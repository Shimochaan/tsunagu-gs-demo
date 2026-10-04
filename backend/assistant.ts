import { demoBookingUrl, isDemoCustomer } from "./self-demo-access.ts";
import { pendingDemoMeetings } from "./self-demo-preferences.ts";
import { normalizeTag, sourceContradiction, matchesWish, sourceContentHash, wishContentKey } from "./assistant-match.ts";
import { feedbackQuery, learningInput, decisionInput, type LearningInput } from "./assistant-learning.ts";
import { publishProposalEvent, registerProposalEvents } from "./proposal-events.ts";
import { businessProfile, registerBusiness } from "./business.ts";
import {
  registerFollowup,
  followupInputs,
  observeFollowup,
  followupCandidate,
  followupEvidenceProblem,
  matchesCondition,
  industryLabels,
  profileCondition,
} from "./followup.ts";
import { registerAssistantConnections } from "./assistant-connections.ts";
import { registerAssistantGoogle } from "./assistant-google.ts";
import { registerCustomerTestDelivery } from "./customer-test-delivery.ts";
import { registerPropertyFile } from "./property-file.ts";
import { setupEnvironment } from "./setup-readiness.ts";
import { scanInputs } from "./assistant-scan-input.ts";
import { z } from "zod";
import {
  processAssistantWork,
  claimAssistantOA,
  finishAssistantOA,
} from "./assistant-work.ts";
import type { Hono, Context } from "hono";
import { all, one, now, id, json, parse, type Row, type Database } from "./db.ts";
import type { AppEnv, Runtime } from "./runtime.ts";
import { accountFor, member, customerAccess, has } from "./access.ts";
import { requireThat, audit, digest } from "./security.ts";
import { guard } from "./sales.ts";
import { deliveryReady, sendDue } from "./delivery.ts";
import { notifyAssistant } from "./assistant-notifications.ts";
import {
  generateAssistantDraft,
  assistantContextHash,
  processAssistantDraftRepairs,
} from "./assistant-draft.ts";
import { automationSchema, automationSettings } from "./assistant-controls.ts";
import {
  discoverAssistantNews,
  syncAssistantFeed,
} from "./assistant-discovery.ts";

const hour = 3600000,
  day = 24 * hour;
const expires = (ms: number) => new Date(Date.now() + ms).toISOString();
const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();
const tags = z.array(z.string().trim().min(2).max(60)).max(20);
const https = z
  .string()
  .url()
  .max(2000)
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password;
  }, "HTTPSの公開URLを指定してください");
export const sourceSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,100}$/),
    kind: z.enum(["news", "product"]),
    audienceCustomerId: z.string().max(100).optional(),
    industry: z.enum(["estate","bridal","recruitment"]).optional(),
    title: z.string().trim().min(1).max(200),
    url: https,
    publishedAt: z.string().datetime(),
    eventAt: z.string().datetime().nullable().default(null),
    checkedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    summary: z.string().trim().min(1).max(1200),
    tags,
    absentTags: tags.default([]),
    area: z.string().max(100).nullable().default(null),
    price: z.number().nonnegative().nullable().default(null),
    status: z
      .enum(["available", "sold", "unpublished", "unknown"])
      .default("unknown"),
    stock: z.number().int().nonnegative().nullable().default(null),
    property: z.object({walkingMinutes:z.number().nonnegative(),layout:z.string().max(30),tenure:z.string().max(60)}).strict().optional(),
    discovery: z
      .object({
        publisher: z.string().max(100),
        excerpt: z.string().max(1200),
        retrievedAt: z.string().datetime(),
        query: z.string().max(40),
      })
      .strict()
      .optional(),
  })
  .strict();
const preferencesSchema = z
  .object({
    noteId: z.string().min(1),
    area: z.string().trim().min(1).max(100),
    maxPrice: z.number().positive(),
    required: tags.min(1),
    excluded: tags.default([]),
  })
  .strict();
export const isAssistant = (p: Row) =>
  String(p.trigger).startsWith("assistant:");
export function ordinaryOnly(p: Row) {
  requireThat(
    !isAssistant(p),
    409,
    "ASSISTANT_REVIEW_REQUIRED",
    "この提案はアシスタントの確認画面から操作してください。",
  );
}
export async function assistantAccess(
  rt: Runtime,
  tenant: string,
  oaId: string,
  actor: string,
  cid?: string,
  action: "read" | "edit" | "approve" | "send" = "read",
) {
  const m = await member(rt, actor, tenant),
    oa = await accountFor(rt, tenant, oaId);
  const company = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [
    tenant,
  ]);
  const common = await rt.openDatabase(tenant, "", "common");
  const customer = cid
    ? await one(common, "SELECT * FROM customers WHERE id=?", [cid])
    : null;
  checkAssistantAccess(m, oa, company, actor, customer, !!cid, action);
  return { m, oa, customer, common };
}
function checkAssistantAccess(
  m: Row | undefined,
  oa: Row | undefined,
  company: Row | null,
  actor: string,
  customer: Row | null,
  hasCustomer: boolean,
  action: "read" | "edit" | "approve" | "send",
) {
  requireThat(
    m,
    403,
    "TENANT_FORBIDDEN",
    "この企業へのアクセス権がありません。",
  );
  requireThat(oa, 404, "OA_NOT_FOUND", "公式LINEが見つかりません。");
  requireThat(
    company?.state === "active",
    403,
    "TENANT_INACTIVE",
    "企業の利用状態を確認してください。",
  );
  const settings = parse(company!.settings);
  requireThat(
    oa!.owner_user_id === actor ||
      parse(oa!.operators, []).includes(actor) ||
      (has(m!, "org_owner") &&
        (action !== "send" || settings.proxySend === true)),
    403,
    "OA_FORBIDDEN",
    "公式LINEの操作権限がありません。",
  );
  if (hasCustomer)
    requireThat(
      customer && customerAccess(m!, customer, action, settings),
      404,
      "CUSTOMER_NOT_FOUND",
      "顧客が見つからないか、操作権限がありません。",
    );
}

