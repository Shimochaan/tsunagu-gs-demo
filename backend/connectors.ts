import { z } from "zod";
import type { Hono, Context } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { accountFor, customerAccess, requireRoles } from "./access.ts";
import { AppError, requireThat, audit, digest } from "./security.ts";

const sheetsSyncSchema = z.object({
  sourceName: z.string().default("Googleスプレッドシート"),
  rows: z
    .array(
      z.object({
        customerId: z.string().optional(),
        lineUserId: z.string().optional(),
        customerName: z.string().optional(),
        note: z.string().min(1).max(5000),
        dealState: z
          .enum(["unknown", "uncontracted", "negotiating", "won", "lost"])
          .default("unknown"),
        externalRef: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
});

const driveDocSyncSchema = z.object({
  customerId: z.string().optional(),
  lineUserId: z.string().optional(),
  customerName: z.string().optional(),
  docTitle: z.string().min(1).max(200),
  docUrl: z.string().url().optional(),
  summary: z.string().min(1).max(10000),
  dealState: z
    .enum(["unknown", "uncontracted", "negotiating", "won", "lost"])
    .default("unknown"),
});

export async function resolveCustomer(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  identifier: {
    customerId?: string;
    lineUserId?: string;
    customerName?: string;
  },
): Promise<Row | null> {
  const common = await rt.openDatabase(tenantId, "", "common");

  if (identifier.customerId) {
    const cust = await one(common, "SELECT * FROM customers WHERE id=?", [
      identifier.customerId,
    ]);
    if (cust) return cust;
  }

  if (identifier.lineUserId) {
    const link = await one(
      common,
      "SELECT customer_id FROM customer_links WHERE oa_id=? AND line_user_id=?",
      [oaId, identifier.lineUserId],
    );
    if (link) {
      const cust = await one(common, "SELECT * FROM customers WHERE id=?", [
        link.customer_id,
      ]);
      if (cust) return cust;
    }
  }

  if (identifier.customerName) {
    const matches = await all(
      common,
      "SELECT * FROM customers WHERE name=? ORDER BY created_at DESC",
      [identifier.customerName],
    );
    if (matches.length === 1) return matches[0];
  }

  return null;
}

export async function importContextNote(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  params: {
    customerId: string;
    source: string;
    sourceRef?: string;
    body: string;
    dealState?: string;
    confirmedBy: string;
  },
) {
  const ts = await rt.openDatabase(tenantId, oaId, "tsunagu");
  const noteHash = await digest(`${params.source}:${params.body.trim()}`);
  const sourceRef = params.sourceRef || `hash:${noteHash}`;

  const existing = await one(
    ts,
    "SELECT id FROM context_notes WHERE customer_id=? AND source_ref=? AND deleted_at IS NULL",
    [params.customerId, sourceRef],
  );
  if (existing) {
    return { id: existing.id, isDuplicate: true };
  }

  const noteId = id();
  const currentNow = now();
  await ts.query(
    "INSERT INTO context_notes(id,customer_id,source,source_ref,body,deal_state,confirmed_by,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      noteId,
      params.customerId,
      params.source,
      sourceRef,
      params.body.trim(),
      params.dealState || "unknown",
      params.confirmedBy,
      currentNow,
      currentNow,
    ],
  );

  return { id: noteId, isDuplicate: false };
}

export function registerConnectors(app: Hono<AppEnv>) {
  // Google Sheets Master Data Sync
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/connectors/sheets/sync",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenant, oaId);

      const b = sheetsSyncSchema.parse(await c.req.json());
      let imported = 0;
      let duplicates = 0;
      let unmapped = 0;
      const importedIds: string[] = [];

      for (const row of b.rows) {
        const customer = await resolveCustomer(rt, tenant, oaId, {
          customerId: row.customerId,
          lineUserId: row.lineUserId,
          customerName: row.customerName,
        });

        if (!customer) {
          unmapped++;
          continue;
        }

        const res = await importContextNote(rt, tenant, oaId, {
          customerId: customer.id,
          source: `sheets:${b.sourceName}`,
          sourceRef: row.externalRef,
          body: row.note,
          dealState: row.dealState,
          confirmedBy: actor,
        });

        if (res.isDuplicate) {
          duplicates++;
        } else {
          imported++;
          importedIds.push(res.id);
        }
      }

      await audit(rt.db, actor, "connector.sheets_synced", oaId, tenant, {
        totalRows: b.rows.length,
        imported,
        duplicates,
        unmapped,
      });

      return c.json({
        ok: true,
        summary: {
          total: b.rows.length,
          imported,
          duplicates,
          unmapped,
        },
        importedIds,
      });
    },
  );

  // Google Drive Document Sync
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/connectors/drive/sync",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenant, oaId);

      const b = driveDocSyncSchema.parse(await c.req.json());
      const customer = await resolveCustomer(rt, tenant, oaId, {
        customerId: b.customerId,
        lineUserId: b.lineUserId,
        customerName: b.customerName,
      });

      requireThat(
        customer,
        404,
        "CUSTOMER_NOT_FOUND",
        "文書を紐付ける顧客が見つかりません。顧客ID、LINEユーザーID、または顧客氏名を確認してください。",
      );

      const noteText = `【${b.docTitle}】\n${b.summary}${b.docUrl ? `\n(参照: ${b.docUrl})` : ""}`;
      const res = await importContextNote(rt, tenant, oaId, {
        customerId: customer.id,
        source: "google_drive",
        sourceRef: b.docUrl || `drive:${b.docTitle}`,
        body: noteText,
        dealState: b.dealState,
        confirmedBy: actor,
      });

      await audit(rt.db, actor, "connector.drive_synced", oaId, tenant, {
        customerId: customer.id,
        docTitle: b.docTitle,
        isDuplicate: res.isDuplicate,
      });

      return c.json({
        ok: true,
        noteId: res.id,
        isDuplicate: res.isDuplicate,
      });
    },
  );

  // List Context Notes for a Customer
  app.get(
    "/api/tenants/:tenantId/accounts/:oaId/customers/:customerId/notes",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        cid = c.req.param("customerId");
      await accountFor(rt, tenant, oaId);

      const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
      const notes = await all(
        ts,
        "SELECT * FROM context_notes WHERE customer_id=? AND deleted_at IS NULL ORDER BY created_at DESC",
        [cid],
      );

      return c.json({ notes });
    },
  );
}
