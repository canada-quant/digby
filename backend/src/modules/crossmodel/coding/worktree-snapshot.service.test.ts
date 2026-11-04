/**
 * Tests for the worktree snapshot store + publisher (feedback ticket 1c767622).
 *
 * The publisher runs against a REAL git repo in a tmp CODING_WORKSPACE_ROOT
 * (same idiom as worktree-files.test.ts): committed / modified / untracked /
 * ignored / deleted fixtures exercise the walk, the whole-repo porcelain badge
 * mapping, the ls-tree deleted-but-tracked merge, the ignore flags, and the
 * content budget. The reader/serving helpers (snapshotLevel,
 * normalizeSnapshotPath) are pure and tested directly against a synthetic
 * snapshot. Redis is an in-memory Map mock (instances.service.test.ts idiom).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-snap-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-snap-env-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/* In-memory Redis (same shape the instances/weather suites use) + TTL map,
 * SCAN/STRLEN/TTL/EXPIRE/SET-NX for the loop-#14 hygiene sweep. */
const redisStore = new Map<string, string>();
const redisTtl = new Map<string, number>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    setEx: jest.fn(async (k: string, ttl: number, v: string) => { redisStore.set(k, v); redisTtl.set(k, ttl); return 'OK'; }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { redisTtl.delete(k); return redisStore.delete(k) ? 1 : 0; }),
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      if (opts?.EX) redisTtl.set(k, opts.EX); else redisTtl.delete(k);
      return 'OK';
    }),
    scanIterator: (opts: { MATCH: string }) => {
      const prefix = opts.MATCH.replace(/\*$/, '');
      const keys = [...redisStore.keys()].filter((k) => k.startsWith(prefix));
      return (async function* () { for (const k of keys) yield k; })();
    },
    strLen: jest.fn(async (k: string) => (redisStore.get(k) ?? '').length),
    ttl: jest.fn(async (k: string) => (redisStore.has(k) ? (redisTtl.get(k) ?? -1) : -2)),
    expire: jest.fn(async (k: string, sec: number) => { if (!redisStore.has(k)) return false; redisTtl.set(k, sec); return true; }),
  },
}));

/* Loop metrics ride a dynamic import from the publisher — mock so the real
 * module's prisma import never loads here (loop #14 trim telemetry). */
const recordLoopMetric = jest.fn(async () => {});
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => (recordLoopMetric as any)(...a),
  LOOP_METRIC_KINDS: { WORKTREE_SNAPSHOT_TRIMMED: 'worktree_snapshot_trimmed', WORKTREE_SNAPSHOT_HYGIENE: 'worktree_snapshot_hygiene' },
}));

const wss = require('./worktree-snapshot.service') as typeof import('./worktree-snapshot.service');
type WorktreeSnapshot = import('./worktree-snapshot.service').WorktreeSnapshot;

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const CHAT = 'wtsnap-chat1';
const WT = path.join(ROOT, 'worktrees', CHAT);

