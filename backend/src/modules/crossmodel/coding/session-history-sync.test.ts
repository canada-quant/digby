/**
 * Session history sync (durable cron): deterministic HISTORY.md per session →
 * git plumbing in the bare mirror → push to origin. Default mode (owner
 * 2026-09-14) = ONE consolidated branch per repo (digby/session-history,
 * sessions/<id>/HISTORY.md) with pruning + legacy-branch migration. The
 * single-branch mode is UNCONDITIONAL: the old
 * SESSION_HISTORY_SINGLE_BRANCH_DISABLED escape hatch was deleted on
 * 2026-11-04 (cluster 42 — it was NF_INERT, never forwarded by any build).
 * The git mock is programmed
 * per-args (an implementation switch), so any unexpected call fails the test.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {
  chatCodingState: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []) },
  crossModelProject: { findMany: jest.fn(async () => []) },
} }));
jest.mock('./workspace.service', () => ({
  __esModule: true,
  git: jest.fn(async () => ({ stdout: '', stderr: '' })),
  repoMirrorPath: jest.fn((id: string) => `/repos/${id}.git`),
  // The real implementation's shape: token → x-access-token URL, no token → unchanged.
  authedUrl: jest.fn((repoUrl: string, token?: string | null) => {
    if (!token) return repoUrl;
    const u = new URL(repoUrl);
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  }),
}));
const mockGetValidToken: jest.Mock = jest.fn(async () => 'TOK');
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn() },
}));

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { git } from './workspace.service';
import { getRecentJournalEntries } from './run-journal.service';
import {
  isMissingRepoError,
  isPermanentPushAuthError,
  runSessionHistorySyncOnce,
  sessionHistoryAuthDisableEnabled,
  sessionHistoryPath,
  __resetSessionHistorySyncForTest,
  SESSION_HISTORY_SYNC_INTERVAL_SEC,
  SESSION_HISTORY_BRANCH,
  SESSION_HISTORY_REF,
  LEGACY_SESSION_HISTORY_PREFIX,
  SESSION_HISTORY_AUTH_DISABLE_ENV,
  SESSION_HISTORY_AUTH_DISABLE_THRESHOLD,
  __pushQuarantineRedisTimeoutMs,
  SESSION_TAKE,
} from './session-history-sync.service';

const stateFindMany = prisma.chatCodingState.findMany as jest.Mock;
const messageFindMany = prisma.crossModelMessage.findMany as jest.Mock;
const projectFindMany = (prisma as any).crossModelProject.findMany as jest.Mock;
const gitMock = git as jest.Mock;
const journalMock = getRecentJournalEntries as jest.Mock;
const loggerWarn = logger.warn as jest.Mock;
const loggerInfo = logger.info as jest.Mock;

const REF = SESSION_HISTORY_REF; // refs/heads/digby/session-history
const LEGACY_REF_PREFIX = `refs/heads/${LEGACY_SESSION_HISTORY_PREFIX}`;
const REF_S1 = `${LEGACY_REF_PREFIX}s1`;
const MIRROR_P1 = '/repos/p1.git';

const SESSION = {
  id: 's1',
  projectId: 'p1',
  userId: 'u1',
  title: 'My session',
  branch: 'digby/session-abc',
  status: 'ready',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  project: { id: 'p1', name: 'Proj', repoProvider: 'github', repoUrl: 'https://github.com/o/r.git', userId: 'owner1' },
};

/** GitHub pushes go to a per-operation authed URL (mirror origins are tokenless). */
const AUTHED = 'https://x-access-token:TOK@github.com/o/r.git';
const MSG_RE = /^history: auto-sync \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A git route: match on the arg vector, respond with stdout text or throw. */
interface GitRoute {
  match: (a: string[]) => boolean;
  respond: (a: string[]) => string;
}

/** Program the git mock per-args; any unrouted call throws (fails the test). */
function programGit(routes: GitRoute[]): void {
  gitMock.mockImplementation(async (args: string[]) => {
    for (const r of routes) {
      if (r.match(args)) return { stdout: r.respond(args), stderr: '' };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

/** The exact arg vectors the mock saw, with temp paths normalized out. */
function gitCalls(): string[][] {
  return gitMock.mock.calls.map(c =>
    (c[0] as string[]).map(a => (a.includes('digby-history-') ? '<tmp>' : a)));
}

/** Routes for the happy consolidated plumbing after hash-object (new or existing tip). */
function plumbingRoutes(over: Partial<Record<string, (a: string[]) => string>> = {}): GitRoute[] {
  return [
    { match: a => a[0] === 'read-tree', respond: over['read-tree'] ?? (() => '') },
    { match: a => a[0] === 'update-index', respond: over['update-index'] ?? (() => '') },
    { match: a => a[0] === 'write-tree', respond: over['write-tree'] ?? (() => 'tree1\n') },
    { match: a => a[0] === 'commit-tree', respond: over['commit-tree'] ?? (() => 'commit1\n') },
    { match: a => a[0] === 'for-each-ref', respond: over['for-each-ref'] ?? (() => '') },
    { match: a => a[0] === 'update-ref', respond: over['update-ref'] ?? (() => '') },
    { match: a => a[0] === 'ls-remote', respond: over['ls-remote'] ?? (() => '') },
    { match: a => a[0] === 'push', respond: over['push'] ?? (() => '') },
  ];
}

const savedAuthDisableEnv = process.env[SESSION_HISTORY_AUTH_DISABLE_ENV];

// ── Fake Redis (ticket b6477bc7): the push quarantine lives in Redis now, so
// the suite programs a Map with TTL semantics — NX-SET claims only absent
// keys, EX expires them, and both reads and writes can be made to throw (the
// fail-open contract). `expireRedisQuarantine` simulates the window elapsing;
// `redisStore` exposes the raw keys for assertions.
const redisSet = redisClient.set as jest.Mock;
const redisGet = redisClient.get as jest.Mock;
const redisDel = redisClient.del as jest.Mock;
const redisIncr = redisClient.incr as jest.Mock;
const redisStore = new Map<string, { value: string; expiresAt: number }>();
let redisOpsDown = false; // every Redis op throws while true (an outage)
let redisPending = false; // ops NEVER settle while true — node-redis does not reject a mid-life outage's commands: the socket stays "open" and every op queues (@redis/client rejects only on a closed socket / disableOfflineQueue, neither of which config/redis.ts sets). Only the per-op timeout can bound this shape.

function resetRedisHarness(): void {
  redisStore.clear();
  redisOpsDown = false;
  redisPending = false;
  redisSet.mockReset();
  redisGet.mockReset();
  redisDel.mockReset();
  redisIncr.mockReset();
  redisSet.mockImplementation(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
    if (redisPending) return new Promise(() => {});
    if (redisOpsDown) throw new Error('Redis is shut down');
    const row = redisStore.get(key);
    if (row && row.expiresAt > Date.now()) {
      if (opts?.NX) return null; // window already claimed — SET NX returns null
      redisStore.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 0) * 1000 });
      return 'OK';
    }
    redisStore.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 0) * 1000 });
    return 'OK';
  });
  redisGet.mockImplementation(async (key: string) => {
    if (redisPending) return new Promise(() => {});
    if (redisOpsDown) throw new Error('Redis is shut down');
    const row = redisStore.get(key);
    // expiresAt < 0 = written TTL-LESS (alive forever, real-Redis no-TTL);
    // 0 = force-expired (the expireRedisQuarantine helper); > now = alive.
    if (!row) return null;
    if (row.expiresAt === 0) return null;
    if (row.expiresAt > 0 && row.expiresAt <= Date.now()) return null;
    return row.value;
  });
  redisDel.mockImplementation(async (...args: unknown[]) => {
    if (redisPending) return new Promise(() => {});
    if (redisOpsDown) throw new Error('Redis is shut down');
    // node-redis v4 del() takes ONE arg — a key or an ARRAY of keys; accept
    // both that and the variadic form.
    const keys = (args as (string | string[])[]).flat() as string[];
    let n = 0;
    for (const k of keys) { if (redisStore.delete(k)) n++; }
    return n;
  });
  redisIncr.mockImplementation(async (key: string) => {
    if (redisPending) return new Promise(() => {});
    if (redisOpsDown) throw new Error('Redis is shut down');
    const row = redisStore.get(key);
    // INCR writes TTL-LESS (real Redis: no TTL) — sentinel expiresAt -1.
    const alive = row && (row.expiresAt < 0 || row.expiresAt > Date.now());
    const next = (alive ? parseInt(row!.value, 10) || 0 : 0) + 1;
    redisStore.set(key, { value: String(next), expiresAt: -1 });
    return next;
  });
}
/** Simulate the quarantine window elapsing (a key expiring server-side). */
const expireRedisQuarantine = (projectId: string) => {
  const row = redisStore.get(`session-history:push-quarantine:${projectId}`);
  if (row) row.expiresAt = 0;
};
/** Simulate the auth-disable RE-PROBE lock's TTL elapsing (24h passed — the
 *  next pass may claim the window and push once). */
