import type { Page } from "playwright";
import {
  formatarListaPorMes,
  LimitadorFrequencia,
  type DeveParar,
  type OnAviso,
  type OnLog,
  type OnProgresso,
  type SecaoRelatorio,
} from "../../nucleo/comum.ts";
import { abrirSessaoChrome, type SessaoChrome } from "../../nucleo/sessao-chrome.ts";

// Fonte Iberia (Avios), escrita contra respostas reais salvas em `fixtures/`
// e documentadas em `contexto/notas-recon-iberia.md`.
//
// A varredura sai de UM endpoint só:
//
//   POST /api/sse-rpa/rs/v1/calendar/grid  → 191 dias numa resposta, os que
//   têm prêmio trazendo `avios`; os que não têm simplesmente não trazem o campo
//
// É o que a tela "Vista mensal de voos" usa. O `/availability`, que o projeto
// antigo atacava, devolve só assentos por voo e NENHUM preço — por isso não
// serve sozinho. Ver "por que sem vagas" no fim deste arquivo.

export type SessaoIberia = SessaoChrome;

export type ParametrosIberia = {
  origem: string; // IATA
  destino: string; // IATA
  passageiros: number;
};

export type DiaIberia = {
  data: string; // YYYY-MM-DD
  avios: number; // menor valor do dia, somando todas as cabines
};

// Ausência de dado e falha na busca são estados diferentes, e a Iberia tem um
// terceiro: requisição que não volta resposta nenhuma (visto quando o site
// cortou a sequência de buscas). Tratar isso como "sem disponibilidade" mandaria
// "não achei nada" pro cliente com a busca nem tendo saído.
export type ResultadoIberia =
  | { tipo: "ok"; dias: DiaIberia[]; janela: { de: string; ate: string } }
  | { tipo: "sem_disponibilidade"; janela: { de: string; ate: string } }
  | { tipo: "parcial"; dias: DiaIberia[]; janela: { de: string; ate: string }; motivo: string }
  | { tipo: "erro"; motivo: string; http?: number };

const INTERVALO_MIN_IBERIA_MS = Number(process.env.IBERIA_INTERVALO_BUSCAS_MS) || 8000;
const TAMANHO_LOTE_DETALHE = Number(process.env.IBERIA_LOTE_DETALHE) || 1;
const PAUSA_APOS_FALHA_MS = 30_000;
const limitadorIberia = new LimitadorFrequencia(INTERVALO_MIN_IBERIA_MS);

// A grade observada devolveu 191 dias pedindo `maxSearchTime: 359` e começou em
// HOJE, não na data pedida. Como o comportamento da janela não foi confirmado, a
// varredura não assume tamanho: pede, olha até onde veio, e pede de novo a
// partir do dia seguinte enquanto avançar. O teto existe só pra não girar em
// falso se o site ignorar a data.
const MAX_CHAMADAS_GRADE = 4;
const DIAS_A_COBRIR = 359;
const MERCADO = process.env.IBERIA_MERCADO || "US";

export async function iniciarSessaoIberia(headless = false): Promise<SessaoIberia> {
  const sessao = await abrirSessaoChrome(headless, "Iberia");
  observarAutorizacao(sessao.page);
  await sessao.page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sessao.page.waitForTimeout(4000);
  return sessao;
}

function dataISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daquiA(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return dataISO(d);
}

// Deep link da tela de resultados, no formato que o próprio site monta. Vale
// ouro: chegar aos resultados por URL dispensa dirigir o formulário da home —
// que tem autocomplete ambíguo (digitar "MAD" oferece Madison antes de Madrid),
// banner promocional cobrindo o botão e datepicker que ignora texto digitado.
export function linkEmissaoIberia(params: ParametrosIberia, data: string): string {
  const [ano, mes, dia] = data.split("-") as [string, string, string];
  const q = new URLSearchParams({
    market: MERCADO,
    // `fromMarket`, `bookingMarket` e `quadrigam` vão copiados da URL que o
    // próprio site monta. O `quadrigam` não tem significado conhecido aqui —
    // entra porque estava na requisição real que funcionou, não por dedução.
    fromMarket: "BR",
    bookingMarket: "BR",
    quadrigam: "IBHMPA",
    language: "pt",
    appliesOMB: "false",
    splitEndCity: "false",
    initializedOMB: "true",
    flexible: "true",
    TRIP_TYPE: "1",
    BEGIN_CITY_01: params.origem.toUpperCase(),
    END_CITY_01: params.destino.toUpperCase(),
    BEGIN_DAY_01: dia,
    BEGIN_MONTH_01: `${ano}${mes}`,
    BEGIN_YEAR_01: ano,
    END_DAY_01: "",
    END_MONTH_01: "",
    END_YEAR_01: "",
    FARE_TYPE: "R",
    ADT: String(params.passageiros),
    CHD: "0",
    INF: "0",
    residentCode: "",
    familianumerosa: "",
    boton: "Buscar",
    pagoAvios: "true",
  });
  return `https://www.iberia.com/flights/?${q.toString()}#!/availability`;
}

