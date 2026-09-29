import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import type { ReportSection } from "./core/common.ts";
import { buildTapReport, cabinParamOf, searchTapYear, startTapSession } from "./scrapers/tap/tap.scraper.ts";

function sectionAsText(name: string, section: ReportSection): string {
  if (section.days.length === 0) return `${name}:\n${section.text}`;
  const summary = `Menor valor: ${section.min}K | Maior valor: ${section.max}K | Dias com disponibilidade: ${section.days.length}`;
  return `${name}:\n${summary}\n${section.text}`;
}

async function askWithDefault(rl: readline.Interface, question: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${question} (Enter para "${fallback}"): `);
  return answer.trim() === "" ? fallback : answer.trim();
}

async function askYesNo(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await rl.question(`${question} (s/n): `);
  return /^s(im)?$/i.test(answer.trim());
}

async function searchFromTerminal() {
  const rl = readline.createInterface({ input, output });

  console.log("✈️  Bot de Emissões TAP Iniciado!\n");

  console.log("Acessando a página de login...");
  const { browser, page, baseUrl } = await startTapSession(false);
  console.log("Login concluído!");

  let origin = (await rl.question("🛫 Digite a origem (código IATA, ex.: GRU): ")).toUpperCase();
  let destination = (await rl.question("🛬 Digite o destino (código IATA, ex.: LIS): ")).toUpperCase();
  let cabin = await rl.question("💺 Cabine (1 para Executiva, 2 para Econômica): ");

  for (;;) {
    console.log(`\nBuscando ${origin} -> ${destination}...`);

    const { days, failedWindows } = await searchTapYear(
      page,
      { baseUrl, origin, destination, cabinParam: cabinParamOf(cabin) },
      (message) => console.log(message),
    );
    if (failedWindows.length > 0) {
      console.log(`\n⚠️  ${failedWindows.length} janela(s) não puderam ser buscadas e foram puladas.`);
    }
    const report = buildTapReport(days);

    console.log("\n--- RESULTADO ---\n");
    console.log(sectionAsText("Executivas", report.business));
    console.log("");
    console.log(sectionAsText("Economicas", report.economy));

    if (!(await askYesNo(rl, "\nDeseja pesquisar mais algum trecho (ex.: a volta)?"))) break;

    // Suggests the return of the route just searched, but any other can be typed.
    const nextOrigin = await askWithDefault(rl, "🛫 Origem", destination);
    const nextDestination = await askWithDefault(rl, "🛬 Destino", origin);
    cabin = await askWithDefault(rl, "💺 Cabine (1 para Executiva, 2 para Econômica)", cabin);
    origin = nextOrigin.toUpperCase();
    destination = nextDestination.toUpperCase();
  }

  rl.close();
  await browser.close();
}

searchFromTerminal();
