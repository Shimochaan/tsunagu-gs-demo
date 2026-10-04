import type { Runtime } from "./runtime.ts";
import { all, one, json, parse } from "./db.ts";
import { digest } from "./security.ts";
import { SHOWCASE_TENANT, SHOWCASE_OA } from "./showcase-constants.ts";
// Complete evidence from actual stored sample rows. Never relax the normal
// stale-evidence guard, and never overwrite evidence after the visitor edits it.
export async function prepareShowcaseSample(rt: Runtime) {
  const ts = await rt.openDatabase(SHOWCASE_TENANT, SHOWCASE_OA, "tsunagu");
  const meta = await one(
    ts,
    "SELECT evidence FROM assistant_proposals WHERE proposal_id='showcase-proposal'",
  );
  const evidence = parse(meta?.evidence);
  if (!meta || evidence.conversationHash) return;
  const h = await rt.openDatabase(SHOWCASE_TENANT, SHOWCASE_OA, "harness");
  const messages = await all(
    h,
    "SELECT id,direction,body,kind,line_user_id,occurred_at,recorded_at FROM messages WHERE customer_id=? ORDER BY occurred_at DESC,id DESC LIMIT 30",
    ["showcase-customer-1"],
  );
  const note = await one(
    ts,
    "SELECT * FROM context_notes WHERE id='showcase-note'",
  );
  await ts.query(
    "UPDATE assistant_proposals SET evidence=? WHERE proposal_id='showcase-proposal' AND evidence=?",
    [
      json({
        ...evidence,
        conversationHash: await digest(json(messages)),
        noteHash: await digest(json(note)),
        preferenceVersion: 1,
      }),
      meta.evidence,
    ],
  );
}
