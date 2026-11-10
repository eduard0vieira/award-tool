import "dotenv/config";
import type { Page, Request } from "playwright";
import { openChromeSession, type ChromeSession } from "../../core/chrome-session.ts";
import { RateLimiter, type OnLog, type OnNotice, type OnProgress, type ShouldStop } from "../../core/common.ts";
import { qatarCalendarLink, readCalendar, type QatarDay, type QatarRoute } from "./qatar-calendar.ts";

// Qatar Privilege Club award calendar (docs/recon/qatar.md): the calendar page
// makes one POST per month with the logged-in member's bearer; the bot follows
// the page's own call and replays its headers from inside the page, one month
// at a time. Without the login the deep link bounces to the home page, and the
// login asks for a code sent by e-mail, so only the person can do it.

export type QatarSession = ChromeSession;

const CALENDAR_PATH = "/dapi/public/bff/web/flight-search/award-fare-calendars";
const LOGIN_PAGE = "https://www.qatarairways.com/en/Privilege-Club/loginpage.html";

const QATAR_MIN_INTERVAL_MS = Number(process.env.QATAR_SEARCH_INTERVAL_MS) || 6000;
const qatarRateLimiter = new RateLimiter(QATAR_MIN_INTERVAL_MS);
const LOGIN_WAIT_MINUTES = Number(process.env.QATAR_LOGIN_WAIT_MINUTES) || 10;
const OWN_CALL_WAIT_MS = 25_000;
const LOGIN_FIELD_TIMEOUT_MS = 15_000;
// Qatar sells about 361 days ahead: this month plus the next twelve.
const MONTHS_TO_SWEEP = 13;
const MAX_CONSECUTIVE_FAILED_MONTHS = 3;

type CalendarCall = { headers: Record<string, string>; body: Record<string, unknown> };

export type FailedMonth = { month: string; error: string };
export type QatarYearResult = { days: QatarDay[]; failedMonths: FailedMonth[] };

export class QatarLoginError extends Error {}

class SessionExpiredError extends Error {}

export async function startQatarSession(headless = false): Promise<QatarSession> {
  return openChromeSession(headless, "Qatar");
}

function isOnLoginPage(page: Page) {
  return /loginpage|login\.|signin/i.test(page.url());
}

// Resolves with the page's own calendar call, or null when none came in time.
async function loadCalendar(page: Page, route: QatarRoute, date: string): Promise<CalendarCall | null> {
  let captured: CalendarCall | null = null;
  const onRequest = async (request: Request) => {
    if (!request.url().includes(CALENDAR_PATH) || request.method() !== "POST") return;
    const body = JSON.parse(request.postData() ?? "null") as Record<string, unknown> | null;
    if (!body) return;
    captured = { headers: await request.allHeaders(), body };
  };
  page.context().on("request", onRequest);
  try {
    await page.goto(qatarCalendarLink(route, date), { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let waited = 0; !captured && waited < OWN_CALL_WAIT_MS; waited += 1000) await page.waitForTimeout(1000);
    return captured;
  } finally {
    page.context().off("request", onRequest);
  }
}

// With QATAR_EMAIL and QATAR_PASSWORD in .env the bot fills the login form
// (fields read from the real page on 2026-11-10); the e-mail code, and any
// captcha, stay with the person. A form that changed is not an error: the
// person logs in by hand. No password ever shows up in a log.
async function fillQatarLogin(page: Page, onLog: OnLog): Promise<boolean> {
  const email = process.env.QATAR_EMAIL;
  const password = process.env.QATAR_PASSWORD;
  if (!email || !password) {
    onLog("Sem QATAR_EMAIL/QATAR_PASSWORD no .env: o login da Qatar é todo manual.");
    return false;
  }
  try {
    const form = page.locator("#j-login-form");
    await form.locator('input[type="text"]').first().fill(email, { timeout: LOGIN_FIELD_TIMEOUT_MS });
    await form.locator('input[type="password"]').first().fill(password, { timeout: LOGIN_FIELD_TIMEOUT_MS });
    await page.locator("#loginButtonInvoke").click({ timeout: LOGIN_FIELD_TIMEOUT_MS });
    onLog("Login da Qatar: e-mail e senha enviados.");
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    onLog(`Login da Qatar: o formulário não foi preenchido (${reason}). O login fica manual.`);
    return false;
  }
}

// Not logged in, the deep link lands on the home page. The login page is
// opened for the person, and the calendar is reopened once the tab leaves it.
async function openCalendar(page: Page, route: QatarRoute, date: string, onLog: OnLog, onNotice: OnNotice): Promise<CalendarCall> {
  onLog(`Abrindo o calendário da Qatar ${route.origin} → ${route.destination}...`);
  const first = await loadCalendar(page, route, date);
  if (first) return first;
  if (/award-calendar/.test(new URL(page.url()).pathname)) {
    throw new Error("O calendário da Qatar abriu, mas não fez a chamada de preços. A página pode ter mudado.");
  }

  await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.bringToFront();
  const filled = await fillQatarLogin(page, onLog);
  const message =
    (filled
      ? "A sessão da Qatar caiu. O bot já colocou o e-mail e a senha: digite na janela do Chrome do bot o código que chegou no e-mail."
      : "A sessão da Qatar caiu. Faça o login no Privilege Club na janela do Chrome do bot, com o código que chega no e-mail.") +
    ` A busca espera até ${LOGIN_WAIT_MINUTES} min e continua sozinha.`;
  onNotice(message);
  onLog(message);

  for (let waited = 0; waited < LOGIN_WAIT_MINUTES * 60_000; waited += 3000) {
    await page.waitForTimeout(3000);
    if (isOnLoginPage(page)) continue;
    const call = await loadCalendar(page, route, date);
    if (call) {
      onLog("Login na Qatar feito; seguindo com a busca.");
      return call;
    }
    await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  throw new QatarLoginError(`Ninguém fez o login na Qatar em ${LOGIN_WAIT_MINUTES} min. A busca não foi feita.`);
}

// Headers the browser sets on its own are refused by fetch; the request id is per call.
function replayHeaders(captured: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(captured)) {
    if (/^(cookie|host|origin|referer|content-length|traceparent|user-agent|accept-encoding|priority)$|^sec-|^:/i.test(name)) continue;
    headers[name] = /^request-id$/i.test(name) ? crypto.randomUUID() : value;
  }
  return headers;
}

async function fetchMonth(page: Page, call: CalendarCall, route: QatarRoute, month: string): Promise<QatarDay[]> {
  const itinerary = { origin: route.origin, destination: route.destination, departureDate: `${month}-16`, isRequested: true };
  const body = { ...call.body, cabinClass: "ECONOMY", itineraries: [itinerary] };
  const answer = await page.evaluate(
    async ({ url, headers, body }) => {
      try {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), credentials: "include" });
        return { status: response.status, text: await response.text() };
      } catch (err) {
        return { status: -1, text: String(err) };
      }
    },
    { url: `https://www.qatarairways.com${CALENDAR_PATH}`, headers: replayHeaders(call.headers), body },
  );

  if (answer.status === 401) throw new SessionExpiredError("A Qatar recusou o token da sessão (401).");
  if (answer.status !== 200) {
    throw new Error(`O calendário da Qatar respondeu HTTP ${answer.status}: ${answer.text.slice(0, 160)}`);
  }
  // With ±15 days around the 16th the answer also brings the first days of the next month.
  return readCalendar(answer.text, "ECONOMY").filter((day) => day.date.startsWith(month));
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthsAhead(today: Date): string[] {
  return Array.from({ length: MONTHS_TO_SWEEP }, (_, offset) => isoDate(new Date(today.getFullYear(), today.getMonth() + offset, 1)).slice(0, 7));
}

