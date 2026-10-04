import { classifyEdit } from "./assistant-learning.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { accountFor } from "./access.ts";
import { requireThat, audit } from "./security.ts";

export const standardQuestions = [
  {
    id: "formality",
    label: "敬語・トーンの基準",
    options: [
      { value: "polite", label: "丁寧で誠実なトーン（〜いただけますと幸いです、恐縮です）" },
      { value: "casual", label: "親しみやすいトーン（〜ですね！、お気軽にどうぞ）" },
      { value: "formal", label: "格式重視のビジネス敬語（〜お願い申し上げます）" },
    ],
  },
  {
    id: "emoji",
    label: "絵文字・記号の使い方",
    options: [
      { value: "minimal", label: "要所のみ控えめに（✨、😊など1通に1〜2個）" },
      { value: "frequent", label: "明るく適度に活用（文末や区切りに活用）" },
      { value: "none", label: "使用しない（記号も最小限）" },
    ],
  },
  {
    id: "length",
    label: "メッセージの長さの目安",
    options: [
      { value: "short", label: "スマホで1画面に収まる短文（150〜250文字）" },
      { value: "medium", label: "文脈と提案理由がしっかり伝わる標準長（250〜400文字）" },
      { value: "detailed", label: "詳細な情報や導入事例を盛り込んだ長文（400〜600文字）" },
    ],
  },
  {
    id: "closingCta",
    label: "文末の呼びかけ（CTA）の基本姿勢",
    options: [
      { value: "soft", label: "返信負担をかけない問いかけ（ご興味があればで構いません）" },
      { value: "meeting", label: "日程候補やオンライン相談への自然な誘導" },
      { value: "resource", label: "動画や事例リンクの確認を促す案内" },
    ],
  },
];

export function extractTextFeatures(samples: string[]) {
  if (!samples.length) {
    return {
      averageCharsPerMessage: 250,
      averageSentencesPerMessage: 3,
      emojiRate: "low",
      commonClosings: [],
    };
  }

  let totalChars = 0;
  let totalSentences = 0;
  let totalEmojis = 0;
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

  for (const s of samples) {
    totalChars += s.length;
    const sentences = s.split(/[。！？\n]+/).filter(Boolean);
    totalSentences += sentences.length || 1;
    const emojis = s.match(emojiRegex);
    if (emojis) totalEmojis += emojis.length;
  }

  const avgChars = Math.round(totalChars / samples.length);
  const avgSentences = Math.round(totalSentences / samples.length);
  const avgEmojis = totalEmojis / samples.length;

  return {
    averageCharsPerMessage: avgChars,
    averageSentencesPerMessage: avgSentences,
    emojiRate: avgEmojis > 2 ? "high" : avgEmojis >= 0.5 ? "medium" : "low",
    sampleCount: samples.length,
    calibratedAt: now(),
  };
}

