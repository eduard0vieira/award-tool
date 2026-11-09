import { Module } from "@nestjs/common";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { startQatarSession, type QatarSession } from "../../../scrapers/qatar/qatar.scraper.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.provider.ts";
import { QATAR_POOL, QatarSource } from "./qatar.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<QatarSession>(QATAR_POOL, {
      label: "qatar",
      size: config.concurrency.qatar,
      createSession: (headless) => startQatarSession(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    QatarSource,
  ],
  exports: [QatarSource],
})
export class QatarModule {}
