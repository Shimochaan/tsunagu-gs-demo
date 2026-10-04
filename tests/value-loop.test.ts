import test from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, ago } from "./helpers/assistant-fixture.ts";
import { one, all, json, now, parse } from "../backend/db.ts";
import {
  scanAssistant,
  upsertSource,
  editAssistant,
  approveAssistant,
  decideAssistant,
  proposeCustomer,
  assistantGuard,
} from "../backend/assistant.ts";
import {
  classifyEdit,
  learningContext,
  learningPrompt,
} from "../backend/assistant-learning.ts";
import {
  generateAssistantDraft,
  draftValidationProblem,
  draftOutputSchema,
} from "../backend/assistant-draft.ts";
import {
  parsePropertyRows,
  propertyHeaders,
} from "../backend/assistant-sheets.ts";
import {
  hasPropertyTag,
  matchesWish,
  sourceContentHash,
} from "../backend/assistant-match.ts";
import {
  articleFromHTML,
  intakeResearch,
} from "../backend/assistant-research-intake.ts";
import { googleSettings } from "../backend/assistant-google-store.ts";
import { syncPropertySheet } from "../backend/assistant-sync.ts";
import { putCredential } from "../backend/credentials.ts";
import { runValueLoop } from "../backend/assistant-value-loop.ts";
const base = "/api/tenants/t/accounts/oa/assistant";
const property = () => ({
  id: "p1",
  kind: "product",
  industry: "estate",
  title: "検証用3LDK",
  url: "https://properties.example.com/one",
  publishedAt: ago(20 * 86400000),
  checkedAt: ago(60000),
  expiresAt: ago(-86400000),
  summary: "新宿区・3LDK・所有権・徒歩7分の架空物件。",
  tags: ["新宿区", "3LDK", "所有権"],
  absentTags: ["定期借地権"],
  area: "新宿区",
  price: 50000000,
  status: "available",
  stock: 1,
  property: { walkingMinutes: 7, layout: "3LDK", tenure: "所有権" },
});
async function wishes(f: Awaited<ReturnType<typeof assistantFixture>>) {
  await f.ts.query(
    "INSERT INTO context_notes(id,customer_id,source,body,confirmed_by,created_at) VALUES ('n','c','human','新宿区、3LDK、所有権。駅徒歩10分以内優先、15分以内可。予算65000000円。','owner',?)",
    [now()],
  );
  await f.request(`${base}/preferences/c`, {
    noteId: "n",
    area: "新宿区",
    maxPrice: 65000000,
    required: ["3LDK", "所有権", "徒歩15分以内"],
    excluded: ["定期借地権"],
  });
}
async function reply(f: Awaited<ReturnType<typeof assistantFixture>>) {
  await f.message();
  await scanAssistant(f.rt, "t", "oa", "owner");
  return (await one(f.ts, "SELECT * FROM proposals"))!;
}
const memory = (
  f: Awaited<ReturnType<typeof assistantFixture>>,
  cid = "c",
  actor = "owner",
) => learningContext(f.ts, actor, cid, "reply");
test("learning: factual changes, negation and private information never become transferable style", () => {
  assert.equal(classifyEdit("1.5万円です", "15万円です").transferable, false);
  assert.equal(
    classifyEdit("5000万円です！", "4000万円です。", {
      category: "style",
      note: "",
    }).transferable,
    false,
  );
  assert.equal(
    classifyEdit("所有権です", "所有権ではありません").transferable,
    false,
  );
  assert.equal(
    classifyEdit("山田さんは子供と入居します", "山田さんは一人で入居します")
      .transferable,
    false,
  );
  assert.equal(
    classifyEdit("ご連絡ありがとうございます！", "ありがとうございます。")
      .transferable,
    true,
  );
});
test("learning: edits alone do not train; exact approved version teaches only phrasing, with actor scope and removal", async () => {
  const f = await assistantFixture();
  try {
    const p = await reply(f);
    await editAssistant(f.rt, "t", "oa", "owner", p.id, 1, p.draft + "！");
    assert.equal((await memory(f)).style.length, 0);
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 2);
    assert.equal((await memory(f, "c2")).style.length, 1);
    const learned = learningPrompt(await memory(f, "c2"));
    assert.ok(!learned.includes(p.draft));
    assert.equal((await memory(f, "c", "stranger")).style.length, 0);
    const e = (await one(
      f.ts,
      "SELECT * FROM assistant_feedback WHERE action='edited'",
    ))!;
    const response = await f.request(
      `${base}/learning/${encodeURIComponent(e.id)}`,
      { excluded: true },
      "PATCH",
    );
    assert.equal(response.status, 200);
    assert.equal((await memory(f)).style.length, 0);
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 2);
    assert.equal(
      (
        await all(
          f.ts,
          "SELECT * FROM assistant_feedback WHERE action='approved'",
        )
      ).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});
