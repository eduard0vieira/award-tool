import { Injectable } from "@nestjs/common";
import type { SessionPool } from "../../core/session-pool.ts";
import { JobStore } from "./job-store.service.ts";

// Reported as an error with its own text because the front already knows how
// to close a card on error; the text makes clear nothing failed.
export const CANCELLED = "Busca cancelada.";

@Injectable()
export class JobRunner {
  constructor(private readonly jobs: JobStore) {}

  async run<S>(pool: SessionPool<S>, jobId: string, work: (session: S) => Promise<void>): Promise<void> {
    const job = this.jobs.get(jobId);
    let slot: number | null = null;
    try {
      if (job.cancelled) return this.jobs.fail(jobId, CANCELLED);
      const { session, index } = await pool.acquire();
      slot = index;
      if (job.cancelled) return this.jobs.fail(jobId, CANCELLED);
      this.jobs.markRunning(jobId);
      await work(session);
    } catch (err) {
      if (job.cancelled) return this.jobs.fail(jobId, CANCELLED);
      const message = err instanceof Error ? err.message : String(err);
      const browserClosed = /Target page, context or browser has been closed/i.test(message);
      this.jobs.fail(
        jobId,
        browserClosed ? "A janela do navegador foi fechada durante a busca. Tente buscar de novo." : message,
      );
    } finally {
      if (slot !== null) pool.release(slot);
      this.jobs.close(jobId);
    }
  }
}
