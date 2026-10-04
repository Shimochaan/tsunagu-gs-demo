import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
test("editable showcase in workerd: same public email has separate persistent stores, safe approval, and simulated provisioning", async () => {
  const built = await build({
    entryPoints: ["tests/workers/showcase-fixture.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    conditions: ["workerd", "worker", "browser"],
  });
  const ddl = (
    await readFile("backend/migrations/platform/0001_initial.sql", "utf8")
  ).match(
    /^CREATE TABLE "(?:account|user|session|verification|rateLimit)" .+;/gm,
  );
  const origin = "https://fixture.example";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "showcase-runtime",
      modules: true,
      script: built.outputFiles[0].text,
      compatibilityDate:
        process.env.WORKER_TEST_COMPATIBILITY_DATE || "2026-09-28",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["PLATFORM_DB"],
      durableObjects: {
        SHOWCASE_DATABASES: { className: "ShowcaseDatabase", useSQLite: true },
      },
      bindings: {
        APP_ORIGIN: origin,
        AUTH_DDL: JSON.stringify(ddl),
        AUTH_SECRET: "showcase-fixture-auth-key-at-least-32-bytes",
        CREDENTIAL_KEY: btoa("a".repeat(32)),
      },
      cf: false,
    }),
  );
  const call = (
    path,
    body,
    cookie = "",
    method = body === undefined ? "GET" : "POST",
    extra = {},
  ) =>
    mf.dispatchFetch(origin + path, {
      method,
      headers: { origin, cookie, "content-type": "application/json", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const good = async (r, status = 200) => {
    const text = await r.text();
    assert.equal(r.status, status, text);
    return JSON.parse(text);
  };
  try {
    await good(await call("/__init"));
    const login = async () => {
      const r = await call("/api/auth/sign-in/demo", {
        email: "demo@example.com",
      });
      await good(r.clone());
      return r.headers
        .getSetCookie()
        .map((x) => x.split(";")[0])
        .join("; ");
    };
    const first = await login(),
      second = await login();
    assert.notEqual(first, second);
    const base = "/api/tenants/showcase-company",
      oa = base + "/accounts/showcase-sales";
    await good(await call("/api/me", undefined, first));
    const settings = {
      name: "第一体験者の架空企業",
      industry: "不動産",
      unit: "company",
      method: "agency",
      product: "harness",
      version: 1,
      retentionDays: null,
      shareTeam: true,
    };
    await good(await call(base + "/settings", settings, first, "PATCH"));
    const firstMe = await good(await call("/api/me", undefined, first));
    const secondMe = await good(await call("/api/me", undefined, second));
    assert.match(JSON.stringify(firstMe), /第一体験者/);
    assert.doesNotMatch(JSON.stringify(secondMe), /第一体験者/);
    await good(await call(base + "/settings", settings, first, "PATCH"), 409);
    const proposal = oa + "/assistant/proposals/showcase-proposal";
    const original = await good(await call(proposal, undefined, first));
    assert.equal(original.proposal.problem, null);
    await good(
      await call(
        proposal,
        {
          version: 1,
          draft: "佐藤様、確認用の文面です。",
          learning: { category: "style", note: "" },
        },
        first,
        "PATCH",
      ),
    );
    const edited = await good(await call(proposal, undefined, first));
    assert.equal(edited.proposal.version, 2);
    const untouched = await good(await call(proposal, undefined, second));
    assert.equal(untouched.proposal.version, 1);
    const approved = await good(
      await call(proposal + "/approve", { version: 2 }, first),
    );
    assert.equal(approved.queued, false);
    const created = await good(
      await call(
        "/api/ops/tenants",
        {
          name: "操作テスト企業",
          adminEmail: "demo@example.com",
          product: "harness",
        },
        first,
        "POST",
        { "idempotency-key": "create-test-company" },
      ),
      201,
    );
    const company = await good(
      await call("/api/ops/tenants/" + created.id, undefined, first),
    );
    assert.ok(
      company.databases.every((x) => x.state === "ready"),
      JSON.stringify(company),
    );
    await good(
      await call("/api/ops/tenants/" + created.id, undefined, second),
      404,
    );
    await good(await call("/api/security/totp/setup", {}, first), 403);
    await good(await call("/api/auth/sign-out", {}, first));
    await good(await call("/api/me", undefined, first), 401);
    await good(await call("/api/me", undefined, second));
  } finally {
    await mf.dispose();
  }
});
