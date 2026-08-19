import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  LimitadorFrequencia,
  formatarListaPorMes,
  parseValorK,
  type OnAviso,
  type OnJanela,
  type OnLog,
  type OnProgresso,
  type DiaFormatado,
  type SecaoRelatorio,
} from "../../nucleo/comum.ts";

export type { OnAviso, OnJanela, OnLog, OnProgresso, SecaoRelatorio };

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

export type Relatorio = {
  executivas: SecaoRelatorio;
  economicas: SecaoRelatorio;
};

const INTERVALO_MIN_BUSCAS_MS = Number(process.env.AWARDTOOL_INTERVALO_BUSCAS_MS) || 15000;
const limitadorAwardtool = new LimitadorFrequencia(INTERVALO_MIN_BUSCAS_MS);

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
  onAviso: OnAviso = () => {},
): Promise<DiaDisponibilidade[]> {
  const { baseUrl, origem, destino, cabineParam, dataInicio, dataFim } = opts;

  // Espaça o início desta busca em relação a qualquer outra busca do
  // AwardTool rodando em paralelo (outras sessões do pool) — é o que evita o
  // bloqueio por "buscando com muita frequência".
  await limitadorAwardtool.aguardarVez();

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

  // Bug conhecido do AwardTool: na primeira busca de cada sessão (login
  // recente), ele às vezes não reconhece o plano Pro da conta ainda e recusa
  // a janela com um modal ("Search range is too broad"), mesmo ela sendo do
  // tamanho de sempre. Fechar o modal e repetir a mesma busca resolve — o
  // plano já é reconhecido normalmente da segunda tentativa em diante.
  const MAX_TENTATIVAS_MODAL = 3;
  // Bloqueio por excesso de frequência ("searching too frequently"): esperar
  // um pouco resolve, mas o cooldown precisa ser bem maior que o do modal
  // acima — insistir rápido só piora/prolonga o bloqueio.
  const MAX_TENTATIVAS_LIMITE = 3;
  for (let tentativa = 1, tentativaLimite = 1; ; tentativa++) {
    if (tentativa > 1) await limitadorAwardtool.aguardarVez();
    await page.goto(resultsUrl);
    await page.waitForLoadState("domcontentloaded");

    const apareceuLimiteFrequencia = await page
      .getByText(/too (many|frequent(ly)?) (requests|searches)|rate.?limit|search(ing)? too (often|frequently)|please (wait|try again)/i)
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (apareceuLimiteFrequencia) {
      if (tentativaLimite >= MAX_TENTATIVAS_LIMITE) {
        throw new Error(
          `O AwardTool bloqueou essa busca por excesso de frequência e continuou bloqueando mesmo depois de ${MAX_TENTATIVAS_LIMITE} tentativas espaçadas. Tente de novo mais tarde.`,
        );
      }
      const esperaMs = 2 * 60 * 1000 * tentativaLimite; // 2min, 4min, 6min...
      const mensagem = `AwardTool bloqueou por buscas muito frequentes. Esperando ${Math.round(esperaMs / 60000)} min antes de tentar de novo [${tentativaLimite}/${MAX_TENTATIVAS_LIMITE}]...`;
      onLog(`  (${mensagem})`);
      onAviso(mensagem);
      await page.waitForTimeout(esperaMs);
      tentativaLimite++;
      continue;
    }

    const apareceuModal = await page
      .getByText(/search range is too broad/i)
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!apareceuModal) break;

    if (tentativa >= MAX_TENTATIVAS_MODAL) {
      throw new Error(
        `O AwardTool continua recusando essa janela como "muito ampla" mesmo depois de ${MAX_TENTATIVAS_MODAL} tentativas. Pode não ser mais o bug de reconhecimento do plano na primeira busca.`,
      );
    }
    onLog(`  (AwardTool não reconheceu o plano Pro nessa tentativa. Fechando aviso e buscando de novo [${tentativa}/${MAX_TENTATIVAS_MODAL}]...)`);
    const botaoOk = page.getByRole("button", { name: /got it/i }).first();
    if (await botaoOk.isVisible().catch(() => false)) {
      await botaoOk.click();
    }
    await page.waitForTimeout(1500);
  }
  onAviso("");

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

export { formatarListaPorMes };

// Tetos padrão, vindos da tabela de milhas da TAP: Executiva na tarifa padrão
// OU melhor (181K ou menos) e Econômica na tarifa padrão OU melhor (53K ou
// menos). Preços acima disso são alguma tarifa "flex"/promocional fora da
// tabela — mas dá pra pedir outros tetos por busca (ver TetosTap), pra
// explorar faixas diferentes.
export const TETO_EXECUTIVA_K_PADRAO = 181;
export const TETO_ECONOMICA_K_PADRAO = 53;

// Teto em K por cabine. Campo ausente ou null = usa o padrão acima.
export type TetosTap = {
  executivaK?: number | null;
  economicaK?: number | null;
};

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

export function construirRelatorio(
  todasAsDatas: DiaDisponibilidade[],
  tetos: TetosTap = {},
): Relatorio {
  const tetoExecutiva = tetos.executivaK ?? TETO_EXECUTIVA_K_PADRAO;
  const tetoEconomica = tetos.economicaK ?? TETO_ECONOMICA_K_PADRAO;
  return {
    executivas: construirSecao(
      todasAsDatas,
      "Executivas",
      "business",
      (v) => v <= tetoExecutiva,
    ),
    economicas: construirSecao(
      todasAsDatas,
      "Economicas",
      "economy",
      (v) => v <= tetoEconomica,
    ),
  };
}

