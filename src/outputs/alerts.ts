import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ALERTS_DIR, PORTAL_DIST_DIR } from "../core/paths.ts";

// Bridge to the alert generator (projetos/vcc-alertas-portal): turns a search
// result into an alert ready to forward to the group, the V2 card image(s) plus
// the WhatsApp caption, exactly as the portal makes them by hand.
//
// The portal build is served by this server under /portal, and its public
// ?render page (RenderAlerta.jsx) draws the card from the route serialized in
// the URL hash, with no Supabase and no login. A headless Chromium opens that
// page, screenshots the card(s) and reads the caption. The PNGs land in the
// alerts folder, served under /alerts.

// How the portal names the airline (AIRLINES) and program (KNOWN_PROGRAMS) for
// each source or airline the bot searches.
const SOURCE_INFO: Record<string, { airline: string; program: string; unit: string }> = {
  tap: { airline: "TAP Air Portugal", program: "TAP Miles & Go", unit: "milhas" },
  aa: { airline: "American Airlines", program: "American Airlines AAdvantage", unit: "milhas" },
  SMILES: { airline: "GOL", program: "Smiles", unit: "milhas" },
  LATAM: { airline: "LATAM", program: "LATAM Pass", unit: "pontos" },
  IB: { airline: "Iberia", program: "Iberia Club", unit: "Avios" },
  BA: { airline: "British Airways", program: "British Airways Executive Club", unit: "Avios" },
  AF: { airline: "Air France", program: "Air France-KLM Flying Blue", unit: "milhas" },
  KLM: { airline: "KLM", program: "Air France-KLM Flying Blue", unit: "milhas" },
  CX: { airline: "Cathay Pacific", program: "Cathay Asia Miles", unit: "milhas" },
  EY: { airline: "Etihad Airways", program: "Etihad Guest", unit: "milhas" },
  QF: { airline: "Qantas", program: "Qantas Frequent Flyer", unit: "pontos" },
  B6: { airline: "Outra", program: "JetBlue TrueBlue", unit: "pontos" },
  VIR: { airline: "Outra", program: "Virgin Atlantic Flying Club", unit: "pontos" },
};

export type AlertRequest = {
  source: string; // "tap" | "aa" | a SeatSpy code ("IB", "BA", ...)
  origin: string; // IATA
  destination: string; // IATA
  cabinClass: string; // "Econômica" | "Premium Economy" | "Executiva"
  minK: number | null; // lowest value seen, in K; becomes the program's "miles"
  maxK: number | null; // highest value; becomes "milesMax" when it differs
  outboundText: string; // "Mmm YYYY: DD, DD", the format the portal parses
  returnText: string;
};

export type GeneratedAlert = {
  images: string[]; // public paths (/alerts/...)
  caption: string;
  // Extra alert of outbound+return combinations; only exists when the dates of
  // both directions cross (see RenderAlerta.jsx in the portal).
  comboImage?: string;
  comboCaption?: string;
  // Only when the alert has return dates. The error says why it could not be
  // built, so a missing return caption never looks like a one-way alert.
  returnCaption?: string;
  returnCaptionError?: string;
};

// The portal writes only the outbound caption. The return one is the same text
// with the route line mirrored, keeping the portal's rule that the bold closes
// before the last flag (some WhatsApp clients ignore "*" right after an emoji).
const ROUTE_LINE = /^✈️ \*(.+) \(([A-Z]{3})\) (\S+) - (.+) \(([A-Z]{3})\)\* (\S+)$/u;

export function mirrorCaption(caption: string): string {
  const [first = "", ...rest] = caption.split("\n");
  const match = first.match(ROUTE_LINE);
  if (!match) {
    throw new Error(`A legenda do portal mudou de formato e a da volta não pôde ser montada. Primeira linha: "${first}"`);
  }
  const [, originCity, origin, originFlag, destinationCity, destination, destinationFlag] = match;
  return [`✈️ *${destinationCity} (${destination}) ${destinationFlag} - ${originCity} (${origin})* ${originFlag}`, ...rest].join(
    "\n",
  );
}

