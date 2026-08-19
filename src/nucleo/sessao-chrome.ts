import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Navegador real (com reputação de perfil) usado pelos bots da AA e da LATAM.
//
// UM Chrome por processo, compartilhado por todas as buscas. Cada busca ganha
// só uma ABA nova (context.newPage()), nunca um navegador novo.
//
// Por que compartilhado, e não um por busca: o perfil do Chrome é um diretório
// com trava exclusiva. Dois `launchPersistentContext` no mesmo perfil fazem o
// segundo morrer com "Opening in existing browser session" — e como os pools da
// AA e da LATAM têm 2 slots cada, quatro buscas simultâneas tentavam abrir
// quatro navegadores no mesmo perfil.
//
// Sobre a porta de depuração (CDP): tentamos primeiro conectar numa janela já
// aberta, mas nesta máquina o attach do Playwright trava mesmo com a porta
// respondendo — uma janela real acumula alvos (pixels de anúncio, iframes de
// recaptcha) e o attach não conclui. Por isso o caminho normal hoje é o bot
// abrir a própria janela; o CDP ficou como oportunidade, com timeout curto.

export type NavegadorBot = {
  browser: Browser | null; // null em contexto persistente (é o caso normal)
  context: BrowserContext;
  viaCdp: boolean; // true = aba numa janela que não é nossa (não fechar!)
  fechado: boolean;
};

export type SessaoChrome = {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  viaCdp: boolean;
  navegador: NavegadorBot;
};

export const CDP_URL = process.env.AA_CDP_URL || `http://localhost:${process.env.AA_CDP_PORTA || 9222}`;
// Fora do repositório porque é dado de navegador, não código. O mesmo perfil
// serve todos os bots, então a reputação e os logins acumulados por um valem
// pros outros.
export const DIR_PERFIL = process.env.AA_CHROME_PERFIL || path.join(os.homedir(), ".chrome-bot-aa");

let compartilhado: Promise<NavegadorBot> | null = null;

export async function abrirSessaoChrome(headless: boolean, rotulo: string): Promise<SessaoChrome> {
  // Duas tentativas: se o navegador compartilhado tiver morrido entre o await
  // e o uso, a segunda passada abre um novo em vez de devolver sessão morta.
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const navegador = await navegadorCompartilhado(headless, rotulo);
    if (navegador.fechado) {
      esquecer(navegador);
      continue;
    }
    try {
      return {
        browser: navegador.browser,
        context: navegador.context,
        page: await navegador.context.newPage(),
        viaCdp: navegador.viaCdp,
        navegador,
      };
    } catch (err) {
      // newPage falha se o navegador caiu bem nesse instante.
      esquecer(navegador);
      if (tentativa === 1) throw err;
    }
  }
  throw new Error("Falha ao abrir uma aba no navegador do bot.");
}

function navegadorCompartilhado(headless: boolean, rotulo: string): Promise<NavegadorBot> {
  if (compartilhado) return compartilhado;

  const promessa = abrirNavegador(headless, rotulo);
  compartilhado = promessa;
  // Sem isso, uma falha de abertura ficaria cacheada e TODA busca seguinte
  // repetiria o mesmo erro até reiniciar o servidor.
  promessa.catch(() => {
    if (compartilhado === promessa) compartilhado = null;
  });
  return promessa;
}

function esquecer(navegador: NavegadorBot) {
  navegador.fechado = true;
  compartilhado = null;
}

async function abrirNavegador(headless: boolean, rotulo: string): Promise<NavegadorBot> {
  return (await conectarNaJanelaDoBot(rotulo)) ?? (await abrirChromePróprio(headless, rotulo));
}

async function conectarNaJanelaDoBot(rotulo: string): Promise<NavegadorBot | null> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 3000 });
    // contexts()[0] é o perfil já aberto na janela (com os cookies dele);
    // newContext() criaria um anônimo, sem nenhuma dessa reputação.
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      return null;
    }
    console.log(`[${rotulo}] usando a janela do bot já aberta (${CDP_URL}).`);
    const navegador: NavegadorBot = { browser, context, viaCdp: true, fechado: false };
    browser.on("disconnected", () => esquecer(navegador));
    return navegador;
  } catch {
    // Porta fechada, ou attach que não conclui (ver comentário do topo).
    return null;
  }
}

async function abrirChromePróprio(headless: boolean, rotulo: string): Promise<NavegadorBot> {
  console.log(`[${rotulo}] abrindo a janela do Chrome do bot (perfil ${DIR_PERFIL}).`);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(DIR_PERFIL, {
      headless,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: null,
    });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    // O perfil é de uso exclusivo: se já existe um Chrome segurando ele (é o
    // que `npm run chrome` faz), não dá pra abrir outro nem tomar o lugar.
    if (/existing browser session|already in use|ProcessSingleton/i.test(mensagem)) {
      throw new Error(
        "O perfil do bot já está em uso por outra janela do Chrome, e a conexão com ela falhou. " +
          "Feche com `npm run chrome:parar` e busque de novo. O bot abre a janela dele sozinho, " +
          "não é mais preciso rodar `npm run chrome` antes.",
      );
    }
    throw err;
  }

  const navegador: NavegadorBot = { browser: context.browser(), context, viaCdp: false, fechado: false };
  context.on("close", () => esquecer(navegador));
  return navegador;
}

// A sessão continua utilizável? (o pool usa isso pra decidir se recria)
export function sessaoViva(s: SessaoChrome): boolean {
  if (s.navegador.fechado) return false;
  if (s.page.isClosed()) return false;
  return s.navegador.browser?.isConnected() ?? true;
}
