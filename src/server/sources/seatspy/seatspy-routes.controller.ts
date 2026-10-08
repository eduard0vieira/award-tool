import { Controller, Get, Param } from "@nestjs/common";
import { IsIn } from "class-validator";
import { AIRLINE_NAMES, type SeatspyAirline } from "../../../scrapers/seatspy/seatspy.scraper.ts";
import { SeatspyRoutes } from "./seatspy-routes.service.ts";

const AIRLINES = Object.keys(AIRLINE_NAMES);

export class SeatspyRoutesParamsDto {
  @IsIn(AIRLINES, { message: `O programa deve ser um destes: ${AIRLINES.join(", ")}.` })
  airline!: SeatspyAirline;
}

@Controller("api/seatspy/routes")
export class SeatspyRoutesController {
  constructor(private readonly routes: SeatspyRoutes) {}

  @Get(":airline")
  get(@Param() params: SeatspyRoutesParamsDto) {
    return this.routes.get(params.airline);
  }
}
