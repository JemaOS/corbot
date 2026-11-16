import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Attachment } from './types.js';

/**
 * Files a person adds to a message. They are saved on the computer the bots work on, in the bot's
 * Library (`uploads/`), so the bot opens them with its own tools: the message only carries where they are.
 */

const LIB_ROOT = '/root/corbot/files';
const DIR = 'uploads';
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export class UploadError extends Error {
  constructor(public status: 400 | 413, message: string) { super(message); }
}

const uploadsOf = (botId: string) => path.join(LIB_ROOT, botId, DIR);

/** A file name that is safe on disk and in a shell, keeping its extension. */
function cleanName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).normalize('NFC').replace(/[^\p{L}\p{N}._ ()-]/gu, '_').replace(/^[.\s]+/, '').trim();
  const ext = path.extname(base).slice(0, 16);
  return ((base.slice(0, base.length - ext.length).slice(0, 100) || 'file') + ext);
}

/** Save an uploaded file for this bot. The name gets a number if one like it is already there. */
export async function saveUpload(botId: string, rawName: string, body: ReadableStream<Uint8Array> | null): Promise<Attachment> {
  if (!body) throw new UploadError(400, 'The file is empty.');
  const dir = uploadsOf(botId);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = cleanName(rawName);
  const ext = path.extname(name);
  let final = name;
  let fd: fs.promises.FileHandle | null = null;
  for (let i = 2; !fd; i++) {
    try { fd = await fs.promises.open(path.join(dir, final), 'wx', 0o644); }
    catch (e: any) {
      if (e?.code !== 'EEXIST' || i > 500) throw e;
      final = `${name.slice(0, name.length - ext.length)}-${i}${ext}`;
    }
  }
  const file = path.join(dir, final);
  let size = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > MAX_UPLOAD_BYTES ? new UploadError(413, `The file is too big (the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as any), count, fd.createWriteStream());
  } catch (e) {
    await fs.promises.rm(file, { force: true });
    throw e;
  }
  if (!size) {
    await fs.promises.rm(file, { force: true });
    throw new UploadError(400, 'The file is empty.');
  }
  return { name: final, path: `${DIR}/${final}`, size };
}

/** The attachments of a message, checked against what is really on disk for this bot. */
export function checkAttachments(botId: string, list: unknown): Attachment[] {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    const name = path.basename(String((a as any)?.path ?? ''));
    if (!name || name !== cleanName(name)) continue;
    try {
      const st = fs.lstatSync(path.join(uploadsOf(botId), name));
      if (st.isFile()) out.push({ name, path: `${DIR}/${name}`, size: st.size });
    } catch { /* not there: leave it out */ }
  }
  return out;
}

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** What the bot is told about the files, after the person's own words. */
export function attachmentNote(botId: string, list: Attachment[]): string {
  if (!list.length) return '';
  const lines = list.map((a) => `- ${path.join(uploadsOf(botId), a.name)} (${human(a.size)})`);
  return `[The user attached ${list.length === 1 ? 'a file' : `${list.length} files`} to this message. ${list.length === 1 ? 'It is' : 'They are'} saved on your computer:\n${lines.join('\n')}\nOpen ${list.length === 1 ? 'it' : 'them'} with your own tools (read the file, look at the image, run a command) before you answer.]`;
}
