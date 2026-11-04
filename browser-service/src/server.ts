/**
 * digby-browser-service entrypoint (ticket ea3ad8a8).
 *
 * Standalone container: pinned Playwright/Chromium, per-session contexts,
 * HTTP on BROWSER_SERVICE_PORT (default 3100) bound INSIDE the compose
 * network (never published to the host). Auth = per-session HMAC bearer.
 *
 * Secret posture (review B2/H2 follow-up): with NO secret the service still
 * starts and answers /health — but EVERY token check fails (tokenFor returns
 * '' and nothing matches an empty bearer), so it is health-green but
 * completely INERT: no context can ever be created. This is deliberate:
 * a brand-new base service must not crash-loop a deploy wave before the
 * operator has set BROWSER_SERVICE_SECRET (the rollout is staged OFF
 * anyway — BROWSER_SERVICE_ENABLED gates the backend side). The log line
 * makes the inert state loud and greppable.
 */

import * as fs from 'fs';
import { BrowserContextManager, createServer } from './core';
import { chromium } from 'playwright';

const PORT = Number(process.env.BROWSER_SERVICE_PORT || 3100);
const SECRET = process.env.BROWSER_SERVICE_SECRET || '';
const DATA_DIR = process.env.BROWSER_SERVICE_DATA_DIR || '/data/contexts';
const CONTEXTS_MAX = Number(process.env.BROWSER_CONTEXTS_MAX || 16);
const IDLE_MS = Number(process.env.BROWSER_CONTEXT_IDLE_MS || 15 * 60_000);

if (!SECRET) {
  // Inert-healthy mode: no secret → every token check fails → no context can
  // ever be created. See the header comment — never crash-loop a deploy wave.
  console.warn('browser-service: BROWSER_SERVICE_SECRET unset — starting INERT (/health 200, every action 401; set the secret to activate)');
}

const mgr = new BrowserContextManager({
  port: PORT,
  secret: SECRET,
  dataDir: DATA_DIR,
  contextsMax: CONTEXTS_MAX,
  idleMs: IDLE_MS,
  playwright: { chromium },
});

const server = createServer(mgr);
server.listen(PORT, '0.0.0.0', () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`browser-service: listening on 0.0.0.0:${PORT} (contexts max ${CONTEXTS_MAX}, idle ${IDLE_MS}ms, data ${DATA_DIR}${SECRET ? '' : ', INERT — no secret'})`);
});
mgr.startReaper();

// Graceful shutdown: persist + close every context (PR #260 / ea3ad8a8).
const shutdown = async (sig: string) => {
  console.log(`browser-service: ${sig} — persisting + closing contexts`);
  server.close();
  try {
    await mgr.closeAll();
  } catch (e) {
    console.error('browser-service: closeAll failed', e);
  }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
