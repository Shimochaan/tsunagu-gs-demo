import { demoAILimits } from "./self-demo-access.ts";
import { queueDemoSheetWrite, processDemoSheetWrites } from "./demo-sheet-sync.ts";
import { googleDB, googleConfig } from "./assistant-google-store.ts";
import { runValueLoop } from "./assistant-value-loop.ts";
import { notifyDemoMeetings, demoLiveState } from "./demo-meeting-line.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { Runtime, AppEnv } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { requireThat, digest } from "./security.ts";
import {
  demoParticipant,
  isDemoGuest,
  demoBookingToken,
  demoBookingUrl,
  demoBookingConfigured,
  claimDemoAI,
} from "./self-demo-access.ts";
import { getCredential } from "./credentials.ts";
import { harnessRequest } from "./harness.ts";
import {
  upsertSource,
  scanAssistant,
  approveAssistant,
  editAssistant,
  decideAssistant,
} from "./assistant.ts";
import { learningInput, decisionInput } from "./assistant-learning.ts";
import { notifyAssistant } from "./assistant-notifications.ts";
import { generateAssistantDraft } from "./assistant-draft.ts";
import { extractMeetingInsights } from "./meet-analysis.ts";
import {
  checkedMeetingTracking,
} from "./meeting-automation.ts";
import { applyDemoWish } from "./self-demo-preferences.ts";
import { readMeetingText, pollDrive } from "./drive.ts";
import { holdCustomer } from "./sales.ts";

