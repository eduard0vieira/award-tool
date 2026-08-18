import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { formatarListaPorMes, type OnLog, type OnProgresso } from "../../nucleo/comum.ts";

export type SessaoSeatspy = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export type CompanhiaSeatspy = "AF" | "B6" | "BA" | "CX" | "EY" | "IB" | "KLM" | "QF" | "VIR";

export type ParametrosSeatspy = {
  companhia: CompanhiaSeatspy;
  origem: string; // IATA, ex.: "GRU"
  destino: string; // IATA, ex.: "MAD"
  idaEVolta: boolean;
};

// Disponibilidade de uma cabine num dia. O SeatSpy às vezes marca o dia como
// disponível (bolinha verde no calendário) sem informar o valor em milhas do
// voo (tarifas mistas/parceiras) — nesse caso `milhas` fica null mesmo com
// `disponivel: true`, pra não perder o dia por falta desse dado.
export type ValorCabine = {
  disponivel: boolean;
  milhas: number | null;
  // Vagas do voo cotado (o mais barato do dia naquela cabine) — é o mesmo
  // número que o SeatSpy mostra no hover do calendário. 0 = sem disponibilidade.
  assentos: number;
};

export type DiaSeatspy = {
  data: string; // YYYY-MM-DD
  economica: ValorCabine;
  premium: ValorCabine;
  executiva: ValorCabine;
  primeira: ValorCabine;
};

export type SecaoSeatspy = {
  rotulo: string;
  corClasse: string;
  menor: number | null; // em K (milhares de milhas), só considerando dias com preço
  maior: number | null;
  // `assentos` só vem do SeatSpy; LATAM e AA reusam esse tipo sem ele.
  dias: { data: string; valorK: number | null; assentos?: number }[];
  texto: string;
};

export type RelatorioSeatspy = { secoes: SecaoSeatspy[] };

// Teto opcional de milhas por cabine (valor absoluto, ex.: 25000). Dias mais
// caros que o teto ficam de fora do relatório daquela cabine.
export type TetosSeatspy = {
  economica?: number | null;
  premium?: number | null;
  executiva?: number | null;
  primeira?: number | null;
};

// Todos os programas que o SeatSpy rastreia (chave = código usado no
// #airline do próprio site, ver selecionarCompanhia).
export const NOME_COMPANHIA: Record<CompanhiaSeatspy, string> = {
  AF: "Air France",
  B6: "JetBlue",
  BA: "British Airways",
  CX: "Cathay Pacific",
  EY: "Etihad Airways",
  IB: "Iberia Airlines",
  KLM: "KLM Royal Dutch Airlines",
  QF: "Qantas Airways",
  VIR: "Virgin Atlantic",
};

