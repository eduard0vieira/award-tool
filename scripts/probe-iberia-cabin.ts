import "dotenv/config";
import { currentAuthorization, iberiaBookingLink, startIberiaSession } from "../src/scrapers/iberia/iberia.scraper.ts";

// The `/calendar/grid` body has a `preferredCabin` the source always sends
// empty, because that is how the site sent it when the recon captured it. If it
// accepted "BUSINESS", the calendar would give BUSINESS dates and prices and the
// front's cabin selector would stop being cosmetic. This probe asks exactly
// that: same route, same date, only that field changing.
//
// Usage: npx tsx scripts/probe-iberia-cabin.ts [GRU] [MAD]

const [origin = "GRU", destination = "MAD"] = process.argv.slice(2);
const params = { origin, destination, passengers: 1 };

const CABINS = ["", "BUSINESS", "ECONOMY", "TOURIST", "PREMIUMTOURIST", "FIRST"];

function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const session = await startIberiaSession(false);
  const page = session.page;
  try {
    const date = daysFromToday(1);
    await page
      .goto(iberiaBookingLink(params, date), { waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch((error: Error) => {
        if (!/ERR_ABORTED/.test(error.message)) throw error;
      });
    await page.waitForTimeout(15_000);
    console.log(`página: ${page.url().slice(0, 90)}`);

    // Without the page's own bearer, ibisservices answers 401 and the probe says nothing about cabins.
    const authorization = currentAuthorization(page);
    if (!authorization) {
      console.error("A página não fez nenhuma chamada com Authorization — sem token não dá pra sondar.");
      return;
    }
    console.log("");

    for (const cabin of CABINS) {
      const body = {
        isPetFlight: false,
        slices: [{ origin: origin.toUpperCase(), destination: destination.toUpperCase(), date }],
        passengers: [{ passengerType: "ADULT", count: "1" }],
        marketCode: "US",
        preferredCabin: cabin,
        maxSearchTime: 359,
      };

      const response = (await page.evaluate(
        async ({ body, authorization }) => {
          try {
            const result = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/calendar/grid", {
              method: "POST",
              headers: { "content-type": "application/json", authorization },
              body: JSON.stringify(body),
              credentials: "include",
            });
            return { status: result.status, text: await result.text() };
          } catch (error) {
            return { status: -1, text: String(error) };
          }
        },
        { body, authorization },
      )) as { status: number; text: string };

      const label = cabin === "" ? "(vazio, como a fonte manda hoje)" : cabin;
      if (response.status !== 200) {
        console.log(`preferredCabin=${label}: status ${response.status} — ${response.text.slice(0, 120)}`);
        continue;
      }
      try {
        const json = JSON.parse(response.text) as {
          outbound?: { availabilityCalendar?: { date: string; avios?: number }[] };
        };
        const calendar = json.outbound?.availabilityCalendar ?? [];
        const priced = calendar.filter((day) => typeof day.avios === "number");
        const values = priced.map((day) => day.avios!);
        console.log(
          `preferredCabin=${label}: ${calendar.length} dias, ${priced.length} com preço` +
            (values.length ? `, de ${Math.min(...values)} a ${Math.max(...values)} Avios` : ""),
        );
      } catch {
        console.log(`preferredCabin=${label}: 200, corpo ilegível`);
      }
      await page.waitForTimeout(8000);
    }
  } finally {
    await page.close().catch(() => {});
    await session.context.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
