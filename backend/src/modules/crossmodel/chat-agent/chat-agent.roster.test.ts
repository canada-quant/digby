/**
 * chat-agent.service × the dynamic roster phase 4 (roster 2026-10-06 Team D): the session roster seam (D-1), the
 * lead's call_in tool (D-2) and the team note (D-3), driven through the REAL turn. The mock preamble is
 * chat-agent.compute-policy.test.ts's (the service's import graph is what it is) plus two boundaries of this file:
 * the roster config (platform/roster-config — controllable per test) and the context store (an in-memory map — the
 * session roster row lives there).
 */

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

// call_in's candidate boundary is mocked ONCE, further down (search "call_in's
// candidate boundary"), with a DELEGATING default + a pinned field in the CALL
// test — a second jest.mock here would be dead code (jest's last registration
// wins silently). The 013c6e70 fail-fast stubs previously at this spot were
// removed when the delegating mocks landed (842763b4); do not re-add a
// duplicate registration.

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
    SESSION_ROSTER: 'session_roster',
    CALL_IN: 'call_in',
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

// ── roster 2026-10-06 (this file's own boundaries) ─────────────────────────
const mockRosterConfigRow: { current: Record<string, unknown> } = { current: {} };
jest.mock('../platform/roster-config', () => {
  const actual = jest.requireActual('../platform/roster-config');
  return { __esModule: true, ...actual, rosterConfig: async () => actual.parseRosterConfig(mockRosterConfigRow.current) };
});
// call_in's candidate boundary: the service resolves the REAL Auto pools + chat
// catalog through dynamic imports (chat-agent.service.ts candidates()), and a
// built-in's catalog card is servable only when its provider env key is set
// (model-catalog.ts builtInCard: servable = !envKey || !!env[envKey]). On a
// KEYLESS runner (CI) every built-in card reads unservable, pickCallInModels
// drops the whole field and "the lead CALLS it" fails exactly as both 2026-10-06
// deploy waves did (e8fcfb8d run 37525454065, 54e097cb run 37526973784 —
// workerMock 0 calls) while a keyed dev shell stays green. Mocked at the same
// boundary with a DELEGATING default (every other test byte-identical: offer /
// not-offered / team-note / session-roster read no candidates); the CALL test
// pins a fixed field so it asserts the call path, not which models this
// instance happens to have keys for. Repro: env -i jest → red; keyed → green.
const mockResolveEffectivePools: jest.Mock = jest.fn();
const mockRealPools: { resolveEffectivePools: (...a: any[]) => Promise<any> } = {} as any;
jest.mock('../model-endpoints/auto-pools.service', () => {
  const actual = jest.requireActual('../model-endpoints/auto-pools.service');
  mockRealPools.resolveEffectivePools = actual.resolveEffectivePools;
  return { __esModule: true, ...actual, resolveEffectivePools: (...a: any[]) => mockResolveEffectivePools(...a) };
});
const mockListChatModelCatalog: jest.Mock = jest.fn();
const mockRealCatalog: { listChatModelCatalog: (...a: any[]) => Promise<any> } = {} as any;
jest.mock('../model-endpoints/model-catalog', () => {
  const actual = jest.requireActual('../model-endpoints/model-catalog');
  mockRealCatalog.listChatModelCatalog = actual.listChatModelCatalog;
  return { __esModule: true, ...actual, listChatModelCatalog: (...a: any[]) => mockListChatModelCatalog(...a) };
});
const mockStore = new Map<string, any>();
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], key: string, value: any) => { mockStore.set(`${ns.join(':')}|${key}`, JSON.parse(JSON.stringify(value))); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: async (ns: string[], key: string) => mockStore.get(`${ns.join(':')}|${key}`) ?? null,
  storePut: (...a: any[]) => mockStorePut(...a),
  storeCreate: async () => true,
  storeDelete: async () => {},
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { isRunActive, subscribeRun } from '../coding/live-runs';
import { presetPlan } from '../platform/compute-policy-gate';
import { modelFamily } from '../model-endpoints/model-catalog';
import { applyRosterTurn, sessionRosterNamespace, SESSION_ROSTER_KEY } from './session-roster';

const BASE = { message: 'the question', mode: 'single_thinking' as const };
const agentMock = runCodingAgent as jest.Mock;
const workerMock = runChatWorker as jest.Mock;
type Ev = { type: string; data: any };

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}
async function runTurn(args: Record<string, any>, waitMs = 15_000): Promise<{ key: string; events: Ev[] }> {
  const key = await startDetachedChatRun({ ...BASE, userId: 'u1', sessionId: null, ...args } as any);
  expect(key).toBeTruthy();
  const events: Ev[] = [];
  subscribeRun(key!, e => events.push(e));
  await waitFor(() => events.some(e => e.type === 'complete' || e.type === 'error'), waitMs);
  await waitFor(() => !isRunActive(key!), waitMs);
  return { key: key!, events };
}
const persistedMeta = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.role === 'assistant').at(-1)?.metadata;
const metricRows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === kind);
const callInTool = (input: any) => (input?.extraTools ?? []).find((t: any) => t?.schema?.function?.name === 'call_in');
const rosterPuts = (chatId: string) => mockStorePut.mock.calls.filter(([ns, key]: any[]) => ns.join(':') === sessionRosterNamespace(chatId).join(':') && key === SESSION_ROSTER_KEY);
const ENV = ['CALL_IN_DISABLED', 'SESSION_ROSTER_DISABLED', 'SESSION_ROSTER_STICKY_LEAD_DISABLED', 'TEAM_NOTE_DISABLED', 'DECISION_GATE_MODE_TURN_PLAN', 'DECISION_GATE_MODE_COMPUTE_POLICY'];

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
  jest.clearAllMocks();
  // call_in candidate boundary: DELEGATE to the real resolver by default (the
  // offer / not-offered / team-note / session-roster tests read no candidates);
  // the CALL test re-pins a fixed field below.
  mockResolveEffectivePools.mockImplementation((...a: any[]) => mockRealPools.resolveEffectivePools(...a));
  mockListChatModelCatalog.mockImplementation((...a: any[]) => mockRealCatalog.listChatModelCatalog(...a));
  mockStore.clear();
  mockRosterConfigRow.current = {};
  for (const k of ENV) delete process.env[k];
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
  mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
  mockPrisma.crossModelMessage.findFirst = jest.fn(async () => null);
  mockPrisma.crossModelMessage.update = jest.fn(async (q: any) => q);
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  mockTurnPlan.mockReset();
  mockTurnPlan.mockImplementation(async () => null);
  mockCanary.mockReset();
  mockCanary.mockImplementation(async () => false);
});
afterAll(() => { for (const k of ENV) delete process.env[k]; });

