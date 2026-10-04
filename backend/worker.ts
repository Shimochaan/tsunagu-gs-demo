import { pollCalendars } from "./calendar.ts";
import { processMeetingUpdates } from "./meeting-automation.ts";
import { syncPropertySheet } from "./assistant-sync.ts";
import { parseAssistantProvider } from "./assistant-config.ts";
import { retainStaffWebhook } from "./webhook-lifetime.ts";
import { workerFetch } from "./worker-fetch.ts";
import { mapLimited } from "./async-utils.ts";
import { cachedDatabaseOpener } from "./database-cache.ts";
import {
  processAssistantBurst,
  assistantAccounts,
  claimAssistantOA,
  finishAssistantOA,
} from "./assistant-work.ts";
import { scanAssistant } from "./assistant.ts";
import { refreshAssistantSources } from "./assistant-discovery.ts";
import { runDailyResearch } from "./assistant-research.ts";
import { z } from "zod";
import { notifyAssistant } from "./assistant-line.ts";
import { pollDrive } from "./drive.ts";
import { createApp } from "./app.ts";
import { D1Store, all } from "./db.ts";
import { makeAuth } from "./auth.ts";
import { cloudflareProvisioning } from "./cloudflare.ts";
import { runPending } from "./jobs.ts";
import { sendDue } from "./delivery.ts";
import { processEvents } from "./webhooks.ts";
import { AppError, requireThat } from "./security.ts";
import type { Runtime, Mail } from "./runtime.ts";
export interface Env {
  GS_SELF_DEMO_ENABLED?: string;
  ASSISTANT_LINE_ENABLED?: string;
  ASSISTANT_LINE_DESTINATION?: string;
  ASSISTANT_LINE_SECRET?: string;
  ASSISTANT_LINE_TOKEN?: string;
  ASSISTANT_FEEDS_JSON?: string;
  ASSISTANT_SEARCH_JSON?: string;
  ASSISTANT_RESEARCH_ENABLED?: string;
  ASSISTANT_NEWS_AUTHORIZATION_ENABLED?: string;
  ASSISTANT_RESEARCH_MODEL?: string;
  TIMEREX_WEBHOOK_SECRETS_JSON?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_PROPOSAL_NOTIFICATIONS?: string;
  OPENAI_API_KEY?: string;
  AI_MODEL?: string;
  AI_PRICING_JSON?: string;
  PLATFORM_DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  AUTH_SECRET: string;
  CREDENTIAL_KEY: string;
  CREDENTIAL_KEY_VERSION: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_PROVISION_TOKEN: string;
  WORKERS_SUBDOMAIN: string;
  RESEND_API_KEY: string;
  BREVO_API_KEY?: string;
  MAIL_FROM: string;
  GOOGLE_CLIENT_ID?: string;
  DRIVE_GOOGLE_CLIENT_ID?: string;
  DRIVE_GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PROVISIONING_ENABLED?: string;
  DELIVERY_ENABLED?: string;
  HARNESS_SERVICE?: Fetcher;
  TENANT_SERVICE?: Fetcher;
}
// Cloudflareのsecretはブラウザーへ渡さない。Google認証とLINE接続は独立して設定する。
export function makeWorkerRuntime(env: Env): Runtime {
  requireThat(
    env.APP_ORIGIN?.startsWith("https://") &&
      env.AUTH_SECRET?.length >= 32 &&
      env.CREDENTIAL_KEY,
    503,
    "ENV_NOT_READY",
    "サービスの初期設定を確認しています。",
  );
  const db = new D1Store(env.PLATFORM_DB);
  const sendMail = async (mail: Mail) => {
    requireThat(
      env.MAIL_FROM && (env.BREVO_API_KEY || env.RESEND_API_KEY),
      503,
      "MAIL_NOT_CONFIGURED",
      "ログイン用メールの配信設定が必要です。",
    );
    if (env.BREVO_API_KEY) {
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: "TSUNAGU", email: env.MAIL_FROM },
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.text,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        console.error(`[Brevo send failed] HTTP ${response.status}`);
        throw new AppError(
          503,
          "MAIL_DELIVERY_FAILED",
          `メールを送信できませんでした（Brevo HTTP ${response.status}）。`,
        );
      }
      return;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new AppError(
        503,
        "MAIL_DELIVERY_FAILED",
        "メールを送信できませんでした。少し待ってからお試しください。",
      );
  };
  const auth = makeAuth({
    database: env.PLATFORM_DB,
    db,
    origin: env.APP_ORIGIN,
    secret: env.AUTH_SECRET,
    googleId: env.GOOGLE_CLIENT_ID,
    googleSecret: env.GOOGLE_CLIENT_SECRET,
    sendMail,
    publicGoogleSignup: env.GS_SELF_DEMO_ENABLED === "true",
  });
  const feedConfig = parseAssistantProvider(env.ASSISTANT_FEEDS_JSON, false),
    searchConfig = parseAssistantProvider(env.ASSISTANT_SEARCH_JSON, true);
  const runtime: Runtime = {
    assistantResearchEnabled: env.ASSISTANT_RESEARCH_ENABLED === "true",
    assistantNewsAuthorizationEnabled:
      env.ASSISTANT_NEWS_AUTHORIZATION_ENABLED === "true",
    assistantResearchModel: env.ASSISTANT_RESEARCH_MODEL,
    assistantConfiguration: {
      line: {
        enabled: env.ASSISTANT_LINE_ENABLED === "true",
        destinationPresent: !!env.ASSISTANT_LINE_DESTINATION,
        secretPresent: !!env.ASSISTANT_LINE_SECRET,
        tokenPresent: !!env.ASSISTANT_LINE_TOKEN,
        valid: /^U[0-9a-f]{32}$/.test(env.ASSISTANT_LINE_DESTINATION || ""),
      },
      search: searchConfig.state,
      feed: feedConfig.state,
    },
    assistantLine:
      env.ASSISTANT_LINE_ENABLED === "true" &&
      env.ASSISTANT_LINE_DESTINATION &&
      env.ASSISTANT_LINE_SECRET &&
      env.ASSISTANT_LINE_TOKEN
        ? {
            enabled: true,
            destination: env.ASSISTANT_LINE_DESTINATION,
            secret: env.ASSISTANT_LINE_SECRET,
            token: env.ASSISTANT_LINE_TOKEN,
          }
        : undefined,
    assistantFeeds: feedConfig.config,
    assistantSearch: searchConfig.config as Runtime["assistantSearch"],
    mailMode:
      env.MAIL_FROM && (env.BREVO_API_KEY || env.RESEND_API_KEY)
        ? "provider"
        : "unconfigured",
    timerexSecrets: env.TIMEREX_WEBHOOK_SECRETS_JSON
      ? JSON.parse(env.TIMEREX_WEBHOOK_SECRETS_JSON)
      : undefined,
    slack:
      env.SLACK_PROPOSAL_NOTIFICATIONS === "true" &&
      env.APP_ORIGIN === "https://tsunagu-staging.shimoryo.workers.dev"
        ? env.SLACK_WEBHOOK_URL
          ? { webhookUrl: env.SLACK_WEBHOOK_URL }
          : env.SLACK_BOT_TOKEN
            ? { botToken: env.SLACK_BOT_TOKEN }
            : undefined
        : undefined,
    ai: env.OPENAI_API_KEY
      ? {
          apiKey: env.OPENAI_API_KEY,
          model: env.AI_MODEL || "gpt-4o-mini",
          prices: env.AI_PRICING_JSON
            ? JSON.parse(env.AI_PRICING_JSON)
            : undefined,
        }
      : undefined,
    db,
    auth,
    origin: env.APP_ORIGIN,
    key: env.CREDENTIAL_KEY,
    keyVersion: env.CREDENTIAL_KEY_VERSION || "v1",
    local: false,
    assistantManualOnly: false,
    provisioningEnabled: env.PROVISIONING_ENABLED === "true" && !!env.CLOUDFLARE_ACCOUNT_ID && !!env.CLOUDFLARE_PROVISION_TOKEN,
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    googleOAuth:
      (env.DRIVE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID) &&
      (env.DRIVE_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET)
        ? {
            clientId: (env.DRIVE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID)!,
            clientSecret: (env.DRIVE_GOOGLE_CLIENT_SECRET ||
              env.GOOGLE_CLIENT_SECRET)!,
          }
        : undefined,
    deliveryEnabled: env.DELIVERY_ENABLED === "true",
    sendMail,
    externalFetch: workerFetch((input, init) => {
      try {
        const urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        const u = new URL(urlStr);
        if (
          env.HARNESS_SERVICE &&
          (u.hostname === "enjin-line.shimoryo.workers.dev" ||
            u.hostname === `enjin-line.${env.WORKERS_SUBDOMAIN}.workers.dev`)
        ) {
          return env.HARNESS_SERVICE.fetch(input, init);
        }
        if (
          env.TENANT_SERVICE &&
          (u.hostname ===
            "tsunagu-tenant-a939c596-854a-4802-9511-cfb42b8176e9.shimoryo.workers.dev" ||
            u.hostname.startsWith("tsunagu-tenant-"))
        ) {
          return env.TENANT_SERVICE.fetch(input, init);
        }
      } catch {}
      return fetch(input, init);
    }),
    assets: env.ASSETS,
    async openDatabase() {
      throw new Error("Runtime adapter not initialized");
    },
    async provisionDatabase() {
      throw new Error("Runtime adapter not initialized");
    },
    async deployTenant() {
      throw new Error("Runtime adapter not initialized");
    },
  };
  const cloud = cloudflareProvisioning(runtime, {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_PROVISION_TOKEN,
    subdomain: env.WORKERS_SUBDOMAIN,
  });
  runtime.openDatabase = cachedDatabaseOpener(cloud.openDatabase);
  runtime.provisionDatabase = async (record) => {
    requireThat(
      env.PROVISIONING_ENABLED === "true",
      503,
      "PROVISIONING_DISABLED",
      "DB発行の有効化と接続確認が必要です。",
    );
    return cloud.provisionDatabase(record);
  };
  runtime.deployTenant = cloud.deployTenant;
  return runtime;
}
const app = createApp();
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await retainStaffWebhook(request, Promise.resolve(app.fetch(request, { runtime: makeWorkerRuntime(env) }, ctx)), ctx);
    } catch {
      return new Response("Service configuration is incomplete.", {
        status: 503,
      });
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        const rt = makeWorkerRuntime(env);
        await runPending(rt);
        const accounts = await assistantAccounts(rt);
        // Bounded round-robin OA work. Claim before reading or mutating the tenant queue.
        const deadline = Date.now() + 45000;
        await mapLimited(accounts, 2, async (oa) => {
          if (Date.now() > deadline) return;
          const lease = await claimAssistantOA(rt, oa.tenant_id, oa.id);
          if (!lease) return;
          let failed = false;
          try {
            await pollCalendars(rt,oa.tenant_id,oa.id);
            await pollDrive(rt,{tenant:oa.tenant_id,oa:oa.id});
            await processMeetingUpdates(rt,oa.tenant_id,oa.id);
            await syncPropertySheet(rt, oa.tenant_id, oa.id);
            await processEvents(rt, oa.tenant_id, oa.id);
            await processAssistantBurst(rt, oa.tenant_id, oa.id);
            await notifyAssistant(rt, oa.tenant_id, oa.id);
            if (env.DELIVERY_ENABLED === "true")
              await sendDue(rt, oa.tenant_id, oa.id);
            await refreshAssistantSources(rt, oa.tenant_id, oa.id);
            if (rt.assistantResearchEnabled && Date.now() < deadline)
              await runDailyResearch(rt, oa.tenant_id, oa.id);
          } catch {
            failed = true;
            console.error("Assistant OA processing deferred.");
          } finally {
            await finishAssistantOA(rt, oa.tenant_id, oa.id, lease, failed);
          }
        });

      })(),
    );
  },
};
