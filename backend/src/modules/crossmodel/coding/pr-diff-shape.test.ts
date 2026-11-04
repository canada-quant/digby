/**
 * Pins pr-diff-shape.ts (tt-rd audit 2026-09-27, findings docs-churn-log-1/-3/-4):
 * the [PR DIFF] line round-trip, the docs-only churn trigger, the duplicate
 * re-open match, the [SCHEDULE STATE] count, and every kill switch.
 * Leaf module, no mocks.
 */
import {
  prDiffShape, renderPrDiffLine, parsePrDiffLine, docsOnlyPrPriorCount, duplicatePrReceipt, docsOnlyPrCount,
  renderDocsOnlyPrNotice, renderDocsOnlyPrRefusal, renderDuplicatePrNotice,
  docsOnlyPrEnforced, docsOnlyPrBatchMs,
  isStatePath,
  PR_DIFF_FILES_CAP, DUP_PR_WINDOW_MS, type PrReceiptLike,
} from './pr-diff-shape';

const NOW = new Date('2026-09-27T12:00:00Z');
const H = 60 * 60 * 1000;
const LOG = 'results/2026-08-29-flash-next-device-legs.md';

const rcpt = (ids: Record<string, unknown>, agoMs: number, over: Partial<PrReceiptLike> = {}): PrReceiptLike => ({
  tool: 'open_pull_request', ok: true, ids, createdAt: new Date(NOW.getTime() - agoMs), ...over,
});

const ENV = ['DOCS_ONLY_PR_ENFORCE', 'DOCS_ONLY_PR_BATCH_HOURS'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('prDiffShape — the compare files JSON reduced to a shape', () => {
  it('the audit shape: one results-log append is docs-only (+18/−0, 1 file)', () => {
    const s = prDiffShape([{ filename: LOG, additions: 18, deletions: 0, status: 'modified' }]);
    expect(s).toMatchObject({ fileCount: 1, files: [LOG], additions: 18, deletions: 0, filesOnlyMd: true });
    expect(s.diffHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a code file anywhere in the set makes it code; markdown variants count as docs; empty is not docs-only', () => {
    expect(prDiffShape([{ filename: 'docs/a.md', additions: 1, deletions: 0 }, { filename: 'src/x.py', additions: 3, deletions: 1 }]).filesOnlyMd).toBe(false);
    expect(prDiffShape([{ filename: 'README.markdown', additions: 1, deletions: 0 }, { filename: 'notes/b.MDX', additions: 1, deletions: 0 }]).filesOnlyMd).toBe(true);
    expect(prDiffShape([]).filesOnlyMd).toBe(false);
    expect(prDiffShape(null).fileCount).toBe(0);
  });

  it('the hash is order-insensitive and changes with any path or line count', () => {
    const a = prDiffShape([{ filename: 'a.md', additions: 1, deletions: 0 }, { filename: 'b.py', additions: 2, deletions: 2 }]);
    const b = prDiffShape([{ filename: 'b.py', additions: 2, deletions: 2 }, { filename: 'a.md', additions: 1, deletions: 0 }]);
    const c = prDiffShape([{ filename: 'a.md', additions: 2, deletions: 0 }, { filename: 'b.py', additions: 2, deletions: 2 }]);
    expect(a.diffHash).toBe(b.diffHash);
    expect(a.diffHash).not.toBe(c.diffHash);
  });

  it('caps the carried paths at PR_DIFF_FILES_CAP but counts every file', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ filename: `src/f${String(i).padStart(2, '0')}.ts`, additions: 1, deletions: 0 }));
    const s = prDiffShape(files);
    expect(s.fileCount).toBe(12);
    expect(s.files).toHaveLength(PR_DIFF_FILES_CAP);
    expect(renderPrDiffLine(s)).toContain('(+4 more)');
  });
});

describe('[PR DIFF] line round-trip (the receipt reads it back)', () => {
  it('renders the fixed fields then the paths, and parses back to the same shape', () => {
    const s = prDiffShape([{ filename: LOG, additions: 18, deletions: 0 }]);
    const line = renderPrDiffLine(s);
    expect(line).toBe(`[PR DIFF] 1 file · +18/−0 · docs-only · hash ${s.diffHash} · ${LOG}`);
    expect(parsePrDiffLine(`Opened PR #841: https://github.com/o/r/pull/841\n${line}\nNOTE: x`)).toEqual({
      fileCount: 1, additions: 18, deletions: 0, filesOnlyMd: true, filesOnlyState: false, diffHash: s.diffHash, files: [LOG],
    });
  });

  it('a code PR with several files parses (the "+N more" tail is dropped from the path list)', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ filename: `src/f${i}.ts`, additions: 1, deletions: 1 }));
    const s = prDiffShape(files);
    const p = parsePrDiffLine(renderPrDiffLine(s));
    expect(p).toMatchObject({ fileCount: 10, filesOnlyMd: false, additions: 10, deletions: 10 });
    expect(p!.files).toHaveLength(PR_DIFF_FILES_CAP);
    expect(p!.files[0]).toBe('src/f0.ts');
  });

  it('absent / malformed → null', () => {
    expect(parsePrDiffLine('Opened PR #1: u')).toBeNull();
    expect(parsePrDiffLine('[PR DIFF] lots · of · junk')).toBeNull();
  });
});

