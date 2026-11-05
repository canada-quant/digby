/**
 * Phase 2 LEG 2a — worker-side run executor: lock/requeue, claim classification,
 * crash-safe input consumption, resume wiring (resumeFrom + harness notice), and
 * finalize semantics (completed / cancelled / interrupted / attempts-exhausted).
 *
 * Prisma + Redis are mocked with small in-memory stand-ins so the REAL
 * run-state / run-claim / session-run-lock modules execute; only the agent,
 * the data service, the workspace/token seams, and the title LLM are stubbed.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Redis: in-memory stand-in (the real lock/cancel/resolve channels run against it). ──
const mockStore = new Map<string, string>();
const mockLists = new Map<string, string[]>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: any) => {
      if (opts?.NX && mockStore.has(k)) return null; // real NX semantics: held lock → acquire fails
      mockStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
    exists: jest.fn(async (k: string) => (mockStore.has(k) ? 1 : 0)),
    expire: jest.fn(async () => true),
    // cff523e7: the provider-failure counter (schedule.service) rides INCR.
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    rPush: jest.fn(async (k: string, v: string) => {
      const l = mockLists.get(k) ?? [];
      l.push(v);
      mockLists.set(k, l);
      return l.length;
    }),
    lPop: jest.fn(async (k: string) => {
      const l = mockLists.get(k) ?? [];
      const v = l.shift();
      if (l.length) mockLists.set(k, l); else mockLists.delete(k);
      return v ?? null;
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const l = mockLists.get(k) ?? [];
      const len = l.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      mockLists.set(k, l.slice(s, e + 1));
      return 'OK';
    }),
  },
}));

const mockPrisma: any = {
  crossModelMessage: {
    create: jest.fn(async () => ({ id: 'msg-new' })),
    update: jest.fn(async () => ({})),
    count: jest.fn(async () => 1), // never the opening turn unless a case overrides
    findMany: jest.fn(async () => []),
  },
  crossModelChat: { findUnique: jest.fn(async () => ({ userId: 'u1' })) },
  agentRun: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
    // Ticket 65af5656: the lease guard reads the row back before releasing a
    // run on a 0-row heartbeat. Default: the row still EXISTS (a racing status
    // flip) → stand down, never cancel. A test that really wants the zombie
    // path overrides this with null (the row is genuinely gone).
    findUnique: jest.fn(async (): Promise<any> => ({ status: 'running' })),
  },
  agentEvent: { create: jest.fn(async () => ({})), aggregate: jest.fn(async () => ({ _max: { seq: 0 } })) },
  // cff523e7: the provider-fail threshold flips coding_schedules.lastStatus.
  // fbe65673: the claim-time stale-firing re-check reads the row — default
  // ENABLED so schedule-linked runs proceed; the guard's own tests override.
  chatSchedule: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async (): Promise<any> => ({ enabled: true })),
    // audit #2: the continuation backstop's pending once-schedule dedupe count.
    count: jest.fn(async (): Promise<number> => 0),
    // v1#33 deadline: the REAL computeMachineRunDeadlineMs reads enabled
    // recurring rows — none ⇒ the 20-min floor, deterministically.
    findMany: jest.fn(async (): Promise<any[]> => []),
  },
  // audit #8: the REAL run-state's fenced writeCheckpoint rides $executeRaw.
  $executeRaw: jest.fn(async () => 1),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGenerateTitle: jest.Mock = jest.fn(async () => 'Generated Title');
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: (...args: any[]) => mockGenerateTitle(...args) },
}));

const mockRunCodingAgent: jest.Mock = jest.fn();
jest.mock('./agent', () => ({ runCodingAgent: (...args: any[]) => mockRunCodingAgent(...args) }));

// Stranded-steer recovery (58790b7b/6a99225c) — pinned invocation sites only;
// the helper itself is unit-tested in steer-recovery.test.ts.
const mockRecoverStrandedSteers: jest.Mock = jest.fn(async () => false);
jest.mock('./steer-recovery', () => ({
  __esModule: true,
  recoverStrandedSteers: (...a: any[]) => mockRecoverStrandedSteers(...a),
}));

const mockReattachWorktree: jest.Mock = jest.fn(async () => '/tmp/wt-reattached');
const mockIsUsableWorktree: jest.Mock = jest.fn(async () => true);
// a086c69d: the mocked workspace.service must keep exporting the volume-ownership
// probe (platform.service's provision gate destructures it via dynamic import);
// default true = "this box owns the volume" so run-executor behavior is unchanged.
const mockIsWorkspaceVolumeOwner: jest.Mock = jest.fn(async () => true);
// FO 2026-09-23 cross-box fix: the blank self-heal rebuilds the standalone repo
// on the claiming worker — observable at the workspace seam.
const mockEnsureBlankWorktree: jest.Mock = jest.fn(async () => '/tmp/wt-blank-new');
// audit #8: the onCheckpoint git-snapshot seam — observable for the throttle tests.
const mockSnapshotWorktreeGitState: jest.Mock = jest.fn(async (): Promise<any> => ({ branch: 'digby/x', wip: 'wipsha1' }));
jest.mock('./workspace.service', () => ({
  reattachWorktree: (...args: any[]) => mockReattachWorktree(...args),
  isUsableWorktree: (...args: any[]) => mockIsUsableWorktree(...args),
  snapshotWorktreeGitState: (...args: any[]) => mockSnapshotWorktreeGitState(...args),
  ensureBlankWorktree: (...args: any[]) => mockEnsureBlankWorktree(...args),
  repoMirrorPath: (id: string) => `/repos/${id}.git`,
  isWorkspaceVolumeOwner: (...args: any[]) => mockIsWorkspaceVolumeOwner(...args),
}));
// The re-provision path dynamically imports the scaffolding seam; stub it so the
// (l) case doesn't pull the real module's import graph into the suite.
jest.mock('./scaffolding.service', () => ({ ensureProjectDocs: jest.fn(async () => ({})) }));
jest.mock('../github/token-manager', () => ({ getValidToken: jest.fn(async () => 'tok') }));
jest.mock('fs/promises', () => ({ access: jest.fn(async () => undefined), stat: jest.fn(async () => undefined) })); // worktree exists (stat: the i10 heal's mirror probe)
// The i10 local-mirror self-heal dynamically imports project-workspace.service;
// stub it so no test pulls the real module's prisma/import graph.
const mockEnsureProvisioned: jest.Mock = jest.fn(async () => '/repos/p1.git');
jest.mock('./project-workspace.service', () => ({
  __esModule: true,
  ensureProvisioned: (...args: any[]) => mockEnsureProvisioned(...args),
}));

// Fleet supervisor (slice B): finalize emits run_completed/run_failed +
// clears the wake-depth stamp via a fire-and-forget dynamic import — mocked
// at the module boundary (the real module's chain reaches config/env, which
// exits the jest worker at import).
const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockClearHookDepth: jest.Mock = jest.fn(async () => {});
// cff523e7: schedule.service's own emission seam (provider-fail attention event)
// calls emitHookEvent on the same module.
const mockEmitHookEvent: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  clearHookDepth: (...a: any[]) => mockClearHookDepth(...a),
}));

// Run journal (cross-run memory): fired fire-and-forget from the finalize
// seam — mocked at the module boundary (the real module reaches prisma +
// the utility LLM).
const mockWriteRunJournalEntryAsync: jest.Mock = jest.fn();
const mockWriteGuardVerdictEntryAsync: jest.Mock = jest.fn();
const mockWriteAttemptsExhaustedEntryAsync: jest.Mock = jest.fn();
const mockWriteProbeMissEntryAsync: jest.Mock = jest.fn();
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  writeRunJournalEntryAsync: (...a: any[]) => mockWriteRunJournalEntryAsync(...a),
  writeGuardVerdictEntryAsync: (...a: any[]) => mockWriteGuardVerdictEntryAsync(...a),
  writeAttemptsExhaustedEntryAsync: (...a: any[]) => mockWriteAttemptsExhaustedEntryAsync(...a),
  writeProbeMissEntryAsync: (...a: any[]) => mockWriteProbeMissEntryAsync(...a),
}));

// Coding memory fold (2026-08-30 phantom-recurrence fix): moved from agent.ts
// to the executor finalize so it sees the POST-guard text — mocked at the
// module boundary like the journal service (the real module reaches prisma +
// the utility LLM via context-store).
const mockUpdateCodingMemoryAsync: jest.Mock = jest.fn();
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  updateCodingMemoryAsync: (...a: any[]) => mockUpdateCodingMemoryAsync(...a),
}));

// Plan-store guard-strike marker (2026-08-30 recurrence fix H1): the guard
// seam dynamic-imports plan.service to mark/clear the strike — mocked at the
// boundary; the PURE prompt builders (continuationPrompt et al.) run real.
// audit #2: getPlan is mocked too (default null — identical to the real one's
// error-swallow against this suite's store-less prisma) so the continuation
// fast-lane tests can hand the backstop an unfinished plan board.
const mockMarkPlanGuardStrike: jest.Mock = jest.fn(async () => {});
const mockClearPlanGuardStrike: jest.Mock = jest.fn(async () => {});
const mockGetPlan: jest.Mock = jest.fn(async (): Promise<any> => null);
// agent-decisions prerequisite 5 (2026-09-27): the claim-time continuation guard
// reads the STRICT plan reader (errors propagate = "unknown", never a skip).
// Default REJECTS — identical to the real reader against this suite's
// store-less prisma — so every pre-existing case keeps its identity.
const mockGetPlanStrict: jest.Mock = jest.fn(async (): Promise<any> => { throw new Error('store-less suite'); });
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...jest.requireActual('./plan.service'),
  markPlanGuardStrike: (...a: any[]) => mockMarkPlanGuardStrike(...a),
  clearPlanGuardStrike: (...a: any[]) => mockClearPlanGuardStrike(...a),
  getPlan: (...a: any[]) => mockGetPlan(...a),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

// Continuation fast-lane (audit #2): the backstop's two queueing lanes are
// mocked at the schedule.service boundary — queueContinuationRun (fast lane)
// and createSchedule (legacy fallback) — while everything else in the module
// (recordScheduleProviderFail et al., exercised by the provider-killed tests)
// stays REAL via requireActual.
const mockQueueContinuationRun: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, runId: 'cont-1' }));
const mockHasQueuedContinuationRun: jest.Mock = jest.fn(async () => false);
const mockCreateScheduleFallback: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, schedule: { intervalSec: 900 } }));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  ...jest.requireActual('./schedule.service'),
  queueContinuationRun: (...a: any[]) => mockQueueContinuationRun(...a),
  hasQueuedContinuationRun: (...a: any[]) => mockHasQueuedContinuationRun(...a),
  createSchedule: (...a: any[]) => mockCreateScheduleFallback(...a),
}));

// Run tool receipts (anti-confabulation evidence channel): the executor unions
// prior attempts' durable rows with the in-process collector at the guard seam —
// mocked at the module boundary like the run-journal service (the real module
// reaches prisma).
const mockGetRunReceipts: jest.Mock = jest.fn(async () => []);
// CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27): earlier runs' receipts for
// the chat — default empty (the tier is inert), overridden per case.
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => []);
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  getRunReceipts: (...a: any[]) => mockGetRunReceipts(...a),
  getRecentChatReceipts: (...a: any[]) => mockGetRecentChatReceipts(...a),
  // fb64368a round 2: both STRICT variants ride the same mock fns — the
  // executor's seams call these, so per-test overrides hit the live path.
  getRunReceiptsStrict: (...a: any[]) => mockGetRunReceipts(...a),
  getRecentChatReceiptsStrict: (...a: any[]) => mockGetRecentChatReceipts(...a),
}));

// The guard-verdict integrity ticket (two-lane hardening) files through the
// feedback service via a fire-and-forget dynamic import — mocked at the
// boundary (the real module's chain reaches middleware/error-handler →
// config/env → process.exit in a keyless test env).
const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a),
}));

// Attribution on conviction: the guard REPLACE lane files the reflection
// module's framework-vs-model investigation ticket via a fire-and-forget
// dynamic import — mocked at the boundary (the real module reaches prisma +
// redis directly).
const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => {});
// Ticket 78f32515: the breaker lane notice's consume seam — default null (no
// pending notice) so every pre-existing schedulerNotice case is unaffected.
const mockConsumeBreakerLaneNotice: jest.Mock = jest.fn(async () => null);
jest.mock('./reflection', () => ({
  __esModule: true,
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  consumeBreakerLaneNotice: (...a: any[]) => mockConsumeBreakerLaneNotice(...a),
}));

// Loop-metrics telemetry (audit #12 close-out): the finalize guard emits
// guard_strike/guard_miss and the continuation fallback emits wake_delivered —
// mocked so no real buffer/DB path loads and the wiring is assertable.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', SCHEDULE_CONTINUATION_SKIP: 'schedule_continuation_skip',
    CONTINUATION_SUPPRESSED: 'continuation_suppressed',
    TRANSIENT_RESUME: 'transient_resume',
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    CODING_MEMORY_INJECTED: 'coding_memory_injected',
    DEGENERATE_FINAL: 'degenerate_final',
    BLANK_PROVISION_DEFERRED: 'blank_provision_deferred', BLANK_PROVISION_SELFHEAL: 'blank_provision_selfheal',
    LOCAL_MIRROR_SELFHEAL: 'local_mirror_selfheal',
  },
}));

// Run-start PROJECT MEMORY injection (owner 2026-09-14): the executor searches
// the project scope over the task text via coding-retrieval.service — mocked at
// the boundary (the real module reaches rag.service → utility-llm → config/env,
// which exits the jest worker at import). Default: nothing found → no block.
const mockSearchMemory: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: (...a: any[]) => mockSearchMemory(...a),
}));

// OWNER-DIRECTIVE-FANOUT (2026-10-20): the lane run-start [OWNER DIRECTIVES IN
// FORCE] block — mocked at the module boundary (the real builder reads every
// supervisor ledger). Default: nothing in force → no block.
const mockBuildOwnerDirectives: jest.Mock = jest.fn(async (): Promise<any> => ({ block: '', shown: [], hidden: 0 }));
const mockRecordOwnerDirectiveDelivered: jest.Mock = jest.fn();
jest.mock('../platform/owner-directive-fanout', () => ({
  __esModule: true,
  buildOwnerDirectivesInForceBlock: (...a: any[]) => mockBuildOwnerDirectives(...a),
  recordOwnerDirectiveDelivered: (...a: any[]) => mockRecordOwnerDirectiveDelivered(...a),
}));

// Finalize → memory pipeline (owner 2026-09-14: project decisions from coding
// finals): updateContextAsync is reached through a fire-and-forget dynamic
// import — mocked at the module boundary (the real module's static chain is
// context.service + the utility LLM).
const mockUpdateContextAsync: jest.Mock = jest.fn();
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  updateContextAsync: (...a: any[]) => mockUpdateContextAsync(...a),
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })),
}));

// Phantom-fabrication evidence guard (feedback be0b5271): runs at the finalize
// seam — the NETWORKED entry (applyCompletionClaimGuard reaches the GitHub
// token manager + global fetch) is mocked; the PURE helpers the executor also
// pulls from this module (verdictHasFindings / renderSuppressedFinal /
// summarizeGuardVerdict — the be199e93 replace lane) run REAL via
// requireActual. Default = pass-through; the (p)/(q)/(r) cases override.
const mockApplyCompletionClaimGuard: jest.Mock = jest.fn();
jest.mock('./run-evidence-guard', () => ({
  __esModule: true,
  ...jest.requireActual('./run-evidence-guard'),
  applyCompletionClaimGuard: (...a: any[]) => mockApplyCompletionClaimGuard(...a),
}));

const mockGetSessionForUser: jest.Mock = jest.fn();
const mockUpdateSessionState: jest.Mock = jest.fn(async () => {});
const mockTouchChat: jest.Mock = jest.fn(async () => {});
// Ticket b6acc1e3: the run-time project-codingModel override seams. Default =
// no project pick → the stamped model stands (pre-existing cases unaffected);
// the override/skip cases below set per-test values.
const mockProjectCodingModel: jest.Mock = jest.fn(async () => null);
const mockResolveOneCodingPick: jest.Mock = jest.fn(async () => null);
// P5-A transcript helpers the merged executor imports (dual-write seam). The
// count default is 1 — never the opening turn unless a case overrides it.
const mockAppendCodingMessage: jest.Mock = jest.fn(async () => ({ id: 'msg-new' }));
const mockUpdateCodingMessage: jest.Mock = jest.fn(async () => ({}));
const mockListRecentCodingTranscript: jest.Mock = jest.fn(async () => []);
const mockCountCodingTranscriptMessages: jest.Mock = jest.fn(async () => 1);
// Title-repair helpers: defaults keep the repair branch inert (proper title, no
// first user message); the (j)/(k) cases override. Re-established in beforeEach.
const mockGetCodingSessionTitle: jest.Mock = jest.fn(async () => 'A proper existing title');
const mockGetFirstUserCodingMessage: jest.Mock = jest.fn(async () => null);
// Ticket 161d39e9: title PROVENANCE — NULL default = the derive path keeps its
// pre-column behavior for every existing case; the provenance cases below
// override (the executor's sticky gate keys on 'spawn-param').
const mockGetCodingSessionTitleSource: jest.Mock = jest.fn(async () => null);
// Seats govern sessions (2026-09-28): run-executor resolves the coding_default SEAT live
// through coding/seat-governance.ts → coding-model resolveRoleModelForRun. The suite's
// baseline seat equals the fixture's stamp ('kimi') so every pre-existing expectation
// holds; the governance cases below move the seat. Provenance / prefs come from the
// coding-data mock (no source → legacy) and the prisma mock (no userPreferences → the
// preference step is fail-open, i.e. no pick).
const mockResolveRoleModelForRun: jest.Mock = jest.fn(async (_role: string, _fallback: string) => 'kimi');
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: (...args: any[]) => mockResolveRoleModelForRun(...args),
}));
jest.mock('./coding-data.service', () => ({
  getSessionForUser: (...args: any[]) => mockGetSessionForUser(...args),
  updateSessionState: (...args: any[]) => mockUpdateSessionState(...args),
  touchChat: (...args: any[]) => mockTouchChat(...args),
  // Ticket b6acc1e3: run-executor's project override dynamically imports these.
  projectCodingModel: (...args: any[]) => mockProjectCodingModel(...args),
  resolveOneCodingPick: (...args: any[]) => mockResolveOneCodingPick(...args),
  appendCodingMessage: (...args: any[]) => mockAppendCodingMessage(...args),
  updateCodingMessage: (...args: any[]) => mockUpdateCodingMessage(...args),
  listRecentCodingTranscript: (...args: any[]) => mockListRecentCodingTranscript(...args),
  countCodingTranscriptMessages: (...args: any[]) => mockCountCodingTranscriptMessages(...args),
  getCodingSessionTitle: (...args: any[]) => mockGetCodingSessionTitle(...args),
  getFirstUserCodingMessage: (...args: any[]) => mockGetFirstUserCodingMessage(...args),
  getCodingSessionTitleSource: (...args: any[]) => mockGetCodingSessionTitleSource(...args),
}));

// 7f546b03: the input-consumption seam stages input.images AND input.files via
// attachments.service — mocked at the boundary (this suite's fs/promises mock
// only stubs `access`; the real staging would degrade to empty notes anyway).
// Defaults: nothing staged — pre-existing tests keep their bare userMessage.
const mockStageAndDescribe: jest.Mock = jest.fn(async () => ({ staged: [], note: '' }));
const mockStageFilesAndDescribe: jest.Mock = jest.fn(async () => ({ staged: [], note: '' }));
jest.mock('./attachments.service', () => ({
  stageAndDescribe: (...args: any[]) => mockStageAndDescribe(...args),
  stageFilesAndDescribe: (...args: any[]) => mockStageFilesAndDescribe(...args),
}));

// audit 2026-10-06 T7-1 / T7-9 / T7-10: the lane-todo seams (lane-todos.ts —
// unit-tested in lane-todos.test.ts) are mocked at the module boundary; the
// defaults are inert (no new work, nothing promoted, no continuation).
const mockFiringStartsNewWork: jest.Mock = jest.fn(async (): Promise<any> => ({ newWork: false, todoIds: [] }));
const mockPromoteLaneTodos: jest.Mock = jest.fn(async (): Promise<string[]> => []);
const mockMaybeStartNextLaneTodo: jest.Mock = jest.fn(async (): Promise<string> => 'no_todo');
// audit 2026-10-08 W5-4: the run-end plan close runs first; 'wake_sent' skips the next-todo continuation.
const mockCloseLaneTodosOnPlanComplete: jest.Mock = jest.fn(async (): Promise<string> => 'no_plan');
jest.mock('./lane-todos', () => ({
  __esModule: true,
  firingStartsNewWork: (...a: any[]) => mockFiringStartsNewWork(...a),
  machineFiringNewWorkDisabled: () => process.env.MACHINE_FIRING_NEW_WORK_DISABLED === '1',
  promoteLaneTodosAtRunStart: (...a: any[]) => mockPromoteLaneTodos(...a),
  maybeStartNextLaneTodo: (...a: any[]) => mockMaybeStartNextLaneTodo(...a),
  closeLaneTodosOnPlanComplete: (...a: any[]) => mockCloseLaneTodosOnPlanComplete(...a),
}));

// audit 2026-10-06 T7-4: the hand-off is observable at its safe wrapper (the
// real module's selectors run; the orchestration is unit-tested in
// deliverable-handoff*.test.ts). Default: nothing posted (null) — identical to
// the real wrapper against this suite's store-less prisma.
const mockRunDeliverableHandoffSafe: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('./deliverable-handoff', () => ({
  __esModule: true,
  ...jest.requireActual('./deliverable-handoff'),
  runDeliverableHandoffSafe: (...a: any[]) => mockRunDeliverableHandoffSafe(...a),
}));

// audit 2026-10-06 T7-8: the run-end unpushed-commits seam (unit-tested in
// unpushed-commits.test.ts) — default: nothing unpushed.
const mockUnpushedAtRunEnd: jest.Mock = jest.fn(async (): Promise<any> => ({ line: null, state: null }));
jest.mock('./unpushed-commits', () => ({
  __esModule: true,
  unpushedCommitsAtRunEnd: (...a: any[]) => mockUnpushedAtRunEnd(...a),
}));

import {
  executeClaimedRun, TITLE_GEN_WAIT_MS,
  formatProjectMemoryBlock, buildProjectMemoryInjection,
  PROJECT_MEMORY_HEADER, PROJECT_MEMORY_BLOCK_CAP_CHARS, PROJECT_MEMORY_ITEM_EXCERPT_CHARS, PROJECT_MEMORY_MIN_SCORE,
  titleSeedFromMessage,
} from './run-executor';
import { GUARD_CHROME_PLACEHOLDER } from '../guard-chrome-redact';
// The redact lane's stand-ins run REAL here (the guard module mock spreads
// requireActual — only applyCompletionClaimGuard is stubbed).
import { REDACTED_CLAIM_LINE, REDACTED_CLOCK_LINE } from './run-evidence-guard';
import type { ClaimedRun } from './run-claim';
import { ATTEMPTS_CAP, RunCheckpoint, resumeAssistantMsgId } from './run-state';
// The schedule.service mock spreads requireActual — the deadline constant is real.
import { MACHINE_RUN_DEADLINE_FLOOR_MS } from './schedule.service';
import { cancelRun, markRunShutdownInterrupted } from './live-runs';
import { requestRunCancel, publishApprovalResolution, publishQuestionResolution, pushSteerMessage } from './session-run-lock';
import { awaitApproval } from './approval-registry';
import { awaitAnswer } from './question-registry';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

/** The mocked redis client's `set` — acquireSessionRunLock's only observable channel. */
const redisSet = () => redisClient.set as unknown as jest.Mock;

const CP: RunCheckpoint = {
  version: 1,
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  step: 3, stepBudget: 200, phase: 'preModel',
  compactionCount: 0, modelErrored: false, modelErrorRecoveries: 0, repetitionRetries: 0,
  leakRetries: 0, autoContinueRounds: 0, autoVerifyIters: 0, lastPlanSig: '',
  lastContinueDiffHash: '', continueStalls: 0, selfAudited: false, lastToolSig: '',
  repeatCount: 0, runStartedAt: 1700000000000, deadlineOffsetMs: 0,
  recentDiffHashes: [], failureSigCounts: {}, usageRunId: 'rABC',
};

const LOCK_KEY = 'coding:session:run:s1';

const makeClaim = (over: Partial<ClaimedRun> = {}): ClaimedRun => ({
  id: 'run1',
  sessionId: 's1',
  preStatus: 'queued',
  checkpoint: null,
  input: { message: 'build it', userId: 'u1' },
  attempts: 1,
  inputConsumed: false,
  lastError: null,
  ...over,
});

const SESSION: any = {
  id: 's1', projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/x', baseBranch: 'main',
  worktreePath: '/tmp/wt', permissionMode: 'auto', model: 'kimi', status: 'running',
  errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  project: {
    id: 'p1', userId: 'u1', name: 'proj', repoUrl: 'https://github.com/o/r', defaultBranch: 'main',
    provider: 'github', githubLabel: null, folderId: null, createdAt: new Date(), updatedAt: new Date(),
  },
};

/** The agentRun.update call that finalized the row (has a terminal status + finishedAt). */
const finalizeCall = () =>
  mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.finishedAt instanceof Date);

// Gate flip 2026-09-11 (owner: full steam): the evidence guard's reject-back +
// REDACT/REPLACE lanes are OBSERVE-ONLY by default; EVIDENCE_GUARD_ENFORCE=1
// re-arms them and QUOTE_GUARD_ENFORCE=1 re-arms the fabricated_quote class.
// Every case starts with both UNSET (the production default); the legacy
// enforce-mode pins set EVIDENCE_GUARD_ENFORCE inline.
// Sibling flip from the same wave that this suite also pins in enforce mode:
// RUN_DEADLINE_ENABLED=1 (the v1#33 deadline-anchoring cases).
const FLIP_ENV_KEYS = ['EVIDENCE_GUARD_ENFORCE', 'QUOTE_GUARD_ENFORCE', 'RUN_DEADLINE_ENABLED'] as const;
const SAVED_FLIP_ENV: Record<string, string | undefined> = Object.fromEntries(FLIP_ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of FLIP_ENV_KEYS) {
    if (SAVED_FLIP_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_FLIP_ENV[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // Seats govern sessions (2026-09-28): baseline seat == the fixture stamp; no kill switch.
  mockResolveRoleModelForRun.mockReset();
  mockResolveRoleModelForRun.mockResolvedValue('kimi');
  delete process.env.SEAT_GOVERNS_SESSIONS_DISABLED;
  for (const k of FLIP_ENV_KEYS) delete process.env[k];
  mockStore.clear();
  mockLists.clear();
  mockGetSessionForUser.mockResolvedValue(SESSION);
  SESSION.worktreePath = '/tmp/wt'; // the re-provision path mutates the shared fixture in place
  mockSnapshotWorktreeGitState.mockResolvedValue({ branch: 'digby/x', wip: 'wipsha1' });
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockGetCodingSessionTitle.mockResolvedValue('A proper existing title');
  mockGetFirstUserCodingMessage.mockResolvedValue(null);
  mockGetCodingSessionTitleSource.mockResolvedValue(null);
  mockGenerateTitle.mockImplementation(async () => 'Generated Title');
  mockReattachWorktree.mockResolvedValue('/tmp/wt-reattached');
  mockIsUsableWorktree.mockResolvedValue(true);
  mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'done', parts: [{ type: 'text', text: 'done' }] }));
  mockApplyCompletionClaimGuard.mockImplementation(async (opts: any) => ({ finalText: opts.finalText, notes: [] }));
  mockGetRunReceipts.mockResolvedValue([]);
  mockStageAndDescribe.mockResolvedValue({ staged: [], note: '' });
  mockStageFilesAndDescribe.mockResolvedValue({ staged: [], note: '' });
  // Continuation backstop defaults (audit #2): no plan board → the backstop is
  // inert for every pre-existing case; the fast-lane tests override getPlan.
  mockGetPlan.mockResolvedValue(null);
  mockQueueContinuationRun.mockResolvedValue({ ok: true, runId: 'cont-1' });
  mockHasQueuedContinuationRun.mockResolvedValue(false);
  mockCreateScheduleFallback.mockResolvedValue({ ok: true, schedule: { intervalSec: 900 } });
  // Project-memory injection default: nothing retrieved → no block, pre-existing
  // cases keep their bare injectSystem semantics.
  mockSearchMemory.mockResolvedValue([]);
  // Owner-directive fan-out default: nothing in force → no block.
  mockBuildOwnerDirectives.mockResolvedValue({ block: '', shown: [], hidden: 0 });
});

