import { IsOptional, Matches } from "class-validator";
import { OptionalCeilingField, OptionalNestedField, RouteRequestDto } from "../../search/request-fields.ts";

const MONTH_OR_DATE = /^\d{4}-\d{2}(-\d{2})?$/;

export class SmilesCeilingsDto {
  @OptionalCeilingField("ceilings.economy")
  economy?: number | null;

  @OptionalCeilingField("ceilings.premium")
  premium?: number | null;

  @OptionalCeilingField("ceilings.business")
  business?: number | null;
}

export class SmilesPeriodDto {
  @IsOptional()
  @Matches(MONTH_OR_DATE, { message: "O campo period.from deve ser um mês (AAAA-MM) ou uma data (AAAA-MM-DD)." })
  from?: string;

  @IsOptional()
  @Matches(MONTH_OR_DATE, { message: "O campo period.until deve ser um mês (AAAA-MM) ou uma data (AAAA-MM-DD)." })
  until?: string;
}

export class SmilesSearchDto extends RouteRequestDto {
  @OptionalNestedField("ceilings", () => SmilesCeilingsDto)
  ceilings?: SmilesCeilingsDto;

  @OptionalNestedField("period", () => SmilesPeriodDto)
  period?: SmilesPeriodDto;
}
