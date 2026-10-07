const form = document.getElementById("login-form");
const userInput = document.getElementById("login-user");
const passInput = document.getElementById("login-pass");
const errorEl = document.getElementById("login-error");
const errorReveal = document.getElementById("login-error-reveal");
const submitButton = form.querySelector('button[type="submit"]');

// Same rule as the server: only a path on this site, never an absolute URL.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function setFieldError(input, invalid) {
  form.querySelector(`[data-error-for="${input.id}"]`).classList.toggle("is-open", invalid);
  if (invalid) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", `${input.id}-error`);
  } else {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }
}

// Opened first and filled a beat later: role="alert" is only read when its text
// changes while it is visible.
function showFormError(message) {
  errorEl.textContent = "";
  errorReveal.classList.add("is-open");
  setTimeout(() => (errorEl.textContent = message), 50);
}

function clearFormError() {
  errorReveal.classList.remove("is-open");
}

// The message leaves as soon as the field is being fixed, never while it is
// still empty, so typing never makes red flash on and off.
for (const input of [userInput, passInput]) {
  input.addEventListener("input", () => {
    if (input.value) setFieldError(input, false);
    clearFormError();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFormError();
  const empty = [userInput, passInput].filter((input) => !input.value);
  for (const input of [userInput, passInput]) setFieldError(input, empty.includes(input));
  if (empty.length > 0) {
    empty[0].focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Entrando…";
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
    showFormError(body.error || "Não foi possível entrar.");
    passInput.select();
  } catch {
    showFormError("Não foi possível conectar ao servidor.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Entrar";
  }
});
