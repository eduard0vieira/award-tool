import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PairConfirmation } from "../../../scrapers/latam/latam.scraper.ts";
import { validateBody } from "../../validation.ts";
import { LatamPairsSearchDto } from "./latam-pairs-search.dto.ts";
import { bandSection, cheapestBand, cheapestPairs } from "./google-latam.source.ts";
import { confirmedSection, drawPairs } from "./latam-pairs.source.ts";

const body = (outboundDates: unknown, returnDates: unknown) => ({ origin: "gru", destination: "jfk", cabin: "Business", outboundDates, returnDates });

describe("LATAM date pairs", () => {
  test("accepts lists of dates and refuses a wrong format or cabin", async () => {
    const request = await validateBody(LatamPairsSearchDto, body(["2026-12-10"], ["2026-12-20"]));
    assert.equal(request.origin, "GRU");
    await assert.rejects(validateBody(LatamPairsSearchDto, body(["10/12/2026"], ["2026-12-20"])), /AAAA-MM-DD/);
    await assert.rejects(validateBody(LatamPairsSearchDto, body([], ["2026-12-20"])), /pelo menos uma data de ida/);
    await assert.rejects(validateBody(LatamPairsSearchDto, { ...body(["2026-12-10"], ["2026-12-20"]), cabin: "First" }), /Economy ou Business/);
  });

  test("draws pairs like the calendar: spread out, 3 to 14 days of trip", () => {
    const pairs = drawPairs(
      ["2026-12-01", "2026-12-02", "2027-03-10", "2027-06-01"],
      ["2026-12-02", "2026-12-09", "2027-03-20", "2027-07-30"],
    );
    assert.deepEqual(pairs, [
      { outbound: "2026-12-01", return: "2026-12-09" },
      { outbound: "2027-03-10", return: "2027-03-20" },
    ]);
    assert.deepEqual(drawPairs(["2026-12-10"], ["2026-12-11"]), []);
  });

  test("each direction lists its confirmed dates at that leg's points, the lowest when a date repeats", () => {
    const pair = (outboundDate: string, returnDate: string, outboundMiles: number | null, returnMiles: number | null) =>
      ({ outboundDate, returnDate, outboundMiles, returnMiles }) as PairConfirmation;
    const pairs = [pair("2026-12-10", "2026-12-20", 120000, 130000), pair("2026-12-10", "2026-12-22", 110000, null)];
    const outbound = confirmedSection(pairs, "outbound", { origin: "GRU", destination: "JFK" });
    assert.deepEqual(
      outbound.days.map((day) => [day.date, day.valueK]),
      [["2026-12-10", 110]],
    );
    const back = confirmedSection(pairs, "return", { origin: "JFK", destination: "GRU" });
    assert.deepEqual(back.days.map((day) => day.date), ["2026-12-20"]);
    assert.equal(back.text, "Dez 2026: 20");
  });
});

describe("Google Flights pairs for LATAM", () => {
  const trip = (outbound: string, priceReais: number) => ({
    outbound,
    return: new Date(Date.parse(`${outbound}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10),
    priceReais,
  });
  const prices = [trip("2026-12-01", 20000), trip("2026-12-02", 20000), trip("2027-03-10", 21500), trip("2027-06-01", 30000)];

  test("keeps every date up to the band above the cheapest, in reais", () => {
    const band = cheapestBand(prices, 10);
    assert.deepEqual(band.map((price) => price.outbound), ["2026-12-01", "2026-12-02", "2027-03-10"]);
    const back = bandSection(band, "return", { origin: "JFK", destination: "GRU" });
    assert.equal(back.unit, "BRL");
    assert.equal(back.text, "Dez 2026: 08, 09\nMar 2027: 17");
    assert.equal(cheapestBand(prices, 60).length, 4);
  });

  test("draws the pairs to confirm from the band, spread over the period", () => {
    assert.deepEqual(cheapestPairs(cheapestBand(prices, 10), 7, 3), [
      { outbound: "2026-12-01", return: "2026-12-08", priceReais: 20000 },
      { outbound: "2026-12-02", return: "2026-12-09", priceReais: 20000 },
      { outbound: "2027-03-10", return: "2027-03-17", priceReais: 21500 },
    ]);
  });
});
