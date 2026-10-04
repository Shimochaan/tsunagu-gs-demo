CREATE TABLE IF NOT EXISTS staff_line_preferences (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id));
CREATE TABLE IF NOT EXISTS staff_line_deliveries (notice_id TEXT PRIMARY KEY,lane TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,first_attempt_at TEXT,last_attempt_at TEXT,error_code TEXT);
CREATE TABLE IF NOT EXISTS staff_line_minute_slots (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,lane TEXT NOT NULL,slot INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,user_id,lane,slot));
