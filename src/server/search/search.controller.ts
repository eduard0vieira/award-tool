import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { JobStore } from "../jobs/job-store.service.ts";
import { SearchService } from "./search.service.ts";

@Controller("api/searches")
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly jobs: JobStore,
  ) {}

  // Read by scripts/run-server.ts: an update only restarts the server when no
  // search would be lost with it.
  @Get("active")
  active() {
    return { active: this.jobs.activeCount() };
  }

  // Validated by the chosen source's own DTO, which depends on `source`.
  @Post()
  @HttpCode(200)
  async start(@Body() body: Record<string, unknown> | undefined) {
    return { jobId: await this.search.start(body) };
  }
}
