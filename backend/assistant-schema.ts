export const assistantPlatformDDL = [
  `CREATE TABLE IF NOT EXISTS staff_line_preferences (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS staff_line_deliveries (notice_id TEXT PRIMARY KEY,lane TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,first_attempt_at TEXT,last_attempt_at TEXT,error_code TEXT)`,
  `CREATE TABLE IF NOT EXISTS staff_line_minute_slots (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,lane TEXT NOT NULL,slot INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,user_id,lane,slot))`,
  `CREATE TABLE IF NOT EXISTS staff_line_edits (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,notice_id TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',PRIMARY KEY(tenant_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS staff_line_links (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,destination TEXT NOT NULL,line_user_id TEXT,state TEXT NOT NULL DEFAULT 'pending',pair_hash TEXT,pair_expires_at TEXT,confirm_hash TEXT,attempts INTEGER NOT NULL DEFAULT 0,notifications INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id),UNIQUE(destination,line_user_id))`,
  `CREATE TABLE IF NOT EXISTS staff_line_events (id TEXT PRIMARY KEY,at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS staff_line_notices (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,user_id TEXT NOT NULL,destination TEXT NOT NULL,line_user_id TEXT NOT NULL,proposal_id TEXT NOT NULL,version INTEGER NOT NULL,draft_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'sending',created_at TEXT NOT NULL,UNIQUE(tenant_id,oa_id,proposal_id,version,user_id))`,
  `CREATE TABLE IF NOT EXISTS staff_line_slots (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,slot TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id,slot))`,
];
export const assistantDDL = [
  `CREATE TABLE IF NOT EXISTS assistant_notice_receipts (proposal_id TEXT NOT NULL,version INTEGER NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(proposal_id,version,user_id))`,
  `CREATE TABLE IF NOT EXISTS assistant_catalog_events (id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,source_id TEXT NOT NULL,occurred_at TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assistant_automation (id TEXT PRIMARY KEY,data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assistant_budget (kind TEXT NOT NULL,day TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,day))`,
  `CREATE TABLE IF NOT EXISTS assistant_runs (id TEXT PRIMARY KEY,kind TEXT NOT NULL,proposal_id TEXT,version INTEGER,state TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(kind,proposal_id,version))`,
  `CREATE TABLE IF NOT EXISTS assistant_settings (id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS assistant_sources (id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,published_at TEXT NOT NULL,event_at TEXT,checked_at TEXT NOT NULL,expires_at TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assistant_preferences (customer_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assistant_proposals (proposal_id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,line_user_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,evidence TEXT NOT NULL,expires_at TEXT NOT NULL,snoozed_until TEXT)`,
  `CREATE TABLE IF NOT EXISTS assistant_approvals (proposal_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,line_user_id TEXT NOT NULL,customer_id TEXT NOT NULL,actor_id TEXT NOT NULL,scheduled_at TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(proposal_id,version))`,
];