export async function iniciarSessaoSeatspy(headless = false): Promise<SessaoSeatspy> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  // O evento "load" (padrão do goto) só dispara quando todo recurso de
  // terceiros termina (Freshworks, Sentry, Clarity...), e qualquer um deles
  // travando trava o goto também. "domcontentloaded" dispara assim que o HTML
  // em si carrega, que é tudo que os campos de login abaixo precisam.
  await page.goto(process.env.SEATSPY_LOGIN_URL!, { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(process.env.SEATSPY_EMAIL!);
  await page.locator("#password").fill(process.env.SEATSPY_PASSWORD!);
  await page.locator("#submit").click();
  await page.waitForURL((url) => !url.pathname.includes("sign-in"), { timeout: 30000 });

  return { browser, context, page };
}

// Os campos do formulário são comboboxes Tom Select. Clicar neles via UI é
// instável (o input interno fica "fora do viewport" pro Playwright), então a
// seleção é feita direto pela API do Tom Select (el.tomselect.setValue), que
// dispara o mesmo evento "change" no <select> que uma seleção manual.
// As opções carregam de forma assíncrona ("Loading"), daí as esperas.

type ElComTomSelect = HTMLSelectElement & {
  tomselect?: {
    options: Record<string, { iata?: string; iatas?: string }>;
    setValue: (v: string) => void;
  };
};

// As companhias são chaveadas pelo próprio código IATA ("IB", "BA", ...).
async function selecionarCompanhia(page: Page, companhia: CompanhiaSeatspy) {
  await page.waitForFunction(
    (cia) => {
      const sel = document.querySelector("#airline") as ElComTomSelect | null;
      return !!sel?.tomselect?.options?.[cia];
    },
    companhia,
    { timeout: 30000 },
  );
  await page.evaluate(
    (cia) => (document.querySelector("#airline") as ElComTomSelect).tomselect!.setValue(cia),
    companhia,
  );
}

// Os aeroportos são chaveados por um id interno; o código IATA fica nos
// campos "iata"/"iatas" de cada opção.
async function selecionarAeroporto(page: Page, campoId: "outbound" | "inbound", iata: string) {
  const chaveHandle = await page.waitForFunction(
    ({ campoId, iata }) => {
      const sel = document.querySelector(`#${campoId}`) as ElComTomSelect | null;
      if (!sel?.tomselect) return null;
      const par = Object.entries(sel.tomselect.options).find(
        ([, o]) => o.iata === iata || (typeof o.iatas === "string" && o.iatas.split(/[\s,]+/).includes(iata)),
      );
      return par ? par[0] : null;
    },
    { campoId, iata },
    { timeout: 30000 },
  );
  const chave = (await chaveHandle.jsonValue()) as string;

  await page.evaluate(
    ({ campoId, chave }) => (document.querySelector(`#${campoId}`) as ElComTomSelect).tomselect!.setValue(chave),
    { campoId, chave },
  );
}

type RespostaAnoCru = {
  data?: { dates?: DataCrua[] };
};

type DataCrua = {
  startDate: string; // "Sun, 19 Jul 2026 00:00:00 GMT"
  flights?: VooCru[];
};

type VooCru = {
  originIATA: string;
  economy: number;
  economyMiles: number | null;
  premium: number;
  premiumMiles: number | null;
  business: number;
  businessMiles: number | null;
  // Primeira classe existe só em algumas companhias (British, Cathay,
  // Etihad, Qantas...). O nome do campo não aparece no JS do site, então
  // aceitamos as duas grafias plausíveis e avisamos no log se vier outra
  // — ver avisarCamposDeCabine.
  first?: number;
  firstMiles?: number | null;
  firstClass?: number;
  firstClassMiles?: number | null;
};

function assentosPrimeira(v: VooCru): number {
  return v.first ?? v.firstClass ?? 0;
}

function milhasPrimeira(v: VooCru): number | null {
  return v.firstMiles ?? v.firstClassMiles ?? null;
}

// Roda uma vez por processo: se a resposta não trouxer nenhum campo de
// primeira classe conhecido, imprime as chaves que vieram, pra dar pra
// corrigir o nome sem precisar gastar outra busca investigando.
let jaAvisouCampos = false;
function avisarCamposDeCabine(voo: VooCru | undefined, onLog: OnLog) {
  if (jaAvisouCampos || !voo) return;
  jaAvisouCampos = true;
  const temPrimeira = ["first", "firstMiles", "firstClass", "firstClassMiles"].some((c) => c in voo);
  if (!temPrimeira) {
    onLog(
      "Atenção: a resposta do SeatSpy não trouxe campo de primeira classe conhecido. " +
        `Campos recebidos: ${Object.keys(voo).join(", ")}`,
    );
  }
}

function paraISO(dataGMT: string): string {
  return new Date(dataGMT).toISOString().slice(0, 10);
}

function valorCabine(
  voos: VooCru[],
  assentos: (v: VooCru) => number,
  milhas: (v: VooCru) => number | null,
): ValorCabine {
  const comAssento = voos.filter((v) => assentos(v) > 0);
  if (comAssento.length === 0) return { disponivel: false, milhas: null, assentos: 0 };

  const comPreco = comAssento.filter((v) => milhas(v) !== null);
  if (comPreco.length === 0) {
    // Dia disponível sem preço informado (tarifa mista/parceira): reporta a
    // maior oferta de vagas do dia.
    return { disponivel: true, milhas: null, assentos: Math.max(...comAssento.map(assentos)) };
  }

  // As vagas têm que ser as DO VOO COTADO, não o máximo do dia — senão a gente
  // anunciaria "9 vagas" num preço que só existe num voo com 2.
  const melhor = comPreco.reduce((a, b) => (milhas(a)! <= milhas(b)! ? a : b));
  return { disponivel: true, milhas: milhas(melhor), assentos: assentos(melhor) };
}

function extrairDias(datas: DataCrua[]): DiaSeatspy[] {
  return datas
    .map((d) => {
      const voos = d.flights ?? [];
      return {
        data: paraISO(d.startDate),
        economica: valorCabine(voos, (v) => v.economy, (v) => v.economyMiles),
        premium: valorCabine(voos, (v) => v.premium, (v) => v.premiumMiles),
        executiva: valorCabine(voos, (v) => v.business, (v) => v.businessMiles),
        primeira: valorCabine(voos, assentosPrimeira, milhasPrimeira),
      };
    })
    .sort((a, b) => a.data.localeCompare(b.data));
}

// Roda a busca pela interface e captura os JSONs de /api/retrieve-year-data
// que o próprio site pede — cada resposta traz o ano inteiro de uma direção.
export async function pesquisarSeatspy(
  page: Page,
  params: ParametrosSeatspy,
  onLog: OnLog,
  onProgresso: OnProgresso,
): Promise<{ ida: DiaSeatspy[]; volta: DiaSeatspy[] | null }> {
  const origem = params.origem.toUpperCase();
  const destino = params.destino.toUpperCase();

  onLog(`Abrindo formulário de busca (${NOME_COMPANHIA[params.companhia]})...`);
  // Mesmo motivo do login: não espera o "load" completo (scripts de
  // terceiros), só o HTML — o resto do fluxo já espera o Tom Select carregar
  // via selecionarCompanhia/selecionarAeroporto.
  await page.goto("https://www.seatspy.com/", { waitUntil: "domcontentloaded" });

  // As respostas não dizem qual direção são; identifica pelo IATA de origem
  // dos voos, com fallback pra ordem de chegada (ida vem primeiro).
  const porDirecao = new Map<"ida" | "volta", DiaSeatspy[]>();
  // Quando o trecho não é operado pela companhia escolhida, o SeatSpy costuma
  // responder rápido com uma lista de dias vazia (ou um status de erro) em vez
  // de nunca responder — sem isso, o código ficava esperando um dado que
  // nunca chegaria até estourar o timeout de 2min lá embaixo.
  const direcoesVazias = new Set<"ida" | "volta">();
  const direcaoPelaOrdem = () => (porDirecao.has("ida") || direcoesVazias.has("ida") ? "volta" : "ida");

  const aoResponder = async (res: import("playwright").Response) => {
    if (!res.url().includes("/api/retrieve-year-data")) return;

    if (res.status() !== 200) {
      const direcao = direcaoPelaOrdem();
      direcoesVazias.add(direcao);
      onLog(`SeatSpy respondeu com erro (status ${res.status()}) pra ${direcao} — tratando como sem disponibilidade.`);
      return;
    }

    let corpo: RespostaAnoCru;
    try {
      corpo = (await res.json()) as RespostaAnoCru;
    } catch {
      return;
    }
    const datas = corpo.data?.dates ?? [];

    if (datas.length === 0) {
      const direcao = direcaoPelaOrdem();
      direcoesVazias.add(direcao);
      onLog(`SeatSpy não encontrou disponibilidade pra ${direcao} (a companhia pode não operar esse trecho).`);
      return;
    }

    const primeiroVoo = datas.flatMap((d) => d.flights ?? [])[0];
    let direcao: "ida" | "volta";
    if (primeiroVoo?.originIATA === origem) direcao = "ida";
    else if (primeiroVoo?.originIATA === destino) direcao = "volta";
    else direcao = direcaoPelaOrdem();

    avisarCamposDeCabine(primeiroVoo, onLog);
    porDirecao.set(direcao, extrairDias(datas));
    onLog(`Recebido ano completo da ${direcao} (${datas.length} dias).`);
  };
  page.on("response", aoResponder);

  try {
    await selecionarCompanhia(page, params.companhia);
    await selecionarAeroporto(page, "outbound", origem);
    await selecionarAeroporto(page, "inbound", destino);

    // Radios/botões também sofrem do problema de viewport — clique via JS.
    await page.evaluate((idaEVolta) => {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${idaEVolta ? "return" : "one-way"}"]`);
      label?.click();
    }, params.idaEVolta);
    onProgresso(0.15);

    onLog(`Buscando ${origem} → ${destino}${params.idaEVolta ? " (ida e volta)" : ""}...`);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#search-submit")?.click();
    });

    // O site responde as direções de forma assíncrona; espera chegar tudo —
    // uma direção "vazia" (ver aoResponder) conta como resolvida também, pra
    // não ficar esperando à toa até o timeout.
    const precisaDe = params.idaEVolta ? 2 : 1;
    const limite = Date.now() + 120000;
    while (Date.now() < limite && porDirecao.size + direcoesVazias.size < precisaDe) {
      await page.waitForTimeout(500);
      onProgresso(Math.min(0.15 + (porDirecao.size + direcoesVazias.size) * 0.4, 0.95));
    }

    const nomeCompanhia = NOME_COMPANHIA[params.companhia];
    if (direcoesVazias.has("ida")) {
      throw new Error(
        `Nenhuma disponibilidade encontrada para ${origem} → ${destino} — é possível que a ${nomeCompanhia} não opere esse trecho.`,
      );
    }
    if (!porDirecao.has("ida")) {
      throw new Error("A busca no SeatSpy não retornou dados (tempo esgotado). Tente de novo.");
    }
    if (params.idaEVolta) {
      if (direcoesVazias.has("volta")) {
        throw new Error(
          `Nenhuma disponibilidade encontrada para a volta (${destino} → ${origem}) — é possível que a ${nomeCompanhia} não opere esse trecho nessa direção.`,
        );
      }
      if (!porDirecao.has("volta")) {
        throw new Error("A busca retornou só a ida; a volta não chegou a tempo. Tente de novo.");
      }
    }

    onProgresso(1);
    return { ida: porDirecao.get("ida")!, volta: porDirecao.get("volta") ?? null };
  } finally {
    page.off("response", aoResponder);
  }
}

