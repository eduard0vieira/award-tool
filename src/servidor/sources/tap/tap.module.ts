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
      rotulo: "awardtool",
      tamanho: config.concurrency.awardtool,
      criarSessao: (headless) => iniciarSessao(headless),
      sessaoViva: (session) => session.browser.isConnected() && !session.page.isClosed(),
      fecharSessao: (session) => session.browser.close(),
    }),
    TapSource,
  ],
  exports: [TapSource],
})
export class TapModule {}
