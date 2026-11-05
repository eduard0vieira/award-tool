import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { buildIberiaReport, filterFlights, iberiaBookingLink, readFlights } from "./iberia.scraper.ts";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const route = { origin: "GRU", destination: "MAD", passengers: 1 };

describe("Iberia availability parser", () => {
  test("prices each cabin of a direct IB flight with its cheapest offer and that offer's seats", () => {
    const flights = readFlights(fixture("iberia-availability-ib-direct.json"), "2026-10-28");
    assert.equal(flights.length, 12);
    assert.deepEqual(flights[1], {
      date: "2026-10-28",
      departureTime: "20:30",
      arrivalDate: "2026-10-29",
      arrivalTime: flights[1]!.arrivalTime,
      origin: "GRU",
      destination: "MAD",
      stops: 0,
      connectingAirports: [],
      durationMinutes: flights[1]!.durationMinutes,
      carriers: [{ code: "IB", name: "Iberia" }],
      aircraft: ["Airbus A330"],
      fares: [
        { cabin: "economy", avios: 20000, seats: 9 },
        { cabin: "premium", avios: 36750, seats: 2 },
      ],
      otherCabins: [],
    });
  });

  test("leaves a connection without a price instead of making one up", () => {
    const flights = readFlights(fixture("iberia-availability-ib-direct.json"), "2026-10-28");
    const latamToIberia = flights.find((flight) => flight.carriers.map((carrier) => carrier.code).join(">") === "LA>IB")!;
    assert.deepEqual(latamToIberia.fares, [{ cabin: "economy", avios: null, seats: 7 }]);
    assert.deepEqual(latamToIberia.connectingAirports, ["FOR"]);
  });

  test("keeps a cabin offered on only one leg out of the trip's cabins, and says so", () => {
    const [moroccan] = readFlights(fixture("iberia-real.json"), "2026-12-15");
    assert.deepEqual(moroccan!.fares, [{ cabin: "economy", avios: null, seats: 4 }]);
    assert.deepEqual(moroccan!.otherCabins, ["BUSINESS"]);
  });

  test("refuses a cabin it does not know instead of filing it as economy", () => {
    const text = fixture("iberia-availability-ib-direct.json").replace('"bookingClass":"PREMIUMTOURIST"', '"bookingClass":"SUPERCLUB"');
    assert.throws(() => readFlights(text, "2026-10-28"), /cabine 'SUPERCLUB'/);
  });

  test("filters flights by stops, airline and cabin", () => {
    const flights = readFlights(fixture("iberia-availability-ib-direct.json"), "2026-10-28");
    assert.equal(filterFlights(flights, { maxStops: 0 }).length, 2);
    assert.equal(filterFlights(flights, { airlines: ["IB"] }).length, 2);
    assert.equal(filterFlights(flights, { cabins: ["premium"] }).length, 1);
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
