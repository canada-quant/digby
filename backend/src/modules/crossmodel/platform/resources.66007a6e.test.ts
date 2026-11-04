/**
 * REPLAY TEST — ticket 66007a6e (the mishap close bar).
 *
 * INCIDENT: a project-supervisor chat (no worktree, no run_command) runs
 * hourly uptime probes with scrape_as_markdown. observe_resource's machine
 * no_receipt gate (resource-tools.ts:325-336, reading currentRunReceipts at
 * :188-213 — the in-process ctx.receipts collector FIRST) refused even
 * immediately after REAL scrapes, because web tools minted NO receipts
 * (agent.ts mints a receipt id only for RECEIPT_TOOLS members; web tools are
 * not in that set). A probe-only seat was structurally un-stampable; the
 * watchdog alarmed about a resource that WAS probed hourly.
 *
 * FIX SHAPE: web-probe tools (scrape_as_markdown / scrape_batch /
 * search_engine / web_pipe / youtube_pipe) mint receipts into the IN-PROCESS
 * collector ONLY (never persisted — run-receipts.ts WEB_PROBE_RECEIPT_TOOLS,
 * agent.ts collector-only persistence). This test builds the incident's
 * receipts with the REAL extractReceipt (pinning the seam's semantics to the
 * gate) and drives executeResourceTool exactly as the incident's lane did.
 *
 * Mirrors resource-tools.test.ts idioms (makeCtx, the run-receipts.service
 * mock, jest.mock of resources.service).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockObserveResource = jest.fn(async (_u: string, ref: string) => ({
  id: ref, projectId: null, label: 'example.com uptime', usdPerHour: null, reservationEndsAt: null,
  maxUnobservedMinutes: 240, lastObservedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(),
}));
jest.mock('./resources.service', () => ({
  __esModule: true,
  observeResource: (...a: any[]) => mockObserveResource(...(a as [any, any])),
}));

const mockGetRunReceipts = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRunReceipts: (...a: any[]) => mockGetRunReceipts(...a),
}));

const mockAgentRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { agentRun: { findFirst: (...a: any[]) => mockAgentRunFindFirst(...a) } },
}));

import { executeResourceTool } from './resource-tools';
import { extractReceipt } from '../coding/run-receipts';

function makeCtx(overrides: Record<string, any> = {}): any {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', projectId: 'chat', permissionMode: 'auto',
    emit: () => {}, userTurnAt: new Date(), runId: 'run-1',
    ...overrides,
  };
}

/** The machine-run shape of the incident's lane: a chat-surface supervisor
 *  wake (userTurnAt undefined, runId undefined, no agent_runs row) whose
 *  in-process collector holds what the agent seam pushed. */
const machineCtx = (receipts: any[]) => makeCtx({ userTurnAt: undefined, runId: undefined, receipts });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRunReceipts.mockResolvedValue([]);
  mockAgentRunFindFirst.mockResolvedValue(null);
});

// The incident's verbatim probe shapes, run through the REAL extractor —
// this is the exact construction the agent seam performs at the result seam
// (agent.ts: draft = extractReceipt(tc.name, argsPreview, result, new Date())).
const NOW = new Date('2026-10-20T02:00:00Z');
const DOWN_RESULT =
  'Failed to fetch https://example.com/api/health — the page may be unavailable, blocked, or rate-limited (a transient 403/429 often clears after a cooldown). A retry after a short wait, or trying a different official source for the same content, is fine — just don\'t hammer the same URL repeatedly. If it keeps failing, answer from the search results you already have.';
const downReceipt = () => ({
  id: 'r-down', chatId: 'sess-1', runId: null,
  ...extractReceipt('scrape_as_markdown', { url: 'https://example.com/api/health' }, DOWN_RESULT, NOW)!,
});
const controlReceipt = () => ({
  id: 'r-ctl', chatId: 'sess-1', runId: null,
  ...extractReceipt('scrape_as_markdown', { url: 'https://example.com/' }, '# Example Domain\n\nThis domain is for use in illustrative examples.', NOW)!,
});

