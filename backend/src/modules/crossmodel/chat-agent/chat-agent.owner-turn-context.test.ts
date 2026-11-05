/**
 * FS context map 2026-10-22 (ranked gaps #1 + #3) — the chat-agent seam of a
 * supervisor OWNER turn (owner: "it still feels the fleet supervisor doesnt
 * fully have the context and memory of everything"):
 *  #1 the orchestrator history is the ORIGIN-chosen window
 *     (platform/owner-turn-history.ts) instead of the last 8 rows whatever
 *     their origin, and a compact [OWNER THREAD — last 48 h] block rides the
 *     system context;
 *  #3 the harness ledger diff rides it as [SINCE YOUR LAST NOTE — harness
 *     diff] with NO wakeLedgerAt handed to the finalize (the high-water mark
 *     stays where the last wake left it), and PROJECT STATUS lines carry
 *     their age;
 *  every switch restores the old turn; machine wakes and drained agent
 *  relays are untouched.
 * The loader + ledger are mocked (their reads: owner-turn-history.test.ts,
 * supervisor-wake-ledger.test.ts). Harness copied from
 * chat-agent.wake-ledger.w6.test.ts.
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

// The owner-turn transcript reads (platform/owner-turn-history.loader.ts) — mocked at the boundary.
const mockLoadOwnerTurnRows: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../platform/owner-turn-history.loader', () => ({
  __esModule: true,
  loadOwnerTurnRows: (...a: any[]) => mockLoadOwnerTurnRows(...a),
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';
import { buildChatQueryContext } from './chat-context';
import { OWNER_THREAD_HEADING, OWNER_TURN_ELIDED_WAKE } from '../platform/owner-turn-history';

const BASE = { message: 'the question', mode: 'single_thinking' as const };

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
});

const NOW = Date.now();
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000);
/** The chat engine's finalize stamp — every model-written row carries it (fleet/supervisor-reply-row hasFinalizeStamp). */
const STAMP = { engine: 'agent' } as const;
const BAKED = (n: number) => `[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: ${at(170 - n * 20).toISOString()}]\n[SUPERVISOR STATE — snapshot ${n}] ${'s'.repeat(15000)}`;
// The supervisor chat's newest rows: the owner's message 3 h ago + its reply, then six
// wake turns and six relay turns (24 rows) — the 8-row slice no longer reaches the owner.
const ROWS: any[] = [
  { id: 'own-3h', role: 'user', content: 'MARK_3H: keep the bench lane on the new box', origin: null, createdAt: at(180) },
  { id: 'own-3h-r', role: 'assistant', content: 'REPLY_3H: will do — bench stays on the new box.', origin: null, meta: STAMP, createdAt: at(179) },
];
for (let i = 1; i <= 6; i += 1) {
  ROWS.push({ id: `w${i}`, role: 'user', content: BAKED(i), origin: 'schedule', machineMessage: `SWEEP firing ${i}`, createdAt: at(170 - i * 20) });
  ROWS.push({ id: `w${i}-r`, role: 'assistant', content: `NOTE ${i}: nothing moved`, origin: 'schedule', meta: STAMP, createdAt: at(169 - i * 20) });
  ROWS.push({ id: `a${i}`, role: 'user', content: `[AGENT-SENT MESSAGE — from chat "Lane ${i}" (abcd000${i}), another Digby agent, NOT the owner.] RELAY_${i}`, origin: 'agent', createdAt: at(165 - i * 20) });
  ROWS.push({ id: `a${i}-r`, role: 'assistant', content: `ack ${i}`, origin: 'agent', meta: STAMP, createdAt: at(164 - i * 20) });
}
const THREAD: any[] = [
  { id: 'own-30h', role: 'user', content: 'MARK_30H: never restart the old cluster', origin: null, createdAt: at(1800) },
  { id: 'own-30h-r', role: 'assistant', content: 'REPLY_30H: noted — the old cluster stays down.', origin: null, meta: STAMP, createdAt: at(1799) },
  ...ROWS.map((r) => ({ ...r, content: String(r.content).slice(0, 1200) })),
];
const LEGACY = ROWS.map((r) => ({ role: r.role, content: r.content }));
const OWNER_LEDGER = {
  block: '[SINCE YOUR LAST NOTE — harness diff 2026-10-22T15:00Z → 2026-10-22T16:00Z (60 min, since your last completed wake); read from the ledger by the harness.]\nLane runs: FAILED 1 (abcd0001 "Bench" 15:40Z)',
  at: '2026-10-22T16:00:00.000Z', since: '2026-10-22T15:00:00.000Z',
};
const FLEET_ROW = { title: 'Fleet Supervisor', isSupervisor: true, isProjectSupervisor: false, userId: 'u1', projectId: null };
const persistedUserRows = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'user');
const lastInput = () => (runCodingAgent as jest.Mock).mock.calls.at(-1)?.[0];

