import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cabineParamDe,
  construirRelatorio,
  iniciarSessao,
  pesquisarAnoCompleto,
  type Relatorio,
  type Sessao,
} from "./bot.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type InfoJanela = { atual: number; total: number; inicio: string; fim: string };

type Job = {
  status: "running" | "done" | "erro";
  progresso: number; // 0..1
  janela?: InfoJanela;
  relatorio?: Relatorio;
  erro?: string;
  ouvintes: Set<Response>;
};

const jobs = new Map<string, Job>();

// Reaproveita a mesma sessão (browser/página logada) entre buscas. Se a
// janela do Chrome foi fechada (manualmente, crash, etc.) nesse meio tempo,
// abre e loga numa nova em vez de continuar tentando usar uma sessão morta
// (o que causaria "Target page, context or browser has been closed" em toda
// busca seguinte).
let sessaoPromise: Promise<Sessao> | null = null;
async function getSessao(): Promise<Sessao> {
  if (sessaoPromise) {
    const sessao = await sessaoPromise;
    if (sessao.browser.isConnected() && !sessao.page.isClosed()) {
      return sessao;
    }
    console.log("Sessão anterior foi fechada, abrindo uma nova...");
    sessaoPromise = null;
  }
  sessaoPromise = iniciarSessao(false);
  return sessaoPromise;
}

let buscaEmAndamento = false;

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

async function executarJob(
  jobId: string,
  params: { origem: string; destino: string; cabine: string },
) {
  const job = jobs.get(jobId)!;
  try {
    const { page, baseUrl } = await getSessao();

    const cabineParam = cabineParamDe(params.cabine);
    const todasAsDatas = await pesquisarAnoCompleto(
      page,
      { baseUrl, origem: params.origem, destino: params.destino, cabineParam },
      (msg) => console.log(`[${jobId}] ${msg}`), // só no terminal do servidor, não vai pro front
      (fracao) => atualizarProgresso(jobId, fracao),
      (info) => atualizarJanela(jobId, info),
    );

    const relatorio = construirRelatorio(todasAsDatas);
    job.status = "done";
    job.relatorio = relatorio;
    emitirEvento(jobId, { tipo: "done", relatorio });
  } catch (err) {
    const mensagemOriginal = err instanceof Error ? err.message : String(err);
    const fechouNoMeio = /Target page, context or browser has been closed/i.test(mensagemOriginal);
    job.status = "erro";
    job.erro = fechouNoMeio
      ? "A janela do navegador foi fechada durante a busca. Tente buscar de novo."
      : mensagemOriginal;
    emitirEvento(jobId, { tipo: "erro", mensagem: job.erro });
  } finally {
    buscaEmAndamento = false;
    for (const res of job.ouvintes) res.end();
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/buscar", (req: Request, res: Response) => {
  const { origem, destino, cabine } = req.body ?? {};

  if (!origem || !destino || !cabine) {
    res.status(400).json({ erro: "origem, destino e cabine são obrigatórios." });
    return;
  }

  if (buscaEmAndamento) {
    res.status(409).json({ erro: "Já existe uma busca em andamento. Aguarde ela terminar." });
    return;
  }

  buscaEmAndamento = true;
  const jobId = randomUUID();
  jobs.set(jobId, { status: "running", progresso: 0, ouvintes: new Set() });

  executarJob(jobId, {
    origem: String(origem).toUpperCase(),
    destino: String(destino).toUpperCase(),
    cabine: String(cabine),
  });

  res.json({ jobId });
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

  // Reenvia o progresso/janela atuais, pra quem conectar atrasado.
  res.write(`data: ${JSON.stringify({ tipo: "progresso", fracao: job.progresso })}\n\n`);
  if (job.janela) {
    res.write(`data: ${JSON.stringify({ tipo: "janela", ...job.janela })}\n\n`);
  }
  if (job.status === "done") {
    res.write(`data: ${JSON.stringify({ tipo: "done", relatorio: job.relatorio })}\n\n`);
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

const PORTA = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(PORTA, () => {
  console.log(`Servidor rodando em http://localhost:${PORTA}`);
});
