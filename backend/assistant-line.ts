import { demoStaffAllowed } from "./self-demo-access.ts";
import {
  notifyAssistant,
  notificationPreferences,
  notificationPreferencesSchema,
  retryAssistantNotice,
} from "./assistant-notifications.ts";
export { notifyAssistant };
import { rewriteAssistant } from "./assistant-rewrite.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { all, one, now, id, json, parse, type Row } from "./db.ts";
import { requireThat, digest, verify, audit, AppError } from "./security.ts";
import { member, has } from "./access.ts";
import type { AppEnv, Runtime } from "./runtime.ts";
import {
  assistantAccess,
  assistantGuard,
  approveAssistant,
  decideAssistant,
  editAssistant,
} from "./assistant.ts";
const until = (ms: number) => new Date(Date.now() + ms).toISOString();
const random = () => id().replaceAll("-", "") + id().replaceAll("-", "");
export async function staffLineReady(rt: Runtime) {
  const conf = rt.assistantLine;
  if (
    !conf?.enabled ||
    !conf.secret ||
    !conf.token ||
    !/^U[0-9a-f]{32}$/.test(conf.destination)
  )
    return false;
  // 同じOAを顧客向けにも使う構成は禁止。担当者userIdを顧客に自動転用しない。
  return !(await one(rt.db, "SELECT id FROM accounts WHERE destination=?", [
    conf.destination,
  ]));
}
async function lineRequest(
  rt: Runtime,
  path: string,
  body: Row,
  retry?: string,
) {
  requireThat(
    await staffLineReady(rt),
    503,
    "STAFF_LINE_NOT_CONNECTED",
    "担当者用LINEは未接続です。",
  );
  const r = await rt.externalFetch(
    `https://api.line.me/v2/bot/message/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rt.assistantLine!.token}`,
        "Content-Type": "application/json",
        ...(retry ? { "X-Line-Retry-Key": retry } : {}),
      },
      body: json(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  requireThat(
    r.ok || (r.status === 409 && !!r.headers.get("x-line-accepted-request-id")),
    502,
    "STAFF_LINE_FAILED",
    "LINEの送信結果を確認できません。",
  );
}
async function reply(
  rt: Runtime,
  replyToken: string | undefined,
  text: string,
) {
  if (replyToken)
    await lineRequest(rt, "reply", {
      replyToken,
      messages: [{ type: "text", text }],
    });
}
export function assistantCard(
  rt: Runtime,
  notice: Row,
  p: Row,
  customer: Row,
  oa: Row,
) {
  const uri = `${rt.origin}/sales?assistant=${encodeURIComponent(p.id)}&oa=${encodeURIComponent(oa.id)}&tenant=${encodeURIComponent(notice.tenant_id)}`;
  const evidence = parse(p.evidence),
    context =
      evidence.industry === "recruitment"
        ? `希望求人：${String(evidence.jobWish || "未確認").slice(0, 150)}\n転職希望時期：${String(evidence.jobChangeTiming || "未確認").slice(0, 150)}${evidence.promise ? `\n次回の連絡：約束「${String(evidence.promise).slice(0, 100)}」` : ""}`
        : evidence.condition || evidence.promise
          ? `確認した条件：${String(evidence.condition || evidence.promise).slice(0, 300)}`
          : evidence.noteBody
            ? `商談メモ：${String(evidence.noteBody).slice(0, 300)}`
            : "";
  const dates = evidence.url
    ? `公開：${evidence.publishedAt}\n出来事：${evidence.eventAt || "出典で未確認"}`
    : "";
  const button = (label: string, action: string) => ({
    type: "button",
    action: {
      type: "postback",
      label,
      data: `assistant:${notice.id}:${action}`,
    },
  });
  return {
    type: "flex",
    altText: `${customer.name}さんへのご連絡案`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `${customer.name}さんへ`,
            weight: "bold",
            size: "lg",
            wrap: true,
          },
          {
            type: "text",
            text: `送信元：${oa.name} · 版 ${p.version}`,
            size: "xs",
            color: "#666666",
            wrap: true,
          },
          { type: "text", text: p.reason, wrap: true, size: "sm" },
          ...(context
            ? [
                {
                  type: "text",
                  text: context,
                  wrap: true,
                  size: "xs",
                  color: "#666666",
                },
              ]
            : []),
          ...(dates
            ? [
                {
                  type: "text",
                  text: dates,
                  wrap: true,
                  size: "xs",
                  color: "#666666",
                },
              ]
            : []),
          { type: "separator" },
          {
            type: "text",
            text:
              evidence.draftDetail ||
              "参考テンプレートです。内容を確認・編集してください。",
            wrap: true,
            size: "xs",
            color: "#666666",
          },
          { type: "text", text: p.draft, wrap: true, size: "sm" },
          {
            type: "text",
            text: `有効期限：${new Date(p.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（日本時間）`,
            wrap: true,
            size: "xs",
            color: "#666666",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          button("この文面を送る", "approve"),
          button("文案の修正を依頼", "edit"),
          {
            type: "button",
            action: { type: "uri", label: "文面・根拠を確認 / 修正", uri },
          },
          button("見送り", "cancel"),
          button("あとで（4時間）", "later"),
        ],
      },
    },
  };
}
async function replyProposalCard(
  rt: Runtime,
  binding: Row,
  notice: Row,
  replyToken: string,
) {
  const ts = await rt.openDatabase(notice.tenant_id, notice.oa_id, "tsunagu"),
    p = await one(
      ts,
      "SELECT p.*,a.evidence,a.expires_at FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?",
      [notice.proposal_id],
    );
  requireThat(p, 404, "NOT_FOUND", "提案が見つかりません。");
  const access = await assistantAccess(
    rt,
    notice.tenant_id,
    notice.oa_id,
    binding.user_id,
    p.customer_id,
    "read",
  );
  const reason = await assistantGuard(rt, notice.tenant_id, notice.oa_id, p);
  requireThat(!reason, 409, "REVIEW_REQUIRED", reason || "");
  requireThat(
    await one(
      rt.db,
      "SELECT user_id FROM staff_line_links WHERE tenant_id=? AND user_id=? AND line_user_id=? AND destination=? AND state='active'",
      [
        binding.tenant_id,
        binding.user_id,
        binding.line_user_id,
        binding.destination,
      ],
    ),
    403,
    "LINK_REVOKED",
    "担当者LINEの連携が解除されています。",
  );
  await rt.db.query(
    "INSERT OR IGNORE INTO staff_line_notices(id,tenant_id,oa_id,user_id,destination,line_user_id,proposal_id,version,draft_hash,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sending',?)",
    [
      id(),
      notice.tenant_id,
      notice.oa_id,
      binding.user_id,
      binding.destination,
      binding.line_user_id,
      p.id,
      p.version,
      await digest(p.draft),
      now(),
    ],
  );
  const updated = (await one(
    rt.db,
    "SELECT * FROM staff_line_notices WHERE tenant_id=? AND oa_id=? AND user_id=? AND proposal_id=? AND version=?",
    [notice.tenant_id, notice.oa_id, binding.user_id, p.id, p.version],
  ))!;
  try {
    await lineRequest(rt, "reply", {
      replyToken,
      messages: [assistantCard(rt, updated, p, access.customer!, access.oa)],
    });
    await rt.db.query("UPDATE staff_line_notices SET state='sent' WHERE id=?", [
      updated.id,
    ]);
  } catch (e) {
    await rt.db.query(
      "UPDATE staff_line_notices SET state='uncertain' WHERE id=?",
      [updated.id],
    );
    throw e;
  }
}
export function registerAssistantLineWebhook(app: Hono<AppEnv>) {
  app.post("/webhooks/staff-line", async (c) => {
    const rt = c.env.runtime;
    requireThat(
      await staffLineReady(rt),
      503,
      "STAFF_LINE_NOT_CONNECTED",
      "担当者用LINEは未接続です。",
    );
    const raw = await c.req.text();
    requireThat(
      await verify(
        rt.assistantLine!.secret,
        raw,
        c.req.header("x-line-signature") || "",
      ),
      401,
      "INVALID_SIGNATURE",
      "Invalid signature",
    );
    const payload = z
      .object({
        destination: z.string(),
        events: z
          .array(
            z.object({
              webhookEventId: z.string().max(200),
              timestamp: z.number(),
              type: z.string(),
              replyToken: z.string().optional(),
              source: z
                .object({ type: z.string(), userId: z.string().optional() })
                .optional(),
              message: z
                .object({
                  type: z.string(),
                  text: z.string().max(5000).optional(),
                })
                .optional(),
              postback: z.object({ data: z.string().max(300) }).optional(),
            }),
          )
          .max(100),
      })
      .parse(JSON.parse(raw));
    requireThat(
      payload.destination === rt.assistantLine!.destination,
      401,
      "WRONG_DESTINATION",
      "Invalid destination",
    );
    for (const event of payload.events) {
      if (
        event.source?.type !== "user" ||
        !event.source.userId ||
        (rt.staffLineTestScope &&
          !rt.staffLineTestScope.lineUserIds.includes(event.source.userId) &&
          !await demoStaffAllowed(rt,event.source.userId,event.message?.text)) ||
        Math.abs(Date.now() - event.timestamp) > 5 * 60000
      )
        continue;
      const claim = await rt.db.query(
        "INSERT OR IGNORE INTO staff_line_events(id,at) VALUES (?,?) RETURNING id",
        [`${payload.destination}:${event.webhookEventId}`, now()],
      );
      if (!claim.rows.length) continue;
      if (event.replyToken)
        rt.staffLineTestScope?.replyTokens.add(event.replyToken);
      const line = event.source.userId;
      if (event.type === "unfollow") {
        await rt.db.query(
          "UPDATE staff_line_links SET state='revoked',notifications=0,updated_at=? WHERE destination=? AND line_user_id=?",
          [now(), payload.destination, line],
        );
        continue;
      }
      try {
        if (
          event.type === "message" &&
          event.message?.type === "text" &&
          event.message.text?.startsWith("連携 ")
        ) {
          const hash = await digest(event.message.text.slice(3).trim()),
            confirm = id().replaceAll("-", "").slice(0, 12);
          const pair = await one(
            rt.db,
            "SELECT * FROM staff_line_links WHERE pair_hash=? AND destination=? AND state='pending' AND pair_expires_at>?",
            [hash, payload.destination, now()],
          );
          requireThat(
            pair &&
              (!rt.staffLineTestScope ||
                pair.tenant_id === rt.staffLineTestScope.tenant),
            409,
            "PAIR_EXPIRED",
            "連携コードが無効です。Web画面からやり直してください。",
          );
          const m = await member(rt, pair.user_id, pair.tenant_id);
          requireThat(
            has(m, "sales", "org_owner", "team_admin"),
            403,
            "FORBIDDEN",
            "営業権限がありません。",
          );
          requireThat(
            !(await one(
              rt.db,
              "SELECT user_id FROM staff_line_links WHERE destination=? AND line_user_id=?",
              [payload.destination, line],
            )),
            409,
            "ALREADY_LINKED",
            "このLINEは既に連携済みです。先にWeb画面で解除してください。",
          );
          const accepted = await rt.db.query(
            "UPDATE staff_line_links SET line_user_id=?,confirm_hash=?,pair_hash=NULL,state='confirming',updated_at=? WHERE tenant_id=? AND user_id=? AND state='pending' AND pair_hash=? RETURNING user_id",
            [
              line,
              await digest(confirm),
              now(),
              pair.tenant_id,
              pair.user_id,
              hash,
            ],
          );
          requireThat(
            accepted.rows.length,
            409,
            "PAIR_USED",
            "連携コードは使用済みです。",
          );
          await reply(
            rt,
            event.replyToken,
            `本人確認コード：${confirm}\n連携を始めたつなぐのWeb画面へ入力してください。他の人には共有しないでください。`,
          );
          continue;
        }
        const binding = await one(
          rt.db,
          "SELECT * FROM staff_line_links WHERE destination=? AND line_user_id=? AND state='active'",
          [payload.destination, line],
        );
        requireThat(
          binding &&
            (!rt.staffLineTestScope ||
              binding.tenant_id === rt.staffLineTestScope.tenant),
          403,
          "STAFF_NOT_LINKED",
          "つなぐのWeb画面から担当者LINEの本人連携を完了してください。",
        );
        await member(rt, binding.user_id, binding.tenant_id);
        if (event.type === "postback") {
          const match = event.postback?.data.match(
            /^assistant:([a-f0-9-]+):(approve|cancel|later|edit)$/,
          );
          requireThat(match, 400, "INVALID_ACTION", "操作を確認してください。");
          const notice = await one(
            rt.db,
            "SELECT * FROM staff_line_notices WHERE id=? AND tenant_id=? AND user_id=? AND destination=? AND line_user_id=? AND state IN ('sent','uncertain')",
            [
              match[1],
              binding.tenant_id,
              binding.user_id,
              payload.destination,
              line,
            ],
          );
          requireThat(
            notice,
            404,
            "NOTICE_NOT_FOUND",
            "この提案を操作する権限がありません。",
          );
          if (match[2] === "edit") {
            const ts = await rt.openDatabase(
                notice.tenant_id,
                notice.oa_id,
                "tsunagu",
              ),
              p = await one(ts, "SELECT * FROM proposals WHERE id=?", [
                notice.proposal_id,
              ]);
            requireThat(
              p &&
                p.version === notice.version &&
                ["pending", "approved", "held"].includes(p.state),
              409,
              "VERSION_CONFLICT",
              "最新カードから修正してください。",
            );
            await assistantAccess(
              rt,
              notice.tenant_id,
              notice.oa_id,
              binding.user_id,
              p.customer_id,
              "edit",
            );
            const reason = await assistantGuard(
              rt,
              notice.tenant_id,
              notice.oa_id,
              p,
            );
            requireThat(!reason, 409, "REVIEW_REQUIRED", reason || "");
            await editAssistant(
              rt,
              notice.tenant_id,
              notice.oa_id,
              binding.user_id,
              p.id,
              p.version,
              p.draft,
            );
            const editNoticeId = id(),
              editExpiry = until(10 * 60000);
            await ts.query(
              "UPDATE assistant_proposals SET snoozed_until=? WHERE proposal_id=?",
              [editExpiry, p.id],
            );
            await rt.db.query(
              "INSERT INTO staff_line_notices(id,tenant_id,oa_id,user_id,destination,line_user_id,proposal_id,version,draft_hash,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,'editing',?)",
              [
                editNoticeId,
                notice.tenant_id,
                notice.oa_id,
                binding.user_id,
                payload.destination,
                line,
                p.id,
                p.version + 1,
                await digest(p.draft),
                now(),
              ],
            );
            await rt.db.query(
              "INSERT INTO staff_line_edits(tenant_id,user_id,notice_id,expires_at) VALUES (?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET notice_id=excluded.notice_id,expires_at=excluded.expires_at,state='waiting'",
              [binding.tenant_id, binding.user_id, editNoticeId, editExpiry],
            );
            await reply(
              rt,
              event.replyToken,
              `この提案の修正内容を送ってください（10分以内）。${rt.ai?.apiKey ? "例：もう少し短く、やわらかく。1回の修正にAIを利用します。" : "文章修正AIは未接続です。"}\n「本文」に続けて改行し、新しい全文を送ることもできます。\n宛先はこのまま、修正後に改めて承認します。やめる場合は「やめる」。`,
            );
          } else if (match[2] === "approve") {
            const result = await approveAssistant(
              rt,
              notice.tenant_id,
              notice.oa_id,
              binding.user_id,
              notice.proposal_id,
              notice.version,
              notice.draft_hash,
            );
            await reply(
              rt,
              event.replyToken,
              result.state === "sent"
                ? "送信しました。"
                : result.state === "uncertain"
                  ? "送信結果が不明です。管理画面で配送履歴を確認してください。"
                  : result.state === "held"
                    ? "送信を保留しました。管理画面で理由を確認してください。"
                    : "承認した文面を送信キューに登録しました。",
            );
          } else {
            await decideAssistant(
              rt,
              notice.tenant_id,
              notice.oa_id,
              binding.user_id,
              notice.proposal_id,
              notice.version,
              match[2] as "cancel" | "later",
            );
            if(match[2]==="cancel") await rt.db.query("INSERT INTO staff_line_edits(tenant_id,user_id,notice_id,expires_at,state) VALUES (?,?,?,?,'feedback') ON CONFLICT(tenant_id,user_id) DO UPDATE SET notice_id=excluded.notice_id,expires_at=excluded.expires_at,state='feedback'",[binding.tenant_id,binding.user_id,notice.id,until(10*60000)]);
            await reply(
              rt,
              event.replyToken,
              match[2] === "cancel"
                ? "見送りました。同じ更新の提案は繰り返し通知しません。理由を次回へ活かす場合は10分以内に「タイミング」「条件不一致」「事実誤り」「文体」「案内済み」のいずれかと、必要なら補足を送ってください。"
                : "4時間後まで通知を控えます。有効期限は延長されません。",
            );
          }
        } else if (event.type === "message" && event.message?.type === "text") {
          const feedbackPrompt=await one(rt.db,"SELECT * FROM staff_line_edits WHERE tenant_id=? AND user_id=? AND state='feedback' AND expires_at>?",[binding.tenant_id,binding.user_id,now()]);
          if(feedbackPrompt) {
            const reasonMatch=(event.message.text||'').trim().match(/^(タイミング|条件不一致|事実誤り|文体|案内済み)(?:[\s：:]+([\s\S]*))?$/);
            if(reasonMatch) {
              const n=await one(rt.db,"SELECT * FROM staff_line_notices WHERE id=? AND user_id=? AND tenant_id=?",[feedbackPrompt.notice_id,binding.user_id,binding.tenant_id]);
              if(n) {
                const ts=await rt.openDatabase(n.tenant_id,n.oa_id,"tsunagu");
                const f=await one(ts,"SELECT * FROM assistant_feedback WHERE proposal_id=? AND version=? AND actor_id=? AND action='cancel'",[n.proposal_id,n.version,binding.user_id]);
                if(f) {
                  await assistantAccess(rt,n.tenant_id,n.oa_id,binding.user_id,f.customer_id,"edit");
                  const categories:Record<string,string>={タイミング:'timing',条件不一致:'not_fit',事実誤り:'incorrect',文体:'tone',案内済み:'duplicate'};
                  await ts.query("UPDATE assistant_feedback SET category=?,note=? WHERE id=?",[categories[reasonMatch[1]],(reasonMatch[2]||'').slice(0,500),f.id]);
                  await audit(rt.db,binding.user_id,"assistant.feedback.reason",f.id,n.tenant_id,{category:categories[reasonMatch[1]]});
                }
              }
              await rt.db.query("DELETE FROM staff_line_edits WHERE tenant_id=? AND user_id=? AND notice_id=?",[binding.tenant_id,binding.user_id,feedbackPrompt.notice_id]);
              await reply(rt,event.replyToken,"見送り理由を記録しました。このお客様への次の提案で参考にします。希望条件や商品情報は書き換えていません。");
              continue;
            }
          }
          const editing = await one(
            rt.db,
            "SELECT * FROM staff_line_edits WHERE tenant_id=? AND user_id=? AND state='waiting' AND expires_at>?",
            [binding.tenant_id, binding.user_id, now()],
          );
          if (editing) {
            if (event.message.text === "やめる") {
              await rt.db.query(
                "DELETE FROM staff_line_edits WHERE tenant_id=? AND user_id=?",
                [binding.tenant_id, binding.user_id],
              );
              const original = await one(
                rt.db,
                "SELECT * FROM staff_line_notices WHERE id=? AND tenant_id=? AND user_id=?",
                [editing.notice_id, binding.tenant_id, binding.user_id],
              );
              if (original)
                await replyProposalCard(
                  rt,
                  binding,
                  original,
                  event.replyToken!,
                );
              continue;
            }
            const notice = await one(
              rt.db,
              "SELECT * FROM staff_line_notices WHERE id=? AND user_id=? AND tenant_id=? AND destination=? AND line_user_id=?",
              [
                editing.notice_id,
                binding.user_id,
                binding.tenant_id,
                payload.destination,
                line,
              ],
            );
            requireThat(
              notice,
              404,
              "NOTICE_NOT_FOUND",
              "提案が見つかりません。",
            );
            await rewriteAssistant(
              rt,
              notice.tenant_id,
              notice.oa_id,
              binding.user_id,
              notice.proposal_id,
              notice.version,
              event.message.text || "",
              `${payload.destination}:${event.webhookEventId}`,
            );
            await rt.db.query(
              "DELETE FROM staff_line_edits WHERE tenant_id=? AND user_id=? AND notice_id=?",
              [binding.tenant_id, binding.user_id, notice.id],
            );
            await replyProposalCard(rt, binding, notice, event.replyToken!);
            continue;
          }
          await reply(
            rt,
            event.replyToken,
            `提案カードの「送る・修正・見送り・あとで」から操作できます。\n${rt.origin}/sales`,
          );
        }
      } catch (e) {
        // Webhookを再実行して顧客送信を繰り返さない。詳細や入力本文はログしない。
        try {
          await reply(
            rt,
            event.replyToken,
            e instanceof AppError
              ? e.message
              : "処理を完了できませんでした。つなぐの画面で最新状態を確認してください。",
          );
        } catch {}
      }
    }
    return c.json({ ok: true });
  });
}
export function registerAssistantLine(app: Hono<AppEnv>) {
  const base = "/api/tenants/:tenantId/assistant-line";
  app.get(base, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id;
    const m = await member(rt, actor, tenant);
    requireThat(
      has(m, "sales", "org_owner", "team_admin"),
      403,
      "FORBIDDEN",
      "営業権限がありません。",
    );
    const row = await one(
      rt.db,
      "SELECT state,notifications,pair_expires_at,updated_at,destination FROM staff_line_links WHERE tenant_id=? AND user_id=?",
      [tenant, actor],
    );
    const ready = await staffLineReady(rt);
    return c.json({
      configured: ready,
      state:
        row?.destination === rt.assistantLine?.destination
          ? row?.state || "unlinked"
          : "unlinked",
      notifications: !!row?.notifications,
      expiresAt: row?.pair_expires_at,
      limits:
        "都度通知・返信を優先。大量発生時は返信/その他を各1分3件まで順次通知",
      preferences: await notificationPreferences(rt, tenant, actor),
      deliveries: await all(
        rt.db,
        "SELECT n.id,n.state,n.created_at,d.lane,d.attempts,d.error_code FROM staff_line_notices n JOIN staff_line_deliveries d ON d.notice_id=n.id WHERE n.tenant_id=? AND n.user_id=? AND n.state IN ('queued','failed','uncertain') ORDER BY n.created_at DESC LIMIT 20",
        [tenant, actor],
      ),
    });
  });
  app.post(`${base}/pair`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id,
      m = await member(rt, actor, tenant);
    requireThat(
      has(m, "sales", "org_owner", "team_admin"),
      403,
      "FORBIDDEN",
      "営業権限がありません。",
    );
    requireThat(
      await staffLineReady(rt),
      409,
      "STAFF_LINE_NOT_CONNECTED",
      "担当者用LINEは未接続です。専用チャネルの設定が必要です。",
    );
    const previous = await one(
      rt.db,
      "SELECT state FROM staff_line_links WHERE tenant_id=? AND user_id=?",
      [tenant, actor],
    );
    requireThat(
      previous?.state !== "active",
      409,
      "ALREADY_LINKED",
      "変更する場合は先に連携を解除してください。",
    );
    const token = random(),
      expiry = until(10 * 60000);
    await rt.db.query(
      "INSERT INTO staff_line_links(tenant_id,user_id,destination,pair_hash,pair_expires_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET destination=excluded.destination,pair_hash=excluded.pair_hash,pair_expires_at=excluded.pair_expires_at,confirm_hash=NULL,line_user_id=NULL,state='pending',notifications=0,attempts=0,updated_at=excluded.updated_at",
      [
        tenant,
        actor,
        rt.assistantLine!.destination,
        await digest(token),
        expiry,
        now(),
      ],
    );
    return c.json({ text: `連携 ${token}`, expiresAt: expiry });
  });
  app.post(`${base}/confirm`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id,
      b = z
        .object({ code: z.string().max(30) })
        .strict()
        .parse(await c.req.json());
    await member(rt, actor, tenant);
    requireThat(
      await staffLineReady(rt),
      409,
      "STAFF_LINE_NOT_CONNECTED",
      "担当者LINE設定を確認してください。",
    );
    const row = await one(
      rt.db,
      "UPDATE staff_line_links SET attempts=attempts+1 WHERE tenant_id=? AND user_id=? AND destination=? AND state='confirming' AND pair_expires_at>? AND attempts<5 RETURNING *",
      [tenant, actor, rt.assistantLine!.destination, now()],
    );
    requireThat(
      row &&
        row.confirm_hash === (await digest(b.code.trim())) &&
        (!rt.staffLineTestScope ||
          (row.tenant_id === rt.staffLineTestScope.tenant &&
            (rt.staffLineTestScope.lineUserIds.includes(row.line_user_id) || await demoStaffAllowed(rt,row.line_user_id,undefined,true)))),
      409,
      "CONFIRM_INVALID",
      "LINEに届いた本人確認コードを確認してください（10分以内・5回まで）。",
    );
    const changed = await rt.db.query(
      "UPDATE staff_line_links SET state='active',pair_hash=NULL,confirm_hash=NULL,updated_at=? WHERE tenant_id=? AND user_id=? AND confirm_hash=? AND state='confirming'",
      [now(), tenant, actor, row.confirm_hash],
    );
    requireThat(
      changed.changes,
      409,
      "PAIR_CHANGED",
      "連携をやり直してください。",
    );
    await audit(rt.db, actor, "assistant.line_linked", actor, tenant);
    return c.json({ ok: true });
  });
  app.post(`${base}/settings`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id,
      b = z
        .object({ notifications: z.boolean() })
        .strict()
        .parse(await c.req.json());
    await member(rt, actor, tenant);
    const r = await rt.db.query(
      "UPDATE staff_line_links SET notifications=?,updated_at=? WHERE tenant_id=? AND user_id=? AND state='active' AND destination=?",
      [
        Number(b.notifications),
        now(),
        tenant,
        actor,
        rt.assistantLine?.destination || "",
      ],
    );
    requireThat(
      r.changes,
      409,
      "STAFF_NOT_LINKED",
      "担当者LINEの本人連携を完了してください。",
    );
    return c.json({ ok: true });
  });
  app.post(`${base}/preferences`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id;
    await member(rt, actor, tenant);
    const data = notificationPreferencesSchema.parse(await c.req.json());
    await rt.db.query(
      "INSERT INTO staff_line_preferences(tenant_id,user_id,data) VALUES (?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET data=excluded.data",
      [tenant, actor, json(data)],
    );
    await rt.db.query(
      "DELETE FROM staff_line_delivery_schedule WHERE notice_id IN (SELECT id FROM staff_line_notices WHERE tenant_id=? AND user_id=? AND state='queued')",
      [tenant, actor],
    );
    return c.json({ ok: true });
  });
  app.post(`${base}/notices/:id/retry`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id;
    await member(rt, actor, tenant);
    return c.json(
      await retryAssistantNotice(rt, tenant, actor, c.req.param("id")),
    );
  });
  app.post(`${base}/revoke`, async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      actor = c.get("principal").user.id;
    await member(rt, actor, tenant);
    await rt.db.query(
      "UPDATE staff_line_links SET state='revoked',line_user_id=NULL,notifications=0,pair_hash=NULL,confirm_hash=NULL,updated_at=? WHERE tenant_id=? AND user_id=?",
      [now(), tenant, actor],
    );
    await audit(rt.db, actor, "assistant.line_revoked", actor, tenant);
    return c.json({ ok: true });
  });
}
