import "dotenv/config";
import type { Page, Response } from "playwright";
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

// LATAM (latamairlines.com/br/pt), cash fares, economy, no login. From the recon (docs/recon/latam.md):
// - The home page's fare calendar comes from
//   GET /bff/web-products-searchbox/v1/calendar?...&extended=true, and it is
//   generous: ONE response carries TWO months and BOTH directions with each
//   day's price. A whole year takes ~6 calls, round trip included.
// - A similar /bff/air-offers/v2/calendar always comes back empty. Not that one.
// - The calls need the x-latam-* headers (400 without them) and must run
//   inside the page (fetch through page.evaluate), as with AA.
// - The site itself flags the cheapest days with `lowPrice: true`, the green
//   highlight of the UI, for free in the JSON.

export type LatamSession = ChromeSession;

export type LatamRoute = { origin: string; destination: string };

export type LatamDay = {
  date: string; // YYYY-MM-DD
  price: number; // in reais
  lowestFare: boolean; // the site's lowPrice ("Menor tarifa" highlight)
};

export type FailedMonth = { month: string; error: string };
export type LatamYearResult = { outbound: LatamDay[]; inbound: LatamDay[]; failedMonths: FailedMonth[] };

// The four rows of the "Combine suas milhas + dinheiro" screen. It is a LADDER,
// not a price: from option 1 (all miles) to 4 (fewest miles, most cash).
// Keeping only one would choose for the client without saying so.
export type RedemptionOption = {
  id: number;
  milhas: number;
  // LATAM shows `cash + fee`, checked on all four rows of the recon (469,56 +
  // 255,69 = 725,25, and so on). `totalReais` is that number; `dinheiroReais`
  // is the part that trades miles for cash.
  dinheiroReais: number;
  totalReais: number;
};

export type PairConfirmation = {
  // Filled by the server with the shared formatter: it is what the alert
  // generator parses ("Out 2026: 31").
  textoIda?: string;
  textoVolta?: string;
  origem: string;
  destino: string;
  dataIda: string;
  dataVolta: string;
  vooIda: string;
  vooVolta: string;
  // Points of EACH leg as LATAM prices them inside the pair (recon: 45.151 +
  // 45.151 = 90.302, option 1). Null when that direction's search response did
  // not come: the alert card speaks per leg, and making up half the total would
  // be a guess when legs cost differently.
  milhasIda: number | null;
  milhasVolta: number | null;
  taxaReais: number;
  opcoes: RedemptionOption[];
  imagem: string;
};

export type LatamCeilings = {
  maxPriceReais?: number | null; // pricier days are left out
  lowestFareOnly?: boolean; // only the days the site flags as lowest fare
};

const LATAM_MIN_INTERVAL_MS = Number(process.env.LATAM_INTERVALO_BUSCAS_MS) || 8000;
const latamRateLimiter = new RateLimiter(LATAM_MIN_INTERVAL_MS);

// Each response covers 2 months, so 6 calls give the 12 months.
const MONTHS_TO_SWEEP = 12;
const MONTHS_PER_CALL = 2;
const MAX_CONSECUTIVE_FAILURES = 3;

export async function startLatamSession(headless = false): Promise<LatamSession> {
  const session = await openChromeSession(headless, "LATAM");

  // The in-page fetch needs a latamairlines.com context, and the home page also warms up the cookies.
  await session.page.goto("https://www.latamairlines.com/br/pt", { waitUntil: "domcontentloaded", timeout: 60000 });
  await session.page.waitForTimeout(4000);

  if (/challenge|denied|acesso negado/i.test(await session.page.title())) {
    throw new Error(
      "A LATAM bloqueou o acesso. Rode `npm run chrome` e, se persistir, " +
        "`bash scripts/import-cookies.sh latamairlines.com` antes de tentar de novo.",
    );
  }

  return session;
}

type RawDay = {
  date: string;
  fare: { amount: number; roundedAmount: number | null; currency: string } | null;
  enabled: boolean;
  lowPrice: boolean;
};

type RawCalendar = {
  month: string; // "2026-09"
  direction: "OUTBOUND" | "INBOUND";
  detailsCalendar?: RawDay[];
};

type CalendarResponse = { days?: { calendar?: RawCalendar[] }[] };

