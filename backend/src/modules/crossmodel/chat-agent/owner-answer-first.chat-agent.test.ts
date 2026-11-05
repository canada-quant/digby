/**
 * build 2026-10-08 A1 — answer-first on OWNER turns in supervisor chats: the chat-agent seams (owner-answer-first.ts).
 *  - CANARY DEFAULT (since 2026-10-10, ticket 4f7263e4): unset/blank ⇒ act on the default canary list (Schooltime
 *    41bd202a + StAnne 99e63f86); an UNLISTED supervisor chat runs byte-for-byte as before (shadow) — the describe
 *    below drives one such chat (abcdef12), so the shadow-path assertions hold under the default; any other
 *    unrecognized value fails SAFE to shadow (review F1);
 *  - ACT (canary / act): the soft deadline collapses the turn after its first tool round, the "Follow-through:" line
 *    becomes the follow-through continuation (reason answer_first_split, the brief, the answer turn's mutating calls),
 *    the closing is rewritten, the OWNER ASK closes only when the follow-through settles;
 *  - the ROUND: posts the result, closes the ask (source 'continuation'), counts duplicate dispatches; an owner
 *    message that PREEMPTS it re-queues it (held until the owner's turn starts), a Stop does not, the cap holds;
 *  - the DRAIN: an answer-first round is never superseded or material-gated; a plain one still is (control).
 * Harness copied from chat-agent.wake-ledger.w6.test.ts (itself from chat-agent.service.test.ts).
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
    // deleteMany({ id: { in } }). Delegate to `delete` — `useQueue` overrides
    // THAT to actually remove the row, so the consume is visible to findFirst
    // (a static {count} stub left the row served forever → unbounded drain).
    deleteMany: jest.fn(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? (where?.id ? [where.id] : []);
      for (const id of ids) await mockPrisma.pendingChatMessage.delete({ where: { id } });
      return { count: ids.length };
    }),
    // shutdown re-queue (2026-09-11) — enqueueChatMessage counts then creates.
    count: jest.fn(async () => 0), create: jest.fn(async (a: any) => ({ id: 'pend-1', ...a.data })),
  },
  // chat-busy's durable layer (worker-tier coding runs) — none in these tests.
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  // MERGE-1 kill-window fix (2026-11-05): createMessagesConsumingPending runs
  // the transcript write and the queue-row consume in ONE $transaction.
  // Buffered/all-or-nothing like the real client and the sibling drain suites:
  // a throw leaves the queue row intact (the LOSS half).
  $transaction: jest.fn(async (fn: any) => {
    // Delegate to the SAME per-test mocks the non-transactional path uses, so
    // `useQueue`'s delete actually removes the row (recording the ids without
    // deleting left findFirst serving the same row forever — an infinite drain).
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
const mockFindUnreadProductionState: jest.Mock = jest.fn((): any[] => []);
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
  // PRODUCTION-STATE UNREAD lane (supervisor doctrine audit D1, 2026-09-27):
  // the seam calls the pure matcher after the guard; stubbed here (default
  // no hits) — the matcher is pinned in its own suite
  // (action-verifier.production-state.2026-09-27.test.ts).
  findUnreadProductionStateClaims: (...a: any[]) => mockFindUnreadProductionState(...a),
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
    SUPERVISOR_HARNESS_RECEIPTS: 'supervisor_harness_receipts', // the follow-through harness line (2026-10-22)
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


const mockBuildWakeLedgerBlock: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockOnSupervisorRunFinalized: jest.Mock = jest.fn(async () => {});
const mockMaterialGateForDrain: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockAckMaterialGateDrain: jest.Mock = jest.fn(async () => true);
const mockRecordAgreement: jest.Mock = jest.fn();
const mockCloseStashes: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/supervisor-wake-ledger', () => ({
  __esModule: true,
  buildWakeLedgerBlock: (...a: any[]) => mockBuildWakeLedgerBlock(...a),
  onSupervisorRunFinalized: (...a: any[]) => mockOnSupervisorRunFinalized(...a),
  materialGateForDrain: (...a: any[]) => mockMaterialGateForDrain(...a),
  ackMaterialGateDrain: (...a: any[]) => mockAckMaterialGateDrain(...a),
  recordMaterialGateAgreement: (...a: any[]) => mockRecordAgreement(...a),
  closeStashesForGateSkip: (...a: any[]) => mockCloseStashes(...a),
}));

// build 2026-10-08 A1: the owner-ask close is observed at the supervisor-state boundary (the rest of the module is real).
const mockCloseAskOnReply: jest.Mock = jest.fn(async () => true);
jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/supervisor-state.service'),
  closeAskOnReply: (...a: any[]) => mockCloseAskOnReply(...a),
}));

// Follow-through minors review fix (2026-10-22, item 2): phase 2's applyHarnessReceipts is wrapped so a test can make it
// THROW after the follow-through strip (the finalize catches it: 'harness receipts append skipped'). The default
// delegates to the real leaf (set in beforeEach), so every other test runs the real record.
const mockApplyHarnessReceipts: jest.Mock = jest.fn();
jest.mock('../platform/harness-receipts', () => {
  const actual = jest.requireActual('../platform/harness-receipts');
  return { __esModule: true, ...actual, applyHarnessReceipts: (...a: any[]) => mockApplyHarnessReceipts(...a) };
});

import { startDetachedChatRun, drainChatQueue } from './chat-agent.service';
import { __resetDrainAttemptLedgerForTests } from './message-queue.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive, cancelRun, subscribeRun } from '../coding/live-runs';
import { buildChatQueryContext } from './chat-context';
import { markChatRunPreempted, setFollowThroughHold, followThroughHoldMs, ANSWER_FIRST_RESUME_NOTE, ANSWER_FIRST_NOT_A_WAKE_LINE } from './owner-answer-first';
import { continuationPrompt, type ContinuationRun } from './turn-continuation';
import { harnessLineKind, harnessNoteKind, HARNESS_NOOP_LINE, HARNESS_RECORD_ZERO_LINE } from '../platform/harness-receipts';
import { isNoopOnlyReply, isSupervisorReplyRow } from '../fleet/supervisor-reply-row';
import { EMPTY_RUN_FALLBACK_NOTE } from '../coding/harness-error-notes';

/** Iteration-bounded wait — the tests move Date.now (the soft deadline's clock), so a wall-clock wait would misfire. */
async function waitFor(pred: () => boolean, iterations = 400): Promise<void> {
  for (let i = 0; i < iterations && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for the run');
}

// The deadline clock: Date.now = real + skew; a mocked step "takes" time by bumping the skew.
let skew = 0;
const realNow = Date.now.bind(Date);
let nowSpy: jest.SpyInstance;

const SUP = 'abcdef12-1111-4111-8111-000000000001'; // a project supervisor chat (the canary list names its 8-hex prefix)
const SUP_ROW = { id: SUP, title: 'Schooltime Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1', projectId: 'p1', leadModel: null };
const OWNER = { message: 'message the tt-rd supervisor about the camera plan and tell me where we are', mode: 'thinking' as const, userId: 'u1', sessionId: null };

let created: any[] = [];
const writes = () => created;
const assistantRow = () => writes().filter((d: any) => d?.role === 'assistant').pop();
const queued = () => mockPrisma.pendingChatMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => String(d?.content ?? '').startsWith('[HARNESS CONTINUATION'));
const metric = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === kind).pop();
const SPLIT_ANSWER = 'Where we are: three of four cameras recorded 15:47–16:17Z. The tt-rd supervisor has not been messaged yet — nothing went out in this answer.\n\nFollow-through: message the tt-rd supervisor (d1d0b346) with the camera plan; read back its reply';
const FULL_ANSWER = 'Where we are: three of four cameras recorded 15:47–16:17Z; the tt-rd lane is idle and its todo is open.';

