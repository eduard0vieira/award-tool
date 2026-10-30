import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { searchGoogleCalendar, type RoundTripPrice } from "../../../scrapers/google-flights/google-flights.scraper.ts";
import { formatDatesByMonth, type FormattedDay } from "../../../core/common.ts";
import { latamBookingLink, pickBestPairs, type LatamSession } from "../../../scrapers/latam/latam.scraper.ts";
import { config } from "../../config.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { confirmPairList } from "./latam-confirmation.ts";
import { GoogleLatamSearchDto } from "./google-latam-search.dto.ts";
import { LATAM_POOL } from "./latam.source.ts";

const DEFAULT_STAY_DAYS = 7;
const DEFAULT_BAND_PERCENT = 10;
// LATAM sells about 330 days ahead; Google's calendar goes about as far.
const HORIZON_DAYS = 330;

const CABINS = {
  Economy: { label: "Econômica", colorClass: "cabin-economy" },
  Business: { label: "Executiva", colorClass: "cabin-business" },
} as const;

function dayFromToday(days: number) {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// The round trips up to `bandPercent` above Google's cheapest: the dates Eduardo
// used to pick by hand, and the ones the card and the alert carry.
export function cheapestBand(prices: RoundTripPrice[], bandPercent: number): RoundTripPrice[] {
  if (prices.length === 0) return [];
  const lowest = Math.min(...prices.map((price) => price.priceReais));
  return prices.filter((price) => price.priceReais <= lowest * (1 + bandPercent / 100));
}

// One direction of the band, in reais. A date shared by two trips keeps the cheaper.
export function bandSection(band: RoundTripPrice[], direction: "outbound" | "return", route: { origin: string; destination: string }) {
  const byDate = new Map<string, number>();
  for (const trip of band) {
    const date = trip[direction];
    byDate.set(date, Math.min(byDate.get(date) ?? Infinity, trip.priceReais));
  }
  const days: FormattedDay[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, valueK]) => ({ date, valueK, link: latamBookingLink(route, date) }));
  const values = days.map((day) => day.valueK);
  return {
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    days,
    text: formatDatesByMonth(days.map((day) => day.date)),
    unit: "BRL" as const,
  };
}

// The calendar's own draw over the band: pairs spread over the period. Each
// outbound only pairs with its own return, since the trip length is fixed.
export function cheapestPairs(band: RoundTripPrice[], stayDays: number, count = config.latamPairs) {
  if (band.length === 0) return [];
  const outbound = band.map((price) => ({ date: price.outbound, price: price.priceReais, lowestFare: false }));
  const inbound = band.map((price) => ({ date: price.return, price: price.priceReais, lowestFare: false }));
  return pickBestPairs(outbound, inbound, count, Infinity, Infinity, undefined, stayDays, stayDays).map((pair) => ({
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
      bandPercent: request.bandPercent ?? DEFAULT_BAND_PERCENT,
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
    const bandPercent = request.bandPercent ?? DEFAULT_BAND_PERCENT;
    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      job.progress(0.05);
      const { prices, cutAfter } = await searchGoogleCalendar(
        page,
        { origin, destination, airline: "LA", cabin, stayDays },
        { from: dayFromToday(1), until: dayFromToday(HORIZON_DAYS) },
        job.log,
      );
      if (prices.length === 0) {
        throw new Error(`O Google Flights não mostrou nenhum ida e volta da LATAM de ${stayDays} dias em ${origin} ⇄ ${destination}.`);
      }
      const band = cheapestBand(prices, bandPercent);
      const chosen = cheapestPairs(band, stayDays);
      const lowest = Math.min(...prices.map((price) => price.priceReais));
      job.log(`Google Flights: ${prices.length} dias, menor ida e volta R$ ${lowest}, ${band.length} até ${bandPercent}% acima. Pares: ${chosen.map((pair) => `${pair.outbound}→${pair.return} R$ ${pair.priceReais}`).join(", ")}.`);
      job.progress(0.2);

      const { confirmed, withoutOffer, failed } = await confirmPairList(jobId, page, job, { origin, destination, cabin }, chosen);
      if (confirmed.length === 0 && withoutOffer.length === 0) {
        throw new Error(`Nenhum par pôde ser conferido na LATAM: ${failed.join(" · ")}`);
      }
      // Every date of the band, in reais as Google shows them: the pairs only lend
      // the points the alert announces.
      const { label, colorClass } = CABINS[cabin];
      const legs = [
        {
          label: `Ida: ${origin} → ${destination}`,
          sections: [{ label, colorClass, ...bandSection(band, "outbound", { origin, destination }) }],
        },
        {
          label: `Volta: ${destination} → ${origin}`,
          sections: [{ label, colorClass, ...bandSection(band, "return", { origin: destination, destination: origin }) }],
        },
      ];
      const cut =
        cutAfter &&
        `O Google Flights só carregou o calendário até ${cutAfter.date.split("-").reverse().join("/")} (${cutAfter.reason}); as idas depois disso ficaram de fora.`;
      const notices = [
        cut,
        withoutOffer.length > 0 && `Sem voo em milhas na ${label}: ${withoutOffer.join(", ")}.`,
        failed.length > 0 && `Não conferidos por falha: ${failed.join(" · ")}.`,
      ].filter(Boolean);
      const partial = failed.length > 0 || cutAfter !== null;
      this.jobs.complete(jobId, {
        legs,
        confirmation: { pairs: confirmed },
        google: { stayDays, bandPercent, lowestReais: lowest, days: prices.length, kept: band.length, pairs: chosen },
        ...(partial && { partialNotice: notices.join(" ") }),
        ...(!partial && notices.length > 0 && { notices }),
      });
    });
  }
}
