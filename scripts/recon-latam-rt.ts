import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { isAskingForLogin, waitForManualLogin } from "../src/scrapers/latam/latam.scraper.ts";
import { FIXTURES_DIR, ROOT_DIR } from "../src/core/paths.ts";

// Descobrir DE ONDE sai o preço de ida e volta da LATAM.
//
// O bot hoje confirma perna por perna (`trip=OW`) e soma: deu 243.535 milhas
// num par que, comprado junto no site, sai por 90.302 + R$ 255,69. Não é
// tarifa diferente — é pergunta diferente: a LATAM precifica o par junto.
//
// O problema é que esse número NÃO está na resposta que o bot já lê
// (`/offers/search/redemption`). A tela "Combine suas milhas + dinheiro", com
// as quatro combinações de milhas+dinheiro, só aparece DEPOIS de escolher um
// voo de ida e um de volta. Então este recon dirige o fluxo e grava tudo que
// passa na rede, pra descobrir qual resposta carrega aquelas quatro linhas —
// e se elas vêm em JSON ou só no HTML.
//
// Nada é parseado aqui de propósito: fixture primeiro, parser depois.
//
// Uso: npx tsx scripts/recon-latam-rt.ts GRU JNB 2026-10-31 2026-11-06

const [origem = "GRU", destino = "JNB", dataIda = daqui(60), dataVolta = daqui(67)] = process.argv.slice(2);
const DIR_SAIDA = path.join(ROOT_DIR, "fixtures", "latam-rt");

function daqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function urlIdaEVolta(): string {
  return (
    "https://www.latamairlines.com/br/pt/oferta-voos?" +
    new URLSearchParams({
      origin: origem,
      destination: destino,
      outbound: `${dataIda}T12:00:00.000Z`,
      inbound: `${dataVolta}T12:00:00.000Z`,
      adt: "1",
      chd: "0",
      inf: "0",
      trip: "RT",
      cabin: "Economy",
      redemption: "true",
      sort: "RECOMMENDED",
    }).toString()
  );
}

type Resposta = { passo: string; metodo: string; url: string; status: number; tamanho: number; corpo: string | null };

const respostas: Resposta[] = [];
let passoAtual = "0-abertura";

const interessa = (u: string) =>
  /latamairlines\.com/.test(u) && !/\.(js|css|png|jpg|jpeg|svg|woff2?|gif|ico)(\?|$)/.test(u);

async function main() {
  console.log(`\nRecon LATAM ida e volta — ${origem} ⇄ ${destino} · ${dataIda} → ${dataVolta}\n`);
  fs.mkdirSync(DIR_SAIDA, { recursive: true });

  const sessao = await openChromeSession(false, "recon-latam-rt");
  const page = sessao.page;

  page.on("response", async (res) => {
    if (!interessa(res.url())) return;
    const tipo = res.headers()["content-type"] ?? "";
    let corpo: string | null = null;
    if (tipo.includes("json")) corpo = await res.text().catch(() => null);
    respostas.push({
      passo: passoAtual,
      metodo: res.request().method(),
      url: res.url(),
      status: res.status(),
      tamanho: corpo?.length ?? 0,
      corpo,
    });
  });

  // ── passo 1: o deep link de ida e volta ──────────────────────────────────
  passoAtual = "1-resultado-ida";
  console.log("1. Abrindo o deep link de ida e volta...");
  await page.goto(urlIdaEVolta(), { waitUntil: "domcontentloaded", timeout: 90_000 });

  if (isAskingForLogin(page)) {
    await waitForManualLogin(page, (m) => console.log(`   ${m}`), () => {});
    await page.goto(urlIdaEVolta(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (isAskingForLogin(page)) {
      console.log("❌ Continuou na tela de login. Faça o login na janela do bot e rode de novo.");
      await encerrar(page);
      return;
    }
  }

  await esperarCartoes(page, "ida");
  await foto(page, "1-resultado-ida");

  // ── passo 2: escolher a ida ──────────────────────────────────────────────
  passoAtual = "2-escolha-ida";
  console.log("2. Escolhendo o primeiro voo da ida...");
  if (!(await escolherPrimeiroVoo(page))) {
    console.log("❌ Não consegui escolher a ida — veja as fotos em fixtures/latam-rt/.");
    await salvar();
    await encerrar(page);
    return;
  }
  await page.waitForTimeout(4000);
  await foto(page, "2-depois-da-ida");

  // ── passo 3: escolher a volta ────────────────────────────────────────────
  passoAtual = "3-escolha-volta";
  console.log("3. Escolhendo o primeiro voo da volta...");
  await esperarCartoes(page, "volta").catch(() => {});
  if (!(await escolherPrimeiroVoo(page))) {
    console.log("⚠️  Não consegui escolher a volta — veja as fotos.");
  }
  await page.waitForTimeout(6000);

  // ── passo 4: a tela das combinações ──────────────────────────────────────
  passoAtual = "4-combinacoes";
  console.log("4. Onde parou:");
  console.log(`   URL: ${page.url()}`);
  const texto = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
  const achouCombinacoes = /Combine suas milhas|Selecione a op/i.test(texto);
  console.log(`   Tela de combinações: ${achouCombinacoes ? "SIM" : "não encontrada"}`);
  const linhas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /milhas.*(BRL|R\$)/i.test(l));
  console.log(`   Linhas com "milhas + dinheiro" no texto da página: ${linhas.length}`);
  for (const l of linhas.slice(0, 8)) console.log(`     ${l}`);
  await foto(page, "4-combinacoes");

  await salvar();
  await encerrar(page);
}

async function esperarCartoes(page: import("playwright").Page, qual: string) {
  await page
    .locator('[data-testid^="wrapper-card-flight-"]')
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => console.log(`   (nenhum cartão de voo apareceu na ${qual})`));
  await page.waitForTimeout(2500);
}

