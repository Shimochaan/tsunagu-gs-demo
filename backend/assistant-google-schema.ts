import { syncDDL } from "./assistant-sync-schema.ts";
export const googleDDL = [
  ...syncDDL,
  `CREATE TABLE IF NOT EXISTS assistant_google_config (id TEXT PRIMARY KEY,actor TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,review_id TEXT,review_state TEXT,review_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS assistant_research_days (day TEXT PRIMARY KEY,actor TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,result TEXT,archive_id TEXT,error_code TEXT)`,
];

export const newsOAuthDDL = `CREATE TABLE IF NOT EXISTS assistant_news_oauth_states (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,expires_at TEXT NOT NULL)`;
