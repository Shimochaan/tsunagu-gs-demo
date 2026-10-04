import { demoParticipant } from "./self-demo-access.ts";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { all, one, now, id, json, parse, type Row } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { assistantAccess, assistantGuard } from "./assistant.ts";
import { assistantCard, staffLineReady } from "./assistant-line.ts";

export const notificationPreferencesSchema = z
  .object({
    quietHours: z.boolean().default(true),
    maxDaily: z.number().int().min(1).max(30).default(12),
    customerCooldownHours: z.number().int().min(1).max(72).default(24),
    startHour: z.number().int().min(0).max(23).default(8),
    endHour: z.number().int().min(0).max(23).default(21),
  })
  .strict()
  .refine(
    (s) => !s.quietHours || s.startHour !== s.endHour,
    "受信開始時刻と終了時刻を分けてください。",
  );
export async function notificationPreferences(
  rt: Runtime,
  tenant: string,
  user: string,
) {
  const p = await one(
    rt.db,
    "SELECT data FROM staff_line_preferences WHERE tenant_id=? AND user_id=?",
    [tenant, user],
  );
  const {notificationWindowOverride:override,...raw}=p ? parse(p.data) : {};
  const settings=notificationPreferencesSchema.parse(raw);
  const demo=await demoParticipant(rt,user);
  if(demo?.state==="active" && demo.notifications_until>now()) return {...settings,quietHours:false,customerCooldownHours:0,maxDaily:20};
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  if(override?.day===today && Number.isInteger(override.endHour) && override.endHour>=0 && override.endHour<=23 && override.endHour!==settings.startHour) settings.endHour=override.endHour;
  return settings;
}
export function withinNotificationWindow(
  p: z.infer<typeof notificationPreferencesSchema>,
) {
  if (!p.quietHours) return true;
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Tokyo",
    }).format(new Date()),
  );
  return p.startHour < p.endHour
    ? hour >= p.startHour && hour < p.endHour
    : hour >= p.startHour || hour < p.endHour;
}
export async function staffNotificationDelay(rt:Runtime,tenant:string,user:string,cid:string,reply=false,eventKey="") {
  const pref=await notificationPreferences(rt,tenant,user);
  if (!withinNotificationWindow(pref)) {
    let next=Date.now();
    for(let i=0;i<25;i++){next=(Math.floor(next/3600000)+1)*3600000;if((new Date(next).getUTCHours()+9)%24===pref.startHour) break;}
    return new Date(next).toISOString();
  }
  const dayStart=new Date(Date.now()+9*3600000).toISOString().slice(0,10)+"T00:00:00+09:00";
  const total=await one(rt.db,"SELECT COUNT(*) AS n FROM staff_notification_claims WHERE tenant_id=? AND user_id=? AND day=? AND event_key<>?",[tenant,user,dayStart.slice(0,10),eventKey]);
  if(total!.n>=pref.maxDaily) return new Date(Date.parse(dayStart)+86400000+pref.startHour*3600000).toISOString();
  if(reply) return null;
  const last=await one(rt.db,"SELECT MAX(d.last_attempt_at) AS at FROM staff_line_notices n JOIN staff_line_deliveries d ON d.notice_id=n.id JOIN staff_proposal_events e ON e.tenant_id=n.tenant_id AND e.oa_id=n.oa_id AND e.user_id=n.user_id AND e.proposal_id=n.proposal_id AND e.version=n.version WHERE n.tenant_id=? AND n.user_id=? AND e.customer_id=? AND n.state IN ('sent','uncertain','sending')",[tenant,user,cid]);
  const slot=await one(rt.db,"SELECT claimed_at FROM staff_notification_customer_slots WHERE tenant_id=? AND user_id=? AND customer_id=? AND event_key<>?",[tenant,user,cid,eventKey]);
  const until=Math.max(last?.at ? Date.parse(last.at)+pref.customerCooldownHours*3600000 : 0,slot?.claimed_at ? Date.parse(slot.claimed_at)+pref.customerCooldownHours*3600000 : 0);
  return until>Date.now() ? new Date(until).toISOString() : null;
}
export async function claimStaffDaily(rt:Runtime,tenant:string,user:string,key:string) {
  const pref=await notificationPreferences(rt,tenant,user),day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  if(await one(rt.db,"SELECT event_key FROM staff_notification_claims WHERE event_key=? AND tenant_id=? AND user_id=?",[key,tenant,user])) return true;
  const r=await rt.db.query("INSERT OR IGNORE INTO staff_notification_claims(event_key,tenant_id,user_id,day) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM staff_notification_claims WHERE tenant_id=? AND user_id=? AND day=?)<?",[key,tenant,user,day,tenant,user,day,pref.maxDaily]);
  return !!r.changes;
}
// Reserve one non-reply opportunity per customer across channels. Ambiguous attempts keep the slot.
export async function claimStaffCustomer(rt:Runtime,tenant:string,user:string,cid:string,key:string,reply=false) {
  if(reply) return true;
  const pref=await notificationPreferences(rt,tenant,user),at=now(),before=new Date(Date.now()-pref.customerCooldownHours*3600000).toISOString();
  const r=await rt.db.query("INSERT INTO staff_notification_customer_slots(tenant_id,user_id,customer_id,event_key,claimed_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,user_id,customer_id) DO UPDATE SET event_key=excluded.event_key,claimed_at=CASE WHEN event_key=excluded.event_key THEN claimed_at ELSE excluded.claimed_at END WHERE claimed_at<=? OR event_key=excluded.event_key",[tenant,user,cid,key,at,before]);
  return !!r.changes;
}
async function minuteSlot(rt: Runtime, n: Row, lane: string) {
  const claim = await rt.db.query(
    "INSERT INTO staff_line_minute_slots(tenant_id,user_id,lane,slot,used) VALUES (?,?,?,?,1) ON CONFLICT(tenant_id,user_id,lane,slot) DO UPDATE SET used=used+1 WHERE used<3 RETURNING used",
    [n.tenant_id, n.user_id, lane, Math.floor(Date.now() / 60000)],
  );
  return !!claim.rows.length;
}
// 配送直前にも本人・本文・宛先・期限を確認。顧客outboxとは別の担当者向けキュー。
async function deliverNotice(rt: Runtime, n: Row) {
  const ts = await rt.openDatabase(n.tenant_id, n.oa_id, "tsunagu"),
    d = await one(
      rt.db,
      "SELECT * FROM staff_line_deliveries WHERE notice_id=?",
      [n.id],
    );
  if (!d || !(await staffLineReady(rt))) return 0;
  const binding = await one(
    rt.db,
    "SELECT * FROM staff_line_links WHERE tenant_id=? AND user_id=? AND state='active' AND notifications=1 AND destination=? AND line_user_id=?",
    [n.tenant_id, n.user_id, n.destination, n.line_user_id],
  );
  const p = await one(
    ts,
    "SELECT p.*,a.evidence,a.expires_at,a.snoozed_until FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?",
    [n.proposal_id],
  );
  let valid =
    !!binding &&
    n.destination === rt.assistantLine?.destination &&
    p?.version === n.version &&
    p?.state === "pending" &&
    (await digest(p.draft)) === n.draft_hash;
  if (valid)
    try {
      await assistantAccess(
        rt,
        n.tenant_id,
        n.oa_id,
        n.user_id,
        p!.customer_id,
        "send",
      );
      valid = !(await assistantGuard(rt, n.tenant_id, n.oa_id, p!));
    } catch {
      valid = false;
    }
  if (!valid) {
    await rt.db.query(
      "UPDATE staff_line_notices SET state='cancelled' WHERE id=? AND state='queued'",
      [n.id],
    );
    return 0;
  }
  const event=await one(rt.db,"SELECT state FROM staff_proposal_events WHERE tenant_id=? AND oa_id=? AND user_id=? AND proposal_id=? AND version=?",[n.tenant_id,n.oa_id,n.user_id,n.proposal_id,n.version]);
  if(event && event.state!=="unread") {await rt.db.query("UPDATE staff_line_notices SET state='cancelled' WHERE id=? AND state='queued'",[n.id]);return 0;}
  // A distinct source update is a new staff event, even while customer contact is cooling down.
  const immediateEvent = d.lane === "reply" || !!parse(p!.evidence).sourceContentHash;
  const delay=await staffNotificationDelay(rt,n.tenant_id,n.user_id,p!.customer_id,immediateEvent,n.id);
  if(delay) {await rt.db.query("INSERT INTO staff_line_delivery_schedule(notice_id,next_at) VALUES (?,?) ON CONFLICT(notice_id) DO UPDATE SET next_at=excluded.next_at",[n.id,delay]);return 0;}
  if (p!.snoozed_until && p!.snoozed_until > now()) return 0;
  if (
    !withinNotificationWindow(
      await notificationPreferences(rt, n.tenant_id, n.user_id),
    )
  )
    return 0;
  if (
    await one(
      ts,
      "SELECT id FROM assistant_runs WHERE proposal_id=? AND kind='draft' AND state='running' AND version IN (?,?)",
      [p!.id, p!.version, p!.version - 1],
    )
  )
    return 0;
  if (
    d.attempts >= 3 ||
    (d.first_attempt_at &&
      Date.now() - Date.parse(d.first_attempt_at) >= 23 * 3600000)
  ) {
    await rt.db.query(
      "UPDATE staff_line_notices SET state='failed' WHERE id=? AND state='queued'",
      [n.id],
    );
    await rt.db.query(
      "UPDATE staff_line_deliveries SET error_code='RETRY_LIMIT' WHERE notice_id=?",
      [n.id],
    );
    return 0;
  }
  if (!(await minuteSlot(rt, n, d.lane))) return 0;
  if (!(await claimStaffDaily(rt,n.tenant_id,n.user_id,n.id))) return 0;
  if (!(await claimStaffCustomer(rt,n.tenant_id,n.user_id,p!.customer_id,n.id,immediateEvent))) return 0;
  const claim = await rt.db.query(
    "UPDATE staff_line_notices SET state='sending' WHERE id=? AND state='queued' RETURNING id",
    [n.id],
  );
  if (!claim.rows.length) return 0;
  await rt.db.query(
    "UPDATE staff_line_deliveries SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),last_attempt_at=?,error_code=NULL WHERE notice_id=?",
    [now(), now(), n.id],
  );
  const latest = await one(
    ts,
    "SELECT p.*,a.snoozed_until FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?",
    [n.proposal_id],
  );
  const stillLinked = await one(
    rt.db,
    "SELECT user_id FROM staff_line_links WHERE tenant_id=? AND user_id=? AND state='active' AND notifications=1 AND destination=? AND line_user_id=?",
    [n.tenant_id, n.user_id, n.destination, n.line_user_id],
  );
  let stillValid =
    !!stillLinked &&
    latest?.state === "pending" &&
    latest?.version === n.version &&
    (await digest(latest.draft)) === n.draft_hash &&
    (!latest.snoozed_until || latest.snoozed_until <= now());
  if (stillValid)
    try {
      await assistantAccess(
        rt,
        n.tenant_id,
        n.oa_id,
        n.user_id,
        latest!.customer_id,
        "send",
      );
      stillValid = !(await assistantGuard(rt, n.tenant_id, n.oa_id, latest!));
    } catch {
      stillValid = false;
    }
  if (!stillValid) {
    await rt.db.query(
      "UPDATE staff_line_notices SET state='cancelled' WHERE id=? AND state='sending'",
      [n.id],
    );
    return 0;
  }
  if (
    !withinNotificationWindow(
      await notificationPreferences(rt, n.tenant_id, n.user_id),
    )
  ) {
    await rt.db.query(
      "UPDATE staff_line_notices SET state='queued' WHERE id=? AND state='sending'",
      [n.id],
    );
    await rt.db.query(
      "UPDATE staff_line_deliveries SET attempts=attempts-1,first_attempt_at=CASE WHEN attempts=1 THEN NULL ELSE first_attempt_at END WHERE notice_id=?",
      [n.id],
    );
    return 0;
  }
  let state = "uncertain",
    code = "NETWORK_UNKNOWN";
  try {
    const r = await rt.externalFetch(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rt.assistantLine!.token}`,
          "Content-Type": "application/json",
          "X-Line-Retry-Key": n.id,
        },
        body: d.body,
        signal: AbortSignal.timeout(15000),
      },
    );
    if (
      r.ok ||
      (r.status === 409 && r.headers.get("x-line-accepted-request-id"))
    ) {
      state = "sent";
      code = "";
    } else if (r.status >= 400 && r.status < 500 && r.status !== 409) {
      state = "failed";
      code = `HTTP_${r.status}`;
    } else code = `HTTP_${r.status}_UNKNOWN`;
  } catch {}
  await rt.db.query(
    "UPDATE staff_line_notices SET state=? WHERE id=? AND state='sending'",
    [state, n.id],
  );
  await rt.db.query(
    "UPDATE staff_line_deliveries SET error_code=? WHERE notice_id=?",
    [code || null, n.id],
  );
  return state === "sent" ? 1 : 0;
}

export async function notifyAssistant(
  rt: Runtime,
  tenant: string,
  oa: string,
  onlyActor?: string,
) {
  if (!(await staffLineReady(rt))) return { sent: 0 };
  const ts = await rt.openDatabase(tenant, oa, "tsunagu");
  if (
    !(
      await one(ts, "SELECT enabled FROM assistant_settings WHERE id='default'")
    )?.enabled
  )
    return { sent: 0 };
  // Recovery is driven by the OA's sending index, not a scan of every tenant's history.
  await rt.db.query(
    "UPDATE staff_line_notices SET state='uncertain' WHERE tenant_id=? AND oa_id=? AND state='sending' AND EXISTS(SELECT 1 FROM staff_line_deliveries d WHERE d.notice_id=staff_line_notices.id AND d.last_attempt_at<?)",
    [tenant, oa, new Date(Date.now() - 120000).toISOString()],
  );
  const links = await all(
    rt.db,
    `SELECT l.* FROM staff_line_links l JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id JOIN accounts a ON a.tenant_id=l.tenant_id AND a.id=? JOIN tenants t ON t.id=l.tenant_id WHERE l.tenant_id=? AND l.destination=? AND l.state='active' AND l.notifications=1 AND m.state='active' AND t.state='active' AND (a.owner_user_id=l.user_id OR EXISTS(SELECT 1 FROM json_each(a.operators) WHERE value=l.user_id) OR (json_extract(t.settings,'$.proxySend')=1 AND EXISTS(SELECT 1 FROM json_each(m.roles) WHERE value='org_owner')))`,
    [oa, tenant, rt.assistantLine!.destination],
  );
  const active = [];
  for(const l of links) {
    if(onlyActor && onlyActor!==l.user_id) continue;
    const demo=await demoParticipant(rt,l.user_id);
    if(demo && (demo.state!=="active" || !demo.notifications_until || demo.notifications_until<=now())) continue;
    active.push(l);
  }
  const byUser = new Map(active.map((l) => [l.user_id, l]));
  if (active.length) {
    const rows = await all(
      ts,
      "SELECT p.*,a.evidence,a.expires_at,a.kind,a.owner_user_id,a.snoozed_until FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE a.owner_user_id IN (SELECT value FROM json_each(?)) AND p.state='pending' AND a.expires_at>? AND (a.snoozed_until IS NULL OR a.snoozed_until<=?) AND NOT EXISTS(SELECT 1 FROM assistant_notice_receipts r WHERE r.proposal_id=p.id AND r.version=p.version AND r.user_id=a.owner_user_id) ORDER BY COALESCE(json_extract(a.evidence,'$.priority'),CASE WHEN a.kind='reply' THEN 10 ELSE 30 END),p.created_at,p.id LIMIT 100",
      [json(active.map((l) => l.user_id)), now(), now()],
    );
    for (const p of rows) {
      const link = byUser.get(p.owner_user_id)!;
      if (
        await one(
          ts,
          "SELECT id FROM assistant_runs WHERE proposal_id=? AND kind='draft' AND state='running' AND version IN (?,?)",
          [p.id, p.version, p.version - 1],
        )
      )
        continue;
      let access;
      try {
        access = await assistantAccess(
          rt,
          tenant,
          oa,
          link.user_id,
          p.customer_id,
          "send",
        );
      } catch {
        continue;
      }
      const existing = await one(
        rt.db,
        "SELECT * FROM staff_line_notices WHERE tenant_id=? AND oa_id=? AND proposal_id=? AND version=? AND user_id=?",
        [tenant, oa, p.id, p.version, link.user_id],
      );
      if (!existing || existing.state === "editing") {
        const notice = { id: existing?.id || id(), tenant_id: tenant };
        const body = json({
          to: link.line_user_id,
          messages: [assistantCard(rt, notice, p, access.customer!, access.oa)],
        });
        await rt.db.batch([
          {
            sql: "INSERT INTO staff_line_notices(id,tenant_id,oa_id,user_id,destination,line_user_id,proposal_id,version,draft_hash,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,'queued',?) ON CONFLICT(tenant_id,oa_id,proposal_id,version,user_id) DO UPDATE SET state='queued' WHERE state='editing'",
            params: [
              notice.id,
              tenant,
              oa,
              link.user_id,
              link.destination,
              link.line_user_id,
              p.id,
              p.version,
              await digest(p.draft),
              now(),
            ],
          },
          {
            sql: "INSERT OR IGNORE INTO staff_line_deliveries(notice_id,lane,body) SELECT id,?,? FROM staff_line_notices WHERE id=? AND state='queued'",
            params: [
              p.kind === "reply" ? "reply" : "opportunity",
              body,
              notice.id,
            ],
          },
        ]);
      }
      await ts.query(
        "INSERT OR IGNORE INTO assistant_notice_receipts(proposal_id,version,user_id) VALUES (?,?,?)",
        [p.id, p.version, link.user_id],
      );
    }
  }
  let sent = 0,
    attempted = 0;
  const deadline = Date.now() + 10000;
  const prefs = new Map<
    string,
    Awaited<ReturnType<typeof notificationPreferences>>
  >();
  const slots = new Map<string, number>();
  for (const r of await all(
    rt.db,
    "SELECT user_id,lane,used FROM staff_line_minute_slots WHERE tenant_id=? AND slot=?",
    [tenant, Math.floor(Date.now() / 60000)],
  ))
    slots.set(`${r.user_id}:${r.lane}`, r.used);
  // Independent lane quotas preserve reply priority without starving older news/product work.
  for (const lane of ["reply", "opportunity"]) {
    const queue = await all(
      rt.db,
      "SELECT n.*,d.lane FROM staff_line_notices n JOIN staff_line_deliveries d ON d.notice_id=n.id LEFT JOIN staff_line_delivery_schedule s ON s.notice_id=n.id WHERE n.tenant_id=? AND n.oa_id=? AND n.state='queued' AND d.lane=? AND COALESCE(s.next_at,'')<=?" +
        (onlyActor ? " AND n.user_id=?" : "") +
        " ORDER BY n.created_at,n.id LIMIT 30",
      [tenant, oa, lane, now(), ...(onlyActor ? [onlyActor] : [])],
    );
    let laneAttempts = 0;
    for (const n of queue) {
      if (laneAttempts >= 10 || attempted >= 20 || Date.now() > deadline) break;
      const key = `${n.user_id}:${lane}`;
      if ((slots.get(key) || 0) >= 3) continue;
      let pref = prefs.get(n.user_id);
      if (!pref) {
        pref = await notificationPreferences(rt, tenant, n.user_id);
        prefs.set(n.user_id, pref);
      }
      if (!withinNotificationWindow(pref)) {
        let next = Date.now();
        for (let h = 0; h < 25; h++) {
          next = (Math.floor(next / 3600000) + 1) * 3600000;
          const hour = (new Date(next).getUTCHours() + 9) % 24;
          if (hour === pref.startHour) break;
        }
        await rt.db.query(
          "INSERT INTO staff_line_delivery_schedule(notice_id,next_at) VALUES (?,?) ON CONFLICT(notice_id) DO UPDATE SET next_at=excluded.next_at",
          [n.id, new Date(next).toISOString()],
        );
        continue;
      }
      sent += await deliverNotice(rt, n);
      slots.set(key, (slots.get(key) || 0) + 1);
      attempted++;
      laneAttempts++;
    }
  }
  return { sent };
}

export async function retryAssistantNotice(
  rt: Runtime,
  tenant: string,
  user: string,
  noticeId: string,
) {
  const n = await one(
    rt.db,
    "SELECT n.*,d.attempts,d.first_attempt_at FROM staff_line_notices n JOIN staff_line_deliveries d ON d.notice_id=n.id WHERE n.id=? AND n.tenant_id=? AND n.user_id=?",
    [noticeId, tenant, user],
  );
  requireThat(n, 404, "NOTICE_NOT_FOUND", "通知が見つかりません。");
  await assistantAccess(rt, tenant, n.oa_id, user);
  requireThat(
    ["failed", "uncertain"].includes(n.state) &&
      n.attempts < 3 &&
      (!n.first_attempt_at ||
        Date.now() - Date.parse(n.first_attempt_at) < 23 * 3600000),
    409,
    "CANNOT_RETRY",
    "結果または再試行期限を確認してください。別のキーでは再送しません。",
  );
  await rt.db.query(
    "UPDATE staff_line_notices SET state='queued' WHERE id=? AND state IN ('failed','uncertain')",
    [noticeId],
  );
  await rt.db.query(
    "DELETE FROM staff_line_delivery_schedule WHERE notice_id=?",
    [noticeId],
  );
  await notifyAssistant(rt, tenant, n.oa_id, user);
  return {
    state: (
      await one(rt.db, "SELECT state FROM staff_line_notices WHERE id=?", [
        noticeId,
      ])
    )?.state,
  };
}
