import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// PHASE 0 of the Azul source: find out where the call must come from, and with
// which session credentials, BEFORE writing a single parsing line.
//
// What was known from the old project (projetos/cheap-flights, see its ANALISE.md):
// - points endpoint: b2c-api.voeazul.com.br/tudoAzulReservationAvailability/
//   api/tudoazul/reservation/availability/v5/availability (the same repo's
//   header generator points to v6; the mismatch is one of the questions here);
// - it is a POST whose body takes UP TO 6 DATES at once (the `criteria` array)
//   with flexibleDays ±3. If confirmed, a year costs ~61 requests per direction;
// - authentication is a session `Authorization` plus `Ocp-Apim-Subscription-Key`.
//   In the old project both were pasted by hand, which is exactly what rotted into 403s.
//
// The strategy is the one that worked for AA and Smiles: let the site generate
// the credentials and listen. Nothing is clicked: the `selecao-voo` deep link
// with `cc=PTS` lands straight on the points result.
//
// Questions this recon must answer:
//   1. does the deep link reach the result without a form?
//   2. which endpoint and version does the site call TODAY, with which headers?
//   3. how many dates come back per response (does `criteria` really work)?
//   4. can the call be repeated from inside the page with another date?
//
// Usage: npx tsx scripts/recon-azul.ts [VCP] [REC] [2026-10-15]

const [origin = "VCP", destination = "REC", date = daysFromToday(60)] = process.argv.slice(2);

function daysFromToday(days: number): string {
  const today = new Date();
  today.setDate(today.getDate() + days);
  return today.toISOString().slice(0, 10);
}

// The site's URL uses M/D/YYYY, not ISO.
function slashedDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}/${year}`;
}

function deepLink(): string {
  const query = new URLSearchParams({
    "c[0].ds": origin.toUpperCase(),
    "c[0].std": slashedDate(date),
    "c[0].as": destination.toUpperCase(),
    "p[0].t": "ADT",
    "p[0].c": "1",
    "p[0].cp": "false",
    "f.dl": "3",
    "f.dr": "3",
    cc: "PTS",
  });
  return `https://www.voeazul.com.br/br/pt/home/selecao-voo?${query}`;
}

// Headers carrying the session. The VALUE is never printed or saved: what
// matters here is knowing THAT they exist and where they come from.
const SECRET_HEADERS = ["authorization", "cookie", "ocp-apim-subscription-key", "x-csrf-token"];

function mask(name: string, value: string): string {
  if (!SECRET_HEADERS.includes(name.toLowerCase())) return value;
  return `<${value.length} chars — não impresso>`;
}

type Capture = {
  url: string;
  method: string;
  headers: Record<string, string>;
  sentBody: string | null;
  status: number | null;
  receivedBody: string | null;
};

