/**
 * build 2026-10-08 ISO — per-user subtree placement through the REAL
 * workspace.service (real git, file:// upstream, tmp volume root):
 *   - switch OFF → byte-identical legacy paths, the DB is never consulted;
 *   - switch ON (canary) → a NEW session's worktree lands in <root>/<userKey>/
 *     worktrees, a NEW project's mirror under the OWNER's key, git works, the
 *     dual-read resolvers + the reaper census find them;
 *   - "new sessions first": a recorded LEGACY path stays legacy; an existing
 *     legacy mirror stays where it is (a new per-user worktree links into it);
 *   - a reaped per-user worktree re-attaches on its branch; removeWorktree.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-ws-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
process.env.CODING_ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-env-'));

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) } }));

const sessions = new Map<string, { userId: string; worktreePath: string | null }>();
const projects = new Map<string, { userId: string }>();
const mockSessionFind = jest.fn(async (q: any) => sessions.get(q.where.id) ?? null);
const mockProjectFind = jest.fn(async (q: any) => projects.get(q.where.id) ?? null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { chatCodingState: { findUnique: (q: any) => mockSessionFind(q) }, crossModelProject: { findUnique: (q: any) => mockProjectFind(q) } },
}));
const mockRecord = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecord(...a),
  LOOP_METRIC_KINDS: { WORKSPACE_ISOLATION: 'workspace_isolation', WORKTREE_SNAPSHOT_COALESCED: 'x', WORKTREE_SNAPSHOT_FAILED: 'y' },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('./workspace.service') as typeof import('./workspace.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const layout = require('./workspace-layout') as typeof import('./workspace-layout');

const U = '808aeb11-2222-4333-8444-555566667777';
const V = 'aa870e33-0000-4000-8000-000000000001';
const KU = layout.userSubtreeKey(U);
const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
const flush = () => new Promise((r) => setTimeout(r, 0));
const placementRows = () => mockRecord.mock.calls.map((c) => c[0]).filter((r: any) => r.meta?.phase === 'placement');

let upstream: string;
beforeAll(() => {
  upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-up-'));
  git(['init', '-q', '-b', 'main'], upstream);
  git(['config', 'user.email', 't@example.com'], upstream);
  git(['config', 'user.name', 't'], upstream);
  fs.writeFileSync(path.join(upstream, 'a.txt'), 'hello\n');
  git(['add', '.'], upstream);
  git(['commit', '-q', '-m', 'init'], upstream);
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(upstream, { recursive: true, force: true });
});
beforeEach(() => {
  mockRecord.mockClear(); mockSessionFind.mockClear(); mockProjectFind.mockClear();
  delete process.env.CODING_WORKSPACE_PER_USER_SUBTREE;
  layout.__resetLayoutMemoForTest();
});

describe('switch OFF — today, byte-for-byte', () => {
  it('legacy paths, no DB lookup, no telemetry', async () => {
    sessions.set('s-off', { userId: U, worktreePath: null });
    projects.set('p-legacy', { userId: U });
    const wt = await ws.ensureWorktree('p-legacy', 's-off', upstream, 'main', 'digby/session-s-off', null);
    expect(wt).toBe(path.join(ROOT, 'worktrees', 's-off'));
    expect(ws.repoMirrorPath('p-legacy')).toBe(path.join(ROOT, 'repos', 'p-legacy.git'));
    expect(fs.existsSync(path.join(ROOT, 'repos', 'p-legacy.git'))).toBe(true);
    expect(mockSessionFind).not.toHaveBeenCalled();
    expect(mockProjectFind).not.toHaveBeenCalled();
    await flush();
    expect(placementRows()).toHaveLength(0);
    expect(layout.listSubtreeKeysSync(ROOT)).toEqual([]);
  });
});

describe('switch ON for a canary user', () => {
  beforeEach(() => { process.env.CODING_WORKSPACE_PER_USER_SUBTREE = U; });

  it('a NEW session + NEW project land in the user subtree; git works; resolvers + census find them', async () => {
    sessions.set('s-u1', { userId: U, worktreePath: null });
    projects.set('p-u', { userId: U });
    const wt = await ws.ensureWorktree('p-u', 's-u1', upstream, 'main', 'digby/session-s-u1', null);
    expect(wt).toBe(path.join(ROOT, KU, 'worktrees', 's-u1'));
    expect(fs.existsSync(path.join(ROOT, KU, 'repos', 'p-u.git'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'repos', 'p-u.git'))).toBe(false);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).toBe('digby/session-s-u1');
    expect(layout.mirrorOfWorktreeSync(wt)).toBe(path.join(ROOT, KU, 'repos', 'p-u.git'));
    layout.__resetLayoutMemoForTest(); // a different process: disk only
    expect(ws.worktreePath('s-u1')).toBe(wt);
    expect(ws.repoMirrorPath('p-u')).toBe(path.join(ROOT, KU, 'repos', 'p-u.git'));
    expect((await ws.listWorktreeDirsOnDisk())!.map((d) => d.sessionId)).toEqual(expect.arrayContaining(['s-u1', 's-off']));
    await flush();
    expect(placementRows().map((r: any) => [r.meta.what, r.meta.layout, r.meta.reason])).toEqual(expect.arrayContaining([
      ['mirror', 'per_user', 'new_per_user'], ['worktree', 'per_user', 'new_per_user'],
    ]));
  });

  it('an EXISTING legacy mirror stays put — the new per-user worktree links into it', async () => {
    sessions.set('s-u2', { userId: U, worktreePath: null });
    const wt = await ws.ensureWorktree('p-legacy', 's-u2', upstream, 'main', 'digby/session-s-u2', null);
    expect(wt).toBe(path.join(ROOT, KU, 'worktrees', 's-u2'));
    expect(layout.mirrorOfWorktreeSync(wt)).toBe(path.join(ROOT, 'repos', 'p-legacy.git'));
    expect(git(['rev-parse', 'HEAD'], wt)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a user OUTSIDE the canary keeps the legacy layout', async () => {
    sessions.set('s-v1', { userId: V, worktreePath: null });
    const wt = await ws.ensureWorktree('p-legacy', 's-v1', upstream, 'main', 'digby/session-s-v1', null);
    expect(wt).toBe(path.join(ROOT, 'worktrees', 's-v1'));
    await flush();
    expect(placementRows().find((r: any) => r.sessionId === 's-v1')?.meta).toMatchObject({ layout: 'legacy', reason: 'user_not_in_canary' });
  });

  it('new sessions first: a session RECORDED at a legacy path re-provisions there', async () => {
    sessions.set('s-u3', { userId: U, worktreePath: path.join(ROOT, 'worktrees', 's-u3') });
    const wt = await ws.ensureWorktree('p-legacy', 's-u3', upstream, 'main', 'digby/session-s-u3', null);
    expect(wt).toBe(path.join(ROOT, 'worktrees', 's-u3'));
  });

  it('a reaped per-user worktree (DB path nulled) re-attaches in the subtree on its own branch', async () => {
    sessions.set('s-u4', { userId: U, worktreePath: null });
    const wt = await ws.ensureWorktree('p-u', 's-u4', upstream, 'main', 'digby/session-s-u4', null);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'work\n');
    git(['add', '.'], wt);
    git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'], wt);
    const tip = git(['rev-parse', 'HEAD'], wt);
    await ws.removeWorktree('p-u', 's-u4');
    expect(fs.existsSync(wt)).toBe(false);
    const again = await ws.reattachWorktree('p-u', 's-u4', upstream, 'main', 'digby/session-s-u4', null, null);
    expect(again).toBe(wt);
    expect(git(['rev-parse', 'HEAD'], again)).toBe(tip);
  });

  it('a blank (standalone) worktree lands in the subtree too', async () => {
    sessions.set('s-u5', { userId: U, worktreePath: null });
    const wt = await ws.ensureBlankWorktree('s-u5', 'main', 'digby/session-s-u5', null);
    expect(wt).toBe(path.join(ROOT, KU, 'worktrees', 's-u5'));
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).toBe('digby/session-s-u5');
  });

  it('a DB failure falls back to the legacy layout (never blocks provisioning)', async () => {
    mockSessionFind.mockRejectedValueOnce(new Error('db down'));
    const wt = await ws.ensureWorktree('p-legacy', 's-u6', upstream, 'main', 'digby/session-s-u6', null);
    expect(wt).toBe(path.join(ROOT, 'worktrees', 's-u6'));
  });
});
