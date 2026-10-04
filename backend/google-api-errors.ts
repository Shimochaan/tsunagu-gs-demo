import { AppError } from "./security.ts";

export type GoogleAPI = "sheets" | "drive" | "calendar" | "google";

// Providerの本文・URL・tokenをログや画面へ返さず、既知の理由だけを表示する。
async function errorBody(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) return null;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes))?.error;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function googleAPIError(
  response: Response,
  api: GoogleAPI = "google",
) {
  const body = await errorBody(response);
  const details = Array.isArray(body?.details) ? body.details : [];
  const info = details.find(
    (d: any) =>
      d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
      d.domain === "googleapis.com" &&
      d.metadata?.service ===
        (api === "calendar"
          ? "calendar-json.googleapis.com"
          : `${api}.googleapis.com`),
  );
  const legacy = Array.isArray(body?.errors) ? body.errors : [];
  const hasReason = (reason: string) =>
    legacy.some((e: any) => e?.reason === reason);
  const name =
    api === "sheets"
      ? "Google Sheets API"
      : api === "drive"
        ? "Google Drive API"
        : api === "calendar"
          ? "Google Calendar API"
          : "Google API";
  if (
    response.status === 403 &&
    api !== "google" &&
    (info?.reason === "SERVICE_DISABLED" || hasReason("accessNotConfigured"))
  ) {
    const project =
      typeof info?.metadata?.consumer === "string"
        ? /^projects\/(\d{1,30})$/.exec(info.metadata.consumer)?.[1]
        : undefined;
    return new AppError(
      502,
      `GOOGLE_${api.toUpperCase()}_API_DISABLED`,
      `${name}が有効になっていません。Google Cloudで、つなぐのGoogle認証に使うプロジェクト${project ? `（プロジェクト番号: ${project}）` : ""}の「APIとサービス → ライブラリ」から${name}を有効にし、数分待って同じ操作をやり直してください。ログインや認証キーの作り直しは不要です。`,
    );
  }
  if (
    response.status === 401 ||
    (response.status === 403 &&
      (info?.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
        hasReason("insufficientPermissions")))
  )
    return new AppError(
      502,
      "GOOGLE_READ_AUTH_REQUIRED",
      "Googleの読み取り認可を確認できません。「Googleに再接続」から、資料の読み取りを許可してください。",
    );
  if (
    response.status === 429 ||
    hasReason("rateLimitExceeded") ||
    hasReason("userRateLimitExceeded")
  )
    return new AppError(
      502,
      "GOOGLE_RATE_LIMITED",
      "Googleの読み取り回数の上限に達しました。しばらく待って再試行してください。",
    );
  if (response.status === 403)
    return new AppError(
      502,
      "GOOGLE_FILE_ACCESS_DENIED",
      "Googleが資料へのアクセスを拒否しました。接続中のGoogleアカウントで元ファイルを開けるか、共有権限や組織の利用制限を確認してください。",
    );
  if (response.status === 404)
    return new AppError(
      502,
      "GOOGLE_FILE_NOT_FOUND",
      "Googleの資料が見つからないか、閲覧権限がありません。元ファイルと接続中のGoogleアカウントを確認してください。",
    );
  if (response.status >= 500)
    return new AppError(
      502,
      "GOOGLE_TEMPORARILY_UNAVAILABLE",
      "Google側で一時的なエラーが発生しました。しばらく待って再試行してください。",
    );
  return new AppError(
    502,
    "GOOGLE_PROVIDER_FAILED",
    `${name}への接続に失敗しました。API設定と資料の閲覧権限を確認してください。`,
  );
}
