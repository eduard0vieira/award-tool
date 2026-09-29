import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Frame, Page, Request } from "playwright";
import { openChromeSession } from "../src/core/chrome-session.ts";
import { FIXTURES_DIR } from "../src/core/paths.ts";

// PHASE 0 of the Iberia source.
//
// The old project (projetos/cheap-flights) hit the iOS APP's API:
// ibisservices.iberia.com/api/sse-rpa/rs/v1/availability, with a token from an
// Iberia Plus login and Akamai cookies pasted by hand, including an
// `X-acf-sensor-data` signed by the native app that cannot be reproduced. That
// is why it turned into 403 and stayed there.
//
// The technique that unlocked Azul ignores all of that: the site builds the
// request and we only swap what we ask for. The first look showed two good signs:
//   - the home page calls `ibisauth.../openid-connect/token` on its own, anonymously;
//   - it uses the SAME `ibisservices.iberia.com` host as the app's API.
//
// Questions for this phase:
//   1. does the "Pagar com Avios" search open without a login?
//   2. which endpoint brings availability, and how many days per response?
//   3. does the result land on a repeatable URL (deep link)?
//
// Usage: npx tsx scripts/recon-iberia.ts [GRU] [MAD] [2026-11-16]

const [origin = "GRU", destination = "MAD", date = daysFromToday(90)] = process.argv.slice(2);

function daysFromToday(days: number): string {
  const today = new Date();
  today.setDate(today.getDate() + days);
  return today.toISOString().slice(0, 10);
}
function brazilianDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}
function brazilianToIso(br: string): string {
  const [day, month, year] = br.split("/");
  return `${year}-${month}-${day}`;
}

// How long the script waits for you to log in on the bot's window. The login
// stays in the profile, so this happens once, not on every search.
const LOGIN_WAIT_MS = Number(process.env.IBERIA_ESPERA_LOGIN_MS) || 600_000;

// Kept out of git (fixtures/*.png): logged-in screens show the holder's name and balance.
const capturePath = (name: string) => path.join(FIXTURES_DIR, `iberia-${name}.png`);

const SECRET_HEADERS = ["authorization", "cookie", "x-acf-sensor-data"];
const mask = (name: string, value: string) =>
  SECRET_HEADERS.includes(name.toLowerCase()) ? `<${value.length} chars — não impresso>` : value;

// Headers `fetch` does not let a page set: the browser puts its own.
const FORBIDDEN_HEADERS = /^(host|cookie|connection|content-length|accept-encoding|user-agent|origin|referer|sec-)/i;

type Capture = {
  url: string;
  method: string;
  headers: Record<string, string>;
  sentBody: string | null;
  status: number | null;
  receivedBody: string | null;
};

// It started watching only `ibisservices`/`ibisauth`, the known hosts, but a
// price route elsewhere on the domain would have been hidden. Wide enough to
// find it, narrow enough not to drown the log in Akamai (`sensor_data`) and
// Dynatrace (`rb_*`) beacons, which the first wide version brought by the dozen.
const isRelevant = (url: string) => {
  const host = new URL(url, "https://www.iberia.com").hostname;
  if (!/(^|\.)iberia\.com$/.test(host)) return false;
  if (/\.(js|css|png|jpe?g|svg|gif|woff2?|ico|mp4)(\?|$)/.test(url)) return false;
  if (/ibisservices\.iberia\.com|ibisauth\.iberia\.com/.test(host)) return true;
  return /\/api\//.test(new URL(url, "https://www.iberia.com").pathname);
};

