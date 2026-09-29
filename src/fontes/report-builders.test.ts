import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { construirRelatorioAA, linkEmissaoAA } from "./aa/bot-aa.ts";
import { construirRelatorioSeatspy, type ValorCabine } from "./seatspy/bot-seatspy.ts";
import { construirRelatorio } from "./tap/bot-tap.ts";

const cabin = (miles: number | null, seats = 0): ValorCabine => ({ disponivel: miles !== null, milhas: miles, assentos: seats });

describe("report builders", () => {
  test("TAP splits business and economy, parsing values in K", () => {
    const report = construirRelatorio(
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
    const { secoes } = construirRelatorioSeatspy(
      [
        { data: "2026-10-01", economica: cabin(30000, 4), premium: cabin(null), executiva: cabin(90000, 2), primeira: cabin(null) },
        { data: "2026-10-03", economica: cabin(45000, 9), premium: cabin(null), executiva: cabin(null), primeira: cabin(null) },
      ],
      { economica: 40000 },
      true,
    );
    assert.deepEqual(
      secoes.map((s) => [s.rotulo, s.corClasse, s.menor, s.maior, s.texto]),
      [
        ["Econômica", "cartao-economica", 30, 30, "Out 2026: 01 (4)"],
        ["Premium", "cartao-premium", null, null, "Nenhuma disponibilidade encontrada nesse período."],
        ["Executiva", "cartao-executiva", 90, 90, "Out 2026: 01 (2)"],
        ["Primeira Classe", "cartao-primeira", null, null, "Nenhuma disponibilidade encontrada nesse período."],
      ],
    );
    assert.deepEqual(secoes[0]!.dias, [{ data: "2026-10-01", valorK: 30, assentos: 4 }]);
  });

  test("AA keeps days under the ceiling and links each one to the booking page", () => {
    const route = { origem: "GRU", destino: "MIA", passageiros: 2, cabine: "executiva" as const };
    const report = construirRelatorioAA(
      [
        { data: "2026-10-01", milhas: 60000 },
        { data: "2026-10-02", milhas: 90000 },
      ],
      70000,
      route,
    );
    assert.equal(report.menor, 60);
    assert.equal(report.texto, "Out 2026: 01");
    assert.equal(report.dias.length, 1);
    assert.equal(report.dias[0]!.link, linkEmissaoAA(route, "2026-10-01"));
    assert.match(linkEmissaoAA(route, "2026-10-01"), /pax=2&adult=2&type=OneWay&searchType=Award&cabin=BUSINESS/);
  });
});
