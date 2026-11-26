// Automatisation par clic dans le monde isolé (partagé avec src/content.js) :
// - Garde-fous communs : pause si une vérification Turnstile est affichée, respect d'une fenêtre d'inactivité
//   utilisateur (5 min) avant toute navigation ou rechargement de confort, attente d'éléments DOM (waitFor), et
//   injection de valeur compatible avec les champs contrôlés par React (setNativeInputValue).
// - Ouverture de pack par clic sur /pulls : clique sur le bouton du site pour déclencher les hooks réseau de la page,
//   persiste l'état du relais dans chrome.storage.local pour survivre aux rechargements, et efface wmNeedClick dès
//   que le POST d'ouverture réussit.
// - Déblocage marché sur /collection (désactivé par défaut) : surveille un blocage prolongé et passe par une mise
//   en vente à prix élevé sur 10 min.
(() => {
  if (window.__wmeClick) return;
  window.__wmeClick = true;

  // Clés de stockage partagées dans chrome.storage.local.
  const LABS_KEY = "wmLabs";                  // fonctionnalités expérimentales débloquées et cochées (src/lib.js)
  const FLAG_NEED_CLICK = "wmNeedClick";
  const FLAG_NEED_VERIFY = "wmNeedVerify";
  const FLAG_RETURN_TO = "wmReturnTo";         // objet { to, startedAt, openedAt } persisté entre rechargements
  const FLAG_MARKET_TRY = "wmMarketTry";
  const FLAG_MARKET_UNBLOCK = "wmMarketUnblock";
  const FLAG_LAST_INPUT = "wmLastInput";       // date de la dernière action réelle du joueur, sur n'importe quelle page
  const FLAG_RELAY_TRY = "wmRelayTry";         // date du dernier départ vers /pulls pour un relais
  const FLAG_PACK_PAUSE = "wmPackPause";       // { until, daily } : le site limite les ouvertures, pas de clic avant

  // Délais de la boucle d'ouverture de packs.
  const PACK_TICK_MS = 5000;
  const RELOAD_AFTER_CLICK_MS = 8000;          // laisse l'animation d'ouverture se jouer avant rechargement
  const RELOAD_IDLE_MS = 180000;               // rechargement périodique sur /pulls si rien n'est prêt
  const RETURN_SETTLE_MS = 3000;               // court délai après ouverture du pack avant de quitter /pulls
  const RETURN_TIMEOUT_MS = 30000;             // sécurité : retour même si le signal d'ouverture n'a pas été vu
  const RELAY_RETRY_MS = 10 * 60000;           // un relais raté (pas de pack ouvert) ne repart pas avant 10 min

  // Délais de la boucle de déblocage marché (désactivée par défaut).
  const MARKET_TICK_MS = 10000;
  const STUCK_MS = 5 * 60000;                  // blocage marché présent depuis au moins 5 min
  const RETRY_MS = 8 * 60000;                  // une tentative au plus toutes les 8 min
  const HIGH_PRICE = 100000;                   // prix élevé pour éviter une vente accidentelle immédiate
  const POST_SUBMIT_WAIT_MS = 22000;           // laisse le temps d'afficher / valider une éventuelle vérification

  // Fenêtre d'inactivité joueur (5 min) : évite de naviguer ou recharger pendant qu'un humain utilise le site.
  const USER_QUIET_MS = 5 * 60000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizePath = () => location.pathname.replace(/\/+$/, "") || "/";
  const onPulls = () => normalizePath() === "/pulls";
  const onCollection = () => normalizePath() === "/collection";

  // Enregistre la dernière action physique réelle du joueur (e.isTrusted) pour calculer userQuiet().
  // Elle est gardée dans chrome.storage.local : sans ça, chaque nouvelle page repartirait de zéro et se croirait
  // « inactive » dès son chargement, même si le joueur vient de cliquer sur un lien.
  // En attendant la lecture du stockage, la page se considère active (Date.now()) : jamais de navigation à l'aveugle.
  let lastInputAt = Date.now();
  let lastSavedAt = 0;
  chrome.storage.local.get(FLAG_LAST_INPUT)
    .then((res) => { lastInputAt = typeof res[FLAG_LAST_INPUT] === "number" ? res[FLAG_LAST_INPUT] : 0; })
    .catch(() => {});
  for (const ev of ["mousedown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(ev, (e) => {
      if (!e.isTrusted) return;
      lastInputAt = Date.now();
      // Au plus une écriture toutes les 5 s : un défilement émet des dizaines d'événements « wheel ».
      if (lastInputAt - lastSavedAt > 5000) {
        lastSavedAt = lastInputAt;
        chrome.storage.local.set({ [FLAG_LAST_INPUT]: lastInputAt }).catch(() => {});
      }
    }, true);
  }
  const userQuiet = () => Date.now() - lastInputAt >= USER_QUIET_MS;

  // Détecte la présence d'un widget Cloudflare Turnstile / défi anti-robot visible dans le DOM.
  const verificationShown = () =>
    Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-sitekey]'));

  // Attend qu'un prédicat retourne quelque chose (un élément du DOM…) jusqu'à timeoutMs.
  async function waitFor(predicate, timeoutMs = 8000, intervalMs = 400) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = predicate();
      if (match) return match;
      await sleep(intervalMs);
    }
    return null;
  }

  // Met à jour un <input> en appelant le setter natif du prototype pour que React détecte le changement.
  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(input, String(value));
    } else {
      input.value = String(value);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Les deux automatisations sont des fonctionnalités expérimentales (src/lib.js, LABS) : elles ne tournent que
  // débloquées par leur code et cochées dans Réglages. Les anciens réglages autoClickPack / autoUnblockMarket ne
  // comptent plus.
  async function getClickSettings() {
    const { [LABS_KEY]: labs } = await chrome.storage.local.get(LABS_KEY);
    return {
      autoClickPack: WME.labOn(labs, "autopack"),
      autoUnblockMarket: WME.labOn(labs, "unblock"),
    };
  }

  const loadedAt = Date.now();
  let clickedAt = 0;
  // Dernier clic de l'extension sur « Ouvrir un paquet », jamais remis à zéro : src/content.js s'en sert pour ne
  // compter dans le récap que les paquets ouverts par l'automatisation, pas ceux que le joueur ouvre lui-même.
  let autoClickAt = 0;
  let statusMessage = "En attente";

  const packButton = () => {
    const img = document.querySelector('button img[alt="Ouvrir un paquet"]');
    return img ? img.closest("button") : null;
  };

  const availablePacks = () => {
    const match = (document.body && document.body.innerText || "").match(/(\d+)\s*\/\s*\d+\s*paquets?\s*disponibles?/i);
    return match ? Number(match[1]) : null;
  };

  // Réception des signaux envoyés par src/inject.js depuis le monde MAIN.
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "wme-click") return;

    if (event.data.type === "pack-opened") {
      // Le POST d'ouverture a réussi : on lève wmNeedClick et on marque openedAt dans l'état relais persisté.
      await chrome.storage.local.remove(FLAG_NEED_CLICK).catch(() => {});
      const { [FLAG_RETURN_TO]: relay } = await chrome.storage.local.get(FLAG_RETURN_TO).catch(() => ({}));
      if (relay && typeof relay === "object" && relay.startedAt && !relay.openedAt) {
        await chrome.storage.local.set({
          [FLAG_RETURN_TO]: { ...relay, openedAt: Date.now() },
        }).catch(() => {});
      }
    } else if (event.data.type === "need-click") {
      await chrome.storage.local.set({ [FLAG_NEED_CLICK]: Date.now() }).catch(() => {});
    } else if (event.data.type === "pack-limited") {
      // Le site limite les ouvertures : pas de clic avant la date qu'il donne. Limite du jour sans date : on attend
      // le lendemain (minuit et 5 min, heure locale). Sans date du tout : une minute.
      const { retryAt, daily } = event.data;
      const tomorrow = new Date();
      tomorrow.setHours(24, 5, 0, 0);
      const until = Number.isFinite(retryAt) ? retryAt : daily ? tomorrow.getTime() : Date.now() + 60e3;
      await chrome.storage.local.set({ [FLAG_PACK_PAUSE]: { until: until + 1000, daily: Boolean(daily) } }).catch(() => {});
    }
  });

  // « Pause : limite du site jusqu'à 14:32 » si une pause d'ouverture est en cours, sinon null.
  async function packPauseMessage() {
    const { [FLAG_PACK_PAUSE]: pause } = await chrome.storage.local.get(FLAG_PACK_PAUSE);
    if (!pause || !(pause.until > Date.now())) return null;
    const time = new Date(pause.until).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return `Pause : ${pause.daily ? "limite du jour atteinte" : "le site limite les ouvertures"}, jusqu'à ${time}`;
  }

  // Boucle d'ouverture de packs sur /pulls et de relais vers /pulls quand wmNeedClick est actif.
  async function packTick() {
    try {
      const settings = await getClickSettings();
      const { [FLAG_NEED_CLICK]: needClick, [FLAG_RETURN_TO]: rawRelay } =
        await chrome.storage.local.get([FLAG_NEED_CLICK, FLAG_RETURN_TO]);

      // Normalise l'objet relais persisté dans chrome.storage.local (survit aux rechargements de page).
      const relay = rawRelay && typeof rawRelay === "object" && rawRelay.startedAt ? rawRelay : null;

      // Si un relais est en cours, on ramène vers la page d'origine une fois le pack ouvert (après un court délai)
      // ou dès que RETURN_TIMEOUT_MS est dépassé. Tant qu'une vérification est affichée sur /pulls, on reste : c'est
      // au joueur de la valider, et partir relancerait un aller-retour plus tard.
      if (relay) {
        const openedAndSettled =
          typeof relay.openedAt === "number" &&
          relay.openedAt >= relay.startedAt &&
          Date.now() - relay.openedAt >= RETURN_SETTLE_MS;
        const timedOut = Date.now() - relay.startedAt >= RETURN_TIMEOUT_MS;
        const waitingForPlayer = onPulls() && verificationShown();

        if (openedAndSettled || (timedOut && !waitingForPlayer)) {
          await chrome.storage.local.remove(FLAG_RETURN_TO);
          const target = relay.to || "/pulls";
          if (target !== normalizePath()) {
            location.assign(target);
          } else {
            location.reload();
          }
          return;
        }
      }

      const relayActive = Boolean(needClick);
      if (!settings.autoClickPack && !relayActive && !relay) {
        statusMessage = "Désactivé";
        return;
      }

      // Le site a demandé d'attendre : ni clic ni relais avant la fin de la pause.
      const pauseMessage = await packPauseMessage();
      if (pauseMessage) {
        statusMessage = pauseMessage;
        return;
      }

      if (onPulls()) {
        if (verificationShown()) {
          statusMessage = "Pause : vérification humaine affichée";
          return;
        }

        if (clickedAt > 0) {
          statusMessage = "Pack cliqué : attente avant rechargement";
          if (Date.now() - clickedAt > RELOAD_AFTER_CLICK_MS) {
            clickedAt = 0;
            location.reload();
          }
          return;
        }

        const btn = packButton();
        const avail = availablePacks();
        if (btn && !btn.disabled && (avail === null || avail > 0)) {
          clickedAt = Date.now();
          // Si on ouvre un pack uniquement pour lever un relais (autoClickPack décoché), on enregistre startedAt
          // dans le stockage afin que le rechargement post-clic sache qu'il doit revenir à la page initiale.
          if (relayActive && !settings.autoClickPack) {
            const currentRelay = relay || {
              to: location.pathname + location.search,
              startedAt: clickedAt,
              openedAt: null,
            };
            if (!currentRelay.startedAt) currentRelay.startedAt = clickedAt;
            await chrome.storage.local.set({ [FLAG_RETURN_TO]: currentRelay });
          }
          statusMessage = "Clic sur « Ouvrir un paquet »";
          autoClickAt = Date.now();
          btn.click();
          return;
        }

        statusMessage = "Aucun pack prêt sur /pulls";
        if (Date.now() - loadedAt > RELOAD_IDLE_MS && userQuiet()) {
          location.reload();
        }
        return;
      }

      // Hors de /pulls : si une validation pack est demandée et que le joueur est inactif depuis 5 min,
      // on mémorise l'URL courante dans FLAG_RETURN_TO et on navigue vers /pulls. Au plus un départ toutes les
      // RELAY_RETRY_MS : si le relais précédent est revenu sans ouvrir de pack (aucun paquet prêt…), on ne repart
      // pas aussitôt.
      const { [FLAG_RELAY_TRY]: lastRelayTry } = await chrome.storage.local.get(FLAG_RELAY_TRY);
      const relayCoolingDown = typeof lastRelayTry === "number" && Date.now() - lastRelayTry < RELAY_RETRY_MS;
      if (relayActive && userQuiet() && !relayCoolingDown) {
        statusMessage = "Redirection vers /pulls pour validation";
        await chrome.storage.local.set({
          [FLAG_RELAY_TRY]: Date.now(),
          [FLAG_RETURN_TO]: {
            to: location.pathname + location.search,
            startedAt: Date.now(),
            openedAt: null,
          },
        });
        location.assign("/pulls");
      } else {
        statusMessage = "En veille hors /pulls";
      }
    } catch (_) {
      statusMessage = "Erreur temporaire";
    }
  }

  // Étape 2 du déblocage marché : sur /collection, sélectionne une carte, ouvre le formulaire d'enchère,
  // fixe un prix élevé sur 10 min, lance l'enchère puis revient à l'URL enregistrée.
  let runningUnblock = false;
  async function runCollectionUnblock() {
    if (runningUnblock) return;
    const { [FLAG_MARKET_UNBLOCK]: unblockState } = await chrome.storage.local.get(FLAG_MARKET_UNBLOCK);
    if (!unblockState) return;

    runningUnblock = true;
    await chrome.storage.local.remove(FLAG_MARKET_UNBLOCK);
    const returnUrl = unblockState.return || "/pulls";

    try {
      const cardImg = await waitFor(
        () => [...document.querySelectorAll("img")].find((img) => /upload\.wikimedia/.test(img.src || "")),
        10000
      );
      if (!cardImg) {
        location.assign(returnUrl);
        return;
      }

      const clickableCard = cardImg.closest("button, [role='button'], a, div") || cardImg;
      clickableCard.click();

      const auctionBtn = await waitFor(
        () => [...document.querySelectorAll("button")].find((btn) => /mettre aux ench/i.test(btn.innerText || "")),
        8000
      );
      if (!auctionBtn) {
        location.assign(returnUrl);
        return;
      }
      auctionBtn.click();

      const priceInput = await waitFor(() => document.querySelector("input[type='number']"), 8000);
      if (priceInput) {
        setNativeInputValue(priceInput, HIGH_PRICE);
      }

      const tenMinBtn = [...document.querySelectorAll("button")].find((btn) => /^10\s*min$/i.test((btn.innerText || "").trim()));
      if (tenMinBtn) tenMinBtn.click();

      await sleep(700);

      const launchBtn = await waitFor(
        () => [...document.querySelectorAll("button")].find((btn) => /lancer l'ench/i.test(btn.innerText || "")),
        4000
      );
      if (!launchBtn) {
        location.assign(returnUrl);
        return;
      }
      launchBtn.click();

      await sleep(POST_SUBMIT_WAIT_MS);
    } catch (_) {
      // Ignore les erreurs transitoires pour toujours tenter le retour vers la page d'origine.
    } finally {
      runningUnblock = false;
      location.assign(returnUrl);
    }
  }

  // Étape 1 du déblocage marché : surveille wmNeedVerify et navigue vers /collection si le blocage dure,
  // en respectant l'intervalle minimal entre tentatives et l'inactivité du joueur.
  async function marketTick() {
    try {
      const settings = await getClickSettings();
      if (!settings.autoUnblockMarket) return;

      if (onCollection()) {
        await runCollectionUnblock();
        return;
      }

      const { [FLAG_NEED_VERIFY]: needVerify, [FLAG_MARKET_TRY]: lastTry } =
        await chrome.storage.local.get([FLAG_NEED_VERIFY, FLAG_MARKET_TRY]);

      const blockedAt = typeof needVerify === "number" ? needVerify : (needVerify && needVerify.at) || 0;
      if (!blockedAt) return;
      if (Date.now() - blockedAt < STUCK_MS) return;
      if (typeof lastTry === "number" && Date.now() - lastTry < RETRY_MS) return;
      if (!userQuiet()) return;

      await chrome.storage.local.set({
        [FLAG_MARKET_TRY]: Date.now(),
        [FLAG_MARKET_UNBLOCK]: { at: Date.now(), return: location.pathname + location.search },
      });
      location.assign("/collection");
    } catch (_) {}
  }

  // Expose l'état synthétique de src/click.js à src/content.js (même monde isolé) pour affichage dans le panneau.
  window.__wmeClickState = () => ({
    status: statusMessage,
    onPulls: onPulls(),
    onCollection: onCollection(),
    challengeVisible: verificationShown(),
    userQuiet: userQuiet(),
    autoClickAt,
  });

  setInterval(packTick, PACK_TICK_MS);
  setInterval(marketTick, MARKET_TICK_MS);
})();
