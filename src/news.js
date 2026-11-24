// Nouveautés de chaque version, pour l'onglet « Nouveautés » du panneau (#28). option : réglage qu'un bouton
// « Activer » allume (message au content script). La plus récente d'abord ; garder les 10 dernières versions.
const WME_NEWS = [
  { version: "0.12.0", items: [
    { text: "Échanges : pendant que tu composes une offre, la valeur de chaque côté s'affiche dans la barre du site, l'écart dessous, et le détail carte par carte dans l'onglet Page. Plus de bilan d'un autre échange au milieu de la fenêtre." },
    { text: "Filtres : la liste de tes amis (proposé d'office sur son profil), la lecture suivie même si tu changes d'onglet, plusieurs étiquettes à la fois (les tiennes ou celles de l'ami), « Dans ma liste de souhaits », les raretés de tous les exemplaires d'un doublon, et un bouton Vendre pour mettre un exemplaire en trop aux enchères. L'onglet Doublons disparaît (filtre Doublons)." },
    { text: "Familles : ajout depuis une catégorie Wikipédia (ex. Aveyron, avec ses sous-catégories), recherche par titre sur plusieurs pages, et les prix manquants lus à chaque ouverture d'une famille." },
    { text: "Nouvel onglet Enchères : bonnes affaires et enchères surcotées vues sur le marché ; leur marque sur les cartes est maintenant coupée par défaut.", option: "deals" },
    { text: "Paquets : une barre par rareté. L'ouverture automatique demande d'accepter un avertissement avant d'être activée." },
    { text: "Retirés : le bloc dans la fiche d'une carte, le « ✓ » et le point bleu (le site montre déjà si tu as la carte), l'ordre de la collection. L'infobulle du prix est plus courte." },
    { text: "Correctif : les étiquettes manquaient si ta collection avait été lue par une version d'avant la 0.10.1." },
  ] },
  { version: "0.11.1", items: [{ text: "Prête pour les boutiques : une archive par navigateur, politique de confidentialité, accord demandé sur Firefox avant tout envoi de données." }] },
  { version: "0.11.0", items: [{ text: "Onglet Familles : groupes de cartes à compléter, avec leur progression, ce qu'il manque et le coût, et un code de partage." }] },
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
];
