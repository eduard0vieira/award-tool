import { IsIn } from "class-validator";
import { AIRLINE_NAMES, type SeatspyAirline } from "../../../scrapers/seatspy/seatspy.scraper.ts";
import {
  OptionalBooleanField,
  OptionalCeilingField,
  OptionalNestedField,
  RouteRequestDto,
} from "../../search/request-fields.ts";

const AIRLINES = Object.keys(AIRLINE_NAMES);

export class SeatspyCeilingsDto {
  @OptionalCeilingField("ceilings.economy")
  economy?: number | null;

  @OptionalCeilingField("ceilings.premium")
  premium?: number | null;

  @OptionalCeilingField("ceilings.business")
  business?: number | null;

  @OptionalCeilingField("ceilings.first")
  first?: number | null;
}

export class SeatspySearchDto extends RouteRequestDto {
  @IsIn(AIRLINES, { message: `airline deve ser uma destas para buscas no SeatSpy: ${AIRLINES.join(", ")}.` })
  airline!: SeatspyAirline;

  @OptionalBooleanField("roundTrip")
  roundTrip?: boolean;

  @OptionalBooleanField("showSeats")
  showSeats?: boolean;

  @OptionalNestedField("ceilings", () => SeatspyCeilingsDto)
  ceilings?: SeatspyCeilingsDto;
}
