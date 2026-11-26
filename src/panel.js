// Le panneau latéral de l'extension (Chrome side_panel, Firefox sidebar_action) : un clic sur l'icône ou Alt+Maj+W
// l'ouvre (src/background.js). Plusieurs onglets : la page ouverte, la collection, les filtres, les souhaits, les
// les enchères, les paquets, les réglages. Il ne lit rien lui-même : il demande tout au content script d'un onglet du site (src/content.js), qui garde
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

// Fonctionnalités expérimentales (src/lib.js, LABS) : débloquées par un code, puis cochées. Lu dans le stockage, pas
// par l'onglet du site, pour que les onglets qui n'interrogent pas son état sachent quoi montrer.
const LABS_KEY = "wmLabs";
async function readLabs() {
  const { [LABS_KEY]: labs } = await chrome.storage.local.get(LABS_KEY);
  return { unlocked: [], on: [], ...(labs || {}) };
}
const labActive = async (id) => WME.labOn(await readLabs(), id);

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
  if (!WME_NEWS.length) return h("p", { className: "muted" }, "Rien de nouveau pour l'instant.");
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
  auctions: { label: "Enchères", every: 0, view: auctionsView }, // se rafraîchit lui-même, sans effacer un formulaire de vente
  packs: { label: "Paquets", every: 0, view: packsView }, // partie en direct relue toute seule, réglages construits une fois
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

// ------------------------------------------------------------------ Page : selon la page ouverte du site. Partout : les
// paquets restants. Puis ce qui sert là où tu es : dernier paquet (défausse), collection, marché, profil d'un ami ou
// offre d'échange, fiche d'une carte, succès. En bas, les prix de la page.
async function pageView() {
  const [state, page] = await Promise.all([ask("state"), ask("panel", { action: "page" })]);
  if (!state || state.ok === false) return error(state || {});
  const p = page && page.ok ? page : { kind: "other" };
  return [
    packsLine(p.packs),
    draftView(state.draft),
    p.sheet ? sheetBox(p.sheet) : null,
    p.kind === "pulls" ? pullsBox(p.pack, state) : null,
    p.kind === "collection" && p.collection ? collectionBox(p.collection) : null,
    p.kind === "market" && p.market ? marketBox(p.market) : null,
    p.friend ? friendBox(p.friend, p.kind === "profile" ? p.showcase : null, Boolean(state.draft)) : null,
    p.kind === "achievements" ? achievementsBox(p.achievements) : null,
    h("h3", {}, "Prix sur la page"),
    h("p", { className: "big" }, `≈ ${wb(state.value)} WB`),
    h("p", { className: "muted" }, `Valeur des ${state.tiles} carte(s) avec un badge sur la page`),
    ...state.trades.map((t) => h("p", { className: "trade" }, t)),
    h("p", {}, `${fr(state.known)} à jour · ${fr(state.old)} de plus de 24 h (grisés) · ${fr(state.waiting)} en attente`),
    h("p", { className: "muted" }, `Lectures sur 10 min : ${state.reads.history}/${state.readBudget} historiques · ` +
      `${state.reads.sales}/${state.readBudget} ventes`),
    state.slowUntil > Date.now() && h("p", { className: "muted" }, `Rythme divisé par deux jusqu'au ${dateTime(state.slowUntil)} (refus récent du site).`),
    ...state.pauses.map((x) => h("p", { className: "warn" }, `Pause : ${x.reason}, jusqu'à ${time(x.until)}.`)),
    sharedLive(state.shared),
    limitsLog(state.limits),
    h("p", { className: "muted" }, "Prix = le « Prix moyen de la semaine » de la fiche de la carte, dans sa rareté ; « ≈ » quand il " +
      "repose sur trop peu de ventes ; « ⚠ » quand une vente isolée hors de proportion fausse celui du site (prix habituel affiché). Au survol d'un badge : ventes, âge du relevé, qui l'a fait."),
  ];
}

