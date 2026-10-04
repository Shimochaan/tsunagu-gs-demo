import { sendProposalNotice, sendBookingNotice } from "./notify.ts";
import { all, one, now, json, parse, id, type Row, type Query } from "./db.ts";
import { audit, AppError } from "./security.ts";
import type { Runtime } from "./runtime.ts";
export async function queueJob(
  rt: Runtime,
  tenant: string,
  oa: string,
  kind: string,
  actor: string,
  key: string,
  payload = {},
) {
  const jobId = id();
  await rt.db.query(
    "INSERT OR IGNORE INTO jobs(id,tenant_id,oa_id,kind,dedupe_key,payload,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [jobId, tenant, oa, kind, key, json(payload), actor, now(), now()],
  );
  return await one(rt.db, "SELECT * FROM jobs WHERE dedupe_key=?", [key]);
}
export function databaseQueries(tenant: string, oa = ""): Query[] {
  return (oa ? ["harness", "tsunagu"] : ["common"]).map((purpose) => ({
    sql: "INSERT OR IGNORE INTO databases(id,tenant_id,oa_id,purpose) VALUES (?,?,?,?)",
    params: [id(), tenant, oa, purpose],
  }));
}
export function jobQuery(
  tenant: string,
  oa: string,
  kind: string,
  actor: string,
  key: string,
  payload = {},
): Query {
  return {
    sql: "INSERT OR IGNORE INTO jobs(id,tenant_id,oa_id,kind,dedupe_key,payload,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    params: [id(), tenant, oa, kind, key, json(payload), actor, now(), now()],
  };
}
export async function runJob(rt: Runtime, jobId: string) {
  // UPDATEの条件で獲得するため、同時に再試行しても一人だけがジョブを実行できる。
  const claimed = await rt.db.query(
    `UPDATE jobs SET state='running',attempts=attempts+1,lease_until=?,updated_at=?
    WHERE id=? AND (state='pending' OR (state='running' AND lease_until<?))
    AND NOT EXISTS (SELECT 1 FROM jobs AS other WHERE other.tenant_id=jobs.tenant_id AND other.id<>jobs.id AND other.state='running' AND other.lease_until>?)
    RETURNING *`,
    [new Date(Date.now() + 300000).toISOString(), now(), jobId, now(), now()],
  );
  const job = claimed.rows[0];
  if (!job) return;
  try {
    if (job.kind === "provision") {
      const dbs = await all(
        rt.db,
        "SELECT * FROM databases WHERE tenant_id=? ORDER BY purpose",
        [job.tenant_id],
      );
      const completed: string[] = parse(job.steps, []);
      for (const db of dbs) {
        if (db.state !== "ready") {
          const physicalId = await rt.provisionDatabase(db);
          await rt.db.query(
            "UPDATE databases SET physical_id=?,state='ready',schema_version=1 WHERE id=?",
            [physicalId, db.id],
          );
        }
        if (!completed.includes(db.id)) completed.push(db.id);
        await rt.db.query(
          "UPDATE jobs SET steps=?,lease_until=?,updated_at=? WHERE id=?",
          [
            json(completed),
            new Date(Date.now() + 300000).toISOString(),
            now(),
            job.id,
          ],
        );
      }
      await rt.deployTenant(job.tenant_id);
    } else if (job.kind === "invite") {
      const p = parse(job.payload);
      const invitation = await one(
        rt.db,
        "SELECT * FROM invitations WHERE id=? AND tenant_id=?",
        [p.invitationId, job.tenant_id],
      );
      if (
        !invitation ||
        invitation.revoked_at ||
        invitation.accepted_at ||
        invitation.expires_at <= now()
      )
        throw new AppError(
          409,
          "INVITATION_EXPIRED",
          "招待を再発行してください。",
        );
      const tenant = await one(rt.db, "SELECT name FROM tenants WHERE id=?", [
        job.tenant_id,
      ]);
      await rt.sendMail({
        to: invitation.email,
        subject: `${tenant.name}からTSUNAGUへの招待`,
        text: `${tenant.name}のワークスペースへ招待されました。\n${rt.origin}/login\n招待されたメールアドレスでログインし、企業への参加を確認してください。\n有効期限: ${invitation.expires_at}`,
      });
    } else if (job.kind === "slack_proposal") {
      await sendProposalNotice(rt, job.tenant_id, job.oa_id, parse(job.payload));
    } else if (job.kind === "slack_booking") {
      await sendBookingNotice(rt, job.tenant_id, job.oa_id, parse(job.payload));
    } else
      throw new AppError(
        422,
        "UNSUPPORTED_JOB",
        "この処理はまだ対応していません。",
      );
    await rt.db.query(
      "UPDATE jobs SET state='completed',lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?",
      [now(), job.id],
    );
    await audit(rt.db, job.created_by, "job.completed", job.id, job.tenant_id);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "JOB_FAILED";
    // 例外全文に秘密情報が含まれる可能性があるため、管理画面へ返すのは定義したコードだけ。
    await rt.db.query(
      "UPDATE jobs SET state=?,lease_until=NULL,error_code=?,updated_at=? WHERE id=?",
      [["slack_proposal", "slack_booking"].includes(job.kind) && job.attempts < 5 ? "pending" : "failed", code, now(), job.id],
    );
    await audit(rt.db, job.created_by, "job.failed", job.id, job.tenant_id, {
      code,
    });
  }
}
export async function runPending(rt: Runtime) {
  const jobs = await all(
    rt.db,
    "SELECT id,tenant_id FROM jobs WHERE state='pending' OR (state='running' AND lease_until<?) ORDER BY created_at LIMIT 10",
    [now()],
  );
  for (const job of jobs) {
    const active = await one(
      rt.db,
      "SELECT id FROM jobs WHERE tenant_id=? AND state='running' AND lease_until>? AND id<>?",
      [job.tenant_id, now(), job.id],
    );
    if (!active) await runJob(rt, job.id);
  }
}
export async function registerDatabases(rt: Runtime, tenant: string, oa = "") {
  for (const purpose of oa ? ["harness", "tsunagu"] : ["common"]) {
    await rt.db.query(
      "INSERT OR IGNORE INTO databases(id,tenant_id,oa_id,purpose) VALUES (?,?,?,?)",
      [id(), tenant, oa, purpose],
    );
  }
}
