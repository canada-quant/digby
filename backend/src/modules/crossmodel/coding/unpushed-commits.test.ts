/**
 * audit 2026-10-06 T7-8 — commits stranded on a local session branch are
 * measured at run end (real git), stamped for the status card and named in
 * ONE harness line when this run moved HEAD.
 */

const mockStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { mockStore.set(`${ns.join('/')}::${key}`, v); }),
}));

import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { measureUnpushed, unpushedCommitsAtRunEnd, unpushedNoteLine, readUnpushedStamp, recordPushedSha, readPushedShas } from './unpushed-commits';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() };
const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV });

let root: string; let origin: string; let wt: string; let lone: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 't7-unpushed-'));
  origin = path.join(root, 'origin.git'); wt = path.join(root, 'wt'); lone = path.join(root, 'lone');
  g(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  g(root, ['clone', '-q', origin, wt]);
  await fs.writeFile(path.join(wt, 'a.md'), 'a\n');
  g(wt, ['add', '-A']); g(wt, ['commit', '-q', '-m', 'c1']); g(wt, ['push', '-q', 'origin', 'HEAD:main']);
  g(wt, ['checkout', '-q', '-b', 'digby/session-x']);
  g(root, ['init', '-q', '-b', 'main', lone]); // a repo with NO remote
  await fs.writeFile(path.join(lone, 'b.md'), 'b\n');
  g(lone, ['add', '-A']); g(lone, ['commit', '-q', '-m', 'only']);
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }).catch(() => undefined); delete process.env.UNPUSHED_COMMITS_NOTE_DISABLED; });
beforeEach(() => { mockStore.clear(); delete process.env.UNPUSHED_COMMITS_NOTE_DISABLED; });

describe('measureUnpushed (real git)', () => {
  it('0 after a push; N for commits on a local branch; null without any remote', async () => {
    expect((await measureUnpushed(wt))?.count).toBe(0);
    await fs.writeFile(path.join(wt, 'docs.md'), 'fix\n');
    g(wt, ['add', '-A']); g(wt, ['commit', '-q', '-m', 'docs: clear stale claim']);
    const m = await measureUnpushed(wt);
    expect(m).toMatchObject({ count: 1, branch: 'digby/session-x' });
    expect(m!.headSha).toMatch(/^[0-9a-f]{8}$/);
    expect(await measureUnpushed(lone)).toBeNull();
    expect(await measureUnpushed(path.join(root, 'nope'))).toBeNull();
  });
});

