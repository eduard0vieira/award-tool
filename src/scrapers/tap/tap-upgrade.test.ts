import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTapUpgradeSection, tapUpgradeCost, tapUpgradeCostK } from "./tap-upgrade.ts";

const day = (date: string, valueK: number) => ({ date, valueK });

describe("TAP upgrade", () => {
  test("prices the crossing to mainland Portugal and adds the connection by region", () => {
    assert.equal(tapUpgradeCostK("FOR", "LIS"), 81.6);
    assert.equal(tapUpgradeCostK("OPO", "GRU"), 81.6);
    assert.equal(tapUpgradeCostK("GRU", "FAO"), 93.5);
    assert.equal(tapUpgradeCostK("GRU", "PDL"), 96);
    assert.equal(tapUpgradeCostK("GRU", "MAD"), 96.5);
    assert.equal(tapUpgradeCostK("LHR", "GIG"), 99.6);
    assert.equal(tapUpgradeCostK("GIG", "PRG"), 104.4);
    assert.match(tapUpgradeCost("GIG", "LHR")!.note, /81\.600 .* \+ 18\.000 na conexão até LHR, Europa 1$/);
  });

  test("has no price outside the table or away from Brazil", () => {
    assert.equal(tapUpgradeCostK("GRU", "ATH"), null);
    assert.equal(tapUpgradeCostK("LIS", "MAD"), null);
  });

  test("adds the upgrade to economy and keeps only the days it beats business", () => {
    const section = buildTapUpgradeSection(
      [day("2026-11-03", 135), day("2026-11-04", 135), day("2026-11-05", 175)],
      [day("2026-11-03", 44.9), day("2026-11-04", 59), day("2026-11-06", 44.9)],
      81.6,
    );
    assert.deepEqual(section.days, [{ date: "2026-11-03", valueK: 126.5, economyK: 44.9, businessK: 135 }]);
    assert.equal(section.text, "Nov 2026: 03");
  });

  test("says why there is nothing", () => {
    assert.match(buildTapUpgradeSection([day("2026-11-03", 120)], [day("2026-11-03", 59)], 81.6).emptyReason!, /Executiva direta/);
    assert.match(buildTapUpgradeSection([day("2026-11-03", 120)], [], 81.6).emptyReason!, /Nenhum dia/);
  });
});
