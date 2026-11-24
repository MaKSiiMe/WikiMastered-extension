// Panneau latéral de l'extension (Chrome side_panel, Firefox sidebar_action) : les grandes vues, qui n'ont pas leur
// place dans les pages du site. Il ne lit rien lui-même : il demande tout au content script d'un onglet du site
// (src/content.js), qui garde la seule file de lecture (budget, rafale, cache partagé).
const { wb } = WME;
const main = document.getElementById("main");
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "on") for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else el[key] = value;
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

// L'onglet du site à interroger : l'onglet actif s'il est sur le site, sinon le premier onglet du site.
async function siteTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.wiki-masters.com/*", "https://wiki-masters.com/*"] });
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find((t) => active && t.id === active.id) || tabs[0] || null;
}

async function ask(message) {
  const tab = await siteTab();
  if (!tab) return { ok: false, error: "Ouvre une page de wiki-masters.com (le panneau passe par elle)." };
  try {
    return (await chrome.tabs.sendMessage(tab.id, { type: "panel", ...message })) ||
      { ok: false, error: "Pas de réponse : recharge la page du site." };
  } catch (_) {
    return { ok: false, error: "Recharge la page du site (ouverte avant l'installation ou la mise à jour de l'extension)." };
  }
}

let tab = "collection";
let state = null;
let busy = false;

for (const button of document.querySelectorAll("nav button")) {
  button.addEventListener("click", () => {
    tab = button.dataset.tab;
    for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-selected", String(b === button));
    render();
  });
}

async function load(refresh = false) {
  if (busy) return;
  busy = true;
  if (refresh || !state) render("Lecture de ta collection…");
  const reply = await ask({ action: "summary", refresh });
  busy = false;
  state = reply;
  render();
}

const fr = (n) => Math.round(n).toLocaleString("fr-FR");
const ago = (at) => WME.ago(Date.now() - at);

// Courbe de la valeur, une mesure par jour (#18).
function sparkline(history) {
  const days = Object.keys(history || {}).sort();
  if (days.length < 2) return h("p", { className: "muted" }, "La courbe de valeur apparaîtra au fil des jours (une mesure par jour).");
  const values = days.map((d) => history[d]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${38 - ((v - min) / (max - min || 1)) * 34}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#fde68a");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  return h("div", {}, svg, h("p", { className: "muted" },
    `${days.length} jours · de ${fr(values[0])} à ${fr(values[values.length - 1])} WB (min ${fr(min)}, max ${fr(max)})`));
}

function collectionView(s) {
  const sum = s.summary;
  const missingRare = ["L", "UR", "SR"].reduce((n, r) => n + (s.missing[r] || 0), 0);
  const loadButton = h("button", {
    className: "act",
    disabled: missingRare === 0,
    on: {
      click: async (e) => {
        e.target.disabled = true;
        const reply = await ask({ action: "loadPrices", rarities: ["L", "UR", "SR"] });
        e.target.textContent = reply.ok ? `${reply.count} carte(s) en file : les prix arrivent au fil des minutes` : reply.error;
      },
    },
  }, missingRare ? `Lire les prix manquants des L, UR, SR (${missingRare})` : "Tous les prix des L, UR, SR sont connus");
  return [
    h("p", { className: "big" }, `≈ ${fr(sum.value)} WB`),
    h("p", { className: "muted" }, `${fr(sum.copies)} exemplaire(s) · ${fr(sum.distinct)} carte(s) · ` +
      `${fr(sum.unsure)} au prix incertain (« ≈ ») · ${fr(sum.unpriced)} sans prix connu (shiny compris)`),
    sparkline(s.history),
    h("table", {},
      h("tr", {}, h("th", {}, "Rareté"), h("th", { className: "num" }, "Exemplaires"), h("th", { className: "num" }, "Valeur"),
        h("th", { className: "num" }, "Sans prix")),
      ...sum.byRarity.map((r) => h("tr", {}, h("td", {}, r.rarity), h("td", { className: "num" }, fr(r.copies)),
        h("td", { className: "num" }, wb(r.value)), h("td", { className: "num" }, fr(r.unpriced))))),
    loadButton,
    h("p", { className: "muted" }, "Seuls les prix connus comptent. Ils arrivent par les pages que tu ouvres, le serveur partagé et " +
      "ce bouton (après les cartes affichées, dans le quota habituel)."),
    h("h3", {}, "Mes cartes les plus chères"),
    h("table", {}, ...sum.top.map((c) => h("tr", {}, h("td", {}, `${c.title}`), h("td", {}, c.rarity),
      h("td", { className: "num" }, `${c.sure ? "" : "≈ "}${wb(c.price)}`)))),
  ];
}

function duplicatesView(s) {
  const list = s.summary.duplicates;
  if (!list.length) return [h("p", {}, "Aucun doublon.")];
  const total = list.reduce((n, d) => n + d.value, 0);
  return [
    h("p", {}, `${fr(list.length)} carte(s) en plusieurs exemplaires · exemplaires en trop ≈ ${fr(total)} WB`),
    h("p", { className: "muted" }, "L'exemplaire le plus rare est gardé ; les autres sont « en trop ». Les favoris sont verrouillés " +
      "par le site (ni vente, ni défausse, ni échange)."),
    h("table", {},
      h("tr", {}, h("th", {}, "Carte"), h("th", {}, "Gardé"), h("th", {}, "En trop"), h("th", { className: "num" }, "Valeur")),
      ...list.map((d) => h("tr", {}, h("td", {}, d.title), h("td", {}, d.kept),
        h("td", {}, d.extra + (d.locked ? ` (${d.locked} favori${d.locked > 1 ? "s" : ""})` : "")),
        h("td", { className: "num" }, d.value ? wb(d.value) : "—")))),
  ];
}

function render(message) {
  if (message) {
    main.replaceChildren(h("p", { className: "muted" }, message));
    return;
  }
  if (!state) return;
  if (!state.ok) {
    main.replaceChildren(h("p", { className: "error" }, state.error), h("button", { className: "act", on: { click: () => load(true) } }, "Réessayer"));
    return;
  }
  main.replaceChildren(
    h("p", { className: "muted" }, `Collection lue il y a ${ago(state.at)} · ${state.waiting} prix en attente `,
      h("button", { className: "act", on: { click: () => load(true) } }, "Relire")),
    ...(tab === "collection" ? collectionView(state) : duplicatesView(state)));
}

load();
// Les prix arrivent au fil des minutes : le bilan est recalculé (sans relire la collection) toutes les 10 s.
setInterval(() => load(false), 10e3);
