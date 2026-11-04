/**
 * Plain-chat confirmation-protocol rehydration — when a confirmation-gated
 * action is live for a chat, loadChatContext appends a [System note] carrying
 * the confirmationId to the last assistant message, so the NEXT turn's model
 * can complete the protocol after the user replies "confirm". Without it the
 * id evaporates (history reload carries role+content only) and the user gets
 * the infinite re-confirm loop (feedback 173ae516 / c506c9e6 / ccae359e).
 *
 * The registry module is used REAL against an in-memory pendingConfirmation
 * table (the testkit); the env-touching boundaries (config/database,
 * config/redis) are mocked so the suite never reaches config/env.
 */

const mockChatFindUnique = jest.fn();
const mockMessageFindMany = jest.fn();
const mockUserMemoryFindUnique = jest.fn();

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    crossModelMessage: { findMany: (...a: any[]) => mockMessageFindMany(...a) },
    userMemory: { findUnique: (...a: any[]) => mockUserMemoryFindUnique(...a) },
    // Deferred property access: this factory runs when context.service first
    // requires config/database (before mockConfirmations' const initializer
    // below), but the registry only touches pendingConfirmation at CALL time —
    // inside test bodies, after module init.
    pendingConfirmation: new Proxy({}, { get: (_t, p) => (mockConfirmations.api as any)[p] }),
  },
}));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), setEx: jest.fn(), del: jest.fn(), expire: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./memory-relevance', () => ({ filterFactsByRelevance: jest.fn(() => []) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn(), deleteAllFactRows: jest.fn() }));

import { ContextService } from './context.service';
import {
  CONFIRMATION_TTL_MS,
  registerPendingConfirmation,
} from './platform/pending-confirmations';
import { createPendingConfirmationTable } from './platform/pending-confirmations.testkit';

const mockConfirmations = createPendingConfirmationTable();

const USER = 'u1';

function seedHistory(rows: Array<{ role: string; content: string }>) {
  mockChatFindUnique.mockResolvedValue({ userId: USER });
  // Honor the query like the DB would (bounded newest-first fetch, 2026-09-14).
  const stamped = rows.map((r, i) => ({ ...r, id: `m${i}`, createdAt: new Date(i * 1000) }));
  mockMessageFindMany.mockImplementation(async (args: any) => {
    const ob = Array.isArray(args?.orderBy) ? args.orderBy[0] : args?.orderBy;
    const sorted = ob?.createdAt === 'desc' ? [...stamped].reverse() : stamped;
    return typeof args?.take === 'number' ? sorted.slice(0, args.take) : sorted;
  });
  mockUserMemoryFindUnique.mockResolvedValue(null);
}

describe('loadChatContext — pending-confirmation protocol note', () => {
  const svc = new ContextService();

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirmations.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('appends the note with the confirmationId to the LAST assistant message when a pending is live', async () => {
    const chat = 'chat-note-1';
    seedHistory([
      { role: 'user', content: 'schedule a ping for tomorrow' },
      { role: 'assistant', content: 'I can do that — please confirm.' },
      { role: 'user', content: 'confirm' },
    ]);
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: chat, userId: USER, tool: 'schedule_message',
      args: { chatId: chat, prompt: 'ping', kind: 'once', intervalMinutes: 1440 },
      summary: 'Schedule a one-time run of "ping" in 1440 min',
    });

    const ctx = await svc.loadChatContext(chat, USER, 'confirm');

    const assistantMsgs = ctx.conversationHistory.filter((m) => m.role === 'assistant');
    const noted = assistantMsgs[assistantMsgs.length - 1];
    expect(noted.content).toContain('[System note — action awaiting the user\'s confirmation');
    expect(noted.content).toContain(`confirmationId: "${confirmationId}"`);
    expect(noted.content).toContain('Tool: schedule_message');
    expect(noted.content).toContain('staged arguments execute exactly as summarized');
    // The user turns are untouched.
    expect(ctx.conversationHistory.filter((m) => m.role === 'user').every((m) => !m.content.includes('System note'))).toBe(true);
  });

  it('leaves history byte-identical when no pending exists for the chat', async () => {
    const chat = 'chat-note-2';
    seedHistory([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    const ctx = await svc.loadChatContext(chat, USER, 'hello');
    expect(ctx.conversationHistory.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });

  it('scopes the note to the owning chat only', async () => {
    const chat = 'chat-note-3';
    await registerPendingConfirmation({
      sessionId: 'chat-note-3-OTHER', userId: USER, tool: 'cancel_schedule', args: { id: 's1' }, summary: 'cancel s1',
    });
    seedHistory([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    const ctx = await svc.loadChatContext(chat, USER, 'hello');
    expect(ctx.conversationHistory.every((m) => !m.content.includes('System note'))).toBe(true);
  });

  it('no assistant message in history → no note, no crash', async () => {
    const chat = 'chat-note-4';
    await registerPendingConfirmation({
      sessionId: chat, userId: USER, tool: 'cancel_schedule', args: { id: 's1' }, summary: 'cancel s1',
    });
    seedHistory([{ role: 'user', content: 'confirm' }]);
    const ctx = await svc.loadChatContext(chat, USER, 'confirm');
    expect(ctx.conversationHistory).toHaveLength(1);
    expect(ctx.conversationHistory[0].content).toBe('confirm');
  });

  it('an EXPIRED pending produces no note', async () => {
    jest.useFakeTimers();
    const chat = 'chat-note-5';
    await registerPendingConfirmation({
      sessionId: chat, userId: USER, tool: 'cancel_schedule', args: { id: 's1' }, summary: 'cancel s1',
    });
    jest.advanceTimersByTime(CONFIRMATION_TTL_MS + 1);
    seedHistory([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'sure — confirm?' },
    ]);
    const ctx = await svc.loadChatContext(chat, USER, 'confirm');
    expect(ctx.conversationHistory.every((m) => !m.content.includes('System note'))).toBe(true);
  });
});
