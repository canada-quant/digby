/**
 * Ticket 8aa5688f — scheduled runs exhaust tool rounds before mandated
 * trailing actions (notify_user unreachable after long data pulls).
 *
 * MEASURED (chat 1ea4621f, Oct 18–25 2026): 8 consecutive daily digest
 * firings whose own final note read "notify_user could not be called — no
 * tool access / rounds exhausted" — the chat 'thinking' profile runs 8
 * tool steps and agent.ts omits tools on the FINAL step, so a wake that
 * burns its budget on Slack pulls reaches the final turn structurally
 * unable to execute the prompt's mandated trailing notify_user. The Oct 25
 * run lost BOTH the digest and the ping (compaction made the pulled detail
 * unquotable); a failing run also cannot file_feedback its own failure.
 *
 * THE FIX (ticket option (b), this suite pins it): the PLATFORM executes
 * the ping at the detached-run finalize — the same
 * executeAccountTool('notify_user') surface the Dig-deeper finalize push
 * uses. Gated on the schedule's OWN stored prompt mandate (never the
 * composed wake text — the doctrine's trigger row quotes the phrase), the
 * run's ok notify_user receipt (never double-ping), a real non-quiet
 * answer, and no cancellation. Kill switch
 * SCHEDULED_NOTIFY_BACKSTOP_DISABLED=1 reverts to pre-fix behavior.
 *
 * Harness copied from followups-backstop.4ac547de.test.ts (itself from
 * owner-answer-first.chat-agent.test.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    count: jest.fn(async ({ where }: any) => (where?.OR ? 0 : 2)),
  },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ title: 'A proper existing title' })),
  },
  chatSchedule: {
    findUnique: jest.fn(async () => null),
  },
  pendingChatMessage: {
    findFirst: jest.fn(async () => null), delete: jest.fn(async () => ({})),
    count: jest.fn(async () => 0), create: jest.fn(async (a: any) => ({ id: 'pend-1', ...a.data })),
  },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
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

jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500), parts: [], receipts: [] })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));
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

// ── THE SEAM UNDER TEST (ticket 8aa5688f) ─────────────────────────────────
// The backstop calls executeAccountTool('notify_user', …) at the finalize
// — the same seam the Dig-deeper finalize push uses. Mocked at the module
// boundary; controllable per test. THE REAL FUNCTION RETURNS A JSON STRING
// (account-tools j(): JSON.stringify(obj, null, 1)) — ok envelopes read
// { ok: true, tool, channel, deliveredTo, chars }, refusals read
// { ok: false, tool, reason, message } — never an object (review finding B2:
// the first cut mocked an object the real function cannot return, making the
// outcome assertion vacuous).
const NOTIFY_OK_ENVELOPE = JSON.stringify({ ok: true, tool: 'notify_user', channel: 'telegram', deliveredTo: '@owner', chars: 100 }, null, 1);
const NOTIFY_REFUSED_ENVELOPE = JSON.stringify({ ok: false, tool: 'notify_user', reason: 'rate_limited', message: 'Hourly cap reached.' }, null, 1);
const mockExecuteAccountTool: jest.Mock = jest.fn(async (...a: any[]) => NOTIFY_OK_ENVELOPE);
jest.mock('../platform/account-tools', () => ({
  __esModule: true,
  executeAccountTool: (...a: any[]) => mockExecuteAccountTool(...a),
}));

const mockVerifySupervisorRunAsync = jest.fn();
const mockVerifyRunActionClaimsAsync = jest.fn();
const mockGuardMachineWakeFinalAnswer = jest.fn(async (...a: any[]) => ({ finalText: a[0].finalText, notice: '', struck: false, phantoms: [] as any[] }));
jest.mock('../platform/action-verifier', () => ({
  __esModule: true,
  verifySupervisorRunAsync: (...a: any[]) => mockVerifySupervisorRunAsync(...a),
  verifyRunActionClaimsAsync: (...a: any[]) => mockVerifyRunActionClaimsAsync(...a),
  guardMachineWakeFinalAnswer: (...a: any[]) => mockGuardMachineWakeFinalAnswer(...a),
  findFutureObservedTimestamps: () => [],
  findUnreadProductionState: () => [],
  PRODUCTION_STATE_STRIKE: 'production_state_unread',
  PRODUCTION_STATE_SEAM: 'machine_wake_production_state',
  isCitationClassClaim: (claim: any) =>
    claim?.fabricatedId === true || ['[evidence citation]', '[owner chat ref]', '[vanished artifact]'].some((tag) => String(claim?.detail ?? '').startsWith(tag)),
  claimAuditExcerpts: (phantoms: any[]) =>
    (Array.isArray(phantoms) ? phantoms : []).slice(0, 4).map((p: any) => ({
      kind: String(p?.kind ?? ''),
      detail: String(p?.detail ?? '').slice(0, 120),
      ...(p?.id ? { id: String(p.id).slice(0, 24) } : {}),
      ...(p?.nearMiss?.length ? { nearMiss: p.nearMiss.slice(0, 4).map((x: any) => String(x).slice(0, 24)) } : {}),
    })),
  toolResultTextsFromParts: (parts: any[]) =>
    (Array.isArray(parts) ? parts : [])
      .filter((p: any) => p && p.type === 'tool_result' && typeof p.result === 'string' && p.result)
      .map((p: any) => p.result),
}));

const mockApplyClaimsBlockLane: jest.Mock = jest.fn((opts: any): any => ({
  finalText: opts.guarded.finalText, notes: opts.guarded.notes, verdict: opts.guarded.verdict,
  lane: { present: false, verified: [], unverified: [], coveredKinds: [] },
}));
jest.mock('../coding/run-evidence-guard', () => ({
  __esModule: true,
  applyClaimsBlockLane: (...a: any[]) => mockApplyClaimsBlockLane(...a),
}));

const mockGenerateOwnerBriefing = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../fleet/owner-briefing.service', () => ({
  __esModule: true,
  OWNER_BRIEFING_KIND: 'owner_briefing',
  generateOwnerBriefing: (...a: any[]) => mockGenerateOwnerBriefing(...a),
}));

const mockEmitHookEventSafe = jest.fn(async (..._a: any[]) => {});
const mockClearHookDepth = jest.fn(async (..._a: any[]) => {});
const mockStampHookDepth = jest.fn(async (..._a: any[]) => {});
const mockOldestPendingHookAgeMs: jest.Mock = jest.fn(async () => 0);
const mockDrainHookEventsForTarget: jest.Mock = jest.fn();
const mockHookBacklogStarving: jest.Mock = jest.fn(async () => false);
const mockDrainHookEventsForTargetNow: jest.Mock = jest.fn(async () => true);
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
  enqueueDirectWake: jest.fn(async (): Promise<any> => ({ ok: true, hookEventId: 'hook-evt-0001' })),
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

const mockRecordLoopMetric: jest.Mock = jest.fn();
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
    FOLLOWUP_BACKSTOP: 'followup_backstop',
    SUPERVISOR_DEFERRAL_UNARMED: 'supervisor_deferral_unarmed',
    DEPLOY_RETIRE_NUDGE: 'deploy_retire_nudge',
    TURN_CONTINUATION: 'turn_continuation',
    SPAWN_TURN_END: 'spawn_turn_end',
    SCHEDULED_NOTIFY_BACKSTOP: 'scheduled_notify_backstop', // ticket 8aa5688f
  },
}));

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

jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/supervisor-state.service'),
  closeAskOnReply: jest.fn(async () => true),
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';
import {
  scheduleMandatesTrailingNotify,
  modelAlreadyNotified,
  isQuietRunReply,
  buildScheduledNotifyMessage,
  scheduledNotifyBackstopDisabled,
  parseNotifyOutcome,
} from './trailing-notify-backstop';

async function waitFor(pred: () => boolean, iterations = 400): Promise<void> {
  for (let i = 0; i < iterations && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for the run');
}

const PLAIN = 'b1c2d3e4-2222-4222-8222-000000000002';
const PLAIN_ROW = { id: PLAIN, title: 'Sunday Market digest', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', projectId: null, leadModel: null };
const SCHEDULE_ID = 'b174c336-23c1-45be-9be7-84ca6042d55e'; // the incident's schedule id shape
const WAKE_PROMPT = '☀️ DAILY 8AM SUNDAY MARKET SLACK DIGEST (recurring — fires ~14:59Z daily). Read the #retail, #orders and #production channels for the trailing 24h. Post the digest as your chat reply. THEN call notify_user with a 1-3 line Telegram summary.';
const NO_MANDATE_PROMPT = 'Read the #retail channel and post a summary as your chat reply.';
const DIGEST = '☀️ Sunday Market digest — 3 restocks, 1 PO pending. Front counter opens 9am; the EB-05 allocation arrived early and 401 Games expects theirs next week.';

let created: any[] = [];
const metrics = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === kind);
const backstopRows = () => metrics('scheduled_notify_backstop');
const notifyCalls = () => mockExecuteAccountTool.mock.calls.filter((c: any[]) => c[1] === 'notify_user');

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
  delete process.env.SCHEDULED_NOTIFY_BACKSTOP_DISABLED;
  (runCodingAgent as jest.Mock).mockReset().mockImplementation(async () => ({ finalText: DIGEST, parts: [{ type: 'text', text: DIGEST }], receipts: [] }));
  mockRecordLoopMetric.mockClear();
  mockExecuteAccountTool.mockReset().mockImplementation(async (...a: any[]) => NOTIFY_OK_ENVELOPE);
  mockPrisma.chatSchedule.findUnique.mockReset().mockImplementation(async () => ({ prompt: WAKE_PROMPT, enabled: true }));
  mockPrisma.crossModelChat.findUnique.mockReset().mockImplementation(async () => ({ ...PLAIN_ROW }));
  mockPrisma.crossModelMessage.findUnique = jest.fn(async () => null);
  mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
  mockPrisma.crossModelMessage.update = jest.fn(async () => ({}));
  mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  mockPrisma.crossModelChat.findUnique.mockReset().mockImplementation(async () => ({ title: 'A proper existing title' }));
  delete process.env.SCHEDULED_NOTIFY_BACKSTOP_DISABLED;
});

/** Drive one SCHEDULED machine wake on a plain chat. */
async function scheduledWake(extra: Record<string, unknown> = {}) {
  const key = await startDetachedChatRun({
    message: WAKE_PROMPT, mode: 'thinking', userId: 'u1', chatId: PLAIN,
    machineWake: true, messageOrigin: 'schedule', firedByScheduleId: SCHEDULE_ID,
    ...extra,
  });
  expect(key).toBe(`chat:${PLAIN}`);
  await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
  await waitFor(() => !isRunActive(key!));
  await new Promise((r) => setTimeout(r, 60));
  return key!;
}

