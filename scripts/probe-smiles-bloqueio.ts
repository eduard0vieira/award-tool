import { abrirSessaoChrome } from "../src/nucleo/sessao-chrome.ts";

// Diz por que o Smiles está negando as buscas hoje.
//
// Existem três negativas diferentes e elas se parecem no log:
//
//   406 JSON            → orçamento de requisições por IP (medido: >20 min)
//   403 HTML "Access Denied" → a borda (Akamai) recusou ESTA requisição
//   403 JSON            → resposta normal do API Gateway pra rota inexistente,
//                         é o que a raiz devolve sempre; não é bloqueio
//
// O que separa um do outro não é o número, é o corpo — e, no caso do 403 HTML,
// qual header foi mandado. Em 2026-09-15 o `channel: APP` passou a ser negado
// sozinho: mesma URL, mesmos cookies, APP dá HTML e WEB dá 200.
//
// Por isso o probe mede variantes de header em vez de só repetir a busca, e
// compara com uma chamada de fora do navegador (que responde 406 quando o IP
// está de boa).
//
// Uso: npx tsx scripts/probe-smiles-bloqueio.ts [GRU] [MIA] [2026-11-20]

const [origem = "GRU", destino = "MIA", data = dataDaqui(60)] = process.argv.slice(2);

const RAIZ = "https://api-air-flightsearch-prd.smiles.com.br/";
const CHAVE = "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw";

// A que está no bot hoje vem primeiro: é a que interessa saber se ainda passa.
const VARIANTES: Array<[string, Record<string, string>]> = [
  ["web (a do bot)", { "x-api-key": CHAVE, channel: "WEB", accept: "application/json, text/plain, */*", "accept-language": "pt-BR,pt;q=0.9" }],
  ["app (negado em set/2026)", { "x-api-key": CHAVE, channel: "APP", accept: "application/json, text/plain, */*" }],
  ["sem channel", { "x-api-key": CHAVE, "accept-language": "pt-BR,pt;q=0.9" }],
];

function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function urlBusca(): string {
  const params = new URLSearchParams({
    originAirportCode: origem.toUpperCase(),
    destinationAirportCode: destino.toUpperCase(),
    departureDate: data,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `${RAIZ}v1/airlines/search?${params}`;
}

type Leitura = { status: number; bloqueada: boolean; resumo: string };

function ler(status: number, texto: string): Leitura {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.startsWith("<")) {
    const ref = limpo.match(/Reference\s*(?:&#32;)?\s*#([\w.]+)/i);
    return { status, bloqueada: true, resumo: `HTML de bloqueio${ref ? `, referência ${ref[1]}` : ""}` };
  }
  if (status === 200) {
    try {
      const seg = JSON.parse(limpo).requestedFlightSegmentList?.[0];
      return {
        status,
        bloqueada: false,
        resumo: `${seg?.flightList?.length ?? 0} voo(s), ${seg?.calendarDayList?.length ?? 0} dia(s) de calendário`,
      };
    } catch {
      return { status, bloqueada: false, resumo: "200, mas o corpo não é o JSON esperado" };
    }
  }
  return { status, bloqueada: false, resumo: limpo.slice(0, 110) };
}

async function main() {
  console.log(`\nProbe de bloqueio do Smiles — ${origem.toUpperCase()} → ${destino.toUpperCase()} em ${data}\n`);

  // Degrau 0: fora do navegador. 406 aqui é o normal e significa "o IP está
  // liberado"; qualquer HTML de bloqueio significa que a borda barrou o IP.
  let deFora: Leitura;
  try {
    const res = await fetch(urlBusca(), { headers: { "x-api-key": CHAVE } });
    deFora = ler(res.status, await res.text());
  } catch (err) {
    deFora = { status: -1, bloqueada: false, resumo: err instanceof Error ? err.message : String(err) };
  }
  console.log(`[fora do navegador] ${deFora.status} · ${deFora.resumo}\n`);

  const sessao = await abrirSessaoChrome(false, "Smiles");
  const leituras: Array<[string, Leitura]> = [];

  try {
    await sessao.page.goto(RAIZ, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sessao.page.waitForTimeout(3000);

    for (const [nome, headers] of VARIANTES) {
      const r = await sessao.page.evaluate(
        async ({ url, headers }) => {
          try {
            const res = await fetch(url, { headers });
            return { status: res.status, texto: await res.text() };
          } catch (err) {
            return { status: -1, texto: String(err) };
          }
        },
        { url: urlBusca(), headers },
      );
      const leitura = ler(r.status, r.texto);
      leituras.push([nome, leitura]);
      console.log(`[${nome}] ${leitura.status} · ${leitura.resumo}`);
      await sessao.page.waitForTimeout(5000);
    }
  } finally {
    await sessao.page.close().catch(() => {});
  }

  const doBot = leituras[0]![1];
  console.log("\n" + "─".repeat(64));

  if (doBot.status === 200) {
    const outraPassa = leituras.slice(1).some(([, l]) => l.status === 200);
    console.log(
      "Leitura: a busca do bot está passando. Se o app reclamou de bloqueio, foi momentâneo" +
        (outraPassa ? "." : " — e só o header do bot passa hoje."),
    );
  } else if (doBot.bloqueada) {
    const saida = leituras.slice(1).find(([, l]) => l.status === 200);
    console.log(
      saida
        ? `Leitura: a borda passou a negar o header do bot, mas "${saida[0]}" ainda responde 200. Troque o header em HEADERS_API.`
        : "Leitura: a borda nega todas as variantes de header." +
            (deFora.bloqueada
              ? " De fora do navegador também — é bloqueio deste IP."
              : " De fora do navegador o IP passa, então o alvo é o navegador: limpe os cookies do perfil e reveja os headers."),
    );
  } else if (doBot.status === 406) {
    console.log("Leitura: 406 — orçamento de requisições por IP. Não é o 403; espere ~30 min e refaça.");
  } else {
    console.log("Leitura: combinação fora do esperado. Anote os números em contexto/notas-bloqueio-smiles.md.");
  }

  process.exit(0);
}

main();
