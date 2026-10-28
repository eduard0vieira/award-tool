// Answers the three questions of Iberia's per-flight detail (docs/recon/iberia.md §17).
// Usage: npx tsx scripts/recon-iberia-detail.ts <mode> GRU MAD
//   price  does /availability carry each flight's Avios? Looks for any price-like
//          field anywhere in the response, in the US and BR markets, and says
//          whether a direct IB/I2/VY flight was seen at all.
//   token  how long the web bearer lives and what happens at its exp: one call a
//          minute without renewing, then one reopening of the results page.
//   sweep  where the detail gets cut and what lifts the cut: sequential (or
//          BATCH=5), renewing the bearer before it expires.
//   scan <file>  the price reading of a saved response, without a browser.
// Each run writes run.log, summary.json and the responses to data/recon/iberia-detail/.
// Env: INTERVAL_MS (5000), MAX_MINUTES (25), BATCH (1), PRICE_DAYS (8), RELOGIN_ON_CUT=1.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { closeChromeSession } from "../src/core/chrome-session.ts";
import { RECON_DIR } from "../src/core/paths.ts";
import {
  currentAuthorization,
  ensureLoggedIn,
  iberiaHeaders,
  openResultsPage,
  searchIberiaYear,
  startIberiaSession,
} from "../src/scrapers/iberia/iberia.scraper.ts";

const MODES = ["price", "token", "sweep", "scan"] as const;
type Mode = (typeof MODES)[number];
const [modeArg = "", ...rest] = process.argv.slice(2);
if (!(MODES as readonly string[]).includes(modeArg)) {
  console.error(`Modo inválido: '${modeArg}'. Use ${MODES.join(" | ")}, ex.: npx tsx scripts/recon-iberia-detail.ts price GRU MAD`);
  process.exit(1);
}
const mode = modeArg as Mode;

const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 5000;
const MAX_MINUTES = Number(process.env.MAX_MINUTES) || 25;
const BATCH = Number(process.env.BATCH) || 1;
const PRICE_DAYS = Number(process.env.PRICE_DAYS) || 8;
const RELOGIN_ON_CUT = process.env.RELOGIN_ON_CUT === "1";
const TOKEN_PROBE_MS = 60_000;
const RENEW_BEFORE_MS = 3 * 60_000;
const OWN_CARRIERS = new Set(["IB", "I2", "VY"]);
// Wide on purpose: §7 read one path, found nothing and concluded "no price".
const PRICE_KEY = /price|fare(?!basis|family)|avios|amount|points|miles|total/i;

