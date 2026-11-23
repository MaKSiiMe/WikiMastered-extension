// Content script : tourne sur chaque page de wiki-masters.com, dans un monde isolé (il voit le DOM, pas le JS du site).
//
// 1. Il reçoit de src/inject.js les réponses de l'API du site, et note les cartes affichées.
// 2. Il demande la cote de chacune (historique des prix), une requête à la fois, et la garde 6 h.
// 3. Il pose un badge « ≈ 1 250 » sur chaque carte de la page, retrouvée par son titre.
// 4. Il ajoute un panneau (bouton « WM » en bas à gauche, ou Alt+Maj+W) : onglets « Prix » et « Amis ».
//
// Lecture seule : uniquement des requêtes GET, les mêmes que le site fait quand tu ouvres une carte ou ta liste de
// souhaits. Aucun clic, aucune mise, aucune vente.
(() => {
  if (window.__wmeContent) return;
  window.__wmeContent = true;

  const { RARITIES, rank, norm, quotes, cardsIn, friendsFromCatalog, wb } = WME;

  // ------------------------------------------------------------------ réglages
  const PRICE_TTL_MS = 6 * 3600e3;      // une cote est redemandée après 6 h (comme le bot)
  const FAILED_TTL_MS = 3600e3;         // une cote refusée par le site est réessayée après 1 h
  const PRICE_KEEP_MS = 7 * 24 * 3600e3; // cotes de plus de 7 jours oubliées
  const REQUEST_GAP_MS = 1000;          // au moins 1 s entre deux requêtes de l'extension…
  const REQUEST_JITTER_MS = 700;        // … plus un délai au hasard, pour ne pas taper en rythme régulier
  const RATE_LIMIT_PAUSE_MS = 60e3;     // le site répond 429 (trop de requêtes) : pause d'une minute
  const FRIENDS_TTL_MS = 3600e3;        // liste des amis gardée 1 h
  const CATALOG_PAGE_SIZE = 50;

  // Firefox : `content.fetch` envoie la requête comme la page elle-même (cookies de session compris). Chrome n'a pas
  // `content` : le fetch du content script part déjà depuis la page.
  const siteFetch = typeof content !== "undefined" && content.fetch ? content.fetch.bind(content) : fetch.bind(window);

  // ------------------------------------------------------------------ stockage (chrome.storage.local)
  // Survit aux rechargements et au redémarrage du navigateur ; propre à l'extension, invisible du site.
  const store = {
    get: async (key, fallback) => ((await chrome.storage.local.get(key))[key] ?? fallback),
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  };

  let settings = { badges: true, minRarity: "" };
  let prices = {}; // id de carte -> { at, q: { SR: { avg, count } }, failed? }
  const seen = new Map(); // titre normalisé -> { id, title, rarities: Set }

  // ------------------------------------------------------------------ requêtes au site, une à la fois
  let lastRequest = 0;
  let pausedUntil = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function get(path) {
    const wait = Math.max(pausedUntil, lastRequest + REQUEST_GAP_MS + Math.random() * REQUEST_JITTER_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const response = await siteFetch(location.origin + path, { credentials: "include" });
    if (response.status === 429) {
      pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      throw new Error("trop de requêtes (429), pause d'une minute");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // ------------------------------------------------------------------ cotes
  const queue = new Set();
  let queueRunning = false;

  const fresh = (entry) => entry && Date.now() - entry.at < (entry.failed ? FAILED_TTL_MS : PRICE_TTL_MS);

  function want(cardId) {
    if (!fresh(prices[cardId])) queue.add(cardId);
    if (!queueRunning) runQueue();
  }

  async function runQueue() {
    queueRunning = true;
    try {
      await ready; // les cotes déjà mémorisées d'abord : pas de requête pour une cote encore fraîche
      while (queue.size) {
        const id = queue.values().next().value;
        queue.delete(id);
        if (fresh(prices[id])) continue;
        try {
          const history = await get(`/api/marketplace/cards/${encodeURIComponent(id)}/price-history`);
          prices[id] = { at: Date.now(), q: quotes(history) };
        } catch (error) {
          prices[id] = { at: Date.now(), q: {}, failed: String(error.message || error) };
        }
        savePricesSoon();
        scheduleBadges();
        refreshPricesTab();
      }
    } finally {
      queueRunning = false;
    }
  }

  // Sauvegarde groupée : au plus une écriture par seconde, mais jamais repoussée indéfiniment (une page fermée pendant
  // la lecture des cotes garde celles déjà lues).
  let saveTimer = null;
  function savePricesSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      store.set("prices", prices);
    }, 1000);
  }

  // Réponses de l'API recopiées par src/inject.js.
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "wme-page") return;
    for (const c of cardsIn(event.data.data)) {
      const key = norm(c.title);
      const entry = seen.get(key) || { id: c.id, title: c.title, rarities: new Set() };
      if (c.rarity) entry.rarities.add(c.rarity);
      seen.set(key, entry);
      want(c.id);
    }
    scheduleBadges();
    refreshPricesTab();
  });

  // ------------------------------------------------------------------ badges sur les cartes
  // Le site n'a pas de classe CSS stable pour une carte : on la retrouve par son titre. On parcourt les textes de la
  // page ; un texte égal au titre d'une carte connue est le nom de la carte, et sa « tuile » est le premier parent qui
  // contient une image et a des frères (une grille). Idée reprise de wm-qol (Kitsoune), qui résiste aux mises à jour.
  const OURS = "#wme-root, .wme-badge";

  function inDialog(el) {
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur.getAttribute("role") === "dialog" || cur.getAttribute("aria-modal") === "true") return true;
    }
    return false;
  }

  function tileRarity(tile, entry) {
    // Une feuille de texte « SR », « L »… dans la tuile : la rareté de cet exemplaire.
    for (const el of tile.querySelectorAll("*")) {
      if (el.children.length || el.closest(OURS)) continue;
      const text = el.textContent.trim().toUpperCase();
      if (rank(text) >= 0 && (!entry.rarities.size || entry.rarities.has(text))) return text;
    }
    return entry.rarities.size === 1 ? [...entry.rarities][0] : "";
  }

  function findTiles() {
    const tiles = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || el.closest(OURS)) continue;
      const entry = seen.get(norm(node.nodeValue));
      if (!entry || inDialog(el)) continue;
      let cur = el;
      for (let i = 0; i < 8 && cur && cur.parentElement; i++, cur = cur.parentElement) {
        if (cur.parentElement.children.length >= 3 && cur.querySelector("img")) {
          if (!tiles.has(cur)) tiles.set(cur, entry);
          break;
        }
      }
    }
    // Une tuile qui en contient une autre n'est pas une carte mais la grille : on garde les plus petites.
    return [...tiles].filter(([t]) => ![...tiles.keys()].some((o) => o !== t && t.contains(o)));
  }

  function badge(tile, entry) {
    const rarity = tileRarity(tile, entry);
    const entryPrices = prices[entry.id];
    let text = "…";
    let tip = "Cote en cours de lecture";
    let state = "wait";
    if (entryPrices && fresh(entryPrices)) {
      const q = entryPrices.q[rarity];
      if (entryPrices.failed) {
        [text, tip, state] = ["?", `Cote illisible : ${entryPrices.failed}`, "none"];
      } else if (q) {
        const age = Math.round((Date.now() - entryPrices.at) / 60e3);
        [text, state] = [`≈ ${wb(q.avg)}`, "ok"];
        tip = `${entry.title} ${rarity} : moyenne de ${q.count} vente(s) récente(s), relevée il y a ${age} min.\n` +
          "Shiny : la cote du site ne les distingue pas.";
      } else {
        const others = Object.entries(entryPrices.q).sort(([a], [b]) => rank(b) - rank(a))
          .map(([r, v]) => `${r} ≈ ${wb(v.avg)}`).join(", ");
        [text, state] = [rarity ? "—" : "?", "none"];
        tip = rarity ? `Aucune vente récente en ${rarity}.` : "Rareté de cette carte non reconnue.";
        if (others) tip += ` Autres raretés : ${others}.`;
      }
    }
    let el = tile.querySelector(":scope > .wme-badge");
    if (!el) {
      el = document.createElement("span");
      el.className = "wme-badge";
      if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
      tile.append(el);
    }
    if (el.textContent !== text) el.textContent = text;
    el.title = tip;
    el.dataset.state = state;
    return state === "ok" ? prices[entry.id].q[rarity].avg : 0;
  }

  let badgeTimer = null;
  let shownValue = 0;
  let shownTiles = 0;
  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(drawBadges, 300);
  }

  function drawBadges() {
    if (!settings.badges) {
      document.querySelectorAll(".wme-badge").forEach((b) => b.remove());
      return;
    }
    const tiles = findTiles();
    shownTiles = tiles.length;
    shownValue = tiles.reduce((sum, [tile, entry]) => sum + badge(tile, entry), 0);
    refreshPricesTab();
  }

  // Le site est une application « une seule page » : il remplace des morceaux du DOM sans recharger. On redessine
  // les badges quand la page change (en ignorant nos propres changements).
  const isOurs = (node) => {
    const el = node instanceof Element ? node : node.parentElement;
    return Boolean(el && el.closest(OURS));
  };
  const ourChange = (m) => isOurs(m.target) ||
    (m.addedNodes.length + m.removedNodes.length > 0 &&
      [...m.addedNodes, ...m.removedNodes].every((n) => n instanceof Element && n.matches(OURS)));
  new MutationObserver((mutations) => {
    if (!mutations.every(ourChange)) scheduleBadges();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ------------------------------------------------------------------ liste de souhaits chez les amis
  let friends = null; // { at, pages } : réponses de /api/cards?wishlist=1, recalculées avec le filtre de rareté
  let friendsStatus = "";

  async function loadFriends() {
    friendsStatus = "Lecture de ta liste de souhaits…";
    renderPanel();
    const pages = [];
    try {
      for (let page = 0; page < 200; page++) {
        const data = await get(`/api/cards?page=${page}&sort=rarity&wishlist=1`);
        if (!Array.isArray(data.cards)) throw new Error("réponse inattendue du site");
        // On ne garde que l'utile : le titre et les amis. Le reste (images, résumés) prendrait de la place.
        pages.push({
          cards: data.cards.map((c) => ({ id: c.id, wikipedia_title: c.wikipedia_title })),
          friendOwners: data.friendOwners || {},
        });
        friendsStatus = `Lecture de ta liste de souhaits… page ${page + 1}`;
        renderPanel();
        if (data.cards.length < CATALOG_PAGE_SIZE) break;
      }
      friends = { at: Date.now(), pages };
      friendsStatus = "";
      store.set("friends", friends);
    } catch (error) {
      friendsStatus = `Lecture refusée : ${error.message || error}`;
    }
    renderPanel();
  }

  // ------------------------------------------------------------------ panneau
  // Petit utilitaire pour créer des éléments sans innerHTML : le texte du site (titres, pseudos) est toujours posé en
  // texte, jamais interprété comme du HTML.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "on") for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value);
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  let root = null;
  let open = false;
  let tab = "prix";

  function buildPanel() {
    root = h("div", { id: "wme-root" });
    document.body.append(root);
    renderPanel();
  }

  function toggle(force) {
    open = force ?? !open;
    if (open && tab === "amis" && !friends && !friendsStatus) loadFriends();
    renderPanel();
  }

  function renderPanel() {
    if (!root) return;
    const fab = h("button", { className: "wme-fab", title: "WikiMastered (Alt+Maj+W)", on: { click: () => toggle() } }, "WM");
    if (!open) {
      root.replaceChildren(fab);
      return;
    }
    const tabButton = (id, label) => h("button", {
      className: tab === id ? "on" : "",
      on: { click: () => { tab = id; toggle(true); } },
    }, label);
    const panel = h("section", { className: "wme-panel" },
      h("header", {},
        h("b", {}, "WikiMastered"),
        h("nav", {}, tabButton("prix", "Prix"), tabButton("amis", "Amis")),
        h("button", { className: "wme-x", title: "Fermer", on: { click: () => toggle(false) } }, "✕")),
      tab === "prix" ? pricesTab() : friendsTab());
    root.replaceChildren(panel, fab);
  }

  // Redessine le panneau seulement s'il montre l'onglet « Prix » : ailleurs, on ne referme pas ce que tu as ouvert.
  function refreshPricesTab() {
    if (open && tab === "prix") renderPanel();
  }

  function pricesTab() {
    const known = Object.values(prices).filter((p) => fresh(p) && !p.failed).length;
    return h("div", { className: "wme-body" },
      h("p", {}, `Cartes repérées sur cette page : ${seen.size}`),
      h("p", {}, `Cartes avec un badge : ${shownTiles}`),
      h("p", {}, `Valeur des cartes affichées : ≈ ${wb(shownValue)} WB`),
      h("p", { className: "wme-muted" }, `${known} cote(s) en mémoire · ${queue.size} en attente` +
        (pausedUntil > Date.now() ? " · pause : le site limite les requêtes" : "")),
      h("label", {},
        h("input", {
          type: "checkbox", checked: settings.badges,
          on: { change: (e) => { settings.badges = e.target.checked; store.set("settings", settings); drawBadges(); } },
        }),
        " Badges de cote sur les cartes"),
      h("button", {
        className: "wme-btn",
        on: { click: () => { prices = {}; store.set("prices", prices); seen.forEach((e) => want(e.id)); drawBadges(); } },
      }, "Relire toutes les cotes"),
      h("p", { className: "wme-muted" },
        "Cote = moyenne des ventes récentes dans la rareté de la carte (historique des prix du site), " +
        "comme le bot. Lecture seule : l'extension ne mise et ne vend jamais."));
  }

  function friendsTab() {
    const body = h("div", { className: "wme-body" });
    const select = h("select", {
      on: { change: (e) => { settings.minRarity = e.target.value; store.set("settings", settings); renderPanel(); } },
    }, h("option", { value: "" }, "toutes"), ...RARITIES.map((r) => h("option", { value: r }, `${r} et plus`)));
    select.value = settings.minRarity;
    body.append(h("div", { className: "wme-row" },
      h("label", {}, "Rareté : ", select),
      h("button", { className: "wme-btn", on: { click: loadFriends } }, "Actualiser")));
    if (friendsStatus) body.append(h("p", { className: "wme-muted" }, friendsStatus));
    if (!friends) return body;

    const list = friendsFromCatalog(friends.pages, settings.minRarity);
    const wishlist = new Set(friends.pages.flatMap((p) => p.cards.map((c) => c.id))).size;
    const found = new Set(list.flatMap((f) => f.cards.map((c) => c.id))).size;
    const age = Math.round((Date.now() - friends.at) / 60e3);
    body.append(h("p", {}, `${found} carte(s) de ta liste (${wishlist}) chez ${list.length} ami(s)`),
      h("p", { className: "wme-muted" }, `Lue il y a ${age} min. Propose l'échange depuis le profil de l'ami.`));
    for (const friend of list) {
      body.append(h("details", {},
        h("summary", {},
          h("a", { href: `/profile/${encodeURIComponent(friend.name)}`, on: { click: (e) => e.stopPropagation() } }, friend.name),
          ` · ${friend.cards.length}`),
        h("ul", {}, friend.cards.map((c) => h("li", {},
          c.title, " ", ...c.rarities.map((r) => h("span", { className: "wme-rar", "data-r": r }, r)))))));
    }
    return body;
  }

  // ------------------------------------------------------------------ démarrage
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyW") toggle();
  });

  const ready = (async () => {
    settings = { ...settings, ...(await store.get("settings", {})) };
    prices = await store.get("prices", {});
    for (const [id, entry] of Object.entries(prices)) {
      if (!entry || Date.now() - entry.at > PRICE_KEEP_MS) delete prices[id];
    }
    const savedFriends = await store.get("friends", null);
    if (savedFriends && Date.now() - savedFriends.at < FRIENDS_TTL_MS) friends = savedFriends;
    buildPanel();
    scheduleBadges();
  })();

  // Prêt à écouter : src/inject.js renvoie les réponses du site arrivées avant le démarrage de ce script.
  window.postMessage({ source: "wme-content", type: "ready" }, location.origin);
})();
