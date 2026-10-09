// A 401 means the login session ended (30 days, or the password changed), so
// the page goes back to the login and returns here afterwards.
async function apiFetch(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  return response;
}

const currentUserEl = document.getElementById("current-user");
const whoAmI = apiFetch("/api/me")
  .then((response) => response.json())
  .then(({ username }) => {
    currentUser = username;
    currentUserEl.textContent = username || "";
    currentUserEl.hidden = !username;
  })
  .catch((err) => console.error("Não foi possível saber quem está logado:", err));

document.getElementById("logout-button").addEventListener("click", async function logout() {
  let body;
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    if (response.ok) {
      location.href = "/login";
      return;
    }
    body = `O servidor respondeu ${response.status}.`;
  } catch (err) {
    console.error("Falha ao sair:", err);
    body = "O servidor não respondeu. Confira a conexão.";
  }
  if (await askUser({ title: "Você continua conectado", body, confirmLabel: "Tentar sair de novo", cancelLabel: "Fechar" })) {
    logout();
  }
});

const THEME_KEY = "awardtool.theme";
const themeButton = document.getElementById("theme-button");

function showTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButton.setAttribute("aria-pressed", String(theme === "dark"));
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#13171b" : "#eff1f0";
}

showTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const THEME_FADE_MS = 300;

// Browsers with view transitions fade the whole page at once; the others (Firefox)
// fade each element's colors.
function switchTheme(theme) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    showTheme(theme);
    return;
  }
  if (document.startViewTransition) {
    document
      .startViewTransition(() => showTheme(theme))
      // A hidden tab or a second click skips the fade; the theme is applied anyway.
      .ready.catch((err) => console.debug("Transição de tema pulada:", err.message));
    return;
  }
  const root = document.documentElement;
  root.classList.add("theme-fading");
  showTheme(theme);
  setTimeout(() => root.classList.remove("theme-fading"), THEME_FADE_MS);
}

themeButton.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  switchTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (err) {
    console.error("Não foi possível guardar o tema escolhido:", err);
  }
});

const confirmDialog = document.getElementById("confirm-dialog");
const confirmDialogTitle = confirmDialog.querySelector(".confirm-dialog-title");
const confirmDialogRoutes = confirmDialog.querySelector(".confirm-dialog-routes");
const confirmDialogBody = confirmDialog.querySelector(".confirm-dialog-body");
const confirmDialogCancel = confirmDialog.querySelector(".confirm-dialog-cancel");
const confirmDialogConfirm = confirmDialog.querySelector(".confirm-dialog-confirm");
let dialogQueue = Promise.resolve();

confirmDialogCancel.addEventListener("click", () => confirmDialog.close("cancel"));
// A click on the dimmed backdrop lands on the dialog element itself, outside its form.
confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) confirmDialog.close("cancel");
});

// `routes`: [{ origin, destination, roundTrip, lines: [text, ...] }], each drawn as the card's route sign.
function askUser({ title, routes = [], body, confirmLabel, cancelLabel = "Cancelar" }) {
  const shown = dialogQueue.then(
    () =>
      new Promise((resolve) => {
        confirmDialogTitle.textContent = title;
        confirmDialogRoutes.replaceChildren(...routes.map(dialogRouteItem));
        confirmDialogRoutes.hidden = routes.length === 0;
        confirmDialogBody.textContent = body;
        confirmDialogCancel.textContent = cancelLabel;
        confirmDialogConfirm.textContent = confirmLabel;
        confirmDialog.returnValue = "";
        confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
        confirmDialog.showModal();
      }),
  );
  dialogQueue = shown;
  return shown;
}

function dialogRouteItem({ origin, destination, roundTrip, lines }) {
  const item = document.createElement("li");
  item.className = "confirm-dialog-route";
  const sign = document.createElement("span");
  sign.className = "confirm-dialog-sign";
  appendRoute(sign, origin, destination, roundTrip);
  const facts = document.createElement("span");
  facts.className = "confirm-dialog-facts";
  for (const [index, text] of lines.entries()) {
    const line = document.createElement("span");
    line.className = index === 0 ? "confirm-dialog-fact-lead" : "confirm-dialog-fact";
    line.textContent = text;
    facts.append(line);
  }
  item.append(sign, facts);
  return item;
}

const tapForm = document.getElementById("tap-search-form");
const tapOriginInput = document.getElementById("tap-origin");
const tapDestinationInput = document.getElementById("tap-destination");
const tapRoundTripCheckbox = document.getElementById("tap-round-trip");
const tapNotice = document.getElementById("tap-notice");
const tapBusinessCeilingInput = document.getElementById("tap-ceiling-business");
const tapEconomyCeilingInput = document.getElementById("tap-ceiling-economy");
const tapQueue = document.getElementById("tap-queue");

const seatspyForm = document.getElementById("seatspy-search-form");
const seatspyProgramSelect = document.getElementById("seatspy-program");
const seatspyOriginInput = document.getElementById("seatspy-origin");
const seatspyDestinationInput = document.getElementById("seatspy-destination");
const seatspyShowSeatsCheckbox = document.getElementById("seatspy-show-seats");
const seatspyRoundTripCheckbox = document.getElementById("seatspy-round-trip");
const seatspyEconomyCeilingInput = document.getElementById("seatspy-ceiling-economy");
const seatspyPremiumCeilingInput = document.getElementById("seatspy-ceiling-premium");
const seatspyBusinessCeilingInput = document.getElementById("seatspy-ceiling-business");
const seatspyFirstCeilingInput = document.getElementById("seatspy-ceiling-first");
const seatspyNotice = document.getElementById("seatspy-notice");
const seatspyQueue = document.getElementById("seatspy-queue");

const aaForm = document.getElementById("aa-search-form");
const aaOriginInput = document.getElementById("aa-origin");
const aaDestinationInput = document.getElementById("aa-destination");
const aaCabinSelect = document.getElementById("aa-cabin");
const aaStopsSelect = document.getElementById("aa-stops");
const aaPassengersSelect = document.getElementById("aa-passengers");
const aaCeilingInput = document.getElementById("aa-ceiling");
const aaRoundTripCheckbox = document.getElementById("aa-round-trip");
const aaNotice = document.getElementById("aa-notice");
const aaQueue = document.getElementById("aa-queue");

const iberiaForm = document.getElementById("iberia-search-form");
const iberiaOriginInput = document.getElementById("iberia-origin");
const iberiaDestinationInput = document.getElementById("iberia-destination");
const iberiaCeilingInput = document.getElementById("iberia-ceiling");
const iberiaDetailDaysSelect = document.getElementById("iberia-detail-days");
const iberiaStopsSelect = document.getElementById("iberia-stops");
const iberiaCabinSelect = document.getElementById("iberia-cabin");
const iberiaRoundTripCheckbox = document.getElementById("iberia-round-trip");
const iberiaNotice = document.getElementById("iberia-notice");
const iberiaQueue = document.getElementById("iberia-queue");

const smilesForm = document.getElementById("smiles-search-form");
const smilesOriginInput = document.getElementById("smiles-origin");
const smilesDestinationInput = document.getElementById("smiles-destination");
const smilesRoundTripCheckbox = document.getElementById("smiles-round-trip");
const smilesFromInput = document.getElementById("smiles-from");
const smilesUntilInput = document.getElementById("smiles-until");
const smilesEconomyCeilingInput = document.getElementById("smiles-ceiling-economy");
const smilesPremiumCeilingInput = document.getElementById("smiles-ceiling-premium");
const smilesBusinessCeilingInput = document.getElementById("smiles-ceiling-business");
const smilesNotice = document.getElementById("smiles-notice");
const smilesQueue = document.getElementById("smiles-queue");

const latamForm = document.getElementById("latam-search-form");
const latamOriginInput = document.getElementById("latam-origin");
const latamDestinationInput = document.getElementById("latam-destination");
const latamCeilingInput = document.getElementById("latam-ceiling");
const latamLowestFareCheckbox = document.getElementById("latam-lowest-fare");
const latamConfirmMilesCheckbox = document.getElementById("latam-confirm-miles");
const latamNotice = document.getElementById("latam-notice");
const latamQueue = document.getElementById("latam-queue");

const jobTemplate = document.getElementById("job-template");
const tabButtons = document.querySelectorAll(".tab-button");
const panels = {
  tap: document.getElementById("panel-tap"),
  seatspy: document.getElementById("panel-seatspy"),
  aa: document.getElementById("panel-aa"),
  iberia: document.getElementById("panel-iberia"),
  smiles: document.getElementById("panel-smiles"),
  latam: document.getElementById("panel-latam"),
  history: document.getElementById("panel-history"),
};
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const historyTop = document.getElementById("history-top");
const historySummary = document.getElementById("history-summary");
const historyNotice = document.getElementById("history-notice");

const MONTHS_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const TOLERANCE_DAYS = 5;
const TOLERANCE_MS = TOLERANCE_DAYS * 24 * 60 * 60 * 1000;

const PROGRAM_LABELS = {
  tap: "TAP",
  AA: "American Airlines",
  LATAM: "LATAM",
  SMILES: "Smiles",
  // `IB` is Iberia seen through SeatSpy; `IBERIA` is the direct search on its own
  // site. They are different sources and the history must tell them apart.
  IBERIA: "Iberia (Avios)",
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

const AA_CABIN_LABELS = { economy: "Econômica", premium: "Premium Economy", business: "Executiva", first: "Primeira Classe" };
const AA_CABIN_CLASSES = { economy: "cabin-economy", premium: "cabin-premium", business: "cabin-business", first: "cabin-first" };

function markSelectedTab(buttons, selected) {
  for (const button of buttons) {
    const isSelected = button === selected;
    button.classList.toggle("active", isSelected);
    button.setAttribute("aria-selected", String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
  }
}

// Arrow keys move between tabs and Tab leaves the list, the keyboard pattern
// screen readers announce for role="tablist".
function onTabListKeydown(event, buttons, select) {
  const list = [...buttons].filter((button) => !button.disabled);
  const index = list.indexOf(event.currentTarget);
  const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: list.length - 1 }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = list[(target + list.length) % list.length];
  select(next);
  next.focus();
}

// Tabs only toggle hidden: nothing is destroyed or recreated, so running search
// cards in one tab keep going and stay visible when you come back.
function selectTab(button) {
  if (button.disabled) return;
  markSelectedTab(tabButtons, button);
  const tab = button.dataset.tab;
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== tab;
  if (tab === "history") renderHistory();
  window.history.replaceState(null, "", `#${tab}`);
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => selectTab(button));
  button.addEventListener("keydown", (event) => onTabListKeydown(event, tabButtons, selectTab));
});

function activateTab(tab) {
  selectTab(document.querySelector(`.tab-button[data-tab="${tab}"]`));
}

// The history used to live under another key with Portuguese fields. It is
// moved once, then the old key goes away so clearing the history cannot bring it back.
// The history is the server's: every search anyone ran, kept in its database.
const PROGRAM_BY_SOURCE = { tap: "tap", aa: "AA", latam: "LATAM", smiles: "SMILES", iberia: "IBERIA" };
// Failed and cancelled searches stay on the server, but nobody has dates from them.
const LISTED_STATUSES = new Set(["queued", "running", "done", "partial"]);
let currentUser = null;

function historyItemFrom(row) {
  return {
    id: row.id,
    program: row.source === "seatspy" ? row.request.airline : PROGRAM_BY_SOURCE[row.source] || row.source,
    origin: row.origin,
    destination: row.destination,
    roundTrip: row.source === "latam" || (row.source === "seatspy" && row.request.roundTrip === true),
    cabin: row.request.cabin,
    passengers: row.request.passengers,
    user: row.user,
    status: row.status,
    timestamp: Date.parse(row.createdAt),
    groupId: row.groupId,
    groupLeg: row.groupLeg,
  };
}

async function loadHistory() {
  const response = await apiFetch("/api/history?limit=200");
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(body?.error || "Não foi possível carregar o histórico do servidor.");
  }
  return body.filter((row) => LISTED_STATUSES.has(row.status)).map(historyItemFrom);
}

// A round-trip entry covers both directions of the route.
function latestSearchOf(history, origin, destination, program) {
  const sameRoute = history.filter(
    (item) =>
      item.program === program &&
      ((item.origin === origin && item.destination === destination) ||
        (item.roundTrip && item.origin === destination && item.destination === origin)),
  );
  if (sameRoute.length === 0) return null;
  return sameRoute.reduce((newest, item) => (item.timestamp > newest.timestamp ? item : newest));
}

function whoSearched(item) {
  if (!item.user) return "";
  return item.user === currentUser ? "você" : item.user;
}

// Facts sit side by side with space between them instead of " · " joins.
function setFacts(element, facts) {
  element.classList.add("facts");
  element.replaceChildren(
    ...facts.filter(Boolean).map((fact) => {
      const span = document.createElement("span");
      if (typeof fact === "string") {
        span.textContent = fact;
      } else {
        span.textContent = fact.text;
        span.className = fact.className;
      }
      return span;
    }),
  );
}

function plural(count, one, other) {
  return `${count} ${count === 1 ? one : other}`;
}

const reaisFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0 });
const reaisCentsFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const integerFormat = new Intl.NumberFormat("pt-BR");
// Search dates are calendar days ("2026-11-08"); read in UTC they never shift a day.
const shortDateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const fullDateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const formatShortDate = (isoDate) => shortDateFormat.format(new Date(`${isoDate}T00:00:00Z`));
const formatFullDate = (isoDate) => fullDateFormat.format(new Date(`${isoDate}T00:00:00Z`));