// Paquets restants, d'après le profil que le site relit toutes les ~15 s.
function packsLine(packs) {
  if (!packs) return h("p", { className: "muted" }, "Paquets : en attente du site (il relit ton profil toutes les 15 s environ).");
  const left = packs.nextAt ? Math.round((packs.nextAt - Date.now()) / 1000) : null;
  const next = packs.full ? "plein" : left === null ? "" : left <= 0 ? "prochain : bientôt" : `prochain dans ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return h("div", { className: "box" }, h("b", {}, `Paquets : ${packs.remaining} / ${packs.max}`), next ? h("span", { className: "muted" }, ` · ${next}`) : null);
}

// Ouvre une page du site dans son onglet.
async function goTo(path) {
  const tab = await siteTab();
  if (tab && tab.url) chrome.tabs.update(tab.id, { url: new URL(path, tab.url).href });
}

// Un ami et ses raretés échangeables (Souhaits, fiche d'une carte).
function ownersList(list) {
  if (!list) return h("span", { className: "muted" }, "…");
  if (!list.length) return h("span", { className: "muted" }, "personne");
  return list.slice(0, 6).map((o) => h("div", { className: o.status === "locked" ? "muted" : "",
    title: o.status === "locked" ? "Seulement en favori : le site ne le laisse pas échanger" : o.status === "unknown" ? "Le site ne dit pas si c'est un favori" : "Échangeable" },
  o.status === "locked" ? "🔒 " : "", o.username, " ", ...o.rarities.map((r) => [rar(r), " "]), o.status === "unknown" ? "?" : ""));
}

function sheetBox(sh) {
  return h("div", { className: "box" },
    h("h3", {}, `Fiche : ${sh.title}`, sh.owned === true ? h("span", { className: "muted" }, " · tu l'as") : null, sh.wished ? h("span", { className: "muted" }, " · dans tes souhaits") : null),
    sh.error ? h("p", { className: "warn" }, sh.error) : null,
    h("h4", {}, "Chez mes amis"),
    sh.loading && !sh.friends ? h("p", { className: "muted" }, "recherche…") : !sh.friendsGiven ? h("p", { className: "muted" }, "Le site ne l'a pas dit.")
      : h("div", {}, ownersList(sh.friends || [])),
    h("h4", {}, "Prochaines enchères"),
    sh.loading && !sh.auctions ? h("p", { className: "muted" }, "recherche…") : !sh.auctions || !sh.auctions.length ? h("p", { className: "muted" }, "Aucune en cours.")
      : h("table", {}, h("tr", {}, h("th", {}, "Rareté"), h("th", { className: "num" }, "Mise min."), h("th", { className: "num" }, "Cote"), h("th", { className: "num" }, "Écart"), h("th", { className: "num" }, "Fin")),
        ...sh.auctions.map((a) => h("tr", {}, h("td", {}, rar(a.rarity, a.shiny)), h("td", { className: "num" }, wb(a.bid)), h("td", { className: "num" }, quoteText(a)),
          gapCell(a.bid, a, false), h("td", { className: "num" }, leftText(a.endAt))))));
}

// /pulls : le dernier paquet, avec la défausse carte par carte ou des doublons d'un coup.
function pullsBox(pack, state) {
  const rules = state.autoDiscard || {};
  const purge = WME.labOn(state.labs, "discardPanel");
  const limit = rules.maxPrice !== null && rules.maxPrice !== undefined ? ", jusqu’à " + fr(rules.maxPrice) + " WB" : "";
  const auto = WME.labOn(state.labs, "discardOnOpen")
    ? "Défausse auto : " + ((rules.rarities || []).join(", ") || "aucune rareté") + limit + (rules.duplicatesOnly ? ", doublons seulement." : ".") : "";
  const discard = async (cards) => {
    const what = cards.length === 1 ? `« ${cards[0].title} » (${cards[0].rarity})` : `${cards.length} cartes : ${cards.map((c) => c.title).join(", ")}`;
    if (!await dialog({ title: "Défausser", lines: [`${what}, contre 1 WB chacune.`, "Une carte défaussée disparaît de ta collection : c'est définitif."], ok: "Défausser" })) return;
    const reply = await ask("panel", { action: "discard", copies: cards.map((c) => c.copy) });
    if (!reply.ok) await dialog({ title: "Défausse interrompue", lines: [reply.error], ok: "OK", cancel: "Fermer" });
    draw(false);
  };
  const out = [h("h3", {}, pack ? `Dernier paquet · ${time(pack.at)}` : "Dernier paquet")];
  if (!pack) out.push(h("p", { className: "muted" }, `Ouvre un paquet : ses cartes s'affichent ici${purge ? ", avec un bouton pour les défausser" : ""}.`));
  else {
    const seenIds = new Set();
    const isDouble = (c) => { const again = seenIds.has(c.title + c.rarity); seenIds.add(c.title + c.rarity); return c.wasOwned === true || again; };
    const rows = pack.cards.map((c) => ({ ...c, double: isDouble(c) }));
    const doubles = rows.filter((c) => c.double && !c.shiny && !c.discarded);
    out.push(h("table", {}, ...rows.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, rar(c.rarity, c.shiny)),
      h("td", { className: c.double ? "muted" : "new" }, c.wasOwned === undefined && !c.double ? "" : c.double ? "Doublon" : "Nouvelle"),
      h("td", { className: "num" }, c.price === null ? "—" : wb(c.price)),
      h("td", {}, c.discarded ? h("span", { className: "muted" }, "défaussée") : c.shiny || !purge ? "" : h("button", { className: "act small", on: { click: () => discard([c]) } }, "Défausser"))))),
    purge && doubles.length > 1 ? h("button", { className: "act", on: { click: () => discard(doubles) } }, `Défausser les ${doubles.length} doublons de ce paquet`) : null);
  }
  out.push(auto && h("p", { className: "muted" }, auto), state.discardError ? h("p", { className: "warn" }, `Défausse auto arrêtée : ${state.discardError}`) : null,
    state.discards && state.discards.length ? h("p", { className: "muted" }, "Dernières défausses : " +
      state.discards.slice(0, 5).map((d) => `${d.title} ${d.rarity}${d.auto ? " (auto)" : ""}`).join(" · ")) : null);
  return h("div", { className: "box" }, ...out);
}

