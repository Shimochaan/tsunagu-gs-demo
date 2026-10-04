import { requireThat } from "./security.ts";

// Workers supports follow/manual, while Node also accepts redirect:"error".
// Preserve the caller's rejection policy without forwarding credentials on 3xx.
export function workerFetch(provider: typeof fetch): typeof fetch {
  return async (input, init) => {
    const rejectRedirect =
      (init?.redirect ?? (input instanceof Request ? input.redirect : undefined)) === "error";
    const response = await provider(input, rejectRedirect ? { ...init, redirect: "manual" } : init);
    requireThat(
      !rejectRedirect || response.status < 300 || response.status >= 400,
      502,
      "PROVIDER_REDIRECT_BLOCKED",
      "接続先の転送を停止しました。接続設定を確認してください。",
    );
    return response;
  };
}
