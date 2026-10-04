import React from "react";
import { B, Field, Note, Section, Tag } from "../platform/ui.jsx";

export function ReadinessChecks({ readiness, onStep }) {
  return <div className="setup-readiness-list">{readiness.checks.map(item=><div className="product-row" key={item.id}>
    <div><strong>{item.label}</strong><p>{item.ready ? "設定済み" : item.detail}</p><small>担当：{item.owner}</small></div>
    <div className="product-actions"><Tag tone={item.ready ? "green" : "stone"}>{item.ready ? "設定済み" : "未完了"}</Tag>
      {!item.ready && onStep && <B variant="ghost" onClick={()=>onStep(item.step)}>確認する →</B>}
    </div>
  </div>)}</div>;
}

export function SetupOverview({ data, accountId, onAccount, onStep, canUseWorkspace = false }) {
  const environment = data.environment;
  const selected = data.accounts.find(a=>a.id===accountId) || data.accounts[0];
  const readiness = data.readiness?.find(r=>r.accountId===selected?.id);
  const next = readiness?.checks.find(c=>!c.ready);
  const scope = new URLSearchParams({tenant:data.tenant.id,...(selected ? {oa:selected.id} : {})});
  const storageReady = readiness?.checks.find(c=>c.id==="databases")?.ready;
  const usable = data.tenant.state === "active" && storageReady && canUseWorkspace;
  return <div className="product-stack setup-overview">
    <Section title="開通までの進め方" sub="必要な設定と担当者をまとめました。未完了の項目から再開できます。">
      {data.accounts.length > 0 && <Field label="進み具合を確認する公式LINE"><select value={selected?.id || ""} onChange={e=>onAccount?.(e.target.value)} disabled={!onAccount}>
        {data.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
      </select></Field>}
      {!selected ? <><Note>最初に顧客用の公式LINEを登録してください。</Note>{onStep && <B onClick={()=>onStep(2)}>公式LINEを登録する →</B>}</> : readiness && <>
        <Note tone={next ? "amber" : "blue"}>{environment?.delivery === "test_only" ? "本人宛の限定テスト環境です。通常企業の開通とは区別して表示します。" : next ? `次の確認：${next.label}（担当：${next.owner}）` : "通常開通に必要な設定が揃いました。開通確認へ進んでください。"}</Note>
        <ReadinessChecks readiness={readiness} onStep={onStep}/>
        {onStep && <B variant="primary" onClick={()=>onStep(next?.step ?? 6)}>{next ? "次の設定へ進む →" : "開通確認へ進む →"}</B>}
      </>}
    </Section>
    <Section title="情報元・通知先をつなぐ" sub="通常開通後、議事録・商品情報・通知先を接続して提案を確認します。">
      <p>Google Driveと商品 → 顧客の希望 → 自分の通知用LINE → 提案・編集・承認</p>
      {usable ? <div className="product-actions"><a className="setup-route-link" href={`/sales/connections?${scope}`}>資料・通知先の接続へ →</a><a className="setup-route-link" href={`/sales?${scope}&settings=assistant`}>希望条件と提案を確認 →</a></div> : <Note>{!canUseWorkspace ? "顧客情報を扱う組織責任者・営業担当者が接続します。システム管理者の権限だけでは会話を表示しません。" : "公式LINEの開通とデータ保存先の準備が済むと、接続設定へ進めます。"}</Note>}
    </Section>
    {environment && <details className="setup-environment"><summary>運営側の準備と、この環境の動作</summary>
      <div className="product-row"><span>招待メール</span><span>{environment.mail === "provider" ? "配信サービスの設定あり（送信結果は処理状況で確認）" : environment.mail === "local" ? "ローカル検証用。外部送信なし" : "配信停止・未設定。新しい招待メールは送れません"}</span></div>
      <div className="product-row"><span>Googleログイン</span><span>{environment.google ? "設定あり" : "運営による設定待ち"}</span></div>
      <div className="product-row"><span>新しい保存先の準備</span><span>{environment.provisioning ? "運営の構築機能に設定あり" : "この環境では新規構築を停止中"}</span></div>
      <div className="product-row"><span>提案の検知</span><span>{environment.detection === "manual" ? "手動確認。画面の確認ボタンで実行します" : "運営の定期実行設定に従います。実行状況は別途確認が必要です"}</span></div>
      <div className="product-row"><span>顧客への送信</span><span>{{test_only:"本人宛の承認済みテストに限定",disabled:"停止中",enabled:"設定あり。本文ごとの承認が必要です"}[environment.delivery]}</span></div>
      <p>この画面を開くだけでは、メール・LINE送信・AI解析・データの新規構築は行いません。</p>
    </details>}
  </div>;
}
