import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./auth.ts";
import { betterAuth } from "better-auth";
import {
  all,
  one,
  now,
  type Query,
  type Value,
  type Database,
  type Row,
} from "./db.ts";
import { platformSchema, schemas, type Purpose } from "./schema.ts";
import { requireThat, AppError } from "./security.ts";
import type { Runtime, Mail } from "./runtime.ts";
export class LocalStore implements Database {
  readonly native: DatabaseSync;
  constructor(file: string) {
    this.native = new DatabaseSync(file);
    this.native.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
  }
  async query(sql: string, params: Value[] = []) {
    return this.exec(sql, params);
  }
  private exec(sql: string, params: Value[] = []) {
    const stmt = this.native.prepare(sql);
    const rows = stmt.columns().length ? (stmt.all(...params) as Row[]) : [];
    const changes = stmt.columns().length
      ? Number((this.native.prepare("SELECT changes() AS n").get() as any).n)
      : Number(stmt.run(...params).changes);
    return { rows, changes };
  }
  async batch(queries: Query[]) {
    this.native.exec("BEGIN IMMEDIATE");
    try {
      const result = queries.map((q) => this.exec(q.sql, q.params));
      this.native.exec("COMMIT");
      return result;
    } catch (e) {
      this.native.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.native.close();
  }
}
export async function makeLocal(options: {
  directory: string;
  origin: string;
  mailSink?: (m: Mail) => Promise<void>;
  externalFetch?: typeof fetch;
  authSecret?: string;
  key?: string;
}) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(options.directory, "mail"), {
    recursive: true,
    mode: 0o700,
  });
  const configFile = path.join(options.directory, "runtime-secrets.json");
  let secrets: { auth: string; key: string };
  try {
    secrets = JSON.parse(await readFile(configFile, "utf8"));
  } catch {
    secrets = {
      auth: Buffer.from(randomBytes(48)).toString("base64url"),
      key: Buffer.from(randomBytes(32)).toString("base64"),
    };
    await writeFile(configFile, JSON.stringify(secrets), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const db = new LocalStore(path.join(options.directory, "platform.sqlite"));
  for (const sql of platformSchema) await db.query(sql);
  const stores = new Map<string, LocalStore>();
  const sendMail =
    options.mailSink ??
    (async (mail: Mail) => {
      // 開発用メール受信箱はWebで公開しない。実メール送信や固定OTPによる認証迂回も行わない。
      const file = path.join(
        options.directory,
        "mail",
        `${Date.now()}-${Buffer.from(randomBytes(6)).toString("hex")}.json`,
      );
      await writeFile(file, JSON.stringify({ ...mail, at: now() }), {
        mode: 0o600,
      });
    });
  const config = authOptions({
    database: db.native,
    db,
    origin: options.origin,
    secret: options.authSecret ?? secrets.auth,
    sendMail,
  });
  const migrations = await getMigrations(config);
  await migrations.runMigrations();
  const auth = betterAuth(config);
  const rt: Runtime = {
    db,
    auth,
    origin: options.origin,
    key: options.key ?? secrets.key,
    keyVersion: "v1",
    local: true,
    assistantManualOnly: true,
    provisioningEnabled: true,
    googleEnabled: false,
    mailMode: "local",
    sendMail,
    externalFetch:
      options.externalFetch ??
      (async () => {
        throw new AppError(
          503,
          "LOCAL_EXTERNAL_DISABLED",
          "ローカルでは外部接続を実行しません。接続テスト用設定が必要です。",
        );
      }),
    async provisionDatabase(record: Row) {
      const file = path.join(options.directory, `${record.id}.sqlite`);
      let store = stores.get(record.id);
      if (!store) {
        store = new LocalStore(file);
        stores.set(record.id, store);
      }
      for (const sql of schemas[record.purpose as Purpose])
        await store.query(sql);
      await chmod(file, 0o600);
      return record.id;
    },
    async deployTenant(tenant: string) {
      await db.query(
        "INSERT INTO tenant_runtimes(tenant_id,version,state) VALUES (?,1,'ready') ON CONFLICT(tenant_id) DO UPDATE SET version=version+1,state='ready'",
        [tenant],
      );
    },
    async openDatabase(tenant: string, oa: string, purpose: Purpose) {
      const record = await one(
        db,
        "SELECT * FROM databases WHERE tenant_id=? AND oa_id=? AND purpose=? AND state='ready'",
        [tenant, oa, purpose],
      );
      requireThat(
        record,
        409,
        "DATABASE_NOT_READY",
        "データベースの準備が完了していません。",
      );
      let store = stores.get(record.id);
      if (!store) {
        store = new LocalStore(
          path.join(options.directory, `${record.id}.sqlite`),
        );
        // 開発中の追加テーブルを既存のローカルDBにも適用する。保存済みデータは削除しない。
        for (const sql of schemas[purpose]) await store.query(sql);
        stores.set(record.id, store);
      }
      return store;
    },
  };
  return {
    runtime: rt,
    close: () => {
      for (const s of stores.values()) s.close();
      db.close();
    },
  };
}
