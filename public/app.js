// A 401 means the login session ended (30 days, or the password changed), so
// the page goes back to the login and returns here afterwards.
async function apiFetch(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  return response;
}

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    if (response.ok) {
      location.href = "/login";
      return;
    }
    alert("Não foi possível sair. Tente de novo.");
  } catch (err) {
    console.error("Falha ao sair:", err);
    alert("Não foi possível conectar ao servidor para sair. Confira a conexão e tente de novo.");
  }
});

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
const clearHistoryButton = document.getElementById("clear-history-button");
const historyNotice = document.getElementById("history-notice");

const MONTHS_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const HISTORY_KEY = "awardtool.history.v2";
const LEGACY_HISTORY_KEY = "awardtool_historico";
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
  const list = [...buttons];
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
function migrateLegacyHistory() {
  const legacyAaCabins = { economica: "economy", premium: "premium", executiva: "business", primeira: "first" };
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY));
    if (!Array.isArray(legacy)) return;
    const migrated = legacy.map((item) => ({
      origin: item.origem,
      destination: item.destino,
      program: item.programa || "tap",
      roundTrip: Boolean(item.idaEVolta),
      ...(item.cabine ? { cabin: legacyAaCabins[item.cabine] || item.cabine } : {}),
      ...(item.passageiros ? { passengers: item.passageiros } : {}),
      timestamp: item.timestamp,
    }));
    localStorage.setItem(HISTORY_KEY, JSON.stringify([...loadHistory(), ...migrated]));
    localStorage.removeItem(LEGACY_HISTORY_KEY);
  } catch (err) {
    console.error("Não consegui migrar o histórico antigo:", err);
  }
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveToHistory(origin, destination, program, roundTrip = false, extras = {}) {
  const history = loadHistory();
  history.push({ origin, destination, program, roundTrip, ...extras, timestamp: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

// Legs that run in sequence enter the history as soon as the outbound ends; if
// the return also completes, the entry becomes a round trip instead of two entries.
function promoteLatestToRoundTrip(origin, destination, program) {
  const history = loadHistory();
  const latest = history
    .filter((item) => item.origin === origin && item.destination === destination && item.program === program)
    .reduce((newest, item) => (!newest || item.timestamp > newest.timestamp ? item : newest), null);
  if (latest) {
    latest.roundTrip = true;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }
}

// A round-trip entry covers both directions of the route.
function latestSearchOf(origin, destination, program) {
  const sameRoute = loadHistory().filter(
    (item) =>
      item.program === program &&
      ((item.origin === origin && item.destination === destination) ||
        (item.roundTrip && item.origin === destination && item.destination === origin)),
  );
  if (sameRoute.length === 0) return null;
  return sameRoute.reduce((newest, item) => (item.timestamp > newest.timestamp ? item : newest));
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
    seatspyOriginInput.focus();
  } else {
    showNotice(historyNotice, `Não há aba para repetir buscas do programa "${item.program}". Preencha a busca na aba do programa.`);
  }
}

// Older history kept both legs apart (A→B and B→A). Those pairs (same program,
// opposite directions, up to 3h apart) show as one ⇄ entry, with the outbound's
// direction and the time the return ended.
function groupForDisplay(history) {
  const PAIR_WINDOW_MS = 3 * 60 * 60 * 1000;
  const used = new Set();
  const display = [];

  for (let i = 0; i < history.length; i++) {
    if (used.has(i)) continue;
    const item = history[i];

    if (!item.roundTrip) {
      const j = history.findIndex(
        (other, k) =>
          k > i &&
          !used.has(k) &&
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
        // `timestamps` is the delete key: a merged pair deletes both entries.
        display.push({ ...outbound, roundTrip: true, timestamp: item.timestamp, timestamps: [outbound.timestamp, item.timestamp] });
        continue;
      }
    }
    display.push({ ...item, timestamps: [item.timestamp] });
  }
  return display;
}

function removeFromHistory(timestamps) {
  const targets = new Set(timestamps);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(loadHistory().filter((item) => !targets.has(item.timestamp))));
  renderHistory();
}

function renderHistory() {
  // A re-render would bring back the row hidden while its undo is pending.
  if (pendingRemoval?.kind === "history") finishPendingRemoval();
  clearNotice(historyNotice);
  const history = groupForDisplay(loadHistory().slice().sort((a, b) => b.timestamp - a.timestamp));
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
  setFacts(historySummary, [
    plural(history.length, "busca", "buscas"),
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

function createHistoryItem(item) {
  const row = document.createElement("div");
  row.className = `history-item accent-${item.program}`;

  const main = document.createElement("div");
  main.className = "history-item-main";

  const programTag = document.createElement("span");
  programTag.className = `program-tag tag-${item.program}`;
  programTag.textContent = PROGRAM_LABELS[item.program] || item.program;

  const route = document.createElement("span");
  route.className = "history-item-route";
  appendRoute(route, item.origin, item.destination, item.roundTrip);

  main.append(programTag, route);

  if (Date.now() - item.timestamp < TOLERANCE_MS) {
    const dot = document.createElement("span");
    dot.className = "recent-dot";
    dot.title = `Dentro da tolerância de ${TOLERANCE_DAYS} dias. Repetir esse trecho vai gerar aviso.`;
    main.appendChild(dot);
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

  right.append(time, relative);

  const spokenRoute = `${item.origin} para ${item.destination}${item.roundTrip ? ", ida e volta" : ""}`;
  const repeatButton = document.createElement("button");
  repeatButton.type = "button";
  repeatButton.className = "repeat-search-button";
  repeatButton.title = "Preencher a busca com esse trecho";
  repeatButton.setAttribute("aria-label", `Repetir a busca ${spokenRoute}`);
  repeatButton.innerHTML = ICONS.repeat;
  repeatButton.addEventListener("click", () => repeatSearch(item));

  // A round-trip entry that came from two entries deletes both, or the leftover
  // half would reappear on its own.
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-item-button";
  deleteButton.title = "Remover este trecho do histórico";
  deleteButton.setAttribute("aria-label", `Remover ${spokenRoute} do histórico`);
  deleteButton.innerHTML = ICONS.close;
  deleteButton.addEventListener("click", () =>
    removeWithUndo({
      kind: "history",
      message: `${item.origin} → ${item.destination} removido do histórico`,
      hide: () => (row.hidden = true),
      restore: () => {
        row.hidden = false;
        deleteButton.focus();
      },
      commit: () => removeFromHistory(item.timestamps || [item.timestamp]),
    }),
  );

  row.append(main, cabins, right, repeatButton, deleteButton);
  return row;
}

clearHistoryButton.addEventListener("click", () => {
  if (!confirm("Apagar todo o histórico de buscas? Isso não pode ser desfeito.")) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

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
let pendingRemoval = null;

// Removing only becomes final when the toast expires, so a click on the wrong
// Remover can be taken back. A new removal finalizes the previous one first.
function removeWithUndo({ kind, message, hide, restore, commit }) {
  finishPendingRemoval();
  hide();
  pendingRemoval = { kind, restore, commit, timer: setTimeout(finishPendingRemoval, UNDO_MS) };
  toastTextEl.textContent = message;
  toastEl.hidden = false;
  announce(`${message}. Use Desfazer para trazer de volta.`);
}

function finishPendingRemoval() {
  if (!pendingRemoval) return;
  const { commit, timer } = pendingRemoval;
  pendingRemoval = null;
  clearTimeout(timer);
  toastEl.hidden = true;
  commit();
}

toastEl.querySelector(".toast-undo").addEventListener("click", () => {
  if (!pendingRemoval) return;
  const { restore, timer } = pendingRemoval;
  pendingRemoval = null;
  clearTimeout(timer);
  toastEl.hidden = true;
  restore();
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
    card.stopButton.hidden = className === "status-done" || className === "status-error";
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
  card.minimizeButton.addEventListener("click", () => {
    card.minimized = !card.minimized;
    const activeSubtab = root.querySelector(".subtab-button.active")?.dataset.subtab || "dates";
    card.resultEl.hidden = card.minimized || activeSubtab !== "dates";
    card.upgradeSubpanelEl.hidden = card.minimized || activeSubtab !== "upgrade";
    card.subtabsEl.hidden = card.minimized;
    card.minimizeButton.textContent = card.minimized ? "Expandir" : "Minimizar";
  });

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
      hide: () => (root.hidden = true),
      restore: () => {
        root.hidden = false;
        card.removeButton.focus();
      },
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
  const list = loadSearches().filter((search) => search.id !== session.record.id);
  list.push(session.record);
  saveSearches(list);
}

// `args` must be serializable: it is what rebuilds the search later.
function newSession(source, args) {
  return {
    record: { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, source, args, steps: [], createdAt: Date.now() },
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
function runOnServer(card, body, progressLabel, session) {
  return new Promise(async (resolve, reject) => {
    card.progressLabelEl.textContent = progressLabel;
    card.progressWindowEl.textContent = "";
    updateBar(card.barEl, 0);
    card.setStatus("Na fila", "status-queued");

    // When resuming, a known step is reused; once the saved steps run out, the
    // search simply carries on from where it stopped.
    const step = session?.record.steps[session.index];
    if (session) session.index++;

    // Set before any early exit: Remove must know which record to delete, and a
    // restored search leaves right below.
    if (session) card.root.dataset.searchId = session.record.id;

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
    if (jobId) card.root.dataset.jobId = jobId;
    if (!jobId) {
      let response;
      try {
        response = await apiFetch("/api/searches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        reject(new Error("Não foi possível conectar ao servidor."));
        return;
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        reject(new Error(error.error || "Erro ao iniciar a busca."));
        return;
      }

      ({ jobId } = await response.json());
      card.root.dataset.jobId = jobId;
      if (session) {
        session.record.steps[session.index - 1] = { jobId };
        persistSession(session);
      }
    }

    const events = new EventSource(`/api/searches/${jobId}/events`);

    events.onmessage = (message) => {
      const event = JSON.parse(message.data);
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
        const result = {
          result: event.legs || event.section || event.report,
          spreadsheetUrl: event.spreadsheetUrl,
          localFile: event.localFile,
          partialNotice: event.partialNotice,
          appliedCeilings: event.appliedCeilings,
          confirmation: event.confirmation,
          stoppedByUser: event.stoppedByUser,
        };
        keepResult(result);
        resolve(result);
      } else if (event.type === "error") {
        events.close();
        removeQuestion(card);
        reject(new Error(event.message));
      }
    };

    events.onerror = () => {
      events.close();
      reject(new Error("Conexão com o servidor perdida."));
    };
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
    if (!editing) return;
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
    if (!session.resuming) saveToHistory(origin, destination, "tap");

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
      promoteLatestToRoundTrip(origin, destination, "tap");
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = false;
    card.subtabsEl.hidden = false;
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
    if (!session.resuming) saveToHistory(origin, destination, program, roundTrip);

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = false;
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
    if (!session.resuming) saveToHistory(origin, destination, "SMILES", false);

    let returnLegs = null;
    let returnSpreadsheetUrl = null;
    if (roundTrip) {
      const inbound = await runOnServer(
        card,
        { ...baseBody, origin: destination, destination: origin },
        "Buscando volta…",
        session,
      );
      returnLegs = inbound.result;
      returnSpreadsheetUrl = inbound.spreadsheetUrl;
      if (inbound.partialNotice) partialNotices.push(inbound.partialNotice);
      renderLegSections(card.resultEl, `Volta: ${destination} → ${origin}`, returnLegs[0].sections);
      recordLegForCopy(card, returnLegs[0].sections);
      promoteLatestToRoundTrip(origin, destination, "SMILES");
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = false;
    showPartialNotices(card, partialNotices);
    updateCardActions(card);
    showSpreadsheetLink(card, outbound.spreadsheetUrl, roundTrip ? "ida" : "busca");
    showSpreadsheetLink(card, returnSpreadsheetUrl, "volta");

    const sectionOf = (legs, label) => legs?.[0]?.sections.find((section) => section.label === label);
    showAlertButtons(card, "SMILES", origin, destination, [
      { cabinClass: "Econômica", outbound: sectionOf(outboundLegs, "Econômica"), inbound: sectionOf(returnLegs, "Econômica") },
      { cabinClass: "Premium Economy", outbound: sectionOf(outboundLegs, "Conforto"), inbound: sectionOf(returnLegs, "Conforto") },
      { cabinClass: "Executiva", outbound: sectionOf(outboundLegs, "Executiva"), inbound: sectionOf(returnLegs, "Executiva") },
    ]);
  } catch (err) {
    showFailure(card, err);
  } finally {
    card.progressEl.hidden = true;
  }
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
      if (!button.disabled) setAlertButtonState(button, option.cabinClass, "idle");
    });
    bar.appendChild(button);
  }
  // At the top, right under the header: generating the alert is what happens as
  // soon as the search ends, and at the bottom it sat behind months of results.
  card.root.querySelector(".job-header").after(bar);
}

// An "images + caption + copy" block, used for the main alert and the combinations one.
function alertBlock(title, images, caption) {
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

  const captionEl = document.createElement("pre");
  captionEl.className = "alert-caption";
  captionEl.textContent = caption;
  block.appendChild(captionEl);

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-button";
  copyButton.textContent = "Copiar legenda";
  copyButton.addEventListener("click", () => copyToClipboard(copyButton, caption, "Copiar legenda"));
  block.appendChild(copyButton);

  return block;
}

function showGeneratedAlert(card, { images, caption, comboImage, comboCaption }) {
  // Combos only come when outbound and return dates cross: the alert sent after
  // the main one, with the combinations ready.
  const hasCombo = Boolean(comboImage);
  insertAfterAlert(card, alertBlock(hasCombo ? "Alerta principal" : "", images, caption));
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
    if (!session.resuming) saveToHistory(origin, destination, "AA", false, { cabin, passengers });

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
      promoteLatestToRoundTrip(origin, destination, "AA");
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = false;
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
    if (!session.resuming) saveToHistory(origin, destination, "LATAM", true);

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = false;
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

function repeatWarning(program, origin, destination, roundTrip) {
  for (const [from, to] of searchRoutes(origin, destination, roundTrip)) {
    if (runningSearches.has(`${program}|${from}|${to}`)) {
      if (!confirm(`A busca ${from} → ${to} ainda está em andamento. Buscar de novo mesmo assim?`)) return false;
      continue;
    }
    const previous = latestSearchOf(from, to, program);
    if (previous && Date.now() - previous.timestamp < TOLERANCE_MS) {
      const confirmed = confirm(
        `Você já buscou ${from} → ${to} ${formatRelativeTime(previous.timestamp)} ` +
          `(${formatDateTime(previous.timestamp)}), há menos de ${TOLERANCE_DAYS} dias. Buscar de novo mesmo assim?`,
      );
      if (!confirmed) return false;
    }
  }
  return true;
}

tapForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearNotice(tapNotice);
  const origin = tapOriginInput.value.trim().toUpperCase();
  const destination = tapDestinationInput.value.trim().toUpperCase();
  const roundTrip = tapRoundTripCheckbox.checked;
  if (!origin || !destination) {
    showNotice(tapNotice, "Preencha origem e destino.");
    return;
  }
  if (!repeatWarning("tap", origin, destination, roundTrip)) return;
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
    if (!session.resuming) saveToHistory(origin, destination, "IBERIA", false, {});

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
      promoteLatestToRoundTrip(origin, destination, "IBERIA");
    }

    card.setStatus("Pronto", "status-done");
    card.resultEl.hidden = false;
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

smilesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearNotice(smilesNotice);
  const origin = smilesOriginInput.value.trim().toUpperCase();
  const destination = smilesDestinationInput.value.trim().toUpperCase();
  if (!origin || !destination) {
    showNotice(smilesNotice, "Preencha origem e destino.");
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
    // Both empty means the server's default period; no date is made up here to
    // compete with the rule that already lives there.
    { from: smilesFromInput.value || undefined, until: smilesUntilInput.value || undefined },
  );
});

seatspyForm.addEventListener("submit", (event) => {
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
  if (!repeatWarning(program, origin, destination, roundTrip)) return;
  trackRunning(
    program,
    origin,
    destination,
    roundTrip,
    startSeatspySearch(program, origin, destination, roundTrip, seatspyShowSeatsCheckbox.checked),
  );
});

// Runs last: every source's functions and form elements must already exist.
migrateLegacyHistory();
const tabFromUrl = location.hash.slice(1);
if (Object.hasOwn(panels, tabFromUrl)) activateTab(tabFromUrl);
restoreSearches();
