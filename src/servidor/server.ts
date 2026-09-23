import crypto, { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  construirRelatorio,
  iniciarSessao,
  pesquisarAnoCompleto,
  TETO_ECONOMICA_K_PADRAO,
  TETO_EXECUTIVA_K_PADRAO,
  type Relatorio,
  type Sessao,
  type TetosTap,
} from "../fontes/tap/bot-tap.ts";
import {
  construirRelatorioSeatspy,
  iniciarSessaoSeatspy,
  NOME_COMPANHIA,
  pesquisarSeatspy,
  type CompanhiaSeatspy,
  type SecaoSeatspy,
  type SessaoSeatspy,
  type TetosSeatspy,
} from "../fontes/seatspy/bot-seatspy.ts";
import {
  CABINE_AA_LABEL,
  MAX_PASSAGEIROS_AA,
  construirRelatorioAA,
  iniciarSessaoAA,
  pesquisarAnoAA,
  type CabineAA,
  type SessaoAA,
} from "../fontes/aa/bot-aa.ts";
import {
  confirmarParEmMilhas,
  construirRelatorioLatam,
  escolherMelhoresPares,
  filtrarPorTetos,
  iniciarSessaoLatam,
  pesquisarAnoLatam,
  type ConfirmacaoPar,
  type SessaoLatam,
  type TetosLatam,
} from "../fontes/latam/bot-latam.ts";
import { formatarListaPorMes, type SecaoRelatorio } from "../nucleo/comum.ts";
import { DIR_PLANILHAS, DIR_PUBLICO } from "../nucleo/caminhos.ts";
import { PoolSessoes } from "../nucleo/pool-sessoes.ts";
import { fecharSessaoChrome, sessaoViva } from "../nucleo/sessao-chrome.ts";
import {
  construirRelatorioSmiles,
  iniciarSessaoSmiles,
  pesquisarAnoSmiles,
  type SessaoSmiles,
  type PeriodoSmiles,
  type TetosSmiles,
} from "../fontes/smiles/bot-smiles.ts";
import {
  construirRelatorioIberia,
  detalharDias as detalharDiasIberia,
  filtrarVoos,
  iniciarSessaoIberia,
  linkEmissaoIberia,
  pesquisarAnoIberia,
  type FiltrosVoo,
  type SessaoIberia,
} from "../fontes/iberia/bot-iberia.ts";
import { DIR_ALERTAS, DIR_PORTAL_DIST, gerarAlerta, type PedidoAlerta } from "../saidas/alertas.ts";
import {
  criarPlanilhaDaBusca,
  gravarCsvDeVoos,
  registrarBusca,
  type LinhaVoo,
  type PernaParaPlanilha,
} from "../saidas/planilha.ts";

// A extração de preços lê as 4 cores (Economy/PremiumEconomy/Business/First)
// de cada dia independente do valor de "cabins" mandado na URL — então o
// relatório sempre traz executiva e econômica juntas nessa mesma busca, e o
// valor abaixo é só o que a busca em si exige pra funcionar.
const CABINE_PARAM_PADRAO = "Economy";


type InfoJanela = { atual: number; total: number; inicio: string; fim: string };

type PernaSeatspy = { rotulo: string; secoes: SecaoSeatspy[] };

// Resultado da fase 2 da LATAM: os melhores pares de datas confirmados em
// milhas, cada um com a escada de combinações milhas+dinheiro que a LATAM
// oferece pro par.
type ConfirmacaoLatam = { pares: ConfirmacaoPar[] };

type Job = {
  status: "fila" | "running" | "done" | "erro";
  progresso: number; // 0..1
  janela?: InfoJanela;
  avisoAtual?: string; // aviso transitório (ex.: cooldown de bloqueio) — "" = sem aviso
  relatorio?: Relatorio;
  avisoParcial?: string; // preenchido quando alguma janela falhou e foi pulada
  pernas?: PernaSeatspy[]; // resultado das buscas via SeatSpy
  secaoAA?: SecaoRelatorio & { rotulo: string }; // resultado das buscas na AA (uma cabine por busca)
  secaoIberia?: SecaoRelatorio & { rotulo: string }; // Iberia: um valor por dia, sem dimensão de cabine
  confirmacao?: ConfirmacaoLatam; // confirmação em milhas do melhor par (LATAM)
  planilhaUrl?: string; // planilha da busca (uma nova por busca — ver planilha.ts)
  tetosAplicados?: { executivaK: number; economicaK: number }; // guardado pra sobreviver a um F5
  // Pergunta em aberto: a busca fica parada esperando resposta da tela. Fica
  // guardada no job pra continuar existindo depois de um F5 — senão a busca
  // esperaria por uma pergunta que ninguém mais vê.
  interrompidaPorVoce?: boolean; // você mandou parar: a perna seguinte nem começa
  cancelado?: boolean; // pedido de parada: a busca encerra no próximo ponto seguro
  pergunta?: { id: string; mensagem: string } | undefined;
  responder?: ((continuar: boolean) => void) | undefined;
  erro?: string;
  ouvintes: Set<Response>;
};

const jobs = new Map<string, Job>();

// Quantas buscas de cada fonte podem rodar ao mesmo tempo (cada uma numa
// janela do navegador própria, já logada). Buscas além disso ficam na fila
// até um slot liberar — ver PoolSessoes.
const CONCORRENCIA_AWARDTOOL = Number(process.env.CONCORRENCIA_AWARDTOOL) || 3;
const CONCORRENCIA_SEATSPY = Number(process.env.CONCORRENCIA_SEATSPY) || 3;
// AA: sem login, mas o Akamai olha o IP — começa mais conservador.
const CONCORRENCIA_AA = Number(process.env.CONCORRENCIA_AA) || 2;
// LATAM também depende da janela do bot (Chrome real) — mesma prudência.
const CONCORRENCIA_LATAM = Number(process.env.CONCORRENCIA_LATAM) || 2;
// Smiles: sem login, mas a chamada sai de dentro do navegador (ver bot-smiles)
// e uma varredura de ano já são ~112 requisições — mesma prudência.
const CONCORRENCIA_SMILES = Number(process.env.CONCORRENCIA_SMILES) || 2;
// Iberia: login que cai sozinho em poucos minutos e um site que já cortou
// rajada uma vez — a mais conservadora das fontes com navegador.
const CONCORRENCIA_IBERIA = Number(process.env.CONCORRENCIA_IBERIA) || 1;

