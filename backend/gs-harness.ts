import { demoProofDDL, receiveDemoProof } from "./gs-demo-proof.ts";
import type { Database, Query } from "./db.ts";
import { all, one } from "./db.ts";
import { digest, verify, requireThat, AppError } from "./security.ts";
import { z } from "zod";

export interface GsHarnessConfig {
  enabled: boolean;
  selfDemo?: boolean;
  accountId?: string;
  channelId?: string;
  destination?: string;
  apiToken?: string;
  channelSecret?: string;
  channelAccessToken?: string;
  profileFetch?: typeof fetch;
}
export const gsHarnessDDL = [
  demoProofDDL,
  `CREATE TABLE IF NOT EXISTS gs_line_scope (id TEXT PRIMARY KEY,account_id TEXT NOT NULL,channel_id TEXT NOT NULL,destination TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gs_line_events (id TEXT PRIMARY KEY,hash TEXT NOT NULL,claim TEXT NOT NULL,received_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gs_line_friends (id TEXT PRIMARY KEY,line_user_id TEXT NOT NULL UNIQUE,is_following INTEGER NOT NULL,event_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gs_line_profiles (friend_id TEXT PRIMARY KEY,display_name TEXT,checked_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gs_line_messages (id TEXT PRIMARY KEY,friend_id TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS gs_line_messages_friend ON gs_line_messages(friend_id,created_at)`,
];
const lineId = z.string().regex(/^U[0-9a-f]{32}$/);
const eventSchema = z.object({
  replyToken: z.string().max(500).optional(),
  webhookEventId: z.string().min(1).max(200),
  type: z.enum(["follow", "unfollow", "message"]),
  timestamp: z.number().int().min(0).max(8640000000000000),
  source: z.object({ type: z.literal("user"), userId: lineId }),
  message: z
    .object({
      id: z.string().min(1).max(200),
      type: z.literal("text"),
      text: z.string().max(5000),
    })
    .optional(),
});
const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
async function sameSecret(a: string, b: string) {
  const x = await digest(a),
    y = await digest(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
async function bodyText(request: Request) {
  const reader = request.body?.getReader();
  requireThat(reader, 400, "BODY_REQUIRED", "Body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader!.read();
      if (r.done) break;
      size += r.value.byteLength;
      requireThat(size <= 128000, 413, "BODY_TOO_LARGE", "Body too large");
      chunks.push(r.value);
    }
  } finally {
    await reader!.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function ensureAccountScope(db: Database, config: GsHarnessConfig) {
  await db.query(
    "INSERT OR IGNORE INTO gs_line_scope(id,account_id,channel_id,destination) VALUES ('default',?,?,?)",
    [config.accountId!, config.channelId!, config.destination!],
  );
  const bound = await one(db, "SELECT * FROM gs_line_scope WHERE id='default'");
  requireThat(
    bound?.account_id === config.accountId &&
      bound?.channel_id === config.channelId &&
      bound?.destination === config.destination,
    409,
    "HARNESS_SCOPE_CHANGED",
    "Account configuration changed; use a separately reviewed database for a different OA",
  );
}

// Receive/read only. Optional profile reads never call push/reply or mutate LINE.
async function profileName(db: Database, config: GsHarnessConfig, row: Record<string, any>) {
  const cached = await one(db, "SELECT * FROM gs_line_profiles WHERE friend_id=?", [row.id]);
  if (!row.is_following || !config.channelAccessToken) return cached?.display_name || null;
  const ttl = cached?.display_name ? 86400000 : 300000;
  if (cached && Date.now() - cached.checked_at < ttl) return cached.display_name;
  let name: string | null = null;
  try {
    const read = async (path: string) => {
      const r = await (config.profileFetch || fetch)(`https://api.line.me/v2/bot/${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${config.channelAccessToken}` },
        redirect: "manual", signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) throw new Error("PROFILE_UNAVAILABLE");
      return await r.json() as Record<string, unknown>;
    };
    // Pin the token to this customer OA before accessing any user's profile.
    const bot = await read("info");
    if (bot.userId !== config.destination) throw new Error("PROFILE_ACCOUNT_MISMATCH");
    const profile = await read(`profile/${encodeURIComponent(row.line_user_id)}`);
    if (profile.userId === row.line_user_id && typeof profile.displayName === "string")
      name = profile.displayName.trim().slice(0, 200) || null;
  } catch { /* A failed profile lookup must not prevent receiving/importing messages. */ }
  await db.query(
    "INSERT INTO gs_line_profiles(friend_id,display_name,checked_at) VALUES (?,?,?) ON CONFLICT(friend_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,gs_line_profiles.display_name),checked_at=excluded.checked_at",
    [row.id, name, Date.now()],
  );
  return name || cached?.display_name || null;
}
export async function gsHarnessFetch(
  request: Request,
  db: Database | undefined,
  config: GsHarnessConfig,
) {
  if (
    !config.enabled ||
    !db ||
    !config.accountId ||
    !config.channelId ||
    !lineId.safeParse(config.destination).success ||
    !config.apiToken ||
    config.apiToken.length < 32 ||
    !config.channelSecret ||
    config.channelSecret.length < 16
  )
    return response(
      {
        success: false,
        error: "HARNESS_NOT_CONFIGURED",
        deliveryEnabled: false,
        connected: false,
      },
      503,
    );
  try {
    const u = new URL(request.url);
    if (u.pathname === "/webhooks/line" && request.method === "POST") {
      const raw = await bodyText(request);
      requireThat(
        await verify(
          config.channelSecret,
          raw,
          request.headers.get("x-line-signature") || "",
        ),
        401,
        "INVALID_SIGNATURE",
        "Invalid signature",
      );
      const body = z
        .object({ destination: lineId, events: z.array(z.unknown()).max(100) })
        .parse(JSON.parse(raw));
      requireThat(
        body.destination === config.destination,
        403,
        "ACCOUNT_MISMATCH",
        "Account mismatch",
      );
      await ensureAccountScope(db, config);
      // Unsupported/group/nontext events are ignored; no profile/image fetches or reply tokens are stored.
      const events = body.events
        .map((e) => eventSchema.safeParse(e))
        .filter((r) => r.success)
        .map((r) => r.data!);
      let inserted = 0;
      for (const event of events) {
        if (event.type === "message" && !event.message) continue;
        const eventHash = await digest(JSON.stringify(event));
        const old = await one(
          db,
          "SELECT hash FROM gs_line_events WHERE id=?",
          [event.webhookEventId],
        );
        requireThat(
          !old || old.hash === eventHash,
          409,
          "EVENT_CONFLICT",
          "Event ID conflict",
        );
        const friendId = (
          await digest(`${config.accountId}:${event.source.userId}`)
        ).replace(/[^a-zA-Z0-9]/g, "");
        const claim = crypto.randomUUID(),
          time = new Date(event.timestamp).toISOString();
        const guard =
          "EXISTS(SELECT 1 FROM gs_line_events WHERE id=? AND claim=?)";
        const queries: Query[] = [
          {
            sql: "INSERT OR IGNORE INTO gs_line_events(id,hash,claim,received_at) VALUES (?,?,?,?)",
            params: [
              event.webhookEventId,
              eventHash,
              claim,
              new Date().toISOString(),
            ],
          },
          {
            sql: `INSERT INTO gs_line_friends(id,line_user_id,is_following,event_at) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET is_following=excluded.is_following,event_at=excluded.event_at WHERE excluded.event_at>gs_line_friends.event_at`,
            params: [
              friendId,
              event.source.userId,
              event.type === "unfollow" ? 0 : 1,
              event.timestamp,
              event.webhookEventId,
              claim,
            ],
          },
        ];
        if (event.type === "message" && !(config.selfDemo && /^体験\s+[0-9a-f]{64}$/.test(event.message!.text)))
          queries.push({
            sql: `INSERT OR IGNORE INTO gs_line_messages(id,friend_id,content,created_at) SELECT ?,?,?,? WHERE ${guard}`,
            params: [
              event.message!.id,
              friendId,
              event.message!.text,
              time,
              event.webhookEventId,
              claim,
            ],
          });
        const result = await db.batch(queries);
        inserted += result[0].changes;
        if(result[0].changes) await receiveDemoProof(db,config,event,friendId);
      }
      return response({ success: true, received: inserted });
    }
    requireThat(
      request.method === "GET",
      405,
      "SEND_DISABLED",
      "Only receive and read are supported",
    );
    requireThat(
      await sameSecret(
        request.headers.get("authorization") || "",
        `Bearer ${config.apiToken}`,
      ),
      401,
      "UNAUTHORIZED",
      "Unauthorized",
    );
    await ensureAccountScope(db, config);
    const success = (data: unknown) => response({ success: true, data });
    const friend = async (row: Record<string, any>) => ({
      id: row.id,
      lineUserId: row.line_user_id,
      displayName: await profileName(db, config, row),
      lineAccountId: config.accountId,
      isFollowing: !!row.is_following,
    });
    if (config.selfDemo && u.pathname === "/api/demo-proof") {
      const hash=z.string().min(40).max(64).parse(u.searchParams.get("hash"));
      const proof=await one(db,"SELECT p.* FROM gs_demo_proofs p JOIN gs_line_friends f ON f.id=p.friend_id WHERE p.pair_hash=? AND p.state='ready' AND p.expires_at>? AND f.is_following=1",[hash,new Date().toISOString()]);
      return success(proof);
    }
    if (u.pathname === "/api/line-accounts")
      return success([
        { id: config.accountId, channelId: config.channelId, isActive: true },
      ]);
    if (u.pathname === "/api/friends") {
      requireThat(
        u.searchParams.get("lineAccountId") === config.accountId,
        403,
        "ACCOUNT_MISMATCH",
        "Account mismatch",
      );
      const offset = z.coerce
          .number()
          .int()
          .min(0)
          .max(1000000)
          .parse(u.searchParams.get("offset") || "0"),
        limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(u.searchParams.get("limit") || "50");
      // List reads use cached names. Importing an individual friend refreshes
      // their profile, keeping this paginated endpoint bounded and inexpensive.
      return success({
        items: (
          await all(
            db,
            "SELECT f.*,p.display_name FROM gs_line_friends f LEFT JOIN gs_line_profiles p ON p.friend_id=f.id ORDER BY f.id LIMIT ? OFFSET ?",
            [limit, offset],
          )
        ).map(row => ({ id: row.id, lineUserId: row.line_user_id, displayName: row.display_name || null, lineAccountId: config.accountId, isFollowing: !!row.is_following })),
        total: (await one(db, "SELECT COUNT(*) AS n FROM gs_line_friends")).n,
      });
    }
    const match = u.pathname.match(
      /^\/api\/friends\/([a-zA-Z0-9]+)(\/messages)?$/,
    );
    if (match) {
      const row = await one(db, "SELECT * FROM gs_line_friends WHERE id=?", [
        match[1],
      ]);
      requireThat(row, 404, "FRIEND_NOT_FOUND", "Friend not found");
      if (!match[2]) return success(await friend(row));
      const rows = await all(
        db,
        "SELECT * FROM gs_line_messages WHERE friend_id=? ORDER BY created_at DESC,id DESC LIMIT 200",
        [row.id],
      );
      return success(
        rows.reverse().map((m) => ({
          id: m.id,
          direction: "incoming",
          messageType: "text",
          content: m.content,
          createdAt: m.created_at,
        })),
      );
    }
    return response({ success: false, error: "NOT_FOUND" }, 404);
  } catch (error) {
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 500;
    return response(
      {
        success: false,
        error:
          error instanceof AppError
            ? error.code
            : status === 400
              ? "INVALID_REQUEST"
              : "HARNESS_FAILED",
      },
      status,
    );
  }
}
