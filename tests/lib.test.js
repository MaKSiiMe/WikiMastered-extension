// Tests des fonctions pures : `npm test`. Aucun navigateur, aucune requête au site.
const test = require("node:test");
const assert = require("node:assert/strict");
const WME = require("../src/lib.js");

test("le prix moyen est celui de la dernière semaine avec des ventes, comme sur le site", () => {
  const history = {
    by_rarity: {
      L: { weekly: [
        { start: "2026-11-09", avg: 8000, count: 4 },
        { start: "2026-11-16", avg: 9000, count: 8 },
        { start: "2026-11-23", avg: 0, count: 0 }, // semaine en cours sans vente : prix reporté
      ] },
      SR: { weekly: [{ start: "2026-11-16", avg: 0, count: 3 }] },
      XX: { weekly: [{ start: "2026-11-16", avg: 5, count: 5 }] },
    },
  };
  const now = new Date("2026-11-24T12:00:00Z");
  assert.deepEqual(WME.quotes(history, now), { L: { avg: 9000, count: 8, week: "2026-11-16", sales12: 12 } }); // SR sans prix, XX inconnue
  assert.deepEqual(WME.quotes(null), {});
});

test("prix fiable : au moins 3 ventes sur les 12 dernières semaines (semaine en cours comprise)", () => {
  const now = new Date("2026-11-24T12:00:00Z"); // semaine du 23/11 ; la 12e semaine en arrière commence le 07/09
  const history = { by_rarity: { R: { weekly: [
    { start: "2026-08-31", avg: 50, count: 9 }, // 13e semaine : trop vieille
    { start: "2026-09-07", avg: 60, count: 1 },
    { start: "2026-11-16", avg: 70, count: 1 },
  ] } } };
  const q = WME.quotes(history, now).R;
  assert.equal(q.sales12, 2);
  assert.equal(WME.reliable(q), false);
  assert.equal(WME.reliable(q, 2), true);
  assert.equal(WME.reliable({ avg: 70, count: 1, week: "2026-11-16" }), null); // relevé avant la 0.6
});

test("semaine en cours : son lundi, à l'heure de Paris comme le site", () => {
  assert.equal(WME.currentWeek(new Date("2026-11-23T10:00:00Z")), "2026-11-23"); // lundi
  assert.equal(WME.currentWeek(new Date("2026-11-29T22:30:00Z")), "2026-11-23"); // dimanche 23 h 30 à Paris
  assert.equal(WME.currentWeek(new Date("2026-11-29T23:30:00Z")), "2026-11-30"); // déjà lundi à Paris
  assert.equal(WME.weekStart(new Date("2026-07-05T22:30:00Z")), "2026-07-06"); // heure d'été : lundi 0 h 30
});

test("les ventes de /sales redonnent l'historique de price-history quand elles sont toutes là", () => {
  const recent = [
    { id: "a", final_price: 1000, settled_at: "2026-11-24T10:00:00+00:00", rarity: "R" },
    { id: "b", final_price: 1201, settled_at: "2026-11-23T08:00:00+00:00", rarity: "R" },
    { id: "c", final_price: 300, settled_at: "2026-11-15T23:30:00+00:00", rarity: "C" }, // lundi 16 à Paris
    { id: "d", final_price: 50, settled_at: "x", rarity: "C" }, // date illisible : ignorée
  ];
  const history = WME.historyFromSales(recent, Date.parse("2026-11-24T12:00:00Z"));
  assert.deepEqual(history.by_rarity.R.weekly, [{ start: "2026-11-23", avg: 1101, min: 1000, max: 1201, count: 2 }]);
  assert.deepEqual(history.by_rarity.C.weekly, [{ start: "2026-11-16", avg: 300, min: 300, max: 300, count: 1 }]);
  assert.deepEqual(history.by_rarity.R.monthly, [{ start: "2026-11-01", avg: 1101, min: 1000, max: 1201, count: 2 }]);
  assert.deepEqual(WME.quotes(history, new Date("2026-11-24T12:00:00Z")), {
    R: { avg: 1101, count: 2, week: "2026-11-23", sales12: 2 },
    C: { avg: 300, count: 1, week: "2026-11-16", sales12: 1 },
  });
  assert.equal(WME.totalSales(history), 3);
  assert.equal(WME.salesComplete({ recent }), true);
  assert.equal(WME.salesComplete({ recent: [...recent, recent[0]] }), false); // 5 ventes : il y en a peut-être d'autres
  assert.equal(WME.salesComplete({ recent: [] }), true); // jamais vendue
  assert.equal(WME.salesComplete(null), false);
});

test("âge court d'un prix", () => {
  assert.equal(WME.ago(12 * 60e3), "12 min");
  assert.equal(WME.ago(5 * 3600e3), "5 h");
  assert.equal(WME.ago(3 * 86400e3), "3 j");
});