const started = Date.now();
const minutes = () => Number(((Date.now() - started) / 60000).toFixed(1));
let logFile: string | null = null;
const log = (message: string) => {
  const line = `[${minutes().toFixed(1)} min] ${message}`;
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type PriceField = { path: string; count: number; sample: string };

function priceFields(node: unknown, at = "$", found = new Map<string, PriceField>()) {
  if (Array.isArray(node)) {
    for (const item of node) priceFields(item, `${at}[]`, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const here = `${at}.${key}`;
      if (PRICE_KEY.test(key)) {
        const field = found.get(here) ?? { path: here, count: 0, sample: JSON.stringify(value).slice(0, 160) };
        field.count++;
        found.set(here, field);
      }
      priceFields(value, here, found);
    }
  }
  return found;
}

type RawSegment = {
  flight?: { operationalCarrier?: { code?: string }; marketingCarrier?: { code?: string } };
  offers?: { bookingClass?: string }[];
};
type RawResponse = { originDestinations?: { slices?: { stopsNumber?: number; segments?: RawSegment[] }[] }[] };
type Itinerary = {
  operating: string;
  marketing: string;
  stops: number | null;
  ownDirect: boolean;
  cabins: string[];
  priceFields: string[];
};
type Reading = { itineraries: Itinerary[]; fields: PriceField[] };
type Verdict = "priced_own_direct" | "unpriced_own_direct" | "no_own_direct";

function readResponse(text: string): Reading {
  const body = JSON.parse(text) as RawResponse;
  if (!body.originDestinations) throw new Error("a resposta não trouxe 'originDestinations'");
  const itineraries = body.originDestinations.flatMap((originDestination) =>
    (originDestination.slices ?? []).map((slice) => {
      const segments = slice.segments ?? [];
      const operating = segments.map((segment) => segment.flight?.operationalCarrier?.code ?? "?");
      return {
        operating: operating.join(">"),
        marketing: segments.map((segment) => segment.flight?.marketingCarrier?.code ?? "?").join(">"),
        stops: slice.stopsNumber ?? null,
        ownDirect: operating.length === 1 && OWN_CARRIERS.has(operating[0]!),
        cabins: [...new Set(segments.flatMap((segment) => (segment.offers ?? []).map((offer) => offer.bookingClass ?? "?")))],
        priceFields: [...priceFields(slice).keys()],
      };
    }),
  );
  return { itineraries, fields: [...priceFields(body).values()] };
}

function verdictOf(reading: Reading): Verdict {
  const own = reading.itineraries.filter((itinerary) => itinerary.ownDirect);
  if (own.some((itinerary) => itinerary.priceFields.length > 0)) return "priced_own_direct";
  return own.length > 0 ? "unpriced_own_direct" : "no_own_direct";
}

const VERDICT_TEXT: Record<Verdict, string> = {
  priced_own_direct: "voo direto IB/I2/VY COM campo de preço",
  unpriced_own_direct: "voo direto IB/I2/VY visto, SEM nenhum campo de preço",
  no_own_direct: "nenhum voo direto IB/I2/VY visto; a pergunta do preço continua aberta",
};

function printReading(label: string, reading: Reading) {
  const own = reading.itineraries.filter((itinerary) => itinerary.ownDirect).length;
  log(`${label}: ${reading.itineraries.length} itinerário(s), ${own} direto(s) IB/I2/VY`);
  for (const itinerary of reading.itineraries) {
    log(
      `  opera ${itinerary.operating} (vende ${itinerary.marketing}), escalas ${itinerary.stops ?? "?"}, ` +
        `cabines ${itinerary.cabins.join("/") || "nenhuma"}, preço: ${itinerary.priceFields.join(", ") || "nenhum campo"}`,
    );
  }
  log(
    `  campos com cara de preço na resposta inteira: ${
      reading.fields.map((field) => `${field.path} ×${field.count} ex. ${field.sample}`).join(" | ") || "nenhum"
    }`,
  );
}

if (mode === "scan") {
  const file = rest[0];
  if (!file) {
    console.error("Uso: npx tsx scripts/recon-iberia-detail.ts scan <arquivo.json>");
    process.exit(1);
  }
  const reading = readResponse(fs.readFileSync(file, "utf8"));
  printReading(path.basename(file), reading);
  log(`veredito: ${VERDICT_TEXT[verdictOf(reading)]}`);
  process.exit(0);
}

const [origin = "", destination = ""] = rest.map((code) => code.toUpperCase());
if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) {
  console.error(`Rota inválida: '${origin}' → '${destination}'. Ex.: npx tsx scripts/recon-iberia-detail.ts ${mode} GRU MAD`);
  process.exit(1);
}
const params = { origin, destination, passengers: 1 };
const stamp = new Date(started).toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(RECON_DIR, "iberia-detail", `${mode}${BATCH > 1 ? `-batch${BATCH}` : ""}-${origin}-${destination}-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
logFile = path.join(outDir, "run.log");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Responses leave this machine only after this pass; the redaction is named in
// the log, the value never is.
function save(name: string, text: string) {
  const patterns: [string, RegExp][] = [
    ["e-mail", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
    ["JWT", /eyJ[\w-]{10,}\.[\w-]{10,}(\.[\w-]+)?/g],
    ["Bearer", /bearer\s+\S+/gi],
  ];
  if (process.env.IBERIA_EMAIL) patterns.push(["IBERIA_EMAIL", new RegExp(escapeRegExp(process.env.IBERIA_EMAIL), "gi")]);
  let clean = text;
  const hits: string[] = [];
  for (const [label, pattern] of patterns) {
    if (!pattern.test(clean)) continue;
    hits.push(label);
    clean = clean.replace(pattern, `[${label} removido]`);
  }
  fs.writeFileSync(path.join(outDir, name), clean);
  if (hits.length > 0) log(`ATENÇÃO: ${name} tinha ${hits.join(", ")}; trocado por marcador antes de gravar.`);
}

type Claims = { azp: string; iat: number; exp: number };

// Only these three claims are read; the token and the rest of the payload
// (which carries the account's e-mail) are never printed or saved.
function claimsOf(authorization: string | null): Claims | null {
  if (!authorization) return null;
  let payload: { azp?: unknown; iat?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /i, "").split(".")[1] ?? "", "base64url").toString());
  } catch (error) {
    // The name only: a JSON.parse message can quote part of the payload.
    log(`o token não é um JWT legível (${error instanceof Error ? error.name : "erro"})`);
    return null;
  }
  if (typeof payload.azp !== "string" || typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    log("o token não trouxe azp, iat e exp com os tipos esperados");
    return null;
  }
  return { azp: payload.azp, iat: payload.iat, exp: payload.exp };
}

const minutesToExp = (claims: Claims | null) => (claims ? Number(((claims.exp * 1000 - Date.now()) / 60000).toFixed(1)) : null);

// Host, path and the SPA's hash route; never the query, which on the login
// redirects can carry an authorization code.
function where(url: string) {
  if (!URL.canParse(url)) return "(url inválida)";
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}${/^#!\/[\w-]+/.exec(parsed.hash)?.[0] ?? ""}`;
}

