import type { Hono } from "hono";
import type { AppEnv, Principal, Runtime } from "./runtime.ts";
import { one, id, json } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { putCredential } from "./credentials.ts";
import {
  googleAdmin,
  boundedJSON,
  googleId,
} from "./assistant-google-store.ts";

export const newsDriveScope = "https://www.googleapis.com/auth/drive.file";
import { newsOAuthDDL } from "./assistant-google-schema.ts";
const callback = "/api/assistant-news-drive/callback";
function enabled(rt: Runtime) {
  requireThat(
    rt.assistantNewsAuthorizationEnabled && rt.googleOAuth,
    409,
    "NEWS_AUTHORIZATION_DISABLED",
    "ニュース保存用の認可は停止中です。管理者が環境設定を確認してください。",
  );
}
export async function beginNewsGrant(
  rt: Runtime,
  t: string,
  oa: string,
  p: Principal,
) {
  enabled(rt);
  await googleAdmin(rt, t, oa, p.user.id);
  await rt.db.query(newsOAuthDDL);
  const state = id() + id();
  await rt.db.batch([
    {
      sql: "DELETE FROM assistant_news_oauth_states WHERE user_id=? AND tenant_id=? AND oa_id=?",
      params: [p.user.id, t, oa],
    },
    {
      sql: "INSERT INTO assistant_news_oauth_states VALUES (?,?,?,?,?,?)",
      params: [
        await digest(state),
        t,
        oa,
        p.user.id,
        p.sessionId,
        new Date(Date.now() + 600000).toISOString(),
      ],
    },
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: rt.googleOAuth!.clientId,
    redirect_uri: rt.origin + callback,
    response_type: "code",
    scope: `openid email ${newsDriveScope}`,
    state,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return { url: url.toString() };
}
export async function finishNewsGrant(
  rt: Runtime,
  p: Principal,
  query: { state?: string; code?: string; error?: string },
) {
  enabled(rt);
  await rt.db.query(newsOAuthDDL);
  requireThat(
    query.state && query.state.length <= 200,
    400,
    "NEWS_OAUTH_STATE",
    "認可を開始し直してください。",
  );
  const key = await digest(query.state!),
    s = await one(
      rt.db,
      "SELECT * FROM assistant_news_oauth_states WHERE id=?",
      [key],
    );
  requireThat(
    s &&
      s.user_id === p.user.id &&
      s.session_id === p.sessionId &&
      s.expires_at > new Date().toISOString(),
    400,
    "NEWS_OAUTH_STATE",
    "認可が期限切れか、ログインした担当者が異なります。",
  );
  await googleAdmin(rt, s.tenant_id, s.oa_id, p.user.id);
  const consumed = await rt.db.query(
    "DELETE FROM assistant_news_oauth_states WHERE id=? AND user_id=? AND session_id=?",
    [key, p.user.id, p.sessionId],
  );
  requireThat(
    consumed.changes === 1,
    409,
    "NEWS_OAUTH_USED",
    "この認可は処理済みです。",
  );
  if (query.error) return { cancelled: true, tenant: s.tenant_id, oa: s.oa_id };
  requireThat(
    query.code && query.code.length <= 4096,
    400,
    "NEWS_OAUTH_CODE",
    "認証コードがありません。",
  );
  const token = await boundedJSON(
    await rt.externalFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        code: query.code!,
        client_id: rt.googleOAuth!.clientId,
        client_secret: rt.googleOAuth!.clientSecret,
        redirect_uri: rt.origin + callback,
        grant_type: "authorization_code",
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }),
  );
  requireThat(
    typeof token.refresh_token === "string" &&
      typeof token.access_token === "string" &&
      String(token.scope).split(" ").includes(newsDriveScope),
    400,
    "NEWS_OAUTH_SCOPE",
    "ニュース保存の認可を許可して再連携してください。",
  );
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const profile = await boundedJSON(
    await rt.externalFetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }),
  );
  requireThat(
    profile.email_verified === true && typeof profile.email === "string",
    400,
    "NEWS_OAUTH_EMAIL",
    "確認済みGoogleアカウントが必要です。",
  );
  // drive.file cannot grant arbitrary existing folders by typing an ID. Create an app-owned folder, or reuse its exact scope marker.
  const marker = (
    await digest(`${s.tenant_id}:${s.oa_id}:${p.user.id}`)
  ).replace(/[^\w-]/g, "");
  const lookup = new URL("https://www.googleapis.com/drive/v3/files");
  lookup.search = new URLSearchParams({
    q: `trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='tsunaguNewsScope' and value='${marker}' }`,
    fields: "files(id),nextPageToken",
    pageSize: "2",
  }).toString();
  const found = await boundedJSON(
    await rt.externalFetch(lookup, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }),
  );
  requireThat(
    Array.isArray(found.files) &&
      found.files.length <= 1 &&
      !found.nextPageToken,
    409,
    "NEWS_FOLDER_AMBIGUOUS",
    "保存用フォルダが複数あります。管理者が整理してから再連携してください。",
  );
  const folder =
    found.files[0] ||
    (await boundedJSON(
      await rt.externalFetch(
        "https://www.googleapis.com/drive/v3/files?fields=id",
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: json({
            name: "つなぐ ニュース（確認待ち）",
            mimeType: "application/vnd.google-apps.folder",
            appProperties: { tsunaguNewsScope: marker },
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        },
      ),
    ));
  const folderId = googleId.parse(folder.id),
    service = `google_drive_news:${p.user.id}`;
  await putCredential(
    rt,
    s.tenant_id,
    s.oa_id,
    service,
    { refreshToken: token.refresh_token, folderId, scopes: token.scope },
    p.user.id,
  );
  await rt.db.query(
    "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES (?,?,?,?,'connected',?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET state='connected',config=excluded.config,last_error=NULL,last_sync_at=NULL",
    [
      id(),
      s.tenant_id,
      s.oa_id,
      service,
      json({ actor: p.user.id, email: profile.email, folderId }),
    ],
  );
  // Neither enable research nor replace an existing source configuration as a side effect of consent.
  return { cancelled: false, folderId, tenant: s.tenant_id, oa: s.oa_id };
}
export function registerNewsDriveOAuth(app: Hono<AppEnv>) {
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/assistant/google/news/authorize",
    async (c) => {
      const body = await c.req.json();
      requireThat(
        body?.acknowledgeFolderCreation === true,
        400,
        "NEWS_OAUTH_CONSENT",
        "専用フォルダ作成への確認が必要です。",
      );
      return c.json(
        await beginNewsGrant(
          c.env.runtime,
          c.req.param("tenantId")!,
          c.req.param("oaId")!,
          c.get("principal"),
        ),
      );
    },
  );
  app.get(callback, async (c) => {
    try {
      const result = await finishNewsGrant(c.env.runtime, c.get("principal"), {
        state: c.req.query("state"),
        code: c.req.query("code"),
        error: c.req.query("error"),
      });
      return c.redirect(
        `/sales/connections?tenant=${encodeURIComponent(result.tenant)}&oa=${encodeURIComponent(result.oa)}&newsDrive=${result.cancelled ? "cancelled" : "connected"}`,
      );
    } catch {
      return c.redirect("/sales/connections?newsDrive=retry");
    }
  });
}
