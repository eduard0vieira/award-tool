import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { SearchService } from "./search.service.ts";

@Controller("api/searches")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  // Validated by the chosen source's own DTO, which depends on `source`.
  @Post()
  @HttpCode(200)
  async start(@Body() body: Record<string, unknown> | undefined) {
    return { jobId: await this.search.start(body) };
  }
}
