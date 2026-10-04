CREATE TABLE IF NOT EXISTS staff_line_edits (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,notice_id TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',PRIMARY KEY(tenant_id,user_id));

CREATE TABLE IF NOT EXISTS staff_line_links (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,destination TEXT NOT NULL,line_user_id TEXT,state TEXT NOT NULL DEFAULT 'pending',pair_hash TEXT,pair_expires_at TEXT,confirm_hash TEXT,attempts INTEGER NOT NULL DEFAULT 0,notifications INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id),UNIQUE(destination,line_user_id));

CREATE TABLE IF NOT EXISTS staff_line_events (id TEXT PRIMARY KEY,at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS staff_line_notices (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,user_id TEXT NOT NULL,destination TEXT NOT NULL,line_user_id TEXT NOT NULL,proposal_id TEXT NOT NULL,version INTEGER NOT NULL,draft_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'sending',created_at TEXT NOT NULL,UNIQUE(tenant_id,oa_id,proposal_id,version,user_id));

CREATE TABLE IF NOT EXISTS staff_line_slots (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,slot TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id,slot));
