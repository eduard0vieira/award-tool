import { Inject, Injectable } from "@nestjs/common";
import path from "node:path";
import {
  construirRelatorioIberia,
  detalharDias,
  filtrarVoos,
  linkEmissaoIberia,
  pesquisarAnoIberia,
  type FiltrosVoo,
  type SessaoIberia,
} from "../../../fontes/iberia/bot-iberia.ts";
import { SPREADSHEETS_DIR } from "../../../core/paths.ts";
import { SessionPool } from "../../../core/session-pool.ts";
import { criarPlanilhaDaBusca, gravarCsvDeVoos, type LinhaVoo } from "../../../saidas/planilha.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch } from "../record-search.ts";
import { IberiaSearchDto } from "./iberia-search.dto.ts";

export const IBERIA_POOL = Symbol("IBERIA_POOL");

export function pickDatesToDetail(dates: string[], aviosByDate: Map<string, number>, detailDays: number): string[] {
  if (detailDays === 0) return [];
  const cheapestFirst = [...dates].sort((a, b) => (aviosByDate.get(a) ?? 0) - (aviosByDate.get(b) ?? 0));
  return detailDays === -1 ? cheapestFirst : cheapestFirst.slice(0, detailDays);
}

// A date that failed or was never reached has no flights either, so narrowing
// would present it as "no matching flight" instead of "not looked at".
export function narrowingBlocker(detail: { failedDates: number; stopped: boolean }): string | null {
  if (detail.stopped) return "o detalhe foi interrompido antes de olhar todas as datas";
  if (detail.failedDates > 0) return `${detail.failedDates} data(s) não puderam ser detalhadas`;
  return null;
}

// No cabin selector: the Avios grid returns one value per day, the cheapest,
// without saying which cabin it belongs to (contexto/notas-recon-iberia.md, 10 and 13).
@Injectable()
export class IberiaSource implements SearchSource<IberiaSearchDto> {
  readonly id = "iberia";
  readonly requestDto = IberiaSearchDto;

