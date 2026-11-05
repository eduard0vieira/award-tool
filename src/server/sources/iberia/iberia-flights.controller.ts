import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { filterSmilesFlights, type StoredSmilesDay } from "../../../scrapers/smiles/smiles-flights.ts";
import { iberiaBookingLink } from "../../../scrapers/iberia/iberia.scraper.ts";
import { PrismaService } from "../../db/prisma.service.ts";
import { SmilesFlightFilterDto } from "../smiles/smiles-flight-filter.dto.ts";

// The same filter as Smiles over the flights the detail priced. The link opens
// the search for one adult, which is what the card's dates link to as well.
@Controller("api/iberia/flights")
export class IberiaFlightsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(":searchId/filter")
  @HttpCode(200)
  async filter(@Param("searchId") searchId: string, @Body() filter: SmilesFlightFilterDto) {
    const row = await this.prisma.search.findUnique({
      where: { id: searchId },
      select: { source: true, flights: true, origin: true, destination: true },
    });
    if (!row) throw new NotFoundException("Busca não encontrada no histórico.");
    if (row.source !== "iberia") throw new BadRequestException("Esse filtro é das buscas da Iberia.");
    if (row.flights === null) {
      throw new NotFoundException(
        "Essa busca não guardou voos com preço: nenhum dia foi detalhado, os detalhados só tinham conexões " +
          "ou ela tem mais de 30 dias.",
      );
    }
    const route = { origin: row.origin, destination: row.destination, passengers: 1 };
    const result = filterSmilesFlights(JSON.parse(row.flights) as StoredSmilesDay[], filter, (date) => iberiaBookingLink(route, date));
    return {
      ...result,
      sections: result.sections.map((section) => (section.label === "Conforto" ? { ...section, label: "Premium Economy" } : section)),
    };
  }
}
