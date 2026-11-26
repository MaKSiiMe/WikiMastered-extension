// Nouveautés de chaque version, pour l'onglet « Nouveautés » du panneau (#28). La plus récente d'abord ; garder les 10
// dernières versions. L'historique repart de la v1 : les versions 0.x sont dans les Releases de GitHub.
//
// Règles d'écriture : pour un joueur, pas pour un développeur. Une ligne par changement visible, 1 ou 2 phrases au
// plus, en commençant par l'onglet ou l'endroit concerné. Pas de détail technique, pas de correctif invisible. Jamais de
// bouton « Activer » pour une fonction avancée (elle a son avertissement). option : réglage qu'un bouton « Activer » allume
// (message au content script).
const WME_NEWS = [
  { version: "1.2.0", items: [
    { text: "Réglages : les fonctions avancées (ouverture auto des paquets, défausse, mise en vente, prix partagés) sont accessibles à tous, plus besoin de code. Coupées par défaut, chacune s'active par sa case, après un avertissement." },
  ] },
  { version: "1.1.0", items: [
    { text: "Collection : étiquettes automatiques. Coche les thèmes que tu veux (Personne, Lieu, Sport, Cinéma, Musique…), « Doublon » ou « GIF » : l'extension te montre quelles cartes reçoivent quelle étiquette, puis les pose quand tu valides, et crée elle-même celles qui manquent sur ton compte." },
    { text: "Souhaits : une case pour retirer de ta liste les cartes que tu possèdes déjà, avec un bouton pour les remettre." },
    { text: "Filtres : choisis combien de cartes afficher, de 50 à toutes." },
    { text: "Paquets : la page ne se recharge plus toute seule pendant que tu ouvres tes paquets, tu vois toutes tes cartes." },
  ] },
  { version: "1.0.0", items: [
    { text: "Version 1.0 : le prix moyen sur chaque carte, le bilan des échanges, et dans le panneau ta collection chiffrée, les filtres, tes souhaits, tes enchères et le récap de tes paquets." },
    { text: "Une idée, un problème ? Dis-le au développeur : les prochaines versions partiront de vos retours." },
  ] },
];
