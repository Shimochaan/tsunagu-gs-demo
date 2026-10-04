import type { BookingEventPayload } from "./booking.ts";
import { z } from "zod";
import type { Runtime, AppEnv } from "./runtime.ts";
import type { Hono } from "hono";
import { all, one, now, id, json, parse } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { holdCustomer } from "./sales.ts";
import { demoBookingUrl, demoBookingConfigured } from "./self-demo-access.ts";

async function bookingOwner(rt: Runtime, token: string) {
  requireThat(
    rt.selfDemo && /^[A-Za-z0-9_-]{43}$/.test(token),
    404,
    "NOT_FOUND",
    "予約リンクを確認してください。",
  );
  const p = await one(
    rt.db,
    "SELECT p.* FROM gs_demo_participants p JOIN memberships m ON m.user_id=p.user_id AND m.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id WHERE p.booking_hash=? AND p.state='active' AND m.state='active' AND t.state='active' AND p.customer_line_id IS NOT NULL",
    [await digest(token)],
  );
  requireThat(
    p && p.tenant_id === rt.selfDemo.tenant,
    404,
    "BOOKING_LINK_INVALID",
    "予約リンクが無効です。体験画面から顧客用LINEの本人確認を完了してください。",
  );
  return p!;
}
export async function demoBookingView(rt: Runtime, token: string) {
  const p = await bookingOwner(rt, token);
  const b = await one(
    rt.db,
    "SELECT starts_at,state,version,notice_state,source,details_url FROM gs_demo_bookings WHERE user_id=? ORDER BY updated_at DESC LIMIT 1",
    [p.user_id],
  );
  if (rt.selfDemo?.timerexUrl) {
    const configured = await demoBookingConfigured(rt);
    const url = new URL(rt.selfDemo.timerexUrl);
    url.searchParams.set("tracking_token", token);
    return {
      title: "G’s不動産・日程予約",
      booking: b,
      timezone: "Asia/Tokyo",
      mode: "timerex",
      configured,
      timerexUrl: configured ? url.href : null,
      message:
        configured ? "TimeRexの空き日時から予約できます。予約完了・変更・取消を、本人確認した顧客用LINEへお知らせします。体験後は予約を取り消してください。" : "予約通知の接続を準備しています。接続完了後、この画面から予約できるようになります。議事録・物件・文案の体験は続けられます。",
    };
  }
  return {
    title: "G’s不動産・体験用の住まい相談",
    booking: b,
    timezone: "Asia/Tokyo",
    mode: "demo",
    message:
      "希望日時を選ぶと予約が記録され、ご本人のLINEへ確認が届きます。提出用の体験予約です。実際の接客・内見は行いません。",
  };
}
export async function saveDemoBooking(
  rt: Runtime,
  token: string,
  input: unknown,
) {
  const p = await bookingOwner(rt, token),
    { tenant, oa } = rt.selfDemo!;
  requireThat(
    !rt.selfDemo?.timerexUrl,
    409,
    "USE_TIMEREX",
    "TimeRexの予約ページから日時を選んでください。",
  );
  const b = z
    .object({
      action: z.enum(["book", "reschedule", "cancel"]),
      startsAt: z.string().datetime().optional(),
      version: z.number().int().min(0),
    })
    .strict()
    .parse(input);
  const prev = await one(rt.db, "SELECT * FROM gs_demo_bookings WHERE id=?", [
    p.customer_id,
  ]);
  const start = b.action === "cancel" ? prev?.starts_at : b.startsAt;
  requireThat(
    start &&
      (b.action === "cancel" ||
        (Date.parse(start) > Date.now() + 60000 &&
          Date.parse(start) < Date.now() + 90 * 86400000)),
    422,
    "BOOKING_DATE",
    "1分後から90日先までの日時を選んでください。",
  );
  const state = b.action === "cancel" ? "cancelled" : "booked";
  // Repeating an identical submission is a read, not a second delivery.
  if (
    prev &&
    prev.state === state &&
    prev.starts_at === start &&
    prev.version === b.version + 1
  )
    return demoBookingView(rt, token);
  requireThat(
    (!prev && b.action === "book" && b.version === 0) ||
      (prev && prev.version === b.version),
    409,
    "BOOKING_CHANGED",
    "予約が変更されています。最新の予約内容を確認してください。",
  );
  const recent = await one(
    rt.db,
    "SELECT COUNT(*) AS n FROM gs_demo_actions WHERE user_id=? AND kind='booking' AND day=?",
    [p.user_id, now().slice(0, 10)],
  );
  requireThat(
    recent!.n < 8,
    429,
    "BOOKING_LIMIT",
    "本日の予約体験は8回までです。",
  );
  const retry = id(),
    at = now();
  const claim = prev
    ? await rt.db.query(
        "UPDATE gs_demo_bookings SET starts_at=?,state=?,version=version+1,notice_state='pending',retry_key=?,updated_at=? WHERE id=? AND version=? AND notice_state NOT IN ('sending','uncertain')",
        [start, state, retry, at, p.customer_id, b.version],
      )
    : await rt.db.query(
        "INSERT OR IGNORE INTO gs_demo_bookings(id,user_id,starts_at,state,retry_key,updated_at) VALUES (?,?,?,?,?,?)",
        [p.customer_id, p.user_id, start, state, retry, at],
      );
  requireThat(
    claim.changes,
    409,
    "BOOKING_CHANGED",
    "予約内容の反映中、または送信結果を確認中です。最新の内容をご確認ください。",
  );
  await rt.db.query(
    "INSERT OR IGNORE INTO gs_demo_actions(id,user_id,kind,day,created_at) VALUES (?,?,'booking',?,?)",
    [retry, p.user_id, at.slice(0, 10), at],
  );
  const h = await rt.openDatabase(tenant, oa, "harness"),
    common = await rt.openDatabase(tenant, "", "common");
  // The reservation and the follow-up stop use the same appointment records as the real product.
  await h.query(
    "INSERT INTO appointments(id,customer_id,external_id,title,starts_at,ends_at,state,source,attribution,details) VALUES (?,?,?,'体験用の住まい相談',?,?,?,'self_demo','tsunagu_link',?) ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at,ends_at=excluded.ends_at,state=excluded.state,version=version+1,details=excluded.details",
    [
      "demo-booking-" + p.customer_id,
      p.customer_id,
      "demo-booking-" + p.customer_id,
      start,
      new Date(Date.parse(start) + 1800000).toISOString(),
      state,
      json({ detailsUrl: await demoBookingUrl(rt, p.customer_id), demo: true }),
    ],
  );
  await common.query(
    "UPDATE customers SET stage=?,version=version+1 WHERE id=?",
    [state === "booked" ? "booked" : "result_pending", p.customer_id],
  );
  await holdCustomer(
    rt,
    tenant,
    p.customer_id,
    state === "booked"
      ? "予約が入りました。予約前の追客提案を停止しました。"
      : "予約が取り消されました。日程を再確認してください。",
  );
  try {
    requireThat(
      rt.customerTestDelivery?.sendDemoBooking,
      503,
      "BOOKING_DELIVERY_UNAVAILABLE",
      "予約通知を送る接続が未設定です。",
    );
    await rt.customerTestDelivery!.sendDemoBooking!(
      rt,
      p.user_id,
      p.customer_id,
      b.version + 1,
    );
  } catch (e: any) {
    // Preserve the saved reservation and surface notification status separately.
    await rt.db.query(
      "UPDATE gs_demo_bookings SET notice_state=CASE WHEN notice_state IN ('sending','uncertain') THEN 'uncertain' ELSE 'failed' END WHERE id=? AND version=? AND notice_state<>'accepted'",
      [p.customer_id, b.version + 1],
    );
  }
  return demoBookingView(rt, token);
}
export function registerDemoBooking(app: Hono<AppEnv>) {
  app.get("/api/demo-bookings/:token", async (c) =>
    c.json(await demoBookingView(c.env.runtime, c.req.param("token"))),
  );
  app.post("/api/demo-bookings/:token", async (c) =>
    c.json(
      await saveDemoBooking(
        c.env.runtime,
        c.req.param("token"),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/demo-property/:id", async (c) => {
    const rt = c.env.runtime;
    requireThat(rt.selfDemo, 404, "NOT_FOUND", "物件が見つかりません。");
    const ts = await rt.openDatabase(
      rt.selfDemo.tenant,
      rt.selfDemo.oa,
      "tsunagu",
    );
    const s = await one(
      ts,
      "SELECT title,data,checked_at FROM assistant_sources WHERE id=? AND kind='product'",
      [c.req.param("id")],
    );
    requireThat(s, 404, "NOT_FOUND", "物件が見つかりません。");
    const d = JSON.parse(s.data);
    return c.json({
      title: s.title,
      summary: d.summary,
      area: d.area,
      price: d.price,
      status: d.status,
      property: d.property,
      checkedAt: s.checked_at,
      demo: true,
    });
  });
}

// Called only after the authenticated TimeRex webhook has updated the core appointment.
export async function receiveDemoTimeRex(
  rt: Runtime,
  tenant: string,
  oa: string,
  payload: BookingEventPayload,
) {
  if (!rt.selfDemo || tenant !== rt.selfDemo.tenant || oa !== rt.selfDemo.oa)
    return;
  const h = await rt.openDatabase(tenant, oa, "harness");
  const appointment = await one(
    h,
    "SELECT * FROM appointments WHERE external_id=?",
    [payload.bookingId],
  );
  if (!appointment) return;
  const p = await one(
    rt.db,
    "SELECT * FROM gs_demo_participants WHERE tenant_id=? AND customer_id=? AND state='active' AND customer_line_id IS NOT NULL",
    [tenant, appointment.customer_id],
  );
  if (!p) return;
  const old = await one(
    rt.db,
    "SELECT * FROM gs_demo_bookings WHERE external_id=?",
    [payload.bookingId],
  );
  const state = appointment.state === "cancelled" ? "cancelled" : "booked";
  const unchanged = old && old.state === state && old.starts_at === appointment.starts_at;
  if (unchanged && old.notice_state !== "pending") return;
  const bid = old?.id || id(),
    version = unchanged ? old.version : (old?.version || 0) + 1;
  const claim = unchanged ? { changes: 1 } : old
    ? await rt.db.query(
        "UPDATE gs_demo_bookings SET starts_at=?,state=?,version=version+1,notice_state='pending',retry_key=?,details_url=?,updated_at=? WHERE id=? AND version=? AND notice_state<>'sending'",
        [
          appointment.starts_at,
          state,
          id(),
          payload.detailsUrl || old.details_url,
          now(),
          bid,
          old.version,
        ],
      )
    : await rt.db.query(
        "INSERT OR IGNORE INTO gs_demo_bookings(id,user_id,starts_at,state,retry_key,source,external_id,details_url,updated_at) VALUES (?,?,?,?,?,'timerex',?,?,?)",
        [
          bid,
          p.user_id,
          appointment.starts_at,
          state,
          id(),
          payload.bookingId,
          payload.detailsUrl || null,
          now(),
        ],
      );
  if (!claim.changes) return;
  await h.query(
    "UPDATE outbox SET state='cancelled',error_code='DEMO_RECEIPT_TRANSPORT' WHERE customer_id=? AND kind IN ('booking_card','reminder') AND state='pending'",
    [p.customer_id],
  );
  try {
    requireThat(rt.customerTestDelivery?.sendDemoBooking, 503, "BOOKING_DELIVERY_UNAVAILABLE", "予約通知の接続を確認してください。");
    await rt.customerTestDelivery!.sendDemoBooking!(
      rt,
      p.user_id,
      bid,
      version,
    );
  } catch {
    await rt.db.query(
      "UPDATE gs_demo_bookings SET notice_state=CASE WHEN notice_state IN ('sending','uncertain') THEN 'uncertain' ELSE 'failed' END WHERE id=? AND version=? AND notice_state<>'accepted'",
      [bid, version],
    );
  }
}

// Recover a crash between core booking storage and receipt storage. Reconcile a
// cancellation that raced an earlier send. Unknown deliveries are never resent.
export async function reconcileDemoBookings(rt: Runtime) {
  if (!rt.selfDemo) return;
  const {tenant, oa} = rt.selfDemo;
  const people = await all(rt.db,
    "SELECT customer_id FROM gs_demo_participants WHERE tenant_id=? AND state='active' AND customer_line_id IS NOT NULL", [tenant]);
  if (!people.length) return;
  await rt.db.query(
    "UPDATE gs_demo_bookings SET notice_state='uncertain' WHERE notice_state='sending' AND updated_at<?",
    [new Date(Date.now()-5*60000).toISOString()]);
  const h = await rt.openDatabase(tenant, oa, "harness");
  const rows = await all(h,
    `SELECT * FROM appointments WHERE source='timerex' AND customer_id IN (${people.map(()=>"?").join(",")}) ORDER BY starts_at DESC LIMIT 100`,
    people.map(p=>p.customer_id));
  for (const a of rows) {
    const d=parse(a.details);
    await receiveDemoTimeRex(rt,tenant,oa,{
      event:a.state==='cancelled'?'booking.cancelled':'booking.created',
      bookingId:a.external_id,title:a.title,startsAt:a.starts_at,guestName:'',guestEmail:'',detailsUrl:d.detailsUrl,
    });
  }
}
