import { execFileSync } from "node:child_process";
import { formatDatesByMonth } from "../src/core/common.ts";

// Formata um bloco colado da planilha (Smiles ou qualquer outra) no texto de
// datas que o grupo recebe. Copie o bloco da planilha e rode:
//
//   npm run -s formatar
//
// Sem pipe, lê o clipboard e devolve o texto pronto nele. Com pipe, usa a
// entrada e a saída padrão e não toca no clipboard:
//
//   pbpaste | npm run -s formatar
//
// O bloco pronto sai na saída padrão; aviso de coluna faltando, data ilegível
// e regra aplicada saem no erro padrão, pra não irem junto no ctrl+V.
//
// O texto por mês vem do `formatDatesByMonth` do núcleo — é o mesmo contrato
// que as fontes emitem e que o `parseDates` do vcc-alertas-portal lê.

type Papel = "data" | "assentos" | "valor" | "direcao" | "unidade" | "origem" | "destino" | "cabine" | "fonte";

const PADROES: [Papel, string[]][] = [
  ["data", ["data", "date", "partida", "embarque", "dia"]],
  ["assentos", ["assento", "seat", "vaga"]],
  ["valor", ["valor", "milhas", "miles", "preco", "price", "tarifa", "pontos", "points", "custo"]],
  ["direcao", ["direcao", "direction", "sentido", "perna", "leg"]],
  ["unidade", ["unidade", "unit", "moeda", "currency"]],
  ["origem", ["origem", "origin", "from"]],
  ["destino", ["destino", "destination"]],
  ["cabine", ["cabine", "cabin", "classe", "class"]],
  ["fonte", ["fonte", "source", "programa", "program", "companhia", "airline"]],
];

const SEM_DIRECAO = "SEM DIREÇÃO";

const avisos: string[] = [];

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function classificar(nomeColuna: string): Papel | null {
  const n = normalizar(nomeColuna);
  if (!n) return null;
  for (const [papel, termos] of PADROES) {
    if (termos.some((t) => n.includes(t))) return papel;
  }
  return null;
}

function detectarDelimitador(linha: string): string {
  if (linha.includes("\t")) return "\t";
  if (linha.includes(";")) return ";";
  if (linha.includes(",")) return ",";
  return "\t";
}

