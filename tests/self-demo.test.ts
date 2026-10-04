import test from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./helpers/assistant-fixture.ts";
import { createApp } from "../backend/app.ts";
import {
  startDemo,
  confirmDemoCustomer,
  processDemoDocument,
} from "../backend/self-demo.ts";
import {
  demoParticipant,
  demoBookingToken,
  claimDemoAI,
  demoCustomerAllowed,
} from "../backend/self-demo-access.ts";
import { applyDemoWish, pendingDemoMeetings } from "../backend/self-demo-preferences.ts";
import {
  demoBookingView,
  saveDemoBooking,
  receiveDemoTimeRex,
  reconcileDemoBookings,
} from "../backend/self-demo-booking.ts";
import { authOptions } from "../backend/auth.ts";
import { one, all, now, json, parse } from "../backend/db.ts";
import { digest, sign } from "../backend/security.ts";
import {
  gsHarnessDDL,
  gsHarnessFetch,
  type GsHarnessConfig,
} from "../backend/gs-harness.ts";
import { LocalStore } from "../backend/local.ts";
import { customerTestDelivery } from "../backend/customer-test-delivery.ts";
import { upsertSource, scanAssistant } from "../backend/assistant.ts";

const line = "U" + "1".repeat(32),
  destination = "U" + "2".repeat(32),
  staffDestination = "U" + "3".repeat(32);
