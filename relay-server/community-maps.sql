-- Ejecutar una sola vez en la misma base PostgreSQL que usa el relay de HaTitix.
CREATE TABLE IF NOT EXISTS hatitix_maps (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    author_id UUID REFERENCES hatitix_accounts(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    likes INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'comunidad'
);

CREATE INDEX IF NOT EXISTS hatitix_maps_created_at_id_idx
    ON hatitix_maps (created_at DESC, id DESC);
