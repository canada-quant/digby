/**
 * chat-agent.service × COMPUTE POLICY (branch cp/harness, 2026-09-26 —
 * docs/DEPTH_UX_SOTA_2026-09-26.md §4/§5). The mock preamble is the same as
 * chat-agent.service.test.ts (the import graph of the service is what it is);
 * the suites at the bottom pin:
 *   - answer-first: the injector waits 0 by default, ≤ STAKES_WAIT_MS on the
 *     stakes path, and today's 300 s gate under ANSWER_FIRST_DISABLED=1;
 *   - the checker spawns by PLAN, not by mode==='thinking';
 *   - the late reconcile is armed unconditionally for chatId rows;
 *   - drafts_agree: ACT + agree skips the reconcile ("Checked ✓"), SHADOW runs
 *     it into the row and labels from the revision verdict;
 *   - check_state events + metadata.check / metadata.depth / metadata.ux;
 *   - the Dig-deeper chip (escalate / signin_deeper / none on machine runs);
 *   - an escalation run: no user row, "Deeper findings" row, original stamped,
 *     notify_user on the research rung;
 *   - the compute_policy + ux_ttft telemetry rows.
 *
 * TIMERS (audit tests-gaps-9, 2026-09-26): this suite runs REAL timers (runTurn
 * polls with setTimeout; the service's timers carry .unref(), so fake timers
 * would need advanceTimersByTimeAsync plumbing through every turn). The two
 * production waits the finalize races against are shrunk at the module
 * boundary instead — CROSS_CHECK_LATE_WAIT_MS 10 s → 50 ms (the DEFAULT
 * injector test paid the full 10 s grace on every run: 72% of the suite) and
 * computePolicyTimeoutMs() 1 200 ms → 50 ms (its env override clamps at
 * ≥ 300 ms, so the env route alone cannot get there). Both are read at CALL
 * time by chat-agent.service.ts (the ts-jest CJS transform reads the exported
 * binding on each use), so the partial mocks below take effect; the pin test
 * at the top of the first describe fails loudly if either ever becomes a
 * boot-time copy. "Did it block" is asserted by ORDER (raceInjector / a
 * pending flag), never by elapsed milliseconds — jest.config.js documents the
 * starvation class (a 23 ms test → 14 s on the shared coding box) that a
 * wall-clock assert trips.
 */

// Test-sized timers (see the TIMERS note above). `mock`-prefixed so the hoisted
// jest.mock factories may reference them; the factories run lazily on first
// require, after these are initialised.
const mockComputePlanTimeoutMs = 50;
const mockCrossCheckLateWaitMs = 50;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    // Titling windows (audit p10): humanTurnCount = total − machine-origin rows
    // − the just-persisted current row. The where.OR shape is the machine-origin
    // count; a bare where is the total. Default: 1 prior human message + the
    // current row, nothing machine (parity with the 1-message ctx mocks below).
    count: jest.fn(async ({ where }: any) => (where?.OR ? 0 : 2)),
  },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ title: 'A proper existing title' })),
  },
  // Busy-chat queue: the run's finally drains pending_chat_messages — empty here.
  pendingChatMessage: {
    findFirst: jest.fn(async () => null), delete: jest.fn(async () => ({})),
    // shutdown re-queue (2026-09-11) — enqueueChatMessage counts then creates.
    count: jest.fn(async () => 0), create: jest.fn(async (a: any) => ({ id: 'pend-1', ...a.data })),
  },
  // chat-busy's durable layer (worker-tier coding runs) — none in these tests.
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// message-queue.service's origin stash imports config/redis (whose chain also
// reaches config/env → process.exit at import) — mock the boundary. chat-busy's
// cross-process layer rides the same mock as an in-memory Redis with REAL
// SET NX semantics (startDetachedChatRun's atomic claim runs against it in
// every test here).
const redisStore = new Map<string, string>();
// List store — the cross-instance run-event mirror (run-event-mirror.ts) RPUSHes
// every chat run's events through the live-run tap wired in startDetachedChatRun.
const redisLists = new Map<string, string[]>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => {
      const had = redisStore.delete(k) || redisLists.delete(k);
      return had ? 1 : 0;
    }),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
    rPush: jest.fn(async (k: string, v: string) => {
      const l = redisLists.get(k) ?? [];
      l.push(v);
      redisLists.set(k, l);
      return l.length;
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const l = redisLists.get(k);
      if (l) redisLists.set(k, l.slice(start < 0 ? Math.max(0, l.length + start) : start, stop < 0 ? l.length + stop + 1 : stop + 1));
      return 'OK';
    }),
    lRange: jest.fn(async (k: string) => redisLists.get(k) ?? []),
    expire: jest.fn(async () => 1),
  },
}));

// chat-agent.service now imports message-queue.service → middleware/error-handler
// → config/env, which calls process.exit(1) without env vars and kills the whole
// jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Seat pre-flight (2026-09-04): the REAL seatUnservableReason reads provider
// env keys, and this jest env is keyless — every run would fail fast with
// SeatUnservableError before reaching the mocked workers. Keep the rest of
// coding-model REAL (resolveRoleModelForRun etc. are exercised).
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500) })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
// N4 (2026-09-25): the checker-site router's gate call + outcome recorder at
// the boundaries — decide() is a controllable promise (the zero-latency
// contract: shadow never awaits it), the recorder captures the finalize facts.
const mockDecide: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/decision-gate'),
  decide: (...a: any[]) => mockDecide(...a),
}));
const mockRecordCheckerOutcome: jest.Mock = jest.fn();
jest.mock('./checker-route-gate', () => ({
  __esModule: true,
  ...jest.requireActual('./checker-route-gate'),
  recordCheckerRouteOutcome: (...a: any[]) => mockRecordCheckerOutcome(...a),
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { saveToSessionHistory: jest.fn(async () => {}) },
}));
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: jest.fn(async () => 'A Generated Title') },
}));

// Phantom-claim action verifier (ticket ae085617): finalize fires it via a
// fire-and-forget dynamic import — mocked at the boundary (the real module
// pulls utility-llm → config/env → process.exit at import in a keyless env).
// The PRE-DELIVERY guard (fcc4dbb4) rides the same boundary; its default here
// is a pass-through (struck:false) so pre-existing runs are unaffected.
const mockVerifySupervisorRunAsync = jest.fn();
const mockVerifyRunActionClaimsAsync = jest.fn();
const mockGuardMachineWakeFinalAnswer = jest.fn(async (...a: any[]) => ({ finalText: a[0].finalText, notice: '', struck: false, phantoms: [] as any[] }));
jest.mock('../platform/action-verifier', () => ({
  __esModule: true,
  verifySupervisorRunAsync: (...a: any[]) => mockVerifySupervisorRunAsync(...a),
  verifyRunActionClaimsAsync: (...a: any[]) => mockVerifyRunActionClaimsAsync(...a),
  guardMachineWakeFinalAnswer: (...a: any[]) => mockGuardMachineWakeFinalAnswer(...a),
  // Pure scan (ticket 31738d9a — the L2 checker block builder awaits it via a
  // dynamic import). Without it the block builder REJECTED here, the checker
  // block was always '' and the step-0 reconcile pass never ran in this file
  // (the WI-D ledger suite's "if it ran" hedge). A no-clock stub — the
  // draft-integrity scan is pinned by its own suites.
  findFutureObservedTimestamps: () => [],
  // Pure classification (ticket b216475a — the always-on citation-enforce
  // branch gates on it). Reimplemented inline because this boundary exists to
  // avoid the real module's import chain — keep in sync with
  // action-verifier.ts's isCitationClassClaim / CITATION_CLASS_TAGS.
  isCitationClassClaim: (claim: any) =>
    claim?.fabricatedId === true || ['[evidence citation]', '[owner chat ref]', '[vanished artifact]'].some((tag) => String(claim?.detail ?? '').startsWith(tag)),
  // Pure filter (ticket a688ba29 — the seam feeds its output to the guard's
  // extraEvidenceHaystacks on the reject-back second pass). Reimplemented
  // inline because this boundary exists to avoid the real module's import
  // chain — keep in sync with action-verifier.ts's toolResultTextsFromParts.
  toolResultTextsFromParts: (parts: any[]) =>
    (Array.isArray(parts) ? parts : [])
      .filter((p: any) => p && p.type === 'tool_result' && typeof p.result === 'string' && p.result)
      .map((p: any) => p.result),
}));

// Supervisor claims-with-receipts lane (owner 2026-09-03): the chat finalize
// dynamically imports run-evidence-guard for isSupervisor chats — mocked at
// the boundary (the real module's chain reaches github/token-manager →
// config/env → process.exit at import in a keyless env). Default impl is the
// lane's identity contract (no change).
const mockApplyClaimsBlockLane: jest.Mock = jest.fn((opts: any): any => ({
  finalText: opts.guarded.finalText, notes: opts.guarded.notes, verdict: opts.guarded.verdict,
  lane: { present: false, verified: [], unverified: [], coveredKinds: [] },
}));
jest.mock('../coding/run-evidence-guard', () => ({
  __esModule: true,
  applyClaimsBlockLane: (...a: any[]) => mockApplyClaimsBlockLane(...a),
}));

// Owner briefings (owner 2026-09-04): the supervisor machine-wake finalize
// fire-and-forgets the plain-English briefing generator via a dynamic import —
// mocked at the boundary (the real module pulls prisma/redis/utility-llm; the
// generator's own lock/garbage gates are pinned in its own suite).
const mockGenerateOwnerBriefing = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../fleet/owner-briefing.service', () => ({
  __esModule: true,
  OWNER_BRIEFING_KIND: 'owner_briefing',
  generateOwnerBriefing: (...a: any[]) => mockGenerateOwnerBriefing(...a),
}));

// Shared vision hop (owner 2026-09-03): text-only ensemble peers get ONE
// glm-5.3-flash image description — mocked so no network hop ever fires.
const mockDescribeImage = jest.fn(async (..._a: any[]) => 'a described image');
jest.mock('../image-describe', () => ({
  __esModule: true,
  describeImageWithVision: (...a: any[]) => mockDescribeImage(...a),
  VISION_UTILITY_MODEL: 'glm-5.3-flash',
  resolveVisionDescribeModel: async () => 'glm-5.3-flash',
}));

// Fleet supervisor (slice B): run finalize emits a hook event + clears the
// wake-depth stamp via a fire-and-forget dynamic import — mocked at the module
// boundary (the real module's chain reaches config/env → process.exit at import).
const mockEmitHookEventSafe = jest.fn(async (..._a: any[]) => {});
const mockClearHookDepth = jest.fn(async (..._a: any[]) => {});
const mockStampHookDepth = jest.fn(async (..._a: any[]) => {});
// Run-finalize fairness (owner 2026-09-14): age of the oldest pending hook row
// for the chat (0 = queue-first default) + the hook drain the finalize kicks.
const mockOldestPendingHookAgeMs: jest.Mock = jest.fn(async () => 0);
const mockDrainHookEventsForTarget: jest.Mock = jest.fn();
// Autonomy loop #11: the queue drain's hook-starvation yield + the retiring-colour un-park.
const mockHookBacklogStarving: jest.Mock = jest.fn(async () => false);
// Loop #17: the finalize AWAITS the hooks-first wake; true = a wake was delivered (default).
const mockDrainHookEventsForTargetNow: jest.Mock = jest.fn(async () => true);
// Loop #15 fairness verdict — mirrors the real rule minus deliverability, driven by mockOldestPendingHookAgeMs.
const mockHooksFirstVerdict: jest.Mock = jest.fn(async (chatId: string, head: any) => {
  const age = Number(await mockOldestPendingHookAgeMs(chatId)) || 0;
  const q = Number(head?.ageMs) || 0;
  if (age < 5 * 60 * 1000) return { hooksFirst: false, reason: age ? 'young' : 'no_hooks', hookAgeMs: age, queueHeadAgeMs: q };
  if (head?.source === 'user') return { hooksFirst: false, reason: 'user_waiting', hookAgeMs: age, queueHeadAgeMs: q };
  if (q > age) return { hooksFirst: false, reason: 'queue_older', hookAgeMs: age, queueHeadAgeMs: q };
  return { hooksFirst: true, reason: 'hooks_first', hookAgeMs: age, queueHeadAgeMs: q };
});
const mockUnparkHookEventsForTarget: jest.Mock = jest.fn(async () => 0);
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  clearHookDepth: (...a: any[]) => mockClearHookDepth(...a),
  stampHookDepth: (...a: any[]) => mockStampHookDepth(...a),
  HOOK_STARVATION_MS: 5 * 60 * 1000,
  oldestPendingHookAgeMs: (...a: any[]) => mockOldestPendingHookAgeMs(...a),
  drainHookEventsForTarget: (...a: any[]) => mockDrainHookEventsForTarget(...a),
  hookBacklogStarving: (...a: any[]) => mockHookBacklogStarving(...a),
  hooksFirstVerdict: (...a: any[]) => mockHooksFirstVerdict(...a),
  drainHookEventsForTargetNow: (...a: any[]) => mockDrainHookEventsForTargetNow(...a),
  unparkHookEventsForTarget: (...a: any[]) => mockUnparkHookEventsForTarget(...a),
}));

// Deferred-action receipts (remediation P2 spark G8): the supervisor machine-
// wake finalize dynamically imports coding/schedule.service to auto-arm a
// one-shot follow-up — mocked at the boundary (the real module's dynamic
// autonomy.service chain reaches crossmodel.service, far too heavy here).
const mockCreateSchedule: jest.Mock = jest.fn(async (input: any) => ({
  ok: true,
  schedule: { id: 'sched-deferred-1234', kind: input?.kind, prompt: input?.prompt },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  createSchedule: (...a: any[]) => mockCreateSchedule(...a),
}));

// Loop-metrics telemetry (statically imported by the service): mocked so the
// reject-back outcome record ({citationRetry:'clean'|'still_dirty'} — owner
// 2026-09-04) is assertable, and no buffer/DB path loads. Kinds are inlined
// (the hooks.service.test.ts pattern) — requireActual would drag config/database.
const mockRecordLoopMetric: jest.Mock = jest.fn();
// WI-D: the per-turn spend ledger's single writer (chat-agent/turn-spend.ts).
const mockRecordRunSpend: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
  recordRunSpend: (...a: any[]) => mockRecordRunSpend(...a),
  LOOP_METRIC_KINDS: {
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    QUEUE_FAIRNESS_PREEMPT: 'queue_fairness_preempt',
    FINALIZE_HOOKS_FIRST: 'finalize_hooks_first',
    CHAT_SEARCH_USAGE: 'chat_search_usage',
    CHAT_PLATFORM_USAGE: 'chat_platform_usage',
    SUPERVISOR_DEFERRAL_UNARMED: 'supervisor_deferral_unarmed',
    DEPLOY_RETIRE_NUDGE: 'deploy_retire_nudge',
    COMPUTE_POLICY: 'compute_policy',
    UX_TTFT: 'ux_ttft',
    UX_BEACON: 'ux_beacon',
  },
}));

