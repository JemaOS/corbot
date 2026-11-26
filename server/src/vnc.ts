import type { IncomingMessage, Server } from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from './db.js';
import { userFromCookieHeader } from './lib/auth.js';
import { readyScreen, screenFor } from './computer.js';
import { screens } from './screens.js';
import { viewerClosed, viewerOpened } from './idle.js';

/**
 * VNC relay: browser <-> our server <-> the screen's VNC server.
 * Upstream is the display's own VNC port: a plain TCP connection on 127.0.0.1, so the picture
 * takes one hop. That port has no password because it only listens on this machine; this relay is
 * what people reach, and it checks who they are. The server performs the RFB handshake upstream,
 * then offers the browser its own RFB session. In "watch" mode, client input messages (KeyEvent,
 * PointerEvent, ClientCutText) are dropped server-side.
 */

/** The far end of the relay. */
interface Upstream {
  send(b: Buffer): void;
  close(): void;
  /** Hold the screen back while the browser is still digesting what it has. */
  pause(): void;
  resume(): void;
  readonly open: boolean;
}

interface UpstreamEvents { data(b: Buffer): void; closed(why: string): void; failed(e: Error): void }

/** A display's VNC server, over TCP. Resolves once connected. */
function connectTcp(host: string, port: number, on: UpstreamEvents): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);     // input events are tiny; waiting to batch them is what makes a remote pointer feel heavy
    let up = false;
    sock.on('data', (d) => on.data(d));
    sock.on('close', () => on.closed('closed'));
    sock.on('error', (e) => { if (up) on.failed(e); else reject(e); });
    sock.once('connect', () => {
      up = true;
      resolve({
        send: (b) => { if (!sock.destroyed) sock.write(b); },
        close: () => sock.destroy(),
        pause: () => { if (!sock.destroyed) sock.pause(); },
        resume: () => { if (!sock.destroyed) sock.resume(); },
        get open() { return !sock.destroyed; },
      });
    });
  });
}

class ByteQueue {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  push(b: Buffer) { this.buf = Buffer.concat([this.buf, b]); this.drain(); }
  close(e: Error) { this.closed = e; for (const w of this.waiters) w.reject(e); this.waiters = []; }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }
  takeAll(): Buffer { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
  private drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** SetPixelFormat: the 32-bit true-colour format noVNC decodes (little-endian, shifts 0/8/16). */
const DEFAULT_PIXEL_FORMAT = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);

/** SetEncodings: compressed encodings first, raw last, medium JPEG quality, desktop-size updates. */
const DEFAULT_ENCODINGS = (() => {
  // No desktop-size pseudo-encodings here: advertising them makes the screen answer the first
  // request with a layout rectangle and no picture, which a client that asks only once never recovers
  // from. The browser's own SetEncodings, when it sends one, still takes over.
  const encs = [1, 7, -260, 16, 5, 2, 6, 0, -32 + 6, -256 + 6];
  const b = Buffer.alloc(4 + 4 * encs.length);
  b.writeUInt8(2, 0); b.writeUInt16BE(encs.length, 2);
  encs.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
  return b;
})();

async function upstreamHandshake(q: ByteQueue, send: (b: Buffer) => void): Promise<Buffer> {
  await q.read(12); // server ProtocolVersion
  send(Buffer.from('RFB 003.008\n'));
  const n = (await q.read(1))[0];
  if (n === 0) {
    const len = (await q.read(4)).readUInt32BE();
    throw new Error(`VNC refused: ${(await q.read(len)).toString()}`);
  }
  const types = [...(await q.read(n))];
  // The display's VNC server is set up without a password (security type 1, "None").
  if (!types.includes(1)) throw new Error(`Unsupported VNC security types: ${types.join(',')}`);
  send(Buffer.from([1]));
  const result = (await q.read(4)).readUInt32BE();
  if (result !== 0) {
    let reason = '';
    try { const len = (await q.read(4)).readUInt32BE(); reason = (await q.read(len)).toString(); } catch { /* none */ }
    throw new Error(`VNC auth failed ${reason}`);
  }
  send(Buffer.from([1])); // ClientInit: shared
  const head = await q.read(24); // w,h,pixfmt(16),nameLen
  const nameLen = head.readUInt32BE(20);
  const name = await q.read(nameLen);
  return Buffer.concat([head, name]);
}

async function browserHandshake(q: ByteQueue, send: (b: Buffer) => void, serverInit: Buffer) {
  send(Buffer.from('RFB 003.008\n'));
  await q.read(12);
  send(Buffer.from([1, 1])); // one security type: None
  await q.read(1);
  send(u32(0)); // SecurityResult OK
  await q.read(1); // ClientInit
  send(serverInit);
}

/**
 * Rewrites a client's SetEncodings, dropping H.264. Android Chrome offers it (WebCodecs is there) and
 * then closes the socket within a second of the first frames, while the same session runs for minutes
 * on a desktop that does not offer it. Tight and JPEG are decoded in JavaScript and behave the same
 * everywhere, so the screen is asked for those instead.
 */
