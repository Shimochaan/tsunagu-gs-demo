import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { accountFor } from "./access.ts";
import { requireThat } from "./security.ts";

export async function calculateProductivityMetrics(
  rt: Runtime,
  tenantId: string,
  oaId: string,
) {
  const ts = await rt.openDatabase(tenantId, oaId, "tsunagu");
  const h = await rt.openDatabase(tenantId, oaId, "harness");

  // 1. Work time measurement
  const workRows = await all(
    ts,
    "SELECT active_seconds FROM work_events WHERE occurred_at > ?",
    [new Date(Date.now() - 30 * 86400_000).toISOString()],
  );
  const totalActiveSeconds = workRows.reduce((sum, r) => sum + (r.active_seconds || 0), 0);

  // 2. Proposals approved in last 30 days
  const approvedProposals = await all(
    ts,
    "SELECT id FROM proposals WHERE state IN ('approved','sent') AND updated_at > ?",
    [new Date(Date.now() - 30 * 86400_000).toISOString()],
  );
  const proposalCount = approvedProposals.length;

  // Estimated manual time: 15 minutes (900 seconds) per draft research & writing
  const manualEstimateSeconds = proposalCount * 900;
  const savedSeconds = Math.max(0, manualEstimateSeconds - totalActiveSeconds);
  const savedMinutes = Math.round(savedSeconds / 60);

  // 3. Appointments and Attribution
  const appointments = await all(
    h,
    "SELECT id, state, attribution, starts_at FROM appointments WHERE starts_at > ?",
    [new Date(Date.now() - 30 * 86400_000).toISOString()],
  );

  const byAttribution = {
    tsunagu_link: appointments.filter((a) => a.attribution === "tsunagu_link").length,
    calendar_correlated: appointments.filter((a) => a.attribution === "calendar_correlated").length,
    unconfirmed: appointments.filter((a) => a.attribution === "unconfirmed").length,
  };

  const attendedCount = appointments.filter((a) => a.state === "attended").length;

  // 4. Usage costs in last 30 days
  const usageRows = await all(
    rt.db,
    "SELECT cost_micros FROM usage_events WHERE tenant_id=? AND oa_id=? AND occurred_at > ?",
    [tenantId, oaId, new Date(Date.now() - 30 * 86400_000).toISOString()],
  );

  let totalCostMicros = 0;
  let hasUnsetPrices = false;

  for (const u of usageRows) {
    if (u.cost_micros == null) {
      hasUnsetPrices = true;
    } else {
      totalCostMicros += u.cost_micros;
    }
  }

  return {
    time: {
      totalActiveSeconds,
      approvedProposalsCount: proposalCount,
      estimatedManualSeconds: manualEstimateSeconds,
      estimatedSavedMinutes: savedMinutes,
      unitPricePerProposalMinutes: 15,
    },
    attribution: {
      totalAppointments: appointments.length,
      attendedCount,
      breakdown: byAttribution,
    },
    costs: {
      hasUnsetPrices,
      totalCostMicros: hasUnsetPrices ? null : totalCostMicros,
      costStatusMessage: hasUnsetPrices
        ? "一部のAI利用単価が未設定のため原価未算出"
        : `${(totalCostMicros / 1_000_000).toFixed(4)} USD`,
    },
  };
}

export function registerProductivity(app: Hono<AppEnv>) {
  // Record work time event
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/work-events",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenant, oaId);

      const b = z
        .object({
          proposalId: z.string().optional(),
          activeSeconds: z.number().int().min(0).max(300),
        })
        .strict()
        .parse(await c.req.json());

      const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
      await ts.query(
        "INSERT INTO work_events(id,user_id,proposal_id,active_seconds,occurred_at) VALUES (?,?,?,?,?)",
        [id(), actor, b.proposalId || null, b.activeSeconds, now()],
      );

      return c.json({ ok: true });
    },
  );

  // Performance & Productivity Dashboard metrics
  app.get(
    "/api/tenants/:tenantId/accounts/:oaId/metrics/performance",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId");
      await accountFor(rt, tenant, oaId);

      const metrics = await calculateProductivityMetrics(rt, tenant, oaId);
      return c.json(metrics);
    },
  );
}
