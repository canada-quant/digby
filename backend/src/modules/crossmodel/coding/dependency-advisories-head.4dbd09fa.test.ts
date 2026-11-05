/**
 * Ticket 4dbd09fa — the open_pull_request advisory scan must read the PUSHED
 * PR HEAD TREE, not the lane's on-disk worktree.
 *
 * THE MISHAP (prod, PR #1488 on example-org/crossmodel, opened 2026-10-14 off
 * clean tip aa4632e3): the PR body's [SECURITY ADVISORY] section listed the
 * exact PRE-#1453 dependency set — axios@1.13.5 (backend), axios@1.13.2
 * (frontend), axios@1.18.1 (asana-mcp), axios@1.16.1 (x-mcp), sdk@1.29.0
 * (asana-mcp), sdk@1.30.0 (digby-mcp) — although the PR's base AND head both
 * carried the fixed floors (axios 1.20.0 / @modelcontextprotocol/sdk 1.32.1,
 * merged in #1453, squash 97c763e0). The reported versions fingerprint-matched
 * the PRE-BUMP lockfiles at 6f960571 (97c763e0^): checkDependencyAdvisories
 * walked the lane's working DIRECTORY (fs.readdir/fs.readFile), which can lag
 * the pushed head arbitrarily — and on the explicit-head path is by definition
 * an UNRELATED checkout. The lane was told main had REGRESSED (spawning a
 * verify todo) and the report described a dependency state that never existed
 * at the PR head.
 *
 * THE FIX: checkDependencyAdvisories gains headRef — a git tree read
 * (ls-tree/show at the head sha) via the DepFileIO seam — and
 * open_pull_request passes the pushed PR head sha (rev-parse HEAD after the
 * pinned push, or the GitHub-ref sha on the explicit-head path, fetched
 * locally). The disk walk remains the fail-open fallback.
 *
 * This file replays the mishap shape end-to-end with REAL git repos: a
 * #1453-class dep-floor bump lands, the lane's disk stays PRE-BUMP, and the
 * PR-open scan must report the HEAD's (fixed) state. OSV is faked; GitHub is
 * mocked at the axios seam (c7bf1e66 harness shape).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard', GUARD_STRIKE: 'guard_strike',
  },
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(),
  waitForProcessOutput: jest.fn(),
  readProcessOutput: jest.fn(),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(),
  listProcesses: jest.fn(),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async () => null),
  findPriorRunPrReceipt: jest.fn(async () => null),
  prHeadMatchesReceipt: jest.fn(async () => false),
  prReceiptHeadState: jest.fn(async () => undefined),
  prStateWarrantsSkip: () => false,
}));
jest.mock('./verify-limiter', () => ({
  __esModule: true,
  withVerifySlot: jest.fn(async (fn: () => Promise<any>) => fn()),
}));

const axiosGet = jest.fn();
const axiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => axiosGet(...a), post: (...a: any[]) => axiosPost(...a) },
}));

import { executeCodingTool, ToolContext } from './tools';
import {
  checkDependencyAdvisories,
  GitTreeIO,
  resolveProductionDeps,
  resetAdvisoryCache,
} from './dependency-advisories';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// ── OSV fake: the pre-bump axios range is vulnerable, the floor is not ─────────

/** The #1453-class shape: axios < 1.20.0 is CRITICAL, fixed at 1.20.0. */
const AXIOS_RCE = {
  id: 'GHSA-4dbd09fa-replay',
  aliases: ['CVE-2026-4dbd'],
  summary: 'axios SSRF/RCE in pre-1.20.0 releases',
  database_specific: { severity: 'CRITICAL' },
  affected: [
    { package: { ecosystem: 'npm', name: 'axios' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.20.0' }] }] },
  ],
};

/** querybatch tells every queried name@version whether AXIOS_RCE covers it. */
function fakeOsv() {
  const calls: string[] = [];
  const impl = async (url: string, init?: any) => {
    calls.push(url);
    if (url.endsWith('/querybatch')) {
      const q = JSON.parse(init.body).queries as Array<{ package: { name: string }, version: string }>;
      return {
        ok: true, status: 200,
        json: async () => ({
          results: q.map(x => ({
            vulns: (x.package.name === 'axios' && x.version !== '1.20.0') ? [{ id: AXIOS_RCE.id }] : [],
          })),
        }),
      };
    }
    return { ok: true, status: 200, json: async () => AXIOS_RCE };
  };
  return { impl, calls };
}

// ── real-git fixture: the lane worktree + its origin ──────────────────────────

const g = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
const wf = async (file: string, body: string) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); };

