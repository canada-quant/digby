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
const probe = (mergedBlob: string | null, baseBlob: string | null, historyBlobs: string[], deletedByBranch?: boolean | null): BlobProbe =>
  ({ mergedBlob, baseBlob, historyBlobs, ...(deletedByBranch === undefined ? {} : { deletedByBranch }) });

// ─────────────────────────────────────────────────────────────────────────────
// TICKET 7445695d — the SIBLING shape the merged-blob rule cannot see: the
// path does not land on an older snapshot, it VANISHES. Report: a lane's PR
// diff showed relay-operator-viewer.ts (−597) and embed-failure.ts (−189)
// deleted, files belonging to OTHER lanes' merged PRs.
//
// MEASURED before building (real git, this ticket):
//   • A merely STALE base is NOT this hazard. Two-dot `git diff main..HEAD`
//     shows the "deletions", but the PR diff is THREE-DOT and the merge KEEPS
//     both files — so nothing to refuse. Pinned in tools.test.ts.
//   • The reachable form: the lane MERGES the base and its resolution drops
//     another lane's file. Then the PR diff really shows `D`, the merge really
//     drops it, and `git log --no-merges --diff-filter=D` finds NO commit of
//     the branch's own — the deletion came from the merge commit.
//   • A deliberate `git rm` (and a rename) DOES leave a deleter commit, so the
//     lane's own cleanup is never refused.
// ─────────────────────────────────────────────────────────────────────────────
describe('detectBaseDrift — the merge DELETING a file the branch never deleted (ticket 7445695d)', () => {
  it('FIRES when the merge drops a base-tracked file with no deleter commit on the branch', () => {
    const v = detectBaseDrift([cand('relay-operator-viewer.ts', 597)], new Map([
      ['relay-operator-viewer.ts', probe(null, 'blob_tip', [], false)],
    ]));
    expect(v.reverting).toBe(true);
    expect(v.deletedFiles).toEqual(['relay-operator-viewer.ts']);
    expect(v.revertingFiles).toEqual([]);
    expect(v.incomplete).toBe(false);
  });

  it('NEVER fires for the lane’s OWN deliberate deletion (a cleanup, or a rename)', () => {
    const v = detectBaseDrift([cand('legacy-module.ts', 40)], new Map([
      ['legacy-module.ts', probe(null, 'blob_tip', [], true)],
    ]));
    expect(v.reverting).toBe(false);
    expect(v.deletedFiles).toEqual([]);
  });

  it('fails OPEN when the deleter lookup is unknown (null/undefined)', () => {
    expect(detectBaseDrift([cand('a.ts')], new Map([['a.ts', probe(null, 'blob_tip', [], null)]])).reverting).toBe(false);
    expect(detectBaseDrift([cand('a.ts')], new Map([['a.ts', probe(null, 'blob_tip', [])]])).reverting).toBe(false);
  });

  it('a path the BASE never tracked is never a deletion (a new file the lane adds)', () => {
    const v = detectBaseDrift([cand('mine.ts')], new Map([['mine.ts', probe(null, null, [], false)]]));
    expect(v.reverting).toBe(false);
  });

  it('reports reverts AND deletions together, each sorted', () => {
    const v = detectBaseDrift(
      [cand('b.ts', 20), cand('a.ts', 40), cand('z.ts', 60)],
      new Map([
        ['b.ts', probe(null, 'tip_b', [], false)],            // deletion
        ['a.ts', probe('old_a', 'tip_a', ['old_a', 'tip_a'])], // revert
        ['z.ts', probe(null, 'tip_z', [], true)],             // the lane's own delete
      ]),
    );
    expect(v.reverting).toBe(true);
    expect(v.revertingFiles).toEqual(['a.ts']);
    expect(v.deletedFiles).toEqual(['b.ts']);
  });
});

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

  it('does not fire when base never tracked the path, or the merge conflicted', () => {
    // A path the base never tracked is not a revert at all.
    expect(detectBaseDrift([cand('src/new.ts')], new Map([['src/new.ts', probe('b', null, [])]]))).toMatchObject({ reverting: false });
    // A deleted path with an UNKNOWN deleter read stays `incomplete` (telemetry
    // visible, fail open) — never a refusal, never a silent "fine" (finding 5).
    expect(detectBaseDrift([cand('docs/dead.md')], new Map([['docs/dead.md', probe(null, 'blob_tip', ['blob_tip'])]])))
      .toMatchObject({ reverting: false, incomplete: true, deletedFiles: [] });
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

  // DETECTOR-RECALL REPLAY (priors #1/#2 of the pr-base-drift guard, ticket
  // 7445695d): adding a new refusal branch (whole-file deletion) must not blunt
  // the guard's existing true positives. Both are replayed above/below against
  // real git — a stale branch that restores an older snapshot still convicts,
  // and a lane dropping a line base just merged still convicts.
  it('THE INCIDENT: a branch that commits stale content over merged work IS caught — DETECTOR-RECALL REPLAY (prior true positive #1)', async () => {
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

  it('a lane that DELETES a line base just merged IS caught — the merge really does drop it (allowBaseDrift is the intent hatch) — DETECTOR-RECALL REPLAY (prior true positive #2)', async () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// TICKET 7445695d — WHOLE-FILE DELETION, against REAL GIT.
// The report's numbers (relay-operator-viewer.ts −597, embed-failure.ts −189)
// are whole-FILE deletions, not shrinks: the merged-blob rule returns null for
// them and the guard read that as `incomplete` (fail open) — the blind spot.
// These tests build all three shapes in a REAL repo and pin which one fires.
// ─────────────────────────────────────────────────────────────────────────────
describe('probeBaseBlobs against REAL GIT — the merge DELETING another lane’s file (ticket 7445695d)', () => {
  let root = '';
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const run = async (args: string[]) => ({ stdout: execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString() });
  const write = (f: string, body: string) => fs.writeFileSync(path.join(root, f), body);

  /** main: `shared.ts` + `relay-operator-viewer.ts`, then another lane lands `embed-failure.ts`. */
  const OWN = 'relay-operator-viewer.ts';
  const OTHER = 'embed-failure.ts';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'basedrift-del-'));
    g('init', '-q', '-b', 'main', '.');
    write('shared.ts', 'export const shared = 1;\n');
    write(OWN, 'export const relay = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'c1 base');
    // PR #2344 lands another lane's file.
    write(OTHER, 'export const embed = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'laneX lands embed-failure (PR #2345 squash)');
  });
  afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  /**
   * Build a lane cut from c1 that MERGES main and RESOLVES by dropping `path`.
   * This is the reachable hazard: the PR diff really shows `D path`, the merge
   * really drops it, and the lane never committed a delete of its own.
   */
  const badResolutionBranch = (name: string, path: string) => {
    const base = g('rev-parse', 'HEAD~1');            // c1 — before the other lane landed
    try { g('checkout', '-q', 'main'); g('branch', '-D', name); } catch { /* absent */ }
    g('checkout', '-q', '-b', name, base);
    write('shared.ts', 'export const shared = 1;\nexport const laneWork = 1;\n');
    g('commit', '-aqm', 'lane real work');
    try { g('merge', '--no-edit', 'main'); } catch { /* conflicts resolved below */ }
    g('rm', '-q', '--ignore-unmatch', path);          // the bad resolution
    g('commit', '-q', '--amend', '--no-edit');
    return name;
  };

  it('THE INCIDENT: a merge RESOLUTION that drops another lane’s file IS caught', async () => {
    badResolutionBranch('badres', OTHER);
    const p = await probeBaseBlobs(run, 'main', 'HEAD', OTHER);
    expect(p).not.toBeNull();
    expect(p!.mergedBlob).toBeNull();                 // the merge DROPS it
    expect(p!.deletedByBranch).toBe(false);           // …and no commit of ours deleted it
    const v = detectBaseDrift([cand(OTHER, 189)], new Map([[OTHER, p]]));
    expect(v.reverting).toBe(true);
    expect(v.deletedFiles).toEqual([OTHER]);
  });

  it('ACCEPTANCE — the lane’s OWN cleanup of a file it DID delete still passes', async () => {
    // Same file, but the lane removes it deliberately with a normal commit.
    try { g('checkout', '-q', 'main'); g('branch', '-D', 'clean'); } catch { /* absent */ }
    g('checkout', '-q', '-b', 'clean', 'main');
    g('rm', '-q', OWN);
    g('commit', '-qm', 'remove the deprecated relay viewer (deliberate cleanup)');
    const p = await probeBaseBlobs(run, 'main', 'HEAD', OWN);
    expect(p).not.toBeNull();
    expect(p!.mergedBlob).toBeNull();
    expect(p!.deletedByBranch).toBe(true);            // our own commit deleted it
    expect(detectBaseDrift([cand(OWN, 597)], new Map([[OWN, p]])).reverting).toBe(false);
  });

  it('a RENAME is not misread as deleting another lane’s file — R100 AND a total rewrite (<50% similarity)', async () => {
    // Review finding 2: the first cut of this test used a ONE-LINE file, which
    // is always R100 — it could never observe the <50%-similarity case where
    // git declines to pair the paths. Both shapes are pinned here against a
    // ≥30-line file, so the discriminator is proven on the case that matters.
    //
    // Each shape gets its OWN scratch base (`main2`), because the file has to
    // exist on the base for `probeBaseBlobs` to judge it at all — and `main`
    // must stay pristine for the tests that depend on its exact history.
    const body = (tag: string) => Array.from({ length: 40 }, (_, i) => `export const ${tag}${i} = ${i};\n`).join('');
    const shapes: Array<[string, (f: string) => void]> = [
      ['renamed', (f: string) => { g('mv', f, 'relay-operator-view.ts'); }],
      // A "move + total rewrite": every line changes, so git will not pair the
      // paths — the old path's removal is still the lane's OWN doing.
      ['rewritten', (f: string) => {
        fs.writeFileSync(path.join(root, 'relay-operator-view.ts'), body('totallyDifferent'));
        fs.unlinkSync(path.join(root, f));
      }],
    ];
    for (const [name, mutator] of shapes) {
      const f = `${name}-big.ts`;
      // Scratch base containing the file.
      try { g('checkout', '-q', 'main'); g('branch', '-D', 'main2'); } catch { /* absent */ }
      g('branch', 'main2', 'main');
      g('checkout', '-q', 'main2');
      write(f, body('original'));
      g('add', '-A'); g('commit', '-qm', `main2: add ${f}`);
      // The lane, cut from that base, replaces the file its own way.
      try { g('checkout', '-q', 'main2'); g('branch', '-D', name); } catch { /* absent */ }
      g('checkout', '-q', '-b', name, 'main2');
      mutator(f);
      g('add', '-A'); g('commit', '-qm', `${name}: replace ${f}`);
      const p = await probeBaseBlobs(run, 'main2', 'HEAD', f);
      expect(p).not.toBeNull();
      expect(p!.mergedBlob).toBeNull();
      // The lane's own commit removed the path — no false refusal for its cleanup.
      expect(p!.deletedByBranch).toBe(true);
      expect(detectBaseDrift([cand(f, 40)], new Map([[f, p]])).reverting).toBe(false);
    }
  });

  it('a filename with glob metacharacters is read LITERALLY (pathspec finding 4)', async () => {
    // A bare pathspec is a GLOB: 'a[xy].ts' matched nothing, so the lane's own
    // deliberate delete would have been falsely refused. `:(literal)` fixes it.
    const weird = 'a[xy].ts';
    try { g('checkout', '-q', 'main'); g('branch', '-D', 'main3'); } catch { /* absent */ }
    g('branch', 'main3', 'main');
    g('checkout', '-q', 'main3');
    write(weird, 'export const x = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'main3: add the oddly-named file');
    try { g('checkout', '-q', 'main3'); g('branch', '-D', 'globbed'); } catch { /* absent */ }
    g('checkout', '-q', '-b', 'globbed', 'main3');
    g('rm', '-q', '--', weird);
    g('commit', '-qm', 'lane deliberately deletes a[xy].ts');
    const p = await probeBaseBlobs(run, 'main3', 'HEAD', weird);
    expect(p).not.toBeNull();
    expect(p!.deletedByBranch).toBe(true);
    expect(detectBaseDrift([cand(weird, 1)], new Map([[weird, p]])).reverting).toBe(false);
  });

  it('THE REPORT’S OWN SCENE, pinned: a merely STALE base is NOT a deletion', async () => {
    // Cut from c1 — main has since landed OTHER — and touch only our own file.
    // The report feared this shape; measured, the THREE-DOT PR diff does not
    // contain OTHER and the merge KEEPS it. Pin it so the guard cannot later be
    // "strengthened" into refusing every honest stale branch.
    try { g('checkout', '-q', 'main'); g('branch', '-D', 'staleonly'); } catch { /* absent */ }
    g('checkout', '-q', '-b', 'staleonly', 'HEAD~1');
    write('shared.ts', 'export const shared = 2;\n');
    g('commit', '-aqm', 'honest edit on a stale base');
    const mb = g('rev-parse', 'HEAD');
    // The PR diff (three-dot) does not mention OTHER at all.
    const prFiles = g('diff', '--name-status', `${mb.split('\n')[0]}...HEAD`);
    expect(prFiles).not.toContain(OTHER);
    // …and the merge keeps it, so the probe says nothing reverted.
    const p = await probeBaseBlobs(run, 'main', 'HEAD', OTHER);
    expect(p!.mergedBlob).toBe(p!.baseBlob);
    expect(detectBaseDrift([cand(OTHER, 189)], new Map([[OTHER, p]])).reverting).toBe(false);
  });
});