/**
 * chat-agent.service tests — detached-run key contract (H2) and the slim
 * 'complete' wire payload (H3). live-runs is the REAL in-memory registry (that
 * register/subscribe contract is exactly what H2 broke); the agent loop,
 * prisma, search, memory, and title generation are mocked so a run completes
 * in milliseconds.
 */

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
    // MERGE-1 kill-window fix (2026-11-05): consume-at-persist needs
    // deleteMany({ id: { in } }). This fixture was left on the pre-fix API
    // (no deleteMany, no $transaction below), so createMessagesConsumingPending
    // THREW, the transcript user row was never persisted, and the drain tests
    // timed out waiting for run events.
    deleteMany: jest.fn(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? (where?.id ? [where.id] : []);
      // The row is GONE after a consume — mirror that on the peek, or a test
      // that armed a PERSISTENT findFirst mock keeps serving the row, the
      // consume keeps succeeding, clearDrainAttempts keeps resetting the bound
      // and the drain loop never ends (heap OOM, 2026-11-05).
      if (ids.length) mockPrisma.pendingChatMessage.findFirst.mockResolvedValue(null);
      return { count: ids.length };
    }),
    // shutdown re-queue (2026-09-11) — enqueueChatMessage counts then creates.
    count: jest.fn(async () => 0), create: jest.fn(async (a: any) => ({ id: 'pend-1', ...a.data })),
  },
  // chat-busy's durable layer (worker-tier coding runs) — none in these tests.
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  // MERGE-1 kill-window fix (2026-11-05): the transcript write and the queue-row
  // consume commit in ONE $transaction. Delegates to the SAME mocks the
  // non-transactional path uses, so assertions on crossModelMessage.create keep
  // meaning what they did before consume-at-persist.
  $transaction: jest.fn(async (fn: any) => {
    const tx = {
      crossModelMessage: { create: jest.fn(async (a: any) => mockPrisma.crossModelMessage.create(a)) },
      pendingChatMessage: { deleteMany: jest.fn(async (a: any) => mockPrisma.pendingChatMessage.deleteMany(a)) },
    };
    return fn(tx);
  }),
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
// Hand-off polish (2026-09-28, audit CT-2 b): the finalize reads the child's
// latest hand-off record before persisting the spawn-time running card.
const mockLatestHandoff: jest.Mock = jest.fn(async () => null);
jest.mock('../coding/deliverable-handoff', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/deliverable-handoff'),
  latestDeliverableHandoff: (...a: any[]) => mockLatestHandoff(...a),
}));
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
// Ghost mode (owner 2026-10-22): the designation lives in the context store —
// mocked at the same boundary the service test uses, with a controllable
// helper so each case can set/clear it.
const ghostStore: Record<string, any> = {};
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => ghostStore[`${ns.join(':')}/${key}`] ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { ghostStore[`${ns.join(':')}/${key}`] = value; }),
}));
jest.mock('../model-endpoints/model-catalog', () => ({
  __esModule: true,
  listChatModelCatalog: jest.fn(async () => [
    // A minimal catalog: the built-ins + the homelab ghost designation target.
    { spec: 'homelab:abliterated-llama-70b', name: 'Abliterated Llama 70B', source: 'registry', family: 'other', tier: 'standard', vision: false, contextChars: null, maxTools: null, priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false },
  ]),
}));
/** Ghost-mode test helper: point the (mocked) context store's ghost row at a spec (null = no designation). */
function setGhostDesignationForTests(spec: string | null): void {
  if (spec) ghostStore['instance:model-roles/ghost-endpoint'] = { spec, enabled: true, updatedAt: new Date().toISOString(), updatedBy: 'test' };
  else delete ghostStore['instance:model-roles/ghost-endpoint'];
}
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
  default: {
    generateTitle: jest.fn(async () => 'A Generated Title'),
    // de60115d: the ghost title chain (designated endpoint / local cleaner).
    generateGhostTitle: jest.fn(async () => 'A Ghost Title'),
    // Ghost-mode privacy pin (B3): the follow-ups backstop is a Moonshot call.
    generateFollowUps: jest.fn(async () => ({ followUps: [] as string[] })),
  },
}));

// Phantom-claim action verifier (ticket ae085617): finalize fires it via a
// fire-and-forget dynamic import — mocked at the boundary (the real module
// pulls utility-llm → config/env → process.exit at import in a keyless env).
// The PRE-DELIVERY guard (fcc4dbb4) rides the same boundary; its default here
// is a pass-through (struck:false) so pre-existing runs are unaffected.
const mockVerifySupervisorRunAsync = jest.fn();
const mockVerifyRunActionClaimsAsync = jest.fn();
const mockGuardMachineWakeFinalAnswer = jest.fn(async (...a: any[]) => ({ finalText: a[0].finalText, notice: '', struck: false, phantoms: [] as any[] }));
const mockFindUnreadProductionState: jest.Mock = jest.fn((): any[] => []);
// Owner-turn live-state read (2026-10-22): the grounding gate — reimplemented inline (keep in sync with
// action-verifier.ts productionStateGroundingTexts: an evidence read's result, never memory / the own state doc).
const mockProductionStateHasGroundingRead: jest.Mock = jest.fn((input: any): boolean =>
  (Array.isArray(input?.parts) ? input.parts : []).some((p: any) => p?.type === 'tool_result' && typeof p.result === 'string' && !!p.result
    && !['get_supervisor_state', 'search_memory', 'update_plan', 'finish_run', 'update_supervisor_state', 'send_chat_message', 'todo_update'].includes(p.name)));
// BRIEFING-UNVERIFIED-FILTER (2026-10-20): the first cut's anywhere-probe — the review fix asserts the footnote
// lane NEVER calls it (a claim's target existing is not evidence of the act).
const mockCitedIdExistsAnywhere: jest.Mock = jest.fn(async (): Promise<boolean> => false);
jest.mock('../platform/action-verifier', () => ({
  __esModule: true,
  citedIdExistsAnywhere: (...a: any[]) => mockCitedIdExistsAnywhere(...a),
  verifySupervisorRunAsync: (...a: any[]) => mockVerifySupervisorRunAsync(...a),
  verifyRunActionClaimsAsync: (...a: any[]) => mockVerifyRunActionClaimsAsync(...a),
  guardMachineWakeFinalAnswer: (...a: any[]) => mockGuardMachineWakeFinalAnswer(...a),
  // Pure scan (ticket 31738d9a — the L2 checker block builder awaits it via a
  // dynamic import). Without it the block builder REJECTED here, the checker
  // block was always '' and the step-0 reconcile pass never ran in this file
  // (the WI-D ledger suite's "if it ran" hedge). A no-clock stub — the
  // draft-integrity scan is pinned by its own suites.
  findFutureObservedTimestamps: () => [],
  // PRODUCTION-STATE UNREAD lane (supervisor doctrine audit D1, 2026-09-27):
  // the seam calls the pure matcher after the guard; stubbed here (default
  // no hits) — the matcher is pinned in its own suite
  // (action-verifier.production-state.2026-09-27.test.ts).
  findUnreadProductionStateClaims: (...a: any[]) => mockFindUnreadProductionState(...a),
  productionStateHasGroundingRead: (...a: any[]) => mockProductionStateHasGroundingRead(...a),
  PRODUCTION_STATE_STRIKE: 'production_state_unread',
  PRODUCTION_STATE_SEAM: 'machine_wake_production_state',
  // Pure classification (ticket b216475a — the always-on citation-enforce
  // branch gates on it). Reimplemented inline because this boundary exists to
  // avoid the real module's import chain — keep in sync with
  // action-verifier.ts's isCitationClassClaim / CITATION_CLASS_TAGS.
  isCitationClassClaim: (claim: any) =>
    claim?.fabricatedId === true || ['[evidence citation]', '[owner chat ref]', '[vanished artifact]'].some((tag) => String(claim?.detail ?? '').startsWith(tag)),
  // Pure formatter (FO firing 57 — the strike's evidence rides the reject-back
  // warn + the outcome row's struckClaims). Reimplemented inline like the
  // neighbors; keep in sync with action-verifier.ts's claimAuditExcerpts
  // (≤4 claims, detail ≤120, id ≤24, nearMiss ≤4).
  claimAuditExcerpts: (phantoms: any[]) =>
    (Array.isArray(phantoms) ? phantoms : []).slice(0, 4).map((p: any) => ({
      kind: String(p?.kind ?? ''),
      detail: String(p?.detail ?? '').slice(0, 120),
      ...(p?.id ? { id: String(p.id).slice(0, 24) } : {}),
      ...(p?.nearMiss?.length ? { nearMiss: p.nearMiss.slice(0, 4).map((x: any) => String(x).slice(0, 24)) } : {}),
    })),
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
// tt-rd audit 2026-09-27: the owner-ask re-wake (platform/owner-asks.ts) rides enqueueDirectWake.
const mockEnqueueDirectWake: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, hookEventId: 'hook-evt-0001' }));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
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
    TURN_CONTINUATION: 'turn_continuation',
    SPAWN_TURN_END: 'spawn_turn_end', // hand-off polish 2026-09-28 (audit CT-2)
    ACTION_CLASS_ANNOTATED: 'action_class_annotated', // BRIEFING-UNVERIFIED-FILTER 2026-10-20
    SUPERVISOR_HARNESS_RECEIPTS: 'supervisor_harness_receipts', // HARNESS-RECEIPTS-AND-CLAIMS 2026-10-20
  },
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

import { __resetDrainAttemptLedgerForTests } from './message-queue.service';
import {
  startDetachedChatRun, chatAgentRunKey, slimChatModelCards, summarizeToolEvidence,
  toolResultPhrase, drainChatQueue, machineOriginRun,
} from './chat-agent.service';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { isRunActive, subscribeRun, getRunMeta } from '../coding/live-runs';
import { clearGhostEndpointCache } from '../model-endpoints/ghost-endpoint.service';
import moonshotIntegration from '../integrations/moonshot.integration';
import { buildChatQueryContext } from './chat-context';
import { searchWithBrightData } from '../mcp-search';
import logger from '../../../utils/logger';
import { redactGuardChrome } from '../guard-chrome-redact';

import { markRetiring as markRetiringForTest, __resetRetiringForTests } from '../coding/retiring';

const BASE = { message: 'the question', mode: 'single_thinking' as const };

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

beforeEach(() => {
  // MERGE-1 drain bound (2026-11-05): the attempt ledger is MODULE-level and this
  // fixture mints a CONSTANT row id ('pend-1'), so declines from earlier tests
  // would accumulate on it and trip the cooldown, making later drains return false
  // ("timed out waiting for run events"). Production ids are cuids.
  __resetDrainAttemptLedgerForTests();
  redisStore.clear(); // a leaked liveness key must not fail a later claim
  redisLists.clear();
  // HARNESS-RECEIPTS-AND-CLAIMS (2026-10-20): the suites below pin supervisor machine-wake notes
  // byte-for-byte for OTHER contracts (the action guard, the claims lane, the briefing hook, the
  // clock package) — they run with the harness append off; the seam has its own describe
  // ('harness receipts seam') that turns it back on.
  process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
});
afterAll(() => {
  delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
});

describe('chatAgentRunKey', () => {
  it('keys chat runs on chatId, anonymous runs on sessionId, else ephemeral', () => {
    expect(chatAgentRunKey({ chatId: 'c1', sessionId: 's1' })).toBe('chat:c1');
    expect(chatAgentRunKey({ chatId: null, sessionId: 's1' })).toBe('chat:session:s1');
    expect(chatAgentRunKey({ chatId: null, sessionId: null })).toMatch(/^chat:ephemeral:/);
  });

  it('is deterministic for the guard when chatId/sessionId exists (and ephemeral is not)', () => {
    expect(chatAgentRunKey({ chatId: 'c1' })).toBe(chatAgentRunKey({ chatId: 'c1' }));
    expect(chatAgentRunKey({})).not.toBe(chatAgentRunKey({}));
  });
});

describe('startDetachedChatRun (H2 — returns the key it registered under)', () => {
  it('returns chat:<id> for a chat run and refuses a concurrent second start with null', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-h2-a', sessionId: null });
    expect(key).toBe('chat:chat-h2-a');
    expect(isRunActive('chat:chat-h2-a')).toBe(true);
    // Double-submit while active → null (the controller maps this to the busy error).
    expect(await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-h2-a', sessionId: null })).toBeNull();
    await waitFor(() => !isRunActive('chat:chat-h2-a'));
  });

  it('refuses to start when ANOTHER process holds the chat (Redis claim) and releases the local slot', async () => {
    // Instance A's run: only its Redis liveness key is visible here (its
    // registry lives in another process). P5 audit — pre-fix this started a
    // SECOND concurrent run and interleaved the transcript.
    redisStore.set('cm:liverun:chat-h2-x', '12345');
    expect(await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-h2-x', sessionId: null })).toBeNull();
    // The local reservation was rolled back — a later drain on THIS instance
    // (after A releases) must be able to start.
    expect(isRunActive('chat:chat-h2-x')).toBe(false);
    redisStore.delete('cm:liverun:chat-h2-x');
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-h2-x', sessionId: null });
    expect(key).toBe('chat:chat-h2-x');
    await waitFor(() => !isRunActive('chat:chat-h2-x'));
  });

  it('keys an anonymous run on the session id', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: null, chatId: null, sessionId: 'sess-h2-b' });
    expect(key).toBe('chat:session:sess-h2-b');
    await waitFor(() => !isRunActive('chat:session:sess-h2-b'));
  });

  it('mirrors the run to Redis for cross-instance attach — DEL of the stale list, then every event with its seq (terminal included)', async () => {
    // A previous run's leftovers must never replay into the NEW run's viewers.
    redisLists.set('cm:runevents:chat-mirror-a', [JSON.stringify({ type: 'chunk', data: { content: 'stale' }, seq: 99 })]);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-mirror-a', sessionId: null });
    expect(key).toBe('chat:chat-mirror-a');
    await waitFor(() => !isRunActive('chat:chat-mirror-a'));
    await waitFor(() => (redisLists.get('cm:runevents:chat-mirror-a') ?? [])
      .some(e => JSON.parse(e).type === 'complete')); // the fire-and-forget mirror chain settles
    const mirrored = (redisLists.get('cm:runevents:chat-mirror-a') ?? []).map(e => JSON.parse(e));
    expect(mirrored.some(e => e.data?.content === 'stale')).toBe(false); // DEL'd on start
    expect(mirrored[0]).toMatchObject({ type: 'init', seq: 1 }); // replay begins at the run's start
    expect(mirrored[mirrored.length - 1].type).toBe('complete'); // consumers stop on the terminal marker
    expect(mirrored.every((e, i) => i === 0 || e.seq > mirrored[i - 1].seq)).toBe(true); // ordered, seq-monotonic
  });

  // Stream drops (2026-10-20): a GUEST run (no chatId, a session id) is now
  // mirrored under its SESSION so GET /session/:sessionId/stream can tail it
  // from the other box — never under a chat key. The stale list is DEL'd first.
  it('guest runs (no chatId, a session id) mirror under cm:runevents:session:<sid> — DEL first, terminal included', async () => {
    redisLists.set('cm:runevents:session:sess-mirror-b', [JSON.stringify({ type: 'chunk', data: { content: 'stale' }, seq: 99 })]);
    const key = await startDetachedChatRun({ ...BASE, userId: null, chatId: null, sessionId: 'sess-mirror-b' });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => (redisLists.get('cm:runevents:session:sess-mirror-b') ?? []).some(e => JSON.parse(e).type === 'complete'));
    const mirrored = (redisLists.get('cm:runevents:session:sess-mirror-b') ?? []).map(e => JSON.parse(e));
    expect(mirrored.some(e => e.data?.content === 'stale')).toBe(false);
    expect(mirrored[0]).toMatchObject({ type: 'init', seq: 1 });
    expect([...redisLists.keys()].filter(k => k.startsWith('cm:runevents:'))).toEqual(['cm:runevents:session:sess-mirror-b']);
  });

  it('GUEST_STREAM_ATTACH_DISABLED=1: guest runs are NOT mirrored — process-local, the pre-2026-10-20 behaviour', async () => {
    process.env.GUEST_STREAM_ATTACH_DISABLED = '1';
    try {
      const key = await startDetachedChatRun({ ...BASE, userId: null, chatId: null, sessionId: 'sess-mirror-c' });
      await waitFor(() => !isRunActive(key!));
      expect([...redisLists.keys()].some(k => k.startsWith('cm:runevents:'))).toBe(false);
    } finally {
      delete process.env.GUEST_STREAM_ATTACH_DISABLED;
    }
  });

  it('ephemeral run (logged-in, no chat, no session): the RETURNED key subscribes successfully', async () => {
    // Regression: the controller used to compute its own ephemeral key, so
    // subscribeRun missed the run and the SSE response ended with zero events.
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: null, sessionId: null });
    expect(key).toMatch(/^chat:ephemeral:/);
    const events: Array<{ type: string; data: any }> = [];
    const unsub = subscribeRun(key!, e => events.push(e));
    expect(unsub).not.toBeNull(); // null would be the silent-empty-stream bug
    await waitFor(() => events.some(e => e.type === 'complete' || e.type === 'error'));
    expect(events.some(e => e.type === 'complete')).toBe(true);
    await waitFor(() => !isRunActive(key!));
  });
});

describe("slim 'complete' payload (H3 — Cloudflare-safe SSE size)", () => {
  it('slimChatModelCards truncates responses to 200 chars and keeps metadata', () => {
    const slim = slimChatModelCards({
      glm: { model: 'glm', response: 'R'.repeat(500), time: 1234, modelUsed: 'glm-5.2', webSearchUsed: true },
      deepseek: { model: 'deepseek', response: '', time: 99, error: 'boom' },
    });
    expect(slim.glm.response).toHaveLength(200);
    expect(slim.glm).toMatchObject({ model: 'glm', time: 1234, modelUsed: 'glm-5.2', webSearchUsed: true });
    expect(slim.deepseek.response).toBe('');
    expect(slim.deepseek.error).toBe('boom');
  });

  it('complete event omits summary/message and truncates model cards; DB metadata keeps full responses', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-h3-a', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    const complete = events.find(e => e.type === 'complete')!.data;

    expect('summary' in complete).toBe(false);
    expect('message' in complete).toBe(false);
    // The answer card is the DIGBY SEAT's card ('digby' — owner 2026-09-15: cards
    // are keyed by seat, labelled by seat via modelLabels, and name the served
    // model on the card), never a vendor key (the 2026-08-15 'glm' collision).
    expect(complete.models.glm).toBeUndefined();
    expect(complete.models.kimi).toBeUndefined();
    expect(complete.models.digby.response).toHaveLength(200); // 500-char answer truncated
    expect(complete.models.digby.modelUsed).toBe('kimi-k3');
    expect(complete.models.digby.persona).toBe('Digby');
    expect(typeof complete.models.digby.time).toBe('number');
    expect(complete.modelLabels).toEqual({ digby: 'Digby', double_checker: 'Double Checker', triple_checker: 'Triple Checker' });
    // Fields the frontend DOES read must survive.
    expect(complete).toHaveProperty('synthesisTime');
    expect(complete).toHaveProperty('canvasCount');
    expect(complete).toHaveProperty('sources');
    expect(complete).toHaveProperty('sessionId');

    // The persisted assistant row keeps the FULL response (More-info after reload).
    const assistantWrite = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'assistant');
    expect(assistantWrite.metadata.models.digby.response).toHaveLength(500);
    expect(assistantWrite.metadata.models.digby.modelUsed).toBe('kimi-k3');
    expect(assistantWrite.metadata.modelLabels.digby).toBe('Digby');
    await waitFor(() => !isRunActive('chat-h3-a'));
  });

  it('sources: only the run\'s OWN tool-collected sources render — no forced-SERP harvest, no harness search call (owner 2026-09-03)', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sources-a', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    // The mocked run fired no tools → zero sources (the old path padded the
    // chips from the forced SERP even on tool-free runs), and the chat lane
    // never called searchWithBrightData at all.
    const sources = events.find(e => e.type === 'complete')!.data.sources as Array<{ sourceUrl: string }>;
    expect(sources).toEqual([]);
    expect(searchWithBrightData as jest.Mock).not.toHaveBeenCalled();
    await waitFor(() => !isRunActive('chat-sources-a'));
  });
});

describe('doctrine — connected apps & email composition (hasUser gate)', () => {
  // The runCodingAgent mock captures the doctrine the harness built for the run.
  const doctrineOfLastRun = (): string =>
    (runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]?.doctrineOverride as string;

  it('authenticated run: doctrine lists the app tools and the [SEND_EMAIL] contract', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-doc-a', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    const d = doctrineOfLastRun();
    expect(d).toContain('[SEND_EMAIL');
    expect(d).toContain('gmail_search');
    expect(d).toContain('plaid_get_transactions');
    await waitFor(() => !isRunActive(key!));
  });

  it('anonymous run: doctrine omits all three', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: null, chatId: null, sessionId: 'sess-doc-b' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    const d = doctrineOfLastRun();
    expect(d).not.toContain('[SEND_EMAIL');
    expect(d).not.toContain('gmail_search');
    expect(d).not.toContain('plaid_get_transactions');
    await waitFor(() => !isRunActive(key!));
  });

  it('council lead (deep_research) gets the apps block too when authenticated', async () => {
    const key = await startDetachedChatRun({ message: 'deep q', mode: 'deep_research', userId: 'u1', chatId: 'chat-doc-c', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    const d = doctrineOfLastRun();
    expect(d).toContain('[SEND_EMAIL');
    expect(d).toContain('gmail_search');
    expect(d).toContain('plaid_get_transactions');
    await waitFor(() => !isRunActive(key!));
  });
});

describe('fleet supervisor hook emission (slice B — run finalize)', () => {
  const emittedFor = (chatId: string) =>
    mockEmitHookEventSafe.mock.calls.map((c: any[]) => c).filter((c) => c[0] === chatId);

  it('a completed chat run emits run_completed (no runId) and clears the depth stamp', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-hooks-a', sessionId: null });
    expect(key).toBe('chat:chat-hooks-a');
    await waitFor(() => !isRunActive('chat-hooks-a'));
    await waitFor(() => emittedFor('chat-hooks-a').length > 0);
    const [call] = emittedFor('chat-hooks-a');
    expect(call[1]).toBe('run_completed');
    expect(call[2]).toContain('Chat run completed');
    expect(call[3]).toBeUndefined(); // plain-chat finalize carries no runId
    await waitFor(() => mockClearHookDepth.mock.calls.some((c: any[]) => c[0] === 'chat-hooks-a'));
  });

  it('the run_completed summary surfaces carried structured blocks (ticket 835595b7 F5)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: 'Dispatch posted mid-run (see the block above).',
      parts: [{ type: 'text', text: 'Working…\n\n[DISPATCH-NEEDED] serve ckpt-45 on lane 7fbd168c' }],
      receipts: [],
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-hooks-c', sessionId: null });
    expect(key).toBe('chat:chat-hooks-c');
    await waitFor(() => !isRunActive('chat-hooks-c'));
    await waitFor(() => emittedFor('chat-hooks-c').length > 0);
    const [call] = emittedFor('chat-hooks-c');
    expect(call[1]).toBe('run_completed');
    expect(call[2]).toContain('Carried structured block');
    expect(call[2]).toContain('serve ckpt-45 on lane 7fbd168c');
    await waitFor(() => mockClearHookDepth.mock.calls.some((c: any[]) => c[0] === 'chat-hooks-c'));
  });

  it('a thrown turn emits run_failed from the detached-run catch', async () => {
    (runCodingAgent as jest.Mock).mockRejectedValueOnce(new Error('agent exploded'));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-hooks-b', sessionId: null });
    expect(key).toBe('chat:chat-hooks-b');
    await waitFor(() => !isRunActive('chat-hooks-b'));
    await waitFor(() => emittedFor('chat-hooks-b').length > 0);
    const [call] = emittedFor('chat-hooks-b');
    expect(call[1]).toBe('run_failed');
    expect(call[2]).toContain('agent exploded');
  });
});

describe('zero-tool pre-final gate — machineTriggered threading (coding/agent.ts)', () => {
  it('the orchestrator input carries the run-lock classification: user turn false; machine wake / non-user origin true', async () => {
    // User turn: no machineWake, no messageOrigin — never gated.
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-ztg-user', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-ztg-user'));
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]?.machineTriggered).toBe(false);

    // Machine wake (schedule firing) — gated.
    await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-ztg-wake', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    await waitFor(() => !isRunActive('chat:chat-ztg-wake'));
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]?.machineTriggered).toBe(true);

    // Fleet 'agent' origin without the machineWake flag — the SAME expression
    // the chat-busy run-lock claim uses classifies it machine ⇒ gated.
    await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-ztg-agent', sessionId: null,
      messageOrigin: 'agent', originSourceChatId: 'chat-src',
    });
    await waitFor(() => !isRunActive('chat:chat-ztg-agent'));
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]?.machineTriggered).toBe(true);
  });

  // Owner-dispatch (2026-10-01): a supervisor relaying the OWNER's own-turn ask
  // — platform sendChatMessage stamps ownerDispatch beside the owner anchor —
  // starts a run that is NOT machine-triggered; the rows keep origin 'agent'.
  it('owner-dispatch: ownerDispatch + anchor ⇒ not machine-triggered (userTurnText threaded); without the anchor ⇒ machine', async () => {
    const AT = new Date();
    await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-ztg-od', sessionId: null,
      messageOrigin: 'agent', originSourceChatId: 'chat-src', ownerDispatch: true, userTurnAt: AT,
    } as any);
    await waitFor(() => !isRunActive('chat:chat-ztg-od'));
    const od = (runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0];
    expect(od?.machineTriggered).toBe(false);
    expect(typeof od?.userTurnText).toBe('string');
    // …but UNATTENDED: the agent loop rides the long machine backoff table (unattendedRun).
    expect(od?.ownerDispatch).toBe(true);

    await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-ztg-od-noanchor', sessionId: null,
      messageOrigin: 'agent', originSourceChatId: 'chat-src', ownerDispatch: true,
    } as any);
    await waitFor(() => !isRunActive('chat:chat-ztg-od-noanchor'));
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]?.machineTriggered).toBe(true);
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]).not.toHaveProperty('ownerDispatch');
  });

  it('machineOriginRun: user / absent origin never machine; agent machine unless an anchored owner dispatch; other origins always machine', () => {
    const AT = new Date();
    expect(machineOriginRun({})).toBe(false);
    expect(machineOriginRun({ messageOrigin: 'user' })).toBe(false);
    expect(machineOriginRun({ messageOrigin: 'agent' })).toBe(true);
    expect(machineOriginRun({ messageOrigin: 'agent', userTurnAt: AT })).toBe(true);
    expect(machineOriginRun({ messageOrigin: 'agent', ownerDispatch: true, userTurnAt: AT })).toBe(false);
    expect(machineOriginRun({ messageOrigin: 'agent', ownerDispatch: true })).toBe(true);
    expect(machineOriginRun({ messageOrigin: 'hook', ownerDispatch: true, userTurnAt: AT })).toBe(true);
    expect(machineOriginRun({ messageOrigin: 'schedule', ownerDispatch: true, userTurnAt: AT })).toBe(true);
  });
});

describe('action-verifier wiring (ticket ae085617 — verifier beyond supervisor wakes)', () => {
  beforeEach(() => {
    mockVerifyRunActionClaimsAsync.mockClear();
    mockVerifySupervisorRunAsync.mockClear();
  });

  it('a NON-supervisor turn whose final asserts an action fires the general verifier (machineTriggered=false)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: 'Done — I have filed a ticket for this pattern (id ab12cd34) so triage picks it up.',
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-verif-a', sessionId: null });
    expect(key).toBe('chat:chat-verif-a');
    await waitFor(() => !isRunActive('chat:chat-verif-a'));
    await waitFor(() => mockVerifyRunActionClaimsAsync.mock.calls.length > 0);
    const [call] = mockVerifyRunActionClaimsAsync.mock.calls;
    expect(call[0]).toMatchObject({ chatId: 'chat-verif-a', userId: 'u1', machineTriggered: false });
    expect(call[0].finalText).toContain('filed a ticket');
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
  });

  it('a final with NO action-claim keywords never fires the verifier (cheap pre-gate)', async () => {
    // The default mock final is 'A'.repeat(500) — keyword-free.
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-verif-b', sessionId: null });
    expect(key).toBe('chat:chat-verif-b');
    await waitFor(() => !isRunActive('chat:chat-verif-b'));
    // Give any stray fire-and-forget a beat to land before asserting silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
  });

  // (ticket 4deaf460, 2026-10-08 17:51Z) THE ROUTING DEAD ZONE: chat 99e63f86
  // is the StAnne-CtrlPlaneUI PROJECT SUPERVISOR chat; the owner asked
  // "message the tt-rd supervisor" and the answer asserted "I've messaged
  // chat d1d0b346" while the turn's receipt pool held ZERO sends — the id
  // exists nowhere (the real tt-rd supervisor is chat 810c924d; the real
  // send landed only at 17:53:14Z, receipt 35fcbce8, after the owner's
  // correction). Pre-fix, a HUMAN turn on a supervisor chat matched NEITHER
  // verifier branch: branch 1 requires machineTriggeredRun, branch 2
  // (`!isSupervisorChat && keywords`) refused supervisor chats outright.
  it('(ticket 4deaf460) a HUMAN turn on a SUPERVISOR chat with an action claim now fires the GENERAL verifier (supervisor:true, machineTriggered:false)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'StAnne-CtrlPlaneUI Supervisor · report-up', isProjectSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: `**The tt-rd supervisor is asking the lane directly why 128K didn't land.** I've messaged chat d1d0b346 (the node-a supervisor in the tt-rd project) with the exact live numbers. It runs autonomously, so the answer will come back to me — I'll relay it here as soon as it responds.`,
      parts: [], receipts: [],
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-verif-sup-human', sessionId: null });
    expect(key).toBe('chat:chat-verif-sup-human');
    await waitFor(() => !isRunActive('chat:chat-verif-sup-human'));
    await waitFor(() => mockVerifyRunActionClaimsAsync.mock.calls.length > 0);
    const [call] = mockVerifyRunActionClaimsAsync.mock.calls;
    // General lane (not the supervisor machine-wake shell)…
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
    // …but flagged as a supervisor chat so the state-doc exoneration +
    // durable-refutation lanes stay armed, with the HUMAN consequence shape.
    expect(call[0]).toMatchObject({
      chatId: 'chat-verif-sup-human', userId: 'u1',
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
    });
    expect(call[0].finalText).toContain("I've messaged chat d1d0b346");
    // The incident's phrasing ROUTED: pre-fix ACTION_CLAIM_KEYWORD_RE +
    // STAGING_CLAIM_IDIOM both missed "messaged chat <id>".
    expect(call[0].finalText).not.toBe('');
  });

  it('(ticket 4deaf460) a human turn on a supervisor chat WITHOUT action keywords still never fires the verifier (pre-gate intact)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'StAnne-CtrlPlaneUI Supervisor · report-up', isProjectSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'The fleet is healthy; GPU util is nominal and nothing needs attention right now.', parts: [], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-verif-sup-quiet', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-verif-sup-quiet'));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
  });
});

describe('pre-delivery action guard seam (ticket fcc4dbb4)', () => {
  const GUARD_BANNER = "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]";
  const phantomNote = 'Wake complete. I filed a feedback ticket for the digest regression (ticket id ab12cd34-9999-8888-7777-666655554444) so triage picks it up.';
  const guardNotice = `${GUARD_BANNER}\nStruck phantom claim(s):\n- [ticket] "filed a feedback ticket for the digest regression" (cited id ab12cd34-9999-8888-7777-666655554444)`;
  const guardReplacement = `${guardNotice}\n\n--- BEGIN STRUCK NOTE ---\n> ${phantomNote}\n--- END STRUCK NOTE ---`;
  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'assistant');

  beforeEach(() => {
    mockGuardMachineWakeFinalAnswer.mockClear();
    mockVerifyRunActionClaimsAsync.mockClear();
    mockVerifySupervisorRunAsync.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear(); // reject-back outcome rows accumulate across tests otherwise
    // Gate flip 2026-09-11 (owner: full steam): the verifier is OBSERVE-ONLY by
    // default. The strike / reject-back contracts below are pinned under the
    // opt-in; the default path has its own test at the end of this block.
    process.env.ACTION_VERIFIER_ENFORCE = '1';
  });
  afterEach(() => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    // Restore the module-scope defaults a supervisor test overrode.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('DEFAULT (gate flip 2026-09-11, ACTION_VERIFIER_ENFORCE unset): a struck supervisor note is delivered UNMODIFIED — one observed guard_strike row, no reject-back, no notice part, no correction row', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
      phantoms: [{ kind: 'message', detail: 'lane audit msg 4ac92734', id: '4ac92734' }],
      rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      correction: '[ACTION VERIFIER — automated integrity check] …',
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-observed', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-observed'));

    // ONE orchestrator run (no reject-back re-orchestration), ONE guard pass.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    // The committed note is the model's own text — nothing removed, no banner.
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(phantomNote);
    expect(assistantWrites()[0].content).not.toContain(GUARD_BANNER);
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    expect(writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier')).toHaveLength(0);
    // Observed telemetry: the verdict is recorded with the phantom kinds/ids.
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'guard_strike', sessionId: 'chat-guard-observed', meta: { guard: 'action-verifier', outcome: 'observed', phantoms: 1, kinds: ['message'], ids: ['4ac92734'] } });
    // Single-audit still holds: the guard audited, so the post-delivery lane stays down.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
  });

  describe('BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20) — action-class footnote + owner-briefing claims', () => {
    const FOOTNOTE_HEADER = '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]';
    const actionNote = [
      '**CanLaw** — dispatched the bench rerun to the GPU lane → results tonight',
      '**Tenstorrent** — speed check passed → next comparison queued → no ETA yet',
    ].join('\n');
    const idLessPhantom = { kind: 'dispatch', detail: 'dispatched the bench rerun to the GPU lane' };
    const runObservedWake = async (chatId: string, opts: { note?: string; phantoms?: any[]; parts?: any[]; machineWake?: boolean; messageOrigin?: string } = {}) => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
      const note = opts.note ?? actionNote;
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: opts.parts ?? [], receipts: [] });
      const phantoms = opts.phantoms;
      if (phantoms) {
        mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
          finalText: `${a.finalText}\n\n[annotation the seam must not deliver for an action-class verdict]`, notice: 'n', struck: true, audited: true,
          phantoms, delivery: 'annotated', correction: 'c',
        }));
      }
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId, sessionId: null, machineWake: opts.machineWake ?? true, messageOrigin: (opts.messageOrigin ?? 'schedule') as any });
      const events: Array<{ type: string; data: any }> = [];
      subscribeRun(key!, (e) => events.push(e));
      await waitFor(() => events.some((e) => e.type === 'complete'));
      await waitFor(() => !isRunActive(`chat:${chatId}`));
      await new Promise((r) => setTimeout(r, 30)); // the briefing's dynamic import settles
      return { note, events };
    };
    beforeEach(() => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      delete process.env.ACTION_CLASS_ANNOTATE_DISABLED;
      delete process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED;
      mockGenerateOwnerBriefing.mockClear();
      mockCitedIdExistsAnywhere.mockClear();
      (runCodingAgent as jest.Mock).mockClear();
    });
    afterEach(() => {
      delete process.env.ACTION_CLASS_ANNOTATE_DISABLED;
      delete process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED;
    });

    it('an ID-LESS action-class conviction delivered observe-only gets ONE trailing footnote (note kept as written), one action_class_annotated row, and rides the briefing as an unverified claim on the footnote-free note', async () => {
      const { note, events } = await runObservedWake('chat-unverified-footnote', { phantoms: [idLessPhantom] });
      expect(assistantWrites()).toHaveLength(1);
      const content: string = assistantWrites()[0].content;
      expect(content.startsWith(note)).toBe(true); // nothing in the note was removed or changed
      const footnote = content.slice(note.length).trim();
      expect(footnote.startsWith(FOOTNOTE_HEADER)).toBe(true);
      expect(footnote).toContain('- [dispatch] "dispatched the bench rerun to the GPU lane"');
      expect(footnote).not.toMatch(/\n\s*\n/); // one paragraph — guard-chrome-redact strips it whole
      expect(content).not.toContain('[annotation the seam must not deliver'); // the guard's own text never ships for action-class
      const parts = assistantWrites()[0].parts as any[];
      expect(parts[parts.length - 1]).toMatchObject({ type: 'text', text: footnote });
      const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessionId: 'chat-unverified-footnote', value: 1, meta: { supervisorScope: 'fleet', zeroTool: true, footnoted: true, briefingFiltered: true, sources: { action_verifier: 1, zero_tool_dispatch: 0 } } });
      expect(footnote).toContain('An owner briefing written from this note marks them as unverified or leaves them out.');
      // The observe-only outcome row is unchanged (outcome 'observed').
      const obs = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back');
      expect(obs).toHaveLength(1);
      expect(obs[0].meta.outcome).toBe('observed');
      // Live viewers get the appended footnote (an APPEND — never the `corrected` marker).
      const complete = events.find((e) => e.type === 'complete')!.data;
      expect(complete.finalText).toBe(content);
      expect(complete.corrected).toBeUndefined();
      // The briefing: the model's note (footnote off) + the claim.
      expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
      const bArgs = mockGenerateOwnerBriefing.mock.calls[0][0];
      expect(bArgs.noteContent).toBe(note);
      expect(bArgs.unverifiedClaims).toEqual([{ kind: 'dispatch', quote: 'dispatched the bench rerun to the GPU lane', source: 'action_verifier' }]);
    });

    it('an ID-BEARING action-class conviction is id-exonerated: no footnote, no row, no briefing claims (the note and briefing input are byte-identical to before)', async () => {
      const { note } = await runObservedWake('chat-unverified-idbearing', { phantoms: [{ kind: 'message', detail: 'lane audit msg 4ac92734', id: '4ac92734' }] });
      expect(assistantWrites()[0].content).toBe(note);
      expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated')).toHaveLength(0);
      expect(mockGenerateOwnerBriefing.mock.calls[0][0].noteContent).toBe(note);
      expect(mockGenerateOwnerBriefing.mock.calls[0][0].unverifiedClaims).toBeUndefined();
    });

    it('ZERO-TOOL wake: a first-person dispatch claim the verifier did not convict is convicted by construction (footnote + briefing claim, source zero_tool_dispatch)', async () => {
      const note = [
        '**CanLaw** — benchmark pack finished → drafting the summary next → tomorrow evening',
        'I dispatched the summary draft to the writing lane for the morning run.',
      ].join('\n');
      const { events } = await runObservedWake('chat-unverified-zerotool', { note });
      const content: string = assistantWrites()[0].content;
      expect(content.startsWith(note)).toBe(true);
      expect(content).toContain(FOOTNOTE_HEADER);
      expect(content).toContain('this run made no tool call at all');
      expect(content).toContain('- [dispatch] "I dispatched the summary draft to the writing lane for the morning run."');
      const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated');
      expect(rows).toHaveLength(1);
      expect(rows[0].meta.sources).toEqual({ action_verifier: 0, zero_tool_dispatch: 1 });
      const bArgs = mockGenerateOwnerBriefing.mock.calls[0][0];
      expect(bArgs.noteContent).toBe(note);
      expect(bArgs.unverifiedClaims).toHaveLength(1);
      expect(bArgs.unverifiedClaims[0]).toMatchObject({ kind: 'dispatch', source: 'zero_tool_dispatch' });
      expect(events.find((e) => e.type === 'complete')!.data.finalText).toBe(content);
    });

    it('a wake that made a tool call never convicts a send claim by construction (the verifier verdict is the only source)', async () => {
      const note = 'I dispatched the summary draft to the writing lane for the morning run.';
      await runObservedWake('chat-unverified-withtool', {
        note,
        parts: [{ type: 'tool_call', name: 'get_chat_messages', args: {} }, { type: 'tool_result', name: 'get_chat_messages', result: '{"ok":true}' }],
      });
      expect(assistantWrites()[0].content).not.toContain(FOOTNOTE_HEADER);
      expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated')).toHaveLength(0);
    });

    it('REVIEW FIX (2026-10-20): a ZERO-TOOL dispatch naming a REAL lane by id is footnoted and marked for the briefing — the target existing is never evidence (no anywhere-probe)', async () => {
      // The unbacked lane's own honest-reference read sees no receipt for the id (it is a lane chat id, not a receipt).
      mockPrisma.runToolReceipt = { findFirst: jest.fn(async () => null) };
      const note = '**Bench** — I messaged lane 7fbd168c to rerun the eval → ETA 2h';
      try {
        mockCitedIdExistsAnywhere.mockResolvedValue(true); // lane 7fbd168c is a real chat
        await runObservedWake('chat-unverified-realid', { note });
        const content: string = assistantWrites()[0].content;
        expect(content.startsWith(note)).toBe(true);
        expect(content).toContain(FOOTNOTE_HEADER);
        expect(content).toContain('this run made no tool call at all');
        expect(mockCitedIdExistsAnywhere).not.toHaveBeenCalled();
        const bArgs = mockGenerateOwnerBriefing.mock.calls[0][0];
        expect(bArgs.unverifiedClaims).toHaveLength(1);
        expect(bArgs.unverifiedClaims[0]).toMatchObject({ source: 'zero_tool_dispatch' });
        expect(bArgs.unverifiedClaims[0].quote).toContain('7fbd168c');
      } finally {
        mockCitedIdExistsAnywhere.mockResolvedValue(false);
        delete mockPrisma.runToolReceipt;
      }
    });

    it('REVIEW FIX: a verifier claim is exonerated only by an executed ACTION receipt of THIS chat (ok, non-read tool, chatId-scoped) — a sentence naming only the target lane is footnoted', async () => {
      const readParts = [{ type: 'tool_call', name: 'get_chat_messages', args: {} }, { type: 'tool_result', name: 'get_chat_messages', result: '{"ok":true}' }];
      const phantom = { kind: 'message', detail: 'messaged the lane to rerun the eval' };
      const receiptFindFirst = jest.fn(async ({ where }: any) => (
        where?.chatId === 'chat-unverified-receipt' && where?.ok === true && Array.isArray(where?.tool?.notIn)
          && where.tool.notIn.includes('get_chat_messages') && where?.id?.startsWith === '1a2b3c4d' ? { id: '1a2b3c4d-0000-4000-8000-000000000000' } : null));
      mockPrisma.runToolReceipt = { findFirst: receiptFindFirst };
      try {
        // Cites a real action receipt of this chat → an honest reference to an earlier send: no footnote.
        const withReceipt = '**Bench** — messaged the lane 7fbd168c to rerun the eval (receipt 1a2b3c4d) → ETA 2h';
        await runObservedWake('chat-unverified-receipt', { note: withReceipt, phantoms: [phantom], parts: readParts });
        expect(assistantWrites()[0].content).toBe(withReceipt);
        expect(receiptFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-unverified-receipt', ok: true }) }));
        // Names only the target lane (a real chat) → footnoted.
        mockPrisma.crossModelMessage.create.mockClear();
        mockCitedIdExistsAnywhere.mockResolvedValue(true);
        const laneOnly = '**Bench** — messaged the lane 7fbd168c to rerun the eval → ETA 2h';
        await runObservedWake('chat-unverified-laneonly', { note: laneOnly, phantoms: [phantom], parts: readParts });
        expect(assistantWrites()[0].content).toContain(FOOTNOTE_HEADER);
        expect(mockCitedIdExistsAnywhere).not.toHaveBeenCalled();
      } finally {
        mockCitedIdExistsAnywhere.mockResolvedValue(false);
        delete mockPrisma.runToolReceipt;
      }
    });

    it('REVIEW FIX: a supervisor machine run that is NOT a wake (agent-message drain) gets the footnote WITHOUT the briefing promise; briefingFiltered:false; no briefing', async () => {
      const { note } = await runObservedWake('chat-unverified-drain', { phantoms: [idLessPhantom], machineWake: false, messageOrigin: 'agent' });
      const content: string = assistantWrites()[0].content;
      expect(content.startsWith(note)).toBe(true);
      expect(content).toContain(FOOTNOTE_HEADER);
      expect(content).not.toContain('owner briefing');
      const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated');
      expect(rows).toHaveLength(1);
      expect(rows[0].meta.briefingFiltered).toBe(false);
      expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
    });

    it('ACTION_CLASS_ANNOTATE_DISABLED=1: no footnote (note as written), the briefing filter still gets the claims', async () => {
      process.env.ACTION_CLASS_ANNOTATE_DISABLED = '1';
      const { note } = await runObservedWake('chat-unverified-annotate-off', { phantoms: [idLessPhantom] });
      expect(assistantWrites()[0].content).toBe(note);
      const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated');
      expect(rows).toHaveLength(1);
      expect(rows[0].meta.footnoted).toBe(false);
      expect(mockGenerateOwnerBriefing.mock.calls[0][0].unverifiedClaims).toHaveLength(1);
    });

    it('BRIEFING_UNVERIFIED_FILTER_DISABLED=1: the footnote still lands, the briefing gets the note exactly as before (no claims)', async () => {
      process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED = '1';
      const { note } = await runObservedWake('chat-unverified-filter-off', { phantoms: [idLessPhantom] });
      const content: string = assistantWrites()[0].content;
      expect(content).toContain(FOOTNOTE_HEADER);
      expect(content).not.toContain('The owner briefing marks them');
      const bArgs = mockGenerateOwnerBriefing.mock.calls[0][0];
      expect(bArgs.noteContent).toBe(note);
      expect(bArgs.unverifiedClaims).toBeUndefined();
    });

    it('both switches on: byte-identical to the pre-change delivery (no footnote, no row, no claims)', async () => {
      process.env.ACTION_CLASS_ANNOTATE_DISABLED = '1';
      process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED = '1';
      const { note } = await runObservedWake('chat-unverified-both-off', { phantoms: [idLessPhantom] });
      expect(assistantWrites()[0].content).toBe(note);
      expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated')).toHaveLength(0);
      expect(mockGenerateOwnerBriefing.mock.calls[0][0]).toEqual(expect.objectContaining({ noteContent: note }));
      expect(mockGenerateOwnerBriefing.mock.calls[0][0].unverifiedClaims).toBeUndefined();
    });

    it('a NON-supervisor machine wake never gets the footnote', async () => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: actionNote, parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: 'n', struck: true, audited: true, phantoms: [idLessPhantom] }));
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-unverified-plain', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
      const events: Array<{ type: string; data: any }> = [];
      subscribeRun(key!, (e) => events.push(e));
      await waitFor(() => events.some((e) => e.type === 'complete'));
      await waitFor(() => !isRunActive('chat:chat-unverified-plain'));
      expect(assistantWrites()[0].content).toBe(actionNote);
    });
  });

  it('build 2026-10-08 F-2: a supervisor wake carrying a finish_run SHADOW record gets ONE finish_run_agreement row (the action verifier verdict on the SAME note) — the note is delivered unmodified', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const finishRun = {
      source: 'nudged', calls: 1, offered: true, nudge: { outcome: 'called', ms: 900 }, status: 'done', valid: false, errors: [], repairs: [],
      claims: 1, verified: 0, unverified: 1, unverifiable: 0, scopeMismatch: 0, byVia: {}, claimTypes: { ticket_update: 1 }, aliasTypes: 0,
      rejected: [{ type: 'ticket_update', ref: 'ab12cd34', reason: 'no_receipt' }], unverifiableRefs: [], openItems: 0, openKinds: {},
      undeclared: 0, undeclaredSample: [], summaryChars: 30, finalChars: phantomNote.length, receiptsAtCall: 0,
    };
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [], finishRun });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
      phantoms: [{ kind: 'ticket', detail: 'filed a feedback ticket', id: 'ab12cd34' }],
      rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-finish-agree', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-finish-agree'));
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'finish_run_agreement');
    expect(rows).toEqual([expect.objectContaining({
      sessionId: 'chat-finish-agree',
      meta: expect.objectContaining({ detector: 'action_verifier', cell: 'both_flagged', agree: true, finishSource: 'nudged', finishValid: false, detectorConvicted: true, detectorKinds: ['ticket'], finishRejectedTypes: ['ticket_update'], supervisorScope: 'fleet' }),
    })]);
  });

  it('(ticket b216475a) an AGENT-ORIGIN supervisor run (messageOrigin agent, machineWake UNSET) now RUNS the guard; the post-delivery verifier stands down when audited', async () => {
    // The 2026-09-13 incident seam: the Fleet Supervisor's notes ca59c504 /
    // 3e5775d4 were anchored by send_chat_message lane reports (origin 'agent',
    // machineWake unset) — pre-fix NEITHER the pre-delivery guard nor the
    // supervisor post-delivery lane ran on them, and four fabricated ticket
    // ids delivered twice. The widened seam audits agent-anchored supervisor
    // runs exactly like machine wakes.
    delete process.env.ACTION_VERIFIER_ENFORCE;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Lane report: all quiet; nothing cited.', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-agentorigin', sessionId: null,
      messageOrigin: 'agent', originSourceChatId: 'chat-src',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-agentorigin'));

    // The guard RAN (pre-fix: never called on an agent-anchored run) with the
    // supervisor machine-run inputs.
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toMatchObject({
      chatId: 'chat-guard-agentorigin', userId: 'u1', supervisor: true, machineTriggered: true, deferConsequences: true,
    });
    // Clean + audited → the post-delivery supervisor verifier stands down
    // (single-audit). Its fail-open backstop is pinned by the next test.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
  });

  it('(ticket b216475a) an AGENT-ORIGIN supervisor run whose guard FAILED OPEN (audited:false) gets the widened post-delivery supervisor verifier as backstop', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Lane report: all quiet; nothing cited.', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: false,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-agentfo', sessionId: null,
      messageOrigin: 'agent', originSourceChatId: 'chat-src',
    });
    subscribeRun(key!, () => {});
    // Pre-fix the post-delivery lane was gated `isSupervisorChat &&
    // args.machineWake` — an agent-anchored run NEVER reached it, even as the
    // guard's fail-open backstop. Widened to machineTriggeredRun, it fires.
    await waitFor(() => mockVerifySupervisorRunAsync.mock.calls.length > 0);
    expect(mockVerifySupervisorRunAsync).toHaveBeenCalledTimes(1);
    expect(mockVerifySupervisorRunAsync.mock.calls[0][0]).toMatchObject({ chatId: 'chat-guard-agentfo', userId: 'u1' });
    await waitFor(() => !isRunActive('chat:chat-guard-agentfo'));
  });

  it('(fleet 17:14Z, 2026-09-15) MIXED strike in observe-only mode: the first guard pass runs under consequenceScope citation-only, the deterministic subset is ENFORCED, and the action-class rest is recorded as observed (mixed:true) — never silently dropped', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    (runCodingAgent as jest.Mock).mockClear();
    // A fabricated-id ACTION conviction (the verifier stamps fabricatedId — the
    // seam's classifier treats it as citation-class) beside an id-less
    // action-class conviction the guard handed back as observedPhantoms.
    const fabricated = { kind: 'schedule', detail: 'schedule_message → sched 88d9287e — CanLaw artifact-check monitor re-armed', id: '88d9287e', fabricatedId: true };
    const observed = { kind: 'message', detail: 'I nudged the CanLaw coordinator lane to re-verify its artifact check.' };
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
      phantoms: [fabricated],
      observedPhantoms: [observed],
      correction: 'corr',
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-mixed', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-mixed'));

    // The FIRST pass already carries the observe-only scope (the guard splits a
    // mixed verdict there — the seam never sees a heterogeneous set).
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toMatchObject({ consequenceScope: 'citation-only', deferConsequences: true });
    // The deterministic conviction is enforced: the guard's redacted text is the committed note.
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(guardReplacement);
    // Telemetry: ONE enforced row (naming the fabricated id) + ONE observed row for the action-class rest, mixed:true.
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'guard_strike');
    const enforced = rows.filter((m: any) => m?.meta?.seam === 'machine_wake_citation_enforce');
    expect(enforced).toHaveLength(1);
    expect(enforced[0].meta).toMatchObject({ outcome: 'enforced', phantoms: 1, kinds: ['schedule'], ids: ['88d9287e'], fabricatedIds: 1 });
    const obs = rows.filter((m: any) => m?.meta?.outcome === 'observed');
    expect(obs).toHaveLength(1);
    expect(obs[0].meta).toMatchObject({ seam: 'machine_wake_reject_back', mixed: true, phantoms: 1, kinds: ['message'], supervisorScope: 'fleet' });
    expect(rows).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
  });

  it('(ticket b216475a) ALWAYS-ON citation enforcement: ACTION_VERIFIER_ENFORCE unset + an ALL-citation-class strike still REPLACES the note, writes the correction row, and records seam machine_wake_citation_enforce outcome enforced', async () => {
    // The core containment: the 2026-09-11 observe-only flip was driven by
    // message-ACTION false positives (the coin-flip LLM lane); the
    // deterministic citation lanes (row-existence + haystack exoneration) are
    // false-positive-safe and keep their pre-delivery bite even in
    // observe-only mode.
    delete process.env.ACTION_VERIFIER_ENFORCE;
    (runCodingAgent as jest.Mock).mockClear();
    const citationPhantom = { kind: 'ticket', detail: '[evidence citation] Receipts: tickets 1322de9e (file_feedback) this run.', id: '1322de9e' };
    const citationCorrection = '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it cited evidence id(s) that DO NOT EXIST …';
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
      phantoms: [citationPhantom],
      correction: citationCorrection,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-citenf', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-citenf'));

    // ONE orchestrator run (no rejectBackNotice armed → no re-orchestration),
    // ONE guard pass.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    // The committed note is the guard's REPLACEMENT — citation-class strikes
    // bite even with ACTION_VERIFIER_ENFORCE unset.
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(guardReplacement);
    expect(assistantWrites()[0].parts[0]).toEqual({ type: 'text', text: guardNotice });
    // The correction row landed (user-role harness message, after the
    // replacement row).
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    const correctionWrites = writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier');
    expect(correctionWrites).toHaveLength(1);
    expect(correctionWrites[0].content).toBe(citationCorrection);
    // Telemetry: the enforced citation strike row (seam
    // machine_wake_citation_enforce) is the ONLY outcome row for this strike.
    // Hardening review 2026-09-14: the observe-only 'observed' row used to be
    // recorded for this strike TOO (stating the note was "delivered
    // unmodified" while it was redacted), so one wake counted 2 strikes.
    const citeRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_citation_enforce');
    expect(citeRows).toHaveLength(1);
    expect(citeRows[0]).toMatchObject({
      kind: 'guard_strike', sessionId: 'chat-guard-citenf',
      meta: { guard: 'action-verifier', outcome: 'enforced', phantoms: 1, kinds: ['ticket'], ids: ['1322de9e'], supervisorScope: 'fleet' },
    });
    const obsRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back' && m?.meta?.outcome === 'observed');
    expect(obsRows).toHaveLength(0);
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'guard_strike')).toHaveLength(1); // exactly ONE guard_strike row per strike
    // The post-delivery lane still stands down — the guard audited.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
  });

    it('reject-back retry SEED (autonomy loop #11): the retry\'s user turn carries the rejected draft (quoted) + this run\'s tool results, and the outcome row records seeded + retryMs', async () => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      (runCodingAgent as jest.Mock).mockClear();
      const citationPhantom = { kind: 'ticket', detail: '[evidence citation] Receipts: tickets 1322de9e (file_feedback) this run.', id: '1322de9e' };
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: phantomNote, parts: [
          { type: 'tool_call', name: 'get_chat_status', args: { chatId: 'b92ef13f' } },
          { type: 'tool_result', name: 'get_chat_status', result: 'chat b92ef13f: idle since 11:20:03Z' },
        ], receipts: [] })
        .mockResolvedValueOnce({ finalText: 'Rewritten note — lane idle since 11:20:03Z (get_chat_status this run).', parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer
        .mockImplementationOnce(async () => ({
          finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
          phantoms: [citationPhantom],
          rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
        }))
        .mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-guard-seed', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive('chat:chat-guard-seed'));
      expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
      const retryMsg = String((runCodingAgent as jest.Mock).mock.calls[1][0].userMessage);
      expect(retryMsg).toContain('[HARNESS NOTICE] rejected — re-verify');
      expect(retryMsg).toContain('[HARNESS — YOUR REJECTED ATTEMPT, FOR REWRITING — not typed by the user]');
      expect(retryMsg).toContain(`> ${phantomNote}`); // the draft rides QUOTED
      expect(retryMsg).toContain('[1] get_chat_status:\nchat b92ef13f: idle since 11:20:03Z'); // this run's tool result rides along
      // The first attempt's message had NO seed.
      expect(String((runCodingAgent as jest.Mock).mock.calls[0][0].userMessage)).not.toContain('YOUR REJECTED ATTEMPT');
      const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back' && m?.meta?.citationRetry);
      expect(rows).toHaveLength(1);
      expect(rows[0].meta).toMatchObject({ citationRetry: 'clean', seeded: true });
      expect(typeof rows[0].meta.retryMs).toBe('number');
      // The delivered note is the retry's clean text.
      const asst = assistantWrites();
      expect(asst[asst.length - 1].content).toContain('Rewritten note');
    });


  it('(ticket b216475a, review F1) post-reject-back ACTION-class second-pass is NOT enforced: citation-class first-pass armed a reject-back, retry convicted action-class → delivered UNMODIFIED in observe-only mode', async () => {
    // The regression the adversarial reviewer caught: the citation-enforce
    // branch classified the FIRST-pass verdict, but the reject-back second pass
    // reassigns `guarded` to a FULL re-guard (LLM action lane included) — an
    // action-class second-pass strike would have been ENFORCED with
    // ACTION_VERIFIER_ENFORCE unset, silently regressing the 2026-09-11 flip.
    // The fix re-classifies on the verdict that STANDS. Pin it: a citation-class
    // first-pass that arms a reject-back, whose retry is convicted ACTION-class,
    // must deliver the retry UNMODIFIED (no citation-enforce row, no correction).
    delete process.env.ACTION_VERIFIER_ENFORCE;
    (runCodingAgent as jest.Mock).mockClear();
    const citationPhantom = { kind: 'ticket', detail: '[evidence citation] Receipts: tickets 1322de9e (file_feedback) this run.', id: '1322de9e' };
    const actionPhantom = { kind: 'message', detail: 'lane audit msg 4ac92734', id: '4ac92734' }; // NOT citation-tagged
    const retryText = 'Re-verified wake note — lane audit msg 4ac92734 (a real read).';
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    // Attempt 1 (citation-class strike, arms a reject-back) → attempt 2 (retry text).
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: retryText, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer
      // First pass: citation-class, struck, defers consequences → rejectBackNotice.
      .mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
        phantoms: [citationPhantom],
        rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      }))
      // Second pass (consequences ON, on the retry's text): ACTION-class strike.
      .mockImplementationOnce(async () => ({
        finalText: 'ACTION REPLACEMENT SHOULD NOT BE DELIVERED', notice: 'action notice', struck: true, audited: true,
        phantoms: [actionPhantom],
        correction: '[ACTION VERIFIER] action correction',
      }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-reclass', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-reclass'));

    // Two orchestrator runs (reject-back fired) + two guard passes.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    // The verdict that STANDS is action-class → NOT enforced: the committed note
    // is the retry's own text, NOT the action replacement.
    const asst = assistantWrites();
    expect(asst.length).toBeGreaterThanOrEqual(1);
    expect(asst[asst.length - 1].content).not.toBe('ACTION REPLACEMENT SHOULD NOT BE DELIVERED');
    // No citation-enforce row for an action-class verdict.
    const citeRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_citation_enforce');
    expect(citeRows).toHaveLength(0);
    // No verifier correction row persisted for the action-class verdict.
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    expect(writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier')).toHaveLength(0);
    // Hardening review 2026-09-14: the outcome row is keyed on the verdict that
    // STANDS — exactly ONE 'observed' row, carrying the action-class SECOND
    // pass's phantoms (a first-pass-keyed condition would have recorded none),
    // plus the one per-cycle reject_back row (citationRetry 'still_dirty').
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back');
    const obsRows = rows.filter((m: any) => m?.meta?.outcome === 'observed');
    expect(obsRows).toHaveLength(1);
    expect(obsRows[0]).toMatchObject({ kind: 'guard_strike', sessionId: 'chat-guard-reclass', meta: { phantoms: 1, kinds: ['message'], ids: ['4ac92734'], supervisorScope: 'fleet' } });
    expect(rows.filter((m: any) => m?.meta?.citationRetry === 'still_dirty')).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('(ticket b216475a) observe-only preserved for ACTION-class strikes: ACTION_VERIFIER_ENFORCE unset + a non-citation strike delivers UNMODIFIED (observed telemetry only, no citation-enforce row)', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
      phantoms: [{ kind: 'message', detail: 'lane audit msg 4ac92734', id: '4ac92734' }],
      correction: '[ACTION VERIFIER — automated integrity check] …',
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-actobs', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-actobs'));

    // Action-class conviction (detail NOT citation-tagged): the 2026-09-11
    // default is untouched — delivered UNMODIFIED, observed telemetry only.
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(phantomNote);
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    expect(writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier')).toHaveLength(0);
    const citeRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_citation_enforce');
    expect(citeRows).toHaveLength(0);
    const obsRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back' && m?.meta?.outcome === 'observed');
    expect(obsRows).toHaveLength(1);
  });

  it('(supervisor doctrine audit D1, 2026-09-27) PRODUCTION-STATE UNREAD lane: a serving sentence resting on nothing this run read mints ONE observed guard_strike row (seam machine_wake_production_state) and the note delivers UNMODIFIED', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const sparkNote = 'Serving status: stock NVFP4 433 GiB is serving on the 4-node cluster.\n\nWAKE: no-op — nothing moved on any project since the previous wake';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: sparkNote, parts: [], receipts: [] });
    // The guard passes clean — the production-state lane is INDEPENDENT of its verdict.
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, audited: true, phantoms: [] }));
    mockFindUnreadProductionState.mockClear();
    mockFindUnreadProductionState.mockImplementationOnce(() => [
      { sentence: 'Serving status: stock NVFP4 433 GiB is serving on the 4-node cluster.', factTokens: ['nvfp4', '433', '4-node'], reason: 'tokens_unread' },
    ]);
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-prod-state', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-prod-state'));

    // The matcher saw the delivered text + this run's parts/receipts.
    expect(mockFindUnreadProductionState).toHaveBeenCalledTimes(1);
    expect(mockFindUnreadProductionState.mock.calls[0][0]).toBe(sparkNote);
    // …and the note's OWN chat id, so a get_chat_messages re-read of its prior notes grounds nothing (review fix 2026-09-27).
    expect(mockFindUnreadProductionState.mock.calls[0][1]).toMatchObject({ parts: [], receipts: [], selfChatId: 'chat-prod-state' });
    // OBSERVE-ONLY: delivered unmodified, no notice part, no correction row, no reject-back.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(sparkNote);
    expect(assistantWrites()[0].content).not.toContain(GUARD_BANNER);
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    expect(writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier')).toHaveLength(0);
    // Exactly ONE telemetry row for the lane, keyed by strike + seam, carrying the sentence and its tokens.
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_production_state');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'guard_strike', sessionId: 'chat-prod-state',
      meta: { guard: 'action-verifier', outcome: 'observed', strike: 'production_state_unread', hits: 1, reasons: ['tokens_unread'], supervisorScope: 'fleet' },
    });
    expect(rows[0].meta.sentences[0]).toMatchObject({ sentence: 'Serving status: stock NVFP4 433 GiB is serving on the 4-node cluster.', factTokens: ['nvfp4', '433', '4-node'] });
    // No hit ⇒ no row (the default stub) — pinned by every other test in this block, whose rows never carry this seam.
  });

  it('(D1, 2026-09-27) PRODUCTION-STATE lane fails OPEN: a throwing matcher leaves the note and the guard path untouched', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const note = 'GLM-5.3 is deployed on nodes 1-4.\n\nWAKE: no-op — nothing moved on any project since the previous wake';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, audited: true, phantoms: [] }));
    mockFindUnreadProductionState.mockImplementationOnce(() => { throw new Error('boom'); });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-prod-state-throw', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-prod-state-throw'));
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(note);
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_production_state');
    expect(rows).toHaveLength(0);
  });

  it('(D1, 2026-09-27) PRODUCTION-STATE lane is SUPERVISOR-only: a non-supervisor machine wake never calls the matcher', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    mockFindUnreadProductionState.mockClear();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'NVFP4 433 GiB is serving on the cluster. I dispatched nothing.', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, audited: true, phantoms: [] }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-prod-state-lane', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-prod-state-lane'));
    expect(mockFindUnreadProductionState).not.toHaveBeenCalled();
  });

  // Hardening review 2026-09-14: supervisorScope — the seat label the verifier's
  // attribution surfaces (phantom ticket prose/area/context, guard_strike meta)
  // key on. Label-only; every verdict and consequence is unchanged.
  describe('supervisorScope threading (hardening review 2026-09-14 — project vs fleet seat)', () => {
    it("a PROJECT supervisor machine wake passes supervisorScope 'project' to the guard and stamps it on the observed guard_strike row", async () => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Alpha Supervisor', isProjectSupervisor: true, userId: 'u1' }));
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true, audited: true,
        phantoms: [{ kind: 'message', detail: 'lane audit msg 4ac92734', id: '4ac92734' }],
      }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-scope-project', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive('chat:chat-scope-project'));

      expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
      expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toMatchObject({ supervisor: true, supervisorScope: 'project', machineTriggered: true });
      const obsRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back' && m?.meta?.outcome === 'observed');
      expect(obsRows).toHaveLength(1);
      expect(obsRows[0].meta.supervisorScope).toBe('project');
      // Observe-only is untouched by the label: delivered unmodified.
      expect(assistantWrites()[0].content).toBe(phantomNote);
    });

    it("the FLEET supervisor passes supervisorScope 'fleet' (the pre-2026-09-14 default made explicit)", async () => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Lane report: all quiet.', parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-scope-fleet', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive('chat:chat-scope-fleet'));
      expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toMatchObject({ supervisor: true, supervisorScope: 'fleet' });
    });

    it("a NON-supervisor machine wake passes NO supervisorScope (label is supervisor-only)", async () => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Nothing to report.', parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-scope-none', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive('chat:chat-scope-none'));
      expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
      expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0].supervisor).toBe(false);
      expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0].supervisorScope).toBeUndefined();
    });

    it("the post-delivery backstop (guard failed open) forwards supervisorScope 'project' to verifySupervisorRunAsync", async () => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Alpha Supervisor', isProjectSupervisor: true, userId: 'u1' }));
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Lane report: all quiet; nothing cited.', parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: false }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-scope-backstop', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => mockVerifySupervisorRunAsync.mock.calls.length > 0);
      expect(mockVerifySupervisorRunAsync.mock.calls[0][0]).toMatchObject({ chatId: 'chat-scope-backstop', userId: 'u1', supervisorScope: 'project' });
      await waitFor(() => !isRunActive('chat:chat-scope-backstop'));
    });
  });

  // Ticket 69d0c808 (mishap replay, WIRING half — the block builder's unit
  // replay lives in supervisor-state.project-schedules.test.ts): a PROJECT
  // supervisor's machine wake previously got NO live per-lane schedule truth
  // (fleet blocks are owner-scoped), so it composed cadence claims from
  // memory and confabulated schedule ids the delivery guard had to strike.
  // The wake now bakes the project's live [PROJECT SCHEDULES] table into the
  // persisted wake prompt.
  describe('project-supervisor wake schedule truth (ticket 69d0c808)', () => {
    beforeEach(() => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Alpha Supervisor', isProjectSupervisor: true, userId: 'u1', projectId: 'p-alpha' }));
      mockPrisma.crossModelChat.findMany = jest.fn(async () => [
        { id: 'lane-deaf-0001', title: 'Deaf lane' },
        { id: 'lane-armed-001', title: 'Armed lane' },
      ]);
      mockPrisma.chatSchedule = {
        findMany: jest.fn(async () => [
          { id: 'sch-live-1', sessionId: 'lane-armed-001', nextRunAt: new Date(Date.now() + 3_600_000) },
        ]),
        groupBy: jest.fn(async () => [
          { sessionId: 'lane-deaf-0001', enabled: false, _count: { _all: 1 }, _max: { lastFiredAt: new Date('2026-09-14T14:00:00Z') } },
          { sessionId: 'lane-armed-001', enabled: true, _count: { _all: 1 }, _max: { lastFiredAt: new Date() } },
        ]),
      };
      mockPrisma.agentRun = { ...(mockPrisma.agentRun ?? {}), groupBy: jest.fn(async () => []) };
    });
    afterEach(() => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
      delete (mockPrisma.crossModelChat as any).findMany;
      delete mockPrisma.chatSchedule;
      if (mockPrisma.agentRun) delete (mockPrisma.agentRun as any).groupBy;
    });

    it('a PROJECT supervisor machine wake gets the live per-lane [PROJECT SCHEDULES] truth baked into its persisted wake prompt', async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Lane report: all quiet.', parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-psched-project', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive('chat:chat-psched-project'));
      const creates = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
      const userWrite = creates.filter((d: any) => d?.chatId === 'chat-psched-project').find((d: any) => d?.role === 'user');
      expect(userWrite).toBeDefined();
      expect(userWrite.content).toContain('[PROJECT SCHEDULES');
      expect(userWrite.content).toContain('"Deaf lane": NO enabled schedules');
      expect(userWrite.content).toContain('"Armed lane": 1 enabled: sch-live next');
    });

    it('a project supervisor with NO projectId gets NO [PROJECT SCHEDULES] block (nothing to scope to)', async () => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Alpha Supervisor', isProjectSupervisor: true, userId: 'u1' }));
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Lane report: all quiet.', parts: [], receipts: [] });
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-psched-noproj', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive('chat:chat-psched-noproj'));
      const creates = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
      const userWrite = creates.filter((d: any) => d?.chatId === 'chat-psched-noproj').find((d: any) => d?.role === 'user');
      expect(userWrite).toBeDefined();
      expect(userWrite.content).not.toContain('[PROJECT SCHEDULES');
    });
  });

  it('STRIKE on a supervisor machine wake: the committed note is the replacement, parts lead with the notice, complete carries the swap, the post-delivery verifier stands down', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true,
      phantoms: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-sup', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-sup'));

    // The guard ran BEFORE persistence with the machine-wake inputs.
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    const call = mockGuardMachineWakeFinalAnswer.mock.calls[0][0];
    expect(call).toMatchObject({ chatId: 'chat-guard-sup', userId: 'u1', supervisor: true, machineTriggered: true, finalText: phantomNote });
    expect(call.runStartedAt).toBeInstanceOf(Date);

    // The committed assistant row IS the replacement — content, the models
    // card metadata, and the persisted parts (notice unshifted to the front).
    expect(assistantWrites()).toHaveLength(1);
    const row = assistantWrites()[0];
    expect(row.content).toBe(guardReplacement);
    expect(row.metadata.models.digby.response).toBe(guardReplacement);
    expect(row.parts[0]).toEqual({ type: 'text', text: guardNotice });

    // A live viewer gets the swap (the reconciledLive idiom), not the phantom.
    expect(events.find(e => e.type === 'complete')!.data.finalText).toBe(guardReplacement);

    // The post-delivery lane stood down — no double ticket / correction.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
  });

  it('ticket fc337153 single-audit: a CLEAN audited guard verdict on a supervisor machine wake stands the post-delivery verifier down', async () => {
    // The 2026-09-11T02:17Z replay: the guard ACQUITTED the note (clean
    // verdict, audit ran) — the post-delivery lane's second independent LLM
    // extraction must NOT re-audit it (its conviction delivered the phantom
    // and reopened the P5 ticket on pure extraction divergence).
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Wake complete. All quiet; four owner items open.', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-audited', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-audited'));

    // The clean note committed as-is…
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe('Wake complete. All quiet; four owner items open.');
    // …and the post-delivery lane stood down — the guard's verdict is THE audit.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
  });

  it('ticket fc337153 backstop: a guard that FAILED OPEN (audited:false) still gets the post-delivery verifier', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Wake complete. All quiet; four owner items open.', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: false,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-failopen', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    // Fail-open keeps the backstop: the post-delivery lane DID run.
    await waitFor(() => mockVerifySupervisorRunAsync.mock.calls.length > 0);
    expect(mockVerifySupervisorRunAsync).toHaveBeenCalledTimes(1);
  });

  it('STRIKE feedback (ticket 51ed3a65): a guard-returned correction is injected as a user-role harness message AFTER the replacement assistant row', async () => {
    const correctionText = '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it claimed action(s) that did NOT execute (no matching successful tool call in that run):\n- [ticket] "filed a feedback ticket for the digest regression" (cited id ab12cd34-9999-8888-7777-666655554444)\nThese are NOT done. Never restate them as done.';
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true,
      phantoms: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
      correction: correctionText,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-corr', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-corr'));

    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    const correctionWrites = writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier');
    // ONE correction row, verbatim content, harness metadata, this chat.
    expect(correctionWrites).toHaveLength(1);
    expect(correctionWrites[0].content).toBe(correctionText);
    expect(correctionWrites[0].metadata).toMatchObject({ origin: 'machine', verifier: 'action-verifier' });
    expect(correctionWrites[0].chatId).toBe('chat-guard-corr');
    // Lands AFTER the replacement assistant row in write order, so "your last
    // status note" reads chronologically in the next wake's history window.
    const assistantIdx = writes.findIndex((d: any) => d?.role === 'assistant');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf(correctionWrites[0])).toBeGreaterThan(assistantIdx);

    // The post-delivery lane still stands down — no double correction.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifySupervisorRunAsync).not.toHaveBeenCalled();
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
  });

  it('a strike whose guard result carries NO correction text injects NO correction row (the seam gate — any strike class)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, phantoms: [],
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-clk', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-clk'));

    expect(assistantWrites()[0].content).toBe(guardReplacement); // replacement still lands
    const correctionWrites = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier');
    expect(correctionWrites).toHaveLength(0);
  });

  it('a clock-class strike WITH correction text injects the correction row (ticket a688ba29 — the seam is not phantom-gated)', async () => {
    const clockCorrection = '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it asserted observation(s) timestamped in the FUTURE — clock reading(s) later than that run\'s real clock (2026-09-01T00:46:37.004Z), so the observation(s) cannot have happened:\n- "00:52Z" — 5 min ahead of this run\'s real clock (2026-09-01T00:46:37.004Z) — in: "**Fleet wake — 5:52 PM PDT (00:52Z Sep 1) — all lanes healthy**"\nClock discipline (machine-wake rule 8): …';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true, phantoms: [],
      correction: clockCorrection,
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-clk2', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-clk2'));

    expect(assistantWrites()[0].content).toBe(guardReplacement); // replacement still lands
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    const correctionWrites = writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier');
    // ONE correction row, verbatim content, harness metadata, this chat —
    // landing AFTER the replacement assistant row so "your last status note"
    // reads chronologically in the next wake's history window.
    expect(correctionWrites).toHaveLength(1);
    expect(correctionWrites[0].content).toBe(clockCorrection);
    expect(correctionWrites[0].metadata).toMatchObject({ origin: 'machine', verifier: 'action-verifier' });
    expect(correctionWrites[0].chatId).toBe('chat-guard-clk2');
    const assistantIdx = writes.findIndex((d: any) => d?.role === 'assistant');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf(correctionWrites[0])).toBeGreaterThan(assistantIdx);
  });

  it('STRIKE on a keyword-bearing NON-supervisor machine wake: same replacement wiring, post lane down', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true,
      phantoms: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-nonsup', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-nonsup'));

    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toMatchObject({ chatId: 'chat-guard-nonsup', supervisor: false, machineTriggered: true });
    expect(assistantWrites()[0].content).toBe(guardReplacement);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
  });

  it('REJECT-BACK (ba65163d/aac649ba): a struck note is re-orchestrated ONCE with the notice; a clean retry delivers with zero strike artifacts', async () => {
    (runCodingAgent as jest.Mock).mockClear();
    const correctedNote = 'Wake complete. All lanes verified fresh via list_chats this run; nothing cited from memory.';
    const rbNotice = '[HARNESS NOTICE — not typed by the user] The integrity check REJECTED your previous answer before delivery — it was NOT posted. …';
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [{ id: 'r1' }] })
      .mockResolvedValueOnce({ finalText: correctedNote, parts: [], receipts: [{ id: 'r2' }] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
      finalText: guardReplacement, notice: guardNotice, struck: true,
      phantoms: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
      rejectBackNotice: rbNotice,
    }));
    // The SECOND guard pass falls through to the module default (struck:false).
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-rb-clean', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-rb-clean'));

    // TWO orchestrator runs — the retry carries the notice on the user turn.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    const retryArgs = (runCodingAgent as jest.Mock).mock.calls[1][0];
    expect(retryArgs.userMessage).toContain('the question');
    expect(retryArgs.userMessage).toContain(rbNotice);

    // TWO guard passes: pass 1 DEFERRED on the phantom note; pass 2 with
    // consequences available on the corrected note, receipts UNIONED.
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    const pass1 = mockGuardMachineWakeFinalAnswer.mock.calls[0][0];
    const pass2 = mockGuardMachineWakeFinalAnswer.mock.calls[1][0];
    expect(pass1).toMatchObject({ finalText: phantomNote, deferConsequences: true, machineTriggered: true });
    expect(pass2.finalText).toBe(correctedNote);
    expect(pass2.deferConsequences).toBeUndefined();
    expect((pass2.receipts || []).map((r: any) => r.id)).toEqual(['r1', 'r2']);

    // The committed assistant row IS the corrected note — the phantom never
    // persisted, and no strike artifacts landed (no correction row).
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(correctedNote);
    // B1 (review): live viewers get the complete-event swap on the clean-retry
    // path too — attempt-1 chunks already streamed, so without finalText the
    // bubble would read phantom+corrected concatenated while the DB holds only
    // the corrected note.
    expect(events.find(e => e.type === 'complete')!.data.finalText).toBe(correctedNote);
    const correctionWrites = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier');
    expect(correctionWrites).toHaveLength(0);

    // Outcome telemetry (owner 2026-09-04): ONE guard_strike row for the
    // reject-back cycle, meta.citationRetry 'clean' — the self-correction
    // worked and is now chartable.
    const rbMetrics = mockRecordLoopMetric.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back');
    expect(rbMetrics).toHaveLength(1);
    expect(rbMetrics[0]).toMatchObject({
      kind: 'guard_strike', sessionId: 'chat-guard-rb-clean',
      meta: { guard: 'action-verifier', citationRetry: 'clean' },
    });
  });

  it('REJECT-BACK exhausted: a still-convicted retry takes the normal struck path — consequences fire on the SECOND answer', async () => {
    (runCodingAgent as jest.Mock).mockClear();
    const secondPhantom = 'Wake complete. I merged the fix PR (PR #999999) after green CI.';
    const secondReplacement = `${guardNotice}\n\n--- BEGIN STRUCK NOTE ---\n> ${secondPhantom}\n--- END STRUCK NOTE ---`;
    const secondCorrection = '[ACTION VERIFIER — automated integrity check] Your last status note was WITHHELD before delivery: it claimed action(s) that did NOT execute …';
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: secondPhantom, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true,
        phantoms: [{ kind: 'ticket', detail: 'x', id: 'ab12cd34-9999-8888-7777-666655554444' }],
        rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      }))
      .mockImplementationOnce(async () => ({
        finalText: secondReplacement, notice: guardNotice, struck: true,
        phantoms: [{ kind: 'pr', detail: 'merged the fix PR', id: '#999999' }],
        correction: secondCorrection,
      }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-rb-struck', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-guard-rb-struck'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[1][0].finalText).toBe(secondPhantom);

    // The committed row is the SECOND replacement; its correction lands after it.
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(secondReplacement);
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    const correctionWrites = writes.filter((d: any) => d?.role === 'user' && d?.metadata?.verifier === 'action-verifier');
    expect(correctionWrites).toHaveLength(1);
    expect(correctionWrites[0].content).toBe(secondCorrection);
    // Live viewers get the swap (the actionGuardStruck idiom).
    expect(events.find(e => e.type === 'complete')!.data.finalText).toBe(secondReplacement);

    // Outcome telemetry (owner 2026-09-04): the still-convicted retry records
    // citationRetry 'still_dirty' — the strip/replace lane ran on the final
    // answer and the recidivism is chartable.
    const rbMetrics = mockRecordLoopMetric.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back');
    expect(rbMetrics).toHaveLength(1);
    expect(rbMetrics[0]).toMatchObject({
      kind: 'guard_strike', sessionId: 'chat-guard-rb-struck',
      meta: { guard: 'action-verifier', citationRetry: 'still_dirty' },
    });
  });

  it('REJECT-BACK retry failure: the original strike stands — consequences re-run on the ORIGINAL note', async () => {
    (runCodingAgent as jest.Mock).mockClear();
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] })
      .mockRejectedValueOnce(new Error('provider down'));
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true,
        phantoms: [{ kind: 'ticket', detail: 'x', id: 'ab12cd34' }],
        rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      }))
      .mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true,
        phantoms: [{ kind: 'ticket', detail: 'x', id: 'ab12cd34' }],
      }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-rb-fail', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-rb-fail'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    // The second pass re-guarded the ORIGINAL note (the retry produced nothing).
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[1][0].finalText).toBe(phantomNote);
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(guardReplacement);
  });

  it('REJECT-BACK retry with EMPTY finalText: fail-closed — adapter.answerText pollution is never parsed (review B2)', async () => {
    (runCodingAgent as jest.Mock).mockClear();
    // The retry resolves but with an empty finalText. On this path the adapter
    // still holds attempt 1's struck text, so adapter.answerText would be the
    // phantom note (+fragments) — the seam must NOT fall back to it: an empty
    // retry is a FAILED retry and the original strike stands.
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: '', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true,
        phantoms: [{ kind: 'ticket', detail: 'x', id: 'ab12cd34' }],
        rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      }))
      .mockImplementationOnce(async () => ({
        finalText: guardReplacement, notice: guardNotice, struck: true,
        phantoms: [{ kind: 'ticket', detail: 'x', id: 'ab12cd34' }],
      }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-rb-empty', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-rb-empty'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    // Pass 2 re-guarded the ORIGINAL note — not a concatenated adapter blob.
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[1][0].finalText).toBe(phantomNote);
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(guardReplacement);
  });

  it('a keyword-FREE NON-supervisor machine wake still reaches the guard (ticket 375c8618 — the deterministic future-clock check must see keyword-free notes)', async () => {
    // The default mock final is 'A'.repeat(500) — keyword-free (mirrors the
    // verif-b pre-gate test). Pre-375c8618 the caller's keyword clause dropped
    // these wakes BEFORE the guard; the (a2) check inside is regex-only, so
    // the LLM matcher still never fires for them.
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-kwfree', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-kwfree'));

    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toMatchObject({ chatId: 'chat-guard-kwfree', supervisor: false, machineTriggered: true });
    // Keyword-free + clean → the post-delivery verifier stays stood down too.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockVerifyRunActionClaimsAsync).not.toHaveBeenCalled();
  });

  it('CLEAN pass: original committed untouched and the post-delivery verifier still runs as backstop', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    // (default mock implementation is the struck:false pass-through)
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-clean', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-clean'));

    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    expect(assistantWrites()[0].content).toBe(phantomNote);
    await waitFor(() => mockVerifyRunActionClaimsAsync.mock.calls.length > 0);
    expect(mockVerifyRunActionClaimsAsync.mock.calls[0][0]).toMatchObject({ chatId: 'chat-guard-clean', machineTriggered: true });
  });

  it('FAIL-OPEN at the seam: a throwing guard keeps the original text and the post-delivery verifier still runs', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockRejectedValueOnce(new Error('guard exploded'));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-guard-fail', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-fail'));

    expect(assistantWrites()[0].content).toBe(phantomNote);
    await waitFor(() => mockVerifyRunActionClaimsAsync.mock.calls.length > 0);
  });

  it('a USER-triggered turn never touches the guard (post-delivery behavior unchanged)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: phantomNote, parts: [], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-guard-user', sessionId: null });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive('chat:chat-guard-user'));

    expect(mockGuardMachineWakeFinalAnswer).not.toHaveBeenCalled();
    expect(assistantWrites()[0].content).toBe(phantomNote);
    await waitFor(() => mockVerifyRunActionClaimsAsync.mock.calls.length > 0);
    expect(mockVerifyRunActionClaimsAsync.mock.calls[0][0]).toMatchObject({ chatId: 'chat-guard-user', machineTriggered: false });
  });
});

describe('auto-title pinning (2026-08-13 — supervisor-title cascade, tickets ea2dde87/ca8c9400)', () => {
  // Prod evidence: six flagged supervisor chats (one per user — the partial
  // unique index is intact) carried machine-wake-derived titles ("Printing
  // Press History Essay Completed", "Machine-Triggered Run No User…") because
  // the first-turn title gate fired on their first WAKE. An unrecognizable
  // supervisor gets replaced while its old wiring survives — the duplicate-
  // supervisor fleet incident. The guard: machine-wake first turns never name
  // a chat, and a supervisor chat's title is pinned even for a human turn.
  const EMPTY_CTX = {
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [] as any[],
    projectId: null,
  };
  const FULL_CTX = {
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }] as any[],
    projectId: null,
  };
  const genTitle = moonshotIntegration.generateTitle as jest.Mock;
  const buildCtx = buildChatQueryContext as jest.Mock;
  const titleWrites = () =>
    mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);

  beforeEach(() => {
    genTitle.mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    buildCtx.mockResolvedValue(EMPTY_CTX); // empty history → the title gate is live
  });
  afterEach(() => {
    buildCtx.mockResolvedValue(FULL_CTX);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('a machine-wake first turn never names the chat', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-title-mw', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    expect(key).toBe('chat:chat-title-mw');
    await waitFor(() => !isRunActive('chat:chat-title-mw'));
    await new Promise((r) => setTimeout(r, 100)); // let any stray fire-and-forget settle
    expect(genTitle).not.toHaveBeenCalled();
    expect(titleWrites()).toHaveLength(0);
  });

  it('a supervisor chat keeps its pinned title even on a human first turn', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-sup', sessionId: null });
    expect(key).toBe('chat:chat-title-sup');
    await waitFor(() => !isRunActive('chat:chat-title-sup'));
    await new Promise((r) => setTimeout(r, 100));
    expect(genTitle).not.toHaveBeenCalled();
    expect(titleWrites()).toHaveLength(0);
  });

  it('an ordinary human first turn still auto-titles the chat (regression guard)', async () => {
    // With the CAS guard the up-front writer reads the row before writing:
    // the title-only read must see the still-stale placeholder, while the
    // repair's read (run end) sees the landed title and stands down.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.title && !select?.isSupervisor) return { title: 'the question' };
      return { title: 'New chat', isSupervisor: false };
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-human', sessionId: null });
    expect(key).toBe('chat:chat-title-human');
    await waitFor(() => titleWrites().length > 0);
    expect(genTitle).toHaveBeenCalled();
    expect(titleWrites()[0][0].data.title).toBe('A Generated Title');
  });

  it('the FIRST human message after machine wakes still auto-titles the chat (audit p10)', async () => {
    // 3 prior wakes persisted 6 machine-origin rows: raw history is 6 (both
    // windows used to be closed forever), but the HUMAN turn count is 0 —
    // the up-front window must re-arm for the human's first real message.
    buildCtx.mockResolvedValue({
      queryMessage: 'the question',
      systemContext: '',
      conversationHistory: Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `wake ${i}`,
      })),
      projectId: null,
    });
    // DB: 6 machine rows + the just-persisted current human row.
    mockPrisma.crossModelMessage.count.mockImplementation(async ({ where }: any) => (where?.OR ? 6 : 7));
    // Stateful row with REAL compare-and-swap semantics: the up-front write
    // lands first (its chain resolves in microtasks at run start), so the
    // run-end repair must read the landed title and stand down — exactly one
    // title write, no double-title (PR #367 CAS guard).
    let storedTitle = 'New Chat'; // stock placeholder — a stale shape
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.isSupervisor && !select?.title) return { isSupervisor: false };
      return { title: storedTitle, ...(select?.isSupervisor ? { isSupervisor: false } : {}) };
    });
    mockPrisma.crossModelChat.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.title !== undefined && where.title !== storedTitle) return { count: 0 };
      if (data?.title) storedTitle = data.title;
      return { count: 1 };
    });
    try {
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-postwake', sessionId: null });
      expect(key).toBe('chat:chat-title-postwake');
      await waitFor(() => titleWrites().length > 0);
      expect(genTitle).toHaveBeenCalled();
      expect(titleWrites()[0][0].data.title).toBe('A Generated Title');
      await waitFor(() => !isRunActive('chat:chat-title-postwake'));
      await new Promise((r) => setTimeout(r, 100)); // let stray fire-and-forget work settle
      expect(titleWrites()).toHaveLength(1); // repair stood down — no double write
      expect(storedTitle).toBe('A Generated Title');
    } finally {
      mockPrisma.crossModelMessage.count.mockImplementation(async ({ where }: any) => (where?.OR ? 0 : 2));
      mockPrisma.crossModelChat.updateMany.mockImplementation(async () => ({ count: 1 }));
    }
  });
});

describe('title generation robustness (ticket 26385762)', () => {
  // The up-front title fires at humanTurnCount === 0 (history-empty ctx) as
  // fire-and-forget; the run-end repair window now INCLUDES turn 1. Old bugs
  // under test here: (1) a 20s Promise.race silently dropped any chain slower
  // than the timer (generateTitle never returns '', so t==='' only ever meant
  // the timer won); (2) every drop path was silent; (3) a one-question chat
  // had no second chance (repair required humanTurnCount > 0).
  const EMPTY_CTX = {
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [] as any[],
    projectId: null,
  };
  const genTitle = moonshotIntegration.generateTitle as jest.Mock;
  const buildCtx = buildChatQueryContext as jest.Mock;
  const titleWrites = () =>
    mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);
  const warnCalls = () => (logger.warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));

  beforeEach(() => {
    genTitle.mockClear();
    (logger.warn as jest.Mock).mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    buildCtx.mockResolvedValue(EMPTY_CTX); // history 0 → humanTurnCount 0: up-front AND (new) turn-1 repair gates live
  });
  afterEach(() => {
    genTitle.mockImplementation(async () => 'A Generated Title');
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('a title chain slower than the retired 20s race still lands (no timer drop)', async () => {
    let resolveTitle!: (t: string) => void;
    genTitle.mockImplementation(() => new Promise<string>((res) => { resolveTitle = res; }));
    // 'New chat' is NOT a stale shape (lowercase c) — the run-end repair no-ops,
    // isolating the up-front path. The up-front CAS read (title-only select)
    // must still see the placeholder, or IT would stand down instead.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.title && !select?.isSupervisor) return { title: 'the question' };
      return { title: 'New chat', isSupervisor: false };
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-slow', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-title-slow'));
    // Old behavior: the 20s race would have resolved '' long before this and
    // silently dropped the title. With the race gone the chain is still in
    // flight after run end — resolve it late and the title must still land.
    resolveTitle('A Slow But Real Title');
    await waitFor(() => titleWrites().length > 0);
    expect(titleWrites()[0][0].data.title).toBe('A Slow But Real Title');
  });

  it('an empty title result logs a warning instead of silently returning', async () => {
    genTitle.mockResolvedValue('' as any);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New chat', isSupervisor: false }));
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-empty', sessionId: null });
    await waitFor(() => warnCalls().some((m) => m.includes('up-front title returned empty')));
    expect(titleWrites()).toHaveLength(0);
  });

  it('a failed title write (updateMany rejects) logs a warning', async () => {
    genTitle.mockResolvedValue('A Real Title');
    // Up-front CAS read (title-only) sees the stale placeholder so the write
    // is attempted; the repair read sees a non-stale shape and no-ops.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.title && !select?.isSupervisor) return { title: 'the question' };
      return { title: 'New chat', isSupervisor: false };
    });
    mockPrisma.crossModelChat.updateMany.mockRejectedValueOnce(new Error('db down'));
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-dbfail', sessionId: null });
    await waitFor(() => warnCalls().some((m) => m.includes('title write failed') && m.includes('db down')));
  });

  it('a skipped title write (updateMany count 0 — non-owner/supervisor) logs a warning', async () => {
    genTitle.mockResolvedValue('A Real Title');
    // Same split as above; on count===0 the classify re-read (also title-only)
    // returns the SAME stale title → not a CAS stand-down → the legacy
    // non-owner/supervisor warn must still fire.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.title && !select?.isSupervisor) return { title: 'the question' };
      return { title: 'New chat', isSupervisor: false };
    });
    mockPrisma.crossModelChat.updateMany.mockResolvedValueOnce({ count: 0 } as any);
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-nonowner', sessionId: null });
    await waitFor(() => warnCalls().some((m) => m.includes('title write skipped')));
  });

  it('a one-question chat repairs its own failed up-front title at run end (turn-1 window)', async () => {
    genTitle
      .mockResolvedValueOnce('' as any) // up-front attempt fails
      .mockResolvedValueOnce('A Repaired Title'); // run-end repair attempt
    // The row still holds the placeholder — 'the question' IS placeholderTitle(message).
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'the question', isSupervisor: false }));
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-t1repair', sessionId: null });
    await waitFor(() => titleWrites().length > 0);
    expect(genTitle).toHaveBeenCalledTimes(2);
    // The repair passes the REAL assistantContent (up-front passed ''), so the
    // heading heuristic in generateTitle is reachable on the second attempt.
    expect(String(genTitle.mock.calls[1][1]).length).toBeGreaterThan(0);
    expect(titleWrites()[0][0].data.title).toBe('A Repaired Title');
    // The repair's write is compare-and-swap: the where carries the stale
    // title it read, so a late up-front write can't be clobbered by it.
    expect(titleWrites()[0][0].where.title).toBe('the question');
  });

  it('turn 1 does NOT re-title when the up-front title already landed (non-stale)', async () => {
    genTitle.mockResolvedValue('A Proper Title');
    // The up-front CAS read (title-only) sees the placeholder still in place,
    // so the up-front write lands; the repair's later read then sees the
    // landed non-stale title and early-returns without a second generation.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.title && !select?.isSupervisor) return { title: 'the question' };
      return { title: 'A Proper Title', isSupervisor: false };
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-t1ok', sessionId: null });
    await waitFor(() => titleWrites().length > 0);
    await waitFor(() => !isRunActive('chat:chat-title-t1ok'));
    await new Promise((r) => setTimeout(r, 100)); // let the repair's fire-and-forget settle
    expect(genTitle).toHaveBeenCalledTimes(1); // up-front only — repair early-returned
    expect(titleWrites()).toHaveLength(1);
  });
});

describe('turn-1 title double-writer race (PR #367 blocking review)', () => {
  // At humanTurnCount === 0 BOTH title writers fire in the SAME run: the
  // up-front chain (question-only title; up to ~30s of utility fallbacks) and
  // the run-end repair (answer-aware title). Pre-CAS, whichever write landed
  // LAST won — a quick answer + slow title chain let the late up-front write
  // clobber the repair's better title (or vice versa), leaving the final
  // title nondeterministic; the old instant-resolve mocks could never see
  // the interleaving. With compare-and-swap on both writers the FIRST
  // successful write wins and the loser stands down (info, not warn). These
  // tests drive the interleavings with controllable deferred mocks against a
  // stateful chat row whose updateMany enforces REAL CAS semantics.
  const EMPTY_CTX = {
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [] as any[],
    projectId: null,
  };
  const genTitle = moonshotIntegration.generateTitle as jest.Mock;
  const buildCtx = buildChatQueryContext as jest.Mock;
  const titleWrites = () =>
    mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);
  const infoCalls = () => (logger.info as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
  const warnCalls = () => (logger.warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));

  // A chat row that behaves like Postgres: findUnique reflects the last
  // committed write; an updateMany whose where carries a title CAS clause
  // only writes when the row still holds that exact title (count 0 else).
  let storedTitle = '';
  let committedTitles: string[] = [];
  const wireStatefulChatRow = (initialTitle: string) => {
    storedTitle = initialTitle;
    committedTitles = [];
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.isSupervisor && !select?.title) return { isSupervisor: false }; // supervisor-gate read
      return { title: storedTitle, ...(select?.isSupervisor ? { isSupervisor: false } : {}) };
    });
    mockPrisma.crossModelChat.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.title !== undefined && where.title !== storedTitle) return { count: 0 }; // CAS miss
      if (data?.title) { storedTitle = data.title; committedTitles.push(data.title); }
      return { count: 1 };
    });
  };

  beforeEach(() => {
    genTitle.mockClear();
    (logger.info as jest.Mock).mockClear();
    (logger.warn as jest.Mock).mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    mockPrisma.crossModelChat.findUnique.mockClear();
    buildCtx.mockResolvedValue(EMPTY_CTX); // humanTurnCount 0 → both writers live in the same run
  });
  afterEach(() => {
    genTitle.mockImplementation(async () => 'A Generated Title');
    mockPrisma.crossModelChat.updateMany.mockImplementation(async () => ({ count: 1 }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('the up-front chain resolving AFTER the run-end repair stands down — the repair title survives', async () => {
    wireStatefulChatRow('the question'); // frontend pre-seeded placeholder = placeholderTitle(message)
    // The up-front chain is SLOW (deferred under test control); the repair's
    // answer-aware title arrives on time.
    let resolveUpFront!: (t: string) => void;
    genTitle
      .mockImplementationOnce(() => new Promise<string>((res) => { resolveUpFront = res; })) // up-front
      .mockResolvedValueOnce('InvestiGators Reading Order'); // run-end repair
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-race-late', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-title-race-late'));
    // Run over, up-front chain still in flight: the repair read the still-
    // stale placeholder and wrote its answer-aware title.
    await waitFor(() => titleWrites().length === 1);
    expect(storedTitle).toBe('InvestiGators Reading Order');
    expect(titleWrites()[0][0].where.title).toBe('the question'); // the repair's CAS clause
    // NOW the up-front chain resolves — pre-CAS this unconditional write
    // clobbered the repair with the question-only title.
    resolveUpFront('what is the Investigators order');
    await waitFor(() => infoCalls().some((m) => m.includes('up-front title') && m.includes('stood down')));
    expect(titleWrites()).toHaveLength(1); // the losing writer stood down WITHOUT writing
    expect(storedTitle).toBe('InvestiGators Reading Order'); // final title is deterministic
    expect(warnCalls().some((m) => m.includes('stood down'))).toBe(false); // stand-down logs at info, NOT warn
  });

  it('an up-front write losing the CAS mid-flight stands down (count 0 — no clobber, no warn)', async () => {
    wireStatefulChatRow('the question');
    let resolveUpFront!: (t: string) => void;
    genTitle
      .mockImplementationOnce(() => new Promise<string>((res) => { resolveUpFront = res; })) // up-front
      .mockResolvedValueOnce('InvestiGators Reading Order'); // run-end repair
    // Hold the up-front CAS READ open until the repair has fully landed, then
    // release it with the STALE snapshot it took at await-time: the read-level
    // staleness check passes (the snapshot IS stale), so only the
    // updateMany-level CAS guard (where.title === read title) can prevent the
    // clobber. One-shot: the post-write classify re-read must hit the store.
    let releaseRead!: (v: { title: string }) => void;
    const heldRead = new Promise<{ title: string }>((res) => { releaseRead = res; });
    let readHeld = true;
    const statefulFindUnique = mockPrisma.crossModelChat.findUnique.getMockImplementation()!;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (q: any) => {
      if (readHeld && q?.select?.title && !q?.select?.isSupervisor) { readHeld = false; return heldRead; }
      return statefulFindUnique(q);
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-title-race-cas', sessionId: null });
    // startDetachedChatRun returns at registration — wait until the run body
    // has actually reached the up-front title block before resolving it.
    await waitFor(() => genTitle.mock.calls.length >= 1);
    resolveUpFront('what is the Investigators order');
    // The repair runs at run end and lands its title while the up-front read
    // is still suspended.
    await waitFor(() => !isRunActive('chat:chat-title-race-cas'));
    await waitFor(() => titleWrites().length === 1); // the repair's write
    expect(storedTitle).toBe('InvestiGators Reading Order');
    // Release the up-front read with its pre-repair stale snapshot — the
    // up-front MUST still attempt its write (the snapshot passes the
    // read-level staleness check); the where-clause CAS is the guard that
    // refuses it (count 0), and the writer stands down.
    releaseRead({ title: 'the question' });
    await waitFor(() => infoCalls().some((m) => m.includes('up-front title') && m.includes('stood down')));
    expect(titleWrites()).toHaveLength(2); // the repair's landed write + the up-front's refused attempt
    expect(titleWrites()[1][0].where.title).toBe('the question'); // the up-front's CAS clause carried its stale snapshot
    expect(committedTitles).toEqual(['InvestiGators Reading Order']); // ONLY the repair ever committed — no clobber
    expect(storedTitle).toBe('InvestiGators Reading Order');
    expect(warnCalls().some((m) => m.includes('title write skipped'))).toBe(false); // a CAS miss is not the legacy drop warn
  });
});

describe('stale-title repair pinning (turns 2-3 path — reviewer follow-up, same tickets)', () => {
  // The repair path (history 1-4) is a SECOND title writer: it must honor the
  // same pinning guards, or already-damaged supervisor rows (stale-shaped
  // titles ending in '…') get re-titled from the next wake payload.
  const ONE_MSG_CTX = {
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }] as any[],
    projectId: null,
  };
  const genTitle = moonshotIntegration.generateTitle as jest.Mock;
  const buildCtx = buildChatQueryContext as jest.Mock;
  const titleWrites = () =>
    mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);

  beforeEach(() => {
    genTitle.mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    buildCtx.mockResolvedValue(ONE_MSG_CTX); // history 1 → repair gate is live, up-front gate is not
  });
  afterEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('machine-wake turns never repair titles', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Machine-Triggered Run No User…', isSupervisor: false }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-repair-mw', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    expect(key).toBe('chat:chat-repair-mw');
    await waitFor(() => !isRunActive('chat:chat-repair-mw'));
    await new Promise((r) => setTimeout(r, 100));
    expect(genTitle).not.toHaveBeenCalled();
    expect(titleWrites()).toHaveLength(0);
  });

  it('supervisor chat with a stale-shaped title is not re-titled (pinned)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Printing Press History Essay Completed…', isSupervisor: true }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-repair-sup', sessionId: null });
    expect(key).toBe('chat:chat-repair-sup');
    await waitFor(() => !isRunActive('chat:chat-repair-sup'));
    await new Promise((r) => setTimeout(r, 100));
    expect(genTitle).not.toHaveBeenCalled();
    expect(titleWrites()).toHaveLength(0);
  });

  it('ordinary human turn with a stale title still repairs it (regression guard)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-repair-human', sessionId: null });
    expect(key).toBe('chat:chat-repair-human');
    await waitFor(() => titleWrites().length > 0);
    expect(genTitle).toHaveBeenCalled();
    expect(titleWrites()[0][0].data.title).toBe('A Generated Title');
  });
});

describe('busy-queue drain preserves message origin (audit p10)', () => {
  // Before: drainChatQueue started queued runs with NO messageOrigin, so the
  // same send got different provenance depending on whether the chat was busy
  // when it arrived (an idle agent send stamps 'agent'; a queued one stamped
  // nothing). The pending row's source now carries the origin through.
  it("a drained 'agent'-sourced message persists metadata.origin=agent", async () => {
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-1', chatId: 'chat-drain-a', userId: 'u1', content: 'queued agent msg',
      mode: 'single_thinking', source: 'agent', createdAt: new Date(),
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-drain-a', sessionId: null });
    expect(key).toBe('chat:chat-drain-a');
    const drainedUserRow = () => mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'user' && d?.content === 'queued agent msg');
    await waitFor(() => !!drainedUserRow());
    expect(drainedUserRow().metadata).toMatchObject({ origin: 'agent' });
    // f89d1213: machine-origin rows are authored by no human — never stamped.
    expect(drainedUserRow().metadata.authorId).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-drain-a'));
    await new Promise((r) => setTimeout(r, 100)); // let the drained run's own fire-and-forget drain settle
  });

  it("a drained 'user'-sourced message persists metadata.origin=user", async () => {
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-2', chatId: 'chat-drain-b', userId: 'u1', content: 'queued user msg',
      mode: 'single_thinking', source: 'user', createdAt: new Date(),
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-drain-b', sessionId: null });
    expect(key).toBe('chat:chat-drain-b');
    const drainedUserRow = () => mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'user' && d?.content === 'queued user msg');
    await waitFor(() => !!drainedUserRow());
    // f89d1213: a human-sourced drain stamps the ENQUEUER as the author
    // (same account as the drainer here — see the teammate test below).
    expect(drainedUserRow().metadata).toMatchObject({ origin: 'user', authorId: 'u1' });
    await waitFor(() => !isRunActive('chat:chat-drain-b'));
    await new Promise((r) => setTimeout(r, 100)); // let the drained run's own fire-and-forget drain settle
  });

  it("a drained 'webhook'-sourced message persists metadata.origin=webhook and stays titling-pinned (machineWake)", async () => {
    // Review follow-up (2026-08-23): a webhook fire IS a machine wake — the
    // drained run must carry machineWake too, or a queued alert payload would
    // name the chat when the busy run drains it. The OUTER run below is a
    // schedule wake (already titling-pinned), so any genTitle call could only
    // come from the DRAINED run.
    const genTitle = moonshotIntegration.generateTitle as jest.Mock;
    const titleWrites = () =>
      mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);
    genTitle.mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-3', chatId: 'chat-drain-c', userId: 'u1', content: 'queued webhook msg',
      mode: 'single_thinking', source: 'webhook', createdAt: new Date(),
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-drain-c', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    expect(key).toBe('chat:chat-drain-c');
    // A machineWake run persists the user row with the machine preamble
    // prepended to the content (same as schedule prompts) — match the tail.
    const drainedUserRow = () => mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'user' && typeof d?.content === 'string' && d.content.endsWith('queued webhook msg'));
    await waitFor(() => !!drainedUserRow());
    expect(drainedUserRow().metadata).toMatchObject({ origin: 'webhook' });
    // f89d1213: webhook fires are machine traffic — never author-stamped.
    expect(drainedUserRow().metadata.authorId).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-drain-c'));
    await new Promise((r) => setTimeout(r, 100)); // let the drained run's own fire-and-forget drain settle
    expect(genTitle).not.toHaveBeenCalled();
    expect(titleWrites()).toHaveLength(0);
  });
});

describe('shared-project author attribution (f89d1213)', () => {
  // The persisted user row for a specific message content (machineWake runs
  // prepend a preamble, so tail-match like the webhook drain test above).
  const userRowEndingWith = (tail: string) => () => mockPrisma.crossModelMessage.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .find((d: any) => d?.role === 'user' && typeof d?.content === 'string' && d.content.endsWith(tail));

  it('an immediate human turn stamps metadata.authorId with the sender', async () => {
    const row = userRowEndingWith('who wrote this?');
    const key = await startDetachedChatRun({
      message: 'who wrote this?', mode: 'single_thinking',
      userId: 'u-author', chatId: 'chat-auth-a', sessionId: null,
    });
    await waitFor(() => !!row());
    expect(row().metadata).toMatchObject({ authorId: 'u-author' });
    await waitFor(() => !isRunActive(key!));
    await new Promise((r) => setTimeout(r, 100)); // let the run's fire-and-forget drain settle
  });

  it('a machine wake (messageOrigin schedule) persists NO authorId', async () => {
    const row = userRowEndingWith('nightly wake payload');
    const key = await startDetachedChatRun({
      message: 'nightly wake payload', mode: 'single_thinking',
      userId: 'u-owner', chatId: 'chat-auth-b', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    await waitFor(() => !!row());
    expect(row().metadata).toMatchObject({ origin: 'schedule' });
    expect(row().metadata.authorId).toBeUndefined();
    await waitFor(() => !isRunActive(key!));
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a drained 'user' message from a DIFFERENT enqueuer stamps THE ENQUEUER, not the drainer", async () => {
    // Shared chat: editor u-editor queued while owner u-owner's run was busy.
    // The drain runs under the FINISHING run's identity (u-owner), but the
    // pending row remembers who sent it — the stamp must name u-editor.
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-auth', chatId: 'chat-auth-c', userId: 'u-editor', content: 'queued teammate msg',
      mode: 'single_thinking', source: 'user', createdAt: new Date(),
    });
    const row = userRowEndingWith('queued teammate msg');
    const key = await startDetachedChatRun({ ...BASE, userId: 'u-owner', chatId: 'chat-auth-c', sessionId: null });
    expect(key).toBe('chat:chat-auth-c');
    await waitFor(() => !!row());
    expect(row().metadata).toMatchObject({ origin: 'user', authorId: 'u-editor' });
    await waitFor(() => !isRunActive('chat:chat-auth-c'));
    await new Promise((r) => setTimeout(r, 100)); // let the drained run's own fire-and-forget drain settle
  });
});

describe('orchestrator empty-output handling (feedback 5f22a689: Kimi K3 returned nothing, silently)', () => {
  const agentCalls = () => (runCodingAgent as jest.Mock).mock.calls.length;
  const persistedAssistant = () => mockPrisma.crossModelMessage.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .find((d: any) => d?.role === 'assistant');
  const kimiCard = () => {
    const models = persistedAssistant()?.metadata?.models ?? {};
    return Object.values(models).find((m: any) => (m as any).modelUsed === 'kimi-k3') as any;
  };

  beforeEach(() => {
    // The file-level mocks accumulate calls across tests (the doctrine suites
    // read .at(-1) for that reason) — count only THIS test's orchestrator runs.
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
  });

  it('an empty NO-TOOL orchestrator run is retried once; a still-empty result stamps the model card with an error', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-empty-a', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(2); // exactly one bounded retry — not a loop
    expect(persistedAssistant().content).toContain("wasn't able to generate a response");
    expect(kimiCard()?.error).toBeTruthy(); // the card explains instead of rendering blank
  });

  it('an empty run WITH tool rounds is NOT retried (side-effect replay guard) but still logged + error-stamped', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [{ type: 'tool_call', name: 'web_search', args: {} }] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-empty-b', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
    expect(kimiCard()?.error).toBeTruthy();
  });

  // ── Rollout watch 2026-09-15 (tick 12): empty MACHINE wakes on the built-in seat ──
  // 16 supervisor wakes in 24h closed as "the model returned no text on this
  // wake" — every one had fired read-only tools (get_chat_status, goal_list…),
  // so the no-tool replay above never applied and the seat fallback is for
  // override seats only. A machine wake whose tool work was READ-ONLY gets ONE
  // retry carrying the read results as evidence; a mutating tool forbids it.
  const MACHINE = { ...BASE, mode: 'thinking' as const, userId: 'u1', sessionId: null, machineWake: true, messageOrigin: 'schedule' as const };

  it('an empty MACHINE wake after READ-ONLY tool work is retried once with the evidence in the notice; the recovered note is delivered', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: '', parts: [
        { type: 'tool_call', name: 'get_chat_status', args: { chatId: 'abc' } },
        { type: 'tool_result', name: 'get_chat_status', result: 'idle, plan 7/7' },
      ] })
      .mockResolvedValueOnce({ finalText: 'WAKE: no-op — nothing moved on any project since 05:40Z', parts: [] });
    const key = await startDetachedChatRun({ ...MACHINE, chatId: 'chat-mw-empty-a' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(2); // exactly one bounded retry
    const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
    expect(second.userMessage).toContain('EMPTY COMPLETION');
    expect(second.userMessage).toContain('get_chat_status');
    expect(second.userMessage).toContain('do not re-fetch');
    expect(persistedAssistant().content).toContain('nothing moved on any project since 05:40Z');
    expect(persistedAssistant().content).not.toContain('the model returned no text');
  });

  it('a still-empty retry closes with the empty-wake note (no loop)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [
      { type: 'tool_call', name: 'list_chats', args: {} }, { type: 'tool_result', name: 'list_chats', result: '2 chats' },
    ] });
    const key = await startDetachedChatRun({ ...MACHINE, chatId: 'chat-mw-empty-b' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(2);
    expect(persistedAssistant().content).toContain('the model returned no text on this wake');
  });

  // Ticket 66007a6e: the web-probe receipt class mints (collector-only) ok
  // receipts for web tools — a web_pipe ok receipt must NOT flip the acted
  // count at the empty-wake note (:4955) and mislabel a probe-only wake as an
  // action wake. READ_ONLY_TOOL_RE gained web_pipe|youtube_pipe for exactly
  // this; scrape_/search_engine already matched.
  it('(ticket 66007a6e) a web_pipe ok receipt does NOT count as acted — a probe-only empty wake still closes no-op', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [
      { type: 'tool_call', name: 'web_pipe', args: { query: 'cql.ca status' } },
      { type: 'tool_result', name: 'web_pipe', result: 'digest\n\nSOURCES:\n- x (https://x/)' },
    ], receipts: [
      { id: 'r1', chatId: 'chat-mw-empty-b', runId: null, tool: 'web_pipe', ok: true, ids: { query: 'cql.ca status' }, inputHash: null, outputHash: null, createdAt: new Date() },
    ] });
    const key = await startDetachedChatRun({ ...MACHINE, chatId: 'chat-mw-empty-b' });
    await waitFor(() => !isRunActive(key!));
    // Web tools are read-only (never REPLAY_UNSAFE_TOOLS) — the bounded retry fires.
    expect(agentCalls()).toBe(2);
    // And the closing note is the no-op line, never "N tool action(s) ran".
    expect(persistedAssistant().content).toContain('the model returned no text on this wake');
    expect(persistedAssistant().content).not.toContain('tool action(s) ran this wake');
  });

  it('a machine wake that fired a MUTATING tool is never replayed (side effects already happened)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [
      { type: 'tool_call', name: 'get_chat_status', args: {} },
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'x', message: 'y' } },
    ] });
    const key = await startDetachedChatRun({ ...MACHINE, chatId: 'chat-mw-empty-c' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
  });

  // ── OWNER turn on a SUPERVISOR chat (tt-rd audit 2026-09-27, finding 4 — the 871d203b failure) ──
  // The owner's 19:16Z "what is going on…" ended EMPTY after 5 tool calls on
  // glm-5.3; the harness persisted the fallback note and nothing re-woke the
  // supervisor. Now: ONE retry carrying the evidence (update_supervisor_state
  // is replay-safe), and a still-failed reply enqueues ONE direct re-wake.
  const SUPERVISOR = { title: 'tt-rd Supervisor', isProjectSupervisor: true, userId: 'u1', projectId: 'p-ttrd' };
  const withSupervisorChat = async (body: () => Promise<void>) => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => SUPERVISOR);
    let n = 0;
    mockPrisma.crossModelMessage.create.mockImplementation(async (a: any) => ({ id: `row-${a?.data?.role}-${++n}`, ...(a?.data ?? {}) }));
    mockEnqueueDirectWake.mockClear();
    try { await body(); } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
      mockPrisma.crossModelMessage.create.mockImplementation(async () => ({}));
    }
  };
  const OWNER = { ...BASE, message: 'what is going on with the speed mission', mode: 'thinking' as const, userId: 'u1', sessionId: null };

  it('an empty OWNER turn after tool work (incl. update_supervisor_state) is retried once with the evidence; the recovered answer is delivered and no re-wake is enqueued', async () => {
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: '', parts: [
          { type: 'tool_call', name: 'goal_list', args: {} }, { type: 'tool_result', name: 'goal_list', result: '2 active goals' },
          { type: 'tool_call', name: 'update_supervisor_state', args: { notes: 'x' } }, { type: 'tool_result', name: 'update_supervisor_state', result: 'applied' },
        ] })
        .mockResolvedValueOnce({ finalText: 'We are at 5.08 tok/s of record; the bisect is on rung zf (msg 871d203b).', parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-owner-empty-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.userMessage).toContain("answering the OWNER's message ended with NO text");
      expect(second.userMessage).toContain('goal_list');
      expect(second.userMessage).toContain('Answer the owner now');
      expect(persistedAssistant().content).toContain('5.08 tok/s of record');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'owner_turn_empty_retry')).toMatchObject({ meta: expect.objectContaining({ seat: 'project_supervisor', recovered: true, toolCalls: 2 }) });
    });
  });

  // REVIEW F1 (ticket 4f7263e4 first-word opener): the opener is delivered answer
  // text but NOT gate-relevant content. An owner turn whose model streams an
  // opener line, fires tools, then finalizes with NO real text is EMPTY for the
  // replay gate — pre-fix, adapter.answerText carried the opener and the gate
  // went blind (the 871d203b class, disguised as a non-empty bubble).
  it('REVIEW F1: an owner turn that streamed only a FIRST-WORD OPENER before its tools still counts as EMPTY — the owner-turn replay fires and the real answer is delivered', async () => {
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock)
        .mockImplementationOnce(async (input: any) => {
          // The model opens with the doctrine's one-line opener, fires a read-only tool…
          input.emit('text', { delta: 'Yes — pulling the live rung state now.' });
          input.emit('tool_call', { name: 'goal_list', args: {} });
          input.emit('tool_result', { name: 'goal_list', result: '2 active goals' });
          // …and finalizes with NO final text (reasoning-only tail — the incident class).
          return { finalText: '', parts: [
            { type: 'tool_call', name: 'goal_list', args: {} }, { type: 'tool_result', name: 'goal_list', result: '2 active goals' },
          ] };
        })
        .mockResolvedValueOnce({ finalText: 'We are at 5.08 tok/s of record; the bisect is on rung zf.', parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-owner-opener-only' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // the replay gate FIRED despite the streamed opener
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.userMessage).toContain("answering the OWNER's message ended with NO text");
      expect(persistedAssistant().content).toContain('5.08 tok/s of record');
    });
  });

  it('a still-empty owner turn persists the fallback note AND enqueues ONE [OWNER ASK UNANSWERED] re-wake naming the ask', async () => {
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [{ type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'tool_result', name: 'get_chat_status', result: 'idle' }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-owner-empty-b' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      expect(persistedAssistant().content).toContain("wasn't able to generate a response");
      await waitFor(() => mockEnqueueDirectWake.mock.calls.length > 0);
      const wake = mockEnqueueDirectWake.mock.calls[0][0];
      expect(wake.targetChatId).toBe('chat-owner-empty-b');
      expect(wake.prompt).toContain('[OWNER ASK UNANSWERED] The owner asked "what is going on with the speed mission" (msg row-user');
      expect(wake.meta).toMatchObject({ kind: 'owner_ask_unanswered', reason: 'empty' });
    });
  });

  it('an owner turn that fired a MUTATING tool (send_chat_message) is never replayed — the fallback note still triggers the re-wake', async () => {
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [{ type: 'tool_call', name: 'send_chat_message', args: { chatId: 'x', content: 'y' } }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-owner-empty-c' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      await waitFor(() => mockEnqueueDirectWake.mock.calls.length > 0);
    });
  });

  // REVIEW F1 (ticket 4f7263e4), the plain-lane twin: a HUMAN plain-chat turn
  // (no supervisor chat) whose model streams an opener, fires a read-only tool,
  // then finalizes empty takes the no-tool/empty-retry path too — the streamed
  // opener must not mask emptiness for the firstIsEmpty gate.
  it('REVIEW F1: a plain-chat owner turn that streamed only a FIRST-WORD OPENER then finalized empty is retried once (the opener does not mask the empty run)', async () => {
    (runCodingAgent as jest.Mock)
      .mockImplementationOnce(async (input: any) => {
        input.emit('text', { delta: 'The answer is coming — pulling the numbers now.' });
        input.emit('tool_call', { name: 'web_pipe', args: { query: 'q' } });
        input.emit('tool_result', { name: 'web_pipe', result: 'r' });
        return { finalText: '', parts: [] };
      })
      .mockResolvedValueOnce({ finalText: 'The number is 42, confirmed.', parts: [] });
    const key = await startDetachedChatRun({ ...BASE, message: 'what is the number', chatId: 'chat-plain-opener-only', userId: 'u1', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(2); // the 5f22a689 empty retry fired despite the opener
    expect(persistedAssistant().content).toContain('The number is 42');
  });

  // ── Unbacked dispatch claim (2026-09-29, TB 2.1 v3c bench — unbacked-claim.ts) ──
  // The Project Supervisor answered a relay with "Dispatched this turn — receipt:
  // 9e1c13ea" and NO tool call; the bench lost two trials after five relays.
  const RELAY = { ...OWNER, message: '[TB-RELAY t1] dispatch it NOW with send_chat_message to chatId s-1' };
  const withReceipts = async (existing: string[], body: () => Promise<void>) => {
    const prev = mockPrisma.runToolReceipt;
    mockPrisma.runToolReceipt = { findFirst: jest.fn(async (a: any) => (existing.some((id) => id.startsWith(a?.where?.id?.startsWith)) ? { id: existing[0] } : null)) };
    try { await body(); } finally { mockPrisma.runToolReceipt = prev; }
  };

  it('(unbacked claim) a supervisor answer that claims a dispatch with an INVENTED receipt and no tool call is re-run once; the retry that really sends is delivered', async () => {
    await withSupervisorChat(() => withReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: 'Dispatched this turn — receipt: 9e1c13ea.', parts: [{ type: 'text', text: 'Dispatched this turn — receipt: 9e1c13ea.' }] })
        .mockResolvedValueOnce({ finalText: 'Dispatched — receipt 403b3ad5.', parts: [
          { type: 'tool_call', name: 'send_chat_message', args: { chatId: 's-1' } }, { type: 'tool_result', name: 'send_chat_message', result: 'send receipt 403b3ad5' },
        ] });
      const key = await startDetachedChatRun({ ...RELAY, chatId: 'chat-unbacked-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.userMessage).toContain('HARNESS CHECK — NO TOOL CALL');
      expect(second.userMessage).toContain('9e1c13ea');
      expect(persistedAssistant().content).toContain('403b3ad5');
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'supervisor_unbacked_claim_retry'))
        .toMatchObject({ meta: expect.objectContaining({ seat: 'project_supervisor', invented: ['9e1c13ea'], recovered: true, retrySent: true }) });
    }));
  });

  it('(unbacked claim) a REAL earlier receipt or a turn that called a tool never re-runs', async () => {
    await withSupervisorChat(() => withReceipts(['d0490bf8-1111-2222-3333-444444444444'], async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Already dispatched earlier — receipt d0490bf8.', parts: [] });
      let key = await startDetachedChatRun({ ...RELAY, chatId: 'chat-unbacked-b' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
    }));
    (runCodingAgent as jest.Mock).mockClear();
    await withSupervisorChat(() => withReceipts([], async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Dispatched — receipt 11112222.', parts: [{ type: 'tool_call', name: 'get_chat_messages', args: {} }] });
      const key = await startDetachedChatRun({ ...RELAY, chatId: 'chat-unbacked-c' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
    }));
  });

  // Audit 2026-10-06 T6-3 (others.md F2): "fresh reads at 06:55Z" / "verified … just now" with ZERO tool calls.
  it('(unbacked freshness) a supervisor owner answer claiming FRESH reads with no tool call is re-run once; the retry that really reads is delivered; the kill switch keeps one attempt', async () => {
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: 'FULL STATE CHECK — fresh reads at 06:55Z: all 4 lanes idle.', parts: [{ type: 'text', text: 'FULL STATE CHECK — fresh reads at 06:55Z: all 4 lanes idle.' }] })
        .mockResolvedValueOnce({ finalText: 'Read just now via get_chat_status: 3 lanes idle, 1 running.', parts: [
          { type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'tool_result', name: 'get_chat_status', result: '3 idle, 1 running' },
        ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-fresh-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.userMessage).toContain('HARNESS CHECK — NO TOOL CALL');
      expect(second.userMessage).toContain('fresh reads at 06:55Z');
      expect(persistedAssistant().content).toContain('1 running');
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'supervisor_unbacked_claim_retry' && r.sessionId === 'chat-fresh-a').pop())
        .toMatchObject({ meta: expect.objectContaining({ claim: 'freshness', invented: [], recovered: true, retryToolCalls: 1 }) });
    });
    (runCodingAgent as jest.Mock).mockClear();
    process.env.SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED = '1';
    try {
      await withSupervisorChat(async () => {
        (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'FULL STATE CHECK — fresh reads at 06:55Z: all idle.', parts: [] });
        const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-fresh-b' });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(1);
      });
    } finally { delete process.env.SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED; }
  });

  it('(unbacked freshness) an honest "not read this turn" answer or a turn that called a tool never re-runs', async () => {
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'No fresh reads this turn — these figures are from the 05:40Z wake.', parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-fresh-c' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
    });
    (runCodingAgent as jest.Mock).mockClear();
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Fresh reads at 06:55Z: all idle.', parts: [{ type: 'tool_call', name: 'list_chats', args: {} }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-fresh-d' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
    });
  });

  // Audit 2026-10-08 W1-2 (supervisors F1, chats F1): StAnne 8c581bc3 "I've messaged chat d1d0b346" with
  // ZERO tool calls — no "receipt" word, so the dispatch check never fired; CanLaw 74471a68's retry still
  // made no tool call and shipped the re-fabricated claim.
  const STANNE = "**The tt-rd supervisor is asking the lane directly why 128K didn't land.** I've messaged chat d1d0b346 (the node-a supervisor in the tt-rd project) with the exact live numbers. I'll relay it here as soon as it responds.";
  it('(unbacked action) "I\'ve messaged chat d1d0b346" with no tool call is re-run once; the retry that really sends is delivered', async () => {
    await withSupervisorChat(() => withReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STANNE, parts: [{ type: 'text', text: STANNE }] })
        .mockResolvedValueOnce({ finalText: 'Sent to the tt-rd supervisor (810c924d) — receipt 35fcbce8. I will relay its answer here.', parts: [
          { type: 'tool_call', name: 'send_chat_message', args: { chatId: '810c924d' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
        ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-action-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.userMessage).toContain('HARNESS CHECK — NO MATCHING TOOL CALL');
      expect(second.userMessage).toContain("I've messaged chat d1d0b346");
      expect(persistedAssistant().content).toContain('receipt 35fcbce8');
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'supervisor_unbacked_claim_retry' && r.sessionId === 'chat-action-a').pop())
        .toMatchObject({ meta: expect.objectContaining({ claim: 'action', classes: ['send'], recovered: true, retrySent: true, rewritten: 0, retried: true }) });
    }));
  });

  it('(unbacked action) a retry that STILL makes no tool call never ships the claim — the sentence is rewritten honestly', async () => {
    await withSupervisorChat(() => withReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STANNE, parts: [] })
        .mockResolvedValueOnce({ finalText: "Done — I've messaged chat d1d0b346 again with the numbers.", parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-action-b' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const content = persistedAssistant().content;
      expect(content).not.toContain("I've messaged chat d1d0b346");
      expect(content).toContain('I have not sent that message yet — nothing went out in this answer.');
      // the transcript parts (rendered over content) carry the honest text too
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain("I've messaged chat d1d0b346");
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'supervisor_unbacked_claim_retry' && r.sessionId === 'chat-action-b').pop())
        .toMatchObject({ meta: expect.objectContaining({ claim: 'action', recovered: false, residualClasses: expect.arrayContaining(['send']) }) });
    }));
  });

  // 2026-10-21 (FSN1021): owner Paul's Fleet Supervisor chat — the retry still made no tool call and the
  // delivered answer paired the honest line with "Both actions are running in the background".
  const FSN_PROMISE = "I'm sending the AGX lane the Tailscale rule as a standing order now and withdrawing the card.";
  const FSN_CONT = 'Both actions are running in the background — the AGX lane gets the rule now, and the card is withdrawn so it stops showing in your inbox.';
  const FSN_NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
  // The note also reads the chat's receipts since the owner's message (an earlier attempt's calls).
  const withTurnReceipts = async (tools: string[], body: () => Promise<void>) => {
    const rtr = mockPrisma.runToolReceipt;
    const prev = rtr.findMany;
    rtr.findMany = jest.fn(async () => tools.map((tool) => ({ tool })));
    try { await body(); } finally { rtr.findMany = prev; }
  };
  const noteMetric = (chatId: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'supervisor_unbacked_claim_retry' && r.sessionId === chatId).pop();

  it('(no-action note) a zero-tool retry that still says "running in the background" ships with ONE inserted harness line — nothing deleted', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [{ type: 'text', text: `${FSN_PROMISE}\n\n${FSN_CONT}` }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const content = persistedAssistant().content;
      expect(content).toContain(FSN_CONT);
      expect(content.trimEnd().endsWith(FSN_NOTE)).toBe(true);
      expect(content.split('Harness check:').length - 1).toBe(1);
      // the note rides as its own trailing part — the run's earlier text parts are kept
      const textParts = (persistedAssistant().parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text);
      expect(textParts.some((t: string) => t.includes(FSN_CONT))).toBe(true);
      expect(textParts[textParts.length - 1]).toContain(FSN_NOTE);
      expect(noteMetric('chat-noaction-a')).toMatchObject({ meta: expect.objectContaining({ claim: 'action', noActionNote: true }) });
    })));
  });

  it('(no-action note) never when the turn acted: a retry that sends, an earlier attempt\'s replayed write, or a receipt since the owner\'s message', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
        .mockResolvedValueOnce({ finalText: 'Sent the rule to the AGX lane (receipt 35fcbce8); it is running in the background now.', parts: [
          { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'e03452f4' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
        ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-b' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    // attempt 1 really wrote the ledger (replay-safe, so the retry runs); the retry makes no tool call
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [
          { type: 'tool_call', name: 'update_supervisor_state', args: {} }, { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true}' },
        ] })
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-c' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    // an earlier attempt (seat fallback / empty retry) sent before the delivered run: its receipt is on the chat
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts(['send_chat_message'], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-d' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
    })));
  });

  it('(no-action note) an honest retry needs no line; a retry whose text came back empty but that SENT counts as acting', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
        .mockResolvedValueOnce({ finalText: "I haven't sent anything yet. The AGX lane's own deploy is underway on its side.", parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-g' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
        .mockResolvedValueOnce({ finalText: '', parts: [
          { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'e03452f4' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
        ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-h' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
      // (the honest rewrite of attempt 1's claim still reads "nothing went out" here — pre-existing main behaviour, its own follow-up task)
    })));
  });

  it('(no-action note) review round 3: a model-written copy of the line never ships on an acting turn', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const forged = `Sent the rule to the AGX lane (receipt 35fcbce8).\n\n${FSN_NOTE}`;
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: forged, parts: [
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'e03452f4' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
        { type: 'text', text: forged },
      ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-i' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain('Harness check:');
    })));
  });

  it('(no-action note) review round 3: a model copy beside the harness line never doubles it in content or parts', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const withCopy = `${FSN_PROMISE}\n\n${FSN_CONT}\n\n${FSN_NOTE}`;
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
        .mockResolvedValueOnce({ finalText: withCopy, parts: [{ type: 'text', text: withCopy }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-j' });
      await waitFor(() => !isRunActive(key!));
      const content = persistedAssistant().content;
      expect(content.split('Harness check:').length - 1).toBe(1);
      const partsText = (persistedAssistant().parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
      expect(partsText.split('Harness check:').length - 1).toBe(1);
    })));
  });

  // ── review round 4 ──
  it('(no-action note) round 4: an earlier attempt\'s READ never switches off the zero-tool dispatch check — a fabricated receipt in the retry is rewritten, kill switch on or off', async () => {
    for (const disabled of [false, true]) {
      if (disabled) process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED = '1';
      try {
        (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
        await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
          (runCodingAgent as jest.Mock)
            .mockResolvedValueOnce({ finalText: "I've messaged chat d1d0b346 with the rule.", parts: [
              { type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'tool_result', name: 'get_chat_status', result: '{}' },
            ] })
            .mockResolvedValueOnce({ finalText: 'Dispatched this turn — receipt: 9e1c13ea.', parts: [] });
          const key = await startDetachedChatRun({ ...OWNER, chatId: `chat-noaction-r4a-${disabled ? 'off' : 'on'}` });
          await waitFor(() => !isRunActive(key!));
          expect(agentCalls()).toBe(2);
          expect(persistedAssistant().content).not.toContain('9e1c13ea');
        })));
      } finally { delete process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED; }
    }
  });

  it('(no-action note) round 4: a model copy in an INTERMEDIATE text part never ships on an acting turn', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Sent the rule to the AGX lane (receipt 35fcbce8).', parts: [
        { type: 'text', text: `Checking the ledger first.\n\n${FSN_NOTE}` },
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'e03452f4' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
        { type: 'text', text: 'Sent the rule to the AGX lane (receipt 35fcbce8).' },
      ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r4c' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain('Harness check:');
    })));
  });

  it('(no-action note) round 4: a quotation of the line is the model\'s own words — kept on a supervisor turn, and a plain chat is never touched', async () => {
    const quoted = `That footer reads "${FSN_NOTE}" — it is a harness line.`;
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: quoted, parts: [{ type: 'text', text: quoted }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r4d' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).toContain(quoted);
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    const standalone = `Here it is:\n\n${FSN_NOTE}`;
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: standalone, parts: [{ type: 'text', text: standalone }] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-noaction-r4e', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(persistedAssistant().content).toContain(FSN_NOTE);
  });

  // ── review round 5 ──
  it('(no-action note) round 5: a read the claim check calls a read (web_pipe, gmail_search, user-MCP *_search) never backs a change claim', async () => {
    for (const read of ['web_pipe', 'gmail_search', 'mcp_notion_search']) {
      (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
      await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
        const claim = "I've updated the supervisor ledger with the AGX rule.";
        (runCodingAgent as jest.Mock)
          .mockResolvedValueOnce({ finalText: claim, parts: [{ type: 'tool_call', name: read, args: {} }, { type: 'tool_result', name: read, result: '{}' }] })
          .mockResolvedValueOnce({ finalText: claim, parts: [{ type: 'tool_call', name: read, args: {} }, { type: 'tool_result', name: read, result: '{}' }] });
        const key = await startDetachedChatRun({ ...OWNER, chatId: `chat-noaction-r5a-${read}` });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(2);
        expect(persistedAssistant().content).toContain('I have not made that change yet');
      })));
    }
  });

  it('(no-action note) round 5: an earlier attempt\'s web read never backs the retry\'s zero-tool change claim', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: "I've messaged chat d1d0b346 with the rule.", parts: [{ type: 'tool_call', name: 'web_pipe', args: {} }, { type: 'tool_result', name: 'web_pipe', result: '{}' }] })
        .mockResolvedValueOnce({ finalText: "I've paused the AGX schedule so it stops firing.", parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r5b' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      expect(persistedAssistant().content).not.toContain("I've paused the AGX schedule");
    })));
  });

  it('(no-action note) round 5: an earlier attempt\'s replay-safe ledger write never blocks the leak retry', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const clean = 'The AGX lane is on step 4; nothing is blocked.';
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: '', parts: [{ type: 'tool_call', name: 'goal_list', args: {} }, { type: 'tool_result', name: 'goal_list', result: '{}' }, { type: 'tool_call', name: 'update_supervisor_state', args: {} }, { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true}' }] })
        .mockResolvedValueOnce({ finalText: 'list_chats({"limit": 20})', parts: [{ type: 'text', text: 'list_chats({"limit": 20})' }] })
        .mockResolvedValueOnce({ finalText: clean, parts: [{ type: 'text', text: clean }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r5c' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(3);
      expect(persistedAssistant().content).toBe(clean);
    })));
  });

  it('(no-action note) round 5: when the finalize strips a model copy, live viewers get the stripped text on complete', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const sent = 'Sent the rule to the AGX lane (receipt 35fcbce8).';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: `${sent}\n\n${FSN_NOTE}`, parts: [
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'e03452f4' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
        { type: 'text', text: `${sent}\n\n${FSN_NOTE}` },
      ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r5d' });
      const events: Array<{ type: string; data: any }> = [];
      subscribeRun(key!, (e: any) => events.push(e));
      await waitFor(() => events.some((e) => e.type === 'complete'));
      await waitFor(() => !isRunActive(key!));
      const complete = events.find((e) => e.type === 'complete')!.data;
      expect(String(complete.finalText ?? '')).toContain(sent);
      expect(String(complete.finalText ?? '')).not.toContain('Harness check:');
    })));
  });

  it('(no-action note) round 6: claim checks judge the delivered attempt exactly as main — an earlier connector read or ledger write never backs a zero-tool claim', async () => {
    // (a) attempt 1 read Gmail and claimed a send; the zero-tool retry claims an unrelated change
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: "I've messaged chat d1d0b346 with the rule.", parts: [{ type: 'tool_call', name: 'gmail_get_message', args: {} }, { type: 'tool_result', name: 'gmail_get_message', result: '{}' }] })
        .mockResolvedValueOnce({ finalText: "I've paused the AGX schedule so it stops firing.", parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r6a' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain("I've paused the AGX schedule");
    })));
    // (b) the owner empty retry ran past attempt 1's ledger write; the recovered zero-tool answer claims a pause
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: '', parts: [{ type: 'tool_call', name: 'goal_list', args: {} }, { type: 'tool_result', name: 'goal_list', result: '{}' }, { type: 'tool_call', name: 'update_supervisor_state', args: {} }, { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true}' }] })
        .mockResolvedValueOnce({ finalText: "I've paused the AGX schedule so it stops firing.", parts: [] })
        .mockResolvedValueOnce({ finalText: "I've paused the AGX schedule so it stops firing.", parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r6b' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain("I've paused the AGX schedule");
    })));
  });

  // ── HR-1 (todo 76fd0cce) ──
  it('(HR-1 case 1) an earlier attempt\'s update_supervisor_state backs the retry\'s ledger claim — the turn-aware line ships, never "nothing was changed"', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const claim = "I've updated the supervisor ledger with the AGX rule.";
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: '', parts: [
          { type: 'tool_call', name: 'goal_list', args: {} }, { type: 'tool_result', name: 'goal_list', result: '{}' },
          { type: 'tool_call', name: 'update_supervisor_state', args: { notes: 'agx rule' } }, { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true}' },
        ] })
        .mockResolvedValueOnce({ finalText: claim, parts: [] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-hr1-s1' });
      await waitFor(() => !isRunActive(key!));
      const content = persistedAssistant().content;
      expect(content).toContain('the `update_supervisor_state` call is in the turn\'s tool log');
      expect(content).not.toContain('nothing was changed in this answer');
    })));
  });

  it('(HR-1 case 2) the unbacked retry really SENT but returned empty — the earlier attempt\'s claim is not rewritten to "nothing went out"', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const claim = "I've messaged chat d1d0b346 with the rule.";
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: claim, parts: [] })
        .mockResolvedValueOnce({ finalText: '', parts: [
          { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'd1d0b346', content: 'the rule' } },
          { type: 'tool_result', name: 'send_chat_message', result: 'send receipt 403b3ad5' },
        ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-hr1-s2' });
      await waitFor(() => !isRunActive(key!));
      const content = persistedAssistant().content;
      // The send really ran (in the retry), so the claim is TRUE: the sentence ships as written.
      expect(content).not.toContain('nothing went out in this answer');
      expect(content).toContain("I've messaged chat d1d0b346 with the rule.");
    })));
  });

  it('(HR-1 case 3) a TRUE ticket close backed by resolve_feedback in the delivered run is never rewritten', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const claim = "I've closed ticket 9c307167 via filer self-close.";
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: claim, parts: [
        { type: 'tool_call', name: 'resolve_feedback', args: { id: '9c307167' } },
        { type: 'tool_result', name: 'resolve_feedback', result: '{"ok":true}' },
      ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-hr1-s3' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).toContain('closed ticket 9c307167');
      expect(persistedAssistant().content).not.toContain('I have not made that change yet');
    })));
  });

  it('(HR-1 kill switch) SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED=1 restores the pre-HR-1 false line', async () => {
    process.env.SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED = '1';
    try {
      await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
        const claim = "I've updated the supervisor ledger with the AGX rule.";
        (runCodingAgent as jest.Mock)
          .mockResolvedValueOnce({ finalText: '', parts: [
            { type: 'tool_call', name: 'update_supervisor_state', args: { notes: 'agx rule' } }, { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true}' },
          ] })
          .mockResolvedValueOnce({ finalText: claim, parts: [] });
        const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-hr1-s4' });
        await waitFor(() => !isRunActive(key!));
        expect(persistedAssistant().content).toContain('I have not made that change yet');
      })));
    } finally { delete process.env.SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED; }
  });

  it('(no-action note) round 7: an answer that is ONLY a copy of the line is delivered as written, never emptied into the fallback', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: FSN_NOTE, parts: [{ type: 'text', text: FSN_NOTE }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r7a' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toMatch(/wasn't able to generate|couldn't get an answer/);
      // round 8: content and parts stay in step — a reload never shows an empty bubble
      const texts = (persistedAssistant().parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
      expect(texts).toContain('Harness check:');
    })));
  });

  it('(no-action note) round 9: content and parts put the line in the SAME place when prose follows the chip block', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const t = `${FSN_PROMISE}\n\n${FSN_CONT}\n\n[FOLLOWUPS]\n- What does the AGX lane report now?\n[/FOLLOWUPS]\n\nThat is the whole status for tonight.`;
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: t, parts: [] })
        .mockResolvedValueOnce({ finalText: t, parts: [{ type: 'text', text: t }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r9a' });
      await waitFor(() => !isRunActive(key!));
      const row = persistedAssistant();
      const partsText = (row.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n\n');
      for (const view of [row.content, partsText]) {
        expect(view.split('Harness check:').length - 1).toBe(1);
        expect(view.indexOf('Harness check:')).toBeLessThan(view.indexOf('That is the whole status for tonight.'));
      }
    })));
  });

  it('(no-action note) round 8: a same-line chip block never turns the harness line into a tappable chip', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      const t = `${FSN_PROMISE}\n\n${FSN_CONT} [FOLLOWUPS]\n- What does the AGX lane report now?\n- When will the rule be live?`;
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: t, parts: [] })
        .mockResolvedValueOnce({ finalText: t, parts: [{ type: 'text', text: t }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-r8a' });
      await waitFor(() => !isRunActive(key!));
      const row = persistedAssistant();
      expect(JSON.stringify(row.metadata?.followUps ?? [])).not.toContain('Harness check');
      expect(row.content).toContain(FSN_NOTE);
      expect(row.content.split('Harness check:').length - 1).toBe(1);
    })));
  });

  describe('(no-action note) round 4: Double Checker revisions', () => {
    const workerMock = runChatWorker as jest.Mock;
    const RECONCILED = 'Revised: both actions are running in the background — the AGX lane gets the rule now.';
    // actedSinceTurn reads runToolReceipt.findMany; flips to "a send was minted" once the reconcile pass runs.
    const run = async (chatId: string, actedDuringReconcile: boolean) => {
      let acted = false;
      const drafts: string[] = [];
      process.env.SUPERVISOR_CHECKER_SKIP_DISABLED = '1';
      process.env.ANSWER_FIRST_DISABLED = '1';
      workerMock.mockReset();
      workerMock.mockImplementation(async (i: any) => {
        if (String(i.userMessage).includes('YOUR DRAFT ANSWER')) {
          drafts.push(String(i.userMessage));
          if (actedDuringReconcile) acted = true;
          return { finalText: RECONCILED, parts: [] };
        }
        return { finalText: 'PEER-DRAFT: the AGX lane has not been messaged this turn.', parts: [] };
      });
      try {
        await withSupervisorChat(() => withReceipts([], async () => {
          const rtr = mockPrisma.runToolReceipt;
          rtr.findMany = jest.fn(async () => (acted ? [{ tool: 'send_chat_message' }] : []));
          (runCodingAgent as jest.Mock)
            .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
            .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] });
          const key = await startDetachedChatRun({ ...OWNER, chatId });
          await waitFor(() => !isRunActive(key!));
        }));
      } finally {
        delete process.env.SUPERVISOR_CHECKER_SKIP_DISABLED;
        delete process.env.ANSWER_FIRST_DISABLED;
        workerMock.mockReset();
        workerMock.mockImplementation(async () => ({ finalText: '' }));
      }
      return drafts;
    };

    it('the reconcile pass never sees the line as its draft, and a revision keeps it only after a fresh receipt check', async () => {
      const drafts = await run('chat-noaction-r4f', false);
      expect(drafts.length).toBeGreaterThan(0);
      for (const d of drafts) expect(d).not.toContain('Harness check:');
      const content = persistedAssistant().content;
      expect(content).toContain('Revised:');
      expect(content.split('Harness check:').length - 1).toBe(1);
    });

    it('a revision written after something acted (the checker or reconcile pass minted a send) drops the line', async () => {
      (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
      await run('chat-noaction-r4g', true);
      const content = persistedAssistant().content;
      expect(content).toContain('Revised:');
      expect(content).not.toContain('Harness check:');
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain('Harness check:');
    });
  });

  it('(no-action note) a read-only claim never asks for it; the kill switch restores the old delivery', async () => {
    await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: 'I checked the AGX lane: its PR #412 is queued for merge and CI is underway.', parts: [] })
        .mockResolvedValueOnce({ finalText: 'Read the AGX lane just now: its PR #412 is queued for merge and CI is underway.', parts: [
          { type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'tool_result', name: 'get_chat_status', result: '{}' },
        ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-e' });
      await waitFor(() => !isRunActive(key!));
      expect(persistedAssistant().content).not.toContain('Harness check:');
    })));
    process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED = '1';
    try {
      (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
      await withSupervisorChat(() => withReceipts([], () => withTurnReceipts([], async () => {
        (runCodingAgent as jest.Mock)
          .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] })
          .mockResolvedValueOnce({ finalText: `${FSN_PROMISE}\n\n${FSN_CONT}`, parts: [] });
        const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-noaction-f' });
        await waitFor(() => !isRunActive(key!));
        expect(persistedAssistant().content).not.toContain('Harness check:');
      })));
    } finally { delete process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED; }
  });

  it('(unbacked action) a run that already fired a MUTATING tool is never replayed — the unbacked send is rewritten in place', async () => {
    await withSupervisorChat(() => withReceipts([], async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: "Paused the project. I've messaged the lane with the new plan.", parts: [
        { type: 'tool_call', name: 'update_project', args: { projectId: 'p-ttrd' } }, { type: 'tool_result', name: 'update_project', result: '{"ok":true}' },
      ] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-action-c' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).toBe('Paused the project. I have not sent that message yet — nothing went out in this answer.');
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'supervisor_unbacked_claim_retry' && r.sessionId === 'chat-action-c').pop())
        .toMatchObject({ meta: expect.objectContaining({ replaySkipped: 'update_project', retried: false, rewritten: 1 }) });
    }));
  });

  it('(unbacked action) kill switches: SUPERVISOR_UNBACKED_CLAIM_REWRITE_DISABLED=1 ships the retry as-is; SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED=1 never re-runs', async () => {
    process.env.SUPERVISOR_UNBACKED_CLAIM_REWRITE_DISABLED = '1';
    try {
      await withSupervisorChat(() => withReceipts([], async () => {
        (runCodingAgent as jest.Mock)
          .mockResolvedValueOnce({ finalText: STANNE, parts: [] })
          .mockResolvedValueOnce({ finalText: "I've messaged chat d1d0b346 again.", parts: [] });
        const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-action-d' });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(2);
        expect(persistedAssistant().content).toContain("I've messaged chat d1d0b346 again.");
      }));
    } finally { delete process.env.SUPERVISOR_UNBACKED_CLAIM_REWRITE_DISABLED; }
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    process.env.SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED = '1';
    try {
      await withSupervisorChat(() => withReceipts([], async () => {
        (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: STANNE, parts: [] });
        const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-action-e' });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(1);
        expect(persistedAssistant().content).toContain("I've messaged chat d1d0b346");
      }));
    } finally { delete process.env.SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED; }
  });

  // Audit 2026-10-08 W1-6: the owner answer's header clock is the answer's own (Schooltime b13ea82b: 10:31 at 11:09).
  it('(answer clock) a stale header clock on a supervisor owner answer is restamped from the server clock', async () => {
    const stale = new Date(Date.now() - 40 * 60_000);
    const z = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
    const pdt = (d: Date) => { const m = ((d.getUTCHours() * 60 + d.getUTCMinutes() - 420) % 1440 + 1440) % 1440; const h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} PDT`; };
    const text = `**${pdt(stale)} (${z(stale)}) — capturing right now**\n\nThe guard unlocks either camera shortly.`;
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: text, parts: [{ type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'text', text }] });
      const key = await startDetachedChatRun({ ...OWNER, chatId: 'chat-clock-a' });
      await waitFor(() => !isRunActive(key!));
      const content = persistedAssistant().content;
      expect(content).not.toContain(`(${z(stale)})`);
      expect(content).toContain('— capturing right now**');
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain(`(${z(stale)})`);
      expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'owner_answer_clock_stamped' && r.sessionId === 'chat-clock-a'))
        .toMatchObject({ meta: expect.objectContaining({ from: `${pdt(stale)} (${z(stale)})` }) });
    });
  });

  // ── Owner-turn live-state read (2026-10-22 — owner's Fleet Supervisor chat 21:13Z + 21:46Z; unread-state-note.ts) ──
  // Two owner turns about live state ("is X deployed / running on cluster Y", "was the memory issue fixed") were
  // answered with ZERO tool calls, from memory, stale or wrong. The matcher is mocked at the module boundary by a
  // fake with the real one's contract: a state sentence is unread unless a tool_result of the turn carries its fact
  // token (memory and the own state doc never ground), or the sentence says it was not read this turn (the
  // doctrine disclaimer).
  const STALE = 'Yes — GLM-5.3 is deployed on spark-2 and the memory fix is live.';
  const UNREAD_LINE = 'Harness check: this answer states live status that was not read in this turn — treat it as unverified.';
  const fakeUnread = (text: string, input: any): any[] => {
    const sentence = String(text ?? '').split('\n').find((l) => /\bis deployed on\b/.test(l) && !/not read this turn/.test(l));
    if (!sentence) return [];
    const grounded = (input?.parts || []).some((p: any) => p?.type === 'tool_result' && !['get_supervisor_state', 'search_memory'].includes(p.name) && /spark-2/.test(String(p.result ?? '')));
    return grounded ? [] : [{ sentence, factTokens: ['glm-5.3', 'spark-2'], reason: 'tokens_unread' }];
  };
  const withUnreadMatcher = async (body: () => Promise<void>) => {
    mockFindUnreadProductionState.mockImplementation(fakeUnread);
    try { await body(); } finally { mockFindUnreadProductionState.mockImplementation(() => []); }
  };
  const stateMetric = (chatId: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'supervisor_unread_state_retry' && r.sessionId === chatId).pop();
  const ASK = { ...OWNER, message: 'is glm-5.3 deployed on spark-2 yet, and was the memory issue fixed?' };

  it('(live-state read) a zero-read owner answer stating live state is re-run ONCE with the harness check; the retry that READS is delivered with no line', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      const READ = 'Read just now from the spark lane: GLM-5.3 is deployed on spark-2; the memory fix landed in its latest run.';
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STALE, parts: [{ type: 'text', text: STALE }] })
        .mockResolvedValueOnce({ finalText: READ, parts: [
          { type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'lane-spark' } },
          { type: 'tool_result', name: 'get_chat_messages', result: '{"chatId":"lane-spark","messages":[{"content":"glm-5.3 serving on spark-2, OOM fix merged"}]}' },
          { type: 'text', text: READ },
        ] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // exactly one bounded re-run
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.userMessage).toContain('HARNESS CHECK — LIVE STATE NOT READ');
      expect(second.userMessage).toContain(STALE);
      expect(second.userMessage).toContain('not read this turn');
      const content = persistedAssistant().content;
      expect(content).toContain('Read just now from the spark lane');
      expect(content).not.toContain(UNREAD_LINE);
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain(UNREAD_LINE);
      expect(stateMetric('chat-state-a')).toMatchObject({ meta: expect.objectContaining({ seat: 'project_supervisor', retried: true, stillUnread: false, noted: false, retryToolCalls: 1, hits: 1 }) });
    })));
  });

  it('(live-state read) a retry that STILL states unread live state ships with ONE harness line — before the chips, never a chip itself', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      const withChips = `${STALE}\n\n[FOLLOWUPS]\n- Read the spark-2 lane now?\n[/FOLLOWUPS]`;
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STALE, parts: [] })
        .mockResolvedValueOnce({ finalText: withChips, parts: [{ type: 'text', text: 'Thinking about it.' }, { type: 'text', text: withChips }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-b' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // the line never costs a second re-run
      const row = persistedAssistant();
      expect(row.content).toContain(STALE); // nothing deleted
      expect(row.content.trimEnd().endsWith(UNREAD_LINE)).toBe(true);
      expect(row.content.split('Harness check:').length - 1).toBe(1);
      const textParts = (row.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text);
      expect(textParts[0]).toBe('Thinking about it.'); // the earlier part is kept — only the delivered answer part carries the line
      expect(textParts[textParts.length - 1]).toContain(UNREAD_LINE);
      expect(JSON.stringify(row.parts).split('Harness check:').length - 1).toBe(1);
      expect((row.metadata?.followUps ?? []).some((f: string) => f.includes('Harness check'))).toBe(false);
      expect(stateMetric('chat-state-b')).toMatchObject({ meta: expect.objectContaining({ retried: true, stillUnread: true, noted: true }) });
    })));
  });

  it('(live-state read) a turn that already READ never re-runs (cost guard); a memory / state-doc read is not a read of live state', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: STALE, parts: [
        { type: 'tool_call', name: 'get_chat_status', args: {} }, { type: 'tool_result', name: 'get_chat_status', result: '{"lanes":[{"id":"lane-a","status":"idle"}]}' },
      ] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-c' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).not.toContain(UNREAD_LINE);
      expect(stateMetric('chat-state-c')).toBeUndefined();
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STALE, parts: [
          { type: 'tool_call', name: 'get_supervisor_state', args: {} }, { type: 'tool_result', name: 'get_supervisor_state', result: 'notes: glm-5.3 deployed on spark-2 (last week)' },
        ] })
        .mockResolvedValueOnce({ finalText: 'GLM-5.3 is deployed on spark-2 per my notes (not read this turn — the note is a week old).', parts: [] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-d' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      expect(persistedAssistant().content).toContain('not read this turn');
      expect(persistedAssistant().content).not.toContain(UNREAD_LINE); // the honest exit needs no line
      expect(stateMetric('chat-state-d')).toMatchObject({ meta: expect.objectContaining({ retried: true, stillUnread: false }) });
    })));
  });

  it('(live-state read) one claim re-run per owner turn: after the unbacked-freshness re-run the check only adds the line', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      const FRESH = 'FULL STATE CHECK — fresh reads at 21:46Z.\nGLM-5.3 is deployed on spark-2.';
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: FRESH, parts: [] })
        .mockResolvedValueOnce({ finalText: 'GLM-5.3 is deployed on spark-2.', parts: [] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-e' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // the freshness re-run only — never a third round
      expect((runCodingAgent as jest.Mock).mock.calls[1][0].userMessage).toContain('fresh reads at 21:46Z');
      expect(persistedAssistant().content.trimEnd().endsWith(UNREAD_LINE)).toBe(true);
      expect(stateMetric('chat-state-e')).toMatchObject({ meta: expect.objectContaining({ retried: false, skipped: 'claim_retry_ran', stillUnread: true, noted: true }) });
    })));
  });

  it('(live-state read) a MACHINE wake is untouched — its own observe-only lane records, the note is never re-run or noted', async () => {
    const prevFind = mockPrisma.crossModelChat.findUnique.getMockImplementation();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    try {
      await withUnreadMatcher(async () => {
        mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, audited: true, phantoms: [] }));
        (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: `${STALE}\n\nWAKE: no-op — nothing moved since the previous wake`, parts: [], receipts: [] });
        const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-state-machine', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(1);
        expect(persistedAssistant().content).not.toContain(UNREAD_LINE);
        expect(stateMetric('chat-state-machine')).toBeUndefined();
        expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).some((r) => r?.sessionId === 'chat-state-machine' && r?.meta?.seam === 'machine_wake_production_state')).toBe(true);
      });
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(prevFind ?? (async () => ({ title: 'A proper existing title' })));
    }
  });

  it('(live-state read) SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED=1 keeps one attempt and no line; a plain chat is never judged', async () => {
    process.env.SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED = '1';
    try {
      await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
        (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: STALE, parts: [] });
        const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-off' });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(1);
        expect(persistedAssistant().content).toBe(STALE);
        expect(stateMetric('chat-state-off')).toBeUndefined();
      })));
    } finally { delete process.env.SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED; }
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    await withUnreadMatcher(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: STALE, parts: [] });
      const key = await startDetachedChatRun({ ...BASE, message: 'is glm-5.3 deployed?', mode: 'single_thinking', userId: 'u1', chatId: 'chat-state-plain', sessionId: null });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).not.toContain(UNREAD_LINE);
      expect(stateMetric('chat-state-plain')).toBeUndefined();
    });
  });

  it('(live-state read) only the harness writes the line — a model copy on a turn it did not note is removed', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      const copied = `GLM-5.3 is deployed on spark-2 (read below).\n\n${UNREAD_LINE}`;
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: copied, parts: [
        { type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'lane-spark' } },
        { type: 'tool_result', name: 'get_chat_messages', result: '{"chatId":"lane-spark","messages":[{"content":"serving on spark-2"}]}' },
        { type: 'text', text: copied },
      ] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-copy' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).toBe('GLM-5.3 is deployed on spark-2 (read below).');
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain(UNREAD_LINE);
    })));
  });

  // ── Review 2026-10-22 (finding 1): the re-run's answer is held to the checks every delivered owner answer gets ──
  it('(live-state read) a re-run that NARRATES a tool call it never made is never swapped in — attempt 1 ships, with the line', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      const NARRATED = "*(Calling get_chat_status on the spark lane…)* Fresh read: it is serving. I've pinged the lane to confirm.";
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STALE, parts: [{ type: 'text', text: STALE }] })
        .mockResolvedValueOnce({ finalText: NARRATED, parts: [{ type: 'text', text: NARRATED }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-leak' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // still ONE bounded re-run — never a third round
      const row = persistedAssistant();
      expect(row.content).toContain(STALE);
      expect(row.content).not.toContain('Calling get_chat_status');
      expect(row.content).not.toContain('pinged the lane');
      expect(row.content.trimEnd().endsWith(UNREAD_LINE)).toBe(true);
      expect(JSON.stringify(row.parts ?? [])).not.toContain('Calling get_chat_status');
      expect(stateMetric('chat-state-leak')).toMatchObject({ meta: expect.objectContaining({ retried: true, retryRejected: 'tool_call_leak', stillUnread: true, noted: true }) });
    })));
  });

  it('(live-state read) a swapped-in re-run is held to the claim check — its unbacked send / freshness claims are rewritten honestly, never delivered', async () => {
    await withSupervisorChat(() => withReceipts([], () => withUnreadMatcher(async () => {
      const CLAIMED = "Fresh reads just now: the spark lane answered. I've messaged the spark lane to confirm the rollout.";
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: STALE, parts: [{ type: 'text', text: STALE }] })
        .mockResolvedValueOnce({ finalText: CLAIMED, parts: [{ type: 'text', text: CLAIMED }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-claim' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const content = persistedAssistant().content;
      expect(content).not.toContain("I've messaged the spark lane");
      expect(content).toContain('I have not sent that message yet — nothing went out in this answer.');
      expect(JSON.stringify(persistedAssistant().parts ?? [])).not.toContain("I've messaged the spark lane");
      const meta = stateMetric('chat-state-claim')?.meta;
      expect(meta).toMatchObject({ retried: true });
      expect(meta.rewritten).toBeGreaterThanOrEqual(1);
      expect(meta.residualClasses).toEqual(expect.arrayContaining(['send']));
      expect(meta.retryRejected).toBeUndefined();
    })));
  });

  // ── Review 2026-10-22 (findings 2 + 4): the REAL action-verifier matcher on realistic owner answers ──
  // The fake above only pins the seam's wiring; these load the real matcher (isolated registry — its import chain
  // stays out of this file's shared one) so chips, offers, the em-dash honest exit and the incident text are
  // judged exactly as production judges them.
  let realVerifier: any = null;
  const withRealUnreadMatcher = async (body: () => Promise<void>) => {
    if (!realVerifier) jest.isolateModules(() => { realVerifier = jest.requireActual('../platform/action-verifier'); });
    const prevGround = mockProductionStateHasGroundingRead.getMockImplementation();
    mockFindUnreadProductionState.mockImplementation((t: string, i: any) => realVerifier.findUnreadProductionStateClaims(t, i));
    mockProductionStateHasGroundingRead.mockImplementation((i: any) => realVerifier.productionStateHasGroundingRead(i));
    try { await body(); } finally {
      mockFindUnreadProductionState.mockImplementation(() => []);
      if (prevGround) mockProductionStateHasGroundingRead.mockImplementation(prevGround);
    }
  };

  it('(live-state read, real matcher) chips, an offer and a restated question are never claims — no re-run, no line', async () => {
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      const ANSWER = 'You asked whether glm-5.3 is deployed on spark-2. I have not looked at the spark lane yet. Want me to verify that the v0.6.3 agent is deployed on mbp-1?'
        + "\n\n[FOLLOWUPS]\n- Is GLM-5.3 still serving on spark-2?\n- Check that PR 1888 is deployed on main head\n- What's running in production?\n[/FOLLOWUPS]";
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: ANSWER, parts: [{ type: 'text', text: ANSWER }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-real-chips' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).not.toContain(UNREAD_LINE);
      expect(stateMetric('chat-state-real-chips')).toBeUndefined();
    })));
  });

  it('(live-state read, real matcher) the honest exit behind an em-dash ("— not read this turn") is never re-run or noted', async () => {
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      const HONEST = 'GLM-5.3 is deployed on spark-2 — not read this turn; my last note on it is from 20:00Z.';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: HONEST, parts: [{ type: 'text', text: HONEST }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-real-dash' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).toBe(HONEST);
      expect(stateMetric('chat-state-real-dash')).toBeUndefined();
    })));
  });

  it('(live-state read, real matcher) the incident answer is re-run once and the retry\'s lane read grounds it; a retry that still states unread state gets the line before its chips, which are never quoted', async () => {
    const INCIDENT = 'Yes — GLM-5.3 is deployed on spark-2 and the memory fix is live.';
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      const READ = 'Read just now from the spark lane: GLM-5.3 is deployed on spark-2; its latest run reports the OOM fix merged.';
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: INCIDENT, parts: [{ type: 'text', text: INCIDENT }] })
        .mockResolvedValueOnce({ finalText: READ, parts: [
          { type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'lane-spark' } },
          { type: 'tool_result', name: 'get_chat_messages', result: '{"chatId":"lane-spark","messages":[{"content":"glm-5.3 serving on spark-2, OOM fix merged"}]}' },
          { type: 'text', text: READ },
        ] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-real-a' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      expect((runCodingAgent as jest.Mock).mock.calls[1][0].userMessage).toContain('HARNESS CHECK — LIVE STATE NOT READ');
      expect(persistedAssistant().content).toContain('Read just now from the spark lane');
      expect(persistedAssistant().content).not.toContain(UNREAD_LINE);
      expect(stateMetric('chat-state-real-a')).toMatchObject({ meta: expect.objectContaining({ retried: true, stillUnread: false, noted: false }) });
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      const STILL = 'GLM-5.3 is deployed on spark-2.\n\n[FOLLOWUPS]\n- Is the memory fix still live on spark-2?\n[/FOLLOWUPS]';
      const CHIPPED = `${INCIDENT}\n\n[FOLLOWUPS]\n- Is GLM-5.3 still serving on spark-2?\n[/FOLLOWUPS]`;
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: CHIPPED, parts: [{ type: 'text', text: CHIPPED }] })
        .mockResolvedValueOnce({ finalText: STILL, parts: [{ type: 'text', text: STILL }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-real-b' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const notice = (runCodingAgent as jest.Mock).mock.calls[1][0].userMessage;
      expect(notice).toContain('GLM-5.3 is deployed on spark-2');
      expect(notice).not.toContain('still serving on spark-2?'); // a chip is never quoted back as a claim
      const row = persistedAssistant();
      expect(row.content.split('Harness check:').length - 1).toBe(1);
      expect(row.content.indexOf(UNREAD_LINE)).toBeLessThan(row.content.indexOf('[FOLLOWUPS]') === -1 ? Infinity : row.content.indexOf('[FOLLOWUPS]'));
      expect((row.metadata?.followUps ?? []).some((f: string) => f.includes('Harness check'))).toBe(false);
      expect(stateMetric('chat-state-real-b')).toMatchObject({ meta: expect.objectContaining({ retried: true, stillUnread: true, noted: true }) });
    })));
  });

  it('(live-state read, real matcher) scope: a past-tense "was fixed in PR 1888" is the history register — never re-run (only present deployed / serving / running state is judged)', async () => {
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      const PAST = 'Yes — the memory issue was fixed in PR 1888.';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: PAST, parts: [{ type: 'text', text: PAST }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-real-past' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(stateMetric('chat-state-real-past')).toBeUndefined();
    })));
  });

  // Review 2026-10-23: a WRITE is not a read — a turn whose only calls record / send work used to count as
  // "already read", so it skipped the re-run, the line AND the telemetry row (the replay_unsafe branch was dead).
  it('(live-state read, real matcher) a write-only owner turn is judged: update_supervisor_state ⇒ re-run once; send_chat_message ⇒ no re-run (replay-unsafe), the line + the row', async () => {
    const CLAIM = 'GLM-5.3 NVFP4 is serving on spark-2 at 433 tok/s.';
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      const HONEST = 'Recorded your directive. GLM-5.3 NVFP4 on spark-2 — not read this turn; my last lane note said 433 tok/s.';
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: CLAIM, parts: [
          { type: 'tool_call', name: 'update_supervisor_state', args: { directives: [{ text: 'keep spark-2 on NVFP4' }] } },
          { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true,"directives":[{"id":"d1","text":"keep GLM-5.3 NVFP4 serving on spark-2 at 433 tok/s"}]}' },
          { type: 'text', text: CLAIM },
        ] })
        .mockResolvedValueOnce({ finalText: HONEST, parts: [{ type: 'text', text: HONEST }] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-write-only' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      expect((runCodingAgent as jest.Mock).mock.calls[1][0].userMessage).toContain('HARNESS CHECK — LIVE STATE NOT READ');
      expect(stateMetric('chat-state-write-only')).toMatchObject({ meta: expect.objectContaining({ retried: true }) });
    })));
    (runCodingAgent as jest.Mock).mockClear(); mockPrisma.crossModelMessage.create.mockClear();
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: CLAIM, parts: [
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-spark', message: 'keep it at 433 tok/s' } },
        { type: 'tool_result', name: 'send_chat_message', result: '{"ok":true,"messageId":"m1"}' },
        { type: 'text', text: CLAIM },
      ] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-send-only' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1); // a re-run would send the lane message twice
      expect(persistedAssistant().content.trimEnd().endsWith(UNREAD_LINE)).toBe(true);
      expect(stateMetric('chat-state-send-only')).toMatchObject({ meta: expect.objectContaining({ retried: false, skipped: 'replay_unsafe', replaySkipped: 'send_chat_message', noted: true }) });
    })));
  });

  // Integration recheck 2026-10-23: the write filter must not drop a LIVE read that is replay-unsafe — an owner
  // answer grounded on the page browser_task just read got a false "not read in this turn" line (no re-run: the
  // browser call made replay unsafe), plus a row. A real read grounds it: no re-run, no line, no row.
  it('(live-state read, real matcher) a browser_task-grounded owner answer gets no line and no re-run', async () => {
    const CLAIM = 'GLM-5.3 NVFP4 is serving on spark-2 at 433 tok/s.';
    await withSupervisorChat(() => withReceipts([], () => withRealUnreadMatcher(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: CLAIM, parts: [
        { type: 'tool_call', name: 'browser_task', args: { task: 'open the spark-2 serving dashboard' } },
        { type: 'tool_result', name: 'browser_task', result: 'spark-2 dashboard: GLM-5.3 NVFP4 serving — 433 tok/s (read 21:40Z)' },
        { type: 'text', text: CLAIM },
      ] });
      const key = await startDetachedChatRun({ ...ASK, chatId: 'chat-state-browser-read' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
      expect(persistedAssistant().content).toBe(CLAIM);
      expect(persistedAssistant().content).not.toContain(UNREAD_LINE);
      expect(stateMetric('chat-state-browser-read')).toBeUndefined();
    })));
  });

  it('(unbacked claim) a plain (non-supervisor) chat is never judged', async () => {
    const prev = mockPrisma.runToolReceipt;
    mockPrisma.runToolReceipt = { findFirst: jest.fn(async () => null) };
    try {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Sent it — receipt 9e1c13ea.', parts: [] });
      const key = await startDetachedChatRun({ ...BASE, message: 'hi', chatId: 'chat-unbacked-plain', userId: 'u1', sessionId: null });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
    } finally { mockPrisma.runToolReceipt = prev; }
  });

  // ── Unsaved standing chat rule (ticket ccd634fb — nightly query suite 2026-10-06, 03-platform-chat-instructions) ──
  const RULE = { ...BASE, message: 'for the rest of this chat, always answer in exactly one sentence', userId: 'u1', sessionId: null };
  it('(standing rule) a plain-chat "noted" with no tool call is re-run once with the harness check; the retry that saves it is delivered', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: 'Noted — every answer from here on will be exactly one sentence.', parts: [{ type: 'text', text: 'Noted' }] })
      .mockResolvedValueOnce({ finalText: 'Saved — every answer in this chat will be one sentence.', parts: [
        { type: 'tool_call', name: 'set_chat_instructions', args: { instructions: 'Always answer in exactly one sentence.' } },
        { type: 'tool_result', name: 'set_chat_instructions', result: '{"ok":true}' },
      ] });
    const key = await startDetachedChatRun({ ...RULE, chatId: 'chat-rule-a' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(2);
    const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
    expect(second.userMessage).toContain('HARNESS CHECK — STANDING RULE NOT SAVED');
    expect(second.userMessage).toContain('set_chat_instructions');
    expect(persistedAssistant().content).toContain('Saved — every answer');
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'chat_rule_unsaved_retry' && r.sessionId === 'chat-rule-a'))
      .toMatchObject({ meta: expect.objectContaining({ cue: 'for the rest of this chat', recovered: true, saved: true, savedVia: ['set_chat_instructions'] }) });
  });

  it('(standing rule) a turn that saved it, a non-rule message, a supervisor chat, a guest, or the kill switch never re-runs', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Saved.', parts: [{ type: 'tool_call', name: 'set_chat_instructions', args: {} }] });
    let key = await startDetachedChatRun({ ...RULE, chatId: 'chat-rule-b' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
    (runCodingAgent as jest.Mock).mockClear();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Rayleigh scattering.', parts: [] });
    key = await startDetachedChatRun({ ...RULE, message: 'explain why the sky is blue', chatId: 'chat-rule-c' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
    (runCodingAgent as jest.Mock).mockClear();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Noted.', parts: [] });
    key = await startDetachedChatRun({ ...RULE, userId: undefined as any, chatId: 'chat-rule-guest' });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
    (runCodingAgent as jest.Mock).mockClear();
    await withSupervisorChat(async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Noted.', parts: [] });
      const k = await startDetachedChatRun({ ...RULE, mode: 'thinking', chatId: 'chat-rule-sup' });
      await waitFor(() => !isRunActive(k!));
      expect(agentCalls()).toBe(1);
    });
    (runCodingAgent as jest.Mock).mockClear();
    process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED = '1';
    try {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Noted.', parts: [] });
      key = await startDetachedChatRun({ ...RULE, chatId: 'chat-rule-d' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(1);
    } finally { delete process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED; }
  });

  it('a plain (non-supervisor) chat keeps the old rule: an empty run WITH tools is not retried and nothing is re-woken', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [{ type: 'tool_call', name: 'goal_list', args: {} }] });
    mockEnqueueDirectWake.mockClear();
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-plain-empty-e', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  // ── Seat FALLBACK (2026-09-11 — the glm-5.3 supervisor seat: 23/124 empty wakes) ──
  const withSeatOverride = async (model: string, body: () => Promise<void>) => {
    const codingModelMod = jest.requireMock('../coding/coding-model') as any;
    const real = codingModelMod.resolveRoleModelForRun;
    codingModelMod.resolveRoleModelForRun = jest.fn(async (role: string, fallback: string) =>
      (role === 'chat_orchestrator' || role === 'supervisor') ? model : fallback);
    try { await body(); } finally { codingModelMod.resolveRoleModelForRun = real; }
  };

  it('an OVERRIDE seat that returns nothing AFTER tool work is finished on the built-in kimi-k3 with the tool evidence in the notice (seat fallback)', async () => {
    await withSeatOverride('glm-5.3', async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({ finalText: '', parts: [
          { type: 'tool_call', name: 'list_chats', args: { q: 'canlaw' } },
          { type: 'tool_result', name: 'list_chats', result: '3 chats: a, b, c' },
        ] })
        .mockResolvedValueOnce({ finalText: 'Recovered final note.', parts: [] });
      const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-seat-fb-a', sessionId: null });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // the failed seat run + ONE fallback — the no-tool replay does not apply
      const first = (runCodingAgent as jest.Mock).mock.calls[0][0];
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(first.model).toBe('glm-5.3');
      expect(second.model).toBe('kimi-k3');
      expect(second.userMessage).toContain('SEAT FALLBACK');
      expect(second.userMessage).toContain('glm-5.3');
      expect(second.userMessage).toContain('CALL list_chats');
      expect(second.userMessage).toContain('do NOT repeat side-effecting actions');
      expect(persistedAssistant().content).toContain('Recovered final note.');
      // The answer card follows the model that actually finished the turn.
      expect(kimiCard()?.modelUsed).toBe('kimi-k3');
      expect(kimiCard()?.error).toBeUndefined();
    });
  });

  it('(no-action note) round 7: a supervisor MACHINE wake\'s leak retry is untouched — an earlier attempt\'s call does not block it (human turns only)', async () => {
    const prevFind = mockPrisma.crossModelChat.findUnique.getMockImplementation();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    try {
      await withSeatOverride('glm-5.3', async () => {
        (runCodingAgent as jest.Mock)
          .mockResolvedValueOnce({ finalText: '', parts: [
            { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'e03452f4' } }, { type: 'tool_result', name: 'send_chat_message', result: 'receipt 35fcbce8' },
          ] })
          .mockResolvedValueOnce({ finalText: 'list_chats({"limit": 20})', parts: [{ type: 'text', text: 'list_chats({"limit": 20})' }] })
          .mockResolvedValueOnce({ finalText: 'WAKE: no-op — nothing moved since 13:30Z', parts: [] });
        const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-noaction-r7m', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
        await waitFor(() => !isRunActive(key!));
        expect(agentCalls()).toBe(3); // the seat run, the fallback, the leak replay — as on main
        expect(persistedAssistant().content).not.toContain('list_chats(');
      });
    } finally {
      mockPrisma.crossModelChat.findUnique.mockImplementation(prevFind ?? (async () => ({ title: 'A proper existing title' })));
    }
  });

  // Rollout watch 2026-09-15 (tick 16): an override seat whose endpoint REJECTS
  // the request shape (tool calling not enabled on the server) — the agent
  // loop gives up fast with modelErrorKind 'capability' and an apology final;
  // the turn is finished on the built-in seat instead of going dark.
  it('an OVERRIDE seat that REJECTS the request shape (400, capability) is finished on the built-in kimi-k3; the apology is never delivered', async () => {
    await withSeatOverride('deepseek-v4.1-flash', async () => {
      (runCodingAgent as jest.Mock)
        .mockResolvedValueOnce({
          finalText: "Sorry — I couldn't get an answer out this time: the AI provider returned an error (HTTP 400)",
          parts: [{ type: 'tool_call', name: 'get_chat_status', args: { chatId: 'abc' } }, { type: 'tool_result', name: 'get_chat_status', result: 'idle' }],
          modelErrored: true, modelErrorStatus: 400, modelErrorKind: 'capability',
        })
        .mockResolvedValueOnce({ finalText: 'WAKE: no-op — nothing moved since 13:30Z', parts: [] });
      const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-seat-fb-cap', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2);
      const second = (runCodingAgent as jest.Mock).mock.calls[1][0];
      expect(second.model).toBe('kimi-k3');
      expect(second.userMessage).toContain('SEAT FALLBACK');
      expect(second.userMessage).toContain('REJECTED the request shape');
      expect(second.userMessage).toContain('get_chat_status');
      expect(persistedAssistant().content).toContain('nothing moved since 13:30Z');
      expect(persistedAssistant().content).not.toContain("couldn't get an answer");
      expect(kimiCard()?.modelUsed).toBe('kimi-k3');
    });
  });

  it('a capability rejection on the BUILT-IN seat itself is not a fallback case (nothing to fall back to) — the honest note stands', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({
      finalText: "Sorry — the AI provider returned an error (HTTP 400)", parts: [{ type: 'tool_call', name: 'x', args: {} }],
      modelErrored: true, modelErrorStatus: 400, modelErrorKind: 'capability',
    });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-seat-fb-cap2', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
  });

  // Ticket 08e58e1d: a provider-killed run's terminal envelope persists UNDER
  // the wake's machine origin — the row must self-describe as a harness error
  // (metadata.providerError) so the fleet watchdog's note scan never scores it
  // as a lane-authored note. A clean run carries NO such marker.
  it('a provider-killed run stamps metadata.providerError on the persisted row; a clean run does not', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({
      finalText: "Sorry — I couldn't get an answer out this time: the AI provider is rate-limiting requests right now (too much traffic on their side), and 3 retries spaced over a couple of minutes all hit the same limit. Nothing is wrong with your message or your account — resending in a minute or two usually works.",
      parts: [],
      modelErrored: true, modelErrorStatus: 429, modelErrorKind: 'transient',
    });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-429-stamp', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    await waitFor(() => !isRunActive(key!));
    const killedRow = persistedAssistant();
    expect(killedRow?.metadata?.origin).toBe('schedule'); // the wake origin the watchdog scans on
    expect(killedRow?.metadata?.providerError).toEqual({ status: 429, kind: 'transient' });

    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: 'WAKE: all lanes green this sweep.', parts: [] });
    const key2 = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-clean-stamp', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    await waitFor(() => !isRunActive(key2!));
    expect(persistedAssistant()?.metadata?.providerError).toBeUndefined();
  });

  it('the seat fallback is one-shot and honest: a still-empty fallback stamps the card with an error', async () => {
    await withSeatOverride('glm-5.3', async () => {
      (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [{ type: 'tool_call', name: 'x', args: {} }] });
      const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-seat-fb-b', sessionId: null });
      await waitFor(() => !isRunActive(key!));
      expect(agentCalls()).toBe(2); // seat run + one fallback, never a loop
      expect(kimiCard()?.error).toContain('returned no output');
    });
  });

  it('the built-in seat itself never triggers the fallback (its path is the no-tool replay above)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '', parts: [{ type: 'tool_call', name: 'x', args: {} }] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-seat-fb-c', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
  });

  // (The 2026-09-11 'shutdown re-queue' test was deleted 2026-09-26 with the dead
  // inflightHumanTurns map — the SIGTERM ritual (shutdown-interrupt.test.ts)
  // is the live path, incl. the new Dig-deeper escalation requeue.)

  it('summarizeToolEvidence: bounded CALL/RESULT digest, non-tool parts skipped', () => {
    const parts = [
      { type: 'text', text: 'ignored' },
      { type: 'tool_call', name: 'list_chats', args: { q: 'x' } },
      { type: 'tool_result', name: 'list_chats', result: 'a\n\nb   c' },
      { type: 'tool_call', name: 'send_chat_message', args: { text: 'y'.repeat(500) } },
    ];
    const s = summarizeToolEvidence(parts, { maxChars: 40 });
    expect(s.split('\n')).toHaveLength(3);
    expect(s).toContain('- CALL list_chats: {"q":"x"}');
    expect(s).toContain('- RESULT list_chats: a b c');
    expect(s.split('\n')[2].length).toBeLessThan(80);
    expect(summarizeToolEvidence(undefined)).toBe('');
    expect(summarizeToolEvidence([{ type: 'tool_call', name: 'a', args: {} }, { type: 'tool_call', name: 'b', args: {} }], { maxLines: 1 })).toContain('more tool work omitted');
  });

  it('a non-empty orchestrator run is not retried and its card carries no error', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: 'A real answer', parts: [] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-empty-c', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1);
    expect(kimiCard()?.error).toBeUndefined();
  });

  it('a followups-ONLY answer (strips to empty prose) is NOT error-stamped — pre-parse emptiness gates the stamp (PR #292 review)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '[FOLLOWUPS]\n["Q1","Q2"]\n[/FOLLOWUPS]', parts: [] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-empty-d', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentCalls()).toBe(1); // raw output was non-empty → no retry
    expect(kimiCard()?.error).toBeUndefined(); // the model DID answer — no false "no output"
  });

  it('follow-up chips PERSIST in the assistant row metadata and match the complete payload (owner 2026-09-18 "what happened to the follow-ups?" — 0 of 46 rows carried them in 7 days)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: 'The answer body.\n\n[FOLLOWUPS]\n- How does METR score RSI?\n- Turn this into a recurring feed\n[/FOLLOWUPS]', parts: [] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-followups-persist', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive(key!));
    const complete = events.find(e => e.type === 'complete')!.data;
    expect(complete.followUps).toEqual(['How does METR score RSI?', 'Turn this into a recurring feed']);
    const assistantWrite = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'assistant' && d?.chatId === 'chat-followups-persist');
    expect(assistantWrite.metadata.followUps).toEqual(complete.followUps); // the reloaded row renders the same chips
    expect(assistantWrite.content).not.toContain('[FOLLOWUPS]');
    // A tool-free run collected no sources → the key is omitted (not an empty array).
    expect(assistantWrite.metadata).not.toHaveProperty('sources');
  });
});

describe('full-peer cross-checker gate (owner 2026-09-03)', () => {
  const workerMock = runChatWorker as jest.Mock;
  const agentMock = runCodingAgent as jest.Mock;

  beforeEach(() => {
    // mockReset (not mockClear): kills any base impl / Once queue leaked by an
    // earlier describe, then every mock gets an explicit per-test impl.
    workerMock.mockReset();
    agentMock.mockReset();
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
  });
  afterEach(() => {
    workerMock.mockReset();
    agentMock.mockReset();
    workerMock.mockImplementation(async () => ({ finalText: '' }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('machine wakes NEVER spawn the peer checker (an 8-step agentic run per wake is a hard cost gate)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-gate-wake', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50)); // let stray fire-and-forgets settle
    expect(workerMock).not.toHaveBeenCalled();
  });

  it('an OWNER-TYPED supervisor L2 turn DOES get the peer checker under SUPERVISOR_CHECKER_SKIP_DISABLED=1 (default since 2026-10-06: no checker on supervisor chats; the supervisorProfile branch only raises the orchestrator budget)', async () => {
    process.env.SUPERVISOR_CHECKER_SKIP_DISABLED = '1';
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const key = await startDetachedChatRun({
      ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-gate-sup', sessionId: null,
      messageOrigin: 'user', userTurnAt: new Date(),
    });
    await waitFor(() => !isRunActive(key!));

    // The peer checker ran, as a cross_checker worker on the new lineup…
    const checkerCall = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    expect(checkerCall).toBeTruthy();
    expect(checkerCall![1]).toBe('cross_checker');
    expect(checkerCall![0].model).toBe('deepseek-flash'); // V4.1 Flash cutover 2026-09-10
    // …while the orchestrator ran the raised SUPERVISOR budget (24 steps).
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.profile.maxSteps).toBe(24);
  });

  it('a plain (non-supervisor) L2 user turn gets the peer checker with the stock 8-step chat profile orchestrator', async () => {
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-gate-plain', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    const checkerCall = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    expect(checkerCall).toBeTruthy();
    expect(agentMock.mock.calls.at(-1)?.[0].profile.maxSteps).toBe(8);
  });

  it('L1 (single_thinking) never spawns the checker', async () => {
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-gate-l1', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(workerMock).not.toHaveBeenCalled();
  });
});

describe('text-only peer image parity (owner 2026-09-03 — shared glm-5.3-flash description)', () => {
  const workerMock = runChatWorker as jest.Mock;
  const agentMock = runCodingAgent as jest.Mock;
  const IMG = { mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64'), name: 'shot.png' };

  beforeEach(() => {
    workerMock.mockReset();
    agentMock.mockReset();
    mockDescribeImage.mockReset();
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
  });
  afterEach(() => {
    workerMock.mockReset();
    agentMock.mockReset();
    workerMock.mockImplementation(async () => ({ finalText: '' }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
  });

  it('with an attached image the checker doctrine carries the description block; the orchestrator keeps NATIVE images', async () => {
    mockDescribeImage.mockImplementation(async () => 'A screenshot of the Digby settings page.');
    const key = await startDetachedChatRun({
      ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-img-a', sessionId: null,
      userImages: [IMG],
    });
    await waitFor(() => !isRunActive(key!));

    // ONE describe hop for the run (the promise is cached across consumers).
    expect(mockDescribeImage).toHaveBeenCalledTimes(1);
    const [buf, mime, name] = mockDescribeImage.mock.calls[0];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(mime).toBe('image/png');
    expect(name).toBe('shot.png');

    const checker = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'))![0];
    expect(String(checker.doctrineOverride)).toContain('[ATTACHED IMAGE — described by glm-5.3-flash');
    expect(String(checker.doctrineOverride)).toContain('A screenshot of the Digby settings page.');
    // The peer itself never receives image payloads — the peer worker path
    // forwards no image parts regardless of the seat's vision (deepseek-flash can see).
    expect(checker.userImages).toBeUndefined();

    // The orchestrator still sees the images natively — no description block.
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.userImages).toEqual([IMG]);
    expect(String(orch.doctrineOverride)).not.toContain('[ATTACHED IMAGE — described by');
  });

  it('a failed describe hop degrades to an HONEST attached-but-undescribed note (never a silent drop)', async () => {
    mockDescribeImage.mockImplementation(async () => { throw new Error('vision endpoint down'); });
    const key = await startDetachedChatRun({
      ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-img-b', sessionId: null,
      userImages: [IMG],
    });
    await waitFor(() => !isRunActive(key!));
    const checker = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'))![0];
    expect(String(checker.doctrineOverride)).toContain('description was unavailable');
    expect(String(checker.doctrineOverride)).toContain('you cannot see');
  });

  it('without images the describe hop never fires and no block is injected', async () => {
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-img-c', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(mockDescribeImage).not.toHaveBeenCalled();
    const checker = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'))![0];
    expect(String(checker.doctrineOverride)).not.toContain('[ATTACHED IMAGE');
  });
});

describe('supervisor claims-with-receipts lane (owner 2026-09-03 — chat-finalize wire-in)', () => {
  const agentMock = runCodingAgent as jest.Mock;
  const assistantRow = (chatId: string) =>
    mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.chatId === chatId && d?.role === 'assistant');

  beforeEach(() => {
    agentMock.mockReset();
    mockApplyClaimsBlockLane.mockReset();
    mockPrisma.crossModelMessage.create.mockClear();
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [], receipts: [] }));
  });
  afterEach(() => {
    agentMock.mockReset();
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    // Restore the module-scope identity default for any later supervisor run.
    mockApplyClaimsBlockLane.mockImplementation((opts: any) => ({
      finalText: opts.guarded.finalText, notes: opts.guarded.notes, verdict: opts.guarded.verdict,
      lane: { present: false, verified: [], unverified: [], coveredKinds: [] },
    }));
  });

  it('a supervisor machine wake feeds the lane the final text + the run receipts; an annotated result persists and rides complete.finalText', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const receipts = [{ id: 'rcpt-1234abcd', tool: 'send_chat_message', ok: true, ids: { messageId: 'msg-5678' } }];
    agentMock.mockImplementation(async () => ({
      finalText: 'Nudged the stalled lane.\n\n```claims\n[{"type":"message_sent","ref":"rcpt-1234abcd"}]\n```',
      parts: [], receipts,
    }));
    const LANE_NOTE = '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]\n1/1 claim(s) verified.';
    mockApplyClaimsBlockLane.mockImplementation((opts: any) => ({
      finalText: `${opts.guarded.finalText}\n\n${LANE_NOTE}`,
      notes: [LANE_NOTE],
      verdict: { ...opts.guarded.verdict, claimsBlockVerified: true },
      lane: { present: true, verified: [{ claim: { type: 'message_sent', ref: 'rcpt-1234abcd' }, receiptId: 'rcpt-1234abcd' }], unverified: [], coveredKinds: [] },
    }));

    const key = await startDetachedChatRun({
      ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-claims-a', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive(key!));

    // The lane got the parsed final text, the run's receipts, and a machine triggerKind.
    expect(mockApplyClaimsBlockLane).toHaveBeenCalledTimes(1);
    const laneArgs = mockApplyClaimsBlockLane.mock.calls[0][0];
    expect(laneArgs.receipts).toEqual(receipts);
    expect(laneArgs.triggerKind).toBe('schedule');
    expect(laneArgs.originalText).toContain('```claims');

    // Annotated text persisted AND swapped into the live complete event.
    expect(assistantRow('chat-claims-a').content).toContain('CLAIMS BLOCK VERIFIED');
    expect(String(events.find(e => e.type === 'complete')!.data.finalText)).toContain('CLAIMS BLOCK VERIFIED');
    // The lane note rides the persisted parts too (transcript renders parts).
    const noteParts = (assistantRow('chat-claims-a').parts ?? []).filter((p: any) => p.type === 'text' && String(p.text).includes('CLAIMS BLOCK VERIFIED'));
    expect(noteParts).toHaveLength(1);
  });

  it('NON-supervisor chats never invoke the lane (supervisor-only for now)', async () => {
    agentMock.mockImplementation(async () => ({
      finalText: 'Done.\n\n```claims\n[{"type":"verify","ref":"local"}]\n```',
      parts: [], receipts: [],
    }));
    const key = await startDetachedChatRun({
      ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-claims-b', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(mockApplyClaimsBlockLane).not.toHaveBeenCalled();
  });

  it('a lane failure is fail-open — the note delivers unchanged', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    agentMock.mockImplementation(async () => ({ finalText: 'Wake note body.', parts: [], receipts: [] }));
    mockApplyClaimsBlockLane.mockImplementation(() => { throw new Error('lane exploded'); });
    const key = await startDetachedChatRun({
      ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-claims-c', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    await waitFor(() => !isRunActive(key!));
    expect(assistantRow('chat-claims-c').content).toBe('Wake note body.');
  });
});

describe('owner briefing finalize hook (owner 2026-09-04 — plain-English layer over wake notes)', () => {
  const agentMock = runCodingAgent as jest.Mock;
  const NOTE = '**Fleet wake — 2 lanes green**\n\nAll quiet; CanLaw digest relayed.';

  beforeEach(() => {
    agentMock.mockReset();
    agentMock.mockImplementation(async () => ({ finalText: NOTE, parts: [], receipts: [] }));
    mockGenerateOwnerBriefing.mockClear();
    mockGuardMachineWakeFinalAnswer.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    // The persisted assistant row's id seeds sourceNoteId — return one.
    // (Compute policy 2026-09-26: the assistant row's id is pre-minted in
    // `data.id` so the Dig-deeper chip can name it — the stub honours it the
    // way Prisma does, so the row-<role> stand-in applies only when absent.)
    mockPrisma.crossModelMessage.create.mockImplementation(async ({ data }: any) => ({ ...data, id: data.id ?? `row-${data.role}` }));
  });
  afterEach(() => {
    agentMock.mockReset();
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    mockPrisma.crossModelMessage.create.mockImplementation(async () => ({}));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('a supervisor machine wake fires the generator with the DELIVERED note + the persisted row id (fire-and-forget)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-brief-a', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => mockGenerateOwnerBriefing.mock.calls.length > 0);
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
    // sourceNoteId = the persisted assistant row's id — since 2026-09-26 the
    // pre-minted uuid the run wrote in `data.id` (the Dig-deeper chip needs it
    // before the persist), so compare against what the create stub received.
    const assistantCreate = mockPrisma.crossModelMessage.create.mock.calls.find(([a]: any[]) => a?.data?.role === 'assistant')?.[0];
    expect(assistantCreate?.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledWith({
      chatId: 'chat-brief-a',
      userId: 'u1',
      noteContent: NOTE,
      sourceNoteId: assistantCreate.data.id,
    });
  });

  it('NON-supervisor machine wakes never brief', async () => {
    // Default chat lookup: not a supervisor.
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-brief-b', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('owner-typed supervisor turns never brief (machine wakes only — the reply already answers a person)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-brief-c', sessionId: null,
    });
    subscribeRun(key!, () => {});
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('a guard-STRUCK note never briefs under ACTION_VERIFIER_ENFORCE=1 (the replacement is harness chrome, not a delivered note)', async () => {
    // Gate flip 2026-09-11: struck notes are delivered unmodified by default
    // (and DO brief); the chrome-never-briefs contract is an enforce-mode pin.
    process.env.ACTION_VERIFIER_ENFORCE = '1';
    try {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({
        finalText: '[ACTION VERIFIER — THIS RUN\'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]\nStruck.',
        notice: '[ACTION VERIFIER — THIS RUN\'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]',
        struck: true, phantoms: [{ kind: 'ticket', detail: 'x', id: 'y' }],
      }));
      const key = await startDetachedChatRun({
        ...BASE, userId: 'u1', chatId: 'chat-brief-d', sessionId: null,
        machineWake: true, messageOrigin: 'schedule',
      });
      subscribeRun(key!, () => {});
      await waitFor(() => !isRunActive(key!));
      await new Promise(r => setTimeout(r, 50));
      expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
    } finally { delete process.env.ACTION_VERIFIER_ENFORCE; }
  });

  it('a generator explosion is fail-open — the wake still finalizes and persists its note', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    mockGenerateOwnerBriefing.mockRejectedValueOnce(new Error('briefing exploded'));
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-brief-e', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive(key!));
    const assistantRow = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.chatId === 'chat-brief-e' && d?.role === 'assistant');
    expect(assistantRow.content).toBe(NOTE);
  });
});

describe('recoveryForMessageId (ticket 68bc5aec — orphan-sweeper re-fire)', () => {
  it('does NOT re-create the user row and threads the exclusion into the history load', async () => {
    const orphanCreatedAt = new Date('2026-08-28T00:00:00.000Z');
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-rec-a', sessionId: null,
      recoveryForMessageId: 'msg-orphan-1', userTurnAt: orphanCreatedAt,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    // NO user-row create — the dead run persisted it already (double-transcript
    // guard); the assistant row still persists as usual. (Assertions are scoped
    // to THIS chat: the suite shares mock state across tests.)
    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-rec-a');
    expect(creates.filter((d: any) => d?.role === 'user')).toHaveLength(0);
    expect(creates.some((d: any) => d?.role === 'assistant')).toBe(true);

    // The history/context load EXCLUDES the orphan row (the 2026-07-14
    // "models saw it twice" hazard) — threaded to buildChatQueryContext.
    expect(buildChatQueryContext).toHaveBeenCalledWith(
      expect.objectContaining({ excludeMessageId: 'msg-orphan-1' }),
    );

    // The ORIGINAL send's createdAt is the run's confirmation anchor: it
    // reaches the orchestrator call as userTurnAt (persist skipped, so the
    // anchor is the threaded value, not a fresh row's).
    const orchCall = (runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0];
    expect(orchCall?.userTurnAt).toEqual(orphanCreatedAt);

    // The chat row is still bumped (persist-time parity)…
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith(
      { where: { id: 'chat-rec-a' }, data: { updatedAt: expect.any(Date) } },
    );
    await waitFor(() => !isRunActive('chat:chat-rec-a'));
  });

  it('without recoveryForMessageId the turn is byte-identical to today (user row persists, no exclusion)', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-rec-b', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
    const userWrite = creates.filter((d: any) => d?.chatId === 'chat-rec-b').find((d: any) => d?.role === 'user');
    expect(userWrite).toMatchObject({ chatId: 'chat-rec-b', role: 'user', content: BASE.message });

    // No exclusion is threaded on the normal path.
    const ctxCall = (buildChatQueryContext as jest.Mock).mock.calls.at(-1)?.[0];
    expect(ctxCall?.excludeMessageId).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-rec-b'));
  });
});

describe('machineMessage stash (ticket bb2eca92 — orphan-sweeper machine re-fire)', () => {
  it('a machineWake run persists the user row with the preamble baked into content AND the clean pre-preamble message in metadata.machineMessage', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-stash-a', sessionId: null,
      message: 'clean wake payload', machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-stash-a');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    // The transcript row keeps the baked preamble (debugging visibility,
    // postmortem 2026-08-11)…
    expect(userWrite.content.startsWith('[MACHINE-TRIGGERED RUN')).toBe(true);
    expect(userWrite.content.endsWith('clean wake payload')).toBe(true);
    // …and the CLEAN pre-preamble message rides metadata, so the orphan
    // sweeper can re-bake a FRESH wake (no double-preamble possible).
    expect(userWrite.metadata).toMatchObject({ origin: 'schedule', machineMessage: 'clean wake payload' });
    await waitFor(() => !isRunActive('chat:chat-stash-a'));
  });

  it('a NON-machineWake run persists NO machineMessage (human/agent sends have nothing baked in)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-stash-b', sessionId: null,
      message: 'plain human question', messageOrigin: 'user',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-stash-b');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.content).toBe('plain human question');
    expect(userWrite.metadata?.machineMessage).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-stash-b'));
  });
});

describe('scheduleOwnerArmed metadata stamp (ticket 6ef770a1 — owner-armed digests render expanded)', () => {
  it('a machineWake schedule run WITH scheduleOwnerArmed persists metadata.scheduleOwnerArmed true on the user row', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-armed-a', sessionId: null,
      message: 'owner-armed digest prompt', machineWake: true, messageOrigin: 'schedule',
      scheduleOwnerArmed: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-armed-a');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata).toMatchObject({ origin: 'schedule', scheduleOwnerArmed: true });
    await waitFor(() => !isRunActive('chat:chat-armed-a'));
  });

  it('a schedule run WITHOUT the flag persists NO scheduleOwnerArmed (machine-armed/legacy rows stay unmarked)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-armed-b', sessionId: null,
      message: 'internal sweep prompt', machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-armed-b');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata).toMatchObject({ origin: 'schedule' });
    expect(userWrite.metadata?.scheduleOwnerArmed).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-armed-b'));
  });

  it('a stray flag on a NON-schedule origin never stamps (guarded on messageOrigin schedule)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-armed-c', sessionId: null,
      message: 'hook wake prompt', machineWake: true, messageOrigin: 'hook',
      scheduleOwnerArmed: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-armed-c');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata?.scheduleOwnerArmed).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-armed-c'));
  });

  // ── Ticket 77c3a7e9: the digest ANSWER renders as a visible assistant
  // bubble (the owner's "buried in accordion" report) — the finalize stamps
  // metadata.kind 'owner_digest' (OWNER_DIGEST_KIND) on the ASSISTANT row of
  // an owner-armed schedule firing's turn, which the frontend machine-turn
  // grouping exempts from the whole-turn collapse (the envelope and verifier
  // chrome stay folded). Same guard shape as the user-row stamp above.
  it('an owner-armed schedule run stamps metadata.kind owner_digest on the ASSISTANT row (ticket 77c3a7e9)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-digest-a', sessionId: null,
      message: 'owner-armed digest prompt', machineWake: true, messageOrigin: 'schedule',
      scheduleOwnerArmed: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-digest-a');
    const assistantWrite = creates.find((d: any) => d?.role === 'assistant');
    expect(assistantWrite).toBeDefined();
    // The row keeps its machine origin (fleet attribution) AND carries the
    // digest kind — the kind is the exemption marker the grouping keys on.
    expect(assistantWrite.metadata).toMatchObject({ origin: 'schedule', kind: 'owner_digest' });
    // The wake user row keeps its 6ef770a1 stamp (expanded accordion anchor).
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite.metadata).toMatchObject({ origin: 'schedule', scheduleOwnerArmed: true });
    await waitFor(() => !isRunActive('chat:chat-digest-a'));
  });

  it('a schedule run WITHOUT the flag stamps NO owner_digest (machine-armed/legacy answers keep folding — 2026-09-03 directive intact)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-digest-b', sessionId: null,
      message: 'internal sweep prompt', machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-digest-b');
    const assistantWrite = creates.find((d: any) => d?.role === 'assistant');
    expect(assistantWrite).toBeDefined();
    expect(assistantWrite.metadata).toMatchObject({ origin: 'schedule' });
    expect(assistantWrite.metadata?.kind).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-digest-b'));
  });

  it('a stray flag on a NON-schedule origin never stamps owner_digest (guard shape mirrors the user-row stamp)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-digest-c', sessionId: null,
      message: 'hook wake prompt', machineWake: true, messageOrigin: 'hook',
      scheduleOwnerArmed: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-digest-c');
    const assistantWrite = creates.find((d: any) => d?.role === 'assistant');
    expect(assistantWrite).toBeDefined();
    expect(assistantWrite.metadata).toMatchObject({ origin: 'hook' });
    expect(assistantWrite.metadata?.kind).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-digest-c'));
  });
});

describe('firedByScheduleId threading (finding B1 — one-shot chain provenance on the plain-chat leg)', () => {
  // The chat-context mock fixes queryMessage, so the lead call is found by the
  // chat it ran for (sessionId) — the same key the run registered under.
  const agentCallFor = (chatId: string) =>
    (runCodingAgent as jest.Mock).mock.calls.find((c: any[]) => c[0]?.sessionId === chatId)?.[0];

  it('a schedule firing threads firedByScheduleId into the agent loop ToolContext', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-chain-a', sessionId: null,
      message: 'chain link a prompt', machineWake: true, messageOrigin: 'schedule',
      firedByScheduleId: 'sch_chain_a',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    expect(agentCallFor('chat-chain-a')).toBeDefined();
    expect(agentCallFor('chat-chain-a')?.firedByScheduleId).toBe('sch_chain_a');
    await waitFor(() => !isRunActive('chat:chat-chain-a'));
  });

  it('CONTROL: a stray firedByScheduleId on a NON-schedule origin never threads (guarded on messageOrigin schedule)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-chain-b', sessionId: null,
      message: 'chain link b prompt', machineWake: true, messageOrigin: 'hook',
      firedByScheduleId: 'sch_chain_b',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    expect(agentCallFor('chat-chain-b')).toBeDefined();
    expect(agentCallFor('chat-chain-b')?.firedByScheduleId).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-chain-b'));
  });

  it('CONTROL: a schedule firing WITHOUT the id threads none (legacy firings stay plain)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-chain-c', sessionId: null,
      message: 'chain link c prompt', machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    expect(agentCallFor('chat-chain-c')).toBeDefined();
    expect(agentCallFor('chat-chain-c')?.firedByScheduleId).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-chain-c'));
  });
});

describe('childResult metadata stamp (ticket 56d6b204 — sub-session result wakes render expanded)', () => {
  it('a machineWake hook run WITH childResult persists metadata.childResult true on the user row (the 2026-09-25 incident: the sub-session DB-audit result was hidden behind the collapsed accordion)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-childresult-a', sessionId: null,
      message: 'Your sub-session "DB audit" reported run_completed: all tables verified',
      machineWake: true, messageOrigin: 'hook',
      childResult: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-childresult-a');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    // The expansion signal the frontend grouping reads off the group's ANCHOR
    // row — without it the delivered sub-session verdict stays folded behind
    // the machine accordion (chat 6e36c834).
    expect(userWrite.metadata).toMatchObject({ origin: 'hook', childResult: true });
    await waitFor(() => !isRunActive('chat:chat-childresult-a'));
  });

  it('a hook run WITHOUT the flag persists NO childResult (ordinary hook wakes stay collapsed)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-childresult-b', sessionId: null,
      message: 'Fleet event from chat "X" (run_completed): routine completion',
      machineWake: true, messageOrigin: 'hook',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-childresult-b');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata).toMatchObject({ origin: 'hook' });
    expect(userWrite.metadata?.childResult).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-childresult-b'));
  });

  it('a stray flag on a NON-hook origin never stamps (guarded on messageOrigin hook)', async () => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-childresult-c', sessionId: null,
      message: 'hourly status sweep', machineWake: true, messageOrigin: 'schedule',
      childResult: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-childresult-c');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata).toMatchObject({ origin: 'schedule' });
    expect(userWrite.metadata?.childResult).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-childresult-c'));
  });
});

/**
 * Ticket 327ff5e3 — the residual of 1757b07d: the childResult marker was only
 * ever stamped for the auto-wired RESULT HOOK (origin 'hook'), and the read
 * side only flattened it on the fleet/Management path. A sub-session REPORTING
 * BACK through send_chat_message (origin 'agent' — the far more common shape)
 * into a PLAIN chat therefore carried no marker at all, so the frontend
 * grouping probe (`probe.childResult === true`) could never fire and the
 * delivered result stayed folded inside the collapsed machine accordion.
 *
 * These pin the PERSIST seam: an agent send whose SENDER is this chat's child
 * is stamped at write time, so every reader (plain chat, fleet thread, minimal
 * view) sees the marker without re-deriving lineage.
 */
describe('ticket 327ff5e3 — child-session RELAY persist stamp (plain chats see delivered results)', () => {
  /** Point the chat-row mock at per-id rows so target vs SENDER resolve independently. */
  const chatRows = (rows: Record<string, any>) => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (a: any) => rows[a?.where?.id] ?? null);
  };

  it('(a) stamps metadata.childResult on an AGENT relay from a child chat into a PLAIN chat (the gap this ticket is about)', async () => {
    chatRows({
      'chat-relay-a': { title: 'Plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
      'child-lane-a': { parentChatId: 'chat-relay-a' },
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-relay-a', sessionId: null,
      message: '[AGENT-SENT MESSAGE — from chat "DB audit" (child-la)]\nAll tables verified; done.',
      messageOrigin: 'agent', originSourceChatId: 'child-lane-a',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-relay-a');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    // The row keeps its agent provenance (it is still machine traffic) AND
    // carries the delivered-result marker the grouping probe reads.
    expect(userWrite.metadata).toMatchObject({ origin: 'agent', childResult: true, sourceChatId: 'child-lane-a' });
    await waitFor(() => !isRunActive('chat:chat-relay-a'));
  });

  it('(b) does NOT stamp a relay whose sender is NOT this chat\'s child (supervisor fan-out / sibling lane stays machine traffic)', async () => {
    chatRows({
      'chat-relay-b': { title: 'Plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
      'fleet-sup-b': { parentChatId: null },
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-relay-b', sessionId: null,
      message: '[AGENT-SENT MESSAGE — from chat "Fleet Supervisor" (fleet-su)]\nhourly sweep',
      messageOrigin: 'agent', originSourceChatId: 'fleet-sup-b',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-relay-b');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata).toMatchObject({ origin: 'agent' });
    expect(userWrite.metadata?.childResult).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-relay-b'));
  });

  it('(c) does NOT stamp a non-agent relay — a human/schedule send is never "delivered sub-session content"', async () => {
    chatRows({
      'chat-relay-c': { title: 'Plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
      'child-lane-c': { parentChatId: 'chat-relay-c' },
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-relay-c', sessionId: null,
      message: 'a plain owner question', messageOrigin: 'schedule', originSourceChatId: 'child-lane-c',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-relay-c');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined();
    expect(userWrite.metadata?.childResult).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-relay-c'));
  });

  it('(d) still honours the RESULT-HOOK stamp — the pre-existing hook path is unchanged', async () => {
    chatRows({ 'chat-relay-d': { title: 'Plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' } });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-relay-d', sessionId: null,
      message: 'Your sub-session "DB audit" (chat c-child) reported run_completed: all tables verified',
      machineWake: true, messageOrigin: 'hook', childResult: true,
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-relay-d');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite.metadata).toMatchObject({ origin: 'hook', childResult: true });
    await waitFor(() => !isRunActive('chat:chat-relay-d'));
  });

  it('(e) a lineage-lookup FAILURE never breaks the send and never invents the marker (fail closed)', async () => {
    // The SENDER read is the one that throws; every other chat resolves to a
    // row that WOULD satisfy lineage for this target, so the ONLY thing
    // withholding the stamp is the failure itself. That keeps the negative
    // control discriminating — it cannot pass merely because lineage is absent
    // (review finding on the first cut of this case).
    const wouldStamp = { title: 'Plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', parentChatId: 'chat-relay-e' };
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (a: any) => {
      if (a?.where?.id === 'child-lane-e') throw new Error('prisma unavailable');
      return wouldStamp;
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-relay-e', sessionId: null,
      message: '[AGENT-SENT MESSAGE — from chat "lane E" (child-la)]\nreport',
      messageOrigin: 'agent', originSourceChatId: 'child-lane-e',
    });
    expect(key).toBe('chat:chat-relay-e'); // the run still started
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));

    const creates = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.chatId === 'chat-relay-e');
    const userWrite = creates.find((d: any) => d?.role === 'user');
    expect(userWrite).toBeDefined(); // the user row was still persisted
    expect(userWrite.metadata?.childResult).toBeUndefined(); // but no marker
    await waitFor(() => !isRunActive('chat:chat-relay-e'));
  });
});

// fixer 2026-09-27 (tt-rd audit, finding upward-chatter-1): the ask-close used
// to run ONLY under !runIsMachineTriggered, so the [OWNER ASK UNANSWERED]
// re-wake and the [FOLLOW-THROUGH] nudge — both hook wakes — could never close
// the ask they exist to answer: it re-injected on every wake for 72 h, nudged
// at 2 h and escalated to the Fleet Supervisor at 8 h, and the answer written
// on the machine wake folded behind the accordion. Now a hook wake carrying
// ownerAskMessageIds closes each ask on a REAL reply (source 'machine_wake'),
// stamps metadata.ownerAskReply on the reply row AND on the wake anchor row
// (the frontend mounts the turn expanded), and does none of that on a
// 'WAKE: no-op' close or an envelope.
describe('owner-ask machine-wake close (fixer 2026-09-27)', () => {
  const ASK_ID = 'msg-ask-11111111-aaaa';
  const stateDoc = () => ({
    directives: [{ id: 'd-ask', text: 'what is going on with the speed mission', at: new Date(Date.now() - 3600_000).toISOString(), status: 'open', kind: 'ask', messageId: ASK_ID }],
    archived: [], dispatches: [], projects: [], notes: '', refutations: [],
  });
  const writes = (chatId: string) => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.chatId === chatId);
  // The assistant persist passes `id: plannedRowId` in data (the Dig-deeper chip
  // names the row before it persists), so the reply row's id is that uuid — the
  // evidence is `msg <its first 8>`; read it off the persisted assistant write.
  const replyId8 = (chatId: string) => String(writes(chatId).find((d: any) => d?.role === 'assistant')?.id ?? '').slice(0, 8);
  const askClosedInUpsert = (chatId: string) => mockPrisma.supervisorState.upsert.mock.calls
    .map((c: any[]) => c[0]?.update?.state ?? c[0]?.create?.state)
    .some((s: any) => Array.isArray(s?.directives) && s.directives.some((d: any) => d?.id === 'd-ask' && d?.status === 'answered' && d?.evidence === `msg ${replyId8(chatId)}`));
  let n = 0;

  beforeEach(() => {
    n = 0;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    mockPrisma.crossModelMessage.create.mockImplementation(async (a: any) => ({ id: `row-${a?.data?.role}-${++n}`, ...(a?.data ?? {}) }));
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
    mockPrisma.supervisorState = {
      findUnique: jest.fn(async () => ({ state: stateDoc() })),
      upsert: jest.fn(async () => ({})),
    };
    mockPrisma.projectTodo = { findMany: jest.fn(async () => []) };
    mockPrisma.chatSchedule = { findMany: jest.fn(async () => []) };
    mockPrisma.ownerQuestion = { findMany: jest.fn(async () => []) };
    mockRecordLoopMetric.mockClear();
  });
  afterEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    mockPrisma.crossModelMessage.create.mockImplementation(async () => ({}));
    delete mockPrisma.crossModelMessage.findMany;
    delete mockPrisma.supervisorState;
    delete mockPrisma.projectTodo;
    delete mockPrisma.chatSchedule;
    delete mockPrisma.ownerQuestion;
  });

  const runWake = async (chatId: string, over: Record<string, unknown> = {}) => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId, sessionId: null,
      message: `[OWNER ASK UNANSWERED] The owner asked "what is going on with the speed mission" (msg ${ASK_ID.slice(0, 8)}) …`,
      machineWake: true, messageOrigin: 'hook', ownerAskMessageIds: [ASK_ID],
      ...over,
    } as any);
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive(`chat:${chatId}`));
  };

  it('a REAL reply on the re-wake closes the ask (evidence = this reply row, source machine_wake) and stamps ownerAskReply on the anchor AND the reply row', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'We are at 5.08 tok/s of record; the bisect is on rung zf (msg msg-ask-).', parts: [] });
    await runWake('chat-askwake-a');
    const user = writes('chat-askwake-a').find((d: any) => d?.role === 'user');
    const assistant = writes('chat-askwake-a').find((d: any) => d?.role === 'assistant');
    expect(user.metadata).toMatchObject({ origin: 'hook', ownerAskReply: true, ownerAskMessageIds: ['msg-ask-'] });
    expect(assistant.metadata).toMatchObject({ origin: 'hook', ownerAskReply: true });
    await waitFor(() => askClosedInUpsert('chat-askwake-a'));
    await waitFor(() => mockRecordLoopMetric.mock.calls.some((c: any[]) => c[0]?.kind === 'directive_ask_autoclose'));
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r?.kind === 'directive_ask_autoclose')).toMatchObject({ sessionId: 'chat-askwake-a', meta: expect.objectContaining({ source: 'machine_wake', askMessageId: 'msg-ask-' }) });
  });

  it("a 'WAKE: no-op' close on the re-wake did NOT answer: no reply stamp, no close (the anchor still expands so the owner sees the miss)", async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'WAKE: no-op — nothing moved on any project since the previous wake', parts: [] });
    await runWake('chat-askwake-b');
    const user = writes('chat-askwake-b').find((d: any) => d?.role === 'user');
    const assistant = writes('chat-askwake-b').find((d: any) => d?.role === 'assistant');
    expect(user.metadata).toMatchObject({ origin: 'hook', ownerAskReply: true });
    expect(assistant.metadata?.ownerAskReply).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(askClosedInUpsert('chat-askwake-b')).toBe(false);
  });

  it('harness receipts ON: a reply that was ONLY the model-typed block does not close the ask; a real reply does', async () => {
    delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'ACTIONS TAKEN\n- answered owner (receipt 1a2b3c4d)', parts: [], receipts: [] });
    await runWake('chat-askwake-block');
    const blockOnly = writes('chat-askwake-block').find((d: any) => d?.role === 'assistant');
    expect(blockOnly.content).toBe('Harness record: 0 lane actions this wake.');
    expect(blockOnly.metadata?.ownerAskReply).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(askClosedInUpsert('chat-askwake-block')).toBe(false);
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'We are at 5.08 tok/s of record; the bisect is on rung zf.', parts: [], receipts: [] });
    await runWake('chat-askwake-real');
    const real = writes('chat-askwake-real').find((d: any) => d?.role === 'assistant');
    expect(real.content).toBe('We are at 5.08 tok/s of record; the bisect is on rung zf.\n\nHarness record: 0 lane actions this wake.');
    expect(real.metadata).toMatchObject({ ownerAskReply: true, harnessActions: 0, harnessReceipts: { mode: 'record' } });
  });

  it('a hook wake WITHOUT ownerAskMessageIds (an ordinary event) never stamps or closes, even with a real reply', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Fleet wake — 2 lane completions, one steer (msg 1a2b3c4d).', parts: [] });
    await runWake('chat-askwake-d', { ownerAskMessageIds: undefined });
    const user = writes('chat-askwake-d').find((d: any) => d?.role === 'user');
    const assistant = writes('chat-askwake-d').find((d: any) => d?.role === 'assistant');
    expect(user.metadata?.ownerAskReply).toBeUndefined();
    expect(assistant.metadata?.ownerAskReply).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(askClosedInUpsert('chat-askwake-d')).toBe(false);
  });
});

describe('persisted transcript parts strip structured markup (ticket dc7fd17a)', () => {
  beforeEach(() => {
    mockPrisma.crossModelMessage.create.mockClear();
  });

  it('text parts persist WITHOUT raw [FOLLOWUPS]/[CANVAS] markup; reasoning filtered; tool parts verbatim; content stays clean', async () => {
    // The agent loop's text parts accumulate the RAW model stream (the
    // sse-adapter only cuts [FOLLOWUPS]/canvas from the forwarded SSE
    // chunks). Persisting them unstripped leaked raw markup into the
    // reloaded chat detail view, which renders parts verbatim.
    const rawAnswer = 'The answer body.\n\n[FOLLOWUPS]\n- Ask a next thing\n- And another\n[/FOLLOWUPS]';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: rawAnswer,
      parts: [
        { type: 'text', text: rawAnswer },
        { type: 'tool_call', name: 'web_search', args: { q: 'x' } },
        { type: 'reasoning', text: 'internal chain-of-thought' },
      ],
      receipts: [],
    });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-parts-dc7', sessionId: null });
    expect(key).toBe('chat:chat-parts-dc7');
    await waitFor(() => !isRunActive('chat:chat-parts-dc7'));

    const writes = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.role === 'assistant');
    expect(writes).toHaveLength(1);
    const row = writes[0];

    // Content: stripped by the pre-existing content-finalize path.
    expect(row.content).toBe('The answer body.');

    // Parts: reasoning out (pre-existing), text part now stripped too, tool
    // part untouched — and the followUps still parse into the followups
    // event/metadata path (chips render from metadata, not content).
    expect(row.parts.find((p: any) => p.type === 'reasoning')).toBeUndefined();
    const textPart = row.parts.find((p: any) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe('The answer body.');
    expect(row.parts.find((p: any) => p.type === 'tool_call'))
      .toEqual({ type: 'tool_call', name: 'web_search', args: { q: 'x' } });
  });

  it('the post-delivery verifier still sees the ORIGINAL un-stripped parts (non-mutating persist strip)', async () => {
    // Action-claim keyword required: a keyword-free final never fires the
    // verifier (cheap pre-gate, tested above).
    const rawAnswer = 'I filed a feedback ticket for the rendering bug (ticket id ab12cd34-9999-8888-7777-666655554444).\n\n[FOLLOWUPS]\n- Ask a next thing\n[/FOLLOWUPS]';
    const rawParts = [{ type: 'text', text: rawAnswer }];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: rawAnswer, parts: rawParts, receipts: [] });
    mockVerifyRunActionClaimsAsync.mockClear();
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-parts-dc8', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-parts-dc8'));
    await waitFor(() => mockVerifyRunActionClaimsAsync.mock.calls.length > 0);
    const [call] = mockVerifyRunActionClaimsAsync.mock.calls;
    // Evidence fidelity: the verifier's parts are the same un-stripped
    // objects the loop produced — the persist strip copies, never mutates.
    expect(call[0].parts[0].text).toBe(rawAnswer);
  });
});

describe('persisted text parts are markdown-normalized (owner report, chat 7dc031fb)', () => {
  // Since the C1 unified-rendering flip, reloaded plain chats render PARTS —
  // content got normalizeAssistantMarkdown at finalize but the text parts
  // carried the raw stream, so every markdown repair was bypassed on reload.
  const collapsedTable = 'Here is the table:\n| Method | Time |\n|---|---|\n| Grill | 30 min |';
  const repairedTable = 'Here is the table:\n\n| Method | Time |\n|---|---|\n| Grill | 30 min |';
  const collapsedHeading = 'Here is the ruleset: ## Setup 1. First thing 2. Second thing ### Details More prose';
  const repairedHeading = 'Here is the ruleset:\n\n## Setup 1. First thing 2. Second thing\n\n### Details More prose';

  const assistantRow = () => {
    const writes = mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.role === 'assistant');
    expect(writes).toHaveLength(1);
    return writes[0];
  };

  beforeEach(() => {
    mockPrisma.crossModelMessage.create.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
  });

  it('a collapsed-table text part persists REPAIRED; tool_call/tool_result parts are untouched', async () => {
    const toolResult = { type: 'tool_result', name: 'web_search', result: 'raw | pipes | stay\n|---|' };
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: collapsedTable,
      parts: [
        { type: 'tool_call', name: 'web_search', args: { q: 'x' } },
        { ...toolResult },
        { type: 'text', text: collapsedTable },
      ],
      receipts: [],
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-md-parts-1', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-md-parts-1'));

    const row = assistantRow();
    // Content path (pre-existing) and the parts path now agree.
    expect(row.content).toBe(repairedTable);
    expect(row.parts.find((p: any) => p.type === 'text').text).toBe(repairedTable);
    // Non-text parts pass through byte-identical — a tool result full of pipe
    // characters must never be "repaired".
    expect(row.parts.find((p: any) => p.type === 'tool_result')).toEqual(toolResult);
    expect(row.parts.find((p: any) => p.type === 'tool_call'))
      .toEqual({ type: 'tool_call', name: 'web_search', args: { q: 'x' } });
  });

  it('the persist normalize is NON-mutating — result.parts keeps the raw text for post-delivery machinery', async () => {
    const rawParts = [{ type: 'text', text: collapsedTable }];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: collapsedTable, parts: rawParts, receipts: [] });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-md-parts-2', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-md-parts-2'));

    // The DB row got the repaired copy; the loop's own array is untouched.
    expect(assistantRow().parts[0].text).toBe(repairedTable);
    expect(rawParts[0].text).toBe(collapsedTable);
  });

  it('MULTI-PART safety: each text part is one whole assistant turn, normalized independently', async () => {
    // The agent loop pushes exactly ONE text part per assistant turn
    // (coding/agent.ts: parts.push of the turn's cleanText), so a text part is
    // always a complete document — never a fragment split mid-table. Two turns
    // with different degradation classes each repair on their own.
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: collapsedHeading,
      parts: [
        { type: 'text', text: collapsedTable },
        { type: 'tool_call', name: 'list_chats', args: {} },
        { type: 'text', text: collapsedHeading },
      ],
      receipts: [],
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-md-parts-3', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-md-parts-3'));

    const texts = assistantRow().parts.filter((p: any) => p.type === 'text').map((p: any) => p.text);
    expect(texts).toEqual([repairedTable, repairedHeading]);
  });

  it('normalize + structured-block strip compose (the dc7fd17a strip still applies, in content order)', async () => {
    const raw = `${collapsedTable}\n[FOLLOWUPS]\n- Next question\n[/FOLLOWUPS]`;
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: raw,
      parts: [{ type: 'text', text: raw }],
      receipts: [],
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-md-parts-4', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-md-parts-4'));

    const text = assistantRow().parts.find((p: any) => p.type === 'text').text;
    expect(text).toContain('Here is the table:\n\n| Method | Time |');
    expect(text).not.toContain('[FOLLOWUPS]');
  });
});

describe('plain-text tool-call leak retry (owner report, chat 7dc031fb)', () => {
  const leakedText = 'list_chats({"limit": 20})';
  const cleanAnswer = 'Here are your live projects: Alpha and Beta, both updated this hour.';
  const NUDGE_MARKER = '[HARNESS NOTICE — not typed by the user]';

  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.role === 'assistant');

  beforeEach(() => {
    mockPrisma.crossModelMessage.create.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    (logger.warn as jest.Mock).mockClear();
  });

  it('a leaked list_chats-as-text final triggers ONE nudged retry, then the clean answer delivers', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: leakedText, parts: [{ type: 'text', text: leakedText }], receipts: [] })
      .mockResolvedValueOnce({ finalText: cleanAnswer, parts: [{ type: 'text', text: cleanAnswer }], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-leak-1', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-leak-1'));

    // TWO orchestrator runs — the retry carries the coding loop's nudge on the user turn.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    const retryArgs = (runCodingAgent as jest.Mock).mock.calls[1][0];
    expect(retryArgs.userMessage).toContain('the question');
    expect(retryArgs.userMessage).toContain(NUDGE_MARKER);
    expect(retryArgs.userMessage).toContain('Re-issue it through the structured tool-calling API');

    // The committed row is the CLEAN answer; the leak never persisted.
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(cleanAnswer);
    // Attempt-1's leaked chunks already streamed — the complete event carries
    // the swap so live viewers see the clean text (same contract as reject-back).
    expect(events.find(e => e.type === 'complete')!.data.finalText).toBe(cleanAnswer);
    // Counted via a log line.
    expect((logger.warn as jest.Mock).mock.calls.some(
      (c: any[]) => String(c[0]).includes('plain-text tool-call leak') && String(c[0]).includes('(1/2)'),
    )).toBe(true);
  });

  it('prose that merely MENTIONS list_chats never triggers a retry', async () => {
    const prose = 'You can use list_chats to see your chats — I checked them all just now.';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: prose, parts: [{ type: 'text', text: prose }], receipts: [] });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-leak-2', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-leak-2'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(prose);
  });

  it('the bound is respected: a persistently-leaking model gets exactly 2 retries (3 runs), then delivers as-is', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: leakedText, parts: [{ type: 'text', text: leakedText }], receipts: [] });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-leak-3', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-leak-3'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(3); // 1 + MAX_CHAT_LEAK_RETRIES
    // Exhausted: the text delivers as-is (bounded, never an infinite loop).
    expect(assistantWrites()[0].content).toBe(leakedText);
    const leakWarns = (logger.warn as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes('plain-text tool-call leak in the final answer — nudging'));
    expect(leakWarns).toHaveLength(2);
    expect(leakWarns[1]).toContain('(2/2)');
  });

  it('a leak after a MUTATING tool call is NOT replayed (side effects already fired)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: leakedText,
      parts: [
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'x', message: 'hi' } },
        { type: 'text', text: leakedText },
      ],
      receipts: [],
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-leak-4', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-leak-4'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
    expect((logger.warn as jest.Mock).mock.calls.some(
      (c: any[]) => String(c[0]).includes("fired mutating tool 'send_chat_message' — NOT replaying"),
    )).toBe(true);
  });

  it('an EMPTY retry falls back to delivering the original leaked text (fail-open, no blank bubble)', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: leakedText, parts: [{ type: 'text', text: leakedText }], receipts: [] })
      .mockResolvedValueOnce({ finalText: '', parts: [], receipts: [] });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-leak-5', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-leak-5'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    expect(assistantWrites()[0].content).toBe(leakedText);
  });
});

describe('prose-narration tool-call retry (feedback ab9d96eb — "Calling list_chats …" as text)', () => {
  // The exact 21:35Z answer shape from chat 7dc031fb: first-person narration of
  // calls the run never made — the call-shape detector provably misses it.
  const narration =
    `You're right, I missed it entirely — Give me a second to pull that session fresh. ` +
    `*(Calling list_chats + get_chat_messages on the TT-RD project session — I'll report what I actually find)*`;
  const cleanAnswer = 'The TT-RD project has one session: Tenstorrent R&D, last active this hour.';
  const NUDGE_MARKER = '[HARNESS NOTICE — not typed by the user]';

  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.role === 'assistant');

  beforeEach(() => {
    mockPrisma.crossModelMessage.create.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    (logger.warn as jest.Mock).mockClear();
  });

  it('a no-tool narration final triggers ONE nudged retry, then the real answer delivers (complete carries the swap)', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: narration, parts: [{ type: 'text', text: narration }], receipts: [] })
      .mockResolvedValueOnce({ finalText: cleanAnswer, parts: [{ type: 'text', text: cleanAnswer }], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-narr-1', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-narr-1'));

    // TWO orchestrator runs — the retry carries the leak nudge on the user turn.
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    const retryArgs = (runCodingAgent as jest.Mock).mock.calls[1][0];
    expect(retryArgs.userMessage).toContain('the question');
    expect(retryArgs.userMessage).toContain(NUDGE_MARKER);

    // The committed row is the REAL answer; the narration never persisted, and
    // live viewers swap to the retry (attempt-1 chunks already streamed).
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(cleanAnswer);
    expect(events.find(e => e.type === 'complete')!.data.finalText).toBe(cleanAnswer);
    expect((logger.warn as jest.Mock).mock.calls.some(
      (c: any[]) => String(c[0]).includes('plain-text tool-call leak') && String(c[0]).includes('(1/2)'),
    )).toBe(true);
  });

  it('the bound is respected for narration too: persistent narration gets exactly 2 retries, then delivers as-is', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: narration, parts: [{ type: 'text', text: narration }], receipts: [] });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-narr-2', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-narr-2'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(3); // 1 + MAX_CHAT_LEAK_RETRIES
    expect(assistantWrites()[0].content).toBe(narration);
  });

  it('a narration-shaped final after REAL tool work is NOT replayed when a mutating tool fired (replay-safety gate covers both shapes)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: narration,
      parts: [
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'x', content: 'hi' } },
        { type: 'text', text: narration },
      ],
      receipts: [],
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-narr-3', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-narr-3'));

    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
    expect((logger.warn as jest.Mock).mock.calls.some(
      (c: any[]) => String(c[0]).includes("fired mutating tool 'send_chat_message' — NOT replaying"),
    )).toBe(true);
  });
});

// ── Remediation P2 spark G8 — deferred-action receipts (2026-09-08 ~21:00Z) ───
// A supervisor machine-wake note that DEFERS an action ("the swap runs next
// wake") while the run armed NO schedule and messaged NO lane is DETECTED.
// Gate flip 2026-09-11 (owner: full steam): OBSERVE-ONLY — the seam records a
// `supervisor_deferral_unarmed` loop metric + a one-line transcript note and
// NEVER arms a schedule (the +15 min auto-arm was the supervisor's
// "self-ping loop": 67 schedules / +16% wakes / 12 re-armed follow-ups).
describe('spark G8 — deferred-action receipts (supervisor machine wakes) — observe-only since 2026-09-11', () => {
  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'assistant');
  const deferralMetrics = () =>
    mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'supervisor_deferral_unarmed');

  beforeEach(() => {
    mockCreateSchedule.mockClear();
    mockRecordLoopMetric.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
  });
  afterEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('the 21:00Z incident shape: a deferral with no armed schedule and no lane message records a metric + a note — and arms NOTHING', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: 'Bench complete: Machete config won. The winning swap runs next wake — no action needed from the owner.',
      parts: [{ type: 'tool_call', name: 'get_chat_status', args: {} }],
      receipts: [],
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-g8-defer', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-g8-defer'));

    // Observe-only: no self-schedule of any kind.
    expect(mockCreateSchedule).not.toHaveBeenCalled();
    // The telemetry row names the deferral (clipped).
    const metrics = deferralMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ kind: 'supervisor_deferral_unarmed', sessionId: 'chat-g8-defer' });
    expect(metrics[0].meta.line).toContain('runs next wake');
    expect(metrics[0].meta.line.length).toBeLessThanOrEqual(120);
    // The final note carries the non-blocking observe note — and no receipt / schedule id.
    const row = assistantWrites().at(-1);
    expect(row.content).toContain('[harness — deferred-action note]');
    expect(row.content).toContain('no longer auto-arms');
    expect(row.content).not.toContain('deferred-action receipt');
    expect(row.content).not.toContain('sched-de');
    // The original model text is preserved verbatim (appended, never replaced).
    expect(row.content).toContain('Bench complete: Machete config won.');
  });

  it('a deferral WITH an armed schedule (schedule_message called) arms nothing', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: 'The swap runs next wake — armed sched 12345678 to fire it.',
      parts: [{ type: 'tool_call', name: 'schedule_message', args: { kind: 'once', intervalMinutes: 30 } }],
      receipts: [],
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-g8-armed', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-g8-armed'));
    expect(mockCreateSchedule).not.toHaveBeenCalled();
    expect(deferralMetrics()).toHaveLength(0);
  });

  it('a deferral that MESSAGED the target lane (send_chat_message) arms nothing', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: 'Told the lane to run the cutover; will verify next wake.',
      parts: [{ type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1', content: 'run the cutover' } }],
      receipts: [],
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-g8-sent', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-g8-sent'));
    expect(mockCreateSchedule).not.toHaveBeenCalled();
    expect(deferralMetrics()).toHaveLength(0);
  });

  it('non-supervisor machine wakes and user turns never reach the seam', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A plain chat', isSupervisor: false, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({
      finalText: 'Will verify next wake.', parts: [], receipts: [],
    });
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId: 'chat-g8-plain', sessionId: null,
      machineWake: true, messageOrigin: 'schedule',
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-g8-plain'));
    expect(mockCreateSchedule).not.toHaveBeenCalled();
    expect(deferralMetrics()).toHaveLength(0);
  });

  // audit 2026-10-06 T8-9 (schooltime F8 / others F17): 191 false notes in 7 days — "next sweep" while a recurring
  // sweep is armed, and the note quoting the line head instead of the deferral clause.
  describe('audit 2026-10-06 T8-9 — an enabled recurring schedule covers the deferral; the note quotes the clause', () => {
    const coveredMetrics = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'supervisor_deferral_covered');
    afterEach(() => { delete mockPrisma.chatSchedule; delete process.env.DEFERRAL_NOTE_PRECISION_DISABLED; });
    const runNote = async (chatId: string, finalText: string) => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText, parts: [{ type: 'tool_call', name: 'get_chat_status', args: {} }], receipts: [] });
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId, sessionId: null, machineWake: true, messageOrigin: 'schedule' });
      const events: Array<{ type: string; data: any }> = [];
      subscribeRun(key!, e => events.push(e));
      await waitFor(() => events.some(e => e.type === 'complete'));
      await waitFor(() => !isRunActive(`chat:${chatId}`));
    };

    it('a chat with an enabled recurring sweep: no note, no unarmed row — a supervisor_deferral_covered row', async () => {
      const count = jest.fn(async () => 1);
      mockPrisma.chatSchedule = { count, findMany: jest.fn(async () => []) };
      await runNote('chat-t89-covered', 'Fresh probe at 22:56Z: shard 4 healthy. My next sweep re-checks the mirror.');
      expect(count).toHaveBeenCalledWith({ where: { sessionId: 'chat-t89-covered', enabled: true, kind: 'recurring' } });
      expect(deferralMetrics()).toHaveLength(0);
      expect(coveredMetrics()).toHaveLength(1);
      expect(coveredMetrics()[0].meta).toMatchObject({ by: 'recurring_schedule', line: 'My next sweep re-checks the mirror.' });
      expect(assistantWrites().at(-1).content).not.toContain('[harness — deferred-action note]');
    });

    it('no recurring schedule: the note fires and quotes the deferral CLAUSE, not the line head', async () => {
      mockPrisma.chatSchedule = { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) };
      await runNote('chat-t89-unarmed', 'Fresh probe at 22:56Z: shard 4 healthy. My next sweep re-checks the mirror.');
      expect(deferralMetrics()).toHaveLength(1);
      expect(deferralMetrics()[0].meta.line).toBe('My next sweep re-checks the mirror.');
      expect(assistantWrites().at(-1).content).toContain('("My next sweep re-checks the mirror.")');
    });

    it('DEFERRAL_NOTE_PRECISION_DISABLED=1: the note fires despite the recurring sweep and quotes the line head (previous behaviour)', async () => {
      process.env.DEFERRAL_NOTE_PRECISION_DISABLED = '1';
      const count = jest.fn(async () => 1);
      mockPrisma.chatSchedule = { count, findMany: jest.fn(async () => []) };
      await runNote('chat-t89-ks', 'Fresh probe at 22:56Z: shard 4 healthy. My next sweep re-checks the mirror.');
      expect(count).not.toHaveBeenCalled();
      expect(coveredMetrics()).toHaveLength(0);
      expect(deferralMetrics()).toHaveLength(1);
      expect(deferralMetrics()[0].meta.line.startsWith('Fresh probe at 22:56Z')).toBe(true);
    });

    // Ticket fcee0741: a cadence announcement is no deferral at all; a deferral line citing a schedule id is armed
    // by the citation (resolved against THIS chat's own schedules — a cited own row that is DISABLED arms nothing).
    describe('ticket fcee0741 — cadence announcements + cited schedules', () => {
      afterEach(() => { delete process.env.DEFERRAL_CADENCE_EXEMPT_DISABLED; });

      it('"**Next sweep:** 21:47Z (schedule 53f68b62)." records nothing — no unarmed row, no note, no DB read', async () => {
        const count = jest.fn(async () => 0);
        const findMany = jest.fn(async () => []);
        mockPrisma.chatSchedule = { count, findMany };
        await runNote('chat-fc-cadence', 'Board unchanged.\n**Next sweep:** 21:47Z (schedule 53f68b62).');
        expect(deferralMetrics()).toHaveLength(0);
        expect(coveredMetrics()).toHaveLength(0);
        expect(count).not.toHaveBeenCalled();
        expect(findMany).not.toHaveBeenCalled();
        expect(assistantWrites().at(-1).content).not.toContain('[harness — deferred-action note]');
      });

      it("a commitment citing another chat's schedule is accepted: covered {by:'cited_schedule', resolved:'unresolved'}", async () => {
        const findMany = jest.fn(async () => []);
        mockPrisma.chatSchedule = { count: jest.fn(async () => 0), findMany };
        await runNote('chat-fc-foreign', 'Drive watch quiet. The lane re-checks the folder next wake (sched d72b394a).');
        expect(findMany).toHaveBeenCalledWith({
          where: { sessionId: 'chat-fc-foreign', OR: [{ id: { startsWith: 'd72b394a' } }] },
          select: { id: true, enabled: true },
          take: 10,
        });
        expect(deferralMetrics()).toHaveLength(0);
        expect(coveredMetrics()).toHaveLength(1);
        expect(coveredMetrics()[0].meta).toMatchObject({ by: 'cited_schedule', resolved: 'unresolved', scheduleIds: ['d72b394a'] });
        expect(assistantWrites().at(-1).content).not.toContain('[harness — deferred-action note]');
      });

      it("a commitment citing this chat's own ENABLED schedule: covered, resolved 'own'", async () => {
        mockPrisma.chatSchedule = { count: jest.fn(async () => 0), findMany: jest.fn(async () => [{ id: '1a2b3c4d-0000-4000-8000-000000000000', enabled: true }]) };
        await runNote('chat-fc-own', 'The swap runs next wake (schedule 1a2b3c4d armed for it).');
        expect(deferralMetrics()).toHaveLength(0);
        expect(coveredMetrics()[0].meta).toMatchObject({ by: 'cited_schedule', resolved: 'own' });
      });

      it("a commitment citing this chat's own DISABLED schedule arms nothing — the unarmed row + note fire", async () => {
        mockPrisma.chatSchedule = { count: jest.fn(async () => 0), findMany: jest.fn(async () => [{ id: '1a2b3c4d-0000-4000-8000-000000000000', enabled: false }]) };
        await runNote('chat-fc-disabled', 'The swap runs next wake (schedule 1a2b3c4d, paused).');
        expect(coveredMetrics()).toHaveLength(0);
        expect(deferralMetrics()).toHaveLength(1);
        expect(deferralMetrics()[0].meta.line).toContain('The swap runs next wake');
        expect(assistantWrites().at(-1).content).toContain('[harness — deferred-action note]');
      });

      it('DEFERRAL_CADENCE_EXEMPT_DISABLED=1: the cadence line trips as before (the unarmed row fires)', async () => {
        process.env.DEFERRAL_CADENCE_EXEMPT_DISABLED = '1';
        mockPrisma.chatSchedule = { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) };
        await runNote('chat-fc-ks', '**Next sweep:** 21:47Z (schedule 53f68b62).');
        expect(deferralMetrics()).toHaveLength(1);
        expect(deferralMetrics()[0].meta.line).toBe('**Next sweep:** 21:47Z (schedule 53f68b62).');
      });
    });
  });
});

// ── Remediation P2 spark B7 — supervisor state doc on OWNER-typed turns ───────
// Machine wakes bake [SUPERVISOR STATE] into the wake prompt; an owner typing
// into the supervisor chat used to run WITHOUT it (amnesic about open
// directives). Non-machine supervisor turns now load the doc + the live
// attention block into the system context.
describe('spark B7 — supervisor state on owner-typed turns', () => {
  const doctrineOfLastRun = (): string =>
    (runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]?.doctrineOverride as string;

  beforeEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    mockPrisma.supervisorState = {
      findUnique: jest.fn(async () => ({
        state: {
          directives: [{ id: 'd-b7', text: 'Cutover the bench lane to Machete after the bench wins', at: new Date().toISOString(), status: 'open' }],
          dispatches: [], projects: [], notes: '', refutations: [],
        },
      })),
      upsert: jest.fn(async () => ({})),
    };
    // buildFleetAttentionBlock legs — quiet fleet.
    mockPrisma.projectTodo = { findMany: jest.fn(async () => []) };
    mockPrisma.chatSchedule = { findMany: jest.fn(async () => []) };
    mockPrisma.ownerQuestion = { findMany: jest.fn(async () => []) };
  });
  afterEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    delete mockPrisma.supervisorState;
    delete mockPrisma.projectTodo;
    delete mockPrisma.chatSchedule;
    delete mockPrisma.ownerQuestion;
  });

  it('an OWNER turn in the supervisor chat carries [SUPERVISOR STATE] (open directives included) in its context', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-b7-owner', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-b7-owner'));
    const d = doctrineOfLastRun();
    expect(d).toContain('[SUPERVISOR STATE');
    expect(d).toContain('Cutover the bench lane to Machete');
  });

  it('a NON-supervisor owner turn never loads the doc', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A plain chat', isSupervisor: false, userId: 'u1' }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-b7-plain', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-b7-plain'));
    expect(mockPrisma.supervisorState.findUnique).not.toHaveBeenCalled();
    expect(doctrineOfLastRun()).not.toContain('[SUPERVISOR STATE');
  });
});

describe('run-finalize fairness (owner 2026-09-14): a starving hook backlog is drained BEFORE the message queue', () => {
  beforeEach(() => {
    mockOldestPendingHookAgeMs.mockReset().mockResolvedValue(0);
    mockDrainHookEventsForTarget.mockReset();
    // TEARDOWN FIX (2026-11-05, bisect: loop #17). The first case below arms
    // findFirst.mockResolvedValueOnce(...) and then asserts the queue was NOT
    // drained — and the hooks-first path short-circuits BEFORE the queue peek,
    // so that one-time impl is never consumed. Jest's *Once impls outrank any
    // mockImplementation a LATER test installs, so loop #17's own
    // `pcm.findFirst.mockImplementation(...)` could not win: its drain was
    // served the PREVIOUS test's row ('queued while starving', chat chat-fair-a)
    // instead of its own, and :5656 then waited 3 s for content that was never
    // going to be persisted. Measured: loop #17 alone 1 passed / 673 ms, with
    // the first case ahead of it 1 failed / 3117 ms.
    // Reset (not just default) so a leftover one-time impl cannot cross cases;
    // this describe's cases each arm their own inside the test body.
    mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
  });

  it('oldest pending hook row older than HOOK_STARVATION_MS → hook drain kicked, the queued message waits for that wake\'s finalize', async () => {
    mockOldestPendingHookAgeMs.mockResolvedValue(6 * 60 * 1000);
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-fair-1', chatId: 'chat-fair-a', userId: 'u1', content: 'queued while starving',
      mode: 'single_thinking', source: 'agent', createdAt: new Date(),
    });
    mockDrainHookEventsForTargetNow.mockClear().mockResolvedValue(true);
    mockRecordLoopMetric.mockClear();
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-fair-a', sessionId: null });
    expect(key).toBe('chat:chat-fair-a');
    await waitFor(() => !isRunActive('chat:chat-fair-a'));
    // Loop #17: the finalize AWAITS the wake (drainHookEventsForTargetNow), no fire-and-forget kick.
    await waitFor(() => mockDrainHookEventsForTargetNow.mock.calls.length > 0);
    expect(mockDrainHookEventsForTargetNow).toHaveBeenCalledWith('chat-fair-a');
    expect(mockDrainHookEventsForTarget).not.toHaveBeenCalled();
    expect(mockHooksFirstVerdict).toHaveBeenCalledWith('chat-fair-a', expect.anything(), expect.any(Date), { capMs: Number.POSITIVE_INFINITY });
    const hf = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.kind === 'finalize_hooks_first');
    expect(hf).toMatchObject({ sessionId: 'chat-fair-a', meta: expect.objectContaining({ wakeStarted: true, hookAgeMs: 6 * 60 * 1000 }) });
    await new Promise((r) => setTimeout(r, 100));
    const drained = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'user' && d?.content === 'queued while starving');
    expect(drained).toBeUndefined(); // the queue was NOT drained this round — the hook wake goes first
  });

  it('loop #17: hooks-first whose awaited wake could NOT start (cap / depth / undeliverable) falls through to the queue drain — nothing starves', async () => {
    mockOldestPendingHookAgeMs.mockResolvedValue(6 * 60 * 1000);
    mockDrainHookEventsForTargetNow.mockClear().mockResolvedValue(false);
    mockRecordLoopMetric.mockClear();
    const row = {
      id: 'pend-fair-ft', chatId: 'chat-fair-d', userId: 'u1', content: 'queued behind an undeliverable backlog',
      mode: 'single_thinking', source: 'agent', createdAt: new Date(),
    };
    let queued: any[] = [row];
    const pcm: any = mockPrisma.pendingChatMessage;
    pcm.findMany = jest.fn(async () => queued);
    pcm.findFirst.mockImplementation(async () => queued[0] ?? null);
    pcm.delete.mockImplementation(async ({ where }: any) => { queued = queued.filter((r) => r.id !== where.id); return {}; });
    try {
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-fair-d', sessionId: null });
      expect(key).toBe('chat:chat-fair-d');
      await waitFor(() => !isRunActive('chat:chat-fair-d'));
      await waitFor(() => mockDrainHookEventsForTargetNow.mock.calls.length > 0);
      await waitFor(() => mockPrisma.crossModelMessage.create.mock.calls.some((c: any[]) => c[0]?.data?.role === 'user' && c[0]?.data?.content === 'queued behind an undeliverable backlog'));
      const hf = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.kind === 'finalize_hooks_first');
      expect(hf).toMatchObject({ sessionId: 'chat-fair-d', meta: expect.objectContaining({ wakeStarted: false }) });
      await waitFor(() => !isRunActive('chat:chat-fair-d'));
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      delete pcm.findMany;
      pcm.findFirst.mockReset().mockResolvedValue(null);
      pcm.delete.mockReset().mockResolvedValue({});
      mockDrainHookEventsForTargetNow.mockReset().mockResolvedValue(true);
    }
  });

  it('QUEUE FAIRNESS (loop #15): a queued machine row OLDER than the hook backlog drains first — queue_fairness_preempt recorded', async () => {
    mockOldestPendingHookAgeMs.mockResolvedValue(6 * 60 * 1000);
    const row = {
      id: 'pend-fair-old', chatId: 'chat-fair-c', userId: 'u1', content: 'queued 30 min ago behind hooks',
      mode: 'single_thinking', source: 'agent', createdAt: new Date(Date.now() - 30 * 60 * 1000),
    };
    let queued: any[] = [row];
    const pcm: any = mockPrisma.pendingChatMessage;
    pcm.findMany = jest.fn(async () => queued);
    pcm.findFirst.mockImplementation(async () => queued[0] ?? null);
    pcm.delete.mockImplementation(async ({ where }: any) => { queued = queued.filter((r) => r.id !== where.id); return {}; });
    mockRecordLoopMetric.mockClear();
    try {
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-fair-c', sessionId: null });
      expect(key).toBe('chat:chat-fair-c');
      await waitFor(() => !isRunActive('chat:chat-fair-c'));
      await waitFor(() => mockPrisma.crossModelMessage.create.mock.calls.some((c: any[]) => c[0]?.data?.role === 'user' && c[0]?.data?.content === 'queued 30 min ago behind hooks'));
      const preempt = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.kind === 'queue_fairness_preempt');
      expect(preempt).toMatchObject({ sessionId: 'chat-fair-c', meta: expect.objectContaining({ entrant: 'finalize', reason: 'queue_older', source: 'agent' }) });
      expect(preempt.meta.queueHeadAgeMs).toBeGreaterThan(preempt.meta.hookAgeMs);
      expect(mockHooksFirstVerdict).toHaveBeenCalledWith('chat-fair-c', expect.objectContaining({ source: 'agent' }), expect.any(Date), { capMs: Number.POSITIVE_INFINITY });
      await waitFor(() => !isRunActive('chat:chat-fair-c'));
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      delete pcm.findMany;
      pcm.findFirst.mockReset().mockResolvedValue(null);
      pcm.delete.mockReset().mockResolvedValue({});
    }
  });

  it('no starving backlog (age 0) and nothing queued → hook drain runs after the queue check (instant hooks default)', async () => {
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce(null);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-fair-b', sessionId: null });
    expect(key).toBe('chat:chat-fair-b');
    await waitFor(() => !isRunActive('chat:chat-fair-b'));
    await waitFor(() => mockDrainHookEventsForTarget.mock.calls.length > 0);
    expect(mockDrainHookEventsForTarget).toHaveBeenCalledWith('chat-fair-b');
  });
});

describe('hook-starvation yield at the other idle-window entrants + retiring-colour hand-off (autonomy loop #11, 2026-09-20)', () => {
  beforeEach(() => {
    mockHookBacklogStarving.mockReset().mockResolvedValue(false);
    mockUnparkHookEventsForTarget.mockReset().mockResolvedValue(0);
    mockDrainHookEventsForTarget.mockReset();
    mockOldestPendingHookAgeMs.mockReset().mockResolvedValue(0);
    __resetRetiringForTests();
  });
  afterAll(() => __resetRetiringForTests());

  it('drainChatQueue (the nudge / orphan-sweeper path) yields for a queued AGENT row when the hook backlog is starving: hook digest kicked, no run started, row left for the wake\'s finalize', async () => {
    mockHookBacklogStarving.mockResolvedValue(true);
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-yield-1', chatId: 'chat-yield-a', userId: 'u1', content: 'queued agent steer',
      mode: 'single_thinking', source: 'agent', createdAt: new Date(),
    });
    const before = mockPrisma.crossModelMessage.create.mock.calls.length;
    expect(await drainChatQueue('chat-yield-a', 'u1')).toBe(false);
    expect(mockHookBacklogStarving).toHaveBeenCalledWith('chat-yield-a', undefined, expect.objectContaining({ source: 'agent' })); // loop #15: the row states its own wait
    expect(mockDrainHookEventsForTarget).toHaveBeenCalledWith('chat-yield-a');
    expect(isRunActive('chat:chat-yield-a')).toBe(false);
    expect(mockPrisma.crossModelMessage.create.mock.calls.length).toBe(before);
    expect(mockPrisma.pendingChatMessage.delete.mock.calls.some((c: any[]) => c[0]?.where?.id === 'pend-yield-1')).toBe(false); // the row waits for the hook wake's finalize
  });

  it('a queued USER row is never held behind hooks (humans preempt machine traffic)', async () => {
    mockHookBacklogStarving.mockResolvedValue(true);
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce({
      id: 'pend-yield-2', chatId: 'chat-yield-b', userId: 'u1', content: 'queued owner message',
      mode: 'single_thinking', source: 'user', createdAt: new Date(),
    });
    expect(await drainChatQueue('chat-yield-b', 'u1')).toBe(true);
    expect(mockHookBacklogStarving).not.toHaveBeenCalled();
    await waitFor(() => !isRunActive('chat:chat-yield-b'));
    await new Promise((r) => setTimeout(r, 100));
  });

  it('a finalize on the RETIRING colour starts nothing but hands the backlog over: parked hook rows un-parked, no queue drain, no hook kick', async () => {
    mockUnparkHookEventsForTarget.mockResolvedValue(8);
    mockOldestPendingHookAgeMs.mockResolvedValue(27 * 60 * 1000); // would have drained hooks first on a live colour
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValue({
      id: 'pend-retire-1', chatId: 'chat-retire-a', userId: 'u1', content: 'queued agent steer',
      mode: 'single_thinking', source: 'agent', createdAt: new Date(),
    });
    // A USER turn still runs on a retiring colour (nginx already routes users to the new colour;
    // the gate refuses only MACHINE starts) — its finalize is where the hand-off happens.
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-retire-a', sessionId: null });
    expect(key).toBe('chat:chat-retire-a');
    // Retire mid-run so the finalize sees the retiring colour.
    markRetiringForTest(new Date());
    await waitFor(() => !isRunActive('chat:chat-retire-a'));
    await waitFor(() => mockUnparkHookEventsForTarget.mock.calls.length > 0);
    expect(mockUnparkHookEventsForTarget).toHaveBeenCalledWith('chat-retire-a');
    await new Promise((r) => setTimeout(r, 150));
    expect(mockDrainHookEventsForTarget).not.toHaveBeenCalled();
    const drained = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.role === 'user' && d?.content === 'queued agent steer');
    expect(drained).toBeUndefined();
    __resetRetiringForTests();
    mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
  });
});

describe('toolResultPhrase — sub-agent result status is a human sentence (owner 2026-09-15)', () => {
  it('never echoes the raw tool id or a byte count', () => {
    for (const n of ['search_engine', 'web_pipe', 'search_memory', 'scrape_as_markdown', 'browser_task', 'gmail_search', 'weird_tool_x']) {
      const line = `Double Checker ${toolResultPhrase(n)}…`;
      expect(line).not.toContain('_');
      expect(line).not.toMatch(/\bB\b|\d/);
      expect(line.startsWith('Double Checker is ')).toBe(true);
    }
    expect(toolResultPhrase('search_engine')).toBe('is reading the search results');
    expect(toolResultPhrase('search_memory')).toBe('is checking what it already knows');
    expect(toolResultPhrase('scrape_as_markdown')).toBe('is reading the page');
  });
});

describe('shared turn spend ledger (WI-D — the Double Checker is metered into run_spend)', () => {
  const workerMock = runChatWorker as jest.Mock;
  const agentMock = runCodingAgent as jest.Mock;
  const usage = (i: any) => i.usage as import('../coding/cost').UsageAccumulator | undefined;
  // The real wrappers (coding/agent.ts runCodingAgent / runChatWorker) hold the
  // ledger while their loop runs and record turn usage into it; the mocks here
  // reproduce exactly that contract so the CALLER side (one ledger threaded to
  // every seat, close() in the turn's finally, the late-pass hold) is what is
  // exercised.
  const recordingAgent = (opts?: { first?: string }) => {
    let calls = 0;
    return async (input: any) => {
      usage(input)?.retain();
      usage(input)?.record('Digby', input.model, { promptTokens: 1000, completionTokens: 200, estimated: false });
      usage(input)?.release();
      calls += 1;
      return { finalText: calls === 1 && opts?.first !== undefined ? opts.first : 'A'.repeat(500), parts: [] };
    };
  };
  // The seat the real record site stamps (agent.ts, seat-label fix 2026-09-25):
  // input.usageRole (the reconcile pass's 'reconcile') over the worker role,
  // under its own row key so it never merges into the checker's row.
  const seatOf = (input: any, role: string) => input.usageRole ?? role;
  const agentOf = (input: any) => input.usageRole ? `Cross-checker (${input.usageRole})` : 'Cross-checker';
  const recordingWorker = (delayMs: number, onDone?: () => void) => async (input: any, role: string) => {
    if (String(input.userMessage).includes('YOUR DRAFT ANSWER')) {
      // the one-shot reconcile pass — the LEAD model in the checker worker shape
      usage(input)?.retain();
      usage(input)?.record(agentOf(input), input.model, { promptTokens: 800, completionTokens: 150, estimated: false }, seatOf(input, role));
      usage(input)?.release();
      return { finalText: 'RECONCILED ' + 'B'.repeat(400), parts: [] };
    }
    usage(input)?.retain();
    await new Promise(r => setTimeout(r, delayMs));
    usage(input)?.record(agentOf(input), input.model, { promptTokens: 500, completionTokens: 100, estimated: false }, seatOf(input, role));
    usage(input)?.release();
    onDone?.();
    return { finalText: 'PEER-DRAFT', parts: [] };
  };

  beforeEach(() => {
    workerMock.mockReset();
    agentMock.mockReset();
    mockRecordRunSpend.mockClear();
    workerMock.mockImplementation(recordingWorker(20));
    agentMock.mockImplementation(recordingAgent());
  });
  afterEach(() => {
    workerMock.mockReset();
    agentMock.mockReset();
    workerMock.mockImplementation(async () => ({ finalText: '' }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
  });

  it('an L2 user turn threads ONE ledger to the lead and the checker and writes ONE run_spend naming both models, stamped profile chat', async () => {
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ledger-l2', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => mockRecordRunSpend.mock.calls.length > 0);

    const orch = agentMock.mock.calls[0][0];
    const checker = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'))![0];
    expect(usage(orch)).toBeDefined();
    expect(usage(orch)!.shared).toBe(true);
    expect(usage(checker)).toBe(usage(orch)); // the SAME accumulator, not a copy
    // The reconcile pass (if it ran) rides the same ledger too.
    for (const [i] of workerMock.mock.calls) expect(usage(i)).toBe(usage(orch));

    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    const [runId, sessionId, snap, stamp] = mockRecordRunSpend.mock.calls[0];
    expect(runId).toBe(usage(orch)!.runId);
    expect(sessionId).toBe('chat-ledger-l2');
    const models = snap.agents.map((a: any) => a.model);
    expect(models).toContain('kimi-k3');
    expect(models).toContain('deepseek-flash');
    expect(snap.agents.find((a: any) => a.model === 'deepseek-flash').role).toBe('cross_checker');
    expect(stamp).toMatchObject({ profile: 'chat', model: 'kimi-k3', triggerKind: 'user' });
  });

  // Audit 2026-10-06 T6-4 (crosscutting X7): a chat / supervisor turn has no agent_runs row — its compaction rows
  // and tool-failure logs carried no runId. The turn now runs inside an ambient telemetry run whose id IS its
  // run_spend runId; the agent loop (and every loop of the turn) sees it for its own session only.
  it('T6-4: every loop of the turn sees ONE minted telemetry run id (chat-…) for its own session — the same id run_spend is written under; CHAT_RUN_TELEMETRY_ID_DISABLED=1 removes it', async () => {
    const { ambientTelemetryRunId, resolveReceiptRunId } = await import('../../../utils/run-telemetry-context');
    const seen: Array<{ own?: string; other?: string; ledger?: string; receiptOwn?: string | null; receiptOther?: string | null; receiptDurable?: string | null }> = [];
    agentMock.mockImplementation(async (input: any) => {
      seen.push({
        own: ambientTelemetryRunId(input.sessionId), other: ambientTelemetryRunId('some-other-chat'), ledger: usage(input)?.runId,
        // Ticket e225aad8: the receipt seam's runId resolution, observed INSIDE
        // the turn — the ambient context is gone once the run completes.
        receiptOwn: resolveReceiptRunId(undefined, input.sessionId), receiptOther: resolveReceiptRunId(undefined, 'some-other-chat'),
        receiptDurable: resolveReceiptRunId('agent-run-1', input.sessionId),
      });
      return recordingAgent()(input);
    });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-telemetry-run', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => mockRecordRunSpend.mock.calls.length > 0);
    expect(seen[0].own).toMatch(/^chat-[0-9a-f-]{36}$/);
    expect(seen[0].other).toBeUndefined();
    expect(seen[0].ledger).toBe(seen[0].own);
    expect(mockRecordRunSpend.mock.calls[0][0]).toBe(seen[0].own);
    expect(ambientTelemetryRunId('chat-telemetry-run')).toBeUndefined(); // nothing leaks outside the turn
    // Ticket e225aad8: the receipt seam resolves the SAME id inside the turn
    // (observed at agentMock time — the ambient context is gone by now), with
    // the durable-runId and cross-chat guards.
    expect(seen[0].receiptOwn).toBe(seen[0].own);
    expect(seen[0].receiptOther).toBeNull();
    expect(seen[0].receiptDurable).toBe('agent-run-1');

    seen.length = 0;
    mockRecordRunSpend.mockClear();
    process.env.CHAT_RUN_TELEMETRY_ID_DISABLED = '1';
    try {
      const key2 = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-telemetry-run-ks', sessionId: null });
      await waitFor(() => !isRunActive(key2!));
      await waitFor(() => mockRecordRunSpend.mock.calls.length > 0);
      expect(seen[0].own).toBeUndefined();
      expect(seen[0].ledger).toMatch(/^r/); // the accumulator's own id, as before
    } finally { delete process.env.CHAT_RUN_TELEMETRY_ID_DISABLED; }
  });

  it('the L2 reconcile pass (the LEAD model re-run one-shot in the checker worker shape) is metered under seat "reconcile", never "cross_checker" (prod 2026-09-25: glm-5.3:[lead,cross_checker])', async () => {
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ledger-reconcile', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => mockRecordRunSpend.mock.calls.length > 0);

    const orch = agentMock.mock.calls[0][0];
    const reconcileCall = workerMock.mock.calls.find(([i]: any[]) => String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    const checkerCall = workerMock.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    expect(reconcileCall).toBeTruthy();
    expect(checkerCall).toBeTruthy();
    // The pass still runs under the cross_checker WORKER role (prompt/toolset
    // unchanged) on the LEAD's model…
    expect(reconcileCall![1]).toBe('cross_checker');
    expect(reconcileCall![0].model).toBe(orch.model);
    // …but its usage seat is 'reconcile'; the real checker carries no usageRole.
    expect(reconcileCall![0].usageRole).toBe('reconcile');
    expect(checkerCall![1]).toBe('cross_checker');
    expect(checkerCall![0].usageRole).toBeUndefined();

    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    const snap = mockRecordRunSpend.mock.calls[0][2];
    const seats = (model: string) => snap.agents.filter((a: any) => a.model === model).map((a: any) => a.role ?? 'lead').sort();
    expect(seats('kimi-k3')).toEqual(['lead', 'reconcile']);   // the lead's model: its own turn + the reconcile pass
    expect(seats('deepseek-flash')).toEqual(['cross_checker']); // the Double Checker, unchanged
    expect(snap.agents.some((a: any) => a.model === 'kimi-k3' && a.role === 'cross_checker')).toBe(false);
  });

  it('checker-only usage is NOT dropped when the lead finishes first: the ledger waits for the checker\'s hold before writing', async () => {
    let workerDoneAt = 0;
    workerMock.mockImplementation(recordingWorker(250, () => { workerDoneAt = Date.now(); }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ledger-late', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => mockRecordRunSpend.mock.calls.length > 0, 5000);
    expect(workerDoneAt).toBeGreaterThan(0);
    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    const snap = mockRecordRunSpend.mock.calls[0][2];
    expect(snap.agents.map((a: any) => a.model)).toContain('deepseek-flash');
  });

  it('a lead retry (empty first completion) lands on the SAME ledger — still exactly one run_spend row, two lead turns', async () => {
    agentMock.mockImplementation(recordingAgent({ first: '' }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-ledger-retry', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => mockRecordRunSpend.mock.calls.length > 0);
    expect(agentMock).toHaveBeenCalledTimes(2); // the bounded empty retry
    expect(usage(agentMock.mock.calls[1][0])).toBe(usage(agentMock.mock.calls[0][0]));
    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    expect(mockRecordRunSpend.mock.calls[0][2].turns).toBe(2);
  });
});

describe('per-chat lead-model override (WI-O #4c — crossmodel_chats.leadModel)', () => {
  const agentMock = runCodingAgent as jest.Mock;
  beforeEach(() => {
    agentMock.mockReset();
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
  });
  afterEach(() => {
    agentMock.mockReset();
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('a plain chat with a stored leadModel runs its lead on that model (the instance seat is untouched)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title', leadModel: 'deepseek-flash' }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-lead-a', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentMock.mock.calls.at(-1)?.[0].model).toBe('deepseek-flash');
  });

  it('without a stored pick the lead is the instance seat (kimi-k3 default)', async () => {
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-lead-b', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect(agentMock.mock.calls.at(-1)?.[0].model).toBe('kimi-k3');
  });

  it('a supervisor chat NEVER honours leadModel — its seat is platform-managed', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1', leadModel: 'deepseek-flash' }));
    const key = await startDetachedChatRun({
      ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-lead-sup', sessionId: null,
      messageOrigin: 'user', userTurnAt: new Date(),
    });
    await waitFor(() => !isRunActive(key!));
    expect(agentMock.mock.calls.at(-1)?.[0].model).toBe('kimi-k3');
  });
});

describe('deploy retire nudge (WI-G, 2026-09-25 — finish long supervisor wakes in place across deploys)', () => {
  beforeEach(() => { __resetRetiringForTests(); mockRecordLoopMetric.mockClear(); });
  afterAll(() => __resetRetiringForTests());

  // Drive the orchestrator's injectSystem hook the way agent.ts does (once per
  // top-level step) and record what each round delivered.
  const captureRounds = (onFirst?: () => void) => {
    const rounds: any[] = [];
    (runCodingAgent as jest.Mock).mockImplementationOnce(async (input: any) => {
      onFirst?.();
      for (let step = 0; step < 3; step++) rounds.push(input.injectSystem ? await input.injectSystem(step) : undefined);
      return { finalText: 'A'.repeat(500) };
    });
    return rounds;
  };

  it('a MACHINE wake that is running when the colour retires gets the notice EXACTLY ONCE at its next tool round, with the deploy_retire_nudge metric', async () => {
    const rounds = captureRounds(() => markRetiringForTest(new Date()));
    // Starts BEFORE the retire (the retiring gate refuses machine STARTS; in-flight runs finish).
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-nudge-wake', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-nudge-wake');
    await waitFor(() => !isRunActive('chat:chat-nudge-wake'));
    expect(rounds).toHaveLength(3);
    expect(typeof rounds[0]).toBe('string');
    expect(rounds[0]).toContain('[HARNESS NOTICE — deploy: this server is RETIRING');
    expect(rounds[0]).toContain('first finish any re-arm or dispatch you already decided on'); // audit 2026-10-06 T4-4 wording
    expect(rounds[1]).toBeNull();
    expect(rounds[2]).toBeNull();
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'deploy_retire_nudge');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'chat-nudge-wake', meta: { chatId: 'chat-nudge-wake', step: 0, isSupervisorWake: false } });
    expect(typeof rows[0].meta.remainingSeconds).toBe('number');
  });

  it('a USER turn on the retiring colour is never nudged (no injector at L1 → rounds stay undefined)', async () => {
    const rounds = captureRounds(() => markRetiringForTest(new Date()));
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-nudge-user', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-nudge-user'));
    expect(rounds).toEqual([undefined, undefined, undefined]);
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).some((m: any) => m?.kind === 'deploy_retire_nudge')).toBe(false);
  });

  it('a machine wake on a colour that is NOT retiring gets no notice', async () => {
    const rounds = captureRounds();
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-nudge-live', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    await waitFor(() => !isRunActive('chat:chat-nudge-live'));
    expect(rounds).toEqual([null, null, null]);
  });

  it('the live-run registry is stamped with the run\'s machine/supervisor facts for /drain-status', async () => {
    let stamped: any = null;
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => {
      stamped = getRunMeta('chat:chat-nudge-meta');
      return { finalText: 'A'.repeat(500) };
    });
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-nudge-meta', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    await waitFor(() => !isRunActive('chat:chat-nudge-meta'));
    expect(stamped).toEqual({ chatId: 'chat-nudge-meta', machineTriggered: true, isSupervisorWake: false });
  });
});

describe('N4 checker-site router wiring (purpose checker_route — shadow never waits, labelled at finalize)', () => {
  const deferred = () => {
    let resolve!: (v: any) => void;
    const promise = new Promise<any>(r => { resolve = r; });
    return { promise, resolve };
  };
  const shadowResult = () => ({
    id: 'dec-n4', backend: 'TypeSafe Jev', ms: 5, mode: 'shadow', calibrated: true,
    answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.6, probabilities: { ordinary: 0.6 } }, needs_live_web: { type: 'noul', noul: 0.2 } },
  });
  beforeEach(() => {
    mockDecide.mockReset();
    mockRecordCheckerOutcome.mockReset();
    (runChatWorker as jest.Mock).mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    process.env.DECISION_GATE_MODE_CHECKER_ROUTE = 'shadow';
    // roster 2026-10-06 B-2: these tests pin the human-turn ASK — retired by default since 2026-10-06; the kill switch restores it.
    process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED = '1';
  });
  afterEach(() => { delete process.env.DECISION_GATE_MODE_CHECKER_ROUTE; delete process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED; });

  it('roster 2026-10-06 B-2 (default): a human Level 2 turn makes NO checker_route ask — the regex places the checker exactly as OFF, one decision_ask_retired row records the skip', async () => {
    delete process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED;
    mockRecordLoopMetric.mockClear();
    mockDecide.mockResolvedValue(shadowResult());
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-n4-retired', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-n4-retired'));
    expect(mockDecide.mock.calls.filter((c: any[]) => c[2]?.purpose === 'checker_route')).toHaveLength(0);
    expect(runChatWorker as jest.Mock).toHaveBeenCalled(); // the Double Checker still runs
    expect(mockRecordCheckerOutcome).not.toHaveBeenCalled();
    const retired = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'decision_ask_retired');
    expect(retired).toEqual([expect.objectContaining({ meta: expect.objectContaining({ purpose: 'checker_route', site: 'checker', segment: 'user' }) })]);
  });

  it('a human Level 2 turn fires decide(checker_route) beside the regex and NEVER awaits it: the checker spawns at effort max and the run completes while the gate is still pending; the recorder fires once with the turn\'s real facts when the decision settles', async () => {
    const d = deferred();
    mockDecide.mockReturnValue(d.promise);
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-n4-shadow', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-n4-shadow'));
    // The gate was asked exactly once, for THIS purpose, and is still pending.
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'checker_route', sessionId: expect.any(String) });
    expect(Object.keys(mockDecide.mock.calls[0][1]).sort()).toEqual(['depth', 'needs_live_web']);
    // The Double Checker started regardless (the regex decided), at 'max'.
    expect(runChatWorker as jest.Mock).toHaveBeenCalled();
    const checkerArgs = (runChatWorker as jest.Mock).mock.calls[0][0];
    if (String(checkerArgs.model).startsWith('deepseek') && !String(checkerArgs.model).includes(':')) {
      expect(checkerArgs.providerExtra).toMatchObject({ reasoning_effort: 'max' });
    }
    // Nothing recorded while the decision is unsettled…
    expect(mockRecordCheckerOutcome).not.toHaveBeenCalled();
    // …then the settled decision is labelled ONCE from the finalize facts.
    d.resolve(shadowResult());
    await waitFor(() => mockRecordCheckerOutcome.mock.calls.length > 0);
    expect(mockRecordCheckerOutcome).toHaveBeenCalledTimes(1);
    const [r, facts, opts] = mockRecordCheckerOutcome.mock.calls[0];
    expect(r).toMatchObject({ id: 'dec-n4', mode: 'shadow' });
    expect(facts).toMatchObject({ leadToolCalls: 0, webToolCalls: 0, finalChars: 500, checkerMerged: false });
    expect(typeof facts.regexSimple).toBe('boolean');
    expect(opts).toMatchObject({ acted: false, failed: false });
  });

  it('never fires for Level 1 / Level 3 / a machine turn, nor when the purpose is off or the site kill switch is set', async () => {
    mockDecide.mockResolvedValue(shadowResult());
    await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-n4-l1', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-n4-l1'));
    await startDetachedChatRun({ ...BASE, mode: 'deep_research', userId: 'u1', chatId: 'chat-n4-l3', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-n4-l3'));
    await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-n4-wake', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    await waitFor(() => !isRunActive('chat:chat-n4-wake'));
    expect(mockDecide).not.toHaveBeenCalled();
    delete process.env.DECISION_GATE_MODE_CHECKER_ROUTE; // NODE_ENV=test default → off
    await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-n4-off', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-n4-off'));
    expect(mockDecide).not.toHaveBeenCalled();
    process.env.DECISION_GATE_MODE_CHECKER_ROUTE = 'shadow';
    process.env.DECISION_GATE_CHECKER_ROUTE_DISABLED = '1';
    try {
      await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-n4-kill', sessionId: null });
      await waitFor(() => !isRunActive('chat:chat-n4-kill'));
      expect(mockDecide).not.toHaveBeenCalled();
    } finally { delete process.env.DECISION_GATE_CHECKER_ROUTE_DISABLED; }
    expect(mockRecordCheckerOutcome).not.toHaveBeenCalled();
  });

  it('an empty orchestrator finalize labels the decision failed (actual unknown), still acted:false', async () => {
    mockDecide.mockResolvedValue(shadowResult());
    (runCodingAgent as jest.Mock).mockResolvedValue({ finalText: '' });
    try {
      await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-n4-empty', sessionId: null });
      await waitFor(() => !isRunActive('chat:chat-n4-empty'));
      await waitFor(() => mockRecordCheckerOutcome.mock.calls.length > 0);
      expect(mockRecordCheckerOutcome).toHaveBeenCalledTimes(1);
      expect(mockRecordCheckerOutcome.mock.calls[0][2]).toMatchObject({ acted: false, failed: true });
    } finally {
      (runCodingAgent as jest.Mock).mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
    }
  });
});

describe('guest (anonymous) runs — title + liveness marker (owner report 2026-09-26)', () => {
  // "guest mode, chat title generation didn't work": the up-front title chain
  // was gated on userId && chatId, so a guest's sidebar row kept the raw first
  // message forever. A first guest turn now generates the same title with NO
  // DB write — shipped as 'chat-title' and echoed as autoTitle on 'complete'.
  // And a reload mid-answer lost the turn: the run now publishes a Redis
  // liveness marker (guest-session-run.ts) for the session-state endpoint.
  const EMPTY_CTX = { queryMessage: 'the question', systemContext: '', conversationHistory: [] as any[], projectId: null };
  const FULL_CTX = { queryMessage: 'the question', systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }] as any[], projectId: null };
  const genTitle = moonshotIntegration.generateTitle as jest.Mock;
  const buildCtx = buildChatQueryContext as jest.Mock;
  const SID = '0f1e2d3c-4b5a-4697-8877-665544332211';

  beforeEach(() => {
    genTitle.mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    buildCtx.mockResolvedValue(EMPTY_CTX);
  });
  afterEach(() => {
    buildCtx.mockResolvedValue(FULL_CTX);
  });

  async function runGuest(sessionId: string) {
    const key = await startDetachedChatRun({ ...BASE, userId: null, chatId: null, sessionId });
    expect(key).toBe(`chat:session:${sessionId}`);
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete' || e.type === 'error'));
    await waitFor(() => !isRunActive(key!));
    return events;
  }

  it("a guest's FIRST turn ships 'chat-title' + a non-null autoTitle on complete, with no DB title write", async () => {
    const events = await runGuest(SID);
    expect(genTitle).toHaveBeenCalledWith('the question', '');
    const titled = events.find(e => e.type === 'chat-title');
    expect(titled?.data).toEqual({ chatId: null, sessionId: SID, title: 'A Generated Title' });
    const complete = events.find(e => e.type === 'complete')!.data;
    expect(complete.autoTitle).toBe('A Generated Title');
    expect(complete.sessionId).toBe(SID);
    // Guests have no chat row: the CAS title write path must not run.
    expect(mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title)).toHaveLength(0);
  });

  it('a later guest turn (non-empty session history) generates no title', async () => {
    buildCtx.mockResolvedValue(FULL_CTX);
    const events = await runGuest('1f1e2d3c-4b5a-4697-8877-665544332211');
    expect(genTitle).not.toHaveBeenCalled();
    expect(events.find(e => e.type === 'chat-title')).toBeUndefined();
    expect(events.find(e => e.type === 'complete')!.data.autoTitle).toBeNull();
  });

  it('an empty title from the chain leaves autoTitle null (the client keeps its placeholder)', async () => {
    genTitle.mockResolvedValueOnce('');
    const events = await runGuest('3f1e2d3c-4b5a-4697-8877-665544332211');
    expect(events.find(e => e.type === 'chat-title')).toBeUndefined();
    expect(events.find(e => e.type === 'complete')!.data.autoTitle).toBeNull();
  });

  it('publishes the cross-process liveness marker for the session while the run is live and clears it at the end', async () => {
    const sessionId = '4f1e2d3c-4b5a-4697-8877-665544332211';
    const marker = `cm_session_run:${sessionId}`;
    // Hold the run open on the agent mock so the marker is observable mid-run.
    let release: (() => void) | null = null;
    (runCodingAgent as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ finalText: 'A'.repeat(500) }); }));
    const key = await startDetachedChatRun({ ...BASE, userId: null, chatId: null, sessionId });
    expect(key).toBe(`chat:session:${sessionId}`);
    expect(redisStore.has(marker)).toBe(true); // written BEFORE the run starts (awaited in startDetachedChatRun)
    await waitFor(() => release !== null);
    release!();
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !redisStore.has(marker)); // the finally clears it
  });

  it('a chat run (chatId) writes no guest marker', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-no-guest-marker', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    expect([...redisStore.keys()].some(k => k.startsWith('cm_session_run:'))).toBe(false);
  });
});


// ── TURN CONTINUATION (cohesive-chat wave 2026-09-28; turn-continuation.ts + task-events.ts) ──
// The owner's real "say the word" hand-back replayed through the REAL finalize:
// the closing is rewritten, a schedule-source pending row carrying the
// continuation stash is enqueued (the finally's drain starts it), the task card
// rides the stream + the row; a continuation round posts a NEW assistant
// message and flips the card to done; the cap holds; a waiting_user question
// and a machine wake are left alone; the kill switch restores today.
describe('turn continuation (2026-09-28)', () => {
  const OWNER_IMESSAGE = `I pulled the threads before tools cut off this run. Here is what I found:\n\n- Mum: asked whether Sunday works.\n- Dave: sent the invoice PDF.\n\nI did not get to her thread — say the word and I will search her thread next.`;
  const CONT_LINE = 'Still working on this — I will post the result here.';
  const created: any[] = [];
  const updated: any[] = [];
  const pendingCreated: any[] = [];
  let rowSeq = 0;
  const originalCreate = mockPrisma.crossModelMessage.create;
  const originalPendingCreate = mockPrisma.pendingChatMessage.create;

  // The ORIGINAL row of the task (the human turn's answer) — per test.
  let origRow: () => any | null = () => ({ id: 'orig-row', chatId: 'chat-cont-2', role: 'assistant', content: `partial\n\n${CONT_LINE}`, parts: [{ type: 'text', text: 'partial' }], metadata: { task: { taskId: 't1', status: 'running' } } });
  const knownRow = (id: string) => created.find((r) => r.id === id) ?? (id === 'orig-row' ? origRow() : null);
  /** The merged task-events persist (cohesive/integration): the anchor is findFirst
   *  scoped { id, chatId, role:'assistant' }, the carrier scan is findMany role 'assistant'. */
  const assistantScan = (chatId: string) => {
    const rows = created.filter((r) => r.chatId === chatId && r.role === 'assistant').reverse();
    const orig = origRow();
    return orig && orig.chatId === chatId ? [...rows, orig] : rows;
  };
  const installTaskRowLookup = () => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async ({ where }: any) => knownRow(where.id));
    mockPrisma.crossModelMessage.findFirst = jest.fn(async ({ where }: any) => {
      if (!where?.id) return null;
      const r = knownRow(where.id);
      return r && (!where.chatId || r.chatId === where.chatId) && (!where.role || r.role === where.role) ? r : null;
    });
    mockPrisma.crossModelMessage.findMany = jest.fn(async ({ where }: any) => (where?.role === 'assistant' ? assistantScan(where.chatId) : []));
  };

  beforeEach(() => {
    created.length = 0; updated.length = 0; pendingCreated.length = 0; rowSeq = 0;
    mockRecordLoopMetric.mockClear();
    mockPrisma.crossModelMessage.create = jest.fn(async ({ data }: any) => { const row = { id: data.id ?? `row-${++rowSeq}`, createdAt: new Date(), ...data }; created.push(row); return row; });
    origRow = () => ({ id: 'orig-row', chatId: 'chat-cont-2', role: 'assistant', content: `partial\n\n${CONT_LINE}`, parts: [{ type: 'text', text: 'partial' }], metadata: { task: { taskId: 't1', status: 'running' } } });
    installTaskRowLookup();
    mockPrisma.crossModelMessage.update = jest.fn(async (a: any) => { updated.push(a); return {}; });
    mockPrisma.pendingChatMessage.create = jest.fn(async (a: any) => { const row = { id: `pend-${pendingCreated.length + 1}`, ...a.data }; pendingCreated.push(row); return row; });
    delete process.env.TURN_CONTINUATION_DISABLED;
    delete process.env.CONTINUATION_MAX_ROUNDS;
  });
  afterAll(() => {
    mockPrisma.crossModelMessage.create = originalCreate;
    mockPrisma.pendingChatMessage.create = originalPendingCreate;
    delete mockPrisma.crossModelMessage.findUnique;
    delete mockPrisma.crossModelMessage.findFirst;
    delete mockPrisma.crossModelMessage.findMany;
    delete mockPrisma.crossModelMessage.update;
  });

  async function runAndCollect(args: any) {
    const events: Array<{ type: string; data: any }> = [];
    const key = await startDetachedChatRun(args);
    expect(key).toBe(`chat:${args.chatId}`);
    subscribeRun(key!, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'complete' || e.type === 'error'));
    await waitFor(() => !isRunActive(key!));
    return events;
  }

  it('a HUMAN turn that hands the task back: closing rewritten, r1/3 queued with the stash, task card running on the row + the stream', async () => {
    const withChips = `${OWNER_IMESSAGE}\n\n[FOLLOWUPS]\n- Search her thread now\n[/FOLLOWUPS]`;
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: withChips, parts: [{ type: 'text', text: withChips }], receipts: [{ ok: true }], deadlineHit: true });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-1', sessionId: null, message: 'find the thread from Anna', mode: 'single_thinking', messageOrigin: 'user', userTurnAt: new Date() });
    // (b) the persisted answer keeps the partial, drops the offer, ends with the one line — content AND parts.
    const assistant = created.find((r) => r.role === 'assistant');
    expect(assistant.content.endsWith(CONT_LINE)).toBe(true);
    expect(assistant.content).not.toMatch(/say the word/i);
    expect(assistant.content).toContain('Mum: asked whether Sunday works.');
    expect(assistant.parts.some((p: any) => p.type === 'text' && p.text.endsWith(CONT_LINE) && !/say the word/i.test(p.text))).toBe(true);
    // (a) one schedule-source pending row of the SAME chat carrying the r1/3 prompt + the stash (Redis side-channel).
    expect(pendingCreated).toHaveLength(1);
    expect(pendingCreated[0]).toMatchObject({ chatId: 'chat-cont-1', userId: 'u1', source: 'schedule', mode: 'single_thinking' });
    expect(pendingCreated[0].content).toMatch(/^\[HARNESS CONTINUATION r1\/3 task=[0-9a-f-]{36} of=/);
    expect(pendingCreated[0].content).toContain('Original ask: "find the thread from Anna"');
    const stash = JSON.parse(redisStore.get('chat:pendingorigin:pend-1')!);
    expect(stash).toMatchObject({ kind: 'schedule', continuation: { round: 1, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: assistant.id, askText: 'find the thread from Anna' } });
    // Review fix 1: a rewritten answer carries no follow-up chips and no Dig-deeper chip (the model's chip would double-run the offered work).
    expect(assistant.metadata.followUps).toBeUndefined();
    expect(assistant.metadata.chips).toBeUndefined();
    expect(events.find((e) => e.type === 'followups')).toBeUndefined();
    // (c) the task event on the stream + persisted on the row; the complete payload swaps the live text.
    const task = events.find((e) => e.type === 'task');
    expect(task?.data).toMatchObject({ taskId: stash.continuation.taskId, chatId: 'chat-cont-1', kind: 'continuation', status: 'running', title: 'Finishing your task', receipts: { ok: 1, total: 1 }, artifacts: [] });
    const card = updated.find((u) => u.where.id === assistant.id);
    expect(card.data.parts.some((p: any) => p.type === 'task' && p.task.status === 'running')).toBe(true);
    expect(card.data.metadata.task).toMatchObject({ taskId: stash.continuation.taskId, status: 'running' });
    expect(events.find((e) => e.type === 'complete')!.data.finalText.endsWith(CONT_LINE)).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ chatId: 'chat-cont-1', round: 1, reason: 'deadline_mid_task', outcome: 'armed' }) }));
  });

  it('(d) a continuation round posts its answer as a NEW assistant row (no user row, no machine origin) and flips the card to done', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: "Found it: Anna's thread has the trip form due Friday — she asked for the signed copy.", parts: [{ type: 'text', text: 'Found it.' }], receipts: [] });
    const cont = { taskId: 't1', round: 1, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: 'orig-row', startedAt: '2026-09-28T00:00:00.000Z', askText: 'find the thread from Anna' };
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-2', sessionId: null, message: '[HARNESS CONTINUATION r1/3] resume', mode: 'single_thinking', messageOrigin: 'schedule', continuation: cont });
    expect(created.filter((r) => r.role === 'user')).toHaveLength(0);
    const result = created.find((r) => r.role === 'assistant');
    expect(result.content).toContain("Anna's thread has the trip form due Friday");
    expect(result.metadata).toMatchObject({ kind: 'continuation_result', continuation: { taskId: 't1', round: 1, ofMessageId: 'orig-row' } });
    expect(result.metadata.origin).toBeUndefined();
    expect(pendingCreated).toHaveLength(0);
    const task = events.find((e) => e.type === 'task');
    expect(task?.data).toMatchObject({ taskId: 't1', status: 'done', resultMessageId: result.id });
    const card = updated.find((u) => u.where.id === 'orig-row');
    expect(card.data.metadata.task).toMatchObject({ taskId: 't1', status: 'done', resultMessageId: result.id });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ round: 1, outcome: 'posted' }) }));
  });

  it('the cap holds: round 3/3 ending in another offer arms nothing, posts the partial with the cap line, card done', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: OWNER_IMESSAGE, parts: [{ type: 'text', text: OWNER_IMESSAGE }], receipts: [] });
    const cont = { taskId: 't1', round: 3, maxRounds: 3, reason: 'offer_to_continue', ofMessageId: 'orig-row', startedAt: '2026-09-28T00:00:00.000Z', askText: 'ask' };
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-2', sessionId: null, message: '[HARNESS CONTINUATION r3/3] resume', mode: 'single_thinking', messageOrigin: 'schedule', continuation: cont });
    expect(pendingCreated).toHaveLength(0);
    const result = created.find((r) => r.role === 'assistant');
    expect(result.content).toMatch(/automatic continuation budget/);
    expect(result.content).not.toMatch(/say the word/i);
    expect(events.find((e) => e.type === 'task')?.data).toMatchObject({ taskId: 't1', status: 'done', note: expect.stringMatching(/budget/) });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ round: 3, outcome: 'cap' }) }));
  });

  it('a round that ends in a genuine question ⇒ card waiting_user, nothing armed, the question stays', async () => {
    const q = 'I found two Xero orgs. Which account should I pull the invoices from — Sunday Market or CQL?';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: q, parts: [{ type: 'text', text: q }], receipts: [] });
    const cont = { taskId: 't1', round: 1, maxRounds: 3, reason: 'offer_to_continue', ofMessageId: 'orig-row', startedAt: '2026-09-28T00:00:00.000Z', askText: 'ask' };
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-2', sessionId: null, message: '[HARNESS CONTINUATION r1/3] resume', mode: 'single_thinking', messageOrigin: 'schedule', continuation: cont });
    expect(pendingCreated).toHaveLength(0);
    expect(created.find((r) => r.role === 'assistant').content).toBe(q);
    expect(events.find((e) => e.type === 'task')?.data).toMatchObject({ taskId: 't1', status: 'waiting_user', note: expect.stringMatching(/Which account/) });
  });

  it('a HUMAN turn ending in a credentials question is left alone (no rewrite, no queue, no card)', async () => {
    const q = 'I need the login credentials for the Xero account before I can pull the invoices — can you share them?';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: q, parts: [{ type: 'text', text: q }], receipts: [], deadlineHit: true });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-3', sessionId: null, message: 'pull the invoices', mode: 'single_thinking', messageOrigin: 'user' });
    expect(pendingCreated).toHaveLength(0);
    expect(created.find((r) => r.role === 'assistant').content).toBe(q);
    expect(events.some((e) => e.type === 'task')).toBe(false);
  });

  // ── Review fixes (same wave) ──────────────────────────────────────────────
  it('fix 1: a COMPLETE answer ending in the doctrine offer is delivered as-is — no rewrite, no queue, no card, chips kept', async () => {
    const complete = 'Bitcoin is at $118,400 this morning, up 2% on the day.\n\nWant me to check this again tomorrow morning and message you on Telegram?\n\n[FOLLOWUPS]\n- Check again tomorrow and message me on Telegram\n[/FOLLOWUPS]';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: complete, parts: [{ type: 'text', text: complete }], receipts: [] });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-6', sessionId: null, message: 'bitcoin price', mode: 'single_thinking', messageOrigin: 'user' });
    expect(pendingCreated).toHaveLength(0);
    const assistant = created.find((r) => r.role === 'assistant');
    expect(assistant.content).toMatch(/Want me to check this again tomorrow/);
    expect(assistant.content).not.toContain(CONT_LINE);
    expect(assistant.metadata.followUps).toEqual(['Check again tomorrow and message me on Telegram']);
    expect(events.some((e) => e.type === 'task')).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation' }));
  });

  it('fix 2: the deck "confirm the card" hand-back on a HUMAN turn arms NOTHING — the answer keeps its pointer to the card and the task card reads waiting_user', async () => {
    const deck = 'I have set up the deck build as a coding session with the brief below (12 slides).\n\nDeck build is staged and waiting on your one click — confirm the card and I will start it.';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: deck, parts: [{ type: 'text', text: deck }], receipts: [{ ok: false }] });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-7', sessionId: null, message: 'build me the Q3 deck', mode: 'single_thinking', messageOrigin: 'user', userTurnAt: new Date() });
    expect(pendingCreated).toHaveLength(0);
    const assistant = created.find((r) => r.role === 'assistant');
    expect(assistant.content).toBe(deck); // byte-identical — the confirmation pointer stands
    const task = events.find((e) => e.type === 'task');
    expect(task?.data).toMatchObject({ chatId: 'chat-cont-7', kind: 'continuation', status: 'waiting_user', note: expect.stringMatching(/confirm the card/i) });
    expect(events.find((e) => e.type === 'complete')!.data.finalText).toBeUndefined(); // no live swap — nothing was rewritten
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ reason: 'confirmation_handback', outcome: 'waiting_user', rewrote: false }) }));
  });

  it('fix 6: a continuation round the user STOPS settles the card as waiting_user with the stopped line — never "finished"', async () => {
    const { cancelRun } = jest.requireActual('../coding/live-runs') as typeof import('../coding/live-runs');
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => { cancelRun('chat:chat-cont-2'); return { finalText: 'Partial: read one thread.', parts: [{ type: 'text', text: 'Partial: read one thread.' }], receipts: [] }; });
    const cont = { taskId: 't1', round: 1, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: 'orig-row', startedAt: '2026-09-28T00:00:00.000Z', askText: 'find the thread from Anna' };
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-2', sessionId: null, message: '[HARNESS CONTINUATION r1/3] resume', mode: 'single_thinking', messageOrigin: 'schedule', continuation: cont });
    expect(pendingCreated).toHaveLength(0);
    const task = events.find((e) => e.type === 'task');
    expect(task?.data).toMatchObject({ taskId: 't1', status: 'waiting_user', note: 'Stopped before it finished — send a message to resume.' });
    expect(task?.data.status).not.toBe('done');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ round: 1, outcome: 'stopped' }) }));
  });

  it('fix 5: a round that would re-arm is SUPERSEDED when the user sent a newer message since the task started — nothing armed, card waiting_user, no "finished"', async () => {
    mockPrisma.crossModelMessage.findMany = jest.fn(async ({ where }: any) => (where?.role === 'user' && where?.createdAt?.gt ? [{ id: 'user-newer', metadata: null }] : where?.role === 'assistant' ? assistantScan(where.chatId) : []));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: OWNER_IMESSAGE, parts: [{ type: 'text', text: OWNER_IMESSAGE }], receipts: [], deadlineHit: true });
    const cont = { taskId: 't1', round: 1, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: 'orig-row', startedAt: '2026-09-28T00:00:00.000Z', askText: 'ask' };
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-2', sessionId: null, message: '[HARNESS CONTINUATION r1/3] resume', mode: 'single_thinking', messageOrigin: 'schedule', continuation: cont });
    installTaskRowLookup();
    expect(pendingCreated).toHaveLength(0);
    const result = created.find((r) => r.role === 'assistant');
    expect(result.content).toMatch(/say the word/i); // the partial posts as-is; the user's own turn owns the ask
    expect(events.find((e) => e.type === 'task')?.data).toMatchObject({ taskId: 't1', status: 'waiting_user', note: expect.stringMatching(/newer message took over/) });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ outcome: 'superseded', supersededBy: 'row' }) }));
  });

  it('fix 4: a queued continuation row whose Redis stash is LOST drains as a continuation rebuilt from the marker — never as a machine wake', async () => {
    const prompt = '[HARNESS CONTINUATION r1/3 task=t-lost of=orig-row reason=deadline_mid_task since=2026-09-28T00:00:00.000Z] — not typed by the user. Resume.\n\nOriginal ask: "find the thread from Anna"';
    let served = false;
    mockPrisma.pendingChatMessage.findFirst = jest.fn(async () => (served ? null : (served = true, { id: 'pend-lost', chatId: 'chat-cont-8', userId: 'u1', content: prompt, mode: 'single_thinking', source: 'schedule', uploadIds: null, createdAt: new Date() })));
    origRow = () => ({ id: 'orig-row', chatId: 'chat-cont-8', role: 'assistant', content: 'partial', parts: [{ type: 'text', text: 'partial' }], metadata: { task: { taskId: 't-lost', status: 'running' } } });
    installTaskRowLookup();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Found it.', parts: [{ type: 'text', text: 'Found it.' }], receipts: [] });
    const { drainChatQueue } = await import('./chat-agent.service');
    const events: Array<{ type: string; data: any }> = [];
    const started = await drainChatQueue('chat-cont-8', 'u1');
    expect(started).toBe(true);
    subscribeRun('chat:chat-cont-8', (e) => events.push(e));
    await waitFor(() => !isRunActive('chat:chat-cont-8'));
    mockPrisma.pendingChatMessage.findFirst = jest.fn(async () => null);
    const result = created.find((r) => r.role === 'assistant');
    expect(result.metadata).toMatchObject({ kind: 'continuation_result', continuation: { taskId: 't-lost', round: 1, ofMessageId: 'orig-row' } });
    expect(result.metadata.origin).toBeUndefined();
    expect(result.content).not.toMatch(/MACHINE-TRIGGERED|freshness/i);
    expect(created.filter((r) => r.role === 'user')).toHaveLength(0);
    const card = updated.find((u) => u.where.id === 'orig-row');
    expect(card.data.metadata.task).toMatchObject({ taskId: 't-lost', status: 'done', resultMessageId: result.id });
  });

  it('fix 5 (drain): a queued continuation row is DROPPED and its card settled when a user row newer than the task exists', async () => {
    const prompt = '[HARNESS CONTINUATION r2/3 task=t-sup of=orig-row reason=offer_to_continue since=2026-09-28T00:00:00.000Z] — not typed by the user. Resume.';
    const deleted: string[] = [];
    mockPrisma.pendingChatMessage.findFirst = jest.fn(async () => (deleted.length ? null : { id: 'pend-sup', chatId: 'chat-cont-9', userId: 'u1', content: prompt, mode: 'single_thinking', source: 'schedule', uploadIds: null, createdAt: new Date() }));
    const originalDelete = mockPrisma.pendingChatMessage.delete;
    mockPrisma.pendingChatMessage.delete = jest.fn(async ({ where }: any) => { deleted.push(where.id); return {}; });
    origRow = () => ({ id: 'orig-row', chatId: 'chat-cont-9', role: 'assistant', content: 'partial', parts: [], metadata: { task: { taskId: 't-sup', status: 'running' } } });
    installTaskRowLookup();
    mockPrisma.crossModelMessage.findMany = jest.fn(async ({ where }: any) => (where?.role === 'user' ? [{ id: 'user-newer', metadata: { origin: 'user' } }] : where?.role === 'assistant' ? assistantScan(where.chatId) : []));
    const { drainChatQueue } = await import('./chat-agent.service');
    const started = await drainChatQueue('chat-cont-9', 'u1');
    mockPrisma.pendingChatMessage.findFirst = jest.fn(async () => null);
    mockPrisma.pendingChatMessage.delete = originalDelete;
    installTaskRowLookup();
    expect(started).toBe(false); // nothing ran
    expect(deleted).toEqual(['pend-sup']);
    expect(runCodingAgent).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-cont-9' }));
    const card = updated.find((u) => u.where.id === 'orig-row');
    expect(card.data.metadata.task).toMatchObject({ taskId: 't-sup', status: 'waiting_user' });
    expect(card.data.parts.some((p: any) => p.type === 'task' && /newer message took over/.test(p.task.note))).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation', meta: expect.objectContaining({ taskId: 't-sup', round: 2, outcome: 'superseded', supersededBy: 'row' }) }));
  });

  it('machine wakes never auto-continue; TURN_CONTINUATION_DISABLED=1 restores today byte-for-byte', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: OWNER_IMESSAGE, parts: [{ type: 'text', text: OWNER_IMESSAGE }], receipts: [] });
    await runAndCollect({ userId: 'u1', chatId: 'chat-cont-4', sessionId: null, message: 'sweep', mode: 'single_thinking', messageOrigin: 'schedule', machineWake: true });
    expect(pendingCreated).toHaveLength(0);
    expect(created.find((r) => r.role === 'assistant').content).toMatch(/say the word/i);
    process.env.TURN_CONTINUATION_DISABLED = '1';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: OWNER_IMESSAGE, parts: [{ type: 'text', text: OWNER_IMESSAGE }], receipts: [] });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-cont-5', sessionId: null, message: 'find the thread', mode: 'single_thinking', messageOrigin: 'user' });
    expect(pendingCreated).toHaveLength(0);
    expect(created.filter((r) => r.role === 'assistant').pop().content).toMatch(/say the word/i);
    expect(events.some((e) => e.type === 'task')).toBe(false);
  });

  // ── cohesive/integration: the SESSION task card at spawn (one lifecycle in the chat that asked) ──
  const SPAWN_ENVELOPE = JSON.stringify({ ok: true, tool: 'start_coding_session', ids: { sessionId: 'sess-deck-1', projectId: 'p1', branch: 'digby/session-sess-deck-1' }, message: 'Started coding session sess-deck-1 "CQL DGX B300 deck" on branch digby/session-sess-deck-1 (base main, model glm-5.3, permissions auto). It is provisioning now. Executed directly on the user\'s own ask — NO confirmation card exists or is pending.' });
  const SPAWN_ANSWER = 'The deck build has started ("CQL DGX B300 deck") — its progress shows on the task card in this chat and the result is posted here when it lands.';
  const spawnParts = () => [{ type: 'tool_call', name: 'start_coding_session' }, { type: 'tool_result', name: 'start_coding_session', result: SPAWN_ENVELOPE }, { type: 'text', text: SPAWN_ANSWER }];

  it('a HUMAN turn that spawned a sub-session persists the running SESSION card on its answer row + the stream; the closing is not a hand-back (no continuation armed)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: SPAWN_ANSWER, parts: spawnParts(), receipts: [{ ok: true }] });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-spawn-1', sessionId: null, message: 'build me the DGX B300 deck', mode: 'single_thinking', messageOrigin: 'user', userTurnAt: new Date() });
    const assistant = created.find((r) => r.role === 'assistant');
    expect(assistant.content).toBe(SPAWN_ANSWER); // no rewrite — the answer says the work started
    expect(pendingCreated).toHaveLength(0); // nothing to continue
    const card = updated.find((u) => u.where.id === assistant.id);
    expect(card.data.parts.filter((p: any) => p.type === 'task')).toHaveLength(1);
    expect(card.data.parts.find((p: any) => p.type === 'task').task).toMatchObject({ taskId: 'session:sess-deck-1', chatId: 'chat-spawn-1', childChatId: 'sess-deck-1', kind: 'session', status: 'running', title: 'CQL DGX B300 deck' });
    expect(card.data.metadata.task).toMatchObject({ taskId: 'session:sess-deck-1', kind: 'session', status: 'running', childChatId: 'sess-deck-1' });
    const task = events.find((e) => e.type === 'task');
    expect(task?.data).toMatchObject({ taskId: 'session:sess-deck-1', kind: 'session', status: 'running', artifacts: [] });
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'turn_continuation' }));
  });

  it('a MACHINE wake\'s spawn gets no session card (a supervisor\'s lane is not a user task)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: SPAWN_ANSWER, parts: spawnParts(), receipts: [] });
    const machine = await runAndCollect({ userId: 'u1', chatId: 'chat-spawn-2', sessionId: null, message: 'sweep', mode: 'single_thinking', messageOrigin: 'schedule', machineWake: true });
    expect(machine.some((e) => e.type === 'task')).toBe(false);
    expect(updated.some((u) => Array.isArray(u.data?.parts) && u.data.parts.some((p: any) => p.type === 'task'))).toBe(false);
  });

  // ── Hand-off polish (2026-09-28, audit CT-2 / E17): the spawn turn ends after the spawn round; the hand-off row is THE result ──
  it('CT-2 (a): a HUMAN turn that spawned hands the agent loop the end-turn hook — it answers the notice once the spawn tool result streamed; spawn_turn_end is recorded', async () => {
    let hookBefore: unknown = 'unset';
    let hookAfter: unknown = 'unset';
    (runCodingAgent as jest.Mock).mockImplementationOnce(async (input: any) => {
      hookBefore = input.endTurnAfterToolRound?.() ?? null;                    // nothing spawned yet ⇒ no collapse
      input.emit('tool_call', { name: 'start_coding_session', args: '{}' });
      input.emit('tool_result', { name: 'start_coding_session', result: SPAWN_ENVELOPE }); // the spawn streams
      hookAfter = input.endTurnAfterToolRound?.() ?? null;                     // ⇒ the notice: finish now
      return { finalText: SPAWN_ANSWER, parts: spawnParts(), receipts: [{ ok: true }], stepsUsed: 2 };
    });
    await runAndCollect({ userId: 'u1', chatId: 'chat-spawn-4', sessionId: null, message: 'build me the deck', mode: 'single_thinking', messageOrigin: 'user', userTurnAt: new Date() });
    expect(hookBefore).toBeNull();
    expect(typeof hookAfter).toBe('string');
    expect(hookAfter as string).toContain('The sub-session "CQL DGX B300 deck" is running now');
    expect(hookAfter as string).toMatch(/Do not poll, wait for, or re-read the session/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'spawn_turn_end', meta: expect.objectContaining({ chatId: 'chat-spawn-4', childChatId: 'sess-deck-1', title: 'CQL DGX B300 deck', stepsUsed: 2 }) }));
    // the running card still lands on the answer row (the hand-off has not posted yet)
    const assistant = created.find((r) => r.role === 'assistant');
    expect(updated.find((u) => u.where.id === assistant.id).data.metadata.task).toMatchObject({ taskId: 'session:sess-deck-1', status: 'running' });
  });

  it('CT-2 (a): a MACHINE wake hands the loop NO end-turn hook', async () => {
    const hooks: unknown[] = [];
    const capture = async (input: any) => { hooks.push(input.endTurnAfterToolRound ?? null); return { finalText: SPAWN_ANSWER, parts: spawnParts(), receipts: [] }; };
    (runCodingAgent as jest.Mock).mockImplementationOnce(capture);
    await runAndCollect({ userId: 'u1', chatId: 'chat-spawn-5', sessionId: null, message: 'sweep', mode: 'single_thinking', messageOrigin: 'schedule', machineWake: true });
    expect(hooks).toEqual([null]);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'spawn_turn_end' }));
  });

  it('CT-2 (b) / E17: the hand-off ALREADY posted this session\'s result on the chat ⇒ the finalize persists NO running card on the newer answer row (the done card never regresses)', async () => {
    mockLatestHandoff.mockResolvedValueOnce({ runId: 'run-child-1', sessionId: 'sess-deck-1', targetChatId: 'chat-spawn-7', parentChatId: 'chat-spawn-7', postedAt: new Date().toISOString(), resultMessageId: 'result-row-1', artifacts: [{ name: 'deck.pdf', kind: 'file', bytes: 10, url: '/api/crossmodel/files/f1/download' }], files: 1, prs: 0, canvases: 0, bytes: 10, skippedTooLarge: 0, truncated: 0 });
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: SPAWN_ANSWER, parts: spawnParts(), receipts: [{ ok: true }] });
    const events = await runAndCollect({ userId: 'u1', chatId: 'chat-spawn-7', sessionId: null, message: 'build me the deck', mode: 'single_thinking', messageOrigin: 'user', userTurnAt: new Date() });
    expect(mockLatestHandoff).toHaveBeenCalledWith('sess-deck-1');
    const assistant = created.find((r) => r.role === 'assistant');
    expect(assistant.content).toBe(SPAWN_ANSWER);
    expect(updated.some((u) => u.where.id === assistant.id && Array.isArray(u.data?.parts) && u.data.parts.some((p: any) => p.type === 'task'))).toBe(false);
    expect(events.some((e) => e.type === 'task' && e.data?.status === 'running')).toBe(false);
    // the record targets ANOTHER chat ⇒ the running card is still owed here
    mockLatestHandoff.mockResolvedValueOnce({ runId: 'run-child-1', sessionId: 'sess-deck-1', targetChatId: 'chat-elsewhere', parentChatId: 'chat-elsewhere', postedAt: new Date().toISOString(), resultMessageId: 'result-row-2', artifacts: [], files: 0, prs: 0, canvases: 0, bytes: 0, skippedTooLarge: 0, truncated: 0 });
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: SPAWN_ANSWER, parts: spawnParts(), receipts: [{ ok: true }] });
    await runAndCollect({ userId: 'u1', chatId: 'chat-spawn-8', sessionId: null, message: 'build me the deck', mode: 'single_thinking', messageOrigin: 'user', userTurnAt: new Date() });
    const assistant8 = created.filter((r) => r.role === 'assistant').at(-1);
    expect(updated.find((u) => u.where.id === assistant8.id).data.metadata.task).toMatchObject({ taskId: 'session:sess-deck-1', status: 'running' });
  });
});

// 2026-10-06: the supervisor no-checker kill switch never leaks between tests.
afterEach(() => { delete process.env.SUPERVISOR_CHECKER_SKIP_DISABLED; });

describe('build 2026-10-08 Q-3 — machine-wake clock package at the seam', () => {
  // REPLAY (prod strike 2026-09-27 12:10Z, Fleet Supervisor c0e22e36 — the ONE real fabricated clock of 33):
  // "**Fleet wake — 6:33 AM PDT: …**" written at 5:08 AM PDT. Rendered here as a Z clock 85 min ahead of
  // the real clock so the test is DST-free.
  const zClock = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'assistant');
  beforeEach(() => {
    mockGuardMachineWakeFinalAnswer.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
  });
  afterEach(() => {
    delete process.env.FUTURE_CLOCK_REPLACE_ENABLED;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('an AHEAD headline clock is corrected from the server clock BEFORE the guard; the committed note carries the real clock; one owner_answer_clock_stamped row (direction ahead)', async () => {
    const ahead = zClock(new Date(Date.now() + 85 * 60_000));
    const note = `**Fleet wake — ${ahead}: tt-rd bisect runner went idle → nudged; CanLaw V15 training stable**\n\n- nothing needs the owner.`;
    (runCodingAgent as jest.Mock).mockClear();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: [{ type: 'text', text: note }], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-q3-ahead', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-q3-ahead'));
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
    const guarded = mockGuardMachineWakeFinalAnswer.mock.calls[0][0].finalText as string;
    expect(guarded).not.toContain(ahead);
    expect(guarded).toMatch(/^\*\*Fleet wake — \d{2}:\d{2}Z: tt-rd bisect runner/);
    expect(assistantWrites()[0].content).not.toContain(ahead);
    const row = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.kind === 'owner_answer_clock_stamped');
    expect(row).toBeDefined();
    expect(row.meta).toMatchObject({ direction: 'ahead', surface: 'machine_wake', from: ahead, supervisorScope: 'fleet' });
    expect(row.value).toBeGreaterThanOrEqual(-86);
    expect(row.value).toBeLessThanOrEqual(-84);
  });

  it('the guard clock verdict is recorded once per pass as future_clock_verdict', async () => {
    const note = '- **Owner card verified OPEN** via fresh pull — still the one live gate (school hours 9:00 AM PDT)';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: '', struck: false, audited: true, phantoms: [],
      clockVerdict: { outcome: 'observed', legacy: false, hits: [{ token: '9:00 AM PDT', minutesAhead: 526, line: note, verdict: 'not_observation' }] },
    }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-q3-verdict', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-q3-verdict'));
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'future_clock_verdict');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'chat-q3-verdict', value: 0, meta: { outcome: 'observed', pass: 1, legacy: false, supervisorScope: 'fleet' } });
    expect(assistantWrites()[0].content).toBe(note);
  });

  it('kill switch FUTURE_CLOCK_REPLACE_ENABLED=1: no headline restamp (the legacy lane)', async () => {
    process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1';
    const ahead = zClock(new Date(Date.now() + 85 * 60_000));
    const note = `**Fleet wake — ${ahead}: lanes idle**`;
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: [], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-q3-legacy', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-q3-legacy'));
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0].finalText).toBe(note);
    expect(mockRecordLoopMetric.mock.calls.some((c: any[]) => c[0]?.kind === 'owner_answer_clock_stamped')).toBe(false);
  });
});

// ── 2026-10-20: a plain user-space chat neither reads nor writes the hidden space's project memory ──
describe('user-space chat isolation — the flag from the context reaches the tool loop and the memory pipeline', () => {
  const { updateContextAsync } = jest.requireMock('../langgraph/memory.graph') as { updateContextAsync: jest.Mock };
  const buildCtx = buildChatQueryContext as jest.Mock;
  const CTX = { queryMessage: 'the question', systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }] as any[], projectId: 'userspace' };
  afterEach(() => { buildCtx.mockResolvedValue({ ...CTX, projectId: null }); });

  it('isolated: runCodingAgent gets projectMemoryIsolated and updateContextAsync gets skipProjectState', async () => {
    buildCtx.mockResolvedValue({ ...CTX, projectMemoryIsolated: true });
    (runCodingAgent as jest.Mock).mockClear(); updateContextAsync.mockClear();
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-us-iso', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-us-iso'));
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'userspace', projectMemoryIsolated: true });
    expect(updateContextAsync).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'userspace', skipProjectState: true }));
  });

  it('not isolated (a real project): neither flag is set', async () => {
    buildCtx.mockResolvedValue({ ...CTX, projectMemoryIsolated: false });
    (runCodingAgent as jest.Mock).mockClear(); updateContextAsync.mockClear();
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-us-real', sessionId: null });
    await waitFor(() => !isRunActive('chat:chat-us-real'));
    expect((runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0].projectMemoryIsolated).toBeUndefined();
    expect(updateContextAsync.mock.calls.at(-1)?.[0].skipProjectState).toBeUndefined();
  });
});

describe('harness receipts seam (HARNESS-RECEIPTS-AND-CLAIMS, supervisor SOTA round 3, 2026-10-20)', () => {
  const LANE = '9e39ec5c-0b5a-4bd8-8a0b-5a1ff0a1b2c3';
  const R1 = 'd24c4c9b-1111-4222-8333-444455556666';
  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'assistant');
  const harnessRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'supervisor_harness_receipts');

  beforeEach(() => {
    delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED; // the seam under test is ON (its default)
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear();
    mockGuardMachineWakeFinalAnswer.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
  });
  afterEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  const runWake = async (chatId: string, result: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce(result);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId, sessionId: null, machineWake: true, messageOrigin: 'hook', ...extra });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive(`chat:${chatId}`));
    return events;
  };

  it('the model-typed ACTIONS TAKEN block (wrong-tool id) is replaced by the harness record; metadata.harnessActions + one metric row; complete carries the text', async () => {
    const events = await runWake('chat-harness-acted', {
      finalText: 'Steered the eval lane toward the fix.\n\nACTIONS TAKEN\n- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
      parts: [
        { type: 'tool_call', name: 'send_chat_message', args: { chatId: LANE, content: 'steer' } },
        { type: 'tool_result', name: 'send_chat_message', result: JSON.stringify({ ok: true, ids: { chatId: LANE }, receiptId: R1 }) },
        { type: 'text', text: 'Steered the eval lane toward the fix.\n\nACTIONS TAKEN\n- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167' },
      ],
      receipts: [{ id: R1, tool: 'send_chat_message', ok: true, ids: { chatId: LANE } }],
    });
    const row = assistantWrites()[0];
    expect(row.content).toBe('Steered the eval lane toward the fix.\n\nACTIONS TAKEN (harness):\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b');
    expect(row.metadata).toMatchObject({ harnessActions: 1, harnessReceipts: { v: 1, mode: 'actions', reportUps: 0, notExecuted: 0 } });
    expect(row.metadata.harnessReceipts.modelBlockLines).toBeGreaterThanOrEqual(2);
    // The persisted parts carry the stripped model text + the harness block, never the model's block.
    const texts = (row.parts as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    expect(texts).not.toContain('9c307167');
    expect(texts).toContain('ACTIONS TAKEN (harness):');
    // The pre-delivery guard audited the MODEL's words without its copied block.
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0].finalText).not.toContain('9c307167');
    expect(harnessRows()).toHaveLength(1);
    expect(harnessRows()[0]).toMatchObject({ sessionId: 'chat-harness-acted', value: 1, meta: { mode: 'actions', harnessActions: 1, tools: ['send_chat_message'], seat: 'supervisor' } });
    const complete = events.find(e => e.type === 'complete')!;
    expect(complete.data.finalText).toBe(row.content);
  });

  it('a zero-call narration closes with the harness no-op line; a note already closing no-op is left as written', async () => {
    await runWake('chat-harness-noop', { finalText: 'All lanes look healthy; nothing to steer.', parts: [], receipts: [] });
    expect(assistantWrites()[0].content).toBe('All lanes look healthy; nothing to steer.\n\nWAKE: no-op (harness: 0 lane actions)');
    expect(assistantWrites()[0].metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'noop' } });
    mockPrisma.crossModelMessage.create.mockClear();
    await runWake('chat-harness-noop2', { finalText: 'WAKE: no-op — nothing moved on any project since the previous wake', parts: [], receipts: [] });
    expect(assistantWrites()[0].content).toBe('WAKE: no-op — nothing moved on any project since the previous wake');
    expect(assistantWrites()[0].metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'noop_present' } });
  });

  it('a guard-STRUCK note keeps the replacement wrapper byte-identical — the harness record rides the metadata only', async () => {
    process.env.ACTION_VERIFIER_ENFORCE = '1';
    try {
      const wrapper = "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]\nStruck.\n\n--- BEGIN STRUCK NOTE ---\n> Filed it.\n--- END STRUCK NOTE ---";
      // No rejectBackNotice ⇒ no re-orchestration: ONE orchestrator run, ONE guard pass.
      mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async () => ({ finalText: wrapper, notice: wrapper.split('\n')[0], struck: true, audited: true, phantoms: [{ kind: 'ticket', detail: 'filed it' }] }));
      await runWake('chat-harness-struck', { finalText: 'Filed it.', parts: [], receipts: [] });
      expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(1);
      expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(1);
      const row = assistantWrites()[assistantWrites().length - 1];
      expect(row.content).toBe(wrapper);
      expect(row.metadata).toMatchObject({ harnessActions: 0 });
      expect(harnessRows()[0]?.meta).toMatchObject({ struck: true });
    } finally {
      delete process.env.ACTION_VERIFIER_ENFORCE;
    }
  });

  it('a HUMAN turn on a supervisor chat is never touched (no strip, no append, no stamp)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'Here is the status.\n\nACTIONS TAKEN\n- none', parts: [], receipts: [] });
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-harness-human', sessionId: null, messageOrigin: 'user' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-harness-human'));
    // (the human-turn markdown repair may re-space the list — the model's block itself stays)
    expect(assistantWrites()[0].content).toMatch(/^Here is the status\.\n\nACTIONS TAKEN\n+- none$/);
    expect(assistantWrites()[0].content).not.toContain('(harness');
    expect(assistantWrites()[0].metadata.harnessActions).toBeUndefined();
    expect(harnessRows()).toHaveLength(0);
  });

  // Review fix (2026-10-20): the pre-delivery citation reject-back is a FULL orchestrator turn — what it
  // executes joins the harness record (attempt 1's calls really executed too), and its own model-typed
  // block gets phase 1's strip. Before the fix the record rendered from attempt 1 only: a zero-call
  // fabricated "Steered … (msg …)" whose retry REALLY sent the steer read 'WAKE: no-op (harness: 0 …)'.
  it('a citation-class reject-back retry that really sends: the harness record lists every attempt\'s executed calls', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    const R2 = '5e6f7a8b-1111-4222-8333-444455556666';
    const TODO = '7c1e5b9f-0000-4000-8000-000000000001';
    const retryNote = 'Steered the CanLaw lane toward the det-v2 rerun.\n\nACTIONS TAKEN\n- send_chat_message to CanLaw (receipt d24c4c9b)';
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({
        finalText: 'Steered the CanLaw lane (msg 1a2b3c4d).',
        parts: [
          { type: 'tool_call', name: 'todo_update', args: { id: TODO, status: 'in_progress' } },
          { type: 'tool_result', name: 'todo_update', result: JSON.stringify({ ok: true, ids: { todoId: TODO }, receiptId: R2 }) },
        ],
        receipts: [{ id: R2, tool: 'todo_update', ok: true, ids: { todoId: TODO } }],
      })
      .mockResolvedValueOnce({
        finalText: retryNote,
        parts: [
          { type: 'tool_call', name: 'send_chat_message', args: { chatId: LANE, content: 'rerun det-v2' } },
          { type: 'tool_result', name: 'send_chat_message', result: JSON.stringify({ ok: true, ids: { chatId: LANE }, receiptId: R1 }) },
          { type: 'text', text: retryNote },
        ],
        receipts: [{ id: R1, tool: 'send_chat_message', ok: true, ids: { chatId: LANE } }],
      });
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async () => ({
        finalText: 'REPLACED', notice: 'n', struck: true, audited: true,
        phantoms: [{ kind: 'message', detail: '[evidence citation] msg 1a2b3c4d', id: '1a2b3c4d' }],
        rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      }))
      .mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-harness-rejectback', sessionId: null, machineWake: true, messageOrigin: 'hook' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-harness-rejectback'));
    expect((runCodingAgent as jest.Mock).mock.calls).toHaveLength(2);
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    // Phase-1 parity on the retry: the second pass audits the retry's words WITHOUT its typed block.
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[1][0].finalText).not.toContain('ACTIONS TAKEN');
    const row = assistantWrites()[assistantWrites().length - 1];
    expect(row.content).toBe([
      'Steered the CanLaw lane toward the det-v2 rerun.',
      '',
      'ACTIONS TAKEN (harness):',
      '- todo_update → todo 7c1e5b9f · receipt 5e6f7a8b',
      '- send_chat_message → chat 9e39ec5c · receipt d24c4c9b',
    ].join('\n'));
    expect(row.metadata).toMatchObject({ harnessActions: 2, harnessReceipts: { mode: 'actions' } });
    expect(harnessRows()[0]).toMatchObject({ value: 2, meta: { rejectBackRetry: true, tools: ['todo_update', 'send_chat_message'] } });
  });

  it('the reject-back retry\'s strip counts start over: attempt 1\'s ACTIONS TAKEN list never words the retry\'s annotation', async () => {
    delete process.env.ACTION_VERIFIER_ENFORCE;
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: 'Steered the CanLaw lane (msg 1a2b3c4d).\n\nACTIONS TAKEN\n- steered CanLaw', parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: 'Lanes are steady; nothing to steer this wake.', parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async () => ({
        finalText: 'REPLACED', notice: 'n', struck: true, audited: true,
        phantoms: [{ kind: 'message', detail: '[evidence citation] msg 1a2b3c4d', id: '1a2b3c4d' }],
        rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify',
      }))
      .mockImplementationOnce(async (a: any) => ({ finalText: a.finalText, notice: '', struck: false, phantoms: [], audited: true }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-harness-rejectback-counts', sessionId: null, machineWake: true, messageOrigin: 'hook' });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete'));
    await waitFor(() => !isRunActive('chat:chat-harness-rejectback-counts'));
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[0][0].harnessStripped).toEqual({ block: true, copies: false });
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[1][0].harnessStripped).toBeUndefined();
  });

  // Review fix (2026-10-20): an OWNER-ARMED schedule firing is the owner's own digest (metadata.kind
  // owner_digest) — its 'ACTIONS TAKEN (last 24h)' section summarises the fleet; nothing is stripped or appended.
  it('an owner-armed digest firing is never rewritten — the harness record rides the metadata only', async () => {
    const digest = 'Daily digest — fleet\n\nACTIONS TAKEN (last 24h):\n- CanLaw lane merged PR #338\n- spark lane re-ran bench\n\n- Open: Hyperstack directive awaiting your wording\n\nWAKE: done';
    await runWake('chat-harness-digest', { finalText: digest, parts: [], receipts: [] }, { messageOrigin: 'schedule', scheduleOwnerArmed: true });
    const row = assistantWrites()[assistantWrites().length - 1];
    // (the markdown repair may re-space the list — every digest line stays)
    expect(row.content).toMatch(/ACTIONS TAKEN \(last 24h\):\n+- CanLaw lane merged PR #338\n- spark lane re-ran bench/);
    expect(row.content).toContain('- Open: Hyperstack directive awaiting your wording');
    expect(row.content).not.toContain('(harness');
    expect(row.content).not.toContain('Harness record');
    expect(row.metadata).toMatchObject({ kind: 'owner_digest', harnessActions: 0, harnessReceipts: { mode: 'record', textExempt: 'owner_digest', modelBlockLines: 0 } });
    expect(harnessRows()[0]).toMatchObject({ meta: { ownerDigest: true, mode: 'record' } });
  });

  // Review fixes (2026-10-20) — the harness appendix × the BRIEFING-UNVERIFIED-FILTER footnote, both ON.
  describe('with the unverified-claims footnote + the owner briefing (review fixes 2026-10-20)', () => {
    const FOOTNOTE_HEADER = '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]';
    const NOOP = 'WAKE: no-op (harness: 0 lane actions)';
    const CLAIMS_TRAILER = [
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]',
      'The typed claims block asserts 1 claim(s) with NO matching tool receipt in this run: pr 999.',
      'A claims-block entry is a completion claim — one without a receipt is treated as FABRICATED until re-verified with real tool calls.',
    ].join('\n');
    const observedPhantoms = (phantoms: any[]) => mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: `${a.finalText}\n\n[annotation the seam must not deliver for an action-class verdict]`, notice: 'n', struck: true, audited: true,
      phantoms, delivery: 'annotated', correction: 'c',
    }));
    beforeEach(() => {
      delete process.env.ACTION_VERIFIER_ENFORCE;
      mockGenerateOwnerBriefing.mockClear();
    });
    const settleBriefing = () => new Promise((r) => setTimeout(r, 30)); // the briefing's dynamic import settles

    it('[0] a zero-tool free-form dispatch claim: the briefing gets the MODEL\'s note only — never the harness no-op line that briefed it as "Nothing new"', async () => {
      const note = 'I dispatched the bench rerun to the eval lane for the morning run.';
      await runWake('chat-harness-fn-briefing', { finalText: note, parts: [], receipts: [] });
      await settleBriefing();
      const content: string = assistantWrites()[0].content;
      expect(content.startsWith(note)).toBe(true);
      expect(content.endsWith(`\n\n${NOOP}`)).toBe(true);
      expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
      const bArgs = mockGenerateOwnerBriefing.mock.calls[0][0];
      expect(bArgs.noteContent).toBe(note);
      expect(bArgs.unverifiedClaims).toHaveLength(1);
      expect(bArgs.unverifiedClaims[0]).toMatchObject({ source: 'zero_tool_dispatch' });
    });

    it('[1]/[7] the footnote lands IN FRONT OF the harness appendix (content + parts), so guard-chrome redaction strips the claims-lane trailer before it and keeps the appendix last', async () => {
      const note = 'I dispatched the bench rerun to the eval lane for the morning run.';
      mockApplyClaimsBlockLane.mockImplementationOnce((opts: any) => ({
        finalText: `${opts.guarded.finalText}\n\n${CLAIMS_TRAILER}`, notes: [CLAIMS_TRAILER], verdict: opts.guarded.verdict,
        lane: { present: true, verified: [], unverified: [{}], coveredKinds: [] },
      }));
      await runWake('chat-harness-fn-order', { finalText: note, parts: [], receipts: [] });
      const row = assistantWrites()[0];
      const content: string = row.content;
      const footAt = content.indexOf(FOOTNOTE_HEADER);
      expect(footAt).toBeGreaterThan(content.indexOf(CLAIMS_TRAILER));
      expect(content.endsWith(`\n\n${NOOP}`)).toBe(true);
      expect(content.slice(footAt)).toMatch(new RegExp(`\\n\\n${NOOP.replace(/[()]/g, '\\$&')}$`));
      const texts = (row.parts as any[]).filter((p: any) => p.type === 'text').map((p: any) => String(p.text));
      expect(texts[texts.length - 1].trim()).toBe(NOOP);
      expect(texts[texts.length - 2].startsWith(FOOTNOTE_HEADER)).toBe(true);
      // Model context (later wakes / get_chat_messages): the trailer AND the footnote strip, the neutral signal fires, the appendix stays last.
      const redacted = redactGuardChrome(content);
      expect(redacted).not.toContain('HARNESS EVIDENCE GUARD');
      expect(redacted).not.toContain(FOOTNOTE_HEADER);
      expect(redacted).toContain('[System note: the harness could not match tool evidence for 1 claim(s) in this reply (types: claims_block)');
      expect(redacted.endsWith(`\n\n${NOOP}`)).toBe(true);
    });

    it('[2] a note that was ONLY the model\'s ACTIONS TAKEN block (late-stripped): a claim inside it is gone from the note — no footnote quoting a line the owner cannot see', async () => {
      observedPhantoms([{ kind: 'dispatch', detail: 'dispatched the bench rerun to the GPU lane' }]);
      await runWake('chat-harness-fn-blockonly', { finalText: 'ACTIONS TAKEN\n- dispatched the bench rerun to the GPU lane', parts: [], receipts: [] });
      const content: string = assistantWrites()[0].content;
      expect(content).toBe(NOOP);
      expect(content).not.toContain(FOOTNOTE_HEADER);
      expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'action_class_annotated')).toHaveLength(0);
    });

    it('[2] when the harness stripped the note\'s own ACTIONS TAKEN list, the footnote never claims "nothing above was removed"', async () => {
      const note = 'I dispatched the bench rerun to the eval lane for the morning run.';
      await runWake('chat-harness-fn-wording', { finalText: `${note}\n\nACTIONS TAKEN\n- dispatched the bench rerun (receipt n/a)`, parts: [], receipts: [] });
      const content: string = assistantWrites()[0].content;
      expect(content).not.toContain('dispatched the bench rerun (receipt n/a)');
      expect(content).toContain(FOOTNOTE_HEADER);
      expect(content).not.toContain('nothing above was removed');
      expect(content).toContain('minus its own ACTIONS TAKEN list');
    });

    it('carried-forward mid-turn blocks stay the stored row\'s LAST paragraph (get_chat_messages keeps a long row\'s tail for them); the harness appendix sits in front of them', async () => {
      const note = 'Sweep done: the eval lane is green and the bench lane is waiting on its run.';
      const dispatch = '[DISPATCH-NEEDED] lane: bench\nRe-run the nightly bench on the fixed commit.';
      await runWake('chat-harness-fn-carried', { finalText: note, parts: [{ type: 'text', text: `Working.\n\n${dispatch}` }], receipts: [] });
      const content: string = assistantWrites()[0].content;
      expect(content.startsWith(note)).toBe(true);
      expect(content.indexOf(NOOP)).toBeGreaterThan(-1);
      expect(content.indexOf(NOOP)).toBeLessThan(content.indexOf('_Carried forward from this run\'s mid-turn output (machine-actionable blocks):_'));
      expect(content.endsWith(dispatch)).toBe(true);
    });

    it('a note whose only harness-stripped lines were model-typed COPIES of harness lines: the footnote names the copies, never an ACTIONS TAKEN list it did not have', async () => {
      const note = 'I dispatched the bench rerun to the eval lane for the morning run.';
      await runWake('chat-harness-fn-copies', { finalText: `${note}\n\n${NOOP}`, parts: [], receipts: [] });
      const content: string = assistantWrites()[0].content;
      expect(content).toContain(FOOTNOTE_HEADER);
      expect(content).toContain('minus its copies of harness-record lines');
      expect(content).not.toContain('ACTIONS TAKEN list');
      expect(content).not.toContain('nothing above was removed');
      expect(content.endsWith(`\n\n${NOOP}`)).toBe(true);
    });
  });
});

// ── STRUCK-NOTE REPEAT (tickets 4c7aebf7 + 9a976d83, 2026-10-21 — chat e03452f4) ─────────────────────
// The 'cql-accelerator Supervisor' chat's 17:12:19Z machine note headlined a FUTURE clock (17:25Z) and
// claimed a computer_task ACL edit; the guard struck the clock (observe-only annotation — 9a976d83, a true
// positive). The Fleet Supervisor then ordered "STEP 1: camera-read the saved policy JSON first"; the
// 17:20:32Z answer was a VERBATIM copy of the struck note with another wrong clock (17:14Z — in the past, so
// the clock lane had nothing to strike) and step 1 never ran (4c7aebf7). The seam pins: ONE bounded
// reject-back naming the repeat + the struck claims; a second repeat is delivered annotated (no loop); a
// genuinely new note, an unstruck prior note and a human turn are untouched; the next machine turn carries
// the [PRIOR NOTE STRUCK] block; the kill switches restore today byte-for-byte.
describe('struck-note repeat (tickets 4c7aebf7 + 9a976d83)', () => {
  const ANNOTATION_HEADER = '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]';
  const REPEAT_NOTICE = '[HARNESS NOTICE — REPEATED NOTE — not typed by the user]';
  const PRIOR_BLOCK = '[PRIOR NOTE STRUCK — harness, not typed by the user]';
  const NOTE_1712 = [
    '**cql-accelerator — 17:25Z**',
    '',
    "Drove the owner's Mac via computer_task: opened the Tailscale admin console → Access controls, applied the ACL edit (tag:agx → port 22 for the orin64 node) and clicked Save — the policy file saved without errors.",
    '',
    'Verify probe: `tailscale ping cql-accelerator` from the gateway is still RED (timeout after 3 tries).',
    '',
    'Next: re-run the probe once the ACL propagates; if it stays red, check the node tags.',
  ].join('\n');
  const CLOCK_ANNOTATION = [
    ANNOTATION_HEADER,
    "This note was delivered as written. 1 clock reading(s) in it are written as observations but read LATER than this run's real clock (2026-10-21T17:12:19.000Z) — an observation cannot be in the future:",
    '- "17:25Z" — 13 min ahead — in: "**cql-accelerator — 17:25Z**"',
    'Treat those lines as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
  ].join('\n');
  // engine 'agent' — the chat-agent finalize stamp every real note carries (round 2: the prior-note scan reads only the lane's own notes).
  const STRUCK_ROW = { id: 'msg-1712-aaaa-bbbb', content: `${NOTE_1712}\n\n${CLOCK_ANNOTATION}`, metadata: { origin: 'hook', engine: 'agent' }, createdAt: new Date('2026-10-21T17:12:19Z') };
  const NOTE_1720 = NOTE_1712.replace('17:25Z', '17:14Z');
  const NEW_NOTE = [
    '**cql-accelerator — step 1 (camera read)**',
    '',
    'Camera-read the Tailscale policy editor on the Mac (screenshot only, no input): the saved policy JSON shows NO acl entry for tag:agx — the earlier "edit applied + saved" did not happen.',
    'Not retrying the edit until the Fleet Supervisor confirms the target rule.',
  ].join('\n');

  let priorRows: any[] = [STRUCK_ROW];
  const priorReads = () => ((mockPrisma.crossModelMessage.findMany as jest.Mock | undefined)?.mock.calls ?? [])
    .filter((c: any[]) => c[0]?.where?.role === 'assistant' && c[0]?.where?.createdAt?.lt instanceof Date);
  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'assistant');
  const repeatRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'struck_note_repeat');
  const orchestratorCalls = () => (runCodingAgent as jest.Mock).mock.calls.map((c: any[]) => c[0]);

  const runWake = async (chatId: string, opts: { human?: boolean; messageOrigin?: string } = {}) => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId, sessionId: null,
      ...(opts.human ? {} : { machineWake: true, messageOrigin: (opts.messageOrigin ?? 'agent') as any }),
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'complete'));
    await waitFor(() => !isRunActive(`chat:${chatId}`));
    await new Promise((r) => setTimeout(r, 30));
    return events;
  };

  beforeEach(() => {
    priorRows = [STRUCK_ROW];
    mockPrisma.crossModelMessage.findMany = jest.fn(async (a: any) =>
      (a?.where?.role === 'assistant' && a?.where?.createdAt?.lt instanceof Date) ? priorRows : []);
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear();
    mockGuardMachineWakeFinalAnswer.mockClear();
    mockGenerateOwnerBriefing.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'cql-accelerator Supervisor', isSupervisor: true, userId: 'u1' }));
    delete process.env.ACTION_VERIFIER_ENFORCE;
    delete process.env.STRUCK_NOTE_REPEAT_DISABLED;
    delete process.env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED;
    // The incident note claims it drove the Mac with no computer_task call in these mocked runs — the computer_task
    // claim check (its own describe below) would annotate it too; this suite pins the repeat seam alone.
    process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED = '1';
  });
  afterEach(() => {
    delete mockPrisma.crossModelMessage.findMany;
    delete process.env.STRUCK_NOTE_REPEAT_DISABLED;
    delete process.env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED;
    delete process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  it('THE INCIDENT: a verbatim re-post of the struck note is rejected back ONCE with a notice naming the repeat + the struck claims; the retry\'s new note is delivered', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-incident');

    const calls = orchestratorCalls();
    expect(calls).toHaveLength(2); // ONE re-orchestration
    // (a) the first attempt already carried the [PRIOR NOTE STRUCK] block naming the struck clock
    expect(String(calls[0].doctrineOverride)).toContain(PRIOR_BLOCK);
    expect(String(calls[0].doctrineOverride)).toContain('> - "17:25Z" — 13 min ahead');
    // (b) the retry's turn: the repeat notice with the struck claims — and NOT the rejected draft to "rewrite"
    const retryMsg = String(calls[1].userMessage);
    expect(retryMsg).toContain('the question'); // the wake's own message still leads
    expect(retryMsg).toContain(REPEAT_NOTICE);
    expect(retryMsg).toContain('100% the same');
    expect(retryMsg).toContain('> - "17:25Z" — 13 min ahead');
    expect(retryMsg).toMatch(/first step/);
    expect(retryMsg).not.toContain('REJECTED DRAFT');
    expect(retryMsg).not.toContain('clicked Save');
    // the guard audited both texts (pass 2 on the retry, consequences on)
    expect(mockGuardMachineWakeFinalAnswer).toHaveBeenCalledTimes(2);
    expect(mockGuardMachineWakeFinalAnswer.mock.calls[1][0].finalText).toBe(NEW_NOTE);
    // delivered: the retry's note, untouched
    expect(assistantWrites()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(NEW_NOTE);
    expect(repeatRows()).toHaveLength(1);
    expect(repeatRows()[0]).toMatchObject({ sessionId: 'chat-repeat-incident', meta: { outcome: 'clean', reason: 'repeat', similarity: 1, priorMessageId: 'msg-1712', priorStruck: 'annotated', struckClaims: 1, supervisorScope: 'fleet' } });
    const cycle = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back');
    // Round 2 (finding 1): a REPEAT-ONLY cycle (the guard struck nothing on pass 1) writes NO guard_strike row — the
    // nightly adjudicator would label it true_positive and G17 would count it as fabrication-class. The
    // struck_note_repeat row records the cycle instead.
    expect(cycle).toHaveLength(0);
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'guard_strike')).toHaveLength(0);
    expect(repeatRows()[0].meta.cycle).toMatchObject({ trigger: 'struck_note_repeat', firstPassStruck: false, secondPassStruck: false, swapped: true });
    expect(repeatRows()[0].meta.cycle.firstPassClockHits).toBeUndefined();
    expect(typeof repeatRows()[0].meta.cycle.retryMs).toBe('number');
  });

  it('a SECOND repeat after the reject-back is delivered as written with ONE annotation — never a third orchestrator call, no owner briefing', async () => {
    const delivered = NOTE_1712.replace('17:25Z', '17:21Z');
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: delivered, parts: [], receipts: [] });
    const events = await runWake('chat-repeat-twice', { messageOrigin: 'schedule' });

    expect(orchestratorCalls()).toHaveLength(2); // bounded: no loop
    const content: string = assistantWrites()[0].content;
    expect(content.startsWith(delivered)).toBe(true); // nothing in the note removed or changed
    const annotation = content.slice(delivered.length).trim();
    expect(annotation.split('\n')[0]).toBe(ANNOTATION_HEADER);
    expect(annotation).toContain('sent back once, and the retry came back as the same copy');
    expect(annotation).not.toMatch(/\n\s*\n/); // one paragraph — guard-chrome-redact strips it whole
    expect(redactGuardChrome(content)).toBe(delivered);
    const parts = assistantWrites()[0].parts as any[];
    expect(parts[parts.length - 1]).toMatchObject({ type: 'text', text: annotation });
    expect(repeatRows()).toHaveLength(1);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'still_repeat_annotated', similarity: 1, retrySimilarity: 1 });
    expect(events.find((e) => e.type === 'complete')!.data.finalText).toBe(content);
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled(); // a re-posted struck note is never briefed as news
  });

  it('a GENUINELY NEW note after a struck one is delivered untouched (one orchestrator call) — one "fresh" row measures the block', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-fresh');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NEW_NOTE);
    expect(repeatRows()).toHaveLength(1);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'fresh', reason: 'below_threshold' });
  });

  it('a verbatim copy of an UNSTRUCK previous note is untouched — no block, no reject-back, no row', async () => {
    priorRows = [{ ...STRUCK_ROW, content: NOTE_1712 }];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-unstruck');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NOTE_1720);
    expect(repeatRows()).toHaveLength(0);
  });

  it('a copy of a note carrying ONLY the observe-only action-claims footnote is untouched (that gate-flipped lane never costs a reject-back)', async () => {
    const footnote = [
      ANNOTATION_HEADER,
      'This note was delivered as written. The integrity check could not verify 1 action claim(s) in it — no matching tool call in this run:',
      '- [dispatch] "applied the ACL edit and clicked Save"',
      'Treat those lines as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
    ].join('\n');
    priorRows = [{ ...STRUCK_ROW, content: `${NOTE_1712.replace('17:25Z', '17:10Z')}\n\n${footnote}` }];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-footnote-only');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NOTE_1720);
    expect(repeatRows()).toHaveLength(0);
  });

  it('a guard reject-back already ARMED for the note carries the repeat notice in the SAME single cycle (folded, never two retries)', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: 'n', struck: true, audited: true,
      phantoms: [{ kind: 'ticket', detail: '[evidence citation] ticket ab12cd34', id: 'ab12cd34', fabricatedId: true }],
      rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify', correction: 'c',
    }));
    await runWake('chat-repeat-folded');
    expect(orchestratorCalls()).toHaveLength(2);
    const retryMsg = String(orchestratorCalls()[1].userMessage);
    expect(retryMsg).toContain(REPEAT_NOTICE);
    expect(retryMsg).toContain('[HARNESS NOTICE] rejected — re-verify');
    expect(assistantWrites()[0].content).toBe(NEW_NOTE);
    const cycle = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.meta?.seam === 'machine_wake_reject_back' && m?.meta?.citationRetry);
    expect(cycle).toHaveLength(1);
    expect(cycle[0].meta.trigger).toBe('guard+struck_note_repeat');
    expect(repeatRows()[0].meta.outcome).toBe('clean');
  });

  it('a HUMAN turn on the same chat is untouched — the prior note is never read, no block, no reject-back', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-human', { human: true });
    expect(priorReads()).toHaveLength(0);
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(repeatRows()).toHaveLength(0);
  });

  it('kill switches: STRUCK_NOTE_REPEAT_DISABLED=1 + PRIOR_NOTE_STRUCK_BLOCK_DISABLED=1 restore today (no read, the repeat delivers as written); each switch alone kills only its half', async () => {
    process.env.STRUCK_NOTE_REPEAT_DISABLED = '1';
    process.env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED = '1';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-off');
    expect(priorReads()).toHaveLength(0);
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NOTE_1720);
    expect(repeatRows()).toHaveLength(0);

    // the repeat half off, the block half on: the block rides, the repeat delivers unmodified
    delete process.env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED;
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-off-2');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NOTE_1720);

    // the block half off, the repeat half on: no block, the repeat is still sent back once
    process.env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED = '1';
    delete process.env.STRUCK_NOTE_REPEAT_DISABLED;
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-off-3');
    expect(orchestratorCalls()).toHaveLength(2);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NEW_NOTE);
  });

  it('fails open: a prior-note read error changes nothing (one call, the note as written)', async () => {
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => { throw new Error('db down'); });
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-dberr');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(NOTE_1720);
    expect(repeatRows()).toHaveLength(0);
  });

  // ── Round 2 (2026-10-21 — both reviews NOT_MERGE_SAFE) ──────────────────────────────────────────────
  const guardStrikeRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'guard_strike');
  /** A clock-only pass-1 verdict exactly as the guard returns it under the clock policy (observe-only annotation). */
  const clockStrike = (a: any) => ({
    finalText: `${a.finalText}\n\n${CLOCK_ANNOTATION}`, notice: CLOCK_ANNOTATION, struck: true, phantoms: [] as any[], audited: true,
    delivery: 'annotated', futureClocks: [{ token: '17:25Z', minutesAhead: 13, line: '**cql-accelerator — 17:25Z**' }], correction: 'clock correction',
  });

  it('finding 2: same template, numbers moved ⇒ fresh data, not a repeat (one call, reason numbers_differ)', async () => {
    const moved = NOTE_1712.replace('port 22', 'port 2222').replace('3 tries', '5 tries').replace('17:25Z', '17:40Z');
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: moved, parts: [], receipts: [] });
    await runWake('chat-repeat-moved');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(moved);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'fresh', reason: 'numbers_differ' });
    expect('deferClockTicket' in mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toBe(false); // no repeat ⇒ pass-1 args as before
  });

  it('finding 3a: an honest NO-OP note after a struck one is never compared — one call, no annotation (the supervisor note classifier)', async () => {
    const NOOP = 'WAKE: no-op — all 3 lanes are still blocked on owner question oq_5f2a; nothing moved since the last wake, so there is no lane action and no new dispatch this turn (as of 17:25Z).';
    priorRows = [{ ...STRUCK_ROW, content: `${NOOP}\n\n${CLOCK_ANNOTATION}` }];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOOP.replace('17:25Z', '17:40Z'), parts: [], receipts: [] });
    await runWake('chat-repeat-noop');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).toContain(PRIOR_BLOCK); // the block still names the original strike
    expect(assistantWrites()[0].content).not.toContain('near-verbatim copy');
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'fresh', reason: 'noop' });
    expect(mockGenerateOwnerBriefing).toHaveBeenCalled();
  });

  it('finding 3b: a previous note whose ONLY strike chrome is the repeat annotation is not struck — no block, no repeat check, no row', async () => {
    const repeatAnnotation = [
      ANNOTATION_HEADER,
      "This note was delivered as written. It is a near-verbatim copy (100% the same, timestamps aside) of this chat's previous note (posted 2026-10-21T17:12:19.000Z), which the integrity check had flagged; it was sent back once, and the retry came back as the same copy.",
      '- "17:25Z" — 13 min ahead — in: "**cql-accelerator — 17:25Z**"',
      'Treat its claims as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
    ].join('\n');
    // (round 4: there is no carry-through — a repeat-annotation-only prior is never compared, whatever sits behind it)
    priorRows = [{ ...STRUCK_ROW, id: 'msg-1720-cccc', content: `${NOTE_1720}\n\n${repeatAnnotation}`, createdAt: new Date('2026-10-21T17:20:32Z') }];
    const again = NOTE_1712.replace('17:25Z', '17:31Z');
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: again, parts: [], receipts: [] });
    await runWake('chat-repeat-only-annotated');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(again);
    expect(repeatRows()).toHaveLength(0);
  });

  it('finding 4: a repeat carrying a still-future clock — pass 1 DEFERS the clock ticket; pass 2 (no defer) guards the text actually delivered', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1712, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => clockStrike(a));
    await runWake('chat-repeat-clock');
    const g = mockGuardMachineWakeFinalAnswer.mock.calls.map((c: any[]) => c[0]);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ deferConsequences: true, deferClockTicket: true });
    expect(g[0].now).toBeInstanceOf(Date);
    expect(g[1].deferConsequences).toBeUndefined();
    expect(g[1].deferClockTicket).toBeUndefined();
    expect(g[1].finalText).toBe(NEW_NOTE);
    expect(orchestratorCalls()).toHaveLength(2);
    expect(assistantWrites()[0].content).toBe(NEW_NOTE); // the discarded draft's clock never reached the thread
    expect(repeatRows()[0].meta.outcome).toBe('clean');
    expect(guardStrikeRows().filter((m: any) => m.meta?.seam === 'machine_wake_reject_back')).toHaveLength(0);
    // Round 3 (nit): the pass-1 clock strike (no guard_strike row on a repeat-only cycle) is stamped on the cycle
    expect(repeatRows()[0].meta.cycle).toMatchObject({ trigger: 'struck_note_repeat', firstPassStruck: true, firstPassClockHits: [{ token: '17:25Z', minutesAhead: 13 }] });
  });

  it('finding 4 (stop mid pass 1): no retry runs — the deferred clock ticket files through a consequences-ON re-guard pinned to the pass-1 instant; the annotation says it could not be sent back', async () => {
    const { cancelRun } = jest.requireActual('../coding/live-runs') as typeof import('../coding/live-runs');
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async (a: any) => { cancelRun('chat:chat-repeat-stop'); return clockStrike(a); })
      .mockImplementationOnce(async (a: any) => clockStrike(a));
    await runWake('chat-repeat-stop');
    expect(orchestratorCalls()).toHaveLength(1); // never re-orchestrated
    const g = mockGuardMachineWakeFinalAnswer.mock.calls.map((c: any[]) => c[0]);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ deferConsequences: true, deferClockTicket: true });
    expect(g[1].deferConsequences).toBeUndefined();
    expect(g[1].finalText).toBe(g[0].finalText);
    expect(g[1].now).toEqual(g[0].now);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'annotated_no_retry' });
    const written = assistantWrites();
    expect(written).toHaveLength(1); // a stopped run still persists what it wrote
    expect(written[0].content.startsWith(NOTE_1720)).toBe(true);
    expect(written[0].content).toContain('could not be sent back');
    expect(written[0].content).not.toMatch(/sent back once|came back/);
  });

  it('finding 5: a retry that produced no usable answer is "retry_failed" — the original is delivered with an annotation that says so (never "came back")', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockRejectedValueOnce(new Error('provider down'));
    await runWake('chat-repeat-retry-failed');
    const content: string = assistantWrites()[0].content;
    expect(content.startsWith(NOTE_1720)).toBe(true);
    expect(content).toContain('the retry produced no usable answer');
    expect(content).not.toContain('came back');
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'retry_failed' });
    expect(repeatRows()[0].meta.retrySimilarity).toBeUndefined();
    expect(repeatRows()[0].meta.cycle).toMatchObject({ swapped: false });
    expect(guardStrikeRows().filter((m: any) => m.meta?.seam === 'machine_wake_reject_back')).toHaveLength(0);
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('finding 6: a harness row (the watchdog nudge) newer than the struck note does not hide it', async () => {
    priorRows = [
      { id: 'nudge-1', content: 'Stuck-note nudge: your last notes repeat.', metadata: { origin: 'attention-watchdog', kind: 'stuck-note-nudge' }, createdAt: new Date('2026-10-21T17:18:00Z') },
      { id: 'ack-1', content: 'Report-up acknowledged.', metadata: { origin: 'report-up-ack', kind: 'report_up_ack' }, createdAt: new Date('2026-10-21T17:17:30Z') },
      STRUCK_ROW,
    ];
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-behind-nudge');
    expect(orchestratorCalls()).toHaveLength(2);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'clean', priorMessageId: 'msg-1712' });
  });

  it('finding 7: the repeat retry\'s seed is reference-only (no "rewrite", no "do not re-fetch"); a folded guard notice loses "Do not mention this check"', async () => {
    const toolParts = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'apply the ACL edit' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 4 · OBSERVE-ONLY (camera; no input was possible)]\n[SUB-AGENT NARRATION — UNVERIFIED] …\nI clicked Save.' },
    ];
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: toolParts, receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: 'n', struck: true, audited: true,
      phantoms: [{ kind: 'ticket', detail: '[evidence citation] ticket ab12cd34', id: 'ab12cd34', fabricatedId: true }],
      rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify. Make the fresh tool calls you need NOW, then answer from their results. Do not mention this check in the note.', correction: 'c',
    }));
    await runWake('chat-repeat-seed');
    const retryMsg = String(orchestratorCalls()[1].userMessage);
    expect(retryMsg).toContain(REPEAT_NOTICE);
    expect(retryMsg).toContain('[HARNESS NOTICE] rejected — re-verify.');
    expect(retryMsg).not.toContain('Do not mention this check');
    expect(retryMsg).toContain("[HARNESS — THIS RUN'S TOOL RESULTS, FOR REFERENCE — not typed by the user]");
    expect(retryMsg).not.toMatch(/REWRITE the note|do not re-fetch|Do not redo the whole wake|REJECTED DRAFT/);
    expect(retryMsg).toContain('[1] computer_task:');
  });

  // ── Round 3 (2026-10-21 — both reviews NOT_MERGE_SAFE) ──────────────────────────────────────────────
  it('round 3 no-op skip: a SHORT (≤200 chars) re-post of a struck claim note is compared and sent back — the classifier\'s length fall-through no longer exempts it', async () => {
    const SHORT = 'Applied the ACL edit on the Mac and clicked Save; verify probe still red, retrying after propagation (17:25Z).';
    priorRows = [{ ...STRUCK_ROW, content: `${SHORT}\n\n${CLOCK_ANNOTATION}` }];
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: SHORT.replace('17:25Z', '17:31Z'), parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-short');
    expect(orchestratorCalls()).toHaveLength(2);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'clean', reason: 'repeat' });
  });

  // ── Round 4 (2026-10-21 — both round-3 reviews NOT_MERGE_SAFE) ──────────────────────────────────────────────
  const REPEAT_ANNOTATION_1720 = [
    ANNOTATION_HEADER,
    "This note was delivered as written. It is a near-verbatim copy (100% the same, timestamps aside) of this chat's previous note (posted 2026-10-21T17:12:19.000Z), which the integrity check had flagged; it was sent back once, and the retry came back as the same copy.",
    '- "17:25Z" — 13 min ahead — in: "**cql-accelerator — 17:25Z**"',
    'Treat its claims as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
  ].join('\n');

  it('round 4: a THIRD verbatim copy (the previous note was already sent back once) is never bounced or annotated again — the round-3 carry-through is gone', async () => {
    priorRows = [
      { ...STRUCK_ROW, id: 'msg-1720-cccc', content: `${NOTE_1720}\n\n${REPEAT_ANNOTATION_1720}`, createdAt: new Date('2026-10-21T17:20:32Z') },
      STRUCK_ROW,
    ];
    const again = NOTE_1712.replace('17:25Z', '17:31Z');
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: again, parts: [], receipts: [] });
    await runWake('chat-repeat-third-copy');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride)).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(again);
    expect(repeatRows()).toHaveLength(0);
    expect(mockGenerateOwnerBriefing).toHaveBeenCalled();
  });

  it('round 4: the delivered copy is stamped SPENT on its row; a later struck copy of it is measured (ineligible, wouldRepeat) and inherits the stamp — never a second reject-back', async () => {
    const delivered = NOTE_1712.replace('17:25Z', '17:21Z');
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: delivered, parts: [], receipts: [] });
    await runWake('chat-repeat-spent-1');
    expect(orchestratorCalls()).toHaveLength(2); // the ONE reject-back
    const w1 = assistantWrites()[0];
    expect(w1.metadata.struckNoteRepeat).toEqual({ spent: true, via: 'repeat' });
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'still_repeat_annotated', lineage: 'repeat', priorSpent: false });

    // wake 2: the stored copy ALSO carries its own clock strike (so it is struck) — still never bounced
    priorRows = [{ id: 'msg-w1', content: `${delivered}\n\n${CLOCK_ANNOTATION}`, metadata: w1.metadata, createdAt: new Date(Date.now() - 60_000) }, STRUCK_ROW];
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear();
    const third = NOTE_1712.replace('17:25Z', '17:33Z');
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: third, parts: [], receipts: [] });
    await runWake('chat-repeat-spent-2');
    expect(orchestratorCalls()).toHaveLength(1);
    const doctrine = String(orchestratorCalls()[0].doctrineOverride);
    expect(doctrine).toContain(PRIOR_BLOCK); // its own strike is still named …
    expect(doctrine).not.toMatch(/is sent back/); // … without a send-back that will not happen
    expect(assistantWrites()[0].content).toBe(third);
    expect(assistantWrites()[0].metadata.struckNoteRepeat).toEqual({ spent: true, via: 'copy_of_spent' });
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'ineligible', reason: 'prior_repeat_spent', wouldRepeat: true, lineage: 'copy_of_spent', priorSpent: true });
  });

  it('round 4: a clean retry (new work) is NOT stamped — a later copy of THAT note is its own lineage', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-clean-nostamp');
    expect(assistantWrites()[0].metadata.struckNoteRepeat).toBeUndefined();
    expect(repeatRows()[0].meta.lineage).toBeUndefined();
  });

  it('round 4 (decision 3): a run that fired a REPLAY-UNSAFE tool (send_chat_message) is never re-orchestrated — annotated instead, the tool named, no owner briefing', async () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1', message: 'camera-read the policy' } },
      { type: 'tool_result', name: 'send_chat_message', result: 'Sent (msg 9f8e7d6c).' },
    ];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] });
    await runWake('chat-repeat-unsafe');
    expect(orchestratorCalls()).toHaveLength(1); // never a replay of the send
    expect('deferClockTicket' in mockGuardMachineWakeFinalAnswer.mock.calls[0][0]).toBe(false); // no reject-back planned
    const content: string = assistantWrites()[0].content;
    expect(content.startsWith(NOTE_1720)).toBe(true);
    expect(content).toContain('it was not sent back, because this run already made a call that must not run twice (send_chat_message)');
    expect(content).not.toMatch(/sent back once|came back/);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'annotated_replay_unsafe', reason: 'repeat', skip: { reason: 'replay_unsafe', tool: 'send_chat_message' }, lineage: 'repeat' });
    expect(repeatRows()[0].meta.cycle).toBeUndefined();
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('round 4 (decision 3): a computer_task WITH input (full control) is replay-unsafe — no replay of the desktop action', async () => {
    const parts = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'apply the ACL edit' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 7 · mac: online (agent 0.6.3) · harness: probe=1/1 input-proven]\n[SUB-AGENT NARRATION — UNVERIFIED] …\nClicked Save.' },
    ];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] });
    await runWake('chat-repeat-ct-full');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'annotated_replay_unsafe', skip: { reason: 'replay_unsafe', tool: 'computer_task' } });
  });

  it('round 4 (decision 3): a camera-only computer_task or an update_supervisor_state write is replay-safe — the copy is still sent back once', async () => {
    const parts = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'camera-read the policy' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 3 · OBSERVE-ONLY (camera; no input was possible)]\n[SUB-AGENT NARRATION — UNVERIFIED] …' },
      { type: 'tool_call', name: 'update_supervisor_state', args: { notes: 'x' } },
      { type: 'tool_result', name: 'update_supervisor_state', result: 'ok' },
    ];
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-replay-safe');
    expect(orchestratorCalls()).toHaveLength(2);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'clean' });
    expect(repeatRows()[0].meta.skip).toBeUndefined();
  });

  // Round 5 (both round-4 reviews, major — their scratch replays): the round-4 'run_backed' skip took a struck clock /
  // id appearing in ANY tool result as backing, so a run that merely READ its own struck note (get_chat_messages of
  // this chat), its supervisor state, or a real read that prints the clock skipped the one reject-back, dropped the
  // claim lines and left the owner briefing open on the re-posted claims. The skip is gone: the copy is sent back once.
  it.each([
    ['get_chat_messages of THIS chat (the struck note itself)', 'get_chat_messages', { chatId: 'chat-repeat-selfread' }, () => JSON.stringify({ messages: [{ id: STRUCK_ROW.id, role: 'assistant', content: STRUCK_ROW.content }] })],
    ['get_supervisor_state notes quoting the struck clock', 'get_supervisor_state', {}, () => '{"notes":"17:12Z: applied ACL edit on the Mac via computer_task; verify probe due 17:25Z"}'],
    ['a real read that prints the struck clock (the round-4 run-backed shape)', 'schedule_get', {}, () => 'schedule 88d9287e — next firing 17:25Z (every 15 min)'],
  ])('round 5: a tool result that echoes / quotes the struck note is not backing — %s: the copy is still sent back ONCE, the claim lines stay, no owner briefing', async (_label, tool, args, result) => {
    const parts = [
      { type: 'tool_call', name: tool, args },
      { type: 'tool_result', name: tool, result: result() },
    ];
    const delivered = NOTE_1712.replace('17:25Z', '17:21Z');
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] })
      .mockResolvedValueOnce({ finalText: delivered, parts: [], receipts: [] });
    await runWake('chat-repeat-selfread');
    expect(orchestratorCalls()).toHaveLength(2); // the one reject-back ran
    expect(String(orchestratorCalls()[1].userMessage)).toContain(REPEAT_NOTICE);
    const content: string = assistantWrites()[0].content;
    expect(content.startsWith(delivered)).toBe(true);
    expect(content).toContain('sent back once, and the retry came back as the same copy');
    expect(content).toContain('- "17:25Z" — 13 min ahead');
    expect(content).toMatch(/Treat its claims as unverified/);
    expect(content).not.toMatch(/own tool results print every item/);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'still_repeat_annotated', reason: 'repeat' });
    expect(repeatRows()[0].meta.skip).toBeUndefined();
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('round 4 (decision 3): a guard reject-back armed on a replay-unsafe run does NOT fold the repeat notice / seed in (its own "reuse, do not redo" seed stands)', async () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1', message: 'x' } },
      { type: 'tool_result', name: 'send_chat_message', result: 'Sent (msg 9f8e7d6c).' },
    ];
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] })
      .mockResolvedValueOnce({ finalText: NOTE_1712.replace('17:25Z', '17:22Z'), parts: [], receipts: [] });
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: 'n', struck: true, audited: true,
      phantoms: [{ kind: 'ticket', detail: '[evidence citation] ticket ab12cd34', id: 'ab12cd34', fabricatedId: true }],
      rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify', correction: 'c',
    }));
    await runWake('chat-repeat-unsafe-folded');
    expect(orchestratorCalls()).toHaveLength(2); // the GUARD's own reject-back (pre-existing), never a second
    const retryMsg = String(orchestratorCalls()[1].userMessage);
    expect(retryMsg).not.toContain(REPEAT_NOTICE);
    expect(retryMsg).toContain('[HARNESS NOTICE] rejected — re-verify');
    expect(retryMsg).not.toContain("[HARNESS — THIS RUN'S TOOL RESULTS, FOR REFERENCE");
    // Round 5 (both round-4 reviews, minor): the wake WAS re-run once — by the guard's own check — so the outcome and
    // the delivered wording say that, never "it was not sent back".
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'guard_cycle_repeat', skip: { reason: 'replay_unsafe', tool: 'send_chat_message' }, guardCycle: { swapped: true }, lineage: 'repeat' });
    const content: string = assistantWrites()[0].content;
    expect(content).toContain('the integrity check re-ran this wake once for its own findings');
    expect(content).toContain('must not run twice (send_chat_message)');
    expect(content).toMatch(/may have run again/);
    expect(content).not.toMatch(/not sent back/);
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('round 5: the guard\'s own reject-back on a replay-unsafe run whose retry FAILED — still guard_cycle_repeat (the wake was re-run once), the original stands', async () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1', message: 'x' } },
      { type: 'tool_result', name: 'send_chat_message', result: 'Sent (msg 9f8e7d6c).' },
    ];
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] })
      .mockRejectedValueOnce(new Error('provider down'));
    // Pass 1: a citation-class strike arms the guard's own reject-back; pass 2 (the original — the retry failed): clean.
    mockGuardMachineWakeFinalAnswer.mockImplementationOnce(async (a: any) => ({
      finalText: a.finalText, notice: 'n', struck: true, audited: true,
      phantoms: [{ kind: 'ticket', detail: '[evidence citation] ticket ab12cd34', id: 'ab12cd34', fabricatedId: true }],
      rejectBackNotice: '[HARNESS NOTICE] rejected — re-verify', correction: 'c',
    }));
    await runWake('chat-repeat-unsafe-guard-failed');
    expect(orchestratorCalls()).toHaveLength(2);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'guard_cycle_repeat', guardCycle: { swapped: false } });
    const content: string = assistantWrites()[0].content;
    expect(content.startsWith(NOTE_1720)).toBe(true);
    expect(content).toContain('the integrity check re-ran this wake once for its own findings');
    expect(content).not.toMatch(/not sent back/);
  });

  it('round 5: a replay-unsafe run with NO reject-back cycle at all keeps annotated_replay_unsafe and its "not sent back" wording (no guardCycle)', async () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-1', message: 'x' } },
      { type: 'tool_result', name: 'send_chat_message', result: 'Sent (msg 9f8e7d6c).' },
    ];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts, receipts: [] });
    await runWake('chat-repeat-unsafe-nocycle');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'annotated_replay_unsafe' });
    expect(repeatRows()[0].meta.guardCycle).toBeUndefined();
    expect(assistantWrites()[0].content).toContain('it was not sent back, because this run already made a call that must not run twice (send_chat_message)');
  });

  it('round 4 (decision 4): a FAILED repeat retry re-guards the original pinned to the pass-1 instant — the deferred clock ticket files on the delivered text', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1712, parts: [], receipts: [] })
      .mockRejectedValueOnce(new Error('provider down'));
    mockGuardMachineWakeFinalAnswer
      .mockImplementationOnce(async (a: any) => clockStrike(a))
      .mockImplementationOnce(async (a: any) => clockStrike(a));
    await runWake('chat-repeat-failed-clock');
    const g = mockGuardMachineWakeFinalAnswer.mock.calls.map((c: any[]) => c[0]);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ deferConsequences: true, deferClockTicket: true });
    expect(g[1].deferConsequences).toBeUndefined();
    expect(g[1].deferClockTicket).toBeUndefined();
    expect(g[1].finalText).toBe(g[0].finalText); // the original stands
    expect(g[1].now).toEqual(g[0].now); // judged on the SAME clock pass 1 used
    expect(repeatRows()[0].meta).toMatchObject({ outcome: 'retry_failed' });
  });

  it('round 4 (decision 4): a SWAPPED retry is judged against the real clock (no pin)', async () => {
    (runCodingAgent as jest.Mock)
      .mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] })
      .mockResolvedValueOnce({ finalText: NEW_NOTE, parts: [], receipts: [] });
    await runWake('chat-repeat-swapped-clock');
    const g = mockGuardMachineWakeFinalAnswer.mock.calls.map((c: any[]) => c[0]);
    expect(g[1].finalText).toBe(NEW_NOTE);
    expect(g[1].now).toBeUndefined();
  });

  it('finding 8: a PLAIN chat\'s machine wake (schedule_message on a user\'s chat) is untouched — no read, no block, no reject-back', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'My plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE_1720, parts: [], receipts: [] });
    await runWake('chat-repeat-plain', { messageOrigin: 'schedule' });
    expect(priorReads()).toHaveLength(0);
    expect(orchestratorCalls()).toHaveLength(1);
    expect(String(orchestratorCalls()[0].doctrineOverride ?? '')).not.toContain(PRIOR_BLOCK);
    expect(assistantWrites()[0].content).toBe(NOTE_1720);
    expect(repeatRows()).toHaveLength(0);
  });
});

// ── COMPUTER_TASK CLAIM CHECK (related to ticket 4c7aebf7 (c), 2026-10-21 — chat-agent/computer-task-claims.ts) ────
// The 17:12:19Z note on chat e03452f4 said it drove the owner's Mac via computer_task ("applied the ACL edit … and
// clicked Save") while the run's computer_task was OBSERVE-ONLY (owner active ⇒ a machine run is camera-only).
// Round 4: OBSERVE-ONLY BY DEFAULT — on a SUPERVISOR-CLASS MACHINE run the check writes ONE counts-only loop_metrics
// row (computer_task_claim) and changes nothing; COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 restores the annotation
// (a [PRIOR NOTE STRUCK] strike, never a reject-back). Human turns, plain chats and the kill switch write nothing.
describe('computer_task claim check (related to ticket 4c7aebf7 (c))', () => {
  const ANNOTATION_HEADER = '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]';
  const PRIOR_BLOCK = '[PRIOR NOTE STRUCK — harness, not typed by the user]';
  const LABEL = "[SUB-AGENT NARRATION — UNVERIFIED] The report below is the computer-use sub-agent's own account of what it did and saw, NOT a harness-verified observation.";
  const NOTE = [
    '**cql-accelerator — status**',
    '',
    "Drove the owner's Mac via computer_task: opened the Tailscale admin console → Access controls, applied the ACL edit (tag:agx → port 22 for the orin64 node) and clicked Save — the policy file saved without errors.",
    '',
    'Verify probe: `tailscale ping cql-accelerator` from the gateway is still RED (timeout after 3 tries).',
  ].join('\n');
  const ctParts = (header: string) => [
    { type: 'tool_call', name: 'computer_task', args: { task: 'apply the ACL edit' } },
    { type: 'tool_result', name: 'computer_task', result: `${header}\n${LABEL}\nOpened the console, applied the edit and clicked Save.` },
  ];
  const OBSERVE = '[Computer task result — steps: 6 · mac: online (agent 0.6.3) · OBSERVE-ONLY (owner active: HID idle 4 s — machine run was camera-only) · harness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 frame=1728x1117 displays=1]';
  const FULL = '[Computer task result — steps: 7 · mac: online (agent 0.6.3) · harness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 frame=1728x1117 displays=1 probe=1/1 input-proven]';

  let priorRows: any[] = [];
  const assistantWrites = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'assistant');
  const strikeRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'guard_strike' && m?.meta?.seam === 'machine_wake_computer_task_claim');
  const verdictRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'computer_task_claim');
  const orchestratorCalls = () => (runCodingAgent as jest.Mock).mock.calls.map((c: any[]) => c[0]);
  const runWake = async (chatId: string, opts: { human?: boolean } = {}) => {
    const key = await startDetachedChatRun({
      ...BASE, userId: 'u1', chatId, sessionId: null,
      ...(opts.human ? {} : { machineWake: true, messageOrigin: 'schedule' as any }),
    });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'complete'));
    await waitFor(() => !isRunActive(`chat:${chatId}`));
    await new Promise((r) => setTimeout(r, 30));
    return events;
  };
  const resetMocks = () => {
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear();
    mockGenerateOwnerBriefing.mockClear();
  };

  beforeEach(() => {
    priorRows = [];
    mockPrisma.crossModelMessage.findMany = jest.fn(async (a: any) =>
      (a?.where?.role === 'assistant' && a?.where?.createdAt?.lt instanceof Date) ? priorRows : []);
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetric.mockClear();
    mockGuardMachineWakeFinalAnswer.mockClear();
    mockGenerateOwnerBriefing.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'cql-accelerator Supervisor', isProjectSupervisor: true, userId: 'u1' }));
    delete process.env.ACTION_VERIFIER_ENFORCE;
    delete process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED;
    delete process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED;
  });
  afterEach(() => {
    delete mockPrisma.crossModelMessage.findMany;
    delete process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED;
    delete process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  });

  // ── the default: OBSERVE-ONLY ───────────────────────────────────────────────────────────────────────────
  it('DEFAULT (observe-only): THE INCIDENT on an OBSERVE-ONLY session is delivered UNCHANGED — one counts-only computer_task_claim row, no guard_strike, no annotation, briefed as written', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
    const events = await runWake('chat-ct-observe');
    expect(orchestratorCalls()).toHaveLength(1);
    expect(assistantWrites()[0].content).toBe(NOTE);
    expect(events.find((e) => e.type === 'complete')!.data.finalText ?? NOTE).toBe(NOTE);
    expect(strikeRows()).toHaveLength(0);
    expect(verdictRows()).toHaveLength(1);
    expect(verdictRows()[0]).toMatchObject({ sessionId: 'chat-ct-observe', meta: { unbacked: true, reason: 'no_input_possible', found: 1, claims: 1, deviceClaims: 1, totalCalls: 1, calls: { observe_only: 1 }, mode: 'observe', annotated: false, supervisorScope: 'project' } });
    expect(JSON.stringify(verdictRows()[0].meta)).not.toMatch(/Drove|Tailscale|clicked|Save/); // never note text
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
    expect(String(mockGenerateOwnerBriefing.mock.calls[0][0].noteContent)).not.toContain('[screen input]');
  });

  it('DEFAULT: the next machine turn gets NO [PRIOR NOTE STRUCK] block (nothing was struck)', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
    await runWake('chat-ct-observe-next-1');
    priorRows = [{ id: 'msg-ct-1', content: assistantWrites()[0].content, metadata: { origin: 'schedule', engine: 'agent' }, createdAt: new Date(Date.now() - 60_000) }];
    resetMocks();
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'WAKE: no-op — nothing moved since the last wake.', parts: [], receipts: [] });
    await runWake('chat-ct-observe-next-2');
    expect(String(orchestratorCalls()[0].doctrineOverride ?? '')).not.toContain(PRIOR_BLOCK);
  });

  it('DEFAULT: a routine note with no screen claim and no computer_task call writes no row at all', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
    const note = 'Applied the computer_task claim-check fix to main via PR #1301; CI green.\n\nOpened a Screen Recording permission ticket (1a2b3c4d).';
    const parts = [
      { type: 'tool_call', name: 'merge_pull_request', args: { pr: 1301 } }, { type: 'tool_result', name: 'merge_pull_request', result: 'Merged #1301.' },
      { type: 'tool_call', name: 'file_feedback', args: {} }, { type: 'tool_result', name: 'file_feedback', result: 'Filed ticket 1a2b3c4d.' },
    ];
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts, receipts: [] });
    await runWake('chat-ct-observe-routine');
    expect(assistantWrites()[0].content).toBe(note);
    expect(verdictRows()).toHaveLength(0);
    expect(strikeRows()).toHaveLength(0);
  });

  it('DEFAULT: a computer_task call with no claim still writes a row (reason no_claims) — the denominator for the false-positive rate', async () => {
    const note = 'Camera-read via computer_task (observe-only, owner active): the saved policy JSON has no tag:agx rule.\n\nOpened ticket 1a2b3c4d with the screen read attached and saved the computer_task result header in it.';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: ctParts(OBSERVE), receipts: [] });
    await runWake('chat-ct-observe-noclaim');
    expect(assistantWrites()[0].content).toBe(note);
    expect(verdictRows()).toHaveLength(1);
    expect(verdictRows()[0].meta).toMatchObject({ unbacked: false, reason: 'no_claims', found: 0, totalCalls: 1, annotated: false });
  });

  it('kill switch COMPUTER_TASK_CLAIM_CHECK_DISABLED=1: no row of either kind, delivered as written (today byte-for-byte) — also with the opt-in set', async () => {
    process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED = '1';
    process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED = '1';
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
    await runWake('chat-ct-off');
    expect(assistantWrites()[0].content).toBe(NOTE);
    expect(verdictRows()).toHaveLength(0);
    expect(strikeRows()).toHaveLength(0);
    expect(mockGenerateOwnerBriefing).toHaveBeenCalled();
  });

  it('a HUMAN turn on the supervisor chat and a PLAIN chat\'s machine wake write nothing', async () => {
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
    await runWake('chat-ct-human', { human: true });
    expect(assistantWrites()[0].content).toBe(NOTE);
    expect(verdictRows()).toHaveLength(0);
    resetMocks();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'My plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' }));
    (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
    await runWake('chat-ct-plain');
    expect(assistantWrites()[0].content).toBe(NOTE);
    expect(verdictRows()).toHaveLength(0);
  });

  // ── the opt-in: COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 (the round-3 annotation, with the round-4 fixes) ─────────
  describe('opt-in COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1', () => {
    beforeEach(() => { process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED = '1'; });

    it('THE INCIDENT: delivered as written + ONE annotation, one guard_strike row + one verdict row (annotated), no reject-back, briefed with the claims marked', async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
      const events = await runWake('chat-ct-incident');
      expect(orchestratorCalls()).toHaveLength(1);
      const content: string = assistantWrites()[0].content;
      expect(content.startsWith(NOTE)).toBe(true);
      const annotation = content.slice(NOTE.length).trim();
      expect(annotation.split('\n')[0]).toBe(ANNOTATION_HEADER);
      expect(annotation).toMatch(/observe-only/);
      expect(annotation).toContain("Drove the owner's Mac via computer_task");
      expect(annotation).not.toMatch(/\n\s*\n/);
      expect(events.find((e) => e.type === 'complete')!.data.finalText).toBe(content);
      expect(strikeRows()).toHaveLength(1);
      expect(strikeRows()[0].meta).toMatchObject({ outcome: 'annotated', strike: 'computer_task_claim_unbacked', reason: 'no_input_possible', claims: 1, calls: { observe_only: 1 }, supervisorScope: 'project' });
      expect(verdictRows()).toHaveLength(1);
      expect(verdictRows()[0].meta).toMatchObject({ unbacked: true, mode: 'annotate', annotated: true });
      expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
      expect(String(mockGenerateOwnerBriefing.mock.calls[0][0].noteContent)).toContain('- [screen input] "Drove the owner\'s Mac via computer_task');
    });

    it('with the briefing filter OFF (BRIEFING_UNVERIFIED_FILTER_DISABLED=1 — nothing would mark the claims) the annotated wake does not brief', async () => {
      process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED = '1';
      try {
        (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
        await runWake('chat-ct-filter-off');
        expect(strikeRows()).toHaveLength(1);
        expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
      } finally {
        delete process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED;
      }
    });

    it('round-3 reviewer 2 replay (1): Fleet Supervisor platform work naming computer_task / Screen Recording — untouched, briefed, no row', async () => {
      mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'Fleet Supervisor', isSupervisor: true, userId: 'u1' }));
      const note = 'Applied the computer_task claim-check fix to main via PR #1301; CI green …\n\nOpened a Screen Recording permission ticket (1a2b3c4d) …';
      const parts = [
        { type: 'tool_call', name: 'merge_pull_request', args: { pr: 1301 } }, { type: 'tool_result', name: 'merge_pull_request', result: 'Merged #1301.' },
        { type: 'tool_call', name: 'file_feedback', args: {} }, { type: 'tool_result', name: 'file_feedback', result: 'Filed ticket 1a2b3c4d.' },
      ];
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts, receipts: [] });
      await runWake('chat-ct-r2-replay-1');
      expect(assistantWrites()[0].content).toBe(note);
      expect(strikeRows()).toHaveLength(0);
      expect(verdictRows()).toHaveLength(0);
      expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
    });

    it('round-3 reviewer 2 replay (2): an observe-only camera read + "saved the computer_task result header" — untouched (the compliant behaviour the block asks for)', async () => {
      const note = 'Camera-read the policy editor via computer_task (observe-only, owner active): the saved JSON has no tag:agx rule.\n\nOpened ticket 1a2b3c4d with the screen read attached and saved the computer_task result header in it.';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: note, parts: ctParts(OBSERVE), receipts: [] });
      await runWake('chat-ct-r2-replay-2');
      expect(assistantWrites()[0].content).toBe(note);
      expect(strikeRows()).toHaveLength(0);
      expect(verdictRows()[0].meta).toMatchObject({ reason: 'no_claims', annotated: false });
    });

    it('round-3 reviewer 1 replay (the retraction loop): wake 2\'s retraction is never mined — no annotation, no strike; wake 3 gets no block from it', async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
      await runWake('chat-ct-loop-1');
      const w1: string = assistantWrites()[0].content;
      expect(w1).toContain(ANNOTATION_HEADER);
      priorRows = [{ id: 'msg-loop-1', content: w1, metadata: { origin: 'schedule', engine: 'agent' }, createdAt: new Date(Date.now() - 120_000) }];
      resetMocks();
      const retraction = 'Correction: the 17:12Z note said I clicked Save on the Mac. That never happened.';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: retraction, parts: [], receipts: [] });
      await runWake('chat-ct-loop-2');
      expect(String(orchestratorCalls()[0].doctrineOverride)).toContain(PRIOR_BLOCK); // wake 2 saw the opt-in block
      expect(assistantWrites()[0].content).toBe(retraction);
      expect(strikeRows()).toHaveLength(0);
      expect(verdictRows()).toHaveLength(0); // no claim, no computer_task call
      priorRows = [{ id: 'msg-loop-2', content: retraction, metadata: { origin: 'schedule', engine: 'agent' }, createdAt: new Date(Date.now() - 60_000) }, ...priorRows];
      resetMocks();
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: 'WAKE: no-op — nothing moved since the last wake.', parts: [], receipts: [] });
      await runWake('chat-ct-loop-3');
      expect(String(orchestratorCalls()[0].doctrineOverride ?? '')).not.toContain(PRIOR_BLOCK);
    });

    it('the honest wording the fix asks for ("Clicked nothing on the Mac this turn") is never annotated', async () => {
      const honest = 'Camera-read via computer_task (observe-only, owner active). Clicked nothing on the Mac this turn — the saved policy JSON shows no tag:agx rule, so the earlier edit did not happen.';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: honest, parts: ctParts(OBSERVE), receipts: [] });
      await runWake('chat-ct-honest');
      expect(assistantWrites()[0].content).toBe(honest);
      expect(strikeRows()).toHaveLength(0);
      expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
    });

    it('the re-post shape: the note says it drove the Mac and the run made NO computer_task call ⇒ annotated (no_computer_task_call)', async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: [], receipts: [] });
      await runWake('chat-ct-nocall');
      expect(assistantWrites()[0].content).toMatch(/made no computer_task call/);
      expect(strikeRows()[0].meta.reason).toBe('no_computer_task_call');
    });

    it('a FULL-CONTROL session with input backs the claims ONLY when the note quotes its harness counters inline (part (c)); a PLAN sentence is not annotated', async () => {
      // PART (c) of ticket 4c7aebf7: NOTE names the action and cites none of FULL's counters ⇒ unbacked.
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(FULL), receipts: [] });
      await runWake('chat-ct-full-unquoted');
      expect(assistantWrites()[0].content).toMatch(/harness counters the note does not quote inline/);
      expect(verdictRows()[0].meta).toMatchObject({ unbacked: true, reason: 'counters_not_quoted', missingQuotes: 5 });
      resetMocks();
      // …and the same run with the counters quoted inline is NOT annotated (delivered as written, reason 'backed').
      const quoted = `${NOTE}\n\nHarness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 displays=1 probe=1/1 input-proven.`;
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: quoted, parts: ctParts(FULL), receipts: [] });
      await runWake('chat-ct-full');
      expect(assistantWrites()[0].content).toBe(quoted);
      expect(strikeRows()).toHaveLength(0);
      expect(verdictRows()[0].meta).toMatchObject({ unbacked: false, reason: 'backed' });
      resetMocks();
      const plan = 'Next: I will click Save in the Tailscale admin console on the Mac once the owner is away — the session this wake was camera-only.';
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: plan, parts: ctParts(OBSERVE), receipts: [] });
      await runWake('chat-ct-plan');
      expect(assistantWrites()[0].content).toBe(plan);
      expect(strikeRows()).toHaveLength(0);
    });

    it('the annotation is a strike for the next machine turn\'s [PRIOR NOTE STRUCK] block (screen-claims wording) — and a RE-POST of it is never bounced', async () => {
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: ctParts(OBSERVE), receipts: [] });
      await runWake('chat-ct-next-1');
      const stored: string = assistantWrites()[0].content;
      priorRows = [{ id: 'msg-ct-1', content: stored, metadata: { origin: 'schedule', engine: 'agent' }, createdAt: new Date(Date.now() - 60_000) }];
      resetMocks();
      (runCodingAgent as jest.Mock).mockResolvedValueOnce({ finalText: NOTE, parts: [], receipts: [] });
      await runWake('chat-ct-next-2');
      expect(orchestratorCalls()).toHaveLength(1); // never a reject-back on this check's strike
      const doctrine = String(orchestratorCalls()[0].doctrineOverride);
      expect(doctrine).toContain(PRIOR_BLOCK);
      expect(doctrine).toContain("Drove the owner's Mac via computer_task");
      expect(doctrine).toMatch(/do not redo other work \(tickets, sessions, messages\)/);
      const content: string = assistantWrites()[0].content;
      expect(content).toMatch(/made no computer_task call/);
      expect(content).not.toContain('near-verbatim copy');
      const repeat = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'struck_note_repeat');
      expect(repeat).toHaveLength(1); // round 4: the ineligible prior is measured …
      expect(repeat[0].meta).toMatchObject({ outcome: 'ineligible', reason: 'prior_screen_claims_only', wouldRepeat: true }); // … never acted on
      expect(repeat[0].meta.lineage).toBeUndefined();
    });
  });
});

// ── Ghost mode (owner 2026-10-22): a ghost chat routes EVERY leg to the admin
// designation and stays out of the cloud side-channels. Pinned here end-to-end
// through the real run seam (startDetachedChatRun → the seat block), with the
// designation service mocked at its store boundary. ─────────────────────────
describe('ghost mode routing + privacy (owner 2026-10-22)', () => {
  const workerMock = runChatWorker as jest.Mock;
  const agentMock = runCodingAgent as jest.Mock;
  const genTitle = moonshotIntegration.generateTitle as jest.Mock;
  const updateContext = jest.requireMock('../langgraph/memory.graph').updateContextAsync as jest.Mock;

  beforeEach(() => {
    workerMock.mockReset(); agentMock.mockReset(); genTitle.mockReset(); updateContext.mockReset();
    workerMock.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    agentMock.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
    genTitle.mockImplementation(async () => 'A Ghost Title');
    updateContext.mockImplementation(async () => {});
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' }));
    clearGhostEndpointCache();
    delete process.env.CHAT_GHOST_MODE_DISABLED;
  });
  afterEach(() => { clearGhostEndpointCache(); delete process.env.CHAT_GHOST_MODE_DISABLED; });

  it('GHOST ONE-LEAD (owner 2026-11-03): a signed-in ghost chat runs the lead ONLY — exactly one model call, no checker', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    // The chat row says ghost. findUnique serves every consumer in the run —
    // the seat seam's read carries ghostMode:true.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: true }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-1', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));

    // The lead ran on the designated abliterated endpoint…
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.model).toBe('homelab:abliterated-llama-70b');
    // …and the Double Checker NEVER spawned. Pre-ruling this chat ran the peer
    // checker on the same spec ('thinking' ⇒ preset spawnChecker true); the
    // owner's 2026-11-03 ruling retired that second inference outright.
    expect(workerMock).not.toHaveBeenCalled();
  });

  it('GHOST ONE-LEAD: a guest ghost send makes exactly one model call on the designation — no checker', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: null, chatId: null, sessionId: 'anon-ghost-one', ghost: true });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.model).toBe('homelab:abliterated-llama-70b');
    // A guest ghost send ALSO asked for 'thinking' — still one call, no checker.
    expect(workerMock).not.toHaveBeenCalled();
  });

  it('GHOST ONE-LEAD: a ghost research-rung turn does not promise findings that will never post', async () => {
    // Review finding (2026-11-04): `if (args.escalation?.rung === 'research')
    // send('progress', keyedProgress('deeper_findings_started'))` told the user
    // "Deeper findings will post here as a new message when they're ready…" —
    // but the ghost collapse forces council 'none' and `isCouncil` false, so
    // nothing would ever post them. Same defect class as the Double Checker
    // banner: a status line advertising a second model that will not run.
    // Pinned here as a source predicate so a later refactor cannot drop it.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'chat-agent.service.ts'), 'utf8');
    expect(src).toContain('if (!ghostSingleModel) send(\'progress\', keyedProgress(\'deeper_findings_started\'));');
  });

  it('GHOST ONE-LEAD: a ghost run makes one model call, so there is no second inference for a banner to describe', async () => {
    // The banner is `STATUS.lane.checked` / `PROGRESS_LINES.second_opinion`,
    // both keyed on `spawnChecker` (chat-agent.service.ts:3773 & :4286). The
    // end-to-end proof is the call-count assertion: the SSE harness is not
    // exposed to this suite, so instead of grepping a stream it cannot see,
    // this case pins the SEAM the banner keys on — a ghost run's plan reaches
    // the roster collapsed, and shouldSpawnChecker refuses it structurally.
    // (ghost-runtime.test.ts pins the pure collapse + the refusal directly.)
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: true }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-banner', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    // The owner's report verbatim: "Thinking 28s / 2 steps / Digby is digging
    // in — the Double Checker is researching alongside…". One model call, so
    // there is no second inference for a banner to describe.
    expect(agentMock).toHaveBeenCalledTimes(1);
    expect(workerMock).not.toHaveBeenCalled();
  });

  it('a NON-ghost chat is untouched: the normal seats resolve (kimi-k3 lead) and the checker still runs', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: false }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-plain-1', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.model).toBe('kimi-k3');
    // Non-ghost behaviour is PRESERVED: 'thinking' still spawns the Double Checker.
    expect(workerMock).toHaveBeenCalled();
  });

  it('a ghost chat with NO designation keeps the normal lineup (never a throw) and skips the extractors', async () => {
    setGhostDesignationForTests(null);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: true }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-2', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    // normal lineup stands…
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.model).toBe('kimi-k3');
    // …the privacy gates fired: no title generation, no memory extraction.
    expect(genTitle).not.toHaveBeenCalled();
    expect(updateContext).not.toHaveBeenCalled();
  });

  it('a GUEST ghost send (args.ghost, no chat row) routes the lead to the designation too', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: null, chatId: null, sessionId: 'anon-ghost-sid', ghost: true });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.model).toBe('homelab:abliterated-llama-70b');
  });

  it('the kill switch CHAT_GHOST_MODE_DISABLED=1 makes a ghost chat run its normal lineup', async () => {
    process.env.CHAT_GHOST_MODE_DISABLED = '1';
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: true }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-3', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    const orch = agentMock.mock.calls.at(-1)?.[0];
    expect(orch.model).toBe('kimi-k3');
  });

  // ── Ticket de60115d (2026-10-23, "ghost mode chat title not working"):
  // the ghost skip dropped title generation entirely, so a ghost chat kept the
  // raw truncated first message (or 'New chat') forever. A ghost first turn
  // now gets the SAME title lifecycle via generateGhostTitle — the designated
  // endpoint when one is live, else the local cleaner — and the CLOUD title
  // chain (generateTitle → utilityChat) stays untouched. ────────────────────
  const ghostTitle = moonshotIntegration.generateGhostTitle as jest.Mock;
  const EMPTY_CTX = { queryMessage: 'the question', systemContext: '', conversationHistory: [] as any[], projectId: null };
  const FULL_CTX_GHOST = { queryMessage: 'the question', systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }] as any[], projectId: null };

  /** Stateful CAS row (the PR #367 idiom): title reads see storedTitle,
   * updateMany with a mismatched where.title CAS-fails like the real DB. */
  function statefulGhostRow(stored0: string) {
    let storedTitle = stored0;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: storedTitle, isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: true }));
    mockPrisma.crossModelChat.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.title !== undefined && where.title !== storedTitle) return { count: 0 };
      if (data?.title) storedTitle = data.title;
      return { count: 1 };
    });
    return () => { mockPrisma.crossModelChat.updateMany.mockImplementation(async () => ({ count: 1 })); };
  }

  it('de60115d: a ghost chat FIRST turn writes a real title via generateGhostTitle — never the cloud chain', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    ghostTitle.mockClear(); genTitle.mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear(); // earlier tests in this describe leave writes behind
    (buildChatQueryContext as jest.Mock).mockResolvedValue(EMPTY_CTX); // first turn → the title gate is live
    const restore = statefulGhostRow('New Chat'); // stock stale placeholder
    try {
      const events: Array<{ type: string; data: any }> = [];
      const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-title', sessionId: null });
      subscribeRun(key!, e => events.push(e));
      await waitFor(() => !isRunActive(key!));
      await new Promise(r => setTimeout(r, 100));
      // The ghost title chain fired ONCE (up-front); the repair read the
      // landed real title and stood down (not stale) — exactly one write.
      expect(ghostTitle).toHaveBeenCalledTimes(1);
      expect(ghostTitle).toHaveBeenCalledWith('the question', '', 'homelab:abliterated-llama-70b');
      // The privacy pin (inverted from the pre-fix behavior): the CLOUD chain
      // never fires on a ghost run.
      expect(genTitle).not.toHaveBeenCalled();
      const titled = events.find(e => e.type === 'chat-title');
      expect(titled?.data).toEqual({ chatId: 'chat-ghost-title', title: 'A Ghost Title' });
      const writes = mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);
      expect(writes).toHaveLength(1);
      expect(writes[0][0].data.title).toBe('A Ghost Title');
    } finally {
      restore();
      (buildChatQueryContext as jest.Mock).mockResolvedValue(FULL_CTX_GHOST);
    }
  });

  it('de60115d: a ghost chat with NO designation still titles LOCALLY (spec null) and never touches the cloud chain', async () => {
    setGhostDesignationForTests(null);
    ghostTitle.mockClear(); genTitle.mockClear();
    (buildChatQueryContext as jest.Mock).mockResolvedValue(EMPTY_CTX);
    const restore = statefulGhostRow('New Chat');
    try {
      const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-title-nd', sessionId: null });
      await waitFor(() => !isRunActive(key!));
      await new Promise(r => setTimeout(r, 100));
      // generateGhostTitle called with a NULL spec (the local-cleaner arm)…
      expect(ghostTitle).toHaveBeenCalledWith('the question', '', null);
      expect(genTitle).not.toHaveBeenCalled();
      const writes = mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[0][0].data.title).toBe('A Ghost Title');
    } finally {
      restore();
      (buildChatQueryContext as jest.Mock).mockResolvedValue(FULL_CTX_GHOST);
    }
  });

  it('de60115d: a GUEST ghost first turn ships chat-title + autoTitle via generateGhostTitle', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    ghostTitle.mockClear(); genTitle.mockClear();
    (buildChatQueryContext as jest.Mock).mockResolvedValueOnce(EMPTY_CTX);
    const events: Array<{ type: string; data: any }> = [];
    const sid = '5f1e2d3c-4b5a-4697-8877-665544332211';
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: null, chatId: null, sessionId: sid, ghost: true });
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => events.some(e => e.type === 'complete' || e.type === 'error'));
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 100));
    expect(ghostTitle).toHaveBeenCalledWith('the question', '', 'homelab:abliterated-llama-70b');
    expect(genTitle).not.toHaveBeenCalled();
    const titled = events.find(e => e.type === 'chat-title');
    expect(titled?.data).toEqual({ chatId: null, sessionId: sid, title: 'A Ghost Title' });
    expect(events.find(e => e.type === 'complete')!.data.autoTitle).toBe('A Ghost Title');
  });

  it('de60115d (review f2/f4): a ghost run whose chat flag was turned OFF mid-run — the ghost repair stands down and NOTHING titles that turn', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    ghostTitle.mockClear(); genTitle.mockClear();
    mockPrisma.crossModelChat.updateMany.mockClear();
    // First turn (up-front arm): the row says ghost, title is the stale
    // placeholder → the up-front arm fires. Then the user turns ghost OFF
    // mid-run: the run-end repair's re-read (select.ghostMode) must see
    // ghostMode:false and STAND DOWN — no cloud generateTitle either (the
    // run-start ghostRun still masks the normal arm for THIS turn).
    let ghostFlag = true;
    let storedTitle = 'New Chat';
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.isSupervisor && !select?.title) return { isSupervisor: false };
      return {
        title: storedTitle,
        isSupervisor: false,
        ...(select?.ghostMode !== undefined ? { ghostMode: ghostFlag } : {}),
      };
    });
    mockPrisma.crossModelChat.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.title !== undefined && where.title !== storedTitle) return { count: 0 };
      if (data?.title) storedTitle = data.title;
      return { count: 1 };
    });
    try {
      (buildChatQueryContext as jest.Mock).mockResolvedValue(EMPTY_CTX);
      const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-off-midrun', sessionId: null });
      // flip ghost off AFTER the run started, BEFORE the run-end repair reads
      await new Promise(r => setTimeout(r, 30));
      ghostFlag = false;
      await waitFor(() => !isRunActive(key!));
      await new Promise(r => setTimeout(r, 150));
      // The up-front ghost arm fired exactly once (the only title write this
      // turn) and the repair re-read stood down: generateGhostTitle called
      // once, generateTitle (cloud) NEVER — mid-run flag flips must not leak
      // the turn's content to the cloud chain retroactively.
      expect(ghostTitle).toHaveBeenCalledTimes(1);
      expect(genTitle).not.toHaveBeenCalled();
      const writes = mockPrisma.crossModelChat.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.title);
      expect(writes).toHaveLength(1);
      expect(writes[0][0].data.title).toBe('A Ghost Title');
    } finally {
      (buildChatQueryContext as jest.Mock).mockResolvedValue(FULL_CTX_GHOST);
      mockPrisma.crossModelChat.updateMany.mockImplementation(async () => ({ count: 1 }));
    }
  });
});

// ── Ghost privacy hardening (adversarial review B1–B6/M1/M3/M4/M6): the
// cloud side-channels a ghost turn must never touch. Pinned at the seam each
// finding named, so a future refactor cannot silently re-open one. ──────────
describe('ghost mode privacy hardening (review B1–B6)', () => {
  const workerMock2 = runChatWorker as jest.Mock;
  const agentMock2 = runCodingAgent as jest.Mock;

  beforeEach(() => {
    workerMock2.mockReset(); agentMock2.mockReset();
    workerMock2.mockImplementation(async () => ({ finalText: 'PEER-DRAFT', parts: [] }));
    agentMock2.mockImplementation(async () => ({ finalText: 'A'.repeat(500), parts: [] }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'New Chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', leadModel: null, projectId: null, ghostMode: true }));
    clearGhostEndpointCache();
    delete process.env.CHAT_GHOST_MODE_DISABLED;
  });

  it('B5: a ghost run with images never calls the cloud image describer — the peers get the honest ghost note', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    const describeSpy = jest.fn();
    jest.doMock('../image-describe', () => ({ describeImageWithVision: describeSpy }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-img', sessionId: null, userImages: [{ name: 'x.png', mediaType: 'image/png', data: Buffer.from('fake').toString('base64') }] });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(describeSpy).not.toHaveBeenCalled();
  });

  it('B3: a ghost thinking turn never generates cloud backstop follow-ups', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    const genFollowUps = (moonshotIntegration.generateFollowUps as unknown as jest.Mock);
    genFollowUps.mockClear();
    genFollowUps.mockResolvedValue({ followUps: ['q1'] });
    const key = await startDetachedChatRun({ ...BASE, mode: 'thinking', userId: 'u1', chatId: 'chat-ghost-fu', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(genFollowUps).not.toHaveBeenCalled();
  });

  it('B6/M1: a ghost run whose orchestrator returns EMPTY never re-runs the turn on the built-in seat (kimi-k3)', async () => {
    setGhostDesignationForTests('homelab:abliterated-llama-70b');
    // First call: the ghost model "returns no output" (the empty/capability-reject shape
    // that triggers the seat-fallback recovery). If the recovery re-ran on kimi-k3
    // there would be a SECOND runCodingAgent call with model 'kimi-k3'.
    agentMock2.mockImplementationOnce(async () => ({ finalText: '', parts: [] }));
    const key = await startDetachedChatRun({ ...BASE, mode: 'single_thinking', userId: 'u1', chatId: 'chat-ghost-empty', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    const models = agentMock2.mock.calls.map(([i]: any[]) => i.model);
    // The privacy property: EVERY orchestrator call on a ghost run — including
    // any empty-answer retry — stays on the designated model. Never a cloud
    // built-in. (A same-model retry is fine; the leak is a kimi-k3 rerun.)
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m: string) => m === 'homelab:abliterated-llama-70b')).toBe(true);
    expect(models).not.toContain('kimi-k3');
  });
});
