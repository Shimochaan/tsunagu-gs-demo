import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, ago } from "./helpers/assistant-fixture.ts";
import { all, one, now, json, parse } from "../backend/db.ts";
import {
  scanAssistant,
  upsertSource,
  approveAssistant,
  decideAssistant,
  assistantGuard,
} from "../backend/assistant.ts";
import { generateAssistantDraft, processAssistantDraftRepairs, draftValidationProblem, draftOutputSchema, sourceDraftFacts } from "../backend/assistant-draft.ts";
import {
  discoverAssistantNews,
  syncAssistantFeed,
  refreshAssistantSources,
} from "../backend/assistant-discovery.ts";
import { sendDue } from "../backend/delivery.ts";
import { createApp } from "../backend/app.ts";
const base = "/api/tenants/t/accounts/oa/assistant";
const source = (kind = "news") => ({
  id: kind,
  kind,
  title: kind === "news" ? "金利に関する発表" : "新宿の3LDK",
  url: `https://publisher.example.com/${kind}`,
  publishedAt: ago(3600000),
  eventAt: null,
  checkedAt: ago(60000),
  expiresAt: new Date(Date.now() + 7200000).toISOString(),
  summary: "金利に関する確認済みの公表内容。個別条件への適用は未確認です。",
  tags: kind === "news" ? ["金利"] : ["3LDK"],
  absentTags: ["借地権"],
  area: kind === "product" ? "新宿" : null,
  price: kind === "product" ? 45000000 : null,
  status: kind === "product" ? "available" : "unknown",
  stock: kind === "product" ? 1 : null,
});
async function note(
  f: Awaited<ReturnType<typeof assistantFixture>>,
  id = "n",
  cid = "c",
  body = "金利が気になる。新宿、3LDK、予算50000000円。",
) {
  await f.ts.query(
    "INSERT INTO context_notes(id,customer_id,source,body,confirmed_by,created_at) VALUES (?,?,'human',?,'owner',?)",
    [id, cid, body, now()],
  );
}
async function proposal(f: Awaited<ReturnType<typeof assistantFixture>>) {
  await f.message();
  await scanAssistant(f.rt, "t", "oa", "owner");
  return (await one(f.ts, "SELECT * FROM proposals"))!;
}
function response(out: any) {
  return Response.json({
    status: "completed",
    usage: { input_tokens: 40, output_tokens: 30 },
    output: [
      { type: "message", content: [{ type: "output_text", text: json(out) }] },
    ],
  });
}

test("assistant intelligence: all three initial drafts use scoped conversation, confirmed memories, preferences and source; remain unapproved", async () => {
  for (const kind of ["reply", "news", "product"]) {
    const f = await assistantFixture();
    try {
      f.rt.ai = { apiKey: "fixture", model: "fixture-model" };
      await note(f);
      await note(f, "other", "c2", "他のお客様だけの秘密条件");
      await f.ts.query(
        "INSERT INTO context_notes(id,customer_id,source,body,created_at) VALUES ('unconfirmed','c','human','未確認の情報',?)",
        [now()],
      );
      await f.request(`${base}/preferences/c`, {
        noteId: "n",
        area: "新宿",
        maxPrice: 50000000,
        required: ["3LDK"],
        excluded: ["借地権"],
      });
      if (kind === "reply")
        await f.message("c", "借り換えと金利について相談できますか？");
      else await upsertSource(f.rt, "t", "oa", source(kind));
      await f.request(`${base}/automation`, { autoDraft: true });
      await scanAssistant(f.rt, "t", "oa", "owner");
      const p = (await one(f.ts, "SELECT * FROM proposals"))!,
        ev = parse(
          (await one(f.ts, "SELECT evidence FROM assistant_proposals"))!
            .evidence,
        );
      assert.equal(p.trigger, `assistant:${kind}`);
      assert.equal(p.state, "pending");
      assert.equal(p.version, 3);
      assert.equal(ev.draftMode, "generated");
      assert.ok(ev.aiContextHash);
      const request = f.calls.find((c) => c.url.includes("openai.com"))!.body;
      assert.equal(request.store, false);
      assert.equal(request.text.format.strict, true);
      const input = JSON.parse(request.input);
      assert.ok(input.refs.some((r: any) => r.id === "note:n"));
      assert.ok(input.refs.some((r: any) => r.id === "preferences"));
      assert.equal(input.currentPropertyConditions.latestNoteId,"note:n");
      assert.equal(input.currentPropertyConditions.values.area,"新宿");
      assert.equal(input.refs.find((r:any)=>r.id==='note:n').currentPropertyConditionSource,true);
      assert.match(request.instructions,/古いメモ.*矛盾として拒否しない/);
      assert.ok(!request.input.includes("他のお客様だけ"));
      assert.ok(!request.input.includes("未確認の情報"));
      if (kind !== "reply")
        assert.match(p.draft, /https:\/\/publisher.example.com/);
      assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
      assert.equal(
        (
          await all(
            f.rt.db,
            "SELECT * FROM usage_events WHERE provider='openai'",
          )
        ).length,
        1,
      );
    } finally {
      await f.dispose();
    }
  }
});

