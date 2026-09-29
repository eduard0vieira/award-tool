import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { formatDatesByMonth, type LabeledSection, type OnLog, type OnProgress } from "../../core/common.ts";

export type SeatspySession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export type SeatspyAirline = "AF" | "B6" | "BA" | "CX" | "EY" | "IB" | "KLM" | "QF" | "VIR";

export type SeatspySearchParams = {
  airline: SeatspyAirline;
  origin: string; // IATA, e.g. "GRU"
  destination: string;
  roundTrip: boolean;
};

// SeatSpy sometimes marks a day available (green dot on the calendar) without
// the flight's miles (mixed or partner fares); then `miles` is null even with
// `available: true`, so the day is not lost for lack of that number.
export type CabinAvailability = {
  available: boolean;
  miles: number | null;
  // Seats of the quoted flight (the day's cheapest in that cabin), the same
  // number SeatSpy shows on the calendar hover. 0 means no availability.
  seats: number;
};

export type SeatspyDay = {
  date: string; // YYYY-MM-DD
  economy: CabinAvailability;
  premium: CabinAvailability;
  business: CabinAvailability;
  first: CabinAvailability;
};

// Values in K (thousands of miles), min/max counting only priced days. Only
// SeatSpy and Smiles have seats; LATAM and AA reuse this shape without them.
export type SectionDay = { date: string; valueK: number | null; seats?: number };
export type SeatspySection = LabeledSection<SectionDay>;

export type SeatspyReport = { sections: SeatspySection[] };

// Optional absolute miles ceiling per cabin (e.g. 25000); pricier days are
// left out of that cabin's report.
export type SeatspyCeilings = {
  economy?: number | null;
  premium?: number | null;
  business?: number | null;
  first?: number | null;
};

// Every program SeatSpy tracks, keyed by the code of the site's own #airline field.
export const AIRLINE_NAMES: Record<SeatspyAirline, string> = {
  AF: "Air France",
  B6: "JetBlue",
  BA: "British Airways",
  CX: "Cathay Pacific",
  EY: "Etihad Airways",
  IB: "Iberia Airlines",
  KLM: "KLM Royal Dutch Airlines",
  QF: "Qantas Airways",
  VIR: "Virgin Atlantic",
};

