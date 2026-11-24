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
  assert.deepEqual(WME.quotes(history, now), { L: { avg: 9000, count: 8, week: "2026-11-16", sales12: 12, low4: 8000, high4: 9000, prev: 8000, trend: [["2026-11-09", 8000], ["2026-11-16", 9000]] } }); // SR sans prix, XX inconnue
  assert.deepEqual(WME.quotes(null), {});
});

test("ventes des 12 dernières semaines (semaine en cours comprise) ; prix fiable : 5 ventes dans la semaine affichée", () => {
  const now = new Date("2026-11-24T12:00:00Z"); // semaine du 23/11 ; la 12e semaine en arrière commence le 07/09
  const history = { by_rarity: { R: { weekly: [
    { start: "2026-08-31", avg: 50, count: 9 }, // 13e semaine : trop vieille
    { start: "2026-09-07", avg: 60, count: 1 },
    { start: "2026-11-16", avg: 70, count: 1 },
  ] } } };
  const q = WME.quotes(history, now).R;
  assert.equal(q.sales12, 2);
  assert.equal(WME.reliable(q), false); // 1 vente dans la semaine affichée
  assert.equal(WME.reliable(q, 1), true);
  assert.equal(WME.reliable({ avg: 9000, count: 5, week: "2026-11-16" }), true);
  assert.equal(WME.reliable(null), false);
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
    R: { avg: 1101, count: 2, week: "2026-11-23", sales12: 2, low4: 1000, high4: 1201, prev: null, trend: [["2026-11-23", 1101]] },
    C: { avg: 300, count: 1, week: "2026-11-16", sales12: 1, low4: 300, high4: 300, prev: null, trend: [["2026-11-16", 300]] },
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
  assert.deepEqual(log.packs[0].cards, [["a", "R", 0, null, null], ["b", "L", 0, null, null]]);

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

test("fiche : fourchette des 4 dernières semaines et semaine précédente", () => {
  const now = new Date("2026-11-24T12:00:00Z"); // 4 semaines : depuis le 02/11
  const history = { by_rarity: { UR: { weekly: [
    { start: "2026-10-26", avg: 2352, min: 450, max: 4177, count: 17 }, // 5e semaine : hors fourchette
    { start: "2026-11-02", avg: 3358, min: 500, max: 6000, count: 74 },
    { start: "2026-11-09", avg: 3837, min: 2420, max: 6000, count: 43 },
    { start: "2026-11-16", avg: 4239, min: 2662, max: 7262, count: 15 },
  ] } } };
  const q = WME.quotes(history, now).UR;
  assert.deepEqual([q.avg, q.low4, q.high4, q.prev], [4239, 500, 7262, 3837]);
});

test("session lue dans les cookies du site, entière ou en morceaux", () => {
  const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `x.${b64url(JSON.stringify({ sub: "u1", exp: 2000000000 }))}.y`;
  const value = "base64-" + b64url(JSON.stringify({ access_token: jwt, expires_at: 2000000000, user: { id: "u1" } }));
  const name = "sb-ref-auth-token";
  assert.deepEqual(WME.sessionFromCookies(`a=b; ${name}=${value}`, name), { token: jwt, userId: "u1", expiresAt: 2e12 });
  const half = Math.floor(value.length / 2);
  assert.equal(WME.sessionFromCookies(`${name}.1=${value.slice(half)}; ${name}.0=${value.slice(0, half)}`, name).userId, "u1");
  assert.equal(WME.sessionFromCookies("a=b", name), null);
  assert.equal(WME.sessionFromCookies(`${name}=pas-du-json`, name), null);
});

test("bilan de la collection : valeur par rareté, plus chères, doublons", () => {
  const rows = [
    ["e1", "ana", "L", 1, 0, 0], ["e2", "ana", "UR", 2, 1, 0], ["e3", "lyon", "R", 1, 0, 0], ["e4", "lyon", "R", 1, 0, 1],
    ["e5", "paris", "C", 1, 0, 0],
  ];
  const prices = { "ana|L": { avg: 9000, sure: true }, "ana|UR": { avg: 4000, sure: false }, "lyon|R": { avg: 50, sure: true } };
  const s = WME.collectionSummary(rows, { ana: "Ana de Armas", lyon: "Lyon" }, (id, r) => prices[`${id}|${r}`] || null);
  assert.equal(s.copies, 6);
  assert.equal(s.distinct, 3);
  assert.equal(s.value, 9000 + 2 * 4000 + 50); // le shiny et la carte sans prix ne comptent pas
  assert.equal(s.unsure, 2);
  assert.equal(s.unpriced, 2);
  assert.deepEqual(s.byRarity.map((r) => r.rarity), ["L", "UR", "R", "C"]);
  assert.deepEqual(s.top.map((c) => `${c.id} ${c.rarity}`), ["ana L", "ana UR", "lyon R"]);
  assert.deepEqual(s.duplicates.map((d) => [d.title, d.copies, d.kept, d.extra, d.locked, d.value]), [
    ["Ana de Armas", 3, "L", "UR, UR", 2, 8000],
    ["Lyon", 2, "R", "R✦", 0, 0],
  ]);
});

test("une mesure par jour de la valeur, 365 jours au plus", () => {
  let h = {};
  for (let d = 1; d <= 5; d++) h = WME.addDailyValue(h, `2026-11-0${d}`, d * 100.4, 3);
  assert.deepEqual(h, { "2026-11-03": 301, "2026-11-04": 402, "2026-11-05": 502 });
});

test("récap de chaque paquet (nouvelles, doublons, valeur) et paquets du jour", () => {
  const day = (h) => new Date(2026, 10, 24, h).getTime(); // 24/11, heure locale
  let log = WME.emptyPullLog();
  log = WME.addPull(log, { at: day(1) - 864e5, auto: false, cards: [{ id: "x", title: "X", rarity: "C" }] }, 100); // la veille
  log = WME.addPull(log, { at: day(10), auto: true, cards: [
    { id: "a", title: "A", rarity: "L", isNew: true }, { id: "b", title: "B", rarity: "C", isNew: false }, { id: "c", title: "C", rarity: "C" },
  ] }, 100);
  const recap = WME.pullRecap(log, (c) => ({ a: 900, b: 5 })[c.id] ?? null, {}, day(12));
  assert.deepEqual(recap.today, { packs: 1, cards: 3, byRarity: { L: 1, C: 2 } });
  assert.equal(recap.last.value, 905);
  assert.equal(recap.last.fresh, 1);
  assert.equal(recap.last.doubles, 1);
  assert.deepEqual(recap.last.cards.map((c) => [c.title, c.isNew]), [["A", true], ["B", false], ["C", null]]);
});

test("filtres de la collection : critères cumulables, prix, tri par valeur", () => {
  const rows = [
    ["e1", "ana", "L", 1, 0, 0, 1], ["e2", "ana", "UR", 1, 0, 0, 1], ["e3", "gif", "R", 1, 0, 0, 2], ["e4", "vide", "C", 2, 0, 0, 0],
    ["e5", "jamais", "PC", 1, 0, 0, 1],
  ];
  const titles = { ana: "Ana de Armas", gif: "Chat animé", vide: "Électrode", jamais: "Rien" };
  const info = (id, r) => ({ "ana|L": { state: "price", avg: 9000, sure: true }, "ana|UR": { state: "price", avg: 4000, sure: false },
    "gif|R": { state: "price", avg: 30, sure: true }, "jamais|PC": { state: "never" } })[`${id}|${r}`] || { state: "unknown" };
  const f = (c) => WME.filterCollection(rows, titles, info, c).items.map((i) => `${i.id}:${i.rarity}`);
  assert.deepEqual(f({}), ["ana:L", "ana:UR", "gif:R", "jamais:PC", "vide:C"]); // par valeur, sans prix à la fin
  assert.deepEqual(f({ duplicates: true }), ["ana:L", "ana:UR", "vide:C"]); // ana en 2 raretés, vide en 2 exemplaires
  assert.deepEqual(f({ noImage: true }), ["vide:C"]);
  assert.deepEqual(f({ gif: true }), ["gif:R"]);
  assert.deepEqual(f({ text: "electrode" }), ["vide:C"]); // accents et majuscules ignorés
  assert.deepEqual(f({ price: "never" }), ["jamais:PC"]);
  assert.deepEqual(f({ price: "range", min: 10, max: 5000 }), ["ana:UR", "gif:R"]);
  assert.deepEqual(f({ rarities: ["L", "R"], sort: "value-asc" }), ["gif:R", "ana:L"]);
  assert.equal(WME.filterCollection(rows, titles, info, { duplicates: true }).count, 3);
});

test("liste de souhaits chiffrée : prix le plus bas connu, coût total", () => {
  const quotes = { a: { L: { avg: 9000 }, R: { avg: 300 } }, b: {}, c: { C: { avg: 5 } } };
  const s = WME.wishlistSummary([{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }],
    (id) => quotes[id] || null, (id) => id === "c");
  assert.deepEqual(s.items.map((i) => [i.id, i.cheapest && i.cheapest.rarity, i.state, i.owned]),
    [["a", "R", "price", false], ["c", "C", "price", true], ["b", null, "never", false], ["d", null, "unknown", false]]);
  assert.equal(s.total, 305);
  assert.deepEqual([s.priced, s.never, s.unknown], [2, 1, 1]);
});

test("marché : bonne affaire (fin proche, 25 % sous la cote) ou surcoté (50 % au-dessus)", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const [a] = WME.auctionsIn({ auctions: [{ card: { id: "x", rarity: "C" }, snapshot_rarity: "sr", is_shiny: false, current_bid: 600,
    base_amount: 100, end_at: "2026-11-24T12:10:00Z" }] });
  assert.deepEqual(a, { cardId: "x", title: "x", rarity: "SR", shiny: false, current: 600, base: 100, endAt: Date.parse("2026-11-24T12:10:00Z") });
  assert.deepEqual(WME.auctionDeal(a, 1000, true, now), { kind: "deal", pct: -34 }); // mise min 660
  assert.equal(WME.auctionDeal(a, 1000, false, now), null); // prix incertain
  assert.equal(WME.auctionDeal({ ...a, endAt: now + 3600e3 }, 1000, true, now), null); // fin trop loin
  assert.deepEqual(WME.auctionDeal({ ...a, current: 0, base: 300 }, 200, true, now), { kind: "high", pct: 50 });
  assert.equal(WME.auctionDeal({ ...a, shiny: true }, 1000, true, now), null);
});

test("filtres : étiquettes (toutes exigées, sans étiquette), souhaits et cartes que je n'ai pas", () => {
  const rows = [["u1", "a", "L", 1, 0, 0, 1], ["u2", "a", "L", 1, 0, 0, 1], ["u3", "b", "R", 1, 0, 0, 1], ["u4", "c", "C", 1, 0, 0, 1]];
  const tags = { u1: ["lieu"], u2: ["religion"], u3: ["lieu"] };
  const info = () => ({ state: "unknown" });
  const f = (c, mine, wished) => WME.filterCollection(rows, {}, info, { sort: "rarity", ...c }, (u) => tags[u] || [], mine, wished).items.map((i) => i.id);
  assert.deepEqual(f({ tags: ["lieu"] }), ["a", "b"]);
  assert.deepEqual(f({ tags: ["lieu", "religion"] }), ["a"]); // les deux étiquettes, sur ses exemplaires à eux tous
  assert.deepEqual(f({ untagged: true }), ["c"]);
  assert.deepEqual(f({ notMine: true }, (id) => ({ a: true, b: false })[id]), ["b"]); // c : inconnu, écartée
  assert.deepEqual(f({ wished: true }, undefined, (id) => id === "c"), ["c"]);
});

test("filtres : raretés de tous les exemplaires d'une carte, exemplaire à vendre", () => {
  const rows = [["u1", "a", "L", 1, 1, 0, 1], ["u2", "a", "UR", 2, 0, 0, 1], ["u3", "a", "UR", 1, 0, 1, 1], ["u4", "b", "R", 1, 0, 0, 1],
    ["u5", "c", "SR", 1, 1, 0, 1], ["u6", "c", "SR", 1, 1, 0, 1]];
  const items = WME.filterCollection(rows, {}, () => ({ state: "unknown" }), { duplicates: true, sort: "rarity" }).items;
  const a = items.find((i) => i.id === "a" && i.rarity === "UR");
  assert.deepEqual(a.variants, [{ rarity: "L", copies: 1, starred: 1, shiny: false }, { rarity: "UR", copies: 2, starred: 0, shiny: false },
    { rarity: "UR", copies: 1, starred: 0, shiny: true }]);
  assert.equal(a.sellCopy, "u2"); // ni favori ni shiny
  assert.equal(items.find((i) => i.id === "a" && i.rarity === "L").sellCopy, null); // favori
  assert.equal(items.find((i) => i.id === "c").sellCopy, null); // deux favoris
  assert.equal(items.find((i) => i.id === "c").starred, 2);
  assert.ok(!items.some((i) => i.id === "b")); // un seul exemplaire : pas un doublon
  assert.equal(WME.filterCollection(rows, {}, () => ({ state: "unknown" }), {}).items.find((i) => i.id === "b").sellCopy, null);
});

test("collection d'un autre joueur lue dans la réponse de son profil", () => {
  const r = WME.friendRows({ collection: [
    { id: "x1", count: 2, is_shiny: false, snapshot_rarity: "ur", owned_by_viewer: false, card: { id: "c1", wikipedia_title: "Lyon", image_url: "a.gif" } },
    { id: "x2", card: { id: "c2", wikipedia_title: "Paris", rarity: "C" }, owned_by_viewer: true }, { card: null }] });
  assert.deepEqual(r.rows, [["x1", "c1", "UR", 2, 0, 0, 2], ["x2", "c2", "C", 1, 0, 0, 0]]);
  assert.deepEqual(r.mine, { c1: false, c2: true });
  assert.deepEqual(r.titles, { c1: "Lyon", c2: "Paris" });
  assert.equal(r.tagsSeen, false);
  const t = WME.friendRows({ tagOptions: [{ id: "t1", name: "Lieu" }], collection: [
    { id: "x1", card: { id: "c1" }, tags: [{ id: "t1", name: "Lieu" }, { id: "t2", name: "Babie" }] }, { id: "x2", card: { id: "c2" }, tags: ["t1"] }] });
  assert.deepEqual([t.tags, t.tagNames, t.tagsSeen], [{ x1: ["t1", "t2"], x2: ["t1"] }, { t1: "Lieu", t2: "Babie" }, true]);
});

test("familles : progression, coût des manquantes, code de partage", () => {
  const cards = [{ id: "a", title: "Mars" }, { id: "b", title: "Vénus" }, { id: "c", title: "Pluton" }];
  const p = WME.familyProgress(cards, { a: { owned: true }, b: { owned: false, cheapest: { rarity: "C", avg: 12 } }, c: { owned: false, cheapest: null } });
  assert.deepEqual([p.total, p.owned, p.cost, p.unpriced, p.missing.map((m) => m.id)], [3, 1, 12, 1, ["b", "c"]]);
  const code = WME.familyCode({ name: "Planètes", cards });
  assert.ok(code.startsWith("WME-F1."));
  assert.deepEqual(WME.readFamilyCode(code), { name: "Planètes", cards });
  assert.equal(WME.readFamilyCode("n'importe quoi"), null);
});
