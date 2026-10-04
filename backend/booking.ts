import { receiveDemoTimeRex } from "./self-demo-booking.ts";
import { saveBookingReceipt } from "./meeting-overview.ts";
import { recordTimeRexReceipt } from "./timerex-connection.ts";
import { normalizeTimeRexPayload } from "./timerex-payload.ts";
import { queueBookingNotice } from "./notify.ts";
import { z } from "zod";
import type { Hono } from "hono";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import type { AppEnv, Runtime } from "./runtime.ts";
import { AppError, requireThat, audit, digest, verify, sign } from "./security.ts";
import { getCredential } from "./credentials.ts";
import { holdCustomer } from "./sales.ts";

export interface BookingEventPayload {
  event: "booking.created" | "booking.rescheduled" | "booking.cancelled";
  bookingId: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  trackingToken?: string;
  customerId?: string;
  lineUserId?: string;
  staffName?: string;
  hostEmails?: string[];
  location?: string;
  detailsUrl?: string;
}

export function formatJstDateTime(isoUtc: string): string {
  try {
    const d = new Date(isoUtc);
    const jst = new Date(d.getTime() + 9 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const year = jst.getUTCFullYear();
    const month = pad(jst.getUTCMonth() + 1);
    const day = pad(jst.getUTCDate());
    const hours = pad(jst.getUTCHours());
    const minutes = pad(jst.getUTCMinutes());
    const daysOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
    const dow = daysOfWeek[jst.getUTCDay()];
    return `${year}年${month}月${day}日(${dow}) ${hours}:${minutes} JST`;
  } catch {
    return isoUtc;
  }
}

export function buildBookingCardFlex(params: {
  title: string;
  startsAt: string;
  staffName?: string;
  location?: string;
  detailsUrl?: string;
}) {
  const formattedTime = formatJstDateTime(params.startsAt);
  const staff = params.staffName || "担当スタッフ";
  const location = params.location || "オンライン (Zoom / Google Meet)";
  const detailsUrl = params.detailsUrl || "https://example.invalid/booking";

  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#10b981",
      paddingTop: "16px",
      paddingBottom: "16px",
      contents: [
        {
          type: "text",
          text: "予約が完了しました",
          weight: "bold",
          size: "lg",
          color: "#ffffff",
          align: "center",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      paddingAll: "20px",
      contents: [
        {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: "サービス・内容",
              size: "xs",
              color: "#6b7280",
            },
            {
              type: "text",
              text: params.title || "個別相談・面談",
              weight: "bold",
              size: "md",
              color: "#111827",
              wrap: true,
            },
          ],
        },
        {
          type: "separator",
        },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            {
              type: "text",
              text: "ご予約日時",
              size: "xs",
              color: "#6b7280",
            },
            {
              type: "text",
              text: formattedTime,
              weight: "bold",
              size: "sm",
              color: "#1e3a8a",
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            {
              type: "text",
              text: "担当者",
              size: "xs",
              color: "#6b7280",
            },
            {
              type: "text",
              text: staff,
              weight: "bold",
              size: "sm",
              color: "#374151",
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            {
              type: "text",
              text: "形式・場所",
              size: "xs",
              color: "#6b7280",
            },
            {
              type: "text",
              text: location,
              size: "xs",
              color: "#4b5563",
              wrap: true,
            },
          ],
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "16px",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#10b981",
          height: "sm",
          action: {
            type: "uri",
            label: "予約内容を確認する",
            uri: detailsUrl,
          },
        },
      ],
    },
  };
}

export function buildReminderText(params: {
  title: string;
  startsAt: string;
  hoursBefore: number;
  staffName?: string;
  location?: string;
}): string {
  const formattedTime = formatJstDateTime(params.startsAt);
  const timingText =
    params.hoursBefore >= 24
      ? `明日 (${params.hoursBefore}時間後)`
      : `本日 (${params.hoursBefore}時間後)`;
  return `【面談リマインド】\n${timingText}に予定されている「${params.title}」のご案内です。\n\n■ 日時: ${formattedTime}\n■ 形式: ${params.location || "オンライン"}\n■ 担当: ${params.staffName || "担当スタッフ"}\n\n当日お話しできることを楽しみにしております。ご都合が悪くなられた際やご質問はお気軽にご返信ください。`;
}

