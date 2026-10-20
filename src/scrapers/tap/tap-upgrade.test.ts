import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTapUpgradeSection, tapUpgradeCostK } from "./tap-upgrade.ts";

const day = (date: string, valueK: number) => ({ date, valueK });

describe("TAP upgrade", () => {
  test("knows the price only between Brazil and mainland Portugal, both ways", () => {
    assert.equal(tapUpgradeCostK("FOR", "LIS"), 81.6);
    assert.equal(tapUpgradeCostK("OPO", "GRU"), 81.6);
    assert.equal(tapUpgradeCostK("GRU", "MAD"), null);
    assert.equal(tapUpgradeCostK("GRU", "PDL"), null);
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