// Minutos sem uso até o slot fechar a sessão e devolver a RAM. Uma sessão do
// SeatSpy parada custa ~450 MB, e o servidor costuma ficar dias de pé; reabrir
// custa ~6s, pagos uma vez por rajada de buscas. 0 desliga o fechamento.
const OCIOSIDADE_MINUTOS = lerOciosidadeMinutos();

function lerOciosidadeMinutos(): number {
  const bruto = process.env.OCIOSIDADE_MINUTOS;
  if (bruto === undefined || bruto.trim() === "") return 10;
  const minutos = Number(bruto);
  // Sem isso, "dez" viraria NaN e o timer dispararia na hora: toda busca pagaria
  // a reabertura e nada no log diria o porquê.
  if (!Number.isFinite(minutos) || minutos < 0) {
    throw new Error(`OCIOSIDADE_MINUTOS inválido: "${bruto}". Use minutos (ex.: 10) ou 0 para desligar.`);
  }
  return minutos;
}

const poolAwardtool = new PoolSessoes<Sessao>({
  rotulo: "awardtool",
  tamanho: CONCORRENCIA_AWARDTOOL,
  criarSessao: (headless) => iniciarSessao(headless),
  sessaoViva: (s) => s.browser.isConnected() && !s.page.isClosed(),
  fecharSessao: (s) => s.browser.close(),
  minutosOcioso: OCIOSIDADE_MINUTOS,
});

// Mesma ideia, mas pro SeatSpy (site próprio, login próprio — independente
// das sessões do AwardTool).
const poolSeatspy = new PoolSessoes<SessaoSeatspy>({
  rotulo: "seatspy",
  tamanho: CONCORRENCIA_SEATSPY,
  criarSessao: (headless) => iniciarSessaoSeatspy(headless),
  sessaoViva: (s) => s.browser.isConnected() && !s.page.isClosed(),
  fecharSessao: (s) => s.browser.close(),
  minutosOcioso: OCIOSIDADE_MINUTOS,
});

// A sessão da AA pode ser uma aba no Chrome do próprio usuário (ver
// iniciarSessaoAA) — daí o browser poder ser null e a checagem olhar a aba.
// AA, LATAM e Smiles dividem o mesmo Chrome, então a ociosidade fecha só a
// aba de cada slot (ver fecharSessaoChrome).
const poolAA = new PoolSessoes<SessaoAA>({
  rotulo: "aa",
  tamanho: CONCORRENCIA_AA,
  criarSessao: (headless) => iniciarSessaoAA(headless),
  sessaoViva,
  fecharSessao: fecharSessaoChrome,
  minutosOcioso: OCIOSIDADE_MINUTOS,
});

const poolLatam = new PoolSessoes<SessaoLatam>({
  rotulo: "latam",
  tamanho: CONCORRENCIA_LATAM,
  criarSessao: (headless) => iniciarSessaoLatam(headless),
  sessaoViva,
  fecharSessao: fecharSessaoChrome,
  minutosOcioso: OCIOSIDADE_MINUTOS,
});

const poolSmiles = new PoolSessoes<SessaoSmiles>({
  rotulo: "smiles",
  tamanho: CONCORRENCIA_SMILES,
  criarSessao: (headless) => iniciarSessaoSmiles(headless),
  sessaoViva,
  fecharSessao: fecharSessaoChrome,
  minutosOcioso: OCIOSIDADE_MINUTOS,
});

const poolIberia = new PoolSessoes<SessaoIberia>({
  rotulo: "iberia",
  tamanho: CONCORRENCIA_IBERIA,
  criarSessao: (headless) => iniciarSessaoIberia(headless),
  sessaoViva,
  fecharSessao: fecharSessaoChrome,
  minutosOcioso: OCIOSIDADE_MINUTOS,
});

function emitirEvento(jobId: string, dado: object) {
  const job = jobs.get(jobId);
  if (!job) return;
  const linha = `data: ${JSON.stringify(dado)}\n\n`;
  for (const res of job.ouvintes) {
    res.write(linha);
  }
}

function atualizarProgresso(jobId: string, fracao: number) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.progresso = fracao;
  emitirEvento(jobId, { tipo: "progresso", fracao });
}

function atualizarJanela(jobId: string, info: InfoJanela) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.janela = info;
  emitirEvento(jobId, { tipo: "janela", ...info });
}

function atualizarAviso(jobId: string, mensagem: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.avisoAtual = mensagem;
  emitirEvento(jobId, { tipo: "aviso", mensagem });
}

// Esqueleto comum dos jobs: espera um slot do pool, marca o job como rodando,
// executa o trabalho da fonte e trata erro/limpeza — o que muda entre as
// fontes é só o miolo (a função `trabalho`), que deve setar job.status "done"
// e emitir o evento "done" com o payload próprio dela.
async function executarComPool<S>(
  pool: PoolSessoes<S>,
  jobId: string,
  trabalho: (sessao: S) => Promise<void>,
) {
  const job = jobs.get(jobId)!;
  let indiceSlot = -1;
  try {
    // Cancelar enquanto está na fila é imediato: nem chega a ocupar um slot do
    // navegador nem a tocar no site.
    if (job.cancelado) return encerrarCancelado(jobId);
    const { sessao, indice } = await pool.adquirir();
    indiceSlot = indice;
    if (job.cancelado) {
      pool.liberar(indice);
      return encerrarCancelado(jobId);
    }
    job.status = "running";
    emitirEvento(jobId, { tipo: "iniciou" });
    await trabalho(sessao);
  } catch (err) {
    const mensagemOriginal = err instanceof Error ? err.message : String(err);
    if (job.cancelado) return encerrarCancelado(jobId);
    const fechouNoMeio = /Target page, context or browser has been closed/i.test(mensagemOriginal);
    job.status = "erro";
    job.erro = fechouNoMeio
      ? "A janela do navegador foi fechada durante a busca. Tente buscar de novo."
      : mensagemOriginal;
    emitirEvento(jobId, { tipo: "erro", mensagem: job.erro });
  } finally {
    if (indiceSlot !== -1) pool.liberar(indiceSlot);
    for (const res of job.ouvintes) res.end();
  }
}

