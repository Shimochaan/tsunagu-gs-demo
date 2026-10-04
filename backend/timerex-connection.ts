import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { one, id, now, json, parse } from "./db.ts";
import { recordingAccess } from "./recording-sources.ts";
import { getCredential, putCredential } from "./credentials.ts";
import { requireThat, AppError } from "./security.ts";
export async function timerexSecret(rt: Runtime, tenant: string, oa: string) {
  if (rt.timerexSecrets?.[oa]) return rt.timerexSecrets[oa];
  try {
    return (await getCredential(rt, tenant, oa, "timerex")).secret as string;
  } catch (e) {
    if (e instanceof AppError && e.code === "CREDENTIAL_REQUIRED") return null;
    throw e;
  }
}
export async function recordTimeRexReceipt(
  rt: Runtime,
  tenant: string,
  oa: string,
  result: unknown,
  test = false,
) {
  const key = test ? "selfTest" : "lastWebhook";
  await rt.db.query(
    "INSERT INTO connections(id,tenant_id,oa_id,service,state,config,last_sync_at) VALUES (?,?,?,'timerex','connected',?,?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET state='connected',config=json_set(connections.config,?,json(?)),last_sync_at=excluded.last_sync_at,last_error=NULL",
    [
      id(),
      tenant,
      oa,
      json({ [key]: { at: now(), result } }),
      now(),
      `$.${key}`,
      json({ at: now(), result }),
    ],
  );
}
export function registerTimeRexConnection(app: Hono<AppEnv>) {
  const base = "/api/tenants/:tenantId/accounts/:oaId/connectors/timerex-setup";
  app.get(base, async (c) => {
    const a = await recordingAccess(c),
      r = await one(
        a.rt.db,
        "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service='timerex'",
        [a.tenant, a.oa],
      ),
      cfg = parse(r?.config);
    return c.json({
      webhookUrl: `${a.rt.origin}/webhooks/timerex/${a.oa}`,
      settingsUrl: cfg.settingsUrl || "https://timerex.net/user",
      configured: !!(await timerexSecret(a.rt, a.tenant, a.oa)),
      lastWebhook: cfg.lastWebhook || null,
      selfTest: cfg.selfTest || null,
      environmentManaged: !!a.rt.timerexSecrets?.[a.oa],
    });
  });
  app.put(base, async (c) => {
    const a = await recordingAccess(c),
      v = z
        .object({
          secret: z.string().min(8).max(1000).optional(),
          settingsUrl: z
            .url()
            .refine((v) => {
              const u = new URL(v);
              return (
                u.protocol === "https:" &&
                u.hostname === "timerex.net" &&
                !u.username &&
                !u.password &&
                !u.port
              );
            })
            .optional(),
        })
        .parse(await c.req.json());
    if (v.secret) {
      requireThat(
        !a.rt.timerexSecrets?.[a.oa],
        409,
        "ENV_MANAGED",
        "運営設定のトークンを使用中です。変更は運営設定から行ってください。",
      );
      await putCredential(
        a.rt,
        a.tenant,
        a.oa,
        "timerex",
        { secret: v.secret },
        c.get("principal").user.id,
      );
    }
    if (v.settingsUrl)
      await a.rt.db.query(
        "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES (?,?,?,'timerex','configured',?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET config=json_set(connections.config,'$.settingsUrl',?)",
        [
          id(),
          a.tenant,
          a.oa,
          json({ settingsUrl: v.settingsUrl }),
          v.settingsUrl,
        ],
      );
    return c.json({ ok: true });
  });
  app.post(base + "/test", async (c) => {
    const a = await recordingAccess(c),
      secret = await timerexSecret(a.rt, a.tenant, a.oa);
    requireThat(
      secret,
      409,
      "TIMEREX_NOT_CONFIGURED",
      "TimeRexのSecurity Tokenを登録してください。",
    );
    const r = await app.fetch(
      new Request(`${a.rt.origin}/webhooks/timerex/${a.oa}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-timerex-authorization": secret!,
        },
        body: json({ webhook_type: "tsunagu.connection_test" }),
        signal: AbortSignal.timeout(15000),
      }),
      { runtime: a.rt },
    );
    requireThat(
      r.ok,
      502,
      "TIMEREX_TEST_FAILED",
      "Webhook受信処理の認証テストに失敗しました。認証設定を確認してください。",
    );
    return c.json({
      ok: true,
      kind: "self_test",
      message:
        "Webhook受信処理と認証設定を確認しました（内部テスト）。TimeRexからの実予約受信は別途確認してください。",
    });
  });
}
