import { demoStaffAllowed } from "./self-demo-access.ts";
import type { Runtime } from "./runtime.ts";
import { one, json, now, type Database } from "./db.ts";
import { requireThat } from "./security.ts";
import { customerTestDelivery } from "./customer-test-delivery.ts";

export interface IntegrationScope {
  selfDemo?: boolean;
  demoCapacity?: number;
  demoTimeRexUrl?: string;
  demoTimeRexSecret?: string;
  tenant: string;
  oa: string;
  common: Database;
  harness: Database;
  tsunagu: Database;
  allowAutomation?: boolean;
  allowResearch?: boolean;
  researchHosts?: string[];
  allowGoogle?: boolean;
  allowOpenAI?: boolean;
  allowNewsArchive?: boolean;
  harnessOrigin?: string;
  harnessFetch?: (request: Request) => Promise<Response>;
  allowStaffLine?: boolean;
  staffLineTestUsers?: string[];
  customerLineDestination?: string;
  allowCustomerDelivery?: boolean;
  customerLineChannelId?: string;
  customerLineToken?: string;
  customerLineTestUsers?: string[];
  staffLineDestination?: string;
}
export function parseStaffTestUsers(value?: string): string[] {
  try {
    const ids = JSON.parse(value || "[]");
    return Array.isArray(ids) &&
      ids.length <= 20 &&
      ids.every((id) => typeof id === "string" && /^U[0-9a-f]{32}$/.test(id))
      ? [...new Set<string>(ids)]
      : [];
  } catch {
    return [];
  }
}
// Outbound delivery requires separate explicit tester scopes. Generic customer requests stay blocked.
export function isolatedIntegrationRuntime(
  rt: Runtime,
  scope: IntegrationScope,
): Runtime {
  requireThat(
    scope.tenant && scope.oa,
    503,
    "INTEGRATION_SCOPE_REQUIRED",
    "検証用の企業・アカウントを設定してください。",
  );
  const blocked = async (): Promise<never> => {
    requireThat(
      false,
      403,
      "INTEGRATION_ACTION_DISABLED",
      "この検証環境では外部送信・環境作成を停止しています。",
    );
    throw new Error("unreachable");
  };
  if (scope.harnessOrigin) {
    const u = new URL(scope.harnessOrigin);
    requireThat(
      u.protocol === "https:" &&
        u.origin === scope.harnessOrigin &&
        /^tsunagu-gs-harness\.[a-z0-9-]+\.workers\.dev$/.test(u.hostname) &&
        !u.username &&
        !u.password,
      503,
      "INTEGRATION_HARNESS_ORIGIN",
      "専用HarnessのHTTPS originを指定してください。",
    );
  }
  if (scope.demoTimeRexUrl) {
    const u = new URL(scope.demoTimeRexUrl);
    requireThat(
      u.origin === "https://timerex.net" &&
        /^\/s\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9]+\/?$/.test(u.pathname) &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password,
      503,
      "DEMO_TIMEREX_URL",
      "体験用のTimeRex予約URLを確認してください。",
    );
  }
  const testers = parseStaffTestUsers(
    JSON.stringify(scope.staffLineTestUsers || []),
  );
  const staffLine =
    scope.allowStaffLine &&
    (testers.length || scope.selfDemo) &&
    rt.assistantLine?.enabled &&
    !!rt.assistantLine.secret &&
    !!rt.assistantLine.token &&
    /^U[0-9a-f]{32}$/.test(rt.assistantLine.destination) &&
    /^U[0-9a-f]{32}$/.test(scope.customerLineDestination || "") &&
    rt.assistantLine.destination !== scope.customerLineDestination
      ? rt.assistantLine
      : undefined;
  const testScope = staffLine
    ? {
        tenant: scope.tenant,
        lineUserIds: testers,
        replyTokens: new Set<string>(),
      }
    : undefined;
  const providerFetch = rt.externalFetch;
  const customerDelivery = customerTestDelivery(
    {
      tenant: scope.tenant,
      oa: scope.oa,
      enabled: scope.allowCustomerDelivery,
      selfDemo: scope.selfDemo,
      channelId: scope.customerLineChannelId,
      destination: scope.customerLineDestination,
      staffDestination: scope.staffLineDestination,
      token: scope.customerLineToken,
      lineUserIds: parseStaffTestUsers(
        JSON.stringify(scope.customerLineTestUsers || []),
      ),
    },
    providerFetch,
  );
  const demoRuntime: Runtime = {
    ...rt,
    assistantLine: staffLine,
    selfDemo: scope.selfDemo
      ? {
          tenant: scope.tenant,
          oa: scope.oa,
          capacity: scope.demoCapacity || 10,
          timerexUrl: scope.demoTimeRexUrl,
        }
      : undefined,
  };
  const externalFetch: typeof fetch = async (input, init) => {
    // workerd rejects redirect:"error" in the constructor. Normalize before
    // constructing, not only before fetch; the status guard below rejects 3xx.
    const request = new Request(input, { ...init, redirect: "manual" }),
      u = new URL(request.url),
      method = request.method;
    const googleRead =
      scope.allowGoogle &&
      method === "GET" &&
      ((u.origin === "https://www.googleapis.com" &&
        (/^\/drive\/v3\/files(?:\/|$)/.test(u.pathname) ||
          /^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(u.pathname))) ||
        (u.origin === "https://sheets.googleapis.com" &&
          u.pathname.startsWith("/v4/spreadsheets/")) ||
        (u.origin === "https://openidconnect.googleapis.com" &&
          u.pathname === "/v1/userinfo"));
    let googleSheetWrite = false;
    if(scope.allowGoogle && scope.selfDemo && u.origin==='https://sheets.googleapis.com' && ['POST','PUT'].includes(method)) {
      const match=u.pathname.match(/^\/v4\/spreadsheets\/([\w-]+)\/values\/(.+)$/);
      const range=match ? decodeURIComponent(match[2]) : '';
      const allowedRange=method==='POST' ? range==="'物件台帳'!A1:R1001:append" && u.searchParams.get('insertDataOption')==='INSERT_ROWS' : /^'物件台帳'!A([2-9]|[1-9][0-9]{1,2}|100[01]):R\1$/.test(range);
      const body=await request.clone().json().catch(()=>null) as any;
      if(match && allowedRange && u.searchParams.get('valueInputOption')==='RAW' && body?.majorDimension==='ROWS' && body.values?.length===1 && body.values[0]?.length===18) {
        const row=body.values[0];
        googleSheetWrite=!!await one(scope.tsunagu,"SELECT j.source_id FROM demo_sheet_writes j JOIN assistant_google_config c ON c.id='default' AND c.version=j.config_version WHERE j.spreadsheet_id=? AND json_extract(c.data,'$.spreadsheetId')=? AND j.source_id=? AND j.row_json=? AND j.state='sending' AND j.lease_until>?",[match[1],match[1],String(row[0]),json(row),now()]);
      }
    }
    const googleToken =
      scope.allowGoogle &&
      method === "POST" &&
      u.origin === "https://oauth2.googleapis.com" &&
      u.pathname === "/token";
    const archive =
      scope.allowGoogle &&
      scope.allowNewsArchive &&
      method === "POST" &&
      u.origin === "https://www.googleapis.com" &&
      ["/drive/v3/files", "/upload/drive/v3/files"].includes(u.pathname);
    const ai =
      scope.allowOpenAI &&
      method === "POST" &&
      u.origin === "https://api.openai.com" &&
      ["/v1/responses", "/v1/chat/completions"].includes(u.pathname);
    const researchRead =
      scope.allowResearch &&
      method === "GET" &&
      u.protocol === "https:" &&
      (!u.port || u.port === "443") &&
      (scope.researchHosts || []).some(
        (h) => u.hostname === h || u.hostname.endsWith(`.${h}`),
      );
    const harnessRead =
      scope.harnessOrigin &&
      u.origin === scope.harnessOrigin &&
      method === "GET" &&
      u.pathname.startsWith("/api/");
    let staffSend = false;
    if (
      staffLine &&
      testScope &&
      u.origin === "https://api.line.me" &&
      method === "POST" &&
      request.headers.get("Authorization") === `Bearer ${staffLine.token}` &&
      ["/v2/bot/message/push", "/v2/bot/message/reply"].includes(u.pathname)
    ) {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as any;
      staffSend =
        !!body &&
        (u.pathname.endsWith("/push")
          ? testers.includes(body.to) ||
            (await demoStaffAllowed(demoRuntime, body.to))
          : typeof body.replyToken === "string" &&
            testScope.replyTokens.delete(body.replyToken));
    }
    requireThat(
      !u.username &&
        !u.password &&
        (googleRead ||
          googleSheetWrite ||
          googleToken ||
          archive ||
          researchRead ||
          ai ||
          harnessRead ||
          staffSend),
      403,
      "INTEGRATION_NETWORK_DISABLED",
      "この接続先・操作は検証環境で許可されていません。",
    );
    if (staffSend) {
      const info = await providerFetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${staffLine!.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      requireThat(
        info.ok &&
          ((await info.json()) as any).userId === staffLine!.destination,
        409,
        "STAFF_BOT_MISMATCH",
        "担当者用トークンの公式LINEが設定と一致しません。送信を停止しました。",
      );
    }
    // Never follow a provider redirect with bearer credentials to a different destination.
    const outgoing = new Request(request, { redirect: "manual" });
    // Same-account workers.dev requests need a service binding. Keep this
    // dispatch after the origin/method gate and retain Harness bearer auth.
    const response =
      harnessRead && scope.harnessFetch
        ? await scope.harnessFetch(outgoing)
        : await providerFetch(outgoing);
    requireThat(
      response.status < 300 || response.status >= 400,
      502,
      "INTEGRATION_REDIRECT_BLOCKED",
      "接続先の転送を停止しました。",
    );
    return response;
  };
  return {
    ...rt,
    selfDemo: demoRuntime.selfDemo,
    deliveryEnabled: customerDelivery.enabled,
    customerTestDelivery: customerDelivery,
    harnessReadOnly: true,
    assistantResearchManualOnly: !scope.allowAutomation,
    assistantSimulation: true,
    driveManualOnly: !scope.allowAutomation,
    assistantLine: staffLine,
    staffLineTestScope: testScope,
    staffPush: undefined,
    slack: undefined,
    timerexSecrets:
      scope.selfDemo && scope.demoTimeRexSecret
        ? { [scope.oa]: scope.demoTimeRexSecret }
        : undefined,
    assistantFeeds: undefined,
    assistantSearch: undefined,
    assistantConfiguration: {
      line: {
        enabled: !!staffLine,
        destinationPresent: !!staffLine,
        secretPresent: !!staffLine,
        tokenPresent: !!staffLine,
        valid: !!staffLine,
      },
      search: "missing",
      feed: "missing",
    },
    assistantResearchEnabled:
      !!scope.allowGoogle &&
      !!scope.allowOpenAI &&
      !!(scope.allowNewsArchive || scope.allowResearch) &&
      !!rt.assistantResearchEnabled,
    assistantNewsAuthorizationEnabled:
      !!scope.allowGoogle &&
      !!scope.allowNewsArchive &&
      !!rt.assistantNewsAuthorizationEnabled,
    ai: scope.allowOpenAI ? rt.ai : undefined,
    googleOAuth: scope.allowGoogle ? rt.googleOAuth : undefined,
    mailMode: "unconfigured",
    assistantManualOnly: !scope.allowAutomation,
    provisioningEnabled: false,
    sendMail: blocked,
    provisionDatabase: blocked,
    deployTenant: blocked,
    externalFetch,
    async openDatabase(tenant, oa, purpose) {
      requireThat(
        tenant === scope.tenant &&
          (purpose === "common" ? oa === "" : oa === scope.oa) &&
          ["common", "harness", "tsunagu"].includes(purpose),
        403,
        "INTEGRATION_DATABASE_SCOPE",
        "検証対象外のデータベースにはアクセスできません。",
      );
      return scope[purpose as "common" | "harness" | "tsunagu"];
    },
  };
}
