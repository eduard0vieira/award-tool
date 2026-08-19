import "dotenv/config";
import type { Page } from "playwright";
import { abrirSessaoChrome, type SessaoChrome } from "../../nucleo/sessao-chrome.ts";
import {
  LimitadorFrequencia,
  formatarListaPorMes,
  type OnAviso,
  type OnLog,
  type OnProgresso,
  type SecaoRelatorio,
} from "../../nucleo/comum.ts";

// Bot da LATAM (latamairlines.com/br/pt), tarifas em dinheiro, classe
// Econômica, sem login.
//
// Como funciona (levantado no recon — ver notas-recon-latam.md):
// - O calendário de tarifas da home vem de
//   GET /bff/web-products-searchbox/v1/calendar?...&extended=true
//   e é generoso: UMA resposta traz DOIS meses e AS DUAS DIREÇÕES, com o preço
//   de cada dia. Um ano inteiro sai em ~6 chamadas (contra ~12 da AA e ~11 da
//   TAP), cobrindo ida e volta de uma vez.
// - Atenção: existe um /bff/air-offers/v2/calendar parecido que devolve sempre
//   vazio. Não é ele.
// - As chamadas precisam dos cabeçalhos x-latam-* (sem eles: 400) e têm que
//   sair de dentro da página (fetch via page.evaluate), como na AA.
// - O próprio site marca os dias mais baratos com `lowPrice: true` — é o
//   destaque verde da interface, e sai de graça no JSON.

export type SessaoLatam = SessaoChrome;

export type ParametrosLatam = {
  origem: string; // IATA
  destino: string; // IATA
};

export type DiaLatam = {
  data: string; // YYYY-MM-DD
  valor: number; // em reais
  menorTarifa: boolean; // lowPrice do site (destaque de "Menor tarifa")
};

export type MesComFalha = { mes: string; erro: string };
export type ResultadoAnoLatam = {
  ida: DiaLatam[];
  volta: DiaLatam[];
  mesesComFalha: MesComFalha[];
};

// Confirmação em milhas de um dia específico (ver confirmarEmMilhas).
// As quatro linhas da tela "Combine suas milhas + dinheiro". É uma ESCADA, não
// um preço: da opção 1 (tudo em milhas) até a 4 (mínimo de milhas, máximo de
// dinheiro). Guardar só uma escolheria pelo cliente sem dizer.
export type OpcaoResgate = {
  id: number;
  milhas: number;
  // O que a LATAM mostra é `dinheiro + taxa` — conferido nas quatro linhas do
  // recon (469,56 + 255,69 = 725,25, e assim por diante). `totalReais` é esse
  // número; `dinheiroReais` é a parte que troca milhas por dinheiro.
  dinheiroReais: number;
  totalReais: number;
};

export type ConfirmacaoPar = {
  // Preenchidos pelo servidor com o formatador comum: é o que o gerador de
  // alertas parseia ("Out 2026: 31").
  textoIda?: string;
  textoVolta?: string;
  origem: string;
  destino: string;
  dataIda: string;
  dataVolta: string;
  vooIda: string;
  vooVolta: string;
  taxaReais: number;
  opcoes: OpcaoResgate[];
  imagem: string;
};

export type TetosLatam = {
  tetoReais?: number | null; // dias mais caros que isso ficam de fora
  somenteMenorTarifa?: boolean; // só os dias que o site marca como menor tarifa
};

const INTERVALO_MIN_LATAM_MS = Number(process.env.LATAM_INTERVALO_BUSCAS_MS) || 8000;
const limitadorLatam = new LimitadorFrequencia(INTERVALO_MIN_LATAM_MS);

// Cada resposta cobre 2 meses, então 6 chamadas dão os 12 meses.
const MESES_A_VARRER = 12;
const MESES_POR_CHAMADA = 2;
const MAX_FALHAS_SEGUIDAS = 3;

