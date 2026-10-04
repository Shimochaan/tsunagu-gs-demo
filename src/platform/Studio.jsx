import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import CustomerApp from "../App.jsx";
import model from "../../model.json";
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
  Avatar,
} from "./ui.jsx";
import { Onboarding } from "./Onboarding.jsx";
import { Ops } from "./Ops.jsx";
import { Structure } from "./Structure.jsx";
const KEY = "tsunagu-platform-v3";
const seed = () => ({
  ...structuredClone(model.fixtures),
  onboarding: {
    step: 0,
    done: [],
    accepted: false,
    companyConfirmed: false,
    membersConfirmed: false,
    connections: false,
    preview: false,
    calibration: false,
    unit: "sales",
    method: "lecture",
    product: "existing",
    companyName: "ネクスト・プロパティ",
    industry: "不動産",
    answers: ["", "", ""],
    profileConfirmed: false,
  },
  grant: null,
  session: null,
  selectedCompany: "next",
  opsRole: "ops_owner",
  customerRole: "sys_admin",
  pricingVersion: 1,
  pricingDate: "2026-10-01",
});
function initial() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return v?.onboarding && Array.isArray(v.accounts) && Array.isArray(v.jobs)
      ? v
      : seed();
  } catch {
    return seed();
  }
}
const route = () =>
  location.hash.startsWith("#/")
    ? location.hash.slice(1)
    : location.protocol === "file:" || location.pathname.endsWith(".html")
      ? "/"
      : location.pathname + location.search;
