export type Value = string | number | null;
export type Row = Record<string, any>;
export type Query = { sql: string; params?: Value[] };
export interface Result {
  rows: Row[];
  changes: number;
}
export interface Database {
  query(sql: string, params?: Value[]): Promise<Result>;
  batch(queries: Query[]): Promise<Result[]>;
}
export const all = async (db: Database, sql: string, p: Value[] = []) =>
  (await db.query(sql, p)).rows;
export const one = async (db: Database, sql: string, p: Value[] = []) =>
  (await all(db, sql, p))[0] ?? null;
export class D1Store implements Database {
  constructor(readonly binding: D1Database) {}
  async query(sql: string, params: Value[] = []) {
    const r = await this.binding
      .prepare(sql)
      .bind(...params)
      .all();
    return { rows: r.results as Row[], changes: r.meta.changes };
  }
  async batch(queries: Query[]) {
    const rs = await this.binding.batch(
      queries.map((q) => this.binding.prepare(q.sql).bind(...(q.params ?? []))),
    );
    return rs.map((r) => ({
      rows: r.results as Row[],
      changes: r.meta.changes,
    }));
  }
}
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const json = (value: unknown) => JSON.stringify(value);
export const parse = (s: string | null | undefined, fallback: any = {}) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
