import { Module } from "@nestjs/common";
import { startAaSession, type AaSession } from "../../../scrapers/aa/aa.scraper.ts";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.provider.ts";
import { AA_POOL, AaSource } from "./aa.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    // AA, LATAM, Smiles and Iberia share one Chrome, so closing a slot closes only its tab.
    sessionPoolProvider<AaSession>(AA_POOL, {
      label: "aa",
      size: config.concurrency.aa,
      createSession: (headless) => startAaSession(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    AaSource,
  ],
  exports: [AaSource],
})
export class AaModule {}