function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString("pt-BR");
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${day} às ${time}`;
}

function formatRelativeTime(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "há 1 dia";
  return `há ${days} dias`;
}

// "2026-07-17" in the local time zone, to group searches by day.
function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayLabel(timestamp) {
  const key = dayKey(timestamp);
  if (key === dayKey(Date.now())) return "Hoje";
  if (key === dayKey(Date.now() - 24 * 60 * 60 * 1000)) return "Ontem";
  const text = new Date(timestamp).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Fills the right tab's form with the history route and switches to it.
function repeatSearch(item) {
  if (item.program === "tap") {
    tapOriginInput.value = item.origin;
    tapDestinationInput.value = item.destination;
    tapRoundTripCheckbox.checked = Boolean(item.roundTrip);
    activateTab("tap");
    tapOriginInput.focus();
  } else if (item.program === "SMILES") {
    smilesOriginInput.value = item.origin;
    smilesDestinationInput.value = item.destination;
    smilesRoundTripCheckbox.checked = Boolean(item.roundTrip);
    activateTab("smiles");
    smilesOriginInput.focus();
  } else if (item.program === "AA") {
    aaOriginInput.value = item.origin;
    aaDestinationInput.value = item.destination;
    if (item.cabin) aaCabinSelect.value = item.cabin;
    // Older entries lack the field; without the default the select would be blank.
    aaPassengersSelect.value = String(item.passengers || 1);
    aaRoundTripCheckbox.checked = Boolean(item.roundTrip);
    activateTab("aa");
    aaOriginInput.focus();
  } else if (item.program === "LATAM") {
    latamOriginInput.value = item.origin;
    latamDestinationInput.value = item.destination;
    activateTab("latam");
    latamOriginInput.focus();
  } else if (item.program === "IBERIA" && document.getElementById("tab-iberia").disabled) {
    showNotice(historyNotice, "A busca direta na Iberia ainda não está disponível.");
  } else if (item.program === "IBERIA") {
    iberiaOriginInput.value = item.origin;
    iberiaDestinationInput.value = item.destination;
    iberiaRoundTripCheckbox.checked = Boolean(item.roundTrip);
    activateTab("iberia");
    iberiaOriginInput.focus();
  } else if ([...seatspyProgramSelect.options].some((option) => option.value === item.program)) {
    seatspyProgramSelect.value = item.program;
    seatspyOriginInput.value = item.origin;
    seatspyDestinationInput.value = item.destination;
    seatspyRoundTripCheckbox.checked = Boolean(item.roundTrip);
    activateTab("seatspy");
    updateSeatspyHints();
    seatspyOriginInput.focus();
  } else {
    showNotice(historyNotice, `Não há aba para repetir buscas do programa "${item.program}". Preencha a busca na aba do programa.`);
  }
}

// The server keeps each leg apart (A→B and B→A). Those pairs (same program,
// opposite directions, up to 3h apart) show as one ⇄ entry, with the outbound's
// direction and the time the return started.
// The pair shows whatever still needs attention first.
function pairStatus(a, b) {
  return ["running", "queued", "partial", "done"].find((status) => a.status === status || b.status === status);
}

function groupForDisplay(history) {
  const PAIR_WINDOW_MS = 3 * 60 * 60 * 1000;
  const used = new Set();
  const display = [];

  for (let i = 0; i < history.length; i++) {
    if (used.has(i)) continue;
    const item = history[i];

    // Legs that know their card pair exactly; the rest fall back to route and time.
    if (item.groupId) {
      const j = history.findIndex((other, k) => k > i && !used.has(k) && other.groupId === item.groupId);
      if (j !== -1) {
        used.add(j);
        const outbound = item.groupLeg === 0 ? item : history[j];
        display.push({ ...outbound, roundTrip: true, timestamp: item.timestamp, status: pairStatus(item, history[j]) });
        continue;
      }
    }

    if (!item.roundTrip) {
      const j = history.findIndex(
        (other, k) =>
          k > i &&
          !used.has(k) &&
          !(item.groupId && other.groupId) &&
          !other.roundTrip &&
          other.program === item.program &&
          other.origin === item.destination &&
          other.destination === item.origin &&
          item.timestamp - other.timestamp < PAIR_WINDOW_MS,
      );
      if (j !== -1) {
        used.add(j);
        // The older entry of the pair is the outbound: it sets the direction shown.
        const outbound = history[j];
        display.push({ ...outbound, roundTrip: true, timestamp: item.timestamp });
        continue;
      }
    }
    display.push(item);
  }
  return display;
}

async function renderHistory() {
  clearNotice(historyNotice);
  let items;
  try {
    items = await loadHistory();
  } catch (err) {
    showNotice(historyNotice, err.message);
    return;
  }
  const history = groupForDisplay(items.sort((a, b) => b.timestamp - a.timestamp));
  historyList.innerHTML = "";
  historyEmpty.hidden = history.length > 0;
  historyTop.hidden = history.length === 0;

  if (history.length === 0) return;

  // Round-trip routes count once, whatever the direction.
  const uniqueRoutes = new Set(
    history.map((item) => {
      const route = item.roundTrip ? [item.origin, item.destination].sort().join("⇄") : `${item.origin}→${item.destination}`;
      return `${item.program}|${route}`;
    }),
  ).size;
  const withinTolerance = history.filter((item) => Date.now() - item.timestamp < TOLERANCE_MS).length;
  const people = new Set(history.map((item) => item.user).filter(Boolean)).size;
  setFacts(historySummary, [
    plural(history.length, "busca", "buscas"),
    people > 0 && plural(people, "pessoa", "pessoas"),
    plural(uniqueRoutes, "trecho diferente", "trechos diferentes"),
    `${withinTolerance} dentro da tolerância de ${TOLERANCE_DAYS} dias`,
    `última ${formatRelativeTime(history[0].timestamp)}`,
  ]);

  const groups = new Map();
  for (const item of history) {
    const key = dayKey(item.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const items of groups.values()) {
    const group = document.createElement("section");
    group.className = "day-group";

    const header = document.createElement("div");
    header.className = "day-header";

    const label = document.createElement("span");
    label.className = "day-label";
    label.textContent = dayLabel(items[0].timestamp);

    const subtitle = document.createElement("span");
    subtitle.className = "day-subtitle";
    setFacts(subtitle, [new Date(items[0].timestamp).toLocaleDateString("pt-BR"), plural(items.length, "busca", "buscas")]);

    header.append(label, subtitle);
    group.appendChild(header);

    for (const item of items) group.appendChild(createHistoryItem(item));
    historyList.appendChild(group);
  }
}

function historyCabins(item) {
  if (item.program === "tap") return [["Executiva", "cabin-business"], ["Econômica", "cabin-economy"]];
  if (item.program === "LATAM" || item.program === "IBERIA") return [["Econômica", "cabin-economy"]];
  if (item.program === "SMILES") return [["Econômica", "cabin-economy"], ["Conforto", "cabin-premium"], ["Executiva", "cabin-business"]];
  if (item.program === "AA") {
    // Passengers only show when more than one, to tell it apart from the regular entry of the same route.
    const label = (AA_CABIN_LABELS[item.cabin] || "Cabine n/d") + (item.passengers > 1 ? `, ${item.passengers} pax` : "");
    return [[label, AA_CABIN_CLASSES[item.cabin] || "cabin-economy"]];
  }
  return [["Econômica", "cabin-economy"], ["Premium", "cabin-premium"], ["Executiva", "cabin-business"], ["Primeira", "cabin-first"]];
}

const HISTORY_STATUS_LABELS = { queued: "Na fila", running: "Buscando", done: "Pronta", partial: "Parcial" };

function createHistoryItem(item) {
  const row = document.createElement("div");
  row.className = `history-item accent-${item.program} history-item-${item.status}`;

  const main = document.createElement("div");
  main.className = "history-item-main";

  const programTag = document.createElement("span");
  programTag.className = `program-tag tag-${item.program}`;
  programTag.textContent = PROGRAM_LABELS[item.program] || item.program;

  const route = document.createElement("span");
  route.className = "history-item-route";
  appendRoute(route, item.origin, item.destination, item.roundTrip);

  main.append(programTag, route);

  const who = whoSearched(item);
  if (who) {
    const user = document.createElement("span");
    user.className = "history-item-user";
    user.textContent = `por ${who}`;
    main.appendChild(user);
  }

  const cabins = document.createElement("div");
  cabins.className = "history-item-cabins";
  for (const [text, className] of historyCabins(item)) {
    const tag = document.createElement("span");
    tag.className = `history-item-cabin ${className}`;
    tag.textContent = text;
    cabins.appendChild(tag);
  }

  const right = document.createElement("div");
  right.className = "history-item-right";

  const time = document.createElement("span");
  time.className = "history-item-time";
  time.textContent = new Date(item.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const relative = document.createElement("span");
  relative.className = "history-item-relative";
  relative.textContent = formatRelativeTime(item.timestamp);

  const status = document.createElement("span");
  status.className = `history-item-status history-status-${item.status}`;
  status.textContent = HISTORY_STATUS_LABELS[item.status];

  right.append(status, time, relative);

  const spokenRoute = `${item.origin} para ${item.destination}${item.roundTrip ? ", ida e volta" : ""}`;
  const repeatButton = document.createElement("button");
  repeatButton.type = "button";
  repeatButton.className = "repeat-search-button";
  repeatButton.title = "Preencher a busca com esse trecho";
  repeatButton.setAttribute("aria-label", `Repetir a busca ${spokenRoute}`);
  repeatButton.innerHTML = ICONS.repeat;
  repeatButton.addEventListener("click", () => repeatSearch(item));

  // A fixed-width slot, so rows with and without "Abrir" keep the status column aligned.
  const actions = document.createElement("div");
  actions.className = "history-item-actions";
  if (item.groupId && (item.status === "done" || item.status === "partial")) {
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "action-button open-result-button";
    openButton.textContent = "Abrir";
    openButton.setAttribute("aria-label", `Abrir o resultado de ${spokenRoute}`);
    openButton.addEventListener("click", () => openFromHistory(item, openButton));
    actions.append(openButton);
  }
  actions.append(repeatButton);
  row.append(main, cabins, right, actions);
  return row;
}

const TAB_BY_SOURCE = { tap: "tap", seatspy: "seatspy", aa: "aa", latam: "latam", smiles: "smiles", iberia: "iberia" };

// Rebuilds the whole card from what the server saved: same dates, copy and alert
// buttons, no new search and no credit spent.
async function openFromHistory(item, button) {
  clearNotice(historyNotice);
  button.disabled = true;
  try {
    const response = await apiFetch(`/api/history/groups/${encodeURIComponent(item.groupId)}`);
    const card = await response.json().catch(() => null);
    if (!response.ok || !card) throw new Error(card?.error || "Não deu para abrir essa busca.");
    if (!RESUME_BY_SOURCE[card.source] || card.args.length !== ARG_COUNT_BY_SOURCE[card.source]) {
      throw new Error("Essa busca foi salva num formato que esta versão não sabe abrir.");
    }
    if (card.legs.every((leg) => !leg.result)) {
      throw new Error("O resultado dessa busca não está mais guardado no servidor. Use o botão de repetir para buscar de novo.");
    }
    const tab = TAB_BY_SOURCE[card.source];
    if (document.getElementById(`tab-${tab}`).disabled) throw new Error("A aba desse programa ainda não está disponível.");

    const session = newSession(card.source, card.args);
    session.viewing = { by: card.user, at: Date.parse(card.createdAt) };
    for (const leg of card.legs) {
      session.record.steps[leg.leg] = leg.result
        ? { result: { ...resultFromEvent(leg.result), searchId: leg.id } }
        : { error: leg.error || "Essa parte da busca não terminou." };
    }
    RESUME_BY_SOURCE[card.source](...card.args, session);
    activateTab(tab);
    panels[tab].querySelector(".search-job")?.scrollIntoView({ block: "start" });
  } catch (err) {
    showNotice(historyNotice, err.message);
  } finally {
    button.disabled = false;
  }
}

const announcer = document.getElementById("announcer");

// A notice that was display:none when its text changed is not read by screen
// readers, so messages also go through this live region, which never hides.
function announce(message) {
  announcer.textContent = "";
  setTimeout(() => (announcer.textContent = message), 50);
}

const UNDO_MS = 6000;
const toastEl = document.getElementById("toast");
const toastTextEl = toastEl.querySelector(".toast-text");
const toastUndoButton = toastEl.querySelector(".toast-undo");
let pendingRemoval = null;

// Removing only becomes final when the toast expires, so a click on the wrong
// Remover can be taken back. A new removal finalizes the previous one first.
function removeWithUndo({ kind, message, element, returnFocusTo, commit }) {
  finishPendingRemoval();
  // The focused button disappears with its element; a keyboard user would be
  // dropped at the top of the page, so focus waits on Desfazer instead.
  const focusWasInside = element.contains(document.activeElement);
  element.hidden = true;
  pendingRemoval = {
    kind,
    element,
    returnFocusTo,
    commit,
    panel: element.closest('[role="tabpanel"]'),
    timer: setTimeout(finishPendingRemoval, UNDO_MS),
  };
  toastTextEl.textContent = message;
  toastEl.hidden = false;
  if (focusWasInside) toastUndoButton.focus();
  announce(`${message}. Use Desfazer para trazer de volta.`);
}

function finishPendingRemoval() {
  if (!pendingRemoval) return;
  const { commit, timer, panel } = pendingRemoval;
  pendingRemoval = null;
  clearTimeout(timer);
  const undoHadFocus = toastEl.contains(document.activeElement);
  toastEl.hidden = true;
  commit();
  if (undoHadFocus) panel?.focus();
}

toastUndoButton.addEventListener("click", () => {
  if (!pendingRemoval) return;
  const { element, returnFocusTo, timer } = pendingRemoval;
  pendingRemoval = null;
  clearTimeout(timer);
  toastEl.hidden = true;
  element.hidden = false;
  returnFocusTo.focus();
});

window.addEventListener("pagehide", finishPendingRemoval);

function showNotice(noticeEl, message) {
  noticeEl.textContent = message;
  noticeEl.hidden = false;
  announce(message);
}

function clearNotice(noticeEl) {
  noticeEl.hidden = true;
  noticeEl.textContent = "";
}

function updateBar(barEl, fraction) {
  barEl.style.transform = `scaleX(${Math.min(Math.max(fraction, 0), 1)})`;
}

let cardCount = 0;

// Every search gets its own card, so several run in parallel without one
// disturbing another's progress or result.
// `title` names the program; `detail` (cabin, passengers) only when it tells
// two cards of the same route apart.
function createJobCard(queueEl, { program, detail, origin, destination, roundTrip }) {
  const fragment = jobTemplate.content.cloneNode(true);
  const root = fragment.querySelector(".search-job");

  const card = {
    root,
    spokenTitle: `${program}${detail ? ` (${detail})` : ""}, ${origin} para ${destination}${roundTrip ? ", ida e volta" : ""}`,
    statusEl: root.querySelector(".job-status"),
    progressEl: root.querySelector(".progress"),
    progressLabelEl: root.querySelector(".progress-label"),
    progressWindowEl: root.querySelector(".progress-window"),
    barEl: root.querySelector(".bar-fill"),
    noticeEl: root.querySelector(".notice"),
    ceilingsEl: root.querySelector(".job-ceilings"),
    subtabsEl: root.querySelector(".subtabs"),
    subtabButtons: root.querySelectorAll(".subtab-button"),
    resultEl: root.querySelector(".result"),
    upgradeSubpanelEl: root.querySelector(".upgrade-subpanel"),
    upgradeListEl: root.querySelector(".upgrade-list"),
    upgradeEmptyEl: root.querySelector(".upgrade-empty"),
    actionsEl: root.querySelector(".job-actions"),
    copyOutboundButton: root.querySelector(".copy-outbound-button"),
    copyReturnButton: root.querySelector(".copy-return-button"),
    minimizeButton: root.querySelector(".minimize-button"),
    stopButton: root.querySelector(".stop-search-button"),
    removeButton: root.querySelector(".remove-button"),
    upgradeLegs: [],
    // Dates per leg in arrival order (outbound first), for the header's copy buttons.
    copyLegs: [],
  };

  root.querySelector(".job-program-name").textContent = program;
  const detailEl = root.querySelector(".job-detail");
  detailEl.textContent = detail || "";
  detailEl.hidden = !detail;
  appendRoute(root.querySelector(".job-route"), origin, destination, roundTrip);

  const cardId = `card-${++cardCount}`;
  const [datesTab, upgradeTab] = card.subtabButtons;
  datesTab.id = `${cardId}-dates-tab`;
  upgradeTab.id = `${cardId}-upgrade-tab`;
  card.resultEl.id = `${cardId}-dates`;
  card.upgradeSubpanelEl.id = `${cardId}-upgrade`;
  datesTab.setAttribute("aria-controls", card.resultEl.id);
  upgradeTab.setAttribute("aria-controls", card.upgradeSubpanelEl.id);
  card.resultEl.setAttribute("aria-labelledby", datesTab.id);
  card.upgradeSubpanelEl.setAttribute("aria-labelledby", upgradeTab.id);

  const selectSubtab = (button) => {
    markSelectedTab(card.subtabButtons, button);
    const subtab = button.dataset.subtab;
    card.resultEl.hidden = subtab !== "dates";
    card.upgradeSubpanelEl.hidden = subtab !== "upgrade";
    if (subtab === "upgrade") renderUpgrade(card);
  };
  card.subtabButtons.forEach((button) => {
    button.addEventListener("click", () => selectSubtab(button));
    button.addEventListener("keydown", (event) => onTabListKeydown(event, card.subtabButtons, selectSubtab));
  });

  card.setStatus = (text, className) => {
    card.statusEl.textContent = text;
    card.statusEl.className = `job-status ${className}`;
    // A shared job is someone else's search too: stopping it would stop theirs.
    card.stopButton.hidden = card.sharedJob || className === "status-done" || className === "status-error";
    // A search ending in error never reaches updateCardActions: without this the
    // card is a dead block with no Remove or Minimize until a reload.
    if (className === "status-error") card.actionsEl.hidden = false;
    // Cards restored on page load would read out a burst of "Pronto".
    if (!card.restored && (className === "status-done" || className === "status-error")) {
      announce(`${card.spokenTitle}: ${text}`);
    }
  };

  card.copyOutboundButton.addEventListener("click", () => copyLeg(card, 0, card.copyOutboundButton, "Copiar ida"));
  card.copyReturnButton.addEventListener("click", () => copyLeg(card, 1, card.copyReturnButton, "Copiar volta"));
  // An alert generated before the edit still shows the old dates; it must not
  // look like the one to forward.
  root.addEventListener("alert-dates-changed", () => markAlertsOutdated(card));

  card.minimized = false;
  // Only TAP cards have the Upgrade tab; on the others, expanding must not reveal an empty tab bar.
  card.hasSubtabs = false;
  card.setMinimized = (minimized) => {
    card.minimized = minimized;
    const activeSubtab = root.querySelector(".subtab-button.active")?.dataset.subtab || "dates";
    card.resultEl.hidden = minimized || activeSubtab !== "dates";
    card.upgradeSubpanelEl.hidden = minimized || activeSubtab !== "upgrade";
    card.subtabsEl.hidden = minimized || !card.hasSubtabs;
    card.minimizeButton.textContent = minimized ? "Expandir" : "Minimizar";
  };
  card.minimizeButton.addEventListener("click", () => card.setMinimized(!card.minimized));

  // Stop exists for the wrong click: the search leaves the queue before spending
  // a query, or ends at the next safe point if already running.
  card.stopButton.addEventListener("click", async () => {
    const jobId = root.dataset.jobId;
    card.stopButton.disabled = true;
    if (!jobId) {
      root.remove();
      return;
    }
    try {
      const response = await apiFetch(`/api/searches/${jobId}/cancel`, { method: "POST" });
      if (!response.ok && response.status !== 409) {
        throw new Error((await response.json().catch(() => ({}))).error || "Falha ao parar.");
      }
    } catch (err) {
      card.stopButton.disabled = false;
      showNotice(card.noticeEl, err.message || "Falha ao parar a busca.");
    }
  });

  // Remove takes the card off the screen AND out of storage; otherwise it would
  // come back on the next reload, which is exactly what persistence does.
  card.removeButton.addEventListener("click", () =>
    removeWithUndo({
      kind: "search",
      message: `Busca ${card.spokenTitle} removida`,
      element: root,
      returnFocusTo: card.removeButton,
      commit: () => {
        const id = root.dataset.searchId;
        if (id) saveSearches(loadSearches().filter((search) => search.id !== id));
        root.remove();
      },
    }),
  );

  queueEl.prepend(root);
  return card;
}

// `sections` is always [{ label, days, text }], the shape every source ends up in.
function recordLegForCopy(card, sections) {
  card.copyLegs.push(sections.filter((section) => section && section.days?.length > 0));
}

// "Mmm YYYY: DD, DD", what the alert generator expects pasted in its date
// fields. With more than one cabin each block is labeled so they never mix.
function legText(sections) {
  const kept = (sections || []).map(keptSection).filter(hasDays);
  if (kept.length === 0) return "";
  if (kept.length === 1) return kept[0].text;
  return kept.map((section) => `${section.label}\n${section.text}`).join("\n\n");
}

// Keyed by the `days` array, not the section: AA renders a spread copy
// ({ ...section, colorClass }) but hands the original to the alert, and both
// share the same array.
const excludedDates = new WeakMap();

function svgIcon(paths, { filled = false } = {}) {
  const paint = filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor"';
  return (
    `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" ${paint} stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
  );
}

