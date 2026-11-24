// Nouveautés de chaque version, pour l'onglet « Nouveautés » du panneau (#28). option : réglage qu'un bouton
// « Activer » allume (message au content script). La plus récente d'abord ; garder les 10 dernières versions.
const WME_NEWS = [
  { version: "0.10.1", items: [
    { text: "Correctif : les onglets Filtres et Souhaits, et la synchronisation des prix partagés, marchent de nouveau (cassés depuis la 0.9.2)." },
    { text: "Filtres : la collection d'un autre joueur (avec « seulement celles que je n'ai pas ») et tes étiquettes." },
    { text: "Échanges : bilan pendant que tu composes une offre, et détail des cartes d'un échange." },
  ] },
  { version: "0.10.0", items: [
    { text: "Fiche d'une carte : courbe des moyennes par semaine, médiane des dernières ventes, bouton ↻ Relire le prix, lien Wikipédia." },
    { text: "Images Wikipédia pour les cartes sans image (option, coupée par défaut).", option: "images" },
    { text: "Nouveautés : ce panneau, après chaque mise à jour." },
  ] },
  { version: "0.9.4", items: [{ text: "Marché : « −34 % » bonne affaire et « +50 % » surcoté à côté du prix.", option: "deals" }] },
  { version: "0.9.3", items: [{ text: "Réglages : taille des données, vider les caches, sauvegarde et restauration JSON." }] },
  { version: "0.9.2", items: [{ text: "Prix partagés : synchronisation par différence, bien plus légère." }] },
  { version: "0.9.1", items: [{ text: "Onglet Souhaits : ta liste de souhaits chiffrée." }] },
  { version: "0.9.0", items: [{ text: "Onglet Filtres : doublons, sans image, GIF, raretés, prix, sur toute la collection." }] },
  { version: "0.8.1", items: [{ text: "Onglet Paquets : le dernier paquet carte par carte et les taux du jour." }] },
  { version: "0.8.0", items: [{ text: "Le panneau latéral remplace la petite fenêtre : clic sur l'icône ou Alt+Maj+W." }] },
  { version: "0.7.0", items: [{ text: "Onglets Collection (valeur, plus chères, courbe) et Doublons." }] },
  { version: "0.6.3", items: [{ text: "Bloc d'infos dans la fiche d'une carte." }] },
];
