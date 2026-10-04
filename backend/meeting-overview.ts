import { calendarDDL } from "./calendar.ts";
import { bookingReceiptsDDL } from "./meeting-schema.ts";
export { bookingReceiptsDDL } from "./meeting-schema.ts";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, json, now, type Row } from "./db.ts";
import { customerAccess } from "./access.ts";
import { parse } from "./db.ts";
import { recordingAccess } from "./recording-sources.ts";

export function japanWeek(at = new Date()) {
  const local = new Date(at.getTime() + 9 * 3600000),
    day = local.toISOString().slice(0, 10),
    monday = new Date(`${day}T00:00:00+09:00`);
  monday.setTime(monday.getTime() - ((local.getUTCDay() + 6) % 7) * 86400000);
  return {
    today: day,
    start: monday.toISOString(),
    end: new Date(monday.getTime() + 7 * 86400000).toISOString(),
    days: Array.from({ length: 7 }, (_, i) =>
      new Date(monday.getTime() + i * 86400000 + 9 * 3600000)
        .toISOString()
        .slice(0, 10),
    ),
  };
}
export async function saveBookingReceipt(
  rt: Runtime,
  tenant: string,
  oa: string,
  p: Row,
) {
  const h = await rt.openDatabase(tenant, oa, "harness");
  await h.query(bookingReceiptsDDL);
  await h.query(
    "INSERT INTO booking_receipts VALUES (?,?,?,?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET title=excluded.title,guest_name=excluded.guest_name,starts_at=CASE WHEN excluded.starts_at='' THEN booking_receipts.starts_at ELSE excluded.starts_at END,ends_at=excluded.ends_at,state=CASE WHEN booking_receipts.state='cancelled' THEN 'cancelled' ELSE excluded.state END,received_at=excluded.received_at",
    [
      p.bookingId,
      p.title || "面談",
      p.guestName || null,
      p.startsAt || "",
      p.endsAt || null,
      p.event === "booking.cancelled" ? "cancelled" : "booked",
      now(),
    ],
  );
}
export function registerMeetingOverview(app: Hono<AppEnv>) {
  app.get(
    "/api/tenants/:tenantId/accounts/:oaId/meeting-overview",
    async (c) => {
      const a = await recordingAccess(c),
        h = await a.rt.openDatabase(a.tenant, a.oa, "harness"),
        common = await a.rt.openDatabase(a.tenant, "", "common");
      await h.query(bookingReceiptsDDL);
      const customers = (
          await all(
            common,
            "SELECT c.* FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE l.oa_id=? AND l.state='confirmed'",
            [a.oa],
          )
        ).filter((x) =>
          customerAccess(a.m, x, "read", parse(c.get("tenant").settings)),
        ),
        allowed = new Set(customers.map((x) => x.id)),
        week = japanWeek();
      const rows = (
        await all(
          h,
          "SELECT * FROM appointments WHERE julianday(starts_at)>=julianday(?) AND julianday(starts_at)<julianday(?) AND state IN ('booked','rescheduled','attended') ORDER BY starts_at",
          [week.start, week.end],
        )
      ).filter((x) => allowed.has(x.customer_id));
      const unlinked = await all(
        h,
        "SELECT r.* FROM booking_receipts r WHERE julianday(starts_at)>=julianday(?) AND julianday(starts_at)<julianday(?) AND state='booked' AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.external_id=r.external_id)",
        [week.start, week.end],
      );
      const ts=await a.rt.openDatabase(a.tenant,a.oa,'tsunagu');for(const sql of calendarDDL) await ts.query(sql);
      const connections=await all(a.rt.db,"SELECT id FROM connections WHERE tenant_id=? AND oa_id=? AND service=? AND state='connected'",[a.tenant,a.oa,`google_calendar:${a.m.user_id}`]);
      const calendar=await all(ts,"SELECT * FROM calendar_items WHERE connection_id IN (SELECT value FROM json_each(?)) AND appointment_id IS NULL AND state<>'cancelled' AND julianday(starts_at)>=julianday(?) AND julianday(starts_at)<julianday(?)",[json(connections.map(x=>x.id)),week.start,week.end]);
      const meetings = [
        ...calendar.map(x=>({...x,source:'google_calendar',customerName:x.title,unlinked:true})),
        ...rows.map((x) => ({
          ...x,
          customerName: customers.find((y) => y.id === x.customer_id)?.name,
        })),
        ...unlinked.map((x) => ({
          ...x,
          id: `unlinked:${x.external_id}`,
          customerName: x.guest_name || x.title,
          unlinked: true,
        })),
      ].sort(
        (x: Row, y: Row) => Date.parse(x.starts_at) - Date.parse(y.starts_at),
      );
      return c.json({ week, meetings });
    },
  );
}
