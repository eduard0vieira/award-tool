// Runs one Panorama window the way the bot does and saves its first 2-day
// response as the page receives it. Usage:
// npx tsx scripts/recon-awardtool-panorama.ts BR_2 EUMAJOR_1 2026-12-01 [outDir] (default: the system temp dir)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { panoramaWindows, sweepPanorama } from "../src/scrapers/tap/tap-panorama.ts";
import { startTapSession } from "../src/scrapers/tap/tap.scraper.ts";

const [from = "BR_2", to = "EUMAJOR_1", start = new Date().toISOString().slice(0, 10), outDir = os.tmpdir()] = process.argv.slice(2);

const session = await startTapSession(true);
try {
  const { page, baseUrl } = session;
  // Only this response is kept: user_info, on the same API, carries the account's e-mail.
  page.on("response", async (response) => {
    if (!response.url().endsWith("/routes_data_v2-0")) return;
    const file = path.join(outDir, `awardtool-panorama-${from}-${to}.json`);
    fs.writeFileSync(file, await response.text());
    console.log(`saved ${file}`);
  });
  const sweep = await sweepPanorama(page, baseUrl, { from, to }, panoramaWindows(start, 90), console.log);
  const routes = new Map<string, number>();
  for (const date of sweep.dates) routes.set(date.route, (routes.get(date.route) ?? 0) + 1);
  console.log(`${sweep.dates.length} TAP dates in ${routes.size} routes, ${sweep.incompleteWindows.length} incomplete window(s)`);
  console.log([...routes.entries()].sort((a, b) => b[1] - a[1]).map(([route, count]) => `${route}:${count}`).join(" "));
} finally {
  await session.browser.close();
}
