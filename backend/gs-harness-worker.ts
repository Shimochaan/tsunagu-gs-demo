import { D1Store } from "./db.ts";
import { gsHarnessFetch } from "./gs-harness.ts";
export interface GsHarnessEnv {
  GS_LINE_DB?: D1Database;
  GS_SELF_DEMO_ENABLED?: string;
  GS_HARNESS_ENABLED?: string;
  GS_LINE_ACCOUNT_ID?: string;
  GS_LINE_CHANNEL_ID?: string;
  GS_LINE_DESTINATION?: string;
  GS_HARNESS_API_TOKEN?: string;
  GS_LINE_CHANNEL_SECRET?: string;
  GS_LINE_CHANNEL_ACCESS_TOKEN?: string;
}
export default {
  async fetch(request: Request, env: GsHarnessEnv) {
    return gsHarnessFetch(
      request,
      env.GS_LINE_DB ? new D1Store(env.GS_LINE_DB) : undefined,
      {
        enabled: env.GS_HARNESS_ENABLED === "true",
        selfDemo: env.GS_SELF_DEMO_ENABLED === "true",
        accountId: env.GS_LINE_ACCOUNT_ID,
        channelId: env.GS_LINE_CHANNEL_ID,
        destination: env.GS_LINE_DESTINATION,
        apiToken: env.GS_HARNESS_API_TOKEN,
        channelSecret: env.GS_LINE_CHANNEL_SECRET,
        channelAccessToken: env.GS_LINE_CHANNEL_ACCESS_TOKEN,
      },
    );
  },
};
