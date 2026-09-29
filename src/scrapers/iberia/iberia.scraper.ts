import type { Frame, Locator, Page } from "playwright";
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

// Iberia (Avios), written against real responses saved in `fixtures/` and
// documented in `docs/recon/iberia.md`.
//
// The sweep comes from ONE endpoint:
//
//   POST /api/sse-rpa/rs/v1/calendar/grid  → 191 days in one response; the ones
//   with an award carry `avios`, the others simply lack the field
//
// It is what the "Vista mensal de voos" screen uses. `/availability`, which the
// old project hit, returns seats per flight and NO price, so it cannot work
// alone (see "why no seats" further down).

export type IberiaSession = ChromeSession;

export type IberiaSearchParams = {
  origin: string; // IATA
  destination: string;
  passengers: number;
};

export type IberiaDay = {
  date: string; // YYYY-MM-DD
  avios: number; // the day's lowest, across every cabin
};

type SweepWindow = { from: string; until: string };

// Missing data and a failed search are different states, and Iberia has a
// third: a request that never gets an answer (seen when the site cut a run of
// searches). Treating that as "no availability" would tell the client "nothing
// found" for a search that never went out.
export type IberiaResult =
  | { kind: "ok"; days: IberiaDay[]; window: SweepWindow }
  | { kind: "no_availability"; window: SweepWindow }
  | { kind: "partial"; days: IberiaDay[]; window: SweepWindow; reason: string }
  | { kind: "error"; reason: string; http?: number };

const IBERIA_MIN_INTERVAL_MS = Number(process.env.IBERIA_SEARCH_INTERVAL_MS) || 8000;
const DETAIL_BATCH_SIZE = Number(process.env.IBERIA_DETAIL_BATCH) || 1;
const PAUSE_AFTER_FAILURE_MS = 30_000;
const iberiaRateLimiter = new RateLimiter(IBERIA_MIN_INTERVAL_MS);

// The observed grid returned 191 days for `maxSearchTime: 359` and started
// TODAY, not at the requested date. The window's behavior is unconfirmed, so the
// sweep assumes no size: it asks, looks how far it got, and asks again from the
// next day while it advances. The cap only keeps it from spinning if the site
// ignores the date.
const MAX_GRID_CALLS = 4;
const DAYS_TO_COVER = 359;
const MARKET = process.env.IBERIA_MARKET || "US";

export async function startIberiaSession(headless = false): Promise<IberiaSession> {
  const session = await openChromeSession(headless, "Iberia");
  watchAuthorization(session.page);
  await session.page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await session.page.waitForTimeout(4000);
  return session;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

// Deep link to the results screen in the site's own format. Reaching the
// results by URL avoids driving the home form, which has an ambiguous
// autocomplete (typing "MAD" offers Madison before Madrid), a promo banner over
// the button and a datepicker that ignores typed text.
export function iberiaBookingLink(params: IberiaSearchParams, date: string): string {
  const [year, month, day] = date.split("-") as [string, string, string];
  const query = new URLSearchParams({
    market: MARKET,
    // `fromMarket`, `bookingMarket` and `quadrigam` are copied from the URL the
    // site builds. `quadrigam` has no known meaning here: it is in because it
    // was in the real request that worked, not by deduction.
    fromMarket: "BR",
    bookingMarket: "BR",
    quadrigam: "IBHMPA",
    language: "pt",
    appliesOMB: "false",
    splitEndCity: "false",
    initializedOMB: "true",
    flexible: "true",
    TRIP_TYPE: "1",
    BEGIN_CITY_01: params.origin.toUpperCase(),
    END_CITY_01: params.destination.toUpperCase(),
    BEGIN_DAY_01: day,
    BEGIN_MONTH_01: `${year}${month}`,
    BEGIN_YEAR_01: year,
    END_DAY_01: "",
    END_MONTH_01: "",
    END_YEAR_01: "",
    FARE_TYPE: "R",
    ADT: String(params.passengers),
    CHD: "0",
    INF: "0",
    residentCode: "",
    familianumerosa: "",
    boton: "Buscar",
    pagoAvios: "true",
  });
  return `https://www.iberia.com/flights/?${query.toString()}#!/availability`;
}

// Headers copied from the site's real call (recon notes, section 7). Not
// decoration: with only `content-type`, `/availability` answers 401 even with
// the valid bearer that `/calendar/grid` accepts.
function iberiaHeaders(authorization: string, screen: "availability" | "calendar") {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "pt-BR",
    "content-type": "application/json",
    authorization,
    "x-observations-current-page": screen,
    "x-observations-origin-page": screen,
    "x-request-appversion": "26.15.5",
    "x-request-device": "macintosh|chrome|153.0.0.0",
    "x-request-osversion": "mac|mac-os-x-15",
  };
}

