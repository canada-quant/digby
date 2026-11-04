/**
 * v1#26 / spark G15 (P5 publish-path remediation) — base-branch push guard.
 *
 * pushSessionBranch is the one seam every publish flows through. Pushing the
 * project's BASE branch (ctx.baseBranch, plus the conventional main/master)
 * used to be REFUSED on machine runs (allowBase never overrode) and on
 * user-present runs without allowBase:true.
 *
 * Gate flip 2026-09-11 (owner: full steam) — OBSERVE-ONLY by default:
 *   - the detection stays: a GUARD_STRIKE loop metric (seam 'base_push',
 *     state 'observed', head, userPresent) is recorded and the push result
 *     carries a one-line note — but the push EXECUTES (the standing directive
 *     is "merge to main and push autonomously"; the deploy workflow's CI test
 *     gate is the real safety net);
 *   - a user-present run passing allowBase:true (the human buttons) is the
 *     explicit click — no note, no metric;
 *   - session-branch pushes are untouched;
 *   - opt-in BASE_PUSH_GUARD_ENFORCE=1 restores the refusal envelope (the old
 *     BASE_PUSH_GUARD_DISABLED kill-switch is retired).
 *
 * End-to-end against a real local bare "remote" (file:// URLs pass through
 * authedPushUrl untouched). Boundary mocks mirror push-ancestry.test.ts.
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

import { pushSessionBranch, protectedBaseBranches, ToolContext } from './tools';
import { extractReceipt } from './run-receipts';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const g = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('v1#26: base-branch push guard (observe-only since the 2026-09-11 gate flip)', () => {
  let remote: string;
  let wt: string;

  const mkCtx = (over: Partial<ToolContext> = {}): { ctx: ToolContext; getGithubToken: jest.Mock } => {
    const getGithubToken = jest.fn(async () => 'tok');
    const ctx = {
      worktree: wt, sessionId: 'sess-1', userId: 'u1', runId: 'run-1', permissionMode: 'auto',
      provider: 'github', repoUrl: `file://${remote}`, branch: 'digby/task', baseBranch: 'main',
      emit: jest.fn(), alwaysAllow: new Set<string>(),
      requestApproval: async () => 'allow' as const,
      execShell: async () => ({ stdout: '', stderr: '' }),
      getGithubToken,
      ...over,
    } as unknown as ToolContext;
    return { ctx, getGithubToken };
  };

  const checkout = (branch: string) => g(wt, ['checkout', '-q', '-B', branch]);
  const remoteHas = (branch: string) => g(remote, ['rev-parse', `refs/heads/${branch}`]).trim();

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['BASE_PUSH_GUARD_ENFORCE', 'BASE_PUSH_GUARD_DISABLED'] as const;

  beforeEach(async () => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    mockRecordLoopMetric.mockClear();
    remote = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'v126-remote-')), 'r.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'v126-wt-'));
    g(wt, ['init', '-q', '-b', 'main']);
    g(wt, ['config', 'user.email', 't@example.com']);
    g(wt, ['config', 'user.name', 't']);
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(wt, ['add', '.']);
    g(wt, ['commit', '-qm', 'c1']);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(remote), { recursive: true, force: true });
    await fs.rm(wt, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  const observed = (head: string, userPresent: boolean) => expect.objectContaining({
    kind: 'guard_strike', sessionId: 'sess-1', runId: 'run-1',
    meta: { seam: 'base_push', state: 'observed', head, userPresent },
  });

  it('MACHINE run pushing the base branch → the push EXECUTES, with a machine-run note and ONE observed metric', async () => {
    checkout('main');
    const { ctx, getGithubToken } = mkCtx({ userTurnAt: undefined });
    const out = await pushSessionBranch(ctx);
    expect(out).toContain('Pushed main');
    expect(out).toContain('base branch "main" pushed from a machine run');
    expect(out).not.toContain('PUSH REFUSED');
    expect(getGithubToken).toHaveBeenCalledTimes(1);
    expect(remoteHas('main')).toBe(g(wt, ['rev-parse', 'HEAD']).trim());
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observed('main', false));
  });

  it('the appended note does not break the git_push receipt (branch/sha/ancestry verdict still parse)', async () => {
    checkout('main');
    const { ctx } = mkCtx({ userTurnAt: undefined });
    const out = await pushSessionBranch(ctx);
    const receipt = extractReceipt('git_push', {}, out, new Date());
    expect(receipt).toMatchObject({ ok: true, ids: { branch: 'main', sha: g(wt, ['rev-parse', 'HEAD']).trim(), verified: 'ancestry' } });
  });

  it('MACHINE run + allowBase:true → same observe-only path (the flag only ever mattered for humans)', async () => {
    checkout('main');
    const { ctx } = mkCtx({ userTurnAt: undefined });
    const out = await pushSessionBranch(ctx, { allowBase: true });
    expect(out).toContain('Pushed main');
    expect(out).toContain('from a machine run');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observed('main', false));
  });

  it('USER-PRESENT run without allowBase → pushes, with a user-present note + observed metric', async () => {
    checkout('main');
    const { ctx } = mkCtx({ userTurnAt: new Date() });
    const out = await pushSessionBranch(ctx);
    expect(out).toContain('Pushed main');
    expect(out).toContain('from a user-present run');
    expect(remoteHas('main')).toBe(g(wt, ['rev-parse', 'HEAD']).trim());
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observed('main', true));
  });

  it('USER-PRESENT run + allowBase:true (the human buttons) → plain push: no note, no metric', async () => {
    checkout('main');
    const { ctx } = mkCtx({ userTurnAt: new Date() });
    const out = await pushSessionBranch(ctx, { allowBase: true });
    expect(out).toContain('Pushed main');
    expect(out).not.toContain('base-push guard');
    expect(remoteHas('main')).toBe(g(wt, ['rev-parse', 'HEAD']).trim());
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('the SESSION branch pushes untouched from a machine run (the normal lane path): no note, no metric', async () => {
    checkout('digby/task');
    const { ctx } = mkCtx({ userTurnAt: undefined });
    const out = await pushSessionBranch(ctx);
    expect(out).toContain('Pushed digby/task');
    expect(out).not.toContain('base-push guard');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('main/master are still DETECTED as base even when they are NOT the configured base (note + metric, push proceeds)', async () => {
    checkout('master');
    const { ctx } = mkCtx({ userTurnAt: undefined, baseBranch: 'develop' } as any);
    const out = await pushSessionBranch(ctx);
    expect(out).toContain('Pushed master');
    expect(out).toContain('base branch "master"');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(observed('master', false));
  });

  describe('opt-in BASE_PUSH_GUARD_ENFORCE=1 restores the refusal', () => {
    beforeEach(() => { process.env.BASE_PUSH_GUARD_ENFORCE = '1'; });

    it('MACHINE run pushing the base branch → structured refusal, nothing pushed, no token fetched', async () => {
      checkout('main');
      const { ctx, getGithubToken } = mkCtx({ userTurnAt: undefined });
      const out = await pushSessionBranch(ctx);
      const env = JSON.parse(out);
      expect(env).toMatchObject({ ok: false, reason: 'base_push_guard', sessionBranch: 'digby/task' });
      expect(env.instructions).toContain('unattended machine-triggered run');
      expect(env.instructions).toContain('git_push');
      expect(env.instructions).toContain('open_pull_request');
      expect(getGithubToken).not.toHaveBeenCalled();
      expect(() => remoteHas('main')).toThrow();
      expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    });

    it('MACHINE run: allowBase:true does NOT override under enforcement', async () => {
      checkout('main');
      const { ctx } = mkCtx({ userTurnAt: undefined });
      const out = await pushSessionBranch(ctx, { allowBase: true });
      expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'base_push_guard' });
      expect(() => remoteHas('main')).toThrow();
    });

    it('USER-PRESENT run without allowBase → refusal that names the allowBase:true override', async () => {
      checkout('main');
      const { ctx } = mkCtx({ userTurnAt: new Date() });
      const out = await pushSessionBranch(ctx);
      const env = JSON.parse(out);
      expect(env).toMatchObject({ ok: false, reason: 'base_push_guard' });
      expect(env.instructions).toContain('allowBase:true');
      expect(() => remoteHas('main')).toThrow();
    });

    it('USER-PRESENT run + allowBase:true → the base push executes', async () => {
      checkout('main');
      const { ctx } = mkCtx({ userTurnAt: new Date() });
      const out = await pushSessionBranch(ctx, { allowBase: true });
      expect(out).toContain('Pushed main');
      expect(remoteHas('main')).toBe(g(wt, ['rev-parse', 'HEAD']).trim());
    });

    it('the retired BASE_PUSH_GUARD_DISABLED kill-switch has no effect any more (ENFORCE wins)', async () => {
      process.env.BASE_PUSH_GUARD_DISABLED = '1';
      checkout('main');
      const { ctx } = mkCtx({ userTurnAt: undefined });
      const out = await pushSessionBranch(ctx);
      expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'base_push_guard' });
    });
  });

  it('protectedBaseBranches: project base + conventional defaults', () => {
    expect([...protectedBaseBranches('develop')].sort()).toEqual(['develop', 'main', 'master']);
    expect([...protectedBaseBranches()].sort()).toEqual(['main', 'master']);
  });
});