function Studio() {
  const [path, setPath] = useState(route),
    [state, setState] = useState(initial),
    [toast, setToast] = useState(""),
    [scenario, setScenario] = useState("normal"),
    [dialog, setDialog] = useState(null);
  const timer = useRef();
  useEffect(() => {
    const f = () => setPath(route());
    addEventListener("hashchange", f);
    addEventListener("popstate", f);
    return () => {
      removeEventListener("hashchange", f);
      removeEventListener("popstate", f);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  }, [state]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = useCallback((next) => {
    if (location.protocol === "file:") {
      location.hash = next;
    } else {
      history.pushState({}, "", next);
      setPath(next);
    }
    setScenario("normal");
    window.scrollTo?.(0, 0);
  }, []);
  const update = (fn) =>
    setState((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  const notify = useCallback((text) => {
    setToast(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const audit = (action, target, scope = "設定", draft) => {
    const add = (s) =>
      s.audit.unshift({
        id: "a-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        actor:
          "木村 / " +
          (model.opsRoles.find((r) => r.id === s.opsRole)?.label || "デモ操作"),
        action,
        target,
        scope,
        at: new Date().toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    if (draft) add(draft);
    else update(add);
  };
  const ctx = {
    model,
    state,
    update,
    go,
    notify,
    audit,
    scenario,
    setScenario,
    dialog,
    setDialog,
    path,
  };
  const isSales = path.split("?")[0] === "/sales",
    isOps = path.startsWith("/ops"),
    isSetup = path === "/onboarding";
  return (
    <>
      <div className={`pt-review-bar ${isSales ? "over-sales" : ""}`}>
        <button onClick={() => go("/")}>
          <I name="Layers" size={14} />
          TSUNAGU <span>/</span> Review Studio
        </button>
        <div>
          <span className="pt-demo-status">
            <i />
            デザインモック・外部連携なし
          </span>
          <button onClick={() => go("/structure")}>
            <I name="Workflow" size={14} />
            <span>構造キャンバス</span>
          </button>
          <button aria-label="レビュー設定" onClick={() => setDialog("review")}>
            <I name="SlidersHorizontal" size={16} />
          </button>
        </div>
      </div>
      {isSales ? (
        <CustomerApp
          initialView={
            new URLSearchParams(path.split("?")[1] || "").get("view") || "today"
          }
        />
      ) : (
        <div className="pt-root">
          {path === "/" ? (
            <ReviewHub {...ctx} />
          ) : path === "/login" || path === "/companies" ? (
            <Auth {...ctx} />
          ) : isOps ? (
            <Ops {...ctx} />
          ) : isSetup ? (
            <ScopedOnboarding {...ctx} />
          ) : path === "/structure" ? (
            <Structure {...ctx} />
          ) : (
            <Empty
              title="この画面はありません"
              description="レビュー入口から画面を選択してください。"
            >
              <B onClick={() => go("/")}>レビュー入口へ</B>
            </Empty>
          )}
        </div>
      )}
      <div className="pt-root pt-overlays">
        <Modal
          open={dialog === "review"}
          title="レビューする状態"
          onClose={() => setDialog(null)}
        >
          <p className="pt-muted">
            すべて模擬操作です。実際の認証・権限付与・外部接続は行いません。
          </p>
          <Field label="顧客企業のロール">
            <select
              value={state.customerRole}
              onChange={(e) => update((s) => (s.customerRole = e.target.value))}
            >
              {model.customerRoles.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="TSUNAGU運営のロール">
            <select
              value={state.opsRole}
              onChange={(e) => update((s) => (s.opsRole = e.target.value))}
            >
              {model.opsRoles.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Note>
            顧客ロールと運営ロールは別々に保持しています。表示上の権限制御を確認するための設定です。
          </Note>
          <B
            variant="secondary"
            icon="RefreshCw"
            onClick={() => {
              setState(seed());
              setDialog(null);
              setScenario("normal");
              notify("追加画面のデモデータを初期化しました");
            }}
          >
            追加画面のデモを初期化
          </B>
        </Modal>
        {toast && (
          <div className="pt-toast" role="status">
            <I name="CheckCircle2" size={20} />
            {toast}
            <button aria-label="通知を閉じる" onClick={() => setToast("")}>
              <I name="X" size={16} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
function ScopedOnboarding(ctx) {
  const tenantId = ctx.state.session?.activeTenant || "next";
  const company =
    ctx.state.companies.find((c) => c.id === tenantId) ||
    ctx.state.companies[0];
  const initialScope = {
    ...seed().onboarding,
    companyName: company.name,
    industry: company.industry,
    unit: company.unit,
    method: company.method,
  };
  const scoped =
    tenantId === "next"
      ? ctx.state.onboarding
      : ctx.state.onboardingByTenant?.[tenantId] || initialScope;
  const update = (fn) =>
    ctx.update((s) => {
      if (tenantId === "next") {
        fn(s);
        return;
      }
      const previous = s.onboarding;
      s.onboarding =
        s.onboardingByTenant?.[tenantId] || structuredClone(initialScope);
      fn(s);
      s.onboardingByTenant = {
        ...s.onboardingByTenant,
        [tenantId]: s.onboarding,
      };
      s.onboarding = previous;
    });
  return (
    <Onboarding
      {...ctx}
      state={{ ...ctx.state, onboarding: scoped }}
      update={update}
      tenantId={tenantId}
    />
  );
}
function ReviewHub({ go, state }) {
  return (
    <div className="pt-hub">
      <header>
        <Brand onClick={() => go("/")} />
        <span>PRODUCT DESIGN / SEPTEMBER 2026</span>
      </header>
      <div className="pt-hub-intro">
        <Tag tone="lavender">TSUNAGU Experience Collection</Tag>
        <h1>
          つながりを育てる。
          <br />
          <span>その裏側まで、なめらかに。</span>
        </h1>
        <p>
          日々の営業から、チームの導入、サービスの運営まで。
          <br />
          レビューしたい体験を選んでください。
        </p>
      </div>
      <div className="pt-entry-grid">
        <article className="pt-entry customer">
          <div className="pt-entry-art">
            <div className="pt-art-orbit" />
            <div className="pt-mini-card first">
              <Avatar name="佐" />
              <div>
                <span>今日の候補</span>
                <strong>
                  3<span>件</span>
                </strong>
              </div>
              <I name="Sparkles" size={24} />
            </div>
            <div className="pt-mini-card second">
              <span className="pt-mini-check">
                <I name="Check" />
              </span>
              <div>
                <strong>次のお約束が、できました。</strong>
                <small>一人ひとりに合わせたご連絡</small>
              </div>
            </div>
          </div>
          <div className="pt-entry-body">
            <span className="pt-overline">01 / CUSTOMER EXPERIENCE</span>
            <h2>顧客向けの営業体験</h2>
            <p>
              提案を確認し、言葉を整え、次の面談へ。
              <br />
              営業担当者が毎日使うワークスペース。
            </p>
            <B icon="ArrowRight" onClick={() => go("/sales")}>
              営業ワークスペースを見る
            </B>
            <button className="pt-text-link" onClick={() => go("/login")}>
              共通ログインから確認
              <I name="ArrowUpRight" size={15} />
            </button>
          </div>
        </article>
        <article className="pt-entry operations">
          <div className="pt-entry-art">
            <div className="pt-art-orbit" />
            <div className="pt-mini-card portfolio">
              <div>
                <span>PORTFOLIO</span>
                <strong>
                  {state.companies.length}
                  <small>企業</small>
                </strong>
              </div>
              <div className="pt-art-bars">
                {[28, 43, 35, 58, 50, 73, 90].map((h, i) => (
                  <i style={{ height: h }} key={i} />
                ))}
              </div>
            </div>
            <div className="pt-mini-card progress">
              <span className="pt-mini-check sage">
                <I name="Rocket" />
              </span>
              <div>
                <strong>開通の準備が進んでいます</strong>
                <small>複数の公式LINEを、ひとつの場所で。</small>
              </div>
            </div>
          </div>
          <div className="pt-entry-body">
            <span className="pt-overline">02 / OPERATIONS & ONBOARDING</span>
            <h2>運営・導入の体験</h2>
            <p>
              契約から開通までを見渡し、
              <br />
              利用・成果・収益をひとつにつなぐ。
            </p>
            <B icon="ArrowRight" onClick={() => go("/ops")}>
              運営ワークスペースを見る
            </B>
            <button className="pt-text-link" onClick={() => go("/onboarding")}>
              顧客の初期セットアップを見る
              <I name="ArrowUpRight" size={15} />
            </button>
          </div>
        </article>
      </div>
      <button className="pt-structure-invite" onClick={() => go("/structure")}>
        <Tile name="Workflow" tone="stone" />
        <div>
          <strong>画面の、その先にある構造。</strong>
          <span>画面マップ・概念図・ER図を、共通の model.json から。</span>
        </div>
        <I name="ArrowRight" />
      </button>
      <footer>
        すべて架空のサンプルです。外部認証・DB発行・Webhook・AI原価取得は模擬動作です。
      </footer>
    </div>
  );
}
function Auth({ path, state, update, go, notify, scenario, setScenario }) {
  const [email, setEmail] = useState("sato@next.example"),
    [phase, setPhase] = useState("email"),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [multi, setMulti] = useState(false),
    [method, setMethod] = useState("code");
  function finish() {
    update(
      (s) =>
        (s.session = {
          user: "demo-user",
          email,
          memberships: multi ? ["next", "aoi"] : ["next"],
          activeTenant: "next",
          expiresAt: Date.now() + 3600000,
        }),
    );
    multi ? go("/companies") : go("/onboarding");
  }
  if (path === "/companies") {
    const memberships = state.session?.memberships || [];
    return (
      <div className="pt-auth-stage">
        <div className="pt-auth-simple">
          <Brand onClick={() => go("/")} />
          <h1>
            {memberships.length > 1 ? "お仕事をする企業を選択" : "企業を確認"}
          </h1>
          <p className="pt-muted">
            企業ごとに、所属する役割と閲覧範囲が分かれています。
          </p>
          {memberships.map((id) => {
            const c = state.companies.find((c) => c.id === id);
            return (
              <button
                className="pt-company-choice"
                key={id}
                onClick={() => {
                  update((s) => (s.session.activeTenant = id));
                  go("/onboarding");
                }}
              >
                <Avatar name={c.name} />
                <div>
                  <strong>{c.name}</strong>
                  <span>システム管理者</span>
                </div>
                <I name="ArrowRight" />
              </button>
            );
          })}
          {memberships.length === 0 && (
            <B onClick={() => go("/login")}>ログインへ</B>
          )}
          <button className="pt-text-link" onClick={() => go("/login")}>
            ログインに戻る
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pt-auth-stage">
      <div className="pt-auth-visual">
        <Brand onClick={() => go("/")} />
        <div>
          <span className="pt-overline">A LITTLE MORE HUMAN.</span>
          <h1>
            次のご連絡が、
            <br />
            いい出会いに
            <br />
            <span>つながるように。</span>
          </h1>
          <p>あなたの言葉で、あなたらしい営業を。</p>
        </div>
        <div className="pt-login-orbit">
          <span>
            <I name="MessageCircle" size={35} />
          </span>
          <span>
            <I name="Sparkles" size={27} />
          </span>
          <span>
            <I name="CalendarDays" size={28} />
          </span>
          <i />
          <i />
        </div>
        <small>人とのつながりを、ていねいに。</small>
      </div>
      <div className="pt-auth-form">
        <div className="pt-auth-form-inner">
          <Tag tone="stone">共通ログイン</Tag>
          <h1>
            {phase === "email"
              ? "おかえりなさい。"
              : method === "link"
                ? "メールをご確認ください"
                : "確認コードを入力"}
          </h1>
          <p>
            {phase === "email"
              ? "お仕事のメールアドレスで、はじめましょう。"
              : `${email} に届くメールを模擬表示しています。`}
          </p>
          {scenario === "invite_expired" ? (
            <>
              <Note tone="amber" icon="Clock">
                <strong>招待の有効期限が切れています</strong>
                <p>
                  企業への参加は完了していません。管理者へ再発行を依頼してください。
                </p>
              </Note>
              <B
                onClick={() => {
                  setScenario("normal");
                  notify("招待の再発行依頼を再現しました");
                }}
              >
                再発行を依頼する（デモ）
              </B>
            </>
          ) : (
            <>
              {phase === "email" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setPhase("verify");
                    setError("");
                  }}
                >
                  <Field label="メールアドレス">
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                    />
                  </Field>
                  <B type="submit" icon="ArrowRight">
                    メールで続ける
                  </B>
                  <div className="pt-or">
                    <span />
                    または
                    <span />
                  </div>
                  <B
                    variant="secondary"
                    className="pt-google"
                    type="button"
                    onClick={finish}
                  >
                    <span className="pt-google-g">G</span>Googleで続ける（デモ）
                  </B>
                </form>
              ) : method === "link" ? (
                <>
                  <Tile name="Mail" size={28} />
                  <Note>
                    このモックからメールは送信されません。下のボタンでマジックリンクを開いた後の体験を確認できます。
                  </Note>
                  <B onClick={finish} icon="ArrowRight">
                    デモのリンクでログイン
                  </B>
                </>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    code === "123456"
                      ? finish()
                      : setError(
                          "確認コードが一致しません。デモ用の123456を入力してください。",
                        );
                  }}
                >
                  <Field label="6桁の確認コード">
                    <input
                      className="pt-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="000000"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, ""))
                      }
                    />
                  </Field>
                  {error && (
                    <p role="alert" className="pt-error">
                      {error}
                    </p>
                  )}
                  <B type="submit" disabled={code.length !== 6}>
                    ログイン
                  </B>
                  <p className="pt-form-help">
                    デモ用コード：
                    <button onClick={() => setCode("123456")} type="button">
                      123456を入力
                    </button>
                  </p>
                  <button
                    className="pt-text-link"
                    type="button"
                    onClick={() =>
                      notify(
                        "確認コードの再送を再現しました。実際のメールは送信されません。",
                      )
                    }
                  >
                    コードを再送する
                  </button>
                </form>
              )}
              {phase !== "email" && (
                <button
                  className="pt-text-link"
                  onClick={() => setPhase("email")}
                >
                  <I name="ArrowLeft" size={14} />
                  メールアドレスを変更
                </button>
              )}
            </>
          )}
          <p className="pt-auth-note">
            <I name="LockKeyhole" size={14} />
            所属企業と役割に応じた画面へ進みます。
          </p>
          <details className="pt-demo-options">
            <summary>
              ログインのデモ設定
              <I name="SlidersHorizontal" size={13} />
            </summary>
            <Field label="ログイン方法">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="code">ワンタイムコード</option>
                <option value="link">マジックリンク</option>
              </select>
            </Field>
            <label className="pt-checkbox">
              <input
                type="checkbox"
                checked={multi}
                onChange={(e) => setMulti(e.target.checked)}
              />
              複数企業に所属する利用者
            </label>
            <button
              className="pt-text-link"
              onClick={() =>
                setScenario(
                  scenario === "invite_expired" ? "normal" : "invite_expired",
                )
              }
            >
              招待期限切れを表示
            </button>
          </details>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Studio />);
