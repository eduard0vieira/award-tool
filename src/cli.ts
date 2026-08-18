import { stdin as input, stdout as output } from "process";
import * as readline from "readline/promises";
import {
  cabineParamDe,
  construirRelatorio,
  iniciarSessao,
  pesquisarAnoCompleto,
  type SecaoRelatorio,
} from "./fontes/tap/bot-tap.ts";

function formatarSecaoParaTexto(nome: string, secao: SecaoRelatorio): string {
  if (secao.dias.length === 0) {
    return `${nome}:\n${secao.texto}`;
  }
  const resumo = `Menor valor: ${secao.menor}K | Maior valor: ${secao.maior}K | Dias com disponibilidade: ${secao.dias.length}`;
  return `${nome}:\n${resumo}\n${secao.texto}`;
}

async function perguntarComPadrao(
  rl: readline.Interface,
  pergunta: string,
  padrao: string,
): Promise<string> {
  const resposta = await rl.question(`${pergunta} (Enter para "${padrao}"): `);
  return resposta.trim() === "" ? padrao : resposta.trim();
}

async function perguntarSimNao(rl: readline.Interface, pergunta: string): Promise<boolean> {
  const resposta = await rl.question(`${pergunta} (s/n): `);
  return /^s(im)?$/i.test(resposta.trim());
}

async function buscarEmissoes() {
  const rl = readline.createInterface({ input, output });

  console.log("✈️  Bot de Emissões TAP Iniciado!\n");

  console.log("Acessando a página de login...");
  const { browser, page, baseUrl } = await iniciarSessao(false);
  console.log("Login concluído!");

  let origem = (
    await rl.question("🛫 Digite a origem (código IATA, ex.: GRU): ")
  ).toUpperCase();
  let destino = (
    await rl.question("🛬 Digite o destino (código IATA, ex.: LIS): ")
  ).toUpperCase();
  let cabine = await rl.question(
    "💺 Cabine (1 para Executiva, 2 para Econômica): ",
  );

  for (;;) {
    console.log(`\nBuscando ${origem} -> ${destino}...`);
    const cabineParam = cabineParamDe(cabine);

    const { dias: todasAsDatas, janelasComFalha } = await pesquisarAnoCompleto(
      page,
      { baseUrl, origem, destino, cabineParam },
      (msg) => console.log(msg),
    );
    if (janelasComFalha.length > 0) {
      console.log(`\n⚠️  ${janelasComFalha.length} janela(s) não puderam ser buscadas e foram puladas.`);
    }
    const relatorio = construirRelatorio(todasAsDatas);

    console.log("\n--- RESULTADO ---\n");
    console.log(formatarSecaoParaTexto("Executivas", relatorio.executivas));
    console.log("");
    console.log(formatarSecaoParaTexto("Economicas", relatorio.economicas));

    const querOutroTrecho = await perguntarSimNao(
      rl,
      "\nDeseja pesquisar mais algum trecho (ex.: a volta)?",
    );
    if (!querOutroTrecho) break;

    // Sugere a volta do trecho pesquisado (origem/destino invertidos) como
    // padrão, mas deixa o usuário digitar outra coisa se quiser.
    const novaOrigem = await perguntarComPadrao(rl, "🛫 Origem", destino);
    const novoDestino = await perguntarComPadrao(rl, "🛬 Destino", origem);
    const novaCabine = await perguntarComPadrao(
      rl,
      "💺 Cabine (1 para Executiva, 2 para Econômica)",
      cabine,
    );

    origem = novaOrigem.toUpperCase();
    destino = novoDestino.toUpperCase();
    cabine = novaCabine;
  }

  rl.close();
  await browser.close();
}

buscarEmissoes();