// ── Compute policy seams (this file's own mocks) ────────────────────────────
// The gate module is Module A's (a preset-returning stub in this worktree);
// every call is controllable here. late-crosscheck is captured at its dynamic
// import; notify_user (account-tools) and the drafts_agree label likewise.
const mockPlan: jest.Mock = jest.fn();
const mockAgree: jest.Mock = jest.fn(async () => ({ agree: null, p: null, mode: 'off' }));
const mockRevision: jest.Mock = jest.fn(async () => ({ material: true, changed: [], source: 'fallback' }));
jest.mock('../platform/compute-policy-gate', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/compute-policy-gate'),
  decideComputePlan: (...a: any[]) => mockPlan(...a),
  decideDraftsAgree: (...a: any[]) => mockAgree(...a),
  decideRevisionMaterial: (...a: any[]) => mockRevision(...a),
  // The D0 ask ceiling the ACT path races the plan against (read per run at
  // chat-agent.service.ts `computePolicyTimeoutMs()`): 50 ms here, not the
  // contract's 1 200 ms — a resolved mockPlan always wins this race (microtask
  // before any timer), and the never-resolving slow-gate test settles in 50 ms.
  computePolicyTimeoutMs: () => mockComputePlanTimeoutMs,
}));
// The finalize's late-draft grace (chat-agent.service.ts races the checker
// promise against CROSS_CHECK_LATE_WAIT_MS before shipping the first answer):
// 50 ms here, not the production 10 s. There is no env for it; everything
// else in agent-profiles stays real.
jest.mock('../coding/agent-profiles', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/agent-profiles'),
  CROSS_CHECK_LATE_WAIT_MS: mockCrossCheckLateWaitMs,
}));
// Dynamic roster phase 2 (2026-10-03): the turn plan is controllable at its module boundary.
const mockTurnPlan: jest.Mock = jest.fn(async () => null);
const mockCanary: jest.Mock = jest.fn(async () => false);
jest.mock('../platform/turn-plan', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/turn-plan'),
  decideTurnPlan: (...a: any[]) => mockTurnPlan(...a),
  turnPlanCanaryIncludes: (...a: any[]) => mockCanary(...a),
}));
// roster 2026-10-06 C-3 / C-4: the role picks + the Quick web budget are controllable at their module boundaries.
// Defaults = OFF (nothing computed, no budget), so every other test in this file runs today's seats.
const mockRolePickDecision: jest.Mock = jest.fn(async () => ({ mode: 'off', acts: false, canary: false }));
const mockQuickWebCapDecision: jest.Mock = jest.fn(async () => ({ mode: 'off', acts: false, canary: false }));
jest.mock('../platform/roster-policy', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/roster-policy'),
  rolePickDecision: (...a: any[]) => mockRolePickDecision(...a),
  quickWebCapDecision: (...a: any[]) => mockQuickWebCapDecision(...a),
}));
const mockResolveRolePicks: jest.Mock = jest.fn(async () => null);
const mockResolveRolePicksBounded: jest.Mock = jest.fn(async () => null);
jest.mock('../platform/role-pick', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/role-pick'),
  resolveRolePicks: (...a: any[]) => mockResolveRolePicks(...a),
  resolveRolePicksBounded: (...a: any[]) => mockResolveRolePicksBounded(...a),
}));
// Roster 2026-10-06 (Team A): the lane-depth access + the checker-pool pick are controllable; every pure rule stays REAL.
const LANE_OFF = { acts: { checker: false, research: false, failOpen: false }, canary: false, modes: { checker: 'shadow', research: 'shadow', failOpen: 'shadow' } };
const mockLaneAccess: jest.Mock = jest.fn(async () => LANE_OFF);
const mockLaneCheckerModel: jest.Mock = jest.fn(async (_lead: string, seat: string) => ({ spec: seat, why: 'the checker pool follows the seat' }));
jest.mock('../platform/lane-depth', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/lane-depth'),
  laneDepthFor: (...a: any[]) => mockLaneAccess(...a),
  laneCheckerModelFor: (...a: any[]) => mockLaneCheckerModel(...a),
}));
const mockRunLate: jest.Mock = jest.fn(async () => ({ outcome: 'no_draft' }));
jest.mock('./late-crosscheck', () => ({
  __esModule: true,
  ...jest.requireActual('./late-crosscheck'),
  runLateCrossCheck: (...a: any[]) => mockRunLate(...a),
}));
const mockExecuteAccountTool: jest.Mock = jest.fn(async () => '{"ok":true}');
jest.mock('../platform/account-tools', () => ({
  __esModule: true,
  executeAccountTool: (...a: any[]) => mockExecuteAccountTool(...a),
}));
// Telemetry honesty (audit 2026-09-26 supervisors-auto-4): the machine-row caps
// reader is a fail-open seam over schedule / spend-cap — fixed here so the row
// shape is assertable without those chains.
const mockReadMachineCaps: jest.Mock = jest.fn(async () => ({ dailyFirings: { used: 3, cap: 480 }, spendCapUsdPerDay: null }));
jest.mock('./machine-caps', () => ({
  __esModule: true,
  readMachineCaps: (...a: any[]) => mockReadMachineCaps(...a),
}));
const mockLabelDraftsAgree: jest.Mock = jest.fn(() => true);
// cp/labels (2026-09-26): the finalize `facts` row goes through the same adapter module.
const mockLabelFacts: jest.Mock = jest.fn(() => true);
jest.mock('./compute-policy-labels', () => ({
  __esModule: true,
  ...jest.requireActual('./compute-policy-labels'), // draftsAgreeLabelMaterial / draftsAgreeMeta stay REAL (pure)
  labelDraftsAgree: (...a: any[]) => mockLabelDraftsAgree(...a),
  labelComputePolicyFacts: (...a: any[]) => mockLabelFacts(...a),
}));
// cp/labels: the reask_5m hook is a dynamic import off the request path — captured here.
const mockLabelReask: jest.Mock = jest.fn(async () => 'labelled');
jest.mock('./compute-policy-label-hooks', () => ({
  __esModule: true,
  labelReaskForChat: (...a: any[]) => mockLabelReask(...a),
  labelThumbsForMessage: jest.fn(async () => 'labelled'),
}));

