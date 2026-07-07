import { chromium } from "playwright";
import { stdin as input, stdout as output } from "process";
import * as readline from "readline/promises";

async function buscarEmissoes() {
  const rl = readline.createInterface({ input, output });

  console.log("✈️  Bot de Emissões TAP Iniciado!\n");
  const origem = await rl.question("🛫 Digite a origem: ");
  const destino = await rl.question("🛬 Digite o destino: ");
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

  await inputOrigem.click({ force: true });
  await page.waitForTimeout(500);

  const clearOrigemBtn = origemContainer.locator(
    'button[aria-label="Clear"], button[title="Clear"]',
  );
  if (await clearOrigemBtn.isVisible()) {
    await clearOrigemBtn.click({ force: true });
  } else {
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
  }

  await inputOrigem.pressSequentially(origem, { delay: 150 });
  await page.waitForTimeout(2000);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // 3.2 Tratando o DESTINO
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  const inputDestino = autocompletes.nth(1).locator("input");
  await inputDestino.click({ force: true });

  const clearDestinoBtn = autocompletes
    .nth(1)
    .locator('button[aria-label="Clear"], button[title="Clear"]');
  if (await clearDestinoBtn.isVisible()) {
    await clearDestinoBtn.click({ force: true });
  }

  await inputDestino.pressSequentially(destino, { delay: 150 });
  await page.waitForTimeout(2000);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");

  console.log("Trechos preenchidos com sucesso!");

  // --- 4. FILTROS DE CABINE E PROGRAMA ---
  console.log("Configurando Cabine e Programa...");

  // 4.1. Filtro de Cabine
  const cabineDropdown = page.locator('div[role="combobox"]').filter({
    has: page.locator('[data-testid="FlightClassOutlinedIcon"]'),
  });
  await cabineDropdown.click();
  await page.waitForTimeout(500);

  const cabineText = cabine === "1" ? "Business" : "Economy";

  await page.getByRole("option", { name: cabineText, exact: true }).click();
  await page.waitForTimeout(500);

  // 4.2. Filtro de Programa (TAP)
  const programasBtn = page.locator("button").filter({
    has: page.locator('[data-testid="CardMembershipIcon"]'),
  });
  await programasBtn.click();
  await page.waitForTimeout(1000);

  const tapRow = page
    .locator("div.flex.justify-between")
    .filter({ hasText: "TAP" });
  const tapOnlyBtn = tapRow.locator("button");

  await tapOnlyBtn.click();
  await page.waitForTimeout(500);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  console.log("Filtros aplicados com sucesso!");

  // --- 5. SELEÇÃO DO PERÍODO DE DATAS (36 DIAS) ---
  const DIAS_BUSCA = 36;
  console.log(`Configurando o calendário para ${DIAS_BUSCA} dias...`);

  const dateInput = page.locator('input[placeholder="Departure Date Range"]');

  async function clicarDiaNoCalendario(timestamp: string) {
    const dayBtn = page.locator(`button[data-timestamp="${timestamp}"]`);
    const nextMonthBtn = page.locator(
      'button[aria-label="Next month"], button[title="Next month"]',
    );

    for (let tentativa = 0; tentativa < 6; tentativa++) {
      if (await dayBtn.isVisible()) {
        await dayBtn.click({ force: true });
        return;
      }
      await nextMonthBtn.click({ force: true });
      await page.waitForTimeout(300);
    }

    throw new Error(
      `Não foi possível encontrar o dia com timestamp ${timestamp} no calendário.`,
    );
  }

  await dateInput.click({ force: true });
  await page.waitForTimeout(1000);

  const todayBtn = page.locator("button.MuiPickersDay-today");
  const todayTimestamp = await todayBtn.getAttribute("data-timestamp");

  if (!todayTimestamp) {
    throw new Error("Não foi possível encontrar a data de hoje no calendário.");
  }

  const dataInicio = new Date(parseInt(todayTimestamp, 10));
  const dataFim = new Date(dataInicio);
  dataFim.setDate(dataInicio.getDate() + DIAS_BUSCA - 1);

  const startTimestamp = dataInicio.getTime().toString();
  const endTimestamp = dataFim.getTime().toString();

  // Clica na primeira data
  await clicarDiaNoCalendario(startTimestamp);
  await page.waitForTimeout(500);

  // Clica na segunda data
  await clicarDiaNoCalendario(endTimestamp);
  await page.waitForTimeout(500);

  // Força o fechamento do modal do calendário apertando ESC para não bloquear o botão Search
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  const rangeSelecionado = await dateInput.inputValue();
  console.log(
    `Calendário configurado: ${dataInicio.toLocaleDateString()} a ${dataFim.toLocaleDateString()} (${rangeSelecionado})`,
  );

  // --- 6. EXECUTAR A BUSCA ---
  console.log("Clicando no botão Search principal...");

  // getByRole com exact: true ignora os botões "Real-time Search" ou "Search History"
  // e pega EXATAMENTE o botão que se chama apenas "Search"
  const searchBtn = page
    .getByRole("button", { name: "Search", exact: true })
    .first();

  // Garante que o botão está de fato atachado na página antes de tentar clicar
  await searchBtn.waitFor({ state: "attached" });

  console.log("Forçando a execução do clique via DOM...");
  // Ignora o ripple effect e clica direto na raiz do elemento
  await searchBtn.evaluate((node) => {
    (node as HTMLElement).click();
  });

  console.log("Pesquisa iniciada com sucesso!");

  // --- 7. AGUARDAR PESQUISA PARCELADA (TEMPO FIXO) ---
  console.log(
    "Aguardando a plataforma processar os voos (tempo fixo de 35 segundos)...",
  );

  // Pausa absoluta de 35 segundos (evita que o script quebre tentando adivinhar as requisições de API)
  await page.waitForTimeout(35000);
  console.log("Busca finalizada!");

  // --- 8. ABRIR O MODAL DE DATAS ---
  console.log("Procurando o filtro de 'Date' nos resultados...");

  const dateFilterBtn = page
    .locator("button")
    .filter({ has: page.locator('[data-testid="DateRangeIcon"]') })
    .filter({ visible: true });

  await dateFilterBtn.first().waitFor({ state: "visible", timeout: 30000 });

  const botaoAlvo = dateFilterBtn.first();

  console.log("Forçando a abertura do modal via DOM...");
  // Força o clique nativo via JavaScript para ignorar qualquer overlay residual do Material-UI
  await botaoAlvo.evaluate((node) => {
    (node as HTMLElement).click();
  });

  await page.waitForTimeout(2000);
  console.log("Modal de datas aberto com sucesso!");
}

buscarEmissoes();