async function fixture() {
  const f = await assistantFixture();
  f.rt.selfDemo = { tenant: "t", oa: "oa", capacity: 10 };
  const app = createApp();
  f.rt.auth = {
    api: {
      getSession: async ({ headers }: any) => {
        const actor = headers.get("x-actor") || "guest";
        return {
          user: {
            id: actor,
            name: actor,
            email: actor + "@example.test",
            emailVerified: headers.get("x-verified") !== "no",
          },
          session: { id: "session-" + actor },
        };
      },
    },
  } as any;
  const request = async (
    path: string,
    body?: any,
    actor = "guest",
    method = body === undefined ? "GET" : "POST",
  ) => {
    const r = await app.fetch(
      new Request(f.rt.origin + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          origin: f.rt.origin,
          authorization: "fixture",
          "x-actor": actor,
        },
        ...(body === undefined ? {} : { body: json(body) }),
      }),
      { runtime: f.rt },
    );
    return { status: r.status, data: (await r.json()) as any };
  };
  const baseFetch = f.rt.externalFetch;
  let followed = true;
  let proof: any = null;
  f.rt.externalFetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/demo-proof?"))
      return Response.json({ success: true, data: proof });
    if (url.endsWith("/api/friends/guestfriend"))
      return Response.json({
        success: true,
        data: {
          id: "guestfriend",
          lineUserId: line,
          displayName: "体験者のLINE名",
          lineAccountId: "account",
          isFollowing: followed,
        },
      });
    if (url.endsWith("/api/friends/guestfriend/messages"))
      return Response.json({ success: true, data: [] });
    return baseFetch(input, init);
  };
  const pair = async (actor = "guest") => {
    await startDemo(f.rt, { id: actor, name: actor });
    const hash = await digest(actor + "pair");
    await f.rt.db.query(
      "UPDATE gs_demo_participants SET pair_hash=?,pair_expires_at=? WHERE user_id=?",
      [hash, new Date(Date.now() + 600000).toISOString(), actor],
    );
    proof = {
      pair_hash: hash,
      confirm_hash: await digest("123abc"),
      expires_at: new Date(Date.now() + 600000).toISOString(),
      line_user_id: line,
      friend_id: "guestfriend",
    };
    await confirmDemoCustomer(f.rt, actor, "123abc");
    return (await demoParticipant(f.rt, actor))!;
  };
  return {
    ...f,
    app,
    request,
    pair,
    unfollow: () => {
      followed = false;
    },
    setProof: (v: any) => (proof = v),
  };
}
test("self demo: public signup opt-in, verified identity, invitation behavior preserved", async () => {
  const f = await fixture();
  try {
    const options = {
      database: null,
      db: f.rt.db,
      origin: f.rt.origin,
      secret: "test-secret",
      sendMail: async () => {},
    };
    const user = {
      id: "new",
      email: "New@Example.Test",
      name: "New",
      emailVerified: true,
    } as any;
    await assert.rejects(() =>
      authOptions(options).databaseHooks.user.create.before(user),
    );
    const demo = authOptions({ ...options, publicGoogleSignup: true });
    assert.equal(
      (await demo.databaseHooks.user.create.before(user)).data.email,
      "new@example.test",
    );
    await assert.rejects(() =>
      demo.databaseHooks.user.create.before({ ...user, emailVerified: false }),
    );
    assert.equal((await f.request("/api/me")).data.home, "/demo");
    assert.equal((await f.request("/api/tenants/t/customers")).status, 403);
    assert.equal((await f.request("/api/demo/start", {})).status, 200);
    assert.equal((await f.request("/api/demo/start", {})).status, 200);
    assert.deepEqual(
      JSON.parse(
        (
          await one(
            f.rt.db,
            "SELECT roles FROM memberships WHERE user_id='guest'",
          )
        ).roles,
      ),
      ["sales", "demo"],
    );
    for (const path of [
      "/api/tenants/t/customers",
      "/api/tenants/t/setup",
      "/api/ops/tenants",
      "/api/tenants/t/accounts/oa/assistant",
    ])
      assert.equal((await f.request(path)).status, 403, path);
    assert.equal(
      (await f.request("/api/tenants/t/assistant-line")).status,
      200,
    );
    assert.equal(
      (await f.request("/api/tenants/other/assistant-line")).status,
      403,
    );
  } finally {
    await f.dispose();
  }
});
test("self demo: 10 concurrent enrollments cannot exceed capacity or create duplicate membership", async () => {
  const f = await fixture();
  try {
    const r = await Promise.allSettled(
      Array.from({ length: 14 }, (_, i) =>
        startDemo(f.rt, { id: "guest" + i, name: "Guest" }),
      ),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 10);
    assert.equal(
      (await one(f.rt.db, "SELECT COUNT(*) AS n FROM gs_demo_participants")).n,
      10,
    );
    const p = (await all(f.rt.db, "SELECT * FROM gs_demo_participants"))[0];
    await startDemo(f.rt, { id: p.user_id, name: "repeat" });
    assert.equal(
      (await one(f.rt.db, "SELECT COUNT(*) AS n FROM gs_demo_participants")).n,
      10,
    );
  } finally {
    await f.dispose();
  }
});
test("self demo: LINE code belongs to customer OA, expires, is single-use, cannot steal another customer", async () => {
  const f = await fixture();
  try {
    const p = await f.pair();
    assert.equal(
      (
        await one(f.common, "SELECT * FROM customers WHERE id=?", [
          p.customer_id,
        ])
      ).owner_user_id,
      "guest",
    );
    assert.equal(
      (
        await one(f.common, "SELECT * FROM customers WHERE id=?", [
          p.customer_id,
        ])
      ).name,
      "体験者のLINE名",
    );
    await assert.rejects(
      () => confirmDemoCustomer(f.rt, "guest", "123abc"),
      (e: any) => e.code === "PAIR_EXPIRED",
    );
    await assert.rejects(
      () => f.pair("second"),
      (e: any) => e.code === "DEMO_ALREADY_LINKED",
    );
    assert.equal(
      (
        await one(
          f.common,
          "SELECT COUNT(*) AS n FROM customer_links WHERE line_user_id=?",
          [line],
        )
      ).n,
      1,
    );
  } finally {
    await f.dispose();
  }
});
test("self demo: own snapshot and document endpoints never expose or edit another participant data", async () => {
  const f = await fixture();
  try {
    await f.pair();
    await startDemo(f.rt, { id: "second", name: "Second" });
    const doc = await f.request("/api/demo/documents", {
      title: "本人のメモ",
      body: "渋谷区で予算5500万円以内の2LDK、所有権、駅徒歩10分以内を希望します。",
      heldAt: now(),
    });
    assert.equal(doc.status, 200);
    assert.equal((await f.request("/api/demo")).data.documents.length, 1);
    assert.equal(
      (await f.request("/api/demo", undefined, "second")).data.documents.length,
      0,
    );
    assert.equal(
      (
        await f.request(
          `/api/demo/documents/${doc.data.id}/link`,
          { version: 1 },
          "second",
        )
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/api/demo")).data.customer.name,
      "体験者のLINE名",
    );
    assert.equal(
      (
        await f.request("/api/demo/proposals/nope/action", {
          action: "approve",
          version: 1,
        })
      ).status,
      404,
    );
    assert.equal((await f.request("/api/demo")).data.messages.length, 0);
  } finally {
    await f.dispose();
  }
});
test("self demo: signed customer proof replies once, is not a sales message, false signatures cannot register", async () => {
  const db = new LocalStore(":memory:");
  for (const sql of gsHarnessDDL) await db.query(sql);
  const calls: any[] = [];
  const cfg: GsHarnessConfig = {
    enabled: true,
    selfDemo: true,
    accountId: "account",
    channelId: "12345",
    destination,
    apiToken: "a".repeat(40),
    channelSecret: "s".repeat(32),
    channelAccessToken: "token",
    profileFetch: async (input, init) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        String(input).endsWith("/info") ? { userId: destination } : {},
      );
    },
  };
  const event = {
    webhookEventId: "event",
    type: "message",
    timestamp: Date.now(),
    replyToken: "r",
    source: { type: "user", userId: line },
    message: { id: "m", type: "text", text: "体験 " + "a".repeat(64) },
  };
  const raw = json({ destination, events: [event] });
  const request = (signature: string) =>
    new Request("https://h.test/webhooks/line", {
      method: "POST",
      headers: { "x-line-signature": signature },
      body: raw,
    });
  try {
    assert.equal((await gsHarnessFetch(request("wrong"), db, cfg)).status, 401);
    const signature = await sign(cfg.channelSecret!, raw);
    assert.equal(
      (await gsHarnessFetch(request(signature), db, cfg)).status,
      200,
    );
    assert.equal(
      (await gsHarnessFetch(request(signature), db, cfg)).status,
      200,
    );
    assert.equal(calls.filter((x) => x.url.endsWith("/reply")).length, 1);
    assert.equal(
      (await one(db, "SELECT COUNT(*) AS n FROM gs_line_messages")).n,
      0,
    );
    const proof = await one(db, "SELECT * FROM gs_demo_proofs");
    assert.equal(proof.state, "ready");
    assert.equal(proof.line_user_id, line);
    assert.ok(!proof.code);
  } finally {
    db.close();
  }
});
test("self demo: personal AI budget is atomic and isolated from other participants", async () => {
  const f = await fixture();
  try {
    await startDemo(f.rt, { id: "guest", name: "guest" });
    await startDemo(f.rt, { id: "second", name: "second" });
    const claims = await Promise.all(
      Array.from({ length: 18 }, () => claimDemoAI(f.rt, "guest")),
    );
    assert.equal(claims.filter(Boolean).length, 12);
    assert.equal(await claimDemoAI(f.rt, "second"), true);
    assert.equal(await claimDemoAI(f.rt, "unknown"), false);
  } finally {
    await f.dispose();
  }
});
test("self demo: booking token maps only to self, repeats and stale versions cannot duplicate booking or send", async () => {
  const f = await fixture();
  try {
    const p = await f.pair(),
      token = await demoBookingToken(f.rt, p.customer_id);
    let sent = 0;
    f.rt.customerTestDelivery = {
      sendDemoBooking: async () => {
        sent++;
      },
    } as any;
    const startsAt = new Date(Date.now() + 86400000).toISOString();
    const first = await saveDemoBooking(f.rt, token, {
      action: "book",
      startsAt,
      version: 0,
    });
    assert.equal(first.booking?.state, "booked");
    await saveDemoBooking(f.rt, token, {
      action: "book",
      startsAt,
      version: 0,
    });
    assert.equal(sent, 1);
    assert.equal(
      (
        await one(f.common, "SELECT stage FROM customers WHERE id=?", [
          p.customer_id,
        ])
      ).stage,
      "booked",
    );
    await assert.rejects(() =>
      saveDemoBooking(f.rt, token, { action: "cancel", version: 0 }),
    );
    await saveDemoBooking(f.rt, token, { action: "cancel", version: 1 });
    assert.equal(sent, 2);
    assert.equal(
      (
        await one(f.common, "SELECT stage FROM customers WHERE id=?", [
          p.customer_id,
        ])
      ).stage,
      "result_pending",
    );
    await assert.rejects(() => demoBookingView(f.rt, "x".repeat(43)));
    await assert.rejects(() =>
      saveDemoBooking(f.rt, token, {
        action: "book",
        startsAt: new Date(Date.now() - 1000).toISOString(),
        version: 2,
      }),
    );
    f.rt.selfDemo!.timerexUrl = "https://timerex.net/s/gs-estate/59cbab21";
    const pending = await demoBookingView(f.rt, token);
    assert.equal(pending.configured, false);
    assert.equal(pending.timerexUrl, null, "do not reserve a real slot before receipt transport is configured");
    f.rt.timerexSecrets = { oa: "fixture-webhook-secret" };
    const view = await demoBookingView(f.rt, token);
    assert.equal(view.mode, "timerex");
    assert.equal(
      new URL(view.timerexUrl!).searchParams.get("tracking_token"),
      token,
    );
    await assert.rejects(
      () =>
        saveDemoBooking(f.rt, token, { action: "book", startsAt, version: 2 }),
      (e: any) => e.code === "USE_TIMEREX",
    );
  } finally {
    await f.dispose();
  }
});
test("self demo: real customer transport permits verified guest only and records booking uncertain without retry", async () => {
  const f = await fixture();
  try {
    const p = await f.pair();
    await f.rt.db.query(
      "UPDATE accounts SET channel_id='123456',destination=? WHERE id='oa'",
      [destination],
    );
    let pushes = 0;
    const delivery = customerTestDelivery(
      {
        tenant: "t",
        oa: "oa",
        enabled: true,
        selfDemo: true,
        channelId: "123456",
        destination,
        staffDestination,
        token: "token",
        lineUserIds: [],
      },
      async (input) => {
        if (String(input).endsWith("/info"))
          return Response.json({ userId: destination });
        pushes++;
        throw Error("lost");
      },
    );
    f.rt.customerTestDelivery = delivery;
    assert.equal(delivery.enabled, true);
    assert.equal(
      await delivery.allows(line, f.rt, "guest", p.customer_id),
      true,
    );
    assert.equal(
      await delivery.allows(line, f.rt, "second", p.customer_id),
      false,
    );
    const token = await demoBookingToken(f.rt, p.customer_id);
    const b = await saveDemoBooking(f.rt, token, {
      action: "book",
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      version: 0,
    });
    assert.equal(b.booking?.notice_state, "uncertain");
    assert.equal(pushes, 1);
    await assert.rejects(() =>
      delivery.sendDemoBooking!(f.rt, "guest", p.customer_id, 1),
    );
    assert.equal(pushes, 1);
  } finally {
    await f.dispose();
  }
});
test("self demo: meeting -> matching -> grounded draft, source ownership and deduplication", async () => {
  const f = await fixture();
  try {
    const p = await f.pair();
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    const baseFetch = f.rt.externalFetch;
    let extractions = 0;
    const quote =
      "渋谷区、5500万円以内、2LDK、所有権、駅徒歩10分以内。定期借地権は除外。";
    f.rt.externalFetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (
        String(input).includes("api.openai.com") &&
        body?.text?.format?.name === "meeting_extract"
      ) {
        extractions++;
        return Response.json({
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 10 },
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: json({
                    summary: "住まいの希望条件を確認しました。",
                    dealState: "uncontracted",
                    stage: "post_meeting",
                    keyPoints: ["渋谷区"],
                    concerns: [],
                    interests: ["2LDK"],
                    nextAction: "条件に合う物件を案内する",
                    triggers: [],
                    tracking: {
                      conditionQuote: quote,
                      terms: ["渋谷区", "2LDK", "所有権"],
                      timings: [],
                      propertyWish: {
                        area: "渋谷区",
                        maxPrice: 55000000,
                        required: ["2LDK", "所有権", "駅徒歩10分以内"],
                        excluded: ["定期借地権"],
                        quote,
                      },
                    },
                  }),
                },
              ],
            },
          ],
        });
      }
      return baseFetch(input, init);
    };
    const source = {
      id: "private-sample",
      kind: "product",
      industry: "estate",
      title: "渋谷のテスト物件",
      url: "https://example.test/property",
      publishedAt: now(),
      checkedAt: now(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      summary: "渋谷区、48000000円、2LDK、所有権、駅徒歩5分。",
      tags: ["2LDK", "所有権", "駅徒歩5分"],
      absentTags: ["定期借地権"],
      area: "渋谷区",
      price: 48000000,
      status: "available",
      stock: 1,
      property: { walkingMinutes: 5, layout: "2LDK", tenure: "所有権" },
    };
    await upsertSource(f.rt, "t", "oa", {
      ...source,
      audienceCustomerId: "another-customer",
    });
    // Reproduce an existing owner's older follow-up profile alongside a newer demo wish.
    await f.ts.query("INSERT INTO context_notes(id,customer_id,source,body,confirmed_by,confirmed_at,created_at) VALUES ('old-profile',?,'human','文京区、5200万円以内、3LDK','guest',?,?)", [p.customer_id,now(),now()]);
    const oldSource=await one(f.ts,"SELECT id,customer_id,body,confirmed_by,confirmed_at,source,source_ref FROM context_notes WHERE id='old-profile'");
    await f.ts.query("INSERT INTO followup_profiles(customer_id,owner_user_id,line_user_id,data,evidence,confirmed_by,updated_at) VALUES (?,'guest',?,?,?,'guest',?)", [p.customer_id,line,
      json({industry:"estate",enabled:true,conditionQuote:"文京区、5200万円以内、3LDK",terms:["文京区","3LDK"],stalledQuote:"",promiseQuote:"",promiseAt:null,phase:"considering",waitDays:3}),
      json({kind:"note",id:oldSource.id,body:oldSource.body,hash:await digest(json(oldSource))}),now()]);

    const doc = await f.request("/api/demo/documents", {
      title: "テスト面談",
      body: quote,
      heldAt: now(),
    });
    const linked = await f.request(`/api/demo/documents/${doc.data.id}/link`, {
      version: 1,
    });
    assert.equal(linked.status, 200);
    const stored = await one(
      f.rt.db,
      "SELECT * FROM gs_demo_documents WHERE id=?",
      [doc.data.id],
    );
    assert.equal(stored.state, "ready", stored.error || stored.analysis);
    assert.equal(
      (
        await all(f.ts, "SELECT * FROM proposals WHERE customer_id=?", [
          p.customer_id,
        ])
      ).length,
      0,
      "other participant source must not match",
    );
    await upsertSource(f.rt, "t", "oa", { ...source, id: "shared-sample" });
    const run = await scanAssistant(
      f.rt,
      "t",
      "oa",
      "guest",
      undefined,
      [p.customer_id],
      { generateDraft: true },
    );
    assert.equal(run.created, 1);
    const proposal = await one(
      f.ts,
      "SELECT * FROM proposals WHERE customer_id=?",
      [p.customer_id],
    );
    assert.equal(proposal.state, "pending", proposal.hold_reason);
    assert.ok(proposal.draft.includes("/demo/book/"));
    const draftInput = JSON.parse(f.calls.find(c => c.body?.text?.format?.name === "assistant_grounded_draft")!.body.input);
    assert.equal(draftInput.currentPropertyConditions.meetingAt, stored.held_at);
    assert.ok(proposal.reason.includes("渋谷区"));
    assert.ok(!proposal.reason.includes("文京区"));
    assert.ok(draftInput.requiredRefs.includes(`note:${stored.id}-v1`));
    assert.ok(!draftInput.requiredRefs.includes("followup-profile"), "old profile must not be mandatory evidence for the current wish");
    assert.equal(JSON.parse(draftInput.refs.find((r:any)=>r.id==="followup-profile").text).propertyConditionsSuperseded,true);

    assert.equal(extractions, 1);
    const second = await scanAssistant(
      f.rt,
      "t",
      "oa",
      "guest",
      undefined,
      [p.customer_id],
      { generateDraft: true },
    );
    assert.equal(second.created, 0);
    await processDemoDocument(f.rt, "guest", doc.data.id);
    assert.equal(extractions, 1);
    const attempts = await one(
      f.rt.db,
      "SELECT COUNT(*) AS n FROM gs_demo_actions WHERE user_id='guest' AND kind='ai'",
    );
    assert.equal(attempts.n, 2);
    const latestPreference = await one(f.ts,"SELECT * FROM assistant_preferences WHERE customer_id=?",[p.customer_id]);
    await f.common.query("UPDATE customers SET stage='result_pending' WHERE id=?",[p.customer_id]);
    const older = await f.request("/api/demo/documents",{title:"過去の面談",body:quote,heldAt:new Date(Date.now()-3*86400000).toISOString()});
    assert.equal((await f.request(`/api/demo/documents/${older.data.id}/link`,{version:1})).status,200);
    const history = await one(f.rt.db,"SELECT * FROM gs_demo_documents WHERE id=?",[older.data.id]);
    assert.equal(history.state,"ready",history.error);
    assert.equal(parse(history.analysis).applied,false);
    assert.deepEqual(await one(f.ts,"SELECT * FROM assistant_preferences WHERE customer_id=?",[p.customer_id]),latestPreference);
    assert.equal((await one(f.common,"SELECT stage FROM customers WHERE id=?",[p.customer_id])).stage,"result_pending");
  } finally {
    await f.dispose();
  }
});
test("self demo: staff LINE pairing permits valid guest nonce but ignores unsolicited unbound LINE", async () => {
  const f = await fixture();
  try {
    await startDemo(f.rt, { id: "guest", name: "Guest" });
    f.rt.assistantLine = {
      destination: staffDestination,
      token: "staff-token",
      secret: "staff-secret",
      enabled: true,
    };
    f.rt.staffLineTestScope = {
      tenant: "t",
      lineUserIds: [],
      replyTokens: new Set(),
    };
    const paired = await f.request("/api/tenants/t/assistant-line/pair", {});
    assert.equal(paired.status, 200);
    await f.webhook({
      type: "message",
      source: { type: "user", userId: line },
      message: { type: "text", text: "hello" },
    });
    assert.equal(
      (await one(f.rt.db, "SELECT COUNT(*) AS n FROM staff_line_events")).n,
      0,
    );
    await f.webhook({
      type: "message",
      source: { type: "user", userId: line },
      message: { type: "text", text: paired.data.text },
    });
    const reply = f.calls.find((c) => c.url.endsWith("/reply"));
    assert.ok(reply);
    const code =
      reply.body.messages[0].text.match(/本人確認コード：([a-f0-9]+)/)[1];
    assert.equal(
      (await f.request("/api/tenants/t/assistant-line/confirm", { code }))
        .status,
      200,
    );
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT state FROM staff_line_links WHERE user_id='guest'",
        )
      ).state,
      "active",
    );
    assert.equal(
      (await f.request("/api/demo/notifications", { enabled: true })).status,
      200,
    );
    assert.equal((await f.request("/api/demo")).data.staff.notifications, 1);
    await f.webhook({
      type: "unfollow",
      source: { type: "user", userId: line },
    });
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT state FROM staff_line_links WHERE user_id='guest'",
        )
      ).state,
      "revoked",
    );
  } finally {
    await f.dispose();
  }
});
test("self demo: TimeRex receipt is mapped to verified customer and duplicate/cancel receipts do not duplicate send", async () => {
  const f = await fixture();
  try {
    const p = await f.pair();
    let sends = 0;
    f.rt.customerTestDelivery = {
      sendDemoBooking: async (rt: typeof f.rt, actor: string, bid: string, version: number) => {
        sends++;
        await rt.db.query("UPDATE gs_demo_bookings SET notice_state='accepted' WHERE id=? AND version=?",[bid,version]);
      },
    } as any;
    const appt = "appt",
      startsAt = new Date(Date.now() + 86400000).toISOString();
    await f.h.query(
      "INSERT INTO appointments(id,customer_id,external_id,title,starts_at,state,source) VALUES (?,?,?,'test',?,'booked','timerex')",
      [appt, p.customer_id, "timerex-event", startsAt],
    );
    const payload = {
      event: "booking.created" as const,
      bookingId: "timerex-event",
      title: "G’s",
      startsAt,
      guestName: "Guest",
      guestEmail: "guest@example.test",
      trackingToken: await demoBookingToken(f.rt, p.customer_id),
      detailsUrl: "https://timerex.net/booking-cancel/test",
    };
    await receiveDemoTimeRex(f.rt, "t", "oa", payload);
    await receiveDemoTimeRex(f.rt, "t", "oa", payload);
    assert.equal(sends, 1);
    // Simulate cancellation arriving while the first notification is in flight.
    await f.rt.db.query("UPDATE gs_demo_bookings SET notice_state='sending' WHERE external_id=?", [payload.bookingId]);
    await f.h.query("UPDATE appointments SET state='cancelled' WHERE id=?", [
      appt,
    ]);
    await receiveDemoTimeRex(f.rt, "t", "oa", {
      ...payload,
      event: "booking.cancelled",
    });
    assert.equal(sends, 1);
    await f.rt.db.query("UPDATE gs_demo_bookings SET notice_state='accepted' WHERE external_id=?", [payload.bookingId]);
    await reconcileDemoBookings(f.rt);
    await receiveDemoTimeRex(f.rt, "t", "oa", {
      ...payload,
      event: "booking.cancelled",
    });
    assert.equal(sends, 2);
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT state FROM gs_demo_bookings WHERE external_id=?",
          ["timerex-event"],
        )
      ).state,
      "cancelled",
    );
  } finally {
    await f.dispose();
  }
});

