/**
 * OWNER-INTERRUPT-ECONOMY (supervisor SOTA round 3, 2026-10-20) — the service
 * paths end to end over the in-memory owner_questions table + an in-memory
 * context store:
 *   - delivery: owner-only / urgent / high cost-of-delay DM at once, the rest
 *     queue for the per-owner 12 h digest (a queue failure DMs at once);
 *   - the digest sweep: not before 11 h 45 m, then ONE DM with every pending
 *     card, answered cards dropped, the kill switch flushes the queue;
 *   - prior-decision recall: machine strict re-ask refused citing the owner's
 *     answer, revisitReason / human / loose / owner-only re-asks annotated,
 *     "Same as before" expands to the prior decision;
 *   - the reversible 24 h recommended default + its digest announcement;
 *   - the supervisor ask-vs-decide advisory; triage surfacing joins the digest;
 *   - owner_question_flagged / owner_question_resolved metrics.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async (): Promise<any> => ({ chatId: 'tg-1' }));
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: { ...mockQuestions.crossModelChat, findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory context store (the digest queue, its claims and the per-question
// economy marker all live there).
const mockStore = new Map<string, { value: any; createdAt: Date }>();
const mockStoreState = { fail: false };
const mockStoreKey = (ns: string[], key: string) => `${ns.join(':')}|${key}`;
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: async (ns: string[], key: string) => {
    if (mockStoreState.fail) throw new Error('store down');
    return mockStore.get(mockStoreKey(ns, key))?.value ?? null;
  },
  storeGetMany: async (ns: string[], keys: string[]) => {
    if (mockStoreState.fail) throw new Error('store down');
    const out = new Map<string, any>();
    for (const k of keys) { const e = mockStore.get(mockStoreKey(ns, k)); if (e) out.set(k, e.value); }
    return out;
  },
  storePut: async (ns: string[], key: string, value: any) => {
    if (mockStoreState.fail) throw new Error('store down');
    const prev = mockStore.get(mockStoreKey(ns, key));
    mockStore.set(mockStoreKey(ns, key), { value, createdAt: prev?.createdAt ?? new Date(Date.now()) });
  },
  storeCreate: async (ns: string[], key: string, value: any) => {
    if (mockStoreState.fail) throw new Error('store down');
    if (mockStore.has(mockStoreKey(ns, key))) return false;
    mockStore.set(mockStoreKey(ns, key), { value, createdAt: new Date(Date.now()) });
    return true;
  },
  storeDelete: async (ns: string[], key: string) => { mockStore.delete(mockStoreKey(ns, key)); },
  storeListNamespace: async (ns: string[]) => {
    if (mockStoreState.fail) throw new Error('store down');
    const prefix = `${ns.join(':')}|`;
    return [...mockStore.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
      .map(([k, e]) => ({ key: k.slice(prefix.length), value: e.value, createdAt: e.createdAt }));
  },
  storePruneNamespace: async (ns: string[], before: Date) => {
    let n = 0;
    for (const [k, e] of [...mockStore.entries()]) {
      if (k.startsWith(`${ns.join(':')}|`) && e.createdAt < before) { mockStore.delete(k); n++; }
    }
    return n;
  },
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: async () => null,
  refundDailyCapToken: async () => {},
  armOwnerAnswerRetrySchedule: async () => ({ ok: true, scheduleId: 'sched-retry-1' }),
}));

jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: async () => {},
}));

jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: async () => {},
}));

jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: async () => ({ todos: 0, goals: 0 }),
}));

import {
  flagOwnerQuestion, answerOwnerQuestion, dismissOwnerQuestion, surfaceTriagedOwnerQuestions, applyDefaultAnswerIfDue, PRIOR_DECISION_MARK,
} from './owner-questions';
import { sweepOwnerDecisionDigest, sweepReversibleDefaults, DIGEST_QUEUE_NS, DIGEST_TEXT_MAX } from './owner-interrupt-economy';

const flush = () => new Promise((r) => setTimeout(r, 10)); // fire-and-forget DMs + metrics
const H = 3_600_000;
const queued = () => [...mockStore.keys()].filter((k) => k.startsWith(`${DIGEST_QUEUE_NS.join(':')}|`));
const metricRows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r.kind === kind);

const ENV_KEYS = [
  'OWNER_PRIOR_DECISION_RECALL_DISABLED', 'OWNER_DECISION_DIGEST_DISABLED',
  'OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED', 'OWNER_ASK_VS_DECIDE_ADVISORY_DISABLED',
  'OWNER_INTERRUPT_METRICS_DISABLED',
];

beforeEach(() => {
  mockQuestions.reset();
  mockStore.clear();
  mockStoreState.fail = false;
  mockTelegramSendMessage.mockReset().mockResolvedValue(true);
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue({ chatId: 'tg-1' });
  mockChatFindUnique.mockReset().mockResolvedValue(null);
  mockRecordLoopMetric.mockReset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  for (const k of ENV_KEYS) delete process.env[k];
});

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Use the 8B checkpoint for tonight\'s eval run?', ...over });

describe('delivery — owner-only / urgent / costly at once, the rest batched (owner rule 2026-10-20)', () => {
  it('an ordinary card queues for the digest: no DM now, delivery "digest", one queue row', async () => {
    const r = await flag();
    await flush();
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.delivery).toBe('digest');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
  });

  it.each([
    ['owner-only (money)', { question: 'Approve $40/month for the monitoring subscription?' }],
    ['urgent', { urgent: true }],
    ['high cost-of-delay', { idleUsdPerDay: 60 }],
  ])('%s is DMed at once', async (_label, over) => {
    const r = await flag(over as any);
    await flush();
    if (r.kind === 'created') expect(r.delivery).toBe('immediate');
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(String(mockTelegramSendMessage.mock.calls[0][1])).toContain('Digby needs your decision');
    expect(queued()).toHaveLength(0);
  });

  it('a queue write failure DMs at once (fail toward delivery)', async () => {
    mockStoreState.fail = true;
    const r = await flag();
    await flush();
    if (r.kind === 'created') expect(r.delivery).toBe('immediate');
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
  });

  it('OWNER_DECISION_DIGEST_DISABLED=1 DMs every card at once again', async () => {
    process.env.OWNER_DECISION_DIGEST_DISABLED = '1';
    await flag();
    await flush();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(queued()).toHaveLength(0);
  });

  it('records owner_question_flagged with the delivery verdict', async () => {
    await flag();
    await flush();
    const rows = metricRows('owner_question_flagged');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual(expect.objectContaining({ outcome: 'created', delivery: 'digest', deliveryReason: 'batched', machine: false }));
  });

  it('OWNER_INTERRUPT_METRICS_DISABLED=1 records no economy rows', async () => {
    process.env.OWNER_INTERRUPT_METRICS_DISABLED = '1';
    await flag();
    await flush();
    expect(metricRows('owner_question_flagged')).toHaveLength(0);
  });
});

describe('sweepOwnerDecisionDigest — ONE DM per owner, ≤ 12 h from filing', () => {
  it('holds before the window, then sends one digest with every pending card and clears the queue', async () => {
    await flag();
    await flag({ chatId: 'chat-2', question: 'Rename the results column to pass_rate?' });
    await flush();
    const early = await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 11 * H) });
    expect(early.sent).toBe(0);
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    const due = await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 11.8 * H) });
    expect(due.sent).toBe(1);
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    const text = String(mockTelegramSendMessage.mock.calls[0][1]);
    expect(text).toContain('Digby needs your decision — 2 cards');
    expect(text).toContain('Use the 8B checkpoint');
    expect(text).toContain('Rename the results column');
    expect(queued()).toHaveLength(0);
    await flush();
    expect(metricRows('owner_decision_digest')[0].meta).toEqual(expect.objectContaining({ phase: 'sent', questions: 2 }));
    // Nothing left: a second sweep sends nothing.
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 13 * H) });
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
  });

  it('a card answered before the digest is dropped (no interrupt for a decided card)', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'Yes, 8B')).toBe('ok');
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 12 * H) });
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(0);
  });

  it('a failed DM keeps the queue for the next pass', async () => {
    await flag();
    mockTelegramSendMessage.mockResolvedValueOnce(false);
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 12 * H) });
    expect(queued()).toHaveLength(1);
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 12.3 * H) });
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
    expect(queued()).toHaveLength(0);
  });

  it('the kill switch FLUSHES whatever is queued at once (nothing stranded by a revert)', async () => {
    await flag();
    process.env.OWNER_DECISION_DIGEST_DISABLED = '1';
    const r = await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 1 * H) });
    expect(r.sent).toBe(1);
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
  });

  it('an owner with no Telegram link: the queue is cleared (the Inbox is the surface)', async () => {
    await flag();
    mockTelegramLinkFindUnique.mockResolvedValue(null);
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 12 * H) });
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(0);
  });
});

describe('prior-decision recall (90 d, owner answers only)', () => {
  const seedPrior = (over: Record<string, any> = {}) => {
    mockQuestions.rows.push({
      id: 'oq_1a2b3c4d-0000-0000-0000-000000000000', chatId: 'chat-1', userId: 'u1',
      question: 'Use the 8B checkpoint for tonight\'s eval run?', status: 'answered',
      answer: 'Yes — 8B, the 14B is still training', answeredBy: 'owner', context: null,
      createdAt: new Date(Date.now() - 6 * 86_400_000), resolvedAt: new Date(Date.now() - 5 * 86_400_000), ...over,
    });
  };

  it('a MACHINE strict re-ask is refused citing the owner\'s answer (no card filed)', async () => {
    seedPrior();
    const r = await flag({ question: 'Should we use the 8B checkpoint for tonight\'s eval run?', machineTriggered: true });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused' || r.refused !== 'previously_decided') throw new Error(`expected previously_decided, got ${JSON.stringify(r)}`);
    expect(r.prior.id).toBe('oq_1a2b3c4d-0000-0000-0000-000000000000');
    expect(r.message).toContain('Yes — 8B, the 14B is still training');
    expect(r.message).toContain('revisitReason');
    expect(mockQuestions.rows.filter((x: any) => x.status === 'open')).toHaveLength(0);
    await flush();
    expect(metricRows('owner_question_flagged')[0].meta).toEqual(expect.objectContaining({ outcome: 'refused', refused: 'previously_decided', priorRecall: 'refused' }));
  });

  it('revisitReason lets a machine re-ask file — annotated, with what changed on the context', async () => {
    seedPrior();
    const r = await flag({ machineTriggered: true, revisitReason: 'The 14B finished training and beats 8B on the dev split.' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.question.question).toContain(PRIOR_DECISION_MARK);
    expect(r.question.question).toContain('you decided this on');
    expect(String(r.question.context)).toContain('[What changed since the prior decision] The 14B finished training');
    expect(r.priorDecision).toEqual(expect.objectContaining({ questionId: 'oq_1a2b3c4d-0000-0000-0000-000000000000', strict: true }));
  });

  // r3 interactions finding 3: a HARNESS per-event card (the required-probes
  // pause, the block-streak escalation, the rollout re-ask after an
  // auto-demote) ignores its result — refusing it left a re-paused schedule
  // with no owner card. Its event postdates the decision ⇒ annotated.
  it('a HARNESS per-event card whose event postdates the owner\'s decision files annotated, never refused (the re-paused schedule keeps its card)', async () => {
    const pause = 'Schedule sch12345 was PAUSED after 3 consecutive firings without its required probes (run_command). Resume it, or drop the probe requirement?';
    seedPrior({ question: pause, answer: 'Resume the schedule (lane must run its probes)' });
    const r = await flag({ question: pause, machineTriggered: true, harnessEventAt: new Date() });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.question.question).toContain('you decided this on');
    expect(r.priorDecision).toEqual(expect.objectContaining({ questionId: 'oq_1a2b3c4d-0000-0000-0000-000000000000', strict: true }));
    // The same card from a model filer (no harness event) is still refused.
    mockQuestions.rows.splice(mockQuestions.rows.findIndex((x: any) => x.id === r.question.id), 1);
    const agent = await flag({ question: pause, machineTriggered: true });
    expect(agent.kind === 'refused' && agent.refused).toBe('previously_decided');
  });

  it('a HARNESS card whose event PREDATES the owner\'s decision is the same unchanged re-ask — still refused', async () => {
    seedPrior();
    const r = await flag({ machineTriggered: true, harnessEventAt: new Date(Date.now() - 6 * 86_400_000) });
    expect(r.kind === 'refused' && r.refused).toBe('previously_decided');
  });

  it('a HUMAN re-ask is annotated, never refused; typed options gain "Same as before"', async () => {
    seedPrior({ answer: 'Use 8B [option use_8b; typed: "1"]', chosenOption: 'use_8b' });
    const r = await flag({ options: [{ id: 'use_8b', label: 'Use 8B' }, { id: 'use_14b', label: 'Use 14B' }] });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.question.question).toContain('«Use 8B»');
    const opts = r.question.options as any[];
    expect(opts.map((o) => o.id)).toEqual(['use_8b', 'use_14b', 'same_as_before']);
    // The owner picks "Same as before" by number → the prior OPTION is chosen.
    expect(await answerOwnerQuestion(r.question.id, 'u1', '3')).toBe('ok');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    expect(row.chosenOption).toBe('use_8b');
    expect(String(row.answer)).toContain('Use 8B');
    expect(String(row.answer)).toContain('[same as before — repeating the owner\'s');
  });

  it('a free-text "same as before" reply expands to the prior answer', async () => {
    seedPrior();
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'same as before')).toBe('ok');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    expect(String(row.answer)).toContain('Yes — 8B, the 14B is still training');
    await flush();
    expect(metricRows('owner_question_resolved').some((m: any) => m.meta.surface === 'same_as_before' && m.meta.by === 'owner')).toBe(true);
  });

  it('an OWNER-ONLY strict machine re-ask is annotated, not refused (each such call is the owner\'s)', async () => {
    seedPrior({ question: 'Delete the stale preview database for lane Helios?', answer: 'Yes, delete it' });
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true });
    const r = await flag({ question: 'Delete the stale preview database for lane Helios?', machineTriggered: true });
    expect(r.kind).toBe('created');
    if (r.kind === 'created') {
      expect(r.question.question).toContain('needs your call each time');
      expect(r.delivery).toBe('immediate');
    }
  });

  it('a supervisor / default answer is not the owner\'s decision — no recall', async () => {
    seedPrior({ answeredBy: 'supervisor' });
    const r = await flag({ machineTriggered: true });
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.question.question).not.toContain(PRIOR_DECISION_MARK);
  });

  it('OWNER_PRIOR_DECISION_RECALL_DISABLED=1 files the machine re-ask unannotated (the pre-recall path)', async () => {
    process.env.OWNER_PRIOR_DECISION_RECALL_DISABLED = '1';
    seedPrior();
    const r = await flag({ question: 'Should we use the 8B checkpoint for tonight\'s eval run?', machineTriggered: true });
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.question.question).not.toContain(PRIOR_DECISION_MARK);
  });

  it('a re-flag of the same annotated card still dedupes onto the open one', async () => {
    seedPrior();
    const a = await flag();
    const b = await flag();
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('deduped');
  });
});

describe('reversible recommended default (24 h, outside the owner-only classes)', () => {
  it('arms a 1-day default + the marker; the sweep applies it at 24 h and the digest announces it', async () => {
    const r = await flag({ reversible: true, recommendedDefault: 'Use 8B' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.reversibleDefault).toEqual({ armed: true, reason: 'armed' });
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    expect(row.defaultAfterDays).toBe(1);
    expect(row.defaultOption).toBe('Use 8B');
    // Not yet due.
    expect(await sweepReversibleDefaults({ now: new Date(Date.now() + 23 * H) })).toBe(0);
    // 24 h: applied, no confirmation DM of its own — queued for the digest.
    row.createdAt = new Date(Date.now() - 25 * H);
    expect(await sweepReversibleDefaults({ now: new Date(Date.now()) })).toBe(1);
    expect(row.status).toBe('answered');
    expect(row.answeredBy).toBe('default');
    expect(String(row.answer)).toContain('RECOMMENDED default after 24 hours');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(queued().some((k) => k.endsWith(':auto_default'))).toBe(true);
    const wake = String(mockFireScheduleTarget.mock.calls.at(-1)![0].prompt);
    expect(wake).toContain('recommended REVERSIBLE default');
    // The next digest (the announcement is held ≤ 12 h like any card) says so;
    // the now-answered card itself is dropped from it.
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 11 * H) });
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 12 * H) });
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    const text = String(mockTelegramSendMessage.mock.calls.at(-1)![1]);
    expect(text).toContain('Defaults applied (reversible');
    expect(text).toContain('"Use 8B"');
  });

  it('an owner-only card never arms: the recommendation is shown, not applied', async () => {
    const r = await flag({ question: 'Approve $40/month for the monitoring subscription?', reversible: true, recommendedDefault: 'Approve' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(r.reversibleDefault).toEqual({ armed: false, reason: 'owner_only:money' });
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    expect(row.defaultAfterDays).toBeUndefined();
    expect(String(row.context)).toContain('[Agent\'s recommended default] "Approve" — not auto-applied');
  });

  it('OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED=1 never arms nor sweeps', async () => {
    process.env.OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED = '1';
    const r = await flag({ reversible: true, recommendedDefault: 'Use 8B' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(r.reversibleDefault?.armed).toBe(false);
    expect(await sweepReversibleDefaults({ now: new Date(Date.now() + 48 * H) })).toBe(0);
  });
});

describe('ask-vs-decide advisory (supervisor filer, observe-only)', () => {
  it('a supervisor\'s machine-turn card outside the owner-only classes files WITH the advisory', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true });
    const r = await flag({ machineTriggered: true, question: 'Rotate the nightly bench slot to 03:00 UTC?' });
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.advisory).toContain('[ASK-VS-DECIDE — observe-only]');
    await flush();
    expect(metricRows('owner_question_flagged')[0].meta).toEqual(expect.objectContaining({ supervisorFiler: true, advisory: 'not_owner_only' }));
  });

  it('a lane\'s card (triaged) and an owner-only supervisor card carry none', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false });
    const lane = await flag({ machineTriggered: true, question: 'Rotate the nightly bench slot to 03:00 UTC?' });
    if (lane.kind === 'created') { expect(lane.advisory).toBeUndefined(); expect(lane.delivery).toBe('triage'); }
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true });
    const own = await flag({ machineTriggered: true, chatId: 'chat-9', question: 'Delete the old checkpoint bucket?' });
    if (own.kind === 'created') expect(own.advisory).toBeUndefined();
  });
});

describe('triage surfacing joins the digest', () => {
  it('a surfaced non-owner-only card queues (anchored at surfacing) instead of DMing', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false });
    const r = await flag({ machineTriggered: true, question: 'Rotate the nightly bench slot to 03:00 UTC?' });
    if (r.kind !== 'created') throw new Error('expected created');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    expect(row.triage).toBe('supervisor');
    expect(await surfaceTriagedOwnerQuestions({ now: new Date(Date.now() + 3 * H) })).toBe(1);
    await flush();
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
  });
});

describe('review 2026-10-20 fixes', () => {
  const armedKey = (id: string) => `owner-question-economy:reversible-armed|${id}`;

  it('BLOCKING: "Same as before" on a re-asked card with REORDERED options records the owner\'s prior choice, not the opposite', async () => {
    mockQuestions.rows.push({
      id: 'oq_9f8e7d6c-0000-0000-0000-000000000000', chatId: 'chat-1', userId: 'u1',
      question: 'Kill the stalled bench run or keep it going?', status: 'answered',
      answer: 'Kill the run [option opt_2; typed: "2"]', chosenOption: 'opt_2', answeredBy: 'owner', context: null,
      options: [{ id: 'opt_1', label: 'Keep it going' }, { id: 'opt_2', label: 'Kill the run' }],
      createdAt: new Date(Date.now() - 2 * 86_400_000), resolvedAt: new Date(Date.now() - 86_400_000),
    });
    const r = await flag({
      question: 'Kill the stalled bench run or keep it going?',
      options: [{ label: 'Kill the run' }, { label: 'Keep it going' }], // positional ids: opt_1 / opt_2 swapped meaning
      revisitReason: 'The run resumed for an hour then stalled again.',
    });
    if (r.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
    const opts = r.question.options as any[];
    expect(opts.map((o) => o.id)).toEqual(['opt_1', 'opt_2', 'same_as_before']);
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'Same as before')).toBe('ok');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    expect(row.chosenOption).toBe('opt_1');
    expect(String(row.answer)).toMatch(/^Kill the run/);
    expect(String(row.answer)).not.toContain('Keep it going');
    const wake = String(mockFireScheduleTarget.mock.calls.at(-1)![0].prompt);
    expect(wake).toContain('Kill the run');
  });

  it('a CHOICE gate whose options do not carry the prior decision gets no "Same as before" button; the words stay a reply', async () => {
    mockQuestions.rows.push({
      id: 'oq_9f8e7d6c-0000-0000-0000-000000000000', chatId: 'chat-1', userId: 'u1',
      question: 'Pause or resume the nightly bench lane?', status: 'answered', answer: 'Pause it', answeredBy: 'owner',
      context: null, createdAt: new Date(Date.now() - 2 * 86_400_000), resolvedAt: new Date(Date.now() - 86_400_000),
    });
    const r = await flag({
      question: 'Pause or resume the nightly bench lane?', expectedAnswerType: 'choice',
      options: [{ id: 'resume', label: 'Resume it' }, { id: 'retire', label: 'Retire it' }],
    } as any);
    if (r.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
    expect((r.question.options as any[]).map((o) => o.id)).toEqual(['resume', 'retire']);
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'same as before')).toBe('reply_recorded');
    expect(mockQuestions.rows.find((x: any) => x.id === r.question.id)!.status).toBe('open');
  });

  it('the reversible sweep is not starved by 60 older open 1-day defaults that are not reversible (it reads the armed index)', async () => {
    for (let i = 0; i < 60; i++) {
      mockQuestions.rows.push({
        id: `oq_legacy-${i}`, chatId: 'chat-legacy', userId: 'u2', question: `Legacy preset ${i}?`, status: 'open',
        defaultAfterDays: 1, defaultOption: 'go', context: null, createdAt: new Date(Date.now() - 10 * 86_400_000),
      });
    }
    const r = await flag({ reversible: true, recommendedDefault: 'Use 8B' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(mockStore.has(armedKey(r.question.id))).toBe(true);
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    row.createdAt = new Date(Date.now() - 25 * H);
    expect(await sweepReversibleDefaults({ now: new Date(Date.now()) })).toBe(1);
    expect(row.status).toBe('answered');
    expect(mockStore.has(armedKey(r.question.id))).toBe(false); // applied → leaves the index
    // The legacy preset rows were never touched by the reversible sweep.
    expect(mockQuestions.rows.filter((x: any) => x.chatId === 'chat-legacy' && x.status === 'open')).toHaveLength(60);
    await flush();
    expect(metricRows('owner_reversible_default').map((m: any) => m.meta.phase)).toEqual(['applied']);
  });

  it('a default refused at apply time (context now reads owner-only) is RETIRED: pair cleared, lane told, index cleared, metric', async () => {
    const r = await flag({ reversible: true, recommendedDefault: 'Use 8B' });
    if (r.kind !== 'created') throw new Error('expected created');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    // A later dedupe append (fea78360) brought a cost into the context.
    row.context = 'The 8B run costs $40/day more than planned.';
    row.createdAt = new Date(Date.now() - 25 * H);
    expect(await sweepReversibleDefaults({ now: new Date(Date.now()) })).toBe(0);
    expect(row.status).toBe('open');
    expect(row.defaultAfterDays).toBeNull();
    expect(row.defaultOption).toBeNull();
    expect(String(row.context)).toContain('NOT auto-applied after 24 h');
    expect(mockStore.has(armedKey(r.question.id))).toBe(false);
    expect(mockQuestions.crossModelMessage.create.mock.calls.some((c: any[]) => String(c[0]?.data?.content ?? '').includes('was NOT auto-applied after 24 hours'))).toBe(true);
    await flush();
    expect(metricRows('owner_reversible_default')[0].meta).toEqual(expect.objectContaining({ phase: 'refused', reason: 'owner_only:money', retired: true }));
    // The P7 blocked-item seam can no longer apply it either.
    expect(await applyDefaultAnswerIfDue(row, new Date(Date.now()))).toBe(false);
    expect(row.status).toBe('open');
  });

  it('the kill switch stops an ALREADY-armed card on the P7 seam too (no fall-through to the preset path)', async () => {
    const r = await flag({ reversible: true, recommendedDefault: 'Use 8B' });
    if (r.kind !== 'created') throw new Error('expected created');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    row.createdAt = new Date(Date.now() - 25 * H);
    process.env.OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED = '1';
    expect(await applyDefaultAnswerIfDue(row, new Date(Date.now()))).toBe(false);
    expect(row.status).toBe('open');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    // Switch off again: the armed default applies as designed.
    delete process.env.OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED;
    expect(await sweepReversibleDefaults({ now: new Date(Date.now()) })).toBe(1);
  });

  it('a revisitReason naming money makes the card owner-only at flag time (same text the apply-time check reads): never armed, DMed at once', async () => {
    mockQuestions.rows.push({
      id: 'oq_1a2b3c4d-0000-0000-0000-000000000000', chatId: 'chat-1', userId: 'u1',
      question: 'Use the 8B checkpoint for tonight\'s eval run?', status: 'answered', answer: 'Yes, 8B', answeredBy: 'owner',
      context: null, createdAt: new Date(Date.now() - 6 * 86_400_000), resolvedAt: new Date(Date.now() - 5 * 86_400_000),
    });
    const r = await flag({ machineTriggered: true, revisitReason: 'The 14B now costs $5/day less.', reversible: true, recommendedDefault: 'Use 8B' });
    if (r.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
    expect(r.reversibleDefault).toEqual({ armed: false, reason: 'owner_only:money' });
    expect(r.delivery).toBe('immediate');
  });

  it('the quoted prior answer never routes the card: a lane re-ask annotated with "tap approve" still goes to supervisor triage', async () => {
    mockQuestions.rows.push({
      id: 'oq_1a2b3c4d-0000-0000-0000-000000000000', chatId: 'chat-1', userId: 'u1',
      question: 'Rotate the nightly bench slot to 03:00 UTC?', status: 'answered', answer: 'Yes — tap approve once CI is green', answeredBy: 'owner',
      context: null, createdAt: new Date(Date.now() - 6 * 86_400_000), resolvedAt: new Date(Date.now() - 5 * 86_400_000),
    });
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false });
    const r = await flag({ machineTriggered: true, question: 'Rotate the nightly bench slot to 03:00 UTC?', revisitReason: 'The bench box moved regions.' });
    if (r.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
    expect(r.question.question).toContain('tap approve');
    expect(r.delivery).toBe('triage');
  });

  it('ATTENTION_WATCHDOG_DISABLED=1 (nothing would send a digest) DMs an ordinary card at once', async () => {
    process.env.ATTENTION_WATCHDOG_DISABLED = '1';
    try {
      const r = await flag();
      await flush();
      if (r.kind === 'created') expect(r.delivery).toBe('immediate');
      expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
      expect(queued()).toHaveLength(0);
    } finally {
      delete process.env.ATTENTION_WATCHDOG_DISABLED;
    }
  });

  it('a triage-surfaced card is anchored at the moment it SURFACED (its 12 h runs from there, not from filing)', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false });
    const r = await flag({ machineTriggered: true, question: 'Rotate the nightly bench slot to 03:00 UTC?' });
    if (r.kind !== 'created') throw new Error('expected created');
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    const surfacedAt = new Date(row.triageUntil).getTime();
    expect(await surfaceTriagedOwnerQuestions({ now: new Date(surfacedAt + 30 * 60_000) })).toBe(1);
    const entry: any = [...mockStore.entries()].find(([k]) => k.startsWith(`${DIGEST_QUEUE_NS.join(':')}|`))![1].value;
    expect(new Date(entry.anchorAt).getTime()).toBe(surfacedAt);
    // 12 h after FILING is not 12 h after surfacing: held.
    await sweepOwnerDecisionDigest({ now: new Date(new Date(row.createdAt).getTime() + 12 * H) });
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    await sweepOwnerDecisionDigest({ now: new Date(surfacedAt + 11.8 * H) });
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
  });

  it('the digest goes out as ONE message under the Telegram cap, and records the gap since the previous digest', async () => {
    for (let i = 0; i < 12; i++) {
      await flag({
        chatId: `chat-${i}`, question: `Card ${i}: rename results column ${i} to pass_rate? ${'detail '.repeat(60)}`,
        options: [{ label: `Rename ${i}`, consequence: 'x'.repeat(280) }, { label: `Keep ${i}`, consequence: 'y'.repeat(280) }],
      });
    }
    await flush();
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 12 * H) });
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    const text = String(mockTelegramSendMessage.mock.calls[0][1]);
    expect(text.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX);
    expect(text).toMatch(/…and \d+ more in Digby → Management → Inbox\./);
    // A second digest 12 h later carries the spacing.
    await flag({ chatId: 'chat-z', question: 'Rename the eval table to evals_v2?' });
    await flush();
    mockRecordLoopMetric.mockClear();
    await sweepOwnerDecisionDigest({ now: new Date(Date.now() + 24 * H) });
    await flush();
    expect(metricRows('owner_decision_digest')[0].meta).toEqual(expect.objectContaining({ phase: 'sent', sinceLastDigestMin: 720, spacingOverridden: false }));
  });
});

describe('owner_question_resolved', () => {
  it('records answers and dismissals with who + latency', async () => {
    const a = await flag();
    const b = await flag({ chatId: 'chat-2', question: 'Rename the results column to pass_rate?' });
    if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(a.question.id, 'u1', 'Yes, 8B');
    await dismissOwnerQuestion(b.question.id, 'u1');
    await flush();
    const rows = metricRows('owner_question_resolved').map((m: any) => m.meta);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'answered', by: 'owner', surface: 'answer' }),
      expect.objectContaining({ outcome: 'dismissed', by: 'owner', surface: 'dismiss' }),
    ]));
    expect(typeof rows[0].latencyMin).toBe('number');
  });
});
