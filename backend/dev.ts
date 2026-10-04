import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeLocal } from "./local.ts";
import { createApp } from "./app.ts";
import { runPending } from "./jobs.ts";
const port = Number(process.env.PORT ?? 4180);
const directory = path.resolve(process.env.TSUNAGU_LOCAL_DIR ?? ".local");
const { runtime, close } = await makeLocal({
  directory,
  origin: `http://127.0.0.1:${port}`,
});
runtime.assets = {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const file = pathname.startsWith("/assets/")
      ? path.join("build/public", pathname)
      : "build/public/index.html";
    if (
      pathname.startsWith("/assets/") &&
      !/^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname)
    )
      return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: {
          "Content-Type": file.endsWith(".js")
            ? "application/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response("Build the app with npm run build.", { status: 503 });
    }
  },
};
const app = createApp();
const server = serve({
  fetch: (request) => app.fetch(request, { runtime }),
  hostname: "127.0.0.1",
  port,
});
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await runPending(runtime);
  } catch {
    console.error(
      "開通ジョブの処理に失敗しました。運営画面で状態をご確認ください。",
    );
  } finally {
    running = false;
  }
}, 2000);
console.log(
  `TSUNAGU: http://127.0.0.1:${port} (isolated local data; external delivery disabled)`,
);
process.on("SIGINT", () => {
  clearInterval(timer);
  server.close();
  close();
  process.exit(0);
});
