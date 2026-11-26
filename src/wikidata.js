// Wikipédia et Wikidata pour les étiquettes de thème (src/content.js, autoTag). Aucune requête au site du jeu : rien
// ne compte pour sa vérification anti-bot.
// - chaque carte : l'API de Wikipédia (fr) donne l'élément Wikidata de son titre (redirections suivies), puis SPARQL ses
//   liens directs « est un » (P31), « sous-classe de » (P279), « métier » (P106), « taxon parent » (P171) et sa
//   description en français ;
// - les classes et taxons atteints : leurs parents (P279, P171), lus une fois et gardés (src/lib.js, hierarchy).
// - les GIF : nombre d'images du fichier (1 : image fixe, pas d'étiquette « GIF »).
// Les deux services répondent aux pages d'autres sites (CORS « * ») : aucun droit d'accès en plus. Requêtes espacées
// d'au moins une seconde ; une erreur remonte, la lecture reprend au passage suivant.
const WMW = (() => {
  const WIKIPEDIA = "https://fr.wikipedia.org/w/api.php";
  const SPARQL = "https://query.wikidata.org/sparql";
  const BATCH = 50; // titres par requête à Wikipédia (limite de l'API)
  const ITEMS_BATCH = 100; // éléments par requête SPARQL
  const PARENTS_BATCH = 200;
  const SPACING_MS = 1000;
  const ENTITY = "http://www.wikidata.org/entity/";
  const CLAIMS = { P31: "p31", P279: "p279", P106: "p106", P171: "p171" };

  let last = 0;
  async function request(url, init) {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let response;
    try {
      response = await fetch(url, { credentials: "omit", ...init });
    } finally {
      last = Date.now();
    }
    if (!response.ok) throw new Error(`${new URL(url).hostname} : HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (_) {
      // Requête trop longue : le service SPARQL coupe la réponse en plein JSON, avec un statut 200.
      throw new Error(`${new URL(url).hostname} : réponse coupée`);
    }
  }

  const wiki = (params) => request(`${WIKIPEDIA}?${new URLSearchParams({ ...params, format: "json", formatversion: "2", origin: "*" })}`);

  async function sparql(query) {
    const data = await request(SPARQL, {
      method: "POST",
      headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query, format: "json" }),
    });
    if (!data || !data.results || !Array.isArray(data.results.bindings)) throw new Error("Wikidata : réponse sans résultats");
    return data.results.bindings;
  }

  const qidOf = (uri) => String(uri).split("/").pop();
  const values = (ids) => ids.map((q) => `wd:${q}`).join(" ");

  /** Élément Wikidata de chaque titre (fr), redirections suivies : { titre: Q… | null }. */
  async function qids(titles) {
    const out = {};
    for (let i = 0; i < titles.length; i += BATCH) {
      const chunk = titles.slice(i, i + BATCH);
      const data = await wiki({ action: "query", titles: chunk.join("|"), prop: "pageprops", ppprop: "wikibase_item", redirects: "1" });
      const query = (data && data.query) || {};
      const moves = {};
      for (const key of ["normalized", "redirects"]) for (const m of query[key] || []) moves[m.from] = m.to;
      const pages = {};
      for (const p of query.pages || []) pages[p.title] = (p.pageprops && p.pageprops.wikibase_item) || null;
      for (const title of chunk) {
        let final = title;
        const seen = new Set();
        while (Object.hasOwn(moves, final) && !seen.has(final)) {
          seen.add(final);
          final = moves[final];
        }
        out[title] = pages[final] || null;
      }
    }
    return out;
  }

  /** Liens directs et description de chaque élément : { Q: { q, p31, p279, p106, p171, d } }. */
  async function claims(ids) {
    const items = [...new Set(ids)].sort();
    const out = Object.fromEntries(items.map((q) => [q, { q, p31: [], p279: [], p106: [], p171: [], d: "" }]));
    const props = Object.keys(CLAIMS).map((p) => `wdt:${p}`).join(" ");
    for (let i = 0; i < items.length; i += ITEMS_BATCH) {
      const rows = await sparql(`SELECT ?item ?p ?o WHERE {
  VALUES ?item { ${values(items.slice(i, i + ITEMS_BATCH))} }
  { VALUES ?p { ${props} } ?item ?p ?o. FILTER(STRSTARTS(STR(?o), "${ENTITY}Q")) }
  UNION { ?item schema:description ?o. FILTER(lang(?o) = "fr") BIND("description" AS ?p) }
}`);
      for (const row of rows) {
        const c = out[qidOf(row.item.value)];
        const prop = qidOf(row.p.value);
        if (!c) continue;
        if (prop === "description") c.d = row.o.value;
        else if (CLAIMS[prop]) c[CLAIMS[prop]].push(qidOf(row.o.value));
      }
    }
    return out;
  }

  /** Parents directs (P279 ou P171) de chaque élément : { Q: [parents] } ([] : aucun). */
  async function parents(ids, prop) {
    const items = [...new Set(ids)].sort();
    const out = Object.fromEntries(items.map((q) => [q, []]));
    for (let i = 0; i < items.length; i += PARENTS_BATCH) {
      const rows = await sparql(`SELECT ?item ?parent WHERE {
  VALUES ?item { ${values(items.slice(i, i + PARENTS_BATCH))} }
  ?item wdt:${prop} ?parent. FILTER(STRSTARTS(STR(?parent), "${ENTITY}Q"))
}`);
      for (const row of rows) {
        const item = qidOf(row.item.value);
        if (out[item]) out[item].push(qidOf(row.parent.value));
      }
    }
    return out;
  }

  /** Lit, niveau par niveau, les parents qui manquent pour classer ces éléments (h : WME.hierarchy) ; onRead(prop,
   * trouvés) après chaque requête, pour garder la progression même si la suivante échoue. */
  async function fill(h, list, onRead = async () => {}) {
    for (const prop of ["P279", "P171"]) {
      for (let todo = [...h.missing(list, prop)].sort(); todo.length; todo = [...h.missing(list, prop)].sort()) {
        for (let i = 0; i < todo.length; i += PARENTS_BATCH) {
          const found = await parents(todo.slice(i, i + PARENTS_BATCH), prop);
          h.add(prop, found);
          await onRead(prop, found);
        }
      }
    }
  }

  /** Nombre d'images de chaque fichier GIF : { fichier: n | null (introuvable) }. */
  async function gifFrames(files) {
    const out = {};
    for (let i = 0; i < files.length; i += BATCH) {
      const chunk = files.slice(i, i + BATCH);
      const moves = {};
      const frames = {};
      let more = {};
      for (let round = 0; round < 20; round++) { // métadonnées trop longues pour une réponse : la suite dans « continue »
        const data = await wiki({ action: "query", titles: chunk.map((f) => `File:${f}`).join("|"), prop: "imageinfo", iiprop: "metadata", ...more });
        const query = (data && data.query) || {};
        for (const m of query.normalized || []) moves[m.from] = m.to;
        for (const page of query.pages || []) {
          const info = (page.imageinfo || [])[0];
          const meta = info && Array.isArray(info.metadata) ? info.metadata.find((m) => m.name === "frameCount") : null;
          if (meta) frames[page.title] = Number(meta.value);
        }
        more = (data && data.continue) || null;
        if (!more) break;
      }
      for (const file of chunk) {
        const title = `File:${file}`;
        const n = frames[moves[title] || title];
        out[file] = Number.isFinite(n) ? n : null;
      }
    }
    return out;
  }

  return { qids, claims, fill, gifFrames };
})();
