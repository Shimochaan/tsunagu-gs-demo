import type { Hono, Context } from "hono";
import { z } from "zod";
import type { AppEnv, Runtime } from "./runtime.ts";
import { one, all, now, type Row } from "./db.ts";
import { has } from "./access.ts";
import { assistantAccess } from "./assistant.ts";
import { staffLineReady } from "./assistant-line.ts";
import { requireThat, AppError } from "./security.ts";
import {
  gateway,
  publicUrl,
  searchResultsSchema,
  validateArticle,
  validateCatalog,
} from "./assistant-discovery.ts";
import { automationSettings } from "./assistant-controls.ts";
type CheckResult = {
  ok: boolean;
  kind: string;
  checkedAt: string;
  externalRequests: number;
  writes: number;
  messagesSent: number;
  code?: string;
  message?: string;
  fields?: string[];
  count?: number;
  usable?: number;
  excluded?: number;
  scope?: string;
  token?: string;
  webhook?: string;
  webhookReachability?: string;
  identity?: string;
  delivery?: string;
  transport?: string;
  contract?: string;
  sync?: string;
};
const base = "/api/tenants/:tenantId/accounts/:oaId/assistant/connections";
const configuration = (config: unknown, state?: string) =>
  state === "invalid" ? "invalid" : config ? "configured" : "missing";
