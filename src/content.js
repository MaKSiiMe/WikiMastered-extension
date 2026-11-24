// Content script : tourne sur chaque page de wiki-masters.com, dans un monde isolé (il voit le DOM, pas le JS du site).
//
// 1. Il reçoit de src/inject.js les réponses de l'API du site, et note les cartes affichées.
// 2. Il demande le prix moyen de chacune (historique des prix, une requête par carte : le site n'en a pas d'autre),
//    une requête à la fois, et le garde 6 h. Avec les prix partagés (option), il demande d'abord au serveur commun
//    (server/, via src/background.js) les lectures des autres participants, et y dépose les siennes.
// 3. Il pose un badge « ≈ 1 250 » sur chaque carte de la page, retrouvée par son titre, et le bilan d'un échange
//    affiché (ce que chaque côté donne).
// 4. Il coordonne les réglages d'automatisation par clic (src/click.js, dans le même monde isolé) et répond à la
//    fenêtre de l'extension (src/popup.js, clic sur l'icône ou Alt+Maj+W) : compteurs, statut clic et réglages.
(() => {
  if (window.__wmeContent) return;
  window.__wmeContent = true;

  const { rank, norm, quotes, currentWeek, cardsIn, tradesIn, tradeBalance, emptyPullLog, addPull, settlePullPrices, pullBaseline, pullRecap, readBudget, siteLimit, wb } = WME;

  // ------------------------------------------------------------------ réglages
  const PRICES_KEY = "prices-v2";       // prix moyens du site (la 0.1 gardait un autre calcul sous « prices »)
  const PRICE_TTL_MS = 6 * 3600e3;      // une cote est redemandée après 6 h (comme le bot)
  const FAILED_TTL_MS = 10 * 60e3;      // une cote illisible est réessayée après 10 min
  const RETRIES = 3;                    // erreur passagère du site (autre 403, 5xx, réseau) : 3 essais avant « ? »
  const RETRY_PAUSE_MS = 15e3;          // … espacés de 15 s
  const PRICE_KEEP_MS = 7 * 24 * 3600e3; // cotes de plus de 7 jours oubliées
  const REQUEST_GAP_MS = 500;           // au moins 0,5 s entre deux requêtes de l'extension (~30 s pour 50 cartes)…
  const REQUEST_JITTER_MS = 300;        // … plus un délai au hasard, pour ne pas taper en rythme régulier
  const RATE_LIMIT_PAUSE_MS = 60e3;     // le site répond 429 (trop de requêtes) sans Retry-After : pause d'une minute
  const LIMIT_PAUSE_MS = 10 * 60e3;     // 403 automation_limit ou vérification demandée : pause de 10 min
  const READ_BUDGET = 80;               // lectures d'historique de prix par fenêtre de 10 min, tous onglets confondus :
  const READ_WINDOW_MS = 10 * 60e3;     // le site bloque vers 90-100 (et le bot WikiMastered lit sur le même compte)
  const READS_KEY = "wmPriceReads";     // dates des lectures récentes, partagées entre onglets (readBudget)
  const PAUSE_KEY = "wmPricePause";     // { until, reason } : pause demandée par le site, partagée entre onglets
  const PULLS_KEY = "wmPulls";          // journal des paquets ouverts, à la main ou en auto (récap de la fenêtre)
  const PULLS_MAX = 10000;              // ~50 000 cartes, ~3 Mo : au-delà, les paquets les plus anciens sont oubliés
  const PULL_BASELINE_KEY = "wmPullBaseline"; // cartes comptées avant le journal, reprises une fois : { at, counts }
  const OTHER_PULL_STATS_KEY = "wm_pull_stats_v1"; // compteurs de « WikiMasters - Prix moyen collection » (localStorage)
  const AUTO_PULL_WINDOW_MS = 15e3;     // un paquet ouvert moins de 15 s après un clic de src/click.js est « auto »
  const SHARED_KEY = "shared";          // serveur de prix partagés : { on, url, token } (fenêtre, src/background.js)
  const SHARED_RECHECK_MS = 2 * 60e3;   // une carte absente du cache partagé y est redemandée après 2 min
  const SHARED_PUSH_MS = 3e3;           // lectures déposées par lots, au plus toutes les 3 s
  const SHARED_SKIP_MS = 10 * 60e3;     // « Relire tous les prix » : le site d'abord, pas le cache, pendant 10 min

  // Firefox : `content.fetch` envoie la requête comme la page elle-même (cookies de session compris). Chrome n'a pas
  // `content` : le fetch du content script part déjà depuis la page.
  const siteFetch = typeof content !== "undefined" && content.fetch ? content.fetch.bind(content) : fetch.bind(window);

  // ------------------------------------------------------------------ stockage (chrome.storage.local)
  // Survit aux rechargements et au redémarrage du navigateur ; propre à l'extension, invisible du site.
  const store = {
    get: async (key, fallback) => ((await chrome.storage.local.get(key))[key] ?? fallback),
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  };

  // Réglages persistés : badges actifs par défaut ; automatisations par clic désactivées par défaut.
  let settings = { badges: true, autoClickPack: false, autoUnblockMarket: false };
  let prices = {}; // id de carte -> { at, q: { SR: { avg, count, week } }, failed? }
  const seen = new Map(); // titre normalisé -> { id, title, rarities: Set, shiny: bool }
  const trades = new Map(); // id d'échange -> { id, sides } (src/lib.js, tradesIn)
  let pullLog = WME.emptyPullLog(); // paquets ouverts : { titles, packs } (src/lib.js, addPull)
  let pullBaselineEntry = null; // { at, counts } une fois repris de l'autre extension (ou remis à zéro)

  // ------------------------------------------------------------------ requêtes au site, une à la fois
  let lastRequest = 0;
  let pausedUntil = 0;
  let pauseReason = "";
  let recentReads = 0; // lectures dans la fenêtre de 10 min, à la dernière vérification du budget (fenêtre)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Une pause demandée par le site vaut pour tous les onglets : le quota est celui du compte, pas de l'onglet.
  function pauseAll(ms, reason) {
    const until = Date.now() + ms;
    if (until <= pausedUntil) return;
    pausedUntil = until;
    pauseReason = reason;
    store.set(PAUSE_KEY, { until, reason });
  }

  // Réserve une lecture dans le budget partagé (READ_BUDGET par READ_WINDOW_MS), en attendant s'il est épuisé. Le
  // verrou (Web Locks, commun aux onglets du site) empêche deux onglets de prendre la même place.
  async function takeReadSlot() {
    for (;;) {
      const reserve = async () => {
        const now = Date.now();
        const budget = readBudget(await store.get(READS_KEY, []), now, READ_BUDGET, READ_WINDOW_MS);
        recentReads = budget.stamps.length;
        if (budget.wait > 0) return budget.wait;
        await store.set(READS_KEY, [...budget.stamps, now]);
        recentReads += 1;
        return 0;
      };
      let wait;
      try {
        wait = navigator.locks ? await navigator.locks.request("wme-price-reads", reserve) : await reserve();
      } catch (_) {
        wait = await reserve(); // verrou indisponible (content script Firefox…) : réservation sans verrou
      }
      if (wait === 0) return;
      await sleep(Math.min(wait + 50, 30e3)); // relu au plus toutes les 30 s : un autre onglet a pu libérer de la place
    }
  }

  async function get(path) {
    await takeReadSlot();
    const wait = Math.max(pausedUntil, lastRequest + REQUEST_GAP_MS + Math.random() * REQUEST_JITTER_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const response = await siteFetch(location.origin + path, { credentials: "include" });
    if (response.ok) return response.json();
    const body = await response.text().catch(() => "");
    const limit = siteLimit(response.status, body);
    if (limit) {
      // Le site demande d'arrêter : tout le monde attend, et la carte n'est pas un échec (elle sera relue).
      const retryAfter = Number(response.headers.get("Retry-After")) * 1000;
      const [ms, reason] = {
        verification: [LIMIT_PAUSE_MS, "vérification demandée par le site"],
        automation: [LIMIT_PAUSE_MS, "quota de lectures du site atteint"],
        rate: [retryAfter > 0 ? retryAfter : RATE_LIMIT_PAUSE_MS, "le site limite les requêtes"],
      }[limit];
      pauseAll(ms, reason);
      throw Object.assign(new Error(`${reason} (HTTP ${response.status})`), { rateLimited: true });
    }
    if (response.status === 403 || response.status >= 500) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { transient: true });
    }
    throw new Error(`HTTP ${response.status}`);
  }

  // ------------------------------------------------------------------ cotes
  const queue = new Set();
  const retries = new Map(); // id de carte -> erreurs passagères déjà subies
  let queueRunning = false;

  const fresh = (entry) => entry && Date.now() - entry.at < (entry.failed ? FAILED_TTL_MS : PRICE_TTL_MS);

  function want(cardId) {
    if (!fresh(prices[cardId])) {
      queue.add(cardId);
      wantShared(cardId);
    }
    if (!queueRunning) runQueue();
  }

  // ------------------------------------------------------------------ prix partagés (server/, src/background.js)
  // Option de la fenêtre, désactivée par défaut. Avant de lire une carte sur le site, on demande au serveur commun si
  // un participant (une autre extension, un bot) l'a lue depuis moins de 6 h : une requête pour toute la page. Chaque
  // lecture faite sur le site y est déposée en retour. On n'envoie que l'identifiant de la carte et la réponse
  // price-history : ni pseudo, ni cookie, ni collection.
  let sharedOn = false;
  let sharedSkipUntil = 0;
  const sharedAsked = new Map(); // id -> date de la dernière demande au serveur
  const sharedWanted = new Set();
  let sharedTimer = null;
  let sharedBusy = Promise.resolve();
  const sharedOut = [];
  let sharedPushTimer = null;
  const sharedStats = { who: "", served: 0, pushed: 0, error: "" };

  const shared = (message) => chrome.runtime.sendMessage(message)
    .then((reply) => reply || { error: "pas de réponse" })
    .catch((error) => ({ error: String((error && error.message) || error) }));
  const noteShared = (reply) => {
    sharedStats.error = reply.error || "";
    if (reply.who) sharedStats.who = reply.who;
    return !reply.error;
  };

  function wantShared(id) {
    if (!sharedOn || Date.now() < sharedSkipUntil) return;
    const asked = sharedAsked.get(id);
    if (asked && Date.now() - asked < SHARED_RECHECK_MS) return;
    sharedWanted.add(id);
    sharedTimer ||= setTimeout(askShared, 150); // les cartes d'une page arrivent ensemble : une seule demande
  }

  function askShared() {
    clearTimeout(sharedTimer);
    sharedTimer = null;
    const ids = [...sharedWanted];
    sharedWanted.clear();
    if (!ids.length) return;
    const now = Date.now();
    for (const id of ids) sharedAsked.set(id, now);
    sharedBusy = sharedBusy.then(async () => {
      let changed = false;
      for (let i = 0; i < ids.length; i += 100) {
        const reply = await shared({ type: "shared-get", ids: ids.slice(i, i + 100), maxAge: PRICE_TTL_MS / 1000 });
        if (!noteShared(reply)) break;
        for (const [id, item] of Object.entries(reply.items || {})) {
          const mine = prices[id];
          if (mine && !mine.failed && mine.at >= item.read_at) continue; // la nôtre est plus récente
          prices[id] = { at: item.read_at, q: quotes(item.history), by: item.read_by };
          sharedStats.served += 1;
          changed = true;
        }
      }
      if (changed) {
        savePricesSoon();
        scheduleBadges();
      }
    });
  }

  // La file attend la réponse du cache partagé avant de lire une carte sur le site.
  async function sharedIdle() {
    if (sharedTimer) askShared();
    await sharedBusy;
  }

  function pushShared(id, history, at) {
    if (!sharedOn || !history || typeof history.by_rarity !== "object" || !history.by_rarity) return;
    sharedOut.push({ id, read_at: at, history: { computed_at: history.computed_at ?? null, by_rarity: history.by_rarity } });
    if (sharedOut.length >= 50) flushShared();
    else sharedPushTimer ||= setTimeout(flushShared, SHARED_PUSH_MS);
  }

  async function flushShared() {
    clearTimeout(sharedPushTimer);
    sharedPushTimer = null;
    while (sharedOut.length) {
      const reply = await shared({ type: "shared-put", items: sharedOut.splice(0, 100) });
      if (!noteShared(reply)) return; // serveur injoignable : ces lectures restent seulement chez nous
      sharedStats.pushed += reply.stored || 0;
    }
  }
  window.addEventListener("pagehide", () => { if (sharedOut.length) flushShared(); });

  function applySharedConfig(cfg) {
    const on = Boolean(cfg && cfg.on && cfg.url && cfg.token);
    if (on === sharedOn) return;
    sharedOn = on;
    sharedAsked.clear();
    if (on) for (const id of queue) wantShared(id); // cartes déjà en attente : d'abord le cache
  }

  async function runQueue() {
    queueRunning = true;
    try {
      await ready; // les cotes déjà mémorisées d'abord : pas de requête pour une cote encore fraîche
      while (queue.size) {
        const id = queue.values().next().value;
        queue.delete(id);
        await sharedIdle(); // une autre lecture l'a peut-être déjà faite (cache partagé)
        if (fresh(prices[id])) continue;
        try {
          const history = await get(`/api/marketplace/cards/${encodeURIComponent(id)}/price-history`);
          const at = Date.now();
          prices[id] = { at, q: quotes(history) };
          pushShared(id, history, at);
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
        const by = entryPrices.by && entryPrices.by !== sharedStats.who ? ` par ${entryPrices.by}` : "";
        tip = `${entry.title} ${rarity} : ${label}, ${q.count} vente(s). Relevé il y a ${age} min${by}.`;
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

  // ------------------------------------------------------------------ récap des paquets ouverts
  // src/inject.js signale chaque ouverture réussie (« pack-opened », avec la réponse du site). Tous les paquets sont
  // notés : « auto » si src/click.js vient de cliquer, sinon ouvert à la main. Ce script est le seul à écrire le
  // journal : deux écrivains se marcheraient dessus (l'un écraserait le paquet ajouté par l'autre).
  // Format compact du journal : voir addPull dans src/lib.js.
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "wme-click") return;
    if (event.data.type !== "pack-opened") return;
    await ready; // le journal enregistré d'abord : sinon ce paquet l'écraserait
    const clickState = typeof window.__wmeClickState === "function" ? window.__wmeClickState() : null;
    const auto = Boolean(clickState && Date.now() - clickState.autoClickAt <= AUTO_PULL_WINDOW_MS);
    const cards = cardsIn(event.data.data);
    pullLog = addPull(pullLog, { at: Date.now(), auto, cards }, PULLS_MAX);
    store.set(PULLS_KEY, pullLog);
    for (const c of cards) if (!c.shiny) want(c.id);
  });

  // Fige les prix connus dans le journal (settlePullPrices, src/lib.js) et l'enregistre s'il a changé.
  function settlePulls() {
    if (settlePullPrices(pullLog, priceOf)) store.set(PULLS_KEY, pullLog);
  }

  // Reprend une seule fois les compteurs de l'autre extension, s'ils sont là. Ils vivent dans le localStorage du
  // site, que ce content script partage avec la page (mais seulement sur www.wiki-masters.com, où elle tourne) : tant
  // qu'ils sont introuvables, on réessaie au prochain chargement. Une fois repris, ils ne sont plus relus : elle
  // continue de compter les mêmes paquets que nous.
  function importPullBaseline() {
    if (pullBaselineEntry) return;
    let other = null;
    try {
      other = JSON.parse(localStorage.getItem(OTHER_PULL_STATS_KEY) || "null");
    } catch (_) {
      return; // illisible : on n'invente rien
    }
    const counts = pullBaseline(other, pullLog);
    if (!counts) return;
    pullBaselineEntry = { at: Date.now(), counts };
    store.set(PULL_BASELINE_KEY, pullBaselineEntry);
  }

  // Plusieurs onglets du site ouverts : chacun garde le journal à jour quand un autre l'écrit.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const pause = changes[PAUSE_KEY] && changes[PAUSE_KEY].newValue;
    if (pause && pause.until > pausedUntil) [pausedUntil, pauseReason] = [pause.until, pause.reason || ""];
    if (changes[PULLS_KEY]) pullLog = changes[PULLS_KEY].newValue || emptyPullLog();
    if (changes[PULL_BASELINE_KEY]) pullBaselineEntry = changes[PULL_BASELINE_KEY].newValue || null;
    if (changes[SHARED_KEY]) applySharedConfig(changes[SHARED_KEY].newValue);
  });

  // ------------------------------------------------------------------ fenêtre de l'extension (src/popup.js)
  // La fenêtre ouverte par l'icône vit dans le monde de l'extension : elle ne voit pas la page. Elle demande donc
  // l'état à ce script par chrome.runtime, et lui transmet les réglages (badges et automatisations par clic).
  // clickInfo est lu depuis src/click.js via window.__wmeClickState(), car les deux scripts partagent le même
  // monde isolé (« document_idle »).
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "badges") {
      settings.badges = Boolean(message.on);
      store.set("settings", settings);
      drawBadges();
    } else if (message.type === "autoClickPack") {
      settings.autoClickPack = Boolean(message.on);
      store.set("settings", settings);
    } else if (message.type === "autoUnblockMarket") {
      settings.autoUnblockMarket = Boolean(message.on);
      store.set("settings", settings);
    } else if (message.type === "clearPulls") {
      pullLog = emptyPullLog();
      store.set(PULLS_KEY, pullLog);
      // Repartir de rien, y compris les cartes d'avant : gardé vide (pas supprimé) pour ne pas les reprendre.
      pullBaselineEntry = { at: Date.now(), counts: {} };
      store.set(PULL_BASELINE_KEY, pullBaselineEntry);
    } else if (message.type === "reread") {
      prices = {};
      store.set(PRICES_KEY, prices);
      sharedSkipUntil = Date.now() + SHARED_SKIP_MS;
      drawBadges();
    }
    const clickInfo = typeof window.__wmeClickState === "function" ? window.__wmeClickState() : null;
    settlePulls();
    reply({
      badges: settings.badges,
      autoClickPack: settings.autoClickPack,
      autoUnblockMarket: settings.autoUnblockMarket,
      clickInfo,
      seen: seen.size,
      tiles: shownTiles,
      value: shownValue,
      known: Object.values(prices).filter((p) => fresh(p) && !p.failed).length,
      waiting: queue.size,
      paused: pausedUntil > Date.now(),
      pauseReason,
      pausedUntil,
      reads: recentReads,
      readBudget: READ_BUDGET,
      trades: shownTrades,
      shared: { on: sharedOn, ...sharedStats },
      pulls: pullRecap(pullLog, priceOf, (pullBaselineEntry && pullBaselineEntry.counts) || {}),
    });
  });

  // ------------------------------------------------------------------ démarrage
  const ready = (async () => {
    settings = { ...settings, ...(await store.get("settings", {})) };
    prices = await store.get(PRICES_KEY, {});
    applySharedConfig(await store.get(SHARED_KEY, null));
    const pause = await store.get(PAUSE_KEY, null);
    if (pause && pause.until > Date.now()) [pausedUntil, pauseReason] = [pause.until, pause.reason || ""];
    const storedPulls = await store.get(PULLS_KEY, null);
    if (Array.isArray(storedPulls)) {
      // Premier format (essais de la 0.4, packs auto seulement) : converti une fois au format compact.
      for (const pull of storedPulls) pullLog = addPull(pullLog, { ...pull, auto: true }, PULLS_MAX);
      settlePullPrices(pullLog, (c) => {
        const old = storedPulls.flatMap((p) => p.cards).find((o) => o.id === c.id && o.rarity === c.rarity && !o.shiny);
        return old && Number.isFinite(old.price) ? old.price : null;
      });
      store.set(PULLS_KEY, pullLog);
    } else if (storedPulls && Array.isArray(storedPulls.packs)) {
      pullLog = storedPulls;
    }
    for (const [id, entry] of Object.entries(prices)) {
      if (!entry || Date.now() - entry.at > PRICE_KEEP_MS) delete prices[id];
    }
    chrome.storage.local.remove(["friends", "prices"]); // 0.1 : liste des amis, et cotes calculées autrement
    scheduleBadges();
    pullBaselineEntry = await store.get(PULL_BASELINE_KEY, null);
    importPullBaseline();
    // Cartes tirées pas encore chiffrées (page fermée avant la réponse du site) : prix déjà en mémoire d'abord, les
    // autres sont redemandés au site.
    settlePulls();
    for (const pack of pullLog.packs) {
      for (const [id, , shiny, price] of pack.cards) if (!Number.isFinite(price) && !shiny) want(id);
    }
  })();

  // Prêt à écouter : src/inject.js renvoie les réponses du site arrivées avant le démarrage de ce script.
  window.postMessage({ source: "wme-content", type: "ready" }, location.origin);
})();