export async function iniciarSessaoLatam(headless = false): Promise<SessaoLatam> {
  const sessao = await abrirSessaoChrome(headless, "LATAM");

  // Precisa estar num contexto latamairlines.com pro fetch in-page valer, e o
  // acesso à home também aquece os cookies.
  await sessao.page.goto("https://www.latamairlines.com/br/pt", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sessao.page.waitForTimeout(4000);

  if (/challenge|denied|acesso negado/i.test(await sessao.page.title())) {
    throw new Error(
      "A LATAM bloqueou o acesso. Rode `npm run chrome` e, se persistir, " +
        "`bash scripts/importar-cookies.sh latamairlines.com` antes de tentar de novo.",
    );
  }

  return sessao;
}

type DiaCru = {
  date: string;
  fare: { amount: number; roundedAmount: number | null; currency: string } | null;
  enabled: boolean;
  lowPrice: boolean;
};

type CalendarioCru = {
  month: string; // "2026-09"
  direction: "OUTBOUND" | "INBOUND";
  detailsCalendar?: DiaCru[];
};

type RespostaCalendario = { days?: { calendar?: CalendarioCru[] }[] };

// Uma chamada do calendário: devolve os dias de 2 meses, já separados por
// direção. `mes` é 1-12.
async function buscarCalendario(
  page: Page,
  params: ParametrosLatam,
  mes: number,
  ano: number,
): Promise<{ ida: DiaLatam[]; volta: DiaLatam[] }> {
  const qs = new URLSearchParams({
    origin: params.origem,
    destination: params.destino,
    month: String(mes),
    year: String(ano),
    isRoundTrip: "true",
    extended: "true", // sem isso a resposta vem sem preços
  });

  const resultado = await page.evaluate(async (qs) => {
    const res = await fetch(`/bff/web-products-searchbox/v1/calendar?${qs}`, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-latam-application-country": "br",
        "x-latam-application-oc": "br",
        "x-latam-application-lang": "pt",
        "x-latam-application-name": "xp-web-products-searchbox-lib",
        "x-latam-client-name": "xp-web-products-searchbox-lib",
        "x-latam-request-id": crypto.randomUUID(),
        "x-latam-app-session-id": crypto.randomUUID(),
        "x-latam-track-id": crypto.randomUUID(),
      },
    });
    return { status: res.status, texto: await res.text() };
  }, qs.toString());

  if (resultado.status !== 200) {
    throw new Error(`Calendário respondeu com status ${resultado.status} (${mes}/${ano}).`);
  }

  let corpo: RespostaCalendario;
  try {
    corpo = JSON.parse(resultado.texto) as RespostaCalendario;
  } catch {
    throw new Error(`Calendário devolveu resposta que não é JSON (${mes}/${ano}).`);
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const ida: DiaLatam[] = [];
  const volta: DiaLatam[] = [];

  for (const bloco of corpo.days ?? []) {
    for (const cal of bloco.calendar ?? []) {
      const destino = cal.direction === "INBOUND" ? volta : ida;
      for (const dia of cal.detailsCalendar ?? []) {
        if (!dia.enabled || !dia.fare || dia.date <= hoje) continue;
        destino.push({ data: dia.date, valor: dia.fare.amount, menorTarifa: Boolean(dia.lowPrice) });
      }
    }
  }
  return { ida, volta };
}

export async function pesquisarAnoLatam(
  page: Page,
  params: ParametrosLatam,
  onLog: OnLog = () => {},
  onProgresso: OnProgresso = () => {},
  onAviso: OnAviso = () => {},
): Promise<ResultadoAnoLatam> {
  const origem = params.origem.toUpperCase();
  const destino = params.destino.toUpperCase();
  const norm = { origem, destino };

  const ida: DiaLatam[] = [];
  const volta: DiaLatam[] = [];
  const mesesComFalha: MesComFalha[] = [];
  let falhasSeguidas = 0;

  const hoje = new Date();
  const chamadas = Math.ceil(MESES_A_VARRER / MESES_POR_CHAMADA);
  onLog(`Buscando ${origem} ⇄ ${destino}. ${chamadas} chamadas cobrem ${MESES_A_VARRER} meses.`);

  for (let i = 0; i < chamadas; i++) {
    const alvo = new Date(hoje.getFullYear(), hoje.getMonth() + i * MESES_POR_CHAMADA, 1);
    const mes = alvo.getMonth() + 1;
    const ano = alvo.getFullYear();
    const rotulo = `${String(mes).padStart(2, "0")}/${ano}`;

    await limitadorLatam.aguardarVez();
    // Cadência menos robótica entre as chamadas.
    await page.waitForTimeout(400 + Math.random() * 1200);

    try {
      const { ida: novosIda, volta: novosVolta } = await buscarCalendario(page, norm, mes, ano);
      ida.push(...novosIda);
      volta.push(...novosVolta);
      onLog(`${rotulo} (+1 mês): ${novosIda.length} dia(s) de ida, ${novosVolta.length} de volta.`);
      falhasSeguidas = 0;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      mesesComFalha.push({ mes: rotulo, erro: mensagem });
      onLog(`Falha em ${rotulo}: ${mensagem}`);
      falhasSeguidas++;
      if (falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
        onAviso("");
        onLog(`${falhasSeguidas} chamadas seguidas falharam. Parando e devolvendo o que já veio.`);
        break;
      }
    }

    onProgresso((i + 1) / chamadas);
  }

  // A resposta de um mês se sobrepõe à do anterior (cada chamada traz 2 meses),
  // então o mesmo dia chega duas vezes — fica o menor valor.
  const dedup = (dias: DiaLatam[]) => {
    const porData = new Map<string, DiaLatam>();
    for (const d of dias) {
      const atual = porData.get(d.data);
      if (!atual || d.valor < atual.valor) porData.set(d.data, d);
    }
    return [...porData.values()].sort((a, b) => a.data.localeCompare(b.data));
  };

  onProgresso(1);
  return { ida: dedup(ida), volta: dedup(volta), mesesComFalha };
}

