import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { abrirSessaoChrome } from "../src/nucleo/sessao-chrome.ts";
import { DIR_FIXTURES } from "../src/nucleo/caminhos.ts";

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

const foto = (nome: string) => path.join(DIR_FIXTURES, `iberia-${nome}.png`);

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

// Começou olhando só `ibisservices`/`ibisauth`, que são os hosts conhecidos —
// mas se o preço em Avios vier de outra rota da casa, esse filtro o esconderia.
// Agora pega qualquer host da iberia.com, menos estático e rastreador.
// Largo o bastante pra achar uma rota de preço fora dos dois hosts conhecidos,
// estreito o bastante pra não afogar o log nos beacons de Akamai (`sensor_data`)
// e Dynatrace (`rb_*`), que a primeira versão larga trouxe às dezenas.
const interessa = (u: string) => {
  const host = new URL(u, "https://www.iberia.com").hostname;
  if (!/(^|\.)iberia\.com$/.test(host)) return false;
  if (/\.(js|css|png|jpe?g|svg|gif|woff2?|ico|mp4)(\?|$)/.test(u)) return false;
  if (/ibisservices\.iberia\.com|ibisauth\.iberia\.com/.test(host)) return true;
  return /\/api\//.test(new URL(u, "https://www.iberia.com").pathname);
};

