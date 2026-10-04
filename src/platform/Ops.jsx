import React, { useState, useEffect } from "react";
import {
  B,
  I,
  Tag,
  Tile,
  Brand,
  Field,
  Title,
  Section,
  Note,
  Empty,
  Modal,
  Stat,
  Status,
  Avatar,
  Segments,
  yen,
  num,
  download,
} from "./ui.jsx";
import { AccountsPanel, MethodPicker } from "./Onboarding.jsx";
const financeStates = {
  forecast: ["見込み", "lavender"],
  confirmed: ["確認済み", "blue"],
  billed: ["請求確定", "sage"],
};
const permissions = {
  ops_owner: [
    "home",
    "activation",
    "company",
    "usage",
    "jobs",
    "plans",
    "support",
    "support_view",
  ],
  ops_sales: ["home", "activation", "company"],
  ops_setup: [
    "home",
    "activation",
    "company",
    "jobs",
    "support",
    "support_view",
  ],
  ops_finance: ["home", "usage", "plans", "company"],
  ops_support: ["home", "jobs", "support", "support_view"],
};
export function Ops(ctx) {
  const { model, state, update, go, path, scenario, setScenario } = ctx;
  const nav = model.screens.filter((s) => s.area === "ops"),
    screen = model.screens.find((s) => s.path === path) || nav[0],
    role = model.opsRoles.find((r) => r.id === state.opsRole);
  const [search, setSearch] = useState("");
  const allowed =
    permissions[state.opsRole]?.includes(screen.id) &&
    scenario !== "no_permission";
  function openCompany(id) {
    update((s) => (s.selectedCompany = id));
    go("/ops/company");
  }
  const props = { ...ctx, openCompany };
  return (
    <div className="pt-ops-layout">
      <aside className="pt-ops-sidebar">
        <Brand ops onClick={() => go("/ops")} />
        <div className="pt-ops-space">
          <span className="pt-space-mark">
            <I name="Layers" />
          </span>
          <div>
            <strong>TSUNAGU Platform</strong>
            <small>運営ワークスペース</small>
          </div>
          <I name="ChevronDown" size={14} />
        </div>
        <span className="pt-nav-caption">MANAGE</span>
        <nav aria-label="TSUNAGU運営ナビゲーション">
          {nav.map((s) => (
            <button
              key={s.id}
              className={s.id === screen.id ? "active" : ""}
              onClick={() => go(s.path)}
            >
              <I name={s.icon} size={18} />
              <span>{s.label}</span>
              {s.id === "jobs" && (
                <b>
                  {
                    state.jobs.filter(
                      (j) => j.status === "failed" || j.status === "ops",
                    ).length
                  }
                </b>
              )}
            </button>
          ))}
        </nav>
        <div className="pt-ops-side-note">
          <I name="ShieldCheck" size={20} />
          <strong>つながりを、守る。</strong>
          <p>
            通常の運営画面では、
            <br />
            顧客の会話本文を表示しません。
          </p>
        </div>
        <button
          className="pt-ops-profile"
          onClick={() => ctx.setDialog("review")}
        >
          <Avatar name="木村" tone="stone" />
          <span>
            <strong>木村 直人</strong>
            <small>{role?.label} · デモ</small>
          </span>
          <I name="MoreHorizontal" />
        </button>
      </aside>
      <div className="pt-ops-body">
        <header className="pt-ops-topbar">
          <div>
            <span>運営</span>
            <I name="ChevronRight" size={13} />
            <strong>{screen.label}</strong>
          </div>
          <div className="pt-ops-top-actions">
            <label className="pt-search">
              <I name="Search" size={15} />
              <input
                placeholder="企業名を検索"
                aria-label="運営の企業検索"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <Tag tone="stone">/ops</Tag>
            <button
              className="pt-icon-btn"
              aria-label="運営の表示状態"
              onClick={() =>
                setScenario(
                  scenario === "no_permission" ? "normal" : "no_permission",
                )
              }
            >
              <I name="ShieldCheck" />
            </button>
          </div>
          {search && (
            <div className="pt-search-popover">
              {state.companies
                .filter((c) =>
                  c.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      openCompany(c.id);
                      setSearch("");
                    }}
                  >
                    <Avatar name={c.name} />
                    <span>{c.name}</span>
                    <I name="ArrowRight" size={16} />
                  </button>
                ))}
              {!state.companies.some((c) =>
                c.name.toLowerCase().includes(search.toLowerCase()),
              ) && <p>該当する企業はありません</p>}
            </div>
          )}
        </header>
        <div className="pt-ops-mobile-nav">
          {nav.map((s) => (
            <button
              key={s.id}
              className={s.id === screen.id ? "active" : ""}
              onClick={() => go(s.path)}
            >
              <I name={s.icon} size={17} />
              {s.label}
            </button>
          ))}
        </div>
        <main className="pt-ops-main">
          {!allowed ? (
            <Empty
              icon="LockKeyhole"
              title="この画面を開く権限がありません"
              description={`${role?.label || "未所属"}の権限では操作できません。顧客企業の役割から運営権限が付与されることはありません。`}
            >
              <B
                variant="secondary"
                onClick={() => {
                  update((s) => (s.opsRole = "ops_owner"));
                  setScenario("normal");
                }}
              >
                運営責任者の状態で確認（デモ）
              </B>
            </Empty>
          ) : screen.id === "home" ? (
            <Portfolio {...props} />
          ) : screen.id === "activation" ? (
            <Activation {...props} />
          ) : screen.id === "company" ? (
            <Company {...props} />
          ) : screen.id === "usage" ? (
            <Usage {...props} />
          ) : screen.id === "jobs" ? (
            <Jobs {...props} />
          ) : screen.id === "plans" ? (
            <Plans {...props} />
          ) : screen.id === "support" || screen.id === "support_view" ? (
            <Support {...props} />
          ) : null}
          <footer className="pt-ops-footer">
            <span>
              <I name="Link2" size={14} />
              TSUNAGU OPERATIONS
            </span>
            <span>外部認証・発行・接続・計測はすべて模擬動作</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Portfolio(ctx) {
  const { state, go, openCompany, model } = ctx;
  const companies = state.companies,
    accounts = state.accounts,
    ready = accounts.filter((a) => a.status === "ready").length,
    sum = (k) =>
      companies.reduce(
        (a, c) => a + (k === "monthly" && c.start > model.asOf ? 0 : c[k] || 0),
        0,
      ),
    income = sum("monthly") + sum("variable"),
    cost = sum("cost");
  return (
    <>
      <Title
        eyebrow="GOOD MORNING, KIMURA"
        title="つながりの、その先へ。"
        description="企業の立ち上がりも、日々の成果も。今日の運営をここから。"
      >
        <span className="pt-date">
          <I name="CalendarDays" size={15} />
          2026年9月22日
        </span>
        <B icon="Plus" onClick={() => go("/ops/activation")}>
          契約企業を発行
        </B>
      </Title>
      <div className="pt-portfolio-top">
        <section className="pt-finance-hero">
          <div>
            <span>
              <I name="Sparkles" size={17} />
              今月の事業見込み
            </span>
            <Tag tone="lavender">見込みを含む · サンプル</Tag>
          </div>
          <p>粗利見込み</p>
          <strong>{yen(income - cost)}</strong>
          <div className="pt-revenue-equation">
            <span>
              売上見込み<b>{yen(income)}</b>
            </span>
            <i>−</i>
            <span>
              総原価<b>{yen(cost)}</b>
            </span>
            <i>=</i>
            <span>
              粗利率
              <b>
                {((100 * (income - cost)) / Math.max(1, income)).toFixed(1)}%
              </b>
            </span>
          </div>
          <div className="pt-hero-foot">
            <span>月額・成果・従量を合算したデモ集計</span>
            <button onClick={() => go("/ops/usage")}>
              内訳を見る
              <I name="ArrowRight" size={15} />
            </button>
          </div>
          <div className="pt-finance-orb" />
        </section>
        <section className="pt-health-card">
          <div>
            <h2>ワークスペースの状況</h2>
            <Tile name="Activity" tone="sage" />
          </div>
          <div className="pt-health-main">
            <strong>
              {companies.length}
              <small>契約企業</small>
            </strong>
            <span>
              <b>{accounts.length}</b> 公式LINE <i>·</i> <b>{sum("users")}</b>{" "}
              利用者
            </span>
          </div>
          <div className="pt-stacked-bar">
            <i
              style={{
                width: `${(ready / Math.max(1, accounts.length)) * 100}%`,
              }}
            />
            <b style={{ flex: 1 }} />
          </div>
          <div className="pt-health-legend">
            <span>
              <i />
              {ready} 開通済み
            </span>
            <span>
              <i />
              {accounts.length - ready} 設定中・要対応
            </span>
          </div>
          <button
            className="pt-text-link"
            onClick={() => go("/ops/activation")}
          >
            開通の進み具合を見る
            <I name="ArrowRight" size={15} />
          </button>
        </section>
      </div>
      <div className="pt-stats-grid">
        <Stat
          label="個別メッセージ"
          value={num(sum("messages"))}
          unit="通"
          caption="LINEから生まれる、日々の接点"
          icon="MessageCircle"
          tone="blue"
        />
        <Stat
          label="AIの処理"
          value={num(sum("aiRuns"))}
          unit="回"
          caption={`AI原価 ${yen((model.fixtures.usage || []).reduce((n, e) => n + e.aiCost, 0))}`}
          icon="Sparkles"
          tone="lavender"
        />
        <Stat
          label="予約 → 実施"
          value={num(sum("bookings"))}
          unit={`→ ${sum("attended")} 件`}
          caption={`初回 ${sum("first")}件 / 再アポ ${sum("repeat")}件`}
          icon="CalendarDays"
          tone="sage"
        />
        <Stat
          label="成果候補"
          value={num(sum("outcomes"))}
          unit="件"
          caption="自動で請求確定せず、根拠を確認"
          icon="CheckCheck"
          tone="peach"
        />
      </div>
      <div className="pt-home-bottom">
        <Section
          title="契約企業"
          sub="今日の状況を、一社ずつ。"
          action={
            <button
              className="pt-text-link"
              onClick={() => go("/ops/activation")}
            >
              すべて見る
              <I name="ArrowRight" size={14} />
            </button>
          }
        >
          <CompanyTable {...ctx} />
        </Section>
        <Section
          title="いま確認したいこと"
          sub="影響と、次のアクション。"
          className="pt-attention-panel"
        >
          {state.jobs
            .filter((j) => j.status !== "ready")
            .slice(0, 3)
            .map((j) => (
              <button
                className="pt-attention"
                key={j.id}
                onClick={() => go("/ops/jobs")}
              >
                <Tile
                  name={
                    j.status === "failed"
                      ? "AlertCircle"
                      : j.status === "ops"
                        ? "Link2"
                        : "Clock"
                  }
                  tone={j.status === "failed" ? "rose" : "peach"}
                />
                <div>
                  <strong>{j.name}</strong>
                  <span>
                    {companies.find((c) => c.id === j.companyId)?.name}
                  </span>
                  <small>
                    {j.status === "failed"
                      ? "完了済み処理を保持して再試行できます"
                      : j.status === "ops"
                        ? "既存ツールとの接続方式を確認"
                        : "顧客側の再接続を待っています"}
                  </small>
                </div>
                <I name="ChevronRight" size={15} />
              </button>
            ))}
          <div className="pt-quiet-card">
            <I name="ShieldCheck" size={22} />
            <p>
              運営のために必要な情報だけを。
              <br />
              <strong>会話本文は通常非表示です。</strong>
            </p>
          </div>
        </Section>
      </div>
    </>
  );
}
function CompanyTable({ state, openCompany }) {
  return (
    <div className="pt-table-wrap">
      <table className="pt-company-table">
        <thead>
          <tr>
            <th>企業</th>
            <th>公式LINE</th>
            <th>月額売上</th>
            <th>状態</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.companies.map((c) => {
            const oa = state.accounts.filter((a) => a.tenantId === c.id),
              n = oa.filter((a) => a.status === "ready").length;
            return (
              <tr key={c.id}>
                <td>
                  <button
                    className="pt-table-company"
                    onClick={() => openCompany(c.id)}
                  >
                    <Avatar
                      name={c.name}
                      tone={c.id === "next" ? "lavender" : "blue"}
                    />
                    <span>
                      <strong>{c.name}</strong>
                      <small>
                        {c.industry} · {c.plan}
                      </small>
                    </span>
                  </button>
                </td>
                <td>
                  <strong>
                    {n}
                    <span className="pt-muted"> / {oa.length}</span>
                  </strong>
                  <small>開通済み</small>
                </td>
                <td>
                  {yen(c.monthly)}
                  <small>料金サンプル</small>
                </td>
                <td>
                  <Tag tone={n === oa.length && oa.length ? "sage" : "amber"}>
                    {n === oa.length && oa.length ? "稼働中" : "開通準備中"}
                  </Tag>
                </td>
                <td>
                  <button
                    className="pt-row-open"
                    aria-label={`${c.name}の詳細`}
                    onClick={() => openCompany(c.id)}
                  >
                    <I name="ChevronRight" size={17} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Activation(ctx) {
  const { state, model, go, update, notify, openCompany } = ctx;
  const [create, setCreate] = useState(false);
  return (
    <>
      <Title
        eyebrow="FROM SIGNATURE TO FIRST CONNECTION"
        title="受注から、開通へ。"
        description="お客様の営業スタイルに合わせて、一社ずつ準備を進めます。"
      >
        <B icon="Plus" onClick={() => setCreate(true)}>
          契約企業を発行
        </B>
      </Title>
      <div className="pt-activation-summary">
        {[
          ["契約企業", state.companies.length, "Building2", "lavender"],
          [
            "開通済み公式LINE",
            state.accounts.filter((a) => a.status === "ready").length,
            "CheckCircle2",
            "sage",
          ],
          [
            "お客様の確認待ち",
            state.jobs.filter((j) => j.status === "customer").length,
            "Clock",
            "amber",
          ],
          [
            "当社の対応が必要",
            state.jobs.filter((j) => ["failed", "ops"].includes(j.status))
              .length,
            "HandHeart",
            "peach",
          ],
        ].map(([l, n, i, t]) => (
          <div key={l}>
            <Tile name={i} tone={t} />
            <span>
              {l}
              <strong>{n}</strong>
            </span>
          </div>
        ))}
      </div>
      <Section title="進行中の企業" sub="企業情報から、公式LINEごとの準備へ。">
        <CompanyTable {...ctx} />
      </Section>
      <div className="pt-two-col">
        <Section
          title="開通のチェックポイント"
          sub="処理ごとに記録し、途中から安全に再開します。"
        >
          <div className="pt-activation-steps">
            {model.activationSteps.map((s, i) => (
              <div key={s.id}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <strong>{s.label}</strong>
                <I name={i === 8 ? "Rocket" : "ChevronRight"} size={16} />
              </div>
            ))}
          </div>
        </Section>
        <Section
          title="どの方法でも、同じ進捗を。"
          sub="受注時に決めた導入方法は、途中から変更できます。"
        >
          <div className="pt-method-explain">
            {model.onboardingMethods.map((m) => (
              <div key={m.id}>
                <Tile name={m.icon} tone="peach" />
                <div>
                  <h3>{m.label}</h3>
                  <p>{m.description}</p>
                </div>
              </div>
            ))}
          </div>
          <Note>
            公式LINEの保有単位・既存環境・当社支援の方法を確認してから、開通枠と各ジョブを用意します。
          </Note>
        </Section>
      </div>
      <IssueCompany {...ctx} open={create} close={() => setCreate(false)} />
    </>
  );
}
function IssueCompany(ctx) {
  const { model, state, update, notify, audit, openCompany, open, close } = ctx;
  const [f, setF] = useState({
      name: "",
      industry: "不動産",
      admin: "",
      plan: "growth",
      unit: "sales",
      origin: "new",
      product: "existing",
      method: "lecture",
      count: 3,
      start: "2026-10-01",
    }),
    [issued, setIssued] = useState(null);
  const patch = (k, v) => setF({ ...f, [k]: v });
  const can = ["ops_owner", "ops_sales"].includes(state.opsRole);
  function submit(e) {
    e.preventDefault();
    if (!can) return;
    const id = "company-" + Date.now(),
      p = model.plans.find((p) => p.id === f.plan);
    update((s) => {
      s.companies.push({
        id,
        name: f.name,
        industry: f.industry,
        initial: f.name.slice(0, 2),
        plan: f.plan,
        oaCount: Number(f.count),
        users: 1,
        ready: 0,
        messages: 0,
        aiRuns: 0,
        bookings: 0,
        attended: 0,
        first: 0,
        repeat: 0,
        outcomes: 0,
        monthly: p.monthly,
        variable: 0,
        cost: 0,
        financialState: "forecast",
        method: f.method,
        unit: f.unit,
        admin: f.admin,
        start: f.start,
        product: f.product,
        invitation: "pending",
        issued: true,
      });
      for (let i = 0; i < Number(f.count); i++)
        s.accounts.push({
          id: `${id}-oa${i + 1}`,
          tenantId: id,
          name:
            f.unit === "sales"
              ? `担当者 ${i + 1} の公式LINE`
              : `公式LINE ${i + 1}`,
          primary: "未割当",
          operators: [],
          team: "未割当",
          unit: f.unit,
          origin: f.origin,
          owner: f.name,
          status: f.origin === "new" ? "uncreated" : "credentials",
          webhookConflict: false,
          sharedApplied: false,
          style: false,
          calendar: false,
          booking: false,
          credentialsStatus: "waiting",
        });
      s.jobs.unshift({
        id: id + "-job",
        companyId: id,
        oaId: null,
        name: "企業DB・OA別DBの発行",
        step: "database",
        status: "processing",
        error: null,
        detail: `企業共通顧客DB 1個と、OA別DB ${Number(f.count) * 2}個の発行待ち（デモ）。`,
        key: id + "-provision-v1",
        attempts: 0,
        done: ["contract", "invitation"],
      });
      audit("契約企業を発行（模擬）", f.name, "受注", s);
    });
    setIssued(id);
    notify("企業・初期管理者・公式LINEの開通枠を作成しました（デモ）");
  }
  return (
    <Modal
      open={open}
      title={issued ? "契約企業を発行しました" : "新しい契約企業"}
      onClose={() => {
        close();
        setIssued(null);
      }}
      wide
    >
      {issued ? (
        <div className="pt-issued">
          <Tile name="CheckCheck" tone="sage" size={30} />
          <h2>{f.name}</h2>
          <p>受注内容を保存し、開通の準備へ進めます。</p>
          <div className="pt-key-values">
            <div>
              <span>初期管理者の招待</span>
              <strong>{f.admin} / 送信待ち（模擬）</strong>
            </div>
            <div>
              <span>企業共通顧客DB</span>
              <strong>1個 / 発行待ち</strong>
            </div>
            <div>
              <span>OA別Harness・TSUNAGU DB</span>
              <strong>{Number(f.count) * 2}個 / 発行待ち</strong>
            </div>
            <div>
              <span>公式LINE</span>
              <strong>{f.count}アカウント / 企業所有</strong>
            </div>
          </div>
          <Note>
            実際のメール送信・公式LINE作成・D1発行は行いません。開通ジョブの状態を次の画面で確認できます。
          </Note>
          <B
            icon="ArrowRight"
            onClick={() => {
              close();
              openCompany(issued);
              setIssued(null);
            }}
          >
            企業の開通状況へ
          </B>
        </div>
      ) : !can ? (
        <Empty
          icon="LockKeyhole"
          title="契約企業の発行権限がありません"
          description="当社営業または運営責任者の操作です。"
        />
      ) : (
        <form onSubmit={submit}>
          <p className="pt-muted">受注した契約の情報を登録します。</p>
          <div className="pt-form-grid">
            <Field label="契約企業名">
              <input
                required
                value={f.name}
                onChange={(e) => patch("name", e.target.value)}
                placeholder="株式会社…"
              />
            </Field>
            <Field label="業種">
              <select
                value={f.industry}
                onChange={(e) => patch("industry", e.target.value)}
              >
                <option>不動産</option>
                <option>スクール・教育</option>
                <option>ライフプラン</option>
                <option>その他</option>
              </select>
            </Field>
          </div>
          <Field label="初期管理者のメールアドレス">
            <input
              required
              type="email"
              value={f.admin}
              onChange={(e) => patch("admin", e.target.value)}
              placeholder="admin@company.example"
            />
          </Field>
          <div className="pt-form-grid">
            <Field label="契約プラン（料金は仮置き）">
              <select
                value={f.plan}
                onChange={(e) => patch("plan", e.target.value)}
              >
                {model.plans.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} / {yen(p.monthly)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="契約開始日">
              <input
                type="date"
                required
                value={f.start}
                onChange={(e) => patch("start", e.target.value)}
              />
            </Field>
            <Field label="公式LINEの保有単位">
              <select
                value={f.unit}
                onChange={(e) => patch("unit", e.target.value)}
              >
                {model.ownershipUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="公式LINEの開通枠数">
              <input
                type="number"
                min="1"
                max="50"
                required
                value={f.count}
                onChange={(e) => patch("count", e.target.value)}
              />
            </Field>
            <Field label="既存 / 新規の公式LINE">
              <select
                value={f.origin}
                onChange={(e) => patch("origin", e.target.value)}
              >
                <option value="new">新規作成 / 企業所有</option>
                <option value="existing">既存アカウントへ追加</option>
              </select>
            </Field>
            <Field label="提供する構成">
              <select
                value={f.product}
                onChange={(e) => patch("product", e.target.value)}
              >
                <option value="existing">TSUNAGU追加</option>
                <option value="harness">Harness込みで構築</option>
              </select>
            </Field>
          </div>
          <Field label="オンボーディング方法">
            <select
              value={f.method}
              onChange={(e) => patch("method", e.target.value)}
            >
              {model.onboardingMethods.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Note>
            営業担当者専用の公式LINEも企業所有です。APIキーによるログインや、営業担当者ごとの追加DBは作りません。
          </Note>
          <B type="submit" icon="Plus">
            契約企業を発行（デモ）
          </B>
        </form>
      )}
    </Modal>
  );
}
function Company(ctx) {
  const { state, model, update, notify, go, audit } = ctx;
  const c =
      state.companies.find((c) => c.id === state.selectedCompany) ||
      state.companies[0],
    oas = state.accounts.filter((a) => a.tenantId === c.id),
    jobs = state.jobs.filter((j) => j.companyId === c.id);
  const [tab, setTab] = useState("accounts");
  const readOnly = !["ops_owner", "ops_sales", "ops_setup"].includes(
    state.opsRole,
  );
  return (
    <>
      <button
        className="pt-text-link pt-back"
        onClick={() => go("/ops/activation")}
      >
        <I name="ArrowLeft" size={14} />
        受注・開通へ
      </button>
      <Title
        eyebrow="COMPANY WORKSPACE"
        title={c.name}
        description={`${c.industry} / ${c.id}`}
      >
        <Tag tone={oas.every((a) => a.status === "ready") ? "sage" : "amber"}>
          {oas.every((a) => a.status === "ready") ? "稼働中" : "開通準備中"}
        </Tag>
      </Title>
      <div className="pt-company-overview">
        <div>
          <span>契約プラン</span>
          <strong>
            {c.plan}
            <small>{yen(c.monthly)} / 月 · 仮置き</small>
          </strong>
        </div>
        <div>
          <span>公式LINE</span>
          <strong>
            {oas.length}
            <small>
              {oas.filter((a) => a.status === "ready").length} 開通済み
            </small>
          </strong>
        </div>
        <div>
          <span>利用者</span>
          <strong>
            {c.users}
            <small>名</small>
          </strong>
        </div>
        <div>
          <span>当月の個別送信</span>
          <strong>
            {num(c.messages)}
            <small>通</small>
          </strong>
        </div>
      </div>
      <div className="pt-company-tabs">
        <Segments
          label="企業詳細の表示"
          value={tab}
          options={[
            { id: "accounts", label: "公式LINE・開通" },
            { id: "contract", label: "契約・導入方法" },
            { id: "database", label: "DB・接続" },
            { id: "members", label: "利用者・役割" },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === "accounts" && (
        <>
          <AccountsPanel {...ctx} tenantId={c.id} readOnly={readOnly} />
          {jobs.length > 0 && (
            <Section title="開通ジョブ">
              <div className="pt-company-jobs">
                {jobs.map((j) => (
                  <button key={j.id} onClick={() => go("/ops/jobs")}>
                    <I name="Activity" />
                    <strong>{j.name}</strong>
                    <Status model={model} id={j.status} />
                    <I name="ChevronRight" size={15} />
                  </button>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
      {tab === "contract" && (
        <>
          <Section title="契約と初期管理者">
            <div className="pt-key-values">
              <div>
                <span>契約開始</span>
                <strong>{c.start}</strong>
              </div>
              <div>
                <span>初期管理者</span>
                <strong>{c.admin}</strong>
              </div>
              <div>
                <span>提供構成</span>
                <strong>
                  {c.product === "harness"
                    ? "Harness込みで構築"
                    : "TSUNAGU追加"}
                </strong>
              </div>
              <div>
                <span>公式LINEの保有単位</span>
                <strong>
                  {model.ownershipUnits.find((u) => u.id === c.unit)?.label}
                </strong>
              </div>
              <div>
                <span>ログイン招待</span>
                <strong>
                  {c.invitation === "pending"
                    ? "送信待ち（模擬）"
                    : c.invitation === "sent"
                      ? "招待済み（模擬）"
                      : "受諾済み（サンプル）"}
                </strong>
              </div>
            </div>
            <B
              variant="secondary"
              icon="Mail"
              disabled={readOnly}
              onClick={() => {
                update(
                  (s) =>
                    (s.companies.find((x) => x.id === c.id).invitation =
                      "sent"),
                );
                audit("初期管理者への招待を再現", c.name);
                notify(
                  "招待済みの状態にしました。実際のメールは送信されません。",
                );
              }}
            >
              ログイン招待を送る（デモ）
            </B>
          </Section>
          {!readOnly && <MethodPicker {...ctx} companyId={c.id} />}
        </>
      )}
      {tab === "database" && (
        <>
          <Section
            title="DBレジストリ"
            sub="DBはそれぞれ独立。企業・公式LINEへの所属を管理します。"
          >
            <div className="pt-db-summary">
              <Tile name="Database" tone="blue" />
              <div>
                <strong>{1 + oas.length * 2} 個の独立したDB</strong>
                <p>企業共通顧客DB 1個 + 公式LINE {oas.length}件 × 2個</p>
              </div>
              <Tag tone="stone">schema v1</Tag>
            </div>
            <div className="pt-db-table">
              <div>
                <I name="Database" />
                <strong>企業共通顧客DB</strong>
                <span>人物正本・現在担当・同一人物の参照</span>
                <Tag tone={c.issued ? "blue" : "sage"}>
                  {c.issued ? "発行待ち" : "利用中（サンプル）"}
                </Tag>
              </div>
              {oas.map((a) => (
                <div key={a.id}>
                  <I name="MessageCircle" />
                  <strong>{a.name}</strong>
                  <span>Harness DB + TSUNAGU DB</span>
                  <Tag tone={a.status === "ready" ? "sage" : "amber"}>
                    {a.status === "ready" ? "発行済み（サンプル）" : "準備中"}
                  </Tag>
                </div>
              ))}
            </div>
            <Note>
              AI判断・提案・承認はOA別TSUNAGU
              DB内のレコードです。追加の営業担当者DBはありません。
            </Note>
          </Section>
          <Section title="接続の確認範囲">
            <div className="pt-connect-pills">
              {[
                "LINE Harness",
                "Google Sheets",
                "Google Drive",
                "Google Calendar",
                "TimeRex",
              ].map((x) => (
                <Tag tone="stone" key={x}>
                  {x}
                </Tag>
              ))}
            </div>
            <p className="pt-muted">
              資格情報は値を表示せず、登録者・更新時刻・状態だけを管理します。
            </p>
          </Section>
        </>
      )}
      {tab === "members" && (
        <Section
          title="顧客企業の役割"
          sub="TSUNAGU運営ロールとは別に管理します。"
        >
          {model.customerRoles.map((r) => (
            <div className="pt-role-row" key={r.id}>
              <Tile
                name={
                  r.id === "sys_admin"
                    ? "Settings"
                    : r.id === "billing"
                      ? "Wallet"
                      : "UserRound"
                }
                tone="stone"
              />
              <div>
                <h3>{r.label}</h3>
                <p>{r.scope}</p>
              </div>
              <span>直接送信：{r.send}</span>
            </div>
          ))}
          <Note>
            システム管理者の設定権限と、顧客会話を閲覧する権限を分けます。
          </Note>
        </Section>
      )}
      <div className="pt-privacy-strip">
        <I name="LockKeyhole" />
        <div>
          <strong>顧客の会話本文は表示されません。</strong>
          <p>
            要請・承認・対象範囲・期限が揃ったサポートアクセスだけ、別画面から確認します。
          </p>
        </div>
        <B variant="secondary" onClick={() => go("/ops/support")}>
          サポートアクセスへ
        </B>
      </div>
    </>
  );
}
function Usage(ctx) {
  const { state, model, scenario, setScenario, notify } = ctx;
  const [company, setCompany] = useState("all"),
    [oa, setOA] = useState("all"),
    [period, setPeriod] = useState("month"),
    [stage, setStage] = useState("all");
  const list = state.companies.filter(
    (c) =>
      (company === "all" || c.id === company) &&
      (stage === "all" || c.financialState === stage),
  );
  const rows = (model.fixtures.usage || []).filter(
    (e) =>
      list.some((c) => c.id === e.tenantId) &&
      (oa === "all" || e.oaId === oa) &&
      (period === "month" || e.day >= 16),
  );
  const sum = (k) => rows.reduce((s, e) => s + e[k], 0);
  const scopeAll = oa === "all";
  const companies = list
    .map((c) => {
      const acc = state.accounts.filter((a) => a.tenantId === c.id);
      const scope = scopeAll
        ? 1
        : acc.some((a) => a.id === oa)
          ? 1 / Math.max(1, acc.length)
          : 0;
      return {
        ...c,
        monthly: (c.start > model.asOf ? 0 : c.monthly) * scope,
        variable: rows
          .filter((e) => e.tenantId === c.id)
          .reduce((s, e) => s + e.variable, 0),
        cost: rows
          .filter((e) => e.tenantId === c.id)
          .reduce((s, e) => s + e.cost, 0),
      };
    })
    .filter((c) => scopeAll || c.monthly > 0);
  const total = (k) => companies.reduce((s, c) => s + c[k], 0),
    missing = scenario === "cost_missing",
    delay = scenario === "delay";
  return (
    <>
      <Title
        eyebrow="USAGE & UNIT ECONOMICS"
        title="使われた価値を、確かな数字に。"
        description="利用量・費用・成果をつなぎ、事業の見込みを確認します。"
      >
        <B
          variant="secondary"
          icon="Download"
          onClick={() => {
            const lines = [
              ["企業", "月額", "成果従量見込み", "原価", "状態"],
              ...companies.map((c) => [
                c.name,
                c.monthly,
                c.variable,
                missing ? "未取得" : c.cost,
                financeStates[c.financialState][0],
              ]),
            ];
            download(
              "tsunagu-operations-sample.csv",
              "\ufeff" +
                lines
                  .map((r) =>
                    r
                      .map((x) => '"' + String(x).replaceAll('"', '""') + '"')
                      .join(","),
                  )
                  .join("\r\n"),
              "text/csv",
            );
            notify("表示範囲のサンプルCSVを出力しました");
          }}
        >
          CSVを出力
        </B>
      </Title>
      <div className="pt-report-filters">
        <Field label="企業">
          <select
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              setOA("all");
            }}
          >
            <option value="all">すべての企業</option>
            {state.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="公式LINE">
          <select value={oa} onChange={(e) => setOA(e.target.value)}>
            <option value="all">すべての公式LINE</option>
            {state.accounts
              .filter((a) => company === "all" || a.tenantId === company)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="利用量の期間">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="month">9月1日 – 9月22日</option>
            <option value="week">直近7日 / 9月16日 – 22日</option>
          </select>
        </Field>
      </div>
      <div className="pt-report-state">
        <Segments
          label="金額の確認状態"
          value={stage}
          options={[
            { id: "all", label: "すべて" },
            { id: "forecast", label: "見込み" },
            { id: "confirmed", label: "確認済み" },
            { id: "billed", label: "請求確定" },
          ]}
          onChange={setStage}
        />
        <Field label="レビュー状態">
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            <option value="normal">通常</option>
            <option value="cost_missing">原価未取得</option>
            <option value="delay">集計遅延</option>
          </select>
        </Field>
      </div>
      {missing && (
        <Note tone="amber" icon="AlertCircle">
          <strong>一部のAI原価をまだ取得できていません。</strong>
          <p>
            未取得をゼロ円として扱わず、総原価と粗利の計算を保留しています。
          </p>
        </Note>
      )}
      {delay && (
        <Note tone="amber" icon="Clock">
          <strong>利用量の集計が遅れています。</strong>
          <p>
            9月22日09:15時点のスナップショットです。最新値として請求確定には使いません。
          </p>
        </Note>
      )}
      <div className="pt-stats-grid">
        <Stat
          label="月額売上"
          value={yen(total("monthly"))}
          caption="当月固定分・期間選択にかかわらず表示"
          icon="Wallet"
          tone="blue"
        />
        <Stat
          label="成果・従量見込み"
          value={yen(total("variable"))}
          caption="選択した利用期間のサンプル"
          icon="ChartNoAxesCombined"
          tone="lavender"
        />
        <Stat
          label="総原価"
          value={missing ? "—" : yen(total("cost"))}
          caption={
            missing ? "原価未取得・算出保留" : "AI・LINE・基盤費用の合算"
          }
          icon="Layers"
          tone="peach"
        />
        <Stat
          label="粗利見込み"
          value={
            missing
              ? "—"
              : yen(total("monthly") + total("variable") - total("cost"))
          }
          caption={
            missing
              ? "不足データの反映後に算出"
              : "当月固定分＋期間内従量−期間内原価"
          }
          icon="Sparkles"
          tone="sage"
        />
      </div>
      {oa !== "all" && (
        <p className="pt-form-help">
          OA別の月額は、同一企業内のアカウント数による均等配賦のデモです。
        </p>
      )}
      <div className="pt-two-col">
        <Section
          title="LINEの利用量"
          sub={
            delay
              ? "最終集計 09:15 / 更新待ち"
              : "選択した企業・公式LINE・期間の集計"
          }
        >
          <div className="pt-usage-bars">
            {[
              ["個別メッセージ", "messages", "blue"],
              ["カード", "cards", "lavender"],
              ["動画", "videos", "peach"],
              ["予約導線", "links", "sage"],
            ].map(([label, key, tone]) => (
              <div key={key}>
                <span>
                  {label}
                  <strong>
                    {num(sum(key))}
                    <small>件</small>
                  </strong>
                </span>
                <i>
                  <b
                    className={tone}
                    style={{
                      width:
                        Math.max(
                          0,
                          (100 * sum(key)) / Math.max(sum("messages"), 1),
                        ) + "%",
                    }}
                  />
                </i>
              </div>
            ))}
          </div>
        </Section>
        <Section
          title="AI処理と成果"
          sub="モデル・用途別の利用量台帳につなげます。"
        >
          <div className="pt-number-grid">
            {[
              ["AI処理", sum("aiRuns"), "回"],
              ["トークン", num(sum("tokens")), ""],
              ["予約", sum("bookings"), "件"],
              ["実施", sum("attended"), "件"],
              ["初回面談", sum("first"), "件"],
              ["再アポ", sum("repeat"), "件"],
            ].map(([l, n, u]) => (
              <div key={l}>
                <span>{l}</span>
                <strong>
                  {typeof n === "number" ? num(n) : n}
                  <small>{u}</small>
                </strong>
              </div>
            ))}
          </div>
          <div className="pt-cost-breakdown">
            {[
              ["AI原価", "aiCost"],
              ["LINE原価", "lineCost"],
              ["基盤原価", "platformCost"],
            ].map(([l, k]) => (
              <div key={k}>
                <span>{l}</span>
                <strong>{missing ? "未取得" : yen(sum(k))}</strong>
              </div>
            ))}
          </div>
          <p className="pt-form-help">
            単価は発生時点の値・通貨とともに記録する設計です。料金・AIモデル単価は未確定。
          </p>
        </Section>
      </div>
      <Section
        title="企業ごとの内訳"
        sub="見込み・確認済み・請求確定を混在させず、状態を残します。"
      >
        <div className="pt-table-wrap">
          <table>
            <thead>
              <tr>
                <th>企業</th>
                <th>月額売上</th>
                <th>成果・従量</th>
                <th>総原価</th>
                <th>粗利見込み</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td>{yen(c.monthly)}</td>
                  <td>{yen(c.variable)}</td>
                  <td>{missing ? "未取得" : yen(c.cost)}</td>
                  <td>
                    {missing ? "—" : yen(c.monthly + c.variable - c.cost)}
                  </td>
                  <td>
                    <Tag tone={financeStates[c.financialState][1]}>
                      {financeStates[c.financialState][0]}
                    </Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!companies.length && (
          <Empty
            title="この条件のデータはありません"
            description="企業・期間・確認状態を変更してください。"
          />
        )}
      </Section>
    </>
  );
}
function Jobs(ctx) {
  const { state, model, update, notify, audit, openCompany } = ctx;
  const [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState(null);
  const job = state.jobs.find((j) => j.id === selected),
    can = ["ops_owner", "ops_setup"].includes(state.opsRole);
  function retry(j) {
    if (!can || j.error === "WEBHOOK_CONFLICT") return;
    update((s) => {
      const x = s.jobs.find((x) => x.id === j.id);
      x.attempts += 1;
      x.status = "ready";
      x.error = null;
      x.done = [...new Set([...x.done, x.step])];
      x.detail =
        "完了済みの処理を保持し、対象ステップを再実行した状態です（模擬動作）。";
      audit("同一イベントキーで再試行（模擬）", x.id, "ジョブ", s);
    });
    setSelected(null);
    notify(
      "対象のステップを再実行しました。完了済みの処理と冪等キーは保持しています。",
    );
  }
  return (
    <>
      <Title
        eyebrow="JOBS & INCIDENTS"
        title="止まったところから、再開する。"
        description="影響範囲を確認し、完了済みの処理を保持して進めます。"
      >
        <Tag tone="stone">最終更新 09:45 · サンプル</Tag>
      </Title>
      <div className="pt-job-statuses">
        {model.jobStatuses.map((s) => (
          <button
            key={s.id}
            className={filter === s.id ? "active" : ""}
            onClick={() => setFilter(filter === s.id ? "all" : s.id)}
          >
            <Status model={model} id={s.id} />
            <strong>
              {state.jobs.filter((j) => j.status === s.id).length}
            </strong>
          </button>
        ))}
      </div>
      <Section
        title="ジョブ一覧"
        action={
          <button className="pt-text-link" onClick={() => setFilter("all")}>
            すべてを表示
          </button>
        }
      >
        <div className="pt-job-list">
          {state.jobs
            .filter((j) => filter === "all" || j.status === filter)
            .map((j) => (
              <button
                key={j.id}
                className="pt-job-row"
                onClick={() => setSelected(j.id)}
              >
                <Tile
                  name={
                    j.status === "failed"
                      ? "AlertCircle"
                      : j.status === "ready"
                        ? "CheckCheck"
                        : "Activity"
                  }
                  tone={
                    j.status === "failed"
                      ? "rose"
                      : j.status === "ready"
                        ? "sage"
                        : "blue"
                  }
                />
                <div>
                  <strong>{j.name}</strong>
                  <small>
                    {state.companies.find((c) => c.id === j.companyId)?.name} ·{" "}
                    {j.id}
                  </small>
                  <p>{j.detail}</p>
                </div>
                <Status model={model} id={j.status} />
                <span className="pt-retry-count">再試行 {j.attempts}回</span>
                <I name="ChevronRight" size={17} />
              </button>
            ))}
        </div>
        {!state.jobs.some((j) => filter === "all" || j.status === filter) && (
          <Empty
            icon="CheckCheck"
            title="この状態のジョブはありません"
            description="ほかの状態を選んで確認できます。"
          />
        )}
      </Section>
      <Note>
        イベントID・処理済み記録を保持する設計です。同じ処理の再試行でDBや送信が重複しないよう、本番実装で検証が必要です。
      </Note>
      <Modal
        open={job}
        title="ジョブの詳細と再試行"
        onClose={() => setSelected(null)}
        wide
      >
        {job && (
          <>
            <div className="pt-detail-title">
              <Tile
                name={job.status === "failed" ? "AlertCircle" : "Activity"}
                tone={job.status === "failed" ? "rose" : "blue"}
              />
              <div>
                <h2>{job.name}</h2>
                <p>
                  {state.companies.find((c) => c.id === job.companyId)?.name}
                </p>
              </div>
              <Status model={model} id={job.status} />
            </div>
            <Note
              tone={job.error ? "amber" : "blue"}
              icon={job.error ? "AlertCircle" : "CheckCheck"}
            >
              <strong>{job.error || "処理の状況"}</strong>
              <p>{job.detail}</p>
            </Note>
            <div className="pt-key-values">
              <div>
                <span>イベント・冪等キー</span>
                <code>{job.key}</code>
              </div>
              <div>
                <span>再試行回数</span>
                <strong>{job.attempts}回</strong>
              </div>
              <div>
                <span>完了済みのステップ</span>
                <strong>
                  {job.done
                    .map(
                      (id) =>
                        model.activationSteps.find((s) => s.id === id)?.label ||
                        id,
                    )
                    .join(" / ") || "なし"}
                </strong>
              </div>
              <div>
                <span>今回の対象</span>
                <strong>
                  {model.activationSteps.find((s) => s.id === job.step)
                    ?.label || "利用量集計"}
                  のみ
                </strong>
              </div>
            </div>
            {job.error === "WEBHOOK_CONFLICT" ? (
              <>
                <Note tone="rose" icon="Link2">
                  既存WebhookのURLを単純追加・上書きする操作は用意していません。既存ツールとの連携条件を事前確認してください。
                </Note>
                <B
                  variant="secondary"
                  onClick={() => {
                    setSelected(null);
                    openCompany(job.companyId);
                  }}
                >
                  公式LINEの事前確認へ
                </B>
              </>
            ) : job.status === "ready" ? (
              <Tag tone="sage">このステップは完了済み</Tag>
            ) : (
              <B
                icon="RefreshCw"
                disabled={!can || job.status === "customer"}
                onClick={() => retry(job)}
              >
                完了済み処理を保持して再試行（デモ）
              </B>
            )}
            {job.status === "customer" && (
              <B
                variant="secondary"
                onClick={() => {
                  update((s) => {
                    const j = s.jobs.find((x) => x.id === job.id);
                    j.status = "failed";
                    j.error = "RECONNECT_READY";
                    j.detail =
                      "顧客による再接続が完了し、確認処理を再試行できます。";
                  });
                  notify("顧客の再接続完了を再現しました");
                }}
              >
                顧客による再接続完了を再現
              </B>
            )}
            {!can && (
              <p className="pt-form-help">
                再試行は運営責任者・セットアップ担当が操作できます。
              </p>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
function Plans({ model, state, update, notify, audit }) {
  const [edit, setEdit] = useState(false),
    [date, setDate] = useState(state.pricingDate),
    [budget, setBudget] = useState(30000);
  return (
    <>
      <Title
        eyebrow="PLANS & GUARDRAILS"
        title="約束を、設定に。"
        description="プラン・利用上限・適用日を、版とともに管理します。"
      >
        <Tag tone="amber">価格方式・単価は未確定</Tag>
      </Title>
      <div className="pt-plan-grid">
        {model.plans.map((p) => (
          <article
            className={`pt-plan-card ${p.id === "growth" ? "featured" : ""}`}
            key={p.id}
          >
            <div>
              <span>{p.name}</span>
              <Tag tone={p.id === "growth" ? "lavender" : "stone"}>
                仮置きプラン
              </Tag>
            </div>
            <strong>
              {yen(p.monthly)}
              <small>/ 月</small>
            </strong>
            <p>デザイン確認用の料金サンプル</p>
            <ul>
              <li>
                <I name="Check" size={15} />
                公式LINE {p.oaLimit}アカウントまで
              </li>
              <li>
                <I name="Check" size={15} />
                AI予算の目安 {yen(p.aiBudget)}
              </li>
              <li>
                <I name="Check" size={15} />
                承認制から段階的に自動化
              </li>
            </ul>
            <B
              variant={p.id === "growth" ? "primary" : "secondary"}
              disabled={state.opsRole !== "ops_owner"}
              onClick={() => {
                setBudget(p.aiBudget);
                setEdit(true);
              }}
            >
              設定と適用日を確認
            </B>
          </article>
        ))}
      </div>
      <div className="pt-two-col">
        <Section title="共通テンプレート">
          <div className="pt-template-list">
            {[
              ["業界テンプレート", "不動産 / スクール / ライフプラン"],
              ["初期質問", "共通 → 業界 → 企業の三層"],
              ["接続テンプレート", "Harness・Sheets・Drive・Calendar・TimeRex"],
              ["承認ルール", "初期は一段階承認 / 代理送信は別権限"],
            ].map(([l, d]) => (
              <div key={l}>
                <Tile name="FileText" tone="stone" />
                <div>
                  <h3>{l}</h3>
                  <p>{d}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
        <Section title="設定の版と適用日">
          <div className="pt-version-card">
            <Tag tone="lavender">v{state.pricingVersion}</Tag>
            <h3>{state.pricingDate} から適用</h3>
            <p>過去の利用イベント・請求条件は上書きしません。</p>
          </div>
          <Note>
            成果候補の確認と、請求確定は別工程です。料金方式・単価の決定後に本番の契約ルールへ反映します。
          </Note>
        </Section>
      </div>
      <Modal
        open={edit}
        title="新しい設定版の作成"
        onClose={() => setEdit(false)}
      >
        <Note tone="amber">
          以下の金額と上限は仮置きです。実際の契約・請求は変更されません。
        </Note>
        <Field label="適用開始日">
          <input
            type="date"
            min="2026-09-23"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="AI予算上限（円 / 月）">
          <input
            type="number"
            min="0"
            step="1000"
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </Field>
        <B
          disabled={
            date < "2026-09-23" || budget < 0 || state.opsRole !== "ops_owner"
          }
          onClick={() => {
            update((s) => {
              s.pricingHistory = [
                ...(s.pricingHistory || []),
                { version: s.pricingVersion, date: s.pricingDate },
              ];
              s.pricingVersion += 1;
              s.pricingDate = date;
              s.aiBudget = budget;
              audit(
                "新しい設定版を保存（模擬）",
                "v" + s.pricingVersion,
                "プラン設定",
                s,
              );
            });
            setEdit(false);
            notify("新しい版として保存しました。過去の条件は保持しています。");
          }}
        >
          新しい版として保存（デモ）
        </B>
      </Modal>
    </>
  );
}
function Support(ctx) {
  const { state, model, update, go, notify, audit, path } = ctx;
  const [form, setForm] = useState(false),
    [now, setNow] = useState(Date.now()),
    [company, setCompany] = useState("next"),
    [oa, setOA] = useState("oa-7"),
    [reason, setReason] = useState(
      "既存Webhookの競合に関する、お客様からの調査依頼",
    ),
    [minutes, setMinutes] = useState("30");
  const g = state.grant;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const active = g?.status === "active" && g.expiresAt > Date.now();
  function revoke(reason) {
    update((s) => {
      s.grant.status = "revoked";
      audit(reason, s.grant.companyId, "サポートアクセス", s);
    });
    notify("サポートアクセスを失効しました");
  }
  if (path === "/ops/support/view")
    return (
      <>
        <Title
          eyebrow="TEMPORARY SUPPORT ACCESS"
          title="期限付きサポート閲覧"
          description="通常の運営画面から分離した、限定された閲覧範囲です。"
        />
        {!active ? (
          <Empty
            icon="LockKeyhole"
            title="このアクセスは有効ではありません"
            description="未承認・期限切れ・失効したアクセスでは内容を表示できません。"
          >
            <B onClick={() => go("/ops/support")}>サポートアクセスへ戻る</B>
          </Empty>
        ) : (
          <>
            <div className="pt-support-access-banner">
              <I name="Eye" />
              <div>
                <strong>
                  {state.companies.find((c) => c.id === g.companyId)?.name} /{" "}
                  {state.accounts.find((a) => a.id === g.oaId)?.name}
                </strong>
                <p>
                  閲覧のみ · 残り{" "}
                  {Math.max(0, Math.ceil((g.expiresAt - now) / 60000))}分 ·
                  理由：{g.reason}
                </p>
              </div>
              <B
                variant="secondary"
                onClick={() => revoke("閲覧中にサポート権限を返却")}
              >
                アクセスを終了
              </B>
            </div>
            <Section
              title="対象範囲内の会話サンプル"
              sub="この画面の内容は架空のデモです。実際の顧客データは取得していません。"
            >
              <div className="pt-support-conversation">
                <p>
                  <span>サンプル顧客 01</span>
                  予約ページから日程を変更できますか？
                </p>
                <p>
                  <span>担当者</span>はい。予約確認の画面から変更いただけます。
                </p>
              </div>
              <Note>
                この閲覧操作は対象の公式LINEとサポート申請IDを付けて監査ログに記録します。
              </Note>
            </Section>
          </>
        )}
      </>
    );
  return (
    <>
      <Title
        eyebrow="ACCESS & AUDIT"
        title="必要なときに、必要な範囲だけ。"
        description="お客様の要請を起点に、対象と期限を明確にして支援します。"
      >
        <B icon="Plus" onClick={() => setForm(true)}>
          サポートアクセスを申請
        </B>
      </Title>
      <div className="pt-support-principles">
        {[
          ["LockKeyhole", "通常は非表示", "運営ロールだけで会話を開けません。"],
          ["Clock", "期限を限定", "対象の企業・公式LINEだけを、短い時間で。"],
          ["ShieldCheck", "操作を記録", "誰が、何を、どの理由で確認したか。"],
        ].map(([i, l, d]) => (
          <div key={l}>
            <Tile name={i} tone="lavender" />
            <h3>{l}</h3>
            <p>{d}</p>
          </div>
        ))}
      </div>
      <Section
        title="サポートアクセス"
        sub="会話本文は、この一覧には表示しません。"
      >
        {!g ? (
          <Empty
            icon="ShieldCheck"
            title="有効なサポートアクセスはありません"
            description="お客様からの依頼に基づいて、対象と理由を指定して申請します。"
          />
        ) : (
          <div className="pt-grant-card">
            <div>
              <Tile name="LockKeyhole" tone={active ? "sage" : "stone"} />
              <div>
                <h3>
                  {state.companies.find((c) => c.id === g.companyId)?.name}
                </h3>
                <p>
                  {state.accounts.find((a) => a.id === g.oaId)?.name} / 閲覧のみ
                </p>
              </div>
              <Tag
                tone={
                  active ? "sage" : g.status === "pending" ? "amber" : "stone"
                }
              >
                {active
                  ? "有効"
                  : g.status === "pending"
                    ? "顧客承認待ち"
                    : g.status === "revoked"
                      ? "失効"
                      : "期限切れ"}
              </Tag>
            </div>
            <div className="pt-key-values">
              <div>
                <span>依頼理由</span>
                <strong>{g.reason}</strong>
              </div>
              <div>
                <span>対象者</span>
                <strong>木村 直人 / TSUNAGUサポート</strong>
              </div>
              <div>
                <span>有効期限</span>
                <strong>
                  {g.expiresAt
                    ? new Date(g.expiresAt).toLocaleTimeString("ja-JP", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "承認後から" + g.minutes + "分"}
                </strong>
              </div>
            </div>
            <div className="pt-modal-actions">
              {g.status === "pending" && (
                <B
                  variant="secondary"
                  onClick={() => {
                    update((s) => {
                      s.grant.status = "active";
                      s.grant.expiresAt = Date.now() + s.grant.minutes * 60000;
                      s.grant.approvedBy = "顧客管理者（承認を模擬）";
                      audit(
                        "顧客管理者の承認を再現",
                        s.grant.companyId,
                        "サポートアクセス",
                        s,
                      );
                    });
                    notify("顧客承認後の状態を再現しました");
                  }}
                >
                  顧客管理者の承認を再現
                </B>
              )}
              {active && (
                <>
                  <B
                    icon="Eye"
                    onClick={() => {
                      audit(
                        "対象OAの会話サンプルを閲覧",
                        g.oaId,
                        "アクセス " + g.id,
                      );
                      go("/ops/support/view");
                    }}
                  >
                    対象範囲を別画面で開く
                  </B>
                  <B
                    variant="secondary"
                    onClick={() => revoke("サポートアクセスを失効")}
                  >
                    失効する
                  </B>
                  <button
                    className="pt-text-link"
                    onClick={() => {
                      update((s) => (s.grant.expiresAt = Date.now() - 1));
                      notify("期限切れを再現しました");
                    }}
                  >
                    期限切れを再現
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Section>
      <Section
        title="監査ログ"
        sub="設定変更・発行・再試行・サポート閲覧の履歴。"
      >
        <div className="pt-audit-list">
          {state.audit.map((a) => (
            <div key={a.id}>
              <span>
                <I name="ShieldCheck" size={15} />
              </span>
              <div>
                <strong>{a.action}</strong>
                <p>
                  {a.actor} · {a.target}
                </p>
                <small>{a.scope}</small>
              </div>
              <time>{a.at}</time>
            </div>
          ))}
        </div>
      </Section>
      <Modal
        open={form}
        title="期限付きアクセスの申請"
        onClose={() => setForm(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!oa || !reason.trim()) return;
            update((s) => {
              s.grant = {
                id: "grant-" + Date.now(),
                companyId: company,
                oaId: oa,
                reason,
                minutes: Number(minutes),
                status: "pending",
                expiresAt: null,
                scope: "conversation_read",
                requestedBy: "木村 直人",
              };
              audit("サポートアクセスを申請", company, "承認待ち", s);
            });
            setForm(false);
            notify("申請を保存しました。顧客承認までは閲覧できません。");
          }}
        >
          <Field label="依頼元の企業">
            <select
              value={company}
              onChange={(e) => {
                setCompany(e.target.value);
                setOA(
                  state.accounts.find((a) => a.tenantId === e.target.value)
                    ?.id || "",
                );
              }}
            >
              {state.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="対象の公式LINE">
            <select required value={oa} onChange={(e) => setOA(e.target.value)}>
              {state.accounts
                .filter((a) => a.tenantId === company)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="お客様からの依頼と調査理由">
            <textarea
              required
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Field label="承認後の有効期間">
            <select
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            >
              <option value="30">30分</option>
              <option value="60">60分</option>
            </select>
          </Field>
          <Note>
            許可するのは対象OAの閲覧のみ。設定代行の一時管理権限とは別のアクセスです。
          </Note>
          <B type="submit" disabled={!reason.trim() || !oa}>
            顧客の承認を依頼（デモ）
          </B>
        </form>
      </Modal>
    </>
  );
}
