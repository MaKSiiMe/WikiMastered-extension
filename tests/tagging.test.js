// Étiquettes automatiques : mêmes résultats que le bot WikiMastered (tests/test_themes.py, repris cas par cas).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const WME = require("../src/lib.js");

const RULES = new Function(`${fs.readFileSync(path.join(__dirname, "..", "src", "themes.js"), "utf8")}; return WME_THEMES;`)();
const facts = (q, natures = [], { jobs = [], taxa = [], description = "" } = {}) =>
  ({ q, natures: new Set(natures), jobs: new Set(jobs), taxa: new Set(taxa), description });
const person = (description, jobs = []) => facts("Q1", ["Q5", "Q729"], { jobs, description });

test("noms d'étiquettes comparés sans émojis, dièse, espaces ni casse", () => {
  assert.equal(WME.tagKey("🎵 Musique"), "musique");
  assert.equal(WME.tagKey("#musique"), "musique");
  assert.equal(WME.tagKey("MUSIQUE "), "musique");
  assert.equal(WME.tagKey("🗺️ Pays"), "pays");
  assert.equal(WME.tagKey("Astéroïde ☄️"), "astéroïde");
  assert.equal(WME.tagKey("🗓️ Année"), "année");
});

test("mots de la description", () => {
  assert.ok(WME.describes("footballeuse française", ["footballeu"]));
  assert.ok(WME.describes("auteure-compositrice-interprète", ["interprète"]));
  assert.ok(!WME.describes("djihadiste français", ["dj"]) && WME.describes("DJ et producteur", ["dj"]));
  assert.ok(!WME.describes("missionnaire", ["miss"]) && WME.describes("Miss France 2016", ["miss"]));
  assert.ok(WME.describes("pilote automobile italien", ["pilote automobile"]));
  assert.ok(!WME.describes("écrivain et aviateur", ["pilote automobile"]));
});

test("thèmes d'après Wikidata, comme le bot", () => {
  const cases = [
    [person("actrice, productrice et mannequin israélienne"), ["Personne", "Cinéma / Série"]],
    [person("écrivain, philosophe et journaliste français", ["Q2066131", "Q33999"]), ["Personne", "Littérature / BD"]],
    [person("", ["Q2066131"]), ["Personne", "Sport"]],
    [person("rappeur et chanteur français"), ["Personne", "Musique"]],
    [person("femme politique française"), ["Personne", "Politique"]],
    [person("actrice, réalisatrice, scénariste et écrivaine française"), ["Personne", "Cinéma / Série", "Littérature / BD"]],
    [person("pasteur et homme d'État allemand"), ["Personne", "Politique", "Religion"]],
    [person("compositeur, musicien, disc-jockey et producteur italien"), ["Personne", "Musique"]],
    [facts("Q17", ["Q6256", "Q23442", "Q56061", "Q271669"]), ["Pays"]],
    [facts("Q140", [], { taxa: ["Q729"] }), ["Animal"]],
    [facts("Q49740", ["Q7889", "Q7397"]), ["Jeu vidéo"]],
    [facts("Q243", ["Q41176", "Q811979", "Q8205328", "Q570116"]), ["Lieu"]],
    [facts("Q1", ["Q39546"]), ["Objet"]],
    [facts("Q4", ["Q16970", "Q41176", "Q811979", "Q8205328"]), ["Lieu", "Religion"]],
    [facts("Q5", ["Q55488", "Q41176", "Q811979", "Q8205328"]), ["Lieu", "Transport"]],
    [facts("Q6", ["Q1114461", "Q95074"]), ["Littérature / BD", "Personnage de fiction"]],
    [facts("Q7", ["Q177597", "Q11446", "Q8205328"]), ["Militaire"]],
    [facts("Q2", ["Q178561", "Q13418847"]), ["Histoire"]],
    [facts("Q3", ["Q14795564"]), []],
  ];
  for (const [f, expected] of cases) assert.deepEqual(WME.themesOf(f, RULES), expected, f.description || f.q);
  assert.deepEqual(RULES.themes.filter((t) => t.removable).map((t) => t.name), ["Objet"]);
});

test("la hiérarchie atteint les classes comme les chemins SPARQL", () => {
  const tree = WME.hierarchy({ P279: { Q10: ["Q11"], Q11: ["Q12", "Q10"], Q12: [], Q20: ["Q21"], Q21: [], Q30: ["Q31"], Q31: [] },
    P171: { Q40: ["Q41"], Q41: [] } });
  const item = { q: "Q1", p31: ["Q10"], p279: ["Q30"], p106: ["Q20"], p171: ["Q40"] };
  assert.ok(tree.complete(item));
  const f = tree.facts(item, { natures: new Set(["Q1", "Q10", "Q12", "Q31", "Q21"]), jobs: new Set(["Q21", "Q12"]), taxa: new Set(["Q1", "Q41"]) });
  assert.deepEqual([...f.natures].sort(), ["Q10", "Q12", "Q31"]);
  assert.deepEqual([...f.jobs], ["Q21"]);
  assert.deepEqual([...f.taxa].sort(), ["Q1", "Q41"]);
  assert.ok(!tree.complete({ q: "Q2", p31: ["Q99"] }));
  assert.deepEqual([...tree.missing([{ p31: ["Q10", "Q98"] }], "P279")], ["Q98"]);
});

