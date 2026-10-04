import React, { useRef, useState } from "react";
import { B, Note, Section } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";

export function HarnessConversation({ base, onImported }) {
  const { data, error, refresh } = useData(`${base}/harness-conversation`);
  const [preview, setPreview] = useState(null),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [failure, setFailure] = useState("");
  const lock = useRef(false);
  const run = async (kind, fn) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setFailure("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setFailure(
        e.message || "通信に失敗しました。状態を確認して再試行してください。",
      );
    } finally {
      lock.current = false;
      setBusy("");
    }
  };
  const root = `${base}/harness-conversation`;
  return (
    <Section
      title="LINEの会話を取り込む"
      sub="顧客用LINEの受信内容を確認してから、このお客様に反映します。AI利用・LINE送信は行いません。"
    >
      {!data ? (
        <>
          <Note>{error || "接続状態を確認しています…"}</Note>
          <B onClick={refresh}>接続状態を再確認</B>
        </>
      ) : (
        <>
          <Note>
            {data.configured
              ? `受信接続の設定あり · ${data.customer} · LINE ID ${data.lineUserId}`
              : "未接続です。「導入・企業設定」→「接続」でHarnessを設定し、友だちを取り込んでください。"}
          </Note>
          <p>
            受信元が返す直近の会話を確認します（この環境は最大{data.readLimit}
            件）。LINEの過去の全履歴は取得しません。
          </p>
          {!preview && (
            <B
              disabled={!data.configured || !!busy}
              onClick={() =>
                run("preview", async () =>
                  setPreview(await api(`${root}/preview`, {})),
                )
              }
            >
              受信した会話を確認
            </B>
          )}
          {preview && (
            <>
              <Note>
                取込前の確認：{preview.customer} · {preview.received}件中、新規
                {preview.newCount}件。対象外{preview.skipped}件。確認期限{" "}
                {date(preview.expiresAt)}
              </Note>
              {!preview.following && (
                <Note tone="amber">
                  このお客様はLINEをブロックしています。確定すると配信停止を反映します。
                </Note>
              )}
              <div className="product-conversation">
                {preview.messages.map((m) => (
                  <div
                    className={`product-message ${m.direction === "incoming" ? "inbound" : "outbound"}`}
                    key={m.id}
                  >
                    <small>
                      {date(m.createdAt)} ·{" "}
                      {m.direction === "incoming"
                        ? "お客様から"
                        : "公式LINEから"}
                    </small>
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {!preview.messages.length && (
                  <p>
                    受信したテキストはありません。顧客用LINEへテスト文を送ってから再確認してください。
                  </p>
                )}
              </div>
              <div className="product-actions">
                <B
                  disabled={!!busy}
                  onClick={() =>
                    run("commit", async () => {
                      const r = await api(`${root}/commit`, {
                        reviewId: preview.id,
                      });
                      setNotice(
                        `${r.replay ? "前回の取込結果を確認しました。" : "取込が完了しました。"}新規${r.inserted}件／確認${r.received}件。LINE送信・AI実行は0件です。`,
                      );
                      setPreview(null);
                      refresh();
                      onImported?.();
                    })
                  }
                >
                  この内容を取り込む
                </B>
                <B
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    run("cancel", async () => {
                      await api(`${root}/cancel`, { reviewId: preview.id });
                      setPreview(null);
                      setNotice(
                        "取込を取り消しました。会話は保存していません。",
                      );
                    })
                  }
                >
                  取込を取り消す
                </B>
              </div>
            </>
          )}
          {busy && (
            <p role="status" aria-live="polite">
              {
                {
                  preview: "受信内容を読み取っています…",
                  commit: "本人と内容を再確認して取り込んでいます…",
                  cancel: "取込を取り消しています…",
                }[busy]
              }
            </p>
          )}
          {failure && (
            <Note tone="rose">
              <span role="alert">{failure}</span>
              <p>
                通信失敗なら同じ操作で結果を再確認できます。内容変更・期限切れなら「取込を取り消す」から新しいプレビューを開いてください。
              </p>
            </Note>
          )}
          {notice && <p role="status">{notice}</p>}
          <p>
            返信案は最後の着信・初回取込から90秒以上経過後、「今日の提案」→「アシスタントの設定・情報元」→「今ある情報から提案を確認」で検出します。画面を閉じるだけでは取込は開始しません。確定開始後は完了結果を確認してください。
          </p>
        </>
      )}
    </Section>
  );
}
