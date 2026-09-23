import "dotenv/config";
import { iniciarSessaoIberia, linkEmissaoIberia, obterAutorizacao } from "../src/fontes/iberia/bot-iberia.ts";

// O corpo do `/calendar/grid` tem um campo `preferredCabin` que a fonte sempre
// manda vazio — porque foi assim que o site mandou quando o recon capturou.
// Se ele aceitar "BUSINESS", o calendário passa a dar datas e preços DE
// EXECUTIVA, e o seletor de cabine do front deixa de ser cosmético.
//
// Esta sonda pergunta isso: mesma rota, mesma data, só mudando o campo.
//
// Uso: npx tsx scripts/probe-cabine-iberia.ts [GRU] [MAD]

const [origem = "GRU", destino = "MAD"] = process.argv.slice(2);
const params = { origem, destino, passageiros: 1 };

const CABINES = ["", "BUSINESS", "ECONOMY", "TOURIST", "PREMIUMTOURIST", "FIRST"];

function daquiA(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const sessao = await iniciarSessaoIberia(false);
  const page = sessao.page;
  try {
    const data = daquiA(1);
    await page
      .goto(linkEmissaoIberia(params, data), { waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) throw e;
      });
    await page.waitForTimeout(15_000);
    console.log(`página: ${page.url().slice(0, 90)}`);

    // Sem o bearer da própria página, o ibisservices devolve 401 e a sonda não
    // responde nada sobre cabine.
    const autorizacao = obterAutorizacao(page);
    if (!autorizacao) {
      console.error("A página não fez nenhuma chamada com Authorization — sem token não dá pra sondar.");
      return;
    }
    console.log("");

    for (const cabine of CABINES) {
      const corpo = {
        isPetFlight: false,
        slices: [{ origin: origem.toUpperCase(), destination: destino.toUpperCase(), date: data }],
        passengers: [{ passengerType: "ADULT", count: "1" }],
        marketCode: "US",
        preferredCabin: cabine,
        maxSearchTime: 359,
      };

      const r = (await page.evaluate(
        async ({ corpo, autorizacao }) => {
          try {
            const res = await fetch("https://ibisservices.iberia.com/api/sse-rpa/rs/v1/calendar/grid", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: autorizacao },
              body: JSON.stringify(corpo),
              credentials: "include",
            });
            return { status: res.status, texto: await res.text() };
          } catch (erro) {
            return { status: -1, texto: String(erro) };
          }
        },
        { corpo, autorizacao },
      )) as { status: number; texto: string };

      const rotulo = cabine === "" ? "(vazio, como a fonte manda hoje)" : cabine;
      if (r.status !== 200) {
        console.log(`preferredCabin=${rotulo}: status ${r.status} — ${r.texto.slice(0, 120)}`);
        continue;
      }
      try {
        const j = JSON.parse(r.texto) as {
          outbound?: { availabilityCalendar?: { date: string; avios?: number }[] };
        };
        const cal = j.outbound?.availabilityCalendar ?? [];
        const comAvios = cal.filter((d) => typeof d.avios === "number");
        const valores = comAvios.map((d) => d.avios!);
        console.log(
          `preferredCabin=${rotulo}: ${cal.length} dias, ${comAvios.length} com preço` +
            (valores.length ? `, de ${Math.min(...valores)} a ${Math.max(...valores)} Avios` : ""),
        );
      } catch {
        console.log(`preferredCabin=${rotulo}: 200, corpo ilegível`);
      }
      await page.waitForTimeout(8000);
    }
  } finally {
    await page.close().catch(() => {});
    await sessao.context.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  },
);
