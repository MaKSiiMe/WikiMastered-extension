# Cache de prix partagé

Un petit serveur (Cloudflare Worker + base D1) où chaque participant (extension ou bot) dépose les historiques de prix
qu'il lit sur le site, et où il demande d'abord ceux que les autres ont déjà lus. Le quota du site
(~90-100 lectures de `price-history` par 10 min et par compte) ne bouge pas : chacun lit seulement ce qu'il regarde, mais
profite des lectures des autres.

Côté extension, c'est une fonctionnalité expérimentale (débloquée par un code). C'est un essai entre quelques
participants de confiance : un jeton par participant, aucune vérification des prix déposés.

## Ce qui est gardé

Pour chaque carte : la dernière réponse `price-history` (`computed_at`, `by_rarity`), sa date et le nom du participant
qui l'a déposée. Plus des compteurs par jour et par participant (cartes demandées, servies, déposées). Rien d'autre : ni
pseudo du site, ni cookie, ni collection. Les lectures de plus de 30 jours sont effacées chaque nuit.

## Routes

Toutes avec `Authorization: Bearer <jeton>`.

| Route | Rôle |
|---|---|
| `GET /v1/history?ids=a,b,c&max_age=21600` | Lectures de moins de `max_age` secondes (6 h par défaut) pour au plus 100 cartes : `{ who, items: { "<id>": { read_at, read_by, history } } }`. |
| `POST /v1/history` | Dépose au plus 100 lectures `{ items: [{ id, read_at (ms), history }] }`. Une lecture plus ancienne que celle gardée ne la remplace pas. -> `{ who, stored, older, rejected }`. |
| `GET /v1/changes?since=<ms>` | Cartes lues depuis `since` (7 jours au plus) : seulement `[[card_id, read_at], …]`, les plus anciennes d'abord, 5000 par réponse (`more` : il en reste). Le client ne demande ensuite que les historiques qui l'intéressent. |
| `GET /v1/stats?days=7` | Compteurs par jour et par participant, et nombre de cartes lues depuis moins de 6 h. |

## Mise en route (une fois)

Il faut un compte Cloudflare (le plan gratuit suffit largement). Depuis ce dossier :

```sh
npm install
npx wrangler login                       # ouvre le navigateur
npx wrangler d1 create wikimastered-share
cp wrangler.example.toml wrangler.toml   # puis y coller le database_id affiché
npx wrangler d1 execute wikimastered-share --remote --file schema.sql
npx wrangler secret put TOKENS           # colle le JSON { "<jeton>": "<nom>", … }
npx wrangler deploy                      # affiche l'adresse https://wikimastered-share.<compte>.workers.dev
```

`wrangler.toml` et les jetons restent hors du dépôt (`.gitignore`). Un jeton : 32 caractères au hasard, par exemple
`openssl rand -hex 16`. Pour ajouter ou retirer un participant, remets tout le JSON avec `wrangler secret put TOKENS`. Nom conseillé : le pseudo du joueur sur le site, suivi de « (bot) » pour son bot (« jarry », « jarry (bot) ») : c'est lui qu'affiche l'infobulle des badges.

## Essai en local

```sh
cp wrangler.example.toml wrangler.toml   # l'identifiant peut rester factice en local
echo 'TOKENS={"tok-a":"essai-a"}' > .dev.vars
npx wrangler d1 execute wikimastered-share --local --file schema.sql
npx wrangler dev
curl -H 'Authorization: Bearer tok-a' 'http://localhost:8787/v1/stats'
```

Les règles (identifiants, âge, taille, jetons) sont dans `src/logic.js`, testées par `npm test` à la racine du dépôt.