export async function processBookingEvent(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  payload: BookingEventPayload,
) {
  const oa = await one(
    rt.db,
    "SELECT * FROM accounts WHERE tenant_id=? AND id=?",
    [tenantId, oaId],
  );
  requireThat(oa, 404, "OA_NOT_FOUND", "公式LINEが見つかりません。");

  const common = await rt.openDatabase(tenantId, "", "common");
  const h = await rt.openDatabase(tenantId, oaId, "harness");

  const existingAppt = await one(h, "SELECT * FROM appointments WHERE external_id=?", [payload.bookingId]);
  // 取消後に遅れて届いた予約確定を再適用しない。
  if (existingAppt?.state === "cancelled" && payload.event === "booking.created")
    return { ok: true, state: "cancelled", ignored: true };

  // 顧客の特定:
  // 1) payload.customerId または payload.lineUserId による照合
  // 2) payload.trackingToken に基づく提案・顧客の照合
  // 3) customer_links / external_links
  let customerId = existingAppt?.customer_id || payload.customerId || null;
  let lineUserId = payload.lineUserId || null;

  let verifiedTracking = false;
  if (payload.trackingToken) {
    const linkRecord = await one(
      common,
      "SELECT customer_id, line_user_id FROM external_links WHERE oa_id=? AND service='timerex' AND external_id=?",
      [oaId, payload.trackingToken],
    );
    if (linkRecord) {
      verifiedTracking = true;
      customerId = linkRecord.customer_id;
      lineUserId = linkRecord.line_user_id;
    }
  }

  if (!customerId && lineUserId) {
    const link = await one(
      common,
      "SELECT customer_id FROM customer_links WHERE oa_id=? AND line_user_id=?",
      [oaId, lineUserId],
    );
    if (link) customerId = link.customer_id;
  }

  if (!customerId && payload.guestEmail) {
    // 外部IDまたはメールアドレスでの照合
    const ext = await one(
      common,
      "SELECT customer_id, line_user_id FROM external_links WHERE oa_id=? AND service='timerex' AND external_id=?",
      [oaId, payload.guestEmail],
    );
    if (ext) {
      customerId = ext.customer_id;
      lineUserId = ext.line_user_id;
    }
  }

  // もし顧客が見つからず、lineUserIdがある場合は新規登録
  if (!customerId && lineUserId) {
    const cid = (await digest(`${oaId}:${lineUserId}`)).replace(/[^a-zA-Z0-9]/g, "");
    await common.batch([
      {
        sql: "INSERT OR IGNORE INTO customers(id,name,owner_user_id,team_id,stage,created_at) VALUES (?,?,?,?,'booked',?)",
        params: [cid, payload.guestName || "ご予約のお客様", oa.owner_user_id, oa.team_id, now()],
      },
      {
        sql: "INSERT OR IGNORE INTO customer_links(oa_id,line_user_id,customer_id) VALUES (?,?,?)",
        params: [oaId, lineUserId, cid],
      },
    ]);
    customerId = cid;
  }

  if (!customerId) {
    if (payload.event === "booking.created") {
      await queueBookingNotice(rt, tenantId, oaId, {
        bookingId: payload.bookingId, customerName: payload.guestName, title: payload.title,
        startsAt: payload.startsAt, staffName: payload.staffName, lineLinked: false,
      });
      await audit(rt.db, "system", "appointment.unmatched", payload.bookingId, tenantId);
    }
    // 氏名だけでLINEを推測しない。未連携の予約もSlackで確認できる。
    return { ok: true, state: "unmatched", lineDelivery: false };
  }

  if (!lineUserId) {
    const link = await one(
      common,
      "SELECT line_user_id FROM customer_links WHERE oa_id=? AND customer_id=?",
      [oaId, customerId],
    );
    lineUserId = link?.line_user_id || null;
  }

  const confirmedLink = await one(common,
    "SELECT line_user_id FROM customer_links WHERE oa_id=? AND customer_id=? AND state='confirmed'",
    [oaId, customerId]);
  requireThat(!lineUserId || confirmedLink?.line_user_id === lineUserId, 409, "BOOKING_LINK_MISMATCH", "予約とLINEの紐付けが一致しません。");
  lineUserId = confirmedLink?.line_user_id || null;

  if (payload.event === "booking.cancelled") {
    if (existingAppt && existingAppt.state !== "cancelled") {
      await h.query(
        "UPDATE appointments SET state='cancelled',version=version+1 WHERE id=?",
        [existingAppt.id],
      );
      // 未送信のリマインド送信予定をすべて取消
      await h.query(
        "UPDATE outbox SET state='cancelled',error_code='APPOINTMENT_CANCELLED' WHERE (retry_key LIKE ? OR retry_key LIKE ?) AND state='pending'",
        [`%:${existingAppt.id}`, `%:${existingAppt.id}:%`],
      );
      // outcomes が存在すればキャンセル
      await common.query(
        "UPDATE outcomes SET state='cancelled' WHERE appointment_id=? AND oa_id=?",
        [existingAppt.id, oaId],
      );
      // 別の確定予約が残っている場合は、面談待ちを維持する。
      const remaining = await one(h,
        "SELECT id FROM appointments WHERE customer_id=? AND state IN ('booked','rescheduled') AND julianday(starts_at)>julianday(?) LIMIT 1", [customerId, now()]);
      await common.query(
        "UPDATE customers SET stage=CASE WHEN stage='won' THEN stage ELSE ? END,version=version+1 WHERE id=?",
        [remaining ? "booked" : "result_pending", customerId],
      );
    }
    await holdCustomer(rt,tenantId,customerId,"面談がキャンセルされました。最新の日程で追客を再検討します。");
    return { ok: true, state: "cancelled" };
  }

  if (payload.event === "booking.rescheduled") {
    if (existingAppt) {
      await h.query(
        "UPDATE appointments SET title=?,starts_at=?,ends_at=?,details=?,state='rescheduled',version=version+1 WHERE id=?",
        [payload.title,payload.startsAt, payload.endsAt || null,json({...parse(existingAppt.details),location:payload.location||parse(existingAppt.details).location,detailsUrl:payload.detailsUrl||parse(existingAppt.details).detailsUrl,staffName:payload.staffName||parse(existingAppt.details).staffName}),existingAppt.id],
      );
      // 旧日時のリマインドを取消
      await h.query(
        "UPDATE outbox SET state='cancelled',error_code='RESCHEDULED' WHERE (retry_key LIKE ? OR retry_key LIKE ?) AND state='pending'",
        [`reminder_%:${existingAppt.id}`, `reminder_%:${existingAppt.id}:%`],
      );
      // 新規リマインドの再スケジュール
      if (lineUserId) await scheduleReminders(rt, tenantId, oaId, {
        appointmentId: existingAppt.id,
        customerId,
        lineUserId: lineUserId!,
        title: payload.title,
        startsAt: payload.startsAt,
        staffName: payload.staffName,
        location: payload.location,
      });
    }
    await common.query("UPDATE customers SET stage=CASE WHEN stage IN ('won','lost') THEN stage ELSE 'booked' END,version=version+1 WHERE id=?",[customerId]);
    await holdCustomer(rt,tenantId,customerId,"面談日時が変更されました。以前の日程を使う提案を取り下げました。");
    return { ok: true, state: "rescheduled" };
  }

  // booking.created
  const apptId = existingAppt?.id || id();
  const attribution = verifiedTracking ? "tsunagu_link" : "unconfirmed";

  if (!existingAppt) {
    await h.query(
      "INSERT INTO appointments(id,customer_id,external_id,title,starts_at,ends_at,state,source,attribution,details,version) VALUES (?,?,?,?,?,?,'booked','timerex',?,?,1)",
      [
        apptId,
        customerId,
        payload.bookingId,
        payload.title || "個別面談",
        payload.startsAt,
        payload.endsAt || null,
        attribution,
        json({
          guestName: payload.guestName,
          guestEmail: payload.guestEmail,
          guestPhone: payload.guestPhone,
          location: payload.location,
          detailsUrl: payload.detailsUrl,
          staffName: payload.staffName,
          hostEmails: payload.hostEmails || [],
        }),
      ],
    );
  }

  // 顧客を「予約確定・面談待ち」に移行し、追客を停止
  if (!existingAppt) await common.query(
    "UPDATE customers SET stage='booked',version=version+1 WHERE id=?",
    [customerId],
  );
  await holdCustomer(
    rt,
    tenantId,
    customerId,
    "商談予約が確定したため、追客を停止しました。",
  );

  // 予約完了カードを outbox に即時スケジュール (LINE Flex Message)
  if (lineUserId) {
    const cardFlex = buildBookingCardFlex({
      title: payload.title || "個別面談",
      startsAt: payload.startsAt,
      staffName: payload.staffName,
      location: payload.location,
      detailsUrl: payload.detailsUrl,
    });

    const cardRetryKey = `booking_card:${oaId}:${apptId}`;
    await h.query(
      "INSERT OR IGNORE INTO outbox(id,customer_id,line_user_id,proposal_id,proposal_version,body,kind,state,scheduled_at,retry_key) VALUES (?,?,?,NULL,NULL,?,'booking_card','pending',?,?)",
      [
        id(),
        customerId,
        lineUserId,
        json([{ type: "flex", altText: "【予約完了】個別面談", contents: cardFlex }]),
        now(),
        cardRetryKey,
      ],
    );

    // リマインド (24時間前、1時間前) のスケジュール
    await scheduleReminders(rt, tenantId, oaId, {
      appointmentId: apptId,
      customerId,
      lineUserId,
      title: payload.title || "個別面談",
      startsAt: payload.startsAt,
      staffName: payload.staffName,
      location: payload.location,
    });
  }

  await queueBookingNotice(rt, tenantId, oaId, {
    bookingId: payload.bookingId, customerName: payload.guestName, title: payload.title,
    startsAt: payload.startsAt, staffName: payload.staffName, lineLinked: Boolean(lineUserId),
  });
  await audit(
    rt.db,
    "system",
    "appointment.booked",
    apptId,
    tenantId,
    { source: "timerex", customerId },
  );

  return { ok: true, appointmentId: apptId };
}

