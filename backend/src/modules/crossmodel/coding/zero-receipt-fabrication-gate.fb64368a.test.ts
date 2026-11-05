/**
 * MISHAP REPLAY (ticket fb64368a) — zero-tool coding run published fabricated
 * PR/merge/push claims; pre-delivery claims-fence validation was missing.
 *
 * THE INCIDENT (2026-10-15, chat 5f90c628 — the Framework Operator lane):
 * two machine runs ~5h apart executed ZERO tools (empty run-receipts list)
 * yet their finals claimed merged PRs, pushes, shas and message receipts:
 *   • f138 (run dabfaca6): "PR #1506 → b50a154f / c7d2f91c / receipt 7a1f9d02"
 *   • f140-followup (run 261e3aa5, 11:05–11:07Z): "PR #1508 merged gate-green
 *     with squash b66fe3f58036, push c625e879 on fo/state-f140-ruling, FS-ack
 *     receipt 7f5781a5" — all false (newest PR was #1507, no branch existed,
 *     no such sha). The Fleet Supervisor relayed the phantom squash as fact
 *     ~50 min later because the delivered message id existed.
 *
 * The evidence guard DETECTED both pre-persist (guard_strike rows, kinds incl.
 * unverified_block_claim + fabricated_pr, outcome 'observed') but the
 * 2026-09-11 "full steam" gate flip left containment observe-only, and the
 * annotate-lane notes are guard chrome — redactGuardChrome strips them on the
 * agent-facing read path — so downstream agents read the phantom claims as
 * bare fact.
 *
 * THE FIX (this ticket): the ZERO-RECEIPT FABRICATION GATE in run-executor.ts —
 * a machine run whose receipt union is EMPTY and whose composed verdict still
 * carries an externally-refuted conviction (GitHub 404 / DB-miss / forged
 * chrome) or an unambiguous typed-fence fabrication (a 'merge' entry —
 * this-run-only by contract — or a full-uuid ref matching no receipt in run ∪
 * carried pool) is contained PRE-DELIVERY via the full-final REPLACE lane,
 * INDEPENDENT of EVIDENCE_GUARD_ENFORCE. Kill switch ZERO_RECEIPT_GUARD_DISABLED=1.
 *
 * This file replays BOTH incident shapes against the REAL executor (guard
 * networked entry mocked to the incident's real verdict classes, everything
 * else real) and pins the containment + the disjointness guarantees:
 *   • a receipted run (honest work, wrong receipt shape) keeps the 2026-09-11
 *     observe-only posture byte-for-byte;
 *   • a zero-receipt run whose ONLY findings are the note-only classes
 *     (unprovenKinds prose / futureDated / non-uuid fence misses) is NOT
 *     contained — an honest zero-tool relay of injected context survives.
 *
 * Mock skeleton mirrors run-executor.test.ts (same seams; see that file's
 * header). The claims-block lane runs REAL (jest.requireActual) — the fence
 * adjudication, including the carried-pool re-adjudication, is the surface
 * under test.
 */
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


// Imports mirror run-executor.test.ts (the skeleton above is transplanted verbatim).
import { executeClaimedRun } from './run-executor';
import type { ClaimedRun } from './run-claim';

const SESSION: any = {
  id: 's1', projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/x', baseBranch: 'main',
  worktreePath: '/tmp/wt', permissionMode: 'auto', model: 'kimi', status: 'running',
  errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  project: {
    id: 'p1', userId: 'u1', name: 'proj', repoUrl: 'https://github.com/o/r', defaultBranch: 'main',
    provider: 'github', githubLabel: null, folderId: null, createdAt: new Date(), updatedAt: new Date(),
  },
};

const makeClaim = (over: Partial<ClaimedRun> = {}): ClaimedRun => ({
  id: 'run1',
  sessionId: 's1',
  preStatus: 'queued',
  checkpoint: null,
  input: { message: 'machine wake', userId: 'u1' },
  attempts: 1,
  inputConsumed: false,
  lastError: null,
  ...over,
} as ClaimedRun);

const assistantRow = () => mockAppendCodingMessage.mock.calls.find((c: any[]) => c[0]?.role === 'assistant')?.[0];

const flushAsync = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

