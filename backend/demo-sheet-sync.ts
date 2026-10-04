import type { Runtime } from "./runtime.ts";
import { all, one, json, parse, now, type Row } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import {
  googleDB,
  googleConfig,
  googleAdmin,
} from "./assistant-google-store.ts";
import { ownDrive, driveAccessToken } from "./drive.ts";
import {
  propertyHeaders,
  parsePropertyRows,
  readPropertySheet,
} from "./assistant-sheets.ts";
import { upsertSource, sourceSchema } from "./assistant.ts";

async function stableSheet(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor: string,
  settings: Parameters<typeof readPropertySheet>[4],
) {
  try {
    return await readPropertySheet(rt, tenant, oa, actor, settings);
  } catch (e: any) {
    // Drive's modifiedTime can settle just after a successful Sheets write.
    // Re-read once; this retries no mutations and keeps the snapshot guard intact.
    if (e.code !== "SHEET_CHANGED") throw e;
    return readPropertySheet(rt, tenant, oa, actor, settings);
  }
}

export function demoPropertyRow(rt: Runtime, sid: string, b: Row) {
  const at = now();
  return [
    sid,
    b.title.startsWith("【体験用】") ? b.title : "【体験用】" + b.title,
    b.area,
    b.price,
    b.layout,
    b.walkingMinutes,
    "所有権",
    b.status === "sold" ? "売約済み" : "販売中",
    0,
    "",
    "定期借地権",
    at,
    at,
    new Date(Date.now() + 7 * 86400000).toISOString(),
    (rt.origin.startsWith("https:") ? rt.origin : "https://self-demo.invalid") +
      "/demo/property/" +
      sid,
    "体験用",
    "架空",
    1,
  ];
}
export function demoSheetSource(row: unknown[], customer: string) {
  const r = parsePropertyRows([propertyHeaders, row], "demo");
  requireThat(
    r.sources.length === 1 && !r.errors.length,
    422,
    "PROPERTY_INVALID",
    r.errors[0]?.message || "物件を確認してください。",
  );
  return { ...r.sources[0], id: String(row[0]), audienceCustomerId: customer };
}
// Insert the durable write intent before publishing any matching evidence.
export async function queueDemoSheetWrite(
  rt: Runtime,
  actor: string,
  customer: string,
  sid: string,
  b: Row,
) {
  const { tenant, oa } = rt.selfDemo!;
  const db = await googleDB(rt, tenant, oa),
    c = await googleConfig(db);
  if (!c.settings.spreadsheetId) return null;
  const hash = await digest(json(b));
  const old = await one(
    db,
    "SELECT * FROM demo_sheet_writes WHERE source_id=?",
    [sid],
  );
  if (old && old.request_hash === hash) {
    requireThat(
      old.user_id === actor && old.customer_id === customer,
      403,
      "FORBIDDEN",
      "自分の物件だけを編集できます。",
    );
    return old;
  }
  const current = await one(db, "SELECT * FROM assistant_sources WHERE id=?", [
    sid,
  ]);
  requireThat(
    !old || b.sourceId,
    409,
    "REQUEST_CHANGED",
    "同じ追加操作の内容が変わっています。もう一度追加してください。",
  );
  requireThat(
    !current ||
      (b.sourceId &&
        current.version === b.version &&
        parse(current.data).audienceCustomerId === customer),
    409,
    "SOURCE_CHANGED",
    "物件が更新されています。最新の内容を確認してください。",
  );
  requireThat(
    !old ||
      (old.state === "synced" &&
        old.user_id === actor &&
        old.customer_id === customer),
    409,
    "SHEET_WRITE_PENDING",
    "前の保存を確認中です。商品マスターへの保存結果をお待ちください。",
  );
  if (!old)
    requireThat(
      (
        await one(
          db,
          "SELECT COUNT(*) n FROM demo_sheet_writes WHERE user_id=? AND updated_at>=?",
          [actor, new Date(Date.now() - 86400000).toISOString()],
        )
      ).n < 8,
      429,
      "DEMO_LIMIT",
      "24時間の物件追加は8件までです。",
    );
  const row = demoPropertyRow(rt, sid, b);
  demoSheetSource(row, customer);
  const q = await db.query(
    `INSERT INTO demo_sheet_writes(source_id,user_id,customer_id,spreadsheet_id,config_version,request_hash,source_version,row_json,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ?=1 OR (SELECT COUNT(*) FROM demo_sheet_writes WHERE user_id=? AND updated_at>=?)<8 ON CONFLICT(source_id) DO UPDATE SET request_hash=excluded.request_hash,source_version=excluded.source_version,row_json=excluded.row_json,state='queued',attempts=0,next_at='',error=NULL,updated_at=excluded.updated_at WHERE state='synced' AND user_id=excluded.user_id AND customer_id=excluded.customer_id AND request_hash=?`,
    [
      sid,
      actor,
      customer,
      c.settings.spreadsheetId,
      c.version,
      hash,
      current?.version || 0,
      json(row),
      now(),
      Number(!!old),
      actor,
      new Date(Date.now() - 86400000).toISOString(),
      old?.request_hash || "",
    ],
  );
  requireThat(
    q.changes === 1,
    409,
    "SHEET_WRITE_PENDING",
    "保存処理中です。しばらくお待ちください。",
  );
  return one(db, "SELECT * FROM demo_sheet_writes WHERE source_id=?", [sid]);
}
export async function processDemoSheetWrites(rt: Runtime, onlySource?: string) {
  if (!rt.selfDemo) return;
  const { tenant, oa } = rt.selfDemo,
    db = await googleDB(rt, tenant, oa);
  const jobs = await all(
    db,
    `SELECT * FROM demo_sheet_writes WHERE (state IN ('queued','sending','uncertain') OR (state='error' AND attempts<3)) AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) AND (? IS NULL OR source_id=?) ORDER BY updated_at LIMIT 2`,
    [now(), now(), onlySource || null, onlySource || null],
  );
  for (const job of jobs) {
    const lease = crypto.randomUUID();
    if (
      !(
        await db.query(
          "UPDATE demo_sheet_writes SET lease_id=?,lease_until=?,attempts=attempts+1 WHERE source_id=? AND request_hash=? AND state=? AND (lease_until IS NULL OR lease_until<=?)",
          [
            lease,
            new Date(Date.now() + 120000).toISOString(),
            job.source_id,
            job.request_hash,
            job.state,
            now(),
          ],
        )
      ).changes
    )
      continue;
    let attempted = false;
    try {
      const c = await googleConfig(db);
      requireThat(
        c.row?.actor &&
          c.version === job.config_version &&
          c.settings.spreadsheetId === job.spreadsheet_id,
        409,
        "CONFIG_CHANGED",
        "接続先が変更されています。管理者が保存先を確認してください。",
      );
      await googleAdmin(rt, tenant, oa, c.row.actor);
      const participant = await one(
        rt.db,
        "SELECT p.customer_id FROM gs_demo_participants p JOIN memberships m ON m.user_id=p.user_id AND m.tenant_id=p.tenant_id WHERE p.user_id=? AND p.tenant_id=? AND p.state='active' AND m.state='active' AND p.customer_line_id IS NOT NULL AND p.pair_hash IS NULL",
        [job.user_id, tenant],
      );
      requireThat(
        participant?.customer_id === job.customer_id,
        403,
        "PARTICIPANT_CHANGED",
        "体験者の連携を確認してください。",
      );
      const con = await ownDrive(rt, tenant, oa, c.row.actor);
      requireThat(
        parse(con.config).canWriteSheets,
        409,
        "SHEET_WRITE_SCOPE",
        "管理者がGoogle接続で商品マスターへの保存を許可してください。",
      );
      const row = parse(job.row_json, []);
      const snapshot = await stableSheet(
        rt,
        tenant,
        oa,
        c.row.actor,
        c.settings,
      );
      const found = snapshot.rows
        .map((r, i) => ({ r, i }))
        .filter((x) => x.r[0] === job.source_id);
      requireThat(
        found.length <= 1,
        409,
        "SHEET_DUPLICATE",
        "物件IDが重複しています。台帳を確認してください。",
      );
      const same = found.length === 1 && json(found[0].r) === job.row_json;
      if (!same) {
        requireThat(
          job.state !== "sending" && job.state !== "uncertain",
          409,
          "SHEET_UNCERTAIN",
          "前の書き込み結果を確認中です。重複追加を防ぐため再送は止めています。",
        );
        requireThat(
          found.length ? job.synced_row === json(found[0].r) : !job.synced_row,
          409,
          "SHEET_CONFLICT",
          "台帳側でこの物件が変更・削除されています。最新の台帳を確認してください。",
        );
        requireThat(
          found.length || snapshot.count < 100,
          409,
          "SHEET_LIMIT",
          "商品マスターは100件以内です。",
        );
        const token = await driveAccessToken(rt, con);
        const range = found.length
          ? `'物件台帳'!A${found[0].i + 1}:R${found[0].i + 1}`
          : "'物件台帳'!A1:R1001";
        const url =
          `https://sheets.googleapis.com/v4/spreadsheets/${job.spreadsheet_id}/values/${encodeURIComponent(range)}` +
          (found.length
            ? "?valueInputOption=RAW"
            : ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
        await db.query(
          "UPDATE demo_sheet_writes SET state='sending' WHERE source_id=? AND lease_id=?",
          [job.source_id, lease],
        );
        attempted = true;
        const response = await rt.externalFetch(url, {
          method: found.length ? "PUT" : "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: json({ majorDimension: "ROWS", values: [row] }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        // A timeout/5xx may already have appended: never blindly repeat it.
        if (response.status >= 400 && response.status < 500) {
          attempted = false;
          requireThat(
            false,
            response.status,
            "SHEET_WRITE_REJECTED",
            "Googleへの保存が拒否されました。編集権限・利用枠を確認してください。",
          );
        }
        requireThat(
          response.ok,
          502,
          "SHEET_UNCERTAIN",
          "Googleへの保存結果を確認中です。",
        );
        await response.body?.cancel();
        const check = await stableSheet(
          rt,
          tenant,
          oa,
          c.row.actor,
          c.settings,
        );
        const matches = check.rows.filter((r) => r[0] === job.source_id);
        requireThat(
          matches.length === 1 && json(matches[0]) === job.row_json,
          409,
          "SHEET_UNCERTAIN",
          "保存後の台帳の内容を確認中です。",
        );
      }
      // Only confirmed rows become usable proposal evidence. The echo uses this same shape.
      const source = sourceSchema.parse(demoSheetSource(row, job.customer_id));
      const current = await one(
        db,
        "SELECT data FROM assistant_sources WHERE id=?",
        [job.source_id],
      );
      if (current?.data !== json(source))
        await upsertSource(
          rt,
          tenant,
          oa,
          source,
          false,
          job.source_version
            ? {
                version: job.source_version,
                audienceCustomerId: job.customer_id,
              }
            : undefined,
        );
      await db.query(
        "UPDATE demo_sheet_writes SET state='synced',synced_row=row_json,error=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_id=?",
        [now(), job.source_id, lease],
      );
      // A prior scan might have consumed the source change while the write was still pending.
      await db.query(
        "INSERT INTO assistant_work_queue(customer_id,priority) VALUES (?,2) ON CONFLICT(customer_id) DO UPDATE SET revision=revision+1,due_at='',attempts=0",
        [job.customer_id],
      );
    } catch (e: any) {
      const state =
        attempted || ["sending", "uncertain"].includes(job.state)
          ? "uncertain"
          : e.code === "SHEET_CONFLICT"
            ? "conflict"
            : "error";
      await db.query(
        "UPDATE demo_sheet_writes SET state=?,error=?,lease_id=NULL,lease_until=NULL,next_at=?,updated_at=? WHERE source_id=? AND lease_id=?",
        [
          state,
          e.code
            ? e.message
            : "商品マスターへの保存結果を確認できませんでした。",
          new Date(Date.now() + 60000).toISOString(),
          now(),
          job.source_id,
          lease,
        ],
      );
    }
  }
}
