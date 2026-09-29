import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// FASE 0 do módulo Seats.aero: uma única chamada ao /search, salvando a
// resposta CRUA em disco e imprimindo todos os headers.
//
// Este script não parseia, não filtra, não converte nada — de propósito. O
// módulo anterior (mileage-bot, em Python) foi escrito contra um schema
// imaginado e acumulou seis bugs silenciosos por causa disso; aqui nenhuma
// linha de parsing é escrita antes de existir uma resposta real em disco.
//
// Uso:
//   npx tsx scripts/salvar-fixture-seatsaero.ts
//   npx tsx scripts/salvar-fixture-seatsaero.ts GRU MIA 10
//
// Precisa de SEATS_API_KEY no .env (a chave NÃO é impressa nem salva).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const DESTINO = path.join(ROOT_DIR, "fixtures", "seatsaero-real.json");

const BASE_URL = process.env.SEATS_BASE_URL || "https://seats.aero/partnerapi";

const [origem = "GRU", destino = "MIA", take = "10"] = process.argv.slice(2);

const chave = process.env.SEATS_API_KEY;
if (!chave) {
  console.error(
    "❌ SEATS_API_KEY não encontrada.\n" +
      "   Adicione a chave da API Partner do Seats.aero no .env do projeto:\n" +
      "   SEATS_API_KEY=...\n",
  );
  process.exit(1);
}

// Só os parâmetros mínimos: quanto menos suposição, mais fiel é o retrato.
// Sem cabins, sem filtro de data, sem order_by — o objetivo aqui é ver o que a
// API devolve por padrão, não o que a gente espera que ela devolva.
const params = new URLSearchParams({
  origin_airport: origem.toUpperCase(),
  destination_airport: destino.toUpperCase(),
  take,
});
const url = `${BASE_URL}/search?${params}`;

console.log(`\n🔌 GET ${url}\n`);

const resposta = await fetch(url, {
  headers: {
    "Partner-Authorization": chave,
    accept: "application/json",
  },
});

console.log(`Status: ${resposta.status} ${resposta.statusText}\n`);

// Todos os headers, sem filtrar: é aqui que mora o de cota, cujo nome exato a
// documentação não publica.
console.log("Headers da resposta:");
const headers: Record<string, string> = {};
resposta.headers.forEach((valor, nome) => {
  headers[nome] = valor;
  console.log(`  ${nome}: ${valor}`);
});
console.log();

const corpo = await resposta.text();

if (!resposta.ok) {
  console.error("❌ A API não respondeu 200 — nada foi salvo (uma fixture de erro não serve de schema).");
  console.error(`Corpo da resposta (${corpo.length} bytes):\n${corpo.slice(0, 2000)}\n`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
fs.writeFileSync(DESTINO, corpo, "utf8");

console.log(`✅ Resposta crua salva em fixtures/seatsaero-real.json (${corpo.length} bytes).`);
console.log("   Nada foi parseado nem transformado — é byte a byte o que a API devolveu.\n");

// Os headers vão junto, num arquivo separado, pra não contaminar a fixture do
// corpo. Sem Authorization: só o que a API respondeu.
const destinoHeaders = path.join(path.dirname(DESTINO), "seatsaero-real.headers.json");
fs.writeFileSync(destinoHeaders, JSON.stringify(headers, null, 2), "utf8");
console.log(`✅ Headers salvos em fixtures/seatsaero-real.headers.json\n`);