const ICONS = {
  pencil: svgIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  repeat: svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  close: svgIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  megaphone: svgIcon('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  check: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
  sheet: svgIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'),
  file: svgIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  oneWay: svgIcon('<path d="M4 12h16"/><path d="m14 6 6 6-6 6"/>'),
  roundTrip: svgIcon('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
};

// The arrow is drawn, so screen readers get the words it stands for instead.
function appendRoute(target, origin, destination, roundTrip) {
  const from = document.createElement("strong");
  from.textContent = origin;
  const arrow = document.createElement("span");
  arrow.className = "route-arrow";
  arrow.title = roundTrip ? "Ida e volta" : "Somente ida";
  arrow.innerHTML = roundTrip ? ICONS.roundTrip : ICONS.oneWay;
  const spokenArrow = document.createElement("span");
  spokenArrow.className = "visually-hidden";
  spokenArrow.textContent = " para ";
  arrow.append(spokenArrow);
  const to = document.createElement("strong");
  to.textContent = destination;
  target.append(from, arrow, to);
  if (roundTrip) {
    const spokenRoundTrip = document.createElement("span");
    spokenRoundTrip.className = "visually-hidden";
    spokenRoundTrip.textContent = ", ida e volta";
    target.append(spokenRoundTrip);
  }
}

function setIconLabel(element, iconName, text) {
  element.innerHTML = ICONS[iconName];
  element.append(text);
}

function setAlertButtonState(button, cabinClass, state) {
  if (state === "busy") {
    button.textContent = "Gerando…";
  } else if (state === "done") {
    setIconLabel(button, "check", cabinClass);
    button.title = "Alerta gerado";
  } else {
    setIconLabel(button, "megaphone", cabinClass);
    button.removeAttribute("title");
  }
}

function excludedOf(section) {
  return (section && excludedDates.get(section.days)) || new Set();
}

// Same output as formatDatesByMonth on the server, seats suffix included.
function daysText(days) {
  return groupByMonth(days)
    .map((group) => `${group.title}: ${group.items.map(dayToken).join(", ")}`)
    .join("\n");
}

function dayToken(day) {
  const dayOfMonth = day.date.split("-")[2];
  return day.seats > 0 ? `${dayOfMonth} (${day.seats})` : dayOfMonth;
}

// Editing rebuilds the text on the front; if the rebuild does not reproduce the
// server's text, an edited alert would go out in a different format.
function canEditDates(section) {
  return daysText(section.days) === section.text;
}

// What the alert and the copy buttons use: the section minus the days taken out
// on screen. With nothing taken out it is the server's object, text untouched.
function keptSection(section) {
  const excluded = excludedOf(section);
  if (excluded.size === 0) return section;
  const days = section.days.filter((day) => !excluded.has(day.date));
  const values = days.map((day) => day.valueK).filter((value) => value != null);
  return {
    ...section,
    days,
    text: daysText(days),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

// The clipboard refuses outside a secure context or without focus; saying
// "Copiado!" then sent an empty paste to the group.
async function copyToClipboard(button, text, idleLabel) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (err) {
    console.error("Falha ao copiar:", err);
  }
  button.textContent = copied ? "Copiado!" : "Não foi possível copiar";
  announce(copied ? "Copiado" : "Não foi possível copiar");
  setTimeout(() => (button.textContent = idleLabel), copied ? 1500 : 4000);
}

function copyLeg(card, index, button, originalLabel) {
  const text = legText(card.copyLegs[index]);
  if (!text) return;
  copyToClipboard(button, text, originalLabel);
}

function updateCardActions(card) {
  card.actionsEl.hidden = false;
  card.copyOutboundButton.hidden = !legText(card.copyLegs[0]);
  card.copyReturnButton.hidden = !legText(card.copyLegs[1]);
}

// Searches survive a reload. The server keeps each job in memory and the events
// endpoint replays the current state, "done" included, so the front only has to
// remember WHICH searches it started: the source, the original arguments and
// the steps (one leg = one step = one server job). A finished step also keeps
// its result, so a completed search comes back even if the server restarted.
const SEARCHES_KEY = "awardtool.searches.v2";
const LEGACY_SEARCHES_KEY = "botEmissoes.buscas.v1";
const MAX_SAVED_SEARCHES = 10;
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
// localStorage usually stops at 5 MB; the cap keeps one huge search from breaking the others' saves.
const MAX_SEARCHES_BYTES = 1_500_000;

function loadSearches() {
  try {
    const cutoff = Date.now() - SEARCH_TTL_MS;
    return (JSON.parse(localStorage.getItem(SEARCHES_KEY)) || []).filter((search) => search.createdAt > cutoff);
  } catch {
    return [];
  }
}

function saveSearches(list) {
  // Drops the oldest until it fits. The search itself keeps working either way.
  let slice = list.slice(-MAX_SAVED_SEARCHES);
  while (slice.length > 0) {
    const text = JSON.stringify(slice);
    if (text.length <= MAX_SEARCHES_BYTES) {
      try {
        localStorage.setItem(SEARCHES_KEY, text);
        return;
      } catch {
        // Quota exceeded: try again with fewer.
      }
    }
    slice = slice.slice(1);
  }
  localStorage.removeItem(SEARCHES_KEY);
}

function persistSession(session) {
  // Someone else's card, or one opened from the history: restoring it as ours
  // would start its missing legs from here.
  if (session.spectating || session.viewing) return;
  const list = loadSearches().filter((search) => search.id !== session.record.id);
  list.push(session.record);
  saveSearches(list);
}

// Read before anything restores them, so the feed never shows this browser's own cards back as someone else's.
const ownGroupIds = new Set(loadSearches().map((search) => search.id));

// `args` must be serializable: it is what rebuilds the search later.
function newSession(source, args) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ownGroupIds.add(id);
  return {
    record: { id, source, args, steps: [], createdAt: Date.now() },
    resuming: false,
    index: 0,
  };
}

// The argument order is the one each search started with, which is why `args` is kept as it came.
const RESUME_BY_SOURCE = {
  tap: (...args) => startTapSearch(...args),
  seatspy: (...args) => startSeatspySearch(...args),
  smiles: (...args) => startSmilesSearch(...args),
  aa: (...args) => startAaSearch(...args),
  latam: (...args) => startLatamSearch(...args),
  iberia: (...args) => startIberiaSearch(...args),
};

async function restoreSearches() {
  // Saved results before the English API have another shape; they are only kept for 24h anyway.
  localStorage.removeItem(LEGACY_SEARCHES_KEY);
  const saved = loadSearches();
  if (saved.length === 0) return;

  const alive = [];
  for (const record of saved) {
    if (!RESUME_BY_SOURCE[record.source]) continue;

    // A step is usable when its result is saved (no server needed) or its job
    // still exists there. If the server restarted mid-step there is nothing to
    // recover, and the whole search leaves instead of coming back broken.
    const steps = [];
    let intact = true;
    for (const step of record.steps) {
      if (step.result) {
        steps.push(step);
        continue;
      }
      const exists = await apiFetch(`/api/searches/${step.jobId}/state`)
        .then((response) => response.ok)
        .catch(() => false);
      if (!exists) {
        intact = false;
        break;
      }
      steps.push(step);
    }
    if (intact) alive.push({ ...record, steps });
  }

  saveSearches(alive);
  for (const record of alive) {
    RESUME_BY_SOURCE[record.source](...record.args, { record, resuming: true, index: 0 });
  }
}

// The server may stop and ask something (today: AwardTool returning window after
// window without flights, which is either a route without awards or a source
// that is down). The search waits for a click, so the question shows in the
// card instead of an alert that gets lost.
function showQuestion(card, jobId, { id, message }) {
  removeQuestion(card);

  const box = document.createElement("div");
  box.className = "question";

  const text = document.createElement("p");
  text.className = "question-text";
  text.textContent = message;

  // Answering someone else's question is deciding their search for them.
  if (card.spectator) {
    text.textContent = `${message}\n\nQuem fez a busca é quem responde.`;
    box.append(text);
    card.root.querySelector(".job-header").after(box);
    return;
  }

  const actions = document.createElement("div");
  actions.className = "question-actions";

  const answer = async (proceed, button) => {
    actions.querySelectorAll("button").forEach((other) => (other.disabled = true));
    button.textContent = "…";
    try {
      const response = await apiFetch(`/api/searches/${jobId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, proceed }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Falha ao enviar a resposta.");
    } catch (err) {
      // Otherwise the card would go silent with both buttons locked.
      text.textContent = `${message}\n\n${err.message}`;
      actions.querySelectorAll("button").forEach((other) => (other.disabled = false));
      button.textContent = proceed ? "Continuar" : "Parar aqui";
    }
  };

  const continueButton = document.createElement("button");
  continueButton.type = "button";
  continueButton.className = "action-button continue-button";
  continueButton.textContent = "Continuar";
  continueButton.addEventListener("click", () => answer(true, continueButton));

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "action-button stop-button";
  stopButton.textContent = "Parar aqui";
  stopButton.addEventListener("click", () => answer(false, stopButton));

  actions.append(continueButton, stopButton);
  box.append(text, actions);
  card.root.querySelector(".job-header").after(box);
}

function removeQuestion(card) {
  card.root.querySelector(":scope > .question")?.remove();
}

// Runs one step over SSE and resolves with its final result. Only this search's
// card is touched; cards running in parallel are unaffected.
// The result came from someone's recent identical search; one click runs the
// whole search again with data from now.
const REPEAT_WARNING_ARGS = {
  tap: ([origin, destination, roundTrip]) => ["tap", origin, destination, roundTrip],
  seatspy: ([program, origin, destination, roundTrip]) => [program, origin, destination, roundTrip],
};

function offerFreshSearch(card, session) {
  if (card.freshSearchButton) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-button fresh-search-button";
  button.textContent = "Buscar de novo";
  button.addEventListener("click", async () => {
    button.disabled = true;
    // The paid sources warn before repeating a recent search, here as on their forms.
    const warning = REPEAT_WARNING_ARGS[session.record.source]?.(session.record.args);
    if (warning && !(await repeatWarning(...warning))) {
      button.disabled = false;
      return;
    }
    const fresh = newSession(session.record.source, session.record.args);
    fresh.forceFresh = true;
    RESUME_BY_SOURCE[session.record.source](...session.record.args, fresh);
  });
  card.freshSearchButton = button;
  card.noticeEl.after(button);
}

// Someone else's search, followed live: it never sends a search of its own.
// Its legs come from the feed, and only whoever searched can stop it or answer.
const spectatedGroups = new Map();
// The originator's browser starts the next leg as soon as the previous one ends.
const SHARED_LEG_WAIT_MS = 2 * 60 * 1000;
// The session goes in right after these arguments; a different count would put it in the wrong one.
const ARG_COUNT_BY_SOURCE = { tap: 4, seatspy: 5, smiles: 5, aa: 7, latam: 4, iberia: 7 };

function followSharedGroup(group, fromSnapshot) {
  if (ownGroupIds.has(group.id)) return;
  const known = spectatedGroups.get(group.id);
  if (known) {
    addSharedLegs(known, group.legs);
    return;
  }
  if (!RESUME_BY_SOURCE[group.source] || group.args.length !== ARG_COUNT_BY_SOURCE[group.source]) return;
  const session = {
    record: { id: group.id, source: group.source, args: group.args, steps: [], createdAt: Date.now() },
    resuming: true,
    index: 0,
    spectating: { by: group.by, fromSnapshot, waiters: new Map() },
  };
  spectatedGroups.set(group.id, session);
  addSharedLegs(session, group.legs);
  RESUME_BY_SOURCE[group.source](...group.args, session);
}

function addSharedLegs(session, legs) {
  legs.forEach((jobId, leg) => {
    if (!jobId || session.record.steps[leg]) return;
    session.record.steps[leg] = { jobId };
    session.spectating.waiters.get(leg)?.(jobId);
    session.spectating.waiters.delete(leg);
  });
}

function nextSharedLeg(session, leg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.spectating.waiters.delete(leg);
      reject(new Error("A próxima perna dessa busca não começou. Quem buscou pode ter fechado a página; confira no Histórico."));
    }, SHARED_LEG_WAIT_MS);
    session.spectating.waiters.set(leg, (jobId) => {
      clearTimeout(timer);
      resolve(jobId);
    });
  });
}

function markSpectatorCard(card, session) {
  if (card.spectator) return;
  card.spectator = true;
  card.sharedJob = true;
  card.stopButton.hidden = true;
  // A page opened mid-search would otherwise read out every colleague's search as it ends.
  card.restored = session.spectating.fromSnapshot;
  const { by } = session.spectating;
  const owner = document.createElement("span");
  owner.className = "job-owner";
  owner.textContent = by ? `por ${by === currentUser ? "você, em outra tela" : by}` : "de outra tela";
  card.root.querySelector(".job-title").after(owner);
  card.setMinimized(true);
}

function markHistoryCard(card, session) {
  if (card.fromHistory) return;
  card.fromHistory = true;
  card.restored = true;
  const { by, at } = session.viewing;
  const owner = document.createElement("span");
  owner.className = "job-owner";
  const whose = !by ? "busca" : by === currentUser ? "sua busca" : `busca de ${by}`;
  owner.textContent = `do histórico, ${whose} em ${formatDateTime(at)}`;
  card.root.querySelector(".job-title").after(owner);
  offerFreshSearch(card, session);
}

let historyRefresh = null;

function refreshVisibleHistory() {
  if (panels.history.hidden) return;
  clearTimeout(historyRefresh);
  historyRefresh = setTimeout(renderHistory, 500);
}

const connectionBanner = document.getElementById("connection-banner");
const connectionBannerText = connectionBanner.querySelector(".connection-banner-text");
const connectionBannerReload = connectionBanner.querySelector(".connection-banner-reload");
const UPDATING_MESSAGE = "Sem conexão com o servidor. Se ele estiver atualizando, volta em alguns segundos.";
// A blip shorter than this (a tunnel hiccup) does not deserve a banner.
const OFFLINE_BANNER_DELAY_MS = 2000;
const FEED_RETRY_MS = [2000, 4000, 8000, 15000];
let serverVersion = null;
let offlineTimer = null;

connectionBannerReload.addEventListener("click", () => location.reload());

function showConnectionBanner(text, { reload = false } = {}) {
  connectionBannerText.textContent = text;
  connectionBannerReload.hidden = !reload;
  connectionBanner.hidden = false;
}

function feedOffline() {
  if (offlineTimer || !connectionBannerReload.hidden) return;
  offlineTimer = setTimeout(() => showConnectionBanner(UPDATING_MESSAGE), OFFLINE_BANNER_DELAY_MS);
}

function feedOnline(version) {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  // The page keeps running the app.js it loaded; after an update it must be reloaded.
  if (serverVersion && version && version !== serverVersion) {
    showConnectionBanner("O bot foi atualizado. Recarregue a página para usar a versão nova.", { reload: true });
    return;
  }
  serverVersion ??= version;
  if (connectionBannerReload.hidden) connectionBanner.hidden = true;
}

function openFeed(attempt = 0) {
  const feed = new EventSource("/api/feed");
  feed.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "hello") {
      attempt = 0;
      feedOnline(event.version);
    } else if (event.type === "group") followSharedGroup(event.group, event.snapshot === true);
    else if (event.type === "history") refreshVisibleHistory();
  };
  feed.onerror = () => {
    feedOffline();
    // The browser retries a dropped connection by itself, but gives up for good on
    // an HTTP error, which is what the tunnel answers while the server restarts.
    if (feed.readyState !== EventSource.CLOSED) return;
    feed.close();
    setTimeout(() => openFeed(attempt + 1), FEED_RETRY_MS[Math.min(attempt, FEED_RETRY_MS.length - 1)]);
  };
}

// The same shape whether the result just arrived or comes back from the history.
function resultFromEvent(event) {
  return {
    result: event.legs || event.section || event.report,
    spreadsheetUrl: event.spreadsheetUrl,
    localFile: event.localFile,
    partialNotice: event.partialNotice,
    appliedCeilings: event.appliedCeilings,
    confirmation: event.confirmation,
    stoppedByUser: event.stoppedByUser,
  };
}

const RECONNECT_MS = 3000;
const SEARCH_NOT_STARTED_MESSAGE =
  "O servidor não respondeu e a busca não começou. Se ele estiver atualizando, tente de novo em alguns segundos.";

function runOnServer(card, body, progressLabel, session) {
  return new Promise(async (resolve, reject) => {
    card.progressLabelEl.textContent = progressLabel;
    card.progressWindowEl.textContent = "";
    updateBar(card.barEl, 0);
    card.setStatus("Na fila", "status-queued");

    // When resuming, a known step is reused; once the saved steps run out, the
    // search simply carries on from where it stopped.
    if (session?.spectating) markSpectatorCard(card, session);
    if (session?.viewing) markHistoryCard(card, session);
    let step = session?.record.steps[session.index];
    if (session) session.index++;
    if (!step && session?.spectating) {
      try {
        step = { jobId: await nextSharedLeg(session, session.index - 1) };
      } catch (err) {
        reject(err);
        return;
      }
    }

    // Set before any early exit: Remove must know which record to delete, and a
    // restored search leaves right below.
    if (session) card.root.dataset.searchId = session.record.id;

    // A card opened from the history only shows what was saved; it never searches.
    if (session?.viewing && !step?.result) {
      reject(new Error(step?.error || "Essa parte da busca não ficou salva no histórico."));
      return;
    }

    if (step?.result) {
      card.restored = true;
      card.setStatus("Pronto", "status-done");
      updateBar(card.barEl, 1);
      card.progressLabelEl.textContent = "Recuperado";
      resolve(step.result);
      return;
    }

    const keepResult = (result) => {
      if (!session) return;
      const target = session.record.steps[session.index - 1];
      if (target) target.result = result;
      persistSession(session);
    };

    let jobId = step?.jobId;
    // The history row behind this leg, where the flight filter finds its flights.
    let searchId = step?.searchId ?? jobId;
    if (jobId) card.root.dataset.jobId = jobId;
    if (!jobId) {
      let response;
      try {
        response = await apiFetch("/api/searches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // A recent identical search comes back instead of a new one, unless
          // this is the "Buscar de novo" of such a result.
          // `group` lets the others follow this card live (see followSharedGroup).
          body: JSON.stringify({
            ...body,
            reuseRecent: !session?.forceFresh,
            ...(session && { group: { id: session.record.id, leg: session.index - 1, args: session.record.args } }),
          }),
        });
      } catch {
        reject(new Error(SEARCH_NOT_STARTED_MESSAGE));
        return;
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        // Without our JSON body, a 5xx comes from the tunnel while the server is down.
        reject(new Error(error.error || (response.status >= 500 ? SEARCH_NOT_STARTED_MESSAGE : "Erro ao iniciar a busca.")));
        return;
      }

      const started = await response.json();
      jobId = started.jobId;
      // A reused result has no row of its own; the original search's row holds its flights.
      searchId = started.reused?.id ?? jobId;
      card.root.dataset.jobId = jobId;
      if (started.joined) {
        card.sharedJob = true;
        card.stopButton.hidden = true;
        const by = started.joined.by && started.joined.by !== currentUser ? `, pedida por ${started.joined.by}` : "";
        showNotice(card.noticeEl, `Essa mesma busca já estava rodando${by}. Acompanhando ela em vez de buscar de novo.`);
      }
      if (started.reused && session) offerFreshSearch(card, session);
      if (session) {
        session.record.steps[session.index - 1] = { jobId, searchId };
        persistSession(session);
      }
    }

    // The job lives on the server, so a dropped connection (tunnel hiccup, phone
    // waking up) only loses the stream: reopening it replays the job's state.
    let reconnecting = false;
    const listen = () => {
      const events = new EventSource(`/api/searches/${jobId}/events`);

      events.onmessage = (message) => {
        const event = JSON.parse(message.data);
        if (reconnecting) {
          reconnecting = false;
          card.progressLabelEl.textContent = progressLabel;
        }
        if (event.type === "queued") {
          card.setStatus("Na fila", "status-queued");
        } else if (event.type === "started") {
          card.setStatus("Buscando…", "status-searching");
        } else if (event.type === "progress") {
          updateBar(card.barEl, event.fraction);
        } else if (event.type === "window") {
          setFacts(card.progressWindowEl, [`Janela ${event.current} de ${event.total}`, `${event.start} – ${event.end}`]);
          card.noticeEl.hidden = true;
        } else if (event.type === "notice") {
          // Transient (e.g. AwardTool's rate-limit cooldown): cleared by the next window or progress.
          card.noticeEl.textContent = event.message;
          card.noticeEl.hidden = !event.message;
        } else if (event.type === "question") {
          showQuestion(card, jobId, event);
        } else if (event.type === "answered") {
          removeQuestion(card);
        } else if (event.type === "done") {
          events.close();
          removeQuestion(card);
          // Otherwise the label stays frozen on the last "Buscando…" after the search ends.
          card.progressLabelEl.textContent = "";
          const result = { ...resultFromEvent(event), searchId };
          keepResult(result);
          resolve(result);
        } else if (event.type === "error") {
          events.close();
          removeQuestion(card);
          reject(new Error(event.message));
        }
      };

      events.onerror = async () => {
        reconnecting = true;
        card.progressLabelEl.textContent = "Conexão caiu. Reconectando…";
        // Still CONNECTING: the browser retries on its own.
        if (events.readyState !== EventSource.CLOSED) return;
        events.close();
        const state = await apiFetch(`/api/searches/${jobId}/state`).catch(() => null);
        if (state?.status === 404) {
          reject(new Error("O servidor reiniciou e essa busca se perdeu. Busque de novo."));
          return;
        }
        setTimeout(listen, RECONNECT_MS);
      };
    };
    listen();
  });
}

function groupByMonth(items) {
  const groups = new Map();
  for (const item of items) {
    const [year, month] = item.date.split("-");
    const key = `${year}-${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.keys())
    .sort()
    .map((key) => {
      const [year, month] = key.split("-");
      return { title: `${MONTHS_PT[parseInt(month, 10) - 1]} ${year}`, items: groups.get(key) };
    });
}

function datesTextByMonth(dates) {
  return groupByMonth(dates.map((date) => ({ date })))
    .map((group) => `${group.title}: ${group.items.map((item) => item.date.split("-")[2]).join(", ")}`)
    .join("\n");
}

// Days where business and economy are both available: on those days the ticket
// can be issued in economy and upgraded to business on TAP, cheaper than issuing
// business directly.
function computeUpgrade(businessDays, economyDays) {
  const economyByDate = new Map((economyDays || []).map((day) => [day.date, day.valueK]));
  return (businessDays || [])
    .filter((day) => economyByDate.has(day.date))
    .map((day) => ({ date: day.date, businessK: day.valueK, economyK: economyByDate.get(day.date) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function renderUpgrade(card) {
  const { upgradeListEl, upgradeEmptyEl, upgradeLegs } = card;
  upgradeListEl.innerHTML = "";
  upgradeEmptyEl.hidden = upgradeLegs.length > 0;
  if (upgradeLegs.length === 0) return;

  for (const leg of upgradeLegs) {
    const crossed = computeUpgrade(leg.business, leg.economy);

    const block = createColumn(leg.label, "upgrade-leg");
    block.querySelector(".edit-dates-button").remove();
    block.querySelector(".date-chips").remove();
    const body = block.querySelector(".column-body");
    // Legs without crossed dates are born closed, leaving room for the ones that have them.
    setColumnExpanded(block, crossed.length > 0);

    const copyButton = block.querySelector(".copy-button");
    if (crossed.length > 0) {
      copyButton.textContent = "Copiar datas";
      copyButton.addEventListener("click", () =>
        copyToClipboard(copyButton, datesTextByMonth(crossed.map((item) => item.date)), "Copiar datas"),
      );
    } else {
      copyButton.remove();
    }

    block.querySelector(".column-summary").textContent =
      crossed.length > 0
        ? `${plural(crossed.length, "dia", "dias")} com as duas cabines disponíveis.`
        : "Nenhum dia com Executiva e Econômica juntas nesse período.";

    if (crossed.length > 0) {
      const dates = document.createElement("div");
      dates.className = "upgrade-dates";
      for (const group of groupByMonth(crossed)) {
        const monthTitle = document.createElement("div");
        monthTitle.className = "month-title";
        monthTitle.textContent = group.title;
        dates.appendChild(monthTitle);

        const rows = document.createElement("div");
        rows.className = "upgrade-rows";
        for (const item of group.items) {
          const row = document.createElement("div");
          row.className = "upgrade-row";

          const day = document.createElement("span");
          day.className = "upgrade-day";
          day.textContent = item.date.split("-")[2];

          const business = document.createElement("span");
          business.className = "date-chip cabin-business";
          business.textContent = item.businessK != null ? `Exec ${item.businessK}K` : "Exec (preço n/d)";

          const economy = document.createElement("span");
          economy.className = "date-chip cabin-economy";
          economy.textContent = item.economyK != null ? `Econ ${item.economyK}K` : "Econ (preço n/d)";

          row.append(day, business, economy);
          rows.appendChild(row);
        }
        dates.appendChild(rows);
      }
      body.appendChild(dates);
    }

    upgradeListEl.appendChild(block);
  }
}

function renderColumn(columnEl, section, colorClass) {
  const summaryEl = columnEl.querySelector(".column-summary");
  const chipsEl = columnEl.querySelector(".date-chips");
  const copyButton = columnEl.querySelector(".copy-button");
  const editButton = columnEl.querySelector(".edit-dates-button");

  if (!section.days || section.days.length === 0) {
    summaryEl.textContent = "Sem disponibilidade nesse período.";
    copyButton.hidden = true;
    editButton.hidden = true;
    setColumnExpanded(columnEl, false);
    return;
  }
  setColumnExpanded(columnEl, true);

  // Miles sources show "123K"; LATAM sends unit "BRL" and becomes "R$ 909". When
  // SeatSpy marks a day available without a price, min/max are null.
  const format = (value) => (section.unit === "BRL" ? reaisFormat.format(value) : `${value}K`);
  const renderSummary = () => {
    const kept = keptSection(section);
    const removed = section.days.length - kept.days.length;
    const range = kept.min != null ? `${format(kept.min)}–${format(kept.max)}` : "Preço não informado";
    setFacts(summaryEl, [
      { text: range, className: "fact-lead" },
      plural(kept.days.length, "dia", "dias"),
      removed > 0 && { text: `${removed} fora do alerta`, className: "fact-excluded" },
    ]);
    copyButton.disabled = kept.days.length === 0;
  };
  renderSummary();

  chipsEl.innerHTML = "";
  for (const group of groupByMonth(section.days)) {
    const monthTitle = document.createElement("div");
    monthTitle.className = "month-title";
    monthTitle.textContent = group.title;
    chipsEl.appendChild(monthTitle);

    const row = document.createElement("div");
    row.className = "date-chip-row";
    for (const { date, seats, link } of group.items) {
      // With a link the day becomes a real anchor (opens in a new tab, the address can be copied).
      const chip = document.createElement(link ? "a" : "span");
      chip.className = `date-chip ${colorClass}${link ? " date-chip-link" : ""}`;
      chip.dataset.date = date;
      if (excludedOf(section).has(date)) chip.classList.add("date-chip-excluded");
      chip.textContent = date.split("-")[2];
      if (link) {
        chip.href = link;
        chip.target = "_blank";
        chip.rel = "noopener noreferrer";
        chip.title = `Abrir a emissão de ${formatFullDate(date)} no site`;
      }
      if (seats > 0) {
        const seatsEl = document.createElement("small");
        seatsEl.className = "date-chip-seats";
        seatsEl.textContent = seats;
        seatsEl.title = plural(seats, "vaga", "vagas");
        chip.appendChild(seatsEl);
      }
      row.appendChild(chip);
    }
    chipsEl.appendChild(row);
  }

  copyButton.hidden = false;
  copyButton.onclick = () => copyToClipboard(copyButton, keptSection(section).text, "Copiar");

  editButton.hidden = false;
  editButton.innerHTML = ICONS.pencil;
  if (!canEditDates(section)) {
    editButton.disabled = true;
    editButton.title = "Edição indisponível: as datas dessa cabine não batem com o texto do alerta.";
    return;
  }

  const editorId = `${columnEl.querySelector(".column-body").id}-editor`;
  const editor = document.createElement("div");
  editor.className = "dates-editor";
  editor.hidden = true;
  editor.innerHTML = `
    <p class="dates-editor-hint" id="${editorId}-hint">Apague as datas que não vão no alerta. Selecione um trecho ou uma linha inteira para tirar várias de uma vez.</p>
    <textarea class="dates-editor-text" spellcheck="false" aria-describedby="${editorId}-hint ${editorId}-error"></textarea>
    <p class="dates-editor-error" id="${editorId}-error" role="alert" hidden></p>
    <div class="dates-editor-actions">
      <button type="button" class="action-button dates-editor-apply">Aplicar</button>
      <button type="button" class="action-button dates-editor-restore">Restaurar todas</button>
      <button type="button" class="action-button dates-editor-cancel">Cancelar</button>
    </div>`;
  chipsEl.before(editor);
  const textArea = editor.querySelector(".dates-editor-text");
  textArea.setAttribute("aria-label", `Datas de ${columnEl.querySelector(".column-label").textContent} que vão no alerta`);
  const errorEl = editor.querySelector(".dates-editor-error");
  const setError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
    if (message) textArea.setAttribute("aria-invalid", "true");
    else textArea.removeAttribute("aria-invalid");
  };

  const setEditing = (editing) => {
    editor.hidden = !editing;
    chipsEl.hidden = editing;
    editButton.setAttribute("aria-pressed", String(editing));
    setError("");
    if (!editing) {
      if (editor.contains(document.activeElement)) editButton.focus();
      return;
    }
    setColumnExpanded(columnEl, true);
    textArea.value = keptSection(section).text;
    textArea.rows = Math.max(3, textArea.value.split("\n").length + 1);
    textArea.focus();
  };

  const apply = () => {
    const parsed = parseKeptDates(textArea.value, section);
    if (parsed.error) {
      setError(parsed.error);
      textArea.focus();
      return;
    }
    const excluded = new Set(section.days.map((day) => day.date).filter((date) => !parsed.kept.has(date)));
    excludedDates.set(section.days, excluded);
    for (const chip of chipsEl.querySelectorAll(".date-chip")) {
      chip.classList.toggle("date-chip-excluded", excluded.has(chip.dataset.date));
    }
    renderSummary();
    setEditing(false);
    columnEl.dispatchEvent(new CustomEvent("alert-dates-changed", { bubbles: true }));
  };

  editButton.onclick = () => setEditing(editor.hidden);
  editor.querySelector(".dates-editor-apply").onclick = apply;
  editor.querySelector(".dates-editor-cancel").onclick = () => setEditing(false);
  editor.querySelector(".dates-editor-restore").onclick = () => {
    textArea.value = section.text;
    setError("");
  };
  textArea.onkeydown = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) apply();
    if (event.key === "Escape") setEditing(false);
  };
}

// The text area is free text, so it is read strictly: every day left in it must
// be one the search returned, written exactly as the copy text writes it. The
// alert never carries what was typed, only the days it matched.
function parseKeptDates(text, section) {
  const datesByMonth = new Map(
    groupByMonth(section.days).map((group) => [group.title, new Map(group.items.map((day) => [dayToken(day), day.date]))]),
  );
  const kept = new Set();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+ \d{4}):(.*)$/);
    if (!match) return { error: `Linha fora do formato "Mmm AAAA: DD, DD": "${line}"` };
    const [, month, rest] = match;
    const dates = datesByMonth.get(month);
    if (!dates) return { error: `${month} não está no resultado dessa busca.` };
    for (const token of rest.split(",").map((part) => part.trim()).filter(Boolean)) {
      const date = dates.get(token);
      if (!date) return { error: `"${token}" não é uma data de ${month} no resultado dessa busca.` };
      kept.add(date);
    }
  }
  return { kept };
}

let columnCount = 0;

// A disclosure button instead of <details>: the cabin's Copiar and edit buttons
// sit in the header, and interactive content inside <summary> is invalid; it
// also kept them reachable while the cabin is collapsed.
function createColumn(title, extraClass = "") {
  const column = document.createElement("section");
  column.className = `column ${extraClass}`.trim();
  const bodyId = `column-${++columnCount}`;
  column.innerHTML = `
    <div class="column-header">
      <h3 class="column-title">
        <button type="button" class="column-toggle" aria-expanded="true" aria-controls="${bodyId}">
          <span class="chevron" aria-hidden="true">›</span>
          <span class="column-label"></span>
        </button>
      </h3>
      <div class="column-actions">
        <button type="button" class="edit-dates-button" title="Editar datas do alerta" aria-label="Editar datas do alerta" aria-pressed="false"></button>
        <button type="button" class="copy-button">Copiar</button>
      </div>
    </div>
    <div class="column-body" id="${bodyId}">
      <p class="column-summary"></p>
      <div class="date-chips"></div>
    </div>`;
  column.querySelector(".column-label").textContent = title;
  const toggle = column.querySelector(".column-toggle");
  toggle.addEventListener("click", () => setColumnExpanded(column, toggle.getAttribute("aria-expanded") !== "true"));
  return column;
}

function setColumnExpanded(column, expanded) {
  column.querySelector(".column-toggle").setAttribute("aria-expanded", String(expanded));
  column.querySelector(".column-body").hidden = !expanded;
}

// Each leg collapses on its own: with both legs on screen, reaching the return
// used to mean scrolling the whole outbound.
function renderLeg(targetEl, label, columnsClass, fillColumns) {
  const root = document.createElement("details");
  root.className = "leg";
  root.open = true;

  const title = document.createElement("summary");
  title.className = "leg-title";
  title.textContent = label;
  root.appendChild(title);

  const columns = document.createElement("div");
  columns.className = columnsClass;
  fillColumns(columns);
  root.appendChild(columns);
  targetEl.appendChild(root);
}

function renderTapLeg(targetEl, label, report) {
  renderLeg(targetEl, label, "columns", (columns) => {
    for (const [title, columnClass, section, colorClass] of [
      ["Executiva", "column-business", report.business, "cabin-business"],
      ["Econômica", "column-economy", report.economy, "cabin-economy"],
    ]) {
      const column = createColumn(title, columnClass);
      columns.appendChild(column);
      renderColumn(column, section, colorClass);
    }
  });
}

// For sources whose cabins come from the server, so columns are built on the fly.
function renderLegSections(targetEl, label, sections) {
  renderLeg(targetEl, label, "columns columns-3", (columns) => {
    for (const section of sections) {
      const column = createColumn(section.label, section.colorClass?.replace("cabin-", "column-"));
      columns.appendChild(column);
      renderColumn(column, section, section.colorClass);
    }
  });
}

function ceilingInMiles(input) {
  const value = parseFloat(input.value);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null;
}

function showFailure(card, err) {
  card.setStatus("Erro", "status-error");
  showNotice(card.noticeEl, err.message || "Erro inesperado.");
}

function showPartialNotices(card, notices) {
  if (notices.length === 0) return;
  showNotice(card.noticeEl, [...new Set(notices)].join(" "));
}

async function startTapSearch(origin, destination, roundTrip, ceilings, session) {
  session = session || newSession("tap", [origin, destination, roundTrip, ceilings]);
  const card = createJobCard(tapQueue, { program: "TAP", origin, destination, roundTrip });
  const partialNotices = [];

  try {
    const outbound = await runOnServer(
      card,
      { source: "tap", origin, destination, ceilings },
      roundTrip ? "Buscando ida…" : "Buscando…",
      session,
    );
    const outboundReport = outbound.result;
    if (outbound.appliedCeilings) {
      setFacts(card.ceilingsEl, [
        { text: "Teto aplicado", className: "fact-lead" },
        `Executiva ${outbound.appliedCeilings.businessK}K`,
        `Econômica ${outbound.appliedCeilings.economyK}K`,
      ]);
      card.ceilingsEl.hidden = false;
    }
    if (outbound.partialNotice) partialNotices.push(outbound.partialNotice);
    const outboundLabel = roundTrip ? `Ida: ${origin} → ${destination}` : `${origin} → ${destination}`;
    renderTapLeg(card.resultEl, outboundLabel, outboundReport);
    card.upgradeLegs.push({ label: outboundLabel, business: outboundReport.business.days, economy: outboundReport.economy.days });
    recordLegForCopy(card, [
      { label: "Executiva", ...outboundReport.business },
      { label: "Econômica", ...outboundReport.economy },
    ]);

    // When you stopped the outbound (empty windows usually mean the source is
    // down), the return does not start: it would spend 10 more AwardTool
    // searches to bring the same emptiness.
    let returnReport = null;
    if (roundTrip && outbound.stoppedByUser) {
      partialNotices.push("A volta não foi buscada. Você interrompeu a ida, e a volta gastaria as mesmas buscas no site.");
    } else if (roundTrip) {
      const inbound = await runOnServer(
        card,
        { source: "tap", origin: destination, destination: origin, ceilings },
        "Buscando volta…",
        session,
      );
      returnReport = inbound.result;
      if (inbound.partialNotice) partialNotices.push(inbound.partialNotice);
      const returnLabel = `Volta: ${destination} → ${origin}`;
      renderTapLeg(card.resultEl, returnLabel, returnReport);
      card.upgradeLegs.push({ label: returnLabel, business: returnReport.business.days, economy: returnReport.economy.days });
      recordLegForCopy(card, [
        { label: "Executiva", ...returnReport.business },
        { label: "Econômica", ...returnReport.economy },
      ]);
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = card.minimized;
    card.hasSubtabs = true;
    card.subtabsEl.hidden = card.minimized;
    showPartialNotices(card, partialNotices);
    updateCardActions(card);
    showAlertButtons(card, "tap", origin, destination, [
      { cabinClass: "Executiva", outbound: outboundReport.business, inbound: returnReport?.business },
      { cabinClass: "Econômica", outbound: outboundReport.economy, inbound: returnReport?.economy },
    ]);
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
}

// One SeatSpy search already brings both legs (and spends a single credit).
async function startSeatspySearch(program, origin, destination, roundTrip, showSeats, session) {
  session = session || newSession("seatspy", [program, origin, destination, roundTrip, showSeats]);
  const card = createJobCard(seatspyQueue, { program: PROGRAM_LABELS[program] || program, origin, destination, roundTrip });

  try {
    const { result: legs } = await runOnServer(
      card,
      {
        source: "seatspy",
        airline: program,
        origin,
        destination,
        roundTrip,
        showSeats,
        ceilings: {
          economy: ceilingInMiles(seatspyEconomyCeilingInput),
          premium: ceilingInMiles(seatspyPremiumCeilingInput),
          business: ceilingInMiles(seatspyBusinessCeilingInput),
          first: ceilingInMiles(seatspyFirstCeilingInput),
        },
      },
      roundTrip ? "Buscando ida e volta…" : "Buscando…",
      session,
    );
    for (const leg of legs) {
      renderLegSections(card.resultEl, leg.label, leg.sections);
      recordLegForCopy(card, leg.sections);
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = card.minimized;
    // No Upgrade tab: the upgrade is a TAP product; on SeatSpy's programs it
    // promised a move those airlines do not offer.
    updateCardActions(card);
    // SeatSpy's "Premium" is "Premium Economy" in the portal's naming.
    const sectionOf = (leg, label) => leg?.sections.find((section) => section.label === label);
    showAlertButtons(card, program, origin, destination, [
      { cabinClass: "Econômica", outbound: sectionOf(legs[0], "Econômica"), inbound: sectionOf(legs[1], "Econômica") },
      { cabinClass: "Premium Economy", outbound: sectionOf(legs[0], "Premium"), inbound: sectionOf(legs[1], "Premium") },
      { cabinClass: "Executiva", outbound: sectionOf(legs[0], "Executiva"), inbound: sectionOf(legs[1], "Executiva") },
      { cabinClass: "Primeira Classe", outbound: sectionOf(legs[0], "Primeira Classe"), inbound: sectionOf(legs[1], "Primeira Classe") },
    ]);
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
}

// Google Sheets may be down or unconfigured; the local CSV always exists when
// there was a flight. Showing the path avoids the "where is the sheet?" question.
function showLocalFile(card, path, label) {
  if (!path) return;
  const block = document.createElement("p");
  block.className = "spreadsheet-link";
  setIconLabel(block, "file", `Planilha da ${label} em ${path}`);
  card.root.appendChild(block);
}

function showSpreadsheetLink(card, url, label) {
  if (!url) return;
  const block = document.createElement("p");
  block.className = "spreadsheet-link";
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  setIconLabel(link, "sheet", `Planilha da ${label}`);
  block.append(link);
  card.root.appendChild(block);
}

// One direction per job (the endpoint is one-way), all three cabins together.
async function startSmilesSearch(origin, destination, ceilings, roundTrip, period, session) {
  session = session || newSession("smiles", [origin, destination, ceilings, roundTrip, period]);
  const card = createJobCard(smilesQueue, { program: "Smiles", origin, destination, roundTrip });
  const partialNotices = [];
  const baseBody = { source: "smiles", ceilings, period };

  try {
    const outbound = await runOnServer(
      card,
      { ...baseBody, origin, destination },
      roundTrip ? "Buscando ida…" : "Buscando…",
      session,
    );
    const outboundLegs = outbound.result;
    if (outbound.partialNotice) partialNotices.push(outbound.partialNotice);
    renderLegSections(card.resultEl, roundTrip ? `Ida: ${origin} → ${destination}` : `${origin} → ${destination}`, outboundLegs[0].sections);
    recordLegForCopy(card, outboundLegs[0].sections);

    let returnLegs = null;
    let returnSpreadsheetUrl = null;
    let returnSearchId = null;
    if (roundTrip) {
      const inbound = await runOnServer(
        card,
        { ...baseBody, origin: destination, destination: origin },
        "Buscando volta…",
        session,
      );
      returnLegs = inbound.result;
      returnSpreadsheetUrl = inbound.spreadsheetUrl;
      returnSearchId = inbound.searchId;
      if (inbound.partialNotice) partialNotices.push(inbound.partialNotice);
      renderLegSections(card.resultEl, `Volta: ${destination} → ${origin}`, returnLegs[0].sections);
      recordLegForCopy(card, returnLegs[0].sections);
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = card.minimized;
    showPartialNotices(card, partialNotices);
    updateCardActions(card);
    showSpreadsheetLink(card, outbound.spreadsheetUrl, roundTrip ? "ida" : "busca");
    showSpreadsheetLink(card, returnSpreadsheetUrl, "volta");

    showAlertButtons(card, "SMILES", origin, destination, smilesAlertOptions(outboundLegs[0].sections, returnLegs?.[0].sections));

    const legs = [{ label: roundTrip ? `Ida: ${origin} → ${destination}` : `${origin} → ${destination}`, searchId: outbound.searchId }];
    if (roundTrip) legs.push({ label: `Volta: ${destination} → ${origin}`, searchId: returnSearchId });
    if (legs.every((leg) => leg.searchId)) addFlightFilter(card, { origin, destination, ceilings, legs });
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
}

// The portal calls Smiles' "Conforto" by its own name, "Premium Economy".
function smilesAlertOptions(outboundSections, returnSections) {
  const sectionOf = (sections, label) => sections?.find((section) => section.label === label);
  return [
    { cabinClass: "Econômica", outbound: sectionOf(outboundSections, "Econômica"), inbound: sectionOf(returnSections, "Econômica") },
    { cabinClass: "Premium Economy", outbound: sectionOf(outboundSections, "Conforto"), inbound: sectionOf(returnSections, "Conforto") },
    { cabinClass: "Executiva", outbound: sectionOf(outboundSections, "Executiva"), inbound: sectionOf(returnSections, "Executiva") },
  ];
}

// Replaces the spreadsheet step: filter the search's flights by who operates
// them, stops and miles, and the card's dates, copy text and alerts follow. The
// server filters and rebuilds the dates with the search's own rules.
const SMILES_FILTER_CABINS = [
  ["economy", "Econômica"],
  ["premium", "Conforto"],
  ["business", "Executiva"],
];
let flightFilterCount = 0;
const FILTER_TYPING_MS = 500;

async function filterSmilesLeg(searchId, filter) {
  const response = await apiFetch(`/api/smiles/flights/${encodeURIComponent(searchId)}/filter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filter),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error || "Não deu para filtrar os voos dessa busca.");
  return body;
}

function addFlightFilter(card, ctx) {
  const id = `flight-filter-${++flightFilterCount}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "action-button";
  toggle.textContent = "Filtrar voos";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", id);
  card.minimizeButton.before(toggle);

  const panel = document.createElement("form");
  panel.id = id;
  panel.className = "flight-filter";
  panel.noValidate = true;
  panel.hidden = true;
  const milesFields = SMILES_FILTER_CABINS.map(
    ([cabin, label]) => `
      <div class="field flight-filter-range" role="group" aria-labelledby="${id}-${cabin}-label">
        <span class="flight-filter-range-label" id="${id}-${cabin}-label">${label} (K)</span>
        <div class="flight-filter-range-inputs">
          <input name="${cabin}-min" type="number" min="1" step="any" placeholder="mín." aria-label="${label}, mínimo em mil milhas" autocomplete="off" />
          <span aria-hidden="true">a</span>
          <input name="${cabin}-max" type="number" min="1" step="any" placeholder="máx." aria-label="${label}, máximo em mil milhas" autocomplete="off" />
        </div>
        <div class="flight-filter-values" data-cabin="${cabin}" aria-label="Valores dos voos de ${label}"></div>
      </div>`,
  ).join("");
  panel.innerHTML = `
    <fieldset class="flight-filter-carriers">
      <legend>Operado por</legend>
      <div class="flight-filter-options"><span class="flight-filter-hint">Carregando as companhias…</span></div>
      <p class="flight-filter-hint">Sem nenhuma marcada, valem todas. Com alguma marcada, só entram voos em que todos os trechos são operados por elas.</p>
    </fieldset>
    <div class="flight-filter-fields">
      <div class="field">
        <label for="${id}-stops">Conexões</label>
        <select id="${id}-stops" name="maxStops">
          <option value="">Qualquer</option>
          <option value="0">Só voo direto</option>
          <option value="1">Até 1 conexão</option>
          <option value="2">Até 2 conexões</option>
        </select>
      </div>
      ${milesFields}
    </div>
    <p class="flight-filter-hint flight-filter-ceiling" hidden></p>
    <div class="flight-filter-actions">
      <button type="button" class="action-button flight-filter-clear">Limpar</button>
      <button type="button" class="action-button flight-filter-hide">Minimizar filtros</button>
      <span class="flight-filter-status" role="status"></span>
    </div>`;
  card.noticeEl.before(panel);

  const options = panel.querySelector(".flight-filter-options");
  const status = panel.querySelector(".flight-filter-status");
  const ceilingNote = panel.querySelector(".flight-filter-ceiling");
  const searchCeilings = SMILES_FILTER_CABINS.filter(([cabin]) => ctx.ceilings?.[cabin]).map(
    ([cabin, label]) => `${label} ${ctx.ceilings[cabin] / 1000}K`,
  );
  if (searchCeilings.length) {
    // The sweep only fetched the flights of days under the search's ceiling.
    ceilingNote.textContent = `A busca só detalhou os dias abaixo do teto dela (${searchCeilings.join(", ")}). Um máximo acima disso não traz dias novos.`;
    ceilingNote.hidden = false;
  }

  const readFilter = () => {
    const form = new FormData(panel);
    const carriers = form.getAll("carrier");
    const filter = {};
    if (carriers.length) filter.carriers = carriers;
    if (form.get("maxStops") !== "") filter.maxStops = Number(form.get("maxStops"));
    const miles = {};
    for (const [cabin] of SMILES_FILTER_CABINS) {
      const range = {};
      for (const bound of ["min", "max"]) {
        const value = parseFloat(form.get(`${cabin}-${bound}`));
        if (Number.isFinite(value) && value > 0) range[bound] = Math.round(value * 1000);
      }
      if (Object.keys(range).length) miles[cabin] = range;
    }
    if (Object.keys(miles).length) filter.miles = miles;
    return filter;
  };

  const run = async (filter) => {
    status.textContent = "Filtrando…";
    const results = await Promise.all(ctx.legs.map((leg) => filterSmilesLeg(leg.searchId, filter)));
    return results;
  };

  // The cheapest cabin the airline flies on its own, so its chip says what it costs.
  const startingPrice = (from) => {
    const found = SMILES_FILTER_CABINS.find(([cabin]) => from[cabin] != null);
    if (!found) return "";
    const [cabin, label] = found;
    return `, a partir de ${integerFormat.format(from[cabin])}${cabin === "economy" ? "" : ` na ${label}`}`;
  };

  // Rebuilt on every change (the starting prices follow the stops), keeping what was checked.
  const showCarriers = (results) => {
    const checked = new Set(new FormData(panel).getAll("carrier"));
    const byCode = new Map();
    for (const option of results.flatMap((result) => result.carrierOptions)) {
      const known = byCode.get(option.code);
      const from = { ...known?.from };
      for (const [cabin, miles] of Object.entries(option.from)) from[cabin] = Math.min(from[cabin] ?? miles, miles);
      byCode.set(option.code, { ...option, from, flights: (known?.flights ?? 0) + option.flights });
    }
    options.replaceChildren(
      ...[...byCode.values()]
        .sort((a, b) => b.flights - a.flights)
        .map((option) => {
          const label = document.createElement("label");
          label.className = "flight-filter-carrier";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.name = "carrier";
          input.value = option.code;
          input.checked = checked.has(option.code);
          const code = document.createElement("strong");
          code.textContent = option.code;
          const name = document.createElement("span");
          name.textContent = `${option.name} (${plural(option.flights, "voo", "voos")}${startingPrice(option.from)})`;
          label.append(input, code, name);
          return label;
        }),
    );
    const unknown = results.reduce((total, result) => total + result.flightsWithoutCarrier, 0);
    if (unknown > 0) {
      const note = document.createElement("span");
      note.className = "flight-filter-hint";
      note.textContent = `${plural(unknown, "voo veio", "voos vieram")} sem operador informado e só entram sem companhia marcada.`;
      options.append(note);
    }
  };

  // Like the spreadsheet's filter by values: every price there is, to pick a
  // limit from. A click makes that value the cabin's maximum.
  const showMilesValues = (results) => {
    for (const list of panel.querySelectorAll(".flight-filter-values")) {
      const cabin = list.dataset.cabin;
      const byMiles = new Map();
      for (const option of results.flatMap((result) => result.milesOptions[cabin])) {
        byMiles.set(option.miles, (byMiles.get(option.miles) ?? 0) + option.flights);
      }
      const maxInput = panel.querySelector(`input[name="${cabin}-max"]`);
      list.replaceChildren(
        ...[...byMiles.entries()]
          .sort(([a], [b]) => a - b)
          .map(([miles, flights]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "flight-filter-value";
            button.title = "Usar como máximo";
            const value = document.createElement("span");
            value.textContent = integerFormat.format(miles);
            const count = document.createElement("span");
            count.className = "flight-filter-value-count";
            count.textContent = plural(flights, "voo", "voos");
            button.append(value, count);
            button.addEventListener("click", () => {
              maxInput.value = String(miles / 1000);
              maxInput.dispatchEvent(new Event("change", { bubbles: true }));
            });
            return button;
          }),
      );
      if (byMiles.size === 0) {
        const empty = document.createElement("span");
        empty.className = "flight-filter-hint";
        empty.textContent = "Nenhum voo nessa cabine.";
        list.append(empty);
      }
    }
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Esconder filtros" : "Filtrar voos";
  };

  toggle.addEventListener("click", async () => {
    setOpen(panel.hidden);
    if (panel.hidden || card.flightFilterLoaded) return;
    card.flightFilterLoaded = true;
    try {
      const results = await run({});
      showCarriers(results);
      showMilesValues(results);
      status.textContent = "";
    } catch (err) {
      card.flightFilterLoaded = false;
      options.replaceChildren();
      status.textContent = err.message;
    }
  });

  // Applied on every change, so picking an airline at once shows its prices.
  // Only the latest answer is drawn: an older one arriving late must not win.
  let latest = 0;
  const apply = async (filter, appliedText) => {
    const mine = ++latest;
    try {
      const results = await run(filter);
      if (mine !== latest) return;
      redrawSmilesCard(card, ctx, results);
      showCarriers(results);
      showMilesValues(results);
      status.textContent = appliedText;
    } catch (err) {
      if (mine === latest) status.textContent = err.message;
    }
  };

  const applyCurrent = () => {
    const filter = readFilter();
    apply(
      filter,
      Object.keys(filter).length
        ? "Filtro aplicado: as datas, a cópia e os alertas abaixo seguem o filtro. Datas tiradas à mão voltaram."
        : "Sem filtro: todas as datas da busca.",
    );
  };

  let typing = null;
  panel.addEventListener("change", applyCurrent);
  // Typed limits wait for a pause, so "372,5" is not filtered as 3, 37 and 372 first.
  panel.addEventListener("input", (event) => {
    if (event.target.type !== "number") return;
    clearTimeout(typing);
    typing = setTimeout(applyCurrent, FILTER_TYPING_MS);
  });
  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(typing);
    applyCurrent();
  });
  panel.querySelector(".flight-filter-clear").addEventListener("click", () => {
    panel.reset();
    clearTimeout(typing);
    applyCurrent();
  });
  panel.querySelector(".flight-filter-hide").addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });
}

function redrawSmilesCard(card, ctx, results) {
  card.resultEl.replaceChildren();
  card.copyLegs = [];
  ctx.legs.forEach((leg, index) => {
    renderLegSections(card.resultEl, leg.label, results[index].sections);
    recordLegForCopy(card, results[index].sections);
  });
  card.root.querySelector(":scope > .alert-actions")?.remove();
  markAlertsOutdated(card);
  showAlertButtons(card, "SMILES", ctx.origin, ctx.destination, smilesAlertOptions(results[0].sections, results[1]?.sections));
  updateCardActions(card);
}

// After a search, each cabin with availability becomes a "generate alert"
// button: the server renders the portal's official card and the WhatsApp
// caption, and returns the images ready to forward to the group.

// Min/max across both directions: the caption shows a single range.
function milesRange(outbound, inbound) {
  const mins = [outbound?.min, inbound?.min].filter((value) => value != null);
  const maxes = [outbound?.max, inbound?.max].filter((value) => value != null);
  return {
    minK: mins.length ? Math.min(...mins) : null,
    maxK: maxes.length ? Math.max(...maxes) : null,
  };
}

function hasDays(section) {
  return (section?.days?.length || 0) > 0;
}

async function requestAlert(body) {
  const response = await apiFetch("/api/alerts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const alert = await response.json();
  if (!response.ok) throw new Error(alert.error || "Falha ao gerar o alerta.");
  return alert;
}

// options: [{ cabinClass, outbound, inbound }]; only cabins with some availability become buttons.
// Who flies the dates going into the alert (dates taken out by hand excluded),
// so the alert names that airline. Only Smiles days carry it; an older card
// without it keeps the program's default airline.
function operatorsOf(sections) {
  const days = sections.filter(hasDays).flatMap((section) => section.days);
  if (days.length === 0 || days.some((day) => day.carriers === undefined)) return {};
  if (days.some((day) => day.carriers === null)) {
    throw new Error("Algumas datas desse alerta são de voos sem companhia informada. Filtre os voos por companhia para o alerta dizer quem opera.");
  }
  const byCode = new Map(days.flatMap((day) => day.carriers).map((carrier) => [carrier.code, carrier]));
  return { operators: [...byCode.values()] };
}

function showAlertButtons(card, source, origin, destination, options) {
  const withData = options.filter((option) => hasDays(option.outbound) || hasDays(option.inbound));
  if (withData.length === 0) return;

  const bar = document.createElement("div");
  bar.className = "alert-actions";
  const label = document.createElement("span");
  label.className = "alert-label";
  label.textContent = "Alerta pro grupo:";
  bar.appendChild(label);

  for (const option of withData) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "alert-button";
    setAlertButtonState(button, option.cabinClass, "idle");
    button.addEventListener("click", async () => {
      button.disabled = true;
      setAlertButtonState(button, option.cabinClass, "busy");
      try {
        const outbound = keptSection(option.outbound);
        const inbound = keptSection(option.inbound);
        if (!hasDays(outbound) && !hasDays(inbound)) {
          throw new Error(`Todas as datas de ${option.cabinClass} foram tiradas do alerta.`);
        }
        const alert = await requestAlert({
          source,
          origin,
          destination,
          cabinClass: option.cabinClass,
          ...milesRange(outbound, inbound),
          outboundText: hasDays(outbound) ? outbound.text : "",
          returnText: hasDays(inbound) ? inbound.text : "",
          ...operatorsOf([outbound, inbound]),
        });
        showGeneratedAlert(card, alert);
        setAlertButtonState(button, option.cabinClass, "done");
      } catch (err) {
        setAlertButtonState(button, option.cabinClass, "idle");
        showNotice(card.noticeEl, err.message || "Falha ao gerar o alerta.");
      } finally {
        button.disabled = false;
      }
    });
    // The alert already on screen no longer matches the dates: back to idle so it gets generated again.
    card.root.addEventListener("alert-dates-changed", () => {
      if (button.isConnected && !button.disabled) setAlertButtonState(button, option.cabinClass, "idle");
    });
    bar.appendChild(button);
  }
  // At the top, right under the header: generating the alert is what happens as
  // soon as the search ends, and at the bottom it sat behind months of results.
  card.root.querySelector(".job-header").after(bar);
}

// An "images + caption + copy" block, used for the main alert and the combinations one.
function appendCaption(block, label, caption) {
  if (label) {
    const labelEl = document.createElement("div");
    labelEl.className = "alert-caption-label";
    labelEl.textContent = label;
    block.appendChild(labelEl);
  }

  const captionEl = document.createElement("pre");
  captionEl.className = "alert-caption";
  captionEl.textContent = caption;
  block.appendChild(captionEl);

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-button";
  const idleLabel = label ? `Copiar ${label.toLowerCase()}` : "Copiar legenda";
  copyButton.textContent = idleLabel;
  copyButton.addEventListener("click", () => copyToClipboard(copyButton, caption, idleLabel));
  block.appendChild(copyButton);
}

function alertBlock(title, images, caption, { returnCaption, returnCaptionError } = {}) {
  const block = document.createElement("div");
  block.className = "alert-result";

  if (title) {
    const titleEl = document.createElement("div");
    titleEl.className = "alert-title";
    titleEl.textContent = title;
    block.appendChild(titleEl);
  }

  const gallery = document.createElement("div");
  gallery.className = "alert-gallery";
  for (const [index, url] of images.entries()) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.download = url.split("/").pop();
    const image = document.createElement("img");
    image.src = url;
    image.width = 220;
    image.decoding = "async";
    image.alt = images.length > 1 ? `Card ${index + 1} de ${images.length} do alerta` : "Card do alerta";
    link.appendChild(image);
    gallery.appendChild(link);
  }
  block.appendChild(gallery);

  const hasReturn = Boolean(returnCaption || returnCaptionError);
  appendCaption(block, hasReturn ? "Legenda da ida" : "", caption);
  if (returnCaption) appendCaption(block, "Legenda da volta", returnCaption);
  if (returnCaptionError) {
    const error = document.createElement("p");
    error.className = "notice";
    error.textContent = returnCaptionError;
    block.appendChild(error);
  }

  return block;
}

function showGeneratedAlert(card, { images, caption, comboImage, comboCaption, returnCaption, returnCaptionError }) {
  // Combos only come when outbound and return dates cross: the alert sent after
  // the main one, with the combinations ready.
  const hasCombo = Boolean(comboImage);
  insertAfterAlert(card, alertBlock(hasCombo ? "Alerta principal" : "", images, caption, { returnCaption, returnCaptionError }));
  if (hasCombo) insertAfterAlert(card, alertBlock("Combinações ida + volta", [comboImage], comboCaption || ""));
}

function markAlertsOutdated(card) {
  for (const block of card.root.querySelectorAll(":scope > .alert-result:not(.alert-outdated)")) {
    block.classList.add("alert-outdated");
    const warning = document.createElement("p");
    warning.className = "alert-outdated-warning";
    warning.textContent = "Desatualizado: as datas mudaram depois deste alerta. Gere de novo.";
    block.prepend(warning);
  }
}

// Stacks generated blocks in order right under the bar that produced them, never
// after the result, which may have a year of dates in front.
function insertAfterAlert(card, block) {
  const previous = card.root.querySelectorAll(":scope > .alert-result");
  const anchor = previous.length ? previous[previous.length - 1] : card.root.querySelector(":scope > .alert-actions");
  if (anchor) anchor.after(block);
  else card.root.querySelector(".job-header").after(block);
}

// A clickable shortcut at the top of the card: each leg's cheapest day with its
// booking link. Every day stays clickable; this only saves scrolling a year of dates.
function showAaBookingShortcut(card, legs) {
  const rows = legs.map(({ label, section }) => ({ label, day: cheapestDayWithLink(section) })).filter(({ day }) => day);
  if (rows.length === 0) return;

  const block = document.createElement("div");
  block.className = "aa-booking-shortcut";

  const title = document.createElement("div");
  title.className = "alert-title";
  title.textContent = "Ir direto pra emissão";
  block.appendChild(title);

  for (const { label, day } of rows) {
    const row = document.createElement("div");
    row.className = "pair-row";

    const value = document.createElement("strong");
    value.className = "pair-value";
    value.textContent = `${day.valueK}K`;

    const dates = document.createElement("span");
    dates.className = "pair-dates";
    setFacts(dates, [label, formatShortDate(day.date)]);

    const link = document.createElement("a");
    link.className = "pair-open";
    link.href = day.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Abrir no site da American";

    row.append(value, dates, link);
    block.appendChild(row);
  }

  card.root.querySelector(".job-header").after(block);
}

// Ties keep the first one, the nearest: days come in chronological order.
function cheapestDayWithLink(section) {
  const withLink = (section?.days ?? []).filter((day) => day.link);
  if (withLink.length === 0) return null;
  return withLink.reduce((cheapest, day) => (day.valueK < cheapest.valueK ? day : cheapest));
}

// One cabin per search, one job per direction; no Upgrade tab (a single cabin never crosses another).
async function startAaSearch(origin, destination, cabin, maxStops, ceiling, roundTrip, passengers = 1, session) {
  session = session || newSession("aa", [origin, destination, cabin, maxStops, ceiling, roundTrip, passengers]);
  const cabinLabel = AA_CABIN_LABELS[cabin] || cabin;
  // One passenger is the common case; the title only mentions it when there are more.
  const passengersLabel = passengers > 1 ? `, ${passengers} passageiros` : "";
  const card = createJobCard(aaQueue, {
    program: "American Airlines",
    detail: `${cabinLabel}${passengersLabel}`,
    origin,
    destination,
    roundTrip,
  });
  const partialNotices = [];
  const baseBody = { source: "aa", cabin, maxStops, ceiling, passengers };

  try {
    const outbound = await runOnServer(
      card,
      { ...baseBody, origin, destination },
      roundTrip ? "Buscando ida…" : "Buscando…",
      session,
    );
    const outboundSection = outbound.result;
    if (outbound.partialNotice) partialNotices.push(outbound.partialNotice);
    renderLegSections(card.resultEl, roundTrip ? `Ida: ${origin} → ${destination}` : `${origin} → ${destination}`, [
      { ...outboundSection, label: cabinLabel, colorClass: AA_CABIN_CLASSES[cabin] },
    ]);
    recordLegForCopy(card, [outboundSection]);

    let returnSection = null;
    if (roundTrip) {
      const inbound = await runOnServer(
        card,
        { ...baseBody, origin: destination, destination: origin },
        "Buscando volta…",
        session,
      );
      returnSection = inbound.result;
      if (inbound.partialNotice) partialNotices.push(inbound.partialNotice);
      renderLegSections(card.resultEl, `Volta: ${destination} → ${origin}`, [
        { ...returnSection, label: cabinLabel, colorClass: AA_CABIN_CLASSES[cabin] },
      ]);
      recordLegForCopy(card, [returnSection]);
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = card.minimized;
    showPartialNotices(card, partialNotices);
    updateCardActions(card);
    // Before the alert bar: both go right under the header, and the last one in stays on top.
    showAaBookingShortcut(card, [
      { label: `${origin} → ${destination}`, section: outboundSection },
      ...(returnSection ? [{ label: `${destination} → ${origin}`, section: returnSection }] : []),
    ]);
    showAlertButtons(card, "aa", origin, destination, [
      { cabinClass: AA_CABIN_LABELS[cabin] || cabin, outbound: outboundSection, inbound: returnSection },
    ]);
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
}

// LATAM prices the PAIR, not the legs added up: the same GRU⇄JNB that cost
// 243.535 miles leg by leg costs 90.302 bought together. Each confirmed pair
// comes with LATAM's miles+cash ladder, from "all miles" to "fewest miles".
function showMilesConfirmation(card, confirmation) {
  const pairs = confirmation?.pairs ?? [];
  if (pairs.length === 0) return;

  const block = document.createElement("div");
  // Its own class: as `alert-result` it was taken for a generated alert, and new
  // alerts ended up after it, at the bottom of the card.
  block.className = "latam-confirmation";

  const title = document.createElement("div");
  title.className = "alert-title";
  title.textContent = "Ida e volta conferido";
  block.appendChild(title);

  for (const pair of pairs) block.appendChild(pairRow(pair));

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-button";
  copyButton.textContent = "Copiar";
  const text = pairs
    .map(
      (pair) =>
        `${pair.options[0].miles.toLocaleString("pt-BR")} pts + R$ ` +
        `${pair.options[0].totalReais.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} · ` +
        `${pair.outboundDate} → ${pair.returnDate}`,
    )
    .join("\n");
  copyButton.addEventListener("click", () => copyToClipboard(copyButton, text, "Copiar"));
  block.appendChild(copyButton);
  // Price near the top: it is the number people look for, and at the bottom it sat behind a year of dates.
  card.root.querySelector(".job-header").after(block);
}

function pairRow(pair) {
  const row = document.createElement("div");
  row.className = "pair-row";

  const value = document.createElement("strong");
  value.className = "pair-value";
  value.textContent = `${integerFormat.format(pair.options[0].miles)} pts + ${reaisCentsFormat.format(pair.options[0].totalReais)}`;

  const dates = document.createElement("span");
  dates.className = "pair-dates";
  dates.textContent = `${formatShortDate(pair.outboundDate)} → ${formatShortDate(pair.returnDate)}`;

  row.append(value, dates);

  // The capture of LATAM's screen sits behind a link: it is proof, not something to fill the screen every time.
  if (pair.image) {
    const link = document.createElement("a");
    link.className = "pair-capture";
    link.href = pair.image;
    link.target = "_blank";
    link.textContent = "Ver captura da LATAM";
    row.appendChild(link);
  }
  return row;
}

// The alert card is PER LEG: one price on the outbound card and one on the
// return. The pair's total put the whole trip's price on both cards, doubling
// the value in the reader's eyes.
function milesOf(pairs) {
  return pairs.flatMap((pair) => [pair.outboundMiles, pair.returnMiles]).filter((value) => typeof value === "number");
}

// The LATAM alert carries ALL calendar dates; the confirmed pairs only bring the
// price. "These are the dates with availability" is what the client wants, not
// "these three pairs I checked". Without a confirmation there is no button: a
// LATAM alert without the points number would be a card with a blank price.
function showLatamAlertButton(card, origin, destination, legs, confirmation) {
  const pairs = confirmation?.pairs ?? [];
  if (pairs.length === 0) return;

  const economyOf = (leg) => leg?.sections?.find((section) => section.label === "Econômica");
  const outboundSection = economyOf(legs[0]);
  const inboundSection = economyOf(legs[1]);
  if (!hasDays(outboundSection) && !hasDays(inboundSection)) return;
  if (milesOf(pairs).length === 0) return;

  const bar = document.createElement("div");
  bar.className = "alert-actions";
  const label = document.createElement("span");
  label.className = "alert-label";
  label.textContent = "Alerta pro grupo:";
  bar.appendChild(label);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "alert-button";
  setAlertButtonState(button, "Econômica", "idle");
  button.title = "Todas as datas do calendário, com os pontos vindos dos pares confirmados";
  button.addEventListener("click", async () => {
    button.disabled = true;
    setAlertButtonState(button, "Econômica", "busy");
    try {
      const outbound = keptSection(outboundSection);
      const inbound = keptSection(inboundSection);
      if (!hasDays(outbound) && !hasDays(inbound)) {
        throw new Error("Todas as datas da Econômica foram tiradas do alerta.");
      }
      // A pair whose date was taken out cannot lend its price: the card would
      // announce points for a day that is no longer in it.
      const keptPairs = pairs.filter(
        (pair) => !excludedOf(outboundSection).has(pair.outboundDate) && !excludedOf(inboundSection).has(pair.returnDate),
      );
      const perLeg = milesOf(keptPairs);
      if (perLeg.length === 0) {
        throw new Error("As datas dos pares conferidos em pontos foram tiradas do alerta, então o card ficaria sem preço.");
      }
      const alert = await requestAlert({
        source: "LATAM",
        origin,
        destination,
        cabinClass: "Econômica",
        minK: Math.min(...perLeg) / 1000,
        maxK: Math.max(...perLeg) / 1000,
        outboundText: hasDays(outbound) ? outbound.text : "",
        returnText: hasDays(inbound) ? inbound.text : "",
      });
      showGeneratedAlert(card, alert);
      setAlertButtonState(button, "Econômica", "done");
    } catch (err) {
      setAlertButtonState(button, "Econômica", "idle");
      showNotice(card.noticeEl, err.message || "Falha ao gerar o alerta.");
    } finally {
      button.disabled = false;
    }
  });
  card.root.addEventListener("alert-dates-changed", () => {
    if (!button.disabled) setAlertButtonState(button, "Econômica", "idle");
  });
  bar.appendChild(button);
  card.root.querySelector(".job-header").after(bar);
}

// One search returns both legs (the calendar has both directions, in reais).
// The alert comes from the miles confirmation, where the number the client pays shows up.
async function startLatamSearch(origin, destination, ceilings, confirmMiles, session) {
  session = session || newSession("latam", [origin, destination, ceilings, confirmMiles]);
  const card = createJobCard(latamQueue, { program: "LATAM", origin, destination, roundTrip: true });

  try {
    const { result: legs, partialNotice, confirmation } = await runOnServer(
      card,
      { source: "latam", origin, destination, ceilings, confirmMiles, outboundMarginReais: 100, returnMarginReais: 300 },
      "Buscando ida e volta…",
      session,
    );
    for (const leg of legs) {
      renderLegSections(card.resultEl, leg.label, leg.sections);
      recordLegForCopy(card, leg.sections);
    }
    if (confirmation) showMilesConfirmation(card, confirmation);
    showLatamAlertButton(card, origin, destination, legs, confirmation);

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = card.minimized;
    if (partialNotice) showPartialNotices(card, [partialNotice]);
    updateCardActions(card);
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
}

function searchRoutes(origin, destination, roundTrip) {
  return roundTrip
    ? [
        [origin, destination],
        [destination, origin],
      ]
    : [[origin, destination]];
}

// Paid searches only enter the history when they end, so without this a double
// click on Buscar started the same paid search twice with no warning.
const runningSearches = new Map();

function trackRunning(program, origin, destination, roundTrip, search) {
  const keys = searchRoutes(origin, destination, roundTrip).map(([from, to]) => `${program}|${from}|${to}`);
  for (const key of keys) runningSearches.set(key, (runningSearches.get(key) || 0) + 1);
  search.finally(() => {
    for (const key of keys) {
      const count = runningSearches.get(key) - 1;
      if (count > 0) runningSearches.set(key, count);
      else runningSearches.delete(key);
    }
  });
}

// The paid sources have a query limit, so a route anyone searched recently asks
// before searching again. It reads the shared history, not just this browser's.
async function repeatWarning(program, origin, destination, roundTrip) {
  const quota = program === "tap" ? "do AwardTool" : "do SeatSpy";
  const spends = `Buscar de novo gasta outra consulta ${quota}.`;
  let history;
  try {
    history = await loadHistory();
  } catch (err) {
    return askUser({
      title: "Não deu para conferir o histórico",
      body: `${err.message} Se alguém já buscou esse trecho, essa busca gasta outra consulta ${quota}.`,
      confirmLabel: "Buscar mesmo assim",
    });
  }

  const routes = [];
  let running = false;
  for (const [from, to] of searchRoutes(origin, destination, roundTrip)) {
    if (runningSearches.has(`${program}|${from}|${to}`)) {
      running = true;
      routes.push({ origin: from, destination: to, lines: ["Você está buscando agora"] });
      continue;
    }
    const previous = latestSearchOf(history, from, to, program);
    if (!previous || Date.now() - previous.timestamp >= TOLERANCE_MS) continue;
    // A round trip found twice is one search: one sign with both directions.
    if (previous.roundTrip && routes.some((route) => route.previous === previous)) continue;
    const who = whoSearched(previous) || "Alguém";
    routes.push({
      origin: previous.roundTrip ? previous.origin : from,
      destination: previous.roundTrip ? previous.destination : to,
      roundTrip: previous.roundTrip,
      previous,
      lines: [
        `${who.charAt(0).toUpperCase()}${who.slice(1)} buscou ${formatRelativeTime(previous.timestamp)}`,
        formatDateTime(previous.timestamp),
      ],
    });
  }
  if (routes.length === 0) return true;

  return askUser({
    title: running ? "Essa busca ainda está rodando" : routes.length > 1 ? "Esses trechos já foram buscados" : "Esse trecho já foi buscado",
    routes,
    body: running ? spends : `A última busca tem menos de ${TOLERANCE_DAYS} dias. ${spends}`,
    confirmLabel: "Buscar de novo",
  });
}

tapForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice(tapNotice);
  const origin = tapOriginInput.value.trim().toUpperCase();
  const destination = tapDestinationInput.value.trim().toUpperCase();
  const roundTrip = tapRoundTripCheckbox.checked;
  if (!origin || !destination) {
    showNotice(tapNotice, "Preencha origem e destino.");
    return;
  }
  if (!(await repeatWarning("tap", origin, destination, roundTrip))) return;
  const inK = (input) => {
    const value = parseFloat(input.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  trackRunning(
    "tap",
    origin,
    destination,
    roundTrip,
    startTapSearch(origin, destination, roundTrip, {
      business: inK(tapBusinessCeilingInput),
      economy: inK(tapEconomyCeilingInput),
    }),
  );
});

latamForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearNotice(latamNotice);
  const origin = latamOriginInput.value.trim().toUpperCase();
  const destination = latamDestinationInput.value.trim().toUpperCase();
  if (!origin || !destination) {
    showNotice(latamNotice, "Preencha origem e destino.");
    return;
  }
  const ceiling = parseFloat(latamCeilingInput.value);
  // Searching LATAM is free, so there is no repeat warning like the paid sources have.
  startLatamSearch(
    origin,
    destination,
    {
      maxReais: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null,
      lowestFareOnly: latamLowestFareCheckbox.checked,
    },
    latamConfirmMilesCheckbox.checked,
  );
});

// One direction per job, like AA. No cabin: the grid returns one value per day
// without saying which cabin it is, so there is nothing to choose.
async function startIberiaSearch(origin, destination, ceilingAvios, roundTrip, detailDays = 0, maxStops = null, cabin = "", session) {
  session = session || newSession("iberia", [origin, destination, ceilingAvios, roundTrip, detailDays, maxStops, cabin]);
  const card = createJobCard(iberiaQueue, { program: "Iberia", detail: "Avios", origin, destination, roundTrip });
  const partialNotices = [];
  const baseBody = { source: "iberia", ceiling: ceilingAvios, detailDays, maxStops, cabins: cabin ? [cabin] : [] };

  try {
    const outbound = await runOnServer(
      card,
      { ...baseBody, origin, destination },
      roundTrip ? "Buscando ida…" : "Buscando…",
      session,
    );
    if (outbound.partialNotice) partialNotices.push(outbound.partialNotice);
    renderLegSections(card.resultEl, roundTrip ? `Ida: ${origin} → ${destination}` : `${origin} → ${destination}`, [
      { ...outbound.result, label: "Menor preço do dia, qualquer cabine", colorClass: "" },
    ]);
    recordLegForCopy(card, [outbound.result]);

    let inbound = null;
    if (roundTrip) {
      inbound = await runOnServer(
        card,
        { ...baseBody, origin: destination, destination: origin },
        "Buscando volta…",
        session,
      );
      if (inbound.partialNotice) partialNotices.push(inbound.partialNotice);
      renderLegSections(card.resultEl, `Volta: ${destination} → ${origin}`, [{ ...inbound.result, label: "Menor preço do dia, qualquer cabine", colorClass: "" }]);
      recordLegForCopy(card, [inbound.result]);
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = card.minimized;
    showPartialNotices(card, partialNotices);
    updateCardActions(card);
    // Without this the per-flight sheet was created and the card said nothing:
    // the file existed and so did the Google tab, but it looked like nothing was made.
    showSpreadsheetLink(card, outbound.spreadsheetUrl, roundTrip ? "ida" : "busca");
    showSpreadsheetLink(card, inbound?.spreadsheetUrl, "volta");
    showLocalFile(card, outbound.localFile, roundTrip ? "ida" : "busca");
    showLocalFile(card, inbound?.localFile, "volta");
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
}

iberiaForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearNotice(iberiaNotice);
  const origin = iberiaOriginInput.value.trim().toUpperCase();
  const destination = iberiaDestinationInput.value.trim().toUpperCase();
  if (!origin || !destination) {
    showNotice(iberiaNotice, "Preencha origem e destino.");
    return;
  }
  const ceilingK = parseFloat(iberiaCeilingInput.value);
  startIberiaSearch(
    origin,
    destination,
    Number.isFinite(ceilingK) && ceilingK > 0 ? ceilingK * 1000 : null,
    iberiaRoundTripCheckbox.checked,
    Number(iberiaDetailDaysSelect.value) || 0,
    iberiaStopsSelect.value === "" ? null : Number(iberiaStopsSelect.value),
    iberiaCabinSelect.value,
  );
});

aaForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearNotice(aaNotice);
  const origin = aaOriginInput.value.trim().toUpperCase();
  const destination = aaDestinationInput.value.trim().toUpperCase();
  if (!origin || !destination) {
    showNotice(aaNotice, "Preencha origem e destino.");
    return;
  }
  const ceilingK = parseFloat(aaCeilingInput.value);
  // Searching AA is free, so there is no repeat warning like the paid sources have.
  startAaSearch(
    origin,
    destination,
    aaCabinSelect.value,
    aaStopsSelect.value === "" ? null : Number(aaStopsSelect.value),
    Number.isFinite(ceilingK) && ceilingK > 0 ? ceilingK * 1000 : null,
    aaRoundTripCheckbox.checked,
    Number(aaPassengersSelect.value) || 1,
  );
});

// "31/12/2026" → "2026-12-31". A date that does not exist (31/02) is null, never
// rolled over into the next month.
function parseTypedDate(text) {
  const match = text.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day)
    ? iso
    : null;
}

// Mirrors SALE_WINDOW_DAYS in src/scrapers/smiles/smiles.scraper.ts: Smiles
// sells up to today + 329 days. The server would silently move a date outside
// the window (past → tomorrow, too far → last day on sale), so it is refused here.
const SMILES_SALE_WINDOW_DAYS = 330;

function localIsoDay(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function smilesDateError(input) {
  const text = input.value.trim();
  if (!text) return null;
  const iso = parseTypedDate(text);
  if (!iso) return /^\d{2}\/\d{2}\/\d{4}$/.test(text) ? `${text} não existe no calendário.` : "Data inválida. Use DD/MM/AAAA.";
  const firstDay = localIsoDay(1);
  const lastDay = localIsoDay(SMILES_SALE_WINDOW_DAYS - 1);
  if (iso < firstDay) return `Use a partir de ${formatFullDate(firstDay)}.`;
  if (iso > lastDay) return `A Smiles só vende até ${formatFullDate(lastDay)}.`;
  return null;
}

function setDateError(input, message) {
  const form = input.form;
  form.querySelector(`[data-error-for="${input.id}"]`).classList.toggle("is-open", Boolean(message));
  if (message) {
    document.getElementById(`${input.id}-error`).textContent = message;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", `${input.id}-error`);
  } else {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }
}

// Each field on its own, plus the order between them once both are valid. The
// message for the range goes on "Até", the field that has to change.
function validateSmilesDates() {
  const fromError = smilesDateError(smilesFromInput);
  let untilError = smilesDateError(smilesUntilInput);
  if (!fromError && !untilError && smilesFromInput.value.trim() && smilesUntilInput.value.trim()) {
    if (parseTypedDate(smilesUntilInput.value) < parseTypedDate(smilesFromInput.value)) {
      untilError = "Vem antes da data inicial.";
    }
  }
  setDateError(smilesFromInput, fromError);
  setDateError(smilesUntilInput, untilError);
  if (fromError) return smilesFromInput;
  if (untilError) return smilesUntilInput;
  return null;
}

// Builds DD/MM/AAAA from the typed digits and refuses a digit no day or month
// can have: "5" as a day becomes "05", a "4" after "3" in the day is dropped,
// and so is a "3" after "1" in the month. Impossible dates such as 31/02 are
// caught once the date is complete.
function maskTypedDate(text) {
  const parts = ["", "", ""];
  for (const digit of text.replace(/\D/g, "")) {
    const [day, month] = parts;
    if (day.length < 2) {
      if (day === "" && digit > "3") parts[0] = `0${digit}`;
      else if (!(day === "3" && digit > "1") && !(day === "0" && digit === "0")) parts[0] += digit;
    } else if (month.length < 2) {
      if (month === "" && digit > "1") parts[1] = `0${digit}`;
      else if (!(month === "1" && digit > "2") && !(month === "0" && digit === "0")) parts[1] += digit;
    } else if (parts[2].length < 4) {
      parts[2] += digit;
    }
  }
  return parts.filter(Boolean).join("/");
}

// Typing fills in the slashes; deleting is left alone so the caret never jumps
// while a date is being fixed. A half-typed date is never marked wrong: the
// check runs once all ten characters are in, or when the field is left.
for (const input of [smilesFromInput, smilesUntilInput]) {
  input.addEventListener("input", (event) => {
    if (event.inputType?.startsWith("insert")) input.value = maskTypedDate(input.value);
    if (input.value.length === 10) validateSmilesDates();
    else if (input.getAttribute("aria-invalid") === "true" && !smilesDateError(input)) setDateError(input, null);
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) validateSmilesDates();
  });
}

// Empty stays empty (the server's default period).
function readPeriod() {
  const invalidInput = validateSmilesDates();
  if (invalidInput) return { invalidInput };
  const period = {};
  if (smilesFromInput.value.trim()) period.from = parseTypedDate(smilesFromInput.value);
  if (smilesUntilInput.value.trim()) period.until = parseTypedDate(smilesUntilInput.value);
  return { period };
}

smilesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearNotice(smilesNotice);
  const origin = smilesOriginInput.value.trim().toUpperCase();
  const destination = smilesDestinationInput.value.trim().toUpperCase();
  if (!origin || !destination) {
    showNotice(smilesNotice, "Preencha origem e destino.");
    return;
  }
  const { period, invalidInput } = readPeriod();
  if (invalidInput) {
    invalidInput.focus();
    return;
  }
  // Searching Smiles is free: no repeat warning like the paid sources have.
  startSmilesSearch(
    origin,
    destination,
    {
      economy: ceilingInMiles(smilesEconomyCeilingInput),
      premium: ceilingInMiles(smilesPremiumCeilingInput),
      business: ceilingInMiles(smilesBusinessCeilingInput),
    },
    smilesRoundTripCheckbox.checked,
    period,
  );
});

// The form warns about a route the airline does not fly while it is typed, from
// the map the server reads off SeatSpy's own form. It only advises: the search
// still checks the live form before spending a credit, and decides.
const seatspyOriginOptions = document.getElementById("seatspy-origin-options");
const seatspyDestinationOptions = document.getElementById("seatspy-destination-options");
const seatspyRoutes = new Map();
const SHOWN_DESTINATIONS = 12;
let seatspyHintsRun = 0;

function seatspyRoutesOf(airline) {
  if (!seatspyRoutes.has(airline)) {
    const loading = apiFetch(`/api/seatspy/routes/${airline}`)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.origins) throw new Error(body?.error || `O servidor respondeu ${response.status}.`);
        return body.origins;
      })
      .catch((err) => {
        console.error(`Mapa de rotas do SeatSpy (${airline}) indisponível; a busca confere a rota sozinha:`, err);
        // Asked again next time instead of staying without hints until a reload.
        seatspyRoutes.delete(airline);
        return null;
      });
    seatspyRoutes.set(airline, loading);
  }
  return seatspyRoutes.get(airline);
}

