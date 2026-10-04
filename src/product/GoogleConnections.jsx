import { CalendarConnection } from "./CalendarConnection.jsx";
import { HarnessConnection } from "./HarnessConnection.jsx";
import React, { useState, useRef } from "react";
import { B, Field, Note, Section, Title } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Action, Form, State } from "./shared.jsx";
import { AssistantGoogle } from "./AssistantGoogle.jsx";
import { StaffLine } from "./Assistant.jsx";
import { SetupProgress } from "./SetupProgress.jsx";
import { PropertyFile } from "./PropertyFile.jsx";

const driveErrors = {
  GOOGLE_TOKEN_REQUEST_FAILED:
    "つなぐからGoogleへの認証通信を完了できませんでした。Googleの設定を作り直さず、確認コードを運営へ伝えてください。",
  GOOGLE_TOKEN_INVALID:
    "Googleからの認証応答を確認できませんでした。確認コードを運営へ伝えてください。",
  CREDENTIAL_STORAGE_UNAVAILABLE:
    "接続情報を保存するサーバー設定に問題があります。運営側で修正が必要です。Googleの設定をやり直す必要はありません。",
  DRIVE_STATE_FAILED:
    "つなぐで認可の記録を確認できませんでした。確認コードを運営へ伝えてください。",
  DRIVE_ACCESS_FAILED:
    "企業・公式LINEの権限を確認できませんでした。運営側で担当者設定を確認します。",
  DRIVE_SOURCES_FAILED:
    "議事録の保存先設定を読み取れませんでした。運営側で保存先の設定を確認します。",
  DRIVE_CONNECTION_SAVE_FAILED:
    "認可結果をつなぐへ保存できませんでした。Googleの設定を作り直さず、確認コードを運営へ伝えてください。",
  INTEGRATION_NETWORK_DISABLED:
    "この環境でGoogleへの通信が許可されていません。運営側の接続設定を確認します。",
  INTEGRATION_REDIRECT_BLOCKED:
    "接続先からの転送を停止しました。運営側で接続先を確認します。",
  PROVIDER_REDIRECT_BLOCKED:
    "接続先からの転送を停止しました。運営側で接続先を確認します。",
  GOOGLE_CLIENT_INVALID:
    "GoogleのクライアントIDとシークレットの組み合わせを確認してください。認証情報は専用環境へ本人が登録します。",
  GOOGLE_REDIRECT_INVALID:
    "Google Cloudの承認済みリダイレクトURIに、この環境の /api/drive/callback を完全一致で登録してください。",
  GOOGLE_GRANT_INVALID:
    "Google認証コードが期限切れか使用済みです。この画面から新しく認可を開始してください。",
  OAUTH_STATE:
    "Google認可の期限が切れたか、ログインしたブラウザが変わりました。この画面から認可を開始し、同じブラウザで10分以内に完了してください。",
  OAUTH_USED:
    "この認可は処理済みです。状態を再読み込みし、未接続ならGoogleに再接続してください。",
  OAUTH_EXCHANGE:
    "Googleの認証コードを交換できませんでした。Google CloudのDrive用リダイレクトURIと、この環境のOAuthクライアント設定を確認してください。",
  DRIVE_SCOPE:
    "Driveの読み取り権限、または継続接続の認可を取得できませんでした。Googleに再接続し、ファイルの表示とダウンロードを許可してください。",
  GOOGLE_PROFILE:
    "Googleアカウント情報を取得できませんでした。再接続しても続く場合は接続設定を運営に確認してください。",
  GOOGLE_EMAIL:
    "確認済みのGoogleメールアドレスを取得できませんでした。利用するGoogleアカウントを確認してください。",
  DRIVE_FORBIDDEN:
    "この企業・公式LINEの資料を接続する権限がありません。ログイン中のアカウントと担当者設定を確認してください。",
};
export function GoogleConnections({ tenant, accounts, customers = [], me }) {
  const roles = me.memberships.find((m) => m.tenant_id === tenant)?.roles || [];
  const requested = new URLSearchParams(location.search).get("oa");
  const [account, setAccount] = useState(
    accounts.some((a) => a.id === requested)
      ? requested
      : accounts[0]?.id || "",
  );
  if (requested && !accounts.some((a) => a.id === requested))
    return (
      <Note>
        指定された公式LINEをこの企業で確認できません。別のアカウントへ自動では切り替えません。メニューの「接続設定」から開き直してください。
      </Note>
    );
  if (!roles.some((r) => ["org_owner", "sys_admin"].includes(r)))
    return (
      <Note>
        接続設定は企業の管理者に依頼してください。議事録の担当者別接続は「面談結果」から行えます。
      </Note>
    );
  return (
    <div className="product-stack">
      <Title
        title="接続設定"
        description="顧客用LINE → 友だち → Googleの資料 → 担当者への通知。接続の進み具合をこの画面で確認できます。"
      />
      <Field label="資料を使う公式LINE">
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      {account ? (
        <ConnectionSteps
          key={`${tenant}:${account}`}
          tenant={tenant}
          oa={account}
          customers={customers}
        />
      ) : (
        <Note>先に「導入・企業設定」で公式LINEを登録してください。</Note>
      )}
    </div>
  );
}
export function ConnectionSteps({ tenant, oa, customers = [] }) {
  const root = `/api/tenants/${tenant}/accounts/${oa}`,
    base = `${root}/assistant/google`,
    drive = `${root}/connectors/drive`;
  const { data, error, refresh } = useData(drive),
    google = useData(base);
  const [picker, setPicker] = useState(null),
    [choice, setChoice] = useState(null),
    [tested, setTested] = useState(null),
    [notice, setNotice] = useState(""),
    [news, setNews] = useState("");
  const reload = () => {
    refresh();
    google.refresh();
  };
  const mine = data?.connections.find(
      (c) => c.mine && c.state !== "disconnected",
    ),
    ready = !!data?.enabled && ["connected", "syncing"].includes(mine?.state);
  const returning = new URLSearchParams(location.search);
  if (!data || !google.data)
    return (
      <>
        <State error={error || google.error} />
        <B onClick={reload}>状態を再読み込み</B>
      </>
    );
  const g = google.data;
  return (
    <>
      {data.demo && (
        <Note>
          公開デモの接続画面です（mock）。Googleへの認可・実ファイル検索は行いません。実接続用の環境で同じ3手順を使います。
        </Note>
      )}
      {(returning.get("drive") === "retry" ||
        returning.get("newsDrive") === "retry") && (
        <Note tone="amber">
          {returning.get("drive") === "retry" &&
          driveErrors[returning.get("reason")]
            ? driveErrors[returning.get("reason")]
            : "Google認可を完了できませんでした。対象の公式LINEを選んで再接続してください。"}
          {returning.get("drive") === "retry" && (
            <p>
              確認コード：
              {Object.hasOwn(driveErrors, returning.get("reason"))
                ? returning.get("reason")
                : "DRIVE_CALLBACK_FAILED"}
              。秘密値を送らず、このコードを運営へ伝えてください。
            </p>
          )}
        </Note>
      )}
      {(returning.get("drive") === "cancelled" ||
        returning.get("newsDrive") === "cancelled") && (
        <Note>
          Googleでの認可をキャンセルしました。再開するときは接続ボタンを押してください。
        </Note>
      )}
      {(returning.get("drive") === "connected" ||
        returning.get("newsDrive") === "connected") && (
        <Note>
          Googleの認可から戻りました。以下の接続状態を確認し、資料の選択へ進んでください。
        </Note>
      )}
      <SetupProgress tenant={tenant} oa={oa} customers={customers} driveReady={ready} folderSelected={!!mine?.folderNames?.length} refreshConnections={reload}/>
      <HarnessSetup root={root} />
      <div id="setup-google" />
      <Section
        title="1. Googleに接続"
        sub="ログイン中のあなたが、この公式LINEで使う資料への読み取りを許可します。"
      >
        {!data.enabled ? (
          <Note>
            運営側の準備待ちです。Google接続の準備ができると、この画面から進められます。
          </Note>
        ) : (
          <Note>
            {mine
              ? `${mine.email} · ${mine.state === "reconnect" ? "再接続が必要です" : "Google認可あり（資料の読み取りは手順3で確認）"}`
              : "未接続です。資料が見えるGoogleアカウントで接続してください。"}
          </Note>
        )}
        <div className="product-actions">
          <Action
            disabled={!data.enabled}
            run={async () => {
              const r = await api(`${drive}/authorize`, {});
              location.assign(r.url);
            }}
          >
            {mine ? "Googleに再接続" : "Googleに接続"}
          </Action>
          {mine && <Action disabled={!data.enabled} run={async () => {
            const r = await api(`${drive}/authorize`, { sheetWrite: true });
            location.assign(r.url);
          }}>{mine.canWriteSheets ? "商品マスターの書き込み許可を更新" : "商品マスターへの保存を許可する"}</Action>}
          {mine && (
            <Action
              run={async () => {
                await api(`${drive}/disconnect`, {});
                setChoice(null);
                setTested(null);
                setPicker(null);
                setNotice("Googleの読み取り接続を解除しました。");
                reload();
              }}
            >
              Google接続を解除
            </Action>
          )}
          <B variant="ghost" onClick={reload}>
            状態を再読み込み
          </B>
        </div>
        {mine?.error && <Note tone="amber">{mine.error}</Note>}
      </Section>
      <Section
        title="2. 資料を選ぶ"
        sub="議事録フォルダと、物件だけを入れたスプレッドシートを選びます。顧客希望・正解表・検証ケースは接続しません。"
      >
        <p>議事録：{mine?.folderNames?.join("、") || "未選択"}</p>
        <B
          disabled={!ready}
          onClick={() => {
            setPicker("folder");
            setChoice(null);
            setNotice("");
          }}
        >
          議事録フォルダを選ぶ
        </B>
        <p>
          物件：
          {g.settings.propertyFileName ||
            (g.settings.spreadsheetId ? "物件台帳（保存済み）" : "未選択")}
        </p>
        <B
          disabled={!ready}
          onClick={() => {
            setPicker("sheet");
            setChoice(null);
            setNotice("");
          }}
        >
          物件ファイルを選ぶ
        </B>
        {picker && (
          <FileChooser
            key={picker}
            base={base}
            kind={picker}
            close={() => {
              setPicker(null);
              setChoice(null);
            }}
            choose={async (f) => {
              if (picker === "folder") {
                await api(
                  `${drive}/folders`,
                  { roots: [f.id], recursive: true, revision: mine.revision },
                  "PUT",
                );
                setTested(null);
                setPicker(null);
                setNotice(
                  `「${f.name}」を保存しました。手順3で読み取りを確認してください。`,
                );
                reload();
              } else {
                setChoice(
                  await api(
                    `${base}/properties/file/${encodeURIComponent(f.id)}`,
                  ),
                );
                setPicker(null);
              }
            }}
          />
        )}
        {choice && (
          <Section
            title={`選択中：${choice.file.name}`}
            sub={`保存先：${choice.folder.name}`}
          >
            <Field label="対象タブ">
              <select aria-label="対象タブ" defaultValue="物件台帳">
                {choice.tabs.map((t) => (
                  <option key={t.name}>{t.name}</option>
                ))}
              </select>
            </Field>
            <p>
              「物件台帳」だけのファイルに限定します。内容はまだ取り込まれません。
            </p>
            <Action
              run={async () => {
                await api(`${base}/properties/select`, {
                  version: g.version,
                  fileId: choice.file.id,
                  sheetName: "物件台帳",
                });
                setNotice(
                  `「${choice.file.name}」を保存しました。手順3で内容を確認してください。`,
                );
                setChoice(null);
                setPicker(null);
                google.refresh();
              }}
            >
              この物件ファイルを保存
            </Action>
            <B variant="ghost" onClick={() => setChoice(null)}>
              選択を取り消す
            </B>
          </Section>
        )}
        {notice && <p role="status">{notice}</p>}
      </Section>
      <Section
        title="3. 読み取りを確認"
        sub="Googleへの読み取りだけを行います。AI解析・ニュース調査・LINE送信は実行しません。"
      >
        <Action
          disabled={!ready || !mine?.roots?.length}
          run={async () => {
            setTested(null);
            try {
              setTested(await api(`${base}/meetings/test`, {}));
            } finally {
              refresh();
            }
          }}
        >
          議事録の接続をテスト
        </Action>
        {tested && (
          <div role="status">
            <p>保存先の読み取りを確認しました：{date(tested.checkedAt)}</p>
            {tested.folders.map((f, i) => (
              <div key={i}>
                <strong>{f.name}</strong>
                {f.files.length ? (
                  <ul>
                    {f.files.map((file) => (
                      <li key={file.id}>{file.name}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    直下にGoogleドキュメント／テキストがありません。形式・保存先を確認してください。サブフォルダ内の資料は「面談結果」で検知できます。
                  </p>
                )}
                {f.hasMore && (
                  <p>
                    先頭20件を確認しました。全件は「面談結果」で検知してください。
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <p>
          保存先を約5分ごとに確認し、新規・更新を自動検知します。初回に顧客を紐付けると、その原文の更新は自動で要約・条件へ反映されます。動画そのものの文字起こしには未対応です。
        </p>
        <a href="/sales/meetings">面談結果へ進む</a>
        <AssistantGoogle
          key={`${g.version}:${g.driveReadConfigured}`}
          base={base}
          connectionMode
          readUnavailable={!ready}
        />
      </Section>
      <CalendarConnection tenant={tenant} oa={oa}/>
      <PropertyFile root={root}/>
      <div id="setup-staff-line"><StaffLine tenant={tenant}/></div>
      <Section
        title="ニュースをDriveに保存する場合"
        sub="任意の追加設定です。議事録・物件の読み取りとは別に、保存用の書き込み認可を行います。"
      >
        <p>
          {g.newsState === "connected"
            ? `${g.newsEmail || "Google"}：書き込み認可あり`
            : g.newsState === "reconnect"
              ? "ニュース保存の再接続が必要です"
              : "ニュース保存は未接続です"}
        </p>
        <p>
          「ニュース保存を接続」でGoogleに移動します。認可すると専用フォルダ「つなぐ
          ニュース（確認待ち）」を作成します。調査は自動では始まりません。
        </p>
        {!g.newsAuthorizationEnabled && (
          <Note>
            ニュース保存は運営側の準備待ちです。議事録・物件の接続とは独立しています。
          </Note>
        )}
        <div className="product-actions">
          <Action
            disabled={!g.newsAuthorizationEnabled}
            run={async () => {
              const r = await api(`${base}/news/authorize`, {
                acknowledgeFolderCreation: true,
              });
              location.assign(r.url);
            }}
          >
            ニュース保存を接続
          </Action>
          <Action
            disabled={!g.newsWriteConfigured}
            run={async () => {
              try {
                const r = await api(`${base}/news/use-folder`, {
                  version: g.version,
                });
                setNews(
                  `「${r.name}」への保存権限を確認し、保存先に設定しました。実ファイルの保存と調査はまだ行っていません。`,
                );
              } finally {
                google.refresh();
              }
            }}
          >
            専用フォルダを確認して保存先にする
          </Action>
          {g.newsState !== "disconnected" && (
            <Action
              run={async () => {
                await api(`${base}/news/disconnect`, {});
                setNews("ニュースの書き込み接続を解除し、調査を停止しました。");
                google.refresh();
              }}
            >
              ニュース保存を解除
            </Action>
          )}
        </div>
        {news && <p role="status">{news}</p>}
        <AssistantGoogle key={g.version} base={base} />
      </Section>
    </>
  );
}
function FileChooser({ base, kind, choose, close }) {
  const lock = useRef(false),
    [busy, setBusy] = useState(false);
  const guarded = async (fn) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const [query, setQuery] = useState(""),
    [rows, setRows] = useState([]),
    [page, setPage] = useState(null),
    [loaded, setLoaded] = useState(false);
  const load = async (next) => {
    const r = await api(
      `${base}/browse?${new URLSearchParams({ kind, search: query, ...(next ? { page: next } : {}) })}`,
    );
    setRows((old) => (next ? [...old, ...r.files] : r.files));
    setPage(r.nextPageToken);
    setLoaded(true);
  };
  return (
    <Section
      title={kind === "folder" ? "議事録フォルダを検索" : "物件ファイルを検索"}
      sub="あなたがGoogleで閲覧できる候補を検索します。名前が同じ場合は「Googleで確認」で保存先を確かめてください。"
    >
      <Form
        button="Googleの候補を表示"
        onSubmit={() => guarded(() => load(null))}
      >
        <Field label="名前で検索（空欄なら一覧）">
          <input
            disabled={busy}
            value={query}
            maxLength={100}
            onChange={(e) => {
              setQuery(e.target.value);
              setRows([]);
              setLoaded(false);
              setPage(null);
            }}
          />
        </Field>
      </Form>
      {loaded && !rows.length && (
        <Note>
          候補がありません。名前・接続アカウント・Googleでの共有権限を確認してください。検証管理・正解表は表示対象外です。
        </Note>
      )}
      {rows.map((f) => (
        <div className="product-row" key={f.id}>
          <div>
            <strong>{f.name}</strong>
            <p>
              <a
                href={`https://drive.google.com/${kind === "folder" ? "drive/folders/" : "file/d/"}${encodeURIComponent(f.id)}`}
                target="_blank"
                rel="noreferrer"
              >
                Googleで確認
              </a>
            </p>
          </div>
          <Action disabled={busy} run={() => guarded(() => choose(f))}>
            {kind === "folder" ? "この議事録フォルダを保存" : "タブを確認"}
          </Action>
        </div>
      ))}
      {page && (
        <Action disabled={busy} run={() => guarded(() => load(page))}>
          次の候補を表示
        </Action>
      )}
      <B disabled={busy} variant="ghost" onClick={close}>
        選択をやめる
      </B>
    </Section>
  );
}

function HarnessSetup({ root }) {
  const { data, error, refresh } = useData(`${root}/harness`);
  return (
    <details id="setup-customer-line">
      <summary>顧客用LINEの受信接続（Harness）</summary>
      <Note>
        顧客用LINEの受信経路を接続します。G’s検証環境では専用の小型受信アダプターを使っています。L Harness本体の管理画面・配信機能とは別の構成です。
      </Note>
      {error ? (
        <>
          <State error={error} />
          <B onClick={refresh}>接続状態を再確認</B>
        </>
      ) : data ? (
        <HarnessConnection
          base={root}
          connected={data.connected}
          done={refresh}
        />
      ) : (
        <p>接続状態を確認しています…</p>
      )}
      <p>
        接続後に友だちを取り込み、「顧客」で対象のお客様を開くと「LINEの会話を取り込む」から受信本文を確認できます。
      </p>
    </details>
  );
}
