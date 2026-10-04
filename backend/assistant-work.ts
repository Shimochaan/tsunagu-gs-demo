import { all, one, now, id, type Database, type Row } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import { scanAssistant } from "./assistant.ts";
import { databaseScope } from "./database-cache.ts";

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
export const WORK_BATCH = 20;
export const SWEEP_BATCH = 100;
const enqueue = (customer: string, priority: number) => ({
  sql: "INSERT INTO assistant_work_queue(customer_id,priority) VALUES (?,?) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1,due_at='',priority=MIN(priority,excluded.priority),attempts=0",
  params: [customer, priority],
});
async function ingest(db: Database, ts: Database, table: string, oa?: string) {
  const cursor =
    (
      await one(ts, "SELECT cursor FROM assistant_ingest_cursors WHERE id=?", [
        table,
      ])
    )?.cursor || "";
  const load = async (after: string) => {
    const result = await db.batch([
      {sql:`SELECT customer_id,revision FROM ${table} WHERE customer_id>?${oa ? " AND oa_id=?" : ""} ORDER BY customer_id LIMIT 100`,params:[after,...(oa ? [oa] : [])]},
      ...(!oa ? [{sql:"SELECT * FROM assistant_meeting_due WHERE due_at<=? ORDER BY due_at,event_id LIMIT 20",params:[now()]}] : []),
    ]);
    const meetings=result[1]?.rows || [];
    if(meetings.length) {
      await ts.batch(meetings.map(e=>enqueue(e.customer_id,1)));
      await db.batch(meetings.map(e=>({sql:"DELETE FROM assistant_meeting_due WHERE event_id=? AND due_at=?",params:[e.event_id,e.due_at]})));
    }
    return result[0].rows;
  };
  let rows = await load(cursor);
  if (!rows.length && cursor) rows = await load("");
  if (!rows.length) return;
  await ts.batch(rows.map((r) => enqueue(r.customer_id, oa ? 1 : 0)));
  await ts.query(
    "INSERT INTO assistant_ingest_cursors(id,cursor) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor",
    [table, rows.length === 100 ? rows.at(-1)!.customer_id : ""],
  );
  // Ack only the exact revision transferred. A concurrent update or a crash cannot lose work.
  await db.batch(
    rows.map((r) => ({
      sql: `DELETE FROM ${table} WHERE customer_id=? AND revision=?${oa ? " AND oa_id=?" : ""}`,
      params: [r.customer_id, r.revision, ...(oa ? [oa] : [])],
    })),
  );
}
async function sweep(common: Database, ts: Database, oa: string) {
  let state = await one(ts, "SELECT * FROM assistant_sweep WHERE id='default'");
  if (!state) return;
  if (state.active_revision === state.completed_revision) {
    if (state.revision === state.completed_revision && state.next_at > now())
      return;
    await ts.query(
      "UPDATE assistant_sweep SET revision=MAX(revision,completed_revision+1),active_revision=MAX(revision,completed_revision+1),cursor='' WHERE id='default' AND active_revision=completed_revision",
    );
    state = await one(ts, "SELECT * FROM assistant_sweep WHERE id='default'");
  }
  const rows = await all(
    common,
    "SELECT DISTINCT customer_id AS id FROM customer_links WHERE oa_id=? AND state='confirmed' AND customer_id>? ORDER BY customer_id LIMIT ?",
    [oa, state!.cursor, SWEEP_BATCH],
  );
  const done = rows.length < SWEEP_BATCH;
  if (rows.length) await ts.batch(rows.map((r) => enqueue(r.id, 2)));
  await ts.query(
    "UPDATE assistant_sweep SET cursor=?,completed_revision=CASE WHEN ? THEN active_revision ELSE completed_revision END,next_at=? WHERE id='default' AND active_revision=?",
    [
      rows.at(-1)?.id || "",
      Number(done),
      later(6 * 3600000),
      state!.active_revision,
    ],
  );
}
export async function processAssistantWork(
  input: Runtime,
  tenant: string,
  oa: string,
  control: { shouldYield?: () => boolean; allowAutoAI?: boolean } = {},
) {
  const rt = databaseScope(input),
    ts = await rt.openDatabase(tenant, oa, "tsunagu");
  if (
    !(
      await one(ts, "SELECT enabled FROM assistant_settings WHERE id='default'")
    )?.enabled
  )
    return { processed: 0, created: 0 };
  if (
    (await one(rt.db, "SELECT state FROM tenants WHERE id=?", [tenant]))
      ?.state !== "active"
  )
    return { processed: 0, created: 0 };
  const [common, h] = await Promise.all([
    rt.openDatabase(tenant, "", "common"),
    rt.openDatabase(tenant, oa, "harness"),
  ]);
  await ingest(h, ts, "assistant_message_changes");
  await ingest(common, ts, "assistant_customer_changes", oa);
  await sweep(common, ts, oa);
  // Due tracking and expiry share one tenant RPC. Both are bounded index reads.
  const dueResults = await ts.batch([
    {
      sql: "INSERT INTO assistant_work_queue(customer_id,priority) SELECT customer_id,1 FROM followup_journeys WHERE next_at IS NOT NULL AND next_at<=? ORDER BY next_at,customer_id LIMIT 20 ON CONFLICT(customer_id) DO NOTHING",
      params: [now()],
    },
    {
      sql: "SELECT q.proposal_id AS id,p.version,p.state FROM assistant_expiry_queue q LEFT JOIN proposals p ON p.id=q.proposal_id WHERE q.due_at<=? ORDER BY q.due_at,q.proposal_id LIMIT 20",
      params: [now()],
    },
  ]);
  const expired = dueResults[1].rows;
  if (expired.length) {
    await ts.batch(
      expired.map((p) => ({
        sql: "UPDATE proposals SET state='expired',hold_reason='提案の有効期限が切れています。' WHERE id=? AND version=? AND state IN ('pending','approved','held')",
        params: [p.id, p.version ?? 0],
      })),
    );
    await h.batch(
      expired.map((p) => ({
        sql: "UPDATE outbox SET state='cancelled',error_code='PROPOSAL_EXPIRED' WHERE proposal_id=? AND state IN ('pending','held')",
        params: [p.id],
      })),
    );
  }
  if (expired.length)
    await ts.batch(
      expired.map((p) => ({
        sql: "DELETE FROM assistant_expiry_queue WHERE proposal_id=? AND due_at<=?",
        params: [p.id, now()],
      })),
    );
  const due = "due_at<=? AND (lease_until IS NULL OR lease_until<=?)";
  const replies = await all(
    ts,
    `SELECT * FROM assistant_work_queue WHERE priority=0 AND ${due} ORDER BY due_at,sequence LIMIT 10`,
    [now(), now()],
  );
  const ordinary = await all(
    ts,
    `SELECT * FROM assistant_work_queue WHERE priority>0 AND ${due} ORDER BY due_at,sequence LIMIT ?`,
    [now(), now(), WORK_BATCH - replies.length],
  );
  let selected = [...replies, ...ordinary];
  if (replies.length && ordinary.length) {
    const turn = (
      await one(
        ts,
        "SELECT cursor FROM assistant_ingest_cursors WHERE id='lane-turn'",
      )
    )?.cursor;
    if (turn === "ordinary") selected = [...ordinary, ...replies];
    await ts.query(
      "INSERT INTO assistant_ingest_cursors(id,cursor) VALUES ('lane-turn',?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor",
      [turn === "ordinary" ? "reply" : "ordinary"],
    );
  }
  // Reply and ordinary queues each get capacity; unused ordinary capacity can serve replies.
  if (selected.length < WORK_BATCH)
    selected.push(
      ...(await all(
        ts,
        `SELECT * FROM assistant_work_queue WHERE priority=0 AND ${due}${replies.length ? ` AND customer_id NOT IN (${replies.map(() => "?").join(",")})` : ""} ORDER BY due_at,sequence LIMIT ?`,
        [
          now(),
          now(),
          ...replies.map((r) => r.customer_id),
          WORK_BATCH - selected.length,
        ],
      )),
    );
  if (!selected.length) return { processed: 0, created: 0 };
  const token = id();
  const claims = await ts.batch(
    selected.map((r) => ({
      sql: "UPDATE assistant_work_queue SET lease_id=?,lease_until=? WHERE customer_id=? AND revision=? AND (lease_until IS NULL OR lease_until<=?) RETURNING customer_id",
      params: [token, later(180000), r.customer_id, r.revision, now()],
    })),
  );
  const claimed = selected.filter((_, i) => claims[i].rows.length);
  if (!claimed.length) return { processed: 0, created: 0 };
  try {
    const result = await scanAssistant(
      rt,
      tenant,
      oa,
      undefined,
      undefined,
      claimed.map((r) => r.customer_id),
      {
        ...control,
        reviewRevisions: Object.fromEntries(
          claimed.map((r) => [r.customer_id, `${r.sequence}:${r.revision}`]),
        ),
      },
    );
    const processed = new Set(result.processed || []);
    await ts.batch(
      claimed.flatMap((r) => {
        if (!processed.has(r.customer_id))
          return [
            {
              sql: "UPDATE assistant_work_queue SET lease_id=NULL,lease_until=NULL WHERE customer_id=? AND lease_id=?",
              params: [r.customer_id, token],
            },
          ];
        const defer = result.deferred?.[r.customer_id];
        return defer
          ? [
              {
                sql: "UPDATE assistant_work_queue SET due_at=?,lease_id=NULL,lease_until=NULL,attempts=0 WHERE customer_id=? AND revision=? AND lease_id=?",
                params: [defer, r.customer_id, r.revision, token],
              },
              {
                sql: "UPDATE assistant_work_queue SET lease_id=NULL,lease_until=NULL WHERE customer_id=? AND lease_id=?",
                params: [r.customer_id, token],
              },
            ]
          : [
              {
                sql: "DELETE FROM assistant_work_queue WHERE customer_id=? AND revision=? AND lease_id=?",
                params: [r.customer_id, r.revision, token],
              },
              {
                sql: "UPDATE assistant_work_queue SET lease_id=NULL,lease_until=NULL WHERE customer_id=? AND lease_id=?",
                params: [r.customer_id, token],
              },
            ];
      }),
    );
    return {
      processed: processed.size,
      created: result.created,
      aiGenerated: result.aiGenerated || 0,
    };
  } catch (error) {
    await ts.batch(
      claimed.flatMap((r) => [
        {
          sql: "UPDATE assistant_work_queue SET attempts=attempts+1,due_at=?,lease_id=NULL,lease_until=NULL WHERE customer_id=? AND revision=? AND lease_id=?",
          params: [
            later(Math.min(3600000, 60000 * 2 ** Math.min(r.attempts, 6))),
            r.customer_id,
            r.revision,
            token,
          ],
        },
        {
          sql: "UPDATE assistant_work_queue SET lease_id=NULL,lease_until=NULL WHERE customer_id=? AND lease_id=?",
          params: [r.customer_id, token],
        },
      ]),
    );
    throw error;
  }
}
export async function assistantAccounts(rt: Runtime, limit = 16) {
  return all(
    rt.db,
    "SELECT a.id,a.tenant_id FROM accounts a JOIN tenants t ON t.id=a.tenant_id LEFT JOIN assistant_oa_work w ON w.tenant_id=a.tenant_id AND w.oa_id=a.id WHERE a.state='ready' AND t.state='active' AND COALESCE(w.next_at,'')<=? AND (w.lease_until IS NULL OR w.lease_until<=?) ORDER BY COALESCE(w.last_run_at,''),a.id LIMIT ?",
    [now(), now(), limit],
  );
}
export async function claimAssistantOA(
  rt: Runtime,
  tenant: string,
  oa: string,
  immediate = false,
) {
  const token = id();
  const r = await rt.db.query(
    "INSERT INTO assistant_oa_work(tenant_id,oa_id,lease_id,lease_until,last_run_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,oa_id) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,last_run_at=excluded.last_run_at WHERE (lease_until IS NULL OR lease_until<=?) AND (next_at<=? OR ?=1) RETURNING oa_id",
    [tenant, oa, token, later(300000), now(), now(), now(), Number(immediate)],
  );
  return r.rows.length ? token : null;
}
export async function finishAssistantOA(
  rt: Runtime,
  tenant: string,
  oa: string,
  token: string,
  failed = false,
) {
  const row = await one(
    rt.db,
    "SELECT failures FROM assistant_oa_work WHERE tenant_id=? AND oa_id=? AND lease_id=?",
    [tenant, oa, token],
  );
  if (!row) return;
  await rt.db.query(
    "UPDATE assistant_oa_work SET lease_id=NULL,lease_until=NULL,failures=?,next_at=? WHERE tenant_id=? AND oa_id=? AND lease_id=?",
    [
      failed ? row.failures + 1 : 0,
      failed
        ? later(Math.min(3600000, 60000 * 2 ** Math.min(row.failures, 6)))
        : later(30000),
      tenant,
      oa,
      token,
    ],
  );
}

