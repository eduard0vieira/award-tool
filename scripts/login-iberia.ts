// Logs the bot's Chrome profile into Iberia Club with IBERIA_EMAIL/IBERIA_PASSWORD
// from .env, the same routine the source uses. When Iberia stops for a code or a
// captcha, or refuses the password, it prints what the screen says and waits for
// you to finish in the window. The session then stays in the profile
// (~/.chrome-bot-aa) for the searches. Usage: npm run login:iberia
import { closeChromeSession, openChromeSession } from "../src/core/chrome-session.ts";
import { logIn } from "../src/scrapers/iberia/iberia.scraper.ts";

const onLoginPage = (url: string) => /login\.iberia\.com/.test(url);

const session = await openChromeSession(false, "login-iberia");
const { page } = session;
try {
  await page
    .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch((error: Error) => {
      if (!/ERR_ABORTED/.test(error.message)) throw error;
    });
  await page.waitForTimeout(4000);

  if (!onLoginPage(page.url())) {
    console.log("A conta já estava logada nesse perfil. Nada a fazer.");
  } else {
    // The same routine a search runs: it waits in the window for whatever is left to a person.
    const showScreen = async (notice: string) => {
      if (!notice) return;
      const screen = await page.locator("body").innerText().catch(() => "");
      console.log(`\n${notice}\nO que a tela de login mostra agora:\n---`);
      console.log(screen.split("\n").filter((line) => line.trim()).slice(0, 25).join("\n"));
      console.log("---");
    };
    await logIn(page, console.log, (notice) => void showScreen(notice)).catch((error: Error) => console.log(`\n${error.message}`));
    console.log(
      onLoginPage(page.url())
        ? "\nContinua na tela de login. Confira IBERIA_EMAIL e IBERIA_PASSWORD no .env."
        : `\nLogin feito: a Iberia saiu da tela de login (${page.url().slice(0, 60)}). A sessão fica salva no perfil do bot.`,
    );
  }
} finally {
  await closeChromeSession(session).catch(() => {});
  // The bot's own window, not one it attached to: closing it frees the profile for the searches.
  if (!session.viaCdp) await session.context.close().catch(() => {});
}