/** A mocked lead: step 0 calls tools, the step takes `stepMs`, then the next step's poll decides (split or not). */
function leadRun(opts: { stepMs: number; split: string; noSplit: string; tools?: Array<{ name: string; args: any }> }) {
  return async (input: any) => {
    const hook: (() => string | null) | undefined = input.endTurnAfterToolRound;
    const polls: Array<string | null> = [];
    polls.push(hook ? hook() : null); // step 0 — never splits
    const tools = opts.tools ?? [{ name: 'get_chat_status', args: { chatId: 'd1d0b346-2222' } }, { name: 'todo_create', args: { title: 'Record all 4 cameras' } }];
    const parts: any[] = [];
    for (const t of tools) { input.emit('tool_call', t); parts.push({ type: 'tool_call', name: t.name, args: t.args }); parts.push({ type: 'tool_result', name: t.name, result: 'ok' }); }
    skew += opts.stepMs;
    const notice = hook ? hook() : null; // step 1
    polls.push(notice);
    const text = notice ? opts.split : opts.noSplit;
    leadPolls.push(polls);
    return { finalText: text, parts: [...parts, { type: 'text', text }] };
  };
}
let leadPolls: Array<Array<string | null>> = [];

beforeEach(() => {
  skew = 0;
  leadPolls = [];
  // Module-level drain ledger (MERGE-1 rework): this fixture mints the SAME row
  // id ('pend-af') in every case, so attempts would otherwise carry over.
  __resetDrainAttemptLedgerForTests();
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
  redisStore.clear();
  redisLists.clear();
  delete process.env.SUPERVISOR_OWNER_ANSWER_FIRST;
  (runCodingAgent as jest.Mock).mockReset().mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
  mockCloseAskOnReply.mockClear();
  mockApplyHarnessReceipts.mockReset().mockImplementation((...a: any[]) => jest.requireActual('../platform/harness-receipts').applyHarnessReceipts(...a));
  mockRecordLoopMetric.mockClear();
  mockMaterialGateForDrain.mockClear();
  let n = 0;
  created = [];
  mockPrisma.crossModelMessage.create.mockReset().mockImplementation(async (a: any) => {
    const r = { id: a?.data?.id ?? `row-${a?.data?.role}-${++n}`, createdAt: new Date(), ...(a?.data ?? {}) };
    created.push(r);
    return r;
  });
  mockPrisma.crossModelMessage.findFirst = jest.fn(async (a: any) => ({ id: a?.where?.id ?? 'row-x', content: 'x', parts: [], metadata: {} }));
  mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
  mockPrisma.crossModelMessage.findUnique = jest.fn(async () => null);
  mockPrisma.crossModelMessage.update = jest.fn(async () => ({}));
  mockPrisma.pendingChatMessage.create.mockClear();
  mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.pendingChatMessage.delete.mockClear();
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => SUP_ROW);
  (buildChatQueryContext as jest.Mock).mockResolvedValue({ queryMessage: OWNER.message, systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }], projectId: 'p1' });
});
afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.SUPERVISOR_OWNER_ANSWER_FIRST;
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  mockPrisma.crossModelMessage.create.mockReset().mockImplementation(async () => ({}));
  for (const k of ['findFirst', 'findMany', 'findUnique', 'update']) delete mockPrisma.crossModelMessage[k];
});

async function ownerTurn(chatId: string = SUP) {
  const key = await startDetachedChatRun({ ...OWNER, chatId });
  expect(key).toBe(`chat:${chatId}`);
  await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
  await waitFor(() => !isRunActive(key!));
  await waitFor(() => !!metric('owner_answer_first') || process.env.SUPERVISOR_OWNER_ANSWER_FIRST === 'off');
  await new Promise((r) => setTimeout(r, 30));
  return key!;
}
const ownerRowId = () => String(writes().find((d: any) => d?.role === 'user')?.id ?? '');

