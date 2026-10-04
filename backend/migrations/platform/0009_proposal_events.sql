CREATE TABLE IF NOT EXISTS staff_notification_customer_slots (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,event_key TEXT NOT NULL,claimed_at TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id,customer_id));

CREATE TABLE IF NOT EXISTS staff_notification_claims (event_key TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,day TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS staff_notification_claim_day ON staff_notification_claims(tenant_id,user_id,day);

CREATE TABLE IF NOT EXISTS staff_proposal_events (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,proposal_id TEXT NOT NULL,version INTEGER NOT NULL,priority INTEGER NOT NULL,reason TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'unread',feedback TEXT,created_at TEXT NOT NULL,read_at TEXT,push_state TEXT NOT NULL DEFAULT 'unconnected',UNIQUE(tenant_id,oa_id,user_id,proposal_id,version));

CREATE INDEX IF NOT EXISTS staff_proposal_user ON staff_proposal_events(tenant_id,user_id,state,created_at DESC);

CREATE INDEX IF NOT EXISTS staff_proposal_due ON staff_proposal_events(tenant_id,oa_id,push_state,expires_at);
