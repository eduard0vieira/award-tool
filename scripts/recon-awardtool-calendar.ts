// Saves AwardTool's route calendar (a year of stored availability for one route,
// every program) as the site's own page receives it, and prints what it holds
// for TAP. Usage: npx tsx scripts/recon-awardtool-calendar.ts GRU-LIS [outDir] (default: the system temp dir)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { startTapSession } from "../src/scrapers/tap/tap.scraper.ts";

const [route = "GRU-LIS", outDir = os.tmpdir()] = process.argv.slice(2);

type CalendarRow = { date: string; program: string; points: { ls: number } };

const session = await startTapSession(true);
try {
  const { page, baseUrl } = session;
  // Only this response is kept: user_info, on the same API, carries the account's e-mail.
  const calendar = page.waitForResponse((response) => response.url().endsWith("/routes_calendar_v2"), { timeout: 45000 });
  await page.goto(`${baseUrl}/route-detail?route=${route}`);
  const raw = await (await calendar).text();
  const file = path.join(outDir, `awardtool-route-calendar-${route}.json`);
  fs.writeFileSync(file, raw);

  const body = JSON.parse(inflateSync(Buffer.from(JSON.parse(raw).ciphered_data, "base64")).toString());
  const tap = (body.data as CalendarRow[]).filter((row) => row.program === "TP").sort((a, b) => a.date.localeCompare(b.date));
  const ages = tap.map((row) => (Date.now() / 1000 - row.points.ls) / 86400).sort((a, b) => a - b);
  console.log(`saved ${file}`);
  console.log(
    `${route}: ${body.data.length} rows, ${tap.length} TAP dates (${tap[0]?.date ?? "-"} to ${tap.at(-1)?.date ?? "-"}), ` +
      `last seen median ${ages[Math.floor(ages.length / 2)]?.toFixed(1) ?? "-"} days, oldest ${ages.at(-1)?.toFixed(1) ?? "-"} days`,
  );
} finally {
  await session.browser.close();
}
