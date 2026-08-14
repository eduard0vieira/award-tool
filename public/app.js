// Aba TAP (AwardTool).
const formTap = document.getElementById("form-busca-tap");
const inputTapOrigem = document.getElementById("tap-origem");
const inputTapDestino = document.getElementById("tap-destino");
const checkboxTapIdaVolta = document.getElementById("tap-ida-volta");
const avisoTap = document.getElementById("tap-aviso");
const inputTapTetoExecutiva = document.getElementById("tap-teto-executiva");
const inputTapTetoEconomica = document.getElementById("tap-teto-economica");
const filaTap = document.getElementById("tap-fila-buscas");

// Aba SeatSpy (Iberia, British, Air France, JetBlue, Cathay, Etihad, KLM,
// Qantas, Virgin Atlantic).
const formSeatspy = document.getElementById("form-busca-seatspy");
const selectSeatspyPrograma = document.getElementById("seatspy-programa");
const inputSeatspyOrigem = document.getElementById("seatspy-origem");
const inputSeatspyDestino = document.getElementById("seatspy-destino");
const checkboxSeatspyIdaVolta = document.getElementById("seatspy-ida-volta");
const inputSeatspyTetoEconomica = document.getElementById("seatspy-teto-economica");
const inputSeatspyTetoPremium = document.getElementById("seatspy-teto-premium");
const inputSeatspyTetoExecutiva = document.getElementById("seatspy-teto-executiva");
const inputSeatspyTetoPrimeira = document.getElementById("seatspy-teto-primeira");
const avisoSeatspy = document.getElementById("seatspy-aviso");
const filaSeatspy = document.getElementById("seatspy-fila-buscas");

// Aba American Airlines (uma cabine por busca).
const formAa = document.getElementById("form-busca-aa");
const inputAaOrigem = document.getElementById("aa-origem");
const inputAaDestino = document.getElementById("aa-destino");
const selectAaCabine = document.getElementById("aa-cabine");
const selectAaConexoes = document.getElementById("aa-conexoes");
const selectAaPassageiros = document.getElementById("aa-passageiros");
const inputAaTeto = document.getElementById("aa-teto");
const checkboxAaIdaVolta = document.getElementById("aa-ida-volta");
const avisoAa = document.getElementById("aa-aviso");
const filaAa = document.getElementById("aa-fila-buscas");

const formSmiles = document.getElementById("form-busca-smiles");
const inputSmilesOrigem = document.getElementById("smiles-origem");
const inputSmilesDestino = document.getElementById("smiles-destino");
const checkboxSmilesIdaVolta = document.getElementById("smiles-ida-volta");
const inputSmilesTetoEconomica = document.getElementById("smiles-teto-economica");
const inputSmilesTetoPremium = document.getElementById("smiles-teto-premium");
const inputSmilesTetoExecutiva = document.getElementById("smiles-teto-executiva");
const avisoSmiles = document.getElementById("smiles-aviso");
const filaSmiles = document.getElementById("smiles-fila-buscas");

// Aba LATAM (tarifas em dinheiro; ida e volta vêm na mesma busca).
const formLatam = document.getElementById("form-busca-latam");
const inputLatamOrigem = document.getElementById("latam-origem");
const inputLatamDestino = document.getElementById("latam-destino");
const inputLatamTeto = document.getElementById("latam-teto");
const checkboxLatamMenorTarifa = document.getElementById("latam-menor-tarifa");
const checkboxLatamConfirmarMilhas = document.getElementById("latam-confirmar-milhas");
const avisoLatam = document.getElementById("latam-aviso");
const filaLatam = document.getElementById("latam-fila-buscas");

const tplJob = document.getElementById("tpl-job");
const tplPerna = document.getElementById("tpl-perna");
const abasBtns = document.querySelectorAll(".aba-btn");
const painelTap = document.getElementById("painel-tap");
const painelSeatspy = document.getElementById("painel-seatspy");
const painelAa = document.getElementById("painel-aa");
const painelSmiles = document.getElementById("painel-smiles");
const painelLatam = document.getElementById("painel-latam");
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

const PROGRAMA_LABEL = {
  tap: "TAP",
  AA: "American Airlines",
  LATAM: "LATAM",
  SMILES: "Smiles",
  AF: "Air France",
  B6: "JetBlue",
  BA: "British Airways",
  CX: "Cathay Pacific",
  EY: "Etihad Airways",
  IB: "Iberia",
  KLM: "KLM",
  QF: "Qantas Airways",
  VIR: "Virgin Atlantic",
};

const CABINE_AA_LABEL = { economica: "Econômica", premium: "Premium Economy", executiva: "Executiva", primeira: "Primeira Classe" };
const CABINE_AA_COR = { economica: "cartao-economica", premium: "cartao-premium", executiva: "cartao-executiva", primeira: "cartao-primeira" };
// Registros antigos do histórico (antes do seletor de programa) eram sempre TAP.
const programaDe = (item) => item.programa || "tap";

// Cada aba (TAP/SeatSpy/Histórico) só troca de hidden — nada é destruído ou
// recriado, então os cards de busca em andamento numa aba continuam rodando
// e visíveis quando você volta pra ela, mesmo com outra aba aberta no meio.
abasBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    abasBtns.forEach((b) => b.classList.remove("ativo"));
    btn.classList.add("ativo");
    const aba = btn.dataset.aba;
    painelTap.hidden = aba !== "tap";
    painelSeatspy.hidden = aba !== "seatspy";
    painelAa.hidden = aba !== "aa";
    painelSmiles.hidden = aba !== "smiles";
    painelLatam.hidden = aba !== "latam";
    painelHistorico.hidden = aba !== "historico";
    if (aba === "historico") renderizarHistorico();
  });
});

function ativarAba(aba) {
  document.querySelector(`.aba-btn[data-aba="${aba}"]`).click();
}

function carregarHistorico() {
  try {
    return JSON.parse(localStorage.getItem(HISTORICO_KEY)) || [];
  } catch {
    return [];
  }
}

