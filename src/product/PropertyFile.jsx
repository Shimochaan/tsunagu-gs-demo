import React, { useRef, useState } from "react";
import { B, Field, Note, Section } from "../platform/ui.jsx";
import { api } from "./api.js";

const columns = [
  ["name", "物件名"], ["priceYen", "売買価格（円）"], ["monthlyRentYen", "月額家賃（円）"],
  ["address", "所在地"], ["layout", "間取り"], ["areaSquareMeters", "専有面積（㎡）"],
  ["walkMinutes", "最寄駅から徒歩（分）"], ["landRights", "土地権利"],
];
const readFile = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1]);
  reader.onerror = () => reject(new Error("ファイルを読み取れませんでした。"));
  reader.readAsDataURL(file);
});

export function PropertyFile({ root }) {
  const [file, setFile] = useState(null), [busy, setBusy] = useState(false),
    [result, setResult] = useState(null), [error, setError] = useState("");
  const lock = useRef(false), requestId = useRef(null), attempted = useRef(false);
  const analyze = async () => {
    if (!file || lock.current || attempted.current) return;
    lock.current = true; attempted.current = true; setBusy(true); setError("");
    try {
      setResult(await api(`${root}/assistant/property-file/preview`, {
        filename: file.name, base64: await readFile(file), requestId: requestId.current,
      }));
    } catch (e) { setError(e.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Section title="マイソクから物件項目を読み取る（試験版）" sub="PDF・Excelを1ファイルずつ読み取り、原文付きの確認用下書きを作ります。">
    <p>PDFまたはxlsx、5MB以下・最大5物件。画像を貼ったExcelはPDFに書き出してください。</p>
    <Field label="物件資料（PDF・Excel）">
      <input type="file" aria-label="物件資料（PDF・Excel）" accept=".pdf,.xlsx" disabled={busy} onClick={e => {
        // Selecting the same file after a failed attempt must also fire change.
        e.currentTarget.value = "";
        setFile(null);
      }} onChange={e => {
        const selected = e.target.files?.[0];
        setResult(null); setError(""); setFile(null); attempted.current = false;
        requestId.current = crypto.randomUUID();
        if (!selected) return;
        if (!/\.(pdf|xlsx)$/i.test(selected.name) || selected.size > 5_000_000) {
          setError("5MB以下のPDFまたはxlsxを選んでください。"); return;
        }
        setFile(selected);
      }}/>
    </Field>
    <p className="product-muted">「この資料をAIで読み取る」を押すと、選んだファイルを接続済みのOpenAIへ送信します。解析は1回ずつ実行し、AI利用量に計上されます。</p>
    <B onClick={analyze} disabled={!file || busy || attempted.current} icon={busy ? "LoaderCircle" : "ScanText"}>
      {busy ? "資料を読み取っています…" : "この資料をAIで読み取る"}
    </B>
    {error && <p role="alert" className="product-error">{error} 再実行するときはファイルを選び直してください。</p>}
    {result && <div className="property-file-result" role="status">
      <Note>{result.filename}：{result.properties.length}件の確認用下書き。商品マスタには未登録です。元資料と照合し、価格・面積・権利と、現在の販売状況を確認してください。</Note>
      {result.warnings.length > 0 && <ul>{result.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}
      {result.properties.map((property,i)=><div key={i} className="property-file-card">
        <h3>{property.name.value || `物件 ${i+1}`}</h3>
        <p>取引区分：{{sale:"売買",rent:"賃貸",unknown:"不明"}[property.transactionType]} · 販売状況・在庫：未確認</p>
        <div className="property-file-table"><table><thead><tr><th>項目</th><th>読み取った値</th><th>AIが示した原文・位置（要照合）</th></tr></thead>
          <tbody>{columns.map(([key,label])=><tr key={key}><th scope="row">{label}</th><td>{property[key].value === null ? "不明" : typeof property[key].value === "number" ? property[key].value.toLocaleString("ja-JP") : property[key].value}</td><td>{property[key].evidence || "記載を確認できません"}</td></tr>)}</tbody>
        </table></div>
      </div>)}
      <B variant="ghost" onClick={()=>{
        const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:"application/json"}));
        const a = document.createElement("a"); a.href=url; a.download="物件項目_未確認.json"; a.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }}>確認用下書きをJSONで保存</B>
      <p className="product-muted">この画面を閉じると下書きは消えます。原本ファイルと抽出内容は、つなぐのDBには保存しません。</p>
    </div>}
  </Section>;
}
