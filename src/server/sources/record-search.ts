import type { SeatspySection } from "../../scrapers/seatspy/seatspy.scraper.ts";
import { saveSearch, type SearchToSave } from "../../outputs/spreadsheet.ts";

export type Leg = { rotulo: string; secoes: SeatspySection[] };

// Recorded here rather than in each bot because this is where every source
// already converges on the same report shape. A recording failure never fails the search.
export function recordSearch(jobId: string, search: Omit<SearchToSave, "searchId">) {
  void saveSearch({ ...search, searchId: jobId }, (message) => console.log(`[${jobId}] ${message}`));
}
