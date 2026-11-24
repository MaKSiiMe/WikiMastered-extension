// Le panneau latéral de l'extension (Chrome side_panel, Firefox sidebar_action) : un clic sur l'icône ou Alt+Maj+W
// l'ouvre (src/background.js). Plusieurs onglets : la page ouverte, la collection, les filtres, les souhaits, les
// familles, les enchères, les paquets, les réglages. Il ne lit rien lui-même : il demande tout au content script d'un onglet du site (src/content.js), qui garde
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

// Thème clair ou sombre, celui du site (relevé par src/content.js).
const applyTheme = (theme) => document.documentElement.classList.toggle("light", theme === "light");
chrome.storage.local.get("wmTheme").then(({ wmTheme }) => applyTheme(wmTheme));
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.wmTheme) applyTheme(changes.wmTheme.newValue); });

// Rareté en pastille aux couleurs du site ; « i » dont le texte s'affiche au survol.
const rar = (rarity, shiny) => h("span", { className: `rar r-${String(rarity || "").toLowerCase()}` }, `${rarity || "?"}${shiny ? " ✦" : ""}`);
const info = (text) => h("span", { className: "info", title: text, tabIndex: 0, ariaLabel: text }, "i");

// replaceChildren sans les null / false / undefined des conditions (il les écrirait en texte).
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((c) => c !== null && c !== undefined && c !== false));

