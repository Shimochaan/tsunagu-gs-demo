import type { Database } from "./db.ts";
import { id, now, one, json } from "./db.ts";
const encoder = new TextEncoder();
export const bytes = (s: string) => encoder.encode(s);
export const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a));
export const unb64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function digest(s: string) {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(s))));
}
export async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(body))),
  );
}
export async function verify(secret: string, body: string, signature: string) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      unb64(signature),
      bytes(body),
    );
  } catch {
    return false;
  }
}
// AADを含めて暗号化するため、別企業・別OAに暗号文をコピーしても復号できない。
export async function encrypt(
  keyBase64: string,
  plaintext: string,
  scope: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(keyBase64),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bytes(scope) },
    key,
    bytes(plaintext),
  );
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}
export async function decrypt(
  keyBase64: string,
  ciphertext: string,
  scope: string,
) {
  const [iv, cipher] = ciphertext.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(keyBase64),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: bytes(scope) },
      key,
      unb64(cipher),
    ),
  );
}
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export async function audit(
  db: Database,
  actor: string,
  action: string,
  target: string,
  tenant: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO audit (id,tenant_id,actor_id,action,target,metadata,at) VALUES (?,?,?,?,?,?,?)",
    [id(), tenant, actor, action, target, json(metadata), now()],
  );
}
export async function limit(
  db: Database,
  key: string,
  maximum: number,
  windowSeconds: number,
) {
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  await db.query(
    "INSERT INTO rate_limits(key,window_start,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start",
    [key, window],
  );
  const row = await one(db, "SELECT count FROM rate_limits WHERE key=?", [key]);
  requireThat(
    row.count <= maximum,
    429,
    "RATE_LIMIT",
    "操作が続いています。少し待ってからお試しください。",
  );
}
