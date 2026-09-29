import {
  OptionalBooleanField,
  OptionalCeilingField,
  OptionalNestedField,
  RouteRequestDto,
} from "../../search/request-fields.ts";

export class LatamCeilingsDto {
  @OptionalCeilingField("tetos.reais")
  reais?: number | null;

  @OptionalBooleanField("tetos.somenteMenorTarifa")
  somenteMenorTarifa?: boolean;
}

export class LatamSearchDto extends RouteRequestDto {
  @OptionalNestedField("tetos", () => LatamCeilingsDto)
  tetos?: LatamCeilingsDto;

  @OptionalBooleanField("confirmarMilhas")
  confirmarMilhas?: boolean;

  @OptionalCeilingField("margemIdaReais")
  margemIdaReais?: number | null;

  @OptionalCeilingField("margemVoltaReais")
  margemVoltaReais?: number | null;
}
