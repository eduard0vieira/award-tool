// A sonda 1 mostrou que a 9ª navegação seguida para de disparar a busca.
// Falta saber O QUE acontece na tela nesse momento — sem isso, "bloqueou" é
// palpite, e palpite foi o que custou caro no Smiles.
//
// Aqui: navega, e quando a busca não dispara, fotografa o estado da página
// (URL, título, marcas de página de bloqueio) em vez de só contar o timeout.
import { openChromeSession } from "../src/core/chrome-session.ts";
import type { Page } from "playwright";

const ORIGEM = "VCP";
const DESTINO = "REC";
const ESPERA_MS = Number(process.env.ESPERA_MS ?? 0);
const QUANTAS = Number(process.env.QUANTAS ?? 14);

const d = (dias: number) => { const x = new Date(); x.setDate(x.getDate() + dias); return x.toISOString().slice(0, 10); };
const barra = (iso: string) => { const [a, m, dd] = iso.split("-").map(Number); return `${m}/${dd}/${a}`; };

function deepLink(iso: string) {
  const p = new URLSearchParams({
    "c[0].ds": ORIGEM, "c[0].std": barra(iso), "c[0].as": DESTINO,
    "p[0].t": "ADT", "p[0].c": "1", "p[0].cp": "false", "f.dl": "3", "f.dr": "3", cc: "PTS",
  });
  return `https://www.voeazul.com.br/br/pt/home/selecao-voo?${p}`;
}

async function retrato(page: Page): Promise<string> {
  const url = page.url();
  const titulo = await page.title().catch(() => "(sem título)");
  const texto = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  return `url=${url.slice(0, 70)} | título="${titulo}" | texto="${texto}"`;
}

async function main() {
  const sessao = await openChromeSession(false, "probe-azul-2");
  const page = sessao.page;
  const t0 = Date.now();

  const statusPorUrl: string[] = [];
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("voeazul.com.br") && (r.status() === 403 || r.status() === 429)) {
      statusPorUrl.push(`${r.status()} ${u.slice(0, 80)}`);
    }
  });

  for (let i = 0; i < QUANTAS; i++) {
    statusPorUrl.length = 0;
    const seg = Math.round((Date.now() - t0) / 1000);
    const pegar = page
      .waitForResponse((r) => /availability\/v\d+\/availability$/.test(r.url()), { timeout: 25_000 })
      .then((r) => r.status())
      .catch(() => null);
    await page.goto(deepLink(d(30 + i * 6)), { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    const status = await pegar;

    if (status !== null) {
      console.log(`#${String(i + 1).padStart(2)} | ${seg}s | busca disparou, status ${status}`);
    } else {
      console.log(`#${String(i + 1).padStart(2)} | ${seg}s | busca NÃO disparou`);
      console.log(`      ${await retrato(page)}`);
      if (statusPorUrl.length) console.log(`      respostas 403/429: ${statusPorUrl.slice(0, 3).join(" ; ")}`);
    }
    if (ESPERA_MS) await page.waitForTimeout(ESPERA_MS);
  }

  await page.close();
  process.exit(0);
}

main();
