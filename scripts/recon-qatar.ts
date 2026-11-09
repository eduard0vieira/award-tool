// Answers what the Qatar source depends on, in the bot's own Chrome profile:
// 1. does the award calendar open there, and does it need the Privilege Club login?
// 2. can the page's own `award-fare-calendars` headers be replayed from a script, month by month?
// 3. what does the endpoint answer without the Authorization header?
// 4. does the login survive closing and reopening Chrome?
// Usage: npx tsx scripts/recon-qatar.ts GRU NRT [months] [outDir] (default outDir: the system temp dir)
// Tokens are never printed or saved: only header names and the bodies the endpoint returns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page, Request, Response } from "playwright";
import { closeChromeSession, openChromeSession } from "../src/core/chrome-session.ts";

const [origin = "GRU", destination = "NRT", monthsArg = "3", outDir = os.tmpdir()] = process.argv.slice(2);
const MONTHS = Number(monthsArg);
const INTERVAL_MS = 6000;
const LOGIN_WAIT_MINUTES = Number(process.env.LOGIN_WAIT_MINUTES) || 10;
const CALENDAR_PATH = "/dapi/public/bff/web/flight-search/award-fare-calendars";
const runDir = path.join(outDir, `qatar-${origin}-${destination}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 60000).toFixed(1)} min] ${message}`);

fs.mkdirSync(runDir, { recursive: true });

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function calendarUrl(departing: string) {
  const query = new URLSearchParams({
    widget: "QR",
    searchType: "F",
    addTaxToFare: "Y",
    minPurTime: "0",
    selLang: "en",
    tripType: "O",
    fromStation: origin,
    toStation: destination,
    departing,
    bookingClass: "E",
    adults: "1",
    children: "0",
    infants: "0",
    ofw: "0",
    teenager: "0",
    flexibleDate: "off",
    qmilesFlow: "true",
    allowRedemption: "Y",
  });
  return `https://www.qatarairways.com/app/booking/award-calendar?${query}`;
}

type Captured = { headers: Record<string, string>; body: string };

const LOGIN_PAGE = "https://www.qatarairways.com/en/Privilege-Club/loginpage.html";

// The deep link bounces to the home page when the session is not logged in.
// Then the script opens the login page for the person (the e-mail code is
// theirs to type) and reopens the calendar once the tab leaves it.
async function openCalendar(page: Page, departing: string, allowLogin: boolean): Promise<Captured | null> {
  let captured: Captured | null = null;
  const onRequest = async (request: Request) => {
    if (!request.url().includes(CALENDAR_PATH) || request.method() !== "POST") return;
    captured = { headers: await request.allHeaders(), body: request.postData() ?? "" };
  };
  const onResponse = async (response: Response) => {
    if (!response.url().includes(CALENDAR_PATH)) return;
    const text = await response.text().catch((err) => `<unreadable: ${err}>`);
    log(`page's own call: HTTP ${response.status()}, ${text.length} bytes`);
    fs.writeFileSync(path.join(runDir, `own-call-${Date.now()}.json`), text);
  };
  page.context().on("request", onRequest);
  page.context().on("response", onResponse);

  const goToCalendar = async () => {
    await page.goto(calendarUrl(departing), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(15000);
    log(`calendar deep link landed on ${new URL(page.url()).pathname}`);
  };

  try {
    await goToCalendar();
    if (captured || !allowLogin) return captured;

    const deadline = Date.now() + LOGIN_WAIT_MINUTES * 60000;
    await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
    log(`not logged in: log in in the bot's Chrome window, with the e-mail code. Waiting up to ${LOGIN_WAIT_MINUTES} min.`);
    while (!captured && Date.now() < deadline) {
      await page.waitForTimeout(3000);
      if (/loginpage|login\.|signin|auth/i.test(page.url())) continue;
      log(`the tab left the login page (${new URL(page.url()).pathname}); reopening the calendar`);
      await goToCalendar();
      if (!captured) {
        await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
        log("the calendar still bounced: back to the login page");
      }
    }
    return captured;
  } finally {
    page.context().off("request", onRequest);
    page.context().off("response", onResponse);
  }
}

async function replay(page: Page, headers: Record<string, string>, body: unknown) {
  return page.evaluate(
    async ({ url, headers, body }) => {
      try {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), credentials: "include" });
        return { status: response.status, text: await response.text() };
      } catch (err) {
        return { status: -1, text: String(err) };
      }
    },
    { url: `https://www.qatarairways.com${CALENDAR_PATH}`, headers, body },
  );
}

