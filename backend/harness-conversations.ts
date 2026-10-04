import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, type Row } from "./db.ts";
import { accountFor, member, customerAccess } from "./access.ts";
import { getCredential } from "./credentials.ts";
import { harnessRequest } from "./harness.ts";
import { digest, requireThat, audit, limit } from "./security.ts";
import { holdCustomer } from "./sales.ts";

export const conversationSyncDDL = `CREATE TABLE IF NOT EXISTS conversation_sync_reviews (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, oa_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 customer_id TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready', claim TEXT, received_count INTEGER NOT NULL,
 inserted_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT)`;
const messageSchema = z.object({
  id: z.string().min(1).max(200),
  direction: z.enum(["incoming", "outgoing"]),
  messageType: z.string().max(100),
  content: z.string().max(10000),
  createdAt: z.string().datetime(),
});
const friendSchema = z.object({
  id: z.string(),
  lineUserId: z.string(),
  lineAccountId: z.string(),
  isFollowing: z.boolean(),
});
const stale = () =>
  requireThat(
    false,
    409,
    "CONVERSATION_CHANGED",
    "接続・本人の紐付け・会話が変更されました。プレビューを取り直してください。",
  );

async function scope(
  rt: Runtime,
  tenant: string,
  oaId: string,
  actor: string,
  customerId: string,
) {
  const membership = await member(rt, actor, tenant);
  const company = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [
    tenant,
  ]);
  requireThat(
    company?.state === "active",
    409,
    "TENANT_INACTIVE",
    "企業の利用状態を確認してください。",
  );
  const oa = await accountFor(rt, tenant, oaId);
  const common = await rt.openDatabase(tenant, "", "common");
  const customer = await one(common, "SELECT * FROM customers WHERE id=?", [
    customerId,
  ]);
  requireThat(
    customer && customerAccess(membership, customer, "edit"),
    403,
    "CUSTOMER_FORBIDDEN",
    "この顧客の会話を取り込む権限がありません。",
  );
  const links = await all(
    common,
    "SELECT e.* FROM external_links e JOIN customer_links c ON c.oa_id=e.oa_id AND c.line_user_id=e.line_user_id AND c.customer_id=e.customer_id AND c.state='confirmed' WHERE e.oa_id=? AND e.service='harness' AND e.customer_id=?",
    [oaId, customerId],
  );
  requireThat(
    links.length === 1,
    409,
    "FRIEND_LINK_REQUIRED",
    "導入・企業設定で友だちを取り込み、顧客とLINEの一意な紐付けを確認してください。",
  );
  const connection = await one(
    rt.db,
    "SELECT state FROM connections WHERE tenant_id=? AND oa_id=? AND service='harness'",
    [tenant, oaId],
  );
  const registered = await one(
    rt.db,
    "SELECT ciphertext FROM credentials WHERE tenant_id=? AND oa_id=? AND service='harness'",
    [tenant, oaId],
  );
  return {
    oa,
    common,
    customer,
    link: links[0],
    configured: connection?.state === "connected" && !!registered,
    stamp: await digest(
      json([
        oa.channel_id,
        links[0],
        customer.owner_user_id,
        customer.team_id,
        customer.opt_out,
        registered?.ciphertext,
        connection?.state,
      ]),
    ),
  };
}
async function readSnapshot(
  rt: Runtime,
  tenant: string,
  oaId: string,
  actor: string,
  customerId: string,
) {
  const before = await scope(rt, tenant, oaId, actor, customerId);
  requireThat(
    before.configured,
    409,
    "HARNESS_NOT_CONNECTED",
    "導入・企業設定でHarnessへの接続を確認して保存してください。",
  );
  const cred = await getCredential(rt, tenant, oaId, "harness");
  const accounts = z
    .array(
      z.object({
        id: z.string(),
        channelId: z.string(),
        isActive: z.boolean(),
      }),
    )
    .parse(await harnessRequest(rt, cred, "/api/line-accounts"));
  requireThat(
    accounts.some(
      (a) =>
        a.id === cred.accountId &&
        a.channelId === before.oa.channel_id &&
        a.isActive,
    ),
    409,
    "HARNESS_ACCOUNT_MISMATCH",
    "顧客用LINEと受信アカウントが一致しません。",
  );
  const readFriend = async () =>
    friendSchema.parse(
      await harnessRequest(
        rt,
        cred,
        `/api/friends/${encodeURIComponent(before.link.external_id)}`,
      ),
    );
  const checkFriend = (f: z.infer<typeof friendSchema>) =>
    requireThat(
      f.id === before.link.external_id &&
        f.lineAccountId === cred.accountId &&
        f.lineUserId === before.link.line_user_id,
      409,
      "FRIEND_LINK_CHANGED",
      "LINE本人の紐付けが一致しません。取込を停止しました。",
    );
  const friend = await readFriend();
  checkFriend(friend);
  const raw = z
    .array(messageSchema)
    .max(500)
    .parse(
      await harnessRequest(
        rt,
        cred,
        `/api/friends/${encodeURIComponent(friend.id)}/messages`,
      ),
    );
  const finalFriend = await readFriend();
  checkFriend(finalFriend);
  if (finalFriend.isFollowing !== friend.isFollowing) stale();
  const after = await scope(rt, tenant, oaId, actor, customerId);
  if (before.stamp !== after.stamp) stale();
  const messages = raw
    .filter((m) => m.messageType === "text")
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  requireThat(
    new Set(messages.map((m) => m.id)).size === messages.length,
    409,
    "DUPLICATE_REMOTE_MESSAGE",
    "受信元でメッセージIDが重複しています。取込を停止しました。",
  );
  requireThat(
    messages.every((m) => Date.parse(m.createdAt) <= Date.now() + 60000),
    409,
    "INVALID_MESSAGE_TIME",
    "受信時刻を確認できません。",
  );
  const h = await rt.openDatabase(tenant, oaId, "harness");
  const existing = messages.length
    ? await all(
        h,
        "SELECT * FROM messages WHERE id IN (SELECT 'harness:' || json_extract(value,'$.id') FROM json_each(?))",
        [json(messages)],
      )
    : [];
  for (const m of messages) {
    const old = existing.find((e) => e.id === `harness:${m.id}`);
    requireThat(
      !old ||
        (old.customer_id === customerId &&
          old.line_user_id === friend.lineUserId &&
          old.body === m.content &&
          old.direction ===
            (m.direction === "incoming" ? "inbound" : "outbound") &&
          old.occurred_at === m.createdAt),
      409,
      "MESSAGE_CONFLICT",
      "取込済みメッセージとの不一致があります。上書きせず停止しました。",
    );
  }
  return {
    ...after,
    h,
    messages,
    following: friend.isFollowing,
    skipped: raw.length - messages.length,
    newCount: messages.length - existing.length,
    fingerprint: await digest(json([before.stamp, friend, messages])),
  };
}

