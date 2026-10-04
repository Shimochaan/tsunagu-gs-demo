import { z } from "zod";
import type { Hono } from "hono";
import type { AppEnv, Runtime } from "./runtime.ts";
import { all, one, now, json, parse } from "./db.ts";
import { member, has } from "./access.ts";
import { requireThat, audit } from "./security.ts";

export const businesses = {
  estate: { label: "不動産", customer: "お客様", product: "物件", meeting: "物件の見学・住まいのご相談", topics: ["住宅ローン", "金利", "住まい"], prompt: "不動産営業として住まいを探すお客様へ連絡する。物件の条件・在庫・出典を確認し、融資の可否や金利適用を断定しない。" },
  bridal: { label: "ブライダル", customer: "お客様", product: "会場・プラン", meeting: "会場見学・ご相談", topics: ["結婚式", "少人数", "会場見学"], prompt: "ブライダル担当として結婚式を検討するお客様へ連絡する。希望人数・会場・費用・時期の確認済みの言葉を尊重し、空き日や料金を捏造しない。" },
  recruitment: { label: "人材紹介", customer: "候補者", product: "求人", meeting: "求人・転職についてのキャリア面談", topics: ["求人", "働き方", "転職"], prompt: "人材紹介営業から候補者への連絡。希望求人・転職希望時期を原文のまま尊重し、キャリア面談を案内する。採否や適性を判定しない。転職時期を次回連絡日時に変換しない。" },
};
export const businessDDL = `CREATE TABLE IF NOT EXISTS tenant_business (tenant_id TEXT PRIMARY KEY,industry TEXT NOT NULL,topics TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)`;
const input = z.object({ version:z.number().int().nonnegative(), industry:z.enum(["estate","bridal","recruitment"]), topics:z.array(z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N} ・ー-]+$/u)).max(5).default([]) }).strict();
export async function businessProfile(rt:Runtime, tenant:string) {
  const r=await one(rt.db,"SELECT * FROM tenant_business WHERE tenant_id=?",[tenant]);
  const industry=r?.industry as keyof typeof businesses | undefined;
  return { industry:industry || null, version:r?.version || 0, topics:r ? parse(r.topics,[]) : [], ...(industry ? businesses[industry] : {label:"主事業未設定",customer:"お客様",product:"商品",meeting:"詳しいご相談",prompt:"業種を推測せず、確認済みの会話と事実だけを使う。"}) , ...(r ? {topics:parse(r.topics,[])} : {}) };
}
export function registerBusiness(app:Hono<AppEnv>) {
  const base="/api/tenants/:tenantId/business";
  app.get(base,async c=>{
    const rt=c.env.runtime,t=c.req.param("tenantId"),m=await member(rt,c.get("principal").user.id,t);
    return c.json({...await businessProfile(rt,t),canEdit:has(m,"org_owner","sys_admin"),options:Object.entries(businesses).map(([value,b])=>({value,...b}))});
  });
  app.put(base,async c=>{
    const rt=c.env.runtime,t=c.req.param("tenantId"),actor=c.get("principal").user.id,m=await member(rt,actor,t),b=input.parse(await c.req.json());
    requireThat(has(m,"org_owner","sys_admin"),403,"BUSINESS_FORBIDDEN","主事業は組織責任者またはシステム管理者が設定してください。");
    const old=await businessProfile(rt,t);
    requireThat(old.version===b.version,409,"BUSINESS_CHANGED","会社設定が更新されています。再読み込みしてください。");
    const topics=b.topics.length ? b.topics : businesses[b.industry].topics;
    if(old.industry===b.industry && json(old.topics)===json(topics)) return c.json(old);
    const r=b.version
      ? await rt.db.query("UPDATE tenant_business SET industry=?,topics=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND version=?",[b.industry,json(topics),actor,now(),t,b.version])
      : await rt.db.query("INSERT OR IGNORE INTO tenant_business(tenant_id,industry,topics,updated_by,updated_at) VALUES (?,?,?,?,?)",[t,b.industry,json(topics),actor,now()]);
    requireThat(r.changes===1,409,"BUSINESS_CHANGED","会社設定が更新されています。再読み込みしてください。");
    // Revision guard takes effect immediately; each account rechecks incrementally.
    for(const a of await all(rt.db,"SELECT id FROM accounts WHERE tenant_id=? AND state='ready'",[t])) {
      const ts=await rt.openDatabase(t,a.id,"tsunagu");
      await ts.query("UPDATE assistant_sweep SET revision=revision+1,next_at='' WHERE id='default'");
      await ts.query("UPDATE proposals SET state='held',approved_by=NULL,approved_version=NULL,hold_reason='会社の主事業・研究テーマが変更されました。再確認してください。' WHERE trigger LIKE 'assistant:%' AND state IN ('pending','approved')");
      const h=await rt.openDatabase(t,a.id,"harness");
      const ids=await all(ts,"SELECT id FROM proposals WHERE trigger LIKE 'assistant:%' AND state='held'");
      await h.query("UPDATE outbox SET state='held',error_code='BUSINESS_CHANGED' WHERE state='pending' AND proposal_id IN (SELECT value FROM json_each(?))",[json(ids.map(x=>x.id))]);
    }
    await audit(rt.db,actor,"business.updated",t,t,{industry:b.industry,version:b.version+1});
    return c.json(await businessProfile(rt,t));
  });
}
