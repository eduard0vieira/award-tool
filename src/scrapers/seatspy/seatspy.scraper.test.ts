import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { findAirport, routeMapFrom, routeNotFoundMessage } from "./seatspy.scraper.ts";

const options = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "seatspy-route-options.json"), "utf8"));

describe("SeatSpy route check", () => {
  test("finds a destination the airline flies from the origin", () => {
    assert.equal(findAirport(options.IB_GRU_destinations, "MAD")?.key, "317");
  });

  test("finds an airport by its city code too", () => {
    assert.equal(findAirport([options.AF_GRU_origin], "SAO")?.iata, "GRU");
  });

  test("reports a route the airline does not fly, naming where it does go", () => {
    assert.equal(findAirport(options.AF_GRU_destinations, "MAD"), null);
    assert.equal(
      routeNotFoundMessage("Air France", "GRU", "MAD", options.AF_GRU_destinations),
      "A Air France não voa GRU → MAD no SeatSpy. De GRU, ela voa para: CDG (Charles De Gaulle). " +
        "A busca não foi feita e nenhum crédito foi gasto.",
    );
  });
});

describe("SeatSpy route map", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "seatspy-route-map-AF.json"), "utf8"));

  test("reads every origin the airline offers, each with its destinations", () => {
    const map = routeMapFrom(raw);
    assert.equal(Object.keys(map).length, 163);
    assert.deepEqual(map.GRU?.destinations, [{ iata: "CDG", iatas: "PAR", title: "Charles De Gaulle" }]);
    assert.equal(map.GRU?.iatas, "SAO");
  });

  test("names the field when an origin comes without its destinations", () => {
    const [key, option] = raw[0];
    const { destinations: _destinations, ...withoutDestinations } = option;
    assert.throws(() => routeMapFrom([[key, withoutDestinations]]), /sem o campo "destinations"/);
  });
});
