import "dotenv/config";
import type { Page } from "playwright";
import { openChromeSession, type ChromeSession } from "../../core/chrome-session.ts";
import {
  formatDatesByMonth,
  RateLimiter,
  type OnLog,
  type OnNotice,
  type OnProgress,
  type ReportSection,
  type ShouldStop,
} from "../../core/common.ts";

// American Airlines (aa.com) award search, no login. From the recon (docs/recon/aa.md):
// - Akamai blocks Playwright's Chromium (instant 403), but real Chrome (channel
//   "chrome" with the automation flag hidden) passes, as long as the session
//   "warms up" on the home page before any /booking URL.
// - The results page accepts a cold deep link, no form filling.
// - The monthly calendar comes from POST /booking/api/search/calendar, which
//   does not depend on session state: changing only departureDate sweeps the
//   year in ~12 calls. The call must run INSIDE the page (fetch through
//   page.evaluate); page.request, outside the browser, gets 403 because its TLS
//   is not Chrome's.
// - The request takes cabin and maxStops server side, so the stops filter is the site's own.

export type AaSession = ChromeSession;

export type AaCabin = "economica" | "premium" | "executiva" | "primeira";

export const AA_CABIN_LABELS: Record<AaCabin, string> = {
  economica: "Econômica",
  premium: "Premium Economy",
  executiva: "Executiva",
  primeira: "Primeira Classe",
};

// Values of the request's slices[].cabin. "BUSINESS,FIRST" is what the site
// sends when Business is picked; checked to return exactly what "BUSINESS"
// does (first class is always pricier, so it never becomes the day's lowest).
const AA_REQUEST_CABINS: Record<AaCabin, string> = {
  economica: "COACH",
  premium: "PREMIUM_ECONOMY",
  executiva: "BUSINESS,FIRST",
  primeira: "FIRST",
};

// The search URL's `cabin` takes different values than the request: the URL
// rejects "BUSINESS,FIRST". Checked in the browser on 2026-09-17: with
// BUSINESS the results page opens already filtered to business, same for PREMIUM_ECONOMY.
const AA_LINK_CABINS: Record<AaCabin, string> = {
  economica: "COACH",
  premium: "PREMIUM_ECONOMY",
  executiva: "BUSINESS",
  primeira: "FIRST",
};

type LinkParams = { origin: string; destination: string; passengers: number; cabin?: AaCabin };

// Serves two purposes: the bot opening the results page (which plants the
// cookies) and the front offering the day's booking link. It is the same
// address the site builds for a manual search.
function aaSearchUrl(params: LinkParams, date: string): string {
  const slices = JSON.stringify([
    { orig: params.origin, origNearby: false, dest: params.destination, destNearby: false, date },
  ]);
  return (
    `https://www.aa.com/booking/search?locale=en_US&pax=${params.passengers}&adult=${params.passengers}` +
    `&type=OneWay&searchType=Award&cabin=${params.cabin ? AA_LINK_CABINS[params.cabin] : ""}&carriers=ALL&slices=` +
    encodeURIComponent(slices)
  );
}

export function aaBookingLink(params: Required<LinkParams>, date: string): string {
  return aaSearchUrl(params, date);
}

// AA takes at most 9 passengers per search (checked: with 10 it answers 400
// "Total number of passengers must be between 1 and 9").
export const AA_MAX_PASSENGERS = 9;

export type AaSearchParams = {
  origin: string;
  destination: string;
  cabin: AaCabin;
  maxStops: number | null; // null = any, 0 = nonstop, 1 = up to 1 stop
  // Adults on the same booking. More people makes the search pickier: a day
  // only shows up with that many award seats on the same flight, and the value
  // is per passenger, not the total.
  passengers: number;
};

export type AaDay = {
  date: string; // YYYY-MM-DD
  miles: number; // the day's lowest for the requested cabin
};

export type FailedMonth = { month: string; error: string };
export type AaYearResult = { days: AaDay[]; failedMonths: FailedMonth[] };

const AA_MIN_INTERVAL_MS = Number(process.env.AA_INTERVALO_BUSCAS_MS) || 6000;
const aaRateLimiter = new RateLimiter(AA_MIN_INTERVAL_MS);

// One failed month may be transient, several in a row mean a block or a broken
// route: give up keeping what was collected (same pattern as TAP's sweep).
const MAX_CONSECUTIVE_FAILED_MONTHS = 3;
const MONTHS_TO_SWEEP = 12;

