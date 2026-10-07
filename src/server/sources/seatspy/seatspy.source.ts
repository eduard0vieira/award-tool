import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { buildSeatspyReport, searchSeatspy, type SeatspySession } from "../../../scrapers/seatspy/seatspy.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch, type Leg } from "../record-search.ts";
import { SeatspySearchDto } from "./seatspy-search.dto.ts";

export const SEATSPY_POOL = Symbol("SEATSPY_POOL");

// A SeatSpy "Return" search brings both legs at once and spends a single
// credit, so one job resolves the round trip.
@Injectable()
export class SeatspySource implements SearchSource<SeatspySearchDto> {
  readonly id = "seatspy";
  readonly requestDto = SeatspySearchDto;

  identity(request: SeatspySearchDto) {
    return {
      origin: request.origin,
      destination: request.destination,
      airline: request.airline,
      roundTrip: request.roundTrip ?? null,
      showSeats: request.showSeats ?? null,
      economy: request.ceilings?.economy ?? null,
      premium: request.ceilings?.premium ?? null,
      business: request.ceilings?.business ?? null,
      first: request.ceilings?.first ?? null,
    };
  }

  constructor(
    @Inject(SEATSPY_POOL) private readonly pool: SessionPool<SeatspySession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: SeatspySearchDto) {
    const { origin, destination, airline } = request;
    const roundTrip = request.roundTrip === true;
    const showSeats = request.showSeats !== false;
    const ceilings = {
      economy: request.ceilings?.economy ?? null,
      premium: request.ceilings?.premium ?? null,
      business: request.ceilings?.business ?? null,
      first: request.ceilings?.first ?? null,
    };

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { outbound, inbound } = await searchSeatspy(
        page,
        { airline, origin, destination, roundTrip },
        job.log,
        job.progress,
      );

      const legs: Leg[] = [
        {
          label: roundTrip ? `Ida: ${origin} → ${destination}` : `${origin} → ${destination}`,
          sections: buildSeatspyReport(outbound, ceilings, showSeats).sections,
        },
      ];
      if (inbound) {
        legs.push({
          label: `Volta: ${destination} → ${origin}`,
          sections: buildSeatspyReport(inbound, ceilings, showSeats).sections,
        });
      }

      recordSearch(jobId, {
        source: airline,
        origin,
        destination,
        legs,
        ceilings: {
          "Econômica": ceilings.economy,
          Premium: ceilings.premium,
          Executiva: ceilings.business,
          "Primeira Classe": ceilings.first,
        },
      });
      this.jobs.complete(jobId, { legs });
    });
  }
}