const expireAuthReprobe = (projectId: string) => {
  const row = redisStore.get(`session-history:auth-disable:reprobe:${projectId}`);
  if (row) row.expiresAt = 0;
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetSessionHistorySyncForTest();
  stateFindMany.mockResolvedValue([]);
  messageFindMany.mockResolvedValue([]);
  projectFindMany.mockResolvedValue([]);
  journalMock.mockResolvedValue([]);
  gitMock.mockImplementation(async (args: string[]) => {
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  resetRedisHarness();
  // The quarantine is ON by default now (its release kill switch expired
  // 2026-11-12 and was deleted); restore the OTHER switches every test.
  delete process.env[SESSION_HISTORY_AUTH_DISABLE_ENV];
});

afterAll(() => {
  if (savedAuthDisableEnv === undefined) delete process.env[SESSION_HISTORY_AUTH_DISABLE_ENV];
  else process.env[SESSION_HISTORY_AUTH_DISABLE_ENV] = savedAuthDisableEnv;
});

describe('runSessionHistorySyncOnce — shared', () => {
  it('exports the 10-minute cadence, the consolidated branch name and the session path shape', () => {
    expect(SESSION_HISTORY_SYNC_INTERVAL_SEC).toBe(600);
    expect(SESSION_HISTORY_BRANCH).toBe('digby/session-history');
    expect(REF).toBe('refs/heads/digby/session-history');
    expect(LEGACY_SESSION_HISTORY_PREFIX).toBe('digby/session-history/');
    expect(sessionHistoryPath('abc')).toBe('sessions/abc/HISTORY.md');
  });

  it('(a) zero sessions: no git calls, summary says 0, and enumerates LIVE chats only (worktree present, past provisioning, chat not archived)', async () => {
    const summary = await runSessionHistorySyncOnce();
    expect(summary).toBe('synced 0, unchanged 0, failed 0 of 0');
    expect(gitMock).not.toHaveBeenCalled();
    expect(stateFindMany).toHaveBeenCalledWith({
      where: { worktreePath: { not: null }, status: { not: 'provisioning' }, chat: { archivedAt: null } },
      include: { project: true },
      orderBy: { updatedAt: 'asc' },
      take: SESSION_TAKE,
    });
    expect(SESSION_TAKE).toBe(500);
  });

  it('(e) blank/plain-provider sessions are skipped (no mirror, no git calls)', async () => {
    stateFindMany.mockResolvedValue([
      { ...SESSION, id: 'sb', project: { ...SESSION.project, repoProvider: 'blank' } },
      { ...SESSION, id: 'sn', project: { ...SESSION.project, repoProvider: null } },
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 0, unchanged 0, failed 0 of 0, skipped 2');
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('(e2) LOCAL-provider sessions are skipped — their mirror is born origin-less (no push destination); prod 922fd3ad failed its push every 10-min pass pre-fix (FO firing 22)', async () => {
    stateFindMany.mockResolvedValue([
      { ...SESSION, id: 'sl', project: { ...SESSION.project, repoProvider: 'local', repoUrl: '' } },
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 0, unchanged 0, failed 0 of 0, skipped 1');
    expect(gitMock).not.toHaveBeenCalled();
    // and it is never counted "failed" — there is no destination to fail against
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('next pass retries'));
  });

  it('enumeration failure returns a summary (never throws)', async () => {
    stateFindMany.mockRejectedValue(new Error('db down'));
    await expect(runSessionHistorySyncOnce()).resolves.toBe('enumeration failed: db down');
    expect(gitMock).not.toHaveBeenCalled();
  });
});

describe('consolidated single branch (default)', () => {
  it('(b) new branch, two sessions: ONE tree with sessions/<id>/HISTORY.md each, ONE commit, ONE push — legacy migration probes ride along', async () => {
    stateFindMany.mockResolvedValue([SESSION, { ...SESSION, id: 's2' }]);
    journalMock.mockResolvedValue([{
      id: 'j1', runId: 'r1', triggerKind: 'user', goal: 'Build it', outcome: 'Built',
      keyDecisions: ['use plumbing'], failures: [], tokensUsed: 100, createdAt: new Date('2026-09-01T01:00:00Z'),
    }]);
    messageFindMany.mockResolvedValue([
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Please   build\nit' },
    ]);
    let blobs = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify', respond: () => { throw new Error('fatal: Needed a single revision'); } },
      { match: a => a[0] === 'hash-object', respond: () => `blob${++blobs}\n` },
      ...plumbingRoutes(),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 2, unchanged 0, failed 0 of 2');
    expect(gitCalls()).toEqual([
      ['rev-parse', '--verify', REF],
      ['hash-object', '-w', '--no-filters', '<tmp>'],
      ['hash-object', '-w', '--no-filters', '<tmp>'],
      // No parent → empty tree; both sessions land at their tree paths.
      ['read-tree', '--empty'],
      ['update-index', '--add', '--cacheinfo', '100644,blob1,sessions/s1/HISTORY.md'],
      ['update-index', '--add', '--cacheinfo', '100644,blob2,sessions/s2/HISTORY.md'],
      ['write-tree'],
      ['commit-tree', 'tree1', '-m', expect.stringMatching(MSG_RE)],
      // Legacy refs conflict with the consolidated ref (git D/F rule): local
      // ones are cleared BEFORE update-ref, origin ones BEFORE the push.
      ['for-each-ref', '--format=%(refname)', LEGACY_REF_PREFIX],
      ['update-ref', REF, 'commit1', ''],
      ['ls-remote', '--heads', AUTHED, `${LEGACY_REF_PREFIX}*`],
      // GitHub project → per-operation AUTHED url, never the tokenless 'origin'.
      ['push', AUTHED, REF],
    ]);
    expect(mockGetValidToken).toHaveBeenCalledWith('owner1');
    // Every call ran in the bare mirror — the worktree is never touched.
    for (const c of gitMock.mock.calls) expect(c[1]).toBe(MIRROR_P1);
    // Index ops ride a TEMP GIT_INDEX_FILE (never the real index).
    for (const name of ['read-tree', 'update-index', 'write-tree']) {
      const call = gitMock.mock.calls.find(c => (c[0] as string[])[0] === name);
      expect(call?.[3]?.GIT_INDEX_FILE).toEqual(expect.stringContaining('digby-history-'));
    }
    // Remote ops get the 120 s timeout; content sources are the journal + transcript.
    for (const name of ['push', 'ls-remote']) {
      const call = gitMock.mock.calls.find(c => (c[0] as string[])[0] === name);
      expect(call?.[2]).toBe(120_000);
    }
    expect(journalMock).toHaveBeenCalledWith('s1', 6);
    expect(messageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: 's1' }, orderBy: { createdAt: 'desc' }, take: 20,
    }));
  });

  it('(c) every blob unchanged at the branch tip: ONE ls-tree, no commit, no update-ref, no push', async () => {
    stateFindMany.mockResolvedValue([SESSION, { ...SESSION, id: 's2' }]);
    let blobs = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blob1\tsessions/s1/HISTORY.md\n100644 blob blob2\tsessions/s2/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => `blob${++blobs}\n` },
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 0, unchanged 2, failed 0 of 2');
    expect(gitCalls()).toEqual([
      ['rev-parse', '--verify', REF],
      ['ls-tree', '-r', 'tip1'],
      ['hash-object', '-w', '--no-filters', '<tmp>'],
      ['hash-object', '-w', '--no-filters', '<tmp>'],
    ]);
  });

  it('(p) prune: a tree entry for a session that is no longer live is force-removed; unrelated paths + live files stay', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'ls-tree', respond: () =>
        '100644 blob blob1\tsessions/s1/HISTORY.md\n100644 blob blobZ\tsessions/sZ/HISTORY.md\n100644 blob other\tREADME.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      ...plumbingRoutes({ 'write-tree': () => 'tree2\n', 'commit-tree': () => 'commit2\n' }),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 0, unchanged 1, failed 0 of 1, pruned 1');
    expect(gitCalls()).toEqual([
      ['rev-parse', '--verify', REF],
      ['ls-tree', '-r', 'tip1'],
      ['hash-object', '-w', '--no-filters', '<tmp>'],
      ['read-tree', 'tip1^{tree}'],
      ['update-index', '--force-remove', 'sessions/sZ/HISTORY.md'],
      ['write-tree'],
      ['commit-tree', 'tree2', '-p', 'tip1', '-m', expect.stringMatching(MSG_RE)],
      ['for-each-ref', '--format=%(refname)', LEGACY_REF_PREFIX],
      ['update-ref', REF, 'commit2', 'tip1'],
      ['ls-remote', '--heads', AUTHED, `${LEGACY_REF_PREFIX}*`],
      ['push', AUTHED, REF],
    ]);
  });

  it('(p2) a capped enumeration (SESSION_TAKE rows) never prunes — a partial view must not delete live files', async () => {
    const many = Array.from({ length: SESSION_TAKE }, (_, i) => ({ ...SESSION, id: `s${i}` }));
    stateFindMany.mockResolvedValue(many);
    const tree = `${many.map(s => `100644 blob same\tsessions/${s.id}/HISTORY.md`).join('\n')}\n100644 blob blobZ\tsessions/sZ/HISTORY.md\n`;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => tree },
      { match: a => a[0] === 'hash-object', respond: () => 'same\n' },
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe(`synced 0, unchanged ${SESSION_TAKE}, failed 0 of ${SESSION_TAKE}`);
    expect(gitCalls().some(a => a[0] === 'update-index' || a[0] === 'push')).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('pruning skipped'));
  });

  it('(m) migration: legacy per-session refs are deleted locally BEFORE update-ref and on origin BEFORE the push; the consolidated branch itself is never deleted', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify', respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      ...plumbingRoutes({
        'for-each-ref': () => `${LEGACY_REF_PREFIX}old1\n${LEGACY_REF_PREFIX}old2\n`,
        'ls-remote': () => [
          `aaa\t${LEGACY_REF_PREFIX}old1`,
          `bbb\t${LEGACY_REF_PREFIX}old2`,
          `ccc\t${REF}`,                       // the consolidated branch — never a deletion target
          `ddd\t${LEGACY_REF_PREFIX}nested/x`, // not the per-session shape
          '',
        ].join('\n'),
      }),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 1, unchanged 0, failed 0 of 1, legacy deleted 2');
    const calls = gitCalls();
    const idx = (pred: (a: string[]) => boolean) => calls.findIndex(pred);
    const localDeletes = calls.filter(a => a[0] === 'update-ref' && a[1] === '-d');
    expect(localDeletes).toEqual([
      ['update-ref', '-d', `${LEGACY_REF_PREFIX}old1`],
      ['update-ref', '-d', `${LEGACY_REF_PREFIX}old2`],
    ]);
    const consolidatedUpdateRef = idx(a => a[0] === 'update-ref' && a[1] === REF);
    expect(idx(a => a[0] === 'update-ref' && a[1] === '-d')).toBeLessThan(consolidatedUpdateRef);
    const remoteDelete = idx(a => a[0] === 'push' && a[2] === '--delete');
    const consolidatedPush = idx(a => a[0] === 'push' && a[2] === REF);
    expect(remoteDelete).toBeGreaterThan(-1);
    expect(remoteDelete).toBeLessThan(consolidatedPush);
    expect(calls[remoteDelete]).toEqual(['push', AUTHED, '--delete', `${LEGACY_REF_PREFIX}old1`, `${LEGACY_REF_PREFIX}old2`]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deleted 2 of 2 legacy'));

    // Second pass with a changed blob: the repo is remembered as migrated —
    // no for-each-ref, no ls-remote, straight to update-ref + push.
    gitMock.mockClear();
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'commit1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blob1\tsessions/s1/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob2\n' },
      ...plumbingRoutes({ 'commit-tree': () => 'commit2\n' }),
    ]);
    const second = await runSessionHistorySyncOnce();
    expect(second).toBe('synced 1, unchanged 0, failed 0 of 1');
    expect(gitCalls().some(a => a[0] === 'for-each-ref' || a[0] === 'ls-remote')).toBe(false);
    expect(gitCalls()).toContainEqual(['update-ref', REF, 'commit2', 'commit1']);
  });

  it('(m2) origin legacy deletion is BATCHED (25 per push) and a failed batch keeps the repo un-memoized so the next pass retries', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    const legacy = Array.from({ length: 30 }, (_, i) => `${LEGACY_REF_PREFIX}old${i}`);
    let deleteBatches = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify', respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      ...plumbingRoutes({
        'ls-remote': () => legacy.map((r, i) => `sha${i}\t${r}`).join('\n'),
        push: a => {
          if (a[2] === '--delete') {
            deleteBatches++;
            if (deleteBatches === 2) throw new Error('remote: permission denied'); // the 5-ref tail batch fails
          }
          return '';
        },
      }),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 1, unchanged 0, failed 0 of 1, legacy deleted 25');
    const deletes = gitCalls().filter(a => a[0] === 'push' && a[2] === '--delete');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toHaveLength(3 + 25);
    expect(deletes[1]).toHaveLength(3 + 5);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('deleting 5 legacy branch(es) on origin failed'));
    // The consolidated push still went out (best-effort migration never blocks the sync).
    expect(gitCalls()).toContainEqual(['push', AUTHED, REF]);

    // Next committing pass re-probes origin (not memoized after a failed batch).
    gitMock.mockClear();
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'commit1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blob1\tsessions/s1/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob2\n' },
      ...plumbingRoutes(),
    ]);
    await runSessionHistorySyncOnce();
    expect(gitCalls().some(a => a[0] === 'ls-remote')).toBe(true);
  });

  it('(d) push rejected once: fetch + rebuild the SAME updates on the remote tip + update-ref + exactly one retry', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    let pushAttempts = 0;
    let commits = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === 'FETCH_HEAD', respond: () => 'remote1\n' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => '' },
      ...plumbingRoutes({
        'commit-tree': () => `commit${++commits}\n`,
        push: a => {
          if (a[2] === REF) {
            pushAttempts++;
            if (pushAttempts === 1) throw new Error('! [rejected] non-fast-forward (fetch first)');
          }
          return '';
        },
      }),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 1, unchanged 0, failed 0 of 1');
    expect(pushAttempts).toBe(2);
    expect(gitCalls().filter(a => a[0] === 'fetch')).toEqual([['fetch', AUTHED, REF]]);
    // The rebuild used the remote tip as parent and re-applied the same blob;
    // the ref move is guarded on OUR first-attempt commit.
    const commitCalls = gitCalls().filter(a => a[0] === 'commit-tree');
    expect(commitCalls).toHaveLength(2);
    expect(commitCalls[1].slice(0, 4)).toEqual(['commit-tree', 'tree1', '-p', 'remote1']);
    expect(gitCalls().filter(a => a[0] === 'read-tree')).toEqual([['read-tree', '--empty'], ['read-tree', 'remote1^{tree}']]);
    expect(gitCalls().filter(a => a[0] === 'update-index')).toEqual([
      ['update-index', '--add', '--cacheinfo', '100644,blob1,sessions/s1/HISTORY.md'],
      ['update-index', '--add', '--cacheinfo', '100644,blob1,sessions/s1/HISTORY.md'],
    ]);
    expect(gitCalls().filter(a => a[0] === 'update-ref')).toEqual([
      ['update-ref', REF, 'commit1', ''],
      ['update-ref', REF, 'commit2', 'commit1'],
    ]);
  });

  it('(d2) push rejected twice: the local ref is ROLLED BACK to the previous tip (so the next pass retries instead of reading "unchanged"), the changed session counts failed, the sweep does not throw', async () => {
    stateFindMany.mockResolvedValue([SESSION, { ...SESSION, id: 's2' }]);
    let blobs = 0;
    let commits = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === 'FETCH_HEAD', respond: () => 'remote1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blob0\tsessions/s1/HISTORY.md\n100644 blob blob2\tsessions/s2/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => `blob${++blobs}\n` }, // s1 → blob1 (changed), s2 → blob2 (unchanged)
      { match: a => a[0] === 'fetch', respond: () => '' },
      ...plumbingRoutes({
        'commit-tree': () => `commit${++commits}\n`,
        push: a => { if (a[2] === REF) throw new Error('! [rejected] non-fast-forward'); return ''; },
      }),
    ]);

    const summary = await runSessionHistorySyncOnce(); // must resolve, not throw

    expect(summary).toBe('synced 0, unchanged 1, failed 1 of 2');
    expect(gitCalls().filter(a => a[0] === 'push' && a[2] === REF)).toHaveLength(2); // first + ONE retry
    expect(gitCalls().filter(a => a[0] === 'update-ref')).toEqual([
      ['update-ref', REF, 'commit1', 'tip1'],
      ['update-ref', REF, 'commit2', 'commit1'],
      ['update-ref', REF, 'tip1', 'commit2'], // rollback to what origin holds
    ]);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('project p1 failed'));
  });

  it('(d3) a brand-new branch whose pushes both fail is deleted locally again (rollback of a root commit)', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === 'FETCH_HEAD', respond: () => { throw new Error('nothing fetched'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error('auth failed'); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error('auth failed'); return ''; } }),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 0, unchanged 0, failed 1 of 1');
    expect(gitCalls().filter(a => a[0] === 'update-ref')).toEqual([
      ['update-ref', REF, 'commit1', ''],
      ['update-ref', '-d', REF, 'commit1'],
    ]);
  });

  // ── (q) TERMINAL AUTH REFUSAL → quarantine (FO firing 106, 2026-10-09) ──
  // Prod: project 52ad1f73 pushed to octocat/Hello-World — "No anonymous
  // write access" / "Authentication failed" — and the sweep logged "next
  // pass retries" every 10 minutes for 2+ days (89 rows/7d). The refusal is
  // PERMANENT: quarantine the repo, warn ONCE, skip until the retry window.
  it('(q) a terminal auth refusal quarantines the repo: one warn, sessions counted push denied (not failed), the next pass SKIPS the repo entirely', async () => {
    stateFindMany.mockResolvedValue([SESSION, { ...SESSION, id: 's2' }]);
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === 'FETCH_HEAD', respond: () => { throw new Error('nothing fetched'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error('remote: No anonymous write access.'); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error('remote: No anonymous write access.\nfatal: Authentication failed for \'https://github.com/octocat/Hello-World.git/\''); return ''; } }),
    ]);

    const first = await runSessionHistorySyncOnce();
    // Not "failed 2 of 2": the sessions were not lost, the push destination refuses writes.
    expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 2');
    // ONE terminal warn for the repo, not one per session and not per pass:
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('project p1'));
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('next pass retries'));
    // Rollback of a root commit still happened (same as (d3) — the local ref
    // must never hold an unpushed commit).
    expect(gitCalls().filter(a => a[0] === 'update-ref')).toEqual([
      ['update-ref', REF, 'commit1', ''],
      ['update-ref', '-d', REF, 'commit1'],
    ]);

    // SECOND pass: quarantined — no git traffic toward the repo at all.
    const warnCallsBefore = loggerWarn.mock.calls.length;
    const gitCallsAfterFirst = gitCalls().length;
    const second = await runSessionHistorySyncOnce();
    expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 2');
    expect(gitCalls().length).toBe(gitCallsAfterFirst); // the whole repo was skipped pre-mirror
    expect(loggerWarn.mock.calls.length).toBe(warnCallsBefore); // no repeat warn
  });

  it('(q2) an EXPIRED quarantine window re-attempts once (a fixed credential or re-pointed project deserves one fresh push)', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    const authFail = 'remote: No anonymous write access.';
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error(authFail); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error(authFail); return ''; } }),
    ]);
    await runSessionHistorySyncOnce(); // quarantines

    // The window is Redis-TTL'd now (ticket b6477bc7): simulate the key
    // expiring server-side instead of aging the process clock.
    expireRedisQuarantine('p1');
    const second = await runSessionHistorySyncOnce();
    // The window expired → one fresh attempt → it fails again (still
    // auth-refused) → re-quarantined with a NEW warn for the new window.
    expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    // 2 pushes per failing pass (first + the fetch-path retry): 2 in the
    // quarantining pass + 2 in this fresh-attempt pass.
    expect(gitCalls().filter(a => a[0] === 'push')).toHaveLength(4);
    expect(loggerWarn).toHaveBeenCalledTimes(2); // first window + fresh window
    // The new window was re-claimed with the full TTL (not a lingering key).
    const row = redisStore.get('session-history:push-quarantine:p1');
    expect(row && row.expiresAt).toBeGreaterThan(Date.now());
  });

  it('(q3) after the window, a landed push CLEARS the quarantine (a fixed credential works again — a later failure starts a FRESH window)', async () => {
    // Pass 1: quarantine the repo.
    stateFindMany.mockResolvedValue([SESSION]);
    let pushes = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error('remote: No anonymous write access.'); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) { pushes++; throw new Error('remote: No anonymous write access.'); } return ''; } }),
    ]);
    await runSessionHistorySyncOnce();
    expect(pushes).toBe(2); // first + the fetch-path retry, then quarantined

    // Pass 2 (still inside the window): skipped entirely — no push attempted.
    await runSessionHistorySyncOnce();
    expect(pushes).toBe(2);

    // Age past the window (the Redis key expiring): the next pass is the ONE
    // fresh attempt, and the token is fixed — the push lands and the
    // quarantine is forgotten.
    expireRedisQuarantine('p1');
    const commits = { n: 0 };
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      ...plumbingRoutes({
        'commit-tree': () => `commit${++commits.n}\n`,
        push: a => { if (a[2] === REF) { pushes++; return ''; } return ''; },
      }),
    ]);
    const third = await runSessionHistorySyncOnce();
    expect(third).toBe('synced 1, unchanged 0, failed 0 of 1');
    expect(pushes).toBe(3); // + the one successful push
    // The landed push cleared the Redis key (no quarantine residue).
    expect(redisStore.has('session-history:push-quarantine:p1')).toBe(false);

    // Pass 4 (real clock, no aging — a lingering quarantine would print
    // "push denied" instead of syncing): the repo is back on the normal
    // unchanged path, proving no quarantine residue.
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'commit1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blob1\tsessions/s1/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
    ]);
    const fourth = await runSessionHistorySyncOnce();
    expect(fourth).toBe('synced 0, unchanged 1, failed 0 of 1');
  });

  it('(q5) a TRANSIENT push failure (non-fast-forward) is NOT quarantined — the fetch+rebuild+retry path keeps its contract', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    let commits = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === 'FETCH_HEAD', respond: () => 'remote1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => '' },
      ...plumbingRoutes({
        'commit-tree': () => `commit${++commits}\n`,
        push: a => { if (a[2] === REF && commits === 1) throw new Error('! [rejected] non-fast-forward'); return ''; },
      }),
    ]);
    const summary = await runSessionHistorySyncOnce();
    expect(summary).toBe('synced 1, unchanged 0, failed 0 of 1');
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('needed a retry'));
  });

  it('(q6) isPermanentPushAuthError: the terminal auth shapes match; transient shapes do not', () => {
    expect(isPermanentPushAuthError(new Error('remote: No anonymous write access.'))).toBe(true);
    expect(isPermanentPushAuthError(new Error("fatal: Authentication failed for 'https://github.com/octocat/Hello-World.git/'"))).toBe(true);
    expect(isPermanentPushAuthError(new Error("fatal: 'origin' does not appear to be a git repository"))).toBe(true);
    expect(isPermanentPushAuthError(new Error('remote: Repository not found'))).toBe(true);
    expect(isPermanentPushAuthError(new Error('remote: You are not authorized to edit this repo'))).toBe(true);
    expect(isPermanentPushAuthError(new Error('! [rejected] non-fast-forward'))).toBe(false);
    expect(isPermanentPushAuthError(new Error('fatal: unable to access: Failed to connect (timeout)'))).toBe(false);
    expect(isPermanentPushAuthError(new Error('rpc failed; HTTP 502 curl 22'))).toBe(false);
  });

  // ── (qr) DURABLE QUARANTINE (ticket b6477bc7, 2026-10-16) ──────────────
  // Replay of the prod repro: project 52ad1f73 warned "push refused
  // permanently (terminal auth; quarantined for 6h…)" at 09:36, 10:37, 12:17,
  // 12:58, 13:08 UTC — every repeat one worker boot — because the quarantine
  // was an in-process Map. The window now lives in Redis, so a process
  // restart must NOT re-warn inside the window.
  it('(qr1) ticket b6477bc7 replay: the quarantine SURVIVES a module reload (worker reboot) — no second warn, no git traffic, inside the 6h window', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    const authFail = 'remote: No anonymous write access.';
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error(authFail); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error(authFail); return ''; } }),
    ]);

    // Pass 1 (the old process): quarantines with ONE warn.
    const first = await runSessionHistorySyncOnce();
    expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
    const quarantinedKey = 'session-history:push-quarantine:p1';
    expect(redisStore.has(quarantinedKey)).toBe(true);
    // The claim was a SET NX with the retry window as the TTL (21600 s).
    expect(redisSet).toHaveBeenCalledWith(quarantinedKey, expect.any(String), { NX: true, EX: 21600 });

    // THE REBOOT: a fresh require of the module — a new process, empty
    // module state, SAME Redis (redisStore is the harness's stand-in for the
    // shared server the deploy leaves untouched).
    let reloaded: typeof import('./session-history-sync.service');
    jest.isolateModules(() => {
      reloaded = require('./session-history-sync.service');
    });
    const warnCallsAfterBoot = loggerWarn.mock.calls.length;
    const gitCallsAfterBoot = gitMock.mock.calls.length;

    // Pass 2 (the new process, inside the 6h window): the repo is skipped —
    // no warn, no git traffic. Pre-fix this re-warned on every boot.
    const second = await reloaded!.runSessionHistorySyncOnce();
    expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    expect(loggerWarn.mock.calls.length).toBe(warnCallsAfterBoot); // no repeat warn
    expect(gitMock.mock.calls.length).toBe(gitCallsAfterBoot); // no git traffic
    // And the surviving key is still the ORIGINAL claim (not re-claimed).
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(redisStore.has(quarantinedKey)).toBe(true);
  });

  it('(qr2) a Redis outage degrades to the EXACT pre-fix per-process window: quarantined in-process (push denied, skipped next pass), the warn never storms per pass, and the sweep never throws', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    const authFail = 'remote: No anonymous write access.';
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error(authFail); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error(authFail); return ''; } }),
    ]);

    redisOpsDown = true; // every Redis op throws (total outage)
    try {
      // Pass 1: attempted (no Redis quarantine visible), auth-refused →
      // quarantined via the IN-PROCESS fallback: same warn, same "push
      // denied" counting as the healthy path.
      const first = await runSessionHistorySyncOnce();
      expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
      expect(loggerWarn).toHaveBeenCalledTimes(1); // ONE warn, not one per session
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
      expect(gitCalls().filter(a => a[0] === 'push')).toHaveLength(2); // first + fetch-path retry

      // Pass 2 (Redis still down, inside the window): the fallback window
      // suppresses everything — no warn, no git traffic (the FO-106 storm
      // class — one warn per pass — cannot return via an outage).
      const second = await runSessionHistorySyncOnce();
      expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(gitCalls().filter(a => a[0] === 'push')).toHaveLength(2); // unchanged
    } finally {
      redisOpsDown = false;
    }
  });

  // ── (qr3) OFFLINE-QUEUE OUTAGE SHAPE (review amendment on b6477bc7) ────
  // node-redis does NOT reject a mid-life outage's commands: the socket stays
  // "open" and every op QUEUES (@redis/client rejects only on a closed socket
  // or disableOfflineQueue — config/redis.ts sets neither), so (qr2)'s
  // throwing mocks model a shape the real worker never produces. With ops
  // that never settle, the per-op timeout must still bound the sweep: degrade
  // to the per-process window, never stall the serial cron loop.
  it('(qr3) ticket b6477bc7: a Redis outage that QUEUES ops (never settles — the real node-redis mid-life shape) is still bounded — fallback window, no storm, no stall, never throws', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    const authFail = 'remote: No anonymous write access.';
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      { match: a => a[0] === 'fetch', respond: () => { throw new Error(authFail); } },
      ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error(authFail); return ''; } }),
    ]);

    const realTimeout = __pushQuarantineRedisTimeoutMs.current;
    __pushQuarantineRedisTimeoutMs.current = 20; // fast test — same code path
    redisPending = true; // ops NEVER settle — the offline-queue shape
    try {
      // Pass 1: no Redis answer inside the bound → the in-process fallback
      // claims the window; identical observable behavior to (qr2).
      const first = await runSessionHistorySyncOnce();
      expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
      expect(gitCalls().filter(a => a[0] === 'push')).toHaveLength(2); // first + fetch-path retry

      // Pass 2 (still pending, inside the fallback window): skipped — no
      // warn, no git traffic, and the pass RETURNS (the sweep is not wedged
      // behind the never-settling op — the cron loop keeps ticking).
      const second = await runSessionHistorySyncOnce();
      expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(gitCalls().filter(a => a[0] === 'push')).toHaveLength(2); // unchanged
    } finally {
      redisPending = false;
      __pushQuarantineRedisTimeoutMs.current = realTimeout;
    }
  });


  it('(f) one session failing to render keeps its PREVIOUS file in the tree (never pruned) while the others land', async () => {
    stateFindMany.mockResolvedValue([SESSION, { ...SESSION, id: 's2' }]);
    let hashCalls = 0;
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blobA\tsessions/s1/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => {
        hashCalls++;
        if (hashCalls === 1) throw new Error('mirror vanished'); // s1 dies here
        return 'blob2\n';
      } },
      ...plumbingRoutes(),
    ]);

    const summary = await runSessionHistorySyncOnce();

    expect(summary).toBe('synced 1, unchanged 0, failed 1 of 2');
    expect(gitCalls().filter(a => a[0] === 'update-index')).toEqual([
      ['update-index', '--add', '--cacheinfo', '100644,blob2,sessions/s2/HISTORY.md'],
    ]);
    expect(gitCalls()).toContainEqual(['push', AUTHED, REF]);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('session s1 failed'));
  });

  it('(g) repos are isolated: a repo-level failure (corrupt mirror tip) counts ITS sessions failed while the other repo syncs on its own mirror', async () => {
    const P2 = { ...SESSION.project, id: 'p2', repoUrl: 'https://github.com/o/r2.git' };
    stateFindMany.mockResolvedValue([SESSION, { ...SESSION, id: 's1b' }, { ...SESSION, id: 's2', projectId: 'p2', project: P2 }]);
    programGit([
      // p1 has a tip but its tree is unreadable → the repo-level catch.
      { match: (a, ) => a[0] === 'rev-parse' && a[1] === '--verify', respond: () => 'tip1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => { throw new Error('fatal: not a tree object'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      ...plumbingRoutes(),
    ]);
    // p2 is a fresh repo (no tip) — route by mirror cwd.
    const routed = gitMock.getMockImplementation()!;
    gitMock.mockImplementation(async (args: string[], cwd: string, ...rest: any[]) => {
      if (cwd === '/repos/p2.git' && args[0] === 'rev-parse') throw new Error('no such ref');
      return routed(args, cwd, ...rest);
    });

    const summary = await runSessionHistorySyncOnce();

    // Both p1 sessions count failed (none confirmed unchanged); p2's landed.
    expect(summary).toBe('synced 1, unchanged 0, failed 2 of 3');
    const pushes = gitMock.mock.calls.filter(c => (c[0] as string[])[0] === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1]).toBe('/repos/p2.git');
    expect(gitMock.mock.calls.some(c => c[1] === MIRROR_P1 && (c[0] as string[])[0] === 'hash-object')).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('project p1 failed (2 session(s)'));
  });
});

