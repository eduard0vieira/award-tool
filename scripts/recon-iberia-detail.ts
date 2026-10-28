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
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page, Request } from "playwright";
import { closeChromeSession } from "../src/core/chrome-session.ts";
import { RECON_DIR } from "../src/core/paths.ts";
import {
  ensureLoggedIn,
  iberiaBookingLink,
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
// The logged-in page calls /members/<Iberia Club number>; URL paths are printed
// and saved, so long digit runs never go out as they are.
const memberNumbers = new Set<string>();
const scrubPath = (pathname: string) => pathname.replace(/\d{6,}/g, "[número]");

// Responses leave this machine only after this pass; the redaction is named in
// the log, the value never is.
function save(name: string, text: string) {
  const patterns: [string, RegExp][] = [
    ["e-mail", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
    ["JWT", /eyJ[\w-]{10,}\.[\w-]{10,}(\.[\w-]+)?/g],
    ["Bearer", /bearer\s+\S+/gi],
  ];
  if (process.env.IBERIA_EMAIL) patterns.push(["IBERIA_EMAIL", new RegExp(escapeRegExp(process.env.IBERIA_EMAIL), "gi")]);
  for (const member of memberNumbers) patterns.push(["número Iberia Club", new RegExp(escapeRegExp(member), "g")]);
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

type Claims = {
  azp: string;
  iat: number;
  exp: number;
  claimNames: string[];
  acr: string | null;
  scope: string | null;
  typ: string | null;
  roles: string[] | null;
};

// Only the claim names and the non-personal values are kept; the token and the
// rest of the payload (e-mail, sub, sid) are never printed or saved.
function claimsOf(authorization: string): Claims | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /i, "").split(".")[1] ?? "", "base64url").toString());
  } catch (error) {
    // The name only: a JSON.parse message can quote part of the payload.
    log(`o token não é um JWT legível (${error instanceof Error ? error.name : "erro"})`);
    return null;
  }
  const { azp, iat, exp, acr, scope, typ, realm_access: realmAccess } = payload;
  if (typeof azp !== "string" || typeof iat !== "number" || typeof exp !== "number") {
    log("o token não trouxe azp, iat e exp com os tipos esperados");
    return null;
  }
  const roles = realmAccess && typeof realmAccess === "object" ? (realmAccess as { roles?: unknown }).roles : undefined;
  return {
    azp,
    iat,
    exp,
    claimNames: Object.keys(payload).sort(),
    acr: typeof acr === "string" ? acr : null,
    scope: typeof scope === "string" ? scope : null,
    typ: typeof typ === "string" ? typ : null,
    roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : null,
  };
}

const minutesToExp = (claims: Claims | undefined) =>
  claims ? Number(((claims.exp * 1000 - Date.now()) / 60000).toFixed(1)) : null;

// Host, path and the SPA's hash route; never the query, which on the login
// redirects can carry an authorization code.
function where(url: string) {
  if (!URL.canParse(url)) return "(url inválida)";
  const parsed = new URL(url);
  return `${parsed.host}${scrubPath(parsed.pathname)}${/^#!\/[\w-]+/.exec(parsed.hash)?.[0] ?? ""}`;
}

type Token = { authorization: string; fingerprint: string; claims: Claims };
type TokenSeen = { fingerprint: string; atMin: number; by: string; seenOn: string; lifetimeMin: number; minutesToExp: number | null; claims: Claims };

// The page holds more than one bearer at once (one showed up on /members with
// 6 min left while another had 14). Taking the last one used on any route, as
// `currentAuthorization` does, sent the older one to /availability, which
// died at its exp. The recon follows the one the site itself sends there.
const tokensSeen = new Map<string, TokenSeen>();
const unreadableTokens = new Set<string>();
const fingerprintOf = (authorization: string) => createHash("sha256").update(authorization).digest("hex").slice(0, 8);
let availabilityToken: Token | null = null;
const availabilityTokenHistory: { atMin: number; fingerprint: string; minutesToExp: number | null }[] = [];
const availabilityExpiry = () => minutesToExp(availabilityToken?.claims);

const navigations: { atMin: number; where: string; minutesToExp: number | null }[] = [];
const authRequests = new Map<string, number>();
const availabilityCalls = { byScript: 0, seenOnNetwork: 0 };
let lastWhere = "";
let lastPageLoadAt = 0;
// A token that shows up this long after a load of the site's page counts as the
// site renewing it by itself, which is the hypothesis being tested.
const PAGE_LOAD_WINDOW_MS = 30_000;

const visitsToLogin = () => navigations.filter((navigation) => navigation.where.startsWith("login.iberia.com")).length;

