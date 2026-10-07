import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// Recon of the LATAM login (auth.latamairlines.com, Auth0 Universal Login).
// The bot's pre-fill was written against a guessed form and never matched.
//
// Questions for this phase:
//   1. which screens come after the identifier, and with which fields/buttons?
//   2. does a verification code or a visible captcha show up, and when?
//   3. what does the URL look like once the login is done?
//
// It types LATAM_EMAIL and LATAM_PASSWORD from .env into a THROWAWAY profile,
// so the bot's profile and the running server are not touched. If a screen
// asks for something the script does not know (a code, a captcha), do it by
// hand in the window: the script keeps recording until the login finishes.
//
// Usage: npx tsx scripts/recon-latam-login.ts

const OUT_DIR = path.join(FIXTURES_DIR, "latam-login");
const WAIT_FOR_HUMAN_MS = 5 * 60_000;

const email = process.env.LATAM_EMAIL;
const password = process.env.LATAM_PASSWORD;
if (!email || !password) {
  console.error("Faltam LATAM_EMAIL e/ou LATAM_PASSWORD no .env.");
  process.exit(1);
}

const searchUrl =
  "https://www.latamairlines.com/br/pt/oferta-voos?" +
  new URLSearchParams({
    origin: "GRU",
    destination: "SCL",
    outbound: "2026-11-15T12:00:00.000Z",
    inbound: "2026-11-22T12:00:00.000Z",
    adt: "1",
    chd: "0",
    inf: "0",
    trip: "RT",
    cabin: "Economy",
    redemption: "true",
    sort: "PRICE,asc",
  }).toString();

function scrub(text: string): string {
  return text
    .replaceAll(email!, "<LATAM_EMAIL>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\d{4,}/g, "<number>");
}

const isAuthPage = (page: Page) => page.url().includes("auth.latamairlines.com");

async function describeStep(page: Page) {
  // No named helpers inside evaluate: tsx wraps them in `__name(...)`, which
  // does not exist in the page ("ReferenceError: __name is not defined").
  const description = await page.evaluate(() => ({
    title: document.title,
    inputs: [...document.querySelectorAll("input")]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) =>
        Object.fromEntries(
          ["type", "name", "id", "autocomplete", "inputmode", "maxlength", "data-testid"]
            .map((name) => [name, el.getAttribute(name)])
            .filter((entry) => entry[1] != null),
        ),
      ),
    buttons: [...document.querySelectorAll<HTMLElement>("button, input[type=submit]")]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({
        text: (el.innerText || (el as HTMLInputElement).value || "").trim().slice(0, 60),
        ...Object.fromEntries(
          ["type", "id", "name", "value", "data-testid"]
            .map((name) => [name, el.getAttribute(name)])
            .filter((entry) => entry[1] != null),
        ),
      })),
    visibleIframes: [...document.querySelectorAll("iframe")]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => el.src.split("?")[0]),
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 600),
  }));
  const url = new URL(page.url());
  return { host: url.host, path: url.pathname, ...description, text: scrub(description.text) };
}

const steps: unknown[] = [];
const authRequests: string[] = [];

async function record(page: Page, label: string) {
  const step = { label, at: new Date().toISOString(), ...(await describeStep(page)) };
  steps.push(step);
  await page.screenshot({ path: path.join(OUT_DIR, `${String(steps.length).padStart(2, "0")}-${label}.png`) });
  console.log(`\n[${label}] ${step.host}${step.path}`);
  console.log(JSON.stringify(step, null, 2));
}

async function clickContinue(page: Page) {
  await page.locator('button[type="submit"]:visible').first().click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(5000);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "latam-login-recon-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled"],
  viewport: null,
});
const page = await context.newPage();

// Status only: the bodies carry the credentials.
page.on("response", (response) => {
  const request = response.request();
  if (!response.url().includes("auth.latamairlines.com") || request.method() === "GET") return;
  authRequests.push(`${request.method()} ${new URL(response.url()).pathname} -> ${response.status()}`);
});

try {
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForURL(/auth\.latamairlines\.com/, { timeout: 30_000 });
  await page.waitForTimeout(4000);
  await record(page, "identifier");

  await page.locator('input[name="alias"]').fill(email);
  await clickContinue(page);
  await record(page, "after-identifier");

  const passwordField = page.locator('input[type="password"]:visible').first();
  if (await passwordField.isVisible().catch(() => false)) {
    await passwordField.fill(password);
    await clickContinue(page);
    await record(page, "after-password");
  } else {
    console.log("\nNenhum campo de senha visível depois do usuário. Continue à mão na janela, se der.");
  }

  const deadline = Date.now() + WAIT_FOR_HUMAN_MS;
  let lastPath = new URL(page.url()).pathname;
  if (isAuthPage(page)) console.log(`\nAinda no login. Se pedir código ou captcha, resolva na janela (até 5 min).`);
  while (isAuthPage(page) && Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const currentPath = new URL(page.url()).pathname;
    if (currentPath !== lastPath && isAuthPage(page)) {
      lastPath = currentPath;
      await page.waitForTimeout(3000);
      await record(page, "auth-step");
    }
  }
  await page.waitForTimeout(5000);
  await record(page, isAuthPage(page) ? "timed-out" : "logged-in");
} catch (err) {
  console.error("\nFalhou:", err instanceof Error ? err.message.split("\n")[0] : err);
  await record(page, "error").catch(() => {});
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "steps.json"), JSON.stringify({ steps, authRequests }, null, 2));
  console.log("\nRequisições ao auth:", authRequests);
  console.log(`\nGravado em ${OUT_DIR}`);
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
