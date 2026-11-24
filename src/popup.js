// La fenêtre de l'extension (clic sur l'icône, ou Alt+Maj+W). Elle vit dans le monde de l'extension, pas dans la page :
// elle demande l'état au content script de l'onglet ouvert (src/content.js) par chrome.tabs.sendMessage.
const { wb } = WME;
const main = document.getElementById("main");
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

// Petit utilitaire sans innerHTML : tout texte est posé en texte.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "on") for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else el[key] = value;
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

async function ask(type, extra) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (_) {
    return null; // pas une page du site (ou ouverte avant l'installation de l'extension)
  }
}

function render(state) {
  if (!state) {
    main.replaceChildren(
      h("p", {}, "Ouvre une page de ", h("a", { href: "https://www.wiki-masters.com/collection", target: "_blank" }, "wiki-masters.com"),
        " (ou recharge-la si elle était ouverte avant l'extension)."));
    return;
  }
  main.replaceChildren(
    h("p", {}, `Cartes avec un badge : ${state.tiles}`),
    h("p", {}, `Valeur des cartes affichées : ≈ ${wb(state.value)} WB`),
    ...state.trades.map((t) => h("p", { className: "trade" }, t)),
    h("p", { className: "muted" }, `${state.known} prix à jour · ${state.old} de plus de 24 h (grisés) · ${state.waiting} en attente`),
    h("p", { className: "muted" }, `Lectures sur 10 min : ${state.reads.history}/${state.readBudget} historiques · ` +
      `${state.reads.sales}/${state.readBudget} ventes`),
    ...state.pauses.map((p) => h("p", { className: "muted" }, `Pause : ${p.reason}, jusqu'à ` +
      `${new Date(p.until).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`)),
    h("label", {},
      h("input", { type: "checkbox", checked: state.badges, on: { change: async (e) => render(await ask("badges", { on: e.target.checked })) } }),
      " Badges de prix sur les cartes"),
    h("label", {},
      h("input", {
        type: "checkbox",
        checked: Boolean(state.autoClickPack),
        on: { change: async (e) => render(await ask("autoClickPack", { on: e.target.checked })) },
      }),
      " Ouverture auto des packs par clic (/pulls)"),
    h("label", {},
      h("input", {
        type: "checkbox",
        checked: Boolean(state.autoUnblockMarket),
        on: { change: async (e) => render(await ask("autoUnblockMarket", { on: e.target.checked })) },
      }),
      " Tentative de déblocage marché (/collection)"),
    clickStatus(state),
    limitsLog(state.limits),
    sharedLive(state.shared),
    pullsRecap(state.pulls),
    h("button", { on: { click: async () => render(await ask("reread")) } }, "Relire tous les prix"),
    h("p", { className: "muted" },
      "Prix = le « Prix moyen de la semaine » de la fiche de la carte, dans sa rareté."));
}

