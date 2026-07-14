const form = document.getElementById("form-busca");
const btnBuscar = document.getElementById("btn-buscar");
const inputOrigem = document.getElementById("origem");
const inputDestino = document.getElementById("destino");
const selectCabine = document.getElementById("cabine");
const aviso = document.getElementById("aviso");
const progresso = document.getElementById("progresso");
const logEl = document.getElementById("log");
const resultado = document.getElementById("resultado");
const saidaExecutivas = document.getElementById("saida-executivas");
const saidaEconomicas = document.getElementById("saida-economicas");
const btnVolta = document.getElementById("btn-volta");

function mostrarAviso(mensagem) {
  aviso.textContent = mensagem;
  aviso.hidden = false;
}

function limparAviso() {
  aviso.hidden = true;
  aviso.textContent = "";
}

function adicionarLog(mensagem) {
  logEl.textContent += mensagem + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function definirCarregando(carregando) {
  btnBuscar.disabled = carregando;
  inputOrigem.disabled = carregando;
  inputDestino.disabled = carregando;
  selectCabine.disabled = carregando;
}

async function iniciarBusca(origem, destino, cabine) {
  limparAviso();
  definirCarregando(true);
  resultado.hidden = true;
  progresso.hidden = false;
  logEl.textContent = "";

  let resposta;
  try {
    resposta = await fetch("/api/buscar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origem, destino, cabine }),
    });
  } catch (err) {
    mostrarAviso("Não foi possível conectar ao servidor.");
    definirCarregando(false);
    return;
  }

  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    mostrarAviso(corpo.erro || "Erro ao iniciar a busca.");
    definirCarregando(false);
    return;
  }

  const { jobId } = await resposta.json();
  const fonte = new EventSource(`/api/buscar/${jobId}/eventos`);

  fonte.onmessage = (evento) => {
    const dado = JSON.parse(evento.data);

    if (dado.tipo === "log") {
      adicionarLog(dado.mensagem);
    } else if (dado.tipo === "done") {
      adicionarLog("Busca concluída!");
      saidaExecutivas.textContent = dado.relatorio.executivas;
      saidaEconomicas.textContent = dado.relatorio.economicas;
      resultado.hidden = false;
      btnVolta.textContent = `Buscar a volta (${destino} → ${origem})`;
      btnVolta.onclick = () => {
        inputOrigem.value = destino;
        inputDestino.value = origem;
        iniciarBusca(destino, origem, selectCabine.value);
      };
      definirCarregando(false);
      fonte.close();
    } else if (dado.tipo === "erro") {
      mostrarAviso(dado.mensagem);
      definirCarregando(false);
      fonte.close();
    }
  };

  fonte.onerror = () => {
    fonte.close();
    definirCarregando(false);
  };
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
  iniciarBusca(origem, destino, cabine);
});
