import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abrirSessaoChrome } from "../sessao-chrome.ts";

// FASE 0 do módulo Iberia.
//
// O projeto antigo (projetos/cheap-flights) atacava a API do APP iOS:
// ibisservices.iberia.com/api/sse-rpa/rs/v1/availability, com token obtido por
// login na conta Iberia Plus e cookies de Akamai colados à mão — inclusive um
// `X-acf-sensor-data`, que é assinado pelo app nativo e não dá pra reproduzir.
// Foi por isso que aquilo virou 403 e ficou.
//
// A técnica que destravou a Azul não liga pra nada disso: quem monta a
// requisição é o site, nós só trocamos o que pedimos. O primeiro olhar já
// mostrou dois sinais bons:
//   - a home chama `ibisauth.../openid-connect/token` sozinha, anônima;
//   - ela usa o MESMO host `ibisservices.iberia.com` da API do app.
//
// Perguntas desta fase:
//   1. a busca com "Pagar com Avios" abre sem login?
//   2. qual endpoint traz a disponibilidade, e quantos dias por resposta?
//   3. o resultado sai numa URL que dá pra repetir (deep link)?
//
// Uso: npx tsx scripts/recon-iberia.ts [GRU] [MAD] [2026-11-16]

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_FIXTURES = path.join(__dirname, "..", "fixtures");

const [origem = "GRU", destino = "MAD", data = dataDaqui(90)] = process.argv.slice(2);

