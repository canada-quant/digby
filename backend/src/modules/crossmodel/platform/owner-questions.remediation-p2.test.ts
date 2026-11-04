/**
 * Remediation P2 — owner-questions hardening:
 *   N3    typed decision options (+ multi-decision refusal, DM rendering,
 *         option matching in the answer path)
 *   v1#5  lane linkage (forChatId/goalId/todoId) + dual wake + supervisor
 *         ledger append on answer
 *   v1#6  durable answer wake (schedule-outbox retry when the immediate wake
 *         does not start) + kill-switch
 *   N8    machine-ask preflight (topic dedupe + answered stop-asking scan)
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// Ticket 26786762: the flag path now vaults delivered credential spans
// through the credentials crypto (AES-256-GCM keyed off JWT_SECRET) — set a
// test secret like the credentials service's own suite does, or the store
// write throws and every credential-carrying flag refuses.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => undefined);
const mockChatFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindMany: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    // Ticket 26786762: the delivered-secrets store + audit table (the flag
    // path vaults would-be-redacted credential spans instead of destroying
    // them — the tables the testkit now carries).
    ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
    activity: mockQuestions.activity,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockArmRetry: jest.Mock = jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  armOwnerAnswerRetrySchedule: (...a: any[]) => mockArmRetry(...a),
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

// v1#5 ledger append — dynamic import of supervisor-state.service.
const mockAppendAnswered: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
}));

// ticket 356d21bb: the answer fan-out's gate unblock is a dynamic import of
// ./goals.service — mocked at the boundary (the real module statically pulls
// middleware/error-handler → config/env → process.exit at import).
const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));

import {
  flagOwnerQuestion,
  answerOwnerQuestion,
  dismissOwnerQuestion,
  normalizeOwnerQuestionOptions,
  looksLikeMultiDecisionQuestion,
  matchAnswerToOption,
  renderOptionsNumbered,
  questionTopicOverlap,
  TOPIC_OVERLAP_THRESHOLD,
  STOP_ASKING_ANSWER_RE,
  shortQuestionRef,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockRefundDailyCapToken.mockReset().mockResolvedValue(undefined);
  mockArmRetry.mockReset().mockResolvedValue({ ok: true, scheduleId: 'sched-retry-1' });
  mockTelegramSendMessage.mockReset().mockResolvedValue(true);
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue(null);
  mockChatFindUnique.mockReset().mockResolvedValue(undefined);
  mockChatFindFirst.mockReset().mockResolvedValue(null);
  mockChatFindMany.mockReset().mockResolvedValue([]);
  mockAppendAnswered.mockReset().mockResolvedValue(undefined);
});

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?', ...over });

// ── Secret-scrubbing review fix (2026-09-27): lane-authored question/context ──
// are redacted at persist like the owner's answer. FAKE fixture shapes only.
// Ticket 26786762 (2026-10-17) updated the contract: a credential span in
// question/context is no longer DESTROYED in place — it is vaulted to the
// encrypted owner_question_secrets store and the stored text carries a
// numbered reveal handle ("[SECRET 1]") the owner can reveal on the card.
// The security property the review fix established is unchanged and still
// asserted below: the plaintext NEVER lands in the stored row.
describe('secret scrubbing — flagOwnerQuestion redacts the question and its context at persist', () => {
  const FAKE_ZAI = '0123456789abcdef0123456789abcdef' + '.AbCdEfGhIjKlMnOp';
  const REDACTED = '[REDACTED: looked like a credential]';

  it('a filed context carrying a Z.ai key and an api_key= assignment stores handles, never plaintext; the stopped-schedule marker survives', async () => {
    const r = await flag({ context: `[stopped-schedule:sch-1] bench ran with ZAI_API_KEY=${FAKE_ZAI}; also api_key=${'x'.repeat(24)}` });
    expect(r.kind).toBe('created');
    const row = (r as any).question;
    // Ticket 26786762: the spans are vaulted with reveal handles, not destroyed.
    expect(row.context).toBe(`[stopped-schedule:sch-1] bench ran with ZAI_API_KEY=[SECRET 1]; also api_key=[SECRET 2]`);
    expect(JSON.stringify(mockQuestions.rows)).not.toContain(FAKE_ZAI);
    // Both delivered values are recoverable by the owner (encrypted store).
    expect(mockQuestions.secretRows).toHaveLength(2);
    expect(mockQuestions.secretRows.every((s: any) => s.valueEnc !== FAKE_ZAI && s.valueEnc.length > 32)).toBe(true);
  });

  it('a question carrying a key stores a handle, never the plaintext', async () => {
    const r = await flag({ question: `May I rotate ${FAKE_ZAI}?` });
    expect((r as any).question.question).toContain('[SECRET 1]');
    expect((r as any).question.question).not.toContain(FAKE_ZAI);
  });

  it('ticket 26786762 kill switch: OWNER_SECRET_DELIVERY_DISABLED=1 restores the pre-fix destruction marker', async () => {
    process.env.OWNER_SECRET_DELIVERY_DISABLED = '1';
    try {
      const r = await flag({ question: `May I rotate ${FAKE_ZAI}?` });
      expect((r as any).question.question).toContain(REDACTED);
      expect((r as any).question.question).not.toContain(FAKE_ZAI);
      // Nothing was vaulted for this flag (the rescue is off) — no row
      // carries the value in any form.
      expect(mockQuestions.secretRows.some((s: any) => s.valueEnc === FAKE_ZAI)).toBe(false);
    } finally {
      delete process.env.OWNER_SECRET_DELIVERY_DISABLED;
    }
  });
});

// ── N3: typed options ─────────────────────────────────────────────────────────

describe('N3 — typed decision options', () => {
  it('normalizeOwnerQuestionOptions: validates, defaults ids, dedupes, caps at 6', () => {
    expect(normalizeOwnerQuestionOptions(undefined)).toBeNull();
    expect(normalizeOwnerQuestionOptions([])).toBeNull();
    expect(normalizeOwnerQuestionOptions([{ label: '' }, { nope: 1 }])).toBeNull();
    const out = normalizeOwnerQuestionOptions([
      { id: 'go', label: 'GO now', consequence: 'cutover runs immediately' },
      { label: 'Hold' }, // id defaults
      { id: 'go', label: 'duplicate id dropped' },
      ...Array.from({ length: 10 }, (_, i) => ({ label: `extra ${i}` })),
    ])!;
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ id: 'go', label: 'GO now', consequence: 'cutover runs immediately' });
    expect(out[1].label).toBe('Hold');
    expect(out[1].id).toMatch(/^opt_/);
  });

  it('looksLikeMultiDecisionQuestion: (1)…(2), "also decide", and two ?-sentences trip; one decision does not', () => {
    expect(looksLikeMultiDecisionQuestion('Decide (1) the region and (2) the engine')).toBe(true);
    expect(looksLikeMultiDecisionQuestion('Pick the region. Also decide the budget cap.')).toBe(true);
    expect(looksLikeMultiDecisionQuestion('Which region? And which engine?')).toBe(true);
    expect(looksLikeMultiDecisionQuestion('Which region should we deploy to?')).toBe(false);
    expect(looksLikeMultiDecisionQuestion('Approve the plan (it costs $50/mo)?')).toBe(false);
  });

  it('a multi-decision question WITHOUT options is refused with multi_decision; WITH options it flags', async () => {
    const refused = await flag({ question: 'Which region? And which engine?' });
    expect(refused).toEqual({ kind: 'refused', refused: 'multi_decision' });
    const ok = await flag({
      question: 'Which region? And which engine?',
      options: [{ id: 'a', label: 'ca + vLLM' }, { id: 'b', label: 'us + TGI' }],
    });
    expect(ok.kind).toBe('created');
  });

  it('created rows store the normalized options; the Telegram DM renders them numbered with the reply hint', async () => {
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-1' });
    const r = await flag({ options: [{ id: 'go', label: 'GO', consequence: 'swap runs now' }, { label: 'Hold' }] });
    if (r.kind !== 'created') throw new Error('expected created');
    expect((r.question as any).options).toEqual([
      { id: 'go', label: 'GO', consequence: 'swap runs now' },
      { id: 'opt_2', label: 'Hold' },
    ]);
    await new Promise((res) => setTimeout(res, 5)); // fire-and-forget DM
    const dm = String(mockTelegramSendMessage.mock.calls[0][1]);
    expect(dm).toContain('1. GO — swap runs now');
    expect(dm).toContain('2. Hold');
    expect(dm).toContain(`answer ${shortQuestionRef(r.question.id)}`);
  });

  it('matchAnswerToOption: id, case-insensitive label, and 1-based number all match; free text does not', () => {
    const opts = [
      { id: 'go', label: 'GO now' },
      { id: 'hold', label: 'Hold the lane' },
    ];
    expect(matchAnswerToOption(opts, 'go')?.id).toBe('go');
    expect(matchAnswerToOption(opts, 'hold the lane')?.id).toBe('hold');
    expect(matchAnswerToOption(opts, '2')?.id).toBe('hold');
    expect(matchAnswerToOption(opts, '3')).toBeNull();
    expect(matchAnswerToOption(opts, 'proceed but carefully')).toBeNull();
    expect(matchAnswerToOption([], 'go')).toBeNull();
  });

  it('answerOwnerQuestion stamps chosenOption on an option-number answer and stores the label', async () => {
    const r = await flag({ options: [{ id: 'go', label: 'GO' }, { id: 'hold', label: 'Hold' }] });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', '2')).toBe('ok');
    const row = mockQuestions.rows[0];
    expect(row.status).toBe('answered');
    expect(row.chosenOption).toBe('hold');
    expect(row.answer).toContain('Hold');
  });

  it('free-text answers on an options question stay free text (no chosenOption)', async () => {
    const r = await flag({ options: [{ id: 'go', label: 'GO' }] });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'neither — rerun the bench first')).toBe('ok');
    const row = mockQuestions.rows[0];
    expect(row.chosenOption).toBeUndefined();
    expect(row.answer).toBe('neither — rerun the bench first');
  });

  it('renderOptionsNumbered is the shared numbered shape', () => {
    expect(renderOptionsNumbered([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', consequence: 'c' }]))
      .toBe('1. A\n2. B — c');
  });
});

// ── v1#5: lane linkage + dual wake + ledger ──────────────────────────────────

describe('v1#5 — lane linkage and answer propagation', () => {
  it('stores forChatId/goalId/todoId when the linked chat belongs to the same owner', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1' });
    const r = await flag({ forChatId: 'lane-1', goalId: 'goal-9', todoId: 'todo-7' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect((r.question as any).forChatId).toBe('lane-1');
    expect((r.question as any).goalId).toBe('goal-9');
    expect((r.question as any).todoId).toBe('todo-7');
  });

  it('drops a FOREIGN forChatId (never an error) and a self-link', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'someone-else' });
    const r1 = await flag({ forChatId: 'lane-x' });
    if (r1.kind !== 'created') throw new Error('expected created');
    expect((r1.question as any).forChatId).toBeUndefined();
    const r2 = await flag({ question: 'Second question?', forChatId: 'chat-1' }); // == chatId
    if (r2.kind !== 'created') throw new Error('expected created');
    expect((r2.question as any).forChatId).toBeUndefined();
  });

  it('the answer wakes BOTH the asking chat and forChatId (deduped when equal)', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1' });
    const r = await flag({ forChatId: 'lane-1' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'go')).toBe('ok');
    const wokenChats = mockFireScheduleTarget.mock.calls.map((c) => c[0].sessionId);
    expect(wokenChats).toEqual(['chat-1', 'lane-1']);
    // Both wakes carry the same resolution prompt.
    for (const call of mockFireScheduleTarget.mock.calls) {
      expect(call[0].prompt).toContain('OWNER just answered');
    }
  });

  it('no forChatId → exactly ONE wake (the pre-existing contract)', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('the answered Q/A lands in the supervisor ledger as a DONE directive', async () => {
    mockChatFindFirst.mockResolvedValue({ id: 'sup-chat-1' }); // the owner's supervisor
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1');
    expect(mockAppendAnswered).toHaveBeenCalledWith('sup-chat-1', 'u1', expect.objectContaining({
      questionId: r.question.id,
      question: 'Which region should we deploy to?',
      answer: 'ca-central-1',
    }));
  });

  it('no supervisor chat → no ledger append, and the answer still lands', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'go')).toBe('ok');
    expect(mockAppendAnswered).not.toHaveBeenCalled();
  });
});

// ── audit 2026-10-06 T3-7 (fleet F11): dismissal retry keyed by QUESTION ─────
describe('T3-7 — a dismissal\'s durable retry is keyed by the question id', () => {
  afterEach(() => { delete process.env.OWNER_DISMISS_RETRY_QUESTION_KEY_DISABLED; });

  it('a BUSY dismissal wake arms [owner-answer-retry:<question id>] and the wake names the id — two dismissals in one chat get two markers', async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    const a = await flag({ question: 'Approve the AGX wizard step?' });
    const b = await flag({ question: 'Approve the Hue bridge credentials?' });
    if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(a.question.id, 'u1')).toBe('ok');
    expect(await dismissOwnerQuestion(b.question.id, 'u1')).toBe('ok');
    const markers = mockArmRetry.mock.calls.map((c: any[]) => c[0].marker);
    expect(markers).toEqual([`[owner-answer-retry:${a.question.id}]`, `[owner-answer-retry:${b.question.id}]`]);
    expect(mockArmRetry.mock.calls[0][0].prompt).toContain(`dismissed your flagged question ${a.question.id}`);
  });

  it('kill switch OWNER_DISMISS_RETRY_QUESTION_KEY_DISABLED=1 restores the chat-keyed marker and the id-less text', async () => {
    process.env.OWNER_DISMISS_RETRY_QUESTION_KEY_DISABLED = '1';
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    const a = await flag({ question: 'Approve the AGX wizard step?' });
    if (a.kind !== 'created') throw new Error('expected created');
    await dismissOwnerQuestion(a.question.id, 'u1');
    expect(mockArmRetry.mock.calls[0][0].marker).toBe('[owner-answer-retry:chat-1]');
    expect(mockArmRetry.mock.calls[0][0].prompt).toContain('dismissed your flagged question] "');
  });
});

// ── v1#6: durable answer wake ────────────────────────────────────────────────

describe('v1#6 — durable answer-wake retry', () => {
  it('a BUSY immediate wake arms the durable retry schedule (marker carries the question id)', async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockArmRetry).toHaveBeenCalledTimes(1);
    const arm = mockArmRetry.mock.calls[0][0];
    expect(arm.sessionId).toBe('chat-1');
    expect(arm.marker).toBe(`[owner-answer-retry:${r.question.id}]`);
    expect(arm.prompt).toContain('OWNER just answered');
  });

  it('a CAPPED chat arms the retry too (the answer lands after the window resets)', async () => {
    mockDailyCapExceeded.mockResolvedValue(48);
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockArmRetry).toHaveBeenCalledTimes(1);
  });

  it('a DELIVERED wake never arms a retry', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockArmRetry).not.toHaveBeenCalled();
  });

  it('an arm failure never fails the answer', async () => {
    mockFireScheduleTarget.mockRejectedValue(new Error('boom'));
    mockArmRetry.mockRejectedValue(new Error('also boom'));
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await expect(answerOwnerQuestion(r.question.id, 'u1', 'go')).resolves.toBe('ok');
  });
});

// ── N8: machine-ask preflight ────────────────────────────────────────────────

describe('N8 — machine-ask preflight', () => {
  it('questionTopicOverlap: same topic ≥ threshold; unrelated topics below it', () => {
    expect(questionTopicOverlap(
      'Which serving engine should the bench use?',
      'Which serving engine should the bench use tonight?',
    )).toBeGreaterThanOrEqual(TOPIC_OVERLAP_THRESHOLD);
    expect(questionTopicOverlap(
      'Which serving engine should the bench use?',
      'Approve the $50/mo Telegram plan?',
    )).toBeLessThan(TOPIC_OVERLAP_THRESHOLD);
  });

  it('STOP_ASKING_ANSWER_RE matches proceed/stop-asking answers, not substantive ones', () => {
    expect(STOP_ASKING_ANSWER_RE.test('Just proceed, and stop asking about this.')).toBe(true);
    expect(STOP_ASKING_ANSWER_RE.test('go ahead')).toBe(true);
    expect(STOP_ASKING_ANSWER_RE.test('Use ca-central-1 for everything EU-adjacent')).toBe(false);
  });

  it('MACHINE flag deduped onto a same-topic OPEN question (returns the existing row)', async () => {
    const first = await flag({ question: 'Which serving engine should the bench use?' });
    if (first.kind !== 'created') throw new Error('expected created');
    const dup = await flag({
      question: 'Which serving engine should the bench use tonight?',
      machineTriggered: true,
    });
    expect(dup.kind).toBe('deduped');
    if (dup.kind === 'deduped') expect(dup.question.id).toBe(first.question.id);
  });

  it('MACHINE flag refused when a recent ANSWERED same-topic question said stop-asking/proceed', async () => {
    const first = await flag({ question: 'Which serving engine should the bench use?' });
    if (first.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(first.question.id, 'u1', 'Use vLLM. Now just proceed and stop asking.');
    const again = await flag({
      question: 'Which serving engine should the bench use tonight?',
      machineTriggered: true,
    });
    expect(again.kind).toBe('refused');
    if (again.kind === 'refused' && again.refused === 'previously_answered') {
      expect(again.prior.id).toBe(first.question.id);
    } else {
      throw new Error(`expected previously_answered, got ${JSON.stringify(again)}`);
    }
  });

  it('a SUBSTANTIVE prior answer does not block a genuine machine re-ask (different situation)', async () => {
    const first = await flag({ question: 'Which serving engine should the bench use?' });
    if (first.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(first.question.id, 'u1', 'Use vLLM for this run only');
    const again = await flag({
      question: 'Which serving engine should the bench use for phase 2?',
      machineTriggered: true,
    });
    expect(again.kind).toBe('created');
  });

  it('USER-anchored flags skip the preflight entirely (a human may re-ask deliberately)', async () => {
    const first = await flag({ question: 'Which serving engine should the bench use?' });
    if (first.kind !== 'created') throw new Error('expected created');
    const again = await flag({ question: 'Which serving engine should the bench use tonight?' });
    expect(again.kind).toBe('created');
  });
});