async function main() {
  console.log(`\nRecon Iberia — ${origem.toUpperCase()}→${destino.toUpperCase()} em ${data} (Avios)\n`);

  const sessao = await abrirSessaoChrome(false, "recon-iberia");
  const page = sessao.page;
  const capturas: Captura[] = [];

  // Pareamento pela IDENTIDADE da requisição, não pela URL: a mesma rota de
  // disponibilidade é chamada duas vezes (marketCode BR e US), e casar por
  // string grudava a resposta de uma no pedido da outra — resultado errado com
  // cara de certo, que é justamente o que o AGENTS.md manda não deixar acontecer.
  const porRequisicao = new Map<import("playwright").Request, Captura>();

  page.on("request", (req) => {
    if (!interessa(req.url())) return;
    const captura: Captura = {
      url: req.url(),
      metodo: req.method(),
      headers: req.headers(),
      corpoEnviado: req.postData(),
      status: null,
      corpoRecebido: null,
    };
    capturas.push(captura);
    porRequisicao.set(req, captura);
  });
  page.on("response", async (res) => {
    const alvo = porRequisicao.get(res.request());
    if (!alvo) return;
    alvo.status = res.status();
    alvo.corpoRecebido = await res.text().catch(() => null);
  });

  console.log("1. Abrindo a home...");
  await page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  // Aviso de cookies: recusar o que não é essencial. Nunca aceitar.
  await recusarCookies(page);
  await fecharPromocoes(page);

  console.log("2. Preenchendo a busca com 'Pagar com Avios'...");
  const preencheu = await preencherFormulario(page);
  if (!preencheu) {
    console.log("❌ Formulário não ficou como pedido. Foto em fixtures/iberia-erro.png");
    await page.screenshot({ path: foto("erro") });
    await encerrar(page);
    return;
  }

  console.log("3. Esperando o resultado...");
  const temBusca = () =>
    capturas.some((c) => /availability|shopping|flights|fares/i.test(c.url) && (c.corpoRecebido?.length ?? 0) > 2000);

  await esperarAte(page, 25_000, async () => temBusca() || (await pedindoLogin(page)) !== false);

  // Resultado na mão manda mais que qualquer pista de tela: numa execução com a
  // sessão já válida, a caixa promocional "Acesso a Iberia Club" foi lida como
  // pedido de login, o script saiu pra logar de novo e perdeu a busca que já
  // tinha voltado 200. Se a disponibilidade chegou, não há login a fazer.
  const comoPediuLogin = temBusca() ? false : await pedindoLogin(page);
  if (comoPediuLogin) {
    console.log(`   a Iberia pediu login (${comoPediuLogin === "url" ? "redirecionou" : "modal na própria página"}).`);

    // O modal sobe com o iframe `IDY_LoginIframeHeader`, que é só o cabeçalho da
    // caixa — o formulário nunca carrega dentro dele (a primeira foto já mostrava
    // o corpo em branco). Como a página de login inteira funciona, o atalho é ir
    // direto nela em vez de esperar um campo que não vem.
    if (comoPediuLogin === "modal") {
      console.log("   o modal não traz formulário; indo direto pra página de login.");
      await page
        .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch((erro: Error) => console.log(`   (não consegui abrir a página de login: ${erro.message.slice(0, 80)})`));
      await page.waitForTimeout(3000);
    }
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

  // A listagem antes vinha com meia dúzia de chamadas em "status ?": o script
  // fechava a página enquanto elas ainda estavam no ar. O que vem DEPOIS da
  // disponibilidade é justamente onde o preço pode estar.
  if (temBusca()) {
    const antes = capturas.length;
    console.log("   (deixando a página assentar 15s pra ver o que vem depois da disponibilidade)");
    await page.waitForTimeout(15_000);
    if (capturas.length > antes) console.log(`   +${capturas.length - antes} chamada(s) depois da busca.`);
  }

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
    await page.screenshot({ path: foto("resultado") });
    await diagnosticarLogin(page);
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

  await mostrarAviosNaTela(page);
  mostrarClaimsDoBearer(busca);
  await sondarRepeticao(page, busca);
  await sondarCalendario(page, capturas);
  await sondarSelecaoDeVoo(page, capturas);

  await encerrar(page);
}

// A disponibilidade não traz preço, e nenhuma chamada capturada até agora traz.
// Antes de concluir que o número não existe, olha o que está NA TELA: se a
// página mostra "34.000 Avios", ele sai de algum lugar — outra rota, ou conta
// feita no cliente (a Iberia resgata por tabela de distância).
async function mostrarAviosNaTela(page: import("playwright").Page) {
  const achados = (await page
    .evaluate(`(() => {
      const texto = document.body ? document.body.innerText : "";
      const casos = texto.match(/[\\d][\\d.,]*\\s*[Aa]vios/g) || [];
      return { unicos: [...new Set(casos)].slice(0, 20), temPalavra: /avios/i.test(texto) };
    })()`)
    .catch(() => null)) as { unicos: string[]; temPalavra: boolean } | null;

  if (!achados) return console.log("\\n   (não consegui ler a tela)");
  if (achados.unicos.length === 0) {
    console.log(
      `\\n   valores em Avios na tela: NENHUM (a palavra "avios" ${achados.temPalavra ? "aparece" : "não aparece"} na página)`,
    );
    return;
  }
  console.log("\\n   valores em Avios renderizados na tela:");
  for (const v of achados.unicos) console.log(`     ${v}`);
}

// A disponibilidade não traz preço nenhum, e o corpo enviado não tem marca de
// Avios — então ou o contexto de resgate viaja no bearer (emitido depois do
// login), ou esta é a busca em dinheiro e a de Avios é outra. O token é
// credencial: aqui só saem os NOMES das claims, e o valor de um punhado que
// não identifica ninguém. Nada disso vai pra disco.
function mostrarClaimsDoBearer(busca: Captura) {
  const bruto = Object.entries(busca.headers).find(([n]) => n.toLowerCase() === "authorization")?.[1];
  if (!bruto) return console.log("\n   (a chamada de disponibilidade não levou Authorization)");

  const partes = bruto.replace(/^Bearer\s+/i, "").split(".");
  if (partes.length !== 3) return console.log("\n   (o Authorization não é JWT — nada a decodificar)");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(partes[1]!, "base64url").toString("utf8"));
  } catch (erro) {
    return console.log(`\n   (não consegui ler o payload do bearer: ${(erro as Error).message})`);
  }

  const DIVULGAVEIS = /^(scope|typ|type|realm|market|azp|aud|iss|avios|redemption|loyalty|client_id|grant)/i;
  console.log("\n   claims do bearer da disponibilidade:");
  for (const [nome, valor] of Object.entries(payload)) {
    const curto = typeof valor === "string" || typeof valor === "number";
    console.log(`     ${nome}${DIVULGAVEIS.test(nome) && curto ? ` = ${String(valor).slice(0, 60)}` : ""}`);
  }
}