describe('observe_resource no_receipt gate — ticket 66007a6e: web-probe receipts are gate evidence', () => {
  it('INCIDENT REPLAY — the hourly uptime probe (DOWN target + ok control) PASSES the machine gate', async () => {
    // The exact incident: the lane scraped the health endpoint (which answered
    // the DOWN shape — the fetch was really attempted) and a control URL, then
    // called observe_resource. Pre-fix: refused no_receipt (web tools minted
    // nothing). Post-fix: the collector holds the ok web-probe receipts.
    const receipts = [downReceipt(), controlReceipt()];
    // Pin the seam's semantics FIRST: both incident shapes extract ok:true.
    expect(receipts[0]).toMatchObject({ tool: 'scrape_as_markdown', ok: true, ids: { url: 'https://example.com/api/health' } });
    expect(receipts[1]).toMatchObject({ tool: 'scrape_as_markdown', ok: true, ids: { url: 'https://example.com/' } });

    const res = JSON.parse(await executeResourceTool(machineCtx(receipts), 'observe_resource', { id: 'wr-1', note: 'probe 02:00Z: DOWN (control up)' }));
    expect(res.ok).toBe(true);
    expect(mockObserveResource).toHaveBeenCalledWith('u1', 'wr-1', 'probe 02:00Z: DOWN (control up)');
    // The collector answered — no DB fallback needed (the chat surface has no
    // agent_runs row anyway).
    expect(mockGetRunReceipts).not.toHaveBeenCalled();
  });

  it('INCIDENT REPLAY (all-down) — ONLY the failed-fetch DOWN receipt still stamps: the watchdog must be stampable when the watched site is down', async () => {
    // An uptime watchdog's DOWN observation is exactly what must reset the
    // unobserved clock — a gate that demands an ok CONTROL scrape would make
    // the down-site case un-stampable again (a different incident of the same
    // class).
    const res = JSON.parse(await executeResourceTool(machineCtx([downReceipt()]), 'observe_resource', { id: 'wr-1', note: 'probe: DOWN' }));
    expect(res.ok).toBe(true);
    expect(mockObserveResource).toHaveBeenCalledWith('u1', 'wr-1', 'probe: DOWN');
  });

  it('DETECTOR-RECALL REPLAY — the prior true positives still refuse: empty collector + no agent_runs row', async () => {
    // 1c1a6699 / the 119df67e detector-recall line: nothing ran this run →
    // nothing was observed. The fix must not loosen this.
    const res = JSON.parse(await executeResourceTool(machineCtx([]), 'observe_resource', { id: 'wr-1' }));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
    expect(mockObserveResource).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY — collector with ONLY ok:false receipts is refused', async () => {
    const failed = {
      id: 'r-f', chatId: 'sess-1', runId: null,
      ...extractReceipt('scrape_as_markdown', { url: 'https://x/' }, 'Web tools unavailable.', NOW)!,
    };
    expect(failed.ok).toBe(false);
    const res = JSON.parse(await executeResourceTool(machineCtx([failed]), 'observe_resource', { id: 'wr-1' }));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
    expect(mockObserveResource).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY — a user-turn ctx stamps without any receipt (the gate is machine-only)', async () => {
    const res = JSON.parse(await executeResourceTool(makeCtx({ receipts: [] }), 'observe_resource', { id: 'wr-1' }));
    expect(res.ok).toBe(true);
    expect(mockObserveResource).toHaveBeenCalledWith('u1', 'wr-1', undefined);
  });

  it('degraded-gateway shape — only ok:false WEB_DEGRADED_MSG receipts → refused no_receipt (nothing was really observed)', async () => {
    // The decided ok:false semantics: an infrastructure-shape failure
    // (degraded gateway) executed nothing observable. A lane that only ever
    // saw WEB_DEGRADED_MSG must NOT be able to stamp — that is the phantom
    // observation the gate exists to refuse.
    const degraded = 'Web search is temporarily unavailable (the search gateway is recovering) — this is a transient infrastructure issue, NOT an indication that no results exist. Do not give up on the topic: use other tools (e.g. GitHub/connector tools) or your own knowledge, note that live web results were unavailable, and you may retry web search shortly.';
    const receipts = [
      { id: 'r-d1', chatId: 'sess-1', runId: null, ...extractReceipt('search_engine', { query: 'x' }, degraded, NOW)! },
      { id: 'r-d2', chatId: 'sess-1', runId: null, ...extractReceipt('scrape_as_markdown', { url: 'https://example.com/api/health' }, degraded, NOW)! },
    ];
    expect(receipts.every((r) => !r.ok)).toBe(true);
    const res = JSON.parse(await executeResourceTool(machineCtx(receipts), 'observe_resource', { id: 'wr-1' }));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
    expect(mockObserveResource).not.toHaveBeenCalled();
  });

  it('mixed: an ok web-probe receipt alongside ok:false ones satisfies the gate (the collector path is any-ok)', async () => {
    const degraded = 'Web search is temporarily unavailable (the search gateway is recovering) — this is a transient infrastructure issue, NOT an indication that no results exist.';
    const receipts = [
      { id: 'r-d', chatId: 'sess-1', runId: null, ...extractReceipt('search_engine', { query: 'x' }, degraded, NOW)! },
      controlReceipt(),
    ];
    const res = JSON.parse(await executeResourceTool(machineCtx(receipts), 'observe_resource', { id: 'wr-1' }));
    expect(res.ok).toBe(true);
  });
});
