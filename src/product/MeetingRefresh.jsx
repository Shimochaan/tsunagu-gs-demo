import React, { useState } from "react";
import { Note } from "../platform/ui.jsx";
import { Action } from "./shared.jsx";
import { api } from "./api.js";
export function useMeetingRefresh(base, fileId, onFresh) {
  const [changed, setChanged] = useState(false);
  return {
    onError: (error) => {
      if (["DOCUMENT_CHANGED", "NOTE_CHANGED"].includes(error.code))
        setChanged(true);
    },
    recovery:
      changed && fileId ? (
        <div role="status">
          <Note>
            原文が更新されています。最新版を取得し、この画面で内容を確認し直せます。取得だけではAI解析・顧客への送信は行いません。
          </Note>
          <Action
            run={async () => {
              const fresh = await api(
                `${base}/meeting-inbox/${fileId}/refresh`,
                {},
              );
              await onFresh(fresh);
              setChanged(false);
            }}
          >
            最新版を取得して再確認
          </Action>
        </div>
      ) : null,
  };
}