const ZERO_GATE_ENV_KEYS = ['EVIDENCE_GUARD_ENFORCE', 'ZERO_RECEIPT_GUARD_DISABLED', 'QUOTE_GUARD_ENFORCE'] as const;
const SAVED_ZERO_GATE_ENV: Record<string, string | undefined> = Object.fromEntries(ZERO_GATE_ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ZERO_GATE_ENV_KEYS) {
    if (SAVED_ZERO_GATE_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ZERO_GATE_ENV[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ZERO_GATE_ENV_KEYS) delete process.env[k];
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
  mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'done', parts: [{ type: 'text', text: 'done' }] }));
  mockApplyCompletionClaimGuard.mockImplementation(async (opts: any) => ({
    finalText: opts.finalText, notes: [],
    verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
  }));
  mockGetRunReceipts.mockResolvedValue([]);
  mockStageAndDescribe.mockResolvedValue({ staged: [], note: '' });
  mockStageFilesAndDescribe.mockResolvedValue({ staged: [], note: '' });
  mockGetPlan.mockResolvedValue(null);
  mockQueueContinuationRun.mockResolvedValue({ ok: true, runId: 'cont-1' });
  mockHasQueuedContinuationRun.mockResolvedValue(false);
  mockCreateScheduleFallback.mockResolvedValue({ ok: true, schedule: { intervalSec: 900 } });
  mockSearchMemory.mockResolvedValue([]);
});

