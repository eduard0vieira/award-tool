import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  formatDatesByMonth,
  parseValueK,
  RateLimiter,
  type FormattedDay,
  type OnLog,
  type OnNotice,
  type OnProgress,
  type OnWindow,
  type ReportSection,
  type ShouldStop,
} from "../../core/common.ts";

export type AvailabilityDay = {
  date: string;
  found: number;
  total: number;
  economy: string;
  premiumEconomy: string;
  business: string;
  first: string;
};

export type TapReport = {
  executivas: ReportSection;
  economicas: ReportSection;
};

const TAP_MIN_INTERVAL_MS = Number(process.env.AWARDTOOL_INTERVALO_BUSCAS_MS) || 15000;
const awardtoolRateLimiter = new RateLimiter(TAP_MIN_INTERVAL_MS);

// Each row of the "Date" popover has a "YYYY-MM-DD (found/total)" paragraph
// followed by 4 prices, one per cabin, told apart by the color of the dot next
// to them (not by position or text, which vary): light green = Economy, dark
// green = Premium Economy, blue = Business, purple = First.
async function extractDays(popover: ReturnType<Page["locator"]>): Promise<AvailabilityDay[]> {
  return popover.evaluate((root) => {
    const COLORS: Record<string, "economy" | "premiumEconomy" | "business" | "first"> = {
      "76,175,80": "economy",
      "46,125,50": "premiumEconomy",
      "0,145,234": "business",
      "103,58,183": "first",
    };

    const rows: AvailabilityDay[] = [];
    root.querySelectorAll("p").forEach((paragraph) => {
      const text = (paragraph.textContent || "").trim();
      const match = text.match(/^(\d{4}-\d{2}-\d{2})\s*\((\d+)\/(\d+)\)$/);
      if (!match) return;

      const priceContainer = paragraph.nextElementSibling;
      if (!priceContainer) return;

      const values: Record<string, string> = { economy: "-", premiumEconomy: "-", business: "-", first: "-" };

      priceContainer.querySelectorAll(".w-\\[52px\\]").forEach((cell) => {
        const dot = cell.querySelector("span[style*='background-color']") as HTMLElement | null;
        const colorMatch = (dot?.getAttribute("style") || "").match(/rgb\(([\d,\s]+)\)/);
        if (!colorMatch || !colorMatch[1]) return;
        const key = COLORS[colorMatch[1].replace(/\s+/g, "")];
        if (key) values[key] = (cell.textContent || "").trim();
      });

      rows.push({
        date: match[1]!,
        found: parseInt(match[2]!, 10),
        total: parseInt(match[3]!, 10),
        economy: values.economy!,
        premiumEconomy: values.premiumEconomy!,
        business: values.business!,
        first: values.first!,
      });
    });
    return rows;
  });
}

type WindowSearch = {
  baseUrl: string;
  origin: string;
  destination: string;
  cabinParam: string;
  start: Date;
  end: Date;
};

