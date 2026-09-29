import "dotenv/config";
import path from "node:path";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// One question: why did the automatic login stop passing? Fills in what is in
// .env, submits, and shows what Iberia answered on screen: wrong credentials,
// captcha, 2FA and blocks have different messages.
//
// Credentials are never printed or stored; only what Iberia returns.

async function main() {
  const email = process.env.IBERIA_EMAIL;
  const password = process.env.IBERIA_PASSWORD;
  if (!email || !password) {
    console.error("Sem IBERIA_EMAIL/IBERIA_PASSWORD no .env.");
    process.exit(1);
  }

  const session = await openChromeSession(false, "diag-login");
  const page = session.page;
  try {
    await page
      .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((error: Error) => {
        if (!/ERR_ABORTED/.test(error.message)) throw error;
      });
    await page.waitForTimeout(5000);

    if (!/login\.iberia\.com/.test(page.url())) {
      console.log(`Já estava logado — a Iberia tirou da tela de login (${page.url().slice(0, 90)}).`);
      return;
    }

    const EMAIL_SELECTOR = 'input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]';
    const emailField = page.locator(EMAIL_SELECTOR).first();
    if (!(await emailField.isVisible().catch(() => false))) {
      console.log("A tela de login não mostrou campo de e-mail.");
    } else {
      await emailField.fill(email);
      const passwordField = page.locator('input[type="password"]').first();
      if (await passwordField.isVisible().catch(() => false)) await passwordField.fill(password);
      console.log("Campos preenchidos a partir do .env. Enviando...");

      for (const selector of ['input[name="loginPage:theForm:loginSubmit"]', 'button[type="submit"]', 'input[type="submit"]']) {
        const button = page.locator(selector).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 10_000 }).catch(() => {});
          console.log(`Enviei com ${selector}`);
          break;
        }
      }
      await page.waitForTimeout(12_000);
    }

    console.log(`\nURL depois do envio: ${page.url().slice(0, 140)}`);
    const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
    console.log(`\nTexto da tela:\n${text.replace(/\n{2,}/g, "\n").slice(0, 900)}`);

    // Captchas and challenges usually come in their own iframe.
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      console.log(`frame: ${frame.url().slice(0, 110)}`);
    }

    // Kept out of git (fixtures/*.png): the login screen may show account details.
    const capture = path.join(FIXTURES_DIR, "iberia-login-diagnosis.png");
    await page.screenshot({ path: capture }).catch(() => {});
    console.log(`\nFoto: ${capture}`);
  } finally {
    await page.close().catch(() => {});
    await session.context.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
