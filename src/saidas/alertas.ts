import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { DIR_ALERTAS_GERADOS, DIR_PORTAL_DIST } from "../nucleo/caminhos.ts";

// Conexão com o gerador de alertas (projetos/vcc-alertas-portal): transforma
// o resultado de uma busca do bot num alerta pronto pra encaminhar no grupo —
// a(s) imagem(ns) do card V2 + a legenda de WhatsApp, exatamente como o
// portal gera manualmente.
//
// Como funciona: o build do portal (vcc-alertas-portal/dist) é servido pelo
// próprio servidor do bot em /portal, e a página pública ?render (ver
// RenderAlerta.jsx no portal) renderiza o card a partir da rota serializada
// no hash da URL — sem Supabase e sem login. Um Chromium headless abre essa
// página, tira screenshot do(s) card(s) e lê a legenda. Os PNGs ficam em
// ./alertas (servido em /alertas), prontos pra baixar e encaminhar.

export { DIR_PORTAL_DIST };
export const DIR_ALERTAS = DIR_ALERTAS_GERADOS;

// Como o portal nomeia companhia (AIRLINES) e programa (KNOWN_PROGRAMS)
// pra cada fonte/companhia que o bot busca.
const INFO_FONTE: Record<string, { companhia: string; programa: string; unit: string }> = {
  tap: { companhia: "TAP Air Portugal", programa: "TAP Miles & Go", unit: "milhas" },
  aa: { companhia: "American Airlines", programa: "American Airlines AAdvantage", unit: "milhas" },
  SMILES: { companhia: "GOL", programa: "Smiles", unit: "milhas" },
  IB: { companhia: "Iberia", programa: "Iberia Club", unit: "Avios" },
  BA: { companhia: "British Airways", programa: "British Airways Executive Club", unit: "Avios" },
  AF: { companhia: "Air France", programa: "Air France-KLM Flying Blue", unit: "milhas" },
  KLM: { companhia: "KLM", programa: "Air France-KLM Flying Blue", unit: "milhas" },
  CX: { companhia: "Cathay Pacific", programa: "Cathay Asia Miles", unit: "milhas" },
  EY: { companhia: "Etihad Airways", programa: "Etihad Guest", unit: "milhas" },
  QF: { companhia: "Qantas", programa: "Qantas Frequent Flyer", unit: "pontos" },
  B6: { companhia: "Outra", programa: "JetBlue TrueBlue", unit: "pontos" },
  VIR: { companhia: "Outra", programa: "Virgin Atlantic Flying Club", unit: "pontos" },
};

export type PedidoAlerta = {
  fonte: string; // "tap" | "aa" | código SeatSpy ("IB", "BA", ...)
  origem: string; // IATA
  destino: string; // IATA
  classe: string; // "Econômica" | "Premium Economy" | "Executiva"
  menorK: number | null; // menor valor visto (em K), vira o "miles" do programa
  maiorK: number | null; // maior valor — vira "milesMax" quando difere do menor
  textoIda: string; // "Mmm YYYY: DD, DD" (formato que o portal já parseia)
  textoVolta: string;
};

export type AlertaGerado = {
  imagens: string[]; // caminhos públicos (/alertas/...)
  legenda: string;
  // Alerta complementar de combinações ida+volta — só existe quando as datas
  // das duas direções se cruzam (ver RenderAlerta.jsx no portal).
  imagemCombo?: string;
  legendaCombo?: string;
};

function montarRota(pedido: PedidoAlerta) {
  const info = INFO_FONTE[pedido.fonte] ?? { companhia: "Outra", programa: pedido.fonte, unit: "milhas" };
  const miles = pedido.menorK != null ? String(Math.round(pedido.menorK * 1000)) : "";
  const maior = pedido.maiorK != null ? Math.round(pedido.maiorK * 1000) : null;
  const milesMax = maior != null && String(maior) !== miles ? String(maior) : "";

  return {
    origemSigla: pedido.origem.toUpperCase(),
    destinoSigla: pedido.destino.toUpperCase(),
    companhia: info.companhia,
    classe: pedido.classe,
    programas: [{ name: info.programa, miles, milesMax, unit: info.unit, taxas: "" }],
    datasIdaText: pedido.textoIda || "",
    datasVoltaText: pedido.textoVolta || "",
  };
}