export function construirRelatorioLatam(dias: DiaLatam[], tetos: TetosLatam = {}): SecaoRelatorio {
  const aceitos = dias.filter((d) => {
    if (tetos.somenteMenorTarifa && !d.menorTarifa) return false;
    return tetos.tetoReais == null || d.valor <= tetos.tetoReais;
  });

  if (aceitos.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma tarifa encontrada nesse período." };
  }

  const diasFormatados = aceitos.map((d) => ({ data: d.data, valorK: Math.round(d.valor) }));
  const valores = diasFormatados.map((d) => d.valorK);

  return {
    menor: Math.min(...valores),
    maior: Math.max(...valores),
    dias: diasFormatados,
    texto: formatarListaPorMes(diasFormatados.map((d) => d.data)),
    unidade: "BRL",
  };
}


// ─── Confirmação em milhas ────────────────────────────────────────────────
//
// O calendário só existe em reais, então o valor em milhas de um dia só sai
// fazendo a busca daquele dia. Aqui é uma busca de IDA SIMPLES por perna (em
// vez de ida e volta): assim as duas pernas aparecem em telas próprias, cada
// uma com seu print, sem precisar selecionar voo nenhum — nada de avançar em
// fluxo de reserva.
//
// Exige sessão logada (anônimo, a LATAM manda pro login em modo milhas):
// `bash scripts/importar-cookies.sh latamairlines.com`.

type OfertaCrua = {
  content?: {
    summary?: {
      flightCode?: string;
      stopOvers?: number;
      lowestPrice?: { currency?: string; amount?: number };
      origin?: { departure?: string; iataCode?: string };
      destination?: { arrival?: string; iataCode?: string };
    };
    newPrices?: { total?: number; taxes?: number }[];
  }[];
};

// A resposta que carrega o preço do PAR. Campo ausente aqui é erro, não zero:
// um par que "custa 0 milhas" viraria alerta e chegaria no cliente.
type RespostaResgate = {
  tax?: { amount?: number; currency?: string };
  redemptionOptions?: { id?: number; totalValueToPay?: { loyalty?: { amount?: number }; money?: { amount?: number } } }[];
};

export class ErroCampoLatam extends Error {
  constructor(campo: string) {
    super(`A LATAM respondeu sem "${campo}". O formato mudou. O parser precisa ser conferido antes de confiar no número.`);
    this.name = "ErroCampoLatam";
  }
}

function exigirNumero(valor: unknown, campo: string): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) throw new ErroCampoLatam(campo);
  return valor;
}

// Traduz a resposta crua na escada de opções. Sem default em campo nenhum.
export function lerOpcoesResgate(corpo: unknown): { taxaReais: number; opcoes: OpcaoResgate[] } {
  const r = corpo as RespostaResgate;
  const taxaReais = exigirNumero(r?.tax?.amount, "tax.amount");
  const cruas = r?.redemptionOptions;
  if (!Array.isArray(cruas) || cruas.length === 0) throw new ErroCampoLatam("redemptionOptions");

  const opcoes = cruas.map((o, i) => {
    const milhas = exigirNumero(o?.totalValueToPay?.loyalty?.amount, `redemptionOptions[${i}].loyalty.amount`);
    const dinheiroReais = exigirNumero(o?.totalValueToPay?.money?.amount, `redemptionOptions[${i}].money.amount`);
    return {
      id: exigirNumero(o?.id, `redemptionOptions[${i}].id`),
      milhas,
      dinheiroReais,
      totalReais: Number((dinheiroReais + taxaReais).toFixed(2)),
    };
  });
  // Da mais milhas pra menos milhas, que é a ordem em que a LATAM mostra.
  opcoes.sort((a, b) => b.milhas - a.milhas);
  return { taxaReais, opcoes };
}