async function main() {
  console.log(`\nRecon Iberia — ${origin.toUpperCase()}→${destination.toUpperCase()} em ${date} (Avios)\n`);

  const session = await openChromeSession(false, "recon-iberia");
  const page = session.page;
  const captures: Capture[] = [];

  // Paired by the request's IDENTITY, not its URL: the same availability route
  // is called twice (marketCode BR and US), and matching by string glued one's
  // response onto the other's request, a wrong result that looks right.
  const byRequest = new Map<Request, Capture>();

  page.on("request", (request) => {
    if (!isRelevant(request.url())) return;
    const capture: Capture = {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      sentBody: request.postData(),
      status: null,
      receivedBody: null,
    };
    captures.push(capture);
    byRequest.set(request, capture);
  });
  page.on("response", async (response) => {
    const capture = byRequest.get(response.request());
    if (!capture) return;
    capture.status = response.status();
    capture.receivedBody = await response.text().catch(() => null);
  });

  console.log("1. Abrindo a home...");
  await page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  // Cookie notice: decline everything non-essential. Never accept.
  await declineCookies(page);
  await closePromotions(page);

  console.log("2. Preenchendo a busca com 'Pagar com Avios'...");
  if (!(await fillSearchForm(page))) {
    console.log("❌ Formulário não ficou como pedido. Foto em fixtures/iberia-error.png");
    await page.screenshot({ path: capturePath("error") });
    await finish(page);
    return;
  }

  console.log("3. Esperando o resultado...");
  const hasSearch = () =>
    captures.some(
      (capture) => /availability|shopping|flights|fares/i.test(capture.url) && (capture.receivedBody?.length ?? 0) > 2000,
    );

  await waitUntil(page, 25_000, async () => hasSearch() || (await askingForLogin(page)) !== false);

  // A result in hand beats any screen hint: in one run with a valid session,
  // the "Acesso a Iberia Club" promo box was read as a login prompt, the script
  // went off to log in again and lost the search that had already returned 200.
  // If availability came, there is no login to do.
  const loginPrompt = hasSearch() ? false : await askingForLogin(page);
  if (loginPrompt) {
    console.log(`   a Iberia pediu login (${loginPrompt === "url" ? "redirecionou" : "modal na própria página"}).`);

    // The modal comes up with the `IDY_LoginIframeHeader` iframe, which is only
    // the box's header: the form never loads inside it (the first capture showed
    // a blank body). Since the full login page works, go straight to it instead
    // of waiting for a field that never comes.
    if (loginPrompt === "modal") {
      console.log("   o modal não traz formulário; indo direto pra página de login.");
      await page
        .goto("https://login.iberia.com/IDY_LoginPage?market=BRpt", { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch((error: Error) => console.log(`   (não consegui abrir a página de login: ${error.message.slice(0, 80)})`));
      await page.waitForTimeout(3000);
    }
    if (!(await waitForManualLogin(page))) {
      await finish(page);
      return;
    }
    // After the login Iberia returns to the booking flow on its own; if it does
    // not, redo the search, now with a session.
    await waitUntil(page, 30_000, hasSearch);
    if (!hasSearch()) {
      console.log("   a busca não refez sozinha depois do login — repetindo o formulário...");
      await page.goto("https://www.iberia.com/br/", { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(5000);
      await declineCookies(page);
      if (await fillSearchForm(page)) await waitUntil(page, 40_000, hasSearch);
    }
  }

  console.log(`\n   URL final: ${page.url()}`);
  console.log(`   Título: ${await page.title()}`);
  const text = ((await page.evaluate("document.body ? document.body.innerText : ''")) as string).replace(/\s+/g, " ");
  console.log(`   Texto (300): ${text.slice(0, 300)}\n`);

  // The listing used to show half a dozen calls as "status ?": the script
  // closed the page while they were still in flight. What comes AFTER the
  // availability is exactly where the price may be.
  if (hasSearch()) {
    const before = captures.length;
    console.log("   (deixando a página assentar 15s pra ver o que vem depois da disponibilidade)");
    await page.waitForTimeout(15_000);
    if (captures.length > before) console.log(`   +${captures.length - before} chamada(s) depois da busca.`);
  }

  console.log(`4. Chamadas à API da Iberia: ${captures.length}\n`);
  for (const capture of captures) {
    console.log(`── ${capture.method} ${capture.url.slice(0, 120)}`);
    console.log(`   status ${capture.status ?? "?"} | ${capture.receivedBody?.length ?? 0} bytes`);
    if (capture.sentBody) console.log(`   enviou: ${capture.sentBody.slice(0, 400)}`);
  }

  const search = captures.find(
    (capture) =>
      /availability|shopping|flights|fares/i.test(capture.url) && capture.status === 200 && (capture.receivedBody?.length ?? 0) > 2000,
  );
  if (!search || !search.receivedBody) {
    console.log("\n⚠️  Nenhuma resposta grande de disponibilidade. Ou exige login, ou sai por outro caminho.");
    await page.screenshot({ path: capturePath("result") });
    await diagnoseLogin(page);
    await finish(page);
    return;
  }

  console.log(`\n5. Endpoint de disponibilidade: ${search.method} ${search.url}`);
  console.log("   headers da aplicação:");
  for (const [name, value] of Object.entries(search.headers)) {
    if (/^(authorization|x-|content-type|accept|market|culture|device)/i.test(name)) console.log(`     ${name}: ${mask(name, value)}`);
  }

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES_DIR, "iberia-real.json"), search.receivedBody, "utf8");
  console.log(`\n✅ Resposta crua salva em fixtures/iberia-real.json (${search.receivedBody.length} bytes).`);

  await showAviosOnScreen(page);
  showBearerClaims(search);
  await probeRepetition(page, search);
  await probeCalendar(page, captures);
  await probeFlightSelection(page, captures);

  await finish(page);
}

// Availability has no price, and no captured call so far does. Before
// concluding the number does not exist, look at what is ON SCREEN: if the page
// shows "34.000 Avios", it comes from somewhere, another route or a client-side
// calculation (Iberia redeems by a distance chart).
async function showAviosOnScreen(page: Page) {
  const found = (await page
    .evaluate(`(() => {
      const text = document.body ? document.body.innerText : "";
      const matches = text.match(/[\\d][\\d.,]*\\s*[Aa]vios/g) || [];
      return { unique: [...new Set(matches)].slice(0, 20), hasWord: /avios/i.test(text) };
    })()`)
    .catch(() => null)) as { unique: string[]; hasWord: boolean } | null;

  if (!found) return console.log("\n   (não consegui ler a tela)");
  if (found.unique.length === 0) {
    console.log(`\n   valores em Avios na tela: NENHUM (a palavra "avios" ${found.hasWord ? "aparece" : "não aparece"} na página)`);
    return;
  }
  console.log("\n   valores em Avios renderizados na tela:");
  for (const value of found.unique) console.log(`     ${value}`);
}

// Availability carries no price and the sent body has no Avios mark, so either
// the redemption context travels in the bearer (issued after login) or this is
// the cash search and the Avios one is another. The token is a credential: only
// the claim NAMES come out, plus the value of a handful that identify nobody.
// None of it goes to disk.
function showBearerClaims(search: Capture) {
  const raw = Object.entries(search.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  if (!raw) return console.log("\n   (a chamada de disponibilidade não levou Authorization)");

  const parts = raw.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) return console.log("\n   (o Authorization não é JWT — nada a decodificar)");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch (error) {
    return console.log(`\n   (não consegui ler o payload do bearer: ${(error as Error).message})`);
  }

  const SHAREABLE = /^(scope|typ|type|realm|market|azp|aud|iss|avios|redemption|loyalty|client_id|grant)/i;
  console.log("\n   claims do bearer da disponibilidade:");
  for (const [name, value] of Object.entries(payload)) {
    const short = typeof value === "string" || typeof value === "number";
    console.log(`     ${name}${SHAREABLE.test(name) && short ? ` = ${String(value).slice(0, 60)}` : ""}`);
  }
}

// The availability screen shows no Avios (only the header's "0 Avios" balance)
// and none of the 13 API routes has a price. What is left is the next step of
// the flow, picking a flight: this probe reads the selection screen, which
// decides whether the source can produce a value per day.
async function probeFlightSelection(page: Page, captures: Capture[]) {
  console.log("\n8. Lendo a tela de seleção de voos...");

  // The previous capture showed the cards but cut the footer where the price
  // should be, and searching for "N Avios" only found the header's balance.
  // Instead of guessing button labels, dump the screen text and look.
  await page.screenshot({ path: capturePath("selection"), fullPage: true }).catch(() => {});
  const text = (await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "")) as string;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  console.log(`   texto da tela (${lines.length} linhas), primeiras 45:`);
  for (const line of lines.slice(0, 45)) console.log(`     ${line.slice(0, 100)}`);

  const withNumbers = lines.filter((line) => /\d{1,3}[.,]\d{3}|\bavios\b/i.test(line));
  if (withNumbers.length) {
    console.log("   linhas com número grande ou 'avios':");
    for (const line of [...new Set(withNumbers)].slice(0, 20)) console.log(`     ${line.slice(0, 100)}`);
  }

  // "Vista mensal de voos" showed up on screen: a direct candidate for the
  // question /calendar left open (a date range in a single call).
  const before = captures.length;
  const monthly = page.locator('a:has-text("Vista mensal"), button:has-text("Vista mensal")').first();
  if (await monthly.isVisible().catch(() => false)) {
    console.log("\n   clicando em 'Vista mensal de voos'...");
    await monthly.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(10_000);
    const newCaptures = captures.slice(before);
    console.log(`   ${newCaptures.length} chamada(s) nova(s):`);
    for (const capture of newCaptures) {
      console.log(`     ${capture.method} ${capture.url.slice(0, 110)} → ${capture.status ?? "?"} | ${capture.receivedBody?.length ?? 0} bytes`);
      // Without the sent body the call cannot be repeated, and repeating is the
      // goal: it goes to the log and to disk next to the response.
      if (capture.sentBody) console.log(`       enviou: ${capture.sentBody.slice(0, 500)}`);
      if ((capture.receivedBody?.length ?? 0) > 500) {
        const name = `iberia-monthly-${newCaptures.indexOf(capture)}.json`;
        fs.writeFileSync(path.join(FIXTURES_DIR, name), capture.receivedBody!, "utf8");
        console.log(`       salvo em fixtures/${name}`);
      }
    }
    await page.screenshot({ path: capturePath("monthly"), fullPage: true }).catch(() => {});
    await showAviosOnScreen(page);
    await probeGrid(page, captures);
  } else {
    console.log("   (link 'Vista mensal de voos' não estava visível)");
  }
}

// `/calendar/grid` returned 191 days for `maxSearchTime: 359` and started TODAY
// instead of the requested date. Before designing the source on top of it,
// three questions: is the window fixed? does the body's date move the start?
// can a year be covered? Each answer here is (or is not) one call less per search.
async function probeGrid(page: Page, captures: Capture[]) {
  const grid = captures.find((capture) => /\/calendar\/grid$/.test(capture.url) && capture.sentBody);
  if (!grid) return console.log("\n9. (nenhuma chamada de calendar/grid capturada)");

  console.log("\n9. Sondando os limites do /calendar/grid...");
  const headers = Object.fromEntries(Object.entries(grid.headers).filter(([name]) => !FORBIDDEN_HEADERS.test(name)));

  const cases: { name: string; body: string }[] = [
    { name: "data +200 dias", body: grid.sentBody!.replace(/"date":"[^"]*"/, `"date":"${daysFromToday(200)}"`) },
    { name: "maxSearchTime=720", body: grid.sentBody!.replace(/"maxSearchTime":\s*\d+/, '"maxSearchTime":720') },
    {
      name: "data +200 e maxSearchTime=720",
      body: grid
        .sentBody!.replace(/"date":"[^"]*"/, `"date":"${daysFromToday(200)}"`)
        .replace(/"maxSearchTime":\s*\d+/, '"maxSearchTime":720'),
    },
  ];

  for (const probe of cases) {
    const response = (await page.evaluate(
      `((url, headers, body) => fetch(url, { method: "POST", headers, body, credentials: "include" })
        .then(async (result) => ({ status: result.status, text: await result.text() }))
        .catch((error) => ({ status: -1, text: String(error) })))(${JSON.stringify(grid.url)}, ${JSON.stringify(headers)}, ${JSON.stringify(probe.body)})`,
    )) as { status: number; text: string };

    if (response.status !== 200) {
      console.log(`   ${probe.name}: status ${response.status} — ${response.text.slice(0, 120)}`);
      continue;
    }
    try {
      const json = JSON.parse(response.text) as {
        outbound?: { availabilityCalendar?: { date: string; avios?: number; lock?: boolean }[] };
      };
      const calendar = json.outbound?.availabilityCalendar;
      if (!calendar?.length) {
        console.log(`   ${probe.name}: 200, mas sem availabilityCalendar no corpo.`);
        continue;
      }
      const priced = calendar.filter((day) => day.avios !== undefined);
      const locked = calendar.filter((day) => day.lock === true).length;
      console.log(
        `   ${probe.name}: ${calendar.length} dias (${calendar[0]!.date} → ${calendar[calendar.length - 1]!.date}), ` +
          `${priced.length} com avios, ${locked} com lock=true`,
      );
    } catch (error) {
      console.log(`   ${probe.name}: 200, mas não consegui ler o JSON (${(error as Error).message.slice(0, 60)})`);
    }
  }
}

// The calendar decides the cost of sweeping a year: one day per call (359
// searches) or a range per call. It came back 404 with marketCode BR, which
// smells of a swapped route or a market without the feature, not "does not
// exist". Try the markets the site itself uses before the next phase builds on day-by-day.
async function probeCalendar(page: Page, captures: Capture[]) {
  const calendar = captures.find((capture) => /\/calendar$/.test(capture.url) && capture.sentBody);
  if (!calendar) return console.log("\n7. (nenhuma chamada de calendário foi capturada)");

  console.log("\n7. Testando o calendário por mercado...");
  const headers = Object.fromEntries(Object.entries(calendar.headers).filter(([name]) => !FORBIDDEN_HEADERS.test(name)));

  for (const market of ["BR", "US", "ES", "GB"]) {
    const body = calendar.sentBody!.replace(/"marketCode"\s*:\s*"[^"]*"/, `"marketCode":"${market}"`);
    const response = (await page.evaluate(
      `((url, headers, body) => fetch(url, { method: "POST", headers, body, credentials: "include" })
        .then(async (result) => ({ status: result.status, text: await result.text() }))
        .catch((error) => ({ status: -1, text: String(error) })))(${JSON.stringify(calendar.url)}, ${JSON.stringify(headers)}, ${JSON.stringify(body)})`,
    )) as { status: number; text: string };

    console.log(`   marketCode=${market}: status ${response.status} | ${response.text.length} bytes`);
    if (response.status === 200 && response.text.length > 500) {
      const file = path.join(FIXTURES_DIR, `iberia-calendar-${market}.json`);
      fs.writeFileSync(file, response.text, "utf8");
      console.log(`   ✅ salvo em fixtures/${path.basename(file)}`);
    } else if (response.status !== 200) {
      console.log(`      resposta: ${response.text.slice(0, 160)}`);
    }
  }
}

// How many days come per response decides the cost of sweeping a year. Instead
// of guessing the body, this probe REPEATS the request the site just made,
// swapping only the date, and fires it from INSIDE the page: the browser signs
// the TLS and sends the cookie, exactly what unlocked AA and Azul (and what
// cheap-flights lacked). It also answers whether the session takes more than one search.
async function probeRepetition(page: Page, search: Capture) {
  console.log("\n6. Repetindo a mesma chamada com outra data (de dentro da página)...");

  const target = `${search.url}\n${search.sentBody ?? ""}`;
  const isoInRequest = target.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const brInRequest = target.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] ?? null;
  if (!isoInRequest && !brInRequest) {
    console.log("   ⚠️  a data não aparece literal na URL nem no corpo — a repetição precisa ser lida à mão.");
    return;
  }

  const headers = Object.fromEntries(Object.entries(search.headers).filter(([name]) => !FORBIDDEN_HEADERS.test(name)));

  for (const offset of [1, 30]) {
    const shifted = new Date(isoInRequest ?? brazilianToIso(brInRequest!));
    shifted.setDate(shifted.getDate() + offset);
    const shiftedIso = shifted.toISOString().slice(0, 10);

    let url = search.url;
    let body = search.sentBody;
    if (isoInRequest) {
      url = url.replaceAll(isoInRequest, shiftedIso);
      body = body?.replaceAll(isoInRequest, shiftedIso) ?? null;
    }
    if (brInRequest) {
      const shiftedBr = brazilianDate(shiftedIso);
      url = url.replaceAll(brInRequest, shiftedBr);
      body = body?.replaceAll(brInRequest, shiftedBr) ?? null;
    }

    const response = (await page.evaluate(
      `((url, method, headers, body) => fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        credentials: "include",
      }).then(async (result) => ({ status: result.status, text: await result.text() }))
        .catch((error) => ({ status: -1, text: String(error) })))(${JSON.stringify(url)}, ${JSON.stringify(search.method)}, ${JSON.stringify(headers)}, ${JSON.stringify(body)})`,
    )) as { status: number; text: string };

    console.log(`   +${offset} dia(s) (${shiftedIso}): status ${response.status} | ${response.text.length} bytes`);
    if (response.status === 200 && response.text.length > 2000) {
      const file = path.join(FIXTURES_DIR, `iberia-real-plus${offset}.json`);
      fs.writeFileSync(file, response.text, "utf8");
      console.log(`   salvo em fixtures/${path.basename(file)}`);
    } else if (response.status !== 200) {
      console.log(`   ⚠️  repetição não voltou 200 — início da resposta: ${response.text.slice(0, 200)}`);
    }
  }
}

// In 2026-08 the Avios search redirected to `login.iberia.com`. In 2026-09 it
// started opening a MODAL on the home page itself ("Acesso a Iberia Club")
// without changing the URL, which made the recon give up thinking no login was
// asked. Both paths are checked now, and it says which one it recognized.
async function askingForLogin(page: Page): Promise<false | "url" | "modal"> {
  if (/login\.iberia\.com/.test(page.url())) return "url";
  if (page.frames().some((frame) => /login\.iberia|ibisauth\.iberia/.test(frame.url()))) return "modal";
  const hasModal = await page
    .evaluate(`(() => {
      const marks = ["acesso a iberia club", "inicie sessão", "iniciar sessão"];
      const large = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 200 && rect.height > 150; };
      return [...document.querySelectorAll("dialog,[role=dialog],div,section")].some(
        (element) => large(element)
          && marks.some((mark) => (element.innerText || "").toLowerCase().includes(mark))
          && (element.querySelector("input") || element.querySelector("iframe")),
      );
    })()`)
    .catch(() => false);
  return hasModal ? "modal" : false;
}

// When the recon finds no availability, what is on screen decides the next
// step, so dump it instead of guessing: frames and the HTML of what looks like
// a login box. The next phase's selectors come from here.
async function diagnoseLogin(page: Page) {
  console.log("\n   diagnóstico da tela:");
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    console.log(`     frame: ${frame.url().slice(0, 140)}`);
  }
  const box = (await page
    .evaluate(`(() => {
      const marks = ["acesso a iberia club", "inicie sessão", "iniciar sessão"];
      const large = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 200 && rect.height > 150; };
      const target = [...document.querySelectorAll("dialog,[role=dialog],div,section")].find(
        (element) => large(element)
          && marks.some((mark) => (element.innerText || "").toLowerCase().includes(mark))
          && (element.querySelector("input") || element.querySelector("iframe")),
      );
      if (!target) return null;
      return {
        tag: target.tagName,
        className: target.className,
        html: target.outerHTML.slice(0, 3000),
        fields: [...target.querySelectorAll("input,button,iframe")].map(
          (element) => element.tagName + " type=" + element.getAttribute("type") + " name=" + element.getAttribute("name")
            + " id=" + element.id + " src=" + (element.getAttribute("src") || "").slice(0, 80),
        ),
      };
    })()`)
    .catch(() => null)) as { tag: string; className: string; html: string; fields: string[] } | null;

  if (!box) {
    console.log("     (nenhuma caixa de login reconhecida na tela)");
    return;
  }
  console.log(`     caixa: <${box.tag} class="${String(box.className).slice(0, 80)}">`);
  for (const field of box.fields) console.log(`       ${field}`);
  const file = path.join(FIXTURES_DIR, "iberia-login-modal.html");
  fs.writeFileSync(file, box.html, "utf8");
  console.log(`     HTML do modal salvo em fixtures/${path.basename(file)}`);
}

