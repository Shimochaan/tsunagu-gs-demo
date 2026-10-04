import React, { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  ChevronDown,
  X,
  Plus,
  Search,
  LayoutDashboard,
  Building2,
  Users,
  MessageCircle,
  CalendarDays,
  FileText,
  Sparkles,
  Clock,
  ShieldCheck,
  LockKeyhole,
  Link2,
  Rocket,
  Workflow,
  Layers,
  LogIn,
  Activity,
  ChartNoAxesCombined,
  SlidersHorizontal,
  Settings,
  Video,
  HandHeart,
  Mail,
  RefreshCw,
  Database,
  AlertCircle,
  Download,
  Copy,
  Globe,
  KeyRound,
  MousePointer2,
  Play,
  Pause,
  ExternalLink,
  CheckCircle2,
  HelpCircle,
  ArrowDown,
  Terminal,
  Monitor,
  Smartphone,
  UserRound,
  Package,
  Eye,
  MoreHorizontal,
  Wallet,
  Send,
  LoaderCircle,
} from "lucide-react";
export const icons = {
  ArrowRight,
  ArrowUpRight,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  ChevronDown,
  X,
  Plus,
  Search,
  LayoutDashboard,
  Building2,
  Users,
  MessageCircle,
  CalendarDays,
  FileText,
  Sparkles,
  Clock,
  ShieldCheck,
  LockKeyhole,
  Link2,
  Rocket,
  Workflow,
  Layers,
  LogIn,
  Activity,
  ChartNoAxesCombined,
  SlidersHorizontal,
  Settings,
  Video,
  HandHeart,
  Mail,
  RefreshCw,
  Database,
  AlertCircle,
  Download,
  Copy,
  Globe,
  KeyRound,
  MousePointer2,
  Play,
  Pause,
  ExternalLink,
  CheckCircle2,
  HelpCircle,
  ArrowDown,
  Terminal,
  Monitor,
  Smartphone,
  UserRound,
  Package,
  Eye,
  MoreHorizontal,
  Wallet,
  Send,
  LoaderCircle,
};
export function I({ name, size = 18, ...props }) {
  const Icon = icons[name] || icons.Layers;
  return <Icon size={size} strokeWidth={1.7} {...props} />;
}
export function B({
  children,
  icon,
  variant = "primary",
  className = "",
  ...props
}) {
  return (
    <button className={`pt-btn ${variant} ${className}`} {...props}>
      {icon && <I name={icon} size={16} />}
      <span>{children}</span>
    </button>
  );
}
export function Tag({ children, tone = "stone", dot = false }) {
  return (
    <span className={`pt-tag ${tone}`}>
      {dot && <i />}
      {children}
    </span>
  );
}
export function Tile({ name, tone = "lavender", size = 20 }) {
  return (
    <span className={`pt-icon-tile ${tone}`}>
      <I name={name} size={size} />
    </span>
  );
}
export function Brand({ ops = false, onClick }) {
  return (
    <button className="pt-brand" onClick={onClick}>
      <span>
        <I name="Link2" size={22} />
      </span>
      tsunagu<b>.</b>
      {ops && <small>OPERATIONS</small>}
    </button>
  );
}
export function Field({ label, hint, children, ...props }) {
  return (
    <label className="pt-field" {...props}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Title({ eyebrow, title, description, children }) {
  return (
    <header className="pt-page-title">
      <div>
        {eyebrow && <p className="pt-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="pt-title-actions">{children}</div>}
    </header>
  );
}
export function Section({ title, sub, children, action, className = "" }) {
  return (
    <section className={`pt-panel ${className}`}>
      <div className="pt-panel-heading">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Note({ children, tone = "blue", icon = "ShieldCheck" }) {
  return (
    <div className={`pt-note ${tone}`}>
      <I name={icon} size={18} />
      <div>{children}</div>
    </div>
  );
}
export function Empty({ title, description, icon = "Layers", children }) {
  return (
    <div className="pt-empty">
      <Tile name={icon} />
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Modal({ open, title, children, onClose, wide = false }) {
  const opener = useRef(null);
  return (
    <Dialog.Root open={Boolean(open)} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="pt-modal-overlay" />
        <Dialog.Content
          className={`pt-modal ${wide ? "wide" : ""}`}
          aria-describedby={undefined}
          onOpenAutoFocus={() => (opener.current = document.activeElement)}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
        >
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="pt-icon-btn" aria-label="閉じる">
                <I name="X" />
              </button>
            </Dialog.Close>
          </header>
          <div className="pt-modal-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Stat({
  label,
  value,
  unit,
  caption,
  icon,
  tone = "blue",
  children,
}) {
  return (
    <div className={`pt-stat ${tone}`}>
      <div>
        <span>{label}</span>
        <Tile name={icon || "ChartNoAxesCombined"} tone={tone} />
      </div>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
      <p>{caption}</p>
      {children}
    </div>
  );
}
export function Avatar({ name, tone = "blue" }) {
  return (
    <span className={`pt-avatar ${tone}`}>{name?.slice(0, 1) || "T"}</span>
  );
}
export function Segments({ value, options, onChange, label }) {
  return (
    <div className="pt-segments" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
export const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
export const num = (n) => Number(n).toLocaleString("ja-JP");
export function Status({ id, model, type = "job" }) {
  const row = (type === "oa" ? model.oaStatuses : model.jobStatuses).find(
    (x) => x.id === id,
  );
  return (
    <Tag tone={row?.tone} dot>
      {row?.label || id}
    </Tag>
  );
}
export function download(name, text, type = "text/plain") {
  const a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
