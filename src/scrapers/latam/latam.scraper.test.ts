import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { buildLatamReport, pickBestPairs, readRedemptionOptions } from "./latam.scraper.ts";

const outbound = [
  { date: "2026-10-01", price: 2500, lowestFare: true },
  { date: "2026-10-02", price: 3100, lowestFare: false },
];
const inbound = [
  { date: "2026-10-08", price: 2600, lowestFare: true },
  { date: "2026-10-12", price: 2700, lowestFare: false },
];

describe("LATAM", () => {
  test("reads the miles-plus-money ladder of a round-trip pair", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "latam-redemption-options-real.json"), "utf8"));
    assert.deepEqual(readRedemptionOptions(raw), {
      feeReais: 255.69,
      options: [
        { id: 1, miles: 90302, cashReais: 0, totalReais: 255.69 },
        { id: 2, miles: 81272, cashReais: 469.56, totalReais: 725.25 },
        { id: 3, miles: 63212, cashReais: 1164.87, totalReais: 1420.56 },
        { id: 4, miles: 45151, cashReais: 1760.89, totalReais: 2016.58 },
      ],
    });
  });

  test("builds the report in reais, dropping days above the ceiling", () => {
    assert.deepEqual(buildLatamReport(outbound, { maxPriceReais: 3000 }), {
      min: 2500,
      max: 2500,
      days: [{ date: "2026-10-01", valueK: 2500 }],
      text: "Out 2026: 01",
      unit: "BRL",
    });
  });

  test("picks the cheapest round-trip pair within the price band", () => {
    assert.deepEqual(pickBestPairs(outbound, inbound, 3, 100, 300), [{ outbound: outbound[0], inbound: inbound[0] }]);
  });

  test("fills the missing pairs with the cheapest returns outside the band", () => {
    const outboundDays = [
      { date: "2026-10-03", price: 2000, lowestFare: true },
      { date: "2026-11-11", price: 2000, lowestFare: true },
    ];
    const inboundDays = [
      { date: "2026-10-06", price: 2900, lowestFare: true },
      { date: "2026-10-08", price: 2800, lowestFare: true },
      { date: "2026-11-23", price: 2400, lowestFare: true },
      { date: "2027-03-17", price: 2650, lowestFare: true },
    ];

    assert.deepEqual(pickBestPairs(outboundDays, inboundDays, 3, 100, 300), [
      { outbound: outboundDays[0], inbound: inboundDays[1] },
      { outbound: outboundDays[1], inbound: inboundDays[2] },
    ]);
  });
});
