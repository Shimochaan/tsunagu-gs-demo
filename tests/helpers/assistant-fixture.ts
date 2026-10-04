import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeLocal } from "../../backend/local.ts";
import { registerDatabases } from "../../backend/jobs.ts";
import { all, one, now, json } from "../../backend/db.ts";
import { member } from "../../backend/access.ts";
import { registerAssistant } from "../../backend/assistant.ts";
import {
  registerAssistantLine,
  registerAssistantLineWebhook,
} from "../../backend/assistant-line.ts";
import { registerSales } from "../../backend/sales.ts";
import { putCredential } from "../../backend/credentials.ts";
import { sign } from "../../backend/security.ts";
import type { AppEnv } from "../../backend/runtime.ts";
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
export async function assistantFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "assistant-test-")),
    local = await makeLocal({
      directory: dir,
      origin: "http://127.0.0.1:4199",
    }),
    rt = local.runtime;
  for (const tenant of ["t", "other"]) {
    await rt.db.query(
      "INSERT INTO tenants(id,name,state,created_at) VALUES (?,?,'active',?)",
      [tenant, tenant, now()],
    );
    await rt.db.query(
      'INSERT INTO memberships(tenant_id,user_id,roles) VALUES (?,?,\'["org_owner","sales"]\')',
      [tenant, tenant === "t" ? "owner" : "other-owner"],
    );
    await rt.db.query(
      "INSERT INTO accounts(id,tenant_id,name,kind,origin,owner_user_id,state,created_at) VALUES (?,?,'住まい相談','sales','existing',?,'ready',?)",
      [
        tenant === "t" ? "oa" : "other-oa",
        tenant,
        tenant === "t" ? "owner" : "other-owner",
        now(),
      ],
    );
    await registerDatabases(rt, tenant);
    await registerDatabases(rt, tenant, tenant === "t" ? "oa" : "other-oa");
  }
  await rt.db.query(
    "INSERT INTO memberships(tenant_id,user_id,roles) VALUES ('t','stranger','[\"sales\"]')",
  );
  for (const r of await all(rt.db, "SELECT * FROM databases"))
    await rt.db.query(
      "UPDATE databases SET physical_id=?,state='ready' WHERE id=?",
      [await rt.provisionDatabase(r), r.id],
    );
  const common = await rt.openDatabase("t", "", "common"),
    ts = await rt.openDatabase("t", "oa", "tsunagu"),
    h = await rt.openDatabase("t", "oa", "harness");
  for (const cid of ["c", "c2", "c3", "c4"]) {
    await common.query(
      "INSERT INTO customers(id,name,owner_user_id,created_at) VALUES (?,?,'owner',?)",
      [cid, cid === "c" ? "山田 花子" : `試験 ${cid}`, now()],
    );
    await common.query(
      "INSERT INTO customer_links(oa_id,line_user_id,customer_id) VALUES ('oa',?,?)",
      [`line-${cid}`, cid],
    );
    await common.query(
      "INSERT INTO external_links(oa_id,service,external_id,customer_id,line_user_id) VALUES ('oa','harness',?,?,?)",
      [`friend-${cid}`, cid, `line-${cid}`],
    );
  }
  await putCredential(
    rt,
    "t",
    "oa",
    "harness",
    {
      origin: "https://harness.test.workers.dev",
      apiKey: "fixture-only",
      accountId: "account",
    },
    "owner",
  );
  await rt.db.query(
    "INSERT INTO connections(id,tenant_id,oa_id,service,state) VALUES ('h','t','oa','harness','connected')",
  );
  await ts.query(
    "INSERT INTO assistant_settings(id,enabled) VALUES ('default',1)",
  );
  const calls: { url: string; body: any }[] = [];
  let failDelivery = false,
    wrongFriend = false;
  rt.externalFetch = async (input, init) => {
    const url = String(input),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.startsWith("https://api.line.me/")) return Response.json({});
    if (url === "https://api.openai.com/v1/responses") {
      const input =
        body?.text?.format?.name === "assistant_grounded_draft"
          ? JSON.parse(body.input)
          : null;
      const source = input?.refs.find((r: any) => r.id.startsWith("source:"));
      const s = source ? JSON.parse(source.text) : null;
      const draft =
        input?.kind === "news"
          ? `前回の金利のお話に関連する記事です。個別条件への適用は未確認です。\n${s.url}\nご希望でしたら一緒に確認しませんか。`
          : input?.kind === "product"
            ? `ご希望に合う${s.title}をご紹介します。在庫は確認時点の情報です。\n${s.url}\n詳しくお話ししませんか。`
            : "金利と借り換えのご相談ですね。適用条件を確認してご案内します。";
      return Response.json({
        status: "completed",
        usage: { input_tokens: 30, output_tokens: 20 },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: input
                  ? JSON.stringify({
                      safeToSend: true,
                      draft,
                      contextRefs: input.requiredRefs,
                      facts: input.requiredRefs.map((ref: string) => ({
                        ref,
                        quote: input.refs
                          .find((r: any) => r.id === ref)
                          .text.slice(0, 80),
                      })),
                    })
                  : "ご連絡ありがとうございます。確認してお返事しますね。",
              },
            ],
          },
        ],
      });
    }
    if (url.startsWith("https://harness.test.workers.dev/api/friends/")) {
      if (init?.method === "POST") {
        if (failDelivery) throw new Error("fixture lost response");
        return Response.json({
          success: true,
          data: { messageId: `sent-${calls.length}` },
        });
      }
      const cid = new URL(url).pathname.split("/")[3].replace("friend-", "");
      if (url.endsWith("/messages"))
        return Response.json({ success: true, data: [] });
      return Response.json({
        success: true,
        data: {
          id: `friend-${cid}`,
          lineUserId: wrongFriend ? "line-wrong" : `line-${cid}`,
          displayName: cid,
          lineAccountId: "account",
          isFollowing: true,
        },
      });
    }
    throw new Error("Unexpected fixture network request");
  };
  const app = new Hono<AppEnv>();
  app.onError((e: any, c) =>
    c.json({ error: e.code, message: e.message }, e.status || 400),
  );
  registerAssistantLineWebhook(app);
  app.use("/api/*", async (c, next) => {
    const actor = c.req.header("x-actor") || "owner",
      tenant = c.req.path.split("/")[3];
    c.set("principal", {
      user: { id: actor, email: `${actor}@example.test`, name: actor },
      sessionId: "test",
      tenantId: tenant,
      opsRole: null,
      mfa: false,
    });
    c.set("membership", await member(rt, actor, tenant));
    c.set(
      "tenant",
      (await one(rt.db, "SELECT * FROM tenants WHERE id=?", [tenant]))!,
    );
    await next();
  });
  registerAssistant(app);
  registerAssistantLine(app);
  registerSales(app);
  const request = async (
    route: string,
    body?: any,
    method = body === undefined ? "GET" : "POST",
    actor = "owner",
  ) => {
    const r = await app.request(
      route,
      {
        method,
        headers: { "Content-Type": "application/json", "x-actor": actor },
        ...(body === undefined ? {} : { body: json(body) }),
      },
      { runtime: rt },
    );
    return { status: r.status, data: (await r.json()) as any };
  };
  const message = async (
    cid = "c",
    text = "金利について教えていただけますか？",
    opts: { id?: string; direction?: string; age?: number } = {},
  ) => {
    const at = ago(opts.age ?? 120000),
      mid = opts.id || `m-${Math.random()}`;
    await h.query(
      "INSERT INTO messages(id,customer_id,line_user_id,direction,source,body,state,occurred_at,recorded_at) VALUES (?,?,?,?,'line',?,'received',?,?)",
      [mid, cid, `line-${cid}`, opts.direction || "inbound", text, at, at],
    );
    return mid;
  };
  const webhook = async (
    event: any,
    destination = rt.assistantLine?.destination || "",
    signature?: string,
  ) => {
    const raw = json({
      destination,
      events: [
        {
          webhookEventId: crypto.randomUUID(),
          timestamp: Date.now(),
          replyToken: "fixture-token",
          source: { type: "user", userId: "staff-line" },
          ...event,
        },
      ],
    });
    const r = await app.request(
      "/webhooks/staff-line",
      {
        method: "POST",
        headers: {
          "x-line-signature":
            signature ?? (await sign(rt.assistantLine!.secret, raw)),
        },
        body: raw,
      },
      { runtime: rt },
    );
    return { status: r.status, data: (await r.json()) as any };
  };
  return {
    dir,
    rt,
    app,
    common,
    ts,
    h,
    calls,
    request,
    message,
    webhook,
    failDelivery: () => {
      failDelivery = true;
    },
    wrongFriend: () => {
      wrongFriend = true;
    },
    dispose: async () => {
      local.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
