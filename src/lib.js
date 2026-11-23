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

  // Cote d'une carte, même calcul que le bot (src/core/pricing.py, history_quotes) : la moyenne des dernières
  // semaines qui ont des ventes, pondérée par leur nombre, en remontant jusqu'à 10 ventes ou 4 semaines.
  const HISTORY_WEEKS = 4;
  const HISTORY_MIN_SALES = 10;

  /**
   * Réponse de /api/marketplace/cards/{id}/price-history -> { "SR": { avg, count }, … }.
   * Format relevé le 22/11 : { computed_at, by_rarity: { "SR": { weekly: [ { start, avg, min, max, count } ] } } }.
   */
  function quotes(history) {
    const out = {};
    const byRarity = history && history.by_rarity;
    if (!byRarity || typeof byRarity !== "object") return out;
    for (const [rarity, series] of Object.entries(byRarity)) {
      const weekly = series && series.weekly;
      if (rank(rarity) < 0 || !Array.isArray(weekly)) continue;
      const points = weekly
        .filter((p) => p && Number(p.avg) > 0 && Number.isInteger(p.count) && p.count > 0)
        .sort((a, b) => String(b.start || "").localeCompare(String(a.start || ""))); // les plus récentes d'abord
      const kept = [];
      for (const p of points) {
        kept.push(p);
        const sales = kept.reduce((n, k) => n + k.count, 0);
        if (kept.length >= HISTORY_WEEKS || sales >= HISTORY_MIN_SALES) break;
      }
      const total = kept.reduce((n, k) => n + k.count, 0);
      if (total) out[rarity] = { avg: kept.reduce((s, k) => s + k.avg * k.count, 0) / total, count: total };
    }
    return out;
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
   * Les cartes contenues dans une réponse du site, quelle qu'elle soit : ta collection (`collection`), le marché
   * (`auctions`), une enchère seule (`auction` ou `card`), le catalogue (`cards`). Une vente a sa propre rareté
   * (`snapshot_rarity`) : la carte a pu changer de rareté depuis.
   */
  function cardsIn(data) {
    if (!data || typeof data !== "object") return [];
    const out = [];
    const push = (c) => c && out.push(c);
    for (const item of Array.isArray(data.collection) ? data.collection : []) {
      push(card(item && item.card, item && item.snapshot_rarity, item && item.is_shiny));
    }
    for (const a of Array.isArray(data.auctions) ? data.auctions : []) {
      push(card(a && a.card, a && a.snapshot_rarity, a && a.is_shiny));
    }
    for (const c of Array.isArray(data.cards) ? data.cards : []) push(card(c));
    const single = data.auction || (data.card ? data : null);
    if (single) push(card(single.card, single.snapshot_rarity, single.is_shiny));
    return out;
  }

  /**
   * Pages de /api/cards?wishlist=1 (ta liste de souhaits) -> amis classés par nombre de cartes :
   * [ { name, cards: [ { id, title, rarities: ["L", "SR"] } ] } ]. `minRarity` écarte les exemplaires plus bas
   * (pour une carte que tu as déjà en SR, seule une UR ou une L t'avance).
   */
  function friendsFromCatalog(pages, minRarity = "") {
    const floor = minRarity ? rank(minRarity) : -1;
    const friends = new Map();
    const seen = new Set();
    for (const page of pages) {
      const owners = (page && page.friendOwners) || {};
      for (const c of (page && page.cards) || []) {
        if (!c || !c.id || seen.has(c.id)) continue;
        seen.add(c.id);
        for (const owner of owners[c.id] || []) {
          if (!owner || !owner.username) continue;
          const rarities = [...new Set((owner.rarities || []).map((r) => String(r).toUpperCase()))]
            .filter((r) => rank(r) < 0 || rank(r) >= floor) // rareté inconnue : gardée
            .sort((a, b) => rank(b) - rank(a));
          if (owner.rarities && owner.rarities.length && !rarities.length) continue;
          if (!friends.has(owner.username)) friends.set(owner.username, []);
          friends.get(owner.username).push({ id: c.id, title: c.wikipedia_title || "?", rarities });
        }
      }
    }
    const best = (c) => Math.max(-1, ...c.rarities.map(rank));
    return [...friends.entries()]
      .map(([name, cards]) => ({ name, cards: cards.sort((a, b) => best(b) - best(a) || a.title.localeCompare(b.title)) }))
      .sort((a, b) => b.cards.length - a.cards.length || a.name.localeCompare(b.name));
  }

  /** 1250 -> « 1 250 », 12500 -> « 12,5 k » : court, pour un badge. */
  function wb(n) {
    if (!Number.isFinite(n)) return "?";
    if (n >= 10000) return (n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k";
    return Math.round(n).toLocaleString("fr-FR");
  }

  return { RARITIES, rank, norm, quotes, cardsIn, friendsFromCatalog, wb };
})();

if (typeof module !== "undefined") module.exports = WME;
