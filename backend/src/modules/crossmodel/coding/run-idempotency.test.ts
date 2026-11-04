/**
 * Audit #8 item 3 — idempotent push/PR on resume: the receipts-backed
 * pre-check the git_push / open_pull_request handlers consult. Everything
 * must FAIL OPEN (null/false) — the guard may only ever skip work it can
 * prove this run already did.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: { findFirst: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGetRunReceipts: jest.Mock = jest.fn(async () => []);
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => []);
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  getRunReceipts: (...a: any[]) => mockGetRunReceipts(...a),
  getRecentChatReceipts: (...a: any[]) => mockGetRecentChatReceipts(...a),
}));

const mockAxiosGet: jest.Mock = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { get: (...a: any[]) => mockAxiosGet(...a) } }));

import { findPriorRunPushReceipt, findPriorRunPrReceipt, prHeadMatchesReceipt, findRecentChatPrReceipts, prReceiptHeadState, prStateWarrantsSkip } from './run-idempotency';
import type { ToolReceipt } from './run-receipts';

const receipt = (over: Partial<ToolReceipt>): ToolReceipt => ({
  id: 'rcp-1', chatId: 's1', runId: 'run1', tool: 'git_push', ok: true,
  ids: {}, inputHash: null, outputHash: null, createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run1' });
});

describe('findPriorRunPushReceipt', () => {
  const PUSH = receipt({ tool: 'git_push', ids: { branch: 'digby/x', sha: 'abc123def456' } });

  it('matches a completed same-run push of the SAME branch + SAME sha', async () => {
    mockGetRunReceipts.mockResolvedValue([PUSH]);
    const r = await findPriorRunPushReceipt('s1', 'digby/x', 'abc123def456');
    expect(r?.id).toBe('rcp-1');
    // The run row lookup is scoped to THIS session's currently-running row.
    expect(mockPrisma.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 's1', status: 'running' },
    }));
    expect(mockGetRunReceipts).toHaveBeenCalledWith('run1');
  });

  it('a moved HEAD (new commits) never matches — genuinely new pushes are never suppressed', async () => {
    mockGetRunReceipts.mockResolvedValue([PUSH]);
    expect(await findPriorRunPushReceipt('s1', 'digby/x', 'NEWSHA999')).toBeNull();
  });

  it('a different branch never matches', async () => {
    mockGetRunReceipts.mockResolvedValue([PUSH]);
    expect(await findPriorRunPushReceipt('s1', 'digby/other', 'abc123def456')).toBeNull();
  });

  it('an ok:false (failed) push receipt exonerates nothing', async () => {
    mockGetRunReceipts.mockResolvedValue([receipt({ ok: false, ids: { branch: 'digby/x', sha: 'abc123def456' } })]);
    expect(await findPriorRunPushReceipt('s1', 'digby/x', 'abc123def456')).toBeNull();
  });

  it('a sha-less receipt (best-effort capture failed) never matches — uncertainty executes', async () => {
    mockGetRunReceipts.mockResolvedValue([receipt({ ids: { branch: 'digby/x' } })]);
    expect(await findPriorRunPushReceipt('s1', 'digby/x', 'abc123def456')).toBeNull();
  });

  it('no running agent_runs row (chat run / race) → null WITHOUT a receipts read', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue(null);
    expect(await findPriorRunPushReceipt('s1', 'digby/x', 'abc123def456')).toBeNull();
    expect(mockGetRunReceipts).not.toHaveBeenCalled();
  });

  it('a prisma error fails open to null', async () => {
    mockPrisma.agentRun.findFirst.mockRejectedValue(new Error('db down'));
    expect(await findPriorRunPushReceipt('s1', 'digby/x', 'abc123def456')).toBeNull();
  });
});

describe('findPriorRunPrReceipt', () => {
  it('returns the LATEST ok open_pull_request receipt carrying prNumber + url', async () => {
    mockGetRunReceipts.mockResolvedValue([
      receipt({ id: 'rcp-old', tool: 'open_pull_request', ids: { prNumber: 6, url: 'https://github.com/o/r/pull/6' } }),
      receipt({ id: 'rcp-push', tool: 'git_push', ids: { branch: 'b' } }),
      receipt({ id: 'rcp-new', tool: 'open_pull_request', ids: { prNumber: 7, url: 'https://github.com/o/r/pull/7' } }),
    ]);
    const r = await findPriorRunPrReceipt('s1');
    expect(r?.id).toBe('rcp-new');
    expect(r?.ids.prNumber).toBe(7);
  });

  it('skips ok:false and id-less PR receipts; none left → null', async () => {
    mockGetRunReceipts.mockResolvedValue([
      receipt({ tool: 'open_pull_request', ok: false, ids: { prNumber: 9, url: 'u' } }),
      receipt({ tool: 'open_pull_request', ids: {} }),
    ]);
    expect(await findPriorRunPrReceipt('s1')).toBeNull();
  });

  it('no running row → null', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue(null);
    expect(await findPriorRunPrReceipt('s1')).toBeNull();
  });
});

describe('prHeadMatchesReceipt (the "same head branch" verification)', () => {
  it('true only when GitHub confirms the receipt PR still has THIS head branch (and is still open — W2-5)', async () => {
    mockAxiosGet.mockResolvedValue({ data: { head: { ref: 'digby/x' }, state: 'open', merged: false } });
    expect(await prHeadMatchesReceipt('tok', 'o', 'r', 7, 'digby/x')).toBe(true);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://api.github.com/repos/o/r/pulls/7',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
  });

  it('a DIFFERENT head branch → false (a new feature branch gets its own PR)', async () => {
    mockAxiosGet.mockResolvedValue({ data: { head: { ref: 'digby/x' } } });
    expect(await prHeadMatchesReceipt('tok', 'o', 'r', 7, 'digby/feature-2')).toBe(false);
  });

  it('a GitHub error (404/network) fails open to false — the handler executes normally', async () => {
    mockAxiosGet.mockRejectedValue(new Error('404'));
    expect(await prHeadMatchesReceipt('tok', 'o', 'r', 7, 'digby/x')).toBe(false);
  });

  it('a garbage PR number never even calls GitHub', async () => {
    expect(await prHeadMatchesReceipt('tok', 'o', 'r', NaN, 'digby/x')).toBe(false);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});

describe('findRecentChatPrReceipts (tt-rd audit 2026-09-27 — cross-run PR receipts of THIS chat)', () => {
  it('returns the chat\'s ok open_pull_request receipts inside the window, newest first', async () => {
    mockGetRecentChatReceipts.mockResolvedValue([
      receipt({ id: 'a', tool: 'open_pull_request', ids: { prNumber: 1 }, createdAt: new Date('2026-09-26T00:00:00Z') }),
      receipt({ id: 'b', tool: 'git_push', ids: { branch: 'x' }, createdAt: new Date('2026-09-26T01:00:00Z') }),
      receipt({ id: 'c', tool: 'open_pull_request', ok: false, ids: {}, createdAt: new Date('2026-09-26T02:00:00Z') }),
      receipt({ id: 'd', tool: 'open_pull_request', ids: { prNumber: 2 }, createdAt: new Date('2026-09-26T03:00:00Z') }),
    ]);
    const out = await findRecentChatPrReceipts('s1', 7 * 24 * 3600_000);
    // Tool-filtered AT THE DB (fixer 2026-09-27, HIGH) — see the cap test below.
    expect(mockGetRecentChatReceipts).toHaveBeenCalledWith('s1', 7 * 24 * 3600_000, { tools: ['open_pull_request'] });
    expect(out.map((r) => r.id)).toEqual(['d', 'a']);
  });

  it('600 newer run_command receipts ahead of one PR receipt no longer push it past the 500-row cap — the read is tool-filtered (prod 2026-09-27: 125 of 135 PR receipts sat beyond the cap on the busiest lane)', async () => {
    const t0 = new Date('2026-09-26T00:00:00Z').getTime();
    const pool: ToolReceipt[] = [
      receipt({ id: 'pr-old', tool: 'open_pull_request', ids: { prNumber: 601, filesOnlyMd: true, files: ['results/log.md'] }, createdAt: new Date(t0) }),
      ...Array.from({ length: 600 }, (_, i) => receipt({ id: `cmd-${i}`, tool: 'run_command', ids: {}, createdAt: new Date(t0 + (i + 1) * 60_000) })),
    ];
    // A faithful stand-in for the DB read: apply the tools filter, newest-first, take 500, return oldest-first.
    const dbLike = async (_chat: string, _since: number, opts?: { tools?: string[] }) => {
      const rows = opts?.tools?.length ? pool.filter((r) => opts.tools!.includes(r.tool)) : pool;
      return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 500).reverse();
    };
    mockGetRecentChatReceipts.mockImplementation(dbLike);
    try {
      const out = await findRecentChatPrReceipts('s1', 7 * 24 * 3600_000);
      expect(out.map((r) => r.id)).toEqual(['pr-old']);
      // The unfiltered read (the pre-fix path) loses the PR receipt to the cap — the class this pins.
      const unfiltered = await dbLike('s1', 7 * 24 * 3600_000);
      expect(unfiltered).toHaveLength(500);
      expect(unfiltered.some((r) => r.tool === 'open_pull_request')).toBe(false);
    } finally {
      mockGetRecentChatReceipts.mockImplementation(async () => []);
    }
  });

  it('fails open to [] on a read error', async () => {
    mockGetRecentChatReceipts.mockRejectedValue(new Error('db down'));
    expect(await findRecentChatPrReceipts('s1', 1000)).toEqual([]);
  });
});

describe('audit 2026-10-08 W2-5 — the idempotent skip never matches a MERGED / closed PR (plumbing.md F3)', () => {
  afterEach(() => { delete process.env.PR_IDEMPOTENCY_OPEN_ONLY_DISABLED; });
  // REPLAY afb5dc82 / run 713ff624 (StAnne): PR #23 on digby/session-afb5dc82
  // merged at 17:54:27; the lane committed the state file, pushed (recreating
  // the deleted branch) and open_pull_request answered "[idempotent skip] …
  // they appear on the existing PR" three times — false: #23 was merged.
  const MERGED_PR_23 = { head: { ref: 'digby/session-afb5dc82' }, state: 'closed', merged: true, merged_at: '2026-10-08T17:54:27Z' };

  it('REPLAY: a merged PR on the same head → no skip (a follow-up PR opens)', async () => {
    mockAxiosGet.mockResolvedValue({ data: MERGED_PR_23 });
    expect(await prHeadMatchesReceipt('tok', 'o', 'r', 23, 'digby/session-afb5dc82')).toBe(false);
    expect(await prReceiptHeadState('tok', 'o', 'r', 23, 'digby/session-afb5dc82')).toEqual({ headMatches: true, state: 'closed', merged: true });
  });

  it('a closed-unmerged PR → no skip; an open one → skip', () => {
    expect(prStateWarrantsSkip({ headMatches: true, state: 'closed', merged: false })).toBe(false);
    expect(prStateWarrantsSkip({ headMatches: true, state: 'open', merged: false })).toBe(true);
    expect(prStateWarrantsSkip({ headMatches: false, state: 'open', merged: false })).toBe(false);
    expect(prStateWarrantsSkip(null)).toBe(false);
  });

  it('merged_at alone (no merged flag) still reads as merged', async () => {
    mockAxiosGet.mockResolvedValue({ data: { head: { ref: 'digby/x' }, state: 'closed', merged_at: '2026-10-08T18:12:00Z' } });
    expect((await prReceiptHeadState('tok', 'o', 'r', 1338, 'digby/x'))?.merged).toBe(true);
  });

  it('PR_IDEMPOTENCY_OPEN_ONLY_DISABLED=1 restores the head-only match', async () => {
    process.env.PR_IDEMPOTENCY_OPEN_ONLY_DISABLED = '1';
    mockAxiosGet.mockResolvedValue({ data: MERGED_PR_23 });
    expect(await prHeadMatchesReceipt('tok', 'o', 'r', 23, 'digby/session-afb5dc82')).toBe(true);
  });
});
