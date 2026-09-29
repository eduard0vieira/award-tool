import "dotenv/config";
import { aaBookingLink, startAaSession, type AaCabin } from "../src/scrapers/aa/aa.scraper.ts";

// Reproduz a chamada de calendário que a fonte da AA faz, mês a mês, e mostra a
// RESPOSTA CRUA. Existe porque uma busca HEL→NRT em executiva devolveu
// "Calendário devolveu erro: 309" em alguns meses e nada nos outros, enquanto o
// site mostrava 75K em quase todo dia de julho/2027.
//
// Uso: npx tsx scripts/probe-calendario-aa.ts HEL NRT executiva 0

const [origem = "HEL", destino = "NRT", cabine = "executiva", conexoesBruto = ""] = process.argv.slice(2);
const maxConexoes = conexoesBruto === "" ? null : Number(conexoesBruto);

const CABINE_REQUEST: Record<string, string> = {
  economica: "COACH",
  premium: "PREMIUM_ECONOMY",
  executiva: "BUSINESS,FIRST",
  primeira: "FIRST",
};

function corpo(departureDate: string, cabinReq: string, stops: number | null) {
  return {
    metadata: { selectedProducts: [], tripType: "OneWay", udo: {} },
    passengers: [{ type: "adult", count: 1 }],
    requestHeader: { clientId: "AAcom" },
    slices: [
      {
        allCarriers: true,
        cabin: cabinReq,
        departureDate,
        destination: destino.toUpperCase(),
        destinationNearbyAirports: false,
        maxStops: stops,
        origin: origem.toUpperCase(),
        originNearbyAirports: false,
      },
    ],
    tripOptions: {
      corporateBooking: false,
      fareType: "Lowest",
      locale: "en_US",
      pointOfSale: null,
      searchType: "Award",
      enableBenefits: true,
    },
    loyaltyInfo: null,
    version: "",
    queryParams: { sliceIndex: 0, sessionId: "", solutionSet: "", solutionId: "" },
  };
}

async function main() {
  const sessao = await startAaSession(false);
  const page = sessao.page;
  try {
    const url = aaBookingLink(
      { origin: origem.toUpperCase(), destination: destino.toUpperCase(), passengers: 1, cabin: cabine as AaCabin },
      "2027-07-15",
    );
    console.log(`abrindo ${url.slice(0, 110)}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(10_000);
    console.log(`URL final: ${page.url().slice(0, 110)}`);
    console.log(`título: ${await page.title()}\n`);

    // Julho/2027 é o mês que o site mostra cheio de 75K — se algum caso
    // responder, é por ali.
    // Os meses que a varredura reporta como falha, mais um que sabidamente
    // funciona — é a comparação que diz o que o 309 significa.
    const casos = ["2026-09-26", "2026-10-15", "2026-11-15", "2026-12-15", "2027-01-15", "2027-07-15"].map(
      (data) => ({ rotulo: `mês de ${data.slice(0, 7)}`, data }),
    );

    for (const caso of casos) {
      const r = (await page.evaluate(async (c) => {
        const res = await fetch("/booking/api/search/calendar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(c),
        });
        return { status: res.status, texto: await res.text() };
      }, corpo(caso.data, CABINE_REQUEST[cabine]!, maxConexoes))) as { status: number; texto: string };

      let resumo = `status ${r.status}, ${r.texto.length} bytes`;
      try {
        const j = JSON.parse(r.texto) as {
          error?: string;
          calendarMonths?: { weeks?: { days?: { date: string | null; validDay: boolean; solution: { perPassengerAwardPoints: number } | null }[] }[] }[];
        };
        if (j.error) {
          resumo += ` | error="${j.error}"`;
        } else {
          const dias = (j.calendarMonths ?? [])
            .flatMap((m) => m.weeks ?? [])
            .flatMap((w) => w.days ?? [])
            .filter((d) => d?.validDay && d.solution && d.date);
          const pontos = dias.map((d) => d.solution!.perPassengerAwardPoints);
          resumo += ` | ${dias.length} dia(s) com prêmio`;
          if (pontos.length) resumo += `, de ${Math.min(...pontos)} a ${Math.max(...pontos)}`;
        }
      } catch {
        resumo += " | corpo não é JSON";
      }
      console.log(`${caso.rotulo}\n   ${resumo}`);
      if (r.texto.length < 700) console.log(`   corpo: ${r.texto}`);
      await page.waitForTimeout(6000);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  },
);
