import type { Runtime } from "./runtime.ts";
import { createApp } from "./app.ts";
export const SHOWCASE_TENANT = "showcase-company";
export const SHOWCASE_OA = "showcase-sales";
export const SHOWCASE_USER = "showcase-viewer";
export const SHOWCASE_MESSAGE =
  "画面見学用のため保存・送信はできません。実際のLINE体験は案内の「自分のLINEで体験」から進んでください。";
const app = createApp();
// Fail closed for every mutation, even future routes; only the isolated login/logout
// and a membership-checked workspace selection may change the visitor's session.
export async function showcaseFetch(request: Request, runtime: Runtime) {
  const path = new URL(request.url).pathname;
  const read = ["GET", "HEAD"].includes(request.method);
  const authAllowed =
    (request.method === "POST" &&
      ["/api/auth/sign-in/demo", "/api/auth/sign-out"].includes(path)) ||
    (read && path === "/api/auth/get-session");
  const sessionSelect =
    request.method === "POST" && path === "/api/session/tenant";
  if (
    path.startsWith("/webhooks/") ||
    (path.startsWith("/api/auth/") && !authAllowed)
  )
    return Response.json(
      {
        error: "NOT_FOUND",
        message: "公開見学用のログインを利用してください。",
      },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  if (!read && !authAllowed && !sessionSelect)
    return Response.json(
      { error: "SHOWCASE_READ_ONLY", message: SHOWCASE_MESSAGE },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  return app.fetch(request, { runtime });
}
