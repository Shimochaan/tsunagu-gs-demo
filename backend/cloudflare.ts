import {
  all,
  one,
  now,
  json,
  type Database,
  type Row,
  type Query,
} from "./db.ts";
import { AppError, b64, requireThat } from "./security.ts";
import { schemas, type Purpose } from "./schema.ts";
import { getCredential, putCredential } from "./credentials.ts";
import type { Runtime } from "./runtime.ts";
import { tenantWorkerSource } from "./tenant-worker.ts";
export function cloudflareProvisioning(
  rt: Runtime,
  config: { accountId: string; token: string; subdomain: string },
) {
  async function api(path: string, init: RequestInit = {}) {
    requireThat(
      config.accountId && config.token,
      503,
      "CLOUDFLARE_NOT_CONFIGURED",
      "Cloudflare発行設定が必要です。",
    );
    const response = await rt.externalFetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(init.body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      },
    );
    const body: any = await response.json();
    if (!response.ok || !body.success)
      throw new AppError(
        502,
        "CLOUDFLARE_API_FAILED",
        "Cloudflare側の処理に失敗しました。",
      );
    return body.result;
  }
  return {
    async provisionDatabase(record: Row) {
      const name = `tsunagu-${record.id}`;
      // タイムアウト後の再試行では名前で照合。重複したDBを作らない。
      const existing = await api(
        `/d1/database?name=${encodeURIComponent(name)}`,
      );
      let database = existing.find((d: Row) => d.name === name);
      if (!database)
        database = await api("/d1/database", {
          method: "POST",
          body: json({ name }),
        });
      await rt.db.query("UPDATE databases SET physical_id=? WHERE id=?", [
        database.uuid,
        record.id,
      ]);
      for (const sql of schemas[record.purpose as Purpose])
        await api(`/d1/database/${database.uuid}/query`, {
          method: "POST",
          body: json({ sql, params: [] }),
        });
      return database.uuid;
    },
    async deployTenant(tenant: string) {
      requireThat(
        /^[a-z0-9-]+$/.test(config.subdomain),
        503,
        "WORKERS_SUBDOMAIN_REQUIRED",
        "Workersサブドメインを設定してください。",
      );
      let credential = await one(
        rt.db,
        "SELECT id FROM credentials WHERE tenant_id=? AND oa_id='' AND service='runtime'",
        [tenant],
      );
      if (!credential)
        await putCredential(
          rt,
          tenant,
          "",
          "runtime",
          { token: b64(crypto.getRandomValues(new Uint8Array(32))) },
          "system",
        );
      const secret = await getCredential(rt, tenant, "", "runtime");
      const dbs = await all(
        rt.db,
        "SELECT * FROM databases WHERE tenant_id=? AND state='ready'",
        [tenant],
      );
      const mapping: Record<string, string> = {};
      const bindings: any[] = dbs.map((d, i) => {
        const name = `DB_${i}`;
        mapping[`${d.oa_id}:${d.purpose}`] = name;
        return { type: "d1", name, id: d.physical_id };
      });
      bindings.push(
        { type: "plain_text", name: "DB_MAP", text: json(mapping) },
        { type: "secret_text", name: "RUNTIME_TOKEN", text: secret.token },
      );
      const script = `tsunagu-tenant-${tenant}`;
      const form = new FormData();
      form.set(
        "metadata",
        json({
          main_module: "tenant.mjs",
          compatibility_date: "2026-09-22",
          bindings,
        }),
      );
      form.set(
        "tenant.mjs",
        new Blob([tenantWorkerSource], {
          type: "application/javascript+module",
        }),
        "tenant.mjs",
      );
      await api(`/workers/scripts/${script}`, { method: "PUT", body: form });
      await api(`/workers/scripts/${script}/subdomain`, {
        method: "POST",
        body: json({ enabled: true }),
      });
      const url = `https://${script}.${config.subdomain}.workers.dev`;
      await rt.db.query(
        "INSERT INTO tenant_runtimes(tenant_id,url,version,state) VALUES (?,?,1,'ready') ON CONFLICT(tenant_id) DO UPDATE SET url=excluded.url,version=version+1,state='ready'",
        [tenant, url],
      );
    },
    async openDatabase(
      tenant: string,
      oa: string,
      purpose: Purpose,
    ): Promise<Database> {
      const runtime = await one(
        rt.db,
        "SELECT url FROM tenant_runtimes WHERE tenant_id=? AND state='ready'",
        [tenant],
      );
      const database = await one(
        rt.db,
        "SELECT id FROM databases WHERE tenant_id=? AND oa_id=? AND purpose=? AND state='ready'",
        [tenant, oa, purpose],
      );
      requireThat(
        runtime && database,
        409,
        "DATABASE_NOT_READY",
        "データベースの準備が完了していません。",
      );
      const credential = await getCredential(rt, tenant, "", "runtime");
      async function batch(queries: Query[]) {
        const r = await rt.externalFetch(`${runtime.url}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
          },
          body: json({ key: `${oa}:${purpose}`, queries }),
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok)
          throw new AppError(
            503,
            "TENANT_DATABASE_UNAVAILABLE",
            "企業データベースへの接続を確認しています。",
          );
        return (await r.json()) as any[];
      }
      return {
        batch,
        async query(sql, params = []) {
          return (await batch([{ sql, params }]))[0];
        },
      };
    },
  };
}