export async function startSeatspySession(headless = false): Promise<SeatspySession> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  // "load" (goto's default) only fires once every third-party resource finishes
  // (Freshworks, Sentry, Clarity...), and any of them hanging hangs the goto.
  // The login fields only need the HTML.
  await page.goto(process.env.SEATSPY_LOGIN_URL!, { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(process.env.SEATSPY_EMAIL!);
  await page.locator("#password").fill(process.env.SEATSPY_PASSWORD!);
  await page.locator("#submit").click();
  await page.waitForURL((url) => !url.pathname.includes("sign-in"), { timeout: 30000 });

  return { browser, context, page };
}

// The form fields are Tom Select comboboxes. Clicking them through the UI is
// flaky (the inner input sits "outside the viewport" for Playwright), so values
// go through Tom Select's API, which fires the same "change" a manual pick does.
// Options load asynchronously, hence the waits.
type TomSelectElement = HTMLSelectElement & {
  tomselect?: {
    options: Record<string, { iata?: string; iatas?: string }>;
    setValue: (value: string) => void;
  };
};

async function selectAirline(page: Page, airline: SeatspyAirline) {
  await page.waitForFunction(
    (code) => !!(document.querySelector("#airline") as TomSelectElement | null)?.tomselect?.options?.[code],
    airline,
    { timeout: 30000 },
  );
  await page.evaluate(
    (code) => (document.querySelector("#airline") as TomSelectElement).tomselect!.setValue(code),
    airline,
  );
}

// Airports are keyed by an internal id; the IATA code lives in each option's "iata"/"iatas".
async function selectAirport(page: Page, fieldId: "outbound" | "inbound", iata: string) {
  const keyHandle = await page.waitForFunction(
    ({ fieldId, iata }) => {
      const select = document.querySelector(`#${fieldId}`) as TomSelectElement | null;
      if (!select?.tomselect) return null;
      const match = Object.entries(select.tomselect.options).find(
        ([, option]) =>
          option.iata === iata || (typeof option.iatas === "string" && option.iatas.split(/[\s,]+/).includes(iata)),
      );
      return match ? match[0] : null;
    },
    { fieldId, iata },
    { timeout: 30000 },
  );
  const key = (await keyHandle.jsonValue()) as string;

  await page.evaluate(
    ({ fieldId, key }) => (document.querySelector(`#${fieldId}`) as TomSelectElement).tomselect!.setValue(key),
    { fieldId, key },
  );
}

type RawYearResponse = {
  data?: { dates?: RawDate[] };
};

type RawDate = {
  startDate: string; // "Sun, 19 Jul 2026 00:00:00 GMT"
  flights?: RawFlight[];
};

type RawFlight = {
  originIATA: string;
  economy: number;
  economyMiles: number | null;
  premium: number;
  premiumMiles: number | null;
  business: number;
  businessMiles: number | null;
  // First class only exists on some airlines (British, Cathay, Etihad,
  // Qantas...). The field name never shows up in the site's JS, so both
  // plausible spellings are accepted and anything else is logged (see warnAboutFirstClassFields).
  first?: number;
  firstMiles?: number | null;
  firstClass?: number;
  firstClassMiles?: number | null;
};

function firstClassSeats(flight: RawFlight): number {
  return flight.first ?? flight.firstClass ?? 0;
}

function firstClassMiles(flight: RawFlight): number | null {
  return flight.firstMiles ?? flight.firstClassMiles ?? null;
}

// Once per process: when no known first-class field comes back, print the keys
// that did, so the name can be fixed without spending another search.
let warnedAboutFields = false;
function warnAboutFirstClassFields(flight: RawFlight | undefined, onLog: OnLog) {
  if (warnedAboutFields || !flight) return;
  warnedAboutFields = true;
  const hasFirstClass = ["first", "firstMiles", "firstClass", "firstClassMiles"].some((field) => field in flight);
  if (!hasFirstClass) {
    onLog(
      "Atenção: a resposta do SeatSpy não trouxe campo de primeira classe conhecido. " +
        `Campos recebidos: ${Object.keys(flight).join(", ")}`,
    );
  }
}

function toIsoDate(gmtDate: string): string {
  return new Date(gmtDate).toISOString().slice(0, 10);
}

function cabinAvailability(
  flights: RawFlight[],
  seatsOf: (flight: RawFlight) => number,
  milesOf: (flight: RawFlight) => number | null,
): CabinAvailability {
  const withSeats = flights.filter((flight) => seatsOf(flight) > 0);
  if (withSeats.length === 0) return { available: false, miles: null, seats: 0 };

  const priced = withSeats.filter((flight) => milesOf(flight) !== null);
  if (priced.length === 0) {
    // Available without a price (mixed or partner fare): report the day's largest seat count.
    return { available: true, miles: null, seats: Math.max(...withSeats.map(seatsOf)) };
  }

  // The seats must be the QUOTED flight's, not the day's maximum, or "9 seats"
  // would be announced for a price that only exists on a flight with 2.
  const cheapest = priced.reduce((a, b) => (milesOf(a)! <= milesOf(b)! ? a : b));
  return { available: true, miles: milesOf(cheapest), seats: seatsOf(cheapest) };
}

function extractDays(dates: RawDate[]): SeatspyDay[] {
  return dates
    .map((rawDate) => {
      const flights = rawDate.flights ?? [];
      return {
        date: toIsoDate(rawDate.startDate),
        economy: cabinAvailability(flights, (f) => f.economy, (f) => f.economyMiles),
        premium: cabinAvailability(flights, (f) => f.premium, (f) => f.premiumMiles),
        business: cabinAvailability(flights, (f) => f.business, (f) => f.businessMiles),
        first: cabinAvailability(flights, firstClassSeats, firstClassMiles),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

type Direction = "outbound" | "inbound";

const DIRECTION_LABEL: Record<Direction, string> = { outbound: "ida", inbound: "volta" };

// Runs the search through the UI and captures the /api/retrieve-year-data JSONs
// the site itself requests; each response carries a whole year of one direction.
export async function searchSeatspy(
  page: Page,
  params: SeatspySearchParams,
  onLog: OnLog,
  onProgress: OnProgress,
): Promise<{ outbound: SeatspyDay[]; inbound: SeatspyDay[] | null }> {
  const origin = params.origin.toUpperCase();
  const destination = params.destination.toUpperCase();

  onLog(`Abrindo formulário de busca (${AIRLINE_NAMES[params.airline]})...`);
  // Same reason as the login: wait for the HTML only; the rest of the flow
  // already waits for Tom Select to load.
  await page.goto("https://www.seatspy.com/", { waitUntil: "domcontentloaded" });

  // Responses do not say which direction they are; tell by the flights' origin
  // IATA, falling back to arrival order (outbound comes first).
  const byDirection = new Map<Direction, SeatspyDay[]>();
  // When the airline does not fly the route, SeatSpy answers quickly with an
  // empty day list (or an error status) instead of never answering; without
  // this the code waited for data that would never come until the 2 min timeout.
  const emptyDirections = new Set<Direction>();
  const directionByOrder = (): Direction =>
    byDirection.has("outbound") || emptyDirections.has("outbound") ? "inbound" : "outbound";

  const onResponse = async (response: Response) => {
    if (!response.url().includes("/api/retrieve-year-data")) return;

    if (response.status() !== 200) {
      const direction = directionByOrder();
      emptyDirections.add(direction);
      onLog(
        `SeatSpy respondeu com erro (status ${response.status()}) pra ${DIRECTION_LABEL[direction]}. Tratando como sem disponibilidade.`,
      );
      return;
    }

    let body: RawYearResponse;
    try {
      body = (await response.json()) as RawYearResponse;
    } catch {
      return;
    }
    const dates = body.data?.dates ?? [];

    if (dates.length === 0) {
      const direction = directionByOrder();
      emptyDirections.add(direction);
      onLog(
        `SeatSpy não encontrou disponibilidade pra ${DIRECTION_LABEL[direction]} (a companhia pode não operar esse trecho).`,
      );
      return;
    }

    const firstFlight = dates.flatMap((date) => date.flights ?? [])[0];
    let direction: Direction;
    if (firstFlight?.originIATA === origin) direction = "outbound";
    else if (firstFlight?.originIATA === destination) direction = "inbound";
    else direction = directionByOrder();

    warnAboutFirstClassFields(firstFlight, onLog);
    byDirection.set(direction, extractDays(dates));
    onLog(`Recebido ano completo da ${DIRECTION_LABEL[direction]} (${dates.length} dias).`);
  };
  page.on("response", onResponse);

  try {
    await selectAirline(page, params.airline);
    await selectAirport(page, "outbound", origin);
    await selectAirport(page, "inbound", destination);

    // Radios and buttons have the same viewport problem: click through JS.
    await page.evaluate((roundTrip) => {
      document.querySelector<HTMLLabelElement>(`label[for="${roundTrip ? "return" : "one-way"}"]`)?.click();
    }, params.roundTrip);
    onProgress(0.15);

    onLog(`Buscando ${origin} → ${destination}${params.roundTrip ? " (ida e volta)" : ""}...`);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#search-submit")?.click();
    });

    // Directions arrive asynchronously; an "empty" one (see onResponse) counts
    // as resolved too, so nothing waits for the timeout in vain.
    const needed = params.roundTrip ? 2 : 1;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && byDirection.size + emptyDirections.size < needed) {
      await page.waitForTimeout(500);
      onProgress(Math.min(0.15 + (byDirection.size + emptyDirections.size) * 0.4, 0.95));
    }

    const airlineName = AIRLINE_NAMES[params.airline];
    if (emptyDirections.has("outbound")) {
      throw new Error(
        `Nenhuma disponibilidade encontrada para ${origin} → ${destination}. É possível que a ${airlineName} não opere esse trecho.`,
      );
    }
    if (!byDirection.has("outbound")) {
      throw new Error("A busca no SeatSpy não retornou dados (tempo esgotado). Tente de novo.");
    }
    if (params.roundTrip) {
      if (emptyDirections.has("inbound")) {
        throw new Error(
          `Nenhuma disponibilidade encontrada para a volta (${destination} → ${origin}). É possível que a ${airlineName} não opere esse trecho nessa direção.`,
        );
      }
      if (!byDirection.has("inbound")) {
        throw new Error("A busca retornou só a ida; a volta não chegou a tempo. Tente de novo.");
      }
    }

    onProgress(1);
    return { outbound: byDirection.get("outbound")!, inbound: byDirection.get("inbound") ?? null };
  } finally {
    page.off("response", onResponse);
  }
}

const CABINS = [
  { field: "economy", label: "Econômica", colorClass: "cabin-economy" },
  { field: "premium", label: "Premium", colorClass: "cabin-premium" },
  { field: "business", label: "Executiva", colorClass: "cabin-business" },
  { field: "first", label: "Primeira Classe", colorClass: "cabin-first" },
] as const;

// `showSeats = false` removes seats from the whole report: from the text that
// goes into the alert and from the days, so the screen hides them too. Seats
// hidden on screen but present in the copied text would be the worst mix.
export function buildSeatspyReport(days: SeatspyDay[], ceilings: SeatspyCeilings = {}, showSeats = true): SeatspyReport {
  const sections = CABINS.map(({ field, label, colorClass }) => {
    const ceiling = ceilings[field];
    const available = days.filter((day) => {
      const cabin = day[field];
      if (!cabin.available) return false;
      // Without a price the ceiling cannot be checked; showing the day beats
      // hiding real availability for lack of that number.
      return ceiling == null || cabin.miles == null || cabin.miles <= ceiling;
    });

    if (available.length === 0) {
      return {
        label,
        colorClass,
        min: null,
        max: null,
        days: [],
        text: "Nenhuma disponibilidade encontrada nesse período.",
      };
    }

    const formattedDays = available.map((day) => {
      const { miles, seats } = day[field];
      const formatted: SectionDay = {
        date: day.date,
        valueK: miles != null ? Math.round(miles / 10) / 100 : null,
      };
      if (showSeats) formatted.seats = seats;
      return formatted;
    });
    const seatsByDate = new Map(formattedDays.map((day) => [day.date, day.seats ?? 0]));
    const knownValues = formattedDays.map((day) => day.valueK).filter((value): value is number => value != null);

    return {
      label,
      colorClass,
      min: knownValues.length > 0 ? Math.min(...knownValues) : null,
      max: knownValues.length > 0 ? Math.max(...knownValues) : null,
      days: formattedDays,
      text: formatDatesByMonth(
        formattedDays.map((day) => day.date),
        showSeats
          ? (date) => {
              const seats = seatsByDate.get(date) ?? 0;
              return seats > 0 ? ` (${seats})` : "";
            }
          : undefined,
      ),
    };
  });

  return { sections };
}
