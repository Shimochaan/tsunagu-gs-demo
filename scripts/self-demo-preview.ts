// Local-only preview. Uses synthetic identity and provider fixtures; never deploy this script.
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { assistantFixture } from "../tests/helpers/assistant-fixture.ts";
import { createApp } from "../backend/app.ts";
import { startDemo } from "../backend/self-demo.ts";
import { now, one, json } from "../backend/db.ts";
const f = await assistantFixture(),
  port = 4188;
f.rt.origin = `http://127.0.0.1:${port}`;
f.rt.selfDemo = {
  tenant: "t",
  oa: "oa",
  capacity: 10,
  timerexUrl: "https://timerex.net/s/gs-estate/59cbab21",
};
f.rt.googleEnabled = true;
f.rt.auth = {
  api: {
    getSession: async () => ({
      user: {
        id: "preview",
        name: "体験ユーザー",
        email: "preview@example.test",
        emailVerified: true,
      },
      session: { id: "preview-session" },
    }),
  },
  handler: async () => Response.json({}),
} as any;
await startDemo(f.rt, { id: "preview", name: "体験ユーザー" });
const p = (await one(
  f.rt.db,
  "SELECT * FROM gs_demo_participants WHERE user_id='preview'",
))!;
await f.rt.db.query(
  "UPDATE gs_demo_participants SET customer_line_id='local-line',notifications_until=? WHERE user_id='preview'",
  [new Date(Date.now() + 7200000).toISOString()],
);
await f.common.query(
  "INSERT INTO customers(id,name,owner_user_id,created_at) VALUES (?,'体験ユーザー（自分）','preview',?)",
  [p.customer_id, now()],
);
await f.common.query(
  "INSERT INTO customer_links(oa_id,line_user_id,customer_id) VALUES ('oa','local-line',?)",
  [p.customer_id],
);
await f.rt.db.query(
  "INSERT INTO staff_line_links(tenant_id,user_id,destination,line_user_id,state,notifications,updated_at) VALUES ('t','preview','local-staff','local-user','active',1,?)",
  [now()],
);
await f.rt.db.query(
  "INSERT INTO gs_demo_documents(id,user_id,title,body,held_at,state,analysis,updated_at) VALUES ('preview-doc','preview','【体験用】初回面談',?,?,'ready',?,?)",
  [
    "渋谷区で予算5500万円以内、2LDK、所有権、駅徒歩10分以内を希望します。",
    now(),
    json({
      summary: "渋谷区で、予算5500万円以内の住まいを希望しています。",
      wish: {
        area: "渋谷区",
        maxPrice: 55000000,
        required: ["2LDK", "所有権", "駅徒歩10分以内"],
      },
    }),
    now(),
  ],
);
await f.ts.query(
  "INSERT INTO proposals(id,customer_id,trigger,reason,draft,customer_version,created_at,updated_at) VALUES ('preview-proposal',?,'assistant:product','議事録の希望条件と、新着物件が一致しました。',?,1,?,?)",
  [
    p.customer_id,
    "ご希望の渋谷区・2LDKのお部屋が新しく入りました。\n駅徒歩5分、4800万円、所有権の物件です。\n在庫は確認時点の情報です。\nよろしければ、住まい相談で詳しくお話ししませんか？",
    now(),
    now(),
  ],
);
await f.ts.query(
  "INSERT INTO assistant_proposals(proposal_id,dedupe_key,kind,line_user_id,owner_user_id,evidence,expires_at) VALUES ('preview-proposal','preview','product','local-line','preview',?,?)",
  [
    json({
      draftMode: "generated",
      draftDetail:
        "ローカル表示確認用の見本です。AI・LINEへの実通信はありません。",
    }),
    new Date(Date.now() + 86400000).toISOString(),
  ],
);
f.rt.assets = {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const asset =
      pathname.startsWith("/assets/") &&
      /^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname);
    const file = asset ? "build/public" + pathname : "build/public/index.html";
    return new Response(await readFile(file), {
      headers: {
        "Content-Type": file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html; charset=utf-8",
      },
    });
  },
};
const app = createApp();
const server = serve({
  hostname: "127.0.0.1",
  port,
  fetch: (r) => {
    const headers = new Headers(r.headers);
    headers.set("cookie", "session_token=local-preview");
    return app.fetch(new Request(r, { headers }), { runtime: f.rt });
  },
});
console.log(`Local fixtures only: http://127.0.0.1:${port}/demo`);
let closing = false;
process.on("SIGINT", async () => {
  if (closing) return;
  closing = true;
  server.close();
  await f.dispose();
  process.exit(0);
});
