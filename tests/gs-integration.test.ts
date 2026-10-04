import test from "node:test";
import assert from "node:assert/strict";
import {
  isolatedIntegrationRuntime,
  parseStaffTestUsers,
} from "../backend/gs-integration.ts";
import { one } from "../backend/db.ts";
import { assistantFixture } from "./helpers/assistant-fixture.ts";
import { harnessRequest } from "../backend/harness.ts";

test("integration isolates tenant/OA/purpose and forcibly disables sends/provisioning/providers", async () => {
  const f = await assistantFixture();
  try {
    let calls = 0;
    f.rt.deliveryEnabled = true;
    f.rt.assistantLine = {
      enabled: true,
      token: "fixture",
      secret: "fixture",
      destination: "fixture",
    };
    f.rt.externalFetch = async () => {
      calls++;
      return Response.json({ ok: true });
    };
    const rt = isolatedIntegrationRuntime(f.rt, {
      tenant: "t",
      oa: "oa",
      common: f.common,
      harness: f.h,
      tsunagu: f.ts,
    });
    assert.equal(rt.deliveryEnabled, false);
    assert.equal(rt.assistantLine, undefined);
    assert.equal(rt.ai, undefined);
    assert.equal(await rt.openDatabase("t", "", "common"), f.common);
    assert.equal(await rt.openDatabase("t", "oa", "tsunagu"), f.ts);
    for (const args of [
      ["other", "oa", "tsunagu"],
      ["t", "other", "harness"],
      ["t", "oa", "common"],
    ] as const)
      await assert.rejects(
        rt.openDatabase(args[0], args[1], args[2]),
        /検証対象外/,
      );
    await assert.rejects(
      rt.sendMail({ to: "fixture", subject: "fixture", text: "fixture" }),
    );
    await assert.rejects(rt.provisionDatabase({}));
    await assert.rejects(rt.deployTenant("t"));
    for (const url of [
      "https://api.line.me/v2/bot/message/push",
      "https://api.openai.com/v1/responses",
      "https://oauth2.googleapis.com/token",
      "https://hooks.slack.com/services/fixture",
    ])
      await assert.rejects(rt.externalFetch(url, { method: "POST" }));
    assert.equal(calls, 0);
  } finally {
    await f.dispose();
  }
});
test("integration gates real adapter methods/origins, rejects redirects and Harness sends", async () => {
  const f = await assistantFixture();
  try {
    const seen: Request[] = [];
    f.rt.externalFetch = async (input) => {
      const req = new Request(input);
      seen.push(req);
      return Response.json({ success: true, data: [] });
    };
    const rt = isolatedIntegrationRuntime(f.rt, {
      tenant: "t",
      oa: "oa",
      common: f.common,
      harness: f.h,
      tsunagu: f.ts,
      allowGoogle: true,
      allowOpenAI: true,
      harnessOrigin: "https://tsunagu-gs-harness.test.workers.dev",
    });
    await rt.externalFetch(
      "https://sheets.googleapis.com/v4/spreadsheets/pinned",
    );
    await rt.externalFetch("https://api.openai.com/v1/responses", {
      method: "POST",
    });
    const cred = {
      origin: "https://tsunagu-gs-harness.test.workers.dev",
      apiKey: "fixture",
    };
    await harnessRequest(rt, cred, "/api/line-accounts");
    assert.equal(seen.length, 3);
    assert.ok(seen.every((r) => r.redirect === "manual"));
    await assert.rejects(
      harnessRequest(rt, cred, "/api/messages", { text: "never-send" }),
    );
    for (const url of [
      "https://www.googleapis.com/drive/v3/files",
      "https://api.openai.com/v1/files",
      "https://enjin-line.shimoryo.workers.dev/api/friends",
    ])
      await assert.rejects(rt.externalFetch(url, { method: "POST" }));
    assert.equal(seen.length, 3);
    const redirectRt = isolatedIntegrationRuntime(
      {
        ...f.rt,
        externalFetch: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://other.test" },
          }),
      },
      {
        tenant: "t",
        oa: "oa",
        common: f.common,
        harness: f.h,
        tsunagu: f.ts,
        allowGoogle: true,
      },
    );
    await assert.rejects(
      redirectRt.externalFetch("https://www.googleapis.com/drive/v3/files"),
      /転送/,
    );
  } finally {
    await f.dispose();
  }
});

