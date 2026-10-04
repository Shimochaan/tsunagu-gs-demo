import { googleDDL } from "./assistant-google-schema.ts";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { one, json, type Database } from "./db.ts";
import { assistantAccess } from "./assistant.ts";
import { has } from "./access.ts";
import { requireThat } from "./security.ts";
import { googleAPIError, type GoogleAPI } from "./google-api-errors.ts";

export const googleId = z.string().regex(/^[\w-]{1,200}$/);
export const googleSettings = z
  .object({
    folderId: googleId.optional(),
    spreadsheetId: googleId.optional(),
    propertyFileName: z.string().max(1000).optional(),
    sheetName: z.literal("物件台帳").default("物件台帳"),
    newsFolderId: googleId.optional(),
    researchEnabled: z.boolean().default(false),
    researchToProposals: z.boolean().default(false),
    autoSheet: z.boolean().default(false),
    topics: z
      .array(
        z
          .string()
          .trim()
          .min(2)
          .max(40)
          .regex(/^[\p{L}\p{N}\s・ー]+$/u),
      )
      .max(5)
      .default([]),
    allowedHosts: z
      .array(z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/))
      .max(20)
      .default([]),
  })
  .strict();
export type GoogleSettings = z.infer<typeof googleSettings>;

export async function googleDB(rt: Runtime, t: string, oa: string) {
  const db = await rt.openDatabase(t, oa, "tsunagu");
  for (const sql of googleDDL) await db.query(sql);
  return db;
}
export async function googleAdmin(
  rt: Runtime,
  t: string,
  oa: string,
  actor: string,
) {
  const a = await assistantAccess(rt, t, oa, actor);
  requireThat(
    has(a.m, "org_owner", "sys_admin"),
    403,
    "FORBIDDEN",
    "管理者が接続設定・取込を行ってください。",
  );
}
export async function googleConfig(db: Database) {
  const r = await one(
    db,
    "SELECT * FROM assistant_google_config WHERE id='default'",
  );
  return {
    row: r,
    settings: googleSettings.parse(r ? JSON.parse(r.data) : {}),
    version: r?.version ?? 0,
  };
}
export async function boundedJSON(response: Response, api: GoogleAPI = "google") {
  if (!response.ok) throw await googleAPIError(response, api);
  const reader = response.body?.getReader();
  requireThat(reader, 502, "EMPTY_RESPONSE", "接続先から応答がありません。");
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      count += r.value.byteLength;
      requireThat(
        count <= 2000000,
        413,
        "SOURCE_TOO_LARGE",
        "応答が大きすぎます。入力ファイルを分割してください。",
      );
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function googleGET(rt: Runtime, token: string, url: string) {
  const host = new URL(url).hostname;
  return boundedJSON(
    await rt.externalFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }),
    host === "sheets.googleapis.com" ? "sheets" : host === "www.googleapis.com" ? "drive" : "google",
  );
}
export const retiredProducts = (
  guard = "1",
  params: (string | number | null)[] = [],
) => ({
  sql: `UPDATE assistant_sources SET data=json_set(data,'$.status','unknown','$.stock',0),version=version+1,updated_at=? WHERE id LIKE 'sheet-%' AND ${guard}`,
  params: [new Date().toISOString(), ...params],
});
