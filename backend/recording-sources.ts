import { z } from "zod";
import type { Hono, Context } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { accountFor, has, customerAccess } from "./access.ts";
import { requireThat, audit } from "./security.ts";

export function driveFolderId(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.hostname !== "drive.google.com" || u.username || u.password || u.port) throw new Error("Google DriveのフォルダURLを入力してください。");
  const match = u.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/);
  if (!match) throw new Error("Google DriveのフォルダURLを入力してください。");
  return match[1];
}
const folderUrl = z.string().max(1000).refine(v => { try { driveFolderId(v); return true; } catch { return false; } }, "Google DriveのフォルダURLを入力してください。").transform(v => `https://drive.google.com/drive/folders/${driveFolderId(v)}`);
const fileUrl = z.url().max(1000).refine(v => {
  const u = new URL(v);
  return u.protocol === "https:" && !u.username && !u.password && !u.port &&
    ((u.hostname === "drive.google.com" && /^\/file\/d\/[\w-]+(?:\/|$)/.test(u.pathname)) ||
     (u.hostname === "docs.google.com" && /^\/document\/d\/[\w-]+(?:\/|$)/.test(u.pathname)));
}, "Driveの録画ファイル、またはGoogleドキュメントのURLを入力してください。");
export const recordingSourceSchema = z.object({
  id: z.uuid(), label: z.string().trim().min(1).max(100),
  hostEmail: z.email().transform(v => v.toLowerCase()), folderUrl,
  includeSubfolders: z.boolean().default(true), enabled: z.boolean().default(true),
}).strict();
const configSchema = z.object({ revision: z.number().int().nonnegative(), sources: z.array(recordingSourceSchema).max(50) }).strict().superRefine((v, ctx) => {
  if (new Set(v.sources.map(s => s.id)).size !== v.sources.length || new Set(v.sources.map(s => s.hostEmail + ":" + s.folderUrl)).size !== v.sources.length)
    ctx.addIssue({ code: "custom", message: "同じ担当者・保存先の重複登録はできません。" });
});
const matchSchema = z.object({ sourceId: z.uuid(), startedAt: z.iso.datetime({ offset: true }), bookingId: z.string().trim().max(200).optional() }).strict();
const service = "meeting_recording_sources";
export async function readRecordingSources(rt: Runtime, tenant: string, oa: string) {
  const row = await one(rt.db, "SELECT config FROM connections WHERE tenant_id=? AND oa_id=? AND service=?", [tenant, oa, service]);
  return { row, config: configSchema.parse(row ? parse(row.config) : { revision: 0, sources: [] }) };
}
export async function recordingAccess(c: Context<AppEnv>) {
  const rt = c.env.runtime, tenant = c.req.param("tenantId")!, oa = c.req.param("oaId")!;
  const account = await accountFor(rt, tenant, oa), m = c.get("membership");
  const assigned = account.owner_user_id === m.user_id || parse(account.operators, []).includes(m.user_id) ||
    (has(m, "team_admin") && account.team_id && parse(m.teams, []).includes(account.team_id));
  requireThat(has(m, "org_owner", "sys_admin") || (has(m, "sales", "team_admin") && assigned), 403, "RECORDING_FORBIDDEN", "この公式LINEの録画保存先を管理する権限がありません。");
  return { rt, tenant, oa, m };
}