// Non-empty prior history: skips the up-front title block (whose 12s race
// timer would linger) and the M2 repair early-returns on the non-stale title.
jest.mock('./chat-context', () => ({
  buildChatQueryContext: jest.fn(async () => ({
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));

import { startDetachedChatRun, DRAFTS_AGREE_ACT_P, chatAgentRunKey } from './chat-agent.service';
import { seatUnservableReason } from '../coding/coding-model';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { isRunActive, subscribeRun, getRunMeta, runLastProgressAt } from '../coding/live-runs';
import { presetPlan, stakesWaitMs, computePolicyTimeoutMs } from '../platform/compute-policy-gate';
import { depthBudgetMaxBackgroundMs } from '../platform/depth-budget';
const STAKES_WAIT_MS = stakesWaitMs();
import { CROSS_CHECK_GATE_MS, CROSS_CHECK_HARD_MS, CROSS_CHECK_SOFT_MS, CROSS_CHECK_LATE_WAIT_MS } from '../coding/agent-profiles';

const BASE = { message: 'the question', mode: 'single_thinking' as const };
const agentMock = runCodingAgent as jest.Mock;
const workerMock = runChatWorker as jest.Mock;

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
type Ev = { type: string; data: any };
const plan = (over: Partial<ReturnType<typeof presetPlan>> = {}) => ({ ...presetPlan('thinking'), ...over });
/** Run one detached turn; resolve with the run key + the event log once 'complete' or 'error' lands. */
async function runTurn(args: Record<string, any>, waitMs = 4000): Promise<{ key: string; events: Ev[] }> {
  const key = await startDetachedChatRun({ ...BASE, userId: 'u1', sessionId: null, ...args } as any);
  expect(key).toBeTruthy();
  const events: Ev[] = [];
  subscribeRun(key!, e => events.push(e));
  await waitFor(() => events.some(e => e.type === 'complete' || e.type === 'error'), waitMs);
  await waitFor(() => !isRunActive(key!), waitMs);
  return { key: key!, events };
}
const complete = (events: Ev[]) => events.find(e => e.type === 'complete')!.data;
const persistedMeta = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.role === 'assistant').at(-1)?.metadata;
/** Which settled first: the injector promise or a timer — the ONLY honest way to read "did it block". */
const raceInjector = async (p: Promise<any>, ms: number): Promise<'injector' | 'timer'> =>
  Promise.race([p.then(() => 'injector' as const), new Promise<'timer'>(r => setTimeout(() => r('timer'), ms))]);
/** "The injector did NOT block": a wait-0 injector settles in microtasks, so it beats even a generous timer;
 *  a held injector (the 300 s gate / the 90 s stakes wait) never does. Order, not elapsed ms. */
const NOT_BLOCKED_BOUND_MS = 2_000;
/** The Double Checker worker calls (never the one-shot reconcile pass, whose user message carries the draft). */
const checkerCalls = () => workerMock.mock.calls.filter(([i]: any[]) => !String(i?.userMessage).includes('YOUR DRAFT ANSWER'));

beforeEach(() => {
  redisStore.clear(); // a leaked liveness key must not fail a later claim
  redisLists.clear();
  jest.clearAllMocks();
  delete process.env.ANSWER_FIRST_DISABLED;
  delete process.env.DIG_DEEPER_DISABLED;
  delete process.env.DEPTH_BUDGET_DISABLED;
  delete process.env.COMPUTE_POLICY_MACHINE_ACT_ENABLED;
  delete process.env.MACHINE_DEEP_RESEARCH_FLOOR_DISABLED;
  delete process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS;
  delete process.env.COMPUTE_POLICY_DISABLED;
  delete process.env.COMPUTE_POLICY_MACHINE_DISABLED;
  delete process.env.RESEARCH_NO_WALL_CLOCK_DISABLED;
  delete process.env.COUNCIL_STALL_MS;
  mockReadMachineCaps.mockImplementation(async () => ({ dailyFirings: { used: 3, cap: 480 }, spendCapUsdPerDay: null }));
  // The compute_policy purpose's mode: unset ⇒ the bare test default 'off' (the
  // preset runs, nothing is awaited); tests that need the gate's plan ADOPTED
  // set 'act' themselves (review 2026-09-26 M4: only an act purpose is awaited).
  delete process.env.DECISION_GATE_MODE_COMPUTE_POLICY;
  mockPlan.mockImplementation(async (i: any) => presetPlan(i.requestedMode));
  mockAgree.mockImplementation(async () => ({ agree: null, p: null, mode: 'off' }));
  mockRevision.mockImplementation(async () => ({ material: true, changed: [], source: 'fallback' }));
  mockRunLate.mockImplementation(async () => ({ outcome: 'no_draft' }));
  agentMock.mockReset();
  workerMock.mockReset();
  agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
  workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
  mockPrisma.crossModelMessage.create.mockImplementation(async (q: any) => ({ id: q?.data?.id ?? 'row-x', createdAt: new Date(), ...q.data }));
  mockPrisma.crossModelMessage.findUnique = jest.fn(async () => null);
  mockPrisma.crossModelMessage.update = jest.fn(async (q: any) => q);
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
});

describe('answer-first — the injector wait (design §5 step 1; chat-agent.service.ts injector block, formerly `CROSS_CHECK_GATE_MS − elapsed`)', () => {
  it('test-sized timers are wired (audit tests-gaps-9): the finalize late-draft grace and the D0 ask ceiling the service reads are the 50 ms overrides, not 10 s / 1 200 ms — if either becomes a boot-time copy this fails instead of silently re-adding 10 s to the suite', () => {
    expect(CROSS_CHECK_LATE_WAIT_MS).toBe(mockCrossCheckLateWaitMs);
    expect(computePolicyTimeoutMs()).toBe(mockComputePlanTimeoutMs);
    expect(mockCrossCheckLateWaitMs).toBeLessThan(1000);
    expect(mockComputePlanTimeoutMs).toBeLessThan(300); // below the env override's own clamp floor — the mock is the only route
  });

  it('DEFAULT: injectSystem(1) resolves at once with NO injection (null) while the Double Checker is pending — the lead keeps its full step budget and is never told to "answer now" (review H2); the doctrine carries the answer-first paragraph; the answer ships with pendingCrossCheck + check_state checking; the late reconcile is armed with the UNBOUNDED checker promise + the revision verdict + a Dig-deeper research chip', async () => {
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    let injected: any = 'unset'; let injectedLater: any = 'unset'; let winner: 'injector' | 'timer' = 'timer'; let doctrine = '';
    agentMock.mockImplementation(async (input: any) => {
      doctrine = String(input.doctrineOverride ?? '');
      const p = input.injectSystem(1).then((v: any) => { injected = v; return v; });
      winner = await raceInjector(p, NOT_BLOCKED_BOUND_MS); // order, not ms: a wait-0 injector settles before any timer can fire
      injectedLater = await input.injectSystem(3); // re-checked at zero cost on every later step — still nothing, still no note
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    // (the finalize keeps a short CROSS_CHECK_LATE_WAIT_MS grace for a draft about to land — 50 ms in this suite, 10 s in prod)
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-af-default' }, 15_000);
    expect(winner).toBe('injector'); // wait 0 (the previous gate held here up to 300 s)
    expect(injected).toBeNull(); // nothing injected — no "still researching, write your final answer now" note
    expect(injectedLater).toBeNull();
    // the doctrine: the answer-first paragraph (never wait, never "answer now"), not today's blocking one
    expect(doctrine).toContain('[PARALLEL CROSS-CHECK IN PROGRESS]');
    expect(doctrine).toContain('Do NOT wait for it');
    expect(doctrine).not.toContain('do NOT write your final answer before the draft arrives');
    expect(doctrine).not.toMatch(/EXCEPTION: if a system message tells you/);
    // the keyed status line, never model prose
    expect(events.find(e => e.type === 'progress' && e.data?.key === 'second_opinion')).toBeTruthy();
    // shipped pending; the pill says "checking"
    const c = complete(events);
    expect(c.pendingCrossCheck).toBe(true);
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'checking' });
    expect(persistedMeta()).toMatchObject({ pendingCrossCheck: true, check: { state: 'checking' }, depth: { plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, source: 'preset' } } });
    // the late reconcile is armed — with the revision verdict + drafts label hook
    await waitFor(() => mockRunLate.mock.calls.length > 0);
    const late = mockRunLate.mock.calls[0][0];
    expect(typeof late.decideRevision).toBe('function');
    expect(typeof late.onOutcome).toBe('function');
    // Dig deeper: a checked answer's next rung is research; the chip names the persisted row
    expect(c.chips).toEqual([expect.objectContaining({ kind: 'escalate', label: 'Dig deeper', nextRung: 'research', escalationOf: c.messageId })]);
    expect(events.find(e => e.type === 'followups')?.data.chips).toEqual(c.chips);
    checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
  }, 20_000);

  // Audit 2026-10-06 T6-5 (stanne P3, e748a8ce: a pure dispatch turn waited 315 s for a reconcile that resolved empty).
  it('a PURE dispatch / coordination turn (platform reads + send_chat_message) skips the Double Checker: no late reconcile, no pendingCrossCheck, check_state skipped, the checker loop is told to stop, crosscheck_dispatch_skip recorded; CROSSCHECK_DISPATCH_SKIP_DISABLED=1 restores the reconcile', async () => {
    const checker = deferred<{ finalText: string; parts: any[] }>();
    let checkerCancelled: (() => boolean) | undefined;
    workerMock.mockImplementation((input: any) => { checkerCancelled = input.isCancelled; return checker.promise; });
    const dispatchParts = [
      { type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'tool_result', name: 'get_chat_status', result: 'idle' },
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 403b3ad5' },
    ];
    agentMock.mockImplementation(async () => ({ finalText: 'Dispatched to lane-1 — receipt 403b3ad5.', parts: dispatchParts }));
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-dispatch-skip' }, 15_000);
    const c = complete(events);
    expect(c.pendingCrossCheck).toBeUndefined();
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'skipped' });
    expect(persistedMeta()).toMatchObject({ check: { state: 'skipped' } });
    expect(mockRunLate).not.toHaveBeenCalled();
    expect(typeof checkerCancelled).toBe('function');
    expect(checkerCancelled!()).toBe(true);
    expect(mockRecordLoopMetric.mock.calls.map((x: any[]) => x[0]).find((r: any) => r.kind === 'crosscheck_dispatch_skip'))
      .toMatchObject({ sessionId: 'chat-dispatch-skip', meta: expect.objectContaining({ tools: ['send_chat_message'] }) });
    checker.resolve({ finalText: '', parts: [] });

    // Kill switch: today's answer-first late reconcile is armed again.
    jest.clearAllMocks();
    process.env.CROSSCHECK_DISPATCH_SKIP_DISABLED = '1';
    try {
      const checker2 = deferred<{ finalText: string; parts: any[] }>();
      workerMock.mockImplementation(() => checker2.promise);
      agentMock.mockImplementation(async () => ({ finalText: 'Dispatched to lane-1 — receipt 403b3ad5.', parts: dispatchParts }));
      const r2 = await runTurn({ mode: 'thinking', chatId: 'chat-dispatch-skip-ks' }, 15_000);
      expect(complete(r2.events).pendingCrossCheck).toBe(true);
      await waitFor(() => mockRunLate.mock.calls.length > 0);
      checker2.resolve({ finalText: 'PEER-DRAFT', parts: [] });
    } finally { delete process.env.CROSSCHECK_DISPATCH_SKIP_DISABLED; }
  }, 30_000);

  it('a turn that dispatched AND researched the web keeps the Double Checker (late reconcile armed)', async () => {
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    agentMock.mockImplementation(async () => ({ finalText: 'Rates rose 2%; I told the lane.', parts: [
      { type: 'tool_call', name: 'search_engine', args: { query: 'rates' } }, { type: 'tool_result', name: 'search_engine', result: 'up 2%' },
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1' } }, { type: 'tool_result', name: 'send_chat_message', result: 'ok' },
    ] }));
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-dispatch-research' }, 15_000);
    expect(complete(events).pendingCrossCheck).toBe(true);
    await waitFor(() => mockRunLate.mock.calls.length > 0);
    checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
  }, 20_000);

  it('ANSWER_FIRST_DISABLED=1: injectSystem(1) BLOCKS on the pending draft (today\'s CROSS_CHECK_GATE_MS gate) and delivers the draft block when it lands; no keyed status line, no check_state, no drafts_agree ask', async () => {
    process.env.ANSWER_FIRST_DISABLED = '1';
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    let winner: 'injector' | 'timer' = 'injector';
    let injected: any = null; let doctrine = '';
    agentMock.mockImplementation(async (input: any) => {
      doctrine = String(input.doctrineOverride ?? '');
      const p = input.injectSystem(1).then((v: any) => { injected = v; return v; });
      winner = await raceInjector(p, 300);
      checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
      await p;
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-af-off' });
    expect(winner).toBe('timer'); // the gate held (300 s in prod; we only need "not 0")
    expect(String(injected)).toContain('PEER-DRAFT'); // the draft block reached the lead — today's contract
    expect(doctrine).toContain('do NOT write your final answer before the draft arrives'); // today's blocking paragraph, byte-for-byte
    expect(events.find(e => e.type === 'progress' && e.data?.key)).toBeUndefined();
    expect(events.find(e => e.type === 'check_state')).toBeUndefined();
    expect(mockAgree).not.toHaveBeenCalled();
    expect(complete(events).pendingCrossCheck).toBeUndefined();
    expect(CROSS_CHECK_GATE_MS).toBe(300_000); // the constant the kill switch restores
  });

  it('STAKES path (gate ACT: checkerWaitMs = STAKES_WAIT_MS): the injector waits — bounded by the 90 s owner rule — and the status line is double_checking_stakes; the lead runs at max (no human "high" override)', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'act';
    mockPlan.mockResolvedValue(plan({ checkerWaitMs: STAKES_WAIT_MS, leadEffort: 'max', source: 'gate_act', mode: 'act', decisionId: 'cp-1', answers: { stakes: { type: 'noul', noul: 0.95 } } }));
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    let winner: 'injector' | 'timer' = 'injector';
    agentMock.mockImplementation(async (input: any) => {
      expect(input.providerExtra?.reasoning_effort).toBeUndefined(); // 'max' = the provider default, no 'high' override
      const p = input.injectSystem(1);
      winner = await raceInjector(p, 300);
      checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
      await p;
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-af-stakes' });
    expect(winner).toBe('timer');
    const stakes = events.find(e => e.type === 'progress' && e.data?.key === 'double_checking_stakes');
    expect(stakes).toBeTruthy();
    expect(stakes!.data.waitMs).toBeLessThanOrEqual(STAKES_WAIT_MS);
    expect(STAKES_WAIT_MS).toBe(90_000);
    expect(persistedMeta().depth).toMatchObject({ plan: { checkerWaitMs: STAKES_WAIT_MS, source: 'gate_act' }, decisionId: 'cp-1', decision: { id: 'cp-1', mode: 'act' } });
  });

  it('a guest run (no chatId) keeps today\'s bounded path — no late revision can reach it; the chip is signin_deeper', async () => {
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    let winner: 'injector' | 'timer' = 'injector';
    agentMock.mockImplementation(async (input: any) => {
      const p = input.injectSystem(1);
      winner = await raceInjector(p, 200);
      checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
      await p;
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', userId: null, chatId: null, sessionId: 'guest-sess-1' });
    expect(winner).toBe('timer'); // today's gate applies to guests
    const c = complete(events);
    expect(c.pendingCrossCheck).toBeUndefined();
    expect(c.chips).toEqual([{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }]);
  });

  it('a draft that is IN by step 1 is injected in-loop (the lead reconciles before answering): check_state checked, metadata.check checked, no pendingCrossCheck, no late pass (review M6)', async () => {
    let injected: any = null;
    agentMock.mockImplementation(async (input: any) => {
      await new Promise(r => setTimeout(r, 150)); // step 0 — the (instant) checker lands meanwhile
      injected = await input.injectSystem(1);
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-af-inloop' });
    expect(String(injected)).toContain('PEER-DRAFT');
    expect(String(injected)).toMatch(/Reconcile with them now/);
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'checked' });
    expect(complete(events).pendingCrossCheck).toBeUndefined();
    expect(persistedMeta().check).toMatchObject({ state: 'checked' });
    expect(mockRunLate).not.toHaveBeenCalled();
    expect(mockAgree).not.toHaveBeenCalled(); // reconciled in-loop — no first-answer drafts_agree ask
  });

  it('a draft landing MID-LOOP is picked up at the next step (the wait-0 miss never latches): step 1 null, step 2 injects the block, check_state checked', async () => {
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    let first: any = 'unset'; let second: any = 'unset';
    agentMock.mockImplementation(async (input: any) => {
      first = await input.injectSystem(1);
      checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
      await new Promise(r => setTimeout(r, 150));
      second = await input.injectSystem(2);
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-af-midloop' });
    expect(first).toBeNull();
    expect(String(second)).toContain('PEER-DRAFT');
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'checked' });
    expect(complete(events).pendingCrossCheck).toBeUndefined();
    expect(mockRunLate).not.toHaveBeenCalled();
  });

  it('the checker finishing with NO usable draft reads interrupted (nothing will ever reconcile late): the injector hands the lead the no-draft note', async () => {
    workerMock.mockImplementation(async () => ({ finalText: '', parts: [] }));
    let injected: any = null;
    agentMock.mockImplementation(async (input: any) => {
      await new Promise(r => setTimeout(r, 150));
      injected = await input.injectSystem(1);
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-af-nodraft' });
    expect(String(injected)).toMatch(/no usable draft/i);
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'interrupted' });
    expect(complete(events).pendingCrossCheck).toBeUndefined();
    expect(persistedMeta().check).toMatchObject({ state: 'interrupted' });
    expect(mockRunLate).not.toHaveBeenCalled();
  });
});

describe('checker spawn — by PLAN, not by mode', () => {
  it('the L2 preset spawns the checker; the L1 preset does not; the gate in ACT can spawn on L1 and skip on L2 (check_state skipped)', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'act';
    await runTurn({ mode: 'thinking', chatId: 'chat-spawn-l2' });
    expect(checkerCalls()).toHaveLength(1);
    workerMock.mockClear();
    await runTurn({ mode: 'single_thinking', chatId: 'chat-spawn-l1' });
    expect(workerMock).not.toHaveBeenCalled();
    mockPlan.mockResolvedValue({ ...presetPlan('single_thinking'), spawnChecker: true, source: 'gate_act', mode: 'act' });
    await runTurn({ mode: 'single_thinking', chatId: 'chat-spawn-l1-act' });
    expect(checkerCalls()).toHaveLength(1);
    workerMock.mockClear();
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), spawnChecker: false, source: 'gate_act', mode: 'act' });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-spawn-l2-skip' });
    expect(workerMock).not.toHaveBeenCalled();
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'skipped' });
    expect(complete(events).chips[0]).toMatchObject({ kind: 'escalate', nextRung: 'verify' }); // an unchecked answer escalates to verify
  });

  it('machine turns ASK the gate too (owner 2026-09-26: "default all chats to auto even supervisors") with machine:true + segment and NO deep-research allowance, run the MACHINE preset (no checker, wait 0, lead max, no council), never spawn from a preset, never get a chip; COMPUTE_POLICY_MACHINE_DISABLED=1 keeps machine runs off the gate; COMPUTE_POLICY_DISABLED=1 keeps the preset without asking', async () => {
    await runTurn({ mode: 'thinking', chatId: 'chat-spawn-wake', machineWake: true, messageOrigin: 'schedule' });
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockPlan.mock.calls[0][0]).toMatchObject({ machine: true, segment: 'machine', guest: false, allowDeepResearch: false, requestedMode: 'thinking' });
    expect(workerMock).not.toHaveBeenCalled();
    const meta = persistedMeta();
    expect(meta.chips).toBeUndefined();
    expect(meta.depth.plan).toMatchObject({ preset: 'thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'preset' });
    // Lead effort rides the telemetry row (the persisted plan tuple is contract-pinned without it); max = the seat's own default (nothing sent).
    expect(mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy').meta).toMatchObject({ machine: true, segment: 'machine', leadEffort: 'max', spawnChecker: false, checkerWaitMs: 0, council: 'none' });
    expect(agentMock.mock.calls.at(-1)![0].providerExtra).toBeUndefined();
    mockPlan.mockClear();
    process.env.COMPUTE_POLICY_MACHINE_DISABLED = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-spawn-wake-off', machineWake: true, messageOrigin: 'schedule' });
    expect(mockPlan).not.toHaveBeenCalled();
    expect(persistedMeta().depth.plan).toMatchObject({ spawnChecker: false, source: 'preset' });
    delete process.env.COMPUTE_POLICY_MACHINE_DISABLED;
    process.env.COMPUTE_POLICY_DISABLED = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-spawn-off' });
    expect(mockPlan).not.toHaveBeenCalled();
    expect(checkerCalls()).toHaveLength(1);
  });

  it('a SUPERVISOR wake asks the gate with machine:true + segment supervisor and the chat\'s stored preset as the fallback (decideComputePlan requestedMode); no checker, no wait, no council, lead max — and the owner typing INTO the supervisor chat is a human turn (segment supervisor, machine:false, checker from the L2 preset)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-sup-wake', machineWake: true, messageOrigin: 'hook' }, 15_000);
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockPlan.mock.calls[0][0]).toMatchObject({ machine: true, segment: 'supervisor', guest: false, allowDeepResearch: false, requestedMode: 'thinking' });
    expect(workerMock).not.toHaveBeenCalled();
    expect(persistedMeta().depth.plan).toMatchObject({ preset: 'thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'preset' });
    const cp = mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy');
    expect(cp.meta).toMatchObject({ machine: true, segment: 'supervisor', guest: false, planSource: 'preset', spawnChecker: false, leadEffort: 'max' });
    mockPlan.mockClear(); mockRecordLoopMetric.mockClear(); workerMock.mockClear();
    await runTurn({ mode: 'thinking', chatId: 'chat-sup-owner', userTurnAt: new Date() }, 15_000);
    expect(mockPlan.mock.calls[0][0]).toMatchObject({ machine: false, segment: 'supervisor', allowDeepResearch: true });
    // Owner 2026-10-06: a human turn on a supervisor chat runs WITHOUT the Double Checker.
    expect(checkerCalls()).toHaveLength(0);
    expect(persistedMeta().depth.plan).toMatchObject({ spawnChecker: false, checkerWaitMs: 0 });
    expect(mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy').meta).toMatchObject({ machine: false, segment: 'supervisor' });
    // Kill switch SUPERVISOR_CHECKER_SKIP_DISABLED=1: the L2 preset's checker again.
    mockPlan.mockClear(); mockRecordLoopMetric.mockClear(); workerMock.mockClear();
    process.env.SUPERVISOR_CHECKER_SKIP_DISABLED = '1';
    try {
      await runTurn({ mode: 'thinking', chatId: 'chat-sup-owner-ks', userTurnAt: new Date() }, 15_000);
      expect(checkerCalls()).toHaveLength(1);
    } finally { delete process.env.SUPERVISOR_CHECKER_SKIP_DISABLED; }
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('legacy MACHINE_TURN_CROSSCHECK_ENABLED=1: a hook-origin turn keeps its PRESET checker + the old gate byte-for-byte (plain preset path, no machine rails) while still asked as machine:true', async () => {
    process.env.MACHINE_TURN_CROSSCHECK_ENABLED = '1';
    try {
      await runTurn({ mode: 'thinking', chatId: 'chat-legacy-hook', messageOrigin: 'hook' }, 15_000);
      expect(mockPlan.mock.calls[0][0]).toMatchObject({ machine: true, segment: 'machine' });
      expect(checkerCalls()).toHaveLength(1); // the L2 preset's checker, as before the 2026-09-22 default
      expect(persistedMeta().depth.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, source: 'preset' });
    } finally {
      delete process.env.MACHINE_TURN_CROSSCHECK_ENABLED;
    }
  });

  it('machine rails in ACT (COMPUTE_POLICY_MACHINE_ACT_ENABLED=1): a gate plan that adds a checker + a stakes wait + a background council on a machine wake keeps ONLY the checker — it runs BEHIND the answer (injector wait 0, never the stakes wait), council none, lead max; under ANSWER_FIRST_DISABLED=1 no gate checker at all', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'act';
    process.env.COMPUTE_POLICY_MACHINE_ACT_ENABLED = '1';
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max', council: 'background', source: 'gate_act', mode: 'act', decisionId: 'd-machine-1' });
    // The gate's checker lands only after the lead's step 1 asked and the
    // injector answered (wait 0) — resolved by ORDER from inside the lead, not
    // by a timer, so no contention can move it ahead of the ask.
    const checker = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(() => checker.promise);
    let winner: 'injector' | 'timer' = 'timer'; let injected: any = 'unset';
    agentMock.mockImplementation(async (input: any) => {
      const p = input.injectSystem(1).then((v: any) => { injected = v; return v; });
      winner = await raceInjector(p, NOT_BLOCKED_BOUND_MS);
      checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    await runTurn({ mode: 'thinking', chatId: 'chat-machine-act', machineWake: true, messageOrigin: 'schedule' }, 15_000);
    expect(checkerCalls()).toHaveLength(1); // the gate's checker spawned
    expect(winner).toBe('injector'); // never waited on it
    expect(injected).toBeNull();
    const actMeta = persistedMeta();
    expect(actMeta.depth.plan).toMatchObject({ spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'gate_act' });
    expect(actMeta.depth.decisionId).toBe('d-machine-1');
    expect(mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy').meta).toMatchObject({ machine: true, leadEffort: 'max', spawnChecker: true, checkerWaitMs: 0, council: 'none', planSource: 'gate_act' });

    workerMock.mockReset(); workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
    process.env.ANSWER_FIRST_DISABLED = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-machine-act-af-off', machineWake: true, messageOrigin: 'schedule' }, 15_000);
    expect(workerMock).not.toHaveBeenCalled();
    expect(persistedMeta().depth.plan).toMatchObject({ spawnChecker: false, checkerWaitMs: 0, council: 'none' });
  }, 30_000);

  it('audit 2026-09-26 (supervisors-auto-5): by DEFAULT a compute_policy ACT plan on a machine wake is DOWNGRADED to shadow — the machine preset runs (no checker), the decision identity is kept (gate_shadow) so the row still pairs', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'act';
    delete process.env.COMPUTE_POLICY_MACHINE_ACT_ENABLED;
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max', council: 'background', source: 'gate_act', mode: 'act', decisionId: 'd-machine-2' });
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
    await runTurn({ mode: 'thinking', chatId: 'chat-machine-act-default', machineWake: true, messageOrigin: 'schedule' }, 15_000);
    expect(checkerCalls()).toHaveLength(0);
    expect(persistedMeta().depth.plan).toMatchObject({ spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'gate_shadow' });
    expect(persistedMeta().depth.decisionId).toBe('d-machine-2');
  }, 30_000);

  it('audit 2026-09-26 (routing-unify-8): a MACHINE wake requested as deep_research is floored to thinking at the run — no council lead / tools on a machine lane (MACHINE_DEEP_RESEARCH_FLOOR_DISABLED=1 restores)', async () => {
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(300), parts: [] }));
    const { events } = await runTurn({ mode: 'deep_research', chatId: 'chat-machine-l3', machineWake: true, messageOrigin: 'schedule' }, 15_000);
    const meta = persistedMeta();
    expect(meta.mode).toBe('thinking');
    expect(meta.depth.plan.preset).toBe('thinking');
    expect(events.some(e => e.type === 'progress' && /convening/i.test(String(e.data?.message)))).toBe(false);
  }, 30_000);

  it('ACT: a slow gate never delays the turn past COMPUTE_PLAN_TIMEOUT_MS: the preset stands', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'act';
    // A plan that is still PENDING when 'complete' lands — the turn ran on the
    // preset without ever getting an answer. Order-based: the gate is a
    // deferred we never resolve, and we assert the run finished with the
    // preset, not that it finished within N wall-clock ms (runTurn's own
    // waitFor is the only bound — 4 s against a 50 ms test ceiling).
    const gate = deferred<any>();
    let planSettled = false;
    mockPlan.mockImplementation(() => gate.promise.then((v: any) => { planSettled = true; return v; }));
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-plan-slow' });
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(planSettled).toBe(false); // still pending when the turn completed
    expect(persistedMeta().depth.plan.source).toBe('preset');
    expect(complete(events)).toBeTruthy();
    gate.resolve(presetPlan('thinking')); // hygiene — nothing awaits it any more
  });

  it('SHADOW (the contract default; review M4): the ask never sits on the request path — the lead starts while the plan is still pending, the preset runs, and the gate\'s decisionId/answers attach at finalize for labels (metadata.depth + the compute_policy row)', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'shadow';
    const gate = deferred<any>();
    let settled = false; let planPendingWhenLeadStarted: boolean | null = null;
    mockPlan.mockImplementation(() => gate.promise.then((v: any) => { settled = true; return v; }));
    agentMock.mockImplementation(async () => {
      planPendingWhenLeadStarted = !settled; // the lead started BEFORE the gate answered
      gate.resolve({ ...presetPlan('thinking'), source: 'gate_shadow', mode: 'shadow', decisionId: 'cp-shadow', answers: { depth: { type: 'choice', choice: 'ordinary' } }, reason: 'shadow: ordinary' });
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-plan-shadow' });
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(planPendingWhenLeadStarted).toBe(true);
    expect(checkerCalls()).toHaveLength(1); // the preset tuple ran (L2 ⇒ checker)
    expect(persistedMeta().depth).toMatchObject({ plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, source: 'gate_shadow' }, decisionId: 'cp-shadow', decision: { id: 'cp-shadow', mode: 'shadow', answers: { depth: { choice: 'ordinary' } } } });
    const cp = mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy');
    expect(cp.meta).toMatchObject({ planSource: 'gate_shadow', preset: 'thinking', decisionId: 'cp-shadow', mode: 'shadow' });
    expect(complete(events)).toBeTruthy();
  });

  it('OFF (the bare NODE_ENV=test default) and SHADOW never adopt a gate plan that differs from the preset — only ACT does', async () => {
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), spawnChecker: false, source: 'gate_act', mode: 'act', decisionId: 'cp-x' });
    await runTurn({ mode: 'thinking', chatId: 'chat-plan-off' });
    expect(checkerCalls()).toHaveLength(1); // the preset spawned; the act-shaped answer was not awaited
    expect(persistedMeta().depth.plan).toMatchObject({ spawnChecker: true, source: 'preset' });
    expect(persistedMeta().depth.decisionId).toBe('cp-x'); // …but its decisionId still labels the turn
  });
});