export async function adaptStyleFromFeedback(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  userId: string,
) {
  const ts = await rt.openDatabase(tenantId, oaId, "tsunagu");
  const edits = await all(
    ts,
    "SELECT e.original,e.final FROM feedback e JOIN feedback a ON a.proposal_id=e.proposal_id AND a.version=e.version AND a.actor_id=e.actor_id AND a.action='approved' AND a.excluded=0 WHERE e.actor_id=? AND ?<>'' AND e.action='edited' AND e.excluded=0 AND e.original<>e.final ORDER BY e.at DESC LIMIT 20",
    [userId, userId],
  );

  const approvedStyle = edits.filter(e=>classifyEdit(e.original,e.final).transferable);
  if (!approvedStyle.length) return null;

  let lengthDiff = 0;
  let removedExclamations = 0;
  let addedExclamations = 0;

  for (const e of approvedStyle) {
    if (!e.original || !e.final) continue;
    lengthDiff += e.final.length - e.original.length;
    const origExc = (e.original.match(/！/g) || []).length;
    const finalExc = (e.final.match(/！/g) || []).length;
    if (finalExc < origExc) removedExclamations++;
    if (finalExc > origExc) addedExclamations++;
  }

  const avgLengthDiff = Math.round(lengthDiff / approvedStyle.length);
  const toneAdjustment =
    removedExclamations > addedExclamations
      ? "more_restrained"
      : addedExclamations > removedExclamations
        ? "more_enthusiastic"
        : "neutral";

  let profile = await one(
    ts,
    "SELECT * FROM style_profiles WHERE user_id=?",
    [userId],
  );
  if (!profile) {
    profile = await one(
      ts,
      "SELECT * FROM style_profiles WHERE state='active' ORDER BY updated_at DESC LIMIT 1",
    );
  }
  if (!profile) return null;

  const currentFeatures = parse(profile.features, {});
  const updatedFeatures = {
    ...currentFeatures,
    learnedAdjustment: {
      avgLengthDelta: avgLengthDiff,
      toneAdjustment,
      feedbackSampleCount: approvedStyle.length,
      recentRevisions: [],
      adaptedAt: now(),
    },
  };

  await ts.query(
    "UPDATE style_profiles SET features=?,version=version+1,updated_at=? WHERE user_id=?",
    [json(updatedFeatures), now(), profile.user_id],
  );

  return updatedFeatures;
}

export type ContextCategory =
  | "tap_followup"
  | "post_meeting"
  | "objection_wait"
  | "schedule_change"
  | "inactivity_cadence"
  | "general";

export function detectContextCategory(trigger?: string | null, reason?: string | null): ContextCategory {
  const text = `${trigger ?? ""} ${reason ?? ""}`.toLowerCase();
  if (
    text.includes("タップ") ||
    text.includes("リッチメニュー") ||
    text.includes("lp") ||
    text.includes("エンジンとは") ||
    text.includes("click") ||
    text.includes("content")
  ) {
    return "tap_followup";
  }
  if (
    text.includes("面談") ||
    text.includes("商談") ||
    text.includes("meeting") ||
    text.includes("ヒアリング") ||
    text.includes("1on1")
  ) {
    return "post_meeting";
  }
  if (
    text.includes("相談") ||
    text.includes("家族") ||
    text.includes("検討") ||
    text.includes("ネック") ||
    text.includes("迷い") ||
    text.includes("wait")
  ) {
    return "objection_wait";
  }
  if (
    text.includes("変更") ||
    text.includes("日程") ||
    text.includes("キャンセル") ||
    text.includes("change")
  ) {
    return "schedule_change";
  }
  if (
    text.includes("休眠") ||
    text.includes("定期") ||
    text.includes("未連絡") ||
    text.includes("cadence") ||
    text.includes("inactivity")
  ) {
    return "inactivity_cadence";
  }
  return "general";
}

