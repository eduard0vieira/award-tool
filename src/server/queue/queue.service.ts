import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Actor } from "../auth/actor.ts";
import { PrismaService } from "../db/prisma.service.ts";
import { JobStore } from "../jobs/job-store.service.ts";
import { finishedStatus } from "../search/search-history.service.ts";
import { SearchFeed } from "../search/search-feed.service.ts";
import { SearchService } from "../search/search.service.ts";
import { QueueItemDto } from "./queue-item.dto.ts";

// One queued card at a time per browser: the three AwardTool searches share one
// session pool and rate limiter, and AA, LATAM and Smiles share the real Chrome
// whose IP Akamai and Smiles watch. SeatSpy spends a paid credit and the TAP live
// search stops to ask questions nobody answers at night, so neither is queued.
const LANES: Record<string, string> = {
  "tap-calendar": "awardtool",
  "tap-showcase": "awardtool",
  smiles: "chrome",
  aa: "chrome",
  latam: "chrome",
};

const TICK_MS = 15_000;
// A leg that never ends would hold its lane, and every item behind it, forever.
const LEG_MAX_MS = (Number(process.env.QUEUE_LEG_MAX_HOURS) || 4) * 3_600_000;
const FINISHED_KEPT_MS = 48 * 3_600_000;

type LegOutcome = { status: "done" | "partial" | "error" | "cancelled"; error?: string };

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly busyLanes = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  // Jobs this queue started itself: the only ones it may cancel.
  private readonly ownJobs = new Set<string>();
  // The e2e tests drive runDue() themselves.
  autoRun = process.env.QUEUE_AUTORUN !== "false";

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly jobs: JobStore,
    private readonly feed: SearchFeed,
  ) {}

  async onModuleInit() {
    // The job died with the last process; its finished legs stay counted in nextLeg.
    const resumed = await this.prisma.queueItem.updateMany({ where: { status: "running" }, data: { status: "waiting", jobId: null } });
    if (resumed.count > 0) console.log(`${resumed.count} item(ns) da fila voltaram a aguardar depois do reinício.`);
    if (!this.autoRun) return;
    this.timer = setInterval(() => void this.runDue(), TICK_MS);
    this.timer.unref();
    void this.runDue();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async add(body: QueueItemDto, actor?: Actor) {
    if (!LANES[body.source]) {
      throw new BadRequestException(`A fila não roda buscas de "${body.source}". Use uma destas: ${Object.keys(LANES).join(", ")}.`);
    }
    const id = randomUUID();
    // Checked now, with the person still at the screen, not when it runs at night.
    const legs = [];
    for (const [leg, legBody] of body.legs.entries()) {
      await this.search.validate(this.bodyFor(body.source, legBody, { id, leg, args: body.args }));
      legs.push(legBody);
    }
    const runAfter = body.runAfter ? new Date(body.runAfter) : new Date();
    const item = await this.prisma.queueItem.create({
      data: {
        id,
        userId: actor?.kind === "user" ? actor.id : null,
        source: body.source,
        args: JSON.stringify(body.args),
        legs: JSON.stringify(legs),
        label: body.label,
        runAfter,
        status: "waiting",
      },
    });
    this.feed.queueChanged();
    if (this.autoRun) void this.runDue();
    return this.view(item, actor?.kind === "user" ? actor.username : null);
  }

  async list() {
    const items = await this.prisma.queueItem.findMany({
      where: { OR: [{ status: { in: ["waiting", "running"] } }, { finishedAt: { gte: new Date(Date.now() - FINISHED_KEPT_MS) } }] },
      orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
      include: { user: { select: { username: true } } },
    });
    return items.map(({ user, ...item }) => this.view(item, user?.username ?? null));
  }

  async cancel(id: string) {
    const item = await this.prisma.queueItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException("Esse item não está na fila.");
    if (item.status === "waiting") {
      await this.finish(id, { status: "cancelled", finishedAt: new Date() });
      return;
    }
    if (item.status !== "running") throw new ConflictException("Esse item já terminou.");
    this.cancelRequested.add(id);
    // Only this item's own leg: a joined leg is someone else's search too.
    if (item.jobId && this.ownJobs.has(item.jobId)) {
      try {
        this.jobs.cancel(item.jobId);
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;
      }
    }
  }

  async runNow(id: string) {
    const updated = await this.prisma.queueItem.updateMany({ where: { id, status: "waiting" }, data: { runAfter: new Date() } });
    if (updated.count === 0) throw new ConflictException("Só um item aguardando pode rodar agora.");
    this.feed.queueChanged();
    if (this.autoRun) void this.runDue();
  }

  // Starts every due item whose lane is free; resolves when those started items end.
  async runDue(): Promise<void> {
    const due = await this.prisma.queueItem.findMany({
      where: { status: "waiting", runAfter: { lte: new Date() } },
      orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
      include: { user: { select: { id: true, username: true } } },
    });
    const running: Promise<void>[] = [];
    for (const item of due) {
      const lane = LANES[item.source] ?? item.source;
      if (this.busyLanes.has(lane)) continue;
      this.busyLanes.add(lane);
      running.push(
        this.run(item)
          .catch((err: unknown) => console.error(`[fila ${item.id}] falhou fora de uma busca:`, err))
          .finally(() => {
            this.busyLanes.delete(lane);
            if (this.autoRun) void this.runDue();
          }),
      );
    }
    await Promise.all(running);
  }

  private async run(item: { id: string; source: string; args: string; legs: string; nextLeg: number; partial: boolean; user: { id: number; username: string } | null }) {
    const legs = JSON.parse(item.legs) as Record<string, unknown>[];
    const args = JSON.parse(item.args) as unknown[];
    const actor: Actor = item.user ? { kind: "user", id: item.user.id, username: item.user.username } : { kind: "machine" };
    let partial = item.partial;
    await this.update(item.id, { status: "running", startedAt: new Date() });

    for (let leg = item.nextLeg; leg < legs.length; leg++) {
      if (this.cancelRequested.delete(item.id)) return this.finish(item.id, { status: "cancelled", finishedAt: new Date() });
      let jobId: string;
      let joined: boolean;
      try {
        // Fresh data: a queued search exists to bring what the site has at that hour.
        const started = await this.search.start(
          { ...this.bodyFor(item.source, legs[leg]!, { id: item.id, leg, args }), reuseRecent: false },
          actor,
        );
        jobId = started.jobId;
        joined = Boolean(started.joined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return this.finish(item.id, { status: "error", error: message, finishedAt: new Date() });
      }
      if (!joined) this.ownJobs.add(jobId);
      await this.update(item.id, { jobId });
      const outcome = await this.waitFor(jobId, !joined);
      this.ownJobs.delete(jobId);

      if (outcome.status === "cancelled" || this.cancelRequested.delete(item.id)) {
        return this.finish(item.id, { status: "cancelled", jobId: null, finishedAt: new Date() });
      }
      if (outcome.status === "error") {
        return this.finish(item.id, { status: "error", error: outcome.error ?? "A busca falhou.", jobId: null, finishedAt: new Date() });
      }
      partial ||= outcome.status === "partial";
      await this.update(item.id, { nextLeg: leg + 1, partial, jobId: null });
    }
    return this.finish(item.id, { status: partial ? "partial" : "done", finishedAt: new Date() });
  }

  private bodyFor(source: string, leg: Record<string, unknown>, group: { id: string; leg: number; args: unknown[] }) {
    return { ...leg, source, group };
  }

  // Checked before subscribing, in the same tick: a joined job may already be over.
  private waitFor(jobId: string, own: boolean): Promise<LegOutcome> {
    const job = this.jobs.get(jobId);
    const outcomeOf = (): LegOutcome | null => {
      if (job.status === "done" && job.result) return { status: finishedStatus(job.result) as "done" | "partial" };
      if (job.status === "error") {
        const status = finishedStatus({ type: "error", message: job.error });
        return { status: status === "cancelled" ? "cancelled" : "error", ...(job.error && { error: job.error }) };
      }
      return null;
    };
    const known = outcomeOf();
    if (known) return Promise.resolve(known);

    return new Promise((resolve) => {
      const deadline = setTimeout(() => {
        subscription.unsubscribe();
        if (own) {
          try {
            this.jobs.cancel(jobId);
          } catch (err) {
            if (!(err instanceof ConflictException)) throw err;
          }
        }
        resolve({ status: "error", error: `A busca passou de ${LEG_MAX_MS / 3_600_000} h e foi parada pela fila.` });
      }, LEG_MAX_MS);
      deadline.unref();
      const subscription = job.events.subscribe({
        next: (event) => {
          const status = finishedStatus(event);
          if (!status) return;
          clearTimeout(deadline);
          resolve(status === "error" ? { status, error: String(event.message) } : { status });
        },
        complete: () => {
          clearTimeout(deadline);
          resolve(outcomeOf() ?? { status: "error", error: "A busca terminou sem resultado." });
        },
      });
    });
  }

  private async update(id: string, data: Record<string, unknown>) {
    await this.prisma.queueItem.update({ where: { id }, data });
    this.feed.queueChanged();
  }

  private async finish(id: string, data: Record<string, unknown>) {
    this.cancelRequested.delete(id);
    await this.update(id, data);
  }

  private view(
    item: { id: string; source: string; args: string; legs: string; label: string; runAfter: Date; status: string; nextLeg: number; partial: boolean; jobId: string | null; error: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null },
    user: string | null,
  ) {
    const { args, legs, ...rest } = item;
    return { ...rest, user, args: JSON.parse(args) as unknown[], legCount: (JSON.parse(legs) as unknown[]).length };
  }
}
