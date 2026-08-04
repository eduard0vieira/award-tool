import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  LimitadorFrequencia,
  formatarListaPorMes,
  type OnAviso,
  type OnLog,
  type OnProgresso,
  type SecaoRelatorio,
} from "./comum.ts";

// Bot da American Airlines (aa.com), busca de prêmios (Award) sem login.
//
// Como funciona (levantado no recon — ver notas-recon-aa.md):
// - O Akamai barra o Chromium do Playwright (403 imediato), mas o Chrome real
//   (channel "chrome" + flag de automação escondida) passa, desde que a
//   sessão "aqueça" visitando a home antes de qualquer URL de /booking.
// - A página de resultados aceita deep-link a frio (sem preencher formulário).
// - O calendário mensal vem de POST /booking/api/search/calendar, que não
//   depende de estado de sessão: mudando só o departureDate dá pra varrer o
//   ano com ~12 chamadas. A chamada precisa ser feita DE DENTRO da página
//   (fetch via page.evaluate) — page.request, fora do navegador, leva 403
//   porque o TLS não é o do Chrome.
// - O request aceita cabine e maxStops (0 = só direto, 1 = até 1 conexão)
//   server-side, então o filtro de conexões é o mesmo do site.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type SessaoAA = {
  browser: Browser | null; // null em contexto persistente (ver iniciarSessaoAA)
  context: BrowserContext;
  page: Page;
  viaCdp: boolean; // true = aba no Chrome do usuário (não fechar o navegador!)
};

export type CabineAA = "economica" | "premium" | "executiva";

export const CABINE_AA_LABEL: Record<CabineAA, string> = {
  economica: "Econômica",
  premium: "Premium Economy",
  executiva: "Executiva",
};

// Valores aceitos no campo slices[].cabin do request (o site manda
// "BUSINESS,FIRST" quando o usuário escolhe Business na UI).
const CABINE_AA_REQUEST: Record<CabineAA, string> = {
  economica: "COACH",
  premium: "PREMIUM_ECONOMY",
  executiva: "BUSINESS,FIRST",
};

export type ParametrosAA = {
  origem: string; // IATA
  destino: string; // IATA
  cabine: CabineAA;
  maxConexoes: number | null; // null = qualquer, 0 = só direto, 1 = até 1 conexão
};

export type DiaAA = {
  data: string; // YYYY-MM-DD
  milhas: number; // menor valor do dia pra cabine pedida
};

export type MesComFalha = { mes: string; erro: string };
export type ResultadoAnoAA = { dias: DiaAA[]; mesesComFalha: MesComFalha[] };

const INTERVALO_MIN_AA_MS = Number(process.env.AA_INTERVALO_BUSCAS_MS) || 6000;
const limitadorAA = new LimitadorFrequencia(INTERVALO_MIN_AA_MS);

// Uma falha de mês pode ser passageira, mas várias seguidas indicam bloqueio
// ou rota quebrada — aí desiste preservando o que já coletou (mesmo padrão
// do pesquisarAnoCompleto da TAP).
const MAX_MESES_FALHAS_SEGUIDAS = 3;
const MESES_A_VARRER = 12;

// Onde o Chrome do usuário expõe o DevTools Protocol (ver `npm run chrome`).
const AA_CDP_URL = process.env.AA_CDP_URL || "http://localhost:9222";
// Perfil próprio do bot, usado no modo avulso. Diferente de um contexto novo
// a cada busca, ele acumula cookies/histórico entre execuções — o Akamai
// confia mais num perfil com passado do que num recém-criado.
const DIR_PERFIL_AA = path.join(__dirname, ".perfil-aa");

