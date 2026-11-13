import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { env } from './env.js';

/**
 * The screens of the computer the bots work on. Every screen is an X display of this machine with
 * its own VNC server (TigerVNC's Xvnc, started by the systemd unit corbot-screen@N; see
 * local/provision.sh). Display :99 is the default screen and the others count up from :100.
 */

export interface Screen { id: string; display: string; width: number; height: number; default: boolean }

const DEFAULT_DISPLAY = 99;
const FIRST_EXTRA_DISPLAY = 100;

/** Screen id -> X display number. 'default' is :99, 'screen-100' is :100. */
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
    const r = await run('import', ['-silent', '-window', 'root', '-quality', '75', 'jpeg:-'], { display: displayNumberOf(screenId), timeoutMs: 10_000 });
    if (r.code !== 0 || !r.out.length) throw new Error(`could not take a picture of screen ${screenId}`);
    return { data: r.out, mime: 'image/jpeg' };
  },

  /** Where the VNC server of this screen listens. */
  vncAddress(screenId: string): { host: string; port: number } {
    return { host: '127.0.0.1', port: env.vncPortBase + displayNumberOf(screenId) };
  },
};
