// Content script : tourne sur chaque page de wiki-masters.com, dans un monde isolé (il voit le DOM, pas le JS du site).
//
// 1. Il reçoit de src/inject.js les réponses de l'API du site, et note les cartes affichées.
// 2. Il demande le prix moyen de chacune (une requête par carte : le site n'a pas de route groupée), par deux routes
//    qui ont chacune leur quota (historique des prix, ou dernières ventes pour une carte peu vendue), les cartes à
//    l'écran d'abord, et le garde 6 h ; plus vieux, jusqu'à 7 jours, il reste affiché grisé le temps d'être relu. Avec les prix partagés (option), il demande d'abord au serveur commun
//    (server/, via src/background.js) les lectures des autres participants, et y dépose les siennes.
// 3. Il pose un badge « ≈ 1 250 » sur chaque carte de la page, retrouvée par son titre, et le bilan d'un échange
//    affiché (ce que chaque côté donne).
// 4. Il coordonne les réglages d'automatisation par clic (src/click.js, dans le même monde isolé) et répond au
//    panneau de l'extension (src/panel.js, clic sur l'icône ou Alt+Maj+W) : compteurs, collection, réglages.
(() => {
  if (window.__wmeContent) return;
  window.__wmeContent = true;

  const { rank, norm, quotes, reliable, MIN_SALES, currentWeek, ownershipIn, SALES_LIMIT, historyFromSales, salesComplete, totalSales, ago, cardsIn, tradesIn, tradeBalance, emptyPullLog, addPull, settlePullPrices, pullBaseline, pullRecap, readBudget, auctionsIn, auctionDeal, minBid, sessionFromCookies, collectionSummary, filterCollection, friendRows, wishlistSummary, friendOwnersIn, wishOwners, myMarketIn, packCardsIn, discardPicks, packState, RARITIES, addDailyValue, countSince, addLimitEvent, siteLimit, wb } = WME;

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
  // Rafale : au plus 10 lectures par 30 s, les deux routes ensemble (relevé du 24/11 : le site a coupé les deux routes
  // après 18 et 19 lectures dans la même minute, une autre extension lisant en même temps ; Toolbox s'en tient aussi
  // à 10 par 30 s). Après un refus « quota », budgets et rafale divisés par deux pendant 24 h.
  const BURST = 10;
  const BURST_WINDOW_MS = 30e3;
  const BURST_KEY = "wmBurstReads";     // dates des lectures récentes, toutes routes
  const SLOW_KEY = "wmSlowUntil";       // date jusqu'à laquelle les budgets sont divisés par deux
  const SLOW_MS = 24 * 3600e3;
  const READS_KEY = "wmPriceReads";     // dates des lectures récentes de price-history, partagées entre onglets
  const SALES_READS_KEY = "wmSalesReads"; // … de /sales, qui a son propre quota (readBudget)
  const PAUSE_KEY = "wmPricePause";     // { until, reason } : pause de toutes les lectures, partagée entre onglets
  const ROUTE_PAUSE_KEY = "wmRoutePause"; // { history: { until, reason }, sales: … } : quota d'une seule route atteint
  const SUPABASE_KEY = "wmSupabase";   // { base, apikey } relevés dans les requêtes du site (src/inject.js)
  const COLLECTION_KEY = "wmCollection"; // { at, rows: [[exemplaire, carte, rareté, nombre, favori, shiny, image]], titles }
  const COLLECTION_TTL_MS = 12 * 3600e3; // collection relue au plus toutes les 12 h, sauf demande
  const SYNC_KEY = "wmSharedSync";      // { since (heure du serveur), sig } : dernière synchronisation avec le serveur partagé
  const VALUE_KEY = "wmValueHistory";   // valeur de la collection, une mesure par jour (#18)
  const OWNED_KEY = "wmOwned";          // possession des cartes d'après les réponses du site : { id: 1 | 0 }
  const LIMITS_KEY = "wmLimitLog";      // refus du site, avec les lectures qui les ont précédés (addLimitEvent)
  const PULLS_KEY = "wmPulls";          // journal des paquets ouverts, à la main ou en auto (récap de la fenêtre)
  const PULLS_MAX = 10000;              // ~50 000 cartes, ~3 Mo : au-delà, les paquets les plus anciens sont oubliés
  const THEME_KEY = "wmTheme"; // « light » ou « dark », relevé sur le site pour le panneau
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

  // Réglages persistés : badges actifs par défaut ; automatisations par clic, bonnes affaires du marché et images
  // Wikipédia désactivées par défaut. minWeekSales : ventes de la semaine à partir desquelles un prix est fiable.
  let settings = { badges: true, autoClickPack: false, autoUnblockMarket: false, minWeekSales: MIN_SALES, deals: false, images: false,
    autoDiscard: { on: false, rarities: ["C", "PC"], maxPrice: null, duplicatesOnly: true } };
  let prices = {}; // id de carte -> { at, q: { SR: { avg, count, week } }, failed? }
  const seen = new Map(); // titre normalisé -> { id, title, rarities: Set, shiny: bool }
  const owned = new Map(); // id de carte -> true (on l'a) | false (on ne l'a pas), d'après le site (ownershipIn)
  const auctions = new Map(); // « carte|rareté » -> enchère du marché la plus proche de sa fin (auctionsIn), pour #16
  const trades = new Map(); // id d'échange -> { id, sides } (src/lib.js, tradesIn)
  let siteProfile = null; // { at, data } : dernier profil lu par le site (paquets restants), src/inject.js
  let achievementProgress = null; // { at, progress: [{ code, current, target }] } : page /achievements du site
  let lastSheet = null; // { id, at } : dernière fiche de carte ouverte (le site a lu son historique de prix)
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
    history: { label: "historiques", readsKey: READS_KEY },
    sales: { label: "ventes", readsKey: SALES_READS_KEY },
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
  let slowUntil = 0; // budgets divisés par deux jusqu'à cette date (refus « quota » récent)
  const factor = () => (Date.now() < slowUntil ? 0.5 : 1);

  async function budgetWait(route, take) {
    const r = ROUTES[route];
    const check = async () => {
      const now = Date.now();
      const budget = readBudget(await store.get(r.readsKey, []), now, Math.floor(READ_BUDGET * factor()), READ_WINDOW_MS);
      const burst = readBudget(await store.get(BURST_KEY, []), now, Math.floor(BURST * factor()), BURST_WINDOW_MS);
      r.reads = budget.stamps.length;
      const wait = Math.max(budget.wait, burst.wait);
      if (wait > 0 || !take) return wait;
      await store.set(r.readsKey, [...budget.stamps, now]);
      await store.set(BURST_KEY, [...burst.stamps, now]);
      r.reads += 1;
      return 0;
    };
    if (!take) return check();
    // Les réservations passent une à une : dans l'onglet par une file (les deux routes partagent la rafale), entre
    // onglets par un verrou Web Locks commun quand le navigator le permet.
    const locked = async () => {
      try {
        return navigator.locks ? await navigator.locks.request("wme-price-reads", check) : await check();
      } catch (_) {
        return check(); // verrou indisponible (content script Firefox…) : la file de l'onglet suffit
      }
    };
    const turn = reservations.then(locked);
    reservations = turn.catch(() => {});
    return turn;
  }
  let reservations = Promise.resolve();

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
      if (limit === "automation") {
        pauseRoute(route, LIMIT_PAUSE_MS, reason);
        slowUntil = Date.now() + SLOW_MS;
        store.set(SLOW_KEY, slowUntil);
      }
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
  let sharedSig = "";
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
          if (applySharedItems(reply.items)) changed = true;
        }
      }
      if (changed) {
        savePricesSoon();
        scheduleBadges();
      }
    });
  }

  // Lectures reçues du serveur : gardées si elles sont plus récentes que les nôtres. -> nombre de prix pris.
  function applySharedItems(items) {
    let taken = 0;
    for (const [id, item] of Object.entries(items || {})) {
      const mine = prices[id];
      if (mine && !mine.failed && mine.at >= item.read_at) continue; // la nôtre est aussi récente
      prices[id] = { at: item.read_at, q: quotes(item.history), n: totalSales(item.history), by: item.read_by };
      sharedStats.served += 1;
      taken += 1;
    }
    return taken;
  }

  // Toute une liste de cartes demandée au serveur partagé (bilan de la collection) : 100 par requête, à la suite,
  // lectures de la semaine. Le bot y dépose ses lectures de la collection : c'est là que sont la plupart des prix.
  async function fillFromShared(ids) {
    if (!sharedOn) return 0;
    let taken = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const reply = await shared({ type: "shared-get", ids: ids.slice(i, i + 100), maxAge: PRICE_KEEP_MS / 1000 });
      if (!noteShared(reply)) break;
      taken += applySharedItems(reply.items);
    }
    if (taken) {
      savePricesSoon();
      scheduleBadges();
    }
    return taken;
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
    // Signature du serveur et du jeton (fin du jeton seulement) : une synchronisation faite avec un autre serveur ou un
    // autre participant ne vaut pas pour celui-ci.
    sharedSig = cfg && cfg.url ? `${cfg.url}|${String(cfg.token || "").slice(-6)}` : "";
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
      const entry = seen.get(key) || { id: c.id, title: c.title, rarities: new Set(), shiny: false, url: "" };
      if (c.url) entry.url = c.url;
      if (c.noImage !== undefined) entry.noImage = c.noImage;
      if (c.rarity) entry.rarities.add(c.rarity);
      if (c.shiny) entry.shiny = true;
      seen.set(key, entry);
    }
    for (const t of tradesIn(data)) trades.set(t.id, t);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "wme-page") return;
    if (event.data.kind === "supabase") {
      noteSupabaseAccess(event.data);
      return;
    }
    if (event.data.kind === "price-history") {
      fromSite(event.data.url, event.data.data);
      // Le site lit l'historique d'une carte quand on ouvre sa fiche : c'est la fiche ouverte (onglet Page).
      const sheet = /\/api\/marketplace\/cards\/([^/?#]+)\/price-history/.exec(String(event.data.url));
      if (sheet) lastSheet = { id: decodeURIComponent(sheet[1]), at: Date.now() };
      return;
    }
    if (event.data.kind === "profile") {
      const p = Array.isArray(event.data.data) ? event.data.data[0] : event.data.data;
      if (p && Number.isFinite(Number(p.packs_remaining))) siteProfile = { at: Date.now(), data: p };
      return;
    }
    if (event.data.kind === "achievements") {
      const progress = event.data.data && Array.isArray(event.data.data.progress) ? event.data.data.progress : null;
      if (progress) achievementProgress = { at: Date.now(), progress };
      return;
    }
    if (event.data.kind === "sales") {
      fromSiteSales(event.data.url, event.data.data);
      return;
    }
    note(event.data.data);
    noteOwnership(event.data.url, event.data.data);
    for (const a of auctionsIn(event.data.data)) {
      const key = `${a.cardId}|${a.rarity}`;
      const known = auctions.get(key);
      if (!known || !(known.endAt > Date.now()) || (a.endAt && a.endAt < known.endAt) || (known.endAt === a.endAt)) auctions.set(key, a);
    }
    scheduleBadges();
  });

  // Possession des cartes : ce que les réponses du site en disent, gardé d'une visite à l'autre. Une carte vendue ou
  // défaussée reste « possédée » jusqu'à ce qu'une réponse dise le contraire.
  let ownedTimer = null;
  function noteOwnership(url, data) {
    let changed = false;
    for (const [id, flag] of ownershipIn(data, url)) {
      if (owned.get(id) === flag) continue;
      owned.set(id, flag);
      changed = true;
    }
    if (changed && !ownedTimer) {
      ownedTimer = setTimeout(() => {
        ownedTimer = null;
        store.set(OWNED_KEY, Object.fromEntries([...owned].map(([id, flag]) => [id, flag ? 1 : 0])));
      }, 2000);
    }
  }

  const onMarket = () => /^\/(marketplace|market|marche)(\/|$)/.test(location.pathname);

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
        const data = JSON.parse(value);
        note(data);
        noteOwnership(key, data);
      } catch (_) {
        // pas du JSON : ignoré
      }
    }
  }

  // ------------------------------------------------------------------ badges sur les cartes
  // Le site n'a pas de classe CSS stable pour une carte : on la retrouve par son titre. On parcourt les textes de la
  // page ; un texte égal au titre d'une carte connue est le nom de la carte, et sa « tuile » est le premier parent qui
  // contient une image et a des frères (une grille). Idée reprise de wm-qol (Kitsoune), qui résiste aux mises à jour.
  const OURS = ".wme-badge, .wme-trade, .wme-art, .wme-draft";

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
    if (settings.images && entry.noImage === true) fillImage(tile, entry);
    const entryPrices = prices[entry.id];
    let text = "…";
    let tip = "Prix en cours de lecture";
    let state = "wait";
    let value = 0;
    let deal = null;
    let skewed = false;
    const isFresh = fresh(entryPrices);
    if (entryPrices && (isFresh || usable(entryPrices))) {
      const q = entryPrices.q[rarity];
      // Plus de 6 h : relu en arrière-plan ; affiché grisé seulement après 24 h.
      if (entryPrices.failed) {
        [text, tip, state] = ["?", `Prix illisible : ${entryPrices.failed}`, "none"];
      } else if (q && shiny) {
        // Le site ne donne aucun prix propre aux shiny : afficher celui de la carte ordinaire tromperait.
        [text, state] = ["✦ ?", "none"];
        tip = `Shiny : le site ne donne pas leur prix (${rarity} ordinaire ≈ ${wb(q.avg)}).`;
      } else if (q) {
        const grey = Date.now() - entryPrices.at >= GREY_AFTER_MS;
        // Prix fiable (assez de ventes dans la semaine) : le chiffre seul ; sinon « ≈ », à prendre avec prudence.
        const sure = reliable(q, settings.minWeekSales);
        // Prix faussé (une vente isolée hors de proportion) : le prix habituel, marqué « ⚠ » ; le chiffre du site au survol.
        skewed = Boolean(q.skewed);
        [text, state, value] = [q.skewed ? `⚠ ${wb(q.avg)}` : sure ? wb(q.avg) : `≈ ${wb(q.avg)}`, grey ? "old" : "ok", q.avg];
        // Marché : bonne affaire ou surcoté (#16, option), d'après la mise minimum de l'enchère affichée.
        const auction = settings.deals && onMarket() ? auctions.get(`${entry.id}|${rarity}`) : null;
        deal = auction && !shiny ? auctionDeal(auction, q.avg, sure) : null;
        const when = q.week >= currentWeek() ? "cette semaine" : `semaine du ${q.week.slice(8, 10)}/${q.week.slice(5, 7)}`;
        const by = entryPrices.by && entryPrices.by !== sharedStats.who ? ` par ${entryPrices.by}` : "";
        tip = `${rarity} · ${q.count} vente(s) ${when} · relevé il y a ${ago(Date.now() - entryPrices.at)}${by}`;
        if (q.skewed) tip += `\nPrix faussé : le site affiche ${wb(q.skewed.avg)} (${q.skewed.count} vente(s) la semaine du ` +
          `${q.skewed.week.slice(8, 10)}/${q.skewed.week.slice(5, 7)}, hors de proportion), écarté. Ici, le prix habituel.`;
        if (deal) tip += deal.kind === "deal" ? `\nBonne affaire : mise minimum ${-deal.pct} % sous le prix, fin bientôt.`
          : `\nSurcoté : mise minimum ${deal.pct} % au-dessus du prix.`;
      } else {
        [text, state] = [rarity ? "—" : "?", "none"];
        tip = rarity ? `Jamais vendue en ${rarity}.` : "Rareté non reconnue.";
      }
      if (!isFresh) tip += refused.get(entry.id) ? "\nRelecture refusée par le site : nouvel essai bientôt." : "\nRelecture en cours.";
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
    el.dataset.deal = deal ? `${deal.pct > 0 ? "+" : "−"}${Math.abs(deal.pct)} %` : "";
    el.dataset.dealKind = deal ? deal.kind : "";
    el.title = tip;
    el.dataset.state = state;
    el.dataset.skewed = String(skewed);
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

  // Un compte supprimé s'appelle « compte_supprime_<identifiant> » : on n'en garde que le sens.
  const who = (name) => (/^compte_supprime/i.test(String(name)) ? "Compte supprimé" : name);

  function tradeLine(trade) {
    const balance = tradeBalance(trade, (item) => priceOf(item, true));
    const side = (s) => `${who(s.name)} donne ≈ ${wb(s.cards)}` + (s.wb ? ` + ${wb(s.wb)} WB` : "") +
      (s.missing ? ` (${s.missing} carte${s.missing > 1 ? "s" : ""} sans prix)` : "");
    const [a, b] = balance.sides;
    const winner = who(balance.gain >= 0 ? a.name : b.name);
    const verdict = Math.abs(balance.gain) < 1 ? "échange équilibré" : `${winner} y gagne ≈ ${wb(Math.abs(balance.gain))}`;
    return { text: `${side(a)} · ${side(b)} → ${verdict}`, gain: balance.gain, incomplete: a.missing + b.missing > 0 };
  }

  // Fenêtres du site (fiche d'une carte, proposition d'échange) : un voile plein écran.
  const MODAL = "div.fixed.inset-0";

  // Bilans posés seulement sur la page des échanges, hors des fenêtres : dans la fenêtre « Échanger avec … », les
  // cartes de l'ami ressembleraient à un échange déjà fait qui les contient.
  let shownTrades = [];
  function drawTrades(allTiles) {
    const kept = new Set();
    shownTrades = [];
    const tiles = location.pathname.startsWith("/trades") ? allTiles.filter(([tile]) => !tile.closest(MODAL)) : [];
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
      // Le bilan, puis (#26) le détail dépliable : chaque carte de chaque côté, titre complet, rareté et prix (le site
      // tronque les noms dans ses offres).
      const details = trade.sides.map((side) => `${who(side.name)} donne : ` + (side.items.length
        ? side.items.map((i) => `${i.title} ${i.rarity}${i.shiny ? " ✦" : ""} (${Number.isFinite(priceOf(i, true)) ? `≈ ${wb(priceOf(i, true))}` : "sans prix"})`).join(" · ")
        : "aucune carte") + (side.wb ? ` + ${wb(side.wb)} WB` : ""));
      const signature = [line.text, ...details].join("\n");
      if (el.dataset.text !== signature) {
        el.dataset.text = signature;
        const summary = Object.assign(document.createElement("summary"), { textContent: `Bilan : ${line.text}` });
        const box = document.createElement("details");
        box.append(summary, ...details.map((d) => Object.assign(document.createElement("div"), { className: "wme-trade-side", textContent: d })));
        const wasOpen = el.querySelector("details") && el.querySelector("details").open;
        box.open = Boolean(wasOpen);
        el.replaceChildren(box);
      }
      el.title = "Cartes au prix moyen du site, dans leur rareté, plus les WB ajoutés. Les shiny n'ont pas de prix. Clic : le détail des cartes.";
      kept.add(el);
    }
    document.querySelectorAll(".wme-trade:not(.wme-draft)").forEach((el) => kept.has(el) || el.remove());
  }

  // ------------------------------------------------------------------ composition d'une offre (#50)
  // Fenêtre « Échanger avec … » du site : barre « Moi : 2 cartes · 150 wb » / « <ami> : 1 carte », onglets « Mes
  // cartes » / « Cartes de <ami> » (l'actif est souligné : border-b-2), et sous « Sélectionnées (n) » les cartes
  // choisies de l'onglet ouvert seulement. On retient celles de chaque côté au fil des onglets. Dans la barre : la
  // valeur de chaque côté, et dessous l'écart ; le détail carte par carte va au panneau (onglet Page). Repères relevés
  // dans le code de LeadOn/Wikimasters-Toolbox. Lecture seule : l'offre part toujours avec le bouton du site.
  const TRADE_COUNTS = /:\s*([\d\s]+)\s*cartes?(?:\s*·\s*([\d\s]+)\s*wb)?/i;
  let tradeDraft = null; // { modal, friend, mine: [cartes], theirs: [cartes] }
  let shownDraft = null; // bilan de l'offre pour le panneau
  const countOf = (text) => Number(String(text || "").replace(/\D/g, "")) || 0;

  function tradeWindow() {
    for (const modal of document.querySelectorAll(MODAL)) {
      const mineLabel = [...modal.querySelectorAll("span")].find((el) => /^Moi\s*:/.test(el.textContent.trim()));
      const bar = mineLabel && mineLabel.parentElement;
      const theirLabel = bar && [...bar.children].find((el) => el !== mineLabel && el.tagName === "SPAN" && !el.classList.contains("wme-draft") && TRADE_COUNTS.test(el.textContent));
      const mineTab = theirLabel && [...modal.querySelectorAll("button")].find((b) => /^Mes cartes/.test(b.textContent.trim()));
      if (!mineTab) continue;
      const active = [...mineTab.parentElement.children].find((b) => b.tagName === "BUTTON" && String(b.className).includes("border-b-2")) || null;
      const heading = [...modal.querySelectorAll("p")].find((p) => /^Sélectionnées\s*\(/.test(p.textContent.trim()));
      return { modal, bar, mineLabel, theirLabel, mineTab, active, friend: theirLabel.textContent.split(":")[0].trim(), selected: heading ? heading.parentElement : null };
    }
    return null;
  }

  // Petit élément à nous, posé une fois juste après `anchor` (et retrouvé ensuite par sa classe).
  function ourAfter(anchor, className, tag = "span") {
    const next = anchor.nextElementSibling;
    if (next && next.classList.contains(className)) return next;
    const el = Object.assign(document.createElement(tag), { className: `wme-draft ${className}` });
    anchor.after(el);
    return el;
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  function drawTradeDraft(tiles) {
    const w = settings.badges ? tradeWindow() : null;
    if (!w) {
      tradeDraft = null;
      shownDraft = null;
      document.querySelectorAll(".wme-draft").forEach((el) => el.remove());
      return;
    }
    if (!tradeDraft || tradeDraft.modal !== w.modal || tradeDraft.friend !== w.friend) tradeDraft = { modal: w.modal, friend: w.friend, mine: [], theirs: [] };
    if (w.active) {
      const chosen = tiles.filter(([tile]) => w.selected && w.selected.contains(tile)).map(([tile, entry]) => {
        const { rarity, shiny } = tileRarity(tile, entry);
        return { id: entry.id, title: entry.title, rarity, shiny };
      });
      tradeDraft[w.active === w.mineTab ? "mine" : "theirs"] = chosen;
    }
    const side = (label, cards) => {
      const [, count, coins] = TRADE_COUNTS.exec(label.textContent) || [];
      let value = 0;
      let missing = 0;
      const list = cards.map((c) => {
        want(c.id, "urgent", c.rarity);
        const price = priceOf(c, true);
        if (Number.isFinite(price)) value += price;
        else missing += 1;
        return { title: c.title, rarity: c.rarity, shiny: c.shiny, price: Number.isFinite(price) ? price : null };
      });
      return { value, missing, wb: countOf(coins), count: countOf(count), seen: cards.length, cards: list };
    };
    const give = side(w.mineLabel, tradeDraft.mine);
    const get = side(w.theirLabel, tradeDraft.theirs);
    const total = (s) => s.value + s.wb;
    const gap = total(get) - total(give);
    const pct = total(give) > 0 ? Math.round((gap / total(give)) * 100) : null;
    shownDraft = { friend: w.friend, give, get, gap, pct };
    // Valeur de chaque côté, juste après son libellé dans la barre du site.
    const value = (s) => (s.seen < s.count ? `≈ ${wb(total(s))} (${s.count - s.seen} à voir)` : `≈ ${wb(total(s))}`) + (s.missing ? ` · ${s.missing} sans prix` : "");
    const mineValue = ourAfter(w.mineLabel, "wme-draft-value");
    const theirValue = ourAfter(w.theirLabel, "wme-draft-value");
    setText(mineValue, value(give));
    setText(theirValue, value(get));
    mineValue.title = "Tes cartes choisies, au prix moyen du site dans leur rareté, plus tes WB. « à voir » : ouvre l'onglet « Mes cartes » pour les compter.";
    theirValue.title = `Les cartes de ${w.friend} choisies, plus ses WB. « à voir » : ouvre l'onglet « Cartes de ${w.friend} » pour les compter.`;
    // L'écart, sous la barre.
    const verdict = ourAfter(w.bar, "wme-draft-gap", "div");
    const empty = !give.count && !get.count && !give.wb && !get.wb;
    setText(verdict, empty ? "" : Math.abs(gap) < 1 ? "Échange équilibré"
      : `${gap > 0 ? "En ta faveur" : `En faveur de ${w.friend}`} : ≈ ${wb(Math.abs(gap))}${pct !== null ? ` (${gap > 0 ? "+" : "−"}${Math.abs(pct)} %)` : ""}`);
    verdict.dataset.side = gap >= 0 ? "good" : "bad";
    verdict.hidden = empty;
    verdict.title = "Le détail carte par carte est dans le panneau de l'extension, onglet Page. L'offre part toujours avec le bouton du site.";
  }

  let badgeTimer = null;
  let pageCards = []; // cartes affichées (dernier passage de drawBadges) : [{ id, title, rarity, shiny }]
  const pickKeys = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  let shownValue = 0;
  let shownTiles = 0;
  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(drawBadges, 300);
  }

  // Sur un profil (vitrines), le prix n'apparaît qu'au survol de la carte : une vitrine se regarde.
  const hoverOnly = () => location.pathname.startsWith("/profile");

  // ------------------------------------------------------------------ collection complète (panneau : #18, #22)
  // Lue dans la base Supabase du site, comme le site lui-même : table user_cards (la base ne laisse voir que ses propres
  // cartes), 1000 exemplaires par requête, avec la session du joueur (cookie du site). Ce n'est pas une route de prix :
  // aucun quota de prix n'est entamé. Le jeton ne part que vers cette base.
  function noteSupabaseAccess({ base, apikey }) {
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/$/.test(String(base)) || typeof apikey !== "string" || apikey.length > 400) return;
    store.set(SUPABASE_KEY, { base, apikey });
  }

  async function session(base) {
    const name = `sb-${new URL(base).hostname.split(".")[0]}-auth-token`;
    let s = sessionFromCookies(document.cookie, name);
    if (!s || s.expiresAt - Date.now() < 120e3) {
      // Une requête au site fait renouveler le cookie de session quand il expire bientôt.
      await siteFetch(location.origin + "/api/wikibidous", { credentials: "include" }).catch(() => {});
      s = sessionFromCookies(document.cookie, name);
    }
    if (!s) throw new Error("Session du site introuvable : recharge la page, connecté.");
    return s;
  }

  let collectionReading = null;
  async function readCollection(force) {
    const cached = await store.get(COLLECTION_KEY, null);
    // La 0.7 ne gardait pas l'image, et les étiquettes ne sont lues que depuis la 0.10.1 : une collection lue avant est
    // relue, sinon ses étiquettes manqueraient (filtre vide, « sans étiquette » = toute la collection).
    const complete = cached && (!cached.rows.length || cached.rows[0].length >= 7) && "tags" in cached;
    if (!force && complete && Date.now() - cached.at < COLLECTION_TTL_MS) return cached;
    collectionReading ||= (async () => {
      const access = await store.get(SUPABASE_KEY, null);
      if (!access) throw new Error("Accès à la collection pas encore repéré : recharge une page du site, puis réessaie.");
      const { token, userId } = await session(access.base);
      const rows = [];
      const titles = {};
      const ids = new Set();
      for (let page = 0; page < 60; page++) {
        const query = "user_cards?select=id,card_id,count,starred,is_shiny,snapshot_rarity,cards(wikipedia_title,rarity,image_url,hide_image)" +
          `&order=obtained_at.desc,id.asc&limit=1000&offset=${page * 1000}`;
        const response = await fetch(access.base + query, {
          credentials: "omit",
          headers: { apikey: access.apikey, authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`Lecture de la collection refusée (HTTP ${response.status})`);
        const batch = await response.json();
        if (!Array.isArray(batch)) throw new Error("Réponse inattendue de la base du site");
        for (const r of batch) {
          if (!r || !r.card_id || ids.has(r.id)) continue; // ligne décalée par une écriture pendant la lecture
          ids.add(r.id);
          const card = r.cards || {};
          const rarity = String(r.snapshot_rarity || card.rarity || "").toUpperCase();
          // Image : 0 sans image (ou masquée par le site), 2 GIF, 1 autre (filtres #19).
          const image = card.hide_image || !card.image_url ? 0 : /\.gif(?:[?#]|$)/i.test(String(card.image_url)) ? 2 : 1;
          rows.push([String(r.id), String(r.card_id), rarity, Math.max(1, Number(r.count) || 1), r.starred ? 1 : 0, r.is_shiny ? 1 : 0, image]);
          if (card.wikipedia_title) titles[r.card_id] = String(card.wikipedia_title);
        }
        if (batch.length < 1000) break;
      }
      // Étiquettes (#63) : les miennes, puis leurs exemplaires étiquette par étiquette (une lecture globale dépasse le
      // délai du serveur, relevé par Toolbox), 3 à la fois. Un échec ne gêne pas la collection.
      const tags = {};
      const cardTags = {};
      let tagsError = "";
      try {
        const get = async (query) => {
          const response = await fetch(access.base + query, { credentials: "omit", headers: { apikey: access.apikey, authorization: `Bearer ${token}` } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        };
        for (const t of await get(`tags?select=id,name&user_id=eq.${encodeURIComponent(userId)}`)) if (t && t.id) tags[t.id] = String(t.name || t.id);
        const queue = Object.keys(tags);
        const worker = async () => {
          for (let id = queue.shift(); id; id = queue.shift()) {
            for (let page = 0; page < 30; page++) {
              const links = await get(`user_card_tags?select=user_card_id&tag_id=eq.${encodeURIComponent(id)}&order=user_card_id.asc&limit=1000&offset=${page * 1000}`);
              for (const l of links) if (l && l.user_card_id) (cardTags[l.user_card_id] ||= []).push(id);
              if (links.length < 1000) break;
            }
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      } catch (error) {
        tagsError = String((error && error.message) || error);
      }
      const result = { at: Date.now(), rows, titles, tags, cardTags, tagsError };
      await store.set(COLLECTION_KEY, result);
      // Possession exacte : les cartes de la collection sont à nous, les autres non (une carte vendue perd son ✓).
      const mine = new Set(rows.map((r) => r[1]));
      for (const id of owned.keys()) if (!mine.has(id)) owned.set(id, false);
      for (const id of mine) owned.set(id, true);
      store.set(OWNED_KEY, Object.fromEntries([...owned].map(([id, flag]) => [id, flag ? 1 : 0])));
      return result;
    })().finally(() => {
      collectionReading = null;
    });
    return collectionReading;
  }

  // Prix d'une carte dans une rareté pour les bilans : { avg, sure } ou null (inconnu, plus de 7 jours, jamais vendue).
  function cardPrice(cardId, rarity) {
    const entry = prices[cardId];
    const q = usable(entry) && entry.q[rarity];
    return q ? { avg: q.avg, sure: reliable(q, settings.minWeekSales) } : null;
  }

  // Synchronisation avec le serveur partagé, par différence : on demande ce qui a changé depuis la dernière fois
  // (identifiants et dates, une requête de 5000 au plus), puis seulement les historiques des cartes qui nous intéressent
  // (collection et souhaits) et que nous n'avons pas, ou plus anciennes. Au plus toutes les 5 min, et à chaque relecture.
  // Une seule synchronisation pour toutes ces cartes : la date de reprise vaut pour toutes.
  const SHARED_SYNC_MS = 5 * 60e3;
  let sharedFill = { at: 0, running: false, text: "" };

  async function interestIds() {
    const ids = new Set();
    const collection = await store.get(COLLECTION_KEY, null);
    if (collection) for (const row of collection.rows) if (!row[5]) ids.add(row[1]); // pas les shiny : sans prix propre
    if (wishCache) for (const w of wishCache.wishes) ids.add(w.id);
    return ids;
  }

  async function syncShared() {
    const interest = await interestIds();
    const saved = await store.get(SYNC_KEY, null);
    let since = saved && saved.sig === sharedSig ? Number(saved.since) || 0 : 0;
    const wanted = new Set();
    for (let page = 0; page < 50; page++) {
      const reply = await shared({ type: "shared-changes", since });
      if (!noteShared(reply)) throw new Error(reply.error);
      const items = reply.items || [];
      for (const [id, readAt] of items) {
        const mine = prices[id];
        if (interest.has(id) && !(mine && !mine.failed && mine.at >= readAt)) wanted.add(id);
      }
      since = reply.more && items.length ? items[items.length - 1][1] - 1 : reply.now;
      if (!reply.more) break;
    }
    const taken = await fillFromShared([...wanted]);
    await store.set(SYNC_KEY, { since, sig: sharedSig });
    return taken;
  }

  function startSharedFill(force) {
    if (!sharedOn || sharedFill.running || (!force && Date.now() - sharedFill.at < SHARED_SYNC_MS)) return;
    sharedFill = { ...sharedFill, at: Date.now(), running: true };
    syncShared().then((taken) => {
      sharedFill = { ...sharedFill, running: false, text: `Prix partagés : ${taken} prix reçu(s) à la dernière synchronisation (${time()}).` };
    }, (error) => {
      sharedFill = { ...sharedFill, running: false, text: `Prix partagés : ${(error && error.message) || "serveur injoignable"}.` };
    });
  }
  const time = () => new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  // Liste de souhaits (#21), lue dans la même base : table wishlist_items (ses propres souhaits), gardée 30 min.
  let wishCache = null;
  async function readWishlist(force) {
    if (!force && wishCache && Date.now() - wishCache.at < 30 * 60e3) return wishCache.wishes;
    const access = await store.get(SUPABASE_KEY, null);
    if (!access) throw new Error("Accès à la base pas encore repéré : recharge une page du site, puis réessaie.");
    const { token } = await session(access.base);
    const wishes = [];
    const ids = new Set();
    for (let page = 0; page < 20; page++) {
      const response = await fetch(`${access.base}wishlist_items?select=card_id,cards(wikipedia_title)&order=card_id.asc&limit=1000&offset=${page * 1000}`, {
        credentials: "omit", headers: { apikey: access.apikey, authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Lecture de la liste de souhaits refusée (HTTP ${response.status})`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error("Réponse inattendue de la base du site");
      for (const w of batch) {
        if (!w || !w.card_id || ids.has(w.card_id)) continue;
        ids.add(w.card_id);
        wishes.push({ id: String(w.card_id), title: String((w.cards && w.cards.wikipedia_title) || w.card_id) });
      }
      if (batch.length < 1000) break;
    }
    wishCache = { at: Date.now(), wishes };
    return wishes;
  }

  // Amis qui ont mes cartes souhaitées : la route du catalogue du site avec son filtre « Ma liste de souhaits »
  // (wishlist=1), comme sa page « Toutes les cartes ». Chaque page de 50 cartes donne aussi friendOwners (les amis qui
  // ont chaque carte) : on cherche mes souhaits chez mes amis, au lieu de lire leurs collections entières. Une page par
  // seconde, autant de pages que de souhaits (25 au plus). Gardé 30 min.
  let wishOwnersCache = null; // { at, owners: { carte: [...] }, given (le site a donné friendOwners) }
  let wishOwnersReading = null;
  let wishOwnersError = "";
  let wishOwnersTried = 0; // dernière tentative : après un refus, pas de nouvel essai automatique avant 5 min
  async function readWishOwners(force) {
    if (!force && wishOwnersCache && Date.now() - wishOwnersCache.at < 30 * 60e3) return wishOwnersCache;
    if (!wishOwnersReading) wishOwnersTried = Date.now();
    wishOwnersReading ||= (async () => {
      const wishes = await readWishlist(force);
      const wanted = new Set(wishes.map((w) => w.id));
      const owners = {};
      let given = false;
      const pages = Math.min(25, Math.ceil(wishes.length / 50) + 1);
      for (let page = 1; page <= pages && wanted.size; page++) {
        if (page > 1) await sleep(1000);
        const response = await siteFetch(`${location.origin}/api/cards?page=${page}&sort=rarity&wishlist=1`, { credentials: "include" });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(siteLimit(response.status, body) ? "le site limite les lectures : réessaie plus tard" : `catalogue refusé par le site (HTTP ${response.status})`);
        }
        const data = await response.json();
        note(data);
        noteOwnership("/api/cards", data);
        if (data && data.friendOwners && typeof data.friendOwners === "object") given = true;
        for (const [id, list] of Object.entries(friendOwnersIn(data))) if (wanted.has(id)) owners[id] = list;
        if (!(Array.isArray(data && data.cards) && data.cards.length >= 50)) break;
      }
      wishOwnersCache = { at: Date.now(), owners, given };
      wishOwnersError = "";
      return wishOwnersCache;
    })().catch((error) => {
      wishOwnersError = String((error && error.message) || error);
      throw error;
    }).finally(() => {
      wishOwnersReading = null;
    });
    return wishOwnersReading;
  }

  // Exemplaires d'une carte dans la collection lue d'un ami (Filtres), si elle couvre ces raretés ; sinon null.
  const friendRowsOf = (cardId) => (username, rarities) => {
    const f = friendCache.get(String(username).toLowerCase());
    if (!f || Date.now() - f.at > COLLECTION_TTL_MS) return null;
    if (!(rarities.length ? rarities : RARITIES).every((r) => f.rarities.includes(r))) return null;
    return f.rows.filter((r) => r[1] === cardId);
  };

  async function panelWishlist(refresh) {
    const wishes = await readWishlist(refresh);
    startSharedFill(refresh); // les souhaits font partie des cartes synchronisées (en arrière-plan)
    const stale = !wishOwnersCache || Date.now() - wishOwnersCache.at > 30 * 60e3;
    if (refresh || (stale && !(wishOwnersError && Date.now() - wishOwnersTried < 5 * 60e3))) readWishOwners(refresh).catch(() => {});
    const summary = wishlistSummary(wishes, (id) => (usable(prices[id]) ? prices[id].q : null), (id) => owned.get(id));
    const known = wishOwnersCache && wishOwnersCache.given ? wishOwnersCache.owners : null;
    for (const item of summary.items) item.friends = known ? wishOwners(known[item.id], friendRowsOf(item.id)) : null;
    return { ...summary, friends: { reading: Boolean(wishOwnersReading), at: wishOwnersCache && wishOwnersCache.at,
      given: Boolean(wishOwnersCache && wishOwnersCache.given), error: wishOwnersError } };
  }

  async function loadWishPrices() {
    const wishes = await readWishlist(false);
    let count = 0;
    for (const w of wishes) if (!usable(prices[w.id])) { want(w.id, "background"); count += 1; }
    return count;
  }

  // Prix d'une carte pour les filtres : jamais vendue (relevé récent sans vente dans cette rareté), prix, ou inconnu.
  function cardPriceInfo(cardId, rarity) {
    const entry = prices[cardId];
    if (!usable(entry)) return { state: "unknown" };
    const q = entry.q[rarity];
    return q ? { state: "price", avg: q.avg, sure: reliable(q, settings.minWeekSales) } : { state: "never" };
  }

  // Filtres (#19) sur ma collection ou celle d'un ami déjà lue (readFriend). Chaque ligne porte aussi les autres
  // exemplaires de la carte (raretés des doublons) et, pour ma collection, l'exemplaire qu'on peut mettre en vente.
  async function panelFilter(criteria = {}) {
    const wished = criteria.wished ? new Set((await readWishlist(false)).map((w) => w.id)) : new Set();
    const isWished = (id) => wished.has(id);
    if (criteria.source && criteria.source !== "me") {
      const friend = friendCache.get(criteria.source.toLowerCase());
      const needsCollection = criteria.duplicates || criteria.noImage || criteria.gif || (criteria.tags || []).length || criteria.untagged;
      if (criteria.wished && !(friend && needsCollection)) return wishedAtFriend(criteria);
      if (!friend) throw new Error(`Collection de ${criteria.source} pas encore lue : clique sur « Lire sa collection ».`);
      if (friend.tagsMissing && ((criteria.tags || []).length || criteria.untagged)) throw new Error(`Le site n'a pas donné les étiquettes de ${friend.pseudo}.`);
      const result = filterCollection(friend.rows, friend.titles, cardPriceInfo, criteria, (copy) => friend.tags[copy] || [],
        (id) => (id in friend.mine ? friend.mine[id] : owned.get(id)), isWished);
      for (const item of result.items) delete item.sellCopy; // pas mes cartes
      return { ...result, source: `${friend.pseudo} (lue il y a ${ago(Date.now() - friend.at)}, raretés ${friend.rarities.join(", ")})` };
    }
    const collection = await readCollection(false);
    if (collection.tagsError && ((criteria.tags || []).length || criteria.untagged)) throw new Error(`Étiquettes illisibles : ${collection.tagsError}. Relis la collection (onglet Collection).`);
    const cardTags = collection.cardTags || {};
    return filterCollection(collection.rows, collection.titles, cardPriceInfo, criteria, (copy) => cardTags[copy] || [], (id) => owned.get(id), isWished);
  }

  // « Dans ma liste de souhaits » chez un ami : on part de mes souhaits et on regarde lesquels il a (friendOwners du
  // catalogue), sans lire sa collection. Si elle a été lue, elle dit en plus quels exemplaires sont des favoris.
  async function wishedAtFriend(criteria) {
    const pseudo = String(criteria.source);
    const { owners, given } = await readWishOwners(false);
    if (!given) throw new Error(`Le site n'a pas dit lesquels de tes amis ont tes souhaits : clique sur « Lire sa collection ».`);
    const titles = Object.fromEntries((await readWishlist(false)).map((w) => [w.id, w.title]));
    const rows = [];
    const unsure = new Set();
    for (const [id, list] of Object.entries(owners)) {
      const own = list.filter((o) => o.username.toLowerCase() === pseudo.toLowerCase());
      const [view] = wishOwners(own, friendRowsOf(id));
      if (!view) continue;
      if (view.status === "unknown") unsure.add(id);
      // Rareté inconnue : une ligne quand même, « ? » (le site n'a dit que le pseudo).
      for (const rarity of view.rarities.length ? view.rarities : ["?"]) rows.push([`${id}|${rarity}`, id, rarity, 1, view.status === "locked" ? 1 : 0, 0, 1]);
    }
    const priceInfo = (id, rarity) => (rarity === "?" ? { state: "unknown" } : cardPriceInfo(id, rarity));
    const result = filterCollection(rows, titles, priceInfo, { ...criteria, wished: false }, () => [], (id) => owned.get(id));
    for (const item of result.items) {
      delete item.sellCopy;
      item.copies = null; // le catalogue ne dit pas combien
      item.unsure = unsure.has(item.id);
    }
    const age = ago(Date.now() - wishOwnersCache.at);
    return { ...result, source: `${pseudo} : tes souhaits qu'il ou elle a (catalogue du site, lu il y a ${age}, sans lire sa collection)`, unsure: unsure.size };
  }

  // Mes enchères au marché (onglet Enchères) : la route que le site appelle sur sa page Marché, onglet « Mes
  // enchères », avec les mêmes paramètres. Gardée 20 s : le panneau rafraîchit toutes les 5 s.
  let mineCache = null;
  let mineReading = null;
  function readMarketMine(force) {
    if (!force && mineCache && Date.now() - mineCache.at < 20e3) return Promise.resolve(mineCache);
    mineReading ||= fetchMarketMine().finally(() => { mineReading = null; });
    return mineReading;
  }
  async function fetchMarketMine() {
    const response = await siteFetch(`${location.origin}/api/marketplace?page=1&limit=50&sort=recent&mine=1`, { credentials: "include" });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(siteLimit(response.status, body) ? "le site limite les lectures : réessaie dans quelques minutes" : `marché refusé par le site (HTTP ${response.status})`);
    }
    const data = await response.json();
    const access = await store.get(SUPABASE_KEY, null);
    const me = access ? (await session(access.base).catch(() => ({}))).userId || "" : "";
    // Solde de WikiBidous : la route de la pastille du site.
    const wallet = await siteFetch(`${location.origin}/api/wikibidous`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const balance = wallet && Number.isFinite(Number(wallet.balance)) ? Number(wallet.balance) : null;
    mineCache = { at: Date.now(), balance, ...myMarketIn(data, me) };
    return mineCache;
  }

  // ------------------------------------------------------------------ onglet Page : selon la page ouverte du site
  const titleOf = (id) => {
    for (const entry of seen.values()) if (entry.id === id) return entry.title;
    return "";
  };
  const byPriceDesc = (a, b) => (b.price ?? -1) - (a.price ?? -1);

  // Fiche d'une carte ouverte : ceux de mes amis qui l'ont (catalogue du site, champ friendOwners) et ses prochaines
  // enchères (marché, tri « Fin proche », comme le site). Deux requêtes par carte, gardées 5 min ; lancées en
  // arrière-plan, le panneau les affiche au rafraîchissement suivant.
  const sheetCache = new Map(); // carte -> { at, loading, friends, friendsGiven, auctions, error }
  function sheetInfo(id, title) {
    const known = sheetCache.get(id);
    if (known && (known.loading || Date.now() - known.at < 5 * 60e3)) return known;
    const out = { at: Date.now(), loading: true, friends: null, friendsGiven: false, auctions: null, error: "" };
    sheetCache.set(id, out);
    (async () => {
      const q = encodeURIComponent(title.slice(0, 80));
      const get = async (url) => {
        const response = await siteFetch(url, { credentials: "include" });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(siteLimit(response.status, body) ? "le site limite les lectures : réessaie plus tard" : `HTTP ${response.status}`);
        }
        return response.json();
      };
      // Le catalogue cherche un morceau du titre, par ordre alphabétique : la carte n'est pas forcément en page 1.
      for (let page = 1; page <= 3 && out.friends === null; page++) {
        if (page > 1) await sleep(800);
        const data = await get(`${location.origin}/api/cards?page=${page}&sort=rarity&q=${q}`);
        note(data);
        noteOwnership("/api/cards", data);
        out.friendsGiven ||= Boolean(data && data.friendOwners);
        if (cardsIn(data).some((c) => c.id === id)) out.friends = wishOwners(friendOwnersIn(data)[id] || [], friendRowsOf(id));
        if (!(Array.isArray(data && data.cards) && data.cards.length >= 50)) break;
      }
      await sleep(500);
      const market = await get(`${location.origin}/api/marketplace?page=1&limit=50&sort=ending_soon&q=${q}`);
      out.auctions = auctionsIn(market).filter((a) => a.cardId === id && a.endAt > Date.now()).slice(0, 10)
        .map((a) => ({ rarity: a.rarity, shiny: a.shiny, bid: minBid(a), endAt: a.endAt, quote: a.shiny ? null : cardPrice(a.cardId, a.rarity) }));
    })().catch((error) => {
      out.error = String((error && error.message) || error);
    }).finally(() => {
      out.loading = false;
      out.at = Date.now();
    });
    return out;
  }

  // Un ami (son profil ouvert, ou l'offre d'échange en cours avec lui) : ses cartes de ma liste de souhaits qu'il peut
  // m'échanger, et mes doublons qu'il n'a pas (si sa collection a été lue, onglet Filtres).
  async function friendContext(name) {
    const lower = name.toLowerCase();
    const friends = await readFriends().catch(() => []);
    const out = { pseudo: name, isFriend: friends.some((n) => n.toLowerCase() === lower), wishes: null, doubles: null, read: null };
    if (!out.isFriend) return out;
    const stale = !wishOwnersCache || Date.now() - wishOwnersCache.at > 30 * 60e3;
    if (stale && !(wishOwnersError && Date.now() - wishOwnersTried < 5 * 60e3)) readWishOwners(false).catch(() => {});
    if (wishOwnersCache && wishOwnersCache.given) {
      const titles = Object.fromEntries((wishCache ? wishCache.wishes : []).map((w) => [w.id, w.title]));
      out.wishes = [];
      for (const [id, list] of Object.entries(wishOwnersCache.owners)) {
        const [v] = wishOwners(list.filter((o) => o.username.toLowerCase() === lower), friendRowsOf(id));
        if (!v || v.status === "locked") continue;
        const prices = v.rarities.map((r) => cardPrice(id, r)).filter(Boolean).map((p) => p.avg);
        out.wishes.push({ id, title: titles[id] || titleOf(id) || id, rarities: v.rarities, status: v.status, price: prices.length ? Math.min(...prices) : null });
      }
      out.wishes.sort(byPriceDesc);
    }
    const f = friendCache.get(lower);
    const col = await store.get(COLLECTION_KEY, null);
    if (f && col) {
      const his = new Set(f.rows.map((r) => r[1]));
      const mine = new Map(); // carte -> { copies, free: rareté d'un exemplaire ni favori ni shiny }
      for (const [, id, rarity, count, starred, shiny] of col.rows) {
        const m = mine.get(id) || mine.set(id, { copies: 0, free: "" }).get(id);
        m.copies += count;
        if (!starred && !shiny && (!m.free || rank(rarity) < rank(m.free))) m.free = rarity;
      }
      out.doubles = [...mine].filter(([id, m]) => m.copies >= 2 && m.free && !his.has(id))
        .map(([id, m]) => { const p = cardPrice(id, m.free); return { id, title: col.titles[id] || id, rarity: m.free, copies: m.copies, price: p ? p.avg : null }; })
        .sort(byPriceDesc).slice(0, 30);
      out.read = { at: f.at, rarities: f.rarities };
    }
    return out;
  }

  // Succès : leurs titres (table achievements de la base du site, lue une fois).
  let achievementTitles = null;
  async function readAchievementTitles() {
    if (achievementTitles) return achievementTitles;
    const access = await store.get(SUPABASE_KEY, null);
    if (!access) return {};
    const { token } = await session(access.base);
    const response = await fetch(`${access.base}achievements?select=code,title,description`, {
      credentials: "omit", headers: { apikey: access.apikey, authorization: `Bearer ${token}` },
    });
    if (!response.ok) return {};
    const list = await response.json();
    achievementTitles = Object.fromEntries((Array.isArray(list) ? list : []).filter((a) => a && a.code).map((a) => [a.code, { title: String(a.title || a.code), description: String(a.description || "") }]));
    return achievementTitles;
  }

  // Fiche de carte ouverte : une fenêtre du site dont un titre est celui d'une carte connue. Le site relit l'historique
  // d'une carte à l'ouverture de sa fiche (sauf dans les 10 min, il le garde) : la dernière lue départage plusieurs titres.
  function openSheet() {
    if (tradeWindow()) return null;
    const found = new Map();
    for (const modal of document.querySelectorAll(MODAL)) {
      for (const heading of modal.querySelectorAll("h1, h2, h3")) {
        const entry = seen.get(norm(heading.textContent));
        if (entry) found.set(entry.id, entry.title);
      }
    }
    const id = lastSheet && found.has(lastSheet.id) ? lastSheet.id : found.size === 1 ? [...found.keys()][0] : null;
    return id ? { id, title: found.get(id) } : null;
  }

  async function panelPage() {
    const path = location.pathname;
    const kind = path.startsWith("/pulls") ? "pulls" : path.startsWith("/collection") ? "collection"
      : /^\/marketplace\/[^/]+/.test(path) ? "auction" : onMarket() ? "market"
      : /^\/profile\/[^/]+/.test(path) ? "profile" : path.startsWith("/achievements") ? "achievements"
      : path.startsWith("/guild") ? "guild" : path.startsWith("/trades") ? "trades" : "other";
    const out = { kind, packs: siteProfile ? { ...packState(siteProfile.data), at: siteProfile.at } : null };
    const withPrice = (c) => ({ ...c, price: c.shiny ? null : priceOf(c, true) });
    const unique = [...new Map(pageCards.map((c) => [`${c.id}|${c.rarity}|${c.shiny ? 1 : 0}`, withPrice(c)])).values()];
    const wished = new Set(wishCache ? wishCache.wishes.map((w) => w.id) : []);

    if (kind === "pulls" && lastPack) {
      out.pack = { at: lastPack.at, cards: lastPack.cards.map((c) => ({ copy: c.copy, title: c.title, rarity: c.rarity, shiny: c.shiny,
        wasOwned: c.wasOwned, discarded: c.discarded, price: withPrice(c).price })) };
    }
    if (kind === "collection") {
      const col = await store.get(COLLECTION_KEY, null);
      const copies = new Map();
      if (col) for (const r of col.rows) copies.set(r[1], (copies.get(r[1]) || 0) + r[3]);
      out.collection = {
        known: Boolean(col),
        doubles: unique.filter((c) => (copies.get(c.id) || 0) >= 2).map((c) => ({ ...c, copies: copies.get(c.id) })).sort(byPriceDesc).slice(0, 20),
        unpriced: unique.filter((c) => !c.shiny && c.price === null).map((c) => c.id),
        top: unique.filter((c) => c.price !== null).sort(byPriceDesc).slice(0, 5),
      };
    }
    if (kind === "market") {
      const ids = new Set(unique.map((c) => c.id));
      const wishes = [];
      for (const a of auctions.values()) {
        if (!ids.has(a.cardId) || !wished.has(a.cardId) || !(a.endAt > Date.now())) continue;
        wishes.push({ title: a.title, rarity: a.rarity, shiny: a.shiny, bid: minBid(a), endAt: a.endAt, quote: a.shiny ? null : cardPrice(a.cardId, a.rarity) });
      }
      let mine;
      try {
        const m = await readMarketMine(false);
        mine = { bidding: m.bidding.map((a) => ({ title: a.title, rarity: a.rarity, shiny: a.shiny, price: a.price, leading: a.leading, endAt: a.endAt })),
          selling: m.selling.length, max: m.max };
      } catch (error) {
        mine = { error: String((error && error.message) || error) };
      }
      out.market = { deals: auctionDeals().filter((d) => ids.has(d.cardId)), wishes: wishes.sort((a, b) => a.endAt - b.endAt), wishesKnown: Boolean(wishCache), mine };
    }
    const friendName = shownDraft ? shownDraft.friend : kind === "profile" ? decodeURIComponent(path.split("/")[2] || "") : "";
    if (friendName) out.friend = await friendContext(friendName).catch(() => null);
    if (kind === "profile") out.showcase = { value: shownValue, tiles: shownTiles };
    const sheet = openSheet();
    if (sheet) {
      const { id, title } = sheet;
      {
        const info = sheetInfo(id, title);
        out.sheet = { title, wished: wished.has(id), owned: owned.get(id), loading: info.loading, friends: info.friends,
          friendsGiven: info.friendsGiven, auctions: info.auctions, error: info.error };
      }
    }
    if (kind === "achievements" && achievementProgress) {
      const titles = await readAchievementTitles().catch(() => ({}));
      out.achievements = { at: achievementProgress.at, items: achievementProgress.progress
        .filter((p) => p && p.code && Number(p.target) > 0)
        .map((p) => ({ code: String(p.code), current: Number(p.current) || 0, target: Number(p.target), ...(titles[p.code] || { title: String(p.code), description: "" }) }))
        .sort((a, b) => b.current / b.target - a.current / a.target) };
    }
    return out;
  }

  // Chaque enchère avec la cote de sa carte dans sa rareté (prix manquants demandés en arrière-plan).
  async function panelMarket(force) {
    const m = await readMarketMine(force);
    const quoted = (a) => {
      if (a.shiny) return { ...a, quote: null };
      if (!usable(prices[a.cardId])) want(a.cardId, "background", a.rarity);
      return { ...a, quote: cardPrice(a.cardId, a.rarity) };
    };
    return { at: m.at, max: m.max, balance: m.balance, selling: m.selling.map(quoted), bidding: m.bidding.map(quoted),
      won: m.won.slice(0, 15).map(quoted), history: m.history.slice(0, 15).map(quoted) };
  }

  // Étiquettes pour les filtres : les miennes (lues avec la collection) ou celles d'un ami lu. -> { id: nom }
  async function panelTags(source) {
    if (source && source !== "me") {
      const friend = friendCache.get(String(source).toLowerCase());
      return { tags: friend ? friend.tagNames : {}, tagsError: !friend ? "" : friend.tagsMissing ? "le site ne les donne pas" : "" };
    }
    const c = await readCollection(false);
    return { tags: c.tags || {}, tagsError: c.tagsError || "" };
  }

  // Mes amis (#51) : la route de la page Amis du site, amitiés acceptées. -> [pseudo], par ordre alphabétique.
  let friendsList = null;
  async function readFriends() {
    if (friendsList && Date.now() - friendsList.at < 30 * 60e3) return friendsList.names;
    const response = await siteFetch(`${location.origin}/api/friends`, { credentials: "include" });
    if (!response.ok) throw new Error(`Liste d'amis refusée par le site (HTTP ${response.status})`);
    const data = await response.json();
    const list = (data && Array.isArray(data.friendships) ? data.friendships : []).filter((f) => f && f.status === "accepted");
    // Moi : d'après la session ; sinon, le joueur présent dans toutes les amitiés.
    let me = "";
    const access = await store.get(SUPABASE_KEY, null);
    if (access) me = (await session(access.base).catch(() => ({}))).userId || "";
    if (!me && list.length > 1) {
      const seenIds = new Map();
      for (const f of list) for (const p of [f.requester, f.addressee]) if (p && p.id) seenIds.set(p.id, (seenIds.get(p.id) || 0) + 1);
      me = [...seenIds].find(([, n]) => n === list.length)?.[0] || "";
    }
    const names = list.map((f) => (f.requester && f.requester.id === me ? f.addressee : f.requester))
      .filter((p) => p && p.username && p.id !== me).map((p) => String(p.username))
      .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
    friendsList = { at: Date.now(), names };
    return names;
  }

  // Collection d'un autre joueur (#51), par la route de son profil, comme le site quand on la fait défiler : 50
  // exemplaires par page, une page par seconde, 60 pages au plus, seulement les raretés choisies. Gardée 12 h. La
  // lecture continue dans l'onglet du site quand le panneau change d'onglet ; friendReading dit où elle en est.
  const friendCache = new Map(); // pseudo en minuscules -> { pseudo, at, rarities, rows, titles, mine, tags, tagNames }
  let friendReading = null; // { pseudo, pages, copies, promise }
  async function readFriend(pseudo, rarities) {
    const name = String(pseudo || "").trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error("Pseudo invalide.");
    const wanted = (Array.isArray(rarities) && rarities.length ? rarities : ["L", "UR", "SR"]).filter((r) => rank(r) >= 0);
    const known = friendCache.get(name.toLowerCase());
    if (known && Date.now() - known.at < COLLECTION_TTL_MS && wanted.every((r) => known.rarities.includes(r))) return known;
    if (friendReading) {
      if (friendReading.pseudo.toLowerCase() === name.toLowerCase()) return friendReading.promise;
      throw new Error(`Lecture de la collection de ${friendReading.pseudo} en cours : attends la fin.`);
    }
    const reading = { pseudo: name, pages: 0, copies: 0, promise: null };
    reading.promise = (async () => {
      const all = { rows: [], titles: {}, mine: {}, tags: {}, tagNames: {}, tagsSeen: false };
      for (const rarity of wanted) {
        for (let page = 1; reading.pages < 60; page++) {
          if (reading.pages) await sleep(1000);
          reading.pages += 1;
          const response = await siteFetch(`${location.origin}/api/profile/${encodeURIComponent(name)}/collection?page=${page}&sort=rarity&stats=0&rarity=${rarity}`, { credentials: "include" });
          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(siteLimit(response.status, body) ? "le site limite les lectures : réessaie plus tard" : `HTTP ${response.status}`);
          }
          const data = await response.json();
          const part = friendRows(data);
          all.rows.push(...part.rows);
          Object.assign(all.titles, part.titles);
          Object.assign(all.mine, part.mine);
          Object.assign(all.tags, part.tags);
          Object.assign(all.tagNames, part.tagNames);
          all.tagsSeen ||= part.tagsSeen;
          reading.copies = all.rows.length;
          noteOwnership(`/api/profile/${name}/collection`, data);
          if (!data || !Array.isArray(data.collection) || data.collection.length < 50) break;
        }
      }
      const { tagsSeen, ...rest } = all;
      const result = { pseudo: name, at: Date.now(), rarities: wanted, ...rest, tagsMissing: !tagsSeen, truncated: reading.pages >= 60 };
      friendCache.set(name.toLowerCase(), result);
      return result;
    })().finally(() => {
      friendReading = null;
    });
    friendReading = reading;
    return reading.promise;
  }

  const friendStatus = () => ({
    reading: friendReading && { pseudo: friendReading.pseudo, pages: friendReading.pages, copies: friendReading.copies },
    known: [...friendCache.values()].map((f) => ({ pseudo: f.pseudo, at: f.at, copies: f.rows.length, rarities: f.rarities })),
  });

  // Mise en vente d'un exemplaire de ma collection, sur clic du joueur dans le panneau (après confirmation) : la même
  // requête que le formulaire « Mettre aux enchères » du site, avec l'identifiant de l'exemplaire (user_cards.id).
  // Jamais réessayée : sans réponse, la vente a peut-être eu lieu.
  const DURATIONS = [10, 30, 60, 180, 360, 720];
  async function sellCopy(copy, base, minutes) {
    const amount = Math.round(Number(base));
    if (!/^[\w-]{1,64}$/.test(String(copy))) throw new Error("Exemplaire inconnu.");
    if (!(amount >= 1)) throw new Error("Prix de départ : au moins 1 WB.");
    if (!DURATIONS.includes(Number(minutes))) throw new Error("Durée inconnue.");
    const collection = await store.get(COLLECTION_KEY, null);
    const row = collection && collection.rows.find((r) => r[0] === String(copy));
    if (!row) throw new Error("Exemplaire introuvable dans ta collection : relis-la.");
    if (row[4]) throw new Error("Favori : le site ne le met pas en vente (retire-le des favoris d'abord).");
    const response = await siteFetch(`${location.origin}/api/marketplace`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ card_id: String(copy), base_amount: amount, duration_minutes: Number(minutes) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data && data.error)) {
      if (data && (data.human_verification_required || data.code === "human_verification_required")) throw new Error("Le site demande une vérification : fais-la sur le site, puis réessaie.");
      throw new Error((data && (data.error || data.message)) || `Refusé par le site (HTTP ${response.status})`);
    }
    // Exemplaire parti : retiré de la collection gardée (un de moins s'il en comptait plusieurs).
    const rows = collection.rows.flatMap((r) => (r[0] !== String(copy) ? [r] : r[3] > 1 ? [[...r.slice(0, 3), r[3] - 1, ...r.slice(4)]] : []));
    await store.set(COLLECTION_KEY, { ...collection, rows });
    return { auction: data && data.auction_id };
  }

  async function panelSummary(refresh) {
    const collection = await readCollection(refresh);
    startSharedFill(refresh);
    const summary = collectionSummary(collection.rows, collection.titles, cardPrice);
    const history = addDailyValue(await store.get(VALUE_KEY, {}), new Date().toISOString().slice(0, 10), summary.value);
    store.set(VALUE_KEY, history);
    const missing = {};
    for (const [, cardId, rarity, , , shiny] of collection.rows) {
      if (!shiny && !cardPrice(cardId, rarity)) (missing[rarity] ||= new Set()).add(cardId);
    }
    return {
      at: collection.at, summary: { ...summary, duplicates: summary.duplicates.slice(0, 300) }, history,
      missing: Object.fromEntries(Object.entries(missing).map(([r, set]) => [r, set.size])),
      waiting: queue.size,
      sharedFill: sharedFill.text,
    };
  }

  // Prix manquants des raretés choisies : mis en file après les cartes affichées (priorité « background »), les plus
  // rares d'abord. Le cache partagé est consulté avant chaque lecture.
  async function loadMissingPrices(rarities) {
    const collection = await readCollection(false);
    const wanted = new Set(rarities);
    const cards = collection.rows.filter(([, cardId, rarity, , , shiny]) => !shiny && wanted.has(rarity) && !cardPrice(cardId, rarity))
      .sort((a, b) => rank(b[2]) - rank(a[2]));
    const done = new Set();
    for (const [, cardId, rarity] of cards) {
      if (done.has(cardId)) continue;
      done.add(cardId);
      want(cardId, "background", rarity);
    }
    return done.size;
  }

  // Les 5 dernières ventes lues par le site lui-même (onglet Marché d'une fiche) : sans rareté demandée et moins de 5
  // ventes en tout, c'est toute l'histoire de la carte, et donc son prix, sans requête de plus.
  async function fromSiteSales(url, data) {
    const match = /\/api\/marketplace\/cards\/([^/?#]+)\/sales/.exec(String(url));
    if (!match || new URL(String(url), location.origin).searchParams.get("rarity") || !salesComplete(data)) return;
    await ready;
    const id = decodeURIComponent(match[1]);
    const mine = prices[id];
    if (mine && !mine.failed && Date.now() - mine.at < 60e3) return;
    remember(id, historyFromSales(data.recent), Date.now());
    queue.delete(id);
    savePricesSoon();
    scheduleBadges();
  }

  // ------------------------------------------------------------------ images Wikipédia (#25, option)
  // Une carte sans image (le site n'en a pas, et ne l'a pas masquée) reçoit la vignette de son article, par l'API publique
  // de Wikipédia (titre seulement, sans cookie). Posée par-dessus l'emplacement de l'image du site, jamais à la place
  // d'une image masquée.
  const wikiImages = new Map(); // titre -> adresse de la vignette, "" si l'article n'en a pas, Promise en cours
  function wikiThumb(entry) {
    const key = entry.url || entry.title;
    if (wikiImages.has(key)) return wikiImages.get(key);
    let lang = "fr";
    let page = entry.title.replace(/ /g, "_");
    const m = /^https:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/.exec(entry.url || "");
    if (m) [lang, page] = [m[1], decodeURIComponent(m[2])];
    const pending = fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}`, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const src = (data && ((data.thumbnail && data.thumbnail.source) || (data.originalimage && data.originalimage.source))) || "";
        const url = /^https:\/\/upload\.wikimedia\.org\//.test(src) ? src : "";
        wikiImages.set(key, url);
        return url;
      }, () => { wikiImages.set(key, ""); return ""; });
    wikiImages.set(key, pending);
    return pending;
  }

  async function fillImage(tile, entry) {
    if (tile.querySelector(".wme-art")) return;
    const biggest = [...tile.querySelectorAll("img")].sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
    const holder = biggest && biggest.parentElement;
    if (!holder) return;
    const url = await wikiThumb(entry);
    if (!url || !holder.isConnected || tile.querySelector(".wme-art")) return;
    if (getComputedStyle(holder).position === "static") holder.style.position = "relative";
    const img = Object.assign(document.createElement("img"), { src: url, alt: "", className: "wme-art", referrerPolicy: "no-referrer" });
    img.title = "Image de l'article Wikipédia (le site n'en a pas)";
    holder.append(img);
  }

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
    pageCards = tiles.map(([tile, entry]) => ({ id: entry.id, title: entry.title, ...pickKeys(tileRarity(tile, entry), ["rarity", "shiny"]) }));
    drawTrades(tiles);
    drawTradeDraft(tiles);
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
    // Nouvelle ou doublon : d'après la possession connue avant ce paquet (exacte depuis la lecture de la collection).
    const cards = cardsIn(event.data.data).map((c) => ({ ...c, isNew: owned.has(c.id) ? !owned.get(c.id) : undefined }));
    for (const c of cards) owned.set(c.id, true);
    pullLog = addPull(pullLog, { at: Date.now(), auto, cards }, PULLS_MAX);
    store.set(PULLS_KEY, pullLog);
    for (const c of cards) if (!c.shiny) want(c.id, "urgent", c.rarity);
    // Le paquet avec ses exemplaires, pour la défausse (onglet Page sur /pulls, et la défausse automatique).
    const wasOwned = new Map(cards.map((c) => [c.id, c.isNew === undefined ? undefined : !c.isNew]));
    lastPack = { at: Date.now(), cards: packCardsIn(event.data.data).map((c) => ({ ...c, wasOwned: wasOwned.get(c.id), discarded: false })) };
    if (Number.isFinite(Number(event.data.data && event.data.data.packs_remaining)) && siteProfile) {
      siteProfile = { at: siteProfile.at, data: { ...siteProfile.data, packs_remaining: Number(event.data.data.packs_remaining), last_normal_pack_opened_at: new Date().toISOString() } };
    }
    autoDiscard(lastPack).catch(() => {});
  });

  // ------------------------------------------------------------------ défausse (une carte contre 1 WikiBidou)
  // La requête du récapitulatif de paquet du site : POST /api/user-cards/{exemplaire}/discard, sans corps. Une à la
  // fois, 0,8 s d'écart ; arrêt au premier refus (vérification humaine, carte engagée…). Jamais un favori : une carte
  // qui sort d'un paquet n'en est pas un, et la défausse à la main ne vise que le dernier paquet.
  let lastPack = null; // { at, cards: [{ id, title, rarity, shiny, copy, wasOwned, discarded }] }
  let discardLog = []; // dernières défausses : [{ at, title, rarity, price, auto }]
  let discarding = Promise.resolve();
  function discardCards(list, auto) {
    const run = discarding.then(async () => {
      let done = 0;
      for (const c of list) {
        if (c.discarded) continue;
        if (done) await sleep(800);
        const response = await siteFetch(`${location.origin}/api/user-cards/${encodeURIComponent(c.copy)}/discard`, { method: "POST", credentials: "include" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || (data && data.error)) {
          if (data && (data.human_verification_required || data.code === "human_verification_required")) throw new Error("le site demande une vérification : fais-la sur le site");
          throw new Error((data && (data.error || data.message)) || `refusée par le site (HTTP ${response.status})`);
        }
        c.discarded = true;
        done += 1;
        if (c.wasOwned === false && !list.some((o) => o !== c && o.id === c.id && !o.discarded)) owned.set(c.id, false);
        discardLog = [{ at: Date.now(), title: c.title, rarity: c.rarity, price: priceOf(c, true), auto }, ...discardLog].slice(0, 30);
      }
      if (done) window.dispatchEvent(new CustomEvent("wikimasters:wikibidous-balance-refresh")); // le site relit son solde
      return done;
    });
    discarding = run.catch(() => {});
    return run;
  }

  // Défausse automatique (réglée dans l'onglet Paquets, coupée par défaut) : les cartes du paquet qui répondent aux
  // règles. Avec un prix maximum, une carte sans prix attend sa lecture (lancée à l'ouverture), 2 min au plus.
  let discardError = "";
  async function autoDiscard(pack) {
    const rules = settings.autoDiscard;
    if (!rules || !rules.on) return;
    let cards = pack.cards;
    for (let round = 0; round < 13 && cards.length; round++) {
      if (round) await sleep(10e3);
      // Les cartes en attente ont déjà passé la règle des doublons au premier tour : seul leur prix reste à voir.
      const { discard, wait } = discardPicks(cards, round ? { ...rules, duplicatesOnly: false } : rules,
        (id) => pack.cards.find((c) => c.id === id).wasOwned, (c) => priceOf(c, true));
      if (discard.length) {
        try {
          await discardCards(discard, true);
          discardError = "";
        } catch (error) {
          discardError = String((error && error.message) || error);
          return;
        }
      }
      cards = wait;
    }
  }

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

  // Enchères vues sur le marché, avec leur écart à la cote (onglet Enchères du panneau) : bonnes affaires et surcotées,
  // seulement avec un prix fiable, les plus proches de leur fin d'abord.
  function auctionDeals() {
    const now = Date.now();
    const out = [];
    for (const a of auctions.values()) {
      if (!(a.endAt > now)) continue;
      const entry = prices[a.cardId];
      const q = usable(entry) && !entry.failed ? entry.q[a.rarity] : null;
      const deal = q ? auctionDeal(a, q.avg, reliable(q, settings.minWeekSales), now) : null;
      if (deal) out.push({ cardId: a.cardId, title: a.title, rarity: a.rarity, price: q.avg, bid: minBid(a), endAt: a.endAt, ...deal });
    }
    return out.sort((x, y) => x.endAt - y.endAt).slice(0, 50);
  }

  // Plusieurs onglets du site ouverts : chacun garde le journal à jour quand un autre l'écrit.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const pause = changes[PAUSE_KEY] && changes[PAUSE_KEY].newValue;
    if (pause && pause.until > pausedUntil) [pausedUntil, pauseReason] = [pause.until, pause.reason || ""];
    if (changes[ROUTE_PAUSE_KEY]) applyRoutePauses(changes[ROUTE_PAUSE_KEY].newValue);
    if (changes[SLOW_KEY]) slowUntil = Math.max(slowUntil, Number(changes[SLOW_KEY].newValue) || 0);
    if (changes[LIMITS_KEY]) limitLog = changes[LIMITS_KEY].newValue || [];
    if (changes[PULLS_KEY]) pullLog = changes[PULLS_KEY].newValue || emptyPullLog();
    if (changes[PULL_BASELINE_KEY]) pullBaselineEntry = changes[PULL_BASELINE_KEY].newValue || null;
    if (changes[SHARED_KEY]) applySharedConfig(changes[SHARED_KEY].newValue);
  });

  // ------------------------------------------------------------------ panneau de l'extension (src/panel.js)
  // Le panneau ouvert par l'icône vit dans le monde de l'extension : il ne voit pas la page. Il demande donc l'état à
  // ce script par chrome.tabs.sendMessage, et lui transmet les réglages (badges, seuil, ordre, automatisation).
  // clickInfo est lu depuis src/click.js via window.__wmeClickState(), car les deux scripts partagent le même
  // monde isolé (« document_idle »).
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "panel") {
      // Panneau latéral (src/panel.js) : réponse asynchrone.
      const work = message.action === "loadPrices" ? loadMissingPrices(Array.isArray(message.rarities) ? message.rarities : [])
        .then((count) => ({ ok: true, count }))
        : message.action === "filter" ? panelFilter(message.criteria).then((data) => ({ ok: true, ...data }))
        : message.action === "friends" ? readFriends().then((names) => ({ ok: true, names }))
        : message.action === "friendStatus" ? Promise.resolve({ ok: true, ...friendStatus() })
        : message.action === "sell" ? sellCopy(message.copy, message.base, message.minutes).then((r) => ({ ok: true, ...r }))
        : message.action === "loadCardPrices" ? Promise.resolve((message.ids || []).slice(0, 5000).forEach((id) => want(String(id), "background")))
          .then(() => ({ ok: true }))
        : message.action === "tags" ? panelTags(message.source).then((t) => ({ ok: true, ...t }))
        : message.action === "friendRead" ? readFriend(message.pseudo, message.rarities)
          .then((f) => ({ ok: true, pseudo: f.pseudo, copies: f.rows.length, truncated: f.truncated }))
        : message.action === "wishlist" ? panelWishlist(Boolean(message.refresh)).then((data) => ({ ok: true, ...data }))
        : message.action === "loadWishPrices" ? loadWishPrices().then((count) => ({ ok: true, count }))
        : message.action === "market" ? panelMarket(Boolean(message.refresh)).then((data) => ({ ok: true, ...data }))
        : message.action === "page" ? panelPage().then((data) => ({ ok: true, ...data }))
        : message.action === "discard" ? (lastPack ? discardCards(lastPack.cards.filter((c) => (message.copies || []).includes(c.copy)), false)
          : Promise.reject(new Error("Aucun paquet ouvert depuis le chargement de la page."))).then((count) => ({ ok: true, count }))
          : panelSummary(Boolean(message.refresh)).then((data) => ({ ok: true, ...data }));
      work.catch((error) => ({ ok: false, error: String((error && error.message) || error) })).then(reply);
      return true;
    }
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
    } else if (message.type === "images") {
      settings.images = Boolean(message.on);
      store.set("settings", settings);
      if (!settings.images) document.querySelectorAll(".wme-art").forEach((img) => img.remove());
      drawBadges();
    } else if (message.type === "autoDiscard") {
      const r = message.rules || {};
      const max = Number(r.maxPrice);
      settings.autoDiscard = {
        on: Boolean(r.on), duplicatesOnly: r.duplicatesOnly !== false,
        rarities: (Array.isArray(r.rarities) ? r.rarities : []).map((x) => String(x).toUpperCase()).filter((x) => rank(x) >= 0),
        maxPrice: r.maxPrice !== null && r.maxPrice !== "" && Number.isFinite(max) && max >= 0 ? Math.round(max) : null,
      };
      store.set("settings", settings);
    } else if (message.type === "deals") {
      settings.deals = Boolean(message.on);
      store.set("settings", settings);
      drawBadges();
    } else if (message.type === "minSales") {
      settings.minWeekSales = Math.min(50, Math.max(1, Math.round(Number(message.value)) || MIN_SALES));
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
      store.set(SYNC_KEY, null); // prix oubliés : la prochaine synchronisation reprend tout
      drawBadges();
    }
    const clickInfo = typeof window.__wmeClickState === "function" ? window.__wmeClickState() : null;
    settlePulls();
    reply({
      badges: settings.badges,
      autoClickPack: settings.autoClickPack,
      autoUnblockMarket: settings.autoUnblockMarket,
      minSales: settings.minWeekSales,
      deals: settings.deals,
      images: settings.images,
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
      readBudget: Math.floor(READ_BUDGET * factor()),
      slowUntil,
      trades: shownTrades,
      draft: shownDraft,
      auctionDeals: auctionDeals(),
      shared: { on: sharedOn, ...sharedStats },
      pulls: pullRecap(pullLog, priceOf, (pullBaselineEntry && pullBaselineEntry.counts) || {}),
      autoDiscard: settings.autoDiscard,
      discards: discardLog.slice(0, 10),
      discardError,
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
    slowUntil = Number(await store.get(SLOW_KEY, 0)) || 0;
    for (const [id, flag] of Object.entries(await store.get(OWNED_KEY, {}))) if (!owned.has(id)) owned.set(id, Boolean(flag));
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

  // Thème du site (classe « light » sur <html>, sombre sinon) : le panneau le suit (src/panel.js).
  const noteTheme = () => {
    const theme = document.documentElement.classList.contains("light") ? "light" : "dark";
    store.get(THEME_KEY, "").then((saved) => saved !== theme && store.set(THEME_KEY, theme));
  };
  noteTheme();
  new MutationObserver(noteTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  // Prêt à écouter : src/inject.js renvoie les réponses du site arrivées avant le démarrage de ce script.
  window.postMessage({ source: "wme-content", type: "ready" }, location.origin);
})();
