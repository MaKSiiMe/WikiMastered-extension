# Publication sur les boutiques (#29, #30)

Tout ce qui ne demande pas de compte est prêt : archives par navigateur, manifeste validé, politique de confidentialité, textes de la fiche, réponses du formulaire, instructions de test. Il reste ce qui se fait avec ton compte, une fois. Chaque bloc ci-dessous se copie-colle tel quel dans la section du même nom.

## Archives

`npm run build` (ou la page [Releases](https://github.com/MaKSiiMe/WikiMastered-extension/releases) d'une version) :

- `wikimastered-extension-<version>-chrome.zip` : Chrome Web Store ;
- `wikimastered-extension-<version>-firefox.zip` : addons.mozilla.org (AMO).

Validé par `web-ext lint` (outil officiel de Mozilla) : 0 erreur. Il reste 2 avertissements sur `sidePanel.setPanelBehavior`, un appel propre à Chrome et protégé par un test de présence.

L'archive envoyée est la version complète, fonctions avancées comprises (coupées par défaut) : elles sont décrites dans la fiche et dans les instructions de test, pour que l'examen ne tombe pas sur des fonctions non déclarées.

## Chrome Web Store (#29)

Compte développeur : https://chrome.google.com/webstore/devconsole (5 $, une seule fois, puis autant d'extensions que tu veux). **Nouvel élément**, envoyer l'archive `-chrome.zip`, puis remplir les quatre sections. L'examen prend en général un à quelques jours.

### Fiche Play Store

- Description : [fiche.md](fiche.md), partie « Description ».
- Catégorie : Divertissement. Langue : français.
- Icône 128 × 128 : `icons/icon-128.png`.
- Captures d'écran (1280 × 800, de 1 à 5) : liste dans [fiche.md](fiche.md).
- Site web : `https://github.com/MaKSiiMe/WikiMastered-extension`. Assistance : `https://github.com/MaKSiiMe/WikiMastered-extension/issues`.

### Confidentialité

Objectif unique :

```
Outils de collection pour le jeu Wiki Masters, sur wiki-masters.com : prix des cartes affichés sur la page, valeur de la collection et des échanges, filtres, liste de souhaits, étiquettes et récap des paquets, dans un panneau latéral.
```

Justification des droits :

| Droit | À coller |
|---|---|
| `storage` | Garder sur l'ordinateur les prix lus, la collection, les réglages et le récap des paquets, pour ne pas relire le site à chaque page. |
| `sidePanel` | Le panneau latéral de l'extension : page ouverte, collection, filtres, souhaits, enchères, paquets, réglages. |
| Hôtes `wiki-masters.com` | Lire les cartes affichées et leurs prix sur le site, y poser les badges de prix, et lire la collection du joueur comme le site lui-même. |
| Hôte facultatif `*.workers.dev` | Joindre le serveur de prix partagés entre joueurs (fonction facultative), seulement si l'utilisateur l'active et donne son adresse ; demandé à ce moment-là. |

Code distant : **Non, je n'utilise pas de code distant.** (Tout le code est dans l'archive ; les réponses de Wikipédia, Wikidata et du serveur de prix sont des données JSON.)

Utilisation des données, cases à cocher :

- **Informations d'authentification** : le jeton de session du site est lu dans son cookie au moment d'une lecture et renvoyé uniquement à la base de données du site, jamais enregistré ni envoyé ailleurs.
- **Contenu du site Web** : cartes, prix, collection, liste de souhaits et étiquettes du joueur ; gardés sur l'ordinateur. Avec les options coupées par défaut : titres de cartes envoyés à Wikipédia et Wikidata, identifiants et prix de cartes au serveur de prix partagés.
- Rien d'autre (ni identité, ni historique de navigation, ni activité, ni localisation, ni communications).
- Les trois certifications (pas de vente des données, pas d'usage sans rapport avec l'objectif, pas de solvabilité) : à cocher, toutes vraies.

Politique de confidentialité : `https://github.com/MaKSiiMe/WikiMastered-extension/blob/main/PRIVACY.md`

### Distribution

- Paiement : gratuit.
- Visibilité : **Publique** (ou **Non répertoriée** pour un essai : seuls ceux qui ont le lien l'installent).
- Régions : toutes (le site est en français, mais rien n'empêche d'y jouer d'ailleurs).

### Instructions de test

Le champ est petit (le texte d'un ami y a été coupé, l'extension est quand même passée) : ce bloc tient en moins de 500 caractères.

```
Extension non officielle pour le jeu wiki-masters.com (compte gratuit à créer sur le site). Connecté, ouvrir la page Marché ou Collection : un badge de prix apparaît sur chaque carte. L'icône de l'extension ouvre le panneau latéral (Collection, Filtres, Souhaits…). Rien n'agit sur le compte par défaut. Les fonctions qui agissent (ouverture des paquets, défausse, vente) : Réglages > Fonctions avancées, cocher, puis accepter l'avertissement.
```

## Firefox, addons.mozilla.org (#30)

1. Compte Firefox, puis https://addons.mozilla.org/developers/ et **Soumettre une nouvelle extension**.
2. Choisir **Sur ce site** (listée sur AMO) ou **Moi-même** (signée mais non listée : un fichier `.xpi` signé à distribuer soi-même, sans fiche publique).
3. Envoyer l'archive `-firefox.zip`. Pas de code source à joindre : il n'y a ni compilation ni minification.
4. Fiche : textes de [fiche.md](fiche.md), catégorie « Jeux et divertissement », licence MIT, politique de confidentialité : contenu de [PRIVACY.md](../PRIVACY.md).
5. **Notes pour les validateurs** : le bloc « Instructions de test » ci-dessus.
6. La collecte de données est déjà déclarée dans le manifeste (`data_collection_permissions`) : rien par défaut, « contenu du site » en option, demandé quand l'utilisateur active une option qui envoie des données (prix partagés, images Wikipédia, étiquettes de thème et GIF).

## Fonctions avancées

Les règles de la communauté Wiki Masters interdisent les scripts qui jouent à la place du joueur. Depuis la 1.0, tout ce qui agit sur le compte à sa place (ouverture auto des paquets, défausse, mise en vente, prix partagés) est coupé par défaut : chaque fonction s'active par sa case dans les Réglages, après un avertissement (extension non officielle, règles du site, responsabilité du joueur). Décision du 26/11/2026 : on les envoie aux boutiques, décrites dans la fiche (paragraphe « Fonctions avancées ») et dans les instructions de test, comme d'autres extensions du jeu déjà publiées qui automatisent aussi.

Les deux écritures de la 1.1 (retrait des souhaits possédés, étiquettes automatiques) ne jouent pas à la place du joueur : ce sont des options ordinaires, coupées par défaut.
