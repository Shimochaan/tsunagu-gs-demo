import { parse, type Row } from "./db.ts";
import type { Runtime } from "./runtime.ts";

export function setupEnvironment(rt: Runtime) {
  return {
    google: rt.googleEnabled,
    mail: rt.mailMode || (rt.local ? "local" : "unconfigured"),
    provisioning: rt.provisioningEnabled === true,
    delivery: rt.harnessReadOnly ? "test_only" : rt.deliveryEnabled === false ? "disabled" : "enabled",
    detection: rt.assistantManualOnly || rt.local ? "manual" : "scheduler_managed",
  };
}

// 表示と開通APIで同じ条件を使い、「全て緑なのに開通できない」を防ぐ。
export function activationReadiness(
  rt: Runtime,
  tenant: Row,
  account: Row,
  databases: Row[],
  connections: Row[],
) {
  const settings = typeof tenant.settings === "string" ? parse(tenant.settings) : tenant.settings || {};
  const required = [["common", ""], ["harness", account.id], ["tsunagu", account.id]];
  const dbReady = required.every(([purpose, oa]) => databases.some(d =>
    d.tenant_id === tenant.id && d.oa_id === oa && d.purpose === purpose && d.state === "ready" && d.physical_id));
  const connected = connections.some(c => c.tenant_id === tenant.id && c.oa_id === account.id && c.service === "harness" && c.state === "connected");
  const checks = [
    {id:"retention", label:settings.retentionDays === null ? "企業の保持期間（期限なし）" : "企業の保持期間", ready:settings.retentionDays === null || (Number.isInteger(settings.retentionDays) && settings.retentionDays >= 1 && settings.retentionDays <= 3650), owner:"企業管理者", step:0, detail:"会話・議事録を保持する日数、または期限なしを選んで保存します。"},
    {id:"owner", label:"公式LINEの主担当", ready:!!account.owner_user_id, owner:"企業管理者", step:2, detail:"招待を受けた担当者を公式LINEに割り当てます。"},
    {id:"databases", label:"データ保存先の準備", ready:dbReady, owner:"運営", step:6, detail:"企業共通・LINE受信・つなぐの3つの保存先を運営が準備します。"},
    {id:"webhook", label:"LINEの受信確認", ready:!!account.webhook_verified_at, owner:"企業管理者・運営", step:3, detail:"顧客用LINEからの受信経路を接続・検証します。"},
    {id:"harness", label:"顧客LINEとの接続", ready:connected, owner:"企業管理者・運営", step:3, detail:"利用中のLINE管理サービスを接続します。"},
    {id:"preview", label:"友だちの取込み確認", ready:!!account.preview_ready, owner:"企業管理者", step:4, detail:"取り込む友だち・担当者を確認します。"},
    {id:"style", label:"担当者の言葉", ready:!!account.calibration_ready, owner:"担当営業", step:5, detail:"普段の返信を7問（各15文字以上）に入力し、最後に『すべての回答を確定して完了』を押します。"},
    {id:"delivery", label:"通常の顧客送信", ready:!rt.harnessReadOnly && rt.deliveryEnabled !== false, owner:"運営", step:6, detail:rt.harnessReadOnly ? "この環境は本人宛の限定テスト用です。通常企業の開通とは別に扱います。" : rt.deliveryEnabled === false ? "運営が送信基盤を確認して有効にします。" : "承認した本文を顧客へ届ける送信設定があります。"},
  ];
  return { accountId:account.id, checks, canActivate:checks.every(c=>c.ready), missing:checks.filter(c=>!c.ready).map(c=>c.id) };
}
