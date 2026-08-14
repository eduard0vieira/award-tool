import crypto, { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  construirRelatorio,
  iniciarSessao,
  pesquisarAnoCompleto,
  TETO_ECONOMICA_K_PADRAO,
  TETO_EXECUTIVA_K_PADRAO,
  type Relatorio,
  type Sessao,
  type TetosTap,
} from "./bot.ts";
import {
  construirRelatorioSeatspy,
  iniciarSessaoSeatspy,
  NOME_COMPANHIA,
  pesquisarSeatspy,
  type CompanhiaSeatspy,
  type SecaoSeatspy,
  type SessaoSeatspy,
  type TetosSeatspy,
} from "./bot-seatspy.ts";
import {
  CABINE_AA_LABEL,
  MAX_PASSAGEIROS_AA,
  construirRelatorioAA,
  iniciarSessaoAA,
  pesquisarAnoAA,
  type CabineAA,
  type SessaoAA,
} from "./bot-aa.ts";
import {
  confirmarEmMilhas,
  construirRelatorioLatam,
  montarPrintCombinado,
  escolherMelhorPar,
  iniciarSessaoLatam,
  pesquisarAnoLatam,
  type ConfirmacaoMilhas,
  type SessaoLatam,
  type TetosLatam,
} from "./bot-latam.ts";
import type { SecaoRelatorio } from "./comum.ts";
import { PoolSessoes } from "./pool-sessoes.ts";
import { sessaoViva } from "./sessao-chrome.ts";
import {
  construirRelatorioSmiles,
  iniciarSessaoSmiles,
  pesquisarAnoSmiles,
  type SessaoSmiles,
  type TetosSmiles,
} from "./bot-smiles.ts";
import { DIR_ALERTAS, DIR_PORTAL_DIST, gerarAlerta, type PedidoAlerta } from "./alertas.ts";
import { criarPlanilhaDaBusca, registrarBusca, type LinhaVoo, type PernaParaPlanilha } from "./planilha.ts";

// A extração de preços lê as 4 cores (Economy/PremiumEconomy/Business/First)
// de cada dia independente do valor de "cabins" mandado na URL — então o
// relatório sempre traz executiva e econômica juntas nessa mesma busca, e o
// valor abaixo é só o que a busca em si exige pra funcionar.
const CABINE_PARAM_PADRAO = "Economy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type InfoJanela = { atual: number; total: number; inicio: string; fim: string };

type PernaSeatspy = { rotulo: string; secoes: SecaoSeatspy[] };

// Resultado da fase 2 da LATAM: o melhor par de datas confirmado em milhas.
type ConfirmacaoLatam = {
  ida: ConfirmacaoMilhas;
  volta: ConfirmacaoMilhas;
  totalMilhas: number;
  totalTaxas: number;
  imagem: string; // print único com as duas pernas ("" se a captura falhou)
};