function salvarNoHistorico(origem, destino, programa, idaEVolta = false, extras = {}) {
  const historico = carregarHistorico();
  historico.push({ origem, destino, programa, idaEVolta, ...extras, timestamp: Date.now() });
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

// Preenche o formulário da aba certa (TAP, SeatSpy ou AA) com o trecho do
// histórico e troca pra ela.
function repetirBusca(item) {
  const programa = programaDe(item);
  if (programa === "tap") {
    inputTapOrigem.value = item.origem;
    inputTapDestino.value = item.destino;
    checkboxTapIdaVolta.checked = Boolean(item.idaEVolta);
    ativarAba("tap");
    inputTapOrigem.focus();
  } else if (programa === "SMILES") {
    inputSmilesOrigem.value = item.origem;
    inputSmilesDestino.value = item.destino;
    checkboxSmilesIdaVolta.checked = Boolean(item.idaEVolta);
    ativarAba("smiles");
    inputSmilesOrigem.focus();
  } else if (programa === "AA") {
    inputAaOrigem.value = item.origem;
    inputAaDestino.value = item.destino;
    if (item.cabine) selectAaCabine.value = item.cabine;
    // Buscas antigas não têm o campo — sem o padrão, o select ficaria em branco.
    selectAaPassageiros.value = String(item.passageiros || 1);
    checkboxAaIdaVolta.checked = Boolean(item.idaEVolta);
    ativarAba("aa");
    inputAaOrigem.focus();
  } else {
    selectSeatspyPrograma.value = programa;
    inputSeatspyOrigem.value = item.origem;
    inputSeatspyDestino.value = item.destino;
    checkboxSeatspyIdaVolta.checked = Boolean(item.idaEVolta);
    ativarAba("seatspy");
    inputSeatspyOrigem.focus();
  }
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

  // TAP traz Executiva + Econômica; SeatSpy traz Premium também; AA é uma
  // cabine por busca (a que ficou registrada no item).
  const cabines =
    programa === "tap"
      ? [["Executiva", "cartao-executiva"], ["Econômica", "cartao-economica"]]
      : programa === "LATAM"
        ? [["Econômica", "cartao-economica"]]
      : programa === "SMILES"
        ? [["Econômica", "cartao-economica"], ["Conforto", "cartao-premium"], ["Executiva", "cartao-executiva"]]
      : programa === "AA"
        ? [
            [
              // Passageiros só aparece quando é mais de um, pra distinguir do
              // registro normal do mesmo trecho.
              (CABINE_AA_LABEL[item.cabine] || "Cabine n/d") +
                (item.passageiros > 1 ? ` · ${item.passageiros} pax` : ""),
              CABINE_AA_COR[item.cabine] || "cartao-economica",
            ],
          ]
        : [["Econômica", "cartao-economica"], ["Premium", "cartao-premium"], ["Executiva", "cartao-executiva"], ["Primeira", "cartao-primeira"]];
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

function mostrarAviso(avisoEl, mensagem) {
  avisoEl.textContent = mensagem;
  avisoEl.hidden = false;
}

function limparAviso(avisoEl) {
  avisoEl.hidden = true;
  avisoEl.textContent = "";
}

function atualizarBarra(barraEl, fracao) {
  barraEl.style.width = `${Math.min(Math.round(fracao * 100), 100)}%`;
}

// Monta um card de busca (ver tpl-job) e já pendura na fila visual da aba
// (filaBuscasEl é a fila da aba TAP ou da aba SeatSpy). Cada busca tem seu
// próprio card, então várias rodam em paralelo sem uma atrapalhar o
// progresso/resultado da outra.
function criarCardJob(filaBuscasEl, tituloRota) {
  const fragmento = tplJob.content.cloneNode(true);
  const raiz = fragmento.querySelector(".job-busca");

  const card = {
    raiz,
    rotaEl: raiz.querySelector(".job-rota"),
    statusEl: raiz.querySelector(".job-status"),
    progressoEl: raiz.querySelector(".progresso"),
    progressoLabelEl: raiz.querySelector(".progresso-label"),
    progressoJanelaEl: raiz.querySelector(".progresso-janela"),
    barraEl: raiz.querySelector(".barra-preenchida"),
    avisoEl: raiz.querySelector(".aviso"),
    tetosEl: raiz.querySelector(".job-tetos"),
    subAbasEl: raiz.querySelector(".sub-abas"),
    subAbaBtnsEl: raiz.querySelectorAll(".sub-aba-btn"),
    resultadoEl: raiz.querySelector(".resultado"),
    subpainelUpgradeEl: raiz.querySelector(".subpainel-upgrade"),
    listaUpgradeEl: raiz.querySelector(".lista-upgrade"),
    upgradeVazioEl: raiz.querySelector(".upgrade-vazio"),
    acoesEl: raiz.querySelector(".job-acoes"),
    btnCopiarIdaEl: raiz.querySelector(".btn-copiar-ida"),
    btnCopiarVoltaEl: raiz.querySelector(".btn-copiar-volta"),
    btnMinimizarEl: raiz.querySelector(".btn-minimizar"),
    pernasParaUpgrade: [],
    // Datas por perna na ordem em que chegam (ida primeiro), pros botões de
    // copiar do cabeçalho — ver registrarPernaCopia.
    pernasCopia: [],
  };

  card.rotaEl.textContent = tituloRota;

  card.subAbaBtnsEl.forEach((btn) => {
    btn.addEventListener("click", () => {
      card.subAbaBtnsEl.forEach((b) => b.classList.remove("ativo"));
      btn.classList.add("ativo");
      const sub = btn.dataset.subaba;
      card.resultadoEl.hidden = sub !== "datas";
      card.subpainelUpgradeEl.hidden = sub !== "upgrade";
      if (sub === "upgrade") renderizarUpgrade(card);
    });
  });

  function definirStatus(texto, classe) {
    card.statusEl.textContent = texto;
    card.statusEl.className = `job-status ${classe}`;
  }
  card.definirStatus = definirStatus;

  card.btnCopiarIdaEl.addEventListener("click", () => copiarPerna(card, 0, card.btnCopiarIdaEl, "Copiar ida"));
  card.btnCopiarVoltaEl.addEventListener("click", () => copiarPerna(card, 1, card.btnCopiarVoltaEl, "Copiar volta"));

  // Minimizar recolhe tudo abaixo do cabeçalho — com várias buscas na fila,
  // dá pra fechar as prontas e continuar vendo as outras sem rolar tanto.
  card.minimizado = false;
  card.btnMinimizarEl.addEventListener("click", () => {
    card.minimizado = !card.minimizado;
    const abaAtiva = raiz.querySelector(".sub-aba-btn.ativo")?.dataset.subaba || "datas";
    card.resultadoEl.hidden = card.minimizado || abaAtiva !== "datas";
    card.subpainelUpgradeEl.hidden = card.minimizado || abaAtiva !== "upgrade";
    card.subAbasEl.hidden = card.minimizado;
    card.btnMinimizarEl.textContent = card.minimizado ? "Expandir" : "Minimizar";
  });

  filaBuscasEl.prepend(raiz);
  return card;
}

// Guarda as datas de uma perna (ida ou volta) pros botões de copiar do
// cabeçalho. `secoes` é sempre [{ rotulo, dias, texto }] — o mesmo formato
// que o SeatSpy já devolve e no qual TAP/AA são normalizados.
function registrarPernaCopia(card, secoes) {
  card.pernasCopia.push(secoes.filter((s) => s && s.dias?.length > 0));
}

// Texto no formato "Mmm YYYY: DD, DD" — o mesmo que o gerador de alertas
// espera colado nos campos de datas. Com mais de uma cabine, cada bloco vai
// rotulado pra não misturar.
function textoDaPerna(secoes) {
  if (!secoes || secoes.length === 0) return "";
  if (secoes.length === 1) return secoes[0].texto;
  return secoes.map((s) => `${s.rotulo}\n${s.texto}`).join("\n\n");
}

async function copiarPerna(card, indice, botao, rotuloOriginal) {
  const texto = textoDaPerna(card.pernasCopia[indice]);
  if (!texto) return;
  await navigator.clipboard.writeText(texto);
  botao.textContent = "Copiado!";
  setTimeout(() => (botao.textContent = rotuloOriginal), 1500);
}

// Mostra a barra de ações do cabeçalho: "Copiar volta" só aparece quando a
// busca tem duas pernas, e ambos os copiar só quando há datas de fato.
function atualizarAcoesCard(card) {
  card.acoesEl.hidden = false;
  card.btnCopiarIdaEl.hidden = !textoDaPerna(card.pernasCopia[0]);
  card.btnCopiarVoltaEl.hidden = !textoDaPerna(card.pernasCopia[1]);
}

// Roda uma busca via SSE e resolve com o resultado final: o relatório da
// perna (TAP) ou a lista de pernas (SeatSpy, que traz ida e volta juntas).
// Atualiza só o card dessa busca — outros cards em paralelo não são afetados.
function buscarNoServidor(card, corpo, rotuloProgresso) {
  return new Promise(async (resolve, reject) => {
    card.progressoLabelEl.textContent = rotuloProgresso;
    card.progressoJanelaEl.textContent = "";
    atualizarBarra(card.barraEl, 0);
    card.definirStatus("Na fila", "status-fila");

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
      if (dado.tipo === "fila") {
        card.definirStatus("Na fila", "status-fila");
      } else if (dado.tipo === "iniciou") {
        card.definirStatus("Buscando...", "status-buscando");
      } else if (dado.tipo === "progresso") {
        atualizarBarra(card.barraEl, dado.fracao);
      } else if (dado.tipo === "janela") {
        card.progressoJanelaEl.textContent = `Janela ${dado.atual} de ${dado.total} · ${dado.inicio} – ${dado.fim}`;
        card.avisoEl.hidden = true;
      } else if (dado.tipo === "aviso") {
        // Aviso transitório (ex.: cooldown de bloqueio de frequência do
        // AwardTool) — some sozinho quando a próxima janela/progresso chegar.
        card.avisoEl.textContent = dado.mensagem;
        card.avisoEl.hidden = !dado.mensagem;
      } else if (dado.tipo === "done") {
        fonte.close();
        resolve({
          resultado: dado.pernas || dado.secaoAA || dado.relatorio,
          planilhaUrl: dado.planilhaUrl,
          avisoParcial: dado.avisoParcial,
          tetosAplicados: dado.tetosAplicados,
          confirmacao: dado.confirmacao,
        });
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
  for (const { data, assentos } of dias) {
    const [ano, mes, dia] = data.split("-");
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    // assentos só existe no SeatSpy (vagas do voo cotado, como no hover deles).
    grupos.get(chave).push({ dia, assentos });
  }
  return Array.from(grupos.keys())
    .sort()
    .map((chave) => {
      const [ano, mesNum] = chave.split("-");
      return { titulo: `${MESES_PT[parseInt(mesNum, 10) - 1]} ${ano}`, dias: grupos.get(chave) };
    });
}

// Mesmo agrupamento por mês do formatarPorMes, mas mantendo o objeto do dia
// inteiro (não só o número), pra aba Upgrade poder mostrar os dois preços.
function agruparPorMesCompleto(itens) {
  const grupos = new Map();
  for (const item of itens) {
    const [ano, mes] = item.data.split("-");
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(item);
  }
  return Array.from(grupos.keys())
    .sort()
    .map((chave) => {
      const [ano, mesNum] = chave.split("-");
      return { titulo: `${MESES_PT[parseInt(mesNum, 10) - 1]} ${ano}`, itens: grupos.get(chave) };
    });
}

function textoDatasPorMes(datas) {
  return agruparPorMesCompleto(datas.map((data) => ({ data })))
    .map((g) => `${g.titulo}: ${g.itens.map((it) => it.data.split("-")[2]).join(", ")}`)
    .join("\n");
}

// Dias em que Executiva e Econômica têm disponibilidade no mesmo dia — é
// nesses dias que dá pra emitir a passagem em Econômica e pedir upgrade pra
// Executiva na TAP, saindo mais barato que emitir direto em Executiva.
function calcularUpgrade(diasExecutiva, diasEconomica) {
  const mapaEconomica = new Map((diasEconomica || []).map((d) => [d.data, d.valorK]));
  return (diasExecutiva || [])
    .filter((d) => mapaEconomica.has(d.data))
    .map((d) => ({ data: d.data, execK: d.valorK, econK: mapaEconomica.get(d.data) }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

function extrairDiasPorRotulo(secoes, rotulo) {
  return secoes.find((s) => s.rotulo === rotulo)?.dias || [];
}

function renderizarUpgrade(card) {
  const { listaUpgradeEl, upgradeVazioEl, pernasParaUpgrade } = card;
  listaUpgradeEl.innerHTML = "";
  upgradeVazioEl.hidden = pernasParaUpgrade.length > 0;
  if (pernasParaUpgrade.length === 0) return;

  for (const perna of pernasParaUpgrade) {
    const cruzadas = calcularUpgrade(perna.executiva, perna.economica);

    // <details> deixa cada perna colapsável — pernas sem cruzamento já
    // nascem fechadas, pra sobrar espaço pras que têm datas de verdade.
    const bloco = document.createElement("details");
    bloco.className = "perna-upgrade";
    bloco.open = cruzadas.length > 0;

    const cabecalho = document.createElement("summary");
    cabecalho.className = "coluna-cabecalho";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    cabecalho.appendChild(chevron);

    const titulo = document.createElement("h3");
    titulo.className = "upgrade-titulo";
    titulo.textContent = perna.rotulo;
    cabecalho.appendChild(titulo);

    if (cruzadas.length > 0) {
      const btnCopiar = document.createElement("button");
      btnCopiar.type = "button";
      btnCopiar.className = "btn-copiar";
      btnCopiar.textContent = "Copiar datas";
      btnCopiar.onclick = (evento) => {
        // Impede que o clique no botão (dentro do <summary>) também colapse o bloco.
        evento.preventDefault();
        evento.stopPropagation();
        navigator.clipboard.writeText(textoDatasPorMes(cruzadas.map((c) => c.data)));
        btnCopiar.textContent = "Copiado!";
        setTimeout(() => (btnCopiar.textContent = "Copiar datas"), 1500);
      };
      cabecalho.appendChild(btnCopiar);
    }
    bloco.appendChild(cabecalho);

    const resumo = document.createElement("p");
    resumo.className = "coluna-resumo";
    resumo.textContent =
      cruzadas.length > 0
        ? `${cruzadas.length} dia(s) com as duas cabines disponíveis.`
        : "Nenhum dia com Executiva e Econômica juntas nesse período.";
    bloco.appendChild(resumo);

    if (cruzadas.length > 0) {
      const lista = document.createElement("div");
      lista.className = "upgrade-lista";
      for (const grupo of agruparPorMesCompleto(cruzadas)) {
        const tituloMes = document.createElement("div");
        tituloMes.className = "mes-titulo";
        tituloMes.textContent = grupo.titulo;
        lista.appendChild(tituloMes);

        const linhas = document.createElement("div");
        linhas.className = "upgrade-linhas";
        for (const item of grupo.itens) {
          const linha = document.createElement("div");
          linha.className = "upgrade-linha";

          const dia = document.createElement("span");
          dia.className = "upgrade-dia";
          dia.textContent = item.data.split("-")[2];

          const exec = document.createElement("span");
          exec.className = "cartao cartao-executiva";
          exec.textContent = item.execK != null ? `Exec ${item.execK}K` : "Exec (preço n/d)";

          const econ = document.createElement("span");
          econ.className = "cartao cartao-economica";
          econ.textContent = item.econK != null ? `Econ ${item.econK}K` : "Econ (preço n/d)";

          linha.append(dia, exec, econ);
          linhas.appendChild(linha);
        }
        lista.appendChild(linhas);
      }
      bloco.appendChild(lista);
    }

    listaUpgradeEl.appendChild(bloco);
  }
}

function renderizarColuna(colunaEl, secao, corClasse) {
  const resumoEl = colunaEl.querySelector(".coluna-resumo");
  const cartoesEl = colunaEl.querySelector(".cartoes");
  const btnCopiar = colunaEl.querySelector(".btn-copiar");

  if (!secao.dias || secao.dias.length === 0) {
    resumoEl.textContent = "Sem disponibilidade nesse período.";
    btnCopiar.hidden = true;
    colunaEl.open = false;
    return;
  }
  colunaEl.open = true;

  // Fontes de milhas mostram "123K"; a LATAM manda unidade "BRL" e vira
  // "R$ 909". Quando o SeatSpy marca o dia como disponível sem informar o
  // valor (tarifa mista/parceira), menor/maior ficam null.
  const fmt = (v) => (secao.unidade === "BRL" ? `R$ ${v.toLocaleString("pt-BR")}` : `${v}K`);
  resumoEl.textContent =
    secao.menor != null
      ? `${fmt(secao.menor)}–${fmt(secao.maior)} · ${secao.dias.length} dia(s)`
      : `Preço não informado · ${secao.dias.length} dia(s)`;

  const grupos = formatarPorMes(secao.dias);
  cartoesEl.innerHTML = "";
  for (const grupo of grupos) {
    const tituloMes = document.createElement("div");
    tituloMes.className = "mes-titulo";
    tituloMes.textContent = grupo.titulo;
    cartoesEl.appendChild(tituloMes);

    const linha = document.createElement("div");
    linha.className = "linha-cartoes";
    for (const { dia, assentos } of grupo.dias) {
      const cartao = document.createElement("span");
      cartao.className = `cartao ${corClasse}`;
      cartao.textContent = dia;
      if (assentos > 0) {
        const vagas = document.createElement("small");
        vagas.className = "cartao-vagas";
        vagas.textContent = assentos;
        vagas.title = `${assentos} vaga(s)`;
        cartao.appendChild(vagas);
      }
      linha.appendChild(cartao);
    }
    cartoesEl.appendChild(linha);
  }

  btnCopiar.hidden = false;
  btnCopiar.onclick = (evento) => {
    evento.preventDefault();
    evento.stopPropagation();
    navigator.clipboard.writeText(secao.texto);
    btnCopiar.textContent = "Copiado!";
    setTimeout(() => (btnCopiar.textContent = "Copiar"), 1500);
  };
}

function renderizarPerna(destinoEl, rotulo, relatorio) {
  const fragmento = tplPerna.content.cloneNode(true);
  const raiz = fragmento.querySelector(".perna");
  raiz.querySelector(".perna-titulo").textContent = rotulo;
  renderizarColuna(raiz.querySelector(".coluna-executiva"), relatorio.executivas, "cartao-executiva");
  renderizarColuna(raiz.querySelector(".coluna-economica"), relatorio.economicas, "cartao-economica");
  destinoEl.appendChild(raiz);
}

// Versão do SeatSpy: as cabines vêm do servidor (Econômica/Premium/Executiva),
// então as colunas são montadas dinamicamente em vez de vir do template.
function renderizarPernaSecoes(destinoEl, rotulo, secoes) {
  const raiz = document.createElement("div");
  raiz.className = "perna";

  const titulo = document.createElement("h2");
  titulo.className = "perna-titulo";
  titulo.textContent = rotulo;
  raiz.appendChild(titulo);

  const colunas = document.createElement("div");
  colunas.className = "colunas colunas-3";
  for (const secao of secoes) {
    const col = document.createElement("details");
    col.className = "coluna";
    col.innerHTML = `
      <summary class="coluna-cabecalho">
        <span class="chevron" aria-hidden="true">›</span>
        <h3></h3>
        <button type="button" class="btn-copiar">Copiar</button>
      </summary>
      <p class="coluna-resumo"></p>
      <div class="cartoes"></div>`;
    col.querySelector("h3").textContent = secao.rotulo;
    renderizarColuna(col, secao, secao.corClasse);
    colunas.appendChild(col);
  }
  raiz.appendChild(colunas);
  destinoEl.appendChild(raiz);
}

function tetoEmMilhas(input) {
  const valor = parseFloat(input.value);
  return Number.isFinite(valor) && valor > 0 ? Math.round(valor * 1000) : null;
}

// Cada chamada cria seu próprio card (ver criarCardJob) e roda de forma
// independente — várias buscas podem estar em andamento ao mesmo tempo
// (modo agents), cada uma numa sessão própria do pool no servidor.
async function iniciarBuscaTap(origem, destino, idaEVolta, tetos) {
  const seta = idaEVolta ? "⇄" : "→";
  const card = criarCardJob(filaTap, `TAP: ${origem} ${seta} ${destino}`);
  const avisosParciais = [];

  try {
    const rotuloIda = idaEVolta ? "Buscando ida..." : "Buscando...";
    const { resultado: relatorioIda, avisoParcial: avisoIda, tetosAplicados } = await buscarNoServidor(card, { origem, destino, tetos }, rotuloIda);
    if (tetosAplicados) {
      card.tetosEl.textContent =
        `Teto aplicado: Executiva ${tetosAplicados.executivaK}K · Econômica ${tetosAplicados.economicaK}K`;
      card.tetosEl.hidden = false;
    }
    if (avisoIda) avisosParciais.push(avisoIda);
    const rotuloPernaIda = idaEVolta ? `Ida: ${origem} → ${destino}` : `${origem} → ${destino}`;
    renderizarPerna(card.resultadoEl, rotuloPernaIda, relatorioIda);
    card.pernasParaUpgrade.push({
      rotulo: rotuloPernaIda,
      executiva: relatorioIda.executivas.dias,
      economica: relatorioIda.economicas.dias,
    });
    registrarPernaCopia(card, [
      { rotulo: "Executiva", ...relatorioIda.executivas },
      { rotulo: "Econômica", ...relatorioIda.economicas },
    ]);
    salvarNoHistorico(origem, destino, "tap");

    let relatorioVolta = null;
    if (idaEVolta) {
      const { resultado, avisoParcial: avisoVolta } = await buscarNoServidor(
        card,
        { origem: destino, destino: origem, tetos },
        "Buscando volta...",
      );
      relatorioVolta = resultado;
      if (avisoVolta) avisosParciais.push(avisoVolta);
      const rotuloPernaVolta = `Volta: ${destino} → ${origem}`;
      renderizarPerna(card.resultadoEl, rotuloPernaVolta, relatorioVolta);
      card.pernasParaUpgrade.push({
        rotulo: rotuloPernaVolta,
        executiva: relatorioVolta.executivas.dias,
        economica: relatorioVolta.economicas.dias,
      });
      registrarPernaCopia(card, [
        { rotulo: "Executiva", ...relatorioVolta.executivas },
        { rotulo: "Econômica", ...relatorioVolta.economicas },
      ]);
      promoverUltimaParaIdaEVolta(origem, destino, "tap");
    }

    card.definirStatus("Pronto", "status-pronto");
    card.resultadoEl.hidden = false;
    card.subAbasEl.hidden = false;
    if (avisosParciais.length > 0) {
      card.avisoEl.textContent = avisosParciais.join(" ");
      card.avisoEl.hidden = false;
    }
    atualizarAcoesCard(card);
    mostrarBotoesAlerta(card, "tap", origem, destino, [
      { classe: "Executiva", secaoIda: relatorioIda.executivas, secaoVolta: relatorioVolta?.executivas },
      { classe: "Econômica", secaoIda: relatorioIda.economicas, secaoVolta: relatorioVolta?.economicas },
    ]);
  } catch (err) {
    card.definirStatus("Erro", "status-erro");
    card.avisoEl.textContent = err.message || "Erro inesperado.";
    card.avisoEl.hidden = false;
  } finally {
    card.progressoEl.hidden = true;
  }
}

// Idem, mas pro SeatSpy: uma busca só já traz ida e volta juntas (e consome
// um crédito só), então não tem o passo separado de "buscar volta" da TAP.
async function iniciarBuscaSeatspy(programa, origem, destino, idaEVolta) {
  const rotuloPrograma = PROGRAMA_LABEL[programa] || programa;
  const seta = idaEVolta ? "⇄" : "→";
  const card = criarCardJob(filaSeatspy, `${rotuloPrograma}: ${origem} ${seta} ${destino}`);

  try {
    const { resultado: pernas } = await buscarNoServidor(
      card,
      {
        fonte: "seatspy",
        companhia: programa,
        origem,
        destino,
        idaEVolta,
        tetos: {
          economica: tetoEmMilhas(inputSeatspyTetoEconomica),
          premium: tetoEmMilhas(inputSeatspyTetoPremium),
          executiva: tetoEmMilhas(inputSeatspyTetoExecutiva),
        },
      },
      idaEVolta ? "Buscando ida e volta..." : "Buscando...",
    );
    for (const perna of pernas) {
      renderizarPernaSecoes(card.resultadoEl, perna.rotulo, perna.secoes);
      registrarPernaCopia(card, perna.secoes);
      card.pernasParaUpgrade.push({
        rotulo: perna.rotulo,
        executiva: extrairDiasPorRotulo(perna.secoes, "Executiva"),
        economica: extrairDiasPorRotulo(perna.secoes, "Econômica"),
      });
    }
    salvarNoHistorico(origem, destino, programa, idaEVolta);

    card.definirStatus("Pronto", "status-pronto");
    card.resultadoEl.hidden = false;
    card.subAbasEl.hidden = false;
    // pernas[0] = ida, pernas[1] = volta (quando ida e volta). O rótulo
    // "Premium" do SeatSpy vira "Premium Economy" na nomenclatura do portal.
    atualizarAcoesCard(card);
    const secaoDe = (perna, rotulo) => perna?.secoes.find((s) => s.rotulo === rotulo);
    mostrarBotoesAlerta(card, programa, origem, destino, [
      { classe: "Econômica", secaoIda: secaoDe(pernas[0], "Econômica"), secaoVolta: secaoDe(pernas[1], "Econômica") },
      { classe: "Premium Economy", secaoIda: secaoDe(pernas[0], "Premium"), secaoVolta: secaoDe(pernas[1], "Premium") },
      { classe: "Executiva", secaoIda: secaoDe(pernas[0], "Executiva"), secaoVolta: secaoDe(pernas[1], "Executiva") },
      { classe: "Primeira Classe", secaoIda: secaoDe(pernas[0], "Primeira Classe"), secaoVolta: secaoDe(pernas[1], "Primeira Classe") },
    ]);
  } catch (err) {
    card.definirStatus("Erro", "status-erro");
    card.avisoEl.textContent = err.message || "Erro inesperado.";
    card.avisoEl.hidden = false;
  } finally {
    card.progressoEl.hidden = true;
  }
}

// Link da planilha daquela busca (uma planilha nova por busca — ver
// planilha.ts). Vira um bloco clicável no card, junto do resultado.
function mostrarLinkPlanilha(card, url, rotulo) {
  if (!url) return;
  const bloco = document.createElement("p");
  bloco.className = "link-planilha";
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `📊 Planilha da ${rotulo}`;
  bloco.append(link);
  card.raiz.appendChild(bloco);
}

// Smiles: uma direção por job (o endpoint é de ida simples), com as três
// cabines juntas — o front pede a volta como segundo job, igual à AA.
async function iniciarBuscaSmiles(origem, destino, tetos, idaEVolta) {
  const seta = idaEVolta ? "⇄" : "→";
  const card = criarCardJob(filaSmiles, `Smiles: ${origem} ${seta} ${destino}`);
  const avisosParciais = [];
  let urlPlanilhaVolta = null;
  const corpoBase = { fonte: "smiles", tetos };

  try {
    const { resultado: pernasIda, avisoParcial: avisoIda, planilhaUrl: planilhaIda } = await buscarNoServidor(
      card,
      { ...corpoBase, origem, destino },
      idaEVolta ? "Buscando ida..." : "Buscando...",
    );
    if (avisoIda) avisosParciais.push(avisoIda);
    const rotuloIda = idaEVolta ? `Ida: ${origem} → ${destino}` : `${origem} → ${destino}`;
    renderizarPernaSecoes(card.resultadoEl, rotuloIda, pernasIda[0].secoes);
    registrarPernaCopia(card, pernasIda[0].secoes);
    salvarNoHistorico(origem, destino, "SMILES", false);

    let pernasVolta = null;
    if (idaEVolta) {
      const { resultado, avisoParcial: avisoVolta, planilhaUrl: planilhaVolta } = await buscarNoServidor(
        card,
        { ...corpoBase, origem: destino, destino: origem },
        "Buscando volta...",
      );
      pernasVolta = resultado;
      if (avisoVolta) avisosParciais.push(avisoVolta);
      urlPlanilhaVolta = planilhaVolta;
      renderizarPernaSecoes(card.resultadoEl, `Volta: ${destino} → ${origem}`, pernasVolta[0].secoes);
      registrarPernaCopia(card, pernasVolta[0].secoes);
      promoverUltimaParaIdaEVolta(origem, destino, "SMILES");
    }

    card.definirStatus("Pronto", "status-pronto");
    card.resultadoEl.hidden = false;
    if (avisosParciais.length > 0) {
      card.avisoEl.textContent = avisosParciais.join(" ");
      card.avisoEl.hidden = false;
    }
    atualizarAcoesCard(card);
    mostrarLinkPlanilha(card, planilhaIda, idaEVolta ? "ida" : "busca");
    mostrarLinkPlanilha(card, urlPlanilhaVolta, "volta");

    const secaoDe = (pernas, rotulo) => pernas?.[0]?.secoes.find((s) => s.rotulo === rotulo);
    mostrarBotoesAlerta(card, "SMILES", origem, destino, [
      { classe: "Econômica", secaoIda: secaoDe(pernasIda, "Econômica"), secaoVolta: secaoDe(pernasVolta, "Econômica") },
      { classe: "Premium Economy", secaoIda: secaoDe(pernasIda, "Conforto"), secaoVolta: secaoDe(pernasVolta, "Conforto") },
      { classe: "Executiva", secaoIda: secaoDe(pernasIda, "Executiva"), secaoVolta: secaoDe(pernasVolta, "Executiva") },
    ]);
  } catch (err) {
    card.definirStatus("Erro", "status-erro");
    card.avisoEl.textContent = err.message || "Erro inesperado.";
    card.avisoEl.hidden = false;
  } finally {
    card.progressoEl.hidden = true;
  }
}

// ─── Geração de alertas (conexão com o vcc-alertas-portal) ────────────────
// Depois que uma busca termina, cada cabine com disponibilidade vira um
// botão "Gerar alerta": o servidor renderiza o card oficial do portal e a
// legenda de WhatsApp, e devolve as imagens prontas pra encaminhar no grupo.

// Junta o menor/maior das duas direções (a legenda mostra uma faixa só).
function faixaDeMilhas(secaoIda, secaoVolta) {
  const menores = [secaoIda?.menor, secaoVolta?.menor].filter((v) => v != null);
  const maiores = [secaoIda?.maior, secaoVolta?.maior].filter((v) => v != null);
  return {
    menorK: menores.length ? Math.min(...menores) : null,
    maiorK: maiores.length ? Math.max(...maiores) : null,
  };
}

function temDias(secao) {
  return (secao?.dias?.length || 0) > 0;
}

// opcoes: [{ classe, secaoIda, secaoVolta }] — só viram botão as cabines com
// alguma disponibilidade.
function mostrarBotoesAlerta(card, fonte, origem, destino, opcoes) {
  const comDados = opcoes.filter((o) => temDias(o.secaoIda) || temDias(o.secaoVolta));
  if (comDados.length === 0) return;

  const barra = document.createElement("div");
  barra.className = "alerta-acoes";
  const rotuloBarra = document.createElement("span");
  rotuloBarra.className = "alerta-rotulo";
  rotuloBarra.textContent = "Alerta pro grupo:";
  barra.appendChild(rotuloBarra);

  for (const opcao of comDados) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-alerta";
    btn.textContent = `📢 ${opcao.classe}`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "⏳ Gerando...";
      try {
        const resposta = await fetch("/api/alerta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fonte,
            origem,
            destino,
            classe: opcao.classe,
            ...faixaDeMilhas(opcao.secaoIda, opcao.secaoVolta),
            textoIda: temDias(opcao.secaoIda) ? opcao.secaoIda.texto : "",
            textoVolta: temDias(opcao.secaoVolta) ? opcao.secaoVolta.texto : "",
          }),
        });
        const corpo = await resposta.json();
        if (!resposta.ok) throw new Error(corpo.erro || "Falha ao gerar o alerta.");
        mostrarAlertaGerado(card, corpo);
        btn.textContent = `✓ ${opcao.classe}`;
      } catch (err) {
        btn.textContent = `📢 ${opcao.classe}`;
        card.avisoEl.textContent = err.message || "Falha ao gerar o alerta.";
        card.avisoEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    barra.appendChild(btn);
  }
  card.raiz.appendChild(barra);
}

// Monta um bloco "imagens + legenda + copiar" — usado tanto pro alerta
// principal quanto pro complementar de combinações.
function blocoDeAlerta(titulo, imagens, legenda) {
  const bloco = document.createElement("div");
  bloco.className = "alerta-resultado";

  if (titulo) {
    const tituloEl = document.createElement("div");
    tituloEl.className = "alerta-titulo";
    tituloEl.textContent = titulo;
    bloco.appendChild(tituloEl);
  }

  const galeria = document.createElement("div");
  galeria.className = "alerta-galeria";
  for (const url of imagens) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.download = url.split("/").pop();
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Imagem do alerta";
    link.appendChild(img);
    galeria.appendChild(link);
  }
  bloco.appendChild(galeria);

  const legendaEl = document.createElement("pre");
  legendaEl.className = "alerta-legenda";
  legendaEl.textContent = legenda;
  bloco.appendChild(legendaEl);

  const btnCopiar = document.createElement("button");
  btnCopiar.type = "button";
  btnCopiar.className = "btn-copiar";
  btnCopiar.textContent = "Copiar legenda";
  btnCopiar.addEventListener("click", () => {
    navigator.clipboard.writeText(legenda);
    btnCopiar.textContent = "Copiado!";
    setTimeout(() => (btnCopiar.textContent = "Copiar legenda"), 1500);
  });
  bloco.appendChild(btnCopiar);

  return bloco;
}

function mostrarAlertaGerado(card, { imagens, legenda, imagemCombo, legendaCombo }) {
  // Combos só vem quando as datas de ida e volta se cruzam — é o alerta que
  // vocês mandam depois do principal, com as combinações já prontas.
  const temCombo = Boolean(imagemCombo);
  card.raiz.appendChild(blocoDeAlerta(temCombo ? "Alerta principal" : "", imagens, legenda));
  if (temCombo) {
    card.raiz.appendChild(blocoDeAlerta("Combinações ida + volta", [imagemCombo], legendaCombo || ""));
  }
}

// AA: uma cabine por busca, cada direção é um job próprio (como na TAP).
// Sem aba Upgrade (não há cruzamento de cabines numa busca de cabine única).
async function iniciarBuscaAA(origem, destino, cabine, maxConexoes, tetoK, idaEVolta, passageiros = 1) {
  const seta = idaEVolta ? "⇄" : "→";
  const rotuloCabine = CABINE_AA_LABEL[cabine] || cabine;
  // O caso comum é 1 passageiro; só polui o título do card quando for mais.
  const rotuloPax = passageiros > 1 ? `, ${passageiros} passageiros` : "";
  const card = criarCardJob(
    filaAa,
    `American Airlines (${rotuloCabine}${rotuloPax}): ${origem} ${seta} ${destino}`,
  );
  const avisosParciais = [];
  const corpoBase = { fonte: "aa", cabine, maxConexoes, teto: tetoK, passageiros };

  try {
    const rotuloIda = idaEVolta ? "Buscando ida..." : "Buscando...";
    const { resultado: secaoIda, avisoParcial: avisoIda } = await buscarNoServidor(
      card,
      { ...corpoBase, origem, destino },
      rotuloIda,
    );
    if (avisoIda) avisosParciais.push(avisoIda);
    const rotuloPernaIda = idaEVolta ? `Ida: ${origem} → ${destino}` : `${origem} → ${destino}`;
    renderizarPernaSecoes(card.resultadoEl, rotuloPernaIda, [{ ...secaoIda, corClasse: CABINE_AA_COR[cabine] }]);
    registrarPernaCopia(card, [secaoIda]);
    salvarNoHistorico(origem, destino, "AA", false, { cabine, passageiros });

    let secaoVolta = null;
    if (idaEVolta) {
      const { resultado, avisoParcial: avisoVolta } = await buscarNoServidor(
        card,
        { ...corpoBase, origem: destino, destino: origem },
        "Buscando volta...",
      );
      secaoVolta = resultado;
      if (avisoVolta) avisosParciais.push(avisoVolta);
      renderizarPernaSecoes(card.resultadoEl, `Volta: ${destino} → ${origem}`, [
        { ...secaoVolta, corClasse: CABINE_AA_COR[cabine] },
      ]);
      registrarPernaCopia(card, [secaoVolta]);
      promoverUltimaParaIdaEVolta(origem, destino, "AA");
    }

    card.definirStatus("Pronto", "status-pronto");
    card.resultadoEl.hidden = false;
    if (avisosParciais.length > 0) {
      card.avisoEl.textContent = avisosParciais.join(" ");
      card.avisoEl.hidden = false;
    }
    atualizarAcoesCard(card);
    mostrarBotoesAlerta(card, "aa", origem, destino, [
      { classe: CABINE_AA_LABEL[cabine] || cabine, secaoIda, secaoVolta },
    ]);
  } catch (err) {
    card.definirStatus("Erro", "status-erro");
    card.avisoEl.textContent = err.message || "Erro inesperado.";
    card.avisoEl.hidden = false;
  } finally {
    card.progressoEl.hidden = true;
  }
}

// Mostra o resultado da confirmação em milhas: o par de datas mais barato,
// o total e o print de cada perna (o mesmo enquadramento do alerta).
function mostrarConfirmacaoMilhas(card, c) {
  const bloco = document.createElement("div");
  bloco.className = "alerta-resultado";

  const titulo = document.createElement("div");
  titulo.className = "alerta-titulo";
  titulo.textContent = "Confirmado em milhas";
  bloco.appendChild(titulo);

  const resumo = document.createElement("p");
  resumo.className = "confirmacao-resumo";
  const fmt = (n) => n.toLocaleString("pt-BR");
  resumo.innerHTML =
    `<strong>${fmt(c.totalMilhas)} milhas + R$ ${c.totalTaxas.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</strong>` +
    ` &middot; ida ${c.ida.data} &middot; volta ${c.volta.data}`;
  bloco.appendChild(resumo);

  // Detalhe de cada perna em texto — é o que garante o alerta mesmo quando o
  // print falha (a imagem é o passo mais frágil do fluxo).
  const detalhe = document.createElement("p");
  detalhe.className = "confirmacao-detalhe";
  detalhe.textContent =
    `Ida ${c.ida.data}: ${fmt(c.ida.milhas)} milhas + R$ ${c.ida.taxas} · ${c.ida.voo}\n` +
    `Volta ${c.volta.data}: ${fmt(c.volta.milhas)} milhas + R$ ${c.volta.taxas} · ${c.volta.voo}`;
  bloco.appendChild(detalhe);

  // Um print só, com ida e volta juntas — é ele que vai pro grupo. Pode não
  // existir se a captura falhou; nesse caso mostra as imagens por perna que
  // tenham sobrado, e se nem essas houver, fica só o texto acima.
  const imagens = c.imagem ? [c.imagem] : [c.ida.imagem, c.volta.imagem].filter(Boolean);
  if (imagens.length > 0) {
    const galeria = document.createElement("div");
    galeria.className = "alerta-galeria confirmacao-galeria";
    for (const src of imagens) {
      const link = document.createElement("a");
      link.href = src;
      link.target = "_blank";
      link.download = src.split("/").pop();
      link.title = `${c.ida.voo} | ${c.volta.voo}`;
      const img = document.createElement("img");
      img.src = src;
      img.alt = "Ida e volta confirmadas em milhas";
      link.appendChild(img);
      galeria.appendChild(link);
    }
    bloco.appendChild(galeria);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-copiar";
  btn.textContent = "Copiar resumo";
  const texto =
    `${origemDestinoDe(card)}\n` +
    `Ida ${c.ida.data}: ${fmt(c.ida.milhas)} milhas + R$ ${c.ida.taxas} (${c.ida.voo})\n` +
    `Volta ${c.volta.data}: ${fmt(c.volta.milhas)} milhas + R$ ${c.volta.taxas} (${c.volta.voo})\n` +
    `Total: ${fmt(c.totalMilhas)} milhas + R$ ${c.totalTaxas}`;
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(texto);
    btn.textContent = "Copiado!";
    setTimeout(() => (btn.textContent = "Copiar resumo"), 1500);
  });
  bloco.appendChild(btn);

  card.raiz.appendChild(bloco);
}

const origemDestinoDe = (card) => card.rotaEl.textContent || "";

// LATAM: uma busca só devolve ida e volta (o calendário traz as duas
// direções). Sem botão de alerta: o card do portal fala em milhas e ainda não
// sabe exibir tarifa em reais.
async function iniciarBuscaLatam(origem, destino, tetos, confirmarMilhas) {
  const card = criarCardJob(filaLatam, `LATAM: ${origem} ⇄ ${destino}`);

  try {
    const { resultado: pernas, avisoParcial, confirmacao } = await buscarNoServidor(
      card,
      { fonte: "latam", origem, destino, tetos, confirmarMilhas, margemIdaReais: 100, margemVoltaReais: 300 },
      "Buscando ida e volta...",
    );
    for (const perna of pernas) {
      renderizarPernaSecoes(card.resultadoEl, perna.rotulo, perna.secoes);
      registrarPernaCopia(card, perna.secoes);
    }
    if (confirmacao) mostrarConfirmacaoMilhas(card, confirmacao);
    salvarNoHistorico(origem, destino, "LATAM", true);

    card.definirStatus("Pronto", "status-pronto");
    card.resultadoEl.hidden = false;
    if (avisoParcial) {
      card.avisoEl.textContent = avisoParcial;
      card.avisoEl.hidden = false;
    }
    atualizarAcoesCard(card);
  } catch (err) {
    card.definirStatus("Erro", "status-erro");
    card.avisoEl.textContent = err.message || "Erro inesperado.";
    card.avisoEl.hidden = false;
  } finally {
    card.progressoEl.hidden = true;
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

formTap.addEventListener("submit", (evento) => {
  evento.preventDefault();
  limparAviso(avisoTap);
  const origem = inputTapOrigem.value.trim().toUpperCase();
  const destino = inputTapDestino.value.trim().toUpperCase();
  const idaEVolta = checkboxTapIdaVolta.checked;
  if (!origem || !destino) {
    mostrarAviso(avisoTap, "Preencha origem e destino.");
    return;
  }
  if (!avisoDeRepeticao("tap", origem, destino, idaEVolta)) return;
  const emK = (input) => {
    const v = parseFloat(input.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  iniciarBuscaTap(origem, destino, idaEVolta, {
    executiva: emK(inputTapTetoExecutiva),
    economica: emK(inputTapTetoEconomica),
  });
});

formLatam.addEventListener("submit", (evento) => {
  evento.preventDefault();
  limparAviso(avisoLatam);
  const origem = inputLatamOrigem.value.trim().toUpperCase();
  const destino = inputLatamDestino.value.trim().toUpperCase();
  if (!origem || !destino) {
    mostrarAviso(avisoLatam, "Preencha origem e destino.");
    return;
  }
  const teto = parseFloat(inputLatamTeto.value);
  // Buscar na LATAM é grátis, então não tem o aviso de repetição das fontes pagas.
  iniciarBuscaLatam(
    origem,
    destino,
    {
      reais: Number.isFinite(teto) && teto > 0 ? teto : null,
      somenteMenorTarifa: checkboxLatamMenorTarifa.checked,
    },
    checkboxLatamConfirmarMilhas.checked,
  );
});

formAa.addEventListener("submit", (evento) => {
  evento.preventDefault();
  limparAviso(avisoAa);
  const origem = inputAaOrigem.value.trim().toUpperCase();
  const destino = inputAaDestino.value.trim().toUpperCase();
  if (!origem || !destino) {
    mostrarAviso(avisoAa, "Preencha origem e destino.");
    return;
  }
  const cabine = selectAaCabine.value;
  const maxConexoes = selectAaConexoes.value === "" ? null : Number(selectAaConexoes.value);
  const tetoK = parseFloat(inputAaTeto.value);
  const passageiros = Number(selectAaPassageiros.value) || 1;
  // Buscar na AA é grátis, então não tem o aviso de repetição em N dias das
  // fontes pagas.
  iniciarBuscaAA(
    origem,
    destino,
    cabine,
    maxConexoes,
    Number.isFinite(tetoK) && tetoK > 0 ? tetoK * 1000 : null,
    checkboxAaIdaVolta.checked,
    passageiros,
  );
});

formSmiles.addEventListener("submit", (evento) => {
  evento.preventDefault();
  limparAviso(avisoSmiles);
  const origem = inputSmilesOrigem.value.trim().toUpperCase();
  const destino = inputSmilesDestino.value.trim().toUpperCase();
  if (!origem || !destino) {
    mostrarAviso(avisoSmiles, "Preencha origem e destino.");
    return;
  }
  // Buscar no Smiles é grátis: sem o aviso de repetição das fontes pagas.
  iniciarBuscaSmiles(
    origem,
    destino,
    {
      economica: tetoEmMilhas(inputSmilesTetoEconomica),
      premium: tetoEmMilhas(inputSmilesTetoPremium),
      executiva: tetoEmMilhas(inputSmilesTetoExecutiva),
    },
    checkboxSmilesIdaVolta.checked,
  );
});

formSeatspy.addEventListener("submit", (evento) => {
  evento.preventDefault();
  limparAviso(avisoSeatspy);
  const programa = selectSeatspyPrograma.value;
  const origem = inputSeatspyOrigem.value.trim().toUpperCase();
  const destino = inputSeatspyDestino.value.trim().toUpperCase();
  const idaEVolta = checkboxSeatspyIdaVolta.checked;
  if (!origem || !destino) {
    mostrarAviso(avisoSeatspy, "Preencha origem e destino.");
    return;
  }
  if (!avisoDeRepeticao(programa, origem, destino, idaEVolta)) return;
  iniciarBuscaSeatspy(programa, origem, destino, idaEVolta);
});