describe('docsOnlyPrPriorCount — the Nth docs-only PR on the same file in the window', () => {
  const mine = prDiffShape([{ filename: LOG, additions: 23, deletions: 0 }]);

  it('a prior docs-only PR of this chat touching the same file inside 24h → count includes this one', () => {
    const prior = [
      rcpt({ prNumber: 840, filesOnlyMd: true, files: [LOG] }, 2 * H),
      rcpt({ prNumber: 839, filesOnlyMd: true, files: [LOG] }, 5 * H),
      rcpt({ prNumber: 838, filesOnlyMd: false, files: ['src/x.py', LOG] }, 6 * H), // code PR — not counted
      rcpt({ prNumber: 800, filesOnlyMd: true, files: [LOG] }, 30 * H), // outside the window
    ];
    expect(docsOnlyPrPriorCount(mine, prior, NOW)).toEqual({ count: 3, sharedFile: LOG });
  });

  it('a first docs-only PR, a docs-only PR on a DIFFERENT file, a code PR, or a failed receipt → null', () => {
    expect(docsOnlyPrPriorCount(mine, [], NOW)).toBeNull();
    expect(docsOnlyPrPriorCount(mine, [rcpt({ filesOnlyMd: true, files: ['docs/other.md'] }, H)], NOW)).toBeNull();
    expect(docsOnlyPrPriorCount(prDiffShape([{ filename: 'src/a.py', additions: 1, deletions: 0 }]), [rcpt({ filesOnlyMd: true, files: ['src/a.py'] }, H)], NOW)).toBeNull();
    expect(docsOnlyPrPriorCount(mine, [rcpt({ filesOnlyMd: true, files: [LOG] }, H, { ok: false })], NOW)).toBeNull();
    expect(docsOnlyPrPriorCount(mine, [rcpt({ filesOnlyMd: true, files: [LOG] }, H, { tool: 'git_push' })], NOW)).toBeNull();
  });

  it('legacy receipts without the diff fields never match; a future-dated receipt is ignored', () => {
    expect(docsOnlyPrPriorCount(mine, [rcpt({ prNumber: 1, url: 'u' }, H)], NOW)).toBeNull();
    expect(docsOnlyPrPriorCount(mine, [rcpt({ filesOnlyMd: true, files: [LOG] }, -H)], NOW)).toBeNull();
  });

  it('DOCS_ONLY_PR_BATCH_HOURS widens / narrows the window', () => {
    const prior = [rcpt({ filesOnlyMd: true, files: [LOG] }, 30 * H)];
    expect(docsOnlyPrPriorCount(mine, prior, NOW)).toBeNull();
    process.env.DOCS_ONLY_PR_BATCH_HOURS = '48';
    expect(docsOnlyPrBatchMs()).toBe(48 * H);
    expect(docsOnlyPrPriorCount(mine, prior, NOW)).toEqual({ count: 2, sharedFile: LOG });
    process.env.DOCS_ONLY_PR_BATCH_HOURS = 'nope';
    expect(docsOnlyPrBatchMs()).toBe(24 * H);
  });
});

describe('duplicatePrReceipt — the same diff hash re-opened across runs (a8976e11: six PRs of one diff)', () => {
  const shape = prDiffShape([{ filename: 'models/gdn.py', additions: 4703, deletions: 12 }]);

  it('matches the newest prior receipt carrying this hash inside 7 days', () => {
    const prior = [
      rcpt({ prNumber: 564, diffHash: shape.diffHash }, 4 * 24 * H),
      rcpt({ prNumber: 590, diffHash: shape.diffHash }, 2 * 24 * H),
      rcpt({ prNumber: 600, diffHash: 'ffffffffffffffff' }, H),
    ];
    expect(duplicatePrReceipt(shape, prior, NOW)?.ids.prNumber).toBe(590);
    expect(duplicatePrReceipt(shape, [rcpt({ prNumber: 500, diffHash: shape.diffHash }, DUP_PR_WINDOW_MS + H)], NOW)).toBeNull();
    expect(duplicatePrReceipt(prDiffShape([]), prior, NOW)).toBeNull();
  });
});

