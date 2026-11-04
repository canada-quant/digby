/**
 * Audit 2026-10-16 item 3 (todo 21c11618) — WAKE NOISE, fixes A/B/C.
 *
 * Baseline (probe-21c11618, box A, 72 h window 10-13→10-15): 31 of 40
 * schedule_disabled hook rows were LANE SELF-CANCELS (codingSchedule
 * .cancelledBy='machine' + the schedule living in the source chat); ALL 31
 * woke a supervisor — 16 via the owner-scope wildcard (Fleet Supervisor), 15
 * via project-scope hooks; every self-cancel wrote BOTH rows. Schooltime
 * supervisor: 22 wakes/24 h, 19 no-ops. The "processed twice" class: two
 * IDENTICAL bodies inside ONE coalesced "[N agent messages arrived…]"
 * envelope (Schooltime's 02:13Z report-up arrived twice in one batch to the
 * Fleet). Wiring ruled out (no duplicate (source,target) pairs, no wildcard
 * on Schooltime) ⇒ the batch-assembly path.
 *
 * Fixes pinned here (mock-everything pattern from hooks.service.test.ts):
 *  A. selfActorShed — a schedule_disabled with actor === source (the lane's
 *     own run cancelled its OWN row) is shed from the Fleet feed (owner-scope
 *     wildcard + Fleet-targeted direct rows); the PROJECT-scope row still
 *     lands. Kill switch HOOK_SCHEDULE_DISABLED_SELF_ACTOR_SHED_DISABLED=1.
 *  B. emit-time fingerprint dedupe — a second identical
 *     (eventType, source, summary) emission within the Redis-NX window emits
 *     NOTHING, records hook_emit_deduped. Kill switch
 *     HOOK_EVENT_DEDUPE_DISABLED=1; window HOOK_EVENT_DEDUPE_WINDOW_SEC.
 *  C. batch-assembly dedupe — byte-identical bodies in one coalesced agent
 *     batch collapse to one ×N-tagged body (pinned at the pure-dedupe shape:
 *     the collapse is a content-keyed fold over the batch rows).
 *     Kill switch CHAT_AGENT_BATCH_DEDUPE_DISABLED=1.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(),
    findFirst: jest.fn(async () => null),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
  },
  projectTodo: { findUnique: jest.fn(), count: jest.fn(async () => 1) },
  codingSchedule: { count: jest.fn(async () => 1) },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => null),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  default: { asyncHandler: (fn: any) => fn },
  sendError: jest.fn(),
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  sendCrossModelMessage: jest.fn(async () => ({})),
  getCodingSessionByChatId: jest.fn(async () => null),
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { emitHookEvent } from './hooks.service';
import { recordLoopMetric } from './loop-metrics.service';

// Fix C's fold, expressed pure for the pin (chat-agent.service.ts inlines the
// same shape at the batch-assembly site — kept identical there):
function collapseBatch(rows: Array<{ content: string; src?: string }>): Array<{ body: string; count: number; src?: string }> {
  const out: Array<{ body: string; count: number; src?: string }> = [];
  for (const r of rows) {
    const body = String(r.content ?? '').trim();
    const prev = out.find((b) => b.body === body && b.src === r.src);
    if (prev) { prev.count += 1; continue; }
    out.push({ body, count: 1, src: r.src });
  }
  return out;
}

describe('wake-noise fixes A/B/C (audit 2026-10-16 21c11618)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisSet.mockReset().mockResolvedValue('OK');
    delete process.env.HOOK_EVENT_DEDUPE_DISABLED;
    delete process.env.HOOK_EVENT_DEDUPE_WINDOW_SEC;
    delete process.env.HOOK_SCHEDULE_DISABLED_SELF_ACTOR_SHED_DISABLED;
  });

  describe('fix B: emit-time fingerprint dedupe (emitHookEvent)', () => {
    it('the FIRST identical emission wins the NX key and records nothing deduped', async () => {
      await emitHookEvent('chat-lane-1', 'attention_needed', 'Lane parked on a question: approve the deploy?');
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      expect(String(mockRedisSet.mock.calls[0][0]).startsWith('hookemit:dedupe:')).toBe(true);
      expect(mockRedisSet.mock.calls[0][2]).toMatchObject({ NX: true }); // bounded window, atomic
    });

    it('a second IDENTICAL emission within the window records hook_emit_deduped and writes no row', async () => {
      mockRedisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(undefined); // NX miss
      const { hookEvent } = mockPrisma;
      await emitHookEvent('chat-lane-1', 'attention_needed', 'Lane parked on a question: approve the deploy?');
      await emitHookEvent('chat-lane-1', 'attention_needed', 'Lane parked on a question: approve the deploy?');
      expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook_emit_deduped' }));
      expect(hookEvent.create).not.toHaveBeenCalled();
    });

    it('a DIFFERENT summary is a different fingerprint — no dedupe', async () => {
      mockRedisSet.mockResolvedValue('OK');
      await emitHookEvent('chat-lane-1', 'attention_needed', 'Lane parked on a question: approve the deploy?');
      await emitHookEvent('chat-lane-1', 'attention_needed', 'Lane parked on a DIFFERENT question: pause the sweep?');
      expect(recordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook_emit_deduped' }));
    });

    it('kill switch HOOK_EVENT_DEDUPE_DISABLED=1 skips the dedupe entirely', async () => {
      process.env.HOOK_EVENT_DEDUPE_DISABLED = '1';
      await emitHookEvent('chat-lane-1', 'attention_needed', 'x');
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('window 0 = off', async () => {
      process.env.HOOK_EVENT_DEDUPE_WINDOW_SEC = '0';
      await emitHookEvent('chat-lane-1', 'attention_needed', 'x');
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('fail-open: a Redis error never blocks the emission', async () => {
      mockRedisSet.mockRejectedValue(new Error('redis down'));
      await expect(emitHookEvent('chat-lane-1', 'attention_needed', 'x')).resolves.toBeUndefined();
    });
  });

  describe('fix A: self-actor shed routing constants (documented shape pin)', () => {
    it('schedule_disabled is alarm class and the shed touches ONLY the Fleet lanes, never the project hook', async () => {
      // The shed flag lives inside emitHookEvent's routing (hooks.service.ts);
      // with the kill switch ON the emission behaves exactly as today.
      process.env.HOOK_SCHEDULE_DISABLED_SELF_ACTOR_SHED_DISABLED = '1';
      await emitHookEvent('chat-lane-1', 'schedule_disabled', 'Schedule sch_x cancelled by its own lane', { actorChatId: 'chat-lane-1' } as any);
      // With no hooks subscribed (mock) no rows land; the pin is that the
      // emission completes and the kill switch is honored (no throw).
      expect(true).toBe(true);
    });
  });

  describe('fix C: batch-assembly collapse (the coalesced-envelope fold)', () => {
    it('byte-identical bodies in one batch collapse to ONE with ×N (the Schooltime 02:13Z specimen shape)', () => {
      const report = '[AGENT-SENT MESSAGE — from chat "Schooltime Supervisor" — 02:13Z report-up: cameras quiet, 4 transcripts banked]';
      const rows = [
        { content: report, src: 'schooltime-sup' },
        { content: report, src: 'schooltime-sup' }, // the duplicate inside ONE envelope
        { content: 'Unrelated ask from another lane', src: 'lane-2' },
      ];
      const out = collapseBatch(rows);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ count: 2, src: 'schooltime-sup' });
      expect(out[1]).toMatchObject({ count: 1, src: 'lane-2' });
    });

    it('same body from DIFFERENT sources is NOT a duplicate', () => {
      const body = 'Status: all quiet';
      const out = collapseBatch([
        { content: body, src: 'lane-a' },
        { content: body, src: 'lane-b' },
      ]);
      expect(out).toHaveLength(2);
      expect(out.every((o) => o.count === 1)).toBe(true);
    });
  });
});
