import { abrirSessaoChrome } from "../src/nucleo/sessao-chrome.ts";

// Mede duas coisas numa rota: até quantos dias à frente o Smiles vende (e o que
// responde depois disso) e se o calendário de 7 dias vem, com e sem congênere.
//
// Uso: npx tsx scripts/recon-smiles-janela.ts GRU MRU

const [origem = "GRU", destino = "MRU"] = process.argv.slice(2);
const RAIZ = "https://api-air-flightsearch-prd.smiles.com.br/";
const HEADERS = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "WEB",
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9",
};

function hojeMais(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function url(data: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    originAirportCode: origem,
    destinationAirportCode: destino,
    departureDate: data,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
    ...extra,
  });
  return `${RAIZ}v1/airlines/search?${q}`;
}

async function main() {
  const sessao = await abrirSessaoChrome(false, "Smiles");
  await sessao.page.goto(RAIZ, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await sessao.page.waitForTimeout(3000);

  const chamar = async (rotulo: string, u: string) => {
    const r = await sessao.page.evaluate(
      async ({ u, headers }) => {
        const res = await fetch(u, { headers });
        return { status: res.status, texto: await res.text() };
      },
      { u, headers: HEADERS },
    );
    let resumo = r.texto.replace(/\s+/g, " ").slice(0, 300);
    if (r.status === 200) {
      const j = JSON.parse(r.texto);
      const seg = j.requestedFlightSegmentList?.[0];
      resumo =
        `hasCalendar=${j.hasCalendar} calendarStatus=${j.calendarStatus} resultType=${j.resultType} ` +
        `voos=${seg?.flightList?.length ?? 0} calendario=${seg?.calendarDayList?.length ?? 0} ` +
        `gds=${[...new Set((seg?.flightList ?? []).map((f: { sourceGDS: string }) => f.sourceGDS))].join("/")}`;
    }
    console.log(`[${rotulo}] ${r.status} · ${resumo}`);
    await sessao.page.waitForTimeout(4000);
  };

  try {
    await chamar(`+30 congener=false`, url(hojeMais(30)));
    await chamar(`+30 congener=true`, url(hojeMais(30), { forceCongener: "true" }));
    for (const d of [320, 326, 328, 329, 330, 331, 335]) await chamar(`+${d} ${hojeMais(d)}`, url(hojeMais(d)));
    await chamar(`+30 sigla inválida`, url(hojeMais(30)).replace(`destinationAirportCode=${destino}`, "destinationAirportCode=XQZ"));
  } finally {
    await sessao.page.close().catch(() => {});
    process.exit(0);
  }
}

main();
