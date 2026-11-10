import { Inject, Injectable } from "@nestjs/common";
import type { ChromeSession } from "../../../core/chrome-session.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import { searchGoogleCalendar, type RoundTripPrice } from "../../../scrapers/google-flights/google-flights.scraper.ts";
import { formatDatesByMonth, type FormattedDay } from "../../../core/common.ts";
import { latamBookingLink } from "../../../scrapers/latam/latam.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { GoogleLatamSearchDto } from "./google-latam-search.dto.ts";

export const GOOGLE_POOL = Symbol("GOOGLE_POOL");

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

// Google Flights filtered to LATAM, the cheapest dates of its calendar, in reais.
// The LATAM site is never opened: its login and anti-bot used to fail the whole
// search and throw the Google dates away with it.
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
    @Inject(GOOGLE_POOL) private readonly pool: SessionPool<ChromeSession>,
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
      const lowest = Math.min(...prices.map((price) => price.priceReais));
      job.log(`Google Flights: ${prices.length} dias, menor ida e volta R$ ${lowest}, ${band.length} até ${bandPercent}% acima.`);
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
      const google = { stayDays, bandPercent, lowestReais: lowest, days: prices.length, kept: band.length };
      if (cutAfter) {
        const until = cutAfter.date.split("-").reverse().join("/");
        const partialNotice = `O Google Flights só carregou o calendário até ${until} (${cutAfter.reason}); as idas depois disso ficaram de fora.`;
        this.jobs.complete(jobId, { legs, google, partialNotice });
      } else {
        this.jobs.complete(jobId, { legs, google });
      }
    });
  }
}
