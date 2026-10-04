CREATE TABLE IF NOT EXISTS booking_receipts (external_id TEXT PRIMARY KEY,title TEXT NOT NULL,guest_name TEXT,starts_at TEXT NOT NULL,ends_at TEXT,state TEXT NOT NULL,received_at TEXT NOT NULL);
