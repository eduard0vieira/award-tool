import { IsIn, IsOptional } from "class-validator";
import { CABINE_AA_LABEL, MAX_PASSAGEIROS_AA, type CabineAA } from "../../../fontes/aa/bot-aa.ts";
import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";

const CABINS = Object.keys(CABINE_AA_LABEL);

export class AaSearchDto extends RouteRequestDto {
  @IsIn(CABINS, { message: `cabine deve ser uma destas para buscas na AA: ${CABINS.join(", ")}.` })
  cabine!: CabineAA;

  @IsOptional()
  @IsIn([0, 1], { message: "O campo maxConexoes deve ser 0, 1 ou vazio." })
  maxConexoes?: 0 | 1 | null;

  @OptionalCeilingField("teto")
  teto?: number | null;

  @OptionalIntField("passageiros", 1, MAX_PASSAGEIROS_AA)
  passageiros?: number;
}
