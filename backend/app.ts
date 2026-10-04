import { registerSelfDemo } from "./self-demo.ts";
import { registerDemoBooking } from "./self-demo-booking.ts";
import { isDemoGuest } from "./self-demo-access.ts";
import { registerCalendar } from "./calendar.ts";
import { registerAssistant } from "./assistant.ts";
import { registerAssistantLine, registerAssistantLineWebhook } from "./assistant-line.ts";
import { registerMeetingOverview } from "./meeting-overview.ts";
import { registerTimeRexConnection } from "./timerex-connection.ts";
import { registerMeetingInbox } from "./meeting-inbox.ts";
import { registerDrive } from "./drive.ts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestBodyLimit } from "./property-file.ts";
import { activationReadiness, setupEnvironment } from "./setup-readiness.ts";
import { z } from "zod";
import * as OTPAuth from "otpauth";
import { all, one, id, now, json, parse, type Query } from "./db.ts";
import type { AppEnv, Runtime } from "./runtime.ts";
import {
  AppError,
  requireThat,
  audit,
  digest,
  encrypt,
  decrypt,
  limit,
} from "./security.ts";
import {
  principal,
  memberships,
  member,
  requireOps,
  requireRoles,
  customerRoles,
  has,
  homeFor,
  accountFor,
} from "./access.ts";
import {
  registerDatabases,
  queueJob,
  runJob,
  databaseQueries,
  jobQuery,
} from "./jobs.ts";
import { putCredential, getCredential } from "./credentials.ts";
import { registerSales } from "./sales.ts";
import { registerWebhooks } from "./webhooks.ts";
import { registerBooking } from "./booking.ts";
import { registerHarness } from "./harness.ts";
import { registerBrain } from "./brain.ts";
import { registerConnectors } from "./connectors.ts";
import { registerMeetAnalysis } from "./meet-analysis.ts";
import { registerStyle } from "./style.ts";
import { registerRecordingSources } from "./recording-sources.ts";
import { registerCadence } from "./cadence.ts";
import { registerProductivity } from "./productivity.ts";
import { registerBilling } from "./billing.ts";
import { registerOperations } from "./operations.ts";
import { deliveryReady } from "./delivery.ts";
const email = z
  .string()
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
const unit = z.enum(["sales", "team", "company", "mixed"]);
const method = z.enum(["lecture", "agency", "self"]);
const fields = z.object({
  name: z.string().trim().min(1).max(120),
  industry: z.string().max(100).default(""),
  unit: unit.default("sales"),
  method: method.default("lecture"),
  product: z.enum(["existing", "harness"]).default("existing"),
});
const oaSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["sales", "team", "company"]),
    origin: z.enum(["new", "existing"]),
    ownerUserId: z.string().nullable().default(null),
    operators: z.array(z.string()).max(100).default([]),
    teamId: z.string().nullable().default(null),
  })
  .strict();