describe('call_in (roster 2026-10-06 D-2) — offered on an eligible human turn, through the real chat turn', () => {
  it('a CANARY user on a plain Level 1 turn: the lead carries the call_in tool (both roles) + its doctrine row; one offer row', async () => {
    mockRosterConfigRow.current = { rosterCanaryUserIds: ['u1'] };
    await runTurn({ mode: 'single_thinking', chatId: 'chat-ci-1' });
    const input = agentMock.mock.calls[0][0];
    expect(callInTool(input)?.schema.function.parameters.properties.role.enum).toEqual(['checker', 'colleague']);
    expect(String(input.doctrineOverride)).toMatch(/## Calling in help \(call_in\)/);
    expect(metricRows('call_in')[0].meta).toMatchObject({ phase: 'offer', roles: ['checker', 'colleague'], mode: 'canary', canary: true });
  });

  it('a Level 2 turn whose Double Checker already runs offers only the colleague role (one checker per answer)', async () => {
    mockRosterConfigRow.current = { callIn: 'act' };
    await runTurn({ mode: 'thinking', chatId: 'chat-ci-l2' });
    expect(callInTool(agentMock.mock.calls[0][0])?.schema.function.parameters.properties.role.enum).toEqual(['colleague']);
  });

  it('never offered: the default canary with nobody on it, CALL_IN_DISABLED=1, a supervisor chat, a machine wake, a council turn', async () => {
    const offered = () => agentMock.mock.calls.map((c: any[]) => !!callInTool(c[0]) || /Calling in help/.test(String(c[0].doctrineOverride)));
    await runTurn({ mode: 'single_thinking', chatId: 'chat-ci-default' });
    mockRosterConfigRow.current = { callIn: 'act', rosterCanaryUserIds: ['u1'] };
    process.env.CALL_IN_DISABLED = '1';
    await runTurn({ mode: 'single_thinking', chatId: 'chat-ci-ks' });
    delete process.env.CALL_IN_DISABLED;
    await runTurn({ mode: 'single_thinking', chatId: 'chat-ci-wake', machineWake: true, messageOrigin: 'schedule' });
    await runTurn({ mode: 'deep_research', chatId: 'chat-ci-council' });
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-ci-sup' });
    expect(offered().every((o: boolean) => o === false)).toBe(true);
    expect(agentMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(metricRows('call_in')).toEqual([]);
    // the council keeps its own tools
    expect(agentMock.mock.calls.some((c: any[]) => (c[0].extraTools ?? []).some((t: any) => t?.schema?.function?.name === 'dispatch_colleagues'))).toBe(true);
  });

  it('the lead CALLS it: one other-family model runs the brief as a read-only peer; its report is the tool result; card + team note + call row record it', async () => {
    mockRosterConfigRow.current = { callIn: 'act' };
    // Hermetic candidate field (see the boundary mock above): a keyless runner
    // must not decide this test — pin pools + catalog so the pick is fixed and
    // servable regardless of which provider keys this environment happens to
    // carry. Lead = kimi-k3 (kimi family); field = deepseek + glm + qwen.
    mockResolveEffectivePools.mockImplementation(async () => ({
      quick: { role: 'quick', models: [], source: 'seats', dropped: [] },
      lead: { role: 'lead', models: [], source: 'seats', dropped: [] },
      checker: { role: 'checker', models: ['deepseek-flash'], source: 'pool', dropped: [] },
      colleague: { role: 'colleague', models: ['deepseek-flash', 'glm-5.3', 'qwen3.6-27b'], source: 'pool', dropped: [] },
    }));
    mockListChatModelCatalog.mockImplementation(async () => [
      { spec: 'kimi-k3', family: 'kimi', servable: true },
      { spec: 'deepseek-flash', family: 'deepseek', servable: true },
      { spec: 'glm-5.3', family: 'glm', servable: true },
      { spec: 'qwen3.6-27b', family: 'qwen', servable: true },
    ] as any);
    let toolOut = '';
    let lead = '';
    agentMock.mockImplementation(async (input: any) => {
      lead = input.model;
      const t = callInTool(input);
      toolOut = t ? await t.execute({ role: 'checker', brief: 'verify the 2.1% growth figure' }) : '';
      return { finalText: 'A'.repeat(500), parts: [] };
    });
    workerMock.mockImplementation(async () => ({ finalText: 'INDEPENDENT ANSWER: 2.1% is right (stats.gov).', parts: [{ type: 'tool_call', name: 'search_engine' }] }));
    await runTurn({ mode: 'single_thinking', chatId: 'chat-ci-run' });
    expect(workerMock).toHaveBeenCalledTimes(1);
    const [w, role] = workerMock.mock.calls[0];
    expect(role).toBe('cross_checker');
    expect(w.doctrineOverride).toMatch(/CALLED IN mid-answer by Digby's lead/);
    expect(w.doctrineOverride).toMatch(/verify the 2\.1% growth figure/);
    expect(w.profile).toMatchObject({ maxSteps: 6 });
    expect(modelFamily(w.model)).not.toBe(modelFamily(lead));
    expect(toolOut).toMatch(/^\[CALL-IN REPORT — the Double Checker/);
    expect(toolOut).toMatch(/INDEPENDENT ANSWER/);
    const meta = persistedMeta();
    expect(meta.models.double_checker).toMatchObject({ persona: 'Double Checker', modelUsed: w.model });
    expect(meta.depth.team.members).toContainEqual({ role: 'checker', model: w.model, via: 'call_in' });
    expect(meta.depth.team.line).toMatch(/\(called in\)/);
    expect(metricRows('call_in').map((r: any) => r.meta)).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'call', outcome: 'ok', role: 'checker', model: w.model })]));
    await waitFor(() => rosterPuts('chat-ci-run').length > 0);
    expect(rosterPuts('chat-ci-run')[0][2]).toMatchObject({ sessionLane: 'checked', last: { callIn: { role: 'checker', model: w.model, ok: true }, needLane: 'checked' } });
  });
});