describe('unpushedCommitsAtRunEnd', () => {
  it('names the stranded commit ONCE (until HEAD moves again), stamps the state, clears after a push', async () => {
    const first = await unpushedCommitsAtRunEnd({ sessionId: 's1', worktree: wt });
    expect(first.line).toContain('1 local commit on digby/session-x NOT pushed to origin');
    expect((await readUnpushedStamp('s1'))?.count).toBe(1);
    const again = await unpushedCommitsAtRunEnd({ sessionId: 's1', worktree: wt });
    expect(again.line).toBeNull(); // a steady lane is not re-told every firing
    g(wt, ['push', '-q', 'origin', 'digby/session-x']);
    const pushed = await unpushedCommitsAtRunEnd({ sessionId: 's1', worktree: wt });
    expect(pushed.line).toBeNull();
    expect((await readUnpushedStamp('s1'))?.count).toBe(0);
  });

  // ── Ticket 6d7b379f — a typed local-commit declaration suppresses the nag ──

  it('6d7b379f: a well-formed claims block declaring the stranded sha as a `commit` entry suppresses the note (the state stamp still records the truth)', async () => {
    await fs.writeFile(path.join(wt, 'fix2.md'), 'fix\n');
    g(wt, ['add', '-A']); g(wt, ['commit', '-q', '-m', 'the banked fix']);
    const head = g(wt, ['rev-parse', '--short=8', 'HEAD']).trim();
    const finalText = [
      'The fix is banked locally — push refused by the open gate; not claimed as pushed.',
      '```claims',
      `[{"type":"commit","ref":"${head}","note":"banked on the session branch, push refused — local, not pushed"}]`,
      '```',
    ].join('\n');
    const out = await unpushedCommitsAtRunEnd({ sessionId: 's6d', worktree: wt, finalText });
    expect(out.line).toBeNull(); // the disclosure was already made in typed form
    expect(out.state?.count).toBe(1); // the stamp still says 1 unpushed
    expect((await readUnpushedStamp('s6d'))?.count).toBe(1);
  });

  it('6d7b379f: the full 40-char sha in the entry suppresses too (prefix match either way)', async () => {
    const full = g(wt, ['rev-parse', 'HEAD']).trim();
    const finalText = 'Banked.\n```claims\n' + JSON.stringify([{ type: 'commit', ref: full }]) + '\n```';
    expect((await unpushedCommitsAtRunEnd({ sessionId: 's6d-full', worktree: wt, finalText })).line).toBeNull();
  });

  it('6d7b379f: NO claims block (the disclosure was never made) → the note still fires', async () => {
    await fs.writeFile(path.join(wt, 'fix3.md'), 'fix\n');
    g(wt, ['add', '-A']); g(wt, ['commit', '-q', '-m', 'undeclared']);
    const out = await unpushedCommitsAtRunEnd({ sessionId: 's6d-none', worktree: wt, finalText: 'Banked a commit.' });
    expect(out.line).toContain('NOT pushed to origin');
  });

  it('6d7b379f: a block naming a DIFFERENT sha does not suppress — partial/false disclosure is not disclosure', async () => {
    const out = await unpushedCommitsAtRunEnd({
      sessionId: 's6d-wrong', worktree: wt,
      finalText: '```claims\n[{"type":"commit","ref":"deadbeef9"}]\n```',
    });
    expect(out.line).toContain('NOT pushed to origin');
  });

  it('6d7b379f: a MALFORMED block never suppresses (it verified nothing)', async () => {
    const out = await unpushedCommitsAtRunEnd({
      sessionId: 's6d-malf', worktree: wt,
      finalText: '```claims\n[{"type":"committ","ref":"x"}]\n```', // unknown type → malformed
    });
    expect(out.line).toContain('NOT pushed to origin');
  });

  it('6d7b379f: a MULTI-commit strand still gets the note (naming the tip discloses the tip only)', async () => {
    await fs.writeFile(path.join(wt, 'f4.md'), 'a\n');
    g(wt, ['add', '-A']); g(wt, ['commit', '-q', '-m', 'one more']);
    const head = g(wt, ['rev-parse', '--short=8', 'HEAD']).trim();
    const before = (await measureUnpushed(wt))?.count ?? 0;
    expect(before).toBeGreaterThanOrEqual(2); // the shared worktree already holds earlier test commits
    const out = await unpushedCommitsAtRunEnd({
      sessionId: 's6d-multi', worktree: wt,
      finalText: '```claims\n' + JSON.stringify([{ type: 'commit', ref: head }]) + '\n```',
    });
    expect(out.line).toContain(`${before} local commits`);
    expect(out.state?.count).toBe(before);
  });

  it('UNPUSHED_COMMITS_NOTE_DISABLED=1: no git read, no stamp, no line', async () => {
    process.env.UNPUSHED_COMMITS_NOTE_DISABLED = '1';
    expect(await unpushedCommitsAtRunEnd({ sessionId: 's2', worktree: wt })).toEqual({ line: null, state: null });
    expect(mockStore.size).toBe(0);
  });

  it('the line wording', () => {
    expect(unpushedNoteLine({ count: 2, headSha: '07d91d2f', branch: null, at: '' })).toBe('⚠ HARNESS NOTE: 2 local commits NOT pushed to origin (HEAD 07d91d2f) — nobody else can see them. Push and open a PR (git_push / open_pull_request), or say in one line why they stay local; never cite a local sha as landed work.');
  });
});

