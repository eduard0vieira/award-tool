import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSearchRows } from "./spreadsheet.ts";

describe("search spreadsheet", () => {
  // The keys are the CSV and Google Sheets headers of an existing, appended-to sheet.
  test("turns a finished search into rows with the sheet's headers", () => {
    const [row, ...rest] = buildSearchRows({
      source: "AA",
      origin: "GRU",
      destination: "MIA",
      searchId: "job-1",
      ceilings: { Executiva: 70 },
      legs: [{ rotulo: "Volta: MIA → GRU", secoes: [{ rotulo: "Executiva", dias: [{ data: "2026-10-01", valorK: 60 }] }] }],
    });
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { ...row, carimbo: "stamp" },
      {
        carimbo: "stamp",
        fonte: "AA",
        origem: "GRU",
        destino: "MIA",
        direcao: "volta",
        cabine: "Executiva",
        data: "2026-10-01",
        valor: 60,
        unidade: "K",
        assentos: null,
        teto: 70,
        busca: "job-1",
      },
    );
  });
});