describe('missing mirror on disk (hardening loop 2026-09-24)', () => {
  it('isMissingRepoError recognises Node\'s missing-cwd shape and ENOENT codes only', () => {
    expect(isMissingRepoError(new Error('spawn git ENOENT'))).toBe(true);
    expect(isMissingRepoError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isMissingRepoError(new Error('fatal: not a git repository'))).toBe(false);
    expect(isMissingRepoError(null)).toBe(false);
  });

  it('a repo whose mirror is gone is SKIPPED (no mirror N), never "failed", and warned ONCE per process — not per session, not per pass', async () => {
    __resetSessionHistorySyncForTest();
    stateFindMany.mockResolvedValue([
      { ...SESSION, id: 's1' },
      { ...SESSION, id: 's2' },
      { ...SESSION, id: 's3' },
    ]);
    gitMock.mockImplementation(async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); });
    const warn = logger.warn as jest.Mock;
    warn.mockClear();

    const first = await runSessionHistorySyncOnce();
    expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, no mirror 3');
    const mirrorWarns = () => warn.mock.calls.filter(c => String(c[0]).includes('mirror missing on disk'));
    expect(mirrorWarns()).toHaveLength(1);
    expect(warn.mock.calls.some(c => String(c[0]).includes('failed (next pass retries)'))).toBe(false);

    const second = await runSessionHistorySyncOnce();
    expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, no mirror 3');
    expect(mirrorWarns()).toHaveLength(1); // still once
  });
});

