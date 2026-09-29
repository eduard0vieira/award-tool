import { Inject, Injectable } from "@nestjs/common";
import {
  construirRelatorioSmiles,
  pesquisarAnoSmiles,
  type PeriodoSmiles,
  type SessaoSmiles,
} from "../../../fontes/smiles/bot-smiles.ts";
import { PoolSessoes } from "../../../nucleo/pool-sessoes.ts";
import { criarPlanilhaDaBusca, type LinhaVoo } from "../../../saidas/planilha.ts";
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
// themselves are enforced by the bot, which knows them.
function toPeriod(period: SmilesPeriodDto | undefined): PeriodoSmiles {
  const result: PeriodoSmiles = {};
  const from = asDate(period?.de, false);
  const until = asDate(period?.ate, true);
  if (from) result.de = from;
  if (until) result.ate = until;
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

  constructor(
    @Inject(SMILES_POOL) private readonly pool: PoolSessoes<SessaoSmiles>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: SmilesSearchDto) {
    const { origem, destino } = request;
    const ceilings = {
      economica: request.tetos?.economica ?? null,
      premium: request.tetos?.premium ?? null,
      executiva: request.tetos?.executiva ?? null,
    };
    const period = toPeriod(request.periodo);

    return this.runner.run(this.pool, jobId, async ({ page }) => {
      const job = this.jobs.callbacks(jobId);
      const { dias, diasComFalha, lacunas, doCache } = await pesquisarAnoSmiles(
        page,
        { origem, destino },
        ceilings,
        job.log,
        job.progress,
        job.shouldStop,
        period,
      );

      const legs: Leg[] = [{ rotulo: `${origem} → ${destino}`, secoes: construirRelatorioSmiles(dias, ceilings) }];

      // The gaps come already worded by the bot, which is what knows what it left uncovered.
      const gaps = [...lacunas];
      const firstFailure = diasComFalha[0];
      if (firstFailure) {
        gaps.push(`${diasComFalha.length} dia(s) falharam. O primeiro foi ${firstFailure.data}: ${firstFailure.erro}`);
      }
      // Cached data is not data from this hour; counting it is what separates
      // saving a request from showing a stale price without saying so.
      if (doCache > 0) {
        gaps.push(`${doCache} dia(s) vieram de consulta recente reaproveitada, não de agora`);
      }
      const partialNotice = gaps.length > 0 ? `Cobertura parcial. ${gaps.join("; ")}.` : undefined;

      const rows: LinhaVoo[] = [];
      for (const day of dias) {
        for (const flight of day.voos) {
          const detail = flight.detalhe;
          rows.push({
            departure_date: detail.partidaData,
            arrival_date: detail.chegadaData,
            departure_station: detail.partidaAeroporto,
            departure_time: detail.partidaHora,
            arrival_station: detail.chegadaAeroporto,
            connections: flight.conexoes,
            connecting_airports: detail.aeroportosConexao,
            points: flight.milhas,
            duration: detail.duracaoMinutos,
            cabin_category: detail.cabineCru,
            operation_carriers: detail.codigoCompanhia,
            program: "SMILES",
            source_fare: flight.tarifa,
            available_seats: flight.assentos,
            aircraft: detail.aeronaves,
            tax: flight.taxaReais ?? "",
            class_of_service: detail.classesServico,
            url: smilesSearchUrl(origem, destino, detail.partidaData),
          });
        }
      }
      const spreadsheetUrl = await criarPlanilhaDaBusca(
        {
          titulo: `Smiles ${origem}-${destino} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          linhas: rows,
        },
        job.log,
      );

      recordSearch(jobId, {
        fonte: "SMILES",
        origem,
        destino,
        pernas: legs,
        tetos: { "Econômica": ceilings.economica, Conforto: ceilings.premium, Executiva: ceilings.executiva },
      });
      this.jobs.complete(jobId, { pernas: legs, avisoParcial: partialNotice, planilhaUrl: spreadsheetUrl });
    });
  }
}
