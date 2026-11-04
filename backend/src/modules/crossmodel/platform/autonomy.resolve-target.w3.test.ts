/**
 * audit 2026-10-08 W3-3: the autonomy gate's resolveChatTarget heals exactly
 * what the executor heals (a suffix, a prefix+suffix splice) — the 2026-09-14
 * "keep the two resolvers in step" rule — owner-scoped, ambiguity fails closed.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const CHATS = [
  { id: '0037460b-d239-474e-bd32-5fe3ec52d820', userId: 'owner-1', parentChatId: '41bd202a-7152-437e-bf4b-a097981692b1' },
  { id: '0037460b-1111-4222-8333-944444444444', userId: 'owner-1', parentChatId: null },
  { id: '99999999-0000-4000-8000-0000ec52d821', userId: 'someone-else', parentChatId: null },
];
const matches = (row: any, where: any) =>
  (where.userId === undefined || row.userId === where.userId)
  && (where.id?.startsWith === undefined || row.id.startsWith(where.id.startsWith))
  && (where.id?.endsWith === undefined || row.id.endsWith(where.id.endsWith));
const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => CHATS.find((c) => c.id === where.id) ?? null),
    findMany: jest.fn(async ({ where, take }: any) => CHATS.filter((c) => matches(c, where)).slice(0, take ?? 50).map((c) => ({ ...c }))),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../middleware/error-handler', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
  },
}));
jest.mock('./loop-metrics.service', () => ({ recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }) }));
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn() } }));

import { resolveChatTarget } from './autonomy.service';

afterEach(() => { delete process.env.ID_RESOLVER_HEAL_DISABLED; });

describe('resolveChatTarget heal (audit 2026-10-08 W3-3)', () => {
  it.each(['0037460b-ec52d820', '…ec52d820', '0037460b-b60b-456e-977f-a3127ec52d820'])('%s resolves to the owner\'s chat with its parent', async (typed) => {
    await expect(resolveChatTarget('owner-1', typed)).resolves.toEqual({
      id: '0037460b-d239-474e-bd32-5fe3ec52d820', parentChatId: '41bd202a-7152-437e-bf4b-a097981692b1', userId: 'owner-1',
    });
  });

  it('ambiguous prefix fails closed; a foreign chat is never reached through a tail; kill switch restores null', async () => {
    await expect(resolveChatTarget('owner-1', '0037460b')).resolves.toBeNull();
    await expect(resolveChatTarget('owner-1', '…ec52d821')).resolves.toBeNull();
    process.env.ID_RESOLVER_HEAL_DISABLED = '1';
    await expect(resolveChatTarget('owner-1', '0037460b-ec52d820')).resolves.toBeNull();
  });
});
