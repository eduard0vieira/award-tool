import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../src/core/paths.ts";
import { filterFlights, readFlights } from "../src/scrapers/iberia/iberia.scraper.ts";

// Checks the flight parser against the real responses saved in fixtures/. Runs
// without network or browser: what can be verified while the site is rate-limiting.

const files = ["iberia-real.json", "iberia-real-plus1.json", "iberia-real-plus30.json"];

for (const name of files) {
  const filePath = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(filePath)) {
    console.log(`${name}: não está em fixtures/ — pulando.`);
    continue;
  }
  const flights = readFlights(fs.readFileSync(filePath, "utf8"), "fixture");
  console.log(`\n${name}: ${flights.length} voo(s)`);
  for (const flight of flights.slice(0, 3)) {
    console.log(
      `  ${flight.date} ${flight.departureTime} ${flight.origin}→${flight.destination} | ${flight.stops} escala(s)` +
        `${flight.connectingAirports.length ? ` via ${flight.connectingAirports.join(", ")}` : ""}` +
        ` | ${flight.carriers.map((carrier) => carrier.code).join(", ")} | ${Math.round(flight.durationMinutes / 60)}h` +
        ` | ${flight.fares.map((fare) => `${fare.cabin} ${fare.avios ?? "sem preço"} (${fare.seats ?? "-"})`).join(", ")}` +
        ` | ${flight.aircraft.join(", ").slice(0, 40)}`,
    );
  }
  console.log(
    `  com Avios: ${flights.filter((flight) => flight.fares.some((fare) => fare.avios !== null)).length} | ` +
      `sem vagas: ${flights.filter((flight) => flight.fares.every((fare) => fare.seats == null)).length}`,
  );
  console.log(`  filtro até 1 escala: ${filterFlights(flights, { maxStops: 1 }).length} voo(s)`);
  console.log(`  filtro só IB/I2/VY: ${filterFlights(flights, { airlines: ["IB", "I2", "VY"] }).length} voo(s)`);
  console.log(`  filtro até 20h: ${filterFlights(flights, { maxDurationMinutes: 1200 }).length} voo(s)`);
}