const fr = (n) => Math.round(n).toLocaleString("fr-FR");
const pct = (part, total) => (total ? (part / total) * 100 : 0);
const pctText = (part, total) => `${pct(part, total).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
// Barre de proportion (raretés des paquets) : largeur relative à la plus grande valeur du tableau.
const bar = (part, max) => h("div", { className: "bar" }, h("span", { style: `width: ${Math.max(1, pct(part, max)).toFixed(1)}%` }));

// Fenêtre de confirmation dans le panneau (confirm() ne s'affiche pas dans le panneau latéral de Firefox).
// { title, lines: [texte], strong?, check? (case à cocher exigée), ok, cancel } -> Promise<bool>
function dialog({ title, lines = [], strong = "", check = "", ok = "Confirmer", cancel = "Annuler" }) {
  return new Promise((resolve) => {
    const close = (answer) => { wrap.remove(); resolve(answer); };
    const okButton = h("button", { className: "act primary", disabled: Boolean(check), on: { click: () => close(true) } }, ok);
    const box = check ? h("label", {}, h("input", { type: "checkbox", on: { change: (e) => { okButton.disabled = !e.target.checked; } } }), ` ${check}`) : null;
    const wrap = h("div", { className: "modal-wrap", on: { click: (e) => { if (e.target === wrap) close(false); } } },
      h("div", { className: "modal", role: "dialog" },
        h("h3", {}, title), ...lines.map((l) => h("p", {}, l)), strong && h("p", {}, h("b", {}, strong)), box,
        h("div", { className: "row" }, h("button", { className: "act", on: { click: () => close(false) } }, cancel), okButton)));
    document.body.append(wrap);
    okButton.focus();
  });
}
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

// ------------------------------------------------------------------ Nouveautés (#28) : bouton en haut du panneau,
// avec un point tant qu'une mise à jour n'a pas été vue. Les versions plus récentes que la dernière vue sont marquées.
const newsButton = document.getElementById("news");
chrome.storage.local.get(["wmNewsUnseen"]).then(({ wmNewsUnseen }) => newsButton.classList.toggle("dot", Boolean(wmNewsUnseen)));
newsButton.addEventListener("click", () => show("news"));

const versionValue = (v) => String(v).split(".").reduce((n, part) => n * 1000 + (Number(part) || 0), 0);

async function newsView() {
  const { wmNewsSeen = "0" } = await chrome.storage.local.get("wmNewsSeen");
  chrome.storage.local.set({ wmNewsSeen: chrome.runtime.getManifest().version, wmNewsUnseen: false });
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  newsButton.classList.remove("dot");
  const state = await ask("state");
  return WME_NEWS.map((release) => h("div", { className: "box" },
    h("h3", {}, `Version ${release.version}`, versionValue(release.version) > versionValue(wmNewsSeen) ? h("span", { className: "new" }, " · nouveau pour toi") : null),
    ...release.items.map((item) => h("p", {}, item.text, " ",
      item.option && state && state.ok !== false && !state[item.option]
        ? h("button", { className: "act small", on: { click: async (e) => { await ask(item.option, { on: true }); e.target.replaceWith(" (activé)"); } } }, "Activer")
        : null))));
}

// ------------------------------------------------------------------ onglets
const TABS = {
  page: { label: "Page", every: 2e3, view: pageView },
  collection: { label: "Collection", every: 10e3, view: collectionView },
  filters: { label: "Filtres", every: 0, view: filtersView },
  wishes: { label: "Souhaits", every: 10e3, view: wishesView },
  families: { label: "Familles", every: 0, view: familiesView },
  auctions: { label: "Enchères", every: 0, view: auctionsView }, // se rafraîchit lui-même, sans effacer un formulaire de vente
  packs: { label: "Paquets", every: 2e3, view: packsView },
  settings: { label: "Réglages", every: 0, view: settingsView },
  news: { label: "Nouveautés", every: 0, view: newsView, hidden: true },
};
let tab = "page";
let timer = null;
let busy = false;

const nav = document.getElementById("tabs");
for (const [key, t] of Object.entries(TABS)) {
  nav.append(h("button", { textContent: t.label, hidden: Boolean(t.hidden), on: { click: () => show(key) } }));
}

function show(key) {
  tab = key;
  [...nav.children].forEach((b, i) => b.setAttribute("aria-selected", String(Object.keys(TABS)[i] === key)));
  clearInterval(timer);
  draw(true);
  if (TABS[key].every) timer = setInterval(() => draw(false), TABS[key].every);
}

// Un dessin à la fois par onglet : un rafraîchissement automatique ne se superpose pas à un dessin en cours, mais un
// changement d'onglet passe toujours (seul le dernier dessin demandé est affiché).
let drawToken = 0;
async function draw(first) {
  if (busy && !first) return;
  const token = ++drawToken;
  busy = true;
  try {
    if (first) fill(main, h("p", { className: "muted" }, "Lecture…"));
    const nodes = await TABS[tab].view(first);
    if (nodes && token === drawToken) fill(main, ...[nodes].flat().filter(Boolean));
  } finally {
    if (token === drawToken) busy = false;
  }
}

const error = (reply) => [h("p", { className: "error" }, reply.error), h("button", { className: "act", on: { click: () => draw(true) } }, "Réessayer")];

// ------------------------------------------------------------------ Page : ce que l'onglet du site affiche
async function pageView() {
  const state = await ask("state");
  if (!state || state.ok === false) return error(state || {});
  return [
    draftView(state.draft),
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

// Offre en cours de composition (fenêtre « Échanger avec … » du site) : chaque carte de chaque côté, et l'écart.
function draftView(d) {
  if (!d) return null;
  const side = (label, s, tab) => [
    h("p", {}, h("b", {}, `${label} ≈ ${wb(s.value + s.wb)}`), s.seen < s.count ? h("span", { className: "muted" }, ` (ouvre « ${tab} » sur le site pour compter ${s.count - s.seen} carte(s))`) : null),
    s.cards.length || s.wb ? h("table", {}, ...s.cards.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, rar(c.rarity, c.shiny)),
      h("td", { className: "num" }, c.price === null ? (c.shiny ? "pas de prix" : "?") : wb(c.price)))),
    s.wb ? h("tr", {}, h("td", {}, "WikiBidous"), h("td", {}), h("td", { className: "num" }, wb(s.wb))) : null) : h("p", { className: "muted" }, "rien pour l'instant"),
  ];
  const verdict = Math.abs(d.gap) < 1 ? "Échange équilibré" : `${d.gap > 0 ? "En ta faveur" : `En faveur de ${d.friend}`} : ≈ ${wb(Math.abs(d.gap))}` +
    (d.pct !== null ? ` (${d.gap > 0 ? "+" : "−"}${Math.abs(d.pct)} %)` : "");
  return h("div", { className: "box" },
    h("h3", {}, `Offre à ${d.friend}`),
    ...side("Tu donnes", d.give, "Mes cartes"),
    ...side("Tu reçois", d.get, `Cartes de ${d.friend}`),
    h("p", { className: d.gap >= 0 ? "good" : "error" }, h("b", {}, verdict)),
    h("p", { className: "muted" }, "Prix moyen du site dans la rareté de chaque carte. Les shiny n'ont pas de prix."));
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

// ------------------------------------------------------------------ Collection (#18)
async function summary(refresh) {
  return ask("panel", { action: "summary", refresh });
}

function readLine(s) {
  return h("p", { className: "muted" }, `Collection lue il y a ${WME.ago(Date.now() - s.at)} · ${fr(s.waiting)} prix en attente `,
    h("button", { className: "act small", on: { click: async () => { fill(main, h("p", { className: "muted" }, "Lecture de ta collection…")); await summary(true); draw(false); } } }, "Relire"));
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
  if (first) fill(main, h("p", { className: "muted" }, "Lecture de ta collection…"));
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
      ...sum.byRarity.map((r) => h("tr", {}, h("td", {}, rar(r.rarity)), h("td", { className: "num" }, fr(r.copies)),
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
    h("table", {}, ...sum.top.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, rar(c.rarity)),
      h("td", { className: "num" }, `${c.sure ? "" : "≈ "}${wb(c.price)}`)))),
  ];
}

// ------------------------------------------------------------------ Filtres (#19) : sur toute la collection, pas
// seulement la page de 50 cartes du site, la mienne ou celle d'un ami (#51). Formulaire construit une fois ; « Filtrer »
// relance la recherche.
const RARITY_CODES = ["L", "UR", "SR", "R", "PC", "C"];
const DURATIONS = [[10, "10 min"], [30, "30 min"], [60, "1 h"], [180, "3 h"], [360, "6 h"], [720, "12 h"]];
let lastCriteria = { sort: "value-desc", price: "all", rarities: [], source: "me", tags: [], friendRarities: ["L"] };

// Mise en vente d'un exemplaire en trop (ma collection) : prix de départ (la cote par défaut) et durée, puis confirmation.
// Le formulaire s'ouvre sous la ligne de la carte ; un second clic le referme.
function sellForm(item, row, cell, span = 5) {
  if (row.nextElementSibling && row.nextElementSibling.classList.contains("sell")) return row.nextElementSibling.remove();
  const amount = h("input", { type: "number", min: 1, step: 1, value: item.price ? Math.round(item.price) : "", className: "small wide-small" });
  const minutes = h("select", {}, ...DURATIONS.map(([m, l]) => h("option", { value: m, selected: m === 60 }, l)));
  const status = h("span", { className: "muted" });
  const go = h("button", { className: "act small", on: { click: async () => {
    const base = Math.round(Number(amount.value));
    if (!(base >= 1)) { status.textContent = " prix de départ ?"; return; }
    const label = DURATIONS.find(([m]) => m === Number(minutes.value))[1];
    if (!await dialog({ title: "Mettre en vente", lines: [`Un exemplaire de « ${item.title} » (${item.rarity}), mise de départ ${fr(base)} WB, pendant ${label}.`,
      "L'enchère part sur le marché du site, comme avec son bouton « Mettre aux enchères »."], ok: "Mettre en vente" })) return;
    go.disabled = true;
    status.textContent = " envoi…";
    const reply = await ask("panel", { action: "sell", copy: item.sellCopy, base, minutes: Number(minutes.value) });
    if (!reply.ok) { go.disabled = false; status.textContent = ` ${reply.error}`; return; }
    status.textContent = " en vente sur le marché.";
    fill(cell, h("span", { className: "good" }, "en vente"));
  } } }, "Mettre en vente");
  row.after(h("tr", { className: "sell" }, h("td", { colSpan: span }, "Mise de départ ", amount, " WB · durée ", minutes, " ", go, status)));
}

// Pseudo du profil ouvert dans l'onglet du site (/profile/<pseudo>), pour le proposer d'office.
async function visitedProfile() {
  const tab = await siteTab();
  const m = tab && tab.url ? /^https:\/\/(?:www\.)?wiki-masters\.com\/profile\/([^/?#]+)/.exec(tab.url) : null;
  return m ? decodeURIComponent(m[1]) : "";
}

async function filtersView() {
  const c = lastCriteria;
  const results = h("div", {});
  const check = (key, label) => h("label", { className: "inline" }, h("input", { type: "checkbox", checked: Boolean(c[key]), on: { change: (e) => { c[key] = e.target.checked; } } }), ` ${label}`);
  const rarityChips = (key) => RARITY_CODES.map((r) => h("label", { className: "inline" }, h("input", { type: "checkbox", checked: c[key].includes(r),
    on: { change: (e) => { c[key] = e.target.checked ? [...c[key], r] : c[key].filter((x) => x !== r); } } }), ` ${r}`));
  const text = h("input", { type: "search", value: c.text || "", placeholder: "mots du titre de la carte (ex. Wikipédia)", className: "wide", on: { input: (e) => { c.text = e.target.value; } } });
  const min = h("input", { type: "number", value: c.min ?? "", placeholder: "de", className: "small", on: { input: (e) => { c.min = e.target.value; } } });
  const max = h("input", { type: "number", value: c.max ?? "", placeholder: "à", className: "small", on: { input: (e) => { c.max = e.target.value; } } });
  const price = h("select", { on: { change: (e) => { c.price = e.target.value; range.hidden = c.price !== "range"; } } },
    ...[["all", "Tous les prix"], ["never", "Jamais vendues (dans leur rareté)"], ["range", "Vendues entre…"]].map(([v, l]) => h("option", { value: v, selected: c.price === v }, l)));
  const range = h("span", { hidden: c.price !== "range" }, " ", min, " et ", max, " WB");

  // Source : ma collection ou celle d'un ami (liste de mes amis sur le site), lue par la route de son profil.
  const source = h("select", {}, h("option", { value: "me" }, "Ma collection"));
  const friendStatus = h("span", { className: "muted" });
  const readButton = h("button", { className: "act small" }, "Lire sa collection");
  const friendBox = h("div", { className: "box", hidden: c.source === "me" },
    h("p", { className: "muted" }, "Raretés à lire (une page de 50 cartes par seconde : les L seules vont vite) :"),
    h("div", {}, ...rarityChips("friendRarities")), readButton, friendStatus,
    h("label", {}, h("input", { type: "checkbox", checked: Boolean(c.notMine), on: { change: (e) => { c.notMine = e.target.checked; } } }), " Seulement celles que je n'ai pas"),
    h("p", { className: "muted" }, "Avec « Dans ma liste de souhaits », pas besoin de lire sa collection : l'extension part de tes souhaits et " +
      "demande au site lesquels il ou elle possède (quelques secondes, quelle que soit la taille de sa collection)."));

  // Étiquettes de la collection choisie, dans un menu déroulant : toutes celles choisies sont exigées (« Lieu » et
  // « Religion » : temples, églises…). « Sans étiquette » exclut les autres.
  const tagBox = h("div", {});
  let tagNames = [];
  const drawTags = () => {
    const chosen = [...c.tags.map((id) => [id, (tagNames.find(([t]) => t === id) || [id, id])[1]]), ...(c.untagged ? [["", "Sans étiquette"]] : [])];
    const pick = h("select", { on: { change: () => {
      if (pick.value === "-none") [c.untagged, c.tags] = [true, []];
      else if (pick.value) [c.untagged, c.tags] = [false, [...c.tags, pick.value]];
      drawTags();
    } } },
    h("option", { value: "" }, chosen.length ? "Ajouter une étiquette…" : "Toutes (aucune exigée)"),
    ...tagNames.filter(([id]) => !c.tags.includes(id)).map(([id, name]) => h("option", { value: id }, name)),
    !c.untagged && h("option", { value: "-none" }, "Sans étiquette"));
    const remove = (id) => { if (id) c.tags = c.tags.filter((x) => x !== id); else c.untagged = false; drawTags(); };
    fill(tagBox, h("label", {}, "Étiquettes ", pick),
      chosen.length ? h("div", {}, ...chosen.map(([id, name]) => h("span", { className: "chip" }, name,
        h("button", { title: "Retirer", ariaLabel: `Retirer ${name}`, on: { click: () => remove(id) } }, "×")))) : null,
      chosen.length > 1 ? h("p", { className: "muted" }, "Une carte doit les avoir toutes.") : null);
  };
  const loadTags = async () => {
    fill(tagBox, h("p", { className: "muted" }, "Étiquettes : lecture…"));
    const reply = await ask("panel", { action: "tags", source: c.source });
    if (!reply.ok || reply.tagsError) return fill(tagBox, h("p", { className: "muted" }, `Étiquettes : ${reply.error || reply.tagsError}`));
    tagNames = Object.entries(reply.tags || {}).sort(([, a], [, b]) => a.localeCompare(b, "fr"));
    c.tags = c.tags.filter((id) => reply.tags[id]);
    if (!tagNames.length) return fill(tagBox, h("p", { className: "muted" }, c.source === "me" ? "Étiquettes : aucune." : "Étiquettes : lis d'abord sa collection."));
    drawTags();
  };

  // Lecture d'un ami : elle continue dans l'onglet du site si le panneau change d'onglet ; on suit sa progression.
  let following = null;
  const follow = () => {
    clearInterval(following);
    following = setInterval(async () => {
      if (!friendStatus.isConnected) return clearInterval(following);
      const st = await ask("panel", { action: "friendStatus" });
      if (st.ok && st.reading) friendStatus.textContent = ` lecture de ${st.reading.pseudo} : ${st.reading.pages} page(s), ${fr(st.reading.copies)} exemplaire(s)…`;
      else clearInterval(following);
    }, 1500);
  };
  const showKnown = (st) => {
    const known = st.ok && st.known.find((k) => k.pseudo.toLowerCase() === String(c.source).toLowerCase());
    friendStatus.textContent = known ? ` ${fr(known.copies)} exemplaire(s) lus il y a ${WME.ago(Date.now() - known.at)} (${known.rarities.join(", ")}).` : " pas encore lue.";
  };
  readButton.addEventListener("click", async () => {
    if (c.source === "me") return;
    readButton.disabled = true;
    friendStatus.textContent = " lecture…";
    follow();
    const reply = await ask("panel", { action: "friendRead", pseudo: c.source, rarities: c.friendRarities });
    clearInterval(following);
    readButton.disabled = false;
    if (!reply.ok) { friendStatus.textContent = ` ${reply.error}`; return; }
    friendStatus.textContent = ` ${fr(reply.copies)} exemplaire(s) lus${reply.truncated ? " (60 pages au plus : choisis moins de raretés)" : ""}.`;
    loadTags();
    run();
  });
  source.addEventListener("change", async () => {
    c.source = source.value;
    c.tags = [];
    friendBox.hidden = c.source === "me";
    const st = await ask("panel", { action: "friendStatus" });
    if (st.ok && st.reading) { friendStatus.textContent = ` lecture de ${st.reading.pseudo} en cours…`; follow(); } else if (c.source !== "me") showKnown(st);
    loadTags();
  });
  Promise.all([ask("panel", { action: "friends" }), visitedProfile(), ask("panel", { action: "friendStatus" })]).then(([reply, visited, st]) => {
    if (!reply.ok) return source.append(h("option", { disabled: true }, `Amis : ${reply.error}`));
    source.append(...reply.names.map((n) => h("option", { value: n }, n)));
    // Sur le profil d'un ami : sa collection d'office (une fois par visite du profil).
    const friend = reply.names.find((n) => n.toLowerCase() === visited.toLowerCase());
    if (friend && c.lastVisited !== friend) [c.source, c.lastVisited] = [friend, friend];
    if (c.source !== "me" && !reply.names.includes(c.source)) c.source = "me";
    source.value = c.source;
    friendBox.hidden = c.source === "me";
    if (st.ok && st.reading) { friendStatus.textContent = ` lecture de ${st.reading.pseudo} en cours…`; follow(); } else if (c.source !== "me") showKnown(st);
    loadTags();
  });

  const sort = h("select", { on: { change: (e) => { c.sort = e.target.value; } } },
    ...[["value-desc", "Valeur décroissante"], ["value-asc", "Valeur croissante"], ["rarity", "Rareté"]].map(([v, l]) => h("option", { value: v, selected: c.sort === v }, l)));

  const run = async () => {
    fill(results, h("p", { className: "muted" }, "Recherche…"));
    const reply = await ask("panel", { action: "filter", criteria: c });
    if (!reply.ok) return fill(results, ...error(reply));
    const label = (i) => (i.state === "price" ? `${i.sure ? "" : "≈ "}${wb(i.price)}` : i.state === "never" ? "jamais vendue" : i.shiny ? "✦ ?" : "?");
    // Tous les exemplaires de la carte (doublons) : « L · UR ×2 · SR✦ », 🔒 pour les favoris (verrouillés par le site).
    const variants = (i) => i.variants.map((v) => `${v.rarity}${v.shiny ? "✦" : ""}${v.copies > 1 ? ` ×${v.copies}` : ""}${v.starred ? " 🔒" : ""}`).join(" · ");
    const mine = c.source === "me";
    fill(results, 
      reply.source && h("p", { className: "muted" }, `Collection de ${reply.source}`),
      h("p", {}, `${fr(reply.count)} carte(s)${reply.count > reply.items.length ? ` (les ${reply.items.length} premières)` : ""}`),
      h("table", {}, h("tr", {}, h("th", {}, "Carte"), h("th", {}, "Rareté"), h("th", { className: "num" }, "Ex."), h("th", { className: "num" }, "Prix"), mine ? h("th", {}) : null),
        ...reply.items.map((i) => {
          const cell = h("td", {});
          const row = h("tr", {},
            h("td", {}, i.title, i.variants.length > 1 || i.copies > 1 ? h("div", { className: "muted" }, variants(i)) : null),
            h("td", {}, rar(i.rarity, i.shiny), i.starred ? " 🔒" : "", i.unsure ? h("span", { className: "muted", title: "Le site ne dit pas si c'est un favori" }, " favori ?") : ""),
            h("td", { className: "num" }, i.copies === null ? "—" : fr(i.copies)), h("td", { className: "num" }, label(i)), mine ? cell : null);
          if (mine && i.sellCopy) cell.append(h("button", { className: "act small", title: "Mettre un exemplaire en vente", on: { click: () => sellForm(i, row, cell) } }, "Vendre"));
          return row;
        })),
      h("p", { className: "muted" }, "« ? » : prix pas encore lu (onglet Collection pour lire les prix manquants). 🔒 : favori, que le site ne laisse ni vendre ni échanger." +
        (mine ? " « Vendre » : pour une carte en plusieurs exemplaires, un exemplaire de cette rareté qui n'est ni favori ni shiny." : "") +
        (reply.unsure ? " « favori ? » : le site ne dit pas si son exemplaire est un favori ; « Lire sa collection » le vérifie." : "") +
        (reply.items.some((i) => i.copies === null) ? " « — » : nombre d'exemplaires inconnu sans lire sa collection." : "")));
  };
  return [
    h("label", {}, "Dans ", source), friendBox,
    h("div", {}, check("duplicates", "Doublons"), check("noImage", "Sans image"), check("gif", "GIF"), check("wished", "Dans ma liste de souhaits")),
    h("div", {}, ...rarityChips("rarities")),
    text,
    h("div", {}, price, range),
    tagBox,
    h("label", {}, "Trier par ", sort),
    h("button", { className: "act primary", on: { click: run } }, "Filtrer"),
    results,
  ];
}

// ------------------------------------------------------------------ Souhaits (#21) : la liste de souhaits du site,
// chiffrée au prix le plus bas connu de chaque carte (toutes raretés), et ceux de mes amis qui peuvent me l'échanger.
let wishRefresh = false;
async function wishesView() {
  const s = await ask("panel", { action: "wishlist", refresh: wishRefresh });
  wishRefresh = false;
  if (!s.ok) return error(s);
  if (!s.items.length) return [h("p", {}, "Ta liste de souhaits est vide.")];
  const f = s.friends || {};
  const friendsLine = f.reading ? h("p", { className: "muted" }, "Recherche de tes souhaits chez tes amis…")
    : f.error ? h("p", { className: "warn" }, `Chez mes amis : ${f.error}`)
    : f.at && !f.given ? h("p", { className: "warn" }, "Le site n'a pas dit lesquels de tes amis ont ces cartes.") : null;
  // Un ami par ligne : pseudo, raretés échangeables. Favori seulement : grisé, 🔒 ; inconnu : « ? ».
  const owners = (list) => {
    if (!list) return h("span", { className: "muted" }, "…");
    if (!list.length) return h("span", { className: "muted" }, "personne");
    const shown = list.slice(0, 4).map((o) => h("div", { className: o.status === "locked" ? "muted" : "",
      title: o.status === "locked" ? "Seulement en favori : le site ne le laisse pas échanger" : o.status === "unknown" ? "Le site ne dit pas si c'est un favori" : "Échangeable" },
    o.status === "locked" ? "🔒 " : "", o.username, " ", ...o.rarities.map((r) => [rar(r), " "]), o.status === "unknown" ? "?" : ""));
    return [...shown, list.length > 4 ? h("div", { className: "muted" }, `+ ${list.length - 4} autre(s)`) : null];
  };
  const free = s.items.filter((i) => i.friends && i.friends.some((o) => o.status !== "locked")).length;
  return [
    h("p", { className: "big" }, `≈ ${fr(s.total)} WB`),
    h("p", { className: "muted" }, `${s.items.length} carte(s) souhaitée(s) · ${s.priced} avec un prix (le plus bas connu, toutes raretés) · ` +
      `${s.never} jamais vendue(s) · ${s.unknown} prix pas encore lu(s)` + (f.given ? ` · ${free} chez un ami` : "")),
    friendsLine,
    h("div", {},
      h("button", { className: "act", disabled: !s.unknown, on: { click: async (e) => {
        e.target.disabled = true;
        const reply = await ask("panel", { action: "loadWishPrices" });
        e.target.textContent = reply.ok ? `${reply.count} carte(s) en file` : reply.error;
      } } }, s.unknown ? `Lire les prix manquants (${s.unknown})` : "Tous les prix sont lus"),
      h("button", { className: "act small", on: { click: () => { wishRefresh = true; draw(true); } } }, "Relire la liste")),
    h("table", {}, h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Dès"), h("th", {}, "Chez mes amis")),
      ...s.items.map((i) => {
        const others = i.prices.filter(([r]) => !i.cheapest || r !== i.cheapest.rarity);
        return h("tr", {},
          h("td", {}, i.title + (i.owned ? " ✓" : ""), others.length ? h("div", { className: "muted" }, others.map(([r, avg]) => `${r} ${wb(avg)}`).join(" · ")) : null),
          h("td", { className: "num" }, i.cheapest ? [rar(i.cheapest.rarity), ` ${wb(i.cheapest.avg)}`] : i.state === "never" ? "jamais vendue" : "?"),
          h("td", {}, owners(f.given ? i.friends : null)));
      })),
    h("p", { className: "muted" }, "« ✓ » : tu as déjà la carte (dans une autre rareté, sans doute). Chez mes amis : ceux qui l'ont, avec les raretés " +
      "qu'ils peuvent t'échanger (pas en favori). 🔒 : seulement en favori. « ? » : le site ne dit pas si c'est un favori ; lire sa " +
      "collection dans l'onglet Filtres le vérifie. Relu toutes les 30 min."),
  ];
}

// ------------------------------------------------------------------ Familles (#20) : groupes de cartes à compléter,
// gardés dans l'extension (wmFamilies). Cartes ajoutées par une recherche dans le catalogue du site ou depuis une
// étiquette ; progression, cartes manquantes et leur coût ; partage par code.
const FAMILIES_KEY = "wmFamilies";
let openFamily = null;
const loadFamilies = async () => (await chrome.storage.local.get(FAMILIES_KEY))[FAMILIES_KEY] || [];
const saveFamilies = (list) => chrome.storage.local.set({ [FAMILIES_KEY]: list });

async function familiesView(first) {
  const families = await loadFamilies();
  if (openFamily && families.some((f) => f.id === openFamily)) return familyView(families, families.find((f) => f.id === openFamily), first);
  const name = h("input", { type: "text", placeholder: "nom de la famille", className: "wide" });
  const code = h("input", { type: "text", placeholder: "code WME-F1.… d'une famille partagée", className: "wide" });
  const status = h("p", { className: "muted" });
  const info = families.length ? await ask("panel", { action: "cardsInfo", ids: [...new Set(families.flatMap((f) => f.cards.map((c) => c.id)))] }) : { ok: true, info: {} };
  return [
    h("p", { className: "muted" }, "Une famille, c'est une liste de cartes que tu veux réunir : un thème, une région, une série… Le panneau suit " +
      "combien tu en as, lesquelles manquent et ce qu'elles coûtent."),
    families.length ? h("table", {}, ...families.map((f) => {
      const p = WME.familyProgress(f.cards, (info.ok && info.info) || {});
      return h("tr", {}, h("td", {}, h("a", { href: "#", on: { click: (e) => { e.preventDefault(); openFamily = f.id; draw(true); } } }, f.name)),
        h("td", { className: "num" }, `${p.owned} / ${p.total}`), h("td", { className: "num" }, p.missing.length ? `≈ ${wb(p.cost)} WB` : "complète"));
    })) : h("p", { className: "muted" }, "Aucune famille pour l'instant."),
    h("h3", {}, "Nouvelle famille"),
    name,
    h("button", { className: "act", on: { click: async () => {
      if (!name.value.trim()) return;
      const family = { id: `f${Date.now()}`, name: name.value.trim().slice(0, 80), cards: [] };
      await saveFamilies([...families, family]);
      openFamily = family.id;
      draw(true);
    } } }, "Créer"),
    h("h3", {}, "Importer une famille partagée"),
    code,
    h("button", { className: "act", on: { click: async () => {
      const read = WME.readFamilyCode(code.value);
      if (!read) { status.textContent = "Code illisible."; return; }
      await saveFamilies([...families, { id: `f${Date.now()}`, ...read }]);
      draw(true);
    } } }, "Importer"),
    status,
  ];
}

// Catégories Wikipédia (#20) : la recherche du site ne regarde que le titre (« Aveyron » ne trouve pas les communes
// de l'Aveyron). Les articles d'une catégorie, et de ses sous-catégories, donnent ces cartes : chaque article de
// Wikipédia en français est une carte. Seul le nom cherché part vers l'API publique de Wikipédia, sans cookie.
const WIKI_API = "https://fr.wikipedia.org/w/api.php";
const wikiGet = async (params) => {
  const response = await fetch(`${WIKI_API}?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params })}`, { credentials: "omit" });
  if (!response.ok) throw new Error(`Wikipédia : HTTP ${response.status}`);
  return response.json();
};

async function findCategories(q) {
  const data = await wikiGet({ action: "query", generator: "search", gsrsearch: q, gsrnamespace: "14", gsrlimit: "15", prop: "categoryinfo" });
  return ((data.query && data.query.pages) || []).sort((a, b) => a.index - b.index)
    .map((p) => ({ title: p.title, pages: (p.categoryinfo && p.categoryinfo.pages) || 0, subcats: (p.categoryinfo && p.categoryinfo.subcats) || 0 }));
}

// Articles d'une catégorie jusqu'à `depth` niveaux de sous-catégories, 5000 au plus. onProgress(articles, catégories).
async function categoryArticles(category, depth, onProgress) {
  const titles = new Set();
  const seenCats = new Set([category]);
  let level = [category];
  for (let d = 0; d <= depth && level.length && titles.size < 5000; d++) {
    const next = [];
    for (const cat of level) {
      let cont = {};
      do {
        const data = await wikiGet({ action: "query", list: "categorymembers", cmtitle: cat, cmtype: d < depth ? "page|subcat" : "page", cmnamespace: d < depth ? "0|14" : "0", cmlimit: "500", ...cont });
        for (const m of (data.query && data.query.categorymembers) || []) {
          if (m.ns === 0) titles.add(m.title);
          else if (m.ns === 14 && !seenCats.has(m.title) && seenCats.size < 300) { seenCats.add(m.title); next.push(m.title); }
        }
        cont = data.continue || null;
        onProgress(titles.size, seenCats.size);
      } while (cont && titles.size < 5000);
      if (titles.size >= 5000) break;
    }
    level = next;
  }
  return [...titles].slice(0, 5000);
}

async function familyView(families, family, first) {
  const update = async (change) => {
    const list = (await loadFamilies()).map((f) => (f.id === family.id ? change(f) : f));
    await saveFamilies(list);
    draw(false);
  };
  const addCards = (cards) => update((f) => ({ ...f, cards: [...f.cards, ...cards.filter((c) => !f.cards.some((o) => o.id === c.id)).map((c) => ({ id: c.id, title: c.title }))] }));
  const reply = await ask("panel", { action: "cardsInfo", ids: family.cards.map((c) => c.id) });
  const info = (reply.ok && reply.info) || {};
  const p = WME.familyProgress(family.cards, info);
  const unread = family.cards.filter((c) => !(info[c.id] && info[c.id].read)).map((c) => c.id);
  // À chaque ouverture de la famille, ses prix manquants partent en file (après les cartes affichées sur le site) : ils
  // arrivent au fil des minutes, et vont aussi au serveur partagé.
  if (first && unread.length) ask("panel", { action: "loadCardPrices", ids: unread });

  // Recherche par titre dans le catalogue du site, 50 cartes par page.
  const search = h("input", { type: "search", placeholder: "morceau de titre (ex. Wikimasters, Marseille)", className: "wide" });
  const found = h("div", {});
  let searchPage = 1;
  let searchCards = [];
  const runSearch = async (more) => {
    searchPage = more ? searchPage + 1 : 1;
    if (!more) { searchCards = []; fill(found, h("p", { className: "muted" }, "Recherche…")); }
    const r = await ask("panel", { action: "catalogSearch", q: search.value, page: searchPage });
    if (!r.ok) return fill(found, ...error(r));
    searchCards = [...searchCards, ...r.cards.filter((c) => !searchCards.some((o) => o.id === c.id))];
    fill(found, 
      h("p", { className: "muted" }, `${searchCards.length} carte(s)`),
      searchCards.length > 1 && h("button", { className: "act small", on: { click: () => addCards(searchCards) } }, `Tout ajouter (${searchCards.length})`),
      r.more && h("button", { className: "act small", on: { click: () => runSearch(true) } }, "Plus de résultats"),
      h("table", {}, ...searchCards.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, rar(c.rarity)),
        h("td", {}, family.cards.some((o) => o.id === c.id) ? "déjà" : h("button", { className: "act small", on: { click: () => addCards([c]) } }, "+"))))));
  };
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(false); });

  // Catégorie Wikipédia : chercher la catégorie, choisir la profondeur, compter, puis tout ajouter.
  const catQuery = h("input", { type: "search", placeholder: "catégorie (ex. Wikipédia, Volcan)", className: "wide" });
  const catBox = h("div", {});
  const runCategories = async () => {
    if (catQuery.value.trim().length < 2) return;
    fill(catBox, h("p", { className: "muted" }, "Recherche des catégories…"));
    let cats;
    try {
      cats = await findCategories(catQuery.value.trim());
    } catch (e) {
      return fill(catBox, h("p", { className: "error" }, e.message));
    }
    if (!cats.length) return fill(catBox, h("p", { className: "muted" }, "Aucune catégorie de ce nom."));
    const pick = h("select", { className: "wide" }, ...cats.map((c) => h("option", { value: c.title }, `${c.title.replace(/^Catégorie:/, "")} (${fr(c.pages)} articles, ${fr(c.subcats)} sous-catégories)`)));
    const depth = h("select", {}, ...[[0, "cette catégorie seule"], [1, "et ses sous-catégories"], [2, "sur 2 niveaux"], [3, "sur 3 niveaux"]].map(([v, l]) => h("option", { value: v, selected: v === 1 }, l)));
    const status = h("p", { className: "muted" });
    const result = h("div", {});
    const count = h("button", { className: "act small", on: { click: async () => {
      count.disabled = true;
      fill(result, );
      try {
        const titles = await categoryArticles(pick.value, Number(depth.value), (n, cats2) => { status.textContent = `${fr(n)} article(s) dans ${fr(cats2)} catégorie(s)…`; });
        status.textContent = `${fr(titles.length)} article(s)${titles.length >= 5000 ? " (5000 au plus)" : ""} : recherche des cartes…`;
        const r = await ask("panel", { action: "cardsByTitles", titles });
        if (!r.ok) throw new Error(r.error);
        const fresh = r.cards.filter((c) => !family.cards.some((o) => o.id === c.id));
        status.textContent = `${fr(titles.length)} article(s), ${fr(r.cards.length)} carte(s) du jeu, dont ${fr(fresh.length)} pas encore dans la famille.`;
        if (fresh.length) fill(result, h("button", { className: "act", on: { click: () => addCards(fresh) } }, `Ajouter ${fr(fresh.length)} carte(s)`),
          h("p", { className: "muted" }, fresh.slice(0, 30).map((c) => c.title).join(" · ") + (fresh.length > 30 ? " …" : "")));
      } catch (e) {
        status.textContent = e.message;
      }
      count.disabled = false;
    } } }, "Compter les cartes");
    fill(catBox, pick, h("div", {}, depth, count), status, result,
      h("p", { className: "muted" }, "Les sous-catégories peuvent s'éloigner du sujet (personnalités, histoire…) : regarde le nombre avant d'ajouter."));
  };
  catQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") runCategories(); });

  const tag = h("select", {}, h("option", { value: "" }, "Ajouter les cartes d'une de mes étiquettes…"));
  ask("panel", { action: "tags" }).then((r) => {
    if (r.ok) tag.append(...Object.entries(r.tags || {}).sort(([, a], [, b]) => a.localeCompare(b)).map(([id, n]) => h("option", { value: id }, n)));
  });
  tag.addEventListener("change", async () => {
    if (!tag.value) return;
    const r = await ask("panel", { action: "tagCards", tag: tag.value });
    if (r.ok) addCards(r.cards);
  });
  const shareStatus = h("span", { className: "muted" });

  return [
    h("p", {}, h("a", { href: "#", on: { click: (e) => { e.preventDefault(); openFamily = null; draw(true); } } }, "← Familles")),
    h("p", { className: "big" }, `${family.name} · ${p.owned} / ${p.total}`),
    h("div", { className: "bar" }, h("span", { style: `width: ${pct(p.owned, p.total).toFixed(1)}%` })),
    h("p", { className: "muted" }, p.missing.length ? `Il en manque ${p.missing.length} : ≈ ${fr(p.cost)} WB au prix le plus bas connu` +
      (p.unpriced ? ` (${p.unpriced} sans prix${unread.length ? `, ${unread.length} en cours de lecture` : ""})` : "") : "Famille complète !"),
    h("h3", {}, "Ajouter des cartes"),
    h("p", { className: "muted" }, "Chaque carte du jeu est un article de Wikipédia en français, et son titre est celui de l'article. Trois façons d'en ajouter :"),
    h("h4", {}, "Par catégorie Wikipédia"),
    h("p", { className: "muted" }, "Wikipédia range ses articles dans des catégories (« Volcan d'Italie », « Jeu vidéo sorti en 1998 »…). Cherche une " +
      "catégorie, choisis jusqu'où descendre dans ses sous-catégories, compte, puis ajoute les cartes de tous ses articles. Le plus complet pour un thème."),
    catQuery, h("button", { className: "act small", on: { click: runCategories } }, "Chercher la catégorie"), catBox,
    h("h4", {}, "Par titre de carte"),
    h("p", { className: "muted" }, "Comme la recherche de la page « Toutes les cartes » du site : un morceau du titre suffit (« Marseille » trouve aussi " +
      "« Olympique de Marseille »). Le site ne cherche que dans le titre, pas dans le texte de l'article."),
    search, h("button", { className: "act small", on: { click: () => runSearch(false) } }, "Chercher"), found,
    h("h4", {}, "Depuis une de mes étiquettes"),
    h("p", { className: "muted" }, "Toutes les cartes que tu as rangées sous cette étiquette sur le site."),
    tag,
    h("h3", {}, "Cartes manquantes"),
    p.missing.length ? h("table", {}, ...p.missing.slice(0, 500).map((c) => h("tr", {}, h("td", {}, c.title),
      h("td", { className: "num" }, c.cheapest ? `${c.cheapest.rarity} ${wb(c.cheapest.avg)}` : "?"),
      h("td", {}, h("button", { className: "act small", title: "Retirer de la famille", on: { click: () => update((f) => ({ ...f, cards: f.cards.filter((o) => o.id !== c.id) })) } }, "×"))))) : null,
    p.missing.length > 500 ? h("p", { className: "muted" }, `… et ${p.missing.length - 500} autres.`) : null,
    h("h3", {}, `Possédées (${p.owned})`),
    h("p", { className: "muted" }, family.cards.filter((c) => info[c.id] && info[c.id].owned).map((c) => c.title).join(" · ") || "aucune"),
    h("h3", {}, "Famille"),
    h("button", { className: "act small", on: { click: async () => {
      await navigator.clipboard.writeText(WME.familyCode(family)).then(() => { shareStatus.textContent = " code copié"; }, () => { shareStatus.textContent = ` ${WME.familyCode(family)}`; });
    } } }, "Partager (code)"), shareStatus, " ",
    h("button", { className: "act small", on: { click: async () => {
      if (!await dialog({ title: "Supprimer la famille", lines: [`« ${family.name} » et sa liste de ${family.cards.length} carte(s).`], ok: "Supprimer" })) return;
      await saveFamilies(families.filter((f) => f.id !== family.id));
      openFamily = null;
      draw(true);
    } } }, "Supprimer"),
  ];
}

// ------------------------------------------------------------------ Paquets : récap et automatisation
async function packsView() {
  const state = await ask("state");
  if (!state || state.ok === false) return error(state || {});
  return [
    lastPack(state.pulls && state.pulls.last),
    todayRates(state.pulls && state.pulls.today),
    pullsRecap(state.pulls) || h("p", { className: "muted" }, "Aucun paquet ouvert noté pour l'instant."),
    h("h3", {}, "Automatisation par clic (désactivée par défaut)"),
    h("p", { className: "muted" }, "Elle ne change jamais de page sous tes yeux : elle attend 5 min sans clic, frappe ni défilement. Les " +
      "règles de Wiki Masters l'interdisent : un avertissement est demandé avant de l'activer."),
    riskyToggle(state.autoClickPack, "autoClickPack", "Ouverture auto des paquets (/pulls)"),
    riskyToggle(state.autoUnblockMarket, "autoUnblockMarket", "Tentative de déblocage du marché (/collection) : met une vraie enchère"),
    clickStatus(state),
  ];
}

// Automatisation : avant de l'activer, l'avertissement à accepter (règles du site, responsabilité du joueur).
function riskyToggle(checked, type, label) {
  const box = h("input", { type: "checkbox", checked: Boolean(checked), on: { change: async (e) => {
    if (e.target.checked && !await automationWarning()) { box.checked = false; return; }
    await ask(type, { on: box.checked });
    draw(false);
  } } });
  return h("label", {}, box, ` ${label}`);
}

function automationWarning() {
  return dialog({
    title: "Avant d'activer l'automatisation",
    lines: [
      "WikiMastered est une extension non officielle, faite par un joueur. Elle n'est ni développée ni approuvée par Wiki Masters.",
      "Les règles de Wiki Masters interdisent les bots, scripts et outils qui jouent ou ouvrent des paquets à ta place. Ses conditions " +
        "d'utilisation prévoient la suspension ou le bannissement d'un compte qui utilise de l'automatisation, jusqu'à la perte définitive " +
        "du compte et de tout ce qu'il contient.",
    ],
    strong: "En l'activant, tu choisis de l'utiliser en connaissance de cause. Tu es seul responsable de son usage et de ses conséquences " +
      "pour ton compte, y compris une sanction ou un bannissement ; le développeur de l'extension ne peut pas en être tenu responsable.",
    check: "J'ai lu cet avertissement et j'active l'automatisation sous ma seule responsabilité.",
    ok: "Activer", cancel: "Laisser désactivé",
  });
}

// Le dernier paquet (#23) : chaque carte, nouvelle ou doublon, son prix, et la valeur du paquet.
function lastPack(last) {
  if (!last) return null;
  const tag = (c) => (c.isNew === true ? "Nouvelle" : c.isNew === false ? "Doublon" : "");
  return h("div", { className: "box" },
    h("h3", {}, `Dernier paquet · ${time(last.at)}${last.auto ? " (auto)" : ""} · ≈ ${wb(last.value)} WB`),
    h("table", {}, ...last.cards.map((c) => h("tr", {},
      h("td", {}, c.title), h("td", {}, rar(c.rarity, c.shiny)), h("td", { className: c.isNew ? "new" : "muted" }, tag(c)),
      h("td", { className: "num" }, Number.isFinite(c.price) ? wb(c.price) : "—")))),
    (last.fresh || last.doubles) ? h("p", { className: "muted" }, `${last.fresh} nouvelle(s) · ${last.doubles} doublon(s)`) : null);
}

// Taux de tirage du jour (#24), remis à zéro à minuit (heure du navigateur).
function todayRates(today) {
  if (!today || !today.packs) return null;
  return h("div", { className: "box" },
    h("h3", {}, `Aujourd'hui · ${today.packs} paquet(s) · ${today.cards} carte(s)`),
    rarityTable(today.byRarity, today.cards));
}

