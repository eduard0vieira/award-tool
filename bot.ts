import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type DiaDisponibilidade = {
  date: string;
  found: number;
  total: number;
  economy: string;
  premiumEconomy: string;
  business: string;
  first: string;
};

export type ParametrosBusca = {
  origem: string;
  destino: string;
  cabine: string; // "1" = Executiva, "2" = Econômica
};

export type DiaFormatado = {
  data: string; // YYYY-MM-DD
  valorK: number;
};

export type SecaoRelatorio = {
  menor: number | null;
  maior: number | null;
  dias: DiaFormatado[]; // ordenados cronologicamente
  texto: string; // "Mmm YYYY: DD, DD, ..." (pra copiar)
};

export type Relatorio = {
  executivas: SecaoRelatorio;
  economicas: SecaoRelatorio;
};

export type OnLog = (mensagem: string) => void;
export type OnProgresso = (fracao: number) => void;
export type OnJanela = (info: {
  atual: number;
  total: number;
  inicio: string;
  fim: string;
}) => void;

// Cada linha do popover "Date" tem um parágrafo "YYYY-MM-DD (achados/total)"
// seguido de 4 valores de preço, um por cabine, identificados pela cor da
// bolinha ao lado (não pela posição/texto, que pode variar): verde-claro =
// Economy, verde-escuro = Premium Economy, azul = Business, roxo = First.
async function extrairDias(
  popover: ReturnType<Page["locator"]>,
): Promise<DiaDisponibilidade[]> {
  return popover.evaluate((root) => {
    const CORES: Record<
      string,
      "economy" | "premiumEconomy" | "business" | "first"
    > = {
      "76,175,80": "economy",
      "46,125,50": "premiumEconomy",
      "0,145,234": "business",
      "103,58,183": "first",
    };

    const linhas: any[] = [];
    root.querySelectorAll("p").forEach((p) => {
      const texto = (p.textContent || "").trim();
      const m = texto.match(/^(\d{4}-\d{2}-\d{2})\s*\((\d+)\/(\d+)\)$/);
      if (!m) return;

      const precoContainer = p.nextElementSibling;
      if (!precoContainer) return;

      const valores: Record<string, string> = {
        economy: "-",
        premiumEconomy: "-",
        business: "-",
        first: "-",
      };

      precoContainer.querySelectorAll(".w-\\[52px\\]").forEach((div) => {
        const dot = div.querySelector(
          "span[style*='background-color']",
        ) as HTMLElement | null;
        const style = dot?.getAttribute("style") || "";
        const corMatch = style.match(/rgb\(([\d,\s]+)\)/);
        if (!corMatch || !corMatch[1]) return;
        const chave = CORES[corMatch[1].replace(/\s+/g, "")];
        if (chave) {
          valores[chave] = (div.textContent || "").trim();
        }
      });

      linhas.push({
        date: m[1]!,
        found: parseInt(m[2]!, 10),
        total: parseInt(m[3]!, 10),
        economy: valores.economy,
        premiumEconomy: valores.premiumEconomy,
        business: valores.business,
        first: valores.first,
      });
    });
    return linhas;
  });
}