const tokens: { atMin: number; azp: string; lifetimeMin: number; minutesToExp: number | null; by: string; seenOn: string }[] = [];
const navigations: { atMin: number; where: string; minutesToExp: number | null }[] = [];
const authRequests = new Map<string, number>();
const availabilityCalls = { byScript: 0, seenOnNetwork: 0 };
let lastClaims: Claims | null = null;
let lastWhere = "";
let reopening = false;

const visitsToLogin = () => navigations.filter((navigation) => navigation.where.startsWith("login.iberia.com")).length;

function watch(page: Page) {
  page.on("request", (request) => {
    if (!URL.canParse(request.url())) return;
    const url = new URL(request.url());
    if (/^login\.iberia\.com$|ibisauth/.test(url.host)) {
      const key = `${request.method()} ${url.host}${url.pathname}`;
      if (!authRequests.has(key)) log(`chamada de autenticação: ${key}`);
      authRequests.set(key, (authRequests.get(key) ?? 0) + 1);
    }
    if (!/ibisservices\.iberia\.com$/.test(url.host)) return;
    if (request.method() === "POST" && url.pathname.endsWith("/availability")) availabilityCalls.seenOnNetwork++;
    const authorization = request.headers()["authorization"];
    if (!authorization) return;
    const claims = claimsOf(authorization);
    if (!claims || (lastClaims && claims.iat === lastClaims.iat && claims.exp === lastClaims.exp)) return;
    const by = tokens.length === 0 ? "first" : reopening ? "script_reopen" : "site";
    lastClaims = claims;
    const entry = {
      atMin: minutes(),
      azp: claims.azp,
      lifetimeMin: Number(((claims.exp - claims.iat) / 60).toFixed(1)),
      minutesToExp: minutesToExp(claims),
      by,
      seenOn: url.pathname,
    };
    tokens.push(entry);
    const how = { first: "primeiro", script_reopen: "reabrindo a busca", site: "o PRÓPRIO SITE trocou" }[by];
    log(`token novo (${how}): azp=${entry.azp}, dura ${entry.lifetimeMin} min, expira em ${entry.minutesToExp} min, visto em ${entry.seenOn}`);
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const here = where(frame.url());
    if (here === lastWhere) return;
    lastWhere = here;
    navigations.push({ atMin: minutes(), where: here, minutesToExp: minutesToExp(lastClaims) });
    log(`aba em ${here} (token expira em ${minutesToExp(lastClaims) ?? "?"} min)`);
  });
}

type Answer = { status: number; text: string };
const isOk = (answer: Answer) => answer.status === 200 || answer.status === 204;
const describe = (answer: Answer) => `status ${answer.status}${isOk(answer) ? "" : ` ${answer.text.slice(0, 100)}`}`;

// -1: the fetch never came back; -2: no token to send; -3: the tab navigated
// in the middle of the call.
async function availability(page: Page, date: string, market = "US"): Promise<Answer> {
  const authorization = currentAuthorization(page);
  if (!authorization) return { status: -2, text: "sem token" };
  availabilityCalls.byScript++;
  return page
    .evaluate(
      async ({ body, headers }) => {
        try {
          const result = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            credentials: "include",
          });
          return { status: result.status, text: await result.text() };
        } catch (error) {
          return { status: -1, text: String(error) };
        }
      },
      {
        body: {
          isPetFlight: false,
          slices: [{ origin, destination, date }],
          passengers: [{ passengerType: "ADULT", count: "1" }],
          marketCode: market,
          preferredCabin: "",
        },
        headers: iberiaHeaders(authorization, "availability"),
      },
    )
    .catch((error: unknown) => ({ status: -3, text: messageOf(error) }));
}

