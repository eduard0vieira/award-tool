import "dotenv/config";
import type { Page } from "playwright";
import { openChromeSession, type ChromeSession } from "../../core/chrome-session.ts";
import {
  RateLimiter,
  formatDatesByMonth,
  type ShouldStop,
  type OnNotice,
  type OnLog,
  type OnProgress,
  type ReportSection,
} from "../../core/common.ts";

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

export type SessaoAA = ChromeSession;

export type CabineAA = "economica" | "premium" | "executiva" | "primeira";

export const CABINE_AA_LABEL: Record<CabineAA, string> = {
  economica: "Econômica",
  premium: "Premium Economy",
  executiva: "Executiva",
  primeira: "Primeira Classe",
};

// Valores aceitos no campo slices[].cabin do request (o site manda
// "BUSINESS,FIRST" quando o usuário escolhe Business na UI).
const CABINE_AA_REQUEST: Record<CabineAA, string> = {
  economica: "COACH",
  premium: "PREMIUM_ECONOMY",
  // "BUSINESS,FIRST" é o que o site manda ao escolher Business; conferido que
  // devolve exatamente o mesmo que "BUSINESS" (a primeira classe é sempre mais
  // cara, então nunca vira o menor valor do dia).
  executiva: "BUSINESS,FIRST",
  primeira: "FIRST",
};

// Valores aceitos no parâmetro `cabin` da URL de busca — não são os mesmos do
// request: lá "executiva" vira "BUSINESS,FIRST", que na URL não é aceito.
// Conferido no navegador em 2026-09-17: com BUSINESS a página de resultados
// abre já filtrada na Executiva, e com PREMIUM_ECONOMY idem.
const CABINE_AA_LINK: Record<CabineAA, string> = {
  economica: "COACH",
  premium: "PREMIUM_ECONOMY",
  executiva: "BUSINESS",
  primeira: "FIRST",
};

// A URL da busca de prêmios. Serve pra duas coisas: o bot abrir a página de
// resultados (que planta os cookies) e o front oferecer o link de emissão do
// dia. É o mesmo endereço que o site gera quando alguém busca na mão.
function urlBuscaAA(
  params: { origem: string; destino: string; passageiros: number; cabine?: CabineAA },
  data: string,
): string {
  const slices = JSON.stringify([
    { orig: params.origem, origNearby: false, dest: params.destino, destNearby: false, date: data },
  ]);
  return (
    `https://www.aa.com/booking/search?locale=en_US&pax=${params.passageiros}&adult=${params.passageiros}` +
    `&type=OneWay&searchType=Award&cabin=${params.cabine ? CABINE_AA_LINK[params.cabine] : ""}&carriers=ALL&slices=` +
    encodeURIComponent(slices)
  );
}

// Link de emissão de um dia: abre a página de resultados da AA já com rota,
// data, cabine e número de passageiros preenchidos.
export function linkEmissaoAA(
  params: { origem: string; destino: string; passageiros: number; cabine: CabineAA },
  data: string,
): string {
  return urlBuscaAA(params, data);
}

// A AA aceita no máximo 9 passageiros por busca (conferido: com 10 ela
// responde 400 dizendo "Total number of passengers must be between 1 and 9").
export const MAX_PASSAGEIROS_AA = 9;

export type ParametrosAA = {
  origem: string; // IATA
  destino: string; // IATA
  cabine: CabineAA;
  maxConexoes: number | null; // null = qualquer, 0 = só direto, 1 = até 1 conexão
  // Quantos adultos na mesma reserva. Pedir mais gente deixa a busca mais
  // seletiva: o dia só aparece se houver essa quantidade de assentos-prêmio no
  // mesmo voo, e o valor mostrado é o de cada passageiro (não o total).
  passageiros: number;
};

export type DiaAA = {
  data: string; // YYYY-MM-DD
  milhas: number; // menor valor do dia pra cabine pedida
};

export type MesComFalha = { mes: string; erro: string };
export type ResultadoAnoAA = { dias: DiaAA[]; mesesComFalha: MesComFalha[] };

const INTERVALO_MIN_AA_MS = Number(process.env.AA_INTERVALO_BUSCAS_MS) || 6000;
const limitadorAA = new RateLimiter(INTERVALO_MIN_AA_MS);

// Uma falha de mês pode ser passageira, mas várias seguidas indicam bloqueio
// ou rota quebrada — aí desiste preservando o que já coletou (mesmo padrão
// do pesquisarAnoCompleto da TAP).
const MAX_MESES_FALHAS_SEGUIDAS = 3;
const MESES_A_VARRER = 12;


