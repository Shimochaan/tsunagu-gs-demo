import { registerHarnessConversations } from "./harness-conversations.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { accountFor, requireRoles } from "./access.ts";
import { getCredential, putCredential } from "./credentials.ts";
import { AppError, requireThat, digest, audit } from "./security.ts";
import { holdCustomer } from "./sales.ts";

// 初期対応先はCloudflare上のHarness。接続先からのリダイレクトを追ってAPIキーを漏らさない。
export function harnessOrigin(value: string) {
  const url = new URL(value);
  requireThat(
    url.protocol === "https:" &&
      /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    400,
    "HARNESS_ORIGIN",
    "Harnessのworkers.dev URLを入力してください。",
  );
  return url.origin;
}
export async function harnessRequest(
  rt: Runtime,
  credential: Row,
  path: string,
  body?: unknown,
) {
  const base = harnessOrigin(credential.origin);
  const response = await rt.externalFetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${credential.apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: json(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    requireThat(
      false,
      502,
      "HARNESS_API_FAILED",
      `Harness通信に失敗しました（HTTP ${response.status}）。接続設定と受信側の稼働状態を確認してください。`,
    );
  }
  const result = (await response.json()) as any;
  requireThat(
    result.success === true,
    502,
    "HARNESS_API_FAILED",
    "Harness側の処理がエラーを返しました。接続設定を確認してください。",
  );
  return result.data;
}
const friendSchema = z
  .object({
    id: z.string(),
    lineUserId: z.string(),
    displayName: z.string().nullable(),
    lineAccountId: z.string().nullable(),
    isFollowing: z.boolean(),
  })
  .passthrough();
export async function importFriend(
  rt: Runtime,
  tenant: string,
  oa: Row,
  credential: Row,
  friendId: string,
) {
  const friend = friendSchema.parse(
    await harnessRequest(
      rt,
      credential,
      `/api/friends/${encodeURIComponent(friendId)}`,
    ),
  );
  requireThat(
    friend.lineAccountId === credential.accountId,
    409,
    "HARNESS_ACCOUNT_MISMATCH",
    "連携先の公式LINEが一致しません。",
  );
  const common = await rt.openDatabase(tenant, "", "common");
  const existingLink = await one(
    common,
    "SELECT customer_id FROM customer_links WHERE oa_id=? AND line_user_id=?",
    [oa.id, friend.lineUserId],
  );
  const cid =
    existingLink?.customer_id ??
    (await digest(`${oa.id}:${friend.lineUserId}`)).replace(
      /[^a-zA-Z0-9]/g,
      "",
    );
  await common.batch([
    {
      sql: "INSERT OR IGNORE INTO customers(id,name,owner_user_id,team_id,opt_out,created_at) VALUES (?,?,?,?,?,?)",
      params: [
        cid,
        friend.displayName || "LINEの友だち",
        oa.owner_user_id,
        oa.team_id,
        friend.isFollowing ? 0 : 1,
        now(),
      ],
    },
    {
      sql: "INSERT OR IGNORE INTO customer_links(oa_id,line_user_id,customer_id) VALUES (?,?,?)",
      params: [oa.id, friend.lineUserId, cid],
    },
  ]);
  const link = await one(
    common,
    "SELECT customer_id FROM customer_links WHERE oa_id=? AND line_user_id=?",
    [oa.id, friend.lineUserId],
  );
  await common.query(
    "INSERT INTO external_links(oa_id,service,external_id,customer_id,line_user_id) VALUES (?,'harness',?,?,?) ON CONFLICT(oa_id,service,external_id) DO UPDATE SET customer_id=excluded.customer_id,line_user_id=excluded.line_user_id",
    [oa.id, friend.id, link.customer_id, friend.lineUserId],
  );
  // 仮名だけ補完する。confirmed_at は商談状況の確認でも更新されるため、
  // 氏名確認の判定には使わない。実名や担当者は取込データで上書きしない。
  if (friend.displayName?.trim())
    await common.query(
      "UPDATE customers SET name=?,version=version+1 WHERE id=? AND name IN ('LINEの友だち','LINEの友達')",
      [friend.displayName.trim(), link.customer_id],
    );
  if (!friend.isFollowing) {
    await common.query("UPDATE customers SET opt_out=1 WHERE id=?", [
      link.customer_id,
    ]);
    await holdCustomer(
      rt,
      tenant,
      link.customer_id,
      "LINEで配信停止となっています。",
    );
  }
  return {
    customerId: link.customer_id,
    lineUserId: friend.lineUserId,
    friendId: friend.id,
  };
}
export async function syncConversation(
  rt: Runtime,
  tenant: string,
  oa: Row,
  credential: Row,
  friendId: string,
) {
  const link = await importFriend(rt, tenant, oa, credential, friendId);
  const messages = z
    .array(
      z.object({
        id: z.string(),
        direction: z.enum(["incoming", "outgoing"]),
        messageType: z.string(),
        content: z.string(),
        createdAt: z.string(),
      }),
    )
    .parse(
      await harnessRequest(
        rt,
        credential,
        `/api/friends/${encodeURIComponent(friendId)}/messages`,
      ),
    );
  const h = await rt.openDatabase(tenant, oa.id, "harness");
  let inserted = 0;
  for (const m of messages) {
    const result = await h.query(
      "INSERT OR IGNORE INTO messages(id,customer_id,line_user_id,direction,source,body,kind,external_id,state,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        `harness:${m.id}`,
        link.customerId,
        link.lineUserId,
        m.direction === "incoming" ? "inbound" : "outbound",
        "harness",
        m.content,
        m.messageType,
        `harness:${m.id}`,
        "received",
        m.createdAt,
        now(),
      ],
    );
    inserted += result.changes;
  }
  if (inserted)
    await holdCustomer(
      rt,
      tenant,
      link.customerId,
      "Harnessに新しい会話があります。",
    );
  await rt.db.query("UPDATE accounts SET sync_at=? WHERE id=?", [now(), oa.id]);
  return { inserted, ...link };
}
export function registerHarness(app: Hono<AppEnv>) {
  registerHarnessConversations(app);
  app.get("/api/tenants/:tenantId/accounts/:oaId/harness", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const tenant = c.req.param("tenantId"),
      oa = await accountFor(c.env.runtime, tenant, c.req.param("oaId"));
    const connection = await one(
      c.env.runtime.db,
      "SELECT state,last_sync_at FROM connections WHERE tenant_id=? AND oa_id=? AND service='harness'",
      [tenant, oa.id],
    );
    return c.json({
      connected: connection?.state === "connected",
      lastSync: connection?.last_sync_at || null,
      channelId: oa.channel_id || null,
      readOnly: !!c.env.runtime.harnessReadOnly,
    });
  });
  app.post("/api/tenants/:tenantId/accounts/:oaId/harness", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      oa = await accountFor(rt, tenant, c.req.param("oaId"));
    const b = z
      .object({
        origin: z.string().url(),
        apiKey: z.string().min(16).max(4096),
        accountId: z.string().min(1).max(128),
        channelId: z
          .string()
          .regex(/^\d{5,20}$/)
          .optional(),
        webhookSecret: z.string().min(32).max(256).optional(),
      })
      .strict()
      .refine((b) => rt.harnessReadOnly === true || b.channelId === undefined, {
        message: "通常の接続ではLINE資格情報画面でチャネルを登録してください。",
      })
      .refine((b) => rt.harnessReadOnly === true || !!b.webhookSecret, {
        message: "送信Webhookの署名シークレットが必要です。",
      })
      .parse(await c.req.json());
    requireThat(
      !rt.harnessReadOnly ||
        rt.deliveryEnabled === false ||
        !!rt.customerTestDelivery,
      409,
      "READ_ONLY_DELIVERY_REQUIRED",
      "読取専用の接続では配送を停止してください。",
    );
    const credential = {
      origin: harnessOrigin(b.origin),
      apiKey: b.apiKey,
      accountId: b.accountId,
    };
    const channelId = b.channelId || oa.channel_id;
    requireThat(
      channelId,
      409,
      "CHANNEL_REQUIRED",
      "先にLINEのチャネルIDを登録してください。",
    );
    requireThat(
      !oa.channel_id || oa.channel_id === channelId,
      409,
      "HARNESS_CHANNEL_PINNED",
      "登録済みのチャネルは変更できません。別のLINEを紐付けないでください。",
    );
    const accounts = z
      .array(
        z.object({
          id: z.string(),
          channelId: z.string(),
          isActive: z.boolean(),
        }),
      )
      .parse(await harnessRequest(rt, credential, "/api/line-accounts"));
    requireThat(
      accounts.some(
        (a) => a.id === b.accountId && a.channelId === channelId && a.isActive,
      ),
      409,
      "HARNESS_ACCOUNT_MISMATCH",
      "登録したLINEのチャネルとHarnessのアカウントが一致しません。",
    );
    if (rt.harnessReadOnly) {
      const pinned = await rt.db.query(
        "UPDATE accounts SET channel_id=?,version=version+1 WHERE id=? AND tenant_id=? AND (channel_id IS NULL OR channel_id=?) AND NOT EXISTS(SELECT 1 FROM accounts WHERE channel_id=? AND id<>?)",
        [channelId, oa.id, tenant, channelId, channelId, oa.id],
      );
      requireThat(
        pinned.changes === 1,
        409,
        "HARNESS_CHANNEL_CONFLICT",
        "チャネルが他のアカウントに登録されたか、設定が変更されました。",
      );
    }
    await putCredential(
      rt,
      tenant,
      oa.id,
      "harness",
      credential,
      c.get("principal").user.id,
    );
    if (!rt.harnessReadOnly)
      await putCredential(
        rt,
        tenant,
        oa.id,
        "harness_events",
        { secret: b.webhookSecret! },
        c.get("principal").user.id,
      );
    await rt.db.query(
      "INSERT INTO connections(id,tenant_id,oa_id,service,state,config,last_sync_at) VALUES (?,?,?,'harness','connected',?,?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET state='connected',config=excluded.config,last_sync_at=excluded.last_sync_at",
      [
        id(),
        tenant,
        oa.id,
        json({
          origin: credential.origin,
          accountId: b.accountId,
          ...(rt.harnessReadOnly ? { readOnly: true } : {}),
        }),
        now(),
      ],
    );
    await rt.db.query(
      "UPDATE accounts SET webhook_mode='harness',preview_ready=0 WHERE id=?",
      [oa.id],
    );
    return c.json({
      ok: true,
      readOnly: !!rt.harnessReadOnly,
      webhookURL: rt.harnessReadOnly
        ? null
        : `${rt.origin}/webhooks/harness-native/${oa.id}`,
    });
  });
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/harness/import",
    async (c) => {
      requireRoles(c, "sys_admin", "org_owner");
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oa = await accountFor(rt, tenant, c.req.param("oaId"));
      const b = z
        .object({ offset: z.number().int().min(0).default(0) })
        .strict()
        .parse(await c.req.json());
      const cred = await getCredential(rt, tenant, oa.id, "harness");
      const page = z
        .object({ items: z.array(friendSchema), total: z.number() })
        .passthrough()
        .parse(
          await harnessRequest(
            rt,
            cred,
            `/api/friends?lineAccountId=${encodeURIComponent(cred.accountId)}&includeTags=false&limit=50&offset=${b.offset}`,
          ),
        );
      for (const f of page.items) {
        requireThat(
          f.lineAccountId === cred.accountId,
          409,
          "HARNESS_ACCOUNT_MISMATCH",
          "異なる公式LINEのデータが含まれています。",
        );
        await importFriend(rt, tenant, oa, cred, f.id);
      }
      await audit(
        rt.db,
        c.get("principal").user.id,
        "harness.friends_imported",
        oa.id,
        tenant,
        { count: page.items.length, offset: b.offset },
      );
      return c.json({
        count: page.items.length,
        total: page.total,
        nextOffset:
          b.offset + page.items.length < page.total
            ? b.offset + page.items.length
            : null,
      });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/harness/assets/sync",
    async (c) => {
      requireRoles(c, "sys_admin", "org_owner", "sales", "team_admin");
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oa = await accountFor(rt, tenant, c.req.param("oaId"));
      const cred = await getCredential(rt, tenant, oa.id, "harness");
      const result = await importHarnessAssets(rt, tenant, oa, cred);
      await audit(
        rt.db,
        c.get("principal").user.id,
        "harness.assets_synced",
        oa.id,
        tenant,
        result,
      );
      return c.json({ ok: true, ...result });
    },
  );
  app.get("/api/tenants/:tenantId/accounts/:oaId/assets", async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      oaId = c.req.param("oaId");
    await accountFor(rt, tenant, oaId);
    const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
    const rows = await all(ts, "SELECT * FROM assets ORDER BY updated_at DESC");
    return c.json({
      assets: rows.map((r) => ({
        ...r,
        body: parse(r.body, {}),
      })),
    });
  });
  app.patch("/api/tenants/:tenantId/accounts/:oaId/assets/:id", async (c) => {
    requireRoles(c, "sys_admin", "org_owner", "team_admin");
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      oaId = c.req.param("oaId");
    await accountFor(rt, tenant, oaId);
    const b = z
      .object({
        state: z
          .enum(["published", "review", "expired", "internal_only"])
          .optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        title: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
    const current = await one(ts, "SELECT * FROM assets WHERE id=?", [
      c.req.param("id"),
    ]);
    requireThat(current, 404, "NOT_FOUND", "素材が見つかりません。");
    await ts.query(
      "UPDATE assets SET state=COALESCE(?,state),expires_at=COALESCE(?,expires_at),title=COALESCE(?,title),updated_at=? WHERE id=?",
      [
        b.state ?? null,
        b.expiresAt ?? null,
        b.title ?? null,
        now(),
        current.id,
      ],
    );
    return c.json({ ok: true });
  });
}

export async function importHarnessAssets(
  rt: Runtime,
  tenant: string,
  oa: Row,
  credential: Row,
) {
  const ts = await rt.openDatabase(tenant, oa.id, "tsunagu");
  let importedTemplates = 0;
  let importedLinks = 0;
  let importedScenarios = 0;

  // 1. Templates
  try {
    const templates = z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            category: z.string().nullable().optional(),
            messageType: z.string().optional(),
            messageContent: z.string().optional(),
          })
          .passthrough(),
      )
      .parse(await harnessRequest(rt, credential, "/api/templates"));

    for (const tpl of templates) {
      const msgType = (tpl as any).type || tpl.messageType || "text";
      const rawContent = (tpl as any).content || tpl.messageContent || "";
      const isPublished =
        ["webinar", "case_study", "active"].includes(tpl.category || "") ||
        msgType === "flex";
      const state = isPublished ? "published" : "review";
      const kind = msgType === "flex" ? "flex" : "card";
      let flexContents: any = null;
      if (kind === "flex" && rawContent) {
        try {
          flexContents =
            typeof rawContent === "string"
              ? JSON.parse(rawContent)
              : rawContent;
        } catch {
          flexContents = null;
        }
      }
      const body = {
        category: tpl.category,
        messageType: msgType,
        messageContent: rawContent,
        contents: flexContents,
      };
      await ts.query(
        "INSERT INTO assets(id,title,kind,harness_id,state,body,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,state=excluded.state,body=excluded.body,updated_at=excluded.updated_at",
        [`tpl:${tpl.id}`, tpl.name, kind, tpl.id, state, json(body), now()],
      );
      importedTemplates++;
    }
  } catch {
    // templates unavailable
  }

  // 2. Tracked links (LPs / Web content)
  try {
    const links = z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            originalUrl: z.string(),
            lineAccountId: z.string().nullable().optional(),
            isActive: z.boolean().optional(),
            ogTitle: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .parse(
        await harnessRequest(
          rt,
          credential,
          `/api/tracked-links?lineAccountId=${encodeURIComponent(credential.accountId)}`,
        ),
      );

    for (const link of links) {
      if (link.lineAccountId && link.lineAccountId !== credential.accountId)
        continue;
      const state = link.isActive !== false ? "published" : "review";
      const body = {
        originalUrl: link.originalUrl,
        ogTitle: link.ogTitle,
      };
      await ts.query(
        "INSERT INTO assets(id,title,kind,url,harness_id,state,body,updated_at) VALUES (?,?,'lp',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,state=excluded.state,body=excluded.body,updated_at=excluded.updated_at",
        [
          `link:${link.id}`,
          link.name,
          link.originalUrl,
          link.id,
          state,
          json(body),
          now(),
        ],
      );
      importedLinks++;
    }
  } catch {
    // links unavailable
  }

  // 3. Scenarios
  try {
    const scenarios = z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullable().optional(),
            lineAccountId: z.string().nullable().optional(),
            isActive: z.boolean().optional(),
          })
          .passthrough(),
      )
      .parse(
        await harnessRequest(
          rt,
          credential,
          `/api/scenarios?lineAccountId=${encodeURIComponent(credential.accountId)}`,
        ),
      );

    for (const scn of scenarios) {
      if (scn.lineAccountId && scn.lineAccountId !== credential.accountId)
        continue;
      const state = scn.isActive ? "published" : "review";
      await ts.query(
        "INSERT INTO assets(id,title,kind,harness_id,state,body,updated_at) VALUES (?,?,'scenario',?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,body=excluded.body,updated_at=excluded.updated_at",
        [
          `scn:${scn.id}`,
          scn.name,
          scn.id,
          state,
          json({ description: scn.description }),
          now(),
        ],
      );
      importedScenarios++;
    }
  } catch {
    // scenarios unavailable
  }

  return {
    imported: importedTemplates + importedLinks + importedScenarios,
    synced: {
      templates: importedTemplates,
      links: importedLinks,
      scenarios: importedScenarios,
    },
  };
}
