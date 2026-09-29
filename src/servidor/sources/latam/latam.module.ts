import { Module } from "@nestjs/common";
import { iniciarSessaoLatam, type SessaoLatam } from "../../../fontes/latam/bot-latam.ts";
import { fecharSessaoChrome, sessaoViva } from "../../../nucleo/sessao-chrome.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { LATAM_POOL, LatamSource } from "./latam.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<SessaoLatam>(LATAM_POOL, {
      rotulo: "latam",
      tamanho: config.concurrency.latam,
      criarSessao: (headless) => iniciarSessaoLatam(headless),
      sessaoViva,
      fecharSessao: fecharSessaoChrome,
    }),
    LatamSource,
  ],
  exports: [LatamSource],
})
export class LatamModule {}