// Toda busca concluída vira linhas na planilha (ver planilha.ts). Fica no
// servidor, e não em cada bot, porque é aqui que as cinco fontes já convergem
// pro mesmo SecaoRelatorio. Falha de registro nunca derruba a busca.
function registrarNaPlanilha(
  jobId: string,
  dados: {
    fonte: string;
    origem: string;
    destino: string;
    pernas: PernaParaPlanilha[];
    tetos?: Record<string, number | null | undefined>;
  },
) {
  void registrarBusca({ ...dados, busca: jobId }, (msg) => console.log(`[${jobId}] ${msg}`));
}

// Quanto tempo uma pergunta fica de pé antes de desistir. Sem isso, uma aba
// fechada seguraria um slot do navegador pra sempre. Ao expirar, para a busca:
// devolver parcial é melhor que ocupar recurso indefinidamente.
const ESPERA_RESPOSTA_MS = Number(process.env.ESPERA_RESPOSTA_MS) || 15 * 60_000;

// Quantos pares de datas confirmar em milhas na LATAM. Cada par é um fluxo
// completo no site (deep link → escolhe ida → escolhe volta), então subir isso
// custa tempo e sessão.
const PARES_LATAM = Number(process.env.LATAM_PARES) || 3;

// Parada pedida pela tela. Vira "erro" com mensagem própria porque o front já
// sabe encerrar o card nesse caso; o que muda é o texto, que precisa deixar
// claro que ninguém falhou.
function encerrarCancelado(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "erro";
  job.erro = "Busca cancelada.";
  emitirEvento(jobId, { tipo: "erro", mensagem: job.erro });
}

// O período chega do formulário como mês (AAAA-MM) ou data (AAAA-MM-DD). Aqui
// vira data: o mês inicial começa no dia 1, o final termina no último dia.
// Valor inválido é ignorado, não corrigido no chute: quem valida de verdade é
// `limitesDoPeriodo`, que conhece as regras da varredura.
function periodoDe(cru: unknown): PeriodoSmiles {
  const p = cru as { de?: unknown; ate?: unknown } | undefined;
  const comoData = (v: unknown, fimDoMes: boolean): string | undefined => {
    if (typeof v !== "string") return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    if (!/^\d{4}-\d{2}$/.test(v)) return undefined;
    if (!fimDoMes) return `${v}-01`;
    const [ano, mes] = v.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
  };
  const periodo: PeriodoSmiles = {};
  const de = comoData(p?.de, false);
  const ate = comoData(p?.ate, true);
  if (de) periodo.de = de;
  if (ate) periodo.ate = ate;
  return periodo;
}

function perguntarAoUsuario(jobId: string, mensagem: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job) return Promise.resolve(false);

  const id = `${jobId}-${Date.now()}`;
  job.pergunta = { id, mensagem };
  emitirEvento(jobId, { tipo: "pergunta", id, mensagem });

  return new Promise<boolean>((resolve) => {
    let jaRespondeu = false;
    const encerrar = (continuar: boolean) => {
      if (jaRespondeu) return;
      jaRespondeu = true;
      clearTimeout(prazo);
      job.pergunta = undefined;
      job.responder = undefined;
      emitirEvento(jobId, { tipo: "respondida", id, continuar });
      resolve(continuar);
    };
    const prazo = setTimeout(() => {
      console.log(`[${jobId}] ninguém respondeu em ${Math.round(ESPERA_RESPOSTA_MS / 60000)} min. Parando a busca.`);
      encerrar(false);
    }, ESPERA_RESPOSTA_MS);
    job.responder = encerrar;
  });
}

function executarJob(jobId: string, params: { origem: string; destino: string; tetos: TetosTap }) {
  return executarComPool(poolAwardtool, jobId, async ({ page, baseUrl }) => {
    const job = jobs.get(jobId)!;
    const { dias: todasAsDatas, janelasComFalha, interrompidaPorVoce } = await pesquisarAnoCompleto(
      page,
      {
        baseUrl,
        origem: params.origem,
        destino: params.destino,
        cabineParam: CABINE_PARAM_PADRAO,
      },
      (msg) => console.log(`[${jobId}] ${msg}`), // só no terminal do servidor, não vai pro front
      (fracao) => atualizarProgresso(jobId, fracao),
      (info) => atualizarJanela(jobId, info),
      (mensagem) => atualizarAviso(jobId, mensagem),
      (mensagem) => perguntarAoUsuario(jobId, mensagem),
      () => job.cancelado === true,
    );

    const relatorio = construirRelatorio(todasAsDatas, params.tetos);
    // Vai pro front pra deixar explícito qual teto valeu de fato — sem isso,
    // um servidor rodando código antigo aplicaria o padrão silenciosamente.
    const tetosAplicados = {
      executivaK: params.tetos.executivaK ?? TETO_EXECUTIVA_K_PADRAO,
      economicaK: params.tetos.economicaK ?? TETO_ECONOMICA_K_PADRAO,
    };
    // Parar por decisão sua também produz resultado parcial — e isso precisa
    // estar escrito, senão o relatório curto passa por busca completa.
    const avisoParcial = interrompidaPorVoce
      ? "Você interrompeu a busca depois das janelas vazias. O resultado abaixo cobre só o período já consultado."
      : janelasComFalha.length > 0
        ? `${janelasComFalha.length} janela(s) não puderam ser buscadas (ver detalhes no terminal do servidor). O resultado abaixo é parcial.`
        : undefined;
    job.status = "done";
    job.relatorio = relatorio;
    if (avisoParcial) job.avisoParcial = avisoParcial;
    registrarNaPlanilha(jobId, {
      fonte: "tap",
      origem: params.origem,
      destino: params.destino,
      pernas: [
        {
          rotulo: `${params.origem} → ${params.destino}`,
          secoes: [
            { ...relatorio.executivas, rotulo: "Executiva" },
            { ...relatorio.economicas, rotulo: "Econômica" },
          ],
        },
      ],
      tetos: { Executiva: tetosAplicados.executivaK, "Econômica": tetosAplicados.economicaK },
    });
    job.tetosAplicados = tetosAplicados;
    if (interrompidaPorVoce) job.interrompidaPorVoce = true;
    emitirEvento(jobId, { tipo: "done", relatorio, avisoParcial, tetosAplicados, interrompidaPorVoce });
  });
}

