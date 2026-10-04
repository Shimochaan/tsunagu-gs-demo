import React, { useState } from "react";
import { Section, Field, Note, B, Tag } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Form, Action, State } from "./shared.jsx";
import { useMeetingRefresh } from "./MeetingRefresh.jsx";
const localInput = (v) =>
  v ? new Date(Date.parse(v) + 9 * 3600000).toISOString().slice(0, 16) : "";
export function CustomerRecordings({ base, customer, onChange }) {
  const url = `${base}/customers/${customer.id}/recordings`,
    { data, error, refresh } = useData(url),
    [review, setReview] = useState(null),
    [saved, setSaved] = useState("");
  const [fileId, setFileId] = useState(null);
  const recovery = useMeetingRefresh(base, fileId, async (fresh) => {
    setReview(
      await api(url + "/preview", { fileId: fresh.id, version: fresh.version }),
    );
    refresh();
  });
  return (
    <Section
      title="Google Meet 議事録をこのお客様へ"
      sub="紐付け済みの原文は約5分ごとに更新を検知・再解析します。初めての資料は相手を一度だけ確認してください。"
    >
      {!data ? (
        <State error={error} />
      ) : (
        <>
          {recovery.recovery}
          {!data.connected ? (
            <Note>
              この公式LINEでご自身のGoogle
              Driveは未接続、または再承認が必要です。「面談結果」の連携設定で、つなぐへの接続と議事録の保存先を確認してください。他のアプリのGoogle接続は利用しません。
            </Note>
          ) : (
            <>
              <p>
                割当先：<strong>{customer.name}</strong>
              </p>
              {!data.aiConfigured && (
                <Note>
                  AI解析は未接続です。
                  {data.mode === "local"
                    ? "ローカル検証では原文の抜粋のみを表示します。解析結果を生成したとは扱いません。"
                    : "接続設定が完了するまで原文確認のみ利用できます。"}
                </Note>
              )}
              {!review && (
                <>
                  <Action run={async () => refresh()}>議事録一覧を更新</Action>
                  {!data.documents.length && (
                    <p>
                      参照できる議事録はありません。許可した保存先の検知結果から最大50件を表示します。
                    </p>
                  )}
                  {data.documents.map((d) => (
                    <article className="product-card" key={d.id}>
                      <h3>{d.title}</h3>
                      <p>
                        更新：{date(d.modifiedAt)} ·{" "}
                        {d.state === "linked"
                          ? "取込済み・更新を自動確認"
                          : "未反映"}
                      </p>
                      <Action
                        onError={recovery.onError}
                        run={async () => {
                          setFileId(d.id);
                          setSaved("");
                          setReview(
                            await api(url + "/preview", {
                              fileId: d.id,
                              version: d.version,
                            }),
                          );
                        }}
                      >
                        この顧客に割り当てて原文を確認
                      </Action>
                    </article>
                  ))}
                </>
              )}
            </>
          )}
          {review && (
            <div className="product-stack">
              <p>
                <strong>{review.customerName}</strong>へ割当 · {review.title}
              </p>
              <a href={review.fileUrl} target="_blank" rel="noreferrer">
                Driveの出典を開く ↗
              </a>
              <p>原文の更新：{date(review.modifiedAt)}</p>
              <details open={review.state === "preview"}>
                <summary>取り込む原文を確認</summary>
                <pre className="recording-transcript">{review.transcript}</pre>
              </details>
              {review.state === "preview" && (
                <Form
                  key={review.id}
                  onError={recovery.onError}
                  button={
                    data.aiConfigured
                      ? "確認した原文を解析する"
                      : "原文の抜粋を確認する（AI未接続）"
                  }
                  onSubmit={async (v) => {
                    const r = await api(`${url}/reviews/${review.id}/analyze`, {
                      version: review.version,
                      confirmed: true,
                      singleCustomerConfirmed:
                        v.singleCustomerConfirmed === "on",
                      heldAt: new Date(v.heldAt + ":00+09:00").toISOString(),
                      ...(v.excerpt?.trim()
                        ? { excerpt: v.excerpt.trim() }
                        : {}),
                    });
                    setReview((x) => ({ ...x, ...r }));
                  }}
                >
                  <Field label="会議日時（日本時間）">
                    <input
                      name="heldAt"
                      type="datetime-local"
                      required
                      defaultValue={localInput(review.heldAt)}
                    />
                  </Field>
                  <Field label="複数のお客様が参加した場合、この方の発言を原文から抜粋">
                    <textarea
                      name="excerpt"
                      maxLength={50000}
                      rows={4}
                      placeholder="対象者の発言を特定できない場合は、割当を取り消してください。"
                    />
                  </Field>
                  <label className="product-check">
                    <input
                      name="singleCustomerConfirmed"
                      type="checkbox"
                      required
                    />
                    原文と発言者を確認し、この顧客の内容であると確認しました
                  </label>
                  <Note>
                    {data.aiConfigured
                      ? "確認した1件の原文をAIで解析します。"
                      : "AI未接続のため、原文の抜粋を確認します。"}
                    保存するまでは顧客情報に反映しません。
                  </Note>
                </Form>
              )}
              {review.state === "draft" && (
                <>
                  <Tag>
                    {review.mode === "source_preview"
                      ? "AI未接続・原文の確認"
                      : "解析済み・反映前"}
                  </Tag>
                  <h3>追記する内容</h3>
                  <p className="recording-transcript">
                    {review.extract.summary}
                  </p>
                  <p>
                    要点：{review.extract.keyPoints.join(" / ") || "抽出なし"}
                  </p>
                  <p>
                    懸念：{review.extract.concerns.join(" / ") || "抽出なし"}
                  </p>
                  <p>
                    関心：{review.extract.interests.join(" / ") || "抽出なし"}
                  </p>
                  <p>次の行動：{review.extract.nextAction}</p>
                  <Form
                    key={review.id}
                    onError={recovery.onError}
                    button="内容を確認してこの顧客のメモへ追記"
                    onSubmit={async (v) => {
                      const r = await api(
                        `${url}/reviews/${review.id}/confirm`,
                        {
                          version: review.version,
                          confirmed: true,
                          applyTriggers: v.applyTriggers === "on",
                        },
                      );
                      setReview(null);
                      setSaved(
                        r.alreadyApplied
                          ? "この版は取込済みです。重複するメモは作成しません。"
                          : "確認済みメモへ追記しました。希望条件と提案候補は次の自動処理で確認・反映します。",
                      );
                      refresh();
                      onChange?.();
                    }}
                  >
                    {!!review.extract.triggers.length && (
                      <>
                        <h3>確認が必要な次回の予定</h3>
                        {review.extract.triggers.map((t, i) => (
                          <p key={i}>
                            {date(
                              new Date(
                                Date.parse(review.heldAt) +
                                  t.daysAfter * 86400000,
                              ).toISOString(),
                            )}{" "}
                            · {t.intent}
                          </p>
                        ))}
                        <label className="product-check">
                          <input type="checkbox" name="applyTriggers" />
                          原文に明記された未来の予定を確認し、連絡案の候補として登録する
                        </label>
                      </>
                    )}
                    <Note>
                      出典付きメモを追記します。全文を紐付けた場合、原文を確認して希望条件と提案候補へ自動反映します。抜粋した場合はメモのみ追記します。顧客への送信は別途承認が必要です。
                    </Note>
                  </Form>
                </>
              )}
              <Action
                run={() => api(`${url}/reviews/${review.id}/cancel`, {})}
                done={() => setReview(null)}
              >
                この割当を取り消す
              </Action>
            </div>
          )}
          {saved && <p role="status">{saved}</p>}
        </>
      )}
    </Section>
  );
}
