import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { createSearchSheet, type FlightRow } from "../../../outputs/spreadsheet.ts";
import {
  buildSmilesReport,
  searchSmilesYear,
  type SmilesPeriod,
  type SmilesSession,
} from "../../../scrapers/smiles/smiles.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch, type Leg } from "../record-search.ts";
import { SmilesSearchDto, type SmilesPeriodDto } from "./smiles-search.dto.ts";

export const SMILES_POOL = Symbol("SMILES_POOL");

function asDate(value: string | undefined, endOfMonth: boolean): string | undefined {
  if (!value) return undefined;
  if (value.length === 10) return value;
  if (!endOfMonth) return `${value}-01`;
  const [year, month] = value.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

// A month starts on its first day and ends on its last; the sweep rules
// themselves are enforced by the scraper, which knows them.
function toPeriod(period: SmilesPeriodDto | undefined): SmilesPeriod {
  const result: SmilesPeriod = {};
  const from = asDate(period?.from, false);
  const until = asDate(period?.until, true);
  if (from) result.from = from;
  if (until) result.until = until;
  return result;
}

function smilesSearchUrl(origin: string, destination: string, date: string): string {
  const query = new URLSearchParams({
    adults: "1",
    cabin: "ALL",
    children: "0",
    departureDate: `${Date.parse(`${date}T12:00:00Z`)}`,
    infants: "0",
    tripType: "2",
    originAirport: origin,
    destinationAirport: destination,
  });
  return `https://www.smiles.com.br/mfe/emissao-passagem/?${query}`;
}

// One direction per job (the endpoint is one-way) with all three cabins together.
@Injectable()
export class SmilesSource implements SearchSource<SmilesSearchDto> {
  readonly id = "smiles";
  readonly requestDto = SmilesSearchDto;

  identity(request: SmilesSearchDto) {
    return {
      origin: request.origin,
      destination: request.destination,
      economy: request.ceilings?.economy ?? null,
      premium: request.ceilings?.premium ?? null,
      business: request.ceilings?.business ?? null,
      // Normalized, so "2026-11" and "2026-11-01" are the same period.
      period: toPeriod(request.period),
    };
  }

  constructor(
    @Inject(SMILES_POOL) private readonly pool: SessionPool<SmilesSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: SmilesSearchDto) {
    const { origin, destination } = request;
    const ceilings = {
      economy: request.ceilings?.economy ?? null,
      premium: request.ceilings?.premium ?? null,
      business: request.ceilings?.business ?? null,
    };
    const period = toPeriod(request.period);

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { days, failedDays, gaps, fromCache } = await searchSmilesYear(
        page,
        { origin, destination },
        ceilings,
        job.log,
        job.progress,
        job.shouldStop,
        period,
      );

      const legs: Leg[] = [{ label: `${origin} → ${destination}`, sections: buildSmilesReport(days, ceilings) }];

      // The gaps come already worded by the scraper, which knows what it left uncovered.
      const notices = [...gaps];
      const firstFailure = failedDays[0];
      if (firstFailure) {
        notices.push(`${failedDays.length} dia(s) falharam. O primeiro foi ${firstFailure.date}: ${firstFailure.error}`);
      }
      // Cached data is not data from this hour; counting it is what separates
      // saving a request from showing a stale price without saying so.
      if (fromCache > 0) {
        notices.push(`${fromCache} dia(s) vieram de consulta recente reaproveitada, não de agora`);
      }
      const partialNotice = notices.length > 0 ? `Cobertura parcial. ${notices.join("; ")}.` : undefined;

      const rows: FlightRow[] = days.flatMap((day) =>
        day.flights.map((flight) => ({
          departure_date: flight.detail.departureDate,
          arrival_date: flight.detail.arrivalDate,
          departure_station: flight.detail.departureAirport,
          departure_time: flight.detail.departureTime,
          arrival_station: flight.detail.arrivalAirport,
          connections: flight.stops,
          connecting_airports: flight.detail.connectingAirports,
          points: flight.miles,
          duration: flight.detail.durationMinutes,
          cabin_category: flight.detail.rawCabin,
          // The operators of each leg, not the seller: filtering this column on "AA"
          // must mean flights American actually flies.
          operation_carriers: flight.detail.operatingCarriers?.map((carrier) => carrier.code).join(", ") ?? "não informado",
          program: "SMILES",
          source_fare: flight.fare,
          available_seats: flight.seats,
          aircraft: flight.detail.aircraft,
          tax: flight.feeReais ?? "",
          class_of_service: flight.detail.serviceClasses,
          url: smilesSearchUrl(origin, destination, flight.detail.departureDate),
        })),
      );
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const spreadsheetUrl = await createSearchSheet({ title: `Smiles ${origin}-${destination} ${stamp}`, rows }, job.log);

      recordSearch(jobId, {
        source: "SMILES",
        origin,
        destination,
        legs,
        ceilings: { "Econômica": ceilings.economy, Conforto: ceilings.premium, Executiva: ceilings.business },
      });
      this.jobs.complete(jobId, { legs, partialNotice, spreadsheetUrl });
    });
  }
}
