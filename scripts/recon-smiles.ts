import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// PHASE 0 of the Smiles source: find out WHICH WAY the call passes today,
// before writing a single parsing line.
//
// What was known from the old project (projetos/cheap-flights, stopped since
// May 2025, see its ANALISE.md):
// - search endpoint: /v1/airlines/search, one GET per date;
// - it exists in three environments (prd, green, blue) and the old code used
//   `green`, a smell of an environment with weaker protection than production;
// - the calls impersonated the iOS APP (not the site) with its own x-api-key.
//   App APIs tend to be less protected, which this recon wants to confirm.
//
// The ladder, cheapest first:
//   1. a Node fetch with the app's headers         (no browser at all)
//   2. a fetch from INSIDE the page in the bot's Chrome (what works for AA)
//
// Nothing is processed: the first 200 response is saved raw.
//
// Usage: npx tsx scripts/recon-smiles.ts [GRU] [MIA] [2026-10-15]

const [origin = "GRU", destination = "MIA", date = daysFromToday(60)] = process.argv.slice(2);

function daysFromToday(days: number): string {
  const today = new Date();
  today.setDate(today.getDate() + days);
  return today.toISOString().slice(0, 10);
}

function searchUrl(environment: string): string {
  const params = new URLSearchParams({
    originAirportCode: origin.toUpperCase(),
    destinationAirportCode: destination.toUpperCase(),
    departureDate: date,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `https://api-air-flightsearch-${environment}.smiles.com.br/v1/airlines/search?${params}`;
}

// The app's client key (from the old code): a public app identifier, not an
// account credential; no login data goes in here. `channel: WEB` since
// 2026-09-15: with `APP` the edge answers 403 with a block page, and without any
// `channel` the response has no calendar. See docs/recon/smiles-blocking.md.
const APP_HEADERS: Record<string, string> = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "WEB",
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9",
};

type StepResult = { step: string; status: number | string; size: number; sample: string; body?: string };

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 220);
}

async function nodeStep(environment: string): Promise<StepResult> {
  const step = `node/${environment}`;
  try {
    const response = await fetch(searchUrl(environment), { headers: APP_HEADERS });
    const text = await response.text();
    return { step, status: response.status, size: text.length, sample: summarize(text), body: text };
  } catch (err) {
    return { step, status: "falhou", size: 0, sample: err instanceof Error ? err.message : String(err) };
  }
}

// Two ways out of the browser, because they fail for different reasons:
//
// (a) navigating straight to the API URL: Chrome goes to the API as if it were
//     a page, with no CORS in the way; the cleanest test of "does the API accept
//     a browser-looking client?";
// (b) a same-origin fetch: open the API host's root and call from inside it. A
//     fetch from www.smiles.com.br does not work: the API is on another
//     subdomain, so the browser enforces CORS and blocks the read even if the
//     response arrives.
async function browserStep(environment: string, mode: "navigate" | "fetch"): Promise<StepResult> {
  const step = `navegador-${mode}/${environment}`;
  const session = await openChromeSession(false, "Smiles");
  try {
    const url = searchUrl(environment);

    if (mode === "navigate") {
      const response = await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const text = await session.page.evaluate(() => document.body.innerText);
      return { step, status: response?.status() ?? "sem resposta", size: text.length, sample: summarize(text), body: text };
    }

    const root = `https://api-air-flightsearch-${environment}.smiles.com.br/`;
    await session.page.goto(root, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await session.page.waitForTimeout(3000);
    const result = await session.page.evaluate(
      async ({ url, headers }) => {
        const response = await fetch(url, { headers });
        return { status: response.status, text: await response.text() };
      },
      { url, headers: APP_HEADERS },
    );
    return { step, status: result.status, size: result.text.length, sample: summarize(result.text), body: result.text };
  } catch (err) {
    return { step, status: "falhou", size: 0, sample: err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err) };
  } finally {
    await session.page.close().catch(() => {});
  }
}

function save(result: StepResult) {
  if (!result.body) return;
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES_DIR, "smiles-real.json"), result.body, "utf8");
  console.log(`\n✅ Resposta crua salva em fixtures/smiles-real.json (${result.body.length} bytes, degrau ${result.step}).`);
}

async function main() {
  console.log(`\nRecon Smiles — ${origin.toUpperCase()} → ${destination.toUpperCase()} em ${date}\n`);

  const results: StepResult[] = [];

  for (const environment of ["prd", "green", "blue"]) {
    const result = await nodeStep(environment);
    results.push(result);
    console.log(`[${result.step}] status ${result.status} · ${result.size} bytes\n    ${result.sample}\n`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  let winner = results.find((result) => result.status === 200 && result.size > 0);

  if (!winner) {
    console.log("Nenhum degrau de rede pura passou — subindo pro navegador.\n");
    for (const mode of ["navigate", "fetch"] as const) {
      const result = await browserStep("prd", mode);
      results.push(result);
      console.log(`[${result.step}] status ${result.status} · ${result.size} bytes\n    ${result.sample}\n`);
      if (result.status === 200 && result.size > 0) {
        winner = result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  console.log("─".repeat(60));
  for (const result of results) console.log(`${result.step.padEnd(20)} ${result.status}`);
  console.log("─".repeat(60));

  if (winner) save(winner);
  else console.log("\n❌ Nenhum degrau devolveu 200 — nada salvo (fixture de erro não serve de schema).");

  process.exit(0);
}

main();
