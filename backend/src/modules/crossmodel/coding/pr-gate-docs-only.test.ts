/**
 * A5 (2026-09-27) — the docs-only classification + PR-diff listing behind the
 * open_pull_request verify gate relief. Pure functions + an injectable git
 * runner, so the rule is pinned without a repo.
 */
import {
  isDocsPath, classifyDocsOnly, listPrDiffFiles, docsOnlyPrBodyNote,
  prGateAutoVerifyDisabled,
  prGateAutoVerifyDeadlineMs, withDeadline,
  PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS, PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS,
} from './pr-gate-docs-only';

describe('A5 pr-gate-docs-only: isDocsPath', () => {
  it.each([
    ['docs/guide.md', true],
    ['docs/sub/dir/diagram.svg', true],
    ['docs/DIGBY_CODE_HARNESS.md', true],
    ['README.md', true],
    ['memory-bank/crossmodel-progress.md', true],
    ['AGENTS.MD', true],
    ['./docs/x.txt', true],
    ['backend/src/modules/crossmodel/coding/tools.ts', false],
    ['frontend/docs-page.tsx', false],
    ['backend/docs/README.txt', false], // docs/ must be at the repo root
    ['notes.mdx', false],
    ['docs', false],
    ['', false],
  ])('%s → %s', (p, expected) => {
    expect(isDocsPath(p)).toBe(expected);
  });
});

describe('A5 pr-gate-docs-only: classifyDocsOnly', () => {
  it('all docs ⇒ docsOnly:true with the file list', () => {
    const v = classifyDocsOnly(['docs/a.md', 'README.md', 'docs/a.md', ' ']);
    expect(v).toEqual({ docsOnly: true, files: ['docs/a.md', 'README.md'], nonDocs: [] });
  });
  it('one code file ⇒ docsOnly:false and names it', () => {
    const v = classifyDocsOnly(['docs/a.md', 'backend/src/x.ts']);
    expect(v.docsOnly).toBe(false);
    expect(v.nonDocs).toEqual(['backend/src/x.ts']);
  });
  it('an EMPTY diff is NOT docs-only (nothing to bypass for)', () => {
    expect(classifyDocsOnly([]).docsOnly).toBe(false);
    expect(classifyDocsOnly(['', '  ']).docsOnly).toBe(false);
  });
});

describe('A5 pr-gate-docs-only: listPrDiffFiles', () => {
  const runner = (table: Record<string, string | Error>) => {
    const calls: string[] = [];
    const run = async (args: string[]) => {
      const key = args.join(' ');
      calls.push(key);
      const hit = table[key];
      if (hit instanceof Error) throw hit;
      return { stdout: hit ?? '' };
    };
    return { run, calls };
  };

  it('unions the branch commits (vs merge-base) with dirty + untracked files', async () => {
    const { run, calls } = runner({
      'merge-base origin/main HEAD': 'abc123\n',
      'diff --name-only abc123 HEAD': 'docs/a.md\nREADME.md\n',
      'diff --name-only HEAD': 'docs/a.md\n',
      'ls-files --others --exclude-standard': 'docs/new.md\n',
    });
    const files = await listPrDiffFiles(run, '/wt', 'main');
    expect(files).toEqual(['docs/a.md', 'README.md', 'docs/new.md']);
    expect(calls[0]).toBe('merge-base origin/main HEAD');
  });

  it('falls back to the local base branch when origin/<base> is missing', async () => {
    const { run, calls } = runner({
      'merge-base origin/main HEAD': new Error('fatal: Not a valid object name origin/main'),
      'merge-base main HEAD': 'def456\n',
      'diff --name-only def456 HEAD': 'src/x.ts\n',
    });
    expect(await listPrDiffFiles(run, '/wt', 'main')).toEqual(['src/x.ts']);
    expect(calls.slice(0, 2)).toEqual(['merge-base origin/main HEAD', 'merge-base main HEAD']);
  });

  it('no resolvable merge-base ⇒ null (the gate treats null as NOT docs-only)', async () => {
    const { run } = runner({
      'merge-base origin/main HEAD': new Error('nope'),
      'merge-base main HEAD': new Error('nope'),
    });
    expect(await listPrDiffFiles(run, '/wt', 'main')).toBeNull();
  });

  it('a git failure after the merge-base ⇒ null (fail-safe)', async () => {
    const { run } = runner({
      'merge-base origin/main HEAD': 'abc\n',
      'diff --name-only abc HEAD': new Error('boom'),
    });
    expect(await listPrDiffFiles(run, '/wt', 'main')).toBeNull();
  });

  it('sanitises the base branch name before it reaches git', async () => {
    const { run, calls } = runner({});
    await listPrDiffFiles(run, '/wt', 'ma;in`$(x)');
    expect(calls[0]).toBe('merge-base origin/mainx HEAD'); // metacharacters stripped (args ride execFile, never a shell)
    expect(await listPrDiffFiles(run, '/wt', ';;')).toBeNull(); // nothing left ⇒ no lookup at all
  });
});