// Headers copiados da chamada real que o site faz (ver seção 7 das notas de
// recon). Não é enfeite: com só `content-type`, o `/availability` devolve 401
// mesmo com o bearer válido que o `/calendar/grid` aceita.
function cabecalhosIberia(autorizacao: string, pagina: "availability" | "calendar") {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "pt-BR",
    "content-type": "application/json",
    authorization: autorizacao,
    "x-observations-current-page": pagina,
    "x-observations-origin-page": pagina,
    "x-request-appversion": "26.15.5",
    "x-request-device": "macintosh|chrome|153.0.0.0",
    "x-request-osversion": "mac|mac-os-x-15",
  };
}

type ItemGrade = { date?: string; avios?: number; lock?: boolean };
type RespostaGrade = {
  outbound?: { availabilityCalendar?: ItemGrade[] };
  errors?: { code?: string; reason?: string }[];
};

function corpoGrade(params: ParametrosIberia, data: string) {
  return {
    isPetFlight: false,
    slices: [{ origin: params.origem.toUpperCase(), destination: params.destino.toUpperCase(), date: data }],
    passengers: [{ passengerType: "ADULT", count: String(params.passageiros) }],
    marketCode: MERCADO,
    preferredCabin: "",
    maxSearchTime: DIAS_A_COBRIR,
  };
}

// O `ibisservices.iberia.com` exige `authorization: Bearer` — é token que o SPA
// guarda em memória, não cookie, então o fetch de dentro da página não o herda
// sozinho (voltava 401). Em vez de forjar token, escuta o que a própria página
// manda: a tela de resultados chama `/availability` ao carregar, e é de lá que
// o valor sai. Nada é impresso nem gravado.
const tokenPorPagina = new WeakMap<Page, string>();

function observarAutorizacao(page: Page): () => string | null {
  page.on("request", (req) => {
    if (!/ibisservices\.iberia\.com/.test(req.url())) return;
    const cabecalhos = req.headers();
    const auth = cabecalhos["authorization"] ?? cabecalhos["Authorization"];
    if (auth) tokenPorPagina.set(page, auth);
  });
  return () => tokenPorPagina.get(page) ?? null;
}

// O último token que a página usou. Serve pra segunda camada (detalhe de voos)
// aproveitar a mesma sessão sem reabrir a busca.
export function obterAutorizacao(page: Page): string | null {
  return tokenPorPagina.get(page) ?? null;
}

// A tela de resultados é rota por hash e demora a assentar: checar uma vez logo
// depois do load pega estado intermediário. Espera virar uma conclusão.
async function esperarTelaAssentar(page: Page) {
  const limite = Date.now() + 30_000;
  while (
    Date.now() < limite &&
    !/#!\/(availability|ibbkerror)/.test(page.url()) &&
    !/login\.iberia\.com/.test(page.url())
  ) {
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);
}

