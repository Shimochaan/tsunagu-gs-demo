import React, { useState } from "react";
import { B, Field, Section, Note, Tag } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Form, Action, State } from "./shared.jsx";

export function RecordingSources({ tenant, account, onLinked }) {
  const base = `/api/tenants/${tenant}/accounts/${account.id}/connectors/recordings`;
  const { data, error, refresh } = useData(base);
  const [editing, setEditing] = useState(null), [saved, setSaved] = useState(false);
  if (error) return <Section title={`${account.name}の録画・議事録保存先`}><State error={error} /></Section>;
  if (!data) return <State />;
  const save = async sources => {
    await api(base, { revision: data.revision, sources }, "PUT");
    setEditing(null); setSaved(true); refresh();
  };
  return <Section title={`${account.name}の録画・議事録保存先`} sub="同じ公式LINEでも、担当者ごとに複数の保存先を登録できます。">
    <Note>保存先の登録と予約へのリンクができます。Driveからの自動取得は未接続です。録画・Geminiメモの内容は、この登録だけでは取り込みません。</Note>
    {saved && <p role="status">保存しました。</p>}
    {data.sources.map(source => <div className="product-row" key={source.id}>
      <div><h3>{source.label} <Tag>{source.enabled ? "使用する" : "停止中"}</Tag></h3><p>{source.hostEmail} · {source.includeSubfolders ? "サブフォルダを含む" : "直下のみ"}</p><a href={source.folderUrl} target="_blank" rel="noreferrer">保存先を開く</a></div>
      <B variant="secondary" onClick={() => { setEditing(source); setSaved(false); }}>編集</B>
    </div>)}
    {!data.sources.length && <p>担当者の保存先を追加してください。予約がなくても登録できます。</p>}
    {!editing && <B variant="secondary" onClick={() => { setEditing({ id: crypto.randomUUID(), label: "", hostEmail: "", folderUrl: "", enabled: true, includeSubfolders: true }); setSaved(false); }}>担当者の保存先を追加</B>}
    {editing && <Form key={editing.id} button="保存先を保存する" onSubmit={v => {
      const source = { id: editing.id, label: v.label, hostEmail: v.hostEmail, folderUrl: v.folderUrl, enabled: v.enabled === "on", includeSubfolders: v.includeSubfolders === "on" };
      return save([...data.sources.filter(s => s.id !== editing.id), source]);
    }}>
      <Field label="担当者・保存先の名前"><input name="label" defaultValue={editing.label} required maxLength={100} placeholder="例：三木良太・1on1録画" /></Field>
      <Field label="TimeRexの主催者メールアドレス"><input name="hostEmail" type="email" defaultValue={editing.hostEmail} required /></Field>
      <Field label="Google DriveのフォルダURL"><input name="folderUrl" type="url" defaultValue={editing.folderUrl} required placeholder="https://drive.google.com/drive/folders/..." /></Field>
      <label><input name="includeSubfolders" type="checkbox" defaultChecked={editing.includeSubfolders} />会議ごとのサブフォルダも対象にする</label>
      <label><input name="enabled" type="checkbox" defaultChecked={editing.enabled} />この保存先を使用する</label>
      <B variant="secondary" type="button" onClick={() => setEditing(null)}>閉じる</B>
    </Form>}
    {data.sources.some(s => s.enabled) && <RecordingLink key={data.revision} base={base} sources={data.sources.filter(s => s.enabled)} onLinked={onLinked} />}
  </Section>;
}
function RecordingLink({ base, sources, onLinked }) {
  const [search, setSearch] = useState(null), [result, setResult] = useState(null), [linked, setLinked] = useState(false);
  return <details style={{ marginTop: 20 }}><summary>録画・議事録をTimeRexの予約に紐付ける</summary>
    <p>担当者のメールと開始日時（前後90分）から候補を探します。候補が1件でも、会議・顧客とファイルを確認してから保存します。</p>
    <Form button="予約候補を探す" onSubmit={async v => {
      setResult(null); setLinked(false);
      const input = { sourceId: v.sourceId, startedAt: new Date(`${v.startedAt}:00+09:00`).toISOString(), ...(v.bookingId.trim() ? { bookingId: v.bookingId.trim() } : {}) };
      const res = await api(`${base}/candidates`, input);
      setSearch(input); setResult(res.candidates);
    }}>
      <Field label="担当者の保存先"><select name="sourceId">{sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
      <Field label="会議の開始日時（日本時間）"><input name="startedAt" type="datetime-local" required /></Field>
      <Field label="TimeRex予約ID（分かる場合）"><input name="bookingId" /></Field>
    </Form>
    {result?.length === 0 && <p role="status">一致する予約がありません。TimeRex主催者メール・日時・LINEの紐付けを確認してください。キャンセル済み予約は対象外です。</p>}
    {result?.length > 0 && !linked && <Form key={JSON.stringify(search)} button="確認して予約にリンクを保存する" onSubmit={async v => {
      const appointment = result.find(a => a.id === v.appointmentId);
      await api(`${base}/link`, { ...search, appointmentId: appointment.id, version: appointment.version, fileUrl: v.fileUrl, confirmed: v.confirmed === "on" });
      setLinked(true); onLinked?.();
    }}>
      <Field label="紐付ける予約"><select name="appointmentId" required defaultValue=""><option value="" disabled>顧客と日時を確認して選択</option>{result.map(a => <option key={a.id} value={a.id}>{a.customerName} · {date(a.startsAt)} · {a.title}</option>)}</select></Field>
      <Field label="録画ファイルまたはGoogleドキュメントのURL"><input name="fileUrl" type="url" required /></Field>
      <label><input name="confirmed" type="checkbox" required />このファイルが選んだ保存先の対象会議・顧客のものだと確認しました</label>
      <p>既存の録画リンクがある場合は置き換えます。議事録のAI解析・顧客状態の変更・LINE送信は実行しません。</p>
    </Form>}
    {linked && <p role="status">予約に録画・議事録リンクを保存しました。</p>}
  </details>;
}
