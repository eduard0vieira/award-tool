import { Module } from "@nestjs/common";
import { startLatamSession, type LatamSession } from "../../../scrapers/latam/latam.scraper.ts";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.provider.ts";
import { LATAM_POOL, LatamSource } from "./latam.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<LatamSession>(LATAM_POOL, {
      label: "latam",
      size: config.concurrency.latam,
      createSession: (headless) => startLatamSession(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    LatamSource,
  ],
  exports: [LatamSource],
})
export class LatamModule {}
