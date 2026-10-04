export const meetingAutoDDL = [
  `CREATE TABLE IF NOT EXISTS meeting_auto_state (file_id TEXT PRIMARY KEY,modified_at TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',text_hash TEXT,note_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL DEFAULT '',lease_until TEXT,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meeting_auto_bindings (file_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,actor_id TEXT NOT NULL,alias TEXT,enabled INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)`,
];