describe('SHADOW (an unlisted chat under the canary default, ticket 4f7263e4) — the owner turn runs exactly as before and records where it would split', () => {
  it('a 50 s first step: no collapse, no follow-through, the ask closes on the answer; owner_answer_first carries wouldSplitAtMs + the moved work', async () => {
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
    await ownerTurn();
    expect(leadPolls[0]).toEqual([null, null]); // the hook only observes
    const input = (runCodingAgent as jest.Mock).mock.calls[0][0];
    expect(input.doctrineOverride).toContain('hard time budget (~2700s)');
    expect(input.doctrineOverride).not.toContain('ANSWER FIRST');
    expect(queued()).toHaveLength(0);
    expect(assistantRow().content).toBe(FULL_ANSWER);
    expect(assistantRow().metadata.ownerAnswerFirst).toEqual({ mode: 'shadow', split: true, armed: false });
    expect(mockCloseAskOnReply).toHaveBeenCalledWith(SUP, 'u1', expect.objectContaining({ askMessageId: ownerRowId() }));
    const m = metric('owner_answer_first');
    expect(m.sessionId).toBe(SUP);
    expect(m.meta).toMatchObject({ mode: 'shadow', setting: 'canary', scope: 'project', split: true, toolsBeforeSplit: 2, mutationsBeforeSplit: 1, totalTools: 2, armed: false, verdict: 'none' });
    expect(m.meta.wouldSplitAtMs).toBeGreaterThanOrEqual(50_000);
  });

  it("SUPERVISOR_OWNER_ANSWER_FIRST=off: no hook, no row stamp, no telemetry", async () => {
    process.env.SUPERVISOR_OWNER_ANSWER_FIRST = 'off';
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
    await ownerTurn();
    expect((runCodingAgent as jest.Mock).mock.calls[0][0].endTurnAfterToolRound).toBeUndefined();
    expect(assistantRow().metadata.ownerAnswerFirst).toBeUndefined();
    expect(metric('owner_answer_first')).toBeUndefined();
  });

  it('canary acts only on its listed chats — another supervisor stays shadow', async () => {
    process.env.SUPERVISOR_OWNER_ANSWER_FIRST = 'canary:99e63f86';
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
    await ownerTurn();
    expect(leadPolls[0]).toEqual([null, null]);
    expect(metric('owner_answer_first').meta).toMatchObject({ mode: 'shadow', setting: 'canary', canary: false });
  });
});

describe('ACT (canary) — answer at the soft deadline, the rest as the follow-through', () => {
  beforeEach(() => { process.env.SUPERVISOR_OWNER_ANSWER_FIRST = 'canary:abcdef12'; });

  it('splits after the first tool round, arms the follow-through with the brief, rewrites the closing, defers the ask close', async () => {
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
    await ownerTurn();
    expect(leadPolls[0][0]).toBeNull();
    expect(leadPolls[0][1]).toContain('[HARNESS NOTICE — not typed by the user] FINAL TURN: ANSWER FIRST');
    expect((runCodingAgent as jest.Mock).mock.calls[0][0].doctrineOverride).toContain('- ANSWER FIRST — the owner is waiting on this reply.');
    // the follow-through round is queued (schedule source, the continuation stash, the brief)
    expect(queued()).toHaveLength(1);
    const q = queued()[0];
    expect(q.source).toBe('schedule');
    expect(q.content).toMatch(/^\[HARNESS CONTINUATION r1\/3 task=\S+ of=\S+ reason=answer_first_split since=\S+ ask=\S+ af=0\]/);
    expect(q.content).toContain(`ask=${ownerRowId()} af=0]`);
    expect(q.content).toContain('ANSWER-FIRST FOLLOW-THROUGH');
    expect(q.content).toContain('It named: message the tt-rd supervisor (d1d0b346) with the camera plan; read back its reply.');
    expect(q.content).toContain('do NOT repeat: todo_create→"record all 4 cameras"');
    // 2026-10-22 minors: the round is told it finishes the owner's answer — never a WAKE: no-op close
    expect(q.content).toContain(ANSWER_FIRST_NOT_A_WAKE_LINE);
    // the answer: partial byte-identical, the harness line instead of the Follow-through line
    const a = assistantRow();
    expect(a.content).toBe('Where we are: three of four cameras recorded 15:47–16:17Z. The tt-rd supervisor has not been messaged yet — nothing went out in this answer.\n\nStill working on this in the background — message the tt-rd supervisor (d1d0b346) with the camera plan; read back its reply. I will post the result here.');
    expect(a.metadata.ownerAnswerFirst).toMatchObject({ mode: 'act', split: true, armed: true });
    expect(a.metadata.ownerAnswerFirst.taskId).toMatch(/^[0-9a-f-]{36}$/);
    // the ask is NOT closed on the split answer
    expect(mockCloseAskOnReply).not.toHaveBeenCalled();
    expect(metric('turn_continuation').meta).toMatchObject({ reason: 'answer_first_split', outcome: 'armed', answerFirst: true, resumes: 0 });
    expect(metric('owner_answer_first').meta).toMatchObject({ mode: 'act', canary: true, split: true, followThrough: 'items', armed: true, verdict: 'continue:answer_first_split', toolsBeforeSplit: 2 });
  });

  it('REVIEW F5 (ticket 4f7263e4): the first-word note coexists with the A1 ANSWER-FIRST line on an acting owner turn — both rows present, aligned, not contradictory', async () => {
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
    await ownerTurn();
    const doctrine = String((runCodingAgent as jest.Mock).mock.calls[0][0].doctrineOverride);
    // The A1 line (deadlineNote slot): answer at the soft deadline.
    expect(doctrine).toContain('- ANSWER FIRST — the owner is waiting on this reply.');
    // The first-word note (crossCheckBlock slot): open with one useful line.
    expect(doctrine).toMatch(/## First word[\s\S]*OPEN WITH ONE USEFUL LINE before your first tool call/);
    // Both rows on the same doctrine (the A1 canary lane this ticket's population shares).
    expect(doctrine.indexOf('## First word')).toBeGreaterThanOrEqual(0);
    expect(doctrine.indexOf('ANSWER FIRST')).toBeGreaterThanOrEqual(0);
    // The note's own first bullet accommodates answering from what the model already
    // holds ("Already certain? Open with the direct answer") — no forced tool call, so
    // the A1 "answer now" and the note "open with a line" never contradict.
    expect(doctrine).toMatch(/## First word[\s\S]*Already certain\? Open with the direct answer[\s\S]*ONE line, then your first tool call in the SAME turn/);
  });

  it('"Follow-through: none" arms nothing, drops the bare line and closes the ask on the answer', async () => {
    const none = 'All four cameras recorded 15:47–16:17Z; the tt-rd supervisor acknowledged at 16:20Z.\n\nFollow-through: none';
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: none, noSplit: FULL_ANSWER }));
    await ownerTurn();
    expect(queued()).toHaveLength(0);
    expect(assistantRow().content).toBe('All four cameras recorded 15:47–16:17Z; the tt-rd supervisor acknowledged at 16:20Z.');
    expect(assistantRow().metadata.ownerAnswerFirst).toEqual({ mode: 'act', split: true, armed: false });
    expect(mockCloseAskOnReply).toHaveBeenCalledWith(SUP, 'u1', expect.objectContaining({ askMessageId: ownerRowId() }));
    expect(metric('owner_answer_first').meta).toMatchObject({ followThrough: 'none', armed: false, verdict: 'done' });
  });

  it('TURN_CONTINUATION_DISABLED=1 holds act at shadow — no split that would drop the remaining work', async () => {
    process.env.TURN_CONTINUATION_DISABLED = '1';
    try {
      (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 50_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
      await ownerTurn();
      expect(leadPolls[0]).toEqual([null, null]);
      expect(queued()).toHaveLength(0);
      expect(assistantRow().content).toBe(FULL_ANSWER);
      expect(metric('owner_answer_first').meta).toMatchObject({ mode: 'shadow', setting: 'canary', canary: true, degraded: 'continuation_off', split: true });
    } finally { delete process.env.TURN_CONTINUATION_DISABLED; }
  });

  it('an answer inside the deadline is untouched (no split, no follow-through) and closes the ask', async () => {
    (runCodingAgent as jest.Mock).mockImplementationOnce(leadRun({ stepMs: 20_000, split: SPLIT_ANSWER, noSplit: FULL_ANSWER }));
    await ownerTurn();
    expect(leadPolls[0]).toEqual([null, null]);
    expect(queued()).toHaveLength(0);
    expect(assistantRow().content).toBe(FULL_ANSWER);
    expect(mockCloseAskOnReply).toHaveBeenCalled();
    expect(metric('owner_answer_first').meta).toMatchObject({ mode: 'act', split: false, splitAtMs: null, armed: false });
  });
});

