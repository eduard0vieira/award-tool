import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { SPREADSHEETS_DIR } from "../src/core/paths.ts";
import { createSearchSheet, saveSearch, writeFlightsCsv, type FlightRow } from "../src/outputs/spreadsheet.ts";
import {
  buildIberiaReport,
  detailDays,
  filterFlights,
  iberiaBookingLink,
  searchIberiaYear,
  startIberiaSession,
  type FlightFilters,
  type IberiaSearchParams,
} from "../src/scrapers/iberia/iberia.scraper.ts";

// Runs the Iberia source end to end, without the server or the front.
//
//   npx tsx scripts/search-iberia.ts GRU MAD 40000 --stops=1 --duration=20h --days=20
//
// Positional: origin, destination, Avios ceiling (optional). Options:
//   --days=N       how many days (the cheapest) to detail flight by flight; 0 turns it off
//   --stops=N      drops itineraries with more than N stops
//   --duration=X   drops anything longer than X; takes "20h", "1200m" or plain minutes
//   --airlines=IB,I2  only itineraries fully operated by these airlines

const options = new Map<string, string>();
const positional: string[] = [];
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z]+)=(.*)$/.exec(arg);
  if (match) options.set(match[1]!, match[2]!);
  else positional.push(arg);
}

const [origin = "GRU", destination = "MAD", rawCeiling] = positional;
const ceiling = rawCeiling ? Number(rawCeiling) : null;
if (ceiling != null && Number.isNaN(ceiling)) {
  console.error(`Teto "${rawCeiling}" não é número.`);
  process.exit(1);
}

function numberOption(name: string, fallback: number | null): number | null {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    console.error(`--${name}=${raw} não é número.`);
    process.exit(1);
  }
  return value;
}

// "20h" → 1200, "90m" → 90, "1200" → 1200.
function durationInMinutes(): number | null {
  const raw = options.get("duration");
  if (!raw) return null;
  const match = /^(\d+(?:[.,]\d+)?)\s*([hm]?)$/i.exec(raw.trim());
  if (!match) {
    console.error(`--duration=${raw} não entendi. Use "20h", "1200m" ou "1200".`);
    process.exit(1);
  }
  const value = Number(match[1]!.replace(",", "."));
  return match[2]!.toLowerCase() === "h" ? Math.round(value * 60) : Math.round(value);
}

// Off by default: the flight detail is not reliable yet. Iberia's session drops
// mid-sweep and `/availability` only answers from inside the tab, which by then
// has been sent to the login. The calendar, which produces the alert, does not depend on it.
const MAX_DETAILED_DAYS = numberOption("days", 0)!;
const filters: FlightFilters = {
  maxStops: numberOption("stops", null),
  maxDurationMinutes: durationInMinutes(),
  airlines: options.get("airlines")?.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean) ?? null,
};

const params: IberiaSearchParams = { origin, destination, passengers: 1 };
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