/* =====================================================================
 * STOP FOR GONE/ARCHIVED PROJECTS + DURABLE AUTH-DISABLE (ticket 5eb035d6,
 * owner decision oq_fd533d0a "STOP THE JOB"). Prod: project 52ad1f73 left
 * the owner's account but its sessions kept pushing against a repo that
 * refuses them — 36 warn rows/24 h. Two stops:
 *   (A) the project is archived (own row or an archived ANCESTOR folder) or
 *       its row is gone → skip every pass, ONE info log per project per
 *       process, never a warn;
 *   (B) the terminal-auth refusal is DURABLE (Redis INCR streak, shared by
 *       every worker process): 3 consecutive refusals disable the repo's
 *       sync — ONE info log at the crossing, the per-window quarantine WARN
 *       suppressed from then on (the ticket's acceptance: the warn class
 *       stops appearing) — with one single-flight re-probe per 24 h and any
 *       landed push resuming it.
 * Sits ON TOP of the b6477bc7 Redis quarantine (PR #1604/#1614).
 * ===================================================================== */
describe('stop sync for gone/archived projects (ticket 5eb035d6)', () => {
  /** A session whose project row carries the archive/parent/path fields. */
  const sessionWithProject = (project: Record<string, unknown>) => ({
    ...SESSION,
    project: { ...SESSION.project, ...project },
  });

  it('(t1) an ARCHIVED project (own row) is skipped: one info log, never a warn, no git calls, counted "project gone"', async () => {
    stateFindMany.mockResolvedValue([
      sessionWithProject({ archivedAt: new Date('2026-10-01T00:00:00Z') }),
      { ...SESSION, id: 's2', project: { ...SESSION.project, archivedAt: new Date('2026-10-01T00:00:00Z') } },
    ]);

    const first = await runSessionHistorySyncOnce();
    expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, project gone 2');
    expect(gitMock).not.toHaveBeenCalled();

    // ONE info for the project — not per session, not per pass — and NO warn.
    const goneInfo = () => loggerInfo.mock.calls.filter(c => String(c[0]).includes("no longer in the owner's account"));
    expect(goneInfo()).toHaveLength(1);
    expect(goneInfo()[0][0]).toContain('project p1');
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('next pass retries'));

    const second = await runSessionHistorySyncOnce();
    expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, project gone 2');
    expect(goneInfo()).toHaveLength(1); // still once
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('(t2) a project NESTED under an archived ANCESTOR folder is skipped too (archive stamps only the folder row — the exact 52ad1f73 shape)', async () => {
    stateFindMany.mockResolvedValue([
      sessionWithProject({ id: 'pchild', projectId: 'pchild', parentId: 'root', path: '/root/pchild' }),
    ]);
    // The ancestor lookup returns root as archived.
    projectFindMany.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      return ids.map((id: string) => ({ id, archivedAt: id === 'root' ? new Date('2026-10-01T00:00:00Z') : null }));
    });

    const summary = await runSessionHistorySyncOnce();
    expect(summary).toBe('synced 0, unchanged 0, failed 0 of 0, project gone 1');
    expect(gitMock).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining("no longer in the owner's account"));
  });

  it('(t3) the ancestor lookup is scoped: only ARCHIVED ancestors stop sync — a live tree syncs on', async () => {
    stateFindMany.mockResolvedValue([
      sessionWithProject({ id: 'pchild', projectId: 'pchild', parentId: 'root', path: '/root/pchild' }),
    ]);
    projectFindMany.mockResolvedValue([{ id: 'root', archivedAt: null }]);

    const summary = await runSessionHistorySyncOnce();
    // It proceeded into the normal plumbing path (git traffic happened).
    expect(summary).not.toContain('project gone');
    expect(gitMock).toHaveBeenCalled();
  });

  it('(t4) a session whose project row is missing (dangling include — a removed project row) is skipped with ONE info log and NO warn: the ticket\'s literal acceptance', async () => {
    stateFindMany.mockResolvedValue([{ ...SESSION, project: null }]);

    const summary = await runSessionHistorySyncOnce();
    expect(summary).toBe('synced 0, unchanged 0, failed 0 of 0, project gone 1');
    expect(gitMock).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining("no longer in the owner's account"));
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('(t5) RESTORE resumes sync: the same project row, archivedAt cleared, syncs again on the very next pass', async () => {
    // Pass 1: archived → gone.
    stateFindMany.mockResolvedValue([sessionWithProject({ archivedAt: new Date('2026-10-01T00:00:00Z') })]);
    await runSessionHistorySyncOnce();
    expect(gitMock).not.toHaveBeenCalled();

    // Pass 2: restored (archivedAt null, no parent) → sync proceeds normally
    // (the unchanged path: same blob at the tip ⇒ no commit, no push).
    stateFindMany.mockResolvedValue([sessionWithProject({ archivedAt: null })]);
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => 'tip1\n' },
      { match: a => a[0] === 'ls-tree', respond: () => '100644 blob blob1\tsessions/s1/HISTORY.md\n' },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
    ]);
    const second = await runSessionHistorySyncOnce();
    expect(second).toBe('synced 0, unchanged 1, failed 0 of 1');
  });
});

