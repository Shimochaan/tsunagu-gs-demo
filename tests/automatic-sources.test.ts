import test from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, ago } from "./helpers/assistant-fixture.ts";
import { one, all, json, parse, now } from "../backend/db.ts";
import { putCredential } from "../backend/credentials.ts";
import {
  scanDrive,
  refreshMeetingDocument,
  readMeetingText,
} from "../backend/drive.ts";
import {
  processMeetingUpdates,
  rememberMeetingBinding,
  groundedMeetingTimings,
  checkedMeetingTracking,
  queueConfirmedMeeting,
} from "../backend/meeting-automation.ts";
import {
  syncCalendar,
  registerCalendar,
  calendarScope,
} from "../backend/calendar.ts";
import { registerMeetingOverview } from "../backend/meeting-overview.ts";
import { processBookingEvent } from "../backend/booking.ts";
import { scanAssistant } from "../backend/assistant.ts";
import { subscribeData, invalidateData } from "../src/product/request-cache.js";

async function driveFixture() {
  const f = await assistantFixture();
  f.rt.googleOAuth = { clientId: "client", clientSecret: "secret" };
  f.rt.ai = { apiKey: "mock-key", model: "mock" };
  await f.ts.query(
    "INSERT INTO assistant_automation(id,data) VALUES ('default',?)",
    [json({ autoDraft: true })],
  );
  await putCredential(
    f.rt,
    "t",
    "oa",
    "google_drive:owner",
    { refreshToken: "mock" },
    "owner",
  );
  await f.rt.db.query(
    "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES ('drive','t','oa','google_drive:owner','connected',?)",
    [json({ actor: "owner", email: "owner@example.test", roots: ["folder"] })],
  );
  const transcript =
    "新宿区で、予算6500万円以内、3LDK、所有権を希望します。7日後に状況を確認する約束です。";
  const result = {
    summary: "新宿区で3LDKを検討。",
    dealState: "uncontracted",
    stage: "post_meeting",
    keyPoints: ["6500万円以内"],
    concerns: [],
    interests: ["新宿区"],
    nextAction: "条件に合う物件を探す",
    triggers: [],
    tracking: {
      conditionQuote: transcript,
      terms: ["新宿区", "3LDK"],
      propertyWish: {
        area: "新宿区",
        maxPrice: 65000000,
        required: ["3LDK", "所有権"],
        excluded: [],
        quote: transcript,
      },
      timings: [
        {
          quote: "7日後に状況を確認する約束です。",
          intent: "検討状況を確認",
          daysAfter: 7,
        },
      ],
    },
  };
  const docs = new Map<string, any>([
    [
      "doc",
      {
        id: "doc",
        name: "2026-09-19_P02様_面談",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: ago(3600000),
        text: transcript,
      },
    ],
  ]);
  let aiCalls = 0,
    changeDuringAI = false;
  f.rt.externalFetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "mock" });
    if (u.hostname === "api.openai.com") {
      aiCalls++;
      if (changeDuringAI) docs.get("doc").modifiedTime = now();
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: json(result) }],
          },
        ],
      });
    }
    if (u.pathname === "/drive/v3/files")
      return Response.json({ files: [...docs.values()] });
    const id = u.pathname.split("/")[4],
      doc = docs.get(id);
    if (doc)
      return u.pathname.endsWith("/export")
        ? new Response(doc.text)
        : Response.json({ modifiedTime: doc.modifiedTime, trashed: false });
    throw new Error("Unexpected mock request: " + u.pathname);
  };
  const scan = async () =>
    scanDrive(
      f.rt,
      (await one(f.rt.db, "SELECT * FROM connections WHERE id='drive'"))!,
    );
  const bind = async (id = "doc", enabled = true) => {
    const doc = (await one(f.ts, "SELECT * FROM meeting_inbox WHERE id=?", [
      id,
    ]))!;
    await rememberMeetingBinding(
      f.rt,
      "t",
      "oa",
      { ...doc, customer_id: "c" },
      "owner",
      enabled,
    );
  };
  return {
    ...f,
    docs,
    result,
    scan,
    bind,
    aiCalls: () => aiCalls,
    race: () => {
      changeDuringAI = true;
    },
  };
}

