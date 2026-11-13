import { useEffect, useState, type ReactNode } from 'react';
import { locale, t, useT } from '../../i18n';
import '../../styles/config.css';

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="cfg-field">
      <label className="cfg-field__label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="cfg-field__hint">{hint}</div>}
    </div>
  );
}

/** A small segmented control with optional per-option hints. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="cfg-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Button that asks "Sure?" in place before running a destructive action. */
export function ConfirmButton({ children, confirmLabel, onConfirm, className = 'cfg-btn cfg-btn--ghost-danger', disabled, title }: { children: ReactNode; confirmLabel?: string; onConfirm: () => Promise<unknown> | void; className?: string; disabled?: boolean; title?: string }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(timer);
  }, [asking]);
  if (!asking) return <button type="button" className={className} disabled={disabled} title={title} onClick={() => setAsking(true)}>{children}</button>;
  return (
    <button
      type="button"
      className="cfg-btn cfg-btn--danger"
      disabled={busy}
      onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setAsking(false); } }}
    >
      {busy ? t('Working…') : confirmLabel ?? t('Delete')}
    </button>
  );
}

export function shortDate(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(locale(), opts);
}

/** "Next today 8:00 AM", shown in the routine's own time zone so it matches its schedule text. */
export function nextRunLabel(ts: number | null, timeZone?: string): string {
  if (!ts) return '';
  let tz = timeZone || undefined;
  try { new Intl.DateTimeFormat(locale(), { timeZone: tz }); } catch { tz = undefined; }
  const dayKey = (at: number) => new Date(at).toLocaleDateString(locale(), { timeZone: tz });
  const day = new Date(ts).toLocaleDateString(locale(), { weekday: 'short', timeZone: tz });
  const time = new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', timeZone: tz });
  if (dayKey(ts) === dayKey(Date.now())) return t('Next today {time}', { time });
  if (dayKey(ts) === dayKey(Date.now() + 86_400_000)) return t('Next tomorrow {time}', { time });
  return t('Next {day} {time}', { day, time });
}

/** How long ago, in words: "just now", "5m ago", "yesterday", "3d ago". */
export function agoLabel(ts: number, now = Date.now()): string {
  const s = (now - ts) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.floor(s / 3600) });
  if (s < 172800) return t('yesterday');
  return t('{n}d ago', { n: Math.floor(s / 86400) });
}

/** The same, compact, for a column of dates: "just now", "5m", "Yesterday", "3d". */
export function ageLabel(ts: number, now = Date.now()): string {
  const s = (now - ts) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n}m', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n}h', { n: Math.floor(s / 3600) });
  if (s < 172800) return t('Yesterday');
  return t('{n}d', { n: Math.floor(s / 86400) });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