describe('durable terminal-auth disable (ticket 5eb035d6, owner oq_fd533d0a STOP THE JOB)', () => {
  /** Routes for a pass whose push is refused with terminal auth. */
  const authRefusedRoutes = (): GitRoute[] => [
    { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
    { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
    { match: a => a[0] === 'fetch', respond: () => { throw new Error('remote: No anonymous write access.'); } },
    ...plumbingRoutes({ push: a => { if (a[2] === REF) throw new Error('remote: No anonymous write access.'); return ''; } }),
  ];

  /** One refusing pass, then expire the quarantine window so the NEXT pass
   *  is a fresh attempt (each fresh refusal = one INCR; in prod the windows
   *  expire on their own TTL). */
  async function refusedPass(): Promise<void> {
    await runSessionHistorySyncOnce();
    expireRedisQuarantine('p1');
  }

  it('(u1) THREE consecutive refusals disable the repo: ONE info at the crossing, warns only on the first two windows, then fully silent', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit(authRefusedRoutes());

    // Pass 1: first refusal — quarantine warn (fresh window), streak 1.
    await refusedPass();
    const quarantineWarns = () => loggerWarn.mock.calls.filter(c => String(c[0]).includes('push refused permanently'));
    const disableInfos = () => loggerInfo.mock.calls.filter(c => String(c[0]).includes('history sync DISABLED'));
    expect(quarantineWarns()).toHaveLength(1);
    expect(disableInfos()).toHaveLength(0);

    // Pass 2: second fresh-window refusal — warn again, streak 2.
    await refusedPass();
    expect(quarantineWarns()).toHaveLength(2);
    expect(disableInfos()).toHaveLength(0);

    // Pass 3: the threshold crossing — ONE info, NO warn (suppressed: the
    // durable disable governs from here — the ticket's acceptance).
    await runSessionHistorySyncOnce();
    expect(disableInfos()).toHaveLength(1);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('history sync DISABLED for it'));
    expect(quarantineWarns()).toHaveLength(2); // unchanged — suppressed

    // Pass 4: fully disabled — no git traffic at all, completely silent.
    const gitCallsBefore = gitCalls().length;
    const fourth = await runSessionHistorySyncOnce();
    expect(fourth).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    expect(gitCalls().length).toBe(gitCallsBefore); // zero push attempts
    expect(disableInfos()).toHaveLength(1);
    expect(quarantineWarns()).toHaveLength(2);
  });

  it('(u2) the streak is DURABLE across a process restart (module state reset, Redis intact): still disabled', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit(authRefusedRoutes());
    await refusedPass();
    await refusedPass();
    await runSessionHistorySyncOnce(); // disabled

    // A FRESH process state (per-process memos cleared, Redis intact).
    __resetSessionHistorySyncForTest();
    const gitBefore = gitCalls().length;
    const summary = await runSessionHistorySyncOnce();
    expect(summary).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    expect(gitCalls().length).toBe(gitBefore); // no push attempted at all
    // and the durable key holds the streak.
    expect(redisStore.get('session-history:auth-disable:p1')?.value).toBe('3');
  });

  it('(u3) a LANDED push clears the durable streak (a fixed credential never stays disabled)', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit(authRefusedRoutes());
    await refusedPass();
    await refusedPass();
    await runSessionHistorySyncOnce(); // streak 3, disabled, lock armed

    // 24h later the re-probe runs; the credential is FIXED — the push lands
    // and clears the streak (the repo is back to normal sync).
    expireAuthReprobe('p1');
    const commits = { n: 0 };
    programGit([
      { match: a => a[0] === 'rev-parse' && a[1] === '--verify' && a[2] === REF, respond: () => { throw new Error('no such ref'); } },
      { match: a => a[0] === 'hash-object', respond: () => 'blob1\n' },
      ...plumbingRoutes({
        'commit-tree': () => `commit${++commits.n}\n`,
        push: a => { if (a[2] === REF) return ''; return ''; },
      }),
    ]);
    const fixed = await runSessionHistorySyncOnce();
    expect(fixed).toBe('synced 1, unchanged 0, failed 0 of 1');
    expect(redisStore.has('session-history:auth-disable:p1')).toBe(false);
  });

  it('(u4) the disable re-probes ONCE per 24 h, and a REFUSED re-probe is fully silent (the warn class stays gone — the ticket\'s acceptance)', async () => {
    stateFindMany.mockResolvedValue([SESSION]);
    programGit(authRefusedRoutes());
    await refusedPass();
    await refusedPass();
    await runSessionHistorySyncOnce(); // disabled, lock armed at the crossing

    const quarantineWarns = () => loggerWarn.mock.calls.filter(c => String(c[0]).includes('push refused permanently'));
    const disableInfos = () => loggerInfo.mock.calls.filter(c => String(c[0]).includes('history sync DISABLED'));
    const warnsAfterDisable = quarantineWarns().length;

    // 24h later: exactly ONE fresh attempt (2 pushes = first + fetch-path
    // retry), refused again — NO new warn, NO new info, and the re-probe
    // lock re-arms for another 24h (self-rearming TTL).
    expireAuthReprobe('p1');
    const pushesBefore = gitCalls().filter(a => a[0] === 'push').length;
    const reprobe = await runSessionHistorySyncOnce();
    expect(reprobe).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    const pushesAfter = gitCalls().filter(a => a[0] === 'push').length;
    expect(pushesAfter - pushesBefore).toBe(2); // ONE fresh attempt
    expect(quarantineWarns().length).toBe(warnsAfterDisable); // silent
    expect(disableInfos().length).toBe(1); // still the single crossing info
    // the lock is re-armed for a full period
    expect(redisStore.get('session-history:auth-disable:reprobe:p1')?.expiresAt).toBeGreaterThan(Date.now());

    // Immediately after (still in the re-armed window): silent skip again.
    const gitLen = gitCalls().length;
    const silent = await runSessionHistorySyncOnce();
    expect(silent).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
    expect(gitCalls().length).toBe(gitLen);
    expect(quarantineWarns().length).toBe(warnsAfterDisable);
    expect(disableInfos().length).toBe(1);
  });

  it('(u5) kill switch SESSION_HISTORY_SYNC_AUTH_DISABLE_DISABLED=1 restores the quarantine-only contract', async () => {
    process.env[SESSION_HISTORY_AUTH_DISABLE_ENV] = '1';
    expect(sessionHistoryAuthDisableEnabled()).toBe(false);
    stateFindMany.mockResolvedValue([SESSION]);
    programGit(authRefusedRoutes());
    // Every pass a FRESH window (the pre-fix rhythm) — but no streak is
    // ever written and no disable ever fires.
    for (let i = 0; i < 5; i++) await refusedPass();
    expect(loggerInfo).not.toHaveBeenCalledWith(expect.stringContaining('history sync DISABLED'));
    expect(redisStore.has('session-history:auth-disable:p1')).toBe(false);
    // and the repo still gets its fresh attempts (quarantine-only).
    expect(gitCalls().filter(a => a[0] === 'push').length).toBeGreaterThanOrEqual(2);
  });

  it('(u6) a Redis outage (ops down, incr included) is FAIL-OPEN: the quarantine contract still holds, no disable fires', async () => {
    redisOpsDown = true;
    stateFindMany.mockResolvedValue([SESSION]);
    programGit(authRefusedRoutes());

    try {
      const first = await runSessionHistorySyncOnce();
      expect(first).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1'); // quarantined (per-process fallback)
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('push refused permanently'));
      const second = await runSessionHistorySyncOnce();
      expect(second).toBe('synced 0, unchanged 0, failed 0 of 0, push denied 1');
      expect(loggerInfo).not.toHaveBeenCalledWith(expect.stringContaining('history sync DISABLED'));
    } finally {
      redisOpsDown = false;
    }
  });

  it('(u7) the threshold constant is 3 (documented owner decision contract)', () => {
    expect(SESSION_HISTORY_AUTH_DISABLE_THRESHOLD).toBe(3);
  });
});