describe('executeClaimedRun', () => {
  it('(a) lock held by another worker → requeue the row, never execute (H1: attempts compensated + not-before backoff)', async () => {
    mockStore.set(LOCK_KEY, 'other-worker');
    await executeClaimedRun(makeClaim());

    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    const requeue = mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'queued');
    expect(requeue?.[0].where).toEqual({ id: 'run1' });
    expect(requeue?.[0].data).toMatchObject({ status: 'queued', workerId: null, heartbeatAt: null });
    // H1 compensation: lock contention is not an attempt…
    expect(requeue?.[0].data.attempts).toEqual({ decrement: 1 });
    // …and the row backs off ~15 s (not-before) instead of spinning the claim tick.
    expect(requeue?.[0].data.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
  });

  it('(b) fresh run: consumes the input (insert + markInputConsumed), runs, finalizes completed', async () => {
    await executeClaimedRun(makeClaim());

    // User message inserted (crash-safe) then marked consumed (guarded).
    // P5-A: the insert goes through the dual-writing data-service helper.
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'build it',
    }));
    expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run1', inputConsumedAt: null },
    }));

    // Agent input assembled like the controller's: plain message, no resume.
    expect(mockRunCodingAgent).toHaveBeenCalledTimes(1);
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.userMessage).toBe('build it');
    expect(input.resumeFrom).toBeUndefined();
    expect(input).toMatchObject({
      worktree: '/tmp/wt', sessionId: 's1', projectId: 'p1', userId: 'u1',
      permissionMode: 'auto', model: 'kimi', projectName: 'proj', branch: 'digby/x',
      repoUrl: 'https://github.com/o/r', provider: 'github', baseBranch: 'main',
    });
    expect(typeof input.onCheckpoint).toBe('function');
    expect(typeof input.injectSystem).toBe('function');

    // Finalize: completed (checkpoint nulled by run-state), no error.
    expect(finalizeCall()?.[0].where).toEqual({ id: 'run1' });
    expect(finalizeCall()?.[0].data.status).toBe('completed');
    expect(finalizeCall()?.[0].data).not.toHaveProperty('error');

    // Session back to ready + the run lock released.
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockStore.has(LOCK_KEY)).toBe(false);

    // Fleet supervisor (§3): finalize emitted run_completed (fire-and-forget —
    // flush the dynamic-import microtask chain) + cleared the wake-depth stamp.
    await new Promise((r) => setImmediate(r));
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      's1', 'run_completed', expect.stringContaining('Coding run completed'), { runId: 'run1' },
    );
    expect(mockClearHookDepth).toHaveBeenCalledWith('s1');
  });

  // Ticket b6acc1e3 — run-time interaction of the explicit start_coding_session
  // `model` param: a session stamped by an explicit spawn-time pick
  // (chatCodingState.modelSource 'spawn-param') keeps its model — the
  // 2026-09-04 project-codingModel override would silently re-route it back to
  // the very route the spawner routed AROUND (the 2026-09-17 kimi-k3 billing
  // 429 the ticket's spawn d4ab649b died on). Default-stamped sessions keep
  // the override byte-identically (the owner ask it implements is untouched).
  it('(b6a) spawn-param session: the project pick is never consulted — the explicit spawn model runs', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, model: 'glm-5.3', modelSource: 'spawn-param' });
    mockProjectCodingModel.mockResolvedValue('kimi-k3'); // would override if consulted
    mockResolveOneCodingPick.mockResolvedValue('kimi-k3');
    await executeClaimedRun(makeClaim());
    expect(mockProjectCodingModel).not.toHaveBeenCalled();
    expect(mockRunCodingAgent.mock.calls[0][0].model).toBe('glm-5.3');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('project codingModel override skipped'));
  });

  it('(b6b) default-stamped session (modelSource NULL): a valid project pick still overrides at run time (2026-09-04 owner ask intact)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, model: 'glm-5.3', modelSource: null });
    mockProjectCodingModel.mockResolvedValue('kimi-k3');
    mockResolveOneCodingPick.mockResolvedValue('kimi-k3');
    await executeClaimedRun(makeClaim());
    expect(mockProjectCodingModel).toHaveBeenCalledWith('p1');
    expect(mockRunCodingAgent.mock.calls[0][0].model).toBe('kimi-k3');
    expect(mockRunCodingAgent.mock.calls[0][0].modelSource).toBe('project');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('project coding-agent override'));
  });

  // Seats govern sessions (owner 2026-09-28; coding/seat-governance.ts): the stamp with
  // modelSource NULL is a RECORD — the coding_default SEAT resolved LIVE governs the run,
  // the governing source rides the init event / agent input (→ run_spend meta.modelSource),
  // and the record is refreshed so the side panel names what ran. The kill switch restores
  // the pre-2026-09-28 stamp authority (project override → stamp).
  it('(sg1) NULL-provenance stamp + a re-seated Workspace default: the SEAT runs, not the stamp; init event + agent input carry modelSource "seat"; the record is refreshed', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, model: 'kimi', modelSource: null });
    mockProjectCodingModel.mockResolvedValue(null); // no project pick (the b6 cases above leave a persistent value)
    mockResolveOneCodingPick.mockResolvedValue(null);
    mockResolveRoleModelForRun.mockResolvedValue('cql-litellm:api-optimize-glm-5.3');
    await executeClaimedRun(makeClaim());
    expect(mockResolveRoleModelForRun).toHaveBeenCalledWith('coding_default', 'glm-5.3');
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.model).toBe('cql-litellm:api-optimize-glm-5.3');
    expect(input.modelSource).toBe('seat');
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { model: 'cql-litellm:api-optimize-glm-5.3' });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('model governed by seat'));
  });

  it('(sg2) an explicit session pick is never re-stamped by the seat', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, model: 'glm-5.3', modelSource: 'explicit' });
    mockProjectCodingModel.mockResolvedValue(null);
    mockResolveOneCodingPick.mockResolvedValue(null);
    mockResolveRoleModelForRun.mockResolvedValue('cql-litellm:api-optimize-glm-5.3');
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.model).toBe('glm-5.3');
    expect(input.modelSource).toBe('explicit');
    expect(mockUpdateSessionState).not.toHaveBeenCalledWith('s1', expect.objectContaining({ model: expect.anything() }));
  });

  it('(sg3) SEAT_GOVERNS_SESSIONS_DISABLED=1: the stamp is the authority again (the seat is never consulted; modelSource "stamp")', async () => {
    process.env.SEAT_GOVERNS_SESSIONS_DISABLED = '1';
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, model: 'kimi', modelSource: null });
    mockProjectCodingModel.mockResolvedValue(null);
    mockResolveOneCodingPick.mockResolvedValue(null);
    mockResolveRoleModelForRun.mockResolvedValue('cql-litellm:api-optimize-glm-5.3');
    await executeClaimedRun(makeClaim());
    expect(mockResolveRoleModelForRun).not.toHaveBeenCalled();
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.model).toBe('kimi');
    expect(input.modelSource).toBe('stamp');
  });

  it('(b2) fc7b2ca7 sighting-1 replay: input.existingUserMessageIds all present → ADOPT the eager rows, NO duplicate user insert, still markInputConsumed', async () => {
    // The recovered stranded steer: the controller already persisted the triage
    // note as user row msg-eager-1 (the sighting's msg 133f6923); the run-start
    // persist must NOT insert the sighting's second copy (msg 4e9a91e8).
    mockPrisma.crossModelMessage.count.mockResolvedValueOnce(1); // the adopt lookup: 1 of 1 ids exist
    await executeClaimedRun(makeClaim({
      input: { message: 'triage note body', userId: 'u1', origin: 'schedule', existingUserMessageIds: ['msg-eager-1'] },
    }));

    // The adopt lookup probed exactly the listed ids, scoped to this chat + role.
    expect(mockPrisma.crossModelMessage.count).toHaveBeenCalledWith({
      where: { id: { in: ['msg-eager-1'] }, chatId: 's1', role: 'user' },
    });
    // NO user-row insert (assistant placeholder/final rows are unaffected).
    expect(mockAppendCodingMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));
    // The input is still marked consumed, and the MODEL still gets the message
    // (adoption changes the transcript, never the run's prompt).
    expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run1', inputConsumedAt: null },
    }));
    expect(mockRunCodingAgent.mock.calls[0][0].userMessage).toBe('triage note body');
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(b3) fc7b2ca7: a PARTIALLY-missing adopt set inserts as before — never trade content loss for tidiness', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValueOnce(1); // only 1 of 2 eager rows found
    await executeClaimedRun(makeClaim({
      input: { message: 'merged steer batch', userId: 'u1', origin: 'schedule', existingUserMessageIds: ['msg-eager-1', 'msg-gone-2'] },
    }));
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'merged steer batch',
    }));
  });

  it('(b4) fc7b2ca7: adopt lookup FAILURE (db blip) inserts as before — duplicate-over-loss doctrine', async () => {
    mockPrisma.crossModelMessage.count.mockRejectedValueOnce(new Error('db blip'));
    await executeClaimedRun(makeClaim({
      input: { message: 'triage note body', userId: 'u1', origin: 'schedule', existingUserMessageIds: ['msg-eager-1'] },
    }));
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'triage note body',
    }));
  });

  it('(l) broken-but-present worktree (dangling gitdir link) → re-provisions from the mirror (#142)', async () => {
    // fs.access succeeds (dir exists) but the probe says it is not a usable repo.
    mockIsUsableWorktree.mockResolvedValue(false);
    await executeClaimedRun(makeClaim());

    // ensureRunnable probed the on-disk dir, found it unusable, and rebuilt it.
    expect(mockIsUsableWorktree).toHaveBeenCalledWith('/tmp/wt');
    expect(mockReattachWorktree).toHaveBeenCalledWith('p1', 's1', 'https://github.com/o/r', 'main', 'digby/x', 'tok', null);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { worktreePath: '/tmp/wt-reattached' });

    // The run then executes against the REPAIRED path and completes.
    expect(mockRunCodingAgent.mock.calls[0][0].worktree).toBe('/tmp/wt-reattached');
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(m) healthy existing worktree → probed, reused in place, no re-provision (#142)', async () => {
    await executeClaimedRun(makeClaim());
    expect(mockIsUsableWorktree).toHaveBeenCalledWith('/tmp/wt');
    expect(mockReattachWorktree).not.toHaveBeenCalled();
    expect(mockRunCodingAgent.mock.calls[0][0].worktree).toBe('/tmp/wt');
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(n) blank session with an existing worktree → probe skipped, legacy behavior (#142)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, project: { ...SESSION.project, provider: 'blank' } });
    await executeClaimedRun(makeClaim());
    expect(mockIsUsableWorktree).not.toHaveBeenCalled();
    expect(mockReattachWorktree).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  // ── FO 2026-09-23 cross-box blank fix (tickets 002542b1 + f4f128c0 + cca4e450; prod
  // chats 26e38cce / 8a898e61): a blank worktree provisioned by a WEB box is
  // invisible to the coding worker (box-local /app/coding-workspaces, no
  // mirror for a standalone repo). Fresh spawn (zero completed runs) →
  // self-heal by re-provisioning locally; real history → the legacy hard
  // error stands. ──
  it('(o) 2026-09-23 cross-box (002542b1/f4f128c0/cca4e450 — the planning lane (third duplicate filing, same root cause)): blank session, worktreePath set, dir ABSENT, zero completed runs → self-heals by re-provisioning on this worker', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, project: { ...SESSION.project, provider: 'blank' } });
    const fs = require('fs/promises');
    fs.access.mockRejectedValueOnce(new Error('ENOENT')); // dir absent on this box
    mockPrisma.agentRun.count.mockResolvedValueOnce(0); // fresh spawn — nothing ever completed
    await executeClaimedRun(makeClaim());

    // The standalone repo was rebuilt HERE and the session row re-pointed.
    expect(mockEnsureBlankWorktree).toHaveBeenCalledWith('s1', 'main', 'digby/x', null);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { worktreePath: '/tmp/wt-blank-new' });
    // The run then executes against the REBUILT path and completes.
    expect(mockRunCodingAgent.mock.calls[0][0].worktree).toBe('/tmp/wt-blank-new');
    expect(finalizeCall()?.[0].data.status).toBe('completed');
    // The self-heal was telemetered.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'blank_provision_selfheal' }));
  });

  it('(p) 2026-09-23 cross-box: blank session, dir absent, but a run COMPLETED before → legacy hard error stands (real history lives on the provisioning box)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, project: { ...SESSION.project, provider: 'blank' } });
    const fs = require('fs/promises');
    fs.access.mockRejectedValueOnce(new Error('ENOENT'));
    mockPrisma.agentRun.count.mockResolvedValueOnce(1); // completed history exists
    await executeClaimedRun(makeClaim());

    expect(mockEnsureBlankWorktree).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('failed');
    expect(String(finalizeCall()?.[0].data.error)).toContain('Workspace missing on disk');
  });

  it('(i10-a) hardening iteration 10: LOCAL project, broken worktree, mirror MISSING on disk → ensureProvisioned re-creates the bare mirror BEFORE reattach, telemetered with mirrorExisted:false (prod 922fd3ad, FO firing 19→22)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, project: { ...SESSION.project, provider: 'local', repoUrl: '' } });
    mockIsUsableWorktree.mockResolvedValue(false); // force the reattach path
    const fs = require('fs/promises');
    fs.stat.mockRejectedValueOnce(new Error('ENOENT')); // mirror gone — a real heal
    await executeClaimedRun(makeClaim());

    expect(mockEnsureProvisioned).toHaveBeenCalledWith('p1');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'local_mirror_selfheal', meta: { projectId: 'p1', mirrorExisted: false },
    }));
    expect(mockReattachWorktree).toHaveBeenCalledWith('p1', 's1', '', 'main', 'digby/x', null, null);
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(i10-b) LOCAL project, broken worktree, mirror PRESENT → the ensure is a no-op but still telemetered mirrorExisted:true (distinguishes heal from routine pass)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, project: { ...SESSION.project, provider: 'local', repoUrl: '' } });
    mockIsUsableWorktree.mockResolvedValue(false);
    const fs = require('fs/promises');
    fs.stat.mockResolvedValueOnce({ isDirectory: () => true }); // mirror survives
    await executeClaimedRun(makeClaim());

    expect(mockEnsureProvisioned).toHaveBeenCalledWith('p1');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'local_mirror_selfheal', meta: { projectId: 'p1', mirrorExisted: true },
    }));
  });

  it('(b2) fleet origin marking: an explicit input.origin WINS over the userTurnAt heuristic (agent send persists agent + sourceChatId)', async () => {
    await executeClaimedRun(makeClaim({
      input: {
        message: 'from another agent', userId: 'u1',
        userTurnAt: new Date().toISOString(), // agent sends still carry the anchor…
        origin: 'agent', originSourceChatId: 'chat-9', // …but must persist as AGENT traffic
      },
    }));

    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'from another agent',
      metadata: { origin: 'agent', sourceChatId: 'chat-9' },
    }));
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(b3) fleet origin marking heuristic (no explicit origin): userTurnAt ⇒ user, neither ⇒ schedule', async () => {
    await executeClaimedRun(makeClaim({
      input: { message: 'typed by a human', userId: 'u1', userTurnAt: new Date().toISOString() },
    }));
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user', content: 'typed by a human', metadata: { origin: 'user' },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user', content: 'machine wake', metadata: { origin: 'schedule' },
    }));
  });

  it('(b4) cap-skip notice: metadata-only on the user row + SYSTEM-context injection — never in the message content', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'tick the loop', userId: 'u1', capSkippedNotice: 7 } }));

    // The persisted user row carries the PLAIN prompt; the count rides metadata
    // (debug visibility) — the ops banner is never stored as the user's words.
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'tick the loop',
      metadata: { origin: 'schedule', capSkippedNotice: 7 },
    }));

    // The model learns about the skips via system context (schedulerNotice),
    // with the plain prompt as its user message.
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.userMessage).toBe('tick the loop');
    expect(input.schedulerNotice).toContain('7 scheduled firing(s) were skipped');
  });

  it('(b5) no cap-skip notice → no schedulerNotice and no metadata key', async () => {
    await executeClaimedRun(makeClaim());
    expect(mockRunCodingAgent.mock.calls[0][0].schedulerNotice).toBeUndefined();
    expect(mockAppendCodingMessage.mock.calls[0][0].metadata).toEqual({ origin: 'schedule' });
  });

  /* ── 78f32515: the derailed lane's one-shot breaker notice rides schedulerNotice ── */
  it('(78f32515) a pending breaker lane notice composes into schedulerNotice (and is consumed from the store)', async () => {
    mockConsumeBreakerLaneNotice.mockResolvedValueOnce(
      '[BREAKER NOTICE] Your previous run was ended by the narrated-tool-emit loop breaker: the run announced "Sending it NOW:" 4× but send_chat_message never executed — that action did NOT happen. Attribution ticket ticket-abc-123 was auto-filed for it. If the action still needs to happen, re-issue it as a REAL tool call this run; if it is moot, say so and move on.',
    );
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    expect(mockConsumeBreakerLaneNotice).toHaveBeenCalledWith('s1');
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(String(input.schedulerNotice)).toContain('[BREAKER NOTICE]');
    expect(String(input.schedulerNotice)).toContain('narrated-tool-emit loop');
    expect(String(input.schedulerNotice)).toContain('ticket-abc-123');
    // System-context channel only — the persisted user row stays the plain prompt.
    expect(input.userMessage).toBe('machine wake');
  });

  it('(78f32515) a consume failure is fail-open — the run starts with no notice', async () => {
    mockConsumeBreakerLaneNotice.mockRejectedValueOnce(new Error('redis down'));
    await executeClaimedRun(makeClaim());

    expect(mockRunCodingAgent.mock.calls[0][0].schedulerNotice).toBeUndefined();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(b7) zero-tool pre-final gate flag: machineTriggered rides the agent input — false for a user turn, true for schedule/agent triggers', async () => {
    // userTurnAt + no origin ⇒ triggerKind 'user' ⇒ never gated.
    await executeClaimedRun(makeClaim({
      input: { message: 'typed by a human', userId: 'u1', userTurnAt: new Date().toISOString() },
    }));
    expect(mockRunCodingAgent.mock.calls[0][0].machineTriggered).toBe(false);

    // No userTurnAt, no origin ⇒ heuristic 'schedule' ⇒ gated.
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    expect(mockRunCodingAgent.mock.calls[1][0].machineTriggered).toBe(true);

    // Explicit fleet origin 'agent' WINS over the userTurnAt anchor ⇒ gated.
    await executeClaimedRun(makeClaim({
      input: { message: 'from another agent', userId: 'u1', userTurnAt: new Date().toISOString(), origin: 'agent', originSourceChatId: 'chat-9' },
    }));
    expect(mockRunCodingAgent.mock.calls[2][0].machineTriggered).toBe(true);
  });

  /* ── Owner-dispatch RUN classification (2026-10-01) ── */
  describe('owner-dispatch: a supervisor relaying the OWNER\'s own-turn ask starts a USER-classified run', () => {
    const AT = new Date('2026-10-01T09:00:00.000Z').toISOString();

    it('eligible (origin agent + ownerDispatch + anchor) ⇒ triggerKind user: not machineTriggered, anchor threaded, full history window; the row stays origin agent', async () => {
      await executeClaimedRun(makeClaim({
        input: { message: 'run the TB task', userId: 'u1', userTurnAt: AT, origin: 'agent', originSourceChatId: 'ps-1', ownerDispatch: true } as any,
      }));
      const input = mockRunCodingAgent.mock.calls[0][0];
      expect(input.machineTriggered).toBe(false);
      expect(input.userTurnAt).toEqual(new Date(AT));
      expect(mockListRecentCodingTranscript).toHaveBeenCalledWith('s1', 24 * 2 + 1 + 3 /* card over-fetch */);
      expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
        role: 'user', content: 'run the TB task',
        metadata: { origin: 'agent', sourceChatId: 'ps-1', ownerDispatch: true },
      }));
    });

    it('INELIGIBLE agent sends stay machine: no flag, or the flag without an anchor, or a non-agent origin carrying the flag', async () => {
      await executeClaimedRun(makeClaim({ input: { message: 'fan-out', userId: 'u1', userTurnAt: AT, origin: 'agent', originSourceChatId: 'ps-1' } as any }));
      expect(mockRunCodingAgent.mock.calls[0][0].machineTriggered).toBe(true);
      expect(mockAppendCodingMessage.mock.calls[0][0].metadata).toEqual({ origin: 'agent', sourceChatId: 'ps-1' });
      await executeClaimedRun(makeClaim({ input: { message: 'no anchor', userId: 'u1', origin: 'agent', ownerDispatch: true } as any }));
      expect(mockRunCodingAgent.mock.calls[1][0].machineTriggered).toBe(true);
      await executeClaimedRun(makeClaim({ input: { message: 'webhook', userId: 'u1', userTurnAt: AT, origin: 'webhook', ownerDispatch: true } as any }));
      expect(mockRunCodingAgent.mock.calls[2][0].machineTriggered).toBe(true);
      expect(mockListRecentCodingTranscript).toHaveBeenLastCalledWith('s1', 2 * 2 + 1 + 3 /* card over-fetch */);
    });

    // ── The robustness rails stay (2026-10-01): an owner-dispatched run is
    // user-classified but UNATTENDED — unattendedRun keys the long backoff
    // table, the cross-run backstop + provider-limit resume, and machine
    // failure semantics exactly as for a machine run.
    const odClaim = () => makeClaim({
      input: { message: 'run the TB task', userId: 'u1', userTurnAt: AT, origin: 'agent', originSourceChatId: 'ps-1', ownerDispatch: true } as any,
    });
    const userClaim = () => makeClaim({ input: { message: 'typed by a human', userId: 'u1', userTurnAt: AT } as any });
    const providerKilledOnce = () =>
      mockRunCodingAgent.mockImplementationOnce(async () => ({
        finalText: '⚠︎ rate-limited: provider kept returning HTTP 429',
        parts: [{ type: 'text', text: 'rate-limited' }],
        modelErrored: true, modelErrorStatus: 429, modelErrorKind: 'transient' as const,
      }));
    const flushHooks = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

    it('rail 1 — the agent input carries ownerDispatch:true (agent.ts unattendedRun → the long machine backoff table); a watched user run carries none', async () => {
      await executeClaimedRun(odClaim());
      expect(mockRunCodingAgent.mock.calls[0][0].ownerDispatch).toBe(true);
      expect(mockRunCodingAgent.mock.calls[0][0].machineTriggered).toBe(false);
      await executeClaimedRun(userClaim());
      expect(mockRunCodingAgent.mock.calls[1][0]).not.toHaveProperty('ownerDispatch');
    });

    it('rail 2a — an owner-dispatched run that ends with open plan steps queues the cross-run [HARNESS CONTINUATION] backstop like a machine run; a watched user run does not', async () => {
      mockGetPlan.mockResolvedValue({
        updatedAt: new Date().toISOString(),
        steps: [{ id: 1, text: 'done', status: 'completed' }, { id: 2, text: 'still open', status: 'pending' }],
      });
      await executeClaimedRun(odClaim());
      expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
      expect(mockQueueContinuationRun.mock.calls[0][0].prompt).toContain('[HARNESS CONTINUATION r1/6]');
      mockQueueContinuationRun.mockClear();
      await executeClaimedRun(userClaim());
      expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    });

    it('rail 2b — a provider-limit kill with no plan queues the throttled [RESUME AFTER PROVIDER LIMIT] run like a machine run', async () => {
      mockGetPlan.mockResolvedValue(null);
      providerKilledOnce();
      await executeClaimedRun(odClaim());
      expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
      const arg = mockQueueContinuationRun.mock.calls[0][0];
      expect(arg.prompt).toContain('[RESUME AFTER PROVIDER LIMIT]');
      expect(arg.resume).toBe(true);
      // a watched user run never resumes
      mockQueueContinuationRun.mockClear();
      providerKilledOnce();
      await executeClaimedRun(userClaim());
      expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    });

    it('rail 3 — a provider-killed owner-dispatched run finalizes FAILED with the provider cause and emits run_failed (machine semantics); a watched user run stays completed', async () => {
      providerKilledOnce();
      await executeClaimedRun(odClaim());
      await flushHooks();
      expect(finalizeCall()?.[0].data.status).toBe('failed');
      expect(finalizeCall()?.[0].data.error).toContain('model provider killed the run (transient failure, HTTP 429)');
      expect(mockEmitHookEventSafe.mock.calls.some((c: any[]) => c[1] === 'run_failed')).toBe(true);
      mockPrisma.agentRun.update.mockClear();
      mockEmitHookEventSafe.mockClear();
      providerKilledOnce();
      await executeClaimedRun(userClaim());
      await flushHooks();
      expect(finalizeCall()?.[0].data.status).toBe('completed');
      expect(mockEmitHookEventSafe.mock.calls.some((c: any[]) => c[1] === 'run_failed')).toBe(false);
    });
  });

  /* ── 7f546b03: input.files stage into the worktree at consumption ── */
  it('(b6) input.files stage via the files seam: note on the agent message + metadata.attachments on the user row (NEVER base64 parts)', async () => {
    const CSV_B64 = Buffer.from('a,b\n1,2\n').toString('base64');
    const FILES_NOTE = '\n\n[ATTACHED FILES — saved to the session filesystem]\n…';
    mockStageFilesAndDescribe.mockResolvedValue({ staged: [{ name: '01-data.csv' }], note: FILES_NOTE });
    await executeClaimedRun(makeClaim({
      input: { message: 'crunch this', userId: 'u1', files: [{ name: 'data.csv', mediaType: 'text/csv', data: CSV_B64 }] },
    }));

    // The bytes staged through the generalized seam (same worktree + label shape as images).
    expect(mockStageFilesAndDescribe).toHaveBeenCalledWith(
      '/tmp/wt', [{ name: 'data.csv', mediaType: 'text/csv', data: CSV_B64 }], 'session s1 run input',
    );
    // The agent-facing message carries the note AFTER the user's text.
    expect(mockRunCodingAgent.mock.calls[0][0].userMessage).toBe(`crunch this${FILES_NOTE}`);
    // The persisted user row: filename+type metadata only — no file parts, no base64.
    const row = mockAppendCodingMessage.mock.calls[0][0];
    expect(row.metadata).toEqual({ origin: 'schedule', attachments: [{ filename: 'data.csv', type: 'text/csv' }] });
    expect(row.parts).toBeUndefined();
  });

  it('(b7) images + files notes BOTH concatenate onto the agent message (image staging unchanged)', async () => {
    mockStageAndDescribe.mockResolvedValue({ staged: [{ name: '01-a.png' }], note: '\n\n[ATTACHMENTS]' });
    mockStageFilesAndDescribe.mockResolvedValue({ staged: [{ name: '01-d.csv' }], note: '\n\n[ATTACHED FILES]' });
    await executeClaimedRun(makeClaim({
      input: {
        message: 'both', userId: 'u1',
        images: [{ mediaType: 'image/png', data: 'AAAA', name: 'a.png' }],
        files: [{ name: 'd.csv', mediaType: 'text/csv', data: 'QUJD' }],
      },
    }));
    expect(mockRunCodingAgent.mock.calls[0][0].userMessage).toBe('both\n\n[ATTACHMENTS]\n\n[ATTACHED FILES]');
  });

  it('(b8) a STEER carrying files stages them mid-run and appends the note to the injected instruction', async () => {
    mockStageFilesAndDescribe.mockResolvedValue({ staged: [{ name: '01-f.txt' }], note: '\n\n[ATTACHED FILES — saved]' });
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    await pushSteerMessage('s1', { text: 'turn left', files: [{ name: 'f.txt', mediaType: 'text/plain', data: 'QUJD' }] });
    const injected = await input.injectSystem();
    expect(mockStageFilesAndDescribe).toHaveBeenCalledWith(
      '/tmp/wt', [{ name: 'f.txt', mediaType: 'text/plain', data: 'QUJD' }], 'session s1 steer',
    );
    expect(injected).toContain('turn left');
    expect(injected).toContain('[ATTACHED FILES — saved]');
  });

  // audit 2026-10-08 W2-9: a peer-agent steer is framed as a peer, not "The user sent this";
  // an owner steer keeps the pre-fix framing; one steer_framed row per drain.
  it('(b9) steers are framed by origin — peer agent vs owner (steer-framing.ts wiring)', async () => {
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    await pushSteerMessage('s1', { text: 'lane idle at 2/8 — resume', origin: 'agent', sourceChatId: 'c0e22e36-1c74' });
    const peer = await input.injectSystem();
    const peerText = typeof peer === 'string' ? peer : peer?.text;
    expect(peerText).toContain('Another Digby agent (chat c0e22e36) sent this WHILE you are working — it is NOT typed by the owner.');
    expect(peerText).not.toContain('The user sent this');
    await pushSteerMessage('s1', { text: 'turn left' });
    const owner = await input.injectSystem();
    const ownerText = typeof owner === 'string' ? owner : owner?.text;
    expect(ownerText).toContain('The user sent this WHILE you are working — treat it as a live steering instruction with high priority.');
  });

  it('(r1) run journal: terminal finalize fires ONE fire-and-forget entry — trigger from the origin heuristic, tools deduped from the transcript', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: 'shipped it',
      parts: [
        { type: 'tool_call', name: 'edit_file', args: {} },
        { type: 'tool_call', name: 'edit_file', args: {} },
        { type: 'tool_call', name: 'run_command', args: {} },
        { type: 'text', text: 'shipped it' },
      ],
    }));
    await executeClaimedRun(makeClaim({
      input: { message: 'build the thing', userId: 'u1', userTurnAt: new Date().toISOString() },
    }));

    expect(mockWriteRunJournalEntryAsync).toHaveBeenCalledTimes(1);
    const j = mockWriteRunJournalEntryAsync.mock.calls[0][0];
    expect(j).toMatchObject({
      chatId: 's1', runId: 'run1', triggerKind: 'user',
      userMessage: 'build the thing', assistantFinal: 'shipped it',
    });
    expect(j.toolsUsed).toEqual(['edit_file', 'run_command']); // deduped, first-appearance order
  });

  it('(r2) run journal: an agent error still journals — the failure IS what the next run needs to know', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => { throw new Error('provider exploded'); });
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    expect(finalizeCall()?.[0].data.status).toBe('failed');
    expect(mockWriteRunJournalEntryAsync).toHaveBeenCalledTimes(1);
    const j = mockWriteRunJournalEntryAsync.mock.calls[0][0];
    expect(j.triggerKind).toBe('schedule'); // no origin, no userTurnAt → executor heuristic
    expect(j.assistantFinal).toBe('Run failed: provider exploded');
  });

  it('(steer-recovery) terminal finalize recovers stranded steers as a follow-up run', async () => {
    await executeClaimedRun(makeClaim());
    expect(mockRecoverStrandedSteers).toHaveBeenCalledTimes(1);
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'run-finalize');
  });

  it('(steer-recovery) shutdown-interrupt SKIPS recovery — the resuming worker drains the mailbox at its own first step', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => {
      markRunShutdownInterrupted('s1'); // worker SIGTERM path
      return { finalText: 'partial', parts: [{ type: 'text', text: 'partial' }] };
    });
    await executeClaimedRun(makeClaim({ preStatus: 'interrupted', checkpoint: CP }));
    expect(mockRecoverStrandedSteers).not.toHaveBeenCalled();
  });

  it('(steer-recovery) attempts-exhausted give-up lane flips ready WITHOUT the finally — and still recovers steers (review F2a)', async () => {
    await executeClaimedRun(makeClaim({ attempts: ATTEMPTS_CAP + 1 }));
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'run-give-up');
  });

  it('(steer-recovery) notRunnable pre-flight lane flips ready WITHOUT the finally — and still recovers steers (review F2a/N1)', async () => {
    mockIsUsableWorktree.mockResolvedValue(false); // worktree gone...
    mockReattachWorktree.mockRejectedValue(new Error('mirror gone')); // ...and re-provision fails → notRunnable
    await executeClaimedRun(makeClaim());
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'run-not-runnable');
  });

  it('(stale-firing) a run queued by an explicitly-CANCELLED schedule finalizes cancelled WITHOUT executing (fbe65673)', async () => {
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce({ enabled: false, lastStatus: 'cancelled' });
    await executeClaimedRun(makeClaim({ input: { message: 'loop prompt', userId: 'u1', origin: 'schedule', scheduleId: 'sch_gone' } }));
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(mockGetSessionForUser).not.toHaveBeenCalled(); // skipped before session load
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    expect(mockPrisma.agentEvent.create).toHaveBeenCalled();
    expect(JSON.stringify(mockPrisma.agentEvent.create.mock.calls[0][0])).toContain('Stale schedule firing');
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'schedule-cancelled');
  });

  it('(stale-firing) CRITICAL false-positive guard: a once/maxRuns-completed schedule (enabled:false, lastStatus started) keeps its legitimately-queued run', async () => {
    // The sweeper sets enabled:false with lastStatus 'started' when a firing
    // consumes the final allowed run (reachedCap) — and for EVERY once-schedule
    // right after queueing it. A blanket disabled-check would cancel those.
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce({ enabled: false, lastStatus: 'started' });
    await executeClaimedRun(makeClaim({ input: { message: '[HARNESS CONTINUATION r1/6] …', userId: 'u1', origin: 'schedule', scheduleId: 'sch_once' } }));
    expect(mockRunCodingAgent).toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).not.toBe('cancelled');
  });

  it('(stale-firing) the sweeper skip-write clobber (skipped:cancelled) still drops a pre-cancel queued run (review finding 2)', async () => {
    // When the fire-time guard rejects a post-cancel fire, the sweeper writes
    // lastStatus 'skipped:cancelled' OVER 'cancelled' — the guard must catch
    // that string too or it goes toothless for its core incident class.
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce({ enabled: false, lastStatus: 'skipped:cancelled' });
    await executeClaimedRun(makeClaim({ input: { message: 'loop prompt', userId: 'u1', origin: 'schedule', scheduleId: 'sch_gone' } }));
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'schedule-cancelled');
  });

  // agent-decisions prerequisite 5 (2026-09-27): the claim-time twin of the
  // fire-time zero-unfinished guard — a QUEUED continuation that went stale
  // behind a busy lane is cancelled before the loop, with ONE row.
  it('(continuation claim-time guard) a queued continuation whose plan board completed before the claim is cancelled before the loop, with ONE schedule_continuation_skip row (seam claim)', async () => {
    mockGetPlanStrict.mockResolvedValueOnce({ steps: [{ id: 1, status: 'completed' }, { id: 2, status: 'blocked' }] });
    await executeClaimedRun(makeClaim({ input: { message: '[machine firing] [HARNESS CONTINUATION r2/6] resume the plan', userId: 'u1', origin: 'schedule' } }));
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(mockGetSessionForUser).not.toHaveBeenCalled(); // skipped before session load
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    expect(finalizeCall()?.[0].data.error).toMatch(/continuation obsolete at claim time/);
    expect(JSON.stringify(mockPrisma.agentEvent.create.mock.calls[0][0])).toContain('Stale continuation skipped');
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'continuation-obsolete');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'schedule_continuation_skip', sessionId: 's1', runId: 'run1',
      meta: expect.objectContaining({ origin: 'schedule', seam: 'claim', steps: 2 }),
    }));
  });

  it('(continuation claim-time guard) steps remaining → runs; a plan READ ERROR → runs (uncertainty never drops a resumption); a USER-typed message with the marker is never judged', async () => {
    mockGetPlanStrict.mockResolvedValueOnce({ steps: [{ id: 1, status: 'pending' }] });
    await executeClaimedRun(makeClaim({ input: { message: '[HARNESS CONTINUATION r1/6] resume', userId: 'u1', origin: 'schedule' } }));
    expect(mockRunCodingAgent).toHaveBeenCalledTimes(1);
    expect(finalizeCall()?.[0].data.status).not.toBe('cancelled');

    jest.clearAllMocks();
    mockGetPlanStrict.mockRejectedValueOnce(new Error('store timeout'));
    await executeClaimedRun(makeClaim({ input: { message: '[HARNESS CONTINUATION r1/6] resume', userId: 'u1', origin: 'schedule' } }));
    expect(mockRunCodingAgent).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    // No queued plan value here on purpose: a USER-typed message never reaches the reader,
    // and a leftover mockResolvedValueOnce would leak into the next suite's claim.
    await executeClaimedRun(makeClaim({ input: { message: 'please resume — [HARNESS CONTINUATION r1/6]', userId: 'u1', userTurnAt: new Date().toISOString() } }));
    expect(mockGetPlanStrict).not.toHaveBeenCalled();
    expect(mockRunCodingAgent).toHaveBeenCalledTimes(1);
  });

  it('(stop means stop) a queued continuation on an ARCHIVED session is cancelled at claim time, before the loop', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (a: any) => (a?.select?.archivedAt ? { archivedAt: new Date() } : { userId: 'u1' }));
    try {
      await executeClaimedRun(makeClaim({ input: { message: '[machine firing] [HARNESS CONTINUATION r2/6] resume the plan', userId: 'u1', origin: 'schedule' } }));
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ userId: 'u1' }));
    }
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    expect(finalizeCall()?.[0].data.error).toMatch(/the session is archived/);
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'continuation-archived');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'continuation_suppressed', sessionId: 's1', runId: 'run1', meta: expect.objectContaining({ reason: 'archived', seam: 'claim' }),
    }));
  });

  it('(stop means stop) an ARCHIVED session never blocks a NON-continuation run (a user can still message it)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (a: any) => (a?.select?.archivedAt ? { archivedAt: new Date() } : { userId: 'u1' }));
    try {
      await executeClaimedRun(makeClaim({ input: { message: 'please look again', userId: 'u1', userTurnAt: new Date().toISOString() } }));
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ userId: 'u1' }));
    }
    expect(mockRunCodingAgent).toHaveBeenCalledTimes(1);
  });

  it('(stale-firing) an expired schedule keeps its already-queued run (fired legitimately pre-expiry)', async () => {
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce({ enabled: false, lastStatus: 'expired' });
    await executeClaimedRun(makeClaim({ input: { message: 'loop prompt', userId: 'u1', origin: 'schedule', scheduleId: 'sch_old' } }));
    expect(mockRunCodingAgent).toHaveBeenCalled();
  });

  it('(stale-firing) a deleted schedule row (findUnique → null) also cancels the stale firing', async () => {
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce(null);
    await executeClaimedRun(makeClaim({ input: { message: 'loop prompt', userId: 'u1', origin: 'schedule', scheduleId: 'sch_gone' } }));
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
  });

  it('(stale-firing) an enabled schedule lets the firing proceed (default mock)', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'loop prompt', userId: 'u1', origin: 'schedule', scheduleId: 'sch_1' } }));
    expect(mockRunCodingAgent).toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).not.toBe('cancelled');
  });

  it('(stale-firing) a schedule-read ERROR never skips — uncertainty must not drop a real run', async () => {
    mockPrisma.chatSchedule.findUnique.mockRejectedValueOnce(new Error('db blip'));
    await executeClaimedRun(makeClaim({ input: { message: 'loop prompt', userId: 'u1', origin: 'schedule', scheduleId: 'sch_1' } }));
    expect(mockRunCodingAgent).toHaveBeenCalled();
  });

  it('(stale-firing) runs WITHOUT a scheduleId (user turns, agent sends) never touch the schedule table', async () => {
    await executeClaimedRun(makeClaim());
    expect(mockPrisma.chatSchedule.findUnique).not.toHaveBeenCalled();
    expect(mockRunCodingAgent).toHaveBeenCalled();
  });

  it('(r3) run journal: a shutdown-interrupted run writes NO entry (its eventual resume writes the one that counts)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(CP);
      markRunShutdownInterrupted('s1');
      cancelRun('s1');
      return { finalText: '', parts: [] };
    });
    await executeClaimedRun(makeClaim());

    expect(finalizeCall()?.[0].data.status).toBe('interrupted');
    expect(mockWriteRunJournalEntryAsync).not.toHaveBeenCalled();
  });

  it('(c) resume: resumeFrom + harness-notice userMessage, NO re-insert when inputConsumed', async () => {
    await executeClaimedRun(makeClaim({
      preStatus: 'interrupted',
      checkpoint: CP,
      input: { message: 'go on', userId: 'u1' },
      inputConsumed: true, // a prior attempt already persisted the message
    }));

    // No user-row re-insert (assistant transcript rows are fine).
    expect(mockAppendCodingMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));
    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run1', inputConsumedAt: null },
    }));

    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.resumeFrom).toBe(CP);
    expect(input.userMessage).toContain('[HARNESS NOTICE — not typed by the user]');
    expect(input.userMessage).toContain('resuming from its saved checkpoint');
    // Transcript-boundary delineation (nightly-lane stale-id postmortem 2026-08-27):
    // replayed tool results are STALE; only post-notice results are current.
    expect(input.userMessage).toContain('TRANSCRIPT BOUNDARY');
    expect(input.userMessage).toContain('only tool results obtained AFTER this notice are current');
    expect(input.userMessage).toContain("The user's latest message follows.\n\ngo on");

    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(c2) duplicate-bubble double-persist fix: a resume UPDATES the checkpoint-carried assistant row (no second append) and re-stamps the id on new checkpoints', async () => {
    // Prod chat ddb4acc5: the interrupted attempt persisted a partial 'P' row;
    // the resumed attempt appended a SECOND full 'PONG' row because
    // assistantMsgId was attempt-local. The checkpoint now carries it.
    const probe: any = { ...CP };
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'PONG' }); // regenerated answer streams into the SAME row
      input.onCheckpoint(probe); // a later checkpoint must re-carry the row id
      return { finalText: 'PONG', parts: [{ type: 'text', text: 'PONG' }] };
    });
    await executeClaimedRun(makeClaim({
      preStatus: 'interrupted',
      checkpoint: { ...CP, assistantMsgId: 'msg-partial' },
      input: { message: 'go on', userId: 'u1' },
      inputConsumed: true,
    }));

    // Streamed partial AND finalize both UPDATE the carried row…
    expect(mockUpdateCodingMessage).toHaveBeenCalledWith('msg-partial', expect.objectContaining({ content: 'PONG' }));
    // …and no fresh assistant row is ever appended (the double-persist).
    expect(mockAppendCodingMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant' }));
    // The resumed attempt's own checkpoints carry the id forward (stamped
    // synchronously in onCheckpoint), so a SECOND interrupt still converges
    // on the same row.
    expect(probe.assistantMsgId).toBe('msg-partial');
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(c3) resumeAssistantMsgId: only a resume claim carries the row id; fresh runs append a new assistant row', async () => {
    // Pure helper contract.
    expect(resumeAssistantMsgId('resume', { assistantMsgId: 'msg-1' })).toBe('msg-1');
    expect(resumeAssistantMsgId('resume', { assistantMsgId: null })).toBeNull();
    expect(resumeAssistantMsgId('resume', null)).toBeNull();
    expect(resumeAssistantMsgId('fresh', { assistantMsgId: 'msg-1' })).toBeNull();

    // A fresh run streaming text APPENDS its own assistant row (unchanged).
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'hi' });
      return { finalText: 'hi', parts: [{ type: 'text', text: 'hi' }] };
    });
    await executeClaimedRun(makeClaim());
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant' }));
  });

  it('(c4) draft_discarded retracts the streamed draft from the partial transcript — the latestText finalize fallback no longer carries it (2026-09-08)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'kept. ' });
      input.emit('text', { delta: 'FABRICATED' });
      // The zero-tool gate discarded the just-streamed draft (agent.ts pops its
      // own part and announces the retraction on the stream).
      input.emit('draft_discarded', { chars: 'FABRICATED'.length, reason: 'zero_tool' });
      input.emit('guard_marker', { text: '⚠︎ discarded', struckPrev: false });
      return { finalText: '', parts: [] }; // no final ⇒ finalize persists latestText
    });
    await executeClaimedRun(makeClaim());
    const persisted = [
      ...mockAppendCodingMessage.mock.calls.map((c) => c[0]),
      ...mockUpdateCodingMessage.mock.calls.map((c) => c[1]),
    ].filter((x) => x && typeof x.content === 'string' && x.role !== 'user');
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[persisted.length - 1].content).toBe('kept. ');
  });

  it('(c5) a run that dies after a discard + marker persists the RETRACTED partial: trimmed text, a typed guard marker part, and a struck candidate (2026-09-08)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'kept. ' });
      input.emit('text', { delta: 'FABRICATED' });
      input.emit('draft_discarded', { chars: 'FABRICATED'.length, reason: 'zero_tool' });
      input.emit('guard_marker', { text: '⚠︎ discarded', struckPrev: false });
      input.emit('tool_call', { name: 'read_file', args: { path: 'x' } });
      input.emit('text', { delta: 'second draft' });
      input.emit('guard_marker', { text: '⚠︎ rejected', struckPrev: true });
      throw new Error('worker died'); // crash path → persistPartial(true)
    });
    await executeClaimedRun(makeClaim());
    const rows = [
      ...mockAppendCodingMessage.mock.calls.map((c) => c[0]),
      ...mockUpdateCodingMessage.mock.calls.map((c) => c[1]),
    ].filter((x) => x && Array.isArray(x.parts) && x.role !== 'user');
    const last = rows[rows.length - 1];
    expect(last.parts).toEqual([
      { type: 'text', text: 'kept. ' },
      { type: 'text', text: '⚠︎ discarded', marker: 'guard' },
      { type: 'tool_call', name: 'read_file', args: { path: 'x' } },
      { type: 'text', text: 'second draft', struck: true },
      { type: 'text', text: '⚠︎ rejected', marker: 'guard' },
    ]);
    // latestText follows the same retraction (the crash-path content).
    expect(last.content).toBe('kept. second draft');
  });

  it('(c5b) a generated image frame lands in agent_events url-only (no base64 — the bytes live in generated_files) and the crash-safe partial keeps url + fileId; screenshots keep their bytes (2026-09-24 review)', async () => {
    const url = '/api/crossmodel/generated-files/f1/inline';
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('image', { mediaType: 'image/png', data: 'AAAA', name: 'Generated · "fox"', source: 'generated', url, fileId: 'f1', prompt: 'a fox' });
      input.emit('image', { mediaType: 'image/png', data: 'BBBB', name: 'Final page', source: 'browser', pageUrl: 'https://x' });
      throw new Error('worker died'); // crash path → persistPartial(true)
    });
    await executeClaimedRun(makeClaim());
    const imageRows = mockPrisma.agentEvent.create.mock.calls.map((c: any[]) => c[0].data).filter((d: any) => d.type === 'image');
    expect(imageRows).toHaveLength(2);
    expect(imageRows[0].payload).toEqual({ mediaType: 'image/png', name: 'Generated · "fox"', source: 'generated', url, fileId: 'f1', prompt: 'a fox' });
    expect(imageRows[0].payload).not.toHaveProperty('data');
    expect(imageRows[1].payload).toMatchObject({ data: 'BBBB', source: 'browser', pageUrl: 'https://x' });
    const rows = [
      ...mockAppendCodingMessage.mock.calls.map((c) => c[0]),
      ...mockUpdateCodingMessage.mock.calls.map((c) => c[1]),
    ].filter((x) => x && Array.isArray(x.parts) && x.role !== 'user');
    const last = rows[rows.length - 1];
    const images = last.parts.filter((p: any) => p.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ mediaType: 'image/png', url, source: 'generated', fileId: 'f1', prompt: 'a fox' });
    expect(images[0]).not.toHaveProperty('data');
    expect(images[1]).toMatchObject({ data: 'BBBB', source: 'browser' });
  });

  it('(c6) the run_completed hook digest quotes the ACCEPTED final, never the head of the streamed text (a struck draft streamed first) (2026-09-08)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'FABRICATED: PR #520 merged, all seven criteria verified.' });
      input.emit('guard_marker', { text: '⚠︎ rejected', struckPrev: true });
      input.emit('tool_call', { name: 'read_file', args: { path: 'x' } });
      input.emit('text', { delta: 'Honest final: nothing merged this run.' });
      return { finalText: 'Honest final: nothing merged this run.', parts: [{ type: 'text', text: 'Honest final: nothing merged this run.' }] };
    });
    await executeClaimedRun(makeClaim());
    const completed = mockEmitHookEventSafe.mock.calls.find((c) => c[1] === 'run_completed');
    expect(completed).toBeDefined();
    expect(completed![2]).toContain('Final answer: Honest final: nothing merged this run.');
    expect(completed![2]).not.toContain('FABRICATED');
  });

  it('(c6b) bf30c5d9: the run_completed hook digest front-loads RUN_OUTCOME — the verdict is extracted from the FULL final even when it lives past the 300-char slice', async () => {
    // The ticket's first-hand shape: a reviewer-style final whose verdict block
    // sits PAST the producer's 300-char "Final answer:" slice (and would also
    // be past truncateSummary's 2000). Pre-fix the wake lost the whole tail.
    const tail = `\n\n${'analysis filler. '.repeat(40)}\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 2\n- BLOCKING: C3 — wildcard lane uncovered\n- BLOCKING: C7 — unverifiable claim\n`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: `Review complete.${tail}`,
      parts: [{ type: 'text', text: `Review complete.${tail}` }],
    }));
    await executeClaimedRun(makeClaim());
    const completed = mockEmitHookEventSafe.mock.calls.find((c) => c[1] === 'run_completed');
    expect(completed).toBeDefined();
    // The status line is FIRST — no downstream cut can take the verdict.
    expect(completed![2].startsWith('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2\n')).toBe(true);
    // 954b7910: line 2 is the ANSWER_MSG_ID (the citable id for the answer this
    // digest quotes) — also front-loaded, then the body.
    expect(completed![2].split('\n')[1].startsWith('ANSWER_MSG_ID: ')).toBe(true);
    expect(completed![2]).toContain('\nCoding run completed.');
    // The sliced body never reaches the tail — the prefix is the ONLY carrier.
    expect(completed![2]).not.toContain('C3');
  });

  it('(c7) a clean final on a run whose own drafts were rejected in-loop does NOT clear a prior plan-store guard strike (2026-09-08 audit)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: 'Honest final after correction.',
      parts: [{ type: 'text', text: 'Honest final after correction.' }],
      guardRejectBacks: 1,
    }));
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    expect(mockClearPlanGuardStrike).not.toHaveBeenCalled();
    expect(mockMarkPlanGuardStrike).not.toHaveBeenCalled(); // the correction was accepted — no NEW strike either
  });

  /* ── e8f71984: degenerate-final detector wiring at BOTH persist seams ──────
   * The unit replay test covers the detector's scoring; these cover the
   * WIRING — that the marker actually lands on the persisted row and the
   * telemetry actually fires, at finalize AND at the crash persist (review
   * finding #1: crash partials were originally unscored). The garbage fixture
   * is quoted from the ticket description (same fragment the replay test
   * tiles); the legit fixture is the mixed-language shape the platform
   * routinely persists and must never flag.
   */
  const E8F71984_GARBAGE_FRAGMENT =
    'top0 ФедT76583057fe3📝Since File0Heading EDFull9 ipcpricingwork64_rhoентыINсsummary' +
    'алфавитSUPPLY42chain_used0моделиREADY559493токенWord748сообщение' +
    '文件0标题ED定价工作64_rhoенты配置就绪模型系统559493线程队列执行完成提交';
  const e8f71984Garbage = (tiles: number): string => {
    const out: string[] = [];
    for (let i = 0; i < tiles; i++) {
      const n = String(i);
      out.push(E8F71984_GARBAGE_FRAGMENT.replace(/0/g, n.length === 1 ? n : n[1]));
    }
    return out.join(' ');
  };
  const persistedAssistantRows = () => [
    ...mockAppendCodingMessage.mock.calls.map((c) => c[0]),
    ...mockUpdateCodingMessage.mock.calls.map((c) => c[1]),
  ].filter((x) => x && typeof x.content === 'string' && x.role !== 'user');
  const degenerateMetricCalls = () =>
    mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'degenerate_final');

  it('(e8f71984-a) a FINALIZED garbage run stamps outputDegenerate on the persisted final and fires the degenerate_final metric', async () => {
    const garbage = e8f71984Garbage(5);
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: garbage,
      parts: [{ type: 'text', text: garbage }],
    }));
    await executeClaimedRun(makeClaim());

    const rows = persistedAssistantRows();
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1];
    expect(last.content).toBe(garbage); // marker-only contract: content is NEVER replaced
    expect(last.metadata.outputDegenerate).toMatchObject({ ticket: 'e8f71984', seam: 'final_persist' });
    expect(last.metadata.outputDegenerate.score.wordRatio).toBeLessThanOrEqual(0.3);

    const metrics = degenerateMetricCalls();
    expect(metrics.length).toBe(1);
    expect(metrics[0][0]).toMatchObject({ kind: 'degenerate_final', sessionId: 's1', runId: 'run1' });
    expect(metrics[0][0].meta).toMatchObject({ ticket: 'e8f71984', seam: 'final_persist' });
  });

  it('(e8f71984-b) a CRASHED run that streamed garbage stamps the marker on the crash persist too (review finding #1)', async () => {
    const garbage = e8f71984Garbage(5);
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: garbage });
      throw new Error('provider connection died'); // crash path → persistPartial(true, crashMetadata)
    });
    await executeClaimedRun(makeClaim());

    const rows = persistedAssistantRows();
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1];
    expect(last.content).toContain(E8F71984_GARBAGE_FRAGMENT.slice(0, 12)); // partial garbage persisted, not replaced
    expect(last.metadata.outputDegenerate).toMatchObject({ ticket: 'e8f71984', seam: 'crash_persist' });

    const metrics = degenerateMetricCalls();
    expect(metrics.length).toBe(1);
    expect(metrics[0][0].meta).toMatchObject({ seam: 'crash_persist' });
  });

  it('(e8f71984-c) a clean MULTILINGUAL final is persisted with NO marker and NO metric (false-positive bar at the seam)', async () => {
    const clean =
      'The migration plan is straightforward. 第一步：freeze write traffic and wait for the replica to catch up. ' +
      'Затем запустите prisma migrate deploy и проверьте, что все миграции применились. ' +
      'Rollback: if the new instance rejects connections, switch back to the old connection string — ' +
      'the schema is forward-compatible, so old code reads it fine. Monitor три показателя: connection count, slow queries, and replication lag. ' +
      'Если задержка превысит пять секунд, pause the cutover until the replica catches up. ' +
      'The window is thirty minutes total, with less than five minutes of write downtime. ' +
      'После релиза держите старый инстанс неделю — он нужен для экстренного отката. ' +
      'Finally, document the result: start time, end time, errors encountered, and fixes applied, so the next migration has a reference.';
    expect(clean.length).toBeGreaterThan(400); // must clear the too-short-to-score floor
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: clean,
      parts: [{ type: 'text', text: clean }],
    }));
    await executeClaimedRun(makeClaim());

    const rows = persistedAssistantRows();
    const last = rows[rows.length - 1];
    expect(last.content).toBe(clean);
    expect(last.metadata.outputDegenerate).toBeUndefined();
    expect(degenerateMetricCalls()).toHaveLength(0);
  });

  it('(d) cancelled at the end (Stop) → finalize cancelled + session ready', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => {
      cancelRun('s1'); // the 2 s cancel poll flips this flag in production
      return { finalText: 'partial', parts: [] };
    });
    await executeClaimedRun(makeClaim());

    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockStore.has(LOCK_KEY)).toBe(false);

    // Fleet supervisor (§3): a cancel counts as run_failed for supervision.
    await new Promise((r) => setImmediate(r));
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      's1', 'run_failed', expect.stringContaining('cancelled'), { runId: 'run1' },
    );
  });

  it('(d2) ALARM-CAUSE-AWARE: a run a CHAT stopped (stop_run → cancel-actor:<runId>) emits run_failed naming cancelledBy, the stopper as the hook actor', async () => {
    mockStore.set('cancel-actor:run1', 'sup-1'); // what stop_run's requestRunCancel wrote
    mockRunCodingAgent.mockImplementationOnce(async () => {
      cancelRun('s1');
      return { finalText: 'partial', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    await new Promise((r) => setImmediate(r));
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      's1', 'run_failed', expect.stringContaining('cancelled'), { runId: 'run1', cause: 'cancelled', cancelledBy: 'sup-1', actorChatId: 'sup-1' },
    );
    // Kill switch: the same stop emits today's `{ runId }`.
    mockEmitHookEventSafe.mockClear();
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    try {
      mockRunCodingAgent.mockImplementationOnce(async () => {
        cancelRun('s1');
        return { finalText: 'partial', parts: [] };
      });
      await executeClaimedRun(makeClaim());
      await new Promise((r) => setImmediate(r));
      expect(mockEmitHookEventSafe).toHaveBeenCalledWith('s1', 'run_failed', expect.stringContaining('cancelled'), { runId: 'run1' });
    } finally { delete process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED; }
  });

  it('(e) shutdown-interrupted WITH a checkpoint written → attempt-neutral interrupted finalize + session NOT set ready', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(CP); // the loop's step-0 checkpoint landed before the SIGTERM
      markRunShutdownInterrupted('s1'); // worker SIGTERM path
      cancelRun('s1');
      return { finalText: '', parts: [] };
    });
    await executeClaimedRun(makeClaim());

    expect(finalizeCall()?.[0].data.status).toBe('interrupted');
    // Attempt-neutral (a graceful deploy interrupt is NOT an attempt — mirrors
    // requeueRun's H1): the claim-time increment is compensated in the SAME
    // atomic update, so repeated deploys can't burn a healthy run's
    // ATTEMPTS_CAP; the checkpoint is RETAINED (resumable by the next worker).
    expect(finalizeCall()?.[0].data.attempts).toEqual({ decrement: 1 });
    expect(finalizeCall()?.[0].data).not.toHaveProperty('checkpoint');
    // Left 'running' — a new worker claims + resumes it (deploy survival).
    expect(mockUpdateSessionState).not.toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockStore.has(LOCK_KEY)).toBe(false);
  });

  it('(e2) H2: shutdown-interrupted with NO checkpoint written → cold-retry queued (no NULL-checkpoint brick)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => {
      // SIGTERM lands in the title-gen/history window — step 0 never checkpointed.
      markRunShutdownInterrupted('s1');
      cancelRun('s1');
      return { finalText: '', parts: [] };
    });
    await executeClaimedRun(makeClaim());

    // NO 'interrupted' (or any terminal) finalize…
    expect(finalizeCall()).toBeUndefined();
    expect(mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'interrupted')).toBeUndefined();
    // …the row goes back to 'queued' via requeueRun: ownership nulled, attempts
    // compensated, not-before backoff — the next worker cold-restarts it from
    // the input (nothing was lost; the run never completed a step).
    const requeue = mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'queued');
    expect(requeue?.[0].where).toEqual({ id: 'run1' });
    expect(requeue?.[0].data).toMatchObject({ status: 'queued', workerId: null, heartbeatAt: null, attempts: { decrement: 1 } });
    expect(requeue?.[0].data.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    // Session NOT flipped ready — the cold-retrying worker owns it.
    expect(mockUpdateSessionState).not.toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockStore.has(LOCK_KEY)).toBe(false);
  });

  it("(f) classify 'fail' (attempts exhausted) → markRunFailed + error event + session ready, WITHOUT ever acquiring the session lock (H1)", async () => {
    await executeClaimedRun(makeClaim({ attempts: ATTEMPTS_CAP + 1 }));

    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
    // H1 classify-before-lock: the fail path never touches the session run-lock
    // (acquireSessionRunLock's only observable channel is the NX SET on LOCK_KEY).
    expect(redisSet().mock.calls.filter((c: any[]) => c[0] === LOCK_KEY)).toEqual([]);
    const failed = mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'failed');
    expect(failed?.[0].where).toEqual({ id: 'run1' });
    expect(failed?.[0].data.error).toBe('attempts exhausted');
    expect(mockPrisma.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runId: 'run1', seq: 1, type: 'error',
        payload: expect.objectContaining({ message: 'attempts exhausted' }),
      }),
    }));
    // Forensics fix 4: the give-up ALWAYS writes the deterministic journal
    // row; with no recorded cause it says so honestly (cause undefined).
    expect(mockWriteAttemptsExhaustedEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', runId: 'run1', attempts: ATTEMPTS_CAP + 1, cause: undefined,
    }));
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockStore.has(LOCK_KEY)).toBe(false);
  });

  it("(f2) forensics fix 4: an attempts-exhausted give-up persists the recorded attempt-cause chain in error + the error event + a deterministic journal row", async () => {
    const CHAIN = 'container OOM-killed during npm install | attempt 2: worker lease expired with no finalizer';
    await executeClaimedRun(makeClaim({ attempts: ATTEMPTS_CAP + 1, lastError: CHAIN }));

    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    // The persisted error names the WHY — 'attempts exhausted: <chain>' with
    // the FIRST cause at the head (the ~300-char cap truncates the tail).
    const failed = mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'failed');
    expect(failed?.[0].where).toEqual({ id: 'run1' });
    expect(failed?.[0].data.error).toBe(`attempts exhausted: ${CHAIN}`);
    // The durable error event carries the same cause for SSE tailers.
    expect(mockPrisma.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runId: 'run1', type: 'error',
        payload: expect.objectContaining({ message: `attempts exhausted: ${CHAIN}` }),
      }),
    }));
    // The harness-written journal row lands, naming the cause + trigger.
    expect(mockWriteAttemptsExhaustedEntryAsync).toHaveBeenCalledTimes(1);
    expect(mockWriteAttemptsExhaustedEntryAsync).toHaveBeenCalledWith({
      chatId: 's1', runId: 'run1', triggerKind: 'schedule',
      attempts: ATTEMPTS_CAP + 1, cause: CHAIN,
    });
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
  });

  it("(f3) forensics fix 4: a very long cause chain is truncated from the TAIL — the first cause survives in the give-up error", async () => {
    const FIRST = 'attempt 1: git clone failed: remote hung up unexpectedly';
    const CHAIN = `${FIRST} | ${'x'.repeat(500)}`;
    await executeClaimedRun(makeClaim({ attempts: ATTEMPTS_CAP + 1, lastError: CHAIN }));

    const failed = mockPrisma.agentRun.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'failed');
    expect(failed?.[0].data.error.startsWith(`attempts exhausted: ${FIRST}`)).toBe(true);
    expect(failed?.[0].data.error.length).toBeLessThanOrEqual('attempts exhausted: '.length + 300);
  });

  it("(r4) forensics fix 4: a re-claimed run that fails AGAIN appends its cause onto the first attempt's stash (first cause preserved, never overwritten)", async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => { throw new Error('second failure: provider exploded'); });
    await executeClaimedRun(makeClaim({ attempts: 2, lastError: 'attempt 1 lost its worker (lease expired with no finalizer — process crash/OOM, hang, or a harness exception)' }));

    const failed = finalizeCall();
    expect(failed?.[0].data.status).toBe('failed');
    expect(failed?.[0].data.error).toBe(
      'attempt 1 lost its worker (lease expired with no finalizer — process crash/OOM, hang, or a harness exception) | attempt 2: second failure: provider exploded',
    );
    // The journal/hook digests still ride THIS attempt's cause (unchained).
    expect(mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal).toBe('Run failed: second failure: provider exploded');
  });

  it('(r5) forensics fix 4: a first-attempt failure keeps its plain error text (no chain prefix when there is no prior cause)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => { throw new Error('provider exploded'); });
    await executeClaimedRun(makeClaim());

    expect(finalizeCall()?.[0].data.status).toBe('failed');
    expect(finalizeCall()?.[0].data.error).toBe('provider exploded');
  });

  it('(g) LEG 2c: a mailbox resolution resolves an awaiting approval/question (drain tick applied)', async () => {
    jest.useFakeTimers();
    try {
      let decision: string | undefined;
      let answer: string | null | undefined;
      mockRunCodingAgent.mockImplementationOnce(async () => {
        // The agent parks inside the worker-local registries…
        const dP = awaitApproval('a1', 's1');
        const qP = awaitAnswer('q1', 's1');
        // …the WEB endpoints RPUSH the session's mailbox (cross-process)…
        await publishApprovalResolution('s1', 'a1', 'allow');
        await publishQuestionResolution('s1', 'q1', 'answer-42');
        // …and the executor's 2 s poll drains + applies them.
        await jest.advanceTimersByTimeAsync(2_000);
        decision = await dP;
        answer = await qP;
        return { finalText: 'done', parts: [] };
      });
      await executeClaimedRun(makeClaim());

      expect(decision).toBe('allow');
      expect(answer).toBe('answer-42');
      // Both waits exited → the pending-presence keys were unpublished.
      expect(mockStore.has('coding:approval:pending:a1')).toBe(false);
      expect(mockStore.has('coding:question:pending:q1')).toBe(false);
      expect(finalizeCall()?.[0].data.status).toBe('completed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('(f46) a 0-row lease heartbeat (run row gone — chat deleted mid-run) cancels the zombie execution at the next step boundary', async () => {
    // FO firing 46 (chat 5a87b912, 2026-09-29): the executor discarded the
    // heartbeat updateMany count, so a cascade-deleted agent_runs row kept
    // executing ~90 min of tools with every receipt/journal write failing the
    // chat FK. Pin the zombie-stop release path: cancel + parked-wait release.
    //
    // Ticket 65af5656 (2026-11-03): the count is now CONFIRMED before it is
    // acted on — the row is read back (findUnique → null = genuinely gone) and
    // absence must hold across zombieConfirmMisses() beats, so this test
    // advances TWO lease ticks. A row that merely flipped status stands down
    // (see the sibling cases below and run-row-liveness.65af5656.test.ts).
    jest.useFakeTimers();
    try {
      let decision: string | undefined;
      let answer: string | null | undefined = 'unset';
      mockRunCodingAgent.mockImplementationOnce(async () => {
        const dP = awaitApproval('a3', 's1');
        const qP = awaitAnswer('q3', 's1');
        // The chat was deleted mid-run: the heartbeat touches 0 rows AND the
        // row really is absent. One-shot mocks only — a permanent
        // mockResolvedValue would leak into every later case in this file
        // (review finding N2, 65af5656).
        mockPrisma.agentRun.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        mockPrisma.agentRun.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
        await jest.advanceTimersByTimeAsync(2.5 * 60 * 1000); // tick 1: absence recorded, no cancel yet
        await jest.advanceTimersByTimeAsync(2.5 * 60 * 1000); // tick 2: confirmed → release
        decision = await dP; // released NOW by the zombie-stop, not the 14-min auto-deny
        answer = await qP;   // released NOW, not the 60-min timeout
        return { finalText: 'partial', parts: [] };
      });
      await executeClaimedRun(makeClaim());

      expect(decision).toBe('deny');   // parked approval denied by the zombie-stop
      expect(answer).toBeNull();       // parked ask_user resolved null
      expect(mockStore.has('coding:approval:pending:a3')).toBe(false);
      expect(mockStore.has('coding:question:pending:q3')).toBe(false);
      expect(finalizeCall()?.[0].data.status).toBe('cancelled'); // the cooperative flag finalizes cancelled
    } finally {
      jest.useRealTimers();
    }
  });

  it('(65af5656) a 0-row heartbeat whose row was flipped OFF running is NOT a deleted chat — the lane survives', async () => {
    // The reproduction: a deploy/drain wave marked live rows 'interrupted'
    // (and/or a racing finalize moved them), so updateMany touched 0 rows
    // while the chat and its work were completely intact. The old guard
    // cancelled every such run — 64 zombie_run_stopped rows across 8 lanes in
    // ~50 ms at 09:15:44.96–45.03Z, and two Schooltime lanes finalized
    // "(Stopped.)" 250 ms apart.
    jest.useFakeTimers();
    try {
      let answer: string | null | undefined = 'unset';
      let stillParked = false;
      mockRunCodingAgent.mockImplementationOnce(async () => {
        const qP = awaitAnswer('q4', 's1');
        // Exists, but no longer 'running' (a racing finalize / re-queue).
        // One-shot: a permanent mock would leak into later cases (N2).
        mockPrisma.agentRun.findUnique.mockResolvedValueOnce({ status: 'completed' });
        mockPrisma.agentRun.updateMany.mockResolvedValueOnce({ count: 0 });
        await jest.advanceTimersByTimeAsync(2.5 * 60 * 1000);
        stillParked = mockStore.has('coding:question:pending:q4');
        // Release the wait ourselves so the run can finish this test cleanly.
        mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
        answer = null;
        return { finalText: 'done', parts: [] };
      });
      await executeClaimedRun(makeClaim());
      expect(stillParked).toBe(true);  // the guard stood down — the park was never released
    } finally {
      jest.useRealTimers();
    }
  });

  it('(h) LEG 2c: a Stop (cancel key) ALSO releases pending approval/question waits immediately', async () => {    jest.useFakeTimers();
    try {
      let decision: string | undefined;
      let answer: string | null | undefined = 'unset';
      mockRunCodingAgent.mockImplementationOnce(async () => {
        const dP = awaitApproval('a2', 's1');
        const qP = awaitAnswer('q2', 's1');
        await requestRunCancel('s1'); // the web POST /stop
        await jest.advanceTimersByTimeAsync(2_000); // the poll takes the key
        decision = await dP; // released NOW, not after the 14-min auto-deny
        answer = await qP;   // released NOW, not after the 60-min timeout
        return { finalText: 'partial', parts: [] };
      });
      await executeClaimedRun(makeClaim());

      expect(decision).toBe('deny'); // parked approval denied by the Stop
      expect(answer).toBeNull();     // parked ask_user resolved null by the Stop
      expect(mockStore.has('coding:approval:pending:a2')).toBe(false);
      expect(mockStore.has('coding:question:pending:q2')).toBe(false);
      expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('(i) #86: final transcript persist failure (P2025 — row/chat deleted mid-run) does NOT fail an otherwise-successful run', async () => {
    // A text event mid-run creates the partial assistant row (first persist is
    // unthrottled — lastPersist starts at 0), so the finalize takes the
    // updateCodingMessage path…
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'working…' });
      return { finalText: 'done', parts: [{ type: 'text', text: 'done' }] };
    });
    // …but the transcript row (or its chat) is gone by finalize — Prisma P2025
    // (e.g. the user deleted the chat while the run was in flight).
    mockUpdateCodingMessage.mockRejectedValueOnce(
      Object.assign(new Error('Record to update not found.'), { code: 'P2025' }),
    );

    await executeClaimedRun(makeClaim());

    // Transcript persistence is best-effort — the RUN's outcome must not depend
    // on it (the agent's work is already applied). Same policy as persistPartial.
    expect(mockUpdateCodingMessage).toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
    expect(finalizeCall()?.[0].data).not.toHaveProperty('error');
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
  });

  it('(j) title repair: re-claim with a placeholder title (opening-turn crash window) generates one from the first user message', async () => {
    // The d5940cb2 scenario: a deploy SIGTERM landed between markInputConsumed
    // and the opening-turn title block, so the session is stuck on the raw-slice
    // placeholder and every later claim is non-opening (inputConsumed=true).
    const firstUser = 'Fix the login bug in the authentication flow and add tests';
    mockGetCodingSessionTitle.mockResolvedValue(firstUser.slice(0, 43)); // raw slice, no ellipsis
    mockGetFirstUserCodingMessage.mockResolvedValue(firstUser);

    await executeClaimedRun(makeClaim({ input: { message: 'go on', userId: 'u1' }, inputConsumed: true }));

    // Exactly one title write: the LLM title replacing the placeholder (the
    // non-opening claim never writes the raw-slice placeholder itself).
    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toHaveLength(1);
    expect(titleWrites[0]).toEqual(['s1', { title: 'Generated Title' }]);
  });

  it('(k) title repair never overwrites a real (user-chosen or LLM) title', async () => {
    // Proper title (beforeEach default) even though a first user message exists.
    mockGetFirstUserCodingMessage.mockResolvedValue('Fix the login bug in the authentication flow and add tests');

    await executeClaimedRun(makeClaim({ input: { message: 'go on', userId: 'u1' }, inputConsumed: true }));

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toHaveLength(0);
  });

  it('(l) title repair yields to a user rename that lands during the generate window', async () => {
    // First read sees the placeholder; by the post-generate recheck the user has
    // renamed — the repair must NOT clobber the rename (cheap compare-and-set).
    const firstUser = 'Fix the login bug in the authentication flow and add tests';
    mockGetCodingSessionTitle
      .mockResolvedValueOnce(firstUser.slice(0, 43)) // initial read: placeholder
      .mockResolvedValue('My renamed session');       // recheck: user renamed mid-generate
    mockGetFirstUserCodingMessage.mockResolvedValue(firstUser);

    await executeClaimedRun(makeClaim({ input: { message: 'go on', userId: 'u1' }, inputConsumed: true }));

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toHaveLength(0);
  });

  it('(m) title-gen blocking window is deliberately BELOW the inner LLM timeout (inversion retired)', () => {
    // generateTitle's internal LLM timeout is 15000ms (moonshot.integration.ts,
    // utilityChat { timeout: 15000 } — raised from 8000 on 2026-08-13). The 12s
    // wait therefore CANNOT cover slow chains — and no longer needs to: it
    // bounds only how long first output waits on the title, and a chain that
    // outlives it lands via generateSessionTitle's background continuation
    // (ticket 8db1bcb3, the (t1) case below). The pre-continuation inversion
    // (race shorter than the inner timeout ⇒ every slow title silently
    // dropped) is retired by design.
    expect(TITLE_GEN_WAIT_MS).toBe(12_000);
    expect(TITLE_GEN_WAIT_MS).toBeLessThan(15_000);
  });

  it('(t1) slow title chain still lands: the 12s wait bounds BLOCKING, not the write (ticket 8db1bcb3)', async () => {
    // The bb759ef9 scenario: the opening turn's title chain outlived the 12s
    // wait (provider load) and race-then-drop kept the raw-slice placeholder
    // for 17 minutes until a LATER claim's repair. Now the in-flight chain
    // continues off the critical path and its result is still CAS-written.
    jest.useFakeTimers();
    try {
      let resolveTitle!: (t: string) => void;
      mockGenerateTitle.mockImplementationOnce(() => new Promise<string>(res => { resolveTitle = res; }));
      mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
      // First read (sticky-spawn check, 15fd6063): the spawn default placeholder.
      // Write-time CAS recheck: the placeholder this run wrote ('build it').
      mockGetCodingSessionTitle
        .mockResolvedValueOnce('Untitled session')
        .mockResolvedValue('build it');

      const exec = executeClaimedRun(makeClaim()); // opening turn (inputConsumed: false)
      // Progress the executor to the title block (its pre-title awaits are
      // mocked microtasks) so the race timer exists before we advance it.
      for (let i = 0; i < 500 && !mockGenerateTitle.mock.calls.length; i++) await Promise.resolve();
      expect(mockGenerateTitle).toHaveBeenCalled();
      // The timer wins the race — then the chain settles AFTER the window.
      await jest.advanceTimersByTimeAsync(TITLE_GEN_WAIT_MS + 1);
      resolveTitle('Generated Title');
      await exec;
      // Flush the background continuation (then → CAS read → write → emit).
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
      expect(titleWrites).toEqual([
        ['s1', { title: 'build it' }],         // immediate placeholder
        ['s1', { title: 'Generated Title' }],  // the slow chain landed anyway
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('(t2) slow title chain yields to a user rename landing in the extended window', async () => {
    jest.useFakeTimers();
    try {
      let resolveTitle!: (t: string) => void;
      mockGenerateTitle.mockImplementationOnce(() => new Promise<string>(res => { resolveTitle = res; }));
      mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
      mockGetCodingSessionTitle
        .mockResolvedValueOnce('Untitled session') // sticky-spawn check (15fd6063)
        .mockResolvedValue('My renamed session'); // CAS recheck at write time

      const exec = executeClaimedRun(makeClaim());
      for (let i = 0; i < 500 && !mockGenerateTitle.mock.calls.length; i++) await Promise.resolve();
      expect(mockGenerateTitle).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(TITLE_GEN_WAIT_MS + 1);
      resolveTitle('Generated Title');
      await exec;
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
      expect(titleWrites).toEqual([['s1', { title: 'build it' }]]); // placeholder only — the rename won
    } finally {
      jest.useRealTimers();
    }
  });

  it('(t3) opening-turn fast title yields to a user rename inside the blocking window', async () => {
    // The repair path's (l) compare-and-set discipline, now on the opening
    // turn: the recheck at write time sees a rename, not our placeholder.
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle
      .mockResolvedValueOnce('Untitled session') // sticky-spawn check (15fd6063)
      .mockResolvedValue('My renamed session');

    await executeClaimedRun(makeClaim());

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([['s1', { title: 'build it' }]]); // placeholder only
  });

  it('(t4) opening-turn fast title still writes while the stored title is the placeholder', async () => {
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle
      .mockResolvedValueOnce('Untitled session') // sticky-spawn check (15fd6063)
      .mockResolvedValue('build it'); // the placeholder this run wrote

    await executeClaimedRun(makeClaim());

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([
      ['s1', { title: 'build it' }],
      ['s1', { title: 'Generated Title' }],
    ]);
  });

  it('(t5) sticky spawn title (ticket 15fd6063): an opening turn on a session spawned with an EXPLICIT title keeps it — no placeholder write, no LLM title, no title write at all', async () => {
    // The incident (2026-09-24, canlegal-bench supervisor 615723ba): the
    // supervisor spawned session 11449a0a via start_coding_session with the
    // explicit title "Mac citator harvest 371 + rescore + docs/splash/UI
    // refresh"; the first run's opening turn OVERWROTE it with a placeholder
    // slice and then the LLM title ("Post-Sweep Acceptance Criteria
    // Verified…" — a verdict phrase, not the session's purpose). The owner
    // reads the sidebar and can't tell what's running. An explicit spawn
    // title matches no looksLikePlaceholderTitle marker, so it is STICKY.
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle.mockResolvedValue('Mac citator harvest 371 + rescore + docs/splash/UI refresh');

    await executeClaimedRun(makeClaim());

    // NO title write of any kind: not the placeholder slice, not the LLM
    // title — the explicit spawn title survives the opening turn.
    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([]);
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('(t6) sticky spawn title: a SHORT but real explicit title (<20 chars) is kept too — the ≥20-char floor only guards the REPAIR heuristic, not the opening-turn stickiness check', async () => {
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle.mockResolvedValue('Fix login bug');

    await executeClaimedRun(makeClaim());

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([]);
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it("(t7) interactive 'New chat' title (lowercase c — the frontend create constant) is placeholder-shaped: the derive path runs, NOT stickiness (review F1)", async () => {
    // frontend page.tsx:2308 + projects/[id]:104,:747 all pass
    // { title: 'New chat' } — the common interactive path. A case-sensitive
    // 'New Chat' list entry missed it, and the sticky guard would have kept
    // the stock frontend title forever (title generation silently disabled
    // for every user-created coding chat).
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle
      .mockResolvedValueOnce('New chat') // sticky-spawn check (15fd6063)
      .mockResolvedValue('build it'); // CAS recheck: the placeholder this run wrote

    await executeClaimedRun(makeClaim());

    // The derive path runs: placeholder slice then the LLM title.
    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([
      ['s1', { title: 'build it' }],
      ['s1', { title: 'Generated Title' }],
    ]);
  });

  // ── Ticket 161d39e9: machine-launched session titles describe the TASK ────
  // Root cause pair, both replayed below: (1) an explicit spawn title that
  // echoes its own task brief is a ≥20-char SUBSTRING of the first message, so
  // looksLikePlaceholderTitle's slice rule misread it as scaffolding and the
  // LLM verdict-phrase overwrote it (the 11449a0a incident); (2) a spawned
  // child's first prompt opens with the [PARENT SESSION CONTEXT] digest — the
  // PARENT's run-outcome lines — and every title surface seeded from the raw
  // message (placeholder slice, LLM seed, crash-repair seed) titled the
  // session after the parent's last outcome ("post-sweep acceptance criteria
  // verified") instead of the child's task.

  const PARENT_DIGEST = [
    '[PARENT SESSION CONTEXT — what the session that spawned you recently did, decided, and learned; newest first]',
    '- 2026-09-24: Mac citator harvest sweep → post-sweep acceptance criteria verified across 371 cases',
    '  Decisions: keep the splash refresh; rescore pinned',
    '',
    '',
  ].join('\n');
  const CHILD_TASK = 'Mac citator harvest 371 + rescore + docs/splash/UI refresh';

  it('(t8) titleSeedFromMessage strips the [PARENT SESSION CONTEXT] digest — the seed is the TASK, not the parent outcome lines (161d39e9)', () => {
    // The verbatim incident shape: digest + blank line + task brief. The seed
    // must be the task; the parent's "- <date>: … → post-sweep acceptance
    // criteria verified" outcome line must NOT lead it.
    expect(titleSeedFromMessage(`${PARENT_DIGEST}${CHILD_TASK}`)).toBe(CHILD_TASK);
    // Schedule-delivered: the firing header sits BEFORE the digest (position-0
    // header stripping alone would eat the digest's header line and strand its
    // outcome body — the lenient locate-anywhere cut exists for exactly this).
    const firing = '[MACHINE-TRIGGERED RUN — a scheduled firing of this chat]\n\n';
    expect(titleSeedFromMessage(`${firing}${PARENT_DIGEST}${CHILD_TASK}`)).toBe(CHILD_TASK);
    // Agent-send-delivered: same, with the agent-send provenance header first.
    const agentSend = '[AGENT-SENT MESSAGE — from chat "Sup" (12345678)]\n\n';
    expect(titleSeedFromMessage(`${agentSend}${PARENT_DIGEST}${CHILD_TASK}`)).toBe(CHILD_TASK);
    // A task brief that merely RESEMBLES the digest is returned unchanged —
    // strict grammar (entry lines + exactly one blank separator) governs, and
    // a non-matching shape never mangles real text.
    const plain = 'Do the harvest for [PARENT SESSION CONTEXT — test] and report';
    expect(titleSeedFromMessage(plain)).toBe(plain);
    // No digest at all: the pre-161d39e9 header-strip behavior is preserved.
    expect(titleSeedFromMessage(`${firing}${CHILD_TASK}`)).toBe(CHILD_TASK);
  });

  it('(t9) opening turn on an UNTITLED spawned child (digest-prefixed first prompt): the placeholder + LLM seed BOTH come from the task, never the parent outcomes (161d39e9)', async () => {
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle
      .mockResolvedValueOnce('Untitled session') // sticky-spawn check
      .mockResolvedValue(CHILD_TASK.slice(0, 60)); // CAS recheck: the placeholder this run wrote

    await executeClaimedRun(makeClaim({ input: { message: `${PARENT_DIGEST}${CHILD_TASK}`, userId: 'u1' } }));

    // Placeholder = the task's first 60 chars (not the digest's outcome line).
    const placeholderWrite = mockUpdateSessionState.mock.calls.find((c: any[]) => c[1]?.title === CHILD_TASK.slice(0, 60));
    expect(placeholderWrite).toBeTruthy();
    // The LLM chain is seeded with the TASK (digest stripped), never the raw
    // parent-outcome text.
    expect(mockGenerateTitle).toHaveBeenCalledWith(CHILD_TASK, '');
  });

  it('(t10) explicit spawn title that ECHOES its own task brief is sticky by PROVENANCE — the substring false positive is closed (161d39e9)', async () => {
    // The 11449a0a incident's residual hole: the spawner passed the explicit
    // title "Mac citator harvest 371 + rescore + docs/splash/UI refresh" and
    // the first prompt CONTAINED that same brief (as part of the task), so
    // looksLikePlaceholderTitle(title, seed) saw a ≥20-char substring and
    // classified a real explicit title as scaffolding. titleSource
    // 'spawn-param' (stamped by startCodingSession) wins: no first-message
    // compare, the title is kept, ZERO title writes.
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle.mockResolvedValue(CHILD_TASK);
    mockGetCodingSessionTitleSource.mockResolvedValue('spawn-param');

    await executeClaimedRun(makeClaim({ input: { message: `Do this: ${CHILD_TASK}`, userId: 'u1' } }));

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([]);
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('(t11) provenance stickiness does NOT rescue a DEGENERATE explicit title — stock/empty/ellipsis titles still derive (161d39e9, guards the t7 class)', async () => {
    mockCountCodingTranscriptMessages.mockResolvedValueOnce(0); // opening turn
    mockGetCodingSessionTitle
      .mockResolvedValueOnce('New chat') // an explicit-but-stock title
      .mockResolvedValue('build it'); // CAS recheck: the placeholder this run wrote
    mockGetCodingSessionTitleSource.mockResolvedValue('spawn-param');

    await executeClaimedRun(makeClaim());

    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([
      ['s1', { title: 'build it' }],
      ['s1', { title: 'Generated Title' }],
    ]);
  });

  it('(t12) crash-window repair: a digest-prefixed first message seeds the LLM from the TASK; an explicit spawn title is never "repaired" away (161d39e9)', async () => {
    // The opening-turn crash window (case (j)'s scenario) on a spawned child:
    // the repair's LLM seed must strip the digest, and provenance stickiness
    // must hold on the NON-opening claim too.
    const firstUser = `${PARENT_DIGEST}${CHILD_TASK}`;
    mockGetCodingSessionTitle.mockResolvedValue(CHILD_TASK.slice(0, 30)); // a placeholder-looking slice
    mockGetFirstUserCodingMessage.mockResolvedValue(firstUser);
    mockGetCodingSessionTitleSource.mockResolvedValue('spawn-param');

    await executeClaimedRun(makeClaim({ input: { message: 'go on', userId: 'u1' }, inputConsumed: true }));

    // spawn-param + a real (non-degenerate) title → no repair write at all.
    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([]);
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('(t13) crash-window repair on an UNTITLED spawned child: the repair LLM seed strips the digest (161d39e9)', async () => {
    const firstUser = `${PARENT_DIGEST}${CHILD_TASK}`;
    mockGetCodingSessionTitle.mockResolvedValue(firstUser.slice(0, 43)); // placeholder written from the RAW digest-prefixed text
    mockGetFirstUserCodingMessage.mockResolvedValue(firstUser);
    mockGetCodingSessionTitleSource.mockResolvedValue(null); // untitled spawn

    await executeClaimedRun(makeClaim({ input: { message: 'go on', userId: 'u1' }, inputConsumed: true }));

    // The repair generates, but its seed is the TASK — not the raw firstUser
    // that opens with the parent's outcome line.
    expect(mockGenerateTitle).toHaveBeenCalledWith(CHILD_TASK, '');
    const titleWrites = mockUpdateSessionState.mock.calls.filter((c: any[]) => c[1] && 'title' in c[1]);
    expect(titleWrites).toEqual([['s1', { title: 'Generated Title' }]]);
  });

  it('(p) evidence guard (feedback be0b5271): a schedule run with a phantom finalText gets the annotation persisted; the guard sees triggerKind + parts', async () => {
    const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.';
    const agentParts = [
      { type: 'tool_call', name: 'update_plan', args: {} }, // the ONLY tool call: non-evidence
      { type: 'text', text: PHANTOM },
    ];
    const agentToolTexts = ['[34/55] gpqa-101 r0 PASS 12.4s — full model-facing tool text'];
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: PHANTOM, parts: agentParts, toolTexts: agentToolTexts }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n[HARNESS EVIDENCE GUARD] zero evidence-bearing tool calls — NO FRESH EVIDENCE this turn; claims UNVERIFIED`,
      notes: ['guard-1'],
    }));

    // Schedule trigger: an input with NO userTurnAt and no explicit origin.
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    expect(mockApplyCompletionClaimGuard).toHaveBeenCalledTimes(1);
    const arg = mockApplyCompletionClaimGuard.mock.calls[0][0];
    expect(arg).toMatchObject({
      finalText: PHANTOM, triggerKind: 'schedule', resumed: false,
      userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github',
    });
    expect(arg.parts).toBe(agentParts); // the run's transcript parts, by reference
    expect(arg.toolTexts).toBe(agentToolTexts); // full-fidelity GUARD 4 haystack (review round-4 B-1)
    // CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27): the earlier-run pool rides
    // the guard call (empty by default) — fetched over 7 d for the chat.
    expect(arg.carriedReceipts).toEqual([]);
    // Wiring pin (review MINOR 3, sub-session 6bdc4019, ticket dc636d0c): the
    // finalize guard call carries the goal-board resolver for the fence
    // union leg — same pin as the reject-back envelope above.
    expect(typeof arg.goalIdsExist).toBe('function');
    expect(typeof arg.todoIdsExist).toBe('function');
    expect(mockGetRecentChatReceipts).toHaveBeenCalledWith(expect.any(String), 7 * 24 * 60 * 60 * 1000);

    // The annotation landed on the persisted assistant message (content + a text part).
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].content).toContain(PHANTOM);
    expect(appended?.[0].content).toContain('HARNESS EVIDENCE GUARD');
    expect(appended?.[0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('HARNESS EVIDENCE GUARD') }),
    ]));
    expect(finalizeCall()?.[0].data.status).toBe('completed');

    // The journal entry + hook summary ride the ANNOTATED text too (consistency).
    expect(mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal).toContain('HARNESS EVIDENCE GUARD');

    // Loop telemetry (audit #12): a clean machine final records guard_miss —
    // carrying the run stamp (remediation P0 N6); the VERDICT lane recorded
    // no strike (no meta.kinds row)…
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_miss', sessionId: 's1', runId: 'run1',
      stamp: expect.objectContaining({ profile: 'coding' }),
    }));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ kinds: expect.anything() }),
    }));
    // (The P4 numeric-provenance lane was deleted in build 2026-10-08 S-2 — no seam row.)
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'numeric_provenance' }),
    }));
  });

  it('(q) evidence guard throw: non-fatal — the run still finalizes completed with the ORIGINAL finalText', async () => {
    const ORIGINAL = 'Merged PR #281, sha 0b8d237e';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: ORIGINAL, parts: [{ type: 'text', text: ORIGINAL }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async () => { throw new Error('guard exploded'); });

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    expect(finalizeCall()?.[0].data.status).toBe('completed');
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].content).toBe(ORIGINAL); // unannotated
    expect(mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal).toBe(ORIGINAL);
  });

  it('(s) run receipts: agent input carries the claimed run id; the guard receives in-process ∪ prior-attempt rows, deduped by id (in-process first)', async () => {
    const inProcess = {
      id: 'rcpt-inproc', chatId: 's1', runId: 'run1', tool: 'git_push', ok: true,
      ids: { branch: 'main' }, inputHash: null, outputHash: null, createdAt: new Date(),
    };
    const prior = {
      id: 'rcpt-prior', chatId: 's1', runId: 'run1', tool: 'git_commit', ok: true,
      ids: { sha: '84fe3ae0' }, inputHash: null, outputHash: null, createdAt: new Date(),
    };
    // The racing fire-and-forget insert of the SAME receipt must not duplicate it.
    const racedDupe = { ...inProcess };
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: 'done', parts: [{ type: 'text', text: 'done' }], receipts: [inProcess],
    }));
    mockGetRunReceipts.mockResolvedValue([prior, racedDupe]);

    await executeClaimedRun(makeClaim());

    // runId passthrough: the durable row id rides the agent input.
    expect(mockRunCodingAgent.mock.calls[0][0].runId).toBe('run1');

    // Union at the guard seam: prior-attempt read is keyed on the claimed id;
    // in-process rows lead, the raced duplicate is dropped.
    expect(mockGetRunReceipts).toHaveBeenCalledWith('run1');
    const arg = mockApplyCompletionClaimGuard.mock.calls[0][0];
    expect(arg.receipts.map((r: any) => r.id)).toEqual(['rcpt-inproc', 'rcpt-prior']);
    expect(arg.receipts[0]).toBe(inProcess); // by reference, not re-hydrated
  });

  it('(s2) run receipts: a prior-attempt read failure degrades to the in-process set alone (guard still gets receipts)', async () => {
    const inProcess = {
      id: 'rcpt-inproc', chatId: 's1', runId: 'run1', tool: 'verify', ok: true,
      ids: { passed: true, failedStage: null }, inputHash: null, outputHash: null, createdAt: new Date(),
    };
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: 'done', parts: [{ type: 'text', text: 'done' }], receipts: [inProcess],
    }));
    mockGetRunReceipts.mockRejectedValue(new Error('db down'));

    await executeClaimedRun(makeClaim());

    expect(finalizeCall()?.[0].data.status).toBe('completed');
    const arg = mockApplyCompletionClaimGuard.mock.calls[0][0];
    expect(arg.receipts.map((r: any) => r.id)).toEqual(['rcpt-inproc']);
  });

  it('(r) REPLACE lane (ticket be199e93): a machine run whose verdict has findings gets its final REPLACED — honest top, quoted original, honest journal/hook, verdict row + integrity ticket', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11: observe-only by default)
    const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: PHANTOM,
      parts: [{ type: 'text', text: PHANTOM }],
      // fb64368a: the scenario carries a receipt so this pin stays about the
      // EVIDENCE_GUARD_ENFORCE=1 REPLACE lane; the zero-receipt fabrication
      // class (the run executed nothing) has its own dedicated suite below.
      receipts: [{ id: 'rrrr1111-2222-3333-4444-555566667777', chatId: 's1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() }],
    }));
    const FOOTER = '🔍 Harness claim verification (verified-at 2026-08-22T00:00:00.000Z):\n• PR #224 — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated';
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n[HARNESS EVIDENCE GUARD] note\n\n${FOOTER}`,
      notes: ['[HARNESS EVIDENCE GUARD] note', FOOTER],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [] },
    }));

    // Schedule trigger (no userTurnAt, no origin) — the replace lane is machine-only.
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // The persisted assistant CONTENT leads with the honest harness banner;
    // the confabulated original survives ONLY inside the quoted audit section.
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    const content: string = appended?.[0].content;
    expect(content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(content).toContain('NOT DONE');
    expect(content).toContain('fabricated PR claims (GitHub 404): #224');
    expect(content).toContain('NO such PR (404)'); // the real footer, in the honest section
    const begin = content.indexOf('--- BEGIN UNVERIFIED RUN OUTPUT');
    expect(begin).toBeGreaterThan(-1);
    expect(content.slice(0, begin)).not.toContain('squash-merged'); // nothing confabulated above the quote
    expect(content).toContain(`> ${PHANTOM}`);

    // The parts-rendered transcript ALSO leads honest (notice unshifted first)
    // — as a typed guard MARKER, with the convicted original STRUCK (2026-09-08).
    expect(appended?.[0].parts[0]).toMatchObject({ type: 'text', marker: 'guard' });
    expect(appended?.[0].parts[0].text).toContain("FINAL ANSWER WAS REPLACED");
    expect(appended?.[0].parts[appended[0].parts.length - 1]).toMatchObject({ type: 'text', text: PHANTOM, struck: true });

    // Journal rides the DETERMINISTIC VERDICT line — never the wrapper with
    // the quoted fabrication (2026-08-30 recurrence fix: the wrapper's audit
    // quote re-seeded the phantom into cross-run memory).
    const journalFinal: string = mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal;
    expect(journalFinal).toContain('evidence guard replaced');
    expect(journalFinal).toContain('NOT DONE');
    expect(journalFinal).not.toContain('squash-merged');
    expect(journalFinal).not.toContain('84fe3ae0');
    // The coding-memory fold gets the same verdict line (post-guard), never the phantom.
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget fold import
    expect(mockUpdateCodingMemoryAsync).toHaveBeenCalledTimes(1);
    const memSummary: string = mockUpdateCodingMemoryAsync.mock.calls[0][0].assistantSummary;
    expect(memSummary).toContain('evidence guard replaced');
    expect(memSummary).not.toContain('squash-merged');
    expect(memSummary).not.toContain('84fe3ae0');
    // Harness-owned verdict row (two-lane hardening) + deduped integrity ticket.
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', triggerKind: 'schedule', unprovenKinds: ['pr_merged'], fabricatedPrs: [224],
    }));
    // Loop telemetry (audit #12): a struck machine final records guard_strike
    // with the finding classes in meta.kinds (never guard_miss).
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', sessionId: 's1', runId: 'run1',
      meta: { seam: 'final_verdict', kinds: ['unproven_completion', 'fabricated_pr'], outcome: 'enforced' },
      stamp: expect.objectContaining({ profile: 'coding', triggerKind: 'schedule' }),
    }));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'guard_miss' }));
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget ticket import
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ area: 'fleet-integrity', type: 'mishap' }));

    // The run_completed hook summary is the honest verdict line — a downstream
    // wake/digest can never quote the fabrication as fact.
    await new Promise((r) => setImmediate(r));
    const hook = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'run_completed');
    expect(hook?.[2]).toContain('REPLACED its final answer');
    expect(hook?.[2]).toContain('NOT DONE');
    expect(hook?.[2]).not.toContain('squash-merged');
    // H1: the strike poisons the plan store (self-reported step notes) — marked…
    expect(mockMarkPlanGuardStrike).toHaveBeenCalledWith('s1', expect.any(String));
    expect(mockClearPlanGuardStrike).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(r-strike) a finding-free MACHINE run CLEARS a prior plan guard-strike (and never marks one)', async () => {
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    await executeClaimedRun(makeClaim());
    await new Promise((r) => setImmediate(r));
    expect(mockClearPlanGuardStrike).toHaveBeenCalledWith('s1');
    expect(mockMarkPlanGuardStrike).not.toHaveBeenCalled();
  });

  it('(r-mem) clean run: the memory fold fires from the FINALIZE seam with the post-guard text (moved out of agent.ts, 2026-08-30)', async () => {
    await executeClaimedRun(makeClaim());
    await new Promise((r) => setImmediate(r));
    expect(mockUpdateCodingMemoryAsync).toHaveBeenCalledTimes(1);
    const arg = mockUpdateCodingMemoryAsync.mock.calls[0][0];
    expect(arg).toMatchObject({ userId: 'u1', sessionId: 's1', userMessage: 'build it' });
    expect(arg.assistantSummary).toBe('done'); // the guard passed the final through untouched
  });

  it('(r-mem2) a failed run never folds memory (agentLoop threw — nothing honest to record)', async () => {
    mockRunCodingAgent.mockRejectedValueOnce(new Error('provider exploded'));
    await executeClaimedRun(makeClaim());
    await new Promise((r) => setImmediate(r));
    expect(mockUpdateCodingMemoryAsync).not.toHaveBeenCalled();
  });

  it('(r2) CLOCK REDACT lane (ticket 45edaf25): a FUTURE-DATED-ONLY verdict WITH claim objects elides just the struck line — REMOVED banner, survivors byte-identical, verdict-line journal/fold/hook; verdict row + integrity ticket still fire', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const CLOCK_STAMP = '2026-08-28T06:49:49.457Z';
    const CLOCK_LINE = `Observation stamped ${CLOCK_STAMP}: sweep row 47 written to the ledger.`;
    const SKEWED = [
      'Audit sweep summary: ticket 93006fd8 re-verified against the queue.',
      'No dispatch-needed items survived the evidence-guard review.',
      CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
    ].join('\n');
    const FD_NOTE = "[HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS]\n1 line(s) cite observation/merge timestamps LATER than this run's wall clock: 2026-08-28T06:49:49.457Z (+22m ahead).";
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: SKEWED,
      parts: [{ type: 'text', text: SKEWED }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n${FD_NOTE}`,
      notes: [FD_NOTE],
      verdict: {
        unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [],
        futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
        futureDatedClaims: [{ text: CLOCK_LINE, stamp: CLOCK_STAMP, aheadMs: 1320000 }],
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // The struck line NEVER reaches the committed answer: the persisted CONTENT
    // leads with the CLOCK REMOVED banner and carries the stand-in 1:1; every
    // other line survives byte-identical — NO full-replacement audit fence
    // (ticket 45edaf25 widens the f8d68167 strip+mark lane to clock findings).
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    const content: string = appended?.[0].content;
    expect(content.startsWith('[HARNESS EVIDENCE GUARD — 1 CLOCK LINE(S) REMOVED]')).toBe(true);
    expect(content).toContain('future-dated observation claims: 2026-08-28T06:49:49.457Z (+22m ahead)');
    expect(content).toContain('cannot be dated in the future');
    expect(content).not.toContain('--- BEGIN UNVERIFIED RUN OUTPUT');
    const body = content.slice(content.indexOf('\n\n') + 2);
    expect(body.split('\n')).toEqual([
      'Audit sweep summary: ticket 93006fd8 re-verified against the queue.',
      'No dispatch-needed items survived the evidence-guard review.',
      REDACTED_CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
    ]);
    // The parts-rendered transcript ALSO leads honest (notice unshifted first).
    expect(appended?.[0].parts[0]).toMatchObject({ type: 'text' });
    expect(appended?.[0].parts[0].text).toContain('CLOCK LINE(S) REMOVED');

    // Journal rides the deterministic verdict line, never the struck original.
    const journalFinal: string = mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal;
    expect(journalFinal).toContain('evidence guard');
    expect(journalFinal).toContain('NOT DONE');
    expect(journalFinal).not.toContain(CLOCK_LINE);
    // The coding-memory fold gets the same verdict line (post-guard).
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget fold import
    expect(mockUpdateCodingMemoryAsync).toHaveBeenCalledTimes(1);
    const memSummary: string = mockUpdateCodingMemoryAsync.mock.calls[0][0].assistantSummary;
    expect(memSummary).toContain('evidence guard');
    expect(memSummary).not.toContain(CLOCK_LINE);
    // The harness-owned verdict row + deduped integrity ticket STILL fire — unchanged.
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', triggerKind: 'schedule', futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
    }));
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget ticket import
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ area: 'fleet-integrity', type: 'mishap' }));

    // The run_completed hook summary leads honest — a downstream wake/digest
    // can never quote the impossible observation as fact.
    const hook = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'run_completed');
    expect(hook?.[2]).toContain('REPLACED its final answer');
    expect(hook?.[2]).not.toContain(CLOCK_LINE);
    // The strike poisons the plan store — marked, never cleared.
    expect(mockMarkPlanGuardStrike).toHaveBeenCalledWith('s1', expect.any(String));
    expect(mockClearPlanGuardStrike).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(r2b) FAIL-CLOSED fallback (ticket 45edaf25): a FUTURE-DATED-ONLY verdict WITHOUT futureDatedClaims (legacy shape) still fully REPLACES — honest top, quoted original, verdict-line journal/fold/hook; verdict row + integrity ticket still fire', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const SKEWED = 'Audit closed — all anchors re-read fresh, nothing needs the owner.';
    const FD_NOTE = "[HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS]\n1 line(s) cite observation/merge timestamps LATER than this run's wall clock: 2026-08-28T06:49:49.457Z (+22m ahead).";
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: SKEWED,
      parts: [{ type: 'text', text: SKEWED }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n${FD_NOTE}`,
      notes: [FD_NOTE],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'] },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // No claim objects → renderRedactedFinal can't run → the REPLACE fallback
    // pins the cdd3fbfe fail-closed principle for legacy-shaped verdicts: the
    // persisted CONTENT leads with the harness banner; the original survives
    // ONLY inside the quoted audit section. (The single-line answer would ALSO
    // null out via the zero-survivors rule even if claim objects existed —
    // keep this fixture claim-object-free to pin the no-objects fallback.)
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    const content: string = appended?.[0].content;
    expect(content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(content).toContain('future-dated observation claims: 2026-08-28T06:49:49.457Z (+22m ahead)');
    const begin = content.indexOf('--- BEGIN UNVERIFIED RUN OUTPUT');
    expect(begin).toBeGreaterThan(-1);
    expect(content.slice(0, begin)).not.toContain(SKEWED); // nothing unproven above the quote
    expect(content).toContain(`> ${SKEWED}`);
    // The parts-rendered transcript ALSO leads honest (notice unshifted first).
    expect(appended?.[0].parts[0]).toMatchObject({ type: 'text' });
    expect(appended?.[0].parts[0].text).toContain('FINAL ANSWER WAS REPLACED');

    // Journal rides the deterministic verdict line, never the wrapper/original.
    const journalFinal: string = mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal;
    expect(journalFinal).toContain('evidence guard replaced');
    expect(journalFinal).toContain('NOT DONE');
    expect(journalFinal).not.toContain(SKEWED);
    // The coding-memory fold gets the same verdict line (post-guard).
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget fold import
    expect(mockUpdateCodingMemoryAsync).toHaveBeenCalledTimes(1);
    const memSummary: string = mockUpdateCodingMemoryAsync.mock.calls[0][0].assistantSummary;
    expect(memSummary).toContain('evidence guard replaced');
    expect(memSummary).not.toContain(SKEWED);
    // The harness-owned verdict row + deduped integrity ticket STILL fire — unchanged.
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', triggerKind: 'schedule', futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
    }));
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget ticket import
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ area: 'fleet-integrity', type: 'mishap' }));

    // The run_completed hook summary leads honest — a downstream wake/digest
    // can never quote the impossible observation as fact.
    const hook = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'run_completed');
    expect(hook?.[2]).toContain('REPLACED its final answer');
    expect(hook?.[2]).not.toContain(SKEWED);
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(r2c) CLAIM+CLOCK REDACT lane (ticket 45edaf25): mixed unprovenKinds + futureDated with BOTH claim sets populated elides 2 claim lines + 1 clock line under the CLAIM+CLOCK banner — no UNVERIFIED fence', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const CLOCK_STAMP = '2026-08-28T06:49:49.457Z';
    const CLOCK_LINE = `Observation stamped ${CLOCK_STAMP}: sweep row 47 written to the ledger.`;
    const COMMIT_LINE = 'Commits 1539fa86 are live on origin/main.';
    const DEPLOY_LINE = 'Deploy green, health check 200.';
    const MIXED = [
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      COMMIT_LINE,
      DEPLOY_LINE,
      CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
      'Second standing note: keep the plan store honest.',
    ].join('\n');
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: MIXED,
      parts: [{ type: 'text', text: MIXED }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: {
        unprovenKinds: ['commit_pushed', 'deploy'], fabricatedPrs: [], refutedMergePrs: [],
        futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
        unprovenClaims: [
          { kind: 'commit_pushed', sha: '1539fa86', text: COMMIT_LINE },
          { kind: 'deploy', text: DEPLOY_LINE },
        ],
        futureDatedClaims: [{ text: CLOCK_LINE, stamp: CLOCK_STAMP, aheadMs: 1320000 }],
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // Both stand-ins ride the persisted CONTENT 1:1 under the CLAIM+CLOCK
    // banner; every other line survives byte-identical, no audit fence.
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    const content: string = appended?.[0].content;
    expect(content.startsWith('[HARNESS EVIDENCE GUARD — 3 CLAIM+CLOCK LINE(S) REMOVED]')).toBe(true);
    expect(content).toContain('zero-evidence completion claims: commit_pushed, deploy');
    expect(content).toContain('future-dated observation claims: 2026-08-28T06:49:49.457Z (+22m ahead)');
    expect(content).toContain('cannot be dated in the future');
    expect(content).not.toContain('--- BEGIN UNVERIFIED RUN OUTPUT');
    const body = content.slice(content.indexOf('\n\n') + 2);
    expect(body.split('\n')).toEqual([
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      REDACTED_CLAIM_LINE,
      REDACTED_CLAIM_LINE,
      REDACTED_CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
      'Second standing note: keep the plan store honest.',
    ]);
    expect(appended?.[0].parts[0]).toMatchObject({ type: 'text' });
    expect(appended?.[0].parts[0].text).toContain('CLAIM+CLOCK LINE(S) REMOVED');

    // Journal/fold ride the deterministic verdict line, never the struck lines.
    const journalFinal: string = mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal;
    expect(journalFinal).toContain('evidence guard');
    expect(journalFinal).toContain('NOT DONE');
    expect(journalFinal).not.toContain(COMMIT_LINE);
    expect(journalFinal).not.toContain(CLOCK_LINE);
    // Verdict row + integrity ticket + plan strike — unchanged by the lane.
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', triggerKind: 'schedule',
      unprovenKinds: ['commit_pushed', 'deploy'],
      futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
    }));
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget ticket import
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ area: 'fleet-integrity', type: 'mishap' }));
    expect(mockMarkPlanGuardStrike).toHaveBeenCalledWith('s1', expect.any(String));
    expect(mockClearPlanGuardStrike).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(r2d) FAIL-CLOSED object parity (45edaf25 review N1): a stale verdict with futureDated strings but NO futureDatedClaims REPLACES — a convicted clock line is never delivered by a claims-only redaction', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const CLOCK_LINE = 'Observation stamped 2026-08-28T06:49:49.457Z: sweep row 47 written to the ledger.';
    const COMMIT_LINE = 'Commits 1539fa86 are live on origin/main.';
    const MIXED = [
      'Triage summary: ticket 93006fd8 is closed; the plan shows 4/4 complete.',
      'No dispatch-needed items survived the evidence-guard review.',
      COMMIT_LINE,
      CLOCK_LINE,
      'Standing requirement: re-verify with fresh tool evidence before restating claims.',
      'Second standing note: keep the plan store honest.',
    ].join('\n');
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: MIXED,
      parts: [{ type: 'text', text: MIXED }],
    }));
    // unprovenKinds DOES carry its objects but futureDated does NOT — before
    // the parity gate this redacted the claim line and DELIVERED the
    // convicted clock line under a CLAIM REMOVED banner.
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: {
        unprovenKinds: ['commit_pushed'], fabricatedPrs: [], refutedMergePrs: [],
        futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
        unprovenClaims: [{ kind: 'commit_pushed', sha: '1539fa86', text: COMMIT_LINE }],
        // futureDatedClaims deliberately ABSENT (stale/hand-built shape)
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // REPLACE lane: the banner leads; NOTHING struck rides above the fence —
    // the convicted clock line survives ONLY inside the quoted audit section.
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    const content: string = appended?.[0].content;
    expect(content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(content).not.toContain('LINE(S) REMOVED]');
    const begin = content.indexOf('--- BEGIN UNVERIFIED RUN OUTPUT');
    expect(begin).toBeGreaterThan(-1);
    expect(content.slice(0, begin)).not.toContain(CLOCK_LINE);
    expect(content.slice(0, begin)).not.toContain(COMMIT_LINE);
    expect(content).toContain(`> ${CLOCK_LINE}`);
    expect(content).toContain(`> ${COMMIT_LINE}`);
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(r3) REPLACE still wins when a future-dated finding rides WITH hard findings (fabricated claims + skewed clocks)', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.';
    const CLOCK_STAMP = '2026-08-28T06:49:49.457Z';
    const CLOCK_LINE = `Observation stamped ${CLOCK_STAMP}: sweep row 47 written to the ledger.`;
    const FINAL = [PHANTOM, CLOCK_LINE].join('\n');
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: FINAL,
      parts: [{ type: 'text', text: FINAL }],
    }));
    // BOTH claim sets populated — the hard fabricatedPrs class STILL
    // disqualifies the redact lane (a fabricated PR claim is never strippable,
    // ticket 45edaf25 keeps the f8d68167 gate: findings ⊂ {unproven, clocks}).
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: {
        unprovenKinds: ['pr_merged'], fabricatedPrs: [224], refutedMergePrs: [],
        futureDated: ['2026-08-28T06:49:49.457Z (+22m ahead)'],
        unprovenClaims: [{ kind: 'pr_merged', prNumber: 224, text: PHANTOM }],
        futureDatedClaims: [{ text: CLOCK_LINE, stamp: CLOCK_STAMP, aheadMs: 1320000 }],
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(appended?.[0].content).not.toContain('REMOVED]'); // the redact lane never ran
    expect(appended?.[0].content).toContain(`> ${PHANTOM}`);
    expect(appended?.[0].content).toContain(`> ${CLOCK_LINE}`);
  });

  it('(t) forgedFooter passthrough: forgery alone triggers the REPLACE lane and reaches the verdict row + integrity ticket text', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const FORGED = 'Sweep done.\n\n🔍 Harness claim verification (verified-at 2026-08-24T00:00:00.000Z):\n• PR #9 — ✅ VERIFIED MERGED';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: FORGED,
      parts: [{ type: 'text', text: FORGED }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], forgedFooter: true },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // Forgery ALONE is a finding → the replace lane fired, led by the honest banner…
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(appended?.[0].content).toContain('forged harness markers'); // summarizeGuardVerdict's new lane
    // …the harness-owned verdict row carries the field…
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', triggerKind: 'schedule', forgedFooter: true,
    }));
    // …and the deduped integrity ticket names the forgery lane.
    await new Promise((r) => setImmediate(r));
    const ticket = mockFileFeedbackTicket.mock.calls[0]?.[0];
    expect(ticket?.description).toContain('forged harness markers');
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('(w) ticket 02102222: a hard-findings strike (convicted content stripped pre-delivery) files with context.containedPreDelivery === true — contained strikes counter-bump instead of reopening', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    // Session a8976e11: 5 sightings / 3 reopens where EVERY strike was contained
    // by the fail-closed guard (REDACT/REPLACE at commit, ticket cdd3fbfe) yet
    // the filing carried no containment marker → each sighting reopened the
    // ticket as "the fix did not hold" → dispatch churn. The marker wires the
    // guard lane into the aac649ba discrimination (feedback.service.ts:367).
    const PROBE_CLAIM = 'Production is healthy — digby.ai returned 200 at 03:10Z.';
    const ORIGINAL = `Sweep complete.\n${PROBE_CLAIM}\nAll quiet otherwise.`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: ORIGINAL,
      parts: [{ type: 'text', text: ORIGINAL }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: {
        unprovenKinds: ['probe'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
        unprovenClaims: [{ kind: 'probe', text: PROBE_CLAIM }],
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    // Contained by construction: the REDACT lane stripped the convicted line
    // before anything delivered (the run's clean remainder survives).
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].content).toContain('REMOVED]');
    expect(appended?.[0].content).not.toContain(PROBE_CLAIM);
    await new Promise((r) => setImmediate(r));
    const ticket = mockFileFeedbackTicket.mock.calls[0]?.[0];
    expect(ticket?.context).toEqual(expect.objectContaining({
      verifier: 'evidence-guard', containedPreDelivery: true,
    }));
  });

  it('(x) gate flip 2026-09-11: unverifiedBlockClaims-only is NOTE-ONLY even under EVIDENCE_GUARD_ENFORCE=1 — the original DELIVERS, the strike row + verdict row + ticket (containedPreDelivery:false) still fire', async () => {
    // P4 v1#25 made a block-miss REPLACE the whole final. Every recoverable
    // exhibit (112 strikes) was honest work in the wrong receipt shape (a
    // run_command verify, an update_feedback with no receipt, a message_sent
    // whose receipt carried {chatId, position} not messageId) — the class is
    // now annotate-only and NO env re-arms it; telemetry keeps the kind so
    // precision stays measurable.
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    const ORIGINAL = 'Sweep complete — receipts attached below.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: ORIGINAL,
      parts: [{ type: 'text', text: ORIGINAL }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: {
        unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
        unverifiedBlockClaims: ['probe — no matching receipt'],
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(false);
    expect(appended?.[0].content).toContain(ORIGINAL); // delivered, not quoted for audit
    expect(appended?.[0].parts.some((p: any) => p.struck || p.marker === 'guard')).toBe(false);
    // Telemetry keeps the kind (observed, not enforced) + the journal verdict row.
    // Firing-20 (2026-10-10): the strike meta also carries bounded claim excerpts
    // (kind + capped final-answer line) — the observability the de529489 pair
    // needed: kinds alone cannot tell honest-work-wrong-receipt-shape from fabrication.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: { seam: 'final_verdict', kinds: ['unverified_block_claim'], outcome: 'observed', claims: [{ kind: 'unverified_block_claim', text: 'probe — no matching receipt' }] },
    }));
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      unverifiedBlockClaims: ['probe — no matching receipt'],
    }));
    await new Promise((r) => setImmediate(r));
    const ticket = mockFileFeedbackTicket.mock.calls[0]?.[0];
    expect(ticket?.context).toEqual(expect.objectContaining({
      verifier: 'evidence-guard', containedPreDelivery: false,
    }));
    expect(mockMarkPlanGuardStrike).not.toHaveBeenCalled();
  });

  it('(od1) ticket 4565991a — an owner-subscribed schedule firing stamps scheduleOwnerArmed on the wake USER row + kind owner_digest on the FINAL row + threads the flag into the agent loop', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'AI Noise Digest — Sep 28', parts: [{ type: 'text', text: 'AI Noise Digest — Sep 28' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'the daily digest', userId: 'u1', origin: 'schedule', scheduleOwnerArmed: true, scheduleId: 'sch_rung' } as any }));

    // (a) the wake USER row (the machine group's ANCHOR) carries the flag —
    // the frontend mounts the whole turn EXPANDED with a "requested" marker.
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user',
      metadata: expect.objectContaining({ origin: 'schedule', scheduleOwnerArmed: true }),
    }));
    // (b) the FINAL assistant row carries the owner_digest kind — the digest
    // ANSWER renders as a normal visible bubble (frontend machine-turn-grouping
    // isOwnerDigest exemption), never accordion chrome.
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].metadata).toEqual(expect.objectContaining({
      origin: 'schedule', triggerKind: 'schedule', scheduleId: 'sch_rung', kind: 'owner_digest',
    }));
    // (c) the agent loop receives the subscription so its OWN-chat re-arms
    // (schedule_self / schedule_message no chatId) inherit ownerSubscribed —
    // the dormant-gate one-shot ladder keeps the mark (the Sep 27 recurrence:
    // machine-armed rungs read ownerSubscribed NULL).
    expect(mockRunCodingAgent.mock.calls[0][0].scheduleOwnerArmed).toBe(true);
  });

  it('(od2) ticket 4565991a CONTROL — a plain machine firing (no flag) stamps NEITHER: collapsed exactly as today', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'sweep note', parts: [{ type: 'text', text: 'sweep note' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'internal sweep', userId: 'u1', origin: 'schedule', scheduleId: 'sch_sweep' } as any }));
    const userWrite = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'user');
    expect(userWrite?.[0].metadata).not.toHaveProperty('scheduleOwnerArmed');
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].metadata).not.toHaveProperty('kind');
    expect(mockRunCodingAgent.mock.calls[0][0].scheduleOwnerArmed).toBeUndefined();
  });

  it('(od3) ticket 4565991a CONTROL — a stray flag on a NON-schedule origin never stamps (guard mirrors the plain-chat shape)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'note', parts: [{ type: 'text', text: 'note' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'hook wake', userId: 'u1', origin: 'hook', scheduleOwnerArmed: true } as any }));
    const userWrite = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'user');
    expect(userWrite?.[0].metadata).not.toHaveProperty('scheduleOwnerArmed');
    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    expect(appended?.[0].metadata).not.toHaveProperty('kind');
    expect(mockRunCodingAgent.mock.calls[0][0].scheduleOwnerArmed).toBeUndefined();
  });

  // ── One-shot CHAIN provenance (finding B1): RunInput.scheduleId on a REAL
  // schedule firing rides into the agent loop as firedByScheduleId; every
  // other origin carries none (a hook wake is not a chain link).
  it('(oc1) finding B1 — a schedule firing threads RunInput.scheduleId into the agent loop as firedByScheduleId', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'probe note', parts: [{ type: 'text', text: 'probe note' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'resume the probe', userId: 'u1', origin: 'schedule', scheduleId: 'sch_rung' } as any }));
    expect(mockRunCodingAgent.mock.calls[0][0].firedByScheduleId).toBe('sch_rung');
  });

  it('(oc2) finding B1 CONTROL — a hook wake carrying a stray scheduleId threads NO firedByScheduleId', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'note', parts: [{ type: 'text', text: 'note' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'hook wake', userId: 'u1', origin: 'hook', scheduleId: 'sch_rung' } as any }));
    expect(mockRunCodingAgent.mock.calls[0][0].firedByScheduleId).toBeUndefined();
  });

  it('(oc3) finding B1 CONTROL — a schedule origin WITHOUT a scheduleId threads none', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'note', parts: [{ type: 'text', text: 'note' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'legacy firing', userId: 'u1', origin: 'schedule' } as any }));
    expect(mockRunCodingAgent.mock.calls[0][0].firedByScheduleId).toBeUndefined();
  });

  it('(y1) P4 CanLaw L5 — LINE-LEVEL REPLACE: a fabricated-PR final with a surviving RECEIPTED line loses only the convicted line (guardOriginal preserved on metadata)', async () => {    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const RID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
    const GOOD = `Opened PR #300 (receipt ${RID}) with the fix — verified green.`;
    const BAD = 'Also merged PR #999 and flipped prod.';
    const ORIGINAL = `${GOOD}\n${BAD}`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: ORIGINAL,
      parts: [{ type: 'text', text: ORIGINAL }],
      receipts: [{ id: RID, chatId: 's1', runId: 'run1', tool: 'open_pull_request', ok: true, ids: { prNumber: 300 }, inputHash: null, outputHash: null, createdAt: new Date() }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [999], refutedMergePrs: [], futureDated: [] },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));

    const appended = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant');
    const content: string = appended?.[0].content;
    // Line-level mode: REMOVED banner, receipted line survives verbatim, the
    // fabricated line is gone — never the whole-final REPLACED wrapper.
    expect(content).toContain('LINE(S) REMOVED');
    expect(content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(false);
    expect(content).toContain(GOOD);
    expect(content).not.toContain('merged PR #999');
    // The pre-strike original rides the row metadata (size-capped guardOriginal)
    // — MERGED with the run's provenance stamp (2026-09-15), never clobbered.
    expect(appended?.[0].metadata).toEqual(expect.objectContaining({ guardOriginal: ORIGINAL, triggerKind: expect.any(String) }));
  });

  it('(y2) P4 spark B27 — a guard-REPLACED machine final ALSO emits an attention_needed alarm event carrying the replace reason', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged, sha 84fe3ae0.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: PHANTOM,
      parts: [{ type: 'text', text: PHANTOM }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [] },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    await new Promise((r) => setImmediate(r));

    const attention = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'attention_needed');
    expect(attention).toBeDefined();
    expect(attention?.[2]).toContain('Evidence guard REPLACED');
    expect(attention?.[2]).toContain('fabricated PR claims');
    expect(attention?.[3]).toEqual({ runId: 'run1' });
    // The terminal run_completed contract is untouched (child-result subscribers).
    expect(mockEmitHookEventSafe.mock.calls.some((c: any[]) => c[1] === 'run_completed')).toBe(true);
  });

  it('(u) seq-prime read fails 3× → the run start THROWS instead of priming to 0 (ticket 3581c8c2); nothing executes, no events appended', async () => {
    mockPrisma.agentEvent.aggregate
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));

    await expect(executeClaimedRun(makeClaim())).rejects.toThrow(/getMaxAgentEventSeq failed 3×/);

    expect(mockPrisma.agentEvent.aggregate).toHaveBeenCalledTimes(3);
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(mockPrisma.agentEvent.create).not.toHaveBeenCalled();
  });

  it('(v) seq-prime read flaky once → retry succeeds and the durable seq continues from the true max', async () => {
    mockPrisma.agentEvent.aggregate
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ _max: { seq: 41 } });

    await executeClaimedRun(makeClaim());

    expect(mockRunCodingAgent).toHaveBeenCalled();
    // The init event is the first durable append — seq continues at 42, never re-based to 1.
    expect(mockPrisma.agentEvent.create.mock.calls[0][0].data.seq).toBe(42);
  });

  it('(w) a failed agent_events append is surfaced — error log + finalize total — and the run still completes', async () => {
    mockPrisma.agentEvent.create.mockRejectedValueOnce(new Error('unique collision'));

    await executeClaimedRun(makeClaim());
    // Let the fire-and-forget tap's .catch chain drain.
    await new Promise((r) => setImmediate(r));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('agent_events append failed for run run1'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('dropped 1 agent_events append(s)'));
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });
});