type Job = {
  status: "fila" | "running" | "done" | "erro";
  progresso: number; // 0..1
  janela?: InfoJanela;
  avisoAtual?: string; // aviso transitório (ex.: cooldown de bloqueio) — "" = sem aviso
  relatorio?: Relatorio;
  avisoParcial?: string; // preenchido quando alguma janela falhou e foi pulada
  pernas?: PernaSeatspy[]; // resultado das buscas via SeatSpy
  secaoAA?: SecaoRelatorio & { rotulo: string }; // resultado das buscas na AA (uma cabine por busca)
  confirmacao?: ConfirmacaoLatam; // confirmação em milhas do melhor par (LATAM)
  planilhaUrl?: string; // planilha da busca (uma nova por busca — ver planilha.ts)
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

const poolAwardtool = new PoolSessoes<Sessao>(
  CONCORRENCIA_AWARDTOOL,
  (headless) => iniciarSessao(headless),
  (s) => s.browser.isConnected() && !s.page.isClosed(),
);

// Mesma ideia, mas pro SeatSpy (site próprio, login próprio — independente
// das sessões do AwardTool).
const poolSeatspy = new PoolSessoes<SessaoSeatspy>(
  CONCORRENCIA_SEATSPY,
  (headless) => iniciarSessaoSeatspy(headless),
  (s) => s.browser.isConnected() && !s.page.isClosed(),
);

// A sessão da AA pode ser uma aba no Chrome do próprio usuário (ver
// iniciarSessaoAA) — daí o browser poder ser null e a checagem olhar a aba.
const poolAA = new PoolSessoes<SessaoAA>(
  CONCORRENCIA_AA,
  (headless) => iniciarSessaoAA(headless),
  sessaoViva,
);

const poolLatam = new PoolSessoes<SessaoLatam>(
  CONCORRENCIA_LATAM,
  (headless) => iniciarSessaoLatam(headless),
  sessaoViva,
);

const poolSmiles = new PoolSessoes<SessaoSmiles>(
  CONCORRENCIA_SMILES,
  (headless) => iniciarSessaoSmiles(headless),
  sessaoViva,
);

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
    const { sessao, indice } = await pool.adquirir();
    indiceSlot = indice;
    job.status = "running";
    emitirEvento(jobId, { tipo: "iniciou" });
    await trabalho(sessao);
  } catch (err) {
    const mensagemOriginal = err instanceof Error ? err.message : String(err);
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

function executarJob(jobId: string, params: { origem: string; destino: string; tetos: TetosTap }) {
  return executarComPool(poolAwardtool, jobId, async ({ page, baseUrl }) => {
    const job = jobs.get(jobId)!;
    const { dias: todasAsDatas, janelasComFalha } = await pesquisarAnoCompleto(
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
    );

    const relatorio = construirRelatorio(todasAsDatas, params.tetos);
    // Vai pro front pra deixar explícito qual teto valeu de fato — sem isso,
    // um servidor rodando código antigo aplicaria o padrão silenciosamente.
    const tetosAplicados = {
      executivaK: params.tetos.executivaK ?? TETO_EXECUTIVA_K_PADRAO,
      economicaK: params.tetos.economicaK ?? TETO_ECONOMICA_K_PADRAO,
    };
    const avisoParcial =
      janelasComFalha.length > 0
        ? `${janelasComFalha.length} janela(s) não puderam ser buscadas (ver detalhes no terminal do servidor) — o resultado abaixo é parcial.`
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
    emitirEvento(jobId, { tipo: "done", relatorio, avisoParcial, tetosAplicados });
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
        secoes: construirRelatorioSeatspy(ida, params.tetos).secoes,
      },
    ];
    if (volta) {
      pernas.push({
        rotulo: `Volta: ${params.destino} → ${params.origem}`,
        secoes: construirRelatorioSeatspy(volta, params.tetos).secoes,
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
    );

    const secao = {
      rotulo: CABINE_AA_LABEL[params.cabine],
      ...construirRelatorioAA(dias, params.tetoMilhas),
    };
    // O motivo da primeira falha vai junto: sem ele o usuário via só "parcial"
    // e teria que abrir o terminal do servidor pra saber se foi bloqueio, rota
    // errada ou pedido recusado.
    const avisoParcial =
      mesesComFalha.length > 0
        ? `${mesesComFalha.length} mês(es) não puderam ser buscados — o resultado abaixo é parcial. ` +
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

// Smiles: uma direção por job (o endpoint é de ida simples), com as três
// cabines juntas — o front pede a volta como um segundo job, igual à AA.
function executarJobSmiles(
  jobId: string,
  params: { origem: string; destino: string; tetos: TetosSmiles },
) {
  return executarComPool(poolSmiles, jobId, async ({ page }) => {
    const job = jobs.get(jobId)!;
    const { dias, diasComFalha, lacunas } = await pesquisarAnoSmiles(
      page,
      { origem: params.origem, destino: params.destino },
      params.tetos,
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
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
      partes.push(`${diasComFalha.length} dia(s) falharam — o primeiro foi ${diasComFalha[0]!.data}: ${diasComFalha[0]!.erro}`);
    }
    const avisoParcial = partes.length > 0 ? `Cobertura parcial — ${partes.join("; ")}.` : undefined;

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
    );

    const pernas: PernaSeatspy[] = [
      { rotulo: `Ida: ${params.origem} → ${params.destino}`, secoes: [{ rotulo: "Econômica", corClasse: "cartao-economica", ...construirRelatorioLatam(ida, params.tetos) }] },
      { rotulo: `Volta: ${params.destino} → ${params.origem}`, secoes: [{ rotulo: "Econômica", corClasse: "cartao-economica", ...construirRelatorioLatam(volta, params.tetos) }] },
    ];
    let avisoParcial =
      mesesComFalha.length > 0
        ? `${mesesComFalha.length} período(s) não puderam ser buscados — o resultado abaixo é parcial.`
        : undefined;

    // Fase 2: confirma em milhas o melhor par de datas dentro da faixa
    // "menor + margem". Os prints vão pra mesma pasta servida em /alertas.
    let confirmacao: ConfirmacaoLatam | undefined;
    let avisoConfirmacao: string | undefined;
    if (params.confirmarMilhas) {
      try {
      const par = escolherMelhorPar(ida, volta, params.margemIdaReais, params.margemVoltaReais);
      if (!par) {
        avisoConfirmacao = "Não achei par de ida e volta dentro da faixa pra confirmar em milhas.";
      } else {
        atualizarAviso(jobId, `Confirmando em milhas ${par.ida.data} → ${par.volta.data}...`);
        const pasta = `latam-${params.origem}-${params.destino}-${Date.now()}`;
        fs.mkdirSync(path.join(DIR_ALERTAS, pasta), { recursive: true });
        const caminho = (n: string) => path.join(DIR_ALERTAS, pasta, n);

        const cIda = await confirmarEmMilhas(
          page,
          { origem: params.origem, destino: params.destino, data: par.ida.data, caminhoImagem: caminho("ida.png") },
          (msg) => console.log(`[${jobId}] ${msg}`),
          // Pedido de login vira aviso na tela: é a única forma de o usuário
          // saber que a busca está parada esperando ele na janela do bot.
          (mensagem) => atualizarAviso(jobId, mensagem),
        );
        const cVolta = await confirmarEmMilhas(
          page,
          { origem: params.destino, destino: params.origem, data: par.volta.data, caminhoImagem: caminho("volta.png") },
          (msg) => console.log(`[${jobId}] ${msg}`),
          (mensagem) => atualizarAviso(jobId, mensagem),
        );

        if (cIda && cVolta) {
          const totalMilhas = cIda.milhas + cVolta.milhas;
          const totalTaxas = Math.round((cIda.taxas + cVolta.taxas) * 100) / 100;

          // O print é o último passo e o mais frágil (depende da página estar
          // renderizada). Se falhar, os valores em milhas — que é o que
          // interessa — continuam valendo, só sem imagem.
          let imagem = "";
          try {
            if (cIda.imagem && cVolta.imagem) {
              await montarPrintCombinado(context, {
                origem: params.origem,
                destino: params.destino,
                ida: cIda,
                volta: cVolta,
                totalMilhas,
                totalTaxas,
                caminhoImagem: caminho("ida-e-volta.png"),
              });
              imagem = `/alertas/${pasta}/ida-e-volta.png`;
            } else {
              avisoConfirmacao = "Não consegui capturar o print de um dos trechos — os valores em milhas abaixo continuam válidos.";
            }
          } catch (err) {
            console.error(`[${jobId}] falha ao montar o print: ${err instanceof Error ? err.message : String(err)}`);
            avisoConfirmacao = "Não consegui montar o print da confirmação — os valores em milhas abaixo continuam válidos.";
          }

          confirmacao = {
            ida: { ...cIda, imagem: cIda.imagem ? `/alertas/${pasta}/ida.png` : "" },
            volta: { ...cVolta, imagem: cVolta.imagem ? `/alertas/${pasta}/volta.png` : "" },
            totalMilhas,
            totalTaxas,
            imagem,
          };
        } else {
          avisoConfirmacao = "As datas mais baratas não tinham oferta em milhas.";
        }
      }
      } catch (err) {
        // Nada aqui pode derrubar o resultado do calendário: as datas em reais
        // já custaram a varredura inteira e são úteis por si só.
        const mensagem = err instanceof Error ? err.message : String(err);
        console.error(`[${jobId}] confirmação em milhas falhou: ${mensagem}`);
        avisoConfirmacao = `A confirmação em milhas falhou (${mensagem}). As datas abaixo continuam válidas.`;
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
    "Aviso: BOT_AUTH_USER/BOT_AUTH_PASS não configurados no .env — o servidor fica sem senha. " +
      "Defina os dois antes de expor essa porta publicamente (ex.: via ngrok).",
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
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
  if (job.status === "done") {
    const dado = job.pernas
      ? { tipo: "done", pernas: job.pernas, confirmacao: job.confirmacao }
      : job.secaoAA
        ? { tipo: "done", secaoAA: job.secaoAA, avisoParcial: job.avisoParcial }
        : { tipo: "done", relatorio: job.relatorio, avisoParcial: job.avisoParcial };
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