type GridItem = { date?: string; avios?: number; lock?: boolean };
type GridResponse = {
  outbound?: { availabilityCalendar?: GridItem[] };
  errors?: { code?: string; reason?: string }[];
};

function gridRequestBody(params: IberiaSearchParams, date: string) {
  return {
    isPetFlight: false,
    slices: [{ origin: params.origin.toUpperCase(), destination: params.destination.toUpperCase(), date }],
    passengers: [{ passengerType: "ADULT", count: String(params.passengers) }],
    marketCode: MARKET,
    preferredCabin: "",
    maxSearchTime: DAYS_TO_COVER,
  };
}

// `ibisservices.iberia.com` requires `authorization: Bearer`, a token the SPA
// keeps in memory rather than a cookie, so a fetch from inside the page does not
// inherit it (it came back 401). Instead of forging a token, listen to what the
// page itself sends: the results screen calls `/availability` on load, and the
// value comes from there. Nothing is printed or stored.
const tokenByPage = new WeakMap<Page, string>();

function watchAuthorization(page: Page) {
  page.on("request", (request) => {
    if (!/ibisservices\.iberia\.com/.test(request.url())) return;
    const headers = request.headers();
    const authorization = headers["authorization"] ?? headers["Authorization"];
    if (authorization) tokenByPage.set(page, authorization);
  });
}

// The last token the page used, so the flight detail can reuse the session
// without reopening the search.
export function currentAuthorization(page: Page): string | null {
  return tokenByPage.get(page) ?? null;
}

// The results screen is a hash route and takes a while to settle: checking once
// right after load catches an intermediate state. Wait for a conclusion.
async function waitForScreenToSettle(page: Page) {
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    !/#!\/(availability|ibbkerror)/.test(page.url()) &&
    !/login\.iberia\.com/.test(page.url())
  ) {
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);
}

