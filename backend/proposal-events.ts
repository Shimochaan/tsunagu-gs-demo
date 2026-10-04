import { staffNotificationDelay, claimStaffDaily, claimStaffCustomer } from "./assistant-notifications.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, now, id, json, parse, type Row } from "./db.ts";
import { member } from "./access.ts";
import { assistantAccess, assistantGuard } from "./assistant.ts";
import { requireThat } from "./security.ts";
export type StaffPushEvent = { id:string; tenantId:string; userId:string; proposalId:string; priority:number; expiresAt:string; url:string };
export interface StaffPushAdapter {
  /** An authenticated installation registry must resolve userId; event.id is the stable delivery idempotency key. Never a customer LINE destination. */
  deliver(event:StaffPushEvent):Promise<"accepted"|"rejected"|"unknown">;
}
export const proposalEventDDL = [
  `CREATE TABLE IF NOT EXISTS staff_notification_customer_slots (tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,event_key TEXT NOT NULL,claimed_at TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id,customer_id))`,
  `CREATE TABLE IF NOT EXISTS staff_notification_claims (event_key TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,day TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS staff_notification_claim_day ON staff_notification_claims(tenant_id,user_id,day)`,
  `CREATE TABLE IF NOT EXISTS staff_proposal_events (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,oa_id TEXT NOT NULL,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,proposal_id TEXT NOT NULL,version INTEGER NOT NULL,priority INTEGER NOT NULL,reason TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'unread',feedback TEXT,created_at TEXT NOT NULL,read_at TEXT,push_state TEXT NOT NULL DEFAULT 'unconnected',UNIQUE(tenant_id,oa_id,user_id,proposal_id,version))`,
  `CREATE INDEX IF NOT EXISTS staff_proposal_user ON staff_proposal_events(tenant_id,user_id,state,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS staff_proposal_due ON staff_proposal_events(tenant_id,oa_id,push_state,expires_at)`,
];
export async function publishProposalEvent(rt:Runtime,tenant:string,oa:string,p:Row) {
  const ev=parse(p.evidence);
  await rt.db.query("INSERT OR IGNORE INTO staff_proposal_events(id,tenant_id,oa_id,user_id,customer_id,proposal_id,version,priority,reason,expires_at,created_at,push_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[id(),tenant,oa,p.owner_user_id,p.customer_id,p.id,p.version,ev.priority || (p.kind==="reply" ? 10 : 30),p.reason,p.expires_at,now(),rt.staffPush ? "pending" : "unconnected"]);
}
async function liveEvent(rt:Runtime,e:Row) {
  try {
    const ts=await rt.openDatabase(e.tenant_id,e.oa_id,"tsunagu"),p=await one(ts,"SELECT p.*,a.evidence FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.id=?",[e.proposal_id]);
    if(!p || p.version!==e.version || p.state!=="pending" || e.expires_at<=now()) return null;
    await assistantAccess(rt,e.tenant_id,e.oa_id,e.user_id,p.customer_id,"read");
    if(await assistantGuard(rt,e.tenant_id,e.oa_id,p)) return null;
    return p;
  } catch {return null;}
}
// Future iOS adapter boundary. No APNs client or device credential is installed by this change.
export async function deliverStaffPush(rt:Runtime,eventId:string) {
  if(!rt.staffPush) return {state:"unconnected"};
  const e=await one(rt.db,"SELECT * FROM staff_proposal_events WHERE id=?",[eventId]);
  if(!e || e.state!=="unread" || !["pending","unconnected"].includes(e.push_state)) return {state:e?.push_state || "missing"};
  const current=await liveEvent(rt,e);
  if(!current) {
    await rt.db.query("UPDATE staff_proposal_events SET state='invalid',push_state='cancelled' WHERE id=?",[e.id]);
    return {state:"cancelled"};
  }
  const immediateEvent=e.priority<=10 || !!parse(current.evidence).sourceContentHash;
  const delay=await staffNotificationDelay(rt,e.tenant_id,e.user_id,e.customer_id,immediateEvent,e.id);
  if(delay) return {state:"deferred",nextAt:delay};
  if(!(await claimStaffDaily(rt,e.tenant_id,e.user_id,e.id))) return {state:"deferred"};
  if(!(await claimStaffCustomer(rt,e.tenant_id,e.user_id,e.customer_id,e.id,immediateEvent))) return {state:"deferred"};
  const claimed=await rt.db.query("UPDATE staff_proposal_events SET push_state='sending' WHERE id=? AND state='unread' AND push_state IN ('pending','unconnected')",[e.id]);
  if(!claimed.changes) return {state:"claimed"};
  const latest=await one(rt.db,"SELECT * FROM staff_proposal_events WHERE id=?",[e.id]);
  if(latest?.state!=="unread" || !(await liveEvent(rt,e))) {await rt.db.query("UPDATE staff_proposal_events SET push_state='cancelled' WHERE id=?",[e.id]);return {state:"cancelled"};}
  let state="unknown";
  try { state=await rt.staffPush.deliver({id:e.id,tenantId:e.tenant_id,userId:e.user_id,proposalId:e.proposal_id,priority:e.priority,expiresAt:e.expires_at,url:`${rt.origin}/sales?tenant=${encodeURIComponent(e.tenant_id)}&oa=${encodeURIComponent(e.oa_id)}&assistant=${encodeURIComponent(e.proposal_id)}`}); } catch {}
  await rt.db.query("UPDATE staff_proposal_events SET push_state=? WHERE id=? AND push_state='sending'",[state,e.id]);
  return {state};
}
export function registerProposalEvents(app:Hono<AppEnv>) {
  const base="/api/tenants/:tenantId/proposal-events";
  app.get(base,async c=>{
    const rt=c.env.runtime,t=c.req.param("tenantId")!,actor=c.get("principal").user.id;
    await member(rt,actor,t);
    const rows=await all(rt.db,"SELECT * FROM staff_proposal_events WHERE tenant_id=? AND user_id=? AND state IN ('unread','read') ORDER BY priority,created_at DESC LIMIT 30",[t,actor]);
    const events=[];
    for(const e of rows) {
      if(await liveEvent(rt,e)) events.push(e);
      else await rt.db.query("UPDATE staff_proposal_events SET state='invalid' WHERE id=? AND state IN ('unread','read')",[e.id]);
    }
    const measurements=await all(rt.db,"SELECT feedback,COUNT(*) AS count FROM staff_proposal_events WHERE tenant_id=? AND user_id=? AND feedback IS NOT NULL GROUP BY feedback",[t,actor]);
    return c.json({events,measurements,pushConfigured:!!rt.staffPush,timingMode:"rules",detail:"返信・約束・確認済み条件の変化をルールで判断します。最適時機の学習は未実装です。"});
  });
  app.post(base+"/:id",async c=>{
    const rt=c.env.runtime,t=c.req.param("tenantId")!,actor=c.get("principal").user.id;
    await member(rt,actor,t);
    const b=z.object({action:z.enum(["read","dismiss","useful","too_early","irrelevant"])}).strict().parse(await c.req.json());
    const e=await one(rt.db,"SELECT * FROM staff_proposal_events WHERE id=? AND tenant_id=? AND user_id=?",[c.req.param("id")!,t,actor]);
    requireThat(e && await liveEvent(rt,e),404,"EVENT_NOT_FOUND","有効な通知が見つかりません。");
    await rt.db.query("UPDATE staff_proposal_events SET state=?,read_at=COALESCE(read_at,?),feedback=COALESCE(?,feedback) WHERE id=?",[b.action==="dismiss" ? "dismissed" : "read",now(),["useful","too_early","irrelevant"].includes(b.action) ? b.action : null,e!.id]);
    return c.json({ok:true});
  });
}