describe('MISHAP REPLAY fb64368a — zero-receipt fabrication gate (run-executor)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EVIDENCE_GUARD_ENFORCE;
    delete process.env.ZERO_RECEIPT_GUARD_DISABLED;
    delete process.env.QUOTE_GUARD_ENFORCE;
    mockApplyCompletionClaimGuard.mockImplementation(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
  });

  // ── INCIDENT 2 (f140-followup) — the full shape ─────────���─────────────────
  it('a ZERO-RECEIPT machine run claiming a merged PR (GitHub 404) is CONTAINED pre-delivery even with EVIDENCE_GUARD_ENFORCE unset — full REPLACE, ticket, zeroReceipt telemetry', async () => {
    // The incident's final shape: fabricated PR merge + push + squash sha.
    const FABRICATED = 'FS ruling banked and merged gate-green (PR #1508) with squash b66fe3f58036; push c625e879 on fo/state-f140-ruling ancestry-verified.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: FABRICATED, parts: [{ type: 'text', text: FABRICATED }],
      // ZERO receipts — the incident's structural signature.
    }));
    // The guard's real verdict classes for the incident (guard_strike row
    // 2026-10-15 11:07:13Z, run 261e3aa5): unproven pr_merged + fabricated_pr.
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [1508], refutedMergePrs: [], futureDated: [] },
    }));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // CONTAINED pre-delivery: the persisted content leads with the REPLACE
    // banner; the fabrication survives ONLY inside the quoted audit section.
    const row = assistantRow();
    const content: string = row.content;
    expect(content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(content).toContain('NOT DONE');
    expect(content).toContain(`> ${FABRICATED}`);
    // Nothing confabulated above the audit quote.
    const begin = content.indexOf('--- BEGIN UNVERIFIED RUN OUTPUT');
    expect(begin).toBeGreaterThan(-1);
    expect(content.slice(0, begin)).not.toContain('b66fe3f58036');
    // The guard_strike row marks the zero-receipt class + outcome enforced.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ outcome: 'enforced', zeroReceipt: true }),
    }));
    // The integrity ticket fires for the class (containedPreDelivery true).
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({
      area: 'fleet-integrity', type: 'mishap',
      context: expect.objectContaining({ containedPreDelivery: true }),
    }));
  });

  // ── INCIDENT 2, typed-fence leg — the ```claims shape the model emitted ────
  it('a ZERO-RECEIPT machine run with a typed claims fence (merge entry + uuid ref) is CONTAINED — the fence adjudicates against run ∪ carried and still convicts', async () => {
    const FENCE = [
      '```claims',
      JSON.stringify([
        { type: 'merge', ref: 'b66fe3f58036' },
        { type: 'message_sent', ref: '7f5781a5-1111-2222-3333-444455556666' },
      ]),
      '```',
    ].join('\n');
    const FABRICATED = `FS-ack delivered — state file updated.\n\n${FENCE}`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: FABRICATED, parts: [{ type: 'text', text: FABRICATED }],
      // ZERO receipts.
    }));
    // Prose guard clean (no mined claims in the text) — the FENCE is the only
    // signal, exactly the incident: the guard's strike kinds were
    // unverified_block_claim + fabricated_pr.
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    // The carried pool is EMPTY in this scenario (getRecentChatReceipts mocked
    // to [] at the service boundary) — no earlier run's receipts to exonerate.

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // The real claims-block lane ran: a merge entry (this-run-only by
    // contract) and a uuid ref matching no receipt both convict → contained.
    const row = assistantRow();
    expect(row.content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ outcome: 'enforced', zeroReceipt: true }),
    }));
    expect(mockFileFeedbackTicket).toHaveBeenCalled();
  });

  // ── DISJOINTNESS 1 — the owner's protected class is untouched ─────────────
  it('a RECEIPTED machine run (honest work, wrong receipt shape) keeps the 2026-09-11 observe-only posture byte-for-byte — unverifiedBlockClaims stays note-only even under EVIDENCE_GUARD_ENFORCE=1', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    const ORIGINAL = 'Sweep complete — receipts attached below.';
    const RID = 'rrrr8888-9999-aaaa-bbbb-ccccddddeeee';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: ORIGINAL, parts: [{ type: 'text', text: ORIGINAL }],
      receipts: [{ id: RID, chatId: 's1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], unverifiedBlockClaims: ['probe — no matching receipt'] },
    }));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // Delivered verbatim (annotate-only) — the zero-receipt gate did not fire.
    const row = assistantRow();
    expect(row.content.startsWith(ORIGINAL)).toBe(true);
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    // No zero-receipt marker on telemetry.
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
    // Under enforce=1 a receipted run's note-only class stays note-only for
    // DELIVERY (the original above) — but the observe-only finding still
    // FILES its integrity ticket with containedPreDelivery:false (the (x)
    // gate-flip pin, unchanged by fb64368a).
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({
      area: 'fleet-integrity', type: 'mishap',
      context: expect.objectContaining({ containedPreDelivery: false }),
    }));
  });

  // ── DISJOINTNESS 2 — the honest zero-tool relay ───────────────────────────
  it('a ZERO-RECEIPT machine run whose ONLY findings are note-only classes (prose unprovenKinds, non-uuid fence miss) is NOT contained — an honest relay of injected context survives', async () => {
    const RELAY = 'FS ruling received and banked — no code change this turn; telemetry shows deploy wave success (per the injected fleet state).';
    const FENCE = ['```claims', JSON.stringify([{ type: 'deploy', ref: 'wave 38696575945' }]), '```'].join('\n');
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: `${RELAY}\n\n${FENCE}`, parts: [{ type: 'text', text: RELAY }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      // unprovenKinds prose (probe) — the note-only zero-evidence class.
      verdict: { unprovenKinds: ['probe'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // Delivered verbatim — the zero-receipt gate counted NO externally-
    // refuted class and NO this-run-only fence type (a 'deploy' ref is
    // non-uuid, so it lands unverifiable/advisory, not a conviction).
    const row = assistantRow();
    expect(row.content.startsWith(RELAY)).toBe(true);
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  // ── KILL SWITCH ─────────────────────────────────────────────────────────────
  it('ZERO_RECEIPT_GUARD_DISABLED=1 restores observe-only for the zero-receipt class — the original delivers, telemetry stays observed', async () => {
    process.env.ZERO_RECEIPT_GUARD_DISABLED = '1';
    const FABRICATED = 'Merged PR #1508 with squash b66fe3f58036.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: FABRICATED, parts: [{ type: 'text', text: FABRICATED }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [1508], refutedMergePrs: [], futureDated: [] },
    }));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    const row = assistantRow();
    expect(row.content.startsWith(FABRICATED)).toBe(true);
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ outcome: 'observed' }),
    }));
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  // ── CARRIED-POOL EXONERATION — the honest restatement ─────────────────────
  it('a ZERO-RECEIPT relay run quoting a REAL receipt id from an earlier run of this chat (carried pool) is NOT contained — the uuid ref is exonerated by re-adjudication', async () => {
    const CARRIED_ID = '7f5781a5-aaaa-bbbb-cccc-ddddeeeeffff';
    const FENCE = ['```claims', JSON.stringify([{ type: 'message_sent', ref: CARRIED_ID }]), '```'].join('\n');
    const RELAY = `Acked to FS earlier this cycle — receipt ${CARRIED_ID} (per the prior firing's record).\n\n${FENCE}`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: RELAY, parts: [{ type: 'text', text: RELAY }],
      // ZERO this-run receipts.
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    // The carried pool returns the REAL earlier-run receipt carrying that id.
    mockGetRecentChatReceipts.mockResolvedValueOnce([
      { id: CARRIED_ID, chatId: 's1', runId: 'run0', tool: 'send_chat_message', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() },
    ]);

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // The uuid ref was re-adjudicated against run ∪ carried and verified —
    // no fence conviction, no containment. (The real claims-block lane
    // verifies a message_sent entry via the receipt id.)
    const row = assistantRow();
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
  });

  // ── fb64368a REVIEW ROUND 1 — carried-aware prose citations + read-failure fail-open ──
  it('a ZERO-RECEIPT run whose carried-pool FETCH FAILS (DB hiccup) is not contained on a uuid fence survivor — the pool is unconfirmed, the citation may be an honest earlier-run id (review aggravator 4)', async () => {
    const CITED = '7f5781a5-aaaa-bbbb-cccc-ddddeeeeffff';
    const FENCE = ['```claims', JSON.stringify([{ type: 'message_sent', ref: CITED }]), '```'].join('\n');
    const RELAY = `Prior ack stands — receipt ${CITED} (per the earlier firing's record).\n\n${FENCE}`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: RELAY, parts: [{ type: 'text', text: RELAY }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    // The carried fetch REJECTS — an UNCONFIRMED pool, not an empty one. The
    // uuid fence survivor would convict on a confirmed-empty pool; a failed
    // read must fail OPEN (the posture of every external resolver here).
    mockGetRecentChatReceipts.mockRejectedValueOnce(new Error('db hiccup'));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    const row = assistantRow();
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
  });

  it('a FAILED prior-attempts receipt read (DB hiccup) leaves the run receipt-UNCONFIRMED — the gate cannot treat it as zero-receipt, so the observe-only posture holds even for a fabricated-PR verdict', async () => {
    const FABRICATED = 'Merged PR #1508 with squash b66fe3f58036.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: FABRICATED, parts: [{ type: 'text', text: FABRICATED }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [1508], refutedMergePrs: [], futureDated: [] },
    }));
    mockGetRunReceipts.mockRejectedValueOnce(new Error('db hiccup'));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // Delivered verbatim (observe-only): "the receipts read failed" is
    // indistinguishable from "the run had receipts" — the strong containment
    // action stays reserved for a CONFIRMED empty receipt union. The finding
    // is still observed in telemetry (no zeroReceipt marker).
    const row = assistantRow();
    expect(row.content.startsWith(FABRICATED)).toBe(true);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
  });

  it('a fence merge entry whose ref is a FULL UUID is counted ONCE and adjudicated like every uuid ref — a real carried merge receipt vouches it, so no double conviction (review finding 4)', async () => {
    const CARRIED_MERGE_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
    const FENCE = ['```claims', JSON.stringify([{ type: 'merge', ref: CARRIED_MERGE_ID }]), '```'].join('\n');
    const RELAY = `The prior merge stands — receipt ${CARRIED_MERGE_ID} (per the earlier firing's record).\n\n${FENCE}`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: RELAY, parts: [{ type: 'text', text: RELAY }] }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
    mockGetRecentChatReceipts.mockResolvedValueOnce([
      { id: CARRIED_MERGE_ID, chatId: 's1', runId: 'run0', tool: 'merge_pull_request', ok: true, ids: { prNumber: 1508, mergeSha: 'b66fe3f58036' }, inputHash: null, outputHash: null, createdAt: new Date() },
    ]);

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // Pre-fix this entry was counted TWICE (mergeFabrications counted every
    // merge entry unconditionally, forgedRefs counted the uuid shape) and the
    // merge leg could never be exonerated. Now it rides the uuid leg alone:
    // the carried merge receipt vouches it → no conviction → not contained.
    const row = assistantRow();
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
  });

  // ── fb64368a REVIEW ROUND 3 (minor 2 rider) — the THIRD fail-open leg: the
  // prose-citation conviction (:2199) is suppressed when the carried read
  // failed and the verdict carries forged citation ids. In prod the guard
  // (handed the failed fetch's empty pool) convicts the id as forged — the
  // executor must not CONTAIN on an unread pool: the cited id may be an
  // honest earlier-run id the executor simply failed to read.
  it('a PROSE forged-citation verdict (forgedFooter + forgedCitationIds) whose carried read FAILED is not contained — the executor fails open on an unread pool (round-3 minor 2)', async () => {
    const CITED = '7f5781a5-aaaa-bbbb-cccc-ddddeeeeffff';
    const RELAY = `Acked to FS earlier this cycle — receipt ${CITED} (per the prior firing's record). No new work this tick.`;
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: RELAY, parts: [{ type: 'text', text: RELAY }] }));
    // The guard convicts the citation (it saw an empty carried pool — the
    // fetch failed before the guard ran) — exactly the prod shape.
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], forgedFooter: true, forgedCitationIds: [CITED] },
    }));
    mockGetRecentChatReceipts.mockRejectedValueOnce(new Error('db hiccup'));

    await executeClaimedRun(makeClaim());
    await flushAsync();

    // forgedProseCitation suppressed (ids present, carried read unconfirmed)
    // → no conviction class → the honest relay delivers.
    const row = assistantRow();
    expect(row.content.startsWith(RELAY)).toBe(true);
    expect(row.content).not.toContain("FINAL ANSWER WAS REPLACED");
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ zeroReceipt: true }),
    }));
  });
});