// One calendar call: two months of days, already split by direction. `month` is 1-12.
async function fetchCalendar(
  page: Page,
  route: LatamRoute,
  month: number,
  year: number,
): Promise<{ outbound: LatamDay[]; inbound: LatamDay[] }> {
  const query = new URLSearchParams({
    origin: route.origin,
    destination: route.destination,
    month: String(month),
    year: String(year),
    isRoundTrip: "true",
    extended: "true", // without it the response has no prices
  });

  const result = await page.evaluate(async (query) => {
    const response = await fetch(`/bff/web-products-searchbox/v1/calendar?${query}`, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-latam-application-country": "br",
        "x-latam-application-oc": "br",
        "x-latam-application-lang": "pt",
        "x-latam-application-name": "xp-web-products-searchbox-lib",
        "x-latam-client-name": "xp-web-products-searchbox-lib",
        "x-latam-request-id": crypto.randomUUID(),
        "x-latam-app-session-id": crypto.randomUUID(),
        "x-latam-track-id": crypto.randomUUID(),
      },
    });
    return { status: response.status, text: await response.text() };
  }, query.toString());

  if (result.status !== 200) {
    throw new Error(`Calendário respondeu com status ${result.status} (${month}/${year}).`);
  }

  let body: CalendarResponse;
  try {
    body = JSON.parse(result.text) as CalendarResponse;
  } catch {
    throw new Error(`Calendário devolveu resposta que não é JSON (${month}/${year}).`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const outbound: LatamDay[] = [];
  const inbound: LatamDay[] = [];

  for (const block of body.days ?? []) {
    for (const calendar of block.calendar ?? []) {
      const target = calendar.direction === "INBOUND" ? inbound : outbound;
      for (const day of calendar.detailsCalendar ?? []) {
        if (!day.enabled || !day.fare || day.date <= today) continue;
        target.push({ date: day.date, price: day.fare.amount, lowestFare: Boolean(day.lowPrice) });
      }
    }
  }
  return { outbound, inbound };
}

export async function searchLatamYear(
  page: Page,
  route: LatamRoute,
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  onNotice: OnNotice = () => {},
  shouldStop: ShouldStop = () => false,
): Promise<LatamYearResult> {
  const normalized = { origin: route.origin.toUpperCase(), destination: route.destination.toUpperCase() };

  const outbound: LatamDay[] = [];
  const inbound: LatamDay[] = [];
  const failedMonths: FailedMonth[] = [];
  let consecutiveFailures = 0;

  const today = new Date();
  const calls = Math.ceil(MONTHS_TO_SWEEP / MONTHS_PER_CALL);
  onLog(`Buscando ${normalized.origin} ⇄ ${normalized.destination}. ${calls} chamadas cobrem ${MONTHS_TO_SWEEP} meses.`);

  for (let i = 0; i < calls; i++) {
    if (shouldStop()) {
      onLog("Busca cancelada. Devolvendo o que já veio.");
      break;
    }
    const target = new Date(today.getFullYear(), today.getMonth() + i * MONTHS_PER_CALL, 1);
    const month = target.getMonth() + 1;
    const year = target.getFullYear();
    const label = `${String(month).padStart(2, "0")}/${year}`;

    await latamRateLimiter.waitTurn();
    // A less robotic cadence between calls.
    await page.waitForTimeout(400 + Math.random() * 1200);

    try {
      const fetched = await fetchCalendar(page, normalized, month, year);
      outbound.push(...fetched.outbound);
      inbound.push(...fetched.inbound);
      onLog(`${label} (+1 mês): ${fetched.outbound.length} dia(s) de ida, ${fetched.inbound.length} de volta.`);
      consecutiveFailures = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedMonths.push({ month: label, error: message });
      onLog(`Falha em ${label}: ${message}`);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        onNotice("");
        onLog(`${consecutiveFailures} chamadas seguidas falharam. Parando e devolvendo o que já veio.`);
        break;
      }
    }

    onProgress((i + 1) / calls);
  }

  // Each call overlaps the previous one (2 months per call), so the same day
  // arrives twice; the lower price wins.
  const dedupe = (days: LatamDay[]) => {
    const byDate = new Map<string, LatamDay>();
    for (const day of days) {
      const current = byDate.get(day.date);
      if (!current || day.price < current.price) byDate.set(day.date, day);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  };

  onProgress(1);
  return { outbound: dedupe(outbound), inbound: dedupe(inbound), failedMonths };
}

// The days that survive the ceilings, i.e. exactly what the user sees on the
// card. Separate because the miles confirmation needs the SAME list: a test
// pair only makes sense if both dates are in the result.
export function filterByCeilings(days: LatamDay[], ceilings: LatamCeilings = {}): LatamDay[] {
  return days.filter((day) => {
    if (ceilings.lowestFareOnly && !day.lowestFare) return false;
    return ceilings.maxPriceReais == null || day.price <= ceilings.maxPriceReais;
  });
}

export function buildLatamReport(days: LatamDay[], ceilings: LatamCeilings = {}): ReportSection {
  const accepted = filterByCeilings(days, ceilings);

  if (accepted.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma tarifa encontrada nesse período." };
  }

  const formattedDays = accepted.map((day) => ({ data: day.date, valorK: Math.round(day.price) }));
  const values = formattedDays.map((day) => day.valorK);

  return {
    menor: Math.min(...values),
    maior: Math.max(...values),
    dias: formattedDays,
    texto: formatDatesByMonth(formattedDays.map((day) => day.data)),
    unidade: "BRL",
  };
}

// Miles confirmation. The calendar only exists in reais, so a day's price in
// miles only comes from searching that day. Requires a logged-in session
// (anonymously, LATAM sends miles mode to the login page):
// `bash scripts/import-cookies.sh latamairlines.com`.

type RawOffer = {
  content?: {
    summary?: {
      flightCode?: string;
      stopOvers?: number;
      lowestPrice?: { currency?: string; amount?: number };
      origin?: { departure?: string; iataCode?: string };
      destination?: { arrival?: string; iataCode?: string };
    };
    newPrices?: { total?: number; taxes?: number }[];
  }[];
};

// The response carrying the PAIR's price. A missing field here is an error, not
// zero: a pair that "costs 0 miles" would become an alert and reach the client.
type RawRedemptionResponse = {
  tax?: { amount?: number; currency?: string };
  redemptionOptions?: { id?: number; totalValueToPay?: { loyalty?: { amount?: number }; money?: { amount?: number } } }[];
};

export class LatamFieldError extends Error {
  constructor(field: string) {
    super(`A LATAM respondeu sem "${field}". O formato mudou. O parser precisa ser conferido antes de confiar no número.`);
    this.name = "LatamFieldError";
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new LatamFieldError(field);
  return value;
}

// Turns the raw response into the ladder of options, with no default on any field.
export function readRedemptionOptions(body: unknown): { feeReais: number; options: RedemptionOption[] } {
  const response = body as RawRedemptionResponse;
  const feeReais = requireNumber(response?.tax?.amount, "tax.amount");
  const rawOptions = response?.redemptionOptions;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) throw new LatamFieldError("redemptionOptions");

  const options = rawOptions.map((option, i) => {
    const miles = requireNumber(option?.totalValueToPay?.loyalty?.amount, `redemptionOptions[${i}].loyalty.amount`);
    const cash = requireNumber(option?.totalValueToPay?.money?.amount, `redemptionOptions[${i}].money.amount`);
    return {
      id: requireNumber(option?.id, `redemptionOptions[${i}].id`),
      milhas: miles,
      dinheiroReais: cash,
      totalReais: Number((cash + feeReais).toFixed(2)),
    };
  });
  // Most miles to fewest, the order LATAM shows.
  options.sort((a, b) => b.milhas - a.milhas);
  return { feeReais, options };
}

// When the session drops, the way back is logging in on the BOT'S WINDOW
// (open and visible): the login stays in the profile for the next searches.
//
// With LATAM_EMAIL and LATAM_SENHA in .env the bot pre-fills both fields; the
// verification code (and any captcha) is always yours. If the form changed and
// pre-filling misses, that is NOT an error: the bot says so and waits for you.
// No password ever shows up in a log.
const LOGIN_WAIT_MS = Number(process.env.LATAM_ESPERA_LOGIN_MS) || 300_000;

export function isAskingForLogin(page: Page): boolean {
  return /login|iniciar-sesion|signin|sign-in/i.test(page.url());
}

async function fillCredentials(page: Page, onLog: OnLog): Promise<void> {
  const email = process.env.LATAM_EMAIL;
  const password = process.env.LATAM_SENHA;
  if (!email || !password) {
    onLog("Sem LATAM_EMAIL/LATAM_SENHA no .env. O login é todo manual na janela do bot.");
    return;
  }

  try {
    const emailField = page.locator('input[type="email"], input[name="email"], #email').first();
    const passwordField = page.locator('input[type="password"]').first();
    await emailField.waitFor({ state: "visible", timeout: 15000 });
    await emailField.fill(email);
    // LATAM sometimes asks for the password only on the next screen; if it is
    // not here, leave the rest to the user instead of chasing a changed selector.
    if (await passwordField.isVisible().catch(() => false)) {
      await passwordField.fill(password);
    }
    onLog("Login da LATAM: e-mail (e senha, se o campo estava na tela) preenchidos. Confirme na janela do bot.");
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    onLog(`Preenchimento automático do login falhou (${reason}). Conclua na janela do bot.`);
  }
}

export async function waitForManualLogin(page: Page, onLog: OnLog, onNotice: OnNotice): Promise<void> {
  await page.bringToFront().catch(() => {});
  await fillCredentials(page, onLog);

  const minutes = Math.round(LOGIN_WAIT_MS / 60000);
  const notice =
    `A LATAM pediu login. Entre na janela do Chrome do bot que está aberta (é a que o bot usa); ` +
    `assim que a sessão voltar, a busca continua sozinha. Tempo limite: ${minutes} min.`;
  onNotice(notice);
  onLog(notice);

  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (!isAskingForLogin(page)) {
      onNotice("");
      onLog("Login concluído. Retomando a busca em milhas.");
      return;
    }
  }

  onNotice("");
  throw new Error(
    `A LATAM continuou pedindo login por ${minutes} min. Faça o login na janela do bot e rode a busca de novo ` +
      "(o login fica salvo no perfil, então isso não deve se repetir a cada busca).",
  );
}

