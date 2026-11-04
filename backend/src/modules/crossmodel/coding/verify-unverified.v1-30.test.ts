/**
 * v1#30 (P5 publish-path remediation) — the UNVERIFIED outcome.
 *
 * A missing verifier tool (exit 127 / "No module named X") used to count as
 * PASSED: the skipped stage kept the chain green, the PR gate opened, and the
 * result text read like a real pass. Now:
 *   - runVerifyChain marks the chain `unverified` when it passed only with
 *     skipped stages (passed stays true so auto-verify never fix-loops on a
 *     missing linter — that behavior is deliberate and unchanged);
 *   - the verify tool result reads "Verify UNVERIFIED: …" (honest);
 *   - the receipt records passed:false + unverified:true (an unverified chain
 *     exonerates no verification claim).
 *
 * Gate flip 2026-09-11 (owner: full steam) — the PR gate NO LONGER BLOCKS on
 * unverified: a lane cannot install a missing container tool (the CanLaw bench
 * lane looped 7 verify rounds in 19 min against this wall) and the PR's CI is
 * the verification of record. The gate records a GUARD_STRIKE metric (seam
 * 'unverified_pr_gate', state 'observed') and appends an UNVERIFIED note to the
 * PR result. Opt-in UNVERIFIED_GATE_ENFORCE=1 restores the block (the old
 * UNVERIFIED_GATE_DISABLED kill-switch is retired).
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
  startBackgroundProcess: jest.fn(),
  waitForProcessOutput: jest.fn(),
  readProcessOutput: jest.fn(),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(),
  listProcesses: jest.fn(),
  processSnapshot: jest.fn(() => []),
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

import { executeCodingTool, ToolContext } from './tools';
import { runVerifyChain } from './verify.service';
import { getVerifyState } from './verify-state';
import { extractReceipt } from './run-receipts';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The 2026-09-10 env guard adds a bounded retry backoff — pin it to 1ms so an
// empty-output exit-1 leg (this suite's construction) never stalls jest.
beforeAll(() => { process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1'; });

describe('v1#30: runVerifyChain unverified flag', () => {
  const chain = [
    { key: 'typecheck', command: 'tsc --noEmit' },
    { key: 'lint', command: 'eslint .' },
    { key: 'test', command: 'jest' },
  ];

  const shellByStage = (exitByCmd: Record<string, number>) =>
    async (cmd: string) => {
      // The 2026-09-10 env guard prepends a reap call and heap-caps each leg
      // (NODE_OPTIONS prefix) — match by inclusion, ignore the reap.
      if (cmd.includes('pgrep')) return { stdout: '', stderr: '' };
      const stage = Object.keys(exitByCmd).find(k => cmd.includes(k));
      const code = stage !== undefined ? exitByCmd[stage] : 0;
      return { stdout: `__DIGBY_EXIT__ ${code}`, stderr: '' };
    };

  it('a missing tool (exit 127) keeps passed:true (no fix-loop) but flags unverified', async () => {
    const r = await runVerifyChain(shellByStage({ 'eslint .': 127 }), '/wt', chain, 1000);
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(true);
    expect(r.stages.find(s => s.key === 'lint')).toMatchObject({ skipped: true });
  });

  it('a fully green chain is verified (unverified:false)', async () => {
    const r = await runVerifyChain(shellByStage({}), '/wt', chain, 1000);
    expect(r).toMatchObject({ passed: true, unverified: false });
  });

  it('a REAL failure wins: failed chain is not "unverified", it is failed', async () => {
    const r = await runVerifyChain(shellByStage({ 'eslint .': 127, 'jest': 1 }), '/wt', chain, 1000);
    expect(r).toMatchObject({ passed: false, unverified: false, failedStage: 'test' });
  });
});

describe('v1#30: verify tool + PR gate honesty (observe-only since the 2026-09-11 gate flip)', () => {
  let wt: string;
  const g = (args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' });

  // The lint tool is "not installed" (exit 127); everything else exits 0.
  const mkCtx = (over: Partial<ToolContext> = {}) => ({
    worktree: wt, sessionId: 'sess-30', userId: 'u1', runId: 'run-30', permissionMode: 'auto',
    provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async (cmd: string) => cmd.includes('pgrep')
      ? { stdout: '', stderr: '' } // the 2026-09-10 env-guard reap preamble
      : ({ stdout: `__DIGBY_EXIT__ ${cmd.includes('eslint') ? 127 : 0}`, stderr: '' }),
    getGithubToken: async () => null,
    userTurnAt: new Date(),
    ...over,
  } as unknown as ToolContext);

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['UNVERIFIED_GATE_ENFORCE', 'UNVERIFIED_GATE_DISABLED'] as const;

  beforeEach(async () => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    mockRecordLoopMetric.mockClear();
    memStore.clear();
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'v130-wt-'));
    g(['init', '-q', '-b', 'digby/x']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    await fs.mkdir(path.join(wt, '.digby'), { recursive: true });
    await fs.writeFile(path.join(wt, '.digby', 'config.json'), JSON.stringify({
      commands: { lint: 'eslint .', test: 'npm test' }, verify: ['lint', 'test'],
    }));
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(['add', '.']);
    g(['commit', '-qm', 'c1']);
  });

  afterEach(async () => {
    await fs.rm(wt, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  it('the result text is honest: "Verify UNVERIFIED", names the skipped stage, and says the PR gate only NOTES it', async () => {
    const out = await executeCodingTool(mkCtx(), 'verify', {});
    expect(out.startsWith('Verify UNVERIFIED:')).toBe(true);
    expect(out).toContain('lint');
    expect(out).toContain('did NOT fully execute');
    expect(out).toContain('UNVERIFIED note');
    expect(out).not.toContain('does not satisfy the PR gate');
    expect(out).not.toContain('Verify PASSED');
  });

  it('ticket 6a8dddd3: the UNVERIFIED text shows the skipped stage command + output tail, and names the wiped-payload pattern', async () => {
    // The reported failure: the skipped stage RAN (a wrapper exec'ing
    // python -m <tool>) but its /tmp payload had been wiped by the pre-exec
    // disk-pressure cleanup, so python printed "No module named X" (exit 1)
    // and the bare "tool not installed" label gave no hint of the real cause.
    const ctx = mkCtx({
      execShell: async (cmd: string) => cmd.includes('pgrep')
        ? { stdout: '', stderr: '' }
        : cmd.includes('eslint')
          ? { stdout: '/usr/bin/python3: No module named eslint\n__DIGBY_EXIT__ 1', stderr: '' }
          : { stdout: '__DIGBY_EXIT__ 0', stderr: '' },
    });
    const out = await executeCodingTool(ctx, 'verify', {});
    expect(out.startsWith('Verify UNVERIFIED:')).toBe(true);
    // Diagnostics for the skipped stage: its configured command, exit code, output tail…
    expect(out).toContain('--- lint skipped (eslint .; exit 1) ---');
    expect(out).toContain('No module named eslint');
    // …and the actionable wiped-payload hint (reinstall into $HOME/.local or the worktree).
    expect(out).toContain('wiped by the pre-exec disk-pressure cleanup');
    expect(out).toContain('$HOME/.local (preserved)');
  });

  it('the recorded state carries unverified:true and the PR gate LETS IT THROUGH (observed metric, no block)', async () => {
    await executeCodingTool(mkCtx(), 'verify', {});
    expect(await getVerifyState('sess-30')).toMatchObject({ passed: true, unverified: true });
    mockRecordLoopMetric.mockClear();
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    // The gate passed: the flow reached the GitHub token step (this ctx has none).
    expect(pr).toContain('No connected GitHub account/token');
    expect(pr).not.toContain('PR blocked');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'guard_strike', sessionId: 'sess-30', runId: 'run-30',
      meta: { seam: 'unverified_pr_gate', state: 'observed' },
    });
  });

  it('opt-in UNVERIFIED_GATE_ENFORCE=1 restores the PR block', async () => {
    process.env.UNVERIFIED_GATE_ENFORCE = '1';
    await executeCodingTool(mkCtx(), 'verify', {});
    mockRecordLoopMetric.mockClear();
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(pr).toContain('PR blocked');
    expect(pr).toContain('UNVERIFIED');
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: 'unverified_pr_gate' }) }));
  });

  it('the retired UNVERIFIED_GATE_DISABLED kill-switch changes nothing (default is already observe-only)', async () => {
    process.env.UNVERIFIED_GATE_DISABLED = '1';
    await executeCodingTool(mkCtx(), 'verify', {});
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(pr).toContain('No connected GitHub account/token');
  });

  it('a fully green chain still reads "Verify PASSED" and opens the gate with NO unverified metric', async () => {
    const ctx = mkCtx({ execShell: async () => ({ stdout: '__DIGBY_EXIT__ 0', stderr: '' }) } as any);
    const out = await executeCodingTool(ctx, 'verify', {});
    expect(out).toContain('Verify PASSED');
    mockRecordLoopMetric.mockClear();
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(pr).toContain('No connected GitHub account/token');
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ seam: 'unverified_pr_gate' }) }));
  });

  it('a RED chain still blocks the PR outright (the flip touched only the UNVERIFIED arm)', async () => {
    const ctx = mkCtx({ execShell: async (cmd: string) => cmd.includes('pgrep')
      ? { stdout: '', stderr: '' }
      : ({ stdout: `__DIGBY_EXIT__ ${cmd.includes('npm test') ? 1 : 0}\nFAIL a.test.ts`, stderr: '' }) } as any);
    await executeCodingTool(ctx, 'verify', {});
    // A5 (2026-09-27): the gate re-runs the chain itself on an unpassed state
    // (one round instead of three) — the chain is still red at gate time here,
    // so the PR is still refused, now with the failing stage's tail.
    const pr = await executeCodingTool(ctx, 'open_pull_request', { title: 't' });
    expect(pr).toContain('PR blocked');
    expect(pr).toContain('not passed this session');
    expect(pr).toContain('FAILED at "test"');
    expect(pr).toContain('FAIL a.test.ts');
  });

  it('the receipt records the honest verdict: passed:false + unverified:true', () => {
    const receipt = extractReceipt('verify', {}, 'Verify UNVERIFIED: ⊘ lint (skipped — tool not installed)  ✓ test (exit 0)\nStage(s) lint could not run…', new Date());
    expect(receipt).toMatchObject({ ok: true, ids: { passed: false, unverified: true, failedStage: null } });
  });
});
