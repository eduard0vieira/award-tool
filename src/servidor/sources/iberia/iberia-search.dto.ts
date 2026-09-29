import { IsArray, IsIn, IsOptional, IsString } from "class-validator";
import { MAX_PASSAGEIROS_AA } from "../../../fontes/aa/bot-aa.ts";
import { OptionalCeilingField, OptionalIntField, RouteRequestDto } from "../../search/request-fields.ts";

export class IberiaSearchDto extends RouteRequestDto {
  @OptionalCeilingField("teto")
  teto?: number | null;

  @OptionalIntField("passageiros", 1, MAX_PASSAGEIROS_AA)
  passageiros?: number;

  // -1 details every date, the old bot's mode: ~15s per date, can pass an hour.
  @OptionalIntField("detalharDias", -1, 40)
  detalharDias?: number;

  @IsOptional()
  @IsIn([0, 1, 2], { message: "O campo maxConexoes deve ser 0, 1, 2 ou vazio." })
  maxConexoes?: 0 | 1 | 2 | null;

  @IsOptional()
  @IsArray({ message: "O campo cabines deve ser uma lista." })
  @IsString({ each: true, message: "Cada item de cabines deve ser texto." })
  cabines?: string[];
}
