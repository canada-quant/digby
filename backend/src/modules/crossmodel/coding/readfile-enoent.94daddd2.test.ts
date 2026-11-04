/**
 * Replay pin — ticket 94daddd2 (mishap, auto-filed at breaker trip):
 * "3× tool-failure streak: read_file on '68a1c868 round-6 adversarial
 * review · Or' — framework or model?"
 *
 * THE INCIDENT: session d429130f — the round-6 adversarial-reviewer session
 * for PR #1947 (branch digby/68a1c868-round2) — run c4e603ef (LIVE and
 * productive at pin time: plan 6/8, ~90 receipts, overwhelmingly
 * run_command successes after the trip). Three read_file misses in a row:
 *   1. `/tmp/r6rev/tip/backend/src/modules/crossmodel/fleet/
 *      follow-through.service.ts` — an ABSOLUTE path outside the worktree:
 *      the c7591297 jail contract refusal (verbatim, failure 1 below).
 *   2. `.digby/68a1c868-r6-corpus.ts` — ENOENT (failure 2).
 *   3. `.digby/68a1c868-r6-differential.md` — ENOENT (failure 3).
 *
 * THE ADJUDICATION — MODEL behavior on a CORRECT framework (forensics
 * gathered fresh 2026-10-25; every fact below was re-verified this run):
 *  1. Failure 1 is the PINNED c7591297 worktree-jail contract: read_file
 *     runs resolveRealInside → resolveInside, which REFUSES an absolute
 *     path outside the worktree with exactly the incident text (tools.ts
 *     "path is outside the worktree: …"). The reviewer session builds its
 *     own detached git worktrees under /tmp/r6rev/ (flips.txt / gained.txt /
 *     lost.txt live there) and reads them via run_command — a file tool
 *     pointed at that container /tmp MUST refuse (the two filesystems are
 *     split-brain by design; remapping was the prod incident c7591297
 *     fixed). The refusal text itself says how to read it.
 *  2. Failures 2–3 are the PINNED honest-ENOENT class (601d0cce /
 *     68e027814): the session was spawned FRESH from main (base eaa157a6e,
 *     0 commits ahead) while the two `.digby/68a1c868-r6-*` files exist
 *     ONLY on the PR branch — committed in 061473ce7
 *     (2026-10-24T23:57:51Z, "commit the differential corpus", part of PR
 *     #1947's round-6 work). A relative-path read_file resolves against the
 *     SESSION's worktree; a file that exists only on another branch MUST
 *     ENOENT (the tool tracks the real tree, never a cache). The model
 *     then recovered exactly as the contract directs: run_command on the
 *     absolute container paths (~90 subsequent receipts, mostly OK).
 *  3. No fuzzy routing exists to blame: dispatch is `switch (name)` on the
 *     exact tool name (tools.ts); the catch-all renders
 *     `Tool read_file failed: <message>` verbatim.
 *  4. The breaker's filing is the DESIGNED containment (the 3× streak
     escalated for investigation; the tool was never withheld — the run
 *     continued and finished its review).
 *
 * WHAT THIS PIN GUARDS (no detector change — marker untouched):
 *  - both refusal surfaces stay byte-exact (the jail text with its fix
 *    guidance; ENOENT with the jail-resolved absolute path);
 *  - both are failure-shaped for the breaker (DETECTOR-RECALL REPLAY of
 *    the PRIOR true positives: the verbatim incident texts still convict
 *    — a future FAILURE_MARKERS edit that stops convicting either class
 *    fails here);
 *  - the recovery breakthroughs: the same relative path reads fine once the
 *    file exists in the session worktree, and run_command remains the
 *    documented path for container-absolute reads.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// learnings-index.service → unified-memory.service → database → env chain:
// env parse exits at import without these (same discipline as the
// 601d0cce / 065a5b5f suites).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
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

import { executeCodingTool, resolveInside, type ToolContext } from './tools';
import { looksLikeToolFailure } from './learnings-index.service';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let WT = '';
const mkCtx = (): ToolContext => ({
  worktree: WT, sessionId: 'sess-94daddd2', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

// The incident shapes, as the reviewer session emitted them.
const CORPUS_REL = '.digby/68a1c868-r6-corpus.ts';
const DIFFERENTIAL_REL = '.digby/68a1c868-r6-differential.md';
const fleetRel = 'backend/src/modules/crossmodel/fleet/follow-through.service.ts';

beforeAll(async () => {
  // A worktree shaped like the reviewer session's: spawned fresh from main —
  // the two `.digby/68a1c868-r6-*` files ABSENT (they exist only on the PR
  // branch, 061473ce7) but the `.digby` directory present, plus the fleet
  // file PRESENT (it exists on main too).
  WT = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-94daddd2-'));
  await fs.mkdir(path.join(WT, '.digby'), { recursive: true });
  await fs.writeFile(path.join(WT, '.digby', 'unrelated-note.md'), '# session state\n');
  await fs.mkdir(path.join(WT, 'backend/src/modules/crossmodel/fleet'), { recursive: true });
  await fs.writeFile(path.join(WT, fleetRel), 'export function followThrough() { return 1; }\n');
});
afterAll(async () => { await fs.rm(WT, { recursive: true, force: true }); });

describe('ticket 94daddd2 — honest refusals for read_file on a fresh reviewer worktree (model behavior; guards fired correctly)', () => {
  it('REPLAY failure 1: the container-absolute /tmp path gets the EXACT c7591297 jail refusal (verbatim incident surface)', async () => {
    const abs = `/tmp/r6rev/tip/${fleetRel}`;
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: abs, start_line: 330, end_line: 500 });
    expect(out).toBe(
      `Tool read_file failed: path is outside the worktree: ${abs} — file tools are worktree-scoped and no longer remap absolute paths ` +
      `(the shell's real /tmp, /etc, … are a DIFFERENT filesystem than the worktree — a write_file there never reaches run_command). ` +
      `Fix: use a worktree-relative path (the shell's cwd IS the worktree, so the same relative path works in run_command), ` +
      `or write/read the absolute container path inside run_command itself (heredoc).`,
    );
  });

  it('REPLAY failure 2: the PR-branch-only corpus path (relative) fails with the EXACT ENOENT + jail-resolved absolute path — and the jail resolution is pinned INDEPENDENTLY (naive join, the 601d0cce:189 discipline)', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: CORPUS_REL, start_line: 1, end_line: 218 });
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${resolveInside(WT, CORPUS_REL)}'`);
    // Independent anchor: the same path the incident named, computed WITHOUT
    // resolveInside — a wrong-root/double-nesting defect in the jail cannot
    // drag the expectation along with it.
    expect(resolveInside(WT, CORPUS_REL)).toBe(`${WT}/${CORPUS_REL}`);
    expect(out).toContain(`open '${WT}/${CORPUS_REL}'`);
  });

  it('REPLAY failure 3: the PR-branch-only differential path fails the same way — both ENOENTs are correct cross-branch refusals', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: DIFFERENTIAL_REL, start_line: 1, end_line: 120 });
    expect(out).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${resolveInside(WT, DIFFERENTIAL_REL)}'`);
    expect(out).toContain(`open '${WT}/${DIFFERENTIAL_REL}'`); // independent anchor, see failure 2
  });

  it('DETECTOR-RECALL REPLAY (marker unchanged — prior true positives still convict): all three VERBATIM incident texts are failure-shaped', () => {
    const abs = `/tmp/r6rev/tip/${fleetRel}`;
    const tp1 = `Tool read_file failed: path is outside the worktree: ${abs} — file tools are worktree-scoped and no longer remap absolute paths (the shell's real /tmp, /etc, … are a DIFFERENT filesystem than the worktree — a write_file there never reaches run_command). Fix: use a worktree-relative path (the shell's cwd IS the worktree, so the same relative path works in run_command), or write/read the absolute container path inside run_command itself (heredoc).`;
    const tp2 = `Tool read_file failed: ENOENT: no such file or directory, open '${resolveInside(WT, CORPUS_REL)}'`;
    const tp3 = `Tool read_file failed: ENOENT: no such file or directory, open '${resolveInside(WT, DIFFERENTIAL_REL)}'`;
    expect(looksLikeToolFailure(tp1)).toBe(true);
    expect(looksLikeToolFailure(tp2)).toBe(true);
    expect(looksLikeToolFailure(tp3)).toBe(true);
  });

  it('CONTRAST: the fleet file that DOES exist on main reads fine through the worktree-relative path — the tool is not broken for present files', async () => {
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: fleetRel });
    expect(out).toContain('export function followThrough()');
  });

  it('RECOVERY BREAKTHROUGH: creating the corpus file in the session worktree makes the same read succeed — the tool tracks the REAL tree, not a cache', async () => {
    await fs.writeFile(resolveInside(WT, CORPUS_REL), '// landed via 061473ce7 (PR #1947 round 6)\n');
    const out = await executeCodingTool(mkCtx(), 'read_file', { path: CORPUS_REL });
    expect(out).toContain('// landed via 061473ce7');
  });

  it('PRECISION: a narration merely QUOTING the refusal is never failure-shaped (anchored marker — no phantom streak on a successful read)', () => {
    expect(looksLikeToolFailure(`the lane hit "Tool read_file failed: ENOENT" and recovered via run_command`)).toBe(false);
  });
});