describe('audit 2026-10-08 W2-2 — a sha git_push published is never "unpushed" (lanes.md F3)', () => {
  // REPLAY of c742c817 / fd1e3be3: git_push publishes to an authenticated URL
  // (`git push <url> HEAD:refs/heads/<branch>`), which never moves
  // refs/remotes/origin/*. The run-end note then said "N local commits … NOT
  // pushed (HEAD <the sha the push receipt names>)".
  // git ≥2.56 changed that: a URL push matching a CONFIGURED remote now
  // opportunistically updates refs/remotes/origin/<branch> (2.55 and older
  // never did), so the remotes-only count read 0 and CI went red on the
  // 2026-10-27 runner-image roll (runner git 2.55.0 → 2.56.0, CI run
  // 40509843111, deploy run 40509843174). The beforeAll forces the
  // historical shape back and the first test guards it, so the replay stays
  // version-stable.
  let wt2: string;
  beforeAll(async () => {
    wt2 = path.join(root, 'wt2');
    g(root, ['clone', '-q', origin, wt2]);
    g(wt2, ['checkout', '-q', '-b', 'digby/session-y']);
    for (const n of [1, 2, 3]) {
      await fs.writeFile(path.join(wt2, `f${n}.md`), `${n}\n`);
      g(wt2, ['add', '-A']); g(wt2, ['commit', '-q', '-m', `c${n}`]);
    }
    // The git_push shape: publish to a URL (here a path), NOT the remote name.
    g(wt2, ['push', '-q', origin, 'HEAD:refs/heads/digby/session-y']);
    // Force the historical shape: git ≥2.56 may have created the tracking ref
    // for that URL push (see above) — drop it so the remotes-only baseline is
    // the one this replay was written against, on every git version.
    try {
      g(wt2, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/digby/session-y']);
      g(wt2, ['update-ref', '-d', 'refs/remotes/origin/digby/session-y']);
    } catch { /* git ≤2.55 shape: the ref was never created, nothing to drop */ }
  });
  afterEach(() => { delete process.env.UNPUSHED_PUSHED_SHAS_DISABLED; });

  it('environment guard: the URL push left NO origin/digby/session-y tracking ref (forced historical shape, any git version)', () => {
    // origin/digby/session-y is the count-zeroing ref: it contains c2/c3, so
    // its presence makes `HEAD --not --remotes` read 0 (the CI-red shape).
    // origin/HEAD (symbolic) and origin/digby/session-x (an earlier
    // describe's beforeAll pushes that branch by name) mirror the clone and
    // are irrelevant here.
    const refs = g(wt2, ['for-each-ref', '--format=%(refname)', 'refs/remotes']).trim().split('\n').filter(Boolean);
    expect(refs).not.toContain('refs/remotes/origin/digby/session-y');
  });

  it('pre-fix shape: a URL push leaves the remotes-only count at 3 (the false note)', async () => {
    expect((await measureUnpushed(wt2))?.count).toBe(3);
  });

  it('the remembered pushed sha clears the count — no note, stamp 0', async () => {
    const head = g(wt2, ['rev-parse', 'HEAD']).trim();
    await recordPushedSha('s-w2', head);
    expect(await readPushedShas('s-w2')).toEqual([head]);
    const r = await unpushedCommitsAtRunEnd({ sessionId: 's-w2', worktree: wt2 });
    expect(r.line).toBeNull();
    expect(r.state?.count).toBe(0);
  });

  it('commits AFTER the push are still counted (only what was published is excluded)', async () => {
    const head = g(wt2, ['rev-parse', 'HEAD']).trim();
    await recordPushedSha('s-w2b', head);
    await fs.writeFile(path.join(wt2, 'late.md'), 'late\n');
    g(wt2, ['add', '-A']); g(wt2, ['commit', '-q', '-m', 'late local commit']);
    const r = await unpushedCommitsAtRunEnd({ sessionId: 's-w2b', worktree: wt2 });
    expect(r.state?.count).toBe(1);
    expect(r.line).toContain('1 local commit on digby/session-y NOT pushed');
    g(wt2, ['reset', '-q', '--hard', 'HEAD~1']);
  });

  it('a squash-merged + deleted head branch (fetch --prune) still reads as pushed', async () => {
    const head = g(wt2, ['rev-parse', 'HEAD']).trim();
    await recordPushedSha('s-w2c', head);
    g(wt2, ['push', '-q', origin, '--delete', 'digby/session-y']);
    g(wt2, ['fetch', '-q', '--prune', 'origin']);
    expect((await unpushedCommitsAtRunEnd({ sessionId: 's-w2c', worktree: wt2 })).state?.count).toBe(0);
  });

  it("an unknown / gc'd remembered sha is ignored (--ignore-missing), never an unmeasurable count", async () => {
    expect((await measureUnpushed(wt2, new Date(), ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']))?.count).toBe(3);
  });

  it('only sha-shaped values are remembered; newest first; capped', async () => {
    await recordPushedSha('s-cap', 'not a sha');
    expect(await readPushedShas('s-cap')).toEqual([]);
    for (let i = 0; i < 25; i++) await recordPushedSha('s-cap', `${'a'.repeat(38)}${String(i).padStart(2, '0')}`);
    const shas = await readPushedShas('s-cap');
    expect(shas.length).toBe(20);
    expect(shas[0]).toBe(`${'a'.repeat(38)}24`);
  });

  it('UNPUSHED_PUSHED_SHAS_DISABLED=1 restores the remotes-only count', async () => {
    const head = g(wt2, ['rev-parse', 'HEAD']).trim();
    await recordPushedSha('s-w2d', head);
    process.env.UNPUSHED_PUSHED_SHAS_DISABLED = '1';
    expect((await unpushedCommitsAtRunEnd({ sessionId: 's-w2d', worktree: wt2 })).state?.count).toBe(3);
  });
});
