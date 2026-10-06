import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import {
  buildSmilesReport,
  error452,
  readSmilesResponse,
  SmilesOutOfSaleWindowError,
  SmilesTransientError,
  SmilesUpstreamError,
} from "./smiles.scraper.ts";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");

describe("Smiles response parser", () => {
  test("reads flights and the 7-day calendar from a GOL route", () => {
    const response = readSmilesResponse(fixture("smiles-real.json"), "2026-10-13")!;
    assert.equal(response.flights.length, 8);
    assert.deepEqual(response.flights[0], {
      cabin: "economy",
      stops: 1,
      seats: 9,
      miles: 138000,
      fare: "SMILES_CLUB",
      milesWithoutClub: 146000,
      feeReais: 326.41,
      airline: "GOL (G3)",
      dataSource: "G3",
      detail: {
        departureDate: "2026-10-13",
        departureTime: "06:00",
        departureAirport: "GRU",
        arrivalDate: "2026-10-13",
        arrivalTime: "16:50",
        arrivalAirport: "MIA",
        connectingAirports: "BSB",
        durationMinutes: 710,
        flightNumbers: "1454, 7748",
        aircraft: "738, 7M8",
        serviceClasses: "U, U",
        airlineCode: "G3",
        rawCabin: "ECONOMIC",
      },
    });
    assert.deepEqual(response.calendar.slice(0, 3), [
      { date: "2026-10-10", miles: 164000 },
      { date: "2026-10-11", miles: 119000 },
      { date: "2026-10-12", miles: 119000 },
    ]);
  });

  test("keeps a partner flight's fee as null instead of zero", () => {
    const response = readSmilesResponse(fixture("smiles-real-congener.json"), "2026-10-29")!;
    assert.equal(response.flights.length, 40);
    assert.equal(response.calendar.length, 0);
    assert.equal(response.flights[0]!.feeReais, null);
    assert.equal(response.flights[0]!.dataSource, "AMADEUS");
  });

  test("tells an out-of-sale date apart from an unknown airport on 452", () => {
    const route = { origin: "gru", destination: "xqz" };
    assert.ok(error452(fixture("smiles-452-date.json"), route, "2027-09-01") instanceof SmilesOutOfSaleWindowError);
    assert.match(error452(fixture("smiles-452-airport.json"), route, "2027-09-01").message, /GRU → XQZ/);
    assert.ok(error452(fixture("smiles-452-upstream-503.json"), route, "2026-10-06") instanceof SmilesUpstreamError);
    assert.ok(error452(fixture("smiles-452-flightlist.json"), route, "2026-10-20") instanceof SmilesTransientError);
  });

  test("builds one section per cabin with seats in the copied text", () => {
    const response = readSmilesResponse(fixture("smiles-real.json"), "2026-10-13")!;
    assert.deepEqual(
      buildSmilesReport([response], {}).map((section) => [section.label, section.min, section.max, section.text]),
      [
        ["Econômica", 138, 138, "Out 2026: 13 (9)"],
        ["Conforto", 219.5, 219.5, "Out 2026: 13 (9)"],
        ["Executiva", 887, 887, "Out 2026: 13 (9)"],
      ],
    );
  });
});