// A tela de disponibilidade não mostra Avios (só o saldo "0 Avios" do cabeçalho)
// e nenhuma das 13 rotas de API traz preço. Resta o passo seguinte do fluxo:
// escolher um voo. Esta sonda clica no primeiro e mostra o que aparece de novo —
// é o que decide se a fonte consegue produzir `valorK` por dia.
async function sondarSelecaoDeVoo(page: import("playwright").Page, capturas: Captura[]) {
  console.log("\n8. Lendo a tela de seleção de voos...");

  // A foto anterior mostrou os cartões mas cortou o rodapé, onde o preço deve
  // estar — e a busca por "N Avios" só achou o saldo do cabeçalho. Em vez de
  // adivinhar rótulo de botão, despeja o texto da tela e olha o que tem lá.
  await page.screenshot({ path: foto("selecao"), fullPage: true }).catch(() => {});
  const texto = (await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "")) as string;
  const linhas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(`   texto da tela (${linhas.length} linhas), primeiras 45:`);
  for (const l of linhas.slice(0, 45)) console.log(`     ${l.slice(0, 100)}`);

  const comNumero = linhas.filter((l) => /\d{1,3}[.,]\d{3}|\bavios\b/i.test(l));
  if (comNumero.length) {
    console.log("   linhas com número grande ou 'avios':");
    for (const l of [...new Set(comNumero)].slice(0, 20)) console.log(`     ${l.slice(0, 100)}`);
  }

  // "Vista mensal de voos" apareceu na tela — é candidato direto a resposta da
  // pergunta que o /calendar deixou em aberto (faixa de datas numa chamada só).
  const antes = capturas.length;
  const mensal = page.locator('a:has-text("Vista mensal"), button:has-text("Vista mensal")').first();
  if (await mensal.isVisible().catch(() => false)) {
    console.log("\n   clicando em 'Vista mensal de voos'...");
    await mensal.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(10_000);
    const novas = capturas.slice(antes);
    console.log(`   ${novas.length} chamada(s) nova(s):`);
    for (const c of novas) {
      console.log(`     ${c.metodo} ${c.url.slice(0, 110)} → ${c.status ?? "?"} | ${c.corpoRecebido?.length ?? 0} bytes`);
      // Sem o corpo enviado não dá pra repetir a chamada — e repetir é o
      // objetivo. Ele entra no log e no disco junto da resposta.
      if (c.corpoEnviado) console.log(`       enviou: ${c.corpoEnviado.slice(0, 500)}`);
      if ((c.corpoRecebido?.length ?? 0) > 500) {
        const nome = `iberia-mensal-${novas.indexOf(c)}.json`;
        fs.writeFileSync(path.join(DIR_FIXTURES, nome), c.corpoRecebido!, "utf8");
        console.log(`       salvo em fixtures/${nome}`);
      }
    }
    await page.screenshot({ path: foto("mensal"), fullPage: true }).catch(() => {});
    await mostrarAviosNaTela(page);
    await sondarGrid(page, capturas);
  } else {
    console.log("   (link 'Vista mensal de voos' não estava visível)");
  }
}

