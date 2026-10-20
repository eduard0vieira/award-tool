import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { buildTapCalendarReport, readRouteCalendar } from "../../../scrapers/tap/tap-calendar.ts";
import { panoramaWindows, sweepPanorama } from "../../../scrapers/tap/tap-panorama.ts";
import { DEFAULT_BUSINESS_CEILING_K, type TapSession } from "../../../scrapers/tap/tap.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { recordSearch } from "../record-search.ts";
import { TapCalendarSearchDto } from "./tap-calendar-search.dto.ts";
import { TAP_POOL } from "./tap.source.ts";

// The stored data spans TAP's whole saver range, so economy goes up to 60K here,
// above the live search's 53K: it takes the 59K days.
export const DEFAULT_CALENDAR_ECONOMY_CEILING_K = 60;
export const DEFAULT_MAX_AGE_HOURS = 120;

const NOT_TRACKED = "O AwardTool não acompanha a TAP nesse trecho.";
// The calendar covers about a year ahead; the Panorama fallback reads the same span.
const PANORAMA_FALLBACK_DAYS = 360;

function todayInSaoPaulo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

@Injectable()
export class TapCalendarSource implements SearchSource<TapCalendarSearchDto> {
  readonly id = "tap-calendar";
  readonly requestDto = TapCalendarSearchDto;

  identity(request: TapCalendarSearchDto) {
    return {
      origin: request.origin,
      destination: request.destination,
      business: request.ceilings?.business ?? null,
      economy: request.ceilings?.economy ?? null,
      businessFloor: request.floors?.business ?? null,
      economyFloor: request.floors?.economy ?? null,
      nonstopOnly: request.nonstopOnly ?? false,
      maxAgeHours: request.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS,
    };
  }

  constructor(
    @Inject(TAP_POOL) private readonly pool: SessionPool<TapSession>,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: TapCalendarSearchDto) {
    const { origin, destination } = request;
    const ceilingsK = {
      business: request.ceilings?.business ?? DEFAULT_BUSINESS_CEILING_K,
      economy: request.ceilings?.economy ?? DEFAULT_CALENDAR_ECONOMY_CEILING_K,
    };
    const floorsK = { business: request.floors?.business ?? null, economy: request.floors?.economy ?? null };
    const filters = { nonstopOnly: request.nonstopOnly ?? false, maxAgeHours: request.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS };
    const appliedCeilings = {
      businessK: ceilingsK.business,
      economyK: ceilingsK.economy,
      businessFloorK: floorsK.business,
      economyFloorK: floorsK.economy,
    };

    return this.runner.run(this.pool, jobId, async ({ page, baseUrl }) => {
      const job = this.jobs.callbacks(jobId);
      job.log(`Lendo o calendário do AwardTool para ${origin}-${destination}...`);
      job.progress(0.1);
      let dates = await readRouteCalendar(page, baseUrl, origin, destination);
      const notices: string[] = [];
      let partialNotice: string | undefined;
      // The calendar has missed TAP on routes Panorama has (FOR-LIS), so an empty
      // calendar is only "not tracked" once Panorama agrees.
      if (dates.length === 0) {
        job.log("O calendário não tem a TAP nesse trecho; conferindo no Panorama...");
        const route = `${origin}-${destination}`;
        const sweep = await sweepPanorama(
          page,
          baseUrl,
          { from: `${origin}_4`, to: `${destination}_4` },
          panoramaWindows(todayInSaoPaulo(), PANORAMA_FALLBACK_DAYS),
          job.log,
          (done, total) => job.progress(0.1 + (0.8 * done) / total),
        );
        dates = sweep.dates.filter((date) => date.route === route);
        if (dates.length > 0) notices.push("Datas vindas do Panorama: o calendário do AwardTool não tem a TAP nesse trecho.");
        if (sweep.incompleteWindows.length > 0) {
          const missing = sweep.incompleteWindows.map((window) => `${window.start} a ${window.end}`).join(", ");
          partialNotice = `O Panorama não respondeu por inteiro em ${missing}. As datas desse período podem estar faltando.`;
        }
      }
      const report = buildTapCalendarReport(dates, {
        ...filters,
        ceilingsK,
        floorsK,
        now: Math.floor(Date.now() / 1000),
        route: { origin, destination },
      });
      job.progress(1);

      if (report.kind === "not_tracked" && !partialNotice) {
        const empty = { min: null, max: null, days: [], text: NOT_TRACKED, emptyReason: NOT_TRACKED };
        this.jobs.complete(jobId, {
          report: { business: empty, economy: empty },
          appliedCeilings,
          filters,
          notTracked: true,
          notices: [`${NOT_TRACKED} (${origin} → ${destination})`],
        });
        return;
      }

      if (report.kind === "not_tracked") {
        const reason = "Nenhuma data da TAP chegou do AwardTool, mas parte do Panorama não respondeu.";
        const empty = { min: null, max: null, days: [], text: reason, emptyReason: reason };
        this.jobs.complete(jobId, { report: { business: empty, economy: empty }, appliedCeilings, filters, partialNotice });
        return;
      }
      if (report.staleDates > 0) {
        const newest = report.newestStaleSeenAt === null ? "" : `, a mais recente vista em ${seenAtText(report.newestStaleSeenAt)}`;
        notices.push(
          `${report.staleDates} data(s) dentro da faixa de milhas ficaram de fora por terem sido vistas há mais de ${filters.maxAgeHours} h${newest}.`,
        );
      }
      if (report.mixedCabinDates > 0) {
        notices.push(`${report.mixedCabinDates} data(s) só tinham Executiva com trecho em Econômica e não contam como Executiva.`);
      }
      job.log(`${report.business.days.length} datas de Executiva e ${report.economy.days.length} de Econômica.`);

      recordSearch(jobId, {
        source: "tap",
        origin,
        destination,
        legs: [
          {
            label: `${origin} → ${destination}`,
            sections: [
              { ...report.business, label: "Executiva" },
              { ...report.economy, label: "Econômica" },
            ],
          },
        ],
        ceilings: { Executiva: ceilingsK.business, "Econômica": ceilingsK.economy },
      });
      this.jobs.complete(jobId, {
        report: { business: report.business, economy: report.economy },
        appliedCeilings,
        filters,
        coverage: { until: report.coveredUntil, seenBetween: report.seenBetween },
        notices,
        partialNotice,
      });
    });
  }
}

function seenAtText(seconds: number) {
  return new Date(seconds * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
