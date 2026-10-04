CREATE TABLE IF NOT EXISTS conversation_sync_reviews (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 customer_id TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready', claim TEXT, received_count INTEGER NOT NULL,
 inserted_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT);