function withoutH264(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 2) return b;
  const n = b.readUInt16BE(2);
  if (b.length < 4 + 4 * n) return b;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = b.readInt32BE(4 + 4 * i);
    if (e !== 50) keep.push(e);
  }
  if (keep.length === n) return b;
  const out = Buffer.alloc(4 + 4 * keep.length);
  out.writeUInt8(2, 0);
  out.writeUInt16BE(keep.length, 2);
  keep.forEach((e, i) => out.writeInt32BE(e, 4 + 4 * i));
  return out;
}

/** Filters a client->server RFB stream, dropping input events. Returns bytes to forward. */
class WatchFilter {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) { this.pending = Buffer.alloc(0); break; } // unknown: fail closed
      if (len === 0 || b.length < len) break; // need more bytes
      const msg = b.subarray(0, len);
      const t = b[0];
      if (t === 2) out.push(withoutH264(Buffer.from(msg)));
      else if (t !== 4 && t !== 5 && t !== 6) out.push(Buffer.from(msg));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}

/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
function msgLength(b: Buffer): number {
  const t = b[0];
  switch (t) {
    case 0: return 20; // SetPixelFormat
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4)); // ClientCutText (+extended)
    case 150: return 10; // EnableContinuousUpdates
    case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
    default: return -1;
  }
}

export function attachVncRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    const user = userFromCookieHeader(req.headers.cookie);
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => relay(client, user.id, bot.id, mode));
  });
}

