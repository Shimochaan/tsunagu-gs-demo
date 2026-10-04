import { demoLivePlatformDDL, demoLiveTsunaguDDL } from "./demo-live-schema.ts";
import { selfDemoDDL } from "./self-demo-access.ts";
import { calendarDDL,calendarStateDDL } from "./calendar.ts";
import { meetingAutoDDL } from "./meeting-auto-schema.ts";
import { learningDDL } from "./assistant-learning.ts";
import { conversationSyncDDL } from "./harness-conversations.ts";
import { newsOAuthDDL } from "./assistant-google-schema.ts";
import { customerTestDDL } from "./customer-test-schema.ts";
import { googleDDL } from "./assistant-google-schema.ts";
import { meetingTriggerDDL } from "./meeting-trigger-work.ts";
import { proposalEventDDL } from "./proposal-events.ts";
import { customerRecordingDDL } from "./customer-recordings.ts";
import { businessDDL } from "./business.ts";
import { followupDDL, followupHarnessDDL } from "./followup-schema.ts";
import {
  performancePlatformDDL,
  performanceCommonDDL,
  performanceHarnessDDL,
  performanceTsunaguDDL,
} from "./assistant-performance-schema.ts";
import { assistantPlatformDDL, assistantDDL } from "./assistant-schema.ts";
import {
  driveStateDDL,
  meetingInboxDDL,
  bookingReceiptsDDL,
} from "./meeting-schema.ts";
// 物理DBの境界を保つ。別DBへの参照はIDで結び、SQLの外部キーとは扱わない。
export const platformSchema = [
  ...demoLivePlatformDDL,
  ...selfDemoDDL,
  ...customerTestDDL,
  newsOAuthDDL,
  businessDDL,
  ...proposalEventDDL,
  ...assistantPlatformDDL,
  driveStateDDL,
  calendarStateDDL,
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'sales', method TEXT NOT NULL DEFAULT 'lecture', product TEXT NOT NULL DEFAULT 'existing', state TEXT NOT NULL DEFAULT 'setup', plan_name TEXT, monthly_fee INTEGER, currency TEXT NOT NULL DEFAULT 'JPY', settings TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memberships (tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL, roles TEXT NOT NULL, teams TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (tenant_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS ops_assignments (email TEXT PRIMARY KEY, role TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active')`,
  `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL, roles TEXT NOT NULL, teams TEXT NOT NULL DEFAULT '[]', expires_at TEXT NOT NULL, accepted_by TEXT, accepted_at TEXT, revoked_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, owner_user_id TEXT, operators TEXT NOT NULL DEFAULT '[]', team_id TEXT, channel_id TEXT UNIQUE, destination TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'credentials', webhook_mode TEXT NOT NULL DEFAULT 'unconfirmed', webhook_verified_at TEXT, calibration_ready INTEGER NOT NULL DEFAULT 0, preview_ready INTEGER NOT NULL DEFAULT 0, primary_calibration_user_id TEXT, sync_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS databases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL, physical_id TEXT, state TEXT NOT NULL DEFAULT 'pending', schema_version INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id,oa_id,purpose))`,
  `CREATE TABLE IF NOT EXISTS tenant_runtimes (tenant_id TEXT PRIMARY KEY, url TEXT, version INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending')`,
  `CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', service TEXT NOT NULL, ciphertext TEXT NOT NULL, key_version TEXT NOT NULL, registered_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,oa_id,service))`,
  `CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', service TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'disconnected', config TEXT NOT NULL DEFAULT '{}', last_sync_at TEXT, last_error TEXT, UNIQUE(tenant_id,oa_id,service))`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', dedupe_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, error_code TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, tenant_id TEXT, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS support_access (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, requested_by TEXT NOT NULL, reason TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', approved_by TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, kind TEXT NOT NULL, units INTEGER NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER, unit_price_snapshot TEXT, cost_micros INTEGER, currency TEXT, state TEXT NOT NULL, occurred_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session_context (session_id TEXT PRIMARY KEY, tenant_id TEXT, mfa_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS mfa_factors (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT -1, attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT)`,
  `CREATE TABLE IF NOT EXISTS idempotency (actor_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, result_id TEXT NOT NULL, PRIMARY KEY(actor_id,key))`,
  `CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state,lease_until)`,
  `CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit(tenant_id,at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
];
export const commonSchema = [
  `CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT, team_id TEXT, mode TEXT NOT NULL DEFAULT 'ai', stage TEXT NOT NULL DEFAULT 'prospect', opt_out INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, confirmed_at TEXT, confirmed_by TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS customer_links (oa_id TEXT NOT NULL, line_user_id TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id), state TEXT NOT NULL DEFAULT 'confirmed', PRIMARY KEY(oa_id,line_user_id))`,
  `CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS external_links (oa_id TEXT NOT NULL, service TEXT NOT NULL, external_id TEXT NOT NULL, customer_id TEXT NOT NULL, line_user_id TEXT NOT NULL, PRIMARY KEY(oa_id,service,external_id), UNIQUE(oa_id,service,line_user_id))`,
  `CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, oa_id TEXT NOT NULL, customer_id TEXT NOT NULL, appointment_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'candidate', occurred_at TEXT NOT NULL, confirmed_by TEXT, UNIQUE(oa_id,appointment_id,kind))`,
  `CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY, at TEXT NOT NULL)`,
];
export const harnessSchema = [
  conversationSyncDDL,
  bookingReceiptsDDL,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, line_user_id TEXT NOT NULL, direction TEXT NOT NULL, source TEXT NOT NULL, actor_id TEXT, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', external_id TEXT UNIQUE, state TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, customer_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending')`,
  `CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT, state TEXT NOT NULL, source TEXT NOT NULL, attribution TEXT NOT NULL DEFAULT 'unconfirmed', details TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, line_user_id TEXT NOT NULL, proposal_id TEXT, proposal_version INTEGER, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sales', state TEXT NOT NULL DEFAULT 'pending', scheduled_at TEXT NOT NULL, retry_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, error_code TEXT, accepted_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS messages_customer_idx ON messages(customer_id,recorded_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_state_idx ON outbox(state,scheduled_at)`,
];
export const tsunaguSchema = [
  ...demoLiveTsunaguDDL,
  ...learningDDL,
  ...customerRecordingDDL,
  ...meetingAutoDDL,
  ...calendarDDL,
  ...assistantDDL,
  ...googleDDL,
  meetingInboxDDL,
  `CREATE TABLE IF NOT EXISTS generation_runs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, customer_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running', proposal_id TEXT, reason TEXT, created_at TEXT NOT NULL, UNIQUE(actor_id,request_key))`,
  `CREATE TABLE IF NOT EXISTS context_notes (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, appointment_id TEXT, source TEXT NOT NULL, source_ref TEXT, body TEXT NOT NULL, deal_state TEXT NOT NULL DEFAULT 'unknown', confirmed_by TEXT, confirmed_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, url TEXT, harness_id TEXT, state TEXT NOT NULL DEFAULT 'review', expires_at TEXT, body TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, trigger TEXT NOT NULL, reason TEXT NOT NULL, context_refs TEXT NOT NULL DEFAULT '[]', draft TEXT NOT NULL, asset_id TEXT, confidence TEXT NOT NULL DEFAULT 'review', state TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1, customer_version INTEGER NOT NULL, history_cursor TEXT, scheduled_at TEXT, approved_by TEXT, approved_version INTEGER, hold_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS proposal_versions (proposal_id TEXT NOT NULL, version INTEGER NOT NULL, draft TEXT NOT NULL, asset_id TEXT, scheduled_at TEXT, actor_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(proposal_id,version))`,
  `CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, version INTEGER NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, original TEXT, final TEXT, classification TEXT, confirmed INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS style_profiles (user_id TEXT PRIMARY KEY, answers TEXT NOT NULL DEFAULT '{}', features TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, label TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 0 AND 1), config TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS work_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, proposal_id TEXT, active_seconds INTEGER NOT NULL CHECK(active_seconds BETWEEN 0 AND 300), occurred_at TEXT NOT NULL)`,
];
platformSchema.push(...performancePlatformDDL);
commonSchema.push(...performanceCommonDDL);
harnessSchema.push(...performanceHarnessDDL);
tsunaguSchema.push(...performanceTsunaguDDL, ...followupDDL);
harnessSchema.push(...followupHarnessDDL, ...meetingTriggerDDL);
export const schemas = {
  common: commonSchema,
  harness: harnessSchema,
  tsunagu: tsunaguSchema,
};
export type Purpose = keyof typeof schemas;