// Uma busca "Return" no SeatSpy já traz ida e volta juntas (e consome um
// crédito só), então o job resolve as duas pernas de uma vez — diferente do
// fluxo da TAP, em que o front pede uma perna por vez.
function executarJobSeatspy(
  jobId: string,
  params: {
    companhia: CompanhiaSeatspy;
    origem: string;
    destino: string;
    idaEVolta: boolean;
    tetos: TetosSeatspy;
    mostrarAssentos: boolean;
  },
) {
  return executarComPool(poolSeatspy, jobId, async ({ page }) => {
    const job = jobs.get(jobId)!;
    const { ida, volta } = await pesquisarSeatspy(
      page,
      params,
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
    );

    const pernas: PernaSeatspy[] = [
      {
        rotulo: params.idaEVolta
          ? `Ida: ${params.origem} → ${params.destino}`
          : `${params.origem} → ${params.destino}`,
        secoes: construirRelatorioSeatspy(ida, params.tetos, params.mostrarAssentos).secoes,
      },
    ];
    if (volta) {
      pernas.push({
        rotulo: `Volta: ${params.destino} → ${params.origem}`,
        secoes: construirRelatorioSeatspy(volta, params.tetos, params.mostrarAssentos).secoes,
      });
    }

    job.status = "done";
    job.pernas = pernas;
    registrarNaPlanilha(jobId, {
      fonte: params.companhia,
      origem: params.origem,
      destino: params.destino,
      pernas,
      tetos: {
        "Econômica": params.tetos.economica,
        Premium: params.tetos.premium,
        Executiva: params.tetos.executiva,
        "Primeira Classe": params.tetos.primeira,
      },
    });
    emitirEvento(jobId, { tipo: "done", pernas });
  });
}

// AA: uma cabine por busca (escolhida no form) e uma direção por job — o
// front pede a volta como um segundo job, igual ao fluxo da TAP.
function executarJobAA(
  jobId: string,
  params: {
    origem: string;
    destino: string;
    cabine: CabineAA;
    maxConexoes: number | null;
    tetoMilhas: number | null;
    passageiros: number;
  },
) {
  return executarComPool(poolAA, jobId, async ({ page }) => {
    const job = jobs.get(jobId)!;
    const { dias, mesesComFalha } = await pesquisarAnoAA(
      page,
      {
        origem: params.origem,
        destino: params.destino,
        cabine: params.cabine,
        maxConexoes: params.maxConexoes,
        passageiros: params.passageiros,
      },
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
      (mensagem) => atualizarAviso(jobId, mensagem),
      () => job.cancelado === true,
    );

    const secao = {
      rotulo: CABINE_AA_LABEL[params.cabine],
      // Com os parâmetros, cada dia sai com o link de emissão daquela data.
      ...construirRelatorioAA(dias, params.tetoMilhas, {
        origem: params.origem,
        destino: params.destino,
        passageiros: params.passageiros,
        cabine: params.cabine,
      }),
    };
    // O motivo da primeira falha vai junto: sem ele o usuário via só "parcial"
    // e teria que abrir o terminal do servidor pra saber se foi bloqueio, rota
    // errada ou pedido recusado.
    const avisoParcial =
      mesesComFalha.length > 0
        ? `${mesesComFalha.length} mês(es) não puderam ser buscados. O resultado abaixo é parcial. ` +
          `Primeira falha (${mesesComFalha[0]!.mes}): ${mesesComFalha[0]!.erro}`
        : undefined;
    job.status = "done";
    job.secaoAA = secao;
    if (avisoParcial) job.avisoParcial = avisoParcial;
    registrarNaPlanilha(jobId, {
      fonte: "AA",
      origem: params.origem,
      destino: params.destino,
      pernas: [{ rotulo: `${params.origem} → ${params.destino}`, secoes: [secao] }],
      tetos: { [secao.rotulo]: params.tetoMilhas },
    });
    emitirEvento(jobId, { tipo: "done", secaoAA: secao, avisoParcial });
  });
}

