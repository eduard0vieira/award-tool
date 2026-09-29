import { ConflictException, Injectable, NotFoundException, type MessageEvent } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { concat, defer, from, map, Subject, type Observable } from "rxjs";
import { config } from "../config.ts";
import type { Job, JobCallbacks, JobEvent } from "./job.types.ts";

@Injectable()
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  create(): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: "queued", progress: 0, events: new Subject() });
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
        job.events.next({ type: "progress", fraction });
      },
      notice: (message) => {
        job.notice = message;
        job.events.next({ type: "notice", message });
      },
      window: (info) => {
        job.window = info;
        job.events.next({ type: "window", ...info });
      },
      ask: (message) => this.ask(jobId, job, message),
      shouldStop: () => job.cancelled === true,
    };
  }

  markRunning(jobId: string) {
    const job = this.get(jobId);
    job.status = "running";
    job.events.next({ type: "started" });
  }

  complete(jobId: string, result: Record<string, unknown>) {
    const job = this.get(jobId);
    job.status = "done";
    job.result = { type: "done", ...result };
    job.events.next(job.result);
  }

  fail(jobId: string, message: string) {
    const job = this.get(jobId);
    job.status = "error";
    job.error = message;
    job.events.next({ type: "error", message });
  }

  close(jobId: string) {
    this.get(jobId).events.complete();
  }

  cancel(jobId: string) {
    const job = this.get(jobId);
    if (job.status === "done" || job.status === "error") throw new ConflictException("Essa busca já terminou.");
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
    return { status: job.status, progress: job.progress };
  }

  stream(jobId: string): Observable<MessageEvent> {
    const job = this.get(jobId);
    // Deferred so the snapshot and the live subscription happen in the same tick:
    // a job finishing in between would otherwise end the stream without "done".
    return defer(() => {
      const replay = from(this.replay(job));
      return job.status === "done" || job.status === "error" ? replay : concat(replay, job.events);
    }).pipe(map((data) => ({ data })));
  }

  private replay(job: Job): JobEvent[] {
    const events: JobEvent[] = [];
    if (job.status === "queued") events.push({ type: "queued" });
    events.push({ type: "progress", fraction: job.progress });
    if (job.window) events.push({ type: "window", ...job.window });
    if (job.notice) events.push({ type: "notice", message: job.notice });
    if (job.question) events.push({ type: "question", ...job.question });
    if (job.status === "done" && job.result) events.push(job.result);
    if (job.status === "error") events.push({ type: "error", message: job.error });
    return events;
  }

  private ask(jobId: string, job: Job, message: string): Promise<boolean> {
    const id = `${jobId}-${Date.now()}`;
    job.question = { id, message };
    job.events.next({ type: "question", id, message });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (proceed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        job.question = undefined;
        job.answer = undefined;
        job.events.next({ type: "answered", id, proceed });
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
