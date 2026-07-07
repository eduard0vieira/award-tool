import { chromium } from "playwright";
import { stdin as input, stdout as output } from "process";
import * as readline from "readline/promises";

async function buscarEmissoes() {
  const rl = readline.createInterface({ input, output });

  console.log("✈️  Bot de Emissões TAP Iniciado!\n");
  const origem = await rl.question("🛫 Digite a origem:");
  const destino = await rl.question("🛬 Digite o destino:");
  const cabine = await rl.question(
    "💺 Cabine (1 para Executiva, 2 para Todas): ",
  );

  rl.close();

  console.log(
    `\nBuscando ${origem.toUpperCase()} -> ${destino.toUpperCase()}...`,
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl = "https://www.awardtool.com/password";
  const emailAccount = "contato@vamoscomclasse.com";
  const passwordAccount = "Vcc$2026";

  console.log("Acessando a página de login...");
  await page.goto(loginUrl);

  await page.locator('input[name="username"]').fill(emailAccount);
  await page.locator('input[name="password"]').fill(passwordAccount);
  await page.locator('button[type="submit"]').click();

  await page.waitForLoadState("networkidle");
  console.log("Login concluído!");

  // --- 3. INTERAÇÃO COM O FORMULÁRIO DE BUSCA ---
  // (Precisaremos dos seletores exatos para preencher isso aqui)

  // Exemplo mental do fluxo:
  // await page.locator('SELETOR_CABINE').click();
  // await page.locator(cabine === '1' ? 'SELETOR_BUSINESS' : 'SELETOR_ALL_CABINS').click();

  // await page.locator('SELETOR_PROGRAMAS').click();
  // await page.locator('SELETOR_TAP').click();

  // await page.locator('SELETOR_ORIGEM').fill(origem);
  // await page.locator('SELETOR_DESTINO').fill(destino);
  // await page.locator('SELETOR_BOTAO_SEARCH').click();

  // ... (Restante do fluxo do Modal)
}

buscarEmissoes();
