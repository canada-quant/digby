/**
 * Replay pin — ticket 14739e76 (mishap, breaker trip 2026-09-20 05:25:56Z,
 * session 23761603-fd80-4c5a-9e64-040ffadf927e, run
 * 788c60d1-bf08-4e96-97f3-1c5c8fec7300; FIRST streak this run; the lane's
 * reasoning named grep).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak: read_file'
 * mishap with two failure texts (newest first):
 *   1. `Tool read_file failed: ENOENT: no such file or directory, open
 *      '/app/coding-workspaces/worktrees/23761603-fd80-4c5a-9e64-040ffadf927e/
 *      backend/src/modules/crossmodel/resources/resource-tools.ts'`
 *   2. `Tool read_file failed: ENOENT: no such file or directory, open
 *      '/app/coding-workspaces/worktrees/23761603-fd80-4c5a-9e64-040ffadf927e/
 *      backend/src/modules/crossmodel/feedback/platform-tools.ts'`
 *
 * WHAT ACTUALLY HAPPENED (adjudication 2026-09-20, all evidence fresh):
 *  1. HALLUCINATED-PATH class, NOT stale-worktree — the explicit discriminator
 *     vs the 8e900af9 class pinned in agent-derail-break.8e900af9.test.ts: a
 *     stale-worktree case requires the file to EXIST ON MAIN but not on the
 *     lane's behind-branch. Here BOTH ticket paths exist NOWHERE:
 *     `git log --all --oneline -- <either path>` is empty (no ref ever
 *     carried them); `git ls-tree origin/main --name-only
 *     backend/src/modules/crossmodel/resources/` is empty — that DIRECTORY
 *     does not exist on main (nor in this worktree);
 *     backend/src/modules/crossmodel/feedback/ exists but has no
 *     platform-tools.ts. The REAL files are
 *     backend/src/modules/crossmodel/platform/platform-tools.ts and
 *     backend/src/modules/crossmodel/platform/resource-tools.ts (both present
 *     in this worktree — re-verified by test (a) below). A lane cannot be
 *     "stale" on a path no ref contains.
 *  2. ROOT CAUSE: the failing lane's ORCHESTRATOR authored a delegate-coder
 *     brief naming the two wrong paths; the coder worker's read_file calls
 *     ENOENT'd truthfully; the derail breaker tripped as designed. The lane's
 *     own transcript (chat 23761603, msg 4ea7a4cd) admits: "my delegate brief
 *     authored the two wrong paths, the worker's reads correctly ENOENT'd,
 *     and the breaker tripped as designed. No framework defect, no stale
 *     worktree."
 *  3. HONEST-ERRNO CONTRACT: read_file (tools.ts `case 'read_file'`,
 *     ~line 1389) resolves through the jail — resolveRealInside, which falls
 *     back to the lexical jail path for a not-yet-created file ("not created
 *     yet — lexical check stands") — and a missing file throws ENOENT from
 *     fs.readFile; the executeCodingTool catch-all (tools.ts:2391) renders
 *     `Tool ${name} failed: ${err.message}` VERBATIM — no softening, no
 *     in-band guidance. Same pinned class as list_dir (ticket 4bf65e24,
 *     listdir-enoent.4bf65e24.test.ts) and edit_file (ticket 8e900af9,
 *     agent-derail-break.8e900af9.test.ts) — one tool over. Softening these
 *     errnos would contradict the pinned 4bf65e24 contract — do NOT do it.
 *  4. "Lane's reasoning named grep" — the intent-mismatch signature in the
 *     breaker math (agent.ts:3171-3184): consecutive same-tool failures +1
 *     each (3172), preflight-ungrounded +1 (3182), intent-mismatch +1 (3183),
 *     trip at >= 3 (3184). Two read_file failures + one intent-mismatch = 3 →
 *     the FIRST trip, which is why the ticket carries exactly two failure
 *     texts for a "3×" streak. Auto-file seam: reflection.ts
 *     fileStreakInvestigation (agent.ts:3278).
 *  5. NO FRAMEWORK REGRESSION: `git log --oneline -8 --
 *     backend/src/modules/crossmodel/coding/tools.ts` shows only the #892
 *     schedule_self doc fix, machine-wake reconcile, working-tree
 *     checkpoints, repo hooks, diagnostics-after-edit, and scheduling guards
 *     — none touch read_file's error surface.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — NO platform
 * code change. Every deterministic seam behaved as designed: honest failure
 * surfaces, the breaker counted the weighted streak and auto-filed with
 * correct metadata (tool, session, run, intent-mismatch note), and no
 * mutation was wrongly executed.
 *
 * These tests pin the honest-errno contract for read_file through the REAL
 * executeCodingTool (boundary mocks mirror agent-derail-break.8e900af9.test.ts,
 * which mirrors listdir-enoent.4bf65e24.test.ts), so a future framework change
 * that masks, misroutes, or softens this failure surface is caught — plus the
 * hallucinated-path DISCRIMINATOR (a future refactor that MOVES the real files
 * to the ticket paths fails this suite loudly, forcing re-adjudication instead
 * of the class silently flipping) and the breaker's trip-math components.
 * The full agent-loop e2e replay (the ec9d7424 pattern) is deliberately NOT
 * duplicated here: its mock set stubs executeCodingTool, which is exactly the
 * REAL seam this suite exists to pin, and the weighted trip / newest-first /
 * one-round-withhold math is already pinned end-to-end by
 * agent-derail-break.ec9d7424.test.ts — this suite pins the two COMPONENTS
 * that fed THIS streak (failure shape + intent-mismatch conviction) instead.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts /
// listdir-enoent.4bf65e24.test.ts / agent-derail-break.8e900af9.test.ts (the
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
// One boundary mock BEYOND the 8e900af9 set, required ONLY because this suite
// also imports learnings-index.service for the breaker's failure-shape
// classifier (looksLikeToolFailure — a pure regex test): that module imports
// unified-memory.service (→ prisma/rag) for its nudger path, which this suite
// never exercises. Same boundary discipline, one hop deeper.
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memSearch: jest.fn(async () => []),
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
import { detectIntendedTool } from './tool-preflight';
import { looksLikeToolFailure } from './learnings-index.service';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── The incident's paths (worktree-relative form, as the lane's delegate brief
//    authored them) and the REAL files it should have read first ─────────────
const HALLUCINATED_A = 'backend/src/modules/crossmodel/resources/resource-tools.ts'; // filed text #1 (newest)
const HALLUCINATED_B = 'backend/src/modules/crossmodel/feedback/platform-tools.ts'; // filed text #2
const HALLUCINATED_DIR = 'backend/src/modules/crossmodel/resources'; // exists NOWHERE (no ref, no worktree)
const REAL_PLATFORM_TS = 'backend/src/modules/crossmodel/platform/platform-tools.ts';
const REAL_RESOURCE_TS = 'backend/src/modules/crossmodel/platform/resource-tools.ts';
const REAL_PLATFORM_DIR = 'backend/src/modules/crossmodel/platform';

let REPO = '';

const mkCtx = (): ToolContext => ({
  worktree: REPO, sessionId: 'sess-14739e76', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

const statOrNull = (p: string) => fs.stat(p).catch(() => null);

beforeAll(async () => {
  // This suite runs read_file against the REAL repo checkout (read-only tool,
  // zero mutation risk): the discriminator and the control are only load-bearing
  // if they probe the same tree the claim is about. realpath() so byte-exact
  // path assertions survive symlinked checkouts (macOS /var → /private/var);
  // Linux CI is already canonical. __dirname = backend/src/modules/crossmodel/coding.
  REPO = await fs.realpath(path.resolve(__dirname, '../../../../..'));
});

describe('ticket 14739e76 — hallucinated-path read_file streak: honest-errno contract (the streak was model behavior)', () => {
  it('DISCRIMINATOR (a): both ticket paths are ABSENT from this worktree — resources/ does not exist at all — while the real platform/ files DO exist (a future file MOVE fails this suite loudly and forces re-adjudication)', async () => {
    expect(await statOrNull(path.join(REPO, HALLUCINATED_A))).toBeNull();
    expect(await statOrNull(path.join(REPO, HALLUCINATED_B))).toBeNull();
    expect(await statOrNull(path.join(REPO, HALLUCINATED_DIR))).toBeNull();
    expect((await statOrNull(path.join(REPO, REAL_PLATFORM_TS)))?.isFile()).toBe(true);
    expect((await statOrNull(path.join(REPO, REAL_RESOURCE_TS)))?.isFile()).toBe(true);
  });

  it('REPLAY filed text #1 (newest): read_file on the hallucinated resources/resource-tools.ts fails with the byte-exact incident surface — catch-all prefix + raw ENOENT + jail-resolved path', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', {
      path: HALLUCINATED_A,
    });
    // The exact incident string shape (breaker trip 2026-09-20 05:25:56Z):
    // fs.readFile on a missing file throws ENOENT; the executeCodingTool
    // catch-all renders `Tool ${name} failed: ${err.message}` verbatim. A
    // byte-exact toBe is ALSO the no-softening pin — any appended guidance
    // breaks this assertion.
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${REPO}/${HALLUCINATED_A}'`);
  });

  it('REPLAY filed text #2: read_file on the hallucinated feedback/platform-tools.ts fails with the byte-exact incident surface — feedback/ EXISTS but carries no platform-tools.ts', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', {
      path: HALLUCINATED_B,
    });
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${REPO}/${HALLUCINATED_B}'`);
  });

  it('the failure names the JAIL-resolved absolute path (resolveRealInside falls back to the lexical jail path for a not-yet-created file), and an outside-worktree absolute path hits the containment error — never an errno read of /etc', async () => {
    expect(resolveInside(REPO, HALLUCINATED_A)).toBe(`${REPO}/${HALLUCINATED_A}`);
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: '/etc/hostname' });
    expect(out).toMatch(/^Tool read_file failed: path is outside the worktree: \/etc\/hostname/);
  });

  it('control (c): read_file on the REAL platform/resource-tools.ts SUCCEEDS with non-empty content — the verify-against-source-bytes-first move the lane should have made', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_RESOURCE_TS });
    expect(out).not.toMatch(/^Tool read_file failed:/);
    expect(out.length).toBeGreaterThan(0);
    // The file's verified header bytes (read this adjudication):
    expect(out).toContain('Watched-resource + training-artifact platform tools');
    // The ranged-read render is line-numbered — the exact view the lane needed.
    const ranged = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_RESOURCE_TS, start_line: 1, end_line: 2 });
    expect(ranged).toMatch(/^1\t\/\*\*\n2\t \* Watched-resource/);
  });

  it('directory arg (d): read_file on the platform DIRECTORY fails with the raw EISDIR errno — the read_file case (tools.ts:1389-1399) has NO directory guard; fs.readFile(dir) throws and the catch-all renders it verbatim (same fs.readFile seam as 8e900af9\'s edit_file EISDIR)', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_PLATFORM_DIR });
    expect(out).toBe('Tool read_file failed: EISDIR: illegal operation on a directory, read');
  });

  it('breaker trip-math components (e) — agent.ts:3171-3184: the rendered ENOENT texts are failure-shaped (the streak gate) and the incident narration convicts grep: 2 same-tool failures + 1 intent-mismatch = 3 → the FIRST trip, exactly two filed texts', async () => {
    const failA = await executeCodingTool(mkCtx(), 'read_file', { path: HALLUCINATED_A });
    const failB = await executeCodingTool(mkCtx(), 'read_file', { path: HALLUCINATED_B });
    // Component 1 — the streak counter only sees failure-shaped results
    // (learnings-index.service FAILURE_MARKERS[0]: /^Tool \S+ failed:/).
    expect(looksLikeToolFailure(failA)).toBe(true);
    expect(looksLikeToolFailure(failB)).toBe(true);
    // Component 2 — the +1 intent-mismatch weight: the ticket's "lane's
    // reasoning named grep" signature is detectIntendedTool(narration,
    // 'read_file', offered) === 'grep' — narration names ANOTHER offered tool
    // as a whole word and never names the called one.
    const OFFERED = ['read_file', 'list_dir', 'glob', 'grep', 'write_file', 'edit_file', 'run_command'];
    const incidentNarration =
      'Let me grep the crossmodel tree for where the watched-resource platform tools are registered before delegating the edit.';
    expect(detectIntendedTool(incidentNarration, 'read_file', OFFERED)).toBe('grep');
    // Asymmetry pin: narrating the CALLED tool convicts NOTHING — a truthful
    // lane that says what it calls is never fast-tripped by this weight.
    expect(detectIntendedTool('Let me read_file the platform module to verify the path exists.', 'read_file', OFFERED)).toBeNull();
  });
});