export async function searchQatarYear(
  page: Page,
  route: QatarRoute,
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  onNotice: OnNotice = () => {},
  shouldStop: ShouldStop = () => false,
): Promise<QatarYearResult> {
  const today = new Date();
  const tomorrow = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const months = monthsAhead(today);

  await qatarRateLimiter.waitTurn();
  let call = await openCalendar(page, route, tomorrow, onLog, onNotice);
  onProgress(0.05);

  const days: QatarDay[] = [];
  const failedMonths: FailedMonth[] = [];
  let consecutiveFailures = 0;

  for (const [index, month] of months.entries()) {
    if (shouldStop()) {
      for (const skipped of months.slice(index)) failedMonths.push({ month: skipped, error: "busca cancelada pela tela" });
      break;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_MONTHS) {
      const reason = `parou depois de ${MAX_CONSECUTIVE_FAILED_MONTHS} meses seguidos com erro`;
      for (const skipped of months.slice(index)) failedMonths.push({ month: skipped, error: reason });
      break;
    }

    await qatarRateLimiter.waitTurn();
    try {
      let monthDays: QatarDay[];
      try {
        monthDays = await fetchMonth(page, call, route, month);
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) throw err;
        onLog(`${month}: ${err.message} Reabrindo o calendário para renovar a sessão.`);
        call = await openCalendar(page, route, tomorrow, onLog, onNotice);
        await qatarRateLimiter.waitTurn();
        monthDays = await fetchMonth(page, call, route, month);
      }
      const upcoming = monthDays.filter((day) => day.date >= tomorrow);
      days.push(...upcoming);
      consecutiveFailures = 0;
      onLog(`${month}: ${upcoming.length} dia(s) com prêmio.`);
    } catch (err) {
      if (err instanceof QatarLoginError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      failedMonths.push({ month, error });
      consecutiveFailures++;
      onLog(`${month}: falhou (${error}).`);
    }
    onProgress(0.05 + 0.95 * ((index + 1) / months.length));
  }

  if (days.length === 0 && failedMonths.length === months.length) {
    throw new Error(`Nenhum mês do calendário da Qatar pôde ser lido. Primeira falha (${failedMonths[0]!.month}): ${failedMonths[0]!.error}`);
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, failedMonths };
}