test("self demo: a returning owner reuses only their own proven LINE customer", async () => {
  const f=await fixture();
  try {
    await f.common.query("INSERT INTO customers(id,name,owner_user_id,created_at) VALUES ('returning','本人','guest',?)",[now()]);
    await f.common.query("INSERT INTO customer_links(oa_id,line_user_id,customer_id) VALUES ('oa',?,'returning')",[line]);
    const p=await f.pair();
    assert.equal(p.customer_id,'returning');
    assert.equal((await demoBookingView(f.rt,await demoBookingToken(f.rt,'returning'))).mode,'demo');
    assert.equal((await one(f.common,"SELECT COUNT(*) AS n FROM customer_links WHERE line_user_id=?",[line])).n,1);
    await assert.rejects(()=>f.pair('second'),(e:any)=>e.code==='DEMO_ALREADY_LINKED');
  } finally {await f.dispose();}
});

test("self demo: authenticated TimeRex ACK does not wait for LINE, and other calendars are ignored", async () => {
  const f=await fixture();
  let release!:()=>void;
  const blockedSend=new Promise<void>(resolve=>{release=resolve;});
  const held:Promise<unknown>[]=[];
  try {
    const p=await f.pair();
    f.rt.selfDemo!.timerexUrl='https://timerex.net/s/gs-estate/59cbab21';
    f.rt.timerexSecrets={oa:'fixture-webhook-secret'};
    let sending=false;
    f.rt.customerTestDelivery={sendDemoBooking:async()=>{sending=true;await blockedSend;}} as any;
    const payload={webhook_type:'event_confirmed',calendar_url:f.rt.selfDemo!.timerexUrl,calendar_name:'体験予約',event:{
      id:'official-event',start_datetime:new Date(Date.now()+86400000).toISOString(),
      form:[{field_type:'guest_name',value:'体験者'},{field_type:'guest_email',value:'guest@example.test'}],
      url_params:[{tracking_token:await demoBookingToken(f.rt,p.customer_id)}],
    }};
    const request=(body:unknown,secret='fixture-webhook-secret')=>f.app.fetch(new Request(f.rt.origin+'/webhooks/timerex/oa',{
      method:'POST',headers:{'Content-Type':'application/json','x-timerex-authorization':secret},body:json(body),
    }),{runtime:f.rt},{waitUntil:(p:Promise<unknown>)=>{held.push(p);},passThroughOnException(){}} as any);
    assert.equal((await request(payload,'wrong')).status,401);
    const ignored=await request({...payload,calendar_url:'https://timerex.net/s/other/calendar'});
    assert.equal((await ignored.json() as any).ignored,true);
    assert.equal((await one(f.h,'SELECT COUNT(*) AS n FROM appointments')).n,0);
    let timeout:ReturnType<typeof setTimeout>;
    const response=await Promise.race([request(payload),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('ACK waited for LINE')),1000);})]).finally(()=>clearTimeout(timeout));
    assert.equal(response.status,200);
    assert.equal(held.length,1);
    assert.equal((await one(f.h,'SELECT customer_id FROM appointments WHERE external_id=?',['official-event'])).customer_id,p.customer_id);
    release();await Promise.all(held);
    assert.equal(sending,true);
  } finally {release();await Promise.allSettled(held);await f.dispose();}
});

