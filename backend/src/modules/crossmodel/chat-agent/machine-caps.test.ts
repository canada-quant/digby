/**
 * machine-caps.ts — the governing caps stamped on a machine wake's
 * compute_policy row (audit 2026-09-26 supervisors-auto-4, fix 3). Fail-open,
 * bounded, never throws: each reader is independent and anything that errors
 * or runs past the timeout is omitted.
 *
 * Owner directive 2026-09-27 ("no cost caps anywhere in the framework unless
 * set by a user at the project settings level"): the spend field reads the ONE
 * resolver (getLaneSpendCap) — the user-set PROJECT cap or null; 'chat' /
 * 'global' scopes no longer exist and can never be stamped.
 */
const mockCapState = jest.fn();
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  capStateForSession: (...a: any[]) => mockCapState(...a),
}));
const mockSpendDisabled = jest.fn(() => false);
const mockLaneCap = jest.fn();
jest.mock('../coding/spend-cap.service', () => ({
  __esModule: true,
  spendCapDisabled: () => mockSpendDisabled(),
  getLaneSpendCap: (...a: any[]) => mockLaneCap(...a),
}));

import { readMachineCaps } from './machine-caps';

beforeEach(() => {
  jest.clearAllMocks();
  mockSpendDisabled.mockReturnValue(false);
  mockCapState.mockResolvedValue({ dailyFiresUsed: 17, dailyCapLimit: 480, capWindowResetsAt: '2026-09-27T00:00:00.000Z' });
  mockLaneCap.mockResolvedValue({ spendCapUsdPerDay: null, spendCapSource: null });
});

describe('readMachineCaps', () => {
  it('REGRESSION PIN (no cap when no project cap is set): stamps the daily firing counter + cap + reset and spendCapUsdPerDay null with NO scope when the resolver reports no cap', async () => {
    await expect(readMachineCaps('chat-1')).resolves.toEqual({
      dailyFirings: { used: 17, cap: 480, resetsAt: '2026-09-27T00:00:00.000Z' },
      spendCapUsdPerDay: null,
    });
    expect(mockCapState).toHaveBeenCalledWith('chat-1');
    expect(mockLaneCap).toHaveBeenCalledWith('chat-1');
  });
  it('a user-set PROJECT cap is stamped with scope project', async () => {
    mockLaneCap.mockResolvedValueOnce({ spendCapUsdPerDay: 25, spendCapSource: 'project', projectId: 'p1' });
    await expect(readMachineCaps('chat-2')).resolves.toMatchObject({ spendCapUsdPerDay: 25, spendCapScope: 'project' });
  });
  it('a resolver that still reports a retired scope (chat / global — a stale build) is stamped as NO cap: nothing but a project cap exists', async () => {
    mockLaneCap.mockResolvedValueOnce({ spendCapUsdPerDay: 12.5, spendCapSource: 'chat' });
    await expect(readMachineCaps('chat-2')).resolves.toEqual({ dailyFirings: expect.any(Object), spendCapUsdPerDay: null });
    mockLaneCap.mockResolvedValueOnce({ spendCapUsdPerDay: 30, spendCapSource: 'global' });
    const out = await readMachineCaps('chat-2');
    expect(out).toMatchObject({ spendCapUsdPerDay: null });
    expect(out).not.toHaveProperty('spendCapScope');
  });
  it('SPEND_CAP_DISABLED ⇒ spendCapUsdPerDay null without reading the resolver', async () => {
    mockSpendDisabled.mockReturnValue(true);
    mockLaneCap.mockResolvedValue({ spendCapUsdPerDay: 25, spendCapSource: 'project' });
    await expect(readMachineCaps('chat-3')).resolves.toMatchObject({ spendCapUsdPerDay: null });
    expect(mockLaneCap).not.toHaveBeenCalled();
  });
  it('an unreadable counter (Redis hiccup) reads used:null; a missing window omits resetsAt', async () => {
    mockCapState.mockResolvedValue({ dailyFiresUsed: null, dailyCapLimit: 48, capWindowResetsAt: null });
    await expect(readMachineCaps('chat-4')).resolves.toMatchObject({ dailyFirings: { used: null, cap: 48 } });
    expect((await readMachineCaps('chat-4'))!.dailyFirings).not.toHaveProperty('resetsAt');
  });
  it('fail-open per reader: a throwing cap reader omits dailyFirings only; a throwing spend reader omits the spend fields only; both ⇒ null', async () => {
    mockCapState.mockRejectedValue(new Error('redis down'));
    await expect(readMachineCaps('chat-5')).resolves.toEqual({ spendCapUsdPerDay: null });
    mockCapState.mockResolvedValue({ dailyFiresUsed: 1, dailyCapLimit: 48, capWindowResetsAt: null });
    mockLaneCap.mockRejectedValue(new Error('store down'));
    await expect(readMachineCaps('chat-5')).resolves.toEqual({ dailyFirings: { used: 1, cap: 48 } });
    mockCapState.mockRejectedValue(new Error('redis down'));
    await expect(readMachineCaps('chat-5')).resolves.toBeNull();
  });
  it('bounded: a reader slower than timeoutMs is omitted, the other still lands', async () => {
    mockCapState.mockImplementation(() => new Promise((res) => setTimeout(() => res({ dailyFiresUsed: 1, dailyCapLimit: 48, capWindowResetsAt: null }), 200)));
    await expect(readMachineCaps('chat-6', { timeoutMs: 20 })).resolves.toEqual({ spendCapUsdPerDay: null });
  });
  it('an empty chatId ⇒ null, no reads', async () => {
    await expect(readMachineCaps('')).resolves.toBeNull();
    expect(mockCapState).not.toHaveBeenCalled();
  });
});