test("assistant intelligence: missing AI is explicit, no automatic calls until enabled, foreign operator cannot generate", async () => {
  const f = await assistantFixture();
  try {
    const p = await proposal(f),
      data = (await f.request(base)).data;
    assert.equal(data.aiConfigured, false);
    assert.match(data.proposals[0].evidence.draftDetail, /AI未接続/);
    assert.equal(
      (
        await f.request(`${base}/proposals/${p.id}/generate`, {
          version: p.version,
        })
      ).status,
      409,
    );
    assert.equal(f.calls.length, 0);
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    assert.equal(
      (
        await f.request(
          `${base}/proposals/${p.id}/generate`,
          { version: p.version },
          "POST",
          "stranger",
        )
      ).status,
      403,
    );
    assert.equal(f.calls.length, 0);
    const result = await f.request(`${base}/proposals/${p.id}/generate`, {
      version: p.version,
    });
    assert.equal(result.data.state, "generated");
  } finally {
    await f.dispose();
  }
});

test("assistant intelligence: invented rate, URL, reference, false quote, unsafe or incomplete output hold the proposal", async () => {
  for (const fault of [
    "number",
    "url",
    "ref",
    "quote",
    "unsafe",
    "incomplete",
  ]) {
    const f = await assistantFixture();
    try {
      f.rt.ai = { apiKey: "fixture", model: "fixture" };
      const p = await proposal(f),
        original = p.draft;
      f.rt.externalFetch = async (_u, init) => {
        const input = JSON.parse(JSON.parse(String(init!.body)).input),
          ref = input.requiredRefs[0];
        const out = {
          safeToSend: fault !== "unsafe",
          draft:
            fault === "number"
              ? "金利は0.1%です。"
              : fault === "url"
                ? "https://fake.example.com/offer"
                : "ご連絡ありがとうございます。確認します。",
          contextRefs: [fault === "ref" ? "note:other-tenant" : ref],
          facts: [
            {
              ref,
              quote:
                fault === "quote"
                  ? "存在しない事実"
                  : input.refs.find((r: any) => r.id === ref).text,
            },
          ],
        };
        return fault === "incomplete"
          ? Response.json({ status: "incomplete" })
          : response(out);
      };
      assert.equal(
        (
          await generateAssistantDraft(
            f.rt,
            "t",
            "oa",
            "owner",
            p.id,
            p.version,
          )
        ).state,
        "blocked",
      );
      const fresh = (await one(f.ts, "SELECT * FROM proposals"))!;
      assert.equal(fresh.state, "held");
      assert.equal(fresh.draft, original);
      await assert.rejects(
        approveAssistant(f.rt, "t", "oa", "owner", p.id, fresh.version),
      );
      assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
    } finally {
      await f.dispose();
    }
  }
});

