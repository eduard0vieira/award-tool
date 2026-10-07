import type { Request } from "express";

// Who made the request: a person logged in, or a machine using the BOT_AUTH
// Basic credentials (alert renderer, supervisor). Absent when login is off.
export type Actor = { kind: "user"; id: number; username: string } | { kind: "machine" };

type RequestWithActor = Request & { actor?: Actor };

export function setActor(req: Request, actor: Actor) {
  (req as RequestWithActor).actor = actor;
}

export function actorOf(req: Request): Actor | undefined {
  return (req as RequestWithActor).actor;
}