beforeAll(() => {
  fs.mkdirSync(path.join(WT, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(WT, 'assets'), { recursive: true });
  git(['init', '-b', 'main'], WT);
  git(['config', 'user.email', 't@t'], WT);
  git(['config', 'user.name', 't'], WT);
  fs.writeFileSync(path.join(WT, 'README.md'), '# hello\n');
  fs.writeFileSync(path.join(WT, 'src', 'committed.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(WT, '.gitignore'), 'ignored-dir/\n*.log\n');
  git(['add', '-A'], WT);
  git(['commit', '-m', 'init'], WT);
  // Post-commit mutations:
  fs.writeFileSync(path.join(WT, 'src', 'committed.ts'), 'export const a = 2;\n'); // modified
  fs.writeFileSync(path.join(WT, 'src', 'new.ts'), 'new\n');                       // untracked
  fs.rmSync(path.join(WT, 'README.md'));                                          // deleted-but-tracked
  fs.mkdirSync(path.join(WT, 'ignored-dir'), { recursive: true });
  fs.writeFileSync(path.join(WT, 'ignored-dir', 'x.log'), 'x\n');                  // ignored
  fs.writeFileSync(path.join(WT, 'src', 'nested', 'deep.txt'), 'deep\n');
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(ENV_ROOT, { recursive: true, force: true });
});

describe('publishWorktreeSnapshot (ticket 1c767622)', () => {
  test('walks the tree, badges, flags ignored, carries content, records the branch', async () => {
    await wss.publishWorktreeSnapshot(CHAT);

    const snap = await wss.getWorktreeSnapshot(CHAT);
    expect(snap).not.toBeNull();
    expect(snap!.v).toBe(1);
    expect(snap!.branch).toBe('main');
    expect(typeof snap!.publishedAt).toBe('string');

    const byPath = new Map(snap!.entries.map(e => [e.path, e]));
    // .git / node_modules never appear
    for (const p of byPath.keys()) {
      expect(p.split('/').map((s: string) => s.toLowerCase())).not.toContain('.git');
      expect(p.split('/').map((s: string) => s.toLowerCase())).not.toContain('node_modules');
    }
    // modified / untracked / deleted badges
    expect(byPath.get('src/committed.ts')?.status).toBe('M');
    expect(byPath.get('src/new.ts')?.status).toBe('?');
    expect(byPath.get('README.md')?.status).toBe('D');
    expect(byPath.get('README.md')?.type).toBe('file');
    // nested + ignored
    expect(byPath.get('src/nested/deep.txt')?.type).toBe('file');
    expect(byPath.get('ignored-dir')?.ignored).toBe(true);
    expect(byPath.get('src')?.type).toBe('dir');
    // content: text file present as base64-decodable utf8
    expect(Buffer.from(snap!.files['src/new.ts'], 'base64').toString('utf8')).toBe('new\n');
    expect(snap!.files['src/nested/deep.txt']).toBeDefined();
    expect(snap!.truncated).toBe(false);
    // mtime (owner 2026-09-17): files AND dirs carry a last-modified epoch-ms
    // stamp so the Files tab can show it and sort most-recent first; a
    // deleted-but-tracked row has nothing on disk to stat, so none.
    expect(typeof byPath.get('src/new.ts')?.mtime).toBe('number');
    expect(typeof byPath.get('src')?.mtime).toBe('number');
    expect(byPath.get('src/new.ts')!.mtime!).toBeGreaterThan(Date.now() - 24 * 3600_000);
    expect(byPath.get('README.md')?.mtime).toBeUndefined();
  });

  test('republish reflects disk changes (idempotent refresh)', async () => {
    fs.writeFileSync(path.join(WT, 'src', 'new.ts'), 'changed\n');
    await wss.publishWorktreeSnapshot(CHAT);
    const snap = await wss.getWorktreeSnapshot(CHAT);
    expect(Buffer.from(snap!.files['src/new.ts'], 'base64').toString('utf8')).toBe('changed\n');
  });

  test('no-ops (no throw, no key) when the worktree is not on this box', async () => {
    await expect(wss.publishWorktreeSnapshot('wtsnap-not-on-this-box')).resolves.toBeUndefined();
    expect(await wss.getWorktreeSnapshot('wtsnap-not-on-this-box')).toBeNull();
  });

  test('getWorktreeSnapshot returns null for a corrupt payload', async () => {
    redisStore.set('cm:wt-snap:wtsnap-corrupt', '{not json');
    expect(await wss.getWorktreeSnapshot('wtsnap-corrupt')).toBeNull();
    redisStore.set('cm:wt-snap:wtsnap-wrongv', JSON.stringify({ v: 99, entries: [] }));
    expect(await wss.getWorktreeSnapshot('wtsnap-wrongv')).toBeNull();
  });

  test('deleteWorktreeSnapshot drops the key', async () => {
    await wss.publishWorktreeSnapshot(CHAT);
    expect(await wss.getWorktreeSnapshot(CHAT)).not.toBeNull();
    await wss.deleteWorktreeSnapshot(CHAT);
    expect(await wss.getWorktreeSnapshot(CHAT)).toBeNull();
  });

  /* ── Review round-1 BLOCKING findings (empirically proven) — regression pins ── */

  test('SECURITY: an outside-worktree symlink is never followed, listed, or published (review B1)', async () => {
    const SECRET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-snap-secret-'));
    try {
      const secretFile = path.join(SECRET_DIR, 'TOPSECRET.txt');
      fs.writeFileSync(secretFile, 'TOPSECRET-OUTSIDE-CONTENT\n');
      // Absolute symlink OUTSIDE the worktree + a relative escape + a .git link.
      fs.symlinkSync(secretFile, path.join(WT, 'leak-abs'));
      fs.symlinkSync('../../outside', path.join(WT, 'leak-rel'));
      fs.symlinkSync('.git/config', path.join(WT, 'leak-git'));

      await wss.publishWorktreeSnapshot(CHAT);
      const snap = await wss.getWorktreeSnapshot(CHAT);
      expect(snap).not.toBeNull();
      const paths = snap!.entries.map(e => e.path);
      expect(paths).not.toContain('leak-abs');
      expect(paths).not.toContain('leak-rel');
      expect(paths).not.toContain('leak-git');
      // And absolutely no outside content anywhere in the payload.
      const raw = JSON.stringify(snap);
      expect(raw).not.toContain('TOPSECRET-OUTSIDE-CONTENT');
      expect(raw).not.toContain('repositoryformatversion'); // .git/config content
    } finally {
      fs.rmSync(SECRET_DIR, { recursive: true, force: true });
    }
  });

  test('SECURITY: a FIFO and a device symlink cannot hang or blow up the publish (review B2)', async () => {
    const FIFO_CHAT = 'wtsnap-fifo';
    const FWT = path.join(ROOT, 'worktrees', FIFO_CHAT);
    fs.mkdirSync(FWT, { recursive: true });
    fs.writeFileSync(path.join(FWT, 'normal.txt'), 'normal\n');
    // A FIFO: stat size 0 passes a size-only gate; readFile on it never
    // resolves. The publish must complete anyway (lstat isFile gate).
    try {
      const { execFileSync: ex } = require('child_process');
      ex('mkfifo', [path.join(FWT, 'pipe')]);
    } catch {
      // mkfifo unavailable — synthesize the same hazard via a device symlink
      fs.symlinkSync('/dev/zero', path.join(FWT, 'pipe'));
    }

    // Bounded wait: the pre-fix code HANGS here (proven by the reviewer).
    await Promise.race([
      wss.publishWorktreeSnapshot(FIFO_CHAT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('publish hung >3s on a FIFO')), 3000)),
    ]);
    const snap = await wss.getWorktreeSnapshot(FIFO_CHAT);
    expect(snap).not.toBeNull();
    expect(snap!.entries.map(e => e.path)).toEqual(['normal.txt']);
    expect(snap!.files['normal.txt']).toBeDefined();
  });

  /* ── Containment regression pin (2026-11-03, todo bbf8dc5f) ──────────────
   *
   * execGit runs git under a whitelist env. That whitelist dropped
   * GIT_CEILING_DIRECTORIES — the ceiling jest.global-setup.js sets at the
   * durable tmp root precisely so repo discovery cannot ascend out of a
   * fixture. Measured before the fix, from a dir with no `.git`:
   *   git rev-parse --show-toplevel  → the ENCLOSING digby checkout (exit 0)
   *   git status --porcelain         → the OUTER repo's own untracked files
   * and with the ceiling forwarded:
   *   git rev-parse --show-toplevel  → fatal: not a git repository (exit 128)
   *
   * So a git-less session worktree had the enclosing checkout's branch,
   * ignore verdicts and deletions merged into ITS snapshot — foreign repo
   * data served back to a different session, and ~1 s of extra scanning per
   * publish once node_modules is installed.
   *
   * This pin fails if the ceiling stops being forwarded: `branch` would come
   * back populated from the outer repo instead of absent.
   */
  test('SECURITY: a git-less worktree never reports the ENCLOSING repo (containment pin)', async () => {
    const NOGIT_CHAT = 'wtsnap-nogit';
    const NGT = path.join(ROOT, 'worktrees', NOGIT_CHAT);
    fs.mkdirSync(NGT, { recursive: true });
    fs.writeFileSync(path.join(NGT, 'only-here.txt'), 'mine\n');

    // Precondition — the fixture really is outside any repo of its own, and
    // it genuinely sits BELOW a repo (this test file runs from one). Without
    // that, the assertion below would pass vacuously.
    expect(fs.existsSync(path.join(NGT, '.git'))).toBe(false);

    await wss.publishWorktreeSnapshot(NOGIT_CHAT);
    const snap = await wss.getWorktreeSnapshot(NOGIT_CHAT);
    expect(snap).not.toBeNull();

    // The whole point: no branch label from the enclosing repo.
    expect(snap!.branch).toBeUndefined();
    // It lists exactly its own file — nothing merged in from the outer repo.
    expect(snap!.entries.map(e => e.path)).toEqual(['only-here.txt']);
    // And no outer-repo path can appear anywhere in the payload.
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain('.jest-tmp');
    expect(raw).not.toContain('worktree-snapshot.service.test');
  });

  test('SECURITY: a tracked file under a symlinked PARENT dir is never published (review round-2 B1 — lstat-only guards follow intermediate links)', async () => {
    // The exact probe the reviewer proved: commit foo/secret.txt, then swap
    // the parent for a symlink to an outside dir containing same-named files.
    const SNAP2 = 'wtsnap-parentsym';
    const W2 = path.join(ROOT, 'worktrees', SNAP2);
    fs.rmSync(W2, { recursive: true, force: true });
    fs.mkdirSync(path.join(W2, 'foo'), { recursive: true });
    git(['init', '-b', 'main'], W2);
    git(['config', 'user.email', 't@t'], W2);
    git(['config', 'user.name', 't'], W2);
    fs.writeFileSync(path.join(W2, 'foo', 'secret.txt'), 'committed-content\n');
    git(['add', '-A'], W2);
    git(['commit', '-m', 'init'], W2);
    // Swap the parent for an outside symlink.
    const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-snap-outside-'));
    try {
      fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'ROOT-SECRET-HOST-CONTENT-x9z\n');
      fs.rmSync(path.join(W2, 'foo'), { recursive: true, force: true });
      fs.symlinkSync(OUTSIDE, path.join(W2, 'foo'));

      await wss.publishWorktreeSnapshot(SNAP2);
      const snap = await wss.getWorktreeSnapshot(SNAP2);
      expect(snap).not.toBeNull();
      // foo/secret.txt is tracked-but-missing → git reports D; the pre-fix
      // D-merge re-added it and lstat(path.join(root,'foo/secret.txt'))
      // FOLLOWED the foo symlink → published the OUTSIDE file's bytes.
      const raw = JSON.stringify(snap);
      expect(raw).not.toContain('ROOT-SECRET-HOST-CONTENT-x9z');
      expect(snap!.files['foo/secret.txt']).toBeUndefined();
    } finally {
      fs.rmSync(OUTSIDE, { recursive: true, force: true });
    }
  });
});

