import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";
import { AA_MAX_PASSENGERS } from "../../../scrapers/aa/aa.scraper.ts";

// Each load of the results page details 5 days, and after a calendar only 3 loads
// fit before Iberia blocks everything for over an hour (docs/recon/iberia.md §17).
export const IBERIA_MAX_DETAIL_DAYS = 15;

export class IberiaSearchDto extends RouteRequestDto {
  @OptionalCeilingField("ceiling")
  ceiling?: number | null;

  @OptionalIntField("passengers", 1, AA_MAX_PASSENGERS)
  passengers?: number;

  @OptionalIntField("detailDays", 0, IBERIA_MAX_DETAIL_DAYS)
  detailDays?: number;
}
