// Le panneau latéral de l'extension (Chrome side_panel, Firefox sidebar_action) : un clic sur l'icône ou Alt+Maj+W
// l'ouvre (src/background.js). Plusieurs onglets : la page ouverte, la collection, les doublons, les paquets, les
// réglages. Il ne lit rien lui-même : il demande tout au content script d'un onglet du site (src/content.js), qui garde
// la seule file de lecture (budget, rafale, cache partagé).
const { wb } = WME;
const main = document.getElementById("main");
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

// Petit utilitaire sans innerHTML : tout texte est posé en texte.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "on") for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else el[key] = value;
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const fr = (n) => Math.round(n).toLocaleString("fr-FR");
const time = (at) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dateTime = (at) => new Date(at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

// L'onglet du site à interroger : l'onglet actif s'il est sur le site, sinon le premier onglet du site.
async function siteTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.wiki-masters.com/*", "https://wiki-masters.com/*"] });
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find((t) => active && t.id === active.id) || tabs[0] || null;
}

// Message au content script : { type, … } -> sa réponse, ou { ok: false, error }.
async function ask(type, extra) {
  const tab = await siteTab();
  if (!tab) return { ok: false, error: "Ouvre une page de wiki-masters.com : le panneau passe par elle." };
  try {
    return (await chrome.tabs.sendMessage(tab.id, { type, ...extra })) || { ok: false, error: "Pas de réponse : recharge la page du site." };
  } catch (_) {
    return { ok: false, error: "Recharge la page du site (ouverte avant l'installation ou la mise à jour de l'extension)." };
  }
}

// ------------------------------------------------------------------ onglets
const TABS = {
  page: { label: "Page", every: 2e3, view: pageView },
  collection: { label: "Collection", every: 10e3, view: collectionView },
  duplicates: { label: "Doublons", every: 10e3, view: duplicatesView },
  packs: { label: "Paquets", every: 2e3, view: packsView },
  settings: { label: "Réglages", every: 0, view: settingsView },
};
let tab = "page";
let timer = null;
let busy = false;

const nav = document.getElementById("tabs");
for (const [key, t] of Object.entries(TABS)) {
  nav.append(h("button", { textContent: t.label, on: { click: () => show(key) } }));
}

function show(key) {
  tab = key;
  [...nav.children].forEach((b, i) => b.setAttribute("aria-selected", String(Object.keys(TABS)[i] === key)));
  clearInterval(timer);
  draw(true);
  if (TABS[key].every) timer = setInterval(() => draw(false), TABS[key].every);
}

async function draw(first) {
  if (busy) return;
  busy = true;
  try {
    if (first) main.replaceChildren(h("p", { className: "muted" }, "Lecture…"));
    const nodes = await TABS[tab].view(first);
    if (nodes) main.replaceChildren(...[nodes].flat().filter(Boolean));
  } finally {
    busy = false;
  }
}

const error = (reply) => [h("p", { className: "error" }, reply.error), h("button", { className: "act", on: { click: () => draw(true) } }, "Réessayer")];

// ------------------------------------------------------------------ Page : ce que l'onglet du site affiche
async function pageView() {
  const state = await ask("state");
  if (!state || state.ok === false) return error(state || {});
  return [
    h("p", { className: "big" }, `≈ ${wb(state.value)} WB`),
    h("p", { className: "muted" }, `Valeur des ${state.tiles} carte(s) avec un badge sur la page`),
    ...state.trades.map((t) => h("p", { className: "trade" }, t)),
    h("h3", {}, "Prix"),
    h("p", {}, `${fr(state.known)} à jour · ${fr(state.old)} de plus de 24 h (grisés) · ${fr(state.waiting)} en attente`),
    h("p", { className: "muted" }, `Lectures sur 10 min : ${state.reads.history}/${state.readBudget} historiques · ` +
      `${state.reads.sales}/${state.readBudget} ventes`),
    state.slowUntil > Date.now() && h("p", { className: "muted" }, `Rythme divisé par deux jusqu'au ${dateTime(state.slowUntil)} (refus récent du site).`),
    ...state.pauses.map((p) => h("p", { className: "warn" }, `Pause : ${p.reason}, jusqu'à ${time(p.until)}.`)),
    sharedLive(state.shared),
    limitsLog(state.limits),
    h("p", { className: "muted" }, "Prix = le « Prix moyen de la semaine » de la fiche de la carte, dans sa rareté ; « ≈ » quand il " +
      "repose sur trop peu de ventes. Au survol d'un badge : ventes, âge du relevé, qui l'a fait."),
  ];
}

function sharedLive(shared) {
  if (!shared || !shared.on) return null;
  if (shared.error) return h("p", { className: "warn" }, `Prix partagés : ${shared.error}`);
  return h("p", { className: "muted" }, `Prix partagés${shared.who ? ` (${shared.who})` : ""} : ${fr(shared.served)} reçu(s) · ${fr(shared.pushed)} déposé(s)`);
}

// Derniers refus du site, avec nos lectures juste avant : de quoi connaître ses quotas sans les chercher.
function limitsLog(limits) {
  if (!limits || !limits.length) return null;
  const what = { automation: "quota atteint", verification: "vérification", rate: "trop vite (429)" };
  const route = { history: "historiques", sales: "ventes" };
  return h("div", { className: "box" },
    h("h3", {}, "Refus du site"),
    ...limits.map((e) => h("p", { className: "muted" }, `${dateTime(e.at)} · ${route[e.route] || e.route} · ` +
      `${what[e.limit] || e.limit} après ${e.reads10m} lecture(s) en 10 min, dont ${e.reads1m} dans la dernière minute`)));
}

// ------------------------------------------------------------------ Collection (#18) et Doublons (#22)
async function summary(refresh) {
  return ask("panel", { action: "summary", refresh });
}

function readLine(s) {
  return h("p", { className: "muted" }, `Collection lue il y a ${WME.ago(Date.now() - s.at)} · ${fr(s.waiting)} prix en attente `,
    h("button", { className: "act small", on: { click: async () => { main.replaceChildren(h("p", { className: "muted" }, "Lecture de ta collection…")); await summary(true); draw(false); } } }, "Relire"));
}

// Courbe de la valeur, une mesure par jour.
function sparkline(history) {
  const days = Object.keys(history || {}).sort();
  if (days.length < 2) return h("p", { className: "muted" }, "La courbe de valeur apparaîtra au fil des jours (une mesure par jour).");
  const values = days.map((d) => history[d]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", values.map((v, i) => `${(i / (values.length - 1)) * 100},${38 - ((v - min) / (max - min || 1)) * 34}`).join(" "));
  for (const [k, v] of [["fill", "none"], ["stroke", "#fde68a"], ["stroke-width", "1.5"], ["vector-effect", "non-scaling-stroke"]]) line.setAttribute(k, v);
  svg.append(line);
  return h("div", {}, svg, h("p", { className: "muted" }, `${days.length} jours · de ${fr(values[0])} à ${fr(values[values.length - 1])} WB`));
}

async function collectionView(first) {
  if (first) main.replaceChildren(h("p", { className: "muted" }, "Lecture de ta collection…"));
  const s = await summary(false);
  if (!s.ok) return error(s);
  const sum = s.summary;
  const missingRare = ["L", "UR", "SR"].reduce((n, r) => n + (s.missing[r] || 0), 0);
  return [
    readLine(s),
    h("p", { className: "big" }, `≈ ${fr(sum.value)} WB`),
    h("p", { className: "muted" }, `${fr(sum.copies)} exemplaire(s) · ${fr(sum.distinct)} carte(s) · ${fr(sum.unsure)} au prix incertain · ` +
      `${fr(sum.unpriced)} sans prix connu (shiny compris)`),
    s.sharedFill && h("p", { className: "muted" }, s.sharedFill),
    sparkline(s.history),
    h("table", {},
      h("tr", {}, h("th", {}, "Rareté"), h("th", { className: "num" }, "Exemplaires"), h("th", { className: "num" }, "Valeur"), h("th", { className: "num" }, "Sans prix")),
      ...sum.byRarity.map((r) => h("tr", {}, h("td", {}, r.rarity), h("td", { className: "num" }, fr(r.copies)),
        h("td", { className: "num" }, wb(r.value)), h("td", { className: "num" }, fr(r.unpriced))))),
    h("button", {
      className: "act", disabled: missingRare === 0,
      on: { click: async (e) => {
        e.target.disabled = true;
        const reply = await ask("panel", { action: "loadPrices", rarities: ["L", "UR", "SR"] });
        e.target.textContent = reply.ok ? `${fr(reply.count)} carte(s) en file : les prix arrivent au fil des minutes` : reply.error;
      } },
    }, missingRare ? `Lire les prix manquants des L, UR, SR (${fr(missingRare)})` : "Tous les prix des L, UR, SR sont connus"),
    h("p", { className: "muted" }, "Seuls les prix connus comptent. Ils viennent des pages que tu ouvres, du serveur partagé (avec les " +
      "lectures de ton bot) et de ce bouton (après les cartes affichées, dans le quota habituel)."),
    h("h3", {}, "Mes cartes les plus chères"),
    h("table", {}, ...sum.top.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, c.rarity),
      h("td", { className: "num" }, `${c.sure ? "" : "≈ "}${wb(c.price)}`)))),
  ];
}

async function duplicatesView() {
  const s = await summary(false);
  if (!s.ok) return error(s);
  const list = s.summary.duplicates;
  if (!list.length) return [readLine(s), h("p", {}, "Aucun doublon.")];
  const total = list.reduce((n, d) => n + d.value, 0);
  return [
    readLine(s),
    h("p", {}, `${fr(list.length)} carte(s) en plusieurs exemplaires · exemplaires en trop ≈ ${fr(total)} WB`),
    h("p", { className: "muted" }, "L'exemplaire le plus rare est gardé ; les autres sont « en trop ». Les favoris sont verrouillés par le " +
      "site (ni vente, ni défausse, ni échange)."),
    h("table", {},
      h("tr", {}, h("th", {}, "Carte"), h("th", {}, "Gardé"), h("th", {}, "En trop"), h("th", { className: "num" }, "Valeur")),
      ...list.map((d) => h("tr", {}, h("td", {}, d.title), h("td", {}, d.kept),
        h("td", {}, d.extra + (d.locked ? ` (${d.locked} favori${d.locked > 1 ? "s" : ""})` : "")),
        h("td", { className: "num" }, d.value ? wb(d.value) : "—")))),
  ];
}

// ------------------------------------------------------------------ Paquets : récap et automatisation
async function packsView() {
  const state = await ask("state");
  if (!state || state.ok === false) return error(state || {});
  return [
    pullsRecap(state.pulls) || h("p", { className: "muted" }, "Aucun paquet ouvert noté pour l'instant."),
    h("h3", {}, "Automatisation par clic"),
    h("p", { className: "muted" }, "Elle ne change jamais de page sous tes yeux : elle attend 5 min sans clic, frappe ni défilement. Les " +
      "règles du site interdisent les scripts qui jouent à ta place : à utiliser en connaissance de cause."),
    toggle(state.autoClickPack, "autoClickPack", "Ouverture auto des paquets (/pulls)"),
    toggle(state.autoUnblockMarket, "autoUnblockMarket", "Tentative de déblocage du marché (/collection) : met une vraie enchère"),
    clickStatus(state),
  ];
}

function toggle(checked, type, label) {
  return h("label", {}, h("input", { type: "checkbox", checked: Boolean(checked), on: { change: async (e) => { await ask(type, { on: e.target.checked }); draw(false); } } }), ` ${label}`);
}

// Récap des paquets ouverts, à la main et en auto (pullRecap, src/lib.js).
function pullsRecap(recap) {
  if (!recap || !(recap.packs || recap.earlier)) return null;
  const total = recap.cards + recap.earlier;
  const percent = (n) => (n / total * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  const order = (r) => (WME.rank(r) < 0 ? -1 : WME.rank(r));
  return h("div", { className: "box" },
    h("h3", {}, `Paquets ouverts · ${fr(total)} carte(s)`),
    h("table", {}, ...Object.entries(recap.byRarity).sort(([a], [b]) => order(b) - order(a))
      .map(([r, n]) => h("tr", {}, h("td", {}, r), h("td", { className: "num" }, fr(n)), h("td", { className: "num" }, `${percent(n)} %`)))),
    recap.shiny > 0 && h("p", { className: "muted" }, `✦ ${recap.shiny} shiny`),
    recap.earlier > 0 && h("p", { className: "muted" }, `Dont ${fr(recap.earlier)} carte(s) d'avant, reprises de l'extension « Prix moyen collection » (sans prix ni détail).`),
    recap.packs > 0 && h("p", {}, `Depuis le ${dateTime(recap.since)} : ${recap.packs} paquet(s) · ${recap.cards} carte(s) · ≈ ${wb(recap.value)} WB`),
    recap.packs > 0 && h("p", { className: "muted" }, `${recap.auto} en auto · ${recap.manual} à la main`),
    recap.missing > 0 && h("p", { className: "muted" }, `${recap.missing} carte(s) sans prix (shiny, aucune vente ou pas encore lu)`),
    recap.best.length > 0 && h("p", { className: "muted" }, "Meilleurs tirages : " + recap.best.map((c) => `${c.title} ${c.rarity} ≈ ${wb(c.price)}`).join(" · ")),
    h("button", { className: "act", on: { click: async () => { if (confirm("Remettre le récap des paquets à zéro ?")) { await ask("clearPulls"); draw(false); } } } }, "Remettre le récap à zéro"));
}

function clickStatus(state) {
  const info = state.clickInfo;
  if (!info || !(state.autoClickPack || state.autoUnblockMarket)) return null;
  const notes = [info.challengeVisible && "vérification affichée", info.userQuiet ? "joueur inactif" : "joueur actif : pas de changement de page"].filter(Boolean);
  return h("p", { className: "muted" }, `État : ${info.status} · ${notes.join(" · ")}`);
}

// ------------------------------------------------------------------ Réglages (construits une fois : pas de
// rafraîchissement automatique, un champ en cours de saisie n'est jamais effacé)
async function settingsView() {
  const state = await ask("state");
  if (!state || state.ok === false) return error(state || {});
  const minSales = h("input", { type: "number", min: 1, max: 50, step: 1, value: state.minSales, className: "small" });
  minSales.addEventListener("change", async () => {
    const reply = await ask("minSales", { value: minSales.value });
    if (reply && reply.minSales) minSales.value = reply.minSales;
  });
  const order = h("select", {}, ...[["", "Rareté (celui du site)"], ["Nom", "Nom"], ["Favoris", "Favoris"], ["Date d'ajout", "Date d'ajout"]]
    .map(([value, label]) => h("option", { value, selected: (state.collectionOrder || "") === value }, label)));
  order.addEventListener("change", () => ask("collectionOrder", { value: order.value }));
  return [
    h("h3", {}, "Sur les cartes"),
    h("label", {}, h("input", { type: "checkbox", checked: state.badges, on: { change: (e) => ask("badges", { on: e.target.checked }) } }), " Badges de prix"),
    h("label", {}, h("input", { type: "checkbox", checked: state.ownedMarks !== false, on: { change: (e) => ask("ownedMarks", { on: e.target.checked }) } }),
      " « ✓ » sur les cartes que j'ai déjà, point bleu sur les autres"),
    h("label", {}, "Prix fiable à partir de ", minSales, " vente(s) dans la semaine (sinon « ≈ »)"),
    h("h3", {}, "Pages du site"),
    h("label", {}, "Ordre de ma collection : ", order),
    h("h3", {}, "Prix partagés"),
    await sharedSettings(),
    h("h3", {}, "Cache des prix"),
    h("button", { className: "act", on: { click: async (e) => { if (confirm("Oublier tous les prix et les relire sur le site ?")) { await ask("reread"); e.target.textContent = "Prix oubliés : relecture en cours"; } } } },
      "Relire tous les prix"),
  ];
}

// Réglages des prix partagés (src/background.js, server/).
const SHARED_KEY = "shared";
async function sharedSettings() {
  const { [SHARED_KEY]: cfg = {} } = await chrome.storage.local.get(SHARED_KEY);
  const status = h("p", { className: "muted" });
  const on = h("input", { type: "checkbox", checked: Boolean(cfg.on) });
  const url = h("input", { type: "url", value: cfg.url || "", placeholder: "https://….workers.dev", className: "wide" });
  const token = h("input", { type: "password", value: cfg.token || "", placeholder: "jeton", autocomplete: "off", className: "wide" });
  const fields = h("div", { hidden: !cfg.on }, url, token, h("button", { className: "act", on: { click: save } }, "Enregistrer"));
  const check = async () => {
    const stats = await chrome.runtime.sendMessage({ type: "shared-stats" }).catch((e) => ({ error: e.message }));
    status.textContent = !stats || stats.error ? `Serveur : ${(stats && stats.error) || "pas de réponse"}`
      : `Connecté en ${stats.who} · ${fr(stats.fresh_cards)} carte(s) lue(s) depuis moins de 6 h dans le cache`;
  };
  // L'autorisation de joindre le serveur se demande pendant le clic (le navigateur l'exige) : vérification synchrone.
  function save() {
    const value = { on: on.checked, url: url.value.trim().replace(/\/+$/, ""), token: token.value.trim() };
    if (!value.on) {
      chrome.storage.local.set({ [SHARED_KEY]: value });
      status.textContent = "Partage désactivé.";
      return;
    }
    let origin = "";
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol === "https:" && parsed.hostname.endsWith(".workers.dev")) origin = parsed.origin;
    } catch (_) {
      // adresse illisible
    }
    if (!origin || !value.token) {
      status.textContent = !origin ? "Adresse attendue : https://….workers.dev" : "Jeton manquant.";
      return;
    }
    const granting = chrome.permissions.request({ origins: [`${origin}/*`] });
    chrome.storage.local.set({ [SHARED_KEY]: value });
    granting.then((granted) => (granted ? check() : (status.textContent = "Autorisation refusée : l'extension ne peut pas joindre ce serveur.")),
      (e) => { status.textContent = `Autorisation impossible : ${e.message}`; });
  }
  on.addEventListener("change", () => {
    fields.hidden = !on.checked;
    if (!on.checked) save();
  });
  if (cfg.on) check();
  return h("div", {}, h("label", {}, on, " Mettre mes lectures en commun (serveur partagé)"), fields, status);
}

show("page");
