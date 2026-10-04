import { hasPropertyTag } from "./assistant-match.ts";
import { businessProfile } from "./business.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, now, json, parse, type Row, type Database } from "./db.ts";
import { digest, requireThat, audit } from "./security.ts";
import { assistantAccess } from "./assistant.ts";

const day = 86400000;
const appointmentDue = (a: Row) =>
  a.ends_at && Date.parse(a.ends_at) > Date.parse(a.starts_at)
    ? a.ends_at
    : a.starts_at;
export const industryLabels: Record<string, string> = {
  estate: "物件の見学・住まいのご相談",
  bridal: "会場見学・ご相談",
  recruitment: "求人・転職についてのキャリア面談",
  general: "詳しいご相談",
};
export const journeyLabels: Record<string, string> = {
  ready: "次のきっかけ待ち",
  promised: "お約束の日時待ち",
  promise_due: "お約束の連絡時期",
  waiting_reply: "返信待ち",
  no_reply: "返信なし・再連絡の確認",
  replied: "返信あり",
  scheduling: "日程調整",
  booking_review: "予約の本人確認待ち",
  booked: "予約済み",
  result_pending: "来場・面談結果の確認",
  reschedule: "取消・再調整の確認",
  completed: "面談実施済み",
  manual_review: "担当者による確認待ち",
  stopped: "追客停止",
  needs_review: "根拠・担当者の再確認",
};
const profileSchema = z
  .object({
    version: z.number().int().nonnegative(),
    industry: z.enum(["estate", "bridal", "recruitment", "general"]),
    enabled: z.boolean(),
    sourceKind: z.enum(["message", "note"]),
    sourceId: z.string().min(1).max(200),
    stalledQuote: z.string().trim().max(500).default(""),
    conditionQuote: z.string().trim().max(500).default(""),
    jobWishQuote: z.string().trim().max(500).default(""),
    // Preserve the candidate's words, including uncertainty. Never a scheduling date.
    jobChangeTimingQuote: z.string().trim().max(500).default(""),
    terms: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
    promiseQuote: z.string().trim().max(500).default(""),
    promiseAt: z.string().datetime().nullable().default(null),
    phase: z.enum(["considering", "scheduling"]).default("considering"),
    waitDays: z.number().int().min(1).max(30).default(3),
    hypothesis: z.string().trim().max(1000).default(""),
  })
  .strict();
export const normalized = (s: string) =>
  s.normalize("NFKC").toLowerCase().trim();
