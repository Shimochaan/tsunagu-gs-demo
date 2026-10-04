import React, { useState, useRef } from "react";
import { B, I, Brand, Avatar, Tag, Note, Empty } from "../platform/ui.jsx";
import { api, label } from "./api.js";
export function State({ error, children }) {
  return error ? (
    <Note tone="rose" icon="AlertCircle">
      {error}
    </Note>
  ) : (
    children || (
      <p role="status" className="product-loading">
        読み込んでいます…
      </p>
    )
  );
}
export function Status({ value }) {
  return (
    <Tag
      dot
      tone={
        ["ready", "completed", "active", "sent"].includes(value)
          ? "green"
          : ["failed", "held", "suspended"].includes(value)
            ? "rose"
            : "lavender"
      }
    >
      {label(value)}
    </Tag>
  );
}
export function Form({
  children,
  onSubmit,
  button = "保存する",
  onDone,
  onError,
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="product-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (lock.current) return;
        lock.current = true;
        const data = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        setError("");
        try {
          await onSubmit(data);
          onDone?.();
        } catch (e) {
          setError(e.message);
          onError?.(e);
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>{children}</fieldset>
      {error && (
        <div role="alert">
          <Note tone="rose" icon="AlertCircle">
            {error}
          </Note>
        </div>
      )}
      <B type="submit" icon={busy ? "LoaderCircle" : "Check"} disabled={busy}>
        {busy ? "処理しています…" : button}
      </B>
    </form>
  );
}
export function Action({
  run,
  children,
  done,
  variant = "secondary",
  onError,
  ...props
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <B
        {...props}
        variant={variant}
        disabled={busy || props.disabled}
        onClick={async () => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await run();
            done?.();
          } catch (e) {
            setError(e.message);
            onError?.(e);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? "処理中…" : children}
      </B>
      {error && (
        <p role="alert" className="product-error">
          {error}
        </p>
      )}
    </>
  );
}
export function Shell({ me, path, go, children, refreshMe }) {
  const ops = path.startsWith("/ops"),
    m = me.memberships.find((x) => x.tenant_id === me.activeTenant),
    roles = m?.roles || [];
  const menus = ops
    ? [
        ["/ops", "LayoutDashboard", "ホーム"],
        ["/ops/tenants", "Building2", "受注・開通"],
        ["/ops/jobs", "Activity", "処理・障害"],
        ...(["ops_owner", "ops_finance"].includes(me.opsRole)
          ? [["/ops/usage", "Wallet", "利用量・原価"]]
          : []),
        ["/ops/support", "HandHeart", "サポート"],
        ["/ops/audit", "ShieldCheck", "操作履歴"],
      ]
    : [
        ...(roles.some((r) => ["sales", "team_admin", "org_owner"].includes(r))
          ? [
              ["/sales", "Sparkles", "今日の提案"],
              ["/sales/dashboard", "ChartNoAxesCombined", "成果"],
              ["/sales/customers", "Users", "顧客"],
              ["/sales/meetings", "CalendarDays", "面談結果"],
            ]
          : []),
        ["/profile", "MessageCircle", "あなたらしい言葉"],
        ...(roles.some((r) => ["sys_admin", "org_owner"].includes(r))
          ? [
              ["/sales/connections", "Link", "接続設定"],
              ["/onboarding", "Settings", "導入・企業設定"],
            ]
          : []),
        ...(roles.includes("billing")
          ? [["/billing", "FileText", "請求書"]]
          : []),
      ];
  return (
    <div className="pt-ops-layout product-shell">
      <aside className="pt-ops-sidebar">
        <Brand ops={ops} onClick={() => go(me.home)} />
        <div className="pt-ops-space">
          <span className="pt-space-mark">
            <I name={ops ? "Layers" : "Building2"} />
          </span>
          <div>
            <strong>
              {ops ? "TSUNAGU Operations" : m?.name || "ワークスペース"}
            </strong>
            <small>
              {ops ? label(me.opsRole) : roles.map(label).join(" / ")}
            </small>
          </div>
        </div>
        <nav aria-label="メインナビゲーション">
          {menus.map(([href, icon, text]) => (
            <button
              key={href}
              className={path === href ? "active" : ""}
              onClick={() => go(href)}
            >
              <I name={icon} />
              <span>{text}</span>
            </button>
          ))}
        </nav>
        <div className="pt-ops-side-note">
          <I name={ops ? "ShieldCheck" : "HandHeart"} />
          <strong>
            {ops
              ? "企業の運用を、ていねいに。"
              : "人とのつながりを、ていねいに。"}
          </strong>
          {me.memberships.length > 1 && (
            <B variant="ghost" onClick={() => go("/companies")}>
              所属企業を切り替える
            </B>
          )}
          {ops && me.memberships.length > 0 && (
            <B variant="ghost" onClick={() => go("/companies")}>
              顧客ワークスペースへ
            </B>
          )}
          {!ops && me.opsRole && (
            <B
              variant="ghost"
              onClick={() => go(me.mfa ? "/ops" : "/security")}
            >
              運営画面へ
            </B>
          )}
        </div>
        <div className="pt-ops-profile">
          <Avatar name={me.user.name || me.user.email} />
          <span>
            <strong>{me.user.name || me.user.email}</strong>
            <small>{me.user.email}</small>
          </span>
        </div>
        <Action
          variant="ghost"
          run={async () => {
            await api("/api/auth/sign-out", {});
            try {
              sessionStorage.removeItem("tsunagu_session_user");
            } catch {}
            refreshMe();
            go("/login");
          }}
        >
          ログアウト
        </Action>
      </aside>
      <div className="pt-ops-body">
        <header className="pt-ops-topbar">
          <div>
            <I name={ops ? "Layers" : "Building2"} />
            <strong>{ops ? "運営管理" : m?.name || "TSUNAGU"}</strong>
          </div>
          <Tag>{ops ? "OPERATIONS" : "WORKSPACE"}</Tag>
        </header>
        <main className="pt-ops-main">{children}</main>
      </div>
    </div>
  );
}
export function Blank({ title, description }) {
  return <Empty title={title} description={description} />;
}
