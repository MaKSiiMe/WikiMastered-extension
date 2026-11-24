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
  duplicates: { label: "Doublons", every: 10e3, view: duplicatesView },
  filters: { label: "Filtres", every: 0, view: filtersView },
  wishes: { label: "Souhaits", every: 10e3, view: wishesView },
  families: { label: "Familles", every: 0, view: familiesView },
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
    if (first) main.replaceChildren(h("p", { className: "muted" }, "Lecture…"));
    const nodes = await TABS[tab].view(first);
    if (nodes && token === drawToken) main.replaceChildren(...[nodes].flat().filter(Boolean));
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

// ------------------------------------------------------------------ Filtres (#19) : sur toute la collection, pas
// seulement la page de 50 cartes du site. Formulaire construit une fois ; « Filtrer » relance la recherche.
const RARITY_CODES = ["L", "UR", "SR", "R", "PC", "C"];
let lastCriteria = { sort: "value-desc", price: "all", rarities: [], source: "me", tag: "" };

async function filtersView() {
  const c = lastCriteria;
  const results = h("div", {});
  const check = (key, label) => h("label", { className: "inline" }, h("input", { type: "checkbox", checked: Boolean(c[key]), on: { change: (e) => { c[key] = e.target.checked; } } }), ` ${label}`);
  const chips = RARITY_CODES.map((r) => h("label", { className: "inline" }, h("input", { type: "checkbox", checked: c.rarities.includes(r),
    on: { change: (e) => { c.rarities = e.target.checked ? [...c.rarities, r] : c.rarities.filter((x) => x !== r); } } }), ` ${r}`));
  const text = h("input", { type: "search", value: c.text || "", placeholder: "mots du titre", className: "wide", on: { input: (e) => { c.text = e.target.value; } } });
  const min = h("input", { type: "number", value: c.min ?? "", placeholder: "de", className: "small", on: { input: (e) => { c.min = e.target.value; } } });
  const max = h("input", { type: "number", value: c.max ?? "", placeholder: "à", className: "small", on: { input: (e) => { c.max = e.target.value; } } });
  const price = h("select", { on: { change: (e) => { c.price = e.target.value; range.hidden = c.price !== "range"; } } },
    ...[["all", "Tous les prix"], ["never", "Jamais vendues (dans leur rareté)"], ["range", "Vendues entre…"]].map(([v, l]) => h("option", { value: v, selected: c.price === v }, l)));
  const range = h("span", { hidden: c.price !== "range" }, " ", min, " et ", max, " WB");
  // Source (#51) : ma collection, ou celle d'un autre joueur, lue par la route de son profil (raretés cochées ci-dessus,
  // L, UR, SR sans rien de coché ; une page par seconde).
  const pseudo = h("input", { type: "text", value: c.source !== "me" ? c.source : "", placeholder: "pseudo", className: "small wide-small" });
  const friendStatus = h("span", { className: "muted" });
  const readButton = h("button", { className: "act small", on: { click: async () => {
    const name = pseudo.value.trim();
    if (!name) return;
    readButton.disabled = true;
    friendStatus.textContent = " lecture… (une page par seconde)";
    const reply = await ask("panel", { action: "friendRead", pseudo: name, rarities: c.rarities });
    readButton.disabled = false;
    if (!reply.ok) { friendStatus.textContent = ` ${reply.error}`; return; }
    c.source = reply.pseudo;
    friendStatus.textContent = ` ${fr(reply.copies)} exemplaire(s) lus${reply.truncated ? " (60 pages au plus : choisis moins de raretés)" : ""}.`;
    run();
  } } }, "Lire sa collection");
  const source = h("select", { on: { change: (e) => { c.source = e.target.value === "me" ? "me" : pseudo.value.trim() || "?"; friendBox.hidden = e.target.value === "me"; } } },
    h("option", { value: "me", selected: c.source === "me" }, "Ma collection"), h("option", { value: "friend", selected: c.source !== "me" }, "La collection d'un joueur"));
  const friendBox = h("div", { hidden: c.source === "me" }, pseudo, " ", readButton, friendStatus,
    h("label", { className: "inline" }, h("input", { type: "checkbox", checked: Boolean(c.notMine), on: { change: (e) => { c.notMine = e.target.checked; } } }), " Seulement celles que je n'ai pas"));
  pseudo.addEventListener("input", () => { if (c.source !== "me") c.source = pseudo.value.trim(); });

  // Étiquettes (#63), lues avec ma collection.
  const tag = h("select", { on: { change: (e) => { c.tag = e.target.value; } } }, h("option", { value: "" }, "Toutes les étiquettes"));
  ask("panel", { action: "tags" }).then((reply) => {
    if (!reply.ok) return;
    const names = Object.entries(reply.tags || {}).sort(([, a], [, b]) => a.localeCompare(b));
    tag.append(h("option", { value: "any", selected: c.tag === "any" }, "Avec une étiquette"), h("option", { value: "none", selected: c.tag === "none" }, "Sans étiquette"),
      ...names.map(([id, name]) => h("option", { value: id, selected: c.tag === id }, name)));
    if (reply.tagsError) tag.title = `Étiquettes illisibles : ${reply.tagsError}`;
  });

  const sort = h("select", { on: { change: (e) => { c.sort = e.target.value; } } },
    ...[["value-desc", "Valeur décroissante"], ["value-asc", "Valeur croissante"], ["rarity", "Rareté"]].map(([v, l]) => h("option", { value: v, selected: c.sort === v }, l)));
  const run = async () => {
    results.replaceChildren(h("p", { className: "muted" }, "Recherche…"));
    const reply = await ask("panel", { action: "filter", criteria: c });
    if (!reply.ok) return results.replaceChildren(...error(reply));
    const label = (i) => (i.state === "price" ? `${i.sure ? "" : "≈ "}${wb(i.price)}` : i.state === "never" ? "jamais vendue" : i.shiny ? "✦ ?" : "?");
    results.replaceChildren(
      reply.source && h("p", { className: "muted" }, `Collection de ${reply.source}`),
      h("p", {}, `${fr(reply.count)} carte(s)${reply.count > reply.items.length ? ` (les ${reply.items.length} premières)` : ""}`),
      h("table", {}, h("tr", {}, h("th", {}, "Carte"), h("th", {}, "Rareté"), h("th", { className: "num" }, "Ex."), h("th", { className: "num" }, "Prix")),
        ...reply.items.map((i) => h("tr", {}, h("td", {}, i.title), h("td", {}, i.rarity + (i.shiny ? " ✦" : "")),
          h("td", { className: "num" }, fr(i.copies)), h("td", { className: "num" }, label(i))))),
      h("p", { className: "muted" }, "« ? » : prix pas encore lu (onglet Collection pour lire les prix manquants)."));
  };
  return [
    h("label", {}, "Dans ", source), friendBox,
    h("div", {}, check("duplicates", "Doublons"), check("noImage", "Sans image"), check("gif", "GIF")),
    h("div", {}, ...chips),
    text,
    h("div", {}, price, range),
    h("label", {}, "Étiquette ", tag),
    h("label", {}, "Trier par ", sort),
    h("button", { className: "act", on: { click: run } }, "Filtrer"),
    results,
  ];
}

