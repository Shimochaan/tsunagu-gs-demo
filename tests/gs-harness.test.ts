import test from "node:test";
import assert from "node:assert/strict";
import { LocalStore } from "../backend/local.ts";
import {
  gsHarnessFetch,
  gsHarnessDDL,
  type GsHarnessConfig,
} from "../backend/gs-harness.ts";
import integration from "../backend/gs-integration-worker.ts";
import { sign } from "../backend/security.ts";
import { assistantFixture } from "./helpers/assistant-fixture.ts";
import { syncConversation } from "../backend/harness.ts";
import { one } from "../backend/db.ts";
const user = "U" + "a".repeat(32),
  dest = "U" + "b".repeat(32);
const cfg: GsHarnessConfig = {
  enabled: true,
  accountId: "gs-line",
  channelId: "12345",
  destination: dest,
  apiToken: "fixture-only-api-token-32-characters",
  channelSecret: "fixture-only-channel-secret",
};
async function fixture() {
  const db = new LocalStore(":memory:");
  for (const sql of gsHarnessDDL) await db.query(sql);
  return db;
}
async function event(
  db: LocalStore,
  overrides: Record<string, unknown> = {},
  destination = dest,
  signature?: string,
) {
  const raw = JSON.stringify({
    destination,
    events: [
      {
        webhookEventId: "event-1",
        type: "message",
        timestamp: 1000,
        source: { type: "user", userId: user },
        message: { id: "message-1", type: "text", text: "fixture incoming" },
        ...overrides,
      },
    ],
  });
  return gsHarnessFetch(
    new Request("https://gs.test/webhooks/line", {
      method: "POST",
      body: raw,
      headers: {
        "x-line-signature": signature ?? (await sign(cfg.channelSecret!, raw)),
      },
    }),
    db,
    cfg,
  );
}
const read = (db: LocalStore, path: string, token = cfg.apiToken) =>
  gsHarnessFetch(
    new Request("https://gs.test" + path, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    db,
    cfg,
  );
test("both closed workers reject every endpoint without configuration or enabling flags", async () => {
  const db = await fixture();
  try {
    for (const path of [
      "/",
      "/api/health",
      "/api/me",
      "/api/line-accounts",
      "/api/friends",
      "/webhooks/line",
    ])
      for (const method of ["GET", "POST"]) {
        const req = new Request("https://gs.test" + path, { method });
        assert.equal(
          (await gsHarnessFetch(req, db, { ...cfg, enabled: false })).status,
          503,
        );
        assert.equal(
          (await gsHarnessFetch(req, db, { ...cfg, apiToken: undefined }))
            .status,
          503,
        );
        assert.equal((await integration.fetch(req, {} as any)).status, 503);
      }
    assert.equal(
      (await one(db, "SELECT COUNT(*) AS n FROM gs_line_events")).n,
      0,
    );
  } finally {
    db.close();
  }
});
test("receive-only Harness verifies signature/account, deduplicates events and has no send/admin routes", async () => {
  const db = await fixture();
  try {
    assert.equal((await event(db, {}, dest, "bad")).status, 401);
    assert.equal((await event(db, {}, user)).status, 403);
    assert.equal((await read(db, "/api/line-accounts", "wrong")).status, 401);
    assert.equal(
      (await read(db, "/api/friends?lineAccountId=other")).status,
      403,
    );
    const receipts = await Promise.all([event(db), event(db)]);
    assert.ok(receipts.every((r) => r.status === 200));
    assert.equal(
      (await one(db, "SELECT COUNT(*) AS n FROM gs_line_messages")).n,
      1,
    );
    const friends: any = await (
      await read(db, "/api/friends?lineAccountId=gs-line")
    ).json();
    const id = friends.data.items[0].id;
    const messages: any = await (
      await read(db, `/api/friends/${id}/messages`)
    ).json();
    assert.equal(messages.data[0].content, "fixture incoming");
    assert.equal(messages.data[0].direction, "incoming");
    assert.equal((await read(db, "/api/friends/missing/messages")).status, 404);
    assert.equal(
      (
        await event(db, {
          message: { id: "message-1", type: "text", text: "conflicting event" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await gsHarnessFetch(
          new Request("https://gs.test/api/messages", {
            method: "POST",
            headers: { Authorization: `Bearer ${cfg.apiToken}` },
            body: "{}",
          }),
          db,
          cfg,
        )
      ).status,
      405,
    );
    assert.equal((await read(db, "/api/admin")).status, 404);
    assert.equal(
      (
        await event(db, {
          webhookEventId: "unfollow",
          type: "unfollow",
          timestamp: 3000,
          message: undefined,
        })
      ).status,
      200,
    );
    await event(db, {
      webhookEventId: "old-follow",
      type: "follow",
      timestamp: 2000,
      message: undefined,
    });
    const friend: any = await (await read(db, `/api/friends/${id}`)).json();
    assert.equal(friend.data.isFollowing, false);
  } finally {
    db.close();
  }
});
test("dedicated Harness contract feeds existing syncConversation without LINE outbound calls", async () => {
  const f = await assistantFixture(),
    db = await fixture();
  try {
    await event(db);
    f.rt.externalFetch = (input, init) =>
      gsHarnessFetch(new Request(input, init), db, cfg);
    const items: any = await (
      await read(db, "/api/friends?lineAccountId=gs-line")
    ).json();
    const credential = {
      origin: "https://tsunagu-gs-harness.test.workers.dev",
      apiKey: cfg.apiToken,
      accountId: cfg.accountId,
    };
    const oa = await one(f.rt.db, "SELECT * FROM accounts WHERE id='oa'");
    const first = await syncConversation(
      f.rt,
      "t",
      oa,
      credential,
      items.data.items[0].id,
    );
    const repeat = await syncConversation(
      f.rt,
      "t",
      oa,
      credential,
      items.data.items[0].id,
    );
    assert.equal(first.inserted, 1);
    assert.equal(repeat.inserted, 0);
    assert.equal(
      (
        await one(f.h, "SELECT body FROM messages WHERE external_id=?", [
          "harness:message-1",
        ])
      ).body,
      "fixture incoming",
    );
  } finally {
    db.close();
    await f.dispose();
  }
});

test("read-only connector omits forwarding secret; ordinary connector still requires it", async () => {
  const { registerHarness } = await import("../backend/harness.ts");
  const f = await assistantFixture(),
    db = await fixture();
  try {
    registerHarness(f.app);
    await f.rt.db.query("UPDATE accounts SET channel_id='12345' WHERE id='oa'");
    f.rt.externalFetch = (input, init) =>
      gsHarnessFetch(new Request(input, init), db, cfg);
    const body = {
      origin: "https://tsunagu-gs-harness.test.workers.dev",
      apiKey: cfg.apiToken,
      accountId: cfg.accountId,
    };
    const path = "/api/tenants/t/accounts/oa/harness";
    const ordinary = await f.request(path, body);
    assert.notEqual(ordinary.status, 200);
    f.rt.harnessReadOnly = true;
    f.rt.deliveryEnabled = false;
    const connected = await f.request(path, body);
    assert.equal(connected.status, 200);
    assert.equal(connected.data.webhookURL, null);
    assert.equal(
      await one(
        f.rt.db,
        "SELECT id FROM credentials WHERE service='harness_events'",
      ),
      null,
    );
    f.rt.deliveryEnabled = true;
    assert.equal((await f.request(path, body)).status, 409);
    f.rt.harnessReadOnly = false;
    assert.equal(
      (
        await f.request(path, {
          ...body,
          webhookSecret: "fixture-forward-secret-32-characters",
        })
      ).status,
      200,
    );
    assert.ok(
      await one(
        f.rt.db,
        "SELECT id FROM credentials WHERE service='harness_events'",
      ),
    );
  } finally {
    db.close();
    await f.dispose();
  }
});

test("read-only connector bootstraps channel without LINE token and refuses relinking, duplicates and foreign actors", async () => {
  const { registerHarness } = await import("../backend/harness.ts");
  const f = await assistantFixture(),
    db = await fixture();
  try {
    registerHarness(f.app);
    f.rt.harnessReadOnly = true;
    f.rt.deliveryEnabled = false;
    let reads = 0;
    f.rt.externalFetch = (input, init) => {
      reads++;
      return gsHarnessFetch(new Request(input, init), db, cfg);
    };
    const path = "/api/tenants/t/accounts/oa/harness";
    const body = {
      origin: "https://tsunagu-gs-harness.test.workers.dev",
      apiKey: cfg.apiToken,
      accountId: cfg.accountId,
      channelId: "12345",
    };
    assert.equal(
      (await f.request(path, body, "POST", "other-owner")).status,
      403,
    );
    assert.equal((await f.request(path, body, "POST", "stranger")).status, 403);
    assert.equal(reads, 0);
    assert.equal(
      (await f.request(path, { ...body, channelId: "98765" })).data.error,
      "HARNESS_ACCOUNT_MISMATCH",
    );
    assert.equal(
      (await one(f.rt.db, "SELECT channel_id FROM accounts WHERE id='oa'"))
        ?.channel_id,
      null,
    );
    await f.rt.db.query(
      "UPDATE accounts SET channel_id='12345' WHERE id='other-oa'",
    );
    assert.equal(
      (await f.request(path, body)).data.error,
      "HARNESS_CHANNEL_CONFLICT",
    );
    await f.rt.db.query(
      "UPDATE accounts SET channel_id=NULL WHERE id='other-oa'",
    );
    for (let i = 0; i < 2; i++)
      assert.equal((await f.request(path, body)).status, 200);
    assert.equal(
      (await one(f.rt.db, "SELECT channel_id FROM accounts WHERE id='oa'"))
        ?.channel_id,
      "12345",
    );
    assert.equal(
      (await f.request(path, { ...body, channelId: "98765" })).data.error,
      "HARNESS_CHANNEL_PINNED",
    );
    assert.equal(
      await one(f.rt.db, "SELECT id FROM credentials WHERE service='line'"),
      null,
    );
    f.rt.harnessReadOnly = false;
    assert.notEqual(
      (
        await f.request(path, {
          ...body,
          webhookSecret: "fixture-forward-secret-32-characters",
        })
      ).status,
      200,
    );
  } finally {
    db.close();
    await f.dispose();
  }
});

test("Harness pins authenticated OA identity so config changes cannot relabel stored conversations", async () => {
  const db = await fixture();
  try {
    await read(db, "/api/line-accounts", "wrong");
    assert.equal(await one(db, "SELECT * FROM gs_line_scope"), null);
    await event(db);
    for (const change of [
      { accountId: "other-account" },
      { channelId: "98765" },
      { destination: user },
    ]) {
      const response = await gsHarnessFetch(
        new Request("https://gs.test/api/line-accounts", {
          headers: { Authorization: `Bearer ${cfg.apiToken}` },
        }),
        db,
        { ...cfg, ...change },
      );
      assert.equal(response.status, 409);
      assert.equal(
        ((await response.json()) as any).error,
        "HARNESS_SCOPE_CHANGED",
      );
    }
    assert.equal((await read(db, "/api/line-accounts")).status, 200);
    assert.equal(
      (await one(db, "SELECT COUNT(*) AS n FROM gs_line_messages")).n,
      1,
    );
  } finally {
    db.close();
  }
});
