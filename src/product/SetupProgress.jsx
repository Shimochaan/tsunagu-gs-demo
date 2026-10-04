import React from "react";
import { B, Note, Section } from "../platform/ui.jsx";
import { useData } from "./api.js";
import { State } from "./shared.jsx";

export function SetupProgress({ tenant, oa, customers, driveReady, folderSelected, refreshConnections }) {
  const root = `/api/tenants/${tenant}/accounts/${oa}`;
  const assistant = useData(`${root}/assistant?scope=settings`);
  const staff = useData(`/api/tenants/${tenant}/assistant-line`);
  const reload = () => { assistant.refresh(); staff.refresh(); refreshConnections(); };
  if (!assistant.data || !staff.data) return <Section title="接続の進み具合"><State error={assistant.error || staff.error}/><B onClick={reload}>進み具合を再確認</B></Section>;
  const a = assistant.data, s = staff.data;
  const scope = `tenant=${encodeURIComponent(tenant)}&oa=${encodeURIComponent(oa)}`;
  const count = customers.filter(c => c.accounts.includes(oa)).length;
  const products = a.sources.filter(x => x.kind === "product").length;
  const steps = [
    {title:"企業への参加", done:true, detail:"Google等でログインし、この企業へ参加済みです。"},
    {title:"顧客用LINEと友だち", done:a.customerConnection.connected && count > 0, detail:`受信接続：${a.customerConnection.connected ? "接続済み" : "未接続"} · 登録した顧客：${count}人`, target:"setup-customer-line", action:"接続・取り込みを確認"},
    {title:"Google Driveと資料", done:driveReady && folderSelected, detail:`Google認可：${driveReady ? "あり" : "未接続"} · 議事録フォルダ：${folderSelected ? "選択済み" : "未選択"} · 商品情報：${products ? "登録あり" : "未登録"}`, target:"setup-google", action:"資料を接続・確認"},
    {title:"顧客の希望と提案", done:a.preferences.length > 0, detail:a.preferences.length ? `${a.preferences.length}人の希望条件を保存済み。資料の内容と照合して提案を確認します。` : "面談結果を確認し、希望条件を設定すると商品と照合できます。", href:`/sales?${scope}&settings=assistant`, action:"希望条件・提案を確認"},
    {title:"担当者へのLINE通知（任意）", done:s.state === "active" && s.notifications && a.enabled, detail:!s.configured ? "運営による通知用LINEの接続準備待ちです。" : s.state !== "active" ? "通知先の本人LINEを連携してください。" : !s.notifications ? "本人連携済み。LINEの通知受取をONにしてください。" : !a.enabled ? "本人連携・通知受取はONです。今日の提案で検知を有効にしてください。" : a.detectionMode === "manual" ? "本人連携・通知受取はON。提案の検知は手動確認です。" : "本人連携・通知受取・検知設定はON。定期実行は運営側の設定に従います。", target:"setup-staff-line", action:"通知先を設定"},
  ];
  const next = steps.find(x => !x.done);
  const go = (step) => {
    const element = document.getElementById(step.target);
    if (element?.tagName === "DETAILS") element.open = true;
    element?.scrollIntoView({behavior:"smooth",block:"start"});
  };
  return <Section title="接続の進み具合" sub="保存された接続・取り込み状態を確認できます。上から順に進めましょう。" action={<B variant="ghost" onClick={reload}>進み具合を再確認</B>}>
    <div className="setup-progress-list">{steps.map((step,i)=><div className={`setup-progress-item ${step.done ? "is-done" : ""}`} key={step.title}>
      <span className="setup-progress-number" aria-label={step.done ? "設定済み" : "未完了"}>{step.done ? "✓" : i+1}</span>
      <div><strong>{step.title}</strong><p>{step.detail}</p>{step.href ? <a href={step.href}>{step.action} →</a> : step.target ? <B variant="ghost" onClick={()=>go(step)}>{step.action} →</B> : null}</div>
    </div>)}</div>
    <Note>{next ? `次に進めるところ：${next.title}` : "接続の準備が揃いました。「今日の提案」で内容を確認してください。"} 接続済みの表示だけでは、資料の読み取り成功や顧客への送信成功を保証しません。</Note>
    <p><a href={`/sales?${scope}`}>今日の提案へ →</a></p>
  </Section>;
}
