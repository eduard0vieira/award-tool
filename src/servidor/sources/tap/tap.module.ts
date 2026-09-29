import { Module } from "@nestjs/common";
import { iniciarSessao, type Sessao } from "../../../fontes/tap/bot-tap.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { TAP_POOL, TapSource } from "./tap.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<Sessao>(TAP_POOL, {
      label: "awardtool",
      size: config.concurrency.awardtool,
      createSession: (headless) => iniciarSessao(headless),
      isAlive: (session) => session.browser.isConnected() && !session.page.isClosed(),
      closeSession: (session) => session.browser.close(),
    }),
    TapSource,
  ],
  exports: [TapSource],
})
export class TapModule {}
