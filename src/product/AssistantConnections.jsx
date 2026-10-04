import React, { useState } from "react";
import { B, Field, Note, Section } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Action, Form, State } from "./shared.jsx";
const names = {
  configured: "設定あり・読取未確認",
  missing: "未設定",
  invalid: "設定形式に誤り",
  disabled: "停止中",
  customer_channel_conflict: "顧客用LINEと重複しています",
};
export function AssistantConnections({ base }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) setOpen(true);
      }}
    >
      <summary>接続の確認・取込前の検証</summary>
      {open && <ConnectionContent base={base} />}
    </details>
  );
}
function ConnectionContent({ base }) {
  const { data, error, refresh } = useData(base),
    [result, setResult] = useState(null),
    [kind, setKind] = useState("catalog"),
    [formKey, setFormKey] = useState(0);
  if (!data) return <State error={error} />;
  const reset = () => {
    setResult(null);
    setKind("catalog");
    setFormKey((x) => x + 1);
  };
  return (
    <Section
      title="接続の確認"
      sub="設定・読取確認・実際の配送を分けて確認します。"
    >
      <p>
        担当者LINE：{names[data.line.configuration]}。本人連携：
        {data.line.identity === "linked" ? "連携済み" : "未連携"}
        。実配送：未検証。
      </p>
      <p>
        ニュース検索：{names[data.search.configuration]}。商品フィード：
        {names[data.catalog.configuration]}。
      </p>
      <Note>
        検索と商品は共通JSON形式に対応しています。利用する提供元の選定・応答変換が必要です。設定があるだけでは接続済みとは表示しません。
      </Note>
      <p>
        照合待ち：
        {data.work.state === "schema_present"
          ? `${data.work.queued}人${data.work.sweeping ? "・全顧客を照合中" : ""}`
          : "DB更新が必要です"}
        。確認日時：{date(data.checkedAt)}
      </p>
      <div className="product-actions">
        <B variant="secondary" onClick={refresh}>
          設定を再確認
        </B>
        <Action
          disabled={!data.line.readyForReadCheck}
          run={async () =>
            setResult(await api(`${base}/check`, { kind: "line" }))
          }
        >
          LINE設定を読取確認（送信なし）
        </Action>
        <Action
          disabled={data.catalog.configuration !== "configured"}
          run={async () =>
            setResult(await api(`${base}/check`, { kind: "catalog" }))
          }
        >
          商品フィードを読取確認（保存なし）
        </Action>
      </div>
      <details>
        <summary>応答JSONを検証する（通信・保存なし）</summary>
        <Form
          key={formKey}
          button="取込前に検証"
          onSubmit={async (v) => {
            let payload;
            try {
              payload = JSON.parse(v.payload);
            } catch {
              throw new Error("JSONの形式を確認してください。");
            }
            const options =
              kind === "article"
                ? {
                    url: v.url,
                    topic: v.topic,
                    allowedHosts: v.hosts.split(/[、,\s]+/).filter(Boolean),
                  }
                : {};
            setResult(
              await api(`${base}/validate`, { kind, payload, ...options }),
            );
          }}
        >
          <Field label="検証する応答">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setResult(null);
              }}
            >
              <option value="catalog">商品・ニュースのフィード</option>
              <option value="search">検索結果</option>
              <option value="article">元記事の本文・日付</option>
            </select>
          </Field>
          {kind === "article" && (
            <>
              <Field label="記事URL">
                <input name="url" type="url" required />
              </Field>
              <Field label="照合する話題">
                <input name="topic" required minLength={2} maxLength={40} />
              </Field>
              <Field label="許可する出典ホスト">
                <input
                  name="hosts"
                  required
                  placeholder="publisher.example.com"
                />
              </Field>
            </>
          )}
          <Field label="提供元から受け取るJSON">
            <textarea name="payload" required rows={7} maxLength={300000} />
          </Field>
        </Form>
        <B variant="ghost" onClick={reset}>
          入力と結果を取り消す
        </B>
      </details>
      {result && (
        <Note>
          <strong>{result.ok ? "確認できました。" : "確認が必要です。"}</strong>
          {result.message && <p>{result.message}</p>}
          {result.count !== undefined && (
            <p>
              {result.count}件を検証し、{result.usable}
              件が鮮度・在庫条件を満たしています。
            </p>
          )}
          {result.webhook && (
            <p>
              トークン：確認済み。Webhook：
              {result.webhook === "configured"
                ? "設定一致・有効"
                : "URLまたは有効化を確認"}
              。到達・本人連携・実配送は別途確認が必要です。
            </p>
          )}
          <p>
            {result.externalRequests}回の読取、保存0件・メッセージ送信0件。
            {result.scope === "contract_only"
              ? "入力形式の検証結果です。実サービスへの接続は確認していません。"
              : ""}
          </p>
        </Note>
      )}
    </Section>
  );
}
