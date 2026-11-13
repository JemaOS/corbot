import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { displayFor } from './box.js';
import { cdpUrlFor, screenFor } from './computer.js';
import { db } from './db.js';
import { env } from './env.js';
import type { EngineInfo, EngineProvider } from './types.js';

/**
 * Every bot is run by a Hermes agent.
 *
 * - The 'primary' engine is a Hermes gateway that already runs on the computer (HERMES_URL, home
 *   HERMES_HOME_PRIMARY). It has its own life: messaging, memory, model. We only talk to its API
 *   server; we never write its config, restart it or stop it.
 * - A 'managed' engine is a Hermes home of our own under ENGINES_DIR/<botId> with its own
 *   `hermes gateway run`, started here and left running when this server exits. Its home sits
 *   outside ~/.hermes, so Hermes treats it as a separate tenant beside the primary gateway.
 */

export type EngineKind = 'primary' | 'managed';
export interface Engine { kind: EngineKind; url: string; key: string; home: string }

const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;

// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// ---------- identity ----------

/** Token a bot's Hermes agent presents to this server's MCP endpoint. `primary` names the primary bot. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(`mcp:${botId}`).digest('hex');
}

export function primaryBotId(): string | null {
  return (db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get() as any)?.id ?? null;
}

export function engineKind(botId: string): EngineKind | null {
  const e = botRow(botId)?.engine;
  return e === 'primary' || e === 'managed' ? e : null;
}

const homeFor = (botId: string) => path.join(env.enginesDir, botId);

let cachedPrimaryKey: string | null = null;
function primaryKey(): string {
  if (env.hermesKey) return env.hermesKey;
  if (cachedPrimaryKey === null) cachedPrimaryKey = readDotenv(path.join(env.hermesHome, '.env')).API_SERVER_KEY ?? '';
  return cachedPrimaryKey;
}

// ---------- assignment ----------

function freePort(): number {
  const used = new Set((db.prepare('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all() as any[]).map((r) => r.engine_port as number));
  let p = env.enginePortBase;
  while (used.has(p)) p++;
  return p;
}

/** Give a new agent bot its engine: the existing agent if nobody has it yet, otherwise one of our own. */
export function assignEngine(botId: string): EngineKind {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  if (b.engine === 'primary' || b.engine === 'managed') return b.engine;
  if (!primaryBotId()) {
    db.prepare("UPDATE bots SET engine='primary', engine_port=NULL WHERE id=?").run(botId);
    return 'primary';
  }
  db.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(freePort(), botId);
  return 'managed';
}

// ---------- a managed bot's Hermes home ----------

/** Model credentials a managed agent may inherit from the primary agent. Never messaging tokens. */
const SHARED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'KILOCODE_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'DASHSCOPE_API_KEY', 'KIMI_API_KEY', 'KIMI_CN_API_KEY', 'XIAOMI_API_KEY', 'TOKENHUB_API_KEY', 'TOKENPLAN_API_KEY',
  'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'MISTRAL_API_KEY', 'STEPFUN_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN', 'FIREWORKS_API_KEY', 'DEEPINFRA_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
];

/** Parts of the primary agent's config a managed agent starts from, so it reaches the same models. */
const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers'];

function soul(b: any): string {
  const owner = (db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id) as any)?.name ?? 'the user';
  const role = b.label ? `, ${b.label}` : '';
  return [
    `You are ${b.name}${role}. You work for ${owner} as one of a small team of AI agents, each with its own screen on a shared computer.`,
    b.description ? `\n${b.description}` : '',
    '\nYou are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    '',
  ].join('\n');
}

/** Rewrite the persona file after a rename or a new description. The primary agent keeps its own. */
export function syncPersona(botId: string) {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));
}

function extraMcpServers(): Record<string, any> {
  if (!env.extraMcpServers) return {};
  try {
    const v = JSON.parse(env.extraMcpServers);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    console.warn('[engine] EXTRA_MCP_SERVERS is not valid JSON; ignored');
    return {};
  }
}

