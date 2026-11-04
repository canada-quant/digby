/**
 * Remediation P2 item 4 — owner-question answers over Telegram: the
 * tryAnswerOwnerQuestionFromTelegram pre-router closes flagged questions
 * through the SAME answer path as the Inbox (answerOwnerQuestion — typed-
 * option matching included) BEFORE anything reaches the chat pipeline.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../langgraph/integration-status-cache', () => ({
  __esModule: true,
  invalidateIntegrationStatusCache: jest.fn(async () => {}),
}));

const mockSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('./telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  getBotUsername: () => 'DigbyBot',
  sendMessage: (...a: any[]) => mockSendMessage(...a),
  sendTyping: jest.fn(async () => {}),
  mintLinkToken: jest.fn(async () => 't'),
  consumeLinkToken: jest.fn(async () => null),
  buildConnectUrl: jest.fn(() => 'https://t.me/DigbyBot?start=t'),
}));

// The pre-router dynamically imports owner-questions: mock the store-touching
// halves, keep shortQuestionRef REAL (requireActual is safe — owner-questions'
// only static import is node:crypto).
const mockListOpen: jest.Mock = jest.fn(async (): Promise<any[]> => []);
const mockAnswer: jest.Mock = jest.fn(async () => 'ok' as const);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/owner-questions'),
  listOpenOwnerQuestionsForUser: (...a: any[]) => mockListOpen(...a),
  answerOwnerQuestion: (...a: any[]) => mockAnswer(...a),
}));

import { tryAnswerOwnerQuestionFromTelegram } from './telegram.controller';

const U = 'user-1';
const TG = '12345';
const Q1 = { id: 'oq_aabbccdd-1111-2222-3333-444444444444', chatId: 'chat-1', userId: U, question: 'Which serving engine should the bench use?', createdAt: new Date(), status: 'open' };
const Q2 = { id: 'oq_eeff0011-5555-6666-7777-888888888888', chatId: 'chat-2', userId: U, question: 'Approve the $50/mo plan?', createdAt: new Date(), status: 'open' };

beforeEach(() => {
  mockSendMessage.mockClear();
  mockListOpen.mockReset().mockResolvedValue([Q1, Q2]);
  mockAnswer.mockReset().mockResolvedValue('ok');
});

describe('answer <ref|N> <text> command', () => {
  it("'answer 1 <text>' closes the FIRST open question (newest first) through answerOwnerQuestion", async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer 1 use vLLM', {});
    expect(handled).toBe(true);
    expect(mockAnswer).toHaveBeenCalledWith(Q1.id, U, 'use vLLM');
    expect(String(mockSendMessage.mock.calls[0][1])).toContain('Answer recorded');
  });

  it('an 8-char short ref (the DM style — id chars after oq_) resolves the row', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer eeff0011 yes, approve it', {});
    expect(handled).toBe(true);
    expect(mockAnswer).toHaveBeenCalledWith(Q2.id, U, 'yes, approve it');
  });

  it('a full oq_ id resolves too', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, `answer ${Q2.id} 2`, {});
    expect(handled).toBe(true);
    expect(mockAnswer).toHaveBeenCalledWith(Q2.id, U, '2'); // option-number answers ride the same path
  });

  it("bare 'answer' lists the open questions with refs and numbers", async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer', {});
    expect(handled).toBe(true);
    expect(mockAnswer).not.toHaveBeenCalled();
    const listing = String(mockSendMessage.mock.calls[0][1]);
    expect(listing).toContain('1. [aabbccdd]');
    expect(listing).toContain('2. [eeff0011]');
  });

  it('an unknown ref is a helpful refusal, never a silent chat-pipeline pass-through', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer 99999999 whatever', {});
    expect(handled).toBe(true);
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(String(mockSendMessage.mock.calls[0][1])).toContain('No open question matches');
  });

  it('a question already closed on another surface answers honestly', async () => {
    mockAnswer.mockResolvedValue('not_open');
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer 1 go', {});
    expect(handled).toBe(true);
    expect(String(mockSendMessage.mock.calls[0][1])).toContain('no longer open');
  });

  it('todo 0dd7d3f2: reply_recorded (choice/yes_no mismatch) says the reply went through — never the credential message', async () => {
    // Specimen oq_17b85b72: a typed reply on a CHOICE card over Telegram got
    // "that question needs a credential" — wrong class entirely. The reply WAS
    // delivered to the asking chat; only the resolution is refused.
    mockAnswer.mockResolvedValue('reply_recorded' as any);
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer 1 not an option, but here is why', {});
    expect(handled).toBe(true);
    const msg = String(mockSendMessage.mock.calls[0][1]);
    expect(msg).toContain('Sent to the chat as a reply');
    expect(msg).not.toContain('needs a credential');
  });

  it('ticket 238c9e2a: the credential_pending DM names ALL three lift channels — the card key field too', async () => {
    // The pre-fix DM said "(store_secret / Account → Coding credentials)" —
    // 2 of 3 channels, missing the card's key field the owner can paste into
    // right from Management → Inbox. Mirrors ccc2e7ad's canonical channel
    // list (PR #1851).
    mockAnswer.mockResolvedValue('credential_pending' as any);
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer 1 use vLLM', {});
    expect(handled).toBe(true);
    const msg = String(mockSendMessage.mock.calls[0][1]);
    expect(msg).toContain('needs a credential');
    // All three channels, in the owner-facing DM.
    expect(msg).toContain('the key field on the card in Management → Inbox, store_secret or Account → Coding credentials');
    // The 2-of-3 fragment is gone.
    expect(msg).not.toContain('store_secret / Account → Coding credentials');
  });

  it('ticket 238c9e2a: the credential reply_recorded DM also names all three channels (review N2)', async () => {
    // The reviewer found the reply_recorded-on-a-credential-gate DM two
    // lines up carried the same 2-of-3 class ("the key field on the card in
    // Management → Inbox, or store_secret") — same fix class, same file.
    mockAnswer.mockResolvedValue('reply_recorded' as any);
    const credentialQ = { ...Q1, expectedAnswerType: 'credential:SCHOOLTIME_API_KEY' };
    mockListOpen.mockResolvedValue([credentialQ]);
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer 1 here is why not', {});
    expect(handled).toBe(true);
    const msg = String(mockSendMessage.mock.calls[0][1]);
    expect(msg).toContain('still needs the KEY itself');
    expect(msg).toContain('the key field on the card in Management → Inbox, store_secret or Account → Coding credentials');
    expect(msg).not.toContain('Management → Inbox, or store_secret)');
  });
});

describe('bare reply to the decision DM', () => {
  const decisionDm = { reply_to_message: { text: '⚠️ Digby needs your decision:\n\nWhich serving engine should the bench use?\n\nAnswer in Digby…' } };

  it('a reply to the decision DM with exactly ONE open question closes it', async () => {
    mockListOpen.mockResolvedValue([Q1]);
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'vLLM please', decisionDm);
    expect(handled).toBe(true);
    expect(mockAnswer).toHaveBeenCalledWith(Q1.id, U, 'vLLM please');
  });

  it('with SEVERAL open questions, the quoted question text disambiguates', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'vLLM please', decisionDm);
    expect(handled).toBe(true);
    expect(mockAnswer).toHaveBeenCalledWith(Q1.id, U, 'vLLM please'); // Q1's text is in the replied DM
  });

  it('an ambiguous reply (no quoted match, several open) asks for the command form instead of guessing', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'yes', {
      reply_to_message: { text: '⚠️ Digby needs your decision:\n\nSomething entirely different?' },
    });
    expect(handled).toBe(true);
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(String(mockSendMessage.mock.calls[0][1])).toContain('answer <number|ref>');
  });

  it('a NORMAL chat message (no reply, no command) falls through to the pipeline', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'what is the weather in Vancouver?', {});
    expect(handled).toBe(false);
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('a reply to a NON-decision bot message falls through too', async () => {
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'thanks!', {
      reply_to_message: { text: 'Here is your weather report…' },
    });
    expect(handled).toBe(false);
  });
});

describe('supervisor-first triage (review 2026-09-13 issue 11)', () => {
  it("the Telegram answer router uses the DEFAULT owner-question listing — rows in supervisor triage are hidden (userId only, never includeTriaged)", async () => {
    await tryAnswerOwnerQuestionFromTelegram(U, TG, 'answer', {});
    expect(mockListOpen).toHaveBeenCalledTimes(1);
    expect(mockListOpen).toHaveBeenCalledWith(U);
    expect(mockListOpen.mock.calls[0]).toHaveLength(1);
  });

  it('the surfaced (held-for-supervisor) DM still carries the decision marker, so a bare reply to it is routed as an answer', async () => {
    mockListOpen.mockResolvedValue([Q1]);
    const handled = await tryAnswerOwnerQuestionFromTelegram(U, TG, 'use vLLM', {
      reply_to_message: {
        text: `⚠️ Digby needs your decision:\n(Held for the Fleet Supervisor first — it did not answer within the triage window, so this one is yours.)\n\n${Q1.question}`,
      },
    });
    expect(handled).toBe(true);
    expect(mockAnswer).toHaveBeenCalledWith(Q1.id, U, 'use vLLM');
  });
});
