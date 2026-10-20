import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { actorOf } from "../auth/actor.ts";
import { QueueItemDto } from "./queue-item.dto.ts";
import { QueueService } from "./queue.service.ts";

@Controller("api/queue")
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  list() {
    return this.queue.list();
  }

  @Post()
  @HttpCode(200)
  add(@Body() body: QueueItemDto, @Req() req: Request) {
    return this.queue.add(body, actorOf(req));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Param("id") id: string) {
    await this.queue.cancel(id);
    return { ok: true };
  }

  @Post(":id/run-now")
  @HttpCode(200)
  async runNow(@Param("id") id: string) {
    await this.queue.runNow(id);
    return { ok: true };
  }
}
