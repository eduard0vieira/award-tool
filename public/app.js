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

const MESES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

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

    if (idaEVolta) {
      const relatorioVolta = await buscarPerna(destino, origem, cabine, "Buscando volta...");
      renderizarPerna(`Volta: ${destino} → ${origem}`, relatorioVolta);
    }

    resultado.hidden = false;
  } catch (err) {
    mostrarAviso(err.message || "Erro inesperado.");
  } finally {
    progresso.hidden = true;
    definirCarregando(false);
  }
}

form.addEventListener("submit", (evento) => {
  evento.preventDefault();
  const origem = inputOrigem.value.trim().toUpperCase();
  const destino = inputDestino.value.trim().toUpperCase();
  const cabine = selectCabine.value;
  if (!origem || !destino) {
    mostrarAviso("Preencha origem e destino.");
    return;
  }
  iniciarBusca(origem, destino, cabine, checkboxIdaVolta.checked);
});
