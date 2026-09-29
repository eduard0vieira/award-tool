import { Module } from "@nestjs/common";
import { iniciarSessaoSmiles, type SessaoSmiles } from "../../../fontes/smiles/bot-smiles.ts";
import { fecharSessaoChrome, sessaoViva } from "../../../nucleo/sessao-chrome.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.ts";
import { SMILES_POOL, SmilesSource } from "./smiles.source.ts";

@Module({
  imports: [JobsModule],
  providers: [
    // No login, but each year sweep is ~112 requests from inside the browser.
    sessionPoolProvider<SessaoSmiles>(SMILES_POOL, {
      rotulo: "smiles",
      tamanho: config.concurrency.smiles,
      criarSessao: (headless) => iniciarSessaoSmiles(headless),
      sessaoViva,
      fecharSessao: fecharSessaoChrome,
    }),
    SmilesSource,
  ],
  exports: [SmilesSource],
})
export class SmilesModule {}
