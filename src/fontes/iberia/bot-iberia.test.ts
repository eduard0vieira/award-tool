import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { DIR_FIXTURES } from "../../nucleo/caminhos.ts";
import { construirRelatorioIberia, filtrarVoos, lerVoos, linkEmissaoIberia } from "./bot-iberia.ts";

const fixture = (name: string) => fs.readFileSync(path.join(DIR_FIXTURES, name), "utf8");
const route = { origem: "GRU", destino: "MAD", passageiros: 1 };

describe("Iberia availability parser", () => {
  test("reads each offer of the day as a flight", () => {
    const flights = lerVoos(fixture("iberia-real.json"), "2026-12-15");
    assert.equal(flights.length, 5);
    assert.deepEqual(flights[0], {
      data: "2026-12-15",
      partidaHora: "00:25",
      chegadaData: "2026-12-15",
      chegadaHora: "18:05",
      origem: "GRU",
      destino: "MAD",
      escalas: 1,
      aeroportosConexao: "CMN",
      duracaoMinutos: 820,
      cabines: "ECONOMY, BUSINESS",
      companhias: "AT",
      classesServico: "E, Z",
      aeronaves: "Boeing 787-9, Boeing 737",
      assentos: 2,
      tarifa: "EATFF, ZATFF",
    });
  });

  test("filters flights by stops and by cabin", () => {
    const flights = lerVoos(fixture("iberia-real-mais1.json"), "2026-12-16");
    assert.equal(flights.length, 9);
    assert.equal(filtrarVoos(flights, { maxEscalas: 0 }).length, 0);
    assert.equal(filtrarVoos(flights, { maxEscalas: 1 }).length, 1);
    assert.equal(filtrarVoos(flights, { cabines: ["BUSINESS"] }).length, 9);
  });

  test("builds the date report in K with an issue link per day", () => {
    const report = construirRelatorioIberia(
      [
        { data: "2026-12-15", avios: 34000 },
        { data: "2027-01-14", avios: 51000 },
      ],
      null,
      route,
    );
    assert.equal(report.menor, 34);
    assert.equal(report.maior, 51);
    assert.equal(report.texto, "Dez 2026: 15\nJan 2027: 14");
    assert.equal(report.dias[0]!.link, linkEmissaoIberia(route, "2026-12-15"));
    assert.match(linkEmissaoIberia(route, "2026-12-15"), /BEGIN_CITY_01=GRU&END_CITY_01=MAD&BEGIN_DAY_01=15&BEGIN_MONTH_01=202612/);
  });
});
