import "dotenv/config";
import { chromium, type Page } from "playwright";
import { stdin as input, stdout as output } from "process";
import * as readline from "readline/promises";

type DiaDisponibilidade = {
  date: string;
  found: number;
  total: number;
  economy: string;
  premiumEconomy: string;
  business: string;
  first: string;
};

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
// nela. Navega direto pela URL (ver comentário mais abaixo em buscarEmissoes)
// em vez de mexer nos widgets de origem/destino/data do formulário.
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

  console.log(
    `  Buscando de ${dataInicio.toLocaleDateString()} a ${dataFim.toLocaleDateString()}...`,
  );
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
    console.log(
      `    (preços ainda não carregaram, tentando de novo [${tentativa}]...)`,
    );
    await page.waitForTimeout(1500 * tentativa);
    dias = await extrairDias(popover);
  }

  console.log(`  Foram encontradas ${dias.length} datas nessa janela.`);
  return dias;
}

const MESES_PT = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];

function parseValorK(valor: string): number | null {
  if (!valor || valor === "-") return null;
  const num = parseFloat(valor.replace(/K$/i, "").replace(",", "."));
  return Number.isNaN(num) ? null : num;
}

function formatarListaPorMes(datas: string[]): string {
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
): string {
  const disponiveis = todasAsDatas.filter((d) => {
    const v = parseValorK(d[campo]);
    return v !== null && aceita(v);
  });

  if (disponiveis.length === 0) {
    return `${nome}:\nNenhuma disponibilidade encontrada nesse período.`;
  }

  const valores = disponiveis.map((d) => parseValorK(d[campo])!);
  const menor = Math.min(...valores);
  const maior = Math.max(...valores);
  const datasOrdenadas = disponiveis.map((d) => d.date).sort();
  const resumo = `Menor valor: ${menor}K | Maior valor: ${maior}K | Dias com disponibilidade: ${disponiveis.length}`;
  const corpo = formatarListaPorMes(datasOrdenadas);

  return `${nome}:\n${resumo}\n${corpo}`;
}

const JANELA_DIAS = 36;

// Pesquisa o trecho inteiro por um ano rolante a partir de hoje (ex.: hoje
// 14/jul/2026 -> vai até 14/jul/2027, que é até onde o calendário do
// AwardTool deixa navegar), em janelas de até 36 dias, e devolve todas as
// datas/preços acumulados das janelas.
async function pesquisarAnoCompleto(
  page: Page,
  opts: {
    baseUrl: string;
    origem: string;
    destino: string;
    cabineParam: string;
  },
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

  while (janelaInicio <= limitePeriodo) {
    let janelaFim = new Date(janelaInicio);
    janelaFim.setDate(janelaInicio.getDate() + JANELA_DIAS - 1);
    if (janelaFim > limitePeriodo) janelaFim = new Date(limitePeriodo);

    console.log(`\nJanela ${numeroJanela}:`);
    const diasDaJanela = await pesquisarJanela(page, {
      baseUrl,
      origem,
      destino,
      cabineParam,
      dataInicio: janelaInicio,
      dataFim: janelaFim,
    });
    todasAsDatas.push(...diasDaJanela);

    janelaInicio = new Date(janelaFim);
    janelaInicio.setDate(janelaFim.getDate() + 1);
    numeroJanela++;
  }

  console.log(
    `\nBusca do ano completa! Total de ${todasAsDatas.length} datas capturadas.`,
  );
  return todasAsDatas;
}

function imprimirRelatorio(todasAsDatas: DiaDisponibilidade[]) {
  const saidaFinal = [
    construirSecao(
      todasAsDatas,
      "Executivas",
      "business",
      (v) => v === VALOR_EXECUTIVA_K,
    ),
    "",
    construirSecao(
      todasAsDatas,
      "Economicas",
      "economy",
      (v) => v <= LIMIAR_ECONOMICA_K,
    ),
  ].join("\n");

  console.log("\n--- RESULTADO ---\n");
  console.log(saidaFinal);
}

async function perguntarComPadrao(
  rl: readline.Interface,
  pergunta: string,
  padrao: string,
): Promise<string> {
  const resposta = await rl.question(`${pergunta} (Enter para "${padrao}"): `);
  return resposta.trim() === "" ? padrao : resposta.trim();
}

async function perguntarSimNao(
  rl: readline.Interface,
  pergunta: string,
): Promise<boolean> {
  const resposta = await rl.question(`${pergunta} (s/n): `);
  return /^s(im)?$/i.test(resposta.trim());
}

async function buscarEmissoes() {
  const rl = readline.createInterface({ input, output });

  console.log("✈️  Bot de Emissões TAP Iniciado!\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl = process.env.LOGIN_URL!;
  const emailAccount = process.env.EMAIL_ACCOUNT!;
  const passwordAccount = process.env.PASSWORD_ACCOUNT!;

  console.log("Acessando a página de login...");
  await page.goto(loginUrl);

  await page.locator('input[name="username"]').fill(emailAccount);
  await page.locator('input[name="password"]').fill(passwordAccount);
  await page.locator('button[type="submit"]').click();

  await page.waitForLoadState("networkidle");
  console.log("Login concluído!");

  const baseUrl = new URL(loginUrl).origin;

  // --- MONTAGEM DA BUSCA DIRETO PELA URL ---
  //
  // Os campos de origem/destino do formulário (Autocomplete multi-select do
  // MUI, com checkboxes) se mostraram não-determinísticos: o mesmo Enter/clique
  // que confirma a opção destacada às vezes seleciona, às vezes só limpa o
  // campo digitado — sem padrão fixo de timing pra contornar. Só que o app
  // inteiro reflete o estado da busca na URL (from, to, cabins, programs, as
  // datas etc.), então navegamos direto pra ela em vez de depender desses
  // widgets frágeis.
  let origem = (
    await rl.question("🛫 Digite a origem (código IATA, ex.: GRU): ")
  ).toUpperCase();
  let destino = (
    await rl.question("🛬 Digite o destino (código IATA, ex.: LIS): ")
  ).toUpperCase();
  let cabine = await rl.question(
    "💺 Cabine (1 para Executiva, 2 para Econômica): ",
  );

  for (;;) {
    console.log(`\nBuscando ${origem} -> ${destino}...`);
    const cabineParam = cabine === "1" ? "Business" : "Economy";

    const todasAsDatas = await pesquisarAnoCompleto(page, {
      baseUrl,
      origem,
      destino,
      cabineParam,
    });
    imprimirRelatorio(todasAsDatas);

    const querOutroTrecho = await perguntarSimNao(
      rl,
      "\nDeseja pesquisar mais algum trecho (ex.: a volta)?",
    );
    if (!querOutroTrecho) break;

    // Sugere a volta do trecho pesquisado (origem/destino invertidos) como
    // padrão, mas deixa o usuário digitar outra coisa se quiser.
    const novaOrigem = await perguntarComPadrao(rl, "🛫 Origem", destino);
    const novoDestino = await perguntarComPadrao(rl, "🛬 Destino", origem);
    const novaCabine = await perguntarComPadrao(
      rl,
      "💺 Cabine (1 para Executiva, 2 para Econômica)",
      cabine,
    );

    origem = novaOrigem.toUpperCase();
    destino = novoDestino.toUpperCase();
    cabine = novaCabine;
  }

  rl.close();
  await browser.close();
}

buscarEmissoes();