describe('provider-killed scheduled runs (cff523e7)', () => {
  const KEY = (sid: string) => `coding:sched:provfail:${sid}`;
  const schedClaim = (over: Partial<ClaimedRun> = {}) =>
    makeClaim({ input: { message: 'run the monitor', userId: 'u1', origin: 'schedule', scheduleId: 'sch_1' }, ...over });
  const providerKilled = () =>
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: '⚠︎ rate-limited: provider kept returning HTTP 429',
      parts: [{ type: 'text', text: 'rate-limited' }],
      modelErrored: true, modelErrorStatus: 429, modelErrorKind: 'transient' as const,
    }));

  it('a schedule-fired provider-killed run INCREMENTS the consecutive counter — below the threshold stays silent', async () => {
    providerKilled();
    await executeClaimedRun(schedClaim());

    // Ticket d36344ed: a MACHINE run the provider killed is a FAILED run — the
    // row carries the provider cause (never a silent 'completed' whose "final
    // answer" is the HTTP error text)…
    expect(finalizeCall()?.[0].data.status).toBe('failed');
    expect(finalizeCall()?.[0].data.error).toContain('model provider killed the run (transient failure, HTTP 429)');
    expect(finalizeCall()?.[0].data.error).toContain('rate-limited');
    // …and the schedule's streak is counted in Redis.
    expect(mockStore.get(KEY('sch_1'))).toBe('1');
    // Below the threshold: no digest-visible status flip, no attention event.
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('at the 3rd consecutive provider-killed run: lastStatus flips + ONE attention_needed; the 4th does not re-fire', async () => {
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run1' }));
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run2' }));
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run3' }));

    expect(mockStore.get(KEY('sch_1'))).toBe('3');
    expect(mockPrisma.chatSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sch_1' }, data: { lastStatus: 'error:provider_429' },
    });
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    const [chatId, eventType, summary, extra] = mockEmitHookEvent.mock.calls[0];
    expect(chatId).toBe('s1');
    expect(eventType).toBe('attention_needed');
    expect(summary).toContain('3 consecutive scheduled runs');
    expect(extra).toMatchObject({
      scheduleId: 'sch_1', sessionId: 's1', consecutiveFailures: 3,
      modelErrorStatus: 429, modelErrorKind: 'transient', runId: 'run3',
    });

    // Past the crossing: counted + lastStatus re-asserted, but NO second event.
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run4' }));
    expect(mockStore.get(KEY('sch_1'))).toBe('4');
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
  });

  it('a GENUINE SUCCESS on the schedule resets the streak (and re-arms the crossing gate)', async () => {
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run1' }));
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run2' }));
    expect(mockStore.get(KEY('sch_1'))).toBe('2');

    // Default mockRunCodingAgent = clean finish (no modelErrored) → reset.
    await executeClaimedRun(schedClaim({ id: 'run3' }));
    expect(mockStore.has(KEY('sch_1'))).toBe(false);
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();

    // A fresh streak starts from 1 again (and could re-cross later — helper-level
    // re-alert covered in sched-provider-fail.test.ts).
    providerKilled(); await executeClaimedRun(schedClaim({ id: 'run4' }));
    expect(mockStore.get(KEY('sch_1'))).toBe('1');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('a provider-killed run with NO scheduleId (user/agent/hook traffic) feeds no counter', async () => {
    providerKilled();
    await executeClaimedRun(makeClaim({ input: { message: 'do it', userId: 'u1' } }));
    expect([...mockStore.keys()].filter((k) => k.startsWith('coding:sched:provfail:'))).toEqual([]);
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  // Ticket d36344ed — the run-status contract by trigger kind.
  it('a CAPABILITY-killed hook wake (HTTP 400, tool-less seat) finalizes FAILED with the cause named', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: 'MODEL ENDPOINT REJECTED THE REQUEST SHAPE (HTTP 400): "auto" tool choice requires --enable-auto-tool-choice',
      parts: [{ type: 'text', text: 'rejected' }],
      modelErrored: true, modelErrorStatus: 400, modelErrorKind: 'capability' as const,
    }));
    await executeClaimedRun(makeClaim({ input: { message: 'wake', userId: 'u1', origin: 'hook' } }));
    expect(finalizeCall()?.[0].data.status).toBe('failed');
    expect(finalizeCall()?.[0].data.error).toContain('capability failure, HTTP 400');
    expect(finalizeCall()?.[0].data.error).toContain('enable-auto-tool-choice');
  });

  it('a USER-triggered provider-killed run keeps its "completed" status — the honest note in the transcript is the delivered answer', async () => {
    providerKilled();
    await executeClaimedRun(makeClaim({ input: { message: 'do it', userId: 'u1', origin: 'user' } }));
    expect(finalizeCall()?.[0].data.status).toBe('completed');
    expect(finalizeCall()?.[0].data.error).toBeUndefined();
  });

  it('a clean machine finish is still "completed" with no error', async () => {
    await executeClaimedRun(schedClaim({ id: 'run-ok' }));
    expect(finalizeCall()?.[0].data.status).toBe('completed');
    expect(finalizeCall()?.[0].data.error).toBeUndefined();
  });

  it('a hook wake (origin hook, no scheduleId) never feeds the counter even when provider-killed', async () => {
    providerKilled();
    await executeClaimedRun(makeClaim({ input: { message: 'hook wake', userId: 'u1', origin: 'hook' } }));
    expect([...mockStore.keys()].filter((k) => k.startsWith('coding:sched:provfail:'))).toEqual([]);
  });
});