export const BACKFILL_LIMITS = {
  chunks: 10,
  sql: 1800,
  rpc: 160,
  milliseconds: 8000,
} as const;
/** Called under the existing OA lease. Chunks are checkpoints; stop before admitting more work. */
export async function processAssistantBurst(
  input: Runtime,
  tenant: string,
  oa: string,
  options: {
    clock?: () => number;
    milliseconds?: number;
    chunks?: number;
    sql?: number;
    rpc?: number;
  } = {},
) {
  const clock = options.clock || (() => performance.now()),
    started = clock();
  const limits = {
    chunks: Math.min(
      options.chunks ?? BACKFILL_LIMITS.chunks,
      BACKFILL_LIMITS.chunks,
    ),
    sql: Math.min(options.sql ?? BACKFILL_LIMITS.sql, BACKFILL_LIMITS.sql),
    rpc: Math.min(options.rpc ?? BACKFILL_LIMITS.rpc, BACKFILL_LIMITS.rpc),
    milliseconds: Math.min(
      options.milliseconds ?? BACKFILL_LIMITS.milliseconds,
      BACKFILL_LIMITS.milliseconds,
    ),
  };
  let sql = 0,
    rpc = 0,
    chunks = 0,
    processed = 0,
    created = 0,
    aiGenerated = 0;
  const scope = databaseScope(input);
  const wrap = (db: Database, tenantDB: boolean): Database => ({
    query: async (statement, params) => {
      sql++;
      if (tenantDB) rpc++;
      return db.query(statement, params);
    },
    batch: async (queries) => {
      sql += queries.length;
      if (tenantDB) rpc++;
      return db.batch(queries);
    },
  });
  const rt: Runtime = {
    ...scope,
    db: wrap(scope.db, false),
    openDatabase: async (t, a, p) =>
      wrap(await scope.openDatabase(t, a, p), true),
  };
  const shouldYield = () =>
    clock() - started >= limits.milliseconds ||
    sql >= limits.sql ||
    rpc >= limits.rpc;
  while (chunks < limits.chunks && !shouldYield()) {
    const result = await processAssistantWork(rt, tenant, oa, {
      shouldYield,
      allowAutoAI: aiGenerated === 0,
    });
    chunks++;
    processed += result.processed;
    created += result.created;
    aiGenerated += result.aiGenerated || 0;
    if (!result.processed) break;
  }
  return {
    processed,
    created,
    chunks,
    aiGenerated,
    sql,
    tenantRPC: rpc,
    elapsedMs: Math.round(clock() - started),
    yielded: shouldYield() || chunks === limits.chunks,
  };
}