test("one-file refresh recovers changed source without AI and does not overwrite active analysis", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    const con = (await one(
      f.rt.db,
      "SELECT * FROM connections WHERE id='drive'",
    ))!;
    const old = (await one(
      f.ts,
      "SELECT * FROM meeting_inbox WHERE id='doc'",
    ))!;
    f.docs.get("doc").modifiedTime = now();
    f.docs.get("doc").text += " 更新しました。";
    await assert.rejects(readMeetingText(f.rt, con, old), {
      code: "DOCUMENT_CHANGED",
    });
    const fresh = await refreshMeetingDocument(f.rt, con, old);
    assert.equal(fresh.version, old.version + 1);
    assert.match(await readMeetingText(f.rt, con, fresh), /更新しました/);
    assert.equal(f.aiCalls(), 0);
    await f.ts.query(
      "UPDATE meeting_inbox SET state='analyzing' WHERE id='doc'",
    );
    await assert.rejects(refreshMeetingDocument(f.rt, con, fresh), {
      code: "NOTE_CHANGED",
    });
  } finally {
    await f.dispose();
  }
});

test("newly confirmed full minutes enter automatic matching and inherit only unchanged grounded conditions", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    await f.bind();
    await processMeetingUpdates(f.rt, "t", "oa");
    const prior = (await one(f.ts, "SELECT * FROM assistant_preferences"))!;
    const text = "渋谷区で2LDKのマンションを希望します。";
    f.docs.set("phone", {
      ...f.docs.get("doc"),
      id: "phone",
      name: "電話ログ",
      modifiedTime: now(),
      text,
    });
    await f.scan();
    await f.bind("phone");
    await f.ts.query(
      "UPDATE meeting_inbox SET state='linked',customer_id='c' WHERE id='phone'",
    );
    await queueConfirmedMeeting(f.rt, "t", "oa", "phone", ago(1000));
    Object.assign(f.result.tracking, {
      conditionQuote: text,
      terms: ["渋谷区", "2LDK"],
      timings: [],
      propertyWish: {
        area: "渋谷区",
        maxPrice: null,
        required: ["2LDK"],
        excluded: [],
        quote: text,
      },
    });
    assert.equal((await processMeetingUpdates(f.rt, "t", "oa")).processed, 1);
    const next = parse(
      (await one(f.ts, "SELECT * FROM assistant_preferences"))!.data,
    );
    assert.equal(next.area, "渋谷区");
    assert.equal(next.maxPrice, 65000000);
    assert.deepEqual(next.required, ["所有権", "2LDK"]);
    assert.equal(next.inheritedNotes[0].id, prior.note_id);
    assert.equal(
      (await one(f.ts, "SELECT state FROM meeting_inbox WHERE id='phone'"))!
        .state,
      "linked",
    );
  } finally {
    await f.dispose();
  }
});

