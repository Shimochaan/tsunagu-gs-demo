import type { Database, Row } from "./db.ts";
import type { Purpose } from "./schema.ts";
import type { makeAuth } from "./auth.ts";
export interface Mail {
  to: string;
  subject: string;
  text: string;
}
import type { StaffPushAdapter } from "./proposal-events.ts";
import type { CustomerTestDelivery } from "./customer-test-delivery.ts";
export interface Runtime {
  selfDemo?: { tenant: string; oa: string; capacity: number; timerexUrl?: string };
  assistantSimulation?: boolean;
  assistantManualOnly?: boolean;
  provisioningEnabled?: boolean;
  customerTestDelivery?: CustomerTestDelivery;
  harnessReadOnly?: boolean;
  assistantResearchEnabled?: boolean;
  assistantNewsAuthorizationEnabled?: boolean;
  assistantResearchModel?: string;
  assistantResearchManualOnly?: boolean;
  driveManualOnly?: boolean;
  staffLineTestScope?: {
    tenant: string;
    lineUserIds: string[];
    replyTokens: Set<string>;
  };
  staffPush?: StaffPushAdapter;
  assistantConfiguration?: {
    line: {
      enabled: boolean;
      destinationPresent: boolean;
      secretPresent: boolean;
      tokenPresent: boolean;
      valid: boolean;
    };
    search: "missing" | "invalid" | "configured";
    feed: "missing" | "invalid" | "configured";
  };
  assistantLine?: {
    destination: string;
    secret: string;
    token: string;
    enabled: boolean;
  };
  assistantFeeds?: Record<string, { url: string; token?: string }>;
  assistantSearch?: Record<
    string,
    { url: string; token?: string; allowedHosts: string[] }
  >;
  mailMode?: "provider" | "local" | "unconfigured";
  timerexSecrets?: Record<string, string>;
  slack?:
    | { botToken: string; webhookUrl?: never }
    | { webhookUrl: string; botToken?: never };
  ai?: {
    apiKey: string;
    model: string;
    prices?: {
      inputUsdPerMillion: number;
      cachedUsdPerMillion: number;
      outputUsdPerMillion: number;
      version: string;
    };
  };
  db: Database;
  auth: ReturnType<typeof makeAuth>;
  origin: string;
  key: string;
  keyVersion: string;
  local: boolean;
  googleEnabled: boolean;
  googleOAuth?: { clientId: string; clientSecret: string };
  deliveryEnabled?: boolean;
  sendMail(mail: Mail): Promise<void>;
  openDatabase(tenant: string, oa: string, purpose: Purpose): Promise<Database>;
  provisionDatabase(record: Row): Promise<string>;
  deployTenant(tenant: string): Promise<void>;
  externalFetch: typeof fetch;
  assets?: { fetch(request: Request): Promise<Response> };
}
export interface Principal {
  user: { id: string; email: string; name: string };
  sessionId: string;
  tenantId: string | null;
  opsRole: string | null;
  mfa: boolean;
}
export type AppEnv = {
  Bindings: { runtime: Runtime };
  Variables: { principal: Principal; membership: Row; tenant: Row };
};
