import { scanAssistant } from "./assistant.ts";
import { notifyAssistant } from "./assistant-notifications.ts";
import { businessProfile } from "./business.ts";
import { usageCost } from "./brain.ts";
import { queueProposalNotice } from "./notify.ts";
import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { accountFor } from "./access.ts";
import { audit, requireThat } from "./security.ts";
import { getAccountCalibrationProfile, buildStylePrompt } from "./style.ts";

export interface CandidateOpportunity {
  customerId: string;
  customerName: string;
  triggerId?: string;
  triggerType: "meeting_trigger" | "tap_response" | "post_meeting_followup" | "context_update" | "inactivity_cadence";
  trigger: string;
  priority: number;
  lastInteractionAt: string;
  evidence: string;
}

export async function discoverCandidates(
  rt: Runtime,
  tenantId: string,
  oaId: string,
  options: {
    cadenceDays?: number;
    maxCandidates?: number;
  } = {},
): Promise<CandidateOpportunity[]> {
  const cadenceDays = options.cadenceDays !== undefined ? options.cadenceDays : 1;
  const maxCandidates = options.maxCandidates || 20;

  const common = await rt.openDatabase(tenantId, "", "common");
  const h = await rt.openDatabase(tenantId, oaId, "harness");
  const ts = await rt.openDatabase(tenantId, oaId, "tsunagu");

  // 1. Get eligible customers for this OA
  const customers = await all(
    common,
    "SELECT c.* FROM customers c JOIN customer_links cl ON cl.customer_id=c.id WHERE cl.oa_id=? AND cl.state='confirmed' AND c.mode='ai' AND c.opt_out=0 AND c.stage NOT IN ('won','lost','booked','result_pending','stopped')",
    [oaId],
  );

  const candidates: CandidateOpportunity[] = [];
  const cooldownCutoff = new Date(Date.now() - 24 * 3600_000).toISOString();

  for (const cust of customers) {
    // Check existing proposals: skip if customer already has a pending, approved, or recent proposal
    const recentProposal = await one(
      ts,
      "SELECT id, state, created_at FROM proposals WHERE customer_id=? AND (state IN ('pending','approved','sending') OR created_at > ?) LIMIT 1",
      [cust.id, cooldownCutoff],
    );
    if (recentProposal) continue;

    const due = await one(h,"SELECT * FROM events WHERE customer_id=? AND type='meeting.trigger' AND (state='pending' OR (state='generating' AND json_extract(payload,'$.leaseUntil')<?)) AND json_extract(payload,'$.scheduledAt')<=? ORDER BY json_extract(payload,'$.scheduledAt') LIMIT 1",[cust.id,now(),now()]);
    if (due) {
      const consumed=await one(ts,"SELECT p.id FROM proposals p,json_each(p.context_refs) ref WHERE ref.value=? AND p.state NOT IN ('held','rejected') LIMIT 1",[due.id]);
      if (!consumed) { const payload=parse(due.payload); candidates.push({customerId:cust.id,customerName:cust.name,triggerId:due.id,triggerType:"meeting_trigger",trigger:payload.intent,priority:110,lastInteractionAt:due.occurred_at,evidence:`議事録で確認した予定日 ${payload.scheduledAt}。次の対応：${payload.nextAction}`}); continue; }
    }

    // Trigger A: Tap / Click event or Rich Menu Keyword within 48h
    const recentClick = await one(
      h,
      "SELECT payload, occurred_at FROM events WHERE customer_id=? AND type IN ('content.clicked','click') AND occurred_at > ? ORDER BY occurred_at DESC LIMIT 1",
      [cust.id, new Date(Date.now() - 48 * 3600_000).toISOString()],
    );

    const recentInbound = await one(
      h,
      "SELECT body, occurred_at FROM messages WHERE customer_id=? AND direction='inbound' AND occurred_at > ? ORDER BY occurred_at DESC LIMIT 1",
      [cust.id, new Date(Date.now() - 48 * 3600_000).toISOString()],
    );

    const isEnjinLP =
      recentInbound?.body?.includes("エンジンとは") ||
      recentClick?.payload?.includes("enjin_startulp") ||
      recentClick?.payload?.includes("エンジンとは");

    if (isEnjinLP) {
      candidates.push({
        customerId: cust.id,
        customerName: cust.name,
        triggerType: "tap_response",
        trigger: "リッチメニュー「エンジンとは」（LP案内）確認後のフォロー",
        priority: 100,
        lastInteractionAt: recentInbound?.occurred_at || recentClick?.occurred_at || now(),
        evidence: "顧客がリッチメニューの「エンジンとは」（LPリンク）を押して詳細を確認した後、次のアクション待ちの状態",
      });
      continue;
    }

    if (recentClick) {
      let tapTitle = "配信コンテンツ・事例";
      try {
        const p = typeof recentClick.payload === "string" ? JSON.parse(recentClick.payload) : recentClick.payload;
        if (p.label || p.title) tapTitle = p.label || p.title;
      } catch {}
      candidates.push({
        customerId: cust.id,
        customerName: cust.name,
        triggerType: "tap_response",
        trigger: `${tapTitle}のタップ確認`,
        priority: 100,
        lastInteractionAt: recentClick.occurred_at,
        evidence: `直近48時間以内にLINE上のコンテンツ（${tapTitle}）をタップ`,
      });
      continue;
    }

    // Trigger B: Post-meeting followup (>24h ago, not won/lost)
    const recentMeeting = await one(
      h,
      "SELECT id, title, starts_at FROM appointments WHERE customer_id=? AND state='attended' AND starts_at < ? AND starts_at > ? LIMIT 1",
      [
        cust.id,
        new Date(Date.now() - 24 * 3600_000).toISOString(),
        new Date(Date.now() - 14 * 86400_000).toISOString(),
      ],
    );
    if (recentMeeting) {
      candidates.push({
        customerId: cust.id,
        customerName: cust.name,
        triggerType: "post_meeting_followup",
        trigger: "個別面談後の検討状況フォロー",
        priority: 80,
        lastInteractionAt: recentMeeting.starts_at,
        evidence: `面談（${recentMeeting.title}）実施から24時間以上経過`,
      });
      continue;
    }

    // Trigger C: New context notes added within 48h
    const newNote = await one(
      ts,
      "SELECT id, source, body, created_at FROM context_notes WHERE customer_id=? AND created_at > ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [cust.id, new Date(Date.now() - 48 * 3600_000).toISOString()],
    );
    if (newNote) {
      candidates.push({
        customerId: cust.id,
        customerName: cust.name,
        triggerType: "context_update",
        trigger: "連携メモ・最新情報の反映",
        priority: 60,
        lastInteractionAt: newNote.created_at,
        evidence: `外部メモ（${newNote.source}）の新規登録`,
      });
      continue;
    }

    // Trigger D: Inactivity threshold exceeded
    const lastMsg = await one(
      h,
      "SELECT occurred_at FROM messages WHERE customer_id=? ORDER BY occurred_at DESC LIMIT 1",
      [cust.id],
    );
    const lastTime = lastMsg?.occurred_at || cust.created_at;
    const lastTimestamp = Date.parse(lastTime);
    if (!isNaN(lastTimestamp) && lastTimestamp < Date.now() - cadenceDays * 86400_000) {
      candidates.push({
        customerId: cust.id,
        customerName: cust.name,
        triggerType: "inactivity_cadence",
        trigger: "前回のやり取りからの定期フォロー",
        priority: 40,
        lastInteractionAt: lastTime,
        evidence: `最終連絡から${cadenceDays}日以上経過`,
      });
    }
  }

  // Sort by priority descending
  return candidates.sort((a, b) => b.priority - a.priority || a.customerId.localeCompare(b.customerId)).slice(0, maxCandidates);
}

