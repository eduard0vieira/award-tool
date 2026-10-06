import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { chromium } from "playwright";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// Measures what the Smiles 406 is keyed on. It spends the IP's budget on
// purpose: expect the search API to stay blocked for this network for a while.
//
// 1. Count: sequential calls on prd, at the bot's pace, until the first 406.
// 2. Variants, right after the 406: prd again, green, blue, prd without the
//    load-balancer cookie, and a fresh browser on prd.
// 3. Recovery: one prd call every 10 min until a 200, to get the window.
//
// Usage: npx tsx scripts/measure-smiles-budget.ts GRU CUN

const [origin = "GRU", destination = "CUN"] = process.argv.slice(2);
const PACE_MS = Number(process.env.SMILES_SEARCH_INTERVAL_MS) || 4000;
const MAX_CALLS = 600;
const RECOVERY_STEP_MS = 10 * 60_000;
const RECOVERY_MAX_MS = 4 * 60 * 60_000;

const HEADERS = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "WEB",
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9",
};

const root = (env: string) => `https://api-air-flightsearch-${env}.smiles.com.br/`;

function todayPlus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function searchPath(date: string): string {
  const query = new URLSearchParams({
    originAirportCode: origin,
    destinationAirportCode: destination,
    departureDate: date,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `v1/airlines/search?${query}`;
}

type Call = { status: number; text: string };

async function call(page: Page, env: string, date: string): Promise<Call> {
  return page.evaluate(
    async ({ url, headers }) => {
      const response = await fetch(url, { headers });
      return { status: response.status, text: await response.text() };
    },
    { url: root(env) + searchPath(date), headers: HEADERS },
  );
}

async function plantOn(page: Page, env: string) {
  await page.goto(root(env), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2000);
}

function summarize({ status, text }: Call): string {
  if (status !== 200) return `${status} ${text.replace(/\s+/g, " ").slice(0, 160)}`;
  const json = JSON.parse(text);
  const segment = json.requestedFlightSegmentList?.[0];
  const flights: { cabin?: string; fareList?: { type?: string; miles?: number }[] }[] = segment?.flightList ?? [];
  const economy = flights
    .filter((flight) => flight.cabin === "ECONOMIC")
    .flatMap((flight) => flight.fareList ?? [])
    .filter((fare) => fare.type === "SMILES_CLUB" && typeof fare.miles === "number")
    .map((fare) => fare.miles!);
  return (
    `200 resultType=${json.resultType} flights=${flights.length} calendar=${segment?.calendarDayList?.length ?? 0}` +
    (economy.length > 0 ? ` economyMin=${Math.min(...economy)}` : "")
  );
}

function clientIp(text: string): string | null {
  const match = text.match(/"clientIP"\s*:\s*"([^"]+)"/);
  return match ? match[1]! : null;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const session = await openChromeSession(false, "Smiles");
  const page = session.page;
  await session.context.clearCookies({ name: /^akaalb_/ });
  await plantOn(page, "prd");

  console.log(`${stamp()} counting on prd, ${origin}→${destination}, one call every ${PACE_MS} ms`);
  let calls = 0;
  let dayOffset = 1;
  let blocked: Call | null = null;
  const ips = new Set<string>();

  while (calls < MAX_CALLS) {
    const date = todayPlus(dayOffset);
    const started = Date.now();
    const result = await call(page, "prd", date);
    calls++;
    console.log(`${stamp()} #${calls} ${date} ${summarize(result)}`);

    if (result.status === 406 || result.status === 403) {
      blocked = result;
      break;
    }
    if (result.status === 452 && result.text.includes("data não permitida")) {
      dayOffset = 1;
    } else {
      dayOffset++;
    }
    if (result.status === 452 && result.text.includes("status code 503")) {
      await session.context.clearCookies({ name: /^akaalb_/ });
      await plantOn(page, "prd");
    }
    await sleep(Math.max(0, PACE_MS - (Date.now() - started)));
  }

  if (!blocked) {
    console.log(`${stamp()} RESULT: no block after ${calls} calls at ${PACE_MS} ms.`);
    process.exit(0);
  }

  const ip = clientIp(blocked.text);
  if (ip) ips.add(ip);
  console.log(`${stamp()} RESULT: first ${blocked.status} on call #${calls}`);
  const anonymized = blocked.text.replace(/"clientIP"\s*:\s*"[^"]+"/, '"clientIP": "0.0.0.0"');
  fs.writeFileSync(path.join(FIXTURES_DIR, `smiles-${blocked.status}-budget.json`), anonymized.trim() + "\n");

  const probeDate = todayPlus(30);
  const variant = async (label: string, run: () => Promise<Call>) => {
    const result = await run();
    const variantIp = clientIp(result.text);
    if (variantIp) ips.add(variantIp);
    console.log(`${stamp()} VARIANT ${label}: ${summarize(result)}`);
    await sleep(PACE_MS);
  };

  await variant("a prd again", () => call(page, "prd", probeDate));
  await variant("b green", async () => {
    await plantOn(page, "green");
    return call(page, "green", probeDate);
  });
  await variant("c blue", async () => {
    await plantOn(page, "blue");
    return call(page, "blue", probeDate);
  });
  await variant("d prd without akaalb", async () => {
    await session.context.clearCookies({ name: /^akaalb_/ });
    await plantOn(page, "prd");
    return call(page, "prd", probeDate);
  });
  await variant("e fresh browser prd", async () => {
    const browser = await chromium.launch({ headless: false, channel: "chrome" });
    try {
      const fresh = await (await browser.newContext()).newPage();
      await plantOn(fresh, "prd");
      return await call(fresh, "prd", probeDate);
    } finally {
      await browser.close();
    }
  });
  console.log(`${stamp()} distinct client IPs seen in 406 bodies: ${ips.size}`);

  await plantOn(page, "prd");
  const blockedAt = Date.now();
  while (Date.now() - blockedAt < RECOVERY_MAX_MS) {
    await sleep(RECOVERY_STEP_MS);
    const result = await call(page, "prd", probeDate);
    const minutes = Math.round((Date.now() - blockedAt) / 60000);
    console.log(`${stamp()} RECOVERY +${minutes} min: ${summarize(result)}`);
    if (result.status === 200) {
      console.log(`${stamp()} RESULT: recovered within ${minutes} min after ${calls} calls.`);
      process.exit(0);
    }
  }
  console.log(`${stamp()} RESULT: still blocked after ${RECOVERY_MAX_MS / 60000} min.`);
  process.exit(0);
}

main();
