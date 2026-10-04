import { HarnessConversation } from "./HarnessConversation.jsx";
import { GoogleConnections } from "./GoogleConnections.jsx";
import { CustomerRecordings } from "./CustomerRecordings.jsx";
import { BusinessSettings } from "./Business.jsx";
import { CustomerFollowup } from "./Followup.jsx";
import { AssistantPanel, AssistantProposal } from "./Assistant.jsx";
import {
  MeetingOverview,
  MeetingConnections,
  MeetingInbox,
} from "./MeetingHub.jsx";
import React, { useState, useEffect, useMemo } from "react";
import {
  B,
  Field,
  Title,
  Section,
  Note,
  Tag,
  Modal,
  Stat,
  Avatar,
} from "../platform/ui.jsx";
import { api, useData, date, label } from "./api.js";
import { State, Status, Blank, Form, Action } from "./shared.jsx";
export function Sales({ tenant, path, me }) {
  const view = path.split("/")[2] || "home";
  const base = `/api/tenants/${tenant}`,
    { data, error, refresh } = useData(`${base}/workspace?view=${view}`),
    [selected, setSelected] = useState(null),
    [filter, setFilter] = useState("pending"),
    [customerFilter, setCustomerFilter] = useState("all"),
    [meetingRevision, setMeetingRevision] = useState(0);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!data || q.get("tenant") !== tenant) return;
    const p = data.proposals.find(
      (p) => p.id === q.get("assistant") && p.oa_id === q.get("oa"),
    );
    if (p) {
      setSelected({ kind: "proposal", value: p });
      history.replaceState(null, "", location.pathname);
      try {
        sessionStorage.removeItem("assistant_return");
      } catch {}
    }
  }, [data, tenant]);
  const customerMap = useMemo(
    () => new Map((data?.customers || []).map((c) => [c.id, c])),
    [data?.customers],
  );
  const pendingByCustomer = useMemo(() => {
    const map = new Map();
    for (const p of data?.proposals || [])
      if (p.state === "pending" && !map.has(p.customer_id))
        map.set(p.customer_id, p);
    return map;
  }, [data?.proposals]);
  useEffect(() => setSelected(null), [tenant, path]);
  if (!data) return <State error={error} />;
  if (
    view === "connections" &&
    new URLSearchParams(location.search).get("tenant") &&
    new URLSearchParams(location.search).get("tenant") !== tenant
  )
    return (
      <State error="接続先の企業へ切替中です。切り替わらない場合は所属を確認し、接続設定をメニューから開き直してください。" />
    );
  if (view === "connections")
    return (
      <GoogleConnections
        key={tenant}
        tenant={tenant}
        accounts={data.accounts}
        customers={data.customers}
        me={me}
      />
    );
  const resolve = (p) => customerMap.get(p.customer_id);
  const pending = data.proposals.filter((p) => p.state === "pending");
  const bulkPending = pending.filter(
    (p) => !p.trigger.startsWith("assistant:"),
  );
  return (
    <>
      <Title
        eyebrow="YOUR WORKSPACE"
        title={
          view === "home"
            ? "今日の、いいきっかけ。"
            : view === "dashboard"
              ? "つながりを、成果へ。"
              : view === "customers"
                ? "一人ひとりを、もっと深く。"
                : "面談の続きを、ていねいに。"
        }
        description={
          view === "home"
            ? "お客様の状況に合ったご連絡を、確認して届けましょう。"
            : "営業の状況と、その先のアクションを確認します。"
        }
      >
        <B variant="secondary" icon="RefreshCw" onClick={refresh}>
          更新
        </B>
      </Title>
      {view === "home" && (
        <BusinessSettings tenant={tenant} onChange={refresh} />
      )}
      {new URLSearchParams(location.search).get("tenant") &&
        new URLSearchParams(location.search).get("tenant") !== tenant && (
          <Note tone="amber">
            この提案の企業へ切替中です。切り替わらない場合は所属・閲覧権限を確認してください。
          </Note>
        )}
      {view === "home" && (
        <>
          <div className="product-welcome">
            <p className="product-kicker">A LITTLE MORE HUMAN.</p>
            <h2>
              {pending.length
                ? `${pending.length}件の提案が、確認を待っています。`
                : "次のきっかけを、育てていきましょう。"}
            </h2>
            <p>過去の会話と新しい情報をもとに、お客様に合う次の一歩を。</p>
          </div>
          <AssistantPanel
            tenant={tenant}
            accounts={data.accounts}
            customers={data.customers}
            onRefresh={refresh}
          />
          <div className="product-tabs">
            {[
              ["pending", "確認待ち"],
              ["approved", "承認済み"],
              ["held", "保留"],
              ["sent", "送信済み"],
              ["cancelled", "見送り"],
              ["expired", "期限・根拠の再確認"],
              ["uncertain", "配送結果の確認待ち"],
            ].map(([id, text]) => (
              <B
                key={id}
                variant="secondary"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {text} {data.proposals.filter((p) => p.state === id).length}
              </B>
            ))}
          </div>
          {filter === "pending" && (
            <div
              className="product-actions"
              style={{
                marginBottom: "16px",
                display: "flex",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <Action
                variant="primary"
                icon="Sparkles"
                run={async () => {
                  await Promise.all(
                    data.accounts.map((acc) =>
                      api(`${base}/accounts/${acc.id}/cadence/generate-all`, {
                        cadenceDays: 1,
                        maxCount: 10,
                      }).catch((e) => ({ ok: false, error: e.message })),
                    ),
                  );
                }}
                done={refresh}
              >
                ✨ AI提案を生成する（ご連絡の候補を探索）
              </Action>
              {bulkPending.length > 0 && (
                <Action
                  variant="secondary"
                  icon="CheckCheck"
                  run={() => {
                    const byOa = {};
                    for (const p of bulkPending) {
                      byOa[p.oa_id] = byOa[p.oa_id] || [];
                      byOa[p.oa_id].push({ id: p.id, version: p.version });
                    }
                    return Promise.all(
                      Object.entries(byOa).map(([oaId, proposals]) =>
                        api(`${base}/accounts/${oaId}/proposals/bulk-approve`, {
                          proposals,
                          mode: "approve_only",
                        }),
                      ),
                    );
                  }}
                  done={refresh}
                >
                  確認待ち {pending.length}件を一括承認（下書き承認）
                </Action>
              )}
            </div>
          )}
          {filter === "held" &&
            data.proposals.some((p) => p.state === "held") && (
              <div
                className="product-actions"
                style={{
                  marginBottom: "16px",
                  display: "flex",
                  gap: "8px",
                  flexWrap: "wrap",
                }}
              >
                <Action
                  variant="primary"
                  run={() => {
                    const heldList = data.proposals.filter(
                      (p) => p.state === "held",
                    );
                    const byOa = {};
                    for (const p of heldList) {
                      byOa[p.oa_id] = byOa[p.oa_id] || [];
                      byOa[p.oa_id].push(p.id);
                    }
                    return Promise.all(
                      Object.entries(byOa).map(([oaId, proposalIds]) =>
                        api(`${base}/accounts/${oaId}/proposals/bulk-resume`, {
                          proposalIds,
                        }),
                      ),
                    );
                  }}
                  done={refresh}
                >
                  保留中の提案を一括で確認待ちに戻す
                </Action>
              </div>
            )}
          <div className="product-list">
            {data.proposals
              .filter((p) => p.state === filter)
              .map((p) => (
                <article key={`${p.oa_id}:${p.id}`} className="product-card">
                  <div className="product-row">
                    <div className="product-actions">
                      <Avatar name={resolve(p)?.name} />
                      <div>
                        <h3>{resolve(p)?.name || "顧客"}</h3>
                        <p>{p.oa_name}</p>
                      </div>
                    </div>
                    <Tag tone={p.confidence === "high" ? "rose" : "blue"}>
                      {p.confidence === "high" ? "おすすめ" : "確認して判断"}
                    </Tag>
                  </div>
                  <div className="product-meta">
                    <Tag>{label(p.trigger)}</Tag>
                    <Status value={p.state} />
                  </div>
                  <h3>このご連絡をおすすめする理由</h3>
                  <p>{p.reason}</p>
                  <div className="product-draft">{p.draft}</div>
                  {p.hold_reason && (
                    <Note tone="amber">
                      ⚠️ <strong>保留理由:</strong> {p.hold_reason}
                    </Note>
                  )}
                  <B
                    icon="ArrowRight"
                    variant="secondary"
                    onClick={() => setSelected({ kind: "proposal", value: p })}
                  >
                    内容を確認する
                  </B>
                </article>
              ))}
            {!data.proposals.some((p) => p.state === filter) && (
              <div style={{ textAlign: "center", padding: "32px 16px" }}>
                <Blank
                  title={
                    filter === "pending"
                      ? "確認待ちのAI提案はありません"
                      : "この状態の提案はありません"
                  }
                  description={
                    filter === "pending"
                      ? "友だちとの過去のやり取りや休眠状態から、AIが連絡すべき候補者とメッセージ案を探索・提案します。"
                      : "連携した情報から提案が作られると、ここに表示されます。"
                  }
                />
                {filter === "pending" && (
                  <div
                    style={{
                      marginTop: "16px",
                      display: "flex",
                      justifyContent: "center",
                    }}
                  >
                    <Action
                      variant="primary"
                      icon="Sparkles"
                      run={async () => {
                        await Promise.all(
                          data.accounts.map((acc) =>
                            api(
                              `${base}/accounts/${acc.id}/cadence/generate-all`,
                              {
                                cadenceDays: 1,
                                maxCount: 10,
                              },
                            ).catch((e) => ({ ok: false, error: e.message })),
                          ),
                        );
                      }}
                      done={refresh}
                    >
                      ✨ 今日のAI提案を生成する（ご連絡の候補を探索）
                    </Action>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {["home", "dashboard", "meetings"].includes(view) && (
        <MeetingOverview
          key={meetingRevision}
          tenant={tenant}
          accounts={data.accounts}
          onResult={(a) => setSelected({ kind: "meeting", value: a })}
        />
      )}
      {view === "dashboard" && (
        <>
          <div className="product-stats">
            <Stat
              label="LINE経由の予約"
              value={data.appointments.length}
              unit="件"
              icon="CalendarDays"
              caption="取り込めた予約の累計"
            />
            <Stat
              label="追跡リンク一致"
              value={
                data.appointments.filter(
                  (a) => a.attribution === "tsunagu_link",
                ).length
              }
              unit="件"
              icon="Sparkles"
              caption="追跡IDで照合した予約。成果確定前"
            />
            <Stat
              label="面談実施"
              value={
                data.appointments.filter((a) => a.state === "attended").length
              }
              unit="件"
              caption="担当者が確認済み"
            />
            <Stat
              label="請求確定"
              value="—"
              unit=""
              caption="請求ルールの設定後に集計"
            />
          </div>
          <div className="product-grid">
            <Section title="アポを増やす余地">
              <p className="product-count">
                {
                  data.customers.filter(
                    (c) =>
                      c.mode === "ai" &&
                      !["won", "booked", "result_pending"].includes(c.stage),
                  ).length
                }
                <small> 人</small>
              </p>
              <p className="product-muted">AIが提案できる状態のお客様</p>
              <p className="product-muted">
                確認待ち {pending.length}件 ／ 本人対応{" "}
                {data.customers.filter((c) => c.mode === "human").length}人
              </p>
            </Section>
            <Section title="作業時間">
              <Note>
                作業時間と手入力時の推定時間は、計測データがそろってから比較します。未取得をゼロとして扱いません。
              </Note>
            </Section>
          </div>
        </>
      )}
      {view === "customers" && (
        <Section title="担当する顧客">
          <div className="product-tabs" style={{ marginBottom: "16px" }}>
            <B
              variant="secondary"
              aria-pressed={customerFilter === "all"}
              onClick={() => setCustomerFilter("all")}
            >
              全員 ({data.customers.length})
            </B>
            <B
              variant="secondary"
              aria-pressed={customerFilter === "has_proposal"}
              onClick={() => setCustomerFilter("has_proposal")}
            >
              💡 AI提案あり (
              {data.customers.filter((c) => pendingByCustomer.has(c.id)).length}
              )
            </B>
          </div>
          {data.customers.length ? (
            data.customers
              .filter((c) => {
                if (customerFilter === "has_proposal") {
                  return pendingByCustomer.has(c.id);
                }
                return true;
              })
              .map((c) => {
                const pendingProposal = pendingByCustomer.get(c.id);
                return (
                  <div key={c.id} className="product-row">
                    <div className="product-actions">
                      <Avatar name={c.name} />
                      <div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <h3>{c.name}</h3>
                          {pendingProposal && (
                            <Tag tone="rose" dot>
                              AI提案あり
                            </Tag>
                          )}
                        </div>
                        <p>
                          {label(c.stage)} · {label(c.mode)}
                        </p>
                      </div>
                    </div>
                    <div className="product-actions">
                      {pendingProposal && (
                        <B
                          variant="primary"
                          onClick={() =>
                            setSelected({
                              kind: "proposal",
                              value: pendingProposal,
                            })
                          }
                        >
                          提案を確認
                        </B>
                      )}
                      <B
                        variant="secondary"
                        onClick={() =>
                          setSelected({ kind: "customer", value: c })
                        }
                      >
                        状況を確認
                      </B>
                    </div>
                  </div>
                );
              })
          ) : (
            <Blank
              title="お客様の情報はまだありません"
              description="公式LINEの連携後、権限のあるお客様が表示されます。"
            />
          )}
        </Section>
      )}
      {view === "meetings" && (
        <>
          {data.accounts.map((account) => (
            <MeetingInbox
              key={account.id}
              tenant={tenant}
              account={account}
              revision={meetingRevision}
              onLinked={() => {
                refresh();
                setMeetingRevision((n) => n + 1);
              }}
            />
          ))}
          {data.accounts.map((account) => (
            <MeetingConnections
              key={account.id}
              tenant={tenant}
              account={account}
              onChange={() => setMeetingRevision((n) => n + 1)}
            />
          ))}
          <Section
            title="予約と面談結果"
            sub="録音がない対面の打ち合わせも、ここから結果とメモを残せます。"
          >
            {data.appointments.length ? (
              data.appointments.map((a) => (
                <div key={`${a.oa_id}:${a.id}`} className="product-row">
                  <div>
                    <h3>{resolve(a)?.name || a.title}</h3>
                    <p>
                      {date(a.starts_at)} · {a.title}
                    </p>
                  </div>
                  <div className="product-actions">
                    <Status value={a.state} />
                    {(() => {
                      try {
                        const link = (
                          typeof a.details === "string"
                            ? JSON.parse(a.details)
                            : a.details
                        )?.recording?.fileUrl;
                        return link &&
                          /^https:\/\/(drive|docs)\.google\.com\//.test(
                            link,
                          ) ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            録画・議事録を開く
                          </a>
                        ) : null;
                      } catch {
                        return null;
                      }
                    })()}
                    <B
                      variant="secondary"
                      onClick={() => setSelected({ kind: "meeting", value: a })}
                    >
                      結果を記録
                    </B>
                  </div>
                </div>
              ))
            ) : (
              <Blank
                title="面談の予定はまだありません"
                description="予約サービスやカレンダーから確認できた予定を表示します。"
              />
            )}
          </Section>
        </>
      )}
      <Modal
        open={selected}
        title={
          selected?.kind === "proposal"
            ? "ご連絡の確認"
            : selected?.kind === "meeting"
              ? "面談結果を記録"
              : "お客様の状況"
        }
        onClose={() => setSelected(null)}
        wide
      >
        {selected?.kind === "proposal" && (
          <Proposal
            key={`${selected.value.id}:${selected.value.version}`}
            p={selected.value}
            base={`${base}/accounts/${selected.value.oa_id}`}
            customer={resolve(selected.value)}
            updated={refresh}
            done={() => {
              setSelected(null);
              refresh();
            }}
          />
        )}
        {selected?.kind === "customer" && (
          <Customer
            c={selected.value}
            base={base}
            updated={refresh}
            done={() => {
              setSelected(null);
              refresh();
            }}
          />
        )}
        {selected?.kind === "meeting" && (
          <>
            <MeetingInbox
              tenant={tenant}
              account={{ id: selected.value.oa_id }}
              appointment={selected.value}
              onLinked={() => {
                setSelected(null);
                refresh();
                setMeetingRevision((n) => n + 1);
              }}
            />
            <Form
              onDone={() => {
                setSelected(null);
                refresh();
              }}
              onSubmit={(v) =>
                api(
                  `${base}/accounts/${selected.value.oa_id}/meetings/${selected.value.id}/result`,
                  { ...v, version: selected.value.version },
                )
              }
            >
              <Field label="実施状況">
                <select name="state">
                  <option value="attended">実施した</option>
                  <option value="cancelled">キャンセル</option>
                  <option value="no_show">欠席</option>
                </select>
              </Field>
              <Field label="契約の状況">
                <select name="deal">
                  <option value="unknown">未確認</option>
                  <option value="uncontracted">まだ契約していない</option>
                  <option value="won">契約済み</option>
                </select>
              </Field>
              <Field label="商談の内容・保留理由">
                <textarea name="note" maxLength={10000} />
              </Field>
              <Field label="今後の対応">
                <select
                  name="mode"
                  defaultValue={resolve(selected.value)?.mode || "ai"}
                >
                  <option value="ai">AIからの提案を受ける</option>
                  <option value="human">本人が対応する</option>
                  <option value="stopped">追客を停止する</option>
                </select>
              </Field>
              <Note>
                契約済みの場合は、営業追客を停止します。結果が未確認の場合は、確認が済むまで送信を保留します。
              </Note>
            </Form>
          </>
        )}
      </Modal>
    </>
  );
}
function Proposal({ p, base, customer, done, updated }) {
  if (p.trigger.startsWith("assistant:"))
    return (
      <AssistantProposal
        p={p}
        base={base}
        customer={customer}
        done={done}
        updated={updated}
      />
    );
  return <OrdinaryProposal p={p} base={base} customer={customer} done={done} />;
}
function OrdinaryProposal({ p, base, customer, done }) {
  const { data, error } = useData(`${base}/customers/${p.customer_id}`),
    [editing, setEditing] = useState(false),
    [holding, setHolding] = useState(false),
    [schedule, setSchedule] = useState("");
  if (!data) return <State error={error} />;
  return (
    <div className="product-stack">
      <div className="product-actions">
        <Avatar name={customer?.name} />
        <h3>{customer?.name}</h3>
        <Status value={p.state} />
      </div>
      <Note>{p.reason}</Note>
      {p.hold_reason && <Note tone="amber">【保留中】{p.hold_reason}</Note>}
      {editing ? (
        <Form
          button="変更して再確認へ戻す"
          onSubmit={(v) =>
            api(
              `${base}/proposals/${p.id}`,
              { version: p.version, draft: v.draft, assetId: p.asset_id },
              "PATCH",
            )
          }
          onDone={done}
        >
          <Field label="送信する文面">
            <textarea
              name="draft"
              required
              maxLength={5000}
              defaultValue={p.draft}
            />
          </Field>
        </Form>
      ) : (
        <div className="product-draft">{p.draft}</div>
      )}
      {p.asset_id && <Tag>登録素材を添付</Tag>}
      {!editing && !["sent", "sending", "uncertain"].includes(p.state) && (
        <B variant="ghost" onClick={() => setEditing(true)}>
          文面を修正する
        </B>
      )}
      <Section title="会話・確認済みのメモ">
        <div className="product-conversation">
          {data.messages.map((m) => (
            <div key={m.id} className={`product-message ${m.direction}`}>
              <small>
                {date(m.occurred_at)} · {m.source}
              </small>
              {m.body}
            </div>
          ))}
          {data.notes.map((n) => (
            <div key={n.id} className="product-message">
              <small>
                {n.confirmed_by ? "確認済みメモ" : "確認前のメモ"} ·{" "}
                {date(n.created_at)}
              </small>
              {n.body}
            </div>
          ))}
          {!data.messages.length && !data.notes.length && (
            <p className="product-muted">会話・メモはまだありません。</p>
          )}
        </div>
      </Section>
      {["pending", "approved"].includes(p.state) && !editing && (
        <>
          <Field label="送信タイミング（空欄なら今すぐ）">
            <input
              type="datetime-local"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </Field>
          <div className="product-actions">
            <Action
              variant="primary"
              run={() =>
                api(`${base}/proposals/${p.id}/approve`, {
                  version: p.version,
                  send: data.canSend,
                  ...(schedule
                    ? { scheduledAt: new Date(schedule).toISOString() }
                    : {}),
                })
              }
              done={done}
            >
              {data.canSend ? "承認して送信予約" : "この内容を承認"}
            </Action>
            <B variant="secondary" onClick={() => setHolding(true)}>
              保留にする
            </B>
          </div>
        </>
      )}
      {p.state === "held" && !editing && (
        <div
          className="product-actions"
          style={{
            marginTop: "16px",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <Action
            variant="primary"
            run={() =>
              api(`${base}/proposals/${p.id}/approve`, {
                version: p.version,
                send: data.canSend,
              })
            }
            done={done}
          >
            {data.canSend
              ? "内容を確認して送信する（保留解除・承認）"
              : "この内容を承認"}
          </Action>
          <Action
            variant="secondary"
            run={() => api(`${base}/proposals/${p.id}/resume`)}
            done={done}
          >
            保留を解除して確認待ちに戻す
          </Action>
        </div>
      )}
      {p.state === "uncertain" && (
        <Section title="配送結果の確認と手動対応">
          <Note tone="amber">
            Harnessへの配送要求後、通信切断またはタイムアウトにより最終結果が未確定です。LINE公式アカウント管理画面またはHarnessで送信状況を確認の上、以下のいずれかを選択してください。自動二重送信は防止されています。
          </Note>
          <div className="product-actions">
            <Action
              variant="primary"
              run={() =>
                api(`${base}/outbox/${p.id}:${p.version}/reconcile`, {
                  action: "mark_sent",
                })
              }
              done={done}
            >
              送信完了として記録
            </Action>
            <Action
              variant="secondary"
              run={() =>
                api(`${base}/outbox/${p.id}:${p.version}/reconcile`, {
                  action: "resend",
                })
              }
              done={done}
            >
              未送信を確認・再送キューへ
            </Action>
            <Action
              variant="danger"
              run={() =>
                api(`${base}/outbox/${p.id}:${p.version}/reconcile`, {
                  action: "cancel",
                })
              }
              done={done}
            >
              送信を取り消す
            </Action>
          </div>
        </Section>
      )}
      {holding && (
        <Form
          button="保留にする"
          onSubmit={(v) => api(`${base}/proposals/${p.id}/hold`, v)}
          onDone={done}
        >
          <Field label="保留の理由">
            <textarea name="reason" required maxLength={500} />
          </Field>
        </Form>
      )}
    </div>
  );
}
function Customer({ c, base, done, updated }) {
  const [contextRevision, setContextRevision] = useState(0);
  const contextChanged = () => {
    setContextRevision((n) => n + 1);
    updated?.();
  };
  const [oa, setOa] = useState(c.accounts?.[0] || ""),
    [result, setResult] = useState("");
  return (
    <div className="product-stack">
      <Form
        onSubmit={(v) =>
          api(
            `${base}/customers/${c.id}/mode`,
            { mode: v.mode, version: c.version },
            "PATCH",
          )
        }
        onDone={done}
      >
        <h3>{c.name}</h3>
        <Status value={c.stage} />
        <Field label="追客の進め方">
          <select name="mode" defaultValue={c.mode}>
            <option value="ai">AIからの提案を受ける</option>
            <option value="human">本人が対応する</option>
            <option value="stopped">追客を停止する</option>
          </select>
        </Field>
        <Note>
          対応方法を変えると、予約済みの営業メッセージは保留されます。本人対応から自動でAI対応に戻ることはありません。
        </Note>
      </Form>
      {c.accounts?.length > 1 && (
        <Field label="公式LINE">
          <select
            className="product-select"
            value={oa}
            onChange={(e) => setOa(e.target.value)}
          >
            {c.accounts.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      )}
      {oa && (
        <>
          <HarnessConversation key={`sync:${oa}:${c.id}`} base={`${base}/accounts/${oa}/customers/${c.id}`} onImported={contextChanged} />
          <CustomerConversation
            key={`${oa}:${c.id}:${contextRevision}`}
            base={`${base}/accounts/${oa}/customers/${c.id}`}
          />
          <CustomerFollowup
            key={oa}
            base={`${base}/accounts/${oa}`}
            customerId={c.id}
            onChange={updated}
          />
          <Section title="面談・電話のメモ">
            <Form
              button="確認済みのメモとして保存"
              onSubmit={(v) =>
                api(`${base}/accounts/${oa}/notes`, {
                  customerId: c.id,
                  body: v.body,
                })
              }
              onDone={done}
            >
              <Field label="伺った内容・保留理由・次回の約束">
                <textarea name="body" required maxLength={10000} />
              </Field>
            </Form>
          </Section>
          <CustomerRecordings
            key={`recording:${oa}:${c.id}`}
            base={`${base}/accounts/${oa}`}
            customer={c}
            onChange={contextChanged}
          />
          <Section title="次のご連絡を考える">
            <Form
              button="このお客様への提案を作る"
              onSubmit={async (v) => {
                const r = await api(
                  `${base}/accounts/${oa}/generate`,
                  { customerId: c.id, trigger: v.trigger },
                  "POST",
                  { "Idempotency-Key": crypto.randomUUID() },
                );
                if (r.id) done();
                else setResult(r.reason);
              }}
            >
              <Field label="今回のきっかけ・更新された情報">
                <textarea name="trigger" required maxLength={1000} />
              </Field>
              <Note>
                会話と確認済みメモを参考に提案を生成します。送信前に、内容を確認・承認できます。
              </Note>
            </Form>
            {result && <Note>{result}</Note>}
          </Section>
        </>
      )}
    </div>
  );
}
function CustomerConversation({ base }) {
  const { data, error } = useData(base);
  if (!data) return <State error={error} />;
  return (
    <Section title="会話とコンテキスト">
      <div className="product-conversation">
        {data.messages.map((m) => (
          <div className={`product-message ${m.direction}`} key={m.id}>
            <small>
              {date(m.occurred_at)} · {m.source}
            </small>
            {m.body}
          </div>
        ))}
        {data.notes.map((n) => (
          <div className="product-message" key={n.id}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                marginBottom: "4px",
                flexWrap: "wrap",
              }}
            >
              <small>
                {n.confirmed_by ? "確認済みのメモ" : "確認前のメモ"}
              </small>
              {n.source === "google_meet" && (
                <Tag tone="emerald">Google Meet 解析</Tag>
              )}
              {n.deal_state && n.deal_state !== "unknown" && (
                <Tag tone="sky">{label(n.deal_state)}</Tag>
              )}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
          </div>
        ))}
        {!data.messages.length && !data.notes.length && (
          <p className="product-muted">会話・メモはまだありません。</p>
        )}
      </div>
    </Section>
  );
}
