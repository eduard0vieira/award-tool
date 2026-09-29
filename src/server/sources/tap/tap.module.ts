import { Module } from "@nestjs/common";
import { startTapSession, type TapSession } from "../../../scrapers/tap/tap.scraper.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.provider.ts";
import { TAP_POOL, TapSource } from "./tap.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<TapSession>(TAP_POOL, {
      label: "awardtool",
      size: config.concurrency.awardtool,
      createSession: (headless) => startTapSession(headless),
      isAlive: (session) => session.browser.isConnected() && !session.page.isClosed(),
      closeSession: (session) => session.browser.close(),
    }),
    TapSource,
  ],
  exports: [TapSource],
})
export class TapModule {}
