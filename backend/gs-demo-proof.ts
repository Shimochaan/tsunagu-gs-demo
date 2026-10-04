import { type Database, one, now, id, json } from "./db.ts";
import { digest } from "./security.ts";
import type { GsHarnessConfig } from "./gs-harness.ts";
export const demoProofDDL = `CREATE TABLE IF NOT EXISTS gs_demo_proofs (pair_hash TEXT PRIMARY KEY,line_user_id TEXT NOT NULL,friend_id TEXT NOT NULL,confirm_hash TEXT NOT NULL,state TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)`;
// A signed direct message proves possession only after its reply code is entered in the initiating browser.
export async function receiveDemoProof(
  db: Database,
  config: GsHarnessConfig,
  event: any,
  friendId: string,
) {
  if (
    !config.selfDemo ||
    !config.channelAccessToken ||
    event.type !== "message" ||
    !/^体験\s+[0-9a-f]{64}$/.test(event.message?.text || "") ||
    !event.replyToken ||
    Math.abs(Date.now() - event.timestamp) > 300000
  )
    return;
  const hash = await digest(event.message.text.trim().split(/\s+/)[1]);
  const code = id().replaceAll("-", "").slice(0, 12),
    at = now();
  const claim = await db.query(
    `INSERT OR IGNORE INTO gs_demo_proofs(pair_hash,line_user_id,friend_id,confirm_hash,state,expires_at,created_at) SELECT ?,?,?,?,'sending',?,? WHERE (SELECT COUNT(*) FROM gs_demo_proofs WHERE line_user_id=? AND created_at>?)<5`,
    [
      hash,
      event.source.userId,
      friendId,
      await digest(code),
      new Date(Date.now() + 600000).toISOString(),
      at,
      event.source.userId,
      new Date(Date.now() - 86400000).toISOString(),
    ],
  );
  if (!claim.changes) return;
  try {
    const transport = config.profileFetch || fetch;
    const headers = {
      Authorization: `Bearer ${config.channelAccessToken}`,
      "Content-Type": "application/json",
    };
    const bot = await transport("https://api.line.me/v2/bot/info", {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!bot.ok || ((await bot.json()) as any).userId !== config.destination)
      throw Error("BOT_MISMATCH");
    const r = await transport("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers,
      body: json({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: `つなぐ体験用の本人確認コード：${code}\nGoogleログインした体験画面の「顧客用LINE」へ入力してください。このコードは他の人に教えないでください。10分間有効です。`,
          },
        ],
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw Error("REPLY_FAILED");
    await db.query(
      "UPDATE gs_demo_proofs SET state='ready' WHERE pair_hash=? AND state='sending'",
      [hash],
    );
  } catch {
    await db.query(
      "UPDATE gs_demo_proofs SET state='failed' WHERE pair_hash=? AND state='sending'",
      [hash],
    );
  }
}
