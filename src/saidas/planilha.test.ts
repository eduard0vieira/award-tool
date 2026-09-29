import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { montarLinhas } from "./planilha.ts";

describe("search spreadsheet", () => {
  // The keys are the CSV and Google Sheets headers of an existing, appended-to sheet.
  test("turns a finished search into spreadsheet rows with the sheet's headers", () => {
    const [row, ...rest] = montarLinhas({
      fonte: "AA",
      origem: "GRU",
      destino: "MIA",
      busca: "job-1",
      tetos: { Executiva: 70 },
      pernas: [{ rotulo: "Volta: MIA → GRU", secoes: [{ rotulo: "Executiva", dias: [{ data: "2026-10-01", valorK: 60 }] }] }],
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
