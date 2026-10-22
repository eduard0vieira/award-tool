// Logs the bot's Chrome profile into LATAM Pass with LATAM_EMAIL/LATAM_PASSWORD
// from .env, the same routine a miles search runs. LATAM may then ask for a
// verification code (WhatsApp or email): type it in the window. The session
// stays in the profile (~/.chrome-bot-aa) for the searches. Usage: npm run login:latam
import { closeChromeSession, openChromeSession } from "../src/core/chrome-session.ts";
import { isAskingForLogin, latamBookingLink, logInToLatam } from "../src/scrapers/latam/latam.scraper.ts";

const session = await openChromeSession(false, "login-latam");
const { page } = session;
try {
  // A miles search is what sends an anonymous visitor to the login.
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await page.goto(latamBookingLink({ origin: "GRU", destination: "SCL" }, inAMonth), { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  if (!isAskingForLogin(page)) {
    console.log("A conta já estava logada nesse perfil. Nada a fazer.");
  } else {
    await logInToLatam(page, console.log, (notice) => notice && console.log(`\n${notice}`)).catch((error: Error) =>
      console.log(`\n${error.message}`),
    );
    console.log(
      isAskingForLogin(page)
        ? "\nContinua no login. Confira LATAM_EMAIL e LATAM_PASSWORD no .env."
        : "\nLogin feito: a LATAM saiu da tela de login. A sessão fica salva no perfil do bot.",
    );
  }
} finally {
  await closeChromeSession(session).catch(() => {});
  // The bot's own window, not one it attached to: closing it frees the profile for the searches.
  if (!session.viaCdp) await session.context.close().catch(() => {});
}
