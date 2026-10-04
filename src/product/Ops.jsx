import React, { useState } from "react";
import {
  B,
  I,
  Field,
  Title,
  Section,
  Note,
  Modal,
  Stat,
  Tag,
} from "../platform/ui.jsx";
import { api, useData, date, label } from "./api.js";
import { Action, Form, State, Status, Blank } from "./shared.jsx";
import { SetupOverview } from "./SetupOverview.jsx";
export const Units = () => (
  <>
    <option value="sales">営業担当者別</option>
    <option value="team">チーム・店舗別</option>
    <option value="company">企業共通</option>
    <option value="mixed">併用</option>
  </>
);
export const Methods = () => (
  <>
    <option value="lecture">画面共有・レクチャー</option>
    <option value="agency">当社が代行</option>
    <option value="self">顧客が設定</option>
  </>
);
export function AccountFields() {
  return (
    <>
      <Field label="公式LINEの名前">
        <input name="name" required maxLength={120} />
      </Field>
      <div className="product-grid">
        <Field label="保有単位">
          <select name="kind">
            <option value="sales">営業担当者専用</option>
            <option value="team">チーム・店舗共通</option>
            <option value="company">企業共通</option>
          </select>
        </Field>
        <Field label="アカウントの準備状況">
          <select name="origin">
            <option value="new">これから企業所有で作成する</option>
            <option value="existing">既存の公式LINEを使う</option>
          </select>
        </Field>
      </div>
    </>
  );
}
function CreateTenant({ done }) {
  const [key] = useState(() => crypto.randomUUID());
  return (
    <Form
      button="契約企業を発行する"
      onDone={done}
      onSubmit={(v) =>
        api(
          "/api/ops/tenants",
          {
            name: v.name,
            industry: v.industry,
            adminEmail: v.email,
            adminRoles:
              v.adminRole === "owner"
                ? ["sys_admin", "org_owner", "sales"]
                : ["sys_admin"],
            unit: v.unit,
            method: v.method,
            product: v.product,
            planName: v.plan || null,
            monthlyFee: v.fee === "" ? null : Number(v.fee),
            accounts: v.oaName
              ? [
                  {
                    name: v.oaName,
                    kind: v.unit === "mixed" ? "sales" : v.unit,
                    origin: v.origin,
                  },
                ]
              : [],
          },
          "POST",
          { "Idempotency-Key": key },
        )
      }
    >
      <Note>
        企業の発行後に管理者へ招待を送り、データベースの準備を開始します。LINE公式アカウント自体の作成は、選択した導入方法で進めます。
      </Note>
      <div className="product-grid">
        <Field label="企業名">
          <input name="name" required maxLength={120} />
        </Field>
        <Field label="業界">
          <input name="industry" maxLength={100} />
        </Field>
      </div>
      <Field
        label="初期管理者のメールアドレス"
        hint="招待を受諾する方のメールアドレスです。"
      >
        <input name="email" type="email" required />
      </Field>
      <Field label="初期管理者の担当範囲">
        <select name="adminRole">
          <option value="system">接続・利用者の管理のみ</option>
          <option value="owner">
            企業責任者・営業も兼任（企業内の顧客を閲覧）
          </option>
        </select>
      </Field>
      <div className="product-grid">
        <Field label="公式LINEの保有単位">
          <select name="unit">
            <Units />
          </select>
        </Field>
        <Field label="導入方法">
          <select name="method">
            <Methods />
          </select>
        </Field>
      </div>
      <Field label="導入パターン">
        <select name="product">
          <option value="existing">既存LINEへTSUNAGUを追加</option>
          <option value="harness">Harness込みで構築</option>
        </select>
      </Field>
      <div className="product-grid">
        <Field label="契約プラン名（未定なら空欄）">
          <input name="plan" maxLength={100} />
        </Field>
        <Field label="月額・税抜（円／未定なら空欄）">
          <input name="fee" type="number" min="0" step="1" />
        </Field>
      </div>
      <Field label="最初の公式LINE名（後から追加可）">
        <input name="oaName" maxLength={120} />
      </Field>
      <Field label="公式LINEの状態">
        <select name="origin">
          <option value="new">新規作成する</option>
          <option value="existing">既存アカウント</option>
        </select>
      </Field>
    </Form>
  );
}
export function Jobs({ jobs, refresh, canRetry = true }) {
  return jobs.length ? (
    <div className="product-table-wrap">
      <table className="product-table">
        <thead>
          <tr>
            <th>企業・処理</th>
            <th>状態</th>
            <th>更新</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                {j.tenant_name || ""}
                <small>
                  {j.kind === "provision"
                    ? "データベースの準備"
                    : "管理者の招待"}
                </small>
              </td>
              <td>
                <Status value={j.state} />
                {j.error_code && <small>{j.error_code}</small>}
              </td>
              <td>
                {date(j.updated_at)}
                <small>試行 {j.attempts} 回</small>
              </td>
              <td>
                {canRetry && ["failed", "pending"].includes(j.state) && (
                  <Action
                    run={() => api(`/api/ops/jobs/${j.id}/retry`, {})}
                    done={refresh}
                  >
                    再試行
                  </Action>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Blank
      title="対応が必要な処理はありません"
      description="開通処理や招待の状態をここで確認できます。"
    />
  );
}
export function Ops({ path, go, me }) {
  const view = path.split("/")[2] || "home",
    tid = path.split("/")[3];
  const endpoint = tid
    ? `/api/ops/tenants/${tid}`
    : view === "home" || view === "tenants"
      ? "/api/ops/overview"
      : `/api/ops/${view}`;
  const { data, error, refresh } = useData(endpoint),
    [dialog, setDialog] = useState(null),
    [setupAccount, setSetupAccount] = useState("");
  const can = (...roles) =>
    me.opsRole === "ops_owner" || roles.includes(me.opsRole);
  if (!data) return <State error={error} />;
  if (tid)
    return (
      <>
        <Title
          eyebrow="TENANT"
          title={data.tenant.name}
          description="契約・公式LINE・導入の状態をまとめて確認できます。"
        >
          <B variant="ghost" onClick={() => go("/ops/tenants")}>
            一覧へ
          </B>
          <B variant="secondary" icon="RefreshCw" onClick={refresh}>
            更新
          </B>
        </Title>
        <div className="product-stack">
          <SetupOverview data={data} accountId={setupAccount} onAccount={setSetupAccount}/>
          <Section title="企業の設定">
            <div className="product-grid">
              <p>
                導入方法：
                {
                  {
                    lecture: "画面共有・レクチャー",
                    agency: "当社代行",
                    self: "顧客が設定",
                  }[data.tenant.method]
                }
              </p>
              <p>
                プラン：{data.tenant.plan_name || "未設定"} ／ 月額：
                {data.tenant.monthly_fee == null
                  ? "未設定"
                  : `${data.tenant.monthly_fee.toLocaleString()}円`}
              </p>
            </div>
            <Note>
              初期管理者の招待・設定は顧客ワークスペースで行います。サポートアクセスは顧客側の承認後に有効になります。
            </Note>
          </Section>
          <Section
            title="公式LINE"
            sub="すべて企業所有。公式LINEごとにHarness／TSUNAGUのDBを用意します。"
            action={
              can("ops_setup") && (
                <B icon="Plus" onClick={() => setDialog("oa")}>
                  追加する
                </B>
              )
            }
          >
            {data.accounts.length ? (
              data.accounts.map((a) => (
                <div className="product-row" key={a.id}>
                  <div>
                    <h3>{a.name}</h3>
                    <p>
                      {a.kind === "sales"
                        ? "担当者専用"
                        : a.kind === "team"
                          ? "チーム・店舗"
                          : "企業共通"}{" "}
                      · {a.origin === "new" ? "新規作成" : "既存"} · DB{" "}
                      {
                        data.databases.filter(
                          (d) => d.oa_id === a.id && d.state === "ready",
                        ).length
                      }
                      /2
                    </p>
                  </div>
                  <Status value={a.state} />
                </div>
              ))
            ) : (
              <Blank
                title="公式LINEを追加しましょう"
                description="担当者別・チーム別・企業共通のアカウントを登録できます。"
              />
            )}
          </Section>
          <Section title="開通の処理">
            <Jobs
              jobs={data.jobs}
              refresh={refresh}
              canRetry={can("ops_setup")}
            />
          </Section>
          <Section title="管理者への招待">
            {data.invitations.map((i) => (
              <div key={i.id} className="product-row">
                <div>
                  {i.email}
                  <p>有効期限 {date(i.expires_at)}</p>
                </div>
                <Tag>
                  {i.accepted_at
                    ? "受諾済み"
                    : i.revoked_at
                      ? "取り消し済み"
                      : "受諾待ち"}
                </Tag>
              </div>
            ))}
          </Section>
        </div>
        <Modal
          open={dialog === "oa"}
          title="公式LINEを追加"
          onClose={() => setDialog(null)}
        >
          <Form
            onSubmit={(v) => api(`/api/ops/tenants/${tid}/accounts`, v)}
            onDone={() => {
              setDialog(null);
              refresh();
            }}
          >
            <AccountFields />
          </Form>
        </Modal>
      </>
    );
  if (view === "home" || view === "tenants")
    return (
      <>
        <Title
          eyebrow="OPERATIONS"
          title={
            view === "home"
              ? "今日の運用を、ひと目で。"
              : "受注から、いいスタートへ。"
          }
          description="契約企業の導入状況を確認し、必要な対応へ進みましょう。"
        >
          <B variant="secondary" icon="RefreshCw" onClick={refresh}>
            更新
          </B>
          {can("ops_sales") && (
            <B icon="Plus" onClick={() => setDialog("tenant")}>
              契約企業を発行
            </B>
          )}
        </Title>
        <div className="product-stats">
          <Stat
            label="契約企業"
            value={data.tenants.length}
            unit="社"
            icon="Building2"
          />
          <Stat
            label="公式LINE"
            value={data.tenants.reduce((n, t) => n + t.oa_count, 0)}
            unit="件"
            icon="MessageCircle"
          />
          <Stat
            label="開通済み"
            value={data.tenants.reduce((n, t) => n + t.ready_count, 0)}
            unit="件"
            icon="CheckCircle2"
          />
          <Stat
            label="要対応の処理"
            value={data.jobs.filter((j) => j.state === "failed").length}
            unit="件"
            icon="Activity"
            tone="rose"
          />
        </div>
        <Section
          title="契約企業"
          sub="導入状況に合わせて、担当チームで開通を進めます。"
        >
          {data.tenants.length ? (
            <div className="product-table-wrap">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>企業</th>
                    <th>状態</th>
                    <th>公式LINE</th>
                    <th>契約</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.tenants.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.name}</strong>
                        <small>{t.industry || "業界未設定"}</small>
                      </td>
                      <td>
                        <Status value={t.state} />
                      </td>
                      <td>
                        {t.ready_count} / {t.oa_count} 開通
                      </td>
                      <td>{t.plan_name || "未設定"}</td>
                      <td>
                        <B
                          variant="ghost"
                          icon="ArrowRight"
                          onClick={() => go(`/ops/tenants/${t.id}`)}
                        >
                          確認する
                        </B>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Blank
              title="最初の契約企業を迎えましょう"
              description="受注した企業を登録すると、管理者の招待とDBの準備を開始します。"
            />
          )}
        </Section>
        <Modal
          open={dialog === "tenant"}
          title="新しい契約企業"
          onClose={() => setDialog(null)}
          wide
        >
          <CreateTenant
            done={() => {
              setDialog(null);
              refresh();
            }}
          />
        </Modal>
      </>
    );
  if (view === "jobs")
    return (
      <>
        <Title
          eyebrow="ACTIVITY"
          title="処理・障害"
          description="失敗した処理は、完了済みの工程を引き継いで再試行します。"
        >
          <B variant="secondary" onClick={refresh}>
            更新
          </B>
        </Title>
        <Section title="処理の一覧">
          <Jobs
            jobs={data.jobs}
            refresh={refresh}
            canRetry={can("ops_setup")}
          />
        </Section>
      </>
    );
  if (view === "usage")
    return (
      <>
        <Title
          eyebrow="USAGE & COST"
          title="利用量と原価"
          description="原価が未取得の処理は、金額未確定として表示します。"
        />
        <Section title="利用記録">
          {data.events.length ? (
            <table className="product-table">
              <thead>
                <tr>
                  <th>処理</th>
                  <th>利用量</th>
                  <th>原価</th>
                  <th>日時</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.kind}</td>
                    <td>{e.units}</td>
                    <td>
                      {e.cost_micros == null
                        ? "未取得"
                        : `${e.cost_micros / 1e6} ${e.currency}`}
                    </td>
                    <td>{date(e.occurred_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Blank
              title="利用記録はまだありません"
              description="処理の実行後に、利用量と取得できた原価を記録します。"
            />
          )}
        </Section>
        <Note>
          成果単価・集計ルールの設定前は、成果報酬や粗利を自動計上しません。
        </Note>
      </>
    );
  if (view === "audit")
    return (
      <>
        <Title
          eyebrow="AUDIT"
          title="操作履歴"
          description="企業の設定や承認操作を確認できます。会話本文・資格情報は含みません。"
        />
        <Section title="最近の操作">
          <table className="product-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>操作</th>
                <th>対象</th>
              </tr>
            </thead>
            <tbody>
              {data.audit.map((a) => (
                <tr key={a.id}>
                  <td>{date(a.at)}</td>
                  <td>{a.action}</td>
                  <td>{a.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </>
    );
  if (view === "support")
    return (
      <>
        <Title
          eyebrow="SUPPORT"
          title="サポートアクセス"
          description="企業・公式LINE・用途・期限を指定し、顧客側の承認を受けます。"
        />
        <Section title="申請状況">
          {data.requests.length ? (
            data.requests.map((s) => (
              <div className="product-row" key={s.id}>
                <div>
                  <h3>{s.tenant_name}</h3>
                  <p>
                    {s.reason} · {date(s.expires_at)}まで
                  </p>
                </div>
                <Tag>{label(s.state)}</Tag>
              </div>
            ))
          ) : (
            <Blank
              title="アクセス申請はありません"
              description="通常の運営画面では、顧客との会話本文を表示しません。"
            />
          )}
        </Section>
      </>
    );
  return (
    <Blank
      title="画面が見つかりません"
      description="メニューから移動してください。"
    />
  );
}