// Searches a window of up to 36 days by navigating straight to the results URL
// instead of driving the form's origin, destination and date widgets.
async function searchWindow(
  page: Page,
  search: WindowSearch,
  onLog: OnLog,
  onProgress: OnProgress,
  // This window's slice of the overall progress (0..1), set at its start and end.
  progressBase: number,
  progressStep: number,
  onNotice: OnNotice = () => {},
): Promise<AvailabilityDay[]> {
  const { baseUrl, origin, destination, cabinParam, start, end } = search;

  // Spaces this search's start from any other AwardTool search running in
  // parallel (other pool sessions): that is what avoids the "searching too
  // frequently" block.
  await awardtoolRateLimiter.waitTurn();

  const params = new URLSearchParams({
    flightWay: "oneway",
    pax: "1",
    children: "0",
    cabins: cabinParam,
    range: "true",
    rangeV2: "false",
    from: origin.toUpperCase(),
    to: destination.toUpperCase(),
    programs: "TP",
    targetId: "",
    oneWayRangeStartDate: String(Math.floor(start.getTime() / 1000)),
    oneWayRangeEndDate: String(Math.floor(end.getTime() / 1000)),
  });

  const resultsUrl = `${baseUrl}/flight?${params.toString()}`;

  onLog(`Buscando de ${start.toLocaleDateString()} a ${end.toLocaleDateString()}...`);
  onProgress(progressBase);

  // Known AwardTool bug: on each session's first search (fresh login) it
  // sometimes does not recognize the account's Pro plan yet and rejects the
  // window with a "Search range is too broad" modal, even at the usual size.
  // Closing the modal and repeating the same search fixes it.
  const MAX_MODAL_RETRIES = 3;
  // The "searching too frequently" block clears after a wait, but the cooldown
  // must be much longer than the modal's: insisting fast only prolongs it.
  const MAX_RATE_LIMIT_RETRIES = 3;
  for (let attempt = 1, rateLimitAttempt = 1; ; attempt++) {
    if (attempt > 1) await awardtoolRateLimiter.waitTurn();
    await page.goto(resultsUrl);
    await page.waitForLoadState("domcontentloaded");

    const rateLimited = await page
      .getByText(/too (many|frequent(ly)?) (requests|searches)|rate.?limit|search(ing)? too (often|frequently)|please (wait|try again)/i)
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (rateLimited) {
      if (rateLimitAttempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `O AwardTool bloqueou essa busca por excesso de frequência e continuou bloqueando mesmo depois de ${MAX_RATE_LIMIT_RETRIES} tentativas espaçadas. Tente de novo mais tarde.`,
        );
      }
      const waitMs = 2 * 60 * 1000 * rateLimitAttempt; // 2 min, 4 min, 6 min...
      const message = `AwardTool bloqueou por buscas muito frequentes. Esperando ${Math.round(waitMs / 60000)} min antes de tentar de novo [${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES}]...`;
      onLog(`  (${message})`);
      onNotice(message);
      await page.waitForTimeout(waitMs);
      rateLimitAttempt++;
      continue;
    }

    const rangeModal = await page
      .getByText(/search range is too broad/i)
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!rangeModal) break;

    if (attempt >= MAX_MODAL_RETRIES) {
      throw new Error(
        `O AwardTool continua recusando essa janela como "muito ampla" mesmo depois de ${MAX_MODAL_RETRIES} tentativas. Pode não ser mais o bug de reconhecimento do plano na primeira busca.`,
      );
    }
    onLog(
      `  (AwardTool não reconheceu o plano Pro nessa tentativa. Fechando aviso e buscando de novo [${attempt}/${MAX_MODAL_RETRIES}]...)`,
    );
    const okButton = page.getByRole("button", { name: /got it/i }).first();
    if (await okButton.isVisible().catch(() => false)) {
      await okButton.click();
    }
    await page.waitForTimeout(1500);
  }
  onNotice("");

  // Per-day prices are only right once the flights long polling truly ends,
  // which takes at least ~35s, and the "loading" banner sometimes disappears
  // before the table finishes filling. So wait for both, whichever takes longer.
  const MIN_WAIT_MS = 35000;
  const waitStart = Date.now();
  try {
    await page
      .getByText(/Retrieving real-time award flight availability|taxiing to the gate/i)
      .first()
      .waitFor({ state: "hidden", timeout: 60000 });
  } catch {
    // Carry on: the minimum wait below is still the safety net.
  }
  const remaining = MIN_WAIT_MS - (Date.now() - waitStart);
  if (remaining > 0) await page.waitForTimeout(remaining);

  const dateButton = page.getByRole("button", { name: "Date", exact: false }).first();
  await dateButton.waitFor({ state: "visible", timeout: 20000 });
  await dateButton.click();
  await page.waitForTimeout(1000);

  const popover = page.locator(".MuiPopover-paper, .MuiPaper-root, [role='dialog']").filter({ visible: true }).last();

  // The popover sometimes opens just before each day's prices fill in. Days with
  // flights found (found > 0) but ALL prices empty mean that race, so retry
  // instead of reporting a wrong "no availability".
  let days = await extractDays(popover);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const flightsWithoutPrice = days.some((day) => day.found > 0 && day.economy === "-" && day.business === "-");
    if (!flightsWithoutPrice) break;
    onLog(`  (preços ainda não carregaram, tentando de novo [${attempt}]...)`);
    await page.waitForTimeout(1500 * attempt);
    days = await extractDays(popover);
  }

  onLog(`Foram encontradas ${days.length} datas nessa janela.`);
  onProgress(progressBase + progressStep);
  return days;
}