export function registerCadence(app: Hono<AppEnv>) {
  // Discovery endpoint: finds candidate opportunities
  app.get(
    "/api/tenants/:tenantId/accounts/:oaId/cadence/candidates",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId");
      await accountFor(rt, tenant, oaId);

      const daysParam = c.req.query("cadenceDays");
      const cadenceDays = daysParam ? parseInt(daysParam, 10) : 5;
      const candidates = await discoverCandidates(rt, tenant, oaId, {
        cadenceDays,
      });

      return c.json({
        ok: true,
        count: candidates.length,
        candidates,
      });
    },
  );

  // Run generation for discovered candidates
  app.post(
    "/api/tenants/:tenantId/accounts/:oaId/cadence/generate-all",
    async (c) => {
      const rt = c.env.runtime,
        tenant = c.req.param("tenantId"),
        oaId = c.req.param("oaId"),
        actor = c.get("principal").user.id;
      await accountFor(rt, tenant, oaId);

      const b = z
        .object({
          maxCount: z.number().int().min(1).max(20).default(10),
          cadenceDays: z.number().int().min(1).max(30).default(1),
        })
        .default({ maxCount: 10, cadenceDays: 1 })
        .parse(await c.req.json().catch(() => ({})));

      const assistantDb = await rt.openDatabase(tenant,oaId,"tsunagu");
      if ((await one(assistantDb,"SELECT enabled FROM assistant_settings WHERE id='default'"))?.enabled) {
        const result=await scanAssistant(rt,tenant,oaId,actor,undefined,undefined,{generateDraft:true});
        await notifyAssistant(rt,tenant,oaId,actor);
        await audit(rt.db,actor,"cadence.assistant.generated",oaId,tenant,{created:result.created,aiGenerated:result.aiGenerated});
        return c.json({ok:true,discovered:result.created,created:result.created,aiGenerated:result.aiGenerated,proposals:[]});
      }

      const candidates = await discoverCandidates(rt, tenant, oaId, {
        cadenceDays: b.cadenceDays,
        maxCandidates: b.maxCount,
      });

      const ts = await rt.openDatabase(tenant, oaId, "tsunagu");
      const h = await rt.openDatabase(tenant, oaId, "harness");
      const common = await rt.openDatabase(tenant, "", "common");
      const calib = await getAccountCalibrationProfile(rt, tenant, oaId);
      let created = 0;
      const createdProposals: Array<{ id: string; customerId: string; trigger: string }> = [];

      for (const cand of candidates) {
        const cust = await one(common, "SELECT * FROM customers WHERE id=?", [
          cand.customerId,
        ]);
        if (!cust) continue;

        if (cand.triggerId) {
          const claimed=await h.query("UPDATE events SET state='generating',payload=json_set(payload,'$.leaseUntil',?) WHERE id=? AND (state='pending' OR (state='generating' AND json_extract(payload,'$.leaseUntil')<?))",[new Date(Date.now()+120000).toISOString(),cand.triggerId,now()]);
          if (!claimed.changes) continue;
        }
        const propId = id();
        let draft = `${cand.customerName}様、お世話になっております。${cand.trigger}についてのご案内です。ご状況はいかがでしょうか。`;
        let reason = cand.evidence;
        let confidence: "high" | "review" = "review";

        // 作成時点の会話カーソルを固定する。生成中に新着があれば既存の送信guardで止める。
        const lastMessage = await one(h,
          "SELECT recorded_at FROM messages WHERE customer_id=? ORDER BY recorded_at DESC LIMIT 1", [cust.id]);
        const historyCursor = lastMessage?.recorded_at ?? null;
        const messages = await all(h,
          "SELECT id,direction,body,occurred_at FROM messages WHERE customer_id=? AND recorded_at<=? ORDER BY occurred_at DESC LIMIT 15", [cust.id, historyCursor]);
        const notes = await all(ts,
          "SELECT id,body,source FROM context_notes WHERE customer_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5", [cust.id]);
        const contextRefs = [...messages, ...notes].map(x => x.id);
        if (cand.triggerId) contextRefs.push(cand.triggerId);
        let state = "pending", holdReason: string | null = null;
        if (rt.ai?.apiKey && rt.ai.model) {
          // 通信失敗は課金ゼロとみなさず、トークン未取得として記録する。
          const usageId = id();
          await rt.db.query(
            "INSERT INTO usage_events(id,tenant_id,oa_id,kind,units,provider,model,state,occurred_at) VALUES (?,?,?,'generation',1,'openai',?,'processing',?)",
            [usageId, tenant, oaId, rt.ai.model, now()]);
          try {
            const baseInstructions =
              "あなたは企業の営業担当者を支援する親身なLINE営業パーソンです。過去の会話や状況に合わせて、お客様の負担にならず興味を惹く短く自然なLINEメッセージ（150〜250字程度）と、その理由を提案してください。押し売りや不自然な敬語は避け、次の一歩を気軽に返信できるようにしてください。";
            const candContext = { trigger: cand.trigger, reason: cand.evidence };
            const candStylePrompt = buildStylePrompt(calib, candContext);
            const res = await rt.externalFetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${rt.ai.apiKey}`,
                "Content-Type": "application/json",
              },
              body: json({
                model: rt.ai.model,
                store: false,
                instructions: `${baseInstructions}\n${(await businessProfile(rt,tenant)).prompt}\n${candStylePrompt || ""}`,
                input: json({
                  customerName: cust.name,
                  trigger: cand.trigger,
                  lastInteraction: cand.lastInteractionAt,
                  recentMessages: messages.reverse().map((m) => `${m.direction === "inbound" ? "お客様" : "担当者"}: ${m.body}`),
                  notes: notes.map((n) => n.body),
                  styleExamples: calib.profile?.answers || {},
                  recentRevisions: calib.recentRevisions,
                }),
                max_output_tokens: 800,
                text: {
                  format: {
                    type: "json_schema",
                    name: "cadence_proposal",
                    strict: true,
                    schema: {
                      type: "object",
                      properties: {
                        draft: { type: "string" },
                        reason: { type: "string" },
                        confidence: { type: "string", enum: ["high", "review"] },
                      },
                      required: ["draft", "reason", "confidence"],
                      additionalProperties: false,
                    },
                  },
                },
              }),
              signal: AbortSignal.timeout(12000),
            });
            requireThat(res.ok, 502, "AI_PROVIDER_FAILED", "AI候補の生成に失敗しました。");
            const data: any = await res.json();
            const cost = usageCost(data.usage, rt.ai.prices);
            await rt.db.query(
              "UPDATE usage_events SET input_tokens=?,output_tokens=?,cache_tokens=?,cost_micros=?,currency=?,unit_price_snapshot=?,state='received' WHERE id=?",
              [data.usage?.input_tokens ?? null, data.usage?.output_tokens ?? null,
                data.usage?.input_tokens_details?.cached_tokens ?? null, cost, cost == null ? null : "USD",
                rt.ai.prices ? json(rt.ai.prices) : null, usageId]);
            requireThat(data.status === "completed", 502, "AI_INCOMPLETE", "AI候補の生成が完了していません。");
            const text = data.output?.filter((o: any) => o.type === "message")
              .flatMap((o: any) => o.content ?? []).filter((o: any) => o.type === "output_text")
              .map((o: any) => o.text).join("");
            const output = z.object({ draft: z.string().trim().min(1).max(5000),
              reason: z.string().trim().min(1).max(2000), confidence: z.enum(["high", "review"]) }).parse(JSON.parse(text || "{}"));
            draft = output.draft; reason = output.reason; confidence = output.confidence;
            await rt.db.query("UPDATE usage_events SET state='completed' WHERE id=?", [usageId]);
          } catch {
            await rt.db.query("UPDATE usage_events SET state='failed' WHERE id=?", [usageId]);
            state = "held";
            holdReason = "AI生成に失敗しました。仮文面のため、再生成して内容を確認してください。";
          }
        } else if (!rt.local) {
          state = "held"; holdReason = "AI接続が未設定です。接続後に再生成してください。";
        }

        await ts.query(
          "INSERT INTO proposals(id,customer_id,trigger,reason,draft,customer_version,confidence,state,context_refs,history_cursor,hold_reason,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
          [
            propId,
            cand.customerId,
            cand.trigger,
            reason,
            draft,
            cust.version,
            confidence,
            state,
            json(contextRefs),
            historyCursor,
            holdReason,
            now(),
            now(),
          ],
        );

        if (cand.triggerId) await h.query("UPDATE events SET state=? WHERE id=?",[state === "pending" ? "processed" : "pending",cand.triggerId]);
        if (state === "pending") await queueProposalNotice(rt, tenant, oaId, {
          proposalId: propId, customerName: cand.customerName, draft,
        });
        created++;
        createdProposals.push({
          id: propId,
          customerId: cand.customerId,
          trigger: cand.trigger,
        });
      }

      await audit(rt.db, actor, "cadence.generated", oaId, tenant, {
        discovered: candidates.length,
        created,
      });

      return c.json({
        ok: true,
        discovered: candidates.length,
        created,
        proposals: createdProposals,
      });
    },
  );
}