async function relay(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let upstream: Upstream | null = null;
  let piping = false;
  const filter = new WatchFilter();
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    upstream?.close();
  };
  // The same reasoning as for the upstream socket: small frames should leave at once.
  const clientSocket = (client as unknown as { _socket?: net.Socket })._socket;
  clientSocket?.setNoDelay(true);
  // A phone on a slow tailnet link answers slowly; without a deadline the session dies during the
  // handshake and the browser only sees a closed socket. Give it room, and keep TCP talking.
  try { clientSocket?.setKeepAlive(true, 15_000); clientSocket?.setTimeout(120_000); } catch { /* not a TCP socket */ }
  // How the session actually goes: bytes both ways and the last thing each side sent. A phone that
  // dies mid-frame and a phone that never asked for a frame look the same without this.
  let upBytes = 0;
  let downBytes = 0;
  let lastClientMsg = -1;
  let frames = 0;
  clientSocket?.on('data', (d: Buffer) => { upBytes += d.length; });
  const origSend = client.send.bind(client);
  (client as unknown as { send: typeof client.send }).send = ((data: unknown, opts?: unknown, cb?: unknown) => {
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) downBytes += Buffer.byteLength(data as Buffer);
    return (origSend as (...a: unknown[]) => void)(data, opts, cb);
  }) as typeof client.send;
  let prevBytes = -1;
  const watchdog = setInterval(() => {
    const bytes = clientSocket?.bytesWritten ?? 0;
    if (!piping) return;
    if (bytes === prevBytes && client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch { /* closing */ }
    }
    prevBytes = bytes;
  }, 20_000);
  client.on('pong', () => { /* alive */ });
  client.on('close', () => {
    clearInterval(watchdog);
    clearInterval(drainer);
    console.log(`[vnc] flow up=${upBytes} down=${downBytes} lastClientMsg=${lastClientMsg} frames=${frames} peakBuffered=${peakBuffered} held=${held} upMsg=${upMsg} rects=${rects} enc=${rectEnc.slice(0, 80)}`);
  });

  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    const b = Buffer.from(data);
    if (b.length) lastClientMsg = b[0];
    if (b.length && b[0] === 3) frames++;
    const raw = Buffer.from(data);
    const fwd = mode === 'watch' ? filter.feed(raw) : (raw.length && raw[0] === 2 ? withoutH264(raw) : raw);
    if (fwd.length && upstream?.open) upstream.send(fwd);
  });
  // Why and when the relay ends, once per session. A phone that gives up while the picture is being
  // decoded shows up here as a close with its code, instead of a bare "client closed".
  const openedAt = Date.now();
  client.on('close', (code: number, reason: Buffer) => {
    const ms = Date.now() - openedAt;
    console.log(`[vnc] session closed after ${ms} ms (piping=${piping}) code=${code} reason=${reason?.toString() || '-'}`);
    viewerClosed(userId);
    fromClient.close(new Error('client closed'));
    upstream?.close();
  });
  client.on('error', (e: Error) => console.warn('[vnc] client error', e.message));
  viewerOpened(userId); // keeps the computer awake while someone is watching (see idle.ts)

  // Backpressure. The screen produces a full frame far faster than a phone on a tailnet link can take
  // it; forwarding blindly piled a megabyte into the socket and the session died within a second. The
  // screen is now held whenever the browser is behind, and let go once it has caught up.
  const FRAME_BYTES = 16 * 1024;
  const HIGH_WATER = 128 * 1024;
  const LOW_WATER = 32 * 1024;
  let held = false;
  let peakBuffered = 0;
  const release = () => {
    if (!held || !upstream?.open) return;
    if ((clientSocket?.writableLength ?? 0) + client.bufferedAmount <= LOW_WATER) { held = false; upstream.resume(); }
  };
  const drainer = setInterval(release, 25);
  clientSocket?.on('drain', release);

  // What the screen actually sent: message type and rectangle encodings. A browser that closes right
  // after a particular encoding is only visible here.
  let upMsg = -1;
  let rectEnc = '';
  let rects = 0;
  let tail = Buffer.alloc(0);
  let want = 0;
  let inFbu = 0;
  const seeUpstream = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    for (;;) {
      if (inFbu > 0) {
        if (tail.length < 12) return;
        const e = tail.readInt32BE(8);
        rectEnc += (rectEnc ? ',' : '') + e;
        rects++;
        tail = tail.subarray(12);
        inFbu--;
        if (e === -224) inFbu = 0; // LastRect: the rest is not rectangles
        continue;
      }
      if (want === 0) {
        if (tail.length < 1) return;
        upMsg = tail[0];
        if (upMsg === 0) {
          if (tail.length < 4) return;
          const n = tail.readUInt16BE(2);
          tail = tail.subarray(4);
          inFbu = n;
          if (n === 0) { want = 0; continue; }
          continue;
        }
        // Other server messages are rare on this link; stop parsing rather than guess a length.
        want = -1;
        return;
      }
      return;
    }
  };

  const events: UpstreamEvents = {
    data: (d) => {
      seeUpstream(d);
      if (!piping) return fromUp.push(d);
      if (client.readyState !== WebSocket.OPEN) return;
      // One RFB update can be hundreds of kilobytes. Chrome on Android closes the socket when a single
      // binary frame is that big, so the picture is sent in small frames; RFB is a byte stream, the
      // browser reassembles it either way.
      for (let i = 0; i < d.length; i += FRAME_BYTES) client.send(d.subarray(i, i + FRAME_BYTES), { binary: true });
      // `bufferedAmount` stays near zero: ws hands the bytes to the socket at once. What actually
      // piles up on a slow link is the socket's own write queue, so that is what is watched.
      const queued = (clientSocket?.writableLength ?? 0) + client.bufferedAmount;
      peakBuffered = Math.max(peakBuffered, queued);
      if (!held && queued > HIGH_WATER && upstream?.open) { held = true; upstream.pause(); }
    },
    closed: (why) => { fromUp.close(new Error(`upstream closed ${why}`)); closeAll(1000, `upstream ${why}`); },
    failed: (e) => { fromUp.close(e); closeAll(1011, String(e)); },
  };

  try {
    const { screenId } = await screenFor(userId, botId);
    // A screen nobody has used yet is bare; set it up while the person is already watching.
    readyScreen(userId, botId).catch(() => {});
    const at = screens.vncAddress(screenId);
    upstream = await connectTcp(at.host, at.port, events);
    const up = upstream;

    const serverInit = await upstreamHandshake(fromUp, (b) => up.send(b));
    console.log(`[vnc] upstream ready ${botId} ${screenId} ${serverInit.readUInt16BE(0)}x${serverInit.readUInt16BE(2)}`);
    await browserHandshake(fromClient, (b) => client.send(b), serverInit);
    console.log(`[vnc] browser handshake done ${botId}`);
    // Flush anything that arrived during the handshake, then switch to piping.
    piping = true;
    console.log(`[vnc] piping ${botId}`);
    // Ask the screen for compressed pictures ourselves. Some browsers (seen on Android Chrome) never
    // send their own pixel format and encodings, and the screen then answers with raw pixels: 5 MB per
    // full frame, which a phone cannot take. The browser's own messages, when they come, override this.
    up.send(DEFAULT_PIXEL_FORMAT);
    up.send(DEFAULT_ENCODINGS);
    // And ask for the whole picture now, so a client that only asks once still receives one.
    const ask = Buffer.alloc(10);
    ask.writeUInt8(3, 0);
    ask.writeUInt16BE(serverInit.readUInt16BE(0), 4);
    ask.writeUInt16BE(serverInit.readUInt16BE(2), 6);
    up.send(ask);
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) for (let i = 0; i < leftoverUp.length; i += 16 * 1024) client.send(leftoverUp.subarray(i, i + 16 * 1024));
    const leftoverClient = fromClient.takeAll();
    if (leftoverClient.length) {
      const fwd = mode === 'watch' ? filter.feed(leftoverClient) : (leftoverClient.length && leftoverClient[0] === 2 ? withoutH264(leftoverClient) : leftoverClient);
      if (fwd.length) up.send(fwd);
    }
  } catch (e: any) {
    console.warn('[vnc] relay failed', e?.message ?? e);
    closeAll(1011, String(e?.message ?? e));
  }
}
