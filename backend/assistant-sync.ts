import type { Runtime } from "./runtime.ts";
import { all, one, json, now, type Query } from "./db.ts";
import { driveAccessToken, ownDrive } from "./drive.ts";
import {
  googleDB,
  googleConfig,
  googleGET,
  googleAdmin,
} from "./assistant-google-store.ts";
import { readPropertySheet } from "./assistant-sheets.ts";
import { businessProfile } from "./business.ts";
import { requireThat } from "./security.ts";

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
export async function syncPropertySheet(
  rt: Runtime,
  t: string,
  oa: string,
  force = false,
) {
  const db = await googleDB(rt, t, oa),
    c = await googleConfig(db);
  if (!c.settings.autoSheet || !c.row?.actor || !c.settings.spreadsheetId)
    return { skipped: "disabled" };
  if (
    !(
      await one(db, "SELECT enabled FROM assistant_settings WHERE id='default'")
    )?.enabled
  )
    return { skipped: "disabled" };
  const lease = crypto.randomUUID();
  const claim = await db.query(
    "INSERT INTO assistant_sheet_sync(id,lease_id,lease_until,next_at) VALUES ('default',?,?,?) ON CONFLICT(id) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,next_at=excluded.next_at WHERE (lease_until IS NULL OR lease_until<=?) AND (next_at<=? OR ?=1) RETURNING id",
    [
      lease,
      later(120000),
      new Date((Math.floor(Date.now() / 300000) + 1) * 300000).toISOString(),
      now(),
      now(),
      Number(force),
    ],
  );
  if (!claim.rows.length) return { skipped: "not_due" };
  try {
    await googleAdmin(rt, t, oa, c.row.actor);
    requireThat(
      [null, "", "estate"].includes((await businessProfile(rt, t)).industry),
      409,
      "SOURCE_INDUSTRY_MISMATCH",
      "不動産の商品マスターを確認してください。",
    );
    const token = await driveAccessToken(
      rt,
      await ownDrive(rt, t, oa, c.row.actor),
    );
    const meta = await googleGET(
      rt,
      token,
      `https://www.googleapis.com/drive/v3/files/${c.settings.spreadsheetId}?fields=id,mimeType,parents,trashed,modifiedTime&supportsAllDrives=true`,
    );
    requireThat(
      meta.id === c.settings.spreadsheetId &&
        !meta.trashed &&
        meta.mimeType === "application/vnd.google-apps.spreadsheet" &&
        meta.parents?.includes(c.settings.folderId),
      422,
      "SHEET_FOLDER_MISMATCH",
      "接続した物件フォルダ内のファイルを確認してください。",
    );
    const prior = await one(
      db,
      "SELECT * FROM assistant_sheet_sync WHERE id='default'",
    );
    if (
      prior?.config_version === c.version &&
      prior.spreadsheet_id === meta.id &&
      prior.modified_time === meta.modifiedTime
    ) {
      await db.query(
        "UPDATE assistant_sheet_sync SET checked_at=?,lease_id=NULL,lease_until=NULL WHERE id='default' AND lease_id=?",
        [now(), lease],
      );
      return { changed: 0, skipped: "unchanged" };
    }
    const snapshot = await readPropertySheet(
      rt,
      t,
      oa,
      c.row.actor,
      c.settings,
    );
    const guard =
      "EXISTS(SELECT 1 FROM assistant_google_config WHERE id='default' AND version=?) AND EXISTS(SELECT 1 FROM assistant_sheet_sync WHERE id='default' AND lease_id=?)";
    const qs: Query[] = snapshot.sources.map((s) => ({
      sql: `INSERT INTO assistant_sources(id,kind,title,url,published_at,event_at,checked_at,expires_at,data,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,published_at=excluded.published_at,checked_at=excluded.checked_at,expires_at=excluded.expires_at,data=excluded.data,version=version+1,updated_at=excluded.updated_at WHERE data<>excluded.data`,
      params: [
        s.id,
        s.kind,
        s.title,
        s.url,
        s.publishedAt,
        s.eventAt,
        s.checkedAt,
        s.expiresAt,
        json(s),
        now(),
        c.version,
        lease,
      ],
    }));
    // Deleted or invalid rows stop being sendable immediately. Valid rows can still progress.
    qs.push({
      sql: `UPDATE assistant_sources SET data=json_set(data,'$.status','unpublished','$.stock',0),version=version+1,updated_at=? WHERE id LIKE 'sheet-%' AND id NOT IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.status')<>'unpublished' AND ${guard}`,
      params: [
        now(),
        json(snapshot.sources.map((s) => s.id)),
        c.version,
        lease,
      ],
    });
    qs.push({
      sql: `UPDATE assistant_sheet_sync SET config_version=?,spreadsheet_id=?,modified_time=?,checked_at=?,state=?,detail=?,lease_id=NULL,lease_until=NULL WHERE id='default' AND lease_id=? AND EXISTS(SELECT 1 FROM assistant_google_config WHERE id='default' AND version=?)`,
      params: [
        c.version,
        meta.id,
        snapshot.modifiedTime,
        now(),
        snapshot.errors.length ? "needs_review" : "synced",
        json({
          rows: snapshot.count,
          valid: snapshot.sources.length,
          errors: snapshot.errors,
          warnings: snapshot.warnings,
        }),
        lease,
        c.version,
      ],
    });
    const results = await db.batch(qs);
    requireThat(
      results.at(-1)?.changes === 1,
      409,
      "CONFIG_CHANGED",
      "読み取り中に接続設定が変わりました。",
    );
    return {
      changed: results.slice(0, -1).reduce((n, r) => n + r.changes, 0),
      valid: snapshot.sources.length,
      errors: snapshot.errors,
    };
  } catch (e: any) {
    // Do not disclose provider payloads/tokens. Leave refresh timestamps untouched on failure.
    await db.query(
      "UPDATE assistant_sheet_sync SET checked_at=?,state='error',detail=?,lease_id=NULL,lease_until=NULL WHERE id='default' AND lease_id=?",
      [
        now(),
        json({
          code: e.code || "SYNC_FAILED",
          message: e.code
            ? e.message
            : "商品マスターの確認を完了できませんでした。",
        }),
        lease,
      ],
    );
    throw e;
  }
}