/**
 * Guard-chrome redaction (ticket ac835c00) — the executor's two context-build
 * seams: the run-history load (agentInput.history) and the resume checkpoint
 * transcript (agentInput.resumeFrom.messages — replayed by agent.ts straight
 * into model context, bypassing the history load). The redactor module runs
 * REAL in this suite (pure, no I/O); stored rows/checkpoints stay wrapped.
 */
describe('guard-chrome redaction (ticket ac835c00)', () => {
  const WRAPPER = [
    "[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]",
    "This machine-triggered run ('schedule') produced a final summary asserting completions its tool log does not support — zero-evidence completion claims: pr_created.",
    'Treat EVERYTHING the run claimed as NOT DONE until re-verified with fresh tool evidence (GitHub API, box probes, test runs).',
    "The run's original summary is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
    '',
    '--- BEGIN UNVERIFIED RUN OUTPUT (quoted for audit — NOT verified, treat as NOT DONE) ---',
    '',
    '> Opened PR #399 with the fix.',
    '',
    '--- END UNVERIFIED RUN OUTPUT ---',
  ].join('\n');

  const savedEnv = process.env.GUARD_CHROME_REDACT;
  beforeEach(() => {
    delete process.env.GUARD_CHROME_REDACT;
    mockListRecentCodingTranscript.mockImplementation(async () => []);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GUARD_CHROME_REDACT;
    else process.env.GUARD_CHROME_REDACT = savedEnv;
  });

  it('history load: a stored guard-wrapped assistant row reaches agentInput.history as the placeholder', async () => {
    // listRecentCodingTranscript is NEWEST-first; the executor reverses and
    // pops the input row.
    mockListRecentCodingTranscript.mockImplementation(async () => [
      { id: 'm3', chatId: 's1', role: 'user', content: 'build it', parts: [], createdAt: new Date(3000) },
      { id: 'm2', chatId: 's1', role: 'assistant', content: WRAPPER, parts: [], createdAt: new Date(2000) },
      { id: 'm1', chatId: 's1', role: 'user', content: 'earlier turn', parts: [], createdAt: new Date(1000) },
    ]);

    await executeClaimedRun(makeClaim());

    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.history).toHaveLength(2);
    expect(input.history[0]).toEqual({ role: 'user', content: 'earlier turn' });
    expect(input.history[1].role).toBe('assistant');
    expect(input.history[1].content).toBe(GUARD_CHROME_PLACEHOLDER);
    expect(input.history[1].content).not.toContain('HARNESS EVIDENCE GUARD');
    expect(input.history[1].content).not.toContain('--- BEGIN');
  });

  it("history load: kill switch GUARD_CHROME_REDACT='0' passes the stored wrapper through byte-identical", async () => {
    process.env.GUARD_CHROME_REDACT = '0';
    mockListRecentCodingTranscript.mockImplementation(async () => [
      { id: 'm2', chatId: 's1', role: 'user', content: 'build it', parts: [], createdAt: new Date(2000) },
      { id: 'm1', chatId: 's1', role: 'assistant', content: WRAPPER, parts: [], createdAt: new Date(1000) },
    ]);

    await executeClaimedRun(makeClaim());

    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.history[0].content).toBe(WRAPPER);
  });

  it('resume: a checkpoint transcript carrying a wrapper is redacted before the agent replays it', async () => {
    const CHROME_CP: RunCheckpoint = {
      ...CP,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'run the digest' },
        { role: 'assistant', content: WRAPPER },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
      ],
    };
    await executeClaimedRun(makeClaim({
      preStatus: 'interrupted',
      checkpoint: CHROME_CP,
      input: { message: 'go on', userId: 'u1' },
      inputConsumed: true,
    }));

    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.resumeFrom).toBeDefined();
    expect(input.resumeFrom.messages[2].content).toBe(GUARD_CHROME_PLACEHOLDER);
    // Untouched entries keep identity; the stored checkpoint object is NOT mutated.
    expect(input.resumeFrom.messages[0]).toBe(CHROME_CP.messages[0]);
    expect(input.resumeFrom.messages[3]).toBe(CHROME_CP.messages[3]);
    expect(CHROME_CP.messages[2].content).toBe(WRAPPER);
    expect(input.resumeFrom.step).toBe(CP.step);
  });

  it('resume: a clean checkpoint passes through BY REFERENCE (no copy cost on the hot path)', async () => {
    await executeClaimedRun(makeClaim({
      preStatus: 'interrupted',
      checkpoint: CP,
      input: { message: 'go on', userId: 'u1' },
      inputConsumed: true,
    }));

    expect(mockRunCodingAgent.mock.calls[0][0].resumeFrom).toBe(CP);
  });
});