const read = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await c.req.json());
const rt = (c: Context<AppEnv>) => c.env.runtime;
const actor = (c: Context<AppEnv>) => c.get("principal").user.id;
const tenantId = (c: Context<AppEnv>) => c.req.param("tenantId")!;
export function createApp() {
  const app = new Hono<AppEnv>();
  app.onError((e, c) => {
    console.error("[app.onError]", e);
    const isZod = e instanceof z.ZodError || (e as any)?.name === "ZodError";
    if (isZod) {
      const issues = (e as any).issues || [];
      return c.json(
        {
          error: "INVALID_INPUT",
          message: "入力内容をご確認ください。",
          fields: issues.map((i: any) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }
    if (e instanceof AppError)
      return c.json({ error: e.code, message: e.message }, e.status as any);
    if (e instanceof SyntaxError)
      return c.json(
        { error: "INVALID_JSON", message: "入力形式を確認してください。" },
        400,
      );
    const detail = (e as any)?.message || String(e);
    return c.json(
      {
        error: "INTERNAL_ERROR",
        message: `処理に失敗しました: ${detail}`,
        detail,
      },
      500,
    );
  });
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    if (Number(c.req.header("content-length") || 0) > requestBodyLimit(c.req.method, c.req.path))
      return c.json(
        { error: "TOO_LARGE", message: "送信データが大きすぎます。" },
        413,
      );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.path.startsWith("/api/") &&
      !c.req.path.startsWith("/api/auth/")
    ) {
      requireThat(
        c.req.header("origin") === rt(c).origin,
        403,
        "ORIGIN_INVALID",
        "画面を再読み込みしてから操作してください。",
      );
      requireThat(
        c.req.header("content-type")?.startsWith("application/json"),
        415,
        "JSON_REQUIRED",
        "JSON形式で送信してください。",
      );
    }
    await next();
  });
  app.use(
    "*",
    (c, next) => bodyLimit({
      maxSize: requestBodyLimit(c.req.method, c.req.path),
      onError: (c) =>
        c.json(
          { error: "TOO_LARGE", message: "送信データが大きすぎます。" },
          413,
        ),
    })(c, next),
  );
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/config", (c) =>
    c.json({ ...(rt(c).selfDemo ? { selfDemo: true } : {}), ...(rt(c).harnessReadOnly ? { harnessReadOnly: true } : {}), google: rt(c).googleEnabled, mail: rt(c).mailMode ? rt(c).mailMode !== "unconfigured" : rt(c).local, mailMode: rt(c).mailMode || (rt(c).local ? "local" : "unconfigured") }),
  );
  // OTPはメール所有者だけが受け取る。検証用コードの無認証公開は行わない。
  app.get("/api/staging-otp", c => c.json({error:"NOT_FOUND",message:"Not found"},404));
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    if (c.req.method === "POST" && /\/(email-otp\/send-verification-otp|sign-in\/magic-link)$/.test(c.req.path))
      requireThat(rt(c).mailMode ? rt(c).mailMode !== "unconfigured" : rt(c).local,503,"MAIL_NOT_CONFIGURED","ログイン用メールの配信設定が未完了です。Googleログインを利用するか、管理者へお問い合わせください。");
    return rt(c).auth.handler(c.req.raw);
  });
  registerDemoBooking(app);
  registerAssistantLineWebhook(app);
  registerWebhooks(app);
  registerBooking(app);
  app.use("/api/*", async (c, next) => {
    const p = await principal(rt(c), c.req.raw.headers);
    requireThat(p, 401, "AUTH_REQUIRED", "ログインしてください。");
    c.set("principal", p);
    if(rt(c).selfDemo && await isDemoGuest(rt(c),p.user.id)) {
      const staffBase=`/api/tenants/${rt(c).selfDemo!.tenant}/assistant-line`;
      const allowed=c.req.path==="/api/me" || c.req.path==="/api/demo" || c.req.path.startsWith("/api/demo/") || c.req.path===staffBase || ["pair","confirm","preferences","revoke"].some(x=>c.req.path===staffBase+"/"+x);
      requireThat(allowed,403,"DEMO_SCOPE","体験用の画面から操作してください。ほかの利用者のデータは参照できません。");
    }
    await next();
  });
  registerSelfDemo(app);
  app.get("/api/me", async (c) => {
    const p = c.get("principal");
    const [ms, invites, factor] = await Promise.all([
      memberships(rt(c), p.user.id),
      all(
        rt(c).db,
        "SELECT i.id,i.tenant_id,t.name,i.roles,i.expires_at FROM invitations i JOIN tenants t ON t.id=i.tenant_id WHERE i.email=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?",
        [p.user.email, now()],
      ),
      one(
        rt(c).db,
        "SELECT confirmed FROM mfa_factors WHERE user_id=?",
        [p.user.id],
      ),
    ]);
    const active =
      ms.find((m) => m.tenant_id === p.tenantId) ??
      (ms.length === 1 ? ms[0] : null);
    const tenantRoute = active
      ? active.tenant_state === "setup"
        ? active.roles.some((x: string) =>
            ["sys_admin", "org_owner"].includes(x),
          )
          ? "/onboarding"
          : "/setup-waiting"
        : homeFor(active)
      : null;
    const route = tenantRoute
      ? tenantRoute
      : p.opsRole
        ? p.mfa
          ? "/ops"
          : "/security"
        : invites.length
          ? "/invitations"
          : ms.length > 1
            ? "/companies"
            : "/access";
    return c.json({
      user: p.user,
      memberships: ms,
      activeTenant: active?.tenant_id ?? null,
      opsRole: p.opsRole,
      mfa: p.mfa,
      mfaEnrolled: Boolean(factor?.confirmed),
      invitations: invites.map((i) => ({ ...i, roles: parse(i.roles, []) })),
      selfDemo: !!rt(c).selfDemo,
      demoOnly: await isDemoGuest(rt(c),p.user.id),
      home: await isDemoGuest(rt(c),p.user.id) ? "/demo" : route,
    });
  });
  app.post("/api/session/tenant", async (c) => {
    const b = await read(c, z.object({ tenantId: z.string() }));
    await member(rt(c), actor(c), b.tenantId);
    await rt(c).db.query(
      "INSERT INTO session_context(session_id,tenant_id) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET tenant_id=excluded.tenant_id",
      [c.get("principal").sessionId, b.tenantId],
    );
    return c.json({ ok: true });
  });
  app.post("/api/invitations/:id/accept", async (c) => {
    const invite = await one(rt(c).db, "SELECT * FROM invitations WHERE id=?", [
      c.req.param("id"),
    ]);
    requireThat(
      invite && invite.email === c.get("principal").user.email,
      404,
      "INVITATION_NOT_FOUND",
      "このアカウント宛の招待がありません。",
    );
    requireThat(
      !invite.revoked_at && invite.expires_at > now(),
      410,
      "INVITATION_EXPIRED",
      "招待の期限が切れています。管理者へ再発行を依頼してください。",
    );
    requireThat(
      !invite.accepted_by || invite.accepted_by === actor(c),
      409,
      "INVITATION_USED",
      "この招待は使用済みです。",
    );
    // 招待受諾と所属追加は同一DBのbatchで確定する。既存所属を無断で昇格させない。
    await rt(c).db.batch([
      {
        sql: "INSERT OR IGNORE INTO memberships(tenant_id,user_id,roles,teams) SELECT tenant_id,?,roles,teams FROM invitations WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?",
        params: [actor(c), invite.id, now()],
      },
      {
        sql: "UPDATE invitations SET accepted_by=?,accepted_at=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?",
        params: [actor(c), now(), invite.id, now()],
      },
      {
        sql: "INSERT INTO session_context(session_id,tenant_id) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET tenant_id=excluded.tenant_id",
        params: [c.get("principal").sessionId, invite.tenant_id],
      },
    ]);
    await audit(
      rt(c).db,
      actor(c),
      "invitation.accepted",
      invite.id,
      invite.tenant_id,
    );
    return c.json({ ok: true });
  });
  app.post("/api/security/enroll", async (c) => {
    const p = c.get("principal");
    requireThat(p.opsRole, 403, "OPS_FORBIDDEN", "運営者向けの設定です。");
    const existing = await one(
      rt(c).db,
      "SELECT confirmed FROM mfa_factors WHERE user_id=?",
      [p.user.id],
    );
    requireThat(
      !existing?.confirmed,
      409,
      "MFA_ALREADY_ENABLED",
      "追加認証は登録済みです。",
    );
    const secret = new OTPAuth.Secret({ size: 20 });
    const sealed = await encrypt(rt(c).key, secret.base32, `mfa:${p.user.id}`);
    await rt(c).db.query(
      "INSERT INTO mfa_factors(user_id,secret) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret",
      [p.user.id, sealed],
    );
    const totp = new OTPAuth.TOTP({
      issuer: "TSUNAGU",
      label: p.user.email,
      secret,
    });
    return c.json({ uri: totp.toString(), secret: secret.base32 });
  });
  app.post("/api/security/verify", async (c) => {
    const p = c.get("principal");
    const b = await read(c, z.object({ code: z.string().regex(/^\d{6}$/) }));
    await limit(rt(c).db, `mfa:${p.user.id}`, 5, 300);
    const factor = await one(
      rt(c).db,
      "SELECT * FROM mfa_factors WHERE user_id=?",
      [p.user.id],
    );
    requireThat(
      factor,
      409,
      "MFA_NOT_ENROLLED",
      "認証アプリを登録してください。",
    );
    const secret = await decrypt(rt(c).key, factor.secret, `mfa:${p.user.id}`);
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const delta = totp.validate({ token: b.code, window: 1 });
    requireThat(
      delta !== null,
      400,
      "INVALID_FACTOR",
      "確認コードが一致しません。",
    );
    const counter = Math.floor(Date.now() / 30000) + delta;
    const r = await rt(c).db.query(
      "UPDATE mfa_factors SET confirmed=1,last_counter=? WHERE user_id=? AND last_counter<?",
      [counter, p.user.id, counter],
    );
    requireThat(
      r.changes,
      400,
      "FACTOR_REUSED",
      "このコードは使用済みです。次のコードをお待ちください。",
    );
    await rt(c).db.query(
      "INSERT INTO session_context(session_id,mfa_at) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET mfa_at=excluded.mfa_at",
      [p.sessionId, now()],
    );
    await audit(rt(c).db, p.user.id, "mfa.verified", p.sessionId);
    return c.json({ ok: true });
  });

  app.use("/api/ops/*", async (c, next) => {
    requireOps(c, "ops_sales", "ops_setup", "ops_finance", "ops_support");
    await next();
  });
  app.get("/api/ops/overview", async (c) => {
    const db = rt(c).db;
    const tenants = await all(
      db,
      "SELECT t.*, (SELECT count(*) FROM accounts a WHERE a.tenant_id=t.id) AS oa_count,(SELECT count(*) FROM accounts a WHERE a.tenant_id=t.id AND a.state='ready') AS ready_count FROM tenants t ORDER BY created_at DESC",
    );
    const usage = await all(
      db,
      "SELECT kind,sum(units) AS units,sum(cost_micros) AS cost_micros,count(*) AS events,sum(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS missing FROM usage_events WHERE occurred_at>=? GROUP BY kind",
      [
        new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
        ).toISOString(),
      ],
    );
    const jobs = await all(
      db,
      "SELECT j.*,t.name AS tenant_name FROM jobs j JOIN tenants t ON t.id=j.tenant_id WHERE j.state<>'completed' ORDER BY j.created_at DESC",
    );
    const canFinance = ["ops_owner", "ops_finance"].includes(
      c.get("principal").opsRole || "",
    );
    return c.json({
      tenants: tenants.map((t) =>
        canFinance ? t : { ...t, monthly_fee: undefined },
      ),
      usage: canFinance
        ? usage
        : usage.map((u) => ({ kind: u.kind, units: u.units })),
      jobs,
      updatedAt: now(),
    });
  });
  app.get("/api/ops/tenants/:tenantId", async (c) => {
    const tenant = await one(rt(c).db, "SELECT * FROM tenants WHERE id=?", [
      tenantId(c),
    ]);
    requireThat(tenant, 404, "NOT_FOUND", "企業が見つかりません。");
    const setup = await tenantSetup(rt(c), tenant);
    if (
      !["ops_owner", "ops_finance", "ops_sales"].includes(
        c.get("principal").opsRole || "",
      )
    )
      setup.tenant.monthly_fee = undefined;
    return c.json(setup);
  });
  app.post("/api/ops/tenants", async (c) => {
    requireOps(c, "ops_sales");
    const b = await read(
      c,
      fields
        .extend({
          adminEmail: email,
          adminRoles: z
            .array(z.enum(customerRoles))
            .min(1)
            .max(5)
            .default(["sys_admin"]),
          planName: z.string().max(100).nullable().default(null),
          monthlyFee: z.number().int().min(0).nullable().default(null),
          accounts: z.array(oaSchema).max(50).default([]),
        })
        .strict(),
    );
    const key = c.req.header("idempotency-key");
    requireThat(
      key && key.length <= 100,
      400,
      "KEY_REQUIRED",
      "処理番号が必要です。再読み込みしてください。",
    );
    const hash = await digest(json(b));
    const prior = await one(
      rt(c).db,
      "SELECT * FROM idempotency WHERE actor_id=? AND key=?",
      [actor(c), key],
    );
    if (prior) {
      requireThat(
        prior.request_hash === hash,
        409,
        "KEY_CONFLICT",
        "同じ処理番号で内容が変更されています。",
      );
      return c.json({ id: prior.result_id });
    }
    const tid = id(),
      invitationId = id();
    // 企業・招待・DBレジストリ・開通ジョブを同じトランザクションで保存する。
    // 応答前に接続が切れても、処理番号で同じ企業を返し、未完了ジョブを再開できる。
    const queries: Query[] = [
      {
        sql: "INSERT INTO idempotency(actor_id,key,request_hash,result_id) VALUES (?,?,?,?)",
        params: [actor(c), key, hash, tid],
      },
      {
        sql: "INSERT INTO tenants(id,name,industry,unit,method,product,plan_name,monthly_fee,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        params: [
          tid,
          b.name,
          b.industry,
          b.unit,
          b.method,
          b.product,
          b.planName,
          b.monthlyFee,
          now(),
        ],
      },
      {
        sql: "INSERT INTO invitations(id,tenant_id,email,roles,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)",
        params: [
          invitationId,
          tid,
          b.adminEmail,
          json(b.adminRoles),
          new Date(Date.now() + 7 * 86400000).toISOString(),
          actor(c),
          now(),
        ],
      },
      ...databaseQueries(tid),
      jobQuery(tid, "", "provision", actor(c), `provision:${tid}:initial`),
      jobQuery(tid, "", "invite", actor(c), `invite:${invitationId}`, {
        invitationId,
      }),
    ];
    for (const a of b.accounts) {
      requireThat(
        !a.ownerUserId && !a.operators.length,
        400,
        "INITIAL_OWNER",
        "担当者は招待受諾後に設定してください。",
      );
      const oa = id();
      queries.push(
        {
          sql: "INSERT INTO accounts(id,tenant_id,name,kind,origin,team_id,created_at) VALUES (?,?,?,?,?,?,?)",
          params: [oa, tid, a.name, a.kind, a.origin, a.teamId, now()],
        },
        ...databaseQueries(tid, oa),
      );
    }
    try {
      await rt(c).db.batch(queries);
    } catch (e) {
      const concurrent = await one(
        rt(c).db,
        "SELECT * FROM idempotency WHERE actor_id=? AND key=?",
        [actor(c), key],
      );
      if (concurrent && concurrent.request_hash === hash)
        return c.json({ id: concurrent.result_id });
      throw e;
    }
    await audit(rt(c).db, actor(c), "tenant.created", tid, tid);
    return c.json({ id: tid }, 201);
  });
  app.post("/api/ops/tenants/:tenantId/accounts", async (c) => {
    requireOps(c, "ops_setup");
    const b = await read(c, oaSchema);
    const tenant = await one(rt(c).db, "SELECT id FROM tenants WHERE id=?", [
      tenantId(c),
    ]);
    requireThat(tenant, 404, "NOT_FOUND", "企業が見つかりません。");
    return c.json(await createOA(rt(c), tenant.id, b, actor(c)), 201);
  });
  app.get("/api/ops/jobs", async (c) =>
    c.json({
      jobs: await all(
        rt(c).db,
        "SELECT j.*,t.name AS tenant_name FROM jobs j JOIN tenants t ON t.id=j.tenant_id ORDER BY created_at DESC LIMIT 200",
      ),
    }),
  );
  app.post("/api/ops/jobs/:id/retry", async (c) => {
    requireOps(c, "ops_setup");
    const job = await one(rt(c).db, "SELECT * FROM jobs WHERE id=?", [
      c.req.param("id"),
    ]);
    requireThat(job, 404, "NOT_FOUND", "処理が見つかりません。");
    requireThat(
      ["failed", "pending"].includes(job.state),
      409,
      "JOB_STATE",
      "この処理は再試行できません。",
    );
    await rt(c).db.query(
      "UPDATE jobs SET state='pending',error_code=NULL WHERE id=? AND state='failed'",
      [job.id],
    );
    await audit(rt(c).db, actor(c), "job.retried", job.id, job.tenant_id);
    await runJob(rt(c), job.id);
    return c.json({ ok: true });
  });
  app.get("/api/ops/audit", async (c) =>
    c.json({
      audit: await all(
        rt(c).db,
        "SELECT * FROM audit ORDER BY at DESC LIMIT 200",
      ),
    }),
  );
  app.get("/api/ops/usage", async (c) => {
    requireOps(c, "ops_finance");
    return c.json({
      events: await all(
        rt(c).db,
        "SELECT * FROM usage_events ORDER BY occurred_at DESC LIMIT 500",
      ),
    });
  });
  app.get("/api/ops/support", async (c) =>
    c.json({
      requests: await all(
        rt(c).db,
        "SELECT s.*,t.name AS tenant_name FROM support_access s JOIN tenants t ON t.id=s.tenant_id ORDER BY created_at DESC",
      ),
    }),
  );
  app.post("/api/ops/support", async (c) => {
    requireOps(c, "ops_support");
    const b = await read(
      c,
      z
        .object({
          tenantId: z.string(),
          oaId: z.string(),
          reason: z.string().trim().min(10).max(500),
          hours: z.number().int().min(1).max(24),
        })
        .strict(),
    );
    await accountFor(rt(c), b.tenantId, b.oaId);
    const sid = id();
    await rt(c).db.query(
      "INSERT INTO support_access(id,tenant_id,oa_id,requested_by,reason,scope,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        sid,
        b.tenantId,
        b.oaId,
        actor(c),
        b.reason,
        "conversation.read",
        new Date(Date.now() + b.hours * 3600000).toISOString(),
        now(),
      ],
    );
    await audit(rt(c).db, actor(c), "support.requested", sid, b.tenantId);
    return c.json({ id: sid }, 201);
  });
  app.post("/api/ops/support/:id/revoke", async (c) => {
    requireOps(c, "ops_support");
    await rt(c).db.query(
      "UPDATE support_access SET state='revoked' WHERE id=? AND requested_by=?",
      [c.req.param("id"), actor(c)],
    );
    await audit(rt(c).db, actor(c), "support.revoked", c.req.param("id"));
    return c.json({ ok: true });
  });

  app.use("/api/tenants/:tenantId/*", async (c, next) => {
    const m = await member(rt(c), actor(c), tenantId(c));
    c.set("membership", m);
    const t = await one(rt(c).db, "SELECT * FROM tenants WHERE id=?", [
      tenantId(c),
    ]);
    requireThat(
      t?.state !== "suspended",
      403,
      "TENANT_SUSPENDED",
      "この企業は利用を停止しています。",
    );
    c.set("tenant", t);
    await next();
  });
  app.get("/api/tenants/:tenantId/setup", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    return c.json(await tenantSetup(rt(c), c.get("tenant")));
  });
  app.get("/api/tenants/:tenantId/my-accounts", async (c) => {
    const rows = await all(
      rt(c).db,
      "SELECT id,name,owner_user_id,operators FROM accounts WHERE tenant_id=?",
      [tenantId(c)],
    );
    return c.json({
      accounts: rows
        .filter(
          (a) =>
            a.owner_user_id === actor(c) ||
            parse(a.operators, []).includes(actor(c)),
        )
        .map((a) => ({ id: a.id, name: a.name })),
    });
  });
  app.patch("/api/tenants/:tenantId/settings", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const b = await read(
      c,
      fields
        .extend({
          version: z.number().int(),
          retentionDays: z.number().int().min(1).max(3650).nullable(),
          shareTeam: z.boolean().default(false),
        })
        .strict(),
    );
    const r = await rt(c).db.query(
      "UPDATE tenants SET name=?,industry=?,unit=?,method=?,product=?,settings=?,version=version+1 WHERE id=? AND version=?",
      [
        b.name,
        b.industry,
        b.unit,
        b.method,
        b.product,
        json({
          ...parse(c.get("tenant").settings),
          retentionDays: b.retentionDays,
          shareTeam: b.shareTeam,
        }),
        tenantId(c),
        b.version,
      ],
    );
    requireThat(
      r.changes,
      409,
      "VERSION_CONFLICT",
      "別の方が更新しました。最新状態を読み込んでください。",
    );
    await audit(
      rt(c).db,
      actor(c),
      "tenant.settings_updated",
      tenantId(c),
      tenantId(c),
    );
    return c.json({ ok: true });
  });
  app.post("/api/tenants/:tenantId/invitations", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const b = await read(
      c,
      z
        .object({
          email,
          roles: z.array(z.enum(customerRoles)).min(1).max(5),
          teams: z.array(z.string()).max(50).default([]),
        })
        .strict(),
    );
    const iid = id();
    await rt(c).db.query(
      "INSERT INTO invitations(id,tenant_id,email,roles,teams,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        iid,
        tenantId(c),
        b.email,
        json(b.roles),
        json(b.teams),
        new Date(Date.now() + 7 * 86400000).toISOString(),
        actor(c),
        now(),
      ],
    );
    await queueJob(
      rt(c),
      tenantId(c),
      "",
      "invite",
      actor(c),
      `invite:${iid}`,
      { invitationId: iid },
    );
    await audit(rt(c).db, actor(c), "invitation.created", iid, tenantId(c));
    return c.json({ id: iid }, 201);
  });
  app.patch("/api/tenants/:tenantId/members/:userId", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const b = await read(
      c,
      z
        .object({
          roles: z.array(z.enum(customerRoles)).min(1),
          teams: z.array(z.string()),
          state: z.enum(["active", "suspended"]),
        })
        .strict(),
    );
    requireThat(
      c.req.param("userId") !== actor(c),
      409,
      "SELF_CHANGE",
      "自身の権限変更は別の管理者へ依頼してください。",
    );
    const result = await rt(c).db.query(
      "UPDATE memberships SET roles=?,teams=?,state=? WHERE tenant_id=? AND user_id=?",
      [
        json(b.roles),
        json(b.teams),
        b.state,
        tenantId(c),
        c.req.param("userId"),
      ],
    );
    requireThat(result.changes, 404, "NOT_FOUND", "利用者が見つかりません。");
    await audit(
      rt(c).db,
      actor(c),
      "membership.updated",
      c.req.param("userId"),
      tenantId(c),
    );
    return c.json({ ok: true });
  });
  app.post("/api/tenants/:tenantId/accounts", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    return c.json(
      await createOA(rt(c), tenantId(c), await read(c, oaSchema), actor(c)),
      201,
    );
  });
  app.patch("/api/tenants/:tenantId/accounts/:oaId", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const b = await read(c, oaSchema.extend({ version: z.number().int() }));
    await validateOperators(rt(c), tenantId(c), b);
    const r = await rt(c).db.query(
      "UPDATE accounts SET name=?,kind=?,owner_user_id=?,operators=?,team_id=?,version=version+1 WHERE tenant_id=? AND id=? AND version=?",
      [
        b.name,
        b.kind,
        b.ownerUserId,
        json(b.operators),
        b.teamId,
        tenantId(c),
        c.req.param("oaId"),
        b.version,
      ],
    );
    requireThat(
      r.changes,
      409,
      "VERSION_CONFLICT",
      "最新の公式LINE設定を確認してください。",
    );
    await audit(
      rt(c).db,
      actor(c),
      "oa.updated",
      c.req.param("oaId"),
      tenantId(c),
    );
    return c.json({ ok: true });
  });
  app.post("/api/tenants/:tenantId/accounts/:oaId/credentials", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
    const b = await read(
      c,
      z
        .object({
          channelId: z.string().regex(/^\d{5,20}$/),
          channelSecret: z.string().min(20).max(256),
          accessToken: z.string().min(20).max(4096),
        })
        .strict(),
    );
    const duplicate = await one(
      rt(c).db,
      "SELECT id FROM accounts WHERE channel_id=? AND id<>?",
      [b.channelId, c.req.param("oaId")],
    );
    requireThat(
      !duplicate,
      409,
      "CHANNEL_ALREADY_CONNECTED",
      "このチャネルはすでに登録されています。",
    );
    await putCredential(
      rt(c),
      tenantId(c),
      c.req.param("oaId"),
      "line",
      b,
      actor(c),
    );
    await rt(c).db.query(
      "UPDATE accounts SET channel_id=?,state='webhook',webhook_verified_at=NULL WHERE id=? AND tenant_id=?",
      [b.channelId, c.req.param("oaId"), tenantId(c)],
    );
    return c.json({ ok: true });
  });
  app.post("/api/tenants/:tenantId/accounts/:oaId/verify-line", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const oa = await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
    const b = await read(
      c,
      z
        .object({
          mode: z.enum(["gateway", "harness"]),
          confirmedExistingWebhook: z.boolean().optional(),
          confirmed: z.any().optional(),
        })
        .passthrough(),
    );
    const isConfirmed = Boolean(
      b.confirmedExistingWebhook || b.confirmed === "on" || b.confirmed === true,
    );
    requireThat(
      isConfirmed,
      400,
      "CONFIRMATION_REQUIRED",
      "「既存Webhookと現在利用中のシステムを確認しました」にチェックを入れてください。",
    );
    let cred;
    try {
      cred = await getCredential(rt(c), tenantId(c), oa.id, "line");
    } catch (e: any) {
      requireThat(
        false,
        409,
        "CREDENTIAL_DECRYPT_FAILED",
        `資格情報の取得・復号に失敗しました: ${e?.message || e}。LINE資格情報を再度入力・登録してください。`,
      );
    }
    requireThat(
      cred && cred.accessToken,
      409,
      "CREDENTIAL_REQUIRED",
      "資格情報を登録してください。",
    );
    const token = String(cred.accessToken).trim();

    let response;
    try {
      response = await rt(c).externalFetch(
        "https://api.line.me/v2/bot/info",
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch (e: any) {
      requireThat(
        false,
        409,
        "LINE_NETWORK_ERROR",
        `LINE APIへの接続でネットワークエラーが発生しました: ${e?.message || e}`,
      );
    }
    requireThat(
      response.ok,
      409,
      "LINE_CREDENTIAL_INVALID",
      `LINEへの接続に失敗しました（HTTP ${response.status}）。登録したアクセストークンをご確認ください。`,
    );
    const bot = z
      .object({
        userId: z.string().regex(/^U[0-9a-f]{32}$/),
        displayName: z.string(),
      })
      .passthrough()
      .parse(await response.json());

    let endpoint;
    try {
      endpoint = await rt(c).externalFetch(
        "https://api.line.me/v2/bot/channel/webhook/endpoint",
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch (e: any) {
      requireThat(
        false,
        409,
        "WEBHOOK_NETWORK_ERROR",
        `LINE Webhook情報の取得でネットワークエラーが発生しました: ${e?.message || e}`,
      );
    }
    requireThat(
      endpoint.ok,
      409,
      "WEBHOOK_CHECK_FAILED",
      `Webhook設定を確認できませんでした（HTTP ${endpoint.status}）。`,
    );
    const configured = z
      .object({ endpoint: z.string().optional().nullable(), active: z.boolean().optional() })
      .passthrough()
      .parse(await endpoint.json());
    const expected = `${rt(c).origin}/webhooks/line/${oa.id}`;
    if (b.mode === "gateway")
      requireThat(
        !configured.endpoint || configured.endpoint === expected,
        409,
        "WEBHOOK_CONFLICT",
        "別のシステムのWebhookが設定されています。接続の切り替え方法を確認してください。",
      );
    await rt(c).db.query(
      "UPDATE accounts SET destination=?,webhook_mode=?,webhook_verified_at=NULL WHERE id=?",
      [bot.userId, b.mode, oa.id],
    );
    await audit(rt(c).db, actor(c), "line.verified", oa.id, tenantId(c));
    return c.json({
      displayName: bot.displayName,
      webhookURL: expected,
      awaitingEvent: true,
    });
  });
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/test-webhook",
    async (c) => {
      requireRoles(c, "sys_admin", "org_owner");
      const oa = await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
      if (oa.webhook_mode === "harness") {
        const conn = await one(
          rt(c).db,
          "SELECT state FROM connections WHERE tenant_id=? AND oa_id=? AND service='harness'",
          [tenantId(c), oa.id],
        );
        requireThat(
          conn && conn.state === "connected",
          400,
          "HARNESS_NOT_CONNECTED",
          "先に「Harnessと接続する」を保存してください。",
        );
      }
      const verifiedAt = now();
      await rt(c).db.query(
        "UPDATE accounts SET webhook_verified_at=? WHERE id=?",
        [verifiedAt, oa.id],
      );
      await audit(rt(c).db, actor(c), "webhook.tested", oa.id, tenantId(c));
      return c.json({ ok: true, webhook_verified_at: verifiedAt });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/verify-webhook-manual",
    async (c) => {
      requireRoles(c, "sys_admin", "org_owner");
      const oa = await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
      const verifiedAt = now();
      await rt(c).db.query(
        "UPDATE accounts SET webhook_verified_at=? WHERE id=?",
        [verifiedAt, oa.id],
      );
      await audit(
        rt(c).db,
        actor(c),
        "webhook.manually_verified",
        oa.id,
        tenantId(c),
      );
      return c.json({ ok: true, webhook_verified_at: verifiedAt });
    },
  );
  app.get("/api/tenants/:tenantId/accounts/:oaId/preview", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const oa = await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
    const common = await rt(c).openDatabase(tenantId(c), "", "common"),
      ts = await rt(c).openDatabase(tenantId(c), oa.id, "tsunagu");
    const customers = await one(
      common,
      "SELECT count(*) AS n FROM customer_links WHERE oa_id=?",
      [oa.id],
    );
    const assets = await one(ts, "SELECT count(*) AS n FROM assets");
    const fingerprint = await digest(
      json({
        id: oa.id,
        version: oa.version,
        sync: oa.sync_at,
        customers: customers.n,
        assets: assets.n,
      }),
    );
    return c.json({
      accountName: oa.name,
      customers: customers.n,
      assets: assets.n,
      fingerprint,
    });
  });
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/preview/confirm",
    async (c) => {
      requireRoles(c, "sys_admin", "org_owner");
      const oa = await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
      const b = await read(c, z.object({ fingerprint: z.string() }));
      const common = await rt(c).openDatabase(tenantId(c), "", "common"),
        ts = await rt(c).openDatabase(tenantId(c), oa.id, "tsunagu");
      const customers = await one(
          common,
          "SELECT count(*) AS n FROM customer_links WHERE oa_id=?",
          [oa.id],
        ),
        assets = await one(ts, "SELECT count(*) AS n FROM assets");
      const fingerprint = await digest(
        json({
          id: oa.id,
          version: oa.version,
          sync: oa.sync_at,
          customers: customers.n,
          assets: assets.n,
        }),
      );
      requireThat(
        b.fingerprint === fingerprint,
        409,
        "PREVIEW_CHANGED",
        "データが更新されています。最新の件数をご確認ください。",
      );
      requireThat(
        oa.webhook_verified_at,
        409,
        "CONNECTION_NOT_VERIFIED",
        "先にWebhookの受信を確認してください。",
      );
      await rt(c).db.query("UPDATE accounts SET preview_ready=1 WHERE id=?", [
        oa.id,
      ]);
      await audit(rt(c).db, actor(c), "preview.confirmed", oa.id, tenantId(c));
      return c.json({ ok: true });
    },
  );
  app.post("/api/tenants/:tenantId/support/:id/decision", async (c) => {
    requireRoles(c, "org_owner", "sys_admin");
    const b = await read(c, z.object({ approve: z.boolean() }));
    const r = await rt(c).db.query(
      "UPDATE support_access SET state=?,approved_by=? WHERE id=? AND tenant_id=? AND state='pending' AND expires_at>? AND requested_by<>?",
      [
        b.approve ? "approved" : "rejected",
        actor(c),
        c.req.param("id"),
        tenantId(c),
        now(),
        actor(c),
      ],
    );
    requireThat(
      r.changes,
      409,
      "SUPPORT_STATE",
      "この申請を承認できません。期限と申請状態をご確認ください。",
    );
    await audit(
      rt(c).db,
      actor(c),
      "support.decided",
      c.req.param("id"),
      tenantId(c),
      { approve: b.approve },
    );
    return c.json({ ok: true });
  });
  app.post("/api/tenants/:tenantId/accounts/:oaId/activate", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const a = await accountFor(rt(c), tenantId(c), c.req.param("oaId"));
    const [dbs, connections] = await Promise.all([
      all(rt(c).db, "SELECT * FROM databases WHERE tenant_id=? AND (oa_id=? OR oa_id='')", [tenantId(c), a.id]),
      all(rt(c).db, "SELECT * FROM connections WHERE tenant_id=? AND oa_id=?", [tenantId(c), a.id]),
    ]);
    const readiness = activationReadiness(rt(c), c.get("tenant"), a, dbs, connections);
    requireThat(
      readiness.canActivate,
      409,
      "ACTIVATION_INCOMPLETE",
      `未完了：${readiness.checks.filter(x=>!x.ready).map(x=>x.label).join("、")}。導入画面の「開通までの進め方」から確認してください。`,
    );
    await rt(c).db.batch([
      { sql: "UPDATE accounts SET state='ready' WHERE id=?", params: [a.id] },
      {
        sql: "UPDATE tenants SET state='active' WHERE id=?",
        params: [tenantId(c)],
      },
    ]);
    await audit(rt(c).db, actor(c), "oa.activated", a.id, tenantId(c));
    return c.json({ ok: true });
  });
  registerAssistant(app);
  registerAssistantLine(app);
  registerSales(app);
  registerHarness(app);
  registerBrain(app);
  registerConnectors(app);
  registerMeetAnalysis(app);
  registerRecordingSources(app);
  registerCalendar(app);
  registerDrive(app);
  registerTimeRexConnection(app);
  registerMeetingInbox(app);
  registerMeetingOverview(app);
  registerStyle(app);
  registerCadence(app);
  registerProductivity(app);
  registerBilling(app);
  registerOperations(app);
  app.all("/api/*", (c) =>
    c.json({ error: "NOT_FOUND", message: "この操作は利用できません。" }, 404),
  );
  app.get("*", async (c) => {
    // 開発資料は本番アセットに含めない。画面の表示許可とは別にAPIも認可する。
    if (
      c.req.path.startsWith("/structure") ||
      c.req.path.startsWith("/review") ||
      c.req.path.includes("model.json")
    )
      return c.text("Not found", 404);
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (rt(c).assets) {
      const res = await rt(c).assets!.fetch(c.req.raw);
      if (c.req.path.startsWith("/assets/")) {
        const headers = new Headers(res.headers);
        const isHashed = /[-.][a-zA-Z0-9_-]{8,}\.(js|css)$/.test(c.req.path);
        if (isHashed) {
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          headers.set(
            "Cache-Control",
            "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
          );
        }
        headers.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
        return new Response(res.status === 304 ? null : res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      return new Response(res.status === 304 ? null : res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }
    return c.text("Build the application first.", 503);
  });
  return app;
}
async function validateOperators(
  rt: Runtime,
  tenant: string,
  b: z.infer<typeof oaSchema>,
) {
  for (const user of new Set(
    [b.ownerUserId, ...b.operators].filter(Boolean) as string[],
  ))
    await member(rt, user, tenant);
}
async function createOA(
  rt: Runtime,
  tenant: string,
  b: z.infer<typeof oaSchema>,
  actor: string,
) {
  await validateOperators(rt, tenant, b);
  const oa = id();
  await rt.db.batch([
    {
      sql: "INSERT INTO accounts(id,tenant_id,name,kind,origin,owner_user_id,operators,team_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      params: [
        oa,
        tenant,
        b.name,
        b.kind,
        b.origin,
        b.ownerUserId,
        json(b.operators),
        b.teamId,
        now(),
      ],
    },
    ...databaseQueries(tenant, oa),
    jobQuery(tenant, oa, "provision", actor, `provision:${oa}`),
  ]);
  await audit(rt.db, actor, "oa.created", oa, tenant);
  return { id: oa };
}
async function tenantSetup(rt: Runtime, tenant: any) {
  const tid = tenant.id;
  const [
    accounts,
    databases,
    connections,
    credentials,
    members,
    invitations,
    jobs,
    support,
  ] = await Promise.all([
    all(rt.db, "SELECT * FROM accounts WHERE tenant_id=?", [tid]),
    all(rt.db, "SELECT * FROM databases WHERE tenant_id=?", [tid]),
    all(rt.db, "SELECT * FROM connections WHERE tenant_id=?", [tid]),
    all(
      rt.db,
      "SELECT oa_id,service,registered_by,updated_at FROM credentials WHERE tenant_id=? AND service<>'runtime'",
      [tid],
    ),
    all(
      rt.db,
      "SELECT m.*,u.email,u.name FROM memberships m JOIN user u ON u.id=m.user_id WHERE m.tenant_id=?",
      [tid],
    ),
    all(
      rt.db,
      "SELECT id,email,roles,expires_at,accepted_at,revoked_at FROM invitations WHERE tenant_id=?",
      [tid],
    ),
    all(
      rt.db,
      "SELECT * FROM jobs WHERE tenant_id=? ORDER BY created_at DESC",
      [tid],
    ),
    all(
      rt.db,
      "SELECT * FROM support_access WHERE tenant_id=? ORDER BY created_at DESC",
      [tid],
    ),
  ]);
  return {
    tenant: { ...tenant, settings: parse(tenant.settings) },
    environment: setupEnvironment(rt),
    readiness: accounts.map(a=>activationReadiness(rt,tenant,a,databases,connections)),
    accounts: accounts.map((a) => ({
      ...a,
      operators: parse(a.operators, []),
    })),
    databases,
    connections: connections.map((c) => ({ ...c, config: parse(c.config) })),
    credentials,
    members: members.map((m) => ({
      ...m,
      roles: parse(m.roles, []),
      teams: parse(m.teams, []),
    })),
    invitations,
    jobs,
    support,
  };
}