// Duas formas de sessão, nessa ordem:
//
// 1. Aba no SEU Chrome (preferida): se o Chrome estiver rodando com a porta
//    de depuração aberta (`npm run chrome`), o bot abre só mais uma aba nele
//    e herda seu perfil real — mesmos cookies, mesmo histórico, mesma
//    reputação de sempre. É o que resolve o "Access Denied" que só acontece
//    no navegador automatizado, já que pro Akamai é a sua navegação normal.
// 2. Chrome próprio com perfil persistente (fallback automático): funciona
//    sem preparo nenhum, mas parte de uma reputação zerada e pode apanhar do
//    anti-bot até o perfil "esquentar".
export async function iniciarSessaoAA(headless = false): Promise<SessaoAA> {
  const sessao = (await conectarNoChromeDoUsuario()) ?? (await abrirChromePróprio(headless));

  // Aquecimento: sem passar pela home primeiro, o Akamai devolve 403 nas
  // URLs de /booking.
  await sessao.page.goto("https://www.aa.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sessao.page.waitForTimeout(4000);

  if (/access denied/i.test(await sessao.page.title())) {
    throw new Error(
      sessao.viaCdp
        ? "A AA bloqueou o acesso mesmo pelo seu Chrome. Espere alguns minutos antes de tentar de novo."
        : "A AA bloqueou o acesso ao navegador do bot. Rode `npm run chrome` (com o Chrome fechado antes) " +
          "pra o bot buscar numa aba do seu próprio navegador, que costuma passar.",
    );
  }

  return sessao;
}

async function conectarNoChromeDoUsuario(): Promise<SessaoAA | null> {
  try {
    const browser = await chromium.connectOverCDP(AA_CDP_URL, { timeout: 3000 });
    // contexts()[0] é o perfil já aberto do usuário (com os cookies dele);
    // newContext() criaria um anônimo, sem nenhuma dessa reputação.
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      return null;
    }
    console.log(`[AA] usando uma aba do seu Chrome (${AA_CDP_URL}).`);
    return { browser, context, page: await context.newPage(), viaCdp: true };
  } catch {
    return null;
  }
}

async function abrirChromePróprio(headless: boolean): Promise<SessaoAA> {
  console.log(
    "[AA] Chrome do usuário indisponível — abrindo navegador próprio. " +
      "Pra usar o seu (menos bloqueios), feche o Chrome e rode `npm run chrome`.",
  );
  const context = await chromium.launchPersistentContext(DIR_PERFIL_AA, {
    headless,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser: context.browser(), context, page, viaCdp: false };
}

function dataISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Uma data "de busca" pra cada um dos 12 meses a partir de hoje. O endpoint
// devolve o mês inteiro do departureDate, então o dia exato só precisa ser
// válido (não pode estar no passado).
function datasDosMeses(): string[] {
  const hoje = new Date();
  const datas: string[] = [];
  for (let m = 0; m < MESES_A_VARRER; m++) {
    const data = new Date(hoje.getFullYear(), hoje.getMonth() + m, 15);
    if (m === 0) {
      // No mês corrente o dia 15 pode já ter passado — usa amanhã.
      const amanha = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1);
      if (amanha.getMonth() !== hoje.getMonth()) continue; // último dia do mês: mês já coberto pelo seguinte
      datas.push(dataISO(amanha));
      continue;
    }
    datas.push(dataISO(data));
  }
  return datas;
}

function corpoCalendario(params: ParametrosAA, departureDate: string) {
  return {
    metadata: { selectedProducts: [], tripType: "OneWay", udo: {} },
    passengers: [{ type: "adult", count: 1 }],
    requestHeader: { clientId: "AAcom" },
    slices: [
      {
        allCarriers: true,
        cabin: CABINE_AA_REQUEST[params.cabine],
        departureDate,
        destination: params.destino,
        destinationNearbyAirports: false,
        maxStops: params.maxConexoes,
        origin: params.origem,
        originNearbyAirports: false,
      },
    ],
    tripOptions: {
      corporateBooking: false,
      fareType: "Lowest",
      locale: "en_US",
      pointOfSale: null,
      searchType: "Award",
      enableBenefits: true,
    },
    loyaltyInfo: null,
    version: "",
    queryParams: { sliceIndex: 0, sessionId: "", solutionSet: "", solutionId: "" },
  };
}

