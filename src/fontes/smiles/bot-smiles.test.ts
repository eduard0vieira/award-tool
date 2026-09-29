import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES_DIR } from "../../core/paths.ts";
import { construirRelatorioSmiles, erro452, ErroForaDaJanelaSmiles, lerRespostaSmiles } from "./bot-smiles.ts";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");

describe("Smiles response parser", () => {
  test("reads flights and the 7-day calendar from a GOL route", () => {
    const response = lerRespostaSmiles(fixture("smiles-real.json"), "2026-10-13")!;
    assert.equal(response.voos.length, 8);
    assert.deepEqual(response.voos[0], {
      cabine: "economica",
      conexoes: 1,
      assentos: 9,
      milhas: 138000,
      tarifa: "SMILES_CLUB",
      milhasSemClube: 146000,
      taxaReais: 326.41,
      companhia: "GOL (G3)",
      origemDados: "G3",
      detalhe: {
        partidaData: "2026-10-13",
        partidaHora: "06:00",
        partidaAeroporto: "GRU",
        chegadaData: "2026-10-13",
        chegadaHora: "16:50",
        chegadaAeroporto: "MIA",
        aeroportosConexao: "BSB",
        duracaoMinutos: 710,
        numerosVoo: "1454, 7748",
        aeronaves: "738, 7M8",
        classesServico: "U, U",
        codigoCompanhia: "G3",
        cabineCru: "ECONOMIC",
      },
    });
    assert.deepEqual(response.calendario.slice(0, 3), [
      { data: "2026-10-10", milhas: 164000 },
      { data: "2026-10-11", milhas: 119000 },
      { data: "2026-10-12", milhas: 119000 },
    ]);
  });

  test("keeps a partner flight's fee as null instead of zero", () => {
    const response = lerRespostaSmiles(fixture("smiles-real-congener.json"), "2026-10-29")!;
    assert.equal(response.voos.length, 40);
    assert.equal(response.calendario.length, 0);
    assert.equal(response.voos[0]!.taxaReais, null);
    assert.equal(response.voos[0]!.origemDados, "AMADEUS");
  });

  test("tells an out-of-sale date apart from an unknown airport on 452", () => {
    const route = { origem: "gru", destino: "xqz" };
    assert.ok(erro452(fixture("smiles-452-data.json"), route, "2027-09-01") instanceof ErroForaDaJanelaSmiles);
    assert.match(erro452(fixture("smiles-452-aeroporto.json"), route, "2027-09-01").message, /GRU → XQZ/);
  });

  test("builds one section per cabin with seats in the copied text", () => {
    const response = lerRespostaSmiles(fixture("smiles-real.json"), "2026-10-13")!;
    const sections = construirRelatorioSmiles([response], {});
    assert.deepEqual(
      sections.map((s) => [s.rotulo, s.menor, s.maior, s.texto]),
      [
        ["Econômica", 138, 138, "Out 2026: 13 (9)"],
        ["Conforto", 219.5, 219.5, "Out 2026: 13 (9)"],
        ["Executiva", 887, 887, "Out 2026: 13 (9)"],
      ],
    );
  });
});