// Raretés tirées : rareté, barre, nombre de cartes, part.
function rarityTable(byRarity, total) {
  const order = (r) => (WME.rank(r) < 0 ? -1 : WME.rank(r));
  const rows = Object.entries(byRarity).sort(([a], [b]) => order(b) - order(a));
  const most = Math.max(...rows.map(([, n]) => n), 1);
  return h("table", { className: "rates" }, ...rows.map(([r, n]) => h("tr", {}, h("td", {}, rar(r)), h("td", { className: "bar-cell" }, bar(n, most)),
    h("td", { className: "num" }, fr(n)), h("td", { className: "num" }, pctText(n, total)))));
}

// Récap des paquets ouverts, à la main et en auto (pullRecap, src/lib.js).
function pullsRecap(recap) {
  if (!recap || !(recap.packs || recap.earlier)) return null;
  const total = recap.cards + recap.earlier;
  return h("div", { className: "box" },
    h("h3", {}, `Paquets ouverts · ${fr(total)} carte(s)`, recap.earlier > 0 ? info(`Dont ${fr(recap.earlier)} carte(s) ouvertes avant l'installation, ` +
      "reprises des compteurs de l'extension « Prix moyen collection » : comptées dans la répartition par rareté, sans prix ni détail.") : null),
    rarityTable(recap.byRarity, total),
    recap.shiny > 0 && h("p", { className: "muted" }, `✦ ${recap.shiny} shiny`),
    recap.packs > 0 && h("p", {}, `Depuis le ${dateTime(recap.since)} : ${recap.packs} paquet(s) · ${recap.cards} carte(s) · ≈ ${wb(recap.value)} WB`),
    recap.packs > 0 && h("p", { className: "muted" }, `${recap.auto} en auto · ${recap.manual} à la main`),
    recap.missing > 0 && h("p", { className: "muted" }, `${recap.missing} carte(s) sans prix (shiny, aucune vente ou pas encore lu)`),
    recap.best.length > 0 && h("p", { className: "muted" }, "Meilleurs tirages : " + recap.best.map((c) => `${c.title} ${c.rarity} ≈ ${wb(c.price)}`).join(" · ")),
    h("button", { className: "act", on: { click: async () => {
      if (await dialog({ title: "Remettre le récap à zéro", lines: ["Tous les paquets notés et les compteurs repris seront oubliés."], ok: "Remettre à zéro" })) { await ask("clearPulls"); draw(false); }
    } } }, "Remettre le récap à zéro"));
}

