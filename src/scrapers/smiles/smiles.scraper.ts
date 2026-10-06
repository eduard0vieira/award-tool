import "dotenv/config";
import type { Page } from "playwright";
import { ExpiringCache } from "../../core/cache.ts";
import { openChromeSession, type ChromeSession } from "../../core/chrome-session.ts";
import { formatDatesByMonth, RateLimiter, type LabeledSection, type OnLog, type ShouldStop } from "../../core/common.ts";

// Smiles (GOL) award availability in miles, no login. How access works (from
// the recon, scripts/recon-smiles.ts):
// - The API answers 406 to requests from outside the browser, in any
//   environment (prd/green/blue), and even to real Chrome when the URL is
//   opened as a plain navigation.
// - What passes is a `fetch` fired from INSIDE a page on the API's OWN ORIGIN:
//   open `api-air-flightsearch-prd.smiles.com.br/` and call from there, so the
//   request goes out with Chrome's TLS, the cookies the root visit planted and
//   an XHR look instead of a navigation.
// - Calling from www.smiles.com.br does not work: the API is on another
//   subdomain, so the browser enforces CORS and blocks the read.
// - A throwaway profile is enough (no reputation or imported cookies needed).
//
// One response covers up to 7 days: the requested day, flight by flight, plus
// the 3 days before and after in `calendarDayList` (lowest miles only). That
// calendar does NOT always come: on partner-only routes (e.g. GRU→SCL, all
// AMADEUS) it is empty even with dozens of flights, so the sweep must check and
// fall back to day by day.

export type SmilesSession = ChromeSession;

const API_HOST = "https://api-air-flightsearch-prd.smiles.com.br";

// The app's client key, a public app identifier, not an account credential.
//
// `channel` is the header that decides whether the call passes. Measured on
// 2026-09-15, same URL and cookies, back to back:
//
//   channel: APP  → 403, Akamai's HTML block page
//   channel: WEB  → 200, 40 flights and the 6 calendar days
//   no channel    → 200, but 8 flights and an empty calendar
//
// Claiming to be the iOS app from a Chrome request is an easy contradiction to
// spot. WEB is what the site sends and the only value that brings the calendar,
// which the sweep relies on. (A fake iOS user-agent also went away: `fetch`
// ignores that header by spec, so it never left here.)
const API_HEADERS: Record<string, string> = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "WEB",
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9",
};

const SMILES_MIN_INTERVAL_MS = Number(process.env.SMILES_SEARCH_INTERVAL_MS) || 4000;
const smilesRateLimiter = new RateLimiter(SMILES_MIN_INTERVAL_MS);

export type SmilesCabin = "economy" | "premium" | "business";

// The response's `cabin` field mapped to our cabin.
const CABIN_BY_CODE: Record<string, SmilesCabin> = {
  ECONOMIC: "economy",
  PREMIUM_ECONOMIC: "premium",
  COMFORT: "premium",
  BUSINESS: "business",
  FIRST_CLASS: "business",
};

export type SmilesRoute = { origin: string; destination: string };

// The period to sweep. Empty means tomorrow to SMILES_SCAN_DAYS days
// ahead, never past the last day on sale. It exists because a whole year rarely
// fits the IP budget: on routes without a calendar each day costs one query,
// and the search would deliver a slice chosen by the bot instead of by whoever asked.
export type SmilesPeriod = { from?: string; until?: string };

export type SmilesFlight = {
  cabin: SmilesCabin;
  stops: number;
  seats: number;
  // SMILES_CLUB fare (Club subscriber), the headline number. Besides being what
  // the agency advertises, it is the fare type `calendarDayList` reports, so the
  // calendar and the detail speak the same currency.
  miles: number;
  // Which fare became `miles`. Almost always SMILES_CLUB; falls back to SMILES
  // when a flight has no Club fare, and is recorded so the number never changes
  // meaning silently.
  fare: "SMILES_CLUB" | "SMILES";
  milesWithoutClub: number | null;
  // Null is REAL absence, not a default: only GOL-operated flights (sourceGDS
  // "G3") carry the fee on this endpoint; partner flights (AMADEUS) come with an
  // empty `g3`. Filling 0 would announce "no fee" for a flight that has one,
  // the mistake that brought the previous project down.
  feeReais: number | null;
  airline: string;
  dataSource: string; // sourceGDS: "G3" (GOL) or the partner's GDS
  // Flight-level detail at the old spreadsheet's (cheap-flights) level; only the sheet uses it.
  detail: SmilesFlightDetail;
};

