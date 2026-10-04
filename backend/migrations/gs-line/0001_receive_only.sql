-- Dedicated Gs receive/read-only Harness; no outgoing message table.
CREATE TABLE IF NOT EXISTS gs_line_events (id TEXT PRIMARY KEY,hash TEXT NOT NULL,claim TEXT NOT NULL,received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gs_line_friends (id TEXT PRIMARY KEY,line_user_id TEXT NOT NULL UNIQUE,is_following INTEGER NOT NULL,event_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gs_line_messages (id TEXT PRIMARY KEY,friend_id TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gs_line_messages_friend ON gs_line_messages(friend_id,created_at);
