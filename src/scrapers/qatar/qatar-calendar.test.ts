import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { buildQatarReport, qatarCalendarLink, readCalendar } from "./qatar-calendar.ts";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const december = fixture("qatar-calendar-GRU-NRT-2026-12.json");
const august = fixture("qatar-calendar-GRU-NRT-2027-08.json");
const route = { origin: "GRU", destination: "NRT" };

describe("Qatar award calendar", () => {
  test("keeps only the priced days, with their Avios and fare band", () => {
    const days = readCalendar(december, "ECONOMY");

    assert.equal(days.length, 10);
    assert.deepEqual(days[0], { date: "2026-12-01", avios: 50000, band: "offpeak" });
    assert.deepEqual(days[1], { date: "2026-12-02", avios: 100000, band: "flexi" });
    assert.deepEqual(days.at(-1), { date: "2026-12-12", avios: 100000, band: "flexi" });
  });

  test("a priced day with no flag stays priced, with no band", () => {
    const days = readCalendar(august, "ECONOMY");

    assert.deepEqual(days[0], { date: "2027-08-01", avios: 60000, band: null });
    assert.equal(days.length, 31);
  });

  test("an error body is an error, never an empty calendar", () => {
    assert.throws(() => readCalendar(fixture("qatar-calendar-400-business.json"), "ECONOMY"), /faresFromCalendar/);
  });

  test("a price in anything but Avios is refused", () => {
    const inCash = december.replace('"lowestPrice":50000,"currencyCode":"AVIOS"', '"lowestPrice":50000,"currencyCode":"BRL"');
    assert.throws(() => readCalendar(inCash, "ECONOMY"), /BRL.*2026-12-01/);
  });

  test("a day missing a fare flag is refused instead of read as unflagged", () => {
    const withoutFlag = december.replace('{"date":"2026-12-01","lowestPrice":50000,"currencyCode":"AVIOS","flexiIndicator":false,', '{"date":"2026-12-01","lowestPrice":50000,"currencyCode":"AVIOS",');
    assert.throws(() => readCalendar(withoutFlag, "ECONOMY"), /flexiIndicator.*2026-12-01/);
  });

  test("the report keeps the days under the ceiling, in K, linked to the day's calendar", () => {
    const report = buildQatarReport([...readCalendar(december, "ECONOMY"), ...readCalendar(august, "ECONOMY")], 70000, route);

    assert.equal(report.min, 50);
    assert.equal(report.max, 60);
    assert.equal(report.text, "Dez 2026: 01\nAgo 2027: 01, 02, 03, 04, 07, 08, 09, 11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25, 26, 27, 29, 30, 31");
    assert.equal(report.days[0]!.link, qatarCalendarLink(route, "2026-12-01"));
    assert.match(report.days[0]!.link!, /fromStation=GRU&toStation=NRT&departing=2026-12-01/);
  });

  test("with nothing under the ceiling the report says so", () => {
    assert.deepEqual(buildQatarReport(readCalendar(december, "ECONOMY"), 40000).days, []);
  });
});
