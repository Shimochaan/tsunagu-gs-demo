import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  motion,
  AnimatePresence,
  MotionConfig,
  useReducedMotion,
  useDragControls,
  useMotionValue,
  animate,
} from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Search,
  X,
  Plus,
  MoreHorizontal,
  Settings,
  SlidersHorizontal,
  Bell,
  LayoutDashboard,
  Users,
  MessageCircle,
  CalendarDays,
  FileText,
  Sparkles,
  Clock,
  Pause,
  ShieldCheck,
  Link2,
  Mic,
  Video,
  FolderOpen,
  ChartNoAxesCombined,
  Send,
  Undo2,
  Monitor,
  Smartphone,
  Command,
  Download,
  Upload,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Mail,
  Phone,
  RefreshCw,
  Plug,
  AudioLines,
  PenLine,
  BookOpen,
  Eye,
  HelpCircle,
  LogOut,
  Building2,
  CalendarCheck,
  ArrowDown,
  Menu,
  Copy,
  GripHorizontal,
  Filter,
  UserRound,
  Sun,
  Cloud,
  LockKeyhole,
} from "lucide-react";
import {
  customers,
  assets,
  initialCandidates,
  initialMeetings,
  initialLinks,
  initialPolicies,
  integrations,
  auditRows,
  periods,
} from "./data.js";