export async function getAccountCalibrationProfile(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  targetContext?: { trigger?: string | null; reason?: string | null; actorId?:string },
) {
  const oa = await accountFor(rt, tenantId, oaId);
  const ts = await rt.openDatabase(tenantId, oaId, "tsunagu");

  const activeProfiles = await all(
    ts,
    "SELECT * FROM style_profiles WHERE state='active' ORDER BY updated_at DESC",
  );

  let selected = targetContext?.actorId ? activeProfiles.find(p=>p.user_id===targetContext.actorId) : oa.primary_calibration_user_id
    ? activeProfiles.find((p) => p.user_id === oa.primary_calibration_user_id)
    : null;

  if (!selected) {
    selected = activeProfiles.find((p) => p.user_id === oa.owner_user_id);
  }

  if (!selected && activeProfiles.length > 0) {
    selected = activeProfiles[0];
  }

  if (!selected) {
    const targetUid = oa.primary_calibration_user_id || oa.owner_user_id;
    if (targetUid) {
      selected = await one(
        ts,
        "SELECT * FROM style_profiles WHERE user_id=?",
        [targetUid],
      );
    }
  }

  const learningActor = targetContext?.actorId || selected?.user_id || oa.owner_user_id;
  const allRevisions = (await all(ts,
    "SELECT e.original,e.final,e.at,p.trigger FROM feedback e JOIN feedback a ON a.proposal_id=e.proposal_id AND a.version=e.version AND a.actor_id=e.actor_id AND a.action='approved' AND a.excluded=0 LEFT JOIN proposals p ON p.id=e.proposal_id WHERE e.actor_id=? AND e.action='edited' AND e.excluded=0 AND e.original<>e.final ORDER BY e.at DESC LIMIT 30",[learningActor]))
    .filter(r=>classifyEdit(r.original,r.final).transferable)
    .map(r=>{const examples=classifyEdit(r.original,r.final).examples; return {...r,trigger:r.trigger,original:examples.map(e=>e.before).join(" / "),final:examples.map(e=>e.after).join(" / "),reason:null};});

  const targetCategory = targetContext
    ? detectContextCategory(targetContext.trigger, targetContext.reason)
    : null;

  const mappedRevisions = allRevisions.map((r) => ({
    original: r.original,
    final: r.final,
    trigger: r.trigger || null,
    reason: r.reason || null,
    category: detectContextCategory(r.trigger, r.reason),
  }));

  // Context-aware selection: Prioritize revisions from the same context category
  const matched = targetCategory
    ? mappedRevisions.filter((r) => r.category === targetCategory)
    : [];
  const others = targetCategory
    ? mappedRevisions.filter((r) => r.category !== targetCategory)
    : mappedRevisions;

  const sortedRevisions = [...matched, ...others].slice(0, 8);

  const categoryStats: Record<string, number> = {};
  for (const r of mappedRevisions) {
    categoryStats[r.category] = (categoryStats[r.category] || 0) + 1;
  }

  const approvedSamples:Row[] = [];

  return {
    primaryUserId:
      oa.primary_calibration_user_id || selected?.user_id || oa.owner_user_id,
    selectedUserId: selected?.user_id || null,
    targetCategory,
    categoryStats,
    profile: selected
      ? {
          ...selected,
          answers: parse(selected.answers, {}),
          features: parse(selected.features, {}),
        }
      : null,
    recentRevisions: sortedRevisions,
    approvedSamples: approvedSamples.map((s) => s.final).filter(Boolean),
  };
}

