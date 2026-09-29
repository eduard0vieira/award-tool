import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// A real browser (with a reputable profile) for the AA, LATAM, Smiles and Iberia bots.
//
// ONE Chrome per process, shared by every search; each search only gets a new
// TAB. The Chrome profile is a directory with an exclusive lock: two
// `launchPersistentContext` calls on the same profile make the second die with
// "Opening in existing browser session", and the pools have several slots each.
//
// We first try to attach to an already open window over CDP, but on this
// machine Playwright's attach hangs even with the port answering: a real window
// piles up targets (ad pixels, recaptcha iframes) and the attach never finishes.
// So the normal path is the bot opening its own window; CDP stays an
// opportunity with a short timeout.

export type BotBrowser = {
  browser: Browser | null; // null for a persistent context, which is the normal case
  context: BrowserContext;
  viaCdp: boolean; // true = a tab in a window that is not ours (never close it)
  closed: boolean;
};

export type ChromeSession = {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  viaCdp: boolean;
  botBrowser: BotBrowser;
};

export const CDP_URL = process.env.AA_CDP_URL || `http://localhost:${process.env.AA_CDP_PORT || 9222}`;
// Outside the repository because it is browser data, not code. One profile
// serves every bot, so the reputation and logins one builds help the others.
export const PROFILE_DIR = process.env.AA_CHROME_PROFILE || path.join(os.homedir(), ".chrome-bot-aa");

let shared: Promise<BotBrowser> | null = null;

export async function openChromeSession(headless: boolean, label: string): Promise<ChromeSession> {
  // Two attempts: if the shared browser died between the await and the use, the
  // second pass opens a new one instead of returning a dead session.
  for (let attempt = 0; attempt < 2; attempt++) {
    const botBrowser = await sharedBrowser(headless, label);
    if (botBrowser.closed) {
      forget(botBrowser);
      continue;
    }
    try {
      return {
        browser: botBrowser.browser,
        context: botBrowser.context,
        page: await botBrowser.context.newPage(),
        viaCdp: botBrowser.viaCdp,
        botBrowser,
      };
    } catch (err) {
      // newPage fails when the browser went down right at this moment.
      forget(botBrowser);
      if (attempt === 1) throw err;
    }
  }
  throw new Error("Falha ao abrir uma aba no navegador do bot.");
}

function sharedBrowser(headless: boolean, label: string): Promise<BotBrowser> {
  if (shared) return shared;

  const opening = openBrowser(headless, label);
  shared = opening;
  // Otherwise a failed opening stays cached and EVERY later search repeats the
  // same error until the server restarts.
  opening.catch(() => {
    if (shared === opening) shared = null;
  });
  return opening;
}

function forget(botBrowser: BotBrowser) {
  botBrowser.closed = true;
  shared = null;
}

async function openBrowser(headless: boolean, label: string): Promise<BotBrowser> {
  return (await attachToBotWindow(label)) ?? (await launchOwnChrome(headless, label));
}

async function attachToBotWindow(label: string): Promise<BotBrowser | null> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 3000 });
    // contexts()[0] is the profile already open in the window, with its cookies;
    // newContext() would create an anonymous one without any of that reputation.
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      return null;
    }
    console.log(`[${label}] usando a janela do bot já aberta (${CDP_URL}).`);
    const botBrowser: BotBrowser = { browser, context, viaCdp: true, closed: false };
    browser.on("disconnected", () => forget(botBrowser));
    return botBrowser;
  } catch {
    // Closed port, or an attach that never finishes (see the top of the file).
    return null;
  }
}

async function launchOwnChrome(headless: boolean, label: string): Promise<BotBrowser> {
  console.log(`[${label}] abrindo a janela do Chrome do bot (perfil ${PROFILE_DIR}).`);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The profile is exclusive: if a Chrome already holds it (that is what
    // `npm run chrome` does), another one can neither open nor take over.
    if (/existing browser session|already in use|ProcessSingleton/i.test(message)) {
      throw new Error(
        "O perfil do bot já está em uso por outra janela do Chrome, e a conexão com ela falhou. " +
          "Feche com `npm run chrome:stop` e busque de novo. O bot abre a janela dele sozinho, " +
          "não é mais preciso rodar `npm run chrome` antes.",
      );
    }
    throw err;
  }

  const botBrowser: BotBrowser = { browser: context.browser(), context, viaCdp: false, closed: false };
  context.on("close", () => forget(botBrowser));
  return botBrowser;
}

export function isSessionAlive(session: ChromeSession): boolean {
  if (session.botBrowser.closed) return false;
  if (session.page.isClosed()) return false;
  return session.botBrowser.browser?.isConnected() ?? true;
}

// Closes only the TAB. The browser stays up on purpose: it is shared by every
// source (see the top of the file), so closing it would kill the others'
// searches, and when it is the user's own window (CDP) that would be worse.
export async function closeChromeSession(session: ChromeSession): Promise<void> {
  if (session.page.isClosed()) return;
  await session.page.close();
}