// A LATAM pede duas escolhas por perna: o voo e, num painel que abre em
// seguida, a tarifa (Light/Plus/Top). Aqui pega sempre a primeira das duas —
// o que interessa é chegar na tela final, não escolher bem.
async function escolherPrimeiroVoo(page: import("playwright").Page): Promise<boolean> {
  const cartao = page.locator('[data-testid^="wrapper-card-flight-"]').first();
  if ((await cartao.count()) === 0) return false;
  await cartao.click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Botão de escolher tarifa dentro do painel; os testids variam, então tenta
  // por texto também.
  const alvos = [
    '[data-testid*="fare-selection"] button',
    'button[data-testid*="select"]',
    "button:has-text('Escolher')",
    "button:has-text('Selecionar')",
    "button:has-text('Continuar')",
  ];
  for (const sel of alvos) {
    const botao = page.locator(sel).first();
    if ((await botao.count()) > 0 && (await botao.isVisible().catch(() => false))) {
      await botao.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }
  // Sem painel de tarifa: o clique no cartão já pode ter bastado.
  return true;
}

async function foto(page: import("playwright").Page, nome: string) {
  const destino = path.join(DIR_SAIDA, `${nome}.png`);
  await page.screenshot({ path: destino, fullPage: true }).catch(() => {});
  console.log(`   foto: fixtures/latam-rt/${nome}.png`);
}

// Cada resposta JSON vira um arquivo, com um índice em texto por cima. É de
// propósito que nada seja interpretado: o parser vem depois, olhando isto.
async function salvar() {
  const indice: string[] = [];
  respostas.forEach((r, i) => {
    const linha = `${String(i).padStart(3, "0")} | ${r.passo} | ${r.metodo} ${r.status} | ${r.tamanho} bytes | ${r.url}`;
    indice.push(linha);
    if (r.corpo && r.corpo.length > 200) {
      fs.writeFileSync(path.join(DIR_SAIDA, `${String(i).padStart(3, "0")}-${r.passo}.json`), r.corpo, "utf8");
    }
  });
  fs.writeFileSync(path.join(DIR_SAIDA, "indice.txt"), indice.join("\n"), "utf8");

  console.log(`\n✅ ${respostas.length} respostas registradas em fixtures/latam-rt/`);
  const grandes = respostas.filter((r) => r.tamanho > 5000).sort((a, b) => b.tamanho - a.tamanho);
  console.log("\nAs maiores respostas JSON (candidatas a carregar o preço do par):");
  for (const r of grandes.slice(0, 8)) {
    console.log(`  ${r.tamanho.toString().padStart(8)} bytes | ${r.passo} | ${r.url.slice(0, 110)}`);
  }
  console.log(`\n(fixtures em ${path.relative(ROOT_DIR, DIR_SAIDA)}; FIXTURES_DIR = ${path.relative(ROOT_DIR, FIXTURES_DIR)})`);
}

async function encerrar(page: import("playwright").Page) {
  await page.close();
  process.exit(0);
}

main();
