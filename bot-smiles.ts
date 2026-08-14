import "dotenv/config";
import type { Page } from "playwright";
import { abrirSessaoChrome, type SessaoChrome } from "./sessao-chrome.ts";
import { LimitadorFrequencia, formatarListaPorMes, type OnLog, type SecaoRelatorio } from "./comum.ts";

// Bot do Smiles (GOL) — busca de disponibilidade em milhas, sem login.
//
// Como o acesso funciona (levantado no recon, ver scripts/recon-smiles.ts):
// - A API responde 406 pra requisição feita de fora do navegador, em qualquer
//   ambiente (prd/green/blue), e responde 406 até pro Chrome real quando a URL
//   é aberta como navegação comum.
// - O que passa é `fetch` disparado de DENTRO de uma página na PRÓPRIA ORIGEM
//   da API: abrir `api-air-flightsearch-prd.smiles.com.br/` e chamar de lá.
//   Assim a requisição sai com TLS de Chrome, com os cookies que a visita à
//   raiz plantou e com cara de XHR em vez de navegação.
// - Não serve chamar de www.smiles.com.br: a API está em outro subdomínio,
//   então o navegador exige CORS e barra a leitura.
// - Perfil descartável basta (não precisa de reputação nem cookie importado).
//
// Uma resposta cobre até 7 dias: o dia pedido, detalhado voo a voo, mais os 3
// dias antes e os 3 depois em `calendarDayList` (só o menor valor em milhas).
// ATENÇÃO pra fase de varredura: esse calendário NEM SEMPRE vem — em rota
// atendida só por parceiras (ex.: GRU→SCL, tudo AMADEUS) ele volta vazio,
// mesmo com dezenas de voos na lista. Quem varrer o ano não pode contar com os
// 7 dias; tem que checar e cair pra dia a dia quando não vier.

export type SessaoSmiles = SessaoChrome;

const HOST_API = "https://api-air-flightsearch-prd.smiles.com.br";

// Chave de cliente do aplicativo — identificador público de app, não
// credencial de conta. Nenhum login entra nesta fonte.
const HEADERS_APP: Record<string, string> = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "APP",
  accept: "application/json, text/plain, */*",
  "user-agent": "ios - com.br.smiles/1.107.0",
  "accept-language": "pt-BR,pt;q=0.9",
};

const INTERVALO_MIN_SMILES_MS = Number(process.env.SMILES_INTERVALO_BUSCAS_MS) || 4000;
export const limitadorSmiles = new LimitadorFrequencia(INTERVALO_MIN_SMILES_MS);

export type CabineSmiles = "economica" | "premium" | "executiva";

export const CABINE_SMILES_LABEL: Record<CabineSmiles, string> = {
  economica: "Econômica",
  premium: "Conforto",
  executiva: "Executiva",
};

// Valor do campo `cabin` na resposta → cabine nossa.
const CABINE_POR_CODIGO: Record<string, CabineSmiles> = {
  ECONOMIC: "economica",
  PREMIUM_ECONOMIC: "premium",
  COMFORT: "premium",
  BUSINESS: "executiva",
  FIRST_CLASS: "executiva",
};

export type ParametrosSmiles = {
  origem: string; // IATA
  destino: string; // IATA
};

export type VooSmiles = {
  cabine: CabineSmiles;
  conexoes: number;
  assentos: number;
  // Tarifa SMILES_CLUB (assinante do Clube) — é o número de capa. Além de ser
  // o que vocês anunciam, é o mesmo tipo de tarifa que o `calendarDayList`
  // reporta, então o calendário e o detalhe falam a mesma moeda.
  milhas: number;
  // Qual tarifa virou `milhas`. Quase sempre SMILES_CLUB; cai pra SMILES
  // quando aquele voo não tem tarifa de Clube — e aí fica registrado, em vez
  // de o número mudar de significado sem ninguém saber.
  tarifa: "SMILES_CLUB" | "SMILES";
  milhasSemClube: number | null;
  // Null é ausência REAL, não default: só voo operado pela GOL (sourceGDS
  // "G3") traz a taxa neste endpoint; em voo de parceira (AMADEUS) o objeto
  // `g3` vem vazio. Preencher com 0 seria anunciar "sem taxa" pra um voo que
  // tem taxa — o erro que derrubou o projeto anterior.
  taxaReais: number | null;
  companhia: string;
  origemDados: string; // sourceGDS: "G3" (GOL) ou o GDS da parceira
};