export async function scheduleReminders(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  params: {
    appointmentId: string;
    customerId: string;
    lineUserId: string;
    title: string;
    startsAt: string;
    staffName?: string;
    location?: string;
  },
) {
  const company = await one(rt.db, "SELECT settings FROM tenants WHERE id=?", [
    tenantId,
  ]);
  const settings = parse(company?.settings, {});
  const reminderHours: number[] = Array.isArray(settings.reminderHours)
    ? settings.reminderHours
    : [24, 1];

  const h = await rt.openDatabase(tenantId, oaId, "harness");
  const eventTime = Date.parse(params.startsAt);

  for (const hours of reminderHours) {
    const reminderTime = new Date(eventTime - hours * 3600 * 1000);
    // すでに過ぎている送信予定は作成しない（24時間未満の直前予約時など）
    if (reminderTime.getTime() > Date.now()) {
      const retryKey = `reminder_${hours}h:${oaId}:${params.appointmentId}:${eventTime}`;
      const reminderText = buildReminderText({
        title: params.title,
        startsAt: params.startsAt,
        hoursBefore: hours,
        staffName: params.staffName,
        location: params.location,
      });

      await h.query(
        "INSERT OR IGNORE INTO outbox(id,customer_id,line_user_id,proposal_id,proposal_version,body,kind,state,scheduled_at,retry_key) VALUES (?,?,?,NULL,NULL,?,'reminder','pending',?,?)",
        [
          id(),
          params.customerId,
          params.lineUserId,
          json([{ type: "text", text: reminderText }]),
          reminderTime.toISOString(),
          retryKey,
        ],
      );
    }
  }
}

