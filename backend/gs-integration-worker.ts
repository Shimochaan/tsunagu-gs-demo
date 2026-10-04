import { runValueLoop } from "./assistant-value-loop.ts";
import { loginBootstrapResponse } from "./gs-login-bootstrap.ts";
import { makeWorkerRuntime, type Env } from "./worker.ts";
import {
  isolatedIntegrationRuntime,
  parseStaffTestUsers,
} from "./gs-integration.ts";
import { D1Store } from "./db.ts";
import { createApp } from "./app.ts";
import { retainStaffWebhook } from "./webhook-lifetime.ts";

export interface IntegrationEnv extends Env {
  GS_DEMO_TIMEREX_URL?: string;
  GS_DEMO_TIMEREX_SECRET?: string;
  GS_SELF_DEMO_CAPACITY?: string;
  GS_DEMO_OPERATOR_AI_LIMIT?: string;
  GS_DEMO_TOTAL_AI_LIMIT?: string;
  GS_RUNTIME_ENABLED?: string;
  GS_AUTOMATION_ENABLED?: string;
  GS_ALLOW_RESEARCH?: string;
  GS_RESEARCH_HOSTS_JSON?: string;
  GS_TENANT_ID: string;
  GS_OA_ID: string;
  GS_COMMON_DB: D1Database;
  GS_HARNESS_DB: D1Database;
  GS_STUDIO_DB: D1Database;
  GS_ALLOW_GOOGLE?: string;
  GS_ALLOW_OPENAI?: string;
  GS_ALLOW_NEWS_ARCHIVE?: string;
  GS_HARNESS_ORIGIN?: string;
  GS_HARNESS_SERVICE?: Fetcher;
  GS_ALLOW_STAFF_LINE?: string;
  GS_STAFF_LINE_TEST_USERS_JSON?: string;
  GS_CUSTOMER_LINE_DESTINATION?: string;
  GS_ALLOW_CUSTOMER_DELIVERY?: string;
  GS_CUSTOMER_LINE_CHANNEL_ID?: string;
  GS_CUSTOMER_LINE_TOKEN?: string;
  GS_CUSTOMER_LINE_TEST_USERS_JSON?: string;
}
function integrationRuntime(env:IntegrationEnv) {
    // Drop unused secrets before constructing auth/providers; makeAuth closes over sendMail.
    const safeEnv: Env = {
      ...env,
      DELIVERY_ENABLED: "false",
      PROVISIONING_ENABLED: "false",
      ASSISTANT_LINE_ENABLED:
        env.GS_ALLOW_STAFF_LINE === "true"
          ? env.ASSISTANT_LINE_ENABLED
          : "false",
      SLACK_PROPOSAL_NOTIFICATIONS: "false",
      ASSISTANT_FEEDS_JSON: undefined,
      ASSISTANT_SEARCH_JSON: undefined,
      TIMEREX_WEBHOOK_SECRETS_JSON: undefined,
      RESEND_API_KEY: "",
      BREVO_API_KEY: undefined,
      MAIL_FROM: "",
      HARNESS_SERVICE: undefined,
      TENANT_SERVICE: undefined,
      CLOUDFLARE_PROVISION_TOKEN: "",
    };
    return isolatedIntegrationRuntime(makeWorkerRuntime(safeEnv), {
      selfDemo: env.GS_SELF_DEMO_ENABLED === "true",
      demoTimeRexUrl: env.GS_DEMO_TIMEREX_URL,
      demoTimeRexSecret: env.GS_DEMO_TIMEREX_SECRET,
      demoOperatorAILimit: Math.max(12,Math.min(1000,Number(env.GS_DEMO_OPERATOR_AI_LIMIT)||12)),
      demoTotalAILimit: Math.max(120,Math.min(5000,Number(env.GS_DEMO_TOTAL_AI_LIMIT)||120)),
      demoCapacity: Math.max(1,Math.min(100,Number(env.GS_SELF_DEMO_CAPACITY)||10)),
      tenant: env.GS_TENANT_ID,
      oa: env.GS_OA_ID,
      common: new D1Store(env.GS_COMMON_DB),
      harness: new D1Store(env.GS_HARNESS_DB),
      tsunagu: new D1Store(env.GS_STUDIO_DB),
      allowAutomation: env.GS_AUTOMATION_ENABLED === "true",
      allowResearch: env.GS_ALLOW_RESEARCH === "true",
      researchHosts: JSON.parse(env.GS_RESEARCH_HOSTS_JSON || "[]"),
      allowGoogle: env.GS_ALLOW_GOOGLE === "true",
      allowOpenAI: env.GS_ALLOW_OPENAI === "true",
      allowNewsArchive: env.GS_ALLOW_NEWS_ARCHIVE === "true",
      harnessOrigin: env.GS_HARNESS_ORIGIN,
      harnessFetch: env.GS_HARNESS_SERVICE
        ? (request) => env.GS_HARNESS_SERVICE!.fetch(request)
        : undefined,
      allowStaffLine: env.GS_ALLOW_STAFF_LINE === "true",
      staffLineTestUsers: parseStaffTestUsers(
        env.GS_STAFF_LINE_TEST_USERS_JSON,
      ),
      customerLineDestination: env.GS_CUSTOMER_LINE_DESTINATION,
      allowCustomerDelivery: env.GS_ALLOW_CUSTOMER_DELIVERY === "true",
      customerLineChannelId: env.GS_CUSTOMER_LINE_CHANNEL_ID,
      customerLineToken: env.GS_CUSTOMER_LINE_TOKEN,
      customerLineTestUsers: parseStaffTestUsers(
        env.GS_CUSTOMER_LINE_TEST_USERS_JSON,
      ),
      staffLineDestination: env.ASSISTANT_LINE_DESTINATION,
    });
}
const app = createApp();
// Scheduled preparation is opt-in; this handler never dispatches customer messages.
export default {
  async scheduled(_event:ScheduledController,env:IntegrationEnv,ctx:ExecutionContext) {
    if(env.GS_RUNTIME_ENABLED !== "true" || env.GS_AUTOMATION_ENABLED !== "true") return;
    ctx.waitUntil(runValueLoop(integrationRuntime(env),env.GS_TENANT_ID,env.GS_OA_ID));
  },
  async fetch(request: Request, env: IntegrationEnv, ctx?: ExecutionContext) {
    if (
      env.GS_RUNTIME_ENABLED !== "true" ||
      !env.PLATFORM_DB ||
      !env.GS_COMMON_DB ||
      !env.GS_HARNESS_DB ||
      !env.GS_STUDIO_DB ||
      !env.GS_TENANT_ID ||
      !env.GS_OA_ID ||
      !env.AUTH_SECRET ||
      !env.CREDENTIAL_KEY
    )
      return loginBootstrapResponse(request, env);
    const runtime = integrationRuntime(env);
    const path = new URL(request.url).pathname;
    // Scoped signed staff webhook and authenticated TimeRex receipts only.
    if (
      /^\/(?:api\/)?webhooks(?:\/|$)/.test(path) &&
      !(path === "/webhooks/staff-line" && runtime.staffLineTestScope) && !(env.GS_AUTOMATION_ENABLED==="true" && path===`/webhooks/timerex/${env.GS_OA_ID}`)
    )
      return new Response(null, { status: 404 });
    const requestedTenant = path.match(/^\/api\/tenants\/([^/]+)/)?.[1];
    if (requestedTenant && requestedTenant !== env.GS_TENANT_ID)
      return new Response(null, { status: 404 });
    return retainStaffWebhook(request, Promise.resolve(app.fetch(request, { runtime }, ctx)), ctx);
  },
};