/* ====================================================================
 * Continuation fast-lane backstop (audit roadmap #2): a machine run that
 * ends with unfinished plan steps requeues its follow-up DIRECTLY
 * (schedule.service.queueContinuationRun — claimable in ~45 s) instead of
 * the old 15-minute once-schedule; the legacy schedule path survives only
 * as the explicit busy-session fallback. Rounds cap + dedupe stall guards
 * are pinned unchanged.
 * ==================================================================== */
describe('continuation fast-lane backstop (audit #2)', () => {
  const planWithUnfinished = {
    goal: 'ship it',
    acceptanceCriteria: [],
    version: 3,
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 1, text: 'done step', status: 'completed' },
      { id: 2, text: 'pending step', status: 'pending' },
      { id: 3, text: 'wip step', status: 'in_progress' },
    ],
  };
  const machineClaim = (msg = 'do the nightly work') =>
    makeClaim({ input: { message: msg, userId: 'u1', origin: 'schedule' } });
  /** The finalize's assistant-transcript write — where the harness note lands. */
  const assistantFinal = () => {
    const calls = mockAppendCodingMessage.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.role === 'assistant');
    return calls[calls.length - 1]?.content ?? '';
  };

  beforeEach(() => {
    mockGetPlan.mockResolvedValue(planWithUnfinished);
  });

  it('requeues the continuation DIRECTLY (fast lane): shared prompt, r1/6 marker, no once-schedule created', async () => {
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
    const arg = mockQueueContinuationRun.mock.calls[0][0];
    expect(arg.sessionId).toBe('s1');
    expect(arg.userId).toBe('u1');
    // The SAME shared builder as the legacy lane: marker + count sentence +
    // claim discipline all ride the fast lane unchanged.
    expect(arg.prompt).toContain('[HARNESS CONTINUATION r1/6]');
    expect(arg.prompt).toContain('2 unfinished plan step(s)');
    expect(arg.prompt).toContain('CLAIM DISCIPLINE');
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    const final = assistantFinal();
    expect(final).toContain('this run ended with 2 unfinished plan step(s)');
    expect(final).toContain('A continuation run is queued (~45s, round 1/6).');
  });

  it('round accounting rides the marker through the fast lane: r1/6 in → r2/6 queued', async () => {
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r1/6] resume the plan'));
    expect(mockQueueContinuationRun.mock.calls[0][0].prompt).toContain('[HARNESS CONTINUATION r2/6]');
    expect(assistantFinal()).toContain('round 2/6');
  });

  it('rounds cap preserved: an incoming r6/6 marker exhausts — NEITHER lane fires', async () => {
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r6/6] keep going'));
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    expect(assistantFinal()).toContain('Continuation rounds exhausted (6)');
  });

  it('busy session falls back to the OLD once-schedule path (explicit fallback + log line)', async () => {
    mockQueueContinuationRun.mockResolvedValue({ ok: false, reason: 'busy' });
    await executeClaimedRun(machineClaim());
    expect(mockCreateScheduleFallback).toHaveBeenCalledTimes(1);
    const arg = mockCreateScheduleFallback.mock.calls[0][0];
    expect(arg).toMatchObject({ sessionId: 's1', userId: 'u1', kind: 'once', promptSetBy: 'machine' });
    expect(arg.intervalSec).toBe(900); // MIN_INTERVAL_SEC — the legacy 15-min lane, byte-for-byte
    expect(arg.prompt).toContain('[HARNESS CONTINUATION r1/6]');
    expect(assistantFinal()).toContain('A continuation run is scheduled (~15 min, round 1/6).');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('continuation fast-lane unavailable'));
    // Loop telemetry (audit #12): the legacy-fallback wake is recorded with the
    // lane + why the fast lane declined.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'wake_delivered', sessionId: 's1', runId: 'run1',
      meta: { lane: 'continuation_fallback_scheduled', fastLaneReason: 'busy' },
    }));
  });

  it('fallback failure keeps the honest needs-attention note (unchanged contract)', async () => {
    mockQueueContinuationRun.mockResolvedValue({ ok: false, reason: 'busy' });
    mockCreateScheduleFallback.mockResolvedValue({ ok: false, error: 'prompt too long' });
    await executeClaimedRun(machineClaim());
    expect(assistantFinal()).toContain('No continuation could be scheduled (prompt too long)');
  });

  it('dedupe stall guard: an already-queued fast-lane row suppresses BOTH lanes ("already scheduled")', async () => {
    mockHasQueuedContinuationRun.mockResolvedValue(true);
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    expect(assistantFinal()).toContain('A continuation run is already scheduled.');
  });

  it('dedupe stall guard: a pending legacy once-schedule also suppresses both lanes (preserved exactly)', async () => {
    mockPrisma.chatSchedule.count.mockResolvedValueOnce(1);
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    expect(assistantFinal()).toContain('A continuation run is already scheduled.');
  });

  // ── STOP MEANS STOP (2026-09-29, continuation-guard.ts) — the TB 2.1 v3b
  // bench: every run the adapter stopped came back as [HARNESS CONTINUATION].
  it('(stop means stop) a STOPPED run queues NO continuation: honest note, one continuation_suppressed row (seam backstop)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => {
      cancelRun('s1'); // the worker took a Stop request for this run
      return { finalText: 'partial work', parts: [{ type: 'text', text: 'partial work' }] };
    });
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    const final = assistantFinal();
    expect(final).toContain('this run ended with 2 unfinished plan step(s)');
    expect(final).toContain('No continuation queued — the run was stopped, and a stop means stop.');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'continuation_suppressed', sessionId: 's1', runId: 'run1',
      meta: expect.objectContaining({ reason: 'stopped', seam: 'backstop', unfinished: 2 }),
    }));
  });

  it('(stop means stop) a deploy-interrupted run queues no continuation and writes no note — the interrupted row resumes itself', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => {
      markRunShutdownInterrupted('s1');
      cancelRun('s1');
      return { finalText: 'partial', parts: [{ type: 'text', text: 'partial' }] };
    });
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    expect(assistantFinal()).not.toContain('HARNESS NOTE');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'continuation_suppressed', meta: expect.objectContaining({ reason: 'shutdown', seam: 'backstop' }),
    }));
  });

  it('(stop means stop) an ARCHIVED session queues no continuation', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (a: any) => (a?.select?.archivedAt ? { archivedAt: new Date() } : { userId: 'u1' }));
    try {
      await executeClaimedRun(machineClaim());
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ userId: 'u1' }));
    }
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    expect(assistantFinal()).toContain('No continuation queued — the session is archived.');
  });

  it('(stop means stop) the fast lane answering archived (a race) is TERMINAL — never the legacy once-schedule', async () => {
    mockQueueContinuationRun.mockResolvedValue({ ok: false, reason: 'archived' });
    await executeClaimedRun(machineClaim());
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    expect(assistantFinal()).toContain('No continuation queued — the session is archived.');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'continuation_suppressed', meta: expect.objectContaining({ reason: 'archived', seam: 'queue' }),
    }));
  });

  it('user-triggered runs never continue (the backstop stays machine-only)', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'hi', userId: 'u1', userTurnAt: new Date().toISOString() } }));
    // c2ee04a1: a user-run's plan IS read now — by the honest unfinished NOTE
    // (names remaining steps + whether anything is scheduled to resume). The
    // CONTINUATION contract is unchanged: nothing is ever queued for a user run.
    expect(mockGetPlan).toHaveBeenCalled();
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    // Loop telemetry: user-watched turns are outside the guard's population —
    // no guard_strike/guard_miss row (audit #12). The per-run retrieval-usage
    // row (owner 2026-09-04) is population-blind by design: it fires for EVERY
    // terminal run, user-triggered included — grounding rates must cover the
    // runs users actually watch.
    const kinds = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]?.kind);
    expect(kinds).not.toContain('guard_strike');
    expect(kinds).not.toContain('guard_miss');
    expect(kinds).not.toContain('wake_delivered');
    expect(kinds).toContain('coding_retrieval_usage');
  });

  it('a fully-complete plan board queues nothing (no unfinished steps → no continuation)', async () => {
    mockGetPlan.mockResolvedValue({
      ...planWithUnfinished,
      steps: [{ id: 1, text: 'done step', status: 'completed' }],
    });
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
  });

  // ── Zero-mutation streak (ticket 9a76855d) — the EMIT-CLOSURE contract ──
  // The detector's numerator (fileMutations) is counted in the executor's own
  // onEvent closure from the REAL runCodingAgent event stream, and the stop
  // decision consumes it. These pin the whole chain through the seam the
  // reviewer flagged: agent emit → counter → nextZeroEditStreak → suppress or
  // queue-with-token. The default agent mock (outer beforeEach) emits NO
  // tool_call events — that IS the zero-edit run shape.
  const STREAK2 = '[HARNESS CONTINUATION r2/6] [zero-edit streak: 2] — resume the plan';

  it('(9a76855d) a run that DISPATCHES a mutating tool through the real emit seam RESETS the streak — the queued prompt carries NO streak token', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('tool_call', { name: 'read_file', args: { path: 'spec.md' } }); // read-only: does not count
      input.emit('tool_call', { name: 'edit_file', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } });
      return { finalText: 'edited', parts: [{ type: 'text', text: 'edited' }] };
    });
    await executeClaimedRun(machineClaim(STREAK2));
    expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
    const prompt = mockQueueContinuationRun.mock.calls[0][0].prompt;
    expect(prompt).toContain('[HARNESS CONTINUATION r3/6]'); // round advanced
    expect(prompt).not.toContain('[zero-edit streak:'); // streak reset to 0 → token omitted
  });

  it('(9a76855d) a namespaced subagent tool_call (…:tool_call) with a mutating name ALSO counts', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('worker:tool_call', { name: 'ast_rewrite', args: { pattern: 'a($B)', rewrite: 'c($B)' } });
      return { finalText: 'ok', parts: [{ type: 'text', text: 'ok' }] };
    });
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r2/6] [zero-edit streak: 1] — resume'));
    expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
    expect(mockQueueContinuationRun.mock.calls[0][0].prompt).not.toContain('[zero-edit streak:');
  });

  it('(9a76855d) a FIRST zero-edit continuation round (no token, 0→1) still queues — one analysis round is legitimate', async () => {
    await executeClaimedRun(machineClaim('do the nightly work'));
    expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
    expect(mockQueueContinuationRun.mock.calls[0][0].prompt).toContain('[zero-edit streak: 1]'); // now visible to the next round
  });

  it('(9a76855d) a zero-edit machine round reaching the threshold TRIPS: no continuation, honest note, loop metric, attention alarm', async () => {
    await executeClaimedRun(machineClaim(STREAK2)); // default agent mock emits nothing → zero edits
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
    const final = assistantFinal();
    expect(final).toContain('this run ended with 2 unfinished plan step(s)');
    expect(final).toContain('No continuation queued — the last 3 consecutive continuation round(s) produced ZERO file edits');
    expect(final).toContain('Send a message (or steer the lane) to resume with an edits-first instruction');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'continuation_suppressed', sessionId: 's1', runId: 'run1',
      meta: expect.objectContaining({
        reason: 'zero_mutation_streak', seam: 'backstop', origin: 'schedule',
        unfinished: 2, streak: 3, priorStreak: 2, fileMutations: 0,
      }),
    }));
    const alarm = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'attention_needed');
    expect(alarm).toBeTruthy(); // supervisor-facing, IN ADDITION to run_completed
    expect(String(alarm![2])).toContain('Zero-mutation continuation guard TRIPPED on session s1');
    expect(String(alarm![2])).toContain('it will not self-resume');
    expect(alarm![3]).toEqual(expect.objectContaining({ runId: 'run1', reason: 'zero_mutation_streak', streak: 3 }));
  });

  it('(9a76855d) CONTINUATION_ZERO_MUTATION_MAX_ROUNDS=1 trips on the FIRST zero-edit round', async () => {
    process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS = '1';
    try {
      await executeClaimedRun(machineClaim('do the nightly work'));
      expect(mockQueueContinuationRun).not.toHaveBeenCalled();
      expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'continuation_suppressed',
        meta: expect.objectContaining({ reason: 'zero_mutation_streak', streak: 1, fileMutations: 0 }),
      }));
    } finally {
      delete process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS;
    }
  });
});

