/**
 * Ticket 2c01e9d2 (2026-09-27) — published-refs receipt + branch-only-landing
 * advisory. REPLAY of the mishap the ticket pins:
 *
 *   FO lane firing 29 pushed a guard fix via git_push and treated the receipt
 *   as "landed on main"; the receipt had actually published only the fo/*
 *   branch ref — no PR, no deploy wave, and main ran without the fix for ~8h
 *   until firing 30's opening check found the fix content absent from main.
 *   Repair required an explicit `git push origin HEAD:main` (0493eea5a).
 *
 * The fix (this test pins both halves):
 *   1. the push result names the VERBATIM refspec(s) published — "— published
 *      refs: refs/heads/<branch>." at the END of the result — and the receipt
 *      carries them as ids.refs (array), so no reader can mistake WHICH refs
 *      moved;
 *   2. when the durable plan's goal states a landing-on-main intent and the
 *      push publishes ONLY a branch ref (the base tip does not contain the
 *      pushed sha), the result carries an explicit NOT-a-main-landing note +
 *      a guard_strike (seam 'branch_only_landing'). The note is a NOTE — never
 *      a refusal — and every failure leg (no plan, unreadable base, goal with
 *      no landing intent) renders NOTHING, never a false advisory.
 *
 * End-to-end against a real local bare "remote" (file:// URLs pass through
 * authedPushUrl untouched). Boundary mocks mirror push-ancestry.test.ts /
 * base-push-guard.v1-26.test.ts. The plan store is the REAL context-store
 * storeGet mock — pushGoalText reads it through plan.service's getPlan, so a
 * goal is injected by seeding storeGet to return a CodingPlan.
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

// The plan store: pushGoalText → getPlan → storeGet. Seeded per-test.
const mockStoreGet: jest.Mock = jest.fn(async () => null);
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: jest.fn(async () => {}),
}));

import { pushSessionBranch, ToolContext, goalLandingOnBaseRe, pushedShaLandsOnBase } from './tools';
import { extractReceipt } from './run-receipts';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const g = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('2c01e9d2: published-refs receipt + branch-only-landing advisory', () => {
  let remote: string;
  let wt: string;
  let headSha: string;

  const mkCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    worktree: wt, sessionId: 'sess-2c01', userId: 'u1', runId: 'run-2c01', permissionMode: 'auto',
    provider: 'github', repoUrl: `file://${remote}`, branch: 'fo/guard-fix', baseBranch: 'main',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: async () => 'tok',
    ...over,
  } as unknown as ToolContext);

  const seedPlanGoal = (goal: string) => {
    mockStoreGet.mockImplementation(async (ns: string[], key: string) => {
      if (ns.join('/').includes('coding-plan') && key === 'plan') {
        return { goal, acceptanceCriteria: [], steps: [], version: 1, updatedAt: new Date().toISOString() };
      }
      return null;
    });
  };

  beforeEach(async () => {
    mockStoreGet.mockReset().mockResolvedValue(null);
    mockRecordLoopMetric.mockClear();
    remote = path.join(await fs.mkdtemp(path.join(os.tmpdir(), '2c01-remote-')), 'r.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    wt = await fs.mkdtemp(path.join(os.tmpdir(), '2c01-wt-'));
    g(wt, ['init', '-q', '-b', 'main']);
    g(wt, ['config', 'user.email', 't@example.com']);
    g(wt, ['config', 'user.name', 't']);
    // main carries the base commit; the fix commit lands on fo/guard-fix only.
    await fs.writeFile(path.join(wt, 'base.txt'), 'v1\n');
    g(wt, ['add', '.']);
    g(wt, ['commit', '-qm', 'base']);
    g(wt, ['push', '-q', `file://${remote}`, 'HEAD:refs/heads/main']);
    g(wt, ['checkout', '-q', '-B', 'fo/guard-fix']);
    await fs.writeFile(path.join(wt, 'fix.txt'), 'guard\n');
    g(wt, ['add', '.']);
    g(wt, ['commit', '-qm', 'fix']);
    headSha = g(wt, ['rev-parse', 'HEAD']).trim();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(remote), { recursive: true, force: true });
    await fs.rm(wt, { recursive: true, force: true });
  });

  it('replay: branch publish under a landing-on-main goal → explicit NOT-a-main-landing note + refs list + ONE guard_strike', async () => {
    seedPlanGoal('Land the guard fix on main and verify the deploy');
    const out = await pushSessionBranch(mkCtx());
    // The refs list is unambiguous — verbatim, at the END of the result.
    expect(out).toContain('Pushed fo/guard-fix');
    expect(out).toContain(`— published refs: refs/heads/fo/guard-fix.`);
    // The advisory: exactly the ticket's silent-non-landing shape.
    expect(out).toContain('branch publish ONLY');
    expect(out).toContain('"main" does NOT contain this commit');
    expect(out).toContain('nothing landed on "main"');
    // The metric: ONE observed strike, the new seam.
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike',
      meta: expect.objectContaining({ seam: 'branch_only_landing', state: 'observed', head: 'fo/guard-fix', base: 'main' }),
    }));
    // The receipt still parses (branch/sha/ancestry) AND carries ids.refs.
    const receipt = extractReceipt('git_push', {}, out, new Date());
    expect(receipt).toMatchObject({
      ok: true,
      ids: {
        branch: 'fo/guard-fix',
        sha: headSha,
        verified: 'ancestry',
        refs: ['refs/heads/fo/guard-fix'],
      },
    });
    // Belt-and-braces on the fixture: main's remote tip does NOT contain the fix.
    const mainTip = g(remote, ['rev-parse', 'refs/heads/main']).trim();
    expect(mainTip).not.toBe(headSha);
  });

  it('no landing intent in the goal (e.g. "publish the branch for review") → NO advisory, but the refs list still rides', async () => {
    seedPlanGoal('Publish the branch for human review and open a PR');
    const out = await pushSessionBranch(mkCtx());
    expect(out).toContain('— published refs: refs/heads/fo/guard-fix.');
    expect(out).not.toContain('branch publish ONLY');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('no plan at all (fresh session) → NO advisory; the refs list alone makes the receipt unambiguous', async () => {
    const out = await pushSessionBranch(mkCtx());
    expect(out).toContain('— published refs: refs/heads/fo/guard-fix.');
    expect(out).not.toContain('branch publish ONLY');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('landing intent + the base tip DOES contain the push (fix already on main) → NO advisory', async () => {
    seedPlanGoal('Land the guard fix on main');
    // Fast-forward main to the fix commit, then push a NEW branch from it.
    g(wt, ['checkout', '-q', '-B', 'main']);
    g(wt, ['merge', '--ff-only', 'fo/guard-fix']);
    g(wt, ['push', '-q', `file://${remote}`, 'HEAD:refs/heads/main']);
    g(wt, ['checkout', '-q', '-B', 'fo/guard-fix2', 'fo/guard-fix']);
    const out = await pushSessionBranch(mkCtx({ branch: 'fo/guard-fix2' } as Partial<ToolContext>));
    expect(out).toContain('— published refs: refs/heads/fo/guard-fix2.');
    expect(out).not.toContain('branch publish ONLY');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a BASE-branch push (the explicit main landing) never renders the advisory', async () => {
    seedPlanGoal('Land the guard fix on main');
    g(wt, ['checkout', '-q', '-B', 'main']);
    const out = await pushSessionBranch(mkCtx({ branch: 'main' } as Partial<ToolContext>));
    // Base-branch pushes get the base-push note, not the landing advisory.
    expect(out).toContain('Pushed main');
    expect(out).not.toContain('branch publish ONLY');
    expect(out).toContain('base branch "main" pushed');
  });

  it('goalLandingOnBaseRe: matches landing intent, ignores mere mentions of the base branch', () => {
    const re = goalLandingOnBaseRe('main');
    expect(re.test('Land the guard fix on main')).toBe(true);
    expect(re.test('land it to main')).toBe(true);
    expect(re.test('Merge PR #12 into main')).toBe(true);
    expect(re.test('push the fix to main')).toBe(true);
    expect(re.test('ship on main')).toBe(true);
    expect(re.test('deploy to main')).toBe(true);
    // No landing verb → no advisory (the false-positive guard).
    expect(re.test('fix the guard in main\'s files')).toBe(false);
    expect(re.test('main is the base branch')).toBe(false);
    // Custom base branches are honored.
    expect(goalLandingOnBaseRe('develop').test('land the fix on develop')).toBe(true);
    expect(goalLandingOnBaseRe('develop').test('land the fix on main')).toBe(true);
    // "main" fallback always matches even when base is custom.
    expect(goalLandingOnBaseRe('release/v2').test('push it to main')).toBe(true);
  });

  it('pushedShaLandsOnBase: tri-state — true/false/null via a real remote', async () => {
    const ctx = mkCtx();
    // True: main's tip IS the 'base' commit (= fo/guard-fix~1).
    const baseSha = g(wt, ['rev-parse', 'fo/guard-fix~1']).trim();
    expect(await pushedShaLandsOnBase(ctx, `file://${remote}`, 'main', baseSha)).toBe(true);
    // False: the fix commit is NOT on main.
    expect(await pushedShaLandsOnBase(ctx, `file://${remote}`, 'main', headSha)).toBe(false);
    // Null: the base branch does not exist on the remote.
    expect(await pushedShaLandsOnBase(ctx, `file://${remote}`, 'no-such-branch', headSha)).toBe(null);
  });
});