// Automatic login with what is in .env. Credentials are never printed or
// stored, only typed into the site's own form.
async function logIn(page: Page, onLog: OnLog) {
  const email = process.env.IBERIA_EMAIL;
  const password = process.env.IBERIA_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "A Iberia pediu login e não há IBERIA_EMAIL/IBERIA_PASSWORD no .env. " +
        "Preencha lá, ou rode `npx tsx scripts/recon-iberia.ts GRU MAD` e faça o login na janela.",
    );
  }

  onLog("A sessão caiu; logando de novo.");
  const EMAIL_SELECTOR = 'input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]';

  let form: Page | Frame | null = null;
  const deadline = Date.now() + 25_000;
  while (!form && Date.now() < deadline) {
    for (const context of [page, ...page.frames()]) {
      if (await context.locator(EMAIL_SELECTOR).first().isVisible().catch(() => false)) {
        form = context;
        break;
      }
    }
    if (!form) await page.waitForTimeout(1500);
  }
  if (!form) throw new Error("A tela de login apareceu, mas não achei o campo de e-mail em nenhum frame.");

  // Type and check, not type and hope: the login form is Visualforce and
  // re-renders after loading, erasing what was typed. The symptom is cruel: the
  // login screen comes back clean, no error, as if the password were wrong.
  const typeInto = async (field: Locator, value: string, label: string) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await field.fill(value).catch(() => {});
      await page.waitForTimeout(600);
      if ((await field.inputValue().catch(() => "")).length === value.length) return true;
      onLog(`o campo de ${label} não segurou o valor (tentativa ${attempt}); reescrevendo.`);
      await field.click({ timeout: 5000 }).catch(() => {});
      await field.type(value, { delay: 60 }).catch(() => {});
      await page.waitForTimeout(600);
      if ((await field.inputValue().catch(() => "")).length === value.length) return true;
    }
    return false;
  };

  const emailField = form.locator(EMAIL_SELECTOR).first();
  if (!(await typeInto(emailField, email, "e-mail"))) {
    throw new Error("O campo de e-mail do login não aceitou o valor — a página deve estar se re-renderizando.");
  }
  const passwordField = form.locator('input[type="password"]').first();
  if (!(await passwordField.isVisible().catch(() => false))) {
    await submitLogin(form);
    await passwordField.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  }
  if (!(await passwordField.isVisible().catch(() => false))) {
    throw new Error("O campo de senha não apareceu na tela de login da Iberia.");
  }
  if (!(await typeInto(passwordField, password, "senha"))) {
    throw new Error("O campo de senha do login não aceitou o valor.");
  }
  // One last check before submitting: if a field emptied in between, submitting
  // now would only bring the clean screen back.
  const emailOk = (await emailField.inputValue().catch(() => "")).length === email.length;
  const passwordOk = (await passwordField.inputValue().catch(() => "")).length === password.length;
  if (!emailOk || !passwordOk) {
    throw new Error(
      `Os campos do login esvaziaram antes do envio (e-mail ${emailOk ? "ok" : "vazio"}, senha ${passwordOk ? "ok" : "vazia"}).`,
    );
  }
  if (!(await submitLogin(form))) throw new Error("Não achei o botão de enviar na tela de login da Iberia.");

  const loginDeadline = Date.now() + 90_000;
  while (Date.now() < loginDeadline && /login\.iberia\.com/.test(page.url())) await page.waitForTimeout(2000);
  if (/login\.iberia\.com/.test(page.url())) {
    throw new Error("O login foi enviado mas a Iberia continuou na tela de login (2FA ou captcha?).");
  }
  onLog("Login refeito.");
}

async function submitLogin(form: Page | Frame): Promise<boolean> {
  for (const selector of [
    'input[name="loginPage:theForm:loginSubmit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Fazer login")',
    'button:has-text("Continuar")',
  ]) {
    const button = form.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 10_000 }).catch(() => {});
    return true;
  }
  return false;
}

// The site rewrites the URL while navigating (hash route), which Playwright
// reports as ERR_ABORTED even when the page loads. The final URL decides, not goto's result.
async function gotoIgnoringHashAbort(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch((error: Error) => {
    if (!/ERR_ABORTED/.test(error.message)) throw error;
  });
}

async function openResultsPage(page: Page, params: IberiaSearchParams, date: string, onLog: OnLog) {
  const url = iberiaBookingLink(params, date);
  onLog(`Abrindo busca em Avios ${params.origin} → ${params.destination}...`);
  await gotoIgnoringHashAbort(page, url);
  await waitForScreenToSettle(page);

  // The URL carries back what the site understood. Checking it here keeps the
  // source from sweeping an airport nobody asked for: in one recon run the
  // search went to Madison (MSN) instead of Madrid (MAD) and the screen answered
  // "no seats", which looks like a legitimate answer.
  const finalUrl = page.url();
  for (const [field, expected] of [
    ["BEGIN_CITY_01", params.origin.toUpperCase()],
    ["END_CITY_01", params.destination.toUpperCase()],
  ] as const) {
    const actual = new RegExp(`${field}=([A-Z]{3})`).exec(finalUrl)?.[1];
    if (actual && actual !== expected) {
      throw new Error(`A Iberia abriu a busca com ${field}=${actual} em vez de ${expected}.`);
    }
  }

  // Iberia's session in the profile drops within minutes, so landing on the
  // login is routine, not an exception: log in and repeat the search. Without
  // credentials in .env nothing can be done alone, and the error says exactly that.
  if (/login\.iberia\.com/.test(page.url())) {
    await logIn(page, onLog);
    await gotoIgnoringHashAbort(page, url);
    await waitForScreenToSettle(page);
    if (/login\.iberia\.com/.test(page.url())) {
      throw new Error("Mesmo depois de logar, a Iberia devolveu a busca pro login.");
    }
  }

  if (/ibbkerror/.test(finalUrl)) {
    throw new Error(
      "A Iberia respondeu com a tela de erro ('não podemos mostrar os voos'). " +
        "Costuma ser corte por frequência: espere alguns minutos ou aumente IBERIA_SEARCH_INTERVAL_MS.",
    );
  }
}

