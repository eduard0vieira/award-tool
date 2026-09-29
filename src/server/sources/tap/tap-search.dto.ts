import { OptionalCeilingField, OptionalNestedField, RouteRequestDto } from "../../search/request-fields.ts";

export class TapCeilingsDto {
  @OptionalCeilingField("ceilings.business")
  business?: number | null;

  @OptionalCeilingField("ceilings.economy")
  economy?: number | null;
}

export class TapSearchDto extends RouteRequestDto {
  @OptionalNestedField("ceilings", () => TapCeilingsDto)
  ceilings?: TapCeilingsDto;
}