describe('drafts_agree at first answer (D1)', () => {
  it('ACT + agree ≥ 0.8: the reconcile pass is SKIPPED, check_state checked, no pendingCrossCheck, metadata.check checked', async () => {
    mockAgree.mockResolvedValue({ agree: true, p: 0.92, mode: 'act', decisionId: 'da-act' });
    // the checker lands immediately; the lead answers at step 0 (never calls injectSystem)
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-agree-act' });
    expect(mockAgree).toHaveBeenCalledTimes(1);
    expect(mockAgree.mock.calls[0][0]).toMatchObject({ leadFinal: expect.stringContaining('AAAA'), checkerDraft: expect.stringContaining('PEER-DRAFT'), chatId: 'chat-agree-act' });
    expect(workerMock).toHaveBeenCalledTimes(1); // the checker only — no 'YOUR DRAFT ANSWER' reconcile worker
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'checked' });
    expect(complete(events).pendingCrossCheck).toBeUndefined();
    expect(persistedMeta().check).toMatchObject({ state: 'checked' });
    expect(mockRunLate).not.toHaveBeenCalled();
    expect(DRAFTS_AGREE_ACT_P).toBe(0.8);
    // drafts_agree label semantics (2026-09-26): the ACTED decision persists its compact stash on
    // the row so a later thumbs / tap labels it acted:true (E12 was blind to acted asks); the
    // in-turn label is NOT written (no reconcile ran, nothing to compare).
    expect(persistedMeta().check.draftsAgree).toMatchObject({ decisionId: 'da-act', p: 0.92, mode: 'act', acted: true, decision: { id: 'da-act', purpose: 'drafts_agree', answers: { agree: { type: 'noul', noul: 0.92 } } } });
    expect(mockLabelDraftsAgree).not.toHaveBeenCalled();
  });

  it('ACT: the acting bar is draftsAgreeThreshold() (DECISION_GATE_THRESHOLD_DRAFTS_AGREE), not a second constant — p=0.85 acts at the default 0.8 and does NOT act when the env raises the bar to 0.9 (the acted set equals the E12 act band)', async () => {
    mockAgree.mockResolvedValue({ agree: true, p: 0.85, mode: 'act', decisionId: 'da-bar' });
    await runTurn({ mode: 'thinking', chatId: 'chat-agree-bar' });
    expect(workerMock).toHaveBeenCalledTimes(1);
    expect(persistedMeta().check).toMatchObject({ state: 'checked', draftsAgree: { decisionId: 'da-bar', acted: true } });
    workerMock.mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    process.env.DECISION_GATE_THRESHOLD_DRAFTS_AGREE = '0.9';
    try {
      mockAgree.mockResolvedValue({ agree: false, p: 0.85, mode: 'act', decisionId: 'da-bar2' }); // decideDraftsAgree reads the same bar ⇒ agree false
      await runTurn({ mode: 'thinking', chatId: 'chat-agree-bar2' });
      expect(workerMock).toHaveBeenCalledTimes(2); // checker + the reconcile pass ran
      expect(persistedMeta().check).not.toHaveProperty('draftsAgree');
    } finally { delete process.env.DECISION_GATE_THRESHOLD_DRAFTS_AGREE; }
  });

  it('ACT but below the bar / SHADOW: the reconcile pass STARTS, the answer ships pending, the same pass finishes into the row (preStartedReconcile) and the label writes from the late verdict', async () => {
    mockAgree.mockResolvedValue({ agree: true, p: 0.9, mode: 'shadow', decisionId: 'da-shadow' });
    const reconcile = deferred<{ finalText: string; parts: any[] }>();
    workerMock.mockImplementation(async (input: any) => String(input.userMessage).includes('YOUR DRAFT ANSWER') ? reconcile.promise : { finalText: 'PEER-DRAFT', parts: [] });
    mockRunLate.mockImplementation(async (i: any) => { i.onOutcome?.({ outcome: 'revised', check: { state: 'updated', changed: ['number: 3'] }, verdict: { material: true, changed: ['number: 3'], source: 'diff' } }); return { outcome: 'revised' }; });
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-agree-shadow' });
    expect(workerMock).toHaveBeenCalledTimes(2); // checker + the reconcile pass
    expect(complete(events).pendingCrossCheck).toBe(true);
    expect(events.find(e => e.type === 'check_state')?.data).toEqual({ state: 'checking' });
    await waitFor(() => mockRunLate.mock.calls.length > 0);
    const late = mockRunLate.mock.calls[0][0];
    expect(late.preStartedReconcile).toBeTruthy();
    expect(late.checkersPromise).toBeTruthy();
    await waitFor(() => mockLabelDraftsAgree.mock.calls.length > 0);
    expect(mockLabelDraftsAgree.mock.calls[0][0]).toMatchObject({ decisionId: 'da-shadow', p: 0.9, mode: 'shadow', material: true, changed: ['number: 3'], acted: false, label: 'reconcile', source: 'late_check' });
    expect(persistedMeta().check).not.toHaveProperty('draftsAgree'); // shadow: the reconcile labels it — no acted stash
    reconcile.resolve({ finalText: 'RECONCILED', parts: [] });
  });

  it('SHADOW label semantics (2026-09-26): the label reads the reconcile VERDICT direction-aware — an additions-only diff labels AGREE (material false), a fallback verdict labels NOTHING (material null), a replaced claim labels disagree', async () => {
    mockAgree.mockResolvedValue({ agree: true, p: 0.9, mode: 'shadow', decisionId: 'da-dir' });
    workerMock.mockImplementation(async (input: any) => String(input.userMessage).includes('YOUR DRAFT ANSWER') ? { finalText: 'RECONCILED', parts: [] } : { finalText: 'PEER-DRAFT', parts: [] });
    const outcomes: any[] = [
      { outcome: 'revised', check: { state: 'updated', changed: ['number: +$20'] }, verdict: { material: true, changed: ['number: +$20'], source: 'diff', contradicts: false } },
      { outcome: 'revised', check: { state: 'updated', changed: [] }, verdict: { material: true, changed: [], source: 'fallback' } },
      { outcome: 'addendum', check: { state: 'updated', changed: ['number: -$50', 'number: +$75'] }, verdict: { material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true } },
      { outcome: 'unchanged', check: { state: 'checked' } },
    ];
    for (const o of outcomes) {
      mockRunLate.mockImplementation(async (i: any) => { i.onOutcome?.(o); return { outcome: o.outcome }; });
      await runTurn({ mode: 'thinking', chatId: `chat-dir-${o.outcome}-${String(o.verdict?.source)}` });
      await waitFor(() => mockRunLate.mock.calls.length > 0);
      mockRunLate.mockClear();
    }
    await waitFor(() => mockLabelDraftsAgree.mock.calls.length >= 4);
    const materials = mockLabelDraftsAgree.mock.calls.map((c: any) => c[0].material);
    expect(materials).toEqual([false, null, true, false]);
  });
});

describe('telemetry — compute_policy + ux_ttft rows (human turns only)', () => {
  it('one compute_policy row + one ux_ttft row per human turn; TTFT measured from the first chunk; metadata.ux persisted', async () => {
    agentMock.mockImplementation(async (input: any) => { input.emit('text', { delta: 'Hello there, here is a long enough answer to pass the holdback window of the adapter. '.repeat(6) }); return { finalText: 'A'.repeat(500), parts: [] }; });
    await runTurn({ mode: 'single_thinking', chatId: 'chat-ttft' });
    const cp = mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy');
    expect(cp).toBeTruthy();
    expect(cp.meta).toMatchObject({ planSource: 'preset', preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', guest: false, budget: { maxBackgroundMs: 15 * 60_000 } });
    expect(cp.meta.budget).not.toHaveProperty('maxUsd'); // owner 2026-09-27: no cost cap on any turn
    const ttft = mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'ux_ttft');
    expect(ttft).toBeTruthy();
    expect(ttft.unit).toBe('ms');
    expect(typeof ttft.value).toBe('number');
    expect(ttft.meta).toMatchObject({ mode: 'single_thinking', preset: 'single_thinking', completionMs: expect.any(Number) });
    expect(persistedMeta().ux).toMatchObject({ firstChunkAt: expect.any(String), ttftMs: expect.any(Number), completionMs: expect.any(Number) });
  });
  it('machine wakes write the compute_policy row (stamped machine + segment — owner 2026-09-26) but never ux_ttft', async () => {
    await runTurn({ mode: 'thinking', chatId: 'chat-ttft-wake', machineWake: true, messageOrigin: 'schedule' });
    const kinds = mockRecordLoopMetric.mock.calls.map((c: any) => c[0].kind);
    expect(kinds).toContain('compute_policy');
    expect(kinds).not.toContain('ux_ttft');
    const cp = mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy');
    expect(cp.meta).toMatchObject({ machine: true, segment: 'machine', guest: false, planSource: 'preset', preset: 'thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', leadEffort: 'max' });
  });
});

describe('telemetry honesty — leadEffortSent / caps (audit 2026-09-26 supervisors-auto-4; budgetEnforced + maxUsd DELETED 2026-09-27 — no hidden cost caps)', () => {
  const cpRow = () => mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).find((m: any) => m.kind === 'compute_policy');
  it('a machine wake row carries the effort the lead was sent and the governing caps (project cap null = none set); the budget has NO maxUsd and NO enforced flag', async () => {
    await runTurn({ mode: 'thinking', chatId: 'chat-honest-wake', machineWake: true, messageOrigin: 'schedule' });
    expect(cpRow().meta).toMatchObject({ machine: true, leadEffort: 'max', leadEffortSent: 'max', caps: { dailyFirings: { used: 3, cap: 480 }, spendCapUsdPerDay: null } });
    expect(cpRow().meta).not.toHaveProperty('budgetEnforced');
    expect(cpRow().meta.budget).not.toHaveProperty('maxUsd');
    expect(mockReadMachineCaps).toHaveBeenCalledWith('chat-honest-wake');
    expect(persistedMeta().depth.budget).not.toHaveProperty('maxUsd');
    expect(persistedMeta().depth.budget).not.toHaveProperty('enforced');
  });
  it('a human-typed supervisor turn carries NO leadEffortSent and NO caps (the daily-firing / project spend caps govern machine firings only) and no budgetEnforced', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-honest-supervisor' });
    expect(cpRow().meta).toMatchObject({ segment: 'supervisor', machine: false });
    expect(cpRow().meta).not.toHaveProperty('budgetEnforced');
    expect(cpRow().meta).not.toHaveProperty('leadEffortSent');
    expect(cpRow().meta).not.toHaveProperty('caps');
    expect(mockReadMachineCaps).not.toHaveBeenCalled();
    expect(persistedMeta().depth.budget).not.toHaveProperty('enforced');
  });
  it('a Level 3 council run carries no budgetEnforced either (no rail exists)', async () => {
    await runTurn({ mode: 'deep_research', chatId: 'chat-honest-council', userTurnAt: new Date() });
    expect(cpRow().meta).not.toHaveProperty('budgetEnforced');
    expect(persistedMeta().depth.budget).not.toHaveProperty('enforced');
  });
  it('a plain human turn carries NONE of the fields (today\'s row shape)', async () => {
    await runTurn({ mode: 'thinking', chatId: 'chat-honest-human' });
    const meta = cpRow().meta;
    expect(meta).not.toHaveProperty('budgetEnforced');
    expect(meta).not.toHaveProperty('leadEffortSent');
    expect(meta).not.toHaveProperty('caps');
    expect(persistedMeta().depth.budget).not.toHaveProperty('enforced');
  });
  it('the caps reader failing never touches the row (fail-open)', async () => {
    mockReadMachineCaps.mockImplementation(async () => { throw new Error('boom'); });
    await runTurn({ mode: 'thinking', chatId: 'chat-honest-wake-fail', machineWake: true, messageOrigin: 'hook' });
    expect(cpRow().meta).toMatchObject({ machine: true, leadEffortSent: 'max' });
    expect(cpRow().meta).not.toHaveProperty('caps');
  });
});

describe('Dig deeper — the escalation run', () => {
  it('verify rung: NO user row, the chat is never re-titled, the assistant row is a "Deeper findings" message naming escalationOf, the original row is stamped with the spent rung, the checker runs with a stakes-bounded wait, no further chip past research', async () => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-1' ? { id: 'orig-1', chatId: 'chat-esc', metadata: { mode: 'single_thinking', depth: { plan: { preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'preset' } } } } : null);
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-esc', escalation: { ofMessageId: 'orig-1', rung: 'verify' }, userTurnAt: new Date() });
    const rows = mockPrisma.crossModelMessage.create.mock.calls.map((c: any) => c[0].data);
    expect(rows.filter((r: any) => r.role === 'user')).toHaveLength(0);
    const a = rows.find((r: any) => r.role === 'assistant');
    expect(a.content.startsWith('**Deeper findings**')).toBe(true);
    expect(a.metadata).toMatchObject({ kind: 'deeper_findings', escalationOf: 'orig-1', escalationRung: 'verify', title: 'Deeper findings', depth: { plan: { source: 'escalation', spawnChecker: true, checkerWaitMs: STAKES_WAIT_MS } } });
    expect(workerMock).toHaveBeenCalled(); // the Double Checker ran for the verify rung
    expect(agentMock.mock.calls[0][0].userMessage).toContain('DIG DEEPER');
    // after verify, research remains — and the chip points at the ORIGINAL message (a Deeper-findings row is never itself escalated)
    expect(complete(events).chips[0]).toMatchObject({ kind: 'escalate', nextRung: 'research', escalationOf: 'orig-1' });
    // Audit 2026-09-26 (routing-unify-4): a provisional `running` stamp lands at run
    // start, the finalize stamp replaces it with `done` + the rung's own spend.
    await waitFor(() => mockPrisma.crossModelMessage.update.mock.calls.some((c: any) => c[0].where.id === 'orig-1' && c[0].data.metadata.depth.escalations?.some((e: any) => e.status === 'done')));
    const stamps = mockPrisma.crossModelMessage.update.mock.calls.filter((c: any) => c[0].where.id === 'orig-1').map((c: any) => c[0]);
    expect(stamps[0].data.metadata.depth.escalations).toEqual([expect.objectContaining({ rung: 'verify', status: 'running' })]);
    expect(stamps[stamps.length - 1].data.metadata.depth.escalations).toEqual([expect.objectContaining({ rung: 'verify', status: 'done', messageId: a.id })]);
    expect(mockExecuteAccountTool).not.toHaveBeenCalled(); // notify only on the research rung
  });

  it('research rung: the council runs (deep_research), deeper_findings_started is announced, no chip remains, and notify_user fires through the existing account tool', async () => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-2' ? { id: 'orig-2', chatId: 'chat-esc-r', metadata: { mode: 'thinking' } } : null);
    const { events } = await runTurn({ mode: 'deep_research', chatId: 'chat-esc-r', escalation: { ofMessageId: 'orig-2', rung: 'research' }, userTurnAt: new Date() });
    // map A1 (2026-10-15): the research rung's harness note carries the depth mandate —
    // primary sources + challenge assumptions — into the lead's user message, end to end.
    expect(String(agentMock.mock.calls[0][0].userMessage)).toContain("verify the earlier answer's key claims against primary sources, challenge its underlying assumptions (not just its facts)");
    expect(events.find(e => e.type === 'progress' && e.data?.key === 'deeper_findings_started')).toBeTruthy();
    expect(complete(events).chips).toBeUndefined();
    await waitFor(() => mockExecuteAccountTool.mock.calls.length > 0);
    const [ctx, name, args] = mockExecuteAccountTool.mock.calls[0];
    expect(name).toBe('notify_user');
    expect(ctx).toMatchObject({ sessionId: 'chat-esc-r', userId: 'u1' });
    expect(String(args.message)).toMatch(/Deeper findings are ready/);
    await waitFor(() => mockPrisma.crossModelMessage.update.mock.calls.some((c: any) => c[0].where.id === 'orig-2' && c[0].data.metadata.depth.escalations?.some((e: any) => e.status === 'done')));
    expect(mockPrisma.crossModelMessage.update.mock.calls.filter((c: any) => c[0].where.id === 'orig-2').at(-1)[0].data.metadata.depth.escalations[0]).toMatchObject({ rung: 'research', status: 'done' });
  });

  it('DIG_DEEPER_DISABLED=1 removes the chip from an ordinary human turn', async () => {
    process.env.DIG_DEEPER_DISABLED = '1';
    const { events } = await runTurn({ mode: 'single_thinking', chatId: 'chat-chip-off' });
    expect(complete(events).chips).toBeUndefined();
    expect(persistedMeta().chips).toBeUndefined();
  });
});

describe('DepthBudget hook — DELETED 2026-09-27 (owner: no hidden cost caps)', () => {
  it('REGRESSION PIN (no cap when no project cap is set): NO turn receives forceFinalTurn — a plain human turn, a machine wake, a hook-origin turn, a Level 3 council run and a supervisor chat all run without a USD hook', async () => {
    const lastInput = () => agentMock.mock.calls.at(-1)![0];
    await runTurn({ mode: 'single_thinking', chatId: 'chat-budget' });
    expect(lastInput().forceFinalTurn).toBeUndefined();
    await runTurn({ mode: 'thinking', chatId: 'chat-budget-wake', machineWake: true, messageOrigin: 'schedule' });
    expect(lastInput().forceFinalTurn).toBeUndefined();
    await runTurn({ mode: 'thinking', chatId: 'chat-budget-hook', messageOrigin: 'hook' });
    expect(lastInput().forceFinalTurn).toBeUndefined();
    await runTurn({ mode: 'deep_research', chatId: 'chat-budget-council', userTurnAt: new Date() });
    expect(lastInput().forceFinalTurn).toBeUndefined();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-budget-supervisor' });
    expect(lastInput().forceFinalTurn).toBeUndefined();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    // …and a plain human turn carries NO hook either — the retired env is dead too
    process.env.DEPTH_BUDGET_MAX_USD = '0.01';
    await runTurn({ mode: 'thinking', chatId: 'chat-budget-human' });
    expect(lastInput().forceFinalTurn).toBeUndefined();
    delete process.env.DEPTH_BUDGET_MAX_USD;
  });
});

