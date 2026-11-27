import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { cdpPortFor } from './desk.js';
import { env } from './env.js';
import { chromeFocusTakesText, textCursorAt } from './screen-focus.js';

/**
 * The screens of the computer the bots work on. Every screen is an X display of this machine with
 * its own VNC server (TigerVNC's Xvnc, started by the systemd unit corbot-screen@N; see
 * local/provision.sh). Display :99 is the default screen and the others count up from :100.
 */

export interface Screen { id: string; display: string; width: number; height: number; default: boolean }

const DEFAULT_DISPLAY = 99;
const FIRST_EXTRA_DISPLAY = 100;

/** Screen id -> X display number. 'default' is :99, 'screen-100' is :100. */
/** One gesture or keystroke sent from a phone to a bot's screen. */
export type ScreenInput =
  | { type: 'tap'; x: number; y: number; button?: 1 | 3 }
  | { type: 'scroll'; x: number; y: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; repeat?: number };

/** The keys a phone sends as keys rather than text. */
export const INPUT_KEYS = new Set(['Return', 'BackSpace', 'Delete', 'Tab', 'Escape', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'Page_Up', 'Page_Down']);

export const displayNumberOf = (screenId: string) => (screenId === 'default' ? DEFAULT_DISPLAY : Number(screenId.replace('screen-', '')));
const idOf = (n: number) => (n === DEFAULT_DISPLAY ? 'default' : `screen-${n}`);

function run(cmd: string, args: string[], opts: { display?: number; timeoutMs?: number; binary?: boolean } = {}): Promise<{ code: number; out: Buffer }> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: opts.timeoutMs ?? 8000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
      env: { PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: process.env.HOME ?? '/root', ...(opts.display !== undefined ? { DISPLAY: `:${opts.display}` } : {}) },
    }, (err, stdout) => resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: stdout as unknown as Buffer }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const socketOf = (n: number) => `/tmp/.X11-unix/X${n}`;
const isOurs = (n: number) => n === DEFAULT_DISPLAY || n >= FIRST_EXTRA_DISPLAY;

/** Display numbers that have an X server socket and are ours to use. */
function localDisplays(): number[] {
  let names: string[] = [];
  try { names = fs.readdirSync('/tmp/.X11-unix'); } catch { return []; }
  return names.map((x) => Number(x.slice(1))).filter((n) => Number.isInteger(n) && isOurs(n)).sort((a, b) => a - b);
}

const sizes = new Map<number, { width: number; height: number }>();

async function localScreen(n: number): Promise<Screen | null> {
  if (!fs.existsSync(socketOf(n))) return null;
  let size = sizes.get(n);
  if (!size) {
    const r = await run('xdotool', ['getdisplaygeometry'], { display: n, timeoutMs: 4000 });
    const m = /^\s*(\d+)\s+(\d+)/.exec(r.out.toString());
    if (r.code !== 0 || !m) return null;     // a socket nobody answers on (the display is still starting, or died)
    size = { width: Number(m[1]), height: Number(m[2]) };
    sizes.set(n, size);
  }
  return { id: idOf(n), display: `:${n}`, ...size, default: n === DEFAULT_DISPLAY };
}

async function localList(): Promise<Screen[]> {
  const all = await Promise.all(localDisplays().map(localScreen));
  return all.filter((s): s is Screen => !!s);
}

/** Start one more display (the systemd unit that runs it), and wait until it answers. */
async function localCreate(): Promise<Screen> {
  const used = new Set(localDisplays());
  let n = FIRST_EXTRA_DISPLAY;
  while (used.has(n)) n++;
  const r = await run('systemctl', ['start', `corbot-screen@${n}`], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`could not start screen :${n} (systemctl start corbot-screen@${n} failed). Was this machine set up with local/provision.sh?`);
  for (let i = 0; i < 60; i++) {
    const s = await localScreen(n);
    if (s) return s;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`screen :${n} did not come up`);
}

export const screens = {
  /** Is the computer up? It is when its first display answers. */
  async up(): Promise<boolean> {
    return !!(await localScreen(DEFAULT_DISPLAY));
  },

  list: localList,

  /** One screen, or a rejection when it is gone. */
  async get(screenId: string): Promise<Screen> {
    sizes.delete(displayNumberOf(screenId));
    const s = await localScreen(displayNumberOf(screenId));
    if (!s) throw new Error(`screen ${screenId} is gone`);
    return s;
  },

  create: localCreate,

  /** A JPEG of the screen as it is now. */
  async screenshot(screenId: string): Promise<{ data: Buffer; mime: string }> {
    const r = await run('import', ['-silent', '-window', 'root', '-quality', '85', 'jpeg:-'], { display: displayNumberOf(screenId), timeoutMs: 10_000 });
    if (r.code !== 0 || !r.out.length) throw new Error(`could not take a picture of screen ${screenId}`);
    return { data: r.out, mime: 'image/jpeg' };
  },

  /**
   * Touch and keyboard from a phone, played on the screen with xdotool. Coordinates are screen pixels.
   * Keys are limited to the editing and navigation keys a phone keyboard cannot type as text.
   */
  async input(screenId: string, a: ScreenInput): Promise<{ keyboard?: boolean }> {
    const display = displayNumberOf(screenId);
    const x = (v: number) => String(Math.max(0, Math.round(v)));
    const xdo = async (args: string[]) => {
      const r = await run('xdotool', args, { display, timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(`xdotool failed on screen ${screenId}`);
    };
    let args: string[];
    switch (a.type) {
      case 'tap': {
        if (a.button === 3) {
          await xdo(['mousemove', x(a.x), x(a.y), 'click', '3']);
          return { keyboard: false };
        }
        // Point first, so the application under the finger shows its own cursor, and read it; then click
        // and ask Chrome what took the focus. (No --sync on mousemove: a second tap on the same spot
        // never moves the pointer and would wait for nothing.)
        await xdo(['mousemove', x(a.x), x(a.y)]);
        await sleep(120);
        const textCursor = await textCursorAt(display);
        await xdo(['click', '1']);
        await sleep(180);
        const chrome = await chromeFocusTakesText(cdpPortFor(screenId));
        return { keyboard: chrome ?? textCursor };
      }
      case 'scroll': {
        const n = Math.min(20, Math.max(1, Math.round(Math.abs(a.dy))));
        args = ['mousemove', x(a.x), x(a.y), 'click', '--repeat', String(n), '--delay', '15', a.dy > 0 ? '5' : '4'];
        break;
      }
      case 'text':
        if (!a.text) return {};
        args = ['type', '--delay', '8', '--clearmodifiers', '--', a.text.slice(0, 2000)];
        break;
      case 'key': {
        if (!INPUT_KEYS.has(a.key)) throw new Error(`key not allowed: ${a.key}`);
        const n = Math.min(200, Math.max(1, Math.round(a.repeat ?? 1)));
        args = ['key', '--clearmodifiers', '--repeat', String(n), '--delay', '10', a.key];
        break;
      }
    }
    await xdo(args);
    return {};
  },

  /** Where the VNC server of this screen listens. */
  vncAddress(screenId: string): { host: string; port: number } {
    return { host: '127.0.0.1', port: env.vncPortBase + displayNumberOf(screenId) };
  },
};
