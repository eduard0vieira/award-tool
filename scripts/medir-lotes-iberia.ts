import "dotenv/config";
import {
  buscarVoosDoDia,
  detalharDias,
  garantirLogado,
  iniciarSessaoIberia,
  obterAutorizacao,
  pesquisarAnoIberia,
  type VooIberia,
} from "../src/fontes/iberia/bot-iberia.ts";

// Mede quantas chamadas de `/availability` em paralelo a Iberia aguenta quando
// saem de dentro da aba, logo depois do calendário, na mesma sessão. É o ritmo
// do `cheap-flights` (lotes de 30, 7s entre lotes), mas pelo navegador, que é o
// que o anti-bot deixa passar. Para no primeiro status que não seja 200/204.
//
// Uso: npx tsx scripts/medir-lotes-iberia.ts [GRU] [MAD] [5,10,30]
//      npx tsx scripts/medir-lotes-iberia.ts GRU MAD detalhe   (o `detalharDias` real, todas as datas)

const [origem = "GRU", destino = "MAD", lotes = "5,10,30"] = process.argv.slice(2);
const params = { origem, destino, passageiros: 1 };
const LOTES = lotes.split(",").map(Number);
const PAUSA_ENTRE_LOTES_MS = 7000;

async function main() {
  const sessao = await iniciarSessaoIberia(false);
  const page = sessao.page;
  const log = (msg: string) => console.log(msg);
  try {
    await garantirLogado(page, log);
    const calendario = await pesquisarAnoIberia(page, params, log);
    if (calendario.tipo === "erro" || calendario.tipo === "sem_disponibilidade") {
      console.error(`Calendário não deu datas pra medir: ${JSON.stringify(calendario)}`);
      return;
    }
    const autorizacao = obterAutorizacao(page);
    if (!autorizacao) {
      console.error("Sem token da página depois do calendário — nada a medir.");
      return;
    }

    const datas = calendario.dias.map((d) => d.data);

    if (lotes === "detalhe") {
      const inicio = Date.now();
      const { voos, diasComFalha } = await detalharDias(page, params, datas, log);
      const comExecutiva = new Set(voos.filter((v) => v.cabines.includes("BUSINESS")).map((v) => v.data));
      console.log(
        `\ndetalhe de ${datas.length} datas em ${((Date.now() - inicio) / 60000).toFixed(1)} min: ` +
          `${voos.length} voos, ${diasComFalha.length} dia(s) com falha, ${comExecutiva.size} dia(s) com executiva`,
      );
      for (const f of diasComFalha.slice(0, 5)) console.log(`  ${f.data}: ${f.erro.slice(0, 160)}`);
      return;
    }
    console.log(`\n${datas.length} datas com prêmio no calendário. Medindo lotes de ${LOTES.join(", ")}.\n`);

    let cursor = 0;
    const cabinesVistas = new Map<string, number>();
    for (const tamanho of LOTES) {
      const lote = datas.slice(cursor, cursor + tamanho);
      cursor += lote.length;
      if (lote.length === 0) break;
      if (!/^https:\/\/www\.iberia\.com\/flights\//.test(page.url())) {
        console.log(`PAROU: a aba saiu da busca antes do lote de ${tamanho} (${page.url().slice(0, 100)}).`);
        break;
      }

      const inicio = Date.now();
      const resultados = await Promise.all(
        lote.map(async (data) => {
          try {
            return { data, voos: await buscarVoosDoDia(page, params, data, autorizacao) };
          } catch (erro) {
            return { data, erro: erro instanceof Error ? erro.message : String(erro) };
          }
        }),
      );
      const ms = Date.now() - inicio;

      const falhas = resultados.filter((r): r is { data: string; erro: string } => "erro" in r);
      const oks = resultados.filter((r): r is { data: string; voos: VooIberia[] } => "voos" in r);
      const diasComExecutiva = oks.filter((r) => r.voos.some((v) => v.cabines.includes("BUSINESS"))).length;
      for (const r of oks) for (const v of r.voos) for (const c of v.cabines.split(", ").filter(Boolean)) {
        cabinesVistas.set(c, (cabinesVistas.get(c) ?? 0) + 1);
      }
      console.log(
        `lote de ${lote.length}: ${(ms / 1000).toFixed(1)}s, ${oks.length} ok, ${falhas.length} falha(s), ` +
          `${oks.reduce((n, r) => n + r.voos.length, 0)} voos, ${diasComExecutiva} dia(s) com executiva`,
      );
      if (falhas.length > 0) {
        for (const f of falhas.slice(0, 3)) console.log(`  ${f.data}: ${f.erro.slice(0, 160)}`);
        console.log("PAROU no primeiro lote com falha.");
        break;
      }
      await page.waitForTimeout(PAUSA_ENTRE_LOTES_MS);
    }

    console.log(`\nCabines vistas nos voos (voo pode ter mais de uma): ${JSON.stringify(Object.fromEntries(cabinesVistas))}`);
    console.log(`Aba ao final: ${page.url().slice(0, 100)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  },
);
