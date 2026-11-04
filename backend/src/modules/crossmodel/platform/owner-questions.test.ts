/**
 * "Needs owner" persistent inbox (ticket 7705fec2) — the owner-questions
 * store, unit-tested directly against an in-memory ownerQuestion table
 * (config/database mocked): input caps, the exact-question dedup, the
 * dismissed-recently cooldown, the per-chat open cap, the per-session hourly
 * rate cap (file_feedback's session-cap mechanism), the conditional
 * answer/dismiss flips (one-shot, ownership-guarded), and the best-effort
 * transcript note posted back into the originating chat.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
  },
}));

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the platform-tools.test.ts pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The resolution wake (2026-08-30): dynamic import of ../coding/schedule.service
// — mocked at the boundary (the real module pulls config/redis → config/env).
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
}));

// ticket 4ab93d8d: the flag-time Telegram push is a dynamic import of
// ../telegram/telegram.service — mocked at the boundary (the real module
// pulls config/redis → config/env).
const mockTelegramIsConfigured: jest.Mock = jest.fn(() => true);
const mockTelegramSendMessage: jest.Mock = jest.fn(async () => {});
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => mockTelegramIsConfigured(),
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
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
  OWNER_QUESTION_OPEN_CAP,
  OWNER_QUESTION_RATE_CAP_PER_HOUR,
  STOPPED_SCHEDULE_MARKER_PREFIX,
  answerOwnerQuestion,
  dismissOwnerQuestion,
  flagOwnerQuestion,
  hasOpenStoppedScheduleDecision,
  isSameDecisionQuestion,
  listOpenOwnerQuestionsForUser,
  resolveOwnerQuestionsForChatAnswer,
  resolveStoppedScheduleDecisionsForSession,
  stoppedScheduleMarker,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockRefundDailyCapToken.mockReset().mockResolvedValue(undefined);
  mockTelegramIsConfigured.mockReset().mockReturnValue(true);
  mockTelegramSendMessage.mockReset().mockResolvedValue(undefined);
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?', ...over });

describe('flagOwnerQuestion', () => {
  it('creates a row: oq_ id, open, trimmed fields', async () => {
    const r = await flag({ question: '  Pick a region?  ', context: '  ca vs us  ' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.question.id).toMatch(/^oq_/);
    expect(r.question).toMatchObject({
      chatId: 'chat-1', userId: 'u1', question: 'Pick a region?', context: 'ca vs us', status: 'open', answer: null,
    });
    expect(mockQuestions.rows).toHaveLength(1);
  });

  it('caps question/context length and rejects an empty question', async () => {
    const long = await flag({ question: 'q'.repeat(3000), context: 'c'.repeat(5000) });
    expect(long.kind).toBe('created');
    if (long.kind === 'created') {
      expect(long.question.question).toHaveLength(2000);
      expect(long.question.context).toHaveLength(4000);
    }
    await expect(flag({ question: '   ' })).resolves.toEqual({ kind: 'refused', refused: 'invalid' });
  });

  it('dedups an OPEN row with the same chatId+question (returns it, no second row)', async () => {
    const first = await flag();
    const second = await flag();
    expect(second.kind).toBe('deduped');
    if (second.kind === 'deduped' && first.kind === 'created') {
      expect(second.question.id).toBe(first.question.id);
    }
    expect(mockQuestions.rows).toHaveLength(1);
    // A DIFFERENT question or a different chat is not a dup.
    await expect(flag({ question: 'Something else?' })).resolves.toMatchObject({ kind: 'created' });
    await expect(flag({ chatId: 'chat-2' })).resolves.toMatchObject({ kind: 'created' });
    expect(mockQuestions.rows).toHaveLength(3);
  });

  it('refuses when the same chatId+question was DISMISSED within 24h, allows after the cooldown', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await flag();
    if (first.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(first.question.id, 'u1')).toBe('ok');
    // abca56ce: the refused shape now names the ACTOR (default owner) in message.
    await expect(flag()).resolves.toEqual({ kind: 'refused', refused: 'dismissed_recently', message: 'the owner dismissed this topic recently — do not re-raise it; act on what you have' });
    expect(mockQuestions.rows).toHaveLength(1); // no second row
    // 24h later the cooldown lifts.
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + 24 * 3600_000 + 1000);
    await expect(flag()).resolves.toMatchObject({ kind: 'created' });
  });

  it('an ANSWERED question is neither a dedup hit nor a cooldown block (re-flag creates fresh)', async () => {
    const first = await flag();
    if (first.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(first.question.id, 'u1', 'ca-central-1')).toBe('ok');
    await expect(flag()).resolves.toMatchObject({ kind: 'created' });
    expect(mockQuestions.rows).toHaveLength(2);
  });

  it('refuses at the per-chat open cap (10), but not for another chat', async () => {
    for (let i = 0; i < OWNER_QUESTION_OPEN_CAP; i++) {
      // Spread the createdAts over >1h so the hourly rate cap doesn't bind first.
      jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + i * 4000_000);
      await expect(flag({ question: `Q${i}?` })).resolves.toMatchObject({ kind: 'created' });
    }
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + OWNER_QUESTION_OPEN_CAP * 4000_000);
    await expect(flag({ question: 'one too many?' })).resolves.toEqual({ kind: 'refused', refused: 'cap' });
    await expect(flag({ chatId: 'chat-2', question: 'one too many?' })).resolves.toMatchObject({ kind: 'created' });
  });

  it('rate-caps a session at 3 fresh flags per hour (file_feedback session-cap mechanism)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    for (let i = 0; i < OWNER_QUESTION_RATE_CAP_PER_HOUR; i++) {
      await expect(flag({ question: `Q${i}?` })).resolves.toMatchObject({ kind: 'created' });
    }
    await expect(flag({ question: 'fourth in the hour?' })).resolves.toEqual({ kind: 'refused', refused: 'cap' });
    // An hour later the window resets.
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + 3600_000 + 1000);
    await expect(flag({ question: 'after the window?' })).resolves.toMatchObject({ kind: 'created' });
  });
});

describe('ticket 4ab93d8d — Telegram push on a new owner flag', () => {
  // The push is fire-and-forget (void …catch) — flush the microtask queue so
  // the assertions observe its settled state deterministically.
  const flushPush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  it('a NEW flag with a linked Telegram DMs the owner the question (inbox pointer included)', async () => {
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-4242' });
    const r = await flagOwnerQuestion({ chatId: 'c1', userId: 'u1', question: 'Approve the upstream issue?' });
    expect(r.kind).toBe('created');
    await flushPush();
    expect(mockTelegramLinkFindUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = mockTelegramSendMessage.mock.calls[0];
    expect(chatId).toBe('tg-4242');
    expect(text).toContain('Approve the upstream issue?');
    expect(text).toContain('Management');
  });

  it('no Telegram link → no DM, but the flag still lands', async () => {
    const r = await flagOwnerQuestion({ chatId: 'c1', userId: 'u1', question: 'No link here' });
    expect(r.kind).toBe('created');
    await flushPush();
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
  });

  it('bot not configured → no link lookup, no DM, flag still lands', async () => {
    mockTelegramIsConfigured.mockReturnValue(false);
    const r = await flagOwnerQuestion({ chatId: 'c1', userId: 'u1', question: 'Unconfigured bot' });
    expect(r.kind).toBe('created');
    await flushPush();
    expect(mockTelegramLinkFindUnique).not.toHaveBeenCalled();
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
  });

  it('a DEDUPED flag does not re-ping the owner', async () => {
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-4242' });
    await flagOwnerQuestion({ chatId: 'c1', userId: 'u1', question: 'Same question twice' });
    await flushPush();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    const r2 = await flagOwnerQuestion({ chatId: 'c1', userId: 'u1', question: 'Same question twice' });
    expect(r2.kind).toBe('deduped');
    await flushPush();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
  });

  it('a Telegram send failure never fails the flag (fire-and-forget)', async () => {
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-4242' });
    mockTelegramSendMessage.mockRejectedValue(new Error('telegram 502'));
    const r = await flagOwnerQuestion({ chatId: 'c1', userId: 'u1', question: 'Push blows up' });
    expect(r.kind).toBe('created');
    await flushPush();
  });
});

describe('listOpenOwnerQuestionsForUser', () => {
  it('returns only the user\'s OPEN rows, newest first', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const a = await flag({ question: 'first?' });
    (Date.now as jest.Mock).mockReturnValue(1_001_000);
    const b = await flag({ question: 'second?' });
    await flag({ userId: 'u2', chatId: 'chat-2', question: 'other user?' });
    if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(b.question.id, 'u1')).toBe('ok');
    const list = await listOpenOwnerQuestionsForUser('u1');
    expect(list.map((r) => r.id)).toEqual([a.question.id]);
  });
});

describe('answerOwnerQuestion', () => {
  it('flips open → answered (one-shot) with the answer + resolvedAt, and posts the transcript note', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', '  ca-central-1, then reassess  ')).toBe('ok');
    const row = mockQuestions.rows[0];
    expect(row.status).toBe('answered');
    expect(row.answer).toBe('ca-central-1, then reassess'); // trimmed
    expect(row.resolvedAt).toBeInstanceOf(Date);
    // One-shot: a second answer is refused.
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'changed my mind')).toBe('not_open');
    // Transcript note into the ORIGINATING chat.
    expect(mockQuestions.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data;
    expect(note).toMatchObject({ chatId: 'chat-1', role: 'assistant' });
    expect(note.metadata).toMatchObject({ origin: 'owner-inbox' });
    expect(note.content).toContain('[Owner inbox]');
    expect(note.content).toContain('Q: "Which region should we deploy to?"');
    expect(note.content).toContain('A: "ca-central-1, then reassess"');
    expect(mockQuestions.crossModelChat.update).toHaveBeenCalledTimes(1); // sidebar bump
  });

  it('caps the answer at 8000 chars', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', ` ${'a'.repeat(9000)} `)).toBe('ok');
    expect(mockQuestions.rows[0].answer).toHaveLength(8000);
  });

  it('N9 — a credential-shaped answer is stored REDACTED (row, transcript note, and wake prompt)', async () => {
    // FAKE fixture token — the incident: an owner password sat verbatim in the
    // answer row and rode into every later prompt render of the chat.
    const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', `use ${FAKE_GH} for the deploy`)).toBe('ok');
    const row = mockQuestions.rows[0];
    expect(row.answer).toBe('use [REDACTED: looked like a credential] for the deploy');
    expect(row.answer).not.toContain(FAKE_GH);
    // The transcript note and the wake prompt render the SAME redacted text.
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data;
    expect(note.content).not.toContain(FAKE_GH);
    expect(note.content).toContain('[REDACTED: looked like a credential]');
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.prompt).not.toContain(FAKE_GH);
    expect(wake.prompt).toContain('[REDACTED: looked like a credential]');
  });

  it('a transcript-note failure does NOT fail the answer (best-effort)', async () => {
    mockQuestions.crossModelMessage.create.mockRejectedValueOnce(new Error('db down'));
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await expect(answerOwnerQuestion(r.question.id, 'u1', 'yes')).resolves.toBe('ok');
    expect(mockQuestions.rows[0].status).toBe('answered');
  });

  it('refuses a wrong user and a nonexistent id without touching the row', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u2', 'intruder')).toBe('not_found');
    expect(await answerOwnerQuestion('oq_nope', 'u1', 'ghost')).toBe('not_found');
    expect(mockQuestions.rows[0].status).toBe('open');
    expect(mockQuestions.crossModelMessage.create).not.toHaveBeenCalled();
  });
});

describe('dismissOwnerQuestion', () => {
  it('flips open → dismissed with resolvedAt and posts the "stop raising it" note', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1')).toBe('ok');
    const row = mockQuestions.rows[0];
    expect(row.status).toBe('dismissed');
    expect(row.answer).toBeNull();
    expect(row.resolvedAt).toBeInstanceOf(Date);
    expect(await dismissOwnerQuestion(r.question.id, 'u1')).toBe('not_open'); // one-shot
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data;
    expect(note.content).toContain('dismissed this flagged question — stop raising it');
    expect(note.content).toContain('"Which region should we deploy to?"');
  });

  it('refuses a wrong user and a nonexistent id', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u2')).toBe('not_found');
    expect(await dismissOwnerQuestion('oq_nope', 'u1')).toBe('not_found');
    expect(mockQuestions.rows[0].status).toBe('open');
    expect(mockQuestions.crossModelMessage.create).not.toHaveBeenCalled();
  });

  // ── Ticket abca56ce: dismissal ATTRIBUTION ────────────────────────────────
  // The 2026-10-16 specimen: a 15:27Z owner-inbox dismissal was narrated at
  // 15:28Z as "dismissed as our bug" with no actor. Every dismissal now
  // stamps dismissedBy and narrates FROM it — a supervisor/system dismissal
  // must never read as the owner's "stop raising it" ruling.
  it('abca56ce: stamps the ACTOR on the row and narrates it — owner default, supervisor/agent/system named', async () => {
    // Default (legacy call sites) = the owner; sentence unchanged.
    let r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1')).toBe('ok');
    expect(mockQuestions.rows[0].dismissedBy).toBe('owner');
    expect(mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content).toContain('The owner dismissed this flagged question');
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('the OWNER dismissed your flagged question');

    // A supervisor-seat dismissal is attributed to the supervisor, NOT owner.
    mockQuestions.rows.length = 0;
    mockQuestions.crossModelMessage.create.mockClear();
    mockFireScheduleTarget.mockClear();
    r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1', { dismissedBy: 'supervisor', reason: 'duplicate of the live card' })).toBe('ok');
    expect(mockQuestions.rows[0].dismissedBy).toBe('supervisor');
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(note).toContain('The Fleet Supervisor (on the owner\'s behalf, under standing directives) dismissed this flagged question');
    expect(note).not.toContain('The owner dismissed this flagged question');
    expect(note).toContain('— reason: duplicate of the live card — stop raising it: "Which region should we deploy to?"');

    // The filing chat withdrawing its own card.
    mockQuestions.rows.length = 0;
    mockQuestions.crossModelMessage.create.mockClear();
    mockFireScheduleTarget.mockClear();
    r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1', { dismissedBy: 'agent' })).toBe('ok');
    expect(mockQuestions.rows[0].dismissedBy).toBe('agent');
    expect(mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content).toContain('The chat that filed it dismissed this flagged question');

    // A system (superseded) dismissal says it is NOT the owner's ruling.
    mockQuestions.rows.length = 0;
    mockQuestions.crossModelMessage.create.mockClear();
    mockFireScheduleTarget.mockClear();
    r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1', { dismissedBy: 'system' })).toBe('ok');
    expect(mockQuestions.rows[0].dismissedBy).toBe('system');
    expect(mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content).toContain('The system dismissed this flagged question (superseded — not the owner\'s ruling)');
    // The question stays extractable by the frontend parser: the note still
    // ends with 'stop raising it: "<question>"'.
    expect(mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content).toMatch(/stop raising it: "[^"]+"$/);
  });
});


// ── Resolution wake (2026-08-30 live audit) ─────────────────────────────────
// The transcript note alone waited for the chat's next scheduled wake (up to a
// 2h sweep); an owner resolution now fires a machine run immediately through
// the shared fireScheduleTarget path.

describe('resolution wakes the originating chat', () => {
  it('an answer WAKES the chat with the resolution text (origin hook)', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const arg = mockFireScheduleTarget.mock.calls[0][0];
    expect(arg.sessionId).toBe('chat-1');
    expect(arg.origin).toBe('hook');
    expect(arg.id).toMatch(/^owner-inbox-/);
    expect(arg.prompt).toContain('OWNER just answered');
    expect(arg.prompt).toContain('ca-central-1');
  });

  it('a dismissal WAKES the chat with the stop-raising instruction', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1')).toBe('ok');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('dismissed');
  });

  it('a busy chat refunds the reserved cap token (the note still awaits the next wake)', async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'yes')).toBe('ok');
    expect(mockRefundDailyCapToken).toHaveBeenCalledWith('chat-1');
  });

  it('a chat at its daily cap is not woken, and the resolution still lands', async () => {
    mockDailyCapExceeded.mockResolvedValue(48);
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'yes')).toBe('ok');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockQuestions.rows[0].status).toBe('answered');
  });

  it('a wake failure never fails the resolution', async () => {
    mockFireScheduleTarget.mockRejectedValue(new Error('scheduler exploded'));
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await expect(answerOwnerQuestion(r.question.id, 'u1', 'yes')).resolves.toBe('ok');
    expect(mockQuestions.rows[0].status).toBe('answered');
  });

  it('refused resolutions (wrong user / nonexistent) never wake', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u2', 'intruder');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
  });
});

/**
 * Ticket 992c8374 — "Decision card won't dismiss: custom typed answers not
 * registered" (2026-09-05): the Fleet Supervisor flagged the Spark
 * Qwen3.8-Flash-Next bring-up with flag_owner_question AND asked it with
 * ask_user ("GO / NVFP4 first / Hold"). The owner typed custom answers into
 * the CARD three times; each resolved the ask_user wait but NOTHING closed
 * the flagged row, so the fleet-attention block kept reporting "The owner has
 * NOT answered" and every wake re-asked — the card would not dismiss. These
 * tests replay that incident: an answer on the in-chat card must close the
 * matching flagged question (same chat, same owner, same decision) so it
 * never re-lists, and must never close a DIFFERENT open decision.
 */