test("learning: customer notes and dismissal reasons are isolated; fact correction is not general wording", async () => {
  const f = await assistantFixture();
  try {
    const p = await reply(f);
    await editAssistant(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      1,
      p.draft + " ゆっくりご検討ください。",
      {
        learning: {
          category: "customer",
          note: "今月は家族の都合を優先し内見を急がない",
        },
      },
    );
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 2);
    assert.equal((await memory(f)).customerNotes.length, 1);
    assert.equal((await memory(f, "c2")).customerNotes.length, 0);
    assert.equal((await memory(f)).style.length, 0);
    await decideAssistant(f.rt, "t", "oa", "owner", p.id, 2, "cancel", {
      reason: "timing",
      note: "家族と相談中",
    });
    assert.equal((await memory(f)).decisions[0].category, "timing");
    assert.equal((await memory(f, "c2")).decisions.length, 0);
  } finally {
    await f.dispose();
  }
});
test("learning: autonomous AI never self-trains; approved directed rewrites retain explicit style intent", async () => {
  const f = await assistantFixture();
  try {
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    const p = await reply(f);
    await generateAssistantDraft(f.rt, "t", "oa", "owner", p.id, 1);
    let current = (await one(f.ts, "SELECT * FROM proposals"))!;
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, current.version);
    assert.equal((await memory(f)).style.length, 0);
    await generateAssistantDraft(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      current.version,
      "もっと短く、絵文字なしに",
    );
    current = (await one(f.ts, "SELECT * FROM proposals"))!;
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, current.version);
    assert.deepEqual((await memory(f)).style[0].directiveRules, [
      "shorter",
      "less_emoji",
    ]);
  } finally {
    await f.dispose();
  }
});
test("matching: property columns override hint tags, walking aliases and priority vs hard limit", () => {
  const row = [
    "p",
    "架空新宿",
    "新宿区",
    50000000,
    "3LDK",
    7,
    "所有権",
    "販売中",
    0.56,
    "新宿区,3LDK,所有権",
    "所有権",
    ago(1000),
    ago(1000),
    ago(-86400000),
    "https://properties.example.com/a",
    "下山",
    "架空",
    1,
  ];
  const parsed = parsePropertyRows([propertyHeaders, row], "test");
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.warnings.length, 1);
  const d = parsed.sources[0];
  assert.equal(hasPropertyTag(d, "駅徒歩10分以内"), true);
  assert.equal(
    matchesWish(d, {
      area: "新宿区",
      maxPrice: 65000000,
      required: ["3LDK", "徒歩15分以内"],
      excluded: ["定期借地権"],
    }),
    true,
  );
  d.property!.walkingMinutes = 16;
  assert.equal(hasPropertyTag(d, "徒歩15分以内"), false);
});
test("loop: recent outbound does not hide a meaningful product update; delivery still needs explicit approval", async () => {
  const f = await assistantFixture();
  try {
    await wishes(f);
    await upsertSource(f.rt, "t", "oa", property());
    await f.h.query(
      "INSERT INTO messages(id,customer_id,line_user_id,direction,source,body,state,occurred_at,recorded_at) VALUES ('sent','c','line-c','outbound','human','昨日の案内','sent',?,?)",
      [ago(3600000), ago(3600000)],
    );
    await f.request(
      `${base}/customers/c/followup`,
      {
        version: 0,
        industry: "estate",
        enabled: true,
        sourceKind: "note",
        sourceId: "n",
        conditionQuote: "駅徒歩10分以内優先、15分以内可。",
        stalledQuote: "",
        terms: ["新宿区", "駅徒歩10分以内", "3LDK"],
        promiseQuote: "",
        promiseAt: null,
        phase: "considering",
        waitDays: 3,
        hypothesis: "",
      },
      "PUT",
    );
    const r = await scanAssistant(f.rt, "t", "oa", "owner", undefined, ["c"], {
      allowAutoAI: false,
    });
    assert.equal(r.created, 1);
    const p = (await one(f.ts, "SELECT * FROM proposals"))!;
    assert.equal(p.trigger, "assistant:product");
    assert.equal(await assistantGuard(f.rt, "t", "oa", p), null);
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, p.version);
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 1);
    assert.equal(
      f.calls.filter((c) => c.url.includes("harness.test") && c.body).length,
      0,
    );
  } finally {
    await f.dispose();
  }
});
test("loop: manual and automatic proposal use source evidence, unchanged checks do not duplicate, real price update does", async () => {
  const f = await assistantFixture();
  try {
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    await wishes(f);
    const s = property();
    await upsertSource(f.rt, "t", "oa", s);
    const r = await proposeCustomer(f.rt, "t", "oa", "owner", "c");
    assert.ok("id" in r && r.id);
    const call = f.calls.find((c) => c.url.includes("openai.com"))!;
    assert.ok(
      JSON.parse(call.body.input).refs.some((r: any) => r.id === "source:p1"),
    );
    const p = (await one(f.ts, "SELECT * FROM proposals"))!;
    await decideAssistant(f.rt, "t", "oa", "owner", p.id, p.version, "cancel");
    await upsertSource(f.rt, "t", "oa", { ...s, checkedAt: now() });
    assert.equal((await scanAssistant(f.rt, "t", "oa", "owner")).created, 0);
    await upsertSource(f.rt, "t", "oa", {
      ...s,
      price: 48000000,
      checkedAt: now(),
    });
    assert.equal((await scanAssistant(f.rt, "t", "oa", "owner")).created, 1);
    assert.equal(f.calls.filter((c) => c.url.includes("openai.com")).length, 1);
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
  } finally {
    await f.dispose();
  }
});
test("research: only publisher dates and text become sources; undated/old/redirect/unsupported sources are held", async () => {
  const html = `<title>住宅ローン金利の発表</title><meta property="article:published_time" content="${ago(3600000)}"><main>住宅ローン金利についての公式発表です。現在の金融環境と公表した適用条件について説明します。</main>`;
  assert.equal(
    articleFromHTML(html, "https://www.boj.or.jp/news/a", "住宅ローン金利", [
      "www.boj.or.jp",
    ]).publisher,
    "www.boj.or.jp",
  );
  assert.throws(() =>
    articleFromHTML(
      html.replace(/<meta[^>]+>/, ""),
      "https://www.boj.or.jp/news/a",
      "住宅ローン金利",
      ["www.boj.or.jp"],
    ),
  );
  const f = await assistantFixture();
  try {
    f.rt.externalFetch = async () =>
      new Response(html, { headers: { "content-type": "text/html" } });
    const r = await intakeResearch(
      f.rt,
      "t",
      "oa",
      googleSettings.parse({
        topics: ["住宅ローン金利"],
        allowedHosts: ["boj.or.jp"],
      }),
      [
        { url: "https://www.boj.or.jp/news/a" },
        { url: "https://evil.example.com/a" },
      ],
    );
    assert.equal(r.imported, 1);
    assert.equal(r.rejected.length, 1);
    assert.equal(
      (await all(f.ts, "SELECT * FROM assistant_sources")).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});
test("sync: unchanged file checks metadata only; invalid rows retire old inventory; loop creates no customer sends", async () => {
  const f = await assistantFixture();
  try {
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
      "INSERT INTO connections(id,tenant_id,oa_id,service,state) VALUES ('g','t','oa','google_drive:owner','connected')",
    );
    await f.ts.query(
      "INSERT INTO assistant_google_config(id,actor,data,version) VALUES ('default','owner',?,1)",
      [
        json(
          googleSettings.parse({
            autoSheet: true,
            folderId: "folder",
            spreadsheetId: "sheet",
          }),
        ),
      ],
    );
    let modified = "v1",
      bad = false,
      sheetReads = 0,
      metaReads = 0;
    const row = () => [
      "p",
      "架空新宿",
      "新宿区",
      bad ? "bad" : 50000000,
      "3LDK",
      7,
      "所有権",
      "販売中",
      0.56,
      "新宿区,3LDK,所有権",
      "定期借地権",
      ago(1000),
      ago(1000),
      ago(-86400000),
      "https://properties.example.com/a",
      "下山",
      "架空",
      1,
    ];
    f.rt.externalFetch = async (input) => {
      const u = new URL(String(input));
      if (u.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "fixture" });
      if (u.hostname === "www.googleapis.com") {
        metaReads++;
        return Response.json({
          id: "sheet",
          mimeType: "application/vnd.google-apps.spreadsheet",
          parents: ["folder"],
          modifiedTime: modified,
        });
      }
      if (u.hostname === "sheets.googleapis.com") {
        sheetReads++;
        const properties = {
          sheetId: 1,
          title: "物件台帳",
          sheetType: "GRID",
          gridProperties: { columnCount: 18, rowCount: 100 },
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
                        rowData: [propertyHeaders, row()].map((r) => ({
                          values: r.map((v) => ({
                            userEnteredValue: {},
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
      throw new Error("Unexpected external request");
    };
    await syncPropertySheet(f.rt, "t", "oa", true);
    assert.equal(sheetReads, 2);
    const nextCheck = new Date(
      (await one(f.ts, "SELECT next_at FROM assistant_sheet_sync"))!.next_at,
    );
    assert.equal(nextCheck.getUTCMinutes() % 5, 0);
    assert.equal(nextCheck.getUTCSeconds(), 0);
    const reads = metaReads;
    await syncPropertySheet(f.rt, "t", "oa", true);
    assert.equal(sheetReads, 2);
    assert.equal(metaReads, reads + 1);
    modified = "v2";
    bad = true;
    await syncPropertySheet(f.rt, "t", "oa", true);
    assert.equal(
      parse((await one(f.ts, "SELECT * FROM assistant_sources"))!.data).status,
      "unpublished",
    );
    await runValueLoop(f.rt, "t", "oa");
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
  } finally {
    await f.dispose();
  }
});
test("news: confirmed interest matches independently of property-specific hard filters", async () => {
  const f = await assistantFixture();
  try {
    await wishes(f);
    await f.ts.query(
      "UPDATE context_notes SET body=body||' 金利が気になります。' WHERE id='n'",
    );
    const saved = await f.request(
      `${base}/customers/c/followup`,
      {
        version: 0,
        industry: "estate",
        enabled: true,
        sourceKind: "note",
        sourceId: "n",
        conditionQuote: "新宿区、3LDK、所有権。",
        stalledQuote: "",
        terms: ["新宿区", "3LDK", "所有権"],
        promiseQuote: "",
        promiseAt: null,
        phase: "considering",
        waitDays: 3,
        hypothesis: "",
      },
      "PUT",
    );
    assert.equal(saved.status, 200);
    await upsertSource(f.rt, "t", "oa", {
      id: "news",
      kind: "news",
      title: "金利の発表",
      url: "https://publisher.example.com/a",
      publishedAt: ago(3600000),
      checkedAt: ago(1000),
      expiresAt: ago(-86400000),
      summary: "金利に関する発表。個別条件への適用は未確認。",
      tags: ["金利"],
    });
    assert.equal((await scanAssistant(f.rt, "t", "oa", "owner")).created, 1);
    assert.equal(
      (await one(f.ts, "SELECT trigger FROM proposals"))!.trigger,
      "assistant:news",
    );
  } finally {
    await f.dispose();
  }
});
test("learning: a fact correction holds the same source contents despite refreshed timestamps; changing the fact permits rematching", async () => {
  const f = await assistantFixture();
  try {
    await wishes(f);
    const source = property();
    await upsertSource(f.rt, "t", "oa", source);
    await scanAssistant(f.rt, "t", "oa", "owner");
    const p = (await one(f.ts, "SELECT * FROM proposals"))!;
    await editAssistant(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      1,
      "価格を確認して改めてご案内します。",
      {
        learning: {
          category: "fact",
          note: "価格の転記誤りを確認。元データの修正が必要。",
        },
      },
    );
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, 2);
    await upsertSource(f.rt, "t", "oa", { ...source, checkedAt: now() });
    assert.equal((await scanAssistant(f.rt, "t", "oa", "owner")).created, 0);
    await upsertSource(f.rt, "t", "oa", {
      ...source,
      price: 49000000,
      checkedAt: now(),
    });
    assert.equal((await scanAssistant(f.rt, "t", "oa", "owner")).created, 1);
  } finally {
    await f.dispose();
  }
});
test("staff loop: a distinct source update notifies within customer cooldown; LINE dismissal reason is recorded once", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-04T02:00:00Z").getTime(),
  });
  const f = await assistantFixture();
  try {
    const { notifyAssistant } =
      await import("../backend/assistant-notifications.ts");
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
    await wishes(f);
    const source = property();
    await upsertSource(f.rt, "t", "oa", source);
    await scanAssistant(f.rt, "t", "oa", "owner");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    const notice = (await one(
      f.rt.db,
      "SELECT * FROM staff_line_notices WHERE state='sent'",
    ))!;
    await f.webhook({
      type: "postback",
      postback: { data: `assistant:${notice.id}:cancel` },
    });
    await f.webhook({
      type: "message",
      message: { type: "text", text: "タイミング 来週相談する" },
    });
    const feedback = (await one(
      f.ts,
      "SELECT * FROM assistant_feedback WHERE action='cancel'",
    ))!;
    assert.equal(feedback.category, "timing");
    assert.equal(feedback.note, "来週相談する");
    t.mock.timers.tick(60001);
    await upsertSource(f.rt, "t", "oa", {
      ...source,
      price: 48000000,
      checkedAt: now(),
    });
    await scanAssistant(f.rt, "t", "oa", "owner");
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 1);
    assert.equal((await notifyAssistant(f.rt, "t", "oa")).sent, 0);
    assert.equal((await all(f.h, "SELECT * FROM outbox")).length, 0);
  } finally {
    await f.dispose();
    t.mock.timers.reset();
  }
});
test("learning: approving a customer-specific note must not retroactively invalidate the approved AI context", async () => {
  const f = await assistantFixture();
  try {
    f.rt.ai = { apiKey: "fixture", model: "fixture" };
    const p = await reply(f);
    await generateAssistantDraft(f.rt, "t", "oa", "owner", p.id, 1);
    const generated = (await one(f.ts, "SELECT * FROM proposals"))!;
    await editAssistant(
      f.rt,
      "t",
      "oa",
      "owner",
      p.id,
      generated.version,
      generated.draft,
      {
        learning: { category: "customer", note: "急がず情報提供を中心にする" },
      },
    );
    const edited = (await one(f.ts, "SELECT * FROM proposals"))!;
    await approveAssistant(f.rt, "t", "oa", "owner", p.id, edited.version);
    const approved = (await one(f.ts, "SELECT * FROM proposals"))!;
    assert.equal(await assistantGuard(f.rt, "t", "oa", approved), null);
    assert.equal((await memory(f)).customerNotes.length, 1);
  } finally {
    await f.dispose();
  }
});

test("draft diagnostics: a model refusal and truncated output explain why without approving a fallback", async () => {
  for (const status of ["completed", "incomplete"]) {
    const f = await assistantFixture();
    try {
      f.rt.ai = { apiKey: "fixture", model: "fixture" };
      const p = await reply(f);
      f.rt.externalFetch = async () =>
        Response.json({
          status,
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    safeToSend: false,
                    reviewReason: "価格の根拠が矛盾しています。",
                    draft: "",
                    contextRefs: [],
                    facts: [],
                  }),
                },
              ],
            },
          ],
        });
      const result = await generateAssistantDraft(
        f.rt,
        "t",
        "oa",
        "owner",
        p.id,
        1,
      );
      assert.equal(result.state, "blocked");
      assert.match(
        result.detail,
        status === "completed" ? /価格の根拠が矛盾/ : /出力上限/,
      );
      assert.equal(
        (await one(f.ts, "SELECT * FROM proposals WHERE id=?", [p.id]))?.state,
        "held",
      );
    } finally {
      await f.dispose();
    }
  }
});

test("simulation: fixture wording must say it is a test; numeric/source validation is retained", () => {
  const text =
    "検証用の物件。5000万円です。在庫は確認時点の情報です。https://example.com/property";
  const context = {
    refs: [{ id: "source:x", text }],
    mandatoryRefs: ["source:x"],
    source: { url: "https://example.com/property" },
    kind: "product",
    simulation: true,
  };
  const draft = draftOutputSchema.parse({
    safeToSend: true,
    draft: text,
    contextRefs: ["source:x"],
    facts: [{ ref: "source:x", quote: text }],
  });
  assert.equal(draftValidationProblem(draft, context), null);
  assert.match(
    draftValidationProblem(
      { ...draft, draft: text.replace("検証用の", "こちらの") },
      context,
    )!,
    /検証用/,
  );
  assert.match(
    draftValidationProblem(
      { ...draft, draft: text.replace("5000", "4000") },
      context,
    )!,
    /数値/,
  );
});
