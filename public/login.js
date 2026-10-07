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

function showError(message, invalidInputs = []) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  for (const input of [userInput, passInput]) {
    if (invalidInputs.includes(input)) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "login-error");
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }
}

function clearError() {
  showError("");
  errorEl.hidden = true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const empty = [userInput, passInput].filter((input) => !input.value);
  if (empty.length > 0) {
    showError("Preencha usuário e senha.", empty);
    empty[0].focus();
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
    showError(body.error || "Não foi possível entrar.", [userInput, passInput]);
    passInput.select();
  } catch {
    showError("Não foi possível conectar ao servidor.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Entrar";
  }
});