// Same deal as the LATAM scraper (`fillCredentials` in latam.scraper.ts): with
// IBERIA_EMAIL and IBERIA_SENHA in .env the script types ahead. It does not
// **confirm** the login when a step is left: 2FA, captcha and anything else
// Iberia decides to ask stay with you. Credentials live only in your .env
// (gitignored); nothing is printed or stored elsewhere.
type LoginContext = Page | Frame;

async function fillCredentials(page: Page): Promise<"sent" | "partial" | "missing"> {
  const email = process.env.IBERIA_EMAIL;
  const password = process.env.IBERIA_SENHA;
  if (!email || !password) {
    console.log("   (sem IBERIA_EMAIL/IBERIA_SENHA no .env — o login é todo na mão, na janela do bot)");
    return "missing";
  }

  try {
    // The cookie notice covers this page too, and its filter swallows clicks.
    await declineCookies(page);

    // The login comes two ways: a redirect to `login.iberia.com` or a modal on
    // the home page. In the modal the form lives in an iframe on
    // `www.iberia.com/integration/ibplus/login/` (it shows in the captures'
    // `redirect_uri`); filtering frames by "login.iberia" excluded exactly that
    // one, and the script waited ten minutes for a manual fill. So look in ALL
    // frames and wait for the iframe to load.
    const EMAIL_SELECTOR = 'input[name="loginPage:theForm:loginEmailInput"], input[type="email"], input[name*="mail" i]';

    let form: LoginContext | null = null;
    const deadline = Date.now() + 25_000;
    while (!form && Date.now() < deadline) {
      for (const context of [page, ...page.frames()]) {
        if (await context.locator(EMAIL_SELECTOR).first().isVisible().catch(() => false)) {
          form = context;
          break;
        }
      }
      if (!form) await page.waitForTimeout(1500);
    }

    if (!form) {
      const frames = page.frames().map((frame) => frame.url().slice(0, 90) || "(sem url)");
      console.log("   não achei o campo de e-mail em nenhum frame — siga na mão na janela do bot.");
      console.log(`   frames na página: ${JSON.stringify(frames)}`);
      return "partial";
    }
    if (form !== page) console.log(`   formulário de login está no iframe ${form.url().slice(0, 90)}`);

    const emailField = form.locator(EMAIL_SELECTOR).first();
    const passwordField = form.locator('input[type="password"]').first();

    await emailField.waitFor({ state: "visible", timeout: 20_000 });
    await emailField.fill(email);

    // Two-step login: if the password is not on screen yet, "continue" brings it.
    if (!(await passwordField.isVisible().catch(() => false))) {
      console.log("   campo de senha fora da tela — enviando o e-mail primeiro.");
      await submitForm(form);
      await passwordField.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    }

    if (!(await passwordField.isVisible().catch(() => false))) {
      console.log("   a senha não apareceu — siga na janela do bot.");
      return "partial";
    }

    await passwordField.fill(password);
    if (!(await submitForm(form))) {
      console.log("   campos preenchidos, mas não achei o botão de enviar — o clique é seu, na janela do bot.");
      return "partial";
    }
    return "sent";
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`   não consegui preencher o login (${reason}) — siga na mão na janela do bot.`);
    return "partial";
  }
}

