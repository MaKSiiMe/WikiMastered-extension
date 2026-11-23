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

  /** Lundi (UTC) de la semaine en cours, « 2026-11-23 » : une cote d'une semaine plus ancienne est « reportée ». */
  function currentWeek(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
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

  /** 1250 -> « 1 250 », 12500 -> « 12,5 k » : court, pour un badge. */
  function wb(n) {
    if (!Number.isFinite(n)) return "?";
    if (n >= 10000) return (n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k";
    return Math.round(n).toLocaleString("fr-FR");
  }

  return { RARITIES, rank, norm, quotes, currentWeek, cardsIn, tradesIn, tradeBalance, wb };
})();

if (typeof module !== "undefined") module.exports = WME;
