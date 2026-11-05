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
/** Kill switch (BS-1 D3): =1 restores the pre-fix silent-healthy behaviour. */
const INERT_LOUD = process.env.BS_INERT_LOUD_DISABLED !== '1';

if (!SECRET) {
  // BS-1 D3 (2026-11-02): INERT is no longer silent. Before this, a secretless
  // service answered /health 200 and reported itself healthy, so a deploy wave
  // went green over a feature that could never serve a single action (every
  // token check fails without a secret). Three signals now, all greppable:
  //
  //   1. this warn line, with an explicit BROWSER_SERVICE_INERT marker;
  //   2. /health answers 503 {status:"inert"} instead of 200 — the container's
  //      own healthcheck (docker-compose.base.yml) reports it unhealthy;
  //   3. the listen banner repeats the inert state.
  //
  // The service still STARTS (never crash-loop a deploy wave) — it just cannot
  // claim to be healthy while it is useless. `BS_INERT_LOUD_DISABLED=1` restores
  // the old silent-healthy behaviour for an operator who needs the container to
  // read healthy while the secret is being provisioned.
  if (INERT_LOUD) {
    console.warn(
      'browser-service: BROWSER_SERVICE_INERT — BROWSER_SERVICE_SECRET unset: '
      + '/health reports 503 INERT and every action is 401 byte-identically '
      + 'rejected; set BROWSER_SERVICE_SECRET to activate '
      + '(BS_INERT_LOUD_DISABLED=1 silences this and answers /health 200)',
    );
  } else {
    console.warn('browser-service: BROWSER_SERVICE_SECRET unset — starting INERT (/health 200 by BS_INERT_LOUD_DISABLED, every action 401; set the secret to activate)');
  }
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
