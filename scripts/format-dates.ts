import { execFileSync } from "node:child_process";
import { formatDatesByMonth } from "../src/core/common.ts";

// Formats a block pasted from a spreadsheet (Smiles or any other) into the date
// text the group receives. Copy the block and run:
//
//   npm run -s format-dates
//
// Without a pipe it reads the clipboard and writes the result back to it. With
// a pipe it uses stdin/stdout and leaves the clipboard alone:
//
//   pbpaste | npm run -s format-dates
//
// The block goes to stdout; missing-column, unreadable-date and applied-rule
// notices go to stderr so they never end up in the ctrl+V.
//
// The per-month text comes from the core's `formatDatesByMonth`: the same
// contract the sources emit and vcc-alertas-portal's `parseDates` reads.

type Role = "date" | "seats" | "value" | "direction" | "unit" | "origin" | "destination" | "cabin" | "source";

// Matched against the pasted header, so they include the Portuguese column names in use.
const HEADER_PATTERNS: [Role, string[]][] = [
  ["date", ["data", "date", "partida", "embarque", "dia"]],
  ["seats", ["assento", "seat", "vaga"]],
  ["value", ["valor", "milhas", "miles", "preco", "price", "tarifa", "pontos", "points", "custo"]],
  ["direction", ["direcao", "direction", "sentido", "perna", "leg"]],
  ["unit", ["unidade", "unit", "moeda", "currency"]],
  ["origin", ["origem", "origin", "from"]],
  ["destination", ["destino", "destination"]],
  ["cabin", ["cabine", "cabin", "classe", "class"]],
  ["source", ["fonte", "source", "programa", "program", "companhia", "airline"]],
];

const NO_DIRECTION = "SEM DIREÇÃO";

const notices: string[] = [];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function classify(columnName: string): Role | null {
  const normalized = normalize(columnName);
  if (!normalized) return null;
  for (const [role, terms] of HEADER_PATTERNS) {
    if (terms.some((term) => normalized.includes(term))) return role;
  }
  return null;
}

function detectDelimiter(line: string): string {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  if (line.includes(",")) return ",";
  return "\t";
}

