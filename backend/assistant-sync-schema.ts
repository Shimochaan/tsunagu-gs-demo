export const syncDDL = [
  `CREATE TABLE IF NOT EXISTS assistant_sheet_sync (id TEXT PRIMARY KEY,config_version INTEGER,spreadsheet_id TEXT,modified_time TEXT,checked_at TEXT,next_at TEXT NOT NULL DEFAULT '',lease_id TEXT,lease_until TEXT,state TEXT NOT NULL DEFAULT 'idle',detail TEXT NOT NULL DEFAULT '{}')`,
];
