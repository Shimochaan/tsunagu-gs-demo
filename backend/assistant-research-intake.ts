import type { Runtime } from "./runtime.ts";
import { now } from "./db.ts";
import { requireThat, digest } from "./security.ts";
import { publicUrl, validateArticle } from "./assistant-discovery.ts";
import { upsertSource } from "./assistant.ts";
import type { GoogleSettings } from "./assistant-google-store.ts";
const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
// The model's publication date/summary are never promoted as evidence. Parse the publisher page.
export function articleFromHTML(
  html: string,
  url: string,
  topic: string,
  allowedHosts: string[],
) {
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)];
  const attr = (tag: string, name: string) =>
    tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
  const value = (key: string) =>
    meta.find((m) =>
      [
        attr(m[0], "property"),
        attr(m[0], "name"),
        attr(m[0], "itemprop"),
      ].includes(key),
    )?.[0];
  const metadata = (key: string) => {
    const tag = value(key);
    return tag ? decode(attr(tag, "content") || "") : "";
  };
  let published =
      metadata("article:published_time") ||
      metadata("datePublished") ||
      metadata("pubdate"),
    title = metadata("og:title");
  const visit = (v: any): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (
      ["Article", "NewsArticle", "BlogPosting"].some((t) =>
        [v["@type"]].flat().includes(t),
      )
    ) {
      published ||= v.datePublished || "";
      title ||= v.headline || "";
    }
    if (v["@graph"]) visit(v["@graph"]);
  };
  for (const m of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(m[1]));
    } catch {}
  }
  if (/^\d{4}-\d\d-\d\d$/.test(published)) published += "T00:00:00+09:00"; // Publisher date, Japan-only research topics; day precision.
  requireThat(
    typeof published === "string" &&
      /^\d{4}-\d\d-\d\dT/.test(published) &&
      /(?:Z|[+-]\d\d:\d\d)$/.test(published),
    422,
    "ARTICLE_DATE_UNVERIFIED",
    "元記事の公開日時を独立確認できません。",
  );
  title ||= decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const content = decode(
    html
      .replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return validateArticle(
    {
      url,
      title: title.trim().slice(0, 200),
      publisher: new URL(url).hostname,
      content: content.slice(0, 50000),
      publishedAt: new Date(published).toISOString(),
      eventAt: null,
      retrievedAt: now(),
    },
    { url, topic, allowedHosts },
  );
}
async function readHTML(response: Response) {
  requireThat(
    response.ok &&
      /text\/html|application\/xhtml/.test(
        response.headers.get("content-type") || "",
      ),
    422,
    "ARTICLE_FORMAT",
    "原文HTMLを取得できません。",
  );
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      requireThat(
        size <= 500000,
        413,
        "ARTICLE_TOO_LARGE",
        "原文が大きすぎます。",
      );
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
export async function intakeResearch(
  rt: Runtime,
  t: string,
  oa: string,
  settings: GoogleSettings,
  citations: { url: string }[],
) {
  let imported = 0;
  const rejected: { url: string; code: string }[] = [];
  for (const citation of citations.slice(0, 3)) {
    try {
      const url = publicUrl(citation.url),
        host = new URL(url).hostname;
      requireThat(
        settings.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`)),
        422,
        "SOURCE_HOST_REJECTED",
        "許可された出典ではありません。",
      );
      const html = await readHTML(
        await rt.externalFetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { Accept: "text/html" },
        }),
      );
      const topic = settings.topics.find((topic) =>
        decode(html).normalize("NFKC").includes(topic.normalize("NFKC")),
      );
      requireThat(
        topic,
        422,
        "NOT_RELEVANT",
        "元記事にテーマの根拠がありません。",
      );
      const a = articleFromHTML(html, url, topic, [host]);
      const index = a.content
        .normalize("NFKC")
        .indexOf(topic.normalize("NFKC"));
      const excerpt = a.content.slice(
        Math.max(0, index - 80),
        Math.max(0, index - 80) + 1000,
      );
      await upsertSource(rt, t, oa, {
        id: `web-${(await digest(url)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`,
        kind: "news",
        title: a.title,
        url,
        publishedAt: a.publishedAt,
        checkedAt: a.retrievedAt,
        expiresAt: new Date(
          Math.min(
            Date.parse(a.publishedAt) + 7 * 86400000,
            Date.now() + 86400000,
          ),
        ).toISOString(),
        summary: excerpt,
        tags: [topic],
        discovery: {
          publisher: a.publisher,
          excerpt,
          retrievedAt: a.retrievedAt,
          query: topic,
        },
      });
      imported++;
    } catch (e: any) {
      rejected.push({
        url: citation.url,
        code: e.code || "ARTICLE_UNVERIFIED",
      });
    }
  }
  return {
    imported,
    rejected,
    verification: imported ? "publisher_verified" : "needs_review",
  };
}
