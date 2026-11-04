/**
 * FOLLOW-THROUGH detector 3b pins — ticket b03d7033 (mishap, 2026-10-20):
 * an ANSWERED owner ask whose order TWIN is still open (the reply answered the
 * question, the order it carried never got evidence) is nudged at 4h and
 * escalated ONCE to the Fleet Supervisor at 8h; the wake/escalation follows the
 * abd733af failed-enqueue discipline (no dedupe key when the enqueue did not
 * land). This is the report-up gap: pre-fix, the exchange died in the lane's
 * transcript with no action and no escalation, so the tier above never saw it.
 */
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  systemSetting: { findUnique: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => [{ id: 'p1', projectSupervisorEnabled: true, archivedAt: null }]) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

import {
  renderOwnerAskTwinNudge, renderOwnerAskTwinEscalation, sweepFollowThrough,
  OWNER_ASK_TWIN_NUDGE_AFTER_MS, OWNER_ASK_ESCALATE_AFTER_MS,
} from './follow-through.service';

const NOW = new Date('2026-10-20T12:00:00Z');
const SUP = 'c6941c11-0000-4000-8000-000000000000'; // the LiteLLM supervisor (project tier)
const FLEET = 'f1ee7000-0000-4000-8000-000000000000';
const PAIR = {
  askId: 'aaaaaaaa-0000-4000-8000-000000000000',
  twinId: 'bbbbbbbb-0000-4000-8000-000000000000',
  // The b03d7033 specimen text (03:28Z ask, chat c6941c11).
  text: "how come i dont see spark-deepseek-v4.1-flash-1017 as an endpoint avialble?? all i see is 'deepseek-v4.1-flash' …is that actually the correct 1017 model running on the sparks?",
  at: '2026-10-20T03:28:44.172Z',
  messageId: 'a9dfa3fb-0000-4000-8000-000000000001',
};

describe('renderOwnerAskTwinNudge / renderOwnerAskTwinEscalation (b03d7033)', () => {
  it('names the ask, the age, the order twin and the act-or-report-up contract', () => {
    const nudge = renderOwnerAskTwinNudge(PAIR, new Date(PAIR.at), NOW);
    expect(nudge).toContain('[FOLLOW-THROUGH]');
    expect(nudge).toContain('9h later'); // 03:28Z → 12:00Z
    expect(nudge).toContain('msg a9dfa3fb');
    expect(nudge).toContain('directive bbbbbbbb');
    expect(nudge).toContain('An answer is not an action');
    const esc = renderOwnerAskTwinEscalation('LiteLLM', PAIR, new Date(PAIR.at), NOW);
    expect(esc).toContain('[OWNER ORDER UNMET 9h]');
    expect(esc).toContain('LiteLLM');
    expect(esc).toContain('msg a9dfa3fb');
  });
});

describe('detector 3b sweep (b03d7033)', () => {
  const wake = jest.fn(async () => ({ ok: true }));
  const pairs = jest.fn(async () => [PAIR]);

  beforeEach(() => { store.clear(); wake.mockClear(); pairs.mockClear(); mockRecordLoopMetric.mockClear(); });

  const sup = (over: Partial<Record<string, unknown>> = {}) => ({ id: SUP, userId: 'u1', title: 'CQL LiteLLM Gateway Supervisor', projectId: 'p1', isSupervisor: false, isProjectSupervisor: true, ...over });

  it('nudges the owning supervisor at 4h+ (ONE wake per twin per day) and escalates to the Fleet at 8h+', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([sup()]);
    mockPrisma.crossModelChat.findFirst.mockImplementation(async (q: any) => (q?.where?.isSupervisor === true ? { id: FLEET } : null));
    const out = await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, listAnsweredAsksWithOpenTwin: pairs as any });
    expect(out).toEqual({ supervisors: 1, nudges: 0, autofiled: 0, askNudges: 0, askEscalations: 0 }); // return shape unchanged (the pinned toEqual)
    expect(wake).toHaveBeenCalledTimes(2);
    const calls: Array<{ targetChatId: string; prompt: string; meta?: Record<string, unknown> }> = wake.mock.calls.map((c: any[]) => c[0]);
    const nudgeCall = calls.find((c) => c.targetChatId === SUP);
    const escCall = calls.find((c) => c.targetChatId === FLEET);
    expect(nudgeCall).toBeTruthy();
    expect(String(nudgeCall && nudgeCall.prompt)).toContain('[FOLLOW-THROUGH]');
    expect(nudgeCall && nudgeCall.meta).toMatchObject({ kind: 'owner_ask_twin_unmet', directiveId: PAIR.twinId, askMessageId: PAIR.messageId });
    expect(escCall).toBeTruthy();
    expect(String(escCall && escCall.prompt)).toContain('[OWNER ORDER UNMET 9h]');
    expect(escCall && escCall.meta).toMatchObject({ kind: 'owner_ask_twin_escalated', directiveId: PAIR.twinId, supervisorChatId: SUP });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_nudge', meta: expect.objectContaining({ stage: 'twin_nudge', chatId: SUP, directiveId: 'bbbbbbbb' }) }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_nudge', meta: expect.objectContaining({ stage: 'twin_escalate', chatId: SUP, fleetChatId: FLEET, directiveId: 'bbbbbbbb' }) }));
    // dedupe: a second sweep the same day sends nothing
    wake.mockClear();
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([sup()]);
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, listAnsweredAsksWithOpenTwin: pairs as any });
    expect(wake).not.toHaveBeenCalled();
  });

  it('a young pair (< 4h) is left alone; a failed nudge enqueue sets NO dedupe key (abd733af seam)', async () => {
    const young = { ...PAIR, at: new Date(NOW.getTime() - 1 * 3600_000).toISOString() };
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([sup()]);
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, listAnsweredAsksWithOpenTwin: (async () => [young]) as any });
    expect(wake).not.toHaveBeenCalled();

    // aged 5h: past the nudge bar, under the 8h escalation bar — only the nudge fires
    const fiveHour = { ...PAIR, at: new Date(NOW.getTime() - 5 * 3600_000).toISOString() };
    const failing = jest.fn(async () => ({ ok: false, error: 'queue full' }));
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([sup()]);
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: failing as any, listAnsweredAsksWithOpenTwin: (async () => [fiveHour]) as any });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0); // no dedupe key — the next sweep re-evaluates
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_nudge', meta: expect.objectContaining({ stage: 'twin_nudge', outcome: 'enqueue_failed' }) }));
  });

  it('the Fleet Supervisor itself is never escalated (its own orders have no one above them)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([sup({ id: FLEET, isSupervisor: true, isProjectSupervisor: false, projectId: null, title: 'Fleet Supervisor' })]);
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, listAnsweredAsksWithOpenTwin: pairs as any });
    const targets = wake.mock.calls.map((c: any[]) => c[0].targetChatId);
    expect(targets).toEqual([FLEET]); // the nudge only — no escalation above the Fleet
  });
});
