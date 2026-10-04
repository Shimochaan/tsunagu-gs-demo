import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { requireRoles, requireOps } from "./access.ts";
import { requireThat, audit } from "./security.ts";

export interface BillingLineItem {
  id: string;
  category: "base_fee" | "ai_generation" | "line_delivery" | "adjustment";
  description: string;
  count?: number;
  unitPrice?: number;
  amount: number;
}

export async function computeMonthlyStatement(
  rt: Runtime,
  tenantId: string,
  yearMonth: string, // "YYYY-MM"
) {
  const tenant = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [tenantId]);
  requireThat(tenant, 404, "TENANT_NOT_FOUND", "企業が見つかりません。");

  const [yearStr, monthStr] = yearMonth.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  requireThat(!isNaN(year) && !isNaN(month) && month >= 1 && month <= 12, 400, "INVALID_YEAR_MONTH", "請求年月はYYYY-MM形式で指定してください。");

  const startIso = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
  const endIso = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();

  // Settings & stored billing state
  const settings = parse(tenant.settings, {});
  const billingStatements = settings.billingStatements || {};
  const stored = billingStatements[yearMonth];

  if (stored && stored.state === "finalized") {
    return stored;
  }

  // 1. Base Fee
  const baseMonthlyFee = tenant.monthly_fee != null ? tenant.monthly_fee : 50000;
  const lineItems: BillingLineItem[] = [
    {
      id: "line_base",
      category: "base_fee",
      description: "TSUNAGU 月額基本利用料",
      amount: baseMonthlyFee,
    },
  ];

  // 2. AI Generations count in that month
  const genCount = (
    await one(
      rt.db,
      "SELECT count(*) as c FROM usage_events WHERE tenant_id=? AND kind='generation' AND occurred_at >= ? AND occurred_at < ?",
      [tenantId, startIso, endIso],
    )
  )?.c || 0;

  const genUnitPrice = settings.pricePerGeneration != null ? settings.pricePerGeneration : 10;
  if (genCount > 0) {
    lineItems.push({
      id: "line_gen",
      category: "ai_generation",
      description: "AI追客提案生成利用料",
      count: genCount,
      unitPrice: genUnitPrice,
      amount: genCount * genUnitPrice,
    });
  }

  // 3. Sent deliveries
  const deliveryCount = (
    await one(
      rt.db,
      "SELECT count(*) as c FROM usage_events WHERE tenant_id=? AND kind='delivery' AND occurred_at >= ? AND occurred_at < ?",
      [tenantId, startIso, endIso],
    )
  )?.c || 0;

  const deliveryUnitPrice = settings.pricePerDelivery != null ? settings.pricePerDelivery : 5;
  if (deliveryCount > 0) {
    lineItems.push({
      id: "line_deliv",
      category: "line_delivery",
      description: "LINE個別メッセージ送信利用料",
      count: deliveryCount,
      unitPrice: deliveryUnitPrice,
      amount: deliveryCount * deliveryUnitPrice,
    });
  }

  // 4. Stored adjustments if present
  const adjustments: BillingLineItem[] = stored?.adjustments || [];
  lineItems.push(...adjustments);

  const subtotal = lineItems.reduce((acc, it) => acc + it.amount, 0);
  const taxAmount = Math.round(subtotal * 0.1);
  const totalAmount = subtotal + taxAmount;

  return {
    tenantId,
    yearMonth,
    state: stored?.state || "draft",
    approvedBy: stored?.approvedBy || null,
    approvedAt: stored?.approvedAt || null,
    currency: tenant.currency || "JPY",
    lineItems,
    adjustments,
    subtotal,
    taxAmount,
    totalAmount,
    updatedAt: now(),
  };
}

