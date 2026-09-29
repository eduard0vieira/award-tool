import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatDatesByMonth, parseValueK } from "./common.ts";

describe("shared formats", () => {
  // Contract with vcc-alertas-portal and the alert generator.
  test("groups dates by month in the Portuguese format the group receives", () => {
    const text = formatDatesByMonth(["2026-08-07", "2026-08-25", "2026-09-01"], (date) =>
      date.endsWith("07") ? " (9)" : "",
    );
    assert.equal(text, "Ago 2026: 07 (9), 25\nSet 2026: 01");
  });

  test("parses values in K, with a decimal comma, and absence as null", () => {
    assert.deepEqual(["181K", "53,5K", "-", ""].map(parseValueK), [181, 53.5, null, null]);
  });
});