async function fetchGrid(
  page: Page,
  params: IberiaSearchParams,
  date: string,
  authorization: string,
): Promise<{ days: IberiaDay[]; lastDate: string | null; locked: number }> {
  const response = await page.evaluate(
    async ({ body, headers }) => {
      try {
        const result = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/calendar/grid", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          credentials: "include",
        });
        return { status: result.status, text: await result.text() };
      } catch (error) {
        return { status: -1, text: String(error) };
      }
    },
    { body: gridRequestBody(params, date), headers: iberiaHeaders(authorization, "calendar") },
  );

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `A Iberia recusou a autorização (${response.status}). A sessão do perfil do Chrome provavelmente caiu — ` +
        "rode `npx tsx scripts/recon-iberia.ts GRU MAD` uma vez pra logar de novo.",
    );
  }

  // -1 is the third state: the request never came back. It never becomes "no
  // availability"; it is a failed search and goes up as an error.
  if (response.status === -1) {
    throw new Error(`A chamada do calendário não chegou a responder (${response.text.slice(0, 120)}).`);
  }
  if (response.status === 404) {
    // This 404 is semantic ("Disponibilidade não encontrada"), not a wrong route.
    return { days: [], lastDate: null, locked: 0 };
  }
  if (response.status !== 200) {
    throw new Error(`O calendário respondeu ${response.status} (a partir de ${date}).`);
  }

  let body: GridResponse;
  try {
    body = JSON.parse(response.text) as GridResponse;
  } catch {
    throw new Error(`O calendário devolveu algo que não é JSON (a partir de ${date}).`);
  }

  const calendar = body.outbound?.availabilityCalendar;
  if (!calendar) {
    throw new Error(
      `A resposta do calendário não trouxe 'outbound.availabilityCalendar' (a partir de ${date}). ` +
        `Início do corpo: ${response.text.slice(0, 200)}`,
    );
  }

  const days: IberiaDay[] = [];
  let locked = 0;
  let lastDate: string | null = null;

  for (const item of calendar) {
    if (!item.date) continue;
    if (!lastDate || item.date > lastDate) lastDate = item.date;
    if (typeof item.avios !== "number") continue; // no award that day
    if (item.lock === true) {
      // `lock: true` only showed up later, with an unconfirmed meaning. The day
      // stays out, but only counts as a loss when it HAD a price: a locked day
      // without `avios` is no award at all, and calling the sweep partial for it
      // would be noise over nothing.
      locked++;
      continue;
    }
    days.push({ date: item.date, avios: item.avios });
  }

  return { days, lastDate, locked };
}

