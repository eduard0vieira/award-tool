import { Inject, Injectable } from "@nestjs/common";
import path from "node:path";
import { SPREADSHEETS_DIR } from "../../../core/paths.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import { createSearchSheet, writeFlightsCsv, type FlightRow } from "../../../outputs/spreadsheet.ts";
import {
  buildIberiaReport,
  detailDays,
  filterFlights,
  iberiaBookingLink,
  searchIberiaYear,
  type FlightFilters,
  type IberiaSession,
} from "../../../scrapers/iberia/iberia.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch } from "../record-search.ts";
import { IberiaSearchDto } from "./iberia-search.dto.ts";

export const IBERIA_POOL = Symbol("IBERIA_POOL");

export function pickDatesToDetail(dates: string[], aviosByDate: Map<string, number>, howMany: number): string[] {
  if (howMany === 0) return [];
  const cheapestFirst = [...dates].sort((a, b) => (aviosByDate.get(a) ?? 0) - (aviosByDate.get(b) ?? 0));
  return howMany === -1 ? cheapestFirst : cheapestFirst.slice(0, howMany);
}

// A date that failed or was never reached has no flights either, so narrowing
// would present it as "no matching flight" instead of "not looked at".
export function narrowingBlocker(detail: { failedDates: number; stopped: boolean }): string | null {
  if (detail.stopped) return "o detalhe foi interrompido antes de olhar todas as datas";
  if (detail.failedDates > 0) return `${detail.failedDates} data(s) não puderam ser detalhadas`;
  return null;
}

// No cabin selector: the Avios grid returns one value per day, the cheapest,
// without saying which cabin it belongs to (docs/recon/iberia.md, 10 and 13).
@Injectable()
export class IberiaSource implements SearchSource<IberiaSearchDto> {
  readonly id = "iberia";
  readonly requestDto = IberiaSearchDto;