test("self demo: interrupted LINE setup stays pending and can resume after reload or expiry", async () => {
  for (const failure of ["customer_batch", "timerex_link"]) {
    const f = await fixture();
    const batch = f.common.batch.bind(f.common), query = f.common.query.bind(f.common);
    try {
      let fail = true;
      f.common.batch = async qs => {
        if (failure === "customer_batch" && fail) { fail = false; throw Error("storage interruption"); }
        return batch(qs);
      };
      f.common.query = async (sql, params) => {
        if (failure === "timerex_link" && fail && sql.startsWith("INSERT OR IGNORE INTO external_links") && sql.includes("'timerex'")) {
          fail = false; throw Error("storage interruption");
        }
        return query(sql, params);
      };
      await assert.rejects(() => f.pair(), /storage interruption/);
      const p = (await demoParticipant(f.rt, "guest"))!;
      assert.equal(p.customer_line_id, line, "retain the unique LINE claim while resuming");
      assert.equal((await f.request("/api/demo")).data.customer, null, "partial customer record is not completion");
      assert.equal((await f.request("/api/demo")).data.customerPairPending,true);
      assert.equal(await demoCustomerAllowed(f.rt, line, "guest", p.customer_id), false);
      const bookingToken = await demoBookingToken(f.rt,p.customer_id);
      await assert.rejects(() => demoBookingView(f.rt, bookingToken), (e: any) => e.code === "BOOKING_LINK_INVALID");
      assert.equal((await f.request("/api/demo/documents", {title:"test",body:"a".repeat(30),heldAt:now()})).status,409);
      await f.rt.db.query("UPDATE gs_demo_participants SET pair_expires_at=? WHERE user_id='guest'", [new Date(Date.now()-1000).toISOString()]);
      const regenerated = await f.request("/api/demo/customer/pair", {});
      assert.equal(regenerated.status,200,"reissue must work despite the interrupted LINE claim");
      const pending = (await demoParticipant(f.rt,"guest"))!;
      f.setProof({confirm_hash:await digest("retry-code"), expires_at:pending.pair_expires_at, line_user_id:line,friend_id:"guestfriend"});
      assert.equal((await f.request("/api/demo/customer/confirm",{code:"retry-code"})).status,200);
      assert.equal((await f.request("/api/demo")).data.customer.name,"体験者のLINE名");
      assert.equal((await f.request("/api/demo")).data.customerPairPending,false);
      assert.equal(await demoCustomerAllowed(f.rt,line,"guest",p.customer_id),true);
      assert.equal((await one(f.common,"SELECT COUNT(*) AS n FROM customers WHERE id=?",[p.customer_id])).n,1);
      assert.equal((await one(f.common,"SELECT COUNT(*) AS n FROM external_links WHERE customer_id=?",[p.customer_id])).n,2);
    } finally { await f.dispose(); }
  }
});

