const form = document.getElementById("form-busca");
const btnBuscar = document.getElementById("btn-buscar");
const selectPrograma = document.getElementById("programa");
const inputOrigem = document.getElementById("origem");
const inputDestino = document.getElementById("destino");
const checkboxIdaVolta = document.getElementById("ida-volta");
const linhaTetos = document.getElementById("linha-tetos");
const inputTetoEconomica = document.getElementById("teto-economica");
const inputTetoPremium = document.getElementById("teto-premium");
const inputTetoExecutiva = document.getElementById("teto-executiva");
const aviso = document.getElementById("aviso");
const progresso = document.getElementById("progresso");
const progressoLabel = document.getElementById("progresso-label");
const progressoJanela = document.getElementById("progresso-janela");
const barraPreenchida = document.getElementById("barra-preenchida");
const resultado = document.getElementById("resultado");
const tplPerna = document.getElementById("tpl-perna");
const abasBtns = document.querySelectorAll(".aba-btn");
const painelBuscar = document.getElementById("painel-buscar");
const painelHistorico = document.getElementById("painel-historico");
const listaHistorico = document.getElementById("lista-historico");
const historicoVazio = document.getElementById("historico-vazio");
const historicoTopo = document.getElementById("historico-topo");
const historicoResumo = document.getElementById("historico-resumo");
const btnLimparHistorico = document.getElementById("btn-limpar-historico");

const MESES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const HISTORICO_KEY = "awardtool_historico";
const TOLERANCIA_DIAS = 5;
const TOLERANCIA_MS = TOLERANCIA_DIAS * 24 * 60 * 60 * 1000;

const PROGRAMA_LABEL = { tap: "TAP", IB: "Iberia", BA: "British Airways" };
// Registros antigos do histórico (antes do seletor de programa) eram sempre TAP.
const programaDe = (item) => item.programa || "tap";

selectPrograma.addEventListener("change", () => {
  linhaTetos.hidden = selectPrograma.value === "tap";
});

abasBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    abasBtns.forEach((b) => b.classList.remove("ativo"));
    btn.classList.add("ativo");
    const aba = btn.dataset.aba;
    painelBuscar.hidden = aba !== "buscar";
    painelHistorico.hidden = aba !== "historico";
    if (aba === "historico") renderizarHistorico();
  });
});

function carregarHistorico() {
  try {
    return JSON.parse(localStorage.getItem(HISTORICO_KEY)) || [];
  } catch {
    return [];
  }
}

function salvarNoHistorico(origem, destino, programa, idaEVolta = false) {
  const historico = carregarHistorico();
  historico.push({ origem, destino, programa, idaEVolta, timestamp: Date.now() });
  localStorage.setItem(HISTORICO_KEY, JSON.stringify(historico));
}

// Na TAP as pernas rodam em sequência: a ida entra no histórico assim que
// termina e, se a volta também completar, o registro vira ida e volta (em vez
// de virar dois registros separados).
function promoverUltimaParaIdaEVolta(origem, destino, programa) {
  const historico = carregarHistorico();
  const ultima = historico
    .filter((h) => h.origem === origem && h.destino === destino && programaDe(h) === programa)
    .reduce((mais, atual) => (!mais || atual.timestamp > mais.timestamp ? atual : mais), null);
  if (ultima) {
    ultima.idaEVolta = true;
    localStorage.setItem(HISTORICO_KEY, JSON.stringify(historico));
  }
}

// Um registro ida e volta cobre as duas direções do trecho.
function buscaRecenteDe(origem, destino, programa) {
  const historico = carregarHistorico();
  const doMesmoTrecho = historico.filter(
    (h) =>
      programaDe(h) === programa &&
      ((h.origem === origem && h.destino === destino) ||
        (h.idaEVolta && h.origem === destino && h.destino === origem)),
  );
  if (doMesmoTrecho.length === 0) return null;
  return doMesmoTrecho.reduce((mais, atual) => (atual.timestamp > mais.timestamp ? atual : mais));
}

