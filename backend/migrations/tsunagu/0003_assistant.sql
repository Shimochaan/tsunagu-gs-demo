CREATE TABLE IF NOT EXISTS assistant_settings (id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS assistant_sources (id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,published_at TEXT NOT NULL,event_at TEXT,checked_at TEXT NOT NULL,expires_at TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS assistant_preferences (customer_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS assistant_proposals (proposal_id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,line_user_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,evidence TEXT NOT NULL,expires_at TEXT NOT NULL,snoozed_until TEXT);

CREATE TABLE IF NOT EXISTS assistant_approvals (proposal_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,line_user_id TEXT NOT NULL,customer_id TEXT NOT NULL,actor_id TEXT NOT NULL,scheduled_at TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(proposal_id,version));
