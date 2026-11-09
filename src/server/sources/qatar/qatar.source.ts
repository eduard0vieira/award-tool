import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { buildQatarReport } from "../../../scrapers/qatar/qatar-calendar.ts";
import { searchQatarYear, type QatarSession } from "../../../scrapers/qatar/qatar.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch } from "../record-search.ts";
import { QatarSearchDto } from "./qatar-search.dto.ts";

export const QATAR_POOL = Symbol("QATAR_POOL");
export const QATAR_SECTION_LABEL = "Econômica";

// One direction per job: the front asks for the return as a second job.
@Injectable()
export class QatarSource implements SearchSource<QatarSearchDto> {
  readonly id = "qatar";
  readonly requestDto = QatarSearchDto;

  identity(request: QatarSearchDto) {
    return { origin: request.origin, destination: request.destination, ceiling: request.ceiling ?? null };
  }

  constructor(
    @Inject(QATAR_POOL) private readonly pool: SessionPool<QatarSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: QatarSearchDto) {
    const { origin, destination } = request;
    const route = { origin, destination };
    const ceiling = request.ceiling ?? null;

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { days, failedMonths } = await searchQatarYear(page, route, job.log, job.progress, job.notice, job.shouldStop);

      const section = { label: QATAR_SECTION_LABEL, ...buildQatarReport(days, ceiling, route) };
      const firstFailure = failedMonths[0];
      const partialNotice = firstFailure
        ? `${failedMonths.length} mês(es) não puderam ser buscados. O resultado abaixo é parcial. ` +
          `Primeira falha (${firstFailure.month}): ${firstFailure.error}`
        : undefined;

      recordSearch(jobId, {
        source: "QATAR",
        origin,
        destination,
        legs: [{ label: `${origin} → ${destination}`, sections: [section] }],
        ceilings: { [section.label]: ceiling },
      });
      this.jobs.complete(jobId, { section, partialNotice });
    });
  }
}
