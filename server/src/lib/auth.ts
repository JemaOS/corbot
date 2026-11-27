import type { Context, MiddlewareHandler } from 'hono';
import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { env } from '../env.js';
import { db, now } from '../db.js';
import { token } from './ids.js';
import type { User } from '../types.js';

const COOKIE = 'corbot_session';
const TTL_MS = 30 * 24 * 3600 * 1000;

export type AuthVars = { Variables: { user: User } };

export function createSession(c: Context, userId: string) {
  const t = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(t, userId, now(), now() + TTL_MS);
  setCookie(c, COOKIE, t, { httpOnly: true, sameSite: 'Lax', secure: env.appUrl.startsWith('https:'), path: '/', maxAge: TTL_MS / 1000 });
}

export function destroySession(c: Context) {
  const t = getCookie(c, COOKIE);
  if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare('SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now()) as any;
  return r ? { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url } : null;
}

export function userFromCookieHeader(cookieHeader: string | undefined): User | null {
  const m = cookieHeader?.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  return userFromToken(m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : undefined);
}

const GATE = 'corbot_gate';
const GATE_TTL_MS = 7 * 24 * 3600 * 1000;

/** The access password has been given in this browser: the door in front of the app is open. */
export function openGate(c: Context) {
  const t = token();
  db.prepare('INSERT INTO gate_sessions(token,created_at,expires_at) VALUES (?,?,?)').run(t, now(), now() + GATE_TTL_MS);
  setCookie(c, GATE, t, { httpOnly: true, sameSite: 'Lax', secure: env.appUrl.startsWith('https:'), path: '/', maxAge: GATE_TTL_MS / 1000 });
}

export function hasGate(c: Context): boolean {
  if (!env.appPassword) return true;
  const t = getCookie(c, GATE);
  if (!t) return false;
  const r = db.prepare('SELECT 1 FROM gate_sessions WHERE token=? AND expires_at>?').get(t, now());
  return !!r;
}

export function hasGateFromHeader(cookieHeader: string | undefined): boolean {
  if (!env.appPassword) return true;
  const m = cookieHeader?.split(/;\s*/).find((p) => p.startsWith(`${GATE}=`));
  if (!m) return false;
  return !!db.prepare('SELECT 1 FROM gate_sessions WHERE token=? AND expires_at>?').get(decodeURIComponent(m.slice(GATE.length + 1)), now());
}

export function closeGate(c: Context) {
  const t = getCookie(c, GATE);
  if (t) db.prepare('DELETE FROM gate_sessions WHERE token=?').run(t);
  deleteCookie(c, GATE, { path: '/' });
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  const u = userFromToken(getCookie(c, COOKIE));
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', u);
  await next();
};

/** Is this the app password? Compared in constant time, on digests of equal length. */
export function isAppPassword(given: string): boolean {
  if (!env.appPassword || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(env.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Key for signing in from the machine the server runs on (POST /api/auth/owner). It is derived from
 * SESSION_SECRET, so only someone who can read the server's .env can make it:
 *   printf 'owner-login' | openssl dgst -sha256 -hmac "$SESSION_SECRET" -r | cut -d' ' -f1
 */
export function isOwnerKey(given: string): boolean {
  const want = crypto.createHmac('sha256', env.sessionSecret).update('owner-login').digest();
  const got = Buffer.from(given, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
