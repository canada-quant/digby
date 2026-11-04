/**
 * Replay test for ticket d6110694 (2026-09-28, owner report "shared workspaces
 * dont work and throw errors"): three shared-mirror defects pinned against
 * real git (no network — file:// remotes), one per prod error class observed
 * in the 17:00–18:30Z window on the spark-cluster/AGX projects:
 *
 *  A. Origin-less mirror under a github project: persistProjectRepo flips a
 *     'local' project to 'github' after the first push but never adds `origin`
 *     to the already-existing bare repo (prod 922fd3ad cql-agx-orin64 —
 *     "git remote set-url origin … error: No such remote 'origin'" 3× at
 *     17:47Z; the mirror NEVER refreshed again). ensureRepoMirror must heal
 *     by adding the remote.
 *  B. Token redaction: the same failure's logged message embeds the AUTHED
 *     URL (live GitHub OAuth token) — redactGitError must strip every
 *     credential shape before it reaches any log surface.
 *  C. Shallow-residue forever loop: a mirror whose shallow file holds a
 *     boundary UNREACHABLE from every ref (a squashed-PR lineage deleted on
 *     origin) makes `fetch --unshallow` exit 0 as a SILENT NO-OP — the file
 *     survives, the probe stays true, and the warn/unshallow pair repeats on
 *     every provision forever (prod 0560b7b8 spark-cluster: 16 pairs in 26h,
 *     boundary d6b1ea90 unreachable from all 64 local heads).
 *     unshallowMirrorIfNeeded must verify the heal landed and prune
 *     unreachable residue (deleting the file — an EMPTY file still reads as
 *     shallow, verified live on git 2.39/2.52).
 *
 * CODING_WORKSPACE_ROOT is overridden BEFORE the module is required (it is read
 * at module load), so the mirrors land in the tmp dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-d6110694-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// project-lock pulls config/redis → config/env (process.exit at import) —
// the same boundary mock the sibling suites use.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('./workspace.service') as typeof import('./workspace.service');

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

let upstream: string;

beforeAll(() => {
  // A real upstream with per-file history.
  upstream = path.join(ROOT, 'upstream');
  fs.mkdirSync(upstream);
  git(['init', '-q', '-b', 'main'], upstream);
  git(['config', 'user.email', 't@example.com'], upstream);
  git(['config', 'user.name', 't'], upstream);
  for (let i = 1; i <= 6; i++) {
    fs.writeFileSync(path.join(upstream, i % 2 ? 'a.txt' : 'b.txt'), `rev ${i}\n`);
    git(['add', '.'], upstream);
    git(['commit', '-qm', `commit ${i}`], upstream);
  }
}, 60_000);

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── A: origin-less local-born mirror under a github project ─────────────────

describe('d6110694-A: origin-less mirror heal', () => {
  const PROJECT = 'proj-originless';
  let mirror: string;

  beforeAll(() => {
    // Born exactly like the prod mirror: 'local' provider → git init --bare,
    // a seed commit — NO origin remote ever.
    mirror = path.join(ROOT, 'repos', `${PROJECT}.git`);
    fs.mkdirSync(mirror, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main'], mirror);
    git(['config', 'user.name', 'Digby'], mirror);
    git(['config', 'user.email', 'digby@digby.example.com'], mirror);
    // Seed a commit via a temp clone of the mirror itself (local-provider shape).
    const seed = path.join(ROOT, 'seed-clone');
    git(['clone', '-q', mirror, seed], ROOT);
    git(['config', 'user.email', 'digby@digby.example.com'], seed);
    git(['config', 'user.name', 'Digby'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# local-born\n');
    git(['add', '.'], seed);
    git(['commit', '-qm', 'chore: initialize Digby project workspace'], seed);
    git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], seed);
    fs.rmSync(seed, { recursive: true, force: true });
    // Premise: the provider is now 'github' (persistProjectRepo flipped it) but
    // the mirror still has no origin.
    expect(git(['remote'], mirror)).toBe('');
  }, 60_000);

  test('ensureRepoMirror ADDS the missing origin instead of dying on set-url', async () => {
    await ws.ensureRepoMirror(PROJECT, `file://${upstream}`, null);
    // The heal: origin now exists, pointing at the real upstream.
    const remotes = git(['remote', '-v'], mirror);
    expect(remotes).toContain('origin');
    expect(remotes).toContain('upstream');
    // And the refresh actually landed: upstream history is visible via the
    // demoted ref layout.
    expect(git(['rev-list', '--count', 'refs/remotes/origin/main'], mirror)).toBe('6');
  }, 60_000);

  test('a second ensure is a quiet no-op (origin present, no re-add)', async () => {
    await ws.ensureRepoMirror(PROJECT, `file://${upstream}`, null);
    expect(git(['remote'], mirror)).toBe('origin');
  }, 60_000);
});

// ── B: credential redaction in logged git errors ────────────────────────────

// The seam under test is the CENTRAL util (reviewer B-1 prescription: the
// branch's local redactGitError was deleted in favor of
// utils/redact-credentials; the workspace warn sites call it directly).
import { redactUrlCredentials as redact, hasUrlCredentials } from '../../../utils/redact-credentials';

// Synthetic credential fixtures are ASSEMBLED at runtime (prefix + body in
// separate literals) so the file's own bytes never contain a contiguous
// token-shaped string for the secret scanner to flag — and so no real
// credential can ever be pasted here by accident.
const tok = (prefix: string, body: string): string => `${prefix}_${body}`;

describe('d6110694-B: credential redaction strips the prod failure shapes', () => {
  test('redacts the x-access-token URL shape from the prod failure line', () => {
    const leaked = tok('gho', 'Synth3t1cT0kenForTest0nly1234567890');
    const prod = 'Command failed: git remote set-url origin ' +
      `https://x-access-token:${leaked}@github.com/canada-quant/cql-agx-orin64.git\n` +
      'error: No such remote \'origin\'';
    const red = redact(prod);
    expect(red).not.toContain(leaked);
    // Canonical util output: the userinfo slot (incl. user) is fully masked —
    // `//x-access-token:<token>@` → `//***@` (host + path + stderr kept).
    expect(red).toContain('https://***@github.com/canada-quant/cql-agx-orin64.git');
    expect(red).toContain('No such remote');
  });

  test('redacts bare gho_/ghp_/github_pat tokens anywhere in the text', () => {
    expect(redact(`token ${tok('gho', '16C7e42F292c6912E7710c838347Ae17')}`))
      .toBe('token gho_***');
    expect(redact(`token ${tok('ghp', 'abc123def456ghi789')}`))
      .toBe('token ghp_***');
    expect(redact(`token ${tok('github_pat', '11AAAAAA0a1b2c3d4e5f6')}`))
      .toBe('token github_pat_***');
  });

  test('redacts generic user:pass@ credentials (non-GitHub hosts)', () => {
    // Canonical util output: the whole userinfo slot is replaced with `***`
    // (user AND password) — `https://bob:hunter2@…` → `https://***@…`.
    expect(redact('https://bob:hunter2@example.com/repo.git'))
      .toBe('https://***@example.com/repo.git');
  });

  test('leaves clean error text untouched', () => {
    const clean = "fatal: repository 'https://github.com/a/b.git/' not found";
    expect(redact(clean)).toBe(clean);
    expect(hasUrlCredentials(clean)).toBe(false);
  });
});

// ── C: shallow-residue forever loop ─────────────────────────────────────────

describe('d6110694-C: unreachable shallow residue is pruned, not looped forever', () => {
  const PROJECT = 'proj-residue';
  let mirror: string;
  let deadTip: string;

  beforeAll(() => {
    // The prod state (box C spark mirror, boundary d6b1ea90, verified live):
    // the boundary commit OBJECT IS PRESENT, its object walk is intact, but it
    // is UNREACHABLE from every ref (92 refs checked incl. refs/digby-wip/*
    // and refs/bench/*; rev-list --count <boundary> --not --all = 1), and the
    // shallow file lists it — so the probe reads true forever while
    // `fetch --unshallow` exits 0 without clearing (git only clears entries it
    // deepens, and the server advertises no ref reaching the dead lineage).
    // Fabricate that exact state: a complete mirror + an unreachable-by-sha
    // fetch of a dead branch's tip + a shallow file listing it.
    const up = path.join(ROOT, 'up-dead');
    fs.mkdirSync(up);
    git(['init', '-q', '-b', 'main'], up);
    git(['config', 'user.email', 't@example.com'], up);
    git(['config', 'user.name', 't'], up);
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(up, 'a.txt'), `rev ${i}\n`);
      git(['add', '.'], up);
      git(['commit', '-qm', `commit ${i}`], up);
    }
    // The dead lineage: an orphan branch off main~3 (its own root).
    git(['checkout', '-q', '--orphan', 'dead'], up);
    git(['rm', '-rq', '--cached', '.'], up);
    fs.writeFileSync(path.join(up, 'pr.txt'), 'pr work\n');
    git(['add', 'pr.txt'], up);
    git(['commit', '-qm', 'dead lineage commit'], up);
    deadTip = git(['rev-parse', 'dead'], up);
    git(['checkout', '-q', '-f', 'main'], up);

    mirror = path.join(ROOT, 'repos', `${PROJECT}.git`);
    fs.mkdirSync(mirror, { recursive: true });
    git(['init', '-q', '--bare'], mirror);
    git(['remote', 'add', 'origin', `file://${up}`], mirror);
    git(['config', 'remote.origin.mirror', 'false'], mirror);
    git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], mirror);
    // Complete main history …
    git(['fetch', '-q', 'origin', 'main'], mirror);
    // … then the dead tip by raw sha: FETCH_HEAD only, no ref, object present.
    git(['fetch', '-q', `file://${up}`, deadTip], mirror);
    // Delete the dead branch upstream — the lineage becomes unfetchable.
    git(['branch', '-D', 'dead'], up);
    // Fabricate the residue: shallow file listing the unreachable tip.
    fs.writeFileSync(path.join(mirror, 'shallow'), `${deadTip}\n`);
    // Premise: probe reads shallow, no ref reaches the entry.
    expect(git(['rev-parse', '--is-shallow-repository'], mirror)).toBe('true');
    expect(git(['rev-list', '--count', deadTip, '--not', '--all'], mirror)).not.toBe('0');
  }, 60_000);

  test('ensureRepoMirror prunes the unreachable residue: probe false, file gone, history intact', async () => {
    // RED-DISCRIMINATING setup (M-1): run under WORKSPACE_UNSHALLOW_DISABLED so
    // the plain `fetch --unshallow` in this environment cannot mask the prod
    // pathology (the prod upstream advertises no ref reaching the dead
    // lineage, so a real unshallow is a silent no-op). With the fetch skipped,
    // only the residue verify/prune can clear the file.
    const prev = process.env.WORKSPACE_UNSHALLOW_DISABLED;
    process.env.WORKSPACE_UNSHALLOW_DISABLED = '1';
    try {
      await ws.ensureRepoMirror(PROJECT, `file://${path.join(ROOT, 'up-dead')}`, null);
      expect(git(['rev-parse', '--is-shallow-repository'], mirror)).toBe('false');
      expect(fs.existsSync(path.join(mirror, 'shallow'))).toBe(false);
      // Live-ref history is untouched by the prune.
      expect(git(['rev-list', '--count', 'refs/remotes/origin/main'], mirror)).toBe('4');
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_UNSHALLOW_DISABLED;
      else process.env.WORKSPACE_UNSHALLOW_DISABLED = prev;
    }
  }, 60_000);

  test('a REACHABLE boundary is never pruned (no over-prune) — and a mixed shallow file is pruned SELECTIVELY', async () => {
    // Fabricate the dangerous-looking state the fix must NOT prune: a shallow
    // file whose entry IS reachable from a live ref (a genuinely truncated
    // lineage). Point the mirror at a NEW upstream whose main has MORE
    // commits than the mirror holds, shallow-list the reachable boundary.
    const up2 = path.join(ROOT, 'up-reachable');
    fs.mkdirSync(up2);
    git(['init', '-q', '-b', 'main'], up2);
    git(['config', 'user.email', 't@example.com'], up2);
    git(['config', 'user.name', 't'], up2);
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(up2, 'a.txt'), `rev ${i}\n`);
      git(['add', '.'], up2);
      git(['commit', '-qm', `commit ${i}`], up2);
    }
    const p2 = 'proj-reachable';
    const m2 = path.join(ROOT, 'repos', `${p2}.git`);
    fs.mkdirSync(m2, { recursive: true });
    git(['init', '-q', '--bare'], m2);
    git(['remote', 'add', 'origin', `file://${up2}`], m2);
    git(['config', 'remote.origin.mirror', 'false'], m2);
    git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], m2);
    // Shallow fetch of main at depth 3: boundary = main~2, REACHABLE from origin/main.
    git(['fetch', '-q', '--depth=3', 'origin', 'main'], m2);
    const boundary = git(['rev-parse', 'refs/remotes/origin/main~2'], m2);
    expect(git(['rev-list', '--count', boundary, '--not', '--all'], m2)).toBe('0'); // premise: reachable
    expect(git(['rev-parse', '--is-shallow-repository'], m2)).toBe('true');

    // MIXED residue: append the unreachable dead tip from the first test as a
    // second shallow entry — the file lists BOTH a reachable boundary and a
    // dead entry. The prune must remove ONLY the dead one. (The dead object
    // must exist in m2's object store or every later rev-list probe 128s.)
    git(['fetch', '-q', `file://${path.join(ROOT, 'up-dead')}`, deadTip], m2);
    fs.appendFileSync(path.join(m2, 'shallow'), `${deadTip}\n`);
    expect(git(['rev-list', '--count', deadTip, '--not', '--all'], m2)).not.toBe('0'); // premise: dead entry is unreachable

    // Run the fix path with unshallow DISABLED (so only the prune logic runs —
    // this isolates the prune from the genuine deepen).
    const prev = process.env.WORKSPACE_UNSHALLOW_DISABLED;
    process.env.WORKSPACE_UNSHALLOW_DISABLED = '1';
    try {
      await ws.ensureRepoMirror(p2, `file://${up2}`, null);
      // The reachable boundary was NOT pruned: the file still lists it.
      expect(fs.existsSync(path.join(m2, 'shallow'))).toBe(true);
      expect(fs.readFileSync(path.join(m2, 'shallow'), 'utf8')).toContain(boundary);
      // The dead entry WAS pruned: it is gone from the file.
      expect(fs.readFileSync(path.join(m2, 'shallow'), 'utf8')).not.toContain(deadTip);
      expect(git(['rev-parse', '--is-shallow-repository'], m2)).toBe('true');
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_UNSHALLOW_DISABLED;
      else process.env.WORKSPACE_UNSHALLOW_DISABLED = prev;
    }
    // And with unshallow re-enabled the genuine heal still works (no residue left behind).
    await ws.ensureRepoMirror(p2, `file://${up2}`, null);
    expect(git(['rev-parse', '--is-shallow-repository'], m2)).toBe('false');
    expect(git(['rev-list', '--count', 'refs/remotes/origin/main'], m2)).toBe('6');
  }, 60_000);
});
