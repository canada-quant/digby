/**
 * One-Digby Phase 1B — workspace safety invariants:
 * SSRF guard on repoUrl (amendment E3) + per-project mutex (E5).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {
  chatCodingState: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  agentRun: { findMany: jest.fn(async () => []) },
  crossModelProject: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
} }));
jest.mock('./workspace.service', () => ({
  __esModule: true,
  git: jest.fn(async () => ({ stdout: '', stderr: '' })),
  ensureRepoMirror: jest.fn(async () => '/repos/x.git'),
  repoMirrorPath: jest.fn((id: string) => `/repos/${id}.git`),
  worktreePath: jest.fn((id: string) => `/wt/${id}`),
  listSessionEnvSidecars: jest.fn(async () => [] as string[]),
  removeSessionEnv: jest.fn(async () => {}),
  removeWorktree: jest.fn(async () => {}),
  persistSessionEnv: jest.fn(async () => true),
  // Review 2026-09-13 issue 8: census + ownership seams (default: nothing on
  // disk, this box owns the volume — the pre-review behaviour).
  listWorktreeDirsOnDisk: jest.fn(async () => [] as Array<{ sessionId: string; mtimeMs: number }>),
  isWorkspaceVolumeOwner: jest.fn(() => true),
}));
// Review 2026-09-13 issue 8: the reaper's own fs touches (orphan-dir rm, the
// `.git` gitdir read, pathExists) — mocked so no test reaches the real disk.
const mockFsRm: jest.Mock = jest.fn(async () => {});
const mockFsReadFile: jest.Mock = jest.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
const mockFsAccess: jest.Mock = jest.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
// Ticket 09d84d7d: prunePathArtifacts' readdir — default ENOENT (prune walk
// sees nothing); tests override per worktree layout.
const mockFsReaddir: jest.Mock = jest.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
jest.mock('fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('fs/promises'),
  rm: (...a: any[]) => mockFsRm(...a),
  readFile: (...a: any[]) => mockFsReadFile(...a),
  access: (...a: any[]) => mockFsAccess(...a),
  readdir: (...a: any[]) => mockFsReaddir(...a),
}));
jest.mock('./scaffolding.service', () => ({ __esModule: true, scaffoldProjectDocs: jest.fn(async () => ({})) }));
// Reaper teardown boundary (dynamic import inside reapIdleWorktrees).
jest.mock('./container.service', () => ({
  __esModule: true,
  stopSessionContainer: jest.fn(async () => {}),
  removeSandboxHome: jest.fn(async () => {}),
}));
// Loop telemetry (remediation P0 worktree_reaped): mocked at the boundary.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { WORKTREE_REAPED: 'worktree_reaped', WORKTREE_REAP_PASS: 'worktree_reap_pass' },
}));
// 2026-10-20: the reaper's per-session live re-check reads the in-memory
// background-process registry (default: nothing running).
const mockProcessSnapshot: jest.Mock = jest.fn(() => []);
jest.mock('./process.service', () => ({
  __esModule: true,
  processSnapshot: (...a: any[]) => mockProcessSnapshot(...a),
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
  },
}));

import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import prisma from '../../../config/database';
import { validateRepoUrl, __withProjectLockForTest as withProjectLock, pruneOrphanSessionEnv, reapIdleWorktrees, pruneReinstallableArtifacts, configureWorkspace, shouldPruneWorktreeArtifacts, reapIdleMsForUsage, worktreeReapIntervalSec, sessionBusyForReap, runWorktreeReapOnce, type ReapPassStats } from './project-workspace.service';

describe('validateRepoUrl (SSRF guard, amendment E3)', () => {
  it('accepts normal https git hosts', () => {
    expect(validateRepoUrl('https://github.com/org/repo.git')).toBeNull();
    expect(validateRepoUrl('https://gitlab.com/group/proj.git')).toBeNull();
  });

  it('rejects non-https schemes', () => {
    expect(validateRepoUrl('http://github.com/org/repo.git')).toBeTruthy();
    expect(validateRepoUrl('git://github.com/org/repo.git')).toBeTruthy();
    expect(validateRepoUrl('file:///etc/passwd')).toBeTruthy();
    expect(validateRepoUrl('ssh://git@github.com/org/repo.git')).toBeTruthy();
  });

  it('rejects loopback, private, and link-local hosts (clone runs on the backend)', () => {
    expect(validateRepoUrl('https://localhost/x.git')).toBeTruthy();
    expect(validateRepoUrl('https://127.0.0.1/x.git')).toBeTruthy();
    expect(validateRepoUrl('https://10.1.2.3/x.git')).toBeTruthy();
    expect(validateRepoUrl('https://172.16.0.1/x.git')).toBeTruthy();
    expect(validateRepoUrl('https://192.168.1.1/x.git')).toBeTruthy();
    expect(validateRepoUrl('https://169.254.169.254/latest/meta-data')).toBeTruthy(); // AWS metadata
  });

  it('rejects custom ports and inline credentials', () => {
    expect(validateRepoUrl('https://github.com:8443/x.git')).toBeTruthy();
    expect(validateRepoUrl('https://user:pass@github.com/x.git')).toBeTruthy();
  });

  it('rejects 172.x hosts only in the RFC-1918 range', () => {
    expect(validateRepoUrl('https://172.15.0.1/x.git')).toBeNull();   // public
    expect(validateRepoUrl('https://172.32.0.1/x.git')).toBeNull();   // public
    expect(validateRepoUrl('https://172.31.0.1/x.git')).toBeTruthy(); // private
  });
});

describe('withProjectLock (E5 + cross-process Redis NX layer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (redisClient.set as jest.Mock).mockResolvedValue('OK');
    (redisClient.eval as jest.Mock).mockResolvedValue(1);
  });

  it('takes the Redis NX lock with a TTL and releases it (ownership-checked) after fn', async () => {
    const result = await withProjectLock('p1', async () => 'done');
    expect(result).toBe('done');
    expect(redisClient.set).toHaveBeenCalledWith(
      'coding:project:lock:p1',
      expect.any(String),
      { NX: true, PX: 60_000 },
    );
    // Release goes through the ownership-checked Lua script with OUR token.
    const token = (redisClient.set as jest.Mock).mock.calls[0][1];
    expect(redisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('del'),
      { keys: ['coding:project:lock:p1'], arguments: [token] },
    );
  });

  it('releases the Redis lock even when fn throws', async () => {
    await expect(withProjectLock('p1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(redisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('del'),
      expect.objectContaining({ keys: ['coding:project:lock:p1'] }),
    );
  });

  it('fails OPEN to the in-process mutex alone when Redis is down (warns once)', async () => {
    (redisClient.set as jest.Mock).mockRejectedValue(new Error('redis down'));
    expect(await withProjectLock('p1', async () => 'ran')).toBe('ran');
    expect(await withProjectLock('p1', async () => 'ran again')).toBe('ran again');
    expect(logger.warn).toHaveBeenCalledTimes(1); // once per outage, not per call
    expect(redisClient.eval).not.toHaveBeenCalled(); // nothing acquired → nothing released
  });

  it('waits and retries while another holder has the lock', async () => {
    (redisClient.set as jest.Mock)
      .mockResolvedValueOnce(null)   // held elsewhere
      .mockResolvedValueOnce('OK');  // freed on the retry
    const result = await withProjectLock('p1', async () => 'eventually');
    expect(result).toBe('eventually');
    expect(redisClient.set).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('still serializes concurrent same-process callers (inner mutex intact)', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(r => { releaseFirst = r; });
    const first = withProjectLock('p1', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = withProjectLock('p1', async () => {
      order.push('second');
    });
    // Give the second call time to (incorrectly) start if the mutex were broken.
    await new Promise(r => setTimeout(r, 700));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  }, 10_000);
});

describe('pruneOrphanSessionEnv (2026-08-20 review — deleted users must not leave env seeds)', () => {
  it('unlinks sidecars with no live chatCodingState row and keeps live ones', async () => {
    const wsMock = jest.requireMock('./workspace.service');
    const prismaMock = jest.requireMock('../../../config/database').default;
    wsMock.listSessionEnvSidecars.mockResolvedValueOnce(['orphan-1', 'live-1']);
    prismaMock.chatCodingState.findMany.mockResolvedValueOnce([{ id: 'live-1' }]);
    wsMock.removeSessionEnv.mockClear();

    await expect(pruneOrphanSessionEnv()).resolves.toBe(1);
    expect(wsMock.removeSessionEnv).toHaveBeenCalledTimes(1);
    expect(wsMock.removeSessionEnv).toHaveBeenCalledWith('orphan-1');
  });

  it('is a no-op when there are no sidecars at all', async () => {
    const wsMock = jest.requireMock('./workspace.service');
    wsMock.listSessionEnvSidecars.mockResolvedValueOnce([]);
    wsMock.removeSessionEnv.mockClear();
    await expect(pruneOrphanSessionEnv()).resolves.toBe(0);
    expect(wsMock.removeSessionEnv).not.toHaveBeenCalled();
  });
});

describe('pruneOrphanSessionEnv fail-safe (review round 2)', () => {
  it('a failed session lookup SKIPS the sweep — never deletes on uncertainty', async () => {
    const wsMock = jest.requireMock('./workspace.service');
    const prismaMock = jest.requireMock('../../../config/database').default;
    wsMock.listSessionEnvSidecars.mockResolvedValueOnce(['only-copy-seed']);
    prismaMock.chatCodingState.findMany.mockRejectedValueOnce(new Error('db down'));
    wsMock.removeSessionEnv.mockClear();
    await expect(pruneOrphanSessionEnv()).resolves.toBe(0);
    expect(wsMock.removeSessionEnv).not.toHaveBeenCalled();
  });
});

// ── worktree_reaped telemetry (remediation P0) ───────────────────────────────

describe('reapIdleWorktrees worktree_reaped emission (remediation P0)', () => {
  const candidate = (id: string, provider: string | null) => ({
    id, projectId: 'p1', status: 'ready', worktreePath: `/wt/${id}`,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    project: { id: 'p1', repoProvider: provider },
  });

  beforeEach(() => {
    mockRecordLoopMetric.mockClear();
    (prisma.chatCodingState.findMany as jest.Mock).mockReset().mockResolvedValue([]);
    (prisma.chatCodingState.update as jest.Mock).mockClear().mockResolvedValue({});
  });

  it('a reaped session emits ONE row with chatId + reason (default idle)', async () => {
    (prisma.chatCodingState.findMany as jest.Mock).mockResolvedValue([candidate('sess-reap-1', 'github')]);
    const n = await reapIdleWorktrees();
    expect(n).toBe(1);
    const rows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'worktree_reaped');
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toMatchObject({
      sessionId: 'sess-reap-1',
      meta: { chatId: 'sess-reap-1', reason: 'idle', provider: 'github' },
    });
  });

  it('the disk-pressure pass stamps reason disk_pressure', async () => {
    (prisma.chatCodingState.findMany as jest.Mock).mockResolvedValue([candidate('sess-reap-2', 'github')]);
    await reapIdleWorktrees({ idleMs: 48 * 3600 * 1000, take: 100, reason: 'disk_pressure' });
    const rows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'worktree_reaped');
    expect(rows).toHaveLength(1);
    expect(rows[0][0].meta.reason).toBe('disk_pressure');
  });

  it('a blank/no-provider session (the ONLY copy of the work) is never reaped and never emits', async () => {
    (prisma.chatCodingState.findMany as jest.Mock).mockResolvedValue([
      candidate('sess-blank', 'blank'), candidate('sess-noprov', null),
    ]);
    const n = await reapIdleWorktrees();
    expect(n).toBe(0);
    expect(mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'worktree_reaped')).toHaveLength(0);
  });
});

// ── P6 (spark B24 / CanLaw B12): the 48h pressure reap must not kill LIVE
// scheduled lanes — an enabled schedule means the session fires again and
// would pay a cold re-provision (fresh HOME, gone deps) every wake. ──────────
describe('reapIdleWorktrees scheduled-lane exemption (P6 — B24)', () => {
  const candidate = (id: string) => ({
    id, projectId: 'p1', worktreePath: `/wt/${id}`, updatedAt: new Date(0),
    project: { id: 'p1', repoProvider: 'github' },
  });

  beforeEach(() => {
    const prismaMock = jest.requireMock('../../../config/database').default;
    prismaMock.chatCodingState.findMany.mockReset();
    prismaMock.chatCodingState.update.mockReset().mockResolvedValue({});
    prismaMock.chatSchedule.findMany.mockReset().mockResolvedValue([]);
  });

  it('exemptScheduled: sessions with an ENABLED schedule are filtered out of the pressure batch', async () => {
    const prismaMock = jest.requireMock('../../../config/database').default;
    prismaMock.chatCodingState.findMany.mockResolvedValueOnce([candidate('s-sched'), candidate('s-idle')]);
    prismaMock.chatSchedule.findMany.mockResolvedValueOnce([{ sessionId: 's-sched' }]);
    const reaped = await reapIdleWorktrees({ idleMs: 48 * 3600 * 1000, take: 100, exemptScheduled: true });
    expect(reaped).toBe(1);
    const updatedIds = prismaMock.chatCodingState.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).toEqual(['s-idle']); // the scheduled lane survives
    expect(prismaMock.chatSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enabled: true, sessionId: { in: ['s-sched', 's-idle'] } }),
    }));
  });

  it('exemptScheduled fail-safe: a schedule-lookup error skips the whole pressure batch (never reaps on uncertainty)', async () => {
    const prismaMock = jest.requireMock('../../../config/database').default;
    prismaMock.chatCodingState.findMany.mockResolvedValueOnce([candidate('s-a')]);
    prismaMock.chatSchedule.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(reapIdleWorktrees({ idleMs: 48 * 3600 * 1000, exemptScheduled: true })).resolves.toBe(0);
    expect(prismaMock.chatCodingState.update).not.toHaveBeenCalled();
  });

  it('the default (7d) reap is untouched: no exemption without the flag', async () => {
    const prismaMock = jest.requireMock('../../../config/database').default;
    prismaMock.chatCodingState.findMany.mockResolvedValueOnce([candidate('s-sched')]);
    const reaped = await reapIdleWorktrees();
    expect(reaped).toBe(1);
    expect(prismaMock.chatSchedule.findMany).not.toHaveBeenCalled();
  });
});

// ── Review 2026-09-13 issue 8: census by DIRECTORY + volume ownership ────────
// Box A's 0-slot worker won the reaper claim, deleted its stale COPY of each
// worktree and nulled the SHARED DB path — orphaning box C's real dir. 177 of
// 223 dirs (79 GB) then had worktreePath=null (118) or no row (59), and the
// old non-null-path query could never see them again.
describe('reapIdleWorktrees on-disk census + ownership (review 2026-09-13 issue 8)', () => {
  const DAY = 24 * 3600 * 1000;
  const oldMtime = Date.now() - 30 * DAY;
  const wsMock = () => jest.requireMock('./workspace.service');
  const prismaMock = () => jest.requireMock('../../../config/database').default;
  const containerMock = () => jest.requireMock('./container.service');
  const row = (id: string, worktreePath: string | null) => ({
    id, projectId: 'p1', status: 'ready', worktreePath, updatedAt: new Date('2026-08-01T00:00:00Z'),
    project: { id: 'p1', repoProvider: 'github' },
  });

  beforeEach(() => {
    mockRecordLoopMetric.mockClear();
    mockFsRm.mockClear();
    mockFsReadFile.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFsAccess.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    prismaMock().chatCodingState.findMany.mockReset().mockResolvedValue([]);
    prismaMock().chatCodingState.update.mockReset().mockResolvedValue({});
    prismaMock().chatSchedule.findMany.mockReset().mockResolvedValue([]);
    wsMock().listWorktreeDirsOnDisk.mockReset().mockResolvedValue([]);
    wsMock().isWorkspaceVolumeOwner.mockReset().mockReturnValue(true);
    wsMock().removeWorktree.mockClear();
    (containerMock().stopSessionContainer as jest.Mock).mockClear();
    (containerMock().removeSandboxHome as jest.Mock).mockClear();
  });

  it('a dirty worktree whose WIP snapshot does not land is KEPT — never deleted (review of #1768)', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-dirty', mtimeMs: oldMtime }]);
    mockFsAccess.mockResolvedValue(undefined);
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([row('s-dirty', '/wt/s-dirty')])
      .mockResolvedValueOnce([{ id: 's-dirty' }]);
    // status stays dirty after add + commit: the commit failed
    wsMock().git.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) return { stdout: ' M src/app.ts\n', stderr: '' };
      if (args.includes('commit')) throw new Error('commit failed');
      return { stdout: '', stderr: '' };
    });
    try {
      const n = await reapIdleWorktrees();
      expect(n).toBe(0);
      expect(wsMock().removeWorktree).not.toHaveBeenCalled();
      expect(prismaMock().chatCodingState.update).not.toHaveBeenCalled();
    } finally {
      wsMock().git.mockReset().mockImplementation(async () => ({ stdout: '', stderr: '' }));
    }
  });

  it('a worktree whose git status fails is KEPT (cannot tell whether it holds unsaved work)', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-broken', mtimeMs: oldMtime }]);
    mockFsAccess.mockResolvedValue(undefined);
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([row('s-broken', '/wt/s-broken')])
      .mockResolvedValueOnce([{ id: 's-broken' }]);
    wsMock().git.mockImplementation(async () => { throw new Error('not a git repository'); });
    try {
      expect(await reapIdleWorktrees()).toBe(0);
      expect(wsMock().removeWorktree).not.toHaveBeenCalled();
    } finally {
      wsMock().git.mockReset().mockImplementation(async () => ({ stdout: '', stderr: '' }));
    }
  });

  it('the candidate query is widened to dirs ON DISK: a null-path row whose dir exists is queried (OR id IN census) and reaped, nulling its path', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-nullpath', mtimeMs: oldMtime }]);
    mockFsAccess.mockResolvedValue(undefined); // the dir is on disk
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([row('s-nullpath', null)])  // candidates
      .mockResolvedValueOnce([{ id: 's-nullpath' }]);    // orphan pass: known row → not an orphan
    const n = await reapIdleWorktrees();
    expect(n).toBe(1);
    const where = prismaMock().chatCodingState.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ worktreePath: { not: null } }, { id: { in: ['s-nullpath'] } }]);
    expect(where.worktreePath).toBeUndefined();
    expect(wsMock().removeWorktree).toHaveBeenCalledWith('p1', 's-nullpath');
    expect(prismaMock().chatCodingState.update).toHaveBeenCalledWith({ where: { id: 's-nullpath' }, data: { worktreePath: null } });
    const rows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'worktree_reaped');
    expect(rows).toHaveLength(1);
    expect(rows[0][0].meta).toMatchObject({ pathWasNull: true, volumeOwner: true, dbNulled: true, onDisk: true });
    // nothing was treated as an orphan
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('with NOTHING on disk the query is the classic non-null-path one (no OR) and no orphan lookup runs', async () => {
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([]);
    await reapIdleWorktrees();
    expect(prismaMock().chatCodingState.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock().chatCodingState.findMany.mock.calls[0][0].where;
    expect(where.worktreePath).toEqual({ not: null });
    expect(where.OR).toBeUndefined();
  });

  it('a dir with NO row, idle by mtime, is removed (fs.rm) + prunes its mirror admin entry + emits orphan:true; never touches the DB', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([
      { sessionId: 'orphan-old', mtimeMs: oldMtime },
      { sessionId: 'orphan-fresh', mtimeMs: Date.now() - 1 * DAY }, // NOT idle → kept
    ]);
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([])   // candidates
      .mockResolvedValueOnce([]);  // orphan pass: no rows for either dir
    mockFsReadFile.mockResolvedValue('gitdir: /repos/p9.git/worktrees/orphan-old\n');
    const n = await reapIdleWorktrees();
    expect(n).toBe(1);
    expect(mockFsRm).toHaveBeenCalledTimes(1);
    expect(mockFsRm).toHaveBeenCalledWith('/wt/orphan-old', { recursive: true, force: true });
    // the mirror's stale worktree admin entry is pruned where the .git file names it
    expect(wsMock().git).toHaveBeenCalledWith(['worktree', 'prune'], '/repos/p9.git');
    expect(prismaMock().chatCodingState.update).not.toHaveBeenCalled();
    const rows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'worktree_reaped');
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toMatchObject({ sessionId: 'orphan-old', meta: { orphan: true, dbNulled: false, reason: 'idle' } });
  });

  it('a dir whose row exists but is NOT idle/ready (e.g. running) is neither a candidate nor an orphan', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-running', mtimeMs: oldMtime }]);
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([])                  // the idle/ready query excluded it
      .mockResolvedValueOnce([{ id: 's-running' }]); // …but the row exists → not an orphan
    expect(await reapIdleWorktrees()).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('orphan pass fail-safe: a failed row lookup skips it — a DB hiccup must never make every dir look orphaned', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 'maybe-orphan', mtimeMs: oldMtime }]);
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('db down'));
    expect(await reapIdleWorktrees()).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('the orphan pass respects the batch budget (take) after the row candidates', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([
      { sessionId: 'o1', mtimeMs: oldMtime - 3 }, { sessionId: 'o2', mtimeMs: oldMtime - 2 }, { sessionId: 'o3', mtimeMs: oldMtime - 1 },
    ]);
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await reapIdleWorktrees({ take: 2 })).toBe(2);
    // oldest first
    expect(mockFsRm.mock.calls.map((c) => c[0])).toEqual(['/wt/o1', '/wt/o2']);
  });

  it('NOT the volume owner (box A, stale copy): removes only the LOCAL copy — never nulls the DB path, never stops the container, never calls removeWorktree on the mirror', async () => {
    wsMock().isWorkspaceVolumeOwner.mockReturnValue(false);
    mockFsAccess.mockResolvedValue(undefined); // a stale copy of the dir exists here
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-real', '/wt/s-real')]);
    const n = await reapIdleWorktrees();
    expect(n).toBe(1);
    expect(mockFsRm).toHaveBeenCalledWith('/wt/s-real', { recursive: true, force: true });
    expect(prismaMock().chatCodingState.update).not.toHaveBeenCalled();           // the shared row is the owner's
    expect(containerMock().stopSessionContainer).not.toHaveBeenCalled();           // DOCKER_HOST here points at the owner's daemon
    expect(wsMock().removeWorktree).not.toHaveBeenCalled();
    const rows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'worktree_reaped');
    expect(rows[0][0].meta).toMatchObject({ volumeOwner: false, dbNulled: false });
  });

  it('NOT the volume owner and nothing local to free: not a reap (no metric, no DB write)', async () => {
    wsMock().isWorkspaceVolumeOwner.mockReturnValue(false);
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-elsewhere', '/wt/s-elsewhere')]);
    expect(await reapIdleWorktrees()).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
    expect(prismaMock().chatCodingState.update).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('the volume owner skips a null-path row whose dir vanished since the census (no phantom reap)', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-gone', mtimeMs: oldMtime }]);
    prismaMock().chatCodingState.findMany
      .mockResolvedValueOnce([row('s-gone', null)])
      .mockResolvedValueOnce([{ id: 's-gone' }]);
    expect(await reapIdleWorktrees()).toBe(0);
    expect(prismaMock().chatCodingState.update).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('pruneReinstallableArtifacts gets the same census widening (null-path dirs held 76 GB of node_modules)', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-nm', mtimeMs: oldMtime }]);
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([]);
    await pruneReinstallableArtifacts();
    const where = prismaMock().chatCodingState.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ worktreePath: { not: null } }, { id: { in: ['s-nm'] } }]);
  });
});

// ── Ticket 09d84d7d: dir-mtime co-signal + cache dirs + scheduled-lane exemption ──
// Box A hit 99% with ~110 GB of worktrees the updatedAt-only bar could never
// touch: housekeeping writers (idle-chat-archiver batches, provisioning
// ready-flips after each mass reap, orphan sweeps) bump updatedAt fleet-wide
// without touching the worktree — only 41 of 149 ancient dirs were eligible
// even at a 6h bar. The on-disk dir mtime carries the worktree's true age.
describe('pruneReinstallableArtifacts dir-mtime co-signal (ticket 09d84d7d)', () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const wsMock2 = () => jest.requireMock('./workspace.service');
  const prismaMock2 = () => jest.requireMock('../../../config/database').default;
  const dirent = (name: string) => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
  const rowAt = (id: string, ageMs: number) => ({ id, updatedAt: new Date(Date.now() - ageMs) });

  beforeEach(() => {
    mockFsRm.mockClear();
    mockFsAccess.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFsReaddir.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    prismaMock2().chatCodingState.findMany.mockReset().mockResolvedValue([]);
    prismaMock2().chatSchedule.findMany.mockReset().mockResolvedValue([]);
    prismaMock2().agentRun.findMany.mockReset().mockResolvedValue([]);
    wsMock2().listWorktreeDirsOnDisk.mockReset().mockResolvedValue([]);
  });

  it('starvation regression: a housekeeping-fresh row (updatedAt inside the bar) whose dir is ancient IS pruned', async () => {
    // 12h-old row under a 24h bar: the updatedAt-only rule skipped it (the
    // 09d84d7d starvation cohort); the ancient dir mtime condemns it now.
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-starved', mtimeMs: Date.now() - 30 * DAY }]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-starved', 12 * HOUR)]);
    mockFsAccess.mockResolvedValue(undefined); // /wt/s-starved exists
    mockFsReaddir.mockImplementation(async (p: string) =>
      (p === '/wt/s-starved' ? [dirent('node_modules'), dirent('.git'), dirent('src')] : []) as any);
    const n = await pruneReinstallableArtifacts({ idleMs: DAY });
    expect(n).toBe(1);
    expect(mockFsRm).toHaveBeenCalledWith('/wt/s-starved/node_modules', { recursive: true, force: true });
    expect(mockFsRm).not.toHaveBeenCalledWith('/wt/s-starved/src', expect.anything());
    expect(mockFsRm).not.toHaveBeenCalledWith('/wt/s-starved/.git', expect.anything());
  });

  it('never prunes tmp/ — it holds the user\'s own scratch output, not an install artifact (review of #1768)', async () => {
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-tmp', mtimeMs: Date.now() - 30 * DAY }]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-tmp', 30 * DAY)]);
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReaddir.mockImplementation(async (p: string) =>
      (p === '/wt/s-tmp' ? [dirent('node_modules'), dirent('tmp')] : []) as any);
    await pruneReinstallableArtifacts({ idleMs: DAY });
    expect(mockFsRm).toHaveBeenCalledWith('/wt/s-tmp/node_modules', { recursive: true, force: true });
    expect(mockFsRm).not.toHaveBeenCalledWith('/wt/s-tmp/tmp', expect.anything());
  });

  it('a row idle past the floor whose dir churned recently is NOT pruned (quiet-but-alive lane)', async () => {
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-alive', mtimeMs: Date.now() - 1 * HOUR }]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-alive', 12 * HOUR)]);
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([dirent('node_modules')] as any);
    const n = await pruneReinstallableArtifacts({ idleMs: DAY });
    expect(n).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('the candidate query floors row freshness at 6h (a hot lane never reaches the JS filter)', async () => {
    await pruneReinstallableArtifacts({ idleMs: DAY });
    const where = prismaMock2().chatCodingState.findMany.mock.calls[0][0].where;
    const ltMs = new Date(where.updatedAt.lt).getTime();
    expect(Date.now() - ltMs).toBeGreaterThanOrEqual(6 * HOUR - 5000);
    expect(Date.now() - ltMs).toBeLessThan(6 * HOUR + 60 * 1000);
  });

  it('.npm and .cache (sandbox-HOME caches, ~0.5 GB/worktree on box A) are reinstallable', async () => {
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-cache', 30 * DAY)]);
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReaddir.mockImplementation(async (p: string) =>
      (p === '/wt/s-cache' ? [dirent('.npm'), dirent('.cache'), dirent('memory-bank')] : []) as any);
    const n = await pruneReinstallableArtifacts();
    expect(n).toBe(1);
    expect(mockFsRm).toHaveBeenCalledWith('/wt/s-cache/.npm', { recursive: true, force: true });
    expect(mockFsRm).toHaveBeenCalledWith('/wt/s-cache/.cache', { recursive: true, force: true });
    expect(mockFsRm).not.toHaveBeenCalledWith('/wt/s-cache/memory-bank', expect.anything());
  });

  it('exemptScheduled: an enabled schedule exempts the lane even with an ancient dir; lookup failure skips the batch', async () => {
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([
      { sessionId: 's-sched', mtimeMs: Date.now() - 30 * DAY },
      { sessionId: 's-idle', mtimeMs: Date.now() - 30 * DAY },
    ]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-sched', 12 * HOUR), rowAt('s-idle', 12 * HOUR)]);
    prismaMock2().chatSchedule.findMany.mockResolvedValueOnce([{ sessionId: 's-sched' }]);
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([dirent('node_modules')] as any);
    const n = await pruneReinstallableArtifacts({ idleMs: DAY, exemptScheduled: true });
    expect(n).toBe(1);
    expect(mockFsRm).toHaveBeenCalledWith('/wt/s-idle/node_modules', { recursive: true, force: true });
    expect(mockFsRm).not.toHaveBeenCalledWith('/wt/s-sched/node_modules', expect.anything());

    // fail-safe: schedule-lookup error → whole batch skipped, nothing removed
    mockFsRm.mockClear();
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-x', mtimeMs: Date.now() - 30 * DAY }]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-x', 12 * HOUR)]);
    prismaMock2().chatSchedule.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(pruneReinstallableArtifacts({ idleMs: DAY, exemptScheduled: true })).resolves.toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('a live or queued run is never pruned', async () => {
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([
      { sessionId: 's-starved', mtimeMs: Date.now() - 30 * DAY },
    ]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-starved', 12 * HOUR)]);
    prismaMock2().agentRun.findMany.mockResolvedValueOnce([{ sessionId: 's-starved' }]);
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([dirent('node_modules')] as any);
    const n = await pruneReinstallableArtifacts({ idleMs: DAY });
    expect(n).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('a live-run lookup error skips the batch (fail closed)', async () => {
    wsMock2().listWorktreeDirsOnDisk.mockResolvedValue([
      { sessionId: 's-starved', mtimeMs: Date.now() - 30 * DAY },
    ]);
    prismaMock2().chatCodingState.findMany.mockResolvedValueOnce([rowAt('s-starved', 12 * HOUR)]);
    prismaMock2().agentRun.findMany.mockRejectedValueOnce(new Error('db down'));
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([dirent('node_modules')] as any);
    await expect(pruneReinstallableArtifacts({ idleMs: DAY })).resolves.toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });
});

describe('worktree disk-adaptive idle selection (2026-10-18)', () => {
  const DAY = 24 * 3600 * 1000;
  const HOUR = 3600 * 1000;

  afterEach(() => {
    delete process.env.WORKTREE_DISK_ADAPTIVE_DISABLED;
    delete process.env.WORKTREE_REAP_INTERVAL_SEC;
  });

  it('shouldPruneWorktreeArtifacts: a live run or an enabled schedule is never pruned', () => {
    const cutoff = Date.now();
    const ancient = cutoff - 30 * DAY;
    expect(shouldPruneWorktreeArtifacts({
      updatedAt: ancient, mtimeMs: ancient, cutoff, hasLiveRun: true, scheduled: false,
    })).toBe(false);
    expect(shouldPruneWorktreeArtifacts({
      updatedAt: ancient, mtimeMs: ancient, cutoff, hasLiveRun: false, scheduled: true,
    })).toBe(false);
  });

  it('shouldPruneWorktreeArtifacts: idle when the row or the dir is older than the cutoff', () => {
    const cutoff = 1_000_000;
    expect(shouldPruneWorktreeArtifacts({
      updatedAt: cutoff - 1, mtimeMs: null, cutoff, hasLiveRun: false, scheduled: false,
    })).toBe(true);
    expect(shouldPruneWorktreeArtifacts({
      updatedAt: cutoff + 1, mtimeMs: cutoff - 1, cutoff, hasLiveRun: false, scheduled: false,
    })).toBe(true);
    expect(shouldPruneWorktreeArtifacts({
      updatedAt: cutoff + 1, mtimeMs: null, cutoff, hasLiveRun: false, scheduled: false,
    })).toBe(false);
  });

  it('reapIdleMsForUsage shortens with volume usage; the kill switch stays at 7d', () => {
    expect(reapIdleMsForUsage(null)).toBe(7 * DAY);
    expect(reapIdleMsForUsage(0.59)).toBe(7 * DAY);
    expect(reapIdleMsForUsage(0.60)).toBe(3 * DAY);
    expect(reapIdleMsForUsage(0.69)).toBe(3 * DAY);
    expect(reapIdleMsForUsage(0.70)).toBe(48 * HOUR);
    expect(reapIdleMsForUsage(0.95)).toBe(48 * HOUR);
    process.env.WORKTREE_DISK_ADAPTIVE_DISABLED = '1';
    expect(reapIdleMsForUsage(0.95)).toBe(7 * DAY);
  });

  it('worktreeReapIntervalSec defaults to 1h, honours a floor, and the kill switch restores 6h', () => {
    expect(worktreeReapIntervalSec()).toBe(3600);
    process.env.WORKTREE_REAP_INTERVAL_SEC = '900';
    expect(worktreeReapIntervalSec()).toBe(900);
    process.env.WORKTREE_REAP_INTERVAL_SEC = '30';
    expect(worktreeReapIntervalSec()).toBe(3600);
    process.env.WORKTREE_DISK_ADAPTIVE_DISABLED = '1';
    expect(worktreeReapIntervalSec()).toBe(21600);
  });
});

/**
 * FO f121-hook (2026-10-12): configureWorkspace same-target githubLabel re-pin.
 * The crossmodel supervisor's 08:38Z re-pin (githubLabel=pastapaul_canadaquant)
 * hit the idempotent early-return and wrote NOTHING — "provisioned" reported,
 * the row kept the dead label, git_push kept refusing fleet-wide. The re-pin is
 * the only lane-side remedy after a connector reconnect re-creates token rows
 * under new labels (getValidToken(userId, project.githubLabel) hard-misses).
 */
