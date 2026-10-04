import { ProposalEvents } from "./ProposalEvents.jsx";
import { AssistantConnections } from "./AssistantConnections.jsx";
import { AssistantGoogle } from "./AssistantGoogle.jsx";
import { CustomerTestDelivery } from "./CustomerTestDelivery.jsx";
import React, { useState, useRef } from "react";
import { B, Section, Field, Note, Tag } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Form, Action, State, Status } from "./shared.jsx";
const words = (s) =>
  s
    .split(/[、,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
export function AssistantPanel({ tenant, accounts, customers, onRefresh }) {
  const initiallyOpen = new URLSearchParams(location.search).get("settings") === "assistant";
  const [opened, setOpened] = useState(initiallyOpen);
  return (
    <Section
      title="気づきを、次のご連絡へ。"
      sub="返信・商談に関連するニュース・希望に合う新着から、ご連絡案を用意します。"
    >
      {accounts.map(a=><AssistantLoopStatus key={a.id} tenant={tenant} account={a}/>)}
      <details
        open={opened}
        onToggle={(e) => {
          setOpened(e.currentTarget.open);
        }}
      >
        <summary>アシスタントの設定・情報元</summary>
        {opened && (
          <div className="product-stack">
            <Note>まず顧客用LINEの希望条件と情報元を設定してください。担当者へのLINE通知は、この画面の下で別に設定できます。</Note>
            {accounts.map((a) => (
              <AccountAssistant
                key={a.id}
                tenant={tenant}
                account={a}
                customers={customers.filter((c) => c.accounts.includes(a.id))}
                onRefresh={onRefresh}
              />
            ))}
            <StaffLine tenant={tenant} />
            <ProposalEvents tenant={tenant} />
          </div>
        )}
      </details>
    </Section>
  );
}
function AssistantLoopStatus({tenant,account}) {
  const {data}=useData(`/api/tenants/${tenant}/accounts/${account.id}/assistant/loop`);
  if(!data || !data.enabled || !data.autoSheet) return null;
  return <Note tone={data.sheet?.state==='error'?'amber':undefined}>
    <p><strong>{account.name}：{data.scheduled?'自動で次の提案を準備しています':'手動で確認する環境です'}</strong></p>
    <p>物件更新：5分ごとに確認 · 文案：{data.autoDraft?'自動生成':'手動生成'} · ニュース：{data.researchEnabled?'1日1回調査':'停止中'}</p>
    <p>前回の物件確認：{data.sheet?.checked_at?date(data.sheet.checked_at):'初回の定期実行を待っています'}{data.sheet?.state==='error'?'（確認できませんでした。設定・情報元をご確認ください）':''}</p>
    <p>合うお客様が見つかった更新だけをお知らせします。顧客への送信は承認後です。</p>
  </Note>;
}
export function StaffLine({ tenant }) {
  const base = `/api/tenants/${tenant}/assistant-line`,
    { data, error, refresh } = useData(base),
    [pair, setPair] = useState(null);
  if (!data) return <State error={error} />;
  return (
    <Section title="担当者への通知用LINE（任意）" sub={data.limits}>
      {!data.configured ? (
        <Note>
          担当者へのLINE通知は未接続です。Webでの希望条件の登録・提案の確認は、この設定なしでも進められます。運営が通知用のつなぐ公式LINEを接続した後、担当者ごとに本人連携します。
        </Note>
      ) : (
        <>
          <p>
            本人連携：
            {
              {
                active: "連携済み",
                confirming: "LINEの確認コードを入力してください",
                pending: "LINEへの連携コード送信待ち",
                revoked: "解除済み",
                unlinked: "未連携",
              }[data.state]
            }
          </p>
          {data.state !== "active" && (
            <Action
              run={async () => setPair(await api(`${base}/pair`, {}))}
              done={refresh}
            >
              本人連携を始める
            </Action>
          )}
          {pair && (
            <Note>
              担当者用LINEへ次の文字列を送信してください（10分以内）。
              <pre className="assistant-token">{pair.text}</pre>
            </Note>
          )}
          {(pair || data.state === "confirming") && (
            <Form
              button="本人連携を完了する"
              onSubmit={(v) => api(`${base}/confirm`, v)}
              onDone={() => {
                setPair(null);
                refresh();
              }}
            >
              <Field label="LINEに届いた本人確認コード">
                <input name="code" required autoComplete="off" maxLength={30} />
              </Field>
            </Form>
          )}
          {data.state === "active" && (
            <Action
              run={() =>
                api(`${base}/settings`, { notifications: !data.notifications })
              }
              done={refresh}
            >
              {data.notifications ? "通知を停止する" : "LINEで提案を受け取る"}
            </Action>
          )}
          {data.state !== "unlinked" && (
            <Action
              variant="ghost"
              run={() => api(`${base}/revoke`, {})}
              done={() => {
                setPair(null);
                refresh();
              }}
            >
              本人連携を解除
            </Action>
          )}
        </>
      )}
      <details>
        <summary>通知を受け取る時間</summary>
        <Form
          key={JSON.stringify(data.preferences)}
          button="受信時間を保存"
          onSubmit={(v) =>
            api(`${base}/preferences`, {
              quietHours: v.quietHours === "true",
              startHour: Number(v.startHour),
              endHour: Number(v.endHour),
              maxDaily:Number(v.maxDaily),
              customerCooldownHours:Number(v.customerCooldownHours),
            })
          }
          onDone={refresh}
        >
          <Field label="受信時間（日本時間）">
            <select
              name="quietHours"
              defaultValue={String(data.preferences.quietHours)}
            >
              <option value="true">指定した時間帯だけ受け取る</option>
              <option value="false">時間帯を制限しない</option>
            </select>
          </Field>
          <Field label="受信開始（時）">
            <input
              name="startHour"
              type="number"
              min="0"
              max="23"
              required
              defaultValue={data.preferences.startHour}
            />
          </Field>
          <Field label="受信終了（時）">
            <input
              name="endHour"
              type="number"
              min="0"
              max="23"
              required
              defaultValue={data.preferences.endHour}
            />
          </Field>
          <Field label="1日の担当者通知上限"><input name="maxDaily" type="number" required min="1" max="30" defaultValue={data.preferences.maxDaily}/></Field>
          <Field label="同じ顧客の通知を空ける時間"><input name="customerCooldownHours" type="number" required min="1" max="72" defaultValue={data.preferences.customerCooldownHours}/></Field>
          <Note>
            既定は8〜21時です。時間外の提案は保留し、受信時間になってから再確認して通知します。待機中に期限が切れた提案は通知しません。顧客への送信は引き続き文面の承認が必要です。
          </Note>
        </Form>
      </details>
      {!!data.deliveries?.length && (
        <details>
          <summary>通知の待機・確認が必要な結果（最新20件）</summary>
          {data.deliveries.map((n) => (
            <div key={n.id} className="product-stack">
              <p>
                {date(n.created_at)} ·{" "}
                {n.lane === "reply" ? "返信の提案" : "ニュース・商品の提案"} ·{" "}
                {
                  {
                    queued: "通知待ち",
                    failed: "LINEが通知を受け付けませんでした",
                    uncertain: "通知の結果を確認できません",
                  }[n.state]
                }
              </p>
              {["failed", "uncertain"].includes(n.state) && (
                <Action
                  run={() => api(`${base}/notices/${n.id}/retry`, {})}
                  done={refresh}
                >
                  同じ通知を再試行（重複防止）
                </Action>
              )}
            </div>
          ))}
          <Note>
            再試行は同じ本文・宛先・重複防止キーを使います。初回から23時間以内、合計3試行まで。期限切れや文面・権限が変わった通知は再送しません。
          </Note>
        </details>
      )}
    </Section>
  );
}
function AccountAssistant({ tenant, account, customers, onRefresh }) {
  const base = `/api/tenants/${tenant}/accounts/${account.id}`,
    { data, error, refresh } = useData(`${base}/assistant?scope=settings`),
    [result, setResult] = useState("");
  if (!data) return <State error={error} />;
  return (
    <Section title={account.name}>
      <Note>顧客用LINE：{data.customerConnection?.connected ? "接続済み" : "接続設定を確認してください"}。{data.customerConnection?.readOnly ? "会話の受信・取込用です。顧客への送信は別の設定です。" : "担当者への通知用LINEとは別の接続です。"}</Note>
      <Note>
        登録済みの情報元：{data.sources.length}件（表示中）。JSONフィード：
        {data.feedConfigured
          ? "JSONフィード設定あり（同期時に確認）"
          : "未設定（Googleの物件台帳は下で別に接続できます）"}
        。文案AI：
        {data.aiConfigured ? "設定あり" : "未接続・参考テンプレートを使用"}
        。Web検索：
        {data.searchConfigured ? "検索・記事取得アダプタ設定あり" : "未設定（任意）"}。
      </Note>
      {(!data.business?.industry || data.business.industry === "estate") && <details>
        <summary>お客様の希望条件</summary>
        <Preferences base={base} customers={customers} saved={data.preferences} />
      </details>}
      {data.canManage && (<>
      <AssistantConnections base={`${base}/assistant/connections`} />
      <AssistantGoogle base={`${base}/assistant/google`} />
      <CustomerTestDelivery base={`${base}/assistant/customer-delivery`} />
      </>)}
      <Note>{data.detectionMode === "manual"
        ? "この環境の検知は手動です。顧客画面でLINEの新着を取り込んだ後、「今ある情報から提案を確認」を押します。検知を有効にしても、定期実行は始まりません。"
        : "定期検知は運営側の実行設定に従います。検知ONだけでは定期実行の稼働確認にはなりません。"}</Note>
      <div className="product-actions">
        <Action
          run={() =>
            api(`${base}/assistant/settings`, { enabled: !data.enabled })
          }
          done={refresh}
        >
          {data.enabled ? "提案の検知を停止" : "提案の検知を有効にする"}
        </Action>
        <Action
          run={async () => {
            const r = await api(`${base}/assistant/scan`, {});
            setResult(
              `${r.created}件の新しい提案を用意しました。返信は最後の着信から90秒後にまとめます。`,
            );
          }}
          done={() => {
            refresh();
            onRefresh();
          }}
        >
          今ある情報から提案を確認
        </Action>
        {data.canManage && (
          <Action
            disabled={!data.feedConfigured}
            run={async () => {
              const r = await api(`${base}/assistant/sync`, {});
              setResult(
                r.error ||
                  `${r.count}件の情報を同期しました。提案を確認ボタンで照合できます。`,
              );
            }}
            done={refresh}
          >
            情報元を同期
          </Action>
        )}
        {data.canManage && (
          <Action
            disabled={!data.searchConfigured}
            run={async () => {
              const r = await api(`${base}/assistant/discover`, {});
              setResult(
                r.error ||
                  r.detail ||
                  `関連記事を${r.imported}件取得しました。${r.rejected}件は重複・出典・日付・関連性の検証で除外しました。提案を確認ボタンで照合できます。`,
              );
            }}
            done={refresh}
          >
            関連記事を検索（1回）
          </Action>
        )}
      </div>
      {result && <p role="status">{result}</p>}
      {data.canManage && (
        <details>
          <summary>AI文案・関連記事・商品同期の定期実行</summary>
          <Note>
            検知を有効にした公式LINEだけが対象です。手動確認の環境では定期実行は始まりません。AIは初回文案と修正を合わせて1日20回まで。検索1回は1テーマ・最大5記事です。取得間隔は情報を探す頻度で、見つかった提案の通知を待たせる間隔ではありません。短くすると取得回数・接続先の利用料が増えます。
          </Note>
          <Form
            key={JSON.stringify(data.automation)}
            button="実行上限を確認して設定を保存"
            onSubmit={(v) =>
              api(`${base}/assistant/automation`, {
                autoDraft: v.autoDraft === "true",
                autoSearch: v.autoSearch === "true",
                autoFeed: v.autoFeed === "true",
                searchIntervalMinutes: Number(v.searchIntervalMinutes),
                feedIntervalMinutes: Number(v.feedIntervalMinutes),
                topics: words(v.topics),
              })
            }
            onDone={refresh}
          >
            <Field label="初回文案のAI生成">
              <select
                name="autoDraft"
                defaultValue={String(data.automation.autoDraft)}
              >
                <option value="false">停止</option>
                <option value="true" disabled={!data.aiConfigured}>
                  有効（新しい提案から）
                </option>
              </select>
            </Field>
            <Field label="関連記事の定期検索">
              <select
                name="autoSearch"
                defaultValue={String(data.automation.autoSearch)}
              >
                <option value="false">停止</option>
                <option value="true" disabled={!data.searchConfigured}>
                  有効（下の取得間隔）
                </option>
              </select>
            </Field>
            <Field label="関連記事を探す間隔">
              <select
                name="searchIntervalMinutes"
                defaultValue={String(data.automation.searchIntervalMinutes)}
              >
                {[60, 180, 360, 720, 1440].map((v) => (
                  <option key={v} value={v}>
                    {v < 1440 ? `${v / 60}時間` : "1日"}ごと・最大{1440 / v}
                    回/日
                  </option>
                ))}
              </select>
            </Field>
            <Field label={data.business?.industry ? "会社の主事業で設定した研究テーマ" : "検索テーマ（カンマ区切り・最大5件）"}>
              <input
                name="topics"
                readOnly={!!data.business?.industry}
                defaultValue={(data.business?.industry ? data.business.topics : data.automation.topics).join(", ")}
                placeholder="住宅ローン, 金利"
              />
            </Field>
            <Note>
              一般的な話題だけを入力してください。氏名や個人情報は含めないでください。確認済み商談メモにあるテーマを検索し、記事本文との一致を確認します。
            </Note>
            <Field label="商品・ニュースフィードの定期同期">
              <select
                name="autoFeed"
                defaultValue={String(data.automation.autoFeed)}
              >
                <option value="false">停止</option>
                <option value="true" disabled={!data.feedConfigured}>
                  有効（下の取得間隔）
                </option>
              </select>
            </Field>
            <Field label="商品フィードを取得する間隔">
              <select
                name="feedIntervalMinutes"
                defaultValue={String(data.automation.feedIntervalMinutes)}
              >
                {[15, 30, 60, 360, 1440].map((v) => (
                  <option key={v} value={v}>
                    {v < 60 ? `${v}分` : v < 1440 ? `${v / 60}時間` : "1日"}
                    ごと・最大{1440 / v}回/日
                  </option>
                ))}
              </select>
            </Field>
            <Note>
              手動取得も同じ日次回数に含みます。既定は検索・商品とも6時間ごとです。確認済み商品を登録・取込イベントで受信した場合は、この間隔を待たずに照合します。
            </Note>
          </Form>
          {data.acquisition?.map((r, i) => (
            <p key={i}>
              {date(r.created_at)} · {r.detail}
            </p>
          ))}
        </details>
      )}
      {data.canManage && (
        <details>
          <summary>ニュース・{data.business?.product || "商品"}の登録（確認済み情報）</summary>
          <SourceForm base={base} business={data.business} done={refresh} />
        </details>
      )}
      <div className="assistant-sources">
        {data.sources.map((s) => (
          <div key={s.id}>
            <Tag>{s.kind === "news" ? "ニュース" : data.business?.product || "商品"}</Tag>{" "}
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title}
            </a>
            <small>
              公開 {date(s.published_at)} · 確認 {date(s.checked_at)} · 期限{" "}
              {date(s.expires_at)}
            </small>
          </div>
        ))}
      </div>
    </Section>
  );
}
function Preferences({ base, customers, saved }) {
  const [cid, setCid] = useState(customers[0]?.id || ""),
    { data, error } = useData(cid ? `${base}/customers/${cid}` : null),
    [success, setSuccess] = useState("");
  const pref = saved.find((p) => p.customer_id === cid)?.data;
  return (
    <div className="product-stack">
      <Field label="お客様">
        <select
          value={cid}
          onChange={(e) => {
            setCid(e.target.value);
            setSuccess("");
          }}
        >
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {error && <State error={error} />}
      {data && (
        <Form
          key={cid}
          onSubmit={(v) =>
            api(`${base}/assistant/preferences/${cid}`, {
              ...v,
              maxPrice: Number(v.maxPrice),
              required: words(v.required),
              excluded: words(v.excluded),
            })
          }
          onDone={() =>
            setSuccess(
              "希望条件を保存しました。提案を確認ボタンで照合できます。",
            )
          }
        >
          <Field label="根拠の確認済み商談メモ">
            <select name="noteId" required defaultValue={pref?.noteId || ""}>
              <option value="">メモを選択</option>
              {data.notes
                .filter((n) => n.confirmed_by)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.body.slice(0, 100)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="希望エリア（情報元と同じ名称）">
            <input name="area" required defaultValue={pref?.area} />
          </Field>
          <Field label="予算上限（円）">
            <input
              name="maxPrice"
              type="number"
              min="1"
              required
              defaultValue={pref?.maxPrice}
            />
          </Field>
          <Field label="必須条件（カンマ区切り・すべて一致）">
            <input
              name="required"
              required
              defaultValue={pref?.required?.join(", ")}
              placeholder="駅徒歩10分以内, 3LDK"
            />
          </Field>
          <Field label="除外条件（カンマ区切り）">
            <input
              name="excluded"
              defaultValue={pref?.excluded?.join(", ")}
              placeholder="借地権"
            />
          </Field>
          <Note>
            条件が不明な商品は一致として扱いません。情報元のタグ表記と揃えてください。
          </Note>
        </Form>
      )}
      {success && <p role="status">{success}</p>}
    </div>
  );
}
function SourceForm({ base, business, done }) {
  const [kind, setKind] = useState("news");
  return (
    <Form
      button="確認した情報を登録"
      onSubmit={(v) =>
        api(`${base}/assistant/sources`, {
          id: v.id,
          kind,
          title: v.title,
          url: v.url,
          summary: v.summary,
          tags: words(v.tags),
          absentTags: words(v.absentTags || ""),
          publishedAt: new Date(v.publishedAt).toISOString(),
          eventAt: v.eventAt ? new Date(v.eventAt).toISOString() : null,
          checkedAt: new Date(v.checkedAt).toISOString(),
          expiresAt: new Date(v.expiresAt).toISOString(),
          area: kind === "product" ? v.area || null : null,
          price: kind === "product" && v.price ? Number(v.price) : null,
          status: kind === "product" ? v.status : "unknown",
          stock: kind === "product" && v.stock !== "" ? Number(v.stock) : null,
        })
      }
      onDone={done}
    >
      <Field label="種類">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="news">ニュース</option>
          <option value="product">{business?.product || "商品"}</option>
        </select>
      </Field>
      <Field label="情報元の管理ID（更新時は同じID）">
        <input name="id" pattern="[A-Za-z0-9_-]+" required />
      </Field>
      <Field label="記事・商品のタイトル">
        <input name="title" required maxLength={200} />
      </Field>
      <Field label="出典URL（HTTPS）">
        <input name="url" type="url" required placeholder="https://" />
      </Field>
      <Field label="出典に基づく要約">
        <textarea name="summary" required maxLength={1200} />
      </Field>
      <Field
        label={
          kind === "news"
            ? "話題タグ（商談メモと照合）"
            : "商品条件タグ（確認できた条件のみ）"
        }
      >
        <input
          name="tags"
          required
          placeholder={kind === "news" ? business?.topics?.[0] || "確認済みの話題" : business?.industry === "recruitment" ? "東京勤務, 営業職" : business?.industry === "bridal" ? "少人数, ガーデン" : "駅徒歩10分以内, 3LDK"}
        />
      </Field>
      <Field label="公開日時">
        <input name="publishedAt" type="datetime-local" required />
      </Field>
      <Field label="出来事の日時（不明なら空欄）">
        <input name="eventAt" type="datetime-local" />
      </Field>
      <Field label="出典・在庫を実際に確認した日時">
        <input name="checkedAt" type="datetime-local" required />
      </Field>
      <Field label="利用期限">
        <input name="expiresAt" type="datetime-local" required />
      </Field>
      {kind === "product" && (
        <>
          {(!business?.industry || business.industry === "estate") && <Field label="エリア（物件の詳細希望条件で照合する場合）">
            <input name="area" />
          </Field>}
          <Field label="該当しないことを確認済みの条件">
            <input name="absentTags" placeholder="借地権" />
          </Field>
          {business?.industry !== "recruitment" && <Field label="価格（円）">
            <input name="price" type="number" min="0" />
          </Field>}
          <Field label="公開・在庫状態（求人は募集状況）">
            <select name="status">
              <option value="unknown">未確認</option>
              <option value="available">公開中・案内可能</option>
              <option value="sold">{business?.industry === "recruitment" ? "募集終了" : "受付終了・売約済み"}</option>
              <option value="unpublished">公開前</option>
            </select>
          </Field>
          <Field label="在庫数・募集枠数（未確認なら空欄）">
            <input name="stock" type="number" min="0" />
          </Field>
        </>
      )}
    </Form>
  );
}
export function AssistantProposal({ p, base, customer, done, updated }) {
  const { data, error, refresh } = useData(
      `${base}/assistant/proposals/${p.id}`,
    ),
    [editing, setEditing] = useState(false),
    [generating, setGenerating] = useState(false),
    generationLock = useRef(false);
  if (!data) return <State error={error} />;
  const current = data.proposal;
  if (!current)
    return <Note>この提案は表示できません。最新状態を確認してください。</Note>;
  const evidence = current.evidence || {},
    mutable = ["pending", "approved", "held"].includes(current.state),
    valid = !current.problem;
  const makeDraft = async (instruction = "") => {
    if (generationLock.current) return;
    generationLock.current = true;
    setGenerating(true);
    try {
      await api(`${base}/assistant/proposals/${p.id}/generate`, {
        version: current.version,
        instruction,
      });
    } finally {
      generationLock.current = false;
      setGenerating(false);
      refresh();
      updated?.();
    }
  };
  return (
    <div className="product-stack">
      <div className="product-actions">
        <h3>{customer?.name}さんへのご連絡</h3>
        <Status value={current.state} />
        <Tag>版 {current.version}</Tag>
      </div>
      <p>
        送信元：{p.oa_name} · 有効期限：{date(current.expires_at)}
      </p>
      <Note>{current.reason}</Note>
      {data.deliveryEnabled === false && <Note tone="amber">送信は停止中です。承認内容を保存できますが、現在は顧客へ配信しません。</Note>}
      {generating && (
        <p role="status">
          会話と根拠を確認して文案を作成中です。完了後の文案を確認してください。
        </p>
      )}
      <Note tone={evidence.draftMode === "generated" ? undefined : "amber"}>
        {evidence.draftDetail ||
          "参考テンプレートです。内容を確認・編集してください。"}
      </Note>
      {current.problem && (
        <Note tone="amber">
          {current.problem} 見送ってから新しい提案を確認してください。
        </Note>
      )}
      {(evidence.lastContactAt || evidence.contactAfter) && <Note>前回のご連絡：{date(evidence.lastContactAt || new Date(new Date(evidence.contactAfter).getTime()-86400000).toISOString())}。追加で案内するタイミングも確認してから承認してください。</Note>}
      {current.hold_reason && <Note tone="amber">{current.hold_reason}</Note>}
      {current.snoozed_until && (
        <p>あとで：{date(current.snoozed_until)}まで通知を控えます。</p>
      )}
      {editing ? (
        <Form
          button="文面を保存して再確認"
          onSubmit={(v) =>
            api(
              `${base}/assistant/proposals/${p.id}`,
              { version: current.version, draft: v.draft, learning: {category:v.learningCategory, note:v.learningNote||""} },
              "PATCH",
            )
          }
          onDone={done}
        >
          <Field label="顧客へ送る文面">
            <textarea
              name="draft"
              defaultValue={current.draft}
              required
              maxLength={2000}
            />
          </Field>
          <Field label="今回の修正を次回へ活かす範囲">
            <select name="learningCategory" defaultValue="auto">
              <option value="auto">自動判定（表現だけの変更を文体として学習）</option>
              <option value="style">文体・言い回し</option>
              <option value="fact">物件・記事の事実訂正（元データの再確認が必要）</option>
              <option value="customer">このお客様だけの事情</option>
            </select>
          </Field>
          <Field label="次回への補足（任意）">
            <input name="learningNote" maxLength={500} placeholder="例：今は内見を急がず、情報提供を中心にする" />
          </Field>
          <Note>この版を承認した後に反映します。文体には氏名・価格・顧客事情を流用しません。</Note>
          <B variant="ghost" onClick={() => setEditing(false)}>
            編集をやめる
          </B>
        </Form>
      ) : (
        <div className="product-draft">{current.draft}</div>
      )}
      {mutable && !editing && (
        <div className="product-actions">
          <Action
            disabled={!valid || !data.aiConfigured || generating}
            run={() => makeDraft()}
          >
            会話と根拠からAI文案を作る
          </Action>
          <Action
            variant="primary"
            disabled={!valid || current.state === "held" || generating}
            run={() =>
              api(`${base}/assistant/proposals/${p.id}/approve`, {
                version: current.version,
              })
            }
            done={done}
          >
            {data.deliveryEnabled === false ? "この文面を承認する（送信停止中）" : "この文面を承認して送る"}
          </Action>
          <B
            variant="secondary"
            disabled={!valid}
            onClick={() => setEditing(true)}
          >
            修正する
          </B>
          <Action
            disabled={!valid}
            run={() =>
              api(`${base}/assistant/proposals/${p.id}/decision`, {
                version: current.version,
                action: "later",
              })
            }
            done={done}
          >
            あとで（4時間）
          </Action>
        </div>
      )}
      {mutable && !editing && <details><summary>この提案を見送る</summary>
        <Form button="理由を記録して見送る" onSubmit={v=>api(`${base}/assistant/proposals/${p.id}/decision`,{version:current.version,action:"cancel",feedback:{reason:v.reason,note:v.note||""}})} onDone={done}>
          <Field label="見送り理由"><select name="reason"><option value="timing">今はタイミングが合わない</option><option value="not_fit">条件・関心と合わない</option><option value="incorrect">情報・事実に誤りがある</option><option value="tone">文面・言い方が合わない</option><option value="duplicate">すでに案内済み</option><option value="unspecified">理由は記録しない</option></select></Field>
          <Field label="次回に活かす補足"><input name="note" maxLength={500}/></Field>
          <Note>理由はこのお客様の次の提案へ反映します。見送りだけで希望条件を変更しません。</Note>
        </Form>
      </details>}
      {!!data.learning?.length && <details><summary>この提案からの学習履歴</summary>{data.learning.filter(e=>e.origin!=="ai").map(e=><div key={e.id}><p>{e.action==="approved"?"承認":e.action==="edited"?"編集":e.action==="cancel"?"見送り":"あとで"}・版{e.version}・{{style:"文体",fact:"事実の再確認",customer:"このお客様の事情",unclassified:"分類保留",approval:"承認を記録",timing:"時機",not_fit:"条件不一致",incorrect:"事実の再確認",tone:"文体",duplicate:"案内済み",unspecified:"理由なし"}[e.category]||e.category} {e.excluded?"（学習対象外）":""}</p>{e.note&&<p>{e.note}</p>}<Action run={()=>api(`${base}/assistant/learning/${encodeURIComponent(e.id)}`,{excluded:!e.excluded},"PATCH")} done={refresh}>{e.excluded?"学習対象に戻す":"学習から除外"}</Action></div>)}</details>}
      {mutable && valid && data.aiConfigured && (
        <details>
          <summary>言葉で文案の修正を依頼</summary>
          <Form
            button="修正案を作成して再確認"
            onSubmit={(v) => makeDraft(v.instruction)}
          >
            <Field label="どう変えますか？">
              <input
                name="instruction"
                required
                maxLength={2000}
                placeholder="もう少しやわらかく、最後に相談に誘う一文を入れて"
              />
            </Field>
          </Form>
        </details>
      )}
      <Section title="この提案の根拠">
        {evidence.condition && <p>次に進む条件：「{evidence.condition}」</p>}
        {evidence.industry === "recruitment" && (
          <>
            <p>
              候補者の希望求人：
              {evidence.jobWish ? `「${evidence.jobWish}」` : "未確認"}
            </p>
            <p>
              転職希望時期：
              {evidence.jobChangeTiming
                ? `「${evidence.jobChangeTiming}」`
                : "未確認"}
            </p>
            <Note>
              転職希望時期は原文のままです。次回の連絡日時・面談日時とは別です。
            </Note>
          </>
        )}
        {evidence.stalled && <p>保留の理由：「{evidence.stalled}」</p>}
        {evidence.promise && <p>次回の約束：「{evidence.promise}」</p>}
        {evidence.profileSource && (
          <details>
            <summary>担当者が確認した原文</summary>
            <blockquote>{evidence.profileSource.body}</blockquote>
          </details>
        )}
        {evidence.messages?.map((m, i) => (
          <blockquote key={i}>{m}</blockquote>
        ))}
        {evidence.noteBody && (
          <>
            <Tag>確認済み商談メモ</Tag>
            <p>{evidence.noteBody}</p>
          </>
        )}
        {evidence.url && (
          <>
            <a href={evidence.url} target="_blank" rel="noreferrer">
              {evidence.title}
            </a>
            <p>{evidence.summary}</p>
            {evidence.discovery && (
              <p>
                記事元：{evidence.discovery.publisher} · 商談との一致：
                {evidence.discovery.query} · 本文取得：
                {date(evidence.discovery.retrievedAt)}
              </p>
            )}
            <p>
              公開：{date(evidence.publishedAt)}
              <br />
              出来事：
              {evidence.eventAt ? date(evidence.eventAt) : "出典で未確認"}
              <br />
              {evidence.industry === "recruitment"
                ? "出典・募集状況確認"
                : "出典・在庫確認"}
              ：{date(evidence.checkedAt)}
            </p>
          </>
        )}
        {evidence.preferences && (
          <p>
            必須：{evidence.preferences.required.join("、")} · 除外：
            {evidence.preferences.excluded.join("、") || "指定なし"}
          </p>
        )}
      </Section>
    </div>
  );
}
