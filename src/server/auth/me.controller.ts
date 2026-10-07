import { Controller, Get, Req } from "@nestjs/common";
import type { Request } from "express";
import { actorOf } from "./actor.ts";

@Controller("api/me")
export class MeController {
  @Get()
  me(@Req() req: Request) {
    const actor = actorOf(req);
    return { username: actor?.kind === "user" ? actor.username : null };
  }
}
