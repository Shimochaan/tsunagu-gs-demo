import React, { useState, useEffect } from "react";
import { B, Field, Title, Section, Note, Tag, Modal } from "../platform/ui.jsx";
import { api, useData, date, label } from "./api.js";
import { Form, Action, State, Status, Blank } from "./shared.jsx";
import { Units, Methods, AccountFields, Jobs } from "./Ops.jsx";
import { HarnessConnection } from "./HarnessConnection.jsx";
import { SetupOverview, ReadinessChecks } from "./SetupOverview.jsx";
const steps = [
  "企業情報",
  "担当者・役割",
  "公式LINE",
  "接続",
  "取込み確認",
  "あなたらしい言葉",
  "開通確認",
];
const STYLE_PRESETS = [
  {
    id: "polite",
    title: "丁寧・伴走型",
    tag: "信頼・標準",
    desc: "誠実で安心感のある標準ビジネス敬語。お客様に寄り添う丁寧な言葉遣いです。",
    samples: {
      "common.first":
        "はじめまして、TSUNAGU担当の○○と申します。この度はお問い合わせいただき誠にありがとうございます！お客様の営業活動がよりスムーズになるよう、心を込めてサポートさせていただきます。何かご不明な点がございましたら、いつでもお気軽にお申し付けください。",
      "common.needs":
        "ご興味をお持ちいただきありがとうございます！まだ具体的なご検討段階でなくても全く問題ございません。まずは現状の課題やお困りごとを少し伺った上で、何かお役に立てる情報をお届けできればと考えております。差し支えなければ、現在気になっている点などをお聞かせいただけますでしょうか？",
      "common.booking":
        "お時間をいただきありがとうございます！ぜひ一度詳しいお話をお聞かせください。以下にオンライン面談の予約カレンダーをご用意いたしました。ご都合の良い日時をこちらから直接お選びいただけますと幸いです。\nhttps://example.com/booking",
      "common.wait":
        "ご家族へのご相談、とても大切ですね。じっくりお話し合っていただければと思います！決して急ぐ必要はございませんので、ご納得いただけるまでご検討ください。ご家族の方から何かご質問などがございましたら、いつでもお気軽にご相談くださいね。",
      "common.change":
        "日程変更のご連絡ありがとうございます。ご都合が悪くなってしまったとのこと、承知いたしました！改めてご都合のよろしい候補日時を2〜3つほど教えていただけますでしょうか？そちらに合わせて調整させていただきます。",
      "industry.case":
        "ツールの導入にあたって『現場のメンバーが使いこなせるか不安』というお声をよくいただきます。弊社では初期設定から操作定着まで専任担当が伴走し、マニュアル不要で使えるシンプルな運用設計をご支援しておりますので、どうぞご安心ください。",
      "company.case":
        "ご検討に役立つ情報として、同業他社様での導入事例インタビューを公開しております。実際の業務でどのように活用され成果が出たのか、ぜひご参考までにご覧いただけますと幸いです。\nhttps://example.com/case-study",
    },
  },
  {
    id: "friendly",
    title: "親しみ・フランク型",
    tag: "親近感・高返信率",
    desc: "心理的ハードルを下げる明るく親身なトーン。適度な感嘆符や絵文字で距離を縮めます。",
    samples: {
      "common.first":
        "はじめまして！TSUNAGU担当の○○です😊 この度はお問い合わせいただき、本当にありがとうございます！LINEでお気軽にご相談いただけるよう準備していますので、どうぞよろしくお願いいたします✨",
      "common.needs":
        "興味を持っていただけて嬉しいです！✨ まだ具体的になっていなくても全然大丈夫ですよ👍 『ちょっと情報収集したい』『他社はどうしてる？』といった軽いご質問でも大歓迎ですので、気になることがあれば何でも聞いてくださいね！",
      "common.booking":
        "お話を聞いてみたいと言っていただけて嬉しいです！😆 こちらの予約リンクから、空いているお好きな日時をポチッと選んでいただけます👇 ご都合の良いお時間でお待ちしております！\nhttps://example.com/booking",
      "common.wait":
        "ご家族とじっくりご相談されるの大切ですよね！😊 無理に急ぐ必要はまったくありませんので、ゆっくりお話し合ってみてください。もしご家族から疑問点など出ましたら、いつでもLINEでご連絡くださいね👍",
      "common.change":
        "日程変更のご連絡ありがとうございます！急なご予定ももちろんありますよね、お気になさらないでください😊 来週以降でご都合の良い日時をいくつか教えていただけますか？すぐに再調整いたします！",
      "industry.case":
        "『LINEの返信って忙しくて手が回らない…』というお悩み、本当に多くいただきます💦 TSUNAGUは商談メモや普段の言葉からAIが自然な提案を作ってくれるので、スキマ時間にポチッと承認するだけで追客が続けられますよ✨",
      "company.case":
        "実際にTSUNAGUを使っていただいているお客様のインタビュー記事が届きました！『営業の負担が半分になった』というリアルな声が載っていますので、ぜひスキマ時間に覗いてみてくださいね👀\nhttps://example.com/case-study",
    },
  },
  {
    id: "logical",
    title: "論理・プロフェッショナル型",
    tag: "要点明快・BtoB",
    desc: "要点を端的に。数字や実績を交え、多忙な経営者・決裁者に響く明快なトーンです。",
    samples: {
      "common.first":
        "この度はお問い合わせいただきありがとうございます。TSUNAGU担当の○○です。貴社の営業生産性向上と顧客フォローの自動化に向けて、最適な活用方法をご提案いたします。よろしくお願い申し上げます。",
      "common.needs":
        "ご関心をお寄せいただき恐縮です。現状の検討度合いに関わらず、同業他社様における費用対効果や導入手順のデータをお渡し可能です。まずは現在の課題感について一言いただけますと、より精度の高い情報を提供できます。",
      "common.booking":
        "ご検討いただきありがとうございます。15〜30分程度で貴社に合わせたデモと活用イメージをご紹介いたします。以下のURLより、貴社のご都合に合わせた日程をご選択ください。\nhttps://example.com/booking",
      "common.wait":
        "承知いたしました。重要なお取り組みですので、ご家族・社内で十分にご検討いただくのが最善かと存じます。判断材料として追加で必要な資料や比較データがございましたら、いつでもお申し付けください。",
      "common.change":
        "日程調整のご連絡ありがとうございます。ご多忙の折、恐縮でございます。恐れ入りますが、候補となる日程（曜日や時間帯）を2〜3候補ご教示いただけますと幸いです。速やかに再調整いたします。",
      "industry.case":
        "商談後のフォロー率が低下する主な要因は『個別メッセージ作成にかかる時間的コスト（平均15分/件）』にあります。弊社のAIサジェストにより作成時間を1分未満に圧縮し、案件化率を平均28%向上させた実績がございます。",
      "company.case":
        "貴社の検討材料として、弊社サービスの詳細仕様書とROI（費用対効果）シミュレーションシートをご用意しております。下記リンクよりご確認いただけますので、ぜひご活用ください。\nhttps://example.com/case-study",
    },
  },
];

