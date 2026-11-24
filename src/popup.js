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
    h("p", { className: "muted" }, `${state.known} prix en mémoire · ${state.waiting} en attente` +
      ` · ${state.reads}/${state.readBudget} lectures sur 10 min`),
    state.paused && h("p", { className: "muted" }, `Pause : ${state.pauseReason || "le site limite les requêtes"}, ` +
      `jusqu'à ${new Date(state.pausedUntil).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`),
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

// Les compteurs suivent l'arrivée des prix tant que la fenêtre est ouverte.
const refresh = async () => render(await ask("state"));
refresh();
setInterval(refresh, 1000);
