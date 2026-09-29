// Probe 1 showed that the 9th navigation in a row stops firing the search. What
// happens on screen at that moment was still unknown: without it, "blocked" is
// a guess, and guessing is what cost dearly with Smiles.
//
// This one navigates and, when the search does not fire, captures the page's
// state (URL, title, block-page marks) instead of only counting the timeout.
import type { Page } from "playwright";
import { openChromeSession } from "../src/core/chrome-session.ts";

const ORIGIN = "VCP";
const DESTINATION = "REC";
const WAIT_MS = Number(process.env.WAIT_MS ?? 0);
const COUNT = Number(process.env.COUNT ?? 14);

const daysFromToday = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};
const slashed = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}/${year}`;
};

function deepLink(iso: string) {
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

async function snapshot(page: Page): Promise<string> {
  const title = await page.title().catch(() => "(sem título)");
  const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  return `url=${page.url().slice(0, 70)} | título="${title}" | texto="${text}"`;
}

async function main() {
  const session = await openChromeSession(false, "probe-azul-2");
  const page = session.page;
  const start = Date.now();

  const blockedResponses: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("voeazul.com.br") && (response.status() === 403 || response.status() === 429)) {
      blockedResponses.push(`${response.status()} ${url.slice(0, 80)}`);
    }
  });

  for (let i = 0; i < COUNT; i++) {
    blockedResponses.length = 0;
    const seconds = Math.round((Date.now() - start) / 1000);
    const searchStatus = page
      .waitForResponse((response) => /availability\/v\d+\/availability$/.test(response.url()), { timeout: 25_000 })
      .then((response) => response.status())
      .catch(() => null);
    await page.goto(deepLink(daysFromToday(30 + i * 6)), { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    const status = await searchStatus;

    if (status !== null) {
      console.log(`#${String(i + 1).padStart(2)} | ${seconds}s | busca disparou, status ${status}`);
    } else {
      console.log(`#${String(i + 1).padStart(2)} | ${seconds}s | busca NÃO disparou`);
      console.log(`      ${await snapshot(page)}`);
      if (blockedResponses.length) console.log(`      respostas 403/429: ${blockedResponses.slice(0, 3).join(" ; ")}`);
    }
    if (WAIT_MS) await page.waitForTimeout(WAIT_MS);
  }

  await page.close();
  process.exit(0);
}

main();