test("Drive addition -> bound meeting analysis -> current conditions, due event and durable customer work; unchanged version costs nothing", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    await f.bind();
    assert.equal((await processMeetingUpdates(f.rt, "t", "oa")).processed, 1);
    assert.equal(f.aiCalls(), 1);
    assert.equal(
      parse((await one(f.ts, "SELECT * FROM assistant_preferences"))!.data)
        .maxPrice,
      65000000,
    );
    assert.equal(
      (await one(f.ts, "SELECT * FROM meeting_inbox"))!.state,
      "linked",
    );
    assert.equal(
      (await one(
        f.ts,
        "SELECT * FROM assistant_work_queue WHERE customer_id='c'",
      ))!.customer_id,
      "c",
    );
    assert.equal(
      (await all(f.h, "SELECT * FROM events WHERE type='meeting.trigger'"))
        .length,
      1,
    );
    await f.scan();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 1);
    // Metadata-only edits restore the existing source without another paid extraction.
    f.docs.get("doc").modifiedTime = now();
    await f.scan();
    assert.ok((await one(f.ts, "SELECT * FROM context_notes"))!.deleted_at);
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 1);
    assert.equal(
      (await one(f.ts, "SELECT * FROM context_notes"))!.deleted_at,
      null,
    );
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
  } finally {
    await f.dispose();
  }
});
test("updated meeting replaces conditions, retires its old promises, removes stale wishes, and survives removal/reappearance", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    await f.bind();
    await processMeetingUpdates(f.rt, "t", "oa");
    f.docs.get("doc").text = "今回は物件探しを中断し、再開日は決めていません。";
    f.docs.get("doc").modifiedTime = now();
    f.result.tracking = {
      conditionQuote: f.docs.get("doc").text,
      terms: [],
      propertyWish: null,
      timings: [],
    } as any;
    await f.scan();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 2);
    assert.equal(await one(f.ts, "SELECT * FROM assistant_preferences"), null);
    assert.equal(
      (
        await all(
          f.h,
          "SELECT * FROM events WHERE type='meeting.trigger' AND state='pending'",
        )
      ).length,
      0,
    );
    const doc = f.docs.get("doc");
    f.docs.delete("doc");
    await f.scan();
    assert.equal(
      (await one(f.ts, "SELECT * FROM meeting_inbox"))!.state,
      "missing",
    );
    f.docs.set("doc", doc);
    await f.scan();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(
      (await one(f.ts, "SELECT * FROM meeting_inbox"))!.state,
      "linked",
    );
    assert.equal(f.aiCalls(), 2);
  } finally {
    await f.dispose();
  }
});
test("new P02 document reuses confirmed alias, but older meeting does not replace newer wishes; unknown/group documents wait", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    await f.bind();
    await processMeetingUpdates(f.rt, "t", "oa");
    f.docs.set("older", {
      ...f.docs.get("doc"),
      id: "older",
      name: "2026-09-10_P02様_面談",
      modifiedTime: now(),
    });
    await f.scan();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 2);
    assert.equal(
      (await one(f.ts, "SELECT note_id FROM assistant_preferences"))!.note_id,
      "drive:oa:doc",
    );
    f.docs.set("unknown", {
      ...f.docs.get("doc"),
      id: "unknown",
      name: "2026-09-20_P99様_面談",
      modifiedTime: now(),
    });
    await f.scan();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 2);
    assert.equal(
      (await one(
        f.ts,
        "SELECT state FROM meeting_auto_state WHERE file_id='unknown'",
      ))!.state,
      "needs_link",
    );
    await f.bind("unknown", false);
    f.docs.get("unknown").modifiedTime = ago(-1000);
    await f.scan();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 2);
  } finally {
    await f.dispose();
  }
});
test("meeting changing during extraction cannot be applied; expired auto leases are recoverable and capped", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    await f.bind();
    f.race();
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(await one(f.ts, "SELECT * FROM context_notes"), null);
    assert.equal(
      (await one(f.ts, "SELECT state FROM meeting_auto_state"))!.state,
      "needs_review",
    );
    await f.ts.query(
      "UPDATE meeting_inbox SET state='analyzing',lease_until=?",
      [ago(1000)],
    );
    await f.ts.query(
      "UPDATE meeting_auto_state SET state='processing',attempts=3",
    );
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(
      (await one(f.ts, "SELECT state FROM meeting_inbox"))!.state,
      "error",
    );
    assert.equal(f.aiCalls(), 1);
  } finally {
    await f.dispose();
  }
});
test("automatic meeting timing requires exact original quotation and explicit elapsed days", () => {
  const held = "2026-09-19T02:00:00Z",
    text = "7日後に確認します。";
  assert.equal(
    groundedMeetingTimings(
      { timings: [{ quote: text, daysAfter: 7 }] },
      text,
      held,
    )[0].scheduledAt,
    "2026-09-25T15:00:00.000Z",
  );
  assert.deepEqual(
    groundedMeetingTimings(
      { timings: [{ quote: text, daysAfter: 3 }] },
      text,
      held,
    ),
    [],
  );
  assert.deepEqual(
    groundedMeetingTimings(
      { timings: [{ quote: "適当な時に連絡", daysAfter: 7 }] },
      text,
      held,
    ),
    [],
  );
});