const CABINES = [
  { campo: "economica", rotulo: "Econômica", corClasse: "cartao-economica" },
  { campo: "premium", rotulo: "Premium", corClasse: "cartao-premium" },
  { campo: "executiva", rotulo: "Executiva", corClasse: "cartao-executiva" },
  { campo: "primeira", rotulo: "Primeira Classe", corClasse: "cartao-primeira" },
] as const;

export function construirRelatorioSeatspy(dias: DiaSeatspy[], tetos: TetosSeatspy = {}): RelatorioSeatspy {
  const secoes = CABINES.map(({ campo, rotulo, corClasse }) => {
    const teto = tetos[campo];
    const disponiveis = dias.filter((d) => {
      const v = d[campo];
      if (!v.disponivel) return false;
      // Sem preço informado não dá pra comparar com o teto — melhor mostrar
      // o dia do que esconder uma disponibilidade real por falta desse dado.
      return teto == null || v.milhas == null || v.milhas <= teto;
    });

    if (disponiveis.length === 0) {
      return {
        rotulo,
        corClasse,
        menor: null,
        maior: null,
        dias: [],
        texto: "Nenhuma disponibilidade encontrada nesse período.",
      };
    }

    const diasFormatados = disponiveis.map((d) => {
      const { milhas, assentos } = d[campo];
      return { data: d.data, valorK: milhas != null ? Math.round(milhas / 10) / 100 : null, assentos };
    });
    const assentosPorData = new Map(diasFormatados.map((d) => [d.data, d.assentos]));
    const valoresConhecidos = diasFormatados.map((d) => d.valorK).filter((v): v is number => v != null);

    return {
      rotulo,
      corClasse,
      menor: valoresConhecidos.length > 0 ? Math.min(...valoresConhecidos) : null,
      maior: valoresConhecidos.length > 0 ? Math.max(...valoresConhecidos) : null,
      dias: diasFormatados,
      texto: formatarListaPorMes(
        diasFormatados.map((d) => d.data),
        (data) => {
          const n = assentosPorData.get(data) ?? 0;
          return n > 0 ? ` (${n})` : "";
        },
      ),
    };
  });

  return { secoes };
}
