/** Additive, local-first tracking. No migration enables notifications or delivery. */
export const followupDDL = [
  `CREATE TABLE IF NOT EXISTS followup_profiles (customer_id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,line_user_id TEXT NOT NULL,data TEXT NOT NULL,evidence TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,confirmed_by TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS followup_journeys (customer_id TEXT PRIMARY KEY,state TEXT NOT NULL,detail TEXT NOT NULL,signature TEXT NOT NULL,next_at TEXT,updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS followup_due ON followup_journeys(next_at,customer_id) WHERE next_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS followup_meetings (appointment_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,proposal_id TEXT,confirmed_by TEXT NOT NULL,confirmed_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS followup_meetings_customer ON followup_meetings(customer_id)`,
  `CREATE TABLE IF NOT EXISTS followup_measurements (proposal_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,actor_id TEXT NOT NULL,baseline_seconds INTEGER NOT NULL,review_seconds INTEGER NOT NULL,created_at TEXT NOT NULL)`,
  ...["INSERT", "UPDATE"].map(
    (event) =>
      `CREATE TRIGGER IF NOT EXISTS followup_profile_${event.toLowerCase()} AFTER ${event} ON followup_profiles BEGIN INSERT INTO assistant_work_queue(customer_id) VALUES (NEW.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1,due_at='',priority=MIN(priority,1),attempts=0; END`,
  ),
  ...["INSERT", "UPDATE"].map(
    (event) =>
      `CREATE TRIGGER IF NOT EXISTS followup_meeting_${event.toLowerCase()} AFTER ${event} ON followup_meetings BEGIN INSERT INTO assistant_work_queue(customer_id) VALUES (NEW.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1,due_at='',priority=MIN(priority,1),attempts=0; END`,
  ),
];
export const followupHarnessDDL = [
  `CREATE INDEX IF NOT EXISTS followup_outbox_customer_state ON outbox(customer_id,state,accepted_at DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS followup_sent_customer ON outbox(customer_id,accepted_at DESC,id DESC) WHERE state='sent'`,
  `CREATE INDEX IF NOT EXISTS followup_appointments_customer ON appointments(customer_id,starts_at DESC,id DESC)`,
  ...["INSERT", "UPDATE", "DELETE"].map((event) => {
    const ref = event === "DELETE" ? "OLD" : "NEW";
    return `CREATE TRIGGER IF NOT EXISTS followup_appointment_${event.toLowerCase()} AFTER ${event} ON appointments BEGIN INSERT INTO assistant_message_changes(customer_id) VALUES (${ref}.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1; ${event === "UPDATE" ? "INSERT INTO assistant_message_changes(customer_id) VALUES (OLD.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1;" : ""} END`;
  }),
  `CREATE TRIGGER IF NOT EXISTS followup_sent_outbox AFTER UPDATE OF state ON outbox WHEN NEW.state IN ('sent','uncertain') AND OLD.state<>NEW.state BEGIN INSERT INTO assistant_message_changes(customer_id) VALUES (NEW.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1; END`,
];