export function buildStylePrompt(calib: {
  profile: { answers: Record<string, string>; features: Record<string, any> } | null;
  recentRevisions: Array<{ original: string; final: string; trigger?: string | null; reason?: string | null; category?: string }>;
  approvedSamples: string[];
  targetCategory?: string | null;
}, targetContext?: { trigger?: string | null; reason?: string | null }): string {
  const parts: string[] = [];

  // Layer 1: TSUNAGU Global Product Philosophy (プロダクト共通の追客思想)
  parts.push("【TSUNAGU プロダクト共通の追客思想（全体基本原則）】");
  parts.push("1. 押し売り・詰問・契約催促の完全排除: 相手の次の判断負担を最小化し、友好的な味方として接すること。");
  parts.push("2. 不自然な格式敬語の禁止: 「〜いただけますと幸甚に存じます」「大変恐縮でございますが」などの堅苦しいメール敬語は使わず、LINEとして自然で親身な丁寧語（〜ですね！、〜幸いです）を使うこと。");
  parts.push("3. 1通につき1アクション・1問いかけ: 返信のハードルを極力下げ、相手がスタンプや一言で返せる気軽さを保つこと。");
  parts.push("4. 顧客のペースと安心感を最優先: 迷いや家族相談には寄り添い、背中を優しく押すこと。");

  // Layer 2: Official Account & Operator Voice (公式LINE・担当者固有の文体規範)
  if (calib.profile?.answers && Object.keys(calib.profile.answers).length > 0) {
    const a = calib.profile.answers;
    parts.push("\n【公式LINE担当者の文体規範（キャリブレーション実例）】");
    parts.push("担当者本人の実際の語り口です。トーン、語尾、句読点、絵文字、距離感を厳密に反映してください：");
    if (a["common.first"]) parts.push(`・初回挨拶/自己紹介の基準:\n「${a["common.first"]}」`);
    if (a["common.needs"]) parts.push(`・興味確認/ネック質問時の基準:\n「${a["common.needs"]}」`);
    if (a["common.booking"]) parts.push(`・面談/予約案内時の基準:\n「${a["common.booking"]}」`);
    if (a["common.wait"]) parts.push(`・家族相談/検討待ち時の基準:\n「${a["common.wait"]}」`);
    if (a["common.change"]) parts.push(`・日程変更時の基準:\n「${a["common.change"]}」`);
    if (a["industry.case"]) parts.push(`・業界の悩みへの回答基準:\n「${a["industry.case"]}」`);
    if (a["company.case"]) parts.push(`・自社実績や案内時の基準:\n「${a["company.case"]}」`);
  }

  // Domain-specific Contextual Action Directives
  parts.push("\n【文脈・リッチメニュー操作時の追客規範】");
  parts.push("・「エンジンとは（サービス概要・LP）」タップ後の追客:");
  parts.push("  顧客はLP（サービス概要）を閲覧した直後で、自分に合うか検討中の状態です。");
  parts.push("  『先ほどは「エンジンとは」をご覧いただきありがとうございます！LPはいかがでしたでしょうか？』とLP閲覧後の感想やネックを自然に尋ね、");
  parts.push("  『さらに詳しい話や個別で相談したい場合は、1on1（個別面談）もできますので、お気軽にお声がけくださいね😊』と次のステップ（1on1面談）を優しく案内する構成にしてください。");
  parts.push("・「1on1」タップ後の追客:");
  parts.push("  面談に関心がある状態です。日程調整カレンダーや候補日時の確認を親身にフォローしてください。");

  if (calib.profile?.features) {
    const f = calib.profile.features;
    if (f.averageLength) parts.push(`・文量の目安: 平均約${f.averageLength}文字（スマホ1画面で自然に読める長さ）`);
    if (f.usesEmoji) parts.push("・絵文字: 明るく親しみやすい絵文字（😊、🙇‍♂️、🙆‍♂️、✨など）を文末に自然に1〜2個活用");
    if (f.learnedAdjustment) {
      const la = f.learnedAdjustment;
      if (la.toneAdjustment === "more_restrained") {
        parts.push("・修正から学習したトーン: 感嘆符（！）を減らし、落ち着いた丁寧で親身なトーンにすること");
      } else if (la.toneAdjustment === "more_enthusiastic") {
        parts.push("・修正から学習したトーン: 明るく親しみやすい語り口で前向きに背中を押すこと");
      }
      if (la.avgLengthDelta) {
        parts.push(`・修正傾向: 担当者の修正により長さを ${la.avgLengthDelta > 0 ? "+" : ""}${la.avgLengthDelta}文字 程度調整する傾向があります`);
      }
    }
  }

  // Layer 3: Context-Matched Few-Shot Revisions (該当場面に適合した人間の修正お手本)
  if (calib.recentRevisions?.length > 0) {
    const currentCategory = calib.targetCategory || (targetContext ? detectContextCategory(targetContext.trigger, targetContext.reason) : null);
    parts.push("\n【担当者による送信修正の学習履歴（文脈に応じたAI下書きと人間の改善例）】");
    parts.push("AIが過去に提案した文面を担当者が直して承認しました。顧客の状況・文脈（LP閲覧後、リッチメニュー操作後、面談後など）に応じた修正傾向（文脈の汲み取り、言い回しの自然さ、余計な敬語の削減、親しみやすさの付加など）を学習し、最新の希望・事実を優先し、表現だけ参考にしてください：");
    for (let i = 0; i < Math.min(calib.recentRevisions.length, 5); i++) {
      const rev = calib.recentRevisions[i];
      const isCategoryMatch = currentCategory && rev.category === currentCategory;
      parts.push(`[修正例 ${i + 1}${rev.trigger ? `（状況: ${rev.trigger}）` : ""}${isCategoryMatch ? " ★現在の場面と一致" : ""}]`);
      if (rev.reason) parts.push(`・背景・文脈: ${rev.reason}`);
      parts.push(`・修正前(AI案): 「${rev.original}」`);
      parts.push(`・修正後(理想): 「${rev.final}」`);
    }
  }

  return parts.join("\n");
}

