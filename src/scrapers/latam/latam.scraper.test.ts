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
        { id: 1, milhas: 90302, dinheiroReais: 0, totalReais: 255.69 },
        { id: 2, milhas: 81272, dinheiroReais: 469.56, totalReais: 725.25 },
        { id: 3, milhas: 63212, dinheiroReais: 1164.87, totalReais: 1420.56 },
        { id: 4, milhas: 45151, dinheiroReais: 1760.89, totalReais: 2016.58 },
      ],
    });
  });

  test("builds the report in reais, dropping days above the ceiling", () => {
    assert.deepEqual(buildLatamReport(outbound, { maxPriceReais: 3000 }), {
      menor: 2500,
      maior: 2500,
      dias: [{ data: "2026-10-01", valorK: 2500 }],
      texto: "Out 2026: 01",
      unidade: "BRL",
    });
  });

  test("picks the cheapest round-trip pair within the price band", () => {
    assert.deepEqual(pickBestPairs(outbound, inbound, 3, 100, 300), [{ outbound: outbound[0], inbound: inbound[0] }]);
  });
});