describe('isSameDecisionQuestion (ticket 992c8374)', () => {
  it('identical decisions match modulo casing/punctuation', () => {
    expect(isSameDecisionQuestion(
      'Spark Qwen3.8-Flash-Next bring-up: GO / NVFP4 first / Hold?',
      'spark qwen3 8 flash next bring up go nvfp4 first hold',
    )).toBe(true);
  });

  it('the incident pair matches on token overlap (word order / extra words differ)', () => {
    expect(isSameDecisionQuestion(
      'Spark Qwen3.8-Flash-Next bring-up: GO with the current plan, NVFP4 first, or hold the lane?',
      'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?',
    )).toBe(true);
  });

  it('containment matches only with the minimum-length guard', () => {
    expect(isSameDecisionQuestion(
      'Ship the NVFP4 quant first?',
      'Decision needed: ship the NVFP4 quant first, or hold for the full stack?',
    )).toBe(true);
    // A short generic string must never contain-match its way into a decision.
    expect(isSameDecisionQuestion('GO?', 'Decision needed: go with the plan, or hold?')).toBe(false);
  });

  it('different decisions do NOT match (the false-positive bar)', () => {
    expect(isSameDecisionQuestion(
      'Spark Qwen3.8-Flash-Next bring-up: GO / NVFP4 first / Hold?',
      'Which region should we deploy the staging stack to?',
    )).toBe(false);
    expect(isSameDecisionQuestion('', 'anything')).toBe(false);
  });

  it('round-1 review B1: formulaic frames differing only in the lane/region noun do NOT match', () => {
    // The exact counterexamples the adversarial review crossed the old
    // stopword-inclusive Jaccard bar with (0.80 / 0.71) — full content-token
    // coverage rejects both because 'helios'/'apollo' and 'staging'/'ca' vs
    // 'production'/'us' are not shared.
    expect(isSameDecisionQuestion(
      'Lane Helios: GO with the current plan, or hold the lane?',
      'Lane Apollo: GO with the current plan, or hold the lane?',
    )).toBe(false);
    expect(isSameDecisionQuestion(
      'Should we deploy the staging stack to the ca region or hold the release?',
      'Should we deploy the production stack to the us region or hold the release?',
    )).toBe(false);
  });

  it('coverage is word-order agnostic: the same decision rephrased still matches', () => {
    expect(isSameDecisionQuestion(
      'Deploy the NVFP4 build to the ca-central-1 spark cluster first?',
      'NVFP4 build first: deploy to the ca-central-1 spark cluster?',
    )).toBe(true);
  });
});