function clickStatus(state) {
  const info = state.clickInfo;
  if (!info || !(state.autoClickPack || state.autoUnblockMarket)) return null;
  const notes = [info.challengeVisible && "vérification affichée", info.userQuiet ? "joueur inactif" : "joueur actif : pas de changement de page"].filter(Boolean);
  return h("p", { className: "muted" }, `État : ${info.status} · ${notes.join(" · ")}`);
}

// ------------------------------------------------------------------ Enchères : deux sous-onglets. Achat : mes mises
// en cours, ce que j'ai gagné, les bonnes affaires vues sur le marché (#16). Vente : mes ventes en cours, terminées, et
// mes doublons à mettre en vente. Tout en lecture, sauf « Vendre » (sur clic, après confirmation) ; miser reste au site
// (ou au bot). La partie en direct se relit toute seule toutes les 5 s (le site, au plus toutes les 20 s).
let auctionSide = "buy";
const leftText = (at) => {
  if (!at) return "?";
  const min = Math.max(0, Math.round((at - Date.now()) / 60e3));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
};
const nextBid = (price) => Math.max(Math.ceil(1.1 * price), price + 1); // mise minimum du site
const quoteText = (a) => (a.shiny ? "✦ ?" : a.quote ? `${a.quote.sure ? "" : "≈ "}${wb(a.quote.avg)}` : "?");
// Écart d'un prix à la cote, en vert sous la cote, en rouge au-dessus (inversé pour un vendeur).
const gapCell = (price, a, seller) => {
  if (!a.quote || !(a.quote.avg > 0) || !(price > 0)) return h("td", { className: "num muted" }, "—");
  const pct = Math.round((price / a.quote.avg - 1) * 100);
  const good = seller ? pct >= 0 : pct <= 0;
  return h("td", { className: `num ${good ? "good" : "error"}` }, `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)} %`);
};
const cardCell = (a) => h("td", {}, a.title, " ", rar(a.rarity, a.shiny));

