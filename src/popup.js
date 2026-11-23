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
      (state.paused ? " · pause : le site limite les requêtes" : "")),
    h("label", {},
      h("input", { type: "checkbox", checked: state.badges, on: { change: async (e) => render(await ask("badges", { on: e.target.checked })) } }),
      " Badges de prix sur les cartes"),
    h("button", { on: { click: async () => render(await ask("reread")) } }, "Relire tous les prix"),
    h("p", { className: "muted" },
      "Prix = le « Prix moyen de la semaine » de la fiche de la carte, dans sa rareté. " +
      "Lecture seule : l'extension ne mise et ne vend jamais."));
}

// Les compteurs suivent l'arrivée des prix tant que la fenêtre est ouverte.
const refresh = async () => render(await ask("state"));
refresh();
setInterval(refresh, 1000);