async function runOwnerTurn(chatId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId, sessionId: null, ...extra } as any);
  expect(key).toBe(`chat:${chatId}`);
  await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
  await waitFor(() => !isRunActive(`chat:${chatId}`));
  await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
}

describe('supervisor OWNER turn — origin-chosen history, [OWNER THREAD], [SINCE YOUR LAST NOTE]', () => {
  const ENV = ['SUPERVISOR_OWNER_HISTORY_V2_DISABLED', 'SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED'];
  beforeEach(() => {
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockOnSupervisorRunFinalized.mockClear();
    mockLoadOwnerTurnRows.mockReset().mockResolvedValue({ history: ROWS, thread: THREAD });
    mockBuildWakeLedgerBlock.mockReset().mockImplementation(async (_c: string, _n?: Date, opts?: { ownerTurn?: boolean }) => (opts?.ownerTurn ? OWNER_LEDGER : null));
    (buildChatQueryContext as jest.Mock).mockResolvedValue({ queryMessage: 'the question', systemContext: '', conversationHistory: LEGACY, projectId: null });
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => FLEET_ROW);
    mockPrisma.supervisorState = {
      findUnique: jest.fn(async () => ({ state: { directives: [], dispatches: [], projects: [{ name: 'Digby', status: 'deploy green', at: at(300).toISOString() }], notes: '', refutations: [] } })),
      upsert: jest.fn(async () => ({})),
    };
    mockPrisma.projectTodo = { findMany: jest.fn(async () => []) };
    mockPrisma.chatSchedule = { findMany: jest.fn(async () => []) };
    mockPrisma.ownerQuestion = { findMany: jest.fn(async () => []) };
  });
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    (buildChatQueryContext as jest.Mock).mockResolvedValue({ queryMessage: 'the question', systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }], projectId: null });
    delete mockPrisma.supervisorState;
    delete mockPrisma.projectTodo;
    delete mockPrisma.chatSchedule;
    delete mockPrisma.ownerQuestion;
  });

  it('the 3 h-old owner message reaches the history (the 8-row slice had lost it), baked wake prompts are elided, the 30 h one rides [OWNER THREAD]', async () => {
    expect(LEGACY.slice(-8).some((h) => h.content.includes('MARK_3H'))).toBe(false);
    await runOwnerTurn('chat-own-1');
    expect(mockLoadOwnerTurnRows).toHaveBeenCalledWith('chat-own-1', expect.objectContaining({ excludeMessageId: null }));
    const history: Array<{ role: string; content: string }> = lastInput().history;
    const i = history.findIndex((h) => h.content.includes('MARK_3H'));
    expect(i).toBe(0);
    expect(history[1].content).toContain('REPLY_3H');
    expect(history.some((h) => h.content.includes('no user is on this turn'))).toBe(false);
    expect(history.some((h) => h.content.startsWith(OWNER_TURN_ELIDED_WAKE.slice(0, -1)))).toBe(true);
    expect(history.filter((h) => h.content.startsWith('[AGENT-SENT MESSAGE'))).toHaveLength(2);
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).toContain(OWNER_THREAD_HEADING);
    expect(doctrine).toContain('MARK_30H');
    expect(doctrine).toContain('REPLY_30H');
    // The owner's own row is persisted verbatim — nothing is baked into it.
    expect(persistedUserRows().map((d: any) => d.content)).toEqual(['the question']);
  });

  it('the harness diff rides the system context above the state doc, PROJECT STATUS carries its age, and the finalize gets no wakeLedgerAt (the mark stays)', async () => {
    await runOwnerTurn('chat-own-2');
    expect(mockBuildWakeLedgerBlock).toHaveBeenCalledWith('chat-own-2', expect.any(Date), expect.objectContaining({ ownerTurn: true }));
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).toContain('[SINCE YOUR LAST NOTE — harness diff');
    expect(doctrine).toContain('Lane runs: FAILED 1');
    expect(doctrine.indexOf('[SINCE YOUR LAST NOTE')).toBeLessThan(doctrine.indexOf('[SUPERVISOR STATE'));
    expect(doctrine).toContain('- Digby [written 5h ago — snapshot, not live]: deploy green');
    expect(mockOnSupervisorRunFinalized.mock.calls[0][0]).toMatchObject({ chatId: 'chat-own-2', machineWake: false, wakeLedgerAt: null });
  });

  it('SUPERVISOR_OWNER_HISTORY_V2_DISABLED=1 ⇒ the legacy 8-row slice byte-for-byte, no thread, no transcript read', async () => {
    process.env.SUPERVISOR_OWNER_HISTORY_V2_DISABLED = '1';
    await runOwnerTurn('chat-own-3');
    expect(mockLoadOwnerTurnRows).not.toHaveBeenCalled();
    expect(lastInput().history).toEqual(LEGACY.slice(-8));
    expect(String(lastInput().doctrineOverride)).not.toContain(OWNER_THREAD_HEADING);
    // The diff is its own switch.
    expect(String(lastInput().doctrineOverride)).toContain('[SINCE YOUR LAST NOTE');
  });

  it('SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED=1 ⇒ no diff read, PROJECT STATUS lines as before', async () => {
    process.env.SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED = '1';
    await runOwnerTurn('chat-own-4');
    expect(mockBuildWakeLedgerBlock).not.toHaveBeenCalled();
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).not.toContain('[SINCE YOUR LAST NOTE');
    expect(doctrine).toContain('- Digby: deploy green');
    expect(doctrine).not.toContain('snapshot, not live');
    expect(doctrine).toContain(OWNER_THREAD_HEADING);
  });

  it('a failed / empty transcript read fails open to the legacy slice', async () => {
    mockLoadOwnerTurnRows.mockResolvedValue(null);
    await runOwnerTurn('chat-own-5');
    expect(lastInput().history).toEqual(LEGACY.slice(-8));
    expect(String(lastInput().doctrineOverride)).not.toContain(OWNER_THREAD_HEADING);
  });

  it('a supervisor MACHINE wake and a drained AGENT relay never take the owner-turn path', async () => {
    await runOwnerTurn('chat-own-6', { machineWake: true, messageOrigin: 'schedule' });
    expect(mockLoadOwnerTurnRows).not.toHaveBeenCalled();
    expect(mockBuildWakeLedgerBlock).toHaveBeenCalledWith('chat-own-6');
    expect(mockBuildWakeLedgerBlock.mock.calls.some((c: any[]) => c[2]?.ownerTurn)).toBe(false);
    mockBuildWakeLedgerBlock.mockClear();
    mockOnSupervisorRunFinalized.mockClear();
    (runCodingAgent as jest.Mock).mockClear();
    await runOwnerTurn('chat-own-7', { messageOrigin: 'agent' });
    expect(mockLoadOwnerTurnRows).not.toHaveBeenCalled();
    expect(mockBuildWakeLedgerBlock).not.toHaveBeenCalled();
    expect(lastInput().history).toEqual(LEGACY.slice(-8));
  });

  // ── Review fixes 2026-10-23 ─────────────────────────────────────────────
  it('item 1: a key / password the owner pasted 3 h and 30 h ago reaches neither the history nor [OWNER THREAD] — this turn\'s own message stays verbatim', async () => {
    const KEY = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAB7CD0EF3GH6';
    const PW = 'Tr0ub4dor&3x';
    const KEY30 = 'sk-Q7rT9vX2bN4mK6pL8sD0fG3hJ5wE1yU2iO4aZ6cV8';
    const NOW_KEY = 'sk-proj-Zz9yXw8vUt7sRq6pOn5mLk4jIh3gFe2dCb1aZZ8YY7';
    const hist = [
      { id: 'k3', role: 'user', content: `MARK_K3 OpenAI key ${KEY}\nthe db password: ${PW}`, origin: null, createdAt: at(180) },
      { id: 'k3-r', role: 'assistant', content: `Using ${KEY} for the bench.`, origin: null, meta: STAMP, createdAt: at(179) },
      ...ROWS.slice(2),
    ];
    const thread = [
      { id: 'k30', role: 'user', content: `MARK_K30 MOONSHOT_API_KEY=${KEY30}`, origin: null, createdAt: at(1800) },
      { id: 'k30-r', role: 'assistant', content: `Noted MOONSHOT_API_KEY=${KEY30}.`, origin: null, meta: STAMP, createdAt: at(1799) },
      ...hist.map((r) => ({ ...r, content: String(r.content).slice(0, 1200) })),
    ];
    mockLoadOwnerTurnRows.mockResolvedValue({ history: hist, thread });
    const message = `store this one: ${NOW_KEY}`;
    (buildChatQueryContext as jest.Mock).mockResolvedValue({ queryMessage: message, systemContext: '', conversationHistory: LEGACY, projectId: null });
    await runOwnerTurn('chat-own-sec', { message });
    const history = JSON.stringify(lastInput().history);
    const doctrine = String(lastInput().doctrineOverride);
    expect(history).toContain('MARK_K3');
    expect(doctrine).toContain('MARK_K30');
    for (const v of [KEY, PW, KEY30]) {
      expect(history).not.toContain(v);
      expect(doctrine).not.toContain(v);
    }
    expect(history).toContain('[REDACTED');
    expect(doctrine).toContain('[REDACTED');
    // The current turn's own message is untouched: persisted verbatim and asked verbatim (store_secret lifts it).
    expect(persistedUserRows().map((d: any) => d.content)).toEqual([message]);
    expect(String(lastInput().userMessage)).toContain(NOW_KEY);
  });

  it('item 2: slow transcript / ledger reads never hold the run — each is bounded (1.5 s) and fails open to omitting its block', async () => {
    const never = () => new Promise<any>((resolve) => { const t = setTimeout(() => resolve(null), 8000); (t as any).unref?.(); });
    mockLoadOwnerTurnRows.mockImplementation(never);
    mockBuildWakeLedgerBlock.mockImplementation((_c: string, _n?: Date, opts?: { ownerTurn?: boolean }) => (opts?.ownerTurn ? never() : Promise.resolve(null)));
    const t0 = Date.now();
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-own-slow', sessionId: null } as any);
    expect(key).toBe('chat:chat-own-slow');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0, 9000);
    const waited = Date.now() - t0;
    expect(waited).toBeLessThan(2500);
    expect(lastInput().history).toEqual(LEGACY.slice(-8));
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).not.toContain(OWNER_THREAD_HEADING);
    expect(doctrine).not.toContain('[SINCE YOUR LAST NOTE');
    expect(doctrine).toContain('[SUPERVISOR STATE');
    await waitFor(() => !isRunActive('chat:chat-own-slow'));
    await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
  }, 15000);

  it('item 2: the reads run CONCURRENTLY with the context build — a 1 s context build + 1 s reads start the run in ~1 s, not ~2 s', async () => {
    const after = <T,>(ms: number, v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));
    (buildChatQueryContext as jest.Mock).mockImplementation(() => after(1000, { queryMessage: 'the question', systemContext: '', conversationHistory: LEGACY, projectId: null }));
    mockLoadOwnerTurnRows.mockImplementation(() => after(1000, { history: ROWS, thread: THREAD }));
    mockBuildWakeLedgerBlock.mockImplementation((_c: string, _n?: Date, opts?: { ownerTurn?: boolean }) => after(1000, opts?.ownerTurn ? OWNER_LEDGER : null));
    const t0 = Date.now();
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-own-conc', sessionId: null } as any);
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0, 9000);
    const waited = Date.now() - t0;
    expect(waited).toBeLessThan(1700);
    // Both blocks made it (each read finished inside its bound).
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).toContain(OWNER_THREAD_HEADING);
    expect(doctrine).toContain('[SINCE YOUR LAST NOTE');
    expect(lastInput().history[0].content).toContain('MARK_3H');
    await waitFor(() => !isRunActive('chat:chat-own-conc'));
    await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
  }, 15000);

  // ── Re-review 2026-10-23 ────────────────────────────────────────────────
  const failOpenRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0])
    .filter((r: any) => r?.kind === 'supervisor_owner_turn_context' && r?.meta?.failedOpen === true);

  it('re-review: a read slower than 1.5 s but faster than the context build is KEPT — waiting for it costs the run nothing', async () => {
    // The finding's shape: a 2.5 s context build (project learnings + memory search) and 2 s reads (the
    // IOPS-bound RDS). The fixed 1.5 s timer started with the read dropped both blocks for no latency gain.
    const after = <T,>(ms: number, v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));
    (buildChatQueryContext as jest.Mock).mockImplementation(() => after(2500, { queryMessage: 'the question', systemContext: '', conversationHistory: LEGACY, projectId: null }));
    mockLoadOwnerTurnRows.mockImplementation(() => after(2000, { history: ROWS, thread: THREAD }));
    mockBuildWakeLedgerBlock.mockImplementation((_c: string, _n?: Date, opts?: { ownerTurn?: boolean }) => after(2000, opts?.ownerTurn ? OWNER_LEDGER : null));
    mockRecordLoopMetric.mockClear();
    const t0 = Date.now();
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-own-slowctx', sessionId: null } as any);
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0, 9000);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(2400);
    expect(waited).toBeLessThan(3200);
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).toContain(OWNER_THREAD_HEADING);
    expect(doctrine).toContain('[SINCE YOUR LAST NOTE');
    expect(lastInput().history[0].content).toContain('MARK_3H');
    expect(failOpenRows()).toEqual([]);
    // Each read was handed a ceiling past the context build, never the 1.5 s bound (that one is the seam's).
    expect(mockLoadOwnerTurnRows.mock.calls.at(-1)?.[1]?.timeoutMs).toBeGreaterThan(5000);
    expect(mockBuildWakeLedgerBlock.mock.calls.find((c: any[]) => c[2]?.ownerTurn)?.[2]?.timeoutMs).toBeGreaterThan(5000);
    await waitFor(() => !isRunActive('chat:chat-own-slowctx'));
    await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
  }, 15000);

  it('re-review: a read still pending when the context build ends is dropped THEN (no wait past it) and the fail-open is recorded per read', async () => {
    const after = <T,>(ms: number, v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));
    const never = () => new Promise<any>((resolve) => { const t = setTimeout(() => resolve(null), 8000); (t as any).unref?.(); });
    (buildChatQueryContext as jest.Mock).mockImplementation(() => after(2000, { queryMessage: 'the question', systemContext: '', conversationHistory: LEGACY, projectId: null }));
    mockLoadOwnerTurnRows.mockImplementation(never);
    mockBuildWakeLedgerBlock.mockImplementation((_c: string, _n?: Date, opts?: { ownerTurn?: boolean }) => (opts?.ownerTurn ? never() : Promise.resolve(null)));
    mockRecordLoopMetric.mockClear();
    const t0 = Date.now();
    await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-own-failopen', sessionId: null } as any);
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0, 9000);
    const waited = Date.now() - t0;
    expect(waited).toBeLessThan(2700);
    expect(lastInput().history).toEqual(LEGACY.slice(-8));
    const doctrine = String(lastInput().doctrineOverride);
    expect(doctrine).not.toContain(OWNER_THREAD_HEADING);
    expect(doctrine).not.toContain('[SINCE YOUR LAST NOTE');
    const rows = failOpenRows();
    expect(rows.map((r: any) => r.meta.which).sort()).toEqual(['ledger', 'rows']);
    for (const r of rows) {
      expect(r).toMatchObject({ sessionId: 'chat-own-failopen', value: 0, meta: { failedOpen: true, timedOut: true, reason: 'timeout', boundMs: 1500, fleet: true } });
      // The bound was the context build (~2 s), not the 1.5 s timer: the read was asked for after it.
      expect(r.meta.askedAtMs).toBeGreaterThanOrEqual(1900);
      expect(r.meta.waitedMs).toBeGreaterThanOrEqual(r.meta.askedAtMs);
    }
    await waitFor(() => !isRunActive('chat:chat-own-failopen'));
    await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
  }, 15000);

  it('re-review: a loader that answers null (its own error / ceiling) records the fail-open as reason null; a healthy turn records none', async () => {
    mockRecordLoopMetric.mockClear();
    await runOwnerTurn('chat-own-healthy');
    expect(failOpenRows()).toEqual([]);
    mockLoadOwnerTurnRows.mockResolvedValue(null);
    mockRecordLoopMetric.mockClear();
    await runOwnerTurn('chat-own-nullread');
    expect(failOpenRows()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ failedOpen: true, which: 'rows', timedOut: false, reason: 'null' }) })]);
  });
});