describe('team note (roster 2026-10-06 D-3)', () => {
  it('a Level 2 turn: "Checked · <lead> + <checker>" on metadata.depth.team and the complete event; TEAM_NOTE_DISABLED=1 drops it; a machine turn carries none', async () => {
    const { events } = await runTurn({ mode: 'thinking', chatId: 'chat-team-1' });
    const team = persistedMeta().depth.team;
    expect(team).toMatchObject({ lane: 'checked' });
    expect(team.line).toMatch(/^Checked · /);
    expect(team.members[0].role).toBe('lead');
    expect(team.members[1]).toMatchObject({ role: 'checker', via: 'plan' });
    expect(events.find((e) => e.type === 'complete')?.data.depth.team).toEqual(team);
    process.env.TEAM_NOTE_DISABLED = '1';
    await runTurn({ mode: 'thinking', chatId: 'chat-team-off' });
    expect(persistedMeta().depth.team).toBeUndefined();
    delete process.env.TEAM_NOTE_DISABLED;
    await runTurn({ mode: 'thinking', chatId: 'chat-team-wake', machineWake: true, messageOrigin: 'schedule' });
    expect(persistedMeta().depth.team).toBeUndefined();
  });
});

describe('session roster (roster 2026-10-06 D-1)', () => {
  const researchRoster = (lead = 'glm-5.3') => applyRosterTurn(null, { messageId: 'm0', planLane: 'research', ranLane: 'research', lead, checker: null, colleagues: [], callIn: null });

  it('SHADOW (default): a human turn on a chat row writes the roster + one session_roster row; the row records the read', async () => {
    await runTurn({ mode: 'single_thinking', chatId: 'chat-r1' });
    await waitFor(() => rosterPuts('chat-r1').length > 0);
    expect(rosterPuts('chat-r1')[0][2]).toMatchObject({ v: 1, sessionLane: 'standard', turns: 1, last: { ranLane: 'standard', needLane: 'standard' } });
    await waitFor(() => metricRows('session_roster').length > 0);
    expect(metricRows('session_roster')[0]).toMatchObject({ sessionId: 'chat-r1', meta: { chatId: 'chat-r1', ranLane: 'standard', sessionLane: 'standard', mode: 'shadow', acts: false } });
    expect(persistedMeta().depth.roster).toMatchObject({ mode: 'shadow', acts: false });
  });

  it('never written on a supervisor chat or a machine wake; mode off and SESSION_ROSTER_DISABLED=1 write (and record) nothing', async () => {
    await runTurn({ mode: 'single_thinking', chatId: 'chat-r-wake', machineWake: true, messageOrigin: 'schedule' });
    mockRosterConfigRow.current = { sessionRoster: 'off' };
    await runTurn({ mode: 'single_thinking', chatId: 'chat-r-off' });
    mockRosterConfigRow.current = {};
    process.env.SESSION_ROSTER_DISABLED = '1';
    await runTurn({ mode: 'single_thinking', chatId: 'chat-r-ks' });
    expect(persistedMeta().depth.roster).toBeUndefined();
    delete process.env.SESSION_ROSTER_DISABLED;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    await runTurn({ mode: 'thinking', chatId: 'chat-r-sup' });
    await new Promise((r) => setTimeout(r, 50));
    expect(mockStorePut.mock.calls.filter(([ns]: any[]) => ns[1] === 'roster')).toEqual([]);
    expect(metricRows('session_roster')).toEqual([]);
  });

  it('ACTS for a canary user: the Quick guard reads the SESSION lane while the ask keeps the legacy lane; a non-canary user reads the legacy lane', async () => {
    mockStore.set(`${sessionRosterNamespace('chat-r2').join(':')}|${SESSION_ROSTER_KEY}`, researchRoster());
    mockRosterConfigRow.current = { rosterCanaryUserIds: ['u1'] };
    await runTurn({ mode: 'thinking', chatId: 'chat-r2' });
    expect(mockTurnPlan.mock.calls[0][1].priorLane).toBe('research'); // the guard
    expect(mockTurnPlan.mock.calls[0][0].priorLane).toBeNull(); // the decision state (the last answer's own lane — none here)
    expect(persistedMeta().depth.roster).toMatchObject({ mode: 'shadow', acts: true, priorLane: 'research', source: 'roster', sessionLaneBefore: 'research' });
    mockRosterConfigRow.current = {};
    await runTurn({ mode: 'thinking', chatId: 'chat-r2' });
    expect(mockTurnPlan.mock.calls[1][1].priorLane).toBeNull();
    expect(persistedMeta().depth.roster).toMatchObject({ acts: false, source: 'legacy' });
  });

  it('the session lead STICKS: a pick that only marginally beats the lead the session ran on keeps it; SESSION_ROSTER_STICKY_LEAD_DISABLED=1 lets it switch', async () => {
    await runTurn({ mode: 'single_thinking', chatId: 'chat-seat' });
    const seat = agentMock.mock.calls[0][0].model as string;
    const pickSpec = modelFamily(seat) === 'glm' ? 'deepseek-flash' : 'glm-5.3';
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    mockRosterConfigRow.current = { sessionRoster: 'act' };
    const plan = {
      lane: 'standard', act: false, mode: 'act', reason: 'lane standard', cls: null,
      roster: { lead: seat, leadPool: 'lead', checker: null, colleagues: [], reason: '' },
      modelPick: {
        spec: pickSpec, changed: true, seat, reason: 'faster', expectedTtftMs: 9_000, seatUtility: 4.0, mode: 'act', act: true,
        ranked: [{ spec: pickSpec, utility: 4.2, ttftP50Ms: 9_000, quality: 4.5, n: 10 }, { spec: seat, utility: 4.0, ttftP50Ms: 30_000, quality: 4.5, n: 10 }],
      },
      stash: { id: 'tp-s', purpose: 'turn_plan', mode: 'act', backend: 'Jev', answers: {}, decidedAt: 'x' },
    };
    mockTurnPlan.mockImplementation(async () => plan);
    mockStore.set(`${sessionRosterNamespace('chat-r3').join(':')}|${SESSION_ROSTER_KEY}`, applyRosterTurn(null, { messageId: 'm0', planLane: 'standard', ranLane: 'standard', lead: seat, checker: null, colleagues: [], callIn: null }));
    agentMock.mockClear();
    await runTurn({ mode: 'single_thinking', chatId: 'chat-r3' });
    expect(agentMock.mock.calls[0][0].model).toBe(seat);
    expect(persistedMeta().depth.roster).toMatchObject({ acts: true, sticky: 'kept_seat' });
    process.env.SESSION_ROSTER_STICKY_LEAD_DISABLED = '1';
    agentMock.mockClear();
    await runTurn({ mode: 'single_thinking', chatId: 'chat-r3' });
    expect(agentMock.mock.calls[0][0].model).toBe(pickSpec);
  });
});
