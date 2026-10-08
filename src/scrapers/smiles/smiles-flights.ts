import { buildSmilesReport, type SmilesCabin, type SmilesCarrier, type SmilesDayResponse, type SmilesSection } from "./smiles.scraper.ts";

// What a finished search keeps of each flight: enough to filter it and rebuild
// the report with the same rules, nothing the spreadsheet already has.
export type StoredSmilesFlight = { cabin: SmilesCabin; miles: number; seats: number; stops: number; carriers: SmilesCarrier[] | null };
export type StoredSmilesDay = { date: string; flights: StoredSmilesFlight[] };

export type MilesRange = { min?: number | null | undefined; max?: number | null | undefined };

export type SmilesFlightFilter = {
  // A flight passes when EVERY leg is flown by one of these; empty means any.
  carriers?: string[] | undefined;
  maxStops?: number | null | undefined;
  miles?: Partial<Record<SmilesCabin, MilesRange>> | undefined;
};

export type CarrierOption = { code: string; name: string; flights: number };
export type MilesOption = { miles: number; flights: number; days: number };

export function storedSmilesDays(days: SmilesDayResponse[]): StoredSmilesDay[] {
  return days.map((day) => ({
    date: day.date,
    flights: day.flights.map((flight) => ({
      cabin: flight.cabin,
      miles: flight.miles,
      seats: flight.seats,
      stops: flight.stops,
      carriers: flight.detail.operatingCarriers,
    })),
  }));
}

function passes(flight: StoredSmilesFlight, filter: SmilesFlightFilter): boolean {
  if (filter.maxStops != null && flight.stops > filter.maxStops) return false;
  const range = filter.miles?.[flight.cabin];
  if (range?.min != null && flight.miles < range.min) return false;
  if (range?.max != null && flight.miles > range.max) return false;
  if (filter.carriers && filter.carriers.length > 0) {
    const allowed = new Set(filter.carriers);
    if (!flight.carriers || !flight.carriers.every((carrier) => allowed.has(carrier.code))) return false;
  }
  return true;
}

export type FilteredSmiles = {
  sections: (SmilesSection & { carriers: string[] })[];
  carrierOptions: CarrierOption[];
  // Every miles value per cabin, like the spreadsheet's filter by values, among
  // the flights that pass the airline and stop choices but ignoring the miles
  // range, so the whole spread stays visible when picking a limit.
  milesOptions: Record<SmilesCabin, MilesOption[]>;
  flightsWithoutCarrier: number;
};

// The report of the flights that pass, built by buildSmilesReport itself so the
// days, values, seats and the date text follow exactly the search's rules. Each
// section also lists the operators of the flights it quotes: what an alert can
// truthfully say about who flies every date in it.
export function filterSmilesFlights(days: StoredSmilesDay[], filter: SmilesFlightFilter): FilteredSmiles {
  const options = new Map<string, CarrierOption>();
  let flightsWithoutCarrier = 0;
  for (const flight of days.flatMap((day) => day.flights)) {
    if (!flight.carriers) {
      flightsWithoutCarrier++;
      continue;
    }
    for (const carrier of new Map(flight.carriers.map((carrier) => [carrier.code, carrier])).values()) {
      const option = options.get(carrier.code) ?? { code: carrier.code, name: carrier.name, flights: 0 };
      option.flights++;
      options.set(carrier.code, option);
    }
  }

  const milesOptions = { economy: new Map(), premium: new Map(), business: new Map() } as Record<
    SmilesCabin,
    Map<number, { flights: number; days: Set<string> }>
  >;
  const withoutMiles = { ...filter, miles: undefined };
  for (const day of days) {
    for (const flight of day.flights) {
      if (!passes(flight, withoutMiles)) continue;
      const option = milesOptions[flight.cabin].get(flight.miles) ?? { flights: 0, days: new Set<string>() };
      option.flights++;
      option.days.add(day.date);
      milesOptions[flight.cabin].set(flight.miles, option);
    }
  }
  const sortedOptions = (cabin: SmilesCabin): MilesOption[] =>
    [...milesOptions[cabin].entries()]
      .sort(([a], [b]) => a - b)
      .map(([miles, option]) => ({ miles, flights: option.flights, days: option.days.size }));

  const kept = days.map((day) => ({ date: day.date, flights: day.flights.filter((flight) => passes(flight, filter)) }));
  const sections = buildSmilesReport(kept).map((section) => ({
    ...section,
    carriers: [...new Set(section.days.flatMap((day) => day.carriers ?? []))].sort(),
  }));

  return {
    sections,
    carrierOptions: [...options.values()].sort((a, b) => b.flights - a.flights || a.code.localeCompare(b.code)),
    milesOptions: { economy: sortedOptions("economy"), premium: sortedOptions("premium"), business: sortedOptions("business") },
    flightsWithoutCarrier,
  };
}
