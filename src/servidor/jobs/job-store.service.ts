import { ConflictException, Injectable, NotFoundException, type MessageEvent } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { concat, defer, from, map, Subject, type Observable } from "rxjs";
import { config } from "../config.ts";
import type { Job, JobCallbacks, JobEvent } from "./job.types.ts";

function replayedResult({ avisoParcial, arquivoLocal, ...result }: JobEvent): JobEvent {
  return "pernas" in result ? result : { ...result, avisoParcial };
}

@Injectable()
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  create(): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: "fila", progress: 0, events: new Subject() });
    return jobId;
  }

  get(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundException("Busca não existe mais.");
    return job;
  }

  callbacks(jobId: string): JobCallbacks {
    const job = this.get(jobId);
    return {
      log: (message) => console.log(`[${jobId}] ${message}`),
      progress: (fraction) => {
        job.progress = fraction;
        job.events.next({ tipo: "progresso", fracao: fraction });
      },
      notice: (message) => {
        job.notice = message;
        job.events.next({ tipo: "aviso", mensagem: message });
      },
      window: (info) => {
        job.window = info;
        job.events.next({ tipo: "janela", ...info });
      },
      ask: (message) => this.ask(jobId, job, message),
      shouldStop: () => job.cancelled === true,
    };
  }

  markRunning(jobId: string) {
    const job = this.get(jobId);
    job.status = "running";
    job.events.next({ tipo: "iniciou" });
  }

  complete(jobId: string, result: Record<string, unknown>) {
    const job = this.get(jobId);
    job.status = "done";
    job.result = { tipo: "done", ...result };
    job.events.next(job.result);
  }

  fail(jobId: string, message: string) {
    const job = this.get(jobId);
    job.status = "erro";
    job.error = message;
    job.events.next({ tipo: "erro", mensagem: message });
  }

  close(jobId: string) {
    this.get(jobId).events.complete();
  }

  cancel(jobId: string) {
    const job = this.get(jobId);
    if (job.status === "done" || job.status === "erro") throw new ConflictException("Essa busca já terminou.");
    job.cancelled = true;
    // Waiting on an open question would hold a browser slot for nothing.
    job.answer?.(false);
  }

  answer(jobId: string, questionId: string | undefined, proceed: boolean) {
    const job = this.get(jobId);
    if (!job.question || !job.answer) throw new ConflictException("Não há pergunta em aberto nessa busca.");
    // An answer from a stale tab or a double click must not land on a newer question.
    if (questionId && questionId !== job.question.id) throw new ConflictException("Essa pergunta já foi respondida.");
    job.answer(proceed);
  }

  state(jobId: string) {
    const job = this.get(jobId);
    return { status: job.status, progresso: job.progress };
  }

  stream(jobId: string): Observable<MessageEvent> {
    const job = this.get(jobId);
    // Deferred so the snapshot and the live subscription happen in the same tick:
    // a job finishing in between would otherwise end the stream without "done".
    return defer(() => {
      const replay = from(this.replay(job));
      return job.status === "done" || job.status === "erro" ? replay : concat(replay, job.events);
    }).pipe(map((data) => ({ data })));
  }

  private replay(job: Job): JobEvent[] {
    const events: JobEvent[] = [];
    if (job.status === "fila") events.push({ tipo: "fila" });
    events.push({ tipo: "progresso", fracao: job.progress });
    if (job.window) events.push({ tipo: "janela", ...job.window });
    if (job.notice) events.push({ tipo: "aviso", mensagem: job.notice });
    if (job.question) events.push({ tipo: "pergunta", ...job.question });
    if (job.status === "done" && job.result) events.push(replayedResult(job.result));
    if (job.status === "erro") events.push({ tipo: "erro", mensagem: job.error });
    return events;
  }

  private ask(jobId: string, job: Job, message: string): Promise<boolean> {
    const id = `${jobId}-${Date.now()}`;
    job.question = { id, mensagem: message };
    job.events.next({ tipo: "pergunta", id, mensagem: message });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (proceed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        job.question = undefined;
        job.answer = undefined;
        job.events.next({ tipo: "respondida", id, continuar: proceed });
        resolve(proceed);
      };
      const deadline = setTimeout(() => {
        console.log(`[${jobId}] ninguém respondeu em ${Math.round(config.answerTimeoutMs / 60000)} min. Parando a busca.`);
        settle(false);
      }, config.answerTimeoutMs);
      job.answer = settle;
    });
  }
}
