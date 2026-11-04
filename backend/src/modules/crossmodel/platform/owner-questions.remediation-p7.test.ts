/**
 * Remediation P7 S2b — decision cards with cost-of-delay + conservative
 * default answers:
 *   - flagOwnerQuestion stores idleUsdPerDay + the (defaultAfterDays,
 *     defaultOption) PAIR — half a pair never arms (double guard #1);
 *   - the new-flag Telegram DM renders "idle cost ~$N/day" and the default line;
 *   - applyDefaultAnswerIfDue auto-answers ONLY past the deadline with BOTH
 *     fields present (double guard #2): answeredBy 'default', chosenOption on
 *     an option match, wake + supervisor ledger + owner confirmation DM;
 *   - answerOwnerQuestion stamps answeredBy 'owner'.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
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
  flagOwnerQuestion, answerOwnerQuestion, applyDefaultAnswerIfDue, renderCostOfDelay,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockArmRetry.mockReset().mockResolvedValue({ ok: true, scheduleId: 'sched-retry-1' });
  mockTelegramSendMessage.mockReset().mockResolvedValue(true);
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue(null);
  mockAppendAnswered.mockReset().mockResolvedValue(undefined);
});

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Keep the H100 reservation for another week?', ...over });

const flush = () => new Promise((r) => setTimeout(r, 5)); // fire-and-forget DM

describe('flagOwnerQuestion — storage + validation', () => {
  it('stores idleUsdPerDay and the (defaultAfterDays, defaultOption) pair', async () => {
    const r = await flag({ idleUsdPerDay: 48, defaultAfterDays: 3, defaultOption: 'Release it' });
    expect(r.kind).toBe('created');
    const row: any = mockQuestions.rows[0];
    expect(row.idleUsdPerDay).toBe(48);
    expect(row.defaultAfterDays).toBe(3);
    expect(row.defaultOption).toBe('Release it');
  });

  it('HALF a default pair never arms (double guard #1): days without option / option without days', async () => {
    await flag({ defaultAfterDays: 3 });
    expect((mockQuestions.rows[0] as any).defaultAfterDays).toBeUndefined();
    mockQuestions.reset();
    await flag({ defaultOption: 'Release it' });
    expect((mockQuestions.rows[0] as any).defaultOption).toBeUndefined();
  });

  it('garbage values drop: non-positive idle cost, out-of-range days', async () => {
    await flag({ idleUsdPerDay: -5, defaultAfterDays: 400, defaultOption: 'x' });
    const row: any = mockQuestions.rows[0];
    expect(row.idleUsdPerDay).toBeUndefined();
    expect(row.defaultAfterDays).toBeUndefined();
    expect(row.defaultOption).toBeUndefined();
  });

  it('the new-flag DM renders the idle-cost and defaults lines', async () => {
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-1' });
    await flag({ idleUsdPerDay: 48, defaultAfterDays: 3, defaultOption: 'Release it' });
    await flush();
    const dm = String(mockTelegramSendMessage.mock.calls[0][1]);
    expect(dm).toContain('idle cost ~$48/day');
    expect(dm).toContain('defaults to "Release it" after 3 days');
  });

  it('renderCostOfDelay is empty without the fields (cards stay byte-identical for plain questions)', () => {
    expect(renderCostOfDelay({})).toBe('');
    expect(renderCostOfDelay({ idleUsdPerDay: 12.5 })).toContain('idle cost ~$12.50/day');
    expect(renderCostOfDelay({ defaultAfterDays: 2, defaultOption: 'Hold' })).toContain('defaults to "Hold" after 2 days');
    expect(renderCostOfDelay({ defaultAfterDays: 2 })).toBe(''); // half a pair renders nothing
  });
});

describe('applyDefaultAnswerIfDue — the conservative auto-answer', () => {
  const NOW = new Date('2026-09-12T12:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

  async function flaggedRow(over: Record<string, any> = {}): Promise<any> {
    await flag({
      options: [{ id: 'keep', label: 'Keep it' }, { id: 'release', label: 'Release it' }],
      defaultAfterDays: 3, defaultOption: 'release',
    });
    const row: any = mockQuestions.rows[0];
    Object.assign(row, { createdAt: daysAgo(4), ...over });
    return row;
  }

  it('past the deadline with BOTH fields: flips to answered/answeredBy default, stamps chosenOption, wakes, ledgers, DMs the owner', async () => {
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-1' });
    const row = await flaggedRow();
    mockTelegramSendMessage.mockClear();
    const applied = await applyDefaultAnswerIfDue(row, NOW);
    expect(applied).toBe(true);
    expect(row.status).toBe('answered');
    expect(row.answeredBy).toBe('default');
    expect(row.chosenOption).toBe('release');
    expect(String(row.answer)).toContain('Release it');
    expect(String(row.answer)).toContain('preset default');
    // The answer wake fired as usual.
    expect(mockFireScheduleTarget).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1', origin: 'hook' }));
    const wakeText = String(mockFireScheduleTarget.mock.calls[0][0].prompt);
    expect(wakeText).toContain('AUTO-ANSWERED with its preset default');
    // Supervisor ledger — degrades quietly when no supervisor chat exists, but
    // the append seam was exercised (the testkit has no supervisor chat).
    // Owner confirmation DM.
    const dm = String(mockTelegramSendMessage.mock.calls.at(-1)![1]);
    expect(dm).toContain('Default applied');
    expect(dm).toContain('Release it');
  });

  it('NOT due yet ⇒ untouched', async () => {
    const row = await flaggedRow({ createdAt: daysAgo(2) });
    expect(await applyDefaultAnswerIfDue(row, NOW)).toBe(false);
    expect(row.status).toBe('open');
  });

  it('double guard #2: a missing half-pair on the ROW never auto-answers (even past the deadline)', async () => {
    const row = await flaggedRow({ defaultOption: null });
    expect(await applyDefaultAnswerIfDue(row, NOW)).toBe(false);
    const row2 = await flaggedRow({ defaultAfterDays: null });
    expect(await applyDefaultAnswerIfDue(row2, NOW)).toBe(false);
  });

  it('a lost race (already answered) returns false without side effects', async () => {
    const row = await flaggedRow({ status: 'answered' });
    expect(await applyDefaultAnswerIfDue(row, NOW)).toBe(false);
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
  });

  it('free-text defaults (no matching option) still apply, without chosenOption', async () => {
    await flag({ defaultAfterDays: 1, defaultOption: 'Keep everything as is' });
    const row: any = mockQuestions.rows[0];
    row.createdAt = daysAgo(2);
    expect(await applyDefaultAnswerIfDue(row, NOW)).toBe(true);
    expect(row.answeredBy).toBe('default');
    expect(row.chosenOption).toBeUndefined();
    expect(String(row.answer)).toContain('Keep everything as is');
  });
});

describe('answeredBy provenance', () => {
  it('an OWNER answer stamps answeredBy owner', async () => {
    await flag();
    const row: any = mockQuestions.rows[0];
    expect(await answerOwnerQuestion(row.id, 'u1', 'Keep it')).toBe('ok');
    expect(row.answeredBy).toBe('owner');
  });
});