export type PairToConfirm = {
  origin: string;
  destination: string;
  outboundDate: string;
  returnDate: string;
  screenshotPath: string;
};

// Confirms the price of a round-trip PAIR, which is not the sum of its legs.
// Measured: GRU→JNB leg by leg gave 243.535 miles; the same pair bought
// together costs 90.302. LATAM prices the pair, and that number only exists
// after picking an outbound AND a return flight.
//
// So the bot drives the site: round-trip deep link → pick the outbound → pick
// the return → the "Combine suas milhas + dinheiro" screen. The price comes from
// the `/offers/redemption-options` response, not from the HTML.
export async function confirmPairInMiles(
  page: Page,
  pair: PairToConfirm,
  onLog: OnLog = () => {},
  onNotice: OnNotice = () => {},
): Promise<PairConfirmation | null> {
  const { origin, destination, outboundDate, returnDate, screenshotPath } = pair;

  let rawOptions: unknown;
  let outboundSearch: RawOffer | undefined;
  let returnSearch: RawOffer | undefined;

  const capture = async (response: Response) => {
    const url = response.url();
    if (response.status() !== 200) return;
    try {
      if (url.includes("/offers/redemption-options")) {
        rawOptions = await response.json();
      } else if (url.includes("/offers/search/redemption")) {
        // The second search carries `outOfferId`: it is the return, already
        // priced against the chosen outbound.
        const body = (await response.json()) as RawOffer;
        if (url.includes("outOfferId=") && !url.includes("outOfferId=null")) returnSearch = body;
        else outboundSearch = body;
      }
    } catch {
      // Non-JSON response: the required fields catch it later.
    }
  };
  page.on("response", capture);

  try {
    await latamRateLimiter.waitTurn();
    const url =
      "https://www.latamairlines.com/br/pt/oferta-voos?" +
      new URLSearchParams({
        origin,
        destination,
        outbound: `${outboundDate}T12:00:00.000Z`,
        inbound: `${returnDate}T12:00:00.000Z`,
        adt: "1",
        chd: "0",
        inf: "0",
        trip: "RT",
        cabin: "Economy",
        redemption: "true",
        sort: "RECOMMENDED",
      }).toString();

    onLog(`Confirmando o par em milhas: ${origin} ⇄ ${destination} · ${outboundDate} → ${returnDate}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

    if (isAskingForLogin(page)) {
      await waitForManualLogin(page, onLog, onNotice);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (isAskingForLogin(page)) {
        throw new Error("A LATAM voltou para a tela de entrada mesmo após o login. Refaça a busca.");
      }
    }

    if (!(await pickFirstFlight(page, "ida", onLog))) {
      onLog(`Sem voo em milhas na ida de ${outboundDate}.`);
      return null;
    }
    if (!(await pickFirstFlight(page, "volta", onLog))) {
      onLog(`Sem voo em milhas na volta de ${returnDate}.`);
      return null;
    }

    // The combinations screen loads after the second pick.
    await waitUntil(() => rawOptions !== undefined, 30_000, page);
    if (rawOptions === undefined) {
      throw new Error(
        "Fluxo concluído sem as combinações de milhas+dinheiro na resposta da LATAM. " +
          "Rode `npm run recon:latam` para inspecionar onde o fluxo parou.",
      );
    }

    const { feeReais, options } = readRedemptionOptions(rawOptions);

    let image = "";
    const originalViewport = page.viewportSize();
    try {
      // `fullPage` alone does not work here: this screen scrolls an inner
      // container, so the document is as tall as the window and the capture only
      // got the visible part (a 38px strip). Opening the window tall enough for
      // everything to fit without scrolling gets outbound, return and combinations together.
      await page.setViewportSize({ width: originalViewport?.width ?? 1280, height: 2000 });
      await page.evaluate("window.scrollTo(0, 0)");
      await page.waitForTimeout(1200);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      image = screenshotPath;
    } catch (err) {
      // The price is the essential data; the image is not. A missing capture is a notice.
      onLog(`Captura do print do par falhou: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (originalViewport) await page.setViewportSize(originalViewport).catch(() => {});
    }

    const best = options[0]!;
    onLog(
      `${outboundDate} → ${returnDate}: ${best.milhas.toLocaleString("pt-BR")} milhas + R$ ${best.totalReais.toFixed(2)} ` +
        `(${options.length} combinações).`,
    );

    return {
      origem: origin,
      destino: destination,
      dataIda: outboundDate,
      dataVolta: returnDate,
      vooIda: describeFirstFlight(outboundSearch, origin, destination),
      vooVolta: describeFirstFlight(returnSearch, destination, origin),
      milhasIda: firstFlightMiles(outboundSearch),
      milhasVolta: firstFlightMiles(returnSearch),
      taxaReais: feeReais,
      opcoes: options,
      imagem: image,
    };
  } finally {
    page.off("response", capture);
  }
}