test("grounded wishes accept split station-distance headings and formatting without accepting an unsupported number", () => {
  const quote =
    "価格上限：5,500万円以内。間取り：2LDK。権利：所有権。駅徒歩分数：理想は10分以内、許容範囲は15分以内。第一希望：新宿区。";
  const tracking = {
    conditionQuote: quote,
    terms: ["新宿区"],
    propertyWish: {
      area: "新宿区",
      maxPrice: 55000000,
      required: ["2LDK", "所有権", "徒歩15分以内"],
      excluded: [],
      quote,
    },
  };
  assert.equal(
    checkedMeetingTracking(tracking, quote.replace("第一希望", "\n第一希望"))
      .propertyWish.maxPrice,
    55000000,
  );
  assert.throws(() =>
    checkedMeetingTracking(
      {
        ...tracking,
        propertyWish: { ...tracking.propertyWish, maxPrice: 58000000 },
      },
      quote,
    ),
  );
});

test("an unresolved new meeting blocks drafts from older wishes, and its extraction is retained for review", async () => {
  const f = await driveFixture();
  try {
    await f.scan();
    await f.bind();
    f.result.tracking.propertyWish.maxPrice = 58000000;
    await processMeetingUpdates(f.rt, "t", "oa");
    const doc = (await one(f.ts, "SELECT * FROM meeting_inbox"))!;
    assert.equal(doc.customer_id, "c");
    assert.ok(parse(doc.analysis).tracking);
    await f.message();
    await scanAssistant(f.rt, "t", "oa", "owner");
    assert.equal((await all(f.ts, "SELECT * FROM proposals")).length, 0);
    // A bounded retry after validation changes can inspect the cached extraction without a second AI call.
    await f.ts.query("UPDATE meeting_auto_state SET state='retry',next_at=''");
    await processMeetingUpdates(f.rt, "t", "oa");
    assert.equal(f.aiCalls(), 1);
  } finally {
    await f.dispose();
  }
});

