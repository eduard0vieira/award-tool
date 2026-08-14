import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Registro das buscas em planilha — a memória que o bot não tem.
//
// Hoje job vive em memória e histórico vive no localStorage do navegador, então
// não dá pra responder "esse trecho está mais barato que no mês passado?".
// Cada busca concluída vira linhas aqui, uma por data encontrada.
//
// Diferença proposital em relação ao projeto antigo (cheap-flights/sheets.py):
// lá cada rodada criava uma planilha NOVA (e a deixava pública pra escrita), o
// que serve pra exportar relatório mas não pra comparar no tempo. Aqui é UMA
// planilha, UMA aba, só append — é o acúmulo que dá valor.
//
// Dois destinos, independentes:
// - CSV local (sempre, sem configuração nenhuma): planilhas/buscas.csv
// - Google Sheets (quando configurado): ver GOOGLE_CREDENCIAIS/PLANILHA_ID
//
// Sem dependência nova: o acesso ao Sheets é REST puro, com o JWT da conta de
// serviço assinado pelo `node:crypto`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_PLANILHAS = path.join(__dirname, "planilhas");
const ARQUIVO_CSV = path.join(DIR_PLANILHAS, "buscas.csv");

const CAMINHO_CREDENCIAIS = process.env.GOOGLE_CREDENCIAIS;
const PLANILHA_ID = process.env.PLANILHA_ID;
const PLANILHA_ABA = process.env.PLANILHA_ABA || "buscas";

