import "dotenv/config";
import type { Page } from "playwright";
import { abrirSessaoChrome, type SessaoChrome } from "./sessao-chrome.ts";
import { LimitadorFrequencia, type OnLog } from "./comum.ts";

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
  // Tarifa SMILES: milhas puras, sem exigir assinatura do Clube. É o número
  // que vale pro cliente comum — ver `milhasClube` pra comparação.
  milhas: number;
  milhasClube: number | null;
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
  if (!smiles) return null; // voo sem tarifa em milhas pura: não é disponibilidade pra nós

  const contexto = `voo ${cabine} em ${data}`;
  const origemDados = exigirTexto(cru.sourceGDS, "sourceGDS", contexto);

  return {
    cabine,
    conexoes: exigirNumero(cru.stops, "stops", contexto),
    assentos: exigirNumero(cru.availableSeats, "availableSeats", contexto),
    milhas: exigirNumero(smiles.miles, "fareList[SMILES].miles", contexto),
    milhasClube: typeof clube?.miles === "number" ? clube.miles : null,
    taxaReais: taxaDe(smiles, origemDados, contexto, onLog),
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
