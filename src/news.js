// Nouveautés de chaque version, pour l'onglet « Nouveautés » du panneau (#28). option : réglage qu'un bouton
// « Activer » allume (message au content script). La plus récente d'abord ; garder les 10 dernières versions.
const WME_NEWS = [
  { version: "0.17.0", items: [
    { text: "Collection : défausse en masse, comme le bot. Raretés et cote maximum au choix, aperçu des cartes, puis confirmation ; jamais une shiny, un favori ni une carte étiquetée. Option : garder un exemplaire de chaque carte." },
  ] },
  { version: "0.16.0", items: [
    { text: "Prix faussé : quand une vente isolée hors de proportion fait la semaine (15 septembre SR vendue 8 067 au lieu de ~40), le badge affiche le prix habituel marqué « ⚠ », avec un contour orange ; le chiffre du site reste au survol." },
  ] },
  { version: "0.15.0", items: [
    { text: "L'onglet Familles est retiré. Tes familles restent enregistrées : Réglages › Données pour les sauvegarder ou les vider." },
  ] },
  { version: "0.14.0", items: [
    { text: "Onglet Page selon la page du site : paquets restants partout ; dernier paquet avec défausse carte par carte ; collection (plus chères, doublons, sans prix) ; marché (mes mises, mes souhaits en vente, bonnes affaires) ; profil d'un ami et offre d'échange (ses cartes de ta liste de souhaits, tes doublons qui lui manquent, WB pour équilibrer) ; fiche d'une carte (amis qui l'ont, prochaines enchères) ; succès (avec la page où avancer)." },
    { text: "Paquets : défausse automatique à l'ouverture, par rareté, cote maximum et doublons seulement. Coupée par défaut." },
    { text: "Familles : la recherche par catégorie Wikipédia est retirée. Enchères › Vente : la colonne Ex. compte tous les exemplaires de la carte." },
  ] },
  { version: "0.13.0", items: [
    { text: "Nouveau look : le panneau reprend les couleurs, les polices et les raretés de Wiki Masters, et suit son thème clair ou sombre." },
    { text: "Enchères en deux : Achat (ton solde, tes mises en tête ou dépassées avec la cote, ce que tu as gagné, les bonnes affaires) et Vente (tes ventes en cours, les créneaux libres, les ventes terminées, tes doublons à mettre en vente)." },
    { text: "Souhaits : une colonne « Chez mes amis » dit qui a chaque carte et dans quelles raretés il peut te l'échanger (pas en favori)." },
    { text: "Filtres : les étiquettes dans un menu déroulant. « Dans ma liste de souhaits » chez un ami ne lit plus toute sa collection : tes souhaits sont cherchés chez lui en quelques secondes." },
    { text: "Familles : les trois façons d'ajouter des cartes expliquées. Paquets : les cartes reprises d'une autre extension passent dans un « i ». Réglages : les prix partagés tout en bas, avec leur fonctionnement." },
    { text: "Correctif : « undefined » ou « false » pouvaient s'afficher sous les résultats des filtres et de la recherche des familles." },
  ] },
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
];
