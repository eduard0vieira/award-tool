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

type Job = {
  status: "running" | "done" | "erro";
  logs: string[];
  relatorio?: Relatorio;
  erro?: string;
  ouvintes: Set<Response>;
};

const jobs = new Map<string, Job>();

let sessaoPromise: Promise<Sessao> | null = null;
function getSessao(): Promise<Sessao> {
  if (!sessaoPromise) {
    sessaoPromise = iniciarSessao(false);
  }
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

function log(jobId: string, mensagem: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.logs.push(mensagem);
  emitirEvento(jobId, { tipo: "log", mensagem });
}

async function executarJob(
  jobId: string,
  params: { origem: string; destino: string; cabine: string },
) {
  const job = jobs.get(jobId)!;
  try {
    const { page, baseUrl } = await getSessao();
    log(jobId, "Login concluído. Iniciando busca...");

    const cabineParam = cabineParamDe(params.cabine);
    const todasAsDatas = await pesquisarAnoCompleto(
      page,
      { baseUrl, origem: params.origem, destino: params.destino, cabineParam },
      (msg) => log(jobId, msg),
    );

    const relatorio = construirRelatorio(todasAsDatas);
    job.status = "done";
    job.relatorio = relatorio;
    emitirEvento(jobId, { tipo: "done", relatorio });
  } catch (err) {
    job.status = "erro";
    job.erro = err instanceof Error ? err.message : String(err);
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
  jobs.set(jobId, { status: "running", logs: [], ouvintes: new Set() });

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

  // Reenvia o que já aconteceu até agora, pra quem conectar atrasado.
  for (const mensagem of job.logs) {
    res.write(`data: ${JSON.stringify({ tipo: "log", mensagem })}\n\n`);
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