export async function searchIberiaYear(
  page: Page,
  params: IberiaSearchParams,
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  _onNotice: OnNotice = () => {},
  shouldStop: ShouldStop = () => false,
): Promise<IberiaResult> {
  const firstDate = daysFromToday(1);
  const horizon = daysFromToday(DAYS_TO_COVER);

  watchAuthorization(page);
  try {
    await iberiaRateLimiter.waitTurn();
    await openResultsPage(page, params, firstDate, onLog);
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }

  const authorization = currentAuthorization(page);
  if (!authorization) {
    return {
      kind: "error",
      reason:
        "A página de resultados não fez nenhuma chamada com Authorization — sem o token do próprio site " +
        "a busca não sai. Verifique se a sessão da Iberia Club ainda está válida no perfil do Chrome.",
    };
  }
  onProgress(0.15);

  const byDate = new Map<string, IberiaDay>();
  let totalLocked = 0;
  let cursor = firstDate;
  let reach: string | null = null;
  let partialReason: string | null = null;

  for (let call = 1; call <= MAX_GRID_CALLS; call++) {
    if (shouldStop()) {
      partialReason = "busca cancelada pela tela";
      break;
    }

    let grid: Awaited<ReturnType<typeof fetchGrid>>;
    try {
      await ensureOnSearchPage(page, params, cursor, onLog);
      await iberiaRateLimiter.waitTurn();
      grid = await fetchGrid(page, params, cursor, currentAuthorization(page) ?? authorization);
    } catch (error) {
      partialReason = error instanceof Error ? error.message : String(error);
      onLog(`Calendário falhou a partir de ${cursor}: ${partialReason}`);
      break;
    }

    for (const day of grid.days) byDate.set(day.date, day);
    totalLocked += grid.locked;
    onLog(
      `Calendário a partir de ${cursor}: ${grid.days.length} dia(s) com prêmio` +
        (grid.lastDate ? `, cobrindo até ${grid.lastDate}.` : "."),
    );

    // The window did not advance: insisting would only repeat the same answer.
    // It is also the sign that the body's `date` does not move the grid's start.
    if (!grid.lastDate || (reach && grid.lastDate <= reach)) {
      if (call > 1) onLog("A grade não avançou além do que já veio; encerrando a varredura.");
      reach = grid.lastDate ?? reach;
      break;
    }
    reach = grid.lastDate;
    onProgress(0.15 + 0.85 * (call / MAX_GRID_CALLS));

    if (reach >= horizon) break;

    const next = new Date(`${reach}T00:00:00`);
    next.setDate(next.getDate() + 1);
    cursor = isoDate(next);
  }

  onProgress(1);

  const window = { from: firstDate, until: reach ?? firstDate };
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  if (totalLocked > 0) {
    partialReason =
      `${totalLocked} dia(s) tinham preço mas vieram com lock e ficaram de fora` + (partialReason ? `; ${partialReason}` : "");
  }

  if (partialReason) return { kind: "partial", days, window, reason: partialReason };
  if (days.length === 0) return { kind: "no_availability", window };
  return { kind: "ok", days, window };
}