  constructor(
    @Inject(IBERIA_POOL) private readonly pool: SessionPool<SessaoIberia>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: IberiaSearchDto) {
    const { origem, destino } = request;
    const route = { origem, destino, passageiros: request.passageiros ?? 1 };
    const ceiling = request.teto ?? null;
    const detailDays = request.detalharDias ?? 0;
    const filters: FiltrosVoo = {
      maxEscalas: request.maxConexoes ?? null,
      cabines: request.cabines && request.cabines.length > 0 ? request.cabines : null,
    };

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const result = await pesquisarAnoIberia(page, route, job.log, job.progress, job.notice, job.shouldStop);

      // An error never goes down as an empty report: the user must know the search did not happen.
      if (result.tipo === "erro") throw new Error(result.motivo);

      const days = result.tipo === "sem_disponibilidade" ? [] : result.dias;
      let section = { rotulo: "Avios", ...construirRelatorioIberia(days, ceiling, route) };
      const partialNotice = result.tipo === "parcial" ? `Cobertura parcial: ${result.motivo}` : undefined;

      // The per-flight sheet says which flight and airline operate each day; the
      // grid only gives date and price. Failing here never drops the date result.
      let spreadsheetUrl: string | null = null;
      let localFile: string | null = null;
      const spreadsheetNotices: string[] = [];
      const aviosByDate = new Map(days.map((day) => [day.data, day.avios]));
      const chosenDates = pickDatesToDetail(
        section.dias.map((day) => day.data),
        aviosByDate,
        detailDays,
      );
      if (chosenDates.length > 0) {
        const detailAll = detailDays === -1;
        if (section.dias.length > chosenDates.length) {
          spreadsheetNotices.push(
            `A planilha de voos traz os ${chosenDates.length} dia(s) mais baratos; ` +
              `os outros ${section.dias.length - chosenDates.length} ficaram sem detalhe.`,
          );
        }

        const { voos: flights, diasComFalha } = await detalharDias(
          page,
          route,
          chosenDates,
          job.log,
          (fraction) => job.progress(0.7 + 0.3 * fraction),
          job.shouldStop,
        );
        const firstFailure = diasComFalha[0];
        if (firstFailure) {
          spreadsheetNotices.push(
            `${diasComFalha.length} dia(s) não puderam ser detalhados. ` +
              `Primeira falha (${firstFailure.data}): ${firstFailure.erro}`,
          );
        }

        const filtered = filtrarVoos(flights, filters);
        if (flights.length > filtered.length) {
          spreadsheetNotices.push(`${flights.length - filtered.length} voo(s) ficaram fora pelos filtros pedidos.`);
        }

        // With every date detailed the filter can also narrow the date list. With
        // partial detail that would hide good dates that were simply not looked at.
        const hasFilter = Boolean(filters.cabines?.length) || filters.maxEscalas != null;
        const blocker = narrowingBlocker({ failedDates: diasComFalha.length, stopped: job.shouldStop() });
        if (detailAll && hasFilter && blocker) {
          spreadsheetNotices.push(
            `A lista de datas não foi filtrada pelo detalhe porque ${blocker}; as datas sem detalhe continuam na lista.`,
          );
        } else if (detailAll && hasFilter) {
          const datesWithFlight = new Set(filtered.map((flight) => flight.data));
          const before = section.dias.length;
          section = {
            rotulo: section.rotulo,
            ...construirRelatorioIberia(
              days.filter((day) => datesWithFlight.has(day.data)),
              ceiling,
              route,
            ),
          };
          spreadsheetNotices.push(
            `As datas foram filtradas pelo que o detalhe encontrou: ${section.dias.length} de ${before} têm voo ` +
              `dentro do que você pediu.`,
          );
        }

        const rows: LinhaVoo[] = filtered.map((flight) => ({
          departure_date: flight.data,
          arrival_date: flight.chegadaData,
          departure_station: flight.origem,
          departure_time: flight.partidaHora,
          arrival_station: flight.destino,
          connections: flight.escalas,
          connecting_airports: flight.aeroportosConexao,
          points: "", // Iberia has no per-flight price; the day's goes in day_avios.
          duration: flight.duracaoMinutos,
          cabin_category: flight.cabines,
          operation_carriers: flight.companhias,
          program: "IBERIA",
          source_fare: flight.tarifa,
          available_seats: flight.assentos ?? "",
          aircraft: flight.aeronaves,
          tax: "",
          class_of_service: flight.classesServico,
          url: linkEmissaoIberia(route, flight.data),
          day_avios: aviosByDate.get(flight.data) ?? "",
        }));

        if (rows.length > 0) {
          const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
          const fileName = `iberia-${origem}-${destino}-${stamp.replace(/[: ]/g, "-")}.csv`;
          try {
            gravarCsvDeVoos(rows, path.join(SPREADSHEETS_DIR, fileName));
            // The local file always exists while Google may be down or unconfigured;
            // without sending it to the screen a saved sheet looked like it was never made.
            localFile = `planilhas/${fileName}`;
          } catch (err) {
            spreadsheetNotices.push(
              `Não consegui gravar o CSV de voos: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          spreadsheetUrl = await criarPlanilhaDaBusca(
            { titulo: `Iberia ${origem}-${destino} ${stamp}`, linhas: rows },
            job.log,
          );
        } else {
          spreadsheetNotices.push("Nenhum voo sobrou depois dos filtros — a planilha de voos não foi gerada.");
        }
      }

      // The Iberia calendar ignores `preferredCabin` (measured: six variations
      // return identical responses). Without this, "Executiva" next to 18.000
      // Avios becomes a wrong promise to the client.
      const cabinNotice = filters.cabines?.length
        ? `Atenção: o valor de cada data é o mais barato do dia em QUALQUER cabine — ` +
          `a Iberia não dá preço por cabine no calendário. O filtro de ` +
          `${filters.cabines.join("/")} agiu só sobre a planilha de voos.`
        : undefined;
      const finalNotice = [cabinNotice, partialNotice, ...spreadsheetNotices].filter(Boolean).join(" ") || undefined;

      recordSearch(jobId, {
        fonte: "IBERIA",
        origem,
        destino,
        pernas: [{ rotulo: `${origem} → ${destino}`, secoes: [section] }],
        tetos: { Avios: ceiling == null ? null : Math.round(ceiling / 10) / 100 },
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
