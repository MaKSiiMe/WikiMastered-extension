# Feuille de route

Ce qu'on prévoit, version par version. On pioche au fur et à mesure : une case cochée = livré (avec sa version).
Tableau de suivi commun avec le bot : [projet WikiMastered](https://github.com/users/MaKSiiMe/projects/1).
Chaque ligne a son issue (jalons [v1](https://github.com/MaKSiiMe/WikiMastered-extension/milestone/1) et [v2](https://github.com/MaKSiiMe/WikiMastered-extension/milestone/2)) : c'est là que se suit le détail ; une PR qui dit « Closes #n » la ferme.
Les idées reprises d'autres outils citent leur source (voir [Outils existants](#outils-existants) en bas).

## 0.4.x : corrections urgentes

Relevé dans la doc d'API de [LeadOn/Wikimasters-Toolbox](https://github.com/LeadOn/Wikimasters-Toolbox) (`docs/site-api.md`, non officielle, peut changer).

- [x] **Quota des prix.** (0.4.1) `/api/marketplace/cards/{id}/price-history` est limité à ~90-100 lectures par 10 min ; au-delà, 403 `automation_limit` pendant ~10 min. Aujourd'hui l'extension lit un prix toutes les 0,5-0,8 s et prend ce 403 pour une erreur passagère (3 essais puis « ? »). À faire : budget d'environ 80 lectures par 10 min (partagé entre onglets), vraie pause sur `automation_limit`, et le dire dans la fenêtre. Le quota est sans doute par compte : il est partagé avec le bot.
- [x] **Vérification humaine.** (0.4.1) Le vrai signal est `human_verification_required` : le mettre dans `looksLikeChallenge` (src/inject.js) à la place des champs devinés.
- [x] **Limites de l'ouverture de paquets.** (0.4.1) `POST /api/packs/open` : 429 + `Retry-After` si deux ouvertures à moins de 2 s ; corps `rate_limited` / `retry_after` / `rate_limit_daily` ; 400 avec `packs_remaining: 0` quand il n'y a plus rien. `click.js` doit respecter `retry_after` et s'arrêter sur la limite quotidienne.
- [ ] **Déblocage marché.** Rien n'écrit encore `wmNeedVerify` : décider d'où vient le signal (réponse `human_verification_required` d'une mise, ou le bot), ou retirer la fonction.

## v1 : le collectionneur

### Prix
- [ ] Prix partagés entre joueurs et bots (serveur commun, `server/`) : essai à quatre en 0.5, puis ouverture plus large avec contrôle des cotes déposées (concordance, vérification par le bot).
- [x] Nombre de ventes derrière chaque prix ; « ≈ » quand il y en a peu, seuil réglable. (Toolbox, henchoznoe) [#13](https://github.com/MaKSiiMe/WikiMastered-extension/issues/13) (0.6.2)
- [x] Courbe de prix au survol d'un badge : un relevé local par rareté et par jour, gardé 90 jours, trous affichés. (henchoznoe) [#14](https://github.com/MaKSiiMe/WikiMastered-extension/issues/14) (0.10.0)
- [x] Médiane et fourchette (Q1-Q3) quand assez de ventes, en plus du prix moyen du site. (henchoznoe) [#15](https://github.com/MaKSiiMe/WikiMastered-extension/issues/15) (0.10.0)
- [x] Marché : badge « bonne affaire » / « surcoté » (mise actuelle comparée à la cote). (Toolbox, Instant Price Check) [#16](https://github.com/MaKSiiMe/WikiMastered-extension/issues/16) (0.9.4)
- [x] Ancienneté d'un prix visible, rafraîchissement ciblé d'une carte (↻). (henchoznoe, better-wiki-master) [#17](https://github.com/MaKSiiMe/WikiMastered-extension/issues/17) (0.10.0)
- [x] ~~Fiche d'une carte : ventes sur 12 semaines, fourchette sur 4 semaines, variation, possession.~~ Retiré en 0.12.0 : le site affiche déjà tout ça. [#47](https://github.com/MaKSiiMe/WikiMastered-extension/issues/47)

### Collection
- [x] Tableau de bord : valeur totale et par rareté, cartes les plus chères, doublons, valeur du compte dans le temps (une mesure par jour). [#18](https://github.com/MaKSiiMe/WikiMastered-extension/issues/18) (0.7.0)
- [x] Filtres cumulables qui manquent au site : doublons, sans image, GIF, étiquettes (avec / sans / l'une de), tranche de prix ; tri par valeur. (Toolbox) [#19](https://github.com/MaKSiiMe/WikiMastered-extension/issues/19) (0.9.0)
- [x] Filtres par étiquette : plusieurs à la fois, ou sans étiquette, les miennes ou celles d'un ami (0.12.0). [#63](https://github.com/MaKSiiMe/WikiMastered-extension/issues/63) (0.10.1)
- [x] Familles à compléter : cartes manquantes, leur prix, ajout depuis une catégorie Wikipédia (0.12.0), ajout à la liste de souhaits en un clic. (Toolbox, Prix moyen collection) [#20](https://github.com/MaKSiiMe/WikiMastered-extension/issues/20) (0.11.0)
- [x] Liste de souhaits avec le prix de chaque carte et le coût total. [#21](https://github.com/MaKSiiMe/WikiMastered-extension/issues/21) (0.9.1)
- [x] Repérage des doublons et de ce qu'ils valent, et mise en vente d'un exemplaire en trop (filtre Doublons, 0.12.0). (Mes doublons, Toolbox) [#22](https://github.com/MaKSiiMe/WikiMastered-extension/issues/22) (0.7.0)
- [x] ~~Pastilles « Possédée ✓ » / « Nouvelle » sur le marché, les profils et le catalogue.~~ Retiré en 0.12.0 : le site a sa propre étiquette. [#45](https://github.com/MaKSiiMe/WikiMastered-extension/issues/45)
- [x] ~~Ordre de la collection gardé d'une visite à l'autre.~~ Retiré en 0.12.0 : remplacé par les filtres (étiquettes cumulées, tri par prix). [#46](https://github.com/MaKSiiMe/WikiMastered-extension/issues/46)

### Paquets
- [x] Récap des paquets ouverts : répartition par rareté, shiny, valeur, meilleurs tirages, à la main / en auto ; reprise des compteurs de « Prix moyen collection ». (0.4)
- [x] Récap de chaque paquet : nouvelle carte ou doublon, valeur du paquet. (Toolbox) [#23](https://github.com/MaKSiiMe/WikiMastered-extension/issues/23) (0.8.1)
- [x] Taux de tirage du jour et depuis le début, remise à zéro quotidienne. (henchoznoe, Toolbox) [#24](https://github.com/MaKSiiMe/WikiMastered-extension/issues/24) (0.8.1)

### Échanges
- [x] Bilan pendant la composition d'une offre d'échange. (Toolbox) [#50](https://github.com/MaKSiiMe/WikiMastered-extension/issues/50) (0.10.1)
- [x] Filtre de la fenêtre d'échange sur toute la collection (la sienne ou celle de l'ami). (Toolbox) [#51](https://github.com/MaKSiiMe/WikiMastered-extension/issues/51) (0.10.1)

### Confort
- [x] Image Wikimedia pour les cartes sans image, lien Wikipédia sur chaque carte. (wikimasters-extended, Toolbox) [#25](https://github.com/MaKSiiMe/WikiMastered-extension/issues/25) (0.10.0)
- [x] Carte entière dans les offres d'échange au lieu du nom tronqué. (wikimasters-extended) [#26](https://github.com/MaKSiiMe/WikiMastered-extension/issues/26) (0.10.1)
- [x] Page d'options : réglages, taille des caches, vider les caches, sauvegarde / restauration JSON. (henchoznoe, BallenghienAlexis) [#27](https://github.com/MaKSiiMe/WikiMastered-extension/issues/27) (0.9.3)
- [x] Panneau « Nouveautés » après une mise à jour, avec un bouton pour activer chaque nouvelle option. (Toolbox) [#28](https://github.com/MaKSiiMe/WikiMastered-extension/issues/28) (0.10.0)
- [ ] Confort à trier après essai de Toolbox : pastille du thème, favori et étiquettes pendant la révélation, récap dans la marge, son de notification, raccourcis de la popup. [#53](https://github.com/MaKSiiMe/WikiMastered-extension/issues/53)

### Publication
- [ ] Chrome Web Store. [#29](https://github.com/MaKSiiMe/WikiMastered-extension/issues/29)
- [ ] Version signée pour Firefox (AMO). [#30](https://github.com/MaKSiiMe/WikiMastered-extension/issues/30)

## v2 : l'investisseur (synchronisée avec le bot)

Avec [WikiMastered](https://github.com/MaKSiiMe/WikiMastered) : l'extension affiche, le bot agit. Côté bot : [API pour l'extension : état du bot](https://github.com/MaKSiiMe/WikiMastered/issues/211), [Exposer prix shiny relevés et historique de valeur du compte](https://github.com/MaKSiiMe/WikiMastered/issues/212), [Étiquettes « Doublon » et « Favori »](https://github.com/MaKSiiMe/WikiMastered/issues/214).

- [ ] Onglet « Bot » dans le tableau de bord : positions, ventes, bilan, file, état de l'anti-bot. [#31](https://github.com/MaKSiiMe/WikiMastered-extension/issues/31)
- [ ] « Stonks » : achats et ventes par jour / semaine / mois, profit réalisé et latent, par carte (bot + `/api/marketplace/mine`). (Toolbox, LeKenT1) [#32](https://github.com/MaKSiiMe/WikiMastered-extension/issues/32)
- [ ] Prix des shiny à partir des ventes réelles (`/api/marketplace/cards/{id}/sales`), séparés des cartes ordinaires : fin de la limite « ✦ ? ». (Toolbox) : l'historique du site ne distingue pas les shiny, seul le bot voit leurs ventes. [#12](https://github.com/MaKSiiMe/WikiMastered-extension/issues/12)
- [ ] Prix des shiny relevés par le bot ; évolution de la valeur du compte (worker `account_value`). [#33](https://github.com/MaKSiiMe/WikiMastered-extension/issues/33)
- [ ] Trafic Wikipédia de chaque carte, depuis le tracker [MaKSiiMe/Wikimasters](https://github.com/MaKSiiMe/Wikimasters) : repérer les cartes qui montent. (Sephiroth-ctrl : bouton pageviews) [#34](https://github.com/MaKSiiMe/WikiMastered-extension/issues/34)
- [ ] Page d'une enchère : autres enchères de la même carte où je mise, vente en cours, écart à la cote. (Toolbox) [#48](https://github.com/MaKSiiMe/WikiMastered-extension/issues/48)
- [ ] « Prochaines enchères de cette carte », avec leur écart à la cote. (Toolbox) [#49](https://github.com/MaKSiiMe/WikiMastered-extension/issues/49)
- [ ] Mes enchères et mes ventes en cours, en lecture seule (la surenchère reste au bot). (Toolbox) [#52](https://github.com/MaKSiiMe/WikiMastered-extension/issues/52)
- [ ] Alertes : carte souhaitée au marché sous sa cote, fin de tes enchères, temps restant dans le titre de l'onglet. (Toolbox) [#35](https://github.com/MaKSiiMe/WikiMastered-extension/issues/35)
- [ ] Vérification demandée par le bot : « ! » sur l'icône et notification, avec un bouton vers la page où la faire. [#36](https://github.com/MaKSiiMe/WikiMastered-extension/issues/36)
- [ ] Aide à la décision par carte (garder, échanger, vendre, défausser) avec les règles du bot, pour trier à la main. (BallenghienAlexis) [#37](https://github.com/MaKSiiMe/WikiMastered-extension/issues/37)
- [ ] Échanges : profils d'intérêt partageables, offre équilibrée proposée. (Toolbox) [#38](https://github.com/MaKSiiMe/WikiMastered-extension/issues/38)

## Pas prévu

- **Sniping, mises auto, vente auto dans l'extension** : c'est le rôle du bot, côté serveur ; ce sont aussi les fonctions qui exposent le plus le compte.
- **Passer la vérification anti-bot** : l'extension s'arrête dessus, comme tous les outils sérieux (LeKenT1 raconte 1 905 tentatives en 77 min avant d'ajouter cet arrêt).
- **Remplacer toute l'interface du site** (Nogze/wikimasters-enhanced), gadgets (Pong).

Rappel : les règles de la communauté WikiMasters interdisent les bots et les scripts qui ouvrent des paquets, misent ou échangent à la place du joueur. L'ouverture auto des paquets (0.4) est concernée.

## Outils existants

Relevé du 24/11/2026.

| Outil | Points forts |
|---|---|
| [LeadOn/Wikimasters-Toolbox](https://github.com/LeadOn/Wikimasters-Toolbox), fork [0xEBO](https://github.com/0xEBO/Wikimasters-Toolbox) | Le plus complet : prix médians (shiny à part), Stonks, familles, tri par thème, récap de paquet, sniper, succès ; doc de l'API du site. |
| [henchoznoe/WikiMasters-Toolbox](https://github.com/henchoznoe/WikiMasters-Toolbox) | Méthode de prix rigoureuse : courbe locale 90 j, médiane / Q1-Q3, fraîcheur ; lecture seule. |
| [AlexherDev69/wikimasters-extended](https://github.com/AlexherDev69/wikimasters-extended), fork [Oxys4](https://github.com/Oxys4/wikimasters-extended) | Confort : images Wikimedia, cartes entières dans les échanges, vue compacte, copier en image ; aucun appel à l'API du site. |
| WikiMasters - Prix moyen collection (Chrome Web Store) | Familles, prix, « ouvrir tous les paquets », statistiques de tirage (`wm_pull_stats_v1`). |
| [BallenghienAlexis/wikimasters-extension](https://github.com/BallenghienAlexis/wikimasters-extension) | Décision par carte, planning des ventes, sauvegarde JSON. |
| [ZainadosRepo/wikimasters-bot](https://github.com/ZainadosRepo/wikimasters-bot) | Classement dans tes étiquettes appris par Wikidata (« À vérifier » si incertain), défausse en lot avec aperçu. |
| [Sephiroth-ctrl](https://github.com/Sephiroth-ctrl/Wiki-Masters-Bot), [LeKenT1](https://github.com/LeKenT1/wikimaster-bot), [Mrjb14](https://github.com/Mrjb14/botwikimaster), [AirKyzzZ](https://github.com/AirKyzzZ/wikimasters-bot) | Bots : paquets, sniping, revente, défausse, rapports Discord, profit réalisé / latent. |
| [better-wiki-master](https://github.com/maxime-lalo/better-wiki-master), [Instant Price Check](https://greasyfork.org/en/scripts/595230-wikimasters-instant-price-check) | Prix sur les cartes, mise en valeur des cartes chères, filtres de notifications. |
| [WikiMasters Discord Bot](https://gitlab.com/julesl1107/wikimasters-discord-bot) | Collections et profils depuis Discord. |
| Chrome Web Store (fiches non lues) : WikiMasters+, Collection+, « c'est fun — Statistiques », WikiRemastered, Mes doublons, Speeder | À regarder depuis un navigateur. |
