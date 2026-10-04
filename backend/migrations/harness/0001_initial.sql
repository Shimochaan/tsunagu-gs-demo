CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, line_user_id TEXT NOT NULL, direction TEXT NOT NULL, source TEXT NOT NULL, actor_id TEXT, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', external_id TEXT UNIQUE, state TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, customer_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');

CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT, state TEXT NOT NULL, source TEXT NOT NULL, attribution TEXT NOT NULL DEFAULT 'unconfirmed', details TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, line_user_id TEXT NOT NULL, proposal_id TEXT, proposal_version INTEGER, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sales', state TEXT NOT NULL DEFAULT 'pending', scheduled_at TEXT NOT NULL, retry_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, error_code TEXT, accepted_at TEXT);

CREATE INDEX IF NOT EXISTS messages_customer_idx ON messages(customer_id,recorded_at);

CREATE INDEX IF NOT EXISTS outbox_state_idx ON outbox(state,scheduled_at);