// The notes' selector is Salesforce Identity's; the modal may use another, so
// it falls back to the first submit-looking button and says which one it took:
// if Iberia changes again, the log already tells what broke.
async function submitForm(form: LoginContext): Promise<boolean> {
  const candidates = [
    'input[name="loginPage:theForm:loginSubmit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Fazer login")',
    'button:has-text("Iniciar sessão")',
    'button:has-text("Entrar")',
    'button:has-text("Continuar")',
  ];
  for (const selector of candidates) {
    const button = form.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 10_000 }).catch(() => {});
    console.log(`   enviei o formulário de login (${selector}).`);
    return true;
  }
  return false;
}

// The Avios search calls no availability without an account: it redirects to
// the login. So the script stops here and hands over the wheel; the password is
// yours and never passes through this process.
async function waitForManualLogin(page: Page): Promise<boolean> {
  await page.bringToFront().catch(() => {});
  const attempt = await fillCredentials(page);
  const minutes = Math.round(LOGIN_WAIT_MS / 60000);

  // With credentials in .env the script logs in alone; the box below only makes
  // sense when a step is left for the person (2FA, captcha, a changed selector).
  if (attempt === "sent") {
    console.log(`   login enviado a partir do .env — esperando a sessão abrir (até ${minutes} min).`);
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
    console.log(`   │  Espero até ${String(minutes).padStart(2)} min. Nada do que você digitar passa por      │`);
    console.log("   │  aqui — o login fica salvo no perfil do Chrome do bot.        │");
    console.log("   └──────────────────────────────────────────────────────────────┘");
    console.log("");
  }

  const deadline = Date.now() + LOGIN_WAIT_MS;
  let lastMark = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await askingForLogin(page))) {
      console.log(`   ✅ login concluído — a tela saiu do login (${page.url().slice(0, 80)})`);
      return true;
    }
    const minutesLeft = Math.round((deadline - Date.now()) / 60000);
    if (`${minutesLeft}` !== lastMark) {
      console.log(`   ...esperando o login (${minutesLeft} min restantes)`);
      lastMark = `${minutesLeft}`;
    }
  }
  console.log(`   ⏱️  passaram ${minutes} min sem login. Rode de novo quando puder — o que já foi descoberto está nas notas.`);
  return false;
}