/* ====================================================================
 * Audit #8 — monotonic checkpoint fence stamping + git-snapshot throttle.
 *
 * The executor's onCheckpoint closure (1) stamps a SYNCHRONOUSLY-increasing
 * checkpointSeq onto every checkpoint before the async write (the REAL
 * run-state then fences on it via $executeRaw — pinned in run-state.test.ts),
 * and (2) throttles the ~6-subprocess git snapshot to checkpoints where a
 * write-capable tool dispatched since the last successful snapshot. The DB
 * checkpoint write itself is NEVER throttled.
 * ==================================================================== */
describe('checkpoint fence stamping + git-snapshot throttle (audit #8)', () => {
  /** Settle the fire-and-forget onCheckpoint IIFE (dynamic import + awaits). */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  // Fresh object per call (CP is a shared fixture other tests hand to
  // onCheckpoint, which mutates checkpointSeq/worktree in place).
  const freshCp = (): RunCheckpoint => ({ ...CP, messages: [...CP.messages], checkpointSeq: undefined, worktree: undefined });
  /** Every fenced checkpoint write this suite observed, as (seq, worktree). */
  const fencedWrites = () =>
    mockPrisma.$executeRaw.mock.calls
      .map((c: any[]) => JSON.parse(c[1]))
      .map((cp: any) => ({ seq: cp.checkpointSeq, worktree: cp.worktree }));

  it('stamps a monotonically increasing checkpointSeq per onCheckpoint call; EVERY checkpoint reaches the DB (never throttled)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle();
      input.onCheckpoint(freshCp()); await settle();
      input.onCheckpoint(freshCp()); await settle();
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(fencedWrites().map((w: any) => w.seq)).toEqual([1, 2, 3]);
  });

  it('a RESUMED run continues its seq ABOVE the stored checkpoint (its writes beat the prior attempt at the fence)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle();
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim({
      preStatus: 'interrupted',
      checkpoint: { ...CP, checkpointSeq: 41 },
      inputConsumed: true,
    }));
    expect(fencedWrites().map((w: any) => w.seq)).toEqual([42]);
  });

  it('CLEAN interval → the git snapshot runs ONCE and is REUSED; the checkpoint still carries it', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle(); // first checkpoint: always snapshots
      // A read-only tool dispatch changes nothing on disk…
      input.emit('tool_call', { name: 'read_file', args: { path: 'a.ts' } });
      input.onCheckpoint(freshCp()); await settle(); // …so this one reuses the snapshot
      input.onCheckpoint(freshCp()); await settle(); // pure think step: reused again
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(mockSnapshotWorktreeGitState).toHaveBeenCalledTimes(1);
    // DB durability contract: all 3 checkpoints landed, each carrying the snapshot.
    const writes = fencedWrites();
    expect(writes).toHaveLength(3);
    for (const w of writes) expect(w.worktree).toEqual({ branch: 'digby/x', wip: 'wipsha1' });
  });

  it('DIRTY interval → a write-capable tool dispatch (orchestrator or subagent) forces a fresh snapshot', async () => {
    mockSnapshotWorktreeGitState
      .mockResolvedValueOnce({ branch: 'digby/x', wip: 'wip-1' })
      .mockResolvedValueOnce({ branch: 'digby/x', wip: 'wip-2' })
      .mockResolvedValueOnce({ branch: 'digby/x', wip: 'wip-3' });
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle();               // snapshot #1
      input.emit('tool_call', { name: 'write_file', args: { path: 'a.ts' } });
      input.onCheckpoint(freshCp()); await settle();               // dirty → snapshot #2
      input.emit('subagent:tool_call', { name: 'run_command', args: { command: 'x' } });
      input.onCheckpoint(freshCp()); await settle();               // worker write → snapshot #3
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(mockSnapshotWorktreeGitState).toHaveBeenCalledTimes(3);
    expect(fencedWrites().map((w: any) => w.worktree.wip)).toEqual(['wip-1', 'wip-2', 'wip-3']);
  });

  it('an UNKNOWN tool name counts as write-capable (fail-safe: snapshot runs)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle();
      input.emit('tool_call', { name: 'some_future_tool', args: {} });
      input.onCheckpoint(freshCp()); await settle();
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(mockSnapshotWorktreeGitState).toHaveBeenCalledTimes(2);
  });

  it('a FAILED snapshot keeps the interval dirty (next checkpoint retries) and falls back to the last good snapshot', async () => {
    mockSnapshotWorktreeGitState
      .mockResolvedValueOnce({ branch: 'digby/x', wip: 'wip-good' })
      .mockResolvedValueOnce(null)                                  // the retry target
      .mockResolvedValueOnce({ branch: 'digby/x', wip: 'wip-recovered' });
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle();               // snapshot #1 ok
      input.emit('tool_call', { name: 'edit_file', args: {} });
      input.onCheckpoint(freshCp()); await settle();               // snapshot #2 FAILS → stale carried
      input.onCheckpoint(freshCp()); await settle();               // still dirty → snapshot #3 retries
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(mockSnapshotWorktreeGitState).toHaveBeenCalledTimes(3);
    expect(fencedWrites().map((w: any) => w.worktree.wip)).toEqual(['wip-good', 'wip-good', 'wip-recovered']);
  });

  it('blank-provider sessions never snapshot (unchanged) but their checkpoints still land, fenced', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, project: { ...SESSION.project, provider: 'blank' } });
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.onCheckpoint(freshCp()); await settle();
      return { finalText: 'done', parts: [] };
    });
    await executeClaimedRun(makeClaim());
    expect(mockSnapshotWorktreeGitState).not.toHaveBeenCalled();
    const writes = fencedWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].seq).toBe(1);
    expect(writes[0].worktree).toBeUndefined();
  });
});

/* ====================================================================
 * P6 — machine-run history diet (v1#35 / spark B8) + workspace
 * re-provision notice (spark B24).
 * ==================================================================== */
describe('machine-run history diet (P6 — v1#35/B8)', () => {
  // 2026-09-15: the fetch over-reads by 3 rows so harness STATUS CARDS
  // (origin session_status / project_status) can be dropped and the model
  // still receives the full window of its own turns.
  const CARD_OVERFETCH = 3;

  it('a schedule-fired claim loads only the last 2 wake/report pairs (take 5 + the card over-fetch)', async () => {
    // makeClaim's default input has no userTurnAt and no origin → triggerKind
    // 'schedule' (a machine run).
    await executeClaimedRun(makeClaim());
    expect(mockListRecentCodingTranscript).toHaveBeenCalledWith('s1', 2 * 2 + 1 + CARD_OVERFETCH);
  });

  it('a hook/agent-origin claim gets the same diet', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'wake', userId: 'u1', origin: 'agent' } as any }));
    expect(mockListRecentCodingTranscript).toHaveBeenCalledWith('s1', 2 * 2 + 1 + CARD_OVERFETCH);
  });

  it('a user-anchored claim keeps the full 24-pair window (take 49 + the card over-fetch) — user runs unchanged', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'build it', userId: 'u1', userTurnAt: new Date().toISOString() } as any }));
    expect(mockListRecentCodingTranscript).toHaveBeenCalledWith('s1', 24 * 2 + 1 + CARD_OVERFETCH);
  });

  it('harness status cards never reach the model as its own prior turns; the window stays 5 real rows (owner ask 2026-09-15)', async () => {
    // Newest-first, as listRecentCodingTranscript returns: input row, a
    // session card, then real turns. The card is dropped; the newest 5
    // real rows survive (the input row is popped by the executor as usual).
    mockListRecentCodingTranscript.mockResolvedValueOnce([
      { role: 'user', content: 'wake (input)', parts: null, metadata: { origin: 'schedule' } },
      { role: 'assistant', content: '**Re-Send Path C: on step 6 of 9; 3 runs finished**\n\n**Blocked**\n- A run hit an error', parts: null, metadata: { origin: 'session_status', kind: 'session_status' } },
      { role: 'assistant', content: 'final B', parts: null, metadata: { origin: 'schedule', triggerKind: 'schedule' } },
      { role: 'user', content: 'wake B', parts: null, metadata: { origin: 'schedule' } },
      { role: 'assistant', content: 'final A', parts: null, metadata: { origin: 'schedule', triggerKind: 'schedule' } },
      { role: 'user', content: 'wake A', parts: null, metadata: { origin: 'schedule' } },
      { role: 'assistant', content: '**older project card**', parts: null, metadata: { origin: 'project_status' } },
      { role: 'assistant', content: 'final Z (beyond the window once cards are dropped)', parts: null, metadata: {} },
    ]);
    await executeClaimedRun(makeClaim());
    const history = mockRunCodingAgent.mock.calls[0][0].history.map((h: any) => h.content);
    expect(history.some((c: string) => c.includes('Re-Send Path C: on step 6 of 9'))).toBe(false);
    expect(history.some((c: string) => c.includes('older project card'))).toBe(false);
    // The window is 5 rows INCLUDING the popped input row → 4 real history rows,
    // the same 2 wake/report pairs the diet promises; 'final Z' stays outside it.
    expect(history).toEqual(['wake A', 'final A', 'wake B', 'final B']);
  });
});