// A busca em milhas exige sessão logada. Quando a sessão cai, o caminho é
// entrar na JANELA DO BOT (que está aberta e visível) — o login fica salvo no
// perfil e vale pras próximas buscas.
//
// Se LATAM_EMAIL e LATAM_SENHA estiverem no .env, o bot adianta o preenchimento
// dos dois campos; o código de verificação (e qualquer captcha) é sempre com
// você. Se o formulário mudar e o preenchimento não pegar, isso NÃO é erro:
// o bot avisa e espera você terminar na mão. Nada de senha aparece em log.
const ESPERA_LOGIN_MS = Number(process.env.LATAM_ESPERA_LOGIN_MS) || 300_000;

export function pedindoLogin(page: Page): boolean {
  const url = page.url();
  return /login|iniciar-sesion|signin|sign-in/i.test(url);
}

async function preencherCredenciais(page: Page, onLog: OnLog): Promise<void> {
  const email = process.env.LATAM_EMAIL;
  const senha = process.env.LATAM_SENHA;
  if (!email || !senha) {
    onLog("Sem LATAM_EMAIL/LATAM_SENHA no .env. O login é todo manual na janela do bot.");
    return;
  }

  try {
    const campoEmail = page.locator('input[type="email"], input[name="email"], #email').first();
    const campoSenha = page.locator('input[type="password"]').first();
    await campoEmail.waitFor({ state: "visible", timeout: 15000 });
    await campoEmail.fill(email);
    // A LATAM às vezes pede a senha só na tela seguinte; se não estiver aqui,
    // deixa o resto com o usuário em vez de insistir num seletor que mudou.
    if (await campoSenha.isVisible().catch(() => false)) {
      await campoSenha.fill(senha);
    }
    onLog("Login da LATAM: e-mail (e senha, se o campo estava na tela) preenchidos. Confirme na janela do bot.");
  } catch (err) {
    const motivo = err instanceof Error ? err.message.split("\n")[0] : String(err);
    onLog(`Preenchimento automático do login falhou (${motivo}). Conclua na janela do bot.`);
  }
}

export async function esperarLoginManual(page: Page, onLog: OnLog, onAviso: OnAviso): Promise<void> {
  await page.bringToFront().catch(() => {});
  await preencherCredenciais(page, onLog);

  const minutos = Math.round(ESPERA_LOGIN_MS / 60000);
  const aviso =
    `A LATAM pediu login. Entre na janela do Chrome do bot que está aberta (é a que o bot usa); ` +
    `assim que a sessão voltar, a busca continua sozinha. Tempo limite: ${minutos} min.`;
  onAviso(aviso);
  onLog(aviso);

  const limite = Date.now() + ESPERA_LOGIN_MS;
  while (Date.now() < limite) {
    await page.waitForTimeout(2000);
    if (!pedindoLogin(page)) {
      onAviso("");
      onLog("Login concluído. Retomando a busca em milhas.");
      return;
    }
  }

  onAviso("");
  throw new Error(
    `A LATAM continuou pedindo login por ${minutos} min. Faça o login na janela do bot e rode a busca de novo ` +
      "(o login fica salvo no perfil, então isso não deve se repetir a cada busca).",
  );
}

