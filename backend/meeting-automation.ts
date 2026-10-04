import type { Runtime } from "./runtime.ts";
import { all, one, now, json, parse, type Row } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { member, customerAccess } from "./access.ts";
import { readMeetingText } from "./drive.ts";
import { extractMeetingInsights } from "./meet-analysis.ts";
import { meetingAutoDDL } from "./meeting-auto-schema.ts";
import { claimBudget, automationSettings } from "./assistant-controls.ts";
import { businessProfile } from "./business.ts";
import { holdCustomer } from "./sales.ts";

// 一度人が紐付けた顧客コードだけ再利用する。氏名の類似度で自動割当しない。
export function meetingAlias(title: string) {
  return (
    title
      .normalize("NFKC")
      .match(/(?:^|[_\s【\[])(P\d{2,8})(?=様|さん|[_\s】\]]|$)/i)?.[1]
      .toUpperCase() || null
  );
}
export async function rememberMeetingBinding(
  rt: Runtime,
  t: string,
  oa: string,
  doc: Row,
  actor: string,
  enabled = true,
) {
  const db = await rt.openDatabase(t, oa, "tsunagu");
  for (const sql of meetingAutoDDL) await db.query(sql);
  await db.query(
    `INSERT INTO meeting_auto_bindings(file_id,customer_id,actor_id,alias,enabled,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET customer_id=excluded.customer_id,actor_id=excluded.actor_id,alias=excluded.alias,enabled=excluded.enabled,updated_at=excluded.updated_at`,
    [
      doc.id,
      doc.customer_id,
      actor,
      meetingAlias(doc.title),
      Number(enabled),
      now(),
    ],
  );
  await db.query(
    "UPDATE meeting_auto_state SET state='retry',next_at='' WHERE state='needs_link'",
  );
}
export async function queueConfirmedMeeting(
  rt: Runtime,
  t: string,
  oa: string,
  fileId: string,
  heldAt: string,
) {
  const db = await rt.openDatabase(t, oa, "tsunagu");
  const doc = await one(
    db,
    "SELECT d.* FROM meeting_inbox d JOIN meeting_auto_bindings b ON b.file_id=d.id WHERE d.id=? AND b.enabled=1 AND d.state='linked'",
    [fileId],
  );
  if (!doc || !heldAt) return;
  await db.query(
    "INSERT INTO meeting_auto_state(file_id,modified_at,state,detail,updated_at) VALUES (?,?,'retry','確認した議事録から希望条件と提案候補を反映します。',?) ON CONFLICT(file_id) DO UPDATE SET state='retry',next_at='',detail=excluded.detail,updated_at=excluded.updated_at",
    [fileId, doc.modified_at, now()],
  );
  await db.query(
    "UPDATE meeting_inbox SET held_at=?,analysis=NULL WHERE id=? AND state='linked' AND version=?",
    [heldAt, fileId, doc.version],
  );
}
export async function invalidateMeetingSource(
  rt: Runtime,
  t: string,
  oa: string,
  doc: Row,
) {
  if (!doc.customer_id) return;
  const db = await rt.openDatabase(t, oa, "tsunagu");
  await db.query(
    "UPDATE context_notes SET deleted_at=? WHERE customer_id=? AND source='google_drive' AND (source_ref=? OR source_ref LIKE ?) AND deleted_at IS NULL",
    [now(), doc.customer_id, doc.id, `${doc.id}:%`],
  );
  await holdCustomer(
    rt,
    t,
    doc.customer_id,
    "議事録の原文が更新されました。最新の内容へ自動更新しています。",
  );
}
const dateInTitle = (s: string) => {
  const m = s.match(/(20\d{2})[-/](\d{2})[-/](\d{2})/);
  return m
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`).toISOString()
    : null;
};
const normalize = (s: string) => s.normalize("NFKC").replace(/[\s,]/g, "");
const quotedTag = (quote: string, tag: string) => {
  const q = normalize(quote),
    t = normalize(tag).replace(/^駅徒歩/, "徒歩");
  if (q.includes(t)) return true;
  const walking = t.match(/^徒歩(\d+)分以内$/);
  // 箇条書きの「駅徒歩分数：…許容範囲は『15分以内』」も同じ根拠。
  return (
    !!walking && /駅徒歩|徒歩分数/.test(q) && q.includes(`${walking[1]}分以内`)
  );
};
const numbers = (s: string) =>
  (normalize(s).match(/\d+(?:\.\d+)?(?:万|億)?/g) || []).map(
    (x) =>
      Number(x.replace(/[万億]$/, "")) *
      (x.endsWith("万") ? 10000 : x.endsWith("億") ? 100000000 : 1),
  );
export function checkedMeetingTracking(tracking: any, transcript: string) {
  requireThat(
    tracking &&
      normalize(transcript).includes(normalize(tracking.conditionQuote)),
    422,
    "MEETING_EVIDENCE",
    "現在の条件を示す原文を確認できません。",
  );
  requireThat(
    tracking.terms.every((t: string) =>
      normalize(tracking.conditionQuote).includes(normalize(t)),
    ),
    422,
    "MEETING_TERMS",
    "条件の語句が原文と一致しません。",
  );
  const w = tracking.propertyWish;
  if (w) {
    requireThat(
      normalize(transcript).includes(normalize(w.quote)) &&
        (w.area === null || normalize(w.quote).includes(normalize(w.area))) &&
        (w.maxPrice === null || numbers(w.quote).includes(w.maxPrice)) &&
        [...w.required, ...w.excluded].every((t: string) =>
          quotedTag(w.quote, t),
        ),
      422,
      "MEETING_WISH",
      "希望条件の数値・語句の根拠を確認できません。",
    );
  }
  return tracking;
}
// 自動の再連絡は、原文で日付または日数まで確認できた約束に限定する。
export function mergeMeetingWish(w: Row, previous: Row | null) {
  const category = (tag: string) =>
    /^\d+s?[ldkr]+$/i.test(normalize(tag))
      ? "layout"
      : /借地権|所有権/.test(tag)
        ? "tenure"
        : /徒歩\d+分以内/.test(tag)
          ? "walk"
          : normalize(tag);
  const changed = new Set([...w.required, ...w.excluded].map(category));
  return {
    area: w.area ?? previous?.area ?? null,
    maxPrice: w.maxPrice ?? previous?.maxPrice ?? null,
    required: [
      ...(previous?.required || []).filter(
        (x: string) => !changed.has(category(x)),
      ),
      ...w.required,
    ],
    excluded: [
      ...(previous?.excluded || []).filter(
        (x: string) => !changed.has(category(x)),
      ),
      ...w.excluded,
    ],
  };
}
export function groundedMeetingTimings(
  tracking: any,
  transcript: string,
  heldAt: string,
) {
  const day = 86400000,
    heldDay = new Date(Date.parse(heldAt) + 9 * 3600000)
      .toISOString()
      .slice(0, 10);
  return (tracking.timings || []).flatMap((v: any) => {
    if (!transcript.includes(v.quote)) return [];
    const quote = normalize(v.quote),
      relative = quote.match(/(\d{1,2})日後/),
      absolute = quote.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
    const due = absolute
      ? Date.parse(
          `${absolute[1]}-${absolute[2].padStart(2, "0")}-${absolute[3].padStart(2, "0")}T00:00:00+09:00`,
        )
      : Date.parse(`${heldDay}T00:00:00+09:00`) +
        (relative ? Number(relative[1]) : /来週/.test(quote) ? 7 : NaN) * day;
    const days = Math.round(
      (due - Date.parse(`${heldDay}T00:00:00+09:00`)) / day,
    );
    return Number.isFinite(due) &&
      days === v.daysAfter &&
      days >= 1 &&
      days <= 60
      ? [{ ...v, scheduledAt: new Date(due).toISOString() }]
      : [];
  });
}
export async function processMeetingUpdates(
  rt: Runtime,
  t: string,
  oa: string,
) {
  if (rt.driveManualOnly || !rt.ai?.apiKey) return { processed: 0 };
  const db = await rt.openDatabase(t, oa, "tsunagu"),
    common = await rt.openDatabase(t, "", "common");
  for (const sql of meetingAutoDDL) await db.query(sql);
  if (!(await automationSettings(db)).autoDraft) return { processed: 0 };
  // Worker中断後の解析中表示を解消。課金済みか不明な実行を際限なく繰り返さない。
  await db.query(
    "UPDATE meeting_inbox SET state='error',lease_until=NULL WHERE state='analyzing' AND lease_until<? AND id IN (SELECT file_id FROM meeting_auto_state WHERE state='processing')",
    [now()],
  );
  await db.query(
    "UPDATE meeting_auto_state SET state=CASE WHEN attempts<3 THEN 'retry' ELSE 'needs_review' END,detail='解析の中断を検知しました。',next_at=? WHERE state='processing' AND file_id IN (SELECT id FROM meeting_inbox WHERE state='error')",
    [new Date(Date.now() + 300000).toISOString()],
  );
  const connections = await all(
    rt.db,
    "SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service LIKE 'google_drive:%' AND state IN ('connected','syncing')",
    [t, oa],
  );
  let processed = 0;
  for (const con of connections) {
    const actor = parse(con.config).actor;
    const membership = await member(rt, actor, t),
      tenant = await one(rt.db, "SELECT settings FROM tenants WHERE id=?", [t]);
    const prior = await all(
      db,
      "SELECT * FROM meeting_inbox WHERE connection_id=? AND confirmed_by IS NOT NULL AND customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meeting_auto_bindings b WHERE b.file_id=meeting_inbox.id)",
      [con.id],
    );
    for (const d of prior) await rememberMeetingBinding(rt, t, oa, d, actor);
    const docs = await all(
      db,
      `SELECT d.*,s.state AS auto_state FROM meeting_inbox d LEFT JOIN meeting_auto_state s ON s.file_id=d.id WHERE d.connection_id=? AND d.state NOT IN ('ignored','missing','applying','analyzing') AND (s.file_id IS NULL OR s.modified_at<>d.modified_at OR (s.state='retry' AND s.next_at<=?)) ORDER BY d.modified_at DESC LIMIT 20`,
      [con.id, now()],
    );
    for (const doc of docs) {
      const mark = async (state: string, detail: string) =>
        db.query(
          `INSERT INTO meeting_auto_state(file_id,modified_at,state,detail,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET attempts=CASE WHEN modified_at=excluded.modified_at THEN attempts ELSE 0 END,modified_at=excluded.modified_at,state=excluded.state,detail=excluded.detail,updated_at=excluded.updated_at`,
          [doc.id, doc.modified_at, state, detail, now()],
        );
      // 開通前の確定済み履歴を一括で再課金しない。
      if (doc.state === "linked" && doc.auto_state !== "retry") {
        await mark("current", "取込済み。次の原文更新を自動で確認します。");
        continue;
      }
      let binding = await one(
        db,
        "SELECT * FROM meeting_auto_bindings WHERE file_id=?",
        [doc.id],
      );
      if (!binding && meetingAlias(doc.title)) {
        const aliases = await all(
          db,
          "SELECT DISTINCT b.customer_id,b.actor_id FROM meeting_auto_bindings b JOIN meeting_inbox d ON d.id=b.file_id WHERE d.connection_id=? AND b.alias=? AND b.enabled=1 AND b.actor_id=?",
          [con.id, meetingAlias(doc.title), actor],
        );
        if (aliases.length === 1) binding = aliases[0];
      }
      if (!binding || binding.enabled === 0) {
        await mark(
          "needs_link",
          "この議事録のお客様を一度だけ確認してください。",
        );
        continue;
      }
      const customer = await one(
        common,
        "SELECT c.*,l.line_user_id FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE l.oa_id=? AND c.id=? AND l.state='confirmed'",
        [oa, binding.customer_id],
      );
      if (
        !customer ||
        !customerAccess(
          membership,
          customer,
          "edit",
          parse(tenant?.settings),
        ) ||
        binding.actor_id !== actor
      ) {
        await mark("needs_link", "お客様の担当・割当を確認してください。");
        continue;
      }
      const heldAt = doc.held_at || dateInTitle(doc.title);
      if (!heldAt || Date.parse(heldAt) > Date.now()) {
        await mark("needs_link", "実施済みの会議日時を確認してください。");
        continue;
      }
      const lease = await db.query(
        "UPDATE meeting_inbox SET state='analyzing',customer_id=?,held_at=?,lease_until=? WHERE id=? AND version=? AND state IN ('unlinked','draft','error','linked')",
        [
          customer.id,
          heldAt,
          new Date(Date.now() + 120000).toISOString(),
          doc.id,
          doc.version,
        ],
      );
      if (!lease.changes) continue;
      await mark("processing", "原文を解析しています。");
      await holdCustomer(
        rt,
        t,
        customer.id,
        "新しい議事録を反映しています。解析が完了するまで以前の条件による提案を保留します。",
      );
      try {
        const transcript = await readMeetingText(rt, con, doc),
          textHash = await digest(transcript);
        const old = await one(
          db,
          "SELECT * FROM meeting_auto_state WHERE file_id=?",
          [doc.id],
        );
        if (old?.text_hash === textHash && old.note_id) {
          await db.batch([
            {
              sql: "UPDATE meeting_inbox SET state='linked',lease_until=NULL WHERE id=? AND version=?",
              params: [doc.id, doc.version],
            },
            {
              sql: "UPDATE context_notes SET deleted_at=NULL WHERE id=?",
              params: [old.note_id],
            },
          ]);
          await mark("current", "本文は同じため再解析していません。");
          continue;
        }
        const cached = parse(doc.analysis),
          hasCached = !!cached.tracking;
        if (!hasCached && !(await claimBudget(db, "ai"))) {
          await mark("retry", "本日のAI利用枠に達しました。翌日に再開します。");
          await db.query(
            "UPDATE meeting_auto_state SET next_at=? WHERE file_id=?",
            [new Date(Date.now() + 86400000).toISOString(), doc.id],
          );
          await db.query(
            "UPDATE meeting_inbox SET state='unlinked',lease_until=NULL WHERE id=? AND version=?",
            [doc.id, doc.version],
          );
          return { processed };
        }
        if (!hasCached)
          await db.query(
            "UPDATE meeting_auto_state SET attempts=attempts+1 WHERE file_id=?",
            [doc.id],
          );
        const result = hasCached
          ? cached
          : await extractMeetingInsights(rt, t, oa, actor, {
              customerName: customer.name,
              title: doc.title,
              heldAt,
              transcript,
              automated: true,
            });
        // 失敗した抽出結果も残し、根拠を確認できるようにする。
        await db.query(
          "UPDATE meeting_inbox SET analysis=? WHERE id=? AND version=? AND state='analyzing'",
          [json(result), doc.id, doc.version],
        );
        const tracking = checkedMeetingTracking(result.tracking, transcript);
        // 読取と解析の間に変わった版を確定しない。
        await readMeetingText(rt, con, doc);
        const latest = await one(db, "SELECT * FROM meeting_inbox WHERE id=?", [
          doc.id,
        ]);
        requireThat(
          latest?.version === doc.version && latest.state === "analyzing",
          409,
          "DOCUMENT_CHANGED",
          "解析中に原文が変わりました。",
        );
        const noteId = `drive:${oa}:${doc.id}`,
          at = now();
        const body = [
          `【${doc.title}／連携原文から自動更新】`,
          result.summary,
          `要点：${result.keyPoints.join(" / ")}`,
          `懸念：${result.concerns.join(" / ")}`,
          `関心：${result.interests.join(" / ")}`,
          `次のアクション：${result.nextAction}`,
          `条件の原文：${tracking.conditionQuote}`,
          ...(tracking.propertyWish
            ? [`希望条件の原文：${tracking.propertyWish.quote}`]
            : []),
        ].join("\n");
        await holdCustomer(
          rt,
          t,
          customer.id,
          "議事録の更新を反映し、最新の根拠から提案を作り直します。",
        );
        const superseded = await all(
          db,
          "SELECT id FROM context_notes WHERE customer_id=? AND source='google_drive' AND (source_ref=? OR source_ref LIKE ?)",
          [customer.id, doc.id, `${doc.id}:%`],
        );
        const h = await rt.openDatabase(t, oa, "harness");
        await h.query(
          "UPDATE events SET state='cancelled' WHERE customer_id=? AND type='meeting.trigger' AND state='pending' AND json_extract(payload,'$.noteId') IN (SELECT value FROM json_each(?))",
          [customer.id, json(superseded.map((n) => n.id))],
        );
        await db.batch([
          {
            sql: "UPDATE context_notes SET deleted_at=? WHERE customer_id=? AND source='google_drive' AND (source_ref=? OR source_ref LIKE ?) AND id<>?",
            params: [at, customer.id, doc.id, `${doc.id}:%`, noteId],
          },
          {
            sql: "INSERT INTO context_notes(id,customer_id,source,source_ref,body,confirmed_by,confirmed_at,created_at) VALUES (?,?,'google_drive',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,deleted_at=NULL",
            params: [
              noteId,
              customer.id,
              doc.id,
              body,
              `auto:${actor}`,
              at,
              at,
            ],
          },
        ]);
        const note = (await one(
          db,
          "SELECT id,customer_id,body,confirmed_by,confirmed_at,source,source_ref FROM context_notes WHERE id=?",
          [noteId],
        ))!;
        const profile = await one(
            db,
            "SELECT * FROM followup_profiles WHERE customer_id=?",
            [customer.id],
          ),
          business = await businessProfile(rt, t);
        const newer = await one(
          db,
          "SELECT id FROM meeting_inbox WHERE customer_id=? AND id<>? AND state='linked' AND julianday(held_at)>julianday(?) LIMIT 1",
          [customer.id, doc.id, heldAt],
        );
        if (!newer) {
          const data = {
            industry: business.industry || "general",
            enabled: true,
            stalledQuote: "",
            jobWishQuote: "",
            jobChangeTimingQuote: "",
            promiseQuote: "",
            promiseAt: null,
            phase: "considering",
            waitDays: 3,
            hypothesis: "",
            ...parse(profile?.data),
            conditionQuote: tracking.conditionQuote,
            terms: tracking.terms,
          };
          // 古い原文の約束を新しい議事録に移し替えない。
          data.stalledQuote = "";
          data.promiseQuote = "";
          data.promiseAt = null;
          await db.query(
            `INSERT INTO followup_profiles(customer_id,owner_user_id,line_user_id,data,evidence,confirmed_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET data=excluded.data,evidence=excluded.evidence,version=version+1,confirmed_by=excluded.confirmed_by,updated_at=excluded.updated_at`,
            [
              customer.id,
              customer.owner_user_id,
              customer.line_user_id,
              json(data),
              json({
                kind: "note",
                id: noteId,
                body: note.body,
                hash: await digest(json(note)),
              }),
              `auto:${actor}`,
              at,
            ],
          );
          if (tracking.propertyWish) {
            const previous = await one(
              db,
              "SELECT * FROM assistant_preferences WHERE customer_id=?",
              [customer.id],
            );
            const previousNote =
              previous?.note_id !== noteId
                ? await one(
                    db,
                    "SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",
                    [previous?.note_id || "", customer.id],
                  )
                : null;
            const prior = previousNote ? parse(previous?.data) : null;
            const inheritedNotes = previousNote
              ? [
                  ...(prior?.inheritedNotes || []),
                  {
                    id: previousNote.id,
                    hash: await digest(json(previousNote)),
                  },
                ]
              : [];
            let validPrior = true;
            for (const ref of inheritedNotes) {
              const n = await one(
                db,
                "SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL",
                [ref.id, customer.id],
              );
              if (!n || (await digest(json(n))) !== ref.hash)
                validPrior = false;
            }
            const wish = mergeMeetingWish(
              tracking.propertyWish,
              validPrior ? prior : null,
            );
            requireThat(
              wish.area && wish.maxPrice,
              422,
              "MEETING_WISH",
              "エリアまたは予算の根拠が不足しています。希望条件を確認してください。",
            );
            await db.query(
              `INSERT INTO assistant_preferences(customer_id,note_id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET note_id=excluded.note_id,data=excluded.data,version=version+1,updated_at=excluded.updated_at`,
              [
                customer.id,
                noteId,
                json({
                  ...wish,
                  inheritedNotes: validPrior ? inheritedNotes : [],
                }),
                at,
              ],
            );
          } else {
            // 元の条件が変わったとき、以前の予算を無条件に残さない。
            await db.query(
              "DELETE FROM assistant_preferences WHERE customer_id=? AND note_id IN (SELECT value FROM json_each(?))",
              [customer.id, json([noteId, ...superseded.map((n) => n.id)])],
            );
          }
          for (const [index, timing] of groundedMeetingTimings(
            tracking,
            transcript,
            heldAt,
          ).entries()) {
            await h.query(
              "INSERT OR IGNORE INTO events(id,customer_id,type,payload,occurred_at,state) VALUES (?,?,'meeting.trigger',?,?,'pending')",
              [
                `${noteId}:${doc.modified_at}:auto:${index}`,
                customer.id,
                json({
                  intent: timing.intent,
                  quote: timing.quote,
                  scheduledAt: timing.scheduledAt,
                  noteId,
                  source: "google_drive_auto",
                }),
                at,
              ],
            );
          }
        }
        await db.query(
          "UPDATE meeting_inbox SET state='linked',analysis=?,held_at=?,customer_id=?,confirmed_by=?,confirmed_at=?,lease_until=NULL,version=version+1 WHERE id=? AND version=?",
          [
            json(result),
            heldAt,
            customer.id,
            `auto:${actor}`,
            at,
            doc.id,
            doc.version,
          ],
        );
        await rememberMeetingBinding(
          rt,
          t,
          oa,
          { ...doc, customer_id: customer.id },
          actor,
        );
        await mark(
          "current",
          newer
            ? "議事録を更新しました。希望条件は、より新しい面談の内容を維持しています。"
            : "原文の更新を解析し、お客様の文脈と提案候補へ反映しました。",
        );
        await db.query(
          "UPDATE meeting_auto_state SET text_hash=?,note_id=? WHERE file_id=?",
          [textHash, noteId, doc.id],
        );
        processed++;
        return { processed }; // 1巡回1件。新しい版だけ、日次の文案予算を共有。
      } catch (e: any) {
        await db.query(
          "UPDATE meeting_inbox SET state='error',lease_until=NULL WHERE id=? AND version=? AND state='analyzing'",
          [doc.id, doc.version],
        );
        await mark(
          "needs_review",
          e.code === "MEETING_EVIDENCE" ||
            e.code === "MEETING_WISH" ||
            e.code === "MEETING_TERMS"
            ? e.message
            : "原文または解析結果の確認が必要です。",
        );
        return { processed, review: 1 };
      }
    }
  }
  return { processed };
}
