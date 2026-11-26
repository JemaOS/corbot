import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';

/**
 * Whether a tap on a bot's screen landed somewhere one types, so a phone opens its keyboard only then.
 *
 * Two signals, in this order of trust:
 *  1. Chrome itself, through DevTools: when one of its pages has the focus after the tap, the focused
 *     element says whether it takes text (an input, a textarea, an editable region). A page's plain
 *     text shows a text cursor too, so Chrome's answer wins over the cursor.
 *  2. The pointer's shape at that spot, read before the click: a text cursor (I-beam) over the address
 *     bar, a terminal or a file manager's path field; an arrow over a close button, a tab or a title
 *     bar; a hand over a link or an icon.
 */

/** Reads the cursor currently shown on a display and prints "text" for an I-beam, "other" otherwise. */
const CURSOR_PROBE = String.raw`
import ctypes, sys
x11 = ctypes.CDLL("libX11.so.6"); xf = ctypes.CDLL("libXfixes.so.3")
class Img(ctypes.Structure):
    _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short), ("width", ctypes.c_ushort), ("height", ctypes.c_ushort),
                ("xhot", ctypes.c_ushort), ("yhot", ctypes.c_ushort), ("serial", ctypes.c_ulong),
                ("pixels", ctypes.POINTER(ctypes.c_ulong)), ("atom", ctypes.c_ulong), ("name", ctypes.c_char_p)]
x11.XOpenDisplay.restype = ctypes.c_void_p
xf.XFixesGetCursorImage.restype = ctypes.POINTER(Img)
xf.XFixesGetCursorImage.argtypes = [ctypes.c_void_p]
d = x11.XOpenDisplay(None)
if not d: print("other"); sys.exit(0)
c = xf.XFixesGetCursorImage(d)
if not c: print("other"); sys.exit(0)
i = c.contents
w, h = i.width, i.height
cols, rows = [], []
for k in range(w * h):
    if (i.pixels[k] >> 24) & 0xFF > 128:
        cols.append(k % w); rows.append(k // w)
if not cols: print("other"); sys.exit(0)
narrow = (max(cols) - min(cols) + 1) <= w * 0.5
tall = (max(rows) - min(rows) + 1) >= h * 0.5
# An I-beam is a tall, narrow bar whose hotspot sits in its middle, not at a tip like an arrow or a hand.
centred = i.yhot >= h * 0.3 and min(cols) <= i.xhot <= max(cols)
print("text" if narrow and tall and centred else "other")
`;

export function textCursorAt(display: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('python3', ['-c', CURSOR_PROBE], {
      timeout: 3000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DISPLAY: `:${display}` },
    }, (err, out) => resolve(!err && String(out).trim() === 'text'));
  });
}

/** In the page that has the focus: does the focused element take text? */
const FOCUS_PROBE = `(() => {
  if (!document.hasFocus()) return 'unfocused';
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e || e === document.body) return 'no';
  if (e.tagName === 'IFRAME') return 'unknown';
  if (e.isContentEditable) return 'yes';
  if (e.tagName === 'TEXTAREA') return e.readOnly || e.disabled ? 'no' : 'yes';
  if (e.tagName === 'INPUT') {
    const t = (e.getAttribute('type') || 'text').toLowerCase();
    const typed = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'];
    return typed.includes(t) && !e.readOnly && !e.disabled ? 'yes' : 'no';
  }
  if (e.getAttribute('role') === 'textbox' || e.getAttribute('role') === 'searchbox' || e.getAttribute('role') === 'combobox') return 'yes';
  return 'no';
})()`;

type Verdict = 'yes' | 'no' | 'unfocused' | 'unknown';

function evaluate(wsUrl: string, timeoutMs: number): Promise<Verdict> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Verdict) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch { /* closing */ } resolve(v); };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: FOCUS_PROBE, returnByValue: true } })));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.id !== 1) return;
        const v = msg.result?.result?.value;
        finish(v === 'yes' || v === 'no' || v === 'unfocused' ? v : 'unknown');
      } catch { finish('unknown'); }
    });
    ws.on('error', () => finish('unknown'));
  });
}

/** Chrome's answer for the screen whose DevTools listen on `port`; null when no page has the focus. */
export async function chromeFocusTakesText(port: number): Promise<boolean | null> {
  let pages: { type: string; webSocketDebuggerUrl?: string }[];
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800) });
    pages = (await r.json()) as typeof pages;
  } catch {
    return null; // no Chrome on this screen, or not answering
  }
  const urls = pages.filter((p) => p.type === 'page' && p.webSocketDebuggerUrl).slice(0, 8).map((p) => p.webSocketDebuggerUrl!);
  const verdicts = await Promise.all(urls.map((u) => evaluate(u, 700)));
  if (verdicts.includes('yes')) return true;
  if (verdicts.includes('no')) return false;
  return null;
}
