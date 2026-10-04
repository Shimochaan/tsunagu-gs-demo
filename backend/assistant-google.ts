import { registerGoogleBrowser } from "./google-browser.ts";
import { registerNewsDriveOAuth } from "./assistant-news-oauth.ts";
import type { Hono, Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "./runtime.ts";
import { one, all, json, parse } from "./db.ts";
import { requireThat } from "./security.ts";
import {
  googleAdmin,
  googleDB,
  googleConfig,
  googleSettings,
  retiredProducts,
} from "./assistant-google-store.ts";
import { previewProperties, importProperties } from "./assistant-sheets.ts";
import { runDailyResearch, researchPreflight } from "./assistant-research.ts";

const base = "/api/tenants/:tenantId/accounts/:oaId/assistant/google";
export function registerAssistantGoogle(app: Hono<AppEnv>) {
  registerNewsDriveOAuth(app);
  registerGoogleBrowser(app);
  const context = async (c: Context<AppEnv>) => {
    const rt = c.env.runtime,
      t = c.req.param("tenantId")!,
      oa = c.req.param("oaId")!,
      actor = c.get("principal").user.id;
    await googleAdmin(rt, t, oa, actor);
    return { rt, t, oa, actor, db: await googleDB(rt, t, oa) };
  };
  app.get(base, async (c) => {
    const x = await context(c),
      config = await googleConfig(x.db);
    const read = await one(
      x.rt.db,
      "SELECT state,config FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",
      [x.t, x.oa, `google_drive:${x.actor}`],
    );
    const write = await one(
      x.rt.db,
      "SELECT state,config FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",
      [x.t, x.oa, `google_drive_news:${x.actor}`],
    );
    return c.json({
      settings: config.settings,
      sheetSync: await one(x.db,"SELECT state,checked_at,next_at,detail FROM assistant_sheet_sync WHERE id='default'"),
      readState: read?.state || "disconnected",
      readEmail: parse(read?.config).email || null,
      newsState: write?.state || "disconnected",
      newsEmail: parse(write?.config).email || null,
      version: config.version,
      owner: config.row?.actor === x.actor,
      driveReadConfigured: ["connected", "syncing"].includes(read?.state),
      newsWriteConfigured: write?.state === "connected",
      newsAuthorizationEnabled:
        !!x.rt.assistantNewsAuthorizationEnabled && !!x.rt.googleOAuth,
      newsWriteFolderId: parse(write?.config).folderId || null,
      researchManualOnly: !!x.rt.assistantResearchManualOnly,
      researchModel: x.rt.assistantResearchModel || x.rt.ai?.model || null,
      researchRuntimeEnabled: !!x.rt.assistantResearchEnabled,
      aiConfigured: !!x.rt.ai,
      researchRuns: await all(
        x.db,
        "SELECT day,state,created_at,archive_id,error_code,result IS NOT NULL AS has_result FROM assistant_research_days ORDER BY day DESC LIMIT 7",
      ),
    });
  });
  app.put(base, async (c) => {
    const x = await context(c),
      b = z
        .object({
          version: z.number().int().nonnegative(),
          settings: googleSettings,
        })
        .strict()
        .parse(await c.req.json());
    await saveGoogleConfig(x, b);
    return c.json({ version: b.version + 1, settings: b.settings });
  });
  app.post(`${base}/properties/preview`, async (c) => {
    const x = await context(c);
    return c.json(await previewProperties(x.rt, x.t, x.oa, x.actor));
  });
  app.post(`${base}/properties/import`, async (c) => {
    const x = await context(c),
      b = z
        .object({ reviewId: z.string().uuid() })
        .strict()
        .parse(await c.req.json());
    return c.json(await importProperties(x.rt, x.t, x.oa, x.actor, b.reviewId));
  });
  app.post(`${base}/properties/cancel`, async (c) => {
    const x = await context(c),
      b = z
        .object({ reviewId: z.string().uuid() })
        .strict()
        .parse(await c.req.json());
    await x.db.query(
      "UPDATE assistant_google_config SET review_state='cancelled' WHERE id='default' AND actor=? AND review_id=? AND review_state='ready'",
      [x.actor, b.reviewId],
    );
    return c.json({ cancelled: true });
  });
  app.post(`${base}/research/run`, async (c) => {
    const x = await context(c);
    z.object({ acknowledgeCost: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    return c.json(await runDailyResearch(x.rt, x.t, x.oa, x.actor));
  });
  app.get(`${base}/research/preflight`, async (c) => {
    const x = await context(c);
    return c.json(await researchPreflight(x.rt, x.t, x.oa, x.actor));
  });
  app.get(`${base}/research/:day`, async (c) => {
    const x = await context(c),
      day = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .parse(c.req.param("day"));
    const run = await one(
      x.db,
      "SELECT result FROM assistant_research_days WHERE day=?",
      [day],
    );
    requireThat(
      run?.result,
      404,
      "RESEARCH_NOT_FOUND",
      "保存された調査メモがありません。",
    );
    return c.json(JSON.parse(run.result));
  });
}

export async function saveGoogleConfig(
  x: {
    rt: AppEnv["Bindings"]["runtime"];
    t: string;
    oa: string;
    actor: string;
    db: Awaited<ReturnType<typeof googleDB>>;
  },
  b: { version: number; settings: z.infer<typeof googleSettings> },
) {
  await googleAdmin(x.rt, x.t, x.oa, x.actor);
  b.settings = googleSettings.parse(b.settings);
  const old = await googleConfig(x.db);
  requireThat(
    b.version === old.version,
    409,
    "CONFIG_CHANGED",
    "設定が更新されました。再読込してください。",
  );
  if (b.settings.researchEnabled) {
    requireThat(
      x.rt.assistantResearchEnabled &&
        x.rt.ai &&
        (b.settings.researchToProposals || b.settings.newsFolderId) &&
        b.settings.topics.length &&
        b.settings.allowedHosts.length,
      409,
      "RESEARCH_NOT_READY",
      "ニュース調査の実行許可・OpenAI・テーマ・出典・保存先を先に設定してください。",
    );
    requireThat(
      b.settings.researchToProposals || await one(
        x.rt.db,
        "SELECT id FROM connections WHERE tenant_id=? AND oa_id=? AND service=? AND state='connected'",
        [x.t, x.oa, `google_drive_news:${x.actor}`],
      ),
      409,
      "NEWS_WRITE_NOT_CONNECTED",
      "ニュース保存用のDrive書込認可が未接続です。",
    );
  }
  // Conditional write plus invalidation in one DB transaction. A stale form cannot overwrite a newer setting.
  const marker = crypto.randomUUID();
  const updates = await x.db.batch([
    {
      sql: "INSERT INTO assistant_google_config(id,actor,data,version,review_id) SELECT 'default',?,?,1,? WHERE ?=0 ON CONFLICT(id) DO NOTHING",
      params: [x.actor, json(b.settings), marker, b.version],
    },
    {
      sql: "UPDATE assistant_google_config SET actor=?,data=?,version=version+1,review_id=?,review_state=NULL,review_json=NULL WHERE id='default' AND version=? AND review_id<>?",
      params: [x.actor, json(b.settings), marker, b.version, marker],
    },
    // Changing the identity/scope invalidates old stock, including already approved proposals through source versions.
    ...(old.row &&
    (old.row.actor !== x.actor ||
      old.settings.folderId !== b.settings.folderId ||
      old.settings.spreadsheetId !== b.settings.spreadsheetId)
      ? [
          retiredProducts(
            "EXISTS(SELECT 1 FROM assistant_google_config WHERE review_id=?)",
            [marker],
          ),
        ]
      : []),
  ]);
  requireThat(
    updates[0].changes + updates[1].changes === 1,
    409,
    "CONFIG_CHANGED",
    "設定が更新されました。再読込してください。",
  );
}