export async function iniciarSessaoAA(headless = false): Promise<SessaoAA> {
  const sessao = await openChromeSession(headless, "AA");

  // Aquecimento: sem passar pela home primeiro, o Akamai devolve 403 nas
  // URLs de /booking.
  await sessao.page.goto("https://www.aa.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sessao.page.waitForTimeout(4000);

  if (/access denied/i.test(await sessao.page.title())) {
    throw new Error(
      sessao.viaCdp
        ? "AA bloqueou o acesso mesmo pelo Chrome do usuário. Aguarde alguns minutos antes de repetir."
        : "A AA bloqueou o acesso ao navegador do bot. Rode `npm run chrome` no terminal pra o bot buscar " +
          "numa aba do seu próprio navegador, que costuma passar.",
    );
  }

  return sessao;
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
    passengers: [{ type: "adult", count: params.passageiros }],
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

type Resposta400 = {
  message?: string;
  details?: { field?: string; reason?: string }[];
};

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
  // Sem cabine de propósito: aqui a página só serve pra plantar os cookies que
  // as chamadas de calendário reutilizam, e o filtro quem aplica é o request.
  const url = urlBuscaAA(params, dataInicial);

  onLog(`Abrindo busca de prêmios ${params.origem} → ${params.destino}...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  const titulo = await page.title();
  if (/access denied/i.test(titulo)) {
    throw new Error(
      "AA bloqueou o acesso (Access Denied). Aguarde alguns minutos e repita; se persistir, aumente AA_INTERVALO_BUSCAS_MS no .env.",
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
    // 400 tem dois significados bem diferentes, e confundir os dois sai caro:
    // a AA só vende até ~331 dias no futuro (fim natural da varredura), mas
    // ela também devolve 400 quando o pedido em si está errado — passageiros
    // demais, por exemplo. Tratar o segundo caso como fim de calendário faria
    // a varredura parar no primeiro mês e entregar "nenhuma disponibilidade"
    // em vez de um erro. Por isso a distinção vem do motivo, não do status.
    let corpo400: Resposta400 = {};
    try {
      corpo400 = JSON.parse(resultado.texto) as Resposta400;
    } catch {
      /* sem corpo legível: cai no erro genérico abaixo */
    }
    const motivos = (corpo400.details ?? []).map((d) => d.reason).filter(Boolean) as string[];
    if (motivos.some((m) => /outside of available schedule/i.test(m))) {
      throw new ErroForaDoHorizonte(departureDate);
    }
    throw new Error(
      `A AA recusou a busca: ${motivos.join(" ") || corpo400.message || resultado.texto.slice(0, 200)}`,
    );
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
  // O 309 NÃO é falha: é "não há prêmio nesse mês nesta rota". Vem com HTTP
  // 200, `calendarMonths: []` e `lowestMonthlyPrice: 0` — calendário vazio bem
  // formado. Medido em 2026-09-25 com HEL→NRT executiva: setembro a janeiro
  // respondem 309 e julho/2027 responde 23 dias a 75.000.
  //
  // Tratá-lo como erro custou caro: como a varredura desiste depois de três
  // meses seguidos falhando, uma rota sazonal morria nos primeiros meses e
  // devolvia "nenhuma disponibilidade" para o ano INTEIRO, escondendo dezenas
  // de datas que existiam. Ausência de dado e falha de busca são estados
  // diferentes — esta linha é essa distinção.
  if (corpo.error === "309") return [];
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
  onProgresso: OnProgress = () => {},
  onAviso: OnNotice = () => {},
  deveParar: ShouldStop = () => false,
): Promise<ResultadoAnoAA> {
  const origem = params.origem.toUpperCase();
  const destino = params.destino.toUpperCase();
  const paramsNorm: ParametrosAA = { ...params, origem, destino };

  const datas = datasDosMeses();
  await limitadorAA.waitTurn();
  await abrirPaginaDeResultados(page, paramsNorm, datas[0]!, onLog);
  onProgresso(0.1);

  const todosOsDias: DiaAA[] = [];
  const mesesComFalha: MesComFalha[] = [];
  let falhasSeguidas = 0;
  let foraDoHorizonte = false;

  for (let i = 0; i < datas.length; i++) {
    if (deveParar()) {
      onLog("Busca cancelada. Devolvendo os meses já consultados.");
      break;
    }
    const departureDate = datas[i]!;
    const rotuloMes = departureDate.slice(0, 7); // YYYY-MM
    let sucesso = false;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_BLOQUEIO && !sucesso; tentativa++) {
      await limitadorAA.waitTurn();
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
          onLog(`Mês ${rotuloMes} ainda não está à venda. Fim da varredura.`);
          foraDoHorizonte = true;
          break;
        }
        const mensagem = err instanceof Error ? err.message : String(err);
        const pareceBloqueio = /status 403/.test(mensagem);
        if (pareceBloqueio && tentativa < MAX_TENTATIVAS_BLOQUEIO) {
          const esperaMs = COOLDOWN_BLOQUEIO_MS * tentativa;
          const esperaMin = Math.round(esperaMs / 60000 * 10) / 10;
          onAviso(`A AA bloqueou temporariamente (403). Esperando ${esperaMin} min antes de tentar de novo...`);
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
          `${falhasSeguidas} meses seguidos falharam. Parando por aqui e devolvendo o que já foi coletado.`,
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
export function construirRelatorioAA(
  dias: DiaAA[],
  tetoMilhas: number | null,
  params?: { origem: string; destino: string; passageiros: number; cabine: CabineAA },
): ReportSection {
  const aceitos = dias.filter((d) => tetoMilhas == null || d.milhas <= tetoMilhas);

  if (aceitos.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const diasFormatados = aceitos.map((d) => ({
    data: d.data,
    valorK: Math.round(d.milhas / 10) / 100, // 171500 -> 171.5
    ...(params ? { link: linkEmissaoAA(params, d.data) } : {}),
  }));
  const valores = diasFormatados.map((d) => d.valorK);

  return {
    menor: Math.min(...valores),
    maior: Math.max(...valores),
    dias: diasFormatados,
    texto: formatDatesByMonth(diasFormatados.map((d) => d.data)),
  };
}
