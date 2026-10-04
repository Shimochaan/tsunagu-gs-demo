CREATE TABLE IF NOT EXISTS assistant_notice_receipts (proposal_id TEXT NOT NULL,version INTEGER NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(proposal_id,version,user_id));
CREATE TABLE IF NOT EXISTS assistant_catalog_events (id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,source_id TEXT NOT NULL,occurred_at TEXT NOT NULL,created_at TEXT NOT NULL);