// Confirma o preço de um PAR ida e volta — que é diferente de somar as duas
// pernas. Medido: GRU→JNB perna a perna deu 243.535 milhas; o mesmo par
// comprado junto sai por 90.302. A LATAM precifica o par, e esse número só
// existe depois de escolher um voo de ida E um de volta.
//
// O caminho é dirigir o site: deep link ida e volta → escolhe a ida → escolhe a
// volta → a tela "Combine suas milhas + dinheiro". O preço vem da resposta de
// `/offers/redemption-options`, não do HTML.
export async function confirmarParEmMilhas(
  page: Page,
  params: { origem: string; destino: string; dataIda: string; dataVolta: string; caminhoImagem: string },
  onLog: OnLog = () => {},
  onAviso: OnAviso = () => {},
): Promise<ConfirmacaoPar | null> {
  const { origem, destino, dataIda, dataVolta, caminhoImagem } = params;

  let opcoesCruas: unknown;
  let buscaIda: OfertaCrua | undefined;
  let buscaVolta: OfertaCrua | undefined;

  const capturar = async (res: import("playwright").Response) => {
    const url = res.url();
    if (res.status() !== 200) return;
    try {
      if (url.includes("/offers/redemption-options")) {
        opcoesCruas = await res.json();
      } else if (url.includes("/offers/search/redemption")) {
        // A segunda busca vem com `outOfferId`: é a volta, já precificada em
        // função da ida escolhida.
        const corpo = (await res.json()) as OfertaCrua;
        if (url.includes("outOfferId=") && !url.includes("outOfferId=null")) buscaVolta = corpo;
        else buscaIda = corpo;
      }
    } catch {
      /* resposta não-JSON: os campos exigidos cobram isso depois */
    }
  };
  page.on("response", capturar);

  try {
    await limitadorLatam.aguardarVez();
    const url =
      "https://www.latamairlines.com/br/pt/oferta-voos?" +
      new URLSearchParams({
        origin: origem,
        destination: destino,
        outbound: `${dataIda}T12:00:00.000Z`,
        inbound: `${dataVolta}T12:00:00.000Z`,
        adt: "1",
        chd: "0",
        inf: "0",
        trip: "RT",
        cabin: "Economy",
        redemption: "true",
        sort: "RECOMMENDED",
      }).toString();

    onLog(`Confirmando o par em milhas: ${origem} ⇄ ${destino} · ${dataIda} → ${dataVolta}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

    if (pedindoLogin(page)) {
      await esperarLoginManual(page, onLog, onAviso);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (pedindoLogin(page)) {
        throw new Error("A LATAM voltou para a tela de entrada mesmo após o login. Refaça a busca.");
      }
    }

    if (!(await escolherPrimeiroVoo(page, "ida", onLog))) {
      onLog(`Sem voo em milhas na ida de ${dataIda}.`);
      return null;
    }
    if (!(await escolherPrimeiroVoo(page, "volta", onLog))) {
      onLog(`Sem voo em milhas na volta de ${dataVolta}.`);
      return null;
    }

    // A tela das combinações carrega depois da segunda escolha.
    await esperarPor(() => opcoesCruas !== undefined, 30_000, page);
    if (opcoesCruas === undefined) {
      throw new Error(
        "Fluxo concluído sem as combinações de milhas+dinheiro na resposta da LATAM. " +
          "Rode `npm run recon:latam` para inspecionar onde o fluxo parou.",
      );
    }

    const { taxaReais, opcoes } = lerOpcoesResgate(opcoesCruas);

    let imagem = "";
    const tamanhoOriginal = page.viewportSize();
    try {
      // `fullPage` sozinho não resolve aqui: nesta tela a rolagem é de um
      // container interno, então a altura do documento é a da janela e o print
      // sai só do pedaço visível (foi o que gerou a tira de 38px). O jeito que
      // pega ida, volta e as combinações juntas é abrir a janela alta o
      // bastante pra tudo caber sem rolagem.
      await page.setViewportSize({ width: tamanhoOriginal?.width ?? 1280, height: 2000 });
      await page.evaluate("window.scrollTo(0, 0)");
      await page.waitForTimeout(1200);
      await page.screenshot({ path: caminhoImagem, fullPage: true });
      imagem = caminhoImagem;
    } catch (err) {
      // O preço é o dado essencial; a imagem não. Falta de print vira aviso.
      onLog(`Captura do print do par falhou: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (tamanhoOriginal) await page.setViewportSize(tamanhoOriginal).catch(() => {});
    }

    const melhor = opcoes[0]!;
    onLog(
      `${dataIda} → ${dataVolta}: ${melhor.milhas.toLocaleString("pt-BR")} milhas + R$ ${melhor.totalReais.toFixed(2)} ` +
        `(${opcoes.length} combinações).`,
    );

    return {
      origem,
      destino,
      dataIda,
      dataVolta,
      vooIda: descreverPrimeiroVoo(buscaIda, origem, destino),
      vooVolta: descreverPrimeiroVoo(buscaVolta, destino, origem),
      taxaReais,
      opcoes,
      imagem,
    };
  } finally {
    page.off("response", capturar);
  }
}