export function registerStyle(app: Hono<AppEnv>) {
  // Get current style configuration
  app.get("/api/tenants/:tenantId/accounts/:oaId/style", async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      oaId = c.req.param("oaId"),
      actor = c.get("principal").user.id;
    await accountFor(rt, tenant, oaId);

    const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
    const profile = await one(
      ts,
      "SELECT * FROM style_profiles WHERE user_id=?",
      [actor],
    );

    return c.json({
      questions: standardQuestions,
      answers: profile ? parse(profile.answers, {}) : {},
      features: profile ? parse(profile.features, {}) : {},
      state: profile?.state || "draft",
      version: profile?.version || 1,
    });
  });

  // Save questionnaire answers
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/style/questionnaire",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenant, oaId);

      const b = z
        .object({
          formality: z.enum(["polite", "casual", "formal"]),
          emoji: z.enum(["minimal", "frequent", "none"]),
          length: z.enum(["short", "medium", "detailed"]),
          closingCta: z.enum(["soft", "meeting", "resource"]),
          customNotes: z.string().max(1000).optional(),
        })
        .strict()
        .parse(await c.req.json());

      const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
      const existing = await one(
        ts,
        "SELECT * FROM style_profiles WHERE user_id=?",
        [actor],
      );

      const currentFeatures = parse(existing?.features, {});
      await ts.query(
        "INSERT INTO style_profiles(user_id,answers,features,state,version,updated_at) VALUES (?,?,?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET answers=excluded.answers,state='active',version=style_profiles.version+1,updated_at=excluded.updated_at",
        [actor, json(b), json(currentFeatures), "active", now()],
      );

      await audit(rt.db, actor, "style.questionnaire_saved", oaId, tenant);

      return c.json({ ok: true, state: "active" });
    },
  );

  // Upload TXT sample messages and extract stylistic features
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/style/samples",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenant, oaId);

      const b = z
        .object({
          sampleTexts: z
            .array(z.string().min(5).max(3000))
            .min(1)
            .max(20),
        })
        .strict()
        .parse(await c.req.json());

      const extracted = extractTextFeatures(b.sampleTexts);
      const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
      const existing = await one(
        ts,
        "SELECT * FROM style_profiles WHERE user_id=?",
        [actor],
      );

      const currentAnswers = parse(existing?.answers, {});
      const mergedFeatures = {
        ...parse(existing?.features, {}),
        ...extracted,
      };

      await ts.query(
        "INSERT INTO style_profiles(user_id,answers,features,state,version,updated_at) VALUES (?,?,?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET features=excluded.features,state='active',version=style_profiles.version+1,updated_at=excluded.updated_at",
        [actor, json(currentAnswers), json(mergedFeatures), "active", now()],
      );

      await audit(rt.db, actor, "style.samples_calibrated", oaId, tenant, {
        samplesCount: b.sampleTexts.length,
      });

      return c.json({ ok: true, features: mergedFeatures });
    },
  );

  // Reset style profile to default
  app.post("/api/tenants/:tenantId/accounts/:oaId/style/reset", async (c) => {
    const rt = c.env.runtime,
      tenant = c.req.param("tenantId"),
      oaId = c.req.param("oaId"),
      actor = c.get("principal").user.id;
    await accountFor(rt, tenant, oaId);

    const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
    await ts.query(
      "UPDATE style_profiles SET answers='{}',features='{}',state='draft',version=version+1,updated_at=? WHERE user_id=?",
      [now(), actor],
    );

    await audit(rt.db, actor, "style.reset", oaId, tenant);

    return c.json({ ok: true, state: "draft" });
  });
}
