/**
 * A5 (2026-09-27) — open_pull_request verify gate: docs-only bypass + auto-verify.
 *
 * Before: the gate REFUSED any PR until the verify chain had passed this session
 * on the current content — docs-only PRs included — so every docs-keeper PR since
 * 2026-09-25 cost a refusal, a verify round and a retry (prod receipts:
 * open_pull_request ok=false 3/7/4 vs ok=true 3/7/4, a verify row between each
 * pair). Now:
 *   - a DOCS-ONLY diff (every file the PR carries is under docs/ or *.md) skips
 *     the chain; the PR body carries a "docs-only, unverified" note and a
 *     guard_strike {seam:'pr_gate_docs_only', state:'observed'} row is recorded;
 *   - otherwise the tool RUNS the chain itself (one round instead of three),
 *     opens on green, and still refuses on red — with the failing stage's tail;
 *   - PR_GATE_AUTO_VERIFY_DISABLED=1 restores the previous behaviour (the old
 *     refusal text is byte-identical).
 *
 * Real temp git repo with a local `main` (merge-base falls back from
 * origin/main) + a REAL .digby/config.json (gatePullRequest defaults true); the
 * context store is an in-memory map so recordVerify/getVerifyState round-trip.
 * "Gate passed" is observed as falling through to the next hard failure (no
 * GitHub token) — except the PR-body test, which mocks axios + an explicit
 * headBranch so the body reaches the POST.
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
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));

const memStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => memStore.get(`${ns.join('/')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { memStore.set(`${ns.join('/')}/${key}`, value); }),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard', GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
  },
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(), waitForProcessOutput: jest.fn(), readProcessOutput: jest.fn(),
  releaseHandle: jest.fn(), stopProcess: jest.fn(), listProcesses: jest.fn(), processSnapshot: jest.fn(() => []),
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
import { getVerifyState } from './verify-state';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

beforeAll(() => { process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1'; });

describe('A5: open_pull_request verify gate — docs-only bypass + auto-verify', () => {
  let wt: string;
  const g = (args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' }).toString();

  /** Records every verify-stage command the gate/tool runs; `red` makes the test stage fail. */
  const shell = (opts: { red?: boolean } = {}) => {
    const calls: string[] = [];
    const execShell = async (cmd: string) => {
      if (cmd.includes('pgrep')) return { stdout: '', stderr: '' }; // env-guard reap preamble
      calls.push(cmd);
      const isTest = cmd.includes('npm test');
      return { stdout: `${isTest && opts.red ? 'FAIL a.test.ts\n' : ''}__DIGBY_EXIT__ ${isTest && opts.red ? 1 : 0}`, stderr: '' };
    };
    return { execShell, calls, verifyRuns: () => calls.filter(c => c.includes('npm test')).length };
  };

  const mkCtx = (over: Partial<ToolContext> = {}) => ({
    worktree: wt, sessionId: 'sess-a5', userId: 'u1', runId: 'run-a5', permissionMode: 'auto',
    provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '__DIGBY_EXIT__ 0', stderr: '' }),
    getGithubToken: async () => null,
    userTurnAt: new Date(),
    ...over,
  } as unknown as ToolContext);

  const ENV_KEYS = ['PR_GATE_AUTO_VERIFY_DISABLED', 'PR_GATE_AUTO_VERIFY_DEADLINE_MS', 'UNVERIFIED_GATE_ENFORCE'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  const commitAll = (msg: string) => { g(['add', '-A']); g(['commit', '-qm', msg]); };

  beforeEach(async () => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    mockRecordLoopMetric.mockClear();
    axiosGet.mockReset(); axiosPost.mockReset();
    memStore.clear();
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'a5-prgate-'));
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    await fs.mkdir(path.join(wt, '.digby'), { recursive: true });
    await fs.mkdir(path.join(wt, 'docs'), { recursive: true });
    await fs.mkdir(path.join(wt, 'src'), { recursive: true });
    await fs.writeFile(path.join(wt, '.digby', 'config.json'), JSON.stringify({ commands: { test: 'npm test' }, verify: ['test'] }));
    await fs.writeFile(path.join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(wt, 'docs', 'guide.md'), '# guide\n');
    await fs.writeFile(path.join(wt, 'README.md'), '# readme\n');
    commitAll('base');
    g(['checkout', '-q', '-b', 'digby/x']);
  });

  afterEach(async () => {
    await fs.rm(wt, { recursive: true, force: true });
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  });

  const docsOnlyBranch = async () => {
    await fs.writeFile(path.join(wt, 'docs', 'guide.md'), '# guide\n\nmore\n');
    await fs.writeFile(path.join(wt, 'README.md'), '# readme\n\nmore\n');
    commitAll('docs');
  };
  const codeBranch = async () => {
    await fs.writeFile(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    commitAll('code');
  };

  it('docs-only branch, no verify this session: the gate is SKIPPED, no chain runs, the metric names the files', async () => {
    await docsOnlyBranch();
    const sh = shell();
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell }), 'open_pull_request', { title: 'docs' });
    expect(out).not.toContain('PR blocked');
    expect(out).toContain('No connected GitHub account/token'); // fell through the gate
    expect(sh.verifyRuns()).toBe(0);
    expect(await getVerifyState('sess-a5')).toBeNull(); // nothing recorded — the chain never ran
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', sessionId: 'sess-a5', runId: 'run-a5', value: 2,
      meta: expect.objectContaining({ seam: 'pr_gate_docs_only', state: 'observed', outcome: 'observed', reason: 'unpassed', files: expect.arrayContaining(['docs/guide.md', 'README.md']) }),
    }));
  });

  it('docs-only PR: the PR BODY carries the "docs-only, unverified" note and the result says the gate was skipped', async () => {
    await docsOnlyBranch();
    axiosGet.mockResolvedValueOnce({ data: { ref: 'refs/heads/digby/x', object: { sha: 'abc' } } });
    axiosPost.mockResolvedValueOnce({ data: { number: 7, html_url: 'https://github.com/o/r/pull/7', head: { ref: 'digby/x' } } });
    const sh = shell();
    const out = await executeCodingTool(
      mkCtx({ execShell: sh.execShell, getGithubToken: async () => 'tok' }),
      'open_pull_request', { title: 'docs', body: 'Keeper update.', headBranch: 'digby/x' },
    );
    expect(out).toContain('Opened PR #7');
    expect(out).toContain('docs-only diff (2 files under docs/ or *.md)');
    expect(out).toContain('"docs-only, unverified"');
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.github.com/repos/o/r/pulls',
      expect.objectContaining({ body: expect.stringMatching(/^Keeper update\.\n\n---\n_Docs-only change \(2 files, all under docs\/ or \*\.md\): the verify chain was not run for this PR — unverified by design/) }),
      expect.anything(),
    );
    expect(sh.verifyRuns()).toBe(0);
  });

  it('a docs-only branch with a DIRTY code file in the working tree is NOT docs-only (conservative union) — auto-verify runs', async () => {
    await docsOnlyBranch();
    await fs.writeFile(path.join(wt, 'src', 'a.ts'), 'export const a = 3;\n'); // uncommitted code edit
    const sh = shell();
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell }), 'open_pull_request', { title: 'docs' });
    expect(out).toContain('No connected GitHub account/token');
    expect(sh.verifyRuns()).toBe(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: 'pr_gate_docs_only' }) }));
  });

  it('code branch, no verify this session: the tool RUNS the chain itself, records the pass, and proceeds (one round, not three)', async () => {
    await codeBranch();
    const sh = shell();
    const ctx = mkCtx({ execShell: sh.execShell });
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 'code' });
    expect(out).not.toContain('PR blocked');
    expect(out).toContain('No connected GitHub account/token');
    expect(sh.verifyRuns()).toBe(1);
    expect(await getVerifyState('sess-a5')).toMatchObject({ passed: true });
    expect((await getVerifyState('sess-a5'))?.unverified).toBeFalsy();
    // The live view sees the same events the verify tool emits.
    expect((ctx.emit as jest.Mock).mock.calls.map(c => c[0])).toEqual(expect.arrayContaining(['verify_start', 'verify_result']));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', sessionId: 'sess-a5', runId: 'run-a5',
      meta: expect.objectContaining({ seam: 'pr_gate_auto_verify', state: 'observed', outcome: 'observed', verdict: 'green', reason: 'unpassed', passed: true, unverified: false, headMismatch: false }),
    }));
  });

  it('code branch, auto-verify GREEN: the PR result carries the [auto-verify] note', async () => {
    await codeBranch();
    axiosGet.mockResolvedValueOnce({ data: { ref: 'refs/heads/digby/x', object: { sha: 'abc' } } });
    axiosPost.mockResolvedValueOnce({ data: { number: 8, html_url: 'https://github.com/o/r/pull/8', head: { ref: 'digby/x' } } });
    const sh = shell();
    const out = await executeCodingTool(
      mkCtx({ execShell: sh.execShell, getGithubToken: async () => 'tok' }),
      'open_pull_request', { title: 'code', body: 'Fix.', headBranch: 'digby/x' },
    );
    expect(out).toContain('Opened PR #8');
    expect(out).toContain('[auto-verify] the verify chain had not passed this session; open_pull_request ran it itself: ✓ test (exit 0)');
    // No docs-only trailer on a code PR.
    expect(axiosPost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: 'Fix.' }), expect.anything());
  });

  it('code branch, auto-verify RED: still refuses, names the stage + tail, nothing pushed, state records the failure', async () => {
    await codeBranch();
    const sh = shell({ red: true });
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell }), 'open_pull_request', { title: 'code' });
    expect(out).toContain('PR blocked');
    expect(out).toContain('open_pull_request ran the chain itself');
    expect(out).toContain('FAILED at "test"');
    expect(out).toContain('FAIL a.test.ts');
    expect(out).toContain('nothing was pushed or opened');
    expect(out).not.toContain('No connected GitHub account/token');
    expect(await getVerifyState('sess-a5')).toMatchObject({ passed: false, failedStage: 'test' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'pr_gate_auto_verify', outcome: 'observed', verdict: 'red', passed: false, failedStage: 'test' }),
    }));
  });

  it('PR_GATE_AUTO_VERIFY_DISABLED=1: the previous refusal text, byte-identical, no chain run', async () => {
    process.env.PR_GATE_AUTO_VERIFY_DISABLED = '1';
    await codeBranch();
    const sh = shell();
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell }), 'open_pull_request', { title: 'code' });
    expect(out).toBe('PR blocked: the verify chain (test) has not passed this session. Run verify and get it green, and have the reviewer sign off, before opening the PR.');
    expect(sh.verifyRuns()).toBe(0);
  });

  it('STALE pass (verified, then a code edit): auto-verify re-runs on the CURRENT content and proceeds', async () => {
    await codeBranch();
    const sh = shell();
    const ctx = mkCtx({ execShell: sh.execShell });
    expect(await executeCodingTool(ctx, 'verify', {})).toContain('Verify PASSED');
    await fs.writeFile(path.join(wt, 'src', 'a.ts'), 'export const a = 4;\n');
    commitAll('more code');
    mockRecordLoopMetric.mockClear();
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 'code' });
    expect(out).not.toContain('STALE');
    expect(out).toContain('No connected GitHub account/token');
    expect(sh.verifyRuns()).toBe(2); // the explicit verify + the gate's re-run
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'pr_gate_auto_verify', reason: 'stale', passed: true }),
    }));
  });

  it('STALE pass + PR_GATE_AUTO_VERIFY_DISABLED=1: the previous STALE refusal', async () => {
    process.env.PR_GATE_AUTO_VERIFY_DISABLED = '1';
    await codeBranch();
    const sh = shell();
    const ctx = mkCtx({ execShell: sh.execShell });
    await executeCodingTool(ctx, 'verify', {});
    await fs.writeFile(path.join(wt, 'src', 'a.ts'), 'export const a = 4;\n');
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 'code' });
    expect(out).toContain('PR blocked: the verify pass is STALE');
    expect(sh.verifyRuns()).toBe(1);
  });

  it('a fresh green pass on the current content: neither bypass nor auto-verify fires (unchanged fast path)', async () => {
    await codeBranch();
    const sh = shell();
    const ctx = mkCtx({ execShell: sh.execShell });
    await executeCodingTool(ctx, 'verify', {});
    mockRecordLoopMetric.mockClear();
    const out = await executeCodingTool(ctx, 'open_pull_request', { title: 'code' });
    expect(out).toContain('No connected GitHub account/token');
    expect(sh.verifyRuns()).toBe(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: expect.stringMatching(/^pr_gate_/) }) }));
  });

  it('auto-verify that passes only UNVERIFIED (tool missing) keeps the v1#30 observe-only note', async () => {
    await codeBranch();
    await fs.writeFile(path.join(wt, '.digby', 'config.json'), JSON.stringify({ commands: { lint: 'eslint .', test: 'npm test' }, verify: ['lint', 'test'] }));
    commitAll('chain');
    const execShell = async (cmd: string) => cmd.includes('pgrep')
      ? { stdout: '', stderr: '' }
      : { stdout: `__DIGBY_EXIT__ ${cmd.includes('eslint') ? 127 : 0}`, stderr: '' };
    const out = await executeCodingTool(mkCtx({ execShell }), 'open_pull_request', { title: 'code' });
    expect(out).toContain('No connected GitHub account/token');
    expect(await getVerifyState('sess-a5')).toMatchObject({ passed: true, unverified: true });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: 'unverified_pr_gate', state: 'observed' }) }));
  });

  it('the human "Open PR" button (prGateBypass) is untouched: no classification, no chain', async () => {
    await codeBranch();
    const sh = shell();
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell, prGateBypass: true }), 'open_pull_request', { title: 'code' });
    expect(out).toContain('No connected GitHub account/token');
    expect(sh.verifyRuns()).toBe(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  // ── Review fixes (2026-09-27) ──────────────────────────────────────────────

  it('HIGH: an auto-verify that outlives PR_GATE_AUTO_VERIFY_DEADLINE_MS refuses (pointing at verify) — NOTHING pushed or opened, the timeout is on the row; the chain finishes behind it and the retry passes the gate without re-running', async () => {
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = '40';
    await codeBranch();
    const calls: string[] = [];
    const execShell = async (cmd: string) => {
      if (cmd.includes('pgrep')) return { stdout: '', stderr: '' };
      calls.push(cmd);
      if (cmd.includes('npm test')) await new Promise(r => setTimeout(r, 200)); // the slow chain (outlives the 40 ms deadline)
      return { stdout: '__DIGBY_EXIT__ 0', stderr: '' };
    };
    const getGithubToken = jest.fn(async () => 'tok');
    const out = await executeCodingTool(mkCtx({ execShell, getGithubToken }), 'open_pull_request', { title: 'code', body: 'Fix.' });
    expect(out).toContain('PR blocked');
    expect(out).toContain('open_pull_request ran the chain itself');
    expect(out).toMatch(/did not finish within \d+s/);
    expect(out).toContain('Run `verify`');
    expect(out).toContain('nothing was pushed or opened');
    expect(getGithubToken).not.toHaveBeenCalled(); // the push / PR-create path was never entered
    expect(axiosGet).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', sessionId: 'sess-a5', runId: 'run-a5',
      meta: expect.objectContaining({ seam: 'pr_gate_auto_verify', state: 'observed', outcome: 'observed', reason: 'unpassed', verdict: 'timeout', timedOut: true, deadlineMs: 40 }),
    }));
    expect(await getVerifyState('sess-a5')).toBeNull(); // returned BEFORE the chain finished — nothing recorded yet
    // The chain finishes on its own and records the pass (the pre-A5 `verify` behaviour).
    // NOT a fixed sleep (ticket 7fbc34cd follow-up, 2026-10-09): the mocked chain sleeps
    // 200 ms of WALL time, but under full-suite load (4 workers, a descheduled worker
    // stretches every timer) a fixed 400 ms wait false-reds here — observed live: this
    // exact line failed in a 1119-suite verify run while the suite passes 17/17 in
    // isolation (f105, FO lane 5f90c628). A bounded poll (5 s ceiling, 25 ms ticks)
    // waits exactly as long as the row takes, never longer, and fails ONLY if the chain
    // genuinely never records — the load-sensitive false-red class, same shape as the
    // ca4798a6 worker-starvation ticket.
    const deadline = Date.now() + 5_000;
    let recorded: any = null;
    while (Date.now() < deadline && !(recorded = await getVerifyState('sess-a5'))) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(recorded).toMatchObject({ passed: true });
    expect(calls.filter(c => c.includes('npm test'))).toHaveLength(1);
    // … so the retry passes the gate WITHOUT re-running the chain and reaches the push path.
    mockRecordLoopMetric.mockClear();
    const retry = await executeCodingTool(mkCtx({ execShell, getGithubToken: async () => null }), 'open_pull_request', { title: 'code' });
    expect(retry).toContain('No connected GitHub account/token');
    expect(calls.filter(c => c.includes('npm test'))).toHaveLength(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: expect.stringMatching(/^pr_gate_/) }) }));
  });

  it('HIGH: a chain that finishes inside the deadline is unaffected (green opens, the row says verdict green)', async () => {
    process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS = '5000';
    await codeBranch();
    const sh = shell();
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell }), 'open_pull_request', { title: 'code' });
    expect(out).toContain('No connected GitHub account/token');
    expect(sh.verifyRuns()).toBe(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'pr_gate_auto_verify', verdict: 'green', passed: true }),
    }));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ verdict: 'timeout' }) }));
  });

  it('MEDIUM: a docs-only CHECKOUT plus a DIFFERENT explicit headBranch is NOT docs-only — no bypass, auto-verify runs, the row says headMismatch, and BOTH the result and the PR body qualify the green (the chain attests the checkout, not this head)', async () => {
    await docsOnlyBranch(); // the worktree checkout (digby/x) is docs-only …
    axiosGet.mockResolvedValueOnce({ data: { ref: 'refs/heads/digby/other', object: { sha: 'def' } } });
    axiosPost.mockResolvedValueOnce({ data: { number: 9, html_url: 'https://github.com/o/r/pull/9', head: { ref: 'digby/other' } } });
    const sh = shell();
    const out = await executeCodingTool(
      mkCtx({ execShell: sh.execShell, getGithubToken: async () => 'tok' }),
      'open_pull_request', { title: 'code', body: 'Body.', headBranch: 'digby/other' }, // … but the PR opens from an out-of-band branch
    );
    expect(out).toContain('Opened PR #9');
    // Shortfall fix (2026-10-04, nightly S1): NO unqualified "[auto-verify] … green"
    // on a head the chain never saw — the result note QUALIFIES the green instead.
    expect(out).not.toContain('[auto-verify]');
    expect(out).toContain('verify chain green (✓ test (exit 0)), but it ran against the WORKTREE checkout — this PR opens from out-of-band head digby/other');
    expect(out).toContain('CI on the PR is the verification of record');
    expect(out).not.toContain('docs-only');
    expect(sh.verifyRuns()).toBe(1);
    // The PR body carries the same honest scope trailer (prHeadMismatchBodyNote).
    expect(axiosPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        head: 'digby/other',
        body: expect.stringMatching(/^Body\.\n\n---\n_Verification scope note: this PR opens from out-of-band head `digby\/other`, which is NOT the worktree checkout the auto-verify chain ran against — the green result attests the checkout, not this head\. CI on the PR is the verification of record\._/),
      }),
      expect.anything(),
    );
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: 'pr_gate_docs_only' }) }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'pr_gate_auto_verify', outcome: 'observed', verdict: 'green', headMismatch: true }),
    }));
  });

  it('MEDIUM: an explicit headBranch EQUAL to the checkout keeps the docs-only bypass (the PR-body test above) — and a malformed headBranch refuses BEFORE the gate: no classification, no chain, no network', async () => {
    await codeBranch();
    const sh = shell();
    const out = await executeCodingTool(mkCtx({ execShell: sh.execShell }), 'open_pull_request', { title: 'code', headBranch: 'bad branch' });
    expect(out).toContain('Invalid headBranch "bad branch"');
    expect(out).toContain('Nothing was opened');
    expect(sh.verifyRuns()).toBe(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });
});
