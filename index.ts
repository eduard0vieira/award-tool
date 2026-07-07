import { chromium } from "playwright";
import { stdin as input, stdout as output } from "process";
import * as readline from "readline/promises";

async function buscarEmissoes() {
  const rl = readline.createInterface({ input, output });

  console.log("✈️  Bot de Emissões TAP Iniciado!\n");
  const origem = await rl.question("🛫 Digite a origem:");
  const destino = await rl.question("🛬 Digite o destino:");
  const cabine = await rl.question(
    "💺 Cabine (1 para Executiva, 2 para Econômica): ",
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

  // --- 3. PREENCHIMENTO DE ORIGEM E DESTINO ---
  console.log("Aguardando a interface de busca renderizar...");
  await page.waitForSelector(".MuiAutocomplete-root", {
    state: "visible",
    timeout: 15000,
  });
  await page.waitForTimeout(2000);

  console.log("Preenchendo os trechos...");
  const autocompletes = page
    .locator(".MuiAutocomplete-root")
    .filter({ visible: true });

  // 3.1 Tratando a ORIGEM
  const origemContainer = autocompletes.nth(0);
  const inputOrigem = origemContainer.locator("input");

  // 1. Clica no input para garantir o foco
  await inputOrigem.click({ force: true });
  await page.waitForTimeout(500);

  // 2. Apaga o valor pré-existente (ex: GRU)
  const clearOrigemBtn = origemContainer.locator(
    'button[aria-label="Clear"], button[title="Clear"]',
  );
  if (await clearOrigemBtn.isVisible()) {
    await clearOrigemBtn.click({ force: true });
  } else {
    // Fallback marreta: Backspace para apagar o "chip" caso o botão de limpar esteja escondido
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
  }

  // 3. Faz o fluxo de preenchimento
  await inputOrigem.pressSequentially(origem, { delay: 150 });
  await page.waitForTimeout(2000); // Espera a lista carregar

  await page.keyboard.press("ArrowDown"); // Vai para a primeira opção
  await page.keyboard.press("Enter"); // Marca o checkbox
  await page.keyboard.press("Escape"); // Fecha o dropdown multi-select
  await page.waitForTimeout(500);

  // 3.2 Tratando o DESTINO
  // 4. Dá o Tab para pular para o "Where to?"
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  // Se o cursor não foi para o lugar certo com o Tab, garantimos o foco manual
  const inputDestino = autocompletes.nth(1).locator("input");
  await inputDestino.click({ force: true });

  // Limpa o destino se tiver algo
  const clearDestinoBtn = autocompletes
    .nth(1)
    .locator('button[aria-label="Clear"], button[title="Clear"]');
  if (await clearDestinoBtn.isVisible()) {
    await clearDestinoBtn.click({ force: true });
  }

  // 5. Preenche o LIS
  await inputDestino.pressSequentially(destino, { delay: 150 });
  await page.waitForTimeout(2000);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");

  console.log("Trechos preenchidos com sucesso!");

  // --- 4. FILTROS DE CABINE E PROGRAMA ---
  console.log("Configurando Cabine e Programa...");

  // 4.1. Filtro de Cabine
  // Localizamos o combobox da cabine usando o ícone da poltrona para ser à prova de falhas
  const cabineDropdown = page.locator('div[role="combobox"]').filter({
    has: page.locator('[data-testid="FlightClassOutlinedIcon"]'),
  });
  await cabineDropdown.click();
  await page.waitForTimeout(500);

  const cabineText = cabine === "1" ? "Business" : "Economy";

  // getByRole com exact: true garante que o Playwright clique apenas na opção idêntica ao texto
  await page.getByRole("option", { name: cabineText, exact: true }).click();
  await page.waitForTimeout(500);

  // 4.2. Filtro de Programa (TAP)
  // Localiza o botão de Programas usando o ícone do cartão
  const programasBtn = page.locator("button").filter({
    has: page.locator('[data-testid="CardMembershipIcon"]'),
  });
  await programasBtn.click();
  await page.waitForTimeout(1000); // Espera a lista de programas renderizar

  // Com base no seu print, cada programa é uma div "flex justify-between"
  // Vamos achar a que contém a TAP e clicar no botão "Only" dentro dela
  const tapRow = page
    .locator("div.flex.justify-between")
    .filter({ hasText: "TAP" });
  const tapOnlyBtn = tapRow.locator("button");

  await tapOnlyBtn.click();
  await page.waitForTimeout(500);

  // O Material-UI pode deixar o menu de programas aberto após clicar no "Only".
  // Um Escape garante que ele saia da frente para podermos clicar em Search.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  console.log("Filtros aplicados com sucesso!");
}

buscarEmissoes();
