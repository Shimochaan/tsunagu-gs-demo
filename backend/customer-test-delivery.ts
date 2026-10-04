import { formatJstDateTime } from "./booking.ts";
import { claimStaffDaily } from "./assistant-notifications.ts";
import { demoCustomerAllowed, demoParticipant } from "./self-demo-access.ts";
import type { Runtime, AppEnv } from "./runtime.ts";
import type { Hono } from "hono";
import { one, now, parse, json, type Row } from "./db.ts";
import { requireThat, digest, audit } from "./security.ts";
import { assistantAccess, assistantDeliveryGuard } from "./assistant.ts";
import { guard } from "./sales.ts";
import { googleAdmin } from "./assistant-google-store.ts";
import { getCredential } from "./credentials.ts";
import { harnessRequest } from "./harness.ts";

export interface CustomerTestDelivery {
  configured: boolean;
  enabled: boolean;
  testerCount: number;
  dailyLimit: number;
  allows(
    lineUserId: string,
    rt?: Runtime,
    actor?: string,
    customer?: string,
  ): boolean | Promise<boolean>;
  sendDemoBooking?(
    rt: Runtime,
    actor: string,
    bookingId: string,
    version: number,
  ): Promise<void>;
  sendShowcaseDraft?(rt:Runtime,actor:string,requestId:string,text:string):Promise<{state:'accepted'}>;
  verify(rt: Runtime, tenant: string, oa: string, actor: string): Promise<void>;
  send(
    rt: Runtime,
    tenant: string,
    oa: string,
    item: Row,
    onDispatch: () => void,
  ): Promise<{ messageId: string }>;
}
export interface CustomerTestConfig {
  tenant: string;
  oa: string;
  enabled?: boolean;
  selfDemo?: boolean;
  channelId?: string;
  destination?: string;
  staffDestination?: string;
  token?: string;
  lineUserIds: string[];
}
const dayJST = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const lineId = /^U[0-9a-f]{32}$/;

