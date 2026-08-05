import crypto, { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
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
  construirRelatorioAA,
  iniciarSessaoAA,
  pesquisarAnoAA,
  type CabineAA,
  type SessaoAA,
} from "./bot-aa.ts";
import type { SecaoRelatorio } from "./comum.ts";
import { PoolSessoes } from "./pool-sessoes.ts";
import { DIR_ALERTAS, DIR_PORTAL_DIST, gerarAlerta, type PedidoAlerta } from "./alertas.ts";

// A extração de preços lê as 4 cores (Economy/PremiumEconomy/Business/First)
// de cada dia independente do valor de "cabins" mandado na URL — então o
// relatório sempre traz executiva e econômica juntas nessa mesma busca, e o
// valor abaixo é só o que a busca em si exige pra funcionar.
const CABINE_PARAM_PADRAO = "Economy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type InfoJanela = { atual: number; total: number; inicio: string; fim: string };

type PernaSeatspy = { rotulo: string; secoes: SecaoSeatspy[] };

type Job = {
  status: "fila" | "running" | "done" | "erro";
  progresso: number; // 0..1
  janela?: InfoJanela;
  avisoAtual?: string; // aviso transitório (ex.: cooldown de bloqueio) — "" = sem aviso
  relatorio?: Relatorio;
  avisoParcial?: string; // preenchido quando alguma janela falhou e foi pulada
  pernas?: PernaSeatspy[]; // resultado das buscas via SeatSpy
  secaoAA?: SecaoRelatorio & { rotulo: string }; // resultado das buscas na AA (uma cabine por busca)
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
  (s) => !s.page.isClosed() && (s.browser?.isConnected() ?? true),
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
      },
      (msg) => console.log(`[${jobId}] ${msg}`),
      (fracao) => atualizarProgresso(jobId, fracao),
      (mensagem) => atualizarAviso(jobId, mensagem),
    );

    const secao = {
      rotulo: CABINE_AA_LABEL[params.cabine],
      ...construirRelatorioAA(dias, params.tetoMilhas),
    };
    const avisoParcial =
      mesesComFalha.length > 0
        ? `${mesesComFalha.length} mês(es) não puderam ser buscados (ver detalhes no terminal do servidor) — o resultado abaixo é parcial.`
        : undefined;
    job.status = "done";
    job.secaoAA = secao;
    if (avisoParcial) job.avisoParcial = avisoParcial;
    emitirEvento(jobId, { tipo: "done", secaoAA: secao, avisoParcial });
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

app.post("/api/buscar", (req: Request, res: Response) => {
  const { fonte, origem, destino, companhia, idaEVolta, tetos, cabine, maxConexoes, teto } = req.body ?? {};

  if (!origem || !destino) {
    res.status(400).json({ erro: "origem e destino são obrigatórios." });
    return;
  }

  const ehSeatspy = fonte === "seatspy";
  const ehAA = fonte === "aa";
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
  } else if (ehAA) {
    executarJobAA(jobId, {
      origem: String(origem).toUpperCase(),
      destino: String(destino).toUpperCase(),
      cabine,
      maxConexoes: maxConexoes === 0 || maxConexoes === 1 ? maxConexoes : null,
      tetoMilhas: tetoDe(teto),
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
      ? { tipo: "done", pernas: job.pernas }
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
