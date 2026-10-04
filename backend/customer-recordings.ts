import { rememberMeetingBinding, queueConfirmedMeeting } from "./meeting-automation.ts";
import { z } from "zod";
import type { Hono, Context } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, id, now, json, parse, type Row } from "./db.ts";
import { customerAccess } from "./access.ts";
import { recordingAccess } from "./recording-sources.ts";
import { inboxDB, readMeetingText } from "./drive.ts";
import { extractMeetingInsights, meetingExtractSchema } from "./meet-analysis.ts";
import { requireThat, digest, audit } from "./security.ts";
import { holdCustomer } from "./sales.ts";

export const customerRecordingDDL = [
  `CREATE TABLE IF NOT EXISTS meeting_customer_reviews (id TEXT PRIMARY KEY,file_id TEXT NOT NULL,file_version INTEGER NOT NULL,modified_at TEXT NOT NULL,connection_id TEXT NOT NULL,actor_id TEXT NOT NULL,customer_id TEXT NOT NULL,customer_version INTEGER NOT NULL,title TEXT NOT NULL,transcript TEXT NOT NULL,text_hash TEXT NOT NULL,held_at TEXT,state TEXT NOT NULL DEFAULT 'preview',analysis TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,expires_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS meeting_customer_review_lookup ON meeting_customer_reviews(customer_id,actor_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS meeting_customer_imports (file_id TEXT NOT NULL,modified_at TEXT NOT NULL,customer_id TEXT NOT NULL,review_id TEXT NOT NULL,note_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(file_id,modified_at))`,
];
// Credentials belong to this actor, OA and tenant. Admin status is not permission to read somebody else's Drive.
export async function readableMeetingConnection(rt:Runtime,t:string,oa:string,actor:string,connection:string) {
  const con=await one(rt.db,"SELECT * FROM connections WHERE id=? AND tenant_id=? AND oa_id=? AND service=? AND state IN ('connected','syncing')",[connection,t,oa,`google_drive:${actor}`]);
  requireThat(con && parse(con.config).actor===actor,409,"DRIVE_NOT_CONNECTED","ご自身のGoogle Drive接続・ファイルのアクセス権を確認してください。");
  return con!;
}
export function registerCustomerRecordings(app:Hono<AppEnv>) {
  const base="/api/tenants/:tenantId/accounts/:oaId/customers/:customerId/recordings";
  const ctx=async(c:Context<AppEnv>)=>{
    const a=await recordingAccess(c),actor=c.get("principal").user.id,cid=c.req.param("customerId")!;
    const common=await a.rt.openDatabase(a.tenant,"","common"),db=await inboxDB(a.rt,a.tenant,a.oa);
    const customer=await one(common,"SELECT c.* FROM customers c JOIN customer_links l ON l.customer_id=c.id WHERE c.id=? AND l.oa_id=? AND l.state='confirmed'",[cid,a.oa]);
    requireThat(customer && customerAccess(a.m,customer,"edit",parse(c.get("tenant").settings)),404,"CUSTOMER_NOT_FOUND","この顧客の議事録を確認する権限がありません。");
    return {...a,actor,cid,customer:customer!,db};
  };
  const review=async(c:Context<AppEnv>)=>{
    const a=await ctx(c),r=await one(a.db,"SELECT * FROM meeting_customer_reviews WHERE id=? AND actor_id=? AND customer_id=?",[c.req.param("reviewId")!,a.actor,a.cid]);
    requireThat(r,404,"REVIEW_NOT_FOUND","この顧客の確認記録が見つかりません。");
    return {...a,r:r!};
  };
  const verify=async(a:Awaited<ReturnType<typeof review>>)=>{
    requireThat(a.r.expires_at>now(),409,"REVIEW_EXPIRED","原文の確認期限が切れました。ファイルを選び直してください。");
    const doc=await one(a.db,"SELECT * FROM meeting_inbox WHERE id=?",[a.r.file_id]);
    requireThat(doc && doc.modified_at===a.r.modified_at && doc.version===a.r.file_version && (!doc.customer_id || doc.customer_id===a.cid),409,"DOCUMENT_CHANGED","議事録の版または割当が変わりました。選び直してください。");
    const con=await readableMeetingConnection(a.rt,a.tenant,a.oa,a.actor,a.r.connection_id);
    const text=await readMeetingText(a.rt,con,doc!);
    requireThat(await digest(text)===a.r.text_hash,409,"DOCUMENT_CHANGED","原文が変更されました。再確認してください。");
    requireThat(a.customer.version===a.r.customer_version,409,"CUSTOMER_CHANGED","顧客情報が変更されました。割当から再確認してください。");
  };
  app.get(base,async c=>{
    const a=await ctx(c),con=await one(a.rt.db,"SELECT * FROM connections WHERE tenant_id=? AND oa_id=? AND service=?",[a.tenant,a.oa,`google_drive:${a.actor}`]);
    const connected=!!a.rt.googleOAuth && !!con && ["connected","syncing"].includes(con.state) && parse(con.config).actor===a.actor;
    const docs=connected ? await all(a.db,"SELECT * FROM meeting_inbox WHERE connection_id=? AND state NOT IN ('ignored','missing','analyzing','applying') AND (customer_id IS NULL OR customer_id=?) ORDER BY detected_at DESC LIMIT 50",[con!.id,a.cid]) : [];
    return c.json({connected,mode:a.rt.local ? "local" : "live",aiConfigured:!!a.rt.ai?.apiKey,state:con?.state || "unconfigured",documents:docs.map(d=>({id:d.id,title:d.title,version:d.version,modifiedAt:d.modified_at,heldAt:d.held_at,state:d.state,fileUrl:`https://drive.google.com/file/d/${encodeURIComponent(d.id)}/view`})),limit:50});
  });
  app.post(base+"/preview",async c=>{
    const a=await ctx(c),b=z.object({fileId:z.string(),version:z.number().int().positive()}).strict().parse(await c.req.json());
    const doc=await one(a.db,"SELECT * FROM meeting_inbox WHERE id=?",[b.fileId]);
    requireThat(doc && doc.version===b.version && !["ignored","analyzing","applying"].includes(doc.state) && (!doc.customer_id || doc.customer_id===a.cid),409,"DOCUMENT_CHANGED","ファイルの版・割当・状態を確認してください。");
    const con=await readableMeetingConnection(a.rt,a.tenant,a.oa,a.actor,doc!.connection_id),text=await readMeetingText(a.rt,con,doc!);
    const rid=id(),at=now();
    await a.db.query("INSERT INTO meeting_customer_reviews(id,file_id,file_version,modified_at,connection_id,actor_id,customer_id,customer_version,title,transcript,text_hash,held_at,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[rid,doc!.id,doc!.version,doc!.modified_at,con.id,a.actor,a.cid,a.customer.version,doc!.title,text,await digest(text),doc!.held_at,at,new Date(Date.now()+3600000).toISOString()]);
    return c.json({id:rid,version:1,title:doc!.title,transcript:text,heldAt:doc!.held_at,modifiedAt:doc!.modified_at,customerName:a.customer.name,fileUrl:`https://drive.google.com/file/d/${encodeURIComponent(doc!.id)}/view`,state:"preview"});
  });
  app.post(base+"/reviews/:reviewId/analyze",async c=>{
    const a=await review(c),b=z.object({version:z.number().int().positive(),confirmed:z.literal(true),singleCustomerConfirmed:z.literal(true),heldAt:z.iso.datetime({offset:true}),excerpt:z.string().trim().min(10).max(50000).optional()}).strict().parse(await c.req.json());
    requireThat(a.r.version===b.version && a.r.state==="preview",409,"REVIEW_CHANGED","確認記録が更新されています。原文から再確認してください。");
    requireThat(Date.parse(b.heldAt)<=Date.now(),400,"MEETING_FUTURE","実施済みの会議日時を確認してください。");
    await verify(a);
    const transcript=b.excerpt || a.r.transcript;

    requireThat(a.r.transcript.includes(transcript),400,"EXCERPT_REQUIRED","対象者の発言は原文から抜き出してください。");
    const lock=await a.db.query("UPDATE meeting_customer_reviews SET state='analyzing' WHERE id=? AND version=? AND state='preview'",[a.r.id,b.version]);
    requireThat(lock.changes===1,409,"REVIEW_BUSY","解析中です。");
    try {
      requireThat(a.rt.ai?.apiKey || a.rt.local,503,"AI_NOT_CONFIGURED","AI解析は未接続です。接続設定後に再度お試しください。");
      const extract=await extractMeetingInsights(a.rt,a.tenant,a.oa,a.actor,{customerName:a.customer.name,title:a.r.title,heldAt:b.heldAt,transcript});
      const r=await a.db.query("UPDATE meeting_customer_reviews SET state='draft',analysis=?,held_at=?,transcript=?,version=version+1 WHERE id=? AND version=? AND state='analyzing'",[json(extract),b.heldAt,transcript,a.r.id,b.version]);
      requireThat(r.changes===1,409,"REVIEW_CANCELLED","確認記録は取消されました。");
      return c.json({id:a.r.id,version:b.version+1,state:"draft",heldAt:b.heldAt,extract,mode:a.rt.ai?.apiKey ? "ai" : "source_preview"});
    } catch(e) {await a.db.query("UPDATE meeting_customer_reviews SET state='preview' WHERE id=? AND state='analyzing'",[a.r.id]);throw e;}
  });
  app.post(base+"/reviews/:reviewId/confirm",async c=>{
    const a=await review(c),b=z.object({version:z.number().int().positive(),confirmed:z.literal(true),applyTriggers:z.boolean().default(false)}).strict().parse(await c.req.json());
    if(a.r.state==="applied") return c.json({ok:true,alreadyApplied:true});
    requireThat(a.r.version===b.version && a.r.state==="draft",409,"REVIEW_CHANGED","解析結果を確認し直してください。");
    await verify(a);
    const extract=meetingExtractSchema.parse(parse(a.r.analysis)),noteId=`drive-review:${a.r.id}`,at=now();
    const existing=await one(a.db,"SELECT * FROM meeting_customer_imports WHERE file_id=? AND modified_at=?",[a.r.file_id,a.r.modified_at]);
    requireThat(!existing || existing.customer_id===a.cid,409,"DOCUMENT_ASSIGNED","この版は別の顧客に割り当て済みです。担当者が元の割当を確認してください。");
    if(existing && existing.review_id!==a.r.id) {
      await a.db.query("UPDATE meeting_customer_reviews SET state='applied',version=version+1 WHERE id=? AND state='draft' AND version=?",[a.r.id,b.version]);
      return c.json({ok:true,alreadyApplied:true,noteId:existing.note_id});
    }
    const lock=await a.db.query("UPDATE meeting_customer_reviews SET state='applying' WHERE id=? AND version=? AND state='draft'",[a.r.id,b.version]);
    requireThat(lock.changes===1,409,"REVIEW_BUSY","反映中です。");
    try {
      const body=[`【${a.r.title}】`,extract.summary,`要点：${extract.keyPoints.join(" / ")}`,`懸念：${extract.concerns.join(" / ")}`,`関心：${extract.interests.join(" / ")}`,`次のアクション：${extract.nextAction}`,`出典：https://drive.google.com/file/d/${a.r.file_id}/view`, `原文の更新日時：${a.r.modified_at}`].join("\n");
      await a.db.batch([
        {sql:"INSERT OR IGNORE INTO meeting_customer_imports(file_id,modified_at,customer_id,review_id,note_id,created_at) VALUES (?,?,?,?,?,?)",params:[a.r.file_id,a.r.modified_at,a.cid,a.r.id,noteId,at]},
        {sql:"INSERT OR IGNORE INTO context_notes(id,customer_id,source,source_ref,body,confirmed_by,confirmed_at,created_at) SELECT ?,?,'google_drive',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM meeting_customer_imports WHERE file_id=? AND modified_at=? AND review_id=?)",params:[noteId,a.cid,`${a.r.file_id}:${a.r.modified_at}`,body,a.actor,at,at,a.r.file_id,a.r.modified_at,a.r.id]},
      ]);
      const imported=await one(a.db,"SELECT * FROM meeting_customer_imports WHERE file_id=? AND modified_at=?",[a.r.file_id,a.r.modified_at]);
      requireThat(imported?.customer_id===a.cid,409,"DOCUMENT_ASSIGNED","別の顧客へ先に反映されました。割当を確認してください。");
      if(imported.review_id===a.r.id && b.applyTriggers && !a.customer.opt_out && a.customer.mode==="ai" && !["won","lost","booked"].includes(a.customer.stage)) {
        const h=await a.rt.openDatabase(a.tenant,a.oa,"harness");
        for(const [i,t] of extract.triggers.entries()) {
          const scheduledAt=new Date(Date.parse(a.r.held_at)+t.daysAfter*86400000).toISOString();
          if(scheduledAt<=at) continue;
          await h.query("INSERT OR IGNORE INTO events(id,customer_id,type,payload,occurred_at,state) VALUES (?,?,'meeting.trigger',?,?,'pending')",[`${noteId}:${i}`,a.cid,json({intent:t.intent,scheduledAt,noteId,source:"google_drive"}),at]);
        }
      }
      await holdCustomer(a.rt,a.tenant,a.cid,"議事録を確認して追記しました。最新の会話から連絡案を再確認してください。");
      await a.db.query("UPDATE meeting_inbox SET state='linked',customer_id=?,confirmed_by=?,confirmed_at=? WHERE id=? AND version=?",[a.cid,a.actor,at,a.r.file_id,a.r.file_version]);
      const docForBinding=(await one(a.db,"SELECT * FROM meeting_inbox WHERE id=?",[a.r.file_id]))!;
      const bindingText=await readMeetingText(a.rt,await readableMeetingConnection(a.rt,a.tenant,a.oa,a.actor,a.r.connection_id),docForBinding);
      await rememberMeetingBinding(a.rt,a.tenant,a.oa,{...docForBinding,customer_id:a.cid},a.actor,bindingText===a.r.transcript);
      await queueConfirmedMeeting(a.rt,a.tenant,a.oa,a.r.file_id,a.r.held_at);
      await audit(a.rt.db,a.actor,"meeting.customer_imported",a.r.id,a.tenant,{oaId:a.oa,customerId:a.cid,fileId:a.r.file_id,modifiedAt:a.r.modified_at});
      await a.db.query("UPDATE meeting_customer_reviews SET state='applied',version=version+1 WHERE id=? AND state='applying'",[a.r.id]);
      return c.json({ok:true,noteId:imported.note_id});
    } catch(e) {await a.db.query("UPDATE meeting_customer_reviews SET state='draft' WHERE id=? AND state='applying'",[a.r.id]);throw e;}
  });
  app.post(base+"/reviews/:reviewId/cancel",async c=>{
    const a=await review(c);
    requireThat(!["applying","applied"].includes(a.r.state),409,"ALREADY_APPLIED","反映済みのメモはこの操作では削除しません。");
    await a.db.query("UPDATE meeting_customer_reviews SET state='cancelled',version=version+1 WHERE id=? AND state IN ('preview','draft','analyzing')",[a.r.id]);
    return c.json({ok:true});
  });
}
