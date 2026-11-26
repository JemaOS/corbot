import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { api, type ScreenInput } from '../lib/api';

/** What a hidden field holds so that Backspace always has something to delete. */
const SENTINEL = '\u00a0'.repeat(8);
/** Finger travel, in CSS pixels, that counts as one scroll step. */
const SCROLL_STEP_PX = 36;
/** Finger travel below which a touch is still a tap. */
const TAP_SLOP_PX = 10;
/** A touch held this long without moving is a right click. */
const LONG_PRESS_MS = 550;

interface Props {
  botId: string;
  /** The hidden field that brings up the phone's keyboard; the parent focuses it from its own button. */
  keysRef: RefObject<HTMLTextAreaElement>;
  /** Called after each input reached the screen, so the picture can refresh at once. */
  onSent: () => void;
  onError: (message: string) => void;
}

/**
 * Driving a bot's screen from a phone, over the picture view: a tap clicks, a held touch right-clicks,
 * a vertical swipe scrolls, and the phone's keyboard types. Inputs are sent one after the other, in
 * order, so a fast typist never sees letters swapped.
 */
export function TouchDrive({ botId, keysRef, onSent, onError }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  // Inputs wait their turn, one request at a time, in order. While one is on its way, the ones that
  // follow are merged where that changes nothing (letters into one text, Backspaces into one repeat),
  // so typing stays quick on a slow link.
  const pending = useRef<ScreenInput[]>([]);
  const busy = useRef(false);
  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (pending.current.length) {
        const next = pending.current.shift()!;
        while (pending.current.length) {
          const after = pending.current[0];
          if (next.type === 'text' && after.type === 'text') { next.text += after.text; pending.current.shift(); continue; }
          if (next.type === 'key' && after.type === 'key' && next.key === after.key && next.key === 'BackSpace') {
            next.repeat = (next.repeat ?? 1) + (after.repeat ?? 1); pending.current.shift(); continue;
          }
          break;
        }
        try { await api.screenInput(botId, next); onSent(); } catch (e) { onError((e as Error).message); }
      }
    } finally {
      busy.current = false;
    }
  }, [botId, onSent, onError]);
  const send = useCallback((input: ScreenInput) => {
    pending.current.push({ ...input });
    void pump();
  }, [pump]);

  // ---- touch ----
  const touch = useRef<{ id: number; x: number; y: number; lastY: number; acc: number; moved: boolean; long: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const at = (clientX: number, clientY: number) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Cancelling the pointerdown also cancels the compatibility mousedown that follows a touch, which
    // would otherwise take the focus back from the keyboard field right after the tap gave it.
    e.preventDefault();
    if (touch.current) return;
    layerRef.current?.setPointerCapture(e.pointerId);
    const t = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, acc: 0, moved: false, long: false, timer: null as ReturnType<typeof setTimeout> | null };
    t.timer = setTimeout(() => {
      if (!touch.current || touch.current.moved) return;
      touch.current.long = true;
      send({ type: 'tap', ...at(t.x, t.y), button: 3 });
    }, LONG_PRESS_MS);
    touch.current = t;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    if (!t.moved && Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_SLOP_PX) {
      t.moved = true;
      if (t.timer) clearTimeout(t.timer);
    }
    if (!t.moved) return;
    t.acc += e.clientY - t.lastY;
    t.lastY = e.clientY;
    const steps = Math.trunc(t.acc / SCROLL_STEP_PX);
    if (steps) {
      t.acc -= steps * SCROLL_STEP_PX;
      // The finger pushes the page: moving up shows what is below.
      send({ type: 'scroll', ...at(e.clientX, e.clientY), dy: -steps });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    touch.current = null;
    if (t.timer) clearTimeout(t.timer);
    if (t.moved || t.long) return;
    send({ type: 'tap', ...at(t.x, t.y), button: 1 });
    // A tap is where one types next: bring up the keyboard, inside the same gesture so the phone allows it.
    focusKeys(keysRef.current);
  };

  const onPointerCancel = () => {
    if (touch.current?.timer) clearTimeout(touch.current.timer);
    touch.current = null;
  };

  // ---- keyboard ----
  const last = useRef(SENTINEL);
  const composing = useRef(false);

  const reseed = (el: HTMLTextAreaElement) => {
    el.value = SENTINEL;
    last.current = SENTINEL;
    el.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  // Phone keyboards report what changed in the field, not which key was pressed (keyCode 229), and
  // rewrite whole words when they suggest or correct. Comparing the field before and after gives the
  // exact keystrokes: as many Backspaces as characters lost, then the new text.
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const before = last.current;
    const now = el.value;
    let p = 0;
    while (p < before.length && p < now.length && before[p] === now[p]) p++;
    const removed = before.length - p;
    const added = now.slice(p);
    last.current = now;
    if (removed > 0) send({ type: 'key', key: 'BackSpace', repeat: removed });
    if (added) {
      added.split('\n').forEach((part, i) => {
        if (i > 0) send({ type: 'key', key: 'Return' });
        if (part) send({ type: 'text', text: part });
      });
    }
    if (!composing.current && (now.length > 64 || !now.startsWith(SENTINEL))) reseed(el);
  };

  // Keys that change nothing in a text field, from a hardware or full keyboard.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const key = KEYS[e.key];
    if (!key) return;
    e.preventDefault();
    send({ type: 'key', key });
  };

  useEffect(() => {
    const el = keysRef.current;
    if (el) reseed(el);
  }, [keysRef]);

  return (
    <>
      <div
        ref={layerRef}
        className="screen__touch"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!touch.current) focusKeys(keysRef.current); }}
      />
      <textarea
        ref={keysRef}
        className="screen__keys"
        aria-hidden
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        enterKeyHint="enter"
        onInput={onInput}
        onKeyDown={onKeyDown}
        onFocus={(e) => reseed(e.currentTarget)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; onInput(e as unknown as React.FormEvent<HTMLTextAreaElement>); }}
      />
    </>
  );
}

/** Keys sent as keys: they move or leave the text rather than change it. */
const KEYS: Record<string, string> = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Tab: 'Tab', Escape: 'Escape', Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down', Delete: 'Delete',
};

/** Focus the keyboard field without scrolling the page under it. */
export function focusKeys(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
}
