import { inflateSync } from "node:zlib";
import type { Page, Response } from "playwright";
import type { OnLog } from "../../core/common.ts";
import type { TapCalendarDate } from "./tap-calendar.ts";
import { awardtoolRateLimiter } from "./tap.scraper.ts";

// AwardTool's Panorama: the same stored data as the route calendar, searched by
// region and 90 days at a time, one response per 2 days. Neither page is
// complete on its own (see docs/recon/awardtool-panorama.md): the calendar had
// no TAP row for FOR-LIS while Panorama had 19 dates, and Panorama had none for
// SSA-LIS while the calendar had 88.

const TAP_PROGRAM = "TP";
export const PANORAMA_WINDOW_DAYS = 90;
const DAYS_PER_RESPONSE = 2;
const WINDOW_TIMEOUT_MS = 45000;

// Unlike the calendar, a cabin without a fare has no key at all; c_s (segments
// of the cheapest itinerary) says which cabins have one, so the two must agree.
type PanoramaPoints = Record<string, unknown> & { c_s?: Record<string, unknown>; c_p?: Record<string, unknown> };

function fail(where: string, detail: string): never {
  throw new Error(`O Panorama do AwardTool (${where}) veio num formato inesperado: ${detail}.`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cabinMiles(points: PanoramaPoints, cabin: "y" | "j", where: string): number | null {
  const segments = asRecord(points.c_s) ?? fail(where, "falta points.c_s");
  const hasFare = cabin in points;
  if (hasFare !== (segments[cabin] != null)) fail(where, `points.${cabin} e points.c_s.${cabin} não batem`);
  if (!hasFare) return null;
  if (typeof points[cabin] !== "number") fail(where, `points.${cabin} não é número`);
  return points[cabin] as number;
}

export type PanoramaDate = TapCalendarDate & { route: string; id: string };

export function decodePanoramaResponse(raw: string, where: string): PanoramaDate[] {
  const wrapper = asRecord(JSON.parse(raw));
  if (typeof wrapper?.ciphered_data !== "string") fail(where, "falta o campo ciphered_data");
  const body = asRecord(JSON.parse(inflateSync(Buffer.from(wrapper.ciphered_data, "base64")).toString()));
  if (body?.status !== 200) fail(where, `status ${String(body?.status)}`);
  if (!Array.isArray(body.data)) fail(where, "falta a lista data");

  return body.data
    .map(asRecord)
    .filter((row) => row?.program === TAP_PROGRAM)
    .map((row) => {
      const { date, route, id } = row!;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(where, "linha sem date");
      if (typeof route !== "string" || !/^[A-Z]{3}-[A-Z]{3}$/.test(route)) fail(where, `${date} sem route`);
      if (typeof id !== "string") fail(where, `${route} ${date} sem id`);
      const at = `${route} ${date}`;
      const points = (asRecord(row!.points) ?? fail(where, `${at} sem points`)) as PanoramaPoints;
      const nonstop = asRecord(row!.points_ns) ?? fail(where, `${at} sem points_ns`);
      if (typeof points.ls !== "number") fail(where, `${at} sem points.ls`);
      if (typeof nonstop.ls !== "number") fail(where, `${at} sem points_ns.ls`);
      const business = cabinMiles(points, "j", at);
      const share = asRecord(points.c_p);
      if (business !== null && typeof share?.j !== "number") fail(where, `${at} sem points.c_p.j`);
      const nonstopMiles = (cabin: "y" | "j") => {
        const value = nonstop[cabin];
        if (value === undefined || value === null) return null;
        if (typeof value !== "number") fail(where, `${at} points_ns.${cabin} não é número`);
        return value;
      };
      return {
        id,
        route,
        date,
        any: {
          seenAt: points.ls,
          economy: cabinMiles(points, "y", at),
          business,
          businessShare: business === null ? null : (share!.j as number),
        },
        nonstop: { seenAt: nonstop.ls, economy: nonstopMiles("y"), business: nonstopMiles("j") },
      };
    });
}

export type PanoramaWindow = { start: string; end: string };

// Consecutive windows from `start` covering `days` days.
export function panoramaWindows(start: string, days: number): PanoramaWindow[] {
  const windows: PanoramaWindow[] = [];
  const day = (offset: number) => new Date(Date.parse(`${start}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  for (let offset = 0; offset < days; offset += PANORAMA_WINDOW_DAYS) {
    windows.push({ start: day(offset), end: day(Math.min(offset + PANORAMA_WINDOW_DAYS, days) - 1) });
  }
  return windows;
}

function daysIn(window: PanoramaWindow) {
  return Math.round((Date.parse(window.end) - Date.parse(window.start)) / 86400000) + 1;
}

// The page reads startDate/endDate as local midnight.
const localMidnight = (date: string) => Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000);

export type PanoramaSweep = {
  dates: PanoramaDate[];
  // Windows where some of the 2-day responses never came: their gaps are not "no award".
  incompleteWindows: PanoramaWindow[];
};

// `from` and `to` are the page's own location codes: GRU_4 (airport), BR_2
// (country), EUMAJOR_1 (region).
export async function sweepPanorama(
  page: Page,
  baseUrl: string,
  query: { from: string; to: string },
  windows: PanoramaWindow[],
  onLog: OnLog = () => {},
  onWindow: (done: number, total: number) => void = () => {},
): Promise<PanoramaSweep> {
  const newest = new Map<string, PanoramaDate>();
  const incompleteWindows: PanoramaWindow[] = [];

  for (const [index, window] of windows.entries()) {
    await awardtoolRateLimiter.waitTurn();
    const expected = Math.ceil(daysIn(window) / DAYS_PER_RESPONSE);
    const where = `${query.from} → ${query.to}, ${window.start} a ${window.end}`;
    const seen = new Set<string>();
    const state = { failure: null as Error | null };
    let resolveAll: () => void = () => {};
    const allArrived = new Promise<void>((resolve) => (resolveAll = resolve));

    const onResponse = async (response: Response) => {
      const name = new URL(response.url()).pathname.split("/").pop() ?? "";
      if (!name.startsWith("routes_data_v2-")) return;
      try {
        if (!response.ok()) throw new Error(`O Panorama do AwardTool (${where}) respondeu HTTP ${response.status()}.`);
        for (const date of decodePanoramaResponse(await response.text(), where)) {
          const known = newest.get(date.id);
          if (!known || known.any.seenAt < date.any.seenAt) newest.set(date.id, date);
        }
        seen.add(name);
      } catch (err) {
        state.failure = err instanceof Error ? err : new Error(String(err));
      }
      if (seen.size >= expected || state.failure) resolveAll();
    };
    page.on("response", onResponse);
    try {
      const params = new URLSearchParams({
        from: query.from,
        to: query.to,
        startDate: String(localMidnight(window.start)),
        endDate: String(localMidnight(window.end)),
        programs: "TP",
        pax: "1",
        children: "0",
      });
      await page.goto(`${baseUrl}/routes?${params}`);
      await Promise.race([allArrived, page.waitForTimeout(WINDOW_TIMEOUT_MS)]);
    } finally {
      page.off("response", onResponse);
    }
    if (state.failure) throw state.failure;
    if (seen.size < expected) {
      onLog(`  (Panorama ${where}: chegaram ${seen.size} de ${expected} respostas)`);
      incompleteWindows.push(window);
    }
    onWindow(index + 1, windows.length);
  }

  return { dates: [...newest.values()].sort((a, b) => a.date.localeCompare(b.date)), incompleteWindows };
}