const JANELA_DIAS = 36;
// Se uma janela falhar mesmo depois dos retries internos (bloqueio de
// frequência persistente, queda de rede, etc.), pula ela e segue pras
// próximas em vez de jogar fora tudo que já foi capturado — mas desiste da
// busca inteira se muitas janelas seguidas falharem (sinal de que o
// problema não vai se resolver sozinho).
const MAX_JANELAS_FALHAS_SEGUIDAS = 3;

export type JanelaComFalha = { inicio: string; fim: string; erro: string };

// Pergunta feita ao usuário no meio da busca. Devolve `true` pra continuar.
// Quem responde é a pessoa na tela — não há default seguro aqui: seguir sozinho
// gastaria meia hora de navegador pra devolver um relatório vazio, e parar
// sozinho esconderia uma rota que de fato não tem disponibilidade.
export type OnPergunta = (mensagem: string) => Promise<boolean>;

// Quantas janelas seguidas sem NENHUM voo antes de desconfiar da fonte. Três é
// mais de 100 dias de calendário: rota que não vende nesse intervalo inteiro
// existe, mas é raro o bastante pra valer perguntar.
const MAX_JANELAS_VAZIAS_SEGUIDAS = Number(process.env.TAP_JANELAS_VAZIAS) || 3;

// "Vazia" aqui é o que o AwardTool mostra quando a fonte dele cai: a tira de
// datas aparece, mas nenhum dia tem voo. Diferente de janela que falhou (erro,
// timeout) — essa responde bem, só não tem nada dentro.
function janelaVazia(dias: DiaDisponibilidade[]): boolean {
  return dias.length > 0 && dias.every((d) => d.found === 0);
}
export type ResultadoAnoCompleto = {
  // Verdadeiro quando você mandou parar: o resultado é parcial de propósito, e
  // isso precisa aparecer no relatório em vez de passar por busca completa.
  interrompidaPorVoce?: boolean;
  dias: DiaDisponibilidade[];
  janelasComFalha: JanelaComFalha[];
};

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
  onAviso: OnAviso = () => {},
  onPergunta?: OnPergunta,
): Promise<ResultadoAnoCompleto> {
  const { baseUrl, origem, destino, cabineParam } = opts;

  const hoje = new Date();
  const limitePeriodo = new Date(
    hoje.getFullYear() + 1,
    hoje.getMonth(),
    hoje.getDate(),
  );

  const todasAsDatas: DiaDisponibilidade[] = [];
  const janelasComFalha: JanelaComFalha[] = [];
  let vaziasSeguidas = 0;
  let interrompidaPorVoce = false;
  let falhasSeguidas = 0;
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

    try {
      const diasDaJanela = await pesquisarJanela(
        page,
        { baseUrl, origem, destino, cabineParam, dataInicio: janelaInicio, dataFim: janelaFim },
        onLog,
        onProgresso,
        (numeroJanela - 1) / totalJanelas,
        1 / totalJanelas,
        onAviso,
      );
      todasAsDatas.push(...diasDaJanela);
      falhasSeguidas = 0;

      // O AwardTool responde "No results match your current filters" tanto
      // quando a rota não tem prêmio quanto quando o feed da companhia caiu.
      // Da nossa parte os dois casos são idênticos, então quem decide é você.
      if (janelaVazia(diasDaJanela)) {
        vaziasSeguidas++;
        if (vaziasSeguidas >= MAX_JANELAS_VAZIAS_SEGUIDAS && onPergunta) {
          const de = janelaInicio.toLocaleDateString("pt-BR");
          const ate = janelaFim.toLocaleDateString("pt-BR");
          const continuar = await onPergunta(
            `${vaziasSeguidas} janelas seguidas sem nenhum voo (até ${de}–${ate}). ` +
              "Isso acontece quando a rota realmente não tem prêmio no período, mas também " +
              "quando a fonte do AwardTool cai, e daqui não dá pra distinguir. Continuar a busca?",
          );
          if (!continuar) {
            onLog("Busca interrompida por você depois das janelas vazias.");
            interrompidaPorVoce = true;
            break;
          }
          // Respondeu que sim: o contador zera pra não perguntar a cada janela.
          vaziasSeguidas = 0;
        }
      } else {
        vaziasSeguidas = 0;
      }
    } catch (err) {
      const mensagemErro = err instanceof Error ? err.message : String(err);
      onLog(`  (janela ${numeroJanela}/${totalJanelas} falhou, pulando: ${mensagemErro})`);
      janelasComFalha.push({
        inicio: janelaInicio.toLocaleDateString("pt-BR"),
        fim: janelaFim.toLocaleDateString("pt-BR"),
        erro: mensagemErro,
      });
      falhasSeguidas++;
      if (falhasSeguidas >= MAX_JANELAS_FALHAS_SEGUIDAS) {
        // Desiste de continuar (o problema não parece transitório), mas
        // devolve o que já foi capturado em vez de jogar tudo fora.
        onLog(
          `${MAX_JANELAS_FALHAS_SEGUIDAS} janelas seguidas falharam. Parando a busca aqui. ` +
            `O que já foi capturado até agora (${todasAsDatas.length} data(s)) foi preservado.`,
        );
        break;
      }
    }

    janelaInicio = new Date(janelaFim);
    janelaInicio.setDate(janelaFim.getDate() + 1);
    numeroJanela++;
  }

  onProgresso(1);
  onLog(`Busca do ano completa! Total de ${todasAsDatas.length} datas capturadas.`);
  if (janelasComFalha.length > 0) {
    onLog(`${janelasComFalha.length} janela(s) falharam e foram puladas.`);
  }
  return { dias: todasAsDatas, janelasComFalha, interrompidaPorVoce };
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
