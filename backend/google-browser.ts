import type { Hono, Context } from "hono";
import type { AppEnv } from "./runtime.ts";
import { z } from "zod";
import { one, parse } from "./db.ts";
import { requireThat } from "./security.ts";
import { driveAccessToken, driveJSON, ownDrive } from "./drive.ts";
import {
  googleAdmin,
  googleDB,
  googleConfig,
  googleId,
  googleGET,
} from "./assistant-google-store.ts";
import { saveGoogleConfig } from "./assistant-google.ts";
import { newsOAuthDDL } from "./assistant-google-schema.ts";

const base = "/api/tenants/:tenantId/accounts/:oaId/assistant/google";
const folderType = "application/vnd.google-apps.folder";
const sheetType = "application/vnd.google-apps.spreadsheet";
const excluded = (name: string) =>
  /検証管理|検証ケース|つなぐ接続対象外|正解表|採点|顧客希望/.test(name);
const escapeQuery = (s: string) =>
  s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
async function context(c: Context<AppEnv>) {
  const rt = c.env.runtime,
    t = c.req.param("tenantId")!,
    oa = c.req.param("oaId")!,
    actor = c.get("principal").user.id;
  await googleAdmin(rt, t, oa, actor);
  return { rt, t, oa, actor, db: await googleDB(rt, t, oa) };
}
async function propertyFile(
  x: Awaited<ReturnType<typeof context>>,
  fileId: string,
) {
  const con = await ownDrive(x.rt, x.t, x.oa, x.actor),
    token = await driveAccessToken(x.rt, con);
  const file = await driveJSON(x.rt, token, `files/${fileId}`, {
    fields: "id,name,mimeType,parents,trashed",
    supportsAllDrives: "true",
  });
  requireThat(
    file.id === fileId &&
      !file.trashed &&
      file.mimeType === sheetType &&
      !excluded(file.name || "") &&
      file.parents?.length === 1,
    422,
    "PROPERTY_FILE_SCOPE",
    "物件専用フォルダ内の物件ファイルを選んでください。検証管理・正解表は対象外です。",
  );
  const folder = await driveJSON(
    x.rt,
    token,
    `files/${googleId.parse(file.parents[0])}`,
    { fields: "id,name,mimeType,trashed", supportsAllDrives: "true" },
  );
  requireThat(
    folder.mimeType === folderType &&
      !folder.trashed &&
      !excluded(folder.name || ""),
    422,
    "PROPERTY_FOLDER_SCOPE",
    "物件専用の保存先を選んでください。",
  );
  // Metadata only: reject mixed workbooks before requesting any cells.
  const book = await googleGET(
    x.rt,
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=spreadsheetId,sheets.properties`,
  );
  const tab = book.sheets?.[0]?.properties;
  requireThat(
    book.spreadsheetId === fileId &&
      book.sheets?.length === 1 &&
      tab?.title === "物件台帳" &&
      tab.sheetType === "GRID" &&
      tab.gridProperties?.columnCount === 18 &&
      tab.gridProperties?.rowCount <= 1001,
    422,
    "SHEET_SCOPE_REJECTED",
    "「物件台帳」だけのファイル（18列、最大1001行）を選んでください。顧客希望や検証ケースを含むファイルは読み込みません。",
  );
  const current = await ownDrive(x.rt, x.t, x.oa, x.actor);
  requireThat(
    current.config === con.config,
    409,
    "DRIVE_CHANGED",
    "Google接続が変わりました。再度選んでください。",
  );
  return {
    file: { id: file.id, name: file.name },
    folder: { id: folder.id, name: folder.name },
    tabs: [{ name: tab.title }],
    settings: {
      folderId: folder.id,
      spreadsheetId: file.id,
      sheetName: tab.title,
      propertyFileName: file.name,
    },
  };
}
export function registerGoogleBrowser(app: Hono<AppEnv>) {
  app.get(`${base}/browse`, async (c) => {
    const x = await context(c);
    const q = z
      .object({
        kind: z.enum(["folder", "sheet"]),
        search: z.string().max(100).optional(),
        parent: googleId.optional(),
        page: z.string().max(2000).optional(),
      })
      .parse(c.req.query());
    const con = await ownDrive(x.rt, x.t, x.oa, x.actor),
      token = await driveAccessToken(x.rt, con);
    const data = await driveJSON(x.rt, token, "files", {
      q: `trashed=false and mimeType='${q.kind === "folder" ? folderType : sheetType}'${q.parent ? ` and '${q.parent}' in parents` : ""}${q.search ? ` and name contains '${escapeQuery(q.search)}'` : ""}`,
      fields: "files(id,name,mimeType),nextPageToken",
      pageSize: "50",
      orderBy: "name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(q.page ? { pageToken: q.page } : {}),
    });
    return c.json({
      files: (data.files || []).filter((f: any) => !excluded(f.name || "")),
      nextPageToken: data.nextPageToken || null,
    });
  });
  app.get(`${base}/properties/file/:fileId`, async (c) =>
    c.json(
      await propertyFile(
        await context(c),
        googleId.parse(c.req.param("fileId")),
      ),
    ),
  );
  app.post(`${base}/properties/select`, async (c) => {
    const x = await context(c),
      b = z
        .object({
          version: z.number().int().nonnegative(),
          fileId: googleId,
          sheetName: z.literal("物件台帳"),
        })
        .strict()
        .parse(await c.req.json());
    const old = await googleConfig(x.db);
    requireThat(
      old.version === b.version,
      409,
      "CONFIG_CHANGED",
      "設定が変わりました。再読み込みしてください。",
    );
    const choice = await propertyFile(x, b.fileId);
    await saveGoogleConfig(x, {
      version: b.version,
      settings: { ...old.settings, ...choice.settings },
    });
    return c.json({ saved: true, file: choice.file, folder: choice.folder });
  });
  app.post(`${base}/meetings/test`, async (c) => {
    const x = await context(c),
      con = await ownDrive(x.rt, x.t, x.oa, x.actor),
      cfg = parse(con.config);
    requireThat(
      cfg.roots?.length,
      409,
      "NO_MEETING_FOLDER",
      "先に議事録フォルダを保存してください。",
    );
    const token = await driveAccessToken(x.rt, con),
      folders = [];
    for (const root of cfg.roots) {
      const folder = await driveJSON(
        x.rt,
        token,
        `files/${googleId.parse(root)}`,
        { fields: "id,name,mimeType,trashed", supportsAllDrives: "true" },
      );
      requireThat(
        folder.mimeType === folderType && !folder.trashed,
        422,
        "FOLDER_UNAVAILABLE",
        "保存先が移動・削除されたか、共有権限が変わりました。選び直してください。",
      );
      const data = await driveJSON(x.rt, token, "files", {
        q: `'${root}' in parents and trashed=false`,
        fields: "files(id,name,mimeType),nextPageToken",
        pageSize: "20",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      folders.push({
        name: folder.name,
        files: (data.files || []).filter((f: any) =>
          ["application/vnd.google-apps.document", "text/plain"].includes(
            f.mimeType,
          ),
        ),
        hasMore: !!data.nextPageToken,
      });
    }
    const current = await ownDrive(x.rt, x.t, x.oa, x.actor);
    requireThat(
      current.config === con.config,
      409,
      "DRIVE_CHANGED",
      "保存先が変更されました。再確認してください。",
    );
    return c.json({ checkedAt: new Date().toISOString(), folders });
  });
  app.post(`${base}/news/use-folder`, async (c) => {
    const x = await context(c),
      b = z
        .object({ version: z.number().int().nonnegative() })
        .strict()
        .parse(await c.req.json());
    const old = await googleConfig(x.db),
      con = await one(
        x.rt.db,
        "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=? AND state='connected'",
        [x.t, x.oa, `google_drive_news:${x.actor}`],
      );
    requireThat(
      con,
      409,
      "NEWS_WRITE_NOT_CONNECTED",
      "先にニュース保存用のGoogle認可を行ってください。",
    );
    const folderId = googleId.parse(parse(con!.config).folderId),
      token = await driveAccessToken(x.rt, con!);
    const folder = await driveJSON(x.rt, token, `files/${folderId}`, {
      fields: "id,name,mimeType,trashed,capabilities(canAddChildren)",
      supportsAllDrives: "true",
    });
    requireThat(
      folder.id === folderId &&
        folder.mimeType === folderType &&
        !folder.trashed &&
        folder.capabilities?.canAddChildren === true,
      409,
      "NEWS_FOLDER_UNAVAILABLE",
      "ニュース保存先への権限がありません。ニュース保存を再接続してください。",
    );
    const current = await one(
      x.rt.db,
      "SELECT state,config FROM connections WHERE id=?",
      [con!.id],
    );
    requireThat(
      current?.state === "connected" && current.config === con!.config,
      409,
      "DRIVE_CHANGED",
      "認可が変わりました。もう一度確認してください。",
    );
    await saveGoogleConfig(x, {
      version: b.version,
      settings: {
        ...old.settings,
        newsFolderId: folderId,
        researchEnabled: false,
      },
    });
    return c.json({
      name: folder.name,
      checkedAt: new Date().toISOString(),
      saved: true,
    });
  });
  app.post(`${base}/news/disconnect`, async (c) => {
    const x = await context(c),
      service = `google_drive_news:${x.actor}`;
    await x.rt.db.query(newsOAuthDDL);
    await x.rt.db.batch([
      {
        sql: "DELETE FROM assistant_news_oauth_states WHERE tenant_id=? AND oa_id=? AND user_id=?",
        params: [x.t, x.oa, x.actor],
      },
      {
        sql: "DELETE FROM credentials WHERE tenant_id=? AND oa_id=? AND service=?",
        params: [x.t, x.oa, service],
      },
      {
        sql: "UPDATE connections SET state='disconnected',config='{}' WHERE tenant_id=? AND oa_id=? AND service=?",
        params: [x.t, x.oa, service],
      },
    ]);
    await x.db.query(
      "UPDATE assistant_google_config SET data=json_remove(json_set(data,'$.researchEnabled',json('false')),'$.newsFolderId'),version=version+1,review_state='cancelled' WHERE actor=?",
      [x.actor],
    );
    return c.json({ disconnected: true });
  });
}
