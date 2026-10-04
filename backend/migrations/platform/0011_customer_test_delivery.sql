CREATE TABLE IF NOT EXISTS gs_customer_line_attempts (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,line_user_id TEXT NOT NULL,body_hash TEXT NOT NULL,retry_key TEXT NOT NULL UNIQUE,day TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gs_customer_line_day ON gs_customer_line_attempts(tenant_id,oa_id,day);
