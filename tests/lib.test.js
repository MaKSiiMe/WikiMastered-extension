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
  assert.deepEqual(WME.quotes(history), { L: { avg: 9000, count: 8, week: "2026-11-16" } }); // SR sans prix, XX inconnue
  assert.deepEqual(WME.quotes(null), {});
});

test("semaine en cours : son lundi, en UTC", () => {
  assert.equal(WME.currentWeek(new Date("2026-11-23T10:00:00Z")), "2026-11-23"); // lundi
  assert.equal(WME.currentWeek(new Date("2026-11-29T23:00:00Z")), "2026-11-23"); // dimanche
  assert.equal(WME.currentWeek(new Date("2026-11-30T00:30:00Z")), "2026-11-30");
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
