import { Inject, Injectable } from "@nestjs/common";
import {
  construirRelatorio,
  pesquisarAnoCompleto,
  TETO_ECONOMICA_K_PADRAO,
  TETO_EXECUTIVA_K_PADRAO,
  type Sessao,
} from "../../../fontes/tap/bot-tap.ts";
import { SessionPool } from "../../../core/session-pool.ts";
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
    @Inject(TAP_POOL) private readonly pool: SessionPool<Sessao>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: TapSearchDto) {
    const { origem, destino } = request;
    // Ceilings are in K here: the TAP table is spoken in thousands, unlike SeatSpy and AA.
    const ceilings = { executivaK: request.tetos?.executiva ?? null, economicaK: request.tetos?.economica ?? null };

    return this.runner.run(this.pool, jobId, async ({ page, baseUrl }) => {
      const job = this.jobs.callbacks(jobId);
      const { dias, janelasComFalha, interrompidaPorVoce } = await pesquisarAnoCompleto(
        page,
        { baseUrl, origem, destino, cabineParam: CABIN_PARAM },
        job.log,
        job.progress,
        job.window,
        job.notice,
        job.ask,
        job.shouldStop,
      );

      const report = construirRelatorio(dias, ceilings);
      // Sent to the front so the ceiling actually applied is explicit instead of
      // an outdated server silently applying the default.
      const appliedCeilings = {
        executivaK: ceilings.executivaK ?? TETO_EXECUTIVA_K_PADRAO,
        economicaK: ceilings.economicaK ?? TETO_ECONOMICA_K_PADRAO,
      };
      const partialNotice = interrompidaPorVoce
        ? "Você interrompeu a busca depois das janelas vazias. O resultado abaixo cobre só o período já consultado."
        : janelasComFalha.length > 0
          ? `${janelasComFalha.length} janela(s) não puderam ser buscadas (ver detalhes no terminal do servidor). O resultado abaixo é parcial.`
          : undefined;

      recordSearch(jobId, {
        source: "tap",
        origin: origem,
        destination: destino,
        legs: [
          {
            rotulo: `${origem} → ${destino}`,
            secoes: [
              { ...report.executivas, rotulo: "Executiva" },
              { ...report.economicas, rotulo: "Econômica" },
            ],
          },
        ],
        ceilings: { Executiva: appliedCeilings.executivaK, "Econômica": appliedCeilings.economicaK },
      });
      this.jobs.complete(jobId, {
        relatorio: report,
        avisoParcial: partialNotice,
        tetosAplicados: appliedCeilings,
        interrompidaPorVoce,
      });
    });
  }
}
