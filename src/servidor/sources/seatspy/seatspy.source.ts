import { Inject, Injectable } from "@nestjs/common";
import {
  construirRelatorioSeatspy,
  pesquisarSeatspy,
  type SessaoSeatspy,
} from "../../../fontes/seatspy/bot-seatspy.ts";
import { SessionPool } from "../../../core/session-pool.ts";
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

  constructor(
    @Inject(SEATSPY_POOL) private readonly pool: SessionPool<SessaoSeatspy>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: SeatspySearchDto) {
    const { origem, destino, companhia } = request;
    const roundTrip = request.idaEVolta === true;
    // Absent means show: an old tab that never sends the field keeps getting seats.
    const showSeats = request.mostrarAssentos !== false;
    const ceilings = {
      economica: request.tetos?.economica ?? null,
      premium: request.tetos?.premium ?? null,
      executiva: request.tetos?.executiva ?? null,
      primeira: request.tetos?.primeira ?? null,
    };

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { ida: outbound, volta: inbound } = await pesquisarSeatspy(
        page,
        { companhia, origem, destino, idaEVolta: roundTrip },
        job.log,
        job.progress,
      );

      const legs: Leg[] = [
        {
          rotulo: roundTrip ? `Ida: ${origem} → ${destino}` : `${origem} → ${destino}`,
          secoes: construirRelatorioSeatspy(outbound, ceilings, showSeats).secoes,
        },
      ];
      if (inbound) {
        legs.push({
          rotulo: `Volta: ${destino} → ${origem}`,
          secoes: construirRelatorioSeatspy(inbound, ceilings, showSeats).secoes,
        });
      }

      recordSearch(jobId, {
        source: companhia,
        origin: origem,
        destination: destino,
        legs,
        ceilings: {
          "Econômica": ceilings.economica,
          Premium: ceilings.premium,
          Executiva: ceilings.executiva,
          "Primeira Classe": ceilings.primeira,
        },
      });
      this.jobs.complete(jobId, { pernas: legs });
    });
  }
}
