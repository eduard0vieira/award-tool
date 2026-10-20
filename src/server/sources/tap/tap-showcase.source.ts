import { Inject, Injectable } from "@nestjs/common";
import { SessionPool } from "../../../core/session-pool.ts";
import { buildTapCalendarReport, readRouteCalendar, type TapCalendarDate } from "../../../scrapers/tap/tap-calendar.ts";
import { panoramaWindows, sweepPanorama } from "../../../scrapers/tap/tap-panorama.ts";
import { buildTapUpgradeSection, TAP_BRAZIL_AIRPORTS, tapUpgradeCostK } from "../../../scrapers/tap/tap-upgrade.ts";
import { DEFAULT_BUSINESS_CEILING_K, type TapSession } from "../../../scrapers/tap/tap.scraper.ts";
import { JobRunner } from "../../jobs/job-runner.service.ts";
import { JobStore } from "../../jobs/job-store.service.ts";
import type { SearchSource } from "../../search/search-source.ts";
import { DEFAULT_CALENDAR_ECONOMY_CEILING_K, DEFAULT_MAX_AGE_HOURS } from "./tap-calendar.source.ts";
import { TapCalendarSearchDto } from "./tap-calendar-search.dto.ts";
import { TAP_POOL } from "./tap.source.ts";

const SHOWCASE_DAYS = 360;
// Panorama has missed whole Brazil-Portugal routes the calendar has (SSA-LIS), and
// those are the ones with the upgrade alert, so their calendars are read too.
const CALENDAR_ROUTES = [...[...TAP_BRAZIL_AIRPORTS].map((origin) => `${origin}-LIS`), "GRU-OPO", "GIG-OPO"];

type CabinSummary = { days: number; minK: number | null };
export type ShowcaseRoute = {
  route: string;
  origin: string;
  destination: string;
  business: CabinSummary;
  economy: CabinSummary;
  upgrade: CabinSummary | null;
  coveredUntil: string;
  staleDates: number;
};

const summary = (section: { days: unknown[]; min: number | null }): CabinSummary => ({ days: section.days.length, minK: section.min });

function todayInSaoPaulo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// Every TAP route from Brazil to Europe in one result, to pick which ones go to
// the group. One job, so the notebook does not update in the middle of it.
@Injectable()
export class TapShowcaseSource implements SearchSource<TapCalendarSearchDto> {
  readonly id = "tap-showcase";
  readonly requestDto = TapCalendarSearchDto;

  identity(request: TapCalendarSearchDto) {
    return {
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
      const byRoute = new Map<string, Map<string, TapCalendarDate>>();
      const keepNewest = (route: string, date: TapCalendarDate) => {
        const dates = byRoute.get(route) ?? new Map<string, TapCalendarDate>();
        const known = dates.get(date.date);
        if (!known || known.any.seenAt < date.any.seenAt) dates.set(date.date, date);
        byRoute.set(route, dates);
      };

      job.log("Buscando Brasil → Europa no Panorama do AwardTool...");
      const steps = 4 + CALENDAR_ROUTES.length;
      const sweep = await sweepPanorama(
        page,
        baseUrl,
        { from: "BR_2", to: "EUMAJOR_1" },
        panoramaWindows(todayInSaoPaulo(), SHOWCASE_DAYS),
        job.log,
        (done) => job.progress(done / steps),
      );
      for (const date of sweep.dates) keepNewest(date.route, date);

      const failedRoutes: string[] = [];
      for (const [index, route] of CALENDAR_ROUTES.entries()) {
        const [origin, destination] = route.split("-") as [string, string];
        job.log(`Conferindo o calendário de ${route}...`);
        try {
          for (const date of await readRouteCalendar(page, baseUrl, origin, destination)) keepNewest(route, date);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          job.log(`  (calendário de ${route} falhou: ${message})`);
          failedRoutes.push(route);
        }
        job.progress((5 + index) / steps);
      }

      const now = Math.floor(Date.now() / 1000);
      const routes: ShowcaseRoute[] = [];
      for (const [route, dates] of byRoute) {
        const [origin, destination] = route.split("-") as [string, string];
        const report = buildTapCalendarReport(
          [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)),
          { ...filters, ceilingsK, floorsK, now, route: { origin, destination } },
        );
        if (report.kind !== "ok") continue;
        const costK = tapUpgradeCostK(origin, destination);
        routes.push({
          route,
          origin,
          destination,
          business: summary(report.business),
          economy: summary(report.economy),
          upgrade: costK === null ? null : summary(buildTapUpgradeSection(report.business.days, report.economy.days, costK)),
          coveredUntil: report.coveredUntil,
          staleDates: report.staleDates,
        });
      }
      routes.sort((a, b) => b.business.days - a.business.days || b.economy.days - a.economy.days || a.route.localeCompare(b.route));

      const gaps = [
        ...sweep.incompleteWindows.map((window) => `o Panorama não respondeu por inteiro de ${window.start} a ${window.end}`),
        ...(failedRoutes.length > 0 ? [`o calendário falhou em ${failedRoutes.join(", ")}`] : []),
      ];
      job.log(`${routes.length} rotas com datas da TAP.`);
      this.jobs.complete(jobId, {
        report: { routes },
        appliedCeilings,
        filters,
        ...(gaps.length > 0 && { partialNotice: `Vitrine parcial: ${gaps.join("; ")}.` }),
      });
    });
  }
}
