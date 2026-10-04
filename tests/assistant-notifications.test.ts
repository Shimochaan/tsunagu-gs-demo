import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, ago } from "./helpers/assistant-fixture.ts";
import { all, one, now, parse } from "../backend/db.ts";
import {
  scanAssistant,
  upsertSource,
  decideAssistant,
  editAssistant,
} from "../backend/assistant.ts";
import { notifyAssistant, notificationPreferences } from "../backend/assistant-notifications.ts";
import { refreshAssistantSources } from "../backend/assistant-discovery.ts";
type Fixture = Awaited<ReturnType<typeof assistantFixture>>;
test("notification window override applies only on its explicit JST day",async()=>{
 const f=await assistantFixture();try {
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  await f.rt.db.query("INSERT INTO staff_line_preferences(tenant_id,user_id,data) VALUES ('t','owner',?)",[JSON.stringify({endHour:21,notificationWindowOverride:{day:today,endHour:23}})]);
  assert.equal((await notificationPreferences(f.rt,'t','owner')).endHour,23);
  await f.rt.db.query("UPDATE staff_line_preferences SET data=?",[JSON.stringify({endHour:21,notificationWindowOverride:{day:'2000-01-01',endHour:23}})]);
  assert.equal((await notificationPreferences(f.rt,'t','owner')).endHour,21);
 }finally{await f.dispose();}
});
const base = "/api/tenants/t/accounts/oa/assistant",
  line = "/api/tenants/t/assistant-line";
const start = new Date("2026-10-02T02:00:00Z").getTime();
async function staff(f: Fixture) {
  f.rt.assistantLine = {
    enabled: true,
    destination: "U" + "a".repeat(32),
    secret: "fixture-only",
    token: "fixture-only",
  };
  await f.rt.db.query(
    "INSERT INTO staff_line_links(tenant_id,user_id,destination,line_user_id,state,notifications,updated_at) VALUES ('t','owner',?,'staff-line','active',1,?)",
    [f.rt.assistantLine.destination, now()],
  );
}
async function note(f: Fixture, cid: string) {
  await f.ts.query(
    "INSERT INTO context_notes(id,customer_id,source,body,confirmed_by,created_at) VALUES (?,?,'human','金利、新宿、3LDK、予算50000000円','owner',?)",
    [`n-${cid}`, cid, now()],
  );
}
const source = (id = "article") => ({
  id,
  kind: "news",
  title: `金利の公表 ${id}`,
  url: `https://publisher.example.com/${id}`,
  publishedAt: ago(3600000),
  checkedAt: ago(1000),
  expiresAt: ago(-86400000),
  summary: "確認済みの公表内容です。",
  tags: ["金利"],
});
async function replies(f: Fixture, cid = "c") {
  await f.message(cid);
  await scanAssistant(f.rt, "t", "oa", undefined, "reply");
  return (await one(
    f.ts,
    "SELECT * FROM proposals WHERE customer_id=? ORDER BY created_at DESC LIMIT 1",
    [cid],
  ))!;
}