async function auctionsView() {
  const seg = h("div", { className: "seg", role: "tablist" }, ...[["buy", "Achat"], ["sell", "Vente"]].map(([key, label]) =>
    h("button", { className: auctionSide === key ? "on" : "", role: "tab", ariaSelected: String(auctionSide === key),
      on: { click: () => { auctionSide = key; draw(true); } } }, label)));
  const live = h("div", {}, h("p", { className: "muted" }, "Lecture de tes enchères…"));
  const stamp = h("span", { className: "muted" });
  let force = false;
  const refresh = async () => {
    const [state, m] = await Promise.all([ask("state"), ask("panel", { action: "market", refresh: force })]);
    force = false;
    stamp.textContent = m.ok ? ` lu à ${time(m.at)}` : "";
    fill(live, ...(auctionSide === "buy" ? buyLive(state, m) : sellLive(m)));
  };
  const again = h("button", { className: "act small", on: { click: () => { force = true; refresh(); } } }, "Relire");
  refresh();
  const timer = setInterval(() => (live.isConnected ? refresh() : clearInterval(timer)), 5e3);
  return [seg, h("p", { className: "muted" }, "Tes enchères sur le marché du site", stamp, again), live,
    ...(auctionSide === "buy" ? await buyStatic() : await sellStatic())];
}

