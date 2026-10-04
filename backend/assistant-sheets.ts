import { sourceContradiction } from "./assistant-match.ts";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { all, json, now, type Query, type Database } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { driveAccessToken, ownDrive } from "./drive.ts";
import { sourceSchema } from "./assistant.ts";
import { publicUrl } from "./assistant-discovery.ts";
import { businessProfile } from "./business.ts";
import {
  googleDB,
  googleConfig,
  googleGET,
  googleAdmin,
  type GoogleSettings,
} from "./assistant-google-store.ts";

export const propertyHeaders = [
  "物件ID",
  "物件名（架空）",
  "エリア原表記",
  "物件価格（円）",
  "間取り",
  "駅徒歩（模擬・分）",
  "権利",
  "在庫状態",
  "地点Aから模擬距離（km）",
  "タグ案（カンマ区切り）",
  "不存在確認タグ案",
  "初回公開日時（模擬/JST）",
  "在庫確認日時（模擬/JST）",
  "有効期限（模擬/JST）",
  "デモ詳細URL",
  "担当者",
  "データ区分",
  "データ版",
];
const date = (value: unknown) => {
  const s = z.string().datetime({ offset: true }).parse(value);
  return new Date(s).toISOString();
};
const numeric = (v: unknown) => z.number().finite().nonnegative().parse(v);
const tags = (v: unknown) =>
  String(v ?? "")
    .split(/[,、]/)
    .map((x) => x.trim())
    .filter(Boolean);