function collectionBox(c) {
  const row = (x, extra) => h("tr", {}, h("td", {}, x.title), h("td", {}, rar(x.rarity, x.shiny)), extra, h("td", { className: "num" }, x.price === null ? "?" : wb(x.price)));
  return h("div", { className: "box" },
    h("h3", {}, "Sur cette page"),
    c.top.length ? [h("h4", {}, "Les plus chères"), h("table", {}, ...c.top.map((x) => row(x, null)))] : null,
    h("h4", {}, `Doublons visibles (${c.doubles.length})`),
    !c.known ? h("p", { className: "muted" }, "Lis ta collection (onglet Collection) pour les repérer.")
      : c.doubles.length ? h("table", {}, ...c.doubles.map((x) => row(x, h("td", { className: "num" }, `×${fr(x.copies)}`)))) : h("p", { className: "muted" }, "Aucun."),
    c.unpriced.length ? h("p", {}, `${c.unpriced.length} carte(s) sans prix sur la page `, h("button", { className: "act small", on: { click: async (e) => {
      e.target.disabled = true;
      await ask("panel", { action: "loadCardPrices", ids: c.unpriced });
      e.target.textContent = "en file";
    } } }, "Lire leurs prix")) : null);
}

function marketBox(m) {
  const mine = m.mine || {};
  const lead = (mine.bidding || []).filter((a) => a.leading).length;
  return h("div", { className: "box" },
    h("h3", {}, "Marché"),
    h("h4", {}, "Mes enchères"),
    mine.error ? h("p", { className: "warn" }, mine.error)
      : [h("p", { className: "muted" }, `${(mine.bidding || []).length} mise(s), en tête sur ${lead} · ${mine.selling || 0} vente(s)${mine.max ? ` / ${mine.max}` : ""} (détail : onglet Enchères)`),
        (mine.bidding || []).length ? h("table", {}, ...mine.bidding.slice(0, 8).map((a) => h("tr", {}, h("td", {}, a.title, " ", rar(a.rarity, a.shiny)),
          h("td", { className: "num" }, wb(a.price)), h("td", {}, a.leading ? h("span", { className: "tag-lead" }, "en tête") : h("span", { className: "tag-out" }, "dépassé")),
          h("td", { className: "num" }, leftText(a.endAt))))) : null],
    h("h4", {}, `Tes souhaits sur cette page (${m.wishes.length})`),
    !m.wishesKnown ? h("p", { className: "muted" }, "Ouvre l'onglet Souhaits une fois pour les repérer.")
      : m.wishes.length ? h("table", {}, h("tr", {}, h("th", {}, "Carte"), h("th", { className: "num" }, "Mise min."), h("th", { className: "num" }, "Cote"), h("th", { className: "num" }, "Fin")),
        ...m.wishes.map((a) => h("tr", {}, h("td", {}, a.title, " ", rar(a.rarity, a.shiny)), h("td", { className: "num" }, wb(a.bid)), h("td", { className: "num" }, quoteText(a)),
          h("td", { className: "num" }, leftText(a.endAt))))) : h("p", { className: "muted" }, "Aucun."),
    h("h4", {}, `Bonnes affaires sur cette page (${m.deals.length})`),
    m.deals.length ? h("table", {}, ...m.deals.map((d) => h("tr", {}, h("td", {}, d.title, " ", rar(d.rarity)), h("td", { className: "num" }, wb(d.bid)),
      h("td", { className: "num" }, wb(d.price)), h("td", { className: `num ${d.kind === "deal" ? "good" : "error"}` }, `${d.pct > 0 ? "+" : "−"}${Math.abs(d.pct)} %`),
      h("td", { className: "num" }, leftText(d.endAt))))) : h("p", { className: "muted" }, "Aucune (tri « Fin proche » du site pour en trouver)."));
}

