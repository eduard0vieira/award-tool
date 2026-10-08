import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { filterSmilesFlights, type StoredSmilesDay } from "../../../scrapers/smiles/smiles-flights.ts";
import { PrismaService } from "../../db/prisma.service.ts";
import { SmilesFlightFilterDto } from "./smiles-flight-filter.dto.ts";

@Controller("api/smiles/flights")
export class SmilesFlightsController {
  constructor(private readonly prisma: PrismaService) {}

  // By the search's history id: the card's leg, a reused result's original or a
  // leg opened from the Histórico all point at the row that holds the flights.
  @Post(":searchId/filter")
  @HttpCode(200)
  async filter(@Param("searchId") searchId: string, @Body() filter: SmilesFlightFilterDto) {
    const row = await this.prisma.search.findUnique({ where: { id: searchId }, select: { source: true, flights: true } });
    if (!row) throw new NotFoundException("Busca não encontrada no histórico.");
    if (row.source !== "smiles") throw new BadRequestException("O filtro de voos só existe para buscas da Smiles.");
    if (row.flights === null) {
      throw new NotFoundException(
        "Os voos dessa busca não foram guardados: ela é de antes do filtro ou tem mais de 30 dias. Busque de novo para filtrar.",
      );
    }
    return filterSmilesFlights(JSON.parse(row.flights) as StoredSmilesDay[], filter);
  }
}