// The portal's own route shape, read by its ?render page.
function portalRoute(request: AlertRequest) {
  const info = SOURCE_INFO[request.source] ?? { airline: "Outra", program: request.source, unit: "milhas" };
  const miles = request.minK != null ? String(Math.round(request.minK * 1000)) : "";
  const highest = request.maxK != null ? Math.round(request.maxK * 1000) : null;
  const milesMax = highest != null && String(highest) !== miles ? String(highest) : "";

  return {
    origemSigla: request.origin.toUpperCase(),
    destinoSigla: request.destination.toUpperCase(),
    companhia: info.airline,
    classe: request.cabinClass,
    programas: [{ name: info.program, miles, milesMax, unit: info.unit, taxas: "" }],
    datasIdaText: request.outboundText || "",
    datasVoltaText: request.returnText || "",
  };
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function generateAlert(
  request: AlertRequest,
  options: { baseUrl: string; authUser?: string; authPass?: string },
): Promise<GeneratedAlert> {
  if (!fs.existsSync(path.join(PORTAL_DIST_DIR, "index.html"))) {
    throw new Error(
      "Build do portal de alertas não encontrado. Rode `npm run build` em projetos/vcc-alertas-portal primeiro.",
    );
  }
  fs.mkdirSync(ALERTS_DIR, { recursive: true });

  const url = `${options.baseUrl}/portal/?render#dados=${encodeURIComponent(JSON.stringify(portalRoute(request)))}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      // Same quality as the portal's manual export (html2canvas with scale 2).
      deviceScaleFactor: 2,
      viewport: { width: 1200, height: 900 },
      // A fixed header instead of httpCredentials: the browser only sends those
      // after a 401 challenge, and a missing login now redirects to /login.
      // Playwright's `send: "always"` does not cover browser navigation.
      ...(options.authUser && options.authPass
        ? {
            extraHTTPHeaders: {
              authorization: `Basic ${Buffer.from(`${options.authUser}:${options.authPass}`).toString("base64")}`,
            },
          }
        : {}),
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const firstCard = page.locator("#render-card-0");
    const renderError = page.locator("[data-render-erro]");
    await firstCard.or(renderError).first().waitFor({ timeout: 30000 });
    if (await renderError.count()) {
      throw new Error("A página de render do portal rejeitou os dados do alerta.");
    }
    await page.evaluate(() => document.fonts?.ready);

    const cardCount = await page.locator('[id^="render-card-"]').count();

    // Same file name as the portal's manual download ("alerta-GRU-MIA.png", with
    // -1/-2 when the alert splits in two cards). Each generation gets a
    // timestamped folder so alerts for the same route (e.g. Executiva and
    // Econômica) never overwrite each other.
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const folder =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
      `-${slug(request.cabinClass)}`;
    fs.mkdirSync(path.join(ALERTS_DIR, folder), { recursive: true });

    const images: string[] = [];
    for (let i = 0; i < cardCount; i++) {
      const name = `alerta-${request.origin}-${request.destination}${cardCount > 1 ? `-${i + 1}` : ""}.png`;
      await page.locator(`#render-card-${i}`).screenshot({ path: path.join(ALERTS_DIR, folder, name) });
      images.push(`/alerts/${folder}/${name}`);
    }

    const alert: GeneratedAlert = {
      images,
      caption: (await page.locator("#render-legenda").textContent()) ?? "",
    };
    if (request.returnText) {
      try {
        alert.returnCaption = mirrorCaption(alert.caption);
      } catch (err) {
        console.error(err);
        alert.returnCaptionError = (err as Error).message;
      }
    }

    const comboCard = page.locator("#render-combo");
    if (await comboCard.count()) {
      const comboName = `alerta-${request.origin}-${request.destination}-combos.png`;
      await comboCard.screenshot({ path: path.join(ALERTS_DIR, folder, comboName) });
      alert.comboImage = `/alerts/${folder}/${comboName}`;
      alert.comboCaption = (await page.locator("#render-legenda-combo").textContent()) ?? "";
    }

    return alert;
  } finally {
    await browser.close();
  }
}