// Profil d'un ami, ou offre d'échange en cours avec lui.
function friendBox(f, showcase, trading) {
  const readButton = h("button", { className: "act small", on: { click: async (e) => {
    e.target.disabled = true;
    e.target.textContent = "lecture…";
    const reply = await ask("panel", { action: "friendRead", pseudo: f.pseudo, rarities: ["L", "UR", "SR"] });
    e.target.textContent = reply.ok ? "lue" : reply.error;
    draw(false);
  } } }, "Lire sa collection (L, UR, SR)");
  return h("div", { className: "box" },
    h("h3", {}, trading ? `Échange avec ${f.pseudo}` : `Profil de ${f.pseudo}`),
    showcase && showcase.tiles ? h("p", { className: "muted" }, `Vitrine : ≈ ${wb(showcase.value)} WB (${showcase.tiles} carte(s))`) : null,
    !f.isFriend ? h("p", { className: "muted" }, "Pas dans tes amis : le site ne dit pas quelles cartes il ou elle a.") : [
      h("h4", {}, `Tes souhaits qu'il ou elle peut t'échanger${f.wishes ? ` (${f.wishes.length})` : ""}`),
      !f.wishes ? h("p", { className: "muted" }, "recherche…") : f.wishes.length
        ? h("table", {}, ...f.wishes.slice(0, 15).map((w) => h("tr", {}, h("td", {}, w.title), h("td", {}, ...w.rarities.map((r) => [rar(r), " "]), w.status === "unknown" ? h("span", { className: "muted", title: "Le site ne dit pas si c'est un favori" }, "?") : ""),
          h("td", { className: "num" }, w.price === null ? "?" : wb(w.price)))))
        : h("p", { className: "muted" }, "Aucun."),
      h("h4", {}, `Tes doublons qui lui manquent${f.doubles ? ` (${f.doubles.length})` : ""}`),
      !f.doubles ? h("p", { className: "muted" }, "Il faut lire sa collection : ", readButton)
        : [f.doubles.length ? h("table", {}, ...f.doubles.slice(0, 15).map((d) => h("tr", {}, h("td", {}, d.title), h("td", {}, rar(d.rarity)),
          h("td", { className: "num" }, `×${fr(d.copies)}`), h("td", { className: "num" }, d.price === null ? "?" : wb(d.price))))) : h("p", { className: "muted" }, "Aucun."),
        h("p", { className: "muted" }, `D'après sa collection lue il y a ${WME.ago(Date.now() - f.read.at)} (${f.read.rarities.join(", ")}) : une carte qu'il a dans une autre rareté n'est pas vue.`)],
    ]);
}

// Succès : les plus proches d'être atteints, avec la page du site où avancer.
const ACHIEVEMENT_PAGES = [[/paquet|pack|tirage|ouvr/i, "/pulls", "Ouvrir des paquets"], [/échang/i, "/trades", "Échanges"],
  [/enchère|vend|vente|achat|achet|marché/i, "/marketplace", "Marché"], [/\bamis?\b|amitié/i, "/friends", "Amis"], [/guilde/i, "/guild", "Guilde"],
  [/collection|carte|légendaire|shiny|rareté|défauss/i, "/collection", "Collection"]];