// ── audit H2 (2026-09-26): the research rung honours DepthBudget.maxBackgroundMs + maxUsd ──
// Since 2026-10-20 deep research has NO wall clock (council-dispatch.ts researchNoWallClock): these clocks are what
// the release switch RESEARCH_NO_WALL_CLOCK_DISABLED=1 restores byte-for-byte — pinned under it.
describe('DepthBudget on the Dig-deeper research rung (audit H2) — under RESEARCH_NO_WALL_CLOCK_DISABLED=1', () => {
  beforeEach(() => { process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1'; });
  afterEach(() => { delete process.env.RESEARCH_NO_WALL_CLOCK_DISABLED; });
  const COUNCIL_LEAD_BACKSTOP_MS = 40 * 60_000;
  const COUNCIL_COLLEAGUE_BACKSTOP_MS = 30 * 60_000;
  const COUNCIL_PRESET_COLLEAGUE_FIT_MS = 9 * 60_000; // fitColleagueDeadline(30 min) = 12-min dispatch wait − 3-min final-turn grace
  const researchEscalation = (chatId: string) => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-h2' ? { id: 'orig-h2', chatId, metadata: { mode: 'thinking' } } : null);
    return runTurn({ mode: 'deep_research', chatId, escalation: { ofMessageId: 'orig-h2', rung: 'research' }, userTurnAt: new Date() });
  };
  /** The lead's agent input, with the council's dispatch tool driven once so a colleague run is observable. */
  const driveOneDispatch = () => {
    agentMock.mockImplementationOnce(async (input: any) => {
      const dispatch = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'dispatch_colleagues');
      if (dispatch) await dispatch.execute({ tasks: [{ model: 'double_checker', mission: 'verify the earlier answer' }] });
      return { finalText: 'D'.repeat(500) };
    });
  };

  it("the research rung's lead AND its colleagues run under runDeadlineMs ≤ depthBudgetMaxBackgroundMs() (15 min default); the lead carries NO USD hook (owner 2026-09-27: no hidden cost caps)", async () => {
    driveOneDispatch();
    await researchEscalation('chat-h2-rung');
    const lead = agentMock.mock.calls.at(-1)![0];
    // the budget is clocked from the tap: the lead gets what is LEFT of it once its context is built (ms of setup here)
    expect(lead.profile.runDeadlineMs).toBeLessThanOrEqual(depthBudgetMaxBackgroundMs());
    expect(lead.profile.runDeadlineMs).toBeGreaterThan(depthBudgetMaxBackgroundMs() - 5_000);
    expect(lead.profile.runDeadlineMs).toBeLessThan(COUNCIL_LEAD_BACKSTOP_MS);
    expect(lead.forceFinalTurn).toBeUndefined(); // a Dig-deeper rung is never ended on cost
    const colleague = workerMock.mock.calls.at(-1)![0];
    expect(colleague.profile.runDeadlineMs).toBeLessThanOrEqual(depthBudgetMaxBackgroundMs());
    expect(colleague.profile.runDeadlineMs).toBeGreaterThanOrEqual(60_000);
    expect(colleague.profile.runDeadlineMs).toBeLessThan(COUNCIL_COLLEAGUE_BACKSTOP_MS);
  });

  it('DEPTH_BUDGET_MAX_BACKGROUND_MS is the operator knob: a 5-minute budget bounds the rung at 5 minutes', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '300000';
    try {
      driveOneDispatch();
      await researchEscalation('chat-h2-knob');
      expect(agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBeLessThanOrEqual(300_000);
      expect(agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBeGreaterThan(295_000);
      expect(workerMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBeLessThanOrEqual(300_000);
    } finally { delete process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS; }
  });

  it('the Level 3 PRESET council: the lead keeps its 40-min backstop (no forceFinalTurn); a colleague is FITTED inside the 12-min dispatch wait (9 min — 2026-10-20: the 30-min backstop guaranteed a timeout + restart)', async () => {
    driveOneDispatch();
    await runTurn({ mode: 'deep_research', chatId: 'chat-h2-preset', userTurnAt: new Date() });
    const lead = agentMock.mock.calls.at(-1)![0];
    expect(lead.profile.runDeadlineMs).toBe(COUNCIL_LEAD_BACKSTOP_MS);
    expect(lead.forceFinalTurn).toBeUndefined();
    expect(workerMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(COUNCIL_PRESET_COLLEAGUE_FIT_MS);
  });

  it('a clone a preset colleague spawns is bounded by what is LEFT of its parent (minus room for the parent\'s final turn) and inherits the attempt\'s cancel latch', async () => {
    driveOneDispatch();
    workerMock.mockImplementationOnce(async (input: any) => {
      const spawn = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'spawn_self');
      if (spawn) await spawn.execute({ subtask: 'one parallel leg' });
      return { finalText: 'COLLEAGUE REPORT ' + 'x'.repeat(300) };
    });
    await runTurn({ mode: 'deep_research', chatId: 'chat-h2-clone', userTurnAt: new Date() });
    const calls = workerMock.mock.calls.map(([i]: any[]) => i);
    const parent = calls.find((i: any) => (i.extraTools || []).some((t: any) => t?.schema?.function?.name === 'spawn_self'));
    const clone = calls.find((i: any) => i !== parent && !(i.extraTools || []).some((t: any) => t?.schema?.function?.name === 'spawn_self'));
    expect(parent.profile.runDeadlineMs).toBe(COUNCIL_PRESET_COLLEAGUE_FIT_MS);
    expect(clone).toBeTruthy();
    expect(clone.profile.runDeadlineMs).toBeLessThanOrEqual(COUNCIL_PRESET_COLLEAGUE_FIT_MS - 90_000);
    expect(clone.profile.runDeadlineMs).toBeGreaterThan(COUNCIL_PRESET_COLLEAGUE_FIT_MS - 90_000 - 5_000);
    expect(typeof clone.isCancelled).toBe('function');
    expect(clone.isCancelled()).toBe(false);
  });

  it('a colleague with too little deadline left gets NO clone (spawn refused, not floored past its parent) — re-review 2026-10-20', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000'; // the rung colleague's deadline floors at 60 s: < 90 s margin + 60 s
    try {
      driveOneDispatch();
      let spawnAnswer = '';
      workerMock.mockImplementationOnce(async (input: any) => {
        const spawn = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'spawn_self');
        if (spawn) spawnAnswer = await spawn.execute({ subtask: 'one parallel leg' });
        return { finalText: 'COLLEAGUE REPORT ' + 'x'.repeat(300) };
      });
      const before = workerMock.mock.calls.length;
      await researchEscalation('chat-h2-clone-refused');
      expect(spawnAnswer).toMatch(/Not enough time left/);
      expect(workerMock.mock.calls.length - before).toBe(1); // the colleague only — no clone run
    } finally { delete process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS; }
  });

  it('COUNCIL_PRESET_COLLEAGUE_FIT_DISABLED=1 restores the preset colleague\'s plain 30-min backstop', async () => {
    process.env.COUNCIL_PRESET_COLLEAGUE_FIT_DISABLED = '1';
    try {
      driveOneDispatch();
      await runTurn({ mode: 'deep_research', chatId: 'chat-h2-preset-off', userTurnAt: new Date() });
      expect(agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(COUNCIL_LEAD_BACKSTOP_MS);
      expect(workerMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(COUNCIL_COLLEAGUE_BACKSTOP_MS);
    } finally { delete process.env.COUNCIL_PRESET_COLLEAGUE_FIT_DISABLED; }
  });

  it('DEPTH_BUDGET_DISABLED=1 restores the previous research-rung behaviour (the preset\'s: lead backstop, no hook, colleague fitted to the dispatch wait)', async () => {
    process.env.DEPTH_BUDGET_DISABLED = '1';
    driveOneDispatch();
    await researchEscalation('chat-h2-off-rung');
    const lead = agentMock.mock.calls.at(-1)![0];
    expect(lead.profile.runDeadlineMs).toBe(COUNCIL_LEAD_BACKSTOP_MS);
    expect(lead.forceFinalTurn).toBeUndefined();
    expect(workerMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(COUNCIL_PRESET_COLLEAGUE_FIT_MS);
  });
});

// ── 2026-10-20: deep research has NO wall clock (owner: "deep research shouldn't have any limit") ──
describe('deep research has NO wall clock (2026-10-20, council-dispatch.ts researchNoWallClock)', () => {
  const STALL_DEFAULT_MS = 10 * 60_000;
  const cpRow = () => mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).filter((m: any) => m.kind === 'compute_policy').at(-1);
  const researchEscalation = (chatId: string) => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-nwc' ? { id: 'orig-nwc', chatId, metadata: { mode: 'thinking' } } : null);
    return runTurn({ mode: 'deep_research', chatId, escalation: { ofMessageId: 'orig-nwc', rung: 'research' }, userTurnAt: new Date() });
  };
  const driveOneDispatch = () => {
    agentMock.mockImplementationOnce(async (input: any) => {
      const dispatch = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'dispatch_colleagues');
      if (dispatch) await dispatch.execute({ tasks: [{ model: 'double_checker', mission: 'go deep on the question' }] });
      return { finalText: 'D'.repeat(500) };
    });
  };
  afterEach(() => { mockPrisma.crossModelMessage.findUnique = jest.fn(async () => null); });

  it('the L3 PRESET: lead and colleague carry NO final-turn deadline and the token-idle stream stall watchdog instead; the step caps stay the termination guarantee', async () => {
    driveOneDispatch();
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-preset', userTurnAt: new Date() });
    const lead = agentMock.mock.calls.at(-1)![0];
    expect(lead.profile.runDeadlineMs).toBeUndefined();
    expect(lead.profile.streamStallMs).toBe(STALL_DEFAULT_MS);
    expect(lead.profile.maxSteps).toBe(24);
    expect(lead.forceFinalTurn).toBeUndefined();
    const colleague = workerMock.mock.calls.at(-1)![0];
    expect(colleague.profile.runDeadlineMs).toBeUndefined();
    expect(colleague.profile.streamStallMs).toBe(STALL_DEFAULT_MS);
    expect(colleague.profile.maxSteps).toBe(16);
  });

  it('the Dig-deeper RESEARCH rung: even a 1-min DepthBudget bounds nothing; the compute_policy row stamps backgroundBoundMs null / source disabled and never a backgroundTimeout', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000';
    driveOneDispatch();
    await researchEscalation('chat-nwc-rung');
    const lead = agentMock.mock.calls.at(-1)![0];
    expect(lead.profile.runDeadlineMs).toBeUndefined();
    expect(lead.profile.streamStallMs).toBe(STALL_DEFAULT_MS);
    const colleague = workerMock.mock.calls.at(-1)![0];
    expect(colleague.profile.runDeadlineMs).toBeUndefined();
    expect(cpRow().meta).toMatchObject({ escalationRung: 'research', backgroundBoundMs: null, backgroundBoundSource: 'disabled' });
    expect(cpRow().meta.backgroundTimeout).toBeUndefined();
    // the rung's colleague fit (one fitted attempt inside the budget) is gone too
    expect(mockRecordLoopMetric.mock.calls.some((c: any) => c[0]?.kind === 'council_rung_fit')).toBe(false);
  });

  it('a clone is unbounded too: spawn_self is never refused for time, and the clone runs unclocked with the watchdog and its 8-step cap', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000'; // under the old clocks this refused the clone ("Not enough time left")
    driveOneDispatch();
    let spawnAnswer = '';
    workerMock.mockImplementationOnce(async (input: any) => {
      const spawn = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'spawn_self');
      if (spawn) spawnAnswer = await spawn.execute({ subtask: 'one parallel leg' });
      return { finalText: 'COLLEAGUE REPORT ' + 'x'.repeat(300) };
    });
    await researchEscalation('chat-nwc-clone');
    expect(spawnAnswer).not.toMatch(/Not enough time left/);
    const calls = workerMock.mock.calls.map(([i]: any[]) => i);
    const parent = calls.find((i: any) => (i.extraTools || []).some((t: any) => t?.schema?.function?.name === 'spawn_self'));
    const clone = calls.find((i: any) => i !== parent && !(i.extraTools || []).some((t: any) => t?.schema?.function?.name === 'spawn_self'));
    expect(clone).toBeTruthy();
    expect(parent.profile.runDeadlineMs).toBeUndefined();
    expect(clone.profile.runDeadlineMs).toBeUndefined();
    expect(clone.profile.streamStallMs).toBe(STALL_DEFAULT_MS);
    expect(clone.profile.maxSteps).toBe(8);
    expect(typeof clone.isCancelled).toBe('function'); // still inherits the attempt's cancel latch
  });

  it('COUNCIL_STALL_MS is the ops knob for the watchdog (clamped 2..60 min; garbage ⇒ the default)', async () => {
    process.env.COUNCIL_STALL_MS = '300000';
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-knob', userTurnAt: new Date() });
    expect(agentMock.mock.calls.at(-1)![0].profile.streamStallMs).toBe(300_000);
    process.env.COUNCIL_STALL_MS = '5';
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-knob-lo', userTurnAt: new Date() });
    expect(agentMock.mock.calls.at(-1)![0].profile.streamStallMs).toBe(2 * 60_000);
    process.env.COUNCIL_STALL_MS = 'soon';
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-knob-bad', userTurnAt: new Date() });
    expect(agentMock.mock.calls.at(-1)![0].profile.streamStallMs).toBe(STALL_DEFAULT_MS);
  });

  it('the live run is stamped a research council with progress beats (the deploy drain reads both); a plain turn is not', async () => {
    let meta: any = null;
    let beat: number | null = null;
    agentMock.mockImplementationOnce(async () => {
      meta = getRunMeta(chatAgentRunKey({ chatId: 'chat-nwc-live' }));
      beat = runLastProgressAt(chatAgentRunKey({ chatId: 'chat-nwc-live' }));
      return { finalText: 'D'.repeat(500) };
    });
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-live', userTurnAt: new Date() });
    expect(meta).toMatchObject({ isResearchCouncil: true });
    expect(typeof beat).toBe('number');
    agentMock.mockImplementationOnce(async () => {
      meta = getRunMeta(chatAgentRunKey({ chatId: 'chat-nwc-plain' }));
      beat = runLastProgressAt(chatAgentRunKey({ chatId: 'chat-nwc-plain' }));
      return { finalText: 'D'.repeat(500) };
    });
    await runTurn({ mode: 'thinking', chatId: 'chat-nwc-plain' });
    expect(meta?.isResearchCouncil).toBeUndefined();
    expect(beat).toBeNull();
  });

  it('a council whose every colleague came back empty says they STALLED or failed — never "within its time budget"', async () => {
    driveOneDispatch();
    workerMock.mockImplementation(async () => ({ finalText: '', parts: [] }));
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-degraded', userTurnAt: new Date() });
    const row = mockPrisma.crossModelMessage.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.role === 'assistant').at(-1);
    expect(String(row?.content)).toContain('Degraded research run: the deep-research council');
    expect(String(row?.content)).toContain('every colleague stalled or failed');
    expect(String(row?.content)).not.toContain('within its time budget');
  });

  it('RESEARCH_NO_WALL_CLOCK_DISABLED=1 restores today\'s clocks byte-for-byte: preset lead 40 min, colleague fitted 9 min, no watchdog key at all', async () => {
    process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1';
    let meta: any = null;
    agentMock.mockImplementationOnce(async (input: any) => {
      meta = getRunMeta(chatAgentRunKey({ chatId: 'chat-nwc-off' }));
      const dispatch = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'dispatch_colleagues');
      if (dispatch) await dispatch.execute({ tasks: [{ model: 'double_checker', mission: 'go deep' }] });
      return { finalText: 'D'.repeat(500) };
    });
    workerMock.mockImplementation(async () => ({ finalText: '', parts: [] }));
    await runTurn({ mode: 'deep_research', chatId: 'chat-nwc-off', userTurnAt: new Date() });
    const lead = agentMock.mock.calls.at(-1)![0];
    expect(lead.profile.runDeadlineMs).toBe(40 * 60_000);
    expect('streamStallMs' in lead.profile).toBe(false);
    const colleague = workerMock.mock.calls.at(-1)![0];
    expect(colleague.profile.runDeadlineMs).toBe(9 * 60_000);
    expect('streamStallMs' in colleague.profile).toBe(false);
    expect(meta?.isResearchCouncil).toBeUndefined();
    const row = mockPrisma.crossModelMessage.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.role === 'assistant').at(-1);
    expect(String(row?.content)).toContain('returned no report within its time budget');
  });
});