describe('the follow-through ROUND (a supervisor chat, mode act)', () => {
  beforeEach(() => { process.env.SUPERVISOR_OWNER_ANSWER_FIRST = 'act'; });
  const stash = (over: Partial<ContinuationRun> = {}): ContinuationRun => ({
    taskId: 'task-af-1', round: 1, maxRounds: 3, reason: 'answer_first_split', ofMessageId: 'row-split-1', askMessageId: 'ask-1',
    startedAt: new Date(realNow() - 60_000).toISOString(), askText: OWNER.message,
    answerFirst: { resumes: 0, done: ['send_chat_message→d1d0b346'], items: 'read back its reply' }, ...over,
  });
  const promptFor = (s: ContinuationRun) => continuationPrompt({ round: s.round, maxRounds: s.maxRounds, reason: s.reason, askText: s.askText, previousAnswer: SPLIT_ANSWER, stash: s });

  it('a finished round posts the result, settles the card done, closes the OWNER ASK (source continuation) and counts a repeated send', async () => {
    const s = stash();
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
      finalText: 'Messaged the tt-rd supervisor; it replied at 18:12Z that the plan is fine.',
      parts: [{ type: 'tool_call', name: 'send_chat_message', args: { chatId: 'd1d0b346-2222', content: 'plan' } }, { type: 'text', text: 'Messaged the tt-rd supervisor; it replied at 18:12Z that the plan is fine.' }],
    }));
    const key = await startDetachedChatRun({ userId: 'u1', chatId: SUP, sessionId: null, message: promptFor(s), mode: 'thinking', messageOrigin: 'schedule', continuation: s });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !!metric('turn_continuation'));
    const row = assistantRow();
    expect(row.metadata).toMatchObject({ kind: 'continuation_result', continuation: { taskId: 'task-af-1' } });
    expect(metric('turn_continuation').meta).toMatchObject({ taskId: 'task-af-1', outcome: 'posted', answerFirst: true, resumes: 0, duplicates: 1, duplicateCalls: ['send_chat_message→d1d0b346'] });
    await waitFor(() => mockCloseAskOnReply.mock.calls.length > 0);
    expect(mockCloseAskOnReply).toHaveBeenCalledWith(SUP, 'u1', { askMessageId: 'ask-1', replyMessageId: row.id, source: 'continuation' });
    expect(metric('owner_answer_first')).toBeUndefined(); // a round is not an owner turn
  });

  it("an OWNER message that preempts the round re-queues it (af=1), holds the drain, persists no '(Stopped.)' row and keeps the card running", async () => {
    const s = stash();
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => {
      await markChatRunPreempted(SUP); // what preemptMachineRunForUserMessage does before cancelling
      cancelRun(`chat:${SUP}`);
      return { finalText: '(Stopped.)', parts: [{ type: 'text', text: '⏹ Stopped by user.' }] };
    });
    const key = await startDetachedChatRun({ userId: 'u1', chatId: SUP, sessionId: null, message: promptFor(s), mode: 'thinking', messageOrigin: 'schedule', continuation: s });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !!metric('turn_continuation'));
    expect(metric('turn_continuation').meta).toMatchObject({ outcome: 'resumed', answerFirst: true, resumes: 1 });
    expect(queued()).toHaveLength(1);
    expect(queued()[0].content).toContain(' ask=ask-1 af=1]');
    expect(writes().filter((d: any) => d?.role === 'assistant')).toHaveLength(0);
    expect(await followThroughHoldMs(SUP)).toBeGreaterThan(0);
    const card = mockPrisma.crossModelMessage.update.mock.calls.map((c: any[]) => c[0]?.data?.metadata?.task).filter(Boolean).pop();
    expect(card).toMatchObject({ taskId: 'task-af-1', status: 'running' });
    expect(mockPrisma.crossModelMessage.update.mock.calls.some((c: any[]) => JSON.stringify(c[0]?.data?.parts ?? []).includes(ANSWER_FIRST_RESUME_NOTE))).toBe(true);
    expect(mockCloseAskOnReply).not.toHaveBeenCalled();
  });

  it('a Stop (no preempt marker) settles the card as stopped — nothing is re-queued', async () => {
    const s = stash();
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => {
      cancelRun(`chat:${SUP}`);
      return { finalText: '(Stopped.)', parts: [] };
    });
    const key = await startDetachedChatRun({ userId: 'u1', chatId: SUP, sessionId: null, message: promptFor(s), mode: 'thinking', messageOrigin: 'schedule', continuation: s });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !!metric('turn_continuation'));
    expect(metric('turn_continuation').meta).toMatchObject({ outcome: 'stopped', answerFirst: true });
    expect(queued()).toHaveLength(0);
  });

  it('the resume cap holds: a round already resumed twice settles as stopped even when preempted', async () => {
    const s = stash({ answerFirst: { resumes: 2, done: [] } });
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => {
      await markChatRunPreempted(SUP);
      cancelRun(`chat:${SUP}`);
      return { finalText: '(Stopped.)', parts: [] };
    });
    const key = await startDetachedChatRun({ userId: 'u1', chatId: SUP, sessionId: null, message: promptFor(s), mode: 'thinking', messageOrigin: 'schedule', continuation: s });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !!metric('turn_continuation'));
    expect(metric('turn_continuation').meta).toMatchObject({ outcome: 'stopped', resumes: 2 });
    expect(queued()).toHaveLength(0);
  });
});