// Points of the chosen leg. Inside the round-trip flow this is already the
// pair's price (the return search carries the outbound's `outOfferId`), so it
// is NOT the price of buying that leg alone.
function firstFlightMiles(search: RawOffer | undefined): number | null {
  const value = search?.content?.[0]?.summary?.lowestPrice?.amount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The chosen flight is always the first card: that is the one clicked.
function describeFirstFlight(search: RawOffer | undefined, from: string, to: string): string {
  const flight = search?.content?.[0]?.summary;
  if (!flight) return "";
  const time = (iso?: string) => (iso ? iso.slice(11, 16) : "--:--");
  const stops = flight.stopOvers ?? 0;
  return (
    `${flight.flightCode ?? ""} · ${time(flight.origin?.departure)} ${from} → ${time(flight.destination?.arrival)} ${to}` +
    ` · ${stops === 0 ? "Direto" : `${stops} parada(s)`}`
  );
}

// Each leg takes two picks: the flight and, in the panel that opens next, the
// fare (Light/Plus/Top). Always the first of both: the fare does not change the
// miles ladder, which is what matters here.
async function pickFirstFlight(page: Page, leg: string, onLog: OnLog): Promise<boolean> {
  const card = page.locator('[data-testid^="wrapper-card-flight-"]').first();
  try {
    await card.waitFor({ timeout: 60_000 });
  } catch {
    onLog(`  (nenhum voo apareceu na ${leg})`);
    return false;
  }
  await page.waitForTimeout(2000);
  await card.click({ timeout: 15_000 });
  await page.waitForTimeout(2500);

  const selectors = [
    '[data-testid*="fare-selection"] button',
    'button[data-testid*="select"]',
    "button:has-text('Escolher')",
    "button:has-text('Selecionar')",
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }
  // Without a fare panel, clicking the card is enough.
  return true;
}

async function waitUntil(ready: () => boolean, timeoutMs: number, page: Page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !ready()) await page.waitForTimeout(500);
}