test("dedicated Harness reads use the service binding with credentials and network guards intact", async () => {
  const f = await assistantFixture();
  try {
    const bound: Request[] = [];
    let publicCalls = 0;
    let redirect = false;
    f.rt.externalFetch = async () => {
      publicCalls++;
      return new Response(null, { status: 404 });
    };
    const origin = "https://tsunagu-gs-harness.test.workers.dev";
    const rt = isolatedIntegrationRuntime(f.rt, {
      tenant: "t", oa: "oa", common: f.common, harness: f.h,
      tsunagu: f.ts, harnessOrigin: origin,
      harnessFetch: async (request) => {
        bound.push(request);
        return redirect
          ? new Response(null, { status: 302, headers: { Location: "https://other.test" } })
          : Response.json({ success: true, data: [{ id: "gs-line" }] });
      },
    });
    const credential = { origin, apiKey: "fixture-read-token" };
    assert.deepEqual(await harnessRequest(rt, credential, "/api/line-accounts"), [{ id: "gs-line" }]);
    assert.equal(publicCalls, 0);
    assert.equal(bound[0].url, origin + "/api/line-accounts");
    assert.equal(bound[0].headers.get("Authorization"), "Bearer fixture-read-token");
    assert.equal(bound[0].redirect, "manual");
    await assert.rejects(harnessRequest(rt, credential, "/api/messages", {}));
    await assert.rejects(rt.externalFetch(origin + "/webhooks/line"));
    await assert.rejects(rt.externalFetch("https://enjin-line.test.workers.dev/api/line-accounts"));
    assert.equal(bound.length, 1);
    assert.equal(publicCalls, 0);
    redirect = true;
    await assert.rejects(harnessRequest(rt, credential, "/api/line-accounts"), /転送/);
  } finally {
    await f.dispose();
  }
});

test("staff tester gate is empty by default, rejects malformed lists and same customer destination", async () => {
  const f = await assistantFixture();
  try {
    const staff = "U" + "a".repeat(32),
      customer = "U" + "b".repeat(32),
      tester = "U" + "c".repeat(32);
    f.rt.assistantLine = {
      enabled: true,
      destination: staff,
      secret: "fixture-secret",
      token: "fixture-token",
    };
    const scope = {
      tenant: "t",
      oa: "oa",
      common: f.common,
      harness: f.h,
      tsunagu: f.ts,
      allowStaffLine: true,
      customerLineDestination: customer,
    };
    assert.equal(
      isolatedIntegrationRuntime(f.rt, scope).assistantLine,
      undefined,
    );
    assert.equal(
      isolatedIntegrationRuntime(f.rt, {
        ...scope,
        staffLineTestUsers: [tester],
        customerLineDestination: staff,
      }).assistantLine,
      undefined,
    );
    assert.deepEqual(parseStaffTestUsers('["*"]'), []);
    assert.deepEqual(parseStaffTestUsers("invalid"), []);
    assert.deepEqual(
      parseStaffTestUsers(JSON.stringify([tester, "invalid"])),
      [],
    );
  } finally {
    await f.dispose();
  }
});