async function uniqueLink(
  rt: Runtime,
  tenant: string,
  oa: string,
  cid: string,
) {
  const common = await rt.openDatabase(tenant, "", "common");
  const links = await all(
    common,
    "SELECT * FROM customer_links WHERE oa_id=? AND customer_id=? AND state='confirmed'",
    [oa, cid],
  );
  return links.length === 1 ? links[0] : null;
}
async function conversation(
  rt: Runtime,
  tenant: string,
  oa: string,
  cid: string,
) {
  const h = await rt.openDatabase(tenant, oa, "harness");
  const rows = await all(
    h,
    "SELECT id,direction,body,kind,line_user_id,occurred_at,recorded_at FROM messages WHERE customer_id=? ORDER BY occurred_at DESC,id DESC LIMIT 30",
    [cid],
  );
  return { rows, hash: await digest(json(rows)) };
}
function sourceProblem(s: Row) {
  const d = parse(s.data),
    n = Date.now();
  if (sourceContradiction(d)) return sourceContradiction(d);
  if (
    Date.parse(s.published_at) > n ||
    (s.kind === "news" && Date.parse(s.published_at) < n - 7 * day)
  )
    return "公開から7日を超えた情報、または公開前の情報です。";
  if (
    Date.parse(s.checked_at) > n ||
    Date.parse(s.checked_at) < n - day ||
    s.expires_at <= now()
  )
    return "出典・在庫の再確認が必要です（確認から24時間経過または期限切れ）。";
  if (
    s.kind === "product" &&
    (d.status !== "available" || d.stock === null || d.stock < 1)
  )
    return "在庫・価格・公開状態を確認できません。";
  return null;
}
async function evidenceProblem(
  rt: Runtime,
  tenant: string,
  oa: string,
  p: Row,
  meta: Row,
) {
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    ev = parse(meta.evidence);
  if ((await pendingDemoMeetings(rt, tenant, oa, [p.customer_id])).size)
    return "新しい議事録の条件を確認中です。変更内容が確定してから提案を再確認してください。";
  if(await one(ts,"SELECT d.id FROM meeting_inbox d JOIN meeting_auto_state s ON s.file_id=d.id WHERE d.customer_id=? AND d.state NOT IN ('ignored','missing') AND s.state IN ('processing','retry','needs_review') LIMIT 1",[p.customer_id])) return "新しい議事録の反映が未完了です。原文・希望条件を確認してから提案を再作成してください。";
  const business = await businessProfile(rt, tenant);
  if ((ev.businessVersion || 0) !== business.version) return "会社の主事業・研究テーマが変更されています。最新設定から提案を確認してください。";
  if (meta.expires_at <= now())
    return "提案の有効期限が切れています。最新情報から確認してください。";
  const link = await uniqueLink(rt, tenant, oa, p.customer_id);
  if (!link || link.line_user_id !== meta.line_user_id)
    return "顧客LINEの紐付けが変更されたか、一意に確認できません。";
  const common = await rt.openDatabase(tenant, "", "common"),
    customer = await one(common, "SELECT * FROM customers WHERE id=?", [
      p.customer_id,
    ]);
  if (
    !customer ||
    customer.opt_out ||
    customer.mode !== "ai" ||
    ["won", "booked"].includes(customer.stage) ||
    (customer.stage === "result_pending" && ev.followupAction !== "reschedule")
  )
    return "顧客の配信停止・対応状況を確認してください。";
  if (customer.version !== p.customer_version)
    return "顧客情報が変更されています。再確認してください。";
  if (customer?.owner_user_id !== meta.owner_user_id)
    return "担当者が変更されています。";
  const currentConversation = await conversation(rt, tenant, oa, p.customer_id);
  const followupProblem = await followupEvidenceProblem(
    rt,
    tenant,
    oa,
    p,
    ev,
    customer,
    link.line_user_id,
    currentConversation.rows,
  );
  if (followupProblem) return followupProblem;
  if (currentConversation.hash !== ev.conversationHash)
    return "新しい会話があります。宛先・最新の会話から提案を作り直してください。";
  if (ev.meetingEventId) {
    const h=await rt.openDatabase(tenant,oa,"harness"),event=await one(h,"SELECT * FROM events WHERE id=? AND customer_id=? AND type='meeting.trigger'",[ev.meetingEventId,p.customer_id]);
    if (!event || event.state!=="pending" || await digest(event.payload)!==ev.meetingEventHash) return "確認した次回予定が変更されました。";
    const due=parse(event.payload).scheduledAt;
    if (!due || due>now() || Date.parse(due)<Date.now()-7*day) return "予定の日時・鮮度を確認してください。";
  }
  if (ev.sourceId) {
    const s = await one(ts, "SELECT * FROM assistant_sources WHERE id=?", [
      ev.sourceId,
    ]);
    if (!s || s.version !== ev.sourceVersion)
      return "ニュース・商品情報が変更されています。内容を再確認してください。";
    if ((parse(s.data).audienceCustomerId && parse(s.data).audienceCustomerId !== p.customer_id)) return "この体験者向けの情報ではありません。";
    if (rt.selfDemo && await one(ts,"SELECT source_id FROM demo_sheet_writes WHERE source_id=? AND state<>'synced'",[s.id])) return "商品マスターへの保存を確認中です。";
    const reason = sourceProblem(s);
    if (reason) return reason;
  }
  if (ev.noteId) {
    const note = await one(
      ts,
      "SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",
      [ev.noteId, p.customer_id],
    );
    if (!note || (await digest(json(note))) !== ev.noteHash)
      return "根拠の商談メモが変更・削除されています。";
  }
  if (p.state!=='sent' && ev.preferences && ev.sourceId && ev.sourceContentHash && await deliveredSameProperty(ts,p.customer_id,ev.sourceId,ev.sourceContentHash,ev.businessVersion||0,ev.preferences))
    return "同じ希望条件・同じ物件内容のご案内は送信済みです。";
  if (ev.preferenceVersion) {
    const pref = await one(
      ts,
      "SELECT * FROM assistant_preferences WHERE customer_id=?",
      [p.customer_id],
    );
    if (pref?.version !== ev.preferenceVersion)
      return "お客様の希望条件が更新されています。";
    for(const ref of parse(pref?.data).inheritedNotes || []) {
      const n=await one(ts,"SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",[ref.id,p.customer_id]);
      if(!n || await digest(json(n))!==ref.hash) return "引き継いだ希望条件の出典が変更されています。最新条件を確認してください。";
    }
  }
  if (
    ev.aiContextHash &&
    ev.aiContextHash !== (await assistantContextHash(rt, tenant, oa, p))
  )
    return "AI文案が参照した会話・商談メモ・希望条件が変更されています。最新情報から提案を確認してください。";
  return null;
}
export async function assistantGuard(
  rt: Runtime,
  tenant: string,
  oa: string,
  p: Row,
) {
  if (!isAssistant(p)) return null;
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    meta = await one(
      ts,
      "SELECT * FROM assistant_proposals WHERE proposal_id=?",
      [p.id],
    );
  return meta
    ? evidenceProblem(rt, tenant, oa, p, meta)
    : "提案の根拠を確認できません。";
}
export async function assistantDeliveryGuard(
  rt: Runtime,
  tenant: string,
  oa: string,
  p: Row,
  item: Row,
) {
  if (!isAssistant(p)) return;
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    snap = await one(
      ts,
      "SELECT * FROM assistant_approvals WHERE proposal_id=? AND version=?",
      [p.id, p.version],
    );
  const meta = await one(
    ts,
    "SELECT * FROM assistant_proposals WHERE proposal_id=?",
    [p.id],
  );
  requireThat(
    snap &&
      meta &&
      snap.body === item.body &&
      snap.body === json([{ type: "text", text: p.draft }]) &&
      snap.line_user_id === item.line_user_id &&
      snap.customer_id === item.customer_id &&
      snap.actor_id === p.approved_by &&
      snap.evidence === meta.evidence &&
      snap.scheduled_at === item.scheduled_at,
    409,
    "APPROVAL_CHANGED",
    "承認時の本文・宛先・根拠と一致しません。",
  );
}
async function deliveredSameProperty(db: Database, customer: string, source: string, contentHash: string, businessVersion: number, wish: Row) {
  const delivered=await all(db,"SELECT a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.customer_id=? AND p.state='sent' AND json_extract(a.evidence,'$.sourceId')=? AND json_extract(a.evidence,'$.sourceContentHash')=? AND COALESCE(json_extract(a.evidence,'$.businessVersion'),0)=?",[customer,source,contentHash,businessVersion]);
  return delivered.some(r=>{const prior=parse(r.evidence).preferences;return prior?.area && wishContentKey(prior)===wishContentKey(wish);});
}