// O voo que foi escolhido é sempre o primeiro cartão — é nele que clicamos.
function descreverPrimeiroVoo(busca: OfertaCrua | undefined, de: string, para: string): string {
  const voo = busca?.content?.[0]?.summary;
  if (!voo) return "";
  const hora = (iso?: string) => (iso ? iso.slice(11, 16) : "--:--");
  const paradas = voo.stopOvers ?? 0;
  return (
    `${voo.flightCode ?? ""} · ${hora(voo.origin?.departure)} ${de} → ${hora(voo.destination?.arrival)} ${para}` +
    ` · ${paradas === 0 ? "Direto" : `${paradas} parada(s)`}`
  );
}

// Cada perna pede duas escolhas: o voo e, no painel que abre em seguida, a
// tarifa (Light/Plus/Top). Pega sempre a primeira das duas — a escolha de tarifa
// não muda a escada de milhas, que é o que interessa aqui.
async function escolherPrimeiroVoo(page: Page, qual: string, onLog: OnLog): Promise<boolean> {
  const cartao = page.locator('[data-testid^="wrapper-card-flight-"]').first();
  try {
    await cartao.waitFor({ timeout: 60_000 });
  } catch {
    onLog(`  (nenhum voo apareceu na ${qual})`);
    return false;
  }
  await page.waitForTimeout(2000);
  await cartao.click({ timeout: 15_000 });
  await page.waitForTimeout(2500);

  const alvos = [
    '[data-testid*="fare-selection"] button',
    'button[data-testid*="select"]',
    "button:has-text('Escolher')",
    "button:has-text('Selecionar')",
  ];
  for (const sel of alvos) {
    const botao = page.locator(sel).first();
    if ((await botao.count()) > 0 && (await botao.isVisible().catch(() => false))) {
      await botao.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }
  // Sem painel de tarifa o clique no cartão já basta.
  return true;
}

async function esperarPor(pronto: () => boolean, limiteMs: number, page: Page) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim && !pronto()) await page.waitForTimeout(500);
}

// A partir dos dias do calendário, escolhe os melhores pares ida/volta dentro
// da faixa "menor + margem", com a volta sempre depois da ida. A margem é
// separada por direção porque a volta costuma sair mais cara — R$ 100 na ida e
// R$ 300 na volta, como combinado.
//
// Devolve VÁRIOS pares porque o preço do calendário é em dinheiro e o preço em
// milhas do par só aparece na confirmação: o par mais barato em reais não é
// necessariamente o mais barato em milhas. Cada data entra em um par só, pra
// dar três opções de fato diferentes em vez de três variações do mesmo dia.
export function escolherMelhoresPares(
  ida: DiaLatam[],
  volta: DiaLatam[],
  quantos = 3,
  margemIdaReais = 100,
  margemVoltaReais = 300,
): { ida: DiaLatam; volta: DiaLatam }[] {
  if (ida.length === 0 || volta.length === 0 || quantos < 1) return [];

  const naFaixa = (dias: DiaLatam[], margemReais: number) => {
    const menor = Math.min(...dias.map((d) => d.valor));
    return dias
      .filter((d) => d.valor <= menor + margemReais)
      .sort((a, b) => a.valor - b.valor || a.data.localeCompare(b.data));
  };

  const idaCandidatos = naFaixa(ida, margemIdaReais);
  const voltaCandidatos = naFaixa(volta, margemVoltaReais);

  const pares: { ida: DiaLatam; volta: DiaLatam }[] = [];
  const voltasUsadas = new Set<string>();

  for (const i of idaCandidatos) {
    if (pares.length >= quantos) break;
    const v = voltaCandidatos.find((x) => x.data > i.data && !voltasUsadas.has(x.data));
    if (!v) continue;
    voltasUsadas.add(v.data);
    pares.push({ ida: i, volta: v });
  }
  return pares;
}

// Um par só — o que o servidor usava antes de passar a confirmar três.
export function escolherMelhorPar(
  ida: DiaLatam[],
  volta: DiaLatam[],
  margemIdaReais = 100,
  margemVoltaReais = 300,
): { ida: DiaLatam; volta: DiaLatam } | null {
  return escolherMelhoresPares(ida, volta, 1, margemIdaReais, margemVoltaReais)[0] ?? null;
}