function buyLive(state, m) {
  const out = [];
  if (!m.ok) out.push(h("p", { className: "error" }, m.error));
  else {
    const lead = m.bidding.filter((a) => a.leading);
    const engaged = lead.reduce((n, a) => n + a.price, 0);
    out.push(m.balance !== null && m.balance !== undefined ? h("p", { className: "big" }, `${fr(m.balance)} WB`) : null,
      m.balance !== null && m.balance !== undefined ? h("p", { className: "muted" }, "Ton solde" + (engaged ? ` · ≈ ${wb(engaged)} WB misés là où tu es en tête` : "")) : null,
      h("h3", {}, `Mes mises en cours (${m.bidding.length})`),
      m.bidding.length ? h("p", { className: "muted" }, `En tête sur ${lead.length} · engagé ≈ ${wb(engaged)} WB`) : null,
      m.bidding.length ? h("table", {},
        h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Mise"), h("th", { className: "num" }, "Cote"), h("th", {}, "État"), h("th", { className: "num" }, "Fin")),
        ...m.bidding.map((a) => h("tr", {}, cardCell(a), h("td", { className: "num" }, wb(a.price)), h("td", { className: "num" }, quoteText(a)),
          h("td", {}, a.leading ? h("span", { className: "tag-lead" }, "en tête") : [h("span", { className: "tag-out" }, "dépassé"),
            h("div", { className: "muted" }, `relance dès ${wb(nextBid(a.price))}`)]),
          h("td", { className: "num" }, leftText(a.endAt)))))
        : h("p", { className: "muted" }, "Aucune mise en cours."),
      h("h3", {}, "Gagnées récemment"),
      m.won.length ? h("table", {},
        h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Payé"), h("th", { className: "num" }, "Cote"), h("th", { className: "num" }, "Écart")),
        ...m.won.map((a) => { const paid = a.final ?? a.price; return h("tr", {}, cardCell(a), h("td", { className: "num" }, wb(paid)),
          h("td", { className: "num" }, quoteText(a)), gapCell(paid, a, false)); }))
        : h("p", { className: "muted" }, "Rien de gagné récemment."));
  }
  const deals = (state && state.auctionDeals) || [];
  out.push(h("h3", {}, "Bonnes affaires sur les pages du marché ouvertes"),
    deals.length ? h("table", {},
      h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Mise min."), h("th", { className: "num" }, "Cote"), h("th", { className: "num" }, "Écart"), h("th", { className: "num" }, "Fin")),
      ...deals.map((d) => h("tr", {}, h("td", {}, `${d.title} `, rar(d.rarity)), h("td", { className: "num" }, wb(d.bid)),
        h("td", { className: "num" }, wb(d.price)), h("td", { className: `num ${d.kind === "deal" ? "good" : "error"}` }, `${d.pct > 0 ? "+" : "−"}${Math.abs(d.pct)} %`),
        h("td", { className: "num" }, leftText(d.endAt)))))
      : h("p", { className: "muted" }, "Aucune pour l'instant. Ouvre le marché du site (tri « Fin proche » pour les bonnes affaires) : les enchères affichées dont le prix est connu apparaissent ici."));
  return out;
}