// Login automático com o que está no .env. As credenciais nunca são impressas
// nem gravadas — só preenchidas no formulário do próprio site.
async function fazerLogin(page: Page, onLog: OnLog) {
  const email = process.env.IBERIA_EMAIL;
  const senha = process.env.IBERIA_SENHA;
  if (!email || !senha) {
    throw new Error(
      "A Iberia pediu login e não há IBERIA_EMAIL/IBERIA_SENHA no .env. " +
        "Preencha lá, ou rode `npx tsx scripts/recon-iberia.ts GRU MAD` e faça o login na janela.",
    );
  }

  onLog("A sessão caiu; logando de novo.");
  const SELETOR_EMAIL =
    'input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]';

  let onde: Page | import("playwright").Frame | null = null;
  const limite = Date.now() + 25_000;
  while (!onde && Date.now() < limite) {
    for (const ctx of [page, ...page.frames()]) {
      if (await ctx.locator(SELETOR_EMAIL).first().isVisible().catch(() => false)) {
        onde = ctx;
        break;
      }
    }
    if (!onde) await page.waitForTimeout(1500);
  }
  if (!onde) throw new Error("A tela de login apareceu, mas não achei o campo de e-mail em nenhum frame.");

  // Preencher e conferir, não preencher e torcer: o formulário do login é
  // Visualforce e se re-renderiza depois de carregar, apagando o que já tinha
  // sido escrito. O sintoma é cruel — volta a tela de login limpa, sem erro
  // nenhum, como se a senha estivesse errada.
  const escrever = async (campo: import("playwright").Locator, valor: string, rotulo: string) => {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      await campo.fill(valor).catch(() => {});
      await page.waitForTimeout(600);
      const ficou = await campo.inputValue().catch(() => "");
      if (ficou.length === valor.length) return true;
      onLog(`o campo de ${rotulo} não segurou o valor (tentativa ${tentativa}); reescrevendo.`);
      await campo.click({ timeout: 5000 }).catch(() => {});
      await campo.type(valor, { delay: 60 }).catch(() => {});
      await page.waitForTimeout(600);
      if ((await campo.inputValue().catch(() => "")).length === valor.length) return true;
    }
    return false;
  };

  const campoEmail = onde.locator(SELETOR_EMAIL).first();
  if (!(await escrever(campoEmail, email, "e-mail"))) {
    throw new Error("O campo de e-mail do login não aceitou o valor — a página deve estar se re-renderizando.");
  }
  const campoSenha = onde.locator('input[type="password"]').first();
  if (!(await campoSenha.isVisible().catch(() => false))) {
    await enviarLogin(onde);
    await campoSenha.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  }
  if (!(await campoSenha.isVisible().catch(() => false))) {
    throw new Error("O campo de senha não apareceu na tela de login da Iberia.");
  }
  if (!(await escrever(campoSenha, senha, "senha"))) {
    throw new Error("O campo de senha do login não aceitou o valor.");
  }
  // Última conferência antes de enviar: se algum campo esvaziou entre uma coisa
  // e outra, enviar agora só devolveria a tela limpa de novo.
  const emailOk = (await campoEmail.inputValue().catch(() => "")).length === email.length;
  const senhaOk = (await campoSenha.inputValue().catch(() => "")).length === senha.length;
  if (!emailOk || !senhaOk) {
    throw new Error(
      `Os campos do login esvaziaram antes do envio (e-mail ${emailOk ? "ok" : "vazio"}, senha ${senhaOk ? "ok" : "vazia"}).`,
    );
  }
  if (!(await enviarLogin(onde))) throw new Error("Não achei o botão de enviar na tela de login da Iberia.");

  const fim = Date.now() + 90_000;
  while (Date.now() < fim && /login\.iberia\.com/.test(page.url())) await page.waitForTimeout(2000);
  if (/login\.iberia\.com/.test(page.url())) {
    throw new Error("O login foi enviado mas a Iberia continuou na tela de login (2FA ou captcha?).");
  }
  onLog("Login refeito.");
}

async function enviarLogin(onde: Page | import("playwright").Frame): Promise<boolean> {
  for (const seletor of [
    'input[name="loginPage:theForm:loginSubmit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Fazer login")',
    'button:has-text("Continuar")',
  ]) {
    const botao = onde.locator(seletor).first();
    if (!(await botao.isVisible().catch(() => false))) continue;
    await botao.click({ timeout: 10_000 }).catch(() => {});
    return true;
  }
  return false;
}

async function abrirPaginaDeResultados(page: Page, params: ParametrosIberia, data: string, onLog: OnLog) {
  const url = linkEmissaoIberia(params, data);
  onLog(`Abrindo busca em Avios ${params.origem} → ${params.destino}...`);
  // O site reescreve a URL durante a navegação (rota por hash), e o Playwright
  // relata isso como ERR_ABORTED mesmo quando a página carrega. Quem decide se
  // deu certo é a URL final, logo abaixo — não o resultado do goto.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch((erro: Error) => {
    if (!/ERR_ABORTED/.test(erro.message)) throw erro;
  });

  await esperarTelaAssentar(page);

  // A URL carrega de volta o que o site entendeu. Conferir aqui é o que impede
  // a fonte de varrer um aeroporto que ninguém pediu: numa execução do recon a
  // busca saiu pra Madison (MSN) no lugar de Madrid (MAD) e a tela respondeu
  // "sem assentos", que parece resposta legítima.
  const urlFinal = page.url();
  for (const [campo, esperado] of [
    ["BEGIN_CITY_01", params.origem.toUpperCase()],
    ["END_CITY_01", params.destino.toUpperCase()],
  ] as const) {
    const obtido = new RegExp(`${campo}=([A-Z]{3})`).exec(urlFinal)?.[1];
    if (obtido && obtido !== esperado) {
      throw new Error(`A Iberia abriu a busca com ${campo}=${obtido} em vez de ${esperado}.`);
    }
  }

  // A sessão da Iberia no perfil cai em minutos, então cair no login é rotina,
  // não exceção: a fonte loga e repete a busca. Sem credencial no .env não há
  // o que fazer sozinho, e aí o erro diz exatamente isso.
  if (/login\.iberia\.com/.test(page.url())) {
    await fazerLogin(page, onLog);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch((erro: Error) => {
      if (!/ERR_ABORTED/.test(erro.message)) throw erro;
    });
    await esperarTelaAssentar(page);
    if (/login\.iberia\.com/.test(page.url())) {
      throw new Error("Mesmo depois de logar, a Iberia devolveu a busca pro login.");
    }
  }

  if (/ibbkerror/.test(urlFinal)) {
    throw new Error(
      "A Iberia respondeu com a tela de erro ('não podemos mostrar os voos'). " +
        "Costuma ser corte por frequência: espere alguns minutos ou aumente IBERIA_INTERVALO_BUSCAS_MS.",
    );
  }
}

