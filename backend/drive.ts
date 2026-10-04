import { meetingAutoDDL } from "./meeting-auto-schema.ts";
import { invalidateMeetingSource } from "./meeting-automation.ts";
import { meetingInboxDDL } from "./meeting-schema.ts";
export { meetingInboxDDL } from "./meeting-schema.ts";
import { driveStateDDL } from "./meeting-schema.ts";
export { driveStateDDL } from "./meeting-schema.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { member, accountFor, has } from "./access.ts";
import {
  AppError,
  requireThat,
  digest,
  audit,
  encrypt,
  decrypt,
} from "./security.ts";
import { getCredential, putCredential } from "./credentials.ts";
import {
  recordingAccess,
  readRecordingSources,
  driveFolderId,
} from "./recording-sources.ts";
export const driveScope = "https://www.googleapis.com/auth/drive.readonly";
import { googleAPIError } from "./google-api-errors.ts";

const driveId = z.string().regex(/^[\w-]{1,200}$/);
export async function inboxDB(rt: Runtime, tenant: string, oa: string) {
  const db = await rt.openDatabase(tenant, oa, "tsunagu");
  await db.query(meetingInboxDDL);
  for (const sql of meetingAutoDDL) await db.query(sql);
  return db;
}
export function meetingTime(title: string): string | null {
  const m = title.match(
    /(20\d{2})[\/-](\d{2})[\/-](\d{2})[ T](\d{2}):(\d{2})\s*(JST|UTC|GMT)/,
  );
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${m[6] === "JST" ? "+09:00" : "Z"}`;
  return Number.isFinite(Date.parse(d)) ? new Date(d).toISOString() : null;
}
export async function driveAccessToken(rt: Runtime, con: Row) {
  requireThat(
    rt.googleOAuth,
    503,
    "GOOGLE_NOT_CONFIGURED",
    "Google連携の設定が必要です。",
  );
  const cred = await getCredential(rt, con.tenant_id, con.oa_id, con.service);
  const response = await rt.externalFetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: rt.googleOAuth!.clientId,
        client_secret: rt.googleOAuth!.clientSecret,
        refresh_token: cred.refreshToken,
        grant_type: "refresh_token",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    if ([400, 401].includes(response.status))
      await rt.db.query(
        "UPDATE connections SET state='reconnect',last_error='Googleの再承認が必要です。' WHERE id=?",
        [con.id],
      );
    requireThat(
      false,
      502,
      "GOOGLE_REFRESH_FAILED",
      "Googleに接続できません。再連携してください。",
    );
  }
  const data: any = await response.json();
  requireThat(
    typeof data.access_token === "string",
    502,
    "GOOGLE_TOKEN_FAILED",
    "Googleの認証を確認してください。",
  );
  return data.access_token as string;
}
export async function driveJSON(
  rt: Runtime,
  token: string,
  path: string,
  query: Record<string, string>,
) {
  const r = await rt.externalFetch(
    `https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(query)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok) throw await googleAPIError(r, "drive");
  return (await r.json()) as any;
}
export async function ownDrive(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor: string,
) {
  const con = await one(
    rt.db,
    "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",
    [tenant, oa, `google_drive:${actor}`],
  );
  requireThat(
    con && ["connected", "syncing"].includes(con.state),
    409,
    "DRIVE_NOT_CONNECTED",
    "Google Driveを連携してください。",
  );
  return con!;
}
async function eligibleConnection(rt: Runtime, con: Row) {
  const cfg = parse(con.config),
    m = await member(rt, cfg.actor, con.tenant_id),
    oa = await accountFor(rt, con.tenant_id, con.oa_id),
    tenant = await one(rt.db, "SELECT state FROM tenants WHERE id=?", [
      con.tenant_id,
    ]);
  requireThat(
    tenant?.state !== "suspended",
    403,
    "TENANT_SUSPENDED",
    "企業が停止されています。",
  );
  requireThat(
    has(m, "org_owner", "sys_admin") ||
      (has(m, "sales", "team_admin") &&
        (oa.owner_user_id === m.user_id ||
          parse(oa.operators, []).includes(m.user_id) ||
          (has(m, "team_admin") && parse(m.teams, []).includes(oa.team_id)))),
    403,
    "DRIVE_FORBIDDEN",
    "接続した担当者の権限を確認してください。",
  );
}
export async function scanDrive(rt: Runtime, con: Row) {
  await eligibleConnection(rt, con);
  const cfg = parse(con.config);
  if (!cfg.roots?.length) {
    await rt.db.query("UPDATE connections SET last_sync_at=? WHERE id=?", [
      now(),
      con.id,
    ]);
    return { detected: 0, complete: true };
  }
  if (con.state === "syncing" && cfg.leaseUntil > now()) return { busy: true };
  const locked = {
    ...cfg,
    leaseUntil: new Date(Date.now() + 120000).toISOString(),
  };
  const lock = await rt.db.query(
    "UPDATE connections SET state='syncing',config=? WHERE id=? AND config=? AND state IN ('connected','syncing')",
    [json(locked), con.id, con.config],
  );
  if (!lock.changes) return { busy: true };
  try {
    const token = await driveAccessToken(rt, con),
      db = await inboxDB(rt, con.tenant_id, con.oa_id);
    const queue: Array<{ folder: string; page?: string }> = cfg.queue?.length
      ? cfg.queue
      : cfg.roots.map((folder: string) => ({ folder }));
    const seen: string[] = cfg.queue?.length ? cfg.seen || [] : [...cfg.roots];
    let detected = 0,
      updated = 0;
    const visitedFiles: string[] = cfg.queue?.length
      ? cfg.visitedFiles || []
      : [];
    for (let page = 0; page < 2 && queue.length; page++) {
      const current = queue[0];
      const data = await driveJSON(rt, token, "files", {
        q: `'${driveId.parse(current.folder)}' in parents and trashed=false`,
        fields:
          "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)",
        pageSize: "100",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(current.page ? { pageToken: current.page } : {}),
      });
      requireThat(
        !data.incompleteSearch,
        502,
        "DRIVE_INCOMPLETE",
        "保存先の検索を完了できませんでした。次回再確認します。",
      );
      for (const f of data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          if (cfg.recursive !== false && !seen.includes(f.id)) {
            requireThat(
              seen.length < 10000,
              409,
              "DRIVE_TOO_LARGE",
              "保存先をより小さいフォルダに絞ってください。",
            );
            seen.push(f.id);
            queue.push({ folder: f.id });
          }
        } else if (
          ["application/vnd.google-apps.document", "text/plain"].includes(
            f.mimeType,
          )
        ) {
          visitedFiles.push(f.id);
          const previous = await one(
            db,
            "SELECT * FROM meeting_inbox WHERE id=?",
            [f.id],
          );
          const inserted = await db.query(
            "INSERT OR IGNORE INTO meeting_inbox(id,connection_id,title,mime_type,modified_at,detected_at,source_email,held_at) VALUES (?,?,?,?,?,?,?,?)",
            [
              f.id,
              con.id,
              f.name,
              f.mimeType,
              f.modifiedTime,
              now(),
              cfg.hostEmail || cfg.email,
              meetingTime(f.name),
            ],
          );
          detected += inserted.changes;
          const change = await db.query(
            "UPDATE meeting_inbox SET title=?,modified_at=?,held_at=COALESCE(?,held_at),analysis=NULL,state=CASE WHEN state='ignored' THEN 'ignored' ELSE 'unlinked' END,lease_until=NULL,version=version+1 WHERE id=? AND (modified_at<>? OR state='missing')",
            [f.name, f.modifiedTime, meetingTime(f.name), f.id, f.modifiedTime],
          );
          updated += change.changes;
          if (change.changes && previous)
            await invalidateMeetingSource(
              rt,
              con.tenant_id,
              con.oa_id,
              previous,
            );
          if (change.changes && previous?.state === "missing")
            await db.query(
              "UPDATE meeting_auto_state SET state='retry',next_at='' WHERE file_id=?",
              [f.id],
            );
        }
      }
      if (data.nextPageToken)
        queue[0] = { ...current, page: data.nextPageToken };
      else queue.shift();
    }
    if (!queue.length) {
      const absent = await all(
        db,
        "SELECT * FROM meeting_inbox WHERE connection_id=? AND state NOT IN ('ignored','missing') AND id NOT IN (SELECT value FROM json_each(?))",
        [con.id, json(visitedFiles)],
      );
      for (const doc of absent) {
        await invalidateMeetingSource(rt, con.tenant_id, con.oa_id, doc);
        await db.query(
          "UPDATE meeting_inbox SET state='missing',version=version+1 WHERE id=?",
          [doc.id],
        );
      }
    }
    await rt.db.query(
      "UPDATE connections SET state='connected',config=?,last_sync_at=?,last_error=NULL WHERE id=? AND config=?",
      [
        json({
          ...cfg,
          queue,
          visitedFiles: queue.length ? visitedFiles : [],
          nextScanAt: new Date(
            (Math.floor(Date.now() / 300000) + 1) * 300000,
          ).toISOString(),
          seen: queue.length ? seen : [],
          leaseUntil: null,
        }),
        now(),
        con.id,
        json(locked),
      ],
    );
    return { detected, updated, complete: !queue.length };
  } catch (error) {
    await rt.db.query(
      "UPDATE connections SET state=CASE WHEN state='reconnect' THEN state ELSE 'connected' END,config=?,last_sync_at=?,last_error='Drive検知に失敗しました。接続と保存先を確認してください。' WHERE id=? AND config=?",
      [
        json({
          ...cfg,
          leaseUntil: null,
          nextScanAt: new Date(Date.now() + 300000).toISOString(),
        }),
        now(),
        con.id,
        json(locked),
      ],
    );
    throw error;
  }
}
export async function pollDrive(
  rt: Runtime,
  scope?: { tenant: string; oa: string },
) {
  if (rt.driveManualOnly) return;
  const rows = await all(
    rt.db,
    "SELECT * FROM connections WHERE service LIKE 'google_drive:%' AND state IN ('connected','syncing') AND (? IS NULL OR (tenant_id=? AND oa_id=?)) AND (last_sync_at IS NULL OR COALESCE(json_extract(config,'$.nextScanAt'),last_sync_at)<=?) ORDER BY COALESCE(last_sync_at,'') LIMIT 2",
    [scope?.tenant || null, scope?.tenant || null, scope?.oa || null, now()],
  );
  for (const con of rows) {
    try {
      await scanDrive(rt, con);
    } catch (error) {
      await rt.db.query(
        "UPDATE connections SET last_sync_at=?,last_error=?,state=CASE WHEN ?=403 THEN 'reconnect' ELSE state END WHERE id=?",
        [
          now(),
          "接続した担当者の権限・Google連携を確認してください。",
          (error as any).status || 502,
          con.id,
        ],
      );
    }
  }
}
export async function refreshMeetingDocument(rt: Runtime, con: Row, doc: Row) {
  await eligibleConnection(rt, con);
  const token = await driveAccessToken(rt, con);
  const meta = await driveJSON(rt, token, `files/${driveId.parse(doc.id)}`, {
    fields: "name,mimeType,modifiedTime,trashed",
    supportsAllDrives: "true",
  });
  requireThat(
    !meta.trashed && typeof meta.modifiedTime === "string",
    409,
    "DOCUMENT_UNAVAILABLE",
    "元の議事録が削除されているか、取得できません。Driveの原文を確認してください。",
  );
  const db = await inboxDB(rt, con.tenant_id, con.oa_id);
  requireThat(
    !["analyzing", "applying"].includes(doc.state),
    409,
    "NOTE_BUSY",
    "解析・保存中です。完了してから再確認してください。",
  );
  const result = await db.query(
    "UPDATE meeting_inbox SET title=?,modified_at=?,analysis=CASE WHEN modified_at<>? THEN NULL ELSE analysis END,state=CASE WHEN modified_at<>? THEN 'unlinked' ELSE state END,version=version+CASE WHEN modified_at<>? THEN 1 ELSE 0 END WHERE id=? AND connection_id=? AND version=? AND state NOT IN ('analyzing','applying','ignored','missing')",
    [
      meta.name || doc.title,
      meta.modifiedTime,
      meta.modifiedTime,
      meta.modifiedTime,
      meta.modifiedTime,
      doc.id,
      con.id,
      doc.version,
    ],
  );
  requireThat(
    result.changes,
    409,
    "NOTE_CHANGED",
    "議事録の状態が変わりました。もう一度最新版を取得してください。",
  );
  if (meta.modifiedTime !== doc.modified_at)
    await invalidateMeetingSource(rt, con.tenant_id, con.oa_id, doc);
  return (await one(db, "SELECT * FROM meeting_inbox WHERE id=?", [doc.id]))!;
}
export async function readMeetingText(rt: Runtime, con: Row, doc: Row) {
  await eligibleConnection(rt, con);
  const token = await driveAccessToken(rt, con),
    meta = await driveJSON(rt, token, `files/${driveId.parse(doc.id)}`, {
      fields: "modifiedTime,trashed",
      supportsAllDrives: "true",
    });
  requireThat(
    !meta.trashed && meta.modifiedTime === doc.modified_at,
    409,
    "DOCUMENT_CHANGED",
    "議事録が更新されています。再検知してから解析してください。",
  );
  const url =
    doc.mime_type === "application/vnd.google-apps.document"
      ? `https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=text%2Fplain`
      : `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`;
  const r = await rt.externalFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  requireThat(
    r.ok && r.body,
    502,
    "DOCUMENT_READ_FAILED",
    "議事録本文を取得できません。",
  );
  const reader = r.body!.getReader(),
    decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      requireThat(
        bytes <= 200000,
        413,
        "DOCUMENT_TOO_LARGE",
        "議事録を50,000文字以内に分割してください。",
      );
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  requireThat(
    text.trim().length >= 10 && text.length <= 50000,
    413,
    "DOCUMENT_SIZE",
    "議事録は10〜50,000文字である必要があります。",
  );
  const after = await driveJSON(rt, token, `files/${driveId.parse(doc.id)}`, {
    fields: "modifiedTime,trashed",
    supportsAllDrives: "true",
  });
  requireThat(
    !after.trashed && after.modifiedTime === doc.modified_at,
    409,
    "DOCUMENT_CHANGED",
    "本文の取得中に議事録が更新されました。再検知してから解析してください。",
  );
  return text;
}
export function registerDrive(app: Hono<AppEnv>) {
  const base = "/api/tenants/:tenantId/accounts/:oaId/connectors/drive";
  app.get(base, async (c) => {
    const a = await recordingAccess(c),
      actor = c.get("principal").user.id,
      rows = await all(
        a.rt.db,
        "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service LIKE 'google_drive:%'",
        [a.tenant, a.oa],
      );
    return c.json({
      enabled: !!a.rt.googleOAuth,
      manualOnly: !!a.rt.driveManualOnly,
      redirectUri: `${a.rt.origin}/api/drive/callback`,
      connections: await Promise.all(
        rows.map(async (r) => {
          const v = parse(r.config);
          return {
            id: r.id,
            revision: await digest(r.config || "{}"),
            email: v.email,
            hostEmail: v.hostEmail,
            roots: v.roots || [],
            folderNames: v.folderNames || [],
            state: r.state,
            lastSync: r.last_sync_at,
            error: r.last_error,
            mine: v.actor === actor,
            remaining: v.queue?.length || 0,
          };
        }),
      ),
    });
  });
  app.post(base + "/authorize", async (c) => {
    const a = await recordingAccess(c),
      p = c.get("principal");
    requireThat(
      a.rt.googleOAuth,
      503,
      "GOOGLE_NOT_CONFIGURED",
      "Google連携の設定が必要です。",
    );
    // Fail before asking the user for consent if the server cannot store it.
    try {
      const probe = await encrypt(
        a.rt.key,
        "drive-preflight",
        "drive-preflight",
      );
      requireThat(
        (await decrypt(a.rt.key, probe, "drive-preflight")) ===
          "drive-preflight",
        503,
        "CREDENTIAL_STORAGE_UNAVAILABLE",
        "接続情報の保存設定を運営側で修正する必要があります。",
      );
    } catch {
      throw new AppError(
        503,
        "CREDENTIAL_STORAGE_UNAVAILABLE",
        "接続情報の保存設定を運営側で修正する必要があります。Googleの設定をやり直す必要はありません。",
      );
    }
    await a.rt.db.query(driveStateDDL);
    const state = id() + id();
    await a.rt.db.batch([
      {
        sql: "DELETE FROM drive_oauth_states WHERE expires_at<? OR (tenant_id=? AND oa_id=? AND user_id=?)",
        params: [now(), a.tenant, a.oa, p.user.id],
      },
      {
        sql: "INSERT INTO drive_oauth_states VALUES (?,?,?,?,?,?)",
        params: [
          await digest(state),
          a.tenant,
          a.oa,
          p.user.id,
          p.sessionId,
          new Date(Date.now() + 600000).toISOString(),
        ],
      },
    ]);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: a.rt.googleOAuth!.clientId,
      redirect_uri: `${a.rt.origin}/api/drive/callback`,
      response_type: "code",
      scope: `openid email ${driveScope}`,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return c.json({ url: url.href });
  });
  app.get("/api/drive/callback", async (c) => {
    let target = "";
    let stage = "state";
    let targetTenant: string | null = null,
      targetOa = "unknown";
    try {
      const rt = c.env.runtime,
        p = c.get("principal"),
        state = c.req.query("state");
      requireThat(
        state && rt.googleOAuth,
        400,
        "OAUTH_STATE",
        "Google連携を最初からやり直してください。",
      );
      await rt.db.query(driveStateDDL);
      const s = await one(
        rt.db,
        "SELECT * FROM drive_oauth_states WHERE id=? AND user_id=? AND session_id=? AND expires_at>?",
        [await digest(state!), p.user.id, p.sessionId, now()],
      );
      requireThat(
        s,
        400,
        "OAUTH_STATE",
        "Google連携の有効期限が切れたか、ログインが変わりました。連携をやり直してください。",
      );
      targetTenant = s!.tenant_id;
      targetOa = s!.oa_id;
      target = `tenant=${encodeURIComponent(s!.tenant_id)}&oa=${encodeURIComponent(s!.oa_id)}&`;
      const used = await rt.db.query(
        "DELETE FROM drive_oauth_states WHERE id=?",
        [s!.id],
      );
      requireThat(
        used.changes === 1,
        409,
        "OAUTH_USED",
        "この認証は使用済みです。",
      );
      stage = "access";
      await eligibleConnection(rt, {
        tenant_id: s!.tenant_id,
        oa_id: s!.oa_id,
        config: json({ actor: p.user.id }),
      });
      if (c.req.query("error"))
        return c.redirect(
          `/sales/connections?tenant=${encodeURIComponent(s!.tenant_id)}&oa=${encodeURIComponent(s!.oa_id)}&drive=cancelled`,
        );
      const code = c.req.query("code");
      requireThat(code, 400, "OAUTH_CODE", "Googleの認証コードがありません。");
      stage = "token";
      const r = await rt.externalFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          code: code!,
          client_id: rt.googleOAuth!.clientId,
          client_secret: rt.googleOAuth!.clientSecret,
          redirect_uri: `${rt.origin}/api/drive/callback`,
          grant_type: "authorization_code",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const failure: any = await r.json().catch(() => ({}));
        const classification =
          failure.error === "invalid_client"
            ? "GOOGLE_CLIENT_INVALID"
            : failure.error === "redirect_uri_mismatch"
              ? "GOOGLE_REDIRECT_INVALID"
              : failure.error === "invalid_grant"
                ? "GOOGLE_GRANT_INVALID"
                : "OAUTH_EXCHANGE";
        requireThat(
          false,
          502,
          classification,
          "Google認証の設定を確認して再連携してください。",
        );
      }
      const token: any = await r.json();
      requireThat(
        token.refresh_token &&
          String(token.scope).split(" ").includes(driveScope),
        400,
        "DRIVE_SCOPE",
        "Driveの読み取りを許可して再連携してください。",
      );
      requireThat(
        typeof token.access_token === "string" && !!token.access_token,
        502,
        "GOOGLE_TOKEN_INVALID",
        "Googleの認証応答を確認できませんでした。",
      );
      stage = "profile";
      const profile = await rt.externalFetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      requireThat(
        profile.ok,
        502,
        "GOOGLE_PROFILE",
        "Googleアカウントを確認できません。",
      );
      const u: any = await profile.json();
      requireThat(
        u.email_verified && u.email,
        400,
        "GOOGLE_EMAIL",
        "確認済みGoogleメールアドレスが必要です。",
      );
      stage = "sources";
      const service = `google_drive:${p.user.id}`,
        old = await one(
          rt.db,
          "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",
          [s!.tenant_id, s!.oa_id, service],
        ),
        prev = parse(old?.config),
        sources = (
          await readRecordingSources(rt, s!.tenant_id, s!.oa_id)
        ).config.sources.filter(
          (x) => x.enabled && x.hostEmail === u.email.toLowerCase(),
        ),
        same = prev.email === u.email;
      const cfg = {
        actor: p.user.id,
        email: u.email,
        hostEmail: same ? prev.hostEmail : u.email,
        roots: same
          ? prev.roots || []
          : sources.map((x) => driveFolderId(x.folderUrl)),
        folderNames: same
          ? prev.folderNames || []
          : sources.map((x) => x.label),
        recursive: true,
        queue: [],
      };
      stage = "credential";
      await putCredential(
        rt,
        s!.tenant_id,
        s!.oa_id,
        service,
        { refreshToken: token.refresh_token },
        p.user.id,
      );
      stage = "connection";
      await rt.db.query(
        "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES (?,?,?,?,'connected',?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET state='connected',config=excluded.config,last_error=NULL,last_sync_at=NULL",
        [old?.id || id(), s!.tenant_id, s!.oa_id, service, json(cfg)],
      );
      return c.redirect(
        `/sales/connections?tenant=${encodeURIComponent(s!.tenant_id)}&oa=${encodeURIComponent(s!.oa_id)}&drive=connected`,
      );
    } catch (error) {
      const allowed = new Set([
        "GOOGLE_CLIENT_INVALID",
        "GOOGLE_REDIRECT_INVALID",
        "GOOGLE_GRANT_INVALID",
        "OAUTH_STATE",
        "OAUTH_USED",
        "OAUTH_CODE",
        "OAUTH_EXCHANGE",
        "DRIVE_SCOPE",
        "GOOGLE_PROFILE",
        "GOOGLE_EMAIL",
        "DRIVE_FORBIDDEN",
        "TENANT_SUSPENDED",
        "TENANT_FORBIDDEN",
        "INTEGRATION_ACTION_DISABLED",
        "INTEGRATION_NETWORK_DISABLED",
        "INTEGRATION_REDIRECT_BLOCKED",
        "PROVIDER_REDIRECT_BLOCKED",
        "GOOGLE_TOKEN_INVALID",
      ]);
      const stageCodes: Record<string, string> = {
        state: "DRIVE_STATE_FAILED",
        access: "DRIVE_ACCESS_FAILED",
        token: "GOOGLE_TOKEN_REQUEST_FAILED",
        profile: "GOOGLE_PROFILE",
        sources: "DRIVE_SOURCES_FAILED",
        credential: "CREDENTIAL_STORAGE_UNAVAILABLE",
        connection: "DRIVE_CONNECTION_SAVE_FAILED",
      };
      const code =
        error instanceof AppError && allowed.has(error.code)
          ? error.code
          : stageCodes[stage] || "DRIVE_CALLBACK_FAILED";
      await audit(
        c.env.runtime.db,
        c.get("principal").user.id,
        "drive.oauth_failed",
        targetOa,
        targetTenant,
        { code, stage },
      ).catch(() => {});
      return c.redirect(
        `/sales/connections?${target}drive=retry&reason=${code}`,
      );
    }
  });
  app.get(base + "/folders", async (c) => {
    const a = await recordingAccess(c),
      con = await ownDrive(a.rt, a.tenant, a.oa, c.get("principal").user.id),
      token = await driveAccessToken(a.rt, con),
      parent = c.req.query("parent"),
      q = parent ? ` and '${driveId.parse(parent)}' in parents` : "";
    return c.json(
      await driveJSON(a.rt, token, "files", {
        q: `mimeType='application/vnd.google-apps.folder' and trashed=false${q}`,
        fields: "nextPageToken,files(id,name)",
        pageSize: "100",
        orderBy: "name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(c.req.query("page") ? { pageToken: c.req.query("page")! } : {}),
      }),
    );
  });
  app.put(base + "/folders", async (c) => {
    const a = await recordingAccess(c),
      con = await ownDrive(a.rt, a.tenant, a.oa, c.get("principal").user.id),
      v = z
        .object({
          roots: z.array(driveId).min(1).max(20),
          revision: z.string().max(100).optional(),
          hostEmail: z.email().optional(),
          recursive: z.boolean().default(true),
        })
        .parse(await c.req.json());
    requireThat(
      !v.revision || v.revision === (await digest(con.config || "{}")),
      409,
      "DRIVE_CHANGED",
      "保存先が変更されました。状態を再読み込みしてください。",
    );
    requireThat(
      con.state !== "syncing",
      409,
      "DRIVE_BUSY",
      "検知中です。少し待って再保存してください。",
    );
    const token = await driveAccessToken(a.rt, con),
      names = [];
    for (const folder of v.roots) {
      const f = await driveJSON(a.rt, token, `files/${folder}`, {
        fields: "id,name,mimeType,trashed",
        supportsAllDrives: "true",
      });
      requireThat(
        f.mimeType === "application/vnd.google-apps.folder" && !f.trashed,
        400,
        "NOT_FOLDER",
        "有効なフォルダを選択してください。",
      );
      names.push(f.name);
    }
    const r = await a.rt.db.query(
      "UPDATE connections SET config=?,last_sync_at=NULL WHERE id=? AND config=? AND state='connected'",
      [
        json({
          ...parse(con.config),
          roots: [...new Set(v.roots)],
          hostEmail: (
            v.hostEmail ||
            parse(con.config).hostEmail ||
            parse(con.config).email
          ).toLowerCase(),
          recursive: v.recursive,
          folderNames: names,
          queue: [],
          seen: [],
        }),
        con.id,
        con.config,
      ],
    );
    requireThat(
      r.changes,
      409,
      "DRIVE_CHANGED",
      "接続が更新されました。再読み込みしてください。",
    );
    return c.json({ ok: true });
  });
  app.post(base + "/scan", async (c) => {
    const a = await recordingAccess(c),
      con = await ownDrive(a.rt, a.tenant, a.oa, c.get("principal").user.id);
    return c.json(await scanDrive(a.rt, con));
  });
  app.post(base + "/disconnect", async (c) => {
    const a = await recordingAccess(c),
      service = `google_drive:${c.get("principal").user.id}`;
    await a.rt.db.query(driveStateDDL);
    await a.rt.db.batch([
      {
        sql: "DELETE FROM drive_oauth_states WHERE tenant_id=? AND oa_id=? AND user_id=?",
        params: [a.tenant, a.oa, c.get("principal").user.id],
      },
      {
        sql: "DELETE FROM credentials WHERE tenant_id=? AND oa_id=? AND service=?",
        params: [a.tenant, a.oa, service],
      },
      {
        sql: "UPDATE connections SET state='disconnected',config='{}' WHERE tenant_id=? AND oa_id=? AND service=?",
        params: [a.tenant, a.oa, service],
      },
    ]);
    await audit(
      a.rt.db,
      c.get("principal").user.id,
      "drive.disconnected",
      a.oa,
      a.tenant,
    );
    return c.json({ ok: true });
  });
}
