import "dotenv/config";
import { aaBookingLink, startAaSession, type AaCabin } from "../src/scrapers/aa/aa.scraper.ts";

// Replays the calendar call the AA source makes, month by month, and shows the
// RAW response. It exists because a HEL→NRT business search returned
// "Calendário devolveu erro: 309" for some months and nothing for others, while
// the site showed 75K on almost every day of July 2027.
//
// Usage: npx tsx scripts/probe-aa-calendar.ts HEL NRT business 0

const [origin = "HEL", destination = "NRT", cabin = "business", rawStops = ""] = process.argv.slice(2);
const maxStops = rawStops === "" ? null : Number(rawStops);

// Typed by AaCabin so a change in the source's cabin values breaks this probe at compile time.
const REQUEST_CABINS: Record<AaCabin, string> = {
  economy: "COACH",
  premium: "PREMIUM_ECONOMY",
  business: "BUSINESS,FIRST",
  first: "FIRST",
};

function requestBody(departureDate: string, requestCabin: string, stops: number | null) {
  return {
    metadata: { selectedProducts: [], tripType: "OneWay", udo: {} },
    passengers: [{ type: "adult", count: 1 }],
    requestHeader: { clientId: "AAcom" },
    slices: [
      {
        allCarriers: true,
        cabin: requestCabin,
        departureDate,
        destination: destination.toUpperCase(),
        destinationNearbyAirports: false,
        maxStops: stops,
        origin: origin.toUpperCase(),
        originNearbyAirports: false,
      },
    ],
    tripOptions: {
      corporateBooking: false,
      fareType: "Lowest",
      locale: "en_US",
      pointOfSale: null,
      searchType: "Award",
      enableBenefits: true,
    },
    loyaltyInfo: null,
    version: "",
    queryParams: { sliceIndex: 0, sessionId: "", solutionSet: "", solutionId: "" },
  };
}

async function main() {
  const session = await startAaSession(false);
  const page = session.page;
  try {
    const url = aaBookingLink(
      { origin: origin.toUpperCase(), destination: destination.toUpperCase(), passengers: 1, cabin: cabin as AaCabin },
      "2027-07-15",
    );
    console.log(`abrindo ${url.slice(0, 110)}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(10_000);
    console.log(`URL final: ${page.url().slice(0, 110)}`);
    console.log(`título: ${await page.title()}\n`);

    // The months the sweep reports as failed, plus July 2027, which the site shows
    // full of 75K: that comparison says what 309 means.
    const cases = ["2026-09-26", "2026-10-15", "2026-11-15", "2026-12-15", "2027-01-15", "2027-07-15"].map((date) => ({
      label: `mês de ${date.slice(0, 7)}`,
      date,
    }));

    for (const probe of cases) {
      const response = (await page.evaluate(async (body) => {
        const result = await fetch("/booking/api/search/calendar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: result.status, text: await result.text() };
      }, requestBody(probe.date, REQUEST_CABINS[cabin as AaCabin], maxStops))) as { status: number; text: string };

      let summary = `status ${response.status}, ${response.text.length} bytes`;
      try {
        const json = JSON.parse(response.text) as {
          error?: string;
          calendarMonths?: {
            weeks?: { days?: { date: string | null; validDay: boolean; solution: { perPassengerAwardPoints: number } | null }[] }[];
          }[];
        };
        if (json.error) {
          summary += ` | error="${json.error}"`;
        } else {
          const days = (json.calendarMonths ?? [])
            .flatMap((month) => month.weeks ?? [])
            .flatMap((week) => week.days ?? [])
            .filter((day) => day?.validDay && day.solution && day.date);
          const points = days.map((day) => day.solution!.perPassengerAwardPoints);
          summary += ` | ${days.length} dia(s) com prêmio`;
          if (points.length) summary += `, de ${Math.min(...points)} a ${Math.max(...points)}`;
        }
      } catch {
        summary += " | corpo não é JSON";
      }
      console.log(`${probe.label}\n   ${summary}`);
      if (response.text.length < 700) console.log(`   corpo: ${response.text}`);
      await page.waitForTimeout(6000);
    }
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
