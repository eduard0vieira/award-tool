import { OptionalCeilingField, OptionalNestedField, RouteRequestDto } from "../../search/request-fields.ts";

export class TapCeilingsDto {
  @OptionalCeilingField("tetos.executiva")
  executiva?: number | null;

  @OptionalCeilingField("tetos.economica")
  economica?: number | null;
}

export class TapSearchDto extends RouteRequestDto {
  @OptionalNestedField("tetos", () => TapCeilingsDto)
  tetos?: TapCeilingsDto;
}
