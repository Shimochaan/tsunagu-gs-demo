import React, { useState } from "react";
import { B, Field, Note, Section } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Action, Form, State } from "./shared.jsx";

export function AssistantGoogle({
  base,
  connectionMode = false,
  readUnavailable = false,
}) {
  const [open, setOpen] = useState(false);
  if (connectionMode)
    return (
      <Content base={base} propertyOnly readUnavailable={readUnavailable} />
    );
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) setOpen(true);
      }}
    >
      <summary>
        {connectionMode
          ? "物件の内容を確認・取り込む／調査設定"
          : "Driveの物件台帳・ニュース調査"}
      </summary>
      {open && <Content base={base} />}
    </details>
  );
}
function Content({ base, propertyOnly = false, readUnavailable = false }) {
  const { data, error, refresh } = useData(base),
    [preview, setPreview] = useState(null),
    [result, setResult] = useState(""),
    [preflight, setPreflight] = useState(null),
    [research, setResearch] = useState(null);
  if (!data) return <State error={error} />;
  const s = data.settings;
  return (
    <Section
      title={propertyOnly ? "物件の内容を確認" : "物件の読み取りと調査設定"}
      sub="顧客希望や検証の正解表は、接続しない別ファイルに保管してください。"
    >
      <Note>
        Drive読取：
        {data.driveReadConfigured
          ? preview
            ? "台帳を読み取りました。下の確認結果をご覧ください"
            : "認可設定あり。読取・取込の結果は下に表示します"
          : "未接続（接続設定で本人のGoogle連携が必要）"}
        。ニュース：
        {s.researchToProposals ? "原文を確認して提案へ反映（Drive保存は不要）" : data.newsWriteConfigured
          ? "書込認可の設定あり・実保存は未確認"
          : "書込認可が未接続"}
        。
      </Note>
      {s.spreadsheetId && <Form key={`sync-${data.version}`} button="物件の自動確認を保存" onSubmit={async v=>{await api(base,{version:data.version,settings:{...s,autoSheet:v.autoSheet==='on'}},'PUT');refresh();}}>
        <label><input type="checkbox" name="autoSheet" defaultChecked={s.autoSheet}/> 5分ごとに更新を確認し、変更した物件だけ取り込む</label>
        <Note>変更がなければ更新日時だけを確認します。適合するお客様が見つかると文案を作り、担当者に通知します。顧客への送信には承認が必要です。</Note>
      </Form>}
      {data.sheetSync && <Note><p>物件マスターの自動確認：{date(data.sheetSync.checked_at)}・{{synced:'確認済み',needs_review:'一部の行に確認が必要',error:'確認できませんでした',idle:'待機中'}[data.sheetSync.state]||data.sheetSync.state}</p>{(()=>{try{const d=JSON.parse(data.sheetSync.detail);return <>{d.message&&<p>{d.message}</p>}{[...(d.errors||[]),...(d.warnings||[])].map((e,i)=><p key={i}>{e.row}行目：{e.message}</p>)}</>;}catch{return null;}})()}</Note>}
      {!propertyOnly && (
        <>
          <p>
            <a
              href={`/sales/connections?tenant=${encodeURIComponent(base.split("/")[3])}&oa=${encodeURIComponent(base.split("/")[5])}`}
            >
              Google・資料の接続設定へ
            </a>
          </p>
          <Form
            key={data.version}
            button="調査設定を保存"
            onSubmit={async (v) => {
              const list = (value) =>
                value
                  .split(/[、,\n]+/)
                  .map((x) => x.trim())
                  .filter(Boolean);
              await api(
                base,
                {
                  version: data.version,
                  settings: {
                    ...s,
                    topics: list(v.topics),
                    allowedHosts: list(v.allowedHosts),
                    researchEnabled: v.enabled === "on",
                    researchToProposals: true,
                  },
                },
                "PUT",
              );
              setPreview(null);
              setResult(
                "設定を保存しました。取込・調査はまだ実行していません。",
              );
              refresh();
            }}
          >
            <p>
              物件ファイル：
              {s.propertyFileName ||
                (s.spreadsheetId ? "物件台帳（保存済み）" : "未選択")}
              。接続設定で資料を選べます。
            </p>
            <Field label="公開ニュースの調査テーマ（改行区切り・最大5件）">
              <textarea
                name="topics"
                defaultValue={s.topics.join("\n")}
                rows={3}
                placeholder="住宅ローン金利"
              />
            </Field>
            <Field label="許可する出典ドメイン（改行区切り）">
              <textarea
                name="allowedHosts"
                defaultValue={s.allowedHosts.join("\n")}
                rows={3}
                placeholder="boj.or.jp"
              />
            </Field>
            <label>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={s.researchEnabled}
                disabled={
                  !data.researchRuntimeEnabled ||

                  !data.aiConfigured
                }
              />{" "}
              {data.researchManualOnly
                ? "手動ニュース調査を許可する"
                : "毎日のニュース調査を有効にする"}
            </label>
            {data.researchManualOnly && (
              <Note>
                この検証環境には自動調査のスケジュールがありません。管理者の実行ボタンから1件ずつ試してください。
              </Note>
            )}
            <p>
              日本時間で1日1回。1回あたりOpenAI応答1件・Web検索は最大3回・出力最大2,400トークンです。料金は設定モデルと検索利用料によります。失敗した日も再実行しません。
            </p>
            {!data.researchRuntimeEnabled && (
              <Note>
                実行環境のニュース調査は停止中です。設定の保存だけできます。
              </Note>
            )}
          </Form>
        </>
      )}
      <div className="product-actions">
        {!propertyOnly && (
          <Action
            run={async () =>
              setPreflight(await api(`${base}/research/preflight`))
            }
          >
            保存済みの調査設定を確認（通信・課金なし）
          </Action>
        )}
        <Action
          disabled={
            readUnavailable ||
            !data.driveReadConfigured ||
            !data.owner ||
            !s.spreadsheetId
          }
          run={async () => {
            setResult("");
            setPreview(await api(`${base}/properties/preview`, {}));
          }}
        >
          物件を読み取って確認
        </Action>
        {!propertyOnly && (
          <Action
            disabled={
              !s.researchEnabled ||
              !data.researchRuntimeEnabled ||
              (!s.researchToProposals && !data.newsWriteConfigured) ||
              !data.aiConfigured ||
              !data.owner
            }
            run={async () => {
              const r = await api(`${base}/research/run`, {
                acknowledgeCost: true,
              });
              setResult(
                r.skipped
                  ? "本日は実行済み、または停止中です。"
                  : r.state === "imported" ? "元記事を確認した情報を提案候補へ追加しました。" : r.state === "needs_review" ? "原文の確認が必要なため候補への追加を保留しました。" : "出典付き調査メモをDriveに保存しました。原文の確認が必要です。",
              );
              refresh();
            }}
          >
            本日の調査を実行（AI利用料が発生）
          </Action>
        )}
      </div>
      {preflight && (
        <Section
          title="ニュース調査の設定確認"
          sub={`確認日時：${date(preflight.checkedAt)}。フォームの未保存の変更は含みません。`}
        >
          <Note>
            {preflight.configurationReady
              ? "設定項目は揃っています。実接続は未検証です。"
              : "まだ不足している設定、または実行できない条件があります。"}
          </Note>
          {preflight.checks.map((c) => (
            <p key={c.key}>
              {c.ready ? "設定あり／条件を満たす" : "未設定／要確認"}：{c.label}
            </p>
          ))}
          <p>
            モデル：{preflight.model || "未設定"}。外部通信{" "}
            {preflight.externalCalls} 件・課金リクエスト{" "}
            {preflight.billingRequests} 件。
          </p>
          <p>{preflight.notice}</p>
        </Section>
      )}
      {preview && (
        <Section
          title={`取込前の確認：${preview.count}件`}
          sub={`確認期限：${date(preview.expiresAt)}。確定前に台帳の変更を再確認します。`}
        >
          {preview.errors.map((e) => (
            <Note key={e.row} tone="rose">
              {e.row}行目：{e.message}
            </Note>
          ))}
          {preview.rows.map((r) => (
            <p key={r.id}>
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.title}
              </a>{" "}
              — {r.area}・{Number(r.price).toLocaleString()}円・
              {r.status === "available"
                ? "販売中"
                : "販売中以外"}（在庫確認 {date(r.checkedAt)}）
            </p>
          ))}
          <div className="product-actions">
            <Action
              disabled={!preview.canImport}
              run={async () => {
                const r = await api(`${base}/properties/import`, {
                  reviewId: preview.reviewId,
                });
                setPreview(null);
                setResult(
                  `${r.imported}件を取り込みました。顧客への送信は0件です。`,
                );
              }}
            >
              この内容で物件を取り込む
            </Action>
            <Action
              run={async () => {
                await api(`${base}/properties/cancel`, {
                  reviewId: preview.reviewId,
                });
                setPreview(null);
                setResult("確認を取り消しました。");
              }}
            >
              取込を取り消す
            </Action>
          </div>
        </Section>
      )}
      {result && <Note>{result}</Note>}
      {!propertyOnly && (
        <Section
          title="ニュース調査の履歴"
          sub="元記事の公開日・本文を確認できた情報だけを提案に使います。確認できないものは保留します。"
        >
          {!data.researchRuns.length && <p>まだ調査を実行していません。</p>}
          {data.researchRuns.map((r) => (
            <div key={r.day}>
              <p>
                {r.day}：
                {{
                  imported: "原文確認済み・提案候補へ反映",
                  needs_review: "原文確認待ち・提案には未使用",
                  archived: "Drive保存済み・内容未確認",
                  running: "処理中／結果未確定",
                  researched: "調査済み・保存待ち",
                  archive_pending: "保存保留",
                  archive_unknown: "保存結果が不明（再送停止）",
                  failed: "調査失敗（再実行停止）",
                }[r.state] || r.state}
              </p>
              {r.archive_id && (
                <a
                  href={`https://drive.google.com/file/d/${encodeURIComponent(r.archive_id)}/view`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Driveで確認
                </a>
              )}
              {!!r.has_result && (
                <Action
                  run={async () =>
                    setResearch(await api(`${base}/research/${r.day}`))
                  }
                >
                  調査メモを見る
                </Action>
              )}
            </div>
          ))}
          {research && (
            <Note>
              <strong>未確認の調査メモ — {date(research.retrievedAt)}</strong>
              <p style={{ whiteSpace: "pre-wrap" }}>{research.body}</p>
              {research.citations.map((c) => (
                <p key={c.url}>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title}
                  </a>
                </p>
              ))}
              <B variant="ghost" onClick={() => setResearch(null)}>
                閉じる
              </B>
            </Note>
          )}
        </Section>
      )}
    </Section>
  );
}
