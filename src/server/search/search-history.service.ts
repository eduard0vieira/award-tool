import { Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { config } from "../config.ts";
import { PrismaService } from "../db/prisma.service.ts";
import { CANCELLED } from "../jobs/job-runner.service.ts";
import { JobStore } from "../jobs/job-store.service.ts";
import type { JobEvent } from "../jobs/job.types.ts";
import { SearchFeed } from "./search-feed.service.ts";

export type NewSearch = {
  jobId: string;
  userId: number | null;
  source: string;
  origin: string;
  destination: string;
  requestKey: string;
  request: Record<string, unknown>;
  group?: { id: string; leg: number; args: unknown[] } | undefined;
};

type SearchUpdate = { status: string; result?: string; error?: string; finishedAt?: Date; flights?: string };

// How a finished job is recorded: the history and the queue must agree on it.
export function finishedStatus(event: JobEvent): "done" | "partial" | "error" | "cancelled" | null {
  if (event.type === "done") {
    // A partial result is kept for the history but never handed to someone
    // else as if it were the whole answer.
    return event.partialNotice || event.stoppedByUser === true ? "partial" : "done";
  }
  if (event.type === "error") return String(event.message) === CANCELLED ? "cancelled" : "error";
  return null;
}

function updateFor(event: JobEvent): SearchUpdate | null {
  if (event.type === "started") return { status: "running" };
  const status = finishedStatus(event);
  if (status === "done" || status === "partial") {
    const { type: _type, ...result } = event;
    return { status, result: JSON.stringify(result), finishedAt: new Date() };
  }
  if (status) return { status, error: String(event.message), finishedAt: new Date() };
  return null;
}

@Injectable()
export class SearchHistory implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobStore,
    private readonly feed: SearchFeed,
  ) {}

  async onModuleInit() {
    // Jobs live in memory: whatever was still running died with the last process.
    const interrupted = await this.prisma.search.updateMany({
      where: { status: { in: ["queued", "running"] } },
      data: { status: "error", error: "O servidor reiniciou no meio da busca.", finishedAt: new Date() },
    });
    if (interrupted.count > 0) console.log(`${interrupted.count} busca(s) interrompida(s) pelo reinício marcadas como erro.`);

    const cutoff = new Date(Date.now() - config.searchResultRetentionDays * 86_400_000);
    await this.prisma.search.updateMany({
      where: { createdAt: { lt: cutoff }, OR: [{ result: { not: null } }, { flights: { not: null } }] },
      data: { result: null, flights: null },
    });
  }

  async record(search: NewSearch) {
    const { jobId, request, group, ...fields } = search;
    await this.prisma.search.create({
      data: {
        ...fields,
        id: jobId,
        request: JSON.stringify(request),
        status: "queued",
        ...(group && { groupId: group.id, groupLeg: group.leg, groupArgs: JSON.stringify(group.args) }),
      },
    });
    this.feed.historyChanged();
    // Chained so the rows follow the job's order even when two updates are in
    // flight at once ("started" right before a fast "done").
    let pending = Promise.resolve();
    const job = this.jobs.get(search.jobId);
    job.events.subscribe((event) => {
      const update = updateFor(event);
      if (!update) return;
      if (event.type === "done" && job.flights !== undefined) update.flights = JSON.stringify(job.flights);
      pending = pending
        .then(() => this.prisma.search.update({ where: { id: search.jobId }, data: update }))
        .then(
          () => this.feed.historyChanged(),
          (err: unknown) =>
            console.error(
              `[${search.jobId}] não foi possível gravar "${update.status}" no histórico: ` +
                (err instanceof Error ? err.message : String(err)),
            ),
        );
    });
  }

  findRecentDone(requestKey: string, since: Date) {
    return this.prisma.search.findFirst({
      where: { requestKey, status: "done", finishedAt: { gte: since }, result: { not: null } },
      orderBy: { finishedAt: "desc" },
      omit: { flights: true },
      include: { user: { select: { username: true } } },
    });
  }

  async list(limit: number, before?: Date) {
    const rows = await this.prisma.search.findMany({
      where: before ? { createdAt: { lt: before } } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      omit: { result: true, flights: true },
      include: { user: { select: { username: true } } },
    });
    return rows.map(({ user, userId: _userId, requestKey: _key, groupArgs: _args, request, ...row }) => ({
      ...row,
      user: user?.username ?? null,
      request: JSON.parse(request) as Record<string, unknown>,
    }));
  }

  // Every saved leg of one card, in order, with what rebuilds the card.
  async getGroup(groupId: string) {
    const all = await this.prisma.search.findMany({
      where: { groupId },
      orderBy: [{ groupLeg: "asc" }, { createdAt: "desc" }],
      omit: { flights: true },
      include: { user: { select: { username: true } } },
    });
    // A queued card rerun after a restart has two rows for a leg: the one that
    // finished wins over the one the restart cut, and the newest over older ones.
    const finished = (status: string) => status === "done" || status === "partial";
    const byLeg = new Map<number | null, (typeof all)[number]>();
    for (const row of all) {
      const kept = byLeg.get(row.groupLeg);
      if (!kept || (!finished(kept.status) && finished(row.status))) byLeg.set(row.groupLeg, row);
    }
    const rows = [...byLeg.values()];
    const first = rows[0];
    if (!first?.groupArgs) throw new NotFoundException("Essa busca não está no histórico.");
    return {
      id: groupId,
      source: first.source,
      args: JSON.parse(first.groupArgs) as unknown[],
      user: first.user?.username ?? null,
      createdAt: first.createdAt,
      legs: rows.map((row) => ({
        leg: row.groupLeg,
        id: row.id,
        status: row.status,
        error: row.error,
        // Null once older than SEARCH_RESULT_RETENTION_DAYS, like in get().
        result: row.result === null ? null : (JSON.parse(row.result) as Record<string, unknown>),
      })),
    };
  }

  async get(id: string) {
    const row = await this.prisma.search.findUnique({
      where: { id },
      omit: { flights: true },
      include: { user: { select: { username: true } } },
    });
    if (!row) throw new NotFoundException("Busca não encontrada no histórico.");
    const { user, userId: _userId, requestKey: _key, groupArgs: _args, request, result, ...rest } = row;
    return {
      ...rest,
      user: user?.username ?? null,
      request: JSON.parse(request) as Record<string, unknown>,
      // Null once older than SEARCH_RESULT_RETENTION_DAYS: the row stays, the payload goes.
      result: result === null ? null : (JSON.parse(result) as Record<string, unknown>),
    };
  }
}
