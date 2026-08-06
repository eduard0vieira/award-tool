import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Sessão de navegador compartilhada pelos bots que dependem de um Chrome real
// com reputação (AA e LATAM). Duas formas, nessa ordem:
//
// 1. Aba na janela do bot (preferida): se o Chrome estiver rodando com a porta
//    de depuração aberta (`npm run chrome`), abre só mais uma aba nele e herda
//    o perfil — mesmos cookies e mesmo histórico. É o que faz os sites tratarem
//    o acesso como navegação normal, e o que permite herdar um login feito à
//    mão (ver scripts/importar-cookies.sh).
// 2. Chrome próprio com o MESMO perfil persistente (fallback automático):
//    funciona sem preparo, mas parte de uma reputação menor.

export type SessaoChrome = {
  browser: Browser | null; // null em contexto persistente
  context: BrowserContext;
  page: Page;
  viaCdp: boolean; // true = aba na janela do bot (não fechar o navegador!)
};

export const CDP_URL = process.env.AA_CDP_URL || `http://localhost:${process.env.AA_CDP_PORTA || 9222}`;
// Fora do repositório porque é dado de navegador, não código. O mesmo perfil
// serve todos os bots, então a reputação acumulada por um vale pros outros.
export const DIR_PERFIL = process.env.AA_CHROME_PERFIL || path.join(os.homedir(), ".chrome-bot-aa");

export async function abrirSessaoChrome(headless: boolean, rotulo: string): Promise<SessaoChrome> {
  return (await conectarNaJanelaDoBot(rotulo)) ?? (await abrirChromePróprio(headless, rotulo));
}

async function conectarNaJanelaDoBot(rotulo: string): Promise<SessaoChrome | null> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 3000 });
    // contexts()[0] é o perfil já aberto na janela (com os cookies dele);
    // newContext() criaria um anônimo, sem nenhuma dessa reputação.
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      return null;
    }
    console.log(`[${rotulo}] usando uma aba da janela do bot (${CDP_URL}).`);
    return { browser, context, page: await context.newPage(), viaCdp: true };
  } catch {
    // Sem janela aberta (todas as abas fechadas) o Chrome recusa a conexão —
    // aí vale mais abrir um navegador próprio do que insistir.
    return null;
  }
}

async function abrirChromePróprio(headless: boolean, rotulo: string): Promise<SessaoChrome> {
  console.log(
    `[${rotulo}] janela do bot indisponível — abrindo navegador próprio. ` +
      "Pra usar a janela do bot (menos bloqueios, e é ela que tem os logins), rode `npm run chrome`.",
  );
  const context = await chromium.launchPersistentContext(DIR_PERFIL, {
    headless,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser: context.browser(), context, page, viaCdp: false };
}

// A sessão continua utilizável? (o pool usa isso pra decidir se recria)
export function sessaoViva(s: SessaoChrome): boolean {
  return !s.page.isClosed() && (s.browser?.isConnected() ?? true);
}
