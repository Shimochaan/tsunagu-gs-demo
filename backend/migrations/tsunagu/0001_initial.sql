CREATE TABLE IF NOT EXISTS generation_runs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, customer_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running', proposal_id TEXT, reason TEXT, created_at TEXT NOT NULL, UNIQUE(actor_id,request_key));

CREATE TABLE IF NOT EXISTS context_notes (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, appointment_id TEXT, source TEXT NOT NULL, source_ref TEXT, body TEXT NOT NULL, deal_state TEXT NOT NULL DEFAULT 'unknown', confirmed_by TEXT, confirmed_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, url TEXT, harness_id TEXT, state TEXT NOT NULL DEFAULT 'review', expires_at TEXT, body TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, trigger TEXT NOT NULL, reason TEXT NOT NULL, context_refs TEXT NOT NULL DEFAULT '[]', draft TEXT NOT NULL, asset_id TEXT, confidence TEXT NOT NULL DEFAULT 'review', state TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1, customer_version INTEGER NOT NULL, history_cursor TEXT, scheduled_at TEXT, approved_by TEXT, approved_version INTEGER, hold_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS proposal_versions (proposal_id TEXT NOT NULL, version INTEGER NOT NULL, draft TEXT NOT NULL, asset_id TEXT, scheduled_at TEXT, actor_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(proposal_id,version));

CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, version INTEGER NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, original TEXT, final TEXT, classification TEXT, confirmed INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS style_profiles (user_id TEXT PRIMARY KEY, answers TEXT NOT NULL DEFAULT '{}', features TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, label TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 0 AND 1), config TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS work_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, proposal_id TEXT, active_seconds INTEGER NOT NULL CHECK(active_seconds BETWEEN 0 AND 300), occurred_at TEXT NOT NULL);
