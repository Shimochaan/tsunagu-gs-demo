-- Generated from backend/schema.ts and installed Better Auth schema. No data.
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE accounts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, owner_user_id TEXT, operators TEXT NOT NULL DEFAULT '[]', team_id TEXT, channel_id TEXT UNIQUE, destination TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'credentials', webhook_mode TEXT NOT NULL DEFAULT 'unconfirmed', webhook_verified_at TEXT, calibration_ready INTEGER NOT NULL DEFAULT 0, preview_ready INTEGER NOT NULL DEFAULT 0, sync_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

CREATE TABLE audit (id TEXT PRIMARY KEY, tenant_id TEXT, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);

CREATE TABLE connections (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', service TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'disconnected', config TEXT NOT NULL DEFAULT '{}', last_sync_at TEXT, last_error TEXT, UNIQUE(tenant_id,oa_id,service));

CREATE TABLE credentials (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', service TEXT NOT NULL, ciphertext TEXT NOT NULL, key_version TEXT NOT NULL, registered_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,oa_id,service));

CREATE TABLE databases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL, physical_id TEXT, state TEXT NOT NULL DEFAULT 'pending', schema_version INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id,oa_id,purpose));

CREATE TABLE idempotency (actor_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, result_id TEXT NOT NULL, PRIMARY KEY(actor_id,key));

CREATE TABLE invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL, roles TEXT NOT NULL, teams TEXT NOT NULL DEFAULT '[]', expires_at TEXT NOT NULL, accepted_by TEXT, accepted_at TEXT, revoked_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', dedupe_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, error_code TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE memberships (tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL, roles TEXT NOT NULL, teams TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (tenant_id,user_id));

CREATE TABLE mfa_factors (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT -1, attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT);

CREATE TABLE ops_assignments (email TEXT PRIMARY KEY, role TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');

CREATE TABLE "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);

CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

CREATE TABLE session_context (session_id TEXT PRIMARY KEY, tenant_id TEXT, mfa_at TEXT);

CREATE TABLE support_access (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, requested_by TEXT NOT NULL, reason TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', approved_by TEXT, created_at TEXT NOT NULL);

CREATE TABLE tenant_runtimes (tenant_id TEXT PRIMARY KEY, url TEXT, version INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending');

CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'sales', method TEXT NOT NULL DEFAULT 'lecture', product TEXT NOT NULL DEFAULT 'existing', state TEXT NOT NULL DEFAULT 'setup', plan_name TEXT, monthly_fee INTEGER, currency TEXT NOT NULL DEFAULT 'JPY', settings TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

CREATE TABLE usage_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, kind TEXT NOT NULL, units INTEGER NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER, unit_price_snapshot TEXT, cost_micros INTEGER, currency TEXT, state TEXT NOT NULL, occurred_at TEXT NOT NULL);

CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE INDEX audit_tenant_idx ON audit(tenant_id,at);

CREATE INDEX jobs_state_idx ON jobs(state,lease_until);

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");