const tokenFamily = (claims: Claims) =>
  claims.roles?.includes("ROLE_MEMBER") ? "membro" : claims.roles?.includes("ROLE_CLIENT_WEB") ? "cliente web" : "desconhecida";

// The whole role and claim lists go to summary.json; the log keeps what tells the tokens apart.
function describeClaims(claims: Claims) {
  return (
    `família ${tokenFamily(claims)}, soft_user ${claims.roles?.includes("soft_user") ? "sim" : "não"}, ` +
    `acr=${claims.acr ?? "-"}, ${claims.roles?.length ?? 0} papéis`
  );
}

// What the network saw for each /availability. A blocked response without CORS
// headers reaches the page's fetch only as "Failed to fetch"; here its status shows.
type NetworkOutcome = { atMin: number; key: string; status: number | null; server: string | null; failure: string | null };
const networkOutcomes: NetworkOutcome[] = [];

const isAvailabilityRequest = (request: Request) =>
  request.method() === "POST" && /^https:\/\/ibisservices\.iberia\.com\/.*\/availability$/.test(request.url().split("?")[0] ?? "");

function availabilityKey(body: string | null) {
  if (!body) return "(sem corpo)";
  try {
    const parsed = JSON.parse(body) as { slices?: { date?: string }[]; marketCode?: string };
    return `${parsed.slices?.[0]?.date ?? "?"}|${parsed.marketCode ?? "?"}`;
  } catch (error) {
    log(`corpo de um availability não é JSON (${error instanceof Error ? error.name : "erro"})`);
    return "(corpo ilegível)";
  }
}

const describeOutcome = (outcome: NetworkOutcome) =>
  outcome.status !== null ? `${outcome.status}${outcome.server ? ` server=${outcome.server}` : ""}` : `falhou: ${outcome.failure}`;

function watch(page: Page) {
  page.on("request", (request) => {
    if (!URL.canParse(request.url())) return;
    const url = new URL(request.url());
    const member = /\/members\/(\d+)/.exec(url.pathname)?.[1];
    if (member) memberNumbers.add(member);
    if (/^login\.iberia\.com$|ibisauth/.test(url.host) && ["document", "xhr", "fetch"].includes(request.resourceType())) {
      const key = `${request.method()} ${url.host}${scrubPath(url.pathname)}`;
      if (!authRequests.has(key)) log(`chamada de autenticação: ${key}`);
      authRequests.set(key, (authRequests.get(key) ?? 0) + 1);
    }
    if (!/ibisservices\.iberia\.com$/.test(url.host)) return;
    const toAvailability = request.method() === "POST" && url.pathname.endsWith("/availability");
    if (toAvailability) availabilityCalls.seenOnNetwork++;
    const authorization = request.headers()["authorization"];
    if (!authorization) return;
    const fingerprint = fingerprintOf(authorization);
    if (unreadableTokens.has(fingerprint)) return;
    let seen = tokensSeen.get(fingerprint);
    if (!seen) {
      const claims = claimsOf(authorization);
      if (!claims) {
        unreadableTokens.add(fingerprint);
        return;
      }
      const by = tokensSeen.size === 0 ? "first" : Date.now() - lastPageLoadAt < PAGE_LOAD_WINDOW_MS ? "page_load" : "site";
      seen = {
        fingerprint,
        atMin: minutes(),
        by,
        seenOn: scrubPath(url.pathname),
        lifetimeMin: Number(((claims.exp - claims.iat) / 60).toFixed(1)),
        minutesToExp: minutesToExp(claims),
        claims,
      };
      tokensSeen.set(fingerprint, seen);
      const how = { first: "primeiro", page_load: "na carga da página", site: "o PRÓPRIO SITE trocou, sem recarregar" }[by];
      log(
        `token novo ${fingerprint} (${how}): azp=${claims.azp}, dura ${seen.lifetimeMin} min, expira em ${seen.minutesToExp} min, ` +
          `visto em ${seen.seenOn}; ${describeClaims(claims)}`,
      );
    }
    if (toAvailability && availabilityToken?.fingerprint !== fingerprint) {
      availabilityToken = { authorization, fingerprint, claims: seen.claims };
      availabilityTokenHistory.push({ atMin: minutes(), fingerprint, minutesToExp: minutesToExp(seen.claims) });
      log(`o availability passou a usar o token ${fingerprint} (expira em ${minutesToExp(seen.claims)} min)`);
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    if (!isAvailabilityRequest(request)) return;
    networkOutcomes.push({
      atMin: minutes(),
      key: availabilityKey(request.postData()),
      status: response.status(),
      server: response.headers()["server"] ?? null,
      failure: null,
    });
  });
  page.on("requestfailed", (request) => {
    if (!isAvailabilityRequest(request)) return;
    networkOutcomes.push({
      atMin: minutes(),
      key: availabilityKey(request.postData()),
      status: null,
      server: null,
      failure: request.failure()?.errorText ?? "sem motivo informado",
    });
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const here = where(frame.url());
    if (here.startsWith("www.iberia.com")) lastPageLoadAt = Date.now();
    if (here === lastWhere) return;
    lastWhere = here;
    navigations.push({ atMin: minutes(), where: here, minutesToExp: availabilityExpiry() });
    log(`aba em ${here} (token do availability expira em ${availabilityExpiry() ?? "?"} min)`);
  });
}

type Answer = { status: number; text: string; network?: string };
const isOk = (answer: Answer) => answer.status === 200 || answer.status === 204;
const describe = (answer: Answer) =>
  `status ${answer.status}${isOk(answer) ? "" : ` ${answer.text.slice(0, 100)}`}${answer.network ? ` | rede: ${answer.network}` : ""}`;

// -1: the fetch never came back; -2: no availability token to send; -3: the
// tab navigated in the middle of the call.
async function availability(page: Page, date: string, market = "US"): Promise<Answer> {
  const token = availabilityToken;
  if (!token) return { status: -2, text: "sem token de availability" };
  availabilityCalls.byScript++;
  const outcomesBefore = networkOutcomes.length;
  const answer: Answer = await page
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
        headers: iberiaHeaders(token.authorization, "availability"),
      },
    )
    .catch((error: unknown) => ({ status: -3, text: messageOf(error) }));
  if (isOk(answer) || answer.status === -2) return answer;
  const key = `${date}|${market}`;
  const matching = () => networkOutcomes.slice(outcomesBefore).filter((outcome) => outcome.key === key);
  // The network event can land a moment after the page's fetch gives up.
  if (matching().length === 0) await page.waitForTimeout(500).catch((error: unknown) => log(`espera falhou: ${messageOf(error)}`));
  answer.network = matching().map(describeOutcome).join(", ") || "nada registrado";
  return answer;
}

