import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import { sha256 } from './lib/ids.js';
import { engineHome } from './engine.js';
import type { Memory } from './types.js';

/**
 * What a bot remembers lives in its Hermes home, not in our database: `memories/MEMORY.md` (the
 * agent's own notes) and `memories/USER.md` (what it knows about the user). Each file is a list of
 * entries separated by a line holding only "§". The app shows them and lets the user remove one.
 */

const SEP = '\n§\n';
const FILES = [
  { key: 'm', file: 'MEMORY.md', source: 'learned' as const },
  { key: 'u', file: 'USER.md', source: 'chat' as const },
];

function read(file: string): { entries: string[]; mtime: number } {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { entries: raw.split(SEP).map((e) => e.trim()).filter(Boolean), mtime: fs.statSync(file).mtimeMs };
  } catch {
    return { entries: [], mtime: 0 };
  }
}

// Bot ids never contain a dot, so it separates the parts of a memory id.
const idFor = (botId: string, key: string, text: string) => `mem.${botId}.${key}.${sha256(text).slice(0, 16)}`;

export function listMemories(botId: string): Memory[] {
  const home = engineHome(botId);
  if (!home) return [];
  const out: Memory[] = [];
  for (const f of FILES) {
    const { entries, mtime } = read(path.join(home, 'memories', f.file));
    for (const text of entries) out.push({ id: idFor(botId, f.key, text), botId, text, createdAt: Math.round(mtime), source: f.source });
  }
  return out;
}

/** The bot a memory id belongs to, so the caller can check who owns it. */
export function memoryBot(id: string): string | null {
  const parts = id.split('.');
  return parts.length === 4 && parts[0] === 'mem' ? parts[1] : null;
}

export function deleteMemory(id: string): boolean {
  const botId = memoryBot(id);
  const home = botId ? engineHome(botId) : null;
  if (!botId || !home) return false;
  const f = FILES.find((x) => x.key === id.split('.')[2]);
  if (!f) return false;
  const file = path.join(home, 'memories', f.file);
  const { entries } = read(file);
  const keep = entries.filter((text) => idFor(botId, f.key, text) !== id);
  if (keep.length === entries.length) return false;
  fs.writeFileSync(file, keep.join(SEP) + (keep.length ? '\n' : ''));
  return true;
}

// ---------- how full the conversation is ----------

export interface ContextUse {
  /** Tokens the conversation took on the agent's last model call. */
  usedTokens: number;
  /** Tokens at which the agent summarizes older messages. 0 when it is not known. */
  compactAtTokens: number;
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The agent's session behind this bot's current conversation, from its record of our last request. */
function sessionIdFor(home: string, conversation: string): string | null {
  const file = path.join(home, 'response_store.db');
  if (!fs.existsSync(file)) return null;
  let store: Database.Database | null = null;
  try {
    store = new Database(file, { readonly: true, fileMustExist: true });
    const row = store.prepare("SELECT json_extract(r.data, '$.session_id') AS sid FROM conversations c JOIN responses r ON r.response_id = c.response_id WHERE c.name = ?").get(conversation) as any;
    return typeof row?.sid === 'string' && row.sid ? row.sid : null;
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/** The model's context window, from the catalog the agent downloaded from its provider. */
function contextLength(home: string, model: string): number {
  const catalog = readJson(path.join(home, 'cache', 'endpoint_model_metadata.json'));
  // One entry per endpoint: { at, models: { <model id>: { context_length, ... } } }.
  for (const endpoint of Object.values(catalog ?? {}) as any[]) {
    const n = Number(endpoint?.models?.[model]?.context_length);
    if (n > 0) return n;
  }
  return 0;
}

/**
 * How full the bot's conversation is. The agent keeps the conversation itself: after each model call
 * it writes down how many tokens the prompt took (sessions/sessions.json), and it summarizes older
 * messages once that passes a share of the model's context window (`compression.threshold` in its
 * config). Null when the bot has not had a turn yet or the agent keeps no such record.
 */
export function contextUse(botId: string, generation: number, model: string | null): ContextUse | null {
  const home = engineHome(botId);
  if (!home) return null;
  const sessionId = sessionIdFor(home, `corbot-${botId}-g${generation}`);
  if (!sessionId) return null;
  const sessions = readJson(path.join(home, 'sessions', 'sessions.json'));
  const entry = (Object.values(sessions ?? {}) as any[]).find((s) => s?.session_id === sessionId);
  const usedTokens = Number(entry?.last_prompt_tokens);
  if (!(usedTokens > 0)) return null;

  let cfg: any = {};
  try { cfg = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) ?? {}; } catch { /* defaults */ }
  const name = model || (typeof cfg.model === 'string' ? cfg.model : cfg.model?.default) || '';
  const window = Number(cfg.model?.context_length) > 0 ? Number(cfg.model.context_length) : contextLength(home, name);
  const share = cfg.compression?.enabled === false ? 1 : Number(cfg.compression?.threshold) > 0 && Number(cfg.compression.threshold) <= 1 ? Number(cfg.compression.threshold) : 0.5;
  return { usedTokens, compactAtTokens: window > 0 ? Math.round(window * share) : 0 };
}
