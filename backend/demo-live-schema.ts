export const demoLivePlatformDDL = [
  `CREATE TABLE IF NOT EXISTS gs_demo_live_state (id TEXT PRIMARY KEY,started_at TEXT NOT NULL,next_at TEXT NOT NULL DEFAULT '',lease_id TEXT,lease_until TEXT,last_sync_at TEXT,error TEXT)`,
  `CREATE TABLE IF NOT EXISTS gs_demo_meeting_notices (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL DEFAULT '',doc_id TEXT,error TEXT,created_at TEXT NOT NULL,UNIQUE(user_id,source_kind,source_id,source_version))`,
  `CREATE INDEX IF NOT EXISTS gs_demo_meeting_notices_work ON gs_demo_meeting_notices(state,next_at)`,
];
export const demoLiveTsunaguDDL = [
  `CREATE TABLE IF NOT EXISTS demo_sheet_writes (source_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,spreadsheet_id TEXT NOT NULL,config_version INTEGER NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',source_version INTEGER NOT NULL,row_json TEXT NOT NULL,synced_row TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL DEFAULT '',lease_id TEXT,lease_until TEXT,error TEXT,updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS demo_sheet_writes_work ON demo_sheet_writes(state,next_at)`,
];