export async function upsertSource(
  rt: Runtime,
  tenant: string,
  oa: string,
  input: unknown,
  monotonic = false,
  expected?: { version: number; audienceCustomerId: string },
) {
  const s = sourceSchema.parse(input);
  requireThat(!sourceContradiction(s),422,"SOURCE_CONTRADICTION",sourceContradiction(s)||"");
  const business = await businessProfile(rt,tenant);
  requireThat(!business.industry || !s.industry || s.industry===business.industry,409,"SOURCE_INDUSTRY_MISMATCH","会社の主事業と異なる情報元です。");
  if (business.industry) s.industry = business.industry;
  requireThat(
    Date.parse(s.checkedAt) <= Date.now() + 60000 &&
      Date.parse(s.expiresAt) > Date.parse(s.checkedAt),
    400,
    "SOURCE_DATES_INVALID",
    "確認日時・有効期限を確認してください。",
  );
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    data = json(s);
  // Check a caller's version and ownership in the write itself, including when
  // the source was removed after the earlier read. A stale edit cannot recreate it.
  const saved = await ts.query(
    "INSERT INTO assistant_sources(id,kind,title,url,published_at,event_at,checked_at,expires_at,data,updated_at) " +
      (expected
        ? "SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_sources WHERE id=? AND version=? AND json_extract(data,'$.audienceCustomerId')=?)"
        : "VALUES (?,?,?,?,?,?,?,?,?,?)") +
      " ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,url=excluded.url,published_at=excluded.published_at,event_at=excluded.event_at,checked_at=excluded.checked_at,expires_at=excluded.expires_at,data=excluded.data,version=version+1,updated_at=excluded.updated_at WHERE data<>excluded.data" +
      (monotonic ? " AND checked_at<excluded.checked_at" : ""),
    [
      s.id,
      s.kind,
      s.title,
      s.url,
      s.publishedAt,
      s.eventAt,
      s.checkedAt,
      s.expiresAt,
      data,
      now(),
      ...(expected ? [s.id, expected.version, expected.audienceCustomerId] : []),
    ],
  );
  if (expected) requireThat(saved.changes, 409, "SOURCE_CHANGED", "物件が更新されています。最新の内容を確認してください。");
}
export async function scanAssistant(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor?: string,
  kindFilter?: "reply" | "opportunity",
  customerIds?: string[],
  control: {
    shouldYield?: () => boolean;
    allowAutoAI?: boolean;
    generateDraft?: boolean;
    reviewRevisions?: Record<string, string>;
  } = {},
) {
  let aiGenerated = 0;
  const processed: string[] = [],
    deferred: Record<string, string> = {};
  const ts = await rt.openDatabase(tenant, oa, "tsunagu");
  const automation = await automationSettings(ts);
  const business = await businessProfile(rt, tenant);
  const aiDay = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const autoAI =
    control.allowAutoAI !== false &&
    (automation.autoDraft || control.generateDraft === true) &&
    !!rt.ai?.apiKey &&
    (rt.selfDemo || ((
      await one(
        ts,
        "SELECT used FROM assistant_budget WHERE kind='ai' AND day=?",
        [aiDay],
      )
     )?.used || 0) < 20);
  if (
    !actor &&
    !(
      await one(ts, "SELECT enabled FROM assistant_settings WHERE id='default'")
    )?.enabled
  )
    return { created: 0, processed, deferred, aiGenerated };
  if (actor) await assistantAccess(rt, tenant, oa, actor);
  const company = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [
    tenant,
  ]);
  if (company?.state !== "active")
    return { created: 0, processed, deferred, aiGenerated };
  const common = await rt.openDatabase(tenant, "", "common"),
    h = await rt.openDatabase(tenant, oa, "harness");
  const sources = (
    await all(
      ts,
      rt.selfDemo ? "SELECT * FROM assistant_sources WHERE id NOT IN (SELECT source_id FROM demo_sheet_writes WHERE state<>'synced') ORDER BY published_at DESC LIMIT 100" : "SELECT * FROM assistant_sources ORDER BY published_at DESC LIMIT 100",
    )
  ).filter((s) => !sourceProblem(s) && (!business.industry || parse(s.data).industry === business.industry));
  const customers = await all(
    common,
    customerIds
      ? `SELECT * FROM customers WHERE id IN (${customerIds.map(() => "?").join(",")})`
      : "SELECT DISTINCT c.* FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE l.oa_id=? AND l.state='confirmed' AND c.mode='ai' AND c.opt_out=0 AND c.stage<>'won' ORDER BY c.id LIMIT 200",
    customerIds || [oa],
  );
  let created = 0;
  const byId = new Map(customers.map((c) => [c.id, c]));
  const ordered = customerIds
    ? customerIds.map((cid) => byId.get(cid) || { id: cid, missing: true })
    : customers;
  const meetingEvents = await all(h,"SELECT * FROM events WHERE type='meeting.trigger' AND state='pending' AND customer_id IN (SELECT value FROM json_each(?)) AND json_extract(payload,'$.scheduledAt')<=? AND json_extract(payload,'$.scheduledAt')>? ORDER BY occurred_at DESC LIMIT 100",[json(customers.map(x=>x.id)),now(),new Date(Date.now()-7*day).toISOString()]);
  const input =
    customerIds && customers.length
      ? await scanInputs(
          rt.db,
          common,
          h,
          ts,
          tenant,
          oa,
          customers,
          actor,
          sources.length > 0 || meetingEvents.length > 0,
        )
      : null;
  const profiles =
    input?.profiles ||
    new Map(
      (
        await all(
          ts,
          "SELECT * FROM followup_profiles WHERE customer_id IN (SELECT value FROM json_each(?))",
          [json(customers.map((c) => c.id))],
        )
      ).map((p) => [p.customer_id, p]),
    );
  const followups = await followupInputs(h, ts, [...profiles.values()]);
  const pendingMeetings=new Set((await all(ts,"SELECT DISTINCT d.customer_id FROM meeting_inbox d JOIN meeting_auto_state s ON s.file_id=d.id WHERE d.customer_id IN (SELECT value FROM json_each(?)) AND d.state NOT IN ('ignored','missing') AND s.state IN ('processing','retry','needs_review')",[json(customers.map(c=>c.id))])).map(d=>d.customer_id));

  for (const cid of await pendingDemoMeetings(rt, tenant, oa, customers.map(c => c.id))) pendingMeetings.add(cid);
  for (const customer of ordered) {
    if (control.shouldYield?.()) break;
    processed.push(customer.id);
    if (customer.missing) continue;
    if(pendingMeetings.has(customer.id)) continue;
    try {
      if (input)
        checkAssistantAccess(
          input.members.get(actor || customer.owner_user_id),
          input.account,
          company,
          actor || customer.owner_user_id,
          customer,
          true,
          "edit",
        );
      else
        await assistantAccess(
          rt,
          tenant,
          oa,
          actor || customer.owner_user_id,
          customer.id,
          "edit",
        );
    } catch {
      continue;
    }
    const links = input?.links.get(customer.id) || [];
    const link = input
      ? links.length === 1
        ? links[0]
        : null
      : await uniqueLink(rt, tenant, oa, customer.id);
    if (!link) continue;
    const rows = input
      ? input.messages.get(customer.id) || []
      : (await conversation(rt, tenant, oa, customer.id)).rows;
    const hash = await digest(json(rows));
    const profile = profiles.get(customer.id);
    const incompatible = business.industry && profile && parse(profile.data).industry !== business.industry;
    if (incompatible) continue;
    const journey = profile
      ? await observeFollowup(
          rt,
          tenant,
          oa,
          profile,
          customer,
          link.line_user_id,
          rows,
          followups.get(customer.id),
        )
      : null;
    // 直近の連続受信をまとめる。最後の着信から90秒待ち、送信済み返信を再提案しない。
    const burst: Row[] = [];
    for (const m of rows) {
      if (m.direction !== "inbound") break;
      burst.push(m);
    }
    if (
      burst.some((m) =>
        /配信停止|連絡不要|連絡しないで|送らないで|案内不要|不要です|結構です/.test(
          m.body,
        ),
      )
    ) {
      await common.query(
        "UPDATE customers SET opt_out=1,version=version+1 WHERE id=? AND opt_out=0",
        [customer.id],
      );
      await ts.query(
        "UPDATE proposals SET state='held',hold_reason='お客様から連絡不要の意思表示がありました。' WHERE customer_id=? AND state IN ('pending','approved')",
        [customer.id],
      );
      await h.query(
        "UPDATE outbox SET state='held',error_code='OPT_OUT' WHERE customer_id=? AND state='pending'",
        [customer.id],
      );
      continue;
    }
    const previous = input
      ? input.previous.get(customer.id) || []
      : await all(
          ts,
          "SELECT p.*,a.expires_at,a.snoozed_until,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.customer_id=? AND p.state IN ('pending','approved','held')",
          [customer.id],
        );
    const reviewKey = `review:${customer.id}`;
    const reviewRevision = control.reviewRevisions?.[customer.id];
    const checkpoint =
      previous.length && reviewRevision !== undefined
        ? await one(
            ts,
            "SELECT cursor FROM assistant_ingest_cursors WHERE id=?",
            [reviewKey],
          )
        : null;
    const checkpointData = checkpoint ? parse(checkpoint.cursor) : {};
    let reviewedThrough =
      checkpointData.revision === reviewRevision
        ? checkpointData.after || ""
        : "";
    const yieldReview = async () => {
      if (reviewRevision !== undefined)
        await ts.query(
          "INSERT INTO assistant_ingest_cursors(id,cursor) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor",
          [
            reviewKey,
            json({
              revision: reviewRevision,
              after: reviewedThrough,
              active: activeProposal,
            }),
          ],
        );
      processed.pop();
      return { created, processed, deferred, aiGenerated };
    };
    let activeProposal =
      checkpointData.revision === reviewRevision && !!checkpointData.active;
    for (const p of previous.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      if (p.id <= reviewedThrough) continue;
      if (control.shouldYield?.()) return await yieldReview();
      const reason = await assistantGuard(rt, tenant, oa, p);
      if (reason) {
        await ts.query(
          "UPDATE proposals SET state='expired',hold_reason=? WHERE id=? AND version=? AND state IN ('pending','approved','held')",
          [reason, p.id, p.version],
        );
        await h.query(
          "UPDATE outbox SET state='cancelled',error_code='EVIDENCE_CHANGED' WHERE proposal_id=? AND state IN ('pending','held')",
          [p.id],
        );
      }
      // A rejected AI draft stays reviewable, but must not block a different new source forever.
      const aiBlocked = p.state === "held" && parse(p.evidence).draftMode === "blocked";
      if (!reason && !aiBlocked && ["pending", "approved", "held"].includes(p.state))
        activeProposal = true;
      reviewedThrough = p.id;
    }
    if (checkpoint)
      await ts.query("DELETE FROM assistant_ingest_cursors WHERE id=?", [
        reviewKey,
      ]);
    if (
      customer.opt_out ||
      customer.mode !== "ai" ||
      ["won", "booked"].includes(customer.stage) ||
      (customer.stage === "result_pending" && journey?.action !== "reschedule")
    )
      continue;
    if (profile && (journey?.problem || activeProposal)) continue;
    if (
      journey &&
      [
        "booking_review",
        "booked",
        "result_pending",
        "completed",
        "stopped",
        "manual_review",
      ].includes(journey.state)
    )
      continue;
    if (burst.length && Date.parse(burst[0].recorded_at) >= Date.now() - 90000)
      deferred[customer.id] = new Date(
        Date.parse(burst[0].recorded_at) + 90001,
      ).toISOString();
    if (deferred[customer.id]) continue;
    if (kindFilter === "reply" && !burst.length) continue;
    if (kindFilter === "opportunity" && burst.length) continue;
    const noteRows = input
      ? input.notes.get(customer.id) || []
      : await all(
          ts,
          "SELECT * FROM context_notes WHERE customer_id=? AND confirmed_by IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30",
          [customer.id],
        );
    const meetingEvent = meetingEvents.find(e=>e.customer_id===customer.id && noteRows.some(n=>n.id===parse(e.payload).noteId));
    const lastOutbound=rows.find(m=>m.direction==="outbound");
    if (!burst.length && !["promise","reschedule"].includes(journey?.action || "") && lastOutbound && Date.parse(lastOutbound.occurred_at)>Date.now()-day) {
      // New information is prepared for explicit human approval; generic nudges still wait.
      if (!sources.length) {
        deferred[customer.id]=new Date(Date.parse(lastOutbound.occurred_at)+day).toISOString();
        continue;
      }
    }
    const pref = input
      ? input.preferences.get(customer.id)
      : await one(
          ts,
          "SELECT * FROM assistant_preferences WHERE customer_id=?",
          [customer.id],
        );
    let kind = "",
      key = "",
      reason = "",
      draft = "",
      evidence: Row = {
        businessVersion: business.version,
        businessIndustry: business.industry,
        conversationHash: hash,
        draftMode: "template",
        ...(profile
          ? {
              followupVersion: profile.version,
              profileSource: parse(profile.evidence),
              condition: parse(profile.data).conditionQuote,
              stalled: parse(profile.data).stalledQuote,
              ...(parse(profile.data).industry === "recruitment"
                ? {
                    industry: "recruitment",
                    jobWish: parse(profile.data).jobWishQuote || "",
                    jobChangeTiming:
                      parse(profile.data).jobChangeTimingQuote || "",
                  }
                : {}),
            }
          : {}),
        draftDetail: rt.ai?.apiKey
          ? "参考テンプレートです。AI文案生成は管理者の設定またはこの提案の生成ボタンで実行できます。"
          : "AI未接続のため参考テンプレートです。内容を確認・編集してください。",
      },
      expiry = expires(day);
    if (
      burst.length &&
      burst[0].line_user_id === link.line_user_id &&
      Date.parse(burst[0].occurred_at) > Date.now() - day &&
      Date.parse(burst[0].recorded_at) < Date.now() - 90000 &&
      burst.every((m) => m.kind === "text")
    ) {
      const snippets = burst
        .slice(0, 3)
        .reverse()
        .map((m) => String(m.body).replace(/\s+/g, " ").slice(0, 100));
      kind = "reply";
      evidence.priority = 10;
      key = `reply:${customer.id}:${burst[0].id}`;
      reason = `${customer.name}さんから${burst.length}件の返信があります。「${snippets.join(" / ")}」への返答を確認しましょう。`;
      draft = `ご連絡ありがとうございます。${snippets.length === 1 ? `「${snippets[0]}」の件、` : "いただいた内容を"}確認してお返事します。`;
      evidence = {
        ...evidence,
        messageIds: burst.map((m) => m.id),
        messages: snippets,
      };
    } else if (
      (!burst.length ||
        journey?.action === "promise" ||
        journey?.action === "reschedule") &&
      journey?.action &&
      journey.action !== "no_reply"
    ) {
      const candidate = followupCandidate(profile!, journey)!;
      kind = "followup";
      key = candidate.key;
      reason = candidate.reason;
      draft = candidate.draft;
      evidence = { ...evidence, ...candidate.evidence };
    } else if (!burst.length && meetingEvent && (!profile || journey?.allowOpportunity)) {
      const payload=parse(meetingEvent.payload),note=noteRows.find(n=>n.id===payload.noteId)!;
      kind="followup";key=`meeting:${customer.id}:${meetingEvent.id}`;
      reason=`確認済みの議事録で予定した連絡時期になりました：${payload.intent}`;
      draft=`先日のご相談について、その後のご状況はいかがでしょうか。よろしければ、${business.meeting}で一緒に確認しませんか。`;
      evidence={...evidence,priority:20,timingRule:"confirmed_meeting_trigger",meetingEventId:meetingEvent.id,meetingEventHash:await digest(meetingEvent.payload),noteId:note.id,noteBody:note.body,noteHash:await digest(json(note)),promiseAt:payload.scheduledAt};
    } else if (!burst.length) {
      for (const s of sources) {
        const audience = parse(s.data).audienceCustomerId;
        if ((audience && audience !== customer.id)) continue;
        if (control.shouldYield?.()) return await yieldReview();
        const d = parse(s.data),
          wish = pref ? parse(pref.data) : null;
        let inheritedValid=true;
        for(const ref of wish?.inheritedNotes || []) {
          const n=await one(ts,"SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",[ref.id,customer.id]);
          if(!n || await digest(json(n))!==ref.hash) inheritedValid=false;
        }
        if(!inheritedValid) continue;
        const note =
          s.kind === "news"
            ? noteRows.find((n) =>
                d.tags.some((tag: string) => norm(n.body).includes(norm(tag))),
              )
            : noteRows.find((n) => n.id === pref?.note_id);
        // Confirmed structured wishes take precedence over extracted priority keywords.
        if (s.kind === "news" && !note) continue;
        if (s.kind === "product" && profile && !wish && !matchesCondition(profile, s)) continue;
        if (!profile && !note) continue;
        if (s.kind === "product" && ((!profile && !wish) || (wish && !matchesWish(d,wish)))) continue;
        const contentHash = await sourceContentHash(s);
        if(await one(ts,"SELECT e.id FROM assistant_feedback e JOIN assistant_feedback a ON a.proposal_id=e.proposal_id AND a.version=e.version AND a.action='approved' AND a.excluded=0 WHERE e.category='fact' AND e.source_id=? AND json_extract(e.details,'$.sourceContentHash')=? AND e.excluded=0 LIMIT 1",[s.id,contentHash])) continue;
        // Reconfirming the same wishes in another meeting must not reoffer an
        // unchanged property already delivered to this customer.
        if(s.kind==='product' && wish && await deliveredSameProperty(ts,customer.id,s.id,contentHash,business.version,wish)) continue;
        // Deduplicate semantic updates, not polling time or row version counters.
        if (await one(ts,"SELECT p.id FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.customer_id=? AND json_extract(a.evidence,'$.sourceId')=? AND json_extract(a.evidence,'$.sourceContentHash')=? AND COALESCE(json_extract(a.evidence,'$.businessVersion'),0)=? AND COALESCE(json_extract(a.evidence,'$.preferenceVersion'),0)=? AND COALESCE(json_extract(a.evidence,'$.followupVersion'),0)=? LIMIT 1",[customer.id,s.id,contentHash,business.version,pref?.version||0,profile?.version||0])) continue;
        kind = s.kind;
        key = `${kind}:${customer.id}:${s.id}:${contentHash}:${pref?.version || 0}${profile ? `:profile:${profile.version}` : ""}`;
        if (
          await one(
            ts,
            "SELECT proposal_id FROM assistant_proposals WHERE dedupe_key=?",
            [key],
          )
        ) {
          kind = "";
          continue;
        }
        const topic = d.tags
          .filter((tag: string) =>
            norm(
              s.kind === "news" ? note!.body : wish && note ? note.body : profile ? profileCondition(parse(profile.data)) : note!.body,
            ).includes(norm(tag)),
          )
          .join("・");
        reason =
          kind === "news"
            ? `確認した発言・メモの「${topic}」に関連する記事が公開されました。個別の条件への適用は未確認です。`
            : wish && note
              ? `ご希望の${wish.area}・予算${wish.maxPrice.toLocaleString("ja-JP")}円以内・${wish.required.join("、")}に一致する新着です。在庫確認 ${s.checked_at}。`
              : profile
              ? `確認済みの条件「${profileCondition(parse(profile.data))}」と新着情報のタグが一致しました。詳しい適用条件は担当者が確認してください。`
              : `ご希望の${wish.area}・予算${wish.maxPrice.toLocaleString("ja-JP")}円以内・${wish.required.join("、")}に一致する新着です。在庫確認 ${s.checked_at}。`;
        draft =
          kind === "news"
            ? `ご相談いただいた${topic}に関連する記事がありました。\n${s.title}\n${s.url}\n条件によって内容が異なるので、ご希望でしたら一緒に確認しませんか。`
            : `${profile ? "ご相談の条件に関連する" : "ご希望に合う"}「${s.title}」が新しく入りました。\n${profile ? d.summary : `${d.area}・${d.price.toLocaleString("ja-JP")}円`}\n${s.url}\n在庫は確認時点の情報です。よろしければ、詳しい内容をお話ししませんか。`;
        if (profile) {
          const industry = parse(profile.data).industry,
            invitation = industryLabels[industry];
          draft =
            kind === "news"
              ? `ご相談いただいた${topic}に関連する記事がありました。\n${s.title}\n${s.url}\n個別の条件への適用は未確認です。よろしければ、${invitation}で一緒に確認しませんか。`
              : `ご相談の条件に関連する「${s.title}」が新しく入りました。\n${d.summary}\n${s.url}\n在庫は確認時点の情報です。詳しい条件も含め、${invitation}で一緒に確認しませんか。`;
          if (industry === "recruitment" && kind === "product")
            draft = `ご希望の条件に関連する求人「${s.title}」をご紹介します。\n${d.summary}\n${s.url}\n募集状況・募集枠は確認時点の情報です。ご希望の求人や転職希望時期について、キャリア面談でお話ししませんか。`;
        }
        evidence = {
          ...evidence,
          priority: 30,
          sourceId: s.id,
          sourceVersion: s.version,
          sourceContentHash: contentHash,
          lastContactAt: !burst.length && lastOutbound ? lastOutbound.occurred_at : null,
          title: s.title,
          url: s.url,
          publishedAt: s.published_at,
          eventAt: s.event_at,
          checkedAt: s.checked_at,
          summary: d.summary,
          discovery: d.discovery,
          ...(note
            ? {
                noteId: note.id,
                noteBody: note.body,
                noteHash: await digest(json(note)),
              }
            : {}),
          ...(kind === "product" && pref
            ? { preferenceVersion: pref!.version, preferences: wish, condition: `${wish.area}・${wish.maxPrice}円以内・${wish.required.join("、")}` }
            : {}),
        };
        expiry = new Date(
          Math.min(
            Date.parse(expiry),
            Date.parse(s.expires_at),
            Date.parse(s.checked_at) + day,
            s.kind === "news" ? Date.parse(s.published_at) + 7 * day : Infinity,
          ),
        ).toISOString();
        break;
      }
    }
    if (!kind && !burst.length && journey?.action === "no_reply") {
      const candidate = followupCandidate(profile!, journey)!;
      kind = "followup";
      key = candidate.key;
      reason = candidate.reason;
      draft = candidate.draft;
      evidence = { ...evidence, ...candidate.evidence };
    }
    if (!kind) continue;
    evidence.timingRule ||= kind === "reply" ? "inbound_burst_settled" : evidence.followupAction || "confirmed_condition_match";
    if (business.version) key += `:business:${business.version}`;
    if (business.industry && !profile && kind !== "reply") draft += `\nよろしければ、${business.meeting}でお話ししませんか。`;
    if(await isDemoCustomer(rt, customer.id)) draft += "\n日程予約（体験用）："+await demoBookingUrl(rt,customer.id);
    const pid = id(),
      at = now();
    await ts.batch([
      {
        sql: "INSERT OR IGNORE INTO assistant_proposals(proposal_id,dedupe_key,kind,line_user_id,owner_user_id,evidence,expires_at) VALUES (?,?,?,?,?,?,?)",
        params: [
          pid,
          key,
          kind,
          link.line_user_id,
          customer.owner_user_id,
          json(evidence),
          expiry,
        ],
      },
      {
        sql: "INSERT INTO proposals(id,customer_id,trigger,reason,draft,customer_version,history_cursor,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_proposals WHERE proposal_id=?)",
        params: [
          pid,
          customer.id,
          `assistant:${kind}`,
          reason,
          draft,
          customer.version,
          rows[0]?.recorded_at || at,
          at,
          at,
          pid,
        ],
      },
    ]);
    if (await one(ts, "SELECT id FROM proposals WHERE id=?", [pid])) {
      created++;
      await publishProposalEvent(rt,tenant,oa,{id:pid,version:1,customer_id:customer.id,owner_user_id:customer.owner_user_id,evidence:json(evidence),kind,reason,expires_at:expiry});
      if (autoAI && kind !== "followup") {
        await generateAssistantDraft(
          rt,
          tenant,
          oa,
          actor || customer.owner_user_id,
          pid,
          1,
          "",
          { automatic: true },
        );
        await processAssistantDraftRepairs(rt, tenant, oa, pid);
        aiGenerated++;
        // 定期処理1回につきAIは1件。次回は未提案のお客様へ進む。
        break;
      }
    }
    if (created >= 20) break;
  }
  return { created, processed, deferred, aiGenerated };
}

