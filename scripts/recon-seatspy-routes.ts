// Answers "does SeatSpy know this route before searching?" without spending a
// credit: logs in, fills the form like the scraper and never clicks search.
// Usage: npx tsx scripts/recon-seatspy-routes.ts AF GRU MAD [outDir] (default: the system temp dir)
// ROUTE_MAP=1 also saves every origin the airline offers, with its destinations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSeatspySession } from "../src/scrapers/seatspy/seatspy.scraper.ts";

const [airline = "AF", origin = "GRU", destination = "MAD", outDir = os.tmpdir()] = process.argv.slice(2);

type TomSelectElement = HTMLSelectElement & {
  tomselect?: { options: Record<string, Record<string, unknown>>; setValue: (value: string) => void };
};

const session = await startSeatspySession(true);
const { page } = session;
// URLs and statuses only: one of these responses is the account's search history.
const requests: { url: string; status: number }[] = [];
page.on("response", (response) => {
  const type = response.request().resourceType();
  if (type === "xhr" || type === "fetch") requests.push({ url: response.url(), status: response.status() });
});

const options = (fieldId: string) =>
  page.evaluate((id) => {
    const select = document.querySelector(`#${id}`) as TomSelectElement | null;
    return select?.tomselect ? Object.entries(select.tomselect.options) : null;
  }, fieldId);
const settle = () => page.waitForTimeout(Number(process.env.SETTLE_MS ?? 3000));

try {
  await page.goto("https://www.seatspy.com/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(document.querySelector("#airline") as TomSelectElement | null)?.tomselect);
  await settle();
  const beforeAirline = { outbound: await options("outbound"), inbound: await options("inbound") };

  await page.evaluate((code) => (document.querySelector("#airline") as TomSelectElement).tomselect!.setValue(code), airline);
  await settle();
  const outboundOptions = await options("outbound");
  if (process.env.ROUTE_MAP) {
    const map = await page.evaluate(() => {
      const select = document.querySelector("#outbound") as TomSelectElement;
      return Object.entries(select.tomselect!.options).map(([key, option]) => {
        const { $div: _div, $option: _option, ...plain } = option as Record<string, unknown>;
        return [key, plain];
      });
    });
    fs.writeFileSync(path.join(outDir, `seatspy-route-map-${airline}.json`), JSON.stringify(map, null, 2));
  }
  const originEntry = outboundOptions?.find(([, option]) => option.iata === origin || String(option.iatas ?? "").split(/[\s,]+/).includes(origin));

  let afterOrigin = null;
  if (originEntry) {
    await page.evaluate((key) => (document.querySelector("#outbound") as TomSelectElement).tomselect!.setValue(key), originEntry[0]);
    await settle();
    afterOrigin = await options("inbound");
  }
  const destinationEntry = afterOrigin?.find(
    ([, option]) => option.iata === destination || String(option.iatas ?? "").split(/[\s,]+/).includes(destination),
  );

  const result = {
    airline,
    origin,
    destination,
    counts: {
      outboundBeforeAirline: beforeAirline.outbound?.length ?? null,
      inboundBeforeAirline: beforeAirline.inbound?.length ?? null,
      outboundAfterAirline: outboundOptions?.length ?? null,
      inboundAfterOrigin: afterOrigin?.length ?? null,
    },
    originEntry,
    destinationEntry: destinationEntry ?? null,
    inboundSample: afterOrigin?.slice(0, 5) ?? null,
    requests,
  };
  const file = path.join(outDir, `seatspy-routes-${airline}-${origin}-${destination}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.counts), "origin:", !!originEntry, "destination:", !!destinationEntry, "→", file);
} finally {
  await session.browser.close();
}
