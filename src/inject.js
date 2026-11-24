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
  // vitrines…). Sauf l'historique des prix : c'est l'extension qui le demande, et il ne contient pas de carte.
  const WATCHED = /\/api\//i;
  const IGNORED = /\/price-history|\/sales(?:[/?#]|$)/i;

  // Ouverture d'un paquet : POST /api/packs/open (relevé dans l'onglet Réseau du site).
  const PACK_OPEN_URL = /\/api\/packs\/open(?:[/?#]|$)/i;

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

  // Détection stricte d'un défi anti-robot : statut 403 ou propriété explicite de vérification/défi dans un objet JSON.
  // Évite de déclencher un faux positif sur un champ générique contenant le mot « verify » dans une réponse normale.
  function looksLikeChallenge(status, payload) {
    if (status === 403) return true;
    if (!payload || typeof payload !== "object") return false;
    return Boolean(
      payload.challenge ||
      payload.turnstile ||
      payload.requires_verification ||
      payload.requiresVerification ||
      payload.need_verify
    );
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const method = String((args[1] && args[1].method) || (input && input.method) || "GET").toUpperCase();

      if (method === "GET" && response.ok && WATCHED.test(url) && !IGNORED.test(url)) {
        // clone() : le corps d'une réponse ne se lit qu'une fois, le site doit pouvoir lire l'original.
        response.clone().json()
          .then((data) => {
            const message = { source: "wme-page", url, data };
            buffer.push(message);
            if (buffer.length > BUFFER_MAX) buffer.shift();
            forward(message);
          })
          .catch(() => {}); // pas du JSON : ignoré
      } else if (method === "POST" && PACK_OPEN_URL.test(url)) {
        // On lit d'abord en texte pour pouvoir tenter JSON.parse sans lever d'erreur si la réponse n'est pas du JSON,
        // et pour inspecter un éventuel défi même lorsque le statut HTTP n'est pas 2xx.
        const clone = response.clone();
        clone.text().then((raw) => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}

          if (looksLikeChallenge(response.status, parsed)) {
            // « need-click » signale à src/click.js qu'une ouverture UI depuis /pulls est requise.
            forward({ source: "wme-click", type: "need-click", url, status: response.status });
            return;
          }

          if (response.ok) {
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