test("assistant intelligence: concurrent/replayed generation calls once; approval blocked during generation and cancellation wins", async () => {
  const f = await assistantFixture();
  try {
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    const p = await proposal(f);
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, p.version);
    const original = f.rt.externalFetch;
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    f.rt.externalFetch = async (u, init) => {
      entered();
      await pending;
      return original(u, init);
    };
    const generating = generateAssistantDraft(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      p.version,
    );
    await started;
    const current = (await one(f.ts, "SELECT * FROM proposals"))!;
    assert.equal(
      (await one(f.h, "SELECT state FROM outbox"))!.state,
      "cancelled",
    );
    await assert.rejects(
      approveAssistant(f.rt, "t", "oa", "owner", p.id, current.version),
    );
    await assert.rejects(
      generateAssistantDraft(f.rt, "t", "oa", "owner", p.id, p.version),
    );
    await decideAssistant(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      current.version,
      "cancel",
    );
    release();
    await generating;
    assert.equal(
      (await one(f.ts, "SELECT state FROM proposals"))!.state,
      "cancelled",
    );
    assert.equal(f.calls.filter((c) => c.url.includes("openai")).length, 1);
  } finally {
    await f.dispose();
  }
});

test("assistant intelligence: changes while generating and to a referenced note after approval prevent delivery", async () => {
  const f = await assistantFixture();
  try {
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    await note(f);
    const p = await proposal(f);
    await generateAssistantDraft(f.rt, "t", "oa", "owner", p.id, p.version);
    const fresh = (await one(f.ts, "SELECT * FROM proposals"))!;
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, fresh.version);
    await f.ts.query(
      "UPDATE context_notes SET body='確認済みの新しい条件' WHERE id='n'",
    );
    assert.match((await assistantGuard(f.rt, "t", "oa", fresh))!, /変更/);
    await sendDue(f.rt, "t", "oa");
    assert.equal(
      f.calls.filter((c) => c.url.includes("/messages") && c.body).length,
      0,
    );
    assert.equal((await one(f.h, "SELECT state FROM outbox"))!.state, "held");
  } finally {
    await f.dispose();
  }
  const g = await assistantFixture();
  try {
    g.rt.ai = { apiKey: "fixture", model: "fixture" };
    await note(g);
    const p = await proposal(g),
      fetch = g.rt.externalFetch;
    g.rt.externalFetch = async (u, i) => {
      const r = await fetch(u, i);
      await g.ts.query(
        "UPDATE context_notes SET body='生成待機中に変わった条件' WHERE id='n'",
      );
      return r;
    };
    assert.equal(
      (await generateAssistantDraft(g.rt, "t", "oa", "owner", p.id, p.version))
        .state,
      "blocked",
    );
    assert.equal(
      (await one(g.ts, "SELECT draft FROM proposals"))!.draft,
      p.draft,
    );
  } finally {
    await g.dispose();
  }
});

test("assistant intelligence: provider failure is visible and daily quota prevents another paid call", async () => {
  const f = await assistantFixture();
  try {
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    const p = await proposal(f);
    let count = 0;
    f.rt.externalFetch = async () => {
      count++;
      throw new Error("fixture failure");
    };
    assert.equal(
      (await generateAssistantDraft(f.rt, "t", "oa", "owner", p.id, p.version))
        .state,
      "failed",
    );
    const fresh = (await one(f.ts, "SELECT * FROM proposals"))!;
    assert.equal(fresh.draft, p.draft);
    assert.equal(fresh.state, "held", "failed AI must not notify its original template");
    assert.match(
      (await f.request(base)).data.proposals[0].evidence.draftDetail,
      /取得できません/,
    );
    await f.ts.query("UPDATE assistant_budget SET used=20 WHERE kind='ai'");
    assert.equal(
      (
        await generateAssistantDraft(
          f.rt,
          "t",
          "oa",
          "owner",
          p.id,
          fresh.version,
        )
      ).state,
      "limit",
    );
    assert.equal(count, 1);
  } finally {
    await f.dispose();
  }
});

