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
} from "../backend/self-demo-access.ts";
import {
  demoBookingView,
  saveDemoBooking,
  receiveDemoTimeRex,
  reconcileDemoBookings,
} from "../backend/self-demo-booking.ts";
import { authOptions } from "../backend/auth.ts";
import { one, all, now, json } from "../backend/db.ts";
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
