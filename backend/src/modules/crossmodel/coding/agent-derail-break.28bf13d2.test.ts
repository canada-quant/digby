/**
 * Replay pin — ticket 28bf13d2 (mishap, auto-filed at breaker trip, session
 * 0037460b-d239-474e-bd32-5fe3ec52d820 "Hue backlog lane", run
 * 652f17bd-a6c1-4274-b655-5d6ec091d4ee; FIRST streak this run; the lane's
 * reasoning named glob).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak: read_file'
 * mishap (ticket title renders the chat-title fragment 'Decrypt-by-play
 * BATCHING (KEK ladder · V…') with two failure texts (newest first), byte-identical to:
 *   `Tool read_file failed: ENOENT: no such file or directory, open
 *    '/app/coding-workspaces/worktrees/0037460b-d239-474e-bd32-5fe3ec52d820/
 *    scratch/deploy/SUMMARIES-RESTORE-2026-10-16.md'`
 *   `Tool read_file failed: ENOENT: no such file or directory, open
 *    '/app/coding-workspaces/worktrees/0037460b-d239-474e-bd32-5fe3ec52d820/
 *    systemd/summary-sync-r1.sh'`
 * Call args (newest first): {"path":"scratch/deploy/SUMMARIES-RESTORE-2026-10-16.md"},
 * {"path":"systemd/summary-sync-r1.sh"} — UNRANGED, TWO DIFFERENT paths (the
 * 9cc62eef hallucinated-path pin read ONE flat path; this ticket read two).
 *
 * WHAT ACTUALLY HAPPENED (adjudicated 2026-10-18, all evidence fresh):
 *  1. BOTH PATHS ARE REAL — on canada-quant/schooltime MAIN (this lane's
 *     project repo, NOT crossmodel): both introduced by commit
 *     e737907bdfbf0c05cf0443b910c0378d2c6d3001 (PR #58 "Restore
 *     /admin/summaries on r-1: re-import + hourly refresh re-arm + Week-6
 *     tutor-edit digest", merged 2026-10-16T21:24:40Z from SIBLING lane
 *     branch digby/session-1c2b28d6; GitHub compare e737907b...main →
 *     'ahead' ⇒ ancestor of main — read 2026-10-18).
 *  2. STALE-BRANCH surface (the 14d62f53 class, cross-lane variant): the
 *     failing session's own branch digby/session-0037460b diverged from main
 *     at merge-base 686f8f54f2 (2026-10-16T00:15:32Z) — 21h BEFORE PR #58
 *     merged — and its worktree (base file mtimes 2026-10-15 19:10) never
 *     contained either file. systemd/ holds only the hue-* units (dir mtime
 *     Oct 9 23:56); scratch/deploy/ only the deckpose/DNS artifacts (dir
 *     mtime Oct 16 02:18 — also pre-trip, and a create+delete at the 06:09Z
 *     trip would have bumped it past 06:09). So the files were never THERE,
 *     not deleted mid-run. The names came from the supervisor dispatch
 *     itself (msg bec369fa, 06:06:02Z: "the r-1 hourly summary-sync … the
 *     same pickup path the Oct 8/9 dailies used") — the model knew the
 *     artifacts existed in the PROJECT and constructed the plausible repo
 *     paths instead of globbing first (its own reasoning named glob).
 *  3. ROOT CAUSE: model behavior on a stale branch — a correct-name /
 *     wrong-branch read. 14d62f53 was the same class via chain-from-prior
 *     provisioning (a NEW lane inheriting an old branch); this variant is a
 *     LONG-LIVED lane (since Oct 5) whose branch simply predates a sibling
 *     lane's main landing. Both ride the documented session-branch isolation
 *     seam — auto-rebasing a live lane onto mid-flight main is NOT a fix
 *     (it would corrupt in-flight work), and softening the ENOENT would
 *     contradict the 14d62f53 / 14739e76 / 9cc62eef pins — do NOT do it.
 *  4. TRIP MATH (why a "3×" ticket carries two texts): 2 same-tool failures
 *     + 1 intent-mismatch fast-trip weight (agent.ts fail-streak counter:
 *     reasoning named glob) = 3 → the FIRST trip; the filer
 *     (reflection.ts fileStreakInvestigation, NX-deduped per (session, tool)
 *     per 24h) rendered the default 'failure' shape with
 *     recentFailures.slice(0, 3) — two entries, newest first via unshift.
 *     Every deterministic seam behaved as designed: the honest ENOENT
 *     surface, the jail fallback naming the FAILING worktree's root, the
 *     args capture, the metadata.
 *  5. THE RUN RECOVERED (no derailment cost): run 652f17bd status
 *     'completed' 07:13:14Z (read 2026-10-18 via get_run_receipts), verify
 *     passed (receipt a9b88802), commits ae59b834 + 0eb03a38 pushed
 *     ancestry-verified, and the dispatched school-hours re-arm DELIVERED
 *     (the run's own final, msg f028f9ed). The first trip was a withhold +
 *     notice, not a run-end — the run ran on and finished (the recovery
 *     itself is not receipt-pinned; the completed status is).
 *  6. NO FRAMEWORK REGRESSION: `git log --oneline -8 origin/main --
 *     backend/src/modules/crossmodel/coding/tools.ts` (read 2026-10-18)
 *     shows the read_file surface untouched (#1742 credential-name notice
 *     in run_command; #1716 auth-401 logging; batch-train; isolation
 *     boundary — none touch read_file's error surface).
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR on a stale
 * branch — NO platform code change. Every deterministic seam behaved as
 * designed: the honest ENOENT surface, the jail fallback naming the worktree
 * path, the session-branch isolation that legitimately serves a base
 * predating a sibling lane's main landing, and the breaker's weighted trip +
 * auto-file with correct metadata (tool, session, run, intent-mismatch note).
 *
 * These tests pin that contract through the REAL executeCodingTool
 * (boundary mocks mirror agent-derail-break.14d62f53.test.ts, which mirrors
 * 9cc62eef/14739e76), plus the TWO-DIFFERENT-PATHS discriminator that keeps
 * this pin distinct from the one-path 9cc62eef class, and the breaker's
 * trip-math components.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Import-time boundary mocks — verbatim discipline from tools.test.ts /
// agent-derail-break.14d62f53.test.ts (the tools.ts import graph reaches
// config/env, which process.exit(1)s without env).
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
// prisma/rag) — carried forward verbatim from the 14d62f53/9cc62eef/14739e76
// set: those suites import the same module for looksLikeToolFailure, and this
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

// ── The incident's two paths (worktree-relative, exactly as the lane's
//    read_file calls carried them). Both are REAL files on
//    canada-quant/schooltime main since e737907b (PR #58, 2026-10-16 21:24Z);
//    the failing session's branch diverged 21h earlier and never had them.
//    They do NOT exist in THIS repo — the schooltime facts live in the header
//    as the adjudication record; the local replay below reproduces what
//    session 0037460b's worktree looked like to read_file. ──────────────────
const SYNC_SCRIPT = 'systemd/summary-sync-r1.sh';
const SUMMARIES_RESTORE = 'scratch/deploy/SUMMARIES-RESTORE-2026-10-16.md';

let STALE = '';

const mkCtx = (worktree: string): ToolContext => ({
  worktree, sessionId: 'sess-28bf13d2', userId: 'u1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
}) as unknown as ToolContext;

beforeAll(async () => {
  // The stale fixture mirrors session 0037460b's ACTUAL worktree shape (read
  // 2026-10-18): systemd/ with the hue-* units but NO summary-sync-r1.sh, and
  // scratch/deploy/ with the deckpose/DNS artifacts but NO
  // SUMMARIES-RESTORE-2026-10-16.md. The jail has no git checks, so this
  // plain dir is exactly what that checkout looked like to read_file.
  STALE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stale-wt-28bf13d2-')));
  await fs.mkdir(path.join(STALE, 'systemd'), { recursive: true });
  await fs.mkdir(path.join(STALE, 'scratch/deploy'), { recursive: true });
  // Sibling decoys that WERE present — pinning that the two dirs existed and
  // the incident was a MISSING FILE in an existing dir, not a missing dir.
  await fs.writeFile(path.join(STALE, 'systemd/hue-record.service'), '[Unit]\nDescription=hue record\n');
  await fs.writeFile(path.join(STALE, 'systemd/hue-record.timer'), '[Timer]\nOnCalendar=*-*-* 09..15:0/6\n');
  await fs.writeFile(path.join(STALE, 'scratch/deploy/DNS-ROLLBACK.md'), '# rollback notes\n');
});

afterAll(async () => {
  if (STALE) await fs.rm(STALE, { recursive: true, force: true });
});

describe('ticket 28bf13d2 — stale-branch read_file ENOENT streak (model behavior; both paths are real on schooltime main, the lane\'s branch predated them)', () => {
  it('REPLAY filed texts #1+#2 (two DIFFERENT paths, UNRANGED): read_file against a worktree shaped like session 0037460b\'s fails with the byte-exact incident surface — catch-all prefix + raw ENOENT + jail-resolved path of the FAILING worktree', async () => {
    // Newest first, exactly as the filer renders recentFailures.
    const outNew = await executeCodingTool(mkCtx(STALE), 'read_file', { path: SUMMARIES_RESTORE });
    const outOld = await executeCodingTool(mkCtx(STALE), 'read_file', { path: SYNC_SCRIPT });
    // The exact incident string shape (breaker trip): fs.readFile on a file
    // missing from the checkout throws ENOENT; the executeCodingTool
    // catch-all renders `Tool ${name} failed: ${err.message}` verbatim. A
    // byte-exact toBe is ALSO the no-softening pin — any appended guidance
    // breaks these assertions. Both incident calls carried only {path}.
    expect(outNew).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${STALE}/${SUMMARIES_RESTORE}'`);
    expect(outOld).toBe(`Tool read_file failed: ENOENT: no such file or directory, open '${STALE}/${SYNC_SCRIPT}'`);
  });

  it('the two filed texts differ byte-wise EXACTLY in the path segment — the TWO-DIFFERENT-PATHS discriminator that keeps this pin distinct from the one-path 9cc62eef hallucinated-flat-path class (the model constructed two plausible repo paths from the supervisor\'s named artifacts, it did not retry one invention)', async () => {
    const outNew = await executeCodingTool(mkCtx(STALE), 'read_file', { path: SUMMARIES_RESTORE });
    const outOld = await executeCodingTool(mkCtx(STALE), 'read_file', { path: SYNC_SCRIPT });
    const prefix = 'Tool read_file failed: ENOENT: no such file or directory, open ';
    expect(outNew.startsWith(prefix + `'${STALE}/`)).toBe(true);
    expect(outOld.startsWith(prefix + `'${STALE}/`)).toBe(true);
    expect(outNew).not.toBe(outOld);
    // Both targets sit in dirs that EXIST (with sibling files present) — a
    // missing-FILE-in-existing-dir ENOENT, not a missing-dir one: the
    // worktree was real, just on a branch that predated both files.
    for (const rel of [SUMMARIES_RESTORE, SYNC_SCRIPT]) {
      const dir = path.dirname(path.join(STALE, rel));
      const entries = await fs.readdir(dir);
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it('the failure names the JAIL-resolved absolute path of the stale worktree (resolveRealInside falls back to the lexical jail path for a not-yet-created file — the filed text names the FAILING session\'s own root, never the real file\'s location on main), and an outside-worktree absolute path hits the containment error — never an errno read of /etc', async () => {
    expect(resolveInside(STALE, SYNC_SCRIPT)).toBe(`${STALE}/${SYNC_SCRIPT}`);
    expect(resolveInside(STALE, SUMMARIES_RESTORE)).toBe(`${STALE}/${SUMMARIES_RESTORE}`);
    const out = await executeCodingTool(mkCtx(STALE), 'read_file', { path: '/etc/hostname' });
    expect(out).toMatch(/^Tool read_file failed: path is outside the worktree: \/etc\/hostname/);
  });

  it('breaker trip-math components — the rendered ENOENT texts are failure-shaped (the streak gate) and the filed "lane\'s reasoning named glob" note is the intent-mismatch weight: 2 same-tool failures + 1 intent-mismatch = 3 → the FIRST trip, exactly two filed texts', async () => {
    const failA = await executeCodingTool(mkCtx(STALE), 'read_file', { path: SYNC_SCRIPT });
    const failB = await executeCodingTool(mkCtx(STALE), 'read_file', { path: SUMMARIES_RESTORE });
    // Component 1 — the streak counter only sees failure-shaped results
    // (learnings-index.service FAILURE_MARKERS[0]: /^Tool \S+ failed:/).
    expect(looksLikeToolFailure(failA)).toBe(true);
    expect(looksLikeToolFailure(failB)).toBe(true);
    // Component 2 — the +1 intent-mismatch weight: the ticket's filed
    // metadata ("lane's reasoning named glob") is
    // detectIntendedTool(narration, 'read_file', offered) === 'glob' —
    // narration names ANOTHER offered tool as a whole word and never names
    // the called one. (Representative narration; the verbatim reasoning
    // lives in chat 0037460b's transcript — the filed note is the source of
    // record.) The narration mirrors the incident: the supervisor dispatch
    // named the summary-sync/pickup-path artifacts, and the lane announced
    // it would glob for them — then read_file'd constructed paths instead.
    const OFFERED = ['read_file', 'list_dir', 'glob', 'grep', 'search_memory', 'search_code_semantic', 'run_command'];
    const incidentNarration =
      'The supervisor says the r-1 hourly summary-sync imports from the dailies pickup path. I should glob the repo for the summary-sync unit and the summaries-restore record before touching anything.';
    expect(detectIntendedTool(incidentNarration, 'read_file', OFFERED)).toBe('glob');
    // Asymmetry pin: narrating the CALLED tool convicts NOTHING — a truthful
    // lane that says what it calls is never fast-tripped by this weight.
    expect(detectIntendedTool('Let me read_file the summary-sync script to check its schedule.', 'read_file', OFFERED)).toBeNull();
  });

  it('control: read_file on a file that IS present in the stale-shaped worktree SUCCEEDS — the ENOENTs were specific to the two branch-missing files, not a broken worktree or a poisoned jail', async () => {
    const out = await executeCodingTool(mkCtx(STALE), 'read_file', { path: 'scratch/deploy/DNS-ROLLBACK.md' });
    expect(out).not.toMatch(/^Tool read_file failed:/);
    expect(out).toContain('rollback notes');
  });
});
