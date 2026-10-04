import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api.js";
import { B, Brand } from "../platform/ui.jsx";
import "./self-demo.css";

const STAFF = "https://lin.ee/yV6rgH7",
  CUSTOMER = "https://line.me/R/ti/p/%40302klzlz";
const sample =
  "【体験用・架空の面談メモ】\nお客様：自分（体験用）\n希望条件：渋谷区で購入物件を探しています。予算は5,500万円以内、2LDK、所有権、駅徒歩10分以内が必須です。定期借地権は除外します。\n気になった物件があれば、日程を選んで住まい相談を予約したいです。";
const fmt = (v) =>
  v ? new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—";
function QR({ url }) {
  const [data, setData] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { width: 160, margin: 1 }).then(
      (v) => live && setData(v),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return data ? (
    <img
      src={data}
      width="144"
      height="144"
      alt="スマートフォンで友だち追加するQRコード"
    />
  ) : null;
}
function Step({ n, title, done, children }) {
  return (
    <section className="demo-step">
      <div className="demo-step-heading">
        <span className={done ? "demo-number complete" : "demo-number"}>
          {done ? "✓" : n}
        </span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
function Pair({ kind, status, pending, run, base, reload }) {
  const [pair, setPair] = useState(null),
    [code, setCode] = useState("");
  const staff = kind === "staff";
  const ready = staff ? status?.state === "active" : !!status;
  return (
    <div>
      <p>
        {staff
          ? "あなたを営業担当者として登録します。新着の提案が届き、LINEから編集・承認・見送りができます。"
          : "あなた自身をお客様として登録します。承認した追客文と予約完了の通知が、このアカウントから届きます。"}
      </p>
      {ready ? (
        <p className="demo-success">
          ✓{" "}
          {staff
            ? "通知用LINEの本人確認が完了しました。"
            : `${status.name} として連携できました。`}
        </p>
      ) : (
        <>
          {pending && <p className="demo-muted">前回の本人確認は保存途中です。確認メッセージを再発行して続けられます。</p>}
          <div className="demo-line-add">
            <QR url={staff ? STAFF : CUSTOMER} />
            <div>
              <a
                className="demo-button"
                href={staff ? STAFF : CUSTOMER}
                target="_blank"
                rel="noreferrer"
              >
                {staff
                  ? "① つなぐ通知用LINEを追加"
                  : "① G’s不動産・顧客用LINEを追加"}
              </a>
              <p>
                <small>
                  {staff ? "@876qqbck" : "@302klzlz"} ／
                  PCの場合はスマートフォンでQRを読み取ります。
                </small>
              </p>
            </div>
          </div>
          <button
            className="demo-button secondary"
            onClick={() =>
              run(async () =>
                setPair(
                  await api(
                    staff ? base + "/pair" : "/api/demo/customer/pair",
                    {},
                  ),
                ),
              )
            }
          >
            {pair ? "確認メッセージを再発行" : "② 本人確認メッセージを作る"}
          </button>
          {pair && (
            <div className="demo-pair">
              <p>
                ③ 下のメッセージをコピーし、追加した
                <strong>{staff ? "通知用" : "顧客用"}</strong>
                LINEのトークへ送ってください。
              </p>
              <textarea
                readOnly
                value={pair.text || pair.message || "連携 " + pair.token}
                rows={3}
                aria-label="LINEに送る本人確認メッセージ"
              />
              <button
                className="demo-button secondary"
                onClick={() =>
                  run(() =>
                    navigator.clipboard.writeText(
                      pair.text || pair.message || "連携 " + pair.token,
                    ),
                  )
                }
              >
                メッセージをコピー
              </button>
              <small>
                有効期限：{fmt(pair.expiresAt)}。期限が切れたら再発行できます。
              </small>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await api(
                      staff ? base + "/confirm" : "/api/demo/customer/confirm",
                      { code },
                    );
                    setCode("");
                    setPair(null);
                    await reload();
                  });
                }}
              >
                <label>
                  ④ このLINEに返信された本人確認コード
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoComplete="one-time-code"
                    placeholder="例：a12b34c56d78"
                  />
                </label>
                <button className="demo-button" type="submit">
                  本人確認を完了する
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function DocumentCard({ d, run, reload }) {
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(d.body),
    [title, setTitle] = useState(d.title);
  return (
    <article className="demo-item">
      <h3>{d.title}</h3>
      <p className="demo-muted">
        版 {d.version} · {fmt(d.held_at)} ·{" "}
        {
          {
            unlinked: "紐付け待ち",
            queued: "解析待ち",
            processing: "解析中",
            ready: "解析済み",
            error: "内容の確認が必要",
          }[d.state]
        }
      </p>
      {d.error && (
        <p role="alert" className="demo-error">
          {d.error}
        </p>
      )}
      {d.analysis?.summary && (
        <>
          <p>{d.analysis.summary}</p>
          {d.analysis.applied === false && <p className="demo-muted">{d.analysis.reason}</p>}
          {d.analysis.wish && <p className="demo-success">
            {d.analysis.applied === false ? "この議事録の条件" : "希望条件"}：{d.analysis.wish.area || "エリアの記載なし"} /{" "}
            {d.analysis.wish.maxPrice ? `${d.analysis.wish.maxPrice.toLocaleString()}円以内` : "予算の記載なし"} /{" "}
            {d.analysis.wish.required?.join("・") || "その他の条件なし"}
          </p>}
        </>
      )}
      <details>
        <summary>議事録の原文を見る</summary>
        <pre>{d.body}</pre>
      </details>
      {!editing ? (
        <div className="demo-actions">
          {["unlinked", "error"].includes(d.state) && (
            <button
              className="demo-button"
              onClick={() =>
                run(async () => {
                  await api(`/api/demo/documents/${d.id}/link`, {
                    version: d.version,
                  });
                  await reload();
                }, "議事録を解析し、希望条件に合う提案を作っています。1分ほどかかる場合があります。")
              }
            >
              {d.state === "error"
                ? (d.analysis?.extraction ? "原文との対応を再確認する" : "解析をやり直す")
                : "自分のお客様に紐付けて解析する"}
            </button>
          )}
          {d.state === "error" && d.analysis?.extraction && (
            <button className="demo-button secondary" onClick={() => run(async () => {
              await api(`/api/demo/documents/${d.id}/link`, {version:d.version,reextract:true});
              await reload();
            }, "AIで改めて解析しています。利用枠を1回使用します。")}>AIで解析し直す（1回分）</button>
          )}
          <button
            className="demo-button secondary"
            disabled={d.state === "processing"}
            onClick={() => {
              setBody(d.body);
              setTitle(d.title);
              setEditing(true);
            }}
          >
            内容を更新する
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api(
                `/api/demo/documents/${d.id}`,
                { title, body, heldAt: d.held_at, version: d.version },
                "PUT",
              );
              setEditing(false);
              await reload();
            }, "更新した議事録を解析しています。");
          }}
        >
          <label>
            タイトル
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label>
            本文
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              minLength={20}
              maxLength={20000}
              required
            />
          </label>
          <button className="demo-button">更新して自動解析</button>
          <button
            type="button"
            className="demo-button secondary"
            onClick={() => setEditing(false)}
          >
            戻る
          </button>
        </form>
      )}
    </article>
  );
}
function Proposal({ p, run, reload }) {
  const [edit, setEdit] = useState(false),
    [draft, setDraft] = useState(p.draft),
    [category, setCategory] = useState("auto"),
    [note, setNote] = useState(""),
    [reason, setReason] = useState("unspecified");
  const active = p.state === "pending" || p.state === "approved";
  const action = (action, extra = {}) =>
    run(
      async () => {
        const result = await api(`/api/demo/proposals/${p.id}/action`, {
          version: p.version,
          action,
          ...extra,
        });
        setEdit(false);
        await reload();
        if (action === "approve" && result.state !== "sent")
          throw Error(
            "送信状態：" +
              (result.state || "確認中") +
              "。最新の状態をご確認ください。",
          );
      },
      action === "approve"
        ? "承認した文面を、自分の顧客用LINEへ送っています。"
        : "変更を保存しています。",
    );
  return (
    <article className="demo-item">
      <div className="demo-proposal-top">
        <span className="demo-tag">
          {{
            pending: "確認待ち",
            approved: "送信待ち",
            sent: "送信済み",
            held: "再確認",
            cancelled: "見送り",
            uncertain: "送信結果の確認が必要",
            sending: "送信中",
          }[p.state] || p.state}{" "}
          · 版 {p.version}
        </span>
        <small>
          通知：
          {{
            sent: "LINEへ送信済み",
            queued: "準備中",
            uncertain: "結果確認中",
          }[p.notice] || "未通知"}
        </small>
      </div>
      <p>{p.reason}</p>
      <pre>{p.draft}</pre>
      <small>{p.evidence.draftDetail}</small>
      {p.hold_reason && <p className="demo-error">{p.hold_reason}</p>}
      {active &&
        (!edit ? (
          <>
            <div className="demo-actions">
              <button className="demo-button" onClick={() => action("approve")}>
                この文面を自分のLINEへ送る
              </button>
              <button
                className="demo-button secondary"
                onClick={() => {
                  setDraft(p.draft);
                  setEdit(true);
                }}
              >
                文面を編集する
              </button>
            </div>
            <details>
              <summary>見送る・あとで確認する</summary>
              <label>
                理由
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  <option value="unspecified">未選択</option>
                  <option value="timing">タイミング</option>
                  <option value="not_fit">条件が合わない</option>
                  <option value="incorrect">事実に誤り</option>
                  <option value="tone">文体</option>
                  <option value="duplicate">重複</option>
                </select>
              </label>
              <label>
                次回のためのメモ
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                />
              </label>
              <div className="demo-actions">
                <button
                  className="demo-button secondary"
                  onClick={() =>
                    action("cancel", { feedback: { reason, note } })
                  }
                >
                  見送る
                </button>
                <button
                  className="demo-button secondary"
                  onClick={() =>
                    action("later", { feedback: { reason, note } })
                  }
                >
                  4時間あとにする
                </button>
              </div>
            </details>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action("edit", { draft, learning: { category, note } });
            }}
          >
            <label>
              送信する文面
              <textarea
                rows={8}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                required
                maxLength={2000}
              />
            </label>
            <label>
              変更の種類
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="auto">自動で分類</option>
                <option value="style">言い回し・文体</option>
                <option value="fact">事実の訂正</option>
                <option value="customer">このお客様の事情</option>
              </select>
            </label>
            <label>
              補足
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </label>
            <p>
              <small>
                文体は承認後の文章を次回の参考にします。事実訂正・顧客固有の事情は分けて記録します。
              </small>
            </p>
            <button className="demo-button">編集を保存して再確認</button>
            <button
              type="button"
              className="demo-button secondary"
              onClick={() => setEdit(false)}
            >
              戻る
            </button>
          </form>
        ))}
    </article>
  );
}
export function SelfDemo({ me }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [library, setLibrary] = useState(null),
    [body, setBody] = useState(sample),
    [title, setTitle] = useState("【体験用】希望条件の初回面談"),
    [openAll, setOpenAll] = useState(false);
  const load = async () => {
    const d = await api("/api/demo");
    setData(d);
    return d;
  };
  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (document.visibilityState === "visible")
        api("/api/demo")
          .then((d) => alive && setData(d))
          .catch((e) => alive && setError(e.message));
    };
    poll();
    const timer = setInterval(poll, 10000);
    window.addEventListener("focus", poll);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, []);
  const run = async (fn, message = "処理しています…") => {
    if (busy) return;
    setBusy(message);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  if (!data)
    return (
      <main className="demo-shell">
        <Brand />
        <p>{error || "体験の準備を確認しています…"}</p>
      </main>
    );
  const base = `/api/tenants/${data.tenant}/assistant-line`,
    notifying =
      data.notificationsUntil &&
      data.notificationsUntil > new Date().toISOString();
  return (
    <main className="demo-shell">
      <header className="demo-header">
        <Brand />
        <a href="/demo" className="demo-tag">
          G’s 提出用・実機体験
        </a>
        <button
          className="demo-link"
          onClick={() =>
            run(async () => {
              await api("/api/auth/sign-out", {});
              location.assign("/login");
            })
          }
        >
          ログアウト
        </button>
      </header>
      <div className="demo-intro">
        <span className="demo-eyebrow">
          自分がお客様になって、つなぐを体験。
        </span>
        <h1>
          情報を足すと、
          <br />
          次のご連絡が届く。
        </h1>
        <p>
          Googleログインから、2つのLINE接続、議事録・物件、追客文の編集と送信、日程予約まで。担当者の同席なしで、その場で試せます。
        </p>
        <p className="demo-muted">
          初回の目安 10〜15分 ／ スマートフォンのLINEを用意してください。
        </p>
      </div>
      {error && (
        <div role="alert" className="demo-error sticky">
          {error}
          <button className="demo-link" onClick={() => setError("")}>
            閉じる
          </button>
        </div>
      )}
      {busy && (
        <div role="status" aria-live="polite" className="demo-progress">
          {busy}
        </div>
      )}
      <fieldset disabled={!!busy} className="demo-fieldset">
        <Step n="1" title="Googleでログイン" done>
          <p>
            {me.user.name} / {me.user.email}
          </p>
          {!data.started && (
            <>
              <p>
                共通の架空物件・議事録を使い、あなた専用のお客様で試します。承認するまで追客文は送信されません。
              </p>
              <button
                className="demo-button"
                onClick={() =>
                  run(async () => {
                    await api("/api/demo/start", {});
                    await load();
                  })
                }
              >
                体験をはじめる
              </button>
            </>
          )}
        </Step>
        {data.started && (
          <>
            <Step
              n="2"
              title="提案が届く「つなぐ通知用LINE」"
              done={data.staff?.state === "active"}
            >
              <Pair
                kind="staff"
                status={data.staff}
                run={run}
                base={base}
                reload={load}
              />
              {data.staff?.state === "active" && (
                <div className="demo-actions">
                  <button
                    className="demo-button"
                    onClick={() =>
                      run(async () => {
                        await api("/api/demo/notifications", {
                          enabled: !notifying,
                        });
                        await load();
                      })
                    }
                  >
                    {notifying
                      ? "通知を停止する"
                      : "これから2時間、体験通知を受け取る"}
                  </button>
                  {notifying && (
                    <small>
                      {fmt(data.notificationsUntil)}{" "}
                      まで。夜間でもこの時間内だけ通知します。
                    </small>
                  )}
                </div>
              )}
            </Step>
            <Step
              n="3"
              title="お客様役になる「G’s不動産LINE」"
              done={!!data.customer}
            >
              <Pair
                kind="customer"
                pending={data.customerPairPending}
                status={data.customer}
                run={run}
                base={base}
                reload={load}
              />
            </Step>
            {data.customer && (
              <>
                <Step
                  n="4"
                  title="議事録を自分のお客様に紐付ける"
                  done={data.documents.some((d) => d.state === "ready")}
                >
                  <p>
                    実際に解析する共通の議事録を選ぶか、その場でメモを追加できます。名前が異なる共通素材も、体験用としてあなた自身に紐付けます。
                  </p>
                  <button
                    className="demo-button secondary"
                    onClick={() =>
                      run(async () =>
                        setLibrary(await api("/api/demo/library")),
                      )
                    }
                  >
                    共通の議事録から選ぶ
                  </button>
                  {library && (
                    <div className="demo-library">
                      {library.documents.map((d) => (
                        <button
                          key={d.id}
                          onClick={() =>
                            run(async () => {
                              await api(`/api/demo/library/${d.id}/copy`, {});
                              setLibrary(null);
                              await load();
                            })
                          }
                        >
                          {d.title}
                          <span>取り込んで確認 →</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <details open={!data.documents.length}>
                    <summary>その場で議事録を追加する（見本入り）</summary>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(async () => {
                          await api("/api/demo/documents", {
                            title,
                            body,
                            heldAt: new Date().toISOString(),
                          });
                          await load();
                        });
                      }}
                    >
                      <label>
                        タイトル
                        <input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          required
                          maxLength={200}
                        />
                      </label>
                      <label>
                        議事録・電話メモ
                        <textarea
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                          rows={7}
                          required
                          minLength={20}
                          maxLength={20000}
                        />
                      </label>
                      <label>
                        テキストファイルから読み込む
                        <input
                          type="file"
                          accept=".txt,.md,text/plain"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f)
                              run(async () => {
                                if (f.size > 80000)
                                  throw Error(
                                    "80KB以内のテキストを選んでください。",
                                  );
                                setBody((await f.text()).slice(0, 20000));
                                setTitle(f.name.replace(/\.(txt|md)$/i, ""));
                              });
                          }}
                        />
                      </label>
                      <button className="demo-button">議事録を追加する</button>
                    </form>
                  </details>
                  {data.documents.map((d) => (
                    <DocumentCard key={d.id} d={d} run={run} reload={load} />
                  ))}
                </Step>
                <Step
                  n="5"
                  title="物件を追加・更新し、自動提案を待つ"
                  done={data.proposals.length > 0}
                >
                  <p>
                    共通の商品マスターを自動で照合します。下のフォームから自分の体験用物件も追加できます。希望条件に合うと文案が自動生成され、通知用LINEに届きます。
                  </p>
                  <details>
                    <summary>
                      共通・自分用の物件を見る（
                      {
                        data.sources.filter((s) => s.data.kind === "product")
                          .length
                      }
                      件）
                    </summary>
                    <div className="demo-library">
                      {data.sources
                        .filter((s) => s.data.kind === "product")
                        .map((s) => (
                          <div key={s.id}>
                            <strong>{s.title}</strong>
                            <small>
                              {s.data.area} / {s.data.price?.toLocaleString()}円
                              / {s.data.tags?.join("・")} /{" "}
                              {s.data.status === "available"
                                ? "販売中"
                                : "要確認"}
                            </small>
                            <a
                              href={`/demo/property/${s.id}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              内容を見る
                            </a>
                            {s.id.startsWith("demo-property-") &&
                              s.data.status === "available" && (
                                <button
                                  className="demo-link"
                                  onClick={() =>
                                    run(async () => {
                                      await api("/api/demo/properties", {
                                        title: s.title,
                                        area: s.data.area,
                                        price: s.data.price,
                                        layout: s.data.property.layout,
                                        walkingMinutes:
                                          s.data.property.walkingMinutes,
                                        status: "sold",
                                        sourceId: s.id,
                                        version: s.version,
                                      });
                                      await load();
                                    })
                                  }
                                >
                                  売約済みに更新する
                                </button>
                              )}
                          </div>
                        ))}
                    </div>
                  </details>
                  <details open={!data.proposals.length}>
                    <summary>物件をその場で追加する</summary>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = Object.fromEntries(
                          new FormData(e.currentTarget),
                        );
                        run(async () => {
                          await api("/api/demo/properties", {
                            ...v,
                            price: Number(v.price) * 10000,
                            walkingMinutes: Number(v.walkingMinutes),
                          });
                          await load();
                        }, "物件情報を照合し、条件が合えば追客文を作っています。");
                      }}
                    >
                      <label>
                        物件名
                        <input
                          name="title"
                          defaultValue="渋谷のテストマンション 301号室"
                          required
                          maxLength={160}
                        />
                      </label>
                      <div className="demo-grid">
                        <label>
                          エリア
                          <input name="area" defaultValue="渋谷区" required />
                        </label>
                        <label>
                          価格（万円）
                          <input
                            name="price"
                            type="number"
                            defaultValue="4800"
                            min="1"
                            required
                          />
                        </label>
                        <label>
                          間取り
                          <select name="layout" defaultValue="2LDK">
                            <option>1LDK</option>
                            <option>2LDK</option>
                            <option>3LDK</option>
                            <option>4LDK</option>
                          </select>
                        </label>
                        <label>
                          駅徒歩（分）
                          <input
                            name="walkingMinutes"
                            type="number"
                            defaultValue="5"
                            min="0"
                            max="60"
                            required
                          />
                        </label>
                      </div>
                      <small>所有権・販売中の架空物件として追加します。</small>
                      <button className="demo-button">物件を追加する</button>
                    </form>
                  </details>
                  {!data.proposals.length && (
                    <p className="demo-muted">
                      議事録の解析後、物件のエリア・予算・間取りを確認します。不一致の場合は文案を作りません。共通ファイルの変更は通常5分以内に検知します。
                    </p>
                  )}
                </Step>
                <Step
                  n="6"
                  title="文案を確認して、自分のLINEへ送る"
                  done={data.proposals.some((p) => p.state === "sent")}
                >
                  <p>
                    通知用LINEのカードでも、この画面でも操作できます。送信すると顧客用LINEからあなたへ届きます。
                  </p>
                  <small>
                    本日のAI利用枠：残り {data.aiRemaining}{" "}
                    回。編集と承認はAIを使いません。
                  </small>
                  {data.proposals.length ? (
                    data.proposals
                      .filter(
                        (p) =>
                          openAll ||
                          [
                            "pending",
                            "approved",
                            "sent",
                            "sending",
                            "uncertain",
                          ].includes(p.state),
                      )
                      .map((p) => (
                        <Proposal
                          key={p.id + ":" + p.version}
                          p={p}
                          run={run}
                          reload={load}
                        />
                      ))
                  ) : (
                    <p className="demo-muted">
                      条件に合う情報から、ここに提案を用意します。画面は10秒ごとに自動更新します。
                    </p>
                  )}
                  <button
                    className="demo-link"
                    onClick={() => setOpenAll(!openAll)}
                  >
                    {openAll
                      ? "現在の提案だけ表示"
                      : "過去・見送り・再確認の提案も表示"}
                  </button>
                  {data.feedback.length > 0 && (
                    <details>
                      <summary>編集・承認・見送りの記録を見る</summary>
                      {data.feedback.map((f, i) => (
                        <p key={i}>
                          {fmt(f.at)} / {f.action} / {f.category}
                          {f.note ? " / " + f.note : ""}
                        </p>
                      ))}
                    </details>
                  )}
                </Step>
                <Step
                  n="7"
                  title="届いた追客LINEから、日程を予約する"
                  done={data.bookings.some((b) => b.state === "booked")}
                >
                  <p>
                    顧客用LINEに届いた文章の「日程予約（体験用）」を開き、日時を選んでください。予約完了がLINEへ届き、予約前の追客提案は停止します。
                  </p>
                  <a
                    className="demo-button secondary"
                    href={data.bookingUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    自分の予約ページを開く
                  </a>
                  {data.bookingConfigured === false && <p className="demo-muted">予約通知の接続を準備中です。接続完了後に日程を選べます。</p>}
                  {data.bookings.map((b) => (
                    <p key={b.id} className="demo-success">
                      {b.state === "cancelled" ? "取消済み" : "予約済み"}：
                      {fmt(b.starts_at)} / LINE通知：
                      {b.notice_state === "accepted"
                        ? "送信済み"
                        : b.notice_state === "uncertain"
                          ? "送信結果の確認が必要"
                          : b.notice_state === "failed"
                            ? "未送信（友だち追加・送信上限を確認）"
                            : "処理中"}
                    </p>
                  ))}
                  <p className="demo-muted">
                    体験用予約のため、実際の接客・内見は行いません。TimeRexの完了メールから変更・取消も試せます。体験後は予約を取り消してください。
                  </p>
                </Step>
                <Step n="8" title="もう一度、条件を変えて試す">
                  <p>
                    議事録のエリア・予算を更新して、その条件に合う物件を追加できます。「物件を売約済みにする」「条件に合わない物件を足す」「古いLINEカードから承認する」も試せます。送るべきでない案は停止します。
                  </p>
                  <p>
                    予約後は追客を停止します。予約を取り消してから、議事録を更新すると次の提案を確認できます。
                  </p>
                  <button
                    className="demo-button secondary"
                    onClick={() =>
                      run(async () => {
                        await api("/api/demo/finish", {});
                        await load();
                      })
                    }
                  >
                    体験を終えて、通知を停止する
                  </button>
                </Step>
              </>
            )}
          </>
        )}
      </fieldset>
      <footer className="demo-footer">
        自分のLINE宛のみ送信 ／ 共通素材は架空データ ／
        操作途中でも同じGoogleアカウントで再開できます。
        {!me.demoOnly && (
          <p>
            <a href="/sales">通常の営業画面へ戻る</a>
          </p>
        )}
      </footer>
    </main>
  );
}
export function PublicDemoPage({ path }) {
  const booking = path.startsWith("/demo/book/"),
    key = path.split("/").at(-1),
    url = booking ? "/api/demo-bookings/" + key : "/api/demo-property/" + key;
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [date, setDate] = useState("");
  const load = () =>
    api(url)
      .then((value) => { setData(value); setError(""); })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    if (!booking) return;
    const refresh = () => { if (document.visibilityState === "visible") load(); };
    const timer = setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [url]);
  const submit = async (action) => {
    setBusy(true);
    setError("");
    try {
      const r = await api(url, {
        action,
        version: data.booking?.version || 0,
        ...(action !== "cancel"
          ? { startsAt: new Date(date + ":00+09:00").toISOString() }
          : {}),
      });
      setData(r);
    } catch (e) {
      setError(e.message);
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="demo-shell demo-public">
      <Brand />
      <p className="demo-tag">G’s不動産・体験用</p>
      {error && (
        <p className="demo-error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p>確認しています…</p>
      ) : booking ? (
        <>
          <h1>{data.title}</h1>
          <p>{data.message}</p>
          {data.booking && (
            <div className="demo-step">
              <h2>
                {data.booking.state === "cancelled"
                  ? "予約取消済み"
                  : "予約内容"}
              </h2>
              <p>{fmt(data.booking.starts_at)}</p>
              <p>
                LINE通知：
                {data.booking.notice_state === "accepted"
                  ? "送信済み"
                  : data.booking.notice_state === "uncertain"
                    ? "送信結果を確認中です。重複送信を避けるため再送は行いません。"
                    : data.booking.notice_state === "failed"
                      ? "通知未送信です。予約自体は保存できています。"
                      : "準備中"}
              </p>
            </div>
          )}
          {data.mode === "timerex" ? (
            <div className="demo-step">
              {data.configured !== false && <a
                className="demo-button"
                href={data.timerexUrl}
                target="_blank"
                rel="noreferrer"
              >
                TimeRexで空き日時を選ぶ
              </a>}
              {data.configured !== false && <p>
                予約が完了すると、顧客用LINEに確認が届きます。TimeRexの完了メールから日時の変更・取消ができます。
              </p>}
              <p className="demo-muted">予約結果はこの画面にも自動で反映されます。</p>
              <button className="demo-button secondary" onClick={load}>
                予約結果を確認する
              </button>
              {data.booking?.details_url && (
                <p>
                  <a
                    href={data.booking.details_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    TimeRexで予約を確認・取り消す
                  </a>
                </p>
              )}
            </div>
          ) : (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(data.booking ? "reschedule" : "book");
                }}
              >
                <label>
                  希望日時（日本時間・30分）
                  <input
                    type="datetime-local"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </label>
                <button className="demo-button" disabled={busy || !date}>
                  {busy
                    ? "予約とLINE通知を処理中…"
                    : data.booking && data.booking.state !== "cancelled"
                      ? "日時を変更する"
                      : "この日時で体験予約をする"}
                </button>
              </form>
              {data.booking?.state === "booked" && (
                <button
                  className="demo-button secondary"
                  disabled={busy}
                  onClick={() => submit("cancel")}
                >
                  予約を取り消す
                </button>
              )}
            </>
          )}
          <p>
            <a href="/demo">つなぐの体験画面へ</a>
          </p>
        </>
      ) : (
        <>
          <h1>{data.title}</h1>
          <p>{data.summary}</p>
          <p>
            {data.price?.toLocaleString()}円 / {data.area}
          </p>
          <p>
            {data.status === "available"
              ? "販売中（体験用）"
              : "販売状況を確認してください"}
          </p>
          <p className="demo-muted">
            確認日時：{fmt(data.checkedAt)}。架空の体験用データです。
          </p>
        </>
      )}
    </main>
  );
}
