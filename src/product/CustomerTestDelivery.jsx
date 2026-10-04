import React, { useState } from "react";
import { Note, Section } from "../platform/ui.jsx";
import { api, useData } from "./api.js";
import { Action, State } from "./shared.jsx";

export function CustomerTestDelivery({ base }) {
  const { data, error, refresh } = useData(base),
    [result, setResult] = useState("");
  if (!data) return <State error={error} />;
  if (data.mode !== "test") return null;
  return (
    <Section
      title="顧客LINEのテスト送信"
      sub="許可した顧客だけに、今回承認したテキスト1件を送ります。"
    >
      <Note tone={data.enabled ? "amber" : undefined}>
        {data.enabled
          ? "テスト送信の実行許可あり。承認すると実際のLINEへ送信します。"
          : "実送信は停止中です。接続先の確認は、設定が揃ってから行えます。"}
      </Note>
      <p>
        接続設定：{data.configured ? "設定あり" : "未設定・不足あり"}
        。顧客用アカウントの確認：
        {data.accountReady ? "確認済み（送信直前にも再確認）" : "未確認"}。
      </p>
      <p>
        許可対象 {data.testerCount} 人。本日の送信開始 {data.attemptedToday} /{" "}
        {data.dailyLimit}{" "}
        件（日本時間）。結果不明も枠を消費し、自動再送しません。
      </p>
      <Action
        disabled={!data.configured}
        run={async () => {
          await api(`${base}/verify`, {});
          setResult(
            "顧客用LINEと受信接続の一致を確認しました。送信は0件です。",
          );
          refresh();
        }}
      >
        接続先を確認（LINE送信なし）
      </Action>
      {result && <Note>{result}</Note>}
      <p>
        宛先や許可リストの設定は管理者が行います。以前の承認をまとめて送る操作はありません。
      </p>
    </Section>
  );
}