function achievementsBox(a) {
  if (!a) return h("div", { className: "box" }, h("h3", {}, "Succès"), h("p", { className: "muted" }, "Recharge la page des succès : sa progression s'affiche ici."));
  const open = a.items.filter((x) => x.current < x.target);
  return h("div", { className: "box" }, h("h3", {}, `Succès en cours (${open.length})`),
    ...open.slice(0, 10).map((x) => {
      const where = ACHIEVEMENT_PAGES.find(([re]) => re.test(`${x.title} ${x.description}`));
      return h("div", { className: "ach" },
        h("p", {}, h("b", {}, x.title), h("span", { className: "muted" }, ` · ${fr(x.current)} / ${fr(x.target)}`),
          where ? h("button", { className: "act small", on: { click: () => goTo(where[1]) } }, where[2]) : null),
        h("div", { className: "bar" }, h("span", { style: `width: ${Math.min(100, pct(x.current, x.target)).toFixed(1)}%` })),
        x.description ? h("p", { className: "muted" }, x.description) : null);
    }));
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
  const even = Math.abs(d.gap) < 1 ? null : d.gap > 0 ? `Pour équilibrer : ajoute ≈ ${wb(d.gap)} WB de ton côté.` : `Pour équilibrer : demande ≈ ${wb(-d.gap)} WB à ${d.friend}.`;
  return h("div", { className: "box" },
    h("h3", {}, `Offre à ${d.friend}`),
    ...side("Tu donnes", d.give, "Mes cartes"),
    ...side("Tu reçois", d.get, `Cartes de ${d.friend}`),
    h("p", { className: d.gap >= 0 ? "good" : "error" }, h("b", {}, verdict)),
    even ? h("p", {}, even) : null,
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
    (await labActive("discardPanel")) ? await bulkDiscardBox() : null,
  ];
}

