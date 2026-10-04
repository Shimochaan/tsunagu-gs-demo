import React, { useState } from "react";
import { Section, Field, Note, Tag } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Action, Form, State } from "./shared.jsx";

export function CalendarConnection({ tenant, oa }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(10);
  const base = `/api/tenants/${tenant}/accounts/${oa}/connectors/calendar`;
  const { data, error, refresh } = useData(base);
  if (!data) return <State error={error} />;
  const items = data.items.filter((item) =>
    item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <Section
      title="Googleカレンダーの予定"
      sub="メインカレンダーの追加・日時変更・キャンセルを約5分ごとに自動反映します。"
    >
      <p>
        {data.connected
          ? `${data.email} · 接続済み`
          : "Googleカレンダーは未接続です。Driveとは別に、予定の読み取り許可が必要です。"}
      </p>
      <Action
        disabled={!data.enabled}
        run={async () => {
          const r = await api(base + "/authorize", {});
          location.assign(r.url);
        }}
      >
        {data.connected ? "Googleカレンダーを再接続" : "Googleカレンダーを接続"}
      </Action>
      {data.connected && (
        <>
          <p>最終確認：{date(data.lastSync)} · 一覧は自動で更新されます。</p>
          {data.error && <Note>{data.error}</Note>}
          <Note>
            お客様との対応だけ初回に確認します。以降の日程変更は自動です。TimeRexにも同じ予約がある場合は「既存の予約」を選ぶと二重登録を防げます。
          </Note>
          {!data.items.length && (
            <p>
              反映された予定はまだありません。接続直後は次の自動確認をお待ちください。
            </p>
          )}
          {data.items.length > 0 && (
            <details>
              <summary>
                取り込んだ予定から面談を選ぶ（直近{data.items.length}件）
              </summary>
              <Field label="予定名で絞り込む">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setLimit(10);
                  }}
                />
              </Field>
              <p>面談として使う予定だけ、お客様を紐付けてください。</p>
              {!items.length && <p>該当する予定はありません。</p>}
              {items.slice(0, limit).map((item) => (
                <article className="product-card" key={item.id}>
                  <h3>{item.title}</h3>
                  <p>
                    {date(item.starts_at)} 〜 {date(item.ends_at)}
                  </p>
                  {item.state === "cancelled" ? (
                    <Tag>キャンセル済み</Tag>
                  ) : item.customer_id ? (
                    <Tag>
                      {data.customers.find((x) => x.id === item.customer_id)
                        ?.name || "お客様"}
                      と紐付け済み・更新は自動
                    </Tag>
                  ) : (
                    <CalendarLink
                      key={item.version}
                      item={item}
                      data={data}
                      base={base}
                      done={refresh}
                    />
                  )}
                </article>
              ))}
              {items.length > limit && (
                <button type="button" onClick={() => setLimit((n) => n + 10)}>
                  さらに10件表示
                </button>
              )}
            </details>
          )}
        </>
      )}
    </Section>
  );
}

function CalendarLink({ item, data, base, done }) {
  const [customer, setCustomer] = useState("");
  return (
    <Form
      button="この予定とお客様を紐付ける"
      onSubmit={async (v) => {
        await api(`${base}/items/${item.id}/link`, {
          version: item.version,
          customerId: customer,
          ...(v.appointmentId ? { appointmentId: v.appointmentId } : {}),
        });
        done();
      }}
    >
      <Field label="面談のお客様">
        <select
          required
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
        >
          <option value="">選択してください</option>
          {data.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="同じ面談の既存の予約">
        <select name="appointmentId" key={customer} defaultValue="">
          <option value="">既存の予約はない（新しく登録）</option>
          {data.appointments
            .filter((a) => a.customer_id === customer)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {date(a.starts_at)} · {a.title} ·{" "}
                {a.source === "timerex" ? "TimeRex" : "カレンダー"}
              </option>
            ))}
        </select>
      </Field>
    </Form>
  );
}
