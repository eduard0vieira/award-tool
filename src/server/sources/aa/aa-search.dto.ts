import { IsIn, IsOptional } from "class-validator";
import { AA_CABIN_LABELS, AA_MAX_PASSENGERS, type AaCabin } from "../../../scrapers/aa/aa.scraper.ts";
import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";

const CABINS = Object.keys(AA_CABIN_LABELS);

export class AaSearchDto extends RouteRequestDto {
  @IsIn(CABINS, { message: `cabine deve ser uma destas para buscas na AA: ${CABINS.join(", ")}.` })
  cabine!: AaCabin;

  @IsOptional()
  @IsIn([0, 1], { message: "O campo maxConexoes deve ser 0, 1 ou vazio." })
  maxConexoes?: 0 | 1 | null;

  @OptionalCeilingField("teto")
  teto?: number | null;

  @OptionalIntField("passageiros", 1, AA_MAX_PASSENGERS)
  passageiros?: number;
}