// O `/calendar/grid` devolveu 191 dias pedindo `maxSearchTime: 359`, e começou
// HOJE em vez da data pedida. Antes de desenhar a fonte em cima disso, três
// perguntas: a janela é fixa? a data do corpo move o começo? dá pra cobrir um
// ano? Cada resposta aqui vira (ou não) uma chamada a menos por busca.
async function sondarGrid(page: import("playwright").Page, capturas: Captura[]) {
  const grid = capturas.find((c) => /\/calendar\/grid$/.test(c.url) && c.corpoEnviado);
  if (!grid) return console.log("\n9. (nenhuma chamada de calendar/grid capturada)");

  console.log("\n9. Sondando os limites do /calendar/grid...");
  const PROIBIDOS = /^(host|cookie|connection|content-length|accept-encoding|user-agent|origin|referer|sec-)/i;
  const headers = Object.fromEntries(Object.entries(grid.headers).filter(([n]) => !PROIBIDOS.test(n)));

  const daqui = (dias: number) => {
    const d = new Date();
    d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
  };

  const casos: { nome: string; corpo: string }[] = [
    { nome: "data +200 dias", corpo: grid.corpoEnviado!.replace(/"date":"[^"]*"/, `"date":"${daqui(200)}"`) },
    { nome: "maxSearchTime=720", corpo: grid.corpoEnviado!.replace(/"maxSearchTime":\s*\d+/, '"maxSearchTime":720') },
    {
      nome: "data +200 e maxSearchTime=720",
      corpo: grid
        .corpoEnviado!.replace(/"date":"[^"]*"/, `"date":"${daqui(200)}"`)
        .replace(/"maxSearchTime":\s*\d+/, '"maxSearchTime":720'),
    },
  ];

  for (const caso of casos) {
    const r = (await page.evaluate(
      `((url, headers, corpo) => fetch(url, { method: "POST", headers, body: corpo, credentials: "include" })
        .then(async (x) => ({ status: x.status, texto: await x.text() }))
        .catch((e) => ({ status: -1, texto: String(e) })))(${JSON.stringify(grid.url)}, ${JSON.stringify(headers)}, ${JSON.stringify(caso.corpo)})`,
    )) as { status: number; texto: string };

    if (r.status !== 200) {
      console.log(`   ${caso.nome}: status ${r.status} — ${r.texto.slice(0, 120)}`);
      continue;
    }
    try {
      const j = JSON.parse(r.texto) as {
        outbound?: { availabilityCalendar?: { date: string; avios?: number; lock?: boolean }[] };
      };
      const cal = j.outbound?.availabilityCalendar;
      if (!cal?.length) {
        console.log(`   ${caso.nome}: 200, mas sem availabilityCalendar no corpo.`);
        continue;
      }
      const comAvios = cal.filter((d) => d.avios !== undefined);
      const travados = cal.filter((d) => d.lock === true).length;
      console.log(
        `   ${caso.nome}: ${cal.length} dias (${cal[0]!.date} → ${cal[cal.length - 1]!.date}), ` +
          `${comAvios.length} com avios, ${travados} com lock=true`,
      );
    } catch (erro) {
      console.log(`   ${caso.nome}: 200, mas não consegui ler o JSON (${(erro as Error).message.slice(0, 60)})`);
    }
  }
}

// O calendário decide o custo de varrer um ano: um dia por chamada (359 buscas)
// ou uma faixa por chamada. Ele voltou 404 com marketCode BR, o que cheira a
// rota trocada ou mercado sem o recurso — não a "não existe". Tenta os mercados
// que o próprio site usa antes de a fase seguinte desenhar em cima do dia a dia.
async function sondarCalendario(page: import("playwright").Page, capturas: Captura[]) {
  const calendario = capturas.find((c) => /\/calendar$/.test(c.url) && c.corpoEnviado);
  if (!calendario) return console.log("\n7. (nenhuma chamada de calendário foi capturada)");

  console.log("\n7. Testando o calendário por mercado...");
  const PROIBIDOS = /^(host|cookie|connection|content-length|accept-encoding|user-agent|origin|referer|sec-)/i;
  const headers = Object.fromEntries(Object.entries(calendario.headers).filter(([n]) => !PROIBIDOS.test(n)));

  for (const mercado of ["BR", "US", "ES", "GB"]) {
    const corpo = calendario.corpoEnviado!.replace(/"marketCode"\s*:\s*"[^"]*"/, `"marketCode":"${mercado}"`);
    const r = (await page.evaluate(
      `((url, headers, corpo) => fetch(url, { method: "POST", headers, body: corpo, credentials: "include" })
        .then(async (r) => ({ status: r.status, texto: await r.text() }))
        .catch((e) => ({ status: -1, texto: String(e) })))(${JSON.stringify(calendario.url)}, ${JSON.stringify(headers)}, ${JSON.stringify(corpo)})`,
    )) as { status: number; texto: string };

    console.log(`   marketCode=${mercado}: status ${r.status} | ${r.texto.length} bytes`);
    if (r.status === 200 && r.texto.length > 500) {
      const arquivo = path.join(DIR_FIXTURES, `iberia-calendario-${mercado}.json`);
      fs.writeFileSync(arquivo, r.texto, "utf8");
      console.log(`   ✅ salvo em fixtures/${path.basename(arquivo)}`);
    } else if (r.status !== 200) {
      console.log(`      resposta: ${r.texto.slice(0, 160)}`);
    }
  }
}

// Pergunta 2 da seção 6 das notas — quantos dias vêm por resposta — é o número
// que decide o custo de varrer um ano. Em vez de supor o corpo, esta sonda
// REPETE a requisição que o site acabou de fazer, trocando só a data, e dispara
// de DENTRO da página: quem assina o TLS e manda o cookie é o navegador, que é
// exatamente o que destravou a AA e a Azul (e o que faltou no cheap-flights).
//
// De quebra responde a pergunta 4: se a segunda chamada volta 200, a sessão
// aguenta mais de uma busca.
async function sondarRepeticao(page: import("playwright").Page, busca: Captura) {
  console.log("\n6. Repetindo a mesma chamada com outra data (de dentro da página)...");

  const alvo = `${busca.url}\n${busca.corpoEnviado ?? ""}`;
  const isoNoPedido = alvo.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const brNoPedido = alvo.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] ?? null;
  if (!isoNoPedido && !brNoPedido) {
    console.log("   ⚠️  a data não aparece literal na URL nem no corpo — a repetição precisa ser lida à mão.");
    return;
  }

  // Cabeçalhos que o `fetch` não deixa definir: o navegador põe os dele.
  const PROIBIDOS = /^(host|cookie|connection|content-length|accept-encoding|user-agent|origin|referer|sec-)/i;
  const headers = Object.fromEntries(Object.entries(busca.headers).filter(([n]) => !PROIBIDOS.test(n)));

  for (const deslocamento of [1, 30]) {
    const base = isoNoPedido ?? dataBR_para_iso(brNoPedido!);
    const nova = new Date(base);
    nova.setDate(nova.getDate() + deslocamento);
    const novaIso = nova.toISOString().slice(0, 10);

    let url = busca.url;
    let corpo = busca.corpoEnviado;
    if (isoNoPedido) {
      url = url.replaceAll(isoNoPedido, novaIso);
      corpo = corpo?.replaceAll(isoNoPedido, novaIso) ?? null;
    }
    if (brNoPedido) {
      const novaBr = dataBR(novaIso);
      url = url.replaceAll(brNoPedido, novaBr);
      corpo = corpo?.replaceAll(brNoPedido, novaBr) ?? null;
    }

    const resultado = (await page.evaluate(
      `((url, metodo, headers, corpo) => fetch(url, {
        method: metodo,
        headers,
        body: metodo === "GET" || metodo === "HEAD" ? undefined : corpo,
        credentials: "include",
      }).then(async (r) => ({ status: r.status, texto: await r.text() }))
        .catch((e) => ({ status: -1, texto: String(e) })))(${JSON.stringify(url)}, ${JSON.stringify(busca.metodo)}, ${JSON.stringify(headers)}, ${JSON.stringify(corpo)})`,
    )) as { status: number; texto: string };

    console.log(`   +${deslocamento} dia(s) (${novaIso}): status ${resultado.status} | ${resultado.texto.length} bytes`);
    if (resultado.status === 200 && resultado.texto.length > 2000) {
      const arquivo = path.join(DIR_FIXTURES, `iberia-real-mais${deslocamento}.json`);
      fs.writeFileSync(arquivo, resultado.texto, "utf8");
      console.log(`   salvo em fixtures/${path.basename(arquivo)}`);
    } else if (resultado.status !== 200) {
      console.log(`   ⚠️  repetição não voltou 200 — início da resposta: ${resultado.texto.slice(0, 200)}`);
    }
  }
}

