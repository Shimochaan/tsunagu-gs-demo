import type { Runtime } from "./runtime.ts";
import { all, one, now, id, type Row } from "./db.ts";
import { requireThat } from "./security.ts";
import { demoLivePlatformDDL } from "./demo-live-schema.ts";
import { participant, copyDemoLibraryDocument } from "./self-demo.ts";
import { staffLineReady, lineRequest } from "./assistant-line.ts";
import { claimStaffDaily } from "./assistant-notifications.ts";

export async function demoLiveState(rt: Runtime) {
  if (!rt.selfDemo) return null;
  for (const sql of demoLivePlatformDDL) await rt.db.query(sql);
  const key = rt.selfDemo.tenant + ":" + rt.selfDemo.oa;
  await rt.db.query(
    "INSERT OR IGNORE INTO gs_demo_live_state(id,started_at) VALUES (?,?)",
    [key, now()],
  );
  return one(rt.db, "SELECT * FROM gs_demo_live_state WHERE id=?", [key]);
}
async function source(rt: Runtime, n: Row) {
  if (n.source_kind === "personal")
    return one(
      rt.db,
      "SELECT id,title,version,state FROM gs_demo_documents WHERE id=? AND user_id=?",
      [n.source_id, n.user_id],
    );
  const ts = await rt.openDatabase(
    rt.selfDemo!.tenant,
    rt.selfDemo!.oa,
    "tsunagu",
  );
  return one(
    ts,
    "SELECT id,title,version,state FROM meeting_inbox WHERE id=? AND state NOT IN ('ignored','missing')",
    [n.source_id],
  );
}
export async function notifyDemoMeetings(rt: Runtime, onlyActor?: string) {
  const live = await demoLiveState(rt);
  if (!live || !(await staffLineReady(rt))) return { sent: 0 };
  const { tenant, oa } = rt.selfDemo!;
  const ts = await rt.openDatabase(tenant, oa, "tsunagu");
  const common = await rt.openDatabase(tenant, "", "common");
  const recipients = await all(
    rt.db,
    `SELECT p.*,l.line_user_id,l.destination FROM gs_demo_participants p JOIN staff_line_links l ON l.user_id=p.user_id AND l.tenant_id=p.tenant_id JOIN memberships m ON m.user_id=p.user_id AND m.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id WHERE t.state='active' AND p.tenant_id=? AND p.state='active' AND p.customer_line_id IS NOT NULL AND p.pair_hash IS NULL AND p.notifications_until>? AND l.state='active' AND l.notifications=1 AND l.destination=? AND m.state='active' AND (? IS NULL OR p.user_id=?) LIMIT 12`,
    [
      tenant,
      now(),
      rt.assistantLine!.destination,
      onlyActor || null,
      onlyActor || null,
    ],
  );
  let sent = 0;
  for (const p of recipients) {
    const customer = await one(
      common,
      "SELECT name,owner_user_id FROM customers WHERE id=?",
      [p.customer_id],
    );
    if (!customer || customer.owner_user_id !== p.user_id) continue;
    const personal = await all(
      rt.db,
      "SELECT id,title,version,'personal' source_kind FROM gs_demo_documents WHERE user_id=? AND state='unlinked' AND NOT EXISTS(SELECT 1 FROM gs_demo_meeting_notices n WHERE n.source_kind='drive' AND gs_demo_documents.id='demo-note-'||n.id) AND updated_at>=? ORDER BY updated_at DESC LIMIT 10",
      [p.user_id, live.started_at],
    );
    const drive = await all(
      ts,
      "SELECT id,title,version,'drive' source_kind FROM meeting_inbox WHERE detected_at>=? AND state NOT IN ('ignored','missing') ORDER BY detected_at DESC LIMIT 20",
      [live.started_at],
    );
    for (const d of [...personal, ...drive]) {
      await rt.db.query(
        "INSERT OR IGNORE INTO gs_demo_meeting_notices(id,user_id,customer_id,source_kind,source_id,source_version,created_at) VALUES (?,?,?,?,?,?,?)",
        [id(), p.user_id, p.customer_id, d.source_kind, d.id, d.version, now()],
      );
    }
    // A stable retry key makes interrupted push requests safe to reconcile within 24 hours.
    const n = await one(
      rt.db,
      "SELECT * FROM gs_demo_meeting_notices WHERE user_id=? AND (state='queued' OR state='sending') AND next_at<=? AND attempts<3 AND created_at>? ORDER BY created_at LIMIT 1",
      [p.user_id, now(), new Date(Date.now() - 23 * 3600000).toISOString()],
    );
    if (!n) continue;
    const d = await source(rt, n);
    if (
      !d ||
      d.version !== n.source_version ||
      n.customer_id !== p.customer_id ||
      (n.source_kind === "personal" && d.state !== "unlinked")
    ) {
      await rt.db.query(
        "UPDATE gs_demo_meeting_notices SET state='stale' WHERE id=?",
        [n.id],
      );
      continue;
    }
    if (!(await claimStaffDaily(rt, tenant, p.user_id, "meeting:" + n.id)))
      continue;
    const claim = await rt.db.query(
      "UPDATE gs_demo_meeting_notices SET state='sending',attempts=attempts+1,next_at=? WHERE id=? AND state IN ('queued','sending') AND next_at<=? RETURNING id",
      [new Date(Date.now() + 60000).toISOString(), n.id, now()],
    );
    if (!claim.changes) continue;
    try {
      await lineRequest(
        rt,
        "push",
        {
          to: p.line_user_id,
          messages: [
            {
              type: "flex",
              altText: `新しい議事録「${d.title.slice(0, 80)}」を${customer.name.slice(0, 40)}さんに紐づけますか？`,
              contents: {
                type: "bubble",
                body: {
                  type: "box",
                  layout: "vertical",
                  spacing: "md",
                  contents: [
                    {
                      type: "text",
                      text: "新しい議事録を検知しました",
                      weight: "bold",
                      wrap: true,
                    },
                    {
                      type: "text",
                      text: d.title.slice(0, 200),
                      wrap: true,
                      size: "sm",
                    },
                    {
                      type: "text",
                      text: `候補：${customer.name}さん（あなたのお客様役）\n${n.source_kind === "drive" ? "共通の体験用素材です。" : "あなたが追加したメモです。"}このお客様との会話として紐づけ、希望条件を解析しますか？`,
                      wrap: true,
                      size: "sm",
                    },
                    {
                      type: "button",
                      style: "primary",
                      action: {
                        type: "postback",
                        label: "このお客様に紐づける",
                        data: `demo-meeting:${n.id}:link`,
                      },
                    },
                    {
                      type: "button",
                      action: {
                        type: "postback",
                        label: "今回は紐づけない",
                        data: `demo-meeting:${n.id}:skip`,
                      },
                    },
                    {
                      type: "button",
                      action: {
                        type: "uri",
                        label: "画面で内容を確認する",
                        uri: rt.origin + "/demo",
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        n.id,
      );
      await rt.db.query(
        "UPDATE gs_demo_meeting_notices SET state='sent',error=NULL WHERE id=? AND state='sending'",
        [n.id],
      );
      sent++;
    } catch {
      await rt.db.query(
        "UPDATE gs_demo_meeting_notices SET state=CASE WHEN attempts>=3 THEN 'uncertain' ELSE 'queued' END,error='LINE通知の結果を確認中です。画面でも紐づけできます。' WHERE id=? AND state='sending'",
        [n.id],
      );
    }
  }
  return { sent };
}
export async function linkDemoMeetingFromLine(
  rt: Runtime,
  binding: Row,
  noticeId: string,
  action: string,
) {
  const p = await participant(rt, binding.user_id, true);
  requireThat(
    p.tenant_id === binding.tenant_id,
    403,
    "FORBIDDEN",
    "体験アカウントを確認してください。",
  );
  const n = await one(
    rt.db,
    "SELECT * FROM gs_demo_meeting_notices WHERE id=? AND user_id=? AND customer_id=? AND state IN ('sent','uncertain','linked','dismissed')",
    [noticeId, binding.user_id, p.customer_id],
  );
  requireThat(n, 404, "NOTICE_NOT_FOUND", "この議事録通知は操作できません。");
  if (n.state === "linked")
    return {
      message: "この議事録は紐づけ済みです。解析結果は体験画面に反映されます。",
    };
  if (n.state === "dismissed")
    return {
      message:
        "この通知は見送り済みです。必要なら体験画面から紐づけてください。",
    };
  const d = await source(rt, n);
  requireThat(
    d && d.version === n.source_version,
    409,
    "DOCUMENT_CHANGED",
    "議事録が更新・削除されています。最新版の通知または体験画面から確認してください。",
  );
  if (action === "skip") {
    await rt.db.query(
      "UPDATE gs_demo_meeting_notices SET state='dismissed' WHERE id=? AND state IN ('sent','uncertain')",
      [n.id],
    );
    return { message: "今回は紐づけません。同じ版の通知は繰り返しません。" };
  }
  const docId =
    n.source_kind === "personal"
      ? d.id
      : await copyDemoLibraryDocument(
          rt,
          binding.user_id,
          d.id,
          d.version,
          "demo-note-" + n.id,
        );
  // Both changes share one transaction. A skip, edit or second tap cannot enqueue stale text.
  const linked = await rt.db.batch([
    {
      sql: "UPDATE gs_demo_meeting_notices SET state='linked',doc_id=? WHERE id=? AND state IN ('sent','uncertain') AND EXISTS(SELECT 1 FROM gs_demo_documents WHERE id=? AND user_id=? AND state='unlinked' AND version=?)",
      params: [
        docId,
        n.id,
        docId,
        binding.user_id,
        n.source_kind === "personal" ? d.version : 1,
      ],
    },
    {
      sql: "UPDATE gs_demo_documents SET state='queued',error=NULL WHERE id=? AND user_id=? AND state='unlinked' AND version=? AND EXISTS(SELECT 1 FROM gs_demo_meeting_notices WHERE id=? AND state='linked' AND doc_id=?)",
      params: [
        docId,
        binding.user_id,
        n.source_kind === "personal" ? d.version : 1,
        n.id,
        docId,
      ],
    },
  ]);
  if (!linked[0].changes)
    return {
      message:
        "この通知は更新または操作済みです。体験画面で最新の状態をご確認ください。",
    };
  return {
    docId,
    message:
      "このお客様に紐づけました。希望条件を解析し、合う物件があれば文案を自動でお届けします。",
  };
}
