import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../../core/paths.ts";
import { iberiaBookingLink, readFlights } from "../../../scrapers/iberia/iberia.scraper.ts";
import { iberiaFlightRows, iberiaFlightSections, pickDatesToDetail, storedIberiaDays } from "./iberia.source.ts";

const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const aviosByDate = new Map([
  ["2026-10-01", 30_000],
  ["2026-10-02", 12_000],
  ["2026-10-03", 45_000],
  ["2026-10-04", 18_000],
]);
const route = { origin: "GRU", destination: "MAD", passengers: 1 };
const flights = readFlights(fs.readFileSync(path.join(FIXTURES_DIR, "iberia-availability-ib-direct.json"), "utf8"), "2026-10-28");

describe("pickDatesToDetail", () => {
  test("picks the N cheapest dates, cheapest first", () => {
    assert.deepEqual(pickDatesToDetail(dates, aviosByDate, 2), ["2026-10-02", "2026-10-04"]);
  });

  test("details nothing when asked for zero", () => {
    assert.deepEqual(pickDatesToDetail(dates, aviosByDate, 0), []);
  });
});

describe("Iberia flight report", () => {
  test("keeps only the priced cabins for the flight filter", () => {
    const [day] = storedIberiaDays(["2026-10-28"], flights);
    assert.deepEqual(day!.flights, [
      { cabin: "economy", miles: 20000, seats: 9, stops: 0, carriers: [{ code: "IB", name: "Iberia" }] },
      { cabin: "economy", miles: 20000, seats: 9, stops: 0, carriers: [{ code: "IB", name: "Iberia" }] },
      { cabin: "premium", miles: 36750, seats: 2, stops: 0, carriers: [{ code: "IB", name: "Iberia" }] },
    ]);
  });

  test("a detailed day with only connections stays in the list, empty", () => {
    const connections = flights.filter((flight) => flight.stops > 0);
    assert.deepEqual(storedIberiaDays(["2026-10-28"], connections), [{ date: "2026-10-28", flights: [] }]);
  });

  test("quotes each cabin under Iberia's names, with the flight's own Avios and a link to the day", () => {
    const sections = iberiaFlightSections(storedIberiaDays(["2026-10-28"], flights), route);
    assert.deepEqual(
      sections.map((section) => [section.label, section.min, section.days.length]),
      [
        ["Econômica", 20, 1],
        ["Premium Economy", 36.75, 1],
        ["Executiva", null, 0],
      ],
    );
    assert.equal(sections[0]!.days[0]!.link, iberiaBookingLink(route, "2026-10-28"));
    assert.equal(sections[1]!.text, "Out 2026: 28 (2)");
  });

  test("writes one spreadsheet row per cabin, with no Avios on a connection", () => {
    const rows = iberiaFlightRows(flights, route, new Map([["2026-10-28", 20000]]));
    const latamToIberia = rows.find((row) => row.operation_carriers === "LA, IB")!;
    assert.equal(latamToIberia.points, "");
    assert.equal(latamToIberia.connecting_airports, "FOR");
    assert.equal(rows.filter((row) => row.points === 36750).length, 1);
  });
});
