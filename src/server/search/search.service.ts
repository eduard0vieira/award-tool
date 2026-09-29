import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { JobStore } from "../jobs/job-store.service.ts";
import { validateBody } from "../validation.ts";
import { SEARCH_SOURCES, type SearchSource, type SearchSourceRegistry } from "./search-source.ts";

// The TAP form predates the other sources and never sends `fonte`.
const DEFAULT_SOURCE = "tap";

@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_SOURCES) private readonly sources: SearchSourceRegistry,
    private readonly jobs: JobStore,
  ) {}

  async start(body: Record<string, unknown> | undefined): Promise<string> {
    const source = this.sourceFor(body?.fonte);
    const request = await validateBody(source.requestDto, body);
    const jobId = this.jobs.create();
    void source.start(jobId, request);
    return jobId;
  }

  private sourceFor(id: unknown): SearchSource {
    const sourceId = id === undefined ? DEFAULT_SOURCE : String(id);
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new BadRequestException(
        `fonte desconhecida: "${sourceId}". Use uma destas: ${[...this.sources.keys()].join(", ")}.`,
      );
    }
    return source;
  }
}
