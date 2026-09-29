import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { DIR_FIXTURES } from "../../nucleo/caminhos.ts";
import { construirRelatorioLatam, escolherMelhoresPares, lerOpcoesResgate } from "./bot-latam.ts";

const outbound = [
  { data: "2026-10-01", valor: 2500, menorTarifa: true },
  { data: "2026-10-02", valor: 3100, menorTarifa: false },
];
const inbound = [
  { data: "2026-10-08", valor: 2600, menorTarifa: true },
  { data: "2026-10-12", valor: 2700, menorTarifa: false },
];

describe("LATAM", () => {
  test("reads the miles-plus-money ladder of a round-trip pair", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR_FIXTURES, "latam-redemption-options-real.json"), "utf8"));
    assert.deepEqual(lerOpcoesResgate(raw), {
      taxaReais: 255.69,
      opcoes: [
        { id: 1, milhas: 90302, dinheiroReais: 0, totalReais: 255.69 },
        { id: 2, milhas: 81272, dinheiroReais: 469.56, totalReais: 725.25 },
        { id: 3, milhas: 63212, dinheiroReais: 1164.87, totalReais: 1420.56 },
        { id: 4, milhas: 45151, dinheiroReais: 1760.89, totalReais: 2016.58 },
      ],
    });
  });

  test("builds the report in reais, dropping days above the ceiling", () => {
    assert.deepEqual(construirRelatorioLatam(outbound, { tetoReais: 3000 }), {
      menor: 2500,
      maior: 2500,
      dias: [{ data: "2026-10-01", valorK: 2500 }],
      texto: "Out 2026: 01",
      unidade: "BRL",
    });
  });

  test("picks the cheapest round-trip pair within the price band", () => {
    assert.deepEqual(escolherMelhoresPares(outbound, inbound, 3, 100, 300), [
      { ida: outbound[0], volta: inbound[0] },
    ]);
  });
});