test("assistant discovery: search then article extraction, canonical dedup, dates/source/relevance rejection; no personal data in queries", async () => {
  const f = await assistantFixture();
  try {
    await note(f, "n", "c", "山田様は金利について相談。連絡先は私的情報。");
    f.rt.assistantSearch = {
      "t:oa": {
        url: "https://gateway.example.com/search",
        allowedHosts: ["publisher.example.com"],
      },
    };
    await f.request(`${base}/automation`, { topics: ["金利"] });
    const calls: any[] = [];
    f.rt.externalFetch = async (u, init) => {
      assert.equal(String(u), "https://gateway.example.com/search");
      const b = JSON.parse(String(init?.body));
      calls.push(b);
      if (b.operation === "search")
        return Response.json({
          results: [
            { url: "https://publisher.example.com/good?utm_source=x" },
            { url: "https://publisher.example.com/good" },
            { url: "https://publisher.example.com/stale" },
            { url: "https://publisher.example.com/unrelated" },
            { url: "https://unapproved.example.com/news" },
          ],
        });
      return Response.json({
        url: b.url,
        title: "金利についての公表",
        publisher: "公表元",
        content: b.url.endsWith("unrelated")
          ? "住宅とは関連のない天気についての詳細な記事本文です。晴れが続きます。"
          : "住宅ローン金利についての公表内容です。条件によって適用は異なります。詳細は金融機関に確認してください。",
        publishedAt: b.url.endsWith("stale")
          ? ago(10 * 86400000)
          : ago(3600000),
        eventAt: null,
        retrievedAt: ago(1000),
      });
    };
    const r = await discoverAssistantNews(f.rt, "t", "oa", "owner");
    assert.equal(r.imported, 1);
    assert.equal(r.rejected, 4);
    assert.equal(calls.filter((c) => c.operation === "article").length, 3);
    assert.ok(!json(calls).includes("山田"));
    assert.ok(!json(calls).includes("連絡先"));
    await scanAssistant(f.rt, "t", "oa", "owner");
    const p = (await f.request(base)).data.proposals[0];
    assert.equal(p.kind, "news");
    assert.equal(p.customer_id, "c");
    assert.equal(p.evidence.discovery.publisher, "公表元");
    assert.equal(p.evidence.url, "https://publisher.example.com/good");
    const before = calls.length;
    assert.equal(
      (await f.request(`${base}/discover`, {}, "POST", "stranger")).status,
      403,
    );
    assert.equal(calls.length, before);
  } finally {
    await f.dispose();
  }
});