export type SmilesFlightDetail = {
  departureDate: string; // YYYY-MM-DD
  departureTime: string; // HH:MM
  departureAirport: string;
  arrivalDate: string;
  arrivalTime: string;
  arrivalAirport: string;
  connectingAirports: string; // "BSB" or "BSB, GIG"
  durationMinutes: number;
  flightNumbers: string; // "1454, 7462"
  aircraft: string; // "738, 73G"
  serviceClasses: string; // "U, T"
  airlineCode: string; // "G3"
  rawCabin: string; // ECONOMIC / COMFORT / BUSINESS, as the API sends it
};

// `miles: null` means the day is on the calendar without a fare, i.e. no
// availability that day. Meaningful absence, not a missing field: treating it as
// an error killed whole sweeps on routes where many calendar days come like this.
export type SmilesCalendarDay = { date: string; miles: number | null };

export type SmilesDayResponse = {
  date: string; // the requested day (YYYY-MM-DD)
  flights: SmilesFlight[];
  // The 3 days before and after with each one's lowest value, in the same
  // response: what makes a year cost ~52 calls instead of 365.
  calendar: SmilesCalendarDay[];
};

// A missing field is a named error, never a silent default: that is exactly how
// the previous (Python) project started announcing "4 seats" for everything.
class SmilesFieldError extends Error {
  constructor(field: string, context: string) {
    super(`Resposta do Smiles sem o campo "${field}" (${context}). O formato da API pode ter mudado.`);
  }
}

function requireNumber(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SmilesFieldError(field, context);
  return value;
}

function requireText(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value === "") throw new SmilesFieldError(field, context);
  return value;
}

export async function startSmilesSession(headless = false): Promise<SmilesSession> {
  const session = await openChromeSession(headless, "Smiles");
  await refreshSmilesSession(session.page);
  return session;
}

// Root status at the last session opening. 406 is expected; 403 means the edge
// already denied the whole origin before any search, which separates "this IP
// is blocked" from "the search path is blocked".
let rootStatusOnOpen: number | null = null;