export async function correlateCalendarEvent(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  event: {
    externalId: string;
    title: string;
    startsAt: string;
    endsAt?: string;
    attendeeEmail?: string;
    attendeeName?: string;
    actorUserId?: string;
  },
) {
  const common = await rt.openDatabase(tenantId, "", "common");
  const h = await rt.openDatabase(tenantId, oaId, "harness");
  const ts = await rt.openDatabase(tenantId, oaId, "tsunagu");

  // 顧客の照合: attendeeEmail または attendeeName
  let matchedCustomer: Row | null = null;
  let confidence: "high" | "review" = "review";
  let evidence = "";

  if (event.attendeeEmail) {
    const ext = await one(
      common,
      "SELECT customer_id FROM external_links WHERE oa_id=? AND external_id=?",
      [oaId, event.attendeeEmail],
    );
    if (ext) {
      matchedCustomer = await one(common, "SELECT * FROM customers WHERE id=?", [
        ext.customer_id,
      ]);
      confidence = "high";
      evidence = `メールアドレス (${event.attendeeEmail}) で一致`;
    }
  }

  if (!matchedCustomer && event.attendeeName) {
    const byName = await all(
      common,
      "SELECT * FROM customers WHERE name=? ORDER BY created_at DESC",
      [event.attendeeName],
    );
    if (byName.length === 1) {
      matchedCustomer = byName[0];
      // 直前7日以内のTSUNAGU提案履歴があるか確認
      const recentProposal = await one(
        ts,
        "SELECT * FROM proposals WHERE customer_id=? AND state IN ('approved','sent') AND created_at > ? LIMIT 1",
        [matchedCustomer.id, new Date(Date.now() - 7 * 86400_000).toISOString()],
      );
      if (recentProposal) {
        confidence = "high";
        evidence = `顧客氏名の一致および直近7日以内のTSUNAGU追客履歴 (${recentProposal.trigger})`;
      } else {
        confidence = "review";
        evidence = "顧客氏名の一致（追客履歴との自動紐付けは確認待ち）";
      }
    }
  }

  if (!matchedCustomer) {
    return {
      matched: false,
      reason: "該当する顧客が見つかりません。手動で顧客を指定してください。",
    };
  }

  const apptId = id();
  const attribution =
    confidence === "high" ? "calendar_correlated" : "unconfirmed";

  await h.query(
    "INSERT INTO appointments(id,customer_id,external_id,title,starts_at,ends_at,state,source,attribution,details,version) VALUES (?,?,?,?,?,?,'booked','calendar',?,?,1) ON CONFLICT(external_id) DO UPDATE SET starts_at=excluded.starts_at,ends_at=excluded.ends_at,attribution=excluded.attribution,details=excluded.details",
    [
      apptId,
      matchedCustomer.id,
      event.externalId,
      event.title || "カレンダーアポ",
      event.startsAt,
      event.endsAt || null,
      attribution,
      json({
        matchConfidence: confidence,
        matchEvidence: evidence,
        attendeeEmail: event.attendeeEmail,
        attendeeName: event.attendeeName,
        registeredBy: event.actorUserId,
      }),
    ],
  );

  // 確度が高い場合は追客停止
  if (confidence === "high") {
    await common.query(
      "UPDATE customers SET stage='booked',version=version+1 WHERE id=?",
      [matchedCustomer.id],
    );
    await holdCustomer(
      rt,
      tenantId,
      matchedCustomer.id,
      "カレンダー予約の照合により追客を停止しました。",
    );
  }

  return {
    matched: true,
    customerId: matchedCustomer.id,
    appointmentId: apptId,
    confidence,
    evidence,
  };
}

