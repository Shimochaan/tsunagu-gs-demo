import type { Runtime } from "./runtime.ts";
import { createApp } from "./app.ts";
import { runPending } from "./jobs.ts";
export {
  SHOWCASE_TENANT,
  SHOWCASE_OA,
  SHOWCASE_USER,
} from "./showcase-constants.ts";
export const SHOWCASE_MESSAGE =
  "外部サービスの接続は実機体験で行ってください。架空データの編集・保存はこの画面で試せます。";
const app = createApp();
export async function showcaseFetch(request: Request, runtime: Runtime) {
  const path = new URL(request.url).pathname;
  const read = ["GET", "HEAD"].includes(request.method);
  const authAllowed =
    (request.method === "POST" &&
      ["/api/auth/sign-in/demo", "/api/auth/sign-out"].includes(path)) ||
    (read && path === "/api/auth/get-session");
  if (
    path.startsWith("/webhooks/") ||
    (path.startsWith("/api/auth/") && !authAllowed)
  )
    return Response.json(
      { error: "NOT_FOUND", message: "公開デモのログインを利用してください。" },
      { status: 404 },
    );
  // Public demo credentials cannot be converted into an operator MFA credential or
  // another real external account. All business data lives in the visitor's own DBs.
  if (!read && path.startsWith("/api/security/"))
    return Response.json(
      {
        error: "SHOWCASE_SECURITY",
        message:
          "公開デモでは認証設定を変更できません。企業設定・文案などの操作を試してください。",
      },
      { status: 403 },
    );
  const response = await app.fetch(request, { runtime });
  if (!read && response.ok && !path.startsWith("/api/auth/"))
    await runPending(runtime);
  return response;
}