async function preferenceNote(f: Awaited<ReturnType<typeof fixture>>, customer: string, id: string, heldAt: string) {
  await f.rt.db.query("INSERT INTO gs_demo_documents(id,user_id,title,body,held_at,updated_at) VALUES (?,'guest',?,'fixture body',?,?)",[id,id,heldAt,now()]);
  await f.ts.query("INSERT INTO context_notes(id,customer_id,source,source_ref,body,confirmed_by,confirmed_at,created_at) VALUES (?,?,'self_demo',?,?,'guest',?,?)",[id+'-v1',customer,id,id,now(),now()]);
  return {id,held_at:heldAt};
}
const demoWish = (area: string | null, maxPrice: number | null = 50000000) => ({area,maxPrice,required:["2LDK"],excluded:[]});

test("self demo: older meetings cannot replace current wishes, including reversed AI completion", async () => {
  const f=await fixture();
  try {
    const p=await f.pair();
    const older=await preferenceNote(f,p.customer_id,"older","2026-10-01T09:00:00Z");
    const newer=await preferenceNote(f,p.customer_id,"newer","2026-10-03T09:00:00Z");
    const query=f.ts.query.bind(f.ts);
    let intercept=true;
    f.ts.query=async(sql,params)=>{
      if(intercept && sql.startsWith("INSERT INTO assistant_preferences")) {
        intercept=false;
        await applyDemoWish(f.rt,f.ts,p.customer_id,newer,"newer-v1",demoWish("渋谷区"));
      }
      return query(sql,params);
    };
    const result=await applyDemoWish(f.rt,f.ts,p.customer_id,older,"older-v1",demoWish("新宿区"));
    assert.equal(result.applied,false);
    assert.equal(parse((await one(f.ts,"SELECT data FROM assistant_preferences WHERE customer_id=?",[p.customer_id])).data).area,"渋谷区");
    const history=await applyDemoWish(f.rt,f.ts,p.customer_id,older,"older-v1",demoWish("品川区"));
    assert.equal(history.applied,false);
    assert.equal((await one(f.ts,"SELECT version FROM assistant_preferences WHERE customer_id=?",[p.customer_id])).version,1);
    await f.ts.query("UPDATE context_notes SET deleted_at=? WHERE id='newer-v1'",[now()]);
    assert.equal((await applyDemoWish(f.rt,f.ts,p.customer_id,older,"older-v1",demoWish("新宿区"))).applied,false,"editing the latest note must not reopen an older write");
  } finally { await f.dispose(); }
});

