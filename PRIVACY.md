# Confidentialité : WikiMastered – Prix des cartes

Dernière mise à jour : 24 novembre 2026.

WikiMastered est une extension de navigateur non officielle pour le jeu [Wiki Masters](https://www.wiki-masters.com/). Elle n'est ni développée ni approuvée par Wiki Masters.

## Ce que l'extension lit

Uniquement sur wiki-masters.com, avec ta session déjà ouverte sur le site :

- les réponses que le site envoie à ta page (cartes affichées, enchères, échanges), pour savoir quelles cartes sont à l'écran ;
- l'historique des prix et les dernières ventes d'une carte (les mêmes routes que l'onglet « Marché » de la fiche d'une carte) ;
- ta collection, ta liste de souhaits et tes étiquettes, dans la base de données du site, comme le site lui-même ;
- sur demande, ta liste d'amis et la collection d'un ami, par les pages du site.

## Ce qu'elle fait sur le site

Seulement sur ton clic, après confirmation : mettre un exemplaire de ta collection aux enchères (la même requête que le bouton « Mettre aux enchères » du site). L'automatisation par clic (ouverture des paquets) est coupée par défaut et ne s'active qu'après un avertissement accepté.

## Ce qu'elle garde

Tout est gardé dans le stockage de l'extension, sur ton ordinateur (`chrome.storage.local`) : prix, collection, réglages, récap des paquets. Rien n'est envoyé au développeur. Le panneau « Réglages » montre la taille de chaque donnée, permet de la vider et d'en faire une sauvegarde.

Le jeton de session du site n'est jamais enregistré par l'extension : il est lu dans le cookie du site au moment d'une lecture, et envoyé seulement à la base de données du site.

## Ce qu'elle envoie ailleurs (deux options, coupées par défaut)

- **Prix partagés** : si tu l'actives (adresse d'un serveur et jeton, fournis par la personne qui gère ce serveur), l'extension envoie à ce serveur l'identifiant des cartes dont elle lit le prix et l'historique de prix du site, et lui demande ceux que les autres participants ont lus. Aucun pseudo, cookie ni contenu de collection n'est envoyé. Le serveur garde les lectures 30 jours au plus.
- **Images Wikipédia** : si tu l'actives, le titre des cartes sans image est envoyé à l'API publique de Wikipédia pour récupérer la vignette de l'article, sans cookie.

Sur Firefox, chacune de ces options demande ton accord au moment où tu l'actives.


## Ce qu'elle ne fait pas

Pas de publicité, pas de mesure d'audience, pas de revente ni de partage de données avec des tiers, pas de code téléchargé à distance.

## Contact

Une question, un problème : [issues du dépôt](https://github.com/MaKSiiMe/WikiMastered-extension/issues).