type Reopening = { atMin: number; renewed: boolean; passedLogin: boolean; minutesToExp: number | null; error?: string };
const reopenings: Reopening[] = [];

async function reopen(page: Page, date: string): Promise<Reopening> {
  const before = lastClaims;
  const loginVisitsBefore = visitsToLogin();
  let error: string | null = null;
  reopening = true;
  try {
    await openResultsPage(page, params, date, log);
    await page.waitForTimeout(5000);
  } catch (caught) {
    error = messageOf(caught);
    log(`reabrir a busca falhou: ${error}`);
  } finally {
    reopening = false;
  }
  const after = claimsOf(currentAuthorization(page));
  const result: Reopening = {
    atMin: minutes(),
    renewed: !!after && (!before || after.iat !== before.iat || after.exp !== before.exp),
    passedLogin: visitsToLogin() > loginVisitsBefore,
    minutesToExp: minutesToExp(after),
    ...(error && { error }),
  };
  reopenings.push(result);
  log(
    `reabri a busca: token ${after ? (result.renewed ? "novo" : "o mesmo") : "nenhum"}, ` +
      `${result.passedLogin ? "PASSOU pelo login" : "sem passar pelo login"}, expira em ${result.minutesToExp ?? "?"} min`,
  );
  return result;
}

async function calendarDays(page: Page): Promise<string[]> {
  const year = await searchIberiaYear(page, params, log);
  if (year.kind === "error") throw new Error(`calendário: ${year.reason}`);
  if (year.kind === "no_availability") throw new Error("o calendário não tem nenhum dia com Avios nessa rota");
  if (year.kind === "partial") log(`calendário parcial: ${year.reason}`);
  const days = year.days.map((day) => day.date);
  if (days.length === 0) throw new Error("o calendário parcial não trouxe nenhum dia com Avios");
  log(`calendário: ${days.length} dia(s) com Avios, de ${days[0]} a ${days.at(-1)}`);
  return days;
}

const summary: Record<string, unknown> = {
  mode,
  origin,
  destination,
  startedAt: new Date(started).toISOString(),
  intervalMs: INTERVAL_MS,
  batch: BATCH,
};

function spread(days: string[], count: number) {
  const size = Math.min(count, days.length);
  return Array.from({ length: size }, (_, index) => days[Math.floor((index * days.length) / size)]!);
}

async function priceMode(page: Page, days: string[]) {
  const readings: Record<string, unknown>[] = [];
  const verdicts: Verdict[] = [];
  let daysWithOwnDirect = 0;
  let savedPriced = false;
  let savedUnpriced = false;
  for (const date of spread(days, PRICE_DAYS)) {
    let sawOwnDirect = false;
    for (const market of ["US", "BR"]) {
      const answer = await availability(page, date, market);
      if (answer.status !== 200) {
        log(`preço ${date} ${market}: ${describe(answer)} | aba em ${where(page.url())}`);
        readings.push({ date, market, status: answer.status });
        await page.waitForTimeout(INTERVAL_MS);
        continue;
      }
      save(`availability-${date}-${market}.json`, answer.text);
      let reading: Reading;
      try {
        reading = readResponse(answer.text);
      } catch (error) {
        log(`preço ${date} ${market}: resposta ilegível (${messageOf(error)}); gravada para leitura`);
        readings.push({ date, market, status: answer.status, error: messageOf(error) });
        await page.waitForTimeout(INTERVAL_MS);
        continue;
      }
      printReading(`preço ${date} ${market}`, reading);
      const verdict = verdictOf(reading);
      verdicts.push(verdict);
      if (verdict !== "no_own_direct") sawOwnDirect = true;
      if (verdict === "priced_own_direct" && !savedPriced) {
        save("iberia-availability-ib-direct.json", answer.text);
        savedPriced = true;
      }
      if (verdict === "unpriced_own_direct" && !savedUnpriced) {
        save("iberia-availability-ib-direct-unpriced.json", answer.text);
        savedUnpriced = true;
      }
      readings.push({
        date,
        market,
        status: answer.status,
        verdict,
        itineraries: reading.itineraries,
        priceFields: reading.fields.map((field) => field.path),
      });
      await page.waitForTimeout(INTERVAL_MS);
    }
    if (sawOwnDirect) daysWithOwnDirect++;
    if (daysWithOwnDirect >= 2) break;
  }
  const overall: Verdict = verdicts.includes("priced_own_direct")
    ? "priced_own_direct"
    : verdicts.includes("unpriced_own_direct")
      ? "unpriced_own_direct"
      : "no_own_direct";
  summary.price = { overall, readings };
  log(`RESPOSTA 1 (preço): ${VERDICT_TEXT[overall]}.`);
}

