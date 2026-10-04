import { CalendarConnection } from "./CalendarConnection.jsx";
import { useMeetingRefresh } from "./MeetingRefresh.jsx";
import React, { useState, useEffect } from "react";
import { B, Field, Section, Note, Tag, Modal } from "../platform/ui.jsx";
import { api, useData, date } from "./api.js";
import { Form, Action, State } from "./shared.jsx";
const day = (value) =>
  new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const localInput = (value) =>
  value
    ? new Date(new Date(value).getTime() + 9 * 3600000)
        .toISOString()
        .slice(0, 16)
    : "";
export function MeetingOverview({ tenant, accounts, onResult }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const reload = () =>
      Promise.all(
        accounts.map(async (a) => ({
          ...(await api(
            `/api/tenants/${tenant}/accounts/${a.id}/meeting-overview`,
          )),
          account: a,
        })),
      )
        .then((rows) => {
          if (active) {
            setData(rows);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 30000);
    window.addEventListener("focus", reload);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [tenant, accounts]);
  if (error) return <State error={error} />;
  if (!data) return <State />;
  const week = data[0]?.week;
  if (!week) return null;
  const meetings = data.flatMap((d) =>
      d.meetings.map((m) => ({
        ...m,
        oa_id: d.account.id,
        oaName: d.account.name,
      })),
    ),
    today = meetings.filter((m) => day(m.starts_at) === week.today),
    counts = week.days.map(
      (d) => meetings.filter((m) => day(m.starts_at) === d).length,
    ),
    max = Math.max(1, ...counts);
  return (
    <div className="meeting-overview-grid">
      <Section
        title="今日の面談"
        sub={`${week.today.replaceAll("-", "/")} · 日本時間 · ${today.length}件`}
      >
        {!today.length && (
          <p className="product-muted">今日の面談予定はありません。</p>
        )}
        {today.map((m) => (
          <div className="product-row" key={`${m.oa_id}:${m.id}`}>
            <div>
              <strong>
                {new Date(m.starts_at).toLocaleTimeString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                　{m.customerName}
              </strong>
              <p>
                {m.oaName} · {m.title}
              </p>
              <Tag>
                {m.unlinked
                  ? "LINEの友だち未紐付け"
                  : m.state === "attended"
                    ? "実施済み"
                    : "予約確定"}
              </Tag>
            </div>
            {!m.unlinked && (
              <B variant="secondary" onClick={() => onResult(m)}>
                面談結果
              </B>
            )}
          </div>
        ))}
      </Section>
      <Section
        title="今週のつながり"
        sub={`${week.days[0]} 〜 ${week.days[6]} · 面談日で集計（日本時間）`}
      >
        <p className="product-count">
          {meetings.length}
          <small> 件の予約</small>
        </p>
        <div
          className="meeting-week-chart"
          role="img"
          aria-label={`今週の予約。${week.days.map((d, i) => `${d} ${counts[i]}件`).join("、")}`}
        >
          {week.days.map((d, i) => (
            <div
              className={`meeting-week-day ${d === week.today ? "is-today" : ""}`}
              key={d}
            >
              <strong>{counts[i]}</strong>
              <div className="meeting-week-track">
                <span style={{ height: `${(counts[i] / max) * 100}%` }} />
              </div>
              <span>{["月", "火", "水", "木", "金", "土", "日"][i]}</span>
              <small>{d.slice(5).replace("-", "/")}</small>
            </div>
          ))}
        </div>
        <p className="product-muted">
          キャンセル・欠席を除きます。ツナグ経由に限定した獲得件数ではありません。
        </p>
      </Section>
    </div>
  );
}
export function MeetingConnections({ tenant, account, onChange }) {
  const base = `/api/tenants/${tenant}/accounts/${account.id}/connectors/drive`,
    { data, error, refresh } = useData(base),
    [folders, setFolders] = useState(false);
  const mine = data?.connections.find(
    (x) => x.mine && x.state !== "disconnected",
  );
  return (
    <Section
      title={`${account.name}の連携`}
      sub="担当者それぞれのGoogleアカウントを、この公式LINEに追加できます。"
    >
      <h3>Google Drive</h3>
      <p>
        <a
          href={`/sales/connections?tenant=${encodeURIComponent(tenant)}&oa=${encodeURIComponent(account.id)}`}
        >
          議事録・物件の接続設定へ
        </a>
      </p>
      <p>
        Googleで読み取りを承認し、議事録の保存先を選択します。
        {data &&
          (data.manualOnly
            ? "この検証環境では「今すぐ検知する」でGoogleドキュメントとテキストを手動で探します。自動巡回はありません。"
            : "保存先内のGoogleドキュメントとテキストを約5分ごとに検知します。")}
        大量のサブフォルダは順番に読み込みます。
      </p>
      {error && <State error={error} />}
      <div className="product-actions">
        <Action
          disabled={!data?.enabled}
          run={async () => {
            const r = await api(base + "/authorize", {});
            window.location.assign(r.url);
          }}
        >
          Google Driveを連携する
        </Action>
        {mine && (
          <>
            <B variant="secondary" onClick={() => setFolders((v) => !v)}>
              保存先を選ぶ
            </B>
            <Action
              run={() => api(base + "/scan", {})}
              done={() => {
                refresh();
                onChange?.();
              }}
            >
              今すぐ検知する
            </Action>
          </>
        )}
      </div>
      {data && !data.enabled && (
        <Note>Google連携のサーバー設定がまだ完了していません。</Note>
      )}
      {data?.connections
        .filter((x) => x.state !== "disconnected")
        .map((x) => (
          <div className="product-row" key={x.id}>
            <div>
              <strong>{x.email}</strong>
              <p>
                {x.folderNames.length
                  ? x.folderNames.join(" / ")
                  : "保存先を選択してください"}{" "}
                ·{" "}
                {x.state === "reconnect"
                  ? "再承認が必要"
                  : x.state === "syncing"
                    ? "検知中"
                    : "接続済み"}
              </p>
              <small>
                最終検知：{date(x.lastSync)}
                {x.remaining ? ` · 残り${x.remaining}フォルダ／ページ` : ""}
              </small>
              {x.error && <p role="alert">{x.error}</p>}
            </div>
            {x.mine && (
              <Action run={() => api(base + "/disconnect", {})} done={refresh}>
                連携を解除
              </Action>
            )}
          </div>
        ))}
      {folders && mine && (
        <FolderChooser
          base={base}
          mine={mine}
          done={() => {
            setFolders(false);
            refresh();
            onChange?.();
          }}
        />
      )}
      <CalendarConnection tenant={tenant} oa={account.id} />
      <details className="meeting-setup">
        <summary>TimeRexの連携設定</summary>
        <TimeRexSetup tenant={tenant} account={account} />
      </details>
    </Section>
  );
}
function FolderChooser({ base, mine, done }) {
  const [rows, setRows] = useState([]),
    [page, setPage] = useState(""),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState(mine.roots || []);
  const load = async (token) => {
    const r = await api(
      base + "/folders" + (token ? "?page=" + encodeURIComponent(token) : ""),
    );
    setRows((prev) => (token ? [...prev, ...r.files] : r.files));
    setPage(r.nextPageToken || "");
    setLoaded(true);
  };
  useEffect(() => {
    load("").catch((e) => setError(e.message));
  }, [base]);
  return (
    <Form
      button="選んだ保存先を監視する"
      onSubmit={(v) =>
        api(
          base + "/folders",
          { roots: selected, hostEmail: v.hostEmail, recursive: true },
          "PUT",
        )
      }
      onDone={done}
    >
      <Field label="TimeRexで使用している担当者メール">
        <input
          name="hostEmail"
          type="email"
          required
          defaultValue={mine.hostEmail || mine.email}
        />
      </Field>
      <Field label="フォルダ名で絞り込み">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="例：Meet Recordings"
        />
      </Field>
      {error && <State error={error} />}
      {!loaded && !error && <State />}
      <div className="meeting-folder-list">
        {rows
          .filter((x) => x.name.toLowerCase().includes(search.toLowerCase()))
          .map((f) => (
            <label key={f.id}>
              <input
                type="checkbox"
                checked={selected.includes(f.id)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked
                      ? [...prev, f.id]
                      : prev.filter((x) => x !== f.id),
                  )
                }
              />
              {f.name}
            </label>
          ))}
      </div>
      {page && (
        <Action type="button" run={() => load(page)}>
          さらにフォルダを表示
        </Action>
      )}
      <p>
        {selected.length}
        フォルダ選択中。会議ごとのサブフォルダも含みます。担当者はご自身のログインからGoogle
        Driveを連携してください。
      </p>
    </Form>
  );
}
function TimeRexSetup({ tenant, account }) {
  const base = `/api/tenants/${tenant}/accounts/${account.id}/connectors/timerex-setup`,
    { data, error, refresh } = useData(base),
    [message, setMessage] = useState("");
  if (!data) return <State error={error} />;
  return (
    <div className="product-stack">
      <p>
        TimeRexの対象カレンダーのWebhook設定に、下記のURLを貼ってください。予約確定・キャンセルを有効にします。
      </p>
      <Field label={`${account.name}専用のWebhook URL`}>
        <input
          readOnly
          value={data.webhookUrl}
          onFocus={(e) => e.target.select()}
        />
      </Field>
      <div className="product-actions">
        <Action run={() => navigator.clipboard.writeText(data.webhookUrl)}>
          URLをコピー
        </Action>
        <a
          className="meeting-link-button"
          href={data.settingsUrl}
          target="_blank"
          rel="noreferrer"
        >
          TimeRexに連携する ↗
        </a>
      </div>
      <p>
        チーム設定 → デベロッパーツール →
        Webhook。初回はTimeRexでチームを選択してください。
      </p>
      <Form
        button="接続設定を保存"
        onSubmit={(v) =>
          api(
            base,
            {
              ...(v.secret ? { secret: v.secret } : {}),
              ...(v.settingsUrl ? { settingsUrl: v.settingsUrl } : {}),
            },
            "PUT",
          )
        }
        onDone={refresh}
      >
        {!data.environmentManaged && (
          <Field
            label={
              data.configured
                ? "Security Token（変更時のみ）"
                : "TimeRexに表示されるSecurity Token"
            }
          >
            <input
              type="password"
              name="secret"
              autoComplete="new-password"
              minLength={8}
            />
          </Field>
        )}
        <Field label="次回から開くTimeRex設定画面のURL（任意）">
          <input
            name="settingsUrl"
            type="url"
            placeholder="TimeRexで開いた設定ページのURL"
            defaultValue={
              data.settingsUrl === "https://timerex.net/user"
                ? ""
                : data.settingsUrl
            }
          />
        </Field>
      </Form>
      <Action
        disabled={!data.configured}
        run={async () => {
          const r = await api(base + "/test", {});
          setMessage(r.message);
        }}
        done={refresh}
      >
        Webhook認証をテスト
      </Action>
      {message && <p role="status">{message}</p>}
      <p>
        認証設定：{data.configured ? "登録済み" : "未登録"}
        <br />
        認証テスト：{date(data.selfTest?.at)}
        <br />
        TimeRexからの実受信：{date(data.lastWebhook?.at)}
        {data.lastWebhook && ` · ${data.lastWebhook.result.event}`}
      </p>
      {!data.lastWebhook && (
        <Note>
          新しい受信記録はまだありません。対象カレンダーでテスト予約を作成し、受信後にキャンセルしてください。
        </Note>
      )}
      <Action
        run={async () => {
          refresh();
        }}
      >
        受信状況を更新
      </Action>
    </div>
  );
}
export function MeetingInbox({
  tenant,
  account,
  appointment,
  onLinked,
  revision = 0,
}) {
  const base = `/api/tenants/${tenant}/accounts/${account.id}/meeting-inbox`,
    { data, error, refresh } = useData(
      base +
        (appointment
          ? "?appointmentId=" + encodeURIComponent(appointment.id)
          : ""),
    ),
    [selected, setSelected] = useState(null),
    [limit, setLimit] = useState(8);
  useEffect(() => {
    refresh();
  }, [revision]);
  if (error) return <State error={error} />;
  if (!data) return <State />;
  const docs = data.documents.filter((d) =>
    appointment
      ? d.state !== "linked" || d.appointment_id === appointment.id
      : true,
  );
  const doc = selected && data.documents.find((x) => x.id === selected);
  return (
    <Section
      title={
        appointment
          ? "この面談に議事録を紐付ける"
          : `${account.name} · 議事録の更新`
      }
      sub="約5分ごとに新規・更新を確認します。紐付け済みの原文は自動で再解析し、各画面と提案へ反映します。"
    >
      <div className="product-actions">
        <Tag>{docs.length}件</Tag>
        <Action run={async () => refresh()}>一覧を更新</Action>
      </div>
      {!docs.length && (
        <p className="product-muted">
          検知した議事録はありません。Google
          Driveの連携と保存先を確認してください。
        </p>
      )}
      {docs.slice(0, limit).map((d) => (
        <div className="product-row" key={d.id}>
          <div>
            <h3>{d.title}</h3>
            <p>
              {d.source_email} ·{" "}
              {d.held_at ? date(d.held_at) : "会議日時は選択時に確認"}
            </p>
            {d.auto_detail && <p>{d.auto_detail}</p>}
            <Tag>
              {
                {
                  draft: "解析済み・確認待ち",
                  analyzing: "解析中",
                  applying: "保存の再試行が必要",
                  linked: "紐付け済み",
                  error: "解析を再試行",
                  unlinked: "未紐付け",
                }[d.state]
              }
            </Tag>
          </div>
          <B variant="secondary" onClick={() => setSelected(d.id)}>
            {d.state === "linked" ? "議事録を確認" : "友だちに紐付ける"}
          </B>
        </div>
      ))}
      {docs.length > limit && (
        <B variant="secondary" onClick={() => setLimit((n) => n + 20)}>
          さらに表示
        </B>
      )}
      {doc && (
        <Modal
          open={true}
          title="議事録と友だちを紐付ける"
          onClose={() => setSelected(null)}
          wide
        >
          <InboxDocument
            key={doc.id}
            base={base}
            doc={doc}
            appointment={appointment}
            done={() => {
              refresh();
              onLinked?.();
            }}
            close={() => setSelected(null)}
          />
        </Modal>
      )}
    </Section>
  );
}
function InboxDocument({ base, doc, appointment, done, close }) {
  const { data, error } = useData(`${base}/${doc.id}/candidates`),
    [customer, setCustomer] = useState(
      appointment?.customer_id || doc.customer_id || "",
    ),
    [search, setSearch] = useState(""),
    [reAnalyze, setReAnalyze] = useState(false),
    [sourceRevision, setSourceRevision] = useState(0);
  const recovery = useMeetingRefresh(
    base.replace(/\/meeting-inbox$/, ""),
    doc.id,
    async () => {
      setReAnalyze(true);
      setSourceRevision((n)=>n+1);
      done();
    },
  );
  if (!data) return <State error={error} />;
  const extract = doc.analysis,
    options = data.candidates.filter(
      (c) =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.id === customer,
    ),
    appointments = data.appointments.filter(
      (a) => a.customerId === customer && new Date(a.startsAt) <= new Date(),
    );
  return (
    <div className="product-stack">
      <a href={doc.fileUrl} target="_blank" rel="noreferrer">
        {doc.fileLabel || "Google Driveで原文を開く"} ↗
      </a>
      <h3>{doc.title}</h3>
      {recovery.recovery}
      {(!extract || reAnalyze) && doc.state !== "linked" && (
        <Form
          key={`${doc.version}:${sourceRevision}`}
          button={
            doc.demo
              ? "デモ原文を読み込む（AI未接続）"
              : "選んだ友だちの議事録としてAI解析する"
          }
          onSubmit={(v) =>
            api(`${base}/${doc.id}/analyze`, {
              version: doc.version,
              customerId: customer,
              appointmentId: v.appointmentId || null,
              heldAt: new Date(v.heldAt + ":00+09:00").toISOString(),
            })
          }
          onDone={done}
          onError={recovery.onError}
        >
          <Field label="友だちを検索">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="氏名で検索"
            />
          </Field>
          <Field label="紐付ける友だち">
            <select
              required
              value={customer}
              disabled={!!appointment}
              onChange={(e) => setCustomer(e.target.value)}
            >
              <option value="">候補と根拠を確認して選択</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.score ? ` · ${c.reason}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="会議日時（日本時間）">
            <input
              name="heldAt"
              type="datetime-local"
              required
              defaultValue={localInput(appointment?.starts_at || doc.held_at)}
            />
          </Field>
          <Field label="紐付ける面談（予約がある場合）">
            <select
              key={customer}
              name="appointmentId"
              defaultValue={appointment?.id || doc.appointment_id || ""}
            >
              <option value="">予約なし・友だちに直接紐付ける</option>
              {appointments.map((a) => (
                <option key={a.id} value={a.id}>
                  {date(a.startsAt)} · {a.title}
                </option>
              ))}
            </select>
          </Field>
          <Note>
            選んだ1件の議事録をAIに送って解析します。結果を確認して保存すると、商談の状況と追客トリガーに反映されます。
          </Note>
        </Form>
      )}
      {extract && !reAnalyze && (
        <>
          <p>
            <strong>紐付け先：</strong>
            {data.candidates.find((c) => c.id === doc.customer_id)?.name}
          </p>
          <h3>商談の内容</h3>
          <p>{extract.summary}</p>
          <dl className="meeting-analysis">
            <dt>商談状況</dt>
            <dd>
              {
                {
                  won: "成約",
                  lost: "失注",
                  negotiating: "商談中",
                  uncontracted: "未契約",
                  unknown: "不明",
                }[extract.dealState]
              }
            </dd>
            <dt>話したこと</dt>
            <dd>{extract.keyPoints.join(" / ")}</dd>
            <dt>懸念点</dt>
            <dd>{extract.concerns.join(" / ") || "記録なし"}</dd>
            <dt>次のアクション</dt>
            <dd>{extract.nextAction}</dd>
          </dl>
          <h3>追客トリガー</h3>
          {extract.triggers.length ? (
            extract.triggers.map((t, i) => (
              <p key={i}>
                {date(
                  new Date(
                    new Date(doc.held_at).getTime() + t.daysAfter * 86400000,
                  ).toISOString(),
                )}{" "}
                · {t.intent}
              </p>
            ))
          ) : (
            <p>議事録から明確な予定は見つかりませんでした。</p>
          )}
          <Note>
            原文で確認できた予定は、指定日以降に自動で候補へ取り込みます。契約済み・失注・追客停止中は対象外です。
          </Note>
          {["draft", "applying"].includes(doc.state) && (
            <>
              <Action
                variant="primary"
                onError={recovery.onError}
                run={() =>
                  api(`${base}/${doc.id}/confirm`, {
                    version: doc.version,
                    confirmed: true,
                  })
                }
                done={() => {
                  done();
                  close();
                }}
              >
                内容を確認して紐付け・設定を保存
              </Action>
              {doc.state !== "applying" && (
                <B variant="secondary" onClick={() => setReAnalyze(true)}>
                  相手や日時を変更して再解析
                </B>
              )}
            </>
          )}
        </>
      )}
      {doc.state === "error" && (
        <>
          <Note>{doc.auto_detail || "解析結果の確認が必要です。"}</Note>
          <B variant="secondary" onClick={() => setReAnalyze(true)}>
            原文・相手を確認して再解析
          </B>
        </>
      )}
      {doc.state === "unlinked" && (
        <Action
          run={() => api(`${base}/${doc.id}/ignore`, { version: doc.version })}
          done={() => {
            done();
            close();
          }}
        >
          商談ではないため一覧から除外
        </Action>
      )}
    </div>
  );
}
