import dotenv from "dotenv";
import { chromium } from "playwright";
dotenv.config();

async function buscarEmissoes() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl = process.env.LOGIN_URL;
  const emailAccount = process.env.EMAIL_ACCOUNT;
  const passwordAccount = process.env.PASSWORD_ACCOUNT;

  if (!loginUrl || !emailAccount || !passwordAccount) {
    throw new Error("URL de login, email ou senha não encontrados");
  }

  console.log("Acessando a página de login...");
  await page.goto(loginUrl);

  await page.locator('input[name="username"]').fill(emailAccount);

  // 2. Preenche a Senha (no Amplify, o padrão para o field de senha é name="password")
  await page.locator('input[name="password"]').fill(passwordAccount);

  // 3. Clica no botão "Sign in"
  await page.locator('button[type="submit"]').click();

  console.log("Aguardando autenticação...");

  // 4. Precisamos esperar o login ser processado antes de tentar buscar os voos.
  // A melhor forma é esperar a página mudar para a URL interna ou a rede acalmar.
  await page.waitForLoadState("networkidle");

  console.log("Login concluído!");

  // Clica para abrir o modal de datas
  await page.click("SELETOR_DO_BOTAO_DATE");

  // Espera as linhas das datas renderizarem no DOM
  // Precisamos substituir '.row-date-class' pela classe real da div
  await page.waitForSelector(".row-date-class", { state: "visible" });

  // Extrai os dados lendo o HTML descriptografado
  const resultados = await page.$$eval(".row-date-class", (linhas) => {
    return linhas
      .map((linha) => {
        // Ajustar as classes abaixo conforme o HTML real do site
        const data = linha.querySelector(".date-text")?.textContent?.trim();
        const pontos = linha.querySelector(".points-text")?.textContent?.trim();

        return { data, pontos };
      })
      .filter((item) => item.pontos); // Filtro básico de segurança
  });

  console.log("Emissões encontradas:", resultados);

  await browser.close();
}

buscarEmissoes();