describe('the queue drain — "resume after the owner\'s turn", never dropped, never gated', () => {
  const s: ContinuationRun = {
    taskId: 'task-af-2', round: 1, maxRounds: 3, reason: 'answer_first_split', ofMessageId: 'row-split-2', askMessageId: 'ask-2',
    startedAt: new Date(realNow() - 120_000).toISOString(), askText: 'status?', answerFirst: { resumes: 0 },
  };
  const row = (content: string) => ({ id: 'pend-af', chatId: SUP, userId: 'u1', content, mode: 'thinking', source: 'schedule', createdAt: new Date(realNow() - 60_000), uploadIds: null });
  const afPrompt = continuationPrompt({ round: 1, maxRounds: 3, reason: 'answer_first_split', askText: 'status?', previousAnswer: SPLIT_ANSWER, stash: s });
  const plainPrompt = continuationPrompt({ round: 1, maxRounds: 3, reason: 'offer_to_continue', askText: 'status?', previousAnswer: 'x', stash: { ...s, answerFirst: undefined } });
  // A one-row in-memory queue: findFirst serves it until delete removes it (no user rows queued).
  let queue: any[] = [];
  const useQueue = (r: any) => {
    queue = [r];
    mockPrisma.pendingChatMessage.findFirst.mockImplementation(async (a: any) => (a?.where?.source === 'user' ? null : (queue[0] ?? null)));
    mockPrisma.pendingChatMessage.delete.mockImplementation(async (a: any) => { queue = queue.filter((q) => q.id !== a?.where?.id); return {}; });
  };

  beforeEach(() => {
    // An owner row NEWER than the task — it supersedes a plain continuation; an answer-first one runs after it.
    mockPrisma.crossModelMessage.findMany = jest.fn(async () => [{ id: 'owner-new', metadata: null }]);
  });
  afterEach(() => {
    queue = [];
    mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.pendingChatMessage.delete.mockReset().mockImplementation(async () => ({}));
  });

  it('an answer-first round (stash rebuilt from its marker) drains despite the newer owner row — the material gate never sees it', async () => {
    useQueue(row(afPrompt));
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({ finalText: 'Read back the reply: plan accepted.', parts: [] }));
    expect(await drainChatQueue(SUP, 'u1')).toBe(true);
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive(`chat:${SUP}`));
    expect(mockMaterialGateForDrain).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
    await waitFor(() => !!metric('turn_continuation'));
    expect(metric('turn_continuation').meta).toMatchObject({ taskId: 'task-af-2', outcome: 'posted', answerFirst: true });
  });

  it('2026-10-22: the drained round (stash rebuilt from its ` af=0` marker, the chat itself not in act) closes its result with the neutral harness record, never the wake no-op line', async () => {
    useQueue(row(afPrompt));
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({ finalText: 'Read back the reply: plan accepted.', parts: [] }));
    expect(await drainChatQueue(SUP, 'u1')).toBe(true);
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive(`chat:${SUP}`));
    await waitFor(() => !!metric('turn_continuation'));
    const r = assistantRow();
    expect(r.metadata).toMatchObject({ kind: 'continuation_result', harnessActions: 0, harnessReceipts: { mode: 'record', followThrough: true } });
    expect(r.content).toBe(`Read back the reply: plan accepted.\n\n${HARNESS_RECORD_ZERO_LINE}`);
    expect(r.content).not.toContain('WAKE: no-op');
  });

  it('control: a PLAIN continuation row on the same chat is superseded by that owner row (dropped, no run)', async () => {
    useQueue(row(plainPrompt));
    expect(await drainChatQueue(SUP, 'u1')).toBe(false);
    expect(runCodingAgent).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
  });

  it('a re-queued round is HELD while the preempting owner turn starts (no run, row kept); the hold lapses on its own', async () => {
    await setFollowThroughHold(SUP, 20_000);
    useQueue(row(afPrompt));
    expect(await drainChatQueue(SUP, 'u1')).toBe(false);
    expect(runCodingAgent).not.toHaveBeenCalled();
    expect(queue).toHaveLength(1);
    skew += 21_000;
    expect(await followThroughHoldMs(SUP)).toBe(0);
  });
});

