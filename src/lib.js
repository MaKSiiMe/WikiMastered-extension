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
   * -> { "SR": { avg, count, week: "2026-11-16" } }
   */
  function quotes(history) {
    const out = {};
    const byRarity = history && history.by_rarity;
    if (!byRarity || typeof byRarity !== "object") return out;
    for (const [rarity, series] of Object.entries(byRarity)) {
      const weekly = series && series.weekly;
      if (rank(rarity) < 0 || !Array.isArray(weekly)) continue;
      const latest = weekly
        .filter((p) => p && Number(p.avg) > 0 && Number(p.count) > 0)
        .sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")))[0];
      if (latest) out[rarity] = { avg: Number(latest.avg), count: Number(latest.count), week: String(latest.start || "") };
    }
    return out;
  }

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

  /** Ajoute un paquet ({ at, auto, cards: [{ id, title, rarity, shiny }] }) ; au-delà de max, oublie les plus anciens. */
  function addPull(log, { at, auto, cards }, max) {
    const titles = { ...log.titles };
    for (const c of cards) titles[c.id] = c.title;
    let packs = [...log.packs, { at, auto: Boolean(auto), cards: cards.map((c) => [c.id, c.rarity, c.shiny ? 1 : 0, null]) }];
    if (packs.length > max) {
      packs = packs.slice(-max);
      const kept = new Set(packs.flatMap((pack) => pack.cards.map(([id]) => id)));
      for (const id of Object.keys(titles)) if (!kept.has(id)) delete titles[id]; // titres des cartes oubliées
    }
    return { titles, packs };
  }

  /** Une carte du journal -> { id, title, rarity, shiny, price } (price : null tant qu'inconnu). */
  const pulledCard = (log, [id, rarity, shiny, price]) =>
    ({ id, title: log.titles[id] || id, rarity, shiny: Boolean(shiny), price: Number.isFinite(price) ? price : null });

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
  function pullRecap(log, priceOf, earlier = {}) {
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

  /** 1250 -> « 1 250 », 12500 -> « 12,5 k » : court, pour un badge. */
  function wb(n) {
    if (!Number.isFinite(n)) return "?";
    if (n >= 10000) return (n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k";
    return Math.round(n).toLocaleString("fr-FR");
  }

  return { RARITIES, rank, norm, quotes, currentWeek, weekStart, SALES_LIMIT, historyFromSales, salesComplete, totalSales, ago, cardsIn, tradesIn, tradeBalance, emptyPullLog, addPull, settlePullPrices, pullBaseline, pullRecap, readBudget, countSince, addLimitEvent, siteLimit, wb };
})();

if (typeof module !== "undefined") module.exports = WME;
