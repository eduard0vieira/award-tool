import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { readCalendarResponse, searchUrl } from "./google-flights.scraper.ts";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");

describe("Google Flights calendar", () => {
  test("reads each outbound date with its return and round-trip price", () => {
    const prices = readCalendarResponse(fixture("google-flights-calendar-GRU-JFK.txt"));
    assert.equal(prices.length, 59);
    assert.deepEqual(prices[0], { outbound: "2027-01-01", return: "2027-01-08", priceReais: 25052 });
    assert.ok(prices.every((price) => Date.parse(price.return) - Date.parse(price.outbound) === 7 * 86_400_000));
  });

  test("says when Google refused the request instead of returning no prices", () => {
    assert.throws(() => readCalendarResponse(fixture("google-flights-calendar-refused.txt")), /recusou o pedido/);
    assert.throws(() => readCalendarResponse("<html>"), /formato inesperado/);
  });

  test("builds the results url the page writes after filtering by airline", () => {
    // Copied from the address bar after filtering GRU-LIS business to LATAM on 2026-10-23.
    const real =
      "CBwQAhoiEgoyMDI3LTAxLTEwMgJMQWoHCAESA0dSVXIHCAESA0xJUxoiEgoyMDI3LTAxLTE3MgJMQWoHCAESA0xJU3IHCAESA0dSVUABSANwAYIBCwj___________8BmAEB";
    const url = new URL(searchUrl({ origin: "GRU", destination: "LIS", airline: "LA", cabin: "Business", stayDays: 7 }, "2027-01-10"));
    assert.equal(url.searchParams.get("tfs"), real);
  });
});
