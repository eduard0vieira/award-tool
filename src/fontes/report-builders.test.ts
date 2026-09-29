import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aaBookingLink, buildAaReport } from "../scrapers/aa/aa.scraper.ts";
import { buildSeatspyReport, type CabinAvailability } from "../scrapers/seatspy/seatspy.scraper.ts";
import { buildTapReport } from "../scrapers/tap/tap.scraper.ts";

const cabin = (miles: number | null, seats = 0): CabinAvailability => ({ available: miles !== null, miles, seats });

describe("report builders", () => {
  test("TAP splits business and economy, parsing values in K", () => {
    const report = buildTapReport(
      [
        { date: "2026-10-01", found: 1, total: 1, economy: "45K", premiumEconomy: "-", business: "170K", first: "-" },
        { date: "2026-10-02", found: 1, total: 1, economy: "60K", premiumEconomy: "-", business: "200K", first: "-" },
        { date: "2026-11-05", found: 1, total: 1, economy: "-", premiumEconomy: "-", business: "150K", first: "-" },
      ],
      {},
    );
    assert.deepEqual(report, {
      executivas: {
        menor: 150,
        maior: 170,
        dias: [
          { data: "2026-10-01", valorK: 170 },
          { data: "2026-11-05", valorK: 150 },
        ],
        texto: "Out 2026: 01\nNov 2026: 05",
      },
      economicas: { menor: 45, maior: 45, dias: [{ data: "2026-10-01", valorK: 45 }], texto: "Out 2026: 01" },
    });
  });

  test("SeatSpy builds four cabins, applies ceilings and shows seats", () => {
    const { sections } = buildSeatspyReport(
      [
        { date: "2026-10-01", economy: cabin(30000, 4), premium: cabin(null), business: cabin(90000, 2), first: cabin(null) },
        { date: "2026-10-03", economy: cabin(45000, 9), premium: cabin(null), business: cabin(null), first: cabin(null) },
      ],
      { economy: 40000 },
      true,
    );
    assert.deepEqual(
      sections.map((s) => [s.rotulo, s.corClasse, s.menor, s.maior, s.texto]),
      [
        ["Econômica", "cartao-economica", 30, 30, "Out 2026: 01 (4)"],
        ["Premium", "cartao-premium", null, null, "Nenhuma disponibilidade encontrada nesse período."],
        ["Executiva", "cartao-executiva", 90, 90, "Out 2026: 01 (2)"],
        ["Primeira Classe", "cartao-primeira", null, null, "Nenhuma disponibilidade encontrada nesse período."],
      ],
    );
    assert.deepEqual(sections[0]!.dias, [{ data: "2026-10-01", valorK: 30, assentos: 4 }]);
  });

  test("AA keeps days under the ceiling and links each one to the booking page", () => {
    const route = { origin: "GRU", destination: "MIA", passengers: 2, cabin: "executiva" as const };
    const report = buildAaReport(
      [
        { date: "2026-10-01", miles: 60000 },
        { date: "2026-10-02", miles: 90000 },
      ],
      70000,
      route,
    );
    assert.equal(report.menor, 60);
    assert.equal(report.texto, "Out 2026: 01");
    assert.equal(report.dias.length, 1);
    assert.equal(report.dias[0]!.link, aaBookingLink(route, "2026-10-01"));
    assert.match(aaBookingLink(route, "2026-10-01"), /pax=2&adult=2&type=OneWay&searchType=Award&cabin=BUSINESS/);
  });
});
