const form = document.getElementById("form-busca");
const btnBuscar = document.getElementById("btn-buscar");
const inputOrigem = document.getElementById("origem");
const inputDestino = document.getElementById("destino");
const selectCabine = document.getElementById("cabine");
const checkboxIdaVolta = document.getElementById("ida-volta");
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

const MESES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const CABINE_LABEL = { 1: "Executiva", 2: "Econômica" };
const HISTORICO_KEY = "awardtool_historico";
const TOLERANCIA_DIAS = 5;
const TOLERANCIA_MS = TOLERANCIA_DIAS * 24 * 60 * 60 * 1000;

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

function salvarNoHistorico(origem, destino, cabine) {
  const historico = carregarHistorico();
  historico.push({ origem, destino, cabine: Number(cabine), timestamp: Date.now() });
  localStorage.setItem(HISTORICO_KEY, JSON.stringify(historico));
}

function buscaRecenteDe(origem, destino, cabine) {
  const historico = carregarHistorico();
  const doMesmoTrecho = historico.filter(
    (h) => h.origem === origem && h.destino === destino && Number(h.cabine) === Number(cabine),
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

function renderizarHistorico() {
  const historico = carregarHistorico().slice().sort((a, b) => b.timestamp - a.timestamp);
  listaHistorico.innerHTML = "";
  historicoVazio.hidden = historico.length > 0;

  for (const item of historico) {
    const linha = document.createElement("div");
    linha.className = "item-historico";

    const rota = document.createElement("span");
    rota.className = "item-historico-rota";
    rota.textContent = `${item.origem} → ${item.destino}`;

    const cabineTag = document.createElement("span");
    cabineTag.className = `item-historico-cabine ${item.cabine === 1 ? "cartao-executiva" : "cartao-economica"}`;
    cabineTag.textContent = CABINE_LABEL[item.cabine] || "";

    const quando = document.createElement("span");
    quando.className = "item-historico-quando";
    quando.textContent = `${formatarDataHora(item.timestamp)} · ${formatarTempoRelativo(item.timestamp)}`;

    linha.append(rota, cabineTag, quando);
    listaHistorico.appendChild(linha);
  }
}

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
  inputOrigem.disabled = carregando;
  inputDestino.disabled = carregando;
  selectCabine.disabled = carregando;
  checkboxIdaVolta.disabled = carregando;
}

function atualizarBarra(fracao) {
  barraPreenchida.style.width = `${Math.min(Math.round(fracao * 100), 100)}%`;
}

// Roda uma busca (uma perna) via SSE e resolve com o relatório final.
function buscarPerna(origem, destino, cabine, rotuloProgresso) {
  return new Promise(async (resolve, reject) => {
    progressoLabel.textContent = rotuloProgresso;
    progressoJanela.textContent = "";
    atualizarBarra(0);

    let resposta;
    try {
      resposta = await fetch("/api/buscar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origem, destino, cabine }),
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
        resolve(dado.relatorio);
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

async function iniciarBusca(origem, destino, cabine, idaEVolta) {
  limparAviso();
  definirCarregando(true);
  resultado.hidden = true;
  resultado.innerHTML = "";
  progresso.hidden = false;

  try {
    const rotuloIda = idaEVolta ? "Buscando ida..." : "Buscando...";
    const relatorioIda = await buscarPerna(origem, destino, cabine, rotuloIda);
    renderizarPerna(idaEVolta ? `Ida: ${origem} → ${destino}` : `${origem} → ${destino}`, relatorioIda);
    salvarNoHistorico(origem, destino, cabine);

    if (idaEVolta) {
      const relatorioVolta = await buscarPerna(destino, origem, cabine, "Buscando volta...");
      renderizarPerna(`Volta: ${destino} → ${origem}`, relatorioVolta);
      salvarNoHistorico(destino, origem, cabine);
    }

    resultado.hidden = false;
  } catch (err) {
    mostrarAviso(err.message || "Erro inesperado.");
  } finally {
    progresso.hidden = true;
    definirCarregando(false);
  }
}

function avisoDeRepeticao(origem, destino, cabine, idaEVolta) {
  const trechos = idaEVolta
    ? [
        [origem, destino],
        [destino, origem],
      ]
    : [[origem, destino]];

  for (const [de, para] of trechos) {
    const anterior = buscaRecenteDe(de, para, cabine);
    if (anterior && Date.now() - anterior.timestamp < TOLERANCIA_MS) {
      const confirmado = confirm(
        `Você já buscou ${de} → ${para} (${CABINE_LABEL[cabine]}) ${formatarTempoRelativo(anterior.timestamp)} ` +
          `(${formatarDataHora(anterior.timestamp)}), há menos de ${TOLERANCIA_DIAS} dias. Buscar de novo mesmo assim?`,
      );
      if (!confirmado) return false;
    }
  }
  return true;
}

form.addEventListener("submit", (evento) => {
  evento.preventDefault();
  const origem = inputOrigem.value.trim().toUpperCase();
  const destino = inputDestino.value.trim().toUpperCase();
  const cabine = selectCabine.value;
  const idaEVolta = checkboxIdaVolta.checked;
  if (!origem || !destino) {
    mostrarAviso("Preencha origem e destino.");
    return;
  }
  if (!avisoDeRepeticao(origem, destino, cabine, idaEVolta)) return;
  iniciarBusca(origem, destino, cabine, idaEVolta);
});