// Récap des paquets ouverts, à la main et en auto (src/content.js, pullRecap de src/lib.js), s'il y en a. La
// répartition compte aussi les cartes reprises de l'autre extension (« earlier »), dont on ne connaît pas le prix.
// Valeur = prix moyen de chaque carte au moment de l'ouverture ; un shiny n'a pas de prix et n'y compte pas.
function pullsRecap(recap) {
  if (!recap || !(recap.packs || recap.earlier)) return null;
  const total = recap.cards + recap.earlier;
  const percent = (n) => (n / total * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  const order = (r) => (WME.rank(r) < 0 ? -1 : WME.rank(r)); // de L à C comme sur le site, raretés inconnues à la fin
  const rarities = Object.entries(recap.byRarity).sort(([a], [b]) => order(b) - order(a))
    .map(([r, n]) => `${r} ${n.toLocaleString("fr-FR")} (${percent(n)} %)`).join(" · ");
  const since = recap.since && new Date(recap.since).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  return h("div", { className: "pulls" },
    h("p", {}, h("b", {}, "Paquets ouverts"), ` · ${total.toLocaleString("fr-FR")} carte(s)`),
    h("p", { className: "muted" }, rarities + (recap.shiny ? ` · ✦ ${recap.shiny} shiny` : "")),
    recap.earlier > 0 && h("p", { className: "muted" },
      `Dont ${recap.earlier.toLocaleString("fr-FR")} carte(s) d'avant, reprises de l'extension « Prix moyen collection » ` +
      "(sans prix ni détail)."),
    recap.packs > 0 && h("p", {},
      `Depuis le ${since} : ${recap.packs} paquet(s) · ${recap.cards} carte(s) · ≈ ${wb(recap.value)} WB`),
    recap.packs > 0 && h("p", { className: "muted" }, `${recap.auto} en auto · ${recap.manual} à la main`),
    recap.missing > 0 && h("p", { className: "muted" }, `${recap.missing} carte(s) sans prix (shiny, aucune vente ou pas encore lu)`),
    recap.best.length > 0 && h("p", { className: "muted" },
      "Meilleurs tirages : " + recap.best.map((c) => `${c.title} ${c.rarity} ≈ ${wb(c.price)}`).join(" · ")),
    h("button", { on: { click: async () => render(await ask("clearPulls")) } }, "Remettre le récap à zéro"));
}

// L'état de l'automatisation par clic (src/click.js), seulement si l'une des deux cases est cochée.
function clickStatus(state) {
  const info = state.clickInfo;
  if (!info || !(state.autoClickPack || state.autoUnblockMarket)) return null;
  const notes = [
    info.challengeVisible && "vérification affichée",
    info.userQuiet ? "joueur inactif" : "joueur actif : pas de changement de page",
  ].filter(Boolean);
  return h("p", { className: "muted" }, `Automatisation : ${info.status} · ${notes.join(" · ")}`);
}

// Derniers refus du site, avec nos lectures juste avant : de quoi connaître ses quotas sans les chercher.
function limitsLog(limits) {
  if (!limits || !limits.length) return null;
  const what = { automation: "quota atteint", verification: "vérification", rate: "trop vite (429)" };
  const route = { history: "historiques", sales: "ventes" };
  return h("div", { className: "pulls" },
    h("p", {}, h("b", {}, "Refus du site")),
    ...limits.map((e) => h("p", { className: "muted" },
      `${new Date(e.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · ${route[e.route] || e.route} · ` +
      `${what[e.limit] || e.limit} après ${e.reads10m} lecture(s) en 10 min, dont ${e.reads1m} dans la dernière minute`)),
    h("p", { className: "muted" }, "Sans les lectures des autres extensions sur ton compte (Toolbox…), que le site compte aussi."));
}

// Prix partagés, côté page : ce que cet onglet a reçu du serveur et y a déposé.
function sharedLive(shared) {
  if (!shared || !shared.on) return null;
  if (shared.error) return h("p", { className: "muted" }, `Prix partagés : ${shared.error}`);
  return h("p", { className: "muted" },
    `Prix partagés${shared.who ? ` (${shared.who})` : ""} : ${shared.served} reçu(s) · ${shared.pushed} déposé(s)`);
}

// Réglages des prix partagés (src/background.js, server/). Construits une seule fois, hors de `main` qui est
// redessiné chaque seconde : un champ en cours de saisie serait effacé.
const SHARED_KEY = "shared";
async function setupShared() {
  const box = document.getElementById("shared");
  const { [SHARED_KEY]: cfg = {} } = await chrome.storage.local.get(SHARED_KEY);
  const status = h("p", { className: "muted" });
  const on = h("input", { type: "checkbox", checked: Boolean(cfg.on) });
  const url = h("input", { type: "url", value: cfg.url || "", placeholder: "https://….workers.dev" });
  const token = h("input", { type: "password", value: cfg.token || "", placeholder: "jeton", autocomplete: "off" });
  const fields = h("div", { hidden: !cfg.on }, url, token, h("button", { on: { click: save } }, "Enregistrer"));

  const check = async () => {
    const stats = await chrome.runtime.sendMessage({ type: "shared-stats" }).catch((e) => ({ error: e.message }));
    status.textContent = !stats || stats.error ? `Serveur : ${(stats && stats.error) || "pas de réponse"}`
      : `Connecté en ${stats.who} · ${stats.fresh_cards} carte(s) lue(s) depuis moins de 6 h dans le cache`;
  };

  // L'autorisation d'appeler le serveur doit être demandée tout de suite au clic (le navigateur l'exige) : la
  // vérification de l'adresse est donc synchrone, et l'enregistrement part en même temps que la demande.
  function save() {
    const value = { on: on.checked, url: url.value.trim().replace(/\/+$/, ""), token: token.value.trim() };
    if (!value.on) {
      chrome.storage.local.set({ [SHARED_KEY]: value });
      status.textContent = "Partage désactivé.";
      return;
    }
    let origin = "";
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol === "https:" && parsed.hostname.endsWith(".workers.dev")) origin = parsed.origin;
    } catch (_) {
      // adresse illisible
    }
    if (!origin || !value.token) {
      status.textContent = !origin ? "Adresse attendue : https://….workers.dev" : "Jeton manquant.";
      return;
    }
    const granting = chrome.permissions.request({ origins: [`${origin}/*`] });
    chrome.storage.local.set({ [SHARED_KEY]: value }); // avant la réponse : Firefox ferme la fenêtre pendant la question
    granting.then((granted) => {
      if (granted) check();
      else status.textContent = "Autorisation refusée : l'extension ne peut pas joindre ce serveur.";
    }, (e) => { status.textContent = `Autorisation impossible : ${e.message}`; });
  }

  on.addEventListener("change", () => {
    fields.hidden = !on.checked;
    if (!on.checked) save();
  });
  box.replaceChildren(h("label", {}, on, " Prix partagés avec d'autres joueurs (test)"), fields, status);
  if (cfg.on) check();
}
setupShared();

// Les compteurs suivent l'arrivée des prix tant que la fenêtre est ouverte.
const refresh = async () => render(await ask("state"));
refresh();
setInterval(refresh, 1000);
