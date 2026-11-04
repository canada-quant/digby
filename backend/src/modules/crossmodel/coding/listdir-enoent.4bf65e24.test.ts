/**
 * Replay for ticket 4bf65e24 — "3× tool-failure streak: list_dir ENOENT on
 * 'Post-CPT Coordination — SFT/GRPO/GSPO + …' — framework or model?"
 *
 * THE INCIDENT (auto-filed at breaker trip, 2026-09-19T00:19Z): session
 * e083ff2e-de98-412a-85df-86923572db1d (CanLaw project, repo canada-quant/canlaw),
 * run 2382a0f8-9227-4c81-9117-71b9c97fc855 — the lane called list_dir on 'docs'
 * and the tool failed twice (streak 3× at trip):
 *   "Tool list_dir failed: ENOENT: no such file or directory, scandir
 *    '/app/coding-workspaces/worktrees/e083ff2e-de98-412a-85df-86923572db1d/docs'"
 *
 * THE ADJUDICATION — MODEL behavior, evidence (all gathered fresh
 * 2026-09-19T01:0xZ):
 *  1. The incident worktree on the worker host has NO docs/ directory. Fresh
 *     `ls -A` of /app/coding-workspaces/worktrees/e083ff2e-…: .digby .digbyignore
 *     .dockerignore .env.example .git .gitignore .gitkeep AGENTS.md Dockerfile
 *     LICENSE README.md RELEASE.md deploy package.json public scripts server
 *     tests tmp — and `find -maxdepth 2 -type d -name docs` → none. The lane
 *     GUESSED the path.
 *  2. The tool answered HONESTLY: tools.ts case 'list_dir' runs
 *     `fs.readdir(resolveInside(worktree, path))` — a missing dir throws ENOENT
 *     and the executeCodingTool catch-all (tools.ts:2331) returns the exact
 *     incident string. Deterministic and CORRECT: a wrong path must fail, and
 *     the failure names the resolved absolute path inside the jail.
 *  3. No fuzzy routing exists to blame for the lane's reasoning naming "grep"
 *     while list_dir fired: dispatch is `switch (name)` on the exact tool name
 *     the model emitted (tools.ts:1365).
 *  4. No framework regression: `git log` on tools.ts / worktree-files.ts shows
 *     no recent change to list_dir's semantics (last touches: #858 cap-cadence,
 *     #857 delta gate, #853 verdict-wait, #838 PR-head guard).
 *
 * These tests pin the honest-ENOENT contract through the REAL executeCodingTool
 * (boundary mocks mirror tools.test.ts), so a future framework change that
 * masks, misroutes, or misattributes this failure is caught.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts (the
// tools.ts import graph reaches config/env, which process.exit(1)s without env).
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
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard',
  },
}));
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: jest.fn(async (): Promise<any> => ({ policy: 'on', source: 'setting' })),
  checkOrAskOwner: jest.fn(async (): Promise<any> => 'pending'),
  evaluateMergeGates: jest.fn(async (): Promise<any> => ({ ok: true, alreadyMerged: false, headSha: 'x', evidenceHash: 'e', evidenceNotes: [] })),
  readAttempt: jest.fn(async (): Promise<any> => ({})),
  writeAttempt: jest.fn(async () => {}),
  clearAttempt: jest.fn(async () => {}),
  recordMergeLearning: jest.fn(async () => {}),
  deleteMergedHeadBranch: jest.fn(async (): Promise<any> => ({ outcome: 'kept', branch: null })),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => ({ put: jest.fn(), get: jest.fn(), delete: jest.fn() }),
}));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, flagOwnerQuestion: jest.fn(async (): Promise<any> => ({ kind: 'created' })) }));
jest.mock('./ci-status', () => ({
  __esModule: true,
  observeCiAfterPush: jest.fn(async () => ''),
  fetchCiStatus: jest.fn(async () => ({ state: 'none', checks: [], failing: [], total: 0 })),
  renderCiStatus: jest.fn(() => ''),
  emitCiFailed: jest.fn(),
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  createSchedule: jest.fn(async () => ({ ok: true, schedule: { id: 'sch1', kind: 'recurring', intervalSec: 3600, nextRunAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-09-13T00:00:00.000Z' } })),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async (): Promise<any> => null),
  findPriorRunPrReceipt: jest.fn(async (): Promise<any> => null),
  prHeadMatchesReceipt: jest.fn(async (): Promise<boolean> => false),
}));

import { executeCodingTool, resolveInside, ToolContext } from './tools';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let WT = '';
const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-4bf65e24', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

beforeAll(async () => {
  // A worktree shaped like the incident's (canlaw.git top level): NO docs/.
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-4bf65e24-'));
  await fs.writeFile(path.join(WT, 'README.md'), '# canlaw\n');
  await fs.writeFile(path.join(WT, 'AGENTS.md'), '# agent guide\n');
  await fs.writeFile(path.join(WT, 'package.json'), '{}\n');
  await fs.mkdir(path.join(WT, 'server'));
  await fs.mkdir(path.join(WT, 'tests'));
  await fs.mkdir(path.join(WT, 'deploy'));
});
afterAll(async () => {
  await fs.rm(WT, { recursive: true, force: true });
});

describe('ticket 4bf65e24 — honest-ENOENT contract (the streak was model behavior)', () => {
  it('REPLAY: list_dir on the missing docs/ dir fails with the EXACT incident surface — catch-all prefix + ENOENT + the resolved jail path', async () => {
    const out = await executeCodingTool(mkCtx(), 'list_dir', { path: 'docs' });
    // The exact incident string shape: "Tool list_dir failed: ENOENT: no such
    // file or directory, scandir '<worktree>/docs'" (tools.ts:2331 catch-all
    // wrapping the honest fs.readdir error).
    expect(out).toBe(`Tool list_dir failed: ENOENT: no such file or directory, scandir '${WT}/docs'`);
  });

  it('the failure names the JAIL-resolved absolute path (resolveInside), never a wrong root or an escape', async () => {
    const out = await executeCodingTool(mkCtx(), 'list_dir', { path: 'docs' });
    expect(out).toContain(resolveInside(WT, 'docs'));
    expect(resolveInside(WT, 'docs')).toBe(`${WT}/docs`);
  });

  it('list_dir on the existing worktree root lists the real entries — the tool is NOT broken for present directories', async () => {
    const out = await executeCodingTool(mkCtx(), 'list_dir', { path: '.' });
    expect(out).not.toMatch(/^Tool list_dir failed:/);
    for (const entry of ['README.md', 'AGENTS.md', 'package.json', 'server/', 'tests/', 'deploy/']) expect(out).toContain(entry);
    expect(out).not.toContain('docs');
  });

  it('contrast class: a FILE where a directory is expected also fails honestly (ENOTDIR), same catch-all surface', async () => {
    const out = await executeCodingTool(mkCtx(), 'list_dir', { path: 'README.md' });
    expect(out).toMatch(/^Tool list_dir failed: ENOTDIR/);
    expect(out).toContain(`${WT}/README.md`);
  });
});