test("self demo: inherited wishes keep evidence and do not reuse changed or deleted note values", async () => {
  const f=await fixture();
  try {
    const p=await f.pair();
    const first=await preferenceNote(f,p.customer_id,"first","2026-10-01T09:00:00Z");
    const second=await preferenceNote(f,p.customer_id,"second","2026-10-02T09:00:00Z");
    const third=await preferenceNote(f,p.customer_id,"third","2026-10-03T09:00:00Z");
    await applyDemoWish(f.rt,f.ts,p.customer_id,first,"first-v1",demoWish("渋谷区"));
    const applied=await applyDemoWish(f.rt,f.ts,p.customer_id,second,"second-v1",demoWish(null,60000000));
    assert.equal(applied.applied,true);
    let pref=await one(f.ts,"SELECT data FROM assistant_preferences WHERE customer_id=?",[p.customer_id]);
    assert.equal(parse(pref.data).area,"渋谷区");
    assert.equal(parse(pref.data).inheritedNotes[0].id,"first-v1");
    await f.ts.query("UPDATE context_notes SET body='希望エリアを訂正しました' WHERE id='first-v1'");
    await assert.rejects(()=>applyDemoWish(f.rt,f.ts,p.customer_id,third,"third-v1",demoWish(null)),(e:any)=>e.code==='DEMO_WISH_INCOMPLETE');
    await f.ts.query("UPDATE context_notes SET deleted_at=? WHERE id='second-v1'",[now()]);
    await assert.rejects(()=>applyDemoWish(f.rt,f.ts,p.customer_id,second,"second-v2",demoWish(null)),(e:any)=>e.code==='DEMO_WISH_INCOMPLETE');
    pref=await one(f.ts,"SELECT note_id FROM assistant_preferences WHERE customer_id=?",[p.customer_id]);
    assert.equal(pref.note_id,"second-v1");
  } finally { await f.dispose(); }
});

test("self demo: simultaneous property edits reject the stale writer without losing the winner", async () => {
  const f=await fixture();
  try {
    await f.pair();
    const property={title:"渋谷の体験物件",area:"渋谷区",price:48000000,layout:"2LDK",walkingMinutes:5,status:"available"};
    const created=await f.request("/api/demo/properties",property);
    assert.equal(created.status,200);
    const sourceId=created.data.id;
    const query=f.ts.query.bind(f.ts);
    let readers=0, release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    f.ts.query=async(sql,params)=>{
      const result=await query(sql,params);
      if(sql==="SELECT data,version FROM assistant_sources WHERE id=?" && readers<2) {
        readers++;
        if(readers===2) release();
        await gate;
      }
      return result;
    };
    const edits=[{...property,status:"sold",sourceId,version:1},{...property,price:49000000,sourceId,version:1}];
    const responses=await Promise.all(edits.map(edit=>f.request("/api/demo/properties",edit)));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const winner=edits[responses.findIndex(r=>r.status===200)];
    const stored=await one(f.ts,"SELECT * FROM assistant_sources WHERE id=?",[sourceId]);
    assert.equal(stored.version,2);
    assert.equal(parse(stored.data).status,winner.status);
    assert.equal(parse(stored.data).price,winner.price);
    assert.equal((await f.request("/api/demo/properties",edits[0])).status,409);
    assert.equal((await one(f.ts,"SELECT version FROM assistant_sources WHERE id=?",[sourceId])).version,2);
    let removed=false;
    f.ts.query=async(sql,params)=>{
      const result=await query(sql,params);
      if(!removed && sql==="SELECT data,version FROM assistant_sources WHERE id=?") {
        removed=true;
        await query("DELETE FROM assistant_sources WHERE id=?",[sourceId]);
      }
      return result;
    };
    assert.equal((await f.request("/api/demo/properties",{...property,sourceId,version:2,price:50000000})).status,409);
    assert.equal(await one(f.ts,"SELECT id FROM assistant_sources WHERE id=?",[sourceId]),null,"do not recreate a source removed after reading it");
  } finally {await f.dispose();}
});

test("self demo: failed extraction is retained for free revalidation and invalidated on document edit", async () => {
  const f=await fixture();
  try {
    await f.pair();
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    const base=f.rt.externalFetch;
    let extractions=0;
    f.rt.externalFetch=async(input,init)=>{
      const body=init?.body ? JSON.parse(String(init.body)) : null;
      if(body?.text?.format?.name==='meeting_extract') {
        extractions++;
        const transcript=JSON.parse(body.input).transcript;
        return Response.json({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:json({summary:'希望条件を確認しました。',dealState:'uncontracted',stage:'post_meeting',keyPoints:[],concerns:[],interests:[],nextAction:'条件に合う物件を確認する',triggers:[],tracking:{conditionQuote:transcript,terms:['新宿区'],timings:[],propertyWish:{area:'新宿区',maxPrice:58000000,required:['3LDK','所有権'],excluded:[],quote:transcript}}})}]}]});
      }
      return base(input,init);
    };
    const body='新宿区、3LDK、所有権、物件価格5,500万円以内を希望します。';
    const added=await f.request('/api/demo/documents',{title:'根拠の確認テスト',body,heldAt:now()});
    const path=`/api/demo/documents/${added.data.id}`;
    await f.request(path+'/link',{version:1});
    let doc=await one(f.rt.db,'SELECT * FROM gs_demo_documents WHERE id=?',[added.data.id]);
    assert.equal(doc.state,'error');
    assert.match(doc.error,/上限予算/);
    assert.equal(parse(doc.analysis).extractVersion,1);
    assert.equal(parse(doc.analysis).extraction.tracking.propertyWish.maxPrice,58000000);
    await f.request(path+'/link',{version:1});
    assert.equal(extractions,1,'validation retry reuses the exact extraction');
    assert.equal((await one(f.rt.db,"SELECT COUNT(*) AS n FROM gs_demo_actions WHERE kind='ai' AND user_id='guest'")).n,1);
    await f.request(path+'/link',{version:1,reextract:true});
    assert.equal(extractions,2,'the user can explicitly request fresh AI output without editing the source');
    await f.request(path,{title:'根拠の確認テスト',body:body.replace('5,500','5,800'),heldAt:doc.held_at,version:1},'guest','PUT');
    doc=await one(f.rt.db,'SELECT * FROM gs_demo_documents WHERE id=?',[added.data.id]);
    assert.equal(extractions,3,'changed text requires fresh extraction');
    assert.equal(doc.version,2);
    assert.equal(doc.state,'ready',doc.error);
  } finally {await f.dispose();}
});


