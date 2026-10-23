import type { Page, Route } from "playwright";
import { RateLimiter, type OnLog } from "../../core/common.ts";

// Google Flights' price calendar, the one its date picker shows: for each
// outbound date, the cheapest round trip with a fixed number of days, in reais.
// It is what Eduardo read by hand to pick LATAM business dates to test.
//
// Google signs the page's own calendar requests: measured on 2026-10-23, a body
// built by the bot, or the page's body with any field changed, comes back with
// error 13. So the bot drives the page instead: dates in the search URL, the
// airline in its filter, then the picker paged forward month by month, reading
// the calls the page makes.

const GOOGLE_MIN_INTERVAL_MS = Number(process.env.GOOGLE_FLIGHTS_INTERVAL_MS) || 5000;
const googleRateLimiter = new RateLimiter(GOOGLE_MIN_INTERVAL_MS);
const MAX_PICKER_PAGES = 14;

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

async function openSearch(page: Page, query: CalendarQuery, firstOutbound: string) {
  const cabin = query.cabin === "Business" ? " business class" : "";
  const words = `Flights from ${query.origin} to ${query.destination} on ${firstOutbound} through ${addDays(firstOutbound, query.stayDays)}${cabin}`;
  await page.goto(`https://www.google.com/travel/flights?q=${encodeURIComponent(words)}&hl=pt-BR&curr=BRL`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const airlinesChip = page.locator('button[aria-label*="ompanhia"], [role="button"][aria-label*="ompanhia"]').first();
  await airlinesChip.click({ timeout: 30_000 });
  const panel = page.locator('[role="dialog"]').filter({ hasText: "Selecionar todas" }).last();
  await panel.getByRole("switch").first().click({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await panel.getByRole("checkbox", { name: AIRLINE_NAMES[query.airline], exact: true }).first().click({ timeout: 15_000 });
  await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
}

export async function searchGoogleCalendar(
  page: Page,
  query: CalendarQuery,
  period: { from: string; until: string },
  onLog: OnLog = () => {},
): Promise<RoundTripPrice[]> {
  await googleRateLimiter.waitTurn();
  onLog(`Google Flights: ${query.origin} ⇄ ${query.destination}, ${AIRLINE_NAMES[query.airline]}, ida e volta de ${query.stayDays} dias...`);
  await openSearch(page, query, period.from);

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
    const nextCall = async (seen: number) => {
      for (let waited = 0; calls.length === seen && waited < 20_000; waited += 250) await page.waitForTimeout(250);
      if (calls.length === seen) return null;
      const call = await calls[seen]!;
      checkCall(call, query);
      for (const price of call.prices) {
        if (price.outbound >= period.from && price.outbound <= period.until) byOutbound.set(price.outbound, price);
      }
      onLog(`Google Flights: ${call.range[0]} a ${call.range[1]}, ${call.prices.length} dias com preço.`);
      return call;
    };

    await page.getByPlaceholder("Partida").first().click({ timeout: 30_000 });
    let last = await nextCall(0);
    if (!last) throw new Error("O Google Flights não abriu o calendário de preços da busca.");
    if (last.range[0] > period.from) {
      throw new Error(`O calendário do Google Flights começou em ${last.range[0]}, depois de ${period.from}.`);
    }
    const forward = page.locator('[role="dialog"] button[aria-label="Avançar"]').first();
    // The last month Google sells has no next one: the calendar ends there.
    const canGoForward = async () =>
      (await forward.isVisible().catch(() => false)) && (await forward.isEnabled({ timeout: 2000 }).catch(() => false));
    for (let pages = 0; last.range[1] < period.until && pages < MAX_PICKER_PAGES; pages++) {
      if (!(await canGoForward())) break;
      await googleRateLimiter.waitTurn();
      const seen = calls.length;
      await forward.click({ timeout: 10_000 });
      const call = await nextCall(seen);
      if (call) last = call;
      else if (await canGoForward()) {
        throw new Error(`O Google Flights parou de carregar o calendário depois de ${last.range[1]}.`);
      }
    }
  } finally {
    await page.unroute("**/GetCalendarPicker*", capture);
  }
  return [...byOutbound.values()].sort((a, b) => a.outbound.localeCompare(b.outbound));
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
