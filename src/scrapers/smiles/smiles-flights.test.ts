import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { filterSmilesFlights, storedSmilesDays } from "./smiles-flights.ts";
import { buildSmilesReport, readSmilesResponse } from "./smiles.scraper.ts";

const congener = readSmilesResponse(fs.readFileSync(path.join(FIXTURES_DIR, "smiles-real-congener.json"), "utf8"), "2026-10-29")!;
const days = storedSmilesDays([congener]);

describe("Smiles flight filter", () => {
  test("without a filter, matches the search's own report", () => {
    const { sections } = filterSmilesFlights(days, {});
    const report = buildSmilesReport([congener]);
    assert.deepEqual(
      sections.map((section) => [section.label, section.text, section.min, section.max]),
      report.map((section) => [section.label, section.text, section.min, section.max]),
    );
  });

  test("keeps only flights whose every leg is flown by the chosen airlines", () => {
    const onlyAf = filterSmilesFlights(days, { carriers: ["AF"] });
    const kept = days[0]!.flights.filter((flight) => flight.carriers?.every((carrier) => carrier.code === "AF"));
    const cheapestAf = Math.min(...kept.filter((flight) => flight.cabin === "economy").map((flight) => flight.miles));
    const economy = onlyAf.sections.find((section) => section.label === "Econômica")!;
    assert.equal(economy.min, Math.round(cheapestAf / 10) / 100);
    assert.deepEqual(economy.carriers, ["AF"]);
  });

  test("names every operator of the quoted flights when several airlines pass", () => {
    const { sections } = filterSmilesFlights(days, { carriers: ["AF", "KL"] });
    for (const section of sections) {
      assert.ok(section.carriers.every((code) => code === "AF" || code === "KL"));
    }
  });

  test("drops a cabin's flights outside its miles range and above the stop limit", () => {
    const economy = days[0]!.flights.filter((flight) => flight.cabin === "economy");
    const floor = Math.min(...economy.map((flight) => flight.miles)) + 1;
    const filtered = filterSmilesFlights(days, { maxStops: 1, miles: { economy: { min: floor } } });
    const section = filtered.sections.find((section) => section.label === "Econômica")!;
    const allowed = economy.filter((flight) => flight.stops <= 1 && flight.miles >= floor);
    assert.equal(section.days.length > 0, allowed.length > 0);
    if (allowed.length) assert.equal(section.min, Math.round(Math.min(...allowed.map((flight) => flight.miles)) / 10) / 100);
  });

  test("lists each operator with how many flights it flies", () => {
    const { carrierOptions, flightsWithoutCarrier } = filterSmilesFlights(days, {});
    assert.equal(flightsWithoutCarrier, 0);
    const af = carrierOptions.find((option) => option.code === "AF")!;
    assert.equal(af.name, "AIR FRANCE");
    assert.equal(af.flights, days[0]!.flights.filter((flight) => flight.carriers?.some((carrier) => carrier.code === "AF")).length);
  });

  test("lists every miles value per cabin, ignoring the miles range but not the airlines", () => {
    const economy = days[0]!.flights.filter((flight) => flight.cabin === "economy");
    const { milesOptions } = filterSmilesFlights(days, { miles: { economy: { max: 1 } } });
    assert.deepEqual(
      milesOptions.economy.map((option) => option.miles),
      [...new Set(economy.map((flight) => flight.miles))].sort((a, b) => a - b),
    );
    assert.equal(
      milesOptions.economy.reduce((total, option) => total + option.flights, 0),
      economy.length,
    );
    const onlyAf = filterSmilesFlights(days, { carriers: ["AF"] }).milesOptions.economy;
    const afFlights = economy.filter((flight) => flight.carriers?.every((carrier) => carrier.code === "AF"));
    assert.equal(onlyAf.reduce((total, option) => total + option.flights, 0), afFlights.length);
  });

  test("tells each airline's cheapest flight per cabin, flown entirely by it and within the stops", () => {
    const { carrierOptions } = filterSmilesFlights(days, { maxStops: 1 });
    const af = carrierOptions.find((option) => option.code === "AF")!;
    const onlyAfEconomy = days[0]!.flights.filter(
      (flight) => flight.cabin === "economy" && flight.stops <= 1 && flight.carriers?.every((carrier) => carrier.code === "AF"),
    );
    assert.equal(af.from.economy, Math.min(...onlyAfEconomy.map((flight) => flight.miles)));
  });
});