// Default ceilings from TAP's miles table: business at the standard fare OR
// better (181K or less) and economy at the standard fare OR better (53K or
// less). Pricier values are some flex or promo fare outside the table; other
// ceilings can be asked per search.
export const DEFAULT_BUSINESS_CEILING_K = 181;
export const DEFAULT_ECONOMY_CEILING_K = 53;

// Ceiling in K per cabin; absent or null means the default above.
export type TapCeilings = {
  businessK?: number | null;
  economyK?: number | null;
};

function buildSection(
  days: AvailabilityDay[],
  field: "economy" | "business",
  accepts: (valueK: number) => boolean,
): ReportSection {
  const available = days.filter((day) => {
    const value = parseValueK(day[field]);
    return value !== null && accepts(value);
  });

  if (available.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const formattedDays: FormattedDay[] = available
    .map((day) => ({ data: day.date, valorK: parseValueK(day[field])! }))
    .sort((a, b) => a.data.localeCompare(b.data));
  const values = formattedDays.map((day) => day.valorK);

  return {
    menor: Math.min(...values),
    maior: Math.max(...values),
    dias: formattedDays,
    texto: formatDatesByMonth(formattedDays.map((day) => day.data)),
  };
}

export function buildTapReport(days: AvailabilityDay[], ceilings: TapCeilings = {}): TapReport {
  const businessCeiling = ceilings.businessK ?? DEFAULT_BUSINESS_CEILING_K;
  const economyCeiling = ceilings.economyK ?? DEFAULT_ECONOMY_CEILING_K;
  return {
    executivas: buildSection(days, "business", (value) => value <= businessCeiling),
    economicas: buildSection(days, "economy", (value) => value <= economyCeiling),
  };
}

const WINDOW_DAYS = 36;
// A window that fails even after the inner retries (persistent rate limit,
// network drop...) is skipped instead of throwing away everything captured,
// but too many failures in a row stop the search: that problem will not fix itself.
const MAX_CONSECUTIVE_FAILED_WINDOWS = 3;

export type FailedWindow = { start: string; end: string; error: string };

// A question asked mid-search; resolves true to continue. The person on screen
// answers because there is no safe default: carrying on alone would spend half
// an hour of browser to return an empty report, and stopping alone would hide a
// route that truly has no availability.
export type OnQuestion = (message: string) => Promise<boolean>;

// Empty windows in a row before suspecting the source. Three is over 100
// calendar days: a route without sales for that long exists, but is rare enough to ask.
const MAX_CONSECUTIVE_EMPTY_WINDOWS = Number(process.env.TAP_JANELAS_VAZIAS) || 3;

// "Empty" is what AwardTool shows when its own feed is down: the date strip
// appears but no day has a flight. Unlike a failed window (error, timeout), this
// one answers fine with nothing inside.
function isEmptyWindow(days: AvailabilityDay[]): boolean {
  return days.length > 0 && days.every((day) => day.found === 0);
}

export type TapYearResult = {
  // True when you stopped it: the result is partial on purpose, and the report
  // must say so instead of passing for a complete search.
  stoppedByUser?: boolean;
  days: AvailabilityDay[];
  failedWindows: FailedWindow[];
};

// Sweeps the route over a rolling year from today (as far as AwardTool's
// calendar lets you navigate), in windows of up to 36 days.
export async function searchTapYear(
  page: Page,
  search: { baseUrl: string; origin: string; destination: string; cabinParam: string },
  onLog: OnLog = () => {},
  onProgress: OnProgress = () => {},
  onWindow: OnWindow = () => {},
  onNotice: OnNotice = () => {},
  onQuestion?: OnQuestion,
  shouldStop: ShouldStop = () => false,
): Promise<TapYearResult> {
  const today = new Date();
  const periodEnd = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());

  const allDays: AvailabilityDay[] = [];
  const failedWindows: FailedWindow[] = [];
  let consecutiveEmpty = 0;
  let stoppedByUser = false;
  let consecutiveFailures = 0;
  let windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let windowNumber = 1;

  let windowCount = 0;
  for (const cursor = new Date(windowStart); cursor <= periodEnd; cursor.setDate(cursor.getDate() + WINDOW_DAYS)) {
    windowCount++;
  }

  while (windowStart <= periodEnd) {
    let windowEnd = new Date(windowStart);
    windowEnd.setDate(windowStart.getDate() + WINDOW_DAYS - 1);
    if (windowEnd > periodEnd) windowEnd = new Date(periodEnd);

    onLog(`Janela ${windowNumber}/${windowCount}:`);
    if (shouldStop()) {
      onLog("Busca cancelada. Devolvendo as janelas já consultadas.");
      stoppedByUser = true;
      break;
    }

    onWindow({
      atual: windowNumber,
      total: windowCount,
      inicio: windowStart.toLocaleDateString("pt-BR"),
      fim: windowEnd.toLocaleDateString("pt-BR"),
    });

    try {
      const windowDays = await searchWindow(
        page,
        { ...search, start: windowStart, end: windowEnd },
        onLog,
        onProgress,
        (windowNumber - 1) / windowCount,
        1 / windowCount,
        onNotice,
      );
      allDays.push(...windowDays);
      consecutiveFailures = 0;

      // AwardTool answers "No results match your current filters" both when the
      // route has no award and when the airline's feed is down. The two look the
      // same from here, so the person decides.
      if (isEmptyWindow(windowDays)) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_WINDOWS && onQuestion) {
          const from = windowStart.toLocaleDateString("pt-BR");
          const until = windowEnd.toLocaleDateString("pt-BR");
          const proceed = await onQuestion(
            `${consecutiveEmpty} janelas seguidas sem nenhum voo (até ${from}–${until}). ` +
              "Isso acontece quando a rota realmente não tem prêmio no período, mas também " +
              "quando a fonte do AwardTool cai, e daqui não dá pra distinguir. Continuar a busca?",
          );
          if (!proceed) {
            onLog("Busca interrompida por você depois das janelas vazias.");
            stoppedByUser = true;
            break;
          }
          // A yes resets the count so it does not ask on every window.
          consecutiveEmpty = 0;
        }
      } else {
        consecutiveEmpty = 0;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      onLog(`  (janela ${windowNumber}/${windowCount} falhou, pulando: ${errorMessage})`);
      failedWindows.push({
        start: windowStart.toLocaleDateString("pt-BR"),
        end: windowEnd.toLocaleDateString("pt-BR"),
        error: errorMessage,
      });
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_WINDOWS) {
        onLog(
          `${MAX_CONSECUTIVE_FAILED_WINDOWS} janelas seguidas falharam. Parando a busca aqui. ` +
            `O que já foi capturado até agora (${allDays.length} data(s)) foi preservado.`,
        );
        break;
      }
    }

    windowStart = new Date(windowEnd);
    windowStart.setDate(windowEnd.getDate() + 1);
    windowNumber++;
  }

  onProgress(1);
  onLog(`Busca do ano completa! Total de ${allDays.length} datas capturadas.`);
  if (failedWindows.length > 0) {
    onLog(`${failedWindows.length} janela(s) falharam e foram puladas.`);
  }
  return { days: allDays, failedWindows, stoppedByUser };
}

export type TapSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  baseUrl: string;
};

// Opens the browser and logs in once. The same `page` is reused across
// searches (outbound and return included) without logging in again.
export async function startTapSession(headless = false): Promise<TapSession> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl = process.env.LOGIN_URL!;

  await page.goto(loginUrl);
  const usernameField = page.locator('input[name="username"]');
  await usernameField.fill(process.env.EMAIL_ACCOUNT!);
  await page.locator('input[name="password"]').fill(process.env.PASSWORD_ACCOUNT!);
  await page.locator('button[type="submit"]').click();
  // "networkidle" never fires here: the site keeps polling after login. The
  // login form leaving the page is a direct signal that the login worked.
  await usernameField.waitFor({ state: "detached" });

  return { browser, context, page, baseUrl: new URL(loginUrl).origin };
}

export function cabinParamOf(cabin: string): string {
  return cabin === "1" ? "Business" : "Economy";
}