async function buscarGrade(
  page: Page,
  params: ParametrosIberia,
  data: string,
  autorizacao: string,
): Promise<{ dias: DiaIberia[]; ultimaData: string | null; travados: number }> {
  const resposta = await page.evaluate(
    async ({ corpo, cabecalhos }) => {
      try {
        const res = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/calendar/grid", {
          method: "POST",
          headers: cabecalhos,
          body: JSON.stringify(corpo),
          credentials: "include",
        });
        return { status: res.status, texto: await res.text() };
      } catch (erro) {
        return { status: -1, texto: String(erro) };
      }
    },
    { corpo: corpoGrade(params, data), cabecalhos: cabecalhosIberia(autorizacao, "calendar") },
  );

  if (resposta.status === 401 || resposta.status === 403) {
    throw new Error(
      `A Iberia recusou a autorização (${resposta.status}). A sessão do perfil do Chrome provavelmente caiu — ` +
        "rode `npx tsx scripts/recon-iberia.ts GRU MAD` uma vez pra logar de novo.",
    );
  }

  // Status -1 é o terceiro estado: a requisição não voltou. Nunca vira "sem
  // disponibilidade" — é falha de busca e sobe como erro.
  if (resposta.status === -1) {
    throw new Error(`A chamada do calendário não chegou a responder (${resposta.texto.slice(0, 120)}).`);
  }
  if (resposta.status === 404) {
    // O 404 aqui é semântico ("Disponibilidade não encontrada"), não rota errada.
    return { dias: [], ultimaData: null, travados: 0 };
  }
  if (resposta.status !== 200) {
    throw new Error(`O calendário respondeu ${resposta.status} (a partir de ${data}).`);
  }

  let corpo: RespostaGrade;
  try {
    corpo = JSON.parse(resposta.texto) as RespostaGrade;
  } catch {
    throw new Error(`O calendário devolveu algo que não é JSON (a partir de ${data}).`);
  }

  const calendario = corpo.outbound?.availabilityCalendar;
  if (!calendario) {
    // Campo esperado ausente é erro nomeado, nunca lista vazia silenciosa.
    throw new Error(
      `A resposta do calendário não trouxe 'outbound.availabilityCalendar' (a partir de ${data}). ` +
        `Início do corpo: ${resposta.texto.slice(0, 200)}`,
    );
  }

  const dias: DiaIberia[] = [];
  let travados = 0;
  let ultimaData: string | null = null;

  for (const item of calendario) {
    if (!item.date) continue;
    if (!ultimaData || item.date > ultimaData) ultimaData = item.date;
    if (typeof item.avios !== "number") continue; // sem prêmio nesse dia
    if (item.lock === true) {
      // `lock: true` só apareceu depois, e o significado não foi confirmado.
      // O dia fica de fora — mas só conta como perda quando ele TINHA preço:
      // dia travado e sem `avios` não é prêmio nenhum, e declarar a varredura
      // parcial por causa dele seria ruído em cima de nada.
      travados++;
      continue;
    }
    dias.push({ data: item.date, avios: item.avios });
  }

  return { dias, ultimaData, travados };
}