// Pesquisa uma janela de até 36 dias e devolve as datas/preços encontrados
// nela. Navega direto pela URL (ver comentário em pesquisarAnoCompleto) em
// vez de mexer nos widgets de origem/destino/data do formulário.
async function pesquisarJanela(
  page: Page,
  opts: {
    baseUrl: string;
    origem: string;
    destino: string;
    cabineParam: string;
    dataInicio: Date;
    dataFim: Date;
  },
  onLog: OnLog,
  // fracaoBase..fracaoBase+fracaoPasso é a fatia do progresso total (0..1)
  // que esta janela ocupa (atualizada no início e no fim da janela).
  onProgresso: OnProgresso,
  fracaoBase: number,
  fracaoPasso: number,
): Promise<DiaDisponibilidade[]> {
  const { baseUrl, origem, destino, cabineParam, dataInicio, dataFim } = opts;

  const params = new URLSearchParams({
    flightWay: "oneway",
    pax: "1",
    children: "0",
    cabins: cabineParam,
    range: "true",
    rangeV2: "false",
    from: origem.toUpperCase(),
    to: destino.toUpperCase(),
    programs: "TP", // TAP
    targetId: "",
    oneWayRangeStartDate: String(Math.floor(dataInicio.getTime() / 1000)),
    oneWayRangeEndDate: String(Math.floor(dataFim.getTime() / 1000)),
  });

  const resultsUrl = `${baseUrl}/flight?${params.toString()}`;

  onLog(
    `Buscando de ${dataInicio.toLocaleDateString()} a ${dataFim.toLocaleDateString()}...`,
  );
  onProgresso(fracaoBase);
  await page.goto(resultsUrl);
  await page.waitForLoadState("domcontentloaded");

  // Os preços por dia só ficam corretos depois que o long polling de voos
  // termina de verdade. Isso demora pelo menos ~35s, e o aviso de "carregando"
  // às vezes some antes da tabela terminar de fato de preencher todos os
  // preços. Por isso esperamos os dois: um tempo mínimo fixo de 35s E o aviso
  // de carregando desaparecer — o que demorar mais.
  const ESPERA_MINIMA_MS = 35000;
  const inicioEspera = Date.now();
  try {
    await page
      .getByText(
        /Retrieving real-time award flight availability|taxiing to the gate/i,
      )
      .first()
      .waitFor({ state: "hidden", timeout: 60000 });
  } catch {
    // segue mesmo assim: o tempo mínimo abaixo ainda vale como rede de segurança
  }
  const tempoRestante = ESPERA_MINIMA_MS - (Date.now() - inicioEspera);
  if (tempoRestante > 0) {
    await page.waitForTimeout(tempoRestante);
  }

  const dateBtn = page
    .getByRole("button", { name: "Date", exact: false })
    .first();
  await dateBtn.waitFor({ state: "visible", timeout: 20000 });
  await dateBtn.click();
  await page.waitForTimeout(1000);

  const popover = page
    .locator(".MuiPopover-paper, .MuiPaper-root, [role='dialog']")
    .filter({ visible: true })
    .last();

  // Às vezes o popover abre um instante antes dos preços de cada dia
  // terminarem de preencher. Se existirem dias com voos encontrados
  // (found > 0) mas TODOS os preços vazios, é sinal dessa corrida — tenta de
  // novo em vez de reportar "sem disponibilidade" errado.
  let dias = await extrairDias(popover);
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    const comVooMasSemPreco = dias.some(
      (d) => d.found > 0 && d.economy === "-" && d.business === "-",
    );
    if (!comVooMasSemPreco) break;
    onLog(`  (preços ainda não carregaram, tentando de novo [${tentativa}]...)`);
    await page.waitForTimeout(1500 * tentativa);
    dias = await extrairDias(popover);
  }

  onLog(`Foram encontradas ${dias.length} datas nessa janela.`);
  onProgresso(fracaoBase + fracaoPasso);
  return dias;
}

const MESES_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function parseValorK(valor: string): number | null {
  if (!valor || valor === "-") return null;
  const num = parseFloat(valor.replace(/K$/i, "").replace(",", "."));
  return Number.isNaN(num) ? null : num;
}

export function formatarListaPorMes(datas: string[]): string {
  const grupos = new Map<string, string[]>();
  for (const d of datas) {
    const [ano, mes, dia] = d.split("-") as [string, string, string];
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave)!.push(dia);
  }
  const chavesOrdenadas = Array.from(grupos.keys()).sort();
  return chavesOrdenadas
    .map((chave) => {
      const [ano, mesNum] = chave.split("-") as [string, string];
      const nomeMes = MESES_PT[parseInt(mesNum, 10) - 1];
      return `${nomeMes} ${ano}: ${grupos.get(chave)!.join(", ")}`;
    })
    .join("\n");
}

// Valores de referência da tabela de milhas da TAP: só interessa a Executiva
// na tarifa padrão (181K exato) e a Econômica na tarifa padrão OU melhor (53K
// ou menos) — preços diferentes desses (ex.: 55K, 80K, alguma tarifa
// "flex"/promocional fora da tabela) são ignorados.
const VALOR_EXECUTIVA_K = 181;
const LIMIAR_ECONOMICA_K = 53;