export async function startAaSession(headless = false): Promise<AaSession> {
  const session = await openChromeSession(headless, "AA");

  // Warm-up: without the home page first, Akamai answers 403 on /booking URLs.
  await session.page.goto("https://www.aa.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await session.page.waitForTimeout(4000);

  if (/access denied/i.test(await session.page.title())) {
    throw new Error(
      session.viaCdp
        ? "AA bloqueou o acesso mesmo pelo Chrome do usuário. Aguarde alguns minutos antes de repetir."
        : "A AA bloqueou o acesso ao navegador do bot. Rode `npm run chrome` no terminal pra o bot buscar " +
          "numa aba do seu próprio navegador, que costuma passar.",
    );
  }

  return session;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// One probe date for each of the next 12 months. The endpoint returns the whole
// month of departureDate, so the exact day only has to be valid (not in the past).
function monthProbeDates(): string[] {
  const today = new Date();
  const dates: string[] = [];
  for (let m = 0; m < MONTHS_TO_SWEEP; m++) {
    if (m === 0) {
      // In the current month the 15th may be gone already, so use tomorrow.
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      if (tomorrow.getMonth() !== today.getMonth()) continue; // last day of the month: the next one covers it
      dates.push(isoDate(tomorrow));
      continue;
    }
    dates.push(isoDate(new Date(today.getFullYear(), today.getMonth() + m, 15)));
  }
  return dates;
}

function calendarRequestBody(params: AaSearchParams, departureDate: string) {
  return {
    metadata: { selectedProducts: [], tripType: "OneWay", udo: {} },
    passengers: [{ type: "adult", count: params.passengers }],
    requestHeader: { clientId: "AAcom" },
    slices: [
      {
        allCarriers: true,
        cabin: AA_REQUEST_CABINS[params.cabin],
        departureDate,
        destination: params.destination,
        destinationNearbyAirports: false,
        maxStops: params.maxStops,
        origin: params.origin,
        originNearbyAirports: false,
      },
    ],
    tripOptions: {
      corporateBooking: false,
      fareType: "Lowest",
      locale: "en_US",
      pointOfSale: null,
      searchType: "Award",
      enableBenefits: true,
    },
    loyaltyInfo: null,
    version: "",
    queryParams: { sliceIndex: 0, sessionId: "", solutionSet: "", solutionId: "" },
  };
}

class BeyondSaleWindowError extends Error {
  constructor(departureDate: string) {
    super(`Mês de ${departureDate} está além do período de venda da AA.`);
  }
}

type BadRequestBody = {
  message?: string;
  details?: { field?: string; reason?: string }[];
};

type CalendarResponse = {
  error?: string;
  calendarMonths?: {
    month: string;
    year: string;
    weeks?: { days?: { date: string | null; validDay: boolean; solution: { perPassengerAwardPoints: number } | null }[] }[];
  }[];
};

// The results page, opened by deep link, sets the cookies and context the
// calendar calls reuse.
async function openResultsPage(page: Page, params: AaSearchParams, firstDate: string, onLog: OnLog) {
  const url = aaSearchUrl(params, firstDate);

  onLog(`Abrindo busca de prêmios ${params.origin} → ${params.destination}...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  if (/access denied/i.test(await page.title())) {
    throw new Error(
      "AA bloqueou o acesso (Access Denied). Aguarde alguns minutos e repita; se persistir, aumente AA_INTERVALO_BUSCAS_MS no .env.",
    );
  }
  if (!page.url().includes("choose-flights")) {
    // Never reached the results: invalid route or a form error.
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    throw new Error(
      `A busca não chegou à página de resultados (URL: ${page.url()}). Confira se a rota ${params.origin} → ${params.destination} existe. Texto da página: ${pageText.slice(0, 150)}`,
    );
  }
}

// Fetches one month's calendar from inside the page; returns the days with
// availability (solution != null) for the requested cabin and filter.
async function fetchMonth(page: Page, params: AaSearchParams, departureDate: string): Promise<AaDay[]> {
  const result = await page.evaluate(
    async (body) => {
      const response = await fetch("/booking/api/search/calendar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    calendarRequestBody(params, departureDate),
  );

  if (result.status === 400) {
    // 400 means two very different things, and mixing them up is costly: AA
    // only sells ~331 days ahead (the sweep's natural end), but it also answers
    // 400 when the request itself is wrong, e.g. too many passengers. Treating
    // the second as end of calendar would stop the sweep at month one and
    // deliver "no availability" instead of an error. So the reason decides, not the status.
    let badRequest: BadRequestBody = {};
    try {
      badRequest = JSON.parse(result.text) as BadRequestBody;
    } catch {
      // No readable body: falls through to the generic error below.
    }
    const reasons = (badRequest.details ?? []).map((detail) => detail.reason).filter(Boolean) as string[];
    if (reasons.some((reason) => /outside of available schedule/i.test(reason))) {
      throw new BeyondSaleWindowError(departureDate);
    }
    throw new Error(`A AA recusou a busca: ${reasons.join(" ") || badRequest.message || result.text.slice(0, 200)}`);
  }
  if (result.status !== 200) {
    throw new Error(`Calendário respondeu com status ${result.status} (mês de ${departureDate}).`);
  }

  let body: CalendarResponse;
  try {
    body = JSON.parse(result.text) as CalendarResponse;
  } catch {
    throw new Error(`Calendário devolveu uma resposta que não é JSON (mês de ${departureDate}).`);
  }
  // 309 is NOT a failure: it means "no award this month on this route", sent
  // with HTTP 200, `calendarMonths: []` and `lowestMonthlyPrice: 0`. Measured on
  // 2026-09-25 with HEL→NRT business: September to January answer 309 and July
  // 2027 answers 23 days at 75.000.
  //
  // Treating it as an error was costly: since the sweep gives up after three
  // failed months in a row, a seasonal route died in its first months and
  // reported "no availability" for the WHOLE year, hiding dozens of real dates.
  if (body.error === "309") return [];
  if (body.error) {
    throw new Error(`Calendário devolveu erro: ${body.error}`);
  }

  const today = isoDate(new Date());
  const days: AaDay[] = [];
  for (const month of body.calendarMonths ?? []) {
    for (const week of month.weeks ?? []) {
      for (const day of week.days ?? []) {
        if (!day?.validDay || !day.solution || !day.date) continue;
        if (day.date <= today) continue; // the current month includes past days
        days.push({ date: day.date, miles: day.solution.perPassengerAwardPoints });
      }
    }
  }
  return days;
}

// Akamai answers 403 when it has had enough.
const MAX_BLOCK_RETRIES = 3;
const BLOCK_COOLDOWN_MS = 90_000;

export async function searchAaYear(
  page: Page,
  params: AaSearchParams,
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  onNotice: OnNotice = () => {},
  shouldStop: ShouldStop = () => false,
): Promise<AaYearResult> {
  const normalized: AaSearchParams = {
    ...params,
    origin: params.origin.toUpperCase(),
    destination: params.destination.toUpperCase(),
  };

  const dates = monthProbeDates();
  await aaRateLimiter.waitTurn();
  await openResultsPage(page, normalized, dates[0]!, onLog);
  onProgress(0.1);

  const allDays: AaDay[] = [];
  const failedMonths: FailedMonth[] = [];
  let consecutiveFailures = 0;
  let beyondSaleWindow = false;

  for (let i = 0; i < dates.length; i++) {
    if (shouldStop()) {
      onLog("Busca cancelada. Devolvendo os meses já consultados.");
      break;
    }
    const departureDate = dates[i]!;
    const monthLabel = departureDate.slice(0, 7); // YYYY-MM
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_BLOCK_RETRIES && !succeeded; attempt++) {
      await aaRateLimiter.waitTurn();
      // Extra random pause: a more human cadence between months.
      await page.waitForTimeout(500 + Math.random() * 1500);
      try {
        const days = await fetchMonth(page, normalized, departureDate);
        allDays.push(...days);
        onLog(`Mês ${monthLabel}: ${days.length} dia(s) com disponibilidade.`);
        succeeded = true;
      } catch (err) {
        if (err instanceof BeyondSaleWindowError) {
          onLog(`Mês ${monthLabel} ainda não está à venda. Fim da varredura.`);
          beyondSaleWindow = true;
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        const looksBlocked = /status 403/.test(message);
        if (looksBlocked && attempt < MAX_BLOCK_RETRIES) {
          const waitMs = BLOCK_COOLDOWN_MS * attempt;
          const waitMin = Math.round((waitMs / 60000) * 10) / 10;
          onNotice(`A AA bloqueou temporariamente (403). Esperando ${waitMin} min antes de tentar de novo...`);
          onLog(`Bloqueio 403 no mês ${monthLabel}; cooldown de ${waitMin} min (tentativa ${attempt}).`);
          await page.waitForTimeout(waitMs);
          onNotice("");
        } else {
          failedMonths.push({ month: monthLabel, error: message });
          onLog(`Falha no mês ${monthLabel}: ${message}`);
          break;
        }
      }
    }
    onNotice("");
    if (beyondSaleWindow) break;

    if (succeeded) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_MONTHS) {
        onLog(`${consecutiveFailures} meses seguidos falharam. Parando por aqui e devolvendo o que já foi coletado.`);
        break;
      }
    }

    onProgress(0.1 + 0.9 * ((i + 1) / dates.length));
  }

  onProgress(1);
  allDays.sort((a, b) => a.date.localeCompare(b.date));
  return { days: allDays, failedMonths };
}

// One cabin per report (AA searches per cabin). The ceiling is in absolute
// miles (e.g. 60000); pricier days are left out.
export function buildAaReport(
  days: AaDay[],
  ceilingMiles: number | null,
  linkParams?: Required<LinkParams>,
): ReportSection {
  const accepted = days.filter((day) => ceilingMiles == null || day.miles <= ceilingMiles);

  if (accepted.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const formattedDays = accepted.map((day) => ({
    data: day.date,
    valorK: Math.round(day.miles / 10) / 100, // 171500 -> 171.5
    ...(linkParams ? { link: aaBookingLink(linkParams, day.date) } : {}),
  }));
  const values = formattedDays.map((day) => day.valorK);

  return {
    menor: Math.min(...values),
    maior: Math.max(...values),
    dias: formattedDays,
    texto: formatDatesByMonth(formattedDays.map((day) => day.data)),
  };
}
