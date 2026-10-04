-- Performance Indexes for fast auth, memberships, invitations and accounts lookups
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations(email);
CREATE INDEX IF NOT EXISTS accounts_tenant_idx ON accounts(tenant_id);
