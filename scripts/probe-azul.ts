// Three questions the recon left as inference rather than measurement:
//  A. is the cap really 6 dates, or did the 7th call break because of the DATE
//     that came with it (day 132) and not the count?
//  B. does flexibleDays ±3 change anything in the response?
//  C. does the site take 30 navigations in a row, the module's real regime?
//     (the Smiles lesson: volume has a budget, and it only shows by measuring)
import type { Page } from "playwright";
import { openChromeSession } from "../src/core/chrome-session.ts";

const ORIGIN = "VCP";
const DESTINATION = "REC";

function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}
function slashed(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}/${year}`;
}
function criterion(iso: string) {
  return { departureStation: ORIGIN, arrivalStation: DESTINATION, std: slashed(iso), departureDate: iso };
}
function requestBody(dates: string[], flex: number) {
  return {
    criteria: dates.map(criterion),
    passengers: [{ type: "ADT", count: "1", companionPass: false }],
    flexibleDays: { daysToLeft: String(flex), daysToRight: String(flex) },
    currencyCode: "BRL",
  };
}
function deepLink(iso: string): string {
  const query = new URLSearchParams({
    "c[0].ds": ORIGIN,
    "c[0].std": slashed(iso),
    "c[0].as": DESTINATION,
    "p[0].t": "ADT",
    "p[0].c": "1",
    "p[0].cp": "false",
    "f.dl": "3",
    "f.dr": "3",
    cc: "PTS",
  });
  return `https://www.voeazul.com.br/br/pt/home/selecao-voo?${query}`;
}

type CallResult = { status: number; ms: number; trips: { std: string; low: number | null }[]; raw: string };

async function call(page: Page): Promise<CallResult> {
  const start = Date.now();
  const nextResponse = page.waitForResponse((response) => /availability\/v\d+\/availability$/.test(response.url()), {
    timeout: 60_000,
  });
  await page.goto(deepLink(daysFromToday(90)), { waitUntil: "domcontentloaded", timeout: 90_000 });
  const response = await nextResponse;
  const text = await response.text();
  const ms = Date.now() - start;
  let trips: { std: string; low: number | null }[] = [];
  try {
    const json = JSON.parse(text) as { data?: { trips?: { std?: string; fareInformation?: { lowestPoints?: number } }[] } };
    trips = (json.data?.trips ?? []).map((trip) => ({
      std: (trip.std ?? "").split("T")[0] ?? "",
      low: trip.fareInformation?.lowestPoints ?? null,
    }));
  } catch {
    // The status tells the story.
  }
  return { status: response.status(), ms, trips, raw: text };
}

async function main() {
  const session = await openChromeSession(false, "probe-azul");
  const page = session.page;

  // Every navigation's availability request is rewritten with the body under test.
  let currentBody: object | null = null;
  await page.route("**/availability/v*/availability", async (route) => {
    if (!currentBody) return route.continue();
    await route.continue({ postData: JSON.stringify(currentBody) });
  });

  console.log("A. Teto de datas, todas dentro da mesma faixa (dias 90–125)\n");
  for (const count of [6, 7, 8, 10]) {
    // Squeezed into days 90..125: none goes past day 125, already known to be good.
    const dates = Array.from({ length: count }, (_, k) => daysFromToday(90 + Math.round((k * 35) / (count - 1))));
    currentBody = requestBody(dates, 3);
    const result = await call(page);
    console.log(`   ${count} datas (${dates[0]}..${dates[dates.length - 1]}) → ${result.status} | ${result.trips.length} trips | ${result.ms}ms`);
    if (result.status !== 200) console.log(`      ${result.raw.slice(0, 120)}`);
    await page.waitForTimeout(1500);
  }

  console.log("\nB. flexibleDays: ±3 contra 0\n");
  const sixDates = Array.from({ length: 6 }, (_, k) => daysFromToday(90 + k * 7));
  const comparison: Record<string, Record<string, number | null>> = {};
  for (const flex of [3, 0]) {
    currentBody = requestBody(sixDates, flex);
    const result = await call(page);
    console.log(`   flex ±${flex} → ${result.status} | ${result.trips.length} trips | ${result.raw.length} bytes`);
    comparison[`flex${flex}`] = Object.fromEntries(result.trips.map((trip) => [trip.std, trip.low]));
    await page.waitForTimeout(1500);
  }
  console.log("   lowestPoints por data:");
  for (const date of sixDates) {
    const withFlex = comparison.flex3?.[date] ?? null;
    const withoutFlex = comparison.flex0?.[date] ?? null;
    console.log(`     ${date}: ±3 → ${withFlex} | 0 → ${withoutFlex} ${withFlex === withoutFlex ? "" : "  ← DIFERENTE"}`);
  }

  console.log("\nC. Volume: 30 navegações seguidas, 6 datas cada (o regime real)\n");
  const start = Date.now();
  let firstProblem: string | null = null;
  for (let i = 0; i < 30; i++) {
    const dates = Array.from({ length: 6 }, (_, k) => daysFromToday(30 + i * 6 + k));
    currentBody = requestBody(dates, 3);
    let result: CallResult;
    try {
      result = await call(page);
    } catch (error) {
      console.log(`   #${i + 1} | sem resposta: ${(error as Error).message.slice(0, 80)}`);
      firstProblem ??= `#${i + 1} sem resposta`;
      continue;
    }
    const requested = new Set(dates);
    const returned = result.trips.map((trip) => trip.std);
    const matches = returned.length === dates.length && returned.every((date) => requested.has(date));
    const seconds = Math.round((Date.now() - start) / 1000);
    console.log(
      `   #${String(i + 1).padStart(2)} | ${seconds}s | status ${result.status} | ${result.trips.length} trips | ${result.ms}ms${matches ? "" : "  ← DATAS NÃO BATEM"}`,
    );
    if (result.status !== 200 && !firstProblem) firstProblem = `#${i + 1} status ${result.status}`;
    if (!matches && !firstProblem) firstProblem = `#${i + 1} datas não batem: ${returned.join(",")}`;
    if (result.status !== 200) console.log(`      ${result.raw.slice(0, 150)}`);
  }
  const total = Math.round((Date.now() - start) / 1000);
  console.log(`\n   30 navegações em ${total}s (${Math.round(total / 30)}s cada)`);
  console.log(`   primeiro problema: ${firstProblem ?? "nenhum"}`);
  console.log(`   → um ano por direção (61 chamadas) levaria ~${Math.round(((total / 30) * 61) / 60)} min`);

  await page.close();
  process.exit(0);
}

main();