async function tokenMode(page: Page, days: string[]) {
  const first = claimsOf(currentAuthorization(page));
  if (!first) throw new Error("a página de resultados não fez nenhuma chamada com token");
  const deadline = first.exp * 1000 + 5 * 60_000;
  log(`observando o token sem renovar até 5 min depois do exp (faltam ${minutesToExp(first)} min), uma chamada por minuto`);
  const probes: { atMin: number; minutesToFirstExp: number | null; status: number; where: string }[] = [];
  let failuresInRow = 0;
  for (let index = 0; Date.now() < deadline && failuresInRow < 2; index++) {
    const answer = await availability(page, days[index % days.length]!);
    const probe = { atMin: minutes(), minutesToFirstExp: minutesToExp(first), status: answer.status, where: where(page.url()) };
    probes.push(probe);
    log(`sonda ${index + 1}: ${describe(answer)}, primeiro token expira em ${probe.minutesToFirstExp} min, aba em ${probe.where}`);
    failuresInRow = isOk(answer) ? 0 : failuresInRow + 1;
    await page.waitForTimeout(TOKEN_PROBE_MS);
  }
  const firstFailure = probes.find((probe) => probe.status !== 200 && probe.status !== 204) ?? null;
  const renewedBySite = tokens.filter((token) => token.by === "site").length;
  const reopened = await reopen(page, days[0]!);
  const afterReopen = await availability(page, days[0]!);
  log(`chamada depois de reabrir: ${describe(afterReopen)}`);
  summary.token = { lifetimeMin: (first.exp - first.iat) / 60, probes, firstFailure, renewedBySite, reopened, afterReopenStatus: afterReopen.status };
  log(
    `RESPOSTA 2 (token): dura ${((first.exp - first.iat) / 60).toFixed(1)} min; ` +
      `primeira falha ${firstFailure ? `com ${firstFailure.minutesToFirstExp} min para o exp (status ${firstFailure.status}, aba em ${firstFailure.where})` : "não houve"}; ` +
      `o site trocou o token sozinho ${renewedBySite} vez(es); reabrir a busca ${reopened.renewed ? "trouxe token novo" : "NÃO trouxe token novo"} ` +
      `${reopened.passedLogin ? "e passou pelo login" : "sem passar pelo login"}; depois disso: status ${afterReopen.status}.`,
  );
}

type Cut = { atMin: number; calls: number; okCalls: number; date: string; status: number; detail: string; where: string };

async function renewIfNeeded(page: Page, date: string) {
  const authorization = currentAuthorization(page);
  const claims = claimsOf(authorization);
  if (authorization && !claims) throw new Error("sem ler o exp do token não há como medir a renovação");
  if (claims && claims.exp * 1000 - Date.now() > RENEW_BEFORE_MS) return;
  log(claims ? `faltam ${minutesToExp(claims)} min para o token expirar; renovando` : "sem token; reabrindo a busca");
  await reopen(page, date);
}

async function sweepUntilCut(page: Page, days: string[], startIndex: number) {
  let calls = 0;
  let index = startIndex;
  const sweepStarted = minutes();
  while (minutes() < MAX_MINUTES) {
    await renewIfNeeded(page, days[index % days.length]!);
    const batch = Array.from({ length: BATCH }, (_, offset) => days[(index + offset) % days.length]!);
    const answers = await Promise.all(batch.map((date) => availability(page, date)));
    calls += batch.length;
    const failed = answers.findIndex((answer) => !isOk(answer));
    if (failed >= 0) {
      const answer = answers[failed]!;
      const cut: Cut = {
        atMin: Number((minutes() - sweepStarted).toFixed(1)),
        calls,
        okCalls: calls - answers.filter((each) => !isOk(each)).length,
        date: batch[failed]!,
        status: answer.status,
        detail: answer.text.slice(0, 100),
        where: where(page.url()),
      };
      return { cut, calls, nextIndex: index + failed };
    }
    index += BATCH;
    if (calls % 10 < BATCH) log(`${calls} chamadas ok`);
    await page.waitForTimeout(INTERVAL_MS);
  }
  return { cut: null, calls, nextIndex: index };
}

const ladderSteps: { step: string; status: number; where: string }[] = [];