function dataBR_para_iso(br: string): string {
  const [d, m, a] = br.split("/");
  return `${a}-${m}-${d}`;
}

// Em 2026-08 a busca com Avios redirecionava pro `login.iberia.com`. Em
// 2026-09 ela passou a abrir um MODAL na própria home ("Acesso a Iberia Club"),
// sem trocar de URL — foi o que fez o recon desistir achando que não tinha
// pedido login. Agora olha os dois caminhos, e diz por qual reconheceu.
async function pedindoLogin(page: import("playwright").Page): Promise<false | "url" | "modal"> {
  if (/login\.iberia\.com/.test(page.url())) return "url";
  if (page.frames().some((f) => /login\.iberia|ibisauth\.iberia/.test(f.url()))) return "modal";
  const temModal = await page
    .evaluate(`(() => {
      const marcas = ["acesso a iberia club", "inicie sessão", "iniciar sessão"];
      const grande = (e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 150; };
      return [...document.querySelectorAll("dialog,[role=dialog],div,section")].some(
        (e) => grande(e)
          && marcas.some((m) => (e.innerText || "").toLowerCase().includes(m))
          && (e.querySelector("input") || e.querySelector("iframe")),
      );
    })()`)
    .catch(() => false);
  return temModal ? "modal" : false;
}

