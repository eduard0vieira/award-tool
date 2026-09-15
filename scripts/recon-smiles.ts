import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abrirSessaoChrome } from "../src/nucleo/sessao-chrome.ts";

// FASE 0 do módulo Smiles: descobrir POR ONDE a chamada passa hoje, antes de
// escrever qualquer linha de parsing.
//
// O que se sabe do projeto antigo (projetos/cheap-flights, parado desde
// mai/2025, ver ANALISE.md lá):
// - endpoint de busca: /v1/airlines/search, um GET por data;
// - ele existe em três ambientes (prd, green, blue) e o código antigo usava o
//   `green` — cheiro de ambiente com proteção mais fraca que o de produção;
// - as chamadas imitavam o APP iOS (não o site), com x-api-key próprio. API de
//   app costuma ser menos protegida, e é isso que este recon quer confirmar.
//
// A escada, do mais barato pro mais caro:
//   1. fetch do Node, com os headers do app        (sem navegador nenhum)
//   2. fetch de DENTRO da página, no Chrome do bot (o que funciona na AA)
//
// Nada é processado: a primeira resposta 200 é salva crua.
//
// Uso: npx tsx scripts/recon-smiles.ts [GRU] [MIA] [2026-10-15]

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_FIXTURES = path.join(__dirname, "..", "fixtures");

const [origem = "GRU", destino = "MIA", data = dataDaqui(60)] = process.argv.slice(2);

function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function urlBusca(ambiente: string): string {
  const params = new URLSearchParams({
    originAirportCode: origem.toUpperCase(),
    destinationAirportCode: destino.toUpperCase(),
    departureDate: data,
    adults: "1",
    children: "0",
    infants: "0",
    forceCongener: "false",
  });
  return `https://api-air-flightsearch-${ambiente}.smiles.com.br/v1/airlines/search?${params}`;
}

// Chave de cliente do app (vinha no código antigo). É identificador público de
// aplicativo, não credencial de conta — nenhum dado de login entra aqui.
// `channel: WEB` desde 2026-09-15: com `APP` a borda responde 403 com página de
// bloqueio, e sem `channel` nenhum a resposta vem sem calendário. Ver
// contexto/notas-bloqueio-smiles.md.
const HEADERS_APP: Record<string, string> = {
  "x-api-key": "aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw",
  channel: "WEB",
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9",
};

type Resultado = { degrau: string; status: number | string; tamanho: number; amostra: string; corpo?: string };

function resumo(texto: string): string {
  return texto.replace(/\s+/g, " ").slice(0, 220);
}

async function degrauNode(ambiente: string): Promise<Resultado> {
  const degrau = `node/${ambiente}`;
  try {
    const res = await fetch(urlBusca(ambiente), { headers: HEADERS_APP });
    const texto = await res.text();
    return { degrau, status: res.status, tamanho: texto.length, amostra: resumo(texto), corpo: texto };
  } catch (err) {
    return { degrau, status: "falhou", tamanho: 0, amostra: err instanceof Error ? err.message : String(err) };
  }
}

// Duas formas de sair de dentro do navegador, porque elas falham por motivos
// diferentes:
//
// (a) navegação direta na URL da API — o Chrome vai à API como se fosse uma
//     página; sem CORS no caminho, e é o teste mais limpo de "a API aceita um
//     cliente com cara de navegador?";
// (b) fetch same-origin — abre a raiz do host da API e chama de lá de dentro.
//     Um fetch a partir de www.smiles.com.br não serve: a API está em outro
//     subdomínio, então o navegador exige CORS e a leitura é barrada mesmo se
//     a resposta chegar.
async function degrauNavegador(ambiente: string, modo: "navegar" | "fetch"): Promise<Resultado> {
  const degrau = `navegador-${modo}/${ambiente}`;
  const sessao = await abrirSessaoChrome(false, "Smiles");
  try {
    const url = urlBusca(ambiente);

    if (modo === "navegar") {
      const resposta = await sessao.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const texto = await sessao.page.evaluate(() => document.body.innerText);
      return {
        degrau,
        status: resposta?.status() ?? "sem resposta",
        tamanho: texto.length,
        amostra: resumo(texto),
        corpo: texto,
      };
    }

    const raiz = `https://api-air-flightsearch-${ambiente}.smiles.com.br/`;
    await sessao.page.goto(raiz, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sessao.page.waitForTimeout(3000);
    const r = await sessao.page.evaluate(
      async ({ url, headers }) => {
        const res = await fetch(url, { headers });
        return { status: res.status, texto: await res.text() };
      },
      { url, headers: HEADERS_APP },
    );
    return { degrau, status: r.status, tamanho: r.texto.length, amostra: resumo(r.texto), corpo: r.texto };
  } catch (err) {
    return { degrau, status: "falhou", tamanho: 0, amostra: err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err) };
  } finally {
    await sessao.page.close().catch(() => {});
  }
}

function salvar(r: Resultado) {
  if (!r.corpo) return;
  fs.mkdirSync(DIR_FIXTURES, { recursive: true });
  const destinoArq = path.join(DIR_FIXTURES, "smiles-real.json");
  fs.writeFileSync(destinoArq, r.corpo, "utf8");
  console.log(`\n✅ Resposta crua salva em fixtures/smiles-real.json (${r.corpo.length} bytes, degrau ${r.degrau}).`);
}

async function main() {
  console.log(`\nRecon Smiles — ${origem.toUpperCase()} → ${destino.toUpperCase()} em ${data}\n`);

  const resultados: Resultado[] = [];

  for (const ambiente of ["prd", "green", "blue"]) {
    const r = await degrauNode(ambiente);
    resultados.push(r);
    console.log(`[${r.degrau}] status ${r.status} · ${r.tamanho} bytes\n    ${r.amostra}\n`);
    await new Promise((ok) => setTimeout(ok, 3000));
  }

  let vencedor = resultados.find((r) => r.status === 200 && r.tamanho > 0);

  if (!vencedor) {
    console.log("Nenhum degrau de rede pura passou — subindo pro navegador.\n");
    for (const modo of ["navegar", "fetch"] as const) {
      const r = await degrauNavegador("prd", modo);
      resultados.push(r);
      console.log(`[${r.degrau}] status ${r.status} · ${r.tamanho} bytes\n    ${r.amostra}\n`);
      if (r.status === 200 && r.tamanho > 0) {
        vencedor = r;
        break;
      }
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }

  console.log("─".repeat(60));
  for (const r of resultados) console.log(`${r.degrau.padEnd(20)} ${r.status}`);
  console.log("─".repeat(60));

  if (vencedor) salvar(vencedor);
  else console.log("\n❌ Nenhum degrau devolveu 200 — nada salvo (fixture de erro não serve de schema).");

  process.exit(0);
}

main();