const LADDER_TEXT: Record<string, string> = {
  same_token_after_30s: "o mesmo token, depois de 30 s (sugere limite de ritmo)",
  fresh_token: "token novo na mesma sessão (sugere cota por token)",
  new_login: "login novo (sugere cota por sessão)",
};

async function ladder(page: Page, cut: Cut): Promise<string | null> {
  const retry = async (step: string) => {
    const answer = await availability(page, cut.date);
    log(`degrau ${step}: ${describe(answer)}, aba em ${where(page.url())}`);
    ladderSteps.push({ step, status: answer.status, where: where(page.url()) });
    return isOk(answer);
  };
  await page.waitForTimeout(30_000);
  if (await retry("same_token_after_30s")) return "same_token_after_30s";
  await reopen(page, cut.date);
  if (await retry("fresh_token")) return "fresh_token";
  if (!RELOGIN_ON_CUT) {
    log("degrau do login novo pulado (rode com RELOGIN_ON_CUT=1 para tentar)");
    return null;
  }
  // Clears the anti-bot cookies too, so "new_login" means new session AND new
  // Akamai state; enough to tell it apart from the token.
  log("apagando os cookies da Iberia e logando de novo; se pedir código, termine na janela");
  await page.context().clearCookies({ domain: /iberia\.com$/ });
  await ensureLoggedIn(page, log);
  await reopen(page, cut.date);
  if (await retry("new_login")) return "new_login";
  return null;
}

async function sweepMode(page: Page, days: string[]) {
  log(`varrendo em lotes de ${BATCH}, ${INTERVAL_MS} ms entre lotes, até ${MAX_MINUTES} min`);
  const first = await sweepUntilCut(page, days, 0);
  const result: Record<string, unknown> = { firstCut: first.cut, callsInFirstRun: first.calls };
  if (!first.cut) {
    log(`RESPOSTA 3 (corte): nenhum corte em ${MAX_MINUTES} min, ${first.calls} chamadas do script.`);
    summary.sweep = result;
    return;
  }
  log(
    `corte na ${first.cut.calls}ª chamada do script (${first.cut.okCalls} ok antes) aos ${first.cut.atMin} min de varredura: ` +
      `${first.cut.status} ${first.cut.detail} | aba em ${first.cut.where} | chamadas vistas na rede até aqui: ${availabilityCalls.seenOnNetwork}`,
  );
  const recoveredBy = await ladder(page, first.cut);
  result.recoveredBy = recoveredBy;
  let secondText = "";
  if (recoveredBy) {
    const second = await sweepUntilCut(page, days, first.nextIndex + 1);
    result.secondCut = second.cut;
    result.callsAfterRecovery = second.calls;
    secondText = second.cut
      ? `; depois disso, novo corte na ${second.cut.calls}ª chamada (${second.cut.atMin} min)`
      : `; depois disso, ${second.calls} chamadas sem corte até o fim do tempo`;
  }
  summary.sweep = result;
  log(
    `RESPOSTA 3 (corte): primeiro corte na ${first.cut.calls}ª chamada aos ${first.cut.atMin} min; ` +
      `destravou com ${recoveredBy ? LADDER_TEXT[recoveredBy] : "nada (sugere cota por IP ou por janela de tempo)"}${secondText}.`,
  );
}

const session = await startIberiaSession(false);
const { page } = session;
watch(page);
let failure: string | null = null;
try {
  const days = await calendarDays(page);
  // /availability needs a logged-in account; the calendar does not.
  await ensureLoggedIn(page, log);
  await reopen(page, days[0]!);
  if (mode === "price") await priceMode(page, days);
  if (mode === "token") await tokenMode(page, days);
  if (mode === "sweep") await sweepMode(page, days);
} catch (error) {
  failure = messageOf(error);
  log(`PAROU: ${failure}`);
} finally {
  Object.assign(summary, {
    failure,
    minutes: minutes(),
    tokens,
    reopenings,
    ladderSteps,
    navigations,
    authRequests: Object.fromEntries(authRequests),
    availabilityCalls,
  });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`saída em ${outDir}`);
  await closeChromeSession(session).catch((error: unknown) => log(`fechar a aba falhou: ${messageOf(error)}`));
  // The bot's own window, not one it attached to: closing it frees the profile.
  if (!session.viaCdp) await session.context.close().catch((error: unknown) => log(`fechar o Chrome falhou: ${messageOf(error)}`));
}
process.exit(failure ? 1 : 0);