function airportMatches(airport, code) {
  return airport.iata === code || airport.iatas.split(/[\s,]+/).includes(code);
}

function fillAirportOptions(datalist, airports) {
  datalist.replaceChildren(
    ...airports.map((airport) => {
      const option = document.createElement("option");
      option.value = airport.iata;
      option.label = airport.title;
      return option;
    }),
  );
}

const seatspyRouteHintReveal = document.getElementById("seatspy-route-hint-reveal");
const seatspyRouteHint = document.getElementById("seatspy-route-hint");

function setSeatspyHint(input, message) {
  seatspyRouteHintReveal.classList.toggle("is-open", Boolean(message));
  if (message) {
    seatspyRouteHint.textContent = message;
    input.setAttribute("aria-describedby", seatspyRouteHint.id);
  } else {
    input.removeAttribute("aria-describedby");
  }
}

async function updateSeatspyHints() {
  const run = ++seatspyHintsRun;
  const airline = seatspyProgramSelect.value;
  const origins = await seatspyRoutesOf(airline);
  // Typing on while the map loads must not leave a hint about older values.
  if (run !== seatspyHintsRun) return;
  setSeatspyHint(seatspyOriginInput, "");
  setSeatspyHint(seatspyDestinationInput, "");
  if (!origins) return;

  const airlineName = seatspyProgramSelect.selectedOptions[0].textContent;
  const origin = seatspyOriginInput.value.trim().toUpperCase();
  const destination = seatspyDestinationInput.value.trim().toUpperCase();
  fillAirportOptions(seatspyOriginOptions, Object.values(origins));
  if (origin.length !== 3) {
    seatspyDestinationOptions.replaceChildren();
    return;
  }

  const from = Object.values(origins).filter((airport) => airportMatches(airport, origin));
  if (from.length === 0) {
    seatspyDestinationOptions.replaceChildren();
    setSeatspyHint(seatspyOriginInput, `A ${airlineName} não tem voos saindo de ${origin} no SeatSpy.`);
    return;
  }
  const destinations = [...new Map(from.flatMap((airport) => airport.destinations).map((airport) => [airport.iata, airport])).values()];
  fillAirportOptions(seatspyDestinationOptions, destinations);
  if (destination.length !== 3 || destinations.some((airport) => airportMatches(airport, destination))) return;

  const named = destinations.slice(0, SHOWN_DESTINATIONS).map((airport) => `${airport.iata} (${airport.title})`);
  const more = destinations.length > SHOWN_DESTINATIONS ? ` e mais ${destinations.length - SHOWN_DESTINATIONS}` : "";
  setSeatspyHint(
    seatspyDestinationInput,
    `A ${airlineName} não voa ${origin} → ${destination} no SeatSpy. De ${origin}, ela voa para: ${named.join(", ")}${more}.`,
  );
}

