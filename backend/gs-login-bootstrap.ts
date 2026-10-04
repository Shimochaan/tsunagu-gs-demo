// Serve the real public login assets while owner-supplied authentication secrets are pending.
// No session, tenant data, auth callback, or authenticated API is synthesized here.
export async function loginBootstrapResponse(
  request: Request,
  env: {
    GS_RUNTIME_ENABLED?: string;
    ASSETS?: { fetch(request: Request): Promise<Response> };
  },
) {
  const path = new URL(request.url).pathname;
  if (env.GS_RUNTIME_ENABLED === "true" && request.method === "GET") {
    if (path === "/api/me")
      return Response.json(
        { error: "AUTH_REQUIRED", message: "ログインが必要です。" },
        { status: 401 },
      );
    if (path === "/api/config")
      return Response.json({
        google: false,
        mail: false,
        mailMode: "unconfigured",
        setupRequired: true,
      });
    if (
      env.ASSETS &&
      (["/", "/login", "/sales", "/sales/connections"].includes(path) ||
        /^\/assets\/[\w.-]+$/.test(path))
    ) {
      const r = await env.ASSETS.fetch(request);
      const response = new Response(r.body, r);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
      return response;
    }
  }
  return Response.json(
    {
      error: "INTEGRATION_NOT_CONFIGURED",
      deliveryEnabled: false,
      connected: false,
    },
    { status: 503 },
  );
}