// Quando o recon não acha disponibilidade, o que decide o próximo passo é o que
// está na tela — então despeja em vez de adivinhar: frames, e o HTML do que
// parece caixa de login. É daqui que saem os seletores da próxima fase.
async function diagnosticarLogin(page: import("playwright").Page) {
  console.log("\n   diagnóstico da tela:");
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    console.log(`     frame: ${f.url().slice(0, 140)}`);
  }
  const caixa = (await page
    .evaluate(`(() => {
      const marcas = ["acesso a iberia club", "inicie sessão", "iniciar sessão"];
      const grande = (e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 150; };
      const alvo = [...document.querySelectorAll("dialog,[role=dialog],div,section")].find(
        (e) => grande(e)
          && marcas.some((m) => (e.innerText || "").toLowerCase().includes(m))
          && (e.querySelector("input") || e.querySelector("iframe")),
      );
      if (!alvo) return null;
      return {
        tag: alvo.tagName,
        classe: alvo.className,
        html: alvo.outerHTML.slice(0, 3000),
        campos: [...alvo.querySelectorAll("input,button,iframe")].map(
          (e) => e.tagName + " type=" + e.getAttribute("type") + " name=" + e.getAttribute("name")
            + " id=" + e.id + " src=" + (e.getAttribute("src") || "").slice(0, 80),
        ),
      };
    })()`)
    .catch(() => null)) as { tag: string; classe: string; html: string; campos: string[] } | null;

  if (!caixa) {
    console.log("     (nenhuma caixa de login reconhecida na tela)");
    return;
  }
  console.log(`     caixa: <${caixa.tag} class="${String(caixa.classe).slice(0, 80)}">`);
  for (const c of caixa.campos) console.log(`       ${c}`);
  const arquivo = path.join(DIR_FIXTURES, "iberia-login-modal.html");
  fs.writeFileSync(arquivo, caixa.html, "utf8");
  console.log(`     HTML do modal salvo em fixtures/${path.basename(arquivo)}`);
}

// Mesmo acordo do módulo da LATAM (`preencherCredenciais` em bot-latam.ts): se
// IBERIA_EMAIL e IBERIA_SENHA estiverem no .env, o script adianta a digitação.
// Ele **não confirma o login** — o clique em "Fazer login" fica com você, que é
// onde entram 2FA, captcha e qualquer coisa que a Iberia resolva pedir.
//
// As credenciais moram só no seu .env (que está no .gitignore). Nada é impresso
// no terminal nem guardado em outro lugar.
type ContextoLogin = import("playwright").Page | import("playwright").Frame;

async function preencherCredenciais(
  page: import("playwright").Page,
): Promise<"enviado" | "parcial" | "ausente"> {
  const email = process.env.IBERIA_EMAIL;
  const senha = process.env.IBERIA_SENHA;
  if (!email || !senha) {
    console.log("   (sem IBERIA_EMAIL/IBERIA_SENHA no .env — o login é todo na mão, na janela do bot)");
    return "ausente";
  }

  try {
    // O aviso de cookies cobre esta página também, e o filtro dele engole cliques.
    await recusarCookies(page);

    // O login sai por dois caminhos: redirecionamento pro `login.iberia.com` ou
    // modal na própria home. No modal o formulário vive num iframe de
    // `www.iberia.com/integration/ibplus/login/` (aparece no `redirect_uri` das
    // capturas) — filtrar frames por "login.iberia" excluía justamente esse, e
    // o script ficava dez minutos esperando um preenchimento manual.
    // Agora procura em TODOS os frames, e espera o iframe carregar.
    const SELETOR_EMAIL =
      'input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]';

    let onde: ContextoLogin | null = null;
    const limite = Date.now() + 25_000;
    while (!onde && Date.now() < limite) {
      for (const ctx of [page, ...page.frames()]) {
        const visivel = await ctx
          .locator(SELETOR_EMAIL)
          .first()
          .isVisible()
          .catch(() => false);
        if (visivel) {
          onde = ctx;
          break;
        }
      }
      if (!onde) await page.waitForTimeout(1500);
    }

    if (!onde) {
      const frames = page.frames().map((f) => f.url().slice(0, 90) || "(sem url)");
      console.log("   não achei o campo de e-mail em nenhum frame — siga na mão na janela do bot.");
      console.log(`   frames na página: ${JSON.stringify(frames)}`);
      return "parcial";
    }
    if (onde !== page) console.log(`   formulário de login está no iframe ${onde.url().slice(0, 90)}`);

    const campoEmail = onde.locator(SELETOR_EMAIL).first();
    const campoSenha = onde.locator('input[type="password"]').first();

    await campoEmail.waitFor({ state: "visible", timeout: 20_000 });
    await campoEmail.fill(email);

    // Login em duas etapas: se a senha ainda não está na tela, o "continuar"
    // é que a traz. Uma rodada de submit só pra isso, depois a de verdade.
    if (!(await campoSenha.isVisible().catch(() => false))) {
      console.log("   campo de senha fora da tela — enviando o e-mail primeiro.");
      await enviarFormulario(onde);
      await campoSenha.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    }

    if (!(await campoSenha.isVisible().catch(() => false))) {
      console.log("   a senha não apareceu — siga na janela do bot.");
      return "parcial";
    }

    await campoSenha.fill(senha);
    if (!(await enviarFormulario(onde))) {
      console.log("   campos preenchidos, mas não achei o botão de enviar — o clique é seu, na janela do bot.");
      return "parcial";
    }
    return "enviado";
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message.split("\n")[0] : String(erro);
    console.log(`   não consegui preencher o login (${motivo}) — siga na mão na janela do bot.`);
    return "parcial";
  }
}

