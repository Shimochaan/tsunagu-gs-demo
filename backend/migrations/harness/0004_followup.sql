-- Additive tracking schema. Does not enable delivery or automation.
CREATE INDEX IF NOT EXISTS followup_outbox_customer_state ON outbox(customer_id,state,accepted_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS followup_sent_customer ON outbox(customer_id,accepted_at DESC,id DESC) WHERE state='sent';
CREATE INDEX IF NOT EXISTS followup_appointments_customer ON appointments(customer_id,starts_at DESC,id DESC);
CREATE TRIGGER IF NOT EXISTS followup_appointment_insert AFTER INSERT ON appointments BEGIN INSERT INTO assistant_message_changes(customer_id) VALUES (NEW.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1;  END;
CREATE TRIGGER IF NOT EXISTS followup_appointment_update AFTER UPDATE ON appointments BEGIN INSERT INTO assistant_message_changes(customer_id) VALUES (NEW.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1; INSERT INTO assistant_message_changes(customer_id) VALUES (OLD.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER IF NOT EXISTS followup_appointment_delete AFTER DELETE ON appointments BEGIN INSERT INTO assistant_message_changes(customer_id) VALUES (OLD.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1;  END;
CREATE TRIGGER IF NOT EXISTS followup_sent_outbox AFTER UPDATE OF state ON outbox WHEN NEW.state IN ('sent','uncertain') AND OLD.state<>NEW.state BEGIN INSERT INTO assistant_message_changes(customer_id) VALUES (NEW.customer_id) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1; END;