// 日時と主催者は候補絞り込みにだけ使う。氏名・タイトルの類似だけで顧客へ自動反映しない。
export function recordingMatches(appointments: Row[], source: z.infer<typeof recordingSourceSchema>, input: z.infer<typeof matchSchema>) {
  if (!source.enabled) return [];
  return appointments.filter(a => {
    const d = parse(a.details), hosts: string[] = Array.isArray(d.hostEmails) ? d.hostEmails : [];
    if (!["booked", "rescheduled", "attended"].includes(a.state) || !hosts.some(e => e.toLowerCase() === source.hostEmail)) return false;
    if (input.bookingId && a.external_id !== input.bookingId) return false;
    return Math.abs(Date.parse(a.starts_at) - Date.parse(input.startedAt)) <= 90 * 60_000;
  });
}
async function candidates(c: Context<AppEnv>, input: z.infer<typeof matchSchema>) {
  const a = await recordingAccess(c), { config } = await readRecordingSources(a.rt, a.tenant, a.oa);
  const source = config.sources.find(s => s.id === input.sourceId && s.enabled);
  requireThat(source, 404, "SOURCE_NOT_FOUND", "有効な録画保存先が見つかりません。");
  const h = await a.rt.openDatabase(a.tenant, a.oa, "harness"), common = await a.rt.openDatabase(a.tenant, "", "common");
  const rows = await all(h, "SELECT * FROM appointments WHERE starts_at>=? AND starts_at<=? AND state IN ('booked','rescheduled','attended')", [new Date(Date.parse(input.startedAt) - 90*60_000).toISOString(), new Date(Date.parse(input.startedAt) + 90*60_000).toISOString()]);
  const matches: Row[] = [];
  for (const appt of recordingMatches(rows, source, input)) {
    const customer = await one(common, "SELECT c.* FROM customers c JOIN customer_links cl ON cl.customer_id=c.id WHERE c.id=? AND cl.oa_id=? AND cl.state='confirmed'", [appt.customer_id, a.oa]);
    if (customer && customerAccess(a.m, customer, "edit", parse(c.get("tenant").settings))) matches.push({ ...appt, customerName: customer.name });
  }
  return { ...a, h, matches, source };
}
export function registerRecordingSources(app: Hono<AppEnv>) {
  const base = "/api/tenants/:tenantId/accounts/:oaId/connectors/recordings";
  app.get(base, async c => {
    const a = await recordingAccess(c), { config } = await readRecordingSources(a.rt, a.tenant, a.oa);
    return c.json({ ...config, retrievalState: "not_connected" });
  });
  app.put(base, async c => {
    const a = await recordingAccess(c), input = configSchema.parse(await c.req.json());
    const { row, config } = await readRecordingSources(a.rt, a.tenant, a.oa);
    requireThat(input.revision === config.revision, 409, "SOURCE_CHANGED", "保存先が更新されています。再読み込みしてください。");
    const next = { ...input, revision: input.revision + 1 };
    const result = row
      ? await a.rt.db.query("UPDATE connections SET config=? WHERE tenant_id=? AND oa_id=? AND service=? AND config=?", [json(next), a.tenant, a.oa, service, row.config])
      : await a.rt.db.query("INSERT OR IGNORE INTO connections(id,tenant_id,oa_id,service,state,config) VALUES (?,?,?,?,'configured',?)", [id(), a.tenant, a.oa, service, json(next)]);
    requireThat(result.changes === 1, 409, "SOURCE_CHANGED", "保存先が更新されています。再読み込みしてください。");
    await audit(a.rt.db, c.get("principal").user.id, "recording.sources_saved", a.oa, a.tenant, { count: next.sources.length });
    return c.json(next);
  });
  app.post(base + "/candidates", async c => {
    const input = matchSchema.parse(await c.req.json()), a = await candidates(c, input);
    return c.json({ candidates: a.matches.map(x => ({ id: x.id, title: x.title, customerName: x.customerName, startsAt: x.starts_at, version: x.version })), requiresConfirmation: true });
  });
  app.post(base + "/link", async c => {
    const input = matchSchema.extend({ appointmentId: z.string().min(1), version: z.number().int().positive(), fileUrl, confirmed: z.literal(true) }).parse(await c.req.json());
    const a = await candidates(c, matchSchema.parse({ sourceId: input.sourceId, startedAt: input.startedAt, bookingId: input.bookingId }));
    const appointment = a.matches.find(x => x.id === input.appointmentId);
    requireThat(appointment, 409, "RECORDING_NO_MATCH", "日時・担当者・予約を再確認してください。");
    const recording = { sourceId: a.source.id, fileUrl: input.fileUrl, startedAt: input.startedAt, confirmedBy: c.get("principal").user.id, confirmedAt: now() };
    const result = await a.h.query("UPDATE appointments SET details=json_set(details,'$.recording',json(?)),version=version+1 WHERE id=? AND version=? AND state IN ('booked','rescheduled','attended')", [json(recording), appointment.id, input.version]);
    requireThat(result.changes === 1, 409, "APPOINTMENT_CHANGED", "予約が更新されています。候補を再検索してください。");
    await audit(a.rt.db, c.get("principal").user.id, "recording.linked", appointment.id, a.tenant, { sourceId: a.source.id });
    return c.json({ ok: true });
  });
}
