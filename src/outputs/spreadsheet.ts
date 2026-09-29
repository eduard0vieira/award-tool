import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, SPREADSHEETS_DIR } from "../core/paths.ts";

// The search log is the memory the bot does not have: jobs live in memory and
// history in the browser's localStorage. Every finished search becomes rows
// here, one per date found, so "is this route cheaper than last month?" has an
// answer. Unlike the old project (cheap-flights/sheets.py), which created a NEW
// public spreadsheet per run, this is ONE sheet, append only: the accumulation
// is the value.
//
// Two independent destinations: a local CSV (always, no setup) and Google
// Sheets (when configured). Sheets is plain REST, with the service account JWT
// signed by `node:crypto`, so no new dependency.

// Kept as "buscas.csv": renaming would split the accumulated history in two files.
const SEARCHES_CSV = path.join(SPREADSHEETS_DIR, "buscas.csv");

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SEARCHES_TAB = process.env.SPREADSHEET_TAB || "buscas";
// The accumulated tab is optional and OFF: the request was one new tab per
// search. History is not lost, the local CSV always accumulates.
const ACCUMULATE_IN_SHEETS = process.env.SPREADSHEET_ACCUMULATE === "true";

// Header names of an existing, appended-to sheet: changing them breaks it.
export const SEARCH_COLUMNS = [
  "carimbo",
  "fonte",
  "origem",
  "destino",
  "direcao",
  "cabine",
  "data",
  "valor",
  "unidade",
  "assentos",
  "teto",
  "busca",
] as const;

export type SearchRow = {
  carimbo: string; // ISO time of the search
  fonte: string; // "SMILES", "AA", "tap", "LATAM", a SeatSpy code...
  origem: string;
  destino: string;
  direcao: "ida" | "volta";
  cabine: string;
  data: string; // flight date, YYYY-MM-DD
  valor: number | null; // in K (miles) or reais, per `unidade`
  unidade: "K" | "BRL";
  assentos: number | null;
  teto: number | null; // the ceiling applied, to explain why a day did not show up
  busca: string; // job id, grouping the rows of one search
};

// The smallest shape every source fits: SeatSpy and Smiles have priceless days
// and seats, LATAM works in reais, TAP and AA have neither.
export type SheetSection = {
  label: string;
  unit?: "K" | "BRL";
  days: { date: string; valueK: number | null; seats?: number }[];
};

export type SheetLeg = {
  label: string; // only used to tell the direction
  sections: SheetSection[];
};

export type SearchToSave = {
  source: string;
  origin: string;
  destination: string;
  legs: SheetLeg[];
  ceilings?: Record<string, number | null | undefined>;
  searchId: string;
};

// "Volta: MIA → GRU" is the return; without that label it is the outbound.
function directionOf(label: string): "ida" | "volta" {
  return /^volta/i.test(label.trim()) ? "volta" : "ida";
}

export function buildSearchRows(search: SearchToSave): SearchRow[] {
  const stamp = new Date().toISOString();
  const rows: SearchRow[] = [];

  for (const leg of search.legs) {
    const direction = directionOf(leg.label);
    for (const section of leg.sections) {
      const ceiling = search.ceilings?.[section.label] ?? null;
      for (const day of section.days) {
        rows.push({
          carimbo: stamp,
          fonte: search.source,
          origem: search.origin,
          destino: search.destination,
          direcao: direction,
          cabine: section.label,
          data: day.date,
          valor: day.valueK ?? null,
          unidade: section.unit ?? "K",
          // Only some sources report seats: null means "not reported", not "zero seats".
          assentos: day.seats ?? null,
          teto: ceiling ?? null,
          busca: search.searchId,
        });
      }
    }
  }

  return rows;
}

function toCells(row: SearchRow): (string | number)[] {
  return SEARCH_COLUMNS.map((column) => row[column] ?? "");
}