export async function pesquisarAnoIberia(
  page: Page,
  params: ParametrosIberia,
  onLog: OnLog = () => {},
  onProgresso: OnProgresso = () => {},
  _onAviso: OnAviso = () => {},
  deveParar: DeveParar = () => false,
): Promise<ResultadoIberia> {
  const primeiraData = daquiA(1);
  const limiteHorizonte = daquiA(DIAS_A_COBRIR);

  observarAutorizacao(page);
  const lerAutorizacao = () => obterAutorizacao(page);
  try {
    await limitadorIberia.aguardarVez();
    await abrirPaginaDeResultados(page, params, primeiraData, onLog);
  } catch (erro) {
    return { tipo: "erro", motivo: erro instanceof Error ? erro.message : String(erro) };
  }

  const autorizacao = lerAutorizacao();
  if (!autorizacao) {
    return {
      tipo: "erro",
      motivo:
        "A página de resultados não fez nenhuma chamada com Authorization — sem o token do próprio site " +
        "a busca não sai. Verifique se a sessão da Iberia Club ainda está válida no perfil do Chrome.",
    };
  }
  onProgresso(0.15);

  const porData = new Map<string, DiaIberia>();
  let travadosTotal = 0;
  let cursor = primeiraData;
  let alcance: string | null = null;
  let motivoParcial: string | null = null;

  for (let chamada = 1; chamada <= MAX_CHAMADAS_GRADE; chamada++) {
    if (deveParar()) {
      motivoParcial = "busca cancelada pela tela";
      break;
    }

    let resultado: Awaited<ReturnType<typeof buscarGrade>>;
    try {
      await garantirNaBusca(page, params, cursor, onLog);
      await limitadorIberia.aguardarVez();
      resultado = await buscarGrade(page, params, cursor, lerAutorizacao() ?? autorizacao);
    } catch (erro) {
      motivoParcial = erro instanceof Error ? erro.message : String(erro);
      onLog(`Calendário falhou a partir de ${cursor}: ${motivoParcial}`);
      break;
    }

    for (const dia of resultado.dias) porData.set(dia.data, dia);
    travadosTotal += resultado.travados;
    onLog(
      `Calendário a partir de ${cursor}: ${resultado.dias.length} dia(s) com prêmio` +
        (resultado.ultimaData ? `, cobrindo até ${resultado.ultimaData}.` : "."),
    );

    // A janela não avançou: insistir só repetiria a mesma resposta. É também o
    // sinal de que o `date` do corpo não move o início da grade.
    if (!resultado.ultimaData || (alcance && resultado.ultimaData <= alcance)) {
      if (chamada > 1) onLog("A grade não avançou além do que já veio; encerrando a varredura.");
      alcance = resultado.ultimaData ?? alcance;
      break;
    }
    alcance = resultado.ultimaData;
    onProgresso(0.15 + 0.85 * (chamada / MAX_CHAMADAS_GRADE));

    if (alcance >= limiteHorizonte) break;

    const seguinte = new Date(`${alcance}T00:00:00`);
    seguinte.setDate(seguinte.getDate() + 1);
    cursor = dataISO(seguinte);
  }

  onProgresso(1);

  const janela = { de: primeiraData, ate: alcance ?? primeiraData };
  const dias = [...porData.values()].sort((a, b) => a.data.localeCompare(b.data));

  if (travadosTotal > 0) {
    motivoParcial = `${travadosTotal} dia(s) tinham preço mas vieram com lock e ficaram de fora` +
      (motivoParcial ? `; ${motivoParcial}` : "");
  }

  if (motivoParcial) return { tipo: "parcial", dias, janela, motivo: motivoParcial };
  if (dias.length === 0) return { tipo: "sem_disponibilidade", janela };
  return { tipo: "ok", dias, janela };
}

