import React, { useState, useEffect, useCallback, useRef } from "react";
import { SelfDemo, PublicDemoPage } from "./SelfDemo.jsx";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../platform/platform.css";
import "./product.css";
import { B, Brand, Title, Section, Note, Tag } from "../platform/ui.jsx";
import { api, label } from "./api.js";
import { Action, Shell, State, Blank } from "./shared.jsx";
import { Login, Security } from "./Auth.jsx";
import { Ops } from "./Ops.jsx";
import { ShowcaseGuide,ShowcaseBanner } from "./Showcase.jsx";
import { Onboarding, Profiles } from "./Onboarding.jsx";
import { Sales } from "./Sales.jsx";
import { captureShowcaseDraft,readShowcaseDraft } from './showcase-handoff.js';
captureShowcaseDraft();
function getInitialMe() {
  try {
    const raw = sessionStorage.getItem("tsunagu_session_user");
    if (raw) return JSON.parse(raw);
  } catch {}
  return undefined;
}

function Product() {
  const switchingReview = useRef(false);
  useEffect(() => {
    const reviewQuery = new URLSearchParams(location.search);
    if (
      location.pathname === "/sales" &&
      reviewQuery.has("assistant") &&
      reviewQuery.has("oa") &&
      reviewQuery.has("tenant")
    ) {
      try {
        sessionStorage.setItem(
          "assistant_return",
          location.pathname + location.search,
        );
      } catch {}
    }
  }, []);
  const [me, setMe] = useState(getInitialMe),
    [config, setConfig] = useState(null),
    [error, setError] = useState(""),
    [path, setPath] = useState(location.pathname);
  const go = useCallback((next) => {
    history.pushState(null, "", next);
    setPath(new URL(next, location.origin).pathname);
    window.scrollTo(0, 0);
  }, []);
  const reload = useCallback(async () => {
    setError("");
    try {
      const data = await api("/api/me");
      setMe(data);
      try {
        sessionStorage.setItem("tsunagu_session_user", JSON.stringify(data));
      } catch {}
      return data;
    } catch (e) {
      if (e.status === 401) {
        try {
          sessionStorage.removeItem("tsunagu_session_user");
        } catch {}
        setMe(null);
        return null;
      }
      setError(e.message);
    }
  }, []);
  const enter = useCallback(async () => {
    const data = await reload();
    let review;
    try {
      review = sessionStorage.getItem("assistant_return");
    } catch {}
    if (
      review &&
      review.startsWith("/sales?") &&
      data?.memberships?.some(
        (m) =>
          m.tenant_id ===
          new URL(review, location.origin).searchParams.get("tenant"),
      )
    ) {
      const targetTenant = new URL(review, location.origin).searchParams.get(
        "tenant",
      );
      await api("/api/session/tenant", { tenantId: targetTenant });
      await reload();
      sessionStorage.removeItem("assistant_return");
      go(review);
    } else go(data?.selfDemo && readShowcaseDraft() ? '/demo' : data?.home || "/login");
  }, [go, reload]);
  useEffect(() => {
    reload();
    api("/api/config")
      .then(setConfig)
      .catch(() => {});
    const listener = () => setPath(location.pathname);
    addEventListener("popstate", listener);
    return () => removeEventListener("popstate", listener);
  }, [reload]);
  useEffect(() => {
    const target = new URLSearchParams(location.search).get("tenant");
    if (
      !me ||
      !target ||
      !(path.startsWith("/sales") || path === "/onboarding") ||
      me.activeTenant === target ||
      switchingReview.current
    )
      return;
    if (!me.memberships.some((m) => m.tenant_id === target)) return;
    switchingReview.current = true;
    api("/api/session/tenant", { tenantId: target })
      .then(reload)
      .catch((e) => setError(e.message))
      .finally(() => {
        switchingReview.current = false;
      });
  }, [me, path, reload]);
  useEffect(() => {
    if (path.startsWith("/demo/book/") || path.startsWith("/demo/property/")) return;
    if (me === undefined) return;
    if (me === null) {
      if (path !== "/login") go("/login");
      return;
    }
    if (path === "/" || path === "/login") go(me.selfDemo && readShowcaseDraft() ? '/demo' : me.home);
    if (path.startsWith("/ops") && (!me.opsRole || !me.mfa))
      go(me.opsRole ? "/security" : me.home);
  }, [me, path, go]);
  if (path.startsWith("/demo/book/") || path.startsWith("/demo/property/")) return <PublicDemoPage path={path}/>;
  if (error)
    return (
      <div className="product-centered">
        <State error={error} />
        <B onClick={reload}>再読み込み</B>
      </div>
    );
  if (me === undefined) return <State />;
  if (me === null) return <Login reload={enter} config={config} />;
  if (me.selfDemo && (path === "/demo" || me.demoOnly)) return <SelfDemo me={me}/>;
  if (path === "/security") return <>{me.showcase && <ShowcaseBanner path={path} go={go}/>}<Security me={me} reload={enter} /></>;
  if (
    path === "/invitations" ||
    path === "/companies" ||
    (!me.activeTenant && !path.startsWith("/ops"))
  )
    return (
      <div className="product-centered">
        {me.showcase && <ShowcaseBanner path={path} go={go}/>}
        <Brand />
        <Title
          eyebrow="WORKSPACE"
          title={
            path === "/invitations"
              ? "参加する企業をご確認ください。"
              : "ワークスペースを選択"
          }
          description={me.user.email}
        />
        <div className="product-stack">
          {me.invitations.map((i) => (
            <Section
              key={i.id}
              title={i.name}
              sub={i.roles.map(label).join(" / ")}
            >
              <Action
                variant="primary"
                run={() => api(`/api/invitations/${i.id}/accept`, {})}
                done={enter}
              >
                招待を受けて参加する
              </Action>
            </Section>
          ))}
          {me.memberships.map((m) => (
            <Section
              key={m.tenant_id}
              title={m.name}
              sub={m.roles.map(label).join(" / ")}
            >
              <Action
                run={async () => {
                  await api("/api/session/tenant", { tenantId: m.tenant_id });
                  const next = await reload();
                  const roles = m.roles;
                  go(
                    m.tenant_state === "setup"
                      ? roles.some((r) =>
                          ["sys_admin", "org_owner"].includes(r),
                        )
                        ? "/onboarding"
                        : "/setup-waiting"
                      : roles.some((r) =>
                            ["sales", "team_admin", "org_owner"].includes(r),
                          )
                        ? "/sales"
                        : roles.includes("sys_admin")
                          ? "/onboarding"
                          : "/billing",
                  );
                }}
              >
                この企業へ進む
              </Action>
            </Section>
          ))}
          {!me.invitations.length && !me.memberships.length && (
            <Blank
              title="所属する企業がありません"
              description="管理者へ、このメールアドレス宛の招待を依頼してください。"
            />
          )}
          <Action
            variant="ghost"
            run={async () => {
              await api("/api/auth/sign-out", {});
              await enter();
            }}
          >
            ログアウト
          </Action>
        </div>
      </div>
    );
  return (
    <Shell me={me} path={path} go={go} refreshMe={reload}>
      {path === "/tour" && me.showcase ? <ShowcaseGuide go={go}/> : path.startsWith("/ops") ? (
        <Ops key={path} me={me} path={path} go={go} />
      ) : path === "/onboarding" ? (
        <Onboarding key={me.activeTenant} tenant={me.activeTenant} me={me} reloadMe={reload} />
      ) : path === "/profile" ? (
        <Profiles tenant={me.activeTenant} />
      ) : path.startsWith("/sales") ? (
        <Sales me={me} tenant={me.activeTenant} path={path} />
      ) : path === "/setup-waiting" ? (
        <>
          <Title
            title="公式LINEの準備を進めています。"
            description="開通までに、あなたらしい言葉の設定を済ませておきましょう。"
          />
          <B onClick={() => go("/profile")}>言葉の設定へ</B>
        </>
      ) : path === "/billing" ? (
        <>
          <Title
            title="請求書"
            description="確定した請求書を確認する場所です。"
          />
          <Blank
            title="請求書はまだありません"
            description="請求の確定後にお知らせします。"
          />
        </>
      ) : (
        <Blank
          title="画面が見つかりません"
          description="メニューから移動してください。"
        />
      )}
    </Shell>
  );
}
class Boundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="product-centered">
        <Note tone="rose">
          画面の読み込みに失敗しました。再読み込みしてください。
        </Note>
        <B onClick={() => location.reload()}>再読み込み</B>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")).render(
  <div className="pt-root">
    <Boundary>
      <Product />
    </Boundary>
  </div>,
);
