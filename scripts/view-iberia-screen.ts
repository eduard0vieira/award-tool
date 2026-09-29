import "dotenv/config";
import path from "node:path";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";
import { iberiaBookingLink } from "../src/scrapers/iberia/iberia.scraper.ts";

// Opens the search deep link and captures where the tab ends up. It exists
// because the source keeps being sent to a login.iberia.com re-authorization
// screen mid-sweep, and what that screen asks for must be seen before deciding what to do.

async function main() {
  const session = await openChromeSession(false, "ver-tela");
  const url = iberiaBookingLink({ origin: "GRU", destination: "MAD", passengers: 1 }, "2026-12-15");

  await session.page
    .goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    .catch((error: Error) => console.log(`goto: ${error.message.slice(0, 60)}`));
  await session.page.waitForTimeout(20_000);

  console.log(`URL final: ${session.page.url()}`);
  console.log(`Título: ${await session.page.title()}`);
  const text = (await session.page.evaluate("document.body ? document.body.innerText : ''")) as string;
  console.log(`\nTexto da tela:\n${text.replace(/\n{2,}/g, "\n").slice(0, 1200)}`);

  // Kept out of git (fixtures/*.png): the logged-in screen shows the holder's name and balance.
  const capture = path.join(FIXTURES_DIR, "iberia-current-screen.png");
  await session.page.screenshot({ path: capture, fullPage: false }).catch(() => {});
  console.log(`\nFoto: ${capture}`);
  await session.page.close().catch(() => {});
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