test("self demo: a blocked AI draft can recover, does not block a new property, and retries enforce owner/version", async () => {
  const f=await fixture();
  try {
    const p=await f.pair();
    f.rt.ai={apiKey:"fixture",model:"fixture"};
    const doc=await preferenceNote(f,p.customer_id,"current",now());
    await applyDemoWish(f.rt,f.ts,p.customer_id,doc,"current-v1",{...demoWish("渋谷区",55000000),required:["2LDK","所有権","駅徒歩10分以内"],excluded:["定期借地権"]});
    const fetch=f.rt.externalFetch;
    let omitQuote=true;
    f.rt.externalFetch=async(u,init)=>{
      const response=await fetch(u,init);
      if(String(u).includes("api.openai.com")) {
        const result=await response.json() as any;
        const output=JSON.parse(result.output[0].content[0].text);
        if(omitQuote) output.facts=output.facts.filter((x:any)=>x.ref.startsWith("source:"));
        result.output[0].content[0].text=json(output);
        return Response.json(result);
      }
      return response;
    };
    const body={title:"渋谷テスト物件",area:"渋谷区",price:49000000,layout:"2LDK",walkingMinutes:5};
    assert.equal((await f.request("/api/demo/properties",body)).status,200);
    let q=await one(f.ts,"SELECT * FROM proposals WHERE customer_id=?",[p.customer_id]);
    assert.equal(q.state,"held");
    assert.match(q.hold_reason,/現在の顧客条件/);
    const snapshot=(await f.request("/api/demo")).data;
    assert.equal(snapshot.proposals[0].state,"held");
    await startDemo(f.rt,{id:"other-guest",name:"Other"});
    await f.rt.db.query("UPDATE gs_demo_participants SET customer_line_id='other-line' WHERE user_id='other-guest'");
    assert.equal((await f.request(`/api/demo/proposals/${q.id}/generate`,{version:q.version},"other-guest")).status,404);
    assert.equal((await f.request(`/api/demo/proposals/${q.id}/generate`,{version:1})).status,409);
    omitQuote=false;
    const recovered=await f.request(`/api/demo/proposals/${q.id}/generate`,{version:q.version});
    assert.equal(recovered.data.state,"generated",json(recovered.data));
    assert.equal((await f.request(`/api/demo/proposals/${q.id}/generate`,{version:q.version})).status,409);
    q=await one(f.ts,"SELECT * FROM proposals WHERE id=?",[q.id]);
    assert.equal(q.state,"pending");
    assert.ok(q.draft.includes("/demo/book/"));
    assert.equal((await one(f.h,"SELECT COUNT(*) n FROM outbox")).n,0,"generation must not send a customer message");
    // The original stall affected customers with a follow-up profile.
    const note=await one(f.ts,"SELECT id,customer_id,body,confirmed_by,confirmed_at,source,source_ref FROM context_notes WHERE id='current-v1'");
    await f.ts.query("INSERT INTO followup_profiles(customer_id,owner_user_id,line_user_id,data,evidence,confirmed_by,updated_at) VALUES (?,'guest',?,?,?,'guest',?)",[p.customer_id,line,
      json({industry:"estate",enabled:true,conditionQuote:note.body,terms:[],stalledQuote:"",promiseQuote:"",promiseAt:null,phase:"considering",waitDays:3}),json({kind:"note",id:note.id,body:note.body,hash:await digest(json(note))}),now()]);
    await f.ts.query("UPDATE proposals SET state='held' WHERE id=?",[q.id]);
    await f.ts.query("UPDATE assistant_proposals SET evidence=json_set(evidence,'$.draftMode','blocked','$.followupVersion',1) WHERE proposal_id=?",[q.id]);
    assert.equal((await f.request("/api/demo/properties",{...body,title:"渋谷テスト物件2"})).status,200);
    assert.equal((await one(f.ts,"SELECT COUNT(*) n FROM proposals WHERE customer_id=?",[p.customer_id])).n,2,"new source is not blocked by an AI rejection");
    assert.equal((await one(f.ts,"SELECT state FROM proposals WHERE customer_id=? AND id<>?",[p.customer_id,q.id])).state,"pending");
    assert.equal((await scanAssistant(f.rt,"t","oa","guest",undefined,[p.customer_id],{generateDraft:true})).created,0,"polling must not regenerate or notify the same update");

  } finally {await f.dispose();}
});


test("self demo: ambiguous current changes preserve values and block discovery/approval until resolved", async () => {
  const f=await fixture();
  try {
    const p=await f.pair();
    const first=await preferenceNote(f,p.customer_id,"prior","2026-10-01T09:00:00Z");
    await applyDemoWish(f.rt,f.ts,p.customer_id,first,"prior-v1",demoWish("新宿区"));
    const before=await one(f.ts,"SELECT * FROM assistant_preferences WHERE customer_id=?",[p.customer_id]);
    await f.request("/api/demo/properties",{title:"新宿のテスト物件",area:"新宿区",price:48000000,layout:"2LDK",walkingMinutes:5});
    const proposal=await one(f.ts,"SELECT * FROM proposals WHERE customer_id=?",[p.customer_id]);
    assert.equal(proposal.state,"pending");

    const ambiguous=await preferenceNote(f,p.customer_id,"ambiguous","2026-10-02T09:00:00Z");
    await f.rt.db.query("UPDATE gs_demo_documents SET state='error',analysis=? WHERE id=?",[json({extraction:{tracking:{reviewReason:"渋谷への変更は未定です"}}}),ambiguous.id]);
    assert.ok((await pendingDemoMeetings(f.rt,"t","oa",[p.customer_id])).has(p.customer_id));
    const approval=await f.request(`/api/demo/proposals/${proposal.id}/action`,{version:proposal.version,action:"approve"});
    assert.equal(approval.status,409);
    assert.match(approval.data.message,/新しい議事録の条件/);
    assert.equal((await one(f.h,"SELECT COUNT(*) n FROM outbox")).n,0);

    assert.equal((await scanAssistant(f.rt,"t","oa","guest",undefined,[p.customer_id])).created,0);
    assert.deepEqual(await one(f.ts,"SELECT * FROM assistant_preferences WHERE customer_id=?",[p.customer_id]),before);
    const resolved=await preferenceNote(f,p.customer_id,"resolved","2026-10-03T09:00:00Z");
    await applyDemoWish(f.rt,f.ts,p.customer_id,resolved,"resolved-v1",demoWish("渋谷区"));
    assert.equal((await pendingDemoMeetings(f.rt,"t","oa",[p.customer_id])).size,0,"older unresolved history does not override a newer confirmed meeting");
  } finally {await f.dispose();}
});