async function main() {
  console.log(`\nRecon Azul — ${origin.toUpperCase()}→${destination.toUpperCase()} em ${date}`);
  console.log(`Deep link: ${deepLink()}\n`);

  const session = await openChromeSession(false, "recon-azul");
  const page = session.page;
  const captures: Capture[] = [];

  const isRelevant = (url: string) => url.includes("b2c-api.voeazul.com.br") || url.includes("/availability");

  page.on("request", (request) => {
    if (!isRelevant(request.url())) return;
    captures.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      sentBody: request.postData(),
      status: null,
      receivedBody: null,
    });
  });

  page.on("response", async (response) => {
    if (!isRelevant(response.url())) return;
    const capture = captures.find((candidate) => candidate.url === response.url() && candidate.status === null);
    if (!capture) return;
    capture.status = response.status();
    try {
      capture.receivedBody = await response.text();
    } catch (error) {
      // The browser already discarded the body: record the failure instead of
      // pretending the response came back empty.
      capture.receivedBody = null;
      console.log(`   (não deu pra ler o corpo de ${response.url()}: ${(error as Error).message})`);
    }
  });

  // Why a call fails "on the network" is step 4's question: Chrome's reason
  // (CORS, block, DNS) only shows in these two events.
  page.on("requestfailed", (request) => {
    if (!isRelevant(request.url())) return;
    console.log(`   [rede] ${request.method()} ${request.url().slice(0, 90)} → ${request.failure()?.errorText}`);
  });
  page.on("console", (message) => {
    const text = message.text();
    if (/CORS|Access-Control|blocked|preflight/i.test(text)) console.log(`   [console] ${text.slice(0, 300)}`);
  });

  console.log("1. Abrindo o deep link (nada é clicado — nem o aviso de cookies)...");
  await page.goto(deepLink(), { waitUntil: "domcontentloaded", timeout: 90_000 });

  // The result loads by XHR after the page; wait for the capture, not for a
  // screen selector (the screen changes more than the network).
  const isSearch = (capture: Capture) =>
    capture.method === "POST" && capture.url.includes("/availability/") && capture.url.endsWith("availability");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !captures.some((capture) => isSearch(capture) && capture.status !== null)) {
    await page.waitForTimeout(1000);
  }

  console.log(`\n2. Onde a página parou: ${page.url()}`);
  console.log(`   Título: ${await page.title()}`);
  console.log(`   Chamadas à API capturadas: ${captures.length}\n`);

  if (captures.length === 0) {
    console.log("❌ Nenhuma. O deep link não chegou ao resultado — ou a busca sai por outro host.");
    await finish(page);
    return;
  }

  for (const capture of captures) {
    console.log(`── ${capture.method} ${capture.url}`);
    console.log(`   status: ${capture.status ?? "sem resposta"} | corpo recebido: ${capture.receivedBody?.length ?? 0} bytes`);
    console.log("   headers da requisição:");
    for (const [name, value] of Object.entries(capture.headers)) {
      console.log(`     ${name}: ${mask(name, value)}`);
    }
    if (capture.sentBody) {
      console.log(`   corpo enviado (${capture.sentBody.length} bytes):`);
      console.log(`     ${capture.sentBody.slice(0, 1200)}`);
    }
    console.log();
  }

  const good = captures.find((capture) => isSearch(capture) && capture.status === 200 && capture.receivedBody);
  if (!good || !good.receivedBody) {
    console.log("❌ Nenhuma resposta 200 com corpo — nada salvo (fixture de erro não serve de schema).");
    await finish(page);
    return;
  }

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES_DIR, "azul-real.json"), good.receivedBody, "utf8");
  console.log(`✅ Resposta crua salva em fixtures/azul-real.json (${good.receivedBody.length} bytes).`);
  console.log("   Só o corpo da resposta — nenhum header de sessão foi pro arquivo.\n");

  // How many dates came back decides the cost of a year.
  try {
    const json = JSON.parse(good.receivedBody) as { data?: { trips?: { std?: string }[] } };
    const trips = json.data?.trips ?? [];
    const dates = [...new Set(trips.map((trip) => (trip.std ?? "").split("T")[0]).filter(Boolean))];
    console.log(`3. Datas distintas nesta única resposta: ${dates.length}`);
    console.log(`   ${dates.join(", ") || "(nenhuma)"}`);
    console.log(`   → um ano por direção custaria ~${dates.length ? Math.ceil(365 / dates.length) : "?"} requisições.\n`);
  } catch {
    console.log("3. O corpo não é o JSON esperado — abra a fixture e olhe.\n");
  }

  if (process.env.SKIP_STEPS !== "true") {
    console.log("4. Repetindo a chamada de DENTRO da página, com outra data...");
    await repeatFromInside(page, good);
  }

  console.log("\n5. Sequestrando a chamada do próprio site (troca só o corpo)...");
  await hijackSiteCall(page);

  await finish(page);
}

// The last and most important step: can WE drive the search?
//
// The first attempt (window.fetch inside the page) failed with "Failed to
// fetch", and the stack showed why: the site wraps window.fetch in an anti-bot
// script. So this is a ladder of transports, from most to least site-like,
// until one answers.
//
// Then the cost question: does `criteria` take several dates at once? The site
// sends one per call; the old project sent six. If six work, a year costs ~61
// requests per direction instead of 365.
type Transport = { name: string; send: (body: unknown) => Promise<TransportResponse> };
type TransportResponse = { status: number | string; size: number; body: string };

function criterion(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return {
    departureStation: origin.toUpperCase(),
    arrivalStation: destination.toUpperCase(),
    std: `${month}/${day}/${year}`,
    departureDate: iso,
  };
}

function searchBody(dateCount: number) {
  return {
    criteria: Array.from({ length: dateCount }, (_, k) => criterion(daysFromToday(90 + k * 7))),
    passengers: [{ type: "ADT", count: "1", companionPass: false }],
    flexibleDays: { daysToLeft: "3", daysToRight: "3" },
    currencyCode: "BRL",
  };
}

function datesIn(body: string): string[] {
  try {
    const json = JSON.parse(body) as { data?: { trips?: { std?: string }[] } };
    return [...new Set((json.data?.trips ?? []).map((trip) => (trip.std ?? "").split("T")[0] ?? "").filter(Boolean))];
  } catch {
    return [];
  }
}

