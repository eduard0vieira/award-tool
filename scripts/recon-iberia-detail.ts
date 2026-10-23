// Answers three questions about Iberia's per-flight detail (docs/recon/iberia.md §17):
// 1. does /availability carry each flight's Avios (cheap-flights read it from
//    offers[].totalPrice.fare on direct IB/I2/VY flights)?
// 2. does the web bearer expire in 15 minutes, and does reopening the results
//    page hand a new one without logging in again?
// 3. where does the detail get cut, and does a fresh token lift the cut?
// Usage: npx tsx scripts/recon-iberia-detail.ts GRU MAD [outDir] (default: the system temp dir)
// INTERVAL_MS (default 5000) spaces the sweep calls; MAX_MINUTES (default 25) ends it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import {
  currentAuthorization,
  ensureLoggedIn,
  iberiaBookingLink,
  iberiaHeaders,
  openResultsPage,
  searchIberiaYear,
  startIberiaSession,
} from "../src/scrapers/iberia/iberia.scraper.ts";

const [origin = "GRU", destination = "MAD", outDir = os.tmpdir()] = process.argv.slice(2);
const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 5000;
const MAX_MINUTES = Number(process.env.MAX_MINUTES) || 25;
const params = { origin, destination, passengers: 1 };
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 60000).toFixed(1)} min`;
const log = (message: string) => console.log(`[${elapsed()}] ${message}`);

// Only the claims that matter; the token itself is never printed or saved.
function claims(authorization: string | null) {
  if (!authorization) return null;
  try {
    const payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1]!, "base64url").toString());
    return { azp: payload.azp as string, exp: payload.exp as number, iat: payload.iat as number };
  } catch {
    return null;
  }
}

async function availability(page: Page, date: string, market: string) {
  const authorization = currentAuthorization(page);
  if (!authorization) return { status: -2, text: "sem token" };
  return page.evaluate(
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
  );
}

type Offer = { bookingClass?: string; remainingSeats?: number; totalPrice?: unknown };
type Slice = { stopsNumber?: number; segments?: { flight?: { operationalCarrier?: { code?: string } }; offers?: Offer[] }[] };

// One line per itinerary: carriers, stops and whether its offers carry a price.
function describe(text: string) {
  const body = JSON.parse(text) as { originDestinations?: { slices?: Slice[] }[] };
  const rows: { carriers: string; stops: number; priced: number; offers: number; sample?: unknown }[] = [];
  for (const od of body.originDestinations ?? []) {
    for (const slice of od.slices ?? []) {
      const segments = slice.segments ?? [];
      const offers = segments.flatMap((segment) => segment.offers ?? []);
      const priced = offers.filter((offer) => offer.totalPrice !== undefined);
      rows.push({
        carriers: segments.map((segment) => segment.flight?.operationalCarrier?.code ?? "?").join(">"),
        stops: slice.stopsNumber ?? segments.length - 1,
        priced: priced.length,
        offers: offers.length,
        ...(priced[0] && { sample: { cabin: priced[0].bookingClass, totalPrice: priced[0].totalPrice } }),
      });
    }
  }
  return rows;
}

async function freshToken(page: Page, date: string) {
  await openResultsPage(page, params, date, log);
  await page.waitForTimeout(5000);
  return claims(currentAuthorization(page));
}

const session = await startIberiaSession(false);
const { page } = session;
try {
  const year = await searchIberiaYear(page, params, log);
  if (year.kind !== "ok" && year.kind !== "partial") throw new Error(`calendário: ${JSON.stringify(year).slice(0, 300)}`);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const days = year.days.map((day) => day.date).filter((date) => date >= tomorrow);
  log(`calendário: ${days.length} dias com Avios`);
  // /availability needs a logged-in account; the calendar does not.
  await ensureLoggedIn(page, log);
  await openResultsPage(page, params, days[0]!, log);
  await page.waitForTimeout(5000);
  log(`tela depois do login: ${page.url().slice(0, 90)}`);
  let token = claims(currentAuthorization(page));
  log(`token: azp=${token?.azp} dura ${token ? Math.round((token.exp - token.iat) / 60) : "?"} min, expira em ${token ? Math.round((token.exp * 1000 - Date.now()) / 60000) : "?"} min`);

  // 1. Price, on the first days with Avios, in both markets.
  let savedPriced = false;
  for (const date of days.slice(0, 4)) {
    for (const market of ["US", "BR"]) {
      const response = await availability(page, date, market);
      if (response.status !== 200) {
        log(`preço ${date} ${market}: status ${response.status} ${response.text.slice(0, 120)} | tela ${page.url().slice(0, 80)}`);
        continue;
      }
      const rows = describe(response.text);
      const direct = rows.filter((row) => row.stops === 0);
      log(`preço ${date} ${market}: ${rows.length} itinerários, ${rows.filter((row) => row.priced > 0).length} com preço; diretos: ${JSON.stringify(direct)}`);
      fs.writeFileSync(path.join(outDir, `iberia-availability-${origin}-${destination}-${date}-${market}.json`), response.text);
      if (!savedPriced && direct.some((row) => row.priced > 0)) {
        fs.writeFileSync(path.join(outDir, "iberia-availability-ib-direct.json"), response.text);
        savedPriced = true;
      }
      await page.waitForTimeout(INTERVAL_MS);
    }
  }

  // 2 and 3. Sequential sweep, renewing the token before it expires.
  let calls = 0;
  let firstCut: { calls: number; at: string } | null = null;
  for (let index = 0; Date.now() - started < MAX_MINUTES * 60000; index++) {
    const date = days[index % days.length]!;
    if (token && token.exp * 1000 - Date.now() < 3 * 60000) {
      const before = token.exp;
      token = await freshToken(page, date);
      log(`token renovado: ${token ? (token.exp !== before ? "novo" : "o mesmo") : "nenhum"}, tela ${page.url().slice(0, 80)}`);
    }
    const response = await availability(page, date, "US");
    calls++;
    if (response.status === 200 || response.status === 204) {
      if (calls % 10 === 0) log(`${calls} chamadas ok`);
    } else {
      log(`corte na chamada ${calls} (${date}): status ${response.status} ${response.text.slice(0, 100)} | tela ${page.url().slice(0, 80)}`);
      if (!firstCut) {
        firstCut = { calls, at: elapsed() };
        await page.waitForTimeout(30_000);
        token = await freshToken(page, date);
        const retry = await availability(page, date, "US");
        log(`depois de 30 s e token novo (${token ? "veio" : "não veio"}): status ${retry.status}`);
        if (retry.status !== 200 && retry.status !== 204) break;
      } else {
        break;
      }
    }
    await page.waitForTimeout(INTERVAL_MS);
  }
  log(`fim: ${calls} chamadas, primeiro corte ${firstCut ? `na ${firstCut.calls}ª aos ${firstCut.at}` : "não houve"}`);
  log(`link do primeiro dia: ${iberiaBookingLink(params, days[0]!).slice(0, 60)}...`);
} finally {
  await session.page.close().catch(() => {});
}
