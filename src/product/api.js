import { peekData, acquireData, invalidateData, subscribeData } from "./request-cache.js";
export { invalidateData };
import { useCallback, useEffect, useState } from "react";
export async function api(
  url,
  body,
  method = body === undefined ? "GET" : "POST",
  extra = {},
  signal,
) {
  const scope =
    method !== "GET" ? url.match(/^\/api\/tenants\/[^/]+/)?.[0] : null;
  if (method !== "GET") invalidateData(scope);
  const response = await fetch(url, {
    signal,
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response
    .json()
    .catch(() => ({ message: "応答を読み取れませんでした。" }));
  if (!response.ok) {
    const error = new Error(data.message || "操作を完了できませんでした。");
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  if (method !== "GET") invalidateData(scope);
  return data;
}
export function useData(url) {
  const [state, setState] = useState(() => ({
    url,
    data: url ? peekData(url) || null : null,
    error: "",
  }));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    if (url) invalidateData(url);
    setRevision((x) => x + 1);
  }, [url]);
  useEffect(() => {
    if (!url) return;
    const unsubscribe=subscribeData(url, () => setRevision(x=>x+1));
    const tick=()=>{
      if (document.visibilityState!=="visible" || document.activeElement?.matches("input,textarea,select,[contenteditable=true]")) return;
      setRevision(x=>x+1);
    };
    const timer=setInterval(tick,30000);
    window.addEventListener("focus",tick); document.addEventListener("visibilitychange",tick);
    return ()=>{unsubscribe();clearInterval(timer);window.removeEventListener("focus",tick);document.removeEventListener("visibilitychange",tick);};
  },[url]);
  useEffect(() => {
    if (!url) {
      setState({ url, data: null, error: "" });
      return;
    }
    let active = true;
    setState((previous) => ({
      url,
      data: previous.url === url ? previous.data : peekData(url) || null,
      error: "",
    }));
    let request;
    const load = () => {
      request = acquireData(url, (signal) =>
        api(url, undefined, "GET", {}, signal),
      );
      request.promise
        .then((data) => {
          if (active) setState(previous => previous.url === url && JSON.stringify(previous.data) === JSON.stringify(data) ? {...previous,error:""} : { url, data, error: "" });
        })
        .catch((e) => {
          if (!active) return;
          if (e.name === "AbortError") {
            // Another mounted form may invalidate this in-flight GET. Resume it
            // while mounted so a settings/detail panel cannot stay loading forever.
            request.release();
            load();
          } else setState(previous => ({ url, data: previous.url===url ? previous.data : null, error:e.message }));
        });
    };
    load();
    return () => {
      active = false;
      request.release();
    };
  }, [url, revision]);
  return {
    data: state.url === url ? state.data : null,
    error: state.url === url ? state.error : "",
    refresh,
  };
}
export const date = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "—";
export const labels = {
  "assistant:followup": "次の約束・再連絡",
  "assistant:reply": "返信へのご連絡",
  "assistant:news": "商談に関連するニュース",
  "assistant:product": "希望に合う新着",
  expired: "期限・根拠の再確認",
  connected: "接続済み",
  credentials: "資格情報待ち",
  prospect: "検討中",
  sending: "送信処理中",
  uncertain: "配送結果の確認待ち",
  sales: "営業担当",
  team_admin: "チーム管理者",
  org_owner: "組織責任者",
  sys_admin: "システム管理者",
  billing: "経理",
  ops_owner: "運営責任者",
  ops_sales: "契約担当",
  ops_setup: "導入担当",
  ops_finance: "財務担当",
  ops_support: "サポート",
  setup: "準備中",
  active: "利用中",
  suspended: "停止中",
  pending: "確認待ち",
  running: "処理中",
  failed: "要対応",
  completed: "完了",
  ready: "開通済み",
  webhook: "接続確認待ち",
  provisioning: "DB準備中",
  held: "保留",
  approved: "承認済み",
  sent: "送信済み",
  new: "新規",
  ai: "AIから提案",
  human: "本人が対応",
  stopped: "追客停止",
  won: "契約済み",
  booked: "予約済み",
  post_meeting: "面談後・検討中",
  result_pending: "結果確認待ち",
  attended: "実施済み",
  cancelled: "キャンセル",
  no_show: "欠席",
  invited: "招待中",
  negotiating: "商談中・検討中",
  closed_won: "成約",
  closed_lost: "失注",
  holding: "検討保留",
  re_propose: "再提案待ち",
};
export const label = (value) => labels[value] || value;
