/**
 * v1#29 (P5 publish-path remediation) — sha/tree-keyed verify state.
 *
 * The PR gate's "verified" boolean was session-scoped and STALE across commits.
 * recordVerify now stores a fingerprint (HEAD sha + a full-worktree content
 * tree hash) and the open_pull_request gate re-fingerprints and compares:
 *   - verify → commit of exactly-verified content → gate PASSES (commit moves
 *     HEAD but not the content tree — the everyday verify→commit→PR flow);
 *   - verify → NEW edit (or new commit with different content) → gate BLOCKS
 *     as STALE — with NO explicit clearing by write_file/edit_file/run_command
 *     (the fingerprint comparison covers mutation, proven here);
 *   - legacy fingerprint-less states pass unchanged (fail-open on ABSENCE —
 *     deploy-safe for in-flight sessions).
 *
 * Real temp git repo + a REAL .digby/config.json (gatePullRequest defaults
 * true); the context store is an in-memory map so recordVerify/getVerifyState
 * genuinely round-trip. "Gate passed" is observed as falling through to the
 * next hard failure (no GitHub token).
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

// In-memory context store: recordVerify/getVerifyState round-trip for real.
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
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits', MERGE_SIZE_GUARD: 'merge_size_guard' },
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
import { captureVerifyFingerprint, getVerifyState, recordVerify } from './verify-state';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('v1#29: sha/tree-keyed verify state', () => {
  let wt: string;
  const g = (args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' }).toString();

  // execShell serves the verify CHAIN and also git plumbing (commit etc.), so
// the counter filters to chain invocations only — by command, like the a5
// suite does. STALE detection is now observed as "the gate re-runs the chain"
// rather than as a refusal (auto-verify is unconditional since RSW-1 retired
// the plain-refusal switch on 2026-11-12); a fresh pass takes the fast path
// and runs nothing.
  let chainRuns = 0;
  const mkCtx = (over: Partial<ToolContext> = {}) => ({
    worktree: wt, sessionId: 'sess-29', userId: 'u1', permissionMode: 'auto',
    provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async (cmd: any) => {
      if (String(cmd || '').includes('npm test')) chainRuns++;
      return { stdout: '__DIGBY_EXIT__ 0', stderr: '' };
    },
    getGithubToken: async () => null, // gate-pass is observed as the token failure
    userTurnAt: new Date(),
    ...over,
  } as unknown as ToolContext);

  beforeEach(async () => {
    memStore.clear();
    chainRuns = 0;
    // A5 (2026-09-27): the gate RE-RUNS the chain on a stale/unpassed state
    // instead of refusing (open-pull-request-verify-gate.a5.test.ts covers that
    // arm). This suite pins the staleness DETECTION that drives it: the gate
    // still classifies the state as STALE, it just auto-verifies rather than
    // refusing. (RSW-1 retired the switch that used to force the refusal path.)
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'v129-wt-'));
    g(['init', '-q', '-b', 'digby/x']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    await fs.mkdir(path.join(wt, '.digby'), { recursive: true });
    await fs.writeFile(path.join(wt, '.digby', 'config.json'), JSON.stringify({
      commands: { test: 'npm test' }, verify: ['test'],
    }));
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(['add', '.']);
    g(['commit', '-qm', 'c1']);
  });

  afterEach(async () => {
    await fs.rm(wt, { recursive: true, force: true });
  });

  it('verify records the fingerprint (HEAD sha + content tree)', async () => {
    const out = await executeCodingTool(mkCtx(), 'verify', {});
    expect(out).toContain('Verify PASSED');
    const vs = await getVerifyState('sess-29');
    expect(vs).toMatchObject({ passed: true });
    expect(vs!.sha).toBe(g(['rev-parse', 'HEAD']).trim());
    expect(vs!.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the everyday flow passes: edit → verify (dirty) → commit the SAME content → PR gate opens', async () => {
    await fs.writeFile(path.join(wt, 'a.txt'), 'v2\n'); // dirty edit
    await executeCodingTool(mkCtx(), 'verify', {});
    const out = await executeCodingTool(mkCtx(), 'git_commit', { message: 'c2' });
    expect(out).not.toContain('failed');
    // Gate passed ⇒ the NEXT failure is the token, not a PR block.
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(pr).toContain('No connected GitHub account/token');
    expect(pr).not.toContain('PR blocked');
  });

  it('PROOF (no explicit clearing needed): a write_file AFTER verify invalidates the pass — the gate detects STALE and re-runs the chain', async () => {
    await executeCodingTool(mkCtx(), 'verify', {});
    expect(chainRuns).toBe(1);
    // Mutate via the actual mutation tool — nothing clears the verify state.
    await executeCodingTool(mkCtx(), 'write_file', { path: 'b.txt', content: 'new content\n' });
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    // STALE was detected: the gate did not take the fast path, it re-ran the chain.
    expect(chainRuns).toBe(2);
    expect(pr).toContain('No connected GitHub account/token');
  });

  it('a NEW COMMIT with different content after verify is also detected as STALE (the gate re-runs the chain)', async () => {
    await executeCodingTool(mkCtx(), 'verify', {});
    expect(chainRuns).toBe(1);
    await fs.writeFile(path.join(wt, 'a.txt'), 'v3\n');
    g(['add', '.']);
    g(['commit', '-qm', 'c3']);
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(chainRuns).toBe(2);
    expect(pr).toContain('No connected GitHub account/token');
  });

  it('a re-verify on the CURRENT state re-opens the gate: STALE re-runs the chain, fresh takes the fast path', async () => {
    await executeCodingTool(mkCtx(), 'verify', {});
    await executeCodingTool(mkCtx(), 'write_file', { path: 'b.txt', content: 'new\n' });
    const stale = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(chainRuns).toBe(2); // STALE detected ⇒ re-ran
    expect(stale).toContain('No connected GitHub account/token');
    await executeCodingTool(mkCtx(), 'verify', {});
    expect(chainRuns).toBe(3);
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(chainRuns).toBe(3); // fresh pass ⇒ fast path, no extra run
    expect(pr).toContain('No connected GitHub account/token');
  });

  it('LEGACY fingerprint-less state passes unchanged (fail-open on absence — deploy-safe for in-flight sessions)', async () => {
    await recordVerify('sess-29', true); // pre-P5 shape: no fingerprint
    await executeCodingTool(mkCtx(), 'write_file', { path: 'b.txt', content: 'drift\n' });
    const pr = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 't' });
    expect(pr).toContain('No connected GitHub account/token');
  });

  it('captureVerifyFingerprint: the content tree is stable across a commit of the same content and moves on any edit', async () => {
    await fs.writeFile(path.join(wt, 'a.txt'), 'v2\n');
    const dirty = await captureVerifyFingerprint(wt);
    g(['add', '.']);
    g(['commit', '-qm', 'c2']);
    const committed = await captureVerifyFingerprint(wt);
    expect(dirty!.tree).toBe(committed!.tree);       // same content ⇒ same tree
    expect(dirty!.sha).not.toBe(committed!.sha);     // …though HEAD moved
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'x\n'); // NEW untracked file counts as content
    const drifted = await captureVerifyFingerprint(wt);
    expect(drifted!.tree).not.toBe(committed!.tree);
  });
});
