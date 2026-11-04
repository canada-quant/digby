/**
 * open_pull_request head-branch guard — replay test for ticket c7bf1e66.
 *
 * The mishap (prod, session a8976e11 on canada-quant/tt-rd): the lane created
 * branch digby/f464-fold-l5finetimer via the GitHub REST API and called
 * open_pull_request — the tool opened PR #629 whose head.ref was the ANCIENT
 * unrelated branch digby/gdn-window-a, and still reported "Opened PR #629" as
 * success. Three gaps, three fixes, three pins:
 *
 *   1. NO explicit head parameter → new optional `headBranch` arg: the push of
 *      the worktree checkout is skipped and the named branch is verified to
 *      exist on the remote (GitHub 404 ⇒ loud refusal, nothing opened).
 *   2. Head re-resolved from the worktree's mutable checkout AFTER the push →
 *      the head is resolved ONCE up front and pinned into pushSessionBranch
 *      (structural — covered by code review; the push+PR path needs a real
 *      remote so it is not unit-executed here).
 *   3. No verification of the created PR → createPullRequestWithHeadCheck
 *      compares the POST /pulls response's head.ref against the requested head
 *      and FAILS LOUDLY (never emits the 'Opened PR #' success prefix the
 *      run-receipts extractor keys on) + records a pr_head_mismatch
 *      guard-strike.
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
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
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
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage',
    CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard',
    GUARD_STRIKE: 'guard_strike',
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

const axiosGet = jest.fn();
const axiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => axiosGet(...a), post: (...a: any[]) => axiosPost(...a) },
}));

import {
  executeCodingTool, ToolContext,
  createPullRequestWithHeadCheck, verifyRemoteBranchExists, isValidBranchName,
} from './tools';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('ticket c7bf1e66: open_pull_request head-branch guard', () => {
  let wt: string;

  const mkCtx = (over: Partial<ToolContext> = {}) => ({
    worktree: wt, sessionId: 'sess-c7bf1e66', userId: 'u1', permissionMode: 'auto',
    provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/session-a8976e11', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '__DIGBY_EXIT__ 0', stderr: '' }),
    getGithubToken: async () => 'tok',
    userTurnAt: new Date(),
    prGateBypass: true, // the human "Open PR" path — skips the verify gate + post-push CI poll
    ...over,
  } as unknown as ToolContext);

  beforeEach(async () => {
    jest.clearAllMocks();
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'c7bf1e66-wt-'));
  });

  afterEach(async () => {
    await fs.rm(wt, { recursive: true, force: true });
  });

  it('explicit headBranch: verifies the remote ref, skips the worktree push, opens from that branch', async () => {
    axiosGet.mockResolvedValueOnce({ data: { ref: 'refs/heads/digby/f464-fold-l5finetimer' } });
    axiosPost.mockResolvedValueOnce({
      data: { number: 630, html_url: 'https://github.com/o/r/pull/630', head: { ref: 'digby/f464-fold-l5finetimer' } },
    });
    const out = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 'fold', headBranch: 'digby/f464-fold-l5finetimer' });
    // Remote ref verified via the git/ref API…
    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.github.com/repos/o/r/git/ref/heads/digby/f464-fold-l5finetimer', expect.anything(),
    );
    // …and the PR opened with THAT branch as head (not the session branch)…
    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.github.com/repos/o/r/pulls',
      expect.objectContaining({ head: 'digby/f464-fold-l5finetimer', base: 'main' }),
      expect.anything(),
    );
    // …with the success prefix intact (receipt extractor keys on it).
    expect(out).toContain('Opened PR #630: https://github.com/o/r/pull/630');
    // The worktree push was skipped — a push attempt against this fake remote
    // would have failed and short-circuited long before the POST above.
    expect(out).not.toContain('git push failed');
  });

  it('explicit headBranch not on the remote (GitHub 404): refuses loudly, opens nothing', async () => {
    axiosGet.mockRejectedValueOnce({ response: { status: 404, data: { message: 'Not Found' } } });
    const out = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 'fold', headBranch: 'digby/f464-fold-l5finetimer' });
    expect(out).toContain('"digby/f464-fold-l5finetimer" is not on the remote o/r');
    expect(out).toContain('Nothing was opened');
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('invalid headBranch shape: refused before any network call', async () => {
    const out = await executeCodingTool(mkCtx(), 'open_pull_request', { title: 'fold', headBranch: 'bad branch' });
    expect(out).toContain('Invalid headBranch "bad branch"');
    expect(axiosGet).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('REPLAY of the mishap: a created PR whose head.ref mismatches the requested head fails loudly', async () => {
    // The ticket's exact shape: requested the fold branch, GitHub reports the
    // PR's head as the ancient digby/gdn-window-a.
    axiosPost.mockResolvedValueOnce({
      data: { number: 629, html_url: 'https://github.com/o/r/pull/629', head: { ref: 'digby/gdn-window-a' } },
    });
    const res = await createPullRequestWithHeadCheck({
      token: 'tok', owner: 'o', repo: 'r',
      title: 'fold', body: '', base: 'main', head: 'digby/f464-fold-l5finetimer',
      sessionId: 'sess-c7bf1e66', runId: 'run-1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Names the wrong PR, both branches, and refuses the success framing —
      // the run-receipts extractor must NOT see an 'Opened PR #' prefix here.
      expect(res.message).toContain('#629');
      expect(res.message).toContain('digby/f464-fold-l5finetimer');
      expect(res.message).toContain('digby/gdn-window-a');
      expect(res.message).toContain('Refusing to report success');
      expect(res.message).not.toContain('Opened PR #');
    }
    // Telemetry: the mismatch is a guard-strike, never silent.
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike',
      meta: expect.objectContaining({ seam: 'pr_head_mismatch', expected: 'digby/f464-fold-l5finetimer', actual: 'digby/gdn-window-a', prNumber: 629 }),
    }));
  });

  it('matching head.ref passes through with the PR number + url', async () => {
    axiosPost.mockResolvedValueOnce({
      data: { number: 631, html_url: 'https://github.com/o/r/pull/631', head: { ref: 'digby/x' } },
    });
    const res = await createPullRequestWithHeadCheck({
      token: 'tok', owner: 'o', repo: 'r', title: 't', body: 'b', base: 'main', head: 'digby/x',
    });
    expect(res).toEqual({ ok: true, number: 631, url: 'https://github.com/o/r/pull/631' });
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });

  it('verifyRemoteBranchExists: non-404 verification failures are loud and open nothing', async () => {
    axiosGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await verifyRemoteBranchExists('tok', 'o', 'r', 'digby/y');
    expect(res).not.toBe(true);
    expect(String(res)).toContain('Could not verify remote branch "digby/y"');
    expect(String(res)).toContain('Nothing was opened');
  });

  it('verifyRemoteBranchExists: success returns the branch tip sha for the post-PR CI observation', async () => {
    axiosGet.mockResolvedValueOnce({ data: { ref: 'refs/heads/digby/y', object: { sha: 'abc123def' } } });
    const res = await verifyRemoteBranchExists('tok', 'o', 'r', 'digby/y');
    expect(res).toEqual({ sha: 'abc123def' });
  });

  it('isValidBranchName: everyday check-ref-format rules', () => {
    expect(isValidBranchName('digby/f464-fold-l5finetimer')).toBe(true);
    expect(isValidBranchName('digby/session-a8976e11')).toBe(true);
    expect(isValidBranchName('bad branch')).toBe(false);
    expect(isValidBranchName('bad..dots')).toBe(false);
    expect(isValidBranchName('/leading')).toBe(false);
    expect(isValidBranchName('trailing/')).toBe(false);
    expect(isValidBranchName('-flag')).toBe(false);
    expect(isValidBranchName('tip.lock')).toBe(false);
    expect(isValidBranchName('')).toBe(false);
  });
});
