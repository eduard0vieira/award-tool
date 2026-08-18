import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abrirSessaoChrome } from "../src/nucleo/sessao-chrome.ts";

// FASE 0 do módulo Azul: descobrir de onde a chamada precisa sair, e com quais
// credenciais de sessão, ANTES de escrever qualquer linha de parsing.
//
// O que se sabe do projeto antigo (projetos/cheap-flights, ver ANALISE.md lá):
// - endpoint de pontos: b2c-api.voeazul.com.br/tudoAzulReservationAvailability/
//   api/tudoazul/reservation/availability/v5/availability  (o gerador de headers
//   do mesmo repo aponta pra v6 — a divergência é uma das perguntas daqui);
// - é POST, e o corpo aceita ATÉ 6 DATAS de uma vez (array `criteria`), com
//   flexibleDays ±3. Se confirmar, um ano custa ~61 requisições por direção;
// - a autenticação é um `Authorization` de sessão + `Ocp-Apim-Subscription-Key`.
//   No projeto antigo os dois eram colados à mão — foi exatamente isso que
//   apodreceu e virou 403.
//
// A estratégia aqui é a mesma que funcionou na AA e no Smiles: deixar o site
// gerar as credenciais e escutar. Nada é clicado — o deep link `selecao-voo`
// com `cc=PTS` cai direto no resultado em pontos.
//
// Perguntas que este recon precisa responder:
//   1. o deep link chega ao resultado sem passar por formulário?
//   2. qual endpoint/versão o site chama HOJE, e com que headers?
//   3. quantas datas voltam por resposta (o array `criteria` funciona mesmo)?
//   4. dá pra repetir a chamada de dentro da página, com outra data?
//
// Uso: npx tsx scripts/recon-azul.ts [VCP] [REC] [2026-10-15]

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_FIXTURES = path.join(__dirname, "..", "fixtures");

const [origem = "VCP", destino = "REC", data = dataDaqui(60)] = process.argv.slice(2);