/** Create or refresh the home. config.yaml is created once; after that only the keys we own are patched. */
async function writeHome(botId: string): Promise<{ home: string; key: string; display: string | null }> {
  const b = botRow(botId);
  const home = homeFor(botId);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.chmodSync(home, 0o700);

  // Its screen decides which display and which Chrome it drives.
  let display: string | null = null;
  let cdp = '';
  try {
    const s = await screenFor(b.user_id, botId);
    display = displayFor(s.screenId);
    cdp = cdpUrlFor(botId, s.screenId);
  } catch (e: any) {
    console.warn(`[engine] no screen for ${b.name} yet: ${e?.message ?? e}`);
  }

  const cwd = `/root/corbot/files/${botId}`;
  fs.mkdirSync(cwd, { recursive: true });

  const cfgFile = path.join(home, 'config.yaml');
  const fresh = !fs.existsSync(cfgFile);
  const cfg = fresh ? {} : readYaml(cfgFile);
  if (fresh) {
    const primary = readYaml(path.join(env.hermesHome, 'config.yaml'));
    for (const k of SHARED_CONFIG) if (primary[k] !== undefined) cfg[k] = primary[k];
    cfg.agent = { reasoning_effort: 'medium' };
  }
  cfg.platform_toolsets = { ...(cfg.platform_toolsets ?? {}), api_server: ['hermes-api-server', ...(display ? ['computer_use'] : [])] };
  cfg.terminal = { ...(cfg.terminal ?? {}), cwd };
  if (cdp) cfg.browser = { ...(cfg.browser ?? {}), cdp_url: cdp };
  cfg.mcp_servers = {
    ...(cfg.mcp_servers ?? {}),
    ...extraMcpServers(),
    corbot: { url: `${env.mcpBaseUrl}/mcp/${botId}`, headers: { Authorization: `Bearer ${mcpToken(botId)}` }, timeout: 1800, connect_timeout: 30 },
  };
  writePrivate(cfgFile, YAML.stringify(cfg));

  if (!fs.existsSync(path.join(home, 'SOUL.md'))) fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));

  // Subscription sign-ins live in auth.json. Start from the primary agent's; later sign-ins are this bot's own.
  const auth = path.join(home, 'auth.json');
  if (!fs.existsSync(auth)) {
    try { writePrivate(auth, fs.readFileSync(path.join(env.hermesHome, 'auth.json'), 'utf8')); } catch { /* the primary agent has none */ }
  }

  // .env is ours entirely: the API server plus inherited model keys. Keys the user added by hand are kept.
  const envFile = path.join(home, '.env');
  const mine = readDotenv(envFile);
  const key = mine.API_SERVER_KEY || crypto.randomBytes(24).toString('hex');
  const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
  const vars: Record<string, string> = { ...mine };
  for (const k of SHARED_ENV) {
    const v = primaryEnv[k] ?? process.env[k];
    if (v && !vars[k]) vars[k] = v;
  }
  Object.assign(vars, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key, API_SERVER_PORT: String(b.engine_port), API_SERVER_HOST: '127.0.0.1' });
  if (cdp) vars.BROWSER_CDP_URL = cdp; else delete vars.BROWSER_CDP_URL;
  writePrivate(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  return { home, key, display };
}

// ---------- a managed bot's gateway ----------

async function healthy(url: string, timeoutMs = 2500): Promise<any | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function keyAccepted(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** The gateway's pid, but only if the pid file belongs to this home and the process is alive. */
function gatewayPid(home: string): number | null {
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8').trim(); } catch { return null; }
  let pid = NaN;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'number') pid = j;
    else {
      if (j?.hermes_home && path.resolve(j.hermes_home) !== path.resolve(home)) return null;
      pid = Number(j?.pid);
    }
  } catch { pid = Number(raw); }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gateway')) return null;
  } catch { /* no /proc: trust the pid file */ }
  return pid;
}