const day = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
function config(rt: Runtime) {
  requireThat(rt.selfDemo, 404, "NOT_FOUND", "体験環境ではありません。");
  return rt.selfDemo;
}
export async function participant(rt: Runtime, actor: string, linked = false) {
  config(rt);
  const p = await demoParticipant(rt, actor);
  requireThat(
    p?.state === "active",
    403,
    "DEMO_START_REQUIRED",
    "「体験をはじめる」から進んでください。",
  );
  requireThat(
    !linked || (p.customer_line_id && !p.pair_hash),
    409,
    "DEMO_LINE_REQUIRED",
    "顧客用LINEの本人確認を先に完了してください。",
  );
  requireThat(
    await one(
      rt.db,
      "SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND state='active'",
      [p.tenant_id, actor],
    ),
    403,
    "DEMO_STOPPED",
    "この体験アカウントは停止しています。",
  );
  return p!;
}
async function slots(rt: Runtime, actor: string, kind: string, limit: number) {
  const r = await rt.db.query(
    "INSERT INTO gs_demo_actions(id,user_id,kind,day,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM gs_demo_actions WHERE user_id=? AND kind=? AND day=?)<?",
    [id(), actor, kind, day(), now(), actor, kind, day(), limit],
  );
  requireThat(
    r.changes,
    429,
    "DEMO_LIMIT",
    "本日の体験回数の上限です。翌日、続きから再開できます。",
  );
}
export async function startDemo(
  rt: Runtime,
  user: { id: string; name: string },
) {
  const { tenant, oa, capacity } = config(rt);
  await demoLiveState(rt);
  const existing = await demoParticipant(rt, user.id);
  if (existing)
    requireThat(
      existing.state === "active",
      403,
      "DEMO_STOPPED",
      "この体験アカウントは停止しています。",
    );
  const guest = await isDemoGuest(rt, user.id),
    cid = existing?.customer_id || "gs-demo-" + id();
  const r = await rt.db.query(
    "INSERT OR IGNORE INTO gs_demo_participants(user_id,tenant_id,guest_only,customer_id,booking_hash,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM gs_demo_participants WHERE tenant_id=? AND state='active')<?",
    [
      user.id,
      tenant,
      Number(guest),
      cid,
      await digest(await demoBookingToken(rt, cid)),
      now(),
      now(),
      tenant,
      capacity,
    ],
  );
  requireThat(
    r.changes || (await demoParticipant(rt, user.id)),
    409,
    "DEMO_FULL",
    "体験枠が満員です。運営へお知らせください。",
  );
  // INSERT OR IGNORE preserves pre-existing real member roles.
  await rt.db.batch([
    {
      sql: 'INSERT OR IGNORE INTO memberships(tenant_id,user_id,roles) VALUES (?,?,\'["sales","demo"]\')',
      params: [tenant, user.id],
    },
    {
      sql: "UPDATE accounts SET operators=json_insert(operators,'$[#]',?) WHERE tenant_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM json_each(operators) WHERE value=?)",
      params: [user.id, tenant, oa, user.id],
    },
  ]);
  return demoParticipant(rt, user.id);
}
export async function confirmDemoCustomer(
  rt: Runtime,
  actor: string,
  code: string,
) {
  const p = await participant(rt, actor),
    { tenant, oa } = config(rt);
  requireThat(
    p.pair_hash && p.pair_expires_at > now(),
    409,
    "PAIR_EXPIRED",
    "確認用メッセージの期限が切れました。新しいメッセージを発行してください。",
  );
  const attempt = await rt.db.query(
    "UPDATE gs_demo_participants SET attempts=attempts+1 WHERE user_id=? AND pair_hash=? AND pair_expires_at>? AND attempts<5 RETURNING attempts",
    [actor, p.pair_hash, now()],
  );
  requireThat(
    attempt.changes,
    429,
    "PAIR_ATTEMPTS",
    "確認回数の上限です。確認用メッセージを再発行してください。",
  );
  const cred = await getCredential(rt, tenant, oa, "harness");
  const proof = await harnessRequest(
    rt,
    cred,
    "/api/demo-proof?hash=" + encodeURIComponent(p.pair_hash),
  );
  requireThat(
    proof?.confirm_hash === (await digest(code.trim())) &&
      proof.expires_at > now() &&
      /^U[0-9a-f]{32}$/.test(proof.line_user_id),
    409,
    "PAIR_CODE_INVALID",
    "顧客用LINEに届いた本人確認コードを入力してください。通知用LINEのコードとは別です。",
  );
  const common = await rt.openDatabase(tenant, "", "common");
  const prior = await one(
    common,
    "SELECT l.customer_id,c.owner_user_id FROM customer_links l JOIN customers c ON c.id=l.customer_id WHERE l.oa_id=? AND l.line_user_id=? AND l.state='confirmed'",
    [oa, proof.line_user_id],
  );
  requireThat(
    !prior || prior.customer_id === p.customer_id || prior.owner_user_id === actor,
    409,
    "DEMO_ALREADY_LINKED",
    "このLINEは既存の顧客に連携済みです。別のLINEで体験するか、既存の営業画面をご利用ください。",
  );
  const friend = await harnessRequest(
    rt,
    cred,
    "/api/friends/" + encodeURIComponent(proof.friend_id),
  );
  requireThat(
    friend?.lineUserId === proof.line_user_id &&
      friend.isFollowing &&
      friend.lineAccountId === cred.accountId,
    409,
    "PAIR_FRIEND_CHANGED",
    "顧客用LINEを友だち追加して、もう一度お試しください。",
  );
  // A returning owner may reuse only their own already-confirmed customer after
  // proving control of the LINE. Never move another operator's customer.
  const customerId = prior?.customer_id || p.customer_id;
  // Unique line index and CAS prevent two Google accounts from claiming the same LINE.
  const saved = await rt.db.query(
    "UPDATE gs_demo_participants SET customer_id=?,booking_hash=?,customer_line_id=?,friend_id=?,updated_at=? WHERE user_id=? AND pair_hash=? AND (customer_line_id IS NULL OR customer_line_id=?) AND NOT EXISTS(SELECT 1 FROM gs_demo_participants WHERE (customer_line_id=? OR customer_id=?) AND user_id<>?)",
    [
      customerId,
      await digest(await demoBookingToken(rt, customerId)),
      proof.line_user_id,
      proof.friend_id,
      now(),
      actor,
      p.pair_hash,
      proof.line_user_id,
      proof.line_user_id,
      customerId,
      actor,
    ],
  );
  requireThat(
    saved.changes,
    409,
    "DEMO_ALREADY_LINKED",
    "このLINEは別のGoogleアカウントで体験中です。最初のGoogleアカウントでログインしてください。",
  );
  p.customer_id = customerId;
  await common.batch([
    {
      sql: "INSERT OR IGNORE INTO customers(id,name,owner_user_id,confirmed_by,confirmed_at,created_at) VALUES (?,?,?,?,?,?)",
      params: [
        p.customer_id,
        friend.displayName || "自分（体験用）",
        actor,
        actor,
        now(),
        now(),
      ],
    },
    {
      sql: "INSERT OR IGNORE INTO customer_links(oa_id,line_user_id,customer_id) VALUES (?,?,?)",
      params: [oa, proof.line_user_id, p.customer_id],
    },
    {
      sql: "INSERT OR IGNORE INTO external_links(oa_id,service,external_id,customer_id,line_user_id) VALUES (?,'harness',?,?,?)",
      params: [oa, proof.friend_id, p.customer_id, proof.line_user_id],
    },
  ]);
  await common.query(
    "INSERT OR IGNORE INTO external_links(oa_id,service,external_id,customer_id,line_user_id) VALUES (?,'timerex',?,?,?)",
    [
      oa,
      await demoBookingToken(rt, p.customer_id),
      p.customer_id,
      proof.line_user_id,
    ],
  );
  const bound = await one(
    common,
    "SELECT customer_id FROM customer_links WHERE oa_id=? AND line_user_id=?",
    [oa, proof.line_user_id],
  );
  requireThat(
    bound?.customer_id === p.customer_id,
    409,
    "PAIR_CHANGED",
    "連携先が変わりました。再確認してください。",
  );
  const completed = await rt.db.query(
    "UPDATE gs_demo_participants SET pair_hash=NULL,pair_expires_at=NULL WHERE user_id=? AND pair_hash=?",
    [actor, p.pair_hash],
  );
  requireThat(completed.changes, 409, "PAIR_CHANGED", "本人確認メッセージが再発行されました。最新のコードで確認してください。");
  return { ok: true, name: friend.displayName || "自分（体験用）" };
}
export async function processDemoDocument(
  rt: Runtime,
  actor: string,
  docId: string,
) {
  const p = await participant(rt, actor, true),
    { tenant, oa } = config(rt);
  const doc = await one(
    rt.db,
    "SELECT * FROM gs_demo_documents WHERE id=? AND user_id=?",
    [docId, actor],
  );
  if (
    !doc ||
    doc.state === "unlinked" ||
    doc.state === "ready" ||
    doc.state === "error"
  )
    return;
  const lease = new Date(Date.now() + 120000).toISOString();
  const claim = await rt.db.query(
    "UPDATE gs_demo_documents SET state='processing',lease_until=?,error=NULL WHERE id=? AND version=? AND (state='queued' OR (state='processing' AND lease_until<?)) RETURNING id",
    [lease, docId, doc.version, now()],
  );
  if (!claim.changes) return;
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    common = await rt.openDatabase(tenant, "", "common");
  try {
    const cached = parse(doc.analysis, null);
    const reusable = cached?.extractVersion === doc.version && cached.extraction?.tracking && cached.extraction;
    if (!reusable) requireThat(
      await claimDemoAI(rt, actor),
      429,
      "DEMO_AI_LIMIT",
      "本日のAI利用枠に達しました。翌日、解析をやり直してください。",
    );
    const customer = await one(
      common,
      "SELECT name FROM customers WHERE id=?",
      [p.customer_id],
    );
    const result = reusable || await extractMeetingInsights(rt, tenant, oa, actor, {
      customerName: customer!.name,
      title: doc.title,
      heldAt: doc.held_at,
      transcript: doc.body,
      automated: true,
    });
    // Retain the exact output for validation repair without another paid AI call.
    const retained = await rt.db.query(
      "UPDATE gs_demo_documents SET analysis=? WHERE id=? AND version=? AND state='processing' AND lease_until=?",
      [json({ extraction: result, extractVersion: doc.version }), docId, doc.version, lease],
    );
    requireThat(retained.changes, 409, "DOCUMENT_CHANGED", "最新版の議事録を解析中です。");
    const tracking = checkedMeetingTracking(result.tracking, doc.body);
    const current = await one(
      rt.db,
      "SELECT version,state,lease_until FROM gs_demo_documents WHERE id=?",
      [docId],
    );
    requireThat(
      current?.version === doc.version && current.state === "processing" && current.lease_until === lease,
      409,
      "DOCUMENT_CHANGED",
      "議事録が更新されました。最新版を自動解析します。",
    );
    const noteId = `${doc.id}-v${doc.version}`,
      at = now();
    await ts.batch([
      {
        sql: "UPDATE context_notes SET deleted_at=? WHERE customer_id=? AND source='self_demo' AND source_ref=? AND id<>?",
        params: [at, p.customer_id, doc.id, noteId],
      },
      {
        sql: "INSERT INTO context_notes(id,customer_id,source,source_ref,body,confirmed_by,confirmed_at,created_at) VALUES (?,?,'self_demo',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,deleted_at=NULL",
        params: [
          noteId,
          p.customer_id,
          doc.id,
          `${doc.title}\n面談日時：${doc.held_at}\n${result.summary}\n条件の原文：${tracking.conditionQuote}\n原文：\n${doc.body}`,
          actor,
          at,
          at,
        ],
      },
    ]);
    const applied = await applyDemoWish(rt, ts, p.customer_id, { id: doc.id, held_at: doc.held_at }, noteId, tracking.propertyWish);
    if (applied.applied) await holdCustomer(rt, tenant, p.customer_id,
      "議事録の条件が更新されました。最新の条件から提案を確認します。");
    // A newly confirmed meeting note resolves the pending-result hold after cancellation.
    // A still-booked appointment and a won deal remain protected.
    if (applied.applied) await common.query(
      "UPDATE customers SET stage='post_meeting',version=version+1 WHERE id=? AND stage='result_pending'",
      [p.customer_id],
    );
    await rt.db.query(
      "UPDATE gs_demo_documents SET state='ready',analysis=?,error=NULL,lease_until=NULL WHERE id=? AND version=? AND lease_until=?",
      [json({ ...result, ...applied }), docId, doc.version, lease],
    );
    await scanAssistant(rt, tenant, oa, actor, undefined, [p.customer_id], {
      generateDraft: true,
    });
    await notifyAssistant(rt, tenant, oa, actor);
  } catch (e: any) {
    await rt.db.query(
      "UPDATE gs_demo_documents SET state='error',error=?,lease_until=NULL WHERE id=? AND version=? AND lease_until=?",
      [
        e.code === "DEMO_AI_LIMIT" ||
        e.code?.startsWith("MEETING_") ||
        e.code === "DEMO_WISH_INCOMPLETE" || e.code === "DEMO_WISH_CHANGED"
          ? e.message
          : "解析を完了できませんでした。内容を確認し「解析をやり直す」を押してください。",
        docId,
        doc.version,
        lease,
      ],
    );
  }
}
export async function processDemoWork(rt: Runtime) {
  if (!rt.selfDemo) return;
  const docs = await all(
    rt.db,
    "SELECT d.id,d.user_id FROM gs_demo_documents d JOIN gs_demo_participants p ON p.user_id=d.user_id WHERE p.state='active' AND (d.state='queued' OR (d.state='processing' AND d.lease_until<?)) ORDER BY d.updated_at LIMIT 2",
    [now()],
  );
  for (const d of docs) await processDemoDocument(rt, d.user_id, d.id);
}
export async function demoSnapshot(rt: Runtime, actor: string) {
  await demoLiveState(rt);
  const { tenant, oa } = config(rt),
    p = await demoParticipant(rt, actor);
  if (!p) return { started: false, tenant, oa };
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    h = await rt.openDatabase(tenant, oa, "harness"),
    common = await rt.openDatabase(tenant, "", "common");
  const [
    customer,
    staff,
    docs,
    sources,
    proposals,
    notices,
    bookings,
    usage,
    feedback,
    messages,
  ] = await Promise.all([
    one(common, "SELECT name,stage,opt_out FROM customers WHERE id=?", [
      p.customer_id,
    ]),
    one(
      rt.db,
      "SELECT state,notifications,pair_expires_at FROM staff_line_links WHERE tenant_id=? AND user_id=?",
      [tenant, actor],
    ),
    all(
      rt.db,
      "SELECT id,title,body,held_at,version,state,analysis,error FROM gs_demo_documents WHERE user_id=? ORDER BY updated_at DESC LIMIT 10",
      [actor],
    ),
    all(
      ts,
      "SELECT id,title,data,version FROM assistant_sources WHERE json_extract(data,'$.audienceCustomerId') IS NULL OR json_extract(data,'$.audienceCustomerId')=? ORDER BY published_at DESC LIMIT 50",
      [p.customer_id],
    ),
    all(
      ts,
      "SELECT p.id,p.reason,p.draft,p.state,p.version,p.hold_reason,p.updated_at,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.customer_id=? AND a.owner_user_id=? ORDER BY p.created_at DESC LIMIT 12",
      [p.customer_id, actor],
    ),
    all(
      rt.db,
      "SELECT proposal_id,version,state FROM staff_line_notices WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20",
      [tenant, actor],
    ),
    all(
      rt.db,
      "SELECT id,starts_at,state,version,notice_state,source,details_url FROM gs_demo_bookings WHERE user_id=? ORDER BY updated_at DESC LIMIT 5",
      [actor],
    ),
    one(
      rt.db,
      "SELECT COUNT(*) AS n FROM gs_demo_actions WHERE user_id=? AND kind='ai' AND day=?",
      [actor, day()],
    ),
    all(
      ts,
      "SELECT action,category,note,at FROM assistant_feedback WHERE actor_id=? AND customer_id=? ORDER BY at DESC LIMIT 10",
      [actor, p.customer_id],
    ),
    all(
      h,
      "SELECT direction,body,occurred_at,state FROM messages WHERE customer_id=? ORDER BY occurred_at DESC LIMIT 15",
      [p.customer_id],
    ),
  ]);
  const g=await googleConfig(await googleDB(rt,tenant,oa));
  const sheetWrites=await all(ts,"SELECT source_id,state,error,updated_at,json_extract(row_json,'$[1]') title FROM demo_sheet_writes WHERE user_id=? ORDER BY updated_at DESC LIMIT 10",[actor]);
  const aiLimits=await demoAILimits(rt,actor);
  const live=await one(rt.db,"SELECT last_sync_at,error FROM gs_demo_live_state WHERE id=?",[tenant+':'+oa]);
  return {
    sheetWrites,live,
    spreadsheetUrl:g.settings.spreadsheetId?'https://docs.google.com/spreadsheets/d/'+g.settings.spreadsheetId+'/edit':null,
    started: true,
    tenant,
    oa,
    state: p.state,
    customer: p.customer_line_id && !p.pair_hash ? customer : null,
    customerPairPending: !!(p.customer_line_id && p.pair_hash),
    staff,
    notificationsUntil: p.notifications_until,
    documents: docs.map((d) => ({ ...d, analysis: parse(d.analysis, null) })),
    sources: sources.map((s) => ({ ...s, data: parse(s.data) })),
    proposals: proposals.map((q) => ({
      ...q,
      evidence: parse(q.evidence),
      notice:
        notices.find((n) => n.proposal_id === q.id && n.version === q.version)
          ?.state || null,
    })),
    bookings,
    bookingUrl: await demoBookingUrl(rt, p.customer_id),
    bookingConfigured: await demoBookingConfigured(rt),
    aiLimit: aiLimits.personal,
    aiRemaining: Math.max(0, aiLimits.personal - usage!.n),
    feedback,
    messages,
  };
}
const documentInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(20).max(20000),
    heldAt: z.string().datetime(),
    version: z.number().int().positive().optional(),
  })
  .strict();
