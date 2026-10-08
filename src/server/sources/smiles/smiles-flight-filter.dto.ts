import { ArrayMaxSize, IsArray, IsOptional, Matches } from "class-validator";
import { OptionalCeilingField, OptionalIntField, OptionalNestedField } from "../../search/request-fields.ts";

export class MilesRangeDto {
  @OptionalCeilingField("min")
  min?: number;

  @OptionalCeilingField("max")
  max?: number;
}

export class SmilesFlightMilesDto {
  @OptionalNestedField("economy", () => MilesRangeDto)
  economy?: MilesRangeDto;

  @OptionalNestedField("premium", () => MilesRangeDto)
  premium?: MilesRangeDto;

  @OptionalNestedField("business", () => MilesRangeDto)
  business?: MilesRangeDto;
}

export class SmilesFlightFilterDto {
  @IsOptional()
  @IsArray({ message: "O campo carriers deve ser uma lista de códigos de companhia." })
  @ArrayMaxSize(50, { message: "O campo carriers aceita no máximo 50 companhias." })
  @Matches(/^[A-Z0-9]{2,3}$/, { each: true, message: "Cada companhia em carriers deve ser um código como AA ou G3." })
  carriers?: string[];

  @OptionalIntField("maxStops", 0, 5)
  maxStops?: number;

  @OptionalNestedField("miles", () => SmilesFlightMilesDto)
  miles?: SmilesFlightMilesDto;
}
