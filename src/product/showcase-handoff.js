const key = "tsunagu_showcase_draft";
export function readShowcaseDraft() {
  try {
    const d = JSON.parse(sessionStorage.getItem(key));
    return d &&
      /^[0-9a-f-]{36}$/i.test(d.requestId) &&
      typeof d.text === "string" &&
      d.text.length > 0 &&
      d.text.length <= 2000
      ? d
      : null;
  } catch {
    return null;
  }
}
export function captureShowcaseDraft() {
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get(
      "showcaseDraft",
    );
    if (location.pathname === "/demo" && raw) {
      sessionStorage.setItem(key, raw);
      if (!readShowcaseDraft()) sessionStorage.removeItem(key);
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch {}
}
export function clearShowcaseDraft() {
  sessionStorage.removeItem(key);
}
export function showcaseDraftURL(text) {
  const params = new URLSearchParams({
    showcaseDraft: JSON.stringify({ requestId: crypto.randomUUID(), text }),
  });
  return "https://tsunagu-gs-integration.shimoryo.workers.dev/demo#" + params;
}
