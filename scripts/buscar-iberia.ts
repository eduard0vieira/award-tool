import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { DIR_PLANILHAS } from "../src/nucleo/caminhos.ts";
import {
  criarPlanilhaDaBusca,
  gravarCsvDeVoos,
  registrarBusca,
  type LinhaVoo,
} from "../src/saidas/planilha.ts";
import {
  construirRelatorioIberia,
  detalharDias,
  filtrarVoos,
  iniciarSessaoIberia,
  linkEmissaoIberia,
  pesquisarAnoIberia,
  type FiltrosVoo,
  type ParametrosIberia,
} from "../src/fontes/iberia/bot-iberia.ts";

// Roda a fonte Iberia de ponta a ponta, sem servidor e sem front.
//
//   npx tsx scripts/buscar-iberia.ts GRU MAD 40000 --escalas=1 --duracao=20h --dias=20
//
// Argumentos posicionais: origem, destino, teto em Avios (opcional).
// Opções:
//   --dias=N      quantos dias (os mais baratos) detalhar voo a voo. 0 desliga.
//   --escalas=N   descarta itinerário com mais de N escalas
//   --duracao=X   descarta acima de X; aceita "20h", "1200m" ou minutos puros
//   --cia=IB,I2   só itinerários operados inteiramente por essas companhias

const args = process.argv.slice(2);
const opcoes = new Map<string, string>();
const posicionais: string[] = [];
for (const arg of args) {
  const casa = /^--([a-z]+)=(.*)$/.exec(arg);
  if (casa) opcoes.set(casa[1]!, casa[2]!);
  else posicionais.push(arg);
}

const [origem = "GRU", destino = "MAD", tetoBruto] = posicionais;
const teto = tetoBruto ? Number(tetoBruto) : null;
if (teto != null && Number.isNaN(teto)) {
  console.error(`Teto "${tetoBruto}" não é número.`);
  process.exit(1);
}

function numeroDaOpcao(nome: string, padrao: number | null): number | null {
  const bruto = opcoes.get(nome);
  if (bruto === undefined) return padrao;
  const n = Number(bruto);
  if (Number.isNaN(n)) {
    console.error(`--${nome}=${bruto} não é número.`);
    process.exit(1);
  }
  return n;
}

// "20h" → 1200, "90m" → 90, "1200" → 1200.
function duracaoEmMinutos(): number | null {
  const bruto = opcoes.get("duracao");
  if (!bruto) return null;
  const casa = /^(\d+(?:[.,]\d+)?)\s*([hm]?)$/i.exec(bruto.trim());
  if (!casa) {
    console.error(`--duracao=${bruto} não entendi. Use "20h", "1200m" ou "1200".`);
    process.exit(1);
  }
  const valor = Number(casa[1]!.replace(",", "."));
  return casa[2]!.toLowerCase() === "h" ? Math.round(valor * 60) : Math.round(valor);
}

// Desligado por padrão: o detalhe voo a voo ainda não é confiável — a sessão da
// Iberia cai no meio da varredura e o `/availability` só responde de dentro da
// aba, que a essa altura já foi mandada pro login. Quem quiser tentar passa
// `--dias=N` sabendo disso. O calendário, que é o que produz o alerta, não
// depende dele.
const MAX_DIAS_DETALHE = numeroDaOpcao("dias", 0)!;
const filtros: FiltrosVoo = {
  maxEscalas: numeroDaOpcao("escalas", null),
  maxDuracaoMinutos: duracaoEmMinutos(),
  companhias: opcoes.get("cia")?.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) ?? null,
};

const params: ParametrosIberia = { origem, destino, passageiros: 1 };
const carimbo = new Date().toISOString().slice(0, 16).replace("T", " ");

