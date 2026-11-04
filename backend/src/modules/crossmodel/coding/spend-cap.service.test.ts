/**
 * Spend cap — the ONE cost cap (ProjectSettings.spendCapUsdPerDay, user-set):
 * cap resolution, trailing-spend math, skip-notice channel, owner-card dedupe.
 *
 * THE REGRESSION PIN (owner directive 2026-09-27, "there should be no cost
 * caps anywhere in the framework at all unless set by a user at the project
 * settings level"): with NO project cap, a leftover chat-level settings row,
 * any env variable and any default must all produce spendCapUsdPerDay null and
 * NO skip — and the spend ledger is never even read.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ projectId: null }));
const mockAggregate = jest.fn(async (..._a: any[]): Promise<any> => ({ _sum: { value: 0 } }));
const mockQueryRaw = jest.fn(async (..._a: any[]): Promise<any> => [{ chat_usd: 0, project_usd: 0, chat_coding_usd: 0, project_coding_usd: 0 }]);
// A row where the coding slice equals the total = a pure coding lane.
const codingOnlyRow = (chatUsd: number, projectUsd?: number) => [{
  chat_usd: chatUsd, chat_coding_usd: chatUsd,
  ...(projectUsd === undefined ? {} : { project_usd: projectUsd, project_coding_usd: projectUsd }),
}];
// The context-store row a LEFTOVER chat cap would live in — must never be read.
const mockContextStoreFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockContextStoreUpsert = jest.fn(async (..._a: any[]) => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    loopMetric: { aggregate: (...a: any[]) => mockAggregate(...a) },
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
const mockRedisIncr = jest.fn(async (..._a: any[]) => 1);
const mockRedisIncrBy = jest.fn(async (..._a: any[]) => 1);
const mockRedisGetDel = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRedisExpire = jest.fn(async (..._a: any[]) => {});
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
    incr: (...a: any[]) => mockRedisIncr(...a),
    incrBy: (...a: any[]) => mockRedisIncrBy(...a),
    getDel: (...a: any[]) => mockRedisGetDel(...a),
    expire: (...a: any[]) => mockRedisExpire(...a),
  },
}));

// Project settings via the LIGHT leaf (folder inheritance) — mocked as a boundary.
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
  checkSpendCap, getLaneSpendCap, trailingSpend24h, trailingProjectSpend24h,
  recordSpendCapSkip, consumeSpendCapSkipNotice, restoreSpendCapSkipNotice,
  maybeAskSpendCapQuestion, spendSkipNoticeText, readParkedSpendCapVerdict,
  SPEND_CACHE_KEY, SPEND_SKIP_KEY, SPEND_CAP_CARD_KEY, SPEND_CAP_VERDICT_KEY,
} from './spend-cap.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockChatFindUnique.mockResolvedValue({ projectId: null });
  mockAggregate.mockResolvedValue({ _sum: { value: 0 } });
  mockQueryRaw.mockResolvedValue([{ chat_usd: 0, project_usd: 0, chat_coding_usd: 0, project_coding_usd: 0 }]);
  mockContextStoreFindUnique.mockResolvedValue(null);
  mockGetMergedProjectStoreState.mockResolvedValue(null);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  delete process.env.SPEND_CAP_DISABLED;
  delete process.env.SPEND_CAP_USD_PER_LANE_DAY;
  delete process.env.DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD;
});

describe('NO CAP WHEN NO PROJECT CAP IS SET — the owner-directive regression pin (2026-09-27)', () => {
  it('no project cap ⇒ getLaneSpendCap {null, null} and checkSpendCap null, and the spend ledger is NEVER read', async () => {
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null, projectId: null });
    expect(await checkSpendCap('chat-1')).toBeNull();
    expect(mockAggregate).not.toHaveBeenCalled();
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('a LEFTOVER chat-level settings row ($12/day — the 1769c8d1 mishap row) is IGNORED: never read, never a cap, never a skip', async () => {
    mockContextStoreFindUnique.mockResolvedValue({ value: { spendCapUsdPerDay: 12 }, expiresAt: null });
    mockQueryRaw.mockResolvedValue([{ chat_usd: 15.71, chat_coding_usd: 0 }]);
    await expect(getLaneSpendCap('9e6e1712')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null, projectId: null });
    expect(await checkSpendCap('9e6e1712')).toBeNull();
    expect(mockContextStoreFindUnique).not.toHaveBeenCalled();
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('the retired env defaults (SPEND_CAP_USD_PER_LANE_DAY, DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD) produce NO cap even with heavy spend', async () => {
    process.env.SPEND_CAP_USD_PER_LANE_DAY = '5';
    process.env.DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD = '25';
    mockQueryRaw.mockResolvedValue(codingOnlyRow(400, 310.5));
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null, projectId: 'p1' });
    expect(await checkSpendCap('chat-1')).toBeNull();
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('a leftover chat row + a project WITHOUT a cap still ⇒ no cap (the project settings are the only place a cap can come from)', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ codingModel: 'glm-5.3' }); // settings exist, no cap key
    mockContextStoreFindUnique.mockResolvedValue({ value: { spendCapUsdPerDay: 12 }, expiresAt: null });
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null, projectId: 'p1' });
    expect(await checkSpendCap('chat-1')).toBeNull();
    expect(mockContextStoreFindUnique).not.toHaveBeenCalled();
  });

  it('the module exports NO chat-cap reader or writer (getChatSpendCap / setChatSpendCap / globalLaneSpendCapUsdPerDay are gone)', () => {
    expect((spendCap as any).getChatSpendCap).toBeUndefined();
    expect((spendCap as any).setChatSpendCap).toBeUndefined();
    expect((spendCap as any).globalLaneSpendCapUsdPerDay).toBeUndefined();
  });

  it('SPEND_CAP_DISABLED=1 bypasses even a set project cap without any read', async () => {
    process.env.SPEND_CAP_DISABLED = '1';
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: 1 });
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null });
    expect(await checkSpendCap('chat-1')).toBeNull();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    expect(mockGetMergedProjectStoreState).not.toHaveBeenCalled();
  });
});

describe('the PROJECT cap (user-set) — the one cap that exists', () => {
  it('getLaneSpendCap resolves the folder-inherited project cap with source project', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: 25 });
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: 25, spendCapSource: 'project', projectId: 'p1' });
    expect(mockGetMergedProjectStoreState).toHaveBeenCalledWith('p1', 'settings');
  });

  it('type-guards stored garbage to null (no cap)', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    for (const bad of ['lots', -3, 0, null, undefined]) {
      mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: bad });
      await expect(getLaneSpendCap('chat-1')).resolves.toMatchObject({ spendCapUsdPerDay: null, spendCapSource: null });
    }
  });

  it('over the project cap on the PROJECT trailing sum ⇒ verdict scope project; under ⇒ null', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: 25 });
    mockQueryRaw.mockResolvedValue(codingOnlyRow(3, 31.4));
    expect(await checkSpendCap('chat-1')).toEqual({ scope: 'project', capUsd: 25, spentUsd: 31.4 });
    mockRedisGet.mockResolvedValue(null);
    mockQueryRaw.mockResolvedValue(codingOnlyRow(3, 24.9));
    expect(await checkSpendCap('chat-1')).toBeNull();
  });

  it('an explicit project cap binds on the ALL-profile project sum (chat / supervisor lanes are metered too)', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: 25 });
    mockQueryRaw.mockResolvedValue([{ chat_usd: 1, project_usd: 30, chat_coding_usd: 1, project_coding_usd: 20 }]);
    expect(await checkSpendCap('chat-1')).toEqual({ scope: 'project', capUsd: 25, spentUsd: 30 });
  });

  it('a set project cap PARKS the verdict so the skip notice can name it; a parked verdict with a retired scope is discarded', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockResolvedValue({ spendCapUsdPerDay: 25 });
    mockQueryRaw.mockResolvedValue(codingOnlyRow(3, 31.4));
    await checkSpendCap('chat-1');
    expect(mockRedisSet).toHaveBeenCalledWith(SPEND_CAP_VERDICT_KEY('chat-1'), expect.stringContaining('"scope":"project"'), expect.objectContaining({ EX: 24 * 3600 }));
    mockRedisGet.mockResolvedValue(JSON.stringify({ scope: 'project', capUsd: 25, spentUsd: 31.4, at: 't' }));
    expect(await readParkedSpendCapVerdict('chat-1')).toMatchObject({ scope: 'project', capUsd: 25 });
    mockRedisGet.mockResolvedValue(JSON.stringify({ scope: 'chat', capUsd: 12, spentUsd: 15.71, at: 't' }));
    expect(await readParkedSpendCapVerdict('chat-1')).toBeNull();
    mockRedisGet.mockResolvedValue(JSON.stringify({ scope: 'global', capUsd: 5, spentUsd: 6, at: 't' }));
    expect(await readParkedSpendCapVerdict('chat-1')).toBeNull();
  });

  it('every read failure fails OPEN (null, never a throw, never a cap)', async () => {
    mockChatFindUnique.mockRejectedValue(new Error('db down'));
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null });
    expect(await checkSpendCap('chat-1')).toBeNull();
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockGetMergedProjectStoreState.mockRejectedValue(new Error('store down'));
    await expect(getLaneSpendCap('chat-1')).resolves.toEqual({ spendCapUsdPerDay: null, spendCapSource: null });
  });
});

describe('trailing spend (grouped query + 5-min cache)', () => {
  it('projectless chats run ONE raw query (the JSON profile split rides it); the result caches under the chat key', async () => {
    mockQueryRaw.mockResolvedValue([{ chat_usd: 4.2, chat_coding_usd: 3.1 }]);
    const s = await trailingSpend24h('chat-1');
    expect(s).toEqual({ chatUsd: 4.2, projectUsd: null, projectId: null, chatCodingUsd: 3.1, projectCodingUsd: null });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockAggregate).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledWith(SPEND_CACHE_KEY('chat-1'), JSON.stringify(s), { EX: 300 });
  });

  it('a cached value short-circuits the DB entirely', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ chatUsd: 7, projectUsd: 9, projectId: 'p1', chatCodingUsd: 7, projectCodingUsd: 9 }));
    const s = await trailingSpend24h('chat-1');
    expect(s.chatUsd).toBe(7);
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('a pre-split cache row (no coding slice) is a MISS, never a stale shape', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ chatUsd: 7, projectUsd: 9, projectId: 'p1' }));
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockQueryRaw.mockResolvedValue([{ chat_usd: 1, project_usd: 2, chat_coding_usd: 1, project_coding_usd: 2 }]);
    const s = await trailingSpend24h('chat-1');
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(s).toEqual({ chatUsd: 1, projectUsd: 2, projectId: 'p1', chatCodingUsd: 1, projectCodingUsd: 2 });
  });

  it('project chats run the ONE grouped raw query (chat + project sums together, both slices) and the SQL splits on meta.profile', async () => {
    mockChatFindUnique.mockResolvedValue({ projectId: 'p1' });
    mockQueryRaw.mockResolvedValue([{ chat_usd: 1.5, project_usd: 8, chat_coding_usd: 1.5, project_coding_usd: 6 }]);
    const s = await trailingSpend24h('chat-1');
    expect(s).toEqual({ chatUsd: 1.5, projectUsd: 8, projectId: 'p1', chatCodingUsd: 1.5, projectCodingUsd: 6 });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = (mockQueryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain(`COALESCE(lm."meta"->>'profile', 'coding') = 'coding'`);
    expect(sql).toContain(`lm."kind" = 'run_spend'`);
  });

  it('fail-open zeros carry the coding slice too', async () => {
    mockChatFindUnique.mockRejectedValue(new Error('db down'));
    expect(await trailingSpend24h('chat-1')).toEqual({ chatUsd: 0, projectUsd: null, projectId: null, chatCodingUsd: 0, projectCodingUsd: null });
  });
});

describe('trailingProjectSpend24h (WI-O #7 — the get_project read-back figure)', () => {
  it('sums run_spend over every chat filed in the project and counts the runs; caches under the project key', async () => {
    mockQueryRaw.mockResolvedValue([{ usd: 3.5, runs: 7 }]);
    const s = await trailingProjectSpend24h('p1');
    expect(s).toEqual({ usd: 3.5, runs: 7 });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledWith(`${SPEND_CACHE_KEY('p1')}:project`, JSON.stringify(s), { EX: 300 });
  });

  it('a cached value short-circuits the DB; a malformed cache entry is a miss', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ usd: 1, runs: 2 }));
    expect(await trailingProjectSpend24h('p1')).toEqual({ usd: 1, runs: 2 });
    expect(mockQueryRaw).not.toHaveBeenCalled();
    mockRedisGet.mockResolvedValue(JSON.stringify({ chatUsd: 1 }));
    mockQueryRaw.mockResolvedValue([{ usd: 0, runs: 0 }]);
    expect(await trailingProjectSpend24h('p1')).toEqual({ usd: 0, runs: 0 });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('a read failure reports null (unknown) — never a fail-open $0 the way the cap check does', async () => {
    mockQueryRaw.mockRejectedValue(new Error('db down'));
    expect(await trailingProjectSpend24h('p1')).toBeNull();
  });
});

describe('spend-skip notice channel (the P3 cap-skip contract, spend flavor)', () => {
  it('record INCRs with a TTL on first; consume GETDELs; restore INCRBYs back', async () => {
    await recordSpendCapSkip('chat-1');
    expect(mockRedisIncr).toHaveBeenCalledWith(SPEND_SKIP_KEY('chat-1'));
    expect(mockRedisExpire).toHaveBeenCalled();
    mockRedisGetDel.mockResolvedValue('3');
    expect(await consumeSpendCapSkipNotice('chat-1')).toBe(3);
    await restoreSpendCapSkipNotice('chat-1', 3);
    expect(mockRedisIncrBy).toHaveBeenCalledWith(SPEND_SKIP_KEY('chat-1'), 3);
  });

  it('the notice text names the PROJECT spend cap as the only cost cap (never the daily firing cap, never a chat cap)', () => {
    const plain = spendSkipNoticeText(2);
    expect(plain).toContain('project spend cap');
    expect(plain).toContain('the only cost cap in the framework');
    expect(plain).not.toContain('daily firing cap');
    expect(plain).not.toMatch(/CHAT's spendCapUsdPerDay|chat cap|SPEND_CAP_USD_PER_LANE_DAY|global/);
    const named = spendSkipNoticeText(4, { scope: 'project', capUsd: 25, spentUsd: 31.4 });
    expect(named).toContain('4 scheduled firing(s)');
    expect(named).toContain('$31.4 over the project cap $25/day');
    expect(named).toContain("PROJECT's spendCapUsdPerDay");
    expect(named).toContain('update_project');
  });
});

describe('owner decision card (ONE per chat per 7d) — project cap only', () => {
  const verdict = { scope: 'project' as const, capUsd: 25, spentUsd: 31.4 };

  it('files once behind the NX gate with raise/keep options, naming the PROJECT cap', async () => {
    await maybeAskSpendCapQuestion('chat-1', 'u1', verdict);
    expect(mockRedisSet).toHaveBeenCalledWith(SPEND_CAP_CARD_KEY('chat-1'), expect.any(String), expect.objectContaining({ NX: true, EX: 7 * 24 * 3600 }));
    expect(mockFlagOwnerQuestion).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1', userId: 'u1', machineTriggered: true,
      question: expect.stringMatching(/PROJECT spend cap.*Raise the cap or keep it\?/),
      options: [
        expect.objectContaining({ id: 'raise' }),
        expect.objectContaining({ id: 'keep' }),
      ],
    }));
    const ctx = mockFlagOwnerQuestion.mock.calls[0][0].context as string;
    expect(ctx).not.toMatch(/chat's settings|SPEND_CAP_USD_PER_LANE_DAY/);
  });

  it('a non-project verdict shape (a retired chat/global cap) NEVER files a card', async () => {
    await maybeAskSpendCapQuestion('chat-1', 'u1', { scope: 'chat', capUsd: 12, spentUsd: 15.71 } as any);
    await maybeAskSpendCapQuestion('chat-1', 'u1', { scope: 'global', capUsd: 5, spentUsd: 6 } as any);
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('a second call inside the window is deduped (no second card)', async () => {
    mockRedisSet.mockResolvedValue(null); // NX lost
    await maybeAskSpendCapQuestion('chat-1', 'u1', verdict);
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('a REFUSED or THROWN flagOwnerQuestion releases the 7-day window; a created / deduped card holds it', async () => {
    mockFlagOwnerQuestion.mockResolvedValue({ kind: 'refused', refused: 'cap' });
    await maybeAskSpendCapQuestion('chat-1', 'u1', verdict);
    expect(mockRedisDel).toHaveBeenCalledWith(SPEND_CAP_CARD_KEY('chat-1'));
    mockRedisDel.mockClear();
    mockFlagOwnerQuestion.mockRejectedValue(new Error('inbox down'));
    await expect(maybeAskSpendCapQuestion('chat-1', 'u1', verdict)).resolves.toBeUndefined();
    expect(mockRedisDel).toHaveBeenCalledWith(SPEND_CAP_CARD_KEY('chat-1'));
    mockRedisDel.mockClear();
    mockFlagOwnerQuestion.mockResolvedValue({ kind: 'deduped', question: { id: 'oq_prior' } });
    await maybeAskSpendCapQuestion('chat-1', 'u1', verdict);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});
