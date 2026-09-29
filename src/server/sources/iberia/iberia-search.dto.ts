import { IsArray, IsIn, IsOptional, IsString } from "class-validator";
import { AA_MAX_PASSENGERS } from "../../../scrapers/aa/aa.scraper.ts";
import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";

export class IberiaSearchDto extends RouteRequestDto {
  @OptionalCeilingField("ceiling")
  ceiling?: number | null;

  @OptionalIntField("passengers", 1, AA_MAX_PASSENGERS)
  passengers?: number;

  // -1 details every date, the old bot's mode: ~15s per date, can pass an hour.
  @OptionalIntField("detailDays", -1, 40)
  detailDays?: number;

  @IsOptional()
  @IsIn([0, 1, 2], { message: "O campo maxStops deve ser 0, 1, 2 ou vazio." })
  maxStops?: 0 | 1 | 2 | null;

  @IsOptional()
  @IsArray({ message: "O campo cabins deve ser uma lista." })
  @IsString({ each: true, message: "Cada item de cabins deve ser texto." })
  cabins?: string[];
}