function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// O formato que o site usa na URL é M/D/AAAA, não ISO.
function dataBarra(iso: string): string {
  const [a, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${a}`;
}

function deepLink(): string {
  const p = new URLSearchParams({
    "c[0].ds": origem.toUpperCase(),
    "c[0].std": dataBarra(data),
    "c[0].as": destino.toUpperCase(),
    "p[0].t": "ADT",
    "p[0].c": "1",
    "p[0].cp": "false",
    "f.dl": "3",
    "f.dr": "3",
    cc: "PTS",
  });
  return `https://www.voeazul.com.br/br/pt/home/selecao-voo?${p}`;
}

// Cabeçalhos que carregam sessão. O VALOR nunca é impresso nem salvo: o que
// interessa aqui é saber QUE eles existem e de onde vêm.
const SIGILOSOS = ["authorization", "cookie", "ocp-apim-subscription-key", "x-csrf-token"];

function mascarar(nome: string, valor: string): string {
  if (!SIGILOSOS.includes(nome.toLowerCase())) return valor;
  return `<${valor.length} chars — não impresso>`;
}

type Captura = {
  url: string;
  metodo: string;
  headers: Record<string, string>;
  corpoEnviado: string | null;
  status: number | null;
  corpoRecebido: string | null;
};

async function main() {
  console.log(`\nRecon Azul — ${origem.toUpperCase()}→${destino.toUpperCase()} em ${data}`);
  console.log(`Deep link: ${deepLink()}\n`);

  const sessao = await abrirSessaoChrome(false, "recon-azul");
  const page = sessao.page;
  const capturas: Captura[] = [];

  const interessa = (u: string) => u.includes("b2c-api.voeazul.com.br") || u.includes("/availability");

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
    try {
      alvo.corpoRecebido = await res.text();
    } catch (erro) {
      // Corpo já descartado pelo navegador: registra a falha em vez de fingir
      // que a resposta veio vazia.
      alvo.corpoRecebido = null;
      console.log(`   (não deu pra ler o corpo de ${res.url()}: ${(erro as Error).message})`);
    }
  });

  // Por que uma chamada falha "na rede" é a pergunta do degrau 4: o motivo do
  // Chrome (CORS, bloqueio, DNS) só aparece nestes dois eventos.
  page.on("requestfailed", (req) => {
    if (!interessa(req.url())) return;
    console.log(`   [rede] ${req.method()} ${req.url().slice(0, 90)} → ${req.failure()?.errorText}`);
  });
  page.on("console", (msg) => {
    const t = msg.text();
    if (/CORS|Access-Control|blocked|preflight/i.test(t)) console.log(`   [console] ${t.slice(0, 300)}`);
  });

  console.log("1. Abrindo o deep link (nada é clicado — nem o aviso de cookies)...");
  await page.goto(deepLink(), { waitUntil: "domcontentloaded", timeout: 90_000 });

  // O resultado carrega por XHR depois da página; espera pela captura, não por
  // um seletor de tela (a tela muda mais do que a rede).
  const éBusca = (c: Captura) => c.metodo === "POST" && c.url.includes("/availability/") && c.url.endsWith("availability");
  const limite = Date.now() + 60_000;
  while (Date.now() < limite && !capturas.some((c) => éBusca(c) && c.status !== null)) {
    await page.waitForTimeout(1000);
  }

  console.log(`\n2. Onde a página parou: ${page.url()}`);
  console.log(`   Título: ${await page.title()}`);
  console.log(`   Chamadas à API capturadas: ${capturas.length}\n`);

  if (capturas.length === 0) {
    console.log("❌ Nenhuma. O deep link não chegou ao resultado — ou a busca sai por outro host.");
    await encerrar(page);
    return;
  }

  for (const c of capturas) {
    console.log(`── ${c.metodo} ${c.url}`);
    console.log(`   status: ${c.status ?? "sem resposta"} | corpo recebido: ${c.corpoRecebido?.length ?? 0} bytes`);
    console.log("   headers da requisição:");
    for (const [nome, valor] of Object.entries(c.headers)) {
      console.log(`     ${nome}: ${mascarar(nome, valor)}`);
    }
    if (c.corpoEnviado) {
      console.log(`   corpo enviado (${c.corpoEnviado.length} bytes):`);
      console.log(`     ${c.corpoEnviado.slice(0, 1200)}`);
    }
    console.log();
  }

  const boa = capturas.find((c) => éBusca(c) && c.status === 200 && c.corpoRecebido);
  if (!boa || !boa.corpoRecebido) {
    console.log("❌ Nenhuma resposta 200 com corpo — nada salvo (fixture de erro não serve de schema).");
    await encerrar(page);
    return;
  }

  fs.mkdirSync(DIR_FIXTURES, { recursive: true });
  const destinoArq = path.join(DIR_FIXTURES, "azul-real.json");
  fs.writeFileSync(destinoArq, boa.corpoRecebido, "utf8");
  console.log(`✅ Resposta crua salva em fixtures/azul-real.json (${boa.corpoRecebido.length} bytes).`);
  console.log("   Só o corpo da resposta — nenhum header de sessão foi pro arquivo.\n");

  // Quantas datas vieram? É o número que decide o custo de um ano.
  try {
    const j = JSON.parse(boa.corpoRecebido) as { data?: { trips?: { std?: string }[] } };
    const trips = j.data?.trips ?? [];
    const datas = [...new Set(trips.map((t) => (t.std ?? "").split("T")[0]).filter(Boolean))];
    console.log(`3. Datas distintas nesta única resposta: ${datas.length}`);
    console.log(`   ${datas.join(", ") || "(nenhuma)"}`);
    console.log(`   → um ano por direção custaria ~${datas.length ? Math.ceil(365 / datas.length) : "?"} requisições.\n`);
  } catch {
    console.log("3. O corpo não é o JSON esperado — abra a fixture e olhe.\n");
  }

  if (process.env.PULAR_DEGRAUS !== "true") {
    console.log("4. Repetindo a chamada de DENTRO da página, com outra data...");
    await repetirDeDentro(page, boa);
  }

  console.log("\n5. Sequestrando a chamada do próprio site (troca só o corpo)...");
  await sequestrar(page);

  await encerrar(page);
}