async function evidenceSource(
  rt: Runtime,
  t: string,
  oa: string,
  cid: string,
  kind: string,
  sid: string,
) {
  const db = await rt.openDatabase(
    t,
    oa,
    kind === "message" ? "harness" : "tsunagu",
  );
  return kind === "message"
    ? one(
        db,
        "SELECT id,customer_id,line_user_id,body,kind,direction,occurred_at FROM messages WHERE id=? AND customer_id=? AND direction='inbound' AND kind='text'",
        [sid, cid],
      )
    : one(
        db,
        "SELECT id,customer_id,body,confirmed_by,confirmed_at,source,source_ref FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",
        [sid, cid],
      );
}
export async function profileProblem(
  rt: Runtime,
  t: string,
  oa: string,
  profile: Row,
  customer: Row,
  line: string,
) {
  const d = parse(profile.data),
    e = parse(profile.evidence);
  const business = await businessProfile(rt,t);
  if (business.industry && d.industry !== business.industry) return "会社の主事業が変更されています。条件の業界を再確認してください。";
  if (!d.enabled) return "次に進む条件の追跡を停止しています。";
  if (
    profile.owner_user_id !== customer.owner_user_id ||
    profile.line_user_id !== line
  )
    return "担当者または顧客LINEが変更されています。条件の根拠を再確認してください。";
  const source = await evidenceSource(rt, t, oa, customer.id, e.kind, e.id);
  if (
    !source ||
    (e.kind === "message" && source.line_user_id !== line) ||
    (await digest(json(source))) !== e.hash
  )
    return "確認した発言・メモが変更または削除されています。条件を再確認してください。";
  return null;
}
/** Bounded snapshot only for customers that opted into structured tracking. */
export async function followupInputs(
  h: Database,
  ts: Database,
  profiles: Row[],
  excludeProposal: string | null = null,
) {
  if (!profiles.length) return new Map<string, Row>();
  const ids = json(profiles.map((p) => p.customer_id));
  const hRows = await h.batch([
    {
      sql: "SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY COALESCE(accepted_at,scheduled_at) DESC,id DESC) n FROM outbox WHERE state IN ('sent','uncertain','sending') AND customer_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR proposal_id IS NULL OR proposal_id<>?)) WHERE n=1",
      params: [ids, excludeProposal, excludeProposal],
    },
    {
      sql: "SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY starts_at DESC,id DESC) n FROM appointments WHERE customer_id IN (SELECT value FROM json_each(?))) WHERE n<=20",
      params: [ids],
    },
  ]);
  const tRows = await ts.batch([
    {
      sql: "SELECT * FROM followup_meetings WHERE appointment_id IN (SELECT value FROM json_each(?))",
      params: [json(hRows[1].rows.map((r) => r.id))],
    },
    {
      sql: "SELECT p.id,a.evidence,a.kind FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id IN (SELECT value FROM json_each(?))",
      params: [json(hRows[0].rows.map((r) => r.proposal_id).filter(Boolean))],
    },
  ]);
  return new Map(
    profiles.map((profile) => [
      profile.customer_id,
      {
        sent: hRows[0].rows.find((r) => r.customer_id === profile.customer_id),
        appointments: hRows[1].rows.filter(
          (r) => r.customer_id === profile.customer_id,
        ),
        confirmed: tRows[0].rows.filter(
          (r) => r.customer_id === profile.customer_id,
        ),
        sentMeta: tRows[1].rows,
      },
    ]),
  );
}
export async function observeFollowup(
  rt: Runtime,
  t: string,
  oa: string,
  profile: Row,
  customer: Row,
  line: string,
  messages: Row[],
  input?: Row,
) {
  const ts = await rt.openDatabase(t, oa, "tsunagu"),
    h = await rt.openDatabase(t, oa, "harness");
  input ||= (await followupInputs(h, ts, [profile])).get(customer.id)!;
  const d = parse(profile.data),
    problem = await profileProblem(rt, t, oa, profile, customer, line);
  let sent = input.sent;
  const latestOutbound = messages.find((m) => m.direction === "outbound");
  if (
    latestOutbound &&
    (!sent ||
      (sent.state === "sent" && latestOutbound.occurred_at > sent.accepted_at))
  )
    sent = {
      id: `message:${latestOutbound.id}`,
      accepted_at: latestOutbound.occurred_at,
      state: "sent",
    };
  const appointments: Row[] = input.appointments;
  const confirmedIds = new Set(
    input.confirmed.map((r: Row) => r.appointment_id),
  );
  const confirmed = appointments.filter((a) => confirmedIds.has(a.id));
  const future = confirmed
    .filter(
      (a) =>
        ["booked", "rescheduled"].includes(a.state) &&
        Date.parse(appointmentDue(a)) > Date.now(),
    )
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const latest = confirmed[0];
  const renewedAfterMeeting =
    latest?.state === "attended" &&
    d.promiseAt &&
    Date.parse(d.promiseAt) > Date.parse(latest.ends_at || latest.starts_at) &&
    profile.updated_at > (latest.ends_at || latest.starts_at);
  const appointment = future || (renewedAfterMeeting ? null : latest);
  const unconfirmed = appointments.find(
    (a) =>
      !confirmedIds.has(a.id) && ["booked", "rescheduled"].includes(a.state),
  );
  const inbound = messages.find(
    (m) =>
      m.direction === "inbound" &&
      (!sent?.accepted_at || m.occurred_at > sent.accepted_at),
  );
  const sentMeta = input.sentMeta.find((p: Row) => p.id === sent?.proposal_id);
  const lastAction = sentMeta ? parse(sentMeta.evidence).followupAction : null;
  let state = "ready",
    action = "",
    nextAt: string | null = null,
    anchor = `profile:${profile.version}`,
    detail = "確認した条件に合う新しい情報を待っています。";
  if (problem) {
    state = "needs_review";
    detail = problem;
  } else if (
    customer.opt_out ||
    customer.mode !== "ai" ||
    customer.stage === "won"
  ) {
    state = "stopped";
    detail = "顧客の配信停止・対応状況に従い追跡を停止しています。";
  } else if (sent && sent.state !== "sent") {
    state = "manual_review";
    detail =
      "配送結果が確定していません。重複連絡を防ぐため結果の確認を待ちます。";
  } else if (future) {
    state = "booked";
    nextAt = appointmentDue(future);
    detail = "担当者が確認した予約です。終了時刻後に実施結果を確認します。";
  } else if (unconfirmed) {
    state = "booking_review";
    detail =
      "既存予約の顧客・担当者・日時を確認してください。確認前に予約確定とは扱いません。";
  } else if (
    appointment &&
    ["booked", "rescheduled"].includes(appointment.state)
  ) {
    state = "result_pending";
    detail = "予約時刻を過ぎました。来場・面談の実施結果を確認してください。";
  } else if (appointment?.state === "attended") {
    state = "completed";
    detail =
      "面談の実施結果が登録されています。次の約束があれば条件を更新してください。";
  } else if (
    appointment &&
    ["cancelled", "no_show"].includes(appointment.state) &&
    !(
      sent?.accepted_at &&
      sent.accepted_at >
        (input.confirmed.find((r: Row) => r.appointment_id === appointment.id)
          ?.confirmed_at || "") &&
      lastAction === "reschedule"
    )
  ) {
    state = "reschedule";
    action = "reschedule";
    anchor = `${appointment.id}:${appointment.version}`;
    detail =
      "予約の取消・未実施を確認しました。再調整の連絡内容を確認してください。";
  } else if (["booked", "result_pending"].includes(customer.stage)) {
    state = "manual_review";
    detail = "顧客の予約・結果確認状況を更新してください。";
  } else if (
    d.promiseAt &&
    (!sent?.accepted_at || sent.accepted_at < d.promiseAt)
  ) {
    anchor = d.promiseAt;
    if (Date.parse(d.promiseAt) < Date.now() - 7 * day) {
      state = "manual_review";
      detail = "約束の日時から7日を過ぎています。約束を再確認してください。";
    } else if (d.promiseAt > now()) {
      state = "promised";
      nextAt = d.promiseAt;
      detail = "お客様と確認した次の連絡日時を待っています。";
    } else {
      state = "promise_due";
      action = "promise";
      detail = "お客様と確認した連絡の時期になりました。";
    }
  } else if (inbound && (!sent || inbound.occurred_at > sent.accepted_at)) {
    state = d.phase === "scheduling" ? "scheduling" : "replied";
    detail = "返信内容を確認して、次のご連絡案を承認してください。";
  } else if (sent) {
    anchor = sent.id;
    if (lastAction === "no_reply") {
      state = "manual_review";
      detail = "再連絡後も返信待ちです。追加の連絡は担当者が判断してください。";
    } else {
      const due = new Date(
        Date.parse(sent.accepted_at) + d.waitDays * day,
      ).toISOString();
      if (due > now()) {
        state = "waiting_reply";
        nextAt = due;
        detail =
          "送信が完了しました。設定した待機期間は追加の営業連絡を控えます。";
      } else {
        state = "no_reply";
        action = "no_reply";
        detail = `${d.waitDays}日間、送信後の返信を確認できていません。再連絡は1回分だけ提案します。`;
      }
    }
  } else if (d.phase === "scheduling") {
    state = "scheduling";
    action = "schedule";
    detail =
      "担当者が確認した日程調整の段階です。空き枠を確約せず、ご希望を伺います。";
  }
  const observation = {
    state,
    detail,
    action,
    anchor,
    nextAt,
    profileVersion: profile.version,
    sentId: sent?.id || null,
    appointment: appointment
      ? {
          id: appointment.id,
          version: appointment.version,
          state: appointment.state,
          startsAt: appointment.starts_at,
          endsAt: appointment.ends_at,
        }
      : null,
  };
  const signature = await digest(json(observation));
  await ts.query(
    "INSERT INTO followup_journeys(customer_id,state,detail,signature,next_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET state=excluded.state,detail=excluded.detail,signature=excluded.signature,next_at=excluded.next_at,updated_at=excluded.updated_at WHERE signature<>excluded.signature",
    [customer.id, state, json(observation), signature, nextAt, now()],
  );
  return {
    ...observation,
    signature,
    problem,
    allowOpportunity: ["ready", "replied", "scheduling", "no_reply"].includes(
      state,
    ),
  };
}
export function profileCondition(data: Row) {
  return [
    data.conditionQuote,
    ...(data.industry === "recruitment" ? [data.jobWishQuote] : []),
  ]
    .filter(Boolean)
    .join(" / ");
}
export function matchesCondition(profile: Row, source: Row) {
  const d = parse(profile.data),
    s = parse(source.data);
  return (
    d.terms.length > 0 &&
    d.terms.every((term: string) =>
      hasPropertyTag(s, term),
    )
  );
}
export function followupCandidate(profile: Row, observation: Row) {
  if (!observation.action || observation.problem) return null;
  const d = parse(profile.data),
    action = observation.action,
    invitation = industryLabels[d.industry];
  const draft =
    action === "promise"
      ? `お約束していたご連絡です。${d.promiseQuote ? `「${d.promiseQuote}」について、` : ""}現在のご状況はいかがでしょうか。よろしければ、${invitation}の日程をご相談しませんか。`
      : action === "reschedule"
        ? `先日のご予定について、改めてご都合を伺ってもよろしいでしょうか。${invitation}をご希望でしたら、ご都合のよい日時をお知らせください。`
        : action === "schedule"
          ? `${invitation}に向けて、ご都合のよい日時をいくつか教えていただけますか。空き状況を確認して、改めてご案内します。`
          : `先日ご案内した件、その後いかがでしょうか。引き続きご検討中でしたら、${invitation}で気になる点を一緒に確認できればと思います。ご連絡を控えた方がよければ、お知らせください。`;
  return {
    key: `followup:${profile.customer_id}:${profile.version}:${action}:${observation.anchor}`,
    reason: observation.detail,
    draft,
    evidence: {
      followupVersion: profile.version,
      followupSignature: observation.signature,
      followupAction: action,
      followupAnchor: observation.anchor,
      condition: d.conditionQuote,
      stalled: d.stalledQuote,
      promise: d.promiseQuote,
      ...(d.industry === "recruitment"
        ? {
            industry: d.industry,
            jobWish: d.jobWishQuote || "",
            jobChangeTiming: d.jobChangeTimingQuote || "",
          }
        : {}),
      profileSource: parse(profile.evidence),
      priority: action === "no_reply" ? 40 : 20,
      draftDetail:
        "確認済みの原文と送信・予約記録から用意した案です。日時や予約の確定は担当者が確認してください。",
    },
  };
}
export async function followupEvidenceProblem(
  rt: Runtime,
  t: string,
  oa: string,
  p: Row,
  ev: Row,
  customer: Row,
  line: string,
  messages: Row[],
) {
  if (!ev.followupVersion) return null;
  const ts = await rt.openDatabase(t, oa, "tsunagu"),
    profile = await one(
      ts,
      "SELECT * FROM followup_profiles WHERE customer_id=?",
      [customer.id],
    );
  if (!profile || profile.version !== ev.followupVersion)
    return "次に進む条件が変更されています。最新版で提案を確認してください。";
  const h = await rt.openDatabase(t, oa, "harness");
  const observed = (await followupInputs(h, ts, [profile], p.id)).get(
    customer.id,
  );
  const observation = await observeFollowup(
    rt,
    t,
    oa,
    profile,
    customer,
    line,
    messages,
    observed,
  );
  if (observation.problem) return observation.problem;
  if (ev.followupSignature && observation.signature !== ev.followupSignature)
    return "送信後の返信・予約・約束の状況が変わっています。提案を作り直してください。";
  if (
    !ev.followupAction &&
    !observation.allowOpportunity &&
    !["assistant:reply","assistant:product","assistant:news"].includes(p.trigger)
  )
    return "次の約束・予約・返信待ちの状況により、ご案内を控えています。";
  return null;
}

