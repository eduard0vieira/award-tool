const form = document.getElementById("login-form");
const userInput = document.getElementById("login-user");
const passInput = document.getElementById("login-pass");
const errorEl = document.getElementById("login-error");
const submitButton = form.querySelector('button[type="submit"]');

// Same rule as the server: only a path on this site, never an absolute URL.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  if (!userInput.value || !passInput.value) {
    showError("Preencha usuário e senha.");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Entrando...";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: userInput.value, pass: passInput.value }),
    });
    if (response.ok) {
      location.replace(nextPage());
      return;
    }
    const body = await response.json().catch(() => ({}));
    showError(body.error || "Não foi possível entrar.");
    passInput.select();
  } catch {
    showError("Não foi possível conectar ao servidor.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Entrar";
  }
});