class ErroForaDoHorizonte extends Error {
  constructor(departureDate: string) {
    super(`Mês de ${departureDate} está além do período de venda da AA.`);
  }
}

type RespostaCalendario = {
  error?: string;
  calendarMonths?: {
    month: string;
    year: string;
    weeks?: { days?: { date: string | null; validDay: boolean; solution: { perPassengerAwardPoints: number } | null }[] }[];
  }[];
};

// Abre a página de resultados via deep-link — é ela que estabelece os
// cookies/contexto que as chamadas de calendário reutilizam.
async function abrirPaginaDeResultados(page: Page, params: ParametrosAA, dataInicial: string, onLog: OnLog) {
  const slices = JSON.stringify([
    { orig: params.origem, origNearby: false, dest: params.destino, destNearby: false, date: dataInicial },
  ]);
  const url =
    "https://www.aa.com/booking/search?locale=en_US&pax=1&adult=1&type=OneWay&searchType=Award&cabin=&carriers=ALL&slices=" +
    encodeURIComponent(slices);

  onLog(`Abrindo busca de prêmios ${params.origem} → ${params.destino}...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  const titulo = await page.title();
  if (/access denied/i.test(titulo)) {
    throw new Error(
      "A AA bloqueou o acesso (Access Denied). Espere alguns minutos e tente de novo; se persistir, aumente AA_INTERVALO_BUSCAS_MS no .env.",
    );
  }
  if (!page.url().includes("choose-flights")) {
    // Não redirecionou pros resultados — rota inválida ou erro no formulário.
    const textoPagina = await page.evaluate(() => document.body.innerText.slice(0, 400));
    throw new Error(
      `A busca não chegou à página de resultados (URL: ${page.url()}). Confira se a rota ${params.origem} → ${params.destino} existe. Texto da página: ${textoPagina.slice(0, 150)}`,
    );
  }
}

// Busca o calendário de um mês via fetch de dentro da página. Retorna os dias
// com disponibilidade (solution != null) na cabine/filtro pedidos.
async function buscarMes(page: Page, params: ParametrosAA, departureDate: string): Promise<DiaAA[]> {
  const resultado = await page.evaluate(
    async (corpo) => {
      const res = await fetch("/booking/api/search/calendar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      return { status: res.status, texto: await res.text() };
    },
    corpoCalendario(params, departureDate),
  );

  if (resultado.status === 400) {
    // A AA só vende até ~331 dias no futuro; meses além disso respondem 400.
    throw new ErroForaDoHorizonte(departureDate);
  }
  if (resultado.status !== 200) {
    throw new Error(`Calendário respondeu com status ${resultado.status} (mês de ${departureDate}).`);
  }

  let corpo: RespostaCalendario;
  try {
    corpo = JSON.parse(resultado.texto) as RespostaCalendario;
  } catch {
    throw new Error(`Calendário devolveu uma resposta que não é JSON (mês de ${departureDate}).`);
  }
  if (corpo.error) {
    throw new Error(`Calendário devolveu erro: ${corpo.error}`);
  }

  const hoje = dataISO(new Date());
  const dias: DiaAA[] = [];
  for (const mes of corpo.calendarMonths ?? []) {
    for (const semana of mes.weeks ?? []) {
      for (const dia of semana.days ?? []) {
        if (!dia?.validDay || !dia.solution || !dia.date) continue;
        if (dia.date <= hoje) continue; // o mês corrente vem com dias já passados
        dias.push({ data: dia.date, milhas: dia.solution.perPassengerAwardPoints });
      }
    }
  }
  return dias;
}

// Detecção de bloqueio: a AA responde 403 (Akamai) quando enche o saco.
const MAX_TENTATIVAS_BLOQUEIO = 3;
const COOLDOWN_BLOQUEIO_MS = 90_000;

export async function pesquisarAnoAA(
  page: Page,
  params: ParametrosAA,
  onLog: OnLog = () => {},
  onProgresso: OnProgresso = () => {},
  onAviso: OnAviso = () => {},
): Promise<ResultadoAnoAA> {
  const origem = params.origem.toUpperCase();
  const destino = params.destino.toUpperCase();
  const paramsNorm: ParametrosAA = { ...params, origem, destino };

  const datas = datasDosMeses();
  await limitadorAA.aguardarVez();
  await abrirPaginaDeResultados(page, paramsNorm, datas[0]!, onLog);
  onProgresso(0.1);

  const todosOsDias: DiaAA[] = [];
  const mesesComFalha: MesComFalha[] = [];
  let falhasSeguidas = 0;
  let foraDoHorizonte = false;

  for (let i = 0; i < datas.length; i++) {
    const departureDate = datas[i]!;
    const rotuloMes = departureDate.slice(0, 7); // YYYY-MM
    let sucesso = false;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_BLOQUEIO && !sucesso; tentativa++) {
      await limitadorAA.aguardarVez();
      // Pausa extra aleatória: cadência mais humana entre os meses.
      await page.waitForTimeout(500 + Math.random() * 1500);
      try {
        const dias = await buscarMes(page, paramsNorm, departureDate);
        todosOsDias.push(...dias);
        onLog(`Mês ${rotuloMes}: ${dias.length} dia(s) com disponibilidade.`);
        sucesso = true;
      } catch (err) {
        if (err instanceof ErroForaDoHorizonte) {
          // Fim natural da varredura: a AA ainda não vende esse mês.
          onLog(`Mês ${rotuloMes} ainda não está à venda — fim da varredura.`);
          foraDoHorizonte = true;
          break;
        }
        const mensagem = err instanceof Error ? err.message : String(err);
        const pareceBloqueio = /status 403/.test(mensagem);
        if (pareceBloqueio && tentativa < MAX_TENTATIVAS_BLOQUEIO) {
          const esperaMs = COOLDOWN_BLOQUEIO_MS * tentativa;
          const esperaMin = Math.round(esperaMs / 60000 * 10) / 10;
          onAviso(`A AA bloqueou temporariamente (403) — esperando ${esperaMin} min antes de tentar de novo...`);
          onLog(`Bloqueio 403 no mês ${rotuloMes}; cooldown de ${esperaMin} min (tentativa ${tentativa}).`);
          await page.waitForTimeout(esperaMs);
          onAviso("");
        } else {
          mesesComFalha.push({ mes: rotuloMes, erro: mensagem });
          onLog(`Falha no mês ${rotuloMes}: ${mensagem}`);
          break;
        }
      }
    }
    onAviso("");
    if (foraDoHorizonte) break;

    if (sucesso) {
      falhasSeguidas = 0;
    } else {
      falhasSeguidas++;
      if (falhasSeguidas >= MAX_MESES_FALHAS_SEGUIDAS) {
        onLog(
          `${falhasSeguidas} meses seguidos falharam — parando por aqui e devolvendo o que já foi coletado.`,
        );
        break;
      }
    }

    onProgresso(0.1 + 0.9 * ((i + 1) / datas.length));
  }

  onProgresso(1);
  todosOsDias.sort((a, b) => a.data.localeCompare(b.data));
  return { dias: todosOsDias, mesesComFalha };
}

// Relatório de uma cabine só (a busca da AA é por cabine). Teto em milhas
// absolutas (ex.: 60000); dias mais caros ficam de fora.
export function construirRelatorioAA(dias: DiaAA[], tetoMilhas: number | null): SecaoRelatorio {
  const aceitos = dias.filter((d) => tetoMilhas == null || d.milhas <= tetoMilhas);

  if (aceitos.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const diasFormatados = aceitos.map((d) => ({
    data: d.data,
    valorK: Math.round(d.milhas / 10) / 100, // 171500 -> 171.5
  }));
  const valores = diasFormatados.map((d) => d.valorK);

  return {
    menor: Math.min(...valores),
    maior: Math.max(...valores),
    dias: diasFormatados,
    texto: formatarListaPorMes(diasFormatados.map((d) => d.data)),
  };
}