// Besides the cookie notice, the home page raises promotions over the form; one
// ("Esperar ou explorar? Últimos dias...") swallowed the click on Pesquisar and
// the search never left the home page. Only promotions are closed, through the
// box's own button; nothing is accepted or consented to.
async function closePromotions(page: Page) {
  const closed = await page.evaluate(`(() => {
    const labels = ["fechar", "cerrar", "close", "×", "x"];
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    let count = 0;
    for (const element of document.querySelectorAll("button,[role=button],a")) {
      const text = (element.innerText || element.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!visible(element) || !labels.includes(text)) continue;
      // Only what sits on an overlay layer.
      const box = element.closest("[class*=modal],[class*=popup],[class*=overlay],[class*=banner],[role=dialog]");
      if (!box) continue;
      element.click();
      count++;
    }
    return count;
  })()`);
  if ((closed as number) > 0) {
    console.log(`   (fechei ${closed} promoção(ões) que cobriam o formulário)`);
    await page.waitForTimeout(1200);
  }
}

// Iberia's cookie notice offers only "Aceitar todos" and "Definições", with no
// decline button. **Nothing is accepted**: what it does is cover the page with a
// dark filter (`onetrust-pc-dark-filter`) that intercepts every click, which was
// blocking the form. Moving the cover out of the way gives no consent at all:
// the banner stays unanswered.
async function declineCookies(page: Page) {
  const decline = page.locator("#onetrust-reject-all-handler").first();
  if (await decline.count().then((count) => count > 0).catch(() => false)) {
    await decline.click({ timeout: 5000 }).catch(() => {});
    console.log("   (aviso de cookies: recusei os não essenciais)");
    await page.waitForTimeout(1500);
    return;
  }

  const removed = await page.evaluate(`(() => {
    const targets = [...document.querySelectorAll(".onetrust-pc-dark-filter, .ot-fade-in")];
    for (const element of targets) element.remove();
    return targets.length;
  })()`);
  console.log(`   (aviso de cookies: sem botão de recusar — nada foi aceito; só tirei a cobertura que bloqueava os cliques, ${removed} elemento(s))`);
  await page.waitForTimeout(800);
}

