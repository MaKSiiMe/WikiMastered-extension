// Nouveautés de chaque version, pour l'onglet « Nouveautés » du panneau (#28). La plus récente d'abord ; garder les 10
// dernières versions. L'historique repart de la v1 : les versions 0.x sont dans les Releases de GitHub.
//
// Règles d'écriture : pour un joueur, pas pour un développeur. Une ligne par changement visible, 1 ou 2 phrases au
// plus, en commençant par l'onglet ou l'endroit concerné. Pas de détail technique, pas de correctif invisible, rien sur
// les fonctionnalités expérimentales (elles restent cachées). option : réglage qu'un bouton « Activer » allume
// (message au content script).
const WME_NEWS = [
  { version: "1.0.0", items: [
    { text: "Version 1.0 : le prix moyen sur chaque carte, le bilan des échanges, et dans le panneau ta collection chiffrée, les filtres, tes souhaits, tes enchères et le récap de tes paquets." },
    { text: "Une idée, un problème ? Dis-le au développeur : les prochaines versions partiront de vos retours." },
  ] },
];
