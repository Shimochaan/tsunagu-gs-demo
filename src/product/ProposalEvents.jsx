import React from "react";
import {Section,Note,Tag} from "../platform/ui.jsx";
import {api,useData,date} from "./api.js";
import {Action,State} from "./shared.jsx";
export function ProposalEvents({tenant}) {
  const base=`/api/tenants/${tenant}/proposal-events`,{data,error,refresh}=useData(base);
  if(!data) return <State error={error}/>;
  return <Section title="担当者への気づきと通知" sub={data.detail}>
    <Note>iOS通知：{data.pushConfigured ? "配信adapter設定あり・端末側の許可と配信結果を要確認" : "未接続（iOSアプリ・APNs・端末登録が必要）"}。ここでの既読や評価は顧客への送信承認ではありません。</Note>
    {!data.events.length && <p>いま確認できる通知はありません。</p>}
    {data.events.map(e=><article className="product-card" key={e.id}>
      <Tag>{e.priority<=10 ? "返信を優先" : e.priority<=20 ? "約束・予定の確認" : "条件に合う新着"}</Tag> <Tag>{e.state==="unread" ? "未読" : "既読"}</Tag>
      <p>{e.reason}</p><small>確認期限：{date(e.expires_at)}</small>
      <div className="product-actions"><a href={`/sales?tenant=${encodeURIComponent(tenant)}&oa=${encodeURIComponent(e.oa_id)}&assistant=${encodeURIComponent(e.proposal_id)}`}>提案を確認</a>
        {[["read","既読にする"],["useful","役立った"],["too_early","まだ早い"],["irrelevant","関連が薄い"],["dismiss","通知を閉じる"]].map(([action,label])=><Action key={action} run={()=>api(`${base}/${e.id}`,{action})} done={refresh}>{label}</Action>)}
      </div>
    </article>)}
    {!!data.measurements.length && <p>担当者の評価：{data.measurements.map(m=>`${({useful:"役立った",too_early:"まだ早い",irrelevant:"関連が薄い"})[m.feedback]} ${m.count}件`).join(" / ")}。評価を蓄積して設定を見直します。学習済みとは扱いません。</p>}
  </Section>;
}