async function main() {
  console.log(`\nIberia ${origem.toUpperCase()} → ${destino.toUpperCase()}${teto ? ` (teto ${teto} Avios)` : ""}\n`);

  const sessao = await iniciarSessaoIberia(false);
  try {
    const resultado = await pesquisarAnoIberia(
      sessao.page,
      params,
      (m) => console.log(`  ${m}`),
      (f) => process.stdout.write(`\r  calendário: ${Math.round(f * 100)}%   `),
    );
    console.log("\n");

    if (resultado.tipo === "erro") {
      console.error(`❌ ${resultado.motivo}`);
      process.exitCode = 1;
      return;
    }
    if (resultado.tipo === "sem_disponibilidade") {
      console.log(`Nenhum dia com prêmio entre ${resultado.janela.de} e ${resultado.janela.ate}.`);
      return;
    }
    if (resultado.tipo === "parcial") console.log(`⚠️  Resultado parcial: ${resultado.motivo}\n`);

    const secao = construirRelatorioIberia(resultado.dias, teto, params);
    console.log(`Janela varrida: ${resultado.janela.de} → ${resultado.janela.ate}`);
    console.log(`Dias com prêmio: ${resultado.dias.length}` + (teto ? ` (${secao.dias.length} dentro do teto)` : ""));
    if (secao.menor != null) console.log(`Faixa: ${secao.menor}K → ${secao.maior}K Avios\n`);
    console.log(secao.texto);

    // Registro acumulado, igual às outras fontes: uma linha por dia.
    await registrarBusca(
      {
        fonte: "IBERIA",
        origem: origem.toUpperCase(),
        destino: destino.toUpperCase(),
        pernas: [
          {
            rotulo: `Ida: ${origem.toUpperCase()} → ${destino.toUpperCase()}`,
            secoes: [{ rotulo: "Avios", dias: secao.dias.map((d) => ({ data: d.data, valorK: d.valorK })) }],
          },
        ],
        tetos: teto != null ? { Avios: Math.round(teto / 10) / 100 } : {},
        busca: crypto.randomUUID(),
      },
      (m) => console.log(`  ${m}`),
    );
    console.log(`\nRegistrado em planilhas/buscas.csv (${secao.dias.length} linha(s)).`);

    if (MAX_DIAS_DETALHE <= 0 || secao.dias.length === 0) return;

    // Detalhe voo a voo: uma requisição por data, então vai nos mais baratos
    // primeiro e com teto de quantidade. O que ficou de fora é dito em voz
    // alta — varredura cortada que não se anuncia vira "não tem" no alerta.
    const aviosPorData = new Map(resultado.dias.map((d) => [d.data, d.avios]));
    const candidatos = [...secao.dias].sort(
      (a, b) => (aviosPorData.get(a.data) ?? 0) - (aviosPorData.get(b.data) ?? 0),
    );
    const escolhidos = candidatos.slice(0, MAX_DIAS_DETALHE);
    if (candidatos.length > escolhidos.length) {
      console.log(
        `\n${candidatos.length} dia(s) passaram no teto; detalhando os ${escolhidos.length} mais baratos ` +
          `(--dias=${MAX_DIAS_DETALHE}). Os outros ${candidatos.length - escolhidos.length} ficaram sem voo na planilha.`,
      );
    } else {
      console.log(`\nDetalhando ${escolhidos.length} dia(s), voo a voo...`);
    }

    const { voos, diasComFalha } = await detalharDias(
      sessao.page,
      params,
      escolhidos.map((d) => d.data),
      (m) => console.log(`  ${m}`),
      (f) => process.stdout.write(`\r  detalhe: ${Math.round(f * 100)}%   `),
    );
    console.log("");

    const filtrados = filtrarVoos(voos, filtros);
    const cortados = voos.length - filtrados.length;
    if (cortados > 0) console.log(`  ${cortados} voo(s) fora dos filtros pedidos.`);
    if (diasComFalha.length > 0) {
      console.log(`⚠️  ${diasComFalha.length} dia(s) falharam. O primeiro: ${diasComFalha[0]!.data} — ${diasComFalha[0]!.erro}`);
    }

    const linhas: LinhaVoo[] = filtrados.map((v) => ({
      departure_date: v.data,
      arrival_date: v.chegadaData,
      departure_station: v.origem,
      departure_time: v.partidaHora,
      arrival_station: v.destino,
      connections: v.escalas,
      connecting_airports: v.aeroportosConexao,
      // Vazio de propósito: a Iberia não dá preço por voo. O do dia vai em
      // `day_avios`, que é o que ele de fato é.
      points: "",
      duration: v.duracaoMinutos,
      cabin_category: v.cabines,
      operation_carriers: v.companhias,
      program: "IBERIA",
      source_fare: v.tarifa,
      available_seats: v.assentos ?? "",
      aircraft: v.aeronaves,
      tax: "",
      class_of_service: v.classesServico,
      url: linkEmissaoIberia(params, v.data),
      day_avios: aviosPorData.get(v.data) ?? "",
    }));

    if (linhas.length === 0) {
      console.log("Nenhum voo sobrou depois dos filtros — planilha de voos não foi gerada.");
      return;
    }

    const arquivo = path.join(
      DIR_PLANILHAS,
      `iberia-${origem.toUpperCase()}-${destino.toUpperCase()}-${carimbo.replace(/[: ]/g, "-")}.csv`,
    );
    gravarCsvDeVoos(linhas, arquivo);
    console.log(`\n✅ ${linhas.length} voo(s) em ${path.relative(process.cwd(), arquivo)}`);

    const url = await criarPlanilhaDaBusca(
      { titulo: `Iberia ${origem.toUpperCase()}-${destino.toUpperCase()} ${carimbo}`, linhas },
      (m) => console.log(`  ${m}`),
    );
    if (url) console.log(`   também no Google: ${url}`);
  } finally {
    // Fechar só a aba deixa o contexto do Chrome vivo, e o processo fica
    // pendurado depois de imprimir tudo — foi o que travou uma execução por
    // 16 minutos. Fecha o contexto e sai com código explícito.
    await sessao.page.close().catch(() => {});
    await sessao.context.close().catch(() => {});
    await sessao.browser?.close().catch(() => {});
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (erro: unknown) => {
    console.error(`\n❌ ${erro instanceof Error ? erro.message : String(erro)}`);
    process.exit(1);
  },
);
