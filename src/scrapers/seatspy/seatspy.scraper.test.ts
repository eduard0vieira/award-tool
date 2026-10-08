import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { findAirport, routeNotFoundMessage } from "./seatspy.scraper.ts";

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
