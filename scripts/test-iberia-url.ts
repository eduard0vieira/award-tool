import fs from "node:fs";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { iberiaBookingLink } from "../src/scrapers/iberia/iberia.scraper.ts";

// Answers one question: does Iberia's error screen ('não podemos mostrar os
// voos') come from rate limiting or from the URL the source builds? Opens both,
// the one the site generated and ours, on the same session and compares.
//
// Usage: npx tsx scripts/test-iberia-url.ts <file-with-the-site-url>

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Passe o arquivo com a URL capturada do site.");
    process.exit(1);
  }
  const siteUrl = fs.readFileSync(file, "utf8").trim();
  const sourceUrl = iberiaBookingLink({ origin: "GRU", destination: "MAD", passengers: 1 }, "2026-12-15");

  const session = await openChromeSession(false, "teste-url");
  try {
    for (const [name, url] of [
      ["URL DO SITE ", siteUrl],
      ["URL DA FONTE", sourceUrl],
    ] as const) {
      await session.page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
        .catch((error: Error) => console.log(`  goto falhou: ${error.message.slice(0, 70)}`));
      await session.page.waitForTimeout(12_000);
      const finalUrl = session.page.url();
      const verdict = /ibbkerror/.test(finalUrl)
        ? "❌ tela de erro"
        : /#!\/availability/.test(finalUrl)
          ? "✅ chegou aos resultados"
          : `? terminou em ...${finalUrl.slice(-45)}`;
      console.log(`${name}: ${verdict}`);
      await session.page.waitForTimeout(6000);
    }
  } finally {
    await session.page.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
