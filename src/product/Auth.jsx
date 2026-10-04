import React, { useState } from "react";
import QRCode from "qrcode";
import {
  B,
  I,
  Brand,
  Field,
  Tag,
  Note,
  Section,
  Title,
} from "../platform/ui.jsx";
import { api } from "./api.js";
import { Form, Action } from "./shared.jsx";

export function Login({ reload, config }) {
  const [email, setEmail] = useState(""),
    [step, setStep] = useState("email"),
    [sent, setSent] = useState(false);

  return (
    <main className="pt-auth-stage">
      <section className="pt-auth-visual">
        <Brand />
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
            <I name="MessageCircle" size={32} />
          </span>
          <span>
            <I name="Sparkles" size={26} />
          </span>
          <span>
            <I name="CalendarDays" size={26} />
          </span>
        </div>
        <small>人とのつながりを、ていねいに。</small>
      </section>
      <section className="pt-auth-form">
        <div className="pt-auth-form-inner">
          <Tag>{config?.selfDemo ? "G’s 提出用・実機体験" : "共通ログイン"}</Tag>
          <h1>
            {config?.selfDemo ? "自分のLINEで、つなぐを体験。" : step === "email" ? "おかえりなさい。" : "メールをご確認ください。"}
          </h1>
          <p>
            {step === "email"
              ? (config?.selfDemo ? "Googleでログインすると、LINE連携・追客文の編集と送信・日程予約を試せます。招待は不要です。" : "招待を受けた、お仕事のメールアドレスではじめましょう。")
              : `${email} 宛の6桁のコードを入力してください。招待が有効な場合にメールが届きます。`}
          </p>
          {config?.setupRequired && (
            <Note tone="amber">
              G's不動産のログイン入口です。Google認証の初期設定が未完了のため、まだログインできません。管理者が認証設定を終えると「Googleで続ける」が表示されます。
            </Note>
          )}
          {config?.selfDemo ? null : config?.mail === false ? (
            <Note tone="amber">
              メールログインの配信設定が未完了です。
              {config?.google
                ? "Googleで続けることができます。"
                : "管理者へ配信設定の確認を依頼してください。"}
            </Note>
          ) : step === "email" ? (
            <Form
              button="メールで続ける"
              onSubmit={async (v) => {
                const targetEmail = v.email.trim();
                setEmail(targetEmail);
                await api("/api/auth/email-otp/send-verification-otp", {
                  email: targetEmail,
                  type: "sign-in",
                });
                setStep("code");
              }}
            >
              <Field label="メールアドレス">
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@company.jp"
                  defaultValue={email}
                />
              </Field>
            </Form>
          ) : (
            <>
              <Form
                button="ログインする"
                onSubmit={async (v) => {
                  await api("/api/auth/sign-in/email-otp", {
                    email,
                    otp: v.code,
                  });
                  await reload();
                }}
              >
                <Field label="確認コード">
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    autoFocus
                  />
                </Field>
              </Form>
              <Action
                run={async () => {
                  await api("/api/auth/email-otp/send-verification-otp", {
                    email,
                    type: "sign-in",
                  });
                }}
              >
                コードを再送する
              </Action>
              <B variant="ghost" onClick={() => setStep("email")}>
                メールアドレスを変更
              </B>
              <Action
                variant="ghost"
                run={async () => {
                  await api("/api/auth/sign-in/magic-link", {
                    email,
                    callbackURL: "/",
                  });
                  setSent(true);
                }}
              >
                ログイン用リンクを受け取る
              </Action>
              {sent && (
                <Note>招待が有効な場合、ログイン用リンクを送信しました。</Note>
              )}
            </>
          )}
          {config?.google && (
            <Action
              run={async () => {
                const r = await api("/api/auth/sign-in/social", {
                  provider: "google",
                  callbackURL: "/",
                });
                if (r.url) location.assign(r.url);
              }}
            >
              Googleで続ける
            </Action>
          )}
          {config?.mailMode === "local" && (
            <Note>
              ローカル検証環境です。メールは外部送信されず、開発者用のローカル受信箱に保存されます。
            </Note>
          )}
          <p className="product-auth-note">
            <I name="LockKeyhole" size={14} />
            {config?.selfDemo ? "Googleの基本情報のみ使用します。自分のLINE宛てに体験できます。" : "所属企業と役割に応じた画面へ進みます。"}
          </p>
        </div>
      </section>
    </main>
  );
}

export function Security({ me, reload }) {
  const [enrollment, setEnrollment] = useState(null);
  const [qrCodeUrl, setQrCodeUrl] = useState(null);

  const startEnrollment = async () => {
    const res = await api("/api/security/enroll", {});
    setEnrollment(res);
    if (res?.uri) {
      try {
        const url = await QRCode.toDataURL(res.uri, {
          width: 220,
          margin: 2,
          color: { dark: "#0f172a", light: "#ffffff" },
        });
        setQrCodeUrl(url);
      } catch (err) {
        console.error("QR Code generation failed:", err);
      }
    }
  };

  return (
    <div className="product-centered">
      <Brand ops />
      <Title
        eyebrow="ACCOUNT SECURITY"
        title="運営画面への追加確認"
        description="認証アプリに表示される確認コードを入力してください。"
      />
      <Section title={me.mfaEnrolled ? "認証アプリで確認" : "認証アプリを登録"}>
        {!me.mfaEnrolled && !enrollment && (
          <Action run={startEnrollment}>QRコードを表示して登録</Action>
        )}
        {enrollment && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              margin: "16px 0",
            }}
          >
            <Note>
              認証アプリ（Google
              Authenticator、1Password等）で以下のQRコードを読み取ってください。
            </Note>
            {qrCodeUrl ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  background: "#ffffff",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid var(--border, #e2e8f0)",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
                  maxWidth: "260px",
                  margin: "0 auto",
                }}
              >
                <img
                  src={qrCodeUrl}
                  alt="MFA QR Code"
                  style={{ width: "200px", height: "200px", display: "block" }}
                />
                <span
                  style={{
                    fontSize: "11px",
                    color: "var(--muted, #64748b)",
                    marginTop: "8px",
                  }}
                >
                  カメラで読めない場合のセットアップキー:
                </span>
                <code
                  className="product-secret"
                  style={{
                    fontSize: "12px",
                    userSelect: "all",
                    wordBreak: "break-all",
                    marginTop: "4px",
                  }}
                >
                  {enrollment.secret}
                </code>
              </div>
            ) : (
              <Note>
                認証アプリで「セットアップキーを入力」を選び、次のキーを登録してください。
                <code className="product-secret">{enrollment.secret}</code>
                時刻ベース・6桁を選択してください。
              </Note>
            )}
          </div>
        )}
        {(me.mfaEnrolled || enrollment) && (
          <Form
            button="確認して進む"
            onSubmit={async (v) => {
              await api("/api/security/verify", { code: v.code });
              setEnrollment(null);
              await reload();
            }}
          >
            <Field label="認証アプリの6桁のコード">
              <input
                name="code"
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                autoComplete="one-time-code"
                autoFocus
              />
            </Field>
          </Form>
        )}
      </Section>
      <Action
        variant="ghost"
        run={async () => {
          await api("/api/auth/sign-out", {});
          await reload();
        }}
      >
        ログアウト
      </Action>
    </div>
  );
}
