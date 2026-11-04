/**
 * audit 2026-10-08 W6 — the chat-agent seams of the supervisor wake ledger:
 *  W6-1 a supervisor MACHINE wake carries [SINCE YOUR LAST WAKE] (under the
 *       owner asks, above the state doc) and keeps only its last 3 own notes +
 *       owner-typed rows as history (machine prompts elided) instead of the
 *       24-message replay; no block ⇒ the old slice byte-for-byte;
 *  W6-1 the finalize advances the high-water mark (onSupervisorRunFinalized);
 *  W6-2 a queued AGENT batch the material gate judges non-material is ACKED
 *       (no turn); a material verdict drains as before.
 * The ledger module is mocked (its reads + rule: supervisor-wake-ledger.test.ts).
 * Harness copied from chat-agent.service.test.ts.
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

import {
  startDetachedChatRun, chatAgentRunKey, slimChatModelCards, summarizeToolEvidence,
  toolResultPhrase, drainChatQueue, machineOriginRun,
} from './chat-agent.service';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { isRunActive, subscribeRun, getRunMeta } from '../coding/live-runs';
import moonshotIntegration from '../integrations/moonshot.integration';
import { buildChatQueryContext } from './chat-context';
import { searchWithBrightData } from '../mcp-search';
import logger from '../../../utils/logger';

import { markRetiring as markRetiringForTest, __resetRetiringForTests } from '../coding/retiring';

const BASE = { message: 'the question', mode: 'single_thinking' as const };

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

beforeEach(() => {
  redisStore.clear(); // a leaked liveness key must not fail a later claim
  redisLists.clear();
});


import { ELIDED_WAKE_PROMPT } from '../platform/wake-material-rule';

const LEDGER = { block: '[SINCE YOUR LAST WAKE — harness ledger diff 2026-10-08T15:15Z → 2026-10-08T16:15Z (60 min)]\nOwner messages: in this chat 15:47Z "record all 4 cameras"', at: '2026-10-08T16:15:00.000Z', since: '2026-10-08T15:15:00.000Z' };
const wakePrompt = (n: number) => `[MACHINE-TRIGGERED RUN — no user is on this turn.] [SUPERVISOR STATE snapshot ${n}] ${'s'.repeat(500)}`;
const HISTORY: Array<{ role: 'user' | 'assistant'; content: string }> = [];
for (let i = 1; i <= 6; i += 1) { HISTORY.push({ role: 'user', content: wakePrompt(i) }); HISTORY.push({ role: 'assistant', content: `note ${i}` }); }
HISTORY.splice(4, 0, { role: 'user', content: 'record all 4 cameras for 30 min' }, { role: 'assistant', content: 'on it' });

const SUP_ROW = { title: 'Schooltime Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1', projectId: 'p1' };
const persistedUserRows = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'user');

describe('W6-1 — [SINCE YOUR LAST WAKE] + continuity history on a supervisor machine wake', () => {
  beforeEach(() => {
    (runCodingAgent as jest.Mock).mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    mockBuildWakeLedgerBlock.mockReset().mockResolvedValue(null);
    mockOnSupervisorRunFinalized.mockClear();
    (buildChatQueryContext as jest.Mock).mockResolvedValue({ queryMessage: 'the question', systemContext: '', conversationHistory: HISTORY, projectId: 'p1' });
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => SUP_ROW);
  });
  afterEach(() => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    (buildChatQueryContext as jest.Mock).mockResolvedValue({ queryMessage: 'the question', systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }], projectId: null });
  });

  it('the diff rides the wake prompt and the history is the last 3 notes + the owner row, machine prompts elided; the finalize advances the mark', async () => {
    mockBuildWakeLedgerBlock.mockResolvedValue(LEDGER);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-w6-sup', sessionId: null, machineWake: true, messageOrigin: 'hook' });
    expect(key).toBe('chat:chat-w6-sup');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-w6-sup'));
    expect(mockBuildWakeLedgerBlock).toHaveBeenCalledWith('chat-w6-sup');
    const wakeRow = persistedUserRows().find((d: any) => String(d.content).includes('[SINCE YOUR LAST WAKE'));
    expect(wakeRow).toBeTruthy();
    expect(String(wakeRow.content).indexOf('[SINCE YOUR LAST WAKE')).toBeLessThan(String(wakeRow.content).indexOf('the question'));
    const history = (runCodingAgent as jest.Mock).mock.calls[0][0].history.map((h: any) => h.content);
    expect(history).toEqual(['record all 4 cameras for 30 min', 'on it', ELIDED_WAKE_PROMPT, 'note 4', ELIDED_WAKE_PROMPT, 'note 5', ELIDED_WAKE_PROMPT, 'note 6']);
    await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
    expect(mockOnSupervisorRunFinalized.mock.calls[0][0]).toMatchObject({ chatId: 'chat-w6-sup', machineWake: true, failed: false, wakeLedgerAt: LEDGER.at });
  });

  it('no block (kill switch / read failed) ⇒ the 24-message replay byte-for-byte; the finalize still reports (mark falls back to the run start)', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-w6-sup2', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-w6-sup2');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-w6-sup2'));
    expect((runCodingAgent as jest.Mock).mock.calls[0][0].history.map((h: any) => h.content)).toEqual(HISTORY.map((h) => h.content));
    expect(persistedUserRows().some((d: any) => String(d.content).includes('[SINCE YOUR LAST WAKE'))).toBe(false);
    await waitFor(() => mockOnSupervisorRunFinalized.mock.calls.length > 0);
    expect(mockOnSupervisorRunFinalized.mock.calls[0][0]).toMatchObject({ chatId: 'chat-w6-sup2', machineWake: true, wakeLedgerAt: null });
  });
});

describe('W6-2 — the material gate at the agent-message drain', () => {
  const agentRow = { id: 'pend-w6', chatId: 'chat-w6-drain', userId: 'u1', content: '[AGENT-SENT MESSAGE — from chat "Hue recorder" (0037460b)] Watch firing 4/24 — cameras still offline.', mode: 'single_thinking', source: 'agent', createdAt: new Date() };
  beforeEach(() => {
    (runCodingAgent as jest.Mock).mockClear();
    mockMaterialGateForDrain.mockReset().mockResolvedValue(null);
    mockAckMaterialGateDrain.mockReset().mockResolvedValue(true);
    mockRecordAgreement.mockClear();
    mockCloseStashes.mockClear();
    mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
  });

  it('a NON-material batch is acked by the harness — no turn starts, the stashes close, the agreement row is written', async () => {
    const verdict = { origin: 'drain', chatId: 'chat-w6-drain', mode: 'act', skip: true, verdict: { material: false, reasons: [], heartbeat: false, sinceMin: 40, floorHours: 4 } };
    mockMaterialGateForDrain.mockResolvedValue(verdict);
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce(agentRow);
    const started = await drainChatQueue('chat-w6-drain', 'u1');
    expect(started).toBe(false);
    expect(mockMaterialGateForDrain).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-w6-drain', rows: [agentRow] }));
    expect(mockAckMaterialGateDrain).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-w6-drain', rows: [agentRow], verdict: verdict.verdict }));
    expect(mockRecordAgreement).toHaveBeenCalledWith(verdict, [null]);
    expect(mockCloseStashes).toHaveBeenCalledWith([null], 'chat-w6-drain', 'drain');
    expect(runCodingAgent).not.toHaveBeenCalled();
    expect(isRunActive('chat:chat-w6-drain')).toBe(false);
  });

  it('a MATERIAL verdict (or a failed ack) drains exactly as before', async () => {
    mockMaterialGateForDrain.mockResolvedValue({ origin: 'drain', chatId: 'chat-w6-drain', mode: 'act', skip: false, verdict: { material: true, reasons: ['lane_report'], heartbeat: false, sinceMin: 40, floorHours: 4 } });
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValueOnce(agentRow);
    expect(await drainChatQueue('chat-w6-drain', 'u1')).toBe(true);
    expect(mockAckMaterialGateDrain).not.toHaveBeenCalled();
    await waitFor(() => !isRunActive('chat:chat-w6-drain'));
    await new Promise((r) => setTimeout(r, 50));
  });
});