// Défausse en masse (comme DISCARD_MAX_VALUE du bot) : raretés, cote au plus N WB, puis « Voir les cartes » et
// « Défausser ». Règles gardées d'une ouverture à l'autre ; la défausse continue panneau fermé (src/content.js).
// Construit une fois : l'onglet se redessine toutes les 10 s sans effacer l'aperçu ni la saisie.
let bulkBox = null;
async function bulkDiscardBox() {
  if (bulkBox) {
    bulkBox.follow();
    return bulkBox;
  }
  const { wmBulkDiscard } = await chrome.storage.local.get(["wmBulkDiscard"]);
  const r = { rarities: ["C", "PC"], maxPrice: null, keepOne: true, neverSold: false, tags: [], ...(wmBulkDiscard || {}) };
  const save = () => chrome.storage.local.set({ wmBulkDiscard: r });
  const result = h("div", {});
  const status = h("p", { className: "muted" });
  const max = h("input", { type: "number", min: 0, step: 1, value: r.maxPrice ?? "", placeholder: "ex. 2", className: "small wide-small",
    on: { change: () => { r.maxPrice = max.value === "" ? null : Math.max(0, Math.round(Number(max.value))); save(); result.replaceChildren(); } } });
  const check = (key, label) => h("label", {}, h("input", { type: "checkbox", checked: Boolean(r[key]),
    on: { change: (e) => { r[key] = e.target.checked; save(); result.replaceChildren(); } } }), label);
  let following = false;
  // Étiquettes qui n'empêchent pas la défausse : aucune par défaut, une liste, ou toutes (« all »).
  const tagBox = h("div", {});
  let tagNames = [];
  const drawTags = () => {
    const all = r.tags === "all";
    const chosen = all ? [] : r.tags.map((id) => [id, (tagNames.find(([t]) => t === id) || [id, id])[1]]);
    const pick = h("select", { on: { change: () => {
      if (pick.value === "-all") r.tags = "all";
      else if (pick.value) r.tags = [...(all ? [] : r.tags), pick.value];
      save();
      result.replaceChildren();
      drawTags();
    } } },
    h("option", { value: "" }, all ? "Toutes les étiquettes" : chosen.length ? "Ajouter une étiquette…" : "Aucune (cartes étiquetées gardées)"),
    ...(all ? [] : tagNames.filter(([id]) => !r.tags.includes(id)).map(([id, name]) => h("option", { value: id }, name))),
    !all && tagNames.length ? h("option", { value: "-all" }, "Tout sélectionner") : null);
    const remove = (id) => { r.tags = id === "-all" ? [] : r.tags.filter((x) => x !== id); save(); result.replaceChildren(); drawTags(); };
    const chips = all ? [["-all", "Toutes les étiquettes"]] : chosen;
    fill(tagBox, h("label", {}, "Défausser aussi les cartes étiquetées ", pick),
      chips.length ? h("div", {}, ...chips.map(([id, name]) => h("span", { className: "chip" }, name,
        h("button", { title: "Retirer", ariaLabel: `Retirer ${name}`, on: { click: () => remove(id) } }, "×")))) : null,
      chips.length ? h("p", { className: "muted" }, "Une carte part seulement si toutes ses étiquettes sont dans cette liste.") : null);
  };
  ask("panel", { action: "tags", source: "me" }).then((reply) => {
    tagNames = reply.ok ? Object.entries(reply.tags || {}).sort(([, a], [, b]) => a.localeCompare(b, "fr")) : [];
    if (Array.isArray(r.tags)) r.tags = r.tags.filter((id) => tagNames.some(([t]) => t === id));
    drawTags();
  });
  const follow = async () => {
    if (following) return;
    following = true;
    try {
      await followLoop();
    } finally {
      following = false;
    }
  };
  const followLoop = async () => {
    for (;;) {
      const reply = await ask("panel", { action: "bulkStatus" });
      if (!reply.ok || !document.body.contains(status)) return;
      const j = reply.job;
      status.textContent = j.running ? `Défausse en cours : ${fr(j.done)} / ${fr(j.total)}…`
        : j.total ? `${fr(j.done)} carte(s) défaussée(s), +${fr(j.done)} WB${j.error ? ` ; arrêtée : ${j.error}` : "."}` : "";
      if (!j.running) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  const preview = async () => {
    if (r.maxPrice === null) { result.replaceChildren(h("p", { className: "warn" }, "Choisis une cote maximum.")); return; }
    result.replaceChildren(h("p", { className: "muted" }, "Recherche…"));
    const reply = await ask("panel", { action: "bulkPreview", rules: r });
    if (!reply.ok) { result.replaceChildren(h("p", { className: "warn" }, reply.error)); return; }
    const go = h("button", { className: "act", disabled: !reply.count || reply.job.running, on: { click: async () => {
      if (!await dialog({ title: "Défausse en masse",
        lines: [`${fr(reply.count)} carte(s) défaussée(s) contre 1 WB chacune (+${fr(reply.count)} WB).`,
          "Une carte défaussée disparaît de ta collection : c'est définitif."],
        check: "J'ai compris : les cartes défaussées sont perdues.", ok: "Défausser" })) return;
      go.disabled = true;
      const started = await ask("panel", { action: "bulkDiscard", rules: r });
      if (!started.ok) { status.textContent = started.error; return; }
      follow();
    } } }, `Défausser ces ${fr(reply.count)} carte(s)`);
    result.replaceChildren(
      h("p", {}, h("b", {}, `${fr(reply.count)} carte(s) à défausser, +${fr(reply.count)} WB`)),
      h("p", { className: "muted" }, `Gardées : ${fr(reply.protected)} en favori, étiquetée ou en plusieurs exemplaires` +
        (reply.unknown ? ` ; ${fr(reply.unknown)} au prix pas encore connu (bouton « Lire les prix manquants » ou pages de ta collection, puis relance)` : "") + "."),
      reply.sample.length ? h("table", {}, ...reply.sample.map((c) => h("tr", {}, h("td", {}, c.title), h("td", {}, rar(c.rarity, c.shiny)),
        h("td", { className: "num" }, c.price === null ? "jamais vendue" : wb(c.price))))) : null,
      reply.count > reply.sample.length ? h("p", { className: "muted" }, `Les ${reply.sample.length} plus chères affichées.`) : null,
      go);
  };
  bulkBox = h("div", { className: "box" },
    h("h3", {}, "Défausse en masse"),
    h("div", {}, h("span", { className: "muted" }, "Raretés : "), ...RARITY_CODES.map((code) => h("label", { className: "inline" },
      h("input", { type: "checkbox", checked: r.rarities.includes(code), on: { change: (e) => {
        r.rarities = e.target.checked ? [...r.rarities, code] : r.rarities.filter((x) => x !== code);
        save();
        result.replaceChildren();
      } } }), " ", rar(code)))),
    h("label", {}, "Cote au plus ", max, " WB"),
    tagBox,
    check("keepOne", " Garder au moins un exemplaire de chaque carte (le plus rare, la shiny avant la L)"),
    check("neverSold", " Défausser aussi les cartes jamais vendues dans leur rareté"),
    h("button", { className: "act", on: { click: preview } }, "Voir les cartes"),
    result, status,
    h("p", { className: "muted" }, "Jamais un favori. Une shiny compte comme une L, au prix de la carte ordinaire (le site n'a pas de prix shiny) : marquée ✦ dans l'aperçu. Prix : celui du badge, dans la rareté de la carte."));
  bulkBox.follow = follow;
  follow();
  return bulkBox;
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
    const canSell = mine && await labActive("sellPanel");
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
          if (canSell && i.sellCopy) cell.append(h("button", { className: "act small", title: "Mettre un exemplaire en vente", on: { click: () => sellForm(i, row, cell) } }, "Vendre"));
          return row;
        })),
      h("p", { className: "muted" }, "« ? » : prix pas encore lu (onglet Collection pour lire les prix manquants). 🔒 : favori, que le site ne laisse ni vendre ni échanger." +
        (canSell ? " « Vendre » : pour une carte en plusieurs exemplaires, un exemplaire de cette rareté qui n'est ni favori ni shiny." : "") +
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

// ------------------------------------------------------------------ Paquets : récap et automatisation
async function packsView() {
  const state = await ask("state");
  if (!state || state.ok === false) return error(state || {});
  const live = h("div", {});
  const refresh = async (st) => {
    const now = st || await ask("state");
    if (!now || now.ok === false) return;
    fill(live, lastPack(now.pulls && now.pulls.last), todayRates(now.pulls && now.pulls.today),
      pullsRecap(now.pulls) || h("p", { className: "muted" }, "Aucun paquet ouvert noté pour l'instant."), clickStatus(now));
  };
  await refresh(state);
  const timer = setInterval(() => (live.isConnected ? refresh() : clearInterval(timer)), 2e3);
  return [
    live,
    WME.labOn(state.labs, "discardOnOpen") ? discardSettings(state.autoDiscard || {}) : null,
  ];
}

// Défausse automatique à l'ouverture d'un paquet (src/content.js, autoDiscard) : fonctionnalité expérimentale, active
// dès qu'elle est cochée dans Réglages. Ici, ses règles ; chaque changement est enregistré tout de suite.
function discardSettings(rules) {
  const r = { rarities: ["C", "PC"], maxPrice: null, duplicatesOnly: true, ...rules };
  const save = () => ask("autoDiscard", { rules: r });
  const max = h("input", { type: "number", min: 0, step: 1, value: r.maxPrice ?? "", placeholder: "sans limite", className: "small wide-small",
    on: { change: () => { r.maxPrice = max.value === "" ? null : Math.max(0, Math.round(Number(max.value))); save(); } } });
  return h("div", { className: "box" },
    h("h3", {}, "Défausse à l'ouverture des paquets (active)"),
    h("div", {}, h("span", { className: "muted" }, "Raretés : "), ...RARITY_CODES.map((code) => h("label", { className: "inline" },
      h("input", { type: "checkbox", checked: r.rarities.includes(code), on: { change: (e) => {
        r.rarities = e.target.checked ? [...r.rarities, code] : r.rarities.filter((x) => x !== code);
        save();
      } } }), " ", rar(code)))),
    h("label", {}, "Cote au plus ", max, " WB"),
    h("label", {}, h("input", { type: "checkbox", checked: r.duplicatesOnly, on: { change: (e) => { r.duplicatesOnly = e.target.checked; save(); } } }),
      " Seulement les doublons (une carte que j'avais déjà, ou un 2ᵉ exemplaire dans le même paquet)"),
    h("p", { className: "muted" }, "Jamais une shiny. Avec une cote maximum, une carte dont le prix n'est pas encore connu attend sa lecture " +
      "(2 min au plus) puis est gardée. Pour l'arrêter : Réglages, Fonctionnalités expérimentales."));
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
  if (!info || !state.autoClickPack) return null;
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
    ...(auctionSide === "buy" ? await buyStatic() : (await labActive("sellPanel")) ? await sellStatic() : [])];
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
      const row = h("tr", {}, h("td", {}, i.title, " ", rar(i.rarity)), h("td", { className: "num", title: "Exemplaires de la carte, toutes raretés" }, fr(i.variants.reduce((n, v) => n + v.copies, 0))),
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
    ...((await labActive("sharedPrices")) ? await sharedSection() : []),
    h("h3", {}, "Fonctionnalité expérimentale"),
    await labsSection(),
  ];
}

