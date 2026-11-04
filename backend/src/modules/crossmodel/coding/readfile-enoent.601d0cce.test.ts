/**
 * Replay pin for ticket 601d0cce — "3× tool-failure streak: read_file on
 * 'Digby's Nightly Self-Improvement Enginee' — framework or model?"
 *
 * THE INCIDENT (auto-filed at breaker trip, 2026-09-28T~20:4xZ): session
 * b92ef13f-c3f8-487e-8267-767e56543150 (crossmodel), run
 * 016f6672-9c03-4f3b-b9f4-770b0c1f4fcc — the lane called read_file on
 * scripts/framework-audit/probe-7acaa7ba-shared-workspace.js and it failed
 * THREE consecutive times (identical refusals, then the breaker tripped):
 *   "Tool read_file failed: ENOENT: no such file or directory, open
 *    '/app/coding-workspaces/worktrees/b92ef13f-…/scripts/framework-audit/
 *     probe-7acaa7ba-shared-workspace.js'"
 * The lane's reasoning named grep (the intent-mismatch signature).
 *
 * THE ADJUDICATION — MODEL behavior, evidence (all gathered fresh
 * 2026-09-28, re-verified at pin time):
 *  1. At the incident time the worktree was on branch c0fb822a-pretty-docx
 *     (base 2ac6cd53f). `git ls-tree -r 2ac6cd53f -- scripts/framework-audit/`
 *     → 0 entries: the probe file NEVER EXISTED on that branch's ancestry.
 *     The file exists on origin/main only (blob a23a787, landed via e18c15c4 /
 *     PR #1123). A read_file call from a worktree whose branch predates the
 *     file MUST ENOENT — the tool answered honestly about its OWN worktree.
 *  2. The tool contract is exact: tools.ts case 'read_file' runs
 *     `fs.readFile(resolveRealInside(worktree, path), 'utf8')` — a missing
 *     file throws ENOENT and the executeCodingTool catch-all (tools.ts:2331)
 *     returns the exact incident string, naming the jail-resolved absolute
 *     path. Deterministic and CORRECT: a missing file must fail.
 *  3. No fuzzy routing exists to blame for the reasoning-named-grep while
 *     read_file fired: dispatch is `switch (name)` on the exact tool name the
 *     model emitted (tools.ts:1370).
 *  4. The model called read_file on a path it had never verified with glob or
 *     list_dir first — the precise discipline the AGENTS.md prompt already
 *     teaches (verify-path-exists-before-read). Same honest-ENOENT family as
 *     4bf65e24 (list_dir) and 8e900af9 (edit_file): wrong-path calls must
 *     fail, and the breaker correctly escalated the 3× streak for
 *     investigation (that filing is the system working as designed).
 *
 * This test drives the REAL executeCodingTool (boundary mocks mirror
 * tools.test.ts / listdir-enoent.4bf65e24.test.ts) so a future framework
 * change that masks, misroutes, or misattributes this failure is caught.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// learnings-index.service → unified-memory.service → database → env chain:
// env parse exits at import without these (same discipline as
// agent-derail-break.00667344.test.ts).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret',
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { quit: jest.fn(), connect: jest.fn() },
  getRedis: jest.fn(() => ({ quit: jest.fn(), connect: jest.fn() })),
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
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', right: 2, status: 'exited', exitCode: '0' })),
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
import { looksLikeToolFailure } from './learnings-index.service';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let WT = '';
const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-601d0cce', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

// The incident path (as the lane typed it) and its jail resolution.
const INCIDENT_REL = 'scripts/framework-audit/probe-7acaa7ba-shared-workspace.js';
const incidentAbs = () => resolveInside(WT, INCIDENT_REL);

beforeAll(async () => {
  // A worktree shaped like the incident's: the probe file ABSENT (the branch
  // ancestry never contained it) but the parent directory present, plus a
  // sibling file that DOES exist — the "narrow miss" shape that tempted the
  // model into reading a path it had never verified.
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-601d0cce-'));
  await fs.mkdir(path.join(WT, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(WT, 'scripts', 'framework-audit'), { recursive: true });
  await fs.writeFile(path.join(WT, 'scripts', 'framework-audit', 'OTHER-probe.js'), '// exists\n');
});

afterAll(async () => {
  await fs.rm(WT, { recursive: true, force: true });
});

describe('ticket 601d0cce — honest-ENOENT contract for read_file (the streak was model behavior)', () => {
  it('REPLAY: read_file on the absent probe file fails with the EXACT incident surface — catch-all prefix + ENOENT + the jail-resolved absolute path', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: INCIDENT_REL });
    // The exact incident string shape: "Tool read_file failed: ENOENT: no
    // such file or directory, open '<worktree>/scripts/framework-audit/
    // probe-7acaa7ba-shared-workspace.js'" (tools.ts:2331 catch-all
    // wrapping the honest fs.readFile error).
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${incidentAbs()}'`);
  });

  it('the failure names the JAIL-resolved absolute path (resolveRealInside), never a wrong root or an escape', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: INCIDENT_REL });
    expect(out).toContain(incidentAbs());
    expect(incidentAbs()).toBe(`${WT}/${INCIDENT_REL}`);
  });

  it('the SIBLING file in the same directory reads fine — the tool is NOT broken for present files (the narrow-miss contrast)', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: 'scripts/framework-audit/OTHER-probe.js' });
    expect(out).toBe('// exists\n');
  });

  it('the incident text is failure-shaped for the breaker (looksLikeToolFailure) — the 3× streak correctly ESCALATED, not misattributed', () => {
    const text = `Tool read_file failed: ENOENT: no such file or directory, open '${incidentAbs()}'`;
    expect(looksLikeToolFailure(text)).toBe(true);
  });

  it('breakthrough exists: creating the file (or merging the branch that carries it) makes the same read succeed — the tool tracks the REAL tree, not a cache', async () => {
    await fs.writeFile(incidentAbs(), '// landed via e18c15c4 / PR #1123\n');
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: INCIDENT_REL });
    expect(out).toBe('// landed via e18c15c4 / PR #1123\n');
  });
});
