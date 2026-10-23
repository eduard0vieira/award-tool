import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, Matches } from "class-validator";
import { RouteRequestDto } from "../../search/request-fields.ts";

const DATE_MESSAGE = (field: string) => `Cada data em ${field} deve estar no formato AAAA-MM-DD.`;

// Outbound and return dates picked by hand (from Google Flights, say). The bot
// draws the round-trip pairs from them the way it does for the calendar, and
// confirms each one in miles, in economy or in LATAM's business.
export class LatamPairsSearchDto extends RouteRequestDto {
  @IsIn(["Economy", "Business"], { message: "O campo cabin deve ser Economy ou Business." })
  cabin!: "Economy" | "Business";

  @IsArray({ message: "O campo outboundDates deve ser uma lista de datas." })
  @ArrayMinSize(1, { message: "Informe pelo menos uma data de ida." })
  @ArrayMaxSize(120, { message: "Informe no máximo 120 datas de ida." })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true, message: DATE_MESSAGE("outboundDates") })
  outboundDates!: string[];

  @IsArray({ message: "O campo returnDates deve ser uma lista de datas." })
  @ArrayMinSize(1, { message: "Informe pelo menos uma data de volta." })
  @ArrayMaxSize(120, { message: "Informe no máximo 120 datas de volta." })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true, message: DATE_MESSAGE("returnDates") })
  returnDates!: string[];
}