async function calendarFixture() {
  const f = await assistantFixture();
  registerCalendar(f.app);
  registerMeetingOverview(f.app);
  f.rt.googleOAuth = { clientId: "client", clientSecret: "secret" };
  await putCredential(
    f.rt,
    "t",
    "oa",
    "google_calendar:owner",
    { refreshToken: "mock" },
    "owner",
  );
  await f.rt.db.query(
    "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES ('cal','t','oa','google_calendar:owner','connected',?)",
    [
      json({
        actor: "owner",
        email: "owner@example.test",
        calendarId: "primary",
      }),
    ],
  );
  let responses: any[] = [],
    queries: URL[] = [];
  f.rt.externalFetch = async (input) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "mock" });
    if (u.pathname.includes("/calendar/v3/")) {
      queries.push(u);
      const data = responses.shift();
      if (data === 410) return new Response("", { status: 410 });
      assert.ok(data, "Unexpected calendar call");
      return Response.json(data);
    }
    throw new Error("Unexpected external request");
  };
  const sync = async (...data: any[]) => {
    responses.push(...data);
    const row = (await one(
      f.rt.db,
      "SELECT * FROM connections WHERE id='cal'",
    ))!;
    await f.rt.db.query("UPDATE connections SET config=? WHERE id='cal'", [
      json({ ...parse(row.config), nextSyncAt: "" }),
    ]);
    return syncCalendar(
      f.rt,
      (await one(f.rt.db, "SELECT * FROM connections WHERE id='cal'"))!,
    );
  };
  return { ...f, sync, queries };
}
const calendarBase = "/api/tenants/t/accounts/oa/connectors/calendar";
test("Google Calendar initial + incremental edit/cancel uses one appointment and never sends customer messages", async () => {
  const f = await calendarFixture();
  try {
    const event = {
      id: "event",
      summary: "面談",
      start: { dateTime: ago(-86400000) },
      end: { dateTime: ago(-90000000) },
      status: "confirmed",
    };
    await f.sync({ items: [event], nextSyncToken: "s1" });
    let item = (await one(f.ts, "SELECT * FROM calendar_items"))!;
    assert.equal(
      (
        await f.request(
          `${calendarBase}/items/${item.id}/link`,
          { version: item.version, customerId: "c" },
          "POST",
          "stranger",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(`${calendarBase}/items/${item.id}/link`, {
          version: item.version,
          customerId: "c",
        })
      ).status,
      200,
    );
    await f.sync({
      items: [
        {
          ...event,
          summary: "変更後の面談",
          start: { dateTime: ago(-2 * 86400000) },
        },
      ],
      nextSyncToken: "s2",
    });
    assert.equal(f.queries[1].searchParams.get("syncToken"), "s1");
    assert.equal(f.queries[1].searchParams.has("timeMin"), false);
    const appt = (await one(f.h, "SELECT * FROM appointments"))!;
    assert.equal(appt.title, "変更後の面談");
    assert.equal(appt.version, 2);
    await f.sync({
      items: [{ id: "event", status: "cancelled" }],
      nextSyncToken: "s3",
    });
    assert.equal(
      (await one(f.h, "SELECT * FROM appointments"))!.state,
      "cancelled",
    );
    await f.sync({ items: [event], nextSyncToken: "s4" }); // restoring a deleted event restores the same appointment.
    assert.equal(
      (await one(f.h, "SELECT * FROM appointments"))!.state,
      "rescheduled",
    );
    assert.equal((await all(f.h, "SELECT * FROM appointments")).length, 1);
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
    const own = await f.request(calendarBase);
    assert.equal(own.data.items.length, 1);
  } finally {
    await f.dispose();
  }
});
test("Calendar pagination retains original token and expired cursor completes a full resync before retiring absent events", async () => {
  const f = await calendarFixture();
  try {
    const event = {
      id: "one",
      summary: "面談",
      start: { dateTime: ago(-86400000) },
      end: { dateTime: ago(-90000000) },
    };
    await f.sync(
      { items: [event], nextPageToken: "page2" },
      { items: [], nextSyncToken: "s1" },
    );
    await f.sync(
      { items: [], nextPageToken: "pageA" },
      { items: [], nextPageToken: "pageB" },
    );
    await f.sync({ items: [], nextSyncToken: "s2" });
    assert.equal(f.queries[4].searchParams.get("syncToken"), "s1");
    assert.equal(f.queries[4].searchParams.get("pageToken"), "pageB");
    await f.sync(410);
    assert.equal(
      (await one(f.ts, "SELECT * FROM calendar_items"))!.state,
      "booked",
    );
    await f.sync({ items: [], nextSyncToken: "fresh" });
    assert.equal(
      (await one(f.ts, "SELECT * FROM calendar_items"))!.state,
      "cancelled",
    );
  } finally {
    await f.dispose();
  }
});
test("explicit Google calendar mirror keeps TimeRex as source of truth without creating a second meeting", async () => {
  const f = await calendarFixture();
  try {
    await f.h.query(
      "INSERT INTO appointments(id,customer_id,external_id,title,starts_at,state,source,version) VALUES ('timerex','c','booking','予約',?,'booked','timerex',1)",
      [ago(-86400000)],
    );
    await f.sync({
      items: [
        {
          id: "one",
          summary: "カレンダーのコピー",
          start: { dateTime: ago(-86400000) },
        },
      ],
      nextSyncToken: "s",
    });
    const item = (await one(f.ts, "SELECT * FROM calendar_items"))!;
    assert.equal(
      (
        await f.request(`${calendarBase}/items/${item.id}/link`, {
          version: item.version,
          customerId: "c",
          appointmentId: "timerex",
        })
      ).status,
      200,
    );
    await f.sync({
      items: [{ id: "one", status: "cancelled" }],
      nextSyncToken: "s2",
    });
    assert.equal((await all(f.h, "SELECT * FROM appointments")).length, 1);
    assert.equal(
      (await one(f.h, "SELECT * FROM appointments"))!.state,
      "booked",
    );
  } finally {
    await f.dispose();
  }
});
test("calendar authorization is read-only and each state is session-bound and one-use", async () => {
  const f = await calendarFixture();
  try {
    const auth = await f.request(calendarBase + "/authorize", {});
    assert.equal(auth.status, 200);
    const url = new URL(auth.data.url);
    assert.equal(
      url.searchParams.get("scope"),
      `openid email ${calendarScope}`,
    );
    const state = url.searchParams.get("state")!;
    // Fixture middleware reads tenant from path; callback sets its own authenticated context.
    const cb = new (await import("hono")).Hono<any>();
    cb.onError((e: any, c: any) => c.json({ error: e.code }, e.status || 400));
    cb.use("*", async (c: any, next: any) => {
      c.set("principal", {
        user: { id: "owner" },
        sessionId: c.req.header("x-session") || "test",
      });
      await next();
    });
    registerCalendar(cb);
    const request = (session = "test") =>
      cb.request(
        "/api/drive/callback?state=" + state + "&error=access_denied",
        { headers: { "x-session": session } },
        { runtime: f.rt },
      );
    assert.equal((await request("wrong")).status, 400);
    assert.equal((await request()).status, 302);
    assert.equal((await request()).status, 400);
  } finally {
    await f.dispose();
  }
});
test("TimeRex reschedule updates meeting facts and removes pending proposal approval", async () => {
  const f = await assistantFixture();
  try {
    await f.h.query(
      "INSERT INTO appointments(id,customer_id,external_id,title,starts_at,state,source,version) VALUES ('a','c','booking','旧予定',?,'booked','timerex',1)",
      [ago(-86400000)],
    );
    await processBookingEvent(f.rt, "t", "oa", {
      event: "booking.rescheduled",
      guestName: "山田",
      guestEmail: "a@example.test",
      bookingId: "booking",
      title: "新しい面談",
      startsAt: ago(-2 * 86400000),
      customerId: "c",
      location: "新しい場所",
    });
    const appt = (await one(f.h, "SELECT * FROM appointments"))!;
    assert.equal(appt.title, "新しい面談");
    assert.equal(parse(appt.details).location, "新しい場所");
    assert.equal(
      (await one(f.common, "SELECT * FROM customers WHERE id='c'"))!.stage,
      "booked",
    );
    await processBookingEvent(f.rt, "t", "oa", {
      event: "booking.cancelled",
      guestName: "山田",
      guestEmail: "a@example.test",
      bookingId: "booking",
      title: "新しい面談",
      startsAt: appt.starts_at,
      customerId: "c",
    });
    assert.equal(
      (await one(f.h, "SELECT * FROM appointments"))!.state,
      "cancelled",
    );
    assert.equal(
      (await all(f.h, "SELECT * FROM outbox WHERE state='pending'")).length,
      0,
    );
  } finally {
    await f.dispose();
  }
});
test("mounted screen invalidation broadcasts only matching tenant URLs and unsubscribes cleanly", () => {
  let a = 0,
    b = 0;
  const offA = subscribeData("/api/tenants/t/workspace", () => a++),
    offB = subscribeData("/api/tenants/other/workspace", () => b++);
  invalidateData("/api/tenants/t/");
  assert.equal(a, 1);
  assert.equal(b, 0);
  offA();
  invalidateData("/api/tenants/t/");
  assert.equal(a, 1);
  offB();
});
