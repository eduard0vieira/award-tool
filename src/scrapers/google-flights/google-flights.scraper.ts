import type { Page, Route } from "playwright";
import { RateLimiter, type OnLog } from "../../core/common.ts";

// Google Flights' price calendar, the one its date picker shows: for each
// outbound date, the cheapest round trip with a fixed number of days, in reais.
// It is what Eduardo read by hand to pick LATAM business dates to test.
//
// Google signs the page's own calendar requests: measured on 2026-10-23, a body
// built by the bot, or the page's body with any field changed, comes back with
// error 13. So the bot drives the page instead: a results URL with the dates,
// cabin and airline, then the picker paged forward month by month, reading the
// calls the page makes.

const GOOGLE_MIN_INTERVAL_MS = Number(process.env.GOOGLE_FLIGHTS_INTERVAL_MS) || 5000;
const googleRateLimiter = new RateLimiter(GOOGLE_MIN_INTERVAL_MS);
const MAX_PICKER_PAGES = 14;
// A page in a background window answers slowly; 20 s already cut a month short.
const MONTH_WAIT_MS = 40_000;

// The cabin codes in the page's request body.
const CABIN_CODES = { Economy: 1, Business: 3 } as const;
export type GoogleCabin = keyof typeof CABIN_CODES;
// The name the airlines filter lists for each code the bot asks for.
const AIRLINE_NAMES = { LA: "LATAM" } as const;

export type CalendarQuery = {
  origin: string;
  destination: string;
  airline: keyof typeof AIRLINE_NAMES;
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

type CalendarCall = { airlines: unknown; cabin: unknown; stay: unknown; range: [string, string]; prices: RoundTripPrice[] };

function readCalendarCall(postData: string | null, text: string): CalendarCall {
  const raw = new URLSearchParams(postData ?? "").get("f.req");
  if (!raw) fail("o pedido da página não tem f.req");
  const search = JSON.parse((JSON.parse(raw) as string[])[1]!) as any[];
  const range = search[2];
  if (!Array.isArray(range) || typeof range[0] !== "string" || typeof range[1] !== "string") fail("o pedido não tem o período");
  return {
    airlines: search[1]?.[13]?.[0]?.[4],
    cabin: search[1]?.[5],
    stay: search[4],
    range: [range[0], range[1]],
    prices: readCalendarResponse(text),
  };
}

// A month the page shows for a different airline, cabin or stay would put the
// wrong prices in the band, so each call is checked against what was asked.
function checkCall(call: CalendarCall, query: CalendarQuery) {
  if (JSON.stringify(call.airlines) !== JSON.stringify([query.airline])) {
    throw new Error(`O filtro de companhia do Google Flights não ficou só em ${AIRLINE_NAMES[query.airline]} (veio ${JSON.stringify(call.airlines)}).`);
  }
  if (call.cabin !== CABIN_CODES[query.cabin]) throw new Error(`O Google Flights buscou outra cabine (código ${call.cabin}).`);
  if (JSON.stringify(call.stay) !== JSON.stringify([query.stayDays, query.stayDays])) {
    throw new Error(`O Google Flights buscou viagens de ${JSON.stringify(call.stay)} dias, não de ${query.stayDays}.`);
  }
}

// The `tfs` parameter of a results URL is a protobuf of the search, read from
// real URLs the page wrote after filtering by airline. Building it puts the
// dates, cabin and airline in the URL, with no search text to parse and no
// filter left over from the last search.
function protoField(field: number, value: number | string | Uint8Array): number[] {
  const varint = (n: number) => {
    const bytes: number[] = [];
    for (; n >= 0x80; n = Math.floor(n / 0x80)) bytes.push((n % 0x80) | 0x80);
    return [...bytes, n];
  };
  if (typeof value === "number") return [...varint(field * 8), ...varint(value)];
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
}

export function searchUrl(query: CalendarQuery, outbound: string) {
  const airport = (code: string) => Uint8Array.from([...protoField(1, 1), ...protoField(2, code)]);
  const leg = (date: string, from: string, to: string) =>
    Uint8Array.from([...protoField(2, date), ...protoField(6, query.airline), ...protoField(13, airport(from)), ...protoField(14, airport(to))]);
  const tfs = Uint8Array.from([
    ...protoField(1, 28),
    ...protoField(2, 2),
    ...protoField(3, leg(outbound, query.origin, query.destination)),
    ...protoField(3, leg(addDays(outbound, query.stayDays), query.destination, query.origin)),
    ...protoField(8, 1),
    ...protoField(9, CABIN_CODES[query.cabin]),
    ...protoField(14, 1),
    // Copied as the page writes it: a field set to -1.
    0x82, 0x01, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ...protoField(19, 1),
  ]);
  return `https://www.google.com/travel/flights/search?tfs=${Buffer.from(tfs).toString("base64url")}&hl=pt-BR&curr=BRL`;
}

async function openSearch(page: Page, query: CalendarQuery, firstOutbound: string) {
  const url = searchUrl(query, firstOutbound);
  // The page may come from LATAM's site, whose own redirects can cut this navigation.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(async (error: Error) => {
    if (!/interrupted by another navigation/.test(error.message)) throw error;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  });
  const name = AIRLINE_NAMES[query.airline];
  await page
    .locator(`[aria-label="${name}, Companhias aéreas, Selecionado"]`)
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {
      throw new Error(`O Google Flights não abriu a busca ${query.origin} ⇄ ${query.destination} filtrada só pela ${name}.`);
    });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

