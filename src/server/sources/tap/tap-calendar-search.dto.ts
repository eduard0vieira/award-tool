import { OptionalBooleanField, OptionalIntField, OptionalNestedField, RouteRequestDto } from "../../search/request-fields.ts";
import { TapCeilingsDto } from "./tap-search.dto.ts";

export class TapCalendarSearchDto extends RouteRequestDto {
  @OptionalNestedField("ceilings", () => TapCeilingsDto)
  ceilings?: TapCeilingsDto;

  @OptionalNestedField("floors", () => TapCeilingsDto)
  floors?: TapCeilingsDto;

  @OptionalBooleanField("nonstopOnly")
  nonstopOnly?: boolean;

  @OptionalIntField("maxAgeHours", 1, 720)
  maxAgeHours?: number;
}
