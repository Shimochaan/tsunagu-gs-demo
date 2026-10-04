CREATE TABLE IF NOT EXISTS assistant_automation (id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_budget (kind TEXT NOT NULL,day TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,day));
CREATE TABLE IF NOT EXISTS assistant_runs (id TEXT PRIMARY KEY,kind TEXT NOT NULL,proposal_id TEXT,version INTEGER,state TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(kind,proposal_id,version));
