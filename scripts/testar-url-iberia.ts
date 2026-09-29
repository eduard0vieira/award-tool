import fs from "node:fs";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { linkEmissaoIberia } from "../src/fontes/iberia/bot-iberia.ts";

// Diagnóstico de uma pergunta só: a tela de erro da Iberia ('não podemos
// mostrar os voos') vem de corte por frequência ou da URL que a fonte monta?
// Abre as duas — a que o site gerou e a nossa — na mesma sessão e compara.
//
// Uso: npx tsx scripts/testar-url-iberia.ts <arquivo-com-a-url-do-site>

async function main() {
  const arquivo = process.argv[2];
  if (!arquivo) {
    console.error("Passe o arquivo com a URL capturada do site.");
    process.exit(1);
  }
  const urlDoSite = fs.readFileSync(arquivo, "utf8").trim();
  const urlDaFonte = linkEmissaoIberia({ origem: "GRU", destino: "MAD", passageiros: 1 }, "2026-12-15");

  const sessao = await openChromeSession(false, "teste-url");
  try {
    for (const [nome, url] of [
      ["URL DO SITE ", urlDoSite],
      ["URL DA FONTE", urlDaFonte],
    ] as const) {
      await sessao.page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
        .catch((erro: Error) => console.log(`  goto falhou: ${erro.message.slice(0, 70)}`));
      await sessao.page.waitForTimeout(12_000);
      const final = sessao.page.url();
      const veredito = /ibbkerror/.test(final)
        ? "❌ tela de erro"
        : /#!\/availability/.test(final)
          ? "✅ chegou aos resultados"
          : `? terminou em ...${final.slice(-45)}`;
      console.log(`${nome}: ${veredito}`);
      await sessao.page.waitForTimeout(6000);
    }
  } finally {
    await sessao.page.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  },
);