async function sharedSection() {
  return [
    h("h3", {}, "Prix partagés"),
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

// Fonctionnalités expérimentales : un champ sans aide ni suggestion ; un code juste ajoute la fonction à la liste en
// dessous, décochée. La cocher demande d'accepter l'avertissement. « Retirer » l'efface (code à retaper).
async function labsSection() {
  const list = h("div", {});
  const save = (labs) => chrome.storage.local.set({ [LABS_KEY]: labs });
  const drawList = async () => {
    const labs = await readLabs();
    fill(list, ...WME.LABS.filter((lab) => labs.unlocked.includes(lab.id)).map((lab) => {
      const box = h("input", { type: "checkbox", checked: labs.on.includes(lab.id), on: { change: async () => {
        if (box.checked && !await labWarning(lab)) { box.checked = false; return; }
        const now = await readLabs();
        await save({ ...now, on: box.checked ? [...new Set([...now.on, lab.id])] : now.on.filter((x) => x !== lab.id) });
        if (lab.id === "sharedPrices") draw(true); // ses réglages apparaissent ou disparaissent plus haut
      } } });
      const forget = h("button", { className: "act small", title: "Retirer de la liste (il faudra retaper le code)", on: { click: async () => {
        const now = await readLabs();
        await save({ unlocked: now.unlocked.filter((x) => x !== lab.id), on: now.on.filter((x) => x !== lab.id) });
        drawList();
      } } }, "Retirer");
      return h("div", {}, h("label", {}, box, ` ${lab.label} `, forget), h("p", { className: "muted" }, lab.detail));
    }));
  };
  const input = h("input", { type: "text", className: "wide", autocomplete: "off", spellcheck: false, ariaLabel: "Fonctionnalité expérimentale",
    on: { keydown: async (e) => {
      if (e.key !== "Enter") return;
      const code = input.value;
      input.value = "";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(WME.labCode(code)));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const lab = WME.LABS.find((l) => l.hash === hash);
      if (!lab) return;
      const now = await readLabs();
      if (!now.unlocked.includes(lab.id)) await save({ ...now, unlocked: [...now.unlocked, lab.id] });
      drawList();
    } } });
  await drawList();
  return h("div", {}, input, list);
}

// Avant d'activer une fonctionnalité expérimentale : extension non officielle, responsabilité du joueur.
function labWarning(lab) {
  return dialog({
    title: lab.label,
    lines: [
      "WikiMastered est une extension non officielle, faite par un joueur. Elle n'est ni développée ni approuvée par Wiki Masters.",
      lab.detail,
      "Cette fonction agit sur ton compte à ta place. Les règles de Wiki Masters interdisent les bots, scripts et outils qui jouent " +
        "pour toi ; ses conditions d'utilisation prévoient la suspension ou le bannissement d'un compte, jusqu'à sa perte définitive.",
    ],
    strong: "En l'activant, tu l'utilises en connaissance de cause et sous ta seule responsabilité, y compris pour une carte perdue, une " +
      "sanction ou un bannissement ; le développeur de l'extension ne peut pas en être tenu responsable.",
    check: "J'ai lu cet avertissement et j'active cette fonction sous ma seule responsabilité.",
    ok: "Activer", cancel: "Laisser désactivée",
  });
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
  { key: "wmLimitLog", label: "Relevé des refus du site", clear: true, backup: true },
  { key: "settings", label: "Réglages", clear: false, backup: true },
  { key: "shared", label: "Prix partagés : adresse et jeton", clear: false, backup: true },
  { key: "wmLabs", label: "Fonctionnalités expérimentales", clear: false, backup: true },
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
      "perdre ce que le site ne garde pas : ton récap des paquets, ta courbe de valeur et tes réglages. Les prix et la " +
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