export type GoogleCalendar = { prices: RoundTripPrice[]; cutAfter: { date: string; reason: string } | null };

export async function searchGoogleCalendar(
  page: Page,
  query: CalendarQuery,
  period: { from: string; until: string },
  onLog: OnLog = () => {},
): Promise<GoogleCalendar> {
  await googleRateLimiter.waitTurn();
  onLog(`Google Flights: ${query.origin} ⇄ ${query.destination}, ${AIRLINE_NAMES[query.airline]}, ida e volta de ${query.stayDays} dias...`);
  await openSearch(page, query, period.from);
  // The bot's Chrome is often behind other windows, where Chrome slows the page down.
  await page.bringToFront();

  const calls: Promise<CalendarCall>[] = [];
  // Read through a route, not page.on("response"): Chrome sometimes drops a
  // response body before it can be read. The page's own body goes out unchanged.
  const capture = async (route: Route) => {
    const call = route.fetch().then(async (response) => {
      const text = await response.text();
      await route.fulfill({ response, body: text });
      return readCalendarCall(route.request().postData(), text);
    });
    // A call that arrives after the sweep ends is never awaited; its failure must not go unhandled.
    call.catch(() => {});
    calls.push(call);
    await call.catch(() => route.abort().catch(() => {}));
  };
  await page.route("**/GetCalendarPicker*", capture);
  const byOutbound = new Map<string, RoundTripPrice>();
  try {
    // The month the picker asks for after `trigger`. A wrong airline, cabin or
    // stay throws; a month that never comes or comes refused is returned as a failure.
    const loadMonth = async (trigger: () => Promise<void>): Promise<CalendarCall | { failure: string }> => {
      const seen = calls.length;
      await trigger();
      for (let waited = 0; calls.length === seen && waited < MONTH_WAIT_MS; waited += 250) await page.waitForTimeout(250);
      if (calls.length === seen) return { failure: "o mês seguinte não carregou" };
      let call: CalendarCall;
      try {
        call = await calls[seen]!;
      } catch (error) {
        return { failure: (error as Error).message };
      }
      checkCall(call, query);
      for (const price of call.prices) {
        if (price.outbound >= period.from && price.outbound <= period.until) byOutbound.set(price.outbound, price);
      }
      onLog(`Google Flights: ${call.range[0]} a ${call.range[1]}, ${call.prices.length} dias com preço.`);
      return call;
    };

    const datePicker = page.getByPlaceholder("Partida").first();
    let first = await loadMonth(() => datePicker.click({ timeout: 30_000 }));
    if ("failure" in first) {
      onLog(`Google Flights: o calendário não abriu (${first.failure}). Abrindo de novo...`);
      first = await loadMonth(async () => {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(1500);
        await datePicker.click({ timeout: 30_000 });
      });
    }
    if ("failure" in first) throw new Error(`O Google Flights não abriu o calendário de preços da busca: ${first.failure}.`);
    if (first.range[0] > period.from) {
      throw new Error(`O calendário do Google Flights começou em ${first.range[0]}, depois de ${period.from}.`);
    }

    let last = first;
    const forward = page.locator('[role="dialog"] button[aria-label="Avançar"]').first();
    // The last month Google sells has no next one: the calendar ends there.
    const canGoForward = async () =>
      (await forward.isVisible().catch(() => false)) && (await forward.isEnabled({ timeout: 2000 }).catch(() => false));
    for (let pages = 0; last.range[1] < period.until && pages < MAX_PICKER_PAGES; pages++) {
      if (!(await canGoForward())) break;
      await googleRateLimiter.waitTurn();
      let next = await loadMonth(() => forward.click({ timeout: 10_000 }));
      if ("failure" in next && (await canGoForward())) {
        // Going back a month and forward again makes the picker ask for that month anew.
        onLog(`Google Flights: o mês depois de ${last.range[1]} falhou (${next.failure}). Tentando de novo...`);
        next = await loadMonth(async () => {
          await page.locator('[role="dialog"] button[aria-label="Anterior"]').first().click({ timeout: 10_000 });
          await page.waitForTimeout(1500);
          await forward.click({ timeout: 10_000 });
        });
      }
      if (!("failure" in next)) {
        last = next;
        continue;
      }
      if (!(await canGoForward())) break;
      // What was read stays: a later month lost does not undo the earlier ones.
      onLog(`Google Flights: parou depois de ${last.range[1]} (${next.failure}).`);
      return { prices: sortedPrices(byOutbound), cutAfter: { date: last.range[1], reason: next.failure } };
    }
  } finally {
    await page.unroute("**/GetCalendarPicker*", capture);
  }
  return { prices: sortedPrices(byOutbound), cutAfter: null };
}

function sortedPrices(byOutbound: Map<string, RoundTripPrice>) {
  return [...byOutbound.values()].sort((a, b) => a.outbound.localeCompare(b.outbound));
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