test("staff tester flow: signed allowlisted pairing, repeat protection, scoped replies/pushes and customer delivery blocked", async () => {
  const f = await assistantFixture();
  try {
    const staff = "U" + "a".repeat(32),
      customer = "U" + "b".repeat(32),
      tester = "U" + "c".repeat(32),
      stranger = "U" + "d".repeat(32);
    f.rt.assistantLine = {
      enabled: true,
      destination: staff,
      secret: "fixture-secret",
      token: "fixture-token",
    };
    const calls: { url: string; body: any }[] = [];
    let actualStaffBot = staff;
    f.rt.externalFetch = async (input, init) => {
      const r = new Request(input, init);
      if (r.url.endsWith("/v2/bot/info"))
        return Response.json({ userId: actualStaffBot });
      calls.push({ url: r.url, body: await r.json() });
      return Response.json({});
    };
    const isolated = isolatedIntegrationRuntime(f.rt, {
      tenant: "t",
      oa: "oa",
      common: f.common,
      harness: f.h,
      tsunagu: f.ts,
      allowStaffLine: true,
      staffLineTestUsers: [tester],
      customerLineDestination: customer,
    });
    Object.assign(f.rt, isolated);
    const pair = await f.request("/api/tenants/t/assistant-line/pair", {});
    assert.equal(pair.status, 200);
    const event = {
      webhookEventId: "allowed-pair",
      type: "message",
      source: { type: "user", userId: tester },
      replyToken: "fixture-reply",
      message: { type: "text", text: pair.data.text },
    };
    assert.equal(
      (
        await f.webhook({
          ...event,
          source: { type: "user", userId: stranger },
        })
      ).status,
      200,
    );
    assert.equal(calls.length, 0);
    assert.equal((await f.webhook(event, staff, "bad-signature")).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await f.webhook(event)).status, 200);
    await f.webhook(event);
    assert.equal(calls.length, 1);
    const code = calls[0].body.messages[0].text.match(/：([a-f0-9]+)/)[1];
    assert.equal(
      (await f.request("/api/tenants/t/assistant-line/confirm", { code }))
        .status,
      200,
    );
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT state FROM staff_line_links WHERE tenant_id='t' AND user_id='owner'",
        )
      )?.state,
      "active",
    );
    const send = (path: string, body: any, token = "fixture-token") =>
      f.rt.externalFetch(`https://api.line.me/v2/bot/message/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    await assert.rejects(
      send("reply", { replyToken: "fixture-reply", messages: [] }),
    );
    await assert.rejects(send("push", { to: stranger, messages: [] }));
    await assert.rejects(
      send("push", { to: tester, messages: [] }, "customer-token"),
    );
    await assert.rejects(send("broadcast", { messages: [] }));
    assert.equal(calls.length, 1);
    await send("push", {
      to: tester,
      messages: [{ type: "text", text: "fixture" }],
    });
    assert.equal(calls.length, 2);
    actualStaffBot = customer;
    await assert.rejects(
      send("push", { to: tester, messages: [] }),
      /担当者用トークン/,
    );
    assert.equal(calls.length, 2);
    assert.equal(f.rt.deliveryEnabled, false);
    await assert.rejects(
      harnessRequest(
        f.rt,
        {
          origin: "https://tsunagu-gs-harness.test.workers.dev",
          apiKey: "fixture",
        },
        "/api/messages",
        { text: "blocked" },
      ),
    );
  } finally {
    await f.dispose();
  }
});

test('integration allows only the exact leased demo row in the configured sheet, never arbitrary spreadsheet writes',async()=>{
 const f=await assistantFixture();try{
  const {json,now}=await import('../backend/db.ts');
  const row=['demo-property-test',...Array(17).fill('fixture')];
  await f.ts.query("INSERT INTO assistant_google_config(id,actor,data) VALUES ('default','owner','{\"spreadsheetId\":\"pinned\"}')");
  await f.ts.query("INSERT INTO demo_sheet_writes(source_id,user_id,customer_id,spreadsheet_id,config_version,request_hash,source_version,row_json,state,lease_until,updated_at) VALUES ('demo-property-test','owner','c','pinned',0,'hash',0,?,'sending',?,?)",[json(row),new Date(Date.now()+60000).toISOString(),now()]);
  let calls=0;
  f.rt.externalFetch=async()=>{calls++;return Response.json({});};
  const rt=isolatedIntegrationRuntime(f.rt,{tenant:'t',oa:'oa',common:f.common,harness:f.h,tsunagu:f.ts,allowGoogle:true,selfDemo:true});
  const url="https://sheets.googleapis.com/v4/spreadsheets/pinned/values/"+encodeURIComponent("'物件台帳'!A1:R1001")+":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";
  const init={method:'POST',body:json({majorDimension:'ROWS',values:[row]})};
  await rt.externalFetch(url,init);assert.equal(calls,1);
  await assert.rejects(rt.externalFetch(url.replace('/pinned/','/elsewhere/'),init));
  await assert.rejects(rt.externalFetch(url,{...init,body:json({majorDimension:'ROWS',values:[[...row.slice(0,-1),'changed']]})}));
  await assert.rejects(rt.externalFetch(url.replace('RAW','USER_ENTERED'),init));
  await assert.rejects(rt.externalFetch('https://sheets.googleapis.com/v4/spreadsheets/pinned:batchUpdate',init));
  await f.ts.query("UPDATE demo_sheet_writes SET state='synced'");
  await assert.rejects(rt.externalFetch(url,init));assert.equal(calls,1);
 }finally{await f.dispose();}
});
