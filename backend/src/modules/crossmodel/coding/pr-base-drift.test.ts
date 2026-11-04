/**
 * Pins pr-base-drift.ts (ticket 9d4ef436, defect family pr-diff-base-drift).
 *
 * The incident: two Schooltime PRs inside four hours (#258 "state: correct the
 * diverged=3 clause", −357 lines across 6 files; #261, the same branch name
 * reused) opened green-looking, merge-ready PRs whose computed diff deleted
 * another lane's already-merged work. Both were closed unmerged; nothing in the
 * open_pull_request result flagged either one.
 *
 * THREE mechanisms were refuted against real git before this one, and the last
 * describe block pins all three refutations against actual repository state
 * (unit fixtures lied about every one of them):
 *   1. file overlap         → fires on routine hot-file co-editing (merge clean)
 *   2. line identity across two three-dot compares → INERT BY CONSTRUCTION
 *      (both anchored to the same merge-base ⇒ disjoint sets)
 *   3. BRANCH blob identity → fires on an honest lane that legitimately drops a
 *      line base just added: the branch blob IS an old base blob, yet the merge
 *      keeps base's work intact
 *
 * What is pinned now: the MERGED TREE. Merging is what the refusal claims to
 * judge, so the probe computes the merge and asks whether the result leaves a
 * path on a snapshot base has already moved past.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectBaseDrift, historyBlobsFromRaw, STATE_PATH_RE, probeBaseBlobs,
  renderBaseDriftDiagnosis, renderBaseDriftRefusal, renderBaseDriftNotice,
  type BlobProbe,
} from './pr-base-drift';

const cand = (p: string, deletions = 5) => ({ path: p, deletions });
const probe = (mergedBlob: string | null, baseBlob: string | null, historyBlobs: string[]): BlobProbe => ({ mergedBlob, baseBlob, historyBlobs });

describe('detectBaseDrift — the signal is the MERGED tree vs base', () => {
  it('FIRES when the merge leaves the path on an OLDER base snapshot', () => {
    const v = detectBaseDrift([cand('scripts/emulator-post.sh')], new Map([
      ['scripts/emulator-post.sh', probe('blob_old', 'blob_tip', ['blob_old', 'blob_tip'])],
    ]));
    expect(v.reverting).toBe(true);
    expect(v.revertingFiles).toEqual(['scripts/emulator-post.sh']);
    expect(v.incomplete).toBe(false);
    expect(v.probedFiles).toBe(1);
  });

  it('THE CASE THAT KILLED THE BRANCH-BLOB RULE: base’s work SURVIVES the merge ⇒ never fires', () => {
    // An honest lane deletes a line base just added. Its BRANCH blob is an old
    // base blob (so branch-blob identity fired — refuted), but the merge keeps
    // base's content, so the merged blob EQUALS the base tip blob.
    const v = detectBaseDrift([cand('backend/package-lock.json')], new Map([
      ['backend/package-lock.json', probe('blob_tip', 'blob_tip', ['blob_tip', 'blob_other'])],
    ]));
    expect(v.reverting).toBe(false);
    expect(v.revertingFiles).toEqual([]);
  });

  it('a fresh honest co-edit produces a merged blob base never had ⇒ never fires', () => {
    const v = detectBaseDrift([cand('AGENTS.md')], new Map([
      ['AGENTS.md', probe('blob_merged_new', 'blob_tip', ['blob_tip', 'blob_older'])],
    ]));
    expect(v.reverting).toBe(false);
  });

  it('does not fire when the merge removes the path, base never tracked it, or the merge conflicted', () => {
    expect(detectBaseDrift([cand('docs/dead.md')], new Map([['docs/dead.md', probe(null, 'blob_tip', ['blob_tip'])]]))).toMatchObject({ reverting: false, incomplete: false });
    expect(detectBaseDrift([cand('src/new.ts')], new Map([['src/new.ts', probe('b', null, [])]]))).toMatchObject({ reverting: false });
  });

  it('names EVERY reverting file, sorted for a stable message', () => {
    const v = detectBaseDrift(
      [cand('scripts/emulator-post.sh'), cand('backend/src/emulator/gate.ts'), cand('src/honest.ts')],
      new Map([
        ['scripts/emulator-post.sh', probe('b1', 'b2', ['b0', 'b1', 'b2'])],
        ['backend/src/emulator/gate.ts', probe('g1', 'g2', ['g1', 'g2'])],
        ['src/honest.ts', probe('h1', 'h2', ['h2'])],
      ]),
    );
    expect(v.revertingFiles).toEqual(['backend/src/emulator/gate.ts', 'scripts/emulator-post.sh']);
  });

  it('fails OPEN: an unprobeable candidate is INCOMPLETE but never a refusal', () => {
    const v = detectBaseDrift([cand('src/a.ts')], new Map([['src/a.ts', null]]));
    expect(v.reverting).toBe(false);
    expect(v.incomplete).toBe(true);
    expect(v.probedFiles).toBe(0);
  });

  it('a null / missing map or candidate list is never a refusal', () => {
    expect(detectBaseDrift(null, null).reverting).toBe(false);
    expect(detectBaseDrift([cand('a.ts')], null).reverting).toBe(false);
    expect(detectBaseDrift([], new Map()).reverting).toBe(false);
    expect(detectBaseDrift([{ path: '' } as any], new Map()).reverting).toBe(false);
  });

  it('a revert is still reported when a SIBLING candidate was unprobeable', () => {
    const v = detectBaseDrift([cand('a.ts'), cand('b.ts')], new Map([['a.ts', probe('old', 'cur', ['old', 'cur'])]]));
    expect(v.reverting).toBe(true);
    expect(v.incomplete).toBe(true);
  });
});

describe('historyBlobsFromRaw — the --raw parser', () => {
  it('collects both sides of every entry and drops the null object', () => {
    const sha = 'a'.repeat(40), sha2 = 'b'.repeat(40), zero = '0'.repeat(40);
    const raw = [
      `:000000 100644 ${zero} ${sha} A\tx`,
      `:100644 100644 ${sha} ${sha2} M\tx`,
    ].join('\n');
    expect(historyBlobsFromRaw(raw)).toEqual([sha, sha2].sort());
  });

  it('ignores commit headers, blanks and junk; de-duplicates', () => {
    const sha = 'a'.repeat(40), sha2 = 'b'.repeat(40);
    const raw = `deadbeef\n\n:100644 100644 ${sha} ${sha2} M\tx\nnot raw\n:100644 100644 ${sha} ${sha2} M\tx`;
    expect(historyBlobsFromRaw(raw)).toEqual([sha, sha2].sort());
    expect(historyBlobsFromRaw(null)).toEqual([]);
    expect(historyBlobsFromRaw('')).toEqual([]);
  });
});

describe('renderings', () => {
  const v = detectBaseDrift([cand('scripts/emulator-post.sh')], new Map([['scripts/emulator-post.sh', probe('b1', 'b2', ['b1', 'b2'])]]));

  it('the diagnosis names the files and the base', () => {
    const line = renderBaseDriftDiagnosis(v, 'main');
    expect(line).toContain('scripts/emulator-post.sh');
    expect(line).toContain('main has already moved past');
    expect(line).toContain('silently REVERT');
  });

  it('the refusal is actionable: base, rebase remedy, override, nothing opened', () => {
    const msg = renderBaseDriftRefusal(v, 'main');
    expect(msg).toMatch(/^PR REFUSED \(base drift\):/);
    expect(msg).toContain('git rebase origin/main');
    expect(msg).toContain('nothing was opened');
    expect(msg).toContain('allowBaseDrift:true');
  });

  it('the override notice states the lane proceeded knowingly', () => {
    expect(renderBaseDriftNotice(v, 'main')).toMatch(/^\[BASE DRIFT OVERRIDE\] allowBaseDrift:true/);
  });
});

describe('STATE_PATH_RE', () => {
  it.each([
    ['.digby/rules/00-current-state.md', true],
    ['.digby/notes/learnings.md', true],
    ['src/a.ts', false],
    ['digby/x', false],
  ])('%s → %s', (p, want) => { expect(STATE_PATH_RE.test(p)).toBe(want); });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DECISIVE TESTS: against REAL GIT.
// Every mechanism so far passed unit fixtures and was wrong; only real
// repository state distinguishes them.
// ─────────────────────────────────────────────────────────────────────────────
describe('probeBaseBlobs against REAL GIT', () => {
  let root = '';
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const run = async (args: string[]) => ({ stdout: execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString() });
  const branch = (name: string, from: string) => {
    try { g('checkout', '-q', 'main'); g('branch', '-D', name); } catch { /* absent */ }
    g('checkout', '-q', '-b', name, from);
  };
  const write = (f: string, body: string) => fs.writeFileSync(path.join(root, f), body);

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'basedrift-'));
    g('init', '-q', '-b', 'main', '.');
    write('emulator.sh', 'enable();\nrun();\n');
    g('add', '-A'); g('commit', '-qm', 'c1');
    write('emulator.sh', 'enable();\nrun();\nSCORE();\n');
    g('commit', '-aqm', 'c2 base lands PR #257');
  });
  afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('THE INCIDENT: a branch that commits stale content over merged work IS caught', async () => {
    branch('stale', 'main');
    write('emulator.sh', 'enable();\nrun();\n');       // restores c1's snapshot
    g('commit', '-aqm', 'state edit that reverts the merged file');
    const p = await probeBaseBlobs(run, 'main', 'HEAD', 'emulator.sh');
    expect(p).not.toBeNull();
    expect(p!.mergedBlob).not.toBe(p!.baseBlob);
    expect(p!.historyBlobs).toContain(p!.mergedBlob!);
    expect(detectBaseDrift([cand('emulator.sh', 1)], new Map([['emulator.sh', p]])).reverting).toBe(true);
  });

  it('THE CASE THAT KILLED BRANCH-BLOB IDENTITY: base’s work SURVIVING the merge never fires', async () => {
    // The refuted rule judged the BRANCH blob, so a branch built on an older
    // base whose file merely LOOKED like an old base snapshot could fire even
    // though the merge keeps base's work. Here the branch is cut from c1 (so
    // its emulator.sh blob IS c1's — an old base blob) but only touches an
    // unrelated file: the merge keeps base's SCORE(), so nothing fires.
    branch('behind', 'HEAD~1');                 // c1 — emulator.sh == old base blob
    write('unrelated.txt', 'lane work\n');
    g('add', '-A'); g('commit', '-qm', 'lane work on an older base');
    const p = await probeBaseBlobs(run, 'main', 'HEAD', 'emulator.sh');
    expect(p).not.toBeNull();
    expect(p!.mergedBlob).toBe(p!.baseBlob);    // base's content survives the merge
    expect(detectBaseDrift([cand('emulator.sh', 1)], new Map([['emulator.sh', p]])).reverting).toBe(false);
  });

  it('a lane that DELETES a line base just merged IS caught — the merge really does drop it (allowBaseDrift is the intent hatch)', async () => {
    // This is not a false positive: merging this branch removes base's SCORE()
    // from main. The refusal names it; a lane that means it passes
    // allowBaseDrift:true.
    branch('dropper', 'main');
    write('emulator.sh', 'enable();\nrun();\n');
    g('commit', '-aqm', 'loudly delete the line base merged');
    const p = await probeBaseBlobs(run, 'main', 'HEAD', 'emulator.sh');
    expect(p!.mergedBlob).not.toBe(p!.baseBlob);
    expect(p!.historyBlobs).toContain(p!.mergedBlob!);
    expect(detectBaseDrift([cand('emulator.sh', 1)], new Map([['emulator.sh', p]])).reverting).toBe(true);
  });

  it('a branch that builds ON the merged work is never caught', async () => {
    branch('ontip', 'main');
    write('emulator.sh', 'enable();\nrun();\nSCORE();\nEXTRA();\n');
    g('commit', '-aqm', 'lane extends the merged work');
    const p = await probeBaseBlobs(run, 'main', 'HEAD', 'emulator.sh');
    expect(detectBaseDrift([cand('emulator.sh', 1)], new Map([['emulator.sh', p]])).reverting).toBe(false);
  });

  it('a file base never tracked returns null (the caller fails open)', async () => {
    branch('ownfile', 'main');
    write('mine.ts', 'one();\ntwo();\n');
    g('add', '-A'); g('commit', '-qm', 'add my own file');
    expect(await probeBaseBlobs(run, 'main', 'HEAD', 'mine.ts')).toBeNull();
  });

  it('an unresolvable base returns null (the caller fails open)', async () => {
    expect(await probeBaseBlobs(run, 'no-such-branch', 'HEAD', 'emulator.sh')).toBeNull();
  });

  it('judges the ref it is GIVEN, not the worktree checkout (the explicit-head fix)', async () => {
    // While checked out on `ontip`, probe the `stale` branch by ref: the answer
    // must describe `stale`, not the tree on disk.
    g('checkout', '-q', 'ontip');
    const onStale = await probeBaseBlobs(run, 'main', 'stale', 'emulator.sh');
    expect(detectBaseDrift([cand('emulator.sh', 1)], new Map([['emulator.sh', onStale]])).reverting).toBe(true);
    const onOntip = await probeBaseBlobs(run, 'main', 'ontip', 'emulator.sh');
    expect(detectBaseDrift([cand('emulator.sh', 1)], new Map([['emulator.sh', onOntip]])).reverting).toBe(false);
  });
});