/**
 * Replay pin — ticket 9cc62eef (mishap, auto-filed at breaker trip
 * 2026-10-05T07:46:25Z, session b811d9f7-9b95-4d59-bab0-4738303421a1
 * "Mac agent calendar · Backend: normalizeA…", run
 * cfb891b7-e393-4428-ae1e-2b8ce5ab19ee; FIRST streak this run; the lane's
 * reasoning named grep).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak: read_file'
 * mishap with two failure texts — byte-identical (newest first):
 *   `Tool read_file failed: ENOENT: no such file or directory, open
 *    '/app/coding-workspaces/worktrees/b811d9f7-9b95-4d59-bab0-4738303421a1/
 *    backend/src/modules/crossmodel/imessage.controller.ts'`
 * Call args of the two failing calls (newest first): {start_line:470,
 * end_line:520} and {start_line:155, end_line:210} — two RANGED reads of the
 * SAME nonexistent flat path.
 *
 * WHAT ACTUALLY HAPPENED (adjudicated 2026-10-05, all evidence fresh):
 *  1. HALLUCINATED-PATH class — the same class as 14739e76
 *     (agent-derail-break.14739e76.test.ts), NOT stale-worktree:
 *     `git log --all --oneline --
 *     backend/src/modules/crossmodel/imessage.controller.ts` is EMPTY — no
 *     ref ever carried the flat path. The controller has always lived one
 *     level deeper, in the module dir:
 *     backend/src/modules/crossmodel/imessage/imessage.controller.ts
 *     (export class IMessageController at :141, 524 lines — the incident's
 *     own ranges 155–210 and 470–520 BOTH land inside the real file, so the
 *     lane held a correct CONTENT model on a wrong PATH model: it guessed
 *     the controller at the flat path where the imessage/ module dir
 *     actually holds it, alongside agent-capabilities.ts).
 *  2. ROOT CAUSE: model behavior — a confident flat-path guess. read_file
 *     ENOENT'd honestly twice; the breaker counted 2 consecutive same-tool
 *     failures + 1 intent-mismatch (reasoning named grep) = 3 → the FIRST
 *     trip, which is why the ticket carries exactly two failure texts for a
 *     "3×" streak.
 *  3. HONEST-ERRNO CONTRACT: read_file (tools.ts `case 'read_file'`,
 *     ~line 1752) resolves through the jail — resolveRealInside falls back
 *     to the lexical jail path for a not-yet-created file — then fs.readFile
 *     throws ENOENT BEFORE the start_line/end_line range-slicing branch ever
 *     runs, which is exactly why both RANGED calls rendered byte-identical
 *     texts; the executeCodingTool catch-all renders `Tool ${name} failed:
 *     ${err.message}` VERBATIM — no softening, no in-band guidance. Same
 *     pinned family as list_dir (ticket 4bf65e24), edit_file (8e900af9) and
 *     read_file (14739e76). Softening this errno would contradict those
 *     pins — do NOT do it.
 *  4. NO FRAMEWORK REGRESSION: `git log --oneline -6 --
 *     backend/src/modules/crossmodel/coding/tools.ts` (read 2026-10-05)
 *     shows #1255 open_pull_request verify qualification, #1241 quick wins,
 *     answer-key guard, reviewer-brief fix, view_image, and update_plan
 *     validation — none touch read_file's error surface.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — NO
 * platform code change. Every deterministic seam behaved as designed: the
 * honest ENOENT surface, the jail fallback naming the worktree path, and
 * the breaker's weighted trip + auto-file with correct metadata (tool,
 * session, run, intent-mismatch note).
 *
 * These tests pin that contract through the REAL executeCodingTool
 * (boundary mocks mirror agent-derail-break.14739e76.test.ts, which mirrors
 * listdir-enoent.4bf65e24.test.ts), plus the hallucinated-path DISCRIMINATOR
 * (a future refactor that MOVES imessage.controller.ts OUT to the flat
 * ticket path fails this suite loudly, forcing re-adjudication instead of
 * the class silently flipping) and the breaker's trip-math components. The
 * full agent-loop e2e replay (the ec9d7424 pattern) is deliberately NOT
 * duplicated: its mock set stubs executeCodingTool — the REAL seam this
 * suite exists to pin — and the weighted trip math is already pinned
 * end-to-end by agent-derail-break.ec9d7424.test.ts.
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
// prisma/rag) — carried forward verbatim from the 14739e76 set: that suite
// imports the same module for looksLikeToolFailure, and this one does too.
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

// ── The incident's path (worktree-relative, exactly as the lane's read_file
//    calls carried it — a FLAT guess that collapses away the imessage/ module
//    dir) and the REAL file it should have read ─────────────────────────────
const HALLUCINATED_FLAT = 'backend/src/modules/crossmodel/imessage.controller.ts'; // both filed texts
const REAL_CONTROLLER = 'backend/src/modules/crossmodel/imessage/imessage.controller.ts';
const REAL_DIR = 'backend/src/modules/crossmodel/imessage'; // exists (holds the controller + agent-capabilities.ts)

let REPO = '';

const mkCtx = (): ToolContext => ({
  worktree: REPO, sessionId: 'sess-9cc62eef', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

const statOrNull = (p: string) => fs.stat(p).catch(() => null);

beforeAll(async () => {
  // This suite runs read_file against the REAL repo checkout (read-only tool,
  // zero mutation risk): the discriminator and the control are only
  // load-bearing if they probe the same tree the claim is about. realpath()
  // so byte-exact path assertions survive symlinked checkouts (macOS
  // /var → /private/var); Linux CI is already canonical. __dirname =
  // backend/src/modules/crossmodel/coding.
  REPO = await fs.realpath(path.resolve(__dirname, '../../../../..'));
});

describe('ticket 9cc62eef — hallucinated flat-path read_file streak: honest-errno contract (the streak was model behavior)', () => {
  it('DISCRIMINATOR (a): the flat ticket path is ABSENT from this worktree (and from every git ref — see header) while the REAL module-dir controller exists — a future file MOVE to the flat path fails this suite loudly and forces re-adjudication', async () => {
    expect(await statOrNull(path.join(REPO, HALLUCINATED_FLAT))).toBeNull();
    expect((await statOrNull(path.join(REPO, REAL_CONTROLLER)))?.isFile()).toBe(true);
    // The module dir the flat guess collapsed away:
    expect((await statOrNull(path.join(REPO, REAL_DIR)))?.isDirectory()).toBe(true);
  });

  it('REPLAY filed text #1 (newest call, start_line 470 end_line 520): read_file on the hallucinated flat path fails with the byte-exact incident surface — catch-all prefix + raw ENOENT + jail-resolved path', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', {
      path: HALLUCINATED_FLAT, start_line: 470, end_line: 520,
    });
    // The exact incident string shape (breaker trip 2026-10-05T07:46Z):
    // fs.readFile on a missing file throws ENOENT; the executeCodingTool
    // catch-all renders `Tool ${name} failed: ${err.message}` verbatim. A
    // byte-exact toBe is ALSO the no-softening pin — any appended guidance
    // breaks this assertion.
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${REPO}/${HALLUCINATED_FLAT}'`);
  });

  it('REPLAY filed text #2 (older call, start_line 155 end_line 210): renders byte-IDENTICAL to text #1 — fs.readFile throws BEFORE the range-slicing branch, so the ranged args never reach the render', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', {
      path: HALLUCINATED_FLAT, start_line: 155, end_line: 210,
    });
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${REPO}/${HALLUCINATED_FLAT}'`);
  });

  it('the failure names the JAIL-resolved absolute path (resolveRealInside falls back to the lexical jail path for a not-yet-created file), and an outside-worktree absolute path hits the containment error — never an errno read of /etc', async () => {
    expect(resolveInside(REPO, HALLUCINATED_FLAT)).toBe(`${REPO}/${HALLUCINATED_FLAT}`);
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: '/etc/hostname' });
    expect(out).toMatch(/^Tool read_file failed: path is outside the worktree: \/etc\/hostname/);
  });

  it('control (c): read_file on the REAL imessage/imessage.controller.ts SUCCEEDS — and the incident\'s OWN line ranges return the exact bytes the lane was hunting for once the path is corrected', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_CONTROLLER });
    expect(out).not.toMatch(/^Tool read_file failed:/);
    expect(out.length).toBeGreaterThan(0);
    // The class seam (re-anchored to :146 by the 4e75cdea platform field in the
    // AgentRequest interface — same re-anchoring the 1ea9a120 edit did; then
    // :165 by the e2915963 label/agentVersion interface fields + the
    // agent-perm-regression/redis imports, :173 by the c44b19e9
    // agent-tcc-regrant imports, :172 by the post-review ReGrantKey
    // import trim, :173 by the 0.9.10 regrantCoversRegression import, now :189
    // by the c468f922 devicePayload prelogin/remoteAccess/unattendedReady
    // fields + their imports, now :205 by the c468f922 (d)-helper
    // prelogin-helper import + preloginHelper payload field, now :217 by the
    // c468f922 brokered-session fold + its crypto import (the withBrokeredSessionWindow import +
    // the wrapped remoteAccess verdict in devicePayload), now :235 by the
    // c468f922 RELAY DATA PLANE imports (relay-dataplane + .store) and the
    // randomBytes crypto import, now :236 by the c468f922 review follow-up (the
    // RELAY_CAPABILITY_HEADER import — one line added above the class seam)),
    // read ranged so the assertion is cap-proof:
    const cls = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_CONTROLLER, start_line: 236, end_line: 243 });
    expect(cls).toContain('export class IMessageController');
    // The ranged read at the OLDER call's own numbers (155–210, re-anchored to
    // 158–213 by the 1ea9a120 agent-row interface edit, then 160–215 by the
    // 4e75cdea pair/complete update-block edit, 179–234 by the e2915963
    // interface/import additions, 187–242 by the c44b19e9 re-grant poll
    // block, 186–241 by the post-review import trim, 187–242 by the
    // 0.9.10 T1 hoisted-parse + covered-guard block, 188–243 by the
    // 2026-10-28 unattended-preset import + pair-body advert, 189–244 by
    // the 2026-10-29 c468f922 brokered-remote-access import + pair-body
    // advert, now 203–258 by the c468f922 devicePayload
    // prelogin/remoteAccess/unattendedReady fields, now 219–274 by the
    // c468f922 (d)-helper prelogin-helper import + preloginHelper payload
    // field, now 231–286 by the c468f922 brokered-session fold, now 249–304 by
    // the c468f922 RELAY DATA PLANE imports (+18), the capability mint in the
    // open handler and close's transport-state clear — BOTH of which sit above
    // this window, now 250–305 by the c468f922 review follow-up (+1: the
    // RELAY_CAPABILITY_HEADER import). The pair/complete route — agent-command
    // transport, the seam the calendar lane was editing around. First line
    // renders line-numbered:
    const ranged = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_CONTROLLER, start_line: 250, end_line: 305 });
    expect(ranged).toMatch(/^250\t {3}\* POST \/imessage\/pair\/complete/);
    // The NEWEST call's own numbers (470–520, re-anchored to 473–527 by the
    // 1ea9a120 controller edits, 533–542 by the 4e75cdea additions, 541–550
    // by the 31fd8440 latestAgentVersion status additions, 592–601 by the
    // e2915963 TCC-regression detector block above it, 625–634 by the
    // c44b19e9 consolidated re-grant block + push helper, 624–633 by the
    // import trim, 636–645 by the 0.9.10 T3 no-channel releases, then
    // 651–660 by the 2026-10-28 unattended advert + touchAgent wiring, then
    // 669–678 by the 2026-10-29 c468f922 brokered-remote-access poll advert,
    // 673–682 by the 2026-10-29 30d3c366 VALID_PANES pane additions, now
    // 687–696 by the c468f922 devicePayload
    // prelogin/remoteAccess/unattendedReady fields, now 722–731 by the
    // c468f922 (d)-helper poll advert + touchAgent wiring, now 860–869 by the
    // c468f922 brokered-session fold, now 1089–1098 by the c468f922 RELAY DATA
    // PLANE block (+229: the four relay handlers and the open/close capability
    // wiring all sit between the class seam and this method — note the delta is
    // NOT the top-of-file +18, which is why each window is measured, never
    // inferred from the first one), now 1101–1110 by the c468f922 review
    // follow-up (+12: the +1 import plus the 11-line capability-in-url refusal
    // guard in getRelayFrames)):
    // deliverResult + the tail.
    const ranged2 = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_CONTROLLER, start_line: 1101, end_line: 1110 });
    expect(ranged2).toMatch(/^1101\t {2}async agentResult\(req: AgentRequest, res: Response\) \{/);
    expect(ranged2).toContain('deliverResult');
  });

  it('directory arg (d): read_file on the REAL imessage/ DIRECTORY fails with the raw EISDIR errno — the read_file case has NO directory guard; fs.readFile(dir) throws and the catch-all renders it verbatim (same fs.readFile seam as 8e900af9\'s edit_file EISDIR)', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: REAL_DIR });
    expect(out).toBe('Tool read_file failed: EISDIR: illegal operation on a directory, read');
  });

  it('breaker trip-math components (e) — the rendered ENOENT texts are failure-shaped (the streak gate) and the filed "lane\'s reasoning named grep" note is the intent-mismatch weight: 2 same-tool failures + 1 intent-mismatch = 3 → the FIRST trip, exactly two filed texts', async () => {
    const failA = await executeCodingTool(mkCtx(), 'read_file', { path: HALLUCINATED_FLAT, start_line: 470, end_line: 520 });
    const failB = await executeCodingTool(mkCtx(), 'read_file', { path: HALLUCINATED_FLAT, start_line: 155, end_line: 210 });
    // Component 1 — the streak counter only sees failure-shaped results
    // (learnings-index.service FAILURE_MARKERS[0]: /^Tool \S+ failed:/).
    expect(looksLikeToolFailure(failA)).toBe(true);
    expect(looksLikeToolFailure(failB)).toBe(true);
    // Component 2 — the +1 intent-mismatch weight: the ticket's filed
    // metadata ("lane's reasoning named grep") is detectIntendedTool(
    // narration, 'read_file', offered) === 'grep' — narration names ANOTHER
    // offered tool as a whole word and never names the called one.
    // (Representative narration; the verbatim reasoning lives in chat
    // b811d9f7's transcript — the filed note is the source of record.)
    const OFFERED = ['read_file', 'list_dir', 'glob', 'grep', 'write_file', 'edit_file', 'run_command'];
    const incidentNarration =
      'Let me grep the crossmodel tree for the imessage controller routes before wiring the agent permission normalization.';
    expect(detectIntendedTool(incidentNarration, 'read_file', OFFERED)).toBe('grep');
    // Asymmetry pin: narrating the CALLED tool convicts NOTHING — a truthful
    // lane that says what it calls is never fast-tripped by this weight.
    expect(detectIntendedTool('Let me read_file the imessage controller to verify the path exists.', 'read_file', OFFERED)).toBeNull();
  });
});
