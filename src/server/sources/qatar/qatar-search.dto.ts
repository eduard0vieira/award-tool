import { OptionalCeilingField, RouteRequestDto } from "../../search/request-fields.ts";

export class QatarSearchDto extends RouteRequestDto {
  @OptionalCeilingField("ceiling")
  ceiling?: number | null;
}
