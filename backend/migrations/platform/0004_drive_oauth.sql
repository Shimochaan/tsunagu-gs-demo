CREATE TABLE IF NOT EXISTS drive_oauth_states (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL);
