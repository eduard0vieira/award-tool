import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { deflateSync } from "node:zlib";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { decodePanoramaResponse, panoramaWindows } from "./tap-panorama.ts";

const raw = fs.readFileSync(path.join(FIXTURES_DIR, "awardtool-panorama-BR_2-EUMAJOR_1.json"), "utf8");
const wrap = (data: unknown[]) => JSON.stringify({ ciphered_data: deflateSync(JSON.stringify({ status: 200, data })).toString("base64") });

const economyOnly = {
  date: "2027-01-06",
  route: "GRU-LIS",
  program: "TP",
  id: "program|TP|GRU|LIS|1:0|20270106",
  points: { ls: 1792325507, c_p: { y: 0, w: null, j: null, f: null }, c_s: { y: 1, w: null, j: null, f: null }, y: 225000 },
  points_ns: { ls: 1792325507, y: 225000 },
};

describe("AwardTool Panorama", () => {
  test("reads every route of a region search", () => {
    const dates = decodePanoramaResponse(raw, "BR_2 → EUMAJOR_1");
    assert.equal(dates.length, 46);
    assert.deepEqual(dates[0], {
      id: "program|TP|BSB|LIS|1:0|20261201",
      route: "BSB-LIS",
      date: "2026-12-01",
      any: { seenAt: 1791888329, economy: 44900, business: 135000, businessShare: 100 },
      nonstop: { seenAt: 1791888329, economy: 44900, business: 135000 },
    });
  });

  test("a cabin without a fare has no key, and that must match its segments", () => {
    const [date] = decodePanoramaResponse(wrap([economyOnly]), "test");
    assert.equal(date!.any.business, null);
    assert.equal(date!.nonstop.business, null);
    const businessWithoutFare = { ...economyOnly, points: { ...economyOnly.points, c_s: { y: 1, w: null, j: 1, f: null } } };
    assert.throws(() => decodePanoramaResponse(wrap([businessWithoutFare]), "test"), /points\.j e points\.c_s\.j não batem/);
  });

  test("splits a year into 90-day windows", () => {
    assert.deepEqual(panoramaWindows("2026-10-20", 360), [
      { start: "2026-10-20", end: "2027-01-17" },
      { start: "2027-01-18", end: "2027-04-17" },
      { start: "2027-04-18", end: "2027-07-16" },
      { start: "2027-07-17", end: "2027-10-14" },
    ]);
    assert.deepEqual(panoramaWindows("2026-12-01", 100).at(-1), { start: "2027-03-01", end: "2027-03-10" });
  });
});
