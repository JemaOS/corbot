import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The box: the computer every bot works on, which is the machine this server runs on. Commands go
 * to its shell and files to its disk.
 */

export interface BashResult { output: string; exit_code: number }

/** Screen id -> X display. The default screen is :99, "screen-100" is :100. */
export const displayFor = (screenId?: string | null) => (!screenId || screenId === 'default' ? ':99' : `:${screenId.replace('screen-', '')}`);

/** Only what a desktop command needs; none of this server's secrets. */
function shellEnv(screenId?: string | null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DISPLAY: displayFor(screenId),
  };
}

function localBash(command: string, timeoutSec: number, screenId?: string | null): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: shellEnv(screenId) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

/** A path safe to put inside single quotes in a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const box = {
  /** Run a bash command on the box. `screenId` picks which screen's DISPLAY it sees. */
  bash(command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
    return localBash(command, timeoutSec, screenId);
  },

  async writeFile(file: string, content: string | Buffer, mode = '0644'): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    await fs.chmod(file, parseInt(mode, 8));
  },

  /** Read a file from the box, or null if it isn't there. */
  async readFile(file: string): Promise<Buffer | null> {
    try { return await fs.readFile(file); } catch { return null; }
  },

  quote: q,
};
