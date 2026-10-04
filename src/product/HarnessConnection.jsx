import React, { useState, useRef } from "react";
import { Section, Field, Note, B } from "../platform/ui.jsx";
import { Form, Action, State } from "./shared.jsx";
import { api, useData } from "./api.js";

export function HarnessConnection({ base, connected, done }) {
  const { data: capabilities, error: capabilitiesError } =
    useData("/api/config");
  const readOnly = !!capabilities?.harnessReadOnly;
  const stopImport = useRef(false);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(null);
  const [importingAll, setImportingAll] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importError, setImportError] = useState("");
  const [copied, setCopied] = useState(false);

  const webhookUrl = `${location.origin}/webhooks/harness-native/${base.split("/").at(-1)}`;

  const copyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleImportAll = async () => {
    if (importingAll) return;
    stopImport.current = false;
    setImportingAll(true);
    setImportError("");
    try {
      let currentOffset = offset;
      while (!stopImport.current) {
        const r = await api(`${base}/harness/import`, {
          offset: currentOffset,
        });
        setResult(r);
        const currentCount = currentOffset + r.count;
        const percent = r.total
          ? Math.min(100, Math.round((currentCount / r.total) * 100))
          : 100;
        setImportProgress({ count: currentCount, total: r.total, percent });
        if (!r.nextOffset) {
          setOffset(0);
          break;
        }
        currentOffset = r.nextOffset;
        setOffset(currentOffset);
        setOffset(currentOffset);
      }
      done?.();
    } catch (err) {
      setImportError(err.message || String(err));
    } finally {
      setImportingAll(false);
    }
  };

  if (!capabilities) return <State error={capabilitiesError} />;
  return (
    <Section
      title="Harnessと接続する"
      sub={
        readOnly
          ? "受信専用Harnessから友だちと会話を読み取ります。顧客へのテスト送信はアシスタントの設定で別途確認します。"
          : "配信システム（Harness）と接続し、友だち情報や配信イベントを連携します。"
      }
    >
      <Form
        button="接続を確認して保存"
        onSubmit={(v) => api(`${base}/harness`, v)}
        onDone={done}
      >
        {readOnly && (
          <Field
            label="顧客用LINEのチャネルID"
            hint="LINE DevelopersのMessaging APIチャネルIDです。担当者用LINEのIDと取り違えないでください。登録後の変更はできません。"
          >
            <input
              name="channelId"
              required
              pattern="[0-9]{5,20}"
              inputMode="numeric"
            />
          </Field>
        )}
        <Field
          label="HarnessのURL"
          hint={
            readOnly
              ? "G’s専用のHarness URLを指定してください。"
              : "※同一企業内で同一Harnessサーバーを共有している場合は同じURLを入力してください。"
          }
        >
          <input
            name="origin"
            type="url"
            required
            placeholder="https://your-harness.your-team.workers.dev"
          />
        </Field>
        <Field
          label="Harness内の公式LINE ID"
          hint="Harness管理画面で対象アカウントを開いたURLまたは一覧に表示されるアカウントIDです。"
        >
          <input
            name="accountId"
            required
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
        </Field>
        <Field
          label="HarnessのAPIキー"
          hint={
            readOnly
              ? "G’s専用Harnessに設定した読取用APIキーを入力してください。"
              : "※同一Harnessサーバーをご利用の場合は、他の公式LINEと同じAPIキー（tsunagu-workerキー）を入力してください。"
          }
        >
          <input
            name="apiKey"
            type="password"
            required
            minLength={16}
            autoComplete="new-password"
          />
        </Field>
        {!readOnly && (
          <Field
            label="送信Webhookの署名シークレット"
            hint="通信保護用の暗号鍵です。Harness側の送信Webhook設定にも同じ値を入力します。"
          >
            <input
              name="webhookSecret"
              type="password"
              required
              minLength={32}
              autoComplete="new-password"
            />
          </Field>
        )}
      </Form>

      {!readOnly && (
        <div style={{ marginTop: "16px" }}>
          <p className="product-muted" style={{ marginBottom: "6px" }}>
            Harnessの送信Webhook URL（Harness管理画面に登録するURL）
          </p>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <code className="product-secret" style={{ flex: 1, margin: 0 }}>
              {webhookUrl}
            </code>
            <button
              type="button"
              className="pt-btn secondary"
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                whiteSpace: "nowrap",
              }}
              onClick={copyWebhook}
            >
              {copied ? "コピー完了 ✓" : "URLをコピー"}
            </button>
          </div>
        </div>
      )}

      {connected && (
        <div
          style={{
            margin: "12px 0",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            padding: "10px 14px",
            borderRadius: "6px",
            color: "#166534",
            fontSize: "13px",
            fontWeight: "500",
          }}
        >
          ✓ Harnessと正常に接続されています。
        </div>
      )}

      <Note>
        {readOnly
          ? "友だちを取り込んだ後、対象のお客様の会話を手動で同期して確認します。LINEの応答や外部送信は行いません。"
          : "既存の応答設定と役割分担を確認してから利用を開始してください。受信イベントの動作確認後に、開通チェックへ進めます。"}
      </Note>

      {connected && (
        <div className="product-note-spaced">
          <div
            style={{
              display: "flex",
              gap: "10px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <B
              variant="primary"
              disabled={importingAll}
              onClick={handleImportAll}
            >
              {importingAll ? "全件取り込み中…" : "友だちを全件一括で取り込む"}
            </B>
            <Action
              disabled={importingAll}
              run={async () => {
                const r = await api(`${base}/harness/import`, { offset });
                setResult(r);
                setOffset(r.nextOffset ?? 0);
              }}
              done={done}
            >
              友だちを{offset ? "続けて" : "50人ずつ"}取り込む
            </Action>
          </div>

          {importingAll && (
            <B
              variant="secondary"
              onClick={() => {
                stopImport.current = true;
              }}
            >
              次のページの取込を停止
            </B>
          )}
          {stopImport.current && !importingAll && (
            <Note>
              取込を停止しました。処理済みの友だちは保持しています。続ける場合は次のページから再開できます。
            </Note>
          )}
          {importProgress && (
            <div style={{ marginTop: "12px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                }}
              >
                <span>
                  取り込み進捗: {importProgress.count} / {importProgress.total}{" "}
                  人
                </span>
                <span>{importProgress.percent}%</span>
              </div>
              <div
                style={{
                  width: "100%",
                  height: "6px",
                  background: "var(--border)",
                  borderRadius: "3px",
                  overflow: "hidden",
                  marginTop: "4px",
                }}
              >
                <div
                  style={{
                    width: `${importProgress.percent}%`,
                    height: "100%",
                    background: "#10b981",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          )}

          {importError && (
            <p
              role="alert"
              className="product-error"
              style={{ marginTop: "8px" }}
            >
              {importError}
            </p>
          )}

          {result && !importProgress && (
            <p
              role="status"
              className="product-muted"
              style={{ marginTop: "8px" }}
            >
              {result.count}人を確認しました。
              {result.nextOffset != null
                ? `続きがあります（現在 ${offset} / ${result.total} 人）。`
                : `この取り込みは完了しました。（全 ${result.total} 人）`}
            </p>
          )}

          {importProgress &&
            !importingAll &&
            importProgress.count >= importProgress.total && (
              <p
                role="status"
                style={{
                  color: "#166534",
                  fontSize: "13px",
                  fontWeight: "500",
                  marginTop: "8px",
                }}
              >
                ✓ 全 {importProgress.total} 人の友だち取り込みが完了しました。
              </p>
            )}
        </div>
      )}
    </Section>
  );
}