// Degrau final e mais importante: nós conseguimos DIRIGIR a busca?
//
// A primeira tentativa (window.fetch, dentro da página) falhou com "Failed to
// fetch", e o stack mostrou por quê: o site embrulha window.fetch num script de
// anti-bot. Então aqui vai uma escada de transportes, do mais parecido com o
// site pro menos, até um responder.
//
// Depois disso, a pergunta de custo: o array `criteria` aceita várias datas de
// uma vez? O site manda uma por chamada; o projeto antigo mandava seis. Se seis
// funcionar, um ano custa ~61 requisições por direção em vez de 365.
type Transporte = { nome: string; enviar: (corpo: unknown) => Promise<Resposta> };
type Resposta = { status: number | string; tam: number; corpo: string };

function criterio(iso: string) {
  const [a, m, d] = iso.split("-").map(Number);
  return {
    departureStation: origem.toUpperCase(),
    arrivalStation: destino.toUpperCase(),
    std: `${m}/${d}/${a}`,
    departureDate: iso,
  };
}

function corpoBusca(quantasDatas: number) {
  return {
    criteria: Array.from({ length: quantasDatas }, (_, k) => criterio(dataDaqui(90 + k * 7))),
    passengers: [{ type: "ADT", count: "1", companionPass: false }],
    flexibleDays: { daysToLeft: "3", daysToRight: "3" },
    currencyCode: "BRL",
  };
}

function datasDe(corpo: string): string[] {
  try {
    const j = JSON.parse(corpo) as { data?: { trips?: { std?: string }[] } };
    return [...new Set((j.data?.trips ?? []).map((t) => (t.std ?? "").split("T")[0] ?? "").filter(Boolean))];
  } catch {
    return [];
  }
}

async function repetirDeDentro(page: import("playwright").Page, base: Captura) {
  // Só os headers que a aplicação define. `referer`, `user-agent` e `sec-ch-*`
  // são do navegador — o fetch os ignora, e mandá-los não muda nada.
  const DA_APP = ["authorization", "ocp-apim-subscription-key", "device", "culture", "accept", "content-type"];
  const headers: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(base.headers)) {
    if (DA_APP.includes(nome.toLowerCase())) headers[nome.toLowerCase()] = valor;
  }
  if (!headers.authorization) {
    console.log("   (a chamada capturada não tinha authorization — pulando)");
    return;
  }
  const url = base.url;

  const transportes: Transporte[] = [
    {
      nome: "fetch da página",
      enviar: (b) =>
        page.evaluate(
          async ({ u, h, b }) => {
            try {
              const res = await fetch(u, { method: "POST", headers: h as Record<string, string>, body: JSON.stringify(b) });
              const t = await res.text();
              return { status: res.status as number | string, tam: t.length, corpo: t };
            } catch (erro) {
              return { status: `falhou: ${(erro as Error).message}`, tam: 0, corpo: "" };
            }
          },
          { u: url, h: headers, b },
        ),
    },
    {
      nome: "XMLHttpRequest",
      enviar: (b) =>
        page.evaluate(
          ({ u, h, b }) =>
            new Promise<{ status: number | string; tam: number; corpo: string }>((ok) => {
              const x = new XMLHttpRequest();
              x.open("POST", u, true);
              for (const [n, v] of Object.entries(h as Record<string, string>)) x.setRequestHeader(n, v);
              x.onload = () => ok({ status: x.status, tam: x.responseText.length, corpo: x.responseText });
              x.onerror = () => ok({ status: "falhou: erro de rede", tam: 0, corpo: "" });
              x.send(JSON.stringify(b));
            }),
          { u: url, h: headers, b },
        ),
    },
    {
      nome: "fetch de iframe novo (sem o embrulho do anti-bot)",
      enviar: (b) =>
        page.evaluate(
          async ({ u, h, b }) => {
            const quadro = document.createElement("iframe");
            quadro.style.display = "none";
            document.body.appendChild(quadro);
            try {
              const limpo = (quadro.contentWindow as Window & typeof globalThis).fetch;
              const res = await limpo.call(quadro.contentWindow, u, {
                method: "POST",
                headers: h as Record<string, string>,
                body: JSON.stringify(b),
              });
              const t = await res.text();
              return { status: res.status as number | string, tam: t.length, corpo: t };
            } catch (erro) {
              return { status: `falhou: ${(erro as Error).message}`, tam: 0, corpo: "" };
            } finally {
              quadro.remove();
            }
          },
          { u: url, h: headers, b },
        ),
    },
    {
      nome: "requisição do Playwright (fora do JS da página)",
      enviar: async (b) => {
        try {
          const res = await page.context().request.post(url, { headers, data: b as object });
          const t = await res.text();
          return { status: res.status(), tam: t.length, corpo: t };
        } catch (erro) {
          return { status: `falhou: ${(erro as Error).message}`, tam: 0, corpo: "" };
        }
      },
    },
  ];

  let vencedor: Transporte | null = null;
  for (const t of transportes) {
    const r = await t.enviar(corpoBusca(1));
    const datas = datasDe(r.corpo);
    console.log(`   ${t.nome}: status ${r.status} | ${r.tam} bytes | ${datas.length} data(s)`);
    if (r.status !== 200 && r.corpo) console.log(`      amostra: ${r.corpo.slice(0, 200)}`);
    if (r.status === 200 && datas.length > 0) {
      vencedor = t;
      break;
    }
  }

  if (!vencedor) {
    console.log("\n⚠️  Nenhum transporte disparou a busca. O módulo teria que navegar por deep link a cada data —");
    console.log("    funciona, mas custa um carregamento de página inteiro por consulta.");
    return;
  }

  console.log(`\n✅ Dá pra dirigir a busca por: ${vencedor.nome}`);
  console.log("\n5. Quantas datas cabem numa chamada?");
  for (const quantas of [3, 6, 12]) {
    const r = await vencedor.enviar(corpoBusca(quantas));
    const datas = datasDe(r.corpo);
    console.log(`   criteria com ${quantas} → status ${r.status} | ${datas.length} data(s) na resposta | ${r.tam} bytes`);
    if (r.status !== 200 && r.corpo) console.log(`      amostra: ${r.corpo.slice(0, 200)}`);
    await page.waitForTimeout(2000);
  }
}

