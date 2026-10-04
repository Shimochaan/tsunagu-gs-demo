import { all, one, parse, type Row } from "./db.ts";
import { requireThat } from "./security.ts";
import type { Context } from "hono";
import type { AppEnv, Principal, Runtime } from "./runtime.ts";
export const customerRoles = [
  "sales",
  "team_admin",
  "org_owner",
  "billing",
  "sys_admin",
] as const;
export const opsRoles = [
  "ops_owner",
  "ops_sales",
  "ops_setup",
  "ops_finance",
  "ops_support",
] as const;
export function roles(m: Row): string[] {
  return parse(m.roles, []);
}
export function has(m: Row, ...wanted: string[]) {
  return wanted.some((r) => roles(m).includes(r));
}
export async function principal(
  rt: Runtime,
  headers: Headers,
): Promise<Principal | null> {
  const cookie = headers.get("cookie");
  const auth = headers.get("authorization");
  if (!cookie?.includes("session_token") && !auth) return null;
  const session = await rt.auth.api.getSession({ headers });
  if (!session?.user.emailVerified) return null;
  const [ops, ctx] = await Promise.all([
    one(
      rt.db,
      "SELECT role FROM ops_assignments WHERE email=? AND state='active'",
      [session.user.email],
    ),
    one(rt.db, "SELECT * FROM session_context WHERE session_id=?", [
      session.session.id,
    ]),
  ]);
  return {
    user: session.user,
    sessionId: session.session.id,
    tenantId: ctx?.tenant_id ?? null,
    opsRole: ops?.role ?? null,
    mfa: Boolean(
      ctx?.mfa_at && Date.now() - Date.parse(ctx.mfa_at) < 12 * 3600 * 1000,
    ),
  };
}
export async function member(rt: Runtime, user: string, tenant: string) {
  const m = await one(
    rt.db,
    "SELECT * FROM memberships WHERE tenant_id=? AND user_id=? AND state='active'",
    [tenant, user],
  );
  requireThat(
    m,
    403,
    "TENANT_FORBIDDEN",
    "この企業へのアクセス権がありません。",
  );
  return m;
}
export function requireRoles(c: Context<AppEnv>, ...wanted: string[]) {
  requireThat(
    has(c.get("membership"), ...wanted),
    403,
    "FORBIDDEN",
    "この操作を行う権限がありません。",
  );
}
export function requireOps(c: Context<AppEnv>, ...wanted: string[]) {
  const p = c.get("principal");
  requireThat(
    p.opsRole,
    403,
    "OPS_FORBIDDEN",
    "運営画面へのアクセス権がありません。",
  );
  requireThat(
    p.mfa,
    403,
    "MFA_REQUIRED",
    "運営画面には認証アプリでの追加確認が必要です。",
  );
  requireThat(
    p.opsRole === "ops_owner" || wanted.includes(p.opsRole),
    403,
    "FORBIDDEN",
    "この運営操作を行う権限がありません。",
  );
}
export function customerAccess(
  m: Row,
  customer: Row,
  action: "read" | "edit" | "approve" | "send",
  settings: Row = {},
) {
  const own = customer.owner_user_id === m.user_id;
  const team = Boolean(
    customer.team_id && parse(m.teams, []).includes(customer.team_id),
  );
  if (action === "send")
    return (
      (has(m, "sales") && own) ||
      (settings.proxySend === true &&
        (has(m, "org_owner") || (has(m, "team_admin") && team)))
    );
  if (has(m, "org_owner") || (has(m, "team_admin") && team)) return true;
  return (
    has(m, "sales") &&
    (own || (action === "read" && settings.shareTeam === true && team))
  );
}
export async function accountFor(rt: Runtime, tenant: string, oa: string) {
  const a = await one(
    rt.db,
    "SELECT * FROM accounts WHERE tenant_id=? AND id=?",
    [tenant, oa],
  );
  requireThat(a, 404, "OA_NOT_FOUND", "公式LINEが見つかりません。");
  return a;
}
export async function memberships(rt: Runtime, user: string): Promise<Row[]> {
  const ms = await all(
    rt.db,
    "SELECT m.*,t.name,t.state AS tenant_state FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.state='active'",
    [user],
  );
  return ms.map((m) => ({
    ...m,
    roles: parse(m.roles, []),
    teams: parse(m.teams, []),
  }));
}
export function homeFor(m: Row) {
  const rs: string[] = Array.isArray(m.roles) ? m.roles : roles(m);
  if (rs.includes("org_owner") || rs.includes("team_admin"))
    return "/sales?view=dashboard";
  if (rs.includes("sales")) return "/sales";
  if (rs.includes("sys_admin")) return "/onboarding";
  return "/billing";
}
