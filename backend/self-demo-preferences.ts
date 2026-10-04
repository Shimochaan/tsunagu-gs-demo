import type { Runtime } from "./runtime.ts";
import { all, one, now, json, parse, type Database, type Row } from "./db.ts";
import { digest, requireThat } from "./security.ts";
import { mergeMeetingWish, meetingWishChanges } from "./meeting-automation.ts";

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

/** Pending or ambiguous current meetings also gate approval, not just discovery. */
export async function pendingDemoMeetings(rt: Runtime, tenant: string, oa: string, customers: string[]) {
  const pending = new Set<string>();
  if (rt.selfDemo?.tenant !== tenant || rt.selfDemo.oa !== oa || !customers.length) return pending;
  const docs = await all(rt.db,
    "SELECT d.*,p.customer_id FROM gs_demo_documents d JOIN gs_demo_participants p ON p.user_id=d.user_id WHERE p.tenant_id=? AND p.customer_id IN (SELECT value FROM json_each(?)) AND (d.state IN ('queued','processing') OR (d.state='error' AND COALESCE(json_extract(d.analysis,'$.extraction.tracking.reviewReason'),'')<>''))",
    [tenant, json(customers)]);
  const db = await rt.openDatabase(tenant, oa, "tsunagu");
  for (const d of docs) {
    if (d.state !== "error") { pending.add(d.customer_id); continue; }
    const pref = await one(db, "SELECT * FROM assistant_preferences WHERE customer_id=?", [d.customer_id]);
    const note = pref ? await one(db, "SELECT * FROM context_notes WHERE id=?", [pref.note_id]) : null;
    const latest = await noteDate(rt, db, note, parse(pref?.data));
    if (!latest || Date.parse(d.held_at) >= Date.parse(latest)) pending.add(d.customer_id);
  }
  return pending;
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
    const changes = meetingWishChanges(input!, validPrior ? data : null, wish!);
    const inherited = validPrior && changes.some(c => c.mode === "inherited") ? refs : [];
    const saved = await db.query(
      "INSERT INTO assistant_preferences(customer_id,note_id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET note_id=excluded.note_id,data=excluded.data,version=version+1,updated_at=excluded.updated_at WHERE assistant_preferences.version=? AND assistant_preferences.note_id=?",
      [customer, noteId, json({ ...wish, inheritedNotes: inherited, meetingHeldAt: doc.held_at, changes }), now(), previous?.version || 0, previous?.note_id || ""]);
    if (saved.changes) return { applied: true, wish, changes, reason: null };
  }
  requireThat(false, 409, "DEMO_WISH_CHANGED", "別の議事録も解析中です。少し待ってから解析をやり直してください。");
  throw new Error("unreachable");
}