// Teto em Avios absolutos (ex.: 40000); dias mais caros ficam de fora.
export function construirRelatorioIberia(
  dias: DiaIberia[],
  tetoAvios: number | null,
  params?: ParametrosIberia,
): SecaoRelatorio {
  const aceitos = dias.filter((d) => tetoAvios == null || d.avios <= tetoAvios);

  if (aceitos.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const diasFormatados = aceitos.map((d) => ({
    data: d.data,
    valorK: Math.round(d.avios / 10) / 100, // 28150 -> 28.15
    ...(params ? { link: linkEmissaoIberia(params, d.data) } : {}),
  }));
  const valores = diasFormatados.map((d) => d.valorK);

  return {
    menor: Math.min(...valores),
    maior: Math.max(...valores),
    dias: diasFormatados,
    texto: formatarListaPorMes(diasFormatados.map((d) => d.data)),
  };
}

// ── Por que esta fonte não traz vagas ──────────────────────────────────────
//
// O `/availability` traz `remainingSeats` por oferta, mas NENHUM preço; a grade
// traz o preço do dia, mas não diz de qual voo ele é. Juntar os dois exigiria
// supor que o preço da grade é o do voo com mais vagas — e anunciar as vagas de
// um voo com o preço de outro é a mentira que `construirRelatorioSmiles` evita
// de propósito. Enquanto não houver como ligar preço e voo pelo dado, o texto
// sai só com as datas, como já acontece na AA.

// ── Segunda camada: voos do dia ───────────────────────────────────────────
//
// A grade diz QUAIS dias têm prêmio e por quanto. Ela não diz nada sobre o voo
// — e o voo importa: na primeira busca real de GRU→MAD, os 9 itinerários do dia
// tinham escala, todos via Casablanca na Royal Air Maroc, com durações de 14h a
// 29h. É o `/availability` que conta isso.
//
// Custa uma requisição por data, então só roda nos dias que interessam.

export type VooIberia = {
  data: string; // YYYY-MM-DD da partida
  partidaHora: string; // HH:MM
  chegadaData: string;
  chegadaHora: string;
  origem: string;
  destino: string;
  escalas: number;
  aeroportosConexao: string; // "CMN, BCN"
  duracaoMinutos: number;
  cabines: string; // "ECONOMY" ou "ECONOMY, BUSINESS"
  companhias: string; // "AT, IB"
  classesServico: string; // rbd por segmento
  aeronaves: string;
  assentos: number | null; // menor do itinerário: o gargalo é quem manda
  tarifa: string; // fareBasis
};

export type FiltrosVoo = {
  maxEscalas?: number | null;
  maxDuracaoMinutos?: number | null;
  companhias?: string[] | null; // códigos IATA aceitos, ex.: ["IB","I2","VY"]
  // `bookingClass` das ofertas: ECONOMY, BUSINESS, PREMIUMTOURIST, FIRST.
  // Só existe neste nível — o calendário que gera as datas não tem cabine.
  cabines?: string[] | null;
};

type OfertaCrua = { bookingClass?: string; rbd?: string; remainingSeats?: number; fareBasis?: string };
type SegmentoCru = {
  departureDateTime?: string;
  arrivalDateTime?: string;
  departure?: { airport?: { code?: string } };
  arrival?: { airport?: { code?: string } };
  flight?: { operationalCarrier?: { code?: string }; aircraft?: { description?: string } };
  offers?: OfertaCrua[];
};
type SliceCru = {
  departureDateTime?: string;
  arrivalDateTime?: string;
  stopsNumber?: number;
  duration?: number;
  segments?: SegmentoCru[];
};
type RespostaDisponibilidade = {
  originDestinations?: { origin?: string; destination?: string; slices?: SliceCru[] }[];
};

const unicos = (valores: (string | undefined)[]) => [...new Set(valores.filter(Boolean) as string[])];

export async function buscarVoosDoDia(
  page: Page,
  params: ParametrosIberia,
  data: string,
  autorizacao: string,
): Promise<VooIberia[]> {
  const corpo = {
    isPetFlight: false,
    slices: [{ origin: params.origem.toUpperCase(), destination: params.destino.toUpperCase(), date: data }],
    passengers: [{ passengerType: "ADULT", count: String(params.passageiros) }],
    marketCode: MERCADO,
    preferredCabin: "",
  };

  // De dentro da página, como o calendário. Tentar pelo `context.request` do
  // Playwright parecia mais robusto (não depende de onde a aba está), mas o
  // `/availability` devolve 401 por ali mesmo com o mesmo bearer e os mesmos
  // headers que o calendário aceita — alguma coisa da sessão só existe no
  // contexto da aba. Quem garante que a aba está no lugar certo é o
  // `garantirNaBusca`, que reloga quando precisa.
  const resposta = await page.evaluate(
    async ({ corpo, cabecalhos }) => {
      try {
        const res = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability", {
          method: "POST",
          headers: cabecalhos,
          body: JSON.stringify(corpo),
          credentials: "include",
        });
        return { status: res.status, texto: await res.text() };
      } catch (erro) {
        return { status: -1, texto: String(erro) };
      }
    },
    { corpo, cabecalhos: cabecalhosIberia(autorizacao, "availability") },
  );

  // 204 é "não tem voo nesse dia" — estado legítimo, lista vazia.
  if (resposta.status === 204) return [];
  // -1 é "a requisição não voltou". Vira erro: confundir com 204 mandaria
  // "sem disponibilidade" pro cliente numa busca que nem saiu.
  if (resposta.status === -1) {
    // Onde a página estava importa: "Failed to fetch" com a aba numa tela de
    // erro é outra história de "Failed to fetch" com a busca aberta.
    throw new Error(
      `A disponibilidade de ${data} não chegou a responder (${resposta.texto.slice(0, 100)}). ` +
        `A aba estava em ${page.url().slice(0, 120)}`,
    );
  }
  if (resposta.status === 401 || resposta.status === 403) {
    throw new Error(`A Iberia recusou a autorização em ${data} (${resposta.status}).`);
  }
  if (resposta.status !== 200) {
    throw new Error(`A disponibilidade de ${data} respondeu ${resposta.status}.`);
  }

  return lerVoos(resposta.texto, data);
}

