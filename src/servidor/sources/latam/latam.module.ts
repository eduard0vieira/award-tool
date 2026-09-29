import { Module } from "@nestjs/common";
import { iniciarSessaoLatam, type SessaoLatam } from "../../../fontes/latam/bot-latam.ts";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { LATAM_POOL, LatamSource } from "./latam.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<SessaoLatam>(LATAM_POOL, {
      label: "latam",
      size: config.concurrency.latam,
      createSession: (headless) => iniciarSessaoLatam(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    LatamSource,
  ],
  exports: [LatamSource],
})
export class LatamModule {}
