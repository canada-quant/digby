/**
 * MISHAP REPLAY — ticket 1769c8d1 (2026-09-27): "Per-chat $12/day spend cap
 * skips project-supervisor schedules despite owner's pre-approved-budget
 * directive."
 *
 * THE MISHAP, as it actually happened (live evidence, box A probe 2026-09-27):
 * a hidden CHAT-level spend cap ($12/day) was written on the spark-cluster
 * project-supervisor chat (store row 9e6e1712…:settings/state, created
 * 18:01:47Z) — by an automated audit redirect, NOT by the owner. The sweeper
 * skipped the supervisor's firings on it (`skipped:spend_cap`) while no
 * surface could name the cap. The owner's ruling (2026-09-27, verbatim):
 * "there should be no cost caps anywhere in the framework at all unless set
 * by a user at the project settings level."
 *
 * THE FIX pins (each replays one leg of the mishap):
 *   1. The chat-level cap NO LONGER EXISTS: the exact mishap row is never
 *      read — a leftover row produces spendCapUsdPerDay null, no verdict, no
 *      skip, and the ledger is not consulted.
 *   2. Nothing in the module can WRITE a chat cap (setChatSpendCap is gone).
 *   3. The ONE resolver (getLaneSpendCap) answers from the PROJECT's user-set
 *      spendCapUsdPerDay only; the retired env defaults are dead.
 *   4. The skip notice and the owner card describe the project cap only — a
 *      retired parked verdict is discarded, a retired verdict shape never
 *      files a card.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ projectId: null }));
const mockQueryRaw = jest.fn(async (..._a: any[]): Promise<any> => [{ chat_usd: 0, project_usd: 0, chat_coding_usd: 0, project_coding_usd: 0 }]);
const mockContextStoreFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockContextStoreUpsert = jest.fn(async (..._a: any[]) => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    contextStoreEntry: {
      findUnique: (...a: any[]) => mockContextStoreFindUnique(...a),
      upsert: (...a: any[]) => mockContextStoreUpsert(...a),
    },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
  },
}));

const mockRedisGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRedisSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
const mockRedisDel = jest.fn(async (..._a: any[]): Promise<any> => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));

const mockGetMergedProjectStoreState = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../platform/folder-inheritance', () => ({
  __esModule: true,
  getMergedProjectStoreState: (...a: any[]) => mockGetMergedProjectStoreState(...a),
}));

const mockFlagOwnerQuestion = jest.fn(async (..._a: any[]): Promise<any> => ({ kind: 'created', question: { id: 'oq_1' } }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));

import * as spendCap from './spend-cap.service';
import {
  checkSpendCap, getLaneSpendCap, maybeAskSpendCapQuestion, spendSkipNoticeText,
  readParkedSpendCapVerdict, SPEND_CAP_CARD_KEY,
} from './spend-cap.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockChatFindUnique.mockResolvedValue({ projectId: null });
  mockQueryRaw.mockResolvedValue([{ chat_usd: 0, project_usd: 0, chat_coding_usd: 0, project_coding_usd: 0 }]);
  mockContextStoreFindUnique.mockResolvedValue(null);
  mockGetMergedProjectStoreState.mockResolvedValue(null);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  delete process.env.SPEND_CAP_DISABLED;
  delete process.env.SPEND_CAP_USD_PER_LANE_DAY;
});

/** The live mishap shape: a $12 chat-level settings row, all-profile spend over it, the chat filed in a project WITHOUT a cap. */
const mishapRow = () => mockContextStoreFindUnique.mockResolvedValue({ value: { spendCapUsdPerDay: 12 }, expiresAt: null });
const overCapSpend = () => mockQueryRaw.mockResolvedValue([{ chat_usd: 15.71, project_usd: 15.71, chat_coding_usd: 0, project_coding_usd: 0 }]);

describe('1769c8d1 — the hidden per-chat cap no longer exists', () => {
  it('replay: the exact mishap row (a $12/day chat settings row on the spark-cluster supervisor) produces NO cap, NO verdict and NO skip — the row is never read', async () => {
    mishapRow();
    overCapSpend();
    mockChatFindUnique.mockResolvedValue({ projectId: '0560b7b8' });
    await expect(getLaneSpendCap('9e6e1712')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null, projectId: '0560b7b8' });
    expect(await checkSpendCap('9e6e1712')).toBeNull();
    expect(mockContextStoreFindUnique).not.toHaveBeenCalled();
    expect(mockQueryRaw).not.toHaveBeenCalled(); // no cap ⇒ the ledger is never consulted
  });

  it('nothing can write a chat cap any more: setChatSpendCap / getChatSpendCap are not exported and the store row is never upserted', async () => {
    expect((spendCap as any).setChatSpendCap).toBeUndefined();
    expect((spendCap as any).getChatSpendCap).toBeUndefined();
    mishapRow();
    await checkSpendCap('9e6e1712');
    expect(mockContextStoreUpsert).not.toHaveBeenCalled();
  });

  it('the ONE resolver answers from the PROJECT settings only: a user-set project cap resolves with source project; the retired env defaults are dead', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: 25 });
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: 25, spendCapSource: 'project', projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue(null);
    process.env.SPEND_CAP_USD_PER_LANE_DAY = '25';
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null, projectId: 'p1' });
  });

  it('a store read error fail-opens (a hiccup must never invent a cap)', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockRejectedValue(new Error('store down'));
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null });
  });

  it('notice: a parked verdict from the retired chat scope is DISCARDED; the cap-less line names the project cap as the only cost cap', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ scope: 'chat', capUsd: 12, spentUsd: 15.71, at: '2026-09-27T18:42:23.619Z' }));
    expect(await readParkedSpendCapVerdict('9e6e1712')).toBeNull();
    const text = spendSkipNoticeText(1, null);
    expect(text).toContain('the only cost cap in the framework');
    expect(text).not.toContain('$12');
    expect(text).not.toMatch(/CHAT's spendCapUsdPerDay|chat cap/);
  });

  it('owner card: a retired chat-scope verdict NEVER files a card; a project-cap verdict files once, and a refused / thrown flag releases the 7-day window', async () => {
    await maybeAskSpendCapQuestion('9e6e1712', 'u1', { scope: 'chat', capUsd: 12, spentUsd: 15.71 } as any);
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    const project = { scope: 'project' as const, capUsd: 25, spentUsd: 31.4 };
    mockFlagOwnerQuestion.mockResolvedValue({ kind: 'refused', refused: 'cap' });
    await maybeAskSpendCapQuestion('9e6e1712', 'u1', project);
    expect(mockRedisSet).toHaveBeenCalledWith(SPEND_CAP_CARD_KEY('9e6e1712'), expect.any(String), expect.objectContaining({ NX: true, EX: 7 * 24 * 3600 }));
    expect(mockRedisDel).toHaveBeenCalledWith(SPEND_CAP_CARD_KEY('9e6e1712'));
    mockRedisDel.mockClear();
    mockFlagOwnerQuestion.mockResolvedValue({ kind: 'created', question: { id: 'oq_new' } });
    await maybeAskSpendCapQuestion('9e6e1712', 'u1', project);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});