// Exportado pra poder ser conferido contra os fixtures sem tocar no site.
export function lerVoos(texto: string, data: string): VooIberia[] {
  let corpoLido: RespostaDisponibilidade;
  try {
    corpoLido = JSON.parse(texto) as RespostaDisponibilidade;
  } catch {
    throw new Error(`A disponibilidade de ${data} devolveu algo que não é JSON.`);
  }
  if (!corpoLido.originDestinations) {
    throw new Error(`A resposta de ${data} não trouxe 'originDestinations'.`);
  }

  const voos: VooIberia[] = [];
  for (const od of corpoLido.originDestinations) {
    for (const trecho of od.slices ?? []) {
      const segmentos = trecho.segments ?? [];
      if (segmentos.length === 0) continue;

      const [partidaData = "", partidaHora = ""] = (trecho.departureDateTime ?? "").split(" ");
      const [chegadaData = "", chegadaHora = ""] = (trecho.arrivalDateTime ?? "").split(" ");

      const ofertas = segmentos.flatMap((s) => s.offers ?? []);
      const assentos = ofertas.map((o) => o.remainingSeats).filter((n): n is number => typeof n === "number");

      voos.push({
        data: partidaData,
        partidaHora,
        chegadaData,
        chegadaHora,
        origem: segmentos[0]!.departure?.airport?.code ?? od.origin ?? "",
        destino: segmentos[segmentos.length - 1]!.arrival?.airport?.code ?? od.destination ?? "",
        escalas: trecho.stopsNumber ?? segmentos.length - 1,
        // Conexão é a chegada de cada segmento menos o último — o destino final
        // não é escala.
        aeroportosConexao: segmentos
          .slice(0, -1)
          .map((s) => s.arrival?.airport?.code)
          .filter(Boolean)
          .join(", "),
        duracaoMinutos: trecho.duration ?? 0,
        cabines: unicos(ofertas.map((o) => o.bookingClass)).join(", "),
        companhias: unicos(segmentos.map((s) => s.flight?.operationalCarrier?.code)).join(", "),
        classesServico: unicos(ofertas.map((o) => o.rbd)).join(", "),
        aeronaves: unicos(segmentos.map((s) => s.flight?.aircraft?.description)).join(", "),
        // O gargalo do itinerário: de nada adianta 8 lugares na primeira perna
        // se a segunda só tem 2.
        assentos: assentos.length > 0 ? Math.min(...assentos) : null,
        tarifa: unicos(ofertas.map((o) => o.fareBasis)).join(", "),
      });
    }
  }
  return voos;
}

// A disponibilidade exige conta logada; o calendário não. Como a sessão da
// Iberia cai em minutos, dá pra estar "meio dentro": a grade responde 200 e o
// `/availability` da própria página responde 401 — inclusive quando é o site
// que faz a chamada. Por isso o detalhe confere o login ANTES, em vez de
// esperar o site redirecionar (nesse caminho ele não redireciona, só nega).
//
// O teste é o mais direto que existe: abrir a página de login. Se o formulário
// aparecer, não estamos logados; se a Iberia nos tirar de lá, estamos.
export async function garantirLogado(page: Page, onLog: OnLog): Promise<void> {
  await page
    .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch((erro: Error) => {
      if (!/ERR_ABORTED/.test(erro.message)) throw erro;
    });
  await page.waitForTimeout(4000);

  if (!/login\.iberia\.com/.test(page.url())) {
    onLog("Sessão da Iberia Club já válida.");
    return;
  }
  const temFormulario = await page
    .locator('input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]')
    .first()
    .isVisible()
    .catch(() => false);
  if (!temFormulario) {
    onLog("Sessão da Iberia Club já válida.");
    return;
  }
  await fazerLogin(page, onLog);
}