describe('configureWorkspace — same-target githubLabel re-pin (FO f121-hook)', () => {
  const prismaMock3 = () => jest.requireMock('../../../config/database').default;
  const configured = (githubLabel: string | null) => ({
    id: 'proj-1', userId: 'u-1', repoProvider: 'github',
    repoUrl: 'https://github.com/org/repo.git', defaultBranch: 'main',
    githubLabel, workspaceAt: new Date(),
  });

  beforeEach(() => {
    prismaMock3().crossModelProject.findFirst.mockReset();
    prismaMock3().crossModelProject.findUnique.mockReset();
    prismaMock3().crossModelProject.update.mockReset().mockResolvedValue({});
    (logger.info as jest.Mock).mockClear();
  });

  it('same target + NEW githubLabel → the label is WRITTEN (the swallowed re-pin)', async () => {
    prismaMock3().crossModelProject.findFirst.mockResolvedValue(configured('dead-label'));
    prismaMock3().crossModelProject.findUnique.mockResolvedValue(configured('pastapaul_canadaquant'));
    const ws = await configureWorkspace('proj-1', 'u-1', {
      repoUrl: 'https://github.com/org/repo.git', provider: 'github', githubLabel: 'pastapaul_canadaquant',
    });
    expect(prismaMock3().crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' }, data: { githubLabel: 'pastapaul_canadaquant' },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('pastapaul_canadaquant'));
    expect(ws.provider).toBe('github');
  });

  it('label-ONLY call (no repoUrl/provider/defaultBranch) re-pins — no false 409', async () => {
    prismaMock3().crossModelProject.findFirst.mockResolvedValue(configured('dead-label'));
    prismaMock3().crossModelProject.findUnique.mockResolvedValue(configured('Pastapaul'));
    await configureWorkspace('proj-1', 'u-1', { githubLabel: 'Pastapaul' });
    expect(prismaMock3().crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' }, data: { githubLabel: 'Pastapaul' },
    });
  });

  it('same target + SAME label → idempotent, no write', async () => {
    prismaMock3().crossModelProject.findFirst.mockResolvedValue(configured('work'));
    prismaMock3().crossModelProject.findUnique.mockResolvedValue(configured('work'));
    await configureWorkspace('proj-1', 'u-1', {
      repoUrl: 'https://github.com/org/repo.git', provider: 'github', githubLabel: 'work',
    });
    expect(prismaMock3().crossModelProject.update).not.toHaveBeenCalled();
  });

  it('same target + ABSENT label (call sites coerce to null) → never CLEARS the stored label', async () => {
    prismaMock3().crossModelProject.findFirst.mockResolvedValue(configured('work'));
    prismaMock3().crossModelProject.findUnique.mockResolvedValue(configured('work'));
    await configureWorkspace('proj-1', 'u-1', {
      repoUrl: 'https://github.com/org/repo.git', provider: 'github', githubLabel: null,
    });
    expect(prismaMock3().crossModelProject.update).not.toHaveBeenCalled();
  });

  it('a DIFFERENT target still 409s — and the label is not written', async () => {
    prismaMock3().crossModelProject.findFirst.mockResolvedValue(configured('work'));
    await expect(configureWorkspace('proj-1', 'u-1', {
      repoUrl: 'https://github.com/org/other.git', provider: 'github', githubLabel: 'pastapaul_canadaquant',
    })).rejects.toMatchObject({ status: 409 });
    expect(prismaMock3().crossModelProject.update).not.toHaveBeenCalled();
  });
});

