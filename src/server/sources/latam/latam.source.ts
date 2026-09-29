import { Inject, Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  buildLatamReport,
  confirmPairInMiles,
  filterByCeilings,
  pickBestPairs,
  searchLatamYear,
  type LatamCeilings,
  type LatamDay,
  type LatamSession,
  type PairConfirmation,
} from "../../../scrapers/latam/latam.scraper.ts";
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

type Confirmation = { confirmation?: { pairs: PairConfirmation[] }; notice?: string };

type PairSearch = {
  origin: string;
  destination: string;
  outbound: LatamDay[];
  inbound: LatamDay[];
  ceilings: LatamCeilings;
  outboundMargin: number;
  inboundMargin: number;
};

// The calendar returns both legs in the same response, so one job resolves the round trip.
@Injectable()
export class LatamSource implements SearchSource<LatamSearchDto> {
  readonly id = "latam";
  readonly requestDto = LatamSearchDto;

  constructor(
    @Inject(LATAM_POOL) private readonly pool: SessionPool<LatamSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: LatamSearchDto) {
    const { origin, destination } = request;
    const ceilings: LatamCeilings = {
      maxPriceReais: request.ceilings?.maxReais ?? null,
      lowestFareOnly: request.ceilings?.lowestFareOnly === true,
    };

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { outbound, inbound, failedMonths } = await searchLatamYear(
        page,
        { origin, destination },
        job.log,
        job.progress,
        job.notice,
        job.shouldStop,
      );

      const legs: Leg[] = [
        {
          label: `Ida: ${origin} → ${destination}`,
          sections: [{ label: "Econômica", colorClass: "cabin-economy", ...buildLatamReport(outbound, ceilings) }],
        },
        {
          label: `Volta: ${destination} → ${origin}`,
          sections: [{ label: "Econômica", colorClass: "cabin-economy", ...buildLatamReport(inbound, ceilings) }],
        },
      ];
      let partialNotice =
        failedMonths.length > 0
          ? `${failedMonths.length} período(s) não puderam ser buscados. O resultado abaixo é parcial.`
          : undefined;

      let confirmation: Confirmation["confirmation"];
      if (request.confirmMiles === true) {
        const confirmed = await this.confirmBestPairs(jobId, page, job, {
          origin,
          destination,
          outbound,
          inbound,
          ceilings,
          outboundMargin: request.outboundMarginReais ?? 100,
          inboundMargin: request.returnMarginReais ?? 300,
        });
        confirmation = confirmed.confirmation;
        if (confirmed.notice) partialNotice = [partialNotice, confirmed.notice].filter(Boolean).join(" ");
      }

      recordSearch(jobId, {
        source: "LATAM",
        origin,
        destination,
        legs,
        ceilings: { "Econômica": ceilings.maxPriceReais },
      });
      this.jobs.complete(jobId, { legs, partialNotice, confirmation });
    });
  }

  // The price of a pair is not the sum of its legs: leg by leg LATAM charged
  // 243.535 miles for a pair that, bought together, costs 90.302.
  private async confirmBestPairs(jobId: string, page: Page, job: JobCallbacks, search: PairSearch): Promise<Confirmation> {
    const result: Confirmation = {};
    try {
      // Only days within the ceilings: the confirmation simulates what the group sees on the card.
      const pairs = pickBestPairs(
        filterByCeilings(search.outbound, search.ceilings),
        filterByCeilings(search.inbound, search.ceilings),
        config.latamPairs,
        search.outboundMargin,
        search.inboundMargin,
      );
      if (pairs.length === 0) {
        result.notice =
          "Nenhum par de ida e volta no resultado com 3 a 14 dias de viagem dentro da faixa de preço. " +
          "Confirmação em milhas não executada.";
      } else {
        const folder = `latam-${search.origin}-${search.destination}-${Date.now()}`;
        fs.mkdirSync(path.join(ALERTS_DIR, folder), { recursive: true });

        const confirmed: PairConfirmation[] = [];
        const failures: string[] = [];
        for (const [index, pair] of pairs.entries()) {
          job.notice(`Confirmando par ${index + 1}/${pairs.length}. ${pair.outbound.date} → ${pair.inbound.date}...`);
          const file = `par-${index + 1}.png`;
          try {
            const offer = await confirmPairInMiles(
              page,
              {
                origin: search.origin,
                destination: search.destination,
                outboundDate: pair.outbound.date,
                returnDate: pair.inbound.date,
                screenshotPath: path.join(ALERTS_DIR, folder, file),
              },
              job.log,
              // A login prompt becomes a notice: it is the only way the user learns
              // the search is waiting for them in the bot's window.
              job.notice,
            );
            if (offer) {
              confirmed.push({
                ...offer,
                image: offer.image ? `/alerts/${folder}/${file}` : "",
                outboundText: formatDatesByMonth([offer.outboundDate]),
                returnText: formatDatesByMonth([offer.returnDate]),
              });
            } else {
              failures.push(`${pair.outbound.date} → ${pair.inbound.date}: sem oferta em milhas`);
            }
          } catch (err) {
            // One failing pair never drops the others; the notice lists which ones were left out.
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[${jobId}] par ${pair.outbound.date}→${pair.inbound.date} falhou: ${reason}`);
            failures.push(`${pair.outbound.date} → ${pair.inbound.date}: ${reason}`);
          }
        }
        job.notice("");

        if (confirmed.length > 0) {
          result.confirmation = { pairs: confirmed };
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
