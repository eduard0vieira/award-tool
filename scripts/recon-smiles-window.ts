import { openChromeSession } from "../src/core/chrome-session.ts";

// Measures two things on a route: how many days ahead Smiles sells (and what it
// answers past that) and whether the 7-day calendar comes, with and without partners.
//
// Usage: npx tsx scripts/recon-smiles-window.ts GRU MRU

const [origin = "GRU", destination = "MRU"] = process.argv.slice(2);
const API_ROOT = "https://api-air-flightsearch-prd.smiles.com.br/";
const HEADERS = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "WEB",
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9",
};

function todayPlus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function searchUrl(date: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    originAirportCode: origin,
    destinationAirportCode: destination,
    departureDate: date,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
    ...extra,
  });
  return `${API_ROOT}v1/airlines/search?${query}`;
}

async function main() {
  const session = await openChromeSession(false, "Smiles");
  await session.page.goto(API_ROOT, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await session.page.waitForTimeout(3000);

  const call = async (label: string, url: string) => {
    const response = await session.page.evaluate(
      async ({ url, headers }) => {
        const result = await fetch(url, { headers });
        return { status: result.status, text: await result.text() };
      },
      { url, headers: HEADERS },
    );
    let summary = response.text.replace(/\s+/g, " ").slice(0, 300);
    if (response.status === 200) {
      const json = JSON.parse(response.text);
      const segment = json.requestedFlightSegmentList?.[0];
      summary =
        `hasCalendar=${json.hasCalendar} calendarStatus=${json.calendarStatus} resultType=${json.resultType} ` +
        `voos=${segment?.flightList?.length ?? 0} calendario=${segment?.calendarDayList?.length ?? 0} ` +
        `gds=${[...new Set((segment?.flightList ?? []).map((flight: { sourceGDS: string }) => flight.sourceGDS))].join("/")}`;
    }
    console.log(`[${label}] ${response.status} · ${summary}`);
    await session.page.waitForTimeout(4000);
  };

  try {
    await call(`+30 congener=false`, searchUrl(todayPlus(30)));
    await call(`+30 congener=true`, searchUrl(todayPlus(30), { forceCongener: "true" }));
    for (const days of [320, 326, 328, 329, 330, 331, 335]) await call(`+${days} ${todayPlus(days)}`, searchUrl(todayPlus(days)));
    await call(
      `+30 sigla inválida`,
      searchUrl(todayPlus(30)).replace(`destinationAirportCode=${destination}`, "destinationAirportCode=XQZ"),
    );
  } finally {
    await session.page.close().catch(() => {});
    process.exit(0);
  }
}

main();
