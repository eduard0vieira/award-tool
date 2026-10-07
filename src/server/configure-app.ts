import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import express, { type NextFunction, type Request, type Response } from "express";
import { ALERTS_DIR, PORTAL_DIST_DIR, PUBLIC_DIR } from "../core/paths.ts";
import { createAuth, loadSessionSecret } from "./auth/auth.ts";
import type { Credentials } from "./config.ts";
import { HttpErrorFilter } from "./http-error.filter.ts";
import { createValidationPipe } from "./validation.ts";

export function configureApp(
  app: NestExpressApplication,
  credentials: Credentials | null,
  sessionSecret?: Buffer,
) {
  // Registered through app.use so it runs before the static assets. Nest
  // middleware (MiddlewareConsumer) runs after them and would leave /, /portal
  // and /alerts open to anyone who finds the tunnel URL.
  if (credentials) {
    const auth = createAuth(credentials, sessionSecret ?? loadSessionSecret());
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === "GET" && req.path === "/login") res.sendFile(path.join(PUBLIC_DIR, "login.html"));
      else next();
    });
    app.use("/api/login", express.json(), (req: Request, res: Response, next: NextFunction) =>
      req.method === "POST" ? auth.login(req, res) : next(),
    );
    app.use("/api/logout", (req: Request, res: Response, next: NextFunction) =>
      req.method === "POST" ? auth.logout(req, res) : next(),
    );
    app.use(auth.guard);
  } else {
    app.use("/login", (_req: Request, res: Response) => res.redirect(302, "/"));
    app.use("/api/logout", (_req: Request, res: Response) => res.json({ ok: true }));
  }

  app.useStaticAssets(PUBLIC_DIR);
  app.useStaticAssets(PORTAL_DIST_DIR, { prefix: "/portal" });
  app.useStaticAssets(ALERTS_DIR, { prefix: "/alerts" });
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalPipes(createValidationPipe());
}
