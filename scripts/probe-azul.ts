// Três perguntas que o recon deixou como inferência, não como medida:
//  A. o teto é mesmo 6 datas, ou a 7ª chamada quebrou por causa da DATA que
//     entrou junto (dia 132) e não pela quantidade?
//  B. flexibleDays ±3 muda alguma coisa na resposta?
//  C. o site aguenta 30 navegações seguidas, que é o regime real do módulo?
//     (a lição do Smiles: volume tem orçamento, e ele só aparece medindo)
import { abrirSessaoChrome } from "/Users/eduard0vieira/projetos/award-tool/sessao-chrome.ts";
import type { Page } from "playwright";

const ORIGEM = "VCP";
const DESTINO = "REC";

function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}
function barra(iso: string): string {
  const [a, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${a}`;
}
function criterio(iso: string) {
  return { departureStation: ORIGEM, arrivalStation: DESTINO, std: barra(iso), departureDate: iso };
}
function corpo(datas: string[], flex: number) {
  return {
    criteria: datas.map(criterio),
    passengers: [{ type: "ADT", count: "1", companionPass: false }],
    flexibleDays: { daysToLeft: String(flex), daysToRight: String(flex) },
    currencyCode: "BRL",
  };
}
function deepLink(iso: string): string {
  const p = new URLSearchParams({
    "c[0].ds": ORIGEM, "c[0].std": barra(iso), "c[0].as": DESTINO,
    "p[0].t": "ADT", "p[0].c": "1", "p[0].cp": "false",
    "f.dl": "3", "f.dr": "3", cc: "PTS",
  });
  return `https://www.voeazul.com.br/br/pt/home/selecao-voo?${p}`;
}

type Saida = { status: number; ms: number; trips: { std: string; low: number | null }[]; bruto: string };

async function chamar(page: Page, b: object): Promise<Saida> {
  const t0 = Date.now();
  const pegar = page.waitForResponse((r) => /availability\/v\d+\/availability$/.test(r.url()), { timeout: 60_000 });
  await page.goto(deepLink(dataDaqui(90)), { waitUntil: "domcontentloaded", timeout: 90_000 });
  const r = await pegar;
  const texto = await r.text();
  const ms = Date.now() - t0;
  let trips: { std: string; low: number | null }[] = [];
  try {
    const j = JSON.parse(texto) as { data?: { trips?: { std?: string; fareInformation?: { lowestPoints?: number } }[] } };
    trips = (j.data?.trips ?? []).map((t) => ({
      std: (t.std ?? "").split("T")[0] ?? "",
      low: t.fareInformation?.lowestPoints ?? null,
    }));
  } catch { /* status conta a história */ }
  return { status: r.status(), ms, trips, bruto: texto };
}

async function main() {
  const sessao = await abrirSessaoChrome(false, "probe-azul");
  const page = sessao.page;

  let corpoAtual: object | null = null;
  await page.route("**/availability/v*/availability", async (rota) => {
    if (!corpoAtual) return rota.continue();
    await rota.continue({ postData: JSON.stringify(corpoAtual) });
  });

  // ── A. o teto é 6, ou foi a data ruim? ──────────────────────────────────────
  console.log("A. Teto de datas, todas dentro da mesma faixa (dias 90–125)\n");
  for (const n of [6, 7, 8, 10]) {
    // 7 datas espremidas em 90..125 — nenhuma passa do dia 125, que já sabemos bom
    const datas = Array.from({ length: n }, (_, k) => dataDaqui(90 + Math.round((k * 35) / (n - 1))));
    corpoAtual = corpo(datas, 3);
    const r = await chamar(page, corpoAtual);
    console.log(`   ${n} datas (${datas[0]}..${datas[datas.length - 1]}) → ${r.status} | ${r.trips.length} trips | ${r.ms}ms`);
    if (r.status !== 200) console.log(`      ${r.bruto.slice(0, 120)}`);
    await page.waitForTimeout(1500);
  }

  // ── B. flexibleDays muda a resposta? ───────────────────────────────────────
  console.log("\nB. flexibleDays: ±3 contra 0\n");
  const seisDatas = Array.from({ length: 6 }, (_, k) => dataDaqui(90 + k * 7));
  const comparacao: Record<string, Record<string, number | null>> = {};
  for (const flex of [3, 0]) {
    corpoAtual = corpo(seisDatas, flex);
    const r = await chamar(page, corpoAtual);
    console.log(`   flex ±${flex} → ${r.status} | ${r.trips.length} trips | ${r.bruto.length} bytes`);
    comparacao[`flex${flex}`] = Object.fromEntries(r.trips.map((t) => [t.std, t.low]));
    await page.waitForTimeout(1500);
  }
  console.log("   lowestPoints por data:");
  for (const d of seisDatas) {
    const a = comparacao.flex3?.[d] ?? null;
    const b = comparacao.flex0?.[d] ?? null;
    console.log(`     ${d}: ±3 → ${a} | 0 → ${b} ${a === b ? "" : "  ← DIFERENTE"}`);
  }

  // ── C. aguenta 30 navegações seguidas? ─────────────────────────────────────
  console.log("\nC. Volume: 30 navegações seguidas, 6 datas cada (o regime real)\n");
  const t0 = Date.now();
  let primeiroErro: string | null = null;
  for (let i = 0; i < 30; i++) {
    const datas = Array.from({ length: 6 }, (_, k) => dataDaqui(30 + i * 6 + k));
    corpoAtual = corpo(datas, 3);
    let r: Saida;
    try {
      r = await chamar(page, corpoAtual);
    } catch (erro) {
      console.log(`   #${i + 1} | sem resposta: ${(erro as Error).message.slice(0, 80)}`);
      primeiroErro ??= `#${i + 1} sem resposta`;
      continue;
    }
    const pedidas = new Set(datas);
    const vieram = r.trips.map((t) => t.std);
    const bate = vieram.length === datas.length && vieram.every((d) => pedidas.has(d));
    const seg = Math.round((Date.now() - t0) / 1000);
    console.log(`   #${String(i + 1).padStart(2)} | ${seg}s | status ${r.status} | ${r.trips.length} trips | ${r.ms}ms${bate ? "" : "  ← DATAS NÃO BATEM"}`);
    if (r.status !== 200 && !primeiroErro) primeiroErro = `#${i + 1} status ${r.status}`;
    if (!bate && !primeiroErro) primeiroErro = `#${i + 1} datas não batem: ${vieram.join(",")}`;
    if (r.status !== 200) console.log(`      ${r.bruto.slice(0, 150)}`);
  }
  const total = Math.round((Date.now() - t0) / 1000);
  console.log(`\n   30 navegações em ${total}s (${Math.round(total / 30)}s cada)`);
  console.log(`   primeiro problema: ${primeiroErro ?? "nenhum"}`);
  console.log(`   → um ano por direção (61 chamadas) levaria ~${Math.round((total / 30) * 61 / 60)} min`);

  await page.close();
  process.exit(0);
}

main();
