// Cache de prix partagé (Cloudflare Worker + base D1) : voir server/README.md.
//
//   GET  /v1/history?ids=a,b,c&max_age=21600  -> { who, items: { "<id>": { read_at, read_by, history } } }
//   POST /v1/history  { items: [{ id, read_at, history }] }  -> { who, stored }
//   GET  /v1/stats?days=7  -> { who, cards, days: [{ day, who, asked, served, stored }] }
//
// Chaque requête porte « Authorization: Bearer <jeton> » ; les jetons vivent dans le secret TOKENS (JSON
// { "<jeton>": "<nom>" }), jamais dans le dépôt.
import { cleanItem, day, KEEP_DAYS, MAX_IDS, parseIds, parseMaxAge, participant } from "./logic.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

let tokensCache = null;
function tokens(env) {
  if (!tokensCache) {
    try {
      tokensCache = JSON.parse(env.TOKENS || "{}");
    } catch (_) {
      tokensCache = {};
    }
  }
  return tokensCache;
}

// Compteurs du jour, par participant : cartes demandées, servies depuis le cache, lectures déposées.
function count(env, who, now, { asked = 0, served = 0, stored = 0 }) {
  return env.DB.prepare(
    "INSERT INTO stats (day, who, asked, served, stored) VALUES (?1, ?2, ?3, ?4, ?5) " +
    "ON CONFLICT (day, who) DO UPDATE SET asked = asked + excluded.asked, served = served + excluded.served, " +
    "stored = stored + excluded.stored",
  ).bind(day(now), who, asked, served, stored).run();
}

async function getHistory(env, who, url, now) {
  const ids = parseIds(url.searchParams.get("ids"));
  if (!ids.length) return json({ error: "ids attendus (au plus " + MAX_IDS + ")" }, 400);
  const since = now - parseMaxAge(url.searchParams.get("max_age")) * 1000;
  const { results } = await env.DB.prepare(
    "SELECT card_id, read_at, read_by, body FROM history " +
    "WHERE card_id IN (SELECT value FROM json_each(?1)) AND read_at >= ?2",
  ).bind(JSON.stringify(ids), since).all();
  const items = {};
  for (const row of results) {
    items[row.card_id] = { read_at: row.read_at, read_by: row.read_by, history: JSON.parse(row.body) };
  }
  await count(env, who, now, { asked: ids.length, served: results.length });
  return json({ who, items });
}

async function postHistory(env, who, request, now) {
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ error: "JSON attendu" }, 400);
  }
  const raw = Array.isArray(payload && payload.items) ? payload.items.slice(0, MAX_IDS) : [];
  const items = raw.map((item) => cleanItem(item, now)).filter(Boolean);
  let stored = 0;
  if (items.length) {
    // Une lecture plus ancienne que celle déjà gardée ne la remplace pas (deux participants, ordre d'arrivée).
    const upsert = env.DB.prepare(
      "INSERT INTO history (card_id, read_at, read_by, body) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (card_id) DO UPDATE SET read_at = excluded.read_at, read_by = excluded.read_by, " +
      "body = excluded.body WHERE excluded.read_at > history.read_at",
    );
    const results = await env.DB.batch(items.map((i) => upsert.bind(i.id, i.readAt, who, i.body)));
    stored = results.reduce((sum, r) => sum + ((r.meta && r.meta.changes) || 0), 0);
    await count(env, who, now, { stored });
  }
  // stored : lectures gardées ; les autres valides étaient plus anciennes que celle du cache.
  return json({ who, stored, older: items.length - stored, rejected: raw.length - items.length });
}

async function getStats(env, who, url, now) {
  const days = Math.min(90, Math.max(1, Math.floor(Number(url.searchParams.get("days")) || 7)));
  const from = day(now - (days - 1) * 86400e3);
  const [{ results }, cards] = await Promise.all([
    env.DB.prepare("SELECT day, who, asked, served, stored FROM stats WHERE day >= ?1 ORDER BY day DESC, who")
      .bind(from).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM history WHERE read_at >= ?1").bind(now - 6 * 3600e3).first(),
  ]);
  return json({ who, fresh_cards: cards ? cards.n : 0, days: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const who = participant(tokens(env), request.headers.get("authorization"));
    if (!who) return json({ error: "jeton inconnu" }, 401);
    const now = Date.now();
    try {
      if (url.pathname === "/v1/history" && request.method === "GET") return await getHistory(env, who, url, now);
      if (url.pathname === "/v1/history" && request.method === "POST") return await postHistory(env, who, request, now);
      if (url.pathname === "/v1/stats" && request.method === "GET") return await getStats(env, who, url, now);
      return json({ error: "route inconnue" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "erreur du serveur" }, 500);
    }
  },

  // Purge quotidienne (wrangler.toml, [triggers]) : lectures de plus de KEEP_DAYS jours, compteurs de plus de 90 jours.
  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM history WHERE read_at < ?1").bind(now - KEEP_DAYS * 86400e3),
      env.DB.prepare("DELETE FROM stats WHERE day < ?1").bind(day(now - 90 * 86400e3)),
    ]);
  },
};
