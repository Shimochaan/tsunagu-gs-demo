CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT, team_id TEXT, mode TEXT NOT NULL DEFAULT 'ai', stage TEXT NOT NULL DEFAULT 'prospect', opt_out INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, confirmed_at TEXT, confirmed_by TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS customer_links (oa_id TEXT NOT NULL, line_user_id TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id), state TEXT NOT NULL DEFAULT 'confirmed', PRIMARY KEY(oa_id,line_user_id));

CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS external_links (oa_id TEXT NOT NULL, service TEXT NOT NULL, external_id TEXT NOT NULL, customer_id TEXT NOT NULL, line_user_id TEXT NOT NULL, PRIMARY KEY(oa_id,service,external_id), UNIQUE(oa_id,service,line_user_id));

CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, oa_id TEXT NOT NULL, customer_id TEXT NOT NULL, appointment_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'candidate', occurred_at TEXT NOT NULL, confirmed_by TEXT, UNIQUE(oa_id,appointment_id,kind));

CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY, at TEXT NOT NULL);
