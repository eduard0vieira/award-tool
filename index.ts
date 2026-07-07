import { chromium } from 'playwright';

async function buscarEmissoes() {
  // Rodando com headless: false no início para debugar visualmente
  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('URL_DO_AWARD_TOOL');

  // ... Lógica de login e preenchimento dos inputs (GRU -> LIS) ...

  // Clica para abrir o modal de datas
  await page.click('SELETOR_DO_BOTAO_DATE');

  // Espera as linhas das datas renderizarem no DOM
  // Precisamos substituir '.row-date-class' pela classe real da div
  await page.waitForSelector('.row-date-class', { state: 'visible' });

  // Extrai os dados lendo o HTML descriptografado
  const resultados = await page.$$eval('.row-date-class', (linhas) => {
    return linhas.map(linha => {
      // Ajustar as classes abaixo conforme o HTML real do site
      const data = linha.querySelector('.date-text')?.textContent?.trim();
      const pontos = linha.querySelector('.points-text')?.textContent?.trim();
      
      return { data, pontos };
    }).filter(item => item.pontos); // Filtro básico de segurança
  });

  console.log('Emissões encontradas:', resultados);

  await browser.close();
}

buscarEmissoes();