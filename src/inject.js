// Ce script tourne DANS la page du site (« world: MAIN » dans manifest.json), avant le code du site.
//
// Pourquoi ? Un content script normal vit dans un monde isolé : il voit la page (le DOM) mais pas les variables ni
// les requêtes du site. Pour savoir quelles cartes la page affiche, on « écoute » les réponses de l'API du site :
// on enveloppe window.fetch, et chaque réponse intéressante est recopiée vers le content script (src/content.js) par
// window.postMessage. Rien n'est modifié : le site reçoit exactement la même réponse qu'avant.
(() => {
  if (window.__wmeHooked) return; // déjà installé (rechargement partiel de la page)
  window.__wmeHooked = true;

  // Toutes les réponses de l'API du site : src/lib.js y cherche les cartes, où qu'elles soient (collection, marché,
  // vitrines…). L'historique des prix et les dernières ventes d'une fiche ouverte (onglet « Marché ») sont recopiés
  // à part : src/content.js en reprend le prix et la médiane sans requête.
  const WATCHED = /\/api\//i;
  const PRICE_HISTORY = /\/api\/marketplace\/cards\/[^/?#]+\/price-history/i;
  const SALES = /\/api\/marketplace\/cards\/[^/?#]+\/sales(?:[/?#]|$)/i;

  // Ouverture d'un paquet : POST /api/packs/open (relevé dans l'onglet Réseau du site).
  const PACK_OPEN_URL = /\/api\/packs\/open(?:[/?#]|$)/i;
  // Lectures que le site fait en POST et dont on recopie la réponse : son profil (paquets restants, dernière
  // régénération ; relu par le site toutes les ~15 s) et la progression des succès (page /achievements).
  const PROFILE_URL = /\/rest\/v1\/rpc\/get_my_profile(?:[/?#]|$)/i;
  const ACHIEVEMENTS_URL = /\/api\/achievements\/check(?:[/?#]|$)/i;

  // Le content script démarre plus tard (« document_idle ») : les réponses arrivées avant sont gardées et renvoyées
  // quand il annonce qu'il écoute. Les renvoyer deux fois ne gêne pas : il note simplement les mêmes cartes.
  const BUFFER_MAX = 20;
  const buffer = [];
  const forward = (message) => window.postMessage(message, location.origin);

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data && event.data.source === "wme-content" && event.data.type === "ready") {
      buffer.forEach(forward);
    }
  });

  // Vérification humaine demandée par le site : son signal est « human_verification_required » dans le corps de la
  // réponse (relevé dans la doc d'API de LeadOn/Wikimasters-Toolbox et le bot AirKyzzZ/wikimasters-bot). Un 403 seul
  // ne suffit pas : il peut aussi vouloir dire « quota dépassé » (automation_limit).
  const looksLikeChallenge = (raw) => /human_verification_required/i.test(raw || "");

  // Limites de l'ouverture de paquets : trop vite (429, ou rate_limited avec retry_after, une date ISO) ou limite
  // quotidienne (rate_limit_daily). -> { retryAt (date en ms, ou null), daily } ; null si la réponse n'en parle pas.
  function packLimit(response, parsed) {
    const daily = Boolean(parsed && parsed.rate_limit_daily);
    if (response.status !== 429 && !(parsed && (parsed.rate_limited || daily))) return null;
    const fromBody = Date.parse((parsed && parsed.retry_after) || "");
    const fromHeader = Number(response.headers.get("Retry-After")) * 1000;
    const retryAt = Number.isFinite(fromBody) ? fromBody : fromHeader > 0 ? Date.now() + fromHeader : null;
    return { retryAt, daily };
  }

  // Accès à la base Supabase du site : sa clé publique et son adresse, relevées dans ses propres requêtes (aucune
  // valeur écrite en dur). src/content.js s'en sert pour lire toute la collection en une quinzaine de requêtes.
  let supabaseSent = "";
  function noteSupabase(input, init) {
    const url = new URL(typeof input === "string" ? input : (input && input.url) || String(input), location.href);
    if (!url.hostname.endsWith(".supabase.co")) return;
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    const apikey = headers.get("apikey") || "";
    if (!apikey || apikey === supabaseSent) return;
    supabaseSent = apikey;
    const message = { source: "wme-page", kind: "supabase", base: `${url.origin}/rest/v1/`, apikey };
    buffer.push(message);
    forward(message);
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      noteSupabase(args[0], args[1]);
    } catch (_) {
      // adresse ou en-têtes illisibles : ignoré
    }
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const method = String((args[1] && args[1].method) || (input && input.method) || "GET").toUpperCase();

      if (method === "GET" && response.ok && WATCHED.test(url)) {
        // clone() : le corps d'une réponse ne se lit qu'une fois, le site doit pouvoir lire l'original.
        response.clone().json()
          .then((data) => {
            const kind = PRICE_HISTORY.test(url) ? "price-history" : SALES.test(url) ? "sales" : "";
            const message = { source: "wme-page", url, data, ...(kind ? { kind } : {}) };
            buffer.push(message);
            if (buffer.length > BUFFER_MAX) buffer.shift();
            forward(message);
          })
          .catch(() => {}); // pas du JSON : ignoré
      } else if (method === "POST" && response.ok && (PROFILE_URL.test(url) || ACHIEVEMENTS_URL.test(url))) {
        response.clone().json()
          .then((data) => {
            const message = { source: "wme-page", url, data, kind: PROFILE_URL.test(url) ? "profile" : "achievements" };
            buffer.push(message);
            if (buffer.length > BUFFER_MAX) buffer.shift();
            forward(message);
          })
          .catch(() => {});
      } else if (method === "POST" && PACK_OPEN_URL.test(url)) {
        // On lit d'abord en texte pour pouvoir tenter JSON.parse sans lever d'erreur si la réponse n'est pas du JSON,
        // et pour inspecter un éventuel défi même lorsque le statut HTTP n'est pas 2xx.
        const clone = response.clone();
        clone.text().then((raw) => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}

          if (looksLikeChallenge(raw)) {
            // « need-click » signale à src/click.js qu'une ouverture UI depuis /pulls est requise.
            forward({ source: "wme-click", type: "need-click", url, status: response.status });
            return;
          }

          const limit = packLimit(response, parsed);
          if (limit) {
            // « pack-limited » : src/click.js ne reclique pas avant retryAt (ou demain, si c'est la limite du jour).
            forward({ source: "wme-click", type: "pack-limited", url, ...limit });
            return;
          }

          // Pas de carte (plus de paquet : 400 avec packs_remaining à 0, ou réponse inattendue) : rien n'a été ouvert.
          if (response.ok && parsed && Array.isArray(parsed.cards) && parsed.cards.length > 0) {
            // « pack-opened » indique que la requête d'ouverture a abouti côté site, quel que soit le schéma JSON.
            // La réponse suit (data) : src/content.js y cherche les cartes tirées pour le récap des paquets.
            forward({ source: "wme-click", type: "pack-opened", url, data: parsed });
          }
        }).catch(() => {});
      }
    } catch (_) {
      // Ne jamais casser le site : une erreur ici est ignorée.
    }
    return response;
  };
})();
