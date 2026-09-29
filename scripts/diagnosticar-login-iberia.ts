import "dotenv/config";
import path from "node:path";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// Uma pergunta só: por que o login automático parou de passar? Preenche com o
// que está no .env, envia, e mostra o que a Iberia respondeu na tela — erro de
// credencial, captcha, 2FA ou bloqueio têm mensagens diferentes.
//
// As credenciais não são impressas nem gravadas; só o que a Iberia devolve.

async function main() {
  const email = process.env.IBERIA_EMAIL;
  const senha = process.env.IBERIA_SENHA;
  if (!email || !senha) {
    console.error("Sem IBERIA_EMAIL/IBERIA_SENHA no .env.");
    process.exit(1);
  }

  const sessao = await openChromeSession(false, "diag-login");
  const page = sessao.page;
  try {
    await page
      .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) throw e;
      });
    await page.waitForTimeout(5000);

    if (!/login\.iberia\.com/.test(page.url())) {
      console.log(`Já estava logado — a Iberia tirou da tela de login (${page.url().slice(0, 90)}).`);
      return;
    }

    const SELETOR_EMAIL =
      'input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]';
    const campoEmail = page.locator(SELETOR_EMAIL).first();
    if (!(await campoEmail.isVisible().catch(() => false))) {
      console.log("A tela de login não mostrou campo de e-mail.");
    } else {
      await campoEmail.fill(email);
      const campoSenha = page.locator('input[type="password"]').first();
      if (await campoSenha.isVisible().catch(() => false)) await campoSenha.fill(senha);
      console.log("Campos preenchidos a partir do .env. Enviando...");

      for (const seletor of [
        'input[name="loginPage:theForm:loginSubmit"]',
        'button[type="submit"]',
        'input[type="submit"]',
      ]) {
        const botao = page.locator(seletor).first();
        if (await botao.isVisible().catch(() => false)) {
          await botao.click({ timeout: 10_000 }).catch(() => {});
          console.log(`Enviei com ${seletor}`);
          break;
        }
      }
      await page.waitForTimeout(12_000);
    }

    console.log(`\nURL depois do envio: ${page.url().slice(0, 140)}`);
    const texto = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
    console.log(`\nTexto da tela:\n${texto.replace(/\n{2,}/g, "\n").slice(0, 900)}`);

    // Captcha e desafios costumam vir em iframe próprio.
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      console.log(`frame: ${f.url().slice(0, 110)}`);
    }

    const foto = path.join(FIXTURES_DIR, "iberia-login-diag.png");
    await page.screenshot({ path: foto }).catch(() => {});
    console.log(`\nFoto: ${foto}`);
  } finally {
    await page.close().catch(() => {});
    await sessao.context.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  },
);
