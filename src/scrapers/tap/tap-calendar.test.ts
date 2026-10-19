import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { deflateSync } from "node:zlib";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { buildTapCalendarReport, decodeCalendarResponse, type TapCalendarDate } from "./tap-calendar.ts";
import { tapBookingLink } from "./tap.scraper.ts";

const raw = fs.readFileSync(path.join(FIXTURES_DIR, "awardtool-route-calendar-GRU-LIS.json"), "utf8");
const dates = decodeCalendarResponse(raw, "GRU-LIS");
// The newest "last seen" in the fixture, so the test does not age with the calendar.
const capturedAt = Math.max(...dates.map((entry) => entry.any.seenAt));
const options = { nonstopOnly: false, maxAgeHours: 48, ceilingsK: { business: 181, economy: 60 }, floorsK: { business: null, economy: null }, now: capturedAt, route: { origin: "GRU", destination: "LIS" } };

const wrap = (body: unknown) => JSON.stringify({ ciphered_data: deflateSync(JSON.stringify(body)).toString("base64") });
const fares = (seenAt: number, economy: number | null, business: number | null) => ({ seenAt, economy, business });

describe("AwardTool route calendar", () => {
  test("keeps only TAP's rows, one per date, in order", () => {
    assert.equal(dates.length, 355);
    assert.deepEqual(dates[0], {
      date: "2026-10-19",
      any: { seenAt: 1792324950, economy: 44900, business: 275000, businessShare: 100 },
      nonstop: { seenAt: 1792324950, economy: 44900, business: 275000 },
    });
    assert.ok(dates.every((entry, index) => index === 0 || dates[index - 1]!.date < entry.date));
  });

  test("names the missing field instead of guessing it", () => {
    const row = { date: "2027-01-01", route: "GRU-LIS", program: "TP", points: { ls: 1, y: 44900 }, points_ns: { ls: 1, y: 44900, j: null } };
    assert.throws(() => decodeCalendarResponse(wrap({ status: 200, data: [row] }), "GRU-LIS"), /points\.j/);
    assert.throws(() => decodeCalendarResponse(wrap({ status: 500, data: [] }), "GRU-LIS"), /status 500/);
    assert.throws(() => decodeCalendarResponse(raw, "LIS-GRU"), /outro trecho/);
  });

  test("applies the ceilings and the maximum age, with the date's last-seen time", () => {
    const report = buildTapCalendarReport(dates, options);
    assert.equal(report.kind, "ok");
    if (report.kind !== "ok") return;
    assert.equal(report.business.days.length, 110);
    assert.equal(report.economy.days.length, 181);
    assert.deepEqual(report.business.days[0], {
      date: "2026-10-20",
      valueK: 135,
      seenAt: 1792324949,
      link: tapBookingLink({ origin: "GRU", destination: "LIS" }, "2026-10-20"),
    });
    assert.match(report.business.days[0]!.link!, /origin=GRU&destination=LIS&.*depDate=20.10.2026&award=true/);
    assert.ok(report.business.days.every((day) => day.valueK <= 181 && day.seenAt >= capturedAt - 48 * 3600));
    assert.ok(report.economy.days.every((day) => day.valueK <= 60));
    assert.equal(report.staleDates, 10);
    assert.equal(report.coveredUntil, "2027-10-15");
  });

  test("a floor drops the cheaper dates", () => {
    const report = buildTapCalendarReport(dates, { ...options, floorsK: { business: null, economy: 55 } });
    if (report.kind !== "ok") return assert.fail("expected a report");
    assert.ok(report.economy.days.length > 0);
    assert.ok(report.economy.days.every((day) => day.valueK >= 55 && day.valueK <= 60));
    assert.equal(report.business.days.length, 110);
  });

  test("nonstop only reads the nonstop fares", () => {
    const anyStops = buildTapCalendarReport(dates, options);
    const nonstop = buildTapCalendarReport(dates, { ...options, nonstopOnly: true });
    if (anyStops.kind !== "ok" || nonstop.kind !== "ok") return assert.fail("expected a report");
    // 2026-11-04: business 135k with a connection, 345k nonstop.
    assert.ok(anyStops.business.days.some((day) => day.date === "2026-11-04"));
    assert.ok(!nonstop.business.days.some((day) => day.date === "2026-11-04"));
  });

  test("a cabin with only stale dates says so instead of no availability", () => {
    const report = buildTapCalendarReport(dates, { ...options, maxAgeHours: 1, now: capturedAt + 10 * 86400 });
    if (report.kind !== "ok") return assert.fail("expected a report");
    assert.equal(report.business.days.length, 0);
    assert.match(report.business.emptyReason ?? "", /mais de 1 h/);
    assert.equal(report.seenBetween, null);
  });

  test("a business fare flown partly in economy is not business", () => {
    const mixed: TapCalendarDate = {
      date: "2027-01-01",
      any: { ...fares(capturedAt, 44900, 150000), businessShare: 60 },
      nonstop: fares(capturedAt, 44900, null),
    };
    const report = buildTapCalendarReport([mixed], options);
    if (report.kind !== "ok") return assert.fail("expected a report");
    assert.equal(report.business.days.length, 0);
    assert.equal(report.business.emptyReason, undefined);
    assert.equal(report.mixedCabinDates, 1);
  });

  test("a route without TAP rows is not tracked, not empty", () => {
    assert.deepEqual(buildTapCalendarReport(decodeCalendarResponse(wrap({ status: 200, data: [] }), "CGB-PMW"), options), {
      kind: "not_tracked",
    });
  });
});