// The suggestion list reacts to the keyboard but does NOT show up in any DOM
// that can be scanned (by tag, class or text: the generic scan came back
// empty). So instead of reading the list, use what works and check the result:
// go down one position at a time and only accept when the field holds the
// requested code. Typing "MAD" offers Madrid AND Madison, in an order that
// changes between runs: that is how a whole search went to Madison unnoticed.
async function pickAirport(page: Page, selector: string, code: string, label: string): Promise<boolean> {
  const MAX_POSITIONS = 8;
  for (let downs = 1; downs <= MAX_POSITIONS; downs++) {
    await page.fill(selector, "");
    await page.waitForTimeout(300);
    await page.type(selector, code, { delay: 120 });
    await page.waitForTimeout(2000);

    for (let i = 0; i < downs; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);

    const value = await page.inputValue(selector).catch(() => "");
    if (value.includes(`(${code})`)) {
      console.log(`   ${label} ${code}: "${value}" (${downs}ª opção da lista)`);
      return true;
    }
    if (downs === 1) console.log(`   ${label} ${code}: 1ª opção era "${value}" — procurando o código na lista...`);
  }

  const value = await page.inputValue(selector).catch(() => "");
  console.log(`   ❌ ${label}: não achei ${code} nas ${MAX_POSITIONS} primeiras opções; campo ficou com "${value}".`);
  return false;
}

