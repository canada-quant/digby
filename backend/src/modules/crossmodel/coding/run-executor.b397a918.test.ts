/**
 * REPLAY TEST — ticket b397a918 (mishap, fleet-integrity, 2026-10-20):
 * "Evidence guard: machine run asserted unproven completions (session 5f90c628)".
 *
 * THE MISHAP BEING REPLAYED: the evidence guard struck a run in a coding
 * session that had been woken by ANOTHER AGENT'S message (a supervisor's
 * defect report) — zero tool receipts, yet the final asserted commit_pushed,
 * cited three commit shas and a feedback-ticket id that did not exist, and
 * restated prompt-carried status as fresh observations. The guard contained
 * it pre-delivery (containedPreDelivery: true) — detection worked.
 *
 * ROOT CAUSE (why the model fabricated on THAT trigger but not on its own
 * scheduled firings, which produced disciplined receipt-cited claims blocks):
 * the CLAIM BAR rides the queued user row for schedule/hook firings
 * (machineFiringHeader, fbe65673) and rides the brief for ticket dispatches —
 * but an agent-sent message into an idle coding session queues BARE: only the
 * one-line [AGENT-SENT MESSAGE] provenance header, no claim discipline at all.
 * The run is still classified triggerKind 'machine' (origin 'agent'), so the
 * zero-tool gate and the journal-backed guard both apply — the model was held
 * to a bar it was never shown on this surface.
 *
 * THE FIX, pinned here:
 *   1. The bar text is ONE shared const (MACHINE_CLAIM_BAR_TEXT,
 *      chat-agent/machine-wake.ts) — the firing header composes from it, so
 *      the two surfaces cannot drift.
 *   2. The executor injects it into the AGENT INPUT (system-context channel,
 *      exactly like schedulerNotice — never the persisted user row, the
 *      cap-skip banner rule) for triggerKind === 'machine' (origin
 *      'agent'/'webhook' without an owner-dispatch anchor).
 *   3. agent.ts renders it as a [MACHINE RUN EVIDENCE RULE] system block and
 *      strips it from worker delegations (evidence discipline is the parent's
 *      concern).
 *
 * NOTE: this is deliberately NOT the 680dd00a no-op shape (three generic
 * "cite your tool ids" re-steers, three recurrences): the flagged session's
 * SCHEDULE prompt was never in the struck run's context — the run was
 * message-triggered — so re-editing a prompt could not fix it. The fix
 * targets the uncovered trigger class at the harness seam instead.
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
  codingMessage: {
    create: jest.fn(async () => ({ id: 'msg-new' })),
    update: jest.fn(async () => ({})),
    count: jest.fn(async () => 1), // never the opening turn unless a case overrides
    findMany: jest.fn(async () => []),
  },
  crossModelChat: { findUnique: jest.fn(async () => ({ userId: 'u1' })) },
  agentRun: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })), count: jest.fn(async () => 0) },
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
  // MERGE-1 step 9 (2026-11-04): the `transcriptDualWriteEnabled` mock key was removed
  // with the seam. run-executor now stamps ANSWER_MSG_ID unconditionally, because a
  // crossmodel_messages row always exists for a persisted final message.
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

import { executeClaimedRun } from './run-executor';
import type { ClaimedRun } from './run-claim';

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

const { MACHINE_CLAIM_BAR_TEXT, machineFiringHeader } = require('../chat-agent/machine-wake');


// Gate-flip env keys (see run-executor.test.ts): unset in every case here —
// the guard's reject-back lanes stay observe-only (the production default).
const FLIP_ENV_KEYS = ['EVIDENCE_GUARD_ENFORCE', 'QUOTE_GUARD_ENFORCE', 'RUN_DEADLINE_ENABLED'] as const;
afterAll(() => {
  for (const k of FLIP_ENV_KEYS) delete process.env[k];
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRoleModelForRun.mockReset();
  mockResolveRoleModelForRun.mockResolvedValue('kimi');
  delete process.env.SEAT_GOVERNS_SESSIONS_DISABLED;
  for (const k of FLIP_ENV_KEYS) delete process.env[k];
  mockStore.clear();
  mockLists.clear();
  mockGetSessionForUser.mockResolvedValue(SESSION);
  SESSION.worktreePath = '/tmp/wt';
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
  mockGetPlan.mockResolvedValue(null);
  mockQueueContinuationRun.mockResolvedValue({ ok: true, runId: 'cont-1' });
  mockHasQueuedContinuationRun.mockResolvedValue(false);
  mockCreateScheduleFallback.mockResolvedValue({ ok: true, schedule: { intervalSec: 900 } });
  mockSearchMemory.mockResolvedValue([]);
  mockBuildOwnerDirectives.mockResolvedValue({ block: '', shown: [], hidden: 0 });
});

describe('b397a918 — the claim bar rides agent/webhook machine runs too (system-context channel)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPlanStrict.mockRejectedValue(new Error('store-less suite'));
  });

  it('REPLAY: an agent-sent wake (origin "agent", the struck run\'s shape) gets the claim bar in the agent input', async () => {
    await executeClaimedRun(makeClaim({
      input: {
        message: '[AGENT-SENT MESSAGE — from another Digby agent chat]\n\nA defect report arrived for your lane.',
        userId: 'u1',
        // The struck run\'s exact classification: an agent send still carries
        // the userTurnAt anchor, but origin WINS → triggerKind machine.
        userTurnAt: new Date().toISOString(),
        origin: 'agent', originSourceChatId: 'fleet-supervisor-chat',
      },
    }));

    const input = mockRunCodingAgent.mock.calls[0][0];
    // THE FIX: the bar is present in the system-context channel…
    expect(input.machineClaimBar).toBe(MACHINE_CLAIM_BAR_TEXT);
    expect(String(input.machineClaimBar)).toContain('CLAIM BAR (the journal-backed evidence guard watches this run)');
    expect(String(input.machineClaimBar)).toContain('fenced claims block');
    // …and the persisted user row stays the PLAIN agent message (the cap-skip
    // banner rule: ops banners never ride message content).
    const userRow = mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'user');
    expect(userRow).toBeTruthy();
    expect(String(userRow[0].content)).not.toContain('CLAIM BAR');
    expect(String(userRow[0].content)).toContain('A defect report arrived');
    expect(input.userMessage).toContain('A defect report arrived');
  });

  it('a webhook-origin run (the other bare machine class) gets the bar too', async () => {
    await executeClaimedRun(makeClaim({
      input: { message: 'CI finished; the deploy is green', userId: 'u1', origin: 'webhook' },
    }));
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.machineClaimBar).toBe(MACHINE_CLAIM_BAR_TEXT);
  });

  it('review finding 1 (PR #1848): a dispatched brief that ALREADY embeds a claim bar gets NO second copy — every machine run sees exactly ONE bar', async () => {
    // A ticket-dispatch lane's first run: origin 'agent', and the brief itself
    // carries a CLAIM BAR (ticket-dispatch.service TICKET_INSTRUCTIONS). Two
    // divergently-worded bars in one run would blur which contract binds —
    // the executor must not stack its own beside a brief-embedded one.
    await executeClaimedRun(makeClaim({
      input: {
        message: '[AGENT-SENT MESSAGE — from another Digby agent chat (id unknown), another Digby agent, NOT the owner.]\n\nCLAIM BAR (the journal-backed evidence guard watches this run — its verdict reads run_journal_entries, not your answer text): every completion claim in your final answer must cite the concrete tool-result artifact observed THIS run.\n\nWork the ticket.',
        userId: 'u1',
        userTurnAt: new Date().toISOString(),
        origin: 'agent', originSourceChatId: 'dispatcher-chat',
      },
    }));
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.machineClaimBar).toBeUndefined();
    expect(String(input.userMessage)).toContain('CLAIM BAR'); // the brief's own bar still rides the message
  });

  it('a user-typed run NEVER gets the bar (origin user / userTurnAt heuristic)', async () => {
    await executeClaimedRun(makeClaim({
      input: { message: 'typed by a human', userId: 'u1', userTurnAt: new Date().toISOString() },
    }));
    expect(mockRunCodingAgent.mock.calls[0][0].machineClaimBar).toBeUndefined();
  });

  it('an owner-dispatch agent send (origin agent + anchor + flag) is USER-classified — no bar', async () => {
    await executeClaimedRun(makeClaim({
      input: {
        message: 'relaying the owner\'s ask', userId: 'u1',
        userTurnAt: new Date().toISOString(),
        origin: 'agent', ownerDispatch: true,
      },
    }));
    expect(mockRunCodingAgent.mock.calls[0][0].machineClaimBar).toBeUndefined();
  });

  it('schedule firings keep their QUEUE-TIME bar in the message — the executor adds no second copy (no drift, no double)', async () => {
    // A schedule firing\'s queued row already carries machineFiringHeader
    // (provenance + bar). The executor must not ALSO inject machineClaimBar:
    // one bar per run, and the in-message one rides every history render.
    await executeClaimedRun(makeClaim({
      input: { message: machineFiringHeader('schedule') + '[FRAMEWORK OPERATOR — 4-hour run] Read docs/FRAMEWORK_OPERATOR.md', userId: 'u1', origin: 'schedule' },
    }));
    const input = mockRunCodingAgent.mock.calls[0][0];
    expect(input.machineClaimBar).toBeUndefined();
    expect(String(input.userMessage)).toContain('CLAIM BAR (the journal-backed evidence guard watches this run)');
  });

  it('the bar text is ONE shared const — the firing header composes from it, so surfaces cannot drift', () => {
    const header = machineFiringHeader('schedule');
    // The firing header embeds the SAME bar text the executor injects.
    expect(header).toContain(MACHINE_CLAIM_BAR_TEXT);
    // And it is the guard-facing discipline, not a summary.
    expect(MACHINE_CLAIM_BAR_TEXT).toContain('no artifact = no claim');
  });
});
