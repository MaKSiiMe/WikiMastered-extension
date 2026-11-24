// Règles du cache partagé, sans Cloudflare ni base : testées par `npm test` à la racine (tests/server.test.js).
//
// Le cache garde, pour chaque carte, la dernière réponse de /api/marketplace/cards/{id}/price-history lue par un
// participant (extension ou bot), telle quelle : chacun en tire son prix (src/lib.js `quotes`, le bot
// `history_quotes`). Rien d'autre : ni pseudo du site, ni cookie, ni collection.

export const MAX_IDS = 100;                 // cartes par requête (une page du site en compte rarement plus)
export const MAX_BODY_BYTES = 64 * 1024;    // une réponse price-history fait quelques Ko
export const MAX_AGE_S = 7 * 24 * 3600;     // on ne sert ni ne garde une lecture de plus de 7 jours
export const DEFAULT_MAX_AGE_S = 6 * 3600;  // fraîcheur par défaut : 6 h, comme l'extension et le bot
export const KEEP_DAYS = 30;                // purge quotidienne des lectures plus anciennes

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Identifiants de cartes d'une liste « a,b,c » : valides, sans doublon, au plus MAX_IDS. -> [] si rien de lisible. */
export function parseIds(raw) {
  const ids = String(raw || "").split(",").map((s) => s.trim()).filter((s) => ID.test(s));
  return [...new Set(ids)].slice(0, MAX_IDS);
}

/** Âge maximal demandé, en secondes, borné à [60 s, 7 j] ; 6 h par défaut. */
export function parseMaxAge(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_AGE_S;
  return Math.min(MAX_AGE_S, Math.max(60, n));
}

/**
 * Une lecture envoyée par un participant : { id, read_at (ms), history: { computed_at?, by_rarity: {…} } }.
 * -> { id, readAt, body (JSON réduit à computed_at et by_rarity) }, ou null si elle n'est pas recevable.
 * readAt est ramené à `now` s'il est dans le futur (horloge en avance), refusé s'il a plus de 7 jours.
 */
export function cleanItem(item, now) {
  if (!item || typeof item !== "object" || !ID.test(String(item.id || ""))) return null;
  const readAt = Math.min(Math.floor(Number(item.read_at)), now);
  if (!Number.isFinite(readAt) || now - readAt > MAX_AGE_S * 1000) return null;
  const history = item.history;
  const byRarity = history && history.by_rarity;
  if (!byRarity || typeof byRarity !== "object" || Array.isArray(byRarity)) return null;
  const body = JSON.stringify({ computed_at: history.computed_at ?? null, by_rarity: byRarity });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return null;
  return { id: String(item.id), readAt, body };
}

/** Jeton -> nom du participant, d'après le secret TOKENS ({ "<jeton>": "maxime-ext", … }). null si inconnu. */
export function participant(tokens, authorization) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(authorization || ""));
  if (!match || !tokens || typeof tokens !== "object") return null;
  const name = Object.hasOwn(tokens, match[1]) ? tokens[match[1]] : null;
  return typeof name === "string" && name ? name : null;
}

/** Jour UTC « 2026-11-24 », pour les compteurs. */
export const day = (now) => new Date(now).toISOString().slice(0, 10);
