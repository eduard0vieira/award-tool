import { Inject, Injectable } from "@nestjs/common";
import { AA_CABIN_LABELS, buildAaReport, searchAaYear, type AaSession } from "../../../scrapers/aa/aa.scraper.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch } from "../record-search.ts";
import { AaSearchDto } from "./aa-search.dto.ts";

export const AA_POOL = Symbol("AA_POOL");

// One cabin and one direction per job: the front asks for the return as a second job.
@Injectable()
export class AaSource implements SearchSource<AaSearchDto> {
  readonly id = "aa";
  readonly requestDto = AaSearchDto;

  constructor(
    @Inject(AA_POOL) private readonly pool: SessionPool<AaSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: AaSearchDto) {
    const { origem, destino, cabine } = request;
    const ceiling = request.teto ?? null;
    const passengers = request.passageiros ?? 1;

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { days, failedMonths } = await searchAaYear(
        page,
        { origin: origem, destination: destino, cabin: cabine, maxStops: request.maxConexoes ?? null, passengers },
        job.log,
        job.progress,
        job.notice,
        job.shouldStop,
      );

      const section = {
        rotulo: AA_CABIN_LABELS[cabine],
        ...buildAaReport(days, ceiling, { origin: origem, destination: destino, passengers, cabin: cabine }),
      };
      // Without the first failure's reason the user would only see "partial" and
      // have to open the server terminal to tell a block from a bad route.
      const firstFailure = failedMonths[0];
      const partialNotice = firstFailure
        ? `${failedMonths.length} mês(es) não puderam ser buscados. O resultado abaixo é parcial. ` +
          `Primeira falha (${firstFailure.month}): ${firstFailure.error}`
        : undefined;

      recordSearch(jobId, {
        source: "AA",
        origin: origem,
        destination: destino,
        legs: [{ rotulo: `${origem} → ${destino}`, secoes: [section] }],
        ceilings: { [section.rotulo]: ceiling },
      });
      this.jobs.complete(jobId, { secaoAA: section, avisoParcial: partialNotice });
    });
  }
}