test("fichier GIF d'une vignette ou de l'original", () => {
  const base = "https://upload.wikimedia.org/wikipedia/commons/";
  assert.equal(WME.gifFile(`${base}thumb/2/23/Franks_expansion.gif/330px-Franks_expansion.gif?utm_source=x`), "Franks_expansion.gif");
  assert.equal(WME.gifFile(`${base}2/23/Caf%C3%A9.GIF`), "Café.GIF");
  assert.equal(WME.gifFile(`${base}x.jpg`), "");
  assert.equal(WME.gifFile(""), "");
});

// Lignes de collection : [exemplaire, carte, rareté, nombre, favori, shiny, image, fichier GIF], de la plus récente à
// la plus ancienne.
const row = (copy, card, { rarity = "R", starred = 0, shiny = 0, image = 1, gif } = {}) => [copy, card, rarity, 1, starred, shiny, image, ...(gif ? [gif] : [])];

test("exemplaire gardé : favori, shiny, plus haute rareté, puis le plus ancien", () => {
  const groups = WME.copiesByCard([
    row("new", "a"), row("old", "a"), row("ur", "b"), row("l", "b", { rarity: "L" }), row("sh", "b", { shiny: 1 }), row("fav", "b", { starred: 1, rarity: "C" }),
  ], { a: "A", b: "B" });
  assert.deepEqual(groups.get("a").map((c) => c.copy), ["old", "new"]);
  assert.deepEqual(groups.get("b").map((c) => c.copy), ["fav", "sh", "l", "ur"]);
});

test("« Doublon » sur les exemplaires en trop, retiré de l'exemplaire gardé ; thèmes sur le gardé", () => {
  const tags = { k1: ["Doublon"], n1: [] };
  const groups = WME.copiesByCard([row("n1", "c"), row("k1", "c"), row("solo", "d")], { c: "Paris", d: "Inconnue" }, (copy) => tags[copy] || []);
  const plan = WME.tagPlan(groups, { Paris: ["Lieu"] }, { duplicate: "Doublon" });
  assert.deepEqual(plan.add.map(([c, t]) => [c.copy, t]), [["k1", "Lieu"], ["n1", "Doublon"]]);
  assert.deepEqual(plan.remove.map(([c, t]) => [c.copy, t]), [["k1", "Doublon"]]);
});

test("un thème retirable ne part qu'une fois un autre thème posé", () => {
  const tags = { p: ["📦 Objet", "Transport"], a: ["Objet"], v: ["Objet"], s: ["Objet"], i: ["Objet", "Lieu"], d1: ["Transport"], d2: ["Objet"] };
  const groups = WME.copiesByCard([row("p", "posee"), row("a", "attente"), row("v", "vrai"), row("s", "seule"), row("i", "inconnue"), row("d2", "doublon"), row("d1", "doublon")],
    { posee: "gare", attente: "attente", vrai: "vrai", seule: "seule", inconnue: "pas encore lue", doublon: "doublon" }, (copy) => tags[copy] || []);
  const themes = { gare: ["Lieu", "Transport"], attente: ["Transport"], vrai: ["Objet"], seule: [], doublon: ["Transport"] };
  const plan = WME.tagPlan(groups, themes, { removable: ["Objet"] });
  assert.deepEqual(plan.remove.map(([c, t]) => [c.copy, t]), [["p", "Objet"], ["d2", "Objet"]]);
  assert.ok(plan.add.some(([c, t]) => c.copy === "a" && t === "Transport"));
  assert.equal(WME.tagPlan(groups, themes).remove.length, 0);
});

test("« GIF » seulement sur l'exemplaire gardé d'une carte vraiment animée", () => {
  const frames = { "Anim.gif": 17, "Fixe.gif": 1 };
  const tags = { d1: ["🎞️ GIF"], d2: ["GIF"], f1: ["GIF"], j1: ["GIF"], u1: ["GIF"], i1: ["GIF"] };
  const groups = WME.copiesByCard([
    row("n1", "new", { image: 2, gif: "Anim.gif" }), row("d2", "dup", { image: 2, gif: "Anim.gif" }), row("d1", "dup", { image: 2, gif: "Anim.gif" }),
    row("f1", "fixed", { image: 2, gif: "Fixe.gif" }), row("j1", "jpg"), row("u1", "unread", { image: 2, gif: "Inconnu.gif" }), row("i1", "no-image", { image: 0 }),
  ], {}, (copy) => tags[copy] || []);
  const plan = WME.tagPlan(groups, {}, { gif: "GIF", frames });
  assert.deepEqual(plan.add.map(([c, t]) => [c.copy, t]), [["n1", "GIF"]]);
  assert.deepEqual(plan.remove.map(([c]) => c.copy).sort(), ["d2", "f1", "j1"]);
  const none = WME.tagPlan(groups, {}, { frames });
  assert.equal(none.add.length + none.remove.length, 0);
});

test("filtres : nombre de cartes affichées", () => {
  const rows = Array.from({ length: 400 }, (_, i) => [String(i), `c${i}`, "C", 1, 0, 0, 1]);
  const titles = Object.fromEntries(rows.map((r) => [r[1], `Carte ${r[1]}`]));
  const run = (limit) => WME.filterCollection(rows, titles, () => ({ state: "unknown" }), { limit, price: "all", rarities: [], tags: [] });
  assert.equal(run(undefined).items.length, 300);
  assert.equal(run(50).items.length, 50);
  assert.equal(run(0).items.length, 400);
  assert.equal(run(0).count, 400);
});