export async function approveAssistant(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor: string,
  pid: string,
  version: number,
  expectedHash?: string,
) {
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    h = await rt.openDatabase(tenant, oa, "harness");
  const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [pid]);
  requireThat(p && isAssistant(p), 404, "NOT_FOUND", "提案が見つかりません。");
  const access = await assistantAccess(
    rt,
    tenant,
    oa,
    actor,
    p.customer_id,
    "send",
  );
  requireThat(
    p.version === version &&
      (!expectedHash || expectedHash === (await digest(p.draft))),
    409,
    "VERSION_CONFLICT",
    "文面が変更されています。最新の提案を開いてください。",
  );
  if (["sent", "sending", "uncertain"].includes(p.state))
    return { ok: true, state: p.state, queued: false };
  requireThat(
    !(await one(
      ts,
      "SELECT id FROM assistant_runs WHERE proposal_id=? AND kind='draft' AND state='running' AND version IN (?,?)",
      [pid, version, version - 1],
    )),
    409,
    "AI_RUNNING",
    "AIが文案を作成中です。完了後の最新版を確認してください。",
  );
  requireThat(
    ["pending", "approved"].includes(p.state),
    409,
    "REVIEW_REQUIRED",
    "保留・取消済みです。最新の提案を確認してください。",
  );
  requireThat(
    access.oa.state === "ready" && (await deliveryReady(rt, tenant, oa)),
    409,
    "DELIVERY_NOT_CONNECTED",
    "顧客向けHarness配送が未接続です。送信は予約されていません。",
  );
  const reason = await guard(rt, tenant, oa, p);
  requireThat(!reason, 409, "REVIEW_REQUIRED", reason || "");
  const meta = (await one(
    ts,
    "SELECT * FROM assistant_proposals WHERE proposal_id=?",
    [pid],
  ))!;
  const body = json([{ type: "text", text: p.draft }]),
    at = now();
  requireThat(!rt.customerTestDelivery?.enabled || await rt.customerTestDelivery.allows(meta.line_user_id,rt,actor,p.customer_id),
    403,"CUSTOMER_TEST_RECIPIENT","この顧客はテスト送信の許可リストに含まれていません。");
  await ts.batch([
    {
      sql: "UPDATE proposals SET state='approved',approved_by=?,approved_version=version,scheduled_at=COALESCE(scheduled_at,?),hold_reason=NULL,updated_at=? WHERE id=? AND version=? AND state IN ('pending','approved')",
      params: [actor, at, at, pid, version],
    },
    {
      sql: "INSERT OR IGNORE INTO assistant_approvals(proposal_id,version,body,line_user_id,customer_id,actor_id,scheduled_at,evidence) SELECT id,version,?,?,?,?,scheduled_at,? FROM proposals WHERE id=? AND version=? AND state='approved' AND approved_by=?",
      params: [
        body,
        meta.line_user_id,
        p.customer_id,
        actor,
        meta.evidence,
        pid,
        version,
        actor,
      ],
    },
    {
      sql: "INSERT OR IGNORE INTO proposal_versions(proposal_id,version,draft,actor_id,at) SELECT id,version,draft,?,? FROM proposals WHERE id=? AND version=? AND state='approved'",
      params: [actor, at, pid, version],
    },
    feedbackQuery(p, meta, actor, "approved", p.draft),
  ]);
  const fresh = await one(ts, "SELECT * FROM proposals WHERE id=?", [pid]),
    snap = await one(
      ts,
      "SELECT * FROM assistant_approvals WHERE proposal_id=? AND version=?",
      [pid, version],
    );
  requireThat(
    fresh?.state === "approved" &&
      fresh.version === version &&
      snap?.body === body &&
      snap.actor_id === actor,
    409,
    "VERSION_CONFLICT",
    "提案が変更されています。",
  );
  await h.query(
    "INSERT OR IGNORE INTO outbox(id,customer_id,line_user_id,proposal_id,proposal_version,body,scheduled_at,retry_key) VALUES (?,?,?,?,?,?,?,?)",
    [
      `${pid}:${version}`,
      p.customer_id,
      snap.line_user_id,
      pid,
      version,
      snap.body,
      snap.scheduled_at,
      `${oa}:${pid}:${version}`,
    ],
  );
  await audit(rt.db, actor, "assistant.approved", pid, tenant, { version });
  if (rt.deliveryEnabled) await sendDue(rt, tenant, oa, rt.customerTestDelivery ? `${pid}:${version}` : undefined);
  return {
    ok: true,
    state: (
      await one(h, "SELECT state FROM outbox WHERE id=?", [`${pid}:${version}`])
    )?.state,
    queued: true,
  };
}
export async function decideAssistant(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor: string,
  pid: string,
  version: number,
  action: "cancel" | "later",
  decision = { reason: "unspecified", note: "" },
) {
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    h = await rt.openDatabase(tenant, oa, "harness");
  const p = await one(ts, "SELECT * FROM proposals WHERE id=?", [pid]);
  requireThat(p && isAssistant(p), 404, "NOT_FOUND", "提案が見つかりません。");
  await assistantAccess(rt, tenant, oa, actor, p.customer_id, "approve");
  if (p.state === "cancelled" && action === "cancel") return;
  const meta = (await one(ts, "SELECT * FROM assistant_proposals WHERE proposal_id=?", [pid]))!;
  const changes = await ts.batch([{sql:
    "UPDATE proposals SET state=?,approved_by=NULL,approved_version=NULL,hold_reason=?,updated_at=? WHERE id=? AND version=? AND state IN ('pending','approved','held')",
    params: [
      action === "cancel" ? "cancelled" : "pending",
      action === "cancel" ? "担当者が見送りました。" : null,
      now(),
      pid,
      version,
    ],
  }, feedbackQuery(p, meta, actor, action, p.draft, decision)]);
  const result = changes[0];
  requireThat(
    result.changes,
    409,
    "CANNOT_CANCEL",
    "送信開始後、期限切れ、または変更済みの提案です。最新状態を確認してください。",
  );
  await ts.query(
    "UPDATE assistant_proposals SET snoozed_until=? WHERE proposal_id=?",
    [action === "later" ? expires(4 * hour) : null, pid],
  );
  await h.query(
    "UPDATE outbox SET state='cancelled',error_code='CANCELLED_BY_HUMAN' WHERE proposal_id=? AND state IN ('pending','held')",
    [pid],
  );
  // laterも承認済みなら版を更新し、取消済みoutboxを復活させない。
  if (action === "later")
    await ts.query(
      "UPDATE proposals SET version=version+1,scheduled_at=NULL WHERE id=? AND version=? AND state='pending'",
      [pid, version],
    );
  await audit(rt.db, actor, `assistant.${action}`, pid, tenant, { version });
}
const base = "/api/tenants/:tenantId/accounts/:oaId/assistant";
export function registerAssistant(app: Hono<AppEnv>) {
  registerBusiness(app);
  registerProposalEvents(app);
  registerFollowup(app);
  registerAssistantConnections(app);
  registerAssistantGoogle(app);
  registerCustomerTestDelivery(app);
  registerPropertyFile(app);
  const ctx = (c: Context<AppEnv>) => ({
    rt: c.env.runtime,
    t: c.req.param("tenantId")!,
    oa: c.req.param("oaId")!,
    actor: c.get("principal").user.id,
  });
  app.get(base, async (c) => {
    const { rt, t, oa, actor } = ctx(c);
    const access = await assistantAccess(rt, t, oa, actor);
    const business=await businessProfile(rt,t);
    const ts = await rt.openDatabase(t, oa, "tsunagu");
    const rows =
      c.req.query("scope") === "settings"
        ? []
        : await all(
            ts,
            "SELECT p.*,a.kind,a.evidence,a.expires_at,a.snoozed_until FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id ORDER BY p.created_at DESC LIMIT 100",
          );
    const proposals = [];
    for (const p of rows) {
      try {
        await assistantAccess(rt, t, oa, actor, p.customer_id);
        proposals.push({
          ...p,
          evidence: parse(p.evidence),
          problem: await assistantGuard(rt, t, oa, p),
        });
      } catch {}
    }
    const prefs = await all(ts, "SELECT * FROM assistant_preferences");
    const visible = [];
    for (const p of prefs) {
      const customer = await one(
        access.common,
        "SELECT * FROM customers WHERE id=?",
        [p.customer_id],
      );
      if (customer && customerAccess(access.m, customer, "read"))
        visible.push({ ...p, data: parse(p.data) });
    }
    return c.json({
      proposals,
      business: await businessProfile(rt,t),
      preferences: visible,
      detectionMode: setupEnvironment(rt).detection,
      customerConnection: {
        connected: access.oa.webhook_mode === "harness"
          ? !!(await one(rt.db,"SELECT id FROM connections WHERE tenant_id=? AND oa_id=? AND service='harness' AND state='connected'",[t,oa]))
          : !!access.oa.webhook_verified_at,
        readOnly: !!rt.harnessReadOnly,
      },
      sources: (await all(ts,"SELECT * FROM assistant_sources ORDER BY updated_at DESC LIMIT 100")).filter(s=>!business.industry || parse(s.data).industry===business.industry),
      enabled: !!(
        await one(
          ts,
          "SELECT enabled FROM assistant_settings WHERE id='default'",
        )
      )?.enabled,
      feedConfigured: !!rt.assistantFeeds?.[`${t}:${oa}`],
      searchConfigured: !!rt.assistantSearch?.[`${t}:${oa}`],
      aiConfigured: !!rt.ai?.apiKey,
      automation: await automationSettings(ts),
      acquisition: has(access.m, "org_owner", "sys_admin")
        ? await all(
            ts,
            "SELECT kind,state,detail,created_at FROM assistant_runs WHERE kind IN ('search','feed') ORDER BY created_at DESC LIMIT 5",
          )
        : [],
      canManage: has(access.m, "org_owner", "sys_admin"),
    });
  });
  app.get(`${base}/proposals/:id`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      ts = await rt.openDatabase(t, oa, "tsunagu");
    const p = await one(
      ts,
      "SELECT p.*,a.kind,a.evidence,a.expires_at,a.snoozed_until FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?",
      [c.req.param("id")],
    );
    requireThat(p, 404, "NOT_FOUND", "提案が見つかりません。");
    await assistantAccess(rt, t, oa, actor, p.customer_id);
    return c.json({
      proposal: {
        ...p,
        evidence: parse(p.evidence),
        problem: await assistantGuard(rt, t, oa, p),
      },
      learning: await all(ts,"SELECT id,version,action,origin,category,note,excluded,at FROM assistant_feedback WHERE proposal_id=? AND actor_id=? ORDER BY at DESC LIMIT 20",[p.id,actor]),
      aiConfigured: !!rt.ai?.apiKey,
      deliveryEnabled: !!rt.deliveryEnabled,
    });
  });
  app.get(`${base}/loop`,async(c)=>{
    const {rt,t,oa,actor}=ctx(c);await assistantAccess(rt,t,oa,actor);
    const ts=await rt.openDatabase(t,oa,"tsunagu");
    const config=parse((await one(ts,"SELECT data FROM assistant_google_config WHERE id='default'"))?.data);
    return c.json({enabled:!!(await one(ts,"SELECT enabled FROM assistant_settings WHERE id='default'"))?.enabled,scheduled:!rt.assistantManualOnly,autoSheet:!!config.autoSheet,autoDraft:(await automationSettings(ts)).autoDraft,researchEnabled:!!config.researchEnabled&&!!rt.assistantResearchEnabled,sheet:await one(ts,"SELECT state,checked_at,next_at,detail FROM assistant_sheet_sync WHERE id='default'"),research:await one(ts,"SELECT day,state,created_at,error_code FROM assistant_research_days ORDER BY day DESC LIMIT 1")});
  });
  app.get(`${base}/learning`, async (c) => {
    const {rt,t,oa,actor}=ctx(c); await assistantAccess(rt,t,oa,actor);
    const ts=await rt.openDatabase(t,oa,"tsunagu");
    return c.json({events:await all(ts,"SELECT id,proposal_id,version,customer_id,action,origin,category,note,at,excluded FROM assistant_feedback WHERE actor_id=? ORDER BY at DESC LIMIT 50",[actor])});
  });
  app.patch(`${base}/learning/:id`,async(c)=>{
    const {rt,t,oa,actor}=ctx(c);const ts=await rt.openDatabase(t,oa,"tsunagu");
    const f=await one(ts,"SELECT * FROM assistant_feedback WHERE id=? AND actor_id=?",[c.req.param('id'),actor]);
    requireThat(f,404,"NOT_FOUND","学習履歴が見つかりません。");
    await assistantAccess(rt,t,oa,actor,f.customer_id,"edit");
    const b=z.object({excluded:z.boolean()}).strict().parse(await c.req.json());
    await ts.query("UPDATE assistant_feedback SET excluded=? WHERE id=? AND actor_id=?",[Number(b.excluded),f.id,actor]);
    await audit(rt.db,actor,"assistant.learning.excluded",f.id,t,b);
    return c.json({ok:true});
  });
  app.post(`${base}/scan-customer`, async (c) => {
    const { rt, t, oa, actor } = ctx(c);
    const b = z
      .object({ customerId: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    await assistantAccess(rt, t, oa, actor, b.customerId, "edit");
    return c.json(await proposeCustomer(rt,t,oa,actor,b.customerId));
  });
  app.post(`${base}/scan`, async (c) => {
    const { rt, t, oa, actor } = ctx(c);
    const result = await scanAssistant(rt, t, oa, actor);
    await notifyAssistant(rt, t, oa, actor);
    return c.json(result);
  });
  app.post(`${base}/settings`, async (c) => {
    const { rt, t, oa, actor } = ctx(c);
    await assistantAccess(rt, t, oa, actor);
    const b = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const ts = await rt.openDatabase(t, oa, "tsunagu");
    await ts.query(
      "INSERT INTO assistant_settings(id,enabled) VALUES ('default',?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled",
      [Number(b.enabled)],
    );
    return c.json({ ok: true });
  });
  app.post(`${base}/automation`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      { m } = await assistantAccess(rt, t, oa, actor);
    requireThat(
      has(m, "org_owner", "sys_admin"),
      403,
      "FORBIDDEN",
      "定期AI・検索・同期の設定は管理者が行ってください。",
    );
    const settings = automationSchema.parse(await c.req.json());
    requireThat(
      !settings.autoDraft || rt.ai?.apiKey,
      409,
      "AI_NOT_CONNECTED",
      "文案AIの接続設定が必要です。",
    );
    requireThat(
      !settings.autoSearch ||
        (rt.assistantSearch?.[`${t}:${oa}`] && settings.topics.length),
      409,
      "SEARCH_NOT_CONNECTED",
      "検索接続とテーマの設定が必要です。",
    );
    requireThat(
      !settings.autoFeed || rt.assistantFeeds?.[`${t}:${oa}`],
      409,
      "FEED_NOT_CONNECTED",
      "商品・ニュースフィードの接続設定が必要です。",
    );
    const ts = await rt.openDatabase(t, oa, "tsunagu");
    await ts.query(
      "INSERT INTO assistant_automation(id,data) VALUES ('default',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      [json(settings)],
    );
    await audit(rt.db, actor, "assistant.automation_changed", oa, t, settings);
    return c.json({ ok: true });
  });
  app.post(`${base}/discover`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      { m } = await assistantAccess(rt, t, oa, actor);
    requireThat(
      has(m, "org_owner", "sys_admin"),
      403,
      "FORBIDDEN",
      "Web検索の実行は管理者が行ってください。",
    );
    const result = await discoverAssistantNews(rt, t, oa, actor);
    await scanAssistant(rt, t, oa, actor, "opportunity");
    await notifyAssistant(rt, t, oa, actor);
    return c.json(result);
  });
  app.post(`${base}/proposals/:id/generate`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      b = z
        .object({
          version: z.number().int(),
          instruction: z.string().trim().max(2000).default(""),
        })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await generateAssistantDraft(
        rt,
        t,
        oa,
        actor,
        c.req.param("id"),
        b.version,
        b.instruction,
      ),
    );
  });
  app.post(`${base}/sources`, async (c) => {
    const { rt, t, oa, actor } = ctx(c);
    const { m } = await assistantAccess(rt, t, oa, actor);
    requireThat(
      has(m, "org_owner", "sys_admin"),
      403,
      "FORBIDDEN",
      "情報登録は管理者が行ってください。",
    );
    const input = sourceSchema.parse(await c.req.json());
    requireThat(
      !/^(feed-|web-)/.test(input.id),
      400,
      "RESERVED_SOURCE_ID",
      "feed- / web- は接続情報用です。別のIDを指定してください。",
    );
    await upsertSource(rt, t, oa, input);
    await audit(rt.db, actor, "assistant.source_updated", oa, t);
    await scanAssistant(rt, t, oa, actor, "opportunity");
    await notifyAssistant(rt, t, oa);
    return c.json({ ok: true });
  });
  app.post(`${base}/sync`, async (c) => {
    const { rt, t, oa, actor } = ctx(c);
    const { m } = await assistantAccess(rt, t, oa, actor);
    requireThat(
      has(m, "org_owner", "sys_admin"),
      403,
      "FORBIDDEN",
      "情報同期は管理者が行ってください。",
    );
    const result = await syncAssistantFeed(rt, t, oa);
    await scanAssistant(rt, t, oa, actor, "opportunity");
    await notifyAssistant(rt, t, oa);
    return c.json(result);
  });
  // 既存ログイン・所属・OA管理権限・Origin検証を使う取込イベント。新しい常設トークンは発行しない。
  app.post(`${base}/catalog-events`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      { m } = await assistantAccess(rt, t, oa, actor);
    requireThat(
      has(m, "org_owner", "sys_admin"),
      403,
      "FORBIDDEN",
      "商品取込は管理者が行ってください。",
    );
    const b = z
      .object({
        eventId: z.string().regex(/^[\w-]{1,100}$/),
        source: sourceSchema.refine(
          (s) => s.kind === "product" && s.id.length <= 95,
        ),
      })
      .strict()
      .parse(await c.req.json());
    requireThat(
      Date.parse(b.source.checkedAt) <= Date.now() &&
        Date.parse(b.source.checkedAt) >= Date.now() - day,
      422,
      "EVENT_STALE",
      "実際の在庫確認日時を指定してください（24時間以内）。",
    );
    const ts = await rt.openDatabase(t, oa, "tsunagu"),
      hash = await digest(json(b)),
      sourceId = `feed-${b.source.id}`;
    const prior = await one(
      ts,
      "SELECT * FROM assistant_catalog_events WHERE id=?",
      [b.eventId],
    );
    requireThat(
      !prior || prior.payload_hash === hash,
      409,
      "EVENT_REUSED",
      "同じイベントIDを別の内容には使えません。",
    );
    await ts.query(
      "INSERT OR IGNORE INTO assistant_catalog_events(id,payload_hash,source_id,occurred_at,created_at) VALUES (?,?,?,?,?)",
      [b.eventId, hash, sourceId, b.source.checkedAt, now()],
    );
    const accepted = await one(
      ts,
      "SELECT payload_hash FROM assistant_catalog_events WHERE id=?",
      [b.eventId],
    );
    requireThat(
      accepted?.payload_hash === hash,
      409,
      "EVENT_REUSED",
      "イベントIDが競合しました。",
    );
    const current = await one(
      ts,
      "SELECT checked_at,data FROM assistant_sources WHERE id=?",
      [sourceId],
    );
    const input = sourceSchema.parse({ ...b.source, id: sourceId });
    requireThat(
      !current ||
        current.checked_at !== input.checkedAt ||
        current.data === json(input),
      409,
      "INVENTORY_VERSION_CONFLICT",
      "同じ確認時刻の異なる在庫情報です。最新の確認日時で再取込してください。",
    );
    await upsertSource(rt, t, oa, input, true);
    const saved = await one(
      ts,
      "SELECT checked_at,data FROM assistant_sources WHERE id=?",
      [sourceId],
    );
    requireThat(
      saved &&
        (saved.checked_at > input.checkedAt || saved.data === json(input)),
      409,
      "INVENTORY_VERSION_CONFLICT",
      "同じ確認時刻の在庫情報が競合しました。最新の確認日時で再取込してください。",
    );
    if (!prior) {
      const lease = await claimAssistantOA(rt, t, oa, true);
      if (lease) {
        let failed = false;
        try {
          await processAssistantWork(rt, t, oa);
          await notifyAssistant(rt, t, oa);
        } catch {
          failed = true;
        } finally {
          await finishAssistantOA(rt, t, oa, lease, failed);
        }
      }
    }
    return c.json({
      ok: true,
      duplicate: !!prior,
      stale: saved.checked_at > input.checkedAt,
    });
  });
  app.post(`${base}/preferences/:customerId`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      cid = c.req.param("customerId");
    await assistantAccess(rt, t, oa, actor, cid, "edit");
    const b = preferencesSchema.parse(await c.req.json()),
      ts = await rt.openDatabase(t, oa, "tsunagu");
    requireThat(
      await one(
        ts,
        "SELECT id FROM context_notes WHERE id=? AND customer_id=? AND confirmed_by IS NOT NULL AND deleted_at IS NULL",
        [b.noteId, cid],
      ),
      409,
      "NOTE_REQUIRED",
      "このお客様の確認済み商談メモを選んでください。",
    );
    await ts.query(
      "INSERT INTO assistant_preferences(customer_id,note_id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET note_id=excluded.note_id,data=excluded.data,version=version+1,updated_at=excluded.updated_at",
      [cid, b.noteId, json(b), now()],
    );
    return c.json({ ok: true });
  });
  app.patch(`${base}/proposals/:id`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      b = z
        .object({
          version: z.number().int(),
          draft: z.string().trim().min(1).max(2000),
          learning: learningInput.optional(),
        })
        .strict()
        .parse(await c.req.json());
    await editAssistant(
      rt,
      t,
      oa,
      actor,
      c.req.param("id"),
      b.version,
      b.draft,
      { learning: b.learning },
    );
    return c.json({ ok: true });
  });
  app.post(`${base}/proposals/:id/approve`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      b = z
        .object({ version: z.number().int() })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await approveAssistant(rt, t, oa, actor, c.req.param("id"), b.version),
    );
  });
  app.post(`${base}/proposals/:id/decision`, async (c) => {
    const { rt, t, oa, actor } = ctx(c),
      b = z
        .object({
          version: z.number().int(),
          action: z.enum(["cancel", "later"]),
          feedback: decisionInput.optional(),
        })
        .strict()
        .parse(await c.req.json());
    await decideAssistant(
      rt,
      t,
      oa,
      actor,
      c.req.param("id"),
      b.version,
      b.action,
      b.feedback,
    );
    return c.json({ ok: true });
  });
}