// Iberia: uma direção por job, como AA e Smiles. Sem seletor de cabine — a
// grade de Avios devolve um valor por dia, o mais barato, sem dizer de qual
// cabine ele é (ver `contexto/notas-recon-iberia.md`, seções 10 e 13).
function executarJobIberia(
  jobId: string,
  params: {
    origem: string;
    destino: string;
    tetoAvios: number | null;
    passageiros: number;
    // Quantos dias (os mais baratos) detalhar voo a voo. 0 desliga. Cada dia
    // custa um carregamento de página, então isto é o que separa uma busca de
    // 40 segundos de uma de vários minutos.
    detalharDias: number;
    filtros: FiltrosVoo;
  },
) {
  return executarComPool(poolIberia, jobId, async ({ page }) => {
    const job = jobs.get(jobId)!;
    const resultado = await pesquisarAnoIberia(
      page,
      { origem: params.origem, destino: params.destino, passageiros: params.passageiros },
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
      (mensagem) => atualizarAviso(jobId, mensagem),
      () => job.cancelado === true,
    );

    // Cada caso do resultado vira uma saída diferente na tela. "Erro" nunca
    // desce como relatório vazio: o usuário precisa saber que a busca não saiu.
    if (resultado.tipo === "erro") throw new Error(resultado.motivo);

    const dias = resultado.tipo === "sem_disponibilidade" ? [] : resultado.dias;
    const secao = {
      rotulo: "Avios",
      ...construirRelatorioIberia(dias, params.tetoAvios, {
        origem: params.origem,
        destino: params.destino,
        passageiros: params.passageiros,
      }),
    };
    const avisoParcial =
      resultado.tipo === "parcial"
        ? `Cobertura parcial: ${resultado.motivo}`
        : undefined;

    // Planilha por voo: é o que diz QUAL voo e QUAL companhia opera o dia — a
    // grade só dá data e preço. Falha aqui não derruba o resultado de datas,
    // que já está pronto.
    let planilhaUrl: string | null = null;
    const avisosPlanilha: string[] = [];
    if (params.detalharDias > 0 && secao.dias.length > 0) {
      const aviosPorData = new Map(dias.map((d) => [d.data, d.avios]));
      const escolhidos = [...secao.dias]
        .sort((a, b) => (aviosPorData.get(a.data) ?? 0) - (aviosPorData.get(b.data) ?? 0))
        .slice(0, params.detalharDias)
        .map((d) => d.data);
      if (secao.dias.length > escolhidos.length) {
        avisosPlanilha.push(
          `A planilha de voos traz os ${escolhidos.length} dia(s) mais baratos; ` +
            `os outros ${secao.dias.length - escolhidos.length} ficaram sem detalhe.`,
        );
      }

      const { voos, diasComFalha } = await detalharDiasIberia(
        page,
        { origem: params.origem, destino: params.destino, passageiros: params.passageiros },
        escolhidos,
        (msg) => console.log(`[${jobId}] ${msg}`),
        (fracao) => atualizarProgresso(jobId, 0.7 + 0.3 * fracao),
        () => job.cancelado === true,
      );
      if (diasComFalha.length > 0) {
        avisosPlanilha.push(
          `${diasComFalha.length} dia(s) não puderam ser detalhados. ` +
            `Primeira falha (${diasComFalha[0]!.data}): ${diasComFalha[0]!.erro}`,
        );
      }

      const filtrados = filtrarVoos(voos, params.filtros);
      if (voos.length > filtrados.length) {
        avisosPlanilha.push(`${voos.length - filtrados.length} voo(s) ficaram fora pelos filtros pedidos.`);
      }

      const linhas: LinhaVoo[] = filtrados.map((v) => ({
        departure_date: v.data,
        arrival_date: v.chegadaData,
        departure_station: v.origem,
        departure_time: v.partidaHora,
        arrival_station: v.destino,
        connections: v.escalas,
        connecting_airports: v.aeroportosConexao,
        points: "", // a Iberia não dá preço por voo; o do dia vai em day_avios
        duration: v.duracaoMinutos,
        cabin_category: v.cabines,
        operation_carriers: v.companhias,
        program: "IBERIA",
        source_fare: v.tarifa,
        available_seats: v.assentos ?? "",
        aircraft: v.aeronaves,
        tax: "",
        class_of_service: v.classesServico,
        url: linkEmissaoIberia(
          { origem: params.origem, destino: params.destino, passageiros: params.passageiros },
          v.data,
        ),
        day_avios: aviosPorData.get(v.data) ?? "",
      }));

      if (linhas.length > 0) {
        const carimbo = new Date().toISOString().slice(0, 16).replace("T", " ");
        try {
          gravarCsvDeVoos(
            linhas,
            path.join(
              DIR_PLANILHAS,
              `iberia-${params.origem}-${params.destino}-${carimbo.replace(/[: ]/g, "-")}.csv`,
            ),
          );
        } catch (err) {
          avisosPlanilha.push(`Não consegui gravar o CSV de voos: ${err instanceof Error ? err.message : String(err)}`);
        }
        planilhaUrl = await criarPlanilhaDaBusca(
          { titulo: `Iberia ${params.origem}-${params.destino} ${carimbo}`, linhas },
          (msg) => console.log(`[${jobId}] ${msg}`),
        );
      } else {
        avisosPlanilha.push("Nenhum voo sobrou depois dos filtros — a planilha de voos não foi gerada.");
      }
    }

    const avisoFinal = [avisoParcial, ...avisosPlanilha].filter(Boolean).join(" ") || undefined;

    job.status = "done";
    job.secaoIberia = secao;
    if (avisoFinal) job.avisoParcial = avisoFinal;
    if (planilhaUrl) job.planilhaUrl = planilhaUrl;
    registrarNaPlanilha(jobId, {
      fonte: "IBERIA",
      origem: params.origem,
      destino: params.destino,
      pernas: [{ rotulo: `${params.origem} → ${params.destino}`, secoes: [secao] }],
      tetos: { Avios: params.tetoAvios == null ? null : Math.round(params.tetoAvios / 10) / 100 },
    });
    emitirEvento(jobId, { tipo: "done", secaoIberia: secao, avisoParcial: avisoFinal, planilhaUrl });
  });
}

