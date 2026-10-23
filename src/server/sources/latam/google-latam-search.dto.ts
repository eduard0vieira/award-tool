import { IsIn, IsOptional } from "class-validator";
import { OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";

// The cheapest LATAM round trips on Google Flights, confirmed in miles on LATAM's site.
export class GoogleLatamSearchDto extends RouteRequestDto {
  @IsOptional()
  @IsIn(["Economy", "Business"], { message: "O campo cabin deve ser Economy ou Business." })
  cabin?: "Economy" | "Business";

  // Google's calendar only takes one trip length per call.
  @OptionalIntField("stayDays", 3, 30)
  stayDays?: number;
}