export async function editAssistant(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor: string,
  pid: string,
  version: number,
  draft: string,
  options: { origin?: "human" | "ai" | "assisted"; directive?: string; learning?: LearningInput } = {},
) {
  draft = z.string().trim().min(1).max(2000).parse(draft);
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    p = await one(ts, "SELECT * FROM proposals WHERE id=?", [pid]);
  requireThat(p && isAssistant(p), 404, "NOT_FOUND", "提案が見つかりません。");
  await assistantAccess(rt, tenant, oa, actor, p.customer_id, "edit");
  const problem = await assistantGuard(rt, tenant, oa, p);
  requireThat(!problem, 409, "REVIEW_REQUIRED", problem || "");
  const meta = (await one(ts, "SELECT * FROM assistant_proposals WHERE proposal_id=?", [pid]))!;
  const changes = await ts.batch([{
    sql: "UPDATE proposals SET draft=?,version=version+1,state='pending',approved_by=NULL,approved_version=NULL,scheduled_at=NULL,hold_reason=NULL,updated_at=? WHERE id=? AND version=? AND state IN ('pending','approved','held')",
    params: [draft, now(), pid, version],
  }, feedbackQuery(p, meta, actor, "edited", draft, {version: version+1, ...options})]);
  const result = changes[0];
  requireThat(
    result.changes,
    409,
    "VERSION_CONFLICT",
    "変更済みか、送信処理が始まっています。",
  );
  const h = await rt.openDatabase(tenant, oa, "harness");
  await h.query(
    "UPDATE outbox SET state='cancelled' WHERE proposal_id=? AND state IN ('pending','held')",
    [pid],
  );
  await ts.query(
    "UPDATE assistant_proposals SET snoozed_until=NULL WHERE proposal_id=?",
    [pid],
  );
  await ts.query(
    "UPDATE assistant_proposals SET evidence=json_set(evidence,'$.draftMode','edited','$.draftDetail','編集済みの文案です。内容を確認してから承認してください。') WHERE proposal_id=?",
    [pid],
  );
  const fresh=await one(ts,"SELECT p.*,a.owner_user_id,a.evidence,a.kind,a.expires_at FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?",[pid]);
  if(fresh) await publishProposalEvent(rt,tenant,oa,fresh);
  await audit(rt.db, actor, "assistant.edited", pid, tenant, {
    version: version + 1,
  });
}

// Both buttons and scheduled source work use scanAssistant and the same grounded generator.
export async function proposeCustomer(rt:Runtime,t:string,oa:string,actor:string,cid:string) {
  await assistantAccess(rt,t,oa,actor,cid,"edit");
  const scan=await scanAssistant(rt,t,oa,actor,undefined,[cid],{allowAutoAI:false});
  const ts=await rt.openDatabase(t,oa,"tsunagu");
  const p=await one(ts,"SELECT p.*,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE customer_id=? AND p.state='pending' ORDER BY p.created_at DESC LIMIT 1",[cid]);
  if(!p) return {...scan,reason:"最新の会話・確認済み条件と有効な情報元から、新しい未提案の候補が見つかりませんでした。商品データの矛盾・期限・希望条件・見送り履歴を確認してください。"};
  const ev=parse(p.evidence);
  if(rt.ai?.apiKey && ev.draftMode==='template') await generateAssistantDraft(rt,t,oa,actor,p.id,p.version);
  await notifyAssistant(rt,t,oa,actor);
  return {...scan,id:p.id,reason:"同じ根拠から提案を用意しました。「今日の提案」で確認できます。"};
}