/**
 * Ticket 23f453de (2026-10-13): a configure_workspace re-pin on an EXISTING
 * github-backed project returned a bare "Project not found" for ~1h of
 * owner-facing downtime because the message named neither the id it looked up
 * nor any recovery — the caller could not tell an abbreviated id from a
 * missing project. The 404 must name the id (the same never-a-bare-not-found
 * convention start_coding_session pinned) and say what reference forms work.
 */
describe('configureWorkspace — the 404 names the id (ticket 23f453de)', () => {
  const prismaMock4 = () => jest.requireMock('../../../config/database').default;

  beforeEach(() => {
    prismaMock4().crossModelProject.findFirst.mockReset();
    prismaMock4().crossModelProject.findUnique.mockReset();
    prismaMock4().crossModelProject.update.mockReset().mockResolvedValue({});
  });

  it('no owner-scoped match → 404 NAMES the projectId and the recovery, never a bare "Project not found"', async () => {
    prismaMock4().crossModelProject.findFirst.mockResolvedValue(null);
    await expect(configureWorkspace('887dcccb-abbr', 'u-1', { githubLabel: 'pastapaul_canadaquant' }))
      .rejects.toMatchObject({
        status: 404,
        message: expect.stringMatching(/Project not found \(projectId: "887dcccb-abbr"\)/),
      });
    await expect(configureWorkspace('887dcccb-abbr', 'u-1', { githubLabel: 'pastapaul_canadaquant' }))
      .rejects.toMatchObject({ message: expect.stringMatching(/never reconstruct or abbreviate/i) });
  });

  it('a project owned by ANOTHER user is the same named 404 — never a bare message and never a write', async () => {
    // findFirst({ id, userId }) returns null when the project exists but the
    // caller is not the owner — the misleading case the ticket describes.
    prismaMock4().crossModelProject.findFirst.mockResolvedValue(null);
    await expect(configureWorkspace('proj-visible-not-owned', 'u-1', {}))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('proj-visible-not-owned') });
    expect(prismaMock4().crossModelProject.update).not.toHaveBeenCalled();
  });
});