function parseDate(raw: string, lineNumber: number): string {
  const value = raw.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]!.padStart(2, "0")}-${br[1]!.padStart(2, "0")}`;
  throw new Error(`linha ${lineNumber}: não consegui ler "${value}" como data. Aceito YYYY-MM-DD e DD/MM/AAAA.`);
}

// An empty number is declared absence (null); an unreadable one is an error,
// never zero, which would reach the alert as "a day without seats".
function parseNumber(raw: string, column: string, lineNumber: number): number | null {
  let value = raw.trim();
  if (!value || value === "-" || value === "—") return null;
  value = value.replace(/\s/g, "").replace(/^R\$/i, "").replace(/[kK]$/, "");
  const hasDot = value.includes(".");
  const hasComma = value.includes(",");
  if (hasDot && hasComma) {
    value =
      value.lastIndexOf(",") > value.lastIndexOf(".") ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (hasComma) {
    value = /,\d{1,2}$/.test(value) ? value.replace(",", ".") : value.replace(/,/g, "");
  } else if (hasDot && /\.\d{3}$/.test(value)) {
    value = value.replace(/\./g, "");
  }
  const number = Number(value);
  if (Number.isNaN(number)) {
    throw new Error(`linha ${lineNumber}: coluna "${column}" tem "${raw.trim()}", que não é número.`);
  }
  return number;
}

function normalizeDirection(raw: string): "outbound" | "return" | null {
  const normalized = normalize(raw);
  if (!normalized) return null;
  if (["ida", "outbound", "departure", "partida", "out", "going"].some((term) => normalized.includes(term))) return "outbound";
  if (["volta", "return", "inbound", "retorno", "back"].some((term) => normalized.includes(term))) return "return";
  notices.push(`direção "${raw.trim()}" não é ida nem volta; essas linhas ficaram num bloco separado.`);
  return null;
}

type PastedRow = {
  date: string;
  seats: number | null;
  value: number | null;
  direction: string;
  labels: Partial<Record<Role, string>>;
};

type Day = { date: string; seats: number | null; value: number | null };

function readPaste(text: string) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("não veio nada na entrada. Copie o bloco da planilha e rode de novo.");

  const delimiter = detectDelimiter(lines[0]!);
  const cells = lines.map((line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, "")));

  const header = cells[0]!;
  const roles = new Map<Role, number>();
  header.forEach((name, i) => {
    const role = classify(name);
    if (!role) return;
    if (roles.has(role)) {
      notices.push(`duas colunas têm o mesmo papel ("${header[roles.get(role)!]}" e "${name}"); usei a primeira.`);
      return;
    }
    roles.set(role, i);
  });

  const dateColumn = roles.get("date");
  if (dateColumn === undefined) {
    throw new Error(
      `não achei coluna de data no cabeçalho (${header.join(" | ")}). Copie da planilha incluindo a linha de títulos.`,
    );
  }

  const seatsColumn = roles.get("seats");
  const valueColumn = roles.get("value");
  const directionColumn = roles.get("direction");

  const rows: PastedRow[] = [];
  for (let i = 1; i < cells.length; i++) {
    const line = cells[i]!;
    const lineNumber = i + 1;
    const direction =
      directionColumn !== undefined ? (normalizeDirection(line[directionColumn] ?? "") ?? "other") : "all";
    const labels: Partial<Record<Role, string>> = {};
    for (const role of ["origin", "destination", "cabin", "source", "unit"] as const) {
      const column = roles.get(role);
      if (column !== undefined && line[column]) labels[role] = line[column]!;
    }
    rows.push({
      date: parseDate(line[dateColumn] ?? "", lineNumber),
      seats: seatsColumn !== undefined ? parseNumber(line[seatsColumn] ?? "", header[seatsColumn]!, lineNumber) : null,
      value: valueColumn !== undefined ? parseNumber(line[valueColumn] ?? "", header[valueColumn]!, lineNumber) : null,
      direction,
      labels,
    });
  }

  return {
    rows,
    hasValue: valueColumn !== undefined,
    hasSeats: seatsColumn !== undefined,
    hasDirection: directionColumn !== undefined,
    valueColumnName: valueColumn !== undefined ? header[valueColumn]! : null,
    columnName: (role: Role) => {
      const column = roles.get(role);
      return column === undefined ? role : header[column]!;
    },
  };
}

type Paste = ReturnType<typeof readPaste>;

// Dedupe: each date keeps the ROW with the most seats and duplicates drop; a tie
// goes to the cheapest. Price and seats always come from the SAME row:
// announcing one flight's price with another's seats would be a lie (the reason
// for the opposite rule in `buildSmilesReport`, which keeps the cheapest flight).
function pickRow(rows: PastedRow[]): PastedRow {
  return rows.reduce((best, current) => {
    const currentSeats = current.seats ?? -1;
    const bestSeats = best.seats ?? -1;
    if (currentSeats !== bestSeats) return currentSeats > bestSeats ? current : best;
    if (current.value != null && best.value != null) return current.value < best.value ? current : best;
    return best.value != null ? best : current;
  });
}

function groupByDay(rows: PastedRow[]): Day[] {
  const byDate = new Map<string, PastedRow[]>();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date)!.push(row);
  }
  let cheaperDropped = 0;
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dateRows]) => {
      const chosen = pickRow(dateRows);
      const values = dateRows.map((row) => row.value).filter((value): value is number => value != null);
      if (chosen.value != null && values.length > 0 && Math.min(...values) < chosen.value) cheaperDropped++;
      return { date, seats: chosen.seats, value: chosen.value };
    });
  if (cheaperDropped > 0) {
    notices.push(
      `${cheaperDropped} dia(s) tinham voo MAIS BARATO com menos vagas; ` +
        `ficou a linha de mais vagas, como pedido — o menor valor do bloco é o dessas linhas.`,
    );
  }
  return days;
}

function ptNumber(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

// A block header only states what ALL its rows agree on. The cheapest GRU→MCO
// value next to dates of another route (or cabin) is the kind of wrong alert
// that costs a client, so on disagreement it warns instead.
function sharedLabel(rows: PastedRow[], role: Role, paste: Paste, title: string): string | null {
  const seen = new Set(rows.map((row) => row.labels[role]).filter((value): value is string => !!value));
  if (seen.size === 1) return [...seen][0]!;
  if (seen.size > 1) {
    notices.push(
      `${title}: a colagem mistura ${seen.size} valores de "${paste.columnName(role)}" (${[...seen].join(", ")}); ` +
        `saiu tudo no mesmo bloco, com um menor/maior só.`,
    );
  }
  return null;
}

function buildBlock(title: string, rows: PastedRow[], days: Day[], paste: Paste): string {
  const lines: string[] = [];
  const flight = {
    origin: sharedLabel(rows, "origin", paste, title),
    destination: sharedLabel(rows, "destination", paste, title),
    cabin: sharedLabel(rows, "cabin", paste, title),
    source: sharedLabel(rows, "source", paste, title),
    unit: sharedLabel(rows, "unit", paste, title),
  };
  const identity = [
    flight.origin && flight.destination ? `${flight.origin} → ${flight.destination}` : null,
    flight.cabin,
    flight.source,
  ]
    .filter(Boolean)
    .join(" · ");

  lines.push(`*${title}*${identity ? ` — ${identity}` : ""}`);

  const seats = days.map((day) => day.seats).filter((value): value is number => value != null);
  const withoutSeats = days.length - seats.length;
  const seatRange = seats.length
    ? seats.length === 1 || Math.min(...seats) === Math.max(...seats)
      ? `${Math.max(...seats)} vaga(s) por dia`
      : `${Math.min(...seats)} a ${Math.max(...seats)} vagas por dia`
    : null;
  lines.push(`💺 ${days.length} data(s)${seatRange ? ` · ${seatRange}` : ""}`);

  const values = days.map((day) => day.value).filter((value): value is number => value != null);
  const unit = flight.unit ? ` ${flight.unit}` : "";
  if (values.length) {
    const lowest = Math.min(...values);
    const highest = Math.max(...values);
    lines.push(
      lowest === highest
        ? `💰 ${ptNumber(lowest)}${unit}`
        : `💰 menor ${ptNumber(lowest)}${unit} · maior ${ptNumber(highest)}${unit}`,
    );
  } else {
    lines.push("⚠️ sem coluna de valor na colagem — preencha o menor/maior antes de enviar");
  }
  if (withoutSeats > 0) lines.push(`⚠️ ${withoutSeats} data(s) vieram sem número de vagas`);
  if (title === NO_DIRECTION) lines.push("⚠️ não reconheci a direção dessas linhas — confira se é ida ou volta");

  const byDate = new Map(days.map((day) => [day.date, day]));
  const text = formatDatesByMonth(
    days.map((day) => day.date),
    (date) => {
      const daySeats = byDate.get(date)!.seats;
      return daySeats != null ? ` (${daySeats})` : "";
    },
  );
  lines.push("");
  lines.push(...text.split("\n").map((line) => `📅 ${line}`));
  return lines.join("\n");
}

const fromClipboard = process.stdin.isTTY === true;
// Without a UTF-8 LANG, pbpaste/pbcopy replace accents and emoji with "?".
const utf8Env = { ...process.env, LANG: "en_US.UTF-8" };

function readInput(): Promise<string> {
  if (fromClipboard) return Promise.resolve(execFileSync("pbpaste", { encoding: "utf8", env: utf8Env }));
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const DIRECTION_ORDER = ["outbound", "return", "other", "all"];
const DIRECTION_TITLE: Record<string, string> = {
  outbound: "IDA",
  return: "VOLTA",
  other: NO_DIRECTION,
  all: "DATAS",
};

async function main() {
  const paste = readPaste(await readInput());

  const byDirection = new Map<string, PastedRow[]>();
  for (const row of paste.rows) {
    if (!byDirection.has(row.direction)) byDirection.set(row.direction, []);
    byDirection.get(row.direction)!.push(row);
  }

  const blocks = [...byDirection.entries()]
    .sort(([a], [b]) => DIRECTION_ORDER.indexOf(a) - DIRECTION_ORDER.indexOf(b))
    .map(([direction, rows]) => buildBlock(DIRECTION_TITLE[direction]!, rows, groupByDay(rows), paste));

  const output = blocks.join("\n\n") + "\n";
  process.stdout.write(output);
  // Only written at the end: if the paste failed, the clipboard still holds the spreadsheet.
  if (fromClipboard) execFileSync("pbcopy", { input: output, env: utf8Env });

  if (!paste.hasDirection) {
    notices.push("sem coluna de direção na colagem: tudo saiu num bloco só. Cole ida e volta separadas, ou traga a coluna.");
  }
  if (!paste.hasSeats) notices.push("sem coluna de assentos: as datas saíram sem o (n) de vagas.");
  notices.push(
    paste.hasValue
      ? `duplicatas: ficou a linha de mais vagas de cada data; valor e vagas vêm dela (coluna "${paste.valueColumnName}").`
      : "duplicatas: ficou a linha de mais vagas de cada data.",
  );
  for (const notice of new Set(notices)) process.stderr.write(`· ${notice}\n`);
  if (fromClipboard) process.stderr.write("✓ texto copiado pro clipboard\n");
}

main().catch((err) => {
  process.stderr.write(`erro: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
