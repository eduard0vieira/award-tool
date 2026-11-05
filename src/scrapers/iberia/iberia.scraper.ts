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
// old project hit, gives each flight, but prices only Iberia's own direct ones
// and is cut after a few calls (§17), so it details a short list of days.

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
export function iberiaHeaders(authorization: string, screen: "availability" | "calendar") {
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
// The page holds two families of 15-minute tokens at once, and only the member
// one opens `/availability` (§17): the last token on any route was sometimes
// the other family, and the detail died at its `exp`. This keeps the one the
// page itself sends to `/availability`.
const availabilityTokenByPage = new WeakMap<Page, string>();
const watchedPages = new WeakSet<Page>();
const AVAILABILITY_PATH = "/api/sse-rpa/rs/v1/availability";

function watchAuthorization(page: Page) {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on("request", (request) => {
    if (!/ibisservices\.iberia\.com/.test(request.url())) return;
    const headers = request.headers();
    const authorization = headers["authorization"] ?? headers["Authorization"];
    if (!authorization) return;
    tokenByPage.set(page, authorization);
    if (request.url().includes(AVAILABILITY_PATH)) availabilityTokenByPage.set(page, authorization);
  });
}

// The last token the page used, so the flight detail can reuse the session
// without reopening the search.
export function currentAuthorization(page: Page): string | null {
  return tokenByPage.get(page) ?? null;
}

export function availabilityAuthorization(page: Page): string | null {
  return availabilityTokenByPage.get(page) ?? null;
}

// The site's error screen ("não podemos mostrar os voos"): reached when it cut
// the session, so going on only lengthens the block.
export class IberiaBlockedError extends Error {}

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

// The OneTrust notice lays a dark filter over the whole page that swallows every
// click: the login's submit "worked" and nothing happened. Declines the
// non-essential cookies (never accepts) and, if the filter stays, moves it out
// of the way, which answers nothing.
async function declineCookies(page: Page, onLog: OnLog) {
  const visible = (selector: string) => page.locator(selector).first().isVisible().catch(() => false);
  if (await visible("#onetrust-reject-all-handler")) {
    await page.locator("#onetrust-reject-all-handler").first().click({ timeout: 5000 });
  } else if (await visible("#onetrust-pc-btn-handler")) {
    await page.locator("#onetrust-pc-btn-handler").first().click({ timeout: 5000 });
    await page.locator(".ot-pc-refuse-all-handler").first().click({ timeout: 10_000 });
  } else {
    return;
  }
  await page.waitForTimeout(1000);
  const removed = await page.evaluate(`(() => {
    const filters = [...document.querySelectorAll(".onetrust-pc-dark-filter")];
    for (const element of filters) element.remove();
    return filters.length;
  })()`);
  onLog(`Aviso de cookies da Iberia: recusei os não essenciais${removed ? " e tirei a cobertura que ficou" : ""}.`);
}

// How long a login that stopped for a person (a code, a captcha, a refused
// password) waits for them to finish in the bot's window.
const LOGIN_WAIT_MS = Number(process.env.IBERIA_LOGIN_WAIT_MS) || 5 * 60_000;

// Automatic login with what is in .env. Credentials are never printed or
// stored, only typed into the site's own form. Whatever the form leaves to a
// person is announced on the card and waited for, in the visible bot window.
export async function logIn(page: Page, onLog: OnLog, onNotice: OnNotice = () => {}) {
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
  await declineCookies(page, onLog);

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

  const onLoginPage = () => /login\.iberia\.com/.test(page.url());
  const automaticDeadline = Date.now() + 30_000;
  while (Date.now() < automaticDeadline && onLoginPage()) await page.waitForTimeout(2000);
  if (onLoginPage()) {
    const minutes = Math.round(LOGIN_WAIT_MS / 60000);
    const notice =
      "A Iberia pediu algo além de e-mail e senha no login (código, captcha ou senha recusada). " +
      `Termine na janela do Chrome do bot; a busca continua sozinha. Tempo limite: ${minutes} min.`;
    await page.bringToFront().catch(() => {});
    onNotice(notice);
    onLog(notice);
    const manualDeadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < manualDeadline && onLoginPage()) await page.waitForTimeout(2000);
    onNotice("");
    if (onLoginPage()) {
      throw new Error(
        `O login da Iberia continuou parado por ${minutes} min. Confira IBERIA_EMAIL e IBERIA_PASSWORD no .env ` +
          "ou rode `npm run login:iberia` e termine na janela.",
      );
    }
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

export async function openResultsPage(
  page: Page,
  params: IberiaSearchParams,
  date: string,
  onLog: OnLog,
  onNotice: OnNotice = () => {},
) {
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
    await logIn(page, onLog, onNotice);
    await gotoIgnoringHashAbort(page, url);
    await waitForScreenToSettle(page);
    if (/login\.iberia\.com/.test(page.url())) {
      throw new Error("Mesmo depois de logar, a Iberia devolveu a busca pro login.");
    }
  }

  if (/ibbkerror/.test(page.url())) {
    // Slowing down does not lift it (§16, §17): the cut comes after a number of calls, not a pace.
    throw new IberiaBlockedError(
      "A Iberia respondeu com a tela de erro ('não podemos mostrar os voos'): ela cortou a sessão depois de " +
        "muitas consultas. Espere pelo menos 20 minutos antes de buscar na Iberia de novo.",
    );
  }
}

// `goto` to the same URL with the same `#!/availability` is an anchor jump in
// Chrome: no load, no call, no new state (§17). Leaving the page first makes it a real load.
export async function reloadResults(
  page: Page,
  params: IberiaSearchParams,
  date: string,
  onLog: OnLog,
  onNotice: OnNotice = () => {},
) {
  await page.goto("about:blank");
  await openResultsPage(page, params, date, onLog, onNotice);
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
  onNotice: OnNotice = () => {},
  shouldStop: ShouldStop = () => false,
): Promise<IberiaResult> {
  const firstDate = daysFromToday(1);
  const horizon = daysFromToday(DAYS_TO_COVER);

  watchAuthorization(page);
  try {
    await iberiaRateLimiter.waitTurn();
    await openResultsPage(page, params, firstDate, onLog, onNotice);
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
      await ensureOnSearchPage(page, params, cursor, onLog, onNotice);
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

// The grid says WHICH days have an award and for how much, nothing about the
// flight, and the flight matters: on the first real GRU→MAD search all 9
// itineraries of the day had a stop, all via Casablanca on Royal Air Maroc.
// `/availability` tells that, and on direct IB flights it also carries each
// offer's Avios (§17). It costs one request per date, so it only runs on the
// days that matter.

export type IberiaCabin = "economy" | "premium" | "business";
export type IberiaCarrier = { code: string; name: string };
// One cabin of one itinerary: the cheapest priced offer and that offer's own
// seats. Connections carry no price at any level (§17): `avios` is null, never 0.
export type IberiaFare = { cabin: IberiaCabin; avios: number | null; seats: number | null };

export type IberiaFlight = {
  date: string; // departure date, YYYY-MM-DD
  departureTime: string; // HH:MM
  arrivalDate: string;
  arrivalTime: string;
  origin: string;
  destination: string;
  stops: number;
  connectingAirports: string[];
  durationMinutes: number;
  carriers: IberiaCarrier[]; // who operates, in flight order
  aircraft: string[];
  fares: IberiaFare[];
  // Booking classes left out of `fares`: Iberia's FIRST has no cabin of ours,
  // and a cabin offered on only some legs of a connection is no cabin of the trip.
  otherCabins: string[];
};

export type FlightFilters = {
  maxStops?: number | null;
  maxDurationMinutes?: number | null;
  airlines?: string[] | null; // accepted IATA codes, e.g. ["IB","I2","VY"]
  cabins?: IberiaCabin[] | null;
};

export const CABIN_BY_BOOKING_CLASS: Record<string, IberiaCabin | null> = {
  ECONOMY: "economy",
  PREMIUMTOURIST: "premium",
  BUSINESS: "business",
  FIRST: null,
};

type RawPrice = { fare?: number; currency?: string };
type RawOffer = { bookingClass?: string; remainingSeats?: number; totalPrice?: RawPrice };
type RawCarrier = { code?: string; name?: string };
type RawSegment = {
  arrival?: { airport?: { code?: string } };
  departure?: { airport?: { code?: string } };
  flight?: { operationalCarrier?: RawCarrier; aircraft?: { description?: string } };
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

function aviosOf(offer: RawOffer, date: string): number | null {
  if (!offer.totalPrice) return null;
  const { fare, currency } = offer.totalPrice;
  if (currency !== "AVIOS" || typeof fare !== "number") {
    throw new Error(`Uma oferta de ${date} veio com preço que não é Avios (${JSON.stringify(offer.totalPrice)}).`);
  }
  return fare;
}

function cabinOf(offer: RawOffer, date: string): IberiaCabin | null {
  const code = offer.bookingClass;
  if (!code || !(code in CABIN_BY_BOOKING_CLASS)) {
    throw new Error(`Uma oferta de ${date} veio com a cabine '${code}', que o bot não conhece.`);
  }
  return CABIN_BY_BOOKING_CLASS[code]!;
}

function faresOf(segments: RawSegment[], date: string): { fares: IberiaFare[]; otherCabins: string[] } {
  const perSegment = segments.map((segment) => {
    const byCabin = new Map<IberiaCabin, RawOffer[]>();
    const other: string[] = [];
    for (const offer of segment.offers ?? []) {
      const cabin = cabinOf(offer, date);
      if (cabin === null) {
        other.push(offer.bookingClass!);
        continue;
      }
      byCabin.set(cabin, [...(byCabin.get(cabin) ?? []), offer]);
    }
    return { byCabin, other };
  });

  const fares: IberiaFare[] = [];
  const otherCabins = new Set(perSegment.flatMap((segment) => segment.other));
  const cabins = new Set(perSegment.flatMap((segment) => [...segment.byCabin.keys()]));
  for (const cabin of cabins) {
    if (!perSegment.every((segment) => segment.byCabin.has(cabin))) {
      otherCabins.add(Object.keys(CABIN_BY_BOOKING_CLASS).find((code) => CABIN_BY_BOOKING_CLASS[code] === cabin)!);
      continue;
    }
    if (segments.length === 1) {
      const offers = perSegment[0]!.byCabin.get(cabin)!;
      const priced = offers
        .map((offer) => ({ offer, avios: aviosOf(offer, date) }))
        .filter((entry): entry is { offer: RawOffer; avios: number } => entry.avios !== null);
      if (priced.length > 0) {
        const cheapest = priced.reduce((a, b) => (a.avios <= b.avios ? a : b));
        fares.push({ cabin, avios: cheapest.avios, seats: cheapest.offer.remainingSeats ?? null });
        continue;
      }
    }
    // Without a price the seats are the trip's bottleneck in that cabin: 9 on one leg are useless if the next has 2.
    const seats = perSegment.map((segment) => {
      const counts = segment.byCabin.get(cabin)!.map((offer) => offer.remainingSeats).filter((n): n is number => typeof n === "number");
      return counts.length > 0 ? Math.max(...counts) : null;
    });
    fares.push({ cabin, avios: null, seats: seats.includes(null) ? null : Math.min(...(seats as number[])) });
  }
  return { fares, otherCabins: [...otherCabins] };
}

// The page's per-load allowance ran out (a call that never answers) or its
// token did (401): both are cured by a real reload, not by a retry on the spot.
export class AvailabilityRefusedError extends Error {}

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
    throw new AvailabilityRefusedError(
      `A disponibilidade de ${date} não chegou a responder (${response.text.slice(0, 100)}). ` +
        `A aba estava em ${page.url().slice(0, 120)}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AvailabilityRefusedError(`A Iberia recusou a autorização em ${date} (${response.status}).`);
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
      const field = <T>(value: T | undefined, name: string): T => {
        if (value === undefined || value === null || value === "") throw new Error(`Um voo de ${date} veio sem '${name}'.`);
        return value;
      };

      const [departureDate, departureTime] = field(slice.departureDateTime, "departureDateTime").split(" ") as [string, string];
      const [arrivalDate, arrivalTime] = field(slice.arrivalDateTime, "arrivalDateTime").split(" ") as [string, string];
      const carriers = new Map<string, IberiaCarrier>();
      for (const segment of segments) {
        const carrier = field(segment.flight?.operationalCarrier, "flight.operationalCarrier");
        const code = field(carrier.code, "operationalCarrier.code");
        carriers.set(code, { code, name: field(carrier.name, "operationalCarrier.name") });
      }

      flights.push({
        date: departureDate,
        departureTime,
        arrivalDate,
        arrivalTime,
        origin: field(segments[0]!.departure?.airport?.code, "departure.airport.code"),
        destination: field(segments.at(-1)!.arrival?.airport?.code, "arrival.airport.code"),
        stops: slice.stopsNumber ?? segments.length - 1,
        // Each segment's arrival except the last: the final destination is no stop.
        connectingAirports: segments.slice(0, -1).map((segment) => field(segment.arrival?.airport?.code, "arrival.airport.code")),
        durationMinutes: field(slice.duration, "duration"),
        carriers: [...carriers.values()],
        aircraft: unique(segments.map((segment) => segment.flight?.aircraft?.description)),
        ...faresOf(segments, date),
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
export async function ensureLoggedIn(page: Page, onLog: OnLog, onNotice: OnNotice = () => {}): Promise<void> {
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
  await logIn(page, onLog, onNotice);
}

// Iberia redirects the tab on its own to a login.iberia.com re-authorization
// page mid-sweep. With the origin changed, the fetch to `ibisservices` becomes
// cross-origin and the browser cuts it ("Failed to fetch"), which looked like
// the source blocking and was not. Reopening the search fixes it.
async function ensureOnSearchPage(page: Page, params: IberiaSearchParams, date: string, onLog: OnLog, onNotice: OnNotice) {
  if (/^https:\/\/www\.iberia\.com\/flights\//.test(page.url())) return;
  onLog("A aba saiu da página de busca; reabrindo antes de continuar.");
  await openResultsPage(page, params, date, onLog, onNotice);
}

export function filterFlights(flights: IberiaFlight[], filters: FlightFilters): IberiaFlight[] {
  return flights.filter((flight) => {
    if (filters.maxStops != null && flight.stops > filters.maxStops) return false;
    if (filters.maxDurationMinutes != null && flight.durationMinutes > filters.maxDurationMinutes) return false;
    if (filters.airlines?.length && !flight.carriers.every((carrier) => filters.airlines!.includes(carrier.code))) return false;
    // ONE fare in a requested cabin is enough: the trip works if it can be booked in it.
    if (filters.cabins?.length && !flight.fares.some((fare) => filters.cabins!.includes(fare.cabin))) return false;
    return true;
  });
}

export type FailedDay = { date: string; error: string };
export type DetailResult = { flights: IberiaFlight[]; failedDays: FailedDay[]; cut: string | null };

// Measured in §17: the site stops answering `/availability` after about a dozen
// calls per page load, at any pace. A real reload every 4 calls never hit that,
// but around 16–20 calls in a session even the page's own load lands on the
// error screen. So: reload every few calls, use the call each load makes anyway,
// and stop at the first load that is refused.
const DETAIL_CALLS_PER_LOAD = 4;

// Each load of the results page asks `/availability` for the date in its URL:
// that answer is one day of the detail, at no extra cost against the cut.
function pageOwnAvailability(page: Page, date: string): Promise<IberiaFlight[] | null> {
  return page
    .waitForResponse(
      (response) =>
        response.url().includes(AVAILABILITY_PATH) &&
        response.request().method() === "POST" &&
        (response.request().postData() ?? "").includes(`"${date}"`),
      { timeout: 60_000 },
    )
    .then(async (response) => {
      if (response.status() === 204) return [];
      if (response.status() !== 200) return null;
      return readFlights(await response.text(), date);
    })
    .catch(() => null);
}

export async function detailDays(
  page: Page,
  params: IberiaSearchParams,
  dates: string[],
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  shouldStop: ShouldStop = () => false,
  onNotice: OnNotice = () => {},
): Promise<DetailResult> {
  watchAuthorization(page);
  const flights: IberiaFlight[] = [];
  const failedDays: FailedDay[] = [];
  let next = 0;
  let cut: string | null = null;

  while (next < dates.length && cut === null) {
    if (shouldStop()) {
      onLog("Detalhamento cancelado; devolvendo os dias já consultados.");
      break;
    }
    const before = next;
    const first = dates[next]!;
    const ownAnswer = pageOwnAvailability(page, first);
    try {
      await iberiaRateLimiter.waitTurn();
      await reloadResults(page, params, first, onLog, onNotice);
    } catch (error) {
      cut = error instanceof Error ? error.message : String(error);
      break;
    }
    const firstFlights = await ownAnswer;
    if (firstFlights) {
      flights.push(...firstFlights);
      next++;
    }

    const authorization = availabilityAuthorization(page);
    for (let call = 0; call < DETAIL_CALLS_PER_LOAD && next < dates.length && authorization; call++) {
      if (shouldStop()) break;
      const date = dates[next]!;
      await iberiaRateLimiter.waitTurn();
      try {
        flights.push(...(await fetchDayFlights(page, params, date, authorization)));
        next++;
      } catch (error) {
        if (error instanceof AvailabilityRefusedError) break;
        // An answer that cannot be read is that day's failure, not the session's.
        failedDays.push({ date, error: error instanceof Error ? error.message : String(error) });
        next++;
      }
    }
    if (next === before) {
      cut = `a Iberia parou de responder ao detalhe depois de ${before} dia(s), mesmo recarregando a página`;
    }
    onLog(`Detalhe: ${next} de ${dates.length} dia(s) consultados.`);
    onProgress(next / dates.length);
  }

  if (cut !== null) {
    onLog(`Parando o detalhe: ${cut}`);
    for (const date of dates.slice(next)) failedDays.push({ date, error: cut });
  }
  return { flights, failedDays, cut };
}