// O seletor das notas é o do Salesforce Identity; o modal pode usar outro, então
// cai pro primeiro botão com cara de enviar. Diz qual pegou — se a Iberia mudar
// de novo, o log já entrega o que quebrou.
async function enviarFormulario(onde: ContextoLogin): Promise<boolean> {
  const candidatos = [
    'input[name="loginPage:theForm:loginSubmit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Fazer login")',
    'button:has-text("Iniciar sessão")',
    'button:has-text("Entrar")',
    'button:has-text("Continuar")',
  ];
  for (const seletor of candidatos) {
    const botao = onde.locator(seletor).first();
    if (!(await botao.isVisible().catch(() => false))) continue;
    await botao.click({ timeout: 10_000 }).catch(() => {});
    console.log(`   enviei o formulário de login (${seletor}).`);
    return true;
  }
  return false;
}

// A busca com Avios não chama disponibilidade nenhuma sem conta: ela redireciona
// pro login. Então o script para aqui e devolve o volante — a senha é sua e não
// passa por este processo.
async function esperarLoginManual(page: import("playwright").Page): Promise<boolean> {
  await page.bringToFront().catch(() => {});
  const tentativa = await preencherCredenciais(page);
  const minutos = Math.round(ESPERA_LOGIN_MS / 60000);

  // Com credencial no .env o script entra sozinho; o aviso abaixo só faz
  // sentido quando sobrou passo pra pessoa (2FA, captcha, seletor que mudou).
  if (tentativa === "enviado") {
    console.log(`   login enviado a partir do .env — esperando a sessão abrir (até ${minutos} min).`);
    console.log("   se a Iberia pedir 2FA ou captcha, a janela do bot está aberta pra você concluir.");
  } else {
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
  }

  const limite = Date.now() + ESPERA_LOGIN_MS;
  let ultimo = "";
  while (Date.now() < limite) {
    await page.waitForTimeout(3000);
    if (!(await pedindoLogin(page))) {
      console.log(`   ✅ login concluído — a tela saiu do login (${page.url().slice(0, 80)})`);
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
// Além do aviso de cookies, a home sobe promoções que cobrem o formulário — uma
// delas ("Esperar ou explorar? Últimos dias...") engoliu o clique em Pesquisar e
// a busca não saiu da home. Fecha só o que é promoção, pelo botão da própria
// caixa; nada de aceitar nem consentir coisa alguma.
async function fecharPromocoes(page: import("playwright").Page) {
  const fechados = await page.evaluate(`(() => {
    const rotulos = ["fechar", "cerrar", "close", "×", "x"];
    const visivel = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let n = 0;
    for (const e of document.querySelectorAll("button,[role=button],a")) {
      const t = (e.innerText || e.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!visivel(e) || !rotulos.includes(t)) continue;
      // Só fecha o que está numa camada sobreposta: fixed/absolute com z-index.
      const caixa = e.closest("[class*=modal],[class*=popup],[class*=overlay],[class*=banner],[role=dialog]");
      if (!caixa) continue;
      e.click();
      n++;
    }
    return n;
  })()`);
  if ((fechados as number) > 0) {
    console.log(`   (fechei ${fechados} promoção(ões) que cobriam o formulário)`);
    await page.waitForTimeout(1200);
  }
}

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

// Digitar "MAD" lista Madrid E Madison — o `ArrowDown + Enter` às cegas pegava
// o primeiro da lista, que numa das execuções foi Madison (MSN). Aqui a opção é
// escolhida pelo CÓDIGO: só cai no comportamento antigo se não achar nada com
// ele, e sempre diz no log o que ficou no campo.
async function escolherAeroporto(
  page: import("playwright").Page,
  seletor: string,
  codigo: string,
  rotulo: string,
): Promise<boolean> {
  // A lista de sugestões responde ao teclado mas NÃO aparece no DOM que dá pra
  // varrer (nem por tag, nem por classe, nem por texto — a varredura genérica
  // voltou vazia). Então em vez de tentar ler a lista, usa o que funciona e
  // confere o resultado: desce uma posição por vez e só aceita quando o campo
  // ficar com o código pedido. Digitar "MAD" oferece Madrid E Madison, e a
  // ordem muda entre execuções — foi assim que uma busca inteira saiu pra
  // Madison sem ninguém perceber.
  const MAX_POSICOES = 8;
  for (let descidas = 1; descidas <= MAX_POSICOES; descidas++) {
    await page.fill(seletor, "");
    await page.waitForTimeout(300);
    await page.type(seletor, codigo, { delay: 120 });
    await page.waitForTimeout(2000);

    for (let i = 0; i < descidas; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);

    const valor = await page.inputValue(seletor).catch(() => "");
    if (valor.includes(`(${codigo})`)) {
      console.log(`   ${rotulo} ${codigo}: "${valor}" (${descidas}ª opção da lista)`);
      return true;
    }
    if (descidas === 1) console.log(`   ${rotulo} ${codigo}: 1ª opção era "${valor}" — procurando o código na lista...`);
  }

  const valor = await page.inputValue(seletor).catch(() => "");
  console.log(`   ❌ ${rotulo}: não achei ${codigo} nas ${MAX_POSICOES} primeiras opções; campo ficou com "${valor}".`);
  return false;
}

// Seletores conferidos na página (o botão visível é uma lupa; o `Pesquisar` de
// verdade é #buttonSubmit1, e o checkbox de Avios só reage pelo rótulo).
async function preencherFormulario(page: import("playwright").Page): Promise<boolean> {
  try {
    const achouOrigem = await escolherAeroporto(page, "#flight_origin1", origem.toUpperCase(), "origem");
    const achouDestino = await escolherAeroporto(page, "#flight_destiny1", destino.toUpperCase(), "destino");
    if (!achouOrigem || !achouDestino) return false;

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
      await page.screenshot({ path: foto("avios") });
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

    await fecharPromocoes(page);
    await page.locator("#buttonSubmit1").first().click({ timeout: 10_000, force: true });

    // Conferência que faltava: a URL do resultado carrega os códigos escolhidos.
    // Sem isso, uma busca pro aeroporto errado volta "não encontramos assentos"
    // e passa por resposta legítima — foi o que aconteceu com MAD virando MSN.
    await page.waitForTimeout(6000);
    const url = page.url();
    const pedido = { BEGIN_CITY_01: origem.toUpperCase(), END_CITY_01: destino.toUpperCase() };
    for (const [campo, esperado] of Object.entries(pedido)) {
      const obtido = new RegExp(`${campo}=([A-Z]{3})`).exec(url)?.[1];
      if (obtido && obtido !== esperado) {
        console.log(`   ❌ o site buscou ${campo}=${obtido}, e não ${esperado} — o autocomplete pegou outro aeroporto.`);
        console.log("      resultado descartado: buscar destino errado devolve 'sem assentos' e parece resposta boa.");
        return false;
      }
    }
    return true;
  } catch (erro) {
    console.log(`   (falhou: ${(erro as Error).message.slice(0, 200)})`);
    return false;
  }
}

// Espera por uma condição em vez de por um tempo fixo: o que interessa é a
// captura chegar, não o relógio.
async function esperarAte(
  page: import("playwright").Page,
  limiteMs: number,
  pronto: () => boolean | Promise<boolean>,
) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim && !(await pronto())) await page.waitForTimeout(1000);
}

async function encerrar(page: import("playwright").Page) {
  await page.close();
  process.exit(0);
}

main();