function construirSecao(
  todasAsDatas: DiaDisponibilidade[],
  nome: string,
  campo: "economy" | "business",
  aceita: (valorK: number) => boolean,
): SecaoRelatorio {
  const disponiveis = todasAsDatas.filter((d) => {
    const v = parseValorK(d[campo]);
    return v !== null && aceita(v);
  });

  if (disponiveis.length === 0) {
    return { menor: null, maior: null, dias: [], texto: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const dias: DiaFormatado[] = disponiveis
    .map((d) => ({ data: d.date, valorK: parseValorK(d[campo])! }))
    .sort((a, b) => a.data.localeCompare(b.data));

  const valores = dias.map((d) => d.valorK);
  const menor = Math.min(...valores);
  const maior = Math.max(...valores);
  const texto = formatarListaPorMes(dias.map((d) => d.data));

  return { menor, maior, dias, texto };
}

export function construirRelatorio(todasAsDatas: DiaDisponibilidade[]): Relatorio {
  return {
    executivas: construirSecao(
      todasAsDatas,
      "Executivas",
      "business",
      (v) => v === VALOR_EXECUTIVA_K,
    ),
    economicas: construirSecao(
      todasAsDatas,
      "Economicas",
      "economy",
      (v) => v <= LIMIAR_ECONOMICA_K,
    ),
  };
}

const JANELA_DIAS = 36;

// Pesquisa o trecho inteiro por um ano rolante a partir de hoje (ex.: hoje
// 14/jul/2026 -> vai até 14/jul/2027, que é até onde o calendário do
// AwardTool deixa navegar), em janelas de até 36 dias, e devolve todas as
// datas/preços acumulados das janelas.
export async function pesquisarAnoCompleto(
  page: Page,
  opts: {
    baseUrl: string;
    origem: string;
    destino: string;
    cabineParam: string;
  },
  onLog: OnLog = () => {},
  onProgresso: OnProgresso = () => {},
  onJanela: OnJanela = () => {},
): Promise<DiaDisponibilidade[]> {
  const { baseUrl, origem, destino, cabineParam } = opts;

  const hoje = new Date();
  const limitePeriodo = new Date(
    hoje.getFullYear() + 1,
    hoje.getMonth(),
    hoje.getDate(),
  );

  const todasAsDatas: DiaDisponibilidade[] = [];
  let janelaInicio = new Date(
    hoje.getFullYear(),
    hoje.getMonth(),
    hoje.getDate(),
  );
  let numeroJanela = 1;

  // Conta quantas janelas serão feitas ao todo, só para a mensagem de progresso.
  let totalJanelas = 0;
  {
    let cursor = new Date(janelaInicio);
    while (cursor <= limitePeriodo) {
      totalJanelas++;
      cursor.setDate(cursor.getDate() + JANELA_DIAS);
    }
  }

  while (janelaInicio <= limitePeriodo) {
    let janelaFim = new Date(janelaInicio);
    janelaFim.setDate(janelaInicio.getDate() + JANELA_DIAS - 1);
    if (janelaFim > limitePeriodo) janelaFim = new Date(limitePeriodo);

    onLog(`Janela ${numeroJanela}/${totalJanelas}:`);
    onJanela({
      atual: numeroJanela,
      total: totalJanelas,
      inicio: janelaInicio.toLocaleDateString("pt-BR"),
      fim: janelaFim.toLocaleDateString("pt-BR"),
    });
    const diasDaJanela = await pesquisarJanela(
      page,
      { baseUrl, origem, destino, cabineParam, dataInicio: janelaInicio, dataFim: janelaFim },
      onLog,
      onProgresso,
      (numeroJanela - 1) / totalJanelas,
      1 / totalJanelas,
    );
    todasAsDatas.push(...diasDaJanela);

    janelaInicio = new Date(janelaFim);
    janelaInicio.setDate(janelaFim.getDate() + 1);
    numeroJanela++;
  }

  onProgresso(1);
  onLog(`Busca do ano completa! Total de ${todasAsDatas.length} datas capturadas.`);
  return todasAsDatas;
}

export type Sessao = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  baseUrl: string;
};

// Abre o navegador e faz login uma única vez. A mesma `page` é reaproveitada
// entre buscas (inclusive entre "ida" e "volta"), sem precisar relogar.
export async function iniciarSessao(headless = false): Promise<Sessao> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl = process.env.LOGIN_URL!;
  const emailAccount = process.env.EMAIL_ACCOUNT!;
  const passwordAccount = process.env.PASSWORD_ACCOUNT!;

  await page.goto(loginUrl);
  const campoUsuario = page.locator('input[name="username"]');
  await campoUsuario.fill(emailAccount);
  await page.locator('input[name="password"]').fill(passwordAccount);
  await page.locator('button[type="submit"]').click();
  // "networkidle" nunca dispara aqui: o site mantém polling/conexões em
  // segundo plano mesmo depois do login. Esperar o formulário de login sumir
  // da tela é um sinal direto de que o login deu certo, sem depender disso.
  await campoUsuario.waitFor({ state: "detached" });

  const baseUrl = new URL(loginUrl).origin;

  return { browser, context, page, baseUrl };
}

export function cabineParamDe(cabine: string): string {
  return cabine === "1" ? "Business" : "Economy";
}