test("assistant discovery: unconnected, future/undated/mismatched article and old event are not accepted; automatic work requires opt-in and is bounded", async () => {
  const f = await assistantFixture();
  try {
    assert.equal(
      (await f.request(`${base}/discover`, {})).data.error,
      "SEARCH_NOT_CONNECTED",
    );
    await note(f);
    f.rt.assistantSearch = {
      "t:oa": {
        url: "https://gateway.example.com/search",
        allowedHosts: ["publisher.example.com"],
      },
    };
    await f.request(`${base}/automation`, { topics: ["金利"] });
    let count = 0;
    f.rt.externalFetch = async (_u, i) => {
      count++;
      const b = JSON.parse(String(i?.body));
      if (b.operation === "search")
        return Response.json({
          results: [
            { url: "https://publisher.example.com/future" },
            { url: "https://publisher.example.com/undated" },
            { url: "https://publisher.example.com/mismatch" },
            { url: "https://publisher.example.com/event" },
          ],
        });
      return Response.json({
        url: b.url.endsWith("mismatch")
          ? "https://publisher.example.com/other"
          : b.url,
        title: "金利",
        publisher: "金融機関",
        content:
          "住宅ローン金利について最近公表された内容を詳しくご紹介する記事本文です。",
        publishedAt: b.url.endsWith("undated")
          ? null
          : b.url.endsWith("future")
            ? new Date(Date.now() + 86400000).toISOString()
            : ago(1000),
        eventAt: b.url.endsWith("event") ? ago(40 * 86400000) : null,
        retrievedAt: ago(500),
      });
    };
    await refreshAssistantSources(f.rt, "t", "oa");
    assert.equal(count, 0);
    await f.request(`${base}/automation`, {
      autoSearch: true,
      topics: ["金利"],
    });
    await Promise.all([
      refreshAssistantSources(f.rt, "t", "oa"),
      refreshAssistantSources(f.rt, "t", "oa"),
    ]);
    assert.equal(count, 5);
    assert.equal(
      (await all(f.ts, "SELECT * FROM assistant_sources")).length,
      0,
    );
    await f.ts.query("UPDATE assistant_budget SET used=4 WHERE kind='search'");
    await assert.rejects(discoverAssistantNews(f.rt, "t", "oa", "owner"));
    assert.equal(count, 5);
  } finally {
    await f.dispose();
  }
});

test("assistant product feed: real adapter snapshot creates matching proposal, removed inventory invalidates approval and failed sync fails closed", async () => {
  const f = await assistantFixture();
  try {
    await note(f);
    await f.request(`${base}/preferences/c`, {
      noteId: "n",
      area: "新宿",
      maxPrice: 50000000,
      required: ["3LDK"],
      excluded: ["借地権"],
    });
    f.rt.assistantFeeds = {
      "t:oa": { url: "https://catalog.example.com/feed.json" },
    };
    let items: any[] = [source("product")],
      fail = false;
    const fetch = f.rt.externalFetch;
    f.rt.externalFetch = async (u, i) =>
      String(u).includes("catalog.example.com")
        ? fail
          ? Response.json({ bad: true })
          : Response.json(items)
        : fetch(u, i);
    assert.equal((await syncAssistantFeed(f.rt, "t", "oa")).count, 1);
    await scanAssistant(f.rt, "t", "oa", "owner");
    const p = (await one(f.ts, "SELECT * FROM proposals"))!;
    assert.equal(p.trigger, "assistant:product");
    assert.equal(
      parse(
        (await one(f.ts, "SELECT evidence FROM assistant_proposals"))!.evidence,
      ).sourceId,
      "feed-product",
    );
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, p.version);
    items = [];
    await syncAssistantFeed(f.rt, "t", "oa");
    await sendDue(f.rt, "t", "oa");
    assert.equal((await one(f.h, "SELECT state FROM outbox"))!.state, "held");
    items = [source("product")];
    await syncAssistantFeed(f.rt, "t", "oa");
    fail = true;
    assert.equal((await syncAssistantFeed(f.rt, "t", "oa")).ok, false);
    assert.equal(
      parse((await one(f.ts, "SELECT data FROM assistant_sources"))!.data)
        .status,
      "unknown",
    );
    assert.equal(
      f.calls.filter((c) => c.url.endsWith("/messages") && c.body).length,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("assistant auth: unavailable mail is reported before auth handler; Google and existing-session paths remain available; local mailbox is distinct", async () => {
  const f = await assistantFixture();
  try {
    const app = createApp();
    f.rt.mailMode = "unconfigured";
    f.rt.googleEnabled = true;
    const config = await app.request("/api/config", {}, { runtime: f.rt });
    assert.deepEqual(await config.json(), {
      google: true,
      mail: false,
      mailMode: "unconfigured",
    });
    for (const path of [
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/sign-in/magic-link",
    ]) {
      const r = await app.request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: json({ email: "fixture@example.test" }),
        },
        { runtime: f.rt },
      );
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as any).error, "MAIL_NOT_CONFIGURED");
    }
    assert.equal(
      (
        await app.request(
          "/api/staging-otp?email=fixture@example.test",
          {},
          { runtime: f.rt },
        )
      ).status,
      404,
    );
    f.rt.mailMode = "local";
    const local = await app.request("/api/config", {}, { runtime: f.rt });
    assert.equal(((await local.json()) as any).mailMode, "local");
    // 稼働中セッションの取り消しやDB変更は設定チェックでは行わない。
    assert.equal(
      (await app.request("/api/health", {}, { runtime: f.rt })).status,
      200,
    );
  } finally {
    await f.dispose();
  }
});