async function buyStatic() {
  const state = await ask("state");
  return [
    h("label", {}, h("input", { type: "checkbox", checked: Boolean(state && state.deals), on: { change: (e) => ask("deals", { on: e.target.checked }) } }),
      " Marquer les enchères sur le marché : « −34 % » bonne affaire, « +50 % » surcotée",
    info("Bonne affaire : l'enchère finit dans moins de 15 min et la mise minimum est au moins 25 % sous le prix moyen de la semaine. " +
      "Surcotée : la mise minimum dépasse ce prix de 50 % ou plus. Seulement avec un prix fiable, jamais pour un shiny.")),
    h("div", { className: "box" }, h("h3", {}, "Bientôt : enchères plafonnées"),
      h("p", { className: "muted" }, "Choisir une carte et un prix maximum, et laisser ton bot WikiMastered miser pour toi : réglé d'ici, " +
        "avec ou sans bot déjà installé. Pour l'instant, l'extension ne mise jamais.")),
  ];
}

function sellLive(m) {
  if (!m.ok) return [h("p", { className: "error" }, m.error)];
  const total = m.selling.reduce((n, a) => n + a.price, 0);
  const slots = m.max ? ` · ${Math.max(0, m.max - m.selling.length)} créneau(x) libre(s) sur ${m.max}` : "";
  return [
    h("h3", {}, `Mes ventes en cours (${m.selling.length}${m.max ? ` / ${m.max}` : ""})`),
    m.selling.length ? h("p", { className: "muted" }, `Rapporterait ≈ ${wb(total)} WB au prix actuel${slots}`) : h("p", { className: "muted" }, `Aucune vente en cours${slots}.`),
    m.selling.length ? h("table", {},
      h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Mise"), h("th", { className: "num" }, "Cote"), h("th", {}, "Enchérisseur"), h("th", { className: "num" }, "Fin")),
      ...m.selling.map((a) => h("tr", {}, cardCell(a),
        h("td", { className: "num" }, a.hasBid ? wb(a.price) : h("span", { className: "muted", title: "Mise de départ, personne n'a encore misé" }, `départ ${wb(a.price)}`)),
        h("td", { className: "num" }, quoteText(a)), h("td", {}, a.bidder || (a.hasBid ? "?" : h("span", { className: "muted" }, "personne"))),
        h("td", { className: "num" }, leftText(a.endAt))))) : null,
    h("h3", {}, "Terminées récemment"),
    m.history.length ? h("table", {},
      h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Vendue"), h("th", { className: "num" }, "Cote"), h("th", { className: "num" }, "Écart")),
      ...m.history.map((a) => {
        const sold = a.status !== "settled_unsold" && a.final !== null && a.final > 0;
        return h("tr", {}, cardCell(a), h("td", { className: "num" }, sold ? wb(a.final) : h("span", { className: "muted" }, "invendue")),
          h("td", { className: "num" }, quoteText(a)), sold ? gapCell(a.final, a, true) : h("td", {}));
      }))
      : h("p", { className: "muted" }, "Aucune vente terminée récemment."),
  ];
}