describe('resolveOwnerQuestionsForChatAnswer (ticket 992c8374 — card answers close the flag)', () => {
  const ask = 'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?';

  it('replays the incident: a custom typed card answer resolves the matching flagged decision', async () => {
    const r = await flag({ question: 'Spark Qwen3.8-Flash-Next bring-up: GO with the current plan, NVFP4 first, or hold the lane?' });
    if (r.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({
      chatId: 'chat-1', userId: 'u1', askedQuestion: ask, answer: 'GO, but NVFP4 first and hold the vision tower',
    });
    expect(out).toEqual({ resolved: 1, ids: [r.question.id] });
    const row = mockQuestions.rows[0];
    expect(row.status).toBe('answered');
    expect(row.answer).toBe('GO, but NVFP4 first and hold the vision tower');
    expect(row.resolvedAt).toBeInstanceOf(Date);
    // The transcript note records the provenance…
    expect(mockQuestions.crossModelMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        chatId: 'chat-1',
        role: 'assistant',
        content: expect.stringContaining('in-chat decision card'),
      }),
    }));
    // …but the chat is NOT woken — the asking run already resumed with the answer.
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    // And the open listing is empty: the fleet-attention block stops re-listing it.
    expect(await listOpenOwnerQuestionsForUser('u1')).toHaveLength(0);
  });

  it('never closes a DIFFERENT open decision on the same chat', async () => {
    const spark = await flag({ question: 'Spark Qwen3.8-Flash-Next bring-up: GO with the current plan, NVFP4 first, or hold the lane?' });
    const region = await flag({ question: 'Which region should we deploy the staging stack to?' });
    if (spark.kind !== 'created' || region.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({ chatId: 'chat-1', userId: 'u1', askedQuestion: ask, answer: 'GO' });
    expect(out).toEqual({ resolved: 1, ids: [spark.question.id] });
    expect(mockQuestions.rows.find((row) => row.id === region.question.id)?.status).toBe('open');
  });

  it('scopes to the same chat and the same owner', async () => {
    const mine = await flag({ question: 'Spark Qwen3.8-Flash-Next bring-up: GO / NVFP4 first / Hold?' });
    const otherChat = await flag({ chatId: 'chat-2', question: 'Spark Qwen3.8-Flash-Next bring-up: GO / NVFP4 first / Hold?' });
    const otherUser = await flag({ chatId: 'chat-3', userId: 'u2', question: 'Spark Qwen3.8-Flash-Next bring-up: GO / NVFP4 first / Hold?' });
    if (mine.kind !== 'created' || otherChat.kind !== 'created' || otherUser.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({ chatId: 'chat-1', userId: 'u1', askedQuestion: ask, answer: 'GO' });
    expect(out).toEqual({ resolved: 1, ids: [mine.question.id] });
    expect(mockQuestions.rows.find((row) => row.id === otherChat.question.id)?.status).toBe('open');
    expect(mockQuestions.rows.find((row) => row.id === otherUser.question.id)?.status).toBe('open');
  });

  it('resolves every matching open row (a re-flagged duplicate decision closes too)', async () => {
    const first = await flag({ question: 'Spark Qwen3.8-Flash-Next bring-up: GO / NVFP4 first / Hold?' });
    if (first.kind !== 'created') throw new Error('expected created');
    // Resolve the first through the inbox, then the run re-flags the same decision.
    expect(await answerOwnerQuestion(first.question.id, 'u1', 'first answer')).toBe('ok');
    const second = await flag({ question: 'Spark Qwen3.8-Flash-Next bring-up: GO with the current plan, NVFP4 first, or hold the lane?' });
    if (second.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({ chatId: 'chat-1', userId: 'u1', askedQuestion: ask, answer: 'GO' });
    // Only the still-OPEN row flips — the answered one is untouched.
    expect(out).toEqual({ resolved: 1, ids: [second.question.id] });
    expect(mockQuestions.rows.find((row) => row.id === first.question.id)?.answer).toBe('first answer');
  });

  it('is a no-op on blank input and never throws on a store failure', async () => {
    expect(await resolveOwnerQuestionsForChatAnswer({ chatId: 'chat-1', userId: 'u1', askedQuestion: '', answer: 'GO' }))
      .toEqual({ resolved: 0, ids: [] });
    expect(await resolveOwnerQuestionsForChatAnswer({ chatId: 'chat-1', userId: 'u1', askedQuestion: ask, answer: '   ' }))
      .toEqual({ resolved: 0, ids: [] });
    // NOTE: spyOn on the kit's own jest.fn returns THAT fn, so mockRestore()
    // would WIPE its base implementation for every later test (found via the
    // SA0906 tests below going dark). ...Once is self-consuming — no restore.
    mockQuestions.api.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveOwnerQuestionsForChatAnswer({ chatId: 'chat-1', userId: 'u1', askedQuestion: ask, answer: 'GO' }))
      .resolves.toEqual({ resolved: 0, ids: [] });
  });
});

