import type { Runtime } from "./runtime.ts";
import { one, now, json, parse, type Database, type Row } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { mergeMeetingWish } from "./meeting-automation.ts";

async function noteDate(rt: Runtime, db: Database, note: Row | null, data: Row) {
  if (data.meetingHeldAt) return data.meetingHeldAt as string;
  if (!note) return null;
  if (note.source === "self_demo") {
    return (await one(rt.db, "SELECT held_at FROM gs_demo_documents WHERE id=?", [note.source_ref]))?.held_at || null;
  }
  // Existing users may enter the demo with a preference from a Drive meeting.
  const meeting = await one(db,
    "SELECT held_at FROM meeting_inbox WHERE id=? OR ? LIKE id || ':%' ORDER BY length(id) DESC LIMIT 1",
    [note.source_ref || "", note.source_ref || ""]);
  return meeting?.held_at || null;
}

/** Apply meeting conditions in meeting order, with evidence for inherited fields.
 * CAS also covers two AI extractions completing in the opposite order.
 */
export async function applyDemoWish(
  rt: Runtime, db: Database, customer: string,
  doc: { id: string; held_at: string }, noteId: string, input: Row | null,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await one(db, "SELECT * FROM assistant_preferences WHERE customer_id=?", [customer]);
    const data = parse(previous?.data);
    const previousNote = previous ? await one(db,
      "SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",
      [previous.note_id, customer]) : null;
    const previousDate = await noteDate(rt, db, previousNote, data);
    if (previousDate && Date.parse(previousDate) > Date.parse(doc.held_at)) {
      return { applied: false, wish: input, reason: "より新しい面談の希望条件を使用しています。この議事録は履歴として保存しました。" };
    }

    // An edited document cannot inherit fields removed from its own older version.
    const refs = previousNote && previousNote.source_ref !== doc.id
      ? [...(data.inheritedNotes || []), { id: previousNote.id, hash: await digest(json(previousNote)) }]
      : [];
    let validPrior = !!previousNote && previousNote.source_ref !== doc.id;
    for (const ref of refs) {
      const note = await one(db,
        "SELECT * FROM context_notes WHERE id=? AND customer_id=? AND deleted_at IS NULL AND confirmed_by IS NOT NULL",
        [ref.id, customer]);
      if (!note || await digest(json(note)) !== ref.hash) validPrior = false;
    }
    const wish = input ? mergeMeetingWish(input, validPrior ? data : null) : null;
    requireThat(wish?.area && wish.maxPrice && wish.required?.length, 422, "DEMO_WISH_INCOMPLETE",
      "希望エリア・上限予算・間取りなどの必須条件を議事録に記入してください。変更・削除された過去の原文からは条件を引き継ぎません。");
    const saved = await db.query(
      "INSERT INTO assistant_preferences(customer_id,note_id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET note_id=excluded.note_id,data=excluded.data,version=version+1,updated_at=excluded.updated_at WHERE assistant_preferences.version=? AND assistant_preferences.note_id=?",
      [customer, noteId, json({ ...wish, inheritedNotes: validPrior ? refs : [], meetingHeldAt: doc.held_at }), now(), previous?.version || 0, previous?.note_id || ""]);
    if (saved.changes) return { applied: true, wish, reason: null };
  }
  requireThat(false, 409, "DEMO_WISH_CHANGED", "別の議事録も解析中です。少し待ってから解析をやり直してください。");
  throw new Error("unreachable");
}