// Doublons à vendre : mes cartes en plusieurs exemplaires, les plus chères d'abord, avec le formulaire de vente (prix
// de départ proposé : la cote). Même règle que l'onglet Filtres : jamais un favori ni un shiny.
async function sellStatic() {
  const reply = await ask("panel", { action: "filter", criteria: { source: "me", duplicates: true, sort: "value-desc", price: "all", rarities: [], tags: [] } });
  const head = [h("h3", {}, "Doublons à vendre"), h("p", { className: "muted" }, "Un exemplaire en trop (ni favori ni shiny), mis aux enchères " +
    "comme avec le bouton du site. Prix de départ proposé : la cote de la carte dans sa rareté.")];
  if (!reply.ok) return [...head, h("p", { className: "error" }, reply.error)];
  const items = reply.items.filter((i) => i.sellCopy).slice(0, 25);
  if (!items.length) return [...head, h("p", { className: "muted" }, "Aucun doublon à vendre.")];
  return [...head, h("table", {}, h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Ex."), h("th", { className: "num" }, "Cote"), h("th", {})),
    ...items.map((i) => {
      const cell = h("td", {});
      const row = h("tr", {}, h("td", {}, i.title, " ", rar(i.rarity)), h("td", { className: "num" }, fr(i.copies)),
        h("td", { className: "num" }, i.state === "price" ? `${i.sure ? "" : "≈ "}${wb(i.price)}` : i.state === "never" ? "jamais vendue" : "?"), cell);
      cell.append(h("button", { className: "act small", on: { click: () => sellForm(i, row, cell, 4) } }, "Vendre"));
      return row;
    })),
  reply.count > items.length ? h("p", { className: "muted" }, "Les autres : onglet Filtres, case Doublons.") : null];
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
  return [
    h("h3", {}, "Sur les cartes"),
    h("label", {}, h("input", { type: "checkbox", checked: state.badges, on: { change: (e) => ask("badges", { on: e.target.checked }) } }), " Badges de prix"),
    h("label", {}, h("input", { type: "checkbox", checked: Boolean(state.images), on: { change: (e) => {
      if (!e.target.checked) return ask("images", { on: false });
      const box = e.target;
      requestAccess([]).then((granted) => (granted ? ask("images", { on: true }) : (box.checked = false)), () => { box.checked = false; });
    } } }),
      " Images Wikipédia pour les cartes sans image (le titre de ces cartes est envoyé à Wikipédia, sans rien d'autre)"),
    h("label", {}, "Prix fiable à partir de ", minSales, " vente(s) dans la semaine (sinon « ≈ »)"),
    h("h3", {}, "Cache des prix"),
    h("button", { className: "act", on: { click: async (e) => {
      if (await dialog({ title: "Relire tous les prix", lines: ["Les prix gardés sont oubliés et relus sur le site, dans le quota habituel : il faut du temps."], ok: "Relire" })) {
        await ask("reread");
        e.target.textContent = "Prix oubliés : relecture en cours";
      }
    } } },
      "Relire tous les prix"),
    h("h3", {}, "Données gardées par l'extension"),
    await dataSection(),
    h("h3", {}, "Prix partagés (facultatif)"),
    h("p", { className: "muted" }, "Le principe : les participants mettent en commun les prix qu'ils lisent. Quand ton extension lit le prix d'une " +
      "carte sur le site, elle le dépose sur un petit serveur ; quand il lui faut un prix qu'un autre participant (joueur ou bot) a lu depuis " +
      "moins de 6 h, elle le reçoit de ce serveur au lieu de le relire."),
    h("p", { className: "muted" }, "Pourquoi : le site limite la lecture des prix à environ 90 cartes toutes les 10 minutes, par compte. Seul, " +
      "chiffrer une grande collection prend des heures ; à plusieurs, chacun en lit une partie et profite du reste. Le site reçoit aussi " +
      "moins de requêtes."),
    h("p", { className: "muted" }, "Ce qui part : l'identifiant de chaque carte et son historique de prix, celui que le site montre à tout le " +
      "monde. Ni ton pseudo, ni tes cookies, ni ta collection. Le jeton dit seulement qui a déposé quoi, pour pouvoir écarter un participant " +
      "qui enverrait de faux prix."),
    h("p", { className: "muted" }, "Pour l'instant c'est un essai entre quelques joueurs : l'adresse du serveur et ton jeton se demandent au " +
      "développeur de l'extension. Sans eux, tout marche pareil, en lisant chaque prix toi-même."),
    await sharedSettings(),
  ];
}

// ------------------------------------------------------------------ Données (#27) : taille, vider, sauvegarder.
// Tout vit dans chrome.storage.local, propre à l'extension. La sauvegarde garde ce qui ne se relit pas sur le site
// (réglages, récap des paquets, courbe de valeur, relevé des refus) ; le cache des prix et la collection se relisent.
const DATA = [
  { key: "prices-v2", label: "Cache des prix", clear: true, backup: false },
  { key: "wmCollection", label: "Collection (relue toutes les 12 h)", clear: true, backup: false },
  { key: "wmOwned", label: "Cartes possédées ou non (« ✓ »)", clear: true, backup: false },
  { key: "wmPulls", label: "Récap des paquets", clear: false, backup: true },
  { key: "wmPullBaseline", label: "Compteurs repris de « Prix moyen collection »", clear: false, backup: true },
  { key: "wmValueHistory", label: "Courbe de la valeur (une mesure par jour)", clear: false, backup: true },
  { key: "wmFamilies", label: "Familles", clear: false, backup: true },
  { key: "wmLimitLog", label: "Relevé des refus du site", clear: true, backup: true },
  { key: "settings", label: "Réglages", clear: false, backup: true },
  { key: "shared", label: "Prix partagés : adresse et jeton", clear: false, backup: true },
];
const kb = (bytes) => (bytes < 1024 ? `${bytes} o` : `${(bytes / 1024).toLocaleString("fr-FR", { maximumFractionDigits: bytes < 10240 ? 1 : 0 })} Ko`);

async function dataSection() {
  const all = await chrome.storage.local.get(DATA.map((d) => d.key));
  const size = (key) => (all[key] === undefined ? 0 : new TextEncoder().encode(JSON.stringify(all[key])).length);
  const status = h("p", { className: "muted" });
  const rows = DATA.map((d) => h("tr", {}, h("td", {}, d.label), h("td", { className: "num" }, kb(size(d.key))),
    h("td", {}, d.clear && all[d.key] !== undefined ? h("button", { className: "act small", on: { click: async () => {
      if (!await dialog({ title: "Vider", lines: [`« ${d.label} »`], ok: "Vider" })) return;
      await chrome.storage.local.remove(d.key);
      if (d.key === "prices-v2") await chrome.storage.local.remove("wmSharedSync");
      status.textContent = "Vidé. Recharge la page du site pour qu'elle reparte de zéro.";
      draw(true);
    } } }, "Vider") : "")));
  const total = DATA.reduce((n, d) => n + size(d.key), 0);

  const exportData = async () => {
    const data = await chrome.storage.local.get(DATA.filter((d) => d.backup).map((d) => d.key));
    const file = new Blob([JSON.stringify({ wikimastered: chrome.runtime.getManifest().version, at: new Date().toISOString(), data }, null, 1)], { type: "application/json" });
    const link = h("a", { href: URL.createObjectURL(file), download: `wikimastered-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    status.textContent = "Sauvegarde téléchargée. Elle contient ton jeton de prix partagés : garde-la pour toi.";
  };
  const picker = h("input", { type: "file", accept: "application/json,.json", hidden: true, on: { change: async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const allowed = new Set(DATA.filter((d) => d.backup).map((d) => d.key));
      const data = Object.fromEntries(Object.entries((parsed && parsed.data) || {}).filter(([k]) => allowed.has(k)));
      if (!Object.keys(data).length) throw new Error("aucune donnée WikiMastered dans ce fichier");
      if (!await dialog({ title: "Restaurer", lines: [`Remplacer ${Object.keys(data).length} donnée(s) par celles de la sauvegarde du ${String(parsed.at || "?").slice(0, 10)} ?`], ok: "Restaurer" })) return;
      await chrome.storage.local.set(data);
      status.textContent = "Sauvegarde restaurée. Recharge la page du site pour qu'elle la prenne en compte.";
      draw(true);
    } catch (err) {
      status.textContent = `Restauration impossible : ${err.message}`;
    }
  } } });
  return h("div", {},
    h("table", {}, ...rows, h("tr", {}, h("td", {}, h("b", {}, "Total")), h("td", { className: "num" }, kb(total)), h("td", {}))),
    h("button", { className: "act", on: { click: exportData } }, "Sauvegarder (JSON)"), " ",
    h("button", { className: "act", on: { click: () => picker.click() } }, "Restaurer…"), picker,
    h("p", { className: "muted" }, "À quoi sert la sauvegarde : changer de navigateur ou d'ordinateur, ou réinstaller l'extension, sans " +
      "perdre ce que le site ne garde pas : tes familles, ton récap des paquets, ta courbe de valeur et tes réglages. Les prix et la " +
      "collection se relisent d'eux-mêmes."),
    status);
}

// Firefox demande le consentement de l'utilisateur avant tout envoi de données (data_collection_permissions du
// manifeste : rien par défaut, « contenu du site » en option, pour les prix partagés et les images Wikipédia). La
// demande part pendant le clic, comme l'exige le navigateur.
const isFirefox = typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getBrowserInfo === "function";
function requestAccess(origins) {
  if (!isFirefox && !origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ ...(origins.length ? { origins } : {}), ...(isFirefox ? { data_collection: ["websiteContent"] } : {}) });
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
    const granting = requestAccess([`${origin}/*`]);
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
