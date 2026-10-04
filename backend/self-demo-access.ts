import type { Runtime } from "./runtime.ts";
import { one, now, parse } from "./db.ts";
import { digest } from "./security.ts";

export const selfDemoDDL = [
  `CREATE TABLE IF NOT EXISTS gs_demo_participants (user_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,guest_only INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'active',customer_id TEXT NOT NULL UNIQUE,customer_line_id TEXT UNIQUE,friend_id TEXT,booking_hash TEXT UNIQUE,notifications_until TEXT,pair_hash TEXT,pair_expires_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gs_demo_documents (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,held_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'unlinked',analysis TEXT,error TEXT,lease_until TEXT,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gs_demo_actions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'claimed',payload TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS gs_demo_actions_user ON gs_demo_actions(user_id,kind,day)`,
  `CREATE TABLE IF NOT EXISTS gs_demo_bookings (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,starts_at TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,notice_state TEXT NOT NULL DEFAULT 'pending',source TEXT NOT NULL DEFAULT 'self_demo',external_id TEXT UNIQUE,details_url TEXT,retry_key TEXT NOT NULL,updated_at TEXT NOT NULL)`,
];
export async function demoParticipant(rt: Runtime, actor: string) {
  return rt.selfDemo
    ? one(
        rt.db,
        "SELECT * FROM gs_demo_participants WHERE user_id=? AND tenant_id=?",
        [actor, rt.selfDemo.tenant],
      )
    : null;
}
export async function isDemoCustomer(rt: Runtime, customer: string) {
  return !!(rt.selfDemo && await one(rt.db,
    "SELECT 1 FROM gs_demo_participants WHERE tenant_id=? AND customer_id=? AND state='active' AND customer_line_id IS NOT NULL AND pair_hash IS NULL",
    [rt.selfDemo.tenant, customer]));
}
export async function demoCustomerAllowed(
  rt: Runtime,
  line: string,
  actor?: string,
  customer?: string,
) {
  if (!rt.selfDemo || !actor || !customer) return false;
  return !!(await one(
    rt.db,
    "SELECT 1 FROM gs_demo_participants p JOIN memberships m ON m.user_id=p.user_id AND m.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id WHERE p.tenant_id=? AND p.user_id=? AND p.customer_id=? AND p.customer_line_id=? AND p.pair_hash IS NULL AND p.state='active' AND m.state='active' AND t.state='active'",
    [rt.selfDemo.tenant, actor, customer, line],
  ));
}
export async function demoStaffAllowed(
  rt: Runtime,
  line: string,
  pairText?: string,
  confirming = false,
) {
  if (!rt.selfDemo) return false;
  if (pairText?.match(/^連携\s+[0-9a-f]{64}$/)) {
    const hash = await digest(pairText.trim().split(/\s+/)[1]);
    return !!(await one(
      rt.db,
      `SELECT 1 FROM staff_line_links l JOIN gs_demo_participants p ON p.user_id=l.user_id AND p.tenant_id=l.tenant_id WHERE l.tenant_id=? AND l.destination=? AND l.pair_hash=? AND l.state='pending' AND l.pair_expires_at>? AND p.state='active'`,
      [rt.selfDemo.tenant, rt.assistantLine?.destination || "", hash, now()],
    ));
  }
  return !!(await one(
    rt.db,
    `SELECT 1 FROM staff_line_links l JOIN gs_demo_participants p ON p.user_id=l.user_id AND p.tenant_id=l.tenant_id WHERE l.tenant_id=? AND l.destination=? AND l.line_user_id=? AND l.state IN (${confirming ? "'active','confirming'" : "'active'"}) AND p.state='active'`,
    [rt.selfDemo.tenant, rt.assistantLine?.destination || "", line],
  ));
}
// Demo-only membership cannot escape the guided API into shared tenant records.
export async function isDemoGuest(rt: Runtime, actor: string) {
  const row = await demoParticipant(rt, actor);
  if (row) return !!row.guest_only;
  if (!rt.selfDemo) return false;
  const member = await one(
    rt.db,
    "SELECT roles FROM memberships WHERE tenant_id=? AND user_id=? AND state='active'",
    [rt.selfDemo.tenant, actor],
  );
  return !member || parse(member.roles, []).includes("demo");
}

export async function claimDemoAI(rt: Runtime, actor: string) {
  const p = await demoParticipant(rt, actor);
  if (!p || p.state !== "active") return false;
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const claim = await rt.db.query(
    "INSERT INTO gs_demo_actions(id,user_id,kind,day,created_at) SELECT ?,?,'ai',?,? WHERE (SELECT COUNT(*) FROM gs_demo_actions WHERE user_id=? AND kind='ai' AND day=?)<12 AND (SELECT COUNT(*) FROM gs_demo_actions WHERE kind='ai' AND day=?)<120",
    [crypto.randomUUID(), actor, day, now(), actor, day, day],
  );
  return !!claim.changes;
}
export async function demoBookingToken(rt: Runtime, customer: string) {
  return (await digest(rt.key + ":self-demo-booking:" + customer))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function demoBookingUrl(rt: Runtime, customer: string) {
  return rt.origin + "/demo/book/" + (await demoBookingToken(rt, customer));
}
export async function demoBookingConfigured(rt: Runtime) {
  if (!rt.selfDemo?.timerexUrl) return true;
  return !!(rt.timerexSecrets?.[rt.selfDemo.oa] || await one(rt.db,
    "SELECT 1 FROM credentials WHERE tenant_id=? AND oa_id=? AND service='timerex' AND ciphertext IS NOT NULL",
    [rt.selfDemo.tenant, rt.selfDemo.oa]));
}