function slug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function gerarAlerta(
  pedido: PedidoAlerta,
  opts: { baseUrl: string; authUser?: string; authPass?: string },
): Promise<AlertaGerado> {
  if (!fs.existsSync(path.join(DIR_PORTAL_DIST, "index.html"))) {
    throw new Error(
      "Build do portal de alertas não encontrado. Rode `npm run build` em projetos/vcc-alertas-portal primeiro.",
    );
  }
  fs.mkdirSync(DIR_ALERTAS, { recursive: true });

  const rota = montarRota(pedido);
  const url = `${opts.baseUrl}/portal/?render#dados=${encodeURIComponent(JSON.stringify(rota))}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      // Mesma qualidade do export manual do portal (html2canvas com scale 2).
      deviceScaleFactor: 2,
      viewport: { width: 1200, height: 900 },
      ...(opts.authUser && opts.authPass
        ? { httpCredentials: { username: opts.authUser, password: opts.authPass } }
        : {}),
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const primeiroCard = page.locator("#render-card-0");
    const erroRender = page.locator("[data-render-erro]");
    await primeiroCard.or(erroRender).first().waitFor({ timeout: 30000 });
    if (await erroRender.count()) {
      throw new Error("A página de render do portal rejeitou os dados do alerta.");
    }
    await page.evaluate(() => document.fonts?.ready);

    const totalCards = await page.locator('[id^="render-card-"]').count();

    // Mesmo padrão de nome do download manual do portal (ver App.jsx):
    // "alerta-GRU-MIA.png", com sufixo -1/-2 quando o alerta divide em dois
    // cards. Cada geração vai numa subpasta com timestamp pra alertas da
    // mesma rota (ex.: Executiva e Econômica) não sobrescreverem um ao outro
    // — o nome baixado continua sendo só o do arquivo.
    const agora = new Date();
    const pasta =
      `${agora.getFullYear()}${String(agora.getMonth() + 1).padStart(2, "0")}${String(agora.getDate()).padStart(2, "0")}` +
      `-${String(agora.getHours()).padStart(2, "0")}${String(agora.getMinutes()).padStart(2, "0")}${String(agora.getSeconds()).padStart(2, "0")}` +
      `-${slug(pedido.classe)}`;
    fs.mkdirSync(path.join(DIR_ALERTAS, pasta), { recursive: true });

    const imagens: string[] = [];
    for (let i = 0; i < totalCards; i++) {
      const cardEl = page.locator(`#render-card-${i}`);
      const nome = `alerta-${pedido.origem}-${pedido.destino}${totalCards > 1 ? `-${i + 1}` : ""}.png`;
      await cardEl.screenshot({ path: path.join(DIR_ALERTAS, pasta, nome) });
      imagens.push(`/alertas/${pasta}/${nome}`);
    }

    const legenda = (await page.locator("#render-legenda").textContent()) ?? "";

    const alerta: AlertaGerado = { imagens, legenda };

    const cardCombo = page.locator("#render-combo");
    if (await cardCombo.count()) {
      const nomeCombo = `alerta-${pedido.origem}-${pedido.destino}-combos.png`;
      await cardCombo.screenshot({ path: path.join(DIR_ALERTAS, pasta, nomeCombo) });
      alerta.imagemCombo = `/alertas/${pasta}/${nomeCombo}`;
      alerta.legendaCombo = (await page.locator("#render-legenda-combo").textContent()) ?? "";
    }

    return alerta;
  } finally {
    await browser.close();
  }
}
