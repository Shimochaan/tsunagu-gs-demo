import { businessProfile } from "./business.ts";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { all, one, now, json } from "./db.ts";
import { requireThat, digest } from "./security.ts";
import { assistantAccess, upsertSource, sourceSchema } from "./assistant.ts";
import {
  automationSettings,
  claimBudget,
  recordRun,
} from "./assistant-controls.ts";

const day = 86400000;
const norm = (s: string) => s.normalize("NFKC").toLowerCase();
// 公開HTTPS限定。任意の検索結果をサーバーから直接fetchせず、承認済みアダプタが取得する。
export function publicUrl(raw: string) {
  const u = new URL(raw),
    h = u.hostname.toLowerCase();
  requireThat(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      h.includes(".") &&
      !/^[\d.]+$|:|(^|\.)(localhost|local|internal|test)$/.test(h),
    400,
    "PUBLIC_URL_REQUIRED",
    "公開HTTPSの出典を指定してください。",
  );
  u.hash = "";
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.href;
}
export async function gateway(
  rt: Runtime,
  config: { url: string; token?: string },
  body?: unknown,
) {
  publicUrl(config.url);
  const response = await rt.externalFetch(config.url, {
    method: body ? "POST" : "GET",
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: json(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  requireThat(
    response.ok,
    502,
    "SOURCE_PROVIDER_FAILED",
    "情報元から取得できませんでした。設定と接続状態をご確認ください。",
  );
  const text = await response.text();
  requireThat(
    text.length <= 500000,
    413,
    "SOURCE_TOO_LARGE",
    "一度に取得する情報が多すぎます。",
  );
  return JSON.parse(text);
}
export const articleSchema = z
  .object({
    url: z.string().url(),
    title: z.string().min(1).max(200),
    publisher: z.string().min(1).max(100),
    content: z.string().min(30).max(50000),
    publishedAt: z.string().datetime(),
    eventAt: z.string().datetime().nullable(),
    retrievedAt: z.string().datetime(),
  })
  .strict();

export const searchResultsSchema = z
  .object({
    results: z.array(z.object({ url: z.string().url() }).strict()).max(5),
  })
  .strict();
export function validateArticle(
  input: unknown,
  options: { url: string; topic: string; allowedHosts: string[] },
) {
  const article = articleSchema.parse(input),
    url = publicUrl(options.url);
  requireThat(
    options.allowedHosts.includes(new URL(url).hostname),
    422,
    "SOURCE_HOST_REJECTED",
    "許可された出典ではありません。",
  );
  requireThat(
    publicUrl(article.url) === url,
    422,
    "SOURCE_MISMATCH",
    "記事の出典URLが一致しません。",
  );
  const published = Date.parse(article.publishedAt),
    retrieved = Date.parse(article.retrievedAt);
  requireThat(
    published <= Date.now() &&
      published >= Date.now() - 7 * day &&
      retrieved <= Date.now() &&
      retrieved >= Date.now() - 3600000,
    422,
    "SOURCE_STALE",
    "公開日または取得日時を検証できません。",
  );
  if (article.eventAt)
    requireThat(
      Date.parse(article.eventAt) <= Date.now() &&
        Date.parse(article.eventAt) >= Date.now() - 30 * day,
      422,
      "EVENT_STALE",
      "古い出来事の再掲、または未来の出来事です。",
    );
  requireThat(
    norm(article.content).includes(norm(options.topic)),
    422,
    "NOT_RELEVANT",
    "記事本文に商談テーマの根拠がありません。",
  );
  return article;
}
export function validateCatalog(input: unknown) {
  const rows = z.array(sourceSchema).max(100).parse(input);
  requireThat(
    new Set(rows.map((r) => r.id)).size === rows.length,
    422,
    "DUPLICATE_SOURCE",
    "情報元に重複したIDがあります。",
  );
  for (const row of rows) {
    sourceSchema.parse({ ...row, id: `feed-${row.id}` });
    publicUrl(row.url);
    requireThat(
      Date.parse(row.checkedAt) <= Date.now() &&
        Date.parse(row.expiresAt) > Date.parse(row.checkedAt),
      422,
      "SOURCE_DATES_INVALID",
      "情報元の日付を確認してください。",
    );
  }
  return rows;
}

// 正規化JSON検索アダプタの契約: search -> URL候補、article -> 元記事から抽出した本文/日付。
// RSSでもモデル生成の要約でもなく、検索と原文取得の両操作が必要。
export async function discoverAssistantNews(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor?: string,
) {
  const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
    config = rt.assistantSearch?.[`${tenant}:${oa}`],
    settings = await automationSettings(ts);
  const business = await businessProfile(rt,tenant);
  if (actor) await assistantAccess(rt, tenant, oa, actor);
  requireThat(
    config,
    409,
    "SEARCH_NOT_CONNECTED",
    "Web検索は未接続です。検索・記事取得JSONアダプタと許可する出典ホストの設定が必要です。",
  );
  requireThat(
    (business.industry ? business.topics : settings.topics).length && config.allowedHosts.length,
    409,
    "SEARCH_TOPICS_REQUIRED",
    "個人情報を含まない検索テーマと出典ホストを設定してください。",
  );
  const notes = await all(
    ts,
    "SELECT customer_id,body FROM context_notes WHERE confirmed_by IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200",
  );
  const relevant: typeof notes = [];
  for (const note of notes) {
    try {
      const a = await assistantAccess(
        rt,
        tenant,
        oa,
        actor ||
          (
            await one(
              await rt.openDatabase(tenant, "", "common"),
              "SELECT owner_user_id FROM customers WHERE id=?",
              [note.customer_id],
            )
          )?.owner_user_id,
        note.customer_id,
      );
      if (a.customer?.opt_out || a.customer?.mode !== "ai") continue;
      relevant.push(note);
    } catch {}
  }
  const topics = (business.industry ? business.topics : settings.topics).filter((t: string) =>
    relevant.some((n) => norm(n.body).includes(norm(t))),
  );
  if (!topics.length)
    return {
      imported: 0,
      rejected: 0,
      detail: "検索テーマに関連する確認済み商談メモがありません。",
    };
  // 1回につき1テーマ、6時間のローテーション。氏名・生の商談記録はプロバイダへ送らない。
  const topic =
    topics[
      Math.floor(Date.now() / (settings.searchIntervalMinutes * 60000)) %
        topics.length
    ];
  requireThat(
    await claimBudget(ts, "search"),
    429,
    "SEARCH_LIMIT",
    "設定した検索間隔に応じた本日の取得上限です。次の日次枠または設定を確認してください。",
  );
  let imported = 0,
    rejected = 0;
  try {
    const results = searchResultsSchema.parse(
      await gateway(rt, config, {
        operation: "search",
        query: topic,
        language: "ja",
        limit: 5,
        publishedAfter: new Date(Date.now() - 7 * day).toISOString(),
      }),
    );
    const seen = new Set<string>();
    for (const result of results.results) {
      try {
        const url = publicUrl(result.url);
        requireThat(
          config.allowedHosts.includes(new URL(url).hostname),
          422,
          "SOURCE_HOST_REJECTED",
          "許可された出典ではありません。",
        );
        if (seen.has(url)) {
          rejected++;
          continue;
        }
        seen.add(url);
        const article = validateArticle(
          await gateway(rt, config, { operation: "article", url }),
          { url, topic, allowedHosts: config.allowedHosts },
        );
        const published = Date.parse(article.publishedAt),
          retrieved = Date.parse(article.retrievedAt);
        const position = norm(article.content).indexOf(norm(topic));
        // 検索スニペットは根拠にしない。本文の該当箇所をそのまま保存。
        const excerpt = article.content.slice(
          Math.max(0, position - 100),
          Math.max(0, position - 100) + 1000,
        );
        const sourceId = `web-${(await digest(url)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
        const old = await one(
          ts,
          "SELECT data FROM assistant_sources WHERE id=?",
          [sourceId],
        );
        const input = sourceSchema.parse({
          id: sourceId,
          kind: "news",
          title: article.title,
          url,
          publishedAt: article.publishedAt,
          eventAt: article.eventAt,
          checkedAt: article.retrievedAt,
          expiresAt: new Date(
            Math.min(published + 7 * day, retrieved + day),
          ).toISOString(),
          summary: excerpt,
          tags: [topic],
          discovery: {
            publisher: article.publisher,
            excerpt,
            retrievedAt: article.retrievedAt,
            query: topic,
          },
        });
        // 同じ原文の再取得で既承認の出典版を変えない（期限前の24h内）。
        if (old) {
          const d = JSON.parse(old.data);
          if (
            d.title === input.title &&
            d.summary === input.summary &&
            d.publishedAt === input.publishedAt &&
            d.eventAt === input.eventAt &&
            d.expiresAt > now()
          ) {
            rejected++;
            continue;
          }
        }
        await upsertSource(rt, tenant, oa, input);
        imported++;
      } catch {
        rejected++;
      }
    }
    await recordRun(
      ts,
      "search",
      "completed",
      `「${topic}」: ${imported}件保存、${rejected}件は重複・日付・出典・関連性の確認により除外。`,
    );
    return { imported, rejected };
  } catch {
    await recordRun(
      ts,
      "search",
      "failed",
      "検索アダプタから取得できませんでした。既存の記事は有効期限内のみ利用します。",
    );
    return {
      imported: 0,
      rejected: 0,
      error:
        "検索アダプタの取得に失敗しました。接続先と応答形式をご確認ください。",
    };
  }
}

// 管理元からの全件スナップショット。消えた商品は販売可と見なさず、古い承認も無効化する。
export async function syncAssistantFeed(
  rt: Runtime,
  tenant: string,
  oa: string,
) {
  const config = rt.assistantFeeds?.[`${tenant}:${oa}`],
    ts = await rt.openDatabase(tenant, oa, "tsunagu");
  requireThat(
    config,
    409,
    "FEED_NOT_CONNECTED",
    "商品・ニュースJSONフィードは未接続です。",
  );
  requireThat(
    await claimBudget(ts, "feed"),
    429,
    "FEED_LIMIT",
    "設定した同期間隔に応じた本日の取得上限です。次の日次枠または設定を確認してください。",
  );
  const startedAt = now();
  try {
    const rows = validateCatalog(await gateway(rt, config));
    const ids = new Set(rows.map((r) => `feed-${r.id}`));
    for (const row of rows)
      await upsertSource(
        rt,
        tenant,
        oa,
        { ...row, id: `feed-${row.id}` },
        true,
      );
    for (const old of await all(
      ts,
      "SELECT id FROM assistant_sources WHERE kind='product' AND id LIKE 'feed-%'",
    ))
      if (!ids.has(old.id))
        await ts.query(
          "UPDATE assistant_sources SET data=json_set(data,'$.status','unpublished','$.stock',0),version=version+1,updated_at=? WHERE id=? AND updated_at<=?",
          [now(), old.id, startedAt],
        );
    await recordRun(
      ts,
      "feed",
      "completed",
      `${rows.length}件を同期。削除商品は非公開として反映。`,
    );
    return { ok: true, count: rows.length };
  } catch {
    await recordRun(
      ts,
      "feed",
      "failed",
      "商品・ニュースフィードの取得または検証に失敗しました。再同期が必要です。",
    );
    // 取得失敗時に、管理元の商品在庫を確認済みと表示し続けない。
    await ts.query(
      "UPDATE assistant_sources SET data=json_set(data,'$.status','unknown'),version=version+1,updated_at=? WHERE kind='product' AND id LIKE 'feed-%'",
      [now()],
    );
    return {
      ok: false,
      count: 0,
      error:
        "情報元の取得・検証に失敗しました。フィード商品の案内を停止しました。",
    };
  }
}

export async function refreshAssistantSources(
  rt: Runtime,
  tenant: string,
  oa: string,
) {
  if (
    (await one(rt.db, "SELECT state FROM tenants WHERE id=?", [tenant]))
      ?.state !== "active"
  )
    return;
  const ts = await rt.openDatabase(tenant, oa, "tsunagu");
  if (
    !(
      await one(ts, "SELECT enabled FROM assistant_settings WHERE id='default'")
    )?.enabled
  )
    return;
  const settings = await automationSettings(ts);
  for (const [kind, enabled, configured, run] of [
    [
      "search",
      settings.autoSearch,
      rt.assistantSearch?.[`${tenant}:${oa}`],
      () => discoverAssistantNews(rt, tenant, oa),
    ],
    [
      "feed",
      settings.autoFeed,
      rt.assistantFeeds?.[`${tenant}:${oa}`],
      () => syncAssistantFeed(rt, tenant, oa),
    ],
  ] as const) {
    if (!enabled || !configured) continue;
    const backoff = await one(
      ts,
      "SELECT failures,next_at FROM assistant_source_backoff WHERE kind=?",
      [kind],
    );
    if (backoff?.next_at > now()) continue;
    const interval =
      kind === "search"
        ? settings.searchIntervalMinutes
        : settings.feedIntervalMinutes;
    const slot = `auto-${kind}:${interval}:${Math.floor(Date.now() / (interval * 60000))}`;
    const claim = await ts.query(
      "INSERT OR IGNORE INTO assistant_runs(id,kind,state,detail,created_at) VALUES (?,?, 'scheduled','定期取得枠',?) RETURNING id",
      [slot, `schedule-${kind}`, now()],
    );
    if (claim.rows.length)
      try {
        const result = await run();
        if (
          result &&
          (("ok" in result && result.ok === false) ||
            ("error" in result && result.error))
        )
          throw new Error("Source deferred");
        await ts.query("DELETE FROM assistant_source_backoff WHERE kind=?", [
          kind,
        ]);
      } catch {
        const failures = (backoff?.failures || 0) + 1;
        const delay = Math.min(
          86400000,
          interval * 60000 * 2 ** Math.min(failures - 1, 6),
        );
        await ts.query(
          "INSERT INTO assistant_source_backoff(kind,failures,next_at) VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET failures=excluded.failures,next_at=excluded.next_at",
          [kind, failures, new Date(Date.now() + delay).toISOString()],
        );
        await recordRun(
          ts,
          kind,
          "failed",
          "定期取得を実行できませんでした。接続設定・日次上限を確認してください。",
        );
      }
  }
}