// The transport is a closed-over capability: the general externalFetch gate still rejects
// all customer LINE requests. Only this approved-text path can use the customer token.
export function customerTestDelivery(
  config: CustomerTestConfig,
  transport: typeof fetch,
): CustomerTestDelivery {
  const configured =
    !!config.token &&
    /^\d{5,20}$/.test(config.channelId || "") &&
    lineId.test(config.destination || "") &&
    lineId.test(config.staffDestination || "") &&
    config.destination !== config.staffDestination &&
    (config.lineUserIds.length > 0 || config.selfDemo === true) &&
    config.lineUserIds.length <= 20 &&
    config.lineUserIds.every((id) => lineId.test(id));
  const enabled = configured && !!config.enabled;
  const scope = (tenant: string, oa: string) =>
    requireThat(
      configured && tenant === config.tenant && oa === config.oa,
      409,
      "CUSTOMER_TEST_NOT_CONFIGURED",
      "顧客テスト送信のアカウント・許可リスト・接続設定を確認してください。",
    );
  const bot = async () => {
    const response = await transport("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    requireThat(
      response.ok,
      502,
      "CUSTOMER_BOT_VERIFY_FAILED",
      "顧客用LINEトークンを確認できません。送信していません。",
    );
    const data = (await response.json()) as any;
    requireThat(
      data.userId === config.destination,
      409,
      "CUSTOMER_BOT_MISMATCH",
      "トークンの公式LINEが顧客用の設定と一致しません。送信していません。",
    );
  };
  const account = async (rt: Runtime, tenant: string, oa: string) => {
    const row = await one(
      rt.db,
      "SELECT * FROM accounts WHERE tenant_id=? AND id=?",
      [tenant, oa],
    );
    requireThat(
      row?.channel_id === config.channelId &&
        (!row.destination || row.destination === config.destination),
      409,
      "CUSTOMER_ACCOUNT_CHANGED",
      "登録済みの顧客チャネルと送信設定が一致しません。",
    );
    return row!;
  };
  return {
    configured,
    enabled,
    testerCount: configured ? config.lineUserIds.length : 0,
    dailyLimit: config.selfDemo ? 8 : 5,
    allows: (line, rt, actor, customer) =>
      configured &&
      (config.lineUserIds.includes(line) ||
        (!!rt &&
          !!config.selfDemo &&
          demoCustomerAllowed(rt, line, actor, customer))),
    async sendShowcaseDraft(rt,actor,requestId,text){
      requireThat(enabled && config.selfDemo && rt.selfDemo,403,'DEMO_SEND_DISABLED','実LINE送信は停止中です。');
      requireThat(/^[0-9a-f-]{36}$/i.test(requestId) && text.trim().length>0 && text.length<=2000,400,'INVALID_DRAFT','文面は1〜2,000文字で入力してください。');
      const p=await demoParticipant(rt,actor);
      requireThat(p?.state==='active' && await demoCustomerAllowed(rt,p.customer_line_id,actor,p.customer_id),409,'DEMO_LINE_REQUIRED','顧客用LINEの本人確認を完了してください。');
      scope(p.tenant_id,config.oa);
      const accountRow=await account(rt,p.tenant_id,config.oa);
      requireThat(accountRow.state==='ready',409,'DEMO_LINE_NOT_READY','顧客用LINEが未接続です。');
      const attemptId=`showcase:${actor}:${requestId}`,bodyHash=await digest(text);
      const previous=await one(rt.db,'SELECT state,body_hash,line_user_id FROM gs_customer_line_attempts WHERE id=?',[attemptId]);
      if(previous){
        requireThat(previous.body_hash===bodyHash && previous.line_user_id===p.customer_line_id,409,'DRAFT_CHANGED','送信確認後に文面または本人連携が変わっています。');
        requireThat(previous.state==='accepted',409,'DEMO_SEND_UNCERTAIN','送信中、または送信結果が未確認です。重複を防ぐため再送しません。LINEのトークを確認してください。');
        return {state:'accepted'};
      }
      const cred=await getCredential(rt,p.tenant_id,config.oa,'harness');
      const friend=await harnessRequest(rt,cred,'/api/friends/'+encodeURIComponent(p.friend_id));
      requireThat(friend.isFollowing && friend.lineUserId===p.customer_line_id,409,'DEMO_UNFOLLOWED','顧客用LINEを友だち追加してください。');
      await bot();
      const common=await rt.openDatabase(p.tenant_id,'','common');
      const customer=await one(common,"SELECT c.opt_out FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE c.id=? AND c.owner_user_id=? AND l.oa_id=? AND l.line_user_id=? AND l.state='confirmed'",[p.customer_id,actor,config.oa,p.customer_line_id]);
      requireThat(customer && !customer.opt_out && await demoCustomerAllowed(rt,p.customer_line_id,actor,p.customer_id),409,'DEMO_LINK_CHANGED','本人連携・配信設定が変わっています。');
      const at=now(),day=dayJST(),retryKey=crypto.randomUUID();
      const claim=await rt.db.query("INSERT OR IGNORE INTO gs_customer_line_attempts(id,tenant_id,oa_id,line_user_id,body_hash,retry_key,day,state,created_at) SELECT ?,?,?,?,?,?,?,'sending',? WHERE (SELECT COUNT(*) FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=? AND line_user_id=?)<8 AND (SELECT COUNT(*) FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=?)<240",[attemptId,p.tenant_id,config.oa,p.customer_line_id,bodyHash,retryKey,day,at,p.tenant_id,config.oa,day,p.customer_line_id,p.tenant_id,config.oa,day]);
      requireThat(claim.changes,409,'DEMO_SEND_LIMIT','送信中、または本日の送信上限（本人宛8通）です。');
      try{
        const response=await transport('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','X-Line-Retry-Key':retryKey},body:json({to:p.customer_line_id,messages:[{type:'text',text}]}),redirect:'manual',signal:AbortSignal.timeout(15000)});
        requireThat(response.ok || response.status===409 && !!response.headers.get('x-line-accepted-request-id'),502,'DEMO_SEND_UNKNOWN','送信結果を確認できません。LINEのトークを確認してください。重複を防ぐため再送しません。');
        await rt.db.query("UPDATE gs_customer_line_attempts SET state='accepted' WHERE id=?",[attemptId]);
      }catch(error){await rt.db.query("UPDATE gs_customer_line_attempts SET state='uncertain' WHERE id=?",[attemptId]);throw error;}
      await audit(rt.db,actor,'demo.showcase.sent',requestId,p.tenant_id,{characters:text.length});
      return {state:'accepted'};
    },
    async sendDemoBooking(rt, actor, bookingId, version) {
      requireThat(
        enabled && config.selfDemo && rt.selfDemo,
        403,
        "BOOKING_DISABLED",
        "予約通知は停止中です。",
      );
      const p = await demoParticipant(rt, actor),
        b = await one(
          rt.db,
          "SELECT * FROM gs_demo_bookings WHERE id=? AND user_id=? AND version=?",
          [bookingId, actor, version],
        );
      requireThat(
        p?.state === "active" &&
          b?.notice_state === "pending" &&
          (await demoCustomerAllowed(
            rt,
            p.customer_line_id,
            actor,
            p.customer_id,
          )),
        409,
        "BOOKING_CHANGED",
        "予約または本人連携が変更されました。",
      );
      scope(p.tenant_id, config.oa);
      const accountRow = await account(rt, p.tenant_id, config.oa);
      requireThat(
        accountRow.state === "ready",
        409,
        "BOOKING_NOT_READY",
        "顧客用LINEが未接続です。",
      );
      const cred = await getCredential(rt, p.tenant_id, config.oa, "harness"),
        friend = await harnessRequest(
          rt,
          cred,
          "/api/friends/" + encodeURIComponent(p.friend_id),
        );
      requireThat(
        friend.isFollowing && friend.lineUserId === p.customer_line_id,
        409,
        "BOOKING_UNFOLLOWED",
        "顧客用LINEを友だち追加してください。",
      );
      await bot();
      const common = await rt.openDatabase(p.tenant_id, "", "common");
      const liveCustomer = await one(
        common,
        "SELECT c.opt_out FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE c.id=? AND c.owner_user_id=? AND l.oa_id=? AND l.line_user_id=? AND l.state='confirmed'",
        [p.customer_id, actor, config.oa, p.customer_line_id],
      );
      requireThat(
        liveCustomer &&
          !liveCustomer.opt_out &&
          (await demoCustomerAllowed(
            rt,
            p.customer_line_id,
            actor,
            p.customer_id,
          )),
        409,
        "BOOKING_LINK_CHANGED",
        "本人連携・配信状態が変わりました。",
      );
      const at = now(),
        day = dayJST(),
        attemptId = "booking:" + b.retry_key;
      const claims = await rt.db.batch([
        {
          sql: "INSERT OR IGNORE INTO gs_customer_line_attempts(id,tenant_id,oa_id,line_user_id,body_hash,retry_key,day,state,created_at) SELECT ?,?,?,?,?,?,?,'sending',? WHERE (SELECT COUNT(*) FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=? AND line_user_id=?)<8 AND (SELECT COUNT(*) FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=?)<240",
          params: [
            attemptId,
            p.tenant_id,
            config.oa,
            p.customer_line_id,
            await digest(
              json({ startsAt: b.starts_at, state: b.state, version }),
            ),
            b.retry_key,
            day,
            at,
            p.tenant_id,
            config.oa,
            day,
            p.customer_line_id,
            p.tenant_id,
            config.oa,
            day,
          ],
        },
        {
          sql: "UPDATE gs_demo_bookings SET notice_state='sending' WHERE id=? AND version=? AND notice_state='pending' AND EXISTS(SELECT 1 FROM gs_customer_line_attempts WHERE id=? AND state='sending')",
          params: [bookingId, version, attemptId],
        },
      ]);
      requireThat(
        claims[0].changes && claims[1].changes,
        409,
        "BOOKING_SEND_LIMIT",
        "通知済み、または本日の送信上限です。",
      );
      const text = `【体験用・${b.state === "cancelled" ? "予約取消" : version === 1 ? "予約完了" : "予約変更"}】\n住まい相談：${formatJstDateTime(b.starts_at)}\n${b.state === "cancelled" ? "予約を取り消しました。" : "ご希望の日時で体験予約を受け付けました。"}\n${b.source === "timerex" ? "TimeRexの予約として記録しました。体験後に予約を取り消してください。" : "実際の接客・内見は行いません。"}${b.source === "timerex" && b.details_url ? "\n予約の確認・取消：" + b.details_url : ""}`;
      try {
        const response = await transport(
          "https://api.line.me/v2/bot/message/push",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.token}`,
              "Content-Type": "application/json",
              "X-Line-Retry-Key": b.retry_key,
            },
            body: json({
              to: p.customer_line_id,
              messages: [{ type: "text", text }],
            }),
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
          },
        );
        requireThat(
          response.ok ||
            (response.status === 409 &&
              !!response.headers.get("x-line-accepted-request-id")),
          502,
          "BOOKING_SEND_UNKNOWN",
          "送信結果を確認できません。再送しません。",
        );
        await rt.db.batch([
          {
            sql: "UPDATE gs_customer_line_attempts SET state='accepted' WHERE id=?",
            params: [attemptId],
          },
          {
            sql: "UPDATE gs_demo_bookings SET notice_state='accepted' WHERE id=? AND version=?",
            params: [bookingId, version],
          },
        ]);
      } catch (e) {
        await rt.db.batch([
          {
            sql: "UPDATE gs_customer_line_attempts SET state='uncertain' WHERE id=?",
            params: [attemptId],
          },
          {
            sql: "UPDATE gs_demo_bookings SET notice_state='uncertain' WHERE id=? AND version=?",
            params: [bookingId, version],
          },
        ]);
        throw e;
      }
      const h = await rt.openDatabase(p.tenant_id, config.oa, "harness");
      await h.query(
        "INSERT OR IGNORE INTO messages(id,customer_id,line_user_id,direction,source,body,kind,external_id,state,occurred_at,recorded_at) VALUES (?,?,?,'outbound','self_demo',?,'text',?,'sent',?,?)",
        [attemptId, p.customer_id, p.customer_line_id, text, attemptId, at, at],
      );
      const staff = await one(
        rt.db,
        "SELECT line_user_id FROM staff_line_links WHERE tenant_id=? AND user_id=? AND state='active' AND notifications=1",
        [p.tenant_id, actor],
      );
      if (
        staff &&
        p.notifications_until > now() &&
        rt.assistantLine?.enabled &&
        (await claimStaffDaily(rt, p.tenant_id, actor, attemptId))
      ) {
        try {
          await rt.externalFetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${rt.assistantLine.token}`,
              "Content-Type": "application/json",
              "X-Line-Retry-Key": crypto.randomUUID(),
            },
            body: json({
              to: staff.line_user_id,
              messages: [
                {
                  type: "text",
                  text: `自分（体験用）のお客様から${b.state === "cancelled" ? "予約取消" : "予約"}が入りました。\n${formatJstDateTime(b.starts_at)}\n予約前の追客は停止しています。\n${rt.origin}/demo`,
                },
              ],
            }),
            redirect: "manual",
          });
        } catch {
          /* customer receipt remains independently recorded */
        }
      }
    },
    async verify(rt, tenant, oa, actor) {
      scope(tenant, oa);
      await googleAdmin(rt, tenant, oa, actor);
      const before = await account(rt, tenant, oa);
      const cred = await getCredential(rt, tenant, oa, "harness");
      const accounts = await harnessRequest(rt, cred, "/api/line-accounts");
      requireThat(
        Array.isArray(accounts) &&
          accounts.some(
            (a) =>
              a.id === cred.accountId &&
              a.channelId === config.channelId &&
              a.isActive,
          ),
        409,
        "HARNESS_ACCOUNT_MISMATCH",
        "受信用Harnessのチャネルが一致しません。",
      );
      await bot();
      const saved = await rt.db.query(
        "UPDATE accounts SET destination=?,state='ready',webhook_mode='harness',version=version+1 WHERE tenant_id=? AND id=? AND channel_id=? AND version=? AND (destination IS NULL OR destination=?)",
        [
          config.destination,
          tenant,
          oa,
          config.channelId,
          before.version,
          config.destination,
        ],
      );
      requireThat(
        saved.changes === 1,
        409,
        "CUSTOMER_ACCOUNT_CHANGED",
        "設定が変わりました。確認をやり直してください。",
      );
      await audit(rt.db, actor, "customer_test.verified", oa, tenant);
    },
    async send(rt, tenant, oa, item, onDispatch) {
      scope(tenant, oa);
      requireThat(
        enabled && rt.deliveryEnabled,
        403,
        "CUSTOMER_TEST_DISABLED",
        "顧客テスト送信は停止中です。",
      );
      requireThat(
        config.lineUserIds.includes(item.line_user_id) ||
          (!!config.selfDemo &&
            (await demoCustomerAllowed(
              rt,
              item.line_user_id,
              (
                await one(
                  await rt.openDatabase(tenant, oa, "tsunagu"),
                  "SELECT approved_by FROM proposals WHERE id=?",
                  [item.proposal_id],
                )
              )?.approved_by,
              item.customer_id,
            ))),
        403,
        "CUSTOMER_TEST_RECIPIENT",
        "この顧客はテスト送信の許可リストに含まれていません。",
      );
      await bot(); // Verify the actual token's bot on every attempt, including after rotation.
      const oaRow = await account(rt, tenant, oa);
      requireThat(
        oaRow.state === "ready" && oaRow.destination === config.destination,
        409,
        "CUSTOMER_TEST_UNVERIFIED",
        "顧客用LINEの接続確認が必要です。",
      );
      const ts = await rt.openDatabase(tenant, oa, "tsunagu"),
        h = await rt.openDatabase(tenant, oa, "harness");
      const live = await one(h, "SELECT * FROM outbox WHERE id=?", [item.id]);
      const proposal = await one(ts, "SELECT * FROM proposals WHERE id=?", [
        item.proposal_id,
      ]);
      requireThat(
        live?.state === "sending" &&
          live.body === item.body &&
          live.line_user_id === item.line_user_id &&
          live.customer_id === item.customer_id &&
          live.proposal_id === item.proposal_id &&
          live.proposal_version === item.proposal_version &&
          proposal?.trigger?.startsWith("assistant:") &&
          proposal.state === "sending" &&
          proposal.version === item.proposal_version &&
          proposal.approved_version === item.proposal_version,
        409,
        "CUSTOMER_TEST_APPROVAL_CHANGED",
        "今回の承認済み提案と配送内容が一致しません。",
      );
      await assistantAccess(
        rt,
        tenant,
        oa,
        proposal.approved_by,
        item.customer_id,
        "send",
      );
      await assistantDeliveryGuard(rt, tenant, oa, proposal, live);
      const reason = await guard(rt, tenant, oa, proposal);
      requireThat(!reason, 409, "CONTEXT_CHANGED", reason || "");
      const messages = parse(live.body, []);
      requireThat(
        messages.length === 1 &&
          messages[0].type === "text" &&
          typeof messages[0].text === "string" &&
          messages[0].text.length > 0 &&
          messages[0].text.length <= 5000,
        409,
        "CUSTOMER_TEST_FORMAT",
        "顧客テスト送信は承認済みのテキスト1件だけです。",
      );
      const attemptId = `${tenant}:${oa}:${item.id}`,
        retryKey = crypto.randomUUID(),
        day = dayJST();
      const claim = await rt.db.query(
        "INSERT OR IGNORE INTO gs_customer_line_attempts(id,tenant_id,oa_id,line_user_id,body_hash,retry_key,day,state,created_at) SELECT ?,?,?,?,?,?,?,'sending',? WHERE (SELECT COUNT(*) FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=?)<? AND (SELECT COUNT(*) FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=? AND line_user_id=?)<? RETURNING id",
        [
          attemptId,
          tenant,
          oa,
          item.line_user_id,
          await digest(live.body),
          retryKey,
          day,
          now(),
          tenant,
          oa,
          day,
          config.selfDemo ? 240 : 5,
          tenant,
          oa,
          day,
          item.line_user_id,
          config.selfDemo ? 8 : 5,
        ],
      );
      requireThat(
        claim.rows.length === 1,
        409,
        "CUSTOMER_TEST_LIMIT",
        "送信開始済み、または本日のテスト送信上限に達しています。再送しません。",
      );
      try {
        onDispatch();
        const response = await transport(
          "https://api.line.me/v2/bot/message/push",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.token}`,
              "Content-Type": "application/json",
              "X-Line-Retry-Key": retryKey,
            },
            body: json({ to: item.line_user_id, messages }),
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          },
        );
        requireThat(
          response.ok ||
            (response.status === 409 &&
              !!response.headers.get("x-line-accepted-request-id")),
          502,
          "CUSTOMER_LINE_OUTCOME_UNKNOWN",
          "LINEへの送信結果を確認できません。自動再送しません。",
        );
        await rt.db.query(
          "UPDATE gs_customer_line_attempts SET state='accepted' WHERE id=?",
          [attemptId],
        );
        return { messageId: retryKey };
      } catch (error) {
        await rt.db.query(
          "UPDATE gs_customer_line_attempts SET state='uncertain' WHERE id=?",
          [attemptId],
        );
        throw error;
      }
    },
  };
}

export function registerCustomerTestDelivery(app: Hono<AppEnv>) {
  const base =
    "/api/tenants/:tenantId/accounts/:oaId/assistant/customer-delivery";
  app.get(base, async (c) => {
    const rt = c.env.runtime,
      t = c.req.param("tenantId")!,
      oa = c.req.param("oaId")!,
      actor = c.get("principal").user.id;
    await googleAdmin(rt, t, oa, actor);
    const a = rt.customerTestDelivery;
    if (!a) return c.json({ mode: "standard" });
    const account = await one(
      rt.db,
      "SELECT state,destination FROM accounts WHERE tenant_id=? AND id=?",
      [t, oa],
    );
    const count = await one(
      rt.db,
      "SELECT COUNT(*) AS n FROM gs_customer_line_attempts WHERE tenant_id=? AND oa_id=? AND day=?",
      [t, oa, dayJST()],
    );
    return c.json({
      mode: "test",
      configured: a.configured,
      enabled: a.enabled,
      testerCount: a.testerCount,
      dailyLimit: a.dailyLimit,
      attemptedToday: count?.n || 0,
      accountReady: account?.state === "ready" && !!account.destination,
    });
  });
  app.post(`${base}/verify`, async (c) => {
    const rt = c.env.runtime,
      t = c.req.param("tenantId")!,
      oa = c.req.param("oaId")!,
      actor = c.get("principal").user.id;
    await googleAdmin(rt, t, oa, actor);
    requireThat(
      rt.customerTestDelivery,
      409,
      "CUSTOMER_TEST_UNAVAILABLE",
      "この環境はテスト配送設定の対象外です。",
    );
    await rt.customerTestDelivery!.verify(rt, t, oa, actor);
    return c.json({ verified: true, messagesSent: 0 });
  });
}
