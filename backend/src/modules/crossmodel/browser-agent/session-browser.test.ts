/**
 * Hosted hardened browser — backend-side tests (ticket ea3ad8a8).
 *
 * Covers: the HTTP client (token derivation, error paths), the hosted driver
 * (mapping to the BrowserDriver contract), the router's hosted wiring
 * (availability gating, GLM pick guard, sessionKey requirement), and the
 * schema kill-switch. All HTTP is mocked — no Chromium, no network.
 */

import { BrowserAction } from './types';

// The logger chain validates env at import (config/env parseEnv exits when
// DATABASE_URL is missing) — mock it like every sibling suite here does.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Controllable mocks for the router's static imports ──────────────────────
const mockGlmChat = jest.fn();
const mockSessionBrowserAvailable = jest.fn();

// Mocked HTTP for the REAL client code: axios.create() returns an instance
// whose .get/.post hit the fake impl.
jest.mock('axios', () => {
  const impl = (cfg: { baseURL?: string; url?: string }) => {
    if (process.env.__BSVC_DOWN === '1') {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3100'));
    }
    // Ticket 169d5080: the service now answers a NON-2xx status for a failed
    // action, and axios throws on those. Simulate that exact shape — the class
    // and any partial content live ONLY in the thrown response body.
    if (process.env.__BSVC_FAIL_STATUS) {
      return Promise.reject(
        Object.assign(new Error(`Request failed with status code ${process.env.__BSVC_FAIL_STATUS}`), {
          response: {
            status: Number(process.env.__BSVC_FAIL_STATUS),
            data: JSON.parse(process.env.__BSVC_FAIL_BODY || '{}'),
          },
        }),
      );
    }
    const url: string = cfg.url || cfg.baseURL || '';
    if (url.includes('/health')) {
      return Promise.resolve({ status: 200, data: { ok: true, service: 'digby-browser-service', contexts: 0 } });
    }
    if (url.includes('/v1/action')) {
      return Promise.resolve({ status: 200, data: { ok: true, action: 'navigate', url: 'https://example.com/' } });
    }
    if (url.includes('/v1/close')) {
      return Promise.resolve({ status: 200, data: { ok: true } });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  const mkInstance = (defaults: Record<string, unknown>) => ({
    get: (url: string) => impl({ ...defaults, url }),
    post: (url: string) => impl({ ...defaults, url }),
  });
  return { __esModule: true, default: { create: mkInstance } };
});

jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: (...a: unknown[]) => mockGlmChat(...a),
  glmConfigured: () => true,
  stripThink: (s: string) => s,
}));
jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  isOnline: () => false,
  selectAgent: async () => ({ agent: null, note: 'no paired Mac' }),
  listAgents: async () => [],
  agentDisplayName: (a: { label?: string }) => a?.label || 'Mac',
}));
jest.mock('../imessage/agent-capabilities', () => ({
  __esModule: true,
  advertisesCapabilities: () => false,
  hasCapability: () => false,
}));
jest.mock('../computer-agent/availability', () => ({
  __esModule: true,
  computerAgentStatus: () => 'not connected',
  computerUseAvailable: () => false,
}));
jest.mock('../computer-agent/vision-client', () => ({
  __esModule: true,
  visionConfigured: async () => false,
}));
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: async () => null,
  decisionMode: () => 'off',
  decisionThreshold: () => 0.7,
  recordDecisionOutcome: () => undefined,
}));
// The sibling drivers pull the env-validating chain (cloud-driver → mcp-search
// → config/env exits on missing DATABASE_URL) — mock them; they're not under
// test here (browser-agent.test.ts covers cloud-driver itself).
jest.mock('./cloud-driver', () => ({
  __esModule: true,
  CloudBrowserDriver: class { kind = 'cloud' as const; async isAvailable() { return true; } },
}));
jest.mock('./local-driver', () => ({
  __esModule: true,
  LocalBrowserDriver: class { kind = 'local' as const; async isAvailable() { return false; } },
}));
// The router probes the hosted service through the client — mock at the module
// boundary so the router tests need no HTTP. Token derivation + the reset
// hook delegate to the REAL module (the client tests exercise the real code).
jest.mock('./session-browser-client', () => {
  const actual = jest.requireActual('./session-browser-client');
  return {
    __esModule: true,
    ...actual,
    sessionBrowserAvailable: (k: string) => mockSessionBrowserAvailable(k),
  };
});

import {
  BROWSER_SERVICE_ENABLED,
  BROWSER_SERVICE_URL,
  sessionBrowserAction,
  sessionBrowserToken,
  __resetTokenCacheForTests,
} from './session-browser-client';