const SCENARIO_META = {
  "common.first": {
    label: "初回お礼",
    incoming:
      "ホームページを見てLINEを追加しました。資料などありますでしょうか？",
    time: "10:14",
  },
  "common.needs": {
    label: "興味喚起",
    incoming:
      "サービスには少し興味があるのですが、まだ具体的に導入するか決めていません。",
    time: "14:20",
  },
  "common.booking": {
    label: "予約案内",
    incoming: "詳しくお話を聞いてみたいです。オンラインで相談可能ですか？",
    time: "11:05",
  },
  "common.wait": {
    label: "相談フォロー",
    incoming:
      "ご提案ありがとうございます。一度家族（社内）と相談してから考えます。",
    time: "16:42",
  },
  "common.change": {
    label: "日程変更",
    incoming:
      "すみません、明日の面談ですが急な予定が入ってしまい変更できますでしょうか？",
    time: "09:30",
  },
  "industry.case": {
    label: "業界の迷い",
    incoming: "導入しても現場のメンバーが使いこなせるかどうかが一番不安です…",
    time: "13:15",
  },
  "company.case": {
    label: "事例・実績",
    incoming: "実際に使われている他社さんの活用事例や実績って見られますか？",
    time: "15:50",
  },
};

function LinePreview({ activeQuestionId, answers, onSelectScenario }) {
  const currentScenario =
    SCENARIO_META[activeQuestionId] || SCENARIO_META["common.first"];
  const currentReply = (answers[activeQuestionId] || "").trim();

  return (
    <div className="pt-line-panel">
      <div className="pt-line-panel-top">
        <div className="pt-line-panel-top-left">
          <div className="pt-line-dot" />
          <div>
            <div className="pt-line-panel-title">LINE トークプレビュー</div>
            <div className="pt-line-panel-sub">お客様画面での表示イメージ</div>
          </div>
        </div>
        <Tag tone="stone">Live</Tag>
      </div>

      <div className="pt-line-scenario-bar">
        {Object.entries(SCENARIO_META).map(([qid, meta]) => (
          <button
            key={qid}
            type="button"
            className={`pt-line-tab-btn ${activeQuestionId === qid ? "active" : ""}`}
            onClick={() => onSelectScenario(qid)}
          >
            {meta.label}
          </button>
        ))}
      </div>

      <div className="pt-line-chat-canvas">
        {/* Customer Incoming Bubble */}
        <div className="pt-line-row other">
          <div className="pt-line-avatar-user">客</div>
          <div className="pt-line-bubble-group">
            <div className="pt-line-speech-bubble other">
              {currentScenario.incoming}
            </div>
            <div className="pt-line-bubble-meta">
              <span>{currentScenario.time}</span>
            </div>
          </div>
        </div>

        {/* My AI / Sales Reply Bubble */}
        <div className="pt-line-row me">
          <div className="pt-line-bubble-group">
            <div
              className={`pt-line-speech-bubble me ${!currentReply ? "empty" : ""}`}
            >
              {currentReply ||
                "（左側の設問に入力した返信がリアルタイムに反映されます）"}
            </div>
            {currentReply && (
              <div className="pt-line-bubble-meta">
                <span className="read">既読</span>
                <span>10:25</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="pt-line-footer">
        入力内容に応じて吹き出しがリアルタイムに更新されます
      </div>
    </div>
  );
}

function Style({ base }) {
  const [selectedUserId, setSelectedUserId] = useState(null);
  const endpoint = selectedUserId
    ? `${base}/style?userId=${selectedUserId}`
    : `${base}/style`;
  const { data, error, refresh } = useData(endpoint);
  const [answers, setAnswers] = useState({});
  const [selectedPreset, setSelectedPreset] = useState("polite");
  const [activeQuestionId, setActiveQuestionId] = useState("common.first");
  const [savingId, setSavingId] = useState(null);
  const [savedIds, setSavedIds] = useState({});
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [prioritySettingId, setPrioritySettingId] = useState(null);
  const [prioritySuccessNote, setPrioritySuccessNote] = useState("");
  const [showLearningDetails, setShowLearningDetails] = useState(false);

  useEffect(() => {
    if (data?.profile?.answers) {
      setAnswers(data.profile.answers);
      const initial = {};
      for (const k of Object.keys(data.profile.answers)) {
        if (data.profile.answers[k]) initial[k] = true;
      }
      setSavedIds(initial);
      setConfirmed(data.profile.state === "active");
    } else {
      setAnswers({});
      setSavedIds({});
      setConfirmed(false);
    }
  }, [data]);

  if (!data) return <State error={error} />;

  const currentViewingUserId =
    selectedUserId || data.profile?.user_id || data.primaryUserId;
  const currentViewingUser =
    data.operators?.find((o) => o.id === currentViewingUserId) ||
    data.operators?.find((o) => o.id === data.primaryUserId) ||
    data.operators?.[0];

  const currentPresetObj =
    STYLE_PRESETS.find((p) => p.id === selectedPreset) || STYLE_PRESETS[0];

  const handleBlur = async (qid, val) => {
    const trimmed = (val ?? "").trim();
    if (!trimmed) return;
    setSavingId(qid);
    try {
      const updated = { ...answers, [qid]: val };
      setAnswers(updated);
      await api(`${base}/style`, {
        userId: currentViewingUserId,
        answers: updated,
        confirm: false,
      });
      setSavedIds((prev) => ({ ...prev, [qid]: true }));
    } catch (e) {
      console.error("Auto-save failed:", e);
    } finally {
      setSavingId(null);
    }
  };

  const handleApplyAllPresetSamples = async (presetId) => {
    const p =
      STYLE_PRESETS.find((item) => item.id === presetId) || currentPresetObj;
    setSelectedPreset(p.id);
    const newAnswers = { ...answers, ...p.samples };
    setAnswers(newAnswers);
    try {
      await api(`${base}/style`, {
        userId: currentViewingUserId,
        answers: newAnswers,
        confirm: false,
      });
      const marked = {};
      data.questions.forEach((q) => (marked[q.id] = true));
      setSavedIds(marked);
    } catch (e) {
      console.error("Failed to auto-save preset answers:", e);
    }
  };

  const handleInsertSingleSample = async (qid) => {
    const sample = currentPresetObj.samples[qid];
    if (!sample) return;
    const updated = { ...answers, [qid]: sample };
    setAnswers(updated);
    setActiveQuestionId(qid);
    await handleBlur(qid, sample);
  };

  const handleConfirmAll = async () => {
    setConfirmError("");
    try {
      await api(`${base}/style`, {
        userId: currentViewingUserId,
        answers,
        confirm: true,
      });
      setConfirmed(true);
      refresh();
    } catch (e) {
      setConfirmError(
        e.message || "すべての設問に15文字以上で回答してください。",
      );
    }
  };

  const handleSetPriority = async (userId, opName) => {
    setPrioritySettingId(userId);
    setPrioritySuccessNote("");
    try {
      await api(`${base}/style/priority`, { userId });
      setPrioritySuccessNote(
        `「${opName}」を最優先のAI文体規範に設定しました。`,
      );
      refresh();
    } catch (e) {
      alert(e.message || "優先設定の更新に失敗しました。");
    } finally {
      setPrioritySettingId(null);
    }
  };

  const validCount = data.questions.filter(
    (q) => (answers[q.id] || "").trim().length >= 15,
  ).length;

  return (
    <div className="product-stack">
      <Note>
        普段お客様に送る言葉で回答してください。まずは全体のスタイル（丁寧・親しみ・論理）を選ぶと、自動的に最適な例文がセットされます。入力内容は1問ごとに自動保存されます。
      </Note>

      {/* 1. Multi-operator Priority & Voice Selection */}
      {data.operators && data.operators.length > 0 && (
        <div className="pt-priority-card">
          <div className="pt-priority-header">
            <div>
              <div className="pt-priority-title">
                AI文体規範の採用担当者（キャリブレーション優先設定）
              </div>
              <p className="pt-priority-desc">
                公式LINEの操作権限を持つ複数の担当者がいる場合、AIはここで優先設定された担当者の言葉遣い・返信スタイルを最優先の文体規範として学習し、提案を生成します。
              </p>
            </div>
            {prioritySuccessNote && (
              <div className="pt-priority-toast">✓ {prioritySuccessNote}</div>
            )}
          </div>

          <div className="pt-operator-grid">
            {data.operators.map((op) => {
              const isCurrentPriority = op.isPrimary;
              const isViewing = op.id === currentViewingUser?.id;
              const isSetting = prioritySettingId === op.id;

              return (
                <div
                  key={op.id}
                  className={`pt-operator-card ${isCurrentPriority ? "is-primary" : ""} ${isViewing ? "is-viewing" : ""}`}
                  onClick={() => setSelectedUserId(op.id)}
                >
                  <div className="pt-operator-card-top">
                    <div className="pt-operator-avatar">
                      {op.name.charAt(0) || "担"}
                    </div>
                    <div className="pt-operator-meta">
                      <div className="pt-operator-name-row">
                        <span className="pt-operator-name">{op.name}</span>
                        {op.isOwner && <Tag tone="stone">オーナー</Tag>}
                      </div>
                      <div className="pt-operator-email">{op.email}</div>
                    </div>
                  </div>

                  <div className="pt-operator-status-row">
                    <Tag tone={op.hasCalibration ? "green" : "stone"}>
                      {op.hasCalibration
                        ? "キャリブレーション完了"
                        : `未完了 (${op.answeredCount}/7問)`}
                    </Tag>
                    {isCurrentPriority ? (
                      <span className="pt-priority-active-badge">
                        ★ AI文体規範として採用中
                      </span>
                    ) : null}
                  </div>

                  <div
                    className="pt-operator-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className={`pt-operator-btn ${isViewing ? "btn-viewing" : ""}`}
                      onClick={() => setSelectedUserId(op.id)}
                    >
                      {isViewing ? "回答を表示中 ✓" : "回答を表示・編集"}
                    </button>

                    {!isCurrentPriority && (
                      <button
                        type="button"
                        className="pt-operator-btn btn-set-priority"
                        disabled={isSetting || !op.hasCalibration}
                        title={
                          !op.hasCalibration
                            ? "キャリブレーション完了後に優先指定できます"
                            : ""
                        }
                        onClick={() => handleSetPriority(op.id, op.name)}
                      >
                        {isSetting ? "設定中…" : "この担当者を文体規範に設定"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 2. Real-time Continuous Learning Status */}
      {data.learningStats && (
        <div className="pt-learning-banner">
          <div className="pt-learning-banner-main">
            <div className="pt-learning-icon-box">🧠</div>
            <div className="pt-learning-body">
              <div className="pt-learning-header-row">
                <span className="pt-learning-title">
                  送信修正・実運用の自動学習エンジン
                </span>
                <span className="pt-learning-status-pill">
                  リアルタイム学習 稼働中
                </span>
              </div>
              <p className="pt-learning-text">
                担当者が提案を修正して送信、または承認した履歴から、AIが語尾・長さ・絵文字・敬語のトーンを自動的に学習し、次回の提案に反映します。
              </p>
              <div className="pt-learning-pills">
                <span className="pt-learning-pill">
                  文体規範:{" "}
                  <strong>{data.learningStats.primaryUserName}</strong>{" "}
                  の回答スタイル
                </span>
                <span className="pt-learning-pill">
                  学習済み送信修正:{" "}
                  <strong>{data.learningStats.revisionsCount}</strong> 件
                </span>
                <span className="pt-learning-pill">
                  トーン補正:{" "}
                  <strong>
                    {data.learningStats.toneAdjustment === "more_restrained"
                      ? "落ち着いた丁寧トーンへ補正"
                      : data.learningStats.toneAdjustment ===
                          "more_enthusiastic"
                        ? "明るく積極的なトーンへ補正"
                        : "標準トーン"}
                  </strong>
                </span>
              </div>
              {data.learningStats.categoryStats &&
                Object.keys(data.learningStats.categoryStats).length > 0 && (
                  <div
                    style={{
                      marginTop: "10px",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--pt-muted)",
                        fontWeight: "600",
                      }}
                    >
                      場面別の学習蓄積:
                    </span>
                    {Object.entries(data.learningStats.categoryStats).map(
                      ([cat, cnt]) => {
                        const catLabel =
                          cat === "tap_followup"
                            ? "メニュー・LP操作後"
                            : cat === "post_meeting"
                              ? "面談・商談後"
                              : cat === "objection_wait"
                                ? "相談・検討待ち"
                                : cat === "schedule_change"
                                  ? "日程変更"
                                  : cat === "inactivity_cadence"
                                    ? "休眠・定期"
                                    : "通常・その他";
                        return (
                          <span
                            key={cat}
                            style={{
                              fontSize: "11px",
                              background: "var(--pt-surface)",
                              padding: "2px 8px",
                              borderRadius: "10px",
                              border: "1px solid var(--pt-border)",
                              color: "var(--pt-ink)",
                            }}
                          >
                            {catLabel}: <strong>{cnt}件</strong>
                          </span>
                        );
                      },
                    )}
                  </div>
                )}
            </div>
          </div>

          {data.learningStats.recentRevisions &&
            data.learningStats.recentRevisions.length > 0 && (
              <div className="pt-learning-revisions-toggle">
                <button
                  type="button"
                  className="pt-learning-toggle-btn"
                  onClick={() => setShowLearningDetails(!showLearningDetails)}
                >
                  {showLearningDetails
                    ? "▲ 直近の送信修正の学習例を閉じる"
                    : `▼ 直近の送信修正の学習例を表示 (${data.learningStats.recentRevisions.length}件)`}
                </button>

                {showLearningDetails && (
                  <div className="pt-learning-revisions-list">
                    {data.learningStats.recentRevisions.map((rev, idx) => (
                      <div key={idx} className="pt-learning-revision-card">
                        <div className="pt-learning-rev-badge">
                          修正例 {idx + 1}
                          {rev.trigger && (
                            <span
                              style={{
                                marginLeft: "8px",
                                fontWeight: "normal",
                                opacity: 0.9,
                              }}
                            >
                              （状況: {rev.trigger}）
                            </span>
                          )}
                        </div>
                        <div className="pt-learning-rev-grid">
                          <div className="pt-learning-rev-before">
                            <span className="pt-learning-rev-label">
                              修正前 (AI案):
                            </span>
                            <p className="pt-learning-rev-text">
                              {rev.original}
                            </p>
                          </div>
                          <div className="pt-learning-rev-arrow">→</div>
                          <div className="pt-learning-rev-after">
                            <span className="pt-learning-rev-label">
                              修正後 (担当者の理想・送信文):
                            </span>
                            <p className="pt-learning-rev-text">{rev.final}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
        </div>
      )}

      {/* Preset Style Selector Cards */}
      <div>
        <div
          style={{
            marginBottom: "8px",
            fontSize: "13px",
            fontWeight: "600",
            color: "var(--pt-ink)",
          }}
        >
          全体のトーン＆マナースタイルを選択
        </div>
        <div className="pt-style-presets">
          {STYLE_PRESETS.map((p) => {
            const isSelected = selectedPreset === p.id;
            return (
              <div
                key={p.id}
                className={`pt-style-preset-card ${isSelected ? "active" : ""}`}
                onClick={() => setSelectedPreset(p.id)}
              >
                <div className="pt-style-preset-header">
                  <span className="pt-style-preset-title">{p.title}</span>
                  <Tag tone={isSelected ? "lavender" : "stone"}>{p.tag}</Tag>
                </div>
                <div className="pt-style-preset-desc">{p.desc}</div>
                <button
                  type="button"
                  className="pt-style-preset-apply"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApplyAllPresetSamples(p.id);
                  }}
                >
                  このスタイルを全問に適用 →
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2-Column Responsive Layout: Questions (Left) & Live LINE Preview (Right) */}
      <div className="pt-style-layout">
        {/* Left: Questions Column */}
        <div className="pt-style-main">
          {/* Active Editing Indicator */}
          {currentViewingUser && (
            <div className="pt-style-editing-indicator">
              <span>
                表示・編集中の担当者: <strong>{currentViewingUser.name}</strong>
                {currentViewingUser.isPrimary && (
                  <span className="pt-priority-inline-badge">
                    （★ AI文体規範として採用中）
                  </span>
                )}
              </span>
              <Tag tone={currentViewingUser.hasCalibration ? "green" : "stone"}>
                {currentViewingUser.hasCalibration
                  ? "キャリブレーション完了"
                  : `未完了 (${validCount}/${data.questions.length})`}
              </Tag>
            </div>
          )}
          <div
            style={{
              background: "var(--pt-canvas, #f7f7fa)",
              border: "1px solid var(--pt-line, #ece9f1)",
              padding: "10px 14px",
              borderRadius: "8px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "13px",
              marginBottom: "16px",
            }}
          >
            <span>
              回答進捗:{" "}
              <strong>
                {validCount} / {data.questions.length} 問完了
              </strong>
              （各15文字以上）
            </span>
            <Tag
              tone={validCount === data.questions.length ? "green" : "stone"}
            >
              {validCount === data.questions.length ? "全問入力済み" : "入力中"}
            </Tag>
          </div>

          {data.questions.map((q) => {
            const currentVal = answers[q.id] || "";
            const isSaving = savingId === q.id;
            const isSaved = savedIds[q.id] && !isSaving;
            const isValid = currentVal.trim().length >= 15;
            const isActive = activeQuestionId === q.id;

            return (
              <div
                key={q.id}
                className={`pt-style-field-card ${isActive ? "active" : ""}`}
              >
                <div className="pt-style-field-header">
                  <span className="pt-style-field-label">
                    {q.group} · {q.text}
                  </span>
                  <div className="pt-style-field-meta">
                    {isSaving && (
                      <span style={{ color: "var(--pt-muted)" }}>保存中…</span>
                    )}
                    {isSaved && (
                      <span style={{ color: "#166534", fontWeight: 600 }}>
                        自動保存済み ✓
                      </span>
                    )}
                    <Tag tone={isValid ? "green" : "stone"}>
                      {currentVal.length} 文字
                    </Tag>
                  </div>
                </div>

                <textarea
                  name={q.id}
                  value={currentVal}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAnswers((prev) => ({ ...prev, [q.id]: val }));
                    setSavedIds((prev) => ({ ...prev, [q.id]: false }));
                  }}
                  onFocus={() => setActiveQuestionId(q.id)}
                  onBlur={(e) => handleBlur(q.id, e.target.value)}
                  placeholder="普段お客様に送る言葉を入力してください（クリックで右側のLINEプレビューが切り替わります）"
                  rows={4}
                />

                <div className="pt-style-sample-bar">
                  <button
                    type="button"
                    className="pt-style-sample-btn"
                    onClick={() => handleInsertSingleSample(q.id)}
                  >
                    「{currentPresetObj.title}」の例文を反映
                  </button>
                  <small
                    style={{
                      color: "var(--pt-muted, #787280)",
                      fontSize: "11px",
                    }}
                  >
                    枠外クリックで自動保存
                  </small>
                </div>
              </div>
            );
          })}

          {confirmError && (
            <p role="alert" className="product-error">
              {confirmError}
            </p>
          )}

          {confirmed && (
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                padding: "10px 14px",
                borderRadius: "6px",
                color: "#166534",
                fontSize: "13px",
                fontWeight: "500",
                marginBottom: "12px",
              }}
            >
              ✓ すべての回答を確定し、文体プロファイルを有効化しました。
            </div>
          )}

          <div style={{ marginTop: "16px" }}>
            <B
              variant="primary"
              disabled={validCount < data.questions.length}
              onClick={handleConfirmAll}
            >
              すべての回答を確定して完了
            </B>
            {validCount < data.questions.length && (
              <p
                className="product-muted"
                style={{ marginTop: "6px", fontSize: "12px" }}
              >
                ※すべての設問（各15文字以上）に回答すると確定ボタンが有効になります。入力中の内容は設問ごとに自動保存されています。
              </p>
            )}
          </div>
        </div>

        {/* Right: Live LINE Phone Mockup */}
        <div className="pt-style-preview-col">
          <LinePreview
            activeQuestionId={activeQuestionId}
            answers={answers}
            onSelectScenario={(qid) => setActiveQuestionId(qid)}
          />
        </div>
      </div>
    </div>
  );
}
export function Profiles({ tenant }) {
  const { data, error } = useData(`/api/tenants/${tenant}/my-accounts`),
    [oa, setOa] = useState("");
  if (!data) return <State error={error} />;
  const selected = oa || data.accounts[0]?.id;
  return (
    <>
      <Title
        eyebrow="YOUR VOICE"
        title="あなたらしい、言葉を。"
        description="お客様への返信を参考に、話し方を整えていきます。"
      />
      {selected ? (
        <>
          <select
            aria-label="文体を設定する公式LINE"
            className="product-select"
            value={selected}
            onChange={(e) => setOa(e.target.value)}
          >
            {data.accounts.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Section title="会話のキャリブレーション">
            <Style
              key={selected}
              base={`/api/tenants/${tenant}/accounts/${selected}`}
            />
          </Section>
        </>
      ) : (
        <Blank
          title="担当する公式LINEが未設定です"
          description="企業の管理者が公式LINEと担当者を設定すると、回答を始められます。"
        />
      )}
    </>
  );
}
function RetentionField({ days }) {
  const [mode, setMode] = useState(days === null ? "unlimited" : "days");
  return <div className="product-grid">
    <Field label="会話・議事録の保持期間" hint="企業の運用ルールを登録します。この保存で既存データの削除は行いません。">
      <select name="retentionMode" value={mode} onChange={e=>setMode(e.target.value)}>
        <option value="days">日数を指定する</option>
        <option value="unlimited">期限なし</option>
      </select>
    </Field>
    {mode === "days" && <Field label="保持日数" hint="自動削除の適用は開通前に確認します。">
      <input name="retentionDays" type="number" min="1" max="3650" required defaultValue={days ?? ""}/>
    </Field>}
  </div>;
}

export function Onboarding({ tenant, me, reloadMe }) {
  const base = `/api/tenants/${tenant}`;
  const { data: capabilities, error: capabilitiesError } =
    useData("/api/config");
  const { data, error, refresh } = useData(`${base}/setup`),
    [step, setStep] = useState(() => {
      const value = new URLSearchParams(location.search).get("step");
      return value !== null && /^[0-6]$/.test(value) ? Number(value) : -1;
    }),
    [settingsSaved, setSettingsSaved] = useState(false),
    [dialog, setDialog] = useState(null),
    [oaId, setOaId] = useState(() => new URLSearchParams(location.search).get("oa") || "");
  if (!data) return <State error={error} />;
  if (!capabilities) return <State error={capabilitiesError} />;
  if (oaId && !data.accounts.some(a=>a.id===oaId)) return <State error="指定した公式LINEがこの企業にありません。導入・企業設定をメニューから開き直してください。"/>;
  const requestedTenant = new URLSearchParams(location.search).get("tenant");
  if (requestedTenant && requestedTenant !== tenant) return <State error="指定された企業へ切替中です。所属先を確認して開き直してください。"/>;
  const org = data.tenant,
    oa = data.accounts.find((a) => a.id === oaId) || data.accounts[0],
    accountBase = oa ? `${base}/accounts/${oa.id}` : "";
  const readiness = data.readiness?.find(r=>r.accountId===oa?.id);
  const roles = me.memberships.find(m=>m.tenant_id===tenant)?.roles || [];
  const choose = (nextStep, account = oa?.id) => {
    setStep(nextStep);
    if (nextStep === -1 || nextStep === 6) refresh();
    if (account) setOaId(account);
    const query = new URLSearchParams(location.search);
    nextStep < 0 ? query.delete("step") : query.set("step",String(nextStep));
    if (account) query.set("oa",account);
    history.replaceState(null,"",`${location.pathname}?${query}`);
    window.scrollTo(0,0);
  };
  const done = () => {
    setDialog(null);
    refresh();
  };
  return (
    <>
      <Title
        eyebrow="GETTING STARTED"
        title="いいスタートを、一緒に。"
        description={`${org.name} · 保存した内容から、いつでも再開できます。`}
      >
        <B variant="secondary" icon="RefreshCw" onClick={refresh}>
          状態を更新
        </B>
      </Title>
      <div
        className="product-tabs"
        role="group"
        aria-label="セットアップの手順"
      >
        <B variant="secondary" aria-pressed={step === -1} onClick={()=>choose(-1)}>開通までの進め方</B>
        {steps.map((s, i) => (
          <B
            key={s}
            variant="secondary"
            aria-pressed={step === i}
            onClick={() => choose(i)}
          >
            {String(i + 1).padStart(2, "0")} {s}
          </B>
        ))}
      </div>
      {step === -1 && <SetupOverview data={data} accountId={oa?.id} onAccount={id=>choose(-1,id)} onStep={choose} canUseWorkspace={roles.includes("org_owner")}/>}
      {step === 0 && (
        <Section
          title="企業の基本情報"
          sub="企業共通の設定を、各公式LINEで使います。"
        >
          <Form
            key={org.version}
            onSubmit={(v) => {
              const {retentionMode, ...values} = v;
              return api(
                `${base}/settings`,
                {
                  ...values,
                  retentionDays: retentionMode === "unlimited" ? null : Number(v.retentionDays),
                  shareTeam: v.shareTeam === "on",
                  version: org.version,
                },
                "PATCH",
              );
            }}
            onDone={() => {
              setSettingsSaved(true);
              refresh();
            }}
          >
            <div className="product-grid">
              <Field label="企業名">
                <input name="name" required defaultValue={org.name} />
              </Field>
              <Field label="業界">
                <input name="industry" defaultValue={org.industry} />
              </Field>
              <Field label="公式LINEの保有単位">
                <select name="unit" defaultValue={org.unit}>
                  <Units />
                </select>
              </Field>
              <Field label="導入方法">
                <select name="method" defaultValue={org.method}>
                  <Methods />
                </select>
              </Field>
            </div>
            <Field label="導入パターン">
              <select name="product" defaultValue={org.product}>
                <option value="existing">既存LINEへTSUNAGUを追加</option>
                <option value="harness">Harness込みで構築</option>
              </select>
            </Field>
            <RetentionField days={org.settings.retentionDays}/>
            <label className="product-check">
              <input
                type="checkbox"
                name="shareTeam"
                defaultChecked={org.settings.shareTeam}
              />
              営業担当者が同じチームの顧客を閲覧できるようにする（標準は自分の顧客のみ）
            </label>
          </Form>
          {settingsSaved && (
            <p role="status" className="product-saved">
              企業設定を保存しました。
            </p>
          )}
        </Section>
      )}
      {step === 1 && (
        <div className="product-stack">
          <Section
            title="担当者・役割"
            action={
              <B icon="Plus" onClick={() => setDialog("invite")}>
                招待する
              </B>
            }
          >
            {data.members.map((m) => (
              <div className="product-row" key={m.user_id}>
                <div>
                  <h3>{m.name || m.email}</h3>
                  <p>{m.email}</p>
                </div>
                <div className="product-actions">
                  {m.roles.map((r) => (
                    <Tag key={r}>{label(r)}</Tag>
                  ))}
                  <Status value={m.state} />
                  {m.user_id !== me.user.id && (
                    <B
                      variant="ghost"
                      onClick={() => setDialog({ type: "member", member: m })}
                    >
                      変更
                    </B>
                  )}
                </div>
              </div>
            ))}
            {data.invitations
              .filter((i) => !i.accepted_at && !i.revoked_at)
              .map((i) => (
                <div className="product-row" key={i.id}>
                  <span>{i.email}</span>
                  <Tag>招待中 · {date(i.expires_at)}まで</Tag>
                </div>
              ))}
          </Section>
          <Note>
            システム管理者は接続や権限を設定します。顧客の会話を扱う場合は、営業担当・チーム管理者・組織責任者を別途付与してください。
          </Note>
        </div>
      )}
      {step === 2 && (
        <Section
          title="企業の公式LINE"
          sub="担当者専用のアカウントも、企業所有で管理します。"
          action={
            <B icon="Plus" onClick={() => setDialog("oa")}>
              追加する
            </B>
          }
        >
          {data.accounts.length ? (
            data.accounts.map((a) => (
              <div className="product-row" key={a.id}>
                <div>
                  <h3>{a.name}</h3>
                  <p>
                    主担当：
                    {data.members.find((m) => m.user_id === a.owner_user_id)
                      ?.name || "未設定"}{" "}
                    · DB{" "}
                    {
                      data.databases.filter(
                        (d) => d.oa_id === a.id && d.state === "ready",
                      ).length
                    }
                    /2
                  </p>
                </div>
                <div className="product-actions">
                  <Status value={a.state} />
                  <B
                    variant="secondary"
                    onClick={() => setDialog({ type: "account", account: a })}
                  >
                    担当を設定
                  </B>
                </div>
              </div>
            ))
          ) : (
            <Blank
              title="公式LINEを登録しましょう"
              description="各担当者の公式LINEを一覧で管理できます。"
            />
          )}
        </Section>
      )}
      {step >= 3 && step <= 6 && (
        <>
          {data.accounts.length > 0 && (
            <div className="product-note-spaced">
              <Field label="設定する公式LINE">
                <select
                  className="product-select"
                  value={oa?.id || ""}
                  onChange={(e) => choose(step,e.target.value)}
                >
                  {data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {!oa ? (
            <Blank
              title="公式LINEの登録が必要です"
              description="公式LINEのステップから追加してください。"
            />
          ) : (
            <>
              {step === 3 && (
                <div className="product-stack">
                  {!capabilities.harnessReadOnly && (
                    <>
                      <Section
                        title="LINEへの接続"
                        sub="Messaging APIの設定情報を登録します。登録後に秘密情報は表示しません。"
                      >
                        <Form
                          key={oa.id}
                          button="資格情報を安全に登録"
                          onSubmit={(v) => api(`${accountBase}/credentials`, v)}
                          onDone={refresh}
                        >
                          <Field label="チャネルID">
                            <input
                              name="channelId"
                              required
                              pattern="[0-9]{5,20}"
                              autoComplete="off"
                            />
                          </Field>
                          <Field label="Channel Secret">
                            <input
                              name="channelSecret"
                              type="password"
                              required
                              minLength={20}
                              autoComplete="new-password"
                            />
                          </Field>
                          <Field label="チャネルアクセストークン">
                            <input
                              name="accessToken"
                              type="password"
                              required
                              minLength={20}
                              autoComplete="off"
                            />
                          </Field>
                          {data.credentials.some(
                            (c) => c.oa_id === oa.id && c.service === "line",
                          ) && (
                            <Note>
                              資格情報は登録済みです。再入力すると更新します。
                            </Note>
                          )}
                        </Form>
                      </Section>
                      <WebhookSection
                        accountBase={accountBase}
                        oa={oa}
                        refresh={refresh}
                      />
                    </>
                  )}
                  <HarnessConnection
                    key={oa.id}
                    base={accountBase}
                    connected={data.connections.some(
                      (c) =>
                        c.oa_id === oa.id &&
                        c.service === "harness" &&
                        c.state === "connected",
                    )}
                    done={refresh}
                  />
                  <Section title="業務ツールとの接続">
                    <Form
                      button="接続先を登録する"
                      onSubmit={(v) =>
                        api(`${base}/connections`, { oaId: oa.id, ...v })
                      }
                      onDone={refresh}
                    >
                      <Field label="サービス">
                        <select name="service">
                          <option value="google_sheets">Google Sheets</option>
                          <option value="google_drive">Google Drive</option>
                          <option value="google_calendar">
                            Google Calendar
                          </option>
                          <option value="timerex">TimeRex</option>
                        </select>
                      </Field>
                      <Field label="取り込むリソースのURL・ID">
                        <input name="resource" maxLength={500} />
                      </Field>
                    </Form>
                    {data.connections
                      .filter((c) => c.oa_id === oa.id)
                      .map((c) => (
                        <div className="product-row" key={c.id}>
                          <span>{c.service}</span>
                          <Status value={c.state} />
                        </div>
                      ))}
                    <p className="product-muted">
                      登録だけでは接続完了になりません。認可とデータ取得の確認後に利用を開始します。
                    </p>
                  </Section>
                </div>
              )}
              {step === 4 && (
                <Preview
                  base={accountBase}
                  oa={oa}
                  done={refresh}
                  refreshAccount={refresh}
                />
              )}
              {step === 5 && (
                <Section title="担当者の言葉を設定">
                  {oa.owner_user_id === me.user.id ||
                  oa.operators.includes(me.user.id) ? (
                    <Style key={oa.id} base={accountBase} />
                  ) : (
                    <Blank
                      title="担当者本人の回答をお待ちください"
                      description="担当者は自分のアカウントでログインし、「あなたらしい言葉」から回答できます。"
                    />
                  )}
                </Section>
              )}
              {step === 6 && (
                <div className="product-stack">
                  <Section title="開通のチェック">
                    {readiness && <ReadinessChecks readiness={readiness} onStep={choose}/>}
                    <Action
                      variant="primary"
                      disabled={!readiness?.canActivate || oa.state === "ready"}
                      run={() => api(`${accountBase}/activate`, {})}
                      done={() => {
                        refresh();
                        reloadMe();
                      }}
                    >
                      {capabilities.harnessReadOnly ? "この環境は限定テスト用です" : oa.state === "ready" ? "利用開始済み" : "この公式LINEの利用を開始する"}
                    </Action>
                  </Section>
                  <Section title="処理状況">
                    <Jobs jobs={data.jobs} refresh={refresh} canRetry={false} />
                  </Section>
                </div>
              )}
            </>
          )}
        </>
      )}
      {data.support.filter((s) => s.state === "pending").length > 0 && (
        <Section title="サポートアクセスの申請">
          {data.support
            .filter((s) => s.state === "pending")
            .map((s) => (
              <div className="product-row" key={s.id}>
                <div>
                  <p>{s.reason}</p>
                  <small>{date(s.expires_at)}まで · 会話の閲覧</small>
                </div>
                <Action
                  run={() =>
                    api(`${base}/support/${s.id}/decision`, { approve: true })
                  }
                  done={refresh}
                >
                  承認
                </Action>
                <Action
                  run={() =>
                    api(`${base}/support/${s.id}/decision`, { approve: false })
                  }
                  done={refresh}
                >
                  拒否
                </Action>
              </div>
            ))}
        </Section>
      )}
      <Modal
        open={dialog}
        title={
          dialog === "invite"
            ? "担当者を招待"
            : dialog?.type === "member"
              ? "役割を変更"
              : dialog === "oa"
                ? "公式LINEを追加"
                : "担当者を設定"
        }
        onClose={() => setDialog(null)}
      >
        {dialog === "invite" && (
          <Form
            button="招待を送る"
            onSubmit={(v) =>
              api(`${base}/invitations`, {
                email: v.email,
                roles: [v.role],
                teams: v.team ? [v.team] : [],
              })
            }
            onDone={done}
          >
            <Field label="メールアドレス">
              <input name="email" type="email" required />
            </Field>
            <RoleField />
            <Field label="チーム名・ID（任意）">
              <input name="team" />
            </Field>
          </Form>
        )}
        {dialog?.type === "member" && (
          <Form
            onSubmit={(v) =>
              api(
                `${base}/members/${dialog.member.user_id}`,
                {
                  roles: v.roles.split(","),
                  teams: v.team ? [v.team] : [],
                  state: v.state,
                },
                "PATCH",
              )
            }
            onDone={done}
          >
            <Note>{dialog.member.email} の役割を設定します。</Note>
            <Field label="役割">
              <select name="roles" defaultValue={dialog.member.roles.join(",")}>
                <RoleOptions />
                <option value="sys_admin,sales">
                  システム管理者＋営業担当
                </option>
                <option value="sys_admin,org_owner">
                  システム管理者＋組織責任者
                </option>
              </select>
            </Field>
            <Field label="チーム">
              <input name="team" defaultValue={dialog.member.teams[0] || ""} />
            </Field>
            <Field label="利用状態">
              <select name="state" defaultValue={dialog.member.state}>
                <option value="active">利用中</option>
                <option value="suspended">停止</option>
              </select>
            </Field>
          </Form>
        )}
        {dialog === "oa" && (
          <Form onSubmit={(v) => api(`${base}/accounts`, v)} onDone={done}>
            <AccountFields />
          </Form>
        )}
        {dialog?.type === "account" && (
          <Form
            onSubmit={(v) => {
              const a = dialog.account;
              return api(
                `${base}/accounts/${a.id}`,
                {
                  name: a.name,
                  kind: a.kind,
                  origin: a.origin,
                  ownerUserId: v.owner || null,
                  operators: v.operator ? [v.operator] : [],
                  teamId: v.team || null,
                  version: a.version,
                },
                "PATCH",
              );
            }}
            onDone={done}
          >
            <Field label="主担当">
              <select
                name="owner"
                defaultValue={dialog.account.owner_user_id || ""}
              >
                <option value="">未設定</option>
                {data.members
                  .filter((m) => m.state === "active")
                  .map((m) => (
                    <option value={m.user_id} key={m.user_id}>
                      {m.name}（{m.email}）
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="追加の操作者（任意）">
              <select
                name="operator"
                defaultValue={dialog.account.operators[0] || ""}
              >
                <option value="">なし</option>
                {data.members
                  .filter((m) => m.state === "active")
                  .map((m) => (
                    <option value={m.user_id} key={m.user_id}>
                      {m.name}（{m.email}）
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="チーム">
              <input name="team" defaultValue={dialog.account.team_id || ""} />
            </Field>
          </Form>
        )}
      </Modal>
    </>
  );
}
function RoleOptions() {
  return (
    <>
      <option value="sales">営業担当：自分の顧客</option>
      <option value="team_admin">チーム管理者：チームの顧客・承認</option>
      <option value="org_owner">組織責任者：企業全体・承認</option>
      <option value="sys_admin">システム管理者：導入・権限設定</option>
      <option value="billing">経理：確定した請求書</option>
    </>
  );
}
function RoleField() {
  return (
    <Field label="役割">
      <select name="role">
        <RoleOptions />
      </select>
    </Field>
  );
}
function Preview({ base, oa, done, refreshAccount }) {
  const { data, error, refresh } = useData(`${base}/preview`);
  if (!data) return <State error={error} />;

  const isWebhookReady = Boolean(oa?.webhook_verified_at);

  return (
    <Section
      title="取込み内容の確認"
      sub="連携した公式LINEとデータ件数をご確認ください。"
    >
      <div className="product-row">
        <span>公式LINE</span>
        <strong>{data.accountName}</strong>
      </div>
      <div className="product-row">
        <span>関連付けられた友だち</span>
        <strong>{data.customers}人</strong>
      </div>
      <div className="product-row">
        <span>登録素材</span>
        <strong>{data.assets}件</strong>
      </div>
      <Note>
        初回の名簿・素材取り込みは各サービスの接続完了後に反映されます。人物の一致が不明な場合は自動統合しません。
      </Note>

      {!isWebhookReady && (
        <div
          style={{
            margin: "14px 0",
            background: "#fffbeb",
            border: "1px solid #fef3c7",
            padding: "12px 14px",
            borderRadius: "6px",
            color: "#92400e",
          }}
        >
          <strong style={{ fontSize: "13px" }}>
            ⚠️ Webhook受信がまだ未完了です
          </strong>
          <p
            style={{
              margin: "4px 0 10px 0",
              fontSize: "12px",
              lineHeight: "1.5",
            }}
          >
            この内容を確認する前に、Webhook受信を完了させてください。下のボタンから今すぐ確認済みにすることもできます。
          </p>
          <Action
            variant="primary"
            run={() => api(`${base}/verify-webhook-manual`, {})}
            done={() => {
              refreshAccount?.();
              refresh();
            }}
          >
            Webhook受信を確認済みにする
          </Action>
        </div>
      )}

      <Action
        variant="primary"
        disabled={!isWebhookReady}
        run={() =>
          api(`${base}/preview/confirm`, { fingerprint: data.fingerprint })
        }
        done={done}
      >
        この内容を確認した
      </Action>
    </Section>
  );
}

function WebhookSection({ accountBase, oa, refresh }) {
  const [mode, setMode] = useState(
    oa.webhook_mode === "gateway" ? "gateway" : "harness",
  );
  const [testResult, setTestResult] = useState(null);
  const isVerified = Boolean(oa.webhook_verified_at);

  return (
    <Section title="Webhookの確認">
      <Note>
        すでにHarness等の配信システムを利用している場合は、LINE
        DevelopersのWebhookを変更せず「Harness経由で連携する」を選択してください。
      </Note>

      {/* Webhook受信状態カード */}
      <div
        style={{
          margin: "12px 0 16px 0",
          background: isVerified ? "#f0fdf4" : "#fffbeb",
          border: `1px solid ${isVerified ? "#bbf7d0" : "#fef3c7"}`,
          padding: "12px 14px",
          borderRadius: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div style={{ flex: 1, minWidth: "240px" }}>
            <strong
              style={{
                color: isVerified ? "#166534" : "#92400e",
                fontSize: "13px",
              }}
            >
              {isVerified
                ? "✅ Webhook受信：確認済み"
                : "⚠️ Webhook受信：未完了（イベント待機中）"}
            </strong>
            <p
              style={{
                margin: "4px 0 0 0",
                fontSize: "12px",
                color: isVerified ? "#15803d" : "#b45309",
                lineHeight: "1.5",
              }}
            >
              {isVerified
                ? `最終受信日時: ${date(oa.webhook_verified_at)}（イベントの受信が確認できています）`
                : "開通チェックの「Webhook受信」を完了させるには、実際のイベント受信または下のボタンで確認を行ってください。"}
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Action
              variant={isVerified ? "secondary" : "primary"}
              run={async () => {
                await api(`${accountBase}/test-webhook`, {});
                setTestResult("疎通テストに成功しました！");
              }}
              done={refresh}
            >
              疎通テストを実行
            </Action>
            <Action
              variant="secondary"
              run={async () => {
                await api(`${accountBase}/verify-webhook-manual`, {});
                setTestResult("手動で確認済みに設定しました。");
              }}
              done={refresh}
            >
              手動で確認済みにする
            </Action>
          </div>
        </div>
        {testResult && (
          <p
            style={{
              margin: "8px 0 0 0",
              fontSize: "12px",
              color: "#166534",
              fontWeight: "500",
            }}
          >
            ✓ {testResult}
          </p>
        )}
      </div>

      <Form
        button="接続を検証する（LINE設定チェック）"
        onSubmit={(v) =>
          api(`${accountBase}/verify-line`, {
            mode: v.mode,
            confirmedExistingWebhook: v.confirmed === "on",
          })
        }
        onDone={refresh}
      >
        <Field label="接続方式">
          <select
            name="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="harness">
              Harness経由で連携する（既存の配信システムを維持）
            </option>
            <option value="gateway">
              TSUNAGUがLINEイベントを受信する（上書き）
            </option>
          </select>
        </Field>
        <label className="product-check">
          <input name="confirmed" type="checkbox" required />
          既存Webhookと現在利用中のシステムを確認しました
        </label>
      </Form>

      {oa.webhook_mode !== "unconfirmed" && (
        <div
          style={{
            marginTop: "12px",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            padding: "10px 14px",
            borderRadius: "6px",
            color: "#166534",
            fontSize: "13px",
            fontWeight: "500",
          }}
        >
          ✓ LINEへの接続検証が完了しました（現在の方式:{" "}
          {oa.webhook_mode === "harness" ? "Harness連携" : "直接受信"}）
        </div>
      )}

      {mode === "harness" ? (
        <div
          style={{
            marginTop: "14px",
            background: "#f8fafc",
            padding: "14px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              fontWeight: "600",
              color: "#0f172a",
            }}
          >
            📋 Harness連携モードの手順
          </p>
          <ol
            style={{
              margin: "8px 0 0 16px",
              padding: 0,
              fontSize: "12px",
              color: "#475569",
              lineHeight: "1.7",
            }}
          >
            <li>
              LINE Developers側のWebhook（例:{" "}
              <code>https://enjin-line.shimoryo.workers.dev/webhook</code>
              ）は<strong>変更不要</strong>です。
            </li>
            <li>
              すぐ下の<strong>「Harnessと接続する」</strong>
              で接続設定を保存します。
            </li>
            <li>
              Harness管理画面の「送信Webhook」に、下に表示される「Harnessの送信Webhook
              URL」を登録します。
            </li>
            <li>
              公式LINEにテストメッセージを送信するか、上の
              <strong>「疎通テストを実行」</strong>または
              <strong>「手動で確認済みにする」</strong>を押してください。
            </li>
          </ol>
        </div>
      ) : (
        <div style={{ marginTop: "14px" }}>
          <p className="product-muted">LINE Developersに設定するWebhook URL</p>
          <code className="product-secret">
            {location.origin}/webhooks/line/{oa.id}
          </code>
          <p className="product-muted">
            最終受信：{date(oa.webhook_verified_at)}
          </p>
        </div>
      )}
    </Section>
  );
}