// ------------------------------------------------------------------ Souhaits (#21) : la liste de souhaits du site,
// chiffrée au prix le plus bas connu de chaque carte (toutes raretés).
let wishRefresh = false;
async function wishesView() {
  const s = await ask("panel", { action: "wishlist", refresh: wishRefresh });
  wishRefresh = false;
  if (!s.ok) return error(s);
  if (!s.items.length) return [h("p", {}, "Ta liste de souhaits est vide.")];
  return [
    h("p", { className: "big" }, `≈ ${fr(s.total)} WB`),
    h("p", { className: "muted" }, `${s.items.length} carte(s) souhaitée(s) · ${s.priced} avec un prix (le plus bas connu, toutes raretés) · ` +
      `${s.never} jamais vendue(s) · ${s.unknown} prix pas encore lu(s)`),
    h("div", {},
      h("button", { className: "act", disabled: !s.unknown, on: { click: async (e) => {
        e.target.disabled = true;
        const reply = await ask("panel", { action: "loadWishPrices" });
        e.target.textContent = reply.ok ? `${reply.count} carte(s) en file` : reply.error;
      } } }, s.unknown ? `Lire les prix manquants (${s.unknown})` : "Tous les prix sont lus"),
      h("button", { className: "act small", on: { click: () => { wishRefresh = true; draw(true); } } }, "Relire la liste")),
    h("table", {}, h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Dès"), h("th", {}, "Autres raretés")),
      ...s.items.map((i) => h("tr", {},
        h("td", {}, i.title + (i.owned ? " ✓" : "")),
        h("td", { className: "num" }, i.cheapest ? `${i.cheapest.rarity} ${wb(i.cheapest.avg)}` : i.state === "never" ? "jamais vendue" : "?"),
        h("td", { className: "muted" }, i.prices.filter(([r]) => !i.cheapest || r !== i.cheapest.rarity).map(([r, avg]) => `${r} ${wb(avg)}`).join(" · "))))),
    h("p", { className: "muted" }, "« ✓ » : tu as déjà la carte (dans une autre rareté, sans doute)."),
  ];
}