// ── cp/labels (2026-09-26): the finalize `facts` label + the reask_5m hook ──
describe('compute-policy labels — the finalize facts row and the reask hook', () => {
  it('a human turn with a gate decision writes ONE facts label (harness facts, requested preset, ttft / completion / spend / council / pill) and persists metadata.depth.facts; the reask hook fires before the user row with sentAt', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'shadow';
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), source: 'gate_shadow', mode: 'shadow', decisionId: 'cp-facts', answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.7 } }, reason: 'shadow' });
    agentMock.mockImplementation(async () => ({ finalText: 'B'.repeat(400), parts: [{ type: 'tool_call', name: 'web_search' } as any] }));
    const userRowAt = Date.now();
    await runTurn({ mode: 'thinking', chatId: 'chat-facts-label' });
    // the facts label — once, through the adapter, with what the harness measured
    expect(mockLabelFacts).toHaveBeenCalledTimes(1);
    const call = mockLabelFacts.mock.calls[0][0];
    expect(call).toMatchObject({
      decisionStash: { id: 'cp-facts', mode: 'shadow' }, requestedPreset: 'thinking', acted: false, failed: false, sessionId: 'chat-facts-label',
      facts: { leadToolCalls: 1, finalChars: 400, checkerSpawned: true },
      turn: { council: 'none' },
    });
    expect(typeof call.turn.completionMs).toBe('number');
    expect(call.escalatable).toBe(true); // audit 2026-09-26: a plain human turn shows the Dig-deeper chip — its facts row may be the ruler's window-closed negative
    // the same facts persist on the row for the later labels
    expect(persistedMeta().depth.facts).toMatchObject({ leadToolCalls: 1, finalChars: 400, checkerSpawned: true });
    expect(persistedMeta().depth.decision).toMatchObject({ id: 'cp-facts' });
    // the reask hook: the chat, the human author, a sentAt captured before the user row persisted
    expect(mockLabelReask).toHaveBeenCalledTimes(1);
    expect(mockLabelReask.mock.calls[0][0]).toMatchObject({ chatId: 'chat-facts-label', authorId: 'u1', sessionId: 'chat-facts-label' });
    expect(mockLabelReask.mock.calls[0][0].sentAt.getTime()).toBeGreaterThanOrEqual(userRowAt);
    expect(mockLabelReask.mock.calls[0][0].sentAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('audit 2026-09-26 (guest-persistence-2): a GUEST turn with a gate decision writes the facts label too, stamped guest + segment (it used to sit inside the chatId branch)', async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'shadow';
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), source: 'gate_shadow', mode: 'shadow', decisionId: 'cp-guest', answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.7 } }, reason: 'shadow' });
    agentMock.mockImplementation(async () => ({ finalText: 'G'.repeat(300), parts: [] }));
    await runTurn({ mode: 'thinking', userId: null, chatId: null, sessionId: 'guest-facts-1' });
    expect(mockLabelFacts).toHaveBeenCalledTimes(1);
    expect(mockLabelFacts.mock.calls[0][0]).toMatchObject({ decisionStash: { id: 'cp-guest' }, guest: true, segment: 'guest', sessionId: 'anon-guest-facts-1' });
  });

  it("audit 2026-09-26 (routing-unify-9): the synthesis status line follows the PLAN — a gate_act plan that dropped the checker on the L2 preset says 'writing your answer', one that added it on L1 says 'digging in'", async () => {
    process.env.DECISION_GATE_MODE_COMPUTE_POLICY = 'act';
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), spawnChecker: false, source: 'gate_act', mode: 'act', decisionId: 'cp-drop' });
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(300), parts: [] }));
    const dropped = await runTurn({ mode: 'thinking', chatId: 'chat-status-drop' });
    const synthLines = (evs: typeof dropped.events) => evs.filter(e => e.type === 'progress' && e.data?.stage === 'synthesis' && !e.data?.key).map(e => String(e.data?.message));
    expect(synthLines(dropped.events).some(m => /writing your answer/.test(m))).toBe(true);
    expect(synthLines(dropped.events).some(m => /digging in/.test(m))).toBe(false); // the L2 preset's line never shows for a dropped checker
    expect(workerMock).not.toHaveBeenCalled();
    mockPlan.mockResolvedValue({ ...presetPlan('single_thinking'), spawnChecker: true, source: 'gate_act', mode: 'act', decisionId: 'cp-add' });
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    const added = await runTurn({ mode: 'single_thinking', chatId: 'chat-status-add' });
    expect(synthLines(added.events).some(m => /digging in/.test(m))).toBe(true);
    expect(synthLines(added.events).some(m => /writing your answer/.test(m))).toBe(false); // the L1 preset's line never shows for an added checker
  }, 30_000);

  it('no decision (preset turn, gate off) ⇒ no facts label; a machine wake ⇒ neither the facts label nor the reask hook', async () => {
    mockPlan.mockResolvedValue(presetPlan('thinking'));
    await runTurn({ mode: 'thinking', chatId: 'chat-no-decision' });
    expect(mockLabelFacts).not.toHaveBeenCalled();
    expect(mockLabelReask).toHaveBeenCalledTimes(1); // a human turn still runs the reask hook (it labels the PREVIOUS answer)
    mockLabelReask.mockClear();
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), decisionId: 'cp-machine', answers: { depth: { type: 'choice', choice: 'ordinary' } } });
    await runTurn({ mode: 'thinking', chatId: 'chat-machine', machineWake: true, messageOrigin: 'schedule' });
    expect(mockLabelFacts).not.toHaveBeenCalled();
    expect(mockLabelReask).not.toHaveBeenCalled();
  });

  it('audit 2026-09-26 (telemetry-readiness-9): a HUMAN turn in a supervisor chat labels its facts with escalatable:false (the chip is disabled there ⇒ no escalated:true can ever pair ⇒ Module B tags the row excludeFromFit)', async () => {
    const answers = { depth: { type: 'choice', choice: 'ordinary', confidence: 0.7 } };
    // SHADOW: the plan lands LATE (after the preset ran) — the segment + stash must still reach the persisted compact decision and the label.
    mockPlan.mockResolvedValue({ ...presetPlan('thinking'), source: 'gate_shadow', mode: 'shadow', decisionId: 'cp-sup-human', answers, segment: 'supervisor', stash: { id: 'cp-sup-human', purpose: 'compute_policy', mode: 'shadow', backend: 'TypeSafe Jev', answers, decidedAt: 'now', segment: 'supervisor' }, reason: 'shadow' });
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    try {
      await runTurn({ mode: 'thinking', chatId: 'chat-sup-human-facts', userTurnAt: new Date() }, 15_000);
      expect(mockLabelFacts).toHaveBeenCalledTimes(1);
      expect(mockLabelFacts.mock.calls[0][0]).toMatchObject({ decisionStash: { id: 'cp-sup-human', segment: 'supervisor' }, escalatable: false });
      expect(persistedMeta().depth.decision).toMatchObject({ id: 'cp-sup-human', mode: 'shadow', segment: 'supervisor' });
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    }
  });
});

describe('DepthBudget.maxBackgroundMs reaches the background deadlines (audit 2026-09-26, settings-switches-5 — the knob used to be stamped on every row and enforced nowhere) — the research-rung legs under RESEARCH_NO_WALL_CLOCK_DISABLED=1', () => {
  // The checker legs are unaffected by the switch; the research-rung legs pin the clocks the switch restores.
  beforeEach(() => { process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1'; });
  afterEach(() => { delete process.env.RESEARCH_NO_WALL_CLOCK_DISABLED; });
  const COUNCIL_LEAD_BACKSTOP_MS = 40 * 60_000;
  const cpRow = () => mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).filter((m: any) => m.kind === 'compute_policy').at(-1);

  it('DEPTH_BUDGET_MAX_BACKGROUND_MS=60000: the Double Checker worker runs under a 60 s deadline (below its 300 s self-wrap), the late reconcile waits at most 60 s, and the compute_policy row names the bound', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000';
    const checker = deferred<any>();
    workerMock.mockImplementation(() => checker.promise);
    // (the finalize keeps today's CROSS_CHECK_LATE_WAIT_MS = 10 s grace for a draft about to land)
    await runTurn({ mode: 'thinking', chatId: 'chat-bg-60' }, 15_000);
    expect(checkerCalls()).toHaveLength(1);
    expect(checkerCalls()[0][0].profile.runDeadlineMs).toBe(60_000);
    await waitFor(() => mockRunLate.mock.calls.length > 0);
    expect(mockRunLate.mock.calls[0][0]).toMatchObject({ maxWaitMs: 60_000, boundSource: 'depth_budget' });
    expect(cpRow().meta).toMatchObject({ budget: { maxBackgroundMs: 60_000 }, backgroundBoundMs: 60_000, backgroundBoundSource: 'depth_budget' });
    expect(cpRow().meta.backgroundTimeout).toBeUndefined();
    checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
  }, 20_000);

  it('DEPTH_BUDGET_MAX_BACKGROUND_MS=60000: the Dig-deeper research rung\'s council lead runs under a 60 s runDeadlineMs (the FINAL-TURN mechanism) and its row names the lead bound; a preset Level 3 lead keeps the 40-min backstop', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000';
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-bg' ? { id: 'orig-bg', chatId: 'chat-bg-esc', metadata: { mode: 'thinking' } } : null);
    await runTurn({ mode: 'deep_research', chatId: 'chat-bg-esc', escalation: { ofMessageId: 'orig-bg', rung: 'research' }, userTurnAt: new Date() });
    expect(agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(60_000);
    expect(cpRow().meta).toMatchObject({ escalationRung: 'research', backgroundBoundMs: 60_000, backgroundBoundSource: 'depth_budget' });
    mockPrisma.crossModelMessage.findUnique = jest.fn(async () => null);
    await runTurn({ mode: 'deep_research', chatId: 'chat-bg-l3', userTurnAt: new Date() });
    expect(agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(COUNCIL_LEAD_BACKSTOP_MS);
  });

  it('defaults (env unset): the checker keeps its 300 s self-wrap and 15-min harness kill (the knob equals the cap ⇒ source cap), the research rung lead is bounded to the 15-min design default', async () => {
    const checker = deferred<any>();
    workerMock.mockImplementation(() => checker.promise);
    await runTurn({ mode: 'thinking', chatId: 'chat-bg-default' }, 15_000);
    expect(checkerCalls()[0][0].profile.runDeadlineMs).toBe(CROSS_CHECK_SOFT_MS);
    await waitFor(() => mockRunLate.mock.calls.length > 0);
    expect(mockRunLate.mock.calls[0][0]).toMatchObject({ maxWaitMs: CROSS_CHECK_HARD_MS, boundSource: 'cap' });
    expect(cpRow().meta).toMatchObject({ backgroundBoundMs: CROSS_CHECK_HARD_MS, backgroundBoundSource: 'cap' });
    checker.resolve({ finalText: 'PEER-DRAFT', parts: [] });
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-bg-d' ? { id: 'orig-bg-d', chatId: 'chat-bg-esc-d', metadata: { mode: 'thinking' } } : null);
    await runTurn({ mode: 'deep_research', chatId: 'chat-bg-esc-d', escalation: { ofMessageId: 'orig-bg-d', rung: 'research' }, userTurnAt: new Date() });
    // the research rung's rail is elapsed-aware (what is LEFT of the budget at dispatch — researchRungDeadlineMs), so the lead lands within a few ms of the 15-min design default
    const leadMs = agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs;
    expect(leadMs).toBeLessThanOrEqual(15 * 60_000);
    expect(leadMs).toBeGreaterThan(15 * 60_000 - 5_000);
    // the row's bound and the lead's deadline are both elapsed-aware but stamped a few ms apart — assert the same
    // budget within a 100 ms tolerance rather than byte-equality (CI 2026-09-27: 899,999 vs 900,000).
    expect(cpRow().meta.backgroundBoundSource).toBe('depth_budget');
    expect(Math.abs(cpRow().meta.backgroundBoundMs - leadMs)).toBeLessThanOrEqual(100);
  }, 20_000);

  it('kill switch DEPTH_BUDGET_DISABLED=1: the caps alone — research lead 40 min, source disabled', async () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000';
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    // the research rung spawns no checker — a fast run
    for (const flag of ['DEPTH_BUDGET_DISABLED'] as const) {
      delete process.env.DEPTH_BUDGET_DISABLED;
      process.env[flag] = '1';
      mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => where.id === 'orig-off' ? { id: 'orig-off', chatId: `chat-bg-esc-off-${flag}`, metadata: { mode: 'thinking' } } : null);
      await runTurn({ mode: 'deep_research', chatId: `chat-bg-esc-off-${flag}`, escalation: { ofMessageId: 'orig-off', rung: 'research' }, userTurnAt: new Date() });
      expect(agentMock.mock.calls.at(-1)![0].profile.runDeadlineMs).toBe(COUNCIL_LEAD_BACKSTOP_MS);
      expect(cpRow().meta).toMatchObject({ backgroundBoundMs: COUNCIL_LEAD_BACKSTOP_MS, backgroundBoundSource: 'disabled' });
    }
  }, 25_000);

  it('the deadline firing is stamped: a Double Checker card carrying the cross-check deadline error marks the compute_policy row backgroundTimeout', async () => {
    workerMock.mockImplementation(async () => { throw new Error('cross-check deadline (DepthBudget.maxBackgroundMs 60s)'); });
    await runTurn({ mode: 'thinking', chatId: 'chat-bg-timeout' });
    expect(cpRow().meta.backgroundTimeout).toBe(true);
  });
});

