import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import {
  buildTapReport,
  DEFAULT_BUSINESS_CEILING_K,
  DEFAULT_ECONOMY_CEILING_K,
  searchTapYear,
  type TapSession,
} from "../../../scrapers/tap/tap.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch } from "../record-search.ts";
import { TapSearchDto } from "./tap-search.dto.ts";

export const TAP_POOL = Symbol("TAP_POOL");

// The extraction reads all four cabin colours whatever `cabins` says in the URL;
// the search only needs some value to run.
const CABIN_PARAM = "Economy";

@Injectable()
export class TapSource implements SearchSource<TapSearchDto> {
  readonly id = "tap";
  readonly requestDto = TapSearchDto;

  constructor(
    @Inject(TAP_POOL) private readonly pool: SessionPool<TapSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: TapSearchDto) {
    const { origin, destination } = request;
    // Ceilings are in K here: the TAP table is spoken in thousands, unlike SeatSpy and AA.
    const ceilings = { businessK: request.ceilings?.business ?? null, economyK: request.ceilings?.economy ?? null };

    return this.runner.run(this.pool, jobId, async ({ page, baseUrl }) => {
      const job = this.jobs.callbacks(jobId);
      const { days, failedWindows, stoppedByUser } = await searchTapYear(
        page,
        { baseUrl, origin, destination, cabinParam: CABIN_PARAM },
        job.log,
        job.progress,
        job.window,
        job.notice,
        job.ask,
        job.shouldStop,
      );

      const report = buildTapReport(days, ceilings);
      // Sent to the front so the ceiling actually applied is explicit instead of
      // an outdated server silently applying the default.
      const appliedCeilings = {
        businessK: ceilings.businessK ?? DEFAULT_BUSINESS_CEILING_K,
        economyK: ceilings.economyK ?? DEFAULT_ECONOMY_CEILING_K,
      };
      const partialNotice = stoppedByUser
        ? "Você interrompeu a busca depois das janelas vazias. O resultado abaixo cobre só o período já consultado."
        : failedWindows.length > 0
          ? `${failedWindows.length} janela(s) não puderam ser buscadas (ver detalhes no terminal do servidor). O resultado abaixo é parcial.`
          : undefined;

      recordSearch(jobId, {
        source: "tap",
        origin,
        destination,
        legs: [
          {
            label: `${origin} → ${destination}`,
            sections: [
              { ...report.business, label: "Executiva" },
              { ...report.economy, label: "Econômica" },
            ],
          },
        ],
        ceilings: { Executiva: appliedCeilings.businessK, "Econômica": appliedCeilings.economyK },
      });
      this.jobs.complete(jobId, { report, partialNotice, appliedCeilings, stoppedByUser });
    });
  }
}