// Plants (or replants) the Akamai cookies by visiting the API root. The root
// answers 406 as a document, and that is fine: what matters is the page sitting
// ON the API's origin (where the fetch can come from) with the visit's cookies.
async function refreshSmilesSession(page: Page): Promise<void> {
  const response = await page.goto(`${API_HOST}/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  rootStatusOnOpen = response?.status() ?? null;
  await page.waitForTimeout(3000);
}

function searchUrl(route: SmilesRoute, date: string): string {
  const query = new URLSearchParams({
    originAirportCode: route.origin.toUpperCase(),
    destinationAirportCode: route.destination.toUpperCase(),
    departureDate: date,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `${API_HOST}/v1/airlines/search?${query}`;
}

type RawFare = { type?: unknown; miles?: unknown; money?: unknown; g3?: { costTax?: unknown } };
type RawPoint = { date?: unknown; airport?: { code?: unknown } };
type RawLeg = {
  flightNumber?: unknown;
  equipment?: unknown;
  classOfService?: unknown;
  departure?: RawPoint;
  arrival?: RawPoint;
};
type RawFlight = {
  cabin?: unknown;
  sourceGDS?: unknown;
  stops?: unknown;
  availableSeats?: unknown;
  airline?: { name?: unknown; code?: unknown };
  fareList?: RawFare[];
  legList?: RawLeg[];
  departure?: RawPoint;
  arrival?: RawPoint;
  airportStop?: unknown;
  duration?: { hours?: unknown; minutes?: unknown };
};
type RawResponse = {
  requestedFlightSegmentList?: {
    flightList?: RawFlight[];
    calendarDayList?: { date?: unknown; miles?: unknown }[];
  }[];
};

// New cabins never fail the search but never slip by either: logged once per process.
const unknownCabins = new Set<string>();

// "2026-10-13T06:00:00" → ["2026-10-13", "06:00"]
function splitDateTime(value: unknown, field: string, context: string): [string, string] {
  const [day = "", rest = ""] = requireText(value, field, context).split("T");
  return [day, rest.slice(0, 5)];
}

function joinLegs(legs: RawLeg[], pick: (leg: RawLeg) => unknown): string {
  return legs
    .map(pick)
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join(", ");
}

function extractDetail(raw: RawFlight, context: string): SmilesFlightDetail {
  const legs = Array.isArray(raw.legList) ? raw.legList : [];
  const [departureDate, departureTime] = splitDateTime(raw.departure?.date, "departure.date", context);
  const [arrivalDate, arrivalTime] = splitDateTime(raw.arrival?.date, "arrival.date", context);
  const hours = typeof raw.duration?.hours === "number" ? raw.duration.hours : 0;
  const minutes = typeof raw.duration?.minutes === "number" ? raw.duration.minutes : 0;

  return {
    departureDate,
    departureTime,
    departureAirport: requireText(raw.departure?.airport?.code, "departure.airport.code", context),
    arrivalDate,
    arrivalTime,
    arrivalAirport: requireText(raw.arrival?.airport?.code, "arrival.airport.code", context),
    // A nonstop flight has no stop: an empty string is the right absence here.
    connectingAirports: typeof raw.airportStop === "string" ? raw.airportStop : "",
    durationMinutes: hours * 60 + minutes,
    flightNumbers: joinLegs(legs, (leg) => leg.flightNumber),
    aircraft: joinLegs(legs, (leg) => leg.equipment),
    serviceClasses: joinLegs(legs, (leg) => leg.classOfService),
    airlineCode: typeof raw.airline?.code === "string" ? raw.airline.code : "",
    rawCabin: typeof raw.cabin === "string" ? raw.cabin : "",
  };
}

function extractFlight(raw: RawFlight, date: string, onLog: OnLog): SmilesFlight | null {
  const cabinCode = requireText(raw.cabin, "cabin", `voo em ${date}`);
  const cabin = CABIN_BY_CODE[cabinCode];
  if (!cabin) {
    if (!unknownCabins.has(cabinCode)) {
      unknownCabins.add(cabinCode);
      onLog(`Atenção: cabine "${cabinCode}" não mapeada no Smiles. Os voos dela ficam fora do relatório.`);
    }
    return null;
  }

  const fares = raw.fareList;
  if (!Array.isArray(fares)) throw new SmilesFieldError("fareList", `voo em ${date}`);

  // Only pure-miles fares matter: SMILES_MONEY mixes miles and cash (not
  // comparable with a miles ceiling) and MONEY is cash only.
  const plain = fares.find((fare) => fare.type === "SMILES");
  const club = fares.find((fare) => fare.type === "SMILES_CLUB");
  const chosen = club ?? plain;
  if (!chosen) return null; // no pure-miles fare: not availability for us

  const context = `voo ${cabin} em ${date}`;
  const dataSource = requireText(raw.sourceGDS, "sourceGDS", context);
  const fare = club ? "SMILES_CLUB" : "SMILES";

  return {
    cabin,
    stops: requireNumber(raw.stops, "stops", context),
    seats: requireNumber(raw.availableSeats, "availableSeats", context),
    miles: requireNumber(chosen.miles, `fareList[${fare}].miles`, context),
    fare,
    milesWithoutClub: typeof plain?.miles === "number" ? plain.miles : null,
    feeReais: feeOf(chosen, dataSource, context, onLog),
    airline: requireText(raw.airline?.name, "airline.name", context),
    dataSource,
    detail: extractDetail(raw, context),
  };
}

// A GOL flight ALWAYS carries the fee; if it ever stops, the format changed and
// that must show up. Partner flights never carry it, which is normal.
let warnedAboutGolFee = false;
// Once per run: repeated on every day of the sweep it would be noise that hides the rest.
let warnedAboutMilesLessCalendar = false;

function warnOnce(onLog: OnLog, message: string) {
  if (warnedAboutMilesLessCalendar) return;
  warnedAboutMilesLessCalendar = true;
  onLog(message);
}

function feeOf(fare: RawFare, dataSource: string, context: string, onLog: OnLog): number | null {
  const raw = fare.g3?.costTax;
  if (typeof raw === "string" && raw !== "") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new SmilesFieldError("fareList[SMILES].g3.costTax", context);
    return value;
  }
  if (dataSource === "G3" && !warnedAboutGolFee) {
    warnedAboutGolFee = true;
    onLog(`Atenção: voo da GOL sem g3.costTax (${context}). O formato da API pode ter mudado.`);
  }
  return null;
}

// A Smiles block is not one day's failure but the end of the sweep. Its two
// flavors have different causes and waits, so each has its own message;
// `gapSummary` is what goes into the partial report.
export class SmilesBlockedError extends Error {
  readonly gapSummary: string;

  constructor(message: string, gapSummary: string) {
    super(message);
    this.gapSummary = gapSummary;
  }
}

// 406 is NOT an expired cookie. Measured: the block lasts over 20 min and
// replanting cookies does not recover it. It is a per-IP request budget over a
// moving window. Hammering burns more budget, so the sweep waits it out with
// sparse rechecks; this error is what it throws once the wait limit runs out.
export class SmilesBudgetError extends SmilesBlockedError {
  constructor() {
    super(
      "Smiles bloqueou as consultas deste IP (406) e o bloqueio não passou dentro do tempo de espera " +
        "(SMILES_MAX_BLOCK_WAIT_MS). Ele vale para o IP inteiro e só passa com o tempo. O que já veio está no resultado.",
      "o bloqueio por IP do Smiles não passou dentro do tempo de espera",
    );
  }
}

// 403 comes before the API: the edge (Akamai) answers with an "Access Denied"
// HTML page instead of JSON. Unlike 406 there is no measured duration, so the
// message promises no wait time. Same handling as 406: stop at once, since every
// following day would get the same 403 and insisting reinforces the pattern.
export class SmilesAccessDeniedError extends SmilesBlockedError {
  constructor(reference: string | null) {
    super(
      "Smiles negou o acesso na borda (403): a resposta é uma página de bloqueio, não a API. " +
        (rootStatusOnOpen === 403
          ? "A raiz da API já respondia 403 quando a sessão abriu, então o bloqueio vale para este IP inteiro. "
          : "") +
        "Não há tempo medido de espera para esse caso. Aguarde antes de repetir e, se voltar logo, " +
        "vale trocar de IP ou reduzir o ritmo (SMILES_MAX_DETAILS)." +
        (reference ? ` Referência Akamai: ${reference}.` : ""),
      "a borda do Smiles passou a negar as chamadas (403); o resto do período não chegou a ser consultado",
    );
  }
}

// An error body ready to become a message. A block page is HTML and used to
// land in the log whole, once per day of the sweep: it becomes one short line,
// with the Akamai reference when there is one (the only useful bit for support).
function summarizeBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    const reference = akamaiReference(trimmed);
    return reference ? `a resposta veio em HTML, referência ${reference}` : "a resposta veio em HTML, não em JSON";
  }
  return trimmed.slice(0, 200);
}

function akamaiReference(text: string): string | null {
  const match = text.match(/Reference\s*(?:&#32;)?\s*#([\w.]+)/i);
  return match ? match[1]! : null;
}

// A date past the last day on sale. Not a failure of that day: it is the edge
// of the period, and the sweep stops there without counting it as an error.
export class SmilesOutOfSaleWindowError extends Error {
  readonly date: string;

  constructor(date: string) {
    super(`O Smiles não vende passagem para ${date}: a data está fora da janela de venda.`);
    this.date = date;
  }
}

// The search backend behind the API answered 503 and Smiles wrapped it in a
// 452. Measured on 2026-10-05: it was not an outage. The `akaalb_*` cookie from
// Akamai's load balancer had pinned the bot's long-lived window to a broken
// origin; a fresh browser got 200 on the same request, and so did the bot once
// that cookie alone was cleared.
export class SmilesUpstreamError extends Error {
  constructor(date: string) {
    super(`O servidor de busca do Smiles respondeu 503 para ${date}.`);
  }
}

// Still 503 after moving to another origin: every following day would fail the
// same way, so the sweep stops instead of logging each one.
export class SmilesUpstreamDownError extends SmilesBlockedError {
  constructor() {
    super(
      "O servidor de busca do Smiles está respondendo 503, mesmo depois de trocar de servidor. " +
        "Não é bloqueio do IP: o problema é do lado deles. Tente de novo mais tarde.",
      "o servidor de busca do Smiles passou a responder 503; o resto do período não chegou a ser consultado",
    );
  }
}

// 452 is their own code with several meanings, and only the body tells them
// apart (fixtures/smiles-452-*.json):
//
//   {"errorMessage":"data não permitida"}                       → date not on sale
//   {"error":"Error: Falha ao obter os dados do aeroporto: XQZ"} → unknown airport code
//   {"error":"AxiosError: Request failed with status code 503"}  → their backend failed
//
// Treating every 452 as an airport error made a GRU→MRU sweep blame the codes
// for dates that simply were not on sale yet.
export function error452(text: string, route: SmilesRoute, date: string): Error {
  let body: { errorMessage?: unknown; error?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return new Error(`O Smiles respondeu 452 para ${date}. ${summarizeBody(text)}`);
  }

  if (body.errorMessage === "data não permitida") return new SmilesOutOfSaleWindowError(date);
  if (typeof body.error === "string" && body.error.includes("status code 503")) return new SmilesUpstreamError(date);
  if (typeof body.error === "string" && body.error.includes("Falha ao obter os dados do aeroporto")) {
    return new Error(
      `O Smiles não reconheceu um dos aeroportos de ${route.origin.toUpperCase()} → ${route.destination.toUpperCase()}. ` +
        "Confira as siglas IATA.",
    );
  }
  return new Error(`O Smiles respondeu 452 para ${date}. ${summarizeBody(text)}`);
}

async function callApi(page: Page, route: SmilesRoute, date: string) {
  await smilesRateLimiter.waitTurn();
  return page.evaluate(
    async ({ url, headers }) => {
      const response = await fetch(url, { headers });
      return { status: response.status, text: await response.text() };
    },
    { url: searchUrl(route, date), headers: API_HEADERS },
  );
}

// How long one day's response stays valid. Short on purpose: the target is the
// retry after a block, not keeping stale prices. Miles availability changes
// during the day, and an alert with stale data is worse than a missing alert.
const CACHE_TTL_MS = Number(process.env.SMILES_CACHE_MS) || 3 * 60 * 60_000;
const dayCache = new ExpiringCache<SmilesDayResponse>(CACHE_TTL_MS);

// Days of the last sweep that came from the cache. Reset at each sweep so it
// becomes a number in the report instead of staying invisible.
let daysFromCache = 0;

function cacheKey(route: SmilesRoute, date: string): string {
  return `${route.origin.toUpperCase()}-${route.destination.toUpperCase()}-${date}`;
}

export function readSmilesResponse(text: string, date: string, onLog: OnLog = () => {}): SmilesDayResponse | null {
  let body: RawResponse;
  try {
    body = JSON.parse(text) as RawResponse;
  } catch {
    throw new Error(`O Smiles devolveu uma resposta que não é JSON para ${date}.`);
  }

  const segment = body.requestedFlightSegmentList?.[0];
  // No segment at all means the route has no result that day: a legitimate
  // answer, not an error; the caller returns it empty explicitly.
  if (!segment) return null;

  const flights: SmilesFlight[] = [];
  for (const raw of segment.flightList ?? []) {
    const flight = extractFlight(raw, date, onLog);
    if (flight) flights.push(flight);
  }

  const calendar: SmilesCalendarDay[] = [];
  for (const day of segment.calendarDayList ?? []) {
    // Only the value may be missing (a day without a fare). Present with the
    // wrong type is still an error: that is a changed format, not absence.
    const miles =
      day.miles === undefined || day.miles === null
        ? null
        : requireNumber(day.miles, "calendarDayList[].miles", `calendário de ${date}`);
    calendar.push({ date: requireText(day.date, "calendarDayList[].date", `calendário de ${date}`), miles });
  }

  // A whole calendar without any value is another story: it may be a period
  // without availability, but it is also how a renamed field would look. Warn
  // once instead of carrying on silently.
  if (calendar.length > 0 && calendar.every((day) => day.miles === null)) {
    warnOnce(
      onLog,
      `Atenção: nenhum dia do calendário de ${date} veio com "miles". ` +
        "Pode ser período sem disponibilidade, mas também pode ser mudança de formato da API.",
    );
  }

  return { date, flights, calendar };
}

function isUpstream503(result: { status: number; text: string }, route: SmilesRoute, date: string): boolean {
  return result.status === 452 && error452(result.text, route, date) instanceof SmilesUpstreamError;
}

export async function fetchSmilesDay(
  page: Page,
  route: SmilesRoute,
  date: string,
  onLog: OnLog = () => {},
): Promise<SmilesDayResponse> {
  const cached = dayCache.get(cacheKey(route, date));
  if (cached) {
    daysFromCache++;
    return cached;
  }

  let result = await callApi(page, route, date);
  if (isUpstream503(result, route, date)) {
    onLog(`O Smiles respondeu 503 para ${date}. Trocando de servidor e tentando de novo.`);
    await page.context().clearCookies({ name: /^akaalb_/ });
    await refreshSmilesSession(page);
    result = await callApi(page, route, date);
    if (isUpstream503(result, route, date)) throw new SmilesUpstreamDownError();
  }

  if (result.status === 406) throw new SmilesBudgetError();
  if (result.status === 403) throw new SmilesAccessDeniedError(akamaiReference(result.text));
  if (result.status === 452) throw error452(result.text, route, date);
  if (result.status !== 200) {
    throw new Error(`O Smiles respondeu ${result.status} para ${date}. ${summarizeBody(result.text)}`);
  }

  const response = readSmilesResponse(result.text, date, onLog);
  if (!response) return { date, flights: [], calendar: [] };
  dayCache.set(cacheKey(route, date), response);
  return response;
}

export type SmilesCeilings = {
  economy?: number | null;
  premium?: number | null;
  business?: number | null;
};

export type FailedDay = { date: string; error: string };

export type SmilesYearResult = {
  days: SmilesDayResponse[];
  failedDays: FailedDay[];
  // Days that came from the cache instead of the API: how much IP budget the
  // sweep saved, and a warning that part of the data is not from this hour.
  fromCache: number;
  // What the sweep did NOT cover, in Portuguese, to become a notice on screen.
  // Empty means the period was fully covered.
  gaps: string[];
};

const DAYS_TO_SWEEP = Number(process.env.SMILES_SCAN_DAYS) || 365;
// Safety cap: even when asked for more, the sweep never goes past this. Without
// it a mistyped range would become thousands of queries.
const MAX_PERIOD_DAYS = Number(process.env.SMILES_MAX_PERIOD_DAYS) || 365;
// Smiles sells up to today + 329 days; from day 330 it answers 452 "data não
// permitida" (measured on 2026-09-29). Asking beyond that only spends queries.
const SALE_WINDOW_DAYS = 330;

function daysInPeriod(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

// Turns the requested period into concrete dates, fixing what makes no sense
// instead of failing: a past date becomes tomorrow, an end before the start
// becomes the default, and a range that is too long is cut at the cap and at the sale window.
export function periodBounds(period: SmilesPeriod = {}): { start: string; end: string } {
  const tomorrow = todayPlus(1);
  const defaultEnd = todayPlus(DAYS_TO_SWEEP);

  const valid = (date?: string) => (date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null);
  let start = valid(period.from) ?? tomorrow;
  let end = valid(period.until) ?? defaultEnd;

  if (start < tomorrow) start = tomorrow;
  if (end < start) end = defaultEnd < start ? start : defaultEnd;

  const cap = addDays(start, MAX_PERIOD_DAYS);
  if (end > cap) end = cap;

  const lastDayOnSale = todayPlus(SALE_WINDOW_DAYS - 1);
  if (start > lastDayOnSale) {
    throw new Error(`O período pedido começa em ${start}, mas o Smiles só vende até ${lastDayOnSale}.`);
  }
  if (end > lastDayOnSale) end = lastDayOnSale;
  return { start, end };
}

const SAMPLING_STEP_DAYS = 7; // the calendar covers ±3 days
// The per-IP budget is the scarce resource (~100–150 requests per window), so
// what protects the search is asking for LESS, not asking slower. With 52
// calendar probes + 25 details a leg stays at ~77, leaving room for the second leg.
const MAX_DETAILED_DAYS = Number(process.env.SMILES_MAX_DETAILS) || 25;
// Measured on 2026-10-06: the 406 is keyed on the IP alone. prd, green, blue, a
// fresh load-balancer cookie and a fresh browser all got it at the same moment,
// so only time recovers it. One call per recheck costs almost nothing.
const BLOCK_RECHECK_MS = Number(process.env.SMILES_BLOCK_RECHECK_MS) || 10 * 60_000;
const MAX_BLOCK_WAIT_MS = Number(process.env.SMILES_MAX_BLOCK_WAIT_MS) || 3 * 60 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function todayPlus(days: number): string {
  return addDays(new Date().toISOString().slice(0, 10), days);
}

async function waitUnlessStopped(ms: number, shouldStop: ShouldStop): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms && !shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, ms - (Date.now() - started))));
  }
  return Date.now() - started;
}

function highestCeiling(ceilings: SmilesCeilings): number | null {
  const values = [ceilings.economy, ceilings.premium, ceilings.business].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  return values.length > 0 ? Math.max(...values) : null;
}

// The sweep has two stages, for the same reason as LATAM: probe cheaply, detail
// only what matters.
// 1. SAMPLING (~52 calls): one day every 7. Each response brings, for free, the
//    lowest value of the 3 days before and after, so these calls cover the
//    whole year's minimum values.
// 2. DETAIL: only days under the ceiling get their own call, which is what
//    brings cabin and seats (the calendar has neither).
// The calendar reports the SMILES_CLUB fare, the same headline number we use,
// so comparing the ceiling with the calendar compares like with like.
//
// When there is no calendar (partner-only routes), stage 1 covers nothing and
// the sweep falls back to day by day within a limit, always saying how much was
// left out, never cutting silently.
export async function searchSmilesYear(
  page: Page,
  route: SmilesRoute,
  ceilings: SmilesCeilings,
  onLog: OnLog = () => {},
  onProgress: (fraction: number) => void = () => {},
  shouldStop: ShouldStop = () => false,
  period: SmilesPeriod = {},
): Promise<SmilesYearResult> {
  const { start, end } = periodBounds(period);
  const ceiling = highestCeiling(ceilings);

  daysFromCache = 0;
  const days: SmilesDayResponse[] = [];
  const failedDays: FailedDay[] = [];
  const gaps: string[] = [];
  const fetched = new Set<string>();
  // Lowest known value per day, from the calendar.
  const calendar = new Map<string, number>();
  // First date rejected as off sale; nothing from there on is queried.
  const saleWindow: { rejectedFrom: string | null } = { rejectedFrom: null };
  const withinSaleWindow = (date: string) => saleWindow.rejectedFrom == null || date < saleWindow.rejectedFrom;
  let blockedMs = 0;

  const fetchWaitingOutBlocks = async (date: string): Promise<SmilesDayResponse> => {
    for (;;) {
      try {
        return await fetchSmilesDay(page, route, date, onLog);
      } catch (err) {
        if (!(err instanceof SmilesBudgetError) || blockedMs >= MAX_BLOCK_WAIT_MS) throw err;
        onLog(
          `O Smiles bloqueou as consultas deste IP (406). Esperando ${Math.round(BLOCK_RECHECK_MS / 60000)} min ` +
            `para tentar ${date} de novo (${Math.round(blockedMs / 60000)} de no máximo ` +
            `${Math.round(MAX_BLOCK_WAIT_MS / 60000)} min de espera até agora).`,
        );
        blockedMs += await waitUnlessStopped(BLOCK_RECHECK_MS, shouldStop);
        if (shouldStop()) {
          onLog("Busca cancelada durante a espera do bloqueio.");
          throw err;
        }
      }
    }
  };

  const fetchDay = async (date: string): Promise<SmilesDayResponse | null> => {
    if (fetched.has(date)) return null;
    fetched.add(date);
    try {
      const response = await fetchWaitingOutBlocks(date);
      days.push(response);
      for (const day of response.calendar) {
        // A day without a fare stays out: it is no candidate, and as zero it
        // would look like the cheapest day of the year.
        if (day.miles === null) continue;
        const current = calendar.get(day.date);
        if (current == null || day.miles < current) calendar.set(day.date, day.miles);
      }
      return response;
    } catch (err) {
      // A block is not one day's failure but the end of the sweep; insisting
      // only burns whatever budget is left.
      if (err instanceof SmilesBlockedError) throw err;
      if (err instanceof SmilesOutOfSaleWindowError) {
        if (withinSaleWindow(date)) saleWindow.rejectedFrom = date;
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
      failedDays.push({ date, error: message });
      onLog(`Falha em ${date}: ${message}`);
      return null;
    }
  };

  const stopRequested = (remainingDays: number): boolean => {
    if (!shouldStop()) return false;
    onLog("Busca cancelada. Devolvendo o que já veio.");
    gaps.push(`a busca foi cancelada: ${remainingDays} dia(s) do período não chegaram a ser consultados`);
    return true;
  };

  const samples: string[] = [];
  for (let date = start; date <= end; date = addDays(date, SAMPLING_STEP_DAYS)) samples.push(date);

  onLog(
    `Varrendo ${route.origin.toUpperCase()} → ${route.destination.toUpperCase()}: ` +
      `${samples.length} sondagens cobrem ${daysInPeriod(start, end)} dias (${start} a ${end}).`,
  );

  let consecutiveFailures = 0;
  try {
    for (let i = 0; i < samples.length; i++) {
      if (shouldStop()) {
        const remaining = samples.length - i;
        onLog("Busca cancelada. Devolvendo o que já veio.");
        if (remaining > 0) gaps.push(`a busca foi cancelada: ${remaining} sondagem(ns) do período não chegaram a ser feitas`);
        break;
      }
      const response = await fetchDay(samples[i]!);
      if (saleWindow.rejectedFrom) break;
      if (response) {
        consecutiveFailures = 0;
      } else if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const remaining = samples.length - i - 1;
        onLog(`${consecutiveFailures} sondagens seguidas falharam. Parando com o que já veio.`);
        if (remaining > 0) gaps.push(`a varredura parou cedo: ${remaining} sondagem(ns) do período não chegaram a ser feitas`);
        break;
      }
      onProgress(0.6 * ((i + 1) / samples.length));
    }

    if (shouldStop()) {
      // Already reported by the sampling loop.
    } else if (days.length === 0) {
      // An empty calendar only means "no calendar" when some probe answered.
      // With none, it is just the failure again, and filling day by day would
      // spend requests on that false evidence.
      onLog("Nenhuma sondagem respondeu, então não há como saber se a rota tem calendário. Nada mais foi consultado.");
    } else if (calendar.size === 0) {
      // A route without a calendar (usually partner-only): no cheap probe says
      // which days are worth it, so fill the gaps between samples day by day up
      // to the limit, and say out loud what was left out.
      onLog("Esta rota não devolve calendário. Preenchendo os dias entre as sondagens, um a um.");
      const missing: string[] = [];
      for (let date = start; date <= end; date = addDays(date, 1)) {
        if (!fetched.has(date) && withinSaleWindow(date)) missing.push(date);
      }

      const toFetch = missing.slice(0, MAX_DETAILED_DAYS);
      const cut = missing.length - toFetch.length;
      if (cut > 0) {
        gaps.push(
          `esta rota não devolve o calendário de 7 dias, então cada dia custa uma consulta; ` +
            `${cut} dia(s) do período ficaram sem verificação (limite de ${MAX_DETAILED_DAYS} por busca)`,
        );
      }

      for (let i = 0; i < toFetch.length; i++) {
        if (stopRequested(toFetch.length - i)) break;
        if (!withinSaleWindow(toFetch[i]!)) break;
        await fetchDay(toFetch[i]!);
        onProgress(0.6 + 0.4 * ((i + 1) / toFetch.length));
      }
    } else {
      const candidates = Array.from(calendar.entries())
        .filter(([date]) => date >= start && date <= end && !fetched.has(date) && withinSaleWindow(date))
        .filter(([, miles]) => ceiling == null || miles <= ceiling)
        .sort((a, b) => a[1] - b[1]); // cheapest first

      const chosen = candidates.slice(0, MAX_DETAILED_DAYS);
      const cut = candidates.length - chosen.length;
      if (cut > 0) {
        // The limit exists, but never silently.
        onLog(`${candidates.length} dias passaram no teto; detalhando os ${chosen.length} mais baratos.`);
        gaps.push(
          `${cut} dia(s) dentro do teto não foram detalhados (limite de ${MAX_DETAILED_DAYS} por busca). ` +
            `os mais baratos entraram primeiro`,
        );
      } else if (chosen.length > 0) {
        onLog(`${chosen.length} dia(s) passaram no teto. Buscando cabine e assentos de cada um.`);
      }

      for (let i = 0; i < chosen.length; i++) {
        if (stopRequested(chosen.length - i)) break;
        await fetchDay(chosen[i]![0]);
        onProgress(0.6 + 0.4 * ((i + 1) / chosen.length));
      }
    }
  } catch (err) {
    // What already came is worth keeping: return a partial result with the gap
    // explained instead of losing a whole sweep to a block at its end.
    if (!(err instanceof SmilesBlockedError)) throw err;
    onLog(err.message);
    gaps.push(`a busca foi interrompida pelo bloqueio do Smiles depois de ${days.length} dia(s): ${err.gapSummary}`);
  }

  if (saleWindow.rejectedFrom) {
    onLog(`O Smiles só vende até ${addDays(saleWindow.rejectedFrom, -1)}. A varredura parou aí.`);
    // `end` is already cut at the known window. A rejection before it means the
    // window shrank, and the days in between were never queried.
    if (saleWindow.rejectedFrom < end) {
      gaps.push(
        `o Smiles recusou as datas a partir de ${saleWindow.rejectedFrom} como fora da venda, antes do fim esperado ` +
          `(${end}); os dias entre elas não foram consultados`,
      );
    }
  }

  onProgress(1);
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (daysFromCache > 0) {
    onLog(`${daysFromCache} dia(s) vieram do cache (validade de ${Math.round(CACHE_TTL_MS / 60000)} min).`);
  }
  return { days, failedDays, gaps, fromCache: daysFromCache };
}

const SMILES_CABINS = [
  { field: "economy", label: "Econômica", colorClass: "cabin-economy" },
  { field: "premium", label: "Conforto", colorClass: "cabin-premium" },
  { field: "business", label: "Executiva", colorClass: "cabin-business" },
] as const;

export type SmilesSection = LabeledSection<{ date: string; valueK: number; seats: number }>;

export function buildSmilesReport(days: SmilesDayResponse[], ceilings: SmilesCeilings = {}): SmilesSection[] {
  return SMILES_CABINS.map(({ field, label, colorClass }) => {
    const ceiling = ceilings[field];

    // A day enters a cabin when it has a flight of that cabin under the
    // ceiling. The day's value is the cheapest flight's, and the seats are THAT
    // flight's: the fullest flight's seats next to the cheapest one's price would be a lie.
    const perDay = days
      .map((day) => {
        const flights = day.flights.filter((flight) => flight.cabin === field && (ceiling == null || flight.miles <= ceiling));
        if (flights.length === 0) return null;
        const cheapest = flights.reduce((a, b) => (a.miles <= b.miles ? a : b));
        return { date: day.date, valueK: Math.round(cheapest.miles / 10) / 100, seats: cheapest.seats };
      })
      .filter((day): day is { date: string; valueK: number; seats: number } => day !== null);

    if (perDay.length === 0) {
      return {
        label,
        colorClass,
        min: null,
        max: null,
        days: [],
        text: "Nenhuma disponibilidade encontrada nesse período.",
      };
    }

    const values = perDay.map((day) => day.valueK);
    const seatsByDate = new Map(perDay.map((day) => [day.date, day.seats]));

    return {
      label,
      colorClass,
      min: Math.min(...values),
      max: Math.max(...values),
      days: perDay,
      text: formatDatesByMonth(
        perDay.map((day) => day.date),
        (date) => {
          const seats = seatsByDate.get(date) ?? 0;
          return seats > 0 ? ` (${seats})` : "";
        },
      ),
    };
  });
}
