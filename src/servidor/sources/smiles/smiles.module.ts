import { Module } from "@nestjs/common";
import { iniciarSessaoSmiles, type SessaoSmiles } from "../../../fontes/smiles/bot-smiles.ts";
import { closeChromeSession, isSessionAlive } from "../../../core/chrome-session.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { SMILES_POOL, SmilesSource } from "./smiles.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    // No login, but each year sweep is ~112 requests from inside the browser.
    sessionPoolProvider<SessaoSmiles>(SMILES_POOL, {
      label: "smiles",
      size: config.concurrency.smiles,
      createSession: (headless) => iniciarSessaoSmiles(headless),
      isAlive: isSessionAlive,
      closeSession: closeChromeSession,
    }),
    SmilesSource,
  ],
  exports: [SmilesSource],
})
export class SmilesModule {}
