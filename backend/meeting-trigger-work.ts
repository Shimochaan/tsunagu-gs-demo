/** Transfer due confirmed meeting events into the existing dirty queue once. */
export const meetingTriggerDDL = [
  `CREATE TABLE IF NOT EXISTS assistant_meeting_due (event_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,due_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS assistant_meeting_due_time ON assistant_meeting_due(due_at,event_id)`,
  ...["INSERT","UPDATE"].map(event=>`CREATE TRIGGER IF NOT EXISTS assistant_meeting_due_${event.toLowerCase()} AFTER ${event} ON events WHEN NEW.type='meeting.trigger' BEGIN DELETE FROM assistant_meeting_due WHERE event_id=NEW.id; INSERT INTO assistant_meeting_due(event_id,customer_id,due_at) SELECT NEW.id,NEW.customer_id,json_extract(NEW.payload,'$.scheduledAt') WHERE NEW.state='pending' AND json_valid(NEW.payload) AND json_extract(NEW.payload,'$.noteId') IS NOT NULL AND json_extract(NEW.payload,'$.scheduledAt') IS NOT NULL; END`),
  `CREATE TRIGGER IF NOT EXISTS assistant_meeting_due_delete AFTER DELETE ON events BEGIN DELETE FROM assistant_meeting_due WHERE event_id=OLD.id; END`,
];
