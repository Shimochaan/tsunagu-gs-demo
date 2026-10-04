import React, { useState } from "react";
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
  Status,
  Avatar,
  Segments,
} from "./ui.jsx";
export function Onboarding(ctx) {
  const {
    state,
    model,
    update,
    go,
    notify,
    scenario,
    setScenario,
    tenantId = "next",
  } = ctx;
  const o = state.onboarding,
    [member, setMember] = useState(null);
  const current = model.onboardingSteps[o.step],
    accounts = state.accounts.filter((a) => a.tenantId === tenantId),
    ready = accounts.filter((a) => a.status === "ready").length;
  const allowed = ["sys_admin", "org_owner"].includes(state.customerRole);
  function next() {
    update((s) => {
      const id = model.onboardingSteps[s.onboarding.step].id;
      s.onboarding.done = [...new Set([...s.onboarding.done, id])];
      s.onboarding.step = Math.min(7, s.onboarding.step + 1);
    });
    window.scrollTo?.(0, 0);
  }
  function patch(v) {
    update((s) => {
      Object.assign(s.onboarding, v);
      const company = s.companies.find((c) => c.id === tenantId);
      if (company && v.method) company.method = v.method;
      if (company && v.unit) company.unit = v.unit;
      if (company && v.product) company.product = v.product;
    });
  }
  const valid = [
    o.accepted,
    o.companyName.trim() && o.companyConfirmed,
    o.membersConfirmed,
    accounts.length > 0,
    o.connections,
    o.preview,
    o.calibration,
    true,
  ][o.step];
  return (
    <div className="pt-setup">
      <header className="pt-setup-top">
        <Brand onClick={() => go("/")} />
        <div>
          <Tag tone="sage">顧客企業の導入</Tag>
          <span>{o.companyName}</span>
          {state.session?.memberships?.length > 1 && (
            <button className="pt-text-link" onClick={() => go("/companies")}>
              企業を切替
              <I name="ChevronDown" size={13} />
            </button>
          )}
          <button className="pt-text-link" onClick={() => go("/")}>
            レビュー入口
            <I name="ArrowUpRight" size={14} />
          </button>
        </div>
      </header>
      <div className="pt-setup-layout">
        <aside className="pt-setup-sidebar">
          <span className="pt-overline">GETTING STARTED</span>
          <h2>
            いいスタートを、
            <br />
            一緒に。
          </h2>
          <p>
            入力した内容は保存されます。
            <br />
            いつでも続きから始められます。
          </p>
          <div className="pt-setup-progress">
            <span>
              準備の進み具合
              <strong>{Math.round((o.done.length / 8) * 100)}%</strong>
            </span>
            <i>
              <b style={{ width: (o.done.length / 8) * 100 + "%" }} />
            </i>
          </div>
          <nav aria-label="セットアップの手順">
            {model.onboardingSteps.map((s, i) => (
              <button
                key={s.id}
                className={i === o.step ? "active" : ""}
                onClick={() => patch({ step: i })}
              >
                <span className={o.done.includes(s.id) ? "done" : ""}>
                  {o.done.includes(s.id) ? (
                    <I name="Check" size={14} />
                  ) : (
                    String(i + 1).padStart(2, "0")
                  )}
                </span>
                <div>
                  <strong>{s.label}</strong>
                  <small>{s.description}</small>
                </div>
              </button>
            ))}
          </nav>
          <div className="pt-setup-help">
            <Tile name="HandHeart" tone="peach" />
            <strong>途中からの代行もできます。</strong>
            <p>
              入力内容と完了したステップを引き継いで、担当者がお手伝いします。
            </p>
            <button
              className="pt-text-link"
              onClick={() => {
                patch({ method: "delegated" });
                notify("進捗を引き継ぎ、当社代行に切り替えました（デモ）");
              }}
            >
              セットアップを依頼
              <I name="ArrowRight" size={14} />
            </button>
          </div>
        </aside>
        <main className="pt-setup-main">
          <div className="pt-setup-meta">
            <span>SETUP / {String(o.step + 1).padStart(2, "0")} OF 08</span>
            <Tag tone="stone">自動保存 · デモ</Tag>
          </div>
          <Title
            title={current.label}
            description={
              [
                "まずは、参加する企業と役割をご確認ください。",
                "あなたのチームのことを教えてください。",
                "使う人と、任せる範囲を整えましょう。",
                "いつもの営業スタイルに合う窓口を。",
                "何を、どの範囲でつなぐかを確認します。",
                "取込みの前に、内容と共有範囲を確認します。",
                "会社の方針と、あなたらしい言葉を重ねます。",
                "準備のできた公式LINEから、はじめましょう。",
              ][o.step]
            }
          />
          {!allowed || scenario === "no_permission" ? (
            <Empty
              icon="LockKeyhole"
              title="この設定を変更する権限がありません"
              description="企業のシステム管理者または組織責任者に設定を依頼してください。顧客会話の閲覧権限とは別の権限です。"
            >
              <B
                variant="secondary"
                onClick={() => {
                  update((s) => (s.customerRole = "sys_admin"));
                  setScenario("normal");
                }}
              >
                管理者の状態で確認（デモ）
              </B>
            </Empty>
          ) : (
            <>
              {o.step === 0 && (
                <Section
                  title={`${o.companyName}からの招待`}
                  sub="招待者：田中 雅人 / 組織責任者"
                >
                  <div className="pt-invite-card">
                    <Avatar name="山口" tone="lavender" />
                    <div>
                      <h3>初期管理者 様</h3>
                      <p>
                        {state.companies.find((c) => c.id === tenantId)?.admin}
                      </p>
                    </div>
                    <Tag tone="lavender">システム管理者</Tag>
                  </div>
                  {scenario === "invite_expired" ? (
                    <Note tone="amber" icon="Clock">
                      <strong>この招待は期限切れです</strong>
                      <p>管理者に再発行を依頼してください。</p>
                      <B
                        variant="secondary"
                        onClick={() => {
                          setScenario("normal");
                          notify("招待再発行を模擬実行しました");
                        }}
                      >
                        招待を再発行（デモ）
                      </B>
                    </Note>
                  ) : (
                    <>
                      <div className="pt-key-values">
                        <div>
                          <span>参加する企業</span>
                          <strong>{o.companyName}</strong>
                        </div>
                        <div>
                          <span>担当できること</span>
                          <strong>メンバー・公式LINE・連携設定</strong>
                        </div>
                        <div>
                          <span>顧客との会話</span>
                          <strong>この役割のみでは閲覧不可</strong>
                        </div>
                        <div>
                          <span>招待の有効期限</span>
                          <strong>2026年9月29日 18:00</strong>
                        </div>
                      </div>
                      <label className="pt-checkbox spacious">
                        <input
                          type="checkbox"
                          checked={o.accepted}
                          onChange={(e) =>
                            patch({ accepted: e.target.checked })
                          }
                        />
                        企業と役割を確認し、招待を受諾します
                      </label>
                    </>
                  )}
                  <button
                    className="pt-text-link"
                    onClick={() =>
                      setScenario(
                        scenario === "invite_expired"
                          ? "normal"
                          : "invite_expired",
                      )
                    }
                  >
                    招待期限切れの状態を見る
                  </button>
                </Section>
              )}
              {o.step === 1 && (
                <>
                  <Section title="企業の基本情報">
                    <div className="pt-form-grid">
                      <Field label="企業名">
                        <input
                          value={o.companyName}
                          onChange={(e) =>
                            patch({ companyName: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="業種">
                        <select
                          value={o.industry}
                          onChange={(e) => patch({ industry: e.target.value })}
                        >
                          <option>不動産</option>
                          <option>スクール・教育</option>
                          <option>コーチング</option>
                          <option>その他</option>
                        </select>
                      </Field>
                    </div>
                    <Field label="所属チーム・店舗">
                      <input
                        defaultValue="東京 第1チーム"
                        onBlur={(e) => patch({ team: e.target.value })}
                      />
                    </Field>
                    <label className="pt-checkbox">
                      <input
                        type="checkbox"
                        checked={o.companyConfirmed}
                        onChange={(e) =>
                          patch({ companyConfirmed: e.target.checked })
                        }
                      />
                      企業情報を確認しました
                    </label>
                  </Section>
                  <MethodPicker {...ctx} />
                </>
              )}
              {o.step === 2 && (
                <>
                  <Section
                    title="担当者と役割"
                    sub="閲覧・承認・送信の権限を分けて管理します。"
                    action={
                      <B
                        variant="secondary"
                        icon="Plus"
                        onClick={() =>
                          setMember({
                            name: "",
                            email: "",
                            role: "sales",
                            team: "東京 第1チーム",
                          })
                        }
                      >
                        担当者を追加
                      </B>
                    }
                  >
                    <div className="pt-member-list">
                      {state.members
                        .filter((m) => (m.tenantId || "next") === tenantId)
                        .map((m) => (
                          <div key={m.id}>
                            <Avatar name={m.name} />
                            <div>
                              <strong>{m.name}</strong>
                              <small>{m.email}</small>
                            </div>
                            <select
                              aria-label={`${m.name}の役割`}
                              value={m.role}
                              onChange={(e) =>
                                update(
                                  (s) =>
                                    (s.members.find((x) => x.id === m.id).role =
                                      e.target.value),
                                )
                              }
                            >
                              {model.customerRoles.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                    </div>
                    <Note>
                      営業担当者は自分の顧客への送信が可能。管理者の承認権限と直接送信権限は分かれます。システム管理者には会話閲覧権限を自動付与しません。
                    </Note>
                    <label className="pt-checkbox">
                      <input
                        type="checkbox"
                        checked={o.membersConfirmed}
                        onChange={(e) =>
                          patch({ membersConfirmed: e.target.checked })
                        }
                      />
                      担当者と役割を確認しました
                    </label>
                  </Section>
                  <div className="pt-role-grid">
                    {model.customerRoles.map((r) => (
                      <div key={r.id}>
                        <I
                          name={
                            r.id === "billing"
                              ? "Wallet"
                              : r.id === "sys_admin"
                                ? "Settings"
                                : "UserRound"
                          }
                        />
                        <h3>{r.label}</h3>
                        <p>{r.scope}</p>
                        <small>直接送信：{r.send}</small>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {o.step === 3 && (
                <>
                  <ProductPicker {...ctx} />
                  <Section
                    title="公式LINEを持つ単位"
                    sub="担当者専用の公式LINEも、企業所有で管理します。"
                  >
                    <div className="pt-choice-grid">
                      {model.ownershipUnits.map((u) => (
                        <button
                          key={u.id}
                          className={`pt-choice ${o.unit === u.id ? "selected" : ""}`}
                          onClick={() => patch({ unit: u.id })}
                        >
                          <div>
                            <I
                              name={
                                u.id === "sales"
                                  ? "UserRound"
                                  : u.id === "team"
                                    ? "Users"
                                    : u.id === "company"
                                      ? "Building2"
                                      : "Layers"
                              }
                            />
                            {u.recommended && (
                              <Tag tone="lavender">主要パターン</Tag>
                            )}
                          </div>
                          <strong>{u.label}</strong>
                          <p>{u.description}</p>
                          {o.unit === u.id && (
                            <I
                              name="CheckCircle2"
                              className="pt-choice-check"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  </Section>
                  <AccountsPanel {...ctx} tenantId={tenantId} />
                </>
              )}
              {o.step === 4 && (
                <>
                  <AccountsPanel {...ctx} tenantId={tenantId} compact />
                  <Section
                    title="外部サービス"
                    sub="接続テストでは本番メッセージを送りません。"
                  >
                    <div className="pt-connect-list">
                      {[
                        ["LINE Harness", "公式LINEごとの受信・送信・履歴"],
                        ["Google Sheets", "企業共通の商品・営業素材"],
                        ["Google Drive", "共有する議事録フォルダ"],
                        ["Google Calendar", "担当者ごとの空き時間"],
                        ["TimeRex", "公式LINE・担当者ごとの予約導線"],
                      ].map(([n, d]) => (
                        <div key={n}>
                          <Tile
                            name={
                              n.includes("Calendar")
                                ? "CalendarDays"
                                : n.includes("Drive")
                                  ? "FileText"
                                  : "Link2"
                            }
                            tone="blue"
                          />
                          <div>
                            <strong>{n}</strong>
                            <small>{d}</small>
                          </div>
                          <Tag
                            tone={
                              scenario === "connection_failed"
                                ? "rose"
                                : o.connections
                                  ? "sage"
                                  : "stone"
                            }
                          >
                            {scenario === "connection_failed"
                              ? "接続失敗"
                              : o.connections
                                ? "確認済み（模擬）"
                                : "未確認"}
                          </Tag>
                        </div>
                      ))}
                    </div>
                    {scenario === "connection_failed" && (
                      <Note tone="rose" icon="AlertCircle">
                        接続の有効期限が切れています。範囲を確認して再接続してください。
                      </Note>
                    )}
                    <B
                      icon="RefreshCw"
                      onClick={() => {
                        patch({ connections: true });
                        setScenario("normal");
                        notify("外部サービスの接続確認を再現しました");
                      }}
                    >
                      {o.connections
                        ? "接続を再確認（デモ）"
                        : "接続を確認する（デモ）"}
                    </B>
                    <button
                      className="pt-text-link"
                      onClick={() => setScenario("connection_failed")}
                    >
                      接続失敗の状態を見る
                    </button>
                  </Section>
                </>
              )}
              {o.step === 5 && (
                <Section
                  title="取り込む情報を確認"
                  sub={`${o.companyName} / 企業共通設定`}
                >
                  <div className="pt-preview-metrics">
                    <div>
                      <strong>128</strong>
                      <span>顧客の照合候補</span>
                    </div>
                    <div>
                      <strong>24</strong>
                      <span>公開中の素材</span>
                    </div>
                    <div>
                      <strong>3</strong>
                      <span>確認が必要</span>
                    </div>
                  </div>
                  <div className="pt-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>情報源</th>
                          <th>取込み先・範囲</th>
                          <th>状態</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>Google Sheets / 物件一覧</td>
                          <td>企業共通テンプレート → 対象公式LINE</td>
                          <td>
                            <Tag tone="sage">24件を利用可能</Tag>
                          </td>
                        </tr>
                        <tr>
                          <td>Google Drive / 商談メモ</td>
                          <td>対象顧客のOA別TSUNAGU DB</td>
                          <td>
                            <Tag tone="amber">3件の顧客照合待ち</Tag>
                          </td>
                        </tr>
                        <tr>
                          <td>LINE Harness / 友だち</td>
                          <td>企業内共通顧客IDとの対応</td>
                          <td>
                            <Tag tone="blue">128件をプレビュー</Tag>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <Note tone="amber" icon="Eye">
                    一致に確信のない顧客は自動統合しません。確認待ちの3件は対象から除外し、残りの内容を確認します。
                  </Note>
                  <label className="pt-checkbox spacious">
                    <input
                      type="checkbox"
                      checked={o.preview}
                      onChange={(e) => patch({ preview: e.target.checked })}
                    />
                    取込み先と対象範囲を確認しました（デモ）
                  </label>
                </Section>
              )}
              {o.step === 6 && (
                <>
                  <Section
                    title="企業共通の設定"
                    sub="共通・業界・企業の質問セットを一括適用します。"
                  >
                    <div className="pt-common-settings">
                      {[
                        ["materials", "営業素材"],
                        ["rules", "承認・送信ルール"],
                        ["questions", "共通・業界・企業の質問"],
                      ].map(([k, l]) => (
                        <label key={k} className="pt-checkbox">
                          <input
                            type="checkbox"
                            checked={state.shared[k]}
                            onChange={(e) =>
                              update((s) => (s.shared[k] = e.target.checked))
                            }
                          />
                          {l}
                        </label>
                      ))}
                    </div>
                    <B
                      variant="secondary"
                      icon="CheckCheck"
                      onClick={() => {
                        update((s) =>
                          s.accounts
                            .filter((a) => a.tenantId === tenantId)
                            .forEach((a) => (a.sharedApplied = true)),
                        );
                        notify(
                          "企業共通設定を適用しました。個別の文体・カレンダー設定は保持しています。",
                        );
                      }}
                    >
                      すべての公式LINEに共通設定を適用
                    </B>
                  </Section>
                  <Section
                    title="担当者の言葉で、答えてみましょう"
                    sub={`${o.companyName} / 担当者のQ&A方式・サンプル3問`}
                  >
                    <div className="pt-answer-progress">
                      <Tag tone="lavender">
                        {o.answers.filter((x) => x.trim().length >= 10).length}{" "}
                        / 3 回答
                      </Tag>
                      <span>すべての回答と本人確認で有効化</span>
                    </div>
                    {[
                      "【共通】初めての問い合わせに、ご挨拶するなら？",
                      "【不動産】予算に不安がある方へ、資金計画の面談を提案するなら？",
                      "【企業】検討を急がせず、来週のご連絡を約束するなら？",
                    ].map((q, i) => (
                      <Field key={q} label={q}>
                        <textarea
                          rows={3}
                          value={o.answers[i]}
                          placeholder="普段使っている、具体的な文章で回答してください。"
                          onChange={(e) =>
                            update((s) => {
                              s.onboarding.answers[i] = e.target.value;
                              s.onboarding.calibration = false;
                              s.onboarding.profileConfirmed = false;
                            })
                          }
                        />
                      </Field>
                    ))}
                    <div className="pt-profile-preview">
                      <Tile name="Sparkles" />
                      <div>
                        <h3>文体プロファイルの確認用サンプル</h3>
                        <p>丁寧な敬語 / 短めの段落 / 控えめな提案</p>
                        <small>
                          実際のAI解析は行っていません。実運用の設問数・判定基準は別途検証します。
                        </small>
                      </div>
                    </div>
                    <label className="pt-checkbox spacious">
                      <input
                        type="checkbox"
                        checked={o.profileConfirmed}
                        disabled={o.answers.some((x) => x.trim().length < 10)}
                        onChange={(e) =>
                          patch({ profileConfirmed: e.target.checked })
                        }
                      />
                      本人として回答・プロファイルを確認しました
                    </label>
                    <B
                      disabled={
                        o.answers.some((x) => x.trim().length < 10) ||
                        !o.profileConfirmed
                      }
                      onClick={() => {
                        patch({ calibration: true });
                        update((s) => {
                          const a =
                            s.accounts.find(
                              (x) =>
                                x.tenantId === tenantId &&
                                x.status === "calibration",
                            ) ||
                            s.accounts.find((x) => x.tenantId === tenantId);
                          if (a) a.style = true;
                        });
                        notify(
                          "担当者のキャリブレーションを完了した状態にしました",
                        );
                      }}
                    >
                      {o.calibration
                        ? "確認済み（デモ）"
                        : "担当者スタイルを有効化（デモ）"}
                    </B>
                    <button
                      className="pt-text-link"
                      onClick={() =>
                        patch({
                          answers: [
                            "お問い合わせありがとうございます。担当の渡辺です。ご希望を伺えれば幸いです。",
                            "毎月のご返済が無理のない範囲になるよう、一緒に資金計画を整理できればと思います。",
                            "お急ぎではありませんので、来週のご都合のよい頃に改めてご連絡いたします。",
                          ],
                          profileConfirmed: false,
                          calibration: false,
                        })
                      }
                    >
                      回答例を入力して試す
                    </button>
                  </Section>
                  <Note>
                    既存LINE履歴のTXTから作る方式も選択可能です。営業体験の「あなたの文体」で読み取りデモを確認できます。TXT方式では顧客を作成・照合せず、十分なプロファイルができた場合はQ&Aの重複回答を求めません。
                  </Note>
                </>
              )}
              {o.step === 7 && (
                <>
                  <div className="pt-launch-hero">
                    <Tile name="Rocket" tone="sage" size={32} />
                    <h2>もうすぐ、次のつながりへ。</h2>
                    <p>
                      開通済み <strong>{ready}</strong> / {accounts.length}{" "}
                      公式LINE
                    </p>
                    <span>
                      未完了の公式LINEは保留し、準備が整った単位で進められます。
                    </span>
                  </div>
                  <Section title="開通前の最終確認">
                    <div className="pt-checklist">
                      {[
                        ["招待の受諾", o.accepted],
                        [
                          "企業情報と担当者",
                          o.companyConfirmed && o.membersConfirmed,
                        ],
                        ["外部サービスの接続範囲", o.connections],
                        ["取込みプレビュー", o.preview],
                        ["担当者のキャリブレーション", o.calibration],
                      ].map(([t, v]) => (
                        <div key={t}>
                          <span className={v ? "done" : "pending"}>
                            <I name={v ? "Check" : "Clock"} size={16} />
                          </span>
                          <strong>{t}</strong>
                          <Tag tone={v ? "sage" : "amber"}>
                            {v ? "確認済み" : "確認待ち"}
                          </Tag>
                        </div>
                      ))}
                    </div>
                    <Note>
                      既存Webhookを使用している公式LINEは、接続方式の確認が終わるまで開通しません。
                    </Note>
                    <B
                      icon="Rocket"
                      disabled={
                        !o.accepted ||
                        !o.companyConfirmed ||
                        !o.membersConfirmed ||
                        !o.connections ||
                        !o.preview ||
                        !o.calibration
                      }
                      onClick={() => {
                        update((s) => {
                          s.accounts
                            .filter(
                              (a) =>
                                a.tenantId === tenantId &&
                                a.status === "calibration" &&
                                a.style &&
                                !a.webhookConflict,
                            )
                            .forEach((a) => {
                              a.status = "ready";
                              a.calendar = true;
                              a.booking = true;
                            });
                          s.onboarding.done = [
                            ...new Set([...s.onboarding.done, "launch"]),
                          ];
                        });
                        notify(
                          "条件を満たした公式LINEを開通済みにしました（模擬動作）",
                        );
                      }}
                    >
                      準備が整った公式LINEを開通（デモ）
                    </B>
                  </Section>
                  <B
                    variant="secondary"
                    icon="ArrowRight"
                    onClick={() => go(tenantId === "next" ? "/sales" : "/")}
                  >
                    {tenantId === "next"
                      ? "営業ワークスペースを確認"
                      : "レビュー入口へ"}
                  </B>
                </>
              )}
              {o.step < 7 && (
                <div className="pt-wizard-footer">
                  <B
                    variant="ghost"
                    icon="ArrowLeft"
                    disabled={o.step === 0}
                    onClick={() => patch({ step: o.step - 1 })}
                  >
                    戻る
                  </B>
                  <span>入力内容はこのブラウザーに保存</span>
                  <B
                    icon="ArrowRight"
                    disabled={!valid || scenario === "invite_expired"}
                    onClick={next}
                  >
                    保存して次へ
                  </B>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <Modal open={member} title="担当者を追加" onClose={() => setMember(null)}>
        {member && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              update((s) =>
                s.members.push({ ...member, tenantId, id: "u-" + Date.now() }),
              );
              setMember(null);
              notify("担当者を追加しました。招待メールは送信されません。");
            }}
          >
            <Field label="氏名">
              <input
                required
                value={member.name}
                onChange={(e) => setMember({ ...member, name: e.target.value })}
              />
            </Field>
            <Field label="メールアドレス">
              <input
                type="email"
                required
                value={member.email}
                onChange={(e) =>
                  setMember({ ...member, email: e.target.value })
                }
              />
            </Field>
            <Field label="役割">
              <select
                value={member.role}
                onChange={(e) => setMember({ ...member, role: e.target.value })}
              >
                {model.customerRoles.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <B type="submit">担当者を追加（デモ）</B>
          </form>
        )}
      </Modal>
    </div>
  );
}
export function MethodPicker({ state, model, update, notify, companyId, tenantId = 'next' }) {
  const c = companyId ? state.companies.find((x) => x.id === companyId) : null;
  const current = c?.method || state.onboarding.method;
  return (
    <Section
      title="導入のお手伝い方法"
      sub="受注時に当社営業が設定。途中で変更しても、入力内容と進捗を引き継ぎます。"
    >
      <div className="pt-method-grid">
        {model.onboardingMethods.map((m) => (
          <button
            key={m.id}
            className={`pt-choice ${current === m.id ? "selected" : ""}`}
            onClick={() => {
              update((s) => {
                const targetId = companyId || tenantId;
                const company = s.companies.find((x) => x.id === targetId);
                if (company) company.method = m.id;
                if (!companyId || targetId === 'next') s.onboarding.method = m.id;
                else if (s.onboardingByTenant?.[targetId]) s.onboardingByTenant[targetId].method = m.id;
              });
              notify("導入方法を変更しました。進捗は引き継がれています。");
            }}
          >
            <I name={m.icon} />
            <strong>{m.label}</strong>
            <p>{m.description}</p>
            {current === m.id && (
              <I name="CheckCircle2" className="pt-choice-check" />
            )}
          </button>
        ))}
      </div>
      {current === "delegated" && (
        <Note tone="amber" icon="Clock">
          代行には対象・期限を限定した一時管理権限を使います。お客様のログインID・パスワードはお預かりしません。
        </Note>
      )}
    </Section>
  );
}
function ProductPicker({ state, update }) {
  return (
    <div className="pt-product-grid">
      {[
        [
          "existing",
          "今の公式LINEに追加",
          "既存の運用を活かし、TSUNAGUをつなぐ。",
          "Link2",
        ],
        [
          "harness",
          "Harness込みで構築",
          "公式LINEの設計から配信・カード・シナリオまで。",
          "Package",
        ],
      ].map(([id, label, d, icon]) => (
        <button
          key={id}
          className={`pt-product ${state.onboarding.product === id ? "selected" : ""}`}
          onClick={() => update((s) => (s.onboarding.product = id))}
        >
          <Tile name={icon} tone={id === "existing" ? "blue" : "peach"} />
          <h3>{label}</h3>
          <p>{d}</p>
          <span>
            {id === "existing"
              ? "既存Webhookは事前に接続方式を確認"
              : "お客様と当社で構築内容を確認"}
          </span>
          {state.onboarding.product === id && <I name="CheckCircle2" />}
        </button>
      ))}
    </div>
  );
}
export function AccountsPanel(ctx) {
  const {
    state,
    model,
    update,
    notify,
    audit,
    tenantId = "next",
    compact = false,
    readOnly = false,
  } = ctx;
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [edit, setEdit] = useState(null),
    [selected, setSelected] = useState([]),
    [add, setAdd] = useState(false),
    [form, setForm] = useState({
      name: "",
      primary: "佐藤 健一",
      unit: state.onboarding.unit,
      origin: "new",
    });
  const company = state.companies.find((c) => c.id === tenantId),
    rows = state.accounts.filter((a) => a.tenantId === tenantId),
    visible = rows.filter(
      (a) =>
        (filter === "all" ||
          (filter === "attention" && a.status !== "ready") ||
          a.status === filter) &&
        [a.name, a.primary, a.team].join("").includes(query),
    );
  const target = state.accounts.find((a) => a.id === edit);
  function change(v) {
    update((s) =>
      Object.assign(
        s.accounts.find((a) => a.id === edit),
        v,
      ),
    );
  }
  function progress(a) {
    if (a.webhookConflict) {
      notify("既存Webhookの受信先を確認してください。自動では切り替えません。");
      return;
    }
    const next = {
      uncreated: "api",
      api: "credentials",
      credentials: "webhook",
      webhook: "database",
      database: "calibration",
      action: "database",
    }[a.status];
    if (next) {
      update((s) => {
        const x = s.accounts.find((r) => r.id === a.id);
        x.status = next;
        if (a.status === "credentials") {
          x.credentialsStatus = "registered";
          x.credentialUpdatedAt = "2026-09-22 10:00";
        }
      });
      notify("次の接続状態へ進めました（模擬動作）");
    } else if (a.status === "calibration")
      notify("担当者の文体・カレンダー・予約導線を確認してください。");
  }
  return (
    <>
      <Section
        title="公式LINEの開通状況"
        sub={`${company?.name || state.onboarding.companyName} / ${rows.length}アカウント · 新規作成分は企業所有`}
        action={
          !readOnly && (
            <B variant="secondary" icon="Plus" onClick={() => setAdd(true)}>
              公式LINEを追加
            </B>
          )
        }
      >
        <div className="pt-account-toolbar">
          <Segments
            label="公式LINEの状態"
            value={filter}
            options={[
              { id: "all", label: `すべて ${rows.length}` },
              { id: "ready", label: "開通済み" },
              { id: "attention", label: "準備中・要対応" },
            ]}
            onChange={setFilter}
          />
          <label className="pt-search">
            <I name="Search" size={16} />
            <input
              aria-label="公式LINEを検索"
              value={query}
              placeholder="アカウント・主担当で検索"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {selected.length > 0 && !readOnly && (
          <div className="pt-bulk">
            <span>{selected.length}件を選択</span>
            <button
              onClick={() => {
                update((s) =>
                  s.accounts
                    .filter((a) => selected.includes(a.id))
                    .forEach((a) => (a.sharedApplied = true)),
                );
                notify(
                  "選択した公式LINEへ共通の素材・ルール・質問を適用しました",
                );
              }}
            >
              企業共通設定を一括適用
              <I name="CheckCheck" size={15} />
            </button>
          </div>
        )}
        <div className="pt-table-wrap">
          <table className="pt-oa-table">
            <thead>
              <tr>
                {!readOnly && (
                  <th>
                    <span className="sr-only">選択</span>
                  </th>
                )}
                <th>公式LINE / 保有単位</th>
                <th>主担当・操作可能者</th>
                <th>開通状況</th>
                <th>共通設定</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id}>
                  {!readOnly && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${a.name}を選択`}
                        checked={selected.includes(a.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, a.id]
                              : selected.filter((id) => id !== a.id),
                          )
                        }
                      />
                    </td>
                  )}
                  <td>
                    <div className="pt-oa-name">
                      <span className="pt-line-icon">
                        <I name="MessageCircle" size={18} />
                      </span>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {
                            model.ownershipUnits.find((x) => x.id === a.unit)
                              ?.label
                          }{" "}
                          · {a.origin === "new" ? "新規 / 企業所有" : "既存"}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong>{a.primary}</strong>
                    <small>{a.operators.join("・")}</small>
                  </td>
                  <td>
                    <Status model={model} type="oa" id={a.status} />
                  </td>
                  <td>
                    {a.sharedApplied ? (
                      <Tag tone="sage">適用済み</Tag>
                    ) : (
                      <Tag tone="stone">未適用</Tag>
                    )}
                  </td>
                  <td>
                    <button
                      className="pt-row-open"
                      aria-label={`${a.name}の設定`}
                      onClick={() => setEdit(a.id)}
                    >
                      <I name="ChevronRight" size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <Empty
            icon="Search"
            title="該当する公式LINEがありません"
            description="条件を変えるか、公式LINEを追加してください。"
          />
        )}
        {!compact && (
          <p className="pt-table-foot">
            <I name="ShieldCheck" size={14} />
            共通設定の一括適用で、個別の文体・カレンダー・予約導線は上書きしません。
          </p>
        )}
      </Section>
      <Modal
        open={target}
        title="公式LINEの設定"
        onClose={() => setEdit(null)}
        wide
      >
        {target && (
          <>
            <div className="pt-account-detail-heading">
              <span className="pt-line-icon large">
                <I name="MessageCircle" size={30} />
              </span>
              <div>
                <h2>{target.name}</h2>
                <p>
                  {company?.name} / 企業所有
                  {target.origin === "new" ? " · 新規作成" : ""}
                </p>
              </div>
              <Status model={model} type="oa" id={target.status} />
            </div>
            <div className="pt-form-grid">
              <Field label="主担当">
                <input
                  readOnly={readOnly}
                  value={target.primary}
                  onChange={(e) => change({ primary: e.target.value })}
                />
              </Field>
              <Field label="チーム・店舗">
                <input
                  readOnly={readOnly}
                  value={target.team}
                  onChange={(e) => change({ team: e.target.value })}
                />
              </Field>
            </div>
            <Field label="操作可能な担当者（読点で区切る）">
              <input
                readOnly={readOnly}
                value={target.operators.join("、")}
                onChange={(e) =>
                  change({ operators: e.target.value.split("、") })
                }
              />
            </Field>
            <div className="pt-key-values">
              <div>
                <span>資格情報</span>
                <strong>
                  {target.credentialsStatus === "registered"
                    ? "登録済み · 値の再表示なし"
                    : "登録待ち"}
                </strong>
              </div>
              <div>
                <span>管理する内容</span>
                <strong>登録者・登録日時・状態のみ</strong>
              </div>
            </div>
            {target.webhookConflict && (
              <Note tone="amber" icon="AlertCircle">
                <strong>既存のWebhookを確認しています</strong>
                <p>
                  他のツールが受信しています。既存Harness・正式連携・中継可否を確認するまで、接続先を上書きしません。
                </p>
                {!readOnly && (
                  <B
                    variant="secondary"
                    onClick={() => {
                      change({ webhookConflict: false, status: "database" });
                      notify(
                        "既存ツールとの連携条件を確認した状態にしました。技術検証は未実施です。",
                      );
                    }}
                  >
                    事前確認済みの状態を再現
                  </B>
                )}
              </Note>
            )}
            {!readOnly && target.credentialsStatus !== "registered" && (
              <section className="pt-secure-registration">
                <h3>資格情報を安全に登録</h3>
                <p>秘密値は再表示せず、登録者・日時・状態だけを管理します。</p>
                <div className="pt-form-grid">
                  <Field label="Channel Secret">
                    <input
                      type="password"
                      readOnly
                      placeholder="モックでは実値を入力しません"
                    />
                  </Field>
                  <Field label="Channel Access Token">
                    <input
                      type="password"
                      readOnly
                      placeholder="モックでは実値を入力しません"
                    />
                  </Field>
                </div>
                <B
                  variant="secondary"
                  icon="LockKeyhole"
                  onClick={() => {
                    change({
                      credentialsStatus: "registered",
                      credentialUpdatedAt: "2026-09-22 10:00",
                      credentialRegisteredBy: "顧客システム管理者",
                      status: "webhook",
                    });
                    notify(
                      "安全な資格情報登録の完了状態を再現しました。秘密値は保存していません。",
                    );
                  }}
                >
                  登録完了を再現（デモ）
                </B>
              </section>
            )}
            <h3 className="pt-subtitle">担当者ごとの設定</h3>
            <div className="pt-personal-options">
              {[
                ["style", "文体プロファイル"],
                ["calendar", "個人のカレンダー"],
                ["booking", "予約導線"],
              ].map(([k, l]) => (
                <label className="pt-checkbox" key={k}>
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={target[k]}
                    onChange={(e) => change({ [k]: e.target.checked })}
                  />
                  {l}
                </label>
              ))}
            </div>
            <Note tone="blue" icon="Database">
              企業共通顧客DBを参照し、この公式LINE用のHarness DBとTSUNAGU
              DBを持ちます。営業担当者用の追加DBは作りません。
            </Note>
            {!readOnly && (
              <>
                <div className="pt-modal-actions">
                  <B
                    variant="secondary"
                    icon="RefreshCw"
                    disabled={
                      target.status === "ready" || target.webhookConflict
                    }
                    onClick={() => progress(target)}
                  >
                    接続・発行を進める（デモ）
                  </B>
                  <B
                    disabled={
                      target.status !== "calibration" ||
                      target.webhookConflict ||
                      !target.style ||
                      !target.calendar ||
                      !target.booking
                    }
                    onClick={() => {
                      change({ status: "ready" });
                      audit?.("公式LINEの開通を再現", target.name);
                      notify("この公式LINEを開通済みにしました（デモ）");
                    }}
                  >
                    この公式LINEを開通
                  </B>
                </div>
                <details className="pt-demo-options">
                  <summary>
                    各開通状態をレビュー
                    <I name="SlidersHorizontal" size={14} />
                  </summary>
                  <Field label="公式LINEの表示状態">
                    <select
                      value={target.status}
                      onChange={(e) =>
                        change({
                          status: e.target.value,
                          webhookConflict: e.target.value === "webhook",
                        })
                      }
                    >
                      {model.oaStatuses.map((s) => (
                        <option value={s.id} key={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <B
                    variant="secondary"
                    icon="KeyRound"
                    onClick={() => {
                      change({
                        credentialsStatus: "registered",
                        credentialUpdatedAt: "2026-09-22 10:00",
                      });
                      notify(
                        "資格情報の登録済み状態を再現しました。秘密情報は入力・保存しません。",
                      );
                    }}
                  >
                    資格情報の登録を再現
                  </B>
                  <B
                    variant="ghost"
                    onClick={() =>
                      change({
                        credentialsStatus: "revoked",
                        status: "credentials",
                      })
                    }
                  >
                    資格情報を失効（デモ）
                  </B>
                </details>
              </>
            )}
          </>
        )}
      </Modal>
      <Modal open={add} title="公式LINEを追加" onClose={() => setAdd(false)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update((s) =>
              s.accounts.push({
                id: "oa-" + Date.now(),
                tenantId,
                name: form.name,
                primary: form.primary,
                operators: [form.primary],
                team: "未割当",
                unit: form.unit,
                origin: form.origin,
                owner: company?.name || s.onboarding.companyName,
                status: form.origin === "new" ? "uncreated" : "credentials",
                webhookConflict: false,
                sharedApplied: false,
                style: false,
                calendar: false,
                booking: false,
                credentialsStatus: "waiting",
              }),
            );
            setAdd(false);
            setForm({ ...form, name: "" });
            notify(
              "公式LINEの開通枠を追加しました。実アカウントは作成されません。",
            );
          }}
        >
          <Field label="公式LINEの名前">
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="主担当">
            <input
              required
              value={form.primary}
              onChange={(e) => setForm({ ...form, primary: e.target.value })}
            />
          </Field>
          <div className="pt-form-grid">
            <Field label="保有単位">
              <select
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
              >
                {model.ownershipUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="既存 / 新規">
              <select
                value={form.origin}
                onChange={(e) => setForm({ ...form, origin: e.target.value })}
              >
                <option value="new">新しく作成</option>
                <option value="existing">既存の公式LINE</option>
              </select>
            </Field>
          </div>
          <Note>
            新規の公式LINE・Provider・Messaging API
            Channelは、担当者専用でも企業所有として登録します。
          </Note>
          <B type="submit" icon="Plus">
            開通枠を追加（デモ）
          </B>
        </form>
      </Modal>
    </>
  );
}
