// Garde-fou : toute fonction appelée dans un script de l'extension doit y être déclarée (ou venir du navigateur).
// En 0.9.2, une réécriture avait effacé la lecture de la liste de souhaits et des filtres sans qu'aucun test ne le
// voie : les appels restaient, les fonctions n'existaient plus. Analyse simple par expressions régulières, sans
// dépendance : elle ne remplace pas un vrai analyseur, mais attrape ce genre d'oubli.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const GLOBALS = new Set(`fetch setTimeout clearTimeout setInterval clearInterval Promise Object Array Number String Boolean Math
  Date JSON Map Set WeakMap URL URLSearchParams Headers Blob encodeURIComponent decodeURIComponent getComputedStyle Error
  TypeError RegExp isFinite isNaN parseInt parseFloat atob btoa TextEncoder TextDecoder confirm alert structuredClone
  AbortSignal Symbol Uint8Array CSS requestAnimationFrame queueMicrotask MessageEvent MutationObserver Intl FileReader
  require Event CustomEvent KeyboardEvent MouseEvent InputEvent PointerEvent`.split(/\s+/));
const KEYWORDS = new Set("if for while switch catch function return typeof new await async super import export do else of".split(" "));

function declared(source) {
  const names = new Set();
  const add = (list) => { for (const n of String(list).match(/[A-Za-z_$][\w$]*/g) || []) names.add(n); };
  for (const m of source.matchAll(/function\*?\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) add(m[1]); // déstructuration
  for (const m of source.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) add(m[1]); // paramètres
  for (const m of source.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*=>/g)) add(m[1]);
  for (const m of source.matchAll(/([\w$]+)\s*=>/g)) names.add(m[1]);
  for (const m of source.matchAll(/catch\s*\(([\w$]+)\)/g)) names.add(m[1]);
  for (const m of source.matchAll(/([\w$]+)\s*=\s*(?:async\s*)?\([^()]*\)\s*=>/g)) names.add(m[1]); // paramètre par défaut fonction
  for (const m of source.matchAll(/for\s*\(\s*(?:const|let|var)\s*([^;]*?)\s+(?:of|in)\s/g)) add(m[1]);
  return names;
}

function called(source) {
  // Sans commentaires ni texte : des chaînes, on ne garde que les expressions des gabarits (${…}).
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, (t) => [...t.matchAll(/\$\{([^{}]*)\}/g)].map((m) => ` ${m[1]} `).join(";"))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    // expressions régulières littérales (après un opérateur ou une ouverture)
    .replace(/(^|[(,=:[!&|?{};]\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/gm, "$1/x/");
  const out = new Set();
  for (const m of clean.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!KEYWORDS.has(m[1]) && !/^[A-Z]+$/.test(m[1])) out.add(m[1]); // MAJUSCULES : jamais des fonctions ici
  return out;
}

const lib = fs.readFileSync(path.join(__dirname, "..", "src", "lib.js"), "utf8");
for (const file of ["lib.js", "content.js", "panel.js", "background.js", "inject.js", "click.js", "wikidata.js"]) {
  test(`${file} : toute fonction appelée est déclarée`, () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
    const known = declared(source);
    const missing = [...called(source)].filter((n) => !known.has(n) && !GLOBALS.has(n) && !(file !== "lib.js" && declared(lib).has(n) && n === "WME"));
    assert.deepEqual(missing, [], `appelées sans déclaration dans src/${file} : ${missing.join(", ")}`);
  });
}
