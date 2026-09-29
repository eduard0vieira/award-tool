import {
  OptionalBooleanField,
  OptionalCeilingField,
  OptionalNestedField,
  RouteRequestDto,
} from "../../search/request-fields.ts";

export class LatamCeilingsDto {
  @OptionalCeilingField("ceilings.maxReais")
  maxReais?: number | null;

  @OptionalBooleanField("ceilings.lowestFareOnly")
  lowestFareOnly?: boolean;
}

export class LatamSearchDto extends RouteRequestDto {
  @OptionalNestedField("ceilings", () => LatamCeilingsDto)
  ceilings?: LatamCeilingsDto;

  @OptionalBooleanField("confirmMiles")
  confirmMiles?: boolean;

  @OptionalCeilingField("outboundMarginReais")
  outboundMarginReais?: number | null;

  @OptionalCeilingField("returnMarginReais")
  returnMarginReais?: number | null;
}