describe('dynamic roster — the turn plan + the QUICK lane (phase 2, 2026-10-03)', () => {
  const quickPlan = (act: boolean) => ({
    lane: 'quick', act, mode: act ? 'act' : 'shadow', reason: 'lane quick (p 0.82, both orders); quick eligible',
    decisionId: 'tp-1', backend: 'TypeSafe Jev',
    cls: { lane: 'quick', laneProbs: { quick: 0.82, standard: 0.1, checked: 0.05, research: 0.03 }, laneConfidence: 0.82, laneAveraged: true, needsLiveWeb: 0.9, stakes: 0.05, contested: 0.02, multiStep: 0.1, breadth: 1, followUp: null },
    roster: { lead: 'cql:q-flash', leadPool: 'quick', checker: null, colleagues: [], reason: 'lane quick' },
    stash: { id: 'tp-1', purpose: 'turn_plan', mode: act ? 'act' : 'shadow', backend: 'TypeSafe Jev', answers: {}, decidedAt: 'x' },
  });
  beforeEach(() => {
    delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    delete process.env.QUICK_LANE_DISABLED;
    delete process.env.TURN_PLAN_DISABLED;
    mockTurnPlan.mockReset();
    mockTurnPlan.mockImplementation(async () => null);
    mockCanary.mockReset();
    mockCanary.mockImplementation(async () => false);
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
  });

  it('SHADOW: asked once per human turn, never applied — the preset lead runs and the Level 2 checker still spawns', async () => {
    mockTurnPlan.mockImplementation(async () => quickPlan(false));
    await runTurn({ mode: 'thinking' });
    expect(mockTurnPlan).toHaveBeenCalledTimes(1);
    expect(mockTurnPlan.mock.calls[0][1]).toMatchObject({ mode: 'thinking', requestedMode: 'thinking', escalation: false, machine: false });
    const call = agentMock.mock.calls[0][0];
    expect(call.model).not.toBe('cql:q-flash');
    expect(call.seatRole).toBe('chat_orchestrator');
    expect(call.fastSeat).toBeUndefined();
    expect(checkerCalls().length).toBe(1);
  });

  it('build 2026-10-08 A2b: the run carries the plan ALREADY asked as a toolLaneHint getter — even a shadow (never awaited) plan; no second ask', async () => {
    mockTurnPlan.mockImplementation(async () => quickPlan(false));
    await runTurn({ mode: 'thinking' });
    expect(mockTurnPlan).toHaveBeenCalledTimes(1);
    const getter = agentMock.mock.calls[0][0].toolLaneHint;
    expect(typeof getter).toBe('function');
    expect(getter()).toEqual({ lane: 'quick', needsLiveWeb: 0.9 });
    expect(mockTurnPlan).toHaveBeenCalledTimes(1);
    // a plan with no classification (the gate did not answer) is no hint
    agentMock.mockClear();
    mockTurnPlan.mockImplementation(async () => ({ ...quickPlan(false), lane: 'checked', cls: null }));
    await runTurn({ mode: 'thinking' });
    expect(agentMock.mock.calls[0][0].toolLaneHint()).toBeNull();
  });

  it('ACT: a confident quick plan runs the Quick answers seat — fast shape, quick profile, no checker even on a Level 2 send', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan(true));
    const { events } = await runTurn({ mode: 'thinking' });
    const call = agentMock.mock.calls[0][0];
    expect(call).toMatchObject({ model: 'cql:q-flash', seatRole: 'chat_quick', fastSeat: true });
    expect(call.profile).toMatchObject({ maxSteps: 4, maxDelegations: 0, runDeadlineMs: 120_000 });
    expect(checkerCalls().length).toBe(0);
    expect(events.some(e => e.type === 'progress' && /Quick answer/.test(String(e.data?.message)))).toBe(true);
  });

  it('ACT: the Quick lane runs with its brief (one search, answer from it) appended to the chat doctrine; a preset turn never carries it', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan(true));
    await runTurn({ mode: 'thinking' });
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).toMatch(/## Quick answer lane \(this turn\)[\s\S]*At most ONE search_engine call/);
    agentMock.mockClear();
    mockTurnPlan.mockImplementation(async () => quickPlan(false));
    await runTurn({ mode: 'thinking' });
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/Quick answer lane/);
  });

  it('QUICK_LANE_BRIEF_DISABLED=1: the Quick lane runs on the plain chat doctrine', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    process.env.QUICK_LANE_BRIEF_DISABLED = '1';
    try {
      mockTurnPlan.mockImplementation(async () => quickPlan(true));
      await runTurn({ mode: 'thinking' });
      expect(agentMock.mock.calls[0][0]).toMatchObject({ seatRole: 'chat_quick' });
      expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/Quick answer lane/);
    } finally {
      delete process.env.QUICK_LANE_BRIEF_DISABLED;
    }
  });

  it('FIRST-WORD OPENER (ticket 4f7263e4): a human plain-chat turn carries the first-word note; a Quick-lane turn carries the QUICK variant (afc10e95); a machine wake and the kill switch carry neither', async () => {
    // Default human turn (preset plan, not Quick): the note rides the doctrine's cross-check slot.
    await runTurn({ mode: 'thinking' });
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).toMatch(/## First word[\s\S]*OPEN WITH ONE USEFUL LINE before your first tool call/);
    // Quick lane (afc10e95: quick-ran turns chained 2-4 web calls before the first word —
    // p50 53.4s vs the 45s bar): the quick variant rides instead — one line before the
    // FIRST SEARCH, naming the lane's one-search budget so the two notes agree.
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan(true));
    agentMock.mockClear();
    await runTurn({ mode: 'thinking' });
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).toMatch(/## First word \(this turn — Quick lane\)/);
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).toMatch(/OPEN WITH ONE LINE before your first search/);
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/OPEN WITH ONE USEFUL LINE before your first tool call/);
    // Machine wake: the note never rides a machine doctrine (wake-note shape is load-bearing).
    agentMock.mockClear();
    mockTurnPlan.mockImplementation(async () => presetPlan('thinking'));
    await runTurn({ mode: 'thinking', machineWake: true, messageOrigin: 'schedule' });
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/## First word/);
    // Kill switch: the note is removed everywhere (both variants).
    delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    process.env.FIRST_WORD_OPENER_DISABLED = '1';
    agentMock.mockClear();
    try {
      await runTurn({ mode: 'thinking' });
      expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/## First word/);
      mockTurnPlan.mockImplementation(async () => quickPlan(true));
      process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
      agentMock.mockClear();
      await runTurn({ mode: 'thinking' });
      expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/## First word/);
    } finally {
      delete process.env.FIRST_WORD_OPENER_DISABLED;
      delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    }
  });

  it('ACT on a chat row: metadata.depth.turnPlan records act + roster, and the plan carries lane quick', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan(true));
    const prevFindMany = mockPrisma.crossModelMessage.findMany;
    const prevFindFirst = mockPrisma.crossModelMessage.findFirst;
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => null);
    try {
      await runTurn({ mode: 'thinking', chatId: 'chat-quick-1' }, 15_000);
      const depth = persistedMeta()?.depth;
      expect(depth?.plan).toMatchObject({ preset: 'single_thinking', spawnChecker: false, lane: 'quick' });
      expect(depth?.turnPlan).toMatchObject({ lane: 'quick', act: true, decisionId: 'tp-1', roster: { lead: 'cql:q-flash', leadPool: 'quick' } });
    } finally {
      mockPrisma.crossModelMessage.findMany = prevFindMany;
      mockPrisma.crossModelMessage.findFirst = prevFindFirst;
    }
  }, 20_000);

  it('ACT but the quick model is unservable here: the preset stands (honest log, no throw)', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan(true));
    (seatUnservableReason as jest.Mock).mockImplementation(async (m: string) => (m === 'cql:q-flash' ? 'endpoint disabled' : null));
    try {
      await runTurn({ mode: 'thinking' });
      expect(agentMock.mock.calls[0][0].model).not.toBe('cql:q-flash');
      expect(checkerCalls().length).toBe(1);
    } finally {
      (seatUnservableReason as jest.Mock).mockImplementation(async () => null);
    }
  });

  it('CANARY (2026-10-03 hardening): purpose still SHADOW, a canary user\'s eligible quick plan runs the Quick lane; the ux_ttft row carries the lane', async () => {
    mockCanary.mockImplementation(async (u: string) => u === 'u1');
    mockTurnPlan.mockImplementation(async () => ({ ...quickPlan(true), canary: true, mode: 'shadow' }));
    await runTurn({ mode: 'thinking' });
    expect(mockCanary).toHaveBeenCalledWith('u1');
    expect(agentMock.mock.calls[0][0]).toMatchObject({ model: 'cql:q-flash', seatRole: 'chat_quick', fastSeat: true });
    expect(checkerCalls().length).toBe(0);
    const ttft = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r.kind === 'ux_ttft');
    expect(ttft?.meta).toMatchObject({ lane: 'quick', leadModel: 'cql:q-flash' });
  });

  it('the turn plan gets the code-intent flag and the sender', async () => {
    mockTurnPlan.mockImplementation(async () => quickPlan(false));
    await runTurn({ mode: 'thinking', message: 'Fix the failing test in tests/auth.spec.ts' });
    expect(mockTurnPlan.mock.calls[0][0]).toMatchObject({ userId: 'u1' });
    expect(mockTurnPlan.mock.calls[0][1]).toMatchObject({ codeIntent: true });
  });

  it('a QUICK-lane turn whose quick model returns nothing is finished on the Digby seat (the normal lead), flagged lane quick', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan(true));
    agentMock.mockImplementation(async (i: any) => ({ finalText: i.model === 'cql:q-flash' ? '' : 'B'.repeat(400), parts: [] }));
    await runTurn({ mode: 'thinking' });
    const models = agentMock.mock.calls.map((c: any[]) => c[0].model);
    expect(models[0]).toBe('cql:q-flash');
    expect(models.at(-1)).not.toBe('cql:q-flash');
    // (this file's LOOP_METRIC_KINDS mock has no SEAT_FALLBACK key — match the row by its meta)
    const fb = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r.meta?.failedSeat === 'cql:q-flash');
    expect(fb?.meta).toMatchObject({ seat: 'chat_quick', failedSeat: 'cql:q-flash', recovered: true, lane: 'quick' });
  });

  it('never asked on a machine turn or a Dig-deeper rung; TURN_PLAN_DISABLED=1 never asks', async () => {
    await runTurn({ mode: 'thinking', machineWake: true });
    expect(mockTurnPlan).not.toHaveBeenCalled();
    process.env.TURN_PLAN_DISABLED = '1';
    await runTurn({ mode: 'thinking' });
    expect(mockTurnPlan).not.toHaveBeenCalled();
  });

  // ── roster 2026-10-06 B-1: label + telemetry hygiene ──────────────────────
  const withRows = async (fn: () => Promise<void>) => {
    const prevFindMany = mockPrisma.crossModelMessage.findMany;
    const prevFindFirst = mockPrisma.crossModelMessage.findFirst;
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => null);
    try { await fn(); } finally {
      mockPrisma.crossModelMessage.findMany = prevFindMany;
      mockPrisma.crossModelMessage.findFirst = prevFindFirst;
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
      delete process.env.TURN_PLAN_SUPERVISOR_SKIP_DISABLED;
    }
  };

  it('B-1: an owner turn on a SUPERVISOR chat never asks the turn plan — one turn_plan_hygiene row, no turnPlan on the answer row', async () => {
    await withRows(async () => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'CanLaw Supervisor', isProjectSupervisor: true, userId: 'u1', projectId: 'p1' }));
      mockTurnPlan.mockImplementation(async () => quickPlan(false));
      await runTurn({ mode: 'thinking', chatId: 'chat-sup-tp', userTurnAt: new Date() }, 15_000);
      expect(mockTurnPlan).not.toHaveBeenCalled();
      const hygiene = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'turn_plan_hygiene');
      expect(hygiene).toEqual([expect.objectContaining({ sessionId: 'chat-sup-tp', meta: { event: 'supervisor_skip', fleet: false } })]);
      expect(persistedMeta()?.depth?.turnPlan).toBeUndefined();
    });
  }, 20_000);

  it('B-1: TURN_PLAN_SUPERVISOR_SKIP_DISABLED=1 asks again — as segment supervisor, supervisor:true in the quick context, and the record stamped supervisor:true (its labels are excluded from fit)', async () => {
    await withRows(async () => {
      process.env.TURN_PLAN_SUPERVISOR_SKIP_DISABLED = '1';
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
      mockTurnPlan.mockImplementation(async () => quickPlan(false));
      await runTurn({ mode: 'thinking', chatId: 'chat-sup-tp-ks', userTurnAt: new Date() }, 15_000);
      expect(mockTurnPlan).toHaveBeenCalledTimes(1);
      expect(mockTurnPlan.mock.calls[0][0]).toMatchObject({ segment: 'supervisor' });
      expect(mockTurnPlan.mock.calls[0][1]).toMatchObject({ supervisor: true });
      expect(persistedMeta()?.depth?.turnPlan).toMatchObject({ lane: 'quick', supervisor: true });
    });
  }, 20_000);

  // Ghost mode (owner 2026-10-22): the turn plan is a CLOUD decision call carrying the message + prior turns — a
  // ghost turn never asks it. The row arm (a ghost chat) shipped with #1888 unpinned; the per-send arm (a chatId-less
  // ghost send: a guest, or the signed-in createChat-failure fallback) is the integ/ghost-composer review fix.
  it('ghost: a GHOST chat row never asks the turn plan — one turn_plan_hygiene ghost_skip row', async () => {
    await withRows(async () => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', ghostMode: true }));
      mockTurnPlan.mockImplementation(async () => quickPlan(false));
      await runTurn({ mode: 'thinking', chatId: 'chat-ghost-tp', userTurnAt: new Date() }, 15_000);
      expect(mockTurnPlan).not.toHaveBeenCalled();
      const hygiene = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'turn_plan_hygiene');
      expect(hygiene).toEqual([expect.objectContaining({ sessionId: 'chat-ghost-tp', meta: { event: 'ghost_skip' } })]);
    });
  }, 20_000);

  it('ghost (review fix): a chatId-less GHOST send (guest per-send ghost) never asks the turn plan either; CHAT_GHOST_MODE_DISABLED=1 asks it again', async () => {
    await withRows(async () => {
      mockTurnPlan.mockImplementation(async () => quickPlan(false));
      await runTurn({ mode: 'thinking', userId: null, chatId: null, sessionId: 'anon-ghost-tp', ghost: true }, 15_000);
      expect(mockTurnPlan).not.toHaveBeenCalled();
      const hygiene = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'turn_plan_hygiene');
      expect(hygiene).toEqual([expect.objectContaining({ meta: { event: 'ghost_skip' } })]);
      // a NON-ghost guest send is asked as before
      await runTurn({ mode: 'thinking', userId: null, chatId: null, sessionId: 'anon-plain-tp' }, 15_000);
      expect(mockTurnPlan).toHaveBeenCalledTimes(1);
      expect(mockTurnPlan.mock.calls[0][0]).toMatchObject({ segment: 'guest' });
      process.env.CHAT_GHOST_MODE_DISABLED = '1';
      try {
        await runTurn({ mode: 'thinking', userId: null, chatId: null, sessionId: 'anon-ghost-ks', ghost: true }, 15_000);
        expect(mockTurnPlan).toHaveBeenCalledTimes(2);
      } finally {
        delete process.env.CHAT_GHOST_MODE_DISABLED;
      }
    });
  }, 40_000);

  it('B-1: the answer row records what RAN beside the prediction — modelPick.act = the pick led (false when it did not), wouldAct = the plan\'s verdict, ran = lane / lead / checker', async () => {
    await withRows(async () => {
      // A STANDARD-lane plan whose pick would act, on a chat that never applies it (the plan purpose is shadow here ⇒ turnPlanMayAct false).
      mockTurnPlan.mockImplementation(async () => ({
        ...quickPlan(false), lane: 'standard', reason: 'lane standard',
        roster: { lead: 'seat-lead', leadPool: 'lead', checker: null, colleagues: [], reason: 'lane standard' },
        modelPick: { spec: 'glm-5.3', changed: true, act: true, mode: 'act', seat: 'seat-lead', expectedTtftMs: 11_000, reason: 'faster', ranked: [] },
      }));
      await runTurn({ mode: 'thinking', chatId: 'chat-tp-ran' }, 15_000);
      const tp = persistedMeta()?.depth?.turnPlan;
      expect(tp.modelPick).toMatchObject({ spec: 'glm-5.3', act: false, wouldAct: true });
      expect(tp.ran).toMatchObject({ lane: 'checked', checker: expect.any(String), colleagues: [] });
      expect(tp.ran.lead).toBe(agentMock.mock.calls[0][0].model);
      expect(tp.ran.lead).not.toBe('glm-5.3');
    });
  }, 20_000);

  it('B-1: a Quick-lane act row records ran.lane quick with no checker', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    await withRows(async () => {
      mockTurnPlan.mockImplementation(async () => quickPlan(true));
      await runTurn({ mode: 'thinking', chatId: 'chat-tp-ran-quick' }, 15_000);
      expect(persistedMeta()?.depth?.turnPlan).toMatchObject({ act: true, ran: { lane: 'quick', lead: 'cql:q-flash', checker: null, colleagues: [] } });
    });
  }, 20_000);
});

describe('lead-effort A/B (owner 2026-10-04)', () => {
  afterEach(() => { delete process.env.CHAT_LEAD_EFFORT_AB_SHARE; delete process.env.CHAT_LEAD_EFFORT_AB_DISABLED; });

  it("share 1: a human L2 turn's lead carries effortCap 'high' and the arm rides metadata.ux + the ux_ttft row", async () => {
    process.env.CHAT_LEAD_EFFORT_AB_SHARE = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-ab-high' });
    expect(agentMock.mock.calls[0][0]).toMatchObject({ effortCap: 'high' });
    expect(persistedMeta()?.ux).toMatchObject({ effortArm: 'high' });
  });

  it("share 0: the control arm — no cap, arm 'max' recorded", async () => {
    process.env.CHAT_LEAD_EFFORT_AB_SHARE = '0';
    await runTurn({ mode: 'thinking', chatId: 'chat-ab-max' });
    expect(agentMock.mock.calls[0][0].effortCap).toBeUndefined();
    expect(persistedMeta()?.ux).toMatchObject({ effortArm: 'max' });
  });

  it('machine wakes are never in the A/B; the kill switch removes the arm entirely', async () => {
    process.env.CHAT_LEAD_EFFORT_AB_SHARE = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-ab-wake', machineWake: true, messageOrigin: 'schedule' });
    expect(agentMock.mock.calls[0][0].effortCap).toBeUndefined();
    agentMock.mockClear();
    process.env.CHAT_LEAD_EFFORT_AB_DISABLED = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-ab-off' });
    expect(agentMock.mock.calls[0][0].effortCap).toBeUndefined();
    expect(persistedMeta()?.ux?.effortArm).toBeUndefined();
  });
});

describe('roster 2026-10-06 C-3 / C-4 — role picks + the Quick web budget at run time', () => {
  const OFF = { mode: 'off', acts: false, canary: false };
  const quickPlan = {
    lane: 'quick', act: true, mode: 'act', reason: 'lane quick', decisionId: 'tp-2', backend: 'TypeSafe Jev',
    cls: { lane: 'quick', laneProbs: { quick: 0.9, standard: 0.05, checked: 0.03, research: 0.02 }, laneConfidence: 0.9, laneAveraged: true, needsLiveWeb: 0.9, stakes: 0.05, contested: 0.02, multiStep: 0.1, breadth: 1, followUp: null },
    roster: { lead: 'cql:q-flash', leadPool: 'quick', checker: null, colleagues: [], reason: 'lane quick' }, stash: null,
  };
  const rolePick = (role: string, seat: string, spec: string) => ({ role, seat, spec, changed: spec !== seat, familyForced: false, reason: `${spec} over ${seat}`, expectedTtftMs: 10_000, seatUtility: 3, ranked: [] });
  beforeEach(() => {
    delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    delete process.env.TURN_PLAN_DISABLED; // the phase-2 block's last test leaves it set
    delete process.env.QUICK_LANE_DISABLED;
    mockTurnPlan.mockReset();
    mockTurnPlan.mockImplementation(async () => null);
    mockRolePickDecision.mockReset();
    mockRolePickDecision.mockImplementation(async () => OFF);
    mockQuickWebCapDecision.mockReset();
    mockQuickWebCapDecision.mockImplementation(async () => OFF);
    mockResolveRolePicks.mockReset();
    mockResolveRolePicks.mockImplementation(async () => null);
    mockResolveRolePicksBounded.mockReset();
    mockResolveRolePicksBounded.mockImplementation(async () => null);
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
  });

  it('ACT (or a canary user): a role-picked checker runs instead of the Double Checker seat', async () => {
    mockRolePickDecision.mockImplementation(async () => ({ mode: 'shadow', acts: true, canary: true }));
    mockResolveRolePicksBounded.mockImplementation(async (req: any) => ({ decision: { mode: 'shadow', acts: true, canary: true }, quick: null, checker: rolePick('checker', req.checker.seat, 'cql:other-checker'), colleagues: [] }));
    await runTurn({ mode: 'thinking' });
    expect(mockResolveRolePicksBounded).toHaveBeenCalledTimes(1);
    expect(mockResolveRolePicksBounded.mock.calls[0][0]).toMatchObject({ userId: 'u1', checker: { seat: expect.any(String) }, quick: null, colleagues: null });
    expect(checkerCalls().map(([i]: any[]) => i.model)).toEqual(['cql:other-checker']);
  });

  it('a role-picked checker that fails is re-run on the SEAT (fail open)', async () => {
    mockRolePickDecision.mockImplementation(async () => ({ mode: 'act', acts: true, canary: false }));
    let seat = '';
    mockResolveRolePicksBounded.mockImplementation(async (req: any) => { seat = req.checker.seat; return { decision: { mode: 'act', acts: true, canary: false }, quick: null, checker: rolePick('checker', seat, 'cql:other-checker'), colleagues: [] }; });
    workerMock.mockImplementation(async (i: any) => ({ finalText: i.model === 'cql:other-checker' ? '' : 'PEER-DRAFT', parts: [] }));
    await runTurn({ mode: 'thinking' }, 8000);
    const models = checkerCalls().map(([i]: any[]) => i.model);
    expect(models[0]).toBe('cql:other-checker');
    expect(models).toContain(seat);
    const fb = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r.meta?.failedSeat === 'cql:other-checker');
    expect(fb?.meta).toMatchObject({ seat: 'double_checker', fallbackModel: seat, rolePicked: true, customFallback: false });
  }, 15_000);

  it('SHADOW (not a canary): computed in the background only — never awaited, the seat checks', async () => {
    mockRolePickDecision.mockImplementation(async () => ({ mode: 'shadow', acts: false, canary: false }));
    await runTurn({ mode: 'thinking' });
    expect(mockResolveRolePicks).toHaveBeenCalledTimes(1);
    expect(mockResolveRolePicksBounded).not.toHaveBeenCalled();
    expect(checkerCalls().map(([i]: any[]) => i.model)).not.toContain('cql:other-checker');
  });

  it('OFF (ROLE_PICK_DISABLED=1 / store off): nothing computed', async () => {
    await runTurn({ mode: 'thinking' });
    expect(mockResolveRolePicks).not.toHaveBeenCalled();
    expect(mockResolveRolePicksBounded).not.toHaveBeenCalled();
  });

  it('never on a machine turn', async () => {
    mockRolePickDecision.mockImplementation(async () => ({ mode: 'act', acts: true, canary: false }));
    await runTurn({ mode: 'thinking', machineWake: true, messageOrigin: 'schedule' });
    expect(mockRolePickDecision).not.toHaveBeenCalled();
    expect(mockResolveRolePicksBounded).not.toHaveBeenCalled();
  });

  it('Quick lane: an acting role pick swaps the Quick model (still the fast, thinking-off shape)', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan);
    mockRolePickDecision.mockImplementation(async () => ({ mode: 'act', acts: true, canary: false }));
    mockResolveRolePicksBounded.mockImplementation(async () => ({ decision: { mode: 'act', acts: true, canary: false }, quick: rolePick('quick', 'cql:q-flash', 'deepseek-flash'), checker: null, colleagues: [] }));
    await runTurn({ mode: 'thinking' });
    expect(mockResolveRolePicksBounded.mock.calls[0][0]).toMatchObject({ quick: { seat: 'cql:q-flash' }, checker: null, lane: 'quick' });
    expect(agentMock.mock.calls[0][0]).toMatchObject({ model: 'deepseek-flash', seatRole: 'chat_quick', fastSeat: true });
    expect(checkerCalls().length).toBe(0);
  });

  it('Quick web budget ACT: the run carries webToolCaps act, the brief says it is enforced, and a quick_lane_tools row is written', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan);
    mockQuickWebCapDecision.mockImplementation(async () => ({ mode: 'shadow', acts: true, canary: true }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [{ type: 'tool_call', name: 'search_engine' }], webToolCap: { search: 1, fetch: 0, refused: 1, wouldRefuse: 0, refusedTools: ['search_engine'], mode: 'act' } }));
    await runTurn({ mode: 'thinking' });
    const call = agentMock.mock.calls[0][0];
    expect(call.webToolCaps).toEqual({ search: 1, fetch: 1, mode: 'act' });
    expect(String(call.doctrineOverride)).toMatch(/ENFORCED: a second search/);
    const row = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r.kind === 'quick_lane_tools');
    expect(row?.meta).toMatchObject({ model: 'cql:q-flash', webToolCalls: 1, budget: 'act', canary: true, refused: 1, thinkingOff: true });
  });

  it('Quick web budget SHADOW: counted (webToolCaps shadow), never announced; OFF: no budget at all; a non-Quick turn never carries one', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockTurnPlan.mockImplementation(async () => quickPlan);
    mockQuickWebCapDecision.mockImplementation(async () => ({ mode: 'shadow', acts: false, canary: false }));
    await runTurn({ mode: 'thinking' });
    expect(agentMock.mock.calls[0][0].webToolCaps).toEqual({ search: 1, fetch: 1, mode: 'shadow' });
    expect(String(agentMock.mock.calls[0][0].doctrineOverride)).not.toMatch(/ENFORCED/);
    agentMock.mockClear();
    mockQuickWebCapDecision.mockImplementation(async () => OFF);
    await runTurn({ mode: 'thinking' });
    expect(agentMock.mock.calls[0][0].webToolCaps).toBeUndefined();
    agentMock.mockClear();
    mockTurnPlan.mockImplementation(async () => null);
    mockQuickWebCapDecision.mockImplementation(async () => ({ mode: 'act', acts: true, canary: false }));
    await runTurn({ mode: 'thinking' });
    expect(agentMock.mock.calls[0][0].webToolCaps).toBeUndefined();
  });

  it('council: acting colleague picks run their slots (the seat is each slot\'s fallback); the request names both council slots', async () => {
    mockRolePickDecision.mockImplementation(async () => ({ mode: 'act', acts: true, canary: false }));
    mockResolveRolePicksBounded.mockImplementation(async (req: any) => ({
      decision: { mode: 'act', acts: true, canary: false }, quick: null, checker: null,
      colleagues: [
        { slot: 'double_checker', pick: rolePick('colleague', req.colleagues[0].seat, 'cql:col-a') },
        { slot: 'triple_checker', pick: rolePick('colleague', req.colleagues[1].seat, 'cql:col-b') },
      ],
    }));
    agentMock.mockImplementationOnce(async (input: any) => {
      const dispatch = (input.extraTools || []).find((t: any) => t?.schema?.function?.name === 'dispatch_colleagues');
      if (dispatch) await dispatch.execute({ tasks: [{ model: 'double_checker', mission: 'a' }, { model: 'triple_checker', mission: 'b' }] });
      return { finalText: 'D'.repeat(500) };
    });
    await runTurn({ mode: 'deep_research', chatId: 'chat-role-council', userTurnAt: new Date() }, 8000);
    expect(mockResolveRolePicksBounded.mock.calls[0][0].colleagues.map((c: any) => c.slot)).toEqual(['double_checker', 'triple_checker']);
    const ran = workerMock.mock.calls.map(([i]: any[]) => i.model);
    expect(ran).toEqual(expect.arrayContaining(['cql:col-a', 'cql:col-b']));
  }, 15_000);

  it('ux_ttft carries the run\'s web-call count (the tool-aware evidence)', async () => {
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_call', name: 'scrape_as_markdown' }] }));
    await runTurn({ mode: 'thinking' });
    const ttft = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r.kind === 'ux_ttft');
    expect(ttft?.meta).toMatchObject({ webToolCalls: 2 });
  });

  it('2026-10-20 task-aware pick: ux_ttft + metadata.depth.turnPlan carry the turn\'s USABLE task kind (null without one)', async () => {
    const taskKind = { kind: 'writing', top: 'writing', p: 0.874, averaged: true, harm: 0.123, usable: true, decisionId: 'tk-1', backend: 'TypeSafe Jev', calibrated: true };
    const plan = { lane: 'standard', act: false, mode: 'shadow', reason: 'lane standard', cls: null, roster: null, taskKind };
    mockTurnPlan.mockImplementation(async () => plan);
    const ttft = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'ux_ttft').at(-1);
    const prevFindMany = mockPrisma.crossModelMessage.findMany;
    const prevFindFirst = mockPrisma.crossModelMessage.findFirst;
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => null);
    try {
      await runTurn({ mode: 'thinking', chatId: 'chat-task-kind' }, 15_000);
    } finally {
      mockPrisma.crossModelMessage.findMany = prevFindMany;
      mockPrisma.crossModelMessage.findFirst = prevFindFirst;
    }
    expect(ttft()?.meta).toMatchObject({ taskKind: 'writing' });
    // the persisted record is the WHITELIST: 2-dp p / harm, no backend / calibrated
    expect(persistedMeta()?.depth?.turnPlan?.taskKind).toEqual({ kind: 'writing', top: 'writing', p: 0.87, averaged: true, harm: 0.12, usable: true, decisionId: 'tk-1' });
    mockRecordLoopMetric.mockClear();
    mockTurnPlan.mockImplementation(async () => ({ ...plan, taskKind: { ...taskKind, kind: null, p: 0.41, usable: false } }));
    await runTurn({ mode: 'thinking' });
    expect(ttft()?.meta).toHaveProperty('taskKind', null);
    mockRecordLoopMetric.mockClear();
    mockTurnPlan.mockImplementation(async () => ({ ...plan, taskKind: undefined }));
    await runTurn({ mode: 'thinking' });
    expect(ttft()?.meta).toHaveProperty('taskKind', null);
  }, 30_000);
});

