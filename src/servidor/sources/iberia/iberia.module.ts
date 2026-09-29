import { Module } from "@nestjs/common";
import { iniciarSessaoIberia, type SessaoIberia } from "../../../fontes/iberia/bot-iberia.ts";
import { fecharSessaoChrome, sessaoViva } from "../../../nucleo/sessao-chrome.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { IBERIA_POOL, IberiaSource } from "./iberia.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    sessionPoolProvider<SessaoIberia>(IBERIA_POOL, {
      rotulo: "iberia",
      tamanho: config.concurrency.iberia,
      criarSessao: (headless) => iniciarSessaoIberia(headless),
      sessaoViva,
      fecharSessao: fecharSessaoChrome,
    }),
    IberiaSource,
  ],
  exports: [IberiaSource],
})
export class IberiaModule {}
