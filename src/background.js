// Script d'arrière-plan : le seul à parler au serveur de prix partagés (server/, un Cloudflare Worker).
//
// Pourquoi ici ? Le content script (src/content.js) n'a pas le droit d'appeler un autre site que wiki-masters.com ;
// l'arrière-plan, si, une fois l'adresse du serveur autorisée depuis la fenêtre de l'extension (src/popup.js). Le
// jeton reste dans chrome.storage.local, propre à l'extension : le site ne le voit jamais.
//
// Messages reçus (chrome.runtime.sendMessage) :
//   { type: "shared-get", ids, maxAge (s) }  -> { who, items: { id: { read_at, read_by, history } } }
//   { type: "shared-put", items }            -> { who, stored, older, rejected }
//   { type: "shared-stats" }                 -> { who, fresh_cards, days }
// En cas d'échec : { error }.
const SHARED_KEY = "shared"; // { on, url, token }, écrit par la fenêtre
const TIMEOUT_MS = 8000;

async function config() {
  const { [SHARED_KEY]: shared } = await chrome.storage.local.get(SHARED_KEY);
  return shared && shared.on && shared.url && shared.token ? shared : null;
}

async function call(path, init = {}) {
  const cfg = await config();
  if (!cfg) return { error: "partage désactivé" };
  try {
    const response = await fetch(cfg.url.replace(/\/+$/, "") + path, {
      ...init,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { error: (data && data.error) || `HTTP ${response.status}` };
    return data || { error: "réponse illisible" };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("shared-")) return undefined;
  let pending;
  if (message.type === "shared-get" && Array.isArray(message.ids) && message.ids.length) {
    const ids = encodeURIComponent(message.ids.slice(0, 100).join(","));
    pending = call(`/v1/history?ids=${ids}&max_age=${Math.floor(Number(message.maxAge) || 21600)}`);
  } else if (message.type === "shared-put" && Array.isArray(message.items) && message.items.length) {
    pending = call("/v1/history", { method: "POST", body: JSON.stringify({ items: message.items.slice(0, 100) }) });
  } else if (message.type === "shared-stats") {
    pending = call("/v1/stats?days=7");
  } else {
    pending = Promise.resolve({ error: "message inconnu" });
  }
  pending.then(reply);
  return true; // réponse asynchrone
});
