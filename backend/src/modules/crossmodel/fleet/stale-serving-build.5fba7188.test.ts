/**
 * Ticket 5fba7188 — a superseded worker colour serves tool traffic and masks a
 * shipped fix.
 *
 * The worker blue-green handoff is zero-gap BY DESIGN (owner 2026-09-24): the
 * new colour goes healthy, the old one gets SIGTERM and stops claiming, but it
 * KEEPS EXECUTING the runs it already claimed — in place, up to
 * WORKER_DRAIN_MAX_MS (6 h), writing the /tmp/worker-draining marker. A run
 * still executing there answers its tool calls with the OLD build, so a read
 * that is merely STALE is byte-indistinguishable from a read that PROVES the
 * newest field is absent.
 *
 * Live evidence (box-c, 2026-10-31T04:23Z): admin-worker-green ran
 * d1d55ab5ea with the drain marker ABSENT (claiming), admin-worker-blue ran
 * 6cb78fee26 with DRAIN=present — one live colour plus one by-design drainer,
 * NOT two servers. Reconciling them away would interrupt live runs, so the
 * read is made FALSIFIABLE instead: every answer stamps the build that
 * produced it.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  appErrorLog: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
  userFeatureRequest: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./deploy-health', () => ({
  __esModule: true,
  ...jest.requireActual('./deploy-health'),
  probeDeployHealth: jest.fn(async () => ({ status: 'healthy', checkedAt: '2026-10-31T04:00:00.000Z', frontendCode: 200, backendCode: 200, baseUrl: 'https://digby.example.com', cached: false })),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  queryLoopMetrics: jest.fn(async () => []),
  summarizeLoopMetrics: jest.fn(async () => []),
  recordLoopMetric: jest.fn(),
}));

import {
  fleetTelemetry,
  servingBuildLine,
} from './fleet-telemetry';
import {
  servingBuild,
  servingProcessKind,
  workerDrainFile,
  WORKER_DRAIN_FILE_DEFAULT,
} from './infra-watch.service';

const NOW = new Date('2026-10-31T04:30:00.000Z');

const env = (over: Record<string, string | undefined> = {}) => ({ ...over } as NodeJS.ProcessEnv);
const noMarker = () => false;
const marker = () => true;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
});

describe('workerDrainFile — ONE definition of the marker path', () => {
  it('defaults to the marker worker.ts writes', () => {
    expect(workerDrainFile(env())).toBe(WORKER_DRAIN_FILE_DEFAULT);
    expect(WORKER_DRAIN_FILE_DEFAULT).toBe('/tmp/worker-draining');
  });

  it('honours the WORKER_DRAIN_FILE override and ignores a blank one', () => {
    expect(workerDrainFile(env({ WORKER_DRAIN_FILE: '/tmp/other' }))).toBe('/tmp/other');
    expect(workerDrainFile(env({ WORKER_DRAIN_FILE: '  ' }))).toBe(WORKER_DRAIN_FILE_DEFAULT);
  });
});

describe('servingProcessKind — which tier runs in this container', () => {
  it('reads the two compose commands', () => {
    expect(servingProcessKind('/app/dist/worker.js')).toBe('worker');
    expect(servingProcessKind('/app/dist/server.js')).toBe('web');
    // '' (not undefined — that falls back to the real process.argv[1], which
    // under jest is jest-worker's own path) is the "cannot tell" case.
    expect(servingProcessKind('')).toBe('unknown');
    expect(servingProcessKind('/app/dist/something.js')).toBe('unknown');
  });
});

describe('servingBuild — the stamp that makes a read falsifiable', () => {
  it('a LIVE claiming worker reports its sha, tier and draining:false', () => {
    const b = servingBuild(env({ DEPLOY_SHA: 'd1d55ab5ea0f3c73c32d805af5d3f23335f039e3', BOX_NAME: 'box-c' }), '/app/dist/worker.js', 300, noMarker);
    expect(b).toEqual({ sha: 'd1d55ab5', host: 'box-c', process: 'worker', draining: false, upMin: 5 });
  });

  it('a DRAINING worker is named as superseded — the box-c 6cb78fee26 shape', () => {
    const b = servingBuild(env({ DEPLOY_SHA: '6cb78fee263558235ea6cc14a4fbecb11c1c4220', BOX_NAME: 'box-c' }), '/app/dist/worker.js', 3600, marker);
    expect(b).toMatchObject({ sha: '6cb78fee', host: 'box-c', process: 'worker', draining: true, upMin: 60 });
  });

  it('the WEB tier never reads as draining (the marker is a worker concept)', () => {
    const b = servingBuild(env({ DEPLOY_SHA: '6cb78fee263558235ea6cc14a4fbecb11c1c4220' }), '/app/dist/server.js', 60, marker);
    expect(b.draining).toBe(false);
    expect(b.process).toBe('web');
  });

  it('an unreadable marker reads as not-draining instead of throwing', () => {
    const b = servingBuild(env({ DEPLOY_SHA: '6cb78fee' }), '/app/dist/worker.js', 60, () => { throw new Error('EACCES'); });
    expect(b.draining).toBe(false);
  });

  it('a pre-passthrough build reports sha:null — never a guessed head', () => {
    const b = servingBuild(env({ BOX_NAME: 'box-a' }), '/app/dist/server.js', 120, noMarker);
    expect(b.sha).toBeNull();
    expect(b.host).toBe('box-a');
  });

  it('rejects a non-sha DEPLOY_SHA instead of stamping garbage', () => {
    expect(servingBuild(env({ DEPLOY_SHA: 'dev' }), '/app/dist/worker.js', 1, noMarker).sha).toBeNull();
  });
});

describe('servingBuildLine — the sentence a reader acts on', () => {
  const head = { sha: 'd1d55ab5ea0f3c73c32d805af5d3f23335f039e3' };

  it('names a DRAINING build as superseded and says a missing field proves nothing', () => {
    const line = servingBuildLine({ sha: '6cb78fee', host: 'box-c', process: 'worker', draining: true, upMin: 96 }, head);
    expect(line).toContain('SUPERSEDED build');
    expect(line).toContain('6cb78fee');
    expect(line).toContain('DRAINING');
    expect(line).toContain('proves NOTHING');
  });

  it('says a missing field on main head IS evidence — scoped to the read', () => {
    const line = servingBuildLine({ sha: 'd1d55ab5', host: 'box-a', process: 'web', draining: false, upMin: 3 }, head);
    expect(line).toContain('IS evidence this build genuinely lacks it');
    // N6: the premise is head equality AT READ TIME, and the sentence says so.
    expect(line).toContain('as read now');
  });

  it('attributes a behind-head build to the lag, not to a failed fix', () => {
    const line = servingBuildLine({ sha: '6cb78fee', host: 'box-c', process: 'worker', draining: false, upMin: 3 }, head);
    expect(line).toContain('NOT main head d1d55ab5');
    expect(line).toContain('not a failed fix');
    expect(line).toContain('re-read before concluding');
  });

  // N2 (review of #2208): the lag REASON is tier-specific — a WEB reader must not
  // be handed box C's worker-skip rule, which does not apply to it.
  it('gives the tier-correct reason behind head', () => {
    const w = servingBuildLine({ sha: '6cb78fee', host: 'box-c', process: 'worker', draining: false, upMin: 3 }, head);
    const web = servingBuildLine({ sha: '6cb78fee', host: 'box-a', process: 'web', draining: false, upMin: 3 }, head);
    expect(w).toContain("box C's worker rebuilds only");
    expect(web).not.toContain("box C's worker");
    expect(web).toContain('the web tier is rebuilt by every wave');
  });

  it('refuses to attribute when the answering build reports no sha', () => {
    const line = servingBuildLine({ sha: null, host: 'box-a', process: 'web', draining: false, upMin: 9 }, head);
    expect(line).toContain('reports NO deploy sha');
    expect(line).toContain('NOT evidence');
  });

  it('refuses to attribute when main head could not be read', () => {
    const line = servingBuildLine({ sha: '6cb78fee', host: 'box-c', process: 'worker', draining: false, upMin: 9 }, null);
    expect(line).toContain('cannot be attributed either way');
  });
});

describe('fleetTelemetry — every answer carries the build that produced it', () => {
  const drainer = { sha: '6cb78fee', host: 'box-c', process: 'worker' as const, draining: true, upMin: 96 };

  it('stamps servingBuild on a NON-deploy view too (the fields are not deploy-only)', async () => {
    const out: any = await fleetTelemetry({ view: 'kinds' }, { userId: 'u', now: NOW, servingBuild: () => drainer });
    expect(out.servingBuild).toEqual(drainer);
    expect(out.view).toBe('kinds');
  });

  // N5 (review of #2208): the tests above drive the injected seam, which stays
  // green even if servingBuild()/the marker read were deleted. This one pins the
  // DEFAULT wiring — no seam — so the real detection is what stamps an answer.
  it('with NO seam injected, the REAL servingBuild stamps the answer', async () => {
    const savedSha = process.env.DEPLOY_SHA;
    process.env.DEPLOY_SHA = 'deadbeefcafe';
    try {
      const out: any = await fleetTelemetry({ view: 'kinds' }, { userId: 'u', now: NOW });
      expect(out.servingBuild.sha).toBe('deadbeef');
      expect(typeof out.servingBuild.draining).toBe('boolean');
      expect(['worker', 'web', 'unknown']).toContain(out.servingBuild.process);
      expect(typeof out.servingBuild.upMin).toBe('number');
    } finally {
      if (savedSha === undefined) delete process.env.DEPLOY_SHA; else process.env.DEPLOY_SHA = savedSha;
    }
  });

  // N5: the draining flag must come from the MARKER, not from a default — a build
  // that reports draining for every process would be as useless as none at all.
  it('the marker file alone decides draining (same env, marker present vs absent)', () => {
    const e = env({ DEPLOY_SHA: '6cb78fee', BOX_NAME: 'box-c' });
    const absent = servingBuild(e, '/app/dist/worker.js', 600, noMarker);
    const present = servingBuild(e, '/app/dist/worker.js', 600, marker);
    expect(absent.draining).toBe(false);
    expect(present.draining).toBe(true);
    expect(absent.sha).toBe(present.sha);
  });

  it('the deploy view stamps it AND says it in the reading', async () => {
    const out: any = await fleetTelemetry(
      { view: 'deploy' },
      {
        userId: 'u', now: NOW,
        servingBuild: () => drainer,
        getGithubToken: async () => null,
      },
    );
    expect(out.servingBuild).toEqual(drainer);
    expect(out.reading).toContain('SUPERSEDED build');
    expect(out.reading).toContain('proves NOTHING');
  });

  it('a live on-head build yields the "missing field IS evidence" reading', async () => {
    const out: any = await fleetTelemetry(
      { view: 'deploy' },
      {
        userId: 'u', now: NOW,
        getGithubToken: async () => 'tok',
        fetchHead: async () => ({ sha: 'd1d55ab5ea0f3c73c32d805af5d3f23335f039e3', committedAt: '2026-10-31T03:00:00Z', title: 'x' }),
        fetchRunsWithStatus: async () => ({ runs: [], status: 200 }),
        servingBuild: () => ({ sha: 'd1d55ab5', host: 'box-a', process: 'web', draining: false, upMin: 4 }),
      },
    );
    expect(out.servingBuild.sha).toBe('d1d55ab5');
    expect(out.reading).toContain('IS evidence this build genuinely lacks it');
  });
});