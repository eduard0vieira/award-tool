import "dotenv/config";
import type { Page } from "playwright";
import { abrirSessaoChrome, type SessaoChrome } from "./sessao-chrome.ts";
import {
  LimitadorFrequencia,
  formatarListaPorMes,
  type OnAviso,
  type OnLog,
  type OnProgresso,
  type SecaoRelatorio,
} from "./comum.ts";

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
export type ConfirmacaoMilhas = {
  data: string;
  milhas: number;
  taxas: number; // em reais
  voo: string; // ex.: "LA8060 · 06:30 GRU → 09:40 LIM · Direto"
  imagem: string; // caminho do print
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
  onLog(`Buscando ${origem} ⇄ ${destino} — ${chamadas} chamadas cobrem ${MESES_A_VARRER} meses.`);

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
        onLog(`${falhasSeguidas} chamadas seguidas falharam — parando e devolvendo o que já veio.`);
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

export async function confirmarEmMilhas(
  page: Page,
  params: { origem: string; destino: string; data: string; caminhoImagem: string },
  onLog: OnLog = () => {},
): Promise<ConfirmacaoMilhas | null> {
  const { origem, destino, data, caminhoImagem } = params;

  let resposta: OfertaCrua | undefined;
  const capturar = async (res: import("playwright").Response) => {
    if (!res.url().includes("/offers/search/redemption") || res.status() !== 200) return;
    try {
      resposta = (await res.json()) as OfertaCrua;
    } catch {
      /* ignora */
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
        outbound: `${data}T12:00:00.000Z`,
        adt: "1",
        chd: "0",
        inf: "0",
        trip: "OW",
        cabin: "Economy",
        redemption: "true",
        sort: "RECOMMENDED",
      }).toString();

    onLog(`Confirmando em milhas: ${origem} → ${destino} em ${data}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (/login|iniciar sesi|entrar/i.test(new URL(page.url()).hostname)) {
      throw new Error(
        "A LATAM pediu login pra busca em milhas. Rode `bash scripts/importar-cookies.sh latamairlines.com` " +
          "com a janela do bot fechada e tente de novo.",
      );
    }

    // Espera os voos aparecerem (é o mesmo sinal que o JSON chegou).
    await page.locator('[data-testid^="wrapper-card-flight-"]').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);

    const voos: NonNullable<OfertaCrua["content"]> = resposta?.content ?? [];
    if (voos.length === 0) {
      onLog(`Sem oferta em milhas para ${data}.`);
      return null;
    }

    // O mais barato em milhas do dia.
    const melhor = voos.reduce((a, b) =>
      (a.summary?.lowestPrice?.amount ?? Infinity) <= (b.summary?.lowestPrice?.amount ?? Infinity) ? a : b,
    );
    const milhas = melhor.summary?.lowestPrice?.amount ?? 0;
    const taxas = melhor.newPrices?.[0]?.taxes ?? melhor.newPrices?.[0]?.total ?? 0;
    const hora = (iso?: string) => (iso ? iso.slice(11, 16) : "--:--");
    const paradas = melhor.summary?.stopOvers ?? 0;
    const voo =
      `${melhor.summary?.flightCode ?? ""} · ${hora(melhor.summary?.origin?.departure)} ${origem}` +
      ` → ${hora(melhor.summary?.destination?.arrival)} ${destino}` +
      ` · ${paradas === 0 ? "Direto" : `${paradas} parada(s)`}`;

    // Print só do primeiro cartão de voo — é o que interessa pro alerta.
    const cartao = page.locator('[data-testid^="wrapper-card-flight-"]').first();
    await cartao.screenshot({ path: caminhoImagem });

    onLog(`${data}: ${milhas.toLocaleString("pt-BR")} milhas + R$ ${taxas} (${voo}).`);
    return { data, milhas, taxas, voo, imagem: caminhoImagem };
  } finally {
    page.off("response", capturar);
  }
}

// A partir dos dias do calendário, escolhe o melhor par ida/volta dentro da
// faixa "menor + margem" (padrão R$ 100, como combinado): o dia mais barato de
// cada direção, com a volta caindo depois da ida.
export function escolherMelhorPar(
  ida: DiaLatam[],
  volta: DiaLatam[],
  margemReais = 100,
): { ida: DiaLatam; volta: DiaLatam } | null {
  if (ida.length === 0 || volta.length === 0) return null;

  const naFaixa = (dias: DiaLatam[]) => {
    const menor = Math.min(...dias.map((d) => d.valor));
    return dias.filter((d) => d.valor <= menor + margemReais);
  };

  const idaCandidatos = naFaixa(ida).sort((a, b) => a.valor - b.valor || a.data.localeCompare(b.data));
  const voltaCandidatos = naFaixa(volta).sort((a, b) => a.valor - b.valor || a.data.localeCompare(b.data));

  for (const i of idaCandidatos) {
    const v = voltaCandidatos.find((x) => x.data > i.data);
    if (v) return { ida: i, volta: v };
  }
  return null;
}