describe('reaper per-session live re-check + kept-dir counts (2026-10-20)', () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const wsMock = () => jest.requireMock('./workspace.service');
  const prismaMock = () => jest.requireMock('../../../config/database').default;
  const row = (id: string) => ({
    id, projectId: 'p1', status: 'ready', worktreePath: `/wt/${id}`, updatedAt: new Date('2026-08-01T00:00:00Z'),
    project: { id: 'p1', repoProvider: 'github' },
  });
  const dirent = (name: string) => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
  const stats = (): ReapPassStats => ({ keptUnknown: 0, keptUnsaved: 0, keptLive: 0 });
  const prevKs = process.env.WORKTREE_REAP_LIVE_RECHECK_DISABLED;

  beforeEach(() => {
    mockRecordLoopMetric.mockClear();
    mockFsRm.mockClear();
    mockProcessSnapshot.mockReset().mockReturnValue([]);
    mockFsAccess.mockReset().mockResolvedValue(undefined);
    mockFsReaddir.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    prismaMock().chatCodingState.findMany.mockReset().mockResolvedValue([]);
    prismaMock().chatCodingState.update.mockReset().mockResolvedValue({});
    prismaMock().chatSchedule.findMany.mockReset().mockResolvedValue([]);
    prismaMock().agentRun.findMany.mockReset().mockResolvedValue([]);
    wsMock().listWorktreeDirsOnDisk.mockReset().mockResolvedValue([]);
    wsMock().isWorkspaceVolumeOwner.mockReset().mockReturnValue(true);
    wsMock().removeWorktree.mockClear();
    wsMock().git.mockReset().mockImplementation(async () => ({ stdout: '', stderr: '' }));
  });
  afterEach(() => {
    if (prevKs === undefined) delete process.env.WORKTREE_REAP_LIVE_RECHECK_DISABLED;
    else process.env.WORKTREE_REAP_LIVE_RECHECK_DISABLED = prevKs;
  });

  it('sessionBusyForReap: live run, running bg process, lookup error (fail closed), idle', async () => {
    prismaMock().agentRun.findMany.mockResolvedValueOnce([{ sessionId: 's1' }]);
    expect(await sessionBusyForReap('s1')).toBe('live_run');
    mockProcessSnapshot.mockReturnValueOnce([{ handle: 'p1', status: 'running' }]);
    expect(await sessionBusyForReap('s1')).toBe('bg_process');
    prismaMock().agentRun.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await sessionBusyForReap('s1')).toBe('unknown');
    mockProcessSnapshot.mockReturnValueOnce([{ handle: 'p1', status: 'exited' }]);
    expect(await sessionBusyForReap('s1')).toBe('idle');
    const q = prismaMock().agentRun.findMany.mock.calls.at(-1)[0];
    expect(q.where).toEqual({ sessionId: 's1', status: { in: ['queued', 'running'] } });
  });

  it('a run queued AFTER the candidate query keeps the worktree (no WIP commit, no delete) and counts keptLive', async () => {
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-mid')]);
    prismaMock().agentRun.findMany.mockResolvedValueOnce([{ sessionId: 's-mid' }]);
    const st = stats();
    expect(await reapIdleWorktrees({ stats: st })).toBe(0);
    expect(wsMock().removeWorktree).not.toHaveBeenCalled();
    expect(wsMock().git).not.toHaveBeenCalled();
    expect(prismaMock().chatCodingState.update).not.toHaveBeenCalled();
    expect(st.keptLive).toBe(1);
  });

  it('a live-run lookup error keeps the worktree (fail closed)', async () => {
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-err')]);
    prismaMock().agentRun.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await reapIdleWorktrees()).toBe(0);
    expect(wsMock().removeWorktree).not.toHaveBeenCalled();
  });

  it('a still-running background process keeps the worktree', async () => {
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-bg')]);
    mockProcessSnapshot.mockImplementation((id: string) => (id === 's-bg' ? [{ handle: 'dev', status: 'running' }] : []));
    expect(await reapIdleWorktrees()).toBe(0);
    expect(wsMock().removeWorktree).not.toHaveBeenCalled();
  });

  it('WORKTREE_REAP_LIVE_RECHECK_DISABLED=1 restores the batch-only behaviour', async () => {
    process.env.WORKTREE_REAP_LIVE_RECHECK_DISABLED = '1';
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-ks')]);
    mockProcessSnapshot.mockReturnValue([{ handle: 'dev', status: 'running' }]);
    expect(await reapIdleWorktrees()).toBe(1);
    expect(prismaMock().agentRun.findMany).not.toHaveBeenCalled();
  });

  it('kept-unknown and kept-unsaved dirs are counted, never deleted', async () => {
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-unk'), row('s-dirty')]);
    wsMock().git.mockImplementation(async (args: string[], wt: string) => {
      if (wt === '/wt/s-unk') throw new Error('not a git repository');
      if (args.includes('status')) return { stdout: ' M a.ts\n', stderr: '' };
      if (args.includes('commit')) throw new Error('commit failed');
      return { stdout: '', stderr: '' };
    });
    const st = stats();
    expect(await reapIdleWorktrees({ stats: st })).toBe(0);
    expect(st).toEqual({ keptUnknown: 1, keptUnsaved: 1, keptLive: 0 });
    expect(wsMock().removeWorktree).not.toHaveBeenCalled();
  });

  it('artifact prune re-checks THIS session right before deleting (run queued after the batch lookup)', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-p', mtimeMs: Date.now() - 30 * DAY }]);
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([{ id: 's-p', updatedAt: new Date(Date.now() - 12 * HOUR) }]);
    prismaMock().agentRun.findMany
      .mockResolvedValueOnce([])                       // batch lookup: idle
      .mockResolvedValueOnce([{ sessionId: 's-p' }]);  // per-session re-check: a run landed
    mockFsReaddir.mockResolvedValue([dirent('node_modules')] as any);
    const st = stats();
    expect(await pruneReinstallableArtifacts({ idleMs: DAY, stats: st })).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
    expect(st.keptLive).toBe(1);
  });

  it('artifact prune skips a session whose dev server is still running from its worktree', async () => {
    wsMock().listWorktreeDirsOnDisk.mockResolvedValue([{ sessionId: 's-dev', mtimeMs: Date.now() - 30 * DAY }]);
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([{ id: 's-dev', updatedAt: new Date(Date.now() - 12 * HOUR) }]);
    mockProcessSnapshot.mockReturnValue([{ handle: 'next', status: 'running' }]);
    mockFsReaddir.mockResolvedValue([dirent('node_modules')] as any);
    expect(await pruneReinstallableArtifacts({ idleMs: DAY })).toBe(0);
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it('the pass row carries keptUnknown / keptUnsaved / keptLive', async () => {
    prismaMock().chatCodingState.findMany.mockResolvedValueOnce([row('s-unk')]);
    wsMock().git.mockImplementation(async () => { throw new Error('not a git repository'); });
    await runWorktreeReapOnce();
    const pass = mockRecordLoopMetric.mock.calls.find((c) => c[0]?.kind === 'worktree_reap_pass');
    expect(pass).toBeTruthy();
    expect(pass![0].meta).toEqual(expect.objectContaining({ keptUnknown: 1, keptUnsaved: 0, keptLive: 0 }));
  });
});