// From the calendar days, picks outbound/return pairs within "lowest + margin",
// the return always after the outbound. The margin differs per direction
// because the return tends to cost more: R$ 100 outbound and R$ 300 return, as agreed.
//
// Callers must pass days ALREADY filtered by the ceilings (`filterByCeilings`):
// the pair simulates a search by the group, so both dates must be in the result
// the group sees. Confirming a date the card does not show returns a capture
// that matches nothing.
//
// Pairs are SPREAD over the period instead of being the three cheapest days.
// Neighbor days usually cost the same points; three pairs in one week return
// the same number three times and say nothing. Different months show whether
// the price changes along the year.
const MIN_PAIR_SPACING_DAYS = Number(process.env.LATAM_DISTANCIA_PARES) || 90;

// The pair must also look like a real trip. Outbound one day and back the next
// is cheap to find and useless as a sample, and a trip that is too long falls
// into another price band, so a two-week cap keeps the comparison fair.
const MIN_STAY_DAYS = Number(process.env.LATAM_ESTADA_MINIMA) || 3;
const MAX_STAY_DAYS = Number(process.env.LATAM_ESTADA_MAXIMA) || 14;

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

export type DatePair = { outbound: LatamDay; inbound: LatamDay };

export function pickBestPairs(
  outbound: LatamDay[],
  inbound: LatamDay[],
  count = 3,
  outboundMarginReais = 100,
  inboundMarginReais = 300,
  minSpacingDays = MIN_PAIR_SPACING_DAYS,
  minStayDays = MIN_STAY_DAYS,
  maxStayDays = MAX_STAY_DAYS,
): DatePair[] {
  if (outbound.length === 0 || inbound.length === 0 || count < 1) return [];

  const withinBand = (days: LatamDay[], marginReais: number) => {
    const lowest = Math.min(...days.map((day) => day.price));
    return days
      .filter((day) => day.price <= lowest + marginReais)
      .sort((a, b) => a.price - b.price || a.date.localeCompare(b.date));
  };

  const outboundCandidates = withinBand(outbound, outboundMarginReais);
  const inboundCandidates = withinBand(inbound, inboundMarginReais);

  const pairs: DatePair[] = [];
  const usedReturns = new Set<string>();

  const tryPair = (candidate: LatamDay): boolean => {
    const back = inboundCandidates.find((day) => {
      if (usedReturns.has(day.date) || day.date <= candidate.date) return false;
      const stay = daysBetween(candidate.date, day.date);
      return stay >= minStayDays && stay <= maxStayDays;
    });
    if (!back) return false;
    usedReturns.add(back.date);
    pairs.push({ outbound: candidate, inbound: back });
    return true;
  };

  // First pass: only dates far enough from those already chosen.
  for (const candidate of outboundCandidates) {
    if (pairs.length >= count) break;
    const farEnough = pairs.every((pair) => daysBetween(pair.outbound.date, candidate.date) >= minSpacingDays);
    if (farEnough) tryPair(candidate);
  }

  // Second pass: when the period is not spread out enough, fill with what is
  // left; fewer pairs because of spacing would be worse than close pairs. Still
  // spread within the little there is: the three cheapest of a one-month result
  // are three days in a row giving the same number three times. So the pick is
  // always the date FARTHEST from those chosen, and price only breaks ties.
  const remaining = outboundCandidates.filter((candidate) => !pairs.some((pair) => pair.outbound.date === candidate.date));
  while (pairs.length < count && remaining.length > 0) {
    const [chosen] = remaining
      .map((candidate) => ({
        candidate,
        distance: pairs.length === 0 ? 0 : Math.min(...pairs.map((pair) => daysBetween(pair.outbound.date, candidate.date))),
      }))
      .sort(
        (a, b) =>
          b.distance - a.distance || a.candidate.price - b.candidate.price || a.candidate.date.localeCompare(b.candidate.date),
      );
    if (!chosen) break;
    remaining.splice(remaining.indexOf(chosen.candidate), 1);
    tryPair(chosen.candidate);
  }

  return pairs.sort((a, b) => a.outbound.date.localeCompare(b.outbound.date));
}
