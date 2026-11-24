// Fonctions « pures » : elles ne touchent ni à la page ni au navigateur, elles transforment des données.
// C'est la partie la plus facile à tester : `npm test` les lance dans Node, sans navigateur (tests/lib.test.js).
//
// Le fichier est chargé deux fois : par le navigateur (content script, il crée la variable globale `WME`) et par
// Node pour les tests (la dernière ligne l'exporte comme un module).
const WME = (() => {
  const RARITIES = ["C", "PC", "R", "SR", "UR", "L"];

  /** Rang d'une rareté (C = 0 … L = 5), -1 si inconnue. */
  const rank = (rarity) => RARITIES.indexOf(String(rarity || "").toUpperCase());

  /** Titre comparable : casse, espaces et accents composés harmonisés (« Napoléon » == « napoléon »). */
  const norm = (s) => String(s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

  /**
   * Prix moyen par rareté, comme le site l'affiche sur la fiche d'une carte : la moyenne de la semaine la plus récente
   * qui a des ventes (« Prix moyen de la semaine », ou « Dernier prix moyen connu » si cette semaine n'a pas encore de
   * vente). Le site le calcule dans le navigateur à partir de /api/marketplace/cards/{id}/price-history ; on refait
   * le même calcul sur la même réponse, pour afficher exactement son chiffre.
   * Format relevé le 22/11 : { computed_at, by_rarity: { "SR": { weekly: [ { start, avg, min, max, count } ] } } }.
   * `sales12` : ventes de la rareté sur les 12 dernières semaines (semaine en cours comprise). `low4` / `high4` : plus
   * bas et plus haut des ventes des 4 dernières semaines (null sans vente) ; `prev` : moyenne de la semaine avec des
   * ventes d'avant celle du prix (null s'il n'y en a pas), pour la variation.
   * -> { "SR": { avg, count, week: "2026-11-16", sales12, low4, high4, prev } }
   */
  function quotes(history, now = new Date()) {
    const from = new Date(`${weekStart(now)}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 7 * (RECENT_WEEKS - 1));
    const cutoff = from.toISOString().slice(0, 10);
    from.setUTCDate(from.getUTCDate() + 7 * (RECENT_WEEKS - 4));
    const cutoff4 = from.toISOString().slice(0, 10);
    const out = {};
    const byRarity = history && history.by_rarity;
    if (!byRarity || typeof byRarity !== "object") return out;
    for (const [rarity, series] of Object.entries(byRarity)) {
      const weekly = series && series.weekly;
      if (rank(rarity) < 0 || !Array.isArray(weekly)) continue;
      const latest = weekly
        .filter((p) => p && Number(p.avg) > 0 && Number(p.count) > 0)
        .sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")))[0];
      if (!latest) continue;
      const sold = weekly.filter((p) => p && Number(p.count) > 0);
      const sales12 = sold.filter((p) => String(p.start || "") >= cutoff).reduce((sum, p) => sum + Number(p.count), 0);
      const recent4 = sold.filter((p) => String(p.start || "") >= cutoff4);
      const lows = recent4.map((p) => Number(p.min ?? p.avg)).filter((n) => Number.isFinite(n) && n > 0);
      const highs = recent4.map((p) => Number(p.max ?? p.avg)).filter((n) => Number.isFinite(n) && n > 0);
      const before = sold.filter((p) => Number(p.avg) > 0 && String(p.start || "") < String(latest.start || ""))
        .sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")))[0];
      // Courbe (#14) : moyennes des semaines avec ventes sur les 12 dernières semaines, de la plus ancienne à la plus récente.
      const trend = sold.filter((p) => String(p.start || "") >= cutoff && Number(p.avg) > 0)
        .sort((a, b) => String(a.start || "").localeCompare(String(b.start || ""))).map((p) => [String(p.start), Number(p.avg)]);
      out[rarity] = {
        avg: Number(latest.avg), count: Number(latest.count), week: String(latest.start || ""), sales12,
        low4: lows.length ? Math.min(...lows) : null, high4: highs.length ? Math.max(...highs) : null,
        prev: before ? Number(before.avg) : null, trend,
      };
    }
    return out;
  }

  /** Semaines prises en compte pour juger un prix (comme Toolbox : 12, semaine en cours comprise). */
  const RECENT_WEEKS = 12;
  /** Seuil par défaut : un prix est fiable s'il repose sur au moins 5 ventes dans la semaine (réglable). */
  const MIN_SALES = 5;

  /**
   * Prix fiable ? Le prix affiché est la moyenne d'une semaine : il est fiable si cette semaine compte au moins
   * `minSales` ventes (`count`). Sinon le badge l'affiche « ≈ ».
   */
  const reliable = (q, minSales = MIN_SALES) => Boolean(q && Number(q.count) >= minSales);

  // Semaines du site : elles commencent le lundi, jour calendaire de Paris (relevé par LeadOn/Wikimasters-Toolbox,
  // core/prices.js : c'est la clé `start` de price-history). Les mois aussi suivent le calendrier de Paris.
  const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
  const parisDay = (date) => PARIS_DAY.format(date); // « 2026-11-24 »
  function weekStart(date) {
    const d = new Date(`${parisDay(date)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  /** Lundi (Paris) de la semaine en cours, « 2026-11-23 » : une cote d'une semaine plus ancienne est « reportée ». */
  const currentWeek = (now = new Date()) => weekStart(now);

  /** La route /sales renvoie au plus SALES_LIMIT ventes : en dessous, ce sont toutes les ventes de la carte. */
  const SALES_LIMIT = 5;

  /**
   * Historique au format de price-history, reconstitué à partir des ventes de /api/marketplace/cards/{id}/sales
   * (`recent: [{ final_price, settled_at, rarity }]`, toutes raretés). Exact seulement si la liste est complète
   * (moins de SALES_LIMIT ventes, `salesComplete`) : c'est alors toute l'histoire de la carte. Même découpage que le
   * site (semaines et mois de Paris), moyennes arrondies comme lui. Méthode de LeadOn/Wikimasters-Toolbox.
   * -> { computed_at, by_rarity: { R: { weekly: [{ start, avg, min, max, count }], monthly: [...] } } }
   */
  function historyFromSales(recent, now = Date.now()) {
    const byRarity = {};
    for (const sale of Array.isArray(recent) ? recent : []) {
      const rarity = String((sale && sale.rarity) || "").toUpperCase();
      const price = Number(sale && sale.final_price);
      const at = Date.parse(sale && sale.settled_at);
      if (rank(rarity) < 0 || !Number.isFinite(price) || price < 0 || !Number.isFinite(at)) continue;
      const date = new Date(at);
      const r = (byRarity[rarity] ||= { weekly: new Map(), monthly: new Map() });
      for (const [map, key] of [[r.weekly, weekStart(date)], [r.monthly, `${parisDay(date).slice(0, 7)}-01`]]) {
        const b = map.get(key) || map.set(key, { sum: 0, min: price, max: price, count: 0 }).get(key);
        b.sum += price;
        b.min = Math.min(b.min, price);
        b.max = Math.max(b.max, price);
        b.count += 1;
      }
    }
    const buckets = (map) => [...map].sort(([a], [b]) => a.localeCompare(b))
      .map(([start, b]) => ({ start, avg: Math.round(b.sum / b.count), min: b.min, max: b.max, count: b.count }));
    const out = {};
    for (const [rarity, r] of Object.entries(byRarity)) out[rarity] = { weekly: buckets(r.weekly), monthly: buckets(r.monthly) };
    return { computed_at: new Date(now).toISOString(), by_rarity: out };
  }

  /** Réponse de /sales qui contient toutes les ventes de la carte (moins de SALES_LIMIT). */
  const salesComplete = (data) => Boolean(data && Array.isArray(data.recent) && data.recent.length < SALES_LIMIT);

  /** Ventes connues d'une carte, toutes raretés (mois, sinon semaines, de price-history). */
  function totalSales(history) {
    let total = 0;
    for (const series of Object.values((history && history.by_rarity) || {})) {
      const points = (series && (Array.isArray(series.monthly) && series.monthly.length ? series.monthly : series.weekly)) || [];
      for (const p of points) total += Math.max(0, Number(p && p.count) || 0);
    }
    return total;
  }

  /** Âge court : « 12 min », « 5 h », « 2 j ». */
  function ago(ms) {
    const min = Math.max(0, Math.round(ms / 60e3));
    if (min < 60) return `${min} min`;
    if (min < 48 * 60) return `${Math.round(min / 60)} h`;
    return `${Math.round(min / 1440)} j`;
  }

  /** Une carte telle que le site la renvoie -> { id, title, rarity, shiny } ; null si elle n'est pas lisible. */
  function card(raw, rarity, shiny) {
    if (!raw || !raw.id || !raw.wikipedia_title) return null;
    return {
      id: String(raw.id),
      title: String(raw.wikipedia_title),
      rarity: String(rarity || raw.rarity || "").toUpperCase(),
      shiny: Boolean(shiny ?? raw.is_shiny),
      url: typeof raw.wikipedia_url === "string" && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(raw.wikipedia_url) ? raw.wikipedia_url : "",
    };
  }

  /**
   * Toutes les cartes d'une réponse du site, où qu'elles soient : ta collection (`collection[].card`), le marché
   * (`auctions[].card`), les vitrines (`showcase[].user_card.card`), le catalogue (`cards[]`)… Une carte est un objet
   * avec `id` et `wikipedia_title`. L'objet qui la contient (exemplaire, vente) donne la rareté de CET exemplaire
   * (`snapshot_rarity`) et s'il est shiny : la carte a pu changer de rareté depuis.
   * Lire toute la réponse plutôt que des chemins connus : une nouvelle page du site est couverte sans retouche.
   */
  function cardsIn(data) {
    const out = [];
    const visit = (node, holder, depth) => {
      if (!node || typeof node !== "object" || depth > 8) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, holder, depth + 1);
        return;
      }
      if (node.id && typeof node.wikipedia_title === "string") {
        const c = card(node, holder && holder.snapshot_rarity, holder && holder.is_shiny);
        if (c) out.push(c);
        return; // une carte ne contient pas d'autres cartes
      }
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object") visit(value, key === "card" ? node : null, depth + 1);
      }
    };
    visit(data, null, 0);
    return out;
  }

  /**
   * Ce que le site dit de la possession des cartes d'une réponse : [[id, true|false], …], sans aucune requête.
   *  - /api/my-collection : toutes ses cartes sont à nous ;
   *  - catalogue (/api/cards) : `cards` et `ownedCardIds` ;
   *  - marché : `owned` à côté de la carte d'une enchère ; collection d'un autre joueur : `owned_by_viewer`.
   * (relevé dans LeadOn/Wikimasters-Toolbox, lib/registry.js)
   */
  function ownershipIn(data, url = "") {
    const out = [];
    if (/\/api\/my-collection(?:[/?#]|$)/i.test(String(url))) {
      for (const c of cardsIn(data)) out.push([c.id, true]);
      return out;
    }
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 8) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (Array.isArray(node.ownedCardIds) && Array.isArray(node.cards)) {
        const mine = new Set(node.ownedCardIds.map(String));
        for (const c of node.cards) if (c && c.id) out.push([String(c.id), mine.has(String(c.id))]);
      }
      const flag = typeof node.owned_by_viewer === "boolean" ? node.owned_by_viewer
        : typeof node.owned === "boolean" ? node.owned : null;
      if (flag !== null && node.card && node.card.id) out.push([String(node.card.id), flag]);
      for (const value of Object.values(node)) if (value && typeof value === "object") visit(value, depth + 1);
    };
    visit(data, 0);
    return out;
  }

  /**
   * Les échanges d'une réponse du site (/api/trades, relevé du bot le 22/11) : chaque échange a un `initiator` qui
   * propose à un `recipient`, des WB de chaque côté et des `items` (un exemplaire, `offered_by` = qui le donne).
   * -> [{ id, sides: [{ name, wb, items: [{ id, title, rarity, shiny }] }, { … }] }] ; côté 0 = l'initiateur.
   */
  function tradesIn(data) {
    const out = [];
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 6) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (Array.isArray(node.items) && ("initiator_id" in node || "recipient_id" in node)) {
        const who = (user, fallback) => String((user && (user.username || user.display_name)) || fallback);
        const sides = [
          { name: who(node.initiator, "Initiateur"), wb: Number(node.initiator_wikibidous) || 0, items: [] },
          { name: who(node.recipient, "Destinataire"), wb: Number(node.recipient_wikibidous) || 0, items: [] },
        ];
        for (const item of node.items) {
          const c = item && card(item.card, item.snapshot_rarity, item.is_shiny || (item.card && item.card.is_shiny));
          const side = item && (item.offered_by === node.initiator_id ? 0 : item.offered_by === node.recipient_id ? 1 : -1);
          if (c && side >= 0) sides[side].items.push(c);
        }
        if (node.id) out.push({ id: String(node.id), sides });
        return;
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(data, 0);
    return out;
  }

  /**
   * Bilan d'un échange : ce que chaque côté donne (cartes au prix moyen + WB). `priceOf(item)` -> nombre, ou null si
   * la carte n'a pas de prix (shiny, aucune vente…). -> [{ name, cards, wb, total, missing }, …] puis `gain` : ce que
   * l'initiateur reçoit de plus qu'il ne donne (négatif : il perd).
   */
  function tradeBalance(trade, priceOf) {
    const sides = trade.sides.map((side) => {
      let cards = 0;
      let missing = 0;
      for (const item of side.items) {
        const price = priceOf(item);
        if (Number.isFinite(price)) cards += price;
        else missing += 1;
      }
      return { name: side.name, cards, wb: side.wb, total: cards + side.wb, missing };
    });
    return { sides, gain: sides[1].total - sides[0].total };
  }

  /**
   * Journal des paquets ouverts, gardé dans chrome.storage.local sous une forme compacte pour tenir des dizaines de
   * milliers de cartes : chaque titre n'est écrit qu'une fois (titles), une carte tirée est un petit tableau.
   * { titles: { "<id>": "Napoléon" }, packs: [{ at, auto, cards: [[id, rarity, shiny (0|1), price (null tant
   *   qu'inconnu)]] }] } ; packs du plus ancien au plus récent, auto = ouvert par l'automatisation (sinon à la main).
   */
  const emptyPullLog = () => ({ titles: {}, packs: [] });

  /**
   * Ajoute un paquet ({ at, auto, cards: [{ id, title, rarity, shiny, isNew }] }) ; au-delà de max, oublie les plus
   * anciens. isNew : true si on n'avait pas la carte avant le paquet, false si c'est un doublon, absent si on ne savait
   * pas. Une carte du journal : [id, rareté, shiny (0|1), prix (null tant qu'inconnu), nouvelle (1|0|null)].
   */
  function addPull(log, { at, auto, cards }, max) {
    const titles = { ...log.titles };
    for (const c of cards) titles[c.id] = c.title;
    let packs = [...log.packs, { at, auto: Boolean(auto),
      cards: cards.map((c) => [c.id, c.rarity, c.shiny ? 1 : 0, null, c.isNew === true ? 1 : c.isNew === false ? 0 : null]) }];
    if (packs.length > max) {
      packs = packs.slice(-max);
      const kept = new Set(packs.flatMap((pack) => pack.cards.map(([id]) => id)));
      for (const id of Object.keys(titles)) if (!kept.has(id)) delete titles[id]; // titres des cartes oubliées
    }
    return { titles, packs };
  }

  /** Une carte du journal -> { id, title, rarity, shiny, price, isNew } (price : null tant qu'inconnu ; isNew : null si inconnu). */
  const pulledCard = (log, [id, rarity, shiny, price, isNew]) => ({
    id, title: log.titles[id] || id, rarity, shiny: Boolean(shiny), price: Number.isFinite(price) ? price : null,
    isNew: isNew === 1 ? true : isNew === 0 ? false : null,
  });

  /**
   * Fige dans le journal le prix de chaque carte tirée dès que `priceOf(card)` le connaît : le récap garde la valeur
   * au moment de l'ouverture, et une carte chiffrée n'est plus redemandée. Modifie le journal ; -> true si changé.
   */
  function settlePullPrices(log, priceOf) {
    let changed = false;
    for (const pack of log.packs) {
      for (const raw of pack.cards) {
        if (Number.isFinite(raw[3])) continue;
        const price = priceOf(pulledCard(log, raw));
        if (Number.isFinite(price)) {
          raw[3] = price;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Rareté pour la répartition du récap : tout ce qui commence par L (« L+ », « L✦ »…) compte en L. */
  const recapRarity = (rarity) => {
    const code = String(rarity || "").toUpperCase();
    return code.startsWith("L") ? "L" : code || "?";
  };

  /**
   * Point de départ repris des compteurs d'une autre extension (« WikiMasters - Prix moyen collection », clé
   * wm_pull_stats_v1 du localStorage du site : { counts: { L: 6, UR: 55, … }, updatedAt }). Les cartes que notre
   * journal a déjà notées sont retirées : les deux extensions ont vu les mêmes paquets, elles compteraient deux fois.
   * -> { C: 8951, … } (raretés à 0 omises), ou null si `other` n'est pas lisible.
   */
  function pullBaseline(other, log) {
    if (!other || typeof other.counts !== "object" || !other.counts) return null;
    const counts = {};
    for (const [rarity, n] of Object.entries(other.counts)) {
      const r = recapRarity(rarity);
      counts[r] = (counts[r] || 0) + Math.max(0, Math.floor(Number(n) || 0));
    }
    for (const pack of log.packs) {
      for (const [, rarity] of pack.cards) {
        const r = recapRarity(rarity);
        if (counts[r]) counts[r] -= 1;
      }
    }
    return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
  }

  /**
   * Récap du journal. Le prix figé d'une carte compte d'abord ; sinon `priceOf(card)` -> nombre, ou null (shiny,
   * aucune vente, pas encore lu). `earlier` = cartes comptées avant le journal, par rareté (pullBaseline) : elles
   * entrent dans la répartition, pas dans la valeur (on ne sait pas lesquelles c'étaient).
   * -> { packs, auto, manual, cards, since, earlier (total de `earlier`), byRarity: { C: 3, R: 1, … } (de C à L,
   *      puis les raretés inconnues ; journal + earlier), shiny, value, missing (cartes sans prix), best (les 3 cartes
   *      les plus chères, avec leur price) }
   */
  function pullRecap(log, priceOf, earlier = {}, now = Date.now()) {
    const byRarity = {};
    for (const [rarity, n] of Object.entries(earlier)) byRarity[recapRarity(rarity)] = (byRarity[recapRarity(rarity)] || 0) + n;
    const priced = [];
    let cards = 0;
    let auto = 0;
    let shiny = 0;
    let value = 0;
    let missing = 0;
    for (const pack of log.packs) {
      if (pack.auto) auto += 1;
      for (const raw of pack.cards) {
        const c = pulledCard(log, raw);
        cards += 1;
        if (c.shiny) shiny += 1;
        const rarity = recapRarity(c.rarity);
        byRarity[rarity] = (byRarity[rarity] || 0) + 1;
        const price = c.price ?? priceOf(c);
        if (Number.isFinite(price)) {
          value += price;
          priced.push({ ...c, price });
        } else {
          missing += 1;
        }
      }
    }
    const order = (r) => (rank(r) < 0 ? RARITIES.length : rank(r));
    return {
      packs: log.packs.length,
      auto,
      manual: log.packs.length - auto,
      cards,
      since: log.packs.length ? log.packs[0].at : null,
      earlier: Object.values(earlier).reduce((sum, n) => sum + n, 0),
      byRarity: Object.fromEntries(Object.entries(byRarity).sort(([a], [b]) => order(a) - order(b))),
      shiny,
      value,
      missing,
      best: priced.sort((a, b) => b.price - a.price).slice(0, 3),
      today: pullsOfDay(log, now),
      last: lastPull(log, priceOf),
    };
  }

  /** Paquets du jour (jour local du navigateur, remis à zéro à minuit) : { packs, cards, byRarity } (#24). */
  function pullsOfDay(log, now = Date.now()) {
    const day = new Date(now).toDateString();
    const out = { packs: 0, cards: 0, byRarity: {} };
    for (const pack of log.packs) {
      if (new Date(pack.at).toDateString() !== day) continue;
      out.packs += 1;
      for (const [, rarity] of pack.cards) {
        out.cards += 1;
        out.byRarity[recapRarity(rarity)] = (out.byRarity[recapRarity(rarity)] || 0) + 1;
      }
    }
    return out;
  }

  /** Le dernier paquet ouvert (#23) : { at, auto, cards: [{ …, price }], value, fresh (nouvelles), doubles } ou null. */
  function lastPull(log, priceOf) {
    const pack = log.packs[log.packs.length - 1];
    if (!pack) return null;
    const cards = pack.cards.map((raw) => {
      const c = pulledCard(log, raw);
      return { ...c, price: c.price ?? priceOf(c) };
    });
    return {
      at: pack.at, auto: pack.auto, cards,
      value: cards.reduce((sum, c) => sum + (Number.isFinite(c.price) ? c.price : 0), 0),
      fresh: cards.filter((c) => c.isNew === true).length,
      doubles: cards.filter((c) => c.isNew === false).length,
    };
  }

  /**
   * Budget de lectures du site : au plus `limit` lectures par fenêtre glissante de `windowMs`. `stamps` = dates des
   * lectures récentes (tous onglets confondus). Le site coupe l'historique des prix au-delà de ~90-100 lectures par
   * 10 min (403 automation_limit, ~10 min de blocage) : mieux vaut attendre un peu que d'être bloqué.
   * -> { wait: ms avant la prochaine lecture (0 : tout de suite), stamps: les dates encore dans la fenêtre, triées }
   */
  function readBudget(stamps, now, limit, windowMs) {
    const recent = (Array.isArray(stamps) ? stamps : [])
      .filter((t) => Number.isFinite(t) && t <= now && now - t < windowMs)
      .sort((a, b) => a - b);
    const wait = recent.length < limit ? 0 : recent[recent.length - limit] + windowMs - now;
    return { wait: Math.max(0, wait), stamps: recent };
  }

  /**
   * Pourquoi le site refuse une requête, d'après son statut et son corps (texte ou JSON) :
   * « verification » (human_verification_required : un humain doit faire la vérification), « automation »
   * (automation_limit : quota dépassé, ~10 min), « rate » (429 : trop vite, voir Retry-After), ou null.
   */
  function siteLimit(status, body) {
    let text = "";
    try {
      text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    } catch (_) {
      text = "";
    }
    if (/human_verification_required/i.test(text)) return "verification";
    if (/automation_limit/i.test(text)) return "automation";
    if (status === 429) return "rate";
    return null;
  }

  /** Lectures de `stamps` faites depuis moins de `ms` avant `now`. */
  const countSince = (stamps, now, ms) => (Array.isArray(stamps) ? stamps : []).filter((t) => t <= now && now - t < ms).length;

  /**
   * Relevé des refus du site, pour connaître ses quotas sans les chercher : chaque refus (`automation_limit`,
   * vérification, 429) est noté avec ce que l'extension avait lu juste avant sur cette route. Les plus récents
   * d'abord, au plus `max`. event : { at, route, limit, status, reads10m, reads1m }.
   */
  const addLimitEvent = (log, event, max = 50) => [event, ...(Array.isArray(log) ? log : [])].slice(0, max);

  // ------------------------------------------------------------------ session et collection (panneau)
  const decodeBase64Url = (text) => {
    const b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  };
  const jwtClaims = (token) => {
    try {
      return JSON.parse(decodeBase64Url(String(token).split(".")[1]));
    } catch (_) {
      return {};
    }
  };

  /**
   * Session Supabase du joueur, lue dans les cookies du site (@supabase/ssr écrit `sb-<ref>-auth-token`, préfixé
   * « base64- », parfois découpé en morceaux `.0`, `.1`…). -> { token, userId, expiresAt (ms) } ou null.
   */
  function sessionFromCookies(cookies, name) {
    let single = null;
    const chunks = [];
    for (const entry of String(cookies || "").split(";")) {
      const i = entry.indexOf("=");
      if (i < 0) continue;
      const key = entry.slice(0, i).trim();
      const value = entry.slice(i + 1).trim();
      if (key === name) single = value;
      else if (key.startsWith(`${name}.`) && Number.isInteger(Number(key.slice(name.length + 1)))) {
        chunks.push([Number(key.slice(name.length + 1)), value]);
      }
    }
    const parse = (raw) => {
      try {
        let text = decodeURIComponent(raw);
        if (text.startsWith("base64-")) text = decodeBase64Url(text.slice(7));
        const session = JSON.parse(text);
        const claims = jwtClaims(session.access_token);
        const userId = (session.user && session.user.id) || claims.sub;
        if (!session.access_token || !userId) return null;
        return { token: session.access_token, userId, expiresAt: (session.expires_at || claims.exp || 0) * 1000 };
      } catch (_) {
        return null;
      }
    };
    const joined = chunks.length ? chunks.sort((a, b) => a[0] - b[0]).map((c) => c[1]).join("") : null;
    return [joined, single].filter(Boolean).map(parse).filter(Boolean).sort((a, b) => b.expiresAt - a.expiresAt)[0] || null;
  }

  /**
   * Bilan de la collection pour le panneau (#18, #22). rows : [[exemplaire, carte, rareté, nombre, favori, shiny]],
   * titles : { carte: titre }, priceOf(carte, rareté) -> { avg, sure } ou null. Un shiny n'a pas de prix propre : il
   * compte sans valeur. Doublons : pour chaque carte, l'exemplaire le plus rare est gardé, les autres sont en trop.
   */
  function collectionSummary(rows, titles, priceOf) {
    const byRarity = {};
    const byCard = new Map();
    let copies = 0;
    let value = 0;
    let unsure = 0;
    let unpriced = 0;
    for (const [, cardId, rarity, count, starred, shiny] of rows) {
      const n = Math.max(1, Number(count) || 1);
      const p = shiny ? null : priceOf(cardId, rarity);
      const r = (byRarity[rarity] ||= { copies: 0, value: 0, unpriced: 0 });
      r.copies += n;
      copies += n;
      if (p) {
        r.value += p.avg * n;
        value += p.avg * n;
        if (!p.sure) unsure += n;
      } else {
        r.unpriced += n;
        unpriced += n;
      }
      const card = byCard.get(cardId) || byCard.set(cardId, []).get(cardId);
      for (let i = 0; i < n; i++) card.push({ rarity, starred: Boolean(starred), shiny: Boolean(shiny), price: p });
    }
    const title = (id) => (titles && titles[id]) || id;
    const top = [...byCard].flatMap(([id, list]) => list.filter((c) => c.price).map((c) => ({ id, title: title(id), rarity: c.rarity, price: c.price.avg, sure: c.price.sure })))
      .sort((a, b) => b.price - a.price)
      .filter((c, i, all) => all.findIndex((o) => o.id === c.id && o.rarity === c.rarity) === i)
      .slice(0, 15);
    const duplicates = [];
    for (const [id, list] of byCard) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => rank(b.rarity) - rank(a.rarity) || Number(a.shiny) - Number(b.shiny));
      const extra = sorted.slice(1);
      duplicates.push({
        id, title: title(id), copies: list.length, kept: sorted[0].rarity,
        extra: extra.map((c) => c.rarity + (c.shiny ? "✦" : "")).join(", "),
        locked: extra.filter((c) => c.starred).length,
        value: extra.reduce((sum, c) => sum + (c.price ? c.price.avg : 0), 0),
      });
    }
    duplicates.sort((a, b) => b.value - a.value || b.copies - a.copies);
    const order = Object.keys(byRarity).sort((a, b) => rank(b) - rank(a));
    return { copies, distinct: byCard.size, value, unsure, unpriced, byRarity: order.map((r) => ({ rarity: r, ...byRarity[r] })), top, duplicates };
  }

  /**
   * Filtres de la collection (#19). rows : [[exemplaire, carte, rareté, nombre, favori, shiny, image]] (image : 0 sans
   * image ou masquée, 1 image, 2 GIF, undefined inconnu) ; priceInfo(carte, rareté) -> { state: "price" | "never" |
   * "unknown", avg?, sure? }. criteria : { duplicates, noImage, gif, rarities: [], text, price: "all" | "never" |
   * "range", min, max, sort: "value-desc" | "value-asc" | "rarity" }. Une ligne par carte et par rareté.
   * -> { count, items: [{ id, title, rarity, copies, shiny, image, price, sure, state }] } (300 premières)
   */
  function filterCollection(rows, titles, priceInfo, criteria = {}) {
    const groups = new Map();
    const perCard = new Map();
    for (const [, id, rarity, count, , shiny, image] of rows) {
      const n = Math.max(1, Number(count) || 1);
      perCard.set(id, (perCard.get(id) || 0) + n);
      const key = `${id}|${rarity}`;
      const g = groups.get(key) || groups.set(key, { id, title: (titles && titles[id]) || id, rarity, copies: 0, shiny: false, image }).get(key);
      g.copies += n;
      if (shiny) g.shiny = true;
    }
    const words = String(criteria.text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(Boolean);
    const plain = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const rarities = new Set(criteria.rarities || []);
    const min = Number.isFinite(Number(criteria.min)) && criteria.min !== "" ? Number(criteria.min) : -Infinity;
    const max = Number.isFinite(Number(criteria.max)) && criteria.max !== "" ? Number(criteria.max) : Infinity;
    const out = [];
    for (const g of groups.values()) {
      if (criteria.duplicates && perCard.get(g.id) < 2) continue;
      if (criteria.noImage && g.image !== 0) continue;
      if (criteria.gif && g.image !== 2) continue;
      if (rarities.size && !rarities.has(g.rarity)) continue;
      if (words.length && !words.every((w) => plain(g.title).includes(w))) continue;
      const info = g.shiny ? { state: "unknown" } : priceInfo(g.id, g.rarity) || { state: "unknown" };
      if (criteria.price === "never" && info.state !== "never") continue;
      if (criteria.price === "range" && !(info.state === "price" && info.avg >= Math.min(min, max) && info.avg <= Math.max(min, max))) continue;
      out.push({ ...g, state: info.state, price: info.state === "price" ? info.avg : null, sure: Boolean(info.sure) });
    }
    const value = (x) => (x.price === null ? null : x.price);
    if (criteria.sort === "rarity") out.sort((a, b) => rank(b.rarity) - rank(a.rarity) || a.title.localeCompare(b.title));
    else {
      const sign = criteria.sort === "value-asc" ? 1 : -1;
      out.sort((a, b) => (value(a) === null) - (value(b) === null) || sign * ((value(a) || 0) - (value(b) || 0)) || rank(b.rarity) - rank(a.rarity));
    }
    return { count: out.length, items: out.slice(0, 300) };
  }

  /**
   * Liste de souhaits chiffrée (#21). wishes : [{ id, title }] ; quotesOf(id) -> { RARETÉ: { avg, count, … } } ou null
   * (pas encore lu) ; owned(id) -> true | false | undefined. Le coût d'une carte est son prix le plus bas connu, toutes
   * raretés (on la veut, pas une rareté précise). -> { items: [{ id, title, cheapest: { rarity, avg } | null, state,
   * prices: [[rareté, avg]], owned }], total, priced, unknown, never }
   */
  function wishlistSummary(wishes, quotesOf, owned = () => undefined) {
    const items = wishes.map(({ id, title }) => {
      const q = quotesOf(id);
      const list = q ? Object.entries(q).sort(([a], [b]) => rank(a) - rank(b)).map(([r, v]) => [r, v.avg]) : [];
      const cheapest = list.length ? list.reduce((best, [r, avg]) => (!best || avg < best.avg ? { rarity: r, avg } : best), null) : null;
      return { id, title, cheapest, prices: list, state: !q ? "unknown" : cheapest ? "price" : "never", owned: owned(id) };
    });
    items.sort((a, b) => (a.cheapest === null) - (b.cheapest === null) || (b.cheapest ? b.cheapest.avg : 0) - (a.cheapest ? a.cheapest.avg : 0));
    const priced = items.filter((i) => i.cheapest);
    return {
      items, total: priced.reduce((sum, i) => sum + i.cheapest.avg, 0), priced: priced.length,
      unknown: items.filter((i) => i.state === "unknown").length, never: items.filter((i) => i.state === "never").length,
    };
  }

  /**
   * Enchères du marché d'une réponse du site (`auctions[]` : carte, rareté de l'exemplaire, shiny, mise actuelle, mise
   * de départ, fin). -> [{ cardId, rarity, shiny, current, base, endAt (ms) }]
   */
  function auctionsIn(data) {
    const list = data && Array.isArray(data.auctions) ? data.auctions : [];
    return list.filter((a) => a && a.card && a.card.id).map((a) => ({
      cardId: String(a.card.id),
      rarity: String(a.snapshot_rarity || a.card.rarity || "").toUpperCase(),
      shiny: Boolean(a.is_shiny),
      current: Number(a.current_bid) || 0,
      base: Number(a.base_amount) || 0,
      endAt: Date.parse(a.end_at) || null,
    }));
  }

  /** Mise minimum du site : 10 % au-dessus de la mise actuelle (au moins +1), ou la mise de départ sans enchère. */
  const minBid = (a) => (a.current > 0 ? Math.max(Math.ceil(1.1 * a.current), a.current + 1) : a.base);

  /**
   * Bonne affaire ou surcoté (#16), comme Toolbox : « bonne affaire » si l'enchère finit dans moins de 15 min et que la
   * mise minimum est au moins 25 % sous la cote ; « surcoté » si elle la dépasse d'au moins 50 %. Seulement avec un prix
   * fiable, et jamais pour un shiny (le site ne donne pas leur prix). -> { kind: "deal" | "high", pct } ou null.
   */
  function auctionDeal(a, price, sure, now = Date.now()) {
    if (!a || a.shiny || !sure || !(price > 0)) return null;
    const bid = minBid(a);
    if (!(bid > 0)) return null;
    const pct = Math.round((bid / price - 1) * 100);
    if (a.endAt && a.endAt - now <= 15 * 60e3 && a.endAt > now && bid <= 0.75 * price) return { kind: "deal", pct };
    if (bid >= 1.5 * price) return { kind: "high", pct };
    return null;
  }

  /** Médiane et quartiles (interpolation linéaire) d'une liste de prix (#15). -> { median, q1, q3, n } ou null. */
  function quartiles(values) {
    const v = (Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    if (!v.length) return null;
    const at = (p) => {
      const i = (v.length - 1) * p;
      const lo = Math.floor(i);
      return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo);
    };
    return { median: at(0.5), q1: at(0.25), q3: at(0.75), n: v.length };
  }

  /** Une mesure par jour de la valeur de la collection (#18) : { "2026-11-24": valeur }, 365 jours au plus. */
  function addDailyValue(history, day, value, max = 365) {
    const next = { ...(history || {}), [day]: Math.round(value) };
    const days = Object.keys(next).sort();
    for (const d of days.slice(0, Math.max(0, days.length - max))) delete next[d];
    return next;
  }

  /** 1250 -> « 1 250 », 12500 -> « 12,5 k » : court, pour un badge. */
  function wb(n) {
    if (!Number.isFinite(n)) return "?";
    if (n >= 10000) return (n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k";
    return Math.round(n).toLocaleString("fr-FR");
  }

  return { RARITIES, rank, norm, quotes, RECENT_WEEKS, MIN_SALES, reliable, currentWeek, weekStart, ownershipIn, SALES_LIMIT, historyFromSales, salesComplete, totalSales, ago, cardsIn, tradesIn, tradeBalance, emptyPullLog, addPull, settlePullPrices, pullBaseline, pullRecap, readBudget, quartiles, auctionsIn, auctionDeal, sessionFromCookies, collectionSummary, filterCollection, wishlistSummary, addDailyValue, countSince, addLimitEvent, siteLimit, wb };
})();

if (typeof module !== "undefined") module.exports = WME;