// Ceiling in absolute Avios (e.g. 40000); pricier days are left out.
export function buildIberiaReport(
  days: IberiaDay[],
  ceilingAvios: number | null,
  linkParams?: IberiaSearchParams,
): ReportSection {
  const accepted = days.filter((day) => ceilingAvios == null || day.avios <= ceilingAvios);

  if (accepted.length === 0) {
    return { min: null, max: null, days: [], text: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const formattedDays = accepted.map((day) => ({
    date: day.date,
    valueK: Math.round(day.avios / 10) / 100, // 28150 -> 28.15
    ...(linkParams ? { link: iberiaBookingLink(linkParams, day.date) } : {}),
  }));
  const values = formattedDays.map((day) => day.valueK);

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    days: formattedDays,
    text: formatDatesByMonth(formattedDays.map((day) => day.date)),
  };
}

// Why this source reports no seats: `/availability` has `remainingSeats` per
// offer but NO price, and the grid has the day's price without saying which
// flight it belongs to. Joining them would assume the grid's price is the
// fullest flight's, and announcing one flight's seats with another's price is
// the lie `buildSmilesReport` avoids on purpose. Until price and flight can be
// linked by the data, the text carries only dates, as with AA.

// The grid says WHICH days have an award and for how much, nothing about the
// flight, and the flight matters: on the first real GRU→MAD search all 9
// itineraries of the day had a stop, all via Casablanca on Royal Air Maroc,
// taking 14h to 29h. `/availability` tells that. It costs one request per date,
// so it only runs on the days that matter.

export type IberiaFlight = {
  date: string; // departure date, YYYY-MM-DD
  departureTime: string; // HH:MM
  arrivalDate: string;
  arrivalTime: string;
  origin: string;
  destination: string;
  stops: number;
  connectingAirports: string; // "CMN, BCN"
  durationMinutes: number;
  cabins: string; // "ECONOMY" or "ECONOMY, BUSINESS"
  airlines: string; // "AT, IB"
  serviceClasses: string; // rbd per segment
  aircraft: string;
  seats: number | null; // the itinerary's lowest: the bottleneck decides
  fare: string; // fareBasis
};

export type FlightFilters = {
  maxStops?: number | null;
  maxDurationMinutes?: number | null;
  airlines?: string[] | null; // accepted IATA codes, e.g. ["IB","I2","VY"]
  // The offers' `bookingClass`: ECONOMY, BUSINESS, PREMIUMTOURIST, FIRST. Only
  // exists at this level; the calendar that produces the dates has no cabin.
  cabins?: string[] | null;
};

type RawOffer = { bookingClass?: string; rbd?: string; remainingSeats?: number; fareBasis?: string };
type RawSegment = {
  departureDateTime?: string;
  arrivalDateTime?: string;
  departure?: { airport?: { code?: string } };
  arrival?: { airport?: { code?: string } };
  flight?: { operationalCarrier?: { code?: string }; aircraft?: { description?: string } };
  offers?: RawOffer[];
};
type RawSlice = {
  departureDateTime?: string;
  arrivalDateTime?: string;
  stopsNumber?: number;
  duration?: number;
  segments?: RawSegment[];
};
type AvailabilityResponse = {
  originDestinations?: { origin?: string; destination?: string; slices?: RawSlice[] }[];
};

const unique = (values: (string | undefined)[]) => [...new Set(values.filter(Boolean) as string[])];

export async function fetchDayFlights(
  page: Page,
  params: IberiaSearchParams,
  date: string,
  authorization: string,
): Promise<IberiaFlight[]> {
  const body = {
    isPetFlight: false,
    slices: [{ origin: params.origin.toUpperCase(), destination: params.destination.toUpperCase(), date }],
    passengers: [{ passengerType: "ADULT", count: String(params.passengers) }],
    marketCode: MARKET,
    preferredCabin: "",
  };

  // From inside the page, like the calendar. Playwright's `context.request`
  // looked sturdier (independent of where the tab is), but `/availability`
  // answers 401 through it even with the same bearer and headers the calendar
  // accepts: something of the session only exists in the tab's context.
  // `ensureOnSearchPage` keeps the tab in the right place, logging in when needed.
  const response = await page.evaluate(
    async ({ body, headers }) => {
      try {
        const result = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          credentials: "include",
        });
        return { status: result.status, text: await result.text() };
      } catch (error) {
        return { status: -1, text: String(error) };
      }
    },
    { body, headers: iberiaHeaders(authorization, "availability") },
  );

  // 204 means "no flight that day": a legitimate state, an empty list.
  if (response.status === 204) return [];
  // -1 means "the request never came back". It becomes an error: mixing it up
  // with 204 would send "no availability" to the client for a search that never went out.
  if (response.status === -1) {
    // Where the page was matters: "Failed to fetch" with the tab on an error
    // screen is a different story from "Failed to fetch" with the search open.
    throw new Error(
      `A disponibilidade de ${date} não chegou a responder (${response.text.slice(0, 100)}). ` +
        `A aba estava em ${page.url().slice(0, 120)}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`A Iberia recusou a autorização em ${date} (${response.status}).`);
  }
  if (response.status !== 200) {
    throw new Error(`A disponibilidade de ${date} respondeu ${response.status}.`);
  }

  return readFlights(response.text, date);
}

export function readFlights(text: string, date: string): IberiaFlight[] {
  let body: AvailabilityResponse;
  try {
    body = JSON.parse(text) as AvailabilityResponse;
  } catch {
    throw new Error(`A disponibilidade de ${date} devolveu algo que não é JSON.`);
  }
  if (!body.originDestinations) {
    throw new Error(`A resposta de ${date} não trouxe 'originDestinations'.`);
  }

  const flights: IberiaFlight[] = [];
  for (const originDestination of body.originDestinations) {
    for (const slice of originDestination.slices ?? []) {
      const segments = slice.segments ?? [];
      if (segments.length === 0) continue;

      const [departureDate = "", departureTime = ""] = (slice.departureDateTime ?? "").split(" ");
      const [arrivalDate = "", arrivalTime = ""] = (slice.arrivalDateTime ?? "").split(" ");

      const offers = segments.flatMap((segment) => segment.offers ?? []);
      const seats = offers.map((offer) => offer.remainingSeats).filter((n): n is number => typeof n === "number");

      flights.push({
        date: departureDate,
        departureTime,
        arrivalDate,
        arrivalTime,
        origin: segments[0]!.departure?.airport?.code ?? originDestination.origin ?? "",
        destination: segments[segments.length - 1]!.arrival?.airport?.code ?? originDestination.destination ?? "",
        stops: slice.stopsNumber ?? segments.length - 1,
        // Connections are each segment's arrival except the last: the final destination is no stop.
        connectingAirports: segments
          .slice(0, -1)
          .map((segment) => segment.arrival?.airport?.code)
          .filter(Boolean)
          .join(", "),
        durationMinutes: slice.duration ?? 0,
        cabins: unique(offers.map((offer) => offer.bookingClass)).join(", "),
        airlines: unique(segments.map((segment) => segment.flight?.operationalCarrier?.code)).join(", "),
        serviceClasses: unique(offers.map((offer) => offer.rbd)).join(", "),
        aircraft: unique(segments.map((segment) => segment.flight?.aircraft?.description)).join(", "),
        // The itinerary's bottleneck: 8 seats on the first leg are useless if the second has 2.
        seats: seats.length > 0 ? Math.min(...seats) : null,
        fare: unique(offers.map((offer) => offer.fareBasis)).join(", "),
      });
    }
  }
  return flights;
}

// Availability requires a logged-in account; the calendar does not. Since
// Iberia's session drops within minutes, you can be "half in": the grid answers
// 200 and the page's own `/availability` answers 401, even when the site makes
// the call. So the detail checks the login FIRST instead of waiting for a
// redirect (on this path there is none, only a denial).
//
// The test is the most direct there is: open the login page. If the form shows
// up we are not logged in; if Iberia sends us away, we are.
export async function ensureLoggedIn(page: Page, onLog: OnLog): Promise<void> {
  await page
    .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch((error: Error) => {
      if (!/ERR_ABORTED/.test(error.message)) throw error;
    });
  await page.waitForTimeout(4000);

  if (!/login\.iberia\.com/.test(page.url())) {
    onLog("Sessão da Iberia Club já válida.");
    return;
  }
  const hasForm = await page
    .locator('input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]')
    .first()
    .isVisible()
    .catch(() => false);
  if (!hasForm) {
    onLog("Sessão da Iberia Club já válida.");
    return;
  }
  await logIn(page, onLog);
}

// Iberia redirects the tab on its own to a login.iberia.com re-authorization
// page mid-sweep. With the origin changed, the fetch to `ibisservices` becomes
// cross-origin and the browser cuts it ("Failed to fetch"), which looked like
// the source blocking and was not. Reopening the search fixes it.
async function ensureOnSearchPage(page: Page, params: IberiaSearchParams, date: string, onLog: OnLog) {
  if (/^https:\/\/www\.iberia\.com\/flights\//.test(page.url())) return;
  onLog("A aba saiu da página de busca; reabrindo antes de continuar.");
  await openResultsPage(page, params, date, onLog);
}

export function filterFlights(flights: IberiaFlight[], filters: FlightFilters): IberiaFlight[] {
  return flights.filter((flight) => {
    if (filters.maxStops != null && flight.stops > filters.maxStops) return false;
    if (filters.maxDurationMinutes != null && flight.durationMinutes > filters.maxDurationMinutes) return false;
    if (filters.airlines?.length) {
      const flightAirlines = flight.airlines.split(", ").filter(Boolean);
      if (!flightAirlines.every((code) => filters.airlines!.includes(code))) return false;
    }
    if (filters.cabins?.length) {
      // ONE offer in the requested cabin is enough: the itinerary works if it
      // can be booked in that class, even when it has others too.
      const flightCabins = flight.cabins.split(", ").filter(Boolean);
      if (!flightCabins.some((cabin) => filters.cabins!.includes(cabin))) return false;
    }
    return true;
  });
}

export type FailedDay = { date: string; error: string };

// Details the requested days in batches of `/availability`, from inside the tab
// and on the session the calendar just used: the `cheap-flights` pace, but
// through the browser. Measured with `scripts/measure-iberia-batches.ts`: 30 at
// once get cut immediately ("Failed to fetch" on all), batches of 10 in a row
// lose days on the second batch, and batches of 5 every 8s get cut for good
// around day 40. So the default is 1: sequential, no bursts. The rate limiter
// spaces BATCHES, not requests.
//
// A failed batch is retried once after reopening the search (the session drops
// in minutes and reopening logs back in). A batch that fails ENTIRELY twice is
// the site cutting: insisting only prolongs the block, so the rest becomes a
// declared failure and the search comes out partial.
export async function detailDays(
  page: Page,
  params: IberiaSearchParams,
  dates: string[],
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  shouldStop: ShouldStop = () => false,
): Promise<{ flights: IberiaFlight[]; failedDays: FailedDay[] }> {
  const flights: IberiaFlight[] = [];
  const failedDays: FailedDay[] = [];
  if (dates.length === 0) return { flights, failedDays };

  // Without a logged-in account EVERY availability call returns 401: checking
  // once up front saves the whole sweep from failing day by day.
  try {
    await ensureLoggedIn(page, onLog);
    await openResultsPage(page, params, dates[0]!, onLog);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onLog(`Não consegui abrir a busca logada da Iberia: ${reason}`);
    return { flights, failedDays: dates.map((date) => ({ date, error: reason })) };
  }

  const queryBatch = async (batch: string[]) => {
    await ensureOnSearchPage(page, params, batch[0]!, onLog);
    await iberiaRateLimiter.waitTurn();
    const authorization = currentAuthorization(page);
    if (!authorization) throw new Error("a página de busca não fez nenhuma chamada com Authorization");
    return Promise.all(
      batch.map(async (date) => {
        try {
          return { date, flights: await fetchDayFlights(page, params, date, authorization) };
        } catch (error) {
          return { date, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  };

  for (let i = 0; i < dates.length; i += DETAIL_BATCH_SIZE) {
    if (shouldStop()) {
      onLog("Detalhamento cancelado; devolvendo os dias já consultados.");
      break;
    }
    let pending = dates.slice(i, i + DETAIL_BATCH_SIZE);
    for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
      if (attempt === 2) {
        onLog(`${pending.length} dia(s) do lote falharam; reabrindo a busca e tentando de novo.`);
        await page.waitForTimeout(PAUSE_AFTER_FAILURE_MS);
        try {
          await openResultsPage(page, params, pending[0]!, onLog);
        } catch (error) {
          onLog(`Reabrir a busca falhou: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const batchPending = pending;
      const results = await queryBatch(batchPending).catch((error: unknown) =>
        batchPending.map((date) => ({ date, error: error instanceof Error ? error.message : String(error) })),
      );
      pending = [];
      for (const result of results) {
        if ("flights" in result) {
          flights.push(...result.flights);
        } else if (attempt === 2) {
          failedDays.push({ date: result.date, error: result.error });
        } else {
          pending.push(result.date);
        }
      }
      if (attempt === 2 && results.every((result) => "error" in result)) {
        const reason = `a Iberia cortou as consultas (lote inteiro falhou duas vezes: ${failedDays.at(-1)!.error.slice(0, 100)})`;
        onLog(`Parando o detalhe: ${reason}`);
        for (const date of dates.slice(i + DETAIL_BATCH_SIZE)) failedDays.push({ date, error: reason });
        return { flights, failedDays };
      }
    }
    const done = Math.min(i + DETAIL_BATCH_SIZE, dates.length);
    onLog(`Detalhe: ${done} de ${dates.length} dia(s) consultados.`);
    onProgress(done / dates.length);
  }

  return { flights, failedDays };
}
