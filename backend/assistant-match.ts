import { parse, json, type Row } from "./db.ts";
import { digest } from "./security.ts";
export const normalizeTag = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^駅徒歩/, "徒歩")
    .trim();
export function hasPropertyTag(data: Row, tag: string) {
  const target = normalizeTag(tag),
    tags = (data.tags || []).map(normalizeTag);
  if (/^\d+s?[ldkr]+$/i.test(target) && data.property?.layout) return normalizeTag(data.property.layout) === target;
  if (/^(所有権|定期借地権|普通借地権|借地権)$/.test(target) && data.property?.tenure) return target === '借地権' ? /借地権/.test(data.property.tenure) : normalizeTag(data.property.tenure) === target;
  const walk = target.match(/^徒歩(\d+)分以内$/);
  if (walk && Number.isFinite(data.property?.walkingMinutes))
    return data.property.walkingMinutes <= Number(walk[1]);
  return tags.includes(target);
}
export function sourceContradiction(data: Row) {
  if ((data.absentTags || []).some((tag: string) => hasPropertyTag(data, tag)))
    return "該当タグと不存在確認タグが矛盾しています。";
  if (
    data.kind === "product" &&
    (data.tags || []).some((t: string) => normalizeTag(t) === "所有権") &&
    (data.tags || []).some((t: string) => /借地権/.test(t))
  )
    return "所有権と借地権の表記が矛盾しています。";
  return null;
}
export function matchesWish(data: Row, wish: Row) {
  if (sourceContradiction(data)) return false;
  if (
    !data.area ||
    data.price === null ||
    normalizeTag(data.area) !== normalizeTag(wish.area) ||
    data.price > wish.maxPrice
  )
    return false;
  if (!wish.required.every((tag: string) => hasPropertyTag(data, tag)))
    return false;
  return !wish.excluded.some(
    (tag: string) =>
      hasPropertyTag(data, tag) ||
      !(
        (data.absentTags || []).map(normalizeTag).includes(normalizeTag(tag)) ||
        (/借地権/.test(tag) && data.property?.tenure === "所有権")
      ),
  );
}
export async function sourceContentHash(source: Row) {
  const d = source.data ? parse(source.data) : source;
  // A freshness check, worksheet formatting or timestamp edit is not a new opportunity.
  const { checkedAt, expiresAt, publishedAt, discovery, ...content } = d;
  return digest(
    json({
      ...content,
      tags: [...(content.tags || [])].map(normalizeTag).sort(),
      absentTags: [...(content.absentTags || [])].map(normalizeTag).sort(),
      ...(discovery
        ? {
            discovery: {
              publisher: discovery.publisher,
              excerpt: discovery.excerpt,
              query: discovery.query,
            },
          }
        : {}),
    }),
  );
}