// Smiles: uma direção por job (o endpoint é de ida simples), com as três
// cabines juntas — o front pede a volta como um segundo job, igual à AA.
function executarJobSmiles(
  jobId: string,
  params: { origem: string; destino: string; tetos: TetosSmiles; periodo: PeriodoSmiles },
) {
  return executarComPool(poolSmiles, jobId, async ({ page }) => {
    const job = jobs.get(jobId)!;
    const { dias, diasComFalha, lacunas, doCache } = await pesquisarAnoSmiles(
      page,
      { origem: params.origem, destino: params.destino },
      params.tetos,
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
      () => job.cancelado === true,
      params.periodo,
    );

    const pernas: PernaSeatspy[] = [
      {
        rotulo: `${params.origem} → ${params.destino}`,
        secoes: construirRelatorioSmiles(dias, params.tetos),
      },
    ];

    // As lacunas vêm prontas em português do próprio bot: é ele que sabe o que
    // deixou de cobrir. O servidor só junta com as falhas de dia.
    const partes = [...lacunas];
    if (diasComFalha.length > 0) {
      partes.push(`${diasComFalha.length} dia(s) falharam. O primeiro foi ${diasComFalha[0]!.data}: ${diasComFalha[0]!.erro}`);
    }
    // Dado de cache não é dado desta hora. Dizer quantos dias vieram de lá é o
    // que separa "economizei consulta" de "mostrei preço vencido sem avisar".
    if (doCache > 0) {
      partes.push(`${doCache} dia(s) vieram de consulta recente reaproveitada, não de agora`);
    }
    const avisoParcial = partes.length > 0 ? `Cobertura parcial. ${partes.join("; ")}.` : undefined;

    // Planilha própria da busca, no formato do bot antigo (uma linha por voo).
    // Falha aqui não derruba nada: o resultado já está pronto.
    const linhasVoo: LinhaVoo[] = [];
    for (const dia of dias) {
      for (const voo of dia.voos) {
        const d = voo.detalhe;
        linhasVoo.push({
          departure_date: d.partidaData,
          arrival_date: d.chegadaData,
          departure_station: d.partidaAeroporto,
          departure_time: d.partidaHora,
          arrival_station: d.chegadaAeroporto,
          connections: voo.conexoes,
          connecting_airports: d.aeroportosConexao,
          points: voo.milhas,
          duration: d.duracaoMinutos,
          cabin_category: d.cabineCru,
          operation_carriers: d.codigoCompanhia,
          program: "SMILES",
          source_fare: voo.tarifa,
          available_seats: voo.assentos,
          aircraft: d.aeronaves,
          tax: voo.taxaReais ?? "",
          class_of_service: d.classesServico,
          url: urlBuscaSmiles(params.origem, params.destino, d.partidaData),
        });
      }
    }
    const planilhaUrl = await criarPlanilhaDaBusca(
      { titulo: `Smiles ${params.origem}-${params.destino} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, linhas: linhasVoo },
      (msg) => console.log(`[${jobId}] ${msg}`),
    );

    job.status = "done";
    job.pernas = pernas;
    if (avisoParcial) job.avisoParcial = avisoParcial;
    if (planilhaUrl) job.planilhaUrl = planilhaUrl;
    registrarNaPlanilha(jobId, {
      fonte: "SMILES",
      origem: params.origem,
      destino: params.destino,
      pernas,
      tetos: {
        "Econômica": params.tetos.economica,
        Conforto: params.tetos.premium,
        Executiva: params.tetos.executiva,
      },
    });
    emitirEvento(jobId, { tipo: "done", pernas, avisoParcial, planilhaUrl });
  });
}

// Link da busca no site do Smiles, pra a planilha levar direto ao voo.
function urlBuscaSmiles(origem: string, destino: string, data: string): string {
  const ts = `${Date.parse(`${data}T12:00:00Z`)}`;
  const q = new URLSearchParams({
    adults: "1",
    cabin: "ALL",
    children: "0",
    departureDate: ts,
    infants: "0",
    tripType: "2",
    originAirport: origem,
    destinationAirport: destino,
  });
  return `https://www.smiles.com.br/mfe/emissao-passagem/?${q}`;
}

// A LATAM devolve ida e volta na mesma resposta do calendário, então o job
// resolve as duas pernas de uma vez (como o SeatSpy, e diferente da TAP/AA).
function executarJobLatam(
  jobId: string,
  params: {
    origem: string;
    destino: string;
    tetos: TetosLatam;
    confirmarMilhas: boolean;
    margemIdaReais: number;
    margemVoltaReais: number;
  },
) {
  return executarComPool(poolLatam, jobId, async ({ page, context }) => {
    const job = jobs.get(jobId)!;
    const { ida, volta, mesesComFalha } = await pesquisarAnoLatam(
      page,
      { origem: params.origem, destino: params.destino },
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
      (mensagem) => atualizarAviso(jobId, mensagem),
      () => job.cancelado === true,
    );

    const pernas: PernaSeatspy[] = [
      { rotulo: `Ida: ${params.origem} → ${params.destino}`, secoes: [{ rotulo: "Econômica", corClasse: "cartao-economica", ...construirRelatorioLatam(ida, params.tetos) }] },
      { rotulo: `Volta: ${params.destino} → ${params.origem}`, secoes: [{ rotulo: "Econômica", corClasse: "cartao-economica", ...construirRelatorioLatam(volta, params.tetos) }] },
    ];
    let avisoParcial =
      mesesComFalha.length > 0
        ? `${mesesComFalha.length} período(s) não puderam ser buscados. O resultado abaixo é parcial.`
        : undefined;

    // Fase 2: confirma em milhas os melhores pares de datas. O preço do PAR não
    // é a soma das pernas — perna a perna a LATAM cobrou 243.535 milhas num par
    // que, comprado junto, sai por 90.302.
    let confirmacao: ConfirmacaoLatam | undefined;
    let avisoConfirmacao: string | undefined;
    if (params.confirmarMilhas) {
      try {
      // Só os dias que passaram nos tetos: a confirmação simula uma busca do
      // grupo, e o grupo só vê o que está no cartão.
      const pares = escolherMelhoresPares(
        filtrarPorTetos(ida, params.tetos),
        filtrarPorTetos(volta, params.tetos),
        PARES_LATAM,
        params.margemIdaReais,
        params.margemVoltaReais,
      );
      if (pares.length === 0) {
        avisoConfirmacao =
          "Nenhum par de ida e volta no resultado com 3 a 14 dias de viagem dentro da faixa de preço. " +
          "Confirmação em milhas não executada.";
      } else {
        const pasta = `latam-${params.origem}-${params.destino}-${Date.now()}`;
        fs.mkdirSync(path.join(DIR_ALERTAS, pasta), { recursive: true });

        const confirmados: ConfirmacaoPar[] = [];
        const falhas: string[] = [];
        for (const [i, par] of pares.entries()) {
          atualizarAviso(jobId, `Confirmando par ${i + 1}/${pares.length}. ${par.ida.data} → ${par.volta.data}...`);
          const arquivo = `par-${i + 1}.png`;
          try {
            const c = await confirmarParEmMilhas(
              page,
              {
                origem: params.origem,
                destino: params.destino,
                dataIda: par.ida.data,
                dataVolta: par.volta.data,
                caminhoImagem: path.join(DIR_ALERTAS, pasta, arquivo),
              },
              (msg) => console.log(`[${jobId}] ${msg}`),
              // Pedido de login vira aviso na tela: é a única forma de o usuário
              // saber que a busca está parada esperando ele na janela do bot.
              (mensagem) => atualizarAviso(jobId, mensagem),
            );
            if (c) {
              confirmados.push({
                ...c,
                imagem: c.imagem ? `/alertas/${pasta}/${arquivo}` : "",
                // Datas já no formato que o gerador de alertas parseia, montadas
                // com o mesmo formatador das outras fontes.
                textoIda: formatarListaPorMes([c.dataIda]),
                textoVolta: formatarListaPorMes([c.dataVolta]),
              });
            }
            else falhas.push(`${par.ida.data} → ${par.volta.data}: sem oferta em milhas`);
          } catch (err) {
            // Um par que falha não derruba os outros: o resultado sai parcial e
            // diz quais pares ficaram de fora.
            const motivo = err instanceof Error ? err.message : String(err);
            console.error(`[${jobId}] par ${par.ida.data}→${par.volta.data} falhou: ${motivo}`);
            falhas.push(`${par.ida.data} → ${par.volta.data}: ${motivo}`);
          }
        }
        atualizarAviso(jobId, "");

        if (confirmados.length > 0) {
          confirmacao = { pares: confirmados };
          if (falhas.length > 0) {
            avisoConfirmacao = `Confirmação parcial: ${falhas.length} de ${pares.length} pares sem resultado. ${falhas.join(" · ")}`;
          }
        } else {
          avisoConfirmacao = `Confirmação em milhas sem resultado em nenhum dos ${pares.length} pares: ${falhas.join(" · ")}`;
        }
      }
      } catch (err) {
        // Nada aqui pode derrubar o resultado do calendário: as datas em reais
        // já custaram a varredura inteira e são úteis por si só.
        const mensagem = err instanceof Error ? err.message : String(err);
        console.error(`[${jobId}] confirmação em milhas falhou: ${mensagem}`);
        avisoConfirmacao = `Confirmação em milhas interrompida: ${mensagem}. As datas abaixo permanecem válidas.`;
      }
      atualizarAviso(jobId, "");
    }

    if (avisoConfirmacao) avisoParcial = [avisoParcial, avisoConfirmacao].filter(Boolean).join(" ");

    job.status = "done";
    job.pernas = pernas;
    if (avisoParcial) job.avisoParcial = avisoParcial;
    if (confirmacao) job.confirmacao = confirmacao;
    registrarNaPlanilha(jobId, {
      fonte: "LATAM",
      origem: params.origem,
      destino: params.destino,
      pernas,
      tetos: { "Econômica": params.tetos.tetoReais },
    });
    emitirEvento(jobId, { tipo: "done", pernas, avisoParcial, confirmacao });
  });
}

const app = express();

// Protege o servidor inteiro (front + API) com usuário/senha quando exposto
// publicamente (ex.: via ngrok, pra controlar do celular) — sem isso,
// qualquer um que ache a URL consegue disparar buscas pagas na conta. Sem
// BOT_AUTH_USER/BOT_AUTH_PASS no .env, roda sem senha (uso só local).
const AUTH_USER = process.env.BOT_AUTH_USER;
const AUTH_PASS = process.env.BOT_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req: Request, res: Response, next) => {
    const cabecalho = req.headers.authorization;
    if (cabecalho?.startsWith("Basic ")) {
      const [usuario = "", senha = ""] = Buffer.from(cabecalho.slice(6), "base64")
        .toString()
        .split(":");
      const usuarioOk =
        usuario.length === AUTH_USER.length && crypto.timingSafeEqual(Buffer.from(usuario), Buffer.from(AUTH_USER));
      const senhaOk =
        senha.length === AUTH_PASS.length && crypto.timingSafeEqual(Buffer.from(senha), Buffer.from(AUTH_PASS));
      if (usuarioOk && senhaOk) {
        next();
        return;
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Bot de Emissoes"');
    res.status(401).send("Autenticação necessária.");
  });
} else {
  console.warn(
    "Aviso: BOT_AUTH_USER/BOT_AUTH_PASS não configurados no .env. O servidor fica sem senha. " +
      "Defina os dois antes de expor essa porta publicamente (ex.: via ngrok).",
  );
}

app.use(express.json());
app.use(express.static(DIR_PUBLICO));
// Build do portal de alertas (vcc-alertas-portal) e imagens de alerta já
// geradas — ver alertas.ts.
app.use("/portal", express.static(DIR_PORTAL_DIST));
app.use("/alertas", express.static(DIR_ALERTAS));

// Teto em K (ex.: 181 = 181.000 milhas). Vazio/invalido = usa o padrao.
function tetoKDe(valor: unknown): number | null {
  const num = Number(valor);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function tetoDe(valor: unknown): number | null {
  const num = Number(valor);
  return Number.isFinite(num) && num > 0 ? num : null;
}

// Passageiros é contagem, não teto: precisa ser inteiro e dentro do que a AA
// aceita (1 a 9). Qualquer coisa fora disso vira 1 em vez de derrubar a busca.
function passageirosDe(valor: unknown): number {
  const num = Math.trunc(Number(valor));
  if (!Number.isFinite(num) || num < 1) return 1;
  return Math.min(num, MAX_PASSAGEIROS_AA);
}

app.post("/api/buscar", (req: Request, res: Response) => {
  const { fonte, origem, destino, companhia, idaEVolta, tetos, cabine, maxConexoes, teto } = req.body ?? {};

  if (!origem || !destino) {
    res.status(400).json({ erro: "origem e destino são obrigatórios." });
    return;
  }

  const ehSeatspy = fonte === "seatspy";
  const ehAA = fonte === "aa";
  const ehLatam = fonte === "latam";
  const ehSmiles = fonte === "smiles";
  const ehIberia = fonte === "iberia";
  if (ehSeatspy && !Object.hasOwn(NOME_COMPANHIA, companhia)) {
    res.status(400).json({
      erro: `companhia deve ser uma destas para buscas no SeatSpy: ${Object.keys(NOME_COMPANHIA).join(", ")}.`,
    });
    return;
  }
  if (ehAA && !Object.hasOwn(CABINE_AA_LABEL, cabine)) {
    res.status(400).json({
      erro: `cabine deve ser uma destas para buscas na AA: ${Object.keys(CABINE_AA_LABEL).join(", ")}.`,
    });
    return;
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: "fila", progresso: 0, ouvintes: new Set() });

  if (ehSeatspy) {
    executarJobSeatspy(jobId, {
      companhia,
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      idaEVolta: Boolean(idaEVolta),
      tetos: {
        economica: tetoDe(tetos?.economica),
        premium: tetoDe(tetos?.premium),
        executiva: tetoDe(tetos?.executiva),
        primeira: tetoDe(tetos?.primeira),
      },
      // Padrão é mostrar: quem não manda o campo (uma aba antiga aberta, por
      // exemplo) continua recebendo o relatório com assentos, como antes.
      mostrarAssentos: req.body?.mostrarAssentos !== false,
    });
  } else if (ehLatam) {
    executarJobLatam(jobId, {
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      tetos: {
        tetoReais: tetoDe(tetos?.reais),
        somenteMenorTarifa: Boolean(tetos?.somenteMenorTarifa),
      },
      confirmarMilhas: Boolean(req.body?.confirmarMilhas),
      margemIdaReais: tetoDe(req.body?.margemIdaReais) ?? 100,
      margemVoltaReais: tetoDe(req.body?.margemVoltaReais) ?? 300,
    });
  } else if (ehSmiles) {
    executarJobSmiles(jobId, {
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      tetos: {
        economica: tetoDe(tetos?.economica),
        premium: tetoDe(tetos?.premium),
        executiva: tetoDe(tetos?.executiva),
      },
      periodo: periodoDe(req.body?.periodo),
    });
  } else if (ehIberia) {
    executarJobIberia(jobId, {
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      tetoAvios: tetoDe(teto),
      passageiros: passageirosDe(req.body?.passageiros),
      detalharDias: Math.min(Math.max(Number(req.body?.detalharDias) || 0, 0), 20),
      filtros: {
        maxEscalas: maxConexoes === 0 || maxConexoes === 1 || maxConexoes === 2 ? maxConexoes : null,
        cabines: Array.isArray(req.body?.cabines) && req.body.cabines.length > 0 ? req.body.cabines : null,
      },
    });
  } else if (ehAA) {
    executarJobAA(jobId, {
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      cabine,
      maxConexoes: maxConexoes === 0 || maxConexoes === 1 ? maxConexoes : null,
      tetoMilhas: tetoDe(teto),
      passageiros: passageirosDe(req.body?.passageiros),
    });
  } else {
    executarJob(jobId, {
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      // Tetos em K aqui (a tabela da TAP é falada em K), diferente do SeatSpy
      // e da AA, que trabalham com milhas absolutas.
      tetos: { executivaK: tetoKDe(tetos?.executiva), economicaK: tetoKDe(tetos?.economica) },
    });
  }

  res.json({ jobId });
});

// Gera o alerta pronto pra encaminhar no grupo (imagens do card + legenda)
// a partir do resultado de uma busca — ver alertas.ts.
app.post("/api/alerta", async (req: Request, res: Response) => {
  const { fonte, origem, destino, classe, menorK, maiorK, textoIda, textoVolta } = req.body ?? {};
  if (!origem || !destino || !classe) {
    res.status(400).json({ erro: "origem, destino e classe são obrigatórios." });
    return;
  }

  const pedido: PedidoAlerta = {
    fonte: String(fonte || ""),
    origem: String(origem),
    destino: String(destino),
    classe: String(classe),
    menorK: Number.isFinite(Number(menorK)) && Number(menorK) > 0 ? Number(menorK) : null,
    maiorK: Number.isFinite(Number(maiorK)) && Number(maiorK) > 0 ? Number(maiorK) : null,
    textoIda: String(textoIda || ""),
    textoVolta: String(textoVolta || ""),
  };

  try {
    const alerta = await gerarAlerta(pedido, {
      baseUrl: `http://localhost:${PORTA}`,
      ...(AUTH_USER && AUTH_PASS ? { authUser: AUTH_USER, authPass: AUTH_PASS } : {}),
    });
    res.json(alerta);
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    console.error(`[alerta] falha: ${mensagem}`);
    res.status(500).json({ erro: mensagem });
  }
});

// O front guarda os ids das buscas pra recuperá-las depois de um F5. Se o
// servidor reiniciou no meio, os jobs sumiram da memória — isto é o que o front
// consulta pra descartar o que não existe mais, em vez de abrir um SSE que
// morre com 404.
app.post("/api/buscar/:jobId/cancelar", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ erro: "Busca não existe mais." });
    return;
  }
  if (job.status === "done" || job.status === "erro") {
    res.status(409).json({ erro: "Essa busca já terminou." });
    return;
  }
  job.cancelado = true;
  // Se estava parada esperando resposta de uma pergunta, cancelar responde por
  // você: seguir esperando seguraria um slot do navegador à toa.
  if (job.responder) job.responder(false);
  res.json({ ok: true });
});