/**
 * SA0906 — stopped-schedule decision cards: the store half. The filing half
 * (coding/stopped-schedule-alert.ts) embeds a machine-readable marker in the
 * decision's context; these tests pin the marker format, the per-scheduleId
 * dedupe read, the session-scoped lane-revival auto-resolve (successor =
 * resolution), the context ECHO on the answer relay, and the full relay
 * round-trip: the owner's "resume" reaches the SESSION chat's wake prompt.
 */
describe('stopped-schedule decisions (SA0906)', () => {
  const SCHED = '0242af66-aaaa-bbbb-cccc-ddddeeeeffff';
  const SESSION = 'sess-spark';
  const stoppedFlag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
    flagOwnerQuestion({
      chatId: SESSION,
      userId: 'u1',
      question: `Resume the stopped schedule ${SCHED.slice(0, 8)} on "Spark cluster"?`,
      context: `${stoppedScheduleMarker(SCHED)}\nSchedule ${SCHED} stopped permanently — it hit its 8-run cap. Active goal it was serving: "W4A16 kernel optimization program" (2 todos remaining).\nReply "resume" to restart it or "leave stopped" to keep it off.`,
      ...over,
    });

  it('the marker format is stable and prefix-scannable', () => {
    expect(stoppedScheduleMarker(SCHED)).toBe(`[stopped-schedule:${SCHED}]`);
    expect(stoppedScheduleMarker(SCHED).startsWith(STOPPED_SCHEDULE_MARKER_PREFIX)).toBe(true);
  });

  it('hasOpenStoppedScheduleDecision sees exactly the open marker-carrying row (the per-scheduleId dedupe)', async () => {
    await expect(hasOpenStoppedScheduleDecision(SCHED)).resolves.toBe(false);
    const r = await stoppedFlag();
    expect(r.kind).toBe('created');
    await expect(hasOpenStoppedScheduleDecision(SCHED)).resolves.toBe(true);
    // A different schedule's id does not match.
    await expect(hasOpenStoppedScheduleDecision('3321c38e-0000-1111-2222-333344445555')).resolves.toBe(false);
    // Resolution closes the dedupe window.
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'leave stopped')).toBe('ok');
    await expect(hasOpenStoppedScheduleDecision(SCHED)).resolves.toBe(false);
  });

  it('hasOpenStoppedScheduleDecision fails OPEN to false on a store error (flag-layer dedupe backstops)', async () => {
    mockQuestions.api.findFirst.mockRejectedValueOnce(new Error('db down')); // Once — never mockRestore a kit fn (see note above)
    await expect(hasOpenStoppedScheduleDecision(SCHED)).resolves.toBe(false);
  });

  describe('lane revival auto-resolves the session\'s open decisions (successor = resolution)', () => {
    it('resolves EVERY open stopped-schedule decision on the chat, posts the note, and never wakes', async () => {
      const a = await stoppedFlag();
      const b = await stoppedFlag({
        question: 'Resume the stopped schedule 3321c38e on "Spark cluster"?',
        context: `${stoppedScheduleMarker('3321c38e-0000-1111-2222-333344445555')}\nSecond stopped link.`,
      });
      if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected created');
      await expect(resolveStoppedScheduleDecisionsForSession(SESSION)).resolves.toBe(2);
      for (const id of [a.question.id, b.question.id]) {
        const row = mockQuestions.rows.find((r) => r.id === id);
        expect(row.status).toBe('answered');
        expect(row.answer).toContain('[auto-resolved]');
        expect(row.resolvedAt).toBeInstanceOf(Date);
      }
      // Transcript notes record the provenance…
      const notes = mockQuestions.crossModelMessage.create.mock.calls.map((c) => c[0].data.content);
      expect(notes.filter((n) => n.includes('Auto-resolved a stopped-schedule decision'))).toHaveLength(2);
      // …but the chat is NOT woken (the revival itself was the action).
      expect(mockFireScheduleTarget).not.toHaveBeenCalled();
      expect(await listOpenOwnerQuestionsForUser('u1')).toHaveLength(0);
    });

    it('touches ONLY marker-carrying rows on THAT chat — other decisions and other chats stay open', async () => {
      const stopped = await stoppedFlag();
      const unrelated = await flagOwnerQuestion({ chatId: SESSION, userId: 'u1', question: 'Which region should we deploy to?' });
      const otherChat = await stoppedFlag({ chatId: 'sess-other', question: 'Resume the stopped schedule 0242af66 on "Other lane"?' });
      if (stopped.kind !== 'created' || unrelated.kind !== 'created' || otherChat.kind !== 'created') throw new Error('expected created');
      await expect(resolveStoppedScheduleDecisionsForSession(SESSION)).resolves.toBe(1);
      expect(mockQuestions.rows.find((r) => r.id === stopped.question.id)?.status).toBe('answered');
      expect(mockQuestions.rows.find((r) => r.id === unrelated.question.id)?.status).toBe('open');
      expect(mockQuestions.rows.find((r) => r.id === otherChat.question.id)?.status).toBe('open');
    });

    it('is idempotent and returns 0 with no open decisions', async () => {
      await expect(resolveStoppedScheduleDecisionsForSession(SESSION)).resolves.toBe(0);
      expect(mockQuestions.crossModelMessage.create).not.toHaveBeenCalled();
    });

    it('returns 0 and never throws on a store failure (the arm/resume path must not break)', async () => {
      mockQuestions.api.findMany.mockRejectedValueOnce(new Error('db down')); // Once — never mockRestore a kit fn (see note above)
      await expect(resolveStoppedScheduleDecisionsForSession(SESSION)).resolves.toBe(0);
    });
  });

  describe('answer relay round-trip — the owner\'s "resume" reaches the session chat', () => {
    it('wakes the SESSION chat with the owner\'s text, the question, AND the echoed context (the schedule id the run needs)', async () => {
      const r = await stoppedFlag();
      if (r.kind !== 'created') throw new Error('expected created');
      expect(await answerOwnerQuestion(r.question.id, 'u1', 'resume')).toBe('ok');
      expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
      const wake = mockFireScheduleTarget.mock.calls[0][0];
      expect(wake.sessionId).toBe(SESSION);      // the chat that owns the schedule
      expect(wake.origin).toBe('hook');          // machine-run wake path
      expect(wake.prompt).toContain('OWNER just answered');
      expect(wake.prompt).toContain('A: "resume"');
      expect(wake.prompt).toContain(`Resume the stopped schedule ${SCHED.slice(0, 8)} on "Spark cluster"?`);
      // The context echo carries the full schedule id + the re-arm instruction,
      // so the woken run can act without any other lookup.
      expect(wake.prompt).toContain('[Question context — as filed with the flag]');
      expect(wake.prompt).toContain(stoppedScheduleMarker(SCHED));
      expect(wake.prompt).toContain('Reply "resume" to restart it');
    });

    it('a question WITHOUT context keeps the legacy wake shape (no empty echo block)', async () => {
      const r = await flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Plain decision?' });
      if (r.kind !== 'created') throw new Error('expected created');
      expect(await answerOwnerQuestion(r.question.id, 'u1', 'yes')).toBe('ok');
      expect(mockFireScheduleTarget.mock.calls[0][0].prompt).not.toContain('[Question context');
    });

    it('clips a maximal context in the echo (the wake prompt stays bounded)', async () => {
      const r = await flagOwnerQuestion({
        chatId: SESSION, userId: 'u1', question: 'Huge-context decision?',
        context: `${stoppedScheduleMarker(SCHED)}\n${'x'.repeat(4000)}`,
      });
      if (r.kind !== 'created') throw new Error('expected created');
      expect(await answerOwnerQuestion(r.question.id, 'u1', 'resume')).toBe('ok');
      const prompt: string = mockFireScheduleTarget.mock.calls[0][0].prompt;
      expect(prompt).toContain(stoppedScheduleMarker(SCHED)); // marker leads, survives the clip
      const echo = prompt.split('[Question context — as filed with the flag]\n')[1] ?? '';
      expect(echo.indexOf('\nAct on this answer now')).toBeLessThanOrEqual(1501);
    });
  });
});
