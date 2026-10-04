import { id, json, now } from "./db.ts";
import { AppError } from "./security.ts";
import type { Runtime } from "./runtime.ts";

const stagingOrigin = "https://tsunagu-staging.shimoryo.workers.dev";
const tenantId = "a939c596-854a-4802-9511-cfb42b8176e9";
const channel = "C0C41CKJGRH";
const recipients: Record<string, { name: string; users: string[] }> = {
  "d9b0b91e-f2ee-4f4c-bfda-7c645d9e8254": {
    name: "ENJIN",
    users: ["U0A82BUC2JV", "U0A82CEC7G9"],
  },
  "54937539-1a38-456f-8dad-60c679a18bde": {
    name: "SHINTARO",
    users: ["U0A82C05NNM"],
  },
};
const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ProposalNotice {
  proposalId: string;
  customerName: string;
  draft: string;
}

// 表示名ではなく検証用の企業ID・公式LINE IDで限定する。
export function proposalSlackMessage(
  rt: Runtime,
  tenant: string,
  oa: string,
  notice: ProposalNotice,
) {
  const recipient = recipients[oa];
  if (
    !rt.slack ||
    rt.origin !== stagingOrigin ||
    tenant !== tenantId ||
    !recipient
  )
    return null;
  return {
    channel,
    text: `${recipient.users.map((user) => `<@${user}>`).join(" ")}\n【返信の候補ができました⭐️】\n対象アカウント：${recipient.name}\n追客先のお名前：${escape(notice.customerName)}\n内容：${escape(notice.draft)}\nリンク：<${stagingOrigin}/sales|管理画面を開く>`,
    parse: "none",
    unfurl_links: false,
    unfurl_media: false,
  };
}

export async function queueProposalNotice(
  rt: Runtime,
  tenant: string,
  oa: string,
  notice: ProposalNotice,
) {
  if (!proposalSlackMessage(rt, tenant, oa, notice)) return;
  // 永続ジョブに保存し、毎分のcronで送る。同一候補の再通知を防ぐ。
  await rt.db.query(
    "INSERT OR IGNORE INTO jobs(id,tenant_id,oa_id,kind,dedupe_key,payload,created_by,created_at,updated_at) VALUES (?,?,?,'slack_proposal',?,?,?,?,?)",
    [
      id(),
      tenant,
      oa,
      `slack-proposal:${tenant}:${oa}:${notice.proposalId}`,
      json(notice),
      "system",
      now(),
      now(),
    ],
  );
}

export async function sendProposalNotice(
  rt: Runtime,
  tenant: string,
  oa: string,
  notice: ProposalNotice,
) {
  const message = proposalSlackMessage(rt, tenant, oa, notice);
  if (!message)
    throw new AppError(
      503,
      "SLACK_NOT_CONFIGURED",
      "Slack通知の設定を確認してください。",
    );
  await sendSlackMessage(rt, message);
}

async function sendSlackMessage(rt: Runtime, message: NonNullable<ReturnType<typeof proposalSlackMessage>>) {
  const webhook = rt.slack!.webhookUrl;
  if (
    webhook &&
    !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(webhook)
  ) {
    throw new AppError(
      503,
      "SLACK_INVALID_WEBHOOK",
      "Slack Webhookの設定を確認してください。",
    );
  }
  // Incoming Webhookの宛先はSlack側に固定される。対象チャンネル専用URLを設定する。
  const { channel: _channel, ...webhookMessage } = message;
  const response = await rt.externalFetch(
    webhook || "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      headers: {
        ...(webhook ? {} : { Authorization: `Bearer ${rt.slack!.botToken}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(webhook ? webhookMessage : message),
      signal: AbortSignal.timeout(15000),
    },
  );
  const accepted = webhook
    ? (await response.text()).trim() === "ok"
    : Boolean(
        ((await response.json().catch(() => null)) as { ok?: boolean } | null)
          ?.ok,
      );
  if (!response.ok || !accepted) {
    throw new AppError(
      503,
      "SLACK_DELIVERY_FAILED",
      "Slack通知を送信できませんでした。",
    );
  }
}

export interface BookingNotice {
  bookingId: string;
  customerName: string;
  title: string;
  startsAt: string;
  staffName?: string;
  lineLinked: boolean;
}
export function bookingSlackMessage(rt: Runtime, tenant: string, oa: string, notice: BookingNotice) {
  const message = proposalSlackMessage(rt, tenant, oa, { proposalId: notice.bookingId, customerName: notice.customerName, draft: "" });
  if (!message) return null;
  const date = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" }).format(new Date(notice.startsAt));
  message.text = `${recipients[oa].users.map(user => `<@${user}>`).join(" ")}\n【1on1の予約が入りました⭐️】\n対象アカウント：${recipients[oa].name}\nご予約者のお名前：${escape(notice.customerName)}\n内容：${escape(notice.title)}\n予約日時：${date}（日本時間）\n担当者：${escape(notice.staffName || "未設定")}\nLINE連携：${notice.lineLinked ? "連携済み" : "未連携（LINE配信なし）"}\nリンク：<${stagingOrigin}/sales|管理画面を開く>`;
  return message;
}
export async function queueBookingNotice(rt: Runtime, tenant: string, oa: string, notice: BookingNotice) {
  if (!bookingSlackMessage(rt, tenant, oa, notice)) return;
  await rt.db.query(
    "INSERT OR IGNORE INTO jobs(id,tenant_id,oa_id,kind,dedupe_key,payload,created_by,created_at,updated_at) VALUES (?,?,?,'slack_booking',?,?,?,?,?)",
    [id(), tenant, oa, `slack-booking:${tenant}:${oa}:${notice.bookingId}`, json(notice), "system", now(), now()],
  );
}
export async function sendBookingNotice(rt: Runtime, tenant: string, oa: string, notice: BookingNotice) {
  const message = bookingSlackMessage(rt, tenant, oa, notice);
  if (!message) throw new AppError(503, "SLACK_NOT_CONFIGURED", "Slack通知の設定を確認してください。");
  await sendSlackMessage(rt, message);
}
