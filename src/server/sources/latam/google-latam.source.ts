import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { searchGoogleCalendar, type RoundTripPrice } from "../../../scrapers/google-flights/google-flights.scraper.ts";
import { pickBestPairs, type LatamSession } from "../../../scrapers/latam/latam.scraper.ts";
import { config } from "../../config.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { confirmPairList } from "./latam-confirmation.ts";
import { confirmedSection } from "./latam-pairs.source.ts";
import { GoogleLatamSearchDto } from "./google-latam-search.dto.ts";
import { LATAM_POOL } from "./latam.source.ts";

const DEFAULT_STAY_DAYS = 7;
// Candidates: the round trips up to this much above Google's cheapest.
const PRICE_BAND = Number(process.env.GOOGLE_LATAM_PRICE_BAND) || 0.1;
// LATAM sells about 330 days ahead; Google's calendar goes about as far.
const HORIZON_DAYS = 330;

const CABINS = {
  Economy: { label: "Econômica", colorClass: "cabin-economy" },
  Business: { label: "Executiva", colorClass: "cabin-business" },
} as const;

function dayFromToday(days: number) {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// The calendar's own draw over Google's prices: the cheapest round trips within
// the band, spread over the period. Each outbound only pairs with its own return,
// since the trip length is fixed.
export function cheapestPairs(prices: RoundTripPrice[], stayDays: number, count = config.latamPairs) {
  if (prices.length === 0) return [];
  const lowest = Math.min(...prices.map((price) => price.priceReais));
  const outbound = prices.map((price) => ({ date: price.outbound, price: price.priceReais, lowestFare: false }));
  const inbound = prices.map((price) => ({ date: price.return, price: price.priceReais, lowestFare: false }));
  return pickBestPairs(outbound, inbound, count, lowest * PRICE_BAND, Infinity, undefined, stayDays, stayDays).map((pair) => ({
    outbound: pair.outbound.date,
    return: pair.inbound.date,
    priceReais: pair.outbound.price,
  }));
}

// What Eduardo did by hand: Google Flights filtered to LATAM, the cheapest dates
// of its calendar, then each pair tested on LATAM's site, mostly in business.
@Injectable()
export class GoogleLatamSource implements SearchSource<GoogleLatamSearchDto> {
  readonly id = "google-latam";
  readonly requestDto = GoogleLatamSearchDto;

  identity(request: GoogleLatamSearchDto) {
    return {
      origin: request.origin,
      destination: request.destination,
      cabin: request.cabin ?? "Business",
      stayDays: request.stayDays ?? DEFAULT_STAY_DAYS,
    };
  }

  constructor(
    @Inject(LATAM_POOL) private readonly pool: SessionPool<LatamSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: GoogleLatamSearchDto) {
    const { origin, destination } = request;
    const cabin = request.cabin ?? "Business";
    const stayDays = request.stayDays ?? DEFAULT_STAY_DAYS;
    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      job.progress(0.05);
      const prices = await searchGoogleCalendar(
        page,
        { origin, destination, airline: "LA", cabin, stayDays },
        { from: dayFromToday(1), until: dayFromToday(HORIZON_DAYS) },
        job.log,
      );
      if (prices.length === 0) {
        throw new Error(`O Google Flights não mostrou nenhum ida e volta da LATAM de ${stayDays} dias em ${origin} ⇄ ${destination}.`);
      }
      const chosen = cheapestPairs(prices, stayDays);
      const lowest = Math.min(...prices.map((price) => price.priceReais));
      job.log(`Google Flights: ${prices.length} dias, menor ida e volta R$ ${lowest}. Pares: ${chosen.map((pair) => `${pair.outbound}→${pair.return} R$ ${pair.priceReais}`).join(", ")}.`);
      job.progress(0.2);

      const { confirmed, withoutOffer, failed } = await confirmPairList(jobId, page, job, { origin, destination, cabin }, chosen);
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
        google: { stayDays, lowestReais: lowest, days: prices.length, pairs: chosen },
        ...(failed.length > 0 && { partialNotice: notices.join(" ") }),
        ...(failed.length === 0 && notices.length > 0 && { notices }),
      });
    });
  }
}