export type DiaCalendarioSmiles = { data: string; milhas: number };

export type RespostaSmiles = {
  data: string; // dia pedido (YYYY-MM-DD)
  voos: VooSmiles[];
  // Os 3 dias antes e os 3 depois, com o menor valor de cada um. Vem na mesma
  // resposta — é o que deixa a varredura de um ano custar ~52 chamadas em vez
  // de 365.
  calendario: DiaCalendarioSmiles[];
};

// Ausência de campo é erro nomeado, nunca default silencioso: foi exatamente
// assim que o projeto anterior (Python) passou a anunciar "4 assentos" pra
// tudo, sem ninguém perceber.
class ErroCampoSmiles extends Error {
  constructor(campo: string, contexto: string) {
    super(`Resposta do Smiles sem o campo "${campo}" (${contexto}). O formato da API pode ter mudado.`);
  }
}

function exigirNumero(valor: unknown, campo: string, contexto: string): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) throw new ErroCampoSmiles(campo, contexto);
  return valor;
}

function exigirTexto(valor: unknown, campo: string, contexto: string): string {
  if (typeof valor !== "string" || valor === "") throw new ErroCampoSmiles(campo, contexto);
  return valor;
}

export async function iniciarSessaoSmiles(headless = false): Promise<SessaoSmiles> {
  const sessao = await abrirSessaoChrome(headless, "Smiles");

  // A raiz da API responde 406 como documento — e tudo bem: o que importa é a
  // página ficar NA ORIGEM da API (é de lá que o fetch pode sair) e os cookies
  // da visita ficarem no contexto.
  await sessao.page.goto(`${HOST_API}/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sessao.page.waitForTimeout(3000);

  return sessao;
}

function urlBusca(params: ParametrosSmiles, data: string): string {
  const query = new URLSearchParams({
    originAirportCode: params.origem.toUpperCase(),
    destinationAirportCode: params.destino.toUpperCase(),
    departureDate: data,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `${HOST_API}/v1/airlines/search?${query}`;
}

type TarifaCrua = { type?: unknown; miles?: unknown; money?: unknown; g3?: { costTax?: unknown } };
type VooCru = {
  cabin?: unknown;
  sourceGDS?: unknown;
  stops?: unknown;
  availableSeats?: unknown;
  airline?: { name?: unknown };
  fareList?: TarifaCrua[];
};
type RespostaCrua = {
  requestedFlightSegmentList?: {
    flightList?: VooCru[];
    calendarDayList?: { date?: unknown; miles?: unknown }[];
  }[];
};

// Cabines novas não derrubam a busca, mas também não passam batido: entram
// aqui e são avisadas uma vez por processo.
const cabinesDesconhecidas = new Set<string>();

function extrairVoo(cru: VooCru, data: string, onLog: OnLog): VooSmiles | null {
  const codigoCabine = exigirTexto(cru.cabin, "cabin", `voo em ${data}`);
  const cabine = CABINE_POR_CODIGO[codigoCabine];
  if (!cabine) {
    if (!cabinesDesconhecidas.has(codigoCabine)) {
      cabinesDesconhecidas.add(codigoCabine);
      onLog(`Atenção: cabine "${codigoCabine}" não mapeada no Smiles — os voos dela ficam fora do relatório.`);
    }
    return null;
  }

  const tarifas = cru.fareList;
  if (!Array.isArray(tarifas)) throw new ErroCampoSmiles("fareList", `voo em ${data}`);

  // Só tarifa de milhas puras interessa: SMILES_MONEY mistura milhas e
  // dinheiro (não dá pra comparar com teto em milhas) e MONEY é só dinheiro.
  const smiles = tarifas.find((t) => t.type === "SMILES");
  const clube = tarifas.find((t) => t.type === "SMILES_CLUB");
  const escolhida = clube ?? smiles;
  if (!escolhida) return null; // voo sem tarifa em milhas pura: não é disponibilidade pra nós

  const contexto = `voo ${cabine} em ${data}`;
  const origemDados = exigirTexto(cru.sourceGDS, "sourceGDS", contexto);
  const tarifa = clube ? "SMILES_CLUB" : "SMILES";

  return {
    cabine,
    conexoes: exigirNumero(cru.stops, "stops", contexto),
    assentos: exigirNumero(cru.availableSeats, "availableSeats", contexto),
    milhas: exigirNumero(escolhida.miles, `fareList[${tarifa}].miles`, contexto),
    tarifa,
    milhasSemClube: typeof smiles?.miles === "number" ? smiles.miles : null,
    taxaReais: taxaDe(escolhida, origemDados, contexto, onLog),
    companhia: exigirTexto(cru.airline?.name, "airline.name", contexto),
    origemDados,
  };
}

// Voo da GOL SEMPRE traz a taxa; se um dia parar de trazer, é mudança de
// formato e precisa aparecer — por isso o aviso. Voo de parceira nunca traz,
// e isso é normal.
let jaAvisouTaxaGol = false;
function taxaDe(smiles: TarifaCrua, origemDados: string, contexto: string, onLog: OnLog): number | null {
  const bruto = smiles.g3?.costTax;
  if (typeof bruto === "string" && bruto !== "") {
    const numero = Number(bruto);
    if (!Number.isFinite(numero)) throw new ErroCampoSmiles("fareList[SMILES].g3.costTax", contexto);
    return numero;
  }
  if (origemDados === "G3" && !jaAvisouTaxaGol) {
    jaAvisouTaxaGol = true;
    onLog(`Atenção: voo da GOL sem g3.costTax (${contexto}) — o formato da API pode ter mudado.`);
  }
  return null;
}

export async function buscarDiaSmiles(
  page: Page,
  params: ParametrosSmiles,
  data: string,
  onLog: OnLog = () => {},
): Promise<RespostaSmiles> {
  await limitadorSmiles.aguardarVez();

  const resultado = await page.evaluate(
    async ({ url, headers }) => {
      const res = await fetch(url, { headers });
      return { status: res.status, texto: await res.text() };
    },
    { url: urlBusca(params, data), headers: HEADERS_APP },
  );

  if (resultado.status === 452) {
    // Código próprio deles pra aeroporto inválido — vale mensagem específica,
    // senão vira "erro 452" e o usuário não descobre que errou a sigla.
    throw new Error(
      `O Smiles não reconheceu um dos aeroportos de ${params.origem.toUpperCase()} → ${params.destino.toUpperCase()}. ` +
        "Confira as siglas IATA.",
    );
  }
  if (resultado.status !== 200) {
    throw new Error(
      `O Smiles respondeu ${resultado.status} para ${data}. ` +
        (resultado.status === 406
          ? "É o bloqueio: a chamada precisa sair de uma página na origem da API (ver iniciarSessaoSmiles)."
          : resultado.texto.slice(0, 200)),
    );
  }

  let corpo: RespostaCrua;
  try {
    corpo = JSON.parse(resultado.texto) as RespostaCrua;
  } catch {
    throw new Error(`O Smiles devolveu uma resposta que não é JSON para ${data}.`);
  }

  const segmento = corpo.requestedFlightSegmentList?.[0];
  if (!segmento) {
    // Sem segmento nenhum = rota sem resultado nesse dia. É resposta legítima,
    // não erro — mas devolvida vazia de forma explícita.
    return { data, voos: [], calendario: [] };
  }

  const voos: VooSmiles[] = [];
  for (const cru of segmento.flightList ?? []) {
    const voo = extrairVoo(cru, data, onLog);
    if (voo) voos.push(voo);
  }

  const calendario: DiaCalendarioSmiles[] = [];
  for (const dia of segmento.calendarDayList ?? []) {
    calendario.push({
      data: exigirTexto(dia.date, "calendarDayList[].date", `calendário de ${data}`),
      milhas: exigirNumero(dia.miles, "calendarDayList[].miles", `calendário de ${data}`),
    });
  }

  return { data, voos, calendario };
}

// ── Fase 2: varredura de um ano ───────────────────────────────────────────
//
// A varredura é em duas etapas, pelo mesmo motivo da LATAM: sondar barato,
// detalhar só o que interessa.
//
// 1. AMOSTRAGEM (~52 chamadas): pede um dia a cada 7. Cada resposta traz, de
//    graça, o menor valor dos 3 dias antes e dos 3 depois — então esses 52
//    pedidos cobrem o ano inteiro de valores mínimos.
// 2. DETALHE: só os dias que passaram no teto ganham uma chamada própria, que
//    é o que traz cabine e assentos (o calendário não traz nenhum dos dois).
//
// O calendário reporta a tarifa SMILES_CLUB, que é a mesma que usamos como
// número de capa — então comparar teto com calendário é comparar igual com
// igual, sem risco de descartar um dia por olhar a moeda errada.
//
// Quando o calendário não vem (rota só de parceiras), a etapa 1 não cobre
// nada e a varredura cai pra dia a dia dentro de um limite — sempre dizendo
// quanto ficou de fora, nunca cortando calado.

export type TetosSmiles = {
  economica?: number | null;
  premium?: number | null;
  executiva?: number | null;
};

export type DiaComFalhaSmiles = { data: string; erro: string };

export type ResultadoAnoSmiles = {
  dias: RespostaSmiles[];
  diasComFalha: DiaComFalhaSmiles[];
  // O que a varredura NÃO cobriu, em português, pra virar aviso na tela.
  // Vazio = cobertura completa do período.
  lacunas: string[];
};

const DIAS_A_VARRER = Number(process.env.SMILES_DIAS_VARREDURA) || 365;
const PASSO_AMOSTRAGEM = 7; // o calendário cobre ±3 dias
const MAX_DETALHES = Number(process.env.SMILES_MAX_DETALHES) || 60;
const MAX_FALHAS_SEGUIDAS = 3;

function somarDias(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function hojeMais(dias: number): string {
  return somarDias(new Date().toISOString().slice(0, 10), dias);
}

function tetoMaximo(tetos: TetosSmiles): number | null {
  const valores = [tetos.economica, tetos.premium, tetos.executiva].filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  return valores.length > 0 ? Math.max(...valores) : null;
}

export async function pesquisarAnoSmiles(
  page: Page,
  params: ParametrosSmiles,
  tetos: TetosSmiles,
  onLog: OnLog = () => {},
  onProgresso: (fracao: number) => void = () => {},
): Promise<ResultadoAnoSmiles> {
  const inicio = hojeMais(1);
  const fim = hojeMais(DIAS_A_VARRER);
  const teto = tetoMaximo(tetos);

  const dias: RespostaSmiles[] = [];
  const diasComFalha: DiaComFalhaSmiles[] = [];
  const lacunas: string[] = [];
  const jaBuscados = new Set<string>();
  // menor valor conhecido por dia, vindo do calendário
  const calendario = new Map<string, number>();

  const buscar = async (data: string): Promise<RespostaSmiles | null> => {
    if (jaBuscados.has(data)) return null;
    jaBuscados.add(data);
    try {
      const resposta = await buscarDiaSmiles(page, params, data, onLog);
      dias.push(resposta);
      for (const c of resposta.calendario) {
        const atual = calendario.get(c.data);
        if (atual == null || c.milhas < atual) calendario.set(c.data, c.milhas);
      }
      return resposta;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      diasComFalha.push({ data, erro: mensagem });
      onLog(`Falha em ${data}: ${mensagem}`);
      return null;
    }
  };

  // ── Etapa 1: amostragem de 7 em 7 dias
  const amostras: string[] = [];
  for (let d = inicio; d <= fim; d = somarDias(d, PASSO_AMOSTRAGEM)) amostras.push(d);

  onLog(
    `Varrendo ${params.origem.toUpperCase()} → ${params.destino.toUpperCase()}: ` +
      `${amostras.length} sondagens cobrem ${DIAS_A_VARRER} dias.`,
  );

  let falhasSeguidas = 0;
  for (let i = 0; i < amostras.length; i++) {
    const resposta = await buscar(amostras[i]!);
    if (resposta) {
      falhasSeguidas = 0;
    } else if (++falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
      const restantes = amostras.length - i - 1;
      onLog(`${falhasSeguidas} sondagens seguidas falharam — parando com o que já veio.`);
      if (restantes > 0) lacunas.push(`a varredura parou cedo: ${restantes} sondagem(ns) do período não chegaram a ser feitas`);
      break;
    }
    onProgresso(0.6 * ((i + 1) / amostras.length));
  }

  // ── Etapa 2: detalhar os dias promissores
  const semCalendario = calendario.size === 0;
  if (semCalendario) {
    // Rota sem calendário (costuma ser rota só de parceiras): não há sonda
    // barata pra dizer quais dias valem a pena, então o jeito é preencher os
    // buracos entre as amostras, dia a dia, até o limite — e dizer em voz alta
    // o que sobrou de fora.
    onLog("Esta rota não devolve calendário — preenchendo os dias entre as sondagens, um a um.");
    const faltando: string[] = [];
    for (let d = inicio; d <= fim; d = somarDias(d, 1)) {
      if (!jaBuscados.has(d)) faltando.push(d);
    }

    const aBuscar = faltando.slice(0, MAX_DETALHES);
    const cortados = faltando.length - aBuscar.length;
    if (cortados > 0) {
      lacunas.push(
        `esta rota não devolve o calendário de 7 dias, então cada dia custa uma consulta; ` +
          `${cortados} dia(s) do período ficaram sem verificação (limite de ${MAX_DETALHES} por busca)`,
      );
    }

    for (let i = 0; i < aBuscar.length; i++) {
      await buscar(aBuscar[i]!);
      onProgresso(0.6 + 0.4 * ((i + 1) / aBuscar.length));
    }
  } else {
    const candidatos = Array.from(calendario.entries())
      .filter(([data]) => data >= inicio && data <= fim && !jaBuscados.has(data))
      .filter(([, milhas]) => teto == null || milhas <= teto)
      .sort((a, b) => a[1] - b[1]); // mais baratos primeiro

    const escolhidos = candidatos.slice(0, MAX_DETALHES);
    const cortados = candidatos.length - escolhidos.length;
    if (cortados > 0) {
      // Limite existe, mas nunca em silêncio.
      onLog(`${candidatos.length} dias passaram no teto; detalhando os ${escolhidos.length} mais baratos.`);
      lacunas.push(
        `${cortados} dia(s) dentro do teto não foram detalhados (limite de ${MAX_DETALHES} por busca) — ` +
          `os mais baratos entraram primeiro`,
      );
    } else if (escolhidos.length > 0) {
      onLog(`${escolhidos.length} dia(s) passaram no teto — buscando cabine e assentos de cada um.`);
    }

    for (let i = 0; i < escolhidos.length; i++) {
      await buscar(escolhidos[i]![0]);
      onProgresso(0.6 + 0.4 * ((i + 1) / escolhidos.length));
    }
  }

  onProgresso(1);
  dias.sort((a, b) => a.data.localeCompare(b.data));
  return { dias, diasComFalha, lacunas };
}

// ── Relatório no contrato comum ───────────────────────────────────────────

const CABINES_SMILES = [
  { campo: "economica", rotulo: "Econômica", corClasse: "cartao-economica" },
  { campo: "premium", rotulo: "Conforto", corClasse: "cartao-premium" },
  { campo: "executiva", rotulo: "Executiva", corClasse: "cartao-executiva" },
] as const;

export type SecaoSmiles = SecaoRelatorio & { rotulo: string; corClasse: string };

export function construirRelatorioSmiles(dias: RespostaSmiles[], tetos: TetosSmiles = {}): SecaoSmiles[] {
  return CABINES_SMILES.map(({ campo, rotulo, corClasse }) => {
    const teto = tetos[campo];

    // Um dia entra pela cabine se tiver voo dela dentro do teto. O valor do
    // dia é o do voo mais barato, e as vagas são as DESSE voo — anunciar as
    // vagas do voo mais cheio junto do preço do mais barato seria mentira.
    const porDia = dias
      .map((dia) => {
        const voos = dia.voos.filter((v) => v.cabine === campo && (teto == null || v.milhas <= teto));
        if (voos.length === 0) return null;
        const melhor = voos.reduce((a, b) => (a.milhas <= b.milhas ? a : b));
        return { data: dia.data, valorK: Math.round(melhor.milhas / 10) / 100, assentos: melhor.assentos };
      })
      .filter((d): d is { data: string; valorK: number; assentos: number } => d !== null);

    if (porDia.length === 0) {
      return {
        rotulo,
        corClasse,
        menor: null,
        maior: null,
        dias: [],
        texto: "Nenhuma disponibilidade encontrada nesse período.",
      };
    }

    const valores = porDia.map((d) => d.valorK);
    const assentosPorData = new Map(porDia.map((d) => [d.data, d.assentos]));

    return {
      rotulo,
      corClasse,
      menor: Math.min(...valores),
      maior: Math.max(...valores),
      dias: porDia,
      texto: formatarListaPorMes(
        porDia.map((d) => d.data),
        (data) => {
          const n = assentosPorData.get(data) ?? 0;
          return n > 0 ? ` (${n})` : "";
        },
      ),
    };
  });
}
