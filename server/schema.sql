-- Base D1 du cache partagé : `npx wrangler d1 execute wikimastered-share --remote --file schema.sql`.
CREATE TABLE IF NOT EXISTS history (
  card_id TEXT PRIMARY KEY,   -- identifiant de la carte sur le site
  read_at INTEGER NOT NULL,   -- date de la lecture (ms)
  read_by TEXT NOT NULL,      -- participant qui l'a déposée (nom du jeton)
  body TEXT NOT NULL          -- { computed_at, by_rarity } de /price-history
);
CREATE INDEX IF NOT EXISTS idx_history_read_at ON history (read_at);

CREATE TABLE IF NOT EXISTS stats (
  day TEXT NOT NULL,          -- jour UTC
  who TEXT NOT NULL,
  asked INTEGER NOT NULL DEFAULT 0,   -- cartes demandées au cache
  served INTEGER NOT NULL DEFAULT 0,  -- … trouvées fraîches
  stored INTEGER NOT NULL DEFAULT 0,  -- lectures déposées
  PRIMARY KEY (day, who)
);
