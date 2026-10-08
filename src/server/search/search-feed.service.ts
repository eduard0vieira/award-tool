import { execFileSync } from "node:child_process";
import { Injectable, type MessageEvent } from "@nestjs/common";
import { concat, defer, from, interval, map, merge, Subject, type Observable } from "rxjs";
import { ROOT_DIR } from "../../core/paths.ts";
import { JobStore } from "../jobs/job-store.service.ts";

// One card on the screen of whoever searched: its legs are separate jobs, and
// only that browser knows they belong together, so it tells the server.
export type SearchGroup = { id: string; source: string; args: unknown[]; by: string | null; legs: string[] };

export type GroupLeg = { id: string; leg: number; args: unknown[]; source: string; by: string | null };

type FeedEvent =
  | { type: "hello"; version: string | null }
  | { type: "group"; group: SearchGroup; snapshot?: true }
  | { type: "history" }
  | { type: "ping" };

// ngrok drops a connection that stays silent for too long.
const PING_MS = 25_000;
const FORGET_AFTER_MS = 6 * 3_600_000;

type TrackedGroup = { group: SearchGroup; announced: boolean; touchedAt: number };

// The page compares it on every reconnect: a different one means the notebook
// pulled an update and the open page is running old code.
function currentVersion(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    console.error(
      "Não deu para ler o commit atual; o aviso de versão nova fica desligado:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

@Injectable()
export class SearchFeed {
  private readonly groups = new Map<string, TrackedGroup>();
  private readonly events = new Subject<FeedEvent>();
  private readonly version = currentVersion();

  constructor(private readonly jobs: JobStore) {}

  // Every leg is recorded, joined and reused ones included, so a group never has
  // a hole; but a group only goes out once one of its legs is a new search, so
  // joining or reusing someone else's search does not show up as a second card.
  addLeg(leg: GroupLeg, jobId: string, startedNew: boolean) {
    this.forgetIdle();
    let tracked = this.groups.get(leg.id);
    if (!tracked) {
      if (leg.leg !== 0) return;
      tracked = {
        group: { id: leg.id, source: leg.source, args: leg.args, by: leg.by, legs: [] },
        announced: false,
        touchedAt: Date.now(),
      };
      this.groups.set(leg.id, tracked);
    }
    const { group } = tracked;
    if (group.source !== leg.source || group.by !== leg.by || leg.leg > group.legs.length) return;
    group.legs[leg.leg] = jobId;
    tracked.touchedAt = Date.now();
    if (startedNew) tracked.announced = true;
    if (tracked.announced) this.events.next({ type: "group", group: copyOf(group) });
  }

  historyChanged() {
    this.events.next({ type: "history" });
  }

  stream(): Observable<MessageEvent> {
    // Deferred like JobStore.stream: snapshot and live subscription in the same tick.
    const feed = defer(() => {
      const hello: FeedEvent = { type: "hello", version: this.version };
      return concat(from([hello, ...this.snapshot()]), this.events);
    });
    const pings = interval(PING_MS).pipe(map((): FeedEvent => ({ type: "ping" })));
    return merge(feed, pings).pipe(map((data) => ({ data })));
  }

  private snapshot(): FeedEvent[] {
    return [...this.groups.values()]
      .filter((tracked) => tracked.announced && this.isRunning(tracked.group))
      .map((tracked) => ({ type: "group", group: copyOf(tracked.group), snapshot: true }));
  }

  private isRunning(group: SearchGroup): boolean {
    return group.legs.some((jobId) => {
      const { status } = this.jobs.state(jobId);
      return status === "queued" || status === "running";
    });
  }

  private forgetIdle() {
    const cutoff = Date.now() - FORGET_AFTER_MS;
    for (const [id, tracked] of this.groups) {
      if (tracked.touchedAt < cutoff && !this.isRunning(tracked.group)) this.groups.delete(id);
    }
  }
}

function copyOf(group: SearchGroup): SearchGroup {
  return { ...group, legs: [...group.legs] };
}