function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}
function dataBR(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

// Quanto tempo o script espera você fazer o login na janela do bot. O login
// fica salvo no perfil, então isso é uma vez só — não a cada busca.
const ESPERA_LOGIN_MS = Number(process.env.IBERIA_ESPERA_LOGIN_MS) || 600_000;

const SIGILOSOS = ["authorization", "cookie", "x-acf-sensor-data"];
const mascarar = (n: string, v: string) =>
  SIGILOSOS.includes(n.toLowerCase()) ? `<${v.length} chars — não impresso>` : v;

type Captura = {
  url: string;
  metodo: string;
  headers: Record<string, string>;
  corpoEnviado: string | null;
  status: number | null;
  corpoRecebido: string | null;
};

const interessa = (u: string) =>
  /ibisservices\.iberia\.com|ibisauth\.iberia\.com/.test(u) && !/\.(js|css|png|jpg|svg|woff2?)/.test(u);

async function main() {
  console.log(`\nRecon Iberia — ${origem.toUpperCase()}→${destino.toUpperCase()} em ${data} (Avios)\n`);

  const sessao = await abrirSessaoChrome(false, "recon-iberia");
  const page = sessao.page;
  const capturas: Captura[] = [];

  page.on("request", (req) => {
    if (!interessa(req.url())) return;
    capturas.push({
      url: req.url(),
      metodo: req.method(),
      headers: req.headers(),
      corpoEnviado: req.postData(),
      status: null,
      corpoRecebido: null,
    });
  });
  page.on("response", async (res) => {
    if (!interessa(res.url())) return;
    const alvo = capturas.find((c) => c.url === res.url() && c.status === null);
    if (!alvo) return;
    alvo.status = res.status();
    alvo.corpoRecebido = await res.text().catch(() => null);
  });

  console.log("1. Abrindo a home...");
  await page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  // Aviso de cookies: recusar o que não é essencial. Nunca aceitar.
  await recusarCookies(page);

  console.log("2. Preenchendo a busca com 'Pagar com Avios'...");
  const preencheu = await preencherFormulario(page);
  if (!preencheu) {
    console.log("❌ Não consegui preencher o formulário — o layout mudou. Foto em scratchpad/iberia-erro.png");
    await page.screenshot({ path: "/private/tmp/claude-501/-Users-eduard0vieira/54478edc-7220-4ae1-8f26-3e30e6d34920/scratchpad/iberia-erro.png" });
    await encerrar(page);
    return;
  }

  console.log("3. Esperando o resultado...");
  const temBusca = () =>
    capturas.some((c) => /availability|shopping|flights|fares/i.test(c.url) && (c.corpoRecebido?.length ?? 0) > 2000);

  await esperarAte(page, 25_000, () => temBusca() || pedindoLogin(page));

  if (pedindoLogin(page)) {
    if (!(await esperarLoginManual(page))) {
      await encerrar(page);
      return;
    }
    // Depois do login a Iberia volta pro fluxo de reserva sozinha; se não voltar,
    // refaz a busca — agora com sessão.
    await esperarAte(page, 30_000, temBusca);
    if (!temBusca()) {
      console.log("   a busca não refez sozinha depois do login — repetindo o formulário...");
      await page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(5000);
      await recusarCookies(page);
      if (await preencherFormulario(page)) await esperarAte(page, 40_000, temBusca);
    }
  }

  console.log(`\n   URL final: ${page.url()}`);
  console.log(`   Título: ${await page.title()}`);
  const texto = (await page.evaluate("document.body ? document.body.innerText : ''") as string).replace(/\s+/g, " ");
  console.log(`   Texto (300): ${texto.slice(0, 300)}\n`);

  console.log(`4. Chamadas à API da Iberia: ${capturas.length}\n`);
  for (const c of capturas) {
    console.log(`── ${c.metodo} ${c.url.slice(0, 120)}`);
    console.log(`   status ${c.status ?? "?"} | ${c.corpoRecebido?.length ?? 0} bytes`);
    if (c.corpoEnviado) console.log(`   enviou: ${c.corpoEnviado.slice(0, 400)}`);
  }

  const busca = capturas.find(
    (c) => /availability|shopping|flights|fares/i.test(c.url) && c.status === 200 && (c.corpoRecebido?.length ?? 0) > 2000,
  );
  if (!busca || !busca.corpoRecebido) {
    console.log("\n⚠️  Nenhuma resposta grande de disponibilidade. Ou exige login, ou sai por outro caminho.");
    await page.screenshot({ path: "/private/tmp/claude-501/-Users-eduard0vieira/54478edc-7220-4ae1-8f26-3e30e6d34920/scratchpad/iberia-resultado.png" });
    await encerrar(page);
    return;
  }

  console.log(`\n5. Endpoint de disponibilidade: ${busca.metodo} ${busca.url}`);
  console.log("   headers da aplicação:");
  for (const [n, v] of Object.entries(busca.headers)) {
    if (/^(authorization|x-|content-type|accept|market|culture|device)/i.test(n)) console.log(`     ${n}: ${mascarar(n, v)}`);
  }

  fs.mkdirSync(DIR_FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(DIR_FIXTURES, "iberia-real.json"), busca.corpoRecebido, "utf8");
  console.log(`\n✅ Resposta crua salva em fixtures/iberia-real.json (${busca.corpoRecebido.length} bytes).`);

  await encerrar(page);
}

const pedindoLogin = (page: import("playwright").Page) => /login\.iberia\.com/.test(page.url());

// Mesmo acordo do módulo da LATAM (`preencherCredenciais` em bot-latam.ts): se
// IBERIA_EMAIL e IBERIA_SENHA estiverem no .env, o script adianta a digitação.
// Ele **não confirma o login** — o clique em "Fazer login" fica com você, que é
// onde entram 2FA, captcha e qualquer coisa que a Iberia resolva pedir.
//
// As credenciais moram só no seu .env (que está no .gitignore). Nada é impresso
// no terminal nem guardado em outro lugar.
async function preencherCredenciais(page: import("playwright").Page): Promise<void> {
  const email = process.env.IBERIA_EMAIL;
  const senha = process.env.IBERIA_SENHA;
  if (!email || !senha) {
    console.log("   (sem IBERIA_EMAIL/IBERIA_SENHA no .env — o login é todo na mão, na janela do bot)");
    return;
  }

  try {
    // O aviso de cookies cobre esta página também, e o filtro dele engole cliques.
    await recusarCookies(page);

    const campoEmail = page
      .locator('input[name="loginPage:theForm:loginEmailInput"], input[type="email"]')
      .first();
    const campoSenha = page.locator('input[type="password"]').first();

    await campoEmail.waitFor({ state: "visible", timeout: 20_000 });
    await campoEmail.fill(email);

    if (await campoSenha.isVisible().catch(() => false)) {
      await campoSenha.fill(senha);
      console.log("   e-mail e senha preenchidos a partir do .env — falta você clicar em \"Fazer login\".");
    } else {
      console.log("   e-mail preenchido; o campo de senha não estava na tela — siga na janela do bot.");
    }
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message.split("\n")[0] : String(erro);
    console.log(`   não consegui preencher o login (${motivo}) — siga na mão na janela do bot.`);
  }
}

// A busca com Avios não chama disponibilidade nenhuma sem conta: ela redireciona
// pro login. Então o script para aqui e devolve o volante — a senha é sua e não
// passa por este processo.
async function esperarLoginManual(page: import("playwright").Page): Promise<boolean> {
  await page.bringToFront().catch(() => {});
  await preencherCredenciais(page);
  const minutos = Math.round(ESPERA_LOGIN_MS / 60000);
  console.log("");
  console.log("   ┌──────────────────────────────────────────────────────────────┐");
  console.log("   │  A Iberia pediu login pra buscar com Avios.                  │");
  console.log("   │                                                              │");
  console.log("   │  Na janela do Chrome que está aberta (é a do bot): confira     │");
  console.log("   │  os campos e clique em \"Fazer login\". Assim que a sessão      │");
  console.log("   │  abrir, o recon continua sozinho.                            │");
  console.log("   │                                                              │");
  console.log(`   │  Espero até ${String(minutos).padStart(2)} min. Nada do que você digitar passa por      │`);
  console.log("   │  aqui — o login fica salvo no perfil do Chrome do bot.        │");
  console.log("   └──────────────────────────────────────────────────────────────┘");
  console.log("");

  const limite = Date.now() + ESPERA_LOGIN_MS;
  let ultimo = "";
  while (Date.now() < limite) {
    await page.waitForTimeout(3000);
    if (!pedindoLogin(page)) {
      console.log(`   ✅ login concluído — a página saiu do login (${page.url().slice(0, 80)})`);
      return true;
    }
    const faltam = Math.round((limite - Date.now()) / 60000);
    const marca = `${faltam}`;
    if (marca !== ultimo) {
      console.log(`   ...esperando o login (${faltam} min restantes)`);
      ultimo = marca;
    }
  }
  console.log(`   ⏱️  passaram ${minutos} min sem login. Rode de novo quando puder — o que já foi descoberto está nas notas.`);
  return false;
}

// O aviso de cookies da Iberia oferece só "Aceitar todos" e "Definições" — não
// tem botão de recusar. **Não aceitamos nada**: o que ele faz é cobrir a página
// com um filtro escuro (`onetrust-pc-dark-filter`) que intercepta todo clique,
// e era isso que estava travando o formulário. Tirar a cobertura do caminho não
// dá consentimento nenhum: o banner segue sem resposta.
async function recusarCookies(page: import("playwright").Page) {
  const recusar = page.locator("#onetrust-reject-all-handler").first();
  if (await recusar.count().then((n) => n > 0).catch(() => false)) {
    await recusar.click({ timeout: 5000 }).catch(() => {});
    console.log("   (aviso de cookies: recusei os não essenciais)");
    await page.waitForTimeout(1500);
    return;
  }

  const removidos = await page.evaluate(`(() => {
    const alvos = [...document.querySelectorAll(".onetrust-pc-dark-filter, .ot-fade-in")];
    for (const e of alvos) e.remove();
    return alvos.length;
  })()`);
  console.log(`   (aviso de cookies: sem botão de recusar — nada foi aceito; só tirei a cobertura que bloqueava os cliques, ${removidos} elemento(s))`);
  await page.waitForTimeout(800);
}

// Seletores conferidos na página (o botão visível é uma lupa; o `Pesquisar` de
// verdade é #buttonSubmit1, e o checkbox de Avios só reage pelo rótulo).
async function preencherFormulario(page: import("playwright").Page): Promise<boolean> {
  try {
    await page.fill("#flight_origin1", origem.toUpperCase());
    await page.waitForTimeout(2500);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await page.fill("#flight_destiny1", destino.toUpperCase());
    await page.waitForTimeout(2500);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // "Só ida": uma perna por busca, como nas outras fontes. O select é
    // controlado por JS, então o evento precisa ir junto.
    await page.evaluate(`(() => {
      const s = document.querySelector("#ticketops-seeker");
      if (s) { s.value = "Só ida"; s.dispatchEvent(new Event("change", { bubbles: true })); }
    })()`);
    await page.waitForTimeout(1200);

    // Avios: o input não responde a clique direto; quem responde é o rótulo.
    // Controle: a mesma busca SEM Avios. Se ela chegar no resultado, o que
    // barra não é a automação — é o Avios.
    const semAvios = process.env.SEM_AVIOS === "true";
    if (semAvios) console.log("   (controle: buscando em dinheiro, sem marcar Avios)");

    const estado = async () =>
      (await page.evaluate(`(() => {
        const e = document.querySelector("#paywithAvios");
        return e ? { marcado: e.checked, desabilitado: e.disabled } : null;
      })()`)) as { marcado: boolean; desabilitado: boolean } | null;

    // O perfil guarda o estado do formulário entre execuções, então o controle
    // precisa DESMARCAR na marra — senão ele repete a busca com Avios e mente.
    await page.evaluate(
      `((ligar) => {
        const e = document.querySelector("#paywithAvios");
        if (!e || e.checked === ligar) return;
        e.checked = ligar;
        e.dispatchEvent(new Event("click", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      })(${semAvios ? "false" : "true"})`,
    );
    await page.waitForTimeout(1200);

    if (!semAvios) {
      await page.locator("label[for='paywithAvios']").first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    if (!semAvios && (await estado())?.marcado !== true) {
      console.log("   rótulo não marcou; tentando pelo próprio input...");
      await page.evaluate(`(() => {
        const e = document.querySelector("#paywithAvios");
        if (e) { e.checked = true; e.dispatchEvent(new Event("click", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }
      })()`);
      await page.waitForTimeout(1500);
    }

    const st = await estado();
    console.log(`   'Pagar com Avios': marcado=${st?.marcado} desabilitado=${st?.desabilitado}`);
    if (!semAvios && st?.marcado !== true) {
      console.log("   ❌ sem Avios a busca vira dinheiro — parando aqui.");
      await page.screenshot({ path: "/private/tmp/claude-501/-Users-eduard0vieira/54478edc-7220-4ae1-8f26-3e30e6d34920/scratchpad/iberia-avios.png" });
      return false;
    }

    // O campo de data é um datepicker: `fill` não fixa o valor. O que pega é
    // escrever e avisar a página, como no checkbox. Ida e volta porque o
    // seletor de "Só ida" é um dropdown próprio — a perna extra não atrapalha
    // o recon, que é descobrir o endpoint.
    const volta = new Date(data);
    volta.setDate(volta.getDate() + 7);
    const dataVolta = dataBR(volta.toISOString().slice(0, 10));
    await page.evaluate(
      `((ida, volta) => {
        const por = (sel, v) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          e.value = v;
          for (const nome of ["input", "change", "blur"]) e.dispatchEvent(new Event(nome, { bubbles: true }));
          return e.value;
        };
        return [por("#flight_round_date1", ida), por("#flight_return_date1", volta)];
      })(${JSON.stringify(dataBR(data))}, ${JSON.stringify(dataVolta)})`,
    );
    await page.waitForTimeout(1200);
    const datas = await page.evaluate(`(() => {
      const v = (s) => { const e = document.querySelector(s); return e ? e.value : null; };
      return [v("#flight_round_date1"), v("#flight_return_date1")];
    })()`);
    console.log(`   datas no formulário: ${JSON.stringify(datas)}`);

    await page.locator("#buttonSubmit1").first().click({ timeout: 10_000, force: true });
    return true;
  } catch (erro) {
    console.log(`   (falhou: ${(erro as Error).message.slice(0, 200)})`);
    return false;
  }
}

// Espera por uma condição em vez de por um tempo fixo: o que interessa é a
// captura chegar, não o relógio.
async function esperarAte(page: import("playwright").Page, limiteMs: number, pronto: () => boolean) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim && !pronto()) await page.waitForTimeout(1000);
}

async function encerrar(page: import("playwright").Page) {
  await page.close();
  process.exit(0);
}

main();
