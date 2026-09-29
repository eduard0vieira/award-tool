import { openChromeSession } from "../src/core/chrome-session.ts";

// Says why Smiles is denying searches today. There are three different denials
// and they look alike in the log:
//
//   406 JSON                  → per-IP request budget (measured: >20 min)
//   403 HTML "Access Denied"  → the edge (Akamai) refused THIS request
//   403 JSON                  → the API Gateway's normal answer for a missing
//                               route, what the root always returns; not a block
//
// What tells them apart is not the number but the body and, for the HTML 403,
// which header was sent. On 2026-09-15 `channel: APP` started being denied on
// its own: same URL, same cookies, APP gives HTML and WEB gives 200.
//
// So the probe measures header variants instead of just repeating the search,
// and compares with a call from outside the browser (which answers 406 when the IP is fine).
//
// Usage: npx tsx scripts/probe-smiles-block.ts [GRU] [MIA] [2026-11-20]

const [origin = "GRU", destination = "MIA", date = daysFromToday(60)] = process.argv.slice(2);

const API_ROOT = "https://api-air-flightsearch-prd.smiles.com.br/";
const API_KEY = "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw";

// The one the scraper uses today comes first: whether it still passes is what matters.
const VARIANTS: Array<[string, Record<string, string>]> = [
  ["web (a do bot)", { "x-api-key": API_KEY, channel: "WEB", accept: "application/json, text/plain, */*", "accept-language": "pt-BR,pt;q=0.9" }],
  ["app (negado em set/2026)", { "x-api-key": API_KEY, channel: "APP", accept: "application/json, text/plain, */*" }],
  ["sem channel", { "x-api-key": API_KEY, "accept-language": "pt-BR,pt;q=0.9" }],
];

function daysFromToday(days: number): string {
  const today = new Date();
  today.setDate(today.getDate() + days);
  return today.toISOString().slice(0, 10);
}

function searchUrl(): string {
  const params = new URLSearchParams({
    originAirportCode: origin.toUpperCase(),
    destinationAirportCode: destination.toUpperCase(),
    departureDate: date,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `${API_ROOT}v1/airlines/search?${params}`;
}

type Reading = { status: number; blocked: boolean; summary: string };

function read(status: number, text: string): Reading {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.startsWith("<")) {
    const reference = clean.match(/Reference\s*(?:&#32;)?\s*#([\w.]+)/i);
    return { status, blocked: true, summary: `HTML de bloqueio${reference ? `, referência ${reference[1]}` : ""}` };
  }
  if (status === 200) {
    try {
      const segment = JSON.parse(clean).requestedFlightSegmentList?.[0];
      return {
        status,
        blocked: false,
        summary: `${segment?.flightList?.length ?? 0} voo(s), ${segment?.calendarDayList?.length ?? 0} dia(s) de calendário`,
      };
    } catch {
      return { status, blocked: false, summary: "200, mas o corpo não é o JSON esperado" };
    }
  }
  return { status, blocked: false, summary: clean.slice(0, 110) };
}

async function main() {
  console.log(`\nProbe de bloqueio do Smiles — ${origin.toUpperCase()} → ${destination.toUpperCase()} em ${date}\n`);

  // Step 0: outside the browser. 406 here is normal and means "the IP is
  // free"; any HTML block page means the edge blocked the IP.
  let outside: Reading;
  try {
    const response = await fetch(searchUrl(), { headers: { "x-api-key": API_KEY } });
    outside = read(response.status, await response.text());
  } catch (err) {
    outside = { status: -1, blocked: false, summary: err instanceof Error ? err.message : String(err) };
  }
  console.log(`[fora do navegador] ${outside.status} · ${outside.summary}\n`);

  const session = await openChromeSession(false, "Smiles");
  const readings: Array<[string, Reading]> = [];

  try {
    await session.page.goto(API_ROOT, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await session.page.waitForTimeout(3000);

    for (const [name, headers] of VARIANTS) {
      const response = await session.page.evaluate(
        async ({ url, headers }) => {
          try {
            const result = await fetch(url, { headers });
            return { status: result.status, text: await result.text() };
          } catch (err) {
            return { status: -1, text: String(err) };
          }
        },
        { url: searchUrl(), headers },
      );
      const reading = read(response.status, response.text);
      readings.push([name, reading]);
      console.log(`[${name}] ${reading.status} · ${reading.summary}`);
      await session.page.waitForTimeout(5000);
    }
  } finally {
    await session.page.close().catch(() => {});
  }

  const scraperReading = readings[0]![1];
  console.log("\n" + "─".repeat(64));

  if (scraperReading.status === 200) {
    const anotherPasses = readings.slice(1).some(([, reading]) => reading.status === 200);
    console.log(
      "Leitura: a busca do bot está passando. Se o app reclamou de bloqueio, foi momentâneo" +
        (anotherPasses ? "." : " — e só o header do bot passa hoje."),
    );
  } else if (scraperReading.blocked) {
    const workaround = readings.slice(1).find(([, reading]) => reading.status === 200);
    console.log(
      workaround
        ? `Leitura: a borda passou a negar o header do bot, mas "${workaround[0]}" ainda responde 200. Troque o header em API_HEADERS.`
        : "Leitura: a borda nega todas as variantes de header." +
            (outside.blocked
              ? " De fora do navegador também — é bloqueio deste IP."
              : " De fora do navegador o IP passa, então o alvo é o navegador: limpe os cookies do perfil e reveja os headers."),
    );
  } else if (scraperReading.status === 406) {
    console.log("Leitura: 406 — orçamento de requisições por IP. Não é o 403; espere ~30 min e refaça.");
  } else {
    console.log("Leitura: combinação fora do esperado. Anote os números em docs/recon/smiles-blocking.md.");
  }

  process.exit(0);
}

main();