describe('workspace re-provision run-start notice (P6 — B24)', () => {
  it('a rebuilt worktree stamps schedulerNotice with the WORKSPACE RE-PROVISIONED warning', async () => {
    mockIsUsableWorktree.mockResolvedValue(false); // exists but unusable → reattach path
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(String(input.schedulerNotice)).toContain('WORKSPACE RE-PROVISIONED');
    expect(String(input.schedulerNotice)).toContain('Re-verify environment assumptions');
  });

  it('an intact worktree carries no re-provision notice (and no phantom schedulerNotice)', async () => {
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.schedulerNotice).toBeUndefined();
  });

  it('the notice COMPOSES with the cap-skip notice instead of replacing it', async () => {
    mockIsUsableWorktree.mockResolvedValue(false);
    await executeClaimedRun(makeClaim({ input: { message: 'go', userId: 'u1', capSkippedNotice: 3 } as any }));
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(String(input.schedulerNotice)).toContain('3 scheduled firing(s) were skipped');
    expect(String(input.schedulerNotice)).toContain('WORKSPACE RE-PROVISIONED');
  });
});

// ── Remediation P7 (spark G13) — the required-probe gate at finalize ──────────

describe('required-probe gate (P7 G13)', () => {
  const NOTICE_KEY = 'coding:sched:probenotice:sch_1';
  const MISS_KEY = 'coding:sched:probemiss:sch_1';
  const schedClaim = (over: Partial<ClaimedRun> = {}) =>
    makeClaim({ input: { message: 'run the monitor', userId: 'u1', origin: 'schedule', scheduleId: 'sch_1' }, ...over });
  const withProbes = () =>
    mockPrisma.chatSchedule.findUnique.mockResolvedValue({
      enabled: true, lastStatus: null,
      requiredProbes: [{ tool: 'run_command' }],
    });

  afterEach(() => {
    // withProbes() sets a persistent implementation — restore the suite default
    // (clearAllMocks clears calls, not implementations).
    mockPrisma.chatSchedule.findUnique.mockImplementation(async () => ({ enabled: true }));
  });

  it('a machine firing that completes WITHOUT the required receipt: journal annotation + next-firing notice + streak count', async () => {
    withProbes();
    await executeClaimedRun(schedClaim());

    expect(finalizeCall()?.[0].data.status).toBe('completed'); // status semantics untouched
    expect(mockWriteProbeMissEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', runId: 'run1', missing: ['run_command'],
    }));
    expect(mockStore.get(NOTICE_KEY)).toBe('run_command');
    expect(mockStore.get(MISS_KEY)).toBe('1');
  });

  it('a firing WITH a matching OK receipt is compliant: streak reset, no annotation', async () => {
    withProbes();
    mockStore.set(MISS_KEY, '2'); // an in-flight streak from earlier firings
    mockGetRunReceipts.mockResolvedValue([
      { id: 'r1', chatId: 's1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() },
    ]);
    await executeClaimedRun(schedClaim());
    expect(mockWriteProbeMissEntryAsync).not.toHaveBeenCalled();
    expect(mockStore.has(MISS_KEY)).toBe(false); // reset
  });

  it('no requiredProbes on the schedule ⇒ the gate is inert', async () => {
    await executeClaimedRun(schedClaim());
    expect(mockWriteProbeMissEntryAsync).not.toHaveBeenCalled();
    expect(mockStore.has(NOTICE_KEY)).toBe(false);
  });

  it('user runs are exempt', async () => {
    withProbes();
    // A user-turn run on the same schedule id never feeds the gate.
    await executeClaimedRun(makeClaim({
      input: { message: 'manual poke', userId: 'u1', userTurnAt: new Date().toISOString(), scheduleId: 'sch_1' } as any,
    }));
    expect(mockWriteProbeMissEntryAsync).not.toHaveBeenCalled();
  });
});

describe('machine-run deadline anchoring (v1#33 double-count fix)', () => {
  const TEN_MIN = 10 * 60_000;
  const agentProfile = () => mockRunCodingAgent.mock.calls[0][0].profile;
  // Gate flip 2026-09-11: the machine-run deadline is default OFF
  // (computeMachineRunDeadlineMs returns null) — these anchoring cases pin the
  // ENFORCED arithmetic, so they opt in.
  beforeEach(() => { process.env.RUN_DEADLINE_ENABLED = '1'; });

  it('COLD re-claim (no checkpoint): the budget stays anchored to the durable first-claim startedAt (2026-09-09 watcher jam)', async () => {
    // Machine trigger (input, no userTurnAt) claimed cold 10 min after first claim.
    await executeClaimedRun(makeClaim({
      input: { message: 'machine wake', userId: 'u1' },
      startedAt: new Date(Date.now() - TEN_MIN),
    }));
    const profile = agentProfile();
    // floor 20 min − ~10 min elapsed ⇒ ~10 min remaining (never the full budget).
    expect(profile.runDeadlineMs).toBeLessThanOrEqual(MACHINE_RUN_DEADLINE_FLOOR_MS - TEN_MIN);
    expect(profile.runDeadlineMs).toBeGreaterThan(MACHINE_RUN_DEADLINE_FLOOR_MS - TEN_MIN - 30_000);
  });

  it('CHECKPOINT resume: the FULL budget is passed — agent.ts anchors elapsed to the checkpoint runStartedAt itself, so remaining would subtract elapsed twice', async () => {
    await executeClaimedRun(makeClaim({
      checkpoint: CP, // carries runStartedAt — agent.ts resumes its own clock from it
      input: null,    // auto-resume ⇒ triggerKind 'machine'
      startedAt: new Date(Date.now() - TEN_MIN),
    }));
    expect(agentProfile().runDeadlineMs).toBe(MACHINE_RUN_DEADLINE_FLOOR_MS);
  });
});

describe('attribution on conviction (guard REPLACE ⇒ framework-vs-model investigation ticket)', () => {
  it('a convicted machine final fire-and-forget files fileStreakInvestigation with the synthetic final_answer evidence', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1'; // enforce-mode pin (gate flip 2026-09-11)
    const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged, and the deploy run finished green.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: PHANTOM,
      parts: [{ type: 'text', text: PHANTOM }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText,
      notes: [],
      verdict: {
        unprovenKinds: ['pr_merged'], fabricatedPrs: [], refutedMergePrs: [224], futureDated: [],
        refutedDeployRuns: ['deploy run 12345 concluded failure'],
        unprovenClaims: [{ text: PHANTOM, kind: 'pr_merged' }],
      },
    }));

    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget reflection import

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    expect(mockFileStreakInvestigation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', runId: 'run1', tool: 'final_answer', perma: false,
    }));
    const failures: string[] = mockFileStreakInvestigation.mock.calls[0][0].recentFailures;
    expect(failures[0]).toContain('guard findings:');
    expect(failures[0]).toContain('refuted_merge');
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringContaining('PR #224 is not merged'),
      expect.stringContaining('deploy run 12345'),
    ]));
  });

  it('a clean machine final never files the investigation ticket', async () => {
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    await new Promise((r) => setImmediate(r));
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});

// ── Gate flip 2026-09-11 (owner: "full steam") — evidence guard OBSERVE-ONLY ──
// Owner directive: gates that withhold/replace a machine lane's OWN work go
// observe-only. The guard still DETECTS every class and records GUARD_STRIKE
// (meta.outcome 'observed') + the journal verdict row, but the run's original
// final is delivered with the guard's notes appended; nothing is struck,
// replaced, ticketed, plan-stamped or alarmed. EVIDENCE_GUARD_ENFORCE=1
// restores the whole conviction pipeline (the enforce-mode pins above).
describe('gate flip 2026-09-11 — evidence guard observe-only by default (EVIDENCE_GUARD_ENFORCE / QUOTE_GUARD_ENFORCE)', () => {
  const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.';
  const FOOTER = '🔍 Harness claim verification (verified-at 2026-08-22T00:00:00.000Z):\n• PR #224 — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated';
  const hardVerdictGuard = (opts: any) => ({
    finalText: `${opts.finalText}\n\n[HARNESS EVIDENCE GUARD] note\n\n${FOOTER}`,
    notes: ['[HARNESS EVIDENCE GUARD] note', FOOTER],
    verdict: {
      unprovenKinds: ['pr_merged'], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [],
      unprovenClaims: [{ kind: 'pr_merged', prNumber: 224, text: PHANTOM }],
    },
  });
  const machineRun = () => executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
  const assistantRow = () => mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant')?.[0];
  // fb64368a: the observe-only posture this describe pins is the OWNER'S
  // protected class — honest work in the wrong receipt shape on a run that
  // DID execute tools. Each scenario's agent therefore carries ≥1 receipt so
  // the zero-receipt fabrication gate (its own suite below) never fires here:
  // zeroReceipt is false and the pin stays about EVIDENCE_GUARD_ENFORCE.
  const withReceipt = (finalText: string, extra: Record<string, unknown> = {}) => mockRunCodingAgent.mockImplementationOnce(async () => ({
    finalText,
    parts: [{ type: 'text', text: finalText }],
    receipts: [{ id: 'rrrr4444-5555-6666-7777-888899990000', chatId: 's1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() }],
    ...extra,
  }));

  it('DEFAULT: hard findings are DETECTED + recorded, but the ORIGINAL final delivers with the notes appended — no REPLACE, no strike marks, no ticket, no plan stamp, no investigation, no alarm', async () => {
    withReceipt(PHANTOM);
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => hardVerdictGuard(opts));

    await machineRun();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Delivered: the original leads, the guard's notes follow — annotate-only.
    const row = assistantRow();
    const content: string = row.content;
    expect(content.startsWith(PHANTOM)).toBe(true);
    expect(content).toContain('NO such PR (404)');
    expect(content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(content).not.toContain('BEGIN UNVERIFIED RUN OUTPUT');
    expect(row.parts.some((p: any) => p.struck || p.marker === 'guard')).toBe(false);
    // No guardOriginal attachment — nothing was removed. The row still carries
    // the run's provenance stamp (2026-09-15: origin + triggerKind on every final).
    expect(row.metadata).not.toHaveProperty('guardOriginal');
    expect(row.metadata).toEqual(expect.objectContaining({ triggerKind: expect.any(String) }));
    // Telemetry keeps flowing: the strike row names the classes and says OBSERVED;
    // the harness-owned verdict row is written; guard_miss is NOT recorded.
    // Firing-20 (2026-10-10): meta.claims carries the struck claim excerpts (bounded).
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', sessionId: 's1', runId: 'run1',
      meta: { seam: 'final_verdict', kinds: ['unproven_completion', 'fabricated_pr'], outcome: 'observed', claims: [{ kind: 'pr_merged', text: PHANTOM }] },
    }));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'guard_miss' }));
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', triggerKind: 'schedule', unprovenKinds: ['pr_merged'], fabricatedPrs: [224],
    }));
    // Journal + memory fold + hook digest carry the run's OWN text (never a verdict-line substitution).
    expect(mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal).toContain(PHANTOM);
    expect(mockWriteRunJournalEntryAsync.mock.calls[0][0].assistantFinal).not.toContain('evidence guard replaced');
    const hook = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'run_completed');
    expect(hook?.[2]).toContain('Coding run completed.');
    expect(hook?.[2]).not.toContain('REPLACED its final answer');
    // Enforcement side-effects are all quiet.
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockMarkPlanGuardStrike).not.toHaveBeenCalled();
    expect(mockClearPlanGuardStrike).not.toHaveBeenCalled(); // a finding never CLEARS a prior strike either
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe.mock.calls.some((c: any[]) => c[1] === 'attention_needed')).toBe(false);
    expect(finalizeCall()?.[0].data.status).toBe('completed');
  });

  it('build 2026-10-08 F-2: a run carrying a finish_run SHADOW record gets ONE finish_run_agreement row — the guard verdict on the SAME final — and the delivery is unchanged', async () => {
    const finishRun = {
      source: 'model', calls: 1, offered: true, nudge: { outcome: 'not_needed' }, status: 'done', valid: true, errors: [], repairs: [],
      claims: 1, verified: 1, unverified: 0, unverifiable: 0, scopeMismatch: 0, byVia: { this_run: 1 }, claimTypes: { pr_merged: 1 }, aliasTypes: 0,
      rejected: [], unverifiableRefs: [], openItems: 0, openKinds: {}, undeclared: 0, undeclaredSample: [], summaryChars: 20, finalChars: PHANTOM.length, receiptsAtCall: 1,
    };
    withReceipt(PHANTOM, { finishRun });
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => hardVerdictGuard(opts));

    await machineRun();
    await new Promise((r) => setImmediate(r));

    expect(assistantRow().content.startsWith(PHANTOM)).toBe(true);
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'finish_run_agreement');
    expect(rows).toEqual([expect.objectContaining({
      sessionId: 's1', runId: 'run1',
      meta: expect.objectContaining({ detector: 'evidence_guard', cell: 'detector_only', agree: false, finishValid: true, detectorConvicted: true, detectorKinds: ['unproven_completion', 'fabricated_pr'], hard: true, fence: 'none' }),
    })]);
  });

  it('build 2026-10-08 F-2: no finish_run record (human turn / FINISH_RUN_DISABLED=1) ⇒ no agreement row', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: PHANTOM, parts: [{ type: 'text', text: PHANTOM }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => hardVerdictGuard(opts));
    await machineRun();
    await new Promise((r) => setImmediate(r));
    expect(mockRecordLoopMetric.mock.calls.some((c: any[]) => c[0]?.kind === 'finish_run_agreement')).toBe(false);
  });

  it('finding A1 review fix: EVIDENCE_GUARD_ENFORCE=1 with a commit_local-ONLY verdict (unproven commit_local + localOnlyShas) stays ANNOTATE-ONLY — original delivered, no REPLACE/REDACT, no ticket; telemetry + journal keep the full classes', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    const BANKED = 'Spark B11: fully banked a65e79f4c0ffee01 on lane/spark-b11.';
    const LOCAL_FOOTER = '🔍 Harness push-claim verification (commits API):\n• a65e79f4c0ff… — ⚠︎ LOCAL ONLY — commit not on origin (404): described as banked/committed but no push carried it; treat it as NOT PUSHED (the commit may exist only in the session worktree)';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: BANKED, parts: [{ type: 'text', text: BANKED }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n${LOCAL_FOOTER}\n\n[HARNESS EVIDENCE GUARD] commit_local note`,
      notes: [LOCAL_FOOTER, '[HARNESS EVIDENCE GUARD] commit_local note'],
      verdict: {
        unprovenKinds: ['commit_local'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
        unprovenClaims: [{ kind: 'commit_local', sha: 'a65e79f4c0ffee01', text: BANKED }],
        localOnlyShas: ['a65e79f4c0ffee01'],
      },
    }));

    await machineRun();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const row = assistantRow();
    const content: string = row.content;
    expect(content.startsWith(BANKED)).toBe(true); // the banked line is DELIVERED
    expect(content).toContain('LOCAL ONLY — commit not on origin');
    expect(content).not.toContain('FINAL ANSWER WAS REPLACED');
    expect(content).not.toContain('REMOVED');
    expect(row.parts.some((p: any) => p.struck || p.marker === 'guard')).toBe(false);
    expect(row.metadata).not.toHaveProperty('guardOriginal');
    // Telemetry + journal still carry the FULL classes (observe-only outcome).
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', sessionId: 's1', runId: 'run1',
      meta: { seam: 'final_verdict', kinds: ['unproven_completion', 'local_only_commit'], outcome: 'observed', claims: [{ kind: 'commit_local', text: BANKED }] },
    }));
    expect(mockWriteGuardVerdictEntryAsync).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', unprovenKinds: ['commit_local'], localOnlyShas: ['a65e79f4c0ffee01'],
    }));
    // No enforcement side-effects for the observe-only class.
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockMarkPlanGuardStrike).not.toHaveBeenCalled();
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).toBe('completed');

    // CONTROL: the same verdict PLUS a fabricated PR still REPLACES under enforcement — the other class drives it.
    jest.clearAllMocks();
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: `${BANKED}\n${PHANTOM}`, parts: [{ type: 'text', text: `${BANKED}\n${PHANTOM}` }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n[HARNESS EVIDENCE GUARD] note\n\n${FOOTER}`,
      notes: ['[HARNESS EVIDENCE GUARD] note', FOOTER],
      verdict: {
        unprovenKinds: ['pr_merged', 'commit_local'], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [],
        unprovenClaims: [{ kind: 'pr_merged', prNumber: 224, text: PHANTOM }, { kind: 'commit_local', sha: 'a65e79f4c0ffee01', text: BANKED }],
        localOnlyShas: ['a65e79f4c0ffee01'],
      },
    }));
    await machineRun();
    await new Promise((r) => setImmediate(r));
    expect(assistantRow().content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ area: 'fleet-integrity', type: 'mishap' }));
  });

  it('DEFAULT: a machine run hands agent.ts maxRejections 0 (in-loop reject-back never bounces); EVIDENCE_GUARD_ENFORCE=1 restores 1', async () => {
    await machineRun();
    expect(mockRunCodingAgent.mock.calls[0][0].evidenceGuardRejectBack).toEqual(expect.objectContaining({
      triggerKind: 'schedule', maxRejections: 0,
    }));
    // Wiring pin (review MINOR 3, sub-session 6bdc4019, ticket dc636d0c): the
    // union-resolve resolvers must ride BOTH guard surfaces — a missing
    // goalIdsExist here would silently regress GUARD 6's fence union leg with
    // no red test (the guard-level tests pin behavior, not this threading).
    const rb = mockRunCodingAgent.mock.calls[0][0].evidenceGuardRejectBack;
    expect(typeof rb.goalIdsExist).toBe('function');
    expect(typeof rb.todoIdsExist).toBe('function');
    expect(rb.ticketIdsExist).not.toBe(rb.goalIdsExist); // a distinct resolver, not an alias

    jest.clearAllMocks();
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    await machineRun();
    expect(mockRunCodingAgent.mock.calls[0][0].evidenceGuardRejectBack).toEqual(expect.objectContaining({
      triggerKind: 'schedule', maxRejections: 1,
    }));
  });

  it('EVIDENCE_GUARD_ENFORCE=1 alone: a fabricated_quote-ONLY verdict is NOTE-ONLY — annotated delivery, observed strike row, ticket marks containedPreDelivery:false', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    const QUOTED = 'Bench done. Verbatim output:\n```\n[34/55] gpqa-100 r0 TRUNC\n```';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: QUOTED, parts: [{ type: 'text', text: QUOTED }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: `${opts.finalText}\n\n[UNVERIFIED QUOTED OUTPUT] note`,
      notes: ['[UNVERIFIED QUOTED OUTPUT] note'],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], fabricatedQuotes: ['[34/55] gpqa-100 r0 TRUNC'] },
    }));

    await machineRun();
    await new Promise((r) => setImmediate(r));

    const row = assistantRow();
    expect(row.content.startsWith(QUOTED)).toBe(true);
    expect(row.content).toContain('[UNVERIFIED QUOTED OUTPUT] note');
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: { seam: 'final_verdict', kinds: ['fabricated_quote'], outcome: 'observed' },
    }));
    expect(mockFileFeedbackTicket.mock.calls[0]?.[0]?.context).toEqual(expect.objectContaining({ containedPreDelivery: false }));
    expect(mockMarkPlanGuardStrike).not.toHaveBeenCalled();
  });

  it('EVIDENCE_GUARD_ENFORCE=1 + QUOTE_GUARD_ENFORCE=1: the quote class convicts again — whole-final REPLACE, enforced strike row', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    process.env.QUOTE_GUARD_ENFORCE = '1';
    const QUOTED = 'Bench done. Verbatim output:\n```\n[34/55] gpqa-100 r0 TRUNC\n```';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: QUOTED, parts: [{ type: 'text', text: QUOTED }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], fabricatedQuotes: ['[34/55] gpqa-100 r0 TRUNC'] },
    }));

    await machineRun();
    await new Promise((r) => setImmediate(r));

    const row = assistantRow();
    expect(row.content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: { seam: 'final_verdict', kinds: ['fabricated_quote'], outcome: 'enforced' },
    }));
    expect(mockMarkPlanGuardStrike).toHaveBeenCalledWith('s1', expect.any(String));
  });

  it('DEFAULT: a clean machine final is unchanged — guard_miss, plan strike CLEARED, nothing annotated', async () => {
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    await machineRun();
    await new Promise((r) => setImmediate(r));
    expect(assistantRow().content).toBe('done');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'guard_miss', sessionId: 's1' }));
    expect(mockClearPlanGuardStrike).toHaveBeenCalledWith('s1');
    expect(mockWriteGuardVerdictEntryAsync).not.toHaveBeenCalled();
  });
});

// Review 2026-09-13 issue 10: the delta coalescer now covers subagent deltas.
// Workers' per-chunk 'subagent:text'/'subagent:reasoning' events used to bypass
// it and were 89% of agent_events inserts (18 GB of a 22 GB RDS volume).
describe('delta coalescing — subagent deltas (review 2026-09-13 issue 10)', () => {
  /** Durable-tap rows of one type, in seq order → [seq, delta]. */
  const tapped = (type: string) => mockPrisma.agentEvent.create.mock.calls
    .map((c: any[]) => c[0].data)
    .filter((d: any) => d.type === type)
    .sort((a: any, b: any) => a.seq - b.seq)
    .map((d: any) => [d.seq, d.payload?.delta ?? d.payload?.title]);

  it("consecutive 'subagent:text' deltas land as ONE agent_events row; subagent_start/_end and a kind switch delimit frames (per-worker identity preserved)", async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('subagent_start', { title: 'W1', role: 'worker' });
      input.emit('subagent:text', { delta: 'alpha ' });
      input.emit('subagent:text', { delta: 'beta' });
      input.emit('subagent:reasoning', { delta: 'hmm' });   // kind switch → flushes 'alpha beta'
      input.emit('subagent:text', { delta: 'gamma' });      // kind switch → flushes 'hmm'
      input.emit('subagent_end', { title: 'W1', role: 'worker', summary: 's' }); // flushes 'gamma'
      input.emit('subagent_start', { title: 'W2', role: 'worker' });
      input.emit('subagent:text', { delta: 'del' });
      input.emit('subagent:text', { delta: 'ta' });         // W2's frame — never merged with W1's
      return { finalText: 'done', parts: [{ type: 'text', text: 'done' }] }; // 'complete' flushes 'delta'
    });
    await executeClaimedRun(makeClaim());

    const text = tapped('subagent:text');
    expect(text.map((t: any) => t[1])).toEqual(['alpha beta', 'gamma', 'delta']);
    // The reasoning delta still delimits the text frames above (the coalescer flushes on the kind switch), but
    // since 2026-10-04 it never reaches agent_events itself — thinking stays on the server (coding/reasoning-wire.ts).
    expect(tapped('subagent:reasoning').map((t: any) => t[1])).toEqual([]);

    // Ordering against the delimiting lifecycle events is exact.
    const starts = tapped('subagent_start');
    const ends = tapped('subagent_end');
    expect(starts.map((s: any) => s[1])).toEqual(['W1', 'W2']);
    expect(text[0][0]).toBeGreaterThan(starts[0][0]);  // 'alpha beta' after W1 start
    expect(text[1][0]).toBeLessThan(ends[0][0]);       // 'gamma' before W1 end
    expect(text[2][0]).toBeGreaterThan(starts[1][0]);  // 'delta' after W2 start
    expect(text[2][0]).toBeLessThan(
      mockPrisma.agentEvent.create.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.type === 'complete').seq,
    );
  });

  it('a main↔subagent kind switch flushes too (no cross-stream merge), and subagent deltas never enter the persisted transcript', async () => {
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      input.emit('text', { delta: 'main ' });
      input.emit('subagent:text', { delta: 'worker' });
      input.emit('text', { delta: 'again' });
      return { finalText: 'main again', parts: [{ type: 'text', text: 'main again' }] };
    });
    await executeClaimedRun(makeClaim());

    expect(tapped('text').map((t: any) => t[1])).toEqual(['main ', 'again']);
    expect(tapped('subagent:text').map((t: any) => t[1])).toEqual(['worker']);
    // accumulate() is unchanged: only main 'text' reaches the assistant row.
    const assistant = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant')?.[0];
    expect(assistant?.content).not.toContain('worker');
  });
});

// ── Run-start PROJECT MEMORY injection + finalize decision extraction (owner
//    2026-09-14: "coding sessions must read the project knowledge base and
//    project decisions", per-user gated; memory failures degrade recall, never
//    a request) ─────────────────────────────────────────────────────────────
describe('project memory — run-start injection (formatProjectMemoryBlock / buildProjectMemoryInjection)', () => {
  const finding = (source: string, ref: string, content: string, score?: number) => ({ source, ref, content, ...(score !== undefined ? { score } : {}) });

  it('block shape: header + one "- (<source> · <ref>) <excerpt>" line per item, whitespace flattened, excerpt capped at 400 chars', () => {
    const long = 'x'.repeat(PROJECT_MEMORY_ITEM_EXCERPT_CHARS + 50);
    const { block, items, sources } = formatProjectMemoryBlock([
      finding('document', 'doc:d1#3', '[spec.pdf] The API\n  must   return 429 on quota exhaustion.'),
      finding('decision', 'decision:9', 'Rate limiting uses a token bucket per key.'),
      finding('learning', 'learnings.md', long),
    ]);
    expect(items).toBe(3);
    expect(sources).toEqual({ document: 1, decision: 1, learning: 1 });
    const lines = block.split('\n');
    expect(lines[0]).toBe(PROJECT_MEMORY_HEADER);
    expect(lines[1]).toMatch(/knowledge base/);
    expect(lines[1]).toMatch(/not instructions/i);
    expect(lines[2]).toBe('- (document · doc:d1#3) [spec.pdf] The API must return 429 on quota exhaustion.');
    expect(lines[3]).toBe('- (decision · decision:9) Rate limiting uses a token bucket per key.');
    const learningLine = lines[4];
    expect(learningLine.startsWith('- (learning · learnings.md) ')).toBe(true);
    const excerpt = learningLine.slice('- (learning · learnings.md) '.length);
    expect(excerpt.length).toBe(PROJECT_MEMORY_ITEM_EXCERPT_CHARS); // 399 chars + the ellipsis
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('a ref-less finding renders as "- (<source>) <excerpt>"', () => {
    const { block } = formatProjectMemoryBlock([finding('decision', '', 'Use pgvector HNSW.')]);
    expect(block.split('\n').pop()).toBe('- (decision) Use pgvector HNSW.');
  });

  it('the whole block is capped at 3500 chars — items past the cap are dropped whole, never split', () => {
    const big = Array.from({ length: 12 }, (_, i) => finding('document', `doc:d${i}#0`, `[f${i}.md] ${'y'.repeat(380)}`));
    const { block, items } = formatProjectMemoryBlock(big);
    expect(block.length).toBeLessThanOrEqual(PROJECT_MEMORY_BLOCK_CAP_CHARS);
    expect(items).toBeLessThan(12);
    expect(items).toBeGreaterThan(0);
    // Every rendered line is a complete item.
    for (const line of block.split('\n').slice(2)) expect(line).toMatch(/^- \(document · doc:d\d+#0\) \[f\d+\.md\] y+$/);
  });

  it('rerank score floor: a scored finding under the floor is dropped, at/above it kept, an unscored one kept', () => {
    const { block, items } = formatProjectMemoryBlock([
      finding('document', 'doc:a#0', 'weak match', 0.05),
      finding('document', 'doc:b#0', 'strong match', 0.6),
      finding('learning', 'learnings.md', 'unscored learning'),
      finding('decision', 'decision:1', 'exactly at the floor', PROJECT_MEMORY_MIN_SCORE),
    ]);
    expect(items).toBe(3);
    expect(block).not.toContain('weak match');
    expect(block).toContain('strong match');
    expect(block).toContain('unscored learning');
    expect(block).toContain('exactly at the floor');
  });

  it('nothing survives → empty block, zero items (the executor injects nothing)', () => {
    expect(formatProjectMemoryBlock([])).toEqual({ block: '', items: 0, sources: {} });
    expect(formatProjectMemoryBlock([finding('document', 'doc:a#0', '   '), finding('document', 'doc:b#0', 'x', 0.01)]).block).toBe('');
  });

  it('buildProjectMemoryInjection: searches the PROJECT scope on the task text with sources learning/decision/document (never code), k=6, the run userId; records coding_memory_injected value = items', async () => {
    mockSearchMemory.mockResolvedValue([
      finding('decision', 'decision:1', 'We chose Postgres.', 0.8),
      finding('document', 'doc:d1#0', '[adr.md] Postgres over Mongo for joins.', 0.7),
      finding('learning', 'learnings.md', 'noise', 0.02), // under the floor
    ]);
    const header = '[MACHINE-TRIGGERED RUN — schedule abc]\n\n';
    const task = `${header}Migrate the users table ${'z'.repeat(2000)}`;
    const res = await buildProjectMemoryInjection({ sessionId: 's1', userId: 'u1', projectId: 'p1', taskText: task, runId: 'run1', trigger: 'schedule' });
    expect(mockSearchMemory).toHaveBeenCalledTimes(1);
    const [sid, query, k, opts] = mockSearchMemory.mock.calls[0];
    expect(sid).toBe('s1');
    expect(query.startsWith('Migrate the users table')).toBe(true); // provenance header stripped
    expect(query.length).toBe(1500);                                  // first 1500 chars
    expect(k).toBe(6);
    expect(opts).toEqual({ scope: 'project', projectId: 'p1', userId: 'u1', sources: ['learning', 'decision', 'document'] });
    expect(res.items).toBe(2);
    expect(res.block).toContain(PROJECT_MEMORY_HEADER);
    expect(res.block).toContain('- (decision · decision:1) We chose Postgres.');
    expect(res.block).not.toContain('noise');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'coding_memory_injected', sessionId: 's1', runId: 'run1', value: 2,
      meta: expect.objectContaining({ trigger: 'schedule', sources: { decision: 1, document: 1 }, candidates: 3 }),
    }));
  });

  it('buildProjectMemoryInjection: empty retrieval → no block, metric value 0 (charts the empty rate)', async () => {
    const res = await buildProjectMemoryInjection({ sessionId: 's1', userId: 'u1', projectId: 'p1', taskText: 'do the thing', runId: 'run1' });
    expect(res).toEqual({ block: '', items: 0 });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'coding_memory_injected', value: 0 }));
  });

  it('buildProjectMemoryInjection: no task text / no user / retrieval throwing → never throws, no block', async () => {
    expect(await buildProjectMemoryInjection({ sessionId: 's1', userId: 'u1', projectId: 'p1', taskText: '   ' })).toEqual({ block: '', items: 0 });
    expect(await buildProjectMemoryInjection({ sessionId: 's1', userId: '', projectId: 'p1', taskText: 'x' })).toEqual({ block: '', items: 0 });
    expect(mockSearchMemory).not.toHaveBeenCalled();
    mockSearchMemory.mockRejectedValueOnce(new Error('embed down'));
    expect(await buildProjectMemoryInjection({ sessionId: 's1', userId: 'u1', projectId: 'p1', taskText: 'x' })).toEqual({ block: '', items: 0 });
  });

  it('executeClaimedRun wiring: the block rides the FIRST injectSystem poll (one-shot), ahead of any steer; the persisted user row and agent userMessage stay the plain prompt', async () => {
    mockSearchMemory.mockResolvedValue([finding('document', 'doc:d1#0', '[spec.pdf] Build it with pgvector.', 0.9)]);
    await executeClaimedRun(makeClaim());

    // Searched on the run's identity: session, task text, the run USER (the gate).
    expect(mockSearchMemory).toHaveBeenCalledWith('s1', 'build it', 6, { scope: 'project', projectId: 'p1', userId: 'u1', sources: ['learning', 'decision', 'document'] });
    // The user row + the model's user message are untouched — the block is context, not the user's words.
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'build it' }));
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.userMessage).toBe('build it');
    expect(input.schedulerNotice).toBeUndefined();
    expect(input.chatSystemPrompt).toBeUndefined();

    const first = await input.injectSystem(0);
    expect(typeof first).toBe('string');
    expect(first).toContain(PROJECT_MEMORY_HEADER);
    expect(first).toContain('- (document · doc:d1#0) [spec.pdf] Build it with pgvector.');
    expect(await input.injectSystem(1)).toBeNull(); // delivered once

    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'coding_memory_injected', sessionId: 's1', runId: 'run1', value: 1,
      stamp: expect.objectContaining({ profile: 'coding', triggerKind: 'schedule' }),
    }));
  });

  it('executeClaimedRun wiring: memory + a pending steer on the same first poll → memory block first, then the steer instruction', async () => {
    mockSearchMemory.mockResolvedValue([finding('decision', 'decision:1', 'Ship behind a flag.', 0.9)]);
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    await pushSteerMessage('s1', { text: 'turn left' });
    const injected = await input.injectSystem(0);
    expect(injected.indexOf(PROJECT_MEMORY_HEADER)).toBe(0);
    expect(injected).toContain('- (decision · decision:1) Ship behind a flag.');
    expect(injected.indexOf('turn left')).toBeGreaterThan(injected.indexOf('Ship behind a flag.'));
  });

  it('executeClaimedRun wiring (OWNER-DIRECTIVE-FANOUT): the owner directives in force ride the FIRST poll ahead of the memory block, once, with ONE delivery row', async () => {
    mockSearchMemory.mockResolvedValue([finding('decision', 'decision:1', 'Ship behind a flag.', 0.9)]);
    const shown = [{ id: 'oq_892c91ae-ruling', text: 'no new boxes, ever', at: '2026-10-19T00:00:00Z', scope: 'fleet', match: 'fleet', standing: true, sourceChatId: 'fleet-sup' }];
    mockBuildOwnerDirectives.mockResolvedValue({ block: '[OWNER DIRECTIVES IN FORCE — scope: fleet + proj]\n- [fleet] no new boxes, ever (oq_892c9, 2026-10-19, standing)', shown, hidden: 0 });
    await executeClaimedRun(makeClaim());
    expect(mockBuildOwnerDirectives).toHaveBeenCalledWith('u1', 'p1', { projectName: 'proj' });
    const input = mockRunCodingAgent.mock.calls[0][0];
    const first = await input.injectSystem(0);
    expect(first.indexOf('[OWNER DIRECTIVES IN FORCE')).toBe(0);
    expect(first.indexOf(PROJECT_MEMORY_HEADER)).toBeGreaterThan(first.indexOf('no new boxes, ever'));
    expect(await input.injectSystem(1)).toBeNull(); // delivered once
    await new Promise((r) => setImmediate(r));
    expect(mockRecordOwnerDirectiveDelivered).toHaveBeenCalledTimes(1);
    expect(mockRecordOwnerDirectiveDelivered).toHaveBeenCalledWith({ targetChatId: 's1', surface: 'lane_run', shown, hidden: 0, runId: 'run1' });
  });

  it('executeClaimedRun wiring (OWNER-DIRECTIVE-FANOUT): a supervisor chat run never asks for the block; a builder failure is no block', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (a: any) => (a?.select?.isProjectSupervisor ? { isSupervisor: false, isProjectSupervisor: true } : { userId: 'u1' }));
    try {
      await executeClaimedRun(makeClaim());
      expect(mockBuildOwnerDirectives).not.toHaveBeenCalled();
      expect(await mockRunCodingAgent.mock.calls[0][0].injectSystem(0)).toBeNull();
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ userId: 'u1' }));
    }
    mockRunCodingAgent.mockClear();
    mockBuildOwnerDirectives.mockRejectedValueOnce(new Error('db down'));
    await executeClaimedRun(makeClaim());
    expect(await mockRunCodingAgent.mock.calls[0][0].injectSystem(0)).toBeNull();
  });

  it('executeClaimedRun wiring: empty retrieval → first poll returns null exactly like before (no empty block)', async () => {
    await executeClaimedRun(makeClaim());
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(await input.injectSystem(0)).toBeNull();
  });

  it('executeClaimedRun wiring: an auto-resume with no new message has no task text → no search (nothing to search on)', async () => {
    await executeClaimedRun(makeClaim({ preStatus: 'running', checkpoint: CP, input: null, inputConsumed: true }));
    expect(mockSearchMemory).not.toHaveBeenCalled();
  });
});

