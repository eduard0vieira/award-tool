import { Inject, Injectable } from "@nestjs/common";
import { formatDatesByMonth, type FormattedDay } from "../../../core/common.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import {
  latamBookingLink,
  pickBestPairs,
  type LatamDay,
  type LatamSession,
  type PairConfirmation,
} from "../../../scrapers/latam/latam.scraper.ts";
import { config } from "../../config.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { confirmPairList } from "./latam-confirmation.ts";
import { LatamPairsSearchDto } from "./latam-pairs-search.dto.ts";
import { LATAM_POOL } from "./latam.source.ts";

const CABINS = {
  Economy: { label: "Econômica", colorClass: "cabin-economy" },
  Business: { label: "Executiva", colorClass: "cabin-business" },
} as const;

// The dates of the confirmed pairs in one direction, each at the points LATAM
// charged for that leg inside its pair. A date in two pairs keeps the lowest.
export function confirmedSection(pairs: PairConfirmation[], direction: "outbound" | "return", route: { origin: string; destination: string }) {
  const byDate = new Map<string, number>();
  for (const pair of pairs) {
    const date = direction === "outbound" ? pair.outboundDate : pair.returnDate;
    const miles = direction === "outbound" ? pair.outboundMiles : pair.returnMiles;
    if (miles === null) continue;
    byDate.set(date, Math.min(byDate.get(date) ?? Infinity, miles));
  }
  const days: FormattedDay[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, miles]) => ({ date, valueK: Math.round(miles / 10) / 100, link: latamBookingLink(route, date) }));
  if (days.length === 0) return { min: null, max: null, days, text: "Nenhuma disponibilidade encontrada nesse período." };
  const values = days.map((day) => day.valueK);
  return { min: Math.min(...values), max: Math.max(...values), days, text: formatDatesByMonth(days.map((day) => day.date)) };
}

// The calendar's own draw, with every date at the same price: pairs spread over
// the period, 3 to 14 days of trip, the return after the outbound.
export function drawPairs(outboundDates: string[], returnDates: string[]) {
  const asDays = (dates: string[]): LatamDay[] => [...new Set(dates)].map((date) => ({ date, price: 0, lowestFare: false }));
  return pickBestPairs(asDays(outboundDates), asDays(returnDates), config.latamPairs).map((pair) => ({
    outbound: pair.outbound.date,
    return: pair.inbound.date,
  }));
}

// Tests dates picked by hand: the bot draws round-trip pairs from them and
// confirms each one in miles on LATAM's site, with its screen captured, as the
// calendar search does for the pairs it picks itself.
@Injectable()
export class LatamPairsSource implements SearchSource<LatamPairsSearchDto> {
  readonly id = "latam-pairs";
  readonly requestDto = LatamPairsSearchDto;

  identity(request: LatamPairsSearchDto) {
    return {
      origin: request.origin,
      destination: request.destination,
      cabin: request.cabin,
      outboundDates: [...request.outboundDates].sort(),
      returnDates: [...request.returnDates].sort(),
    };
  }

  constructor(
    @Inject(LATAM_POOL) private readonly pool: SessionPool<LatamSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: LatamPairsSearchDto) {
    const { origin, destination, cabin } = request;
    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const pairs = drawPairs(request.outboundDates, request.returnDates);
      if (pairs.length === 0) {
        throw new Error("Nenhum par de ida e volta com 3 a 14 dias de viagem entre as datas informadas.");
      }
      job.log(`Pares sorteados: ${pairs.map((pair) => `${pair.outbound} → ${pair.return}`).join(", ")}.`);
      const { confirmed, withoutOffer, failed } = await confirmPairList(jobId, page, job, { origin, destination, cabin }, pairs);
      if (confirmed.length === 0 && withoutOffer.length === 0) {
        throw new Error(`Nenhum par pôde ser conferido na LATAM: ${failed.join(" · ")}`);
      }

      const { label, colorClass } = CABINS[cabin];
      const legs = [
        {
          label: `Ida: ${origin} → ${destination}`,
          sections: [{ label, colorClass, ...confirmedSection(confirmed, "outbound", { origin, destination }) }],
        },
        {
          label: `Volta: ${destination} → ${origin}`,
          sections: [{ label, colorClass, ...confirmedSection(confirmed, "return", { origin: destination, destination: origin }) }],
        },
      ];
      const notices = [
        withoutOffer.length > 0 && `Sem voo em milhas na ${label}: ${withoutOffer.join(", ")}.`,
        failed.length > 0 && `Não conferidos por falha: ${failed.join(" · ")}.`,
      ].filter(Boolean);
      this.jobs.complete(jobId, {
        legs,
        confirmation: { pairs: confirmed },
        // Only a failure makes it partial; a pair without a flight in miles is an answer.
        ...(failed.length > 0 && { partialNotice: notices.join(" ") }),
        ...(failed.length === 0 && notices.length > 0 && { notices }),
      });
    });
  }
}