function formatarDataHora(timestamp) {
  const data = new Date(timestamp);
  const dataStr = data.toLocaleDateString("pt-BR");
  const horaStr = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${dataStr} às ${horaStr}`;
}

function formatarTempoRelativo(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "agora mesmo";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHoras = Math.floor(diffMin / 60);
  if (diffHoras < 24) return `há ${diffHoras}h`;
  const diffDias = Math.floor(diffHoras / 24);
  if (diffDias === 1) return "há 1 dia";
  return `há ${diffDias} dias`;
}

// "2026-07-17" no fuso local, pra agrupar buscas por dia.
function chaveDoDia(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rotuloDoDia(timestamp) {
  const hoje = chaveDoDia(Date.now());
  const ontem = chaveDoDia(Date.now() - 24 * 60 * 60 * 1000);
  const chave = chaveDoDia(timestamp);
  if (chave === hoje) return "Hoje";
  if (chave === ontem) return "Ontem";
  const texto = new Date(timestamp).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// Preenche o formulário da aba Buscar com o trecho do histórico e troca de aba.
function repetirBusca(item) {
  const programa = programaDe(item);
  selectPrograma.value = programa;
  linhaTetos.hidden = programa === "tap";
  inputOrigem.value = item.origem;
  inputDestino.value = item.destino;
  checkboxIdaVolta.checked = Boolean(item.idaEVolta);
  document.querySelector('.aba-btn[data-aba="buscar"]').click();
  inputOrigem.focus();
}

// Registros novos de ida e volta já vêm como um item só, mas o histórico
// antigo guardava as duas pernas separadas (A→B e B→A). Aqui esses pares
// (mesmo programa, direções opostas, até 3h de diferença) viram um item ⇄ na
// exibição, com a direção original da ida e o horário em que terminou.
function agruparParaExibicao(historico) {
  const JANELA_PAR_MS = 3 * 60 * 60 * 1000;
  const usados = new Set();
  const exibicao = [];

  for (let i = 0; i < historico.length; i++) {
    if (usados.has(i)) continue;
    const item = historico[i];

    if (!item.idaEVolta) {
      const j = historico.findIndex(
        (outro, k) =>
          k > i &&
          !usados.has(k) &&
          !outro.idaEVolta &&
          programaDe(outro) === programaDe(item) &&
          outro.origem === item.destino &&
          outro.destino === item.origem &&
          item.timestamp - outro.timestamp < JANELA_PAR_MS,
      );
      if (j !== -1) {
        usados.add(j);
        // O registro mais antigo do par é a ida: dita a direção exibida.
        const ida = historico[j];
        exibicao.push({ ...ida, idaEVolta: true, timestamp: item.timestamp });
        continue;
      }
    }
    exibicao.push(item);
  }
  return exibicao;
}

function renderizarHistorico() {
  const bruto = carregarHistorico().slice().sort((a, b) => b.timestamp - a.timestamp);
  const historico = agruparParaExibicao(bruto);
  listaHistorico.innerHTML = "";
  historicoVazio.hidden = historico.length > 0;
  historicoTopo.hidden = historico.length === 0;

  if (historico.length === 0) return;

  // Resumo geral no topo. Trechos de ida e volta contam como um só,
  // independente da direção.
  const trechosUnicos = new Set(
    historico.map((h) => {
      const rota = h.idaEVolta ? [h.origem, h.destino].sort().join("⇄") : `${h.origem}→${h.destino}`;
      return `${programaDe(h)}|${rota}`;
    }),
  ).size;
  const emTolerancia = historico.filter((h) => Date.now() - h.timestamp < TOLERANCIA_MS).length;
  historicoResumo.textContent =
    `${historico.length} busca(s) · ${trechosUnicos} trecho(s) diferente(s) · ` +
    `${emTolerancia} dentro da tolerância de ${TOLERANCIA_DIAS} dias · última ${formatarTempoRelativo(historico[0].timestamp)}`;

  // Agrupa por dia, mantendo a ordem (mais recente primeiro).
  const grupos = new Map();
  for (const item of historico) {
    const chave = chaveDoDia(item.timestamp);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(item);
  }

  for (const itens of grupos.values()) {
    const grupo = document.createElement("section");
    grupo.className = "dia-grupo";

    const cabecalho = document.createElement("div");
    cabecalho.className = "dia-cabecalho";

    const rotulo = document.createElement("span");
    rotulo.className = "dia-rotulo";
    rotulo.textContent = rotuloDoDia(itens[0].timestamp);

    const sub = document.createElement("span");
    sub.className = "dia-sub";
    const dataCurta = new Date(itens[0].timestamp).toLocaleDateString("pt-BR");
    sub.textContent = `${dataCurta} · ${itens.length} busca(s)`;

    cabecalho.append(rotulo, sub);
    grupo.appendChild(cabecalho);

    for (const item of itens) {
      grupo.appendChild(criarItemHistorico(item));
    }
    listaHistorico.appendChild(grupo);
  }
}

function criarItemHistorico(item) {
  const programa = programaDe(item);

  const linha = document.createElement("div");
  linha.className = `item-historico accent-${programa}`;

  const principal = document.createElement("div");
  principal.className = "item-historico-principal";

  const tagPrograma = document.createElement("span");
  tagPrograma.className = `tag-programa tag-${programa}`;
  tagPrograma.textContent = PROGRAMA_LABEL[programa] || programa;

  const rota = document.createElement("span");
  rota.className = "item-historico-rota";
  const de = document.createElement("strong");
  de.textContent = item.origem;
  const seta = document.createElement("span");
  seta.className = item.idaEVolta ? "rota-seta rota-seta-iv" : "rota-seta";
  seta.textContent = item.idaEVolta ? "⇄" : "→";
  seta.title = item.idaEVolta ? "Ida e volta" : "Somente ida";
  const para = document.createElement("strong");
  para.textContent = item.destino;
  rota.append(de, seta, para);

  principal.append(tagPrograma, rota);

  if (Date.now() - item.timestamp < TOLERANCIA_MS) {
    const ponto = document.createElement("span");
    ponto.className = "ponto-recente";
    ponto.title = `Dentro da tolerância de ${TOLERANCIA_DIAS} dias — repetir esse trecho vai gerar aviso.`;
    principal.appendChild(ponto);
  }

  // TAP traz Executiva + Econômica; SeatSpy (Iberia/British) traz Premium também.
  const cabines =
    programa === "tap"
      ? [["Executiva", "cartao-executiva"], ["Econômica", "cartao-economica"]]
      : [["Econômica", "cartao-economica"], ["Premium", "cartao-premium"], ["Executiva", "cartao-executiva"]];
  const grupoCabines = document.createElement("div");
  grupoCabines.className = "item-historico-cabines";
  for (const [texto, classe] of cabines) {
    const tag = document.createElement("span");
    tag.className = `item-historico-cabine ${classe}`;
    tag.textContent = texto;
    grupoCabines.appendChild(tag);
  }

  const direita = document.createElement("div");
  direita.className = "item-historico-direita";

  const hora = document.createElement("span");
  hora.className = "item-historico-hora";
  hora.textContent = new Date(item.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const relativo = document.createElement("span");
  relativo.className = "item-historico-relativo";
  relativo.textContent = formatarTempoRelativo(item.timestamp);

  direita.append(hora, relativo);

  const btnRepetir = document.createElement("button");
  btnRepetir.type = "button";
  btnRepetir.className = "btn-rebuscar";
  btnRepetir.title = "Preencher a busca com esse trecho";
  btnRepetir.textContent = "↻";
  btnRepetir.addEventListener("click", () => repetirBusca(item));

  linha.append(principal, grupoCabines, direita, btnRepetir);
  return linha;
}

btnLimparHistorico.addEventListener("click", () => {
  if (!confirm("Apagar todo o histórico de buscas? Isso não pode ser desfeito.")) return;
  localStorage.removeItem(HISTORICO_KEY);
  renderizarHistorico();
});

function mostrarAviso(mensagem) {
  aviso.textContent = mensagem;
  aviso.hidden = false;
}

function limparAviso() {
  aviso.hidden = true;
  aviso.textContent = "";
}

function definirCarregando(carregando) {
  btnBuscar.disabled = carregando;
  selectPrograma.disabled = carregando;
  inputOrigem.disabled = carregando;
  inputDestino.disabled = carregando;
  checkboxIdaVolta.disabled = carregando;
  inputTetoEconomica.disabled = carregando;
  inputTetoPremium.disabled = carregando;
  inputTetoExecutiva.disabled = carregando;
}

function atualizarBarra(fracao) {
  barraPreenchida.style.width = `${Math.min(Math.round(fracao * 100), 100)}%`;
}

// Roda uma busca via SSE e resolve com o resultado final: o relatório da
// perna (TAP) ou a lista de pernas (SeatSpy, que traz ida e volta juntas).
function buscarNoServidor(corpo, rotuloProgresso) {
  return new Promise(async (resolve, reject) => {
    progressoLabel.textContent = rotuloProgresso;
    progressoJanela.textContent = "";
    atualizarBarra(0);

    let resposta;
    try {
      resposta = await fetch("/api/buscar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
    } catch {
      reject(new Error("Não foi possível conectar ao servidor."));
      return;
    }

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => ({}));
      reject(new Error(corpo.erro || "Erro ao iniciar a busca."));
      return;
    }

    const { jobId } = await resposta.json();
    const fonte = new EventSource(`/api/buscar/${jobId}/eventos`);

    fonte.onmessage = (evento) => {
      const dado = JSON.parse(evento.data);
      if (dado.tipo === "progresso") {
        atualizarBarra(dado.fracao);
      } else if (dado.tipo === "janela") {
        progressoJanela.textContent = `Janela ${dado.atual} de ${dado.total} · ${dado.inicio} – ${dado.fim}`;
      } else if (dado.tipo === "done") {
        fonte.close();
        resolve(dado.pernas || dado.relatorio);
      } else if (dado.tipo === "erro") {
        fonte.close();
        reject(new Error(dado.mensagem));
      }
    };

    fonte.onerror = () => {
      fonte.close();
      reject(new Error("Conexão com o servidor perdida."));
    };
  });
}

function formatarPorMes(dias) {
  const grupos = new Map();
  for (const { data } of dias) {
    const [ano, mes, dia] = data.split("-");
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(dia);
  }
  return Array.from(grupos.keys())
    .sort()
    .map((chave) => {
      const [ano, mesNum] = chave.split("-");
      return { titulo: `${MESES_PT[parseInt(mesNum, 10) - 1]} ${ano}`, dias: grupos.get(chave) };
    });
}

function renderizarColuna(colunaEl, secao, corClasse) {
  const resumoEl = colunaEl.querySelector(".coluna-resumo");
  const cartoesEl = colunaEl.querySelector(".cartoes");
  const btnCopiar = colunaEl.querySelector(".btn-copiar");

  if (!secao.dias || secao.dias.length === 0) {
    resumoEl.textContent = "Sem disponibilidade nesse período.";
    btnCopiar.hidden = true;
    return;
  }

  resumoEl.textContent = `${secao.menor}K–${secao.maior}K · ${secao.dias.length} dia(s)`;

  const grupos = formatarPorMes(secao.dias);
  cartoesEl.innerHTML = "";
  for (const grupo of grupos) {
    const tituloMes = document.createElement("div");
    tituloMes.className = "mes-titulo";
    tituloMes.textContent = grupo.titulo;
    cartoesEl.appendChild(tituloMes);

    const linha = document.createElement("div");
    linha.className = "linha-cartoes";
    for (const dia of grupo.dias) {
      const cartao = document.createElement("span");
      cartao.className = `cartao ${corClasse}`;
      cartao.textContent = dia;
      linha.appendChild(cartao);
    }
    cartoesEl.appendChild(linha);
  }

  btnCopiar.hidden = false;
  btnCopiar.onclick = () => {
    navigator.clipboard.writeText(secao.texto);
    btnCopiar.textContent = "Copiado!";
    setTimeout(() => (btnCopiar.textContent = "Copiar"), 1500);
  };
}

function renderizarPerna(rotulo, relatorio) {
  const fragmento = tplPerna.content.cloneNode(true);
  const raiz = fragmento.querySelector(".perna");
  raiz.querySelector(".perna-titulo").textContent = rotulo;
  renderizarColuna(raiz.querySelector(".coluna-executiva"), relatorio.executivas, "cartao-executiva");
  renderizarColuna(raiz.querySelector(".coluna-economica"), relatorio.economicas, "cartao-economica");
  resultado.appendChild(raiz);
}

// Versão do SeatSpy: as cabines vêm do servidor (Econômica/Premium/Executiva),
// então as colunas são montadas dinamicamente em vez de vir do template.
function renderizarPernaSecoes(rotulo, secoes) {
  const raiz = document.createElement("div");
  raiz.className = "perna";

  const titulo = document.createElement("h2");
  titulo.className = "perna-titulo";
  titulo.textContent = rotulo;
  raiz.appendChild(titulo);

  const colunas = document.createElement("div");
  colunas.className = "colunas colunas-3";
  for (const secao of secoes) {
    const col = document.createElement("div");
    col.className = "coluna";
    col.innerHTML = `
      <div class="coluna-cabecalho">
        <h3></h3>
        <button type="button" class="btn-copiar">Copiar</button>
      </div>
      <p class="coluna-resumo"></p>
      <div class="cartoes"></div>`;
    col.querySelector("h3").textContent = secao.rotulo;
    renderizarColuna(col, secao, secao.corClasse);
    colunas.appendChild(col);
  }
  raiz.appendChild(colunas);
  resultado.appendChild(raiz);
}

function tetoEmMilhas(input) {
  const valor = parseFloat(input.value);
  return Number.isFinite(valor) && valor > 0 ? Math.round(valor * 1000) : null;
}

async function iniciarBusca(programa, origem, destino, idaEVolta) {
  limparAviso();
  definirCarregando(true);
  resultado.hidden = true;
  resultado.innerHTML = "";
  progresso.hidden = false;

  try {
    if (programa === "tap") {
      const rotuloIda = idaEVolta ? "Buscando ida..." : "Buscando...";
      const relatorioIda = await buscarNoServidor({ origem, destino }, rotuloIda);
      renderizarPerna(idaEVolta ? `Ida: ${origem} → ${destino}` : `${origem} → ${destino}`, relatorioIda);
      salvarNoHistorico(origem, destino, "tap");

      if (idaEVolta) {
        const relatorioVolta = await buscarNoServidor({ origem: destino, destino: origem }, "Buscando volta...");
        renderizarPerna(`Volta: ${destino} → ${origem}`, relatorioVolta);
        promoverUltimaParaIdaEVolta(origem, destino, "tap");
      }
    } else {
      // SeatSpy: uma busca só já traz ida e volta (e consome um crédito só).
      const pernas = await buscarNoServidor(
        {
          fonte: "seatspy",
          companhia: programa,
          origem,
          destino,
          idaEVolta,
          tetos: {
            economica: tetoEmMilhas(inputTetoEconomica),
            premium: tetoEmMilhas(inputTetoPremium),
            executiva: tetoEmMilhas(inputTetoExecutiva),
          },
        },
        idaEVolta ? "Buscando ida e volta..." : "Buscando...",
      );
      for (const perna of pernas) renderizarPernaSecoes(perna.rotulo, perna.secoes);
      salvarNoHistorico(origem, destino, programa, idaEVolta);
    }

    resultado.hidden = false;
  } catch (err) {
    mostrarAviso(err.message || "Erro inesperado.");
  } finally {
    progresso.hidden = true;
    definirCarregando(false);
  }
}

function avisoDeRepeticao(programa, origem, destino, idaEVolta) {
  const trechos = idaEVolta
    ? [
        [origem, destino],
        [destino, origem],
      ]
    : [[origem, destino]];

  for (const [de, para] of trechos) {
    const anterior = buscaRecenteDe(de, para, programa);
    if (anterior && Date.now() - anterior.timestamp < TOLERANCIA_MS) {
      const confirmado = confirm(
        `Você já buscou ${de} → ${para} ${formatarTempoRelativo(anterior.timestamp)} ` +
          `(${formatarDataHora(anterior.timestamp)}), há menos de ${TOLERANCIA_DIAS} dias. Buscar de novo mesmo assim?`,
      );
      if (!confirmado) return false;
    }
  }
  return true;
}

form.addEventListener("submit", (evento) => {
  evento.preventDefault();
  const programa = selectPrograma.value;
  const origem = inputOrigem.value.trim().toUpperCase();
  const destino = inputDestino.value.trim().toUpperCase();
  const idaEVolta = checkboxIdaVolta.checked;
  if (!origem || !destino) {
    mostrarAviso("Preencha origem e destino.");
    return;
  }
  if (!avisoDeRepeticao(programa, origem, destino, idaEVolta)) return;
  iniciarBusca(programa, origem, destino, idaEVolta);
});
