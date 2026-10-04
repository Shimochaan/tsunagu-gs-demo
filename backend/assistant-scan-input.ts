import { type Database, type Row, json } from "./db.ts";
/** Read-only snapshot for one detection chunk. Never used for approval or delivery. */
export async function scanInputs(
  platform: Database,
  common: Database,
  harness: Database,
  ts: Database,
  tenant: string,
  oa: string,
  customers: Row[],
  actor?: string,
  withSources = true,
) {
  const ids = json(customers.map((c) => c.id)),
    users = json([...new Set(customers.map((c) => actor || c.owner_user_id))]);
  const [auth, links, history, content] = await Promise.all([
    platform.batch([
      {
        sql: "SELECT * FROM memberships WHERE tenant_id=? AND state='active' AND user_id IN (SELECT value FROM json_each(?))",
        params: [tenant, users],
      },
      {
        sql: "SELECT * FROM accounts WHERE tenant_id=? AND id=?",
        params: [tenant, oa],
      },
    ]),
    common.query(
      "SELECT * FROM customer_links WHERE oa_id=? AND state='confirmed' AND customer_id IN (SELECT value FROM json_each(?))",
      [oa, ids],
    ),
    harness.query(
      "SELECT id,direction,body,kind,line_user_id,occurred_at,recorded_at,customer_id FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY occurred_at DESC,id DESC) AS row_num FROM messages WHERE customer_id IN (SELECT value FROM json_each(?))) WHERE row_num<=30 ORDER BY customer_id,occurred_at DESC,id DESC",
      [ids],
    ),
    ts.batch([
      {
        sql: "SELECT p.*,a.expires_at,a.snoozed_until FROM proposals p JOIN assistant_proposals a ON a.proposal_id=p.id WHERE p.customer_id IN (SELECT value FROM json_each(?)) AND p.state IN ('pending','approved','held')",
        params: [ids],
      },
      {
        sql: "SELECT * FROM followup_profiles WHERE customer_id IN (SELECT value FROM json_each(?))",
        params: [ids],
      },
      ...(withSources
        ? [
            {
              sql: "SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS row_num FROM context_notes WHERE customer_id IN (SELECT value FROM json_each(?)) AND confirmed_by IS NOT NULL AND deleted_at IS NULL) WHERE row_num<=30 ORDER BY customer_id,created_at DESC",
              params: [ids],
            },
            {
              sql: "SELECT * FROM assistant_preferences WHERE customer_id IN (SELECT value FROM json_each(?))",
              params: [ids],
            },
          ]
        : []),
    ]),
  ]);
  const group = (rows: Row[]) => {
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const rows = map.get(r.customer_id) || [];
      rows.push(r);
      map.set(r.customer_id, rows);
    }
    return map;
  };
  const messages = group(history.rows),
    notes = group(content[2]?.rows || []);
  for (const rows of messages.values())
    for (const r of rows) delete r.customer_id;
  for (const rows of notes.values()) for (const r of rows) delete r.row_num;
  return {
    members: new Map(auth[0].rows.map((m) => [m.user_id, m])),
    account: auth[1].rows[0],
    links: group(links.rows),
    messages,
    previous: group(content[0].rows),
    profiles: new Map(content[1].rows.map((p) => [p.customer_id, p])),
    notes,
    preferences: new Map(
      (content[3]?.rows || []).map((p) => [p.customer_id, p]),
    ),
  };
}
