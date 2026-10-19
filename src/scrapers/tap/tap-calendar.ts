import { inflateSync } from "node:zlib";
import type { Page } from "playwright";
import { formatDatesByMonth, type FormattedDay, type ReportSection } from "../../core/common.ts";
import { awardtoolRateLimiter } from "./tap.scraper.ts";

// AwardTool's route calendar: a year of its stored award data for one route, every
// program in a single response. See docs/recon/awardtool-panorama.md.

type Fares = { seenAt: number; economy: number | null; business: number | null };

export type TapCalendarDate = {
  date: string;
  any: Fares & { businessShare: number | null };
  nonstop: Fares;
};

const TAP_PROGRAM = "TP";
const CALENDAR_TIMEOUT_MS = 45000;

function fail(route: string, detail: string): never {
  throw new Error(`O calendário do AwardTool para ${route} veio num formato inesperado: ${detail}.`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function milesField(set: Record<string, unknown>, key: string, where: string, route: string): number | null {
  if (!(key in set)) fail(route, `falta o campo ${where}.${key}`);
  const value = set[key];
  if (value === null) return null;
  if (typeof value !== "number") fail(route, `${where}.${key} não é número`);
  return value;
}

function seenAtField(set: Record<string, unknown>, where: string, route: string): number {
  if (typeof set.ls !== "number") fail(route, `falta o campo ${where}.ls`);
  return set.ls;
}

// The page receives the body still wrapped: base64 of zlib inside "ciphered_data".
export function decodeCalendarResponse(raw: string, route: string): TapCalendarDate[] {
  const wrapper = asRecord(JSON.parse(raw));
  if (typeof wrapper?.ciphered_data !== "string") fail(route, "falta o campo ciphered_data");
  const body = asRecord(JSON.parse(inflateSync(Buffer.from(wrapper.ciphered_data, "base64")).toString()));
  if (body?.status !== 200) fail(route, `status ${String(body?.status)}`);
  if (!Array.isArray(body.data)) fail(route, "falta a lista data");

  const rows = body.data.map(asRecord);
  // The page may still be answering for the route it showed before: those dates must never pass for this one.
  if (rows.length > 0 && !rows.some((row) => row?.route === route)) fail(route, "a resposta é de outro trecho");

  return rows
    .filter((row) => row?.route === route && row.program === TAP_PROGRAM)
    .map((row) => {
      const date = row!.date;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(route, "linha sem date");
      const points = asRecord(row!.points) ?? fail(route, `${date} sem points`);
      const nonstop = asRecord(row!.points_ns) ?? fail(route, `${date} sem points_ns`);
      const business = milesField(points, "j", "points", route);
      const share = asRecord(points.c_p);
      if (business !== null && typeof share?.j !== "number") fail(route, `${date} sem points.c_p.j`);
      return {
        date,
        any: {
          seenAt: seenAtField(points, "points", route),
          economy: milesField(points, "y", "points", route),
          business,
          businessShare: business === null ? null : (share!.j as number),
        },
        nonstop: {
          seenAt: seenAtField(nonstop, "points_ns", route),
          economy: milesField(nonstop, "y", "points_ns", route),
          business: milesField(nonstop, "j", "points_ns", route),
        },
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function readRouteCalendar(page: Page, baseUrl: string, origin: string, destination: string) {
  const route = `${origin}-${destination}`;
  await awardtoolRateLimiter.waitTurn();
  const [response] = await Promise.all([
    page
      .waitForResponse((candidate) => candidate.url().endsWith("/routes_calendar_v2"), { timeout: CALENDAR_TIMEOUT_MS })
      .catch((err: unknown) => {
        throw new Error(`O calendário do AwardTool para ${route} não respondeu em ${CALENDAR_TIMEOUT_MS / 1000} s.`, { cause: err });
      }),
    page.goto(`${baseUrl}/route-detail?route=${route}`),
  ]);
  if (!response.ok()) throw new Error(`O calendário do AwardTool para ${route} respondeu HTTP ${response.status()}.`);
  return decodeCalendarResponse(await response.text(), route);
}

export type TapCalendarDay = FormattedDay & { seenAt: number };
export type TapCalendarSection = Omit<ReportSection, "days"> & { days: TapCalendarDay[]; emptyReason?: string };

export type TapCalendarOptions = {
  nonstopOnly: boolean;
  maxAgeHours: number;
  ceilingsK: { business: number; economy: number };
  // Unix seconds, like the calendar's "last seen".
  now: number;
};

export type TapCalendarReport =
  | { kind: "not_tracked" }
  | {
      kind: "ok";
      business: TapCalendarSection;
      economy: TapCalendarSection;
      coveredUntil: string;
      // Dates within the ceilings left out because AwardTool last saw them too long ago.
      staleDates: number;
      newestStaleSeenAt: number | null;
      mixedCabinDates: number;
      seenBetween: { oldest: number; newest: number } | null;
    };

const STALE_REASON = (hours: number) =>
  `Só há datas vistas pelo AwardTool há mais de ${hours} h. Aumente a idade máxima no formulário para vê-las.`;

export function buildTapCalendarReport(dates: TapCalendarDate[], options: TapCalendarOptions): TapCalendarReport {
  if (dates.length === 0) return { kind: "not_tracked" };
  const { nonstopOnly, maxAgeHours, ceilingsK, now } = options;
  const oldestAllowed = now - maxAgeHours * 3600;

  const kept = { business: [] as TapCalendarDay[], economy: [] as TapCalendarDay[] };
  const staleByCabin = { business: 0, economy: 0 };
  const staleDates = new Set<string>();
  let newestStaleSeenAt: number | null = null;
  let mixedCabinDates = 0;

  for (const entry of dates) {
    const fares = nonstopOnly ? entry.nonstop : entry.any;
    const mixedCabin = !nonstopOnly && entry.any.businessShare !== null && entry.any.businessShare < 100;
    if (mixedCabin) mixedCabinDates++;
    for (const cabin of ["business", "economy"] as const) {
      const miles = cabin === "business" && mixedCabin ? null : fares[cabin];
      if (miles === null || miles > ceilingsK[cabin] * 1000) continue;
      if (fares.seenAt < oldestAllowed) {
        staleByCabin[cabin]++;
        staleDates.add(entry.date);
        newestStaleSeenAt = Math.max(newestStaleSeenAt ?? 0, fares.seenAt);
        continue;
      }
      kept[cabin].push({ date: entry.date, valueK: miles / 1000, seenAt: fares.seenAt });
    }
  }

  const section = (cabin: "business" | "economy"): TapCalendarSection => {
    const days = kept[cabin];
    if (days.length === 0) {
      return {
        min: null,
        max: null,
        days,
        text: "Nenhuma disponibilidade encontrada nesse período.",
        ...(staleByCabin[cabin] > 0 ? { emptyReason: STALE_REASON(maxAgeHours) } : {}),
      };
    }
    const values = days.map((day) => day.valueK);
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      days,
      text: formatDatesByMonth(days.map((day) => day.date)),
    };
  };

  const seen = [...kept.business, ...kept.economy].map((day) => day.seenAt);
  return {
    kind: "ok",
    business: section("business"),
    economy: section("economy"),
    coveredUntil: dates.at(-1)!.date,
    staleDates: staleDates.size,
    newestStaleSeenAt,
    mixedCabinDates,
    seenBetween: seen.length > 0 ? { oldest: Math.min(...seen), newest: Math.max(...seen) } : null,
  };
}
