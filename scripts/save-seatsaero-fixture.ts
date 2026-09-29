import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// PHASE 0 of the Seats.aero source: one single /search call, saving the RAW
// response to disk and printing every header.
//
// This script parses, filters and converts nothing, on purpose. The previous
// source (mileage-bot, in Python) was written against an imagined schema and
// piled up six silent bugs because of it; here no parsing line gets written
// before a real response exists on disk.
//
// Usage:
//   npx tsx scripts/save-seatsaero-fixture.ts
//   npx tsx scripts/save-seatsaero-fixture.ts GRU MIA 10
//
// Needs SEATS_API_KEY in .env (the key is NOT printed or saved).

const BODY_FILE = path.join(FIXTURES_DIR, "seatsaero-real.json");
const HEADERS_FILE = path.join(FIXTURES_DIR, "seatsaero-real.headers.json");

const BASE_URL = process.env.SEATS_BASE_URL || "https://seats.aero/partnerapi";

const [origin = "GRU", destination = "MIA", take = "10"] = process.argv.slice(2);

const apiKey = process.env.SEATS_API_KEY;
if (!apiKey) {
  console.error(
    "❌ SEATS_API_KEY não encontrada.\n" +
      "   Adicione a chave da API Partner do Seats.aero no .env do projeto:\n" +
      "   SEATS_API_KEY=...\n",
  );
  process.exit(1);
}

// Only the minimum parameters: the fewer assumptions, the truer the picture. No
// cabins, no date filter, no order_by: the goal is seeing what the API returns
// by default, not what we expect it to return.
const params = new URLSearchParams({
  origin_airport: origin.toUpperCase(),
  destination_airport: destination.toUpperCase(),
  take,
});
const url = `${BASE_URL}/search?${params}`;

console.log(`\n🔌 GET ${url}\n`);

const response = await fetch(url, {
  headers: {
    "Partner-Authorization": apiKey,
    accept: "application/json",
  },
});

console.log(`Status: ${response.status} ${response.statusText}\n`);

// Every header, unfiltered: the quota one lives here, and the docs do not publish its exact name.
console.log("Headers da resposta:");
const headers: Record<string, string> = {};
response.headers.forEach((value, name) => {
  headers[name] = value;
  console.log(`  ${name}: ${value}`);
});
console.log();

const body = await response.text();

if (!response.ok) {
  console.error("❌ A API não respondeu 200 — nada foi salvo (uma fixture de erro não serve de schema).");
  console.error(`Corpo da resposta (${body.length} bytes):\n${body.slice(0, 2000)}\n`);
  process.exit(1);
}

fs.mkdirSync(FIXTURES_DIR, { recursive: true });
fs.writeFileSync(BODY_FILE, body, "utf8");

console.log(`✅ Resposta crua salva em fixtures/seatsaero-real.json (${body.length} bytes).`);
console.log("   Nada foi parseado nem transformado — é byte a byte o que a API devolveu.\n");

// Headers go in a separate file so they never pollute the body fixture. No
// Authorization: only what the API answered.
fs.writeFileSync(HEADERS_FILE, JSON.stringify(headers, null, 2), "utf8");
console.log(`✅ Headers salvos em fixtures/seatsaero-real.headers.json\n`);
