import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { buildIberiaReport, filterFlights, iberiaBookingLink, readFlights } from "./iberia.scraper.ts";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const route = { origin: "GRU", destination: "MAD", passengers: 1 };

describe("Iberia availability parser", () => {
  test("reads each offer of the day as a flight", () => {
    const flights = readFlights(fixture("iberia-real.json"), "2026-12-15");
    assert.equal(flights.length, 5);
    assert.deepEqual(flights[0], {
      date: "2026-12-15",
      departureTime: "00:25",
      arrivalDate: "2026-12-15",
      arrivalTime: "18:05",
      origin: "GRU",
      destination: "MAD",
      stops: 1,
      connectingAirports: "CMN",
      durationMinutes: 820,
      cabins: "ECONOMY, BUSINESS",
      airlines: "AT",
      serviceClasses: "E, Z",
      aircraft: "Boeing 787-9, Boeing 737",
      seats: 2,
      fare: "EATFF, ZATFF",
    });
  });

  test("filters flights by stops and by cabin", () => {
    const flights = readFlights(fixture("iberia-real-plus1.json"), "2026-12-16");
    assert.equal(flights.length, 9);
    assert.equal(filterFlights(flights, { maxStops: 0 }).length, 0);
    assert.equal(filterFlights(flights, { maxStops: 1 }).length, 1);
    assert.equal(filterFlights(flights, { cabins: ["BUSINESS"] }).length, 9);
  });

  test("builds the date report in K with a booking link per day", () => {
    const report = buildIberiaReport(
      [
        { date: "2026-12-15", avios: 34000 },
        { date: "2027-01-14", avios: 51000 },
      ],
      null,
      route,
    );
    assert.equal(report.min, 34);
    assert.equal(report.max, 51);
    assert.equal(report.text, "Dez 2026: 15\nJan 2027: 14");
    assert.equal(report.days[0]!.link, iberiaBookingLink(route, "2026-12-15"));
    assert.match(iberiaBookingLink(route, "2026-12-15"), /BEGIN_CITY_01=GRU&END_CITY_01=MAD&BEGIN_DAY_01=15&BEGIN_MONTH_01=202612/);
  });
});
