import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Credentials } from "./config.ts";

function safeEqual(given: string, expected: string): boolean {
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function basicAuth({ user, pass }: Credentials) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const [givenUser = "", givenPass = ""] = Buffer.from(header.slice(6), "base64").toString().split(":");
      // Both comparisons run before deciding, so timing never reveals which one failed.
      const userOk = safeEqual(givenUser, user);
      const passOk = safeEqual(givenPass, pass);
      if (userOk && passOk) {
        next();
        return;
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Bot de Emissoes"');
    res.status(401).send("Autenticação necessária.");
  };
}
