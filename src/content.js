// Content script : tourne sur chaque page de wiki-masters.com, dans un monde isolé (il voit le DOM, pas le JS du site).
//
// 1. Il reçoit de src/inject.js les réponses de l'API du site, et note les cartes affichées.
// 2. Il demande le prix moyen de chacune (historique des prix, une requête par carte : le site n'en a pas d'autre),
//    une requête à la fois, et le garde 6 h.
// 3. Il pose un badge « ≈ 1 250 » sur chaque carte de la page, retrouvée par son titre, et le bilan d'un échange
//    affiché (ce que chaque côté donne).
// 4. Il répond à la fenêtre de l'extension (src/popup.js, clic sur l'icône ou Alt+Maj+W) : compteurs et réglages.
//
// Lecture seule : uniquement des requêtes GET, les mêmes que le site fait quand tu ouvres la fiche d'une carte.
// Aucun clic, aucune mise, aucune vente.
(() => {
  if (window.__wmeContent) return;
  window.__wmeContent = true;

  const { rank, norm, quotes, currentWeek, cardsIn, tradesIn, tradeBalance, wb } = WME;

  // ------------------------------------------------------------------ réglages
  const PRICES_KEY = "prices-v2";       // prix moyens du site (la 0.1 gardait un autre calcul sous « prices »)
  const PRICE_TTL_MS = 6 * 3600e3;      // une cote est redemandée après 6 h (comme le bot)
  const FAILED_TTL_MS = 10 * 60e3;      // une cote illisible est réessayée après 10 min
  const RETRIES = 3;                    // erreur passagère du site (403, 5xx, réseau) : 3 essais avant « ? »
  const RETRY_PAUSE_MS = 15e3;          // … espacés de 15 s
  const PRICE_KEEP_MS = 7 * 24 * 3600e3; // cotes de plus de 7 jours oubliées
  const REQUEST_GAP_MS = 500;           // au moins 0,5 s entre deux requêtes de l'extension (~30 s pour 50 cartes)…
  const REQUEST_JITTER_MS = 300;        // … plus un délai au hasard, pour ne pas taper en rythme régulier
  const RATE_LIMIT_PAUSE_MS = 60e3;     // le site répond 429 (trop de requêtes) : pause d'une minute

  // Firefox : `content.fetch` envoie la requête comme la page elle-même (cookies de session compris). Chrome n'a pas
  // `content` : le fetch du content script part déjà depuis la page.
  const siteFetch = typeof content !== "undefined" && content.fetch ? content.fetch.bind(content) : fetch.bind(window);

  // ------------------------------------------------------------------ stockage (chrome.storage.local)
  // Survit aux rechargements et au redémarrage du navigateur ; propre à l'extension, invisible du site.
  const store = {
    get: async (key, fallback) => ((await chrome.storage.local.get(key))[key] ?? fallback),
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  };

  let settings = { badges: true };
  let prices = {}; // id de carte -> { at, q: { SR: { avg, count, week } }, failed? }
  const seen = new Map(); // titre normalisé -> { id, title, rarities: Set, shiny: bool }
  const trades = new Map(); // id d'échange -> { id, sides } (src/lib.js, tradesIn)

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
      throw Object.assign(new Error("trop de requêtes (429), pause d'une minute"), { rateLimited: true });
    }
    if (response.status === 403 || response.status >= 500) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { transient: true });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // ------------------------------------------------------------------ cotes
  const queue = new Set();
  const retries = new Map(); // id de carte -> erreurs passagères déjà subies
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
          retries.delete(id);
        } catch (error) {
          if (error.rateLimited) {
            queue.add(id); // le site demande de ralentir : la carte attend la fin de la pause, ce n'est pas un échec
            continue;
          }
          // Erreur passagère (site surchargé, réseau, autre extension qui le sollicite) : on réessaie un peu plus tard.
          const tries = (retries.get(id) || 0) + 1;
          if ((error.transient || error instanceof TypeError) && tries < RETRIES) {
            retries.set(id, tries);
            pausedUntil = Math.max(pausedUntil, Date.now() + RETRY_PAUSE_MS);
            queue.add(id);
            continue;
          }
          retries.delete(id);
          prices[id] = { at: Date.now(), q: {}, failed: String(error.message || error) };
        }
        savePricesSoon();
        scheduleBadges();
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
      store.set(PRICES_KEY, prices);
    }, 1000);
  }

  // Réponses de l'API recopiées par src/inject.js. On note seulement les cartes : leur prix n'est demandé que si
  // elles sont trouvées sur la page (voir badge), pas pour celles d'un échange ou d'une notification.
  function note(data) {
    for (const c of cardsIn(data)) {
      const key = norm(c.title);
      const entry = seen.get(key) || { id: c.id, title: c.title, rarities: new Set(), shiny: false };
      if (c.rarity) entry.rarities.add(c.rarity);
      if (c.shiny) entry.shiny = true;
      seen.set(key, entry);
    }
    for (const t of tradesIn(data)) trades.set(t.id, t);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "wme-page") return;
    note(event.data.data);
    scheduleBadges();
  });

  // Certaines pages (Collection globale) gardent leur réponse dans le sessionStorage de l'onglet et ne la redemandent
  // pas quand on y revient : aucune requête à écouter. On lit donc aussi ces copies (une seule fois chacune).
  const readCopies = new Set();
  function readSessionCopies() {
    let storage;
    try {
      storage = window.sessionStorage;
    } catch (_) {
      return; // stockage bloqué par le navigateur
    }
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.includes("/api/")) continue;
      const value = storage.getItem(key) || "";
      const tag = `${key}|${value.length}`;
      if (readCopies.has(tag) || value.length > 5e6) continue;
      readCopies.add(tag);
      try {
        note(JSON.parse(value));
      } catch (_) {
        // pas du JSON : ignoré
      }
    }
  }

  // ------------------------------------------------------------------ badges sur les cartes
  // Le site n'a pas de classe CSS stable pour une carte : on la retrouve par son titre. On parcourt les textes de la
  // page ; un texte égal au titre d'une carte connue est le nom de la carte, et sa « tuile » est le premier parent qui
  // contient une image et a des frères (une grille). Idée reprise de wm-qol (Kitsoune), qui résiste aux mises à jour.
  const OURS = ".wme-badge, .wme-trade";

  // Taille de l'illustration d'une carte : les petites images (icônes des étiquettes…) ne comptent pas. Une « carte »
  // plus large que CARD_MAX_PX est en fait une fenêtre (la fiche d'une carte) : le titre de son en-tête n'a pas de badge.
  const ART_MIN_PX = 60;
  const CARD_MAX_PX = 480;
  const hasArt = (el) => [...el.querySelectorAll("img")].some((img) => img.getBoundingClientRect().width >= ART_MIN_PX);

  // Le badge de rareté de la tuile : un élément dont le texte est « SR », « L », « L✦ » (shiny)… C'est la rareté de
  // CET exemplaire, et son style sert de modèle au badge de prix. -> { rarity, shiny, el } ; el = null si introuvable.
  // Le « ✦ » d'un shiny peut être un caractère, un élément à part ou une icône (svg) : on remonte donc jusqu'au plus
  // grand élément qui ne contient que ce badge, et une icône dedans compte comme shiny si le site a dit que la carte
  // existe en shiny.
  const SHINY_MARK = /[✦✧✨★☆⭐+]/;
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join("");
  const rarityCode = (text) => {
    const raw = text.trim();
    const code = raw.toUpperCase().replace(/[^A-Z]/g, "");
    return raw.length <= 4 && rank(code) >= 0 ? code : "";
  };
  function tileRarity(tile, entry) {
    for (const el of tile.querySelectorAll("*")) {
      if (el.closest(OURS)) continue;
      const code = rarityCode(ownText(el));
      if (!code || rarityCode(el.textContent) !== code) continue;
      let badgeEl = el;
      while (badgeEl.parentElement && badgeEl.parentElement !== tile &&
        rarityCode(badgeEl.parentElement.textContent) === code) badgeEl = badgeEl.parentElement;
      const shiny = SHINY_MARK.test(badgeEl.textContent) || (entry.shiny && Boolean(badgeEl.querySelector("svg, img")));
      return { rarity: code, shiny, el: badgeEl };
    }
    return { rarity: entry.rarities.size === 1 ? [...entry.rarities][0] : "", shiny: false, el: null };
  }

  // Styles recopiés du badge de rareté : le prix a la même allure (couleurs, bordure, police, taille) que le « SR »
  // ou le « L » d'à côté, sur les petites cartes comme sur les grandes.
  const COPIED_STYLES = ["background-color", "background-image", "color", "border-top-width", "border-top-style",
    "border-top-color", "border-right-width", "border-right-style", "border-right-color", "border-bottom-width",
    "border-bottom-style", "border-bottom-color", "border-left-width", "border-left-style", "border-left-color",
    "border-radius", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "padding-top",
    "padding-right", "padding-bottom", "padding-left", "box-shadow", "text-shadow", "height", "box-sizing"];

  function copyRarityStyle(badgeEl, rarityEl, tile) {
    const from = getComputedStyle(rarityEl);
    for (const prop of COPIED_STYLES) badgeEl.style.setProperty(prop, from.getPropertyValue(prop));
    badgeEl.style.display = "inline-flex";
    badgeEl.style.alignItems = "center";
    // Centré (styles.css), à la hauteur du badge de rareté. Les positions mesurées tiennent compte d'un agrandissement
    // au survol : on les ramène à la taille normale de la carte (offsetWidth ignore cet agrandissement).
    const tileBox = tile.getBoundingClientRect();
    const rarityBox = rarityEl.getBoundingClientRect();
    const scale = tileBox.width / (tile.offsetWidth || 1) || 1;
    const top = (rarityBox.top - tileBox.top) / scale - tile.clientTop;
    badgeEl.style.top = `${Math.max(0, top).toFixed(1)}px`;
  }

  // La carte d'un titre : son plus petit parent qui contient aussi l'illustration. C'est l'élément que le site anime au
  // survol (il grandit, se soulève) : un badge posé dedans suit l'animation.
  function findTiles() {
    const tiles = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || el.closest(OURS)) continue;
      const entry = seen.get(norm(node.nodeValue));
      if (!entry) continue;
      let cur = el;
      for (let i = 0; i < 10 && cur && cur !== document.body; i++, cur = cur.parentElement) {
        if (hasArt(cur)) {
          if (cur.offsetWidth <= CARD_MAX_PX && !tiles.has(cur)) tiles.set(cur, entry);
          break;
        }
      }
    }
    // Une « carte » qui en contient une autre est en fait la grille (titre sans illustration à lui) : on l'écarte.
    return [...tiles].filter(([t]) => ![...tiles.keys()].some((o) => o !== t && t.contains(o)));
  }

  // Taille du badge proportionnelle à la largeur de la carte : ~1/15 de la largeur, entre 8 et 14 px.
  // offsetWidth ignore l'agrandissement au survol (transform) : le badge grandit avec la carte, sans recalcul.
  const badgeFontPx = (tile) => Math.max(8, Math.min(14, tile.offsetWidth / 15));

  function badge(tile, entry) {
    want(entry.id);
    const { rarity, shiny, el: rarityEl } = tileRarity(tile, entry);
    const entryPrices = prices[entry.id];
    let text = "…";
    let tip = "Prix en cours de lecture";
    let state = "wait";
    let value = 0;
    if (entryPrices && fresh(entryPrices)) {
      const q = entryPrices.q[rarity];
      if (entryPrices.failed) {
        [text, tip, state] = ["?", `Prix illisible : ${entryPrices.failed}`, "none"];
      } else if (q && shiny) {
        // Le site ne donne aucun prix propre aux shiny : afficher celui de la carte ordinaire tromperait.
        [text, state] = ["✦ ?", "none"];
        tip = `${entry.title} ${rarity} shiny : le site ne donne pas de prix pour les shiny.\n` +
          `${rarity} ordinaire : ≈ ${wb(q.avg)} (${q.count} vente(s)).`;
      } else if (q) {
        const age = Math.round((Date.now() - entryPrices.at) / 60e3);
        const label = q.week >= currentWeek() ? "Prix moyen de la semaine" : `Dernier prix moyen connu (semaine du ${q.week})`;
        [text, state, value] = [`≈ ${wb(q.avg)}`, "ok", q.avg];
        tip = `${entry.title} ${rarity} : ${label}, ${q.count} vente(s). Relevé il y a ${age} min.`;
      } else {
        const others = Object.entries(entryPrices.q).sort(([a], [b]) => rank(b) - rank(a))
          .map(([r, v]) => `${r} ≈ ${wb(v.avg)}`).join(", ");
        [text, state] = [rarity ? "—" : "?", "none"];
        tip = rarity ? `Aucune vente enregistrée en ${rarity}.` : "Rareté de cette carte non reconnue.";
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
    if (rarityEl) {
      copyRarityStyle(el, rarityEl, tile);
      el.dataset.styled = "rarity";
    } else {
      // Pas de badge de rareté à imiter : style par défaut (styles.css), à la taille de la carte.
      const size = `${badgeFontPx(tile).toFixed(1)}px`;
      if (el.style.fontSize !== size) el.style.fontSize = size;
      delete el.dataset.styled;
    }
    if (el.textContent !== text) el.textContent = text;
    el.title = tip;
    el.dataset.state = state;
    return value;
  }

  // Prix d'un exemplaire pour le bilan d'un échange : null si inconnu (shiny, aucune vente, pas encore lu).
  function priceOf(item) {
    const entry = prices[item.id];
    const q = entry && fresh(entry) && !entry.failed && entry.q[item.rarity];
    return q && !item.shiny ? q.avg : null;
  }

  // ------------------------------------------------------------------ bilan d'un échange
  // Le bloc d'un échange : le plus petit élément qui contient une tuile de chaque côté de l'échange et AUCUNE tuile
  // d'une autre carte. Une même carte peut apparaître dans plusieurs échanges de la liste : on essaie chacune de ses
  // tuiles, et un bloc qui déborde sur un autre échange est écarté. Le bilan se pose juste après ce bloc.
  function tradeBlock(trade, tiles) {
    const ids = new Set(trade.sides.flatMap((s) => s.items.map((i) => i.id)));
    const mine = tiles.filter(([, entry]) => ids.has(entry.id)).map(([tile]) => tile);
    const others = tiles.filter(([, entry]) => !ids.has(entry.id)).map(([tile]) => tile);
    const sideTiles = trade.sides.filter((s) => s.items.length)
      .map((s) => tiles.filter(([, entry]) => s.items.some((i) => i.id === entry.id)).map(([tile]) => tile));
    if (sideTiles.length === 0 || sideTiles.some((list) => list.length === 0)) return null;
    let best = null;
    for (const start of mine) {
      for (let node = start.parentElement; node && node !== document.body; node = node.parentElement) {
        if (others.some((t) => node.contains(t))) break; // déborde sur une autre carte : trop haut
        if (sideTiles.every((list) => list.some((t) => node.contains(t)))) {
          if (!best || best.contains(node)) best = node;
          break;
        }
      }
    }
    return best;
  }

  function tradeLine(trade) {
    const balance = tradeBalance(trade, priceOf);
    const side = (s) => `${s.name} donne ≈ ${wb(s.cards)}` + (s.wb ? ` + ${wb(s.wb)} WB` : "") +
      (s.missing ? ` (${s.missing} carte${s.missing > 1 ? "s" : ""} sans prix)` : "");
    const [a, b] = balance.sides;
    const winner = balance.gain >= 0 ? a.name : b.name;
    const verdict = Math.abs(balance.gain) < 1 ? "échange équilibré" : `${winner} y gagne ≈ ${wb(Math.abs(balance.gain))}`;
    return { text: `${side(a)} · ${side(b)} → ${verdict}`, gain: balance.gain, incomplete: a.missing + b.missing > 0 };
  }

  let shownTrades = [];
  function drawTrades(tiles) {
    const kept = new Set();
    shownTrades = [];
    for (const trade of trades.values()) {
      const block = tradeBlock(trade, tiles);
      if (!block || !block.parentElement) continue;
      for (const side of trade.sides) for (const item of side.items) want(item.id); // cartes sans tuile comprises
      const line = tradeLine(trade);
      shownTrades.push(line.text);
      const selector = `.wme-trade[data-trade="${CSS.escape(trade.id)}"]`;
      let el = block.nextElementSibling && block.nextElementSibling.matches(selector) ? block.nextElementSibling : null;
      if (!el) {
        el = document.createElement("div");
        el.className = "wme-trade";
        el.dataset.trade = trade.id;
        block.after(el);
      }
      if (el.textContent !== `Bilan : ${line.text}`) el.textContent = `Bilan : ${line.text}`;
      el.title = "Cartes au prix moyen du site, dans leur rareté, plus les WB ajoutés. Les shiny n'ont pas de prix.";
      kept.add(el);
    }
    document.querySelectorAll(".wme-trade").forEach((el) => kept.has(el) || el.remove());
  }

  let badgeTimer = null;
  let shownValue = 0;
  let shownTiles = 0;
  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(drawBadges, 300);
  }

  // Sur un profil (vitrines), le prix n'apparaît qu'au survol de la carte : une vitrine se regarde.
  const hoverOnly = () => location.pathname.startsWith("/profile");

  function drawBadges() {
    readSessionCopies();
    document.documentElement.classList.toggle("wme-hover-only", hoverOnly());
    if (!settings.badges) {
      document.querySelectorAll(OURS).forEach((b) => b.remove());
      shownTiles = 0;
      shownValue = 0;
      shownTrades = [];
      return;
    }
    const tiles = findTiles();
    shownTiles = tiles.length;
    shownValue = tiles.reduce((sum, [tile, entry]) => sum + badge(tile, entry), 0);
    drawTrades(tiles);
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

  // ------------------------------------------------------------------ fenêtre de l'extension (src/popup.js)
  // La fenêtre ouverte par l'icône vit dans le monde de l'extension : elle ne voit pas la page. Elle demande donc
  // l'état à ce script par chrome.runtime, et lui transmet les réglages.
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "badges") {
      settings.badges = Boolean(message.on);
      store.set("settings", settings);
      drawBadges();
    } else if (message.type === "reread") {
      prices = {};
      store.set(PRICES_KEY, prices);
      drawBadges();
    }
    reply({
      badges: settings.badges,
      seen: seen.size,
      tiles: shownTiles,
      value: shownValue,
      known: Object.values(prices).filter((p) => fresh(p) && !p.failed).length,
      waiting: queue.size,
      paused: pausedUntil > Date.now(),
      trades: shownTrades,
    });
  });

  // ------------------------------------------------------------------ démarrage
  const ready = (async () => {
    settings = { ...settings, ...(await store.get("settings", {})) };
    prices = await store.get(PRICES_KEY, {});
    for (const [id, entry] of Object.entries(prices)) {
      if (!entry || Date.now() - entry.at > PRICE_KEEP_MS) delete prices[id];
    }
    chrome.storage.local.remove(["friends", "prices"]); // 0.1 : liste des amis, et cotes calculées autrement
    scheduleBadges();
  })();

  // Prêt à écouter : src/inject.js renvoie les réponses du site arrivées avant le démarrage de ce script.
  window.postMessage({ source: "wme-content", type: "ready" }, location.origin);
})();
