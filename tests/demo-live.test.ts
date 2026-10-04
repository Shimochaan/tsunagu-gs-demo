import test from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./helpers/assistant-fixture.ts";
import { all, one, now, json, parse } from "../backend/db.ts";
import { putCredential } from "../backend/credentials.ts";
import { startDemo } from "../backend/self-demo.ts";
import {
  queueDemoSheetWrite,
  processDemoSheetWrites,
  demoPropertyRow,
} from "../backend/demo-sheet-sync.ts";
import {
  propertyHeaders,
  previewProperties,
  importProperties,
} from "../backend/assistant-sheets.ts";
import { syncPropertySheet } from "../backend/assistant-sync.ts";
import {
  demoLiveState,
  notifyDemoMeetings,
  linkDemoMeetingFromLine,
} from "../backend/demo-meeting-line.ts";
import {
  claimAssistantOA,
  finishAssistantOA,
} from "../backend/assistant-work.ts";

async function fixture() {
  const f = await assistantFixture();
  f.rt.selfDemo = { tenant: "t", oa: "oa", capacity: 10 };
  const p = await startDemo(f.rt, { id: "owner", name: "test" });
  const who = await one(
    f.rt.db,
    "SELECT * FROM gs_demo_participants WHERE user_id='owner'",
  );
  await f.common.query(
    "INSERT INTO customers(id,name,owner_user_id,created_at) VALUES (?,'体験者','owner',?)",
    [who.customer_id, now()],
  );
  await f.rt.db.query(
    "UPDATE gs_demo_participants SET customer_line_id='customer-fixture',pair_hash=NULL,notifications_until=? WHERE user_id='owner'",
    [new Date(Date.now() + 3600000).toISOString()],
  );
  f.rt.googleOAuth = { clientId: "fixture", clientSecret: "fixture" };
  await putCredential(
    f.rt,
    "t",
    "oa",
    "google_drive:owner",
    { refreshToken: "fixture" },
    "owner",
  );
  await f.rt.db.query(
    "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES ('drive','t','oa','google_drive:owner','connected','{\"canWriteSheets\":true}')",
  );
  await f.ts.query(
    "INSERT INTO assistant_google_config(id,actor,data) VALUES ('default','owner',?)",
    [json({ folderId: "folder", spreadsheetId: "sheet", autoSheet: true })],
  );
  let rows: unknown[][] = [
    propertyHeaders,
    demoPropertyRow(f.rt, "EXTERNAL-1", {
      title: "共通物件",
      area: "新宿区",
      price: 50000000,
      layout: "2LDK",
      walkingMinutes: 5,
      status: "available",
    }),
  ];
  let revision = 1,
    writes = 0,
    lost = false,
    reject = false;
  const original = f.rt.externalFetch;
  f.rt.externalFetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "fixture" });
    if (u.hostname === "www.googleapis.com" && u.pathname.endsWith("/sheet"))
      return Response.json({
        id: "sheet",
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: ["folder"],
        modifiedTime: String(revision),
      });
    if (u.hostname === "sheets.googleapis.com") {
      if (init?.method === "POST" || init?.method === "PUT") {
        if (reject) return Response.json({}, { status: 403 });
        writes++;
        const row = JSON.parse(String(init.body)).values[0];
        if (u.pathname.endsWith(":append")) rows.push(row);
        else {
          const match = decodeURIComponent(u.pathname).match(/!A(\d+):/)!;
          rows[Number(match[1]) - 1] = row;
        }
        revision++;
        if (lost) throw Error("lost acknowledgement");
        return Response.json({ updatedRows: 1 });
      }
      const properties = {
        sheetId: 1,
        title: "物件台帳",
        sheetType: "GRID",
        gridProperties: { columnCount: 18, rowCount: 1000 },
      };
      return Response.json({
        spreadsheetId: "sheet",
        sheets: [
          {
            properties,
            ...(u.searchParams.has("ranges")
              ? {
                  data: [
                    {
                      rowData: rows.map((r) => ({
                        values: r.map((v) => ({
                          effectiveValue:
                            typeof v === "number"
                              ? { numberValue: v }
                              : { stringValue: v },
                        })),
                      })),
                    },
                  ],
                }
              : {}),
          },
        ],
      });
    }
    return original(input, init);
  };
  return {
    ...f,
    who,
    rows,
    changed: () => revision++,
    writes: () => writes,
    lost: (v: boolean) => (lost = v),
    reject: (v: boolean) => (reject = v),
  };
}
const input = {
  title: "保存検証",
  area: "港区",
  price: 99000000,
  layout: "4LDK",
  walkingMinutes: 2,
  status: "available",
};
const sid = "demo-property-" + crypto.randomUUID();
async function enqueue(f: any, body: any = input, id = sid) {
  return queueDemoSheetWrite(f.rt, "owner", f.who.customer_id, id, body);
}

