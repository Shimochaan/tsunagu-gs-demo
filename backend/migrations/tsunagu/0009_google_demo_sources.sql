-- Additive only: isolated source reviews and daily research records.
CREATE TABLE IF NOT EXISTS assistant_google_config (id TEXT PRIMARY KEY,actor TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,review_id TEXT,review_state TEXT,review_json TEXT);
CREATE TABLE IF NOT EXISTS assistant_research_days (day TEXT PRIMARY KEY,actor TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,result TEXT,archive_id TEXT,error_code TEXT);
