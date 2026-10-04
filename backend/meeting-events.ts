import type { Runtime } from "./runtime.ts";
import { one, now, parse } from "./db.ts";
import { holdCustomer } from "./sales.ts";
// 面談結果はイベントを残してから別DBへ反映する。再実行でも版・成果を二重計上しない。
export async function applyMeetingResult(
  rt: Runtime,
  tenant: string,
  oa: string,
  eventId: string,
) {
  const h = await rt.openDatabase(tenant, oa, "harness"),
    common = await rt.openDatabase(tenant, "", "common"),
    ts = await rt.openDatabase(tenant, oa, "tsunagu");
  const event = await one(
    h,
    "SELECT * FROM events WHERE id=? AND type='meeting.result' AND state='pending'",
    [eventId],
  );
  if (!event) return;
  const p = parse(event.payload),
    meeting = await one(h, "SELECT * FROM appointments WHERE id=?", [
      p.meetingId,
    ]);
  if (!meeting || meeting.version !== p.version) {
    await h.query("UPDATE events SET state='superseded' WHERE id=?", [eventId]);
    return;
  }
  const customer = await one(common, "SELECT * FROM customers WHERE id=?", [
    event.customer_id,
  ]);
  if (!customer) throw new Error("Meeting customer missing");
  const stage =
    customer.stage === "won"
      ? "won"
      : p.state === "attended"
        ? p.deal === "won"
          ? "won"
          : p.deal === "uncontracted"
            ? "post_meeting"
            : "result_pending"
        : "result_pending";
  const mode = stage === "won" ? "stopped" : (p.mode ?? customer.mode);
  await common.batch([
    {
      sql: "UPDATE customers SET stage=?,mode=?,confirmed_at=?,confirmed_by=?,version=version+1 WHERE id=? AND NOT EXISTS (SELECT 1 FROM processed_events WHERE id=?)",
      params: [
        stage,
        mode,
        event.occurred_at,
        p.actor,
        event.customer_id,
        eventId,
      ],
    },
    {
      sql: "INSERT OR IGNORE INTO processed_events(id,at) VALUES (?,?)",
      params: [eventId, now()],
    },
  ]);
  await ts.query(
    "INSERT OR IGNORE INTO context_notes(id,customer_id,appointment_id,source,body,deal_state,confirmed_by,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      eventId,
      event.customer_id,
      p.meetingId,
      "manual",
      p.note,
      p.deal,
      p.actor,
      event.occurred_at,
      event.occurred_at,
    ],
  );
  await holdCustomer(
    rt,
    tenant,
    event.customer_id,
    "面談結果が確認されました。最新の内容から追客を再検討してください。",
  );
  if (p.state === "attended")
    await common.query(
      "INSERT INTO outcomes(id,oa_id,customer_id,appointment_id,kind,source,occurred_at,confirmed_by) VALUES (?,?,?,?,'attended',?,?,?) ON CONFLICT(oa_id,appointment_id,kind) DO UPDATE SET state='candidate',confirmed_by=excluded.confirmed_by",
      [
        `attended:${oa}:${meeting.id}`,
        oa,
        event.customer_id,
        meeting.id,
        meeting.attribution,
        meeting.starts_at,
        p.actor,
      ],
    );
  else
    await common.query(
      "UPDATE outcomes SET state='cancelled',confirmed_by=? WHERE oa_id=? AND appointment_id=? AND kind='attended'",
      [p.actor, oa, meeting.id],
    );
  await h.query("UPDATE events SET state='processed' WHERE id=?", [eventId]);
}
