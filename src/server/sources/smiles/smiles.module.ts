import { Module } from "@nestjs/common";
import { startSmilesSession, type SmilesSession } from "../../../scrapers/smiles/smiles.scraper.ts";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.provider.ts";
import { SmilesFlightsController } from "./smiles-flights.controller.ts";
import { SMILES_POOL, SmilesSource } from "./smiles.source.ts";

@Module({
  imports: [JobsModule],
  controllers: [SmilesFlightsController],
  providers: [
    // No login, but each year sweep is ~112 requests from inside the browser.
    sessionPoolProvider<SmilesSession>(SMILES_POOL, {
      label: "smiles",
      size: config.concurrency.smiles,
      createSession: (headless) => startSmilesSession(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    SmilesSource,
  ],
  exports: [SmilesSource],
})
export class SmilesModule {}
