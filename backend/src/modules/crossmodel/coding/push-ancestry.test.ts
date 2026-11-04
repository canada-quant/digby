/**
 * I2b (repo-integrity remediation, 2026-09-09) — ancestry push verdicts.
 *
 * Real incident: push "verification" compared ls-remote TIP STRINGS and
 * declared success while a repo's main ran as two divergent lines for ~11
 * days. pushSessionBranch now re-fetches the remote branch after pushing and
 * verifies `git merge-base --is-ancestor <local-sha> FETCH_HEAD` — the verdict
 * rides the result string ("(verified: ancestry)" / "(verified: failed — …)")
 * and lands in the git_push receipt as ids.verified.
 *
 * End-to-end against a real local bare "remote" (file:// URLs ignore the
 * credential injection, so authedPushUrl passes them through untouched).
 * Boundary mocks mirror tools.test.ts.
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

import { pushSessionBranch, ToolContext } from './tools';
import { extractReceipt } from './run-receipts';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const g = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('I2b: git_push ancestry verdict', () => {
  let remote: string;
  let wt: string;
  let headSha: string;

  const mkCtx = (): ToolContext => ({
    worktree: wt, sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    provider: 'github', repoUrl: `file://${remote}`, branch: 'digby/x', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: async () => 'tok',
  } as unknown as ToolContext);

  beforeEach(async () => {
    remote = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'i2b-remote-')), 'r.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'i2b-wt-'));
    g(wt, ['init', '-q', '-b', 'digby/x']);
    g(wt, ['config', 'user.email', 't@example.com']);
    g(wt, ['config', 'user.name', 't']);
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(wt, ['add', '.']);
    g(wt, ['commit', '-qm', 'c1']);
    headSha = g(wt, ['rev-parse', 'HEAD']).trim();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(remote), { recursive: true, force: true });
    await fs.rm(wt, { recursive: true, force: true });
  });

  it('a real push earns "(verified: ancestry)" — the local sha is an ancestor of the RE-FETCHED remote tip', async () => {
    const out = await pushSessionBranch(mkCtx());
    expect(out).toContain('Pushed digby/x');
    expect(out).toContain(`sha ${headSha}`);
    expect(out).toContain('(verified: ancestry)');
    // The remote genuinely has it (belt-and-braces for the fixture itself).
    expect(g(remote, ['rev-parse', 'refs/heads/digby/x']).trim()).toBe(headSha);
  });

  it('the receipt carries ids.verified — "ancestry" and "failed" verdict strings both extract; legacy strings omit it', () => {
    const ok = extractReceipt('git_push', {},
      `Pushed digby/x to GitHub (https://github.com/o/r) — sha ${'a'.repeat(40)} (verified: ancestry).`, new Date());
    expect(ok).toMatchObject({ ok: true, ids: { branch: 'digby/x', verified: 'ancestry' } });

    const failed = extractReceipt('git_push', {},
      `Pushed digby/x to GitHub (https://github.com/o/r) — sha ${'b'.repeat(40)} (verified: failed — the re-fetched remote tip does not confirm this commit; treat the push as UNCONFIRMED and re-check with git_push / git log before claiming it landed).`, new Date());
    expect(failed).toMatchObject({ ok: true, ids: { branch: 'digby/x', verified: 'failed' } });

    const legacy = extractReceipt('git_push', {},
      `Pushed digby/x to GitHub (https://github.com/o/r) — sha ${'c'.repeat(40)}.`, new Date());
    expect(legacy!.ids.verified).toBeUndefined();

    // A failed push is still never a receipt-ok push (unchanged).
    expect(extractReceipt('git_push', {}, 'git push failed: remote hung up', new Date())).toMatchObject({ ok: false });
  });

  it('audit 2026-10-08 W2-2: a push moves refs/remotes/origin/<branch> to the pushed sha and remembers it for the session', async () => {
    const store: any = jest.requireMock('../memory/context-store');
    (store.storePut as jest.Mock).mockClear();
    await pushSessionBranch(mkCtx());
    expect(g(wt, ['rev-parse', 'refs/remotes/origin/digby/x']).trim()).toBe(headSha);
    expect(store.storePut).toHaveBeenCalledWith(['sess-1', 'git-state'], 'pushed', expect.objectContaining({ shas: [headSha] }));
  });

  it('audit 2026-10-08 W2-2: UNPUSHED_PUSHED_SHAS_DISABLED=1 — no tracking-ref move, nothing remembered', async () => {
    const store: any = jest.requireMock('../memory/context-store');
    (store.storePut as jest.Mock).mockClear();
    process.env.UNPUSHED_PUSHED_SHAS_DISABLED = '1';
    try {
      await pushSessionBranch(mkCtx());
      expect(() => g(wt, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/digby/x'])).toThrow();
      expect(store.storePut).not.toHaveBeenCalledWith(['sess-1', 'git-state'], 'pushed', expect.anything());
    } finally { delete process.env.UNPUSHED_PUSHED_SHAS_DISABLED; }
  });
});