export function parsePropertyRows(rows: unknown[][], prefix: string) {
  requireThat(
    json(rows[0]) === json(propertyHeaders),
    422,
    "SHEET_HEADERS",
    "物件台帳の18列の見出し・順序を確認してください。",
  );
  const sources: z.infer<typeof sourceSchema>[] = [];
  const errors: { row: number; message: string }[] = [];
  const warnings: { row: number; message: string }[] = [];
  const ids = new Set<string>();
  const invalidIds = new Set<string>();
  let count = 0;
  rows.slice(1).forEach((r, i) => {
    if (r.every((x) => x === "" || x === null || x === undefined)) return;
    count++;
    try {
      requireThat(
        count <= 100,
        422,
        "SHEET_LIMIT",
        "物件は100件以内にしてください。",
      );
      const rawId = z
        .string()
        .regex(/^[\w-]{1,60}$/)
        .parse(r[0]);
      requireThat(
        !ids.has(rawId),
        422,
        "DUPLICATE_SOURCE",
        "物件IDが重複しています。",
      );
      ids.add(rawId);
      const status = z
        .enum(["販売中", "売約済み", "非公開", "不明"])
        .parse(r[7]);
      const price = numeric(r[3]);
      requireThat(
        Number.isSafeInteger(price),
        422,
        "PRICE_INVALID",
        "価格は円単位の整数にしてください。",
      );
      const walking = numeric(r[5]),
        distance = numeric(r[8]);
      const right = z.string().min(1).max(60).parse(r[6]),
        room = z.string().min(1).max(30).parse(r[4]);
      requireThat(
        r[16] === "架空",
        422,
        "DEMO_ONLY",
        "この接続は架空物件専用です。データ区分を確認してください。",
      );
      requireThat(
        numeric(r[17]) >= 1,
        422,
        "VERSION_REQUIRED",
        "データ版を確認してください。",
      );
      requireThat(
        typeof r[14] === "string" && r[14].length > 0,
        422,
        "URL_REQUIRED",
        "デモ詳細URLが未入力です。顧客が確認できるURLを入力してください。",
      );
      const typedTags=[String(r[2]),room,right];
      const rawTags=tags(r[9]), rawAbsent=tags(r[10]);
      // The dedicated rights/walking columns are authoritative; free-form tags are hints.
      const ownership=/^(所有権|定期借地権|借地権|普通借地権)$/;
      const extras=rawTags.filter(t=>!ownership.test(t) && !/^(駅)?徒歩\d+分以内$/.test(t));
      const absent=rawAbsent.filter(t=>!typedTags.includes(t));
      if(right==='所有権') absent.push('定期借地権','借地権');
      if(rawAbsent.some(t=>typedTags.includes(t)) || rawTags.some(t=>ownership.test(t) && t!==right)) warnings.push({row:i+2,message:'タグの権利表記が物件カラムと異なるため、権利カラムを優先しました。'});
      const source = sourceSchema.parse({
        id: `sheet-${prefix}-${rawId}`,
        kind: "product",
        industry: "estate",
        title: r[1],
        url: publicUrl(String(r[14])),
        area: r[2],
        price,
        property:{walkingMinutes:walking,layout:room,tenure:right},
        summary: `架空物件。${r[2]}・${room}・${right}・駅徒歩${walking}分。地点Aから模擬距離${distance}km（実地の距離ではありません）。`,
        tags: [...new Set([...typedTags,...extras,...[5,10,15,20].filter(n=>walking<=n).map(n=>`徒歩${n}分以内`)])],
        absentTags: [...new Set(absent)],
        publishedAt: date(r[11]),
        checkedAt: date(r[12]),
        expiresAt: date(r[13]),
        status: (
          {
            販売中: "available",
            売約済み: "sold",
            非公開: "unpublished",
            不明: "unknown",
          } as const
        )[status],
        stock: status === "販売中" ? 1 : 0,
      });
      requireThat(
        Date.parse(source.publishedAt) <= Date.now() &&
          Date.parse(source.checkedAt) <= Date.now() &&
          Date.parse(source.checkedAt) >= Date.now() - 86400000 &&
          Date.parse(source.expiresAt) > Date.now() &&
          Date.parse(source.expiresAt) > Date.parse(source.checkedAt),
        422,
        "SOURCE_STALE",
        "公開日・在庫確認日時・有効期限を確認してください（在庫確認は24時間以内）。",
      );
      requireThat(!sourceContradiction(source),422,"SOURCE_CONTRADICTION",sourceContradiction(source)||"");
      sources.push(source);
    } catch (e: any) {
      if(typeof r[0] === "string") invalidIds.add(`sheet-${prefix}-${r[0]}`);
      errors.push({
        row: i + 2,
        message:
          e instanceof z.ZodError
            ? "値の型・必須項目・文字数を確認してください。"
            : e.message,
      });
    }
  });
  requireThat(
    count > 0,
    422,
    "EMPTY_CATALOG",
    "空の台帳は取り込めません。削除する物件は非公開にしてください。",
  );
  return { sources: sources.filter(s=>!invalidIds.has(s.id)), errors, warnings, count };
}
export async function readPropertySheet(
  rt: Runtime,
  t: string,
  oa: string,
  actor: string,
  s: GoogleSettings,
) {
  requireThat(
    s.folderId && s.spreadsheetId,
    409,
    "SHEET_NOT_CONFIGURED",
    "接続設定で物件ファイルを選んで保存してください。",
  );
  const token = await driveAccessToken(rt, await ownDrive(rt, t, oa, actor));
  const meta = await googleGET(
    rt,
    token,
    `https://www.googleapis.com/drive/v3/files/${s.spreadsheetId}?fields=id,mimeType,parents,trashed,modifiedTime&supportsAllDrives=true`,
  );
  requireThat(
    meta.id === s.spreadsheetId &&
      !meta.trashed &&
      meta.mimeType === "application/vnd.google-apps.spreadsheet" &&
      meta.parents?.includes(s.folderId),
    422,
    "SHEET_FOLDER_MISMATCH",
    "指定した物件フォルダ内のスプレッドシートではありません。",
  );
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${s.spreadsheetId}`;
  const info = await googleGET(
    rt,
    token,
    `${url}?fields=spreadsheetId,sheets.properties`,
  );
  const sheet = info.sheets?.[0]?.properties;
  requireThat(
    info.spreadsheetId === s.spreadsheetId &&
      info.sheets?.length === 1 &&
      sheet?.title === s.sheetName &&
      sheet.sheetType === "GRID" &&
      sheet.gridProperties?.columnCount === 18 &&
      sheet.gridProperties.rowCount <= 1001,
    422,
    "SHEET_SCOPE_REJECTED",
    "物件台帳だけのファイル（18列、最大1001行）を指定してください。顧客希望・検証ケースのタブは読み込みません。",
  );
  const query = new URLSearchParams({
    ranges: `'${s.sheetName}'!A1:R1001`,
    fields:
      "spreadsheetId,sheets(properties,data(startRow,startColumn,rowData.values(userEnteredValue,effectiveValue)))",
  });
  const data = await googleGET(rt, token, `${url}?${query}`);
  requireThat(
    data.spreadsheetId === s.spreadsheetId &&
      data.sheets?.length === 1 &&
      data.sheets[0].properties?.sheetId === sheet.sheetId &&
      data.sheets[0].properties?.title === s.sheetName,
    422,
    "SHEET_CHANGED",
    "読取中にタブが変わりました。再確認してください。",
  );
  const after = await googleGET(
    rt,
    token,
    `https://www.googleapis.com/drive/v3/files/${s.spreadsheetId}?fields=id,mimeType,parents,trashed,modifiedTime&supportsAllDrives=true`,
  );
  requireThat(
    !after.trashed &&
      after.id === meta.id &&
      after.modifiedTime === meta.modifiedTime &&
      after.parents?.includes(s.folderId),
    409,
    "SHEET_CHANGED",
    "読み取り中に物件ファイルが更新・移動されました。再確認してください。",
  );
  const grid = data.sheets[0].data;
  requireThat(
    grid?.length === 1 && !grid[0].startRow && !grid[0].startColumn,
    422,
    "SHEET_RANGE",
    "台帳の読取範囲を確認できませんでした。",
  );
  const rows: unknown[][] = (grid[0].rowData || []).map((row: any) =>
    Array.from({ length: 18 }, (_, i) => {
      const v = row.values?.[i];
      requireThat(
        !v?.userEnteredValue?.formulaValue,
        422,
        "SHEET_FORMULA",
        "数式のある台帳は取り込めません。値だけの物件専用ファイルにしてください。",
      );
      const e = v?.effectiveValue;
      return (
        e?.numberValue ??
        e?.stringValue ??
        (e?.boolValue !== undefined
          ? e.boolValue
          : e?.errorValue
            ? "#ERROR"
            : "")
      );
    }),
  );
  const prefix = (await digest(s.spreadsheetId!))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, 12);
  return {
    ...parsePropertyRows(rows, prefix),
    rows, prefix,
    hash: await digest(json({ sheet: sheet.sheetId, rows })),
    modifiedTime: after.modifiedTime,
  };
}
// Capture before reading Google. A queued/new/completed write invalidates the whole
// import transaction, including its checkpoint, so the next poll reads a fresh sheet.
export const demoSheetWritesUnchanged = `(SELECT json_group_array(json_array(source_id,state,request_hash,config_version)) FROM (SELECT source_id,state,request_hash,config_version FROM demo_sheet_writes WHERE spreadsheet_id=? ORDER BY source_id))=?`;
export async function demoSheetWriteSnapshot(db: Database, spreadsheetId: string) {
  const rows=await all(db,"SELECT * FROM demo_sheet_writes WHERE spreadsheet_id=? ORDER BY source_id",[spreadsheetId]);
  return {exports:new Map(rows.map(j=>[j.source_id,j])),token:json(rows.map(j=>[j.source_id,j.state,j.request_hash,j.config_version]))};
}
export async function mapDemoSheetSources(db: Database, snapshot: Awaited<ReturnType<typeof readPropertySheet>>, spreadsheetId: string, writes?: Awaited<ReturnType<typeof demoSheetWriteSnapshot>>) {
  const {exports}=writes || await demoSheetWriteSnapshot(db,spreadsheetId);
  const pendingIds=[...exports.values()].filter(j=>j.state!=="synced").map(j=>j.source_id);
  snapshot.sources=snapshot.sources.flatMap(s=>{
    const raw=s.id.slice(("sheet-"+snapshot.prefix+"-").length),j=exports.get(raw);
    if(!j)return [s];
    if(j.state!=="synced")return [];
    return [sourceSchema.parse({...s,id:j.source_id,audienceCustomerId:j.customer_id})];
  });
  return {exports,pendingIds};
}
export async function previewProperties(
  rt: Runtime,
  t: string,
  oa: string,
  actor: string,
) {
  await googleAdmin(rt, t, oa, actor);
  const db = await googleDB(rt, t, oa),
    c = await googleConfig(db);
  requireThat(
    c.row?.actor === actor,
    409,
    "CONFIG_OWNER",
    "この管理者で接続設定を保存し直してください。",
  );
  const r = await readPropertySheet(rt, t, oa, actor, c.settings);
  const review = {
    id: crypto.randomUUID(),
    actor,
    hash: r.hash,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    version: c.version,
  };
  const changed = await db.query(
    "UPDATE assistant_google_config SET review_id=?,review_state='ready',review_json=? WHERE id='default' AND version=? AND (review_state IS NULL OR review_state<>'importing')",
    [review.id, json(review), c.version],
  );
  requireThat(
    changed.changes === 1,
    409,
    "CONFIG_CHANGED",
    "設定が変更されたか取込中です。再確認してください。",
  );
  return {
    reviewId: review.id,
    expiresAt: review.expiresAt,
    count: r.count,
    errors: r.errors,
    warnings: r.warnings,
    rows: r.sources.map((s) => ({
      id: s.id,
      title: s.title,
      area: s.area,
      price: s.price,
      status: s.status,
      url: s.url,
      checkedAt: s.checkedAt,
    })),
    canImport: r.errors.length === 0,
  };
}
export async function importProperties(
  rt: Runtime,
  t: string,
  oa: string,
  actor: string,
  reviewId: string,
) {
  await googleAdmin(rt, t, oa, actor);
  const db = await googleDB(rt, t, oa),
    c = await googleConfig(db),
    review = JSON.parse(c.row?.review_json || "{}");
  requireThat(
    c.row?.actor === actor &&
      review.actor === actor &&
      c.row?.review_id === reviewId &&
      c.row.review_state === "ready" &&
      review.version === c.version &&
      Date.parse(review.expiresAt) > Date.now(),
    409,
    "REVIEW_INVALID",
    "確認が取消・確定済み、または期限切れです。再確認してください。",
  );
  const business = await businessProfile(rt, t);
  requireThat(
    !business.industry || business.industry === "estate",
    409,
    "SOURCE_INDUSTRY_MISMATCH",
    "不動産事業で使用してください。",
  );
  const writes = await demoSheetWriteSnapshot(db, c.settings.spreadsheetId!);
  const r = await readPropertySheet(rt, t, oa, actor, c.settings);
  requireThat(
    r.hash === review.hash &&
      !r.errors.length &&
      Date.parse(review.expiresAt) > Date.now(),
    409,
    "SHEET_CHANGED",
    "確認後に内容または鮮度が変わりました。再確認してください。",
  );
  const {exports,pendingIds}=await mapDemoSheetSources(db,r,c.settings.spreadsheetId!,writes);
  // One atomic tenant DB batch: sources, withdrawn stock, and consumed review.
  const guard =
    `EXISTS(SELECT 1 FROM assistant_google_config WHERE review_id=? AND version=? AND review_state='ready') AND ${demoSheetWritesUnchanged}`;
  const guardParams=[reviewId,c.version,c.settings.spreadsheetId!,writes.token];
  const queries: Query[] = r.sources.map((s) => ({
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
      ...guardParams,
    ],
  }));
  queries.push({
    sql: `UPDATE assistant_sources SET data=json_set(data,'$.status','unpublished','$.stock',0),version=version+1,updated_at=? WHERE (id LIKE 'sheet-%' OR id IN (SELECT source_id FROM demo_sheet_writes WHERE spreadsheet_id=? AND state='synced')) AND id NOT IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.status')<>'unpublished' AND ${guard}`,
    params: [now(), c.settings.spreadsheetId!,json([...r.sources.map((s)=>s.id),...pendingIds]),...guardParams],
  });
  for(const s of r.sources) {
    const j=exports.get(s.id),row=r.rows.find(x=>x[0]===s.id);
    if(j && row)queries.push({sql:`UPDATE demo_sheet_writes SET synced_row=?,row_json=? WHERE source_id=? AND state='synced' AND ${guard}`,params:[json(row),json(row),s.id,...guardParams]});
  }
  queries.push({
    sql: `UPDATE assistant_google_config SET review_state='imported' WHERE id='default' AND ${guard}`,
    params: guardParams,
  });
  const results = await db.batch(queries);
  requireThat(
    results.at(-1)?.changes === 1,
    409,
    "REVIEW_INVALID",
    "確認が取消・確定済み、または物件の保存状態が変わりました。再確認してください。",
  );
  return { imported: r.sources.length, messagesSent: 0 };
}