export async function copyDemoLibraryDocument(rt: Runtime, actor: string, fileId: string, expectedVersion?: number, copyId?: string) {
  await participant(rt, actor, true);
    const { tenant, oa } = config(rt),
      ts = await rt.openDatabase(tenant, oa, "tsunagu");
    let d = await one(
      ts,
      "SELECT * FROM meeting_inbox WHERE id=? AND state NOT IN ('ignored','missing')",
      [fileId],
    );
    requireThat(d, 404, "NOT_FOUND", "議事録が見つかりません。");
    requireThat(!expectedVersion || d.version === expectedVersion, 409, "DOCUMENT_CHANGED", "議事録が更新されています。最新版の通知から紐づけてください。");
    const con = await one(
      rt.db,
      "SELECT * FROM connections WHERE id=? AND tenant_id=? AND oa_id=?",
      [d.connection_id, tenant, oa],
    );
    requireThat(
      con,
      409,
      "SOURCE_UNAVAILABLE",
      "共通の議事録接続を確認できません。下の見本から体験できます。",
    );
    let body: string;
    try {
      body = await readMeetingText(rt, con, d);
    } catch (e: any) {
      if (e.code !== "DOCUMENT_CHANGED" || expectedVersion) throw e;
      await pollDrive(rt, { tenant, oa });
      d = await one(ts, "SELECT * FROM meeting_inbox WHERE id=?", [d.id]);
      body = await readMeetingText(rt, con, d!);
    }
    const docId = copyId || "demo-note-" + id();
    await rt.db.query(
      "INSERT OR IGNORE INTO gs_demo_documents(id,user_id,title,body,held_at,updated_at) VALUES (?,?,?,?,?,?)",
      [
        docId,
        actor,
        d!.title,
        body.slice(0, 20000),
        d!.held_at || now(),
        now(),
      ],
    );

  return docId;
}

