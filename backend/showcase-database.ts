import { DurableObject } from "cloudflare:workers";
import { showcaseSeed } from "./showcase-seed.ts";
import { SHOWCASE_USER_DDL } from "./showcase-constants.ts";
import { platformSchema, schemas } from "./schema.ts";
import type { Database, Query, Result, Value } from "./db.ts";
export type ShowcaseKind = "platform" | "common" | "harness" | "studio";
// One private SQLite object per visitor + company + OA + purpose. No SQL rewriting,
// and no shared mutable customer/workspace state between public-login sessions.
export class ShowcaseDatabase extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS _showcase_meta (id TEXT PRIMARY KEY,kind TEXT NOT NULL)",
      );
    });
  }
  execute(kind: ShowcaseKind, sample: boolean, queries: Query[]): Result[] {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const existing = sql
        .exec("SELECT kind FROM _showcase_meta WHERE id=?", "default")
        .toArray()[0];
      if (!existing) {
        const seed: Query[] = sample
          ? showcaseSeed([SHOWCASE_USER_DDL])[kind]
          : (kind === "platform"
              ? [...platformSchema, SHOWCASE_USER_DDL]
              : schemas[kind === "studio" ? "tsunagu" : kind]
            ).map((sql) => ({ sql }));
        for (const q of seed) sql.exec(q.sql, ...(q.params || [])).toArray();
        sql.exec("INSERT INTO _showcase_meta VALUES (?,?)", "default", kind);
      } else if (existing.kind !== kind) throw Error("SHOWCASE_DATABASE_SCOPE");
      return queries.map((q) => {
        const rows = sql.exec(q.sql, ...(q.params || [])).toArray();
        const changed = sql.exec("SELECT changes() AS n").one().n;
        return { rows, changes: Number(changed) };
      });
    });
  }
}
export class ShowcaseStore implements Database {
  constructor(
    private stub: {
      execute(
        kind: ShowcaseKind,
        sample: boolean,
        queries: Query[],
      ): Promise<Result[]>;
    },
    private kind: ShowcaseKind,
    private sample: boolean,
  ) {}
  async query(sql: string, params: Value[] = []) {
    return (await this.batch([{ sql, params }]))[0];
  }
  async batch(queries: Query[]) {
    return this.stub.execute(this.kind, this.sample, queries);
  }
}
