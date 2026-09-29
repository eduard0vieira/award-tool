import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../src/core/paths.ts";
import { filtrarVoos, lerVoos } from "../src/fontes/iberia/bot-iberia.ts";

// Confere o parser de voos contra as respostas reais salvas em fixtures/.
// Roda sem rede e sem navegador — é o que dá pra verificar quando o site está
// cortando por frequência.

const arquivos = ["iberia-real.json", "iberia-real-mais1.json", "iberia-real-mais30.json"];

for (const nome of arquivos) {
  const caminho = path.join(FIXTURES_DIR, nome);
  if (!fs.existsSync(caminho)) {
    console.log(`${nome}: não está em fixtures/ — pulando.`);
    continue;
  }
  const voos = lerVoos(fs.readFileSync(caminho, "utf8"), "fixture");
  console.log(`\n${nome}: ${voos.length} voo(s)`);
  for (const v of voos.slice(0, 3)) {
    console.log(
      `  ${v.data} ${v.partidaHora} ${v.origem}→${v.destino} | ${v.escalas} escala(s)` +
        `${v.aeroportosConexao ? ` via ${v.aeroportosConexao}` : ""} | ${v.companhias}` +
        ` | ${Math.round(v.duracaoMinutos / 60)}h | ${v.cabines} | vagas ${v.assentos ?? "-"}` +
        ` | ${v.aeronaves.slice(0, 40)}`,
    );
  }
  const semCompanhia = voos.filter((v) => !v.companhias).length;
  const semAssento = voos.filter((v) => v.assentos == null).length;
  console.log(`  sem companhia: ${semCompanhia} | sem vagas: ${semAssento}`);
  console.log(`  filtro até 1 escala: ${filtrarVoos(voos, { maxEscalas: 1 }).length} voo(s)`);
  console.log(`  filtro só IB/I2/VY: ${filtrarVoos(voos, { companhias: ["IB", "I2", "VY"] }).length} voo(s)`);
  console.log(`  filtro até 20h: ${filtrarVoos(voos, { maxDuracaoMinutos: 1200 }).length} voo(s)`);
}
