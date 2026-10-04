import { z } from "zod";
import { one, now, type Database } from "./db.ts";

export const automationSchema = z
  .object({
    autoDraft: z.boolean().default(false),
    autoSearch: z.boolean().default(false),
    autoFeed: z.boolean().default(false),
    searchIntervalMinutes: z
      .union([
        z.literal(60),
        z.literal(180),
        z.literal(360),
        z.literal(720),
        z.literal(1440),
      ])
      .default(360),
    feedIntervalMinutes: z
      .union([
        z.literal(15),
        z.literal(30),
        z.literal(60),
        z.literal(360),
        z.literal(1440),
      ])
      .default(360),
    topics: z
      .array(
        z
          .string()
          .trim()
          .min(2)
          .max(40)
          .regex(/^[\p{L}\p{N} ・ー-]+$/u),
      )
      .max(5)
      .default([]),
  })
  .strict();
export async function automationSettings(db: Database) {
  const row = await one(
    db,
    "SELECT data FROM assistant_automation WHERE id='default'",
  );
  return automationSchema.parse(row ? JSON.parse(row.data) : {});
}
// 試行開始時に枠を確保。失敗時も返さず、並行実行や再試行による費用超過を防ぐ。
export async function claimBudget(
  db: Database,
  kind: "ai" | "search" | "feed",
) {
  const settings = await automationSettings(db);
  const limit =
    kind === "ai"
      ? 20
      : Math.ceil(
          1440 /
            (kind === "search"
              ? settings.searchIntervalMinutes
              : settings.feedIntervalMinutes),
        );
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const result = await db.query(
    "INSERT INTO assistant_budget(kind,day,used) VALUES (?,?,1) ON CONFLICT(kind,day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used",
    [kind, day, limit],
  );
  return !!result.rows.length;
}
export async function recordRun(
  db: Database,
  kind: string,
  state: string,
  detail: string,
) {
  await db.query(
    "INSERT INTO assistant_runs(id,kind,state,detail,created_at) VALUES (?,?,?,?,?)",
    [crypto.randomUUID(), kind, state, detail, now()],
  );
}
