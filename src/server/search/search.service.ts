import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { JobStore } from "../jobs/job-store.service.ts";
import { validateBody } from "../validation.ts";
import { SEARCH_SOURCES, type SearchSource, type SearchSourceRegistry } from "./search-source.ts";

@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_SOURCES) private readonly sources: SearchSourceRegistry,
    private readonly jobs: JobStore,
  ) {}

  async start(body: Record<string, unknown> | undefined): Promise<string> {
    const source = this.sourceFor(body?.source);
    const request = await validateBody(source.requestDto, body);
    const jobId = this.jobs.create();
    void source.start(jobId, request);
    return jobId;
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
