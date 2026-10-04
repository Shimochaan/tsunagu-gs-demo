import React, { useState } from "react";
import { Section, Field, Note, Tag } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Form, Action, State, Status } from "./shared.jsx";
const localDate = (value) =>
  value
    ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
export function CustomerFollowup({ base, customerId, onChange }) {
  const url = `${base}/assistant/customers/${customerId}/followup`,
    { data, error, refresh } = useData(url),
    [opened, setOpened] = useState(false);
  const done = () => {
    refresh();
    onChange?.();
  };
  if (!data) return <State error={error} />;
  const p = data.profile,
    j = data.journey;
  return (
    <Section
      title="次に進む条件と、その後のご連絡"
      sub="お客様の言葉を確認し、連絡の時期から面談の結果まで追いかけます。"
    >
      {j ? (
        <>
          <Tag>{data.labels[j.state] || j.state}</Tag>
          <p>{j.detail}</p>
          {j.nextAt && <p>次の確認：{date(j.nextAt)}</p>}
        </>
      ) : (
        <Note>
          確認した発言・商談メモから、保留の理由や次回の約束を登録できます。
        </Note>
      )}
      {p && (
        <div className="product-stack">
          {p.data.stalledQuote && <p>保留の理由：「{p.data.stalledQuote}」</p>}
          {p.data.conditionQuote && (
            <p>次に進む条件：「{p.data.conditionQuote}」</p>
          )}
          {p.data.industry === "recruitment" && (
            <>
              <p>
                候補者の希望求人：
                {p.data.jobWishQuote ? `「${p.data.jobWishQuote}」` : "未確認"}
              </p>
              <p>
                転職希望時期：
                {p.data.jobChangeTimingQuote
                  ? `「${p.data.jobChangeTimingQuote}」`
                  : "未確認"}
              </p>
              <Note>
                転職希望時期は候補者の言葉をそのまま記録しています。次回の連絡日時とは別です。
              </Note>
            </>
          )}
          {p.data.promiseQuote && (
            <p>
              次回の約束：「{p.data.promiseQuote}」 · {date(p.data.promiseAt)}
            </p>
          )}
          {p.data.hypothesis && (
            <Note>
              担当者の仮説（照合・文案には使いません）：{p.data.hypothesis}
            </Note>
          )}
          <small>
            確認：{date(p.updated_at)} · 版 {p.version}
          </small>
        </div>
      )}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setOpened(true);
        }}
      >
        <summary>
          {p ? "条件・次回の約束を確認し直す" : "お客様の言葉から条件を登録"}
        </summary>
        {opened && (
          <ProfileForm
            key={`${customerId}:${p?.version || 0}`}
            data={data}
            url={url}
            done={done}
          />
        )}
      </details>
      {p && (
        <Action
          run={() => api(`${base}/assistant/scan-customer`, { customerId })}
          done={done}
        >
          このお客様の次の連絡案を確認
        </Action>
      )}
      {data.appointments.length > 0 && (
        <details>
          <summary>予約・来場・面談結果を確認</summary>
          <Note>
            既存の予約記録です。本人・担当者・日時を確認してください。新しい空き枠や予約は作成しません。
          </Note>
          {data.appointments.map((a) => (
            <div key={`${a.id}:${a.version}`} className="product-stack">
              <h4>{a.title}</h4>
              <p>
                {date(a.starts_at)} · <Status value={a.state} />
              </p>
              {data.confirmed.some((f) => f.appointment_id === a.id) && (
                <>
                  <Tag>担当者確認済み</Tag>
                  <Action
                    run={() =>
                      api(`${url}/meetings/${a.id}/confirmation`, {}, "DELETE")
                    }
                    done={done}
                  >
                    予約の確認・成果の関連付けを取り消す
                  </Action>
                </>
              )}
              <Form
                button="この顧客の予約として確認"
                onSubmit={(v) =>
                  api(`${url}/meetings/${a.id}/confirm`, {
                    version: a.version,
                    confirmed: true,
                    proposalId: v.proposalId || null,
                  })
                }
                onDone={done}
              >
                <Field label="予約につながった連絡（関連を確認できる場合のみ）">
                  <select
                    name="proposalId"
                    defaultValue={
                      data.confirmed.find((f) => f.appointment_id === a.id)
                        ?.proposal_id || ""
                    }
                  >
                    <option value="">関連は未確認</option>
                    {data.proposals.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.draft.slice(0, 60)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="本人・担当者・日時が正しいことを確認">
                  <input type="checkbox" required />
                </Field>
              </Form>
              <Form
                button="実施結果を確認して保存"
                onSubmit={(v) =>
                  api(`${base}/meetings/${a.id}/result`, {
                    version: a.version,
                    state: v.state,
                    deal: v.deal,
                    note: v.note,
                  })
                }
                onDone={done}
              >
                <Field label="確認した結果">
                  <select
                    name="state"
                    defaultValue={
                      a.state === "attended" ? "attended" : "cancelled"
                    }
                  >
                    <option value="attended">来場・面談を実施</option>
                    <option value="cancelled">取消</option>
                    <option value="no_show">実施できず</option>
                  </select>
                </Field>
                <Field label="商談の状況">
                  <select name="deal" defaultValue="unknown">
                    <option value="unknown">未確認</option>
                    <option value="uncontracted">引き続き検討</option>
                    <option value="won">成約済み</option>
                  </select>
                </Field>
                <Field label="確認した内容">
                  <textarea name="note" required maxLength={10000} />
                </Field>
              </Form>
            </div>
          ))}
        </details>
      )}
      <details>
        <summary>商談と作業時間の記録</summary>
        <p>
          関連を確認した有効な予約：{data.metrics.attributedBookings}件 · 実施：
          {data.metrics.attended}件 · 取消・未実施：{data.metrics.cancelled}件
        </p>
        <p>
          比較記録：{data.metrics.measuredReviews}件 · 確認時間：
          {Math.round(data.metrics.reviewSeconds / 60)}分 · 推定削減時間：
          {Math.round(data.metrics.estimatedSavedSeconds / 60)}分
        </p>
        <Note>
          予約と連絡の関連を担当者が確認した記録です。つなぐによる純増を証明する値ではありません。削減時間は従来の所要時間と実際の確認時間との差です。
        </Note>
        {data.proposals.length > 0 && (
          <Form
            button="時間の比較を記録"
            onSubmit={(v) =>
              api(`${url}/measurements`, {
                proposalId: v.proposalId,
                baselineSeconds: Number(v.baselineSeconds),
                reviewSeconds: Number(v.reviewSeconds),
              })
            }
            onDone={done}
          >
            <Field label="送信済みの連絡">
              <select name="proposalId">
                {data.proposals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.draft.slice(0, 60)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="従来この作業にかけていた時間（秒）">
              <input
                name="baselineSeconds"
                type="number"
                min="1"
                max="7200"
                required
              />
            </Field>
            <Field label="実際に計測した確認・編集時間（秒）">
              <input
                name="reviewSeconds"
                type="number"
                min="1"
                max="7200"
                required
              />
            </Field>
            <Note>同じ送信済み提案への二重登録は集計しません。</Note>
          </Form>
        )}
      </details>
    </Section>
  );
}
function ProfileForm({ data, url, done }) {
  const p = data.profile,
    d = p?.data || {},
    initial = p ? `${p.evidence.kind}:${p.evidence.id}` : "",
    [source, setSource] = useState(initial),
    [industry, setIndustry] = useState(data.business?.industry || d.industry || "general"),
    selected = data.sources.find((s) => `${s.kind}:${s.id}` === source);
  if (!data.sources.length)
    return (
      <Note>
        根拠にする顧客の発言がない場合は、下の「面談・電話のメモ」に確認した内容を保存してください。
      </Note>
    );
  return (
    <Form
      button="原文と条件を確認して保存"
      onSubmit={(v) =>
        api(
          url,
          {
            version: p?.version || 0,
            sourceKind: selected?.kind,
            sourceId: selected?.id,
            industry,
            enabled: v.enabled === "true",
            stalledQuote: v.stalledQuote,
            conditionQuote: v.conditionQuote,
            jobWishQuote:
              industry === "recruitment" ? v.jobWishQuote || "" : "",
            jobChangeTimingQuote:
              industry === "recruitment" ? v.jobChangeTimingQuote || "" : "",
            promiseQuote: v.promiseQuote,
            terms: (v.terms || "")
              .split(/[、,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
            promiseAt: v.promiseAt ? new Date(v.promiseAt).toISOString() : null,
            waitDays: Number(v.waitDays),
            phase: v.phase,
            hypothesis: v.hypothesis,
          },
          "PUT",
        )
      }
      onDone={done}
    >
      <Field label="原文（このお客様の発言・確認済みメモ）">
        <select
          required
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">選択してください</option>
          {data.sources.map((s) => (
            <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
              {s.kind === "message" ? "発言" : "メモ"}：{s.body.slice(0, 80)}
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <blockquote className="product-draft">{selected.body}</blockquote>
      )}
      <Note>
        事実欄は原文から抜き出してください。解釈や推測は仮説欄へ。個人の属性や採用・融資の適格性を推測する機能はありません。
      </Note>
      <Field label="主事業（会社設定を適用）">
        <select
          name="industry"
          disabled={!!data.business?.industry}
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
        >
          {(!data.business?.industry || industry === "general") && <option value="general">その他</option>}
          {(!data.business?.industry || industry === "estate") && <option value="estate">不動産</option>}
          {(!data.business?.industry || industry === "bridal") && <option value="bridal">ブライダル</option>}
          {(!data.business?.industry || industry === "recruitment") && <option value="recruitment">人材紹介</option>}
        </select>
      </Field>
      <Field label="保留の理由（原文の抜粋）">
        <textarea
          name="stalledQuote"
          defaultValue={d.stalledQuote || ""}
          maxLength={500}
        />
      </Field>
      <Field label="次に進む条件（原文の抜粋）">
        <textarea
          name="conditionQuote"
          defaultValue={d.conditionQuote || ""}
          maxLength={500}
        />
      </Field>
      {industry === "recruitment" && (
        <>
          <Field label="候補者の希望求人（原文の抜粋）">
            <textarea
              name="jobWishQuote"
              defaultValue={d.jobWishQuote || ""}
              maxLength={500}
              placeholder="例：東京勤務の営業職で、在宅勤務もできる求人が希望です"
            />
          </Field>
          <Field label="転職希望時期（原文の抜粋）">
            <textarea
              name="jobChangeTimingQuote"
              defaultValue={d.jobChangeTimingQuote || ""}
              maxLength={500}
              placeholder="例：年明け頃／いい求人があれば／まだ決めていない"
            />
          </Field>
          <Note>
            時期が曖昧でも、そのまま保存できます。確定日には変換しません。未確認なら空欄にし、キャリア面談で伺えます。
          </Note>
        </>
      )}
      <Field label="新着情報と照合する条件の語句（カンマ区切り）">
        <input
          name="terms"
          defaultValue={(d.terms || []).join(", ")}
          placeholder="金利、駅徒歩10分以内、少人数、勤務地"
        />
      </Field>
      <Field label="次回の約束（原文の抜粋）">
        <textarea
          name="promiseQuote"
          defaultValue={d.promiseQuote || ""}
          maxLength={500}
        />
      </Field>
      {industry === "recruitment" && (
        <Note>
          次回の連絡日時は、別途候補者と約束した場合だけ入力してください。転職希望時期から自動設定しません。
        </Note>
      )}
      <Field label="確認した次回の連絡日時（端末のタイムゾーン）">
        <input
          name="promiseAt"
          type="datetime-local"
          defaultValue={localDate(d.promiseAt)}
        />
      </Field>
      <Field label="担当者が確認した段階">
        <select name="phase" defaultValue={d.phase || "considering"}>
          <option value="considering">条件を検討中</option>
          <option value="scheduling">日程調整に進む</option>
        </select>
      </Field>
      <Field label="返信を待つ日数">
        <input
          name="waitDays"
          type="number"
          min="1"
          max="30"
          defaultValue={d.waitDays || 3}
          required
        />
      </Field>
      <Field label="担当者の仮説（照合・文案には使用しません）">
        <textarea
          name="hypothesis"
          defaultValue={d.hypothesis || ""}
          maxLength={1000}
        />
      </Field>
      <Field label="条件の追跡">
        <select name="enabled" defaultValue={String(d.enabled !== false)}>
          <option value="true">追跡する</option>
          <option value="false">停止する</option>
        </select>
      </Field>
    </Form>
  );
}
