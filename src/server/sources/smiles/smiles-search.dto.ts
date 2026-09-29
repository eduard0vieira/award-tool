import { IsOptional, Matches } from "class-validator";
import { OptionalCeilingField, OptionalNestedField, RouteRequestDto } from "../../search/request-fields.ts";

const MONTH_OR_DATE = /^\d{4}-\d{2}(-\d{2})?$/;

export class SmilesCeilingsDto {
  @OptionalCeilingField("tetos.economica")
  economica?: number | null;

  @OptionalCeilingField("tetos.premium")
  premium?: number | null;

  @OptionalCeilingField("tetos.executiva")
  executiva?: number | null;
}

export class SmilesPeriodDto {
  @IsOptional()
  @Matches(MONTH_OR_DATE, { message: "O campo periodo.de deve ser um mês (AAAA-MM) ou uma data (AAAA-MM-DD)." })
  de?: string;

  @IsOptional()
  @Matches(MONTH_OR_DATE, { message: "O campo periodo.ate deve ser um mês (AAAA-MM) ou uma data (AAAA-MM-DD)." })
  ate?: string;
}

export class SmilesSearchDto extends RouteRequestDto {
  @OptionalNestedField("tetos", () => SmilesCeilingsDto)
  tetos?: SmilesCeilingsDto;

  @OptionalNestedField("periodo", () => SmilesPeriodDto)
  periodo?: SmilesPeriodDto;
}
