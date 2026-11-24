// Règles du cache partagé (server/src/logic.js) : `npm test`, sans Cloudflare.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanItem, day, MAX_IDS, parseIds, parseMaxAge, participant } from "../server/src/logic.js";

test("ids : valides, sans doublon, au plus 100", () => {
  assert.deepEqual(parseIds("a1, b-2,a1,,../x,c_3"), ["a1", "b-2", "c_3"]);
  assert.deepEqual(parseIds(null), []);
  assert.equal(parseIds(Array.from({ length: 150 }, (_, i) => `id${i}`).join(",")).length, MAX_IDS);
});

test("âge maximal : 6 h par défaut, borné entre 1 min et 7 jours", () => {
  assert.equal(parseMaxAge(undefined), 21600);
  assert.equal(parseMaxAge("10"), 60);
  assert.equal(parseMaxAge("99999999"), 7 * 24 * 3600);
  assert.equal(parseMaxAge("3600"), 3600);
});

test("une lecture déposée est réduite à computed_at et by_rarity", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const history = { computed_at: "x", by_rarity: { SR: { weekly: [] } }, extra: "ignoré" };
  const item = cleanItem({ id: "abc", read_at: now - 1000, history }, now);
  assert.deepEqual(item, { id: "abc", readAt: now - 1000, body: '{"computed_at":"x","by_rarity":{"SR":{"weekly":[]}}}' });
  assert.equal(cleanItem({ id: "abc", read_at: now + 60e3, history }, now).readAt, now); // horloge en avance
  assert.equal(cleanItem({ id: "abc", read_at: now - 8 * 86400e3, history }, now), null); // trop vieille
  assert.equal(cleanItem({ id: "abc", read_at: now, history: { by_rarity: [] } }, now), null);
  assert.equal(cleanItem({ id: "a/b", read_at: now, history }, now), null);
  const huge = { by_rarity: { SR: { weekly: "x".repeat(70 * 1024) } } };
  assert.equal(cleanItem({ id: "abc", read_at: now, history: huge }, now), null);
});

test("participant : nom du jeton, sinon null", () => {
  const tokens = { s3cr3t: "maxime-ext" };
  assert.equal(participant(tokens, "Bearer s3cr3t"), "maxime-ext");
  assert.equal(participant(tokens, "Bearer autre"), null);
  assert.equal(participant(tokens, "Bearer toString"), null); // pas de propriété héritée
  assert.equal(participant(tokens, null), null);
});

test("jour UTC des compteurs", () => {
  assert.equal(day(Date.parse("2026-11-24T23:59:00Z")), "2026-11-24");
});
