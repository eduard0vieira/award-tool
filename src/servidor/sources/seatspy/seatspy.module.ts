import { Module } from "@nestjs/common";
import { iniciarSessaoSeatspy, type SessaoSeatspy } from "../../../fontes/seatspy/bot-seatspy.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { SEATSPY_POOL, SeatspySource } from "./seatspy.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<SessaoSeatspy>(SEATSPY_POOL, {
      rotulo: "seatspy",
      tamanho: config.concurrency.seatspy,
      criarSessao: (headless) => iniciarSessaoSeatspy(headless),
      sessaoViva: (session) => session.browser.isConnected() && !session.page.isClosed(),
      fecharSessao: (session) => session.browser.close(),
    }),
    SeatspySource,
  ],
  exports: [SeatspySource],
})
export class SeatspyModule {}