function parseData(bruto: string, numeroLinha: number): string {
  const v = bruto.trim();
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]!.padStart(2, "0")}-${br[1]!.padStart(2, "0")}`;
  throw new Error(
    `linha ${numeroLinha}: não consegui ler "${v}" como data. Aceito YYYY-MM-DD e DD/MM/AAAA.`,
  );
}

// Número vazio é ausência declarada (vira null); número ilegível é erro — nunca
// vira zero, que sairia no alerta como "dia sem vaga".
function parseNumero(bruto: string, coluna: string, numeroLinha: number): number | null {
  let v = bruto.trim();
  if (!v || v === "-" || v === "—") return null;
  v = v.replace(/\s/g, "").replace(/^R\$/i, "").replace(/[kK]$/, "");
  const temPonto = v.includes(".");
  const temVirgula = v.includes(",");
  if (temPonto && temVirgula) {
    v = v.lastIndexOf(",") > v.lastIndexOf(".") ? v.replace(/\./g, "").replace(",", ".") : v.replace(/,/g, "");
  } else if (temVirgula) {
    v = /,\d{1,2}$/.test(v) ? v.replace(",", ".") : v.replace(/,/g, "");
  } else if (temPonto && /\.\d{3}$/.test(v)) {
    v = v.replace(/\./g, "");
  }
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(`linha ${numeroLinha}: coluna "${coluna}" tem "${bruto.trim()}", que não é número.`);
  }
  return n;
}

function normalizarDirecao(bruto: string): "ida" | "volta" | null {
  const n = normalizar(bruto);
  if (!n) return null;
  if (["ida", "outbound", "departure", "partida", "out", "going"].some((t) => n.includes(t))) return "ida";
  if (["volta", "return", "inbound", "retorno", "back"].some((t) => n.includes(t))) return "volta";
  avisos.push(`direção "${bruto.trim()}" não é ida nem volta; essas linhas ficaram num bloco separado.`);
  return null;
}

type Registro = {
  data: string;
  assentos: number | null;
  valor: number | null;
  direcao: string;
  rotulos: Partial<Record<Papel, string>>;
};

type Dia = { data: string; assentos: number | null; valor: number | null };

function lerColagem(texto: string) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (linhas.length === 0) throw new Error("não veio nada na entrada. Copie o bloco da planilha e rode de novo.");

  const delimitador = detectarDelimitador(linhas[0]!);
  const celulas = linhas.map((l) => l.split(delimitador).map((c) => c.trim().replace(/^"|"$/g, "")));

  const cabecalho = celulas[0]!;
  const papeis = new Map<Papel, number>();
  cabecalho.forEach((nome, i) => {
    const papel = classificar(nome);
    if (!papel) return;
    if (papeis.has(papel)) {
      avisos.push(`duas colunas viraram "${papel}" ("${cabecalho[papeis.get(papel)!]}" e "${nome}"); usei a primeira.`);
      return;
    }
    papeis.set(papel, i);
  });

  const iData = papeis.get("data");
  if (iData === undefined) {
    throw new Error(
      `não achei coluna de data no cabeçalho (${cabecalho.join(" | ")}). ` +
        `Copie da planilha incluindo a linha de títulos.`,
    );
  }

  const iAssentos = papeis.get("assentos");
  const iValor = papeis.get("valor");
  const iDirecao = papeis.get("direcao");
  const iUnidade = papeis.get("unidade");

  const registros: Registro[] = [];
  for (let i = 1; i < celulas.length; i++) {
    const linha = celulas[i]!;
    const numero = i + 1;
    const direcao = iDirecao !== undefined ? (normalizarDirecao(linha[iDirecao] ?? "") ?? "outros") : "todas";
    const rotulos: Partial<Record<Papel, string>> = {};
    for (const papel of ["origem", "destino", "cabine", "fonte", "unidade"] as const) {
      const i = papeis.get(papel);
      if (i !== undefined && linha[i]) rotulos[papel] = linha[i]!;
    }
    registros.push({
      data: parseData(linha[iData] ?? "", numero),
      assentos: iAssentos !== undefined ? parseNumero(linha[iAssentos] ?? "", cabecalho[iAssentos]!, numero) : null,
      valor: iValor !== undefined ? parseNumero(linha[iValor] ?? "", cabecalho[iValor]!, numero) : null,
      direcao,
      rotulos,
    });
  }

  return {
    registros,
    temValor: iValor !== undefined,
    temAssentos: iAssentos !== undefined,
    temDirecao: iDirecao !== undefined,
    colunaValor: iValor !== undefined ? cabecalho[iValor]! : null,
    nomeColuna: (papel: Papel) => {
      const i = papeis.get(papel);
      return i === undefined ? papel : cabecalho[i]!;
    },
  };
}

// Deduplicação: cada data fica com a LINHA de mais vagas, e as duplicatas caem.
// Empate vai na mais barata. Preço e vagas saem sempre da MESMA linha — anunciar
// o preço de um voo com a vaga de outro seria mentira (é a razão da regra oposta
// em `construirRelatorioSmiles`, que fica com o voo mais barato).
function escolherLinha(linhas: Registro[]): Registro {
  return linhas.reduce((melhor, atual) => {
    const vagasAtual = atual.assentos ?? -1;
    const vagasMelhor = melhor.assentos ?? -1;
    if (vagasAtual !== vagasMelhor) return vagasAtual > vagasMelhor ? atual : melhor;
    if (atual.valor != null && melhor.valor != null) return atual.valor < melhor.valor ? atual : melhor;
    return melhor.valor != null ? melhor : atual;
  });
}

function agruparPorDia(registros: Registro[]): Dia[] {
  const porData = new Map<string, Registro[]>();
  for (const r of registros) {
    if (!porData.has(r.data)) porData.set(r.data, []);
    porData.get(r.data)!.push(r);
  }
  let descartadasMaisBaratas = 0;
  const dias = [...porData.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([data, linhas]) => {
      const escolhida = escolherLinha(linhas);
      const valores = linhas.map((l) => l.valor).filter((n): n is number => n != null);
      if (escolhida.valor != null && valores.length > 0 && Math.min(...valores) < escolhida.valor) {
        descartadasMaisBaratas++;
      }
      return { data, assentos: escolhida.assentos, valor: escolhida.valor };
    });
  if (descartadasMaisBaratas > 0) {
    avisos.push(
      `${descartadasMaisBaratas} dia(s) tinham voo MAIS BARATO com menos vagas; ` +
        `ficou a linha de mais vagas, como pedido — o menor valor do bloco é o dessas linhas.`,
    );
  }
  return dias;
}

function numeroPt(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

// O cabeçalho do bloco só afirma o que TODAS as linhas dele concordam. Valor
// mais barato de GRU→MCO anunciado junto de datas de outra rota (ou de outra
// cabine) é o tipo de alerta errado que custa cliente — então diverge, avisa.
function rotuloUnico(registros: Registro[], papel: Papel, ctx: ReturnType<typeof lerColagem>, titulo: string): string | null {
  const vistos = new Set(registros.map((r) => r.rotulos[papel]).filter((v): v is string => !!v));
  if (vistos.size === 1) return [...vistos][0]!;
  if (vistos.size > 1) {
    avisos.push(
      `${titulo}: a colagem mistura ${vistos.size} valores de "${ctx.nomeColuna(papel)}" (${[...vistos].join(", ")}); ` +
        `saiu tudo no mesmo bloco, com um menor/maior só.`,
    );
  }
  return null;
}

function montarBloco(titulo: string, registros: Registro[], dias: Dia[], ctx: ReturnType<typeof lerColagem>): string {
  const linhas: string[] = [];
  const voo = {
    origem: rotuloUnico(registros, "origem", ctx, titulo),
    destino: rotuloUnico(registros, "destino", ctx, titulo),
    cabine: rotuloUnico(registros, "cabine", ctx, titulo),
    fonte: rotuloUnico(registros, "fonte", ctx, titulo),
    unidade: rotuloUnico(registros, "unidade", ctx, titulo),
  };
  const identidade = [voo.origem && voo.destino ? `${voo.origem} → ${voo.destino}` : null, voo.cabine, voo.fonte]
    .filter(Boolean)
    .join(" · ");

  linhas.push(`*${titulo}*${identidade ? ` — ${identidade}` : ""}`);

  const vagas = dias.map((d) => d.assentos).filter((n): n is number => n != null);
  const semVagas = dias.length - vagas.length;
  const faixaVagas = vagas.length
    ? vagas.length === 1 || Math.min(...vagas) === Math.max(...vagas)
      ? `${Math.max(...vagas)} vaga(s) por dia`
      : `${Math.min(...vagas)} a ${Math.max(...vagas)} vagas por dia`
    : null;
  linhas.push(`💺 ${dias.length} data(s)${faixaVagas ? ` · ${faixaVagas}` : ""}`);

  const valores = dias.map((d) => d.valor).filter((n): n is number => n != null);
  const unidade = voo.unidade ? ` ${voo.unidade}` : "";
  if (valores.length) {
    const menor = Math.min(...valores);
    const maior = Math.max(...valores);
    linhas.push(
      menor === maior
        ? `💰 ${numeroPt(menor)}${unidade}`
        : `💰 menor ${numeroPt(menor)}${unidade} · maior ${numeroPt(maior)}${unidade}`,
    );
  } else {
    linhas.push("⚠️ sem coluna de valor na colagem — preencha o menor/maior antes de enviar");
  }
  if (semVagas > 0) linhas.push(`⚠️ ${semVagas} data(s) vieram sem número de vagas`);
  if (titulo === SEM_DIRECAO) linhas.push("⚠️ não reconheci a direção dessas linhas — confira se é ida ou volta");

  const porData = new Map(dias.map((d) => [d.data, d]));
  const texto = formatDatesByMonth(
    dias.map((d) => d.data),
    (data) => {
      const assentos = porData.get(data)!.assentos;
      return assentos != null ? ` (${assentos})` : "";
    },
  );
  linhas.push("");
  linhas.push(...texto.split("\n").map((l) => `📅 ${l}`));
  return linhas.join("\n");
}

const doClipboard = process.stdin.isTTY === true;
// Sem LANG em UTF-8, pbpaste/pbcopy trocam acento e emoji por "?".
const ambienteUtf8 = { ...process.env, LANG: "en_US.UTF-8" };

function lerEntrada(): Promise<string> {
  if (doClipboard) return Promise.resolve(execFileSync("pbpaste", { encoding: "utf8", env: ambienteUtf8 }));
  return new Promise((resolve, reject) => {
    let dados = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (pedaco) => (dados += pedaco));
    process.stdin.on("end", () => resolve(dados));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const ctx = lerColagem(await lerEntrada());

  const ordem = ["ida", "volta", "outros", "todas"];
  const porDirecao = new Map<string, Registro[]>();
  for (const r of ctx.registros) {
    if (!porDirecao.has(r.direcao)) porDirecao.set(r.direcao, []);
    porDirecao.get(r.direcao)!.push(r);
  }

  const blocos = [...porDirecao.entries()]
    .sort(([a], [b]) => ordem.indexOf(a) - ordem.indexOf(b))
    .map(([direcao, registros]) => {
      const titulo = direcao === "ida" ? "IDA" : direcao === "volta" ? "VOLTA" : direcao === "outros" ? SEM_DIRECAO : "DATAS";
      return montarBloco(titulo, registros, agruparPorDia(registros), ctx);
    });

  const saida = blocos.join("\n\n") + "\n";
  process.stdout.write(saida);
  // Só grava no fim: se a colagem deu erro, o clipboard continua com a planilha.
  if (doClipboard) execFileSync("pbcopy", { input: saida, env: ambienteUtf8 });

  if (!ctx.temDirecao) {
    avisos.push("sem coluna de direção na colagem: tudo saiu num bloco só. Cole ida e volta separadas, ou traga a coluna.");
  }
  if (!ctx.temAssentos) avisos.push("sem coluna de assentos: as datas saíram sem o (n) de vagas.");
  avisos.push(
    ctx.temValor
      ? `duplicatas: ficou a linha de mais vagas de cada data; valor e vagas vêm dela (coluna "${ctx.colunaValor}").`
      : "duplicatas: ficou a linha de mais vagas de cada data.",
  );
  for (const aviso of new Set(avisos)) process.stderr.write(`· ${aviso}\n`);
  if (doClipboard) process.stderr.write("✓ texto copiado pro clipboard\n");
}

main().catch((err) => {
  process.stderr.write(`erro: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
