import type { Page } from "playwright";
import { RateLimiter, type OnLog } from "../../core/common.ts";

// Google Flights' price calendar, the one its date picker shows: for each
// outbound date, the cheapest round trip with a fixed number of days, in reais.
// It is what Eduardo read by hand to pick LATAM business dates to test.
//
// The page calls `FlightsFrontendService/GetCalendarPicker` with a JSON body
// (route, airlines, cabin, date range, trip length). The bot opens a search so
// the page hands it a valid endpoint URL, then asks for its own windows from
// inside the page. Measured on 2026-10-23: the trip length must be one number
// (a range is refused), and 6 months fit in one call while 12 do not.

const GOOGLE_MIN_INTERVAL_MS = Number(process.env.GOOGLE_FLIGHTS_INTERVAL_MS) || 5000;
const googleRateLimiter = new RateLimiter(GOOGLE_MIN_INTERVAL_MS);
export const CALENDAR_WINDOW_DAYS = 180;

// The cabin codes in the request body, as the page sends them.
const CABIN_CODES = { Economy: 1, Business: 3 } as const;
export type GoogleCabin = keyof typeof CABIN_CODES;

export type CalendarQuery = {
  origin: string;
  destination: string;
  airline: string; // IATA, e.g. "LA"
  cabin: GoogleCabin;
  stayDays: number;
};

export type RoundTripPrice = { outbound: string; return: string; priceReais: number };

function fail(detail: string): never {
  throw new Error(`O calendário do Google Flights veio num formato inesperado: ${detail}.`);
}

// The response is Google's batch format: an anti-JSON prefix, then length-prefixed
// chunks; the payload is a JSON string inside the "wrb.fr" entry.
export function readCalendarResponse(text: string): RoundTripPrice[] {
  const chunk = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith('[["wrb.fr"'));
  if (!chunk) fail('falta o bloco "wrb.fr"');
  const entry = (JSON.parse(chunk) as unknown[][])[0]!;
  if (entry[2] == null) {
    const refused = JSON.stringify(entry).includes("ErrorResponse");
    throw new Error(
      refused
        ? "O Google Flights recusou o pedido do calendário (período ou duração fora do que ele aceita)."
        : "O Google Flights devolveu o calendário vazio.",
    );
  }
  const payload = JSON.parse(entry[2] as string) as unknown[];
  const days = payload[1];
  if (!Array.isArray(days)) fail("falta a lista de dias");
  const prices: RoundTripPrice[] = [];
  for (const day of days as unknown[][]) {
    const [outbound, back, offer] = day;
    if (typeof outbound !== "string" || typeof back !== "string") fail("dia sem datas de ida e volta");
    // A day without a price has none to show: no flight that day, not zero.
    const price = Array.isArray(offer) && Array.isArray(offer[0]) ? offer[0][1] : null;
    if (price == null) continue;
    if (typeof price !== "number") fail(`preço de ${outbound} não é número`);
    prices.push({ outbound, return: back, priceReais: price });
  }
  return prices;
}

function requestBody(query: CalendarQuery, range: { from: string; until: string }) {
  const slice = (from: string, to: string) => [
    [[[from, 0]]],
    [[[to, 0]]],
    null,
    0,
    [query.airline],
    null,
    range.from,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    2,
  ];
  const search = [
    null,
    [
      null,
      null,
      1,
      null,
      [],
      CABIN_CODES[query.cabin],
      [1, 0, 0, 0],
      null,
      null,
      null,
      null,
      null,
      null,
      [slice(query.origin, query.destination), slice(query.destination, query.origin)],
      null,
      null,
      null,
      1,
    ],
    [range.from, range.until],
    null,
    [query.stayDays, query.stayDays],
  ];
  return `f.req=${encodeURIComponent(JSON.stringify([null, JSON.stringify(search)]))}&`;
}

// Opens a search for the route so the page makes its own calendar call: that
// call's URL carries the session parameters the endpoint wants.
export async function openCalendarEndpoint(page: Page, query: CalendarQuery): Promise<string> {
  await googleRateLimiter.waitTurn();
  let endpoint = "";
  const listen = (request: { url: () => string }) => {
    if (request.url().includes("/GetCalendarPicker")) endpoint = request.url();
  };
  page.on("request", listen);
  try {
    const cabin = query.cabin === "Business" ? " business class" : "";
    const words = `Flights from ${query.origin} to ${query.destination}${cabin}`;
    await page.goto(`https://www.google.com/travel/flights?q=${encodeURIComponent(words)}&hl=pt-BR&curr=BRL`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.getByPlaceholder("Partida").first().click({ timeout: 30_000 });
    for (let waited = 0; !endpoint && waited < 20_000; waited += 500) await page.waitForTimeout(500);
  } finally {
    page.off("request", listen);
  }
  if (!endpoint) throw new Error("O Google Flights não abriu o calendário de preços da busca.");
  return endpoint;
}

export async function fetchCalendarWindow(
  page: Page,
  endpoint: string,
  query: CalendarQuery,
  range: { from: string; until: string },
): Promise<RoundTripPrice[]> {
  await googleRateLimiter.waitTurn();
  const response = await page.evaluate(
    async ({ url, body }) => {
      try {
        const result = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body,
          credentials: "include",
        });
        return { status: result.status, text: await result.text() };
      } catch (error) {
        return { status: -1, text: String(error) };
      }
    },
    { url: endpoint, body: requestBody(query, range) },
  );
  if (response.status !== 200) {
    throw new Error(`O calendário do Google Flights respondeu ${response.status} (${response.text.slice(0, 80)}).`);
  }
  return readCalendarResponse(response.text);
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// The whole period in windows the endpoint accepts.
export async function searchGoogleCalendar(
  page: Page,
  query: CalendarQuery,
  period: { from: string; until: string },
  onLog: OnLog = () => {},
): Promise<RoundTripPrice[]> {
  const endpoint = await openCalendarEndpoint(page, query);
  const prices: RoundTripPrice[] = [];
  for (let from = period.from; from <= period.until; from = addDays(from, CALENDAR_WINDOW_DAYS + 1)) {
    const until = [addDays(from, CALENDAR_WINDOW_DAYS), period.until].sort()[0]!;
    onLog(`Google Flights: ${query.origin} ⇄ ${query.destination}, idas de ${from} a ${until}...`);
    prices.push(...(await fetchCalendarWindow(page, endpoint, query, { from, until })));
  }
  return prices;
}