describe('project memory — finalize feeds the memory pipeline (project decisions from coding finals, machineRun:true)', () => {
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

  it('a completed run calls updateContextAsync with { userId, projectId, chatId, userMessage, synthesis = the accepted final, machineRun: true }', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'Decided: pgvector HNSW for the index.', parts: [{ type: 'text', text: 'Decided: pgvector HNSW for the index.' }] }));
    await executeClaimedRun(makeClaim({ input: { message: '[MACHINE-TRIGGERED RUN — schedule abc]\n\nreview the index design', userId: 'u1' } }));
    await flush();
    expect(mockUpdateContextAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateContextAsync).toHaveBeenCalledWith({
      userId: 'u1', projectId: 'p1', chatId: 's1',
      userMessage: 'review the index design', // provenance header stripped
      synthesis: 'Decided: pgvector HNSW for the index.',
      machineRun: true,
    });
  });

  it('the pipeline gets the ACCEPTED final: on a guard replacement it receives the deterministic verdict line, never the struck text', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'Merged PR #99 and deployed.', parts: [{ type: 'text', text: 'Merged PR #99 and deployed.' }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], unprovenClaims: [], fabricatedPrs: [], refutedMergePrs: [99], futureDated: [], futureDatedClaims: [] },
    }));
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    await flush();
    expect(mockUpdateContextAsync).toHaveBeenCalledTimes(1);
    const arg = mockUpdateContextAsync.mock.calls[0][0];
    expect(arg.machineRun).toBe(true);
    expect(arg.synthesis).toMatch(/evidence guard replaced this run's final answer/);
    expect(arg.synthesis).not.toContain('Merged PR #99 and deployed.');
  });

  // 2026-09-21 (owner: "I only see 3 facts"): a run the HUMAN typed is a real
  // user turn — full pipeline (machineRun:false). Machine wakes unchanged.
  it('a run queued by a real user turn (userTurnAt, human text) feeds the pipeline as a user turn — machineRun:false', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'Planned the Windows port in three phases.', parts: [{ type: 'text', text: 'Planned the Windows port in three phases.' }] }));
    await executeClaimedRun(makeClaim({ input: { message: 'we need to begin putting together a plan to build our app for windows', userId: 'u1', userTurnAt: new Date().toISOString() } as any }));
    await flush();
    expect(mockUpdateContextAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateContextAsync.mock.calls[0][0]).toEqual(expect.objectContaining({ userId: 'u1', chatId: 's1', machineRun: false, userMessage: 'we need to begin putting together a plan to build our app for windows' }));
  });

  // Review 2026-10-23: nothing on the coding path reads the thread summary — a chat BORN a coding session (chat row
  // and coding state created together) skips the thread LLM extraction; a plain chat that got a workspace LATER keeps
  // it (its Dig-deeper turns run the chat agent, which reads the summary). Machine wakes never carry the flag.
  it('a human turn in a born-coding session asks the pipeline to skip the thread extraction; a later-attached chat does not', async () => {
    const t0 = new Date('2026-10-20T10:00:00.000Z');
    const final = async () => ({ finalText: 'Planned it.', parts: [{ type: 'text', text: 'Planned it.' }] });
    mockRunCodingAgent.mockImplementationOnce(final).mockImplementationOnce(final);
    mockGetSessionForUser.mockResolvedValueOnce({ ...SESSION, createdAt: new Date(t0.getTime() + 40), chatCreatedAt: t0 });
    await executeClaimedRun(makeClaim({ input: { message: 'plan the windows port please', userId: 'u1', userTurnAt: new Date().toISOString() } as any }));
    mockGetSessionForUser.mockResolvedValueOnce({ ...SESSION, createdAt: new Date(t0.getTime() + 3_600_000), chatCreatedAt: t0 });
    await executeClaimedRun(makeClaim({ id: 'run2', input: { message: 'plan the windows port please', userId: 'u1', userTurnAt: new Date().toISOString() } as any }));
    await flush();
    expect(mockUpdateContextAsync).toHaveBeenCalledTimes(2);
    expect(mockUpdateContextAsync.mock.calls[0][0]).toEqual(expect.objectContaining({ machineRun: false, skipThreadState: true }));
    expect(mockUpdateContextAsync.mock.calls[1][0]).toEqual(expect.objectContaining({ machineRun: false }));
    expect(mockUpdateContextAsync.mock.calls[1][0]).not.toHaveProperty('skipThreadState');
  });

  it('a userTurnAt anchor does NOT make an agent-sent or firing-header input human — machineRun stays true', async () => {
    const final = async () => ({ finalText: 'Done: swept the lane.', parts: [{ type: 'text', text: 'Done: swept the lane.' }] });
    mockRunCodingAgent.mockImplementationOnce(final).mockImplementationOnce(final);
    await executeClaimedRun(makeClaim({ input: { message: '[AGENT-SENT MESSAGE — from chat "X" (abc)] please review', userId: 'u1', userTurnAt: new Date().toISOString(), origin: 'agent' } as any }));
    await executeClaimedRun(makeClaim({ id: 'run2', input: { message: '[MACHINE-TRIGGERED RUN — schedule abc]\n\nsweep', userId: 'u1', userTurnAt: new Date().toISOString() } as any }));
    await flush();
    expect(mockUpdateContextAsync).toHaveBeenCalledTimes(2);
    expect(mockUpdateContextAsync.mock.calls.every((c: any[]) => c[0].machineRun === true)).toBe(true);
  });

  it('a FAILED run never feeds the pipeline (no accepted final)', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => { throw new Error('provider exploded'); });
    await executeClaimedRun(makeClaim({ input: { message: 'machine wake', userId: 'u1' } }));
    await flush();
    expect(finalizeCall()?.[0].data.status).toBe('failed');
    expect(mockUpdateContextAsync).not.toHaveBeenCalled();
  });

  it('a CANCELLED run never feeds the pipeline', async () => {
    mockRunCodingAgent.mockImplementationOnce(async () => { cancelRun('s1'); return { finalText: '', parts: [] }; });
    await executeClaimedRun(makeClaim());
    await flush();
    expect(finalizeCall()?.[0].data.status).toBe('cancelled');
    expect(mockUpdateContextAsync).not.toHaveBeenCalled();
  });

  it('a pipeline failure never breaks finalize (fire-and-forget)', async () => {
    mockUpdateContextAsync.mockImplementationOnce(() => { throw new Error('pipeline down'); });
    await executeClaimedRun(makeClaim());
    await flush();
    expect(finalizeCall()?.[0].data.status).toBe('completed');
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
  });
});

// ── RESUME AFTER A PROVIDER LIMIT (2026-09-29, transient-resume.ts) — TB 2.1
// v3e: a machine run the gateway's 47-min cooldown killed BEFORE it wrote a
// plan ended failed with nothing to resume it (build-cython-ext: zero model
// turns, scored 0).
describe('resume after a provider limit (transient-resume.ts)', () => {
  const machineClaim = (msg = '[AGENT-SENT MESSAGE] execute the task') =>
    makeClaim({ input: { message: msg, userId: 'u1', origin: 'agent' } });
  const providerKilled = () =>
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: '⚠︎ rate-limited: provider kept returning HTTP 429',
      parts: [{ type: 'text', text: 'rate-limited' }],
      modelErrored: true, modelErrorStatus: 429, modelErrorKind: 'transient' as const,
    }));
  const lastAssistant = () => {
    const calls = mockAppendCodingMessage.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.role === 'assistant');
    return calls[calls.length - 1]?.content ?? '';
  };
  beforeEach(() => { mockGetPlan.mockResolvedValue(null); });

  it('a transient provider kill with NO plan queues ONE throttled resume (r1/6 + the resume marker, resume:true)', async () => {
    providerKilled();
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
    const arg = mockQueueContinuationRun.mock.calls[0][0];
    expect(arg.prompt).toContain('[HARNESS CONTINUATION r1/6]');
    expect(arg.prompt).toContain('[RESUME AFTER PROVIDER LIMIT]');
    expect(arg.resume).toBe(true);
    expect(arg.delayMs).toBeGreaterThanOrEqual(180_000); // the provider-throttle delay, never the ~45 s fast lane
    expect(lastAssistant()).toContain('a resume run is queued');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transient_resume', meta: expect.objectContaining({ seam: 'backstop', round: 1, queued: true }) }));
  });
  it('ALARM-CAUSE-AWARE: the terminal run_failed of a provider-killed run whose resume is QUEUED carries {cause, resumeQueued, round} (a quiet row); no resume ⇒ today\'s `{ runId }`', async () => {
    providerKilled();
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r1/6] [RESUME AFTER PROVIDER LIMIT] carry on'));
    await new Promise((r) => setImmediate(r));
    const failedEmit = () => mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'run_failed');
    expect(failedEmit()?.[3]).toEqual({ runId: 'run1', cause: 'provider_transient', resumeQueued: true, round: 2 });
    // Resume rounds exhausted ⇒ nothing queued ⇒ an ordinary alarm-class run_failed (lane_failed stays material).
    mockEmitHookEventSafe.mockClear();
    providerKilled();
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r6/6] [RESUME AFTER PROVIDER LIMIT] carry on'));
    await new Promise((r) => setImmediate(r));
    expect(failedEmit()?.[3]).toEqual({ runId: 'run1' });
  });
  it('the round rides the incoming marker; past round 6 nothing is queued', async () => {
    providerKilled();
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r2/6] [RESUME AFTER PROVIDER LIMIT] carry on'));
    expect(mockQueueContinuationRun.mock.calls[0][0].prompt).toContain('[HARNESS CONTINUATION r3/6]');
    mockQueueContinuationRun.mockClear();
    providerKilled();
    await executeClaimedRun(machineClaim('[HARNESS CONTINUATION r6/6] [RESUME AFTER PROVIDER LIMIT] carry on'));
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(lastAssistant()).toContain('resume rounds are exhausted');
  });
  it('never for a clean finish, a size kill, a user-origin run, or a stopped run', async () => {
    await executeClaimedRun(machineClaim());
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: 'x', parts: [], modelErrored: true, modelErrorStatus: 400, modelErrorKind: 'size' as const }));
    await executeClaimedRun(machineClaim());
    providerKilled();
    await executeClaimedRun(makeClaim({ input: { message: 'please do it', userId: 'u1', origin: 'user' } }));
    mockRunCodingAgent.mockImplementationOnce(async () => {
      cancelRun('s1');
      return { finalText: 'x', parts: [], modelErrored: true, modelErrorStatus: 429, modelErrorKind: 'transient' as const };
    });
    await executeClaimedRun(machineClaim());
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
  });
  it('the claim-time zero-unfinished guard lets a RESUME through on a plan-less session', async () => {
    mockGetPlanStrict.mockResolvedValueOnce(null);
    await executeClaimedRun(machineClaim('[machine firing] [HARNESS CONTINUATION r1/6] [RESUME AFTER PROVIDER LIMIT] carry on'));
    expect(mockRunCodingAgent).toHaveBeenCalled();
    expect(finalizeCall()?.[0].data.status).not.toBe('cancelled');
  });
});

// ── A4 MACHINE-FIRING EFFORT STEP-DOWN (2026-10-04 coding quick wins —
// machine-firing-effort.ts): the executor judges SCHEDULE / HOOK firings only,
// reads the plan board with the [ALL-COMPLETE BOARD] predicate
// (schedule.service planBoardAllComplete — real here via requireActual) and
// hands the decision to the agent as AgentRunInput.machineFiringEffort.
describe('A4: machine-firing effort decision at claim time (2026-10-04)', () => {
  const ALL_DONE = { goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'a', status: 'completed' }, { id: 2, text: 'b', status: 'completed' }], version: 2, updatedAt: '2026-10-04T00:00:00.000Z' };
  const OPEN = { ...ALL_DONE, steps: [{ id: 1, text: 'a', status: 'completed' }, { id: 2, text: 'b', status: 'in_progress' }] };
  const BLOCKED = { ...ALL_DONE, steps: [{ id: 1, text: 'a', status: 'completed' }, { id: 2, text: 'b', status: 'blocked' }] };
  const agentInput = () => mockRunCodingAgent.mock.calls[mockRunCodingAgent.mock.calls.length - 1][0];
  afterEach(() => { delete process.env.MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED; });

  it('a schedule firing on an ALL-COMPLETE board ⇒ cap high (reason all_complete_board)', async () => {
    mockGetPlan.mockResolvedValue(ALL_DONE);
    await executeClaimedRun(makeClaim({ input: { message: 'tick', userId: 'u1', origin: 'schedule' } }));
    expect(agentInput().machineFiringEffort).toEqual({ cap: 'high', reason: 'all_complete_board' });
    expect(mockGetPlan).toHaveBeenCalledWith('s1');
  });

  it('a hook firing on an all-complete board is judged the same way', async () => {
    mockGetPlan.mockResolvedValue(ALL_DONE);
    await executeClaimedRun(makeClaim({ input: { message: 'child finished', userId: 'u1', origin: 'hook' } }));
    expect(agentInput().machineFiringEffort).toEqual({ cap: 'high', reason: 'all_complete_board' });
  });

  it.each([
    ['an open board', OPEN, { cap: null, reason: 'board_open' }],
    ['a BLOCKED board (a wait lane is never all-complete)', BLOCKED, { cap: null, reason: 'board_open' }],
    ['no plan', null, { cap: null, reason: 'no_plan' }],
  ])('a schedule firing with %s keeps max (recorded only)', async (_l, plan, expected) => {
    mockGetPlan.mockResolvedValue(plan);
    await executeClaimedRun(makeClaim({ input: { message: 'tick', userId: 'u1', origin: 'schedule' } }));
    expect(agentInput().machineFiringEffort).toEqual(expected);
  });

  it('a human turn, an agent send and an owner-dispatched run are never judged (no field)', async () => {
    mockGetPlan.mockResolvedValue(ALL_DONE);
    await executeClaimedRun(makeClaim({ input: { message: 'please fix it', userId: 'u1', origin: 'user', userTurnAt: new Date().toISOString() } }));
    expect(agentInput()).not.toHaveProperty('machineFiringEffort');
    await executeClaimedRun(makeClaim({ input: { message: 'peer request', userId: 'u1', origin: 'agent' } }));
    expect(agentInput()).not.toHaveProperty('machineFiringEffort');
    await executeClaimedRun(makeClaim({ input: { message: 'owner ask relayed', userId: 'u1', origin: 'agent', ownerDispatch: true, userTurnAt: new Date().toISOString() } as any }));
    expect(agentInput()).not.toHaveProperty('machineFiringEffort');
  });

  it('MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED=1: no decision, no plan read for it, no field (today)', async () => {
    process.env.MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED = '1';
    mockGetPlan.mockResolvedValue(ALL_DONE);
    await executeClaimedRun(makeClaim({ input: { message: 'tick', userId: 'u1', origin: 'schedule' } }));
    expect(agentInput()).not.toHaveProperty('machineFiringEffort');
  });
});

// ── audit 2026-10-06 T7 run-start / run-end seams ────────────────────────────
describe('T7 (audit 2026-10-06): first provision, new-work effort, todo promote, lane continuation', () => {
  const ALL_DONE = { goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'a', status: 'completed' }], version: 2, updatedAt: '2026-10-04T00:00:00.000Z' };
  const agentInput = () => mockRunCodingAgent.mock.calls[mockRunCodingAgent.mock.calls.length - 1][0];
  const flush = () => new Promise((r) => setImmediate(r));
  afterEach(() => {
    delete process.env.FIRST_PROVISION_NOTICE_FIX_DISABLED;
    delete process.env.MACHINE_FIRING_NEW_WORK_DISABLED;
    mockFiringStartsNewWork.mockResolvedValue({ newWork: false, todoIds: [] });
  });

  it('T7-2: a FIRST provision (worktreePath null) is not announced as a re-provision', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, worktreePath: null });
    await executeClaimedRun(makeClaim());
    expect(mockReattachWorktree).toHaveBeenCalled();
    expect(String(agentInput().schedulerNotice ?? '')).not.toContain('WORKSPACE RE-PROVISIONED');
  });

  it('T7-2: an existing-but-unusable worktree still gets the re-provision notice', async () => {
    mockIsUsableWorktree.mockResolvedValue(false);
    await executeClaimedRun(makeClaim());
    expect(String(agentInput().schedulerNotice ?? '')).toContain('WORKSPACE RE-PROVISIONED');
  });

  it('T7-2: FIRST_PROVISION_NOTICE_FIX_DISABLED=1 restores the notice on a first provision', async () => {
    process.env.FIRST_PROVISION_NOTICE_FIX_DISABLED = '1';
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, worktreePath: null });
    await executeClaimedRun(makeClaim());
    expect(String(agentInput().schedulerNotice ?? '')).toContain('WORKSPACE RE-PROVISIONED');
  });

  it('T7-1: a schedule firing that STARTS new work on an all-complete board keeps the seat effort (reason new_work)', async () => {
    mockGetPlan.mockResolvedValue(ALL_DONE);
    mockFiringStartsNewWork.mockResolvedValue({ newWork: true, todoIds: ['1744ef36'] });
    await executeClaimedRun(makeClaim({ input: { message: 'start todo 1744ef36 — build cql-agent', userId: 'u1', origin: 'schedule' } }));
    expect(mockFiringStartsNewWork).toHaveBeenCalledWith('s1', 'start todo 1744ef36 — build cql-agent');
    expect(agentInput().machineFiringEffort).toEqual({ cap: null, reason: 'new_work' });
  });

  it('T7-1: MACHINE_FIRING_NEW_WORK_DISABLED=1 restores the step-down (the todo read is skipped)', async () => {
    process.env.MACHINE_FIRING_NEW_WORK_DISABLED = '1';
    mockGetPlan.mockResolvedValue(ALL_DONE);
    mockFiringStartsNewWork.mockResolvedValue({ newWork: true, todoIds: ['1744ef36'] });
    await executeClaimedRun(makeClaim({ input: { message: 'start todo 1744ef36', userId: 'u1', origin: 'schedule' } }));
    expect(mockFiringStartsNewWork).not.toHaveBeenCalled();
    expect(agentInput().machineFiringEffort).toEqual({ cap: 'high', reason: 'all_complete_board' });
  });

  it('T7-9: a fresh run asks to promote its todos (machine flag from the trigger); a resume never does', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'start todo 57e0fe8d', userId: 'u1', origin: 'schedule' } }));
    expect(mockPromoteLaneTodos).toHaveBeenCalledWith({ chatId: 's1', userId: 'u1', runId: 'run1', prompt: 'start todo 57e0fe8d', machineTriggered: true });
    mockPromoteLaneTodos.mockClear();
    await executeClaimedRun(makeClaim({ preStatus: 'running', checkpoint: CP, inputConsumed: true }));
    expect(mockPromoteLaneTodos).not.toHaveBeenCalled();
  });

  it('T7-4: the hand-off gets the run\'s spend (context events) and a lazy plan-progress reader', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, title: 'New chat' });
    mockGetPlan.mockResolvedValue({ goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'a', status: 'completed' }, { id: 2, text: 'b', status: 'completed' }, { id: 3, text: 'c', status: 'blocked' }], version: 1, updatedAt: '2026-10-06T00:00:00.000Z' });
    mockRunCodingAgent.mockImplementation(async (inp: any) => {
      inp.emit('context', { chars: 10, budget: 100, compactions: 0, usage: { totalCostUsd: 2.35, turns: 4 } });
      return { finalText: 'done', parts: [{ type: 'text', text: 'done' }] };
    });
    await executeClaimedRun(makeClaim());
    const arg = mockRunDeliverableHandoffSafe.mock.calls[0][0];
    expect(arg).toMatchObject({ spendUsd: 2.35, sessionTitle: 'New chat' }); // the hand-off swaps the placeholder for the fresh chat title
    expect(await arg.loadSteps()).toEqual({ done: 2, total: 3 });
  });

  it('T7-4: HANDOFF_CARD_FACTS_DISABLED=1 passes the run-start title and no spend / steps (pre-fix)', async () => {
    process.env.HANDOFF_CARD_FACTS_DISABLED = '1';
    try {
      mockGetSessionForUser.mockResolvedValue({ ...SESSION, title: 'New chat' });
      await executeClaimedRun(makeClaim());
      const arg = mockRunDeliverableHandoffSafe.mock.calls[0][0];
      expect(arg.sessionTitle).toBe('New chat');
      expect(arg).not.toHaveProperty('spendUsd');
      expect(arg).not.toHaveProperty('loadSteps');
    } finally { delete process.env.HANDOFF_CARD_FACTS_DISABLED; }
  });

  it('T7-8: unpushed commits add ONE harness line to the final (and so to the run_completed hook summary)', async () => {
    const line = '⚠ HARNESS NOTE: 1 local commit on digby/x NOT pushed to origin (HEAD 07d91d2f) — nobody else can see it.';
    mockUnpushedAtRunEnd.mockResolvedValueOnce({ line, state: { count: 1, headSha: '07d91d2f', branch: 'digby/x', at: '' } });
    await executeClaimedRun(makeClaim());
    await flush(); await flush();
    // Ticket 6d7b379f: the executor passes the final text so a typed claims-block
    // declaration of the strand can suppress the re-nag.
    expect(mockUnpushedAtRunEnd).toHaveBeenCalledWith({ sessionId: 's1', worktree: '/tmp/wt', finalText: 'done' });
    const persisted = mockUpdateCodingMessage.mock.calls.map((c: any[]) => String(c[1]?.content ?? c[0]?.content ?? '')).join('\n') + mockAppendCodingMessage.mock.calls.map((c: any[]) => JSON.stringify(c)).join('\n');
    expect(persisted).toContain('NOT pushed to origin');
    const hook = mockEmitHookEventSafe.mock.calls.find((c: any[]) => c[1] === 'run_completed');
    expect(String(hook?.[2] ?? '')).toContain('NOT pushed to origin');
  });

  it('T7-11: a chat-engine-era assistant row reaches the coding run WITH its tool-call digest; coding-era rows are untouched', async () => {
    const T_CHAT = new Date('2026-10-05T18:55:00Z'); const T_CODING = new Date('2026-10-05T19:14:00Z');
    mockPrisma.chatCodingState = { findUnique: jest.fn(async () => ({ createdAt: new Date('2026-10-05T19:00:00Z') })) };
    try {
      // listRecentCodingTranscript returns NEWEST first.
      mockListRecentCodingTranscript.mockResolvedValueOnce([
        { id: 'u2', role: 'user', content: 'build it', parts: null, createdAt: T_CODING },
        { id: 'a2', role: 'assistant', content: 'coding answer', parts: [{ type: 'tool_call', name: 'read_file', args: { path: 'a' } }], createdAt: T_CODING },
        { id: 'a1', role: 'assistant', content: 'The build is underway.', parts: [{ type: 'tool_call', name: 'start_coding_session', args: { title: 'Build', goalId: '259a67ee' } }], createdAt: T_CHAT },
        { id: 'u1', role: 'user', content: 'build a control plane', parts: null, createdAt: T_CHAT },
      ]);
      await executeClaimedRun(makeClaim());
      const history = mockRunCodingAgent.mock.calls[0][0].history as Array<{ role: string; content: string }>;
      const chatEra = history.find((h) => h.content.startsWith('The build is underway.'));
      expect(chatEra?.content).toContain('start_coding_session {title: "Build", goalId: "259a67ee"}');
      const codingEra = history.find((h) => h.content.startsWith('coding answer'));
      expect(codingEra?.content).toBe('coding answer');
    } finally { delete mockPrisma.chatCodingState; }
  });

  it('T7-10: a COMPLETED run asks for the next lane todo; a failed run does not', async () => {
    await executeClaimedRun(makeClaim());
    await flush(); await flush();
    expect(mockMaybeStartNextLaneTodo).toHaveBeenCalledWith({ chatId: 's1', userId: 'u1', runId: 'run1' });
    mockMaybeStartNextLaneTodo.mockClear();
    mockRunCodingAgent.mockImplementation(async () => { throw new Error('model exploded'); });
    await executeClaimedRun(makeClaim());
    await flush(); await flush();
    expect(mockMaybeStartNextLaneTodo).not.toHaveBeenCalled();
  });

  it('W5-4 (audit 2026-10-08): a completed run first closes the plan-complete todo; a closing wake skips the next-todo continuation', async () => {
    mockCloseLaneTodosOnPlanComplete.mockResolvedValueOnce('wake_sent');
    await executeClaimedRun(makeClaim());
    for (let i = 0; i < 4; i++) await flush();
    expect(mockCloseLaneTodosOnPlanComplete).toHaveBeenCalledWith(expect.objectContaining({ chatId: 's1', userId: 'u1', runId: 'run1' }));
    expect(mockMaybeStartNextLaneTodo).not.toHaveBeenCalled();
    mockCloseLaneTodosOnPlanComplete.mockResolvedValueOnce('closed' as any); // legacy outcome (pre-260dd714): any non-wake_sent still continues
    await executeClaimedRun(makeClaim());
    for (let i = 0; i < 4; i++) await flush();
    expect(mockMaybeStartNextLaneTodo).toHaveBeenCalledTimes(1);
  });
});