test("sheet write: app append, retry and sheet echo retain one source and audience; direct edit/delete reflect", async () => {
  const f = await fixture();
  try {
    await enqueue(f);
    await processDemoSheetWrites(f.rt);
    const first = await one(
      f.ts,
      "SELECT * FROM assistant_sources WHERE id=?",
      [sid],
    );
    assert.ok(first);
    assert.equal(f.writes(), 1);
    assert.equal(parse(first.data).audienceCustomerId, f.who.customer_id);
    await enqueue(f);
    await processDemoSheetWrites(f.rt);
    await syncPropertySheet(f.rt, "t", "oa", true);
    assert.equal(f.writes(), 1);
    assert.equal(
      (
        await one(f.ts, "SELECT version FROM assistant_sources WHERE id=?", [
          sid,
        ])
      ).version,
      first.version,
    );
    assert.equal(
      (
        await one(
          f.ts,
          "SELECT COUNT(*) n FROM assistant_sources WHERE id LIKE ?",
          ["%" + sid],
        )
      ).n,
      1,
    );
    const row = f.rows.find((r) => r[0] === sid)!;
    row[3] = 98000000;
    f.changed();
    await syncPropertySheet(f.rt, "t", "oa", true);
    const updated = await one(
      f.ts,
      "SELECT * FROM assistant_sources WHERE id=?",
      [sid],
    );
    assert.equal(parse(updated.data).price, 98000000);
    assert.equal(parse(updated.data).audienceCustomerId, f.who.customer_id);
    const sold = {
      ...input,
      price: 98000000,
      status: "sold",
      sourceId: sid,
      version: updated.version,
    };
    await enqueue(f, sold);
    await processDemoSheetWrites(f.rt);
    assert.equal(f.rows.find((r) => r[0] === sid)![7], "売約済み");
    assert.equal(f.writes(), 2);
    f.rows.splice(
      f.rows.findIndex((r) => r[0] === sid),
      1,
    );
    f.changed();
    await syncPropertySheet(f.rt, "t", "oa", true);
    assert.equal(
      parse(
        (
          await one(f.ts, "SELECT data FROM assistant_sources WHERE id=?", [
            sid,
          ])
        ).data,
      ).status,
      "unpublished",
    );
  } finally {
    await f.dispose();
  }
});
test("sheet write: timeout after append reconciles by ID without resending; no draft source before confirmation", async () => {
  const f = await fixture();
  try {
    await enqueue(f);
    f.lost(true);
    await processDemoSheetWrites(f.rt);
    assert.equal(
      (await one(f.ts, "SELECT state FROM demo_sheet_writes")).state,
      "uncertain",
    );
    assert.equal(
      await one(f.ts, "SELECT id FROM assistant_sources WHERE id=?", [sid]),
      null,
    );
    await f.ts.query("UPDATE demo_sheet_writes SET next_at=''");
    await processDemoSheetWrites(f.rt);
    assert.equal(f.writes(), 1);
    assert.equal(
      (await one(f.ts, "SELECT state FROM demo_sheet_writes")).state,
      "synced",
    );
  } finally {
    await f.dispose();
  }
});
test("sheet write: denied scope, configuration change, wrong user, duplicate ID and changed remote row fail closed", async () => {
  const f = await fixture();
  try {
    await enqueue(f);
    await assert.rejects(
      queueDemoSheetWrite(f.rt, "stranger", "c2", sid, input),
    );
    await f.rt.db.query("UPDATE connections SET config='{}' WHERE id='drive'");
    await processDemoSheetWrites(f.rt);
    assert.equal(f.writes(), 0);
    assert.equal(
      (await one(f.ts, "SELECT state FROM demo_sheet_writes")).state,
      "error",
    );
    await f.rt.db.query(
      "UPDATE connections SET config='{\"canWriteSheets\":true}' WHERE id='drive'",
    );
    await f.ts.query("UPDATE demo_sheet_writes SET state='queued',next_at=''");
    await processDemoSheetWrites(f.rt);
    const v = (
      await one(f.ts, "SELECT version FROM assistant_sources WHERE id=?", [sid])
    ).version;
    await enqueue(f, { ...input, sourceId: sid, version: v, status: "sold" });
    f.rows.find((r) => r[0] === sid)![3] = 97000000;
    f.changed();
    await processDemoSheetWrites(f.rt);
    assert.equal(
      (await one(f.ts, "SELECT state FROM demo_sheet_writes")).state,
      "conflict",
    );
    assert.equal(f.writes(), 1);
  } finally {
    await f.dispose();
  }
});
async function lineFixture() {
  const f = await fixture();
  f.rt.assistantLine = {
    destination: "U" + "a".repeat(32),
    enabled: true,
    token: "fixture",
    secret: "fixture",
  };
  await f.rt.db.query(
    "INSERT INTO staff_line_links(tenant_id,user_id,destination,line_user_id,state,notifications,updated_at) VALUES ('t','owner',?,'staff-fixture','active',1,?)",
    [f.rt.assistantLine.destination, now()],
  );
  const note = async (id: string) =>
    f.rt.db.query(
      "INSERT INTO gs_demo_documents(id,user_id,title,body,held_at,updated_at) VALUES (?,'owner','新しい議事録','体験用の面談メモ。港区の希望について確認。',?,?)",
      [id, now(), now()],
    );
  return { ...f, note, binding: { user_id: "owner", tenant_id: "t" } };
}
test("meeting LINE: only new note notifies once; correct owner can link once, skip and stale edits never queue", async () => {
  const f = await lineFixture();
  try {
    await f.note("note1");
    await notifyDemoMeetings(f.rt);
    await notifyDemoMeetings(f.rt);
    const n = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_meeting_notices WHERE source_id='note1'",
    );
    assert.equal(n.state, "sent");
    assert.equal(f.calls.filter((c) => c.url.endsWith("/push")).length, 1);
    await assert.rejects(
      linkDemoMeetingFromLine(
        f.rt,
        { user_id: "stranger", tenant_id: "t" },
        n.id,
        "link",
      ),
    );
    assert.equal(
      (await linkDemoMeetingFromLine(f.rt, f.binding, n.id, "link")).docId,
      "note1",
    );
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT state FROM gs_demo_documents WHERE id='note1'",
        )
      ).state,
      "queued",
    );
    assert.equal(
      (await linkDemoMeetingFromLine(f.rt, f.binding, n.id, "link")).docId,
      undefined,
    );
    await f.note("note2");
    await notifyDemoMeetings(f.rt);
    const n2 = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_meeting_notices WHERE source_id='note2'",
    );
    await linkDemoMeetingFromLine(f.rt, f.binding, n2.id, "skip");
    await linkDemoMeetingFromLine(f.rt, f.binding, n2.id, "link");
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT state FROM gs_demo_documents WHERE id='note2'",
        )
      ).state,
      "unlinked",
    );
    await f.note("note3");
    await notifyDemoMeetings(f.rt);
    const n3 = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_meeting_notices WHERE source_id='note3'",
    );
    await f.rt.db.query(
      "UPDATE gs_demo_documents SET version=version+1 WHERE id='note3'",
    );
    await assert.rejects(
      linkDemoMeetingFromLine(f.rt, f.binding, n3.id, "link"),
      /更新/,
    );
  } finally {
    await f.dispose();
  }
});
test("meeting LINE: simultaneous taps, newer text and opt-out do not produce duplicate work or unsolicited notices", async () => {
  const f = await lineFixture();
  try {
    await f.note("race");
    await notifyDemoMeetings(f.rt);
    const n = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_meeting_notices WHERE source_id='race'",
    );
    const taps = await Promise.all([
      linkDemoMeetingFromLine(f.rt, f.binding, n.id, "link"),
      linkDemoMeetingFromLine(f.rt, f.binding, n.id, "link"),
    ]);
    assert.equal(taps.filter((r) => r.docId).length, 1);
    await f.rt.db.query(
      "UPDATE gs_demo_participants SET notifications_until=NULL WHERE user_id='owner'",
    );
    await f.note("off");
    await notifyDemoMeetings(f.rt);
    assert.equal(
      await one(
        f.rt.db,
        "SELECT id FROM gs_demo_meeting_notices WHERE source_id='off'",
      ),
      null,
    );
  } finally {
    await f.dispose();
  }
});
test("demo fast loop: ten simultaneous clients share a single lease and a 30-second idle interval", async () => {
  const f = await fixture();
  try {
    const leases = await Promise.all(
      Array.from({ length: 10 }, () => claimAssistantOA(f.rt, "t", "oa")),
    );
    assert.equal(leases.filter(Boolean).length, 1);
    await finishAssistantOA(f.rt, "t", "oa", leases.find(Boolean)!);
    assert.equal(await claimAssistantOA(f.rt, "t", "oa"), null);
  } finally {
    await f.dispose();
  }
});

