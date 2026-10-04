-- Additive local-reviewed migration; apply only through the approved migration workflow.
CREATE TABLE IF NOT EXISTS meeting_customer_reviews (id TEXT PRIMARY KEY,file_id TEXT NOT NULL,file_version INTEGER NOT NULL,modified_at TEXT NOT NULL,connection_id TEXT NOT NULL,actor_id TEXT NOT NULL,customer_id TEXT NOT NULL,customer_version INTEGER NOT NULL,title TEXT NOT NULL,transcript TEXT NOT NULL,text_hash TEXT NOT NULL,held_at TEXT,state TEXT NOT NULL DEFAULT 'preview',analysis TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS meeting_customer_review_lookup ON meeting_customer_reviews(customer_id,actor_id,created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_customer_imports (file_id TEXT NOT NULL,modified_at TEXT NOT NULL,customer_id TEXT NOT NULL,review_id TEXT NOT NULL,note_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(file_id,modified_at));
