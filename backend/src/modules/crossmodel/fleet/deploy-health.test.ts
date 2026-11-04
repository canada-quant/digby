/**
 * Deploy health (WI-M 2026-09-25) — the ONE live site probe shared by the REST
 * admin job-health endpoint and get_fleet_telemetry views 'jobHealth' / 'deploy'.
 *
 * Pins: the classification rule (healthy REQUIRES backend 200 — the backend leg
 * is /api/health, which answers 503 when db or redis is down; the old rule
 * counted any non-5xx as backend-up proof and a POST-only-route GET-404 read
 * healthy, live-verified 2026-10-08); the 60 s in-process
 * cache (one probe per burst; `fresh` bypasses it); the DEPLOY_HEALTH_PROBE_DISABLED
 * kill switch (status 'skipped', no GET); the base-URL override; a throwing
 * check never escapes (status 'unknown'). The GET itself is an injected seam —
 * no network from tests.
 */
import {
  classifyDeployHealth,
  deployHealthBaseUrl,
  httpStatusOf,
  probeDeployHealth,
  resetDeployHealthCache,
  DEPLOY_HEALTH_CACHE_MS,
} from './deploy-health';
import http from 'http';

const T0 = new Date('2026-09-25T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  resetDeployHealthCache();
  delete process.env.DEPLOY_HEALTH_PROBE_DISABLED;
  delete process.env.DEPLOY_HEALTH_PROBE_BASE_URL;
});

describe('classifyDeployHealth (healthy requires backend 200 — /api/health semantics)', () => {
  it('healthy = frontend 200 + backend 200; a non-200 backend (404 fall-through, 503 unhealthy, 5xx) is degraded; neither leg = down', () => {
    expect(classifyDeployHealth(200, 200)).toBe('healthy');
    expect(classifyDeployHealth(200, 400)).toBe('degraded');
    // Regression pin (live 2026-10-08): GET /api/auth/login answered 404 — the
    // old rule read this exact pair as 'healthy' with the backend down-ish.
    expect(classifyDeployHealth(200, 404)).toBe('degraded');
    // Up-but-unhealthy backend: /api/health answers 503 when db or redis is down.
    expect(classifyDeployHealth(200, 503)).toBe('degraded');
    expect(classifyDeployHealth(200, 500)).toBe('degraded');
    expect(classifyDeployHealth(200, 0)).toBe('degraded');
    expect(classifyDeployHealth(0, 400)).toBe('degraded');
    expect(classifyDeployHealth(502, 400)).toBe('degraded');
    expect(classifyDeployHealth(0, 0)).toBe('down');
    expect(classifyDeployHealth(502, 0)).toBe('down');
  });
});

describe('probeDeployHealth', () => {
  it('GETs / and /api/health on the base URL and returns the classified, uncached answer', async () => {
    const check = jest.fn(async (url: string) => (url.endsWith('/api/health') ? 200 : 200));
    const r = await probeDeployHealth({ now: T0, check });
    expect(r).toEqual({ status: 'healthy', checkedAt: T0.toISOString(), frontendCode: 200, backendCode: 200, baseUrl: 'https://digby.example.com', cached: false });
    expect(check.mock.calls.map((c) => c[0])).toEqual(['https://digby.example.com/', 'https://digby.example.com/api/health']);
  });

  it('caches for DEPLOY_HEALTH_CACHE_MS (one probe per burst); fresh:true and expiry re-probe', async () => {
    const check = jest.fn(async (_url: string) => 200);
    await probeDeployHealth({ now: T0, check });
    const hit = await probeDeployHealth({ now: at(DEPLOY_HEALTH_CACHE_MS), check });
    expect(hit).toMatchObject({ status: 'healthy', cached: true, checkedAt: T0.toISOString() });
    expect(check).toHaveBeenCalledTimes(2);
    await probeDeployHealth({ now: at(1_000), check, fresh: true });
    expect(check).toHaveBeenCalledTimes(4);
    const later = await probeDeployHealth({ now: at(DEPLOY_HEALTH_CACHE_MS + 2_000), check });
    expect(later.cached).toBe(false);
    expect(check).toHaveBeenCalledTimes(6);
  });

  it('DEPLOY_HEALTH_PROBE_DISABLED=1 skips the GET entirely and reads status skipped (never cached as a real answer)', async () => {
    process.env.DEPLOY_HEALTH_PROBE_DISABLED = '1';
    const check = jest.fn(async (_url: string) => 200);
    const r = await probeDeployHealth({ now: T0, check });
    expect(r).toMatchObject({ status: 'skipped', checkedAt: T0.toISOString(), reason: expect.stringContaining('DEPLOY_HEALTH_PROBE_DISABLED=1') });
    expect(r.frontendCode).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    delete process.env.DEPLOY_HEALTH_PROBE_DISABLED;
    expect((await probeDeployHealth({ now: at(1), check })).status).toBe('healthy');
  });

  it('DEPLOY_HEALTH_PROBE_BASE_URL overrides the probed origin (trailing slash stripped)', async () => {
    process.env.DEPLOY_HEALTH_PROBE_BASE_URL = 'https://edge.example.test/';
    expect(deployHealthBaseUrl()).toBe('https://edge.example.test');
    const check = jest.fn(async (_url: string) => 0);
    const r = await probeDeployHealth({ now: T0, check });
    expect(r).toMatchObject({ status: 'down', baseUrl: 'https://edge.example.test', frontendCode: 0, backendCode: 0 });
    expect(check.mock.calls.map((c) => c[0])).toEqual(['https://edge.example.test/', 'https://edge.example.test/api/health']);
  });

  it('a throwing check reads status unknown — never a rejection', async () => {
    const r = await probeDeployHealth({ now: T0, check: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ status: 'unknown', checkedAt: T0.toISOString(), cached: false });
  });

  it('httpStatusOf honors plain http:// targets (c75b5f34 follow-up: a self-hosted instance probes its own http:// Caddy URL — the old unconditional https.get read every http URL as 0)', async () => {
    // Real loopback listener — no network egress, no injected seam: the pin is
    // that httpStatusOf itself picks the right scheme.
    const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(httpStatusOf(`http://127.0.0.1:${port}/api/health`)).resolves.toBe(200);
      // and an https:// request against that plain-http port still degrades to 0 (never throws)
      await expect(httpStatusOf(`https://127.0.0.1:${port}/api/health`)).resolves.toBe(0);
    } finally {
      server.close();
    }
  });
});
