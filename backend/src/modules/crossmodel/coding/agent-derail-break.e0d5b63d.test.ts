/**
 * Replay pin — ticket e0d5b63d (mishap, breaker trip 2026-09-28T07:14:01.030Z,
 * session 24bb2d99-efca-4346-a5aa-30e01aab3737 "Create sanitized public
 * canlegalbench GitHub repo", run 3e832451-cd06-410a-980b-382a00a50325; FIRST
 * streak this run; tool read_file).
 *
 * THE INCIDENT (auto-filed at breaker trip, 07:13:59.032Z, three failure texts,
 * all byte-identical):
 *   `Tool read_file failed: ENOENT: no such file or directory, open
 *    '/app/coding-workspaces/worktrees/24bb2d99-efca-4346-a5aa-30e01aab3737/
 *    SANITIZATION.md'`
 *
 * WHAT ACTUALLY HAPPENED (adjudicated 2026-09-28, every fact re-probed fresh
 * from agent_events / coding_messages / loop_metrics on the prod boxes):
 *  1. THE CALLER was a DELEGATE REVIEWER, not the orchestrator: the main
 *     agent (glm-5.3) dispatched `delegate({role:'reviewer', …})` for an
 *     adversarial security review of the about-to-be-public repo (transcript
 *     msg 1bca8be4, part i=215). The delegate worker runs the fast seat
 *     (loop_metrics meta names model api-optimize-alibaba-deepseek-v4.1-flash)
 *     INSIDE the orchestrator's agent loop, so its read_file calls flow through
 *     the same breaker. The main agent itself made ZERO read_file calls the
 *     whole run (coding_messages.parts for the session hold 0 read_file
 *     tool_call entries — every one of the run's 110 read_file events is
 *     subagent:*).
 *  2. THE FILE EXISTS — in two places, neither of them the worktree ROOT. The
 *     orchestrator assembled the sanitized tree at tmp/san/pub/ inside its
 *     worktree (write_file parts i=144 first draft, i=236 the reviewer-driven
 *     rewrite: "Wrote tmp/san/pub/SANITIZATION.md (6641 bytes, 104 lines)")
 *     and pushed it as the fresh single-commit public repo; its own reviewer
 *     brief pointed the worker at a CLONE of that repo at /tmp/clb-verify
 *     ("The repo is a clone at /tmp/clb-verify (also readable: the assembly
 *     directory …/tmp/san/pub — same content)"). The reviewer's own successful
 *     `run_command cd /tmp/clb-verify && git ls-files` (agent_events seq 3149,
 *     07:13:45) printed "SANITIZATION.md" — the file is TRACKED in the clone
 *     at /tmp/clb-verify/SANITIZATION.md, 313 files.
 *  3. THE STREAK: between 07:07:16 and 07:13:56 the reviewer ran ~53
 *     successful run_command greps over /tmp/clb-verify whose outputs
 *     repeatedly showed ./SANITIZATION.md hits (seq 2509 "=== 89.124 ===
 *     ./SANITIZATION.md:41", seq 3116 canlii file list, seq 3150 git
 *     ls-files). Three times — seq 2518 (07:07:33), seq 2954 (07:12:09),
 *     seq 3176 (07:13:56) — it then called the JAILED file tool
 *     `read_file {path:"SANITIZATION.md"}`. read_file resolves a relative
 *     path against ctx.worktree (tools.ts resolveRealInside → resolveInside:
 *     "Path relative to the project root" per its own schema), so the bare
 *     name resolved to the WORKTREE ROOT — where the file has never existed
 *     (the run's Files snapshot lists RELEASE_NOTES.md → SECURITY.md with no
 *     SANITIZATION.md between) → honest ENOENT, byte-identical ×3.
 *  4. THE STREAK ARITHMETIC IS CORRECT BY DESIGN: in the 07:05→07:14:05
 *     window the reviewer produced 57 tool results — 53 run_command, 1
 *     list_dir, 3 read_file — and the ONLY failure-shaped results were the
 *     three ENOENTs. run_command is streak-EXEMPT (a red test loop is
 *     legitimate iteration), and a different tool's success does not reset a
 *     per-tool streak (agent.ts: the success branch clears failStreakTool
 *     only when `tc.name === failStreakTool`) — so the count ran 1 → 2 → 3
 *     across 6.5 minutes of healthy interleaved work. Trip at 3: one-round
 *     withhold + this auto-filed ticket. That interleaved arithmetic is the
 *     pinned 02bf673a anti-laundering semantics working as designed.
 *  5. THE SELF-HEAL (the doctrine's intended arc, 4 seconds after the trip):
 *     agent_events seq 3185 (07:14:05): `run_command cd /tmp/clb-verify &&
 *     cat -n SANITIZATION.md` → SUCCESS — the reviewer read the file through
 *     the tool whose contract matches an out-of-worktree absolute path (the
 *     shell honors real absolute paths; file tools are worktree-scoped and
 *     FAIL LOUD on absolute paths outside the worktree rather than remapping,
 *     the c7591297 design). The run completed (92 steps, plan 7/7) and the
 *     sanitized public repo shipped with the reviewer's findings folded in.
 *  6. NO FRAMEWORK REGRESSION: `git log` on tools.ts shows the read_file
 *     error surface untouched since the aa235f7f5/b3d9f8822 security batches;
 *     the breaker block (agent.ts failStreakCount) last changed with the D5
 *     supervisor-only ladder (86e54b489), which never touched the per-tool
 *     reset semantics this streak exercised.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the
 * reviewer worker reached for the jailed read_file tool with a bare relative
 * name whose grep-derived "existence evidence" lived in a directory OUTSIDE
 * the jail, in an assembly tree the brief itself pointed at — the same
 * orchestrator-authored-brief class as ticket 14739e76 (agent-derail-break.
 * 14739e76.test.ts). Every deterministic seam behaved as designed: the jail
 * failed LOUD with an honest errno naming the resolved absolute path, the
 * breaker counted the interleaved per-tool streak correctly, the one-round
 * withhold fired, the ticket was auto-filed with correct metadata, and the
 * worker self-recovered via the tool that CAN reach the file. NO platform
 * code change. Softening the errno into in-band guidance would contradict
 * the pinned 4bf65e24 honest-errno contract — do NOT do it.
 *
 * These tests pin, through the REAL executeCodingTool (boundary mocks mirror
 * agent-derail-break.14739e76.test.ts): the byte-exact incident surface for a
 * bare-name read that misses at the worktree root (no softening, the
 * jail-resolved absolute path), the JAIL ASYMMETRY the worker missed (a
 * relative path resolves under the worktree; an absolute out-of-worktree path
 * is refused with the loud containment error, NEVER remapped or silently
 * read; the out-of-tree file is unreadable by read_file by design), the
 * grep-output-priming shape (a bare name harvested from a listing of a
 * DIFFERENT directory fails at the root), the breaker's failure-shape
 * classification of the incident texts, and the control — the same call with
 * the worktree-RELATIVE path to the real file succeeds, which is the move
 * the worker should have made (and did, 4s later, through run_command).
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
// One boundary mock BEYOND the 14739e76 set, required ONLY because this suite
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
import { looksLikeToolFailure } from './learnings-index.service';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── The incident's names ──────────────────────────────────────────────────────
// BARE_NAME is the exact arg the reviewer emitted (agent_events seq 2518/2954/
// 3176: {"args":{"path":"SANITIZATION.md"},"name":"read_file"}). The worktree
// root this suite runs against is the REAL repo checkout (read-only tool, zero
// mutation risk) — SANITIZATION.md does not exist at ITS root either, so the
// bare-name read reproduces the byte-exact incident surface.
const BARE_NAME = 'SANITIZATION.md';
// The RELATIVE path the worker should have used had the file been in ITS
// worktree (the incident worktree's real location: tmp/san/pub/SANITIZATION.md).
// In THIS repo the same shape is a control file that DOES exist at a nested
// path — proves a nested-path read succeeds where the bare name misses.
const NESTED_CONTROL = 'scripts/framework-audit/probe-e0d5b63d.js';

let REPO = '';

const statOrNull = (p: string) => fs.stat(p).catch(() => null);

beforeAll(async () => {
  // This suite runs read_file against the REAL repo checkout (read-only tool,
  // zero mutation risk). realpath() so byte-exact path assertions survive
  // symlinked checkouts; __dirname = backend/src/modules/crossmodel/coding.
  REPO = await fs.realpath(path.resolve(__dirname, '../../../../..'));
});

const mkCtx = (): ToolContext => ({
  worktree: REPO, sessionId: 'sess-e0d5b63d', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

describe('ticket e0d5b63d — bare-name read_file ENOENT from an out-of-jail listing: honest-errno contract (the streak was model behavior)', () => {

  it('REPLAY (b): read_file on the bare name fails with the byte-exact incident surface — catch-all prefix + raw ENOENT + jail-resolved worktree-root path, NO softening and NO in-band guidance', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: BARE_NAME });
    // The exact incident string shape (breaker trip 2026-09-28T07:14:01.030Z —
    // all three filed texts byte-identical): fs.readFile on a missing file
    // throws ENOENT; the executeCodingTool catch-all renders
    // `Tool ${name} failed: ${err.message}` verbatim. A byte-exact toBe is
    // ALSO the no-softening pin — any appended guidance breaks this assertion.
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${REPO}/${BARE_NAME}'`);
    // And the breaker's streak gate (learnings-index.service FAILURE_MARKERS)
    // saw it as failure-shaped — the input to the 1→2→3 count.
    expect(looksLikeToolFailure(out)).toBe(true);
  });

  it('JAIL ASYMMETRY (c): the bare name resolves UNDER the worktree (a relative path is worktree-rooted — the exact trap), while the out-of-worktree ABSOLUTE path (where the reviewer\'s greps actually ran) is refused with the loud containment error, NEVER remapped or silently read', async () => {
    // The trap itself: a bare relative name resolves against the worktree root.
    expect(resolveInside(REPO, BARE_NAME)).toBe(`${REPO}/${BARE_NAME}`);
    // The out-of-jail target (the reviewer's /tmp/clb-verify clone):
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: '/tmp/clb-verify/SANITIZATION.md' });
    expect(out).toMatch(/^Tool read_file failed: path is outside the worktree: \/tmp\/clb-verify\/SANITIZATION\.md/);
    // The containment error is ALSO failure-shaped — had the worker tried the
    // absolute form it would have streaked the same way. The jail is honest
    // from every direction.
    expect(looksLikeToolFailure(out)).toBe(true);
  });


  it('SELF-HEAL CONTROL (e): the recovery the worker actually made — the shell reaches the out-of-jail absolute path that read_file must refuse — is the designed pairing, and its [command OK] banner is NOT failure-shaped (run_command is also the streak-exempt tool, so the recovery never fed the streak)', async () => {
    // The self-heal at 07:14:05 (agent_events seq 3185):
    //   run_command cd /tmp/clb-verify && cat -n SANITIZATION.md → [command OK]
    // The banner contract: success leads with [command OK]; the failure-shape
    // classifier (which feeds the breaker streak) must see neither shape as a
    // failure — the exempt tool's result never moves the read_file streak.
    expect(looksLikeToolFailure('[command OK]\n1\t# Public-repo sanitization inventory')).toBe(false);
    // A real command failure is still failure-shaped — through its [exit: N]
    // TAIL marker (EXIT_MARKER_TAIL_RE), not the banner alone: the banner is
    // for the model, the tail is for the classifier.
    expect(looksLikeToolFailure('[command FAILED — exit 1]\ngrep: no match\n[exit: 1]')).toBe(true);
    expect(looksLikeToolFailure('[command FAILED — exit 1]\ngrep: no match')).toBe(false); // banner alone: not the marker
  });

  it('BREAKER COMPONENT (f): the incident carried NO intent-mismatch weight — the three texts were the only inputs (1+1+1 across 6.5 min of interleaved exempt-tool successes), so the FIRST trip landed exactly at the third call, not before — pinning that a different tool\'s successes do not reset a per-tool streak', async () => {
    // The count arithmetic this incident exercised (agent.ts failStreakCount):
    // three same-tool failure-shaped results, ZERO same-tool successes between
    // them (the 53 interleaved run_command results are streak-EXEMPT and a
    // different tool's success does not clear failStreakTool), so the count
    // ran 1 → 2 → 3 and the FIRST trip fired on the third call. The
    // interleave/no-reset semantics are pinned end-to-end by
    // agent-derail-break.02bf673a.test.ts and 03587322's NO-RESET pin; this
    // pin is the incident's own classifier evidence: all three filed texts are
    // failure-shaped, and a success-shaped interleaved result is not.
    const filed = [
      `Tool read_file failed: ENOENT: no such file or directory, open '/app/coding-workspaces/worktrees/24bb2d99-efca-4346-a5aa-30e01aab3737/SANITIZATION.md'`,
      `Tool read_file failed: ENOENT: no such file or directory, open '/app/coding-workspaces/worktrees/24bb2d99-efca-4346-a5aa-30e01aab3737/SANITIZATION.md'`,
      `Tool read_file failed: ENOENT: no such file or directory, open '/app/coding-workspaces/worktrees/24bb2d99-efca-4346-a5aa-30e01aab3737/SANITIZATION.md'`,
    ];
    for (const t of filed) expect(looksLikeToolFailure(t)).toBe(true);
    // The interleaved run_command greps' real result shape (seq 2509 etc.) —
    // success-shaped, streak-exempt, non-resetting for the read_file streak:
    expect(looksLikeToolFailure('[command OK]\n=== 89.124 ===\n./SANITIZATION.md:41:| `leade')).toBe(false);
  });
});