test("automatic drafts: numeric display aliases retain grounding and URLs cannot supply unrelated numbers", () => {
  const facts = sourceDraftFacts({ price: 99000000, checkedAt: "2026-10-04T15:19:00Z", url: "https://example.test/87654321" });
  const text = json(facts) + " 予算100000000円、別の価格120000000円。";
  const context = { refs: [{ id: "source:x", text }], mandatoryRefs: ["source:x"], source: null, kind: "reply" };
  const output = draftOutputSchema.parse({ safeToSend: true, draft: "9,900万円、予算1億円、別の価格1億2000万円。2026年10月5日00:19日本時間。", contextRefs: ["source:x"], facts: [{ ref: "source:x", quote: text }] });
  assert.equal(draftValidationProblem(output, context), null);
  assert.match(draftValidationProblem({ ...output, draft: "価格9800万円です。" }, context)!, /9800万/);
  assert.match(draftValidationProblem({ ...output, draft: "面積87654321です。" }, context)!, /87654321/);
  assert.match(draftValidationProblem({ ...output, draft: "https://example.test/changed" }, context)!, /URL/);
});

// Create the queued state directly through the real generation path, then let a fresh tick resume it.
async function queuedRepair(f: Awaited<ReturnType<typeof assistantFixture>>, mode = "number") {
  const p = await proposal(f);
  f.rt.ai = { apiKey: "fixture", model: "fixture" };
  const fetch = f.rt.externalFetch;
  let calls = 0;
  f.rt.externalFetch = async (u, init) => {
    const res = await fetch(u, init);
    if (!String(u).includes("api.openai.com")) return res;
    calls++;
    if (mode === "provider" && calls === 1) return new Response("unavailable", { status: 503 });
    const data: any = await res.json();
    const out = JSON.parse(data.output[0].content[0].text);
    if (mode === "unsafe") { out.safeToSend = false; out.reviewReason = "価格の根拠が矛盾しています"; out.draft = ""; }
    else if (calls === 1 || mode === "always") out.draft += "価格123456789円です。";
    data.output[0].content[0].text = json(out);
    return Response.json(data);
  };
  const result = await generateAssistantDraft(f.rt, "t", "oa", "owner", p.id, p.version, "", { automatic: true });
  return { p, result, calls: () => calls };
}

test("automatic drafts: a persisted repair resumes once, provides the failure reason and does not repeat on later ticks", async () => {
  for (const mode of ["number", "provider"]) {
    const f = await assistantFixture();
    try {
      const q = await queuedRepair(f, mode);
      assert.equal(q.result.state, "retry_pending");
      assert.equal((await one(f.ts, "SELECT state FROM proposals WHERE id=?", [q.p.id])).state, "held");
      await Promise.all([processAssistantDraftRepairs({ ...f.rt }, "t", "oa"), processAssistantDraftRepairs(f.rt, "t", "oa")]);
      const p = await one(f.ts, "SELECT p.*,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?", [q.p.id]);
      assert.equal(p.state, "pending");
      assert.equal(parse(p.evidence).draftMode, "generated");
      assert.equal((await one(f.ts, "SELECT state FROM assistant_runs WHERE kind='draft_repair'")).state, "completed");
      const input = JSON.parse(f.calls.filter(c => c.url.includes("openai.com"))[1].body.input);
      assert.match(input.automaticRepair.problem, mode === "number" ? /123456789/ : /接続エラー/);
      await processAssistantDraftRepairs(f.rt, "t", "oa");
      await scanAssistant(f.rt, "t", "oa", "owner");
      assert.equal(q.calls(), 2);
      assert.equal((await one(f.h, "SELECT COUNT(*) n FROM outbox")).n, 0);
    } finally { await f.dispose(); }
  }
});