// ------------------------------------------------------------------ Familles (#20) : groupes de cartes à compléter,
// gardés dans l'extension (wmFamilies). Cartes ajoutées par une recherche dans le catalogue du site ou depuis une
// étiquette ; progression, cartes manquantes et leur coût ; partage par code.
const FAMILIES_KEY = "wmFamilies";
let openFamily = null;
const loadFamilies = async () => (await chrome.storage.local.get(FAMILIES_KEY))[FAMILIES_KEY] || [];
const saveFamilies = (list) => chrome.storage.local.set({ [FAMILIES_KEY]: list });

async function familiesView() {
  const families = await loadFamilies();
  if (openFamily && families.some((f) => f.id === openFamily)) return familyView(families, families.find((f) => f.id === openFamily));
  const name = h("input", { type: "text", placeholder: "nom de la famille", className: "wide" });
  const code = h("input", { type: "text", placeholder: "code WME-F1.… d'une famille partagée", className: "wide" });
  const status = h("p", { className: "muted" });
  const info = families.length ? await ask("panel", { action: "cardsInfo", ids: [...new Set(families.flatMap((f) => f.cards.map((c) => c.id)))] }) : { ok: true, info: {} };
  return [
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

async function familyView(families, family) {
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

  const search = h("input", { type: "search", placeholder: "chercher dans le catalogue du site", className: "wide" });
  const found = h("div", {});
  const runSearch = async () => {
    found.replaceChildren(h("p", { className: "muted" }, "Recherche…"));
    const r = await ask("panel", { action: "catalogSearch", q: search.value });
    if (!r.ok) return found.replaceChildren(...error(r));
    found.replaceChildren(
      r.cards.length > 1 && h("button", { className: "act small", on: { click: () => addCards(r.cards) } }, `Tout ajouter (${r.cards.length})`),
      h("table", {}, ...r.cards.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, c.rarity),
        h("td", {}, family.cards.some((o) => o.id === c.id) ? "déjà" : h("button", { className: "act small", on: { click: () => addCards([c]) } }, "+"))))));
  };
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  const tag = h("select", {}, h("option", { value: "" }, "Ajouter les cartes d'une étiquette…"));
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
    h("p", { className: "muted" }, p.missing.length ? `Il en manque ${p.missing.length} : ≈ ${fr(p.cost)} WB au prix le plus bas connu` +
      (p.unpriced ? ` (${p.unpriced} sans prix)` : "") : "Famille complète !"),
    unread.length > 0 && h("button", { className: "act small", on: { click: async (e) => { await ask("panel", { action: "loadCardPrices", ids: unread }); e.target.textContent = `${unread.length} prix en file`; } } },
      `Lire les prix manquants (${unread.length})`),
    h("h3", {}, "Ajouter des cartes"),
    search, h("button", { className: "act small", on: { click: runSearch } }, "Chercher"), found, tag,
    h("h3", {}, "Cartes manquantes"),
    p.missing.length ? h("table", {}, ...p.missing.map((c) => h("tr", {}, h("td", {}, c.title),
      h("td", { className: "num" }, c.cheapest ? `${c.cheapest.rarity} ${wb(c.cheapest.avg)}` : "?"),
      h("td", {}, h("button", { className: "act small", title: "Retirer de la famille", on: { click: () => update((f) => ({ ...f, cards: f.cards.filter((o) => o.id !== c.id) })) } }, "×"))))) : null,
    h("h3", {}, `Possédées (${p.owned})`),
    h("p", { className: "muted" }, family.cards.filter((c) => info[c.id] && info[c.id].owned).map((c) => c.title).join(" · ") || "aucune"),
    h("h3", {}, "Famille"),
    h("button", { className: "act small", on: { click: async () => {
      await navigator.clipboard.writeText(WME.familyCode(family)).then(() => { shareStatus.textContent = " code copié"; }, () => { shareStatus.textContent = ` ${WME.familyCode(family)}`; });
    } } }, "Partager (code)"), shareStatus, " ",
    h("button", { className: "act small", on: { click: async () => {
      if (!confirm(`Supprimer la famille « ${family.name} » ?`)) return;
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
    h("h3", {}, "Automatisation par clic"),
    h("p", { className: "muted" }, "Elle ne change jamais de page sous tes yeux : elle attend 5 min sans clic, frappe ni défilement. Les " +
      "règles du site interdisent les scripts qui jouent à ta place : à utiliser en connaissance de cause."),
    toggle(state.autoClickPack, "autoClickPack", "Ouverture auto des paquets (/pulls)"),
    toggle(state.autoUnblockMarket, "autoUnblockMarket", "Tentative de déblocage du marché (/collection) : met une vraie enchère"),
    clickStatus(state),
  ];
}

// Le dernier paquet (#23) : chaque carte, nouvelle ou doublon, son prix, et la valeur du paquet.
function lastPack(last) {
  if (!last) return null;
  const tag = (c) => (c.isNew === true ? "Nouvelle" : c.isNew === false ? "Doublon" : "");
  return h("div", { className: "box" },
    h("h3", {}, `Dernier paquet · ${time(last.at)}${last.auto ? " (auto)" : ""} · ≈ ${wb(last.value)} WB`),
    h("table", {}, ...last.cards.map((c) => h("tr", {},
      h("td", {}, c.title), h("td", {}, c.rarity + (c.shiny ? " ✦" : "")), h("td", { className: c.isNew ? "new" : "muted" }, tag(c)),
      h("td", { className: "num" }, Number.isFinite(c.price) ? wb(c.price) : "—")))),
    (last.fresh || last.doubles) ? h("p", { className: "muted" }, `${last.fresh} nouvelle(s) · ${last.doubles} doublon(s)`) : null);
}

// Taux de tirage du jour (#24), remis à zéro à minuit (heure du navigateur).
function todayRates(today) {
  if (!today || !today.packs) return null;
  const order = (r) => (WME.rank(r) < 0 ? -1 : WME.rank(r));
  return h("div", { className: "box" },
    h("h3", {}, `Aujourd'hui · ${today.packs} paquet(s) · ${today.cards} carte(s)`),
    h("p", { className: "muted" }, Object.entries(today.byRarity).sort(([a], [b]) => order(b) - order(a))
      .map(([r, n]) => `${r} ${n} (${(n / today.cards * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %)`).join(" · ")));
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
    h("label", {}, h("input", { type: "checkbox", checked: Boolean(state.images), on: { change: (e) => {
      if (!e.target.checked) return ask("images", { on: false });
      const box = e.target;
      requestAccess([]).then((granted) => (granted ? ask("images", { on: true }) : (box.checked = false)), () => { box.checked = false; });
    } } }),
      " Images Wikipédia pour les cartes sans image (le titre de ces cartes est envoyé à Wikipédia, sans rien d'autre)"),
    h("label", {}, h("input", { type: "checkbox", checked: state.deals !== false, on: { change: (e) => ask("deals", { on: e.target.checked }) } }),
      " Marché : « −34 % » bonne affaire (fin dans moins de 15 min, 25 % sous la cote), « +50 % » surcoté"),
    h("label", {}, "Prix fiable à partir de ", minSales, " vente(s) dans la semaine (sinon « ≈ »)"),
    h("h3", {}, "Pages du site"),
    h("label", {}, "Ordre de ma collection : ", order),
    h("h3", {}, "Prix partagés"),
    await sharedSettings(),
    h("h3", {}, "Cache des prix"),
    h("button", { className: "act", on: { click: async (e) => { if (confirm("Oublier tous les prix et les relire sur le site ?")) { await ask("reread"); e.target.textContent = "Prix oubliés : relecture en cours"; } } } },
      "Relire tous les prix"),
    h("h3", {}, "Données gardées par l'extension"),
    await dataSection(),
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
      if (!confirm(`Vider « ${d.label} » ?`)) return;
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
      if (!confirm(`Remplacer ${Object.keys(data).length} donnée(s) par celles de la sauvegarde du ${String(parsed.at || "?").slice(0, 10)} ?`)) return;
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
    h("p", { className: "muted" }, "La sauvegarde garde ce qui ne se relit pas sur le site : réglages, récap des paquets, courbe de valeur, " +
      "relevé des refus. Le cache des prix et la collection se relisent d'eux-mêmes."),
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