seatspyProgramSelect.addEventListener("change", updateSeatspyHints);
seatspyOriginInput.addEventListener("input", updateSeatspyHints);
seatspyDestinationInput.addEventListener("input", updateSeatspyHints);
document.getElementById("tab-seatspy").addEventListener("click", updateSeatspyHints);

seatspyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice(seatspyNotice);
  const program = seatspyProgramSelect.value;
  const origin = seatspyOriginInput.value.trim().toUpperCase();
  const destination = seatspyDestinationInput.value.trim().toUpperCase();
  const roundTrip = seatspyRoundTripCheckbox.checked;
  if (!origin || !destination) {
    showNotice(seatspyNotice, "Preencha origem e destino.");
    return;
  }
  if (!(await repeatWarning(program, origin, destination, roundTrip))) return;
  trackRunning(
    program,
    origin,
    destination,
    roundTrip,
    startSeatspySearch(program, origin, destination, roundTrip, seatspyShowSeatsCheckbox.checked),
  );
});

// Runs last: every source's functions and form elements must already exist.
const tabFromUrl = location.hash.slice(1);
if (Object.hasOwn(panels, tabFromUrl)) activateTab(tabFromUrl);
if (tabFromUrl === "seatspy") updateSeatspyHints();
restoreSearches();
// The feed labels cards by who searched, and yours from another device should say "você".
whoAmI.finally(openFeed);
