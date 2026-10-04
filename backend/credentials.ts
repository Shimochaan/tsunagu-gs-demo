import { one, id, now, json, parse } from "./db.ts";
import { encrypt, decrypt, audit, requireThat } from "./security.ts";
import type { Runtime } from "./runtime.ts";
export async function putCredential(
  rt: Runtime,
  tenant: string,
  oa: string,
  service: string,
  value: Record<string, string>,
  actor: string,
) {
  const ciphertext = await encrypt(
    rt.key,
    json(value),
    `${tenant}:${oa}:${service}`,
  );
  await rt.db.query(
    `INSERT INTO credentials(id,tenant_id,oa_id,service,ciphertext,key_version,registered_by,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,oa_id,service) DO UPDATE SET ciphertext=excluded.ciphertext,key_version=excluded.key_version,registered_by=excluded.registered_by,updated_at=excluded.updated_at`,
    [id(), tenant, oa, service, ciphertext, rt.keyVersion, actor, now()],
  );
  await audit(rt.db, actor, "credential.updated", `${oa}:${service}`, tenant);
}
export async function getCredential(
  rt: Runtime,
  tenant: string,
  oa: string,
  service: string,
) {
  const r = await one(
    rt.db,
    "SELECT ciphertext,key_version FROM credentials WHERE tenant_id=? AND oa_id=? AND service=?",
    [tenant, oa, service],
  );
  requireThat(
    r,
    409,
    "CREDENTIAL_REQUIRED",
    "接続に必要な資格情報を登録してください。",
  );
  requireThat(
    r.key_version === rt.keyVersion,
    503,
    "KEY_UNAVAILABLE",
    "資格情報の暗号鍵を確認してください。",
  );
  return parse(
    await decrypt(rt.key, r.ciphertext, `${tenant}:${oa}:${service}`),
  );
}
