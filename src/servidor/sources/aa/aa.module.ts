import { Module } from "@nestjs/common";
import { iniciarSessaoAA, type SessaoAA } from "../../../fontes/aa/bot-aa.ts";
import { fecharSessaoChrome, sessaoViva } from "../../../nucleo/sessao-chrome.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { AA_POOL, AaSource } from "./aa.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    // AA, LATAM, Smiles and Iberia share one Chrome, so closing a slot closes only its tab.
    sessionPoolProvider<SessaoAA>(AA_POOL, {
      rotulo: "aa",
      tamanho: config.concurrency.aa,
      criarSessao: (headless) => iniciarSessaoAA(headless),
      sessaoViva,
      fecharSessao: fecharSessaoChrome,
    }),
    AaSource,
  ],
  exports: [AaSource],
})
export class AaModule {}
