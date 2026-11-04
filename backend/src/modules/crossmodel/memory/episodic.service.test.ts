/**
 * Tests for episodic.service.ts — past-conversation cue gate + block assembly.
 * Prisma / logger mocked; no DB required.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $queryRawUnsafe: jest.fn() },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import { referencesPastConversation, buildEpisodicBlock } from './episodic.service';

const mockedPrisma = prisma as unknown as { $queryRawUnsafe: jest.Mock };

beforeEach(() => jest.clearAllMocks());

describe('referencesPastConversation', () => {
  test.each([
    'what did we discuss last week about the boat engine?',
    'you told me a lighthouse fact before',
    'like we discussed earlier, continue the plan',
    'in a previous chat you gave me a recipe',
    'remember when we went over the budget?',
    'pick up where we left off',
    'What did you tell me about HNSW indexes?',
  ])('cues fire: %s', msg => {
    expect(referencesPastConversation(msg)).toBe(true);
  });

  test.each([
    'what is the tallest lighthouse in Canada?',
    'write me a poem about the sea',
    'my last name is Smith', // "last" alone is not a cue
    'this chat is great',
    'lets talk about conversations in general',
  ])('no cue: %s', msg => {
    expect(referencesPastConversation(msg)).toBe(false);
  });
});

describe('buildEpisodicBlock', () => {
  test('returns empty without a cue — no DB query', async () => {
    const block = await buildEpisodicBlock('u1', 'what is 2+2?', null);
    expect(block).toBe('');
    expect(mockedPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('formats top hits, one per chat, most-relevant first', async () => {
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([
      { chatId: 'c1', chatTitle: 'Boat repairs', role: 'assistant', content: 'The engine needs a new impeller before spring.', createdAt: new Date('2026-07-01'), rank: 0.9 },
      { chatId: 'c1', chatTitle: 'Boat repairs', role: 'user', content: 'dup chat hit', createdAt: new Date('2026-07-01'), rank: 0.8 },
      { chatId: 'c2', chatTitle: 'Budget', role: 'user', content: 'We planned 2k for the boat.', createdAt: new Date('2026-06-20'), rank: 0.5 },
    ]);
    const block = await buildEpisodicBlock('u1', 'what did we discuss about the boat engine?', 'current-chat');
    expect(block).toContain('[RELATED PAST CONVERSATIONS');
    expect(block).toContain('Boat repairs');
    expect(block).toContain('impeller');
    expect(block).toContain('Budget');
    expect(block).not.toContain('dup chat hit'); // one snippet per chat
    // excludeChatId is passed through to the query params
    expect(mockedPrisma.$queryRawUnsafe.mock.calls[0].slice(1)).toContain('current-chat');
  });

  test('returns empty on zero hits and on DB failure', async () => {
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([]);
    expect(await buildEpisodicBlock('u1', 'what did we discuss before?', null)).toBe('');

    mockedPrisma.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
    expect(await buildEpisodicBlock('u1', 'what did we discuss before?', null)).toBe('');
  });
});