async function repeatFromInside(page: Page, base: Capture) {
  // Only the headers the application sets. `referer`, `user-agent` and
  // `sec-ch-*` belong to the browser: fetch ignores them.
  const APP_HEADERS = ["authorization", "ocp-apim-subscription-key", "device", "culture", "accept", "content-type"];
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(base.headers)) {
    if (APP_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  if (!headers.authorization) {
    console.log("   (a chamada capturada não tinha authorization — pulando)");
    return;
  }
  const url = base.url;

  const transports: Transport[] = [
    {
      name: "fetch da página",
      send: (body) =>
        page.evaluate(
          async ({ url, headers, body }) => {
            try {
              const response = await fetch(url, { method: "POST", headers: headers as Record<string, string>, body: JSON.stringify(body) });
              const text = await response.text();
              return { status: response.status as number | string, size: text.length, body: text };
            } catch (error) {
              return { status: `falhou: ${(error as Error).message}`, size: 0, body: "" };
            }
          },
          { url, headers, body },
        ),
    },
    {
      name: "XMLHttpRequest",
      send: (body) =>
        page.evaluate(
          ({ url, headers, body }) =>
            new Promise<{ status: number | string; size: number; body: string }>((resolve) => {
              const request = new XMLHttpRequest();
              request.open("POST", url, true);
              for (const [name, value] of Object.entries(headers as Record<string, string>)) request.setRequestHeader(name, value);
              request.onload = () => resolve({ status: request.status, size: request.responseText.length, body: request.responseText });
              request.onerror = () => resolve({ status: "falhou: erro de rede", size: 0, body: "" });
              request.send(JSON.stringify(body));
            }),
          { url, headers, body },
        ),
    },
    {
      name: "fetch de iframe novo (sem o embrulho do anti-bot)",
      send: (body) =>
        page.evaluate(
          async ({ url, headers, body }) => {
            const frame = document.createElement("iframe");
            frame.style.display = "none";
            document.body.appendChild(frame);
            try {
              const cleanFetch = (frame.contentWindow as Window & typeof globalThis).fetch;
              const response = await cleanFetch.call(frame.contentWindow, url, {
                method: "POST",
                headers: headers as Record<string, string>,
                body: JSON.stringify(body),
              });
              const text = await response.text();
              return { status: response.status as number | string, size: text.length, body: text };
            } catch (error) {
              return { status: `falhou: ${(error as Error).message}`, size: 0, body: "" };
            } finally {
              frame.remove();
            }
          },
          { url, headers, body },
        ),
    },
    {
      name: "requisição do Playwright (fora do JS da página)",
      send: async (body) => {
        try {
          const response = await page.context().request.post(url, { headers, data: body as object });
          const text = await response.text();
          return { status: response.status(), size: text.length, body: text };
        } catch (error) {
          return { status: `falhou: ${(error as Error).message}`, size: 0, body: "" };
        }
      },
    },
  ];

  let winner: Transport | null = null;
  for (const transport of transports) {
    const response = await transport.send(searchBody(1));
    const dates = datesIn(response.body);
    console.log(`   ${transport.name}: status ${response.status} | ${response.size} bytes | ${dates.length} data(s)`);
    if (response.status !== 200 && response.body) console.log(`      amostra: ${response.body.slice(0, 200)}`);
    if (response.status === 200 && dates.length > 0) {
      winner = transport;
      break;
    }
  }

  if (!winner) {
    console.log("\n⚠️  Nenhum transporte disparou a busca. O módulo teria que navegar por deep link a cada data —");
    console.log("    funciona, mas custa um carregamento de página inteiro por consulta.");
    return;
  }

  console.log(`\n✅ Dá pra dirigir a busca por: ${winner.name}`);
  console.log("\n5. Quantas datas cabem numa chamada?");
  for (const count of [3, 6, 12]) {
    const response = await winner.send(searchBody(count));
    const dates = datesIn(response.body);
    console.log(`   criteria com ${count} → status ${response.status} | ${dates.length} data(s) na resposta | ${response.size} bytes`);
    if (response.status !== 200 && response.body) console.log(`      amostra: ${response.body.slice(0, 200)}`);
    await page.waitForTimeout(2000);
  }
}

// When none of our calls pass, what is left is letting the SITE make its own
// call, with every anti-bot header and cookie only it knows how to build, and
// swapping just the body on the way. If `criteria` takes several dates, one
// navigation yields several dates.
async function hijackSiteCall(page: Page) {
  // How many dates fit one call defines the cost of a year; found by trying: BATCHES=6,8,10
  const batchSizes = (process.env.BATCHES ?? "1,6,12").split(",").map(Number);
  for (const count of batchSizes) {
    let swapped = false;
    let response: { status: number; body: string } | null = null;

    await page.route("**/availability/v*/availability", async (route) => {
      if (swapped) return route.continue();
      swapped = true;
      await route.continue({ postData: JSON.stringify(searchBody(count)) });
    });

    const nextResponse = page.waitForResponse((candidate) => /availability\/v\d+\/availability$/.test(candidate.url()), {
      timeout: 60_000,
    });
    await page.goto(deepLink(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    try {
      const result = await nextResponse;
      response = { status: result.status(), body: await result.text() };
    } catch {
      response = null;
    }
    await page.unroute("**/availability/v*/availability");

    if (!response) {
      console.log(`   criteria com ${count} → nenhuma resposta em 60s`);
      continue;
    }
    const dates = datesIn(response.body);
    console.log(`   criteria com ${count} → status ${response.status} | ${response.body.length} bytes | ${dates.length} data(s) na resposta`);
    if (dates.length) console.log(`     ${dates.join(", ")}`);
    if (response.status !== 200) console.log(`     amostra: ${response.body.slice(0, 200)}`);

    if (count === Math.max(...batchSizes) && dates.length > 0) {
      fs.writeFileSync(path.join(FIXTURES_DIR, "azul-real-multidata.json"), response.body, "utf8");
      console.log("   ✅ fixture multi-data salva em fixtures/azul-real-multidata.json");
    }
  }
}

async function finish(page: Page) {
  await page.close();
  process.exit(0);
}

main();
