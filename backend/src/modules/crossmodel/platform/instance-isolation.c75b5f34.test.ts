/**
 * REPLAY — ticket c75b5f34 "Self-hosted/Edge isolation boundary: self-improve
 * on own copy only, hard-fail on prod targets".
 *
 * The leaf's contract is pinned in instance-targets.test.ts. THIS suite pins
 * the WIRED surfaces — the call sites that historically defaulted to the
 * production repo (`|| 'canada-quant/digby'`) and now resolve from the
 * instance's OWN environment, hard-failing when a NON-prod instance
 * (DIGBY_INSTANCE != prod) would resolve a production target:
 *
 *   - self-merge ownRepoSlug() (SELF_REPO) — the always-on self-merge target;
 *   - infra-watch DEPLOY_REPO (INFRA_WATCH_REPO) — module-load const: a
 *     non-prod instance configured to the production repo must fail AT LOAD
 *     (a boot hard-fail), unset ⇒ '' (nothing watched, no silent prod read);
 *   - deploy-health — a non-prod instance never probes the production site by
 *     default (own SELFHOST_PUBLIC_URL, else 'skipped').
 *
 * Prod behavior with DIGBY_INSTANCE unset is pinned by the existing suites
 * (self-merge.service.test.ts, infra-watch.service.test.ts,
 * deploy-repo-scope.51ff7e93.test.ts, deploy-health.test.ts) — all green
 * before this change; this suite adds the NON-prod side.
 */

// self-merge.service's static graph reaches prisma/redis (config/env's
// process.exit landmine in a bare test context) — mock the boundary modules.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ENV_KEYS = ['DIGBY_INSTANCE', 'SELF_REPO', 'INFRA_WATCH_REPO', 'GITHUB_REPO_SLUG', 'DEPLOY_HEALTH_PROBE_BASE_URL', 'SELFHOST_PUBLIC_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  // deploy-health's in-process cache must not leak between env shapes.
  jest.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe('c75b5f34 — self-merge ownRepoSlug() resolves from the instance env', () => {
  it('DIGBY_INSTANCE unset ⇒ prod ⇒ the production repo (self-merge behavior unchanged)', () => {
    const { ownRepoSlug } = require('../coding/self-merge.service');
    expect(ownRepoSlug()).toBe('canada-quant/digby');
  });

  it('non-prod instance, SELF_REPO unset ⇒ empty (no own repo — never a silent prod fallback)', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    const { ownRepoSlug } = require('../coding/self-merge.service');
    expect(ownRepoSlug()).toBe('');
  });

  it('non-prod instance, SELF_REPO = own fork ⇒ the fork (self-improvement on its own copy)', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    process.env.SELF_REPO = 'acme/edge-digby';
    const { ownRepoSlug } = require('../coding/self-merge.service');
    expect(ownRepoSlug()).toBe('acme/edge-digby');
  });

  it('non-prod instance, SELF_REPO = PRODUCTION repo ⇒ hard fail (IsolationBoundaryError)', () => {
    process.env.DIGBY_INSTANCE = 'edge';
    process.env.SELF_REPO = 'canada-quant/digby';
    const { ownRepoSlug } = require('../coding/self-merge.service');
    expect(() => ownRepoSlug()).toThrow(/ISOLATION BOUNDARY/);
    expect(() => ownRepoSlug()).toThrow(/canada-quant\/digby/);
  });
});

describe('c75b5f34 — infra-watch DEPLOY_REPO (module-load resolution)', () => {
  it('DIGBY_INSTANCE unset ⇒ prod ⇒ the production repo (deploy telemetry unchanged)', () => {
    const { DEPLOY_REPO } = require('../fleet/infra-watch.service');
    expect(DEPLOY_REPO).toBe('canada-quant/digby');
  });

  it('non-prod instance, INFRA_WATCH_REPO unset ⇒ empty string (nothing watched — fetchers short-circuit to no facts)', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    const { DEPLOY_REPO, fetchDeployRuns } = require('../fleet/infra-watch.service');
    expect(DEPLOY_REPO).toBe('');
    // and the fetcher refuses to build a URL at all
    return expect(fetchDeployRuns('tok')).resolves.toEqual([]);
  });

  it('non-prod instance, INFRA_WATCH_REPO = own fork ⇒ the fork', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    process.env.INFRA_WATCH_REPO = 'acme/edge-digby';
    const { DEPLOY_REPO } = require('../fleet/infra-watch.service');
    expect(DEPLOY_REPO).toBe('acme/edge-digby');
  });

  it('non-prod instance, INFRA_WATCH_REPO = PRODUCTION repo ⇒ module load HARD-FAILS (boot refuses to start watching prod)', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    process.env.INFRA_WATCH_REPO = 'canada-quant/digby';
    expect(() => require('../fleet/infra-watch.service')).toThrow(/ISOLATION BOUNDARY/);
  });
});

describe('c75b5f34 — deploy-health never probes the production site from a non-prod instance', () => {
  it('DIGBY_INSTANCE unset ⇒ prod ⇒ the production default https://digby.example.com (unchanged)', () => {
    const { deployHealthBaseUrl } = require('../fleet/deploy-health');
    expect(deployHealthBaseUrl()).toBe('https://digby.example.com');
  });

  it('non-prod instance ⇒ the instance OWN public URL (SELFHOST_PUBLIC_URL)', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    process.env.SELFHOST_PUBLIC_URL = 'http://my-digby.lan:8080/';
    const { deployHealthBaseUrl } = require('../fleet/deploy-health');
    expect(deployHealthBaseUrl()).toBe('http://my-digby.lan:8080');
  });

  it('non-prod instance with no own URL ⇒ empty base ⇒ probe answers skipped (never the production default)', async () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    const { probeDeployHealth } = require('../fleet/deploy-health');
    const r = await probeDeployHealth({ now: new Date(), check: async () => 200 });
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('isolation boundary');
  });

  it('an explicit DEPLOY_HEALTH_PROBE_BASE_URL still wins on a non-prod instance (the operator override)', () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    process.env.DEPLOY_HEALTH_PROBE_BASE_URL = 'https://status.my-digby.example';
    const { deployHealthBaseUrl } = require('../fleet/deploy-health');
    expect(deployHealthBaseUrl()).toBe('https://status.my-digby.example');
  });
});
