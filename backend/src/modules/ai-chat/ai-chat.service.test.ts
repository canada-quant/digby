/**
 * Admin dashboard AI Chat (backlog audit CT-7, 2026-09-28): the reply comes
 * from the Utility seat (utilityChat) — never a canned string. Pins: the
 * bounded history window + system prompt shape, the honest notice on an
 * empty / failed model answer.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/env', () => ({ env: { NODE_ENV: 'test' } }));
jest.mock('../../middleware/error-handler', () => ({
  AppError: class AppError extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));

const mockUtilityChat = jest.fn(async (..._a: any[]): Promise<any> => 'A real answer.');
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

const chatRow = { id: 'c1', title: 'T', userId: 'u1', messages: [] as any[], createdAt: new Date(), updatedAt: new Date() };
const mockFindUnique = jest.fn(async (..._a: any[]): Promise<any> => chatRow);
const mockUpdate = jest.fn(async (...a: any[]): Promise<any> => ({ id: 'c1', title: 'T', messages: a[0].data.messages, createdAt: new Date(), updatedAt: new Date() }));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: { aIChat: { findUnique: (...a: any[]) => mockFindUnique(...a), update: (...a: any[]) => mockUpdate(...a) } },
}));

import aiChatService, { AI_CHAT_HISTORY_MESSAGES, AI_CHAT_UNAVAILABLE_NOTICE, AI_CHAT_SYSTEM_PROMPT } from './ai-chat.service';

const CANNED = /interesting question|I'd suggest the following approach|my perspective on that|break this down for you/i;

beforeEach(() => {
  mockUtilityChat.mockClear().mockResolvedValue('A real answer.');
  chatRow.messages = [];
});

describe('AIChatService.addMessage — Utility seat reply', () => {
  test('the assistant turn is the utilityChat answer, with the system prompt + the user turn in the call', async () => {
    const r = await aiChatService.addMessage('c1', 'u1', { content: 'What is 2+2?' });
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const [messages, opts] = mockUtilityChat.mock.calls[0];
    expect(messages[0]).toEqual({ role: 'system', content: AI_CHAT_SYSTEM_PROMPT });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'What is 2+2?' });
    expect(opts).toMatchObject({ contentOnly: true });
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(r.messages[1].content).toBe('A real answer.');
    expect(r.messages[1].content).not.toMatch(CANNED);
  });

  test('the history window is bounded to the last AI_CHAT_HISTORY_MESSAGES turns (oldest dropped) and system rows in the stored transcript are skipped', async () => {
    chatRow.messages = [
      { role: 'system', content: 'legacy stored system row', timestamp: 't' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, timestamp: 't' })),
    ];
    await aiChatService.addMessage('c1', 'u1', { content: 'latest' });
    const [messages] = mockUtilityChat.mock.calls[0];
    expect(messages).toHaveLength(AI_CHAT_HISTORY_MESSAGES + 1); // + the system prompt
    expect(messages.some((m: any) => m.content === 'legacy stored system row')).toBe(false);
    expect(messages[1].content).toBe(`turn ${31 - AI_CHAT_HISTORY_MESSAGES}`); // oldest surviving turn
    expect(messages[messages.length - 1].content).toBe('latest');
  });

  test('an EMPTY model answer and a THROWING model both answer with the honest notice — never a canned string', async () => {
    mockUtilityChat.mockResolvedValueOnce('   ');
    let r = await aiChatService.addMessage('c1', 'u1', { content: 'hi' });
    expect(r.messages[1].content).toBe(AI_CHAT_UNAVAILABLE_NOTICE);
    chatRow.messages = [];
    mockUtilityChat.mockRejectedValueOnce(new Error('provider down'));
    r = await aiChatService.addMessage('c1', 'u1', { content: 'hi again' });
    expect(r.messages[1].content).toBe(AI_CHAT_UNAVAILABLE_NOTICE);
    expect(r.messages[1].content).not.toMatch(CANNED);
  });
});