describe('normalizeSnapshotPath (ticket 1c767622)', () => {
  test.each([
    ['', ''],
    ['src', 'src'],
    ['src/nested', 'src/nested'],
    ['./src//nested/', 'src/nested'],
  ])('%p → %p', (input, expected) => {
    expect(wss.normalizeSnapshotPath(input as string)).toBe(expected);
  });

  test.each([
    ['..'],
    ['a/../..'],
    ['/abs'],
    ['C:/x'],
    ['a\\b'],
    ['a\0b'],
    ['.git/config'],
    ['src/.git'],
    ['node_modules/x'],
    ['src/node_modules'],
  ])('rejects %p', (input) => {
    expect(() => wss.normalizeSnapshotPath(input as string)).toThrow();
  });
});

describe('snapshotLevel (ticket 1c767622)', () => {
  const snap: WorktreeSnapshot = {
    v: 1,
    publishedAt: '2026-09-12T00:00:00.000Z',
    entries: [
      { path: 'zebra.ts', name: 'zebra.ts', type: 'file' },
      { path: 'alpha', name: 'alpha', type: 'dir' },
      { path: 'alpha/beta.ts', name: 'beta.ts', type: 'file' },
      { path: 'alpha/gamma', name: 'gamma', type: 'dir' },
      { path: 'alpha/gamma/deep.txt', name: 'deep.txt', type: 'file' },
      { path: 'beta.md', name: 'beta.md', type: 'file' },
      { path: 'skip.log', name: 'skip.log', type: 'file', ignored: true },
      { path: 'ignored-dir', name: 'ignored-dir', type: 'dir', ignored: true },
      { path: 'ignored-dir/x.log', name: 'x.log', type: 'file', ignored: true },
    ],
    files: {},
    truncated: true,
  };

  test('root level: direct children only, dirs before files, codepoint order', () => {
    const { entries, truncated } = wss.snapshotLevel(snap, '', false);
    expect(entries.map(e => e.path)).toEqual(['alpha', 'beta.md', 'zebra.ts']);
    expect(truncated).toBe(true);
  });

  test('showIgnored=1 keeps ignored entries', () => {
    const { entries } = wss.snapshotLevel(snap, '', true);
    expect(entries.map(e => e.path)).toEqual(['alpha', 'ignored-dir', 'beta.md', 'skip.log', 'zebra.ts']);
  });

  test('nested level filters to that dir', () => {
    const { entries } = wss.snapshotLevel(snap, 'alpha', false);
    expect(entries.map(e => e.path)).toEqual(['alpha/gamma', 'alpha/beta.ts']);
  });

  test('deep level', () => {
    const { entries } = wss.snapshotLevel(snap, 'alpha/gamma', false);
    expect(entries.map(e => e.path)).toEqual(['alpha/gamma/deep.txt']);
  });

  test('empty level', () => {
    const { entries } = wss.snapshotLevel(snap, 'nothing', false);
    expect(entries).toEqual([]);
  });
});