app.post("/api/buscar/:jobId/responder", (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ erro: "Busca não existe mais." });
    return;
  }
  if (!job.pergunta || !job.responder) {
    res.status(409).json({ erro: "Não há pergunta em aberto nessa busca." });
    return;
  }
  if (req.body?.id && req.body.id !== job.pergunta.id) {
    // Resposta de uma pergunta antiga (aba velha, clique duplicado): ignora em
    // vez de aplicar na pergunta errada.
    res.status(409).json({ erro: "Essa pergunta já foi respondida." });
    return;
  }
  job.responder(req.body?.continuar === true);
  res.json({ ok: true });
});

app.get("/api/buscar/:jobId/estado", (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ erro: "Busca não existe mais." });
    return;
  }
  res.json({ status: job.status, progresso: job.progresso });
});

app.get("/api/buscar/:jobId/eventos", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Reenvia o estado atual, pra quem conectar atrasado (ex.: busca ainda na
  // fila esperando um slot do pool liberar).
  if (job.status === "fila") {
    res.write(`data: ${JSON.stringify({ tipo: "fila" })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ tipo: "progresso", fracao: job.progresso })}\n\n`);
  if (job.janela) {
    res.write(`data: ${JSON.stringify({ tipo: "janela", ...job.janela })}\n\n`);
  }
  if (job.avisoAtual) {
    res.write(`data: ${JSON.stringify({ tipo: "aviso", mensagem: job.avisoAtual })}\n\n`);
  }
  if (job.pergunta) {
    res.write(`data: ${JSON.stringify({ tipo: "pergunta", ...job.pergunta })}\n\n`);
  }
  if (job.status === "done") {
    // O reenvio precisa carregar tudo que o evento ao vivo carrega — planilha e
    // tetos inclusive. Sem isso, uma busca recuperada depois de um F5 voltava
    // sem o link da planilha e parecia que ela não tinha sido gerada.
    const comum = {
      planilhaUrl: job.planilhaUrl,
      tetosAplicados: job.tetosAplicados,
      interrompidaPorVoce: job.interrompidaPorVoce,
    };
    const dado = job.pernas
      ? { tipo: "done", ...comum, pernas: job.pernas, confirmacao: job.confirmacao }
      : job.secaoIberia
        ? { tipo: "done", ...comum, secaoIberia: job.secaoIberia, avisoParcial: job.avisoParcial }
      : job.secaoAA
        ? { tipo: "done", ...comum, secaoAA: job.secaoAA, avisoParcial: job.avisoParcial }
        : { tipo: "done", ...comum, relatorio: job.relatorio, avisoParcial: job.avisoParcial };
    res.write(`data: ${JSON.stringify(dado)}\n\n`);
    res.end();
    return;
  }
  if (job.status === "erro") {
    res.write(`data: ${JSON.stringify({ tipo: "erro", mensagem: job.erro })}\n\n`);
    res.end();
    return;
  }

  job.ouvintes.add(res);
  req.on("close", () => job.ouvintes.delete(res));
});

const PORTA = process.env.PORT ? parseInt(process.env.PORT, 10) : 5555;
app.listen(PORTA, () => {
  console.log(`Servidor rodando em http://localhost:${PORTA}`);
});
