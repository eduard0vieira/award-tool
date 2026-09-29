import { Inject, Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  confirmarParEmMilhas,
  construirRelatorioLatam,
  escolherMelhoresPares,
  filtrarPorTetos,
  pesquisarAnoLatam,
  type ConfirmacaoPar,
  type DiaLatam,
  type SessaoLatam,
  type TetosLatam,
} from "../../../fontes/latam/bot-latam.ts";
import { formatDatesByMonth } from "../../../core/common.ts";
import { ALERTS_DIR } from "../../../core/paths.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import { config } from "../../config.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { JobCallbacks } from "../../jobs/job.types.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch, type Leg } from "../record-search.ts";
import { LatamSearchDto } from "./latam-search.dto.ts";

export const LATAM_POOL = Symbol("LATAM_POOL");

type Confirmation = { confirmation?: { pares: ConfirmacaoPar[] }; notice?: string };

type PairSearch = {
  origem: string;
  destino: string;
  outbound: DiaLatam[];
  inbound: DiaLatam[];
  ceilings: TetosLatam;
  outboundMargin: number;
  inboundMargin: number;
};

// The calendar returns both legs in the same response, so one job resolves the round trip.
@Injectable()
export class LatamSource implements SearchSource<LatamSearchDto> {
  readonly id = "latam";
  readonly requestDto = LatamSearchDto;

  constructor(
    @Inject(LATAM_POOL) private readonly pool: SessionPool<SessaoLatam>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: LatamSearchDto) {
    const { origem, destino } = request;
    const ceilings: TetosLatam = {
      tetoReais: request.tetos?.reais ?? null,
      somenteMenorTarifa: request.tetos?.somenteMenorTarifa === true,
    };

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { ida: outbound, volta: inbound, mesesComFalha } = await pesquisarAnoLatam(
        page,
        { origem, destino },
        job.log,
        job.progress,
        job.notice,
        job.shouldStop,
      );

      const legs: Leg[] = [
        {
          rotulo: `Ida: ${origem} → ${destino}`,
          secoes: [{ rotulo: "Econômica", corClasse: "cartao-economica", ...construirRelatorioLatam(outbound, ceilings) }],
        },
        {
          rotulo: `Volta: ${destino} → ${origem}`,
          secoes: [{ rotulo: "Econômica", corClasse: "cartao-economica", ...construirRelatorioLatam(inbound, ceilings) }],
        },
      ];
      let partialNotice =
        mesesComFalha.length > 0
          ? `${mesesComFalha.length} período(s) não puderam ser buscados. O resultado abaixo é parcial.`
          : undefined;

      let confirmation: Confirmation["confirmation"];
      if (request.confirmarMilhas === true) {
        const confirmed = await this.confirmBestPairs(jobId, page, job, {
          origem,
          destino,
          outbound,
          inbound,
          ceilings,
          outboundMargin: request.margemIdaReais ?? 100,
          inboundMargin: request.margemVoltaReais ?? 300,
        });
        confirmation = confirmed.confirmation;
        if (confirmed.notice) partialNotice = [partialNotice, confirmed.notice].filter(Boolean).join(" ");
      }

      recordSearch(jobId, {
        source: "LATAM",
        origin: origem,
        destination: destino,
        legs,
        ceilings: { "Econômica": ceilings.tetoReais },
      });
      this.jobs.complete(jobId, { pernas: legs, avisoParcial: partialNotice, confirmacao: confirmation });
    });
  }

  // The price of a pair is not the sum of its legs: leg by leg LATAM charged
  // 243.535 miles for a pair that, bought together, costs 90.302.
  private async confirmBestPairs(jobId: string, page: Page, job: JobCallbacks, search: PairSearch): Promise<Confirmation> {
    const result: Confirmation = {};
    try {
      // Only days within the ceilings: the confirmation simulates what the group sees on the card.
      const pairs = escolherMelhoresPares(
        filtrarPorTetos(search.outbound, search.ceilings),
        filtrarPorTetos(search.inbound, search.ceilings),
        config.latamPairs,
        search.outboundMargin,
        search.inboundMargin,
      );
      if (pairs.length === 0) {
        result.notice =
          "Nenhum par de ida e volta no resultado com 3 a 14 dias de viagem dentro da faixa de preço. " +
          "Confirmação em milhas não executada.";
      } else {
        const folder = `latam-${search.origem}-${search.destino}-${Date.now()}`;
        fs.mkdirSync(path.join(ALERTS_DIR, folder), { recursive: true });

        const confirmed: ConfirmacaoPar[] = [];
        const failures: string[] = [];
        for (const [index, pair] of pairs.entries()) {
          job.notice(`Confirmando par ${index + 1}/${pairs.length}. ${pair.ida.data} → ${pair.volta.data}...`);
          const file = `par-${index + 1}.png`;
          try {
            const offer = await confirmarParEmMilhas(
              page,
              {
                origem: search.origem,
                destino: search.destino,
                dataIda: pair.ida.data,
                dataVolta: pair.volta.data,
                caminhoImagem: path.join(ALERTS_DIR, folder, file),
              },
              job.log,
              // A login prompt becomes a notice: it is the only way the user learns
              // the search is waiting for them in the bot's window.
              job.notice,
            );
            if (offer) {
              confirmed.push({
                ...offer,
                imagem: offer.imagem ? `/alertas/${folder}/${file}` : "",
                textoIda: formatDatesByMonth([offer.dataIda]),
                textoVolta: formatDatesByMonth([offer.dataVolta]),
              });
            } else {
              failures.push(`${pair.ida.data} → ${pair.volta.data}: sem oferta em milhas`);
            }
          } catch (err) {
            // One failing pair never drops the others; the notice lists which ones were left out.
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[${jobId}] par ${pair.ida.data}→${pair.volta.data} falhou: ${reason}`);
            failures.push(`${pair.ida.data} → ${pair.volta.data}: ${reason}`);
          }
        }
        job.notice("");

        if (confirmed.length > 0) {
          result.confirmation = { pares: confirmed };
          if (failures.length > 0) {
            result.notice = `Confirmação parcial: ${failures.length} de ${pairs.length} pares sem resultado. ${failures.join(" · ")}`;
          }
        } else {
          result.notice = `Confirmação em milhas sem resultado em nenhum dos ${pairs.length} pares: ${failures.join(" · ")}`;
        }
      }
    } catch (err) {
      // Nothing here may drop the calendar result: the dates in reais already
      // cost the whole sweep and are useful on their own.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${jobId}] confirmação em milhas falhou: ${message}`);
      result.notice = `Confirmação em milhas interrompida: ${message}. As datas abaixo permanecem válidas.`;
    }
    job.notice("");
    return result;
  }
}
