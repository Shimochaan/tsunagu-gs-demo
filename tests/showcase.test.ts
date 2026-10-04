import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LocalStore } from "../backend/local.ts";
import { makeAuth } from "../backend/auth.ts";
import {
  showcaseFetch,
  SHOWCASE_TENANT,
  SHOWCASE_OA,
} from "../backend/showcase.ts";
import { showcaseSeed } from "../backend/showcase-seed.ts";
import type { Runtime } from "../backend/runtime.ts";
const origin = "http://localhost:4219",
  base = `/api/tenants/${SHOWCASE_TENANT}`,
  oa = `${base}/accounts/${SHOWCASE_OA}`;
async function fixture() {
  const stores = {
    platform: new LocalStore(":memory:"),
    common: new LocalStore(":memory:"),
    harness: new LocalStore(":memory:"),
    studio: new LocalStore(":memory:"),
  };
  const ddl = (
    await readFile("backend/migrations/platform/0001_initial.sql", "utf8")
  ).match(
    /^CREATE TABLE "(?:account|user|session|verification|rateLimit)" .+;/gm,
  )!;
  for (const [key, qs] of Object.entries(showcaseSeed(ddl)))
    for (const q of qs)
      await stores[key as keyof typeof stores].query(q.sql, q.params);
  let externalCalls = 0;
  const blocked = async (): Promise<never> => {
    externalCalls++;
    throw Error("External I/O forbidden");
  };
  const rt: Runtime = {
    showcase: true,
    db: stores.platform,
    auth: makeAuth({
      database: stores.platform.native,
      db: stores.platform,
      origin,
      secret: "synthetic-showcase-test-secret-at-least-32-characters",
      publicShowcase: true,
      sendMail: blocked,
    }),
    origin,
    key: btoa("a".repeat(32)),
    keyVersion: "v1",
    local: true,
    googleEnabled: false,
    deliveryEnabled: false,
    provisioningEnabled: false,
    assistantManualOnly: true,
    assistantSimulation: true,
    mailMode: "unconfigured",
    externalFetch: blocked,
    sendMail: blocked,
    provisionDatabase: blocked,
    deployTenant: blocked,
    async openDatabase(t, a, p) {
      assert.equal(t, SHOWCASE_TENANT);
      if (p !== "common") assert.equal(a, SHOWCASE_OA);
      return p === "tsunagu" ? stores.studio : stores[p];
    },
  };
  let cookie = "";
  const call = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    customOrigin = origin,
  ) =>
    showcaseFetch(
      new Request(origin + path, {
        method,
        headers: {
          origin: customOrigin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      rt,
    );
  const login = async () => {
    const r = await call("/api/auth/sign-in/demo", {
      email: "demo@example.com",
    });
    assert.equal(r.status, 200, await r.clone().text());
    cookie = r.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
    assert.match(cookie, /session_token/);
    return r;
  };
  return {
    stores,
    rt,
    call,
    login,
    externalCalls: () => externalCalls,
    close: () => Object.values(stores).forEach((s) => s.close()),
  };
}
test("public showcase logs into real product screens, blocks writes and external I/O", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/api/me")).status, 401);
    assert.equal(
      (await f.call("/api/auth/sign-in/demo", { email: "someone@example.com" }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.call(
          "/api/auth/sign-in/demo",
          { email: "demo@example.com" },
          "POST",
          "https://other.example",
        )
      ).status,
      403,
    );
    const login = await f.login();
    assert.equal(((await login.json()) as any).token, undefined);
    const me: any = await (await f.call("/api/me")).json();
    assert.equal(me.user.email, "demo@example.com");
    assert.equal(me.home, "/tour");
    assert.equal(me.opsRole, "ops_owner");
    assert.equal(me.showcase, true);
    assert.equal(me.mfa, true);
    for (const route of [
      "/api/ops/overview",
      "/api/ops/tenants/" + SHOWCASE_TENANT,
      "/api/ops/jobs",
      "/api/ops/usage",
      "/api/ops/support",
      "/api/ops/audit",
      base + "/setup",
      base + "/my-accounts",
      base + "/connections",
      base + "/workspace?view=all",
      base + "/workspace?view=customers",
      base + "/workspace?view=meetings",
      base + "/workspace?view=dashboard",
      oa + "/assistant",
      oa + "/assistant/learning",
      oa + "/assistant/loop",
      oa + "/assistant/google",
      oa + "/style",
      oa + "/meeting-overview",
      oa + "/meeting-inbox",
      oa + "/connectors/recordings",
      oa + "/connectors/drive",
      oa + "/connectors/calendar",
      oa + "/customers/showcase-customer-1",
    ]) {
      const r = await f.call(route);
      assert.equal(r.status, 200, route + " " + (await r.clone().text()));
    }
    for (const route of [
      "/api/ops/tenants",
      base + "/settings",
      oa + "/proposals",
      oa + "/assistant/scan",
      oa + "/assistant/proposals/showcase-proposal/approve",
      oa + "/connectors/drive/authorize",
      "/future-mutating-endpoint",
    ])
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await f.call(route, {}, method);
        assert.equal(r.status, 403, route);
        assert.equal(((await r.json()) as any).error, "SHOWCASE_READ_ONLY");
      }
    assert.equal(
      (await f.call("/api/auth/sign-in/social", { provider: "google" })).status,
      404,
    );
    assert.equal((await f.call("/webhooks/line", {})).status, 404);
    assert.equal(
      (await f.call("/api/tenants/gs-integration/workspace")).status,
      403,
    );
    assert.equal(f.externalCalls(), 0);
    assert.equal(
      (await f.call("/api/session/tenant", { tenantId: SHOWCASE_TENANT }))
        .status,
      200,
    );
    assert.equal((await f.call("/api/auth/sign-out", {})).status, 200);
    assert.equal((await f.call("/api/me")).status, 401);
  } finally {
    f.close();
  }
});
test("demo login plugin is absent from normal production auth", async () => {
  const f = await fixture();
  try {
    const auth = makeAuth({
      database: f.stores.platform.native,
      db: f.stores.platform,
      origin,
      secret: "synthetic-normal-test-secret-at-least-32-characters",
      sendMail: async () => {},
    });
    const r = await auth.handler(
      new Request(origin + "/api/auth/sign-in/demo", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "demo@example.com" }),
      }),
    );
    assert.equal(r.status, 404);
  } finally {
    f.close();
  }
});

test("shared showcase visitors keep independent sessions when one logs out", async () => {
  const f = await fixture();
  try {
    const first = await f.login();
    const cookie = first.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    const second = await f.login();
    assert.notEqual(first.headers.get('set-cookie'), second.headers.get('set-cookie'));
    assert.equal((await f.call('/api/auth/sign-out', {})).status, 200);
    const stillSignedIn = await showcaseFetch(new Request(origin+'/api/me', {headers:{cookie}}), f.rt);
    assert.equal(stillSignedIn.status, 200);
  } finally { f.close(); }
});