test("automatic drafts: refusal, repeated failure, changed context, edits, cancellation and exhausted budget never auto-notify unverified output", async () => {
  for (const mode of ["unsafe", "always", "changed", "edited", "cancelled", "budget"]) {
    const f = await assistantFixture();
    try {
      const q = await queuedRepair(f, mode);
      if (mode === "changed") await f.message("c", "希望が変わりました");
      if (mode === "edited") {
        const p = await one(f.ts, "SELECT * FROM proposals WHERE id=?", [q.p.id]);
        const { editAssistant } = await import("../backend/assistant.ts");
        await editAssistant(f.rt, "t", "oa", "owner", p.id, p.version, "本人が編集した文面");
      }
      if (mode === "cancelled") await f.ts.query("UPDATE proposals SET state='cancelled' WHERE id=?", [q.p.id]);
      if (mode === "budget") await f.ts.query("UPDATE assistant_budget SET used=20 WHERE kind='ai'");
      await processAssistantDraftRepairs(f.rt, "t", "oa");
      await processAssistantDraftRepairs(f.rt, "t", "oa");
      assert.equal(q.calls(), mode === "always" ? 2 : 1, mode);
      const p = await one(f.ts, "SELECT p.*,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?", [q.p.id]);
      assert.equal(p.state, mode === "edited" ? "pending" : mode === "cancelled" ? "cancelled" : "held", mode);
      if (mode !== "cancelled") assert.notEqual(parse(p.evidence).draftMode, "retry_pending", mode);
      if (mode === "edited") assert.equal(p.draft, "本人が編集した文面");
      assert.equal((await one(f.h, "SELECT COUNT(*) n FROM outbox")).n, 0);
    } finally { await f.dispose(); }
  }
});


test("automatic drafts: an interrupted repair is held without replaying an ambiguous paid request", async () => {
  const f = await assistantFixture();
  try {
    const q = await queuedRepair(f);
    await f.ts.query("UPDATE assistant_runs SET state='running',created_at=? WHERE kind='draft_repair'", [new Date(Date.now() - 6 * 60000).toISOString()]);
    await processAssistantDraftRepairs(f.rt, "t", "oa");
    await processAssistantDraftRepairs(f.rt, "t", "oa");
    assert.equal(q.calls(), 1);
    assert.equal((await one(f.ts, "SELECT state FROM assistant_runs WHERE kind='draft_repair'")).state, "interrupted");
    const p = await one(f.ts, "SELECT p.*,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?", [q.p.id]);
    assert.equal(p.state, "held");
    assert.equal(parse(p.evidence).draftMode, "blocked");
    assert.match(p.hold_reason, /中断/);
  } finally { await f.dispose(); }
});

test("automatic drafts: the scheduled value loop resumes a queued repair after the property request ends", async () => {
  const f = await assistantFixture();
  try {
    const q = await queuedRepair(f);
    const { runValueLoop } = await import("../backend/assistant-value-loop.ts");
    const result = await runValueLoop(f.rt, "t", "oa");
    assert.deepEqual(result.issues, []);
    assert.equal(q.calls(), 2);
    assert.equal((await one(f.ts, "SELECT state FROM assistant_runs WHERE kind='draft_repair'")).state, "completed");
  } finally { await f.dispose(); }
});
