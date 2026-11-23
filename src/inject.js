// Ce script tourne DANS la page du site (« world: MAIN » dans manifest.json), avant le code du site.
//
// Pourquoi ? Un content script normal vit dans un monde isolé : il voit la page (le DOM) mais pas les variables ni
// les requêtes du site. Pour savoir quelles cartes la page affiche, on « écoute » les réponses de l'API du site :
// on enveloppe window.fetch, et chaque réponse intéressante est recopiée vers le content script (src/content.js) par
// window.postMessage. Rien n'est modifié : le site reçoit exactement la même réponse qu'avant.
(() => {
  if (window.__wmeHooked) return; // déjà installé (rechargement partiel de la page)
  window.__wmeHooked = true;

  // Réponses qui contiennent des cartes : ta collection, le marché, la collection d'un ami, le catalogue.
  const WATCHED = /\/api\/(my-collection|marketplace|profile\/[^/]+\/collection|cards)(?:[/?#]|$)/i;
  const IGNORED = /\/price-history|\/sales|\/bid(?:[/?#]|$)/i;

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
      }
    } catch (_) {
      // Ne jamais casser le site : une erreur ici est ignorée.
    }
    return response;
  };
})();