describe('roster 2026-10-06 Team A — the turn plan decides DEPTH (lane checker A-2, lane fail-open A-4, the prefetched plan A-3)', () => {
  const lanePlan = (probs: Record<string, number>, over: Record<string, unknown> = {}) => {
    const lane = Object.keys(probs).reduce((b, l) => (probs[l] > probs[b] ? l : b), 'quick');
    return {
      lane, act: false, mode: 'act', reason: `lane ${lane}`, decisionId: 'tp-l', backend: 'TypeSafe Jev',
      cls: { lane, laneProbs: { quick: 0, standard: 0, checked: 0, research: 0, ...probs }, laneConfidence: probs[lane], laneAveraged: true, needsLiveWeb: 0.3, stakes: 0.2, contested: 0.05, multiStep: 0.3, breadth: 2, followUp: null, ...over },
      roster: { lead: 'kimi-k3', leadPool: 'lead', checker: null, colleagues: [], reason: 'lane' },
      stash: { id: 'tp-l', purpose: 'turn_plan', mode: 'act', backend: 'TypeSafe Jev', answers: {}, decidedAt: 'x', calibrated: true },
    };
  };
  const STANDARD = () => lanePlan({ quick: 0.02, standard: 0.95, checked: 0.02, research: 0.01 });
  const CHECKED = () => lanePlan({ quick: 0, standard: 0.2, checked: 0.8, research: 0 }, { stakes: 0.9 });
  const acts = (over: Record<string, boolean>) => ({ ...LANE_OFF, canary: true, acts: { ...LANE_OFF.acts, ...over } });
  const laneRow = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r?.kind === 'lane_depth');
  beforeEach(() => {
    delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    delete process.env.TURN_PLAN_DISABLED; // an earlier describe leaves it set
    delete process.env.QUICK_LANE_DISABLED;
    mockTurnPlan.mockReset();
    mockTurnPlan.mockImplementation(async () => null);
    mockCanary.mockReset();
    mockCanary.mockImplementation(async () => false);
    mockLaneAccess.mockReset();
    mockLaneAccess.mockImplementation(async () => LANE_OFF);
    mockLaneCheckerModel.mockReset();
    mockLaneCheckerModel.mockImplementation(async (_lead: string, seat: string) => ({ spec: seat, why: 'seat' }));
    // The turn plan's session reads (prior user turns / the last answer's lane) on a chat row.
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => null);
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
  });

  it('NOT acting for this sender (shadow, not the canary): the preset runs unchanged — the Level 2 checker spawns — and the lane_depth row records the would-act', async () => {
    mockTurnPlan.mockImplementation(async () => STANDARD());
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-shadow' }, 15_000);
    expect(checkerCalls().length).toBe(1);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ preset: 'thinking', spawnChecker: true });
    expect(persistedMeta()?.depth?.plan?.lane).toBeUndefined();
    expect(laneRow()?.meta).toMatchObject({ lane: 'standard', wouldChecker: false, applied: null, ranLane: 'checked', ranChecker: true, segment: 'user' });
  });

  it('audit 2026-10-08 W4-1b: that non-acting Standard-classified Level 2 turn\'s ux_ttft row is keyed STANDARD (was bucketed checked by its preset); the kill switch restores no lane', async () => {
    mockTurnPlan.mockImplementation(async () => STANDARD());
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-ttft' }, 15_000);
    const ttft = () => mockRecordLoopMetric.mock.calls.map((c: any) => c[0]).filter((m: any) => m.kind === 'ux_ttft').at(-1);
    expect(ttft()?.meta).toMatchObject({ preset: 'thinking', lane: 'standard', ranLane: 'checked', planLane: 'standard', laneSource: 'turn_plan' });
    process.env.UX_TTFT_LANE_ALWAYS_DISABLED = '1';
    try {
      mockRecordLoopMetric.mockClear();
      await runTurn({ mode: 'thinking', chatId: 'chat-lane-ttft-ks' }, 15_000);
      expect(ttft()?.meta?.lane).toBeUndefined();
      expect(ttft()?.meta?.laneSource).toBeUndefined();
    } finally {
      delete process.env.UX_TTFT_LANE_ALWAYS_DISABLED;
    }
  });

  it('A-2 checker acts: a confident STANDARD lane drops the checker on a Level 2 send — Level 1 shape, no checker run, source turn_plan, lane standard', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockTurnPlan.mockImplementation(async () => STANDARD());
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-std' }, 15_000);
    expect(checkerCalls().length).toBe(0);
    // audit 2026-10-08 W4-1c: the Standard lane keeps its Level 1 alias + no checker but runs the 'thinking' BUDGET.
    expect(agentMock.mock.calls[0][0].profile).toMatchObject({ maxSteps: 8, runDeadlineMs: 480_000 });
    expect(persistedMeta()?.depth?.plan).toMatchObject({ preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'turn_plan' });
    expect(laneRow()?.meta).toMatchObject({ applied: 'checker', ranLane: 'standard', ranChecker: false, source: 'turn_plan', canary: true, budget: 'thinking' });
  });

  it('A-2 checker acts + STANDARD_LANE_THINKING_BUDGET_DISABLED=1: the Standard lane runs the Level 1 budget again (W4-1c kill switch)', async () => {
    process.env.STANDARD_LANE_THINKING_BUDGET_DISABLED = '1';
    try {
      mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
      mockTurnPlan.mockImplementation(async () => STANDARD());
      await runTurn({ mode: 'thinking', chatId: 'chat-lane-std-ks' }, 15_000);
      expect(agentMock.mock.calls[0][0].profile).toMatchObject({ maxSteps: 6, runDeadlineMs: 240_000 });
      expect(laneRow()?.meta?.budget).toBeUndefined();
    } finally {
      delete process.env.STANDARD_LANE_THINKING_BUDGET_DISABLED;
    }
  });

  it('A-2 checker acts: a CHECKED lane (high stakes) adds the checker on a Level 1 send — lane checked, source turn_plan', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockTurnPlan.mockImplementation(async () => CHECKED());
    await runTurn({ mode: 'single_thinking', chatId: 'chat-lane-chk' }, 15_000);
    expect(checkerCalls().length).toBe(1);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, lane: 'checked', source: 'turn_plan' });
  });

  it('A-2: a lane-checked turn takes its checker from the checker POOL (another family than the lead) — the worker runs on the pool model', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockTurnPlan.mockImplementation(async () => CHECKED());
    mockLaneCheckerModel.mockImplementation(async () => ({ spec: 'cql:pool-checker', why: 'checker pool' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-pool' }, 15_000);
    expect(mockLaneCheckerModel).toHaveBeenCalledTimes(1);
    expect(checkerCalls()[0][0].model).toBe('cql:pool-checker');
    expect(laneRow()?.meta).toMatchObject({ checkerModel: 'cql:pool-checker' });
  });

  it('A-2: high stakes never lose the checker even when the lane reads standard', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockTurnPlan.mockImplementation(async () => lanePlan({ quick: 0, standard: 0.95, checked: 0.05, research: 0 }, { stakes: 0.7 }));
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-stakes' }, 15_000);
    expect(checkerCalls().length).toBe(1);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ spawnChecker: true, lane: 'checked', source: 'turn_plan' });
  });

  it('A-4 fail-open acts + NO usable turn plan ⇒ "standard on the seat" (no checker, source lane_fail_open); the checker feature alone keeps the preset', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ failOpen: true }));
    mockTurnPlan.mockImplementation(async () => null);
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-fo' }, 15_000);
    expect(checkerCalls().length).toBe(0);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'lane_fail_open' });
    jest.clearAllMocks();
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-fo2' }, 15_000);
    expect(checkerCalls().length).toBe(1);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, source: 'preset' });
  });

  it('never on a supervisor chat (the lane access is not even read) and never on a Dig-deeper rung', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true, failOpen: true }));
    mockTurnPlan.mockImplementation(async () => STANDARD());
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-sup' }, 15_000);
    expect(mockLaneAccess).not.toHaveBeenCalled();
    expect(laneRow()).toBeUndefined();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    mockTurnPlan.mockClear(); // (the supervisor turn above still ASKS the turn plan today — Team B's B1 owns that)
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-esc', escalation: { ofMessageId: 'm-orig', rung: 'verify' } }, 15_000);
    expect(mockLaneAccess).not.toHaveBeenCalled();
    expect(mockTurnPlan).not.toHaveBeenCalled();
    expect(persistedMeta()?.depth?.plan).toMatchObject({ source: 'escalation', lane: 'checked', spawnChecker: true });
  });

  it('A-3: a turn plan the controller already asked (args.turnPlanPrefetched) is reused — turn_plan is never asked twice', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-pre', turnPlanPrefetched: STANDARD() }, 15_000);
    expect(mockTurnPlan).not.toHaveBeenCalled();
    expect(persistedMeta()?.depth?.plan).toMatchObject({ lane: 'standard', source: 'turn_plan' });
    expect(persistedMeta()?.depth?.turnPlan).toMatchObject({ lane: 'standard', decisionId: 'tp-l' });
  });

  // 2026-10-20 — follow-up hysteresis on the A-2 checker drop: the session lane is the one the Quick guard reads (the
  // last answer's turn-plan lane here — the session roster does not act in this harness).
  const CHECKED_SESSION = { metadata: { depth: { turnPlan: { lane: 'checked', act: false, stash: { id: 'tp-prev', purpose: 'turn_plan' } } } } };
  const STANDARD_FOLLOW_UP = () => lanePlan({ quick: 0.02, standard: 0.95, checked: 0.02, research: 0.01 }, { followUp: 0.9 });

  it('2026-10-20: a STANDARD follow-up in a CHECKED session keeps the checker when A-2 acts (the row records the session lane)', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockTurnPlan.mockImplementation(async () => STANDARD_FOLLOW_UP());
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => CHECKED_SESSION);
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-fu' }, 15_000);
    expect(checkerCalls().length).toBe(1);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, lane: 'checked', source: 'turn_plan' });
    expect(laneRow()?.meta).toMatchObject({ applied: 'checker', wouldChecker: true, priorLane: 'checked', followUp: 0.9, ranChecker: true, checkerWhy: expect.stringMatching(/follow-up in a checked session/) });
    // the ask itself still saw the last answer's lane (unchanged input)
    expect(mockTurnPlan.mock.calls[0][1]).toMatchObject({ priorLane: 'checked' });
  });

  it('2026-10-20: LANE_CHECKER_FOLLOW_UP_DISABLED=1 restores the session-blind drop', async () => {
    process.env.LANE_CHECKER_FOLLOW_UP_DISABLED = '1';
    try {
      mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
      mockTurnPlan.mockImplementation(async () => STANDARD_FOLLOW_UP());
      mockPrisma.crossModelMessage.findFirst = jest.fn(async () => CHECKED_SESSION);
      await runTurn({ mode: 'thinking', chatId: 'chat-lane-fu-ks' }, 15_000);
      expect(checkerCalls().length).toBe(0);
      expect(persistedMeta()?.depth?.plan).toMatchObject({ spawnChecker: false, lane: 'standard', source: 'turn_plan' });
    } finally {
      delete process.env.LANE_CHECKER_FOLLOW_UP_DISABLED;
    }
  });

  it('2026-10-20: a PREFETCHED plan (the controller research route) reads the session lane itself — the follow-up keeps its checker; a new topic drops it', async () => {
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => CHECKED_SESSION);
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-fu-pre', turnPlanPrefetched: STANDARD_FOLLOW_UP() }, 15_000);
    expect(mockTurnPlan).not.toHaveBeenCalled();
    expect(checkerCalls().length).toBe(1);
    expect(laneRow()?.meta).toMatchObject({ applied: 'checker', priorLane: 'checked', ranChecker: true });
    jest.clearAllMocks();
    mockLaneAccess.mockImplementation(async () => acts({ checker: true }));
    mockPrisma.crossModelMessage.findFirst = jest.fn(async () => CHECKED_SESSION);
    await runTurn({ mode: 'thinking', chatId: 'chat-lane-fu-pre2', turnPlanPrefetched: STANDARD() }, 15_000);
    expect(checkerCalls().length).toBe(0);
    expect(persistedMeta()?.depth?.plan).toMatchObject({ spawnChecker: false, lane: 'standard', source: 'turn_plan' });
  });
  afterAll(() => { delete mockPrisma.crossModelMessage.findMany; delete mockPrisma.crossModelMessage.findFirst; });
});
