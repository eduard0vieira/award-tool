import { IsIn, IsOptional } from "class-validator";
import { AA_CABIN_LABELS, AA_MAX_PASSENGERS, type AaCabin } from "../../../scrapers/aa/aa.scraper.ts";
import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";

const CABINS = Object.keys(AA_CABIN_LABELS);

export class AaSearchDto extends RouteRequestDto {
  @IsIn(CABINS, { message: `cabin deve ser uma destas para buscas na AA: ${CABINS.join(", ")}.` })
  cabin!: AaCabin;

  @IsOptional()
  @IsIn([0, 1], { message: "O campo maxStops deve ser 0, 1 ou vazio." })
  maxStops?: 0 | 1 | null;

  @OptionalCeilingField("ceiling")
  ceiling?: number | null;

  @OptionalIntField("passengers", 1, AA_MAX_PASSENGERS)
  passengers?: number;
}