/** A lockfile v3 that installs axios at `version`. */
const lockWith = (axiosVersion: string) => JSON.stringify({
  lockfileVersion: 3,
  packages: { '': { dependencies: { axios: `^${axiosVersion}` } }, [`node_modules/axios`]: { version: axiosVersion } },
});

/** One #1453-style package: a manifest + lockfile pair pinned to `axiosVersion`. */
async function pkgPair(root: string, dir: string, axiosVersion: string) {
  await wf(path.join(root, dir, 'package.json'), JSON.stringify({ name: dir || 'root', dependencies: { axios: `^${axiosVersion}` } }));
  await wf(path.join(root, dir, 'package-lock.json'), lockWith(axiosVersion));
}

describe('ticket 4dbd09fa: the advisory scan reads the PUSHED PR HEAD, not the lane disk', () => {
  let remote: string;
  let wt: string;
  let preBumpSha: string;
  let floorSha: string;

  const mkCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    worktree: wt, sessionId: 'sess-4dbd09fa', userId: 'u1', permissionMode: 'auto',
    provider: 'github', repoUrl: `https://github.com/o/r`, branch: 'digby/session-4dbd09fa', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: async () => 'tok',
    userTurnAt: new Date(),
    prGateBypass: true,
    ...over,
  } as unknown as ToolContext);

  /** The PR-open flow with GitHub mocked: verifyRemoteBranchExists + POST /pulls succeed. */
  const mockPrCreate = (number = 1492, headSha?: string) => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    // verifyRemoteBranchExists — returns the remote tip (defaults to the FLOOR sha).
    axiosGet.mockResolvedValueOnce({ data: { ref: 'refs/heads/digby/fresh-branch', object: { sha: headSha ?? floorSha } } });
    axiosPost.mockResolvedValueOnce({
      data: { number, html_url: `https://github.com/o/r/pull/${number}`, head: { ref: 'digby/fresh-branch' } },
    });
    return number;
  };

  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => { for (const k of ['DEPENDENCY_ADVISORY_CHECK_DISABLED']) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
  afterAll(() => { for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

  beforeEach(async () => {
    resetAdvisoryCache();
    axiosGet.mockReset();
    axiosPost.mockReset();
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-4dbd09fa-'));
    remote = path.join(rootTmp, 'origin.git');
    wt = path.join(rootTmp, 'wt');
    // origin: bare, one main history
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
    // the lane worktree: a CLONE of origin at the pre-bump tip (this is how
    // real session worktrees come into being)…
    const seed = path.join(rootTmp, 'seed');
    execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'pipe' });
    g(seed, ['config', 'user.email', 't@example.com']);
    g(seed, ['config', 'user.name', 't']);
    await pkgPair(seed, '.', '1.13.5');          // the PRE-BUMP root (the 6f960571 shape)
    await pkgPair(seed, 'frontend', '1.13.2');   // …and the sub-project, equally stale
    g(seed, ['add', '.']);
    g(seed, ['commit', '-qm', 'pre-bump deps']);
    preBumpSha = g(seed, ['rev-parse', 'HEAD']).trim();
    g(seed, ['push', '-q', remote, 'HEAD:refs/heads/main']);
    // …origin/main then gains the #1453-class floors (a DIFFERENT lane's work),
    // while THIS lane's worktree is cloned from the pre-bump tip and never
    // pulls: its disk AND its local history stay pre-bump.
    await pkgPair(seed, '.', '1.20.0');
    await pkgPair(seed, 'frontend', '1.20.0');
    g(seed, ['add', '.']);
    g(seed, ['commit', '-qm', 'dep floors (#1453 shape)']);
    g(seed, ['push', '-q', '-f', remote, 'HEAD:refs/heads/main']);
    floorSha = g(seed, ['rev-parse', 'HEAD']).trim();
    await fs.rm(seed, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', remote, wt], { stdio: 'pipe' });
    g(wt, ['checkout', '-q', '-b', 'digby/session-4dbd09fa', 'origin/main']);
    g(wt, ['reset', '-q', '--hard', preBumpSha]);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(remote), { recursive: true, force: true });
  });

  it('REPLAY of the mishap at the resolve layer: the lane disk is pre-bump, the head tree is post-floor — headRef must win', async () => {
    // Sanity: the two states genuinely differ (this is the 4dbd09fa setup).
    expect(g(wt, ['show', `${floorSha}:package.json`])).toContain('1.20.0');
    const disk = JSON.parse(await fs.readFile(path.join(wt, 'package.json'), 'utf8'));
    expect(disk.dependencies.axios).toBe('^1.13.5');

    // DISK (old behaviour — the bug): reports the stale pre-bump versions.
    const fromDisk = await resolveProductionDeps(wt);
    expect(fromDisk.deps.map(d => `${d.name}@${d.version}`).sort()).toEqual(['axios@1.13.2', 'axios@1.13.5']);
    // (dedup by name@version is historical: two manifests on one version collapse)

    // HEAD TREE (the fix): reports exactly what the pushed PR head carries —
    // the floor, once (same dedup).
    const fromHead = await resolveProductionDeps(wt, new GitTreeIO(wt, floorSha));
    expect(fromHead.deps.map(d => `${d.name}@${d.version}`).sort()).toEqual(['axios@1.20.0']);
    expect(fromHead.manifests).toEqual(['package.json', 'frontend/package.json']);
  });

  it('REPLAY of the mishap at the check layer: headRef describes the PR head (fixed), not the stale disk (vulnerable)', async () => {
    const osv = fakeOsv();
    // Old behaviour — disk: TWO vulnerable groups (the false alarm PR #1488 showed).
    const diskReport = await checkDependencyAdvisories(wt, { fetchImpl: osv.impl });
    expect(diskReport.findings.map(f => `${f.pkg}@${f.version}`).sort()).toEqual(['axios@1.13.2', 'axios@1.13.5']);
    // New behaviour — headRef: the floor clears both, nothing to report.
    const headReport = await checkDependencyAdvisories(wt, { fetchImpl: osv.impl, headRef: floorSha });
    expect(headReport.findings).toEqual([]);
    expect(headReport.error).toBeUndefined();
  });

  it('the fix covers sub-project manifests too: frontend/ resolves from the head tree, never the stale disk', async () => {
    const fromHead = await resolveProductionDeps(wt, new GitTreeIO(wt, floorSha));
    expect(fromHead.manifests).toEqual(['package.json', 'frontend/package.json']);
    expect(fromHead.deps.every(d => d.version === '1.20.0')).toBe(true);
  });

  it('open_pull_request (explicit head): the PR body carries the HEAD\'s advisory state — a stale lane disk cannot inject false dep alerts', async () => {
    mockPrCreate();
    // Hermetic OSV: even a full resolve must never reach the real network —
    // any query the scan makes for the head's deps is answered "clean".
    const osv = fakeOsv();
    const realFetch = global.fetch;
    global.fetch = osv.impl as any;
    try {
      const out = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 'unrelated fix', headBranch: 'digby/fresh-branch' });
      // The PR opened (observe-only scan never blocks it)…
      expect(out).toContain('Opened PR #1492: https://github.com/o/r/pull/1492');
      // …and the body posted to GitHub was built from the HEAD tree: the floor
      // clears the advisory, so NO [SECURITY ADVISORY] section may appear —
      // this is the exact false-positive class of PR #1488.
      const posted = axiosPost.mock.calls.find(c => String(c[0]).endsWith('/pulls'));
      expect(posted).toBeDefined();
      const body = String(posted?.[2]?.body ?? posted?.[1]?.body ?? '');
      expect(body).not.toContain('Security advisories in production dependencies');
      expect(body).not.toContain('axios@1.13');
      // The notice to the lane is equally silent.
      expect(out).not.toContain('[SECURITY ADVISORY]');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('open_pull_request (explicit head): a GENUINELY vulnerable head still reports — the fix must not swallow real findings', async () => {
    // The head branch tip carries the VULNERABLE pre-bump state: the remote
    // branch itself points at the pre-bump commit, and the local worktree
    // already HAS that object (it authored it) — so the cat-file guard skips
    // the network fetch entirely and the tree read is deterministic.
    g(wt, ['push', '-q', '-f', remote, `${preBumpSha}:refs/heads/digby/fresh-branch`]);
    mockPrCreate(1493, preBumpSha);
    const osv = fakeOsv();
    const realFetch = global.fetch;
    global.fetch = osv.impl as any;
    try {
      const out = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 'vulnerable head', headBranch: 'digby/fresh-branch' });
      expect(out).toContain('Opened PR #1493');
      expect(out).toContain('[SECURITY ADVISORY]');
      expect(out).toContain('axios@1.13.5');
      const posted = axiosPost.mock.calls.find(c => String(c[0]).endsWith('/pulls'));
      const body = String(posted?.[2]?.body ?? posted?.[1]?.body ?? '');
      expect(body).toContain('Security advisories in production dependencies');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('fail-open: an unreadable headRef (bad sha) falls back to the disk walk, never throws, never blocks the PR', async () => {
    const report = await checkDependencyAdvisories(wt, { fetchImpl: fakeOsv().impl, headRef: '0'.repeat(40) });
    // Fallback = the historical disk behaviour (stale but honest about THIS worktree).
    expect(report.findings.map(f => `${f.pkg}@${f.version}`).sort()).toEqual(['axios@1.13.2', 'axios@1.13.5']);
    expect(report.error).toBeUndefined();
    expect(report.source).toBe('worktree');
  });

  it('a RESOLVABLE head tree with ZERO manifests is authoritative (a delete-the-JS-app PR): no silent disk fallback, source says pr-head', async () => {
    // Head tree: the app's manifests are gone entirely (the PR deletes them).
    // The commit is made in a sibling clone and PUSHED to the shared remote so
    // the lane worktree can actually resolve the sha (an object that exists
    // nowhere the worktree can reach is the UNRESOLVABLE case, not this one).
    const seed = path.join(path.dirname(remote), 'delseed');
    execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'pipe' });
    g(seed, ['config', 'user.email', 't@example.com']);
    g(seed, ['config', 'user.name', 't']);
    await fs.rm(path.join(seed, 'package.json'), { force: true });
    await fs.rm(path.join(seed, 'package-lock.json'), { force: true });
    await fs.rm(path.join(seed, 'frontend'), { recursive: true, force: true });
    g(seed, ['add', '-A']);
    g(seed, ['commit', '-qm', 'delete the JS app']);
    g(seed, ['push', '-q', remote, 'HEAD:refs/heads/delete-the-app']);
    const delSha = g(seed, ['rev-parse', 'HEAD']).trim();
    await fs.rm(seed, { recursive: true, force: true });
    g(wt, ['fetch', '-q', remote, 'refs/heads/delete-the-app']);
    // The lane disk STILL carries the vulnerable pre-bump manifests — the old
    // fallback-on-empty would have reported them. The head tree must win.
    const report = await checkDependencyAdvisories(wt, { fetchImpl: fakeOsv().impl, headRef: delSha });
    expect(report.findings).toEqual([]);
    expect(report.manifests).toEqual([]);
    expect(report.packages).toBe(0);
    expect(report.source).toBe('pr-head');
  });

  it('the report names its source: pr-head when the head tree was read, worktree on the disk walk', async () => {
    const osv = fakeOsv();
    const disk = await checkDependencyAdvisories(wt, { fetchImpl: osv.impl });
    expect(disk.source).toBe('worktree');
    const head = await checkDependencyAdvisories(wt, { fetchImpl: osv.impl, headRef: floorSha });
    expect(head.source).toBe('pr-head');
  });

  it('ADVERSARIAL-REVIEW FIX: a non-ASCII manifest dir in the head tree is NOT silently dropped (ls-tree -z exact-bytes compare)', async () => {
    // The reviewer's end-to-end-confirmed class: the human-readable ls-tree
    // format C-quotes `décor/package.json` under core.quotepath=1, so a
    // trim()-based string compare returned false and the manifest VANISHED
    // from the head scan — a false negative relative to the old disk walk.
    // Head tree: a non-ASCII-named package locked to the VULNERABLE version.
    const seed = path.join(path.dirname(remote), 'qseed');
    execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'pipe' });
    g(seed, ['config', 'user.email', 't@example.com']);
    g(seed, ['config', 'user.name', 't']);
    await pkgPair(seed, 'décor', '1.13.5');
    g(seed, ['add', '.']);
    g(seed, ['commit', '-qm', 'add a non-ASCII package dir']);
    g(seed, ['push', '-q', remote, 'HEAD:refs/heads/non-ascii-dir']);
    const quoteSha = g(seed, ['rev-parse', 'HEAD']).trim();
    await fs.rm(seed, { recursive: true, force: true });
    g(wt, ['fetch', '-q', remote, 'refs/heads/non-ascii-dir']);
    const fromHead = await resolveProductionDeps(wt, new GitTreeIO(wt, quoteSha));
    expect(fromHead.manifests).toContain('décor/package.json');
    // …and its vulnerable axios is actually REPORTED from the head tree.
    const osv = fakeOsv();
    const report = await checkDependencyAdvisories(wt, { fetchImpl: osv.impl, headRef: quoteSha });
    expect(report.source).toBe('pr-head');
    expect(report.findings.some(f => f.pkg === 'axios' && f.version === '1.13.5' && f.manifest === 'décor/package.json')).toBe(true);
  });

  it('kill switch still silences the whole scan', async () => {
    const prev = process.env.DEPENDENCY_ADVISORY_CHECK_DISABLED;
    process.env.DEPENDENCY_ADVISORY_CHECK_DISABLED = '1';
    try {
      mockPrCreate(1494);
      const out = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't', headBranch: 'digby/fresh-branch' });
      expect(out).toContain('Opened PR #1494');
      expect(out).not.toContain('[SECURITY ADVISORY]');
    } finally {
      if (prev === undefined) delete process.env.DEPENDENCY_ADVISORY_CHECK_DISABLED; else process.env.DEPENDENCY_ADVISORY_CHECK_DISABLED = prev;
    }
  });
});
