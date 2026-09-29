import "dotenv/config";
import {
  currentAuthorization,
  detailDays,
  ensureLoggedIn,
  fetchDayFlights,
  searchIberiaYear,
  startIberiaSession,
  type IberiaFlight,
} from "../src/scrapers/iberia/iberia.scraper.ts";

// Measures how many parallel `/availability` calls Iberia takes when they leave
// from inside the tab, right after the calendar, on the same session: the
// `cheap-flights` pace (batches of 30, 7s apart), but through the browser,
// which is what the anti-bot lets pass. Stops at the first status that is not 200/204.
//
// Usage: npx tsx scripts/measure-iberia-batches.ts [GRU] [MAD] [5,10,30]
//        npx tsx scripts/measure-iberia-batches.ts GRU MAD detail   (the real `detailDays`, every date)

const [origin = "GRU", destination = "MAD", batches = "5,10,30"] = process.argv.slice(2);
const params = { origin, destination, passengers: 1 };
const BATCH_SIZES = batches.split(",").map(Number);
const PAUSE_BETWEEN_BATCHES_MS = 7000;

async function main() {
  const session = await startIberiaSession(false);
  const page = session.page;
  const log = (message: string) => console.log(message);
  try {
    await ensureLoggedIn(page, log);
    const calendar = await searchIberiaYear(page, params, log);
    if (calendar.kind === "error" || calendar.kind === "no_availability") {
      console.error(`Calendário não deu datas pra medir: ${JSON.stringify(calendar)}`);
      return;
    }
    const authorization = currentAuthorization(page);
    if (!authorization) {
      console.error("Sem token da página depois do calendário — nada a medir.");
      return;
    }

    const dates = calendar.days.map((day) => day.date);

    if (batches === "detail") {
      const start = Date.now();
      const { flights, failedDays } = await detailDays(page, params, dates, log);
      const withBusiness = new Set(flights.filter((flight) => flight.cabins.includes("BUSINESS")).map((flight) => flight.date));
      console.log(
        `\ndetalhe de ${dates.length} datas em ${((Date.now() - start) / 60000).toFixed(1)} min: ` +
          `${flights.length} voos, ${failedDays.length} dia(s) com falha, ${withBusiness.size} dia(s) com executiva`,
      );
      for (const failure of failedDays.slice(0, 5)) console.log(`  ${failure.date}: ${failure.error.slice(0, 160)}`);
      return;
    }
    console.log(`\n${dates.length} datas com prêmio no calendário. Medindo lotes de ${BATCH_SIZES.join(", ")}.\n`);

    let cursor = 0;
    const cabinsSeen = new Map<string, number>();
    for (const size of BATCH_SIZES) {
      const batch = dates.slice(cursor, cursor + size);
      cursor += batch.length;
      if (batch.length === 0) break;
      if (!/^https:\/\/www\.iberia\.com\/flights\//.test(page.url())) {
        console.log(`PAROU: a aba saiu da busca antes do lote de ${size} (${page.url().slice(0, 100)}).`);
        break;
      }

      const start = Date.now();
      const results = await Promise.all(
        batch.map(async (date) => {
          try {
            return { date, flights: await fetchDayFlights(page, params, date, authorization) };
          } catch (error) {
            return { date, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const elapsedMs = Date.now() - start;

      const failures = results.filter((result): result is { date: string; error: string } => "error" in result);
      const successes = results.filter((result): result is { date: string; flights: IberiaFlight[] } => "flights" in result);
      const daysWithBusiness = successes.filter((result) => result.flights.some((flight) => flight.cabins.includes("BUSINESS"))).length;
      for (const result of successes) {
        for (const flight of result.flights) {
          for (const cabin of flight.cabins.split(", ").filter(Boolean)) cabinsSeen.set(cabin, (cabinsSeen.get(cabin) ?? 0) + 1);
        }
      }
      console.log(
        `lote de ${batch.length}: ${(elapsedMs / 1000).toFixed(1)}s, ${successes.length} ok, ${failures.length} falha(s), ` +
          `${successes.reduce((count, result) => count + result.flights.length, 0)} voos, ${daysWithBusiness} dia(s) com executiva`,
      );
      if (failures.length > 0) {
        for (const failure of failures.slice(0, 3)) console.log(`  ${failure.date}: ${failure.error.slice(0, 160)}`);
        console.log("PAROU no primeiro lote com falha.");
        break;
      }
      await page.waitForTimeout(PAUSE_BETWEEN_BATCHES_MS);
    }

    console.log(`\nCabines vistas nos voos (voo pode ter mais de uma): ${JSON.stringify(Object.fromEntries(cabinsSeen))}`);
    console.log(`Aba ao final: ${page.url().slice(0, 100)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