const KEY = "tsunagu-studio-v2";
const fresh = () => ({
  candidates: structuredClone(initialCandidates),
  customers: structuredClone(customers),
  meetings: structuredClone(initialMeetings),
  links: structuredClone(initialLinks),
  policies: structuredClone(initialPolicies),
  booking: {},
  replies: {},
  style: {
    tone: "natural",
    answers: [
      "お問い合わせありがとうございます。ネクスト・プロパティの佐藤です。",
      "ご不安な点を、ひとつずつ一緒に整理できればと思います。",
      "",
      "",
    ],
    saved: false,
  },
  connections: Object.fromEntries(integrations.map((i) => [i.id, "connected"])),
});
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return ["candidates", "customers", "meetings", "links", "policies"].every(
      (k) => Array.isArray(saved?.[k]),
    ) &&
      saved?.connections &&
      saved?.style?.answers &&
      saved?.booking &&
      saved?.replies
      ? saved
      : fresh();
  } catch {
    return fresh();
  }
}
const statusMap = {
  pending: ["承認待ち", "blue"],
  approved: ["送信予約済み", "sage"],
  held: ["保留中", "amber"],
  human: ["本人対応", "stone"],
};
const modeLabels = { ai: "AI支援", human: "本人対応", stopped: "追客停止" };
const navItems = [
  ["today", "今日の候補", LayoutDashboard],
  ["customers", "顧客", Users],
  ["conversation", "会話・予約", MessageCircle],
  ["meetings", "面談結果", CalendarCheck],
  ["dashboard", "成果", ChartNoAxesCombined],
];
const adminItems = [
  ["linkage", "商談の紐付け", Link2],
  ["assets", "営業素材", FolderOpen],
  ["policy", "自動化ルール", ShieldCheck],
  ["style", "あなたの文体", PenLine],
  ["integrations", "サービス連携", Plug],
];
const viewTitles = Object.fromEntries([...navItems, ...adminItems]);
const smallSpring = { type: "spring", stiffness: 420, damping: 40 };
function IconButton({ icon: Icon, label, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      <Icon size={19} />
    </button>
  );
}
function Button({
  children,
  variant = "primary",
  icon: Icon,
  className = "",
  ...props
}) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {Icon && <Icon size={17} />}
      <span>{children}</span>
    </button>
  );
}
function Badge({ children, tone = "stone", dot = false }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i />}
      {children}
    </span>
  );
}
function Avatar({ person, size = "" }) {
  return (
    <span className={`avatar ${person?.color || "blue"} ${size}`}>
      {person?.initial || "佐"}
    </span>
  );
}
function Empty({ icon: Icon = CheckCheck, title, description, children }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={28} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
function SectionHead({ title, aside, sub }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {aside}
    </div>
  );
}
export default function App({ initialView = "today" } = {}) {
  const [state, setState] = useState(load),
    [view, setView] = useState(initialView),
    [layout, setLayout] = useState("auto"),
    [role, setRole] = useState("rep");
  const [narrow, setNarrow] = useState(() => window.innerWidth < 800),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("pending"),
    [category, setCategory] = useState("all");
  const [selected, setSelected] = useState(null),
    [checked, setChecked] = useState([]),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [period, setPeriod] = useState("7");
  const [conversationId, setConversationId] = useState("tanaka"),
    [customerQuery, setCustomerQuery] = useState("");
  const contentRef = useRef(null),
    toastRef = useRef(null);
  const mobile = narrow || layout === "mobile";
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  }, [state]);
  useEffect(() => {
    const m = matchMedia("(max-width:799px)");
    const f = () => setNarrow(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  useEffect(() => {
    const f = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal({ type: "search" });
      }
    };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, []);
  useEffect(() => () => clearTimeout(toastRef.current), []);
  const notify = useCallback((text, action) => {
    setToast({ text, action, id: Date.now() });
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 6500);
  }, []);
  const update = (fn) =>
    setState((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  const person = (id) => state.customers.find((c) => c.id === id);
  const pending = state.candidates.filter(
    (c) =>
      c.status === "pending" &&
      person(c.customerId)?.mode === "ai" &&
      !state.booking[c.customerId],
  );
  const held = state.candidates.filter((c) => c.status === "held");
  const queued = state.candidates.filter((c) => c.status === "approved");
  const unconfirmed = state.meetings.filter((m) => !m.confirmed);
  const unlinked = state.links.filter((l) => !l.linked);
  function go(next) {
    setView(next);
    setSelected(null);
    setChecked([]);
    setModal(null);
    contentRef.current?.scrollTo?.({ top: 0, behavior: "instant" });
  }
  function openCandidate(id) {
    setSelected(id);
    if (mobile) setModal({ type: "candidate", id });
  }
  const matchQuery = (c, q) =>
    [
      person(c.customerId)?.name,
      c.trigger,
      c.category,
      person(c.customerId)?.subtitle,
    ]
      .join(" ")
      .replace(/\s/g, "")
      .toLowerCase()
      .includes(q.replace(/\s/g, "").toLowerCase());
  const visible = state.candidates.filter(
    (c) =>
      (filter === "all" || c.status === filter) &&
      (category === "all" || c.category === category) &&
      matchQuery(c, query),
  );
  function changeCandidate(id, patch) {
    update((s) => {
      const c = s.candidates.find((c) => c.id === id);
      if (c) Object.assign(c, patch);
    });
  }
  function approve(ids) {
    const eligible = ids.filter(
      (id) =>
        pending.some((c) => c.id === id && c.draft.trim()) &&
        assets.find(
          (a) => a.id === state.candidates.find((c) => c.id === id)?.assetId,
        )?.status === "公開中",
    );
    if (!eligible.length) {
      notify(
        "承認できる候補がありません。文面・顧客の対応モード・素材を確認してください。",
      );
      return;
    }
    update((s) =>
      s.candidates.forEach((c) => {
        if (eligible.includes(c.id)) c.status = "approved";
      }),
    );
    setChecked([]);
    notify(`${eligible.length}件の送信を予約しました`, {
      label: "取り消す",
      run: () => {
        update((s) =>
          s.candidates.forEach((c) => {
            if (eligible.includes(c.id) && c.status === "approved")
              c.status = "pending";
          }),
        );
        notify("送信予約を取り消しました");
      },
    });
  }
  function restore(c) {
    if (person(c.customerId).mode !== "ai" || state.booking[c.customerId]) {
      notify(
        "予約・成約により追客を停止しています。顧客の状況をご確認ください。",
      );
      return;
    }
    changeCandidate(c.id, { status: "pending", hold: "" });
    notify("承認待ちに戻しました");
  }
  function setMode(id, mode) {
    update((s) => {
      s.customers.find((c) => c.id === id).mode = mode;
      if (mode !== "ai")
        s.candidates.forEach((c) => {
          if (
            c.customerId === id &&
            ["pending", "approved"].includes(c.status)
          ) {
            c.status = mode === "human" ? "human" : "held";
            c.hold = "顧客の対応モードに合わせて、送信を停止しています。";
          }
        });
    });
    notify(`対応モードを「${modeLabels[mode]}」に変更しました`);
  }
  function csv() {
    const lines = [
      ["顧客名", "担当者", "面談日時", "寄与根拠", "状態", "金額"],
      ...auditRows,
    ];
    const text =
      "\ufeff" +
      lines
        .map((r) =>
          r.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(","),
        )
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "tsunagu_audit_sample_202609.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("明細サンプル4件をCSVに出力しました");
  }
  const approvalProps = {
    person,
    state,
    changeCandidate,
    approve,
    restore,
    setMode,
    setModal,
    notify,
  };
  const stats = {
    today: pending.length,
    meetings: unconfirmed.length,
    linkage: unlinked.length,
  };
  return (
    <MotionConfig reducedMotion="user">
      <div className="demo-toolbar">
        <div className="demo-label">
          <span className="mini-mark">t</span>
          <span>
            TSUNAGU <span className="toolbar-divider">/</span> Design preview
          </span>
          <span className="demo-dot" />{" "}
          <span className="sample-label">サンプルデータ・外部送信なし</span>
        </div>
        <div className="demo-controls">
          <div className="device-switch" role="group" aria-label="表示サイズ">
            <button
              aria-pressed={layout !== "mobile"}
              onClick={() => setLayout("auto")}
              title="画面幅に合わせる"
            >
              <Monitor size={15} />
              <span>デスクトップ</span>
            </button>
            <button
              aria-pressed={layout === "mobile"}
              onClick={() => setLayout("mobile")}
              title="モバイル表示"
            >
              <Smartphone size={15} />
              <span>モバイル</span>
            </button>
          </div>
          <button
            className="demo-settings"
            aria-label="デモ設定"
            onClick={() => setModal({ type: "settings" })}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
      </div>
      <div
        className={`app-shell ${layout === "mobile" ? "preview-mobile" : ""}`}
      >
        <div className="app-frame">
          <aside className="sidebar">
            <a
              className="brand"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                go("today");
              }}
              aria-label="TSUNAGU 今日の候補"
            >
              <span className="brand-symbol">
                <Link2 size={23} />
              </span>
              tsunagu<span className="brand-period">.</span>
            </a>
            <button
              className="workspace-picker"
              onClick={() => setModal({ type: "workspace" })}
            >
              <span className="workspace-icon">
                <Building2 size={18} />
              </span>
              <span>
                <strong>ネクスト・プロパティ</strong>
                <small>東京 第1チーム</small>
              </span>
              <ChevronDown size={14} />
            </button>
            <nav aria-label="メインナビゲーション">
              <p className="nav-heading">ワークスペース</p>
              {navItems.map(([id, label, Icon]) => (
                <button
                  key={id}
                  className={`nav-item ${view === id ? "active" : ""}`}
                  aria-current={view === id ? "page" : undefined}
                  onClick={() => go(id)}
                >
                  <Icon size={19} />
                  <span>{label}</span>
                  {stats[id] > 0 && (
                    <span className="nav-count">{stats[id]}</span>
                  )}
                </button>
              ))}
              <p className="nav-heading management">管理と設定</p>
              {adminItems.map(([id, label, Icon]) => (
                <button
                  key={id}
                  className={`nav-item ${view === id ? "active" : ""}`}
                  aria-current={view === id ? "page" : undefined}
                  onClick={() => go(id)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {stats[id] > 0 && (
                    <span className="nav-count neutral">{stats[id]}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className="help-link"
                onClick={() => setModal({ type: "help" })}
              >
                <HelpCircle size={17} />
                <span>使い方ガイド</span>
                <ArrowUpRight size={14} />
              </button>
              <button
                className="profile-row"
                onClick={() => setModal({ type: "workspace" })}
              >
                <Avatar person={{ initial: "佐", color: "stone" }} />
                <span>
                  <strong>佐藤 健一</strong>
                  <small>
                    {role === "rep" ? "営業担当者" : "チーム管理者"}
                  </small>
                </span>
                <MoreHorizontal size={18} />
              </button>
            </div>
          </aside>
          <div className="app-body">
            <header className="topbar">
              <div className="breadcrumb">
                <span>ワークスペース</span>
                <ChevronRight size={13} />
                <strong>{viewTitles[view]}</strong>
              </div>
              <button className="mobile-brand" onClick={() => go("today")}>
                <Link2 size={20} />
                <b>tsunagu.</b>
              </button>
              <div className="topbar-actions">
                <button
                  className="command-search"
                  onClick={() => setModal({ type: "search" })}
                >
                  <Search size={16} />
                  <span>顧客・画面を検索</span>
                  <kbd>⌘ K</kbd>
                </button>
                <IconButton
                  icon={Search}
                  label="検索"
                  className="icon-button mobile-search"
                  onClick={() => setModal({ type: "search" })}
                />
                <button
                  className="notification-button"
                  aria-label={`保留中の提案 ${held.length}件`}
                  onClick={() => {
                    go("today");
                    setFilter("held");
                    setCategory("all");
                    setQuery("");
                  }}
                >
                  <Bell size={19} />
                  {held.length > 0 && <i />}
                </button>
                <button
                  className="mobile-menu"
                  aria-label="管理メニュー"
                  onClick={() => setModal({ type: "menu" })}
                >
                  <Menu size={20} />
                </button>
                <button
                  className="topbar-avatar"
                  aria-label="ワークスペース設定"
                  onClick={() => setModal({ type: "workspace" })}
                >
                  <Avatar person={{ initial: "佐", color: "stone" }} />
                </button>
              </div>
            </header>
            <main id="main-content" className="main-content" ref={contentRef}>
              <div className="page-heading">
                <div>
                  <p className="page-eyebrow">
                    {view === "today"
                      ? "おはようございます、佐藤さん。"
                      : view === "dashboard"
                        ? "ひとつひとつのご連絡を、確かな成果に。"
                        : "ネクスト・プロパティ / 東京 第1チーム"}
                  </p>
                  <h1 tabIndex={-1}>{viewTitles[view]}</h1>
                </div>
                <div className="page-heading-aside">
                  {view === "today" ? (
                    <>
                      <span className="date-label">
                        <CalendarDays size={15} />
                        9月21日（月）
                      </span>
                      <Badge tone="sage" dot>
                        デモ稼働中
                      </Badge>
                    </>
                  ) : view === "dashboard" ? (
                    <Button variant="secondary" icon={Download} onClick={csv}>
                      CSV出力
                    </Button>
                  ) : view === "meetings" ? (
                    <Badge tone="blue">確認待ち {unconfirmed.length}件</Badge>
                  ) : null}
                </div>
              </div>
              {view === "today" && (
                <>
                  <div className="overview-grid">
                    <section className="hero-card">
                      <div className="hero-topline">
                        <span className="hero-label">
                          <Sparkles size={17} />
                          あなたの確認を待つ提案
                        </span>
                        <span className="hero-caption">TODAY</span>
                      </div>
                      <div className="hero-body">
                        <div>
                          <div className="hero-number">
                            {pending.length}
                            <span>件</span>
                          </div>
                          <p>
                            {pending.length
                              ? "相手のことを考えた、ご連絡を。"
                              : "今日の提案をすべて確認しました。"}
                          </p>
                        </div>
                        <div
                          className="hero-ring"
                          aria-label={`${queued.length}件を承認済み`}
                        >
                          <svg viewBox="0 0 90 90" aria-hidden="true">
                            <circle
                              cx="45"
                              cy="45"
                              r="36"
                              className="ring-track"
                            />
                            <circle
                              cx="45"
                              cy="45"
                              r="36"
                              className="ring-value"
                              style={{
                                strokeDasharray: 226.2,
                                strokeDashoffset:
                                  226.2 *
                                  (1 -
                                    queued.length /
                                      Math.max(
                                        1,
                                        pending.length + queued.length,
                                      )),
                              }}
                            />
                          </svg>
                          <span>
                            <CheckCheck size={22} />
                            <small>{queued.length}件 承認済み</small>
                          </span>
                        </div>
                      </div>
                      <div className="hero-bottom">
                        <span>
                          <ShieldCheck size={14} />
                          確認した文面だけを送信
                        </span>
                        <Button
                          onClick={() => {
                            setFilter("pending");
                            setCategory("all");
                            setQuery("");
                            if (pending[0]) openCandidate(pending[0].id);
                          }}
                          disabled={!pending.length}
                        >
                          提案を確認
                          <ArrowRight size={16} />
                        </Button>
                      </div>
                    </section>
                    <button
                      className="summary-tile held-tile"
                      onClick={() => {
                        setFilter("held");
                        setQuery("");
                        setCategory("all");
                        setSelected(null);
                      }}
                    >
                      <span className="tile-top">
                        <span className="icon-tile amber">
                          <Pause size={19} />
                        </span>
                        <ArrowUpRight size={16} />
                      </span>
                      <span className="tile-count">
                        {held.length}
                        <small>件</small>
                      </span>
                      <strong>送信を保留中</strong>
                      <span className="tile-description">最新の状況を確認</span>
                    </button>
                    <button
                      className="summary-tile"
                      onClick={() => go("meetings")}
                    >
                      <span className="tile-top">
                        <span className="icon-tile lavender">
                          <Mic size={19} />
                        </span>
                        <ArrowUpRight size={16} />
                      </span>
                      <span className="tile-count">
                        {unconfirmed.length}
                        <small>件</small>
                      </span>
                      <strong>面談結果の確認</strong>
                      <span className="tile-description">
                        次のフォローにつなげる
                      </span>
                    </button>
                  </div>
                  <div
                    className={`today-columns ${selected && !mobile ? "has-detail" : ""}`}
                  >
                    <section className="candidate-section">
                      <SectionHead
                        title="ご連絡の候補"
                        aside={
                          <span className="quiet-text">
                            {state.candidates.length}件
                          </span>
                        }
                      />
                      <div className="candidate-panel">
                        <div
                          className="list-tabs"
                          role="group"
                          aria-label="提案の状態"
                        >
                          {[
                            ["pending", "承認待ち", pending.length],
                            ["approved", "予約済み", queued.length],
                            ["held", "保留中", held.length],
                            ["all", "すべて", state.candidates.length],
                          ].map(([key, label, n]) => (
                            <button
                              key={key}
                              aria-pressed={filter === key}
                              className={filter === key ? "selected" : ""}
                              onClick={() => {
                                setFilter(key);
                                setChecked([]);
                                setSelected(null);
                              }}
                            >
                              {label}
                              <span>{n}</span>
                            </button>
                          ))}
                        </div>
                        <div className="list-tools">
                          <label className="inline-search">
                            <Search size={16} />
                            <input
                              aria-label="候補を検索"
                              placeholder="名前・きっかけで検索"
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                            />
                            {query && (
                              <button
                                aria-label="検索をクリア"
                                onClick={() => setQuery("")}
                              >
                                <X size={14} />
                              </button>
                            )}
                          </label>
                          <label className="filter-select">
                            <Filter size={14} />
                            <select
                              aria-label="きっかけで絞り込み"
                              value={category}
                              onChange={(e) => {
                                setCategory(e.target.value);
                                setChecked([]);
                              }}
                            >
                              <option value="all">すべてのきっかけ</option>
                              {["閲覧後", "商談後", "お約束", "新着物件"].map(
                                (x) => (
                                  <option key={x}>{x}</option>
                                ),
                              )}
                            </select>
                          </label>
                        </div>
                        {checked.length > 0 && (
                          <div className="selection-bar">
                            <span>{checked.length}件を選択中</span>
                            <button
                              onClick={() =>
                                setModal({
                                  type: "bulk",
                                  ids: checked.filter((id) =>
                                    visible.some((c) => c.id === id),
                                  ),
                                })
                              }
                            >
                              文面をまとめて確認
                              <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                        <div className="candidate-list" aria-label="提案一覧">
                          {visible.length ? (
                            visible.map((c) => (
                              <div
                                key={c.id}
                                className={`candidate-row ${selected === c.id ? "selected" : ""}`}
                              >
                                <label
                                  className="row-checkbox"
                                  title="まとめて確認する候補を選択"
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={`${person(c.customerId).name}様の提案を選択`}
                                    checked={checked.includes(c.id)}
                                    disabled={c.status !== "pending"}
                                    onChange={(e) =>
                                      setChecked((v) =>
                                        e.target.checked
                                          ? [...v, c.id]
                                          : v.filter((x) => x !== c.id),
                                      )
                                    }
                                  />
                                </label>
                                <button
                                  className="candidate-row-content"
                                  onClick={() => openCandidate(c.id)}
                                >
                                  <Avatar person={person(c.customerId)} />
                                  <span className="candidate-row-main">
                                    <span className="candidate-person">
                                      {person(c.customerId).name}
                                      <small>様</small>
                                      <Badge
                                        tone={
                                          c.category === "お約束"
                                            ? "sage"
                                            : c.status === "held"
                                              ? "amber"
                                              : "stone"
                                        }
                                      >
                                        {c.category}
                                      </Badge>
                                    </span>
                                    <span className="candidate-trigger">
                                      {c.trigger}
                                    </span>
                                    <span className="candidate-meta">
                                      <Clock size={12} />
                                      {c.status === "held"
                                        ? "状況の確認が必要"
                                        : `${c.time}に送信予定`}
                                    </span>
                                  </span>
                                  <span className="candidate-end">
                                    <Badge tone={statusMap[c.status][1]}>
                                      {statusMap[c.status][0]}
                                    </Badge>
                                    <ChevronRight size={17} />
                                  </span>
                                </button>
                              </div>
                            ))
                          ) : (
                            <Empty
                              icon={filter === "pending" ? CheckCheck : Search}
                              title={
                                query
                                  ? "一致する候補はありません"
                                  : filter === "pending"
                                    ? "確認、お疲れさまでした"
                                    : "この状態の候補はありません"
                              }
                              description={
                                query
                                  ? "名前やきっかけを変えて検索してください。"
                                  : "新しい候補が見つかると、ここに表示します。"
                              }
                            />
                          )}
                        </div>
                        <div className="list-footer">
                          <ShieldCheck size={14} />
                          <span>
                            新しい返信や成約を検知すると、送信を保留します。
                          </span>
                        </div>
                      </div>
                      {unlinked.length > 0 && (
                        <button
                          className="linkage-banner"
                          onClick={() => go("linkage")}
                        >
                          <span className="icon-tile stone">
                            <Link2 size={18} />
                          </span>
                          <span>
                            <strong>商談を顧客につなげましょう</strong>
                            <small>
                              紐付け待ち {unlinked.length}
                              件。次のフォローを準備できます。
                            </small>
                          </span>
                          <ChevronRight size={18} />
                        </button>
                      )}
                    </section>
                    <aside className="today-aside">
                      {selected && !mobile ? (
                        <div className="detail-panel">
                          <CandidateDetail
                            candidate={state.candidates.find(
                              (c) => c.id === selected,
                            )}
                            {...approvalProps}
                            onClose={() => setSelected(null)}
                          />
                        </div>
                      ) : (
                        <>
                          <Agenda
                            meetings={state.meetings}
                            person={person}
                            onOpen={() => go("meetings")}
                          />
                          <section className="weekly-card">
                            <SectionHead
                              title="今週のつながり"
                              aside={<ArrowUpRight size={16} />}
                            />
                            <div className="weekly-stat">
                              <strong>12</strong>
                              <span>件の予約</span>
                              <Badge tone="sage">9/15 – 9/21</Badge>
                            </div>
                            <MiniChart values={periods["7"].values} />
                            <button
                              className="text-link"
                              onClick={() => go("dashboard")}
                            >
                              成果を詳しく見る
                              <ArrowRight size={14} />
                            </button>
                          </section>
                          <div className="quiet-note">
                            <span className="small-orb">
                              <Sparkles size={17} />
                            </span>
                            <p>
                              ご連絡のタイミングも、
                              <br />
                              <strong>一人ひとりに合わせて。</strong>
                            </p>
                          </div>
                        </>
                      )}
                    </aside>
                  </div>
                </>
              )}
              {view === "customers" && (
                <>
                  <div className="page-description">
                    これまでの会話と、これからのお約束を一か所に。
                  </div>
                  <label className="large-search">
                    <Search size={18} />
                    <input
                      aria-label="顧客を検索"
                      placeholder="顧客名・エリアで検索"
                      value={customerQuery}
                      onChange={(e) => setCustomerQuery(e.target.value)}
                    />
                  </label>
                  <div className="customer-grid">
                    {state.customers
                      .filter((c) =>
                        (c.name + c.subtitle)
                          .replace(/\s/g, "")
                          .includes(customerQuery.replace(/\s/g, "")),
                      )
                      .map((c) => (
                        <button
                          className="customer-card"
                          key={c.id}
                          onClick={() =>
                            setModal({ type: "customer", id: c.id })
                          }
                        >
                          <div className="customer-card-top">
                            <Avatar person={c} size="large" />
                            <Badge
                              tone={
                                c.mode === "stopped"
                                  ? "stone"
                                  : c.mode === "human"
                                    ? "peach"
                                    : "sage"
                              }
                            >
                              {modeLabels[c.mode]}
                            </Badge>
                          </div>
                          <h2>
                            {c.name}
                            <small>様</small>
                          </h2>
                          <p>{c.subtitle}</p>
                          <div className="customer-card-note">
                            <span>{c.stage}</span>
                            <p>{c.concern}</p>
                          </div>
                          <div className="customer-card-footer">
                            <span>{c.seen}</span>
                            <ChevronRight size={17} />
                          </div>
                        </button>
                      ))}
                  </div>
                  {!state.customers.some((c) =>
                    (c.name + c.subtitle)
                      .replace(/\s/g, "")
                      .includes(customerQuery.replace(/\s/g, "")),
                  ) && (
                    <Empty
                      icon={Search}
                      title="一致する顧客はありません"
                      description="名前やエリアを変えて検索してください。"
                    />
                  )}
                </>
              )}
              {view === "conversation" && (
                <Conversations
                  state={state}
                  update={update}
                  person={person}
                  selectedId={conversationId}
                  setSelectedId={setConversationId}
                  notify={notify}
                  setModal={setModal}
                />
              )}
              {view === "meetings" && (
                <Meetings
                  state={state}
                  update={update}
                  person={person}
                  notify={notify}
                  go={go}
                />
              )}
              {view === "dashboard" && (
                <Dashboard
                  period={period}
                  setPeriod={setPeriod}
                  setModal={setModal}
                  csv={csv}
                  pending={pending.length}
                  held={held.length}
                  go={go}
                />
              )}
              {view === "linkage" && (
                <Linkage
                  state={state}
                  update={update}
                  person={person}
                  notify={notify}
                />
              )}
              {view === "assets" && <AssetLibrary setModal={setModal} />}
              {view === "policy" && (
                <Policies
                  state={state}
                  update={update}
                  role={role}
                  notify={notify}
                  setModal={setModal}
                />
              )}
              {view === "style" && (
                <StyleSettings state={state} update={update} notify={notify} />
              )}
              {view === "integrations" && (
                <Integrations
                  state={state}
                  update={update}
                  setModal={setModal}
                  notify={notify}
                />
              )}
              <footer className="page-footer">
                <Link2 size={13} />
                <span>TSUNAGU</span>
                <span>人とのつながりを、ていねいに。</span>
              </footer>
            </main>
            <nav className="bottom-nav" aria-label="モバイルメニュー">
              {navItems.map(([id, label, Icon]) => (
                <button
                  key={id}
                  aria-current={view === id ? "page" : undefined}
                  className={view === id ? "active" : ""}
                  onClick={() => go(id)}
                >
                  <span>
                    <Icon size={21} />
                    {stats[id] > 0 && <i>{stats[id]}</i>}
                  </span>
                  <small>{id === "today" ? "今日" : label}</small>
                </button>
              ))}
            </nav>
          </div>
        </div>
      </div>
      <Sheet
        modal={modal}
        close={() => setModal(null)}
        mobile={mobile}
        title={
          modal?.type === "candidate"
            ? "提案を確認"
            : modal?.type === "preview"
              ? "LINEでの表示"
              : modal?.type === "customer"
                ? "顧客カルテ"
                : modal?.type === "search"
                  ? "顧客・画面を検索"
                  : modal?.type === "bulk"
                    ? "まとめて承認"
                    : modal?.type === "audit"
                      ? "成果の明細"
                      : modal?.type === "asset"
                        ? "営業素材"
                        : modal?.type === "menu"
                          ? "管理メニュー"
                          : modal?.type === "support"
                            ? "セットアップの相談"
                            : modal?.type === "policy"
                              ? "自動化ルールの変更"
                              : modal?.type === "help"
                                ? "使い方ガイド"
                                : "ワークスペース設定"
        }
      >
        {modal?.type === "candidate" && (
          <CandidateDetail
            candidate={state.candidates.find((c) => c.id === modal.id)}
            {...approvalProps}
          />
        )}
        {modal?.type === "preview" && (
          <LinePreview
            candidate={state.candidates.find((c) => c.id === modal.id)}
            person={person}
            onBack={() =>
              setModal(mobile ? { type: "candidate", id: modal.id } : null)
            }
          />
        )}
        {modal?.type === "customer" && (
          <CustomerDetail
            customer={person(modal.id)}
            state={state}
            setMode={setMode}
            openConversation={() => {
              setConversationId(modal.id);
              go("conversation");
            }}
          />
        )}
        {modal?.type === "asset" && (
          <AssetDetail asset={assets.find((a) => a.id === modal.id)} />
        )}
        {modal?.type === "search" && (
          <GlobalSearch people={state.customers} go={go} setModal={setModal} />
        )}
        {modal?.type === "bulk" && (
          <BulkReview
            ids={modal.ids}
            state={state}
            person={person}
            approve={(ids) => {
              approve(ids);
              setModal(null);
            }}
          />
        )}
        {modal?.type === "audit" && <Audit csv={csv} />}
        {modal?.type === "menu" && (
          <div className="sheet-menu">
            {adminItems.map(([id, label, Icon]) => (
              <button key={id} onClick={() => go(id)}>
                <Icon size={20} />
                <span>{label}</span>
                <ChevronRight size={17} />
              </button>
            ))}
            <button onClick={() => setModal({ type: "workspace" })}>
              <UserRound size={20} />
              <span>ワークスペース設定</span>
              <ChevronRight size={17} />
            </button>
          </div>
        )}
        {["workspace", "settings"].includes(modal?.type) && (
          <div className="settings-content">
            <div className="workspace-header">
              <Avatar person={{ initial: "佐", color: "stone" }} size="large" />
              <h2>佐藤 健一</h2>
              <p>ネクスト・プロパティ / 東京 第1チーム</p>
            </div>
            <div className="form-group">
              <label htmlFor="roleSelect">デモで操作するロール</label>
              <select
                id="roleSelect"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value);
                  notify("デモの操作ロールを変更しました");
                }}
              >
                <option value="rep">営業担当者</option>
                <option value="manager">チーム管理者</option>
              </select>
              <p>管理者は、自動化ルールの昇格を確認できます。</p>
            </div>
            <div className="info-callout">
              <ShieldCheck size={18} />
              <p>
                入力・承認はこのブラウザーに保存します。LINE送信や外部サービスとの接続は行いません。
              </p>
            </div>
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={() => {
                setState(fresh());
                setChecked([]);
                setSelected(null);
                setModal(null);
                setFilter("pending");
                setQuery("");
                setCategory("all");
                notify("サンプルデータを初期状態に戻しました");
              }}
            >
              デモを最初から見る
            </Button>
          </div>
        )}
        {modal?.type === "support" && (
          <Support
            onSubmit={() => {
              setModal(null);
              notify(
                "相談内容をデモ内で受け付けました。外部への送信はありません。",
              );
            }}
          />
        )}
        {modal?.type === "policy" && (
          <PolicyConfirm
            policy={state.policies.find((p) => p.id === modal.id)}
            onConfirm={() => {
              const p = state.policies.find((p) => p.id === modal.id);
              if (role === "manager" && p.rate >= 90 && p.edits === 0) {
                update(
                  (s) => (s.policies.find((p) => p.id === modal.id).level = 2),
                );
                setModal(null);
                notify("条件付き自動に変更しました（デモ）");
              }
            }}
          />
        )}
        {modal?.type === "help" && (
          <div className="help-content">
            <p className="lead">朝の確認から、次のご連絡まで。</p>
            {[
              [
                "01",
                "今日の候補を確認",
                "きっかけと顧客の状況を確認し、提案を開きます。",
              ],
              [
                "02",
                "文面と時刻を整える",
                "必要に応じて編集。LINEプレビューで表示を確認できます。",
              ],
              [
                "03",
                "承認して送信予約",
                "予約は取り消し可能。新しい返信があれば保留します。",
              ],
              [
                "04",
                "面談結果を次につなげる",
                "面談の結果と約束を残し、次のフォローへつなげます。",
              ],
            ].map(([n, t, d]) => (
              <div className="help-step" key={n}>
                <span>{n}</span>
                <div>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Sheet>
      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            key={toast.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            role="status"
          >
            <CheckCircle2 size={20} />
            <span>{toast.text}</span>
            {toast.action && (
              <button
                onClick={() => {
                  toast.action.run();
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              className="toast-close"
              aria-label="通知を閉じる"
              onClick={() => setToast(null)}
            >
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

function Agenda({ meetings, person, onOpen }) {
  return (
    <section className="agenda-card">
      <SectionHead
        title="今日の面談"
        aside={<span className="quiet-text">2件</span>}
      />
      <div className="agenda-date">
        <span className="date-square">
          <small>MON</small>
          <strong>21</strong>
        </span>
        <div>
          <strong>9月21日</strong>
          <small>お客様との、次のお約束。</small>
        </div>
      </div>
      {meetings.map((m) => (
        <button className="agenda-item" key={m.id} onClick={onOpen}>
          <span className="agenda-time">
            {m.time}
            <small>{m.duration}</small>
          </span>
          <span className="agenda-line" />
          <span>
            <strong>{person(m.customerId).name} 様</strong>
            <small>
              {m.format === "対面" ? <Users size={12} /> : <Video size={12} />}{" "}
              {m.format} · {m.confirmed ? "確認済み" : "結果を確認"}
            </small>
          </span>
          <ChevronRight size={14} />
        </button>
      ))}
      <button className="text-link" onClick={onOpen}>
        面談結果を確認
        <ArrowRight size={14} />
      </button>
    </section>
  );
}
function MiniChart({ values, large = false }) {
  const max = Math.max(...values, 1);
  return (
    <div
      className={`mini-chart ${large ? "large" : ""}`}
      role="img"
      aria-label={values.map((n, i) => `${i + 1}日目 ${n}件`).join("、")}
    >
      <div className="chart-bars">
        {values.map((v, i) => (
          <div
            className={`chart-bar-group ${i === values.length - 1 ? "last" : ""}`}
            key={i}
            title={`${i + 1}日目：${v}件`}
          >
            <span className="bar-track">
              <span style={{ height: `${(v / max) * 90}%` }} />
            </span>
            {values.length <= 7 && (
              <small>{["火", "水", "木", "金", "土", "日", "月"][i]}</small>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
function CandidateDetail({
  candidate: c,
  person,
  state,
  changeCandidate,
  approve,
  restore,
  setMode,
  setModal,
  notify,
  onClose,
}) {
  if (!c) return null;
  const p = person(c.customerId),
    asset = assets.find((a) => a.id === c.assetId);
  const blocked = p.mode !== "ai" || state.booking[p.id];
  return (
    <div className="candidate-detail">
      <div className="detail-heading">
        <div className="detail-title">
          <Avatar person={p} />
          <div>
            <h2>
              {p.name}
              <small>様</small>
            </h2>
            <p>{p.subtitle}</p>
          </div>
        </div>
        {onClose && (
          <IconButton icon={X} label="提案詳細を閉じる" onClick={onClose} />
        )}
      </div>
      <div className="detail-state">
        <Badge tone={statusMap[c.status][1]} dot>
          {statusMap[c.status][0]}
        </Badge>
        <span>
          <Clock size={13} />
          {c.time.startsWith("明日") ? c.time : `本日 ${c.time}`}
        </span>
      </div>
      {c.status === "held" && (
        <div className="hold-callout">
          <Pause size={19} />
          <div>
            <strong>まずは、最新の状況を確認</strong>
            <p>{c.hold}</p>
          </div>
        </div>
      )}
      <div className="ai-reason">
        <div className="ai-reason-title">
          <Sparkles size={16} />
          <h3>このご連絡を提案した理由</h3>
        </div>
        <p>{c.reason}</p>
        <details>
          <summary>
            参照した情報 <ChevronDown size={13} />
          </summary>
          <ul>
            {c.evidence.map((e) => (
              <li key={e}>
                <FileText size={13} />
                {e}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <button
        className={`attachment ${asset.color}`}
        onClick={() => setModal({ type: "asset", id: asset.id })}
      >
        <span className="attachment-icon">
          <FileText size={22} />
          <small>{asset.kind}</small>
        </span>
        <span>
          <strong>{asset.title}</strong>
          <small>
            {asset.source} · {asset.status}
          </small>
        </span>
        <Eye size={17} />
      </button>
      <div className="draft-section">
        <div className="draft-heading">
          <label htmlFor={`draft-${c.id}`}>送信するメッセージ</label>
          <button
            className="text-link"
            onClick={() => setModal({ type: "preview", id: c.id })}
          >
            <Eye size={14} />
            LINEで確認
          </button>
        </div>
        <textarea
          id={`draft-${c.id}`}
          value={c.draft}
          readOnly={c.status !== "pending"}
          onChange={(e) => changeCandidate(c.id, { draft: e.target.value })}
          rows={8}
        />
        <div className="draft-meta">
          <span>
            <PenLine size={12} />
            {c.status === "pending"
              ? "あなたの言葉に編集できます"
              : c.status === "approved"
                ? "予約を取り消すと編集できます"
                : "承認待ちに戻すと編集できます"}
          </span>
          <span>{c.draft.length}文字</span>
        </div>
      </div>
      <div className="time-setting">
        <label htmlFor={`time-${c.id}`}>
          <Clock size={16} />
          <span>送信する時刻</span>
        </label>
        <select
          id={`time-${c.id}`}
          value={c.time}
          disabled={c.status !== "pending"}
          onChange={(e) => changeCandidate(c.id, { time: e.target.value })}
        >
          {[
            ...new Set([
              c.time,
              "17:00",
              "18:00",
              "18:30",
              "19:15",
              "明日 10:00",
            ]),
          ].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {blocked && (
        <p className="form-note amber-text">
          {state.booking[p.id]
            ? "予約確定済みのため、追客を停止しています。"
            : `顧客は「${modeLabels[p.mode]}」です。`}
        </p>
      )}
      <div className="detail-actions">
        {c.status === "pending" ? (
          <>
            <Button
              icon={Check}
              disabled={Boolean(blocked) || !c.draft.trim()}
              onClick={() => approve([c.id])}
            >
              承認して送信予約
            </Button>
            <div className="secondary-actions">
              <button
                onClick={() => {
                  changeCandidate(c.id, {
                    status: "held",
                    hold: "担当者が文面・顧客状況を確認するため保留しています。",
                  });
                  notify("提案を保留しました");
                }}
              >
                <Pause size={14} />
                保留にする
              </button>
              <button onClick={() => setMode(p.id, "human")}>
                <UserRound size={14} />
                本人で対応
              </button>
            </div>
          </>
        ) : c.status === "approved" ? (
          <>
            <div className="success-line">
              <CheckCircle2 size={20} />
              <span>{c.time}の送信を予約しました</span>
            </div>
            <Button variant="secondary" icon={Undo2} onClick={() => restore(c)}>
              予約を取り消す
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              icon={UserRound}
              onClick={() => {
                setMode(p.id, "human");
              }}
            >
              本人対応に切り替える
            </Button>
            <button
              className="text-link centered"
              disabled={Boolean(blocked)}
              onClick={() => restore(c)}
            >
              状況を確認し、承認待ちに戻す
              <ArrowRight size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Sheet({ modal, close, mobile, title, children }) {
  const returnFocus = useRef(null);
  const controls = useDragControls(),
    y = useMotionValue(0),
    reduce = useReducedMotion();
  useEffect(() => {
    y.set(0);
  }, [modal?.type, modal?.id, y]);
  return (
    <Dialog.Root
      open={Boolean(modal)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <AnimatePresence>
        {modal && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="sheet-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                returnFocus.current = document.activeElement;
                if (modal?.type === "search") {
                  event.preventDefault();
                  document.querySelector('[aria-label="顧客・画面の検索"]')?.focus();
                }
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const target = returnFocus.current;
                returnFocus.current = null;
                if (target?.isConnected) target.focus();
                else document.querySelector("h1")?.focus();
              }}
            >
              <motion.section
                className={`sheet ${mobile ? "mobile-sheet" : ""} ${["candidate", "customer", "preview"].includes(modal.type) ? "wide-sheet" : ""}`}
                initial={
                  reduce
                    ? { opacity: 0 }
                    : mobile
                      ? { opacity: 1, y: 80 }
                      : { opacity: 0, x: 24 }
                }
                animate={{ opacity: 1, x: 0, y: 0 }}
                exit={
                  reduce
                    ? { opacity: 0 }
                    : mobile
                      ? { opacity: 0, y: 80 }
                      : { opacity: 0, x: 24 }
                }
                transition={smallSpring}
                drag={mobile && !reduce ? "y" : false}
                dragControls={controls}
                dragListener={false}
                dragConstraints={{ top: 0 }}
                dragElastic={{ top: 0.08, bottom: 0.6 }}
                style={mobile && !reduce ? { y } : undefined}
                onDragEnd={(_, info) => {
                  const projected = info.offset.y + info.velocity.y * 0.18;
                  if (projected > 150 && info.velocity.y > -100) close();
                  else
                    animate(y, 0, {
                      ...smallSpring,
                      velocity: info.velocity.y,
                    });
                }}
              >
                <div
                  className="sheet-handle"
                  onPointerDown={(e) => {
                    if (mobile && !reduce) controls.start(e);
                  }}
                  aria-hidden="true"
                >
                  <i />
                </div>
                <header className="sheet-header">
                  <Dialog.Title>{title}</Dialog.Title>
                  <Dialog.Close asChild>
                    <IconButton icon={X} label="閉じる" />
                  </Dialog.Close>
                </header>
                <div className="sheet-content" key={modal.type + modal.id}>
                  {children}
                </div>
              </motion.section>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function LinePreview({ candidate, person, onBack }) {
  const p = person(candidate.customerId),
    a = assets.find((a) => a.id === candidate.assetId);
  return (
    <>
      <p className="sheet-description">
        {p.name}様に届くメッセージのプレビューです。
      </p>
      <div className="line-preview">
        <div className="line-chat-title">
          <ChevronLeft size={19} />
          <strong>ネクスト・プロパティ</strong>
          <Phone size={17} />
        </div>
        <div className="line-chat-body">
          <span className="chat-date">9月21日（月）</span>
          <div className="outbound-bubble">{candidate.draft}</div>
          <div className={`line-asset-card ${a.color}`}>
            <div className="line-asset-cover">
              <FileText size={30} />
              <span>{a.tag}</span>
            </div>
            <div>
              <strong>{a.title}</strong>
              <p>{a.description}</p>
              <span className="line-preview-link">
                資料を見る <ExternalLink size={12} />
              </span>
            </div>
          </div>
          <span className="chat-time">送信予定 {candidate.time}</span>
        </div>
      </div>
      <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
        文面の確認に戻る
      </Button>
    </>
  );
}
function CustomerDetail({ customer: c, state, setMode, openConversation }) {
  const candidates = state.candidates.filter((p) => p.customerId === c.id);
  return (
    <div className="customer-detail">
      <div className="customer-profile">
        <Avatar person={c} size="xl" />
        <h2>
          {c.name}
          <small>様</small>
        </h2>
        <p>{c.subtitle}</p>
        <Badge tone="stone">{c.stage}</Badge>
        <Button
          variant="secondary"
          icon={MessageCircle}
          onClick={openConversation}
        >
          会話を開く
        </Button>
      </div>
      <div className="grouped-list">
        <div>
          <span>希望エリア</span>
          <strong>{c.area}</strong>
        </div>
        <div>
          <span>ご予算</span>
          <strong>{c.budget}</strong>
        </div>
        <div>
          <span>希望条件</span>
          <strong>{c.wish}</strong>
        </div>
      </div>
      <section className="profile-section">
        <h3>大切にしていること</h3>
        <p>{c.concern}</p>
      </section>
      <section className="profile-section pale-blue">
        <h3>
          <CalendarDays size={17} />
          次のお約束
        </h3>
        <p>{c.promise}</p>
      </section>
      <div className="form-group">
        <label htmlFor="customer-mode">対応モード</label>
        <select
          id="customer-mode"
          value={c.mode}
          onChange={(e) => setMode(c.id, e.target.value)}
        >
          {Object.entries(modeLabels).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {c.mode === "stopped" && (
          <p>
            <ShieldCheck size={14} />
            この顧客への追客は停止しています。
          </p>
        )}
      </div>
      <section className="profile-section">
        <h3>最近のやりとり</h3>
        <div className="timeline">
          {[
            ...[{ date: "9/21", title: c.last, desc: c.concern }],
            ...candidates.map((p) => ({
              date: "9/21",
              title: statusMap[p.status][0],
              desc: p.trigger,
            })),
            { date: "9/15", title: "商談メモを更新", desc: c.promise },
          ].map((e, i) => (
            <div key={i}>
              <i />
              <small>{e.date}</small>
              <strong>{e.title}</strong>
              <p>{e.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Conversations({
  state,
  update,
  person,
  selectedId: id,
  setSelectedId,
  notify,
  setModal,
}) {
  const [draft, setDraft] = useState(""),
    [slot, setSlot] = useState("9月25日（金）16:00");
  const c = person(id),
    booked = state.booking[id],
    replies = state.replies[id] || [];
  useEffect(() => setDraft(""), [id]);
  function simulate() {
    update((s) => {
      s.replies[id] = [
        ...(s.replies[id] || []),
        {
          from: "customer",
          text: "ありがとうございます。今週金曜日の夕方に、15分ほどお話しできますか？",
        },
      ];
      s.candidates.forEach((p) => {
        if (p.customerId === id && ["approved", "pending"].includes(p.status)) {
          p.status = "held";
          p.hold =
            "新しい返信が届いたため、送信を保留しました。会話の内容を確認してください。";
        }
      });
    });
    notify("返信を再現しました。対象の送信予約を保留しています。");
  }
  function book() {
    if (c.mode === "stopped") return;
    update((s) => {
      s.booking[id] = slot;
      s.customers.find((p) => p.id === id).stage = "予約確定";
      s.candidates.forEach((p) => {
        if (p.customerId === id) {
          p.status = "held";
          p.hold = "面談の予約が確定したため、追客を停止しています。";
        }
      });
    });
    notify("面談を予約しました。追客を停止し、予約案内に切り替えました。");
  }
  return (
    <div className="conversation-layout">
      <aside className="conversation-list">
        <div className="conversation-list-heading">
          <h2>LINEの会話</h2>
          <Badge tone="stone">{state.customers.length}</Badge>
        </div>
        {state.customers.map((p) => (
          <button
            key={p.id}
            className={p.id === id ? "selected" : ""}
            onClick={() => setSelectedId(p.id)}
          >
            <Avatar person={p} />
            <span>
              <strong>{p.name}</strong>
              <small>
                {state.booking[p.id] ? "面談の予約が確定しました" : p.last}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
        ))}
      </aside>
      <section className="conversation-thread">
        <header>
          <Avatar person={c} />
          <div>
            <h2>
              {c.name}
              <small>様</small>
            </h2>
            <p>{modeLabels[c.mode]} · LINE公式アカウント</p>
          </div>
          <IconButton
            icon={UserRound}
            label="顧客カルテを開く"
            onClick={() => setModal({ type: "customer", id })}
          />
        </header>
        <div className="conversation-scroll">
          <span className="chat-date neutral">9月21日（月）</span>
          <div className="chat-message incoming">
            <span className="message-label">{c.name}様</span>
            <p>{c.concern}</p>
            <time>09:10</time>
          </div>
          <div className="chat-message outgoing">
            <span className="message-label">佐藤 健一</span>
            <p>
              ご相談ありがとうございます。伺った内容をもとに、ご案内を準備いたしますね。
            </p>
            <time>09:12</time>
          </div>
          {replies.map((r, i) => (
            <div
              className={`chat-message ${r.from === "customer" ? "incoming" : "outgoing"}`}
              key={i}
            >
              <span className="message-label">
                {r.from === "customer" ? `${c.name}様` : "佐藤 健一"}
              </span>
              <p>{r.text}</p>
              <time>09:{String(20 + i).padStart(2, "0")}</time>
            </div>
          ))}
          {booked ? (
            <div className="booking-confirmed">
              <span className="icon-tile sage">
                <Check size={22} />
              </span>
              <Badge tone="sage">予約確定</Badge>
              <h3>個別相談のお約束</h3>
              <p>
                {booked} 〜 {booked?.includes("17:00") ? "17:30" : "16:30"}
              </p>
              <div>
                <Video size={15} />
                オンライン · 担当 佐藤 健一
              </div>
              <small>追客を停止し、予約案内に切り替えています。</small>
              <button
                className="text-link"
                onClick={() => {
                  update((s) => {
                    delete s.booking[id];
                    s.customers.find((p) => p.id === id).stage = "検討中";
                  });
                  notify(
                    "予約を取り消しました。追客の再開は提案画面で確認してください。",
                  );
                }}
              >
                予約を取り消す
              </button>
            </div>
          ) : (
            replies.some((r) => r.from === "customer") && (
              <div className="booking-suggestion">
                <h3>
                  <CalendarDays size={18} />
                  面談の日程候補
                </h3>
                <p>お客様の希望に合わせ、空き枠を確認しました。</p>
                <label className="sr-only" htmlFor="booking-slot">
                  面談の日時
                </label>
                <select
                  id="booking-slot"
                  value={slot}
                  onChange={(e) => setSlot(e.target.value)}
                >
                  <option>9月25日（金）16:00</option>
                  <option>9月25日（金）17:00</option>
                </select>
                <Button
                  icon={Check}
                  disabled={c.mode === "stopped"}
                  onClick={book}
                >
                  この日時で予約を確定
                </Button>
              </div>
            )
          )}
        </div>
        <form
          className="conversation-compose"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            update(
              (s) =>
                (s.replies[id] = [
                  ...(s.replies[id] || []),
                  { from: "rep", text: draft.trim() },
                ]),
            );
            setDraft("");
            notify("メッセージをデモの会話に追加しました");
          }}
        >
          <label className="sr-only" htmlFor="reply">
            返信メッセージ
          </label>
          <textarea
            id="reply"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="メッセージを入力…"
            rows={2}
          />
          <div>
            <span>デモ内の会話に追加します</span>
            <Button type="submit" icon={Send} disabled={!draft.trim()}>
              返信
            </Button>
          </div>
        </form>
        <div className="simulation-control">
          <button onClick={simulate}>
            <RefreshCw size={14} />
            顧客の返信を再現
          </button>
        </div>
      </section>
    </div>
  );
}

function Meetings({ state, update, person, notify, go }) {
  const [tab, setTab] = useState("unconfirmed");
  const list = state.meetings.filter((m) => tab === "all" || !m.confirmed);
  const edit = (id, patch) =>
    update((s) =>
      Object.assign(
        s.meetings.find((m) => m.id === id),
        patch,
      ),
    );
  function confirm(m) {
    if (m.attendance !== "実施済み" && m.outcome === "成約") {
      notify("実施状況と面談の結果を確認してください");
      return;
    }
    if (!m.next.trim()) {
      notify("次のアクションを入力してください");
      return;
    }
    update((s) => {
      const item = s.meetings.find((x) => x.id === m.id);
      item.confirmed = true;
      const p = s.customers.find((p) => p.id === item.customerId);
      p.promise = item.next;
      p.concern = item.note;
      p.last = "面談結果を確認しました";
      p.mode = item.outcome === "成約" ? "stopped" : item.mode;
      p.stage = item.outcome === "成約" ? "成約済み" : "検討中";
      if (p.mode !== "ai")
        s.candidates.forEach((c) => {
          if (c.customerId === p.id) {
            c.status = "held";
            c.hold = "面談結果に合わせて追客を停止しています。";
          }
        });
    });
    notify("面談結果を確定し、顧客カルテを更新しました");
  }
  return (
    <>
      <div className="section-toolbar">
        <p className="page-description">
          面談で伺ったことを、次のアクションへ。
        </p>
        <div className="segmented">
          <button
            aria-pressed={tab === "unconfirmed"}
            onClick={() => setTab("unconfirmed")}
          >
            確認待ち
          </button>
          <button aria-pressed={tab === "all"} onClick={() => setTab("all")}>
            すべて
          </button>
        </div>
      </div>
      <div className="meeting-grid">
        {list.map((m) => (
          <section key={m.id} className="meeting-card">
            <div className="meeting-card-heading">
              <Avatar person={person(m.customerId)} />
              <div>
                <h2>
                  {person(m.customerId).name}
                  <small>様</small>
                </h2>
                <p>
                  本日 {m.time} · {m.format}
                </p>
              </div>
              <Badge tone={m.confirmed ? "sage" : "blue"}>
                {m.confirmed ? "確認済み" : "確認待ち"}
              </Badge>
            </div>
            <div className="meeting-source">
              <Mic size={16} />
              <span>
                {m.format === "対面" ? "対面商談のメモ" : "議事録からの下書き"}
              </span>
              <Badge tone="stone">{m.duration}</Badge>
            </div>
            <div className="form-pair">
              <div className="form-group">
                <label htmlFor={`${m.id}-attend`}>実施状況</label>
                <select
                  id={`${m.id}-attend`}
                  disabled={m.confirmed}
                  value={m.attendance}
                  onChange={(e) => edit(m.id, { attendance: e.target.value })}
                >
                  {["実施済み", "キャンセル", "不参加"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor={`${m.id}-outcome`}>面談の結果</label>
                <select
                  id={`${m.id}-outcome`}
                  disabled={m.confirmed}
                  value={m.outcome}
                  onChange={(e) => edit(m.id, { outcome: e.target.value })}
                >
                  {["継続検討", "成約", "失注"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor={`${m.id}-note`}>お客様の懸念・ご相談</label>
              <textarea
                id={`${m.id}-note`}
                disabled={m.confirmed}
                value={m.note}
                rows={3}
                onChange={(e) => edit(m.id, { note: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${m.id}-next`}>次のお約束・アクション</label>
              <textarea
                id={`${m.id}-next`}
                disabled={m.confirmed}
                value={m.next}
                rows={3}
                onChange={(e) => edit(m.id, { next: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${m.id}-mode`}>今後の対応</label>
              <select
                id={`${m.id}-mode`}
                disabled={m.confirmed || m.outcome === "成約"}
                value={m.outcome === "成約" ? "stopped" : m.mode}
                onChange={(e) => edit(m.id, { mode: e.target.value })}
              >
                {Object.entries(modeLabels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            {m.outcome === "成約" && (
              <div className="success-line">
                <ShieldCheck size={17} />
                成約したお客様への追客は停止します。
              </div>
            )}
            <Button
              variant={m.confirmed ? "secondary" : "primary"}
              icon={m.confirmed ? PenLine : Check}
              onClick={() =>
                m.confirmed ? edit(m.id, { confirmed: false }) : confirm(m)
              }
            >
              {m.confirmed ? "結果を修正する" : "面談結果を確定"}
            </Button>
          </section>
        ))}
      </div>
      {!list.length && (
        <Empty
          title="すべての面談結果を確認しました"
          description="新しい議事録が届くと、ここに下書きを表示します。"
        />
      )}
      <button className="linkage-banner" onClick={() => go("linkage")}>
        <span className="icon-tile lavender">
          <AudioLines size={18} />
        </span>
        <span>
          <strong>まだ紐付いていない商談はありませんか？</strong>
          <small>録音・議事録を顧客に紐付ける</small>
        </span>
        <ArrowRight size={17} />
      </button>
    </>
  );
}

function Dashboard({ period, setPeriod, setModal, csv, pending, held, go }) {
  const series = periods[period];
  return (
    <>
      <div className="dashboard-period">
        <span>
          <CalendarDays size={16} />
          2026年9月1日 – 9月21日
        </span>
        <Badge tone="stone">月次サンプル</Badge>
      </div>
      <div className="metrics-grid">
        {[
          [
            "創出した予約",
            "32",
            "件",
            "全48件のうち 66.7%",
            "blue",
            CalendarDays,
          ],
          ["実施した面談", "26", "件", "初回18件 / 再面談8件", "sage", Users],
          [
            "削減できた時間",
            "12.7",
            "時間",
            "手動換算14.8時間 − 操作2.1時間",
            "lavender",
            Clock,
          ],
          [
            "課金が確定した面談",
            "22",
            "件",
            "請求予定 ¥660,000",
            "peach",
            CheckCircle2,
          ],
        ].map(([l, n, u, note, tone, Icon]) => (
          <button
            className="metric-card"
            key={l}
            onClick={() => setModal({ type: "audit" })}
          >
            <span className={`icon-tile ${tone}`}>
              <Icon size={19} />
            </span>
            <p>{l}</p>
            <strong>
              {n}
              <small>{u}</small>
            </strong>
            <span>{note}</span>
          </button>
        ))}
      </div>
      <div className="dashboard-columns">
        <section className="chart-card">
          <SectionHead
            title="予約獲得の推移"
            sub="TSUNAGUをきっかけにした予約。"
            aside={
              <div className="segmented">
                {["7", "14", "30"].map((p) => (
                  <button
                    key={p}
                    aria-pressed={period === p}
                    onClick={() => setPeriod(p)}
                  >
                    {p}日
                  </button>
                ))}
              </div>
            }
          />
          <div className="chart-large-number">
            <strong>{series.values.reduce((a, b) => a + b, 0)}</strong>
            <span>件の予約</span>
            <small>{series.label}</small>
          </div>
          <MiniChart values={series.values} large />
          <div className="chart-axis">
            <span>
              {period === "7" ? "9/15" : period === "14" ? "9/8" : "8/23"}
            </span>
            <span>日別の予約件数</span>
            <span>9/21</span>
          </div>
        </section>
        <section className="funnel-card">
          <SectionHead title="予約から成果まで" />
          <div className="funnel-bars">
            {[
              ["LINE全体の予約", 48],
              ["TSUNAGUからの予約", 32],
              ["実施を確認", 26],
              ["課金が確定", 22],
            ].map(([l, n], i) => (
              <button key={l} onClick={() => setModal({ type: "audit" })}>
                <span>
                  {l}
                  <strong>
                    {n}
                    <small>件</small>
                  </strong>
                </span>
                <i>
                  <b
                    style={{
                      width: `${(n / 48) * 100}%`,
                      opacity: 0.35 + i * 0.2,
                    }}
                  />
                </i>
              </button>
            ))}
          </div>
          <p className="quiet-text">
            確定分のみ計上。未実施・キャンセル分は除外します。
          </p>
        </section>
      </div>
      <div className="insight-strip">
        <span className="icon-tile blue">
          <Sparkles size={19} />
        </span>
        <div>
          <h3>次の成果につながる、ご連絡があります。</h3>
          <p>
            承認待ち {pending}件、状況の確認が必要な保留 {held}件。
          </p>
        </div>
        <Button variant="secondary" onClick={() => go("today")}>
          候補を確認
          <ArrowRight size={15} />
        </Button>
      </div>
      <section className="audit-panel">
        <SectionHead
          title="成果の明細"
          sub="サンプル4件を表示。上記の月次集計とは対象範囲が異なります。"
          aside={
            <button className="text-link" onClick={csv}>
              <Download size={15} />
              CSV出力
            </button>
          }
        />
        <AuditTable />
      </section>
    </>
  );
}
function AuditTable() {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>顧客</th>
            <th>面談日時</th>
            <th>TSUNAGUの寄与</th>
            <th>状態</th>
            <th className="right">金額</th>
          </tr>
        </thead>
        <tbody>
          {auditRows.map(([name, rep, date, reason, status, price]) => (
            <tr key={name}>
              <td>
                <strong>{name} 様</strong>
                <small>{rep}</small>
              </td>
              <td>{date}</td>
              <td>{reason}</td>
              <td>
                <Badge tone={status === "課金確定" ? "sage" : "stone"}>
                  {status}
                </Badge>
              </td>
              <td className="right">
                {price ? "¥" + price.toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Audit({ csv }) {
  return (
    <>
      <p className="sheet-description">
        月次の集計とは別に、操作確認用の4件を表示しています。
      </p>
      <AuditTable />
      <div className="info-callout">
        <ShieldCheck size={18} />
        <p>
          成果報酬は面談の実施確認後に確定します。未実施・キャンセルは請求対象に含めません。
        </p>
      </div>
      <Button icon={Download} onClick={csv}>
        明細サンプルをCSV出力
      </Button>
    </>
  );
}

function Linkage({ state, update, person, notify }) {
  const [choices, setChoices] = useState({});
  function link(l) {
    const id = choices[l.id] || l.customerId,
      p = person(id);
    update((s) => {
      const target = s.links.find((x) => x.id === l.id);
      target.linked = true;
      target.linkedCustomer = id;
      const name = p.name;
      const allowed = p.mode === "ai" && !s.booking[id];
      s.candidates.unshift({
        id: `linked-${l.id}`,
        customerId: id,
        category: "商談後",
        status: allowed ? "pending" : "held",
        hold: allowed
          ? ""
          : "顧客の予約・対応モードにより、送信を保留しています。",
        assetId:
          { yamamoto: "cost", takahashi: "property", watanabe: "loan" }[id] ||
          "rate",
        time: "18:30",
        trigger: "面談の記録を紐付けました",
        reason: `「${l.title}」の商談記録をもとに、お礼のご連絡を準備しました。手動で紐付けた場合は、顧客と記録が一致しているか確認してください。`,
        evidence: [`${l.date} ${l.source}`, l.summary],
        draft: `${name}様、本日はお時間をいただきありがとうございました。\n\nご相談いただいた内容を確認し、次のご案内を準備いたします。追加で気になることがありましたら、お気軽にお知らせください。`,
      });
    });
    notify(`${p.name}様に商談を紐付け、提案を作成しました`);
  }
  return (
    <>
      <p className="page-description">
        商談の記録を、正しいお客様につなげます。
      </p>
      <div className="linkage-grid">
        {state.links.map((l) => (
          <section className="linkage-card" key={l.id}>
            <div className="linkage-source">
              <span className="icon-tile lavender">
                {l.source === "ボイスメモ" ? (
                  <Mic size={20} />
                ) : l.source === "TimeRex" ? (
                  <CalendarDays size={20} />
                ) : (
                  <Video size={20} />
                )}
              </span>
              <span>
                <strong>{l.source}</strong>
                <small>{l.date}</small>
              </span>
              <Badge tone={l.linked ? "sage" : "stone"}>
                {l.linked ? "紐付け済み" : "確認待ち"}
              </Badge>
            </div>
            <h2>{l.title}</h2>
            <p className="meeting-excerpt">{l.summary}</p>
            <div className="match-connector">
              <span />
              <Link2 size={18} />
              <span />
            </div>
            <div className="match-customer">
              <Avatar
                person={person(
                  l.linked ? l.linkedCustomer : choices[l.id] || l.customerId,
                )}
              />
              <div>
                <strong>
                  {
                    person(
                      l.linked
                        ? l.linkedCustomer
                        : choices[l.id] || l.customerId,
                    ).name
                  }{" "}
                  様
                </strong>
                <small>
                  {choices[l.id] && choices[l.id] !== l.customerId
                    ? "手動で選択"
                    : l.basis}
                </small>
              </div>
              {l.linked && <CheckCircle2 size={20} />}
            </div>
            {!l.linked ? (
              <>
                <Button icon={Link2} onClick={() => link(l)}>
                  この顧客に紐付ける
                </Button>
                <details className="manual-match">
                  <summary>
                    別の顧客を選ぶ <ChevronDown size={14} />
                  </summary>
                  <label className="sr-only" htmlFor={`match-${l.id}`}>
                    紐付ける顧客
                  </label>
                  <select
                    id={`match-${l.id}`}
                    value={choices[l.id] || l.customerId}
                    onChange={(e) =>
                      setChoices({ ...choices, [l.id]: e.target.value })
                    }
                  >
                    {state.customers.map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name} 様
                      </option>
                    ))}
                  </select>
                </details>
              </>
            ) : (
              <div className="success-line centered">
                <CheckCircle2 size={17} />
                「今日の候補」に提案を作成しました
              </div>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function AssetLibrary({ setModal }) {
  const [filter, setFilter] = useState("すべて"),
    [search, setSearch] = useState("");
  return (
    <>
      <p className="page-description">
        お客様の検討を助ける、資料や事例を集めました。
      </p>
      <div className="asset-toolbar">
        <div className="segmented">
          {["すべて", "公開中", "失効"].map((f) => (
            <button
              key={f}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="inline-search">
          <Search size={16} />
          <input
            aria-label="営業素材を検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="資料名で検索"
          />
        </label>
      </div>
      <div className="asset-grid">
        {assets
          .filter(
            (a) =>
              (filter === "すべて" || a.status === filter) &&
              a.title.includes(search),
          )
          .map((a) => (
            <button
              key={a.id}
              className="asset-card"
              onClick={() => setModal({ type: "asset", id: a.id })}
            >
              <div className={`asset-cover ${a.color}`}>
                <span className="cover-top">
                  TSUNAGU LIBRARY <ArrowUpRight size={17} />
                </span>
                <div className="document-art">
                  <span>{a.kind}</span>
                  <FileText size={38} />
                  <i />
                  <i />
                </div>
                <span className="cover-category">{a.tag}</span>
              </div>
              <div className="asset-card-body">
                <div>
                  <Badge tone={a.status === "公開中" ? "sage" : "stone"}>
                    {a.status}
                  </Badge>
                  <small>{a.source}</small>
                </div>
                <h2>{a.title}</h2>
                <p>{a.description}</p>
                <footer>
                  <span>
                    承認率 <strong>{a.approval}%</strong>
                  </span>
                  <span>
                    予約率 <strong>{a.appointment}%</strong>
                  </span>
                </footer>
              </div>
            </button>
          ))}
      </div>
      {!assets.some(
        (a) =>
          (filter === "すべて" || a.status === filter) &&
          a.title.includes(search),
      ) && (
        <Empty
          icon={Search}
          title="該当する資料はありません"
          description="検索語や公開状態を変更してください。"
        />
      )}
    </>
  );
}
function AssetDetail({ asset: a }) {
  return (
    <div className="asset-detail">
      <div className={`asset-detail-cover ${a.color}`}>
        <Badge tone="stone">{a.kind} · サンプル</Badge>
        <FileText size={42} />
        <h2>{a.title}</h2>
        <p>{a.description}</p>
      </div>
      <div className="grouped-list">
        <div>
          <span>公開状態</span>
          <Badge tone={a.status === "公開中" ? "sage" : "stone"}>
            {a.status}
          </Badge>
        </div>
        <div>
          <span>情報源</span>
          <strong>{a.source}</strong>
        </div>
        <div>
          <span>利用シーン</span>
          <strong>{a.tag}</strong>
        </div>
      </div>
      <section className="profile-section">
        <h3>資料に含まれる内容</h3>
        <ol>
          <li>お客様からよくいただくご相談</li>
          <li>検討するときに整理しておきたい項目</li>
          <li>担当者と一緒に確認する次のステップ</li>
        </ol>
      </section>
      <p className="form-note">
        デザイン確認用の資料プレビューです。実際の金融条件・物件情報を示すものではありません。
      </p>
    </div>
  );
}

function Policies({ state, update, role, notify, setModal }) {
  return (
    <>
      <div className="policy-intro">
        <span className="policy-intro-icon">
          <ShieldCheck size={30} />
        </span>
        <div>
          <h2>任せる範囲を、少しずつ。</h2>
          <p>実績を確認しながら、連絡の種類ごとに自動化の範囲を調整します。</p>
        </div>
      </div>
      <div className="policy-levels">
        {[
          ["0", "候補の抽出", "営業担当者が文面を作成"],
          ["1", "確認して送信", "文面を確認し、承認して送信"],
          ["2", "条件付き自動", "条件に合うものだけ自動送信"],
        ].map(([n, t, d]) => (
          <div key={n}>
            <span>LEVEL {n}</span>
            <strong>{t}</strong>
            <p>{d}</p>
          </div>
        ))}
      </div>
      <div className="policies-list">
        {state.policies.map((p) => {
          const ready = p.level === 1 && p.rate >= 90 && p.edits === 0;
          return (
            <section
              className={`policy-card ${ready ? "eligible" : ""}`}
              key={p.id}
            >
              <div className="policy-card-top">
                <span
                  className={`icon-tile ${p.level === 2 ? "sage" : "blue"}`}
                >
                  <ShieldCheck size={20} />
                </span>
                <div>
                  <h2>{p.title}</h2>
                  <p>{p.desc}</p>
                </div>
                <Badge
                  tone={
                    p.level === 2 ? "sage" : p.level === 1 ? "blue" : "stone"
                  }
                >
                  Level {p.level} ·{" "}
                  {["候補抽出", "承認制", "条件付き自動"][p.level]}
                </Badge>
              </div>
              <div className="policy-stats">
                <span>
                  直近7日の承認率<strong>{p.rate}%</strong>
                </span>
                <span>
                  重要な修正<strong>{p.edits}%</strong>
                </span>
                <span>
                  変更の権限
                  <strong>
                    {role === "manager" ? "管理者" : "管理者のみ"}
                  </strong>
                </span>
              </div>
              {ready ? (
                <div className="promotion">
                  <div>
                    <Sparkles size={17} />
                    <span>
                      昇格の条件を満たしています
                      <small>承認率90%以上・重要修正ゼロ</small>
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={role !== "manager"}
                    onClick={() => setModal({ type: "policy", id: p.id })}
                  >
                    自動化の範囲を確認
                  </Button>
                </div>
              ) : (
                p.level === 2 && (
                  <button
                    className="text-link"
                    disabled={role !== "manager"}
                    onClick={() => {
                      update(
                        (s) =>
                          (s.policies.find((x) => x.id === p.id).level = 1),
                      );
                      notify("承認制に戻しました");
                    }}
                  >
                    承認制に戻す
                    <Undo2 size={13} />
                  </button>
                )
              )}
            </section>
          );
        })}
      </div>
      <div className="info-callout">
        <LockKeyhole size={18} />
        <p>
          新しい返信・成約・情報の矛盾を検知した場合は、自動化のレベルにかかわらず送信を保留します。
        </p>
      </div>
    </>
  );
}
function PolicyConfirm({ policy: p, onConfirm }) {
  return (
    <div className="policy-confirm">
      <span className="large-icon sage">
        <ShieldCheck size={32} />
      </span>
      <h2>条件付き自動に変更しますか？</h2>
      <p>{p.title}</p>
      <div className="grouped-list">
        <div>
          <span>変更前</span>
          <strong>Level 1 · 承認して送信</strong>
        </div>
        <div>
          <span>変更後</span>
          <strong>Level 2 · 条件付き自動</strong>
        </div>
      </div>
      <div className="info-callout">
        <ShieldCheck size={18} />
        <p>
          この種類の連絡に限り、条件に合う提案を自動送信します。保留条件は引き続き適用され、いつでも承認制に戻せます。
        </p>
      </div>
      <Button icon={Check} onClick={onConfirm}>
        管理者として変更を承認
      </Button>
    </div>
  );
}

function StyleSettings({ state, update, notify }) {
  const fileRef = useRef(null),
    [fileNote, setFileNote] = useState("");
  const prompts = [
    "初めてお問い合わせいただいたとき",
    "不安を感じているお客様への返答",
    "もう一度ご連絡するとき",
    "面談のお礼を伝えるとき",
  ];
  const answered = state.style.answers.filter((a) => a.trim()).length;
  async function readFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      notify("2MB以下のテキストファイルを選択してください");
      return;
    }
    const text = await file.text();
    setFileNote(
      `${file.name} · ${text.split(/\r?\n/).filter(Boolean).length}行を読み取りました`,
    );
    notify("テキストを読み取りました。原文は保存していません。");
    e.target.value = "";
  }
  return (
    <>
      <p className="page-description">普段の言葉づかいを、提案にも。</p>
      <div className="style-layout">
        <section className="style-main">
          <SectionHead
            title="いつもの言葉を教えてください"
            aside={<Badge tone="blue">{answered} / 4 回答</Badge>}
          />
          <p className="form-note">
            ご自身ならどう返すか、短い文章で大丈夫です。
          </p>
          {prompts.map((p, i) => (
            <div className="style-question" key={p}>
              <label htmlFor={`style-${i}`}>
                <span>0{i + 1}</span>
                {p}
              </label>
              <textarea
                id={`style-${i}`}
                rows={3}
                value={state.style.answers[i]}
                placeholder="普段の言葉で入力してください…"
                onChange={(e) =>
                  update((s) => {
                    s.style.answers[i] = e.target.value;
                    s.style.saved = false;
                  })
                }
              />
            </div>
          ))}
          <Button
            icon={Check}
            onClick={() => {
              update((s) => (s.style.saved = true));
              notify("回答をこのブラウザーに保存しました");
            }}
          >
            {state.style.saved ? "保存しました" : "回答を保存"}
          </Button>
        </section>
        <aside>
          <section className="tone-card">
            <h2>メッセージの雰囲気</h2>
            <p>ご希望に近いトーンを選択。</p>
            <div className="tone-options">
              {[
                ["natural", "自然でていねい", "親しみと丁寧さのバランス"],
                ["formal", "落ち着いて丁寧", "敬語を基本に、端的に"],
                [
                  "friendly",
                  "やわらかく親しみやすい",
                  "短い文章で、気軽な印象",
                ],
              ].map(([v, l, d]) => (
                <label
                  key={v}
                  className={state.style.tone === v ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="tone"
                    value={v}
                    checked={state.style.tone === v}
                    onChange={() => update((s) => (s.style.tone = v))}
                  />
                  <span>
                    <strong>{l}</strong>
                    <small>{d}</small>
                  </span>
                  {state.style.tone === v && <CheckCircle2 size={19} />}
                </label>
              ))}
            </div>
            <div className="tone-preview">
              <Badge tone="lavender">文体サンプル</Badge>
              <p>
                {state.style.tone === "formal"
                  ? "田中様、お世話になっております。先日はお時間をいただき、誠にありがとうございました。"
                  : state.style.tone === "friendly"
                    ? "田中様、こんにちは！先日はありがとうございました。その後、気になることはありませんか？"
                    : "田中様、こんにちは。先日はお時間をいただき、ありがとうございました。"}
              </p>
            </div>
          </section>
          <section className="upload-card">
            <span className="icon-tile stone">
              <Upload size={20} />
            </span>
            <h3>過去のトーク履歴を使う</h3>
            <p>
              TXTを選び、読み取りを試せます。デモでは文体のAI学習は行いません。
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              className="sr-only"
              onChange={readFile}
              aria-label="トーク履歴TXTを選択"
            />
            <Button variant="secondary" onClick={() => fileRef.current.click()}>
              TXTファイルを選択
            </Button>
            {fileNote && <p className="file-note">{fileNote}</p>}
          </section>
        </aside>
      </div>
    </>
  );
}

function Integrations({ state, update, setModal, notify }) {
  const [busy, setBusy] = useState(null);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  function reconnect(id) {
    setBusy(id);
    timers.current.push(
      setTimeout(() => {
        update((s) => (s.connections[id] = "connected"));
        setBusy(null);
        notify("接続確認のデモが完了しました");
      }, 500),
    );
  }
  return (
    <>
      <div className="section-toolbar">
        <p className="page-description">
          営業の情報を、ひとつのワークスペースへ。
        </p>
        <Button
          variant="secondary"
          icon={HelpCircle}
          onClick={() => setModal({ type: "support" })}
        >
          セットアップを相談
        </Button>
      </div>
      <div className="integrations-panel">
        {integrations.map((i) => (
          <section key={i.id} className="integration-row">
            <span className={`service-logo ${i.tone}`}>{i.letter}</span>
            <div className="integration-info">
              <h2>{i.name}</h2>
              <p>{i.desc}</p>
              <small>最終同期 9/21 {i.sync} · サンプル</small>
            </div>
            <Badge
              tone={state.connections[i.id] === "connected" ? "sage" : "amber"}
              dot
            >
              {state.connections[i.id] === "connected"
                ? "接続済み"
                : "確認が必要"}
            </Badge>
            <Button
              variant="secondary"
              icon={RefreshCw}
              disabled={busy === i.id}
              onClick={() => reconnect(i.id)}
            >
              {busy === i.id ? "確認中…" : "接続を再確認"}
            </Button>
          </section>
        ))}
      </div>
      <details className="integration-demo">
        <summary>
          連携エラーの表示を確認 <ChevronDown size={14} />
        </summary>
        <p>デモでは実際の接続・再認証は行いません。</p>
        <Button
          variant="secondary"
          onClick={() => {
            update((s) => (s.connections.sheets = "error"));
            notify("Google Sheetsの同期失敗を再現しました");
          }}
        >
          Google Sheetsの同期失敗を再現
        </Button>
      </details>
      {state.connections.sheets === "error" && (
        <div className="hold-callout">
          <AlertCircle size={21} />
          <div>
            <strong>物件マスタを同期できませんでした</strong>
            <p>
              「公開フラグ」列が見つかりません。列名を確認するか、セットアップをご相談ください。
            </p>
            <button
              className="text-link"
              onClick={() => setModal({ type: "support" })}
            >
              セットアップを相談
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
function Support({ onSubmit }) {
  const [note, setNote] = useState("");
  return (
    <form
      className="support-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="lead">連携の設定を、一緒に確認します。</p>
      <div className="grouped-list">
        <div>
          <span>対象企業</span>
          <strong>ネクスト・プロパティ</strong>
        </div>
        <div>
          <span>対象サービス</span>
          <strong>Google Sheets</strong>
        </div>
      </div>
      <div className="form-group">
        <label htmlFor="support-note">お困りの内容</label>
        <textarea
          id="support-note"
          rows={5}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="設定で困っていることを教えてください。"
          required
        />
      </div>
      <p className="form-note">相談受付のデモです。外部には送信しません。</p>
      <Button type="submit" icon={Send} disabled={!note.trim()}>
        相談内容を確認
      </Button>
    </form>
  );
}
function GlobalSearch({ people, go, setModal }) {
  const [q, setQ] = useState("");
  const norm = (s) => s.replace(/\s/g, "").toLowerCase();
  return (
    <div className="global-search">
      <label className="large-search">
        <Search size={20} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="顧客名・画面名を入力"
          aria-label="顧客・画面の検索"
        />
      </label>
      <h3>顧客</h3>
      {people
        .filter((c) => norm(c.name + c.subtitle).includes(norm(q)))
        .map((c) => (
          <button
            key={c.id}
            onClick={() => setModal({ type: "customer", id: c.id })}
          >
            <Avatar person={c} />
            <span>
              <strong>{c.name} 様</strong>
              <small>{c.subtitle}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))}
      <h3>画面</h3>
      {[...navItems, ...adminItems]
        .filter(([id, l]) => l.includes(q))
        .map(([id, l, Icon]) => (
          <button key={id} onClick={() => go(id)}>
            <span className="icon-tile stone">
              <Icon size={18} />
            </span>
            <strong>{l}</strong>
            <ArrowRight size={16} />
          </button>
        ))}
      {!people.some((c) => norm(c.name + c.subtitle).includes(norm(q))) &&
        ![...navItems, ...adminItems].some(([, l]) => l.includes(q)) && (
          <p className="form-note">該当する顧客・画面はありません。</p>
        )}
    </div>
  );
}
function BulkReview({ ids, state, person, approve }) {
  const [ack, setAck] = useState(false);
  const list = state.candidates.filter(
    (c) =>
      ids.includes(c.id) &&
      c.status === "pending" &&
      person(c.customerId).mode === "ai" &&
      !state.booking[c.customerId],
  );
  return (
    <div className="bulk-review">
      <p className="sheet-description">
        表示中の候補から選んだ{list.length}
        件を承認します。各文面と送信時刻をご確認ください。
      </p>
      {list.map((c) => (
        <section className="bulk-item" key={c.id}>
          <div>
            <Avatar person={person(c.customerId)} />
            <strong>{person(c.customerId).name} 様</strong>
            <Badge tone="stone">{c.time}</Badge>
          </div>
          <p>{c.draft || "文面が空です。提案画面で入力してください。"}</p>
        </section>
      ))}
      <label className="acknowledge">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        文面と送信先・時刻を確認しました
      </label>
      <Button
        icon={Check}
        disabled={!ack || !list.length || list.some((c) => !c.draft.trim())}
        onClick={() => approve(list.map((c) => c.id))}
      >
        {list.length}件を承認して送信予約
      </Button>
    </div>
  );
}