/* ── Redis byte ceiling (autonomy loop #14, 2026-09-21) ───────────────────── */
describe('fitSnapshotToCeiling — the serialized snapshot never exceeds the Redis ceiling', () => {
  const mk = (n: number, bodyBytes: number): WorktreeSnapshot => {
    const entries: any[] = [];
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const depth = i % 4; // paths at depth 1..4
      const p = ['a', 'b', 'c', 'd'].slice(0, depth).concat(`f${i}.ts`).join('/');
      entries.push({ path: p, name: `f${i}.ts`, type: 'file', size: bodyBytes, mtime: 1758400000000 + i, status: 'M' });
      if (i % 3 === 0) files[p] = Buffer.alloc(bodyBytes, 97).toString('base64');
    }
    return { v: 1, origin: 'run', publishedAt: '2026-09-21T00:00:00.000Z', entries, files, truncated: false };
  };

  it('a snapshot under the ceiling is returned byte-identical (no trim, no metric-worthy change)', () => {
    const snap = mk(20, 100);
    const fit = wss.fitSnapshotToCeiling(snap, 1024 * 1024);
    expect(fit.droppedFiles).toBe(0);
    expect(fit.cutEntries).toBe(0);
    expect(fit.json).toBe(JSON.stringify(snap));
    expect(fit.snapshot).toBe(snap);
  });

  it('drops file BODIES first (largest first) and keeps the whole tree when that suffices', () => {
    const snap = mk(60, 4000); // tree ~7 KB, bodies 20 × 5.3 KB b64 ≈ 107 KB
    const ceiling = 40 * 1024;
    const fit = wss.fitSnapshotToCeiling(snap, ceiling);
    expect(fit.json.length).toBeLessThanOrEqual(ceiling);
    expect(fit.droppedFiles).toBeGreaterThan(0);
    expect(fit.cutEntries).toBe(0);
    expect(fit.snapshot.entries).toHaveLength(60);
    expect(fit.snapshot.truncated).toBe(false);
    expect(Object.keys(fit.snapshot.files).length).toBe(20 - fit.droppedFiles);
    expect(JSON.parse(fit.json).entries).toHaveLength(60);
  });

  it('then cuts the DEEPEST entries, flips truncated:true, and the shallow levels stay complete', () => {
    const snap = mk(2000, 10); // tree alone ≈ 250 KB
    const ceiling = 64 * 1024;
    const fit = wss.fitSnapshotToCeiling(snap, ceiling);
    expect(fit.json.length).toBeLessThanOrEqual(ceiling);
    expect(fit.snapshot.files).toEqual({});
    expect(fit.cutEntries).toBeGreaterThan(0);
    expect(fit.snapshot.truncated).toBe(true);
    const kept = fit.snapshot.entries;
    const depth = (p: string) => p.split('/').length;
    const maxKeptDepth = Math.max(...kept.map((e) => depth(e.path)));
    // every entry shallower than the deepest kept level survived in full
    const shallowTotal = snap.entries.filter((e) => depth(e.path) < maxKeptDepth).length;
    expect(kept.filter((e) => depth(e.path) < maxKeptDepth)).toHaveLength(shallowTotal);
    expect(JSON.parse(fit.json)).toEqual(fit.snapshot);
    expect(fit.before).toBeGreaterThan(fit.after);
  });

  it('snapshotMaxBytes: default 384 KB; env override honoured above the 16 KB floor', () => {
    delete process.env.WORKTREE_SNAPSHOT_MAX_BYTES;
    expect(wss.snapshotMaxBytes()).toBe(384 * 1024);
    process.env.WORKTREE_SNAPSHOT_MAX_BYTES = '65536';
    expect(wss.snapshotMaxBytes()).toBe(65536);
    process.env.WORKTREE_SNAPSHOT_MAX_BYTES = '100'; // below floor → default
    expect(wss.snapshotMaxBytes()).toBe(384 * 1024);
    process.env.WORKTREE_SNAPSHOT_MAX_BYTES = 'nope';
    expect(wss.snapshotMaxBytes()).toBe(384 * 1024);
    delete process.env.WORKTREE_SNAPSHOT_MAX_BYTES;
  });

  it('TTL is the 7-day idle-reap horizon (was 30 d — the 238 MB pile that evicted run locks)', () => {
    expect(wss.SNAPSHOT_TTL_SEC).toBe(7 * 24 * 3600);
  });

  it('publishWorktreeSnapshot persists the FITTED json under the ceiling and records worktree_snapshot_trimmed', async () => {
    process.env.WORKTREE_SNAPSHOT_MAX_BYTES = String(16 * 1024);
    recordLoopMetric.mockClear();
    try {
      // Pad the fixture repo so the tree + bodies exceed 16 KB.
      for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(WT, 'src', 'nested', `pad-${i}.txt`), `pad ${i}\n`.repeat(40));
      await wss.publishWorktreeSnapshot(CHAT, 'run');
      const raw = redisStore.get(`cm:wt-snap:${CHAT}`)!;
      expect(raw.length).toBeLessThanOrEqual(16 * 1024);
      const snap = JSON.parse(raw) as WorktreeSnapshot;
      expect(snap.v).toBe(1);
      expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'worktree_snapshot_trimmed', sessionId: CHAT,
        meta: expect.objectContaining({ after: raw.length, origin: 'run' }),
      }));
      const call = (recordLoopMetric.mock.calls[0] as any[])[0];
      expect(call.meta.before).toBeGreaterThan(call.meta.after);
      expect(call.meta.droppedFiles + call.meta.cutEntries).toBeGreaterThan(0);
    } finally {
      delete process.env.WORKTREE_SNAPSHOT_MAX_BYTES;
      for (let i = 0; i < 120; i++) fs.rmSync(path.join(WT, 'src', 'nested', `pad-${i}.txt`), { force: true });
    }
  });
});

