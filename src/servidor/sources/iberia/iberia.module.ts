import { Module } from "@nestjs/common";
import { startIberiaSession, type IberiaSession } from "../../../scrapers/iberia/iberia.scraper.ts";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { IBERIA_POOL, IberiaSource } from "./iberia.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<IberiaSession>(IBERIA_POOL, {
      label: "iberia",
      size: config.concurrency.iberia,
      createSession: (headless) => startIberiaSession(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    IberiaSource,
  ],
  exports: [IberiaSource],
})
export class IberiaModule {}