test("meeting LINE: new Drive file creates a private copy on confirmation; historical files do not flood and a lost push uses the same retry key", async () => {
  const f = await lineFixture();
  try {
    await f.rt.db.query(
      'UPDATE connections SET config=\'{"actor":"owner","canWriteSheets":true}\' WHERE id=\'drive\'',
    );
    const at = now();
    for (const [id, date] of [
      ["oldfile", "2000-01-01T00:00:00.000Z"],
      ["newfile", at],
    ])
      await f.ts.query(
        "INSERT INTO meeting_inbox(id,connection_id,title,mime_type,modified_at,detected_at,source_email) VALUES (?,'drive','共通の新規議事録','text/plain',?,?,'fixture@example.test')",
        [id, at, date],
      );
    const original = f.rt.externalFetch,
      keys: string[] = [];
    f.rt.externalFetch = async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname === "/drive/v3/files/newfile")
        return u.searchParams.get("alt") === "media"
          ? new Response(
              "体験用議事録。港区の予算1億円以内の4LDKを希望します。",
            )
          : Response.json({ modifiedTime: at, trashed: false });
      if (u.pathname.endsWith("/push")) {
        keys.push(new Headers(init?.headers).get("X-Line-Retry-Key")!);
        if (keys.length === 1) throw Error("lost");
        return new Response(null, {
          status: 409,
          headers: { "x-line-accepted-request-id": "accepted" },
        });
      }
      return original(input, init);
    };
    await notifyDemoMeetings(f.rt);
    assert.equal(
      (await one(f.rt.db, "SELECT COUNT(*) n FROM gs_demo_meeting_notices")).n,
      1,
    );
    await f.rt.db.query("UPDATE gs_demo_meeting_notices SET next_at=''");
    await notifyDemoMeetings(f.rt);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    const n = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_meeting_notices WHERE source_id='newfile'",
    );
    const result = await linkDemoMeetingFromLine(f.rt, f.binding, n.id, "link");
    const copy = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_documents WHERE id=?",
      [result.docId!],
    );
    assert.equal(copy.user_id, "owner");
    assert.equal(copy.state, "queued");
    assert.match(copy.body, /港区/);
    await notifyDemoMeetings(f.rt);
    assert.equal(keys.length, 2);
  } finally {
    await f.dispose();
  }
});