async function stopGateway(botId: string) {
  const home = homeFor(botId);
  const pid = gatewayPid(home);
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { process.kill(pid, 0); } catch { return; }
  }
  signal('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
}

const starting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();
const keys = new Map<string, string>();

function managedUrl(botId: string): string {
  return `http://127.0.0.1:${botRow(botId).engine_port}`;
}

function managedKey(botId: string): string {
  let k = keys.get(botId);
  if (!k) {
    k = readDotenv(path.join(homeFor(botId), '.env')).API_SERVER_KEY ?? '';
    if (k) keys.set(botId, k);
  }
  return k;
}

async function startGateway(botId: string): Promise<void> {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') throw new Error('not a managed engine');
  if (!b.engine_port) db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort(), botId);
  const url = managedUrl(botId);

  // A gateway from an earlier run of this server is still good: use it as it is.
  if ((await healthy(url)) && managedKey(botId) && (await keyAccepted(url, managedKey(botId)))) return;
  if (await healthy(url)) {
    if (gatewayPid(homeFor(botId))) await stopGateway(botId);
    else throw new Error(`Port ${botRow(botId).engine_port} is taken by something else.`);
  }

  const { home, key, display } = await writeHome(botId);
  keys.set(botId, key);
  if (gatewayPid(home)) await stopGateway(botId);

  const log = fs.openSync(path.join(home, 'logs', 'gateway.out.log'), 'a');
  const child = spawn(env.hermesBin, ['gateway', 'run', '--no-supervise'], {
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    // Only what the agent needs. None of this server's secrets, and nothing of the primary agent's messaging.
    env: {
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME ?? '/root',
      USER: process.env.USER ?? 'root',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HERMES_HOME: home,
      HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'),
      // Hermes' browser tool talks to a helper process it finds under this folder. With the default
      // (one folder per HOME) every agent on the computer would end up driving the same browser.
      BH_HOME: path.join(home, 'browser-harness'),
      ...(display ? { DISPLAY: display } : {}),
    },
  });
  fs.closeSync(log);
  let exited: string | null = null;
  child.once('error', (e) => { exited = `could not run ${env.hermesBin}: ${e.message}`; });
  child.once('exit', (code) => { exited = `the agent stopped while starting (exit ${code}). See ${path.join(home, 'logs', 'gateway.out.log')}`; });
  child.unref();

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) throw new Error(exited);
    if (await healthy(url, 1500)) {
      console.log(`[engine] ${b.name}: gateway up on ${url}`);
      return;
    }
  }
  throw new Error('The agent did not come up within 90 seconds.');
}