export const COLUNAS = [
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

export type LinhaPlanilha = {
  carimbo: string; // ISO do momento da busca
  fonte: string; // "SMILES", "AA", "tap", "LATAM", código do SeatSpy...
  origem: string;
  destino: string;
  direcao: "ida" | "volta";
  cabine: string;
  data: string; // YYYY-MM-DD do voo
  valor: number | null; // em K (milhas) ou em reais, conforme `unidade`
  unidade: "K" | "BRL";
  assentos: number | null;
  teto: number | null; // teto aplicado na busca, pra saber por que um dia não apareceu
  busca: string; // id do job, pra agrupar as linhas de uma mesma busca
};

// Forma mínima que serve pras cinco fontes: o SeatSpy e o Smiles têm dias sem
// preço (valorK null) e vagas, a LATAM tem unidade em reais, a TAP e a AA não
// têm nem um nem outro.
export type SecaoParaPlanilha = {
  rotulo: string;
  unidade?: "K" | "BRL";
  dias: { data: string; valorK: number | null; assentos?: number }[];
};

export type PernaParaPlanilha = {
  rotulo: string; // usado só pra deduzir a direção
  secoes: SecaoParaPlanilha[];
};

// "Volta: MIA → GRU" → volta. Sem rótulo de volta, é ida.
function direcaoDe(rotulo: string): "ida" | "volta" {
  return /^volta/i.test(rotulo.trim()) ? "volta" : "ida";
}

export function montarLinhas(params: {
  fonte: string;
  origem: string;
  destino: string;
  pernas: PernaParaPlanilha[];
  tetos?: Record<string, number | null | undefined>;
  busca: string;
}): LinhaPlanilha[] {
  const carimbo = new Date().toISOString();
  const linhas: LinhaPlanilha[] = [];

  for (const perna of params.pernas) {
    const direcao = direcaoDe(perna.rotulo);
    for (const secao of perna.secoes) {
      const teto = params.tetos?.[secao.rotulo] ?? null;
      for (const dia of secao.dias) {
        linhas.push({
          carimbo,
          fonte: params.fonte,
          origem: params.origem,
          destino: params.destino,
          direcao,
          cabine: secao.rotulo,
          data: dia.data,
          valor: dia.valorK ?? null,
          unidade: secao.unidade ?? "K",
          // `assentos` só existe em algumas fontes (SeatSpy, Smiles) — null aqui
          // é "esta fonte não informa", não "zero vagas".
          assentos: dia.assentos ?? null,
          teto: teto ?? null,
          busca: params.busca,
        });
      }
    }
  }

  return linhas;
}

function paraCelulas(linha: LinhaPlanilha): (string | number)[] {
  return COLUNAS.map((coluna) => {
    const valor = linha[coluna];
    return valor === null || valor === undefined ? "" : valor;
  });
}

function escaparCsv(valor: string | number): string {
  const texto = String(valor);
  return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function gravarCsv(linhas: LinhaPlanilha[]) {
  fs.mkdirSync(DIR_PLANILHAS, { recursive: true });
  const novo = !fs.existsSync(ARQUIVO_CSV);
  const conteudo =
    (novo ? `${COLUNAS.join(",")}\n` : "") +
    linhas.map((l) => paraCelulas(l).map(escaparCsv).join(",")).join("\n") +
    "\n";
  fs.appendFileSync(ARQUIVO_CSV, conteudo, "utf8");
}

// ── Google Sheets (REST puro, sem dependência nova) ───────────────────────

type Credenciais = { client_email: string; private_key: string };

let tokenEmCache: { valor: string; expiraEm: number } | null = null;

function base64url(entrada: Buffer | string): string {
  return Buffer.from(entrada).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function obterToken(cred: Credenciais): Promise<string> {
  if (tokenEmCache && tokenEmCache.expiraEm > Date.now() + 60_000) return tokenEmCache.valor;

  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = base64url(
    JSON.stringify({
      iss: cred.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: agora,
      exp: agora + 3600,
    }),
  );
  const assinatura = base64url(
    crypto.createSign("RSA-SHA256").update(`${cabecalho}.${corpo}`).sign(cred.private_key),
  );

  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${cabecalho}.${corpo}.${assinatura}`,
    }),
  });

  if (!resposta.ok) {
    // Nunca ecoa a chave; só o que o Google respondeu.
    throw new Error(`Google recusou a autenticação da conta de serviço (${resposta.status}): ${(await resposta.text()).slice(0, 200)}`);
  }

  const dados = (await resposta.json()) as { access_token?: string; expires_in?: number };
  if (!dados.access_token) throw new Error("Google não devolveu access_token para a conta de serviço.");

  tokenEmCache = { valor: dados.access_token, expiraEm: Date.now() + (dados.expires_in ?? 3600) * 1000 };
  return dados.access_token;
}

function lerCredenciais(): Credenciais | null {
  if (!CAMINHO_CREDENCIAIS || !PLANILHA_ID) return null;
  if (!fs.existsSync(CAMINHO_CREDENCIAIS)) {
    throw new Error(`GOOGLE_CREDENCIAIS aponta para um arquivo que não existe: ${CAMINHO_CREDENCIAIS}`);
  }
  const cru = JSON.parse(fs.readFileSync(CAMINHO_CREDENCIAIS, "utf8")) as Partial<Credenciais>;
  if (!cru.client_email || !cru.private_key) {
    throw new Error("O arquivo de credenciais não tem client_email/private_key — não é uma conta de serviço.");
  }
  return { client_email: cru.client_email, private_key: cru.private_key };
}

// A aba vazia precisa ganhar o cabeçalho junto do primeiro append — senão
// fica uma planilha com dados e sem nome de coluna, que ninguém sabe ler
// depois. Só custa uma leitura, e só na primeira vez.
async function abaVazia(token: string): Promise<boolean> {
  const alcance = encodeURIComponent(`${PLANILHA_ABA}!A1:A1`);
  const resposta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA_ID}/values/${alcance}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!resposta.ok) {
    if (resposta.status === 400) {
      throw new Error(
        `A planilha não tem uma aba chamada "${PLANILHA_ABA}". Renomeie a aba ou ajuste PLANILHA_ABA no .env.`,
      );
    }
    return false; // erro de leitura não impede a escrita; o append reporta se falhar
  }
  const dados = (await resposta.json()) as { values?: unknown[][] };
  return !dados.values || dados.values.length === 0;
}

async function enviarAoSheets(cred: Credenciais, linhas: LinhaPlanilha[]) {
  const token = await obterToken(cred);
  const valores = linhas.map(paraCelulas);
  if (await abaVazia(token)) valores.unshift([...COLUNAS]);
  const alcance = encodeURIComponent(`${PLANILHA_ABA}!A1`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA_ID}/values/${alcance}:append` +
    "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";

  const resposta = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: valores }),
  });

  if (!resposta.ok) {
    const texto = (await resposta.text()).slice(0, 300);
    if (resposta.status === 403) {
      throw new Error(
        `O Sheets recusou a escrita (403). Compartilhe a planilha com ${cred.client_email} como Editor. Resposta: ${texto}`,
      );
    }
    throw new Error(`O Sheets recusou a escrita (${resposta.status}): ${texto}`);
  }
}

let jaAvisouSemSheets = false;

// Registra as linhas nos destinos disponíveis. NUNCA derruba a busca: uma
// falha aqui vira aviso, porque o resultado da busca já está pronto e vale
// mais que o registro.
export async function registrarBusca(
  params: Parameters<typeof montarLinhas>[0],
  onLog: (mensagem: string) => void = () => {},
): Promise<void> {
  const linhas = montarLinhas(params);
  if (linhas.length === 0) return;

  try {
    gravarCsv(linhas);
  } catch (err) {
    onLog(`Não consegui gravar o CSV de buscas: ${err instanceof Error ? err.message : String(err)}`);
  }

  let cred: Credenciais | null = null;
  try {
    cred = lerCredenciais();
  } catch (err) {
    onLog(`Planilha do Google desligada: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!cred) {
    if (!jaAvisouSemSheets) {
      jaAvisouSemSheets = true;
      onLog(
        "Planilha do Google não configurada (GOOGLE_CREDENCIAIS + PLANILHA_ID no .env) — " +
          `as buscas estão sendo gravadas só em ${path.relative(__dirname, ARQUIVO_CSV)}.`,
      );
    }
    return;
  }

  try {
    await enviarAoSheets(cred, linhas);
    onLog(`${linhas.length} linha(s) enviadas para a planilha.`);
  } catch (err) {
    onLog(`Falha ao enviar para a planilha: ${err instanceof Error ? err.message : String(err)}`);
  }
}
