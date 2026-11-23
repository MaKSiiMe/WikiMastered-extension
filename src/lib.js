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

  /** 1250 -> « 1 250 », 12500 -> « 12,5 k » : court, pour un badge. */
  function wb(n) {
    if (!Number.isFinite(n)) return "?";
    if (n >= 10000) return (n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k";
    return Math.round(n).toLocaleString("fr-FR");
  }

  return { RARITIES, rank, norm, quotes, currentWeek, cardsIn, wb };
})();

if (typeof module !== "undefined") module.exports = WME;
