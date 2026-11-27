import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals } from './agent/loop.js';
import { configApi } from './routes-config.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi } from './mcp.js';
import { initEngines } from './engine.js';
import { warmScreens } from './computer.js';

initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes' }));
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({
    root: path.relative(process.cwd(), webDist),
    // The HTML must never be cached: after an update a phone that keeps the old page asks for chunks
    // that no longer exist and shows nothing. Hashed assets can be kept for a year.
    // The service worker and the PWA manifest must also stay fresh so updates reach installed apps.
    onFound: (_path, c) => {
      const noStore = _path.endsWith('.html') || _path === webDist || _path.endsWith('/sw.js') || _path.endsWith('.webmanifest');
      c.header('Cache-Control', noStore ? 'no-store' : 'public, max-age=31536000, immutable');
    },
  }));
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8'));
  });
}

const server = serve({ fetch: app.fetch, port: env.port, ...(env.host ? { hostname: env.host } : {}) }, (info) => console.log(`[corbot] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
// CORBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.CORBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[corbot] scheduler disabled (CORBOT_NO_SCHEDULER=1)');
startIdleWatcher();
initEngines();
warmScreens();