describe('A5 pr-gate-docs-only: note + kill switches', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ['PR_GATE_AUTO_VERIFY_DISABLED']) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('the PR-body note says docs-only + unverified and counts the files', () => {
    expect(docsOnlyPrBodyNote(1)).toContain('Docs-only change (1 file, all under docs/ or *.md)');
    expect(docsOnlyPrBodyNote(3)).toContain('(3 files,');
    expect(docsOnlyPrBodyNote(3)).toContain('unverified by design');
  });

  it('the auto-verify switch defaults OFF and reads only the literal "1"', () => {
    expect(prGateAutoVerifyDisabled()).toBe(false);
    process.env.PR_GATE_AUTO_VERIFY_DISABLED = 'true';
    expect(prGateAutoVerifyDisabled()).toBe(false);
    process.env.PR_GATE_AUTO_VERIFY_DISABLED = '1';
    expect(prGateAutoVerifyDisabled()).toBe(true);
  });
});

describe('review fix 2026-09-27 (HIGH): the auto-verify deadline stays under the agent loop\'s 15-min uncancelled tool abort', () => {
  const saved = process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS;
  beforeEach(() => { delete process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS; });
  afterEach(() => { if (saved === undefined) delete process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS; else process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = saved; });

  it('defaults to 12 min; the ceiling is under TOOL_HARD_TIMEOUT_MS (15 min, agent.ts)', () => {
    expect(prGateAutoVerifyDeadlineMs()).toBe(PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS);
    expect(PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS).toBe(12 * 60 * 1000);
    expect(PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS).toBeLessThan(15 * 60 * 1000);
    expect(PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS).toBeLessThanOrEqual(PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS);
  });

  it('the env override is honoured, clamped to the ceiling, and garbage / ≤0 falls back to the default', () => {
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = '30000';
    expect(prGateAutoVerifyDeadlineMs()).toBe(30_000);
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = String(60 * 60 * 1000); // an hour would re-open the hazard
    expect(prGateAutoVerifyDeadlineMs()).toBe(PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS);
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = 'soon';
    expect(prGateAutoVerifyDeadlineMs()).toBe(PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS);
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = '0';
    expect(prGateAutoVerifyDeadlineMs()).toBe(PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS);
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = '-5';
    expect(prGateAutoVerifyDeadlineMs()).toBe(PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS);
  });

  it('withDeadline: a fast promise yields its value; a slow one yields timedOut and keeps running; a late rejection is swallowed; an early one propagates', async () => {
    expect(await withDeadline(Promise.resolve(7), 50)).toEqual({ timedOut: false, value: 7 });
    let finished = false;
    const slow = new Promise<number>(r => setTimeout(() => { finished = true; r(1); }, 60));
    expect(await withDeadline(slow, 5)).toEqual({ timedOut: true });
    expect(finished).toBe(false); // not cancelled, not finished — the caller must take no side effect
    await slow;
    expect(finished).toBe(true);
    const lateFail = new Promise<number>((_, rej) => setTimeout(() => rej(new Error('late')), 20));
    expect(await withDeadline(lateFail, 5)).toEqual({ timedOut: true });
    await new Promise(r => setTimeout(r, 40)); // the rejection lands after the deadline — must not surface
    await expect(withDeadline(Promise.reject(new Error('early')), 50)).rejects.toThrow('early');
  });
});
