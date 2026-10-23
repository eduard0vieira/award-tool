import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { formatDatesByMonth } from "../../../core/common.ts";
import { ALERTS_DIR } from "../../../core/paths.ts";
import {
  confirmPairInMiles,
  LatamFlowError,
  type LatamCabin,
  type PairConfirmation,
  type PairToConfirm,
} from "../../../scrapers/latam/latam.scraper.ts";
import type { JobCallbacks } from "../../jobs/job.types.ts";

const PAIR_ATTEMPTS = 2;

export type DatePairToConfirm = { outbound: string; return: string };

export type PairListResult = {
  confirmed: PairConfirmation[];
  // The site answered, with no flight in miles that day: availability, not failure.
  withoutOffer: string[];
  failed: string[];
};

// Confirms each pair in miles, one after the other, with LATAM's screen
// captured for every pair that comes back. One failing pair never drops the others.
export async function confirmPairList(
  jobId: string,
  page: Page,
  job: JobCallbacks,
  route: { origin: string; destination: string; cabin: LatamCabin },
  pairs: DatePairToConfirm[],
): Promise<PairListResult> {
  const folder = `latam-${route.origin}-${route.destination}-${Date.now()}`;
  fs.mkdirSync(path.join(ALERTS_DIR, folder), { recursive: true });

  const result: PairListResult = { confirmed: [], withoutOffer: [], failed: [] };
  for (const [index, pair] of pairs.entries()) {
    job.notice(`Confirmando par ${index + 1}/${pairs.length}. ${pair.outbound} → ${pair.return}...`);
    const file = `par-${index + 1}.png`;
    try {
      const offer = await confirmWithRetry(page, job, {
        origin: route.origin,
        destination: route.destination,
        outboundDate: pair.outbound,
        returnDate: pair.return,
        screenshotPath: path.join(ALERTS_DIR, folder, file),
        cabin: route.cabin,
      });
      if (offer) {
        result.confirmed.push({
          ...offer,
          image: offer.image ? `/alerts/${folder}/${file}` : "",
          outboundText: formatDatesByMonth([offer.outboundDate]),
          returnText: formatDatesByMonth([offer.returnDate]),
        });
      } else {
        result.withoutOffer.push(`${pair.outbound} → ${pair.return}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[${jobId}] par ${pair.outbound}→${pair.return} falhou: ${reason}`);
      result.failed.push(`${pair.outbound} → ${pair.return}: ${reason}`);
    }
  }
  job.notice("");
  return result;
}

// Only a step the site did not complete is tried again; a login or format
// error would fail the same way twice.
async function confirmWithRetry(page: Page, job: JobCallbacks, pair: PairToConfirm): Promise<PairConfirmation | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      // A login prompt becomes a notice: it is the only way the user learns
      // the search is waiting for them in the bot's window.
      return await confirmPairInMiles(page, pair, job.log, job.notice);
    } catch (err) {
      if (!(err instanceof LatamFlowError) || attempt >= PAIR_ATTEMPTS) throw err;
      job.log(`Par ${pair.outboundDate} → ${pair.returnDate} falhou (${err.message}). Tentando de novo.`);
    }
  }
}