function replayHeaders(captured: Record<string, string>, withAuthorization = true) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(captured)) {
    // Headers the browser sets itself (cookie, origin, sec-*) are refused by fetch anyway.
    if (/^(cookie|host|origin|referer|content-length|traceparent|user-agent)$|^sec-|^:/i.test(name)) continue;
    if (!withAuthorization && /^authorization$/i.test(name)) continue;
    headers[name] = value;
  }
  for (const name of Object.keys(headers)) if (/^request-id$/i.test(name)) headers[name] = crypto.randomUUID();
  return headers;
}

function summarize(text: string) {
  try {
    const parsed = JSON.parse(text) as { faresFromCalendar?: { date: string; lowestPrice?: number; currencyCode?: string; cabinClass?: string }[] };
    const days = parsed.faresFromCalendar ?? [];
    const priced = days.filter((day) => day.lowestPrice !== undefined);
    return {
      topKeys: Object.keys(parsed),
      days: days.length,
      range: days.length ? `${days[0]!.date}..${days.at(-1)!.date}` : null,
      priced: priced.length,
      values: [...new Set(priced.map((day) => day.lowestPrice))].sort(),
      currencies: [...new Set(priced.map((day) => day.currencyCode))],
      cabins: [...new Set(priced.map((day) => day.cabinClass))],
    };
  } catch {
    return { notJson: text.slice(0, 200) };
  }
}

async function pass(label: string, allowLogin: boolean) {
  log(`=== ${label}`);
  const session = await openChromeSession(false, "Qatar");
  const { page } = session;
  const tomorrow = isoDate(new Date(Date.now() + 86400000));
  const captured = await openCalendar(page, tomorrow, allowLogin);
  if (!captured) {
    await closeChromeSession(session);
    return { label, captured: false };
  }
  const authorization = Object.entries(captured.headers).find(([name]) => /^authorization$/i.test(name))?.[1] ?? "";
  log(`captured header names: ${Object.keys(captured.headers).join(", ")}`);
  log(`authorization: ${authorization.split(" ")[0] ?? ""} + ${Math.max(0, authorization.length - 7)} chars; page body: ${captured.body}`);

  const results: unknown[] = [];
  const pageBody = JSON.parse(captured.body) as { itineraries: { departureDate: string }[] };
  for (let month = 0; month < MONTHS; month++) {
    await page.waitForTimeout(INTERVAL_MS);
    const center = new Date();
    center.setUTCMonth(center.getUTCMonth() + month + 1, 16);
    const body = { ...pageBody, itineraries: [{ ...pageBody.itineraries[0], departureDate: isoDate(center) }] };
    const answer = await replay(page, replayHeaders(captured.headers), body);
    fs.writeFileSync(path.join(runDir, `${label}-${isoDate(center)}.json`), answer.text);
    const summary = { center: isoDate(center), status: answer.status, ...summarize(answer.text) };
    log(JSON.stringify(summary));
    results.push(summary);
  }

  await page.waitForTimeout(INTERVAL_MS);
  const anonymous = await replay(page, replayHeaders(captured.headers, false), pageBody);
  fs.writeFileSync(path.join(runDir, `${label}-without-authorization.json`), anonymous.text);
  const anonymousSummary = { status: anonymous.status, ...summarize(anonymous.text) };
  log(`without Authorization: ${JSON.stringify(anonymousSummary)}`);

  await closeChromeSession(session);
  return { label, captured: true, results, anonymous: anonymousSummary };
}

const first = await pass("first", true);
// Closing the whole context is what a server restart does; the next pass shows whether the login survives it.
const { context } = await openChromeSession(false, "Qatar");
await context.close();
log("Chrome closed; reopening to see whether the login survives");
const second = await pass("after-restart", false);

fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ origin, destination, first, second }, null, 2));
log(`saved in ${runDir}`);
process.exit(0);