/* ── Hygiene sweep over the EXISTING pile (autonomy loop #14) ──────────────── */
describe('sweepSnapshotHygiene — re-fits oversized live snapshots and clamps 30 d TTLs to 7 d', () => {
  const big = (n: number): string => {
    const entries: any[] = [];
    for (let i = 0; i < n; i++) entries.push({ path: `dir${i % 7}/sub/f${i}.ts`, name: `f${i}.ts`, type: 'file', size: 10, mtime: 1758400000000 + i });
    return JSON.stringify({ v: 1, origin: 'run', publishedAt: '2026-09-01T00:00:00.000Z', entries, files: { 'dir0/sub/f0.ts': Buffer.alloc(3000, 98).toString('base64') }, truncated: false });
  };
  const DAY = 86400;

  beforeEach(() => {
    for (const k of [...redisStore.keys()]) if (k.startsWith('cm:wt-snap:') || k.startsWith('cm:wtsnap-hygiene:')) { redisStore.delete(k); redisTtl.delete(k); }
    recordLoopMetric.mockClear();
    process.env.WORKTREE_SNAPSHOT_MAX_BYTES = String(16 * 1024);
  });
  afterAll(() => { delete process.env.WORKTREE_SNAPSHOT_MAX_BYTES; });

  it('oversized + long-TTL → refitted under the ceiling with TTL clamped; small long-TTL → clamped only; small short-TTL → untouched; legacy junk → TTL clamped, payload left', async () => {
    redisStore.set('cm:wt-snap:over', big(1500)); redisTtl.set('cm:wt-snap:over', 29 * DAY);       // 1.65 MB-class
    redisStore.set('cm:wt-snap:small-long', big(20)); redisTtl.set('cm:wt-snap:small-long', 25 * DAY);
    redisStore.set('cm:wt-snap:small-short', big(20)); redisTtl.set('cm:wt-snap:small-short', 3 * DAY);
    redisStore.set('cm:wt-snap:junk', 'x'.repeat(20 * 1024)); redisTtl.set('cm:wt-snap:junk', 28 * DAY);
    expect(redisStore.get('cm:wt-snap:over')!.length).toBeGreaterThan(16 * 1024);

    const r = await wss.sweepSnapshotHygiene();
    expect(r).not.toBeNull();
    expect(r!.scanned).toBe(4);
    expect(r!.oversized).toBe(2);
    expect(r!.refitted).toBe(1);
    expect(r!.unparseable).toBe(1);
    expect(r!.ttlClamped).toBe(3); // over, small-long, junk
    expect(r!.bytesFreed).toBeGreaterThan(0);

    const over = redisStore.get('cm:wt-snap:over')!;
    expect(over.length).toBeLessThanOrEqual(16 * 1024);
    const snap = JSON.parse(over) as WorktreeSnapshot;
    expect(snap.truncated).toBe(true);
    expect(snap.files).toEqual({});
    expect(redisTtl.get('cm:wt-snap:over')).toBe(7 * DAY);
    expect(redisTtl.get('cm:wt-snap:small-long')).toBe(7 * DAY);
    expect(redisStore.get('cm:wt-snap:small-long')).toBe(big(20)); // payload untouched
    expect(redisTtl.get('cm:wt-snap:small-short')).toBe(3 * DAY);   // shorter than 7 d stays
    expect(redisStore.get('cm:wt-snap:junk')).toBe('x'.repeat(20 * 1024));
    expect(redisTtl.get('cm:wt-snap:junk')).toBe(7 * DAY);
  });

  it('a snapshot whose remaining TTL is already under 7 d keeps that shorter TTL when re-fitted', async () => {
    redisStore.set('cm:wt-snap:over2', big(1500)); redisTtl.set('cm:wt-snap:over2', 2 * DAY);
    const r = await wss.sweepSnapshotHygiene({ force: true });
    expect(r!.refitted).toBe(1);
    expect(r!.ttlClamped).toBe(0);
    expect(redisTtl.get('cm:wt-snap:over2')).toBe(2 * DAY);
  });

  it('runs ONCE per interval fleet-wide: the second call finds the NX lock held and returns null; force bypasses it', async () => {
    redisStore.set('cm:wt-snap:a', big(20)); redisTtl.set('cm:wt-snap:a', 25 * DAY);
    expect(await wss.sweepSnapshotHygiene()).not.toBeNull();
    expect(redisTtl.get('cm:wtsnap-hygiene:lock')).toBe(wss.SNAPSHOT_HYGIENE_INTERVAL_SEC);
    expect(await wss.sweepSnapshotHygiene()).toBeNull();
    expect(await wss.sweepSnapshotHygiene({ force: true })).not.toBeNull();
  });

  it('a nothing-to-do pass records no metric', async () => {
    redisStore.set('cm:wt-snap:ok', big(20)); redisTtl.set('cm:wt-snap:ok', 5 * DAY);
    const r = await wss.sweepSnapshotHygiene({ force: true });
    expect(r).toEqual(expect.objectContaining({ scanned: 1, refitted: 0, ttlClamped: 0 }));
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });
});
