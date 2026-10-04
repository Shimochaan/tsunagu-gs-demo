import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { requireOps, requireRoles, accountFor } from "./access.ts";
import { requireThat, audit } from "./security.ts";

export async function hasValidSupportAccess(
  rt: Runtime,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const row = await one(
    rt.db,
    "SELECT id FROM support_access WHERE tenant_id=? AND requested_by=? AND state='approved' AND expires_at > ?",
    [tenantId, userId, now()],
  );
  return Boolean(row);
}

export async function enforceRetentionPolicy(
  rt: Runtime,
  tenantId: string,
  oaId: string,
) {
  const tenant = await one(rt.db, "SELECT settings FROM tenants WHERE id=?", [
    tenantId,
  ]);
  const settings = parse(tenant?.settings, {});
  const messageRetentionDays = settings.messageRetentionDays || 180;
  const outboxRetentionDays = settings.outboxRetentionDays || 60;

  const msgCutoff = new Date(
    Date.now() - messageRetentionDays * 86400_000,
  ).toISOString();
  const outboxCutoff = new Date(
    Date.now() - outboxRetentionDays * 86400_000,
  ).toISOString();

  const h = await rt.openDatabase(tenantId, oaId, "harness");

  // Prune old messages
  const msgRes = await h.query(
    "DELETE FROM messages WHERE recorded_at < ?",
    [msgCutoff],
  );

  // Prune finalized or cancelled outbox records (never pending/uncertain)
  const outboxRes = await h.query(
    "DELETE FROM outbox WHERE scheduled_at < ? AND state IN ('sent','cancelled')",
    [outboxCutoff],
  );

  return {
    messagesPruned: msgRes.changes,
    outboxPruned: outboxRes.changes,
    messageRetentionDays,
    outboxRetentionDays,
  };
}

export function registerOperations(app: Hono<AppEnv>) {
  // Ops requests time-bound support access
  app.post("/api/ops/support/request", async (c) => {
    requireOps(c);
    const rt = c.env.runtime,
      actor = c.get("principal").user.id;

    const b = z
      .object({
        tenantId: z.string(),
        oaId: z.string().default(""),
        reason: z.string().min(5).max(500),
        scope: z.enum(["investigation", "setup_support", "data_migration"]),
        durationHours: z.number().int().min(1).max(72).default(24),
      })
      .strict()
      .parse(await c.req.json());

    const accessId = id();
    const expiresAt = new Date(
      Date.now() + b.durationHours * 3600_000,
    ).toISOString();

    await rt.db.query(
      "INSERT INTO support_access(id,tenant_id,oa_id,requested_by,reason,scope,expires_at,state,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)",
      [
        accessId,
        b.tenantId,
        b.oaId,
        actor,
        b.reason,
        b.scope,
        expiresAt,
        now(),
      ],
    );

    await audit(rt.db, actor, "support.requested", accessId, b.tenantId, {
      reason: b.reason,
      durationHours: b.durationHours,
    });

    return c.json({ ok: true, accessId, expiresAt, state: "pending" });
  });

  // Customer admin approves support access
  app.post("/api/tenants/:tenantId/support/:id/approve", async (c) => {
    requireRoles(c, "org_owner");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      accessId = c.req.param("id"),
      actor = c.get("principal").user.id;

    const access = await one(
      rt.db,
      "SELECT * FROM support_access WHERE id=? AND tenant_id=?",
      [accessId, tenantId],
    );
    requireThat(access, 404, "NOT_FOUND", "サポート申請が見つかりません。");
    requireThat(
      access.state === "pending",
      409,
      "INVALID_STATE",
      "この申請はすでに処理されています。",
    );

    await rt.db.query(
      "UPDATE support_access SET state='approved',approved_by=? WHERE id=?",
      [actor, accessId],
    );

    await audit(rt.db, actor, "support.approved", accessId, tenantId);

    return c.json({ ok: true, state: "approved" });
  });

  // Customer admin revokes support access
  app.post("/api/tenants/:tenantId/support/:id/revoke", async (c) => {
    requireRoles(c, "org_owner");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      accessId = c.req.param("id"),
      actor = c.get("principal").user.id;

    const access = await one(
      rt.db,
      "SELECT * FROM support_access WHERE id=? AND tenant_id=?",
      [accessId, tenantId],
    );
    requireThat(access, 404, "NOT_FOUND", "サポート申請が見つかりません。");

    await rt.db.query(
      "UPDATE support_access SET state='revoked' WHERE id=?",
      [accessId],
    );

    await audit(rt.db, actor, "support.revoked", accessId, tenantId);

    return c.json({ ok: true, state: "revoked" });
  });

  // Ops audit log of read execution under support access
  app.post("/api/ops/support/:id/audit-read", async (c) => {
    requireOps(c);
    const rt = c.env.runtime,
      accessId = c.req.param("id"),
      actor = c.get("principal").user.id;

    const access = await one(
      rt.db,
      "SELECT * FROM support_access WHERE id=? AND state='approved' AND expires_at > ?",
      [accessId, now()],
    );
    requireThat(
      access,
      403,
      "ACCESS_EXPIRED",
      "サポートアクセス権限が有効期限切れ、または承認されていません。",
    );

    const b = z
      .object({
        resource: z.string().min(1),
        action: z.string().min(1),
      })
      .parse(await c.req.json());

    await audit(rt.db, actor, "support.read_accessed", access.tenant_id, access.tenant_id, {
      accessId,
      resource: b.resource,
      action: b.action,
    });

    return c.json({ ok: true });
  });

  // Retention run
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/retention/run",
    async (c) => {
      requireRoles(c, "sys_admin", "org_owner");
      const rt = c.env.runtime,
        tenantId = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenantId, oaId);

      const result = await enforceRetentionPolicy(rt, tenantId, oaId);
      await audit(rt.db, actor, "retention.enforced", oaId, tenantId, result);

      return c.json({ ok: true, ...result });
    },
  );
}
