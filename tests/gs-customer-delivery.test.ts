import test from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./helpers/assistant-fixture.ts";
import { isolatedIntegrationRuntime } from "../backend/gs-integration.ts";
import {
  approveAssistant,
  scanAssistant,
  decideAssistant,
  editAssistant,
} from "../backend/assistant.ts";
import { sendDue } from "../backend/delivery.ts";
import { all, one, now } from "../backend/db.ts";

const customerBot = "U" + "a".repeat(32),
  staffBot = "U" + "b".repeat(32);
const ids = Object.fromEntries(
  ["c", "c2", "c3", "c4", "c5", "c6"].map((c, i) => [
    c,
    "U" + (i + 1).toString(16).padStart(32, "0"),
  ]),
);
const base = "/api/tenants/t/accounts/oa/assistant/customer-delivery";
async function fixture(enabled = true, users = Object.values(ids)) {
  const f = await assistantFixture();
  for (const cid of ["c5", "c6"]) {
    await f.common.query(
      "INSERT INTO customers(id,name,owner_user_id,created_at) VALUES (?,?,'owner',?)",
      [cid, cid, now()],
    );
    await f.common.query(
      "INSERT INTO customer_links(oa_id,line_user_id,customer_id) VALUES ('oa',?,?)",
      [ids[cid], cid],
    );
    await f.common.query(
      "INSERT INTO external_links(oa_id,service,external_id,customer_id,line_user_id) VALUES ('oa','harness',?,?,?)",
      [`friend-${cid}`, cid, ids[cid]],
    );
  }
  for (const [cid, line] of Object.entries(ids)) {
    await f.common.query(
      "UPDATE customer_links SET line_user_id=? WHERE customer_id=?",
      [line, cid],
    );
    await f.common.query(
      "UPDATE external_links SET line_user_id=? WHERE customer_id=?",
      [line, cid],
    );
  }
  await f.rt.db.query(
    "UPDATE accounts SET channel_id='12345',state='credentials' WHERE id='oa'",
  );
  let botId = customerBot,
    wrongFriend = false,
    failPush = false;
  let onBot: (() => Promise<void>) | undefined;
  const calls: {
    url: string;
    method: string;
    body: any;
    retry: string | null;
  }[] = [];
  f.rt.externalFetch = async (input, init) => {
    const r = new Request(input, init),
      u = new URL(r.url),
      body = r.method === "POST" ? await r.json() : null;
    calls.push({
      url: r.url,
      method: r.method,
      body,
      retry: r.headers.get("X-Line-Retry-Key"),
    });
    if (u.origin === "https://tsunagu-gs-harness.test.workers.dev") {
      assert.equal(r.method, "GET");
      if (u.pathname === "/api/line-accounts")
        return Response.json({
          success: true,
          data: [{ id: "account", channelId: "12345", isActive: true }],
        });
      if (u.pathname.endsWith("/messages"))
        return Response.json({ success: true, data: [] });
      const fid = u.pathname.split("/").at(-1)!,
        cid = fid.replace("friend-", "");
      return Response.json({
        success: true,
        data: {
          id: fid,
          lineUserId: wrongFriend ? "U" + "f".repeat(32) : ids[cid],
          displayName: cid,
          lineAccountId: "account",
          isFollowing: true,
        },
      });
    }
    assert.equal(
      r.headers.get("Authorization"),
      "Bearer fixture-customer-token",
    );
    if (u.pathname === "/v2/bot/info") {
      await onBot?.();
      return Response.json({ userId: botId });
    }
    assert.equal(u.pathname, "/v2/bot/message/push");
    assert.match(r.headers.get("X-Line-Retry-Key")!, /^[0-9a-f-]{36}$/);
    if (failPush) throw Error("fixture lost LINE response");
    return Response.json({ sentMessages: [{ id: "fixture-message" }] });
  };
  const scope = {
    tenant: "t",
    oa: "oa",
    common: f.common,
    harness: f.h,
    tsunagu: f.ts,
    harnessOrigin: "https://tsunagu-gs-harness.test.workers.dev",
    allowCustomerDelivery: enabled,
    customerLineChannelId: "12345",
    customerLineDestination: customerBot,
    staffLineDestination: staffBot,
    customerLineToken: "fixture-customer-token",
    customerLineTestUsers: users,
  };
  // Replace the fixture's pre-existing Harness credential, never a real credential.
  const { putCredential } = await import("../backend/credentials.ts");
  await putCredential(
    f.rt,
    "t",
    "oa",
    "harness",
    {
      origin: scope.harnessOrigin,
      apiKey: "fixture-read-only",
      accountId: "account",
    },
    "owner",
  );
  Object.assign(f.rt, isolatedIntegrationRuntime(f.rt, scope));
  const verify = async () => {
    const r = await f.request(base + "/verify", {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  const proposal = async (cid = "c") => {
    await f.message(cid, "金利について次の相談をお願いします。");
    await f.h.query("UPDATE messages SET line_user_id=? WHERE customer_id=?", [
      ids[cid],
      cid,
    ]);
    await scanAssistant(f.rt, "t", "oa", "owner", undefined, [cid], {
      allowAutoAI: false,
    });
    return (await one(
      f.ts,
      "SELECT * FROM proposals WHERE customer_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1",
      [cid],
    ))!;
  };
  return {
    ...f,
    verify,
    proposal,
    network: calls,
    pushes: () => calls.filter((c) => c.url.endsWith("/message/push")),
    botMismatch: () => {
      botId = staffBot;
    },
    wrongFriend: () => {
      wrongFriend = true;
    },
    failPush: () => {
      failPush = true;
    },
    onBot: (fn: () => Promise<void>) => {
      onBot = fn;
    },
  };
}

test("customer test setup: stopped by default, empty allowlist closed, owner-only verification sends nothing", async () => {
  const f = await fixture(false);
  try {
    assert.equal(f.rt.deliveryEnabled, false);
    assert.equal((await f.request(base)).data.configured, true);
    assert.equal(
      (await f.request(base + "/verify", {}, "POST", "stranger")).status,
      403,
    );
    assert.equal(
      (await f.request(base + "/verify", {}, "POST", "other-owner")).status,
      403,
    );
    assert.equal(f.network.length, 0);
    await f.verify();
    assert.equal(f.pushes().length, 0);
    const p = await f.proposal();
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, p.version);
    await sendDue(f.rt, "t", "oa", `${p.id}:${p.version}`);
    assert.equal(f.pushes().length, 0);
    await assert.rejects(
      f.rt.externalFetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        body: "{}",
      }),
    );
  } finally {
    await f.dispose();
  }
  const empty = await fixture(true, []);
  try {
    assert.equal(empty.rt.deliveryEnabled, false);
    assert.equal((await empty.request(base + "/verify", {})).status, 409);
    assert.equal(empty.network.length, 0);
  } finally {
    await empty.dispose();
  }
});
test("customer test: approved frozen text is delivered once; parallel/repeated approval cannot duplicate", async () => {
  const f = await fixture();
  try {
    await f.verify();
    const p = await f.proposal();
    assert.ok(p);
    await Promise.allSettled([
      approveAssistant(f.rt, "t", "oa", "owner", p.id, 1),
      approveAssistant(f.rt, "t", "oa", "owner", p.id, 1),
    ]);
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 1);
    assert.equal(f.pushes().length, 1);
    assert.deepEqual(f.pushes()[0].body, {
      to: ids.c,
      messages: [{ type: "text", text: p.draft }],
    });
    assert.equal(
      (await one(f.h, "SELECT state FROM outbox WHERE proposal_id=?", [p.id]))
        ?.state,
      "sent",
    );
    assert.equal(
      (await one(f.ts, "SELECT state FROM proposals WHERE id=?", [p.id]))
        ?.state,
      "sent",
    );
    assert.equal(
      (
        await one(
          f.rt.db,
          "SELECT provider FROM usage_events WHERE kind='message'",
        )
      )?.provider,
      "line-test",
    );
  } finally {
    await f.dispose();
  }
});
test("customer test: explicit approval sends only that item; backlog and scheduled/bulk calls stay stopped", async () => {
  const f = await fixture();
  try {
    await f.verify();
    const old = await f.proposal("c"),
      next = await f.proposal("c2");
    f.rt.deliveryEnabled = false;
    await approveAssistant(f.rt, "t", "oa", "owner", old.id, 1);
    f.rt.deliveryEnabled = true;
    await sendDue(f.rt, "t", "oa");
    assert.equal(f.pushes().length, 0);
    await approveAssistant(f.rt, "t", "oa", "owner", next.id, 1);
    assert.equal(f.pushes().length, 1);
    assert.equal(f.pushes()[0].body.to, ids.c2);
    assert.equal(
      (await one(f.h, "SELECT state FROM outbox WHERE proposal_id=?", [old.id]))
        ?.state,
      "pending",
    );
  } finally {
    await f.dispose();
  }
});
test("customer test: cancellation, edits after approval and foreign tenant block delivery", async () => {
  const f = await fixture();
  try {
    await f.verify();
    const p = await f.proposal();
    f.rt.deliveryEnabled = false;
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 1);
    await editAssistant(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      1,
      "変更した文面です。最新の内容を確認してください。",
    );
    f.rt.deliveryEnabled = true;
    await assert.rejects(approveAssistant(f.rt, "t", "oa", "owner", p.id, 1));
    await decideAssistant(f.rt, "t", "oa", "owner", p.id, 2, "cancel");
    await assert.rejects(approveAssistant(f.rt, "t", "oa", "owner", p.id, 2));
    await assert.rejects(
      approveAssistant(f.rt, "other", "oa", "owner", p.id, 2),
    );
    await sendDue(f.rt, "t", "oa", `${p.id}:1`);
    assert.equal(f.pushes().length, 0);
  } finally {
    await f.dispose();
  }
});
test("customer test: wrong token bot, non-tester, changed friend and expired proposal send nothing", async () => {
  for (const mode of ["bot", "tester", "friend", "expiry"]) {
    const f = await fixture(
      true,
      mode === "tester" ? [ids.c2] : Object.values(ids),
    );
    try {
      await f.verify();
      const p = await f.proposal();
      if (mode === "bot") f.botMismatch();
      if (mode === "friend") f.wrongFriend();
      if (mode === "expiry")
        await f.ts.query(
          "UPDATE assistant_proposals SET expires_at=? WHERE proposal_id=?",
          [new Date(Date.now() - 1000).toISOString(), p.id],
        );
      await approveAssistant(f.rt, "t", "oa", "owner", p.id, 1).catch(() => {});
      assert.equal(f.pushes().length, 0, mode);
    } finally {
      await f.dispose();
    }
  }
});
test("customer test: opt-out or approval mutation during bot check is rechecked before any push", async () => {
  for (const mode of ["optout", "body", "permission"]) {
    const f = await fixture();
    try {
      await f.verify();
      const p = await f.proposal();
      f.onBot(async () => {
        if (mode === "optout")
          await f.common.query("UPDATE customers SET opt_out=1 WHERE id='c'");
        if (mode === "body")
          await f.h.query("UPDATE outbox SET body='[]' WHERE proposal_id=?", [
            p.id,
          ]);
        if (mode === "permission")
          await f.rt.db.query(
            "UPDATE memberships SET state='revoked' WHERE user_id='owner'",
          );
      });
      await approveAssistant(f.rt, "t", "oa", "owner", p.id, 1);
      assert.equal(f.pushes().length, 0, mode);
      assert.equal(
        (await one(f.h, "SELECT state FROM outbox WHERE proposal_id=?", [p.id]))
          ?.state,
        "held",
      );
    } finally {
      await f.dispose();
    }
  }
});
test("customer test: uncertain outcome consumes attempt and never retries", async () => {
  const f = await fixture();
  try {
    await f.verify();
    const p = await f.proposal();
    f.failPush();
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 1);
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 1);
    await sendDue(f.rt, "t", "oa", `${p.id}:1`);
    assert.equal(f.pushes().length, 1);
    assert.equal(
      (await one(f.h, "SELECT state FROM outbox"))?.state,
      "uncertain",
    );
    assert.equal(
      (await one(f.rt.db, "SELECT state FROM gs_customer_line_attempts"))
        ?.state,
      "uncertain",
    );
  } finally {
    await f.dispose();
  }
});
test("customer test: sixth daily attempt is held even with distinct approved proposals", async () => {
  const f = await fixture();
  try {
    await f.verify();
    const proposals = [];
    for (const cid of Object.keys(ids)) {
      const p = await f.proposal(cid);
      assert.ok(p, cid);
      proposals.push(p);
    }
    await Promise.allSettled(
      proposals.map((p) => approveAssistant(f.rt, "t", "oa", "owner", p.id, 1)),
    );
    assert.equal(f.pushes().length, 5);
    assert.equal(
      (await all(f.rt.db, "SELECT id FROM gs_customer_line_attempts")).length,
      5,
    );
    assert.equal(
      (
        await one(
          f.h,
          "SELECT COUNT(*) AS n FROM outbox WHERE error_code='CUSTOMER_TEST_LIMIT'",
        )
      )?.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});