test("les cartes sont lues dans toutes les réponses du site", () => {
  const c = (id, title, rarity = "R") => ({ id, wikipedia_title: title, rarity });
  const cards = [
    ...WME.cardsIn({ collection: [{ card: c("1", "Napoléon"), is_shiny: true }, { card: null }] }),
    ...WME.cardsIn({ auctions: [{ card: c("2", "Lyon", "SR"), snapshot_rarity: "ur", seller: { id: "s" } }] }),
    ...WME.cardsIn({ cards: [c("3", "Paris", "L")] }),
    ...WME.cardsIn({ auction: { card: c("4", "Rome"), snapshot_rarity: "PC" } }),
    // Vitrines (/api/showcase, /api/profile/{pseudo}/showcase), relevé du 22/11.
    ...WME.cardsIn({ galleries: [{ name: "GOTY" }], showcase: [
      { position: 0, user_card: { card: c("5", "Elden Ring", "SR"), snapshot_rarity: "UR", is_shiny: false } },
      { position: 1, user_card: { card: c("6", "Rapport sexuel", "L"), snapshot_rarity: "L", is_shiny: true } },
    ] }),
  ];
  assert.deepEqual(cards.map((x) => [x.id, x.title, x.rarity, x.shiny]), [
    ["1", "Napoléon", "R", true],
    ["2", "Lyon", "UR", false], // la rareté de la vente, pas celle du catalogue
    ["3", "Paris", "L", false],
    ["4", "Rome", "PC", false],
    ["5", "Elden Ring", "UR", false],
    ["6", "Rapport sexuel", "L", true],
  ]);
  assert.deepEqual(WME.cardsIn("pas un objet"), []);
  assert.deepEqual(WME.cardsIn({ user: { id: "u", username: "bob" } }), []); // pas une carte : pas de titre
});

test("montants courts pour les badges", () => {
  assert.equal(WME.wb(1250).replace(/\s/g, " "), "1 250");
  assert.equal(WME.wb(12500).replace(/\s/g, " "), "12,5 k");
  assert.equal(WME.wb(NaN), "?");
});

test("un échange : les cartes de chaque côté et son bilan", () => {
  const card = (id, title, rarity) => ({ id, wikipedia_title: title, rarity });
  const [trade] = WME.tradesIn({ trades: [{
    id: "t1", initiator_id: "a", recipient_id: "b", initiator: { username: "Alice" }, recipient: { username: "Bob" },
    initiator_wikibidous: 300, recipient_wikibidous: 0,
    items: [
      { offered_by: "a", card: card("1", "Lyon", "SR"), snapshot_rarity: "UR" },
      { offered_by: "b", card: card("2", "Paris", "L"), snapshot_rarity: "L" },
      { offered_by: "b", card: card("3", "Rome", "L"), snapshot_rarity: "L", is_shiny: true },
      { offered_by: "b", card_id: "4" }, // carte sans fiche : ignorée
    ],
  }] });
  assert.equal(trade.id, "t1");
  assert.deepEqual(trade.sides.map((s) => [s.name, s.wb, s.items.map((i) => `${i.title} ${i.rarity}${i.shiny ? "✦" : ""}`)]), [
    ["Alice", 300, ["Lyon UR"]],
    ["Bob", 0, ["Paris L", "Rome L✦"]],
  ]);
  const prices = { 1: 2000, 2: 5000 };
  const balance = WME.tradeBalance(trade, (item) => (item.shiny ? null : prices[item.id] ?? null));
  assert.deepEqual(balance.sides.map((s) => [s.total, s.missing]), [[2300, 0], [5000, 1]]);
  assert.equal(balance.gain, 2700); // Alice reçoit 5 000 (sans le shiny) et donne 2 300
});

test("journal des paquets : compact, prix figés, récap de C à L, à la main et en auto", () => {
  const prices = { a: 100, b: 2500, c: 40 };
  const priceOf = (c) => (c.shiny ? null : prices[c.id] ?? null);
  let log = WME.emptyPullLog();
  log = WME.addPull(log, { at: 1, auto: true, cards: [
    { id: "a", title: "Lyon", rarity: "R", shiny: false }, { id: "b", title: "Rome", rarity: "L", shiny: false }] }, 10);
  log = WME.addPull(log, { at: 2, auto: false, cards: [
    { id: "c", title: "Paris", rarity: "C", shiny: false }, { id: "b", title: "Rome", rarity: "L", shiny: true }] }, 10);
  log = WME.addPull(log, { at: 3, auto: true, cards: [] }, 10); // réponse sans carte lisible : le paquet compte
  assert.deepEqual(log.packs[0].cards, [["a", "R", 0, null], ["b", "L", 0, null]]);

  assert.equal(WME.settlePullPrices(log, priceOf), true);
  assert.equal(WME.settlePullPrices(log, priceOf), false); // déjà figés (le shiny reste sans prix)
  prices.b = 9999; // la cote bouge après l'ouverture : le récap garde le prix figé
  const recap = WME.pullRecap(log, priceOf);
  assert.deepEqual([recap.packs, recap.auto, recap.manual, recap.cards, recap.since], [3, 2, 1, 4, 1]);
  assert.deepEqual(Object.entries(recap.byRarity), [["C", 1], ["R", 1], ["L", 2]]);
  assert.deepEqual([recap.shiny, recap.value, recap.missing], [1, 2640, 1]);
  assert.deepEqual(recap.best.map((c) => [c.title, c.price]), [["Rome", 2500], ["Lyon", 100], ["Paris", 40]]);

  const trimmed = WME.addPull(log, { at: 4, auto: true, cards: [] }, 2); // max 2 : les deux plus anciens partent
  assert.deepEqual(trimmed.packs.map((p) => p.at), [3, 4]);
  assert.deepEqual(trimmed.titles, {});
  assert.equal(WME.pullRecap(WME.emptyPullLog(), priceOf).since, null);
});