export function registerBilling(app: Hono<AppEnv>) {
  // Get Monthly Statement Draft or Final
  app.get("/api/tenants/:tenantId/billing/:yearMonth", async (c) => {
    requireRoles(c, "org_owner", "sys_admin");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      yearMonth = c.req.param("yearMonth");

    const statement = await computeMonthlyStatement(rt, tenantId, yearMonth);
    return c.json(statement);
  });

  // Add adjustment to draft statement
  app.post("/api/tenants/:tenantId/billing/:yearMonth/adjust", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      yearMonth = c.req.param("yearMonth"),
      actor = c.get("principal").user.id;

    const b = z
      .object({
        description: z.string().min(1).max(200),
        amount: z.number().int(), // Can be negative (discount/credit)
      })
      .strict()
      .parse(await c.req.json());

    const tenant = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [tenantId]);
    requireThat(tenant, 404, "TENANT_NOT_FOUND", "企業が見つかりません。");

    const settings = parse(tenant.settings, {});
    settings.billingStatements = settings.billingStatements || {};
    const current = await computeMonthlyStatement(rt, tenantId, yearMonth);
    requireThat(current.state !== "finalized", 409, "ALREADY_FINALIZED", "確定済みの請求書は変更できません。");

    const adjustments = current.adjustments || [];
    adjustments.push({
      id: id(),
      category: "adjustment",
      description: b.description,
      amount: b.amount,
    });

    settings.billingStatements[yearMonth] = {
      ...current,
      adjustments,
      state: "draft",
    };

    await rt.db.query("UPDATE tenants SET settings=?,version=version+1 WHERE id=?", [
      json(settings),
      tenantId,
    ]);

    await audit(rt.db, actor, "billing.adjusted", yearMonth, tenantId, {
      description: b.description,
      amount: b.amount,
    });

    const updated = await computeMonthlyStatement(rt, tenantId, yearMonth);
    return c.json(updated);
  });

  // Approve statement (ready to finalize)
  app.post("/api/tenants/:tenantId/billing/:yearMonth/approve", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      yearMonth = c.req.param("yearMonth"),
      actor = c.get("principal").user.id;

    const tenant = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [tenantId]);
    requireThat(tenant, 404, "TENANT_NOT_FOUND", "企業が見つかりません。");

    const current = await computeMonthlyStatement(rt, tenantId, yearMonth);
    requireThat(current.state !== "finalized", 409, "ALREADY_FINALIZED", "確定済みの請求書です。");

    const settings = parse(tenant.settings, {});
    settings.billingStatements = settings.billingStatements || {};
    settings.billingStatements[yearMonth] = {
      ...current,
      state: "approved",
      approvedBy: actor,
      approvedAt: now(),
    };

    await rt.db.query("UPDATE tenants SET settings=?,version=version+1 WHERE id=?", [
      json(settings),
      tenantId,
    ]);

    await audit(rt.db, actor, "billing.approved", yearMonth, tenantId);

    const updated = await computeMonthlyStatement(rt, tenantId, yearMonth);
    return c.json(updated);
  });

  // Finalize statement (tenant admin or sys_admin)
  app.post("/api/tenants/:tenantId/billing/:yearMonth/finalize", async (c) => {
    requireRoles(c, "org_owner", "sys_admin");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      yearMonth = c.req.param("yearMonth"),
      actor = c.get("principal").user.id;

    const tenant = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [tenantId]);
    requireThat(tenant, 404, "TENANT_NOT_FOUND", "企業が見つかりません。");

    const current = await computeMonthlyStatement(rt, tenantId, yearMonth);
    requireThat(current.state === "approved", 409, "APPROVAL_REQUIRED", "請求書を確定する前に承認を完了してください。");

    const settings = parse(tenant.settings, {});
    settings.billingStatements = settings.billingStatements || {};
    settings.billingStatements[yearMonth] = {
      ...current,
      state: "finalized",
      finalizedBy: actor,
      finalizedAt: now(),
    };

    await rt.db.query("UPDATE tenants SET settings=?,version=version+1 WHERE id=?", [
      json(settings),
      tenantId,
    ]);

    await audit(rt.db, actor, "billing.finalized", yearMonth, tenantId, {
      totalAmount: current.totalAmount,
    });

    return c.json({ ok: true, state: "finalized", totalAmount: current.totalAmount });
  });

  // Ops Finalize statement
  app.post("/api/ops/tenants/:tenantId/billing/:yearMonth/finalize", async (c) => {
    requireOps(c, "ops_owner");
    const rt = c.env.runtime,
      tenantId = c.req.param("tenantId"),
      yearMonth = c.req.param("yearMonth"),
      actor = c.get("principal").user.id;

    const tenant = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [tenantId]);
    requireThat(tenant, 404, "TENANT_NOT_FOUND", "企業が見つかりません。");

    const current = await computeMonthlyStatement(rt, tenantId, yearMonth);
    requireThat(current.state === "approved", 409, "APPROVAL_REQUIRED", "請求書を確定する前に承認を完了してください。");

    const settings = parse(tenant.settings, {});
    settings.billingStatements = settings.billingStatements || {};
    settings.billingStatements[yearMonth] = {
      ...current,
      state: "finalized",
      finalizedBy: actor,
      finalizedAt: now(),
    };

    await rt.db.query("UPDATE tenants SET settings=?,version=version+1 WHERE id=?", [
      json(settings),
      tenantId,
    ]);

    await audit(rt.db, actor, "billing.finalized", yearMonth, tenantId, {
      totalAmount: current.totalAmount,
      byOps: true,
    });

    return c.json({ ok: true, state: "finalized", totalAmount: current.totalAmount });
  });
}
