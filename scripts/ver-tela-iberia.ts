import "dotenv/config";
import { abrirSessaoChrome } from "../src/nucleo/sessao-chrome.ts";
import { linkEmissaoIberia } from "../src/fontes/iberia/bot-iberia.ts";
import { DIR_FIXTURES } from "../src/nucleo/caminhos.ts";
import path from "node:path";

// Abre o deep link da busca e fotografa onde a aba para. Existe porque a fonte
// vem sendo mandada pra uma tela de reautorização do login.iberia.com no meio
// da varredura, e é preciso ver o que ela pede antes de decidir o que fazer.

async function main() {
  const sessao = await abrirSessaoChrome(false, "ver-tela");
  const url = linkEmissaoIberia({ origem: "GRU", destino: "MAD", passageiros: 1 }, "2026-12-15");

  await sessao.page
    .goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    .catch((erro: Error) => console.log(`goto: ${erro.message.slice(0, 60)}`));
  await sessao.page.waitForTimeout(20_000);

  console.log(`URL final: ${sessao.page.url()}`);
  console.log(`Título: ${await sessao.page.title()}`);
  const texto = (await sessao.page.evaluate("document.body ? document.body.innerText : ''")) as string;
  console.log(`\nTexto da tela:\n${texto.replace(/\n{2,}/g, "\n").slice(0, 1200)}`);

  const foto = path.join(DIR_FIXTURES, "iberia-tela-atual.png");
  await sessao.page.screenshot({ path: foto, fullPage: false }).catch(() => {});
  console.log(`\nFoto: ${foto}`);
  await sessao.page.close().catch(() => {});
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  },
);
