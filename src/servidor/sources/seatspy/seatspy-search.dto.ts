import { IsIn } from "class-validator";
import { NOME_COMPANHIA, type CompanhiaSeatspy } from "../../../fontes/seatspy/bot-seatspy.ts";
import {
  OptionalBooleanField,
  OptionalCeilingField,
  OptionalNestedField,
  RouteRequestDto,
} from "../../search/request-fields.ts";

const AIRLINES = Object.keys(NOME_COMPANHIA);

export class SeatspyCeilingsDto {
  @OptionalCeilingField("tetos.economica")
  economica?: number | null;

  @OptionalCeilingField("tetos.premium")
  premium?: number | null;

  @OptionalCeilingField("tetos.executiva")
  executiva?: number | null;

  @OptionalCeilingField("tetos.primeira")
  primeira?: number | null;
}

export class SeatspySearchDto extends RouteRequestDto {
  @IsIn(AIRLINES, { message: `companhia deve ser uma destas para buscas no SeatSpy: ${AIRLINES.join(", ")}.` })
  companhia!: CompanhiaSeatspy;

  @OptionalBooleanField("idaEVolta")
  idaEVolta?: boolean;

  @OptionalBooleanField("mostrarAssentos")
  mostrarAssentos?: boolean;

  @OptionalNestedField("tetos", () => SeatspyCeilingsDto)
  tetos?: SeatspyCeilingsDto;
}
