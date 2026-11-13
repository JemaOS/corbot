import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { Icon } from './Icon';

/**
 * The app's drop-down list. A button that opens a list in a layer above everything else, so the
 * list is never cut off by a scrolling panel and looks the same in every browser and theme.
 * It opens upwards when there is no room below, stays inside the window, can be searched when it
 * is long, and works from the keyboard (arrows, Enter, Escape, typing the first letters).
 */

export interface SelectOption<T> {
  value: T;
  label: string;
  /** Secondary text at the end of the row. */
  hint?: string;
  /** Options with the same group are shown together under this heading. */
  group?: string;
}

interface Props<T> {
  /** What is being chosen, for screen readers. */
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Text on the button, when it should differ from the chosen option's label. */
  display?: string;
  /** Classes of the button. Default: the small inline look. */
  className?: string;
  disabled?: boolean;
}

/** A list longer than this gets a search field. */
const SEARCH_FROM = 10;
/** Space between the button and the list, and between the list and the window's edge. */
const GAP = 6;
const EDGE = 8;

interface Place { left: number; top: number | null; bottom: number | null; maxHeight: number }

export function Select<T extends string | number>({ label, value, options, onChange, display, className = 'mini-select', disabled }: Props<T>) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const searchable = options.length > SEARCH_FROM;
  const current = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return options;
    return options.filter((o) => { const text = `${o.label} ${o.hint ?? ''}`.toLowerCase(); return words.every((w) => text.includes(w)); });
  }, [options, query]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close(false);
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setPlace(null);
    setOpen(true);
  };

  const choose = (o: SelectOption<T> | undefined) => {
    if (!o) return;
    close(true);
    if (o.value !== value) onChange(o.value);
  };

  /** Put the list next to the button: below it, or above when there is more room there; never outside the window. */
  const measure = useCallback(() => {
    const b = button.current, p = pop.current;
    if (!b || !p) return;
    const r = b.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh) { setOpen(false); return; }   // the button was scrolled out of sight
    const below = vh - r.bottom - GAP - EDGE, above = r.top - GAP - EDGE;
    const up = below < 220 && above > below;
    const width = p.offsetWidth;
    const next: Place = {
      left: Math.round(Math.max(EDGE, Math.min(r.right - width, vw - width - EDGE))),
      top: up ? null : Math.round(r.bottom + GAP),
      bottom: up ? Math.round(vh - r.top + GAP) : null,
      maxHeight: Math.round(Math.max(120, Math.min(360, up ? above : below))),
    };
    setPlace((was) => (was && was.left === next.left && was.top === next.top && was.bottom === next.bottom && was.maxHeight === next.maxHeight ? was : next));
  }, []);

  useLayoutEffect(() => { if (open) measure(); }, [open, measure, shown.length]);

  useEffect(() => {
    if (!open) return;
    const inside = (n: EventTarget | null) => n instanceof Node && (!!button.current?.contains(n) || !!pop.current?.contains(n));
    const down = (e: PointerEvent) => { if (!inside(e.target)) setOpen(false); };
    const scroll = (e: Event) => { if (!(e.target instanceof Node && pop.current?.contains(e.target))) measure(); };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', measure);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  // Keys go to the open list first, before a dialog or the page acts on them (Escape would close the dialog too).
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const done = () => { e.preventDefault(); e.stopPropagation(); };
      const move = (to: number) => { done(); setActive(Math.max(0, Math.min(shown.length - 1, to))); };
      if (e.key === 'Escape') { done(); close(true); }
      else if (e.key === 'Tab') close(false);
      else if (e.key === 'ArrowDown') move(active + 1);
      else if (e.key === 'ArrowUp') move(active - 1);
      else if (e.key === 'PageDown') move(active + 8);
      else if (e.key === 'PageUp') move(active - 8);
      else if (e.key === 'Enter') { done(); choose(shown[active]); }
      else if (!searchable && e.key === 'Home') move(0);
      else if (!searchable && e.key === 'End') move(shown.length - 1);
      else if (!searchable && e.key === ' ') { done(); choose(shown[active]); }
      else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typing the first letters jumps to the option.
        const now = Date.now();
        typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
        const i = shown.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
        if (i >= 0) move(i);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  useEffect(() => {
    if (open) pop.current?.querySelector('.select-pop__option.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, place]);

  // The list is hidden until it has been placed, and a hidden field cannot take the focus: give it once it shows.
  const placed = !!place;
  useEffect(() => {
    if (open && placed) pop.current?.querySelector<HTMLInputElement>('.select-pop__search')?.focus({ preventScroll: true });
  }, [open, placed]);

  let group: string | undefined;
  return (
    <>
      <button
        ref={button} type="button" className={className} disabled={disabled} onClick={toggle}
        aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${display ?? current?.label ?? String(value)}`}
      >
        <span className="select__value">{display ?? current?.label ?? String(value)}</span>
        <Icon name="chev_down" size={10} opacity={0.66} />
      </button>
      {open && createPortal(
        <div
          ref={pop} className="select-pop"
          style={place ? { left: place.left, top: place.top ?? undefined, bottom: place.bottom ?? undefined, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}
        >
          {searchable && (
            <input
              className="select-pop__search" type="search" value={query} spellCheck={false} autoComplete="off"
              placeholder={t('Search')} aria-label={t('Search')} aria-controls={`${id}-list`}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            />
          )}
          <div className="select-pop__list" id={`${id}-list`} role="listbox" aria-label={label}>
            {shown.length === 0 && <div className="select-pop__empty">{t('Nothing matches.')}</div>}
            {shown.map((o, i) => {
              const heading = o.group !== group ? o.group : undefined;
              group = o.group;
              return (
                <div key={String(o.value)} role="presentation">
                  {heading && <div className="select-pop__group">{heading}</div>}
                  <div
                    role="option" aria-selected={o.value === value}
                    className={`select-pop__option${i === active ? ' is-active' : ''}`}
                    // Keep the focus where it is (the search field, or the button), so typing goes on working.
                    onPointerDown={(e) => e.preventDefault()}
                    onPointerMove={() => { if (i !== active) setActive(i); }}
                    onClick={() => choose(o)}
                  >
                    <span className="select-pop__check">{o.value === value && <Icon name="check" size={12} />}</span>
                    <span className="select-pop__label">{o.label}</span>
                    {o.hint && <span className="select-pop__hint">{o.hint}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