// Selectors checked on the page (the visible button is a magnifier; the real
// `Pesquisar` is #buttonSubmit1, and the Avios checkbox only reacts through its label).
async function fillSearchForm(page: Page): Promise<boolean> {
  try {
    const originFound = await pickAirport(page, "#flight_origin1", origin.toUpperCase(), "origem");
    const destinationFound = await pickAirport(page, "#flight_destiny1", destination.toUpperCase(), "destino");
    if (!originFound || !destinationFound) return false;

    // One way: one leg per search, like the other sources. The select is
    // JS-controlled, so the event must go along.
    await page.evaluate(`(() => {
      const select = document.querySelector("#ticketops-seeker");
      if (select) { select.value = "Só ida"; select.dispatchEvent(new Event("change", { bubbles: true })); }
    })()`);
    await page.waitForTimeout(1200);

    // Control run: the same search WITHOUT Avios. If it reaches the result,
    // what blocks is not the automation but Avios.
    const withoutAvios = process.env.WITHOUT_AVIOS === "true";
    if (withoutAvios) console.log("   (controle: buscando em dinheiro, sem marcar Avios)");

    const aviosState = async () =>
      (await page.evaluate(`(() => {
        const input = document.querySelector("#paywithAvios");
        return input ? { checked: input.checked, disabled: input.disabled } : null;
      })()`)) as { checked: boolean; disabled: boolean } | null;

    // The profile keeps the form state between runs, so the control must
    // UNCHECK by force, or it repeats the Avios search and lies.
    await page.evaluate(
      `((turnOn) => {
        const input = document.querySelector("#paywithAvios");
        if (!input || input.checked === turnOn) return;
        input.checked = turnOn;
        input.dispatchEvent(new Event("click", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })(${withoutAvios ? "false" : "true"})`,
    );
    await page.waitForTimeout(1200);

    if (!withoutAvios) {
      await page.locator("label[for='paywithAvios']").first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    if (!withoutAvios && (await aviosState())?.checked !== true) {
      console.log("   rótulo não marcou; tentando pelo próprio input...");
      await page.evaluate(`(() => {
        const input = document.querySelector("#paywithAvios");
        if (input) { input.checked = true; input.dispatchEvent(new Event("click", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }
      })()`);
      await page.waitForTimeout(1500);
    }

    const state = await aviosState();
    console.log(`   'Pagar com Avios': marcado=${state?.checked} desabilitado=${state?.disabled}`);
    if (!withoutAvios && state?.checked !== true) {
      console.log("   ❌ sem Avios a busca vira dinheiro — parando aqui.");
      await page.screenshot({ path: capturePath("avios") });
      return false;
    }

    // The date field is a datepicker: `fill` does not stick. What works is
    // writing and notifying the page, as with the checkbox. Round trip because
    // the one-way selector is its own dropdown; the extra leg does not hurt the
    // recon, whose goal is finding the endpoint.
    const returnDate = new Date(date);
    returnDate.setDate(returnDate.getDate() + 7);
    await page.evaluate(
      `((outbound, inbound) => {
        const set = (selector, value) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          element.value = value;
          for (const name of ["input", "change", "blur"]) element.dispatchEvent(new Event(name, { bubbles: true }));
          return element.value;
        };
        return [set("#flight_round_date1", outbound), set("#flight_return_date1", inbound)];
      })(${JSON.stringify(brazilianDate(date))}, ${JSON.stringify(brazilianDate(returnDate.toISOString().slice(0, 10)))})`,
    );
    await page.waitForTimeout(1200);
    const formDates = await page.evaluate(`(() => {
      const value = (selector) => { const element = document.querySelector(selector); return element ? element.value : null; };
      return [value("#flight_round_date1"), value("#flight_return_date1")];
    })()`);
    console.log(`   datas no formulário: ${JSON.stringify(formDates)}`);

    await closePromotions(page);
    await page.locator("#buttonSubmit1").first().click({ timeout: 10_000, force: true });

    // The result URL carries the chosen codes. Without this check, a search for
    // the wrong airport returns "no seats found" and passes for a legitimate
    // answer, which is what happened when MAD became MSN.
    await page.waitForTimeout(6000);
    const url = page.url();
    const requested = { BEGIN_CITY_01: origin.toUpperCase(), END_CITY_01: destination.toUpperCase() };
    for (const [field, expected] of Object.entries(requested)) {
      const actual = new RegExp(`${field}=([A-Z]{3})`).exec(url)?.[1];
      if (actual && actual !== expected) {
        console.log(`   ❌ o site buscou ${field}=${actual}, e não ${expected} — o autocomplete pegou outro aeroporto.`);
        console.log("      resultado descartado: buscar destino errado devolve 'sem assentos' e parece resposta boa.");
        return false;
      }
    }
    return true;
  } catch (error) {
    console.log(`   (falhou: ${(error as Error).message.slice(0, 200)})`);
    return false;
  }
}

// Waits for a condition instead of a fixed time: what matters is the capture arriving, not the clock.
async function waitUntil(page: Page, timeoutMs: number, ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(await ready())) await page.waitForTimeout(1000);
}

async function finish(page: Page) {
  await page.close();
  process.exit(0);
}

main();