/** Start (or adopt) the bot's gateway. Safe to call often; concurrent calls share one start. */
function ensureManaged(botId: string): Promise<void> {
  let p = starting.get(botId);
  if (!p) {
    p = startGateway(botId)
      .then(() => { failures.delete(botId); })
      .catch((e: any) => {
        const msg = String(e?.message ?? e);
        failures.set(botId, msg);
        console.warn(`[engine] ${botId}: ${msg}`);
        throw e;
      })
      .finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

/** Where to send this bot's turns. Starts its gateway if it is not running. */
export async function engineFor(botId: string): Promise<Engine> {
  let kind = engineKind(botId);
  if (!kind) {
    const b = botRow(botId);
    if (!b) throw new Error('bot not found');
    if (b.kind === 'room') throw new Error('A group chat has no agent of its own.');
    kind = assignEngine(botId);
  }
  if (kind === 'primary') return { kind, url: env.hermesUrl, key: primaryKey(), home: env.hermesHome };
  const url = managedUrl(botId);
  if (!(await healthy(url, 1500)) || !managedKey(botId)) await ensureManaged(botId);
  return { kind, url, key: managedKey(botId), home: homeFor(botId) };
}

/** The bot's Hermes home, without starting anything (memory files, sign-in commands). */
export function engineHome(botId: string): string | null {
  const kind = engineKind(botId);
  return kind === 'primary' ? env.hermesHome : kind === 'managed' ? homeFor(botId) : null;
}

/**
 * Hermes can run a private screen of its own for a profile (its "Bot Desktop": an Xvnc display with
 * state in <home>/bot-desktop). While that screen is up, the agent's computer-use tool acts there and
 * not on the screen this app shows (so does its browser tool, unless the config pins it to a Chrome
 * with `browser.cdp_url`), so the user could be watching an idle desktop.
 */
export function ownScreenOn(botId: string): boolean {
  const home = engineHome(botId);
  if (!home) return false;
  const dir = path.join(home, 'bot-desktop');
  try {
    // launcher.pid holds "<pid> <create time>"; the env file appears once the screen is usable.
    const pid = Number(fs.readFileSync(path.join(dir, 'launcher.pid'), 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(path.join(dir, 'env'))) return false;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Ask Hermes to stop that private screen. Hermes refuses while a person is using it; the refusal is passed on. */
export function stopOwnScreen(botId: string): Promise<void> {
  const home = engineHome(botId);
  if (!home) return Promise.reject(new Error('This bot has no agent.'));
  return new Promise((resolve, reject) => {
    execFile(env.hermesBin, ['computer-use', 'screen', 'stop'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!ownScreenOn(botId)) return resolve();
      const said = `${stderr || ''}\n${stdout || ''}`.trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || (err ? String(err.message) : 'The screen is still running.')));
    });
  });
}

/** Start the gateway in the background (after creating a bot, or on server start). */
export function provisionEngine(botId: string) {
  if (engineKind(botId) === 'managed') ensureManaged(botId).catch(() => {});
}

export async function restartEngine(botId: string): Promise<void> {
  if (engineKind(botId) !== 'managed') return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  optionsCache.delete(botId);
  provisionEngine(botId);
}

/** The bot is gone: stop its gateway and delete its home. The primary agent is left alone. */
export async function removeEngine(botId: string): Promise<void> {
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  keys.delete(botId);
  failures.delete(botId);
  optionsCache.delete(botId);
  if (path.resolve(home).startsWith(path.resolve(env.enginesDir) + path.sep)) fs.rmSync(home, { recursive: true, force: true });
}

/** On server start: give older bots an engine, then bring the managed gateways up. */
export function initEngines() {
  fs.mkdirSync(env.enginesDir, { recursive: true });
  const bots = db.prepare("SELECT id, is_primary FROM bots WHERE engine IS NULL AND COALESCE(kind,'agent') <> 'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all() as any[];
  for (const b of bots) assignEngine(b.id);
  for (const b of db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as any[]) provisionEngine(b.id);
}

// ---------- what the settings panel shows ----------

/** Order of the providers that are not connected yet: the ones people ask for first, the rest by name. */
const WELL_KNOWN = [
  'anthropic', 'openai-codex', 'openai-api', 'gemini', 'xai-oauth', 'xai', 'kilocode', 'openrouter', 'nous',
  'deepseek', 'zai', 'alibaba', 'kimi-coding', 'xiaomi', 'tencent-tokenhub', 'minimax', 'mistral',
];

/** Names that say what the provider is known for, where Hermes' own name does not. */
const DISPLAY_NAME: Record<string, string> = {
  anthropic: 'Claude (Anthropic)', zai: 'GLM (Z.AI)', alibaba: 'Qwen (Alibaba Cloud)', 'kimi-coding': 'Kimi (Moonshot)', 'kimi-coding-cn': 'Kimi (Moonshot, China)',
  xiaomi: 'MiMo (Xiaomi)', 'tencent-tokenhub': 'Hunyuan (Tencent TokenHub)', 'tencent-tokenplan': 'Hunyuan (Tencent TokenPlan)',
};

/** Hermes names the key setting only while a provider is not connected; these let a key be replaced afterwards. */
const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', 'openai-api': 'OPENAI_API_KEY', gemini: 'GOOGLE_API_KEY', xai: 'XAI_API_KEY', kilocode: 'KILOCODE_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', zai: 'GLM_API_KEY', alibaba: 'DASHSCOPE_API_KEY', 'kimi-coding': 'KIMI_API_KEY', 'kimi-coding-cn': 'KIMI_CN_API_KEY', xiaomi: 'XIAOMI_API_KEY',
  'tencent-tokenhub': 'TOKENHUB_API_KEY', 'tencent-tokenplan': 'TOKENPLAN_API_KEY', minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_CN_API_KEY',
};

/**
 * Providers Hermes has no entry for. Each is an OpenAI-compatible endpoint, added to the agent's
 * config as a named provider when its key is saved.
 */
const EXTRA_PROVIDERS: { id: string; name: string; api: string; keyEnv: string; models: string[] }[] = [
  { id: 'mistral', name: 'Mistral', api: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'devstral-medium-latest', 'magistral-medium-latest'] },
];

/** Providers that are set up with their own tooling, not a key or a sign-in this app can start. */
const HIDDEN = new Set(['custom']);

const optionsCache = new Map<string, { at: number; data: any }>();

async function modelOptions(botId: string, e: { url: string; key: string }): Promise<any | null> {
  const hit = optionsCache.get(botId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  try {
    const r = await fetch(`${e.url}/api/model/options`, { headers: e.key ? { Authorization: `Bearer ${e.key}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    optionsCache.set(botId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string' && !!m) : []);

/** Every provider the agent knows, connected ones first, each with all of its models (recommended first). */
function toProviders(data: any, home: string | null): EngineProvider[] {
  const list: any[] = Array.isArray(data?.providers) ? data.providers : [];
  const keys = home ? readDotenv(path.join(home, '.env')) : {};
  const out = list
    .filter((p) => p?.slug && !HIDDEN.has(p.slug))
    .map((p): EngineProvider => {
      const id = String(p.slug);
      const extra = EXTRA_PROVIDERS.find((x) => x.id === id);
      const all = [...new Set([...strings(p.featured_models), ...strings(p.models)])];
      return {
        id,
        name: DISPLAY_NAME[id] ?? String(p.name ?? id),
        // Hermes lists Anthropic as an API-key provider, yet it can also sign in to a Claude subscription. Offer that until a key is in place.
        kind: String(p.auth_type ?? '').includes('oauth') || (id === 'anthropic' && !p.authenticated) ? 'subscription' : 'api_key',
        // A provider added from EXTRA_PROVIDERS is listed by Hermes as soon as it is in the config; it is connected once its key is there.
        connected: extra ? !!keys[extra.keyEnv] : !!p.authenticated,
        models: all.length ? all : extra?.models ?? [],
        keyEnv: extra?.keyEnv ?? (typeof p.key_env === 'string' && p.key_env ? p.key_env : KEY_ENV[id] ?? null),
      };
    });
  for (const x of EXTRA_PROVIDERS) {
    if (!out.some((p) => p.id === x.id)) out.push({ id: x.id, name: x.name, kind: 'api_key', connected: !!keys[x.keyEnv], models: x.models, keyEnv: x.keyEnv });
  }
  const known = (p: EngineProvider) => (WELL_KNOWN.indexOf(p.id) < 0 ? WELL_KNOWN.length : WELL_KNOWN.indexOf(p.id));
  return out.sort((a, b) => Number(b.connected) - Number(a.connected) || known(a) - known(b) || a.name.localeCompare(b.name));
}

/** Replace, add or (with null) remove one setting in a .env file, leaving every other line as it is. */
function setDotenvVar(file: string, name: string, value: string | null) {
  let lines: string[] = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { /* no file yet */ }
  const mine = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  lines = lines.filter((l) => !mine.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (value) lines.push(`${name}=${value}`);
  writePrivate(file, lines.join('\n') + '\n');
}

/**
 * Connect a provider with an API key (or, with an empty key, disconnect it). The key goes into the
 * agent's own .env, which Hermes reads again on every turn, so no restart is needed. It is saved for
 * every bot of the same person, so connecting a provider once is enough. The key is never sent back.
 */
export async function setProviderKey(botId: string, providerId: string, key: string): Promise<void> {
  const b = botRow(botId);
  const home = engineHome(botId);
  if (!b || !home) throw new Error('This bot has no agent.');
  const value = key.trim();
  if (value && !/^[\x21-\x7e]{8,400}$/.test(value)) throw new Error('That does not look like an API key.');

  const extra = EXTRA_PROVIDERS.find((x) => x.id === providerId);
  let keyEnv = extra?.keyEnv ?? null;
  if (!keyEnv) {
    const e = engineKind(botId) === 'primary' ? { url: env.hermesUrl, key: primaryKey() } : { url: managedUrl(botId), key: managedKey(botId) };
    optionsCache.delete(botId);
    const listed = toProviders(await modelOptions(botId, e), home).find((p) => p.id === providerId);
    keyEnv = listed?.keyEnv ?? KEY_ENV[providerId] ?? null;
  }
  // Only a provider's own key setting: never the agent's server settings, which live in the same file.
  if (!keyEnv || !/^[A-Z][A-Z0-9_]{2,60}$/.test(keyEnv) || /^(API_SERVER|BROWSER|HERMES|TERMINAL)_/.test(keyEnv)) throw new Error('This provider is not connected with an API key.');

  const homes = new Set<string>([home]);
  for (const other of db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(kind,'agent') <> 'room'").all(b.user_id) as any[]) {
    const h = engineHome(other.id);
    if (h && fs.existsSync(h)) homes.add(h);
    optionsCache.delete(other.id);
  }
  for (const h of homes) {
    setDotenvVar(path.join(h, '.env'), keyEnv, value || null);
    if (extra) {
      // The provider's entry in the agent's config comes and goes with its key.
      const file = path.join(h, 'config.yaml');
      const cfg = readYaml(file);
      const had = cfg.providers?.[extra.id];
      if (value) cfg.providers = { ...(cfg.providers ?? {}), [extra.id]: { ...(had ?? {}), name: extra.name, api: extra.api, key_env: extra.keyEnv, transport: 'chat_completions' } };
      else if (had) { delete cfg.providers[extra.id]; if (!Object.keys(cfg.providers).length) delete cfg.providers; }
      if (value || had) writePrivate(file, YAML.stringify(cfg));
    }
  }
}

export async function engineInfo(botId: string): Promise<EngineInfo> {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  const kind = engineKind(botId);
  const base: EngineInfo = { botId, profile: kind === 'primary' ? 'default' : botId, status: 'stopped', error: null, model: b.model ?? null, provider: b.provider ?? null, version: null, providers: [], ownScreen: kind ? ownScreenOn(botId) : false };
  if (!kind) return { ...base, status: 'error', error: 'This bot has no agent.' };

  let e: { url: string; key: string };
  if (kind === 'primary') e = { url: env.hermesUrl, key: primaryKey() };
  else {
    if (!b.engine_port) return { ...base, status: 'error', error: 'No port assigned.' };
    e = { url: managedUrl(botId), key: managedKey(botId) };
  }

  const health = await healthy(e.url);
  if (!health) {
    if (kind === 'primary') return { ...base, status: 'error', error: `The agent at ${env.hermesUrl} is not answering.` };
    if (starting.has(botId)) return { ...base, status: 'starting' };
    const failed = failures.get(botId);
    if (failed) return { ...base, status: 'error', error: failed };
    provisionEngine(botId);
    return { ...base, status: 'starting' };
  }
  if (kind === 'managed' && starting.has(botId)) return { ...base, status: 'starting' };

  const data = await modelOptions(botId, e);
  return {
    ...base,
    status: 'ready',
    version: typeof health.version === 'string' && health.version !== 'unknown' ? health.version : null,
    model: b.model ?? data?.model ?? null,
    provider: b.provider ?? data?.provider ?? null,
    providers: toProviders(data, engineHome(botId)),
  };
}

/** After a sign-in the provider list changes; drop what we remembered. */
export function forgetEngineOptions(botId: string) { optionsCache.delete(botId); }
