/**
 * v1#28 (P5 publish-path remediation) — CI observation.
 *
 *   a. `check_ci` READ tool: GitHub Checks API (legacy status fallback), sha
 *      defaulting to the last sha this session pushed (receipts) → HEAD.
 *   b. git_push's ONE bounded post-push poll: the result carries a
 *      "CI: pending|success|failure|none" line; failure emits ci_failed.
 *      Kill-switch PUSH_CI_OBSERVE_DISABLED.
 *   c. `ci_failed` hook event: emitted only for shas THIS session pushed.
 *
 * axios + hooks.service + run-receipts.service are mocked at the module
 * boundary; the git_push wiring test pushes to a REAL local bare remote whose
 * path ends in .../github.com/o/r so parseOwnerRepo resolves an owner/repo.
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

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockAxiosGet(...a), post: jest.fn() },
}));

const mockEmitHookEventSafe = jest.fn(async () => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => (mockEmitHookEventSafe as any)(...a),
}));

const mockGetRecentChatReceipts = jest.fn(async () => [] as any[]);
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
  getRunReceipts: jest.fn(async () => []),
  recordRunReceiptAsync: jest.fn(),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async () => null),
  findPriorRunPrReceipt: jest.fn(async () => null),
  prHeadMatchesReceipt: jest.fn(async () => false),
}));

import { executeCodingTool, ToolContext } from './tools';
import { fetchCiStatus, observeCiAfterPush, CI_CHECKS_CAP } from './ci-status';
import { extractReceipt } from './run-receipts';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const flush = () => new Promise((r) => setImmediate(r));

const checkRunsResp = (runs: Array<{ name: string; status?: string; conclusion?: string | null }>, total?: number) => ({
  data: {
    total_count: total ?? runs.length,
    check_runs: runs.map((r) => ({ name: r.name, status: r.status ?? 'completed', conclusion: r.conclusion === undefined ? 'success' : r.conclusion })),
  },
});

describe('v1#28a: fetchCiStatus aggregation', () => {
  beforeEach(() => mockAxiosGet.mockReset());

  it('all check runs green → success', async () => {
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'build' }, { name: 'test' }]));
    const ci = await fetchCiStatus('tok', 'o', 'r', 'a'.repeat(40));
    expect(ci).toMatchObject({ state: 'success', total: 2, failing: [] });
    expect(mockAxiosGet.mock.calls[0][0]).toContain(`/repos/o/r/commits/${'a'.repeat(40)}/check-runs?per_page=${CI_CHECKS_CAP}`);
  });

  it('any incomplete run → pending', async () => {
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'build' }, { name: 'test', status: 'in_progress', conclusion: null }]));
    const ci = await fetchCiStatus('tok', 'o', 'r', 'a'.repeat(40));
    expect(ci.state).toBe('pending');
  });

  it('any failing conclusion → failure with the failing names', async () => {
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'build' }, { name: 'test', conclusion: 'failure' }, { name: 'deploy', conclusion: 'timed_out' }]));
    const ci = await fetchCiStatus('tok', 'o', 'r', 'a'.repeat(40));
    expect(ci.state).toBe('failure');
    expect(ci.failing).toEqual(['test', 'deploy']);
  });

  it('bounded: at most CI_CHECKS_CAP check runs listed', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `check-${i}` }));
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp(many, 25));
    const ci = await fetchCiStatus('tok', 'o', 'r', 'a'.repeat(40));
    expect(ci.checks.length).toBeLessThanOrEqual(CI_CHECKS_CAP);
    expect(ci.total).toBe(25);
  });

  it('zero check runs → falls back to the legacy commit-status API', async () => {
    mockAxiosGet
      .mockResolvedValueOnce(checkRunsResp([], 0))
      .mockResolvedValueOnce({ data: { state: 'failure', total_count: 2, statuses: [{ state: 'failure', context: 'ci/legacy' }, { state: 'success', context: 'ci/other' }] } });
    const ci = await fetchCiStatus('tok', 'o', 'r', 'a'.repeat(40));
    expect(ci.state).toBe('failure');
    expect(ci.failing).toEqual(['ci/legacy']);
    expect(mockAxiosGet.mock.calls[1][0]).toContain('/status');
  });

  it('no check runs AND no statuses → none (no CI configured)', async () => {
    mockAxiosGet
      .mockResolvedValueOnce(checkRunsResp([], 0))
      .mockResolvedValueOnce({ data: { state: 'pending', total_count: 0, statuses: [] } });
    const ci = await fetchCiStatus('tok', 'o', 'r', 'a'.repeat(40));
    expect(ci.state).toBe('none');
  });
});

describe('v1#28a: check_ci tool', () => {
  const SHA = 'b'.repeat(40);

  const mkCtx = (over: Partial<ToolContext> = {}) => ({
    worktree: '/tmp/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    provider: 'github', repoUrl: 'https://github.com/o/r', branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: async () => 'tok',
    ...over,
  } as unknown as ToolContext);

  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockEmitHookEventSafe.mockClear();
    mockGetRecentChatReceipts.mockReset().mockResolvedValue([]);
  });

  it('explicit sha: renders the combined state + per-check conclusions', async () => {
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'build' }, { name: 'test' }]));
    const out = await executeCodingTool(mkCtx(), 'check_ci', { sha: SHA });
    expect(out).toContain(`CI for ${SHA.slice(0, 12)}: SUCCESS (2 checks)`);
    expect(out).toContain('- build: success');
    expect(out).toContain('- test: success');
  });

  it('defaults to the LAST sha this session pushed (durable git_push receipts)', async () => {
    mockGetRecentChatReceipts.mockResolvedValue([
      { tool: 'git_push', ok: true, ids: { sha: 'c'.repeat(40) } },
      { tool: 'git_push', ok: true, ids: { sha: SHA } },
    ] as any);
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'build' }]));
    const out = await executeCodingTool(mkCtx(), 'check_ci', {});
    expect(out).toContain(`CI for ${SHA.slice(0, 12)}`);
    expect(mockAxiosGet.mock.calls[0][0]).toContain(`/commits/${SHA}/`);
  });

  it('a FAILURE on a sha this session pushed emits the ci_failed hook event', async () => {
    mockGetRecentChatReceipts.mockResolvedValue([{ tool: 'git_push', ok: true, ids: { sha: SHA } }] as any);
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'test', conclusion: 'failure' }]));
    const out = await executeCodingTool(mkCtx(), 'check_ci', { sha: SHA });
    expect(out).toContain('FAILURE');
    expect(out).toContain('NOT done');
    await flush();
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      'sess-1', 'ci_failed', expect.stringContaining('CI FAILED'), expect.objectContaining({ sha: SHA }),
    );
  });

  it("a failure on a sha this session did NOT push emits nothing (someone else's red is not our work signal)", async () => {
    mockGetRecentChatReceipts.mockResolvedValue([] as any);
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'test', conclusion: 'failure' }]));
    await executeCodingTool(mkCtx(), 'check_ci', { sha: SHA });
    await flush();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('guards: non-GitHub project, bad sha, missing token', async () => {
    expect(await executeCodingTool(mkCtx({ provider: 'git' } as any), 'check_ci', {})).toContain('only available for GitHub projects');
    expect(await executeCodingTool(mkCtx(), 'check_ci', { sha: 'not-hex!' })).toContain('Invalid sha');
    expect(await executeCodingTool(mkCtx({ getGithubToken: async () => null } as any), 'check_ci', { sha: SHA })).toContain('No connected GitHub account/token');
  });

  it('a GitHub error degrades to an honest failure string (commit may not be pushed yet)', async () => {
    mockAxiosGet.mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));
    const out = await executeCodingTool(mkCtx(), 'check_ci', { sha: SHA });
    expect(out).toContain('check_ci failed: GitHub answered 404');
    expect(out).toContain('push first');
  });
});

describe('v1#28b: git_push post-push CI observation (ONE bounded poll)', () => {
  let remoteParent: string;
  let remote: string;
  let wt: string;

  const mkCtx = (): ToolContext => ({
    worktree: wt, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    // The path ends in github.com/o/r so parseOwnerRepo resolves {o, r} while
    // the push itself stays a real local file:// operation.
    provider: 'github', repoUrl: `file://${remote}`, branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: async () => 'tok',
    userTurnAt: new Date(),
  } as unknown as ToolContext);

  beforeEach(async () => {
    mockAxiosGet.mockReset();
    mockEmitHookEventSafe.mockClear();
    remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), 'v128-remote-'));
    remote = path.join(remoteParent, 'github.com', 'o', 'r');
    await fs.mkdir(remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'v128-wt-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' });
    g(['init', '-q', '-b', 'digby/x']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(['add', '.']);
    g(['commit', '-qm', 'c1']);
    process.env.PUSH_CI_OBSERVE_DELAY_MS = '0';
    // Gate flip 2026-09-11 (owner: full steam): the post-push poll is OPT-IN.
    // The observation contract is pinned under the opt-in; the default (no
    // env) is pinned below as "no CI line, nothing queried, no sleep".
    process.env.PUSH_CI_OBSERVE_ENABLED = '1';
  });

  afterEach(async () => {
    await fs.rm(remoteParent, { recursive: true, force: true });
    await fs.rm(wt, { recursive: true, force: true });
    delete process.env.PUSH_CI_OBSERVE_DELAY_MS;
    delete process.env.PUSH_CI_OBSERVE_ENABLED;
    delete process.env.PUSH_CI_OBSERVE_DISABLED;
  });

  it('a successful push carries the CI verdict; failure names the checks, emits ci_failed, and the receipt records ids.ci', async () => {
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'backend-tests', conclusion: 'failure' }]));
    const out = await executeCodingTool(mkCtx(), 'git_push', {});
    expect(out).toContain('Pushed digby/x');
    expect(out).toContain('CI: failure — backend-tests');
    expect(out).toContain('NOT done');
    await flush();
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      'sess-1', 'ci_failed', expect.stringContaining('backend-tests'), expect.anything(),
    );
    expect(extractReceipt('git_push', {}, out, new Date())).toMatchObject({ ok: true, ids: expect.objectContaining({ ci: 'failure' }) });
  });

  it('green CI → "CI: success" and NO ci_failed emission', async () => {
    mockAxiosGet.mockResolvedValueOnce(checkRunsResp([{ name: 'backend-tests' }]));
    const out = await executeCodingTool(mkCtx(), 'git_push', {});
    expect(out).toContain('CI: success');
    await flush();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('a status-query failure degrades honestly ("CI: unobserved … use check_ci")', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('boom'));
    const out = await executeCodingTool(mkCtx(), 'git_push', {});
    expect(out).toContain('Pushed digby/x');
    expect(out).toContain('CI: unobserved');
    expect(out).toContain('check_ci');
  });

  it('DEFAULT (PUSH_CI_OBSERVE_ENABLED unset) → the push result carries no CI line, nothing is queried, and no post-push sleep is paid', async () => {
    delete process.env.PUSH_CI_OBSERVE_ENABLED;
    process.env.PUSH_CI_OBSERVE_DELAY_MS = '600000'; // would hang the test if the poll ran
    const out = await executeCodingTool(mkCtx(), 'git_push', {});
    expect(out).toContain('Pushed digby/x');
    expect(out).not.toContain('CI:');
    expect(mockAxiosGet).not.toHaveBeenCalled();
    // The retired kill-switch alone does not re-arm the poll.
    process.env.PUSH_CI_OBSERVE_DISABLED = '1';
    const suffix = await observeCiAfterPush({ token: 'tok', owner: 'o', repo: 'r', sha: 'a'.repeat(40), sessionId: 's' });
    expect(suffix).toBe('');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('observeCiAfterPush unit: no token → silent no-op (anonymous never observes)', async () => {
    const suffix = await observeCiAfterPush({ token: null, owner: 'o', repo: 'r', sha: 'a'.repeat(40), sessionId: 's' });
    expect(suffix).toBe('');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
