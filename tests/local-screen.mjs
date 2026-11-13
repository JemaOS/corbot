// Checks a bot's live screen through the app's relay, the way the browser viewer uses it:
// RFB handshake, one full frame, then how fast frames come while the picture changes.
//   node tests/local-screen.mjs http://localhost:8787 <botId> <session cookie value> [watch|control]
import { WebSocket } from 'ws';

const [base = 'http://localhost:8787', botId, session, mode = 'watch'] = process.argv.slice(2);
if (!botId || !session) { console.error('usage: local-screen.mjs <base url> <botId> <session cookie> [watch|control]'); process.exit(2); }

const url = `${base.replace(/^http/, 'ws')}/api/bots/${botId}/screen?mode=${mode}`;
const ws = new WebSocket(url, ['binary'], { headers: { Cookie: `corbot_session=${session}` } });
let buf = Buffer.alloc(0);
const waiters = [];
const feed = () => { while (waiters.length && buf.length >= waiters[0].n) { const w = waiters.shift(); const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(out); } };
const read = (n) => new Promise((resolve) => { waiters.push({ n, resolve }); feed(); });
ws.on('message', (d) => { buf = Buffer.concat([buf, d]); feed(); });
ws.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
ws.on('close', (code, reason) => { if (!done) { console.error(`closed early: ${code} ${reason}`); process.exit(1); } });
let done = false;

const t0 = Date.now();
await new Promise((r) => ws.once('open', r));
const version = (await read(12)).toString().trim();
ws.send(Buffer.from('RFB 003.008\n'));
const types = [...(await read((await read(1))[0]))];
ws.send(Buffer.from([1]));
const auth = (await read(4)).readUInt32BE();
ws.send(Buffer.from([1]));
const init = await read(24);
const width = init.readUInt16BE(0), height = init.readUInt16BE(2), bpp = init[4];
const name = (await read(init.readUInt32BE(20))).toString();
console.log(`handshake ${Date.now() - t0} ms: ${version}, security ${types}, auth ${auth}, ${width}x${height} ${bpp}bpp "${name}"`);

// Raw encoding only, so a frame's size is known without decoding anything.
const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(0, 4);
ws.send(enc);
const request = (incremental) => { const b = Buffer.alloc(10); b[0] = 3; b[1] = incremental ? 1 : 0; b.writeUInt16BE(width, 6); b.writeUInt16BE(height, 8); ws.send(b); };

async function frame() {
  for (;;) {
    const type = (await read(1))[0];
    if (type === 0) {
      const rects = (await read(3)).readUInt16BE(1);
      let pixels = 0, colours = new Set();
      for (let i = 0; i < rects; i++) {
        const h = await read(12);
        const w = h.readUInt16BE(4), ht = h.readUInt16BE(6);
        const data = await read(w * ht * (bpp / 8));
        pixels += w * ht;
        for (let p = 0; p < data.length && colours.size < 64; p += 4 * 997) colours.add(data.readUInt32LE(p) & 0xffffff);
      }
      return { rects, pixels, colours: colours.size };
    }
    if (type === 2) continue;                                                   // bell
    if (type === 3) { await read(3); await read((await read(4)).readUInt32BE()); continue; }   // server cut text
    if (type === 1) { await read(1); const n = (await read(4)).readUInt16BE(2); await read(n * 6); continue; }
    throw new Error(`unexpected server message ${type}`);
  }
}

let t = Date.now();
request(false);
const first = await frame();
console.log(`first full frame ${Date.now() - t} ms: ${first.pixels} pixels (${width * height} expected), ${first.colours} distinct colours sampled`);

// Frames per second while asking as fast as answers come, for two seconds.
let frames = 0, changed = 0;
const end = Date.now() + 2000;
const gaps = [];
let pending = null;        // one reader at a time: a frame still being waited for is reused, never raced
while (Date.now() < end) {
  if (!pending) { t = Date.now(); request(true); pending = frame(); }
  const f = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 400))]);
  if (!f) continue;        // nothing changed on the screen: the server waits, which is right
  pending = null;
  frames++; changed += f.pixels; gaps.push(Date.now() - t);
}
gaps.sort((a, b) => a - b);
console.log(`2 s of updates: ${frames} frames, ${changed} changed pixels, median answer ${gaps[gaps.length >> 1] ?? '-'} ms`);

if (mode === 'control') {
  // Pointer to the middle of the screen: in control mode the relay passes it on.
  const p = Buffer.alloc(6); p[0] = 5; p.writeUInt16BE(width >> 1, 2); p.writeUInt16BE(height >> 1, 4);
  ws.send(p);
  console.log('sent a pointer move');
}
done = true;
ws.close();
const ok = first.pixels === width * height && first.colours > 1;
console.log(ok ? 'OK' : 'FAILED: the frame is empty or a single colour');
process.exit(ok ? 0 : 1);