describe('ticket 8aa5688f — the platform trailing-notify backstop at the finalize', () => {
  describe('detection (the stored-prompt mandate detector)', () => {
    it('detects the incident prompt verbatim (THEN call notify_user …)', () => {
      expect(scheduleMandatesTrailingNotify(WAKE_PROMPT)).toBe(true);
    });
    it('detects the doctrine-recommended phrasing', () => {
      expect(scheduleMandatesTrailingNotify('check the fleet board daily and end with "then notify_user with the result"')).toBe(true);
    });
    it('detects plain-English variants (send me the digest via notify_user)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest in the chat, then send me the summary via notify_user.')).toBe(true);
    });
    it('detects the "after that" conjunction (review B3: the first cut missed it)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest as your chat reply. After that, call notify_user with a short summary.')).toBe(true);
    });
    it('detects across a line break (review B3: then\\ncall notify_user)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest as your chat reply.\nthen\ncall notify_user with a 1-3 line summary.')).toBe(true);
    });
    it('does NOT fire on a mention without sequencing', () => {
      expect(scheduleMandatesTrailingNotify('Read #retail and post a summary. Use notify_user only if something urgent appears.')).toBe(false);
    });
    it('does NOT fire on a negation in the next sentence (review B3)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest as your chat reply, then post the summary. Never call notify_user for this digest.')).toBe(false);
    });
    it('does NOT fire on an explicit prohibition after the conjunction (review B3)', () => {
      expect(scheduleMandatesTrailingNotify('Check the board and post the digest, then do not notify_user under any circumstances.')).toBe(false);
    });
    it('does NOT fire on the mention-only shape the first cut\'s negative test missed (review B3: any "then … notify_user" within 80 chars)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then confirm in the chat whether notify_user is even needed for this lane.')).toBe(false);
    });
    it('does NOT fire on the imperative sweep register (re-review B3-r: the "Then check/verify/report … notify_user …" mis-fire class)', () => {
      const sweepRegister = [
        'Then report whether notify_user is wired on this box.',
        'Then check that notify_user credentials still work.',
        'Then verify notify_user is configured.',
        'Then list any notify_user failures from the last 24h.',
        'Then audit notify_user rate-limit refusals.',
        'Then inspect notify_user delivery logs.',
        'Then confirm notify_user is NOT required for this lane.',
        'Post the report, then review notify_user usage across lanes.',
      ];
      for (const p of sweepRegister) expect(scheduleMandatesTrailingNotify(p)).toBe(false);
    });
    it('does NOT fire when the gap is inside the old 20-char window but not adjacent (re-review B3-r: the fixture must fail BY DESIGN, not by margin)', () => {
      // A non-adjacent gap between the conjunction and notify_user — inside
      // the OLD 20-char bare window, outside adjacency. If the bare branch
      // ever regresses to a window, this fires.
      expect(scheduleMandatesTrailingNotify('Then check that notify_user works here.')).toBe(false);
    });
    it('fires on the exact-adjacency doctrine shape even with a comma/quote separator', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then, notify_user with the result.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then: "notify_user with the result".')).toBe(true);
    });
    it('fires on polarity-flip idioms (re-review: "don\'t forget to call" is a mandate, not a prohibition)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then don\'t forget to call notify_user with the summary.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then do not forget to call notify_user.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then never skip notify_user.')).toBe(true);
    });
    it('fires across an abbreviation period inside the instruction (re-review: e.g. cut the sentence window)', () => {
      expect(scheduleMandatesTrailingNotify('Then, per the runbook (e.g. the digest section), call notify_user with the summary.')).toBe(true);
    });
    it('the via branch is covered (review N-c: zero coverage on the third matcher)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then push me the summary via notify_user.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then send the findings through notify_user.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then fire the report with notify_user.')).toBe(true);
    });
    it('does NOT fire on a semicolon-bounded mention in the next clause (re-review N-a: ; was not a boundary)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest; notify_user mentioned in the runbook is out of scope.')).toBe(false);
    });
    it('FIRES on the colon-after-conjunction doctrine shape (round-3 B-3R-b: ;/: boundaries deleted real mandates)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest. Then: call notify_user with the summary.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then: send me the summary via notify_user.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest. After that: call notify_user with the summary.')).toBe(true);
    });
    it('FIRES across a semicolon-separated imperative run (round-3 B-3R-b)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest. Then send the summary; call notify_user with it.')).toBe(true);
    });
    it('does NOT fire on a predicate after adjacent notify_user — "then notify_user is optional/not required/forbidden" (round-3 B-3R-c)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest. Then notify_user is optional for this lane.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then notify_user is not required here.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then notify_user should never be used for this lane.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then notify_user is forbidden — the owner muted it.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Never forget the meeting; then notify_user is optional.')).toBe(false);
    });
    it('does NOT fire when a flip idiom\'s continuation is NOT a verb+notify_user (round-3 B-3R-d: the bare call token converted prohibitions to mandates)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest. Then don\'t forget to NOT call notify_user.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then don\'t forget notify_user is optional on quiet days.')).toBe(false);
    });
    it('FIRES on genuine flip idioms with verb forms (round-3 B-3R-d: "don\'t skip calling" went silent when the strip ate the verb)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then never skip calling notify_user.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then don\'t forget to call notify_user with the summary.')).toBe(true);
    });
    it('does NOT fire when the leading window carries a real negation ("don\'t call" is NOT a flip idiom)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest. Then don\'t call notify_user — the owner muted the lane.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then never call notify_user for this digest.')).toBe(false);
    });
    it('an 80-char+ gap between conjunction and verb stays silent (no intervening conjunction)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then walk the dog around the whole neighbourhood twice before breakfast arrives and the sun rises over the distant hills, and call notify_user.')).toBe(false);
    });
    it('a mandate re-anchored by a LATER conjunction still fires (finally/lastly near the verb)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, walk the dog, water the plants, and finally call notify_user with the summary.')).toBe(true);
    });
    it('does NOT fire on the doctrine\'s schedule_message advice row (review B3: the marker guard was a no-op)', () => {
      const doctrineRow = '- check back / remind me / every morning / monitor → schedule_message on this chat (standalone prompt; to reach them outside the app end with "then notify_user with the result")';
      // The REAL shipped doctrine row (capability-doctrine.ts:145) carries NO
      // marker — the guard must work on the row's schedule_message mention.
      expect(scheduleMandatesTrailingNotify(`Post the digest as your chat reply.\n${doctrineRow}`)).toBe(false);
    });
    it('a CONDITIONAL mandate still fires by design (the owner asked to be pinged on urgent firings; the quiet gate keeps quiet mornings silent)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest as your chat reply. If something is urgent, then call notify_user immediately.')).toBe(true);
    });
    it('empty prompt never matches', () => {
      expect(scheduleMandatesTrailingNotify('')).toBe(false);
    });

    // ── ticket f12ab026 — the 4 reviewer-enumerated residues + the safe-direction miss ──
    // Every case below FAILED against the detector as shipped in eb5cf6c29
    // (19/19 reproduced on the differential harness) and is pinned to its
    // corrected behavior.
    it('f12ab026 residue 1: prohibitions phrased outside the NEG word list do NOT fire (spurious-ping direction)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then no need to call notify_user.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then there is no need to call notify_user.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then we should not call notify_user.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then it is unnecessary to call notify_user.')).toBe(false);
    });
    it('f12ab026 residue 1 collateral: an unrelated "not" in a conditional does NOT veto a real mandate', () => {
      expect(scheduleMandatesTrailingNotify('If the report is not empty, then call notify_user with the summary.')).toBe(true);
    });
    it('f12ab026 residue 2: indirect/interrogative framing does NOT fire (the sweep-register class)', () => {
      expect(scheduleMandatesTrailingNotify('Then check whether you can call notify_user from this box.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Then verify we can call notify_user at all.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Then confirm whether to call notify_user.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Then report how to call notify_user from a schedule.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Then document how to use notify_user.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Then ask whether it is possible to call notify_user.')).toBe(false);
    });
    it('f12ab026 residue 2 collateral: a reporting verb whose lead is NOT interrogative still fires (conditional mandate)', () => {
      expect(scheduleMandatesTrailingNotify('Then check if anything is red and call notify_user with the summary.')).toBe(true);
    });
    it('f12ab026 residue 3: TAIL_PREDICATE over-reach on (A)/(C) tails — the mandate still fires (safe-direction regression fixed)', () => {
      expect(scheduleMandatesTrailingNotify('Then call notify_user with the summary; a 1-3 line length is required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Then call notify_user with the summary, the chart is optional.')).toBe(true);
    });
    it('f12ab026 residue 3: TAIL_PREDICATE IS applied to branch (B) preposition-led tails — no spurious ping', () => {
      expect(scheduleMandatesTrailingNotify('Then notify_user for this lane is not required.')).toBe(false);
    });
    it('f12ab026 residue 3 collateral: a true prohibition INSIDE the adjacent segment still silences (B)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest. Then notify_user with a summary is not required for this lane.')).toBe(false);
    });
    it('f12ab026 residue 4: BARE_TAIL_OK false friends do NOT fire', () => {
      expect(scheduleMandatesTrailingNotify('then notify_user and Slack both work')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then notify_user now exists as a tool')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then notify_user for reference only')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then notify_user with nothing')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then notify_user to confirm it exists is not needed')).toBe(false);
    });
    it('f12ab026 safe-direction miss: a standalone flip idiom with no conjunction still fires', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest as your reply. Don\'t forget to call notify_user with a summary.')).toBe(true);
    });
    it('f12ab026 safe-direction miss collateral: the synthesized conjunction anchor still routes through the (A) discipline — a tail negation vetoes the flip', () => {
      // The rewrite SYNTHESIZES ' then call notify_user' so branch (A) can
      // anchor the standalone flip — this test proves the anchor does not
      // BYPASS the (A) guards: a negation in the flip's tail still vetoes.
      expect(scheduleMandatesTrailingNotify('Post the digest as your reply. Don\'t forget to call notify_user — never with the full digest.')).toBe(false);
      // …and the content-word "no" alone (about the summary, not the call)
      // does NOT veto — the flip is a mandate either way.
      expect(scheduleMandatesTrailingNotify('Post the digest as your reply. Don\'t forget to call notify_user with no summary at all.')).toBe(true);
    });
    it('f12ab026 collateral edge probes (the scoping rules): predicate-in-later-clause still fires / about-the-call predicates stay silent', () => {
      // Tail scoping: a prohibition INSIDE the adjacent segment silences; a
      // single-word negation in ANY segment silences; only a non-anaphoric
      // PREDICATE in a later segment (about the length/chart) does not.
      expect(scheduleMandatesTrailingNotify('then call notify_user, which is not required here')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then call notify_user — no need to wait for the digest')).toBe(true);
      // Reporting-verb lead WITHOUT interrogative ending still fires.
      expect(scheduleMandatesTrailingNotify('Then check if anything is red and call notify_user with the summary.')).toBe(true);
    });
    // ── re-review (round 2) of the f12ab026 hardening — B-1/B-1'/N-1/N-2/N-3 ──
    // Every case below FIRED against the first hardening cut (commit f124d423)
    // in the spurious-ping direction (B-1*, N-1) or went silent in the safe
    // direction (N-2, N-3); all are pinned to the remediated behavior.
    it('re-review B-1: a restriction in a LATER tail segment still vetoes — segment-1 scoping reverted, no spurious ping', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but only if something is urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, unless the run is empty.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; calling it is forbidden.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but never with the raw JSON.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; do not call it twice.')).toBe(false);
    });
    it('re-review B-1c/B-1\': an anaphoric-tail predicate ("which is optional / not required") vetoes — comma position no longer decides', () => {
      expect(scheduleMandatesTrailingNotify('Then call notify_user with the summary, which is optional on quiet days.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then call notify_user with a summary, which is not required here')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then call notify_user with the summary, which is optional.')).toBe(false);
    });
    it('re-review N-1: open negative-predicate class — "is unnecessary / is not wanted / is pointless" veto the flip tail', () => {
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user — the ping is unnecessary.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user — it is not wanted on quiet mornings.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user; a ping is pointless here.")).toBe(false);
      // The reviewer's verbatim (ungrammatical but detector-reachable) shapes:
      expect(scheduleMandatesTrailingNotify("Don't forget to call notify_user is unnecessary.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Don't forget to call notify_user is not wanted.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Don't forget to call notify_user is pointless.")).toBe(false);
    });
    it('re-review N-2: a later genuine mandate is not shadowed by an earlier vetoed mention (every occurrence is tried)', () => {
      expect(scheduleMandatesTrailingNotify('Then check whether you can call notify_user. Then call notify_user with the summary.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Then verify we can call notify_user at all. Post the digest, then send me the summary via notify_user.')).toBe(true);
    });
    it('re-review N-3: anchored false friends — real mandates containing "nothing urgent" / "that exist(s)" still fire', () => {
      expect(scheduleMandatesTrailingNotify('then notify_user with nothing urgent.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('then notify_user the findings that exist.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('then notify_user with the summary that now exists.')).toBe(true);
    });
    // ── round-3 re-review (R3-A/B/C/D/E) — every probe row the reviewer and
    // its cross-family review reproduced, pinned to the remediated behavior.
    // The differential corpus (126 probes, value-failures=0) holds the same
    // rows; these pins guard the committed contract.
    it('round-3 R3-A: predicates about THE PING with call-synonym/pronoun subjects veto — no spurious ping', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but this is not required on quiet days.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, though this is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, although the notification is forbidden here.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but they are not required today.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; this is not required on quiet days.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; but the ping is not required on quiet days.')).toBe(false);
      // the author's pinned wording mirrored past a semicolon, and synonyms:
      expect(scheduleMandatesTrailingNotify('then call notify_user; which is not required here')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the message is not required today.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but such a call is unnecessary.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the notification is off.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; they are unnecessary here.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the pings are not wanted.')).toBe(false);
    });
    it('round-3 R3-B: imperative prohibitions (skip/omit/hold/suppress/forgo/drop it) veto — no spurious ping', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but skip it on green days.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; omit the ping on quiet mornings.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but hold the notification until the owner asks.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; suppress it for this lane.')).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest. Don't forget to call notify_user; forgo it on quiet days.")).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but drop them if nothing is urgent.')).toBe(false);
      // imperative about CONTENT stays mandate-amplifying — fires:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but skip the chart.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; omit the length line.')).toBe(true);
    });
    it('round-3 R3-C: conditional connectives beyond "only if" (only on/only when/except) veto — no spurious ping', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but only on red mornings.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, with anything except the full digest.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and only when something is urgent.')).toBe(false);
      // a formatting exception scoped by a PRECEDING numeric bound stays a mandate:
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; keep it under 10 lines except on red days.')).toBe(true);
    });
    it('round-3 R3-D: benign "not <descriptor>" clauses about the CONTENT do not silence the mandate (recall loss fixed)', () => {
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and it is not more than 3 lines.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, which is not too long.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, if that is not a problem.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; it is not a long message.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, although that is not final yet.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and the chart is not needed.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; which is not final yet.')).toBe(true);
    });
    it('round-3 R3-E: semicolon/comma symmetry — content-noun tails never veto on either side; anaphoric tails veto on both', () => {
      // content-noun subject (the length/chart/summary) — the ticket's own
      // residue-3 doctrine, now position-independent:
      expect(scheduleMandatesTrailingNotify('Then call notify_user with the summary; the chart is optional.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Then call notify_user with the summary, the length is optional.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the summary is optional.')).toBe(true);
      expect(scheduleMandatesTrailingNotify("Post the digest. Don't forget to call notify_user; the length is optional.")).toBe(true);
      // anaphoric subject — vetoes on either side (the asymmetry must not
      // invert): "it is optional" is a prohibition wherever it sits.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, it is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; calling it is forbidden.')).toBe(false);
      // flip + B1c tail still vetoes (the reviewer's NS17 adjudication):
      expect(scheduleMandatesTrailingNotify("Post the digest. Don't forget to call notify_user with the summary, which is optional on quiet days.")).toBe(false);
    });
    // ── round-4 re-review (R4-1/R4-2) — the two BLOCKING spurious-ping classes
    // the reviewer convicted on the round-3 vocabulary, pinned to the round-5
    // remediated behavior: contraction-copula normalization (R4-1) and
    // head-noun subject scoping (R4-2).
    it('round-4 R4-1: contracted copulas (it\'s/they\'re/x\'s not …) are prohibitions too — no spurious ping', () => {
      // the reviewer's three regression rows (old=false, r2=true, new=true):
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required today.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but they're not wanted here.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but the ping's not needed.")).toBe(false);
      // the un-flipped plain variants (the reviewer's pre-existing B1/B2/B3
      // fires, old=true) are fixed by the same normalization — safe direction:
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary, but it's not required today.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary, but it's optional on quiet days.")).toBe(false);
      // control: the identical shape with a FULL copula vetoes (round-3 S1):
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary, but it is not required today.")).toBe(false);
      // control: a possessive that is NOT a predicate passes through
      // untouched — the normalization is gated on the predicate continuation:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; the chart\'s data is included.')).toBe(true);
    });
    it('round-4 R4-2: call-synonym subjects carrying content-noun modifiers/PPs are prohibitions — no spurious ping', () => {
      // the reviewer's regression rows (unanchored CONTENT_NOUN exempted them):
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the call with the chart summary is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert for the chart is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart\'s ping is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the pings for the charts are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert about the findings is off.')).toBe(false);
      // controls — strip the modifier/PP and the identical shape vetoes (R3-A):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert is not wanted this week.')).toBe(false);
      // control — the content noun as the HEAD stays mandate-amplifying (the
      // ticket's residue-3 doctrine; the reviewer's A18 control):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart is not required.')).toBe(true);
    });
    it('round-4 R4-C: a numeric bound in one conjunct does not disarm a call gate in another — no spurious ping', () => {
      // the reviewer's conviction row: the format bound ("under 10 lines")
      // and the call gate ("only if urgent") sit in DIFFERENT conjuncts —
      // the gate still vetoes (old=false, r2=false, round-3 new=true):
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; keep it under 10 lines and only if urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; keep it under 10 lines and only when something is urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, no more than 3 lines and only if urgent.')).toBe(false);
      // control — the bound and the connective in the SAME conjunct scope the
      // FORMAT and the mandate fires (round-3 R3-C, unchanged):
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; keep it under 10 lines except on red days.')).toBe(true);
      // controls — a lone call gate, or connective-before-bound, vetoes:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but only if something is urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, only if the digest is under 3 lines.')).toBe(false);
    });
    it('round-4 R4-E: false friends veto only the notify_user-ADJACENT segment — a later capability remark does not silence a real mandate', () => {
      // the reviewer's recall-loss rows: the false friend sits in a LATER
      // ;/, segment — a separate remark about capabilities, not a
      // prohibition on the call. The mandate fires (old=true, round-3 new=false):
      expect(scheduleMandatesTrailingNotify('then notify_user with the summary; and Slack both work.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('then notify_user with the summary; it now exists as a tool.')).toBe(true);
      // controls — the SAME false friend in the ADJACENT clause still vetoes
      // (ticket residue 4 / re-review N-3, unchanged):
      expect(scheduleMandatesTrailingNotify('then notify_user and Slack both work')).toBe(false);
      expect(scheduleMandatesTrailingNotify('then notify_user now exists as a tool')).toBe(false);
    });
    // ── round-5 re-review (msg 99e67d1c, NOT-MERGE-SAFE) — five classes,
    // pinned to the round-6 remediated behavior. Row labels and transition
    // fingerprints (old/f124/r2/dca/r5) are the reviewer's, reproduced
    // against six git-blob detectors this round.
    it('round-5 R5-1: EVERY connective-bearing conjunct is bound-checked — a format exception in conjunct 0 cannot disarm a call gate in conjunct 1', () => {
      // the reviewer's conviction rows (old=false f124=true r2=false
      // dca=true 63aa=true): the round-4 findIndex examined only the FIRST
      // connective-bearing conjunct, so "…under 10 lines except on red days
      // AND only if urgent" read the format exception and missed the live
      // call gate:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; keep it under 10 lines except on red days and only if urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, keep it under 10 lines except on red days and only if urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; max 20 lines except weekends and only if urgent.')).toBe(false);
      // controls — bound and gate in DIFFERENT conjuncts with no exception
      // (round-4 R4-C, unchanged), and same-conjunct exception scoping the
      // FORMAT (round-3 R3-C, still fires):
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; keep it under 10 lines and only if urgent.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; keep it under 10 lines except on red days.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, only if the digest is under 3 lines.')).toBe(false);
    });
    it('round-5 R5-2: a coordinated subject is read conjunct by conjunct — a call-word conjunct smuggles no exemption past a content conjunct', () => {
      // the reviewer's conviction rows (old=false f124=true … 63aa=true):
      // the head test read only the LAST conjunct, so "the ping and the
      // summary" (a real prohibition on the ping) read as content:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping and the summary are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert and the digest are not wanted.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the notification and the summary are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the call and the chart summary are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the ping and the summary are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the message and the digest are not required.')).toBe(false);
      // controls — the call word LAST vetoes in every round (position
      // symmetry, the reviewer's A22/A26), and a fully-content coordination
      // stays mandate-amplifying (A21):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the summary and the ping are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the digest and the alert are not wanted.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart and the summary are optional.')).toBe(true);
    });
    it('round-5 R5-4: a compound [call-synonym + content noun] head is a CALL — the ping\'s parts named by their call-synonym head', () => {
      // the reviewer's conviction rows (old=false f124=true 63aa=true), plus
      // the round-4 A10 precedent ("the summary ping") in the same order:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping summary is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the notification body is not required.')).toBe(false);
      // pre-existing at old=true (the reviewer's adjudication) — fixed by the
      // same rule now:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert text is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the summary ping is not required.')).toBe(false);
      // controls — the bare call word vetoes (A16); the content HEAD stays
      // mandate-amplifying (A18):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart is not required.')).toBe(true);
    });
    it('round-5 R5-3: the contraction rewrite is gated on PREDICATIVE position — attributive adjectives and hyphenated compounds pass through untouched', () => {
      // the reviewer's minted-silence rows (old=true dca=true 797=false
      // 63aa=false, want true): a possessive followed by an ATTRIBUTIVE
      // predicate word ("the alert's optional status line") was rewritten
      // into a copula the sentence never had, minting a veto:
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the alert's optional status line is included.")).toBe(true);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the report's needed columns are listed in the digest.")).toBe(true);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the ping's not required line items are listed separately.")).toBe(true);
      // hyphen-bounded predicate words are part of the compound, never a
      // predicate (the reviewer's C1m/C2m hyphenated rows):
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the digest's optional-only sections are fine.")).toBe(true);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the box's off-hours settings are unchanged.")).toBe(true);
      // controls — a REAL predicative contraction still vetoes (round-4
      // R4-1, G2/B12), and a coordinator opens a new clause so a later
      // copula does not rescue an attributive reading:
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required today.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but the ping's not needed.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the chart's data is included.")).toBe(true);
      // attack rows on the predicative gate (round-6 author probes):
      // a later copula PAST a conjunction keeps the rewrite — the later
      // copula belongs to a different clause, the prohibition still vetoes:
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required and the digest is long.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required when the run is empty.")).toBe(false);
      // a long attributive noun phrase (5 words to the later copula) is
      // still attributive — the window covers it:
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the alert's optional status of the report line is included.")).toBe(true);
    });
    it('round-5 R5-5: the prepositional-tail cut never splits a hyphenated compound — "alert-with-chart" is one word', () => {
      // the reviewer's recall-loss row (old=false f124=true r2=true dca=true
      // 797=false 63aa=false, want true): SUBJECT_PP matched the "with"
      // inside "alert-with-chart" and truncated the head to "the alert",
      // re-breaking a shape the early rounds had fixed:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert-with-chart notes are not required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart-with-findings notes are not required.')).toBe(true);
      // controls — a FREE-STANDING prepositional tail is still cut and the
      // call-synonym head still vetoes (round-4 R4-2, unchanged):
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the call with the chart summary is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the notification for this lane is not required.')).toBe(false);
    });
    it('round-6 R6-1: comma-coordinated subject lists are governed conjunct by conjunct — a list comma before a noun run + coordinator + shared copula is normalized to its and-form', () => {
      // the reviewer's conviction rows (A23-class, unsafe since f124d423c;
      // family R6-1a/c/d/g/i/j + minimal pair MP1-2): segmentsOf's ;/, split
      // isolated each comma conjunct in its own predicate-less segment, so
      // the call-word conjunct smuggled past the conjunct discipline:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert, the digest and the summary are not wanted.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the notification, the digest and the chart are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the call, the summary and the digest are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the message, the digest and the summary are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping, the digest, the summary and the chart are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest. Then call notify_user with the summary; the alert, the notification and the ping are not wanted.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping, the chart and the summary are not required.')).toBe(false);
      // controls — a fully-content comma coordination stays mandate-
      // amplifying, ordinary comma tails keep splitting, and the non-comma
      // form (MP1-1) keeps its round-5 fix:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the summary and the digest are optional.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping and the chart are not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and Slack both work.')).toBe(true);
    });
    it('round-6 R6-2: comma-less subordinators open clauses too — the CLAUSE_BREAK vocabulary is complete, and n\'t contractions normalize like s/\'re ones', () => {
      // the reviewer's minted rows (twelve, R6-2a–l): whereas/whilst/
      // provided/given/in case/assuming/whenever/wherever/however were
      // missing from CLAUSE_BREAK, so the later copula blocked the rewrite
      // and a real prohibition FIRED:
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required today whereas the digest is long.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not needed whilst the boxes are green.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required provided the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required given the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required in case the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required assuming the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required whenever the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required wherever the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required however the digest is short.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but the ping's not needed whereas the digest is long.")).toBe(false);
      // the n't shape (R6-2k/l): "it isn't required" is the same prohibition
      // — the apostrophe sits inside the copula, so the s/'re normalizer
      // never saw it at any round:
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it isn't required today whereas the digest is long.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it isn't needed whilst the boxes are green.")).toBe(false);
      // control — the SAME shape with a coordinator (MP2-1) already kept
      // its rewrite:
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not required today and the digest is long.")).toBe(false);
    });
    it('round-6 R6-5: a call-FIRST hyphen compound AS THE WHOLE HEAD is a CALL — "the ping-with-chart" names the ping in compound form', () => {
      // the reviewer's minted rows (MP5-2 + R6-5b/c/e): the R5-5 space-bounded
      // PP cut left "ping-with-chart" one token ending in "chart" → content
      // head → exemption → FIRE:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping-with-chart is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert-with-summary is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the notification-with-digest is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the message-with-chart is not wanted.')).toBe(false);
      // controls — a FREE content noun after the compound is the head (AX10 /
      // X-B2.1 / X-B2.2 stay true), and the SPACED form still vetoes (MP5-1):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the call-with-chart summary is not required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert-with-chart notes are not required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart-with-findings notes are not required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping with the chart is not required.')).toBe(false);
    });
    it('round-6 R6-F2: hyphenated predicative idioms are predicates — "it\'s off-limits" vetoes like its full-copula twin', () => {
      // the reviewer's minted rows (H-F2a/d) + pre-existing (H-F2b/e): the
      // hyphen boundary guard (?![\w-]) blocked "off" inside "off-limits",
      // and "out-of-scope" failed PRED_ADJ's spaced form, so a prohibited
      // ping whose predicate was hyphenated FIRED:
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's off-limits for this lane.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's out-of-scope for this lane.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but the ping's off-limits.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it's not-needed today.")).toBe(false);
      // controls — the full copula always vetoed, and hyphenated ATTRIBUTIVE
      // compounds stay untouched (C1m/C2m):
      expect(scheduleMandatesTrailingNotify("Post the digest as your reply. Don't forget to call notify_user with the summary, but it is off-limits for this lane.")).toBe(false);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the digest's optional-only sections are fine.")).toBe(true);
      expect(scheduleMandatesTrailingNotify("Post the digest, then call notify_user with the summary; the box's off-hours settings are unchanged.")).toBe(true);
    });
    it('round-6 R6-4: a LENGTH measurement of the message is content — "the message length" is not the ping; the ping\'s parts still are', () => {
      // the author-guided recall rows (R6-4a/b/c: true at 63aa07d37, silenced
      // at 444524425) — a measurement OF the message is mandate-amplifying
      // detail, so the veto must NOT fire:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the message length is not required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the alert length is not required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the ping length is not required.')).toBe(true);
      // control — the ping's PARTS stay call-anaphoric (R5-4 X-N2 class):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the message body is not required.')).toBe(false);
    });
    it('round-8 R7-1: Oxford / asyndetic / unarticle\'d / semicolon lists are normalized like bare and-lists — the call conjunct cannot smuggle past a list-comma form', () => {
      // reviewer round-7 verdict (msg 348bb9ef) BLOCKING R7-1a–h + MP1-2ox/asy
      // + A23ox: the round-7 LIST_COMMA normalizer covered only the bare
      // "A, B and C" shape (zero Oxford fixtures pinned), so every other list
      // form left the call conjunct in its own predicate-less segment and the
      // mandate fired (unsolicited-ping class, want=false). The round-8
      // segmentsOf merge (per-separator right-to-left with structural guards)
      // folds every form into its and-form BEFORE the split, so the
      // conjunct-by-conjunct head discipline governs comma lists exactly like
      // and-lists. All rows were true at both 44452442 and 3bfa5f83.
      const BASE = 'Post the digest, then call notify_user with the summary';
      // R7-1a — Oxford comma, determiner-led items:
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the chart, the ping, and the digest are not required.`)).toBe(false);
      // R7-1b — asyndetic (no coordinator before the last item):
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the chart, the ping, the digest are not required.`)).toBe(false);
      // R7-1c — Oxford list with a singular copula ("the digest is"):
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the chart, the ping, and the digest is not required.`)).toBe(false);
      // R7-1d — semicolon-separated list:
      expect(scheduleMandatesTrailingNotify(`${BASE}; the chart; the ping; the digest are not required.`)).toBe(false);
      // R7-1e — unarticle'd Oxford list (bare-noun items):
      expect(scheduleMandatesTrailingNotify(`${BASE}, but chart, ping, and digest are not required.`)).toBe(false);
      // R7-1f — "not wanted" predicate form:
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the chart, the ping, and the digest are not wanted.`)).toBe(false);
      // R7-1h — the call word LAST in the Oxford list:
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the digest, the chart, and the ping are not required.`)).toBe(false);
      // MP1-2ox — the round-6 minimal pair with ONE Oxford comma added
      // (3bf flipped correct→fires; the minimal-pair discipline the verdict
      // demanded):
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the ping, the chart, and the summary are not required.`)).toBe(false);
      // MP1-2asy — the same row asyndetic:
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the ping, the chart, the summary are not required.`)).toBe(false);
      // A23ox — the A23 class in Oxford form:
      expect(scheduleMandatesTrailingNotify(`${BASE}; the ping, the chart, and the summary are not required.`)).toBe(false);
      // CONTROLS — the all-content Oxford list stays mandate-amplifying
      // (content subjects fire), the verbatim MP1-2 row stays silent, and
      // the no-comma MP1-1 row keeps firing:
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the chart, the digest, and the summary are not required.`)).toBe(true);
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the ping and the summary are not required.`)).toBe(false);
      expect(scheduleMandatesTrailingNotify(`${BASE}, but the ping and the chart are required.`)).toBe(true);
    });
    it('round-8 R7-2: a content clause inside a list does not over-merge across its boundary — the mandate stays governed', () => {
      // reviewer round-7 verdict (msg 348bb9ef) BLOCKING R7-2b/c/g/h (minted
      // in round 7): the round-7 list-comma fix over-merged across a
      // content-clause boundary — "the digest is fine, the alert and the
      // summary are not wanted" read "the alert" as a list conjunct of the
      // CONTENT clause and the call conjunct escaped. The round-8 LEFT guard
      // requires a verb-free conjunct run since the previous separator, so a
      // clause ("the digest is fine") is never merged over; the minimal pair
      // R7-2mp (comma→and) behaves identically. 44452442 was correct on
      // R7-2b/g and the semicolon control; R7-2c/h and R7-2mp had fired there.
      const FLIPBASE = `Post the digest as your reply. Don't forget to call notify_user with the summary`;
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}; the digest is fine, the alert and the summary are not wanted.`)).toBe(false);
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}; the summary is fine, the alert and the digest are not required.`)).toBe(false);
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}; the chart is fine, the ping and the digest are not wanted.`)).toBe(false);
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}, but the digest is fine, the alert and the summary are not wanted.`)).toBe(false);
      // R7-2mp minimal pair — comma→and (the coordinator form):
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}; the digest is fine and the alert and the summary are not wanted.`)).toBe(false);
      // CONTROLS — the semicolon shape (no comma over-merge) stays governed,
      // and the all-content comma form still fires:
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}; the digest is fine; the alert and the summary are not wanted.`)).toBe(false);
      expect(scheduleMandatesTrailingNotify(`${FLIPBASE}; the digest is fine, the chart and the summary are not wanted.`)).toBe(true);
    });
    it('round-8 R7-4b family (DOCUMENTED-CURRENT, non-blocking, safe direction): a content subject behind a comma clause-break is read as a veto — inherited silence, pinned against further drift', () => {
      // reviewer round-7 verdict (msg 348bb9ef) NON-BLOCKING R7-4b (minted
      // round 7, safe direction): subjectOf's subject window ([\\w\\s'-], no
      // comma) cannot cross the comma into a trailing content subject, so
      // "but the churn analysis and the delivery summary are not required"
      // is read as a veto and the wake is skipped. Doctrine-correct want is
      // TRUE (a content subject is mandate-amplifying — 44452442 fired);
      // pinned at the CURRENT behavior to make the drift visible, with the
      // doctrine-desired value in comments. The comma-permeable subject
      // re-anchoring fix is deliberately deferred (the round-7 verdict
      // scoped this class non-blocking; widening the window is what minted
      // R7-2). The long form whose final head lands INSIDE the window still
      // fires — the recall side of the family is intact.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the churn analysis and the delivery summary are not required.')).toBe(false); // want=true (doctrine)
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the quarterly revenue breakdown table, the regional sales split, the churn cohort analysis, and the delivery summary are not required.')).toBe(true);
      // H-F6b (NON-BLOCKING, safe direction, minted round 7): the arming
      // gate's except-clause convergence — an except-phrase after the
      // cadence stops the mandate from arming (44452442 also silent).
      // Doctrine-correct want is TRUE; pinned documented-current.
      expect(scheduleMandatesTrailingNotify('post the digest, then call notify_user with the summary every day except Sundays.')).toBe(false); // want=true (doctrine)
    });
    it('round-9 H-F4a: distributed negation (neither … nor) with a required-side complement is prohibitive — the ping conjunct cannot escape an un-carried prohibition', () => {
      // Round-8 verdict (msg a934fad7, 11:17Z) BLOCKING-1: "neither the ping
      // nor the summary is required" distributes the prohibition over both
      // conjuncts (≡ "the ping or the summary is not required" — the pinned
      // R7-2d form), but the neither…nor frame carries no not/never carrier,
      // PRED_NOT never matched, the segment read unpredicated and the
      // mandate fired a spurious ping (as-shipped eb5cf6c29 silent →
      // PR-head true; unpinned — zero "neither" fixtures in the suite). The
      // NEITHER_DISTRIB branch counts the frame as predicated; the subject
      // scoping then reads its conjuncts and vetoes when a conjunct's head
      // is a call word. Minimal pairs: the not-carrier form and the or-form
      // already vetoed directly (kept false); "neither … nor … is optional"
      // reads BOTH mandatory — mandate-amplifying, still fires; an
      // all-content neither-frame ("neither the digest nor the length is
      // required") is detail, still fires.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping nor the summary is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping nor the digest is required.')).toBe(false);
      // minimal pairs (the mechanism's own controls — round-8 verdict):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping nor the summary is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; the ping or the summary is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping nor the summary should be required.')).toBe(false);
      // recall controls: optional-side (both mandatory) and all-content
      // neither-frames stay mandate-amplifying detail — the mandate fires.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the chart nor the summary is optional.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the digest nor the length is required.')).toBe(true);
    });
    it('round-9 R8-C6/C8: a trailing coordinated appendix after a prohibition list does not defeat the list merge — the appendix is cut and segmented, the ping veto re-forms', () => {
      // Round-8 verdict (msg a934fad7) BLOCKING-2: "…but the chart, the
      // ping, and the digest are not required, and the summary is optional"
      // — the appendix chunk carries a verb, rightIsConjunctList's item
      // validation failed at every separator, the R7-1 merge was refused
      // and the veto on the prohibited ping never re-formed (as-shipped
      // silent → PR-head true; byte-fingerprint of the round-7 R7-1a
      // conviction, its fifth form). The APPENDIX_SEP cut removes a
      // trailing ", and <noun> <copula> …" appendix whose left side is
      // already a completed clause; the appendix lands as its own segment
      // (content subject, exempt). Minimal pair: the semicolon form
      // (R8-C7) always segmented — stays false; R8-C8 (", and the summary
      // is fine") same class. The appendix-veto control (", and the ping
      // is not required") keeps its veto, and the Oxford completing comma
      // (", and the digest are not required") never cuts — its left side
      // is a bare conjunct run, not a completed clause.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and the summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required today, and the summary is fine.')).toBe(false);
      // minimal pairs:
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required; the summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and the ping is not required.')).toBe(false);
      // recall control: the plain Oxford veto shape (R7-1a) is unchanged.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required.')).toBe(false);
      // recall control: a content-only appendix after a content list —
      // "the chart, the digest, and the summary are not required, and the
      // table is fine" — has no call conjunct; the mandate still fires.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the digest, and the summary are not required, and the table is fine.')).toBe(true);
    });
    it('round-10 CLASS 1: a serial-comma neither-list (", neither the ping, the chart, nor the digest is required") is pre-normalized before the ;/, split — the ping cannot scatter into predicate-less segments', () => {
      // Round-9 verdict (msg 230703a2, 13:48Z) BLOCKING-1: the neither-frame
      // matches NEITHER_DISTRIB whole, but the final ;/, split scatters it
      // into predicate-less segments ("neither the ping" / "the chart" /
      // "nor the digest is required") — the copula lands in the LAST
      // segment, the call conjuncts sit unpredicated and the mandate fired a
      // spurious ping (old=false → 33c9b8ac=true → ed9=true; pre-existing,
      // not minted by the ed9 delta). The round-10 normalizer rewrites the
      // serial chain to its REPEATED-nor form BEFORE the split ("neither the
      // ping nor the chart nor the digest is required") — the SAME veto path
      // as the pinned two-item form (NEITHER_DISTRIB predicates the frame,
      // predicatedAboutCall reads the conjuncts). Guards: every rewritten
      // comma must be followed by an item-shaped conjunct (determiner-led
      // noun phrase) optionally headed by nor, and a candidate that OPENS
      // with a verb/copula/negation is a CLAUSE conjunct — the chain REFUSES
      // (no rewrite, exact pre-existing scatter). Minimal pair: the two-item
      // form (no comma) never rewrote and already vetoed.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, nor the digest is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart nor the digest is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, nor the summary is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, nor the digest is required today.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but neither the ping, the chart, nor the digest is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, nor the summary are required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, the digest, nor the summary is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify("Don't forget to call notify_user with the summary; neither the ping, the chart, nor the digest is required.")).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, nor the digest is required on quiet mornings.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart, nor the summary should be required.')).toBe(false);
      // minimal pair: the two-item neither…nor form (the pinned round-9
      // H-F4a shape) is untouched byte-for-byte.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping nor the chart is required.')).toBe(false);
      // recall controls: a plain mandate still fires; a neither-frame whose
      // conjuncts are CLAUSES ("neither the run is empty, nor the summary is
      // required") refuses the rewrite and keeps its exact pre-existing
      // verdict; a serial chain whose FIRST item is a multi-token PP
      // ("the owner of the bot") refuses (NM_ITEM caps the item) and keeps
      // its pre-existing verdict; an all-content clause-frame is detail.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; the ping and the chart are required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the run is empty, nor the summary is required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the owner of the bot, the chart, nor the digest is required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the run is empty, nor the data is stale.')).toBe(true);
    });
    it('round-10 CLASS 2: appendix shapes outside the round-8 whitelist — but-coordinator, multi-token/possessive subject, imperative (with and without the coordinator), the no-space coordinate form and the negative imperative — are all cut, and the ping veto re-forms', () => {
      // Round-9 verdict (msg 230703a2) BLOCKING-2 residuals: every appendix
      // shape below left rightIsConjunctList failing at its separator —
      // A-x12 (", but the summary is optional"): but was outside the
      // coordinator set; R9-P9a/A-x14 (multi-token/possessive subject "the
      // quarterly summary" / "the owner’s summary"): the subject span
      // allowed one token; R9-P5a (imperative ", and keep the report
      // short."): no copula to anchor; the no-space coordinate form
      // ("required,and the summary is optional."): APPENDIX_SEP anchored on
      // ",\s+"; and the negative imperative (", and don’t ping the owner
      // twice."): a copula-less PROHIBITION the merge cannot read — the veto
      // never re-formed and the mandate fired (all old=false → 33c=true →
      // ed9=true; the negative imperative is a round-10 fresh find,
      // 7th form of the appendix family). Fixes: APPENDIX_SEP admits but
      // and a ≤3-token/possessive subject span, anchors on ",\s*"; the
      // imperative branch cuts before a boundary-verb imperative (VERB_RE
      // left guard); the negative-imperative branch cuts ONLY when the left
      // side already ends in a prohibition (it can never disarm a real
      // veto). Veto controls: a veto echo (", and do not skip the summary")
      // keeps its veto; the one-token pins and the semicolon forms keep
      // vetoing (round-9 pins).
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, but the summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and the quarterly summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and the owner’s summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and keep the report short.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, keep the report short.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required,and the summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and don’t ping the owner twice.')).toBe(false);
      // veto controls: a veto echo in the same coordinated tail keeps its
      // veto; the round-9 one-token pin and semicolon form keep vetoing.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and do not skip the summary.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and the summary is optional.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required; the summary is optional.')).toBe(false);
      // recall controls: all-content lists have no call conjunct — an
      // appended don’t-imperative or but-appendix is mandate-amplifying
      // detail, still fires (the negative-imperative cut is refused there:
      // its left side carries no prohibition to reinforce).
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the digest, and the summary are not required, and don’t ping the owner twice.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the digest, and the summary are not required, but the table is fine.')).toBe(true);
    });
    it('round-11: the two round-10 FINAL BLOCKING classes (msg 3f206f91) — fresh-verb imperative appendices (R10-A1) and clause-conjunct neither frames (R10-A2) — are fixed; their minimal pairs and every round-10 pin hold', () => {
      // Round-10 FINAL verdict (reviewer lane d5b198e0, msg 3f206f91,
      // 19:08Z): NOT-MERGE-SAFE, two BLOCKING classes, both PR-introduced
      // and both self-reproduced with minimal pairs (delta mints nothing,
      // B=0).
      // R10-A1 (IA-5/IA-6): the round-10 imperative cut gated on a CLOSED
      // verb allowlist {keep,limit,cap,hold,maintain,stay,remain}, so fresh
      // imperative shapes — ", and summarize the findings in three lines."
      // / ", and send a copy to the archive." — escaped and the mandate
      // fired a spurious ping (both true at the round-10 head). The cut is
      // widened to ANY verb-opening appendix whose left side is verbful,
      // with the disarm-safety precondition made explicit and symmetric
      // with the negative-imperative branch: a LEFT side that carries a
      // prohibition may discard ANY appendix (the veto survives the cut —
      // the cut only ENABLES the merge guards, and the left VERB_RE + item
      // chain + PROHIB_TAIL still gate); a clean LEFT side may discard only
      // a veto-free appendix (no PROHIB_TAIL vocabulary, no call-anaphoric
      // token, no negative-imperative lead — that lead belongs to the NI
      // branch below, whose left-prohibition precondition is untouched).
      // R10-A2 (NM-3b/NM-15): the clause-refusal path PRESERVES the
      // scattered neither-frame, but the second segment ("nor the ping is
      // required") carried no predication shape — TAIL_PREDICATE anchors a
      // copula at the segment start, NEITHER_DISTRIB needs the whole
      // frame — so a call-word conjunct head never vetoed (NM-3b fired),
      // and a SEMICOLON mid-frame ("neither the ping, the chart; the
      // digest is required.") ended the walk exactly like a period and
      // scattered the frame (NM-15 fired). Fixes: the NOR_DISTRIB
      // predication shape (segment opening "nor" + copula + REQUIRED-side
      // complement — the same frame-carried negation NEITHER_DISTRIB
      // encodes; the optional side stays undistributed, mandate-amplifying)
      // subjects "nor the ping is required" through predicatedAboutCall
      // while "nor the summary is required" stays content-exempt; the
      // chain walk crosses a mid-frame ";" after an item-shaped conjunct
      // (the first-word verb/copula refusal and the cop-cut still gate
      // what follows).
      // R10-A1 convictions (verbatim):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and summarize the findings in three lines.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and send a copy to the archive.')).toBe(false);
      // R10-A1 minimal pair: the pinned keep-family keeps its verdict.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and keep the report short.')).toBe(false);
      // R10-A1 disarm controls: a veto-carrying appendix after a CLEAN left
      // side is NOT cut (the veto it carries would have been the only one);
      // a veto echo is never silently discarded.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; the chart is fine, and the ping is not required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and do not skip the summary.')).toBe(false);
      // R10-A1 recall control: a clean left with a plain imperative — the
      // appendix is mandate-amplifying detail, the mandate still fires.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and keep the report short.')).toBe(true);
      // R10-A2 convictions (verbatim):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the run is empty, nor the ping is required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the ping, the chart; the digest is required.')).toBe(false);
      // R10-A2 minimal pair: the author's own NM-3 row — the second
      // conjunct names CONTENT ("the summary") — stays a firing mandate.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary; neither the run is empty, nor the summary is required.')).toBe(true);
      // NI branch untouched: the negative imperative keeps its exact
      // preconditions on both sides.
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the ping, and the digest are not required, and don’t ping the owner twice.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, but the chart, the digest, and the summary are not required, and don’t ping the owner twice.')).toBe(true);
    });
    it('round-12: the inverted neither/nor frame (R12-β, re-derived from the round-11 FINAL NOT-MERGE-SAFE bound) is fixed — the negation lives in the subject-aux inversion and now rides the SAME conjunct head-noun discipline as the normal-order frame', () => {
      // Round-11 FINAL (reviewer lane cfe59504, msg ba03548f, 22:57Z):
      // NOT-MERGE-SAFE with one NEW blocking class the reviewer's own probes
      // found but whose row was lost with its worker (recovery exhausted) —
      // bounded by the verdict to the three round-11 fix surfaces or between
      // them. The round-12 re-derivation battery (tmp/rev12-probes.js: 33
      // rows, verbatim controls, verbful-left gate, R11-MINTED=0 on the
      // interaction space) surfaced the class on the NOR_DISTRIB surface:
      // the SUBJECT-AUX INVERSION of the neither/nor frame — "…, and nor is
      // it required." / "…, and neither is it wanted." — fires a spurious
      // ping at EVERY head (ed9 / round-10 head / round-11 head): the
      // negation lives in the inversion, NOR_DISTRIB's subject-between shape
      // sees nothing between "nor" and the aux, and TAIL_PREDICATE needs a
      // literal not/never. Fix: NOR_INVERT matches the inverted frame with
      // the SAME closed COMPLEMENT list (REQUIRED side only — the OPTIONAL
      // side stays undistributed, "nor is it optional" reads "it is
      // mandatory" and still fires), and the post-aux capture is scoped
      // through the SAME subjectHeadAboutCall conjunct discipline (a plain
      // subjectOf read would hand back the literal word "nor" and veto even
      // the content minimal pair). The delta moves ONLY these shapes T→f;
      // every corpus row and pin holds (verdict-diff changed=4 as before).
      // R12-β convictions (verbatim):
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and nor is it required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and nor is the ping required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('The digest will be posted in the chat, then call notify_user with the summary, and nor is it required.')).toBe(false);
      expect(scheduleMandatesTrailingNotify('Post the digest, then call notify_user with the summary, and neither is it wanted.')).toBe(false);
      // R12-β semicolon-scatter variant (the NM-15 shape under inversion):
      expect(scheduleMandatesTrailingNotify('The digest will be posted in the chat, then call notify_user with the summary; neither the run is empty, nor is it wanted.')).toBe(false);
      // R12-β minimal pairs: a CONTENT post-aux subject stays a firing
      // mandate (the NM-3 symmetry under inversion).
      expect(scheduleMandatesTrailingNotify('The digest will be posted in the chat, then call notify_user with the summary, and nor is the summary required.')).toBe(true);
      expect(scheduleMandatesTrailingNotify('The digest will be posted in the chat, then call notify_user with the summary, and neither is the digest required.')).toBe(true);
      // R12-β optional-side control: the OPTIONAL side is NOT distributed.
      expect(scheduleMandatesTrailingNotify('The digest will be posted in the chat, then call notify_user with the summary, and nor is it optional.')).toBe(true);
      // Recall control: the plain mandate still fires.
      expect(scheduleMandatesTrailingNotify('The digest will be posted in the chat, then call notify_user with the summary.')).toBe(true);
    });
    it('DETECTOR-RECALL REPLAY (f12ab026 detector change): the prior true positives of scheduleMandatesTrailingNotify still fire', () => {
      // The detector's prior true positives — the incident prompt verbatim, the
      // doctrine-recommended phrasing, and every positive shape the 4 review
      // rounds of PR #1987 convicted — replayed verbatim against the hardened
      // detector. A recall erosion here would silently stop platform pings on
      // real mandates (the 8-missed-morning incident class this backstop exists
      // to end).
      const priorTruePositives = [
        WAKE_PROMPT, // the incident prompt (chat 1ea4621f, Oct 18–25)
        'check the fleet board daily and end with "then notify_user with the result"', // doctrine phrasing
        'Post the digest in the chat, then send me the summary via notify_user.',
        'Post the digest as your chat reply. After that, call notify_user with a short summary.',
        'Post the digest as your chat reply.\nthen\ncall notify_user with a 1-3 line summary.',
        'Post the digest, then, notify_user with the result.',
        'Post the digest, then: "notify_user with the result".',
        'Post the digest, then don\'t forget to call notify_user with the summary.',
        'Post the digest, then do not forget to call notify_user.',
        'Post the digest, then never skip notify_user.',
        'Then, per the runbook (e.g. the digest section), call notify_user with the summary.',
        'Post the digest, then push me the summary via notify_user.',
        'Post the digest. Then: call notify_user with the summary.',
        'Post the digest. Then send the summary; call notify_user with it.',
        'Post the digest, then never skip calling notify_user.',
        'Post the digest, walk the dog, water the plants, and finally call notify_user with the summary.',
        'Post the digest as your chat reply. If something is urgent, then call notify_user immediately.',
      ];
      for (const p of priorTruePositives) {
        expect(scheduleMandatesTrailingNotify(p)).toBe(true);
      }
    });
  });

  describe('the receipts gate (never double-ping)', () => {
    it('an ok notify_user receipt proves the model pinged — backstop stays silent', () => {
      expect(modelAlreadyNotified([
        { tool: 'slack_search', ok: true },
        { tool: 'notify_user', ok: true, ids: { channel: 'telegram' } },
      ])).toBe(true);
    });
    it('a refused (ok:false) notify_user receipt is NOT a delivered ping — backstop fires', () => {
      expect(modelAlreadyNotified([
        { tool: 'notify_user', ok: false, ids: { reason: 'rate_capped' } },
      ])).toBe(false);
    });
    it('no receipts at all', () => {
      expect(modelAlreadyNotified([])).toBe(false);
      expect(modelAlreadyNotified(undefined)).toBe(false);
    });
    it('a delivered tool-result ENVELOPE in the parts array suppresses the backstop (review B1: the receipt mint is skipped on intent-replay/read-cache legs)', () => {
      // The replay leg: no receipt was minted, but the parts array carries
      // the account-tools j() envelope with "ok": true.
      expect(modelAlreadyNotified([], [
        { type: 'tool_result', name: 'notify_user', result: NOTIFY_OK_ENVELOPE },
      ])).toBe(true);
    });
    it('a REFUSED envelope in the parts array does not suppress the backstop (the ping never landed)', () => {
      expect(modelAlreadyNotified([], [
        { type: 'tool_result', name: 'notify_user', result: NOTIFY_REFUSED_ENVELOPE },
      ])).toBe(false);
    });
    it('a non-notify_user ok envelope does not suppress the backstop', () => {
      expect(modelAlreadyNotified([], [
        { type: 'tool_result', name: 'slack_search', result: JSON.stringify({ ok: true }, null, 1) },
      ])).toBe(false);
    });
  });

  describe('outcome parsing (review B2: executeAccountTool returns a JSON STRING)', () => {
    it('parses an ok envelope', () => {
      expect(parseNotifyOutcome(NOTIFY_OK_ENVELOPE)).toEqual({ ok: true, detail: 'telegram' });
    });
    it('parses a refusal envelope with its reason', () => {
      expect(parseNotifyOutcome(NOTIFY_REFUSED_ENVELOPE)).toEqual({ ok: false, detail: 'rate_limited' });
    });
    it('handles the appended-outbound-note shape via substring (JSON.parse fails)', () => {
      expect(parseNotifyOutcome(`${NOTIFY_OK_ENVELOPE}\n(1 field was redacted.)`)).toEqual({ ok: true, detail: 'telegram' });
    });
    it('unparseable text is ok:null, never assumed sent', () => {
      expect(parseNotifyOutcome('something odd')).toEqual({ ok: null, detail: 'unparsed' });
      expect(parseNotifyOutcome('')).toEqual({ ok: null, detail: 'empty' });
    });
  });

  describe('the quiet-reply gate', () => {
    it('the QUIET_RUN_REPLY one-liner must not ping', () => {
      expect(isQuietRunReply('Nothing new.')).toBe(true);
      expect(isQuietRunReply('  nothing new ')).toBe(true);
    });
    it('a real digest is not quiet', () => {
      expect(isQuietRunReply(DIGEST)).toBe(false);
    });
  });

  describe('the backstop message', () => {
    it('is capped under NOTIFY_MESSAGE_MAX (3500) and names the chat when given one', () => {
      const msg = buildScheduledNotifyMessage('Sunday Market digest', 'X'.repeat(5000));
      expect(msg.length).toBeLessThanOrEqual(3500);
      expect(msg).toContain('"Sunday Market digest"');
      expect(msg.startsWith('Scheduled digest ready')).toBe(true);
    });
    it('works without a title (the wiring path passes null — notify_user\'s footer names the chat)', () => {
      const msg = buildScheduledNotifyMessage(null, DIGEST);
      expect(msg).toContain('Scheduled digest ready — open the chat to read it.');
      expect(msg).toContain(DIGEST.slice(0, 100));
    });
  });

  describe('the kill switch', () => {
    it('SCHEDULED_NOTIFY_BACKSTOP_DISABLED=1 disables the backstop', async () => {
      process.env.SCHEDULED_NOTIFY_BACKSTOP_DISABLED = '1';
      expect(scheduledNotifyBackstopDisabled()).toBe(true);
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
      expect(backstopRows()).toHaveLength(0);
    });
  });

  describe('the finalize wiring', () => {
    it('fires the platform ping for a mandated scheduled wake that produced no notify receipt (the incident shape)', async () => {
      await scheduledWake();
      const calls = notifyCalls();
      expect(calls).toHaveLength(1);
      const [ctx, toolName, toolArgs] = calls[0];
      expect(toolName).toBe('notify_user');
      expect(String(toolArgs?.message ?? '')).toContain('Scheduled digest ready');
      expect(String(toolArgs?.channel ?? '')).toBe('auto');
      // The context is the chat (sessionId) — the notify footer names the chat.
      expect(String(ctx?.sessionId ?? '')).toBe(PLAIN);
      const rows = backstopRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].meta.scheduleId).toBe(SCHEDULE_ID);
      expect(String(rows[0].meta.outcome)).toBe('ok');
      expect(String(rows[0].meta.detail ?? '')).toBe('telegram');
    });

    it('stays silent when the model already pinged (ok notify_user receipt present)', async () => {
      (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
        finalText: DIGEST,
        parts: [{ type: 'text', text: DIGEST }],
        receipts: [{ tool: 'notify_user', ok: true, ids: { channel: 'telegram' } }],
      }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
      expect(backstopRows()).toHaveLength(0);
    });

    it('stays silent when the model pinged on the intent-replay leg (envelope in parts, NO receipt — review B1)', async () => {
      (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
        finalText: DIGEST,
        parts: [{ type: 'text', text: DIGEST }, { type: 'tool_result', name: 'notify_user', result: NOTIFY_OK_ENVELOPE }],
        receipts: [], // the replay leg minted nothing
      }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
      expect(backstopRows()).toHaveLength(0);
    });

    it('a REFUSED model ping (rate-capped envelope, no receipt) does NOT suppress the backstop — the owner still gets the digest ping', async () => {
      (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
        finalText: DIGEST,
        parts: [{ type: 'text', text: DIGEST }, { type: 'tool_result', name: 'notify_user', result: NOTIFY_REFUSED_ENVELOPE }],
        receipts: [],
      }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(1);
    });

    it('records a refused outcome honestly (review B2: the first cut recorded every refusal as sent)', async () => {
      mockExecuteAccountTool.mockImplementationOnce(async () => NOTIFY_REFUSED_ENVELOPE);
      await scheduledWake();
      const rows = backstopRows();
      expect(rows).toHaveLength(1);
      expect(String(rows[0].meta.outcome)).toBe('refused');
      expect(String(rows[0].meta.detail ?? '')).toBe('rate_limited');
    });

    it('stays silent when the stored prompt has no mandate', async () => {
      mockPrisma.chatSchedule.findUnique.mockImplementationOnce(async () => ({ prompt: NO_MANDATE_PROMPT, enabled: true }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
    });

    it('stays silent on the doctrine-advice shape a supervisor might quote (review B3)', async () => {
      const doctrineQuoted = 'Post the digest as your chat reply.\n- check back / remind me / every morning / monitor → schedule_message on this chat (standalone prompt; to reach them outside the app end with "then notify_user with the result")';
      mockPrisma.chatSchedule.findUnique.mockImplementationOnce(async () => ({ prompt: doctrineQuoted, enabled: true }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
    });

    it('stays silent on the negation shape (never call notify_user)', async () => {
      mockPrisma.chatSchedule.findUnique.mockImplementationOnce(async () => ({ prompt: 'Post the digest as your chat reply, then post the summary. Never call notify_user for this digest.', enabled: true }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
    });

    it('stays silent when the schedule was disabled mid-run (owner pause)', async () => {
      mockPrisma.chatSchedule.findUnique.mockImplementationOnce(async () => ({ prompt: WAKE_PROMPT, enabled: false }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
    });

    it('stays silent on the quiet reply ("Nothing new." mornings)', async () => {
      (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({ finalText: 'Nothing new.', parts: [], receipts: [] }));
      await scheduledWake();
      expect(notifyCalls()).toHaveLength(0);
    });

    it('stays silent on a user turn (no firedByScheduleId)', async () => {
      await scheduledWake({ machineWake: false, messageOrigin: 'user', firedByScheduleId: undefined });
      expect(notifyCalls()).toHaveLength(0);
    });

    it('a backstop failure is non-fatal and still records the metric', async () => {
      mockExecuteAccountTool.mockImplementationOnce(async () => { throw new Error('telegram link missing'); });
      await scheduledWake();
      const rows = backstopRows();
      expect(rows).toHaveLength(1);
      expect(String(rows[0].meta.outcome)).toBe('error');
      expect(String(rows[0].meta.error ?? '')).toContain('telegram link missing');
    });
  });
});
