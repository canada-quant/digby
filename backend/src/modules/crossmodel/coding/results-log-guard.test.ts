/**
 * Pins results-log-guard.ts (tt-rd audit 2026-09-27, finding docs-churn-log-2):
 * the glob, the unified-diff / compare-files parsers, the truncation rule
 * (bytes ratio with the hunk-span fallback), the archive exoneration, the
 * note, and the switches. Leaf module, no mocks.
 */
import {
  globToRegExp, matchesResultsLog, parseUnifiedDiff, diffStatsFromPatches, resultsLogCandidates,
  findResultsLogTruncations, hasArchiveAdded, renderResultsLogNote,
  resultsLogGuardEnforced, resultsLogMaxDeletedLines, resultsLogGlobs,
  RESULTS_LOG_DEFAULT_GLOBS, RESULTS_LOG_MAX_CANDIDATES,
} from './results-log-guard';

const LOG = 'results/2026-08-29-flash-next-device-legs.md';
const ENV = ['RESULTS_LOG_GUARD_ENFORCE', 'RESULTS_LOG_MAX_DELETED_LINES', 'RESULTS_LOG_GLOB'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** A unified diff that rewrites `path` from `oldLines` sections to a stub (the #601 / #809 shape). */
function stubRewriteDiff(path: string, oldLines: number, newLines: number, extraFiles = ''): string {
  const old = Array.from({ length: oldLines }, (_, i) => (i % 40 === 0 ? `-## L-HT1 rung ${i / 40} — result` : `-| row ${i} | 5.08 tok/s | wall=12.6s |`));
  const fresh = Array.from({ length: newLines }, (_, i) => `+stub line ${i}`);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines} +1,${newLines} @@\n${old.join('\n')}\n${fresh.join('\n')}\n${extraFiles}`;
}

describe('glob + matchesResultsLog', () => {
  it('the default globs catch results/ logs, *results*, *tracker*, *log* markdown anywhere — and nothing else', () => {
    expect(resultsLogGlobs()).toEqual(RESULTS_LOG_DEFAULT_GLOBS);
    for (const p of [LOG, 'results/a/b/c.md', 'docs/tenstorrent-upstream-tracker.md', 'notes/2026-results-week.md', 'CHANGELOG.md'.toLowerCase(), 'runlog.md', 'Results.MD']) {
      expect(matchesResultsLog(p)).toBe(true);
    }
    for (const p of ['README.md', 'src/results.py', 'docs/design.md', 'results/data.json', '']) expect(matchesResultsLog(p)).toBe(false);
  });

  it('globToRegExp: ** spans directories, * stays inside a segment, ? is one char, dots are literal', () => {
    expect(globToRegExp('results/**/*.md').test('results/x.md')).toBe(true);
    expect(globToRegExp('results/**/*.md').test('results/a/b/x.md')).toBe(true);
    expect(globToRegExp('results/*.md').test('results/a/x.md')).toBe(false);
    expect(globToRegExp('*.md').test('a/x.md')).toBe(false);
    expect(globToRegExp('**/*log*.md').test('runlog.md')).toBe(true);
    expect(globToRegExp('x?.md').test('xa.md')).toBe(true);
    expect(globToRegExp('x.md').test('xamd')).toBe(false);
  });

  it('RESULTS_LOG_GLOB overrides the list', () => {
    process.env.RESULTS_LOG_GLOB = 'journal/**/*.md, ';
    expect(resultsLogGlobs()).toEqual(['journal/**/*.md']);
    expect(matchesResultsLog('journal/x.md')).toBe(true);
    expect(matchesResultsLog(LOG)).toBe(false);
  });
});

describe('parseUnifiedDiff', () => {
  it('counts added / deleted lines, deleted bytes, lost "##" sections, and the hunk-covered old span per file', () => {
    const stats = parseUnifiedDiff(stubRewriteDiff(LOG, 8419, 29, 'diff --git a/scripts/patch.py b/scripts/patch.py\n--- /dev/null\n+++ b/scripts/patch.py\n@@ -0,0 +1,2 @@\n+import os\n+print(1)\n'));
    expect(stats).toHaveLength(2);
    const log = stats[0];
    expect(log).toMatchObject({ path: LOG, added: 29, deleted: 8419, sectionsDeleted: 211, hunkCoveredOld: 8419, isNew: false, isRemoved: false });
    expect(log.deletedBytes).toBeGreaterThan(8419 * 20);
    expect(stats[1]).toMatchObject({ path: 'scripts/patch.py', added: 2, deleted: 0, isNew: true, hunkCoveredOld: 0 });
  });

  it('a deleted body line that starts with "-- " is not mistaken for a file header; removed files are flagged', () => {
    const diff = 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ /dev/null\n@@ -1,3 +0,0 @@\n--- a list item\n-- another\n-last\n';
    const stats = parseUnifiedDiff(diff);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ path: 'x.md', deleted: 3, isRemoved: true });
  });

  it('tolerates the header-less secret-scan fixture shape and empty input', () => {
    expect(parseUnifiedDiff('+++ b/file\n+const x = 1;\n')).toEqual([]);
    expect(parseUnifiedDiff('')).toEqual([]);
    const bare = parseUnifiedDiff('--- a/f.md\n+++ b/f.md\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n');
    expect(bare[0]).toMatchObject({ path: 'f.md', added: 1, deleted: 2, hunkCoveredOld: 2 });
  });
});

describe('diffStatsFromPatches (GitHub compare / pulls-files JSON)', () => {
  it('reads the per-file patch when present, falls back to the counts (bytes unknown) when GitHub omits it', () => {
    const stats = diffStatsFromPatches([
      { filename: LOG, additions: 20, deletions: 4232, status: 'modified', patch: '@@ -1,4238 +1,20 @@\n' + Array.from({ length: 4232 }, (_, i) => (i % 25 === 0 ? '-## section' : '-row')).join('\n') + '\n' + Array.from({ length: 20 }, () => '+stub').join('\n') },
      { filename: 'results/big.md', additions: 1, deletions: 900, status: 'modified' }, // no patch (too large)
      { filename: 'results/archive/old.md', additions: 4232, deletions: 0, status: 'added' },
    ]);
    expect(stats[0]).toMatchObject({ path: LOG, added: 20, deleted: 4232, sectionsDeleted: 170, hunkCoveredOld: 4238 });
    expect(stats[0].deletedBytes).toBeGreaterThan(0);
    expect(stats[1]).toMatchObject({ path: 'results/big.md', added: 1, deleted: 900, deletedBytes: null, hunkCoveredOld: 0 });
    expect(stats[2]).toMatchObject({ path: 'results/archive/old.md', isNew: true });
    expect(hasArchiveAdded(stats)).toBe(true);
  });
});

describe('resultsLogCandidates + findResultsLogTruncations', () => {
  it('PR #601 shape: −8,409 lines of a 1.43 MB log to a 29-line stub, no archive → a truncation at ~100 % with the archive-missing flag', () => {
    const stats = parseUnifiedDiff(stubRewriteDiff(LOG, 8419, 29));
    const cands = resultsLogCandidates(stats);
    expect(cands.map((c) => c.path)).toEqual([LOG]);
    const preBytes = stats[0].deletedBytes! + 200; // the pre-PR file was the deleted content plus a little
    const t = findResultsLogTruncations(cands, () => preBytes, stats);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ path: LOG, deleted: 8419, added: 29, sectionsDeleted: 211, preBytes, hunkEstimated: false, archiveMissing: true });
    expect(t[0].ratio).toBeGreaterThan(0.95);
    expect(renderResultsLogNote(t[0])).toMatch(/^results_log: results\/2026-08-29-flash-next-device-legs\.md −8419 lines \(211 sections, \+29\) = \d+% of its \d+ pre-PR bytes with NO archive file added — results logs and trackers are APPEND-ONLY on main/);
  });

  it('a 200-line trim from the top of a 10,000-line log (2 % of the bytes) is NOT a truncation — the pre-size read matters', () => {
    const stats = parseUnifiedDiff(stubRewriteDiff(LOG, 205, 5));
    const cands = resultsLogCandidates(stats);
    expect(cands).toHaveLength(1);
    expect(findResultsLogTruncations(cands, () => stats[0].deletedBytes! * 50, stats)).toEqual([]);
  });

  it('pre-size unreadable → hunk-span fallback: ≥ 90 % of the covered old lines deleted = a stub rewrite; a 60 % edit is not', () => {
    const stub = parseUnifiedDiff(stubRewriteDiff(LOG, 4238, 20));
    const t = findResultsLogTruncations(resultsLogCandidates(stub), () => null, stub);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ hunkEstimated: true, preBytes: null });
    expect(renderResultsLogNote(t[0])).toContain('of the lines the diff touches (pre-PR size unreadable)');
    // 300 of 500 covered lines deleted: below the 90 % stub bar.
    const partial = parseUnifiedDiff(`diff --git a/${LOG} b/${LOG}\n--- a/${LOG}\n+++ b/${LOG}\n@@ -1,500 +1,200 @@\n${Array.from({ length: 300 }, () => '-x').join('\n')}\n`);
    expect(findResultsLogTruncations(resultsLogCandidates(partial), () => null, partial)).toEqual([]);
  });

  it('an archive/ file ADDED in the same diff clears the archive-missing flag (an archive move, not a loss)', () => {
    const stats = parseUnifiedDiff(stubRewriteDiff(LOG, 4238, 20, `diff --git a/results/archive/legs-2026-09-25.md b/results/archive/legs-2026-09-25.md\n--- /dev/null\n+++ b/results/archive/legs-2026-09-25.md\n@@ -0,0 +1,2 @@\n+moved\n+here\n`));
    const t = findResultsLogTruncations(resultsLogCandidates(stats), () => null, stats);
    expect(t[0].archiveMissing).toBe(false);
    expect(renderResultsLogNote(t[0])).toContain('(an archive/ file is added in the same diff)');
  });

  it('candidates: below the line floor, non-results paths, and newly added files are skipped; the largest deletions win, capped', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ filename: `results/r${i}.md`, additions: 0, deletions: 300 + i, status: 'modified' }));
    const stats = diffStatsFromPatches([
      ...many,
      { filename: 'results/small.md', additions: 0, deletions: 199, status: 'modified' },
      { filename: 'src/big.ts', additions: 0, deletions: 5000, status: 'modified' },
      { filename: 'results/new.md', additions: 0, deletions: 500, status: 'added' },
    ]);
    const cands = resultsLogCandidates(stats);
    expect(cands).toHaveLength(RESULTS_LOG_MAX_CANDIDATES);
    expect(cands.map((c) => c.path)).toEqual(['results/r4.md', 'results/r3.md', 'results/r2.md']);
    process.env.RESULTS_LOG_MAX_DELETED_LINES = '100';
    expect(resultsLogMaxDeletedLines()).toBe(100);
    expect(resultsLogCandidates(stats.filter((s) => s.path === 'results/small.md')).map((c) => c.path)).toEqual(['results/small.md']);
  });

  it('the enforce switch reads 1 / true / on; the line floor defaults to 200', () => {
    expect(resultsLogGuardEnforced()).toBe(false);
    expect(resultsLogMaxDeletedLines()).toBe(200);
    process.env.RESULTS_LOG_GUARD_ENFORCE = 'true';
    expect(resultsLogGuardEnforced()).toBe(true);
  });
});
