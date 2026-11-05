import { Inject, Injectable } from "@nestjs/common";
import path from "node:path";
import { SPREADSHEETS_DIR } from "../../../core/paths.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import { createSearchSheet, writeFlightsCsv, type FlightRow } from "../../../outputs/spreadsheet.ts";
import {
  buildIberiaReport,
  detailDays,
  iberiaBookingLink,
  searchIberiaYear,
  type IberiaCabin,
  type IberiaFlight,
  type IberiaSearchParams,
  type IberiaSession,
} from "../../../scrapers/iberia/iberia.scraper.ts";
import type { StoredSmilesDay } from "../../../scrapers/smiles/smiles-flights.ts";
import { buildSmilesReport, type SmilesSection } from "../../../scrapers/smiles/smiles.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch, type Leg } from "../record-search.ts";
import { IberiaSearchDto } from "./iberia-search.dto.ts";

export const IBERIA_POOL = Symbol("IBERIA_POOL");
export const DEFAULT_IBERIA_DETAIL_DAYS = 5;
export const CALENDAR_SECTION_LABEL = "Menor preço do dia, qualquer cabine";

const CABIN_LABELS: Record<IberiaCabin, string> = { economy: "Econômica", premium: "Premium Economy", business: "Executiva" };

// One row per cabin of each flight: the Avios is that cabin's, and a connection
// has none (Iberia prices only its own direct flights), so its cell stays empty.
export function iberiaFlightRows(flights: IberiaFlight[], route: IberiaSearchParams, aviosByDate: Map<string, number>): FlightRow[] {
  return flights.flatMap((flight) =>
    flight.fares.map((fare) => ({
      departure_date: flight.date,
      arrival_date: flight.arrivalDate,
      departure_station: flight.origin,
      departure_time: flight.departureTime,
      arrival_station: flight.destination,
      connections: flight.stops,
      connecting_airports: flight.connectingAirports.join(", "),
      points: fare.avios ?? "",
      duration: flight.durationMinutes,
      cabin_category: CABIN_LABELS[fare.cabin],
      operation_carriers: flight.carriers.map((carrier) => carrier.code).join(", "),
      program: "IBERIA",
      source_fare: "",
      available_seats: fare.seats ?? "",
      aircraft: flight.aircraft.join(", "),
      tax: "",
      class_of_service: "",
      url: iberiaBookingLink(route, flight.date),
      day_avios: aviosByDate.get(flight.date) ?? "",
    })),
  );
}

// What the flight filter keeps: the priced cabins only. A connection has no
// Avios of its own, and a price-less flight in a priced list would be read as free.
export function storedIberiaDays(dates: string[], flights: IberiaFlight[]): StoredSmilesDay[] {
  return dates.map((date) => ({
    date,
    flights: flights
      .filter((flight) => flight.date === date)
      .flatMap((flight) =>
        flight.fares
          .filter((fare): fare is typeof fare & { avios: number } => fare.avios !== null)
          // 0 is how the report says "no seat count", not "no seats": a priced offer is bookable.
          .map((fare) => ({ cabin: fare.cabin, miles: fare.avios, seats: fare.seats ?? 0, stops: flight.stops, carriers: flight.carriers })),
      ),
  }));
}

// The flight report under Iberia's own names: Smiles calls the premium cabin "Conforto".
export function iberiaFlightSections(days: StoredSmilesDay[], route: IberiaSearchParams): SmilesSection[] {
  return buildSmilesReport(days, {}, (date) => iberiaBookingLink(route, date)).map((section) =>
    section.label === "Conforto" ? { ...section, label: CABIN_LABELS.premium } : section,
  );
}

export function pickDatesToDetail(dates: string[], aviosByDate: Map<string, number>, howMany: number): string[] {
  return [...dates].sort((a, b) => (aviosByDate.get(a) ?? 0) - (aviosByDate.get(b) ?? 0)).slice(0, howMany);
}

// The calendar gives every day with an award, cheapest in ANY cabin (§15), so
// its section carries no cabin. The detail then opens the cheapest days flight
// by flight, as many as Iberia lets one session ask (§17), and only those
// flights' own Avios go under a cabin.
@Injectable()
export class IberiaSource implements SearchSource<IberiaSearchDto> {
  readonly id = "iberia";
  readonly requestDto = IberiaSearchDto;

  identity(request: IberiaSearchDto) {
    return {
      origin: request.origin,
      destination: request.destination,
      ceiling: request.ceiling ?? null,
      passengers: request.passengers ?? null,
      detailDays: request.detailDays ?? DEFAULT_IBERIA_DETAIL_DAYS,
    };
  }

  constructor(
    @Inject(IBERIA_POOL) private readonly pool: SessionPool<IberiaSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: IberiaSearchDto) {
    const { origin, destination } = request;
    const route = { origin, destination, passengers: request.passengers ?? 1 };
    const ceiling = request.ceiling ?? null;
    const daysToDetail = request.detailDays ?? DEFAULT_IBERIA_DETAIL_DAYS;

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const result = await searchIberiaYear(page, route, job.log, (fraction) => job.progress(0.6 * fraction), job.notice, job.shouldStop);
      // An error never goes down as an empty report: the user must know the search did not happen.
      if (result.kind === "error") throw new Error(result.reason);

      const days = result.kind === "no_availability" ? [] : result.days;
      const calendar = { label: CALENDAR_SECTION_LABEL, ...buildIberiaReport(days, ceiling, route) };
      const notices: string[] = [];
      const partial: string[] = result.kind === "partial" ? [`Cobertura parcial do calendário: ${result.reason}`] : [];

      const aviosByDate = new Map(days.map((day) => [day.date, day.avios]));
      const chosen = pickDatesToDetail(
        calendar.days.map((day) => day.date),
        aviosByDate,
        daysToDetail,
      );
      let flightSections: SmilesSection[] = [];
      let stored: StoredSmilesDay[] = [];
      let spreadsheetUrl: string | null = null;
      let localFile: string | null = null;

      if (chosen.length > 0) {
        if (calendar.days.length > chosen.length) {
          notices.push(
            `Voo a voo: os ${chosen.length} dia(s) mais baratos do calendário. ` +
              `Os outros ${calendar.days.length - chosen.length} têm só o preço do calendário.`,
          );
        }
        const detail = await detailDays(
          page,
          route,
          chosen,
          job.log,
          (fraction) => job.progress(0.6 + 0.4 * fraction),
          job.shouldStop,
          job.notice,
        );
        const detailed = chosen.filter((date) => !detail.failedDays.some((failed) => failed.date === date));
        if (detail.cut) {
          partial.push(`A Iberia cortou o detalhe depois de ${detailed.length} de ${chosen.length} dia(s): ${detail.cut}`);
        } else if (detail.failedDays.length > 0) {
          const [first] = detail.failedDays;
          partial.push(`${detail.failedDays.length} dia(s) não puderam ser detalhados. Primeira falha (${first!.date}): ${first!.error}`);
        }

        stored = storedIberiaDays(detailed, detail.flights);
        flightSections = iberiaFlightSections(stored, route);
        const onlyConnections = stored.filter((day) => day.flights.length === 0).length;
        if (onlyConnections > 0) {
          notices.push(
            `${onlyConnections} dia(s) detalhados só tinham voos com conexão, que a Iberia não precifica voo a voo: ` +
              "esses dias ficam só com o preço do calendário.",
          );
        }

        const rows = iberiaFlightRows(detail.flights, route, aviosByDate);
        if (rows.length > 0) {
          const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
          const fileName = `iberia-${origin}-${destination}-${stamp.replace(/[: ]/g, "-")}.csv`;
          try {
            writeFlightsCsv(rows, path.join(SPREADSHEETS_DIR, fileName));
            localFile = `spreadsheets/${fileName}`;
          } catch (err) {
            notices.push(`Não consegui gravar o CSV de voos: ${err instanceof Error ? err.message : String(err)}`);
          }
          spreadsheetUrl = await createSearchSheet({ title: `Iberia ${origin}-${destination} ${stamp}`, rows }, job.log);
        }
      }

      const legs: Leg[] = [{ label: `${origin} → ${destination}`, sections: [calendar, ...flightSections] }];
      recordSearch(jobId, {
        source: "IBERIA",
        origin,
        destination,
        legs,
        ceilings: { Avios: ceiling == null ? null : Math.round(ceiling / 10) / 100 },
      });
      if (stored.length > 0) this.jobs.keepFlights(jobId, stored);
      this.jobs.complete(jobId, {
        legs,
        spreadsheetUrl,
        localFile,
        ...(partial.length > 0 ? { partialNotice: [...partial, ...notices].join(" ") } : notices.length > 0 ? { notices } : {}),
      });
    });
  }
}
