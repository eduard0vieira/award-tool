import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { requestKey, searchDay } from "./request-key.ts";

describe("search request key", () => {
  const route = { origin: "GRU", destination: "CUN", economy: 80000, period: { from: "2026-11-01" } };

  test("is the same for the same search, whatever the field order", () => {
    const reordered = { period: { from: "2026-11-01" }, economy: 80000, destination: "CUN", origin: "GRU" };
    assert.equal(requestKey("smiles", route, "2026-10-07"), requestKey("smiles", reordered, "2026-10-07"));
    assert.equal(
      requestKey("smiles", { ...route, extra: undefined }, "2026-10-07"),
      requestKey("smiles", route, "2026-10-07"),
    );
  });

  test("changes with the source, the day, a ceiling or the period", () => {
    const base = requestKey("smiles", route, "2026-10-07");
    assert.notEqual(requestKey("aa", route, "2026-10-07"), base);
    assert.notEqual(requestKey("smiles", route, "2026-10-08"), base);
    assert.notEqual(requestKey("smiles", { ...route, economy: 90000 }, "2026-10-07"), base);
    assert.notEqual(requestKey("smiles", { ...route, period: { from: "2026-12-01" } }, "2026-10-07"), base);
  });

  test("counts the day in São Paulo, not in UTC", () => {
    assert.equal(searchDay(new Date("2026-10-08T02:30:00Z")), "2026-10-07");
    assert.equal(searchDay(new Date("2026-10-08T03:30:00Z")), "2026-10-08");
  });
});
