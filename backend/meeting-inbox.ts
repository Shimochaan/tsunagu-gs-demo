import {
  rememberMeetingBinding,
  queueConfirmedMeeting,
} from "./meeting-automation.ts";
import {
  registerCustomerRecordings,
  readableMeetingConnection,
} from "./customer-recordings.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv } from "./runtime.ts";
import { all, one, now, json, parse, type Row } from "./db.ts";
import { customerAccess } from "./access.ts";
import { recordingAccess } from "./recording-sources.ts";
import { inboxDB, readMeetingText, refreshMeetingDocument } from "./drive.ts";
import {
  extractMeetingInsights,
  meetingExtractSchema,
} from "./meet-analysis.ts";
import { requireThat, audit } from "./security.ts";
import { holdCustomer } from "./sales.ts";

export function suggestMeetingFriends(
  doc: Row,
  customers: Row[],
  appointments: Row[],
) {
  const title = String(doc.title)
    .normalize("NFKC")
    .replace(/\s/g, "")
    .toLowerCase();
  return customers
    .map((customer) => {
      const name = String(customer.name)
        .normalize("NFKC")
        .replace(/\s/g, "")
        .toLowerCase();
      const meetings = appointments.filter(
        (a) =>
          a.customer_id === customer.id &&
          ["booked", "rescheduled", "attended"].includes(a.state) &&
          doc.held_at &&
          Math.abs(Date.parse(a.starts_at) - Date.parse(doc.held_at)) <=
            90 * 60000 &&
          parse(a.details).hostEmails?.some(
            (e: string) => e.toLowerCase() === doc.source_email.toLowerCase(),
          ),
      );
      const named = name.length >= 2 && title.includes(name);
      return {
        id: customer.id,
        name: customer.name,
        score: meetings.length ? 100 : named ? 50 : 0,
        reason: meetings.length
          ? "TimeRexの担当者・日時が一致"
          : named
            ? "議事録のタイトルに氏名が含まれる"
            : "候補にない場合は手動で選択",
        appointments: meetings.map((a) => ({
          id: a.id,
          title: a.title,
          startsAt: a.starts_at,
        })),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
}
export function registerMeetingInbox(app: Hono<AppEnv>) {
  registerCustomerRecordings(app);
  const base = "/api/tenants/:tenantId/accounts/:oaId/meeting-inbox";
  const ctx = async (c: any) => {
    const a = await recordingAccess(c),
      db = await inboxDB(a.rt, a.tenant, a.oa),
      common = await a.rt.openDatabase(a.tenant, "", "common"),
      h = await a.rt.openDatabase(a.tenant, a.oa, "harness");
    const customers = (
      await all(
        common,
        "SELECT DISTINCT c.* FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE l.oa_id=? AND l.state='confirmed'",
        [a.oa],
      )
    ).filter((x) =>
      customerAccess(a.m, x, "edit", parse(c.get("tenant").settings)),
    );
    const connections = await all(
      a.rt.db,
      "SELECT id FROM connections WHERE tenant_id=? AND oa_id=? AND service=? AND state IN ('connected','syncing')",
      [a.tenant, a.oa, `google_drive:${c.get("principal").user.id}`],
    );
    return {
      connectionIds: connections.map((x) => x.id),
      ...a,
      db,
      common,
      h,
      customers,
      actor: c.get("principal").user.id,
    };
  };
  app.post(base + "/:fileId/refresh", async (c) => {
    const a = await ctx(c),
      doc = await one(a.db, "SELECT * FROM meeting_inbox WHERE id=?", [
        c.req.param("fileId")!,
      ]);
    requireThat(
      doc &&
        a.connectionIds.includes(doc.connection_id) &&
        (!doc.customer_id || a.customers.some((x) => x.id === doc.customer_id)),
      404,
      "NOTE_NOT_FOUND",
      "この議事録を確認する権限がありません。",
    );
    const con = await readableMeetingConnection(
      a.rt,
      a.tenant,
      a.oa,
      a.actor,
      doc!.connection_id,
    );
    const fresh = await refreshMeetingDocument(a.rt, con, doc!);
    return c.json({ id: fresh.id, version: fresh.version });
  });
  app.get(base, async (c) => {
    const a = await ctx(c),
      rows = await all(
        a.db,
        "SELECT d.*,s.state AS auto_state,s.detail AS auto_detail FROM meeting_inbox d LEFT JOIN meeting_auto_state s ON s.file_id=d.id WHERE d.state NOT IN ('ignored','missing') ORDER BY COALESCE(d.held_at,d.detected_at) DESC LIMIT 200",
        [],
      );
    return c.json({
      documents: rows
        .filter(
          (d) =>
            a.connectionIds.includes(d.connection_id) &&
            (!d.customer_id || a.customers.some((x) => x.id === d.customer_id)),
        )
        .map((d) => ({
          ...d,
          analysis: parse(d.analysis, null),
          fileUrl: `https://drive.google.com/file/d/${encodeURIComponent(d.id)}/view`,
        })),
      limit: 200,
    });
  });
  app.get(base + "/:fileId/candidates", async (c) => {
    const a = await ctx(c),
      doc = await one(a.db, "SELECT * FROM meeting_inbox WHERE id=?", [
        c.req.param("fileId")!,
      ]);
    requireThat(
      doc && a.connectionIds.includes(doc.connection_id),
      404,
      "NOTE_NOT_FOUND",
      "議事録が見つかりません。",
    );
    requireThat(
      !doc!.customer_id || a.customers.some((x) => x.id === doc!.customer_id),
      403,
      "NOTE_FORBIDDEN",
      "議事録を編集する権限がありません。",
    );
    const appointments = await all(
      a.h,
      "SELECT * FROM appointments WHERE state IN ('booked','rescheduled','attended')",
    );
    return c.json({
      candidates: suggestMeetingFriends(doc!, a.customers, appointments),
      appointments: appointments
        .filter((x) => a.customers.some((y) => y.id === x.customer_id))
        .map((x) => ({
          id: x.id,
          customerId: x.customer_id,
          title: x.title,
          startsAt: x.starts_at,
        })),
    });
  });
  app.post(base + "/:fileId/analyze", async (c) => {
    const a = await ctx(c),
      v = z
        .object({
          version: z.number().int().positive(),
          customerId: z.string(),
          appointmentId: z.string().nullable().default(null),
          heldAt: z.iso.datetime({ offset: true }),
        })
        .parse(await c.req.json());
    const doc = await one(a.db, "SELECT * FROM meeting_inbox WHERE id=?", [
        c.req.param("fileId")!,
      ]),
      customer = a.customers.find((x) => x.id === v.customerId);
    requireThat(
      doc &&
        a.connectionIds.includes(doc.connection_id) &&
        customer &&
        (!doc.customer_id || a.customers.some((x) => x.id === doc.customer_id)),
      404,
      "NOTE_CUSTOMER_NOT_FOUND",
      "議事録または紐付け可能な友だちが見つかりません。",
    );
    requireThat(
      Date.parse(v.heldAt) <= Date.now(),
      400,
      "MEETING_FUTURE",
      "実施済みの会議日時を指定してください。",
    );
    const appt = v.appointmentId
      ? await one(
          a.h,
          "SELECT * FROM appointments WHERE id=? AND customer_id=? AND state IN ('booked','rescheduled','attended') AND julianday(starts_at)<=julianday(?)",
          [v.appointmentId, customer!.id, now()],
        )
      : null;
    requireThat(
      !v.appointmentId || appt,
      409,
      "MEETING_MISMATCH",
      "選択した友だちの実施済み予約を指定してください。",
    );
    requireThat(
      a.rt.ai?.apiKey || a.rt.local,
      503,
      "AI_NOT_CONFIGURED",
      "AI接続を設定してから解析してください。",
    );
    const con = await one(
      a.rt.db,
      "SELECT * FROM connections WHERE id=? AND tenant_id=? AND oa_id=? AND state IN ('connected','syncing')",
      [doc!.connection_id, a.tenant, a.oa],
    );
    requireThat(
      con,
      409,
      "DRIVE_NOT_CONNECTED",
      "議事録の担当者がGoogle Driveを再連携してください。",
    );
    const lock = await a.db.query(
      "UPDATE meeting_inbox SET state='analyzing',lease_until=? WHERE id=? AND version=? AND (state IN ('unlinked','draft','error') OR (state='analyzing' AND lease_until<?))",
      [new Date(Date.now() + 120000).toISOString(), doc!.id, v.version, now()],
    );
    requireThat(
      lock.changes,
      409,
      "NOTE_CHANGED",
      "解析中または更新済みです。再読み込みしてください。",
    );
    try {
      const transcript = await readMeetingText(a.rt, con!, doc!);
      const extract = await extractMeetingInsights(
        a.rt,
        a.tenant,
        a.oa,
        a.actor,
        {
          customerName: customer!.name,
          title: doc!.title,
          heldAt: v.heldAt,
          transcript,
        },
      );
      await a.db.query(
        "UPDATE meeting_inbox SET state='draft',analysis=?,customer_id=?,appointment_id=?,held_at=?,customer_version=?,appointment_version=?,lease_until=NULL,version=version+1 WHERE id=? AND state='analyzing' AND version=?",
        [
          json(extract),
          customer!.id,
          v.appointmentId,
          v.heldAt,
          customer!.version,
          appt?.version ?? null,
          doc!.id,
          v.version,
        ],
      );
      return c.json({ ok: true });
    } catch (error) {
      await a.db.query(
        "UPDATE meeting_inbox SET state='error',lease_until=NULL WHERE id=? AND state='analyzing' AND version=?",
        [doc!.id, v.version],
      );
      throw error;
    }
  });
  app.post(base + "/:fileId/confirm", async (c) => {
    const a = await ctx(c),
      v = z
        .object({
          version: z.number().int().positive(),
          confirmed: z.literal(true),
        })
        .parse(await c.req.json()),
      doc = await one(a.db, "SELECT * FROM meeting_inbox WHERE id=?", [
        c.req.param("fileId")!,
      ]);
    requireThat(
      doc &&
        a.connectionIds.includes(doc.connection_id) &&
        a.customers.some((x) => x.id === doc.customer_id),
      404,
      "NOTE_NOT_FOUND",
      "議事録を編集する権限がありません。",
    );
    if (doc!.state === "linked")
      return c.json({ ok: true, alreadyLinked: true });
    requireThat(
      doc!.version === v.version && ["draft", "applying"].includes(doc!.state),
      409,
      "NOTE_CHANGED",
      "解析結果を再読み込みしてください。",
    );
    const con = await readableMeetingConnection(
      a.rt,
      a.tenant,
      a.oa,
      a.actor,
      doc!.connection_id,
    );
    await readMeetingText(a.rt, con, doc!);
    const extract = meetingExtractSchema.parse(parse(doc!.analysis)),
      customer = a.customers.find((x) => x.id === doc!.customer_id)!,
      eventId = `drive:${a.oa}:${doc!.id}:${doc!.modified_at}`,
      applied = await one(
        a.common,
        "SELECT id FROM processed_events WHERE id=?",
        [eventId],
      );
    requireThat(
      applied || customer.version === doc!.customer_version,
      409,
      "CUSTOMER_CHANGED",
      "友だちの状況が更新されました。再解析してください。",
    );
    const appt = doc!.appointment_id
      ? await one(
          a.h,
          "SELECT * FROM appointments WHERE id=? AND customer_id=?",
          [doc!.appointment_id, customer.id],
        )
      : null;
    requireThat(
      !doc!.appointment_id ||
        (appt &&
          ["booked", "rescheduled", "attended"].includes(appt.state) &&
          (appt.version === doc!.appointment_version ||
            parse(appt.details).meetingNoteId === eventId)),
      409,
      "MEETING_CHANGED",
      "面談結果が更新されました。再解析してください。",
    );
    const lock = await a.db.query(
      "UPDATE meeting_inbox SET state='applying',lease_until=? WHERE id=? AND version=? AND (state='draft' OR (state='applying' AND (lease_until IS NULL OR lease_until<?)))",
      [new Date(Date.now() + 120000).toISOString(), doc!.id, v.version, now()],
    );
    requireThat(
      lock.changes,
      409,
      "NOTE_BUSY",
      "保存中です。少し待って再読み込みしてください。",
    );
    try {
      const at = now(),
        future = await one(
          a.h,
          "SELECT id FROM appointments WHERE customer_id=? AND julianday(starts_at)>julianday(?) AND state IN ('booked','rescheduled')",
          [customer.id, at],
        );
      const stage =
        customer.stage === "won"
          ? "won"
          : extract.dealState === "won"
            ? "won"
            : future
              ? "booked"
              : extract.stage;
      await a.common.batch([
        {
          sql: "UPDATE customers SET stage=?,mode=?,version=version+1,confirmed_at=?,confirmed_by=? WHERE id=? AND version=? AND NOT EXISTS (SELECT 1 FROM processed_events WHERE id=?)",
          params: [
            stage,
            ["won", "lost"].includes(stage) ? "stopped" : customer.mode,
            at,
            a.actor,
            customer.id,
            doc!.customer_version,
            eventId,
          ],
        },
        {
          sql: "INSERT OR IGNORE INTO processed_events(id,at) SELECT ?,? WHERE EXISTS (SELECT 1 FROM customers WHERE id=? AND confirmed_at=? AND version=?)",
          params: [eventId, at, customer.id, at, doc!.customer_version + 1],
        },
      ]);
      requireThat(
        await one(a.common, "SELECT id FROM processed_events WHERE id=?", [
          eventId,
        ]),
        409,
        "CUSTOMER_CHANGED",
        "友だちの状況が更新されました。再解析してください。",
      );
      const body = [
        `【${doc!.title}】`,
        extract.summary,
        `要点：${extract.keyPoints.join(" / ")}`,
        `懸念：${extract.concerns.join(" / ")}`,
        `関心：${extract.interests.join(" / ")}`,
        `次のアクション：${extract.nextAction}`,
      ].join("\n");
      await a.db.query(
        "UPDATE context_notes SET deleted_at=? WHERE customer_id=? AND source='google_drive' AND source_ref=? AND id<>?",
        [at, customer.id, doc!.id, eventId],
      );
      await a.db.query(
        "INSERT OR IGNORE INTO context_notes(id,customer_id,appointment_id,source,source_ref,body,deal_state,confirmed_by,confirmed_at,created_at) VALUES (?,?,?,'google_drive',?,?,?,?,?,?)",
        [
          eventId,
          customer.id,
          doc!.appointment_id,
          doc!.id,
          body,
          extract.dealState,
          a.actor,
          at,
          at,
        ],
      );
      if (appt) {
        const r = await a.h.query(
          "UPDATE appointments SET state='attended',details=json_set(details,'$.meetingNoteId',?,'$.dealState',?,'$.recording',json(?)),version=version+1 WHERE id=? AND version=? AND state IN ('booked','rescheduled','attended')",
          [
            eventId,
            extract.dealState,
            json({
              fileUrl: `https://drive.google.com/file/d/${doc!.id}/view`,
              confirmedBy: a.actor,
              confirmedAt: at,
            }),
            appt.id,
            doc!.appointment_version,
          ],
        );
        requireThat(
          r.changes || parse(appt.details).meetingNoteId === eventId,
          409,
          "MEETING_CHANGED",
          "面談が更新されました。確認して保存を再試行してください。",
        );
      }
      if (!["won", "lost"].includes(stage))
        for (const [i, trig] of extract.triggers.entries()) {
          const scheduledAt = new Date(
            Date.parse(doc!.held_at) + trig.daysAfter * 86400000,
          ).toISOString();
          await a.h.query(
            "INSERT OR IGNORE INTO events(id,customer_id,type,payload,occurred_at,state) VALUES (?,?,'meeting.trigger',?,?,'pending')",
            [
              `${eventId}:trigger:${i}`,
              customer.id,
              json({
                intent: trig.intent,
                scheduledAt,
                nextAction: extract.nextAction,
                noteId: eventId,
                source: "google_drive",
              }),
              at,
            ],
          );
        }
      await holdCustomer(
        a.rt,
        a.tenant,
        customer.id,
        "議事録が確認されました。最新の商談内容から追客を再検討してください。",
      );
      await a.db.query(
        "UPDATE meeting_inbox SET state='linked',confirmed_by=?,confirmed_at=?,lease_until=NULL,version=version+1 WHERE id=? AND version=?",
        [a.actor, at, doc!.id, v.version],
      );
      await rememberMeetingBinding(
        a.rt,
        a.tenant,
        a.oa,
        { ...doc, customer_id: customer.id },
        a.actor,
      );
      await queueConfirmedMeeting(a.rt, a.tenant, a.oa, doc!.id, doc!.held_at);
      await audit(
        a.rt.db,
        a.actor,
        "meeting.inbox_confirmed",
        doc!.id,
        a.tenant,
        { oaId: a.oa, customerId: customer.id },
      );
      return c.json({ ok: true });
    } catch (error) {
      const done = await one(
        a.common,
        "SELECT id FROM processed_events WHERE id=?",
        [eventId],
      );
      await a.db.query(
        "UPDATE meeting_inbox SET lease_until=NULL,state=? WHERE id=? AND state='applying'",
        [done ? "applying" : "draft", doc!.id],
      );
      throw error;
    }
  });
  app.post(base + "/:fileId/ignore", async (c) => {
    const a = await ctx(c),
      v = z
        .object({ version: z.number().int().positive() })
        .parse(await c.req.json());
    const r = await a.db.query(
      "UPDATE meeting_inbox SET state='ignored',version=version+1 WHERE id=? AND version=? AND state='unlinked' AND connection_id IN (SELECT value FROM json_each(?))",
      [c.req.param("fileId")!, v.version, json(a.connectionIds)],
    );
    requireThat(
      r.changes,
      409,
      "NOTE_CHANGED",
      "更新済みです。再読み込みしてください。",
    );
    return c.json({ ok: true });
  });
}
