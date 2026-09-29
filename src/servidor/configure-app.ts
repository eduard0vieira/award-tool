import type { NestExpressApplication } from "@nestjs/platform-express";
import { PUBLIC_DIR } from "../core/paths.ts";
import { DIR_ALERTAS, PORTAL_DIST_DIR } from "../saidas/alertas.ts";
import { basicAuth } from "./basic-auth.ts";
import type { Credentials } from "./config.ts";
import { HttpErrorFilter } from "./http-error.filter.ts";
import { createValidationPipe } from "./validation.ts";

export function configureApp(app: NestExpressApplication, credentials: Credentials | null) {
  // Registered through app.use so it runs before the static assets. Nest
  // middleware (MiddlewareConsumer) runs after them and would leave /, /portal
  // and /alertas open to anyone who finds the tunnel URL.
  if (credentials) app.use(basicAuth(credentials));

  app.useStaticAssets(PUBLIC_DIR);
  app.useStaticAssets(PORTAL_DIST_DIR, { prefix: "/portal" });
  app.useStaticAssets(DIR_ALERTAS, { prefix: "/alertas" });
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalPipes(createValidationPipe());
}