test("notifications: opportunity burst never uses reply slots, remaining opportunities respect customer notification cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    for (const c of ["c", "c2", "c3"]) await note(f, c);
    await upsertSource(f.rt, "t", "oa", source());
    await scanAssistant(f.rt, "t", "oa", undefined, "opportunity");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 3);
    await upsertSource(f.rt, "t", "oa", source("second"));
    await scanAssistant(f.rt, "t", "oa", undefined, "opportunity");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    assert.equal(
      (
        await all(
          f.rt.db,
          "SELECT * FROM staff_line_notices WHERE state='queued'",
        )
      ).length,
      3,
    );
    await replies(f, "c4");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    await f.request(`${line}/preferences`, {quietHours:false,customerCooldownHours:1});
    t.mock.timers.setTime(start + 3600001);
    await f.rt.db.query("DELETE FROM staff_line_delivery_schedule");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 3);
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 7);
    assert.equal(
      (
        await all(
          f.rt.db,
          "SELECT * FROM staff_line_notices WHERE state='queued'",
        )
      ).length,
      0,
    );
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("notifications: concurrent scans and notifications send each version once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    await f.message();
    await Promise.all([
      scanAssistant(f.rt, "t", "oa"),
      scanAssistant(f.rt, "t", "oa"),
    ]);
    await Promise.all([
      notifyAssistant(f.rt, "t", "oa"),
      notifyAssistant(f.rt, "t", "oa"),
    ]);
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 1);
    t.mock.timers.setTime(start + 120000);
    await notifyAssistant(f.rt, "t", "oa");
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 1);
    assert.equal(
      (await all(f.rt.db, "SELECT * FROM staff_line_deliveries")).length,
      1,
    );
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("notifications: short consecutive replies aggregate, new reply creates a fresh notification and refusal stops it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    await f.message("c", "質問です", { id: "first", age: 20000 });
    await f.message("c", "金利も教えてください", { id: "second", age: 10000 });
    await scanAssistant(f.rt, "t", "oa", undefined, "reply");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    t.mock.timers.setTime(start + 81000);
    await scanAssistant(f.rt, "t", "oa", undefined, "reply");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    const ev = parse(
      (await one(f.ts, "SELECT evidence FROM assistant_proposals"))!.evidence,
    );
    assert.equal(ev.messageIds.length, 2);
    await f.message("c", "追加の条件です", { id: "third", age: 0 });
    t.mock.timers.setTime(start + 172000);
    await scanAssistant(f.rt, "t", "oa", undefined, "reply");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    await f.message("c", "連絡不要です", { id: "stop", age: 0 });
    await scanAssistant(f.rt, "t", "oa", undefined, "reply");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    assert.equal(
      (await one(f.common, "SELECT opt_out FROM customers WHERE id='c'"))!
        .opt_out,
      1,
    );
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("notifications: quiet hours persist queued items, personal opt-out from quiet hours and overnight windows are explicit", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-02T14:00:00Z"),
  });
  const f = await assistantFixture();
  try {
    await staff(f);
    await replies(f);
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    assert.equal(
      (await one(f.rt.db, "SELECT state FROM staff_line_notices"))!.state,
      "queued",
    );
    await f.request(
      `${line}/preferences`,
      { quietHours: false },
      "POST",
      "stranger",
    );
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    await f.request(`${line}/preferences`, { quietHours: false });
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    await f.request(`${line}/preferences`, {
      quietHours: true,
      startHour: 22,
      endHour: 2,
    });
    await replies(f, "c2");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    t.mock.timers.setTime(new Date("2026-10-02T18:00:00Z").getTime());
    await replies(f, "c3");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    assert.equal(
      (
        await f.request(`${line}/preferences`, {
          quietHours: true,
          startHour: 8,
          endHour: 8,
        })
      ).status,
      400,
    );
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("notifications: definite failure and unknown result require explicit retry using exactly the same body and key", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    await replies(f);
    let result = "failed";
    const attempts: { key: string | null; body: any }[] = [];
    f.rt.externalFetch = async (_u, i) => {
      attempts.push({
        key: new Headers(i?.headers).get("X-Line-Retry-Key"),
        body: i?.body,
      });
      if (result === "failed") return new Response("rejected", { status: 400 });
      if (result === "unknown") throw new Error("fixture lost response");
      return new Response(null, {
        status: 409,
        headers: { "x-line-accepted-request-id": "fixture-accepted" },
      });
    };
    await notifyAssistant(f.rt, "t", "oa");
    const n = (await one(f.rt.db, "SELECT * FROM staff_line_notices"))!;
    assert.equal(n.state, "failed");
    t.mock.timers.setTime(start + 60000);
    await notifyAssistant(f.rt, "t", "oa");
    assert.equal(attempts.length, 1);
    assert.equal(
      (await f.request(`${line}/notices/${n.id}/retry`, {}, "POST", "stranger"))
        .status,
      404,
    );
    result = "accepted";
    assert.equal(
      (await f.request(`${line}/notices/${n.id}/retry`, {})).data.state,
      "sent",
    );
    assert.deepEqual(attempts[0], attempts[1]);
    await replies(f, "c2");
    result = "unknown";
    await notifyAssistant(f.rt, "t", "oa");
    const unknown = (await one(
      f.rt.db,
      "SELECT * FROM staff_line_notices WHERE state='uncertain'",
    ))!;
    await notifyAssistant(f.rt, "t", "oa");
    assert.equal(attempts.length, 3);
    result = "accepted";
    assert.equal(
      (await f.request(`${line}/notices/${unknown.id}/retry`, {})).data.state,
      "sent",
    );
    assert.deepEqual(attempts[2], attempts[3]);
    assert.equal(
      (await f.request(`${line}/notices/${unknown.id}/retry`, {})).status,
      409,
    );
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("notifications: queued cancellation, snooze, expiry, edit and revoked rights do not deliver an obsolete card", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  for (const change of ["cancel", "later", "expire", "edit", "revoke"]) {
    const f = await assistantFixture();
    try {
      await staff(f);
      await f.request(`${line}/preferences`, {
        quietHours: true,
        startHour: 20,
        endHour: 21,
      });
      const p = await replies(f);
      await notifyAssistant(f.rt, "t", "oa");
      if (change === "cancel" || change === "later")
        await decideAssistant(
          f.rt,
          "t",
          "oa",
          "owner",
          p.id,
          p.version,
          change,
        );
      if (change === "expire")
        await f.ts.query("UPDATE assistant_proposals SET expires_at=?", [
          ago(1000),
        ]);
      if (change === "edit")
        await editAssistant(
          f.rt,
          "t",
          "oa",
          "owner",
          p.id,
          p.version,
          "担当者が確認して直した文案です。",
        );
      if (change === "revoke")
        await f.rt.db.query(
          "UPDATE accounts SET owner_user_id='other-owner' WHERE id='oa'",
        );
      await f.request(`${line}/preferences`, { quietHours: false });
      await notifyAssistant(f.rt, "t", "oa");
      const pushes = f.calls.filter((c) => c.url.endsWith("/push"));
      assert.equal(pushes.length, change === "edit" ? 1 : 0);
      if (change === "edit")
        assert.ok(
          JSON.stringify(pushes[0].body).includes("担当者が確認して直した"),
        );
      if (change === "later") {
        t.mock.timers.setTime(start + 4 * 3600000 + 1000);
        assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
        t.mock.timers.setTime(start);
      }
    } finally {
      await f.dispose();
    }
  }
  t.mock.timers.reset();
});
test("notifications: cancellation immediately after the queue claim wins before LINE API dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    const p = await replies(f);
    const original = f.rt.db.query.bind(f.rt.db);
    let cancelled = false;
    f.rt.db.query = async (sql, params) => {
      const r = await original(sql, params);
      if (
        !cancelled &&
        sql.startsWith("UPDATE staff_line_notices SET state='sending'")
      ) {
        cancelled = true;
        await decideAssistant(
          f.rt,
          "t",
          "oa",
          "owner",
          p.id,
          p.version,
          "cancel",
        );
      }
      return r;
    };
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 0);
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("catalog events: authenticated ingest triggers detection and notification, is replay safe and does not roll inventory back", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    await note(f, "c");
    await f.request(`${base}/preferences/c`, {
      noteId: "n-c",
      area: "新宿",
      maxPrice: 50000000,
      required: ["3LDK"],
      excluded: [],
    });
    const item = {
      ...source("item"),
      kind: "product",
      title: "新宿の3LDK",
      tags: ["3LDK"],
      area: "新宿",
      price: 45000000,
      status: "available",
      stock: 1,
    };
    const body = { eventId: "created-1", source: item };
    assert.equal(
      (await f.request(`${base}/catalog-events`, body, "POST", "stranger"))
        .status,
      403,
    );
    assert.equal((await f.request(`${base}/catalog-events`, body)).status, 200);
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 1);
    assert.equal(
      (await f.request(`${base}/catalog-events`, body)).data.duplicate,
      true,
    );
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 1);
    assert.equal(
      (
        await f.request(`${base}/catalog-events`, {
          ...body,
          source: { ...item, stock: 0 },
        })
      ).status,
      409,
    );
    const sold = {
      eventId: "sold-2",
      source: { ...item, checkedAt: now(), status: "sold", stock: 0 },
    };
    assert.equal((await f.request(`${base}/catalog-events`, sold)).status, 200);
    assert.equal(
      (
        await f.request(`${base}/catalog-events`, {
          ...body,
          eventId: "late-3",
        })
      ).data.stale,
      true,
    );
    assert.equal(
      parse(
        (await one(
          f.ts,
          "SELECT data FROM assistant_sources WHERE id='feed-item'",
        ))!.data,
      ).status,
      "sold",
    );
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("notifications: interrupted sends become uncertain and retries stop at three attempts or 23 hours", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await staff(f);
    await replies(f);
    await f.request(`${line}/preferences`, {
      quietHours: true,
      startHour: 20,
      endHour: 21,
    });
    await notifyAssistant(f.rt, "t", "oa");
    const n = (await one(f.rt.db, "SELECT * FROM staff_line_notices"))!;
    await f.rt.db.query(
      "UPDATE staff_line_notices SET state='sending' WHERE id=?",
      [n.id],
    );
    await f.rt.db.query(
      "UPDATE staff_line_deliveries SET attempts=1,first_attempt_at=?,last_attempt_at=? WHERE notice_id=?",
      [ago(121000), ago(121000), n.id],
    );
    await f.request(`${line}/preferences`, { quietHours: false });
    await notifyAssistant(f.rt, "t", "oa");
    assert.equal(
      (await one(f.rt.db, "SELECT state FROM staff_line_notices"))!.state,
      "uncertain",
    );
    assert.equal(f.calls.length, 0);
    let calls = 0;
    f.rt.externalFetch = async () => {
      calls++;
      return new Response("fixture", { status: 503 });
    };
    assert.equal(
      (await f.request(`${line}/notices/${n.id}/retry`, {})).data.state,
      "uncertain",
    );
    assert.equal(
      (await f.request(`${line}/notices/${n.id}/retry`, {})).data.state,
      "uncertain",
    );
    assert.equal(
      (await f.request(`${line}/notices/${n.id}/retry`, {})).status,
      409,
    );
    assert.equal(calls, 2);
    await f.rt.db.query(
      "UPDATE staff_line_deliveries SET attempts=1 WHERE notice_id=?",
      [n.id],
    );
    t.mock.timers.setTime(start + 23 * 3600000);
    assert.equal(
      (await f.request(`${line}/notices/${n.id}/retry`, {})).status,
      409,
    );
    assert.equal(calls, 2);
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("acquisition cadence: configured search/feed intervals are independent from notification frequency and validate bounds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await assistantFixture();
  try {
    await note(f, "c");
    f.rt.assistantFeeds = {
      "t:oa": { url: "https://catalog.example.com/feed" },
    };
    f.rt.assistantSearch = {
      "t:oa": {
        url: "https://search.example.com/api",
        allowedHosts: ["publisher.example.com"],
      },
    };
    const counts = { search: 0, feed: 0 };
    f.rt.externalFetch = async (u) => {
      if (String(u).includes("catalog")) {
        counts.feed++;
        return Response.json([]);
      }
      counts.search++;
      return Response.json({ results: [] });
    };
    assert.equal(
      (
        await f.request(`${base}/automation`, {
          autoFeed: true,
          autoSearch: true,
          topics: ["金利"],
          feedIntervalMinutes: 15,
          searchIntervalMinutes: 60,
        })
      ).status,
      200,
    );
    await Promise.all([
      refreshAssistantSources(f.rt, "t", "oa"),
      refreshAssistantSources(f.rt, "t", "oa"),
    ]);
    assert.deepEqual(counts, { search: 1, feed: 1 });
    t.mock.timers.setTime(start + 15 * 60000);
    await refreshAssistantSources(f.rt, "t", "oa");
    assert.deepEqual(counts, { search: 1, feed: 2 });
    t.mock.timers.setTime(start + 60 * 60000);
    await refreshAssistantSources(f.rt, "t", "oa");
    assert.deepEqual(counts, { search: 2, feed: 3 });
    assert.equal(
      (
        await f.request(`${base}/automation`, {
          feedIntervalMinutes: 1,
          searchIntervalMinutes: 1,
        })
      ).status,
      400,
    );
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
