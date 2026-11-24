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

  const { rank, norm, quotes, reliable, MIN_SALES, RECENT_WEEKS, currentWeek, ownershipIn, SALES_LIMIT, historyFromSales, salesComplete, totalSales, ago, cardsIn, tradesIn, tradeBalance, emptyPullLog, addPull, settlePullPrices, pullBaseline, pullRecap, readBudget, quartiles, auctionsIn, auctionDeal, sessionFromCookies, collectionSummary, filterCollection, wishlistSummary, addDailyValue, countSince, addLimitEvent, siteLimit, wb } = WME;

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
  let settings = { badges: true, autoClickPack: false, autoUnblockMarket: false, minWeekSales: MIN_SALES, ownedMarks: true, collectionOrder: "", deals: true, images: false };
  let prices = {}; // id de carte -> { at, q: { SR: { avg, count, week } }, failed? }
  const seen = new Map(); // titre normalisé -> { id, title, rarities: Set, shiny: bool }
  const owned = new Map(); // id de carte -> true (on l'a) | false (on ne l'a pas), d'après le site (ownershipIn)
  const auctions = new Map(); // « carte|rareté » -> enchère du marché la plus proche de sa fin (auctionsIn), pour #16
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

  // Pastille « ✓ » / « Nouvelle » : pas sur sa propre collection ni sur la Collection globale (le site l'y montre
  // déjà), ni sur la page des paquets (toutes les cartes tirées sont à nous).
  const ownMarks = () => settings.ownedMarks && !/^\/(collection|global-collection|pulls)(\/|$)/.test(location.pathname);

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
  const OURS = ".wme-badge, .wme-trade, .wme-fiche, .wme-art, .wme-draft";

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
        const sure = reliable(q, settings.minWeekSales);
        [text, state, value] = [sure ? wb(q.avg) : `≈ ${wb(q.avg)}`, grey ? "old" : "ok", q.avg];
        // Marché : bonne affaire ou surcoté (#16), d'après la mise minimum de l'enchère affichée.
        const auction = settings.deals && onMarket() ? auctions.get(`${entry.id}|${rarity}`) : null;
        deal = auction && !shiny ? auctionDeal(auction, q.avg, sure) : null;
        const by = entryPrices.by && entryPrices.by !== sharedStats.who ? ` par ${entryPrices.by}` : "";
        const sales = sure ? "" : ` Prix incertain : moins de ${settings.minWeekSales} ventes dans la semaine.`;
        const recent = Number.isFinite(q.sales12) ? ` ${q.sales12} vente(s) sur ${RECENT_WEEKS} semaines.` : "";
        tip = `${entry.title} ${rarity} : ${label}, ${q.count} vente(s).${sales}${recent} ` +
          `Relevé il y a ${ago(Date.now() - entryPrices.at)}${by}.${old}`;
        if (deal) {
          tip += deal.kind === "deal" ? `\nBonne affaire : la mise minimum est ${-deal.pct} % sous la cote, et l'enchère finit bientôt.`
            : `\nSurcoté : la mise minimum dépasse la cote de ${deal.pct} %.`;
        }
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
    el.dataset.deal = deal ? `${deal.pct > 0 ? "+" : "−"}${Math.abs(deal.pct)} %` : "";
    el.dataset.dealKind = deal ? deal.kind : "";
    const own = ownMarks() ? owned.get(entry.id) : undefined;
    el.dataset.own = own === true ? "yes" : own === false ? "no" : "";
    if (own !== undefined) tip += own ? "\nTu as déjà cette carte." : "\nTu n'as pas cette carte.";
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
      // Le bilan, puis (#26) le détail dépliable : chaque carte de chaque côté, titre complet, rareté et prix (le site
      // tronque les noms dans ses offres).
      const details = trade.sides.map((side) => `${side.name} donne : ` + (side.items.length
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
  // choisies de l'onglet ouvert seulement. On retient celles de chaque côté au fil des onglets, et on pose sous la barre
  // ce que tu donnes, ce que tu reçois et l'écart. Repères relevés dans le code de LeadOn/Wikimasters-Toolbox. Lecture
  // seule : l'offre part toujours avec le bouton du site.
  const TRADE_COUNTS = /:\s*([\d\s]+)\s*cartes?(?:\s*·\s*([\d\s]+)\s*wb)?/i;
  let tradeDraft = null; // { modal, friend, mine: [cartes], theirs: [cartes] }
  const countOf = (text) => Number(String(text || "").replace(/\D/g, "")) || 0;

  function tradeWindow() {
    for (const modal of document.querySelectorAll(FICHE_MODAL)) {
      const mineLabel = [...modal.querySelectorAll("span")].find((el) => /^Moi\s*:/.test(el.textContent.trim()));
      const bar = mineLabel && mineLabel.parentElement;
      const theirLabel = bar && [...bar.children].find((el) => el !== mineLabel && el.tagName === "SPAN" && TRADE_COUNTS.test(el.textContent));
      const mineTab = theirLabel && [...modal.querySelectorAll("button")].find((b) => /^Mes cartes/.test(b.textContent.trim()));
      if (!mineTab) continue;
      const active = [...mineTab.parentElement.children].find((b) => b.tagName === "BUTTON" && String(b.className).includes("border-b-2")) || null;
      const heading = [...modal.querySelectorAll("p")].find((p) => /^Sélectionnées\s*\(/.test(p.textContent.trim()));
      return { modal, bar, mineLabel, theirLabel, mineTab, active, friend: theirLabel.textContent.split(":")[0].trim(), selected: heading ? heading.parentElement : null };
    }
    return null;
  }

  function drawTradeDraft(tiles) {
    const w = settings.badges ? tradeWindow() : null;
    if (!w) {
      tradeDraft = null;
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
      for (const c of cards) {
        want(c.id, "urgent", c.rarity);
        const p = priceOf(c, true);
        if (Number.isFinite(p)) value += p;
        else missing += 1;
      }
      return { value, missing, wb: countOf(coins), count: countOf(count), seen: cards.length };
    };
    const give = side(w.mineLabel, tradeDraft.mine);
    const get = side(w.theirLabel, tradeDraft.theirs);
    const total = (s) => s.value + s.wb;
    const gap = total(get) - total(give);
    const pct = total(give) > 0 ? Math.round((gap / total(give)) * 100) : null;
    const unseen = (s, tab) => (s.count > s.seen ? ` (ouvre « ${tab} » pour compter ${s.count - s.seen} carte(s))` : "");
    const lines = [
      `Tu donnes ≈ ${wb(give.value)}${give.wb ? ` + ${wb(give.wb)} WB` : ""}${give.missing ? ` (${give.missing} sans prix)` : ""}${unseen(give, "Mes cartes")}`,
      `Tu reçois ≈ ${wb(get.value)}${get.wb ? ` + ${wb(get.wb)} WB` : ""}${get.missing ? ` (${get.missing} sans prix)` : ""}${unseen(get, `Cartes de ${w.friend}`)}`,
      Math.abs(gap) < 1 ? "Échange équilibré." : `${gap > 0 ? "En ta faveur" : "En sa faveur"} : ≈ ${wb(Math.abs(gap))}${pct !== null ? ` (${gap > 0 ? "+" : "−"}${Math.abs(pct)} % de ce que tu donnes)` : ""}.`,
    ];
    let el = w.bar.nextElementSibling && w.bar.nextElementSibling.classList.contains("wme-draft") ? w.bar.nextElementSibling : null;
    if (!el) {
      el = Object.assign(document.createElement("div"), { className: "wme-draft wme-trade" });
      w.bar.after(el);
    }
    const text = lines.join("\n");
    if (el.dataset.text !== text) {
      el.dataset.text = text;
      el.replaceChildren(...lines.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
      el.dataset.side = gap >= 0 ? "good" : "bad";
    }
    el.title = "Cartes choisies au prix moyen du site, dans leur rareté, plus les WB. Le site ne montre que les cartes de l'onglet ouvert : " +
      "ouvre les deux onglets pour compter les deux côtés. L'offre part toujours avec le bouton du site.";
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
    const complete = cached && (!cached.rows.length || cached.rows[0].length >= 7); // la 0.7 ne gardait pas l'image
    if (!force && complete && Date.now() - cached.at < COLLECTION_TTL_MS) return cached;
    collectionReading ||= (async () => {
      const access = await store.get(SUPABASE_KEY, null);
      if (!access) throw new Error("Accès à la collection pas encore repéré : recharge une page du site, puis réessaie.");
      const { token } = await session(access.base);
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
      const result = { at: Date.now(), rows, titles };
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

  // ------------------------------------------------------------------ fiche d'une carte (#47)
  // Sous le titre de la fenêtre d'une carte, un bloc par rareté vendue : prix (« ≈ » s'il est incertain), ventes de la
  // semaine et des 12 dernières, plus bas et plus haut sur 4 semaines, variation par rapport à la semaine d'avant ; et
  // si on possède la carte. Les chiffres viennent de l'historique que le site lit lui-même en ouvrant la fiche
  // (fromSite) : aucune requête en plus. Repères de la fenêtre relevés dans le code de LeadOn/Wikimasters-Toolbox.
  const FICHE_MODAL = "div.fixed.inset-0";
  const shortDay = (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

  // Petite courbe des moyennes par semaine (#14), en SVG (posé en éléments, jamais en HTML).
  function trendSvg(trend) {
    if (!Array.isArray(trend) || trend.length < 2) return null;
    const values = trend.map(([, avg]) => avg);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 20");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "wme-trend");
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", values.map((v, i) => `${(i / (values.length - 1)) * 100},${18 - ((v - min) / (max - min || 1)) * 16}`).join(" "));
    for (const [k, v] of [["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.5"], ["vector-effect", "non-scaling-stroke"]]) line.setAttribute(k, v);
    const title = document.createElementNS(ns, "title");
    title.textContent = trend.map(([start, avg]) => `${shortDay(start)} : ${wb(avg)}`).join(" · ");
    svg.append(title, line);
    return svg;
  }

  // Les 5 dernières ventes d'une carte, recopiées quand le site les lit (onglet Marché de la fiche) : #15.
  const recentSales = new Map(); // « carte|rareté » -> [prix]
  function fromSiteSales(url, data) {
    const match = /\/api\/marketplace\/cards\/([^/?#]+)\/sales/.exec(String(url));
    if (!match || !data || !Array.isArray(data.recent)) return;
    const id = decodeURIComponent(match[1]);
    const asked = (new URL(String(url), location.origin).searchParams.get("rarity") || "").toUpperCase();
    const groups = {};
    for (const sale of data.recent) {
      const rarity = String((sale && sale.rarity) || asked || "").toUpperCase();
      if (rank(rarity) < 0 || !Number.isFinite(Number(sale.final_price))) continue;
      (groups[rarity] ||= []).push(Number(sale.final_price));
    }
    for (const [rarity, list] of Object.entries(groups)) recentSales.set(`${id}|${rarity}`, list);
    scheduleBadges();
  }

  // Une ligne par rareté vendue : texte, courbe, et médiane des dernières ventes quand le site les a lues.
  function ficheRows(entry) {
    const entryPrices = prices[entry.id];
    if (!entryPrices || !usable(entryPrices)) return { rows: [{ text: "Prix en cours de lecture…" }], age: "" };
    const rows = Object.entries(entryPrices.q).sort(([a], [b]) => rank(b) - rank(a)).map(([rarity, q]) => {
      const sure = reliable(q, settings.minWeekSales);
      const when = q.week >= currentWeek() ? "cette semaine" : `la semaine du ${shortDay(q.week)}`;
      const parts = [`${rarity} ${sure ? "" : "≈ "}${wb(q.avg)}`, `${q.count} vente(s) ${when}`];
      if (Number.isFinite(q.sales12)) parts.push(`${q.sales12} sur 12 sem.`);
      if (Number.isFinite(q.low4) && Number.isFinite(q.high4)) parts.push(`4 sem. : ${wb(q.low4)} – ${wb(q.high4)}`);
      if (Number.isFinite(q.prev) && q.prev > 0) {
        const pct = Math.round((q.avg / q.prev - 1) * 100);
        parts.push(`${pct > 0 ? "+" : ""}${pct} % sur la semaine d'avant`);
      }
      const stats = quartiles(recentSales.get(`${entry.id}|${rarity}`));
      if (stats) parts.push(`${stats.n} dernière(s) vente(s) : médiane ${wb(stats.median)}${stats.n >= 3 ? `, Q1–Q3 ${wb(stats.q1)} – ${wb(stats.q3)}` : ""}`);
      return { text: parts.join(" · "), trend: q.trend };
    });
    if (!rows.length) rows.push({ text: "Jamais vendue." });
    const age = `Relevé il y a ${ago(Date.now() - entryPrices.at)}` +
      (entryPrices.by && entryPrices.by !== sharedStats.who ? ` par ${entryPrices.by}` : "") + ".";
    return { rows, age };
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

  // ↻ (#17) : relit tout de suite le prix de cette carte sur le site (pas le cache partagé), en tête de file.
  function rereadCard(id) {
    delete prices[id];
    refused.delete(id);
    sharedAsked.set(id, Date.now());
    want(id, "urgent");
    savePricesSoon();
    scheduleBadges();
  }

  function drawFiches() {
    for (const modal of document.querySelectorAll(FICHE_MODAL)) {
      const title = modal.querySelector("h2");
      const entry = title && seen.get(norm(title.textContent));
      let block = modal.querySelector(".wme-fiche");
      if (!entry) {
        if (block) block.remove();
        continue;
      }
      want(entry.id, "urgent");
      if (!block) {
        block = document.createElement("div");
        block.className = "wme-fiche";
        const anchor = title.parentElement && title.parentElement !== modal ? title.parentElement : title;
        anchor.after(block);
      }
      const { rows, age } = ficheRows(entry);
      const own = owned.get(entry.id);
      const notes = [age, own === undefined ? "" : own ? "Tu as déjà cette carte." : "Tu n'as pas cette carte."].filter(Boolean);
      const text = [...rows.map((r) => r.text + (r.trend ? r.trend.length : "")), ...notes].join("\n");
      if (block.dataset.text === text) continue;
      block.dataset.text = text;
      const div = (props, ...children) => {
        const el = Object.assign(document.createElement("div"), props);
        el.append(...children.filter(Boolean));
        return el;
      };
      const wiki = entry.url || `https://fr.wikipedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, "_"))}`;
      const reread = Object.assign(document.createElement("button"), { type: "button", className: "wme-link", textContent: "↻ Relire le prix" });
      reread.addEventListener("click", (event) => {
        event.stopPropagation();
        rereadCard(entry.id);
      });
      const link = Object.assign(document.createElement("a"), { href: wiki, target: "_blank", rel: "noopener noreferrer", className: "wme-link", textContent: "Wikipédia ↗" });
      link.addEventListener("click", (event) => event.stopPropagation());
      block.replaceChildren(
        ...rows.map((r) => div({ className: "wme-row" }, div({ textContent: r.text }), trendSvg(r.trend))),
        ...notes.map((line) => div({ className: "wme-note", textContent: line })),
        div({ className: "wme-actions" }, reread, link));
    }
  }

  // ------------------------------------------------------------------ ordre de la collection (#46)
  // Le site revient à l'ordre par rareté à chaque visite de /collection. Avec un ordre choisi dans la fenêtre (« Nom »,
  // « Favoris », « Date d'ajout » : les libellés de son menu), on le sélectionne dans son menu, une fois par visite ;
  // un ordre choisi ensuite à la main est gardé jusqu'à la visite suivante. Repères relevés dans le code de
  // LeadOn/Wikimasters-Toolbox (features/site-dom.js) : bouton « Trier la collection », options role="option".
  const ORDER_BUTTON = 'main button[aria-label="Trier la collection"]';
  const ORDER_TRIES = 3;
  let orderVisit = null; // { wanted, tries, done, busy } pour la visite en cours de /collection

  async function ensureCollectionOrder() {
    if (location.pathname !== "/collection") {
      orderVisit = null;
      return;
    }
    const wanted = settings.collectionOrder || "";
    if (!orderVisit || orderVisit.wanted !== wanted) orderVisit = { wanted, tries: 0, done: false, busy: false };
    const visit = orderVisit;
    const button = document.querySelector(ORDER_BUTTON);
    if (visit.done || visit.busy || !button) return;
    if (!wanted || button.textContent.trim() === wanted) {
      visit.done = true;
      return;
    }
    const openList = () => button.getAttribute("aria-expanded") === "true"
      ? document.getElementById(button.getAttribute("aria-controls") || "") : null;
    let list = openList();
    if (!list) {
      if (visit.tries >= ORDER_TRIES) {
        visit.done = true; // menu qui ne s'ouvre pas : on garde l'ordre du site
        return;
      }
      visit.tries += 1;
      visit.busy = true;
      button.click();
      for (let waited = 0; !list && waited < 1000; waited += 50) {
        await sleep(50);
        list = openList();
      }
      visit.busy = false;
      if (!list || visit !== orderVisit) return; // page quittée ou réglage changé pendant l'attente
    }
    visit.done = true;
    const option = [...list.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === wanted);
    (option || button).click(); // option introuvable (libellé changé par le site) : menu refermé, ordre du site
  }

  function drawBadges() {
    ensureCollectionOrder();
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
    drawFiches();
    const tiles = findTiles();
    pageTiles = new Map();
    for (const [tile, entry] of tiles) (pageTiles.get(entry.id) || pageTiles.set(entry.id, []).get(entry.id)).push(tile);
    shownTiles = tiles.length;
    shownValue = tiles.reduce((sum, [tile, entry]) => sum + badge(tile, entry), 0);
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
        : message.action === "wishlist" ? panelWishlist(Boolean(message.refresh)).then((data) => ({ ok: true, ...data }))
        : message.action === "loadWishPrices" ? loadWishPrices().then((count) => ({ ok: true, count }))
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
    } else if (message.type === "deals") {
      settings.deals = Boolean(message.on);
      store.set("settings", settings);
      drawBadges();
    } else if (message.type === "ownedMarks") {
      settings.ownedMarks = Boolean(message.on);
      store.set("settings", settings);
      drawBadges();
    } else if (message.type === "collectionOrder") {
      settings.collectionOrder = ["Nom", "Favoris", "Date d'ajout"].includes(message.value) ? message.value : "";
      store.set("settings", settings);
      orderVisit = null; // appliqué tout de suite si la collection est affichée
      ensureCollectionOrder();
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
      ownedMarks: settings.ownedMarks,
      deals: settings.deals,
      images: settings.images,
      collectionOrder: settings.collectionOrder,
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

  // Prêt à écouter : src/inject.js renvoie les réponses du site arrivées avant le démarrage de ce script.
  window.postMessage({ source: "wme-content", type: "ready" }, location.origin);
})();