export function registerHarnessConversations(app: Hono<AppEnv>) {
  const base =
    "/api/tenants/:tenantId/accounts/:oaId/customers/:customerId/harness-conversation";
  app.get(base, async (c) => {
    const s = await scope(
      c.env.runtime,
      c.req.param("tenantId"),
      c.req.param("oaId"),
      c.get("principal").user.id,
      c.req.param("customerId"),
    );
    return c.json({
      configured: s.configured,
      customer: s.customer.name,
      lineUserId: s.link.line_user_id,
      lastSync: s.oa.sync_at,
      readLimit: c.env.runtime.harnessReadOnly ? 200 : 500,
    });
  });
  app.post(`${base}/preview`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      oa = c.req.param("oaId"),
      customer = c.req.param("customerId"),
      actor = c.get("principal").user.id;
    await scope(rt, tenant, oa, actor, customer);
    await limit(rt.db, `conversation-preview:${tenant}:${oa}:${actor}`, 20, 60);
    const s = await readSnapshot(rt, tenant, oa, actor, customer),
      review = id(),
      expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    await s.h.query(
      "INSERT INTO conversation_sync_reviews(id,tenant_id,oa_id,actor_id,customer_id,fingerprint,expires_at,received_count,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        review,
        tenant,
        oa,
        actor,
        customer,
        s.fingerprint,
        expiresAt,
        s.messages.length,
        now(),
      ],
    );
    // Store no message bodies in review metadata; a cancelled preview never imports conversations.
    return c.json({
      id: review,
      expiresAt,
      customer: s.customer.name,
      lineUserId: s.link.line_user_id,
      messages: s.messages,
      received: s.messages.length,
      newCount: s.newCount,
      skipped: s.skipped,
      following: s.following,
    });
  });
  for (const action of ["commit", "cancel"] as const)
    app.post(`${base}/${action}`, async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oa = c.req.param("oaId"),
        customer = c.req.param("customerId"),
        actor = c.get("principal").user.id;
      const { reviewId } = z
        .object({ reviewId: z.string().uuid() })
        .strict()
        .parse(await c.req.json());
      const initial = await scope(rt, tenant, oa, actor, customer),
        h = await rt.openDatabase(tenant, oa, "harness");
      const review = await one(
        h,
        "SELECT * FROM conversation_sync_reviews WHERE id=? AND tenant_id=? AND oa_id=? AND actor_id=? AND customer_id=?",
        [reviewId, tenant, oa, actor, customer],
      );
      requireThat(
        review,
        404,
        "REVIEW_NOT_FOUND",
        "この確認内容は利用できません。プレビューからやり直してください。",
      );
      if (action === "cancel") {
        await h.query(
          "UPDATE conversation_sync_reviews SET state='cancelled' WHERE id=? AND state='ready'",
          [reviewId],
        );
        const current = await one(
          h,
          "SELECT state FROM conversation_sync_reviews WHERE id=?",
          [reviewId],
        );
        requireThat(
          current.state === "cancelled",
          409,
          "SYNC_ALREADY_COMPLETED",
          "取込は完了しています。取消で取り込んだ会話は削除されません。",
        );
        return c.json({ cancelled: true });
      }
      if (review.state === "completed")
        return c.json({
          completed: true,
          replay: true,
          inserted: review.inserted_count,
          received: review.received_count,
        });
      requireThat(
        review.state === "ready" && review.expires_at > now(),
        409,
        "REVIEW_EXPIRED",
        "取消済み、または確認から5分が経過しました。プレビューを取り直してください。",
      );
      requireThat(
        initial.configured,
        409,
        "HARNESS_NOT_CONNECTED",
        "Harness接続を確認してください。",
      );
      const s = await readSnapshot(rt, tenant, oa, actor, customer);
      if (s.fingerprint !== review.fingerprint) stale();
      // Invalidate queued sends BEFORE adding new context; no AI, notifications or delivery here.
      if (s.newCount || !s.following)
        await holdCustomer(
          rt,
          tenant,
          customer,
          "LINE会話の取込で状況を再確認してください。",
        );
      const final = await scope(rt, tenant, oa, actor, customer);
      if (final.stamp !== s.stamp) stale();
      if (!s.following)
        await s.common.query("UPDATE customers SET opt_out=1 WHERE id=?", [
          customer,
        ]);
      const claim = id(),
        at = now();
      await h.batch([
        {
          sql: "UPDATE conversation_sync_reviews SET state='applying',claim=? WHERE id=? AND state='ready' AND expires_at>?",
          params: [claim, reviewId, at],
        },
        {
          sql: `INSERT OR IGNORE INTO messages(id,customer_id,line_user_id,direction,source,body,kind,external_id,state,occurred_at,recorded_at)
        SELECT 'harness:'||json_extract(value,'$.id'),?,?,CASE json_extract(value,'$.direction') WHEN 'incoming' THEN 'inbound' ELSE 'outbound' END,'harness',json_extract(value,'$.content'),'text','harness:'||json_extract(value,'$.id'),'received',json_extract(value,'$.createdAt'),?
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM conversation_sync_reviews WHERE id=? AND state='applying' AND claim=?)`,
          params: [
            customer,
            s.link.line_user_id,
            at,
            json(s.messages),
            reviewId,
            claim,
          ],
        },
        {
          sql: "UPDATE conversation_sync_reviews SET inserted_count=changes(),state='completed',completed_at=? WHERE id=? AND state='applying' AND claim=?",
          params: [at, reviewId, claim],
        },
      ]);
      const result = await one(
        h,
        "SELECT * FROM conversation_sync_reviews WHERE id=?",
        [reviewId],
      );
      requireThat(
        result.state === "completed",
        409,
        "REVIEW_CANCELLED",
        "取込は取り消されました。必要ならプレビューからやり直してください。",
      );
      if (result.claim === claim) {
        await rt.db.query(
          "UPDATE accounts SET sync_at=? WHERE id=? AND tenant_id=?",
          [at, oa, tenant],
        );
        await audit(
          rt.db,
          actor,
          "harness.conversation_imported",
          customer,
          tenant,
          {
            reviewId,
            received: result.received_count,
            inserted: result.inserted_count,
          },
        );
      }
      return c.json({
        completed: true,
        replay: result.claim !== claim,
        received: result.received_count,
        inserted: result.inserted_count,
      });
    });
}
