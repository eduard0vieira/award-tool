import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { narrowingBlocker, pickDatesToDetail } from "./iberia.source.ts";

const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const aviosByDate = new Map([
  ["2026-10-01", 30_000],
  ["2026-10-02", 12_000],
  ["2026-10-03", 45_000],
  ["2026-10-04", 18_000],
]);

describe("pickDatesToDetail", () => {
  test("picks the N cheapest dates, cheapest first", () => {
    assert.deepEqual(pickDatesToDetail(dates, aviosByDate, 2), ["2026-10-02", "2026-10-04"]);
  });

  test("details every date, cheapest first, when asked for all (-1)", () => {
    assert.deepEqual(pickDatesToDetail(dates, aviosByDate, -1), ["2026-10-02", "2026-10-04", "2026-10-01", "2026-10-03"]);
  });

  test("details nothing when asked for zero", () => {
    assert.deepEqual(pickDatesToDetail(dates, aviosByDate, 0), []);
  });
});

describe("narrowingBlocker", () => {
  test("allows narrowing only when every date was detailed", () => {
    assert.equal(narrowingBlocker({ failedDates: 0, stopped: false }), null);
  });

  test("blocks narrowing when a date failed to be detailed", () => {
    assert.match(narrowingBlocker({ failedDates: 2, stopped: false })!, /2 data\(s\) não puderam ser detalhadas/);
  });

  test("blocks narrowing when the detail was stopped before the last date", () => {
    assert.match(narrowingBlocker({ failedDates: 0, stopped: true })!, /interrompido/);
  });
});
