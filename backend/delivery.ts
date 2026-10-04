import { assistantDeliveryGuard } from "./assistant.ts";
import { all, one, now, json, parse, type Row } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import { getCredential } from "./credentials.ts";
import { harnessRequest, syncConversation } from "./harness.ts";
import { guard } from "./sales.ts";
import { member, customerAccess } from "./access.ts";
import { AppError, requireThat, audit } from "./security.ts";

export async function deliveryReady(rt: Runtime, tenant: string, oa: string) {
  const connection = await one(
    rt.db,
    "SELECT state FROM connections WHERE tenant_id=? AND oa_id=? AND service='harness'",
    [tenant, oa],
  );
  return connection?.state === "connected";
}
export async function sendDue(
  rt: Runtime,
  tenant: string,
  oaId: string,
  onlyOutboxId?: string,
) {
  // The test profile never drains a backlog or transactional messages. Only the
  // single assistant proposal explicitly approved in this request is eligible.
  if (
    rt.customerTestDelivery &&
    (!rt.customerTestDelivery.enabled || !onlyOutboxId)
  )
    return;
  const oa = await one(
    rt.db,
    "SELECT * FROM accounts WHERE tenant_id=? AND id=? AND state='ready'",
    [tenant, oaId],
  );
  if (!oa) return;
  if (!(await deliveryReady(rt, tenant, oaId))) return;
  const h = await rt.openDatabase(tenant, oaId, "harness"),
    ts = await rt.openDatabase(tenant, oaId, "tsunagu");
  // Harnessの現行APIは冪等キー未対応。送信開始後に応答を失ったものは再送せず照合待ちにする。
  await h.query(
    "UPDATE outbox SET state='uncertain',error_code='DELIVERY_UNKNOWN' WHERE state='sending' AND lease_until<?",
    [now()],
  );
  const reconciliations = await all(
    h,
    "SELECT o.id,o.proposal_id,o.proposal_version,o.state,q.revision AS reconcile_revision FROM outbox_reconcile_queue q JOIN outbox o ON o.id=q.outbox_id ORDER BY q.outbox_id LIMIT 100",
  );
  if (reconciliations.length) {
    if (reconciliations.some((r) => r.proposal_id))
      await ts.batch(
        reconciliations
          .filter((r) => r.proposal_id)
          .map((r) => ({
            sql: "UPDATE proposals SET state=? WHERE id=? AND version=? AND state<>?",
            params: [r.state, r.proposal_id, r.proposal_version, r.state],
          })),
      );
    await h.batch(
      reconciliations.map((r) => ({
        sql: "DELETE FROM outbox_reconcile_queue WHERE outbox_id=? AND revision=?",
        params: [r.id, r.reconcile_revision],
      })),
    );
  }
  const rows = await all(
    h,
    "SELECT * FROM outbox WHERE state='pending' AND scheduled_at<=?" +
      (onlyOutboxId ? " AND id=?" : "") +
      " ORDER BY scheduled_at LIMIT 10",
    onlyOutboxId ? [now(), onlyOutboxId] : [now()],
  );
  for (const item of rows) {
    let dispatched = false;
    try {
      const cred = await getCredential(rt, tenant, oaId, "harness");
      const common = await rt.openDatabase(tenant, "", "common");
      const link = await one(
        common,
        "SELECT * FROM external_links WHERE oa_id=? AND service='harness' AND customer_id=? AND line_user_id=?",
        [oaId, item.customer_id, item.line_user_id],
      );
      requireThat(
        link,
        409,
        "FRIEND_LINK_REQUIRED",
        "Harness上の友だちとの一致を確認してください。",
      );
      const syncedLink = await syncConversation(
        rt,
        tenant,
        oa,
        cred,
        link.external_id,
      );
      requireThat(
        syncedLink.customerId === item.customer_id &&
          syncedLink.lineUserId === item.line_user_id,
        409,
        "RECIPIENT_CHANGED",
        "配送先の顧客LINEが変更されています。紐付けを再確認してください。",
      );

      const customer = await one(common, "SELECT * FROM customers WHERE id=?", [
        item.customer_id,
      ]);
      requireThat(
        customer,
        404,
        "CUSTOMER_NOT_FOUND",
        "顧客が見つかりません。",
      );
      requireThat(
        !customer.opt_out,
        409,
        "OPT_OUT",
        "顧客が配信停止となっています。",
      );

      const company = await one(rt.db, "SELECT * FROM tenants WHERE id=?", [
        tenant,
      ]);
      requireThat(
        company && company.state === "active",
        403,
        "TENANT_INACTIVE",
        "企業のアカウント状態を確認してください。",
      );

      const isTransactional = ["booking_card", "reminder"].includes(item.kind);
      requireThat(
        !rt.customerTestDelivery || (!isTransactional && item.proposal_id),
        409,
        "CUSTOMER_TEST_APPROVAL_REQUIRED",
        "テスト配送は今回承認した提案1件だけです。",
      );
      let proposal: Row | null = null;

      if (!isTransactional) {
        proposal = await one(ts, "SELECT * FROM proposals WHERE id=?", [
          item.proposal_id,
        ]);
        requireThat(
          proposal &&
            proposal.state === "approved" &&
            proposal.version === item.proposal_version &&
            proposal.approved_version === item.proposal_version,
          409,
          "APPROVAL_CHANGED",
          "承認内容が変更されています。",
        );
        const m = await member(rt, proposal.approved_by, tenant);
        requireThat(
          customerAccess(m, customer, "send", parse(company.settings)),
          403,
          "SEND_PERMISSION_CHANGED",
          "送信権限を確認してください。",
        );
        requireThat(
          oa.owner_user_id === proposal.approved_by ||
            parse(oa.operators, []).includes(proposal.approved_by) ||
            parse(company.settings).proxySend === true,
          403,
          "OA_PERMISSION_CHANGED",
          "公式LINEの操作権限を確認してください。",
        );
        await assistantDeliveryGuard(rt, tenant, oaId, proposal, item);
        const reason = await guard(rt, tenant, oaId, proposal);
        requireThat(!reason, 409, "CONTEXT_CHANGED", reason || "");
      } else if (isTransactional) {
        // リマインド送信直前に対象面談がキャンセルされていないか確認
        const appointmentMatch = item.retry_key.match(
          /^(?:reminder_[\d.]+h|booking_card):[^:]+:([^:]+)(?::(\d+))?$/,
        );
        if (appointmentMatch) {
          const apptId = appointmentMatch[1];
          const appt = await one(
            h,
            "SELECT state,starts_at FROM appointments WHERE id=?",
            [apptId],
          );
          if (
            !appt ||
            !["booked", "rescheduled"].includes(appt.state) ||
            (appointmentMatch[2] &&
              Date.parse(appt.starts_at) !== Number(appointmentMatch[2]))
          ) {
            await h.query(
              "UPDATE outbox SET state='cancelled',error_code='APPOINTMENT_CANCELLED' WHERE id=?",
              [item.id],
            );
            continue;
          }
        }
      }

      const messages = parse(item.body, []);
      requireThat(
        messages.length === 1 &&
          ["text", "flex", "image"].includes(messages[0].type),
        409,
        "DELIVERY_FORMAT_UNSUPPORTED",
        "この形式の配送アダプターを確認してください。",
      );

      const claim = await h.query(
        "UPDATE outbox SET state='sending',attempts=attempts+1,lease_until=? WHERE id=? AND state='pending' RETURNING id",
        [new Date(Date.now() + 60000).toISOString(), item.id],
      );
      if (!claim.rows.length) continue;

      if (proposal) {
        const claimProposal = await ts.query(
          "UPDATE proposals SET state='sending' WHERE id=? AND version=? AND state='approved' RETURNING id",
          [proposal.id, proposal.version],
        );
        requireThat(
          claimProposal.rows.length,
          409,
          "APPROVAL_CHANGED",
          "承認内容が変わりました。",
        );
        await assistantDeliveryGuard(rt, tenant, oaId, proposal, item);
        const lastReason = await guard(rt, tenant, oaId, proposal);
        requireThat(!lastReason, 409, "CONTEXT_CHANGED", lastReason || "");
      }

      const msg = messages[0];
      const harnessPayload =
        msg.type === "flex"
          ? {
              messageType: "flex",
              content:
                typeof msg.contents === "string"
                  ? msg.contents
                  : JSON.stringify(msg.contents),
              altText: msg.altText || "メッセージが届きました",
              trackLinks: false,
            }
          : msg.type === "image"
            ? {
                messageType: "image",
                content: JSON.stringify({
                  originalContentUrl: msg.originalContentUrl,
                  previewImageUrl: msg.previewImageUrl,
                }),
                trackLinks: false,
              }
            : { messageType: "text", content: msg.text, trackLinks: false };

      let result: Row;
      if (rt.customerTestDelivery) {
        result = await rt.customerTestDelivery.send(
          rt,
          tenant,
          oaId,
          item,
          () => {
            dispatched = true;
          },
        );
      } else {
        dispatched = true;
        result = await harnessRequest(
          rt,
          cred,
          `/api/friends/${encodeURIComponent(link.external_id)}/messages`,
          harnessPayload,
        );
      }
      requireThat(
        typeof result.messageId === "string",
        502,
        "DELIVERY_UNKNOWN",
        "配送結果の確認が必要です。",
      );

      const logText =
        msg.type === "flex"
          ? msg.altText || "[カード]"
          : msg.type === "image"
            ? "[画像]"
            : msg.text;
      const provider = rt.customerTestDelivery ? "line-test" : "harness";

      await h.batch([
        {
          sql: "UPDATE outbox SET state='sent',accepted_at=?,lease_until=NULL,error_code=NULL WHERE id=?",
          params: [now(), item.id],
        },
        {
          sql: "INSERT OR IGNORE INTO messages(id,customer_id,line_user_id,direction,source,actor_id,body,kind,external_id,state,occurred_at,recorded_at) VALUES (?,?,?,'outbound',?,?,?,?,?,'sent',?,?)",
          params: [
            `${provider}:${result.messageId}`,
            item.customer_id,
            item.line_user_id,
            isTransactional ? "system" : "tsunagu",
            proposal ? proposal.approved_by : null,
            logText,
            msg.type,
            `${provider}:${result.messageId}`,
            now(),
            now(),
          ],
        },
      ]);

      if (proposal) {
        await ts.query(
          "UPDATE proposals SET state='sent',updated_at=? WHERE id=? AND version=?",
          [now(), proposal.id, proposal.version],
        );
      }

      await rt.db.query(
        "INSERT OR IGNORE INTO usage_events(id,tenant_id,oa_id,kind,units,provider,state,occurred_at) VALUES (?,?,?,'message',1,?,'accepted',?)",
        [`send:${oaId}:${item.id}`, tenant, oaId, provider, now()],
      );

      await audit(
        rt.db,
        proposal ? proposal.approved_by : "system",
        "message.sent",
        item.id,
        tenant,
        { kind: item.kind, messageType: msg.type },
      );
    } catch (e) {
      const state = dispatched ? "uncertain" : "held",
        code = e instanceof AppError ? e.code : "DELIVERY_FAILED";
      await h.query(
        "UPDATE outbox SET state=?,error_code=?,lease_until=NULL WHERE id=? AND state IN ('pending','sending')",
        [state, code, item.id],
      );
      if (item.proposal_id) {
        await ts.query(
          "UPDATE proposals SET state=?,hold_reason=? WHERE id=? AND version=? AND state NOT IN ('sent','cancelled','expired')",
          [
            state,
            dispatched
              ? rt.customerTestDelivery
                ? "LINEへの送信結果が不明です。自動再送せず、対象顧客とのトークと試験履歴を確認してください。"
                : "送信結果が不明です。Harnessで送信履歴を確認してください。"
              : e instanceof AppError && e.message
                ? e.message
                : (e as any)?.message ||
                  "接続・権限・最新の会話を確認してください。",
            item.proposal_id,
            item.proposal_version,
          ],
        );
      }
    }
  }
}
