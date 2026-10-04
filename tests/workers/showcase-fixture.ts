import worker, { ShowcaseDatabase } from "../../backend/showcase-worker.ts";
import { showcaseSeed } from "../../backend/showcase-seed.ts";
export { ShowcaseDatabase };
export default {
  async fetch(request: Request, env: any) {
    if (new URL(request.url).pathname === "/__init") {
      for (const q of showcaseSeed(JSON.parse(env.AUTH_DDL)).platform)
        await env.PLATFORM_DB.prepare(q.sql)
          .bind(...(q.params || []))
          .run();
      return Response.json({ ok: true });
    }
    return worker.fetch(request, env);
  },
};