test("self demo: property save alone repairs one invalid AI attempt and sends exactly one staff notice without customer delivery", async () => {
  const f = await fixture();
  try {
    const p = await f.pair();
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    f.rt.assistantLine = { destination: staffDestination, token: "fixture", secret: "fixture", enabled: true };
    await f.rt.db.query("INSERT INTO staff_line_links(tenant_id,user_id,destination,line_user_id,state,notifications,updated_at) VALUES ('t','guest',?,'staff-test','active',1,?)", [staffDestination, now()]);
    await f.rt.db.query("UPDATE gs_demo_participants SET notifications_until=? WHERE user_id='guest'", [new Date(Date.now() + 3600000).toISOString()]);
    const doc = await preferenceNote(f, p.customer_id, "minato-current", now());
    await applyDemoWish(f.rt, f.ts, p.customer_id, doc, "minato-current-v1", { ...demoWish("港区", 100000000), required: ["4LDK", "所有権", "駅徒歩5分以内"], excluded: ["定期借地権"] });
    const fetch = f.rt.externalFetch;
    let attempts = 0;
    f.rt.externalFetch = async (u, init) => {
      const res = await fetch(u, init);
      if (!String(u).includes("api.openai.com")) return res;
      attempts++;
      const data: any = await res.json();
      const out = JSON.parse(data.output[0].content[0].text);
      if (attempts === 1) out.draft += "根拠のない面積87654321平方メートル。";
      else out.draft += "港区、9,900万円、4LDK、所有権、駅徒歩2分です。";
      data.output[0].content[0].text = json(out);
      return Response.json(data);
    };
    const added = await f.request("/api/demo/properties", { title: "港区の自動通知テスト", area: "港区", price: 99000000, layout: "4LDK", walkingMinutes: 2 });
    assert.equal(added.status, 200, json(added.data));
    assert.equal(attempts, 2);
    const q = await one(f.ts, "SELECT p.*,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE customer_id=?", [p.customer_id]);
    assert.equal(q.state, "pending", q.hold_reason);
    assert.equal(parse(q.evidence).draftMode, "generated");
    assert.match(q.draft, /9,900万円/);
    assert.equal((await one(f.rt.db, "SELECT COUNT(*) n FROM staff_line_notices WHERE proposal_id=? AND state='sent'", [q.id])).n, 1);
    await scanAssistant(f.rt, "t", "oa", "guest", undefined, [p.customer_id], { generateDraft: true });
    const { notifyAssistant } = await import("../backend/assistant-notifications.ts");
    await notifyAssistant(f.rt, "t", "oa");
    assert.equal(attempts, 2);
    assert.equal(f.calls.filter(c => c.url.endsWith("/push")).length, 1);
    assert.equal((await one(f.h, "SELECT COUNT(*) n FROM outbox")).n, 0);
  } finally { await f.dispose(); }
});

test('showcase draft handoff sends only to authenticated tester; retries, recipient injection and revocation cannot send again',async()=>{
 const f=await fixture();
 try{
  const p=await f.pair();
  await f.rt.db.query("UPDATE accounts SET channel_id='123456',destination=? WHERE id='oa'",[destination]);
  const pushes:any[]=[];
  f.rt.customerTestDelivery=customerTestDelivery({tenant:'t',oa:'oa',enabled:true,selfDemo:true,channelId:'123456',destination,staffDestination,token:'fixture',lineUserIds:[]},async(input,init)=>{
   if(String(input).endsWith('/info'))return Response.json({userId:destination});
   pushes.push(JSON.parse(String(init?.body)));return Response.json({sentMessages:[{id:'fixture-message'}]});
  });
  const path='/api/demo/showcase/send',draft={requestId:crypto.randomUUID(),text:'操作デモで編集した架空の物件案内です。'};
  assert.equal((await f.request(path,{...draft,to:'other-line'})).status,400);
  assert.equal((await f.request(path,draft,'second')).status,403);
  assert.equal((await f.request(path,draft)).status,200);
  assert.deepEqual(pushes,[{to:line,messages:[{type:'text',text:draft.text}]}]);
  assert.equal((await f.request(path,draft)).status,200);
  assert.equal(pushes.length,1);
  assert.equal((await f.request(path,{...draft,text:'差し替え'})).status,409);
  await f.common.query('UPDATE customers SET opt_out=1 WHERE id=?',[p.customer_id]);
  assert.equal((await f.request(path,{...draft,requestId:crypto.randomUUID()})).status,409);
  assert.equal(pushes.length,1);
  await f.rt.db.query("UPDATE gs_demo_participants SET state='ended' WHERE user_id='guest'");
  assert.equal((await f.request(path,{...draft,requestId:crypto.randomUUID()})).status,403);
 }finally{await f.dispose()}
});
test('showcase draft double-click is atomic and uncertain LINE response is not resent',async()=>{
 const f=await fixture();
 try{
  await f.pair();await f.rt.db.query("UPDATE accounts SET channel_id='123456',destination=? WHERE id='oa'",[destination]);
  let pushes=0;
  f.rt.customerTestDelivery=customerTestDelivery({tenant:'t',oa:'oa',enabled:true,selfDemo:true,channelId:'123456',destination,staffDestination,token:'fixture',lineUserIds:[]},async input=>{if(String(input).endsWith('/info'))return Response.json({userId:destination});pushes++;throw Error('simulated connection loss');});
  const draft={requestId:crypto.randomUUID(),text:'重複検証用'};
  const results=await Promise.all([f.request('/api/demo/showcase/send',draft),f.request('/api/demo/showcase/send',draft)]);
  assert.ok(results.every(r=>r.status>=400));assert.equal(pushes,1);
  assert.equal((await f.request('/api/demo/showcase/send',draft)).status,409);assert.equal(pushes,1);
 }finally{await f.dispose()}
});