// Se nenhuma chamada nossa passa, sobra deixar o SITE fazer a chamada dele — com
// todos os cabeçalhos e cookies de anti-bot que só ele sabe montar — e trocar só
// o corpo no caminho. Se o array `criteria` aceitar várias datas, uma navegação
// rende várias datas.
async function sequestrar(page: import("playwright").Page) {
  // Quantas datas cabem numa chamada é o número que define o custo de um ano.
  // Configurável porque a resposta se acha por tentativa: LOTES=6,8,10
  const LOTES = (process.env.LOTES ?? "1,6,12").split(",").map(Number);
  for (const quantas of LOTES) {
    let trocou = false;
    let resposta: { status: number; corpo: string } | null = null;

    await page.route("**/availability/v*/availability", async (rota) => {
      if (trocou) return rota.continue();
      trocou = true;
      await rota.continue({ postData: JSON.stringify(corpoBusca(quantas)) });
    });

    const pegar = page.waitForResponse(
      (r) => /availability\/v\d+\/availability$/.test(r.url()),
      { timeout: 60_000 },
    );
    await page.goto(deepLink(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    try {
      const r = await pegar;
      resposta = { status: r.status(), corpo: await r.text() };
    } catch {
      resposta = null;
    }
    await page.unroute("**/availability/v*/availability");

    if (!resposta) {
      console.log(`   criteria com ${quantas} → nenhuma resposta em 60s`);
      continue;
    }
    const datas = datasDe(resposta.corpo);
    console.log(
      `   criteria com ${quantas} → status ${resposta.status} | ${resposta.corpo.length} bytes | ${datas.length} data(s) na resposta`,
    );
    if (datas.length) console.log(`     ${datas.join(", ")}`);
    if (resposta.status !== 200) console.log(`     amostra: ${resposta.corpo.slice(0, 200)}`);

    if (quantas === Math.max(...LOTES) && datas.length > 0) {
      fs.writeFileSync(path.join(DIR_FIXTURES, "azul-real-multidata.json"), resposta.corpo, "utf8");
      console.log("   ✅ fixture multi-data salva em fixtures/azul-real-multidata.json");
    }
  }
}

async function encerrar(page: import("playwright").Page) {
  await page.close();
  process.exit(0);
}

main();