describe('state-only PRs — .digby/** is harness STATE, never the docs-only class (fixer 2026-09-27, finding docs-churn-log-2)', () => {
  const STATE = '.digby/rules/00-current-state.md';

  it('a PR touching only .digby/** is state-only: filesOnlyMd false, the line says state-only, and it round-trips', () => {
    const s = prDiffShape([{ filename: STATE, additions: 12, deletions: 9 }, { filename: '.digby/notes/learnings.md', additions: 1, deletions: 0 }]);
    expect(s).toMatchObject({ fileCount: 2, filesOnlyMd: false, filesOnlyState: true });
    const line = renderPrDiffLine(s);
    expect(line).toBe(`[PR DIFF] 2 files · +13/−9 · state-only · hash ${s.diffHash} · .digby/notes/learnings.md, ${STATE}`);
    expect(parsePrDiffLine(line)).toMatchObject({ fileCount: 2, filesOnlyMd: false, filesOnlyState: true, files: ['.digby/notes/learnings.md', STATE] });
    expect(isStatePath(STATE)).toBe(true);
    expect(isStatePath('.digby/config.json')).toBe(true);
    expect(isStatePath('docs/.digby/x.md')).toBe(false);
    expect(isStatePath(LOG)).toBe(false);
    // an ordinary docs-only / code PR is untouched
    expect(prDiffShape([{ filename: LOG, additions: 18, deletions: 0 }])).toMatchObject({ filesOnlyMd: true, filesOnlyState: false });
    expect(prDiffShape([{ filename: 'src/a.py', additions: 1, deletions: 0 }])).toMatchObject({ filesOnlyMd: false, filesOnlyState: false });
  });

  it('a mixed state + results PR is classified on its NON-state files (docs-only); the state file is never the churn notice\'s shared file; a state-only PR is never noticed or counted', () => {
    const mixed = prDiffShape([{ filename: STATE, additions: 3, deletions: 3 }, { filename: LOG, additions: 18, deletions: 0 }]);
    expect(mixed).toMatchObject({ filesOnlyMd: true, filesOnlyState: false });
    // a prior docs-only PR that shared ONLY the state file → no notice
    expect(docsOnlyPrPriorCount(mixed, [rcpt({ filesOnlyMd: true, files: [STATE, 'results/other.md'] }, H)], NOW)).toBeNull();
    // …sharing the results log → the notice keys on the LOG, never the state file
    expect(docsOnlyPrPriorCount(mixed, [rcpt({ filesOnlyMd: true, files: [STATE, LOG] }, H)], NOW)).toEqual({ count: 2, sharedFile: LOG });
    // a state-only PR is never noticed (not docs-only) and never counted
    const stateOnly = prDiffShape([{ filename: STATE, additions: 3, deletions: 3 }]);
    expect(docsOnlyPrPriorCount(stateOnly, [rcpt({ filesOnlyMd: true, files: [STATE] }, H)], NOW)).toBeNull();
    expect(docsOnlyPrCount([rcpt({ filesOnlyMd: false, filesOnlyState: true, files: [STATE] }, H), rcpt({ filesOnlyMd: true, files: [LOG] }, H)], NOW)).toBe(1);
    // state + code is code
    expect(prDiffShape([{ filename: STATE, additions: 1, deletions: 0 }, { filename: 'src/a.py', additions: 1, deletions: 0 }])).toMatchObject({ filesOnlyMd: false, filesOnlyState: false });
  });
});

describe('docsOnlyPrCount + notices', () => {
  it('counts the window\'s docs-only receipts (the [SCHEDULE STATE] line)', () => {
    const prior = [rcpt({ filesOnlyMd: true }, H), rcpt({ filesOnlyMd: true }, 20 * H), rcpt({ filesOnlyMd: false }, H), rcpt({ filesOnlyMd: true }, 30 * H)];
    expect(docsOnlyPrCount(prior, NOW)).toBe(2);
    expect(docsOnlyPrCount(prior, NOW, 48 * H)).toBe(3);
  });

  it('the notices name the file, the ordinal, and the current-state rule; the refusal says nothing was opened', () => {
    const s = prDiffShape([{ filename: LOG, additions: 23, deletions: 0 }]);
    const n = renderDocsOnlyPrNotice(s, { count: 3, sharedFile: LOG });
    expect(n).toMatch(/^\[DOCS-ONLY PR NOTICE\] this PR only appends to results\/2026-08-29-flash-next-device-legs\.md \(\+23\/−0\), the 3rd such PR in 24h/);
    expect(n).toContain('.digby/rules/00-current-state.md');
    expect(renderDocsOnlyPrNotice(s, { count: 21, sharedFile: LOG }, 12)).toContain('the 21st such PR in 12h');
    expect(renderDocsOnlyPrNotice(s, { count: 12, sharedFile: LOG })).toContain('the 12th such PR');
    const r = renderDocsOnlyPrRefusal(s, { count: 2, sharedFile: LOG });
    expect(r).toMatch(/^PR REFUSED \(DOCS_ONLY_PR_ENFORCE=1, machine run\)/);
    expect(r).toContain('Nothing was opened.');
    expect(renderDuplicatePrNotice(rcpt({ prNumber: 590 }, 0), 'digby/gdn-window-a')).toContain('open PR #590 already carries this exact file set and line counts (its head branch: digby/gdn-window-a)');
  });

  it('the docs-only enforce switch reads 1 / true / on', () => {
    expect(docsOnlyPrEnforced()).toBe(false);
    process.env.DOCS_ONLY_PR_ENFORCE = 'on';
    expect(docsOnlyPrEnforced()).toBe(true);
  });
});
