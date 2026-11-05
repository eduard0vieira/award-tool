import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";
import { AA_MAX_PASSENGERS } from "../../../scrapers/aa/aa.scraper.ts";

// About 16 days fit in one session before Iberia cuts the detail (docs/recon/iberia.md §17).
export const IBERIA_MAX_DETAIL_DAYS = 16;

export class IberiaSearchDto extends RouteRequestDto {
  @OptionalCeilingField("ceiling")
  ceiling?: number | null;

  @OptionalIntField("passengers", 1, AA_MAX_PASSENGERS)
  passengers?: number;

  @OptionalIntField("detailDays", 0, IBERIA_MAX_DETAIL_DAYS)
  detailDays?: number;
}
