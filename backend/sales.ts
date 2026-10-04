import { mapLimited } from "./async-utils.ts";
import { assistantGuard, ordinaryOnly } from "./assistant.ts";
import { queueProposalNotice } from "./notify.ts";
import type { Hono, Context } from "hono";
import { z } from "zod";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import type { AppEnv, Runtime } from "./runtime.ts";
import { audit, requireThat } from "./security.ts";
import { accountFor, customerAccess, requireRoles, has } from "./access.ts";
import { getCredential } from "./credentials.ts";
import { deliveryReady, sendDue } from "./delivery.ts";
import { applyMeetingResult } from "./meeting-events.ts";
import {
  adaptStyleFromFeedback,
  getAccountCalibrationProfile,
} from "./style.ts";
const t = (c: Context<AppEnv>) => c.req.param("tenantId")!;
const a = (c: Context<AppEnv>) => c.req.param("oaId")!;
const actor = (c: Context<AppEnv>) => c.get("principal").user.id;
const runtime = (c: Context<AppEnv>) => c.env.runtime;
async function customer(
  c: Context<AppEnv>,
  cid: string,
  action: "read" | "edit" | "approve" | "send" = "read",
) {
  const rt = runtime(c),
    common = await rt.openDatabase(t(c), "", "common");
  const row = await one(common, "SELECT * FROM customers WHERE id=?", [cid]);
  requireThat(
    row &&
      customerAccess(
        c.get("membership"),
        row,
        action,
        parse(c.get("tenant").settings),
      ),
    404,
    "CUSTOMER_NOT_FOUND",
    "顧客が見つからないか、操作権限がありません。",
  );
  return row;
}
async function linked(c: Context<AppEnv>, cid: string) {
  const rt = runtime(c);
  await accountFor(rt, t(c), a(c));
  const common = await rt.openDatabase(t(c), "", "common");
  const link = await one(
    common,
    "SELECT * FROM customer_links WHERE oa_id=? AND customer_id=? AND state='confirmed'",
    [a(c), cid],
  );
  requireThat(
    link,
    404,
    "CUSTOMER_NOT_LINKED",
    "この公式LINEに顧客が関連付けられていません。",
  );
  return link;
}
export const calibrationQuestions = [
  {
    id: "common.first",
    group: "共通",
    text: "初めてお問い合わせをいただきました。普段の言葉でお礼と自己紹介をしてください。",
  },
  {
    id: "common.needs",
    group: "共通",
    text: "「少し興味があるけれど、まだ具体的ではない」と言われました。希望を確かめる返信を書いてください。",
  },
  {
    id: "common.booking",
    group: "共通",
    text: "「一度話を聞きたい」と返信がありました。予約ページをご案内する言葉を書いてください。",
  },
  {
    id: "common.wait",
    group: "共通",
    text: "「家族と相談してから考えます」と言われました。急がせずに返信してください。",
  },
  {
    id: "common.change",
    group: "共通",
    text: "面談の日程変更を希望されています。希望日を伺う返信を書いてください。",
  },
  {
    id: "industry.case",
    group: "業界",
    text: "あなたの業界でよくある迷いを一つ挙げ、そのお客様への返信を書いてください。",
  },
  {
    id: "company.case",
    group: "企業",
    text: "自社の公開済みの情報を一つ使って、検討中のお客様にご案内する返信を書いてください。",
  },
];
export function registerSales(app: Hono<AppEnv>) {
  app.get("/api/tenants/:tenantId/workspace", async (c) => {
    const rt = runtime(c),
      m = c.get("membership");
    requireThat(
      has(m, "sales", "team_admin", "org_owner"),
      403,
      "FORBIDDEN",
      "営業画面の閲覧権限がありません。",
    );
    const view = c.req.query("view") || "all";
    const customerView = view === "customers",
      includeMeetings = ["all", "dashboard", "meetings"].includes(view),
      includeAssets = view === "all",
      includeOutcomes = view === "all";
    const common = await rt.openDatabase(t(c), "", "common");
    const commonRows = await common.batch([
      { sql: "SELECT * FROM customers ORDER BY name" },
      {
        sql: "SELECT customer_id,oa_id FROM customer_links WHERE state='confirmed'",
      },
      ...(includeOutcomes
        ? [{ sql: "SELECT * FROM outcomes ORDER BY occurred_at DESC" }]
        : []),
    ]);
    const settings = parse(c.get("tenant").settings);
    const customers = commonRows[0].rows.filter((row) =>
      customerAccess(m, row, "read", settings),
    );
    const allowed = new Set(customers.map((x) => x.id));
    const linksByCustomer = new Map<string, string[]>();
    for (const link of commonRows[1].rows) {
      const list = linksByCustomer.get(link.customer_id) || [];
      list.push(link.oa_id);
      linksByCustomer.set(link.customer_id, list);
    }
    for (const row of customers)
      row.accounts = linksByCustomer.get(row.id) || [];
    const accounts = await all(
      rt.db,
      "SELECT a.id,a.name,a.state,a.owner_user_id,a.operators,a.team_id,(SELECT count(*) FROM databases d WHERE d.tenant_id=a.tenant_id AND d.oa_id=a.id AND d.state='ready') AS ready_count FROM accounts a WHERE a.tenant_id=?",
      [t(c)],
    );
    const visibleAccounts = accounts.filter(
      (a) =>
        has(m, "org_owner") ||
        (has(m, "team_admin") && parse(m.teams, []).includes(a.team_id)) ||
        a.owner_user_id === actor(c) ||
        parse(a.operators, []).includes(actor(c)) ||
        customers.some((row) => row.accounts.includes(a.id)),
    );
    const parts = await mapLimited(
      visibleAccounts.filter((a) => a.ready_count === 2),
      3,
      async (account) => {
        const [ts, h] = await Promise.all([
          rt.openDatabase(t(c), account.id, "tsunagu"),
          customerView ? null : rt.openDatabase(t(c), account.id, "harness"),
        ]);
        const ids = json([...allowed]);
        const ps = await all(
          ts,
          customerView
            ? "SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC,id DESC) AS customer_rank FROM proposals WHERE state='pending' AND customer_id IN (SELECT value FROM json_each(?))) WHERE customer_rank=1 ORDER BY created_at DESC"
            : "SELECT p.*,COALESCE(json_extract(a.evidence,'$.priority'),CASE WHEN p.trigger='assistant:reply' THEN 10 ELSE 30 END) AS assistant_priority FROM proposals p LEFT JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.customer_id IN (SELECT value FROM json_each(?)) ORDER BY p.created_at DESC LIMIT 500",
          [ids],
        );
        const [outbox, appointments, assets] = await Promise.all([
          !customerView && ps.length
            ? all(
                h!,
                "SELECT proposal_id,state,error_code,proposal_version FROM outbox WHERE proposal_id IN (SELECT value FROM json_each(?)) ORDER BY proposal_version DESC",
                [json(ps.map((p) => p.id))],
              )
            : [],
          includeMeetings
            ? all(
                h!,
                "SELECT * FROM appointments WHERE customer_id IN (SELECT value FROM json_each(?)) ORDER BY starts_at DESC LIMIT 500",
                [ids],
              )
            : [],
          includeAssets &&
          (has(m, "org_owner") ||
            (has(m, "team_admin") &&
              parse(m.teams, []).includes(account.team_id)) ||
            account.owner_user_id === actor(c) ||
            parse(account.operators, []).includes(actor(c)))
            ? all(ts, "SELECT * FROM assets ORDER BY updated_at DESC")
            : [],
        ]);
        const delivery = new Map<string, Row>();
        for (const row of outbox)
          if (!delivery.has(row.proposal_id))
            delivery.set(row.proposal_id, row);
        return {
          proposals: ps.map((p) => ({
            ...p,
            oa_id: account.id,
            oa_name: account.name,
            delivery: delivery.get(p.id) || null,
          })),
          appointments: appointments.map((p) => ({ ...p, oa_id: account.id })),
          assets: assets.map((p) => ({ ...p, oa_id: account.id })),
        };
      },
    );
    const proposals = parts
        .flatMap((p) => p.proposals)
        .sort(
          (a: Row, b: Row) =>
            (a.assistant_priority || 30) - (b.assistant_priority || 30) ||
            b.created_at.localeCompare(a.created_at),
        ),
      appointments = parts.flatMap((p) => p.appointments),
      assets = parts.flatMap((p) => p.assets);
    const outcomes = (commonRows[2]?.rows || []).filter((o) =>
      allowed.has(o.customer_id),
    );
    return c.json({
      tenant: { id: t(c), name: c.get("tenant").name },
      customers,
      accounts: accounts
        .filter(
          (a) =>
            has(m, "org_owner") ||
            (has(m, "team_admin") && parse(m.teams, []).includes(a.team_id)) ||
            a.owner_user_id === actor(c) ||
            parse(a.operators, []).includes(actor(c)) ||
            customers.some((row) => row.accounts.includes(a.id)),
        )
        .map((a) => ({ id: a.id, name: a.name, state: a.state })),
      proposals,
      appointments,
      assets,
      outcomes,
      roles: parse(m.roles, []),
      updatedAt: now(),
    });
  });
  app.get(
    "/api/tenants/:tenantId/accounts/:oaId/customers/:customerId",
    async (c) => {
      const row = await customer(c, c.req.param("customerId"));
      await linked(c, row.id);
      const rt = runtime(c),
        h = await rt.openDatabase(t(c), a(c), "harness"),
        ts = await rt.openDatabase(t(c), a(c), "tsunagu");
      const [messages, notes] = await Promise.all([
        all(
          h,
          "SELECT * FROM messages WHERE customer_id=? ORDER BY recorded_at DESC,id DESC LIMIT 500",
          [row.id],
        ),
        all(
          ts,
          "SELECT * FROM context_notes WHERE customer_id=? AND deleted_at IS NULL ORDER BY created_at DESC",
          [row.id],
        ),
      ]);
      return c.json({
        customer: row,
        messages: messages.reverse(),
        notes,
        canSend: customerAccess(
          c.get("membership"),
          row,
          "send",
          parse(c.get("tenant").settings),
        ),
      });
    },
  );
  app.patch("/api/tenants/:tenantId/customers/:customerId/mode", async (c) => {
    const b = z
      .object({
        mode: z.enum(["ai", "human", "stopped"]),
        version: z.number().int(),
      })
      .parse(await c.req.json());
    const row = await customer(c, c.req.param("customerId"), "edit");
    requireThat(
      !(row.stage === "won" && b.mode === "ai"),
      409,
      "CUSTOMER_WON",
      "契約済みの顧客に営業追客は再開できません。",
    );
    const rt = runtime(c),
      common = await rt.openDatabase(t(c), "", "common");
    const r = await common.query(
      "UPDATE customers SET mode=?,version=version+1 WHERE id=? AND version=?",
      [b.mode, row.id, b.version],
    );
    requireThat(
      r.changes,
      409,
      "VERSION_CONFLICT",
      "顧客の最新状態を確認してください。",
    );
    await holdCustomer(
      rt,
      t(c),
      row.id,
      "対応モードが変更されました。再確認してください。",
    );
    await audit(rt.db, actor(c), "customer.mode_changed", row.id, t(c), {
      mode: b.mode,
    });
    return c.json({ ok: true });
  });
  app.post("/api/tenants/:tenantId/accounts/:oaId/proposals", async (c) => {
    const b = z
      .object({
        customerId: z.string(),
        trigger: z.string().trim().min(1).max(100),
        reason: z.string().trim().min(1).max(2000),
        draft: z.string().trim().min(1).max(5000),
        assetId: z.string().nullable().default(null),
      })
      .strict()
      .parse(await c.req.json());
    const row = await customer(c, b.customerId, "edit");
    await linked(c, row.id);
    requireThat(
      row.stage !== "won" && row.mode !== "stopped",
      409,
      "PURSUIT_STOPPED",
      "追客を停止している顧客です。",
    );
    const rt = runtime(c),
      ts = await rt.openDatabase(t(c), a(c), "tsunagu"),
      h = await rt.openDatabase(t(c), a(c), "harness");
    const latest = await one(
      h,
      "SELECT recorded_at FROM messages WHERE customer_id=? ORDER BY recorded_at DESC LIMIT 1",
      [row.id],
    );
    const pid = id();
    await ts.query(
      "INSERT INTO proposals(id,customer_id,trigger,reason,draft,asset_id,customer_version,history_cursor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        pid,
        row.id,
        b.trigger,
        b.reason,
        b.draft,
        b.assetId,
        row.version,
        latest?.recorded_at ?? null,
        now(),
        now(),
      ],
    );
    await queueProposalNotice(rt, t(c), a(c), {
      proposalId: pid,
      customerName: row.name,
      draft: b.draft,
    });
    await audit(rt.db, actor(c), "proposal.created", pid, t(c), {
      source: "human",
    });
    return c.json({ id: pid }, 201);
  });
  app.patch(
    "/api/tenants/:tenantId/accounts/:oaId/proposals/:id",
    async (c) => {
      const b = z
        .object({
          version: z.number().int(),
          draft: z.string().trim().min(1).max(5000),
          assetId: z.string().nullable().default(null),
        })
        .strict()
        .parse(await c.req.json());
      const rt = runtime(c);
      await accountFor(rt, t(c), a(c));
      const ts = await rt.openDatabase(t(c), a(c), "tsunagu");
      const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [
        c.req.param("id"),
      ]);
      requireThat(p, 404, "NOT_FOUND", "提案が見つかりません。");
      ordinaryOnly(p);
      const row = await customer(c, p.customer_id, "edit");
      requireThat(
        !["sent", "sending", "uncertain"].includes(p.state),
        409,
        "ALREADY_SENT",
        "送信処理開始後の文面は変更できません。配送結果を確認してください。",
      );
      const h = await rt.openDatabase(t(c), a(c), "harness");
      const latest = await one(
        h,
        "SELECT recorded_at FROM messages WHERE customer_id=? ORDER BY recorded_at DESC LIMIT 1",
        [row.id],
      );
      // 意味変更の自動分類は未確定。初期実装は保存時に必ず承認を取り直す安全側の扱い。
      const result = await ts.query(
        "UPDATE proposals SET draft=?,asset_id=?,version=version+1,state='pending',approved_by=NULL,approved_version=NULL,customer_version=?,history_cursor=?,hold_reason=NULL,updated_at=? WHERE id=? AND version=? AND state NOT IN ('sent','sending','uncertain')",
        [
          b.draft,
          b.assetId,
          row.version,
          latest?.recorded_at ?? null,
          now(),
          p.id,
          b.version,
        ],
      );
      requireThat(
        result.changes,
        409,
        "VERSION_CONFLICT",
        "別の方が編集しました。最新の文面を確認してください。",
      );
      await ts.query(
        "INSERT INTO feedback(id,proposal_id,version,actor_id,action,original,final,at) VALUES (?,?,?,?,?,?,?,?)",
        [id(), p.id, p.version, actor(c), "edited", p.draft, b.draft, now()],
      );
      await adaptStyleFromFeedback(rt, t(c), a(c), actor(c)).catch(() => {});
      await h.query(
        "UPDATE outbox SET state='cancelled' WHERE proposal_id=? AND state IN ('pending','held')",
        [p.id],
      );
      return c.json({ ok: true });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/proposals/:id/approve",
    async (c) => {
      const b = z
        .object({
          version: z.number().int(),
          scheduledAt: z.string().datetime().optional(),
          send: z.boolean().default(false),
        })
        .strict()
        .parse(await c.req.json());
      const rt = runtime(c),
        oa = await accountFor(rt, t(c), a(c)),
        ts = await rt.openDatabase(t(c), a(c), "tsunagu"),
        h = await rt.openDatabase(t(c), a(c), "harness");
      const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [
        c.req.param("id"),
      ]);
      requireThat(p, 404, "NOT_FOUND", "提案が見つかりません。");
      ordinaryOnly(p);
      const row = await customer(c, p.customer_id, "approve");
      const link = await linked(c, row.id);
      if (b.send) {
        await customer(c, row.id, "send");
        requireThat(
          oa.owner_user_id === actor(c) ||
            parse(oa.operators, []).includes(actor(c)) ||
            parse(c.get("tenant").settings).proxySend === true,
          403,
          "OA_SEND_FORBIDDEN",
          "この公式LINEから送信する権限がありません。",
        );
        requireThat(
          oa.state === "ready",
          409,
          "OA_NOT_READY",
          "公式LINEの開通確認を完了してください。",
        );
        requireThat(
          await deliveryReady(rt, t(c), a(c)),
          409,
          "DELIVERY_NOT_CONNECTED",
          "Harnessの配送接続を確認してください。",
        );
      }
      const latestMsg = await one(
        h,
        "SELECT recorded_at FROM messages WHERE customer_id=? ORDER BY recorded_at DESC LIMIT 1",
        [row.id],
      );
      // 通常の確認待ち(pending)承認時は提案作成以降の顧客新着メッセージを検知し、
      // 保留中(held)からの承認時は人間が最新文脈を確認した上での承認として最新カーソルを適用する
      const proposalToCheck = {
        ...p,
        customer_version: row.version,
        history_cursor:
          p.state === "held"
            ? (latestMsg?.recorded_at ?? p.history_cursor)
            : p.history_cursor,
      };
      const reason = await guard(rt, t(c), a(c), proposalToCheck);
      requireThat(!reason, 409, "SEND_HELD", reason || "");
      requireThat(
        p.version === b.version &&
          ["pending", "approved", "held"].includes(p.state),
        409,
        "VERSION_CONFLICT",
        "最新の提案を確認してください。",
      );
      const scheduled = b.scheduledAt ?? now();
      requireThat(
        Date.parse(scheduled) > Date.now() - 60000,
        400,
        "INVALID_SCHEDULE",
        "送信日時は現在以降にしてください。",
      );
      const existing = await one(
        h,
        "SELECT * FROM outbox WHERE proposal_id=? AND proposal_version=?",
        [p.id, p.version],
      );
      if (existing) {
        requireThat(
          !b.scheduledAt || existing.scheduled_at === b.scheduledAt,
          409,
          "SCHEDULE_CHANGED",
          "送信予約済みです。変更時は保留して文面・日時を再確認してください。",
        );
        if (existing.state === "held") {
          await h.query(
            "UPDATE outbox SET state='pending',error_code=NULL,lease_until=NULL,scheduled_at=? WHERE id=?",
            [scheduled, existing.id],
          );
          await ts.query(
            "UPDATE proposals SET state='approved',approved_by=?,approved_version=version,scheduled_at=?,customer_version=?,history_cursor=?,hold_reason=NULL,updated_at=? WHERE id=? AND version=?",
            [
              actor(c),
              scheduled,
              row.version,
              latestMsg?.recorded_at ?? p.history_cursor,
              now(),
              p.id,
              b.version,
            ],
          );
        }
        if (
          b.send &&
          Date.parse(scheduled) <= Date.now() &&
          rt.deliveryEnabled
        ) {
          await sendDue(rt, t(c), a(c)).catch((e) =>
            console.error("sendDue error:", e),
          );
        }
        const updated = await one(h, "SELECT state FROM outbox WHERE id=?", [
          existing.id,
        ]);
        return c.json({
          ok: true,
          queued: ["pending", "sending", "sent"].includes(
            updated?.state || existing.state,
          ),
          state: updated?.state || existing.state,
        });
      }
      const result = await ts.query(
        "UPDATE proposals SET state='approved',approved_by=?,approved_version=version,scheduled_at=?,customer_version=?,history_cursor=?,hold_reason=NULL,updated_at=? WHERE id=? AND version=? AND state IN ('pending','approved','held')",
        [
          actor(c),
          scheduled,
          row.version,
          latestMsg?.recorded_at ?? p.history_cursor,
          now(),
          p.id,
          b.version,
        ],
      );
      requireThat(
        result.changes,
        409,
        "VERSION_CONFLICT",
        "提案の状態が変わりました。",
      );
      await ts.query(
        "INSERT OR IGNORE INTO proposal_versions(proposal_id,version,draft,asset_id,scheduled_at,actor_id,at) VALUES (?,?,?,?,?,?,?)",
        [p.id, p.version, p.draft, p.asset_id, scheduled, actor(c), now()],
      );
      await ts.query(
        "INSERT OR IGNORE INTO feedback(id,proposal_id,version,actor_id,action,final,at) VALUES (?,?,?,?,?,?,?)",
        [
          `approve:${p.id}:${p.version}`,
          p.id,
          p.version,
          actor(c),
          "approved",
          p.draft,
          now(),
        ],
      );
      await adaptStyleFromFeedback(rt, t(c), a(c), actor(c)).catch(() => {});
      if (b.send) {
        let messagePayload: any[] = [{ type: "text", text: p.draft }];
        if (p.asset_id) {
          const asset = await one(ts, "SELECT * FROM assets WHERE id=?", [
            p.asset_id,
          ]);
          requireThat(
            asset && asset.state === "published",
            409,
            "ASSET_NOT_PUBLISHED",
            "素材の公開状態をご確認ください。未公開または確認待ちの素材は送信できません。",
          );
          requireThat(
            !asset.expires_at || asset.expires_at > now(),
            409,
            "ASSET_EXPIRED",
            "素材の利用期限が切れています。",
          );
          const assetBody = parse(asset.body, {});
          if (asset.kind === "flex" && assetBody.contents) {
            messagePayload = [
              {
                type: "flex",
                altText: p.draft.slice(0, 40) || asset.title,
                contents: assetBody.contents,
              },
            ];
          } else if (asset.kind === "video") {
            messagePayload = [
              {
                type: "flex",
                altText: p.draft.slice(0, 40) || asset.title,
                contents: {
                  type: "bubble",
                  hero: assetBody.thumbnailUrl
                    ? {
                        type: "image",
                        url: assetBody.thumbnailUrl,
                        size: "full",
                        aspectRatio: "16:9",
                        aspectMode: "cover",
                      }
                    : undefined,
                  body: {
                    type: "box",
                    layout: "vertical",
                    spacing: "md",
                    contents: [
                      { type: "text", text: p.draft, wrap: true, size: "sm" },
                      {
                        type: "text",
                        text: asset.title,
                        weight: "bold",
                        size: "md",
                        wrap: true,
                      },
                    ],
                  },
                  footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [
                      {
                        type: "button",
                        style: "primary",
                        color: "#2563eb",
                        action: {
                          type: "uri",
                          label: "動画を視聴する",
                          uri: asset.url || "https://example.invalid",
                        },
                      },
                      {
                        type: "button",
                        style: "secondary",
                        action: {
                          type: "uri",
                          label: "1on1で相談する",
                          uri: `${asset.url || "https://example.invalid"}#booking`,
                        },
                      },
                    ],
                  },
                },
              },
            ];
          } else if (asset.kind === "lp" || asset.kind === "card") {
            messagePayload = [
              {
                type: "flex",
                altText: p.draft.slice(0, 40) || asset.title,
                contents: {
                  type: "bubble",
                  body: {
                    type: "box",
                    layout: "vertical",
                    spacing: "md",
                    contents: [
                      { type: "text", text: p.draft, wrap: true, size: "sm" },
                      { type: "separator" },
                      {
                        type: "text",
                        text: asset.title,
                        weight: "bold",
                        size: "md",
                        wrap: true,
                      },
                    ],
                  },
                  footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [
                      {
                        type: "button",
                        style: "primary",
                        color: "#2563eb",
                        action: {
                          type: "uri",
                          label: "詳細を見る",
                          uri: asset.url || "https://example.invalid",
                        },
                      },
                    ],
                  },
                },
              },
            ];
          }
        }
        await h.query(
          "INSERT OR IGNORE INTO outbox(id,customer_id,line_user_id,proposal_id,proposal_version,body,scheduled_at,retry_key) VALUES (?,?,?,?,?,?,?,?)",
          [
            `${p.id}:${p.version}`,
            row.id,
            link.line_user_id,
            p.id,
            p.version,
            json(messagePayload),
            scheduled,
            id(),
          ],
        );
        if (Date.parse(scheduled) <= Date.now() && rt.deliveryEnabled) {
          await sendDue(rt, t(c), a(c)).catch((e) =>
            console.error("sendDue error:", e),
          );
        }
      }
      await audit(
        rt.db,
        actor(c),
        b.send ? "proposal.queued" : "proposal.approved",
        p.id,
        t(c),
        { version: p.version },
      );
      return c.json({ ok: true, queued: b.send });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/proposals/bulk-approve",
    async (c) => {
      const rt = runtime(c),
        oa = await accountFor(rt, t(c), a(c)),
        ts = await rt.openDatabase(t(c), a(c), "tsunagu"),
        h = await rt.openDatabase(t(c), a(c), "harness");
      const b = z
        .object({
          proposals: z
            .array(z.object({ id: z.string(), version: z.number().int() }))
            .min(1)
            .max(50),
          mode: z.enum(["send_now", "schedule", "approve_only"]),
          scheduledAt: z.string().datetime().optional(),
        })
        .strict()
        .parse(await c.req.json());

      const shouldSend = b.mode === "send_now" || b.mode === "schedule";
      const scheduled =
        b.mode === "schedule" && b.scheduledAt ? b.scheduledAt : now();
      if (b.mode === "schedule" && b.scheduledAt) {
        requireThat(
          Date.parse(b.scheduledAt) > Date.now() - 60000,
          400,
          "INVALID_SCHEDULE",
          "送信日時は現在以降にしてください。",
        );
      }

      let approvedCount = 0;
      const failures: Array<{ id: string; reason: string }> = [];

      for (const item of b.proposals) {
        try {
          const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [
            item.id,
          ]);
          if (
            !p ||
            p.version !== item.version ||
            !["pending", "approved"].includes(p.state)
          ) {
            failures.push({
              id: item.id,
              reason: "提案が見つからないかバージョンが一致しません。",
            });
            continue;
          }
          ordinaryOnly(p);
          const row = await customer(c, p.customer_id, "approve");
          const link = await linked(c, row.id);
          const reason = await guard(rt, t(c), a(c), p);
          if (reason) {
            failures.push({ id: item.id, reason });
            continue;
          }
          if (shouldSend) {
            await customer(c, row.id, "send");
            if (p.asset_id) {
              const asset = await one(ts, "SELECT * FROM assets WHERE id=?", [
                p.asset_id,
              ]);
              if (
                !asset ||
                asset.state !== "published" ||
                (asset.expires_at && asset.expires_at <= now())
              ) {
                failures.push({
                  id: item.id,
                  reason: "素材の公開状態または利用期限を確認してください。",
                });
                continue;
              }
            }
          }

          await ts.query(
            "UPDATE proposals SET state='approved',approved_by=?,approved_version=version,scheduled_at=?,updated_at=? WHERE id=? AND version=?",
            [actor(c), scheduled, now(), p.id, item.version],
          );
          await ts.query(
            "INSERT OR IGNORE INTO proposal_versions(proposal_id,version,draft,asset_id,scheduled_at,actor_id,at) VALUES (?,?,?,?,?,?,?)",
            [
              p.id,
              item.version,
              p.draft,
              p.asset_id,
              scheduled,
              actor(c),
              now(),
            ],
          );
          if (shouldSend) {
            await h.query(
              "INSERT OR IGNORE INTO outbox(id,customer_id,line_user_id,proposal_id,proposal_version,body,scheduled_at,retry_key) VALUES (?,?,?,?,?,?,?,?)",
              [
                `${p.id}:${item.version}`,
                row.id,
                link.line_user_id,
                p.id,
                item.version,
                json([{ type: "text", text: p.draft }]),
                scheduled,
                id(),
              ],
            );
          }
          approvedCount++;
        } catch (e: any) {
          failures.push({
            id: item.id,
            reason: e.message || "承認に失敗しました。",
          });
        }
      }
      if (shouldSend && b.mode === "send_now" && rt.deliveryEnabled) {
        await sendDue(rt, t(c), a(c)).catch((e) =>
          console.error("sendDue error in bulk-approve:", e),
        );
      }

      await audit(rt.db, actor(c), "proposals.bulk_approved", a(c), t(c), {
        approved: approvedCount,
        failed: failures.length,
        mode: b.mode,
      });

      return c.json({ ok: true, approvedCount, failures });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/outbox/:id/reconcile",
    async (c) => {
      const rt = runtime(c),
        h = await rt.openDatabase(t(c), a(c), "harness"),
        ts = await rt.openDatabase(t(c), a(c), "tsunagu");
      const outboxItem = await one(h, "SELECT * FROM outbox WHERE id=?", [
        c.req.param("id"),
      ]);
      requireThat(outboxItem, 404, "NOT_FOUND", "送信記録が見つかりません。");
      await accountFor(rt, t(c), a(c));
      await customer(c, outboxItem.customer_id, "send");
      requireThat(
        outboxItem.state === "uncertain",
        409,
        "RECONCILE_STATE",
        "配送結果が不明な記録だけ照合できます。",
      );
      const b = z
        .object({
          action: z.enum(["mark_sent", "resend", "cancel"]),
          note: z.string().max(500).optional(),
        })
        .strict()
        .parse(await c.req.json());

      if (b.action === "resend" && outboxItem.proposal_id) {
        const proposal = await one(ts, "SELECT * FROM proposals WHERE id=?", [
          outboxItem.proposal_id,
        ]);
        if (proposal) ordinaryOnly(proposal);
      }
      if (b.action === "mark_sent") {
        await h.query(
          "UPDATE outbox SET state='sent',accepted_at=?,lease_until=NULL,error_code=NULL WHERE id=?",
          [now(), outboxItem.id],
        );
        if (outboxItem.proposal_id) {
          await ts.query(
            "UPDATE proposals SET state='sent',updated_at=? WHERE id=?",
            [now(), outboxItem.proposal_id],
          );
        }
        await h.query(
          "INSERT OR IGNORE INTO messages(id,customer_id,line_user_id,direction,source,actor_id,body,kind,external_id,state,occurred_at,recorded_at) VALUES (?,?,?,'outbound','manual_reconcile',?,?,'text',?,'sent',?,?)",
          [
            `reconcile:${outboxItem.id}`,
            outboxItem.customer_id,
            outboxItem.line_user_id,
            actor(c),
            b.note || "手動照合により送信完了を確認",
            `reconcile:${outboxItem.id}`,
            now(),
            now(),
          ],
        );
        await rt.db.query(
          "INSERT OR IGNORE INTO usage_events(id,tenant_id,oa_id,kind,units,provider,state,occurred_at) VALUES (?,?,?,'message',1,'harness','accepted',?)",
          [`reconcile:${a(c)}:${outboxItem.id}`, t(c), a(c), now()],
        );
      } else if (b.action === "resend") {
        await h.query(
          "UPDATE outbox SET state='pending',attempts=0,lease_until=NULL,error_code=NULL WHERE id=?",
          [outboxItem.id],
        );
        if (outboxItem.proposal_id) {
          await ts.query(
            "UPDATE proposals SET state='approved',hold_reason=NULL WHERE id=?",
            [outboxItem.proposal_id],
          );
        }
      } else if (b.action === "cancel") {
        await h.query(
          "UPDATE outbox SET state='cancelled',error_code='CANCELLED_BY_HUMAN',lease_until=NULL WHERE id=?",
          [outboxItem.id],
        );
        if (outboxItem.proposal_id) {
          await ts.query(
            "UPDATE proposals SET state='held',hold_reason=? WHERE id=?",
            [b.note || "手動で送信を取り消しました。", outboxItem.proposal_id],
          );
        }
      }
      await audit(rt.db, actor(c), "outbox.reconciled", outboxItem.id, t(c), {
        action: b.action,
        note: b.note,
      });
      return c.json({ ok: true, action: b.action });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/appointments/calendar-sync",
    async (c) => {
      const rt = runtime(c);
      await accountFor(rt, t(c), a(c));
      const b = z
        .object({
          externalId: z.string().min(1),
          title: z.string().min(1),
          startsAt: z.string().datetime(),
          endsAt: z.string().datetime().optional(),
          attendeeEmail: z.string().email().optional(),
          attendeeName: z.string().optional(),
        })
        .strict()
        .parse(await c.req.json());

      const { correlateCalendarEvent } = await import("./booking.ts");
      const result = await correlateCalendarEvent(rt, t(c), a(c), {
        ...b,
        actorUserId: actor(c),
      });
      return c.json(result);
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/proposals/:id/hold",
    async (c) => {
      const rt = runtime(c);
      await accountFor(rt, t(c), a(c));
      const ts = await rt.openDatabase(t(c), a(c), "tsunagu");
      const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [
        c.req.param("id"),
      ]);
      requireThat(p, 404, "NOT_FOUND", "提案がありません。");
      await customer(c, p.customer_id, "approve");
      const b = z
        .object({ reason: z.string().trim().min(1).max(500) })
        .parse(await c.req.json());
      const held = await ts.query(
        "UPDATE proposals SET state='held',hold_reason=? WHERE id=? AND state IN ('pending','approved','held')",
        [b.reason, p.id],
      );
      requireThat(
        held.changes,
        409,
        "DELIVERY_ALREADY_STARTED",
        "送信処理が始まっています。配送結果を確認してください。",
      );
      const h = await rt.openDatabase(t(c), a(c), "harness");
      await h.query(
        "UPDATE outbox SET state='held',error_code='HUMAN_HOLD' WHERE proposal_id=? AND state='pending'",
        [p.id],
      );
      await audit(rt.db, actor(c), "proposal.held", p.id, t(c));
      return c.json({ ok: true });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/proposals/:id/resume",
    async (c) => {
      const rt = runtime(c);
      await accountFor(rt, t(c), a(c));
      const ts = await rt.openDatabase(t(c), a(c), "tsunagu"),
        h = await rt.openDatabase(t(c), a(c), "harness");
      const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [
        c.req.param("id"),
      ]);
      requireThat(p, 404, "NOT_FOUND", "提案がありません。");
      ordinaryOnly(p);
      const row = await customer(c, p.customer_id, "approve");
      const latest = await one(
        h,
        "SELECT recorded_at FROM messages WHERE customer_id=? ORDER BY recorded_at DESC LIMIT 1",
        [row.id],
      );
      const result = await ts.query(
        "UPDATE proposals SET state='pending',hold_reason=NULL,customer_version=?,history_cursor=?,updated_at=? WHERE id=? AND state='held'",
        [row.version, latest?.recorded_at ?? p.history_cursor, now(), p.id],
      );
      requireThat(
        result.changes,
        409,
        "NOT_HELD",
        "保留中の提案のみ再開できます。",
      );
      await h.query(
        "UPDATE outbox SET state='pending',error_code=NULL,lease_until=NULL WHERE proposal_id=? AND state='held'",
        [p.id],
      );
      await audit(rt.db, actor(c), "proposal.resumed", p.id, t(c));
      return c.json({ ok: true });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/proposals/bulk-resume",
    async (c) => {
      const rt = runtime(c);
      await accountFor(rt, t(c), a(c));
      const ts = await rt.openDatabase(t(c), a(c), "tsunagu"),
        h = await rt.openDatabase(t(c), a(c), "harness"),
        common = await rt.openDatabase(t(c), "", "common");
      const b = z
        .object({
          proposalIds: z.array(z.string().min(1)).optional(),
        })
        .parse(await c.req.json().catch(() => ({})));
      const rows = b.proposalIds?.length
        ? await all(
            ts,
            `SELECT id, customer_id, history_cursor FROM proposals WHERE trigger NOT LIKE 'assistant:%' AND state='held' AND id IN (${b.proposalIds.map(() => "?").join(",")})`,
            b.proposalIds,
          )
        : await all(
            ts,
            "SELECT id, customer_id, history_cursor FROM proposals WHERE trigger NOT LIKE 'assistant:%' AND state='held'",
          );
      let resumed = 0;
      for (const row of rows) {
        const cust = await one(
          common,
          "SELECT version FROM customers WHERE id=?",
          [row.customer_id],
        );
        const latest = await one(
          h,
          "SELECT recorded_at FROM messages WHERE customer_id=? ORDER BY recorded_at DESC LIMIT 1",
          [row.customer_id],
        );
        const res = await ts.query(
          "UPDATE proposals SET state='pending',hold_reason=NULL,customer_version=?,history_cursor=?,updated_at=? WHERE id=? AND state='held'",
          [
            cust?.version ?? 1,
            latest?.recorded_at ?? row.history_cursor,
            now(),
            row.id,
          ],
        );
        if (res.changes) {
          resumed++;
          await h.query(
            "UPDATE outbox SET state='pending',error_code=NULL,lease_until=NULL WHERE proposal_id=? AND state='held'",
            [row.id],
          );
        }
      }
      await audit(rt.db, actor(c), "proposal.bulk_resumed", a(c), t(c), {
        count: resumed,
      });
      return c.json({ ok: true, count: resumed });
    },
  );
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/meetings/:id/result",
    async (c) => {
      const b = z
        .object({
          version: z.number().int(),
          state: z.enum(["attended", "cancelled", "no_show"]),
          deal: z.enum(["uncontracted", "won", "unknown"]),
          note: z.string().max(10000),
          mode: z.enum(["ai", "human", "stopped"]).optional(),
        })
        .strict()
        .parse(await c.req.json());
      const rt = runtime(c);
      await accountFor(rt, t(c), a(c));
      const h = await rt.openDatabase(t(c), a(c), "harness"),
        ts = await rt.openDatabase(t(c), a(c), "tsunagu"),
        common = await rt.openDatabase(t(c), "", "common");
      const meeting = await one(h, "SELECT * FROM appointments WHERE id=?", [
        c.req.param("id"),
      ]);
      requireThat(meeting, 404, "NOT_FOUND", "面談が見つかりません。");
      const row = await customer(c, meeting.customer_id, "edit");
      const eventId = `meeting:${a(c)}:${meeting.id}:${b.version + 1}`;
      const results = await h.batch([
        {
          sql: "INSERT OR IGNORE INTO events(id,customer_id,type,payload,occurred_at) SELECT ?,?,'meeting.result',?,? FROM appointments WHERE id=? AND version=?",
          params: [
            eventId,
            row.id,
            json({
              ...b,
              version: b.version + 1,
              meetingId: meeting.id,
              actor: actor(c),
            }),
            now(),
            meeting.id,
            b.version,
          ],
        },
        {
          sql: "UPDATE appointments SET state=?,version=version+1 WHERE id=? AND version=?",
          params: [b.state, meeting.id, b.version],
        },
      ]);
      requireThat(
        results[1].changes,
        409,
        "VERSION_CONFLICT",
        "面談結果が更新されています。最新内容をご確認ください。",
      );
      await applyMeetingResult(rt, t(c), a(c), eventId);
      await audit(rt.db, actor(c), "meeting.confirmed", meeting.id, t(c), {
        state: b.state,
        deal: b.deal,
      });
      return c.json({ ok: true });
    },
  );
  app.post("/api/tenants/:tenantId/accounts/:oaId/notes", async (c) => {
    const b = z
      .object({
        customerId: z.string(),
        body: z.string().trim().min(1).max(10000),
      })
      .strict()
      .parse(await c.req.json());
    await customer(c, b.customerId, "edit");
    await linked(c, b.customerId);
    const rt = runtime(c),
      ts = await rt.openDatabase(t(c), a(c), "tsunagu");
    const nid = id();
    const common = await rt.openDatabase(t(c), "", "common");
    await common.query("UPDATE customers SET version=version+1 WHERE id=?", [
      b.customerId,
    ]);
    await ts.query(
      "INSERT INTO context_notes(id,customer_id,source,body,confirmed_by,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?)",
      [nid, b.customerId, "manual", b.body, actor(c), now(), now()],
    );
    await holdCustomer(
      rt,
      t(c),
      b.customerId,
      "新しい確認済みのメモがあります。",
    );
    return c.json({ id: nid }, 201);
  });
  app.get("/api/tenants/:tenantId/accounts/:oaId/style", async (c) => {
    const oa = await accountFor(runtime(c), t(c), a(c));
    requireThat(
      has(c.get("membership"), "sales", "sys_admin", "org_owner") &&
        (has(c.get("membership"), "sys_admin", "org_owner") ||
          oa.owner_user_id === actor(c) ||
          parse(oa.operators, []).includes(actor(c))),
      403,
      "FORBIDDEN",
      "文体設定の権限がありません。",
    );
    const ts = await runtime(c).openDatabase(t(c), a(c), "tsunagu");
    const calib = await getAccountCalibrationProfile(runtime(c), t(c), a(c));

    const operatorIds = Array.from(
      new Set([oa.owner_user_id, ...parse(oa.operators, [])].filter(Boolean)),
    ) as string[];

    const users = operatorIds.length
      ? await all(
          runtime(c).db,
          `SELECT id, name, email FROM user WHERE id IN (${operatorIds.map(() => "?").join(",")})`,
          operatorIds,
        )
      : [];

    const allProfiles = operatorIds.length
      ? await all(
          ts,
          `SELECT user_id, answers, features, state, version, updated_at FROM style_profiles WHERE user_id IN (${operatorIds.map(() => "?").join(",")})`,
          operatorIds,
        )
      : [];

    const operators = operatorIds.map((uid) => {
      const u = users.find((x) => x.id === uid);
      const prof = allProfiles.find((x) => x.user_id === uid);
      const answers = prof ? parse(prof.answers, {}) : {};
      const hasCalibration =
        prof?.state === "active" || Object.keys(answers).length >= 5;
      return {
        id: uid,
        name: u?.name || (u?.email ? u.email.split("@")[0] : uid),
        email: u?.email || "",
        isOwner: uid === oa.owner_user_id,
        isPrimary: uid === calib.primaryUserId,
        hasCalibration,
        state: prof?.state || "none",
        answeredCount: Object.keys(answers).length,
        updatedAt: prof?.updated_at || null,
      };
    });

    const requestedUserId = c.req.query("userId");
    const targetUserId = requestedUserId || calib.primaryUserId || actor(c);
    const targetProfileRow = allProfiles.find(
      (p) => p.user_id === targetUserId,
    );
    const myProfileRow = allProfiles.find((p) => p.user_id === actor(c));

    const targetProfile = targetProfileRow
      ? {
          ...targetProfileRow,
          answers: parse(targetProfileRow.answers, {}),
          features: parse(targetProfileRow.features, {}),
        }
      : requestedUserId
        ? {
            user_id: requestedUserId,
            answers: {},
            features: {},
            state: "none",
            version: 1,
            updated_at: null,
          }
        : null;

    const myProfile = myProfileRow
      ? {
          ...myProfileRow,
          answers: parse(myProfileRow.answers, {}),
          features: parse(myProfileRow.features, {}),
        }
      : null;

    return c.json({
      questions: calibrationQuestions,
      primaryUserId: calib.primaryUserId,
      operators,
      profile: targetProfile || calib.profile || myProfile,
      myProfile,
      learningStats: {
        revisionsCount: calib.recentRevisions.length,
        recentRevisions: calib.recentRevisions,
        feedbackSampleCount:
          calib.profile?.features?.learnedAdjustment?.feedbackSampleCount ||
          calib.recentRevisions.length,
        toneAdjustment:
          calib.profile?.features?.learnedAdjustment?.toneAdjustment ||
          "neutral",
        categoryStats: calib.categoryStats || {},
        primaryUserName: operators.find((o) => o.isPrimary)?.name || "担当者",
      },
    });
  });
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/style/priority",
    async (c) => {
      const rt = runtime(c),
        oa = await accountFor(rt, t(c), a(c));
      requireThat(
        oa.owner_user_id === actor(c) ||
          parse(oa.operators, []).includes(actor(c)),
        403,
        "FORBIDDEN",
        "公式LINEの操作権限を持つ担当者のみ設定できます。",
      );
      const b = z
        .object({ userId: z.string() })
        .strict()
        .parse(await c.req.json());
      const operatorIds = [oa.owner_user_id, ...parse(oa.operators, [])].filter(
        Boolean,
      );
      requireThat(
        operatorIds.includes(b.userId),
        400,
        "INVALID_OPERATOR",
        "公式LINEの操作権限を持つ担当者を指定してください。",
      );
      await rt.db.query(
        "UPDATE accounts SET primary_calibration_user_id=? WHERE id=?",
        [b.userId, oa.id],
      );
      const ts = await rt.openDatabase(t(c), a(c), "tsunagu");
      const prof = await one(
        ts,
        "SELECT state FROM style_profiles WHERE user_id=?",
        [b.userId],
      );
      if (prof?.state === "active") {
        await rt.db.query(
          "UPDATE accounts SET calibration_ready=1 WHERE id=?",
          [oa.id],
        );
      }
      await audit(rt.db, actor(c), "style.priority_updated", oa.id, t(c), {
        primaryUserId: b.userId,
      });
      return c.json({ ok: true, primaryUserId: b.userId });
    },
  );
  app.post("/api/tenants/:tenantId/accounts/:oaId/style", async (c) => {
    const oa = await accountFor(runtime(c), t(c), a(c));
    requireThat(
      oa.owner_user_id === actor(c) ||
        parse(oa.operators, []).includes(actor(c)),
      403,
      "FORBIDDEN",
      "本人の公式LINEの文体を設定してください。",
    );
    const b = z
      .object({
        userId: z.string().optional(),
        answers: z.record(z.string(), z.string().max(3000)),
        confirm: z.boolean(),
      })
      .strict()
      .parse(await c.req.json());
    const targetUserId = b.userId || actor(c);
    const operatorIds = [oa.owner_user_id, ...parse(oa.operators, [])].filter(
      Boolean,
    );
    requireThat(
      operatorIds.includes(targetUserId),
      400,
      "INVALID_OPERATOR",
      "公式LINEの操作権限を持つ担当者を指定してください。",
    );
    if (b.confirm)
      requireThat(
        calibrationQuestions.every(
          (q) => (b.answers[q.id] ?? "").trim().length >= 15,
        ),
        400,
        "ANSWERS_REQUIRED",
        "すべての設問へ普段の言葉で回答してください。",
      );
    const values = Object.values(b.answers).filter(Boolean);
    const features = {
      averageLength: values.length
        ? Math.round(values.reduce((n, s) => n + s.length, 0) / values.length)
        : 0,
      usesEmoji: values.some((s) => /\p{Extended_Pictographic}/u.test(s)),
      source: "self_confirmed_answers",
    };
    const ts = await runtime(c).openDatabase(t(c), a(c), "tsunagu");
    await ts.query(
      "INSERT INTO style_profiles(user_id,answers,features,state,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET answers=excluded.answers,features=excluded.features,state=excluded.state,version=version+1,updated_at=excluded.updated_at",
      [
        targetUserId,
        json(b.answers),
        json(features),
        b.confirm ? "active" : "draft",
        now(),
      ],
    );
    if (b.confirm) {
      if (
        oa.owner_user_id === targetUserId ||
        oa.primary_calibration_user_id === targetUserId ||
        !oa.primary_calibration_user_id
      ) {
        await runtime(c).db.query(
          "UPDATE accounts SET calibration_ready=1 WHERE id=?",
          [oa.id],
        );
      }
      await adaptStyleFromFeedback(runtime(c), t(c), a(c), targetUserId).catch(
        () => {},
      );
    }
    return c.json({ ok: true, features });
  });
  app.get("/api/tenants/:tenantId/connections", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    return c.json({
      connections: await all(
        runtime(c).db,
        "SELECT id,oa_id,service,state,config,last_sync_at,last_error FROM connections WHERE tenant_id=?",
        [t(c)],
      ),
      services: [
        "harness",
        "google_sheets",
        "google_drive",
        "google_calendar",
        "timerex",
      ],
    });
  });
  app.post("/api/tenants/:tenantId/connections", async (c) => {
    requireRoles(c, "sys_admin", "org_owner");
    const b = z
      .object({
        oaId: z.string(),
        service: z.enum([
          "harness",
          "google_sheets",
          "google_drive",
          "google_calendar",
          "timerex",
        ]),
        resource: z.string().max(500).default(""),
      })
      .strict()
      .parse(await c.req.json());
    await accountFor(runtime(c), t(c), b.oaId);
    await runtime(c).db.query(
      "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES (?,?,?,?,'setup',?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET config=excluded.config,state='setup'",
      [id(), t(c), b.oaId, b.service, json({ resource: b.resource })],
    );
    return c.json({ ok: true, state: "setup" });
  });
}
export async function holdCustomer(
  rt: Runtime,
  tenant: string,
  customerId: string,
  reason: string,
) {
  const accounts = await all(
    rt.db,
    "SELECT id FROM accounts WHERE tenant_id=?",
    [tenant],
  );
  for (const a of accounts) {
    const ready = await one(
      rt.db,
      "SELECT count(*) AS n FROM databases WHERE tenant_id=? AND oa_id=? AND state='ready'",
      [tenant, a.id],
    );
    if (ready?.n !== 2) continue;
    const ts = await rt.openDatabase(tenant, a.id, "tsunagu"),
      h = await rt.openDatabase(tenant, a.id, "harness");
    await ts.query(
      "UPDATE proposals SET state='held',hold_reason=?,updated_at=? WHERE customer_id=? AND state IN ('approved','pending')",
      [reason, now(), customerId],
    );
    await h.query(
      "UPDATE outbox SET state='held',error_code='CONTEXT_CHANGED' WHERE customer_id=? AND kind='sales' AND state='pending'",
      [customerId],
    );
  }
}
export async function guard(
  rt: Runtime,
  tenant: string,
  oa: string,
  proposal: Row,
): Promise<string | null> {
  const assistantReason = await assistantGuard(rt, tenant, oa, proposal);
  if (assistantReason) return assistantReason;
  const common = await rt.openDatabase(tenant, "", "common"),
    ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    h = await rt.openDatabase(tenant, oa, "harness");
  const row = await one(common, "SELECT * FROM customers WHERE id=?", [
    proposal.customer_id,
  ]);
  if (!row) return "顧客データが存在しないため送信を停止しました。";
  if (row.opt_out)
    return "顧客がLINE配信停止（オプトアウト）に設定されているため保留しました。";
  if (row.mode !== "ai")
    return `顧客の対応モードが手動（${row.mode}）に設定されているため保留しました。`;
  if (row.stage === "won") return "顧客が成約済み（won）のため保留しました。";
  if (row.stage === "booked")
    return "顧客の次回アポイントメント（予約）が既に確定しているため保留しました。";
  if (
    row.stage === "result_pending" &&
    proposal.trigger !== "assistant:followup"
  )
    return "直近の面談結果の反映待ちのため保留しました。";
  if (row.version !== proposal.customer_version)
    return "提案作成後に顧客の担当者またはステータスが更新されたため保留しました。";
  const pendingResult = await one(
    h,
    "SELECT id FROM events WHERE customer_id=? AND type='meeting.result' AND state='pending' LIMIT 1",
    [row.id],
  );
  if (pendingResult)
    return "面談結果の反映中です。完了後に内容をご確認ください。";

  // 顧客からの新しい受信（inbound）メッセージがあるかチェック（自社からの送信や過去ログ同期では誤保留しない）
  if (proposal.history_cursor) {
    const newInbound = await one(
      h,
      "SELECT id, body, occurred_at FROM messages WHERE customer_id=? AND direction='inbound' AND recorded_at > ? ORDER BY recorded_at DESC LIMIT 1",
      [row.id, proposal.history_cursor],
    );
    if (newInbound) {
      const snippet = String(newInbound.body || "")
        .replace(/\n/g, " ")
        .slice(0, 30);
      return `提案作成後に顧客から新着メッセージ「${snippet}${snippet.length >= 30 ? "..." : ""}」が届いたため保留しました。`;
    }
  }

  if (proposal.asset_id) {
    const asset = await one(ts, "SELECT * FROM assets WHERE id=?", [
      proposal.asset_id,
    ]);
    if (!asset || asset.state !== "published")
      return "添付素材が非公開または削除されているため保留しました。";
    if (asset.expires_at && asset.expires_at <= now())
      return "添付素材の利用期限が切れているため保留しました。";
  }
  return null;
}
