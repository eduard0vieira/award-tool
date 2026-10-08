import { Controller, Get, Param, Query } from "@nestjs/common";
import { HistoryQueryDto } from "./history-query.dto.ts";
import { SearchHistory } from "./search-history.service.ts";

@Controller("api/history")
export class HistoryController {
  constructor(private readonly history: SearchHistory) {}

  @Get()
  list(@Query() query: HistoryQueryDto) {
    return this.history.list(query.limit ?? 50, query.before ? new Date(query.before) : undefined);
  }

  @Get("groups/:groupId")
  getGroup(@Param("groupId") groupId: string) {
    return this.history.getGroup(groupId);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.history.get(id);
  }
}
