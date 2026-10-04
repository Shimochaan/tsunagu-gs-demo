import type { Hono } from "hono";
import { z } from "zod";
import { one, all, id, now, json } from "./db.ts";
import type { AppEnv, Runtime } from "./runtime.ts";
import { requireThat, verify, digest, b64 } from "./security.ts";
import { getCredential } from "./credentials.ts";
import { holdCustomer } from "./sales.ts";
import { syncConversation } from "./harness.ts";
import { applyMeetingResult } from "./meeting-events.ts";
const lineSchema = z.object({
  destination: z.string(),
  events: z
    .array(
      z
        .object({
          webhookEventId: z.string(),
          type: z.string(),
          timestamp: z.number(),
          source: z
            .object({ type: z.string(), userId: z.string().optional() })
            .optional(),
          message: z
            .object({
              id: z.string(),
              type: z.string(),
              text: z.string().optional(),
            })
            .optional(),
          postback: z.object({ data: z.string() }).optional(),
        })
        .passthrough(),
    )
    .max(100),
});
export function registerWebhooks(app: Hono<AppEnv>) {
  app.post("/webhooks/harness-native/:oaId", async (c) => {
    const rt = c.env.runtime,
      oa = await one(rt.db, "SELECT * FROM accounts WHERE id=?", [
        c.req.param("oaId"),
      ]);
    requireThat(oa, 404, "NOT_FOUND", "Not found");
    const raw = await c.req.text();
    requireThat(raw.length <= 1_000_000, 413, "TOO_LARGE", "Too large");
    const cred = await getCredential(rt, oa.tenant_id, oa.id, "harness_events");
    const hex = c.req.header("x-webhook-signature") ?? "";
    requireThat(
      /^[a-f0-9]{64}$/i.test(hex),
      401,
      "INVALID_SIGNATURE",
      "Invalid signature",
    );
    const signature = b64(
      Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16)),
    );
    requireThat(
      await verify(cred.secret, raw, signature),
      401,
      "INVALID_SIGNATURE",
      "Invalid signature",
    );
    const payload = z
      .object({
        event: z.string(),
        timestamp: z.string(),
        data: z.object({
          friendId: z.string().optional(),
          eventData: z.record(z.string(), z.unknown()).optional(),
        }),
      })
      .parse(JSON.parse(raw));
    const parsed = Date.parse(payload.timestamp);
    requireThat(
      Number.isFinite(parsed) && Math.abs(Date.now() - parsed) < 300000,
      401,
      "EVENT_EXPIRED",
      "Event expired",
    );
    const h = await rt.openDatabase(oa.tenant_id, oa.id, "harness");
    const eventId = `native:${await digest(raw)}`;
    const previous = await one(h, "SELECT state FROM events WHERE id=?", [
      eventId,
    ]);
    if (previous?.state === "processed") return c.json({ ok: true });
    // replyToken等の認証情報を保持しない。友だちはAPIでOA所属を照合してから取り込む。
    if (payload.data.friendId) {
      const connector = await getCredential(rt, oa.tenant_id, oa.id, "harness");
      const synced = await syncConversation(
        rt,
        oa.tenant_id,
        oa,
        connector,
        payload.data.friendId,
      );
      await h.query(
        "INSERT OR REPLACE INTO events(id,customer_id,type,payload,occurred_at,state) VALUES (?,?,?,?,?,'processed')",
        [
          eventId,
          synced.customerId,
          payload.event,
          json({ event: payload.event, friendId: payload.data.friendId }),
          new Date(parsed).toISOString(),
        ],
      );
    }
    await rt.db.query(
      "UPDATE accounts SET webhook_verified_at=?,sync_at=? WHERE id=?",
      [now(), now(), oa.id],
    );
    return c.json({ ok: true });
  });
  app.post("/webhooks/line/:oaId", async (c) => {
    const rt = c.env.runtime;
    const oa = await one(rt.db, "SELECT * FROM accounts WHERE id=?", [
      c.req.param("oaId"),
    ]);
    requireThat(oa, 404, "NOT_FOUND", "Not found");
    const secret = await getCredential(rt, oa.tenant_id, oa.id, "line");
    const raw = await c.req.text();
    requireThat(raw.length <= 1_000_000, 413, "TOO_LARGE", "Too large");
    requireThat(
      await verify(
        secret.channelSecret,
        raw,
        c.req.header("x-line-signature") ?? "",
      ),
      401,
      "INVALID_SIGNATURE",
      "Invalid signature",
    );
    const payload = lineSchema.parse(JSON.parse(raw));
    requireThat(
      oa.destination && payload.destination === oa.destination,
      409,
      "CHANNEL_MISMATCH",
      "Channel must be verified first",
    );
    requireThat(
      ["gateway", "harness"].includes(oa.webhook_mode),
      409,
      "WEBHOOK_MODE_REQUIRED",
      "Webhook routing has not been confirmed",
    );
    const h = await rt.openDatabase(oa.tenant_id, oa.id, "harness");
    // 署名を検証した後でのみ保存する。重複配送は同じevent IDに集約する。
    for (const e of payload.events)
      await h.query(
        "INSERT OR IGNORE INTO events(id,type,payload,occurred_at) VALUES (?,?,?,?)",
        [
          `line:${e.webhookEventId}`,
          e.type,
          json(e),
          new Date(e.timestamp).toISOString(),
        ],
      );
    await rt.db.query(
      "UPDATE accounts SET webhook_verified_at=?,sync_at=? WHERE id=?",
      [now(), now(), oa.id],
    );
    await processEvents(rt, oa.tenant_id, oa.id);
    return c.json({ ok: true });
  });
  app.post("/webhooks/harness/:oaId", async (c) => {
    const rt = c.env.runtime,
      oa = await one(rt.db, "SELECT * FROM accounts WHERE id=?", [
        c.req.param("oaId"),
      ]);
    requireThat(oa, 404, "NOT_FOUND", "Not found");
    const cred = await getCredential(rt, oa.tenant_id, oa.id, "harness_events");
    const raw = await c.req.text(),
      timestamp = c.req.header("x-tsunagu-timestamp") ?? "";
    requireThat(raw.length <= 1_000_000, 413, "TOO_LARGE", "Too large");
    requireThat(
      Math.abs(Date.now() - Number(timestamp)) < 300000 &&
        (await verify(
          cred.secret,
          `${timestamp}.${raw}`,
          c.req.header("x-tsunagu-signature") ?? "",
        )),
      401,
      "INVALID_SIGNATURE",
      "Invalid signature",
    );
    const event = z
      .object({
        id: z.string().min(1).max(200),
        type: z.enum(["message.sent", "content.clicked"]),
        lineUserId: z.string().min(1).max(128),
        text: z.string().max(20000).optional(),
        occurredAt: z.string().datetime(),
        actorId: z.string().optional(),
      })
      .strict()
      .parse(JSON.parse(raw));
    const h = await rt.openDatabase(oa.tenant_id, oa.id, "harness");
    await h.query(
      "INSERT OR IGNORE INTO events(id,type,payload,occurred_at) VALUES (?,?,?,?)",
      [`harness:${event.id}`, event.type, json(event), event.occurredAt],
    );
    await processEvents(rt, oa.tenant_id, oa.id);
    return c.json({ ok: true });
  });
}
export async function processEvents(rt: Runtime, tenant: string, oaId: string) {
  const oa = await one(
    rt.db,
    "SELECT * FROM accounts WHERE tenant_id=? AND id=?",
    [tenant, oaId],
  );
  const common = await rt.openDatabase(tenant, "", "common"),
    h = await rt.openDatabase(tenant, oaId, "harness");
  const events = await all(
    h,
    "SELECT * FROM events WHERE state='pending' AND type<>'meeting.trigger' ORDER BY occurred_at LIMIT 100",
  );
  for (const event of events) {
    if (event.type === "meeting.trigger") continue;
    if (event.type === "meeting.result") {
      await applyMeetingResult(rt, tenant, oaId, event.id);
      continue;
    }
    const e = JSON.parse(event.payload);
    const lineUserId =
      e.source?.type === "user" ? e.source.userId : e.lineUserId;
    if (!lineUserId) {
      await h.query("UPDATE events SET state='ignored' WHERE id=?", [event.id]);
      continue;
    }
    let link = await one(
      common,
      "SELECT * FROM customer_links WHERE oa_id=? AND line_user_id=?",
      [oaId, lineUserId],
    );
    if (!link) {
      // OA間の同一人物推測はしない。新しい友だちはOA内の安定IDで登録する。
      const cid = (await digest(`${oaId}:${lineUserId}`)).replace(
        /[^a-zA-Z0-9]/g,
        "",
      );
      await common.batch([
        {
          sql: "INSERT OR IGNORE INTO customers(id,name,owner_user_id,team_id,created_at) VALUES (?,?,?,?,?)",
          params: [cid, "LINEの友だち", oa.owner_user_id, oa.team_id, now()],
        },
        {
          sql: "INSERT OR IGNORE INTO customer_links(oa_id,line_user_id,customer_id) VALUES (?,?,?)",
          params: [oaId, lineUserId, cid],
        },
      ]);
      link = await one(
        common,
        "SELECT * FROM customer_links WHERE oa_id=? AND line_user_id=?",
        [oaId, lineUserId],
      );
    }
    const cid = link.customer_id;
    if (e.type === "message" || e.type === "message.sent") {
      const text =
        e.message?.text ?? e.text ?? `[${e.message?.type ?? "message"}]`;
      await h.query(
        "INSERT OR IGNORE INTO messages(id,customer_id,line_user_id,direction,source,actor_id,body,external_id,state,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          event.id,
          cid,
          lineUserId,
          e.type === "message" ? "inbound" : "outbound",
          e.type === "message" ? "line" : "harness",
          e.actorId ?? null,
          text,
          e.message?.id ?? e.id,
          "received",
          event.occurred_at,
          now(),
        ],
      );
      await holdCustomer(
        rt,
        tenant,
        cid,
        "新しい会話があります。最新のやり取りを確認してください。",
      );
    }
    if (e.type === "unfollow") {
      await common.query(
        "UPDATE customers SET opt_out=1,version=version+1 WHERE id=?",
        [cid],
      );
      await holdCustomer(rt, tenant, cid, "配信を停止しています。");
    }
    // followで過去の配信停止を自動解除しない。
    await h.query(
      "UPDATE events SET state='processed',customer_id=? WHERE id=?",
      [cid, event.id],
    );
  }
}