test("sheet write: modifiedTime settling after append only retries reads", async () => {
  const f = await fixture();
  try {
    const original = f.rt.externalFetch;
    let wrote = false,
      metaReads = 0;
    f.rt.externalFetch = async (input, init) => {
      const u = new URL(String(input));
      if (
        wrote &&
        u.hostname === "www.googleapis.com" &&
        u.pathname.endsWith("/sheet")
      ) {
        metaReads++;
        if (metaReads === 2) f.changed();
      }
      const result = await original(input, init);
      if (init?.method === "POST" && u.hostname === "sheets.googleapis.com")
        wrote = true;
      return result;
    };
    await enqueue(f);
    await processDemoSheetWrites(f.rt);
    assert.equal(
      (await one(f.ts, "SELECT state FROM demo_sheet_writes")).state,
      "synced",
    );
    assert.equal(f.writes(), 1);
    assert.equal(metaReads, 4);
  } finally {
    await f.dispose();
  }
});

for (const manual of [false, true])
  test(`sheet ${manual ? "manual import" : "auto sync"}: a concurrent app save invalidates stale rows and checkpoint`, async () => {
    const f = await fixture();
    try {
      await enqueue(f);
      await processDemoSheetWrites(f.rt);
      const review = manual
        ? await previewProperties(f.rt, "t", "oa", "owner")
        : null;
      const batch = f.ts.batch.bind(f.ts);
      let injected = false;
      f.ts.batch = async (queries) => {
        if (
          !injected &&
          queries.some((q) => q.sql.startsWith("INSERT INTO assistant_sources"))
        ) {
          injected = true;
          const v = (
            await one(
              f.ts,
              "SELECT version FROM assistant_sources WHERE id=?",
              [sid],
            )
          ).version;
          await enqueue(f, {
            ...input,
            sourceId: sid,
            version: v,
            status: "sold",
          });
          await processDemoSheetWrites(f.rt);
        }
        return batch(queries);
      };
      await assert.rejects(
        manual
          ? importProperties(f.rt, "t", "oa", "owner", review!.reviewId)
          : syncPropertySheet(f.rt, "t", "oa", true),
      );
      assert.ok(injected);
      assert.equal(
        parse(
          (
            await one(f.ts, "SELECT data FROM assistant_sources WHERE id=?", [
              sid,
            ])
          ).data,
        ).status,
        "sold",
      );
      assert.equal(
        parse(
          (
            await one(
              f.ts,
              "SELECT synced_row FROM demo_sheet_writes WHERE source_id=?",
              [sid],
            )
          ).synced_row,
        )[7],
        "売約済み",
      );
      if (manual)
        assert.equal(
          (
            await one(
              f.ts,
              "SELECT review_state FROM assistant_google_config WHERE id='default'",
            )
          ).review_state,
          "ready",
        );
      else
        assert.equal(
          (
            await one(
              f.ts,
              "SELECT modified_time FROM assistant_sheet_sync WHERE id='default'",
            )
          ).modified_time,
          null,
        );
      await syncPropertySheet(f.rt, "t", "oa", true);
      assert.equal(
        parse(
          (
            await one(f.ts, "SELECT data FROM assistant_sources WHERE id=?", [
              sid,
            ])
          ).data,
        ).status,
        "sold",
      );
      assert.equal(f.writes(), 2);
    } finally {
      await f.dispose();
    }
  });


test('meeting LINE webhook durably queues before acknowledgement and never waits for AI',async()=>{
 const f=await lineFixture();try {
   f.rt.ai={apiKey:'fixture',model:'fixture'};
   await f.note('webhook-note');await notifyDemoMeetings(f.rt);
   const n=await one(f.rt.db,"SELECT id FROM gs_demo_meeting_notices WHERE source_id='webhook-note'");
   const event={type:'postback',webhookEventId:'same-event',source:{type:'user',userId:'staff-fixture'},postback:{data:`demo-meeting:${n.id}:link`}};
   assert.equal((await f.webhook(event)).status,200);
   assert.equal((await one(f.rt.db,"SELECT state FROM gs_demo_documents WHERE id='webhook-note'")).state,'queued');
   assert.equal(f.calls.filter(c=>c.url.includes('openai.com')).length,0);
   assert.equal((await f.webhook(event)).status,200);
   assert.equal(f.calls.filter(c=>c.url.endsWith('/reply')).length,1);
 } finally {await f.dispose();}
});
