import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR, ROOT_DIR } from "../src/core/paths.ts";
import { isAskingForLogin, waitForManualLogin } from "../src/scrapers/latam/latam.scraper.ts";

// Finds out WHERE LATAM's round-trip price comes from.
//
// The bot used to confirm leg by leg (`trip=OW`) and add them up: 243.535 miles
// for a pair that, bought together on the site, costs 90.302 + R$ 255,69. Not a
// different fare but a different question: LATAM prices the pair together.
//
// That number is NOT in the response the bot already reads
// (`/offers/search/redemption`). The "Combine suas milhas + dinheiro" screen,
// with the four miles+cash combinations, only shows AFTER picking an outbound
// and a return flight. So this recon drives the flow and records everything on
// the network, to learn which response carries those four rows, and whether as
// JSON or only in the HTML.
//
// Nothing is parsed here on purpose: fixture first, parser later.
//
// Usage: npx tsx scripts/recon-latam-round-trip.ts GRU JNB 2026-10-31 2026-11-06

const [origin = "GRU", destination = "JNB", outboundDate = daysFromToday(60), returnDate = daysFromToday(67)] =
  process.argv.slice(2);
// Kept out of git (.gitignore): captures come from a logged-in session and can show name, account and balance.
const OUTPUT_DIR = path.join(FIXTURES_DIR, "latam-rt");

function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function roundTripUrl(): string {
  return (
    "https://www.latamairlines.com/br/pt/oferta-voos?" +
    new URLSearchParams({
      origin,
      destination,
      outbound: `${outboundDate}T12:00:00.000Z`,
      inbound: `${returnDate}T12:00:00.000Z`,
      adt: "1",
      chd: "0",
      inf: "0",
      trip: "RT",
      cabin: "Economy",
      redemption: "true",
      sort: "RECOMMENDED",
    }).toString()
  );
}

type RecordedResponse = { step: string; method: string; url: string; status: number; size: number; body: string | null };

const recorded: RecordedResponse[] = [];
let currentStep = "0-abertura";

const isRelevant = (url: string) =>
  /latamairlines\.com/.test(url) && !/\.(js|css|png|jpg|jpeg|svg|woff2?|gif|ico)(\?|$)/.test(url);

async function main() {
  console.log(`\nRecon LATAM ida e volta — ${origin} ⇄ ${destination} · ${outboundDate} → ${returnDate}\n`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const session = await openChromeSession(false, "recon-latam-rt");
  const page = session.page;

  page.on("response", async (response) => {
    if (!isRelevant(response.url())) return;
    const contentType = response.headers()["content-type"] ?? "";
    let body: string | null = null;
    if (contentType.includes("json")) body = await response.text().catch(() => null);
    recorded.push({
      step: currentStep,
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
      size: body?.length ?? 0,
      body,
    });
  });

  currentStep = "1-resultado-ida";
  console.log("1. Abrindo o deep link de ida e volta...");
  await page.goto(roundTripUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });

  if (isAskingForLogin(page)) {
    await waitForManualLogin(page, (message) => console.log(`   ${message}`), () => {});
    await page.goto(roundTripUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (isAskingForLogin(page)) {
      console.log("❌ Continuou na tela de login. Faça o login na janela do bot e rode de novo.");
      await finish(page);
      return;
    }
  }

  await waitForFlightCards(page, "ida");
  await capture(page, "1-resultado-ida");

  currentStep = "2-escolha-ida";
  console.log("2. Escolhendo o primeiro voo da ida...");
  if (!(await pickFirstFlight(page))) {
    console.log("❌ Não consegui escolher a ida — veja as fotos em fixtures/latam-rt/.");
    await saveRecorded();
    await finish(page);
    return;
  }
  await page.waitForTimeout(4000);
  await capture(page, "2-depois-da-ida");

  currentStep = "3-escolha-volta";
  console.log("3. Escolhendo o primeiro voo da volta...");
  await waitForFlightCards(page, "volta").catch(() => {});
  if (!(await pickFirstFlight(page))) {
    console.log("⚠️  Não consegui escolher a volta — veja as fotos.");
  }
  await page.waitForTimeout(6000);

  currentStep = "4-combinacoes";
  console.log("4. Onde parou:");
  console.log(`   URL: ${page.url()}`);
  const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
  const foundCombinations = /Combine suas milhas|Selecione a op/i.test(text);
  console.log(`   Tela de combinações: ${foundCombinations ? "SIM" : "não encontrada"}`);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /milhas.*(BRL|R\$)/i.test(line));
  console.log(`   Linhas com "milhas + dinheiro" no texto da página: ${lines.length}`);
  for (const line of lines.slice(0, 8)) console.log(`     ${line}`);
  await capture(page, "4-combinacoes");

  await saveRecorded();
  await finish(page);
}

async function waitForFlightCards(page: Page, leg: string) {
  await page
    .locator('[data-testid^="wrapper-card-flight-"]')
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => console.log(`   (nenhum cartão de voo apareceu na ${leg})`));
  await page.waitForTimeout(2500);
}

// LATAM asks for two picks per leg: the flight and, in a panel that opens next,
// the fare (Light/Plus/Top). This always takes the first of both: the goal is
// reaching the final screen, not choosing well.
async function pickFirstFlight(page: Page): Promise<boolean> {
  const card = page.locator('[data-testid^="wrapper-card-flight-"]').first();
  if ((await card.count()) === 0) return false;
  await card.click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // The fare button's testids vary, so text selectors are tried too.
  const selectors = [
    '[data-testid*="fare-selection"] button',
    'button[data-testid*="select"]',
    "button:has-text('Escolher')",
    "button:has-text('Selecionar')",
    "button:has-text('Continuar')",
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }
  // Without a fare panel the card click may have been enough.
  return true;
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`), fullPage: true }).catch(() => {});
  console.log(`   foto: fixtures/latam-rt/${name}.png`);
}

// Each JSON response becomes a file, with a text index on top. Nothing is
// interpreted on purpose: the parser comes later, looking at this.
async function saveRecorded() {
  const index: string[] = [];
  recorded.forEach((response, i) => {
    const number = String(i).padStart(3, "0");
    index.push(`${number} | ${response.step} | ${response.method} ${response.status} | ${response.size} bytes | ${response.url}`);
    if (response.body && response.body.length > 200) {
      fs.writeFileSync(path.join(OUTPUT_DIR, `${number}-${response.step}.json`), response.body, "utf8");
    }
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, "index.txt"), index.join("\n"), "utf8");

  console.log(`\n✅ ${recorded.length} respostas registradas em fixtures/latam-rt/`);
  const largest = recorded.filter((response) => response.size > 5000).sort((a, b) => b.size - a.size);
  console.log("\nAs maiores respostas JSON (candidatas a carregar o preço do par):");
  for (const response of largest.slice(0, 8)) {
    console.log(`  ${response.size.toString().padStart(8)} bytes | ${response.step} | ${response.url.slice(0, 110)}`);
  }
  console.log(`\n(fixtures em ${path.relative(ROOT_DIR, OUTPUT_DIR)})`);
}

async function finish(page: Page) {
  await page.close();
  process.exit(0);
}

main();
