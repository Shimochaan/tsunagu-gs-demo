import React from "react";
import { B, Title, Section, Note, Tag } from "../platform/ui.jsx";
import {
  showcaseScreens,
  onboardingFlow,
  liveDemoURL,
} from "./showcase-content.js";
export function ShowcaseBanner({ path, go }) {
  const screen = showcaseScreens.find((x) => x[1] === path);
  return (
    <aside className="showcase-banner" aria-label="画面見学の案内">
      <div>
        <Tag>公開デモ · 架空データ</Tag>
        <strong>
          {screen ? `${screen[0]}の画面：${screen[2]}` : "全画面ガイド"}
        </strong>
      </div>
      <p>
        {screen?.[3] ||
          "運営・企業管理・営業の実際の画面を、共通アカウントで見学できます。"}{" "}
        {screen?.[4]}
      </p>
      <small>
        閲覧・画面内の切り替えができます。保存・送信・外部接続は停止しています。
      </small>
      <div className="showcase-links">
        <B variant="ghost" onClick={() => go("/tour")}>
          画面一覧・導入フロー
        </B>
        <a href={liveDemoURL} target="_blank" rel="noreferrer">
          自分のLINEで体験 ↗
        </a>
      </div>
    </aside>
  );
}
export function ShowcaseGuide({ go }) {
  return (
    <>
      <Title
        eyebrow="PRODUCT TOUR"
        title="つなぐの全体を、見て歩く。"
        description="同じ製品を、営業・企業管理者・運営の3つの視点から。まず「今日の提案」、次に「導入・企業設定」、最後に「運営ホーム」の順がおすすめです。"
      />
      <div className="showcase-entry-grid">
        {[
          ["/sales", "営業の毎日を見る", "情報の変化から、次のご連絡へ。"],
          [
            "/onboarding",
            "企業の導入を見る",
            "公式LINE・情報元・営業担当をつなぐ。",
          ],
          ["/ops", "運営の仕事を見る", "受注から開通、日々の支援まで。"],
        ].map(([url, title, desc]) => (
          <button className="showcase-entry" key={url} onClick={() => go(url)}>
            <strong>{title} →</strong>
            <span>{desc}</span>
          </button>
        ))}
      </div>
      <Section
        title="受注から、使い始めるまで"
        sub="実際の企業に導入する際の操作と担当者です。現在は初期接続を運営と企業管理者で進め、営業の日常操作をLINEに集める構成です。"
      >
        <ol className="showcase-flow">
          {onboardingFlow.map(([title, role, text]) => (
            <li key={title}>
              <Tag>{role}</Tag>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </Section>
      <div className="product-stack">
        {["営業", "企業管理", "運営", "共通"].map((role) => (
          <Section key={role} title={`${role}の画面`}>
            <div className="showcase-screen-list">
              {showcaseScreens
                .filter((x) => x[0] === role)
                .map(([_, url, title, why, how]) => (
                  <article key={url}>
                    <div>
                      <B variant="secondary" onClick={() => go(url)}>
                        {title} →
                      </B>
                      <p>{why}</p>
                      <small>{how}</small>
                    </div>
                  </article>
                ))}
            </div>
          </Section>
        ))}
      </div>
      <Section title="共有と権限の範囲">
        <p>
          企業ごとに共通の顧客DBを持ち、閲覧・編集は役割・担当・チーム設定で制御します。商品情報・議事録・提案は公式LINE（OA）単位のDBに保存し、同じOAの営業が権限に応じて使います。複数OAの商品情報を企業全体へ自動集約する仕組みとは異なります。
        </p>
        <Note>
          このログインでは画面を比較するため、架空企業の複数の役割をまとめています。本運用では担当者に必要な権限だけを付与し、運営が顧客の会話を自由に閲覧する設定にはしません。
        </Note>
      </Section>
      <Section title="実際に試せること・画面で確認すること">
        <p>
          Googleログインの実機デモでは、自分のLINEへの提案・編集・承認・送信、議事録と物件の追加、TimeRex予約を試せます。こちらの全画面見学では、実送信やAIの呼び出しは行いません。
        </p>
        <p>
          リサーチ・カレンダー・PDF/Excel取り込みなどの設定画面も閲覧できます。設定画面の表示は、すべての外部接続・課金・請求処理の実機検証完了を意味しません。
        </p>
        <a href={liveDemoURL} target="_blank" rel="noreferrer">
          Googleでログインして、自分のLINEで体験する ↗
        </a>
      </Section>
    </>
  );
}