function escapeCsv(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendSearchCsv(rows: SearchRow[]) {
  fs.mkdirSync(SPREADSHEETS_DIR, { recursive: true });
  const isNew = !fs.existsSync(SEARCHES_CSV);
  const content =
    (isNew ? `${SEARCH_COLUMNS.join(",")}\n` : "") +
    rows.map((row) => toCells(row).map(escapeCsv).join(",")).join("\n") +
    "\n";
  fs.appendFileSync(SEARCHES_CSV, content, "utf8");
}

// A per-search sheet as a local file, for when Google is not configured (or to
// have the data on disk anyway).
export function writeFlightsCsv(rows: FlightRow[], filePath: string): void {
  const content =
    `${FLIGHT_COLUMNS.join(",")}\n` +
    rows.map((row) => FLIGHT_COLUMNS.map((column) => escapeCsv(row[column] ?? "")).join(",")).join("\n") +
    "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// Same columns, in the same order, as the old bot's FlightAvailability
// (cheap-flights): the format the team already knows how to filter. One row per FLIGHT.
export const FLIGHT_COLUMNS = [
  "departure_date",
  "arrival_date",
  "departure_station",
  "departure_time",
  "arrival_station",
  "connections",
  "connecting_airports",
  "points",
  "duration",
  "cabin_category",
  "operation_carriers",
  "program",
  "source_fare",
  "available_seats",
  "aircraft",
  "tax",
  "class_of_service",
  "url",
  // Appended last so older columns keep their position and old filters still
  // work. Iberia prices per DAY, not per flight: putting that number in `points`
  // would claim a given itinerary costs it, including the 29h one via Casablanca
  // that is almost surely not the day's cheapest.
  "day_avios",
] as const;

// Optional so sources that price per flight need not fill a column that is not theirs.
export type FlightRow = Record<Exclude<(typeof FLIGHT_COLUMNS)[number], "day_avios">, string | number> & {
  day_avios?: string | number;
};

// Each search gets a new TAB in the user's spreadsheet. Not a new spreadsheet:
// a service account has ZERO Drive quota (`storageQuota.limit: "0"`), so it
// cannot own files and creating one returns 403 "storage quota has been
// exceeded". A tab gives the same isolation and a direct link.

// Tab names reject : \ / ? * [ ] and are capped at 100 characters.
function validTabName(title: string): string {
  return title.replace(/[:\\/?*\[\]]/g, "-").slice(0, 95);
}

async function createTab(token: string, title: string): Promise<{ gid: number; name: string }> {
  const name = validTabName(title);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: name } } }] }),
  });
  if (!response.ok) {
    throw new Error(`Falha ao criar a aba da busca (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { replies?: { addSheet?: { properties?: { sheetId?: number } } }[] };
  const gid = body.replies?.[0]?.addSheet?.properties?.sheetId;
  if (typeof gid !== "number") throw new Error("O Google criou a aba mas não devolveu o id dela.");
  return { gid, name };
}

// Returns the tab's link, or null when Sheets is off or failed. Never throws:
// the search result is worth more than the record.
export async function createSearchSheet(
  params: { title: string; rows: FlightRow[] },
  onLog: (message: string) => void = () => {},
): Promise<string | null> {
  if (params.rows.length === 0) return null;

  let account: ServiceAccount | null = null;
  try {
    account = readServiceAccount();
  } catch (err) {
    onLog(`Planilha desligada: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!account) return null;

  try {
    const token = await getAccessToken(account);
    const { gid, name } = await createTab(token, params.title);

    const values = [[...FLIGHT_COLUMNS], ...params.rows.map((row) => FLIGHT_COLUMNS.map((column) => row[column] ?? ""))];
    const range = encodeURIComponent(`${name}!A1`);
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append` +
        "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
    if (!response.ok) {
      throw new Error(`Falha ao escrever na aba da busca (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }

    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=${gid}`;
    onLog(`Aba "${name}" criada com ${params.rows.length} voo(s): ${url}`);
    return url;
  } catch (err) {
    onLog(`Falha ao criar a aba da busca: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

type ServiceAccount = { client_email: string; private_key: string };

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = base64url(crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!response.ok) {
    // Never echo the key; only what Google answered.
    throw new Error(
      `Google recusou a autenticação da conta de serviço (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google não devolveu access_token para a conta de serviço.");

  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

function readServiceAccount(): ServiceAccount | null {
  if (!CREDENTIALS_PATH || !SPREADSHEET_ID) return null;
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`GOOGLE_CREDENTIALS aponta para um arquivo que não existe: ${CREDENTIALS_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")) as Partial<ServiceAccount>;
  if (!raw.client_email || !raw.private_key) {
    throw new Error("O arquivo de credenciais não tem client_email/private_key. Não é uma conta de serviço.");
  }
  return { client_email: raw.client_email, private_key: raw.private_key };
}

// An empty tab must get the header with its first append, or it ends up with
// data nobody can read. Costs one read, only the first time.
async function isTabEmpty(token: string): Promise<boolean> {
  const range = encodeURIComponent(`${SEARCHES_TAB}!A1:A1`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(
        `A planilha não tem uma aba chamada "${SEARCHES_TAB}". Renomeie a aba ou ajuste SPREADSHEET_TAB no .env.`,
      );
    }
    return false; // a failed read does not block the write; the append reports its own failure
  }
  const body = (await response.json()) as { values?: unknown[][] };
  return !body.values || body.values.length === 0;
}

async function appendToSheet(account: ServiceAccount, rows: SearchRow[]) {
  const token = await getAccessToken(account);
  const values = rows.map(toCells);
  if (await isTabEmpty(token)) values.unshift([...SEARCH_COLUMNS]);
  const range = encodeURIComponent(`${SEARCHES_TAB}!A1`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append` +
    "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });

  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    if (response.status === 403) {
      throw new Error(
        `O Sheets recusou a escrita (403). Compartilhe a planilha com ${account.client_email} como Editor. Resposta: ${text}`,
      );
    }
    throw new Error(`O Sheets recusou a escrita (${response.status}): ${text}`);
  }
}

let warnedWithoutSheets = false;

// Never fails the search: a failure here becomes a log line, because the search
// result is already there and is worth more than the record.
export async function saveSearch(search: SearchToSave, onLog: (message: string) => void = () => {}): Promise<void> {
  const rows = buildSearchRows(search);
  if (rows.length === 0) return;

  try {
    appendSearchCsv(rows);
  } catch (err) {
    onLog(`Falha ao gravar o CSV de buscas: ${err instanceof Error ? err.message : String(err)}`);
  }

  let account: ServiceAccount | null = null;
  try {
    account = readServiceAccount();
  } catch (err) {
    onLog(`Planilha do Google desligada: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!ACCUMULATE_IN_SHEETS) return;

  if (!account) {
    if (!warnedWithoutSheets) {
      warnedWithoutSheets = true;
      onLog(
        "Planilha do Google não configurada (GOOGLE_CREDENTIALS + SPREADSHEET_ID no .env). " +
          `as buscas estão sendo gravadas só em ${path.relative(ROOT_DIR, SEARCHES_CSV)}.`,
      );
    }
    return;
  }

  try {
    await appendToSheet(account, rows);
    onLog(`${rows.length} linha(s) enviadas para a planilha.`);
  } catch (err) {
    onLog(`Falha ao enviar para a planilha: ${err instanceof Error ? err.message : String(err)}`);
  }
}
