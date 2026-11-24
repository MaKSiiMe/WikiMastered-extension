// Content script : tourne sur chaque page de wiki-masters.com, dans un monde isolé (il voit le DOM, pas le JS du site).
//
// 1. Il reçoit de src/inject.js les réponses de l'API du site, et note les cartes affichées.
// 2. Il demande le prix moyen de chacune (une requête par carte : le site n'a pas de route groupée), par deux routes
//    qui ont chacune leur quota (historique des prix, ou dernières ventes pour une carte peu vendue), les cartes à
//    l'écran d'abord, et le garde 6 h ; plus vieux, jusqu'à 7 jours, il reste affiché grisé le temps d'être relu. Avec les prix partagés (option), il demande d'abord au serveur commun
//    (server/, via src/background.js) les lectures des autres participants, et y dépose les siennes.
// 3. Il pose un badge « ≈ 1 250 » sur chaque carte de la page, retrouvée par son titre, et le bilan d'un échange
//    affiché (ce que chaque côté donne).
// 4. Il coordonne les réglages d'automatisation par clic (src/click.js, dans le même monde isolé) et répond à la
//    fenêtre de l'extension (src/popup.js, clic sur l'icône ou Alt+Maj+W) : compteurs, statut clic et réglages.
(() => {
  if (window.__wmeContent) return;
  window.__wmeContent = true;

  const { rank, norm, quotes, reliable, MIN_SALES, RECENT_WEEKS, currentWeek, SALES_LIMIT, historyFromSales, salesComplete, totalSales, ago, cardsIn, tradesIn, tradeBalance, emptyPullLog, addPull, settlePullPrices, pullBaseline, pullRecap, readBudget, countSince, addLimitEvent, siteLimit, wb } = WME;

  // ------------------------------------------------------------------ réglages
  const PRICES_KEY = "prices-v2";       // prix moyens du site (la 0.1 gardait un autre calcul sous « prices »)
  const PRICE_TTL_MS = 6 * 3600e3;      // une cote est redemandée après 6 h (comme le bot)
  const FAILED_TTL_MS = 10 * 60e3;      // une cote illisible est réessayée après 10 min
  const RETRIES = 3;                    // erreur passagère du site (autre 403, 5xx, réseau) : 3 essais avant « ? »
  const RETRY_PAUSE_MS = 15e3;          // … espacés de 15 s
  const PRICE_KEEP_MS = 7 * 24 * 3600e3; // cotes de plus de 7 jours oubliées
  const GREY_AFTER_MS = 24 * 3600e3;    // relu après 6 h, mais grisé seulement après 24 h (le prix bouge peu en un jour)
  const REQUEST_GAP_MS = 500;           // au moins 0,5 s entre deux requêtes de l'extension (~30 s pour 50 cartes)…
  const REQUEST_JITTER_MS = 300;        // … plus un délai au hasard, pour ne pas taper en rythme régulier
  const RATE_LIMIT_PAUSE_MS = 60e3;     // le site répond 429 (trop de requêtes) sans Retry-After : pause d'une minute
  const LIMIT_PAUSE_MS = 10 * 60e3;     // 403 automation_limit ou vérification demandée : pause de 10 min
  const READ_BUDGET = 80;               // lectures par route et par fenêtre de 10 min, tous onglets confondus :
  const READ_WINDOW_MS = 10 * 60e3;     // le site bloque vers 90-100 (et le bot WikiMastered lit sur le même compte)
  const READS_KEY = "wmPriceReads";     // dates des lectures récentes de price-history, partagées entre onglets
  const SALES_READS_KEY = "wmSalesReads"; // … de /sales, qui a son propre quota (readBudget)
  const PAUSE_KEY = "wmPricePause";     // { until, reason } : pause de toutes les lectures, partagée entre onglets
  const ROUTE_PAUSE_KEY = "wmRoutePause"; // { history: { until, reason }, sales: … } : quota d'une seule route atteint
  const LIMITS_KEY = "wmLimitLog";      // refus du site, avec les lectures qui les ont précédés (addLimitEvent)
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
  // minSales : ventes sur 12 semaines à partir desquelles un prix est fiable (sinon « ≈ »).
  let settings = { badges: true, autoClickPack: false, autoUnblockMarket: false, minSales: MIN_SALES };
  let prices = {}; // id de carte -> { at, q: { SR: { avg, count, week } }, failed? }
  const seen = new Map(); // titre normalisé -> { id, title, rarities: Set, shiny: bool }
  const trades = new Map(); // id d'échange -> { id, sides } (src/lib.js, tradesIn)
  let pullLog = WME.emptyPullLog(); // paquets ouverts : { titles, packs } (src/lib.js, addPull)
  let pullBaselineEntry = null; // { at, counts } une fois repris de l'autre extension (ou remis à zéro)

  // ------------------------------------------------------------------ requêtes au site
  // Deux routes donnent le prix d'une carte, chacune avec son propre quota sur le site :
  //  - history : /price-history, toutes les ventes par semaine et par rareté (ce que le site affiche) ;
  //  - sales : /sales, les 5 dernières ventes. Pour une carte vendue moins de 5 fois en tout, c'est toute son histoire,
  //    et on en refait exactement le même historique (historyFromSales, src/lib.js). Les cartes communes (C, PC, R)
  //    passent presque toutes par là. Idée de LeadOn/Wikimasters-Toolbox.
  // Chaque route a son budget (READ_BUDGET par READ_WINDOW_MS, partagé entre onglets), sa cadence, et sa pause quand
  // le site la coupe (automation_limit). Une vérification humaine ou un 429 arrêtent les deux.
  const ROUTES = {
    history: { label: "historiques", readsKey: READS_KEY, lock: "wme-price-reads" },
    sales: { label: "ventes", readsKey: SALES_READS_KEY, lock: "wme-sales-reads" },
  };
  for (const r of Object.values(ROUTES)) Object.assign(r, { last: 0, pausedUntil: 0, reason: "", reads: 0, waiting: false });
  let pausedUntil = 0; // pause de toutes les routes
  let limitLog = []; // refus du site (LIMITS_KEY), pour la fenêtre
  let pauseReason = "";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Une pause demandée par le site vaut pour tous les onglets : le quota est celui du compte, pas de l'onglet.
  function pauseAll(ms, reason) {
    const until = Date.now() + ms;
    if (until <= pausedUntil) return;
    pausedUntil = until;
    pauseReason = reason;
    store.set(PAUSE_KEY, { until, reason });
  }

  function pauseRoute(route, ms, reason) {
    const r = ROUTES[route];
    const until = Date.now() + ms;
    if (until <= r.pausedUntil) return;
    [r.pausedUntil, r.reason] = [until, reason];
    store.set(ROUTE_PAUSE_KEY, Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, { until: v.pausedUntil, reason: v.reason }])));
  }

  const routePausedUntil = (route) => Math.max(pausedUntil, ROUTES[route].pausedUntil);

  // Budget d'une route : -> ms à attendre avant sa prochaine lecture (0 : tout de suite). Avec `take`, la place est
  // réservée, sous un verrou (Web Locks, commun aux onglets du site) pour que deux onglets ne prennent pas la même.
  async function budgetWait(route, take) {
    const r = ROUTES[route];
    const check = async () => {
      const now = Date.now();
      const budget = readBudget(await store.get(r.readsKey, []), now, READ_BUDGET, READ_WINDOW_MS);
      r.reads = budget.stamps.length;
      if (budget.wait > 0 || !take) return budget.wait;
      await store.set(r.readsKey, [...budget.stamps, now]);
      r.reads += 1;
      return 0;
    };
    if (!take) return check();
    try {
      return navigator.locks ? await navigator.locks.request(r.lock, check) : await check();
    } catch (_) {
      return check(); // verrou indisponible (content script Firefox…) : réservation sans verrou
    }
  }

  // Attend que la route puisse lire (pause finie, place dans le budget) sans rien réserver : la carte à lire n'est
  // choisie qu'ensuite, d'après ce qui est à l'écran à ce moment-là.
  async function routeReady(route) {
    const r = ROUTES[route];
    for (;;) {
      const wait = Math.max(routePausedUntil(route) - Date.now(), await budgetWait(route, false));
      r.waiting = wait > 0;
      if (!r.waiting) return;
      await sleep(Math.min(wait + 50, 30e3)); // relu au plus toutes les 30 s : un autre onglet a pu libérer de la place
    }
  }

  // Note un refus du site avec nos lectures de la route juste avant (10 dernières minutes, dernière minute). Les
  // lectures d'une autre extension sur le même compte (Toolbox…) n'y sont pas : elles comptent pourtant pour le site.
  async function noteLimit(route, limit, status) {
    const now = Date.now();
    const stamps = await store.get(ROUTES[route].readsKey, []);
    const event = { at: now, route, limit, status, reads10m: countSince(stamps, now, READ_WINDOW_MS), reads1m: countSince(stamps, now, 60e3) };
    store.set(LIMITS_KEY, addLimitEvent(await store.get(LIMITS_KEY, []), event));
  }

  async function get(route, path) {
    const r = ROUTES[route];
    for (let wait = await budgetWait(route, true); wait > 0; wait = await budgetWait(route, true)) {
      await sleep(Math.min(wait + 50, 30e3)); // un autre onglet a pris la dernière place entre-temps
    }
    const wait = Math.max(routePausedUntil(route), r.last + REQUEST_GAP_MS + Math.random() * REQUEST_JITTER_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    r.last = Date.now();
    const response = await siteFetch(location.origin + path, { credentials: "include" });
    if (response.ok) return response.json();
    const body = await response.text().catch(() => "");
    const limit = siteLimit(response.status, body);
    if (limit) {
      // Le site demande d'arrêter : on attend, et la carte n'est pas un échec (elle sera relue).
      const retryAfter = Number(response.headers.get("Retry-After")) * 1000;
      const reason = {
        verification: "vérification demandée par le site",
        automation: "quota de lectures du site atteint",
        rate: "le site limite les requêtes",
      }[limit];
      noteLimit(route, limit, response.status);
      if (limit === "automation") pauseRoute(route, LIMIT_PAUSE_MS, reason);
      else pauseAll(limit === "rate" && retryAfter > 0 ? retryAfter : limit === "rate" ? RATE_LIMIT_PAUSE_MS : LIMIT_PAUSE_MS, reason);
      throw Object.assign(new Error(`${reason} (HTTP ${response.status})`), { rateLimited: true });
    }
    if (response.status === 403 || response.status >= 500) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { transient: true });
    }
    throw new Error(`HTTP ${response.status}`);
  }

  // ------------------------------------------------------------------ cotes
  // File d'attente : id de carte -> { prio, rarity, salesTried }. D'abord « urgent » (paquet ouvert, échange affiché),
  // puis « page » (les cartes de la page, les plus proches de l'écran d'abord ; une carte qui a quitté la page est
  // retirée), puis « background » (cartes du récap des paquets, au démarrage).
  const PRIO = { background: 1, page: 2, urgent: 3 };
  const queue = new Map();
  const retries = new Map(); // id de carte -> erreurs passagères déjà subies
  const refused = new Map(); // id -> { until, error } : relecture refusée, l'ancien prix reste affiché jusque-là
  const workers = { history: false, sales: false };
  let pageTiles = new Map(); // id de carte -> ses tuiles sur la page (dernier passage de drawBadges)

  const fresh = (entry) => entry && Date.now() - entry.at < (entry.failed ? FAILED_TTL_MS : PRICE_TTL_MS);
  // Un prix de plus de 6 h reste affiché, grisé, jusqu'à 7 jours : le temps d'être relu.
  const usable = (entry) => Boolean(entry && !entry.failed && entry.q && Date.now() - entry.at < PRICE_KEEP_MS);

  function want(cardId, prio = "page", rarity = "") {
    if (fresh(prices[cardId])) return;
    const block = refused.get(cardId);
    if (block && Date.now() < block.until) return;
    const cur = queue.get(cardId);
    queue.set(cardId, {
      prio: cur && PRIO[cur.prio] > PRIO[prio] ? cur.prio : prio,
      rarity: rarity || (cur && cur.rarity) || "",
      salesTried: Boolean(cur && cur.salesTried),
    });
    wantShared(cardId);
    startWorkers();
  }

  // /sales d'abord ? Oui pour une carte qu'on sait vendue moins de 5 fois en tout, et, sans historique connu, pour une
  // carte commune (C, PC, R) : elles se vendent peu.
  function viaSales(id, item) {
    if (item.salesTried) return false;
    const n = prices[id] && prices[id].n;
    if (Number.isFinite(n)) return n < SALES_LIMIT;
    return rank(item.rarity) >= 0 && rank(item.rarity) <= rank("R");
  }

  // Distance (px) entre l'écran et la plus proche tuile de la carte : 0 si visible, Infinity si plus sur la page.
  function screenDistance(id) {
    let best = Infinity;
    for (const tile of pageTiles.get(id) || []) {
      if (!tile.isConnected) continue;
      const box = tile.getBoundingClientRect();
      best = Math.min(best, box.bottom < 0 ? -box.bottom : box.top > innerHeight ? box.top - innerHeight : 0);
    }
    return best;
  }

  // La prochaine carte à lire par cette route. La route des historiques laisse les cartes « /sales d'abord » à
  // l'autre, sauf si celle-ci est en pause ou attend son budget.
  function pick(route) {
    const salesFree = routePausedUntil("sales") <= Date.now() && !ROUTES.sales.waiting;
    let best = null;
    let bestScore = -Infinity;
    for (const [id, item] of queue) {
      if (fresh(prices[id])) {
        queue.delete(id);
        continue;
      }
      let distance = 0;
      if (item.prio === "page") {
        distance = screenDistance(id);
        if (distance === Infinity) {
          queue.delete(id); // la carte a quitté la page : plus la peine de la lire
          continue;
        }
      }
      const sales = viaSales(id, item);
      if (route === "sales" ? !sales : sales && salesFree) continue;
      const score = PRIO[item.prio] * 1e9 - Math.min(distance, 1e8);
      if (score > bestScore) [best, bestScore] = [id, score];
    }
    return best;
  }

  function startWorkers() {
    for (const route of Object.keys(ROUTES)) if (!workers[route]) runWorker(route);
  }

  async function runWorker(route) {
    workers[route] = true;
    try {
      await ready; // les cotes déjà mémorisées d'abord : pas de requête pour une cote encore fraîche
      for (;;) {
        await routeReady(route);
        await sharedIdle(); // une autre lecture l'a peut-être déjà faite (cache partagé)
        const id = pick(route);
        if (!id) break;
        const item = queue.get(id);
        queue.delete(id);
        await readCard(route, id, item);
      }
    } finally {
      workers[route] = false;
      ROUTES[route].waiting = false;
    }
  }

  // Une lecture réussie, d'où qu'elle vienne : gardée, et déposée sur le serveur partagé.
  function remember(id, history, at) {
    prices[id] = { at, q: quotes(history), n: totalSales(history) };
    retries.delete(id);
    refused.delete(id);
    pushShared(id, history, at);
  }

  async function readCard(route, id, item) {
    const card = encodeURIComponent(id);
    try {
      if (route === "sales") {
        const data = await get("sales", `/api/marketplace/cards/${card}/sales`);
        if (!salesComplete(data)) {
          // 5 ventes (ou réponse inattendue) : il y en a peut-être d'autres, l'historique complet est nécessaire.
          queue.set(id, { ...item, salesTried: true });
          startWorkers();
          return;
        }
        remember(id, historyFromSales(data.recent), Date.now());
      } else {
        remember(id, await get("history", `/api/marketplace/cards/${card}/price-history`), Date.now());
      }
    } catch (error) {
      if (error.rateLimited) {
        queue.set(id, item); // le site demande de ralentir : la carte attend la fin de la pause, ce n'est pas un échec
        startWorkers();
        return;
      }
      if (route === "sales") {
        queue.set(id, { ...item, salesTried: true }); // l'historique prend le relais
        startWorkers();
        return;
      }
      // Erreur passagère (site surchargé, réseau, autre extension qui le sollicite) : on réessaie un peu plus tard.
      const tries = (retries.get(id) || 0) + 1;
      if ((error.transient || error instanceof TypeError) && tries < RETRIES) {
        retries.set(id, tries);
        if (Date.now() + RETRY_PAUSE_MS > ROUTES.history.pausedUntil) {
          [ROUTES.history.pausedUntil, ROUTES.history.reason] = [Date.now() + RETRY_PAUSE_MS, "erreur passagère du site"];
        }
        queue.set(id, item);
        return;
      }
      retries.delete(id);
      const message = String(error.message || error);
      if (usable(prices[id])) refused.set(id, { until: Date.now() + FAILED_TTL_MS, error: message }); // l'ancien reste
      else prices[id] = { at: Date.now(), q: {}, failed: message };
    }
    savePricesSoon();
    scheduleBadges();
  }

  // L'onglet « Marché » d'une fiche ouverte par le joueur : le site vient de lire l'historique (src/inject.js le
  // recopie), on le reprend sans requête.
  async function fromSite(url, history) {
    const match = /\/api\/marketplace\/cards\/([^/?#]+)\/price-history/.exec(String(url));
    if (!match || !history || typeof history.by_rarity !== "object" || !history.by_rarity) return;
    await ready;
    const id = decodeURIComponent(match[1]);
    const mine = prices[id];
    if (mine && !mine.failed && Date.now() - mine.at < 60e3) return; // notre propre lecture (Firefox la voit passer)
    remember(id, history, Date.now());
    queue.delete(id);
    savePricesSoon();
    scheduleBadges();
  }

  // ------------------------------------------------------------------ prix partagés (server/, src/background.js)
  // Option de la fenêtre, désactivée par défaut. Avant de lire une carte sur le site, on demande au serveur commun si
  // un participant (une autre extension, un bot) l'a lue : une requête pour toute la page. Chaque lecture faite sur le
  // site y est déposée en retour. On n'envoie que l'identifiant de la carte et son historique de prix : ni pseudo, ni
  // cookie, ni collection.
  let sharedOn = false;
  let sharedSkipUntil = 0;
  const sharedAsked = new Map(); // id -> date de la dernière demande au serveur
  const sharedWanted = new Map(); // id -> âge maximal demandé (s)
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
    // Première demande : toute lecture de la semaine (affichée grisée si elle a plus de 6 h). Ensuite, toutes les
    // 2 min tant que la carte attend : seulement une lecture fraîche, faite entre-temps par un autre participant.
    sharedWanted.set(id, (asked ? PRICE_TTL_MS : PRICE_KEEP_MS) / 1000);
    sharedTimer ||= setTimeout(askShared, 150); // les cartes d'une page arrivent ensemble : une seule demande
  }

  function askShared() {
    clearTimeout(sharedTimer);
    sharedTimer = null;
    if (!sharedWanted.size) return;
    const groups = new Map(); // âge maximal -> ids
    const now = Date.now();
    for (const [id, maxAge] of sharedWanted) {
      (groups.get(maxAge) || groups.set(maxAge, []).get(maxAge)).push(id);
      sharedAsked.set(id, now);
    }
    sharedWanted.clear();
    sharedBusy = sharedBusy.then(async () => {
      let changed = false;
      for (const [maxAge, ids] of groups) {
        for (let i = 0; i < ids.length; i += 100) {
          const reply = await shared({ type: "shared-get", ids: ids.slice(i, i + 100), maxAge });
          if (!noteShared(reply)) return;
          for (const [id, item] of Object.entries(reply.items || {})) {
            const mine = prices[id];
            if (mine && !mine.failed && mine.at >= item.read_at) continue; // la nôtre est aussi récente
            prices[id] = { at: item.read_at, q: quotes(item.history), n: totalSales(item.history), by: item.read_by };
            sharedStats.served += 1;
            changed = true;
          }
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
    if (on) for (const id of queue.keys()) wantShared(id); // cartes déjà en attente : d'abord le cache
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
    if (event.data.kind === "price-history") {
      fromSite(event.data.url, event.data.data);
      return;
    }
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
    const { rarity, shiny, el: rarityEl } = tileRarity(tile, entry);
    want(entry.id, "page", rarity);
    const entryPrices = prices[entry.id];
    let text = "…";
    let tip = "Prix en cours de lecture";
    let state = "wait";
    let value = 0;
    const isFresh = fresh(entryPrices);
    if (entryPrices && (isFresh || usable(entryPrices))) {
      const q = entryPrices.q[rarity];
      // Plus de 6 h : relu en arrière-plan ; affiché grisé seulement après 24 h.
      const block = refused.get(entry.id);
      const old = isFresh ? "" : block ? ` Relecture refusée par le site (${block.error}) : nouvel essai bientôt.`
        : " Relecture en cours.";
      if (entryPrices.failed) {
        [text, tip, state] = ["?", `Prix illisible : ${entryPrices.failed}`, "none"];
      } else if (q && shiny) {
        // Le site ne donne aucun prix propre aux shiny : afficher celui de la carte ordinaire tromperait.
        [text, state] = ["✦ ?", "none"];
        tip = `${entry.title} ${rarity} shiny : le site ne donne pas de prix pour les shiny.\n` +
          `${rarity} ordinaire : ≈ ${wb(q.avg)} (${q.count} vente(s)).${old}`;
      } else if (q) {
        const label = q.week >= currentWeek() ? "Prix moyen de la semaine" : `Dernier prix moyen connu (semaine du ${q.week})`;
        const grey = Date.now() - entryPrices.at >= GREY_AFTER_MS;
        // Prix fiable (assez de ventes sur 12 semaines) : le chiffre seul ; sinon « ≈ », à prendre avec prudence.
        const sure = reliable(q, settings.minSales);
        [text, state, value] = [sure ? wb(q.avg) : `≈ ${wb(q.avg)}`, grey ? "old" : "ok", q.avg];
        const by = entryPrices.by && entryPrices.by !== sharedStats.who ? ` par ${entryPrices.by}` : "";
        const sales = sure === null ? ""
          : ` ${q.sales12} vente(s) sur ${RECENT_WEEKS} semaines${sure ? "" : ` : prix incertain (fiable à partir de ${settings.minSales})`}.`;
        tip = `${entry.title} ${rarity} : ${label}, ${q.count} vente(s).${sales} ` +
          `Relevé il y a ${ago(Date.now() - entryPrices.at)}${by}.${old}`;
      } else {
        const others = Object.entries(entryPrices.q).sort(([a], [b]) => rank(b) - rank(a))
          .map(([r, v]) => `${r} ≈ ${wb(v.avg)}`).join(", ");
        [text, state] = [rarity ? "—" : "?", "none"];
        tip = rarity ? `Aucune vente enregistrée en ${rarity}.` : "Rareté de cette carte non reconnue.";
        if (others) tip += ` Autres raretés : ${others}.`;
        tip += old;
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
  // `allowOld` : un prix de plus de 6 h compte aussi (bilan d'un échange affiché, comme les badges grisés). Le récap
  // des paquets, lui, fige seulement un prix frais.
  function priceOf(item, allowOld = false) {
    const entry = prices[item.id];
    const ok = entry && !entry.failed && (fresh(entry) || (allowOld && usable(entry)));
    const q = ok && entry.q[item.rarity];
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
    const balance = tradeBalance(trade, (item) => priceOf(item, true));
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
      for (const side of trade.sides) for (const item of side.items) want(item.id, "urgent", item.rarity); // même sans tuile
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
      pageTiles = new Map();
      shownTiles = 0;
      shownValue = 0;
      shownTrades = [];
      return;
    }
    const tiles = findTiles();
    pageTiles = new Map();
    for (const [tile, entry] of tiles) (pageTiles.get(entry.id) || pageTiles.set(entry.id, []).get(entry.id)).push(tile);
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
    for (const c of cards) if (!c.shiny) want(c.id, "urgent", c.rarity);
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

  function applyRoutePauses(saved) {
    for (const [route, pause] of Object.entries(saved || {})) {
      const r = ROUTES[route];
      if (r && pause && pause.until > r.pausedUntil) [r.pausedUntil, r.reason] = [pause.until, pause.reason || ""];
    }
  }

  // Pauses en cours, pour la fenêtre : [{ reason, until }].
  function currentPauses() {
    const now = Date.now();
    const out = pausedUntil > now ? [{ reason: pauseReason || "le site limite les requêtes", until: pausedUntil }] : [];
    for (const r of Object.values(ROUTES)) if (r.pausedUntil > now) out.push({ reason: `${r.label} : ${r.reason}`, until: r.pausedUntil });
    return out;
  }

  // Plusieurs onglets du site ouverts : chacun garde le journal à jour quand un autre l'écrit.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const pause = changes[PAUSE_KEY] && changes[PAUSE_KEY].newValue;
    if (pause && pause.until > pausedUntil) [pausedUntil, pauseReason] = [pause.until, pause.reason || ""];
    if (changes[ROUTE_PAUSE_KEY]) applyRoutePauses(changes[ROUTE_PAUSE_KEY].newValue);
    if (changes[LIMITS_KEY]) limitLog = changes[LIMITS_KEY].newValue || [];
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
    } else if (message.type === "minSales") {
      settings.minSales = Math.min(50, Math.max(1, Math.round(Number(message.value)) || MIN_SALES));
      store.set("settings", settings);
      drawBadges();
    } else if (message.type === "clearPulls") {
      pullLog = emptyPullLog();
      store.set(PULLS_KEY, pullLog);
      // Repartir de rien, y compris les cartes d'avant : gardé vide (pas supprimé) pour ne pas les reprendre.
      pullBaselineEntry = { at: Date.now(), counts: {} };
      store.set(PULL_BASELINE_KEY, pullBaselineEntry);
    } else if (message.type === "reread") {
      prices = {};
      refused.clear();
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
      minSales: settings.minSales,
      clickInfo,
      seen: seen.size,
      tiles: shownTiles,
      value: shownValue,
      known: Object.values(prices).filter((p) => fresh(p) && !p.failed).length,
      old: Object.values(prices).filter((p) => usable(p) && Date.now() - p.at >= GREY_AFTER_MS).length,
      waiting: queue.size,
      pauses: currentPauses(),
      reads: Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [k, r.reads])),
      limits: limitLog.slice(0, 5),
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
    applyRoutePauses(await store.get(ROUTE_PAUSE_KEY, null));
    limitLog = await store.get(LIMITS_KEY, []);
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
      for (const [id, rarity, shiny, price] of pack.cards) if (!Number.isFinite(price) && !shiny) want(id, "background", rarity);
    }
  })();

  // Prêt à écouter : src/inject.js renvoie les réponses du site arrivées avant le démarrage de ce script.
  window.postMessage({ source: "wme-content", type: "ready" }, location.origin);
})();