async function main() {
  console.log(`\nIberia ${origin.toUpperCase()} → ${destination.toUpperCase()}${ceiling ? ` (teto ${ceiling} Avios)` : ""}\n`);

  const session = await startIberiaSession(false);
  try {
    const result = await searchIberiaYear(
      session.page,
      params,
      (message) => console.log(`  ${message}`),
      (fraction) => process.stdout.write(`\r  calendário: ${Math.round(fraction * 100)}%   `),
    );
    console.log("\n");

    if (result.kind === "error") {
      console.error(`❌ ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    if (result.kind === "no_availability") {
      console.log(`Nenhum dia com prêmio entre ${result.window.from} e ${result.window.until}.`);
      return;
    }
    if (result.kind === "partial") console.log(`⚠️  Resultado parcial: ${result.reason}\n`);

    const section = buildIberiaReport(result.days, ceiling, params);
    console.log(`Janela varrida: ${result.window.from} → ${result.window.until}`);
    console.log(`Dias com prêmio: ${result.days.length}` + (ceiling ? ` (${section.days.length} dentro do teto)` : ""));
    if (section.min != null) console.log(`Faixa: ${section.min}K → ${section.max}K Avios\n`);
    console.log(section.text);

    // The accumulated record, like every other source: one row per day.
    await saveSearch(
      {
        source: "IBERIA",
        origin: origin.toUpperCase(),
        destination: destination.toUpperCase(),
        legs: [
          {
            label: `Ida: ${origin.toUpperCase()} → ${destination.toUpperCase()}`,
            sections: [{ label: "Avios", days: section.days.map((day) => ({ date: day.date, valueK: day.valueK })) }],
          },
        ],
        ceilings: ceiling != null ? { Avios: Math.round(ceiling / 10) / 100 } : {},
        searchId: crypto.randomUUID(),
      },
      (message) => console.log(`  ${message}`),
    );
    console.log(`\nRegistrado em spreadsheets/buscas.csv (${section.days.length} linha(s)).`);

    if (MAX_DETAILED_DAYS <= 0 || section.days.length === 0) return;

    // One request per date, so the cheapest go first and the count is capped.
    // What was left out is said out loud: a cut sweep that does not announce
    // itself becomes "not available" in the alert.
    const aviosByDate = new Map(result.days.map((day) => [day.date, day.avios]));
    const candidates = [...section.days].sort((a, b) => (aviosByDate.get(a.date) ?? 0) - (aviosByDate.get(b.date) ?? 0));
    const chosen = candidates.slice(0, MAX_DETAILED_DAYS);
    if (candidates.length > chosen.length) {
      console.log(
        `\n${candidates.length} dia(s) passaram no teto; detalhando os ${chosen.length} mais baratos ` +
          `(--days=${MAX_DETAILED_DAYS}). Os outros ${candidates.length - chosen.length} ficaram sem voo na planilha.`,
      );
    } else {
      console.log(`\nDetalhando ${chosen.length} dia(s), voo a voo...`);
    }

    const { flights, failedDays } = await detailDays(
      session.page,
      params,
      chosen.map((day) => day.date),
      (message) => console.log(`  ${message}`),
      (fraction) => process.stdout.write(`\r  detalhe: ${Math.round(fraction * 100)}%   `),
    );
    console.log("");

    const filtered = filterFlights(flights, filters);
    const dropped = flights.length - filtered.length;
    if (dropped > 0) console.log(`  ${dropped} voo(s) fora dos filtros pedidos.`);
    if (failedDays.length > 0) {
      console.log(`⚠️  ${failedDays.length} dia(s) falharam. O primeiro: ${failedDays[0]!.date} — ${failedDays[0]!.error}`);
    }

    const rows: FlightRow[] = filtered.map((flight) => ({
      departure_date: flight.date,
      arrival_date: flight.arrivalDate,
      departure_station: flight.origin,
      departure_time: flight.departureTime,
      arrival_station: flight.destination,
      connections: flight.stops,
      connecting_airports: flight.connectingAirports,
      // Empty on purpose: Iberia has no per-flight price. The day's goes in `day_avios`, which is what it is.
      points: "",
      duration: flight.durationMinutes,
      cabin_category: flight.cabins,
      operation_carriers: flight.airlines,
      program: "IBERIA",
      source_fare: flight.fare,
      available_seats: flight.seats ?? "",
      aircraft: flight.aircraft,
      tax: "",
      class_of_service: flight.serviceClasses,
      url: iberiaBookingLink(params, flight.date),
      day_avios: aviosByDate.get(flight.date) ?? "",
    }));

    if (rows.length === 0) {
      console.log("Nenhum voo sobrou depois dos filtros — planilha de voos não foi gerada.");
      return;
    }

    const file = path.join(
      SPREADSHEETS_DIR,
      `iberia-${origin.toUpperCase()}-${destination.toUpperCase()}-${stamp.replace(/[: ]/g, "-")}.csv`,
    );
    writeFlightsCsv(rows, file);
    console.log(`\n✅ ${rows.length} voo(s) em ${path.relative(process.cwd(), file)}`);

    const url = await createSearchSheet(
      { title: `Iberia ${origin.toUpperCase()}-${destination.toUpperCase()} ${stamp}`, rows },
      (message) => console.log(`  ${message}`),
    );
    if (url) console.log(`   também no Google: ${url}`);
  } finally {
    // Closing only the tab keeps Chrome's context alive and the process hangs
    // after printing everything (it once hung a run for 16 minutes). Close the
    // context and exit with an explicit code.
    await session.page.close().catch(() => {});
    await session.context.close().catch(() => {});
    await session.browser?.close().catch(() => {});
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