test("point de départ repris de l'autre extension : sans double compte, les L+ comptés en L", () => {
  let log = WME.emptyPullLog();
  log = WME.addPull(log, { at: 1, auto: false, cards: [
    { id: "a", title: "Lyon", rarity: "C", shiny: false }, { id: "b", title: "Rome", rarity: "L+", shiny: false }] }, 10);
  // L'autre extension a vu le même paquet : ses compteurs l'incluent déjà.
  const earlier = WME.pullBaseline({ counts: { L: 6, UR: 55, SR: 0, C: 8951, "L+": 1 }, updatedAt: 0 }, log);
  assert.deepEqual(earlier, { L: 6, UR: 55, C: 8950 });
  const recap = WME.pullRecap(log, () => null, earlier);
  assert.equal(recap.earlier, 9011);
  assert.equal(recap.cards, 2);
  assert.deepEqual(Object.entries(recap.byRarity), [["C", 8951], ["UR", 55], ["L", 7]]);
  assert.equal(WME.pullBaseline(null, log), null);
  assert.equal(WME.pullBaseline({ counts: "?" }, log), null);
});

test("budget de lectures : fenêtre glissante, attente jusqu'à la sortie de la plus ancienne", () => {
  const W = 600e3;
  assert.deepEqual(WME.readBudget([], 1000, 3, W), { wait: 0, stamps: [] });
  // Trop vieilles, futures ou illisibles : oubliées.
  assert.deepEqual(WME.readBudget([1, 5000, "x", null], 700e3, 3, W).stamps, []);
  const full = WME.readBudget([300e3, 100e3, 200e3], 400e3, 3, W);
  assert.equal(full.wait, 300e3); // la lecture de t=100 s sort de la fenêtre à t=700 s
  assert.deepEqual(full.stamps, [100e3, 200e3, 300e3]);
  assert.equal(WME.readBudget([100e3, 200e3, 300e3], 400e3, 4, W).wait, 0);
});

test("refus du site : vérification, quota, trop vite", () => {
  assert.equal(WME.siteLimit(403, { error: "human_verification_required" }), "verification");
  assert.equal(WME.siteLimit(403, '{"error":"automation_limit"}'), "automation");
  assert.equal(WME.siteLimit(429, ""), "rate");
  assert.equal(WME.siteLimit(403, { error: "forbidden" }), null);
  assert.equal(WME.siteLimit(500, null), null);
});


test("relevé des refus du site : lectures d'avant, les plus récents d'abord, 50 au plus", () => {
  const now = 1_000_000_000;
  const stamps = [now - 11 * 60e3, now - 9 * 60e3, now - 30e3, now - 5e3, now + 1000];
  assert.equal(WME.countSince(stamps, now, 10 * 60e3), 3);
  assert.equal(WME.countSince(stamps, now, 60e3), 2);
  assert.equal(WME.countSince(null, now, 60e3), 0);
  let log = [];
  for (let i = 0; i < 55; i++) log = WME.addLimitEvent(log, { at: i });
  assert.equal(log.length, 50);
  assert.equal(log[0].at, 54);
});

test("possession des cartes lue dans les réponses du site, sans requête", () => {
  const c = (id) => ({ id, wikipedia_title: `Carte ${id}`, rarity: "R" });
  assert.deepEqual(WME.ownershipIn({ collection: [{ card: c("1") }] }, "/api/my-collection?page=1"), [["1", true]]);
  assert.deepEqual(WME.ownershipIn({ cards: [c("2"), c("3")], ownedCardIds: ["3"] }, "/api/cards?page=1"),
    [["2", false], ["3", true]]);
  assert.deepEqual(WME.ownershipIn({ auctions: [{ card: c("4"), owned: true }, { card: c("5"), owned: false }, { card: c("6") }] },
    "/api/marketplace"), [["4", true], ["5", false]]);
  assert.deepEqual(WME.ownershipIn({ collection: [{ card: c("7"), owned_by_viewer: false }] }, "/api/profile/x/collection"),
    [["7", false]]);
  assert.deepEqual(WME.ownershipIn(null), []);
});