type Reopening = {
  atMin: number;
  minutesToExpBefore: number | null;
  renewed: boolean;
  passedLogin: boolean;
  pageCalledAvailability: boolean;
  fingerprint: string | null;
  minutesToExp: number | null;
  error?: string;
};
const reopenings: Reopening[] = [];

async function reopen(page: Page, date: string): Promise<Reopening> {
  const before = availabilityToken?.fingerprint ?? null;
  const minutesToExpBefore = availabilityExpiry();
  const loginVisitsBefore = visitsToLogin();
  const availabilityCallsBefore = availabilityCalls.seenOnNetwork;
  let error: string | null = null;
  try {
    // The same URL with the same #! route is an anchor jump for Chrome, not a
    // load: no availability call and no new token (seen at 12.5 min of a run).
    const withoutHash = (url: string) => url.split("#")[0];
    if (withoutHash(page.url()) === withoutHash(iberiaBookingLink(params, date))) {
      await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    }
    await openResultsPage(page, params, date, log);
    await page.waitForTimeout(5000);
  } catch (caught) {
    error = messageOf(caught);
    log(`reabrir a busca falhou: ${error}`);
  }
  const after = availabilityToken;
  const result: Reopening = {
    atMin: minutes(),
    minutesToExpBefore,
    renewed: !!after && after.fingerprint !== before,
    passedLogin: visitsToLogin() > loginVisitsBefore,
    pageCalledAvailability: availabilityCalls.seenOnNetwork > availabilityCallsBefore,
    fingerprint: after?.fingerprint ?? null,
    minutesToExp: availabilityExpiry(),
    ...(error && { error }),
  };
  reopenings.push(result);
  log(
    `reabri a busca: a página ${result.pageCalledAvailability ? "chamou" : "NÃO chamou"} o availability, ` +
      `token do availability ${after ? `${result.renewed ? "novo" : "o mesmo"} (${after.fingerprint})` : "nenhum"}, ` +
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

const msToExp = (token: Token) => token.claims.exp * 1000 - Date.now();

async function tokenMode(page: Page, days: string[]) {
  const first = availabilityToken;
  if (!first) throw new Error("a busca aberta não chamou o availability, então não há token para seguir");
  log(
    `sondando o token ${first.fingerprint} uma vez por minuto até faltarem ${RENEW_BEFORE_MS / 60000} min para o exp ` +
      `(faltam ${minutesToExp(first.claims)} min); depois, reabrir a busca`,
  );
  const probes: { atMin: number; phase: string; fingerprint: string | null; minutesToExp: number | null; status: number; where: string }[] = [];
  let index = 0;
  const probe = async (phase: string) => {
    const answer = await availability(page, days[index++ % days.length]!);
    const entry = {
      atMin: minutes(),
      phase,
      fingerprint: availabilityToken?.fingerprint ?? null,
      minutesToExp: availabilityExpiry(),
      status: answer.status,
      where: where(page.url()),
    };
    probes.push(entry);
    log(`sonda ${phase} ${probes.length}: ${describe(answer)}, token ${entry.fingerprint} expira em ${entry.minutesToExp} min, aba em ${entry.where}`);
    return answer;
  };

  let current = first;
  while (msToExp(current) > RENEW_BEFORE_MS && minutes() < MAX_MINUTES) {
    await probe("antes");
    const untilRenewal = msToExp(current) - RENEW_BEFORE_MS;
    if (untilRenewal > 0) await page.waitForTimeout(Math.min(TOKEN_PROBE_MS, untilRenewal));
    current = availabilityToken ?? current;
  }
  const reopened = await reopen(page, days[0]!);
  const afterStatuses: number[] = [];
  for (let call = 0; call < 2; call++) {
    afterStatuses.push((await probe("depois")).status);
    await page.waitForTimeout(INTERVAL_MS);
  }
  const renewedBySite = [...tokensSeen.values()].filter((token) => token.by === "site").length;
  summary.token = { firstFingerprint: first.fingerprint, lifetimeMin: (first.claims.exp - first.claims.iat) / 60, probes, reopened, afterStatuses, renewedBySite };
  log(
    `RESPOSTA 2 (token): o token do availability (${first.fingerprint}) dura ${((first.claims.exp - first.claims.iat) / 60).toFixed(1)} min; ` +
      `reabrir a busca com ${reopened.minutesToExpBefore} min para o exp ${reopened.renewed ? "TROUXE token novo" : "NÃO trouxe token novo"} ` +
      `${reopened.passedLogin ? "e passou pelo login" : "sem passar pelo login"} (a página ${reopened.pageCalledAvailability ? "chamou" : "não chamou"} o availability); ` +
      `chamadas depois: ${afterStatuses.join(", ")}; o site trocou o token sozinho ${renewedBySite} vez(es); ${tokensSeen.size} token(s) distintos vistos.`,
  );
}

type Cut = { atMin: number; calls: number; okCalls: number; date: string; status: number; detail: string; network: string | null; where: string };

async function renewIfNeeded(page: Page, date: string) {
  const left = availabilityToken ? msToExp(availabilityToken) : null;
  if (left !== null && left > RENEW_BEFORE_MS) return;
  log(left !== null ? `faltam ${availabilityExpiry()} min para o token do availability expirar; renovando` : "sem token de availability; reabrindo a busca");
  const reopened = await reopen(page, date);
  // Otherwise the expired token's 401 would be counted as Iberia cutting the sweep.
  if (!availabilityToken || msToExp(availabilityToken) <= RENEW_BEFORE_MS) {
    throw new Error(
      `reabrir a busca não trouxe token de availability novo (${reopened.fingerprint ?? "nenhum"}, expira em ${reopened.minutesToExp ?? "?"} min)`,
    );
  }
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
        network: answer.network ?? null,
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
      `${first.cut.status} ${first.cut.detail} | rede: ${first.cut.network ?? "-"} | aba em ${first.cut.where} | chamadas vistas na rede até aqui: ${availabilityCalls.seenOnNetwork}`,
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
  if (!availabilityToken) throw new Error("a busca aberta não chamou o availability, então não há o token que o site usa ali");
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
    tokens: [...tokensSeen.values()],
    availabilityTokenHistory,
    reopenings,
    ladderSteps,
    navigations,
    authRequests: Object.fromEntries(authRequests),
    availabilityCalls,
    networkStatusCounts: networkOutcomes.reduce<Record<string, number>>((counts, outcome) => {
      const label = outcome.status !== null ? String(outcome.status) : `falha ${outcome.failure}`;
      counts[label] = (counts[label] ?? 0) + 1;
      return counts;
    }, {}),
    networkOutcomes,
  });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`saída em ${outDir}`);
  await closeChromeSession(session).catch((error: unknown) => log(`fechar a aba falhou: ${messageOf(error)}`));
  // The bot's own window, not one it attached to: closing it frees the profile.
  if (!session.viaCdp) await session.context.close().catch((error: unknown) => log(`fechar o Chrome falhou: ${messageOf(error)}`));
}
process.exit(failure ? 1 : 0);
