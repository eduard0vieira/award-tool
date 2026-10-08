import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../auth/actor.ts";
import { config } from "../config.ts";
import { JobStore } from "../jobs/job-store.service.ts";
import { validateBody } from "../validation.ts";
import { requestKey, searchDay } from "./request-key.ts";
import type { RouteRequestDto } from "./request-fields.ts";
import { SEARCH_SOURCES, type SearchSource, type SearchSourceRegistry } from "./search-source.ts";
import { SearchFeed } from "./search-feed.service.ts";
import { SearchHistory } from "./search-history.service.ts";

export type StartedSearch = {
  jobId: string;
  // Someone already had this exact search running: the job is theirs, shared.
  joined?: { by: string | null };
  // A finished identical search was handed back instead of a new one.
  // `id` is the original search's: its row holds what the card can still use
  // (the flight filter), since the reused job itself has no row.
  reused?: { by: string | null; finishedAt: string; id: string };
};

const MAX_GROUP_ARGS_LENGTH = 4000;

function timeInSaoPaulo(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(date);
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_SOURCES) private readonly sources: SearchSourceRegistry,
    private readonly jobs: JobStore,
    private readonly history: SearchHistory,
    private readonly feed: SearchFeed,
  ) {}

  async start(body: Record<string, unknown> | undefined, actor?: Actor): Promise<StartedSearch> {
    const source = this.sourceFor(body?.source);
    const request = await validateBody(source.requestDto, body);
    const route = request as RouteRequestDto;
    const identity = source.identity(request);
    const key = requestKey(source.id, identity, searchDay());
    const requestedBy = actor?.kind === "user" ? actor.username : null;
    const trackLeg = (jobId: string, startedNew: boolean) => {
      if (route.group) this.feed.addLeg({ ...route.group, source: source.id, by: requestedBy }, jobId, startedNew);
    };
    if (route.group && JSON.stringify(route.group.args).length > MAX_GROUP_ARGS_LENGTH) {
      throw new BadRequestException("O campo group.args é grande demais.");
    }

    const active = this.jobs.findActive(key);
    if (active) {
      trackLeg(active.jobId, false);
      return { jobId: active.jobId, joined: { by: active.requestedBy } };
    }

    if (route.reuseRecent === true) {
      const since = new Date(Date.now() - config.searchReuseHours * 3_600_000);
      const recent = await this.history.findRecentDone(key, since);
      if (recent?.result && recent.finishedAt) {
        const by = recent.user?.username ?? null;
        const notice =
          `Resultado de uma busca${by ? ` de ${by}` : ""} feita às ${timeInSaoPaulo(recent.finishedAt)}. ` +
          "Para dados de agora, busque de novo.";
        const jobId = this.jobs.createFinished(JSON.parse(recent.result) as Record<string, unknown>, notice);
        trackLeg(jobId, false);
        return { jobId, reused: { by, finishedAt: recent.finishedAt.toISOString(), id: recent.id } };
      }
    }

    const jobId = this.jobs.create({ requestKey: key, requestedBy });
    await this.history.record({
      jobId,
      userId: actor?.kind === "user" ? actor.id : null,
      source: source.id,
      origin: route.origin,
      destination: route.destination,
      requestKey: key,
      request: identity,
      group: route.group,
    });
    trackLeg(jobId, true);
    void source.start(jobId, request);
    return { jobId };
  }

  private sourceFor(id: unknown): SearchSource {
    const source = typeof id === "string" ? this.sources.get(id) : undefined;
    if (!source) {
      throw new BadRequestException(
        `source desconhecida: "${String(id)}". Use uma destas: ${[...this.sources.keys()].join(", ")}.`,
      );
    }
    return source;
  }
}
