/**
 * Replay pin — ticket 14d62f53 (mishap, auto-filed at breaker trip, session
 * 3b9b940b-93a9-44b7-b4ec-e19bc0f2ea34 "P3 turn plan label hygiene · Run
 * TPL1005", run 30861638-2572-4b01-bb81-0953e63f9c18; FIRST streak this
 * run; the lane's reasoning named search_memory).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak: read_file'
 * mishap with two failure texts — byte-identical (newest first):
 *   `Tool read_file failed: ENOENT: no such file or directory, open
 *    '/app/coding-workspaces/worktrees/3b9b940b-93a9-44b7-b4ec-e19bc0f2ea34/
 *    backend/src/modules/crossmodel/chat-agent/turn-plan-labels.ts'`
 * Call args of the two failing calls (newest first): {path:
 * 'backend/src/modules/crossmodel/chat-agent/turn-plan-labels.ts'} — twice,
 * UNRANGED (no start_line/end_line): two reads of the SAME path.
 *
 * WHAT ACTUALLY HAPPENED (adjudicated 2026-10-05, all evidence fresh):
 *  1. STALE-BASE class — the OPPOSITE discriminator from 9cc62eef
 *     (hallucinated flat path, never carried by any ref): here the path is
 *     REAL. backend/src/modules/crossmodel/chat-agent/turn-plan-labels.ts
 *     was introduced by 8b113c521 (dynamic roster phase 2, #1230), an
 *     ANCESTOR of origin/main (git merge-base --is-ancestor 8b113c521 HEAD
 *     → 0, read 2026-10-05) and present in this main-synced checkout (83
 *     lines, exports labelTurnPlan). The failing session's worktree,
 *     however, sat at off-main 2745ea539 — a base cut BEFORE 8b113c521 —
 *     via the documented chain-from-prior provisioning (platform.service.ts
 *     findPriorSession → provisionWorktree, ~:2410-:2430: a prompt-less
 *     session inherits the most recent prior session's branch, which can
 *     legitimately predate files that landed on main after it was cut).
 *     read_file ENOENT'd honestly: the file genuinely did not exist in
 *     THAT checkout.
 *  2. ROOT CAUSE: model behavior on a stale surface — a CORRECT path guess
 *     against an out-of-date base. read_file failed twice with the honest
 *     errno; the breaker counted 2 consecutive same-tool failures + 1
 *     intent-mismatch (reasoning named search_memory) = 3 → the FIRST trip,
 *     which is why the ticket carries exactly two failure texts for a "3×"
 *     streak. The run's receipts show it continuing past the trip — the
 *     streak did not recur.
 *  3. HONEST-ERRNO CONTRACT: read_file (tools.ts `case 'read_file'`)
 *     resolves through the jail — resolveRealInside falls back to the
 *     lexical jail path for a not-yet-created file — then fs.readFile
 *     throws ENOENT; the executeCodingTool catch-all renders
 *     `Tool ${name} failed: ${err.message}` VERBATIM — no softening, no
 *     in-band guidance. The replay below reproduces the incident against a
 *     TEMP STALE WORKTREE (a plain dir shaped like a pre-8b113c521
 *     checkout: the jail has NO git checks, so an empty dir with the
 *     parent path is exactly what that checkout looked like to read_file).
 *     Same pinned family as list_dir (ticket 4bf65e24), edit_file
 *     (8e900af9), read_file hallucinated-path (14739e76) and read_file
 *     hallucinated-path RANGED (9cc62eef). Softening this errno would
 *     contradict those pins — do NOT do it.
 *  4. NO FRAMEWORK REGRESSION: the stale base itself is the documented
 *     chain-from-prior seam (platform.service.ts continuity by design;
 *     ticket 43de2735 narrowed only the PLAN inheritance), and
 *     `git log --oneline -6 --
 *     backend/src/modules/crossmodel/coding/tools.ts` (read 2026-10-05)
 *     shows #1255 open_pull_request verify qualification, #1241 quick
 *     wins, answer-key guard, reviewer-brief fix, view_image, and
 *     update_plan validation — none touch read_file's error surface.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR on a stale
 * checkout — NO platform code change. Every deterministic seam behaved as
 * designed: the honest ENOENT surface, the jail fallback naming the
 * worktree path, the chain-from-prior provisioning that legitimately
 * serves a stale base to a new lane, and the breaker's weighted trip +
 * auto-file with correct metadata (tool, session, run, intent-mismatch
 * note).
 *
 * These tests pin that contract through the REAL executeCodingTool
 * (boundary mocks mirror agent-derail-break.9cc62eef.test.ts, which
 * mirrors agent-derail-break.14739e76.test.ts), plus the stale-base
 * DISCRIMINATOR (the ticket path is REAL on main — a future refactor that
 * MOVES or DELETES turn-plan-labels.ts fails this suite loudly, forcing
 * re-adjudication instead of the class silently flipping to
 * hallucinated-path) and the breaker's trip-math components.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts /
// listdir-enoent.4bf65e24.test.ts / agent-derail-break.14739e76.test.ts (the
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
// The learnings-index.service boundary mock (unified-memory.service →
// prisma/rag) — carried forward verbatim from the 9cc62eef/14739e76 set:
// those suites import the same module for looksLikeToolFailure, and this
// one does too.
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
  listProcesses: jest.fn(() => ''),
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
import * as os from 'os';

// ── The incident's path (worktree-relative, exactly as the lane's read_file
//    calls carried it) — a REAL file on main since 8b113c521 (dynamic roster
//    phase 2); the failing session's checkout simply predated it ──────────
const TURN_PLAN_LABELS = 'backend/src/modules/crossmodel/chat-agent/turn-plan-labels.ts';

let REPO = '';
let STALE = '';

const mkCtx = (worktree: string): ToolContext => ({
  worktree, sessionId: 'sess-14d62f53', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

const statOrNull = (p: string) => fs.stat(p).catch(() => null);

beforeAll(async () => {
  // This suite runs read_file against the REAL repo checkout (read-only
  // tool, zero mutation risk) for the control/discriminator legs, and
  // against a TEMP STALE WORKTREE for the incident replay. realpath() so
  // byte-exact path assertions survive symlinked checkouts (macOS
  // /var → /private/var); Linux CI is already canonical. __dirname =
  // backend/src/modules/crossmodel/coding.
  REPO = await fs.realpath(path.resolve(__dirname, '../../../../..'));
  // The stale fixture: a pre-8b113c521 checkout had
  // backend/src/.../chat-agent/ for years — but no turn-plan-labels.ts in
  // it. The jail has no git checks, so this plain dir is exactly what that
  // checkout looked like to read_file.
  STALE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stale-wt-14d62f53-')));
  await fs.mkdir(path.join(STALE, 'backend/src/modules/crossmodel/chat-agent'), { recursive: true });
});

afterAll(async () => {
  if (STALE) await fs.rm(STALE, { recursive: true, force: true });
});

describe('ticket 14d62f53 — stale-base read_file ENOENT streak: honest-errno contract (the streak was model behavior on a stale checkout)', () => {
  it('DISCRIMINATOR (a): the ticket path is REAL — present in this main-synced checkout (introducer 8b113c521, ancestor of origin/main) — so the incident was a STALE WORKTREE, not a hallucinated path; a future move/delete of turn-plan-labels.ts fails here loudly and forces re-adjudication', async () => {
    expect((await statOrNull(path.join(REPO, TURN_PLAN_LABELS)))?.isFile()).toBe(true);
  });

  it('REPLAY filed texts #1+#2 (both calls, UNRANGED, byte-identical): read_file on the REAL path against a STALE worktree fails with the byte-exact incident surface — catch-all prefix + raw ENOENT + jail-resolved path of the FAILING worktree', async () => {
    const outA = await executeCodingTool(mkCtx(STALE), 'read_file', { path: TURN_PLAN_LABELS });
    const outB = await executeCodingTool(mkCtx(STALE), 'read_file', { path: TURN_PLAN_LABELS });
    // The exact incident string shape (breaker trip): fs.readFile on a
    // file missing from the checkout throws ENOENT; the executeCodingTool
    // catch-all renders `Tool ${name} failed: ${err.message}` verbatim. A
    // byte-exact toBe is ALSO the no-softening pin — any appended guidance
    // breaks this assertion. Both incident calls carried only {path} and
    // rendered byte-identical texts.
    expect(outA).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${STALE}/${TURN_PLAN_LABELS}'`);
    expect(outB).toBe(outA);
  });

  it('the failure names the JAIL-resolved absolute path of the stale worktree (resolveRealInside falls back to the lexical jail path for a not-yet-created file — the filed text names the FAILING session\'s own root, not the real file\'s location), and an outside-worktree absolute path hits the containment error — never an errno read of /etc', async () => {
    expect(resolveInside(STALE, TURN_PLAN_LABELS)).toBe(`${STALE}/${TURN_PLAN_LABELS}`);
    const out = await executeCodingTool(mkCtx(STALE), 'read_file', { path: '/etc/hostname' });
    expect(out).toMatch(/^Tool read_file failed: path is outside the worktree: \/etc\/hostname/);
  });

  it('control (c): read_file on the REAL turn-plan-labels.ts in THIS main-synced worktree SUCCEEDS — returning exactly the bytes the stale lane was hunting (the label writer the TPL1005 run was working on)', async () => {
    const out = await executeCodingTool(mkCtx(REPO), 'read_file', { path: TURN_PLAN_LABELS });
    expect(out).not.toMatch(/^Tool read_file failed:/);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('export function labelTurnPlan');
    expect(out).toContain('TURN_PLAN_ESCALATION_WINDOW_MS');
    // The class seam, ranged so the assertion is cap-proof: the label
    // writer's signature line is DERIVED from the full read above (not
    // hardcoded), so the pin tracks edits to the file instead of staling
    // (ticket 14d62f53 follow-up: a +4-line edit once moved the pinned
    // line and broke this suite).
    const sigLine = out.split('\n').findIndex((l) => l.includes('export function labelTurnPlan')) + 1;
    expect(sigLine).toBeGreaterThan(0);
    const ranged = await executeCodingTool(mkCtx(REPO), 'read_file', { path: TURN_PLAN_LABELS, start_line: sigLine, end_line: sigLine });
    expect(ranged).toMatch(/^\d+\t/);
    expect(ranged).toContain('export function labelTurnPlan');
  });

  it('breaker trip-math components (d) — the rendered ENOENT texts are failure-shaped (the streak gate) and the filed "lane\'s reasoning named search_memory" note is the intent-mismatch weight: 2 same-tool failures + 1 intent-mismatch = 3 → the FIRST trip, exactly two filed texts', async () => {
    const failA = await executeCodingTool(mkCtx(STALE), 'read_file', { path: TURN_PLAN_LABELS });
    const failB = await executeCodingTool(mkCtx(STALE), 'read_file', { path: TURN_PLAN_LABELS });
    // Component 1 — the streak counter only sees failure-shaped results
    // (learnings-index.service FAILURE_MARKERS[0]: /^Tool \S+ failed:/).
    expect(looksLikeToolFailure(failA)).toBe(true);
    expect(looksLikeToolFailure(failB)).toBe(true);
    // Component 2 — the +1 intent-mismatch weight: the ticket's filed
    // metadata ("lane's reasoning named search_memory") is
    // detectIntendedTool(narration, 'read_file', offered) ===
    // 'search_memory' — narration names ANOTHER offered tool as a whole
    // word and never names the called one. (Representative narration; the
    // verbatim reasoning lives in chat 3b9b940b's transcript — the filed
    // note is the source of record.)
    const OFFERED = ['read_file', 'list_dir', 'glob', 'grep', 'search_memory', 'search_code_semantic', 'run_command'];
    const incidentNarration =
      'Let me search_memory for the turn plan label conventions before reading the labels module.';
    expect(detectIntendedTool(incidentNarration, 'read_file', OFFERED)).toBe('search_memory');
    // Asymmetry pin: narrating the CALLED tool convicts NOTHING — a truthful
    // lane that says what it calls is never fast-tripped by this weight.
    expect(detectIntendedTool('Let me read_file turn-plan-labels.ts to check its exports.', 'read_file', OFFERED)).toBeNull();
  });
});
