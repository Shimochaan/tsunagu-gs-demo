import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { z } from "zod";
import { AppError, digest, requireThat } from "./security.ts";
import { googleAPIError } from "./google-api-errors.ts";
import { member, accountFor, has, customerAccess } from "./access.ts";
import { putCredential } from "./credentials.ts";
import { driveAccessToken } from "./drive.ts";
import { recordingAccess } from "./recording-sources.ts";
import { holdCustomer } from "./sales.ts";
export const calendarScope =
  "https://www.googleapis.com/auth/calendar.events.readonly";
export const calendarStateDDL = `CREATE TABLE IF NOT EXISTS calendar_oauth_states (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,expires_at TEXT NOT NULL)`;
export const calendarDDL = [
  `CREATE TABLE IF NOT EXISTS calendar_items (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,event_id TEXT NOT NULL,ical_uid TEXT,title TEXT NOT NULL,starts_at TEXT,ends_at TEXT,state TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,seen_run TEXT,customer_id TEXT,appointment_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS calendar_items_connection ON calendar_items(connection_id,starts_at)`,
];
const nextTick = () =>
  new Date((Math.floor(Date.now() / 300000) + 1) * 300000).toISOString();
async function calendarDB(rt: Runtime, t: string, oa: string) {
  const db = await rt.openDatabase(t, oa, "tsunagu");
  for (const sql of calendarDDL) await db.query(sql);
  return db;
}
async function calendarAccess(
  rt: Runtime,
  t: string,
  oa: string,
  actor: string,
) {
  const m = await member(rt, actor, t),
    a = await accountFor(rt, t, oa),
    company = await one(rt.db, "SELECT state FROM tenants WHERE id=?", [t]);
  requireThat(
    company?.state === "active" &&
      (has(m, "org_owner", "sys_admin") ||
        (has(m, "sales", "team_admin") &&
          (a.owner_user_id === actor ||
            parse(a.operators, []).includes(actor)))),
    403,
    "CALENDAR_FORBIDDEN",
    "この予定を接続する権限を確認してください。",
  );
  return m;
}
export async function applyCalendarItem(rt: Runtime, con: Row, item: Row) {
  if (!item.customer_id || !item.appointment_id) return;
  const h = await rt.openDatabase(con.tenant_id, con.oa_id, "harness"),
    common = await rt.openDatabase(con.tenant_id, "", "common"),
    db = await calendarDB(rt, con.tenant_id, con.oa_id);
  const old = await one(h, "SELECT * FROM appointments WHERE id=?", [
    item.appointment_id,
  ]);
  const data = parse(item.data),
    state =
      item.state === "cancelled"
        ? "cancelled"
        : old?.state === "attended" && old.starts_at === item.starts_at
          ? "attended"
          : old
            ? "rescheduled"
            : "booked";
  if (old && old.source !== "google_calendar") return; // 明示的に対応付けたTimeRex予定はTimeRexを正本とする。
  if (!item.starts_at) return;
  const changed =
    !old ||
    old.starts_at !== item.starts_at ||
    old.ends_at !== item.ends_at ||
    old.title !== item.title ||
    (item.state === "cancelled") !== (old.state === "cancelled") ||
    parse(old.details).location !== (data.location || "");
  if (!changed) return;
  await h.query(
    `INSERT INTO appointments(id,customer_id,external_id,title,starts_at,ends_at,state,source,details,version) VALUES (?,?,?,?,?,?,?,'google_calendar',?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,state=excluded.state,details=excluded.details,version=version+1`,
    [
      item.appointment_id,
      item.customer_id,
      `calendar:${item.id}`,
      item.title,
      item.starts_at,
      item.ends_at,
      state,
      json({
        calendarItem: item.id,
        hostEmails: [parse(con.config).email],
        location: data.location || "",
        detailsUrl: data.htmlLink || "",
      }),
    ],
  );
  await db.query(
    "INSERT INTO followup_meetings(appointment_id,customer_id,confirmed_by,confirmed_at) VALUES (?,?,?,?) ON CONFLICT(appointment_id) DO UPDATE SET confirmed_at=excluded.confirmed_at",
    [item.appointment_id, item.customer_id, parse(con.config).actor, now()],
  );
  const future = await one(
    h,
    "SELECT id FROM appointments WHERE customer_id=? AND starts_at>? AND state IN ('booked','rescheduled') LIMIT 1",
    [item.customer_id, now()],
  );
  await common.query(
    "UPDATE customers SET stage=CASE WHEN stage IN ('won','lost') THEN stage WHEN ? THEN 'booked' WHEN stage='booked' THEN 'result_pending' ELSE stage END,version=version+1 WHERE id=?",
    [Number(!!future), item.customer_id],
  );
  await holdCustomer(
    rt,
    con.tenant_id,
    item.customer_id,
    "会議予定が更新されました。最新の日程で追客を再検討します。",
  );
}
export async function syncCalendar(rt: Runtime, con: Row) {
  const cfg = parse(con.config);
  await calendarAccess(rt, con.tenant_id, con.oa_id, cfg.actor);
  if (cfg.nextSyncAt > now() || cfg.leaseUntil > now())
    return { skipped: true };
  // 差分トークンだけでは未変更の遠い将来の予定は窓に入らない。月次で期間を延長する。
  if (
    cfg.lastFullAt &&
    Date.parse(cfg.lastFullAt) < Date.now() - 30 * 86400000 &&
    !cfg.pageToken
  ) {
    cfg.syncToken = null;
    cfg.run = null;
    cfg.since = null;
    cfg.until = null;
    cfg.lastFullAt = null;
  }
  const locked = {
    ...cfg,
    leaseUntil: new Date(Date.now() + 120000).toISOString(),
  };
  if (
    !(
      await rt.db.query(
        "UPDATE connections SET config=? WHERE id=? AND config=? AND state='connected'",
        [json(locked), con.id, con.config],
      )
    ).changes
  )
    return { skipped: true };
  const db = await calendarDB(rt, con.tenant_id, con.oa_id);
  try {
    const token = await driveAccessToken(rt, con);
    const full = !cfg.syncToken,
      run = cfg.run || id(),
      since = cfg.since || new Date(Date.now() - 30 * 86400000).toISOString(),
      until = cfg.until || new Date(Date.now() + 365 * 86400000).toISOString();
    let pageToken = cfg.pageToken,
      syncToken = cfg.syncToken,
      changed = 0,
      complete = false;
    for (let page = 0; page < 2; page++) {
      const query = new URLSearchParams({
        maxResults: "100",
        singleEvents: "true",
        showDeleted: "true",
        fields:
          "nextPageToken,nextSyncToken,items(id,iCalUID,summary,start,end,status,updated,location,htmlLink,eventType,visibility)",
        ...(syncToken ? { syncToken } : { timeMin: since, timeMax: until }),
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await rt.externalFetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId || "primary")}/events?${query}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (response.status === 410) {
        await rt.db.query(
          "UPDATE connections SET config=?,last_error='予定を再同期しています。',last_sync_at=? WHERE id=? AND config=?",
          [
            json({
              ...cfg,
              syncToken: null,
              pageToken: null,
              run: null,
              leaseUntil: null,
              nextSyncAt: nextTick(),
            }),
            now(),
            con.id,
            json(locked),
          ],
        );
        return { reset: true };
      }
      if (!response.ok) throw await googleAPIError(response, "calendar");
      const data: any = await response.json();
      for (const e of data.items || []) {
        if (!e.id || (e.eventType && e.eventType !== "default")) continue;
        const key = (
            await digest(`${con.id}:${cfg.calendarId || "primary"}:${e.id}`)
          )
            .replaceAll("/", "_")
            .replaceAll("+", "-")
            .replace(/=+$/, ""),
          old = await one(db, "SELECT * FROM calendar_items WHERE id=?", [key]);
        const start =
            e.start?.dateTime ||
            (e.start?.date ? `${e.start.date}T00:00:00+09:00` : old?.starts_at),
          end =
            e.end?.dateTime ||
            (e.end?.date ? `${e.end.date}T00:00:00+09:00` : old?.ends_at);
        const normalizedStart = start ? new Date(start).toISOString() : null,
          normalizedEnd = end ? new Date(end).toISOString() : null;
        const state = e.status === "cancelled" ? "cancelled" : "booked",
          title = String(e.summary || old?.title || "予定").slice(0, 200),
          body = json({
            htmlLink: e.htmlLink || "",
            location: e.location || "",
            allDay: !!e.start?.date,
          });
        await db.query(
          `INSERT INTO calendar_items(id,connection_id,event_id,ical_uid,title,starts_at,ends_at,state,data,updated_at,seen_run) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,state=excluded.state,data=excluded.data,updated_at=excluded.updated_at,seen_run=excluded.seen_run,version=version+CASE WHEN title<>excluded.title OR starts_at IS NOT excluded.starts_at OR ends_at IS NOT excluded.ends_at OR state<>excluded.state OR data<>excluded.data THEN 1 ELSE 0 END`,
          [
            key,
            con.id,
            e.id,
            e.iCalUID || null,
            title,
            normalizedStart,
            normalizedEnd,
            state,
            body,
            now(),
            run,
          ],
        );
        const item = (await one(db, "SELECT * FROM calendar_items WHERE id=?", [
          key,
        ]))!;
        if (!old || item.version !== old.version) changed++;
        await applyCalendarItem(rt, con, item);
      }
      pageToken = data.nextPageToken;
      if (!pageToken) {
        syncToken = data.nextSyncToken;
        requireThat(
          syncToken,
          502,
          "CALENDAR_CURSOR",
          "次回の差分確認情報を取得できませんでした。",
        );
        complete = true;
        break;
      }
    }
    if (full && complete) {
      const missing = await all(
        db,
        "SELECT * FROM calendar_items WHERE connection_id=? AND seen_run<>? AND state<>'cancelled' AND ends_at>? AND starts_at<?",
        [con.id, run, since, until],
      );
      for (const item of missing) {
        await db.query(
          "UPDATE calendar_items SET state='cancelled',version=version+1 WHERE id=?",
          [item.id],
        );
        await applyCalendarItem(rt, con, { ...item, state: "cancelled" });
      }
    }
    await rt.db.query(
      "UPDATE connections SET config=?,last_sync_at=?,last_error=NULL WHERE id=? AND config=?",
      [
        json({
          ...cfg,
          syncToken,
          pageToken: pageToken || null,
          since,
          until,
          lastFullAt: full && complete ? now() : cfg.lastFullAt,
          run: complete ? null : run,
          leaseUntil: null,
          nextSyncAt: nextTick(),
        }),
        now(),
        con.id,
        json(locked),
      ],
    );
    return { changed, complete };
  } catch (e) {
    await rt.db.query(
      "UPDATE connections SET config=?,last_error=?,last_sync_at=? WHERE id=? AND config=?",
      [
        json({ ...cfg, leaseUntil: null, nextSyncAt: nextTick() }),
        e instanceof AppError && e.code.startsWith("GOOGLE_")
          ? e.message
          : "カレンダーの同期に失敗しました。権限・API設定を確認してください。",
        now(),
        con.id,
        json(locked),
      ],
    );
    throw e;
  }
}
export async function pollCalendars(rt: Runtime, t: string, oa: string) {
  const rows = await all(
    rt.db,
    "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service LIKE 'google_calendar:%' AND state='connected' ORDER BY COALESCE(last_sync_at,'') LIMIT 2",
    [t, oa],
  );
  for (const con of rows) {
    try {
      await syncCalendar(rt, con);
    } catch {
      /* Each connection records its own error; keep other sources moving. */
    }
  }
}
export function registerCalendar(app: Hono<AppEnv>) {
  const base = "/api/tenants/:tenantId/accounts/:oaId/connectors/calendar";
  const ctx = async (c: any) => {
    const a = await recordingAccess(c),
      actor = c.get("principal").user.id;
    return {
      ...a,
      actor,
      db: await calendarDB(a.rt, a.tenant, a.oa),
      service: `google_calendar:${actor}`,
    };
  };
  app.get(base, async (c) => {
    const a = await ctx(c),
      con = await one(
        a.rt.db,
        "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",
        [a.tenant, a.oa, a.service],
      ),
      cfg = parse(con?.config);
    const common = await a.rt.openDatabase(a.tenant, "", "common"),
      h = await a.rt.openDatabase(a.tenant, a.oa, "harness");
    const customers = (
      await all(
        common,
        "SELECT c.* FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE l.oa_id=? AND l.state='confirmed'",
        [a.oa],
      )
    ).filter((x) =>
      customerAccess(a.m, x, "edit", parse(c.get("tenant").settings)),
    );
    return c.json({
      connected: con?.state === "connected",
      enabled: !!a.rt.googleOAuth,
      email: cfg.email || "",
      calendarId: cfg.calendarId || "primary",
      lastSync: con?.last_sync_at,
      error: con?.last_error,
      customers: customers.map((x) => ({ id: x.id, name: x.name })),
      appointments: await all(
        h,
        "SELECT id,customer_id,title,starts_at,source FROM appointments WHERE customer_id IN (SELECT value FROM json_each(?)) AND state IN ('booked','rescheduled','attended') ORDER BY starts_at DESC LIMIT 200",
        [json(customers.map((x) => x.id))],
      ),
      items: con
        ? await all(
            a.db,
            "SELECT id,title,starts_at,ends_at,state,version,customer_id,appointment_id FROM calendar_items WHERE connection_id=? AND starts_at>=? ORDER BY starts_at LIMIT 100",
            [con.id, new Date(Date.now() - 7 * 86400000).toISOString()],
          )
        : [],
    });
  });
  app.post(base + "/authorize", async (c) => {
    const a = await ctx(c),
      p = c.get("principal");
    requireThat(
      a.rt.googleOAuth,
      503,
      "GOOGLE_NOT_CONFIGURED",
      "Google連携設定が必要です。",
    );
    await a.rt.db.query(calendarStateDDL);
    const state = `calendar.${id()}`;
    await a.rt.db.query(
      "INSERT INTO calendar_oauth_states VALUES (?,?,?,?,?,?)",
      [
        await digest(state),
        a.tenant,
        a.oa,
        a.actor,
        p.sessionId,
        new Date(Date.now() + 600000).toISOString(),
      ],
    );
    const query = new URLSearchParams({
      client_id: a.rt.googleOAuth!.clientId,
      redirect_uri: `${a.rt.origin}/api/drive/callback`,
      response_type: "code",
      scope: `openid email ${calendarScope}`,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return c.json({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
    });
  });
  // 既存の登録済みredirect URIを再利用し、用途別の一回限りstateで振り分ける。
  app.get("/api/drive/callback", async (c, next) => {
    const state = c.req.query("state") || "";
    if (!state.startsWith("calendar.")) return next();
    const rt = c.env.runtime,
      p = c.get("principal");
    await rt.db.query(calendarStateDDL);
    const s = await one(
      rt.db,
      "SELECT * FROM calendar_oauth_states WHERE id=? AND user_id=? AND session_id=? AND expires_at>?",
      [await digest(state), p.user.id, p.sessionId, now()],
    );
    requireThat(
      s,
      400,
      "OAUTH_STATE",
      "Googleカレンダーの接続を最初からやり直してください。",
    );
    requireThat(
      (
        await rt.db.query("DELETE FROM calendar_oauth_states WHERE id=?", [
          s!.id,
        ])
      ).changes === 1,
      409,
      "OAUTH_USED",
      "この認可は使用済みです。",
    );
    const back = `/sales/connections?tenant=${encodeURIComponent(s!.tenant_id)}&oa=${encodeURIComponent(s!.oa_id)}`;
    if (c.req.query("error")) return c.redirect(back + "&calendar=cancelled");
    await calendarAccess(rt, s!.tenant_id, s!.oa_id, p.user.id);
    requireThat(
      rt.googleOAuth && c.req.query("code"),
      400,
      "OAUTH_CODE",
      "Googleの認可を確認してください。",
    );
    const response = await rt.externalFetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        body: new URLSearchParams({
          code: c.req.query("code")!,
          client_id: rt.googleOAuth!.clientId,
          client_secret: rt.googleOAuth!.clientSecret,
          redirect_uri: `${rt.origin}/api/drive/callback`,
          grant_type: "authorization_code",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    requireThat(
      response.ok,
      502,
      "OAUTH_EXCHANGE",
      "Googleカレンダーの認可を交換できませんでした。",
    );
    const token: any = await response.json();
    requireThat(
      token.refresh_token &&
        String(token.scope).split(" ").includes(calendarScope),
      400,
      "CALENDAR_SCOPE",
      "カレンダーの予定の読み取りを許可してください。",
    );
    const profile = await rt.externalFetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    requireThat(
      profile.ok,
      502,
      "GOOGLE_PROFILE",
      "Googleアカウントを確認できません。",
    );
    const user: any = await profile.json();
    requireThat(
      user.email_verified && typeof user.email === "string",
      400,
      "GOOGLE_EMAIL",
      "確認済みGoogleアカウントが必要です。",
    );
    const service = `google_calendar:${p.user.id}`,
      old = await one(
        rt.db,
        "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",
        [s!.tenant_id, s!.oa_id, service],
      );
    requireThat(
      !old || parse(old.config).email === user.email,
      409,
      "CALENDAR_ACCOUNT_CHANGED",
      "同じGoogleアカウントで再接続してください。",
    );
    await putCredential(
      rt,
      s!.tenant_id,
      s!.oa_id,
      service,
      { refreshToken: token.refresh_token },
      p.user.id,
    );
    await rt.db.query(
      "INSERT INTO connections(id,tenant_id,oa_id,service,state,config) VALUES (?,?,?,?,'connected',?) ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET state='connected',config=excluded.config,last_error=NULL",
      [
        old?.id || id(),
        s!.tenant_id,
        s!.oa_id,
        service,
        json({
          ...parse(old?.config),
          actor: p.user.id,
          email: user.email,
          calendarId: parse(old?.config).calendarId || "primary",
          leaseUntil: null,
          nextSyncAt: "",
        }),
      ],
    );
    return c.redirect(back + "&calendar=connected");
  });
  app.post(base + "/items/:id/link", async (c) => {
    const a = await ctx(c),
      b = z
        .object({
          version: z.number().int(),
          customerId: z.string(),
          appointmentId: z.string().optional(),
        })
        .strict()
        .parse(await c.req.json());
    const con = await one(
        a.rt.db,
        "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=? AND state='connected'",
        [a.tenant, a.oa, a.service],
      ),
      item = con
        ? await one(
            a.db,
            "SELECT * FROM calendar_items WHERE id=? AND connection_id=?",
            [c.req.param("id"), con.id],
          )
        : null;
    requireThat(
      item && item.state !== "cancelled" && item.version === b.version,
      409,
      "CALENDAR_CHANGED",
      "予定が更新されています。",
    );
    const common = await a.rt.openDatabase(a.tenant, "", "common"),
      customer = await one(
        common,
        "SELECT c.* FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE l.oa_id=? AND c.id=? AND l.state='confirmed'",
        [a.oa, b.customerId],
      );
    requireThat(
      customer &&
        customerAccess(a.m, customer, "edit", parse(c.get("tenant").settings)),
      403,
      "CUSTOMER_FORBIDDEN",
      "このお客様に紐付ける権限がありません。",
    );
    requireThat(
      !item!.customer_id || item!.customer_id === b.customerId,
      409,
      "CALENDAR_ASSIGNED",
      "すでに紐付いたお客様を確認してください。",
    );
    const h = await a.rt.openDatabase(a.tenant, a.oa, "harness");
    const mirror = b.appointmentId
      ? await one(
          h,
          "SELECT * FROM appointments WHERE id=? AND customer_id=?",
          [b.appointmentId, b.customerId],
        )
      : null;
    requireThat(
      !b.appointmentId ||
        (mirror &&
          (!item!.appointment_id || item!.appointment_id === mirror.id)),
      409,
      "MEETING_MISMATCH",
      "同じお客様の予約を指定してください。",
    );
    const aid = mirror?.id || item!.appointment_id || id();
    requireThat(
      (
        await a.db.query(
          "UPDATE calendar_items SET customer_id=?,appointment_id=?,version=version+1 WHERE id=? AND version=?",
          [b.customerId, aid, item!.id, b.version],
        )
      ).changes === 1,
      409,
      "CALENDAR_CHANGED",
      "予定が更新されています。",
    );
    await applyCalendarItem(a.rt, con!, {
      ...item,
      customer_id: b.customerId,
      appointment_id: aid,
    });
    return c.json({ ok: true });
  });
}