function safeFailure(error: unknown) {
  if (error instanceof z.ZodError)
    return {
      code: "CONTRACT_INVALID",
      message: "応答JSONの形式を確認してください。",
      fields: error.issues.map((i) => i.path.join(".")).slice(0, 10),
    };
  if (error instanceof AppError)
    return { code: error.code, message: error.message };
  return {
    code: "PROVIDER_UNAVAILABLE",
    message:
      "応答を確認できませんでした。接続先・認証・応答形式を確認してください。",
  };
}
function eligible(row: Row) {
  const n = Date.now();
  return (
    Date.parse(row.publishedAt) <= n &&
    Date.parse(row.publishedAt) >= n - 7 * 86400000 &&
    Date.parse(row.checkedAt) >= n - 86400000 &&
    Date.parse(row.expiresAt) > n &&
    (row.kind !== "product" ||
      (row.status === "available" &&
        row.stock > 0 &&
        row.price !== null &&
        row.area))
  );
}
export function validateConnectionPayload(input: unknown): CheckResult {
  const b = z
    .object({
      kind: z.enum(["search", "article", "catalog"]),
      payload: z.unknown(),
      url: z.string().url().optional(),
      topic: z.string().trim().min(2).max(40).optional(),
      allowedHosts: z.array(z.string().min(1)).max(30).optional(),
    })
    .strict()
    .parse(input);
  try {
    let count = 0,
      usable = 0;
    if (b.kind === "search") {
      const rows = searchResultsSchema.parse(b.payload).results;
      for (const r of rows) {
        publicUrl(r.url);
        if (b.allowedHosts?.length)
          requireThat(
            b.allowedHosts.includes(new URL(r.url).hostname),
            422,
            "SOURCE_HOST_REJECTED",
            "許可された出典ではありません。",
          );
      }
      count = rows.length;
      usable = count;
    } else if (b.kind === "article") {
      requireThat(
        b.url && b.topic && b.allowedHosts?.length,
        422,
        "ARTICLE_CONTEXT_REQUIRED",
        "照合するURL・話題・出典ホストを指定してください。",
      );
      validateArticle(b.payload, {
        url: b.url!,
        topic: b.topic!,
        allowedHosts: b.allowedHosts!,
      });
      count = usable = 1;
    } else {
      const rows = validateCatalog(b.payload);
      count = rows.length;
      usable = rows.filter(eligible).length;
    }
    return {
      ok: true,
      kind: b.kind,
      count,
      usable,
      excluded: count - usable,
      checkedAt: now(),
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      scope: "contract_only",
    };
  } catch (error) {
    return {
      ok: false,
      kind: b.kind,
      ...safeFailure(error),
      checkedAt: now(),
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      scope: "contract_only",
    };
  }
}
export async function assistantConnections(
  rt: Runtime,
  t: string,
  oa: string,
  actor: string,
) {
  const ts = await rt.openDatabase(t, oa, "tsunagu"),
    key = `${t}:${oa}`,
    line = rt.assistantLine;
  const declared = rt.assistantConfiguration?.line;
  const presence = declared || {
    enabled: !!line?.enabled,
    destinationPresent: !!line?.destination,
    secretPresent: !!line?.secret,
    tokenPresent: !!line?.token,
    valid: /^U[0-9a-f]{32}$/.test(line?.destination || ""),
  };
  const ready = await staffLineReady(rt),
    collision =
      !!line?.destination &&
      !!(await one(rt.db, "SELECT id FROM accounts WHERE destination=?", [
        line.destination,
      ]));
  const staff = await one(
    rt.db,
    "SELECT state,notifications,destination FROM staff_line_links WHERE tenant_id=? AND user_id=?",
    [t, actor],
  );
  const settings = await automationSettings(ts);
  const recent = await all(
    ts,
    "SELECT kind,state,created_at FROM assistant_runs WHERE kind IN ('search','feed') ORDER BY created_at DESC LIMIT 10",
  );
  const provider = (kind: "search" | "feed") => {
    const config =
      kind === "search" ? rt.assistantSearch?.[key] : rt.assistantFeeds?.[key];
    let state = configuration(config, rt.assistantConfiguration?.[kind]);
    if (config)
      try {
        publicUrl(config.url);
      } catch {
        state = "invalid";
      }
    return {
      configuration: state,
      adapter: "generic-json-v1",
      vendorAdapter: config ? "external_gateway" : "not_selected",
      transport: "not_checked",
      contract: "not_checked",
      lastAcquisition: recent.find((r) => r.kind === kind) || null,
      automatic: kind === "search" ? settings.autoSearch : settings.autoFeed,
      topicsConfigured:
        kind === "search" ? settings.topics.length > 0 : undefined,
    };
  };
  let work: Row = { state: "schema_missing" };
  try {
    const queue = await one(
      ts,
      "SELECT count(*) AS queued,sum(CASE WHEN due_at<=? THEN 1 ELSE 0 END) AS due FROM assistant_work_queue",
      [now()],
    );
    const sweep = await one(
      ts,
      "SELECT active_revision,completed_revision,cursor FROM assistant_sweep WHERE id='default'",
    );
    work = {
      state: "schema_present",
      queued: queue?.queued || 0,
      due: queue?.due || 0,
      sweeping: !!sweep && sweep.active_revision !== sweep.completed_revision,
    };
  } catch {}
  return {
    checkedAt: now(),
    scope: "configuration_only",
    runtime: rt.local ? "local" : "deployed_endpoint",
    externalRequests: 0,
    line: {
      configuration: collision
        ? "customer_channel_conflict"
        : !presence.destinationPresent ||
            !presence.secretPresent ||
            !presence.tokenPresent
          ? "missing"
          : !presence.valid
            ? "invalid"
            : !presence.enabled
              ? "disabled"
              : "configured",
      fields: presence,
      readyForReadCheck: ready,
      identity:
        staff?.state === "active" && staff.destination === line?.destination
          ? "linked"
          : "not_linked",
      notifications: !!staff?.notifications,
      token: "not_checked",
      webhook: "not_checked",
      delivery: "not_tested",
    },
    search: provider("search"),
    catalog: provider("feed"),
    work,
  };
}
// Metadata and feed reads only. This function never sends a LINE message or writes a source.
export async function checkAssistantConnection(
  rt: Runtime,
  t: string,
  oa: string,
  kind: "line" | "catalog",
): Promise<CheckResult> {
  let externalRequests = 0;
  try {
    if (kind === "line") {
      requireThat(
        await staffLineReady(rt),
        409,
        "STAFF_LINE_NOT_READY",
        "担当者専用LINEの設定・顧客用LINEとの区別を確認してください。",
      );
      const get = async (path: string) => {
        externalRequests++;
        const r = await rt.externalFetch(`https://api.line.me${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${rt.assistantLine!.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        requireThat(
          r.ok,
          502,
          r.status === 401 || r.status === 403
            ? "LINE_AUTH_FAILED"
            : "LINE_READ_FAILED",
          "LINEの読取確認に失敗しました。トークンとチャネル権限を確認してください。",
        );
        return (await r.json()) as Row;
      };
      const bot = await get("/v2/bot/info");
      requireThat(
        bot.userId === rt.assistantLine!.destination,
        409,
        "LINE_DESTINATION_MISMATCH",
        "設定した担当者用LINEとトークンのチャネルが一致しません。",
      );
      const webhook = await get("/v2/bot/channel/webhook/endpoint");
      const matches =
        webhook.endpoint === new URL("/webhooks/staff-line", rt.origin).href;
      return {
        ok: matches && webhook.active === true,
        kind,
        token: "verified",
        webhook:
          matches && webhook.active === true
            ? "configured"
            : "needs_configuration",
        webhookReachability: "not_tested",
        identity: "requires_pairing",
        delivery: "not_tested",
        checkedAt: now(),
        externalRequests,
        writes: 0,
        messagesSent: 0,
      };
    }
    const config = rt.assistantFeeds?.[`${t}:${oa}`];
    requireThat(
      config,
      409,
      "FEED_NOT_CONNECTED",
      "商品フィードが未設定です。提供元と接続設定を確認してください。",
    );
    externalRequests++;
    const rows = validateCatalog(await gateway(rt, config!));
    return {
      ok: true,
      kind,
      count: rows.length,
      usable: rows.filter(eligible).length,
      transport: "verified",
      contract: "verified",
      sync: "not_run",
      checkedAt: now(),
      externalRequests,
      writes: 0,
      messagesSent: 0,
    };
  } catch (error) {
    return {
      ok: false,
      kind,
      ...safeFailure(error),
      checkedAt: now(),
      externalRequests,
      writes: 0,
      messagesSent: 0,
    };
  }
}
export function registerAssistantConnections(app: Hono<AppEnv>) {
  const context = async (c: Context<AppEnv>) => {
    const rt = c.env.runtime,
      t = c.req.param("tenantId")!,
      oa = c.req.param("oaId")!,
      actor = c.get("principal").user.id;
    const access = await assistantAccess(rt, t, oa, actor);
    requireThat(
      has(access.m, "org_owner", "sys_admin"),
      403,
      "FORBIDDEN",
      "接続診断は管理者が行ってください。",
    );
    return { rt, t, oa, actor };
  };
  app.get(base, async (c) => {
    const x = await context(c);
    return c.json(await assistantConnections(x.rt, x.t, x.oa, x.actor));
  });
  app.post(`${base}/check`, async (c) => {
    const x = await context(c);
    const b = z
      .object({ kind: z.enum(["line", "catalog"]) })
      .strict()
      .parse(await c.req.json());
    return c.json(await checkAssistantConnection(x.rt, x.t, x.oa, b.kind));
  });
  app.post(`${base}/validate`, async (c) => {
    await context(c);
    const text = await c.req.text();
    requireThat(
      text.length <= 500000,
      413,
      "SOURCE_TOO_LARGE",
      "検証するJSONは500KB以内にしてください。",
    );
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      throw new AppError(400, "INVALID_JSON", "JSONの形式を確認してください。");
    }
    return c.json(validateConnectionPayload(input));
  });
}