export function registerBooking(app: Hono<AppEnv>) {
  app.post("/webhooks/timerex/:oaId", async (c) => {
    const rt = c.env.runtime;
    const oaId = c.req.param("oaId");
    const oa = await one(rt.db, "SELECT * FROM accounts WHERE id=?", [oaId]);
    requireThat(oa, 404, "NOT_FOUND", "公式LINEが見つかりません。");

    // 同一OAに紐づくTimeRexチームのセキュリティトークンを必須検証する。
    let expected = rt.timerexSecrets?.[oaId];
    if (!expected) {
      try {
        const cred = await getCredential(rt, oa.tenant_id, oa.id, "timerex");
        expected = cred?.secret;
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "CREDENTIAL_REQUIRED") throw e;
      }
    }
    requireThat(rt.local || expected, 503, "TIMEREX_NOT_CONFIGURED", "TimeRexのセキュリティトークンを設定してください。");
    if (expected) {
      const header = c.req.header("x-timerex-authorization") || c.req.header("authorization") || c.req.header("x-timerex-signature") || c.req.header("x-webhook-signature") || "";
      const token = header.replace(/^Bearer\s+/i, "");
      requireThat(token && await verify(token, "timerex-webhook", await sign(expected, "timerex-webhook")),
        401, "INVALID_SIGNATURE", "TimeRexの認証トークンが一致しません。");
    }

    const raw = await c.req.json();
    if (raw.webhook_type === "tsunagu.connection_test") {
      await recordTimeRexReceipt(rt, oa.tenant_id, oa.id, { authenticated: !!expected }, true);
      return c.json({ ok: true, kind: "self_test" });
    }
    if(rt.selfDemo?.timerexUrl && raw.webhook_type) {
      const expectedUrl=new URL(rt.selfDemo.timerexUrl); let incoming:URL;
      try { incoming=new URL(raw.calendar_url); } catch {return c.json({ok:true,ignored:true});}
      if(incoming.origin!==expectedUrl.origin || incoming.pathname.replace(/\/$/,'')!==expectedUrl.pathname.replace(/\/$/,'')) return c.json({ok:true,ignored:true});
    }
    const payload = normalizeTimeRexPayload(raw);
    await saveBookingReceipt(rt, oa.tenant_id, oa.id, payload);

    const result = await processBookingEvent(rt, oa.tenant_id, oa.id, payload);
    // The core reservation is durable before replying to TimeRex. LINE delivery
    // may outlive TimeRex's 15-second timeout; retain it without delaying the ACK.
    const delivery = receiveDemoTimeRex(rt,oa.tenant_id,oa.id,payload);
    let context: Pick<ExecutionContext, "waitUntil"> | undefined;
    try { context = c.executionCtx; } catch { /* local test runtime */ }
    if (context) context.waitUntil(delivery);
    else await delivery;
    await recordTimeRexReceipt(rt, oa.tenant_id, oa.id, { bookingId: payload.bookingId, event: payload.event, state: result.state || "received" });
    return c.json(result);
  });
}
