// Tests des fonctions pures : `npm test`. Aucun navigateur, aucune requête au site.
const test = require("node:test");
const assert = require("node:assert/strict");
const WME = require("../src/lib.js");

test("la cote suit le calcul du bot : semaines récentes jusqu'à 10 ventes", () => {
  const history = {
    by_rarity: {
      L: { weekly: [
        { start: "2026-11-16", avg: 9000, count: 8 },
        { start: "2026-11-09", avg: 8000, count: 4 },  // 12 ventes atteintes ici : on s'arrête
        { start: "2026-11-02", avg: 1, count: 50 },
      ] },
      SR: { weekly: [{ start: "2026-11-16", avg: 0, count: 3 }, { start: "2026-11-09", avg: 300, count: 0 }] },
      XX: { weekly: [{ start: "2026-11-16", avg: 5, count: 5 }] },
    },
  };
  const q = WME.quotes(history);
  assert.deepEqual(Object.keys(q), ["L"]); // SR sans vente valable, XX inconnue
  assert.equal(Math.round(q.L.avg), Math.round((9000 * 8 + 8000 * 4) / 12));
  assert.equal(q.L.count, 12);
  assert.deepEqual(WME.quotes(null), {});
});

test("au plus 4 semaines pour une carte peu vendue", () => {
  const weekly = [1, 2, 3, 4, 5].map((i) => ({ start: `2026-10-0${i}`, avg: 100 * i, count: 1 }));
  const q = WME.quotes({ by_rarity: { R: { weekly } } });
  assert.equal(q.R.count, 4);
  assert.equal(q.R.avg, (200 + 300 + 400 + 500) / 4); // la plus ancienne (100) est écartée
});

test("les cartes sont lues dans toutes les réponses du site", () => {
  const c = (id, title, rarity = "R") => ({ id, wikipedia_title: title, rarity });
  const cards = [
    ...WME.cardsIn({ collection: [{ card: c("1", "Napoléon"), is_shiny: true }, { card: null }] }),
    ...WME.cardsIn({ auctions: [{ card: c("2", "Lyon", "SR"), snapshot_rarity: "ur" }] }),
    ...WME.cardsIn({ cards: [c("3", "Paris", "L")] }),
    ...WME.cardsIn({ card: c("4", "Rome"), snapshot_rarity: "PC" }),
  ];
  assert.deepEqual(cards.map((x) => [x.id, x.title, x.rarity, x.shiny]), [
    ["1", "Napoléon", "R", true],
    ["2", "Lyon", "UR", false], // la rareté de la vente, pas celle du catalogue
    ["3", "Paris", "L", false],
    ["4", "Rome", "PC", false],
  ]);
  assert.deepEqual(WME.cardsIn("pas un objet"), []);
});

test("liste de souhaits chez les amis : classés par nombre de cartes, raretés filtrées", () => {
  const owner = (username, ...rarities) => ({ id: "u-" + username, username, rarities });
  const pages = [
    {
      cards: [{ id: "a", wikipedia_title: "Napoléon" }, { id: "b", wikipedia_title: "Lyon" }],
      friendOwners: { a: [owner("alice", "sr", "L"), owner("bob", "C")], b: [owner("alice", "R")] },
    },
    { cards: [{ id: "a", wikipedia_title: "Napoléon" }], friendOwners: { a: [owner("carl", "UR")] } }, // déjà vue
  ];
  assert.deepEqual(WME.friendsFromCatalog(pages), [
    { name: "alice", cards: [{ id: "a", title: "Napoléon", rarities: ["L", "SR"] }, { id: "b", title: "Lyon", rarities: ["R"] }] },
    { name: "bob", cards: [{ id: "a", title: "Napoléon", rarities: ["C"] }] },
  ]);
  const high = WME.friendsFromCatalog(pages, "SR");
  assert.deepEqual(high.map((f) => [f.name, f.cards.map((c) => c.rarities)]), [["alice", [["L", "SR"]]]]);
});

test("montants courts pour les badges", () => {
  assert.equal(WME.wb(1250).replace(/\s/g, " "), "1 250");
  assert.equal(WME.wb(12500).replace(/\s/g, " "), "12,5 k");
  assert.equal(WME.wb(NaN), "?");
});
