import React, { useState } from "react";
import { Section, Field, Note, Tag } from "../platform/ui.jsx";
import { api, useData } from "./api.js";
import { Form, State } from "./shared.jsx";
export function BusinessSettings({tenant,onChange}) {
  const url=`/api/tenants/${tenant}/business`,{data,error,refresh}=useData(url);
  if(!data) return <State error={error}/>;
  return <Section title={`会社の主事業 · ${data.label}`} sub={data.industry ? `${data.customer}の希望と${data.product}の情報から、${data.meeting}につなげます。` : "会社の主事業を設定すると、画面・研究テーマ・連絡案を業界に合わせます。"}>
    <Tag>{data.industry ? "会社全体に適用" : "未設定・業種を推測しません"}</Tag>
    <details><summary>{data.canEdit ? "主事業・研究テーマを設定する" : "会社設定を確認する"}</summary>
      {data.canEdit ? <BusinessForm key={data.version} data={data} url={url} done={()=>{refresh();onChange?.();}}/> : <p>主事業の変更は組織責任者・システム管理者へ依頼してください。</p>}
    </details>
  </Section>;
}
function BusinessForm({data,url,done}) {
  const [industry,setIndustry]=useState(data.industry || ""),[topics,setTopics]=useState(data.topics.join("、"));
  return <Form button="会社の主事業を保存" onSubmit={()=>api(url,{version:data.version,industry,topics:topics.split(/[、,\n]/).map(s=>s.trim()).filter(Boolean)},"PUT")} onDone={done}>
    <Field label="会社の主事業"><select required value={industry} onChange={e=>{setIndustry(e.target.value);setTopics(data.options.find(x=>x.value===e.target.value)?.topics.join("、") || "");}}><option value="">選択してください</option>{data.options.map(x=><option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
    <Field label="研究テーマ（個人情報を含めず、5件まで）"><input value={topics} onChange={e=>setTopics(e.target.value)} maxLength={205}/></Field>
    <Note>変更すると旧設定の提案は再確認が必要になります。顧客・会話・確認済みの希望条件は移動・自動変更しません。検索は接続・定期取得の設定後、関連する確認済みメモがあるテーマだけを取得します。</Note>
  </Form>;
}