const ORIG = { ...process.env };

beforeEach(() => {
  __resetTokenCacheForTests();
  process.env = { ...ORIG };
  process.env.BROWSER_SERVICE_SECRET = 'unit-secret';
  process.env.BROWSER_SERVICE_URL = 'http://browser-service:3100';
  delete process.env.BROWSER_SERVICE_ENABLED;
  delete process.env.__BSVC_DOWN;
  mockGlmChat.mockReset();
  mockSessionBrowserAvailable.mockReset();
  mockGlmChat.mockResolvedValue({ content: '{"driver":"cloud","reason":"r"}' });
  mockSessionBrowserAvailable.mockResolvedValue(false);
});
afterAll(() => { process.env = { ...ORIG }; });

describe('session-browser-client (ticket ea3ad8a8)', () => {
  test('BROWSER_SERVICE_ENABLED parses the standard truthy forms', () => {
    process.env.BROWSER_SERVICE_ENABLED = '1'; expect(BROWSER_SERVICE_ENABLED()).toBe(true);
    process.env.BROWSER_SERVICE_ENABLED = 'true'; expect(BROWSER_SERVICE_ENABLED()).toBe(true);
    process.env.BROWSER_SERVICE_ENABLED = 'YES'; expect(BROWSER_SERVICE_ENABLED()).toBe(true);
    process.env.BROWSER_SERVICE_ENABLED = '0'; expect(BROWSER_SERVICE_ENABLED()).toBe(false);
    process.env.BROWSER_SERVICE_ENABLED = ''; expect(BROWSER_SERVICE_ENABLED()).toBe(false);
  });

  test('BROWSER_SERVICE_URL defaults to the compose service name', () => {
    delete process.env.BROWSER_SERVICE_URL;
    expect(BROWSER_SERVICE_URL()).toBe('http://browser-service:3100');
  });

  test('token derivation matches the service formula (sha256-hmac over ctx:<key>)', () => {
    const token = sessionBrowserToken('chat:abc');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionBrowserToken('chat:abc')).toBe(token);
    expect(sessionBrowserToken('chat:xyz')).not.toBe(token);
  });

  test('sessionBrowserAction maps the response', async () => {
    const res = await sessionBrowserAction('chat:abc', { name: 'navigate', url: 'https://example.com/' });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('navigate');
  });

  test('sessionBrowserAction returns a clean error when the secret is unset', async () => {
    delete process.env.BROWSER_SERVICE_SECRET;
    __resetTokenCacheForTests();
    const res = await sessionBrowserAction('chat:abc', { name: 'navigate', url: 'https://x/' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/BROWSER_SERVICE_SECRET unset/);
  });

  test('sessionBrowserAction maps an axios failure into an error observation', async () => {
    // The axios mock rejects everything while __BSVC_DOWN is set.
    process.env.__BSVC_DOWN = '1';
    const res = await sessionBrowserAction('chat:abc', { name: 'navigate', url: 'https://x/' }, 500);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hosted browser service error/);
    delete process.env.__BSVC_DOWN;
  });

  // Ticket 169d5080: the service answers a NON-2xx status for a REAL failure
  // (invalid/incomplete URL, missing selector, render incomplete, screenshot too
  // large, at capacity). axios throws on those, so the body is the only place
  // the machine-readable class and any partial content live. The client must
  // forward them instead of flattening everything into a bare string — the
  // pre-fix dead ternary made every one of these look like a healthy 200.
  test('169d5080: a non-2xx action response keeps its errorCode, status and partial content', async () => {
    process.env.__BSVC_FAIL_STATUS = '502';
    process.env.__BSVC_FAIL_BODY = JSON.stringify({
      ok: false,
      action: 'get_content',
      url: 'https://www.facebook.com/ads/library/',
      errorCode: 'render_incomplete',
      error: 'render incomplete: still an empty HTML shell after 1200ms of re-polling',
      content: '<html><body><div id="root"></div></body></html>',
    });
    try {
      const res = await sessionBrowserAction('chat:abc', { name: 'get_content' });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe('render_incomplete');
      expect(res.status).toBe(502);
      // The partial content survives so the caller can show what WAS read.
      expect(res.content).toContain('root');
      expect(res.url).toBe('https://www.facebook.com/ads/library/');
      expect(res.error).toMatch(/render incomplete/);
    } finally {
      delete process.env.__BSVC_FAIL_STATUS;
      delete process.env.__BSVC_FAIL_BODY;
    }
  });

  test('169d5080: a 400 incomplete_url from the service reaches the caller as that class', async () => {
    process.env.__BSVC_FAIL_STATUS = '400';
    process.env.__BSVC_FAIL_BODY = JSON.stringify({
      ok: false,
      action: 'navigate',
      errorCode: 'incomplete_url',
      error: 'incomplete URL: "https://www.facebook.com/ads/library/?acti" breaks off mid-path',
    });
    try {
      const res = await sessionBrowserAction('chat:abc', {
        name: 'navigate',
        url: 'https://www.facebook.com/ads/library/?acti',
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
      expect(res.errorCode).toBe('incomplete_url');
      expect(res.error).toMatch(/incomplete URL/);
    } finally {
      delete process.env.__BSVC_FAIL_STATUS;
      delete process.env.__BSVC_FAIL_BODY;
    }
  });
});

describe('HostedBrowserDriver (ticket ea3ad8a8)', () => {
  test('executes actions through the client and tags the observation hosted', async () => {
    const { HostedBrowserDriver } = await import('./hosted-driver');
    const d = new HostedBrowserDriver('session:s1');
    expect(d.kind).toBe('hosted');
    await expect(d.isAvailable()).resolves.toBe(false); // mock default: down
    mockSessionBrowserAvailable.mockResolvedValue(true);
    await expect(d.isAvailable()).resolves.toBe(true);
    const obs = await d.execute({ name: 'navigate', url: 'https://example.com/' } as BrowserAction);
    expect(obs.ok).toBe(true);
    expect(obs.driver).toBe('hosted');
    expect(obs.action).toBe('navigate');
  });

  test('close() keeps the context alive by default (persistence IS the feature)', async () => {
    const { HostedBrowserDriver } = await import('./hosted-driver');
    const d = new HostedBrowserDriver('session:s1');
    await expect(d.close()).resolves.toBeUndefined();
  });

  test('interactionCapability is cdp (fully interactive real Chromium)', async () => {
    const { HostedBrowserDriver } = await import('./hosted-driver');
    const d = new HostedBrowserDriver('session:s1');
    expect(d.interactionCapability!()).toBe('cdp');
    expect(d.wasInteractiveRefused!()).toBe(false);
  });
});

describe('router hosted wiring (ticket ea3ad8a8)', () => {  test('selectBrowserDriver never offers hosted when disabled (env off)', async () => {
    const { selectBrowserDriver } = await import('./router');
    const sel = await selectBrowserDriver('user-1', 'read a public page', { sessionKey: 'chat:c1' });
    expect(sel.kind).toBe('cloud');
    expect(mockSessionBrowserAvailable).not.toHaveBeenCalled(); // enabled-off short-circuits the probe
  });

  test('a hosted GLM pick with the service down falls back to cloud (drift guard)', async () => {
    process.env.BROWSER_SERVICE_ENABLED = '1';
    mockSessionBrowserAvailable.mockResolvedValue(false); // probe fails
    mockGlmChat.mockResolvedValue({ content: '{"driver":"hosted","reason":"persistent login"}' });
    const { selectBrowserDriver } = await import('./router');
    const sel = await selectBrowserDriver('user-1', 'sign into a site and keep the login', { sessionKey: 'chat:c1' });
    expect(sel.kind).toBe('cloud');
  });

  test('with the service up + enabled + sessionKey, a hosted GLM pick is honored', async () => {
    process.env.BROWSER_SERVICE_ENABLED = '1';
    mockSessionBrowserAvailable.mockResolvedValue(true);
    mockGlmChat.mockResolvedValue({ content: '{"driver":"hosted","reason":"persistent login"}' });
    const { selectBrowserDriver } = await import('./router');
    const sel = await selectBrowserDriver('user-1', 'sign into a site and keep the login', { sessionKey: 'chat:c1' });
    expect(sel.kind).toBe('hosted');
    if (sel.driver) expect(sel.driver.kind).toBe('hosted');
    expect(sel.reason).toBeTruthy();
  });

  test('the hosted destination requires BOTH enabled and a sessionKey', async () => {
    process.env.BROWSER_SERVICE_ENABLED = '1';
    mockSessionBrowserAvailable.mockResolvedValue(true);
    mockGlmChat.mockResolvedValue({ content: '{"driver":"hosted","reason":"r"}' });
    const { selectBrowserDriver } = await import('./router');
    // No sessionKey → the hosted pick must fall back to cloud (no persistent
    // context can exist without a scope).
    const sel = await selectBrowserDriver('user-1', 'task');
    expect(sel.kind).toBe('cloud');
  });
});