// 2026-10-22 (prod): the owner's replies on the Fleet Supervisor chat ended with "WAKE: no-op (harness: 0 lane
// actions)". An owner turn answered at the soft deadline runs its remainder as this follow-through round — machine-
// triggered (origin 'schedule'), so the harness-receipts finalize recorded it like a wake and closed the owner's own
// answer with the zero-action WAKE line. A round isAnswerFirstFollowThrough marks gets the owner-ask reply's neutral
// 'Harness record:' line instead; executed actions keep the ACTIONS TAKEN (harness) block; ordinary wakes keep the
// no-op line. Kill switch SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1.
describe("the follow-through ROUND's harness record (2026-10-22) — the owner's answer, never a 'WAKE: no-op' wake close", () => {
  const LANE = '9e39ec5c-0b5a-4bd8-8a0b-5a1ff0a1b2c3';
  const R1 = 'd24c4c9b-1111-4222-8333-444455556666';
  const RESULT = "Read back the tt-rd supervisor's reply: the camera plan is accepted and recording starts at 18:30Z.";
  const stash = (): ContinuationRun => ({
    taskId: 'task-af-h', round: 1, maxRounds: 3, reason: 'answer_first_split', ofMessageId: 'row-split-h', askMessageId: 'ask-h',
    startedAt: new Date(realNow() - 60_000).toISOString(), askText: OWNER.message,
    answerFirst: { resumes: 0, done: [], items: 'read back its reply' },
  });
  const ACTED = {
    finalText: RESULT,
    parts: [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: LANE, content: 'start recording at 18:30Z' } },
      { type: 'tool_result', name: 'send_chat_message', result: JSON.stringify({ ok: true, ids: { chatId: LANE }, receiptId: R1 }) },
      { type: 'text', text: RESULT },
    ],
    receipts: [{ id: R1, tool: 'send_chat_message', ok: true, ids: { chatId: LANE } }],
  };
  const ACTED_BLOCK = 'ACTIONS TAKEN (harness):\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b';
  const harnessMetric = () => metric('supervisor_harness_receipts');
  const runRound = async (result: Record<string, unknown>) => {
    const s = stash();
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => result);
    const key = await startDetachedChatRun({ userId: 'u1', chatId: SUP, sessionId: null, message: continuationPrompt({ round: 1, maxRounds: 3, reason: s.reason, askText: s.askText, previousAnswer: SPLIT_ANSWER, stash: s }), mode: 'thinking', messageOrigin: 'schedule', continuation: s });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !!metric('turn_continuation'));
    return assistantRow();
  };
  const runWake = async (result: Record<string, unknown>) => {
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => result);
    const key = await startDetachedChatRun({ userId: 'u1', chatId: SUP, sessionId: null, message: '[wake] a lane finished its run', mode: 'thinking', machineWake: true, messageOrigin: 'hook' });
    await waitFor(() => !isRunActive(key!));
    await waitFor(() => !!harnessMetric());
    return assistantRow();
  };
  beforeEach(() => {
    process.env.SUPERVISOR_OWNER_ANSWER_FIRST = 'act';
    delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    delete process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED;
  });
  afterEach(() => { delete process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED; });

  it('zero lane actions: the result closes with the neutral Harness record line — no WAKE: no-op — and classifies as a plain note, never a wake no-op', async () => {
    const r = await runRound({ finalText: RESULT, parts: [{ type: 'text', text: RESULT }], receipts: [] });
    expect(r.metadata).toMatchObject({ kind: 'continuation_result', continuation: { taskId: 'task-af-h' } });
    expect(r.content).toBe(`${RESULT}\n\n${HARNESS_RECORD_ZERO_LINE}`);
    expect(r.content).not.toContain('WAKE: no-op');
    expect(r.content).not.toContain(HARNESS_NOOP_LINE);
    expect(r.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'record', followThrough: true } });
    // the classifiers that read it (attention watchdog / supervisor_turn_noop facts via metadata, classifySupervisorNote via content)
    expect(harnessNoteKind(r.metadata)).toBe('supervisor_note');
    // 2026-10-22 minors: the content-only classifier agrees (the record line ⇒ a plain note, never the ≤200-char no-op)
    expect(harnessLineKind(r.content)).toBe('supervisor_note');
    expect((await import('../platform/supervisor.service')).classifySupervisorNote(r.content)).toBe('supervisor_note');
    expect(/\b(?:SWEEP|WAKE):\s*no-op\b/i.test(r.content)).toBe(false);
    // the persisted parts carry the same appendix the content does
    expect((r.parts as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')).toContain(HARNESS_RECORD_ZERO_LINE);
    expect(harnessMetric()).toMatchObject({ sessionId: SUP, value: 0, meta: { mode: 'record', harnessActions: 0, followThrough: true, origin: 'schedule' } });
  });

  it("with executed lane actions: the ACTIONS TAKEN (harness) block is byte-identical to an ordinary wake's", async () => {
    const r = await runRound(ACTED);
    expect(r.content).toBe(`${RESULT}\n\n${ACTED_BLOCK}`);
    expect(r.metadata).toMatchObject({ harnessActions: 1, harnessReceipts: { mode: 'actions', reportUps: 0, notExecuted: 0, followThrough: true } });
    expect(harnessNoteKind(r.metadata)).toBe('supervisor_action');
    created = [];
    mockRecordLoopMetric.mockClear();
    const w = await runWake(ACTED);
    expect(w.content).toBe(`${RESULT}\n\n${ACTED_BLOCK}`);
    expect(w.metadata.harnessReceipts.followThrough).toBeUndefined();
  });

  it('control: an ordinary machine wake on the same supervisor chat keeps the wake no-op close', async () => {
    const w = await runWake({ finalText: 'All lanes look healthy; nothing to steer.', parts: [], receipts: [] });
    expect(w.content).toBe(`All lanes look healthy; nothing to steer.\n\n${HARNESS_NOOP_LINE}`);
    expect(w.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'noop' } });
    expect(w.metadata.harnessReceipts.followThrough).toBeUndefined();
    expect(harnessNoteKind(w.metadata)).toBe('supervisor_noop');
    expect(harnessMetric().meta.followThrough).toBeUndefined();
  });

  it('kill switch SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1: the round closes with the wake no-op line again (the pre-fix behaviour)', async () => {
    process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED = '1';
    const r = await runRound({ finalText: RESULT, parts: [{ type: 'text', text: RESULT }], receipts: [] });
    expect(r.content).toBe(`${RESULT}\n\n${HARNESS_NOOP_LINE}`);
    expect(r.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'noop' } });
    expect(r.metadata.harnessReceipts.followThrough).toBeUndefined();
    expect(harnessNoteKind(r.metadata)).toBe('supervisor_noop');
  });

  // 2026-10-22 minors: the core wake.close rule rides every supervisor prompt, so a round could itself close the
  // owner's answer with 'WAKE: no-op — nothing moved'; it got mode 'noop_present' and the owner read the wake line.
  // The trailing model-typed no-op line is stripped before the record (content AND the last text part).
  const NOOP_CLOSE = 'WAKE: no-op — nothing moved';
  const SELF_NOOP = `${RESULT}\n\n${NOOP_CLOSE}`;
  it("a round that closes itself with 'WAKE: no-op — nothing moved' is delivered without it: the neutral record line, mode 'record', a plain note", async () => {
    const r = await runRound({ finalText: SELF_NOOP, parts: [{ type: 'text', text: SELF_NOOP }], receipts: [] });
    expect(r.content).toBe(`${RESULT}\n\n${HARNESS_RECORD_ZERO_LINE}`);
    expect(r.content).not.toContain('WAKE: no-op');
    expect(r.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'record', followThrough: true, modelNoopLines: 1 } });
    expect(harnessNoteKind(r.metadata)).toBe('supervisor_note');
    expect(harnessLineKind(r.content)).toBe('supervisor_note');
    expect((await import('../platform/supervisor.service')).classifySupervisorNote(r.content)).toBe('supervisor_note');
    const partsText = (r.parts as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
    expect(partsText).not.toContain('WAKE: no-op');
    expect(partsText).toContain(HARNESS_RECORD_ZERO_LINE);
    expect(harnessMetric()).toMatchObject({ meta: { mode: 'record', followThrough: true, modelNoopLines: 1 } });
  });

  it("with executed lane actions the round's own no-op close goes too — the ACTIONS TAKEN (harness) block stands alone", async () => {
    const r = await runRound({ ...ACTED, finalText: SELF_NOOP, parts: [...ACTED.parts.slice(0, 2), { type: 'text', text: SELF_NOOP }] });
    expect(r.content).toBe(`${RESULT}\n\n${ACTED_BLOCK}`);
    expect(r.metadata).toMatchObject({ harnessActions: 1, harnessReceipts: { mode: 'actions', followThrough: true, modelNoopLines: 1 } });
  });

  it("control: an ordinary machine wake that closes with the model's 'WAKE: no-op' keeps it (noop_present) and still classifies as a no-op", async () => {
    const w = await runWake({ finalText: `All lanes look healthy.\n\n${NOOP_CLOSE}`, parts: [{ type: 'text', text: `All lanes look healthy.\n\n${NOOP_CLOSE}` }], receipts: [] });
    expect(w.content).toBe(`All lanes look healthy.\n\n${NOOP_CLOSE}`);
    expect(w.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'noop_present' } });
    expect(w.metadata.harnessReceipts.modelNoopLines).toBeUndefined();
    expect(harnessNoteKind(w.metadata)).toBe('supervisor_noop');
    expect((await import('../platform/supervisor.service')).classifySupervisorNote(w.content)).toBe('supervisor_noop');
  });

  it("kill switch SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1: the round's own 'WAKE: no-op' close stays (noop_present — the pre-fix behaviour)", async () => {
    process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED = '1';
    const r = await runRound({ finalText: SELF_NOOP, parts: [{ type: 'text', text: SELF_NOOP }], receipts: [] });
    expect(r.content).toBe(SELF_NOOP);
    expect(r.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'noop_present' } });
    expect(r.metadata.harnessReceipts.followThrough).toBeUndefined();
    expect(r.metadata.harnessReceipts.modelNoopLines).toBeUndefined();
    expect(harnessNoteKind(r.metadata)).toBe('supervisor_noop');
  });

  // ── Review fixes (2026-10-22 minors) ───────────────────────────────────────────────────────────────────────────
  const partsTextOf = (r: any) => ((r.parts ?? []) as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
  const closedWith = async (rowId: string) => {
    await waitFor(() => mockCloseAskOnReply.mock.calls.length > 0);
    expect(mockCloseAskOnReply).toHaveBeenCalledWith(SUP, 'u1', { askMessageId: 'ask-h', replyMessageId: rowId, source: 'continuation' });
  };
  /** The round's replayed live events (subscribeRun replays the buffer of a finished run). */
  const liveEvents = (): Array<{ type: string; data: any }> => {
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(`chat:${SUP}`, (e: any) => events.push(e));
    return events;
  };
  const completeOf = (events: Array<{ type: string; data: any }>) => events.filter((e) => e.type === 'complete').pop()?.data;

  // Item 1: a round made ONLY of the no-op close was stripped to '' — the row became the bare 'Harness record:' line,
  // no longer a no-op reply (isNoopOnlyReply), so closeAskOnReply (source 'continuation') marked the owner ask ANSWERED
  // with a content-free bubble.
  it("a round that is ONLY 'WAKE: no-op — nothing moved' is not stripped (noop_present): a no-op reply, so the owner ask stays open", async () => {
    const r = await runRound({ finalText: NOOP_CLOSE, parts: [{ type: 'text', text: NOOP_CLOSE }], receipts: [] });
    expect(r.content).toBe(NOOP_CLOSE);
    expect(r.content).not.toContain(HARNESS_RECORD_ZERO_LINE);
    expect(r.metadata).toMatchObject({ kind: 'continuation_result', harnessActions: 0, harnessReceipts: { mode: 'noop_present', followThrough: true } });
    expect(r.metadata.harnessReceipts.modelNoopLines).toBeUndefined();
    // the ask-close reads the row: a bare no-op close is no reply (closeAskOnReply refuses it — T4-9)
    expect(isNoopOnlyReply(r.content)).toBe(true);
    expect(isSupervisorReplyRow(r)).toBe(false);
    expect(metric('turn_continuation').meta).toMatchObject({ taskId: 'task-af-h', outcome: 'posted', answerFirst: true });
    await closedWith(r.id);
  });

  // Re-review (2026-10-23): the same failure with other wording — a CHAINED close whose "reason" is itself wake.close
  // boilerplate was rewritten to 'No lane action' + the record line, a reply row, so the ask closed on nothing.
  const CHAINED_CLOSE = 'WAKE: no-op — nothing moved since your answer; no lane action';
  it("a round that is ONLY a chained close ('…; no lane action') is not stripped (noop_present): a no-op reply, so the owner ask stays open", async () => {
    const r = await runRound({ finalText: CHAINED_CLOSE, parts: [{ type: 'text', text: CHAINED_CLOSE }], receipts: [] });
    expect(r.content).toBe(CHAINED_CLOSE);
    expect(r.content).not.toContain(HARNESS_RECORD_ZERO_LINE);
    expect(r.metadata).toMatchObject({ kind: 'continuation_result', harnessActions: 0, harnessReceipts: { mode: 'noop_present', followThrough: true } });
    expect(r.metadata.harnessReceipts.modelNoopLines).toBeUndefined();
    expect(partsTextOf(r)).toContain(CHAINED_CLOSE);
    expect(isNoopOnlyReply(r.content)).toBe(true);
    expect(isSupervisorReplyRow(r)).toBe(false);
    await closedWith(r.id);
  });

  const REASON_CLOSE = 'WAKE: no-op — nothing moved since your answer; the tt-rd supervisor has not replied yet';
  it('a round that is only a no-op close WITH a reason delivers the reason as plain text (no marker) + the record line — a real reply, so the ask closes as answered', async () => {
    const r = await runRound({ finalText: REASON_CLOSE, parts: [{ type: 'text', text: REASON_CLOSE }], receipts: [] });
    expect(r.content).toBe(`The tt-rd supervisor has not replied yet\n\n${HARNESS_RECORD_ZERO_LINE}`);
    expect(r.metadata).toMatchObject({ harnessActions: 0, harnessReceipts: { mode: 'record', followThrough: true, modelNoopLines: 1, modelNoopReasonLines: 1 } });
    expect(partsTextOf(r)).not.toContain('WAKE: no-op');
    expect(partsTextOf(r)).toContain('The tt-rd supervisor has not replied yet');
    expect(harnessNoteKind(r.metadata)).toBe('supervisor_note');
    // the reason is a reply — the ask closes ('answered': a reply exists, never 'done')
    expect(isNoopOnlyReply(r.content)).toBe(false);
    expect(isSupervisorReplyRow(r)).toBe(true);
    await closedWith(r.id);
    expect(harnessMetric()).toMatchObject({ meta: { mode: 'record', modelNoopLines: 1, modelNoopReasonLines: 1 } });
  });

  // Item 2: phase 2 throwing after the strip — the complete event carried no finalText (the live view kept the
  // streamed close while the row dropped it), and a round stripped to '' stored EMPTY_RUN_FALLBACK_NOTE ⇒ 'failed'.
  it('phase 2 throwing after the strip: the live view swaps to the stripped text the row stores; never the empty-run envelope', async () => {
    mockApplyHarnessReceipts.mockImplementation(() => { throw new Error('harness record exploded'); });
    const r = await runRound({ finalText: SELF_NOOP, parts: [{ type: 'text', text: SELF_NOOP }], receipts: [] });
    expect(r.content).toBe(RESULT);
    expect(partsTextOf(r)).not.toContain('WAKE: no-op');
    expect(completeOf(liveEvents())?.finalText).toBe(RESULT);
    expect(metric('turn_continuation').meta).toMatchObject({ outcome: 'posted' });
    expect(harnessMetric()).toBeUndefined(); // phase 2 never finished
  });

  it('phase 2 throwing: a reason-only round keeps its reason (row + live view); a bare close round keeps the close — never stripped to nothing', async () => {
    mockApplyHarnessReceipts.mockImplementation(() => { throw new Error('harness record exploded'); });
    const r = await runRound({ finalText: REASON_CLOSE, parts: [{ type: 'text', text: REASON_CLOSE }], receipts: [] });
    expect(r.content).toBe('The tt-rd supervisor has not replied yet');
    expect(completeOf(liveEvents())?.finalText).toBe('The tt-rd supervisor has not replied yet');
    expect(metric('turn_continuation').meta).toMatchObject({ outcome: 'posted' });
    created = [];
    mockRecordLoopMetric.mockClear();
    const b = await runRound({ finalText: NOOP_CLOSE, parts: [{ type: 'text', text: NOOP_CLOSE }], receipts: [] });
    expect(b.content).toBe(NOOP_CLOSE);
    expect(b.content).not.toBe(EMPTY_RUN_FALLBACK_NOTE);
    expect(metric('turn_continuation').meta).toMatchObject({ outcome: 'posted' });
    expect(isNoopOnlyReply(b.content)).toBe(true);
  });

  // Item 3: the variants that still reached the owner.
  it("variants: a 'Receipts: none' line under the close and a '## WAKE: no-op' heading are stripped from the content AND the stored parts", async () => {
    for (const close of ['WAKE: no-op — nothing moved\nReceipts: none', '## WAKE: no-op — nothing moved since your answer', '> **WAKE: no-op** — nothing moved']) {
      created = [];
      mockRecordLoopMetric.mockClear();
      const note = `${RESULT}\n\n${close}`;
      const r = await runRound({ finalText: note, parts: [{ type: 'text', text: note }], receipts: [] });
      expect(r.content).toBe(`${RESULT}\n\n${HARNESS_RECORD_ZERO_LINE}`);
      expect(r.metadata).toMatchObject({ harnessReceipts: { mode: 'record', followThrough: true, modelNoopLines: 1 } });
      expect(partsTextOf(r)).not.toMatch(/WAKE: no-op|Receipts: none/);
    }
  });

  it('a claims-lane note appended after the close: the close leaves the content AND the stored model part (the walk skips the notes part); the note stays', async () => {
    const NOTE = '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]\nThe typed claims block could not be parsed — no claim in it was checked.';
    mockApplyClaimsBlockLane.mockImplementationOnce((opts: any) => ({
      finalText: `${opts.guarded.finalText}\n\n${NOTE}`, notes: [NOTE], verdict: opts.guarded.verdict,
      lane: { present: true, verified: [], unverified: [], coveredKinds: [] },
    }));
    const r = await runRound({ finalText: SELF_NOOP, parts: [{ type: 'text', text: SELF_NOOP }], receipts: [] });
    expect(r.content).toBe(`${RESULT}\n\n${NOTE}\n\n${HARNESS_RECORD_ZERO_LINE}`);
    expect(r.metadata).toMatchObject({ harnessReceipts: { mode: 'record', followThrough: true, modelNoopLines: 1 } });
    const texts = ((r.parts ?? []) as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text);
    expect(texts[0]).toBe(RESULT);
    expect(texts).toContain(NOTE);
    expect(texts.join('\n')).not.toContain('WAKE: no-op');
  });
});
