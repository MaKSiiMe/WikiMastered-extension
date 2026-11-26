# Publication sur les boutiques (#29, #30)

Tout ce qui ne demande pas de compte est prêt : archives par navigateur, manifeste validé, politique de confidentialité, textes de la fiche, justification des droits. Il reste ce qui se fait avec ton compte, une fois.

## Archives

`npm run build` (ou la page [Releases](https://github.com/MaKSiiMe/WikiMastered-extension/releases) d'une version) :

- `wikimastered-extension-<version>-chrome.zip` : Chrome Web Store ;
- `wikimastered-extension-<version>-firefox.zip` : addons.mozilla.org (AMO).

Validé par `web-ext lint` (outil officiel de Mozilla) : 0 erreur. Il reste 2 avertissements sur `sidePanel.setPanelBehavior`, un appel propre à Chrome et protégé par un test de présence.

## Chrome Web Store (#29)

1. Créer un compte développeur : https://chrome.google.com/webstore/devconsole (frais d'inscription uniques de 5 $).
2. **Nouvel élément** et envoyer l'archive `-chrome.zip`.
3. Fiche : textes de [fiche.md](fiche.md), catégorie « Divertissement », langue française.
4. Captures d'écran (1280 × 800 ou 640 × 400, de 1 à 5) :
   - badges sur la page Marché ;
   - panneau, onglet Collection ;
   - offre d'échange en cours ;
   - panneau, onglet Filtres.
5. Onglet **Confidentialité** :
   - objectif unique : « Afficher le prix moyen des cartes Wiki Masters et des outils de collection » ;
   - justification de chaque droit : ci-dessous ;
   - données : « contenu du site Web » ;
   - lien vers la politique : `https://github.com/MaKSiiMe/WikiMastered-extension/blob/main/PRIVACY.md`.
6. Visibilité : « Non répertoriée » pour commencer (seuls ceux qui ont le lien l'installent), puis « Publique ».

## Firefox, addons.mozilla.org (#30)

1. Compte Firefox, puis https://addons.mozilla.org/developers/ et **Soumettre une nouvelle extension**.
2. Choisir **Sur ce site** (listée sur AMO) ou **Moi-même** (signée mais non listée : un fichier `.xpi` signé à distribuer soi-même, sans fiche publique).
3. Envoyer l'archive `-firefox.zip`. Pas de code source à joindre : il n'y a ni compilation ni minification.
4. Fiche : textes de [fiche.md](fiche.md), catégorie « Jeux et divertissement », licence MIT, politique de confidentialité : contenu de [PRIVACY.md](../PRIVACY.md).
5. La collecte de données est déjà déclarée dans le manifeste (`data_collection_permissions`) : rien par défaut, « contenu du site » en option.

## Justification des droits

| Droit | Pourquoi |
|---|---|
| `storage` | Garder les prix lus, la collection, les réglages et le récap des paquets sur l'ordinateur. |
| `sidePanel` (Chrome) / `sidebar_action` (Firefox) | Le panneau latéral : page ouverte, collection, filtres, souhaits, enchères, paquets, réglages. |
| `https://www.wiki-masters.com/*` | Lire les cartes affichées et leurs prix sur le site, et y poser les badges. |
| `https://*.workers.dev/*` (facultatif, demandé à l'activation) | Joindre le serveur de prix partagés (fonctionnalité expérimentale), seulement si l'utilisateur l'active et donne son adresse. |

## Fonctionnalités expérimentales

Les règles de la communauté Wiki Masters interdisent les scripts qui jouent à la place du joueur. Depuis la 1.0, tout ce qui agit sur le compte (ouverture auto des paquets, défausse, mise en vente, prix partagés) est caché : chaque fonction se débloque par un code, puis s'active après un avertissement (extension non officielle, règles du site, responsabilité du joueur).

À décider avant l'envoi : les boutiques demandent que la fiche décrive tout ce que fait l'extension, et des fonctions cachées d'automatisation risquent un refus. Deux possibilités : les décrire dans la fiche (« fonctions avancées, désactivées par défaut »), ou envoyer aux boutiques une archive sans elles et garder la version complète pour les Releases.
