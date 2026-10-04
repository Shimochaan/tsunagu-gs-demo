CREATE INDEX IF NOT EXISTS staff_slots_current ON staff_line_minute_slots(tenant_id,slot);
CREATE TABLE IF NOT EXISTS assistant_oa_work (tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,lease_id TEXT,lease_until TEXT,next_at TEXT NOT NULL DEFAULT '',last_run_at TEXT NOT NULL DEFAULT '',failures INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,oa_id));
CREATE INDEX IF NOT EXISTS assistant_oa_work_due ON assistant_oa_work(next_at,last_run_at);
CREATE TABLE IF NOT EXISTS staff_line_delivery_schedule (notice_id TEXT PRIMARY KEY,next_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS staff_notices_queue ON staff_line_notices(tenant_id,oa_id,state,created_at,user_id);
CREATE INDEX IF NOT EXISTS staff_delivery_attempt ON staff_line_deliveries(last_attempt_at);
CREATE INDEX IF NOT EXISTS accounts_ready ON accounts(state,id);