// A Iberia redireciona a aba sozinha pra uma página de re-autorização do
// `login.iberia.com` no meio da varredura. Com a origem trocada, o fetch pro
// `ibisservices` vira cross-origin e o navegador corta ("Failed to fetch") —
// o que parecia bloqueio da fonte e não era. Reabrir a busca resolve.
async function garantirNaBusca(page: Page, params: ParametrosIberia, data: string, onLog: OnLog) {
  if (/^https:\/\/www\.iberia\.com\/flights\//.test(page.url())) return;
  onLog("A aba saiu da página de busca; reabrindo antes de continuar.");
  await abrirPaginaDeResultados(page, params, data, onLog);
}

export function filtrarVoos(voos: VooIberia[], filtros: FiltrosVoo): VooIberia[] {
  return voos.filter((v) => {
    if (filtros.maxEscalas != null && v.escalas > filtros.maxEscalas) return false;
    if (filtros.maxDuracaoMinutos != null && v.duracaoMinutos > filtros.maxDuracaoMinutos) return false;
    if (filtros.companhias?.length) {
      const doVoo = v.companhias.split(", ").filter(Boolean);
      if (!doVoo.every((c) => filtros.companhias!.includes(c))) return false;
    }
    if (filtros.cabines?.length) {
      // Basta UMA oferta na cabine pedida: o itinerário serve se dá pra emitir
      // naquela classe, mesmo que também tenha outras.
      const doVoo = v.cabines.split(", ").filter(Boolean);
      if (!doVoo.some((c) => filtros.cabines!.includes(c))) return false;
    }
    return true;
  });
}

export type DiaComFalha = { data: string; erro: string };

// Detalha os dias pedidos em lotes paralelos de `/availability`, de dentro da
// aba e na sessão em que o calendário acabou de rodar — o ritmo do
// `cheap-flights`, mas pelo navegador. Medido com
// `scripts/medir-lotes-iberia.ts`: 30 de uma vez são cortados na hora
// ("Failed to fetch" em todas), lotes de 10 em sequência perdem dias já no
// segundo lote, e lotes de 5 a cada 8s são cortados de vez por volta do dia
// 40. Por isso o padrão é 1: sequencial, sem rajada. O limitador segura a
// distância entre LOTES, não entre requisições.
//
// Um lote com falha é repetido uma vez depois de reabrir a busca (a sessão cai
// em minutos e reabrir reloga). Um lote que falha INTEIRO duas vezes é corte
// do site: insistir só prolonga o bloqueio, então o resto vira falha declarada
// e a busca sai parcial.
export async function detalharDias(
  page: Page,
  params: ParametrosIberia,
  datas: string[],
  onLog: OnLog = () => {},
  onProgresso: OnProgresso = () => {},
  deveParar: DeveParar = () => false,
): Promise<{ voos: VooIberia[]; diasComFalha: DiaComFalha[] }> {
  const voos: VooIberia[] = [];
  const diasComFalha: DiaComFalha[] = [];
  if (datas.length === 0) return { voos, diasComFalha };

  // Sem conta logada, TODA chamada de disponibilidade volta 401: conferir uma
  // vez antes poupa a varredura inteira de falhar dia a dia.
  try {
    await garantirLogado(page, onLog);
    await abrirPaginaDeResultados(page, params, datas[0]!, onLog);
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    onLog(`Não consegui abrir a busca logada da Iberia: ${motivo}`);
    return { voos, diasComFalha: datas.map((data) => ({ data, erro: motivo })) };
  }

  const consultarLote = async (lote: string[]) => {
    await garantirNaBusca(page, params, lote[0]!, onLog);
    await limitadorIberia.aguardarVez();
    const autorizacao = obterAutorizacao(page);
    if (!autorizacao) throw new Error("a página de busca não fez nenhuma chamada com Authorization");
    return Promise.all(
      lote.map(async (data) => {
        try {
          return { data, voos: await buscarVoosDoDia(page, params, data, autorizacao) };
        } catch (erro) {
          return { data, erro: erro instanceof Error ? erro.message : String(erro) };
        }
      }),
    );
  };

  for (let i = 0; i < datas.length; i += TAMANHO_LOTE_DETALHE) {
    if (deveParar()) {
      onLog("Detalhamento cancelado; devolvendo os dias já consultados.");
      break;
    }
    const lote = datas.slice(i, i + TAMANHO_LOTE_DETALHE);
    let pendentes = lote;
    for (let tentativa = 1; tentativa <= 2 && pendentes.length > 0; tentativa++) {
      if (tentativa === 2) {
        onLog(`${pendentes.length} dia(s) do lote falharam; reabrindo a busca e tentando de novo.`);
        await page.waitForTimeout(PAUSA_APOS_FALHA_MS);
        try {
          await abrirPaginaDeResultados(page, params, pendentes[0]!, onLog);
        } catch (erro) {
          onLog(`Reabrir a busca falhou: ${erro instanceof Error ? erro.message : String(erro)}`);
        }
      }
      const resultados = await consultarLote(pendentes).catch((erro: unknown) =>
        pendentes.map((data) => ({ data, erro: erro instanceof Error ? erro.message : String(erro) })),
      );
      pendentes = [];
      for (const r of resultados) {
        if ("voos" in r) {
          voos.push(...r.voos);
        } else if (tentativa === 2) {
          diasComFalha.push({ data: r.data, erro: r.erro });
        } else {
          pendentes.push(r.data);
        }
      }
      if (tentativa === 2 && resultados.every((r) => "erro" in r)) {
        const motivo = `a Iberia cortou as consultas (lote inteiro falhou duas vezes: ${diasComFalha.at(-1)!.erro.slice(0, 100)})`;
        onLog(`Parando o detalhe: ${motivo}`);
        for (const data of datas.slice(i + TAMANHO_LOTE_DETALHE)) diasComFalha.push({ data, erro: motivo });
        return { voos, diasComFalha };
      }
    }
    const feitos = Math.min(i + TAMANHO_LOTE_DETALHE, datas.length);
    onLog(`Detalhe: ${feitos} de ${datas.length} dia(s) consultados.`);
    onProgresso(feitos / datas.length);
  }

  return { voos, diasComFalha };
}