export function registerSelfDemo(app: Hono<AppEnv>) {
  const ctx = (c: any) => ({
    rt: c.env.runtime as Runtime,
    actor: c.get("principal").user.id as string,
  });
  app.get("/api/demo", async (c) => {
    const { rt, actor } = ctx(c);
    return c.json(await demoSnapshot(rt, actor));
  });
  app.post("/api/demo/start", async (c) => {
    await startDemo(c.env.runtime, c.get("principal").user);
    return c.json({ ok: true });
  });
  app.post("/api/demo/customer/pair", async (c) => {
    const { rt, actor } = ctx(c),
      p = await participant(rt, actor);
    requireThat(
      !p.customer_line_id || p.pair_hash,
      409,
      "ALREADY_PAIRED",
      "顧客用LINEは連携済みです。",
    );
    await slots(rt, actor, "pair", 5);
    const token = id().replaceAll("-", "") + id().replaceAll("-", ""),
      expiresAt = new Date(Date.now() + 600000).toISOString();
    await rt.db.query(
      "UPDATE gs_demo_participants SET pair_hash=?,pair_expires_at=?,attempts=0 WHERE user_id=?",
      [await digest(token), expiresAt, actor],
    );
    return c.json({ text: "体験 " + token, expiresAt });
  });
  app.post("/api/demo/customer/confirm", async (c) => {
    const { rt, actor } = ctx(c);
    const b = z
      .object({ code: z.string().trim().min(1).max(100) })
      .strict()
      .parse(await c.req.json());
    return c.json(await confirmDemoCustomer(rt, actor, b.code));
  });
  app.post("/api/demo/notifications", async (c) => {
    const { rt, actor } = ctx(c),
      p = await participant(rt, actor);
    const b = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const expires = b.enabled
      ? new Date(Date.now() + 2 * 3600000).toISOString()
      : null;
    await rt.db.query(
      "UPDATE gs_demo_participants SET notifications_until=? WHERE user_id=?",
      [expires, actor],
    );
    await rt.db.query(
      "UPDATE staff_line_links SET notifications=? WHERE tenant_id=? AND user_id=? AND state='active'",
      [Number(b.enabled), p.tenant_id, actor],
    );
    await demoLiveState(rt);
    await notifyDemoMeetings(rt, actor);
    await notifyAssistant(rt, p.tenant_id, config(rt).oa, actor);
    return c.json({ ok: true, expiresAt: expires });
  });
  app.get("/api/demo/library", async (c) => {
    const { rt, actor } = ctx(c);
    await participant(rt, actor);
    const { tenant, oa } = config(rt),
      ts = await rt.openDatabase(tenant, oa, "tsunagu");
    return c.json({
      documents: await all(
        ts,
        "SELECT id,title,held_at,modified_at FROM meeting_inbox WHERE state NOT IN ('ignored','missing') ORDER BY modified_at DESC LIMIT 50",
      ),
    });
  });
  app.post("/api/demo/library/:id/copy", async (c) => {
    const { rt, actor } = ctx(c);
    await participant(rt, actor, true);
    await slots(rt, actor, "copy", 6);
    const docId = await copyDemoLibraryDocument(rt, actor, c.req.param("id"));
    await notifyDemoMeetings(rt, actor);
    return c.json({ ok: true, id: docId });
  });
  app.post("/api/demo/documents", async (c) => {
    const { rt, actor } = ctx(c);
    await participant(rt, actor, true);
    const b = documentInput.parse(await c.req.json());
    await slots(rt, actor, "document", 6);
    const docId = "demo-note-" + id();
    await rt.db.query(
      "INSERT INTO gs_demo_documents(id,user_id,title,body,held_at,updated_at) VALUES (?,?,?,?,?,?)",
      [docId, actor, b.title, b.body, b.heldAt, now()],
    );
    await notifyDemoMeetings(rt, actor);
    return c.json({ ok: true, id: docId });
  });
  app.put("/api/demo/documents/:id", async (c) => {
    const { rt, actor } = ctx(c),
      p = await participant(rt, actor, true),
      b = documentInput.parse(await c.req.json());
    const r = await rt.db.query(
      "UPDATE gs_demo_documents SET title=?,body=?,held_at=?,version=version+1,state=CASE WHEN state='unlinked' THEN 'unlinked' ELSE 'queued' END,analysis=NULL,error=NULL,lease_until=NULL,updated_at=? WHERE id=? AND user_id=? AND version=? AND state<>'processing'",
      [
        b.title,
        b.body,
        b.heldAt,
        now(),
        c.req.param("id"),
        actor,
        b.version || 0,
      ],
    );
    requireThat(
      r.changes,
      409,
      "DOCUMENT_CHANGED",
      "解析中、または別の画面で更新されました。最新版を確認してください。",
    );
    await holdCustomer(
      rt,
      p.tenant_id,
      p.customer_id,
      "議事録の更新を解析中です。",
    );
    await processDemoDocument(rt, actor, c.req.param("id"));
    await notifyDemoMeetings(rt, actor);
    return c.json({ ok: true });
  });
  app.post("/api/demo/documents/:id/link", async (c) => {
    const { rt, actor } = ctx(c);
    await participant(rt, actor, true);
    const b = z
      .object({ version: z.number().int().positive(), reextract: z.boolean().default(false) })
      .strict()
      .parse(await c.req.json());
    const r = await rt.db.query(
      "UPDATE gs_demo_documents SET state='queued',error=NULL,analysis=CASE WHEN ? THEN NULL ELSE analysis END WHERE id=? AND user_id=? AND version=? AND state IN ('unlinked','error')",
      [Number(b.reextract), c.req.param("id"), actor, b.version],
    );
    requireThat(
      r.changes,
      409,
      "DOCUMENT_CHANGED",
      "この議事録は解析済み・解析中、または更新されています。",
    );
    await processDemoDocument(rt, actor, c.req.param("id"));
    await notifyDemoMeetings(rt, actor);
    return c.json({ ok: true });
  });
  app.post("/api/demo/properties/:id/retry",async c=>{
    const {rt,actor}=ctx(c),p=await participant(rt,actor,true),{tenant,oa}=config(rt);
    const ts=await googleDB(rt,tenant,oa),g=await googleConfig(ts);
    const job=await one(ts,"SELECT * FROM demo_sheet_writes WHERE source_id=? AND user_id=? AND customer_id=?",[c.req.param('id'),actor,p.customer_id]);
    requireThat(job && ['error','uncertain'].includes(job.state) && job.spreadsheet_id===g.settings.spreadsheetId,409,'SHEET_REVIEW','保存先または台帳側の変更を確認してください。');
    await ts.query("UPDATE demo_sheet_writes SET state=CASE WHEN state='error' THEN 'queued' ELSE state END,attempts=0,next_at='',config_version=? WHERE source_id=? AND state=? AND lease_id IS NULL",[g.version,job.source_id,job.state]);
    await processDemoSheetWrites(rt,job.source_id);
    await scanAssistant(rt,tenant,oa,actor,undefined,[p.customer_id],{generateDraft:true});
    await notifyAssistant(rt,tenant,oa,actor);
    return c.json({ok:true});
  });
  app.post("/api/demo/pulse",async c=>{
    const {rt,actor}=ctx(c),p=await participant(rt,actor,true),{tenant,oa}=config(rt);
    if(!p.notifications_until || p.notifications_until<=now()) return c.json({skipped:"inactive"});
    return c.json(await runValueLoop(rt,tenant,oa));
  });
  app.post("/api/demo/properties", async (c) => {
    const { rt, actor } = ctx(c),
      p = await participant(rt, actor, true),
      { tenant, oa } = config(rt);
    const b = z
      .object({
        title: z.string().trim().min(1).max(160),
        area: z.string().trim().min(1).max(60),
        price: z.number().positive().max(1e11),
        layout: z.string().regex(/^[1-9][SLDK]+$/),
        walkingMinutes: z.number().int().min(0).max(60),
        status: z.enum(["available", "sold"]).default("available"),
        requestId: z.string().uuid().optional(),
        sourceId: z
          .string()
          .regex(/^demo-property-[a-f0-9-]+$/)
          .optional(),
        version: z.number().int().positive().optional(),
      })
      .strict()
      .parse(await c.req.json());
    const ts = await rt.openDatabase(tenant, oa, "tsunagu");
    const sid = b.sourceId || "demo-property-" + (b.requestId || id());
    const job=await queueDemoSheetWrite(rt,actor,p.customer_id,sid,b);
    if(job) {
      if(job.state!=="synced") await processDemoSheetWrites(rt,sid);
      const saved=await one(ts,"SELECT state,error FROM demo_sheet_writes WHERE source_id=?",[sid]);
      if(saved?.state==='synced') {
        await scanAssistant(rt,tenant,oa,actor,undefined,[p.customer_id],{generateDraft:true});
        await notifyAssistant(rt,tenant,oa,actor);
      }
      return c.json({ok:true,id:sid,sheet:saved});
    }
    if (b.sourceId) {
      const old = await one(
        ts,
        "SELECT data,version FROM assistant_sources WHERE id=?",
        [sid],
      );
      requireThat(
        old &&
          parse(old.data).audienceCustomerId === p.customer_id &&
          old.version === b.version,
        409,
        "SOURCE_CHANGED",
        "物件が更新されています。最新の内容を確認してください。",
      );
    }
    await slots(rt, actor, "property", 8);
    const at = now();
    await upsertSource(rt, tenant, oa, {
      id: sid,
      kind: "product",
      industry: "estate",
      audienceCustomerId: p.customer_id,
      title: b.title.startsWith("【体験用】")
        ? b.title
        : "【体験用】" + b.title,
      url:
        (rt.origin.startsWith("https:")
          ? rt.origin
          : "https://self-demo.invalid") +
        "/demo/property/" +
        sid,
      publishedAt: at,
      checkedAt: at,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      summary: `体験用の架空物件。${b.area}、${b.price}円、${b.layout}、駅徒歩${b.walkingMinutes}分、所有権。`,
      tags: [b.layout, "所有権", "駅徒歩" + b.walkingMinutes + "分"],
      absentTags: ["定期借地権"],
      area: b.area,
      price: b.price,
      status: b.status,
      stock: b.status === "available" ? 1 : 0,
      property: {
        walkingMinutes: b.walkingMinutes,
        layout: b.layout,
        tenure: "所有権",
      },
    }, false, b.sourceId ? { version: b.version!, audienceCustomerId: p.customer_id } : undefined);
    await scanAssistant(rt, tenant, oa, actor, undefined, [p.customer_id], {
      generateDraft: true,
    });
    await notifyAssistant(rt, tenant, oa, actor);
    return c.json({ ok: true, id: sid });
  });
  app.post("/api/demo/proposals/:id/generate", async (c) => {
    const { rt, actor } = ctx(c), p = await participant(rt, actor, true), { tenant, oa } = config(rt);
    const b = z.object({ version: z.number().int().positive() }).strict().parse(await c.req.json());
    const ts = await rt.openDatabase(tenant, oa, "tsunagu");
    requireThat(await one(ts, "SELECT id FROM proposals WHERE id=? AND customer_id=?", [c.req.param("id"), p.customer_id]),
      404, "NOT_FOUND", "自分宛の提案が見つかりません。");
    const result = await generateAssistantDraft(rt, tenant, oa, actor, c.req.param("id"), b.version);
    await notifyAssistant(rt, tenant, oa, actor);
    return c.json(result);
  });
  app.post("/api/demo/proposals/:id/action", async (c) => {
    const { rt, actor } = ctx(c),
      p = await participant(rt, actor, true),
      { tenant, oa } = config(rt);
    const b = z
      .object({
        version: z.number().int().positive(),
        action: z.enum(["approve", "edit", "cancel", "later"]),
        draft: z.string().max(2000).optional(),
        learning: learningInput.optional(),
        feedback: decisionInput.optional(),
      })
      .strict()
      .parse(await c.req.json());
    const ts = await rt.openDatabase(tenant, oa, "tsunagu");
    requireThat(
      await one(ts, "SELECT id FROM proposals WHERE id=? AND customer_id=?", [
        c.req.param("id"),
        p.customer_id,
      ]),
      404,
      "NOT_FOUND",
      "自分宛の提案が見つかりません。",
    );
    if (b.action === "approve")
      return c.json(
        await approveAssistant(
          rt,
          tenant,
          oa,
          actor,
          c.req.param("id"),
          b.version,
        ),
      );
    if (b.action === "edit")
      await editAssistant(
        rt,
        tenant,
        oa,
        actor,
        c.req.param("id"),
        b.version,
        b.draft || "",
        { learning: b.learning },
      );
    else
      await decideAssistant(
        rt,
        tenant,
        oa,
        actor,
        c.req.param("id"),
        b.version,
        b.action,
        b.feedback,
      );
    return c.json({ ok: true });
  });
  app.post("/api/demo/finish", async (c) => {
    const { rt, actor } = ctx(c),
      p = await participant(rt, actor);
    await rt.db.query(
      "UPDATE gs_demo_participants SET notifications_until=NULL WHERE user_id=?",
      [actor],
    );
    await rt.db.query(
      "UPDATE staff_line_links SET notifications=0 WHERE tenant_id=? AND user_id=?",
      [p.tenant_id, actor],
    );
    return c.json({ ok: true });
  });
}