  constructor(
    @Inject(IBERIA_POOL) private readonly pool: SessionPool<IberiaSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: IberiaSearchDto) {
    const { origem, destino } = request;
    const route = { origin: origem, destination: destino, passengers: request.passageiros ?? 1 };
    const ceiling = request.teto ?? null;
    const daysToDetail = request.detalharDias ?? 0;
    const filters: FlightFilters = {
      maxStops: request.maxConexoes ?? null,
      cabins: request.cabines && request.cabines.length > 0 ? request.cabines : null,
    };

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const result = await searchIberiaYear(page, route, job.log, job.progress, job.notice, job.shouldStop);

      // An error never goes down as an empty report: the user must know the search did not happen.
      if (result.kind === "error") throw new Error(result.reason);

      const days = result.kind === "no_availability" ? [] : result.days;
      let section = { rotulo: "Avios", ...buildIberiaReport(days, ceiling, route) };
      const partialNotice = result.kind === "partial" ? `Cobertura parcial: ${result.reason}` : undefined;

      // The per-flight sheet says which flight and airline operate each day; the
      // grid only gives date and price. Failing here never drops the date result.
      let spreadsheetUrl: string | null = null;
      let localFile: string | null = null;
      const spreadsheetNotices: string[] = [];
      const aviosByDate = new Map(days.map((day) => [day.date, day.avios]));
      const chosenDates = pickDatesToDetail(
        section.dias.map((day) => day.data),
        aviosByDate,
        daysToDetail,
      );
      if (chosenDates.length > 0) {
        const detailAll = daysToDetail === -1;
        if (section.dias.length > chosenDates.length) {
          spreadsheetNotices.push(
            `A planilha de voos traz os ${chosenDates.length} dia(s) mais baratos; ` +
              `os outros ${section.dias.length - chosenDates.length} ficaram sem detalhe.`,
          );
        }

        const { flights, failedDays } = await detailDays(
          page,
          route,
          chosenDates,
          job.log,
          (fraction) => job.progress(0.7 + 0.3 * fraction),
          job.shouldStop,
        );
        const firstFailure = failedDays[0];
        if (firstFailure) {
          spreadsheetNotices.push(
            `${failedDays.length} dia(s) não puderam ser detalhados. ` +
              `Primeira falha (${firstFailure.date}): ${firstFailure.error}`,
          );
        }

        const filtered = filterFlights(flights, filters);
        if (flights.length > filtered.length) {
          spreadsheetNotices.push(`${flights.length - filtered.length} voo(s) ficaram fora pelos filtros pedidos.`);
        }

        // With every date detailed the filter can also narrow the date list. With
        // partial detail that would hide good dates that were simply not looked at.
        const hasFilter = Boolean(filters.cabins?.length) || filters.maxStops != null;
        const blocker = narrowingBlocker({ failedDates: failedDays.length, stopped: job.shouldStop() });
        if (detailAll && hasFilter && blocker) {
          spreadsheetNotices.push(
            `A lista de datas não foi filtrada pelo detalhe porque ${blocker}; as datas sem detalhe continuam na lista.`,
          );
        } else if (detailAll && hasFilter) {
          const datesWithFlight = new Set(filtered.map((flight) => flight.date));
          const before = section.dias.length;
          section = {
            rotulo: section.rotulo,
            ...buildIberiaReport(
              days.filter((day) => datesWithFlight.has(day.date)),
              ceiling,
              route,
            ),
          };
          spreadsheetNotices.push(
            `As datas foram filtradas pelo que o detalhe encontrou: ${section.dias.length} de ${before} têm voo ` +
              `dentro do que você pediu.`,
          );
        }

        const rows: FlightRow[] = filtered.map((flight) => ({
          departure_date: flight.date,
          arrival_date: flight.arrivalDate,
          departure_station: flight.origin,
          departure_time: flight.departureTime,
          arrival_station: flight.destination,
          connections: flight.stops,
          connecting_airports: flight.connectingAirports,
          points: "", // Iberia has no per-flight price; the day's goes in day_avios.
          duration: flight.durationMinutes,
          cabin_category: flight.cabins,
          operation_carriers: flight.airlines,
          program: "IBERIA",
          source_fare: flight.fare,
          available_seats: flight.seats ?? "",
          aircraft: flight.aircraft,
          tax: "",
          class_of_service: flight.serviceClasses,
          url: iberiaBookingLink(route, flight.date),
          day_avios: aviosByDate.get(flight.date) ?? "",
        }));

        if (rows.length > 0) {
          const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
          const fileName = `iberia-${origem}-${destino}-${stamp.replace(/[: ]/g, "-")}.csv`;
          try {
            writeFlightsCsv(rows, path.join(SPREADSHEETS_DIR, fileName));
            // The local file always exists while Google may be down or unconfigured;
            // without sending it to the screen a saved sheet looked like it was never made.
            localFile = `planilhas/${fileName}`;
          } catch (err) {
            spreadsheetNotices.push(
              `Não consegui gravar o CSV de voos: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          spreadsheetUrl = await createSearchSheet({ title: `Iberia ${origem}-${destino} ${stamp}`, rows }, job.log);
        } else {
          spreadsheetNotices.push("Nenhum voo sobrou depois dos filtros — a planilha de voos não foi gerada.");
        }
      }

      // The Iberia calendar ignores `preferredCabin` (measured: six variations
      // return identical responses). Without this, "Executiva" next to 18.000
      // Avios becomes a wrong promise to the client.
      const cabinNotice = filters.cabins?.length
        ? `Atenção: o valor de cada data é o mais barato do dia em QUALQUER cabine — ` +
          `a Iberia não dá preço por cabine no calendário. O filtro de ` +
          `${filters.cabins.join("/")} agiu só sobre a planilha de voos.`
        : undefined;
      const finalNotice = [cabinNotice, partialNotice, ...spreadsheetNotices].filter(Boolean).join(" ") || undefined;

      recordSearch(jobId, {
        source: "IBERIA",
        origin: origem,
        destination: destino,
        legs: [{ rotulo: `${origem} → ${destino}`, secoes: [section] }],
        ceilings: { Avios: ceiling == null ? null : Math.round(ceiling / 10) / 100 },
      });
      this.jobs.complete(jobId, {
        secaoIberia: section,
        avisoParcial: finalNotice,
        planilhaUrl: spreadsheetUrl,
        arquivoLocal: localFile,
      });
    });
  }
}