export function registerFollowup(app: Hono<AppEnv>) {
  const base =
    "/api/tenants/:tenantId/accounts/:oaId/assistant/customers/:customerId/followup";
  const ctx = async (c: any, action: "read" | "edit" = "read") => {
    const rt: Runtime = c.env.runtime,
      t = c.req.param("tenantId"),
      oa = c.req.param("oaId"),
      cid = c.req.param("customerId"),
      actor = c.get("principal").user.id;
    const access = await assistantAccess(rt, t, oa, actor, cid, action);
    const links = await all(
      access.common,
      "SELECT line_user_id FROM customer_links WHERE oa_id=? AND customer_id=? AND state='confirmed'",
      [oa, cid],
    );
    requireThat(
      links.length === 1,
      409,
      "LINK_REVIEW",
      "顧客LINEの紐付けを一意に確認してください。",
    );
    const ts = await rt.openDatabase(t, oa, "tsunagu"),
      h = await rt.openDatabase(t, oa, "harness");
    return {
      rt,
      t,
      oa,
      cid,
      actor,
      ts,
      h,
      customer: access.customer!,
      line: links[0].line_user_id,
    };
  };
  app.get(base, async (c) => {
    const { rt, t, oa, cid, ts, h, customer, line } = await ctx(c);
    const profile = await one(
      ts,
      "SELECT * FROM followup_profiles WHERE customer_id=?",
      [cid],
    );
    const [messages, notes, appointments, confirmed, proposals, measures] =
      await Promise.all([
        all(
          h,
          "SELECT id,body,direction,kind,line_user_id,occurred_at,recorded_at FROM messages WHERE customer_id=? ORDER BY occurred_at DESC,id DESC LIMIT 30",
          [cid],
        ),
        all(
          ts,
          "SELECT id,body,confirmed_at FROM context_notes WHERE customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL ORDER BY created_at DESC LIMIT 30",
          [cid],
        ),
        all(
          h,
          "SELECT * FROM appointments WHERE customer_id=? ORDER BY starts_at DESC LIMIT 20",
          [cid],
        ),
        all(ts, "SELECT * FROM followup_meetings WHERE customer_id=?", [cid]),
        all(
          ts,
          "SELECT p.id,p.draft,p.created_at FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE customer_id=? AND state='sent' ORDER BY p.created_at DESC LIMIT 30",
          [cid],
        ),
        all(ts, "SELECT * FROM followup_measurements WHERE customer_id=?", [
          cid,
        ]),
      ]);
    const journey = profile
      ? await observeFollowup(rt, t, oa, profile, customer, line, messages)
      : null;
    const linkedAppointments = confirmed
      .filter((f) => f.proposal_id)
      .map((f) => f.appointment_id);
    const totals = await one(
      h,
      "SELECT COUNT(CASE WHEN state NOT IN ('cancelled','no_show') THEN 1 END) booked,COUNT(CASE WHEN state='attended' THEN 1 END) attended,COUNT(CASE WHEN state IN ('cancelled','no_show') THEN 1 END) cancelled FROM appointments WHERE customer_id=? AND id IN (SELECT value FROM json_each(?))",
      [cid, json(linkedAppointments)],
    );
    return c.json({
      profile: profile
        ? {
            ...profile,
            data: parse(profile.data),
            evidence: parse(profile.evidence),
          }
        : null,
      journey,
      business: await businessProfile(rt,t),
      sources: [
        ...messages
          .filter(
            (m) =>
              m.direction === "inbound" &&
              m.kind === "text" &&
              m.line_user_id === line,
          )
          .map((m) => ({ id: m.id, kind: "message", body: m.body })),
        ...notes.map((n) => ({ ...n, kind: "note" })),
      ],
      appointments,
      confirmed,
      proposals,
      labels: journeyLabels,
      metrics: {
        attributedBookings: totals!.booked,
        attended: totals!.attended,
        cancelled: totals!.cancelled,
        measuredReviews: measures.length,
        estimatedSavedSeconds: measures.reduce(
          (sum, m) => sum + m.baseline_seconds - m.review_seconds,
          0,
        ),
        reviewSeconds: measures.reduce((sum, m) => sum + m.review_seconds, 0),
      },
    });
  });
  app.put(base, async (c) => {
    const { rt, t, oa, cid, actor, ts, customer, line } = await ctx(c, "edit"),
      b = profileSchema.parse(await c.req.json());
    const business = await businessProfile(rt,t);
    requireThat(!business.industry || business.industry === b.industry,409,"BUSINESS_MISMATCH","会社の主事業に合わせて条件を確認してください。");
    const source = await evidenceSource(
      rt,
      t,
      oa,
      cid,
      b.sourceKind,
      b.sourceId,
    );
    requireThat(
      source && (b.sourceKind !== "message" || source.line_user_id === line),
      409,
      "SOURCE_REVIEW",
      "この顧客の発言・確認済みメモを選んでください。",
    );
    const facts = [
      b.stalledQuote,
      b.conditionQuote,
      b.promiseQuote,
      b.jobWishQuote,
      b.jobChangeTimingQuote,
    ];
    requireThat(
      facts.some(Boolean) && facts.every((q) => !q || source!.body.includes(q)),
      400,
      "QUOTE_REQUIRED",
      "事実欄には選んだ原文の抜粋を記入してください。解釈は仮説欄に分けてください。",
    );
    requireThat(
      b.terms.every((term) =>
        normalized(profileCondition(b)).includes(normalized(term)),
      ),
      400,
      "TERMS_NOT_GROUNDED",
      "照合する語句は次に進む条件・希望求人の原文から指定してください。",
    );
    requireThat(
      !b.promiseAt || !!b.promiseQuote,
      400,
      "PROMISE_QUOTE_REQUIRED",
      "次回日時には約束の原文が必要です。",
    );
    const { version, sourceKind, sourceId, ...data } = b;
    const evidence = json({
      kind: sourceKind,
      id: sourceId,
      body: source!.body,
      hash: await digest(json(source)),
    });
    const old = await one(
      ts,
      "SELECT version FROM followup_profiles WHERE customer_id=?",
      [cid],
    );
    requireThat(
      (old?.version || 0) === version,
      409,
      "VERSION_CONFLICT",
      "条件が更新されています。最新内容を開いてください。",
    );
    const result = old
      ? await ts.query(
          "UPDATE followup_profiles SET owner_user_id=?,line_user_id=?,data=?,evidence=?,version=version+1,confirmed_by=?,updated_at=? WHERE customer_id=? AND version=?",
          [
            customer.owner_user_id,
            line,
            json(data),
            evidence,
            actor,
            now(),
            cid,
            version,
          ],
        )
      : await ts.query(
          "INSERT OR IGNORE INTO followup_profiles(customer_id,owner_user_id,line_user_id,data,evidence,confirmed_by,updated_at) VALUES (?,?,?,?,?,?,?)",
          [
            cid,
            customer.owner_user_id,
            line,
            json(data),
            evidence,
            actor,
            now(),
          ],
        );
    requireThat(
      result.changes,
      409,
      "VERSION_CONFLICT",
      "同時に更新されました。最新内容を開いてください。",
    );
    await audit(rt.db, actor, "followup.confirmed", cid, t, {
      version: version + 1,
    });
    return c.json({ ok: true, version: version + 1 });
  });
  app.post(`${base}/meetings/:id/confirm`, async (c) => {
    const { rt, t, cid, actor, ts, h } = await ctx(c, "edit");
    const b = z
      .object({
        version: z.number().int(),
        proposalId: z.string().nullable(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    const appointment = await one(
      h,
      "SELECT * FROM appointments WHERE id=? AND customer_id=?",
      [c.req.param("id"), cid],
    );
    requireThat(
      appointment && appointment.version === b.version,
      409,
      "APPOINTMENT_CHANGED",
      "この顧客の予約と最新版の日時を確認してください。",
    );
    if (b.proposalId) {
      const p = await one(
        ts,
        "SELECT p.* FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=? AND p.customer_id=? AND p.state='sent'",
        [b.proposalId, cid],
      );
      const sent =
        p &&
        (await one(
          h,
          "SELECT id FROM outbox WHERE proposal_id=? AND state='sent' AND customer_id=?",
          [p.id, cid],
        ));
      requireThat(
        sent,
        409,
        "SENT_PROPOSAL_REQUIRED",
        "実際に送信済みのこの顧客への提案を選んでください。",
      );
    }
    await ts.query(
      "INSERT INTO followup_meetings(appointment_id,customer_id,proposal_id,confirmed_by,confirmed_at) VALUES (?,?,?,?,?) ON CONFLICT(appointment_id) DO UPDATE SET proposal_id=excluded.proposal_id,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at WHERE customer_id=excluded.customer_id",
      [appointment!.id, cid, b.proposalId, actor, now()],
    );
    await audit(
      rt.db,
      actor,
      "followup.meeting_confirmed",
      appointment!.id,
      t,
      { proposalId: b.proposalId },
    );
    return c.json({ ok: true });
  });
  app.delete(`${base}/meetings/:id/confirmation`, async (c) => {
    const { rt, t, cid, actor, ts } = await ctx(c, "edit");
    const aid = c.req.param("id");
    await ts.batch([
      {
        sql: "DELETE FROM followup_meetings WHERE appointment_id=? AND customer_id=?",
        params: [aid, cid],
      },
      {
        sql: "INSERT INTO assistant_work_queue(customer_id) VALUES (?) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1,due_at='',attempts=0",
        params: [cid],
      },
    ]);
    await audit(rt.db, actor, "followup.meeting_unlinked", aid, t);
    return c.json({ ok: true });
  });
  app.post(`${base}/measurements`, async (c) => {
    const { cid, actor, ts } = await ctx(c, "edit"),
      b = z
        .object({
          proposalId: z.string(),
          baselineSeconds: z.number().int().min(1).max(7200),
          reviewSeconds: z.number().int().min(1).max(7200),
        })
        .strict()
        .parse(await c.req.json());
    const p = await one(
      ts,
      "SELECT id FROM proposals WHERE id=? AND customer_id=? AND trigger LIKE 'assistant:%' AND state='sent'",
      [b.proposalId, cid],
    );
    requireThat(
      p,
      409,
      "SENT_PROPOSAL_REQUIRED",
      "送信済みの提案を選んでください。",
    );
    await ts.query(
      "INSERT OR IGNORE INTO followup_measurements(proposal_id,customer_id,actor_id,baseline_seconds,review_seconds,created_at) VALUES (?,?,?,?,?,?)",
      [b.proposalId, cid, actor, b.baselineSeconds, b.reviewSeconds, now()],
    );
    return c.json({ ok: true });
  });
}