// ── DETECTOR-RECALL REPLAY (ticket fb64368a detector change) ────────────────
// The fb64368a fix changes a framework detector lane (coding/run-evidence-guard's
// executor-side containment gate — a new evidence gate). Per the detector-change
// rule, this suite replays the detector's PRIOR true positives and asserts they
// STILL FIRE. The prior true positives here are the guard's pre-existing
// convicting lanes, replayed at their own seams:
//   • the observe-only DEFAULT posture (strike row outcome observed, original
//     delivered) for a RECEIPTED run — run-executor.test.ts 'DEFAULT' pin;
//   • the EVIDENCE_GUARD_ENFORCE=1 REPLACE lane for a receipted run — the
//     be199e93 pin;
//   • the unverifiedBlockClaims note-only pin for a receipted run — the
//     2026-09-11 gate-flip pin;
//   • the guard-miss lane for a clean machine final.
// Those replays live in run-executor.test.ts (updated this PR to carry
// receipts so they pin their original intents); the three below are the
// recall cases that must fire through THIS suite's real-lane wiring too.
describe('DETECTOR-RECALL REPLAY — prior true positives still fire (fb64368a detector change)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EVIDENCE_GUARD_ENFORCE;
    delete process.env.ZERO_RECEIPT_GUARD_DISABLED;
    mockApplyCompletionClaimGuard.mockImplementation(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
    }));
  });

  it('RECALL 1 — a clean machine final (no findings) still records guard_miss, not a strike: the detector never fires on an honest final', async () => {
    const HONEST = 'Sweep complete — 3 spike rows reviewed, all baseline-pair tripwires; no action needed.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({ finalText: HONEST, parts: [{ type: 'text', text: HONEST }] }));
    await executeClaimedRun(makeClaim());
    await flushAsync();
    const row = assistantRow();
    expect(row.content.startsWith(HONEST)).toBe(true);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'guard_strike' }));
  });

  it('RECALL 2 — a fabricated-PR conviction on a RECEIPTED run still fires the strike row with outcome observed under DEFAULT (the pre-fb64368a behavior is unchanged for receipted runs)', async () => {
    const PHANTOM = 'Plan 6/6 — CLOSED. PR #224 squash-merged, sha 84fe3ae0.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: PHANTOM, parts: [{ type: 'text', text: PHANTOM }],
      receipts: [{ id: 'rrrr2222-3333-4444-5555-666677778888', chatId: 's1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [] },
    }));
    await executeClaimedRun(makeClaim());
    await flushAsync();
    // The strike still fires (observed) and — receipted run — the original
    // still delivers under DEFAULT: the fb64368a gate changed NOTHING for
    // the receipted class.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ kinds: ['unproven_completion', 'fabricated_pr'], outcome: 'observed' }),
    }));
    const row = assistantRow();
    expect(row.content.startsWith(PHANTOM)).toBe(true);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('RECALL 3 — EVIDENCE_GUARD_ENFORCE=1 still contains a receipted run with hard findings (the be199e93 REPLACE lane, unchanged by fb64368a)', async () => {
    process.env.EVIDENCE_GUARD_ENFORCE = '1';
    const PHANTOM = 'Merged PR #224, sha 84fe3ae0.';
    mockRunCodingAgent.mockImplementationOnce(async () => ({
      finalText: PHANTOM, parts: [{ type: 'text', text: PHANTOM }],
      receipts: [{ id: 'rrrr3333-4444-5555-6666-777788889999', chatId: 's1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() }],
    }));
    mockApplyCompletionClaimGuard.mockImplementationOnce(async (opts: any) => ({
      finalText: opts.finalText, notes: [],
      verdict: { unprovenKinds: ['pr_merged'], fabricatedPrs: [224], refutedMergePrs: [], futureDated: [] },
    }));
    await executeClaimedRun(makeClaim());
    await flushAsync();
    const row = assistantRow();
    expect(row.content.startsWith("[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]")).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ area: 'fleet-integrity', type: 'mishap' }));
  });
});
