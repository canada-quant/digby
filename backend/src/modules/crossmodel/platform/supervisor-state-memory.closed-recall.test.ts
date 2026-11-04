/**
 * fs-durable-memory review (2026-10-22), item 4: automatic recall must rank
 * OPEN rows above CLOSED archived rows. The 50-row cap now archives done /
 * answered rows (up to 200 closed rows kept, the older ones in the cold
 * archive), and every one is mirrored into the chat scope the per-turn recall
 * searches — so a plain top-15 search could return nothing but closed history
 * and crowd out the trimmed open orders the block exists to surface. Now:
 *  - a refs-filtered leg searches the doc's rows MINUS closed archived rows,
 *    so open rows are always in the candidate set;
 *  - closed archived rows render AFTER the open rows, at most
 *    SUPERVISOR_RECALL_CLOSED_MAX of them — only to fill slots the open rows
 *    left, or when the query matches them strongly;
 *  - SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED=1 restores the single search.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFindState: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { supervisorState: { findUnique: (...a: any[]) => mockFindState(...a), upsert: jest.fn() }, crossModelChat: { findUnique: jest.fn(async () => null) } },
}));
jest.mock('./kpi-register.service', () => ({ __esModule: true, loadKpisForSupervisorChat: jest.fn(async () => []) }));
const mockMemSearch: jest.Mock = jest.fn(async () => []);
const mockMemListRefs: jest.Mock = jest.fn(async () => []);
const mockMemDeleteRefs: jest.Mock = jest.fn(async () => 0);
const mockMemStore: jest.Mock = jest.fn(async (_s: any, _src: any, items: any[]) => items.length);
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 0),
  memSearch: (...a: any[]) => mockMemSearch(...a),
  memListRefs: (...a: any[]) => mockMemListRefs(...a),
  memDeleteRefs: (...a: any[]) => mockMemDeleteRefs(...a),
  memStore: (...a: any[]) => mockMemStore(...a),
}));

import {
  buildSupervisorStateRecallBlock,
  embedSupervisorStateColdRows,
  embedSupervisorStateDoc,
  closedRecallStrongMatch,
  isClosedArchivedRecallHit,
  supervisorStateColdMemRows,
  supervisorStateMemRows,
  SUPERVISOR_RECALL_CLOSED_MAX,
} from './supervisor-state-memory';
import type { SupervisorDirective, SupervisorStateDoc } from './supervisor-state.service';

const CHAT = 'ffffffff-6666-6666-6666-666666666666';
const OPEN_A: SupervisorDirective = { id: 'a1a1a1a1-0000-4000-8000-000000000001', text: 'Move the canlaw bench to the H100 box this week', at: '2026-10-20T09:00:00Z', status: 'open', origin: 'owner' };
const OPEN_B: SupervisorDirective = { id: 'b2b2b2b2-0000-4000-8000-000000000002', text: 'Report the det-v2 score with receipts every morning', at: '2026-10-21T09:00:00Z', status: 'open', origin: 'owner' };
const doc: SupervisorStateDoc = { directives: [OPEN_A, OPEN_B], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };

/** 15 closed archived rows (cold refs) — all about the same topic, so a plain search returns only them. */
const closedRows: SupervisorDirective[] = Array.from({ length: 15 }, (_, i) => ({
  id: `c${String(i).padStart(7, '0')}-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
  text: `Answered ask ${i}: is the canlaw bench run on the H100 box done yet`,
  at: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 3_600_000).toISOString(),
  status: 'answered', kind: 'ask', evidence: `msg ${String(i).padStart(8, '0')}`, archivedAt: '2026-10-15T00:00:00Z',
}));
const asHit = (it: { ref?: string; title?: string; content: string }) => ({ ref: it.ref ?? '', title: it.title ?? '', source: 'supervisor_state', content: it.content, scopeType: 'chat', scopeId: CHAT, createdAt: '2026-10-22T00:00:00Z' });
const closedHits = supervisorStateColdMemRows(closedRows).map(asHit);
const openHits = supervisorStateMemRows(doc).map(asHit);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED;
  delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED;
  delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
  mockFindState.mockResolvedValue({ state: doc });
  // The refs-filtered leg answers from the doc's own (open) rows; the plain search is all closed history.
  mockMemSearch.mockImplementation(async (_scopes: any, _q: string, _k: number, opts: any) => (opts?.refs?.length ? openHits.filter((h) => opts.refs.includes(h.ref)) : closedHits));
});
afterAll(() => { delete process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED; delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED; });

describe('recall: open rows outrank closed archived rows', () => {
  it('open rows are surfaced (and lead) even when the plain top-k is all closed history', async () => {
    const block = await buildSupervisorStateRecallBlock(CHAT, 'canlaw bench H100', 5, { visibleText: 'nothing visible' });
    expect(block).toContain('Move the canlaw bench to the H100 box');
    expect(block).toContain('Report the det-v2 score');
    const closedLines = block.split('\n').filter((l) => l.includes('Answered ask'));
    expect(closedLines.length).toBeLessThanOrEqual(SUPERVISOR_RECALL_CLOSED_MAX);
    // every open line precedes every closed line
    const lastOpen = Math.max(block.indexOf('Move the canlaw bench'), block.indexOf('Report the det-v2 score'));
    for (const l of closedLines) expect(block.indexOf(l)).toBeGreaterThan(lastOpen);
    expect(block).toContain('Closed (done / answered');
    // the refs leg searched only open rows — never a closed archived ref
    const refsCall = mockMemSearch.mock.calls.find((c: any[]) => c[3]?.refs);
    expect(refsCall).toBeDefined();
    expect(refsCall![3].refs.some((r: string) => r.startsWith('archive '))).toBe(false);
  });

  it('when open rows fill k, a closed row shows only on a STRONG query match (and still after them)', async () => {
    const manyOpen: SupervisorDirective[] = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}d${i}d${i}d${i}-0000-4000-8000-00000000000${i}`, text: `Open order ${i} about the nightly digest layout`, at: `2026-10-2${i}T00:00:00Z`, status: 'open' }));
    const d2: SupervisorStateDoc = { ...doc, directives: manyOpen };
    mockFindState.mockResolvedValue({ state: d2 });
    const open2 = supervisorStateMemRows(d2).map(asHit);
    const strong = asHit(supervisorStateColdMemRows([{ id: 'e5e5e5e5-0000-4000-8000-000000000099', text: 'Retire the spark cluster staging lane after the benchmark freeze', at: '2026-10-02T00:00:00Z', status: 'done', evidence: 'pr #77', archivedAt: '2026-10-10T00:00:00Z' }])[0]);
    mockMemSearch.mockImplementation(async (_s: any, _q: string, _k: number, opts: any) => (opts?.refs?.length ? open2 : [closedHits[0], strong, closedHits[1]]));
    const block = await buildSupervisorStateRecallBlock(CHAT, 'retire the spark cluster staging lane after the benchmark freeze?', 3, { visibleText: 'nothing visible' });
    expect(block.split('\n').filter((l) => l.includes('Open order')).length).toBe(3);
    expect(block).toContain('Retire the spark cluster staging lane');
    expect(block).not.toContain('Answered ask'); // weak closed matches never displace or join a full open set
    expect(block.indexOf('Retire the spark cluster')).toBeGreaterThan(block.lastIndexOf('Open order'));
  });

  it('closedRecallStrongMatch / isClosedArchivedRecallHit (pure)', () => {
    expect(isClosedArchivedRecallHit({ ref: 'archive c0000000-0000 @x #y', title: 'Archived directive [c0000000] (answered)' })).toBe(true);
    expect(isClosedArchivedRecallHit({ ref: 'directive x @y #z', title: 'Archived directive [x] (done)' })).toBe(true);
    expect(isClosedArchivedRecallHit({ ref: 'directive x @y #z', title: 'Archived directive [x] (open)' })).toBe(false);
    expect(isClosedArchivedRecallHit({ ref: 'directive x @y #z', title: 'Directive [x] (done)' })).toBe(false); // live closed rows were always recallable
    const hit = closedHits[3];
    expect(closedRecallStrongMatch('is the canlaw bench run on the H100 box done yet?', hit)).toBe(true);
    expect(closedRecallStrongMatch('canlaw', hit)).toBe(false);
    expect(closedRecallStrongMatch(`what happened to ${closedRows[3].id.slice(0, 8)}?`, hit)).toBe(true);
  });

  it('kill switch SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED=1: the single plain search as before', async () => {
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
    const block = await buildSupervisorStateRecallBlock(CHAT, 'canlaw bench H100', 5, { visibleText: 'nothing visible' });
    expect(mockMemSearch).toHaveBeenCalledTimes(1);
    expect(mockMemSearch.mock.calls[0][3].refs).toBeUndefined();
    // unbounded closed history again (only the 1500-char cap limits it)
    expect(block.split('\n').filter((l) => l.includes('Answered ask')).length).toBeGreaterThan(SUPERVISOR_RECALL_CLOSED_MAX);
    expect(block).not.toContain('Closed (done / answered');
  });
});

describe('open-first recall does not depend on SUPERVISOR_RECALL_DIFF_QUERY_DISABLED (review round 3)', () => {
  // The batch mirror (diff-query hygiene OFF) stores every HOT doc row under the
  // one 'supervisor-state' ref and the cold rows under 'archive …' refs; titles
  // still say which rows are closed archived ones.
  const batchOpen = openHits.map((h) => ({ ...h, ref: 'supervisor-state' }));
  it('batch mode: a hot-doc leg (the batch ref) supplies the open rows, closed archived rows come last and capped', async () => {
    process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED = '1';
    mockMemSearch.mockImplementation(async (_s: any, _q: string, _k: number, opts: any) => (opts?.refs?.length ? (opts.refs.includes('supervisor-state') ? batchOpen : []) : closedHits));
    const block = await buildSupervisorStateRecallBlock(CHAT, 'canlaw bench H100', 5);
    expect(block).toContain('Move the canlaw bench to the H100 box');
    expect(block).toContain('Report the det-v2 score');
    const closedLines = block.split('\n').filter((l) => l.includes('Answered ask'));
    expect(closedLines.length).toBeLessThanOrEqual(SUPERVISOR_RECALL_CLOSED_MAX);
    const lastOpen = Math.max(block.indexOf('Move the canlaw bench'), block.indexOf('Report the det-v2 score'));
    for (const l of closedLines) expect(block.indexOf(l)).toBeGreaterThan(lastOpen);
    const refsCall = mockMemSearch.mock.calls.find((c: any[]) => c[3]?.refs);
    expect(refsCall![3].refs).toEqual(['supervisor-state']);
    // no row twice when both legs return it
    expect(block.split('\n').filter((l) => l.includes('Move the canlaw bench')).length).toBe(1);
  });

  it('batch mode + SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED=1: the single plain search as before', async () => {
    process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED = '1';
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
    await buildSupervisorStateRecallBlock(CHAT, 'canlaw bench H100', 5);
    expect(mockMemSearch).toHaveBeenCalledTimes(1);
    expect(mockMemSearch.mock.calls[0][2]).toBe(5);
    expect(mockMemSearch.mock.calls[0][3].refs).toBeUndefined();
  });
});

describe('cold-archive mirror (item 5: the full archive stays searchable without living in the hot doc)', () => {
  it("cold rows are mirrored under 'archive …' refs; the reconcile drops only stale 'archive' refs", async () => {
    const rows = closedRows.slice(0, 3);
    const want = supervisorStateColdMemRows(rows).map((r) => r.ref);
    mockMemListRefs.mockResolvedValueOnce([{ ref: want[0], rows: 1 }, { ref: 'archive gone0000 @x #y', rows: 1 }, { ref: 'directive keep-me @x #z', rows: 1 }]);
    const n = await embedSupervisorStateColdRows(CHAT, rows, { userId: 'u1' });
    expect(n).toBe(2);
    expect(mockMemDeleteRefs).toHaveBeenCalledWith({ type: 'chat', id: CHAT }, 'supervisor_state', ['archive gone0000 @x #y']);
    const stored = mockMemStore.mock.calls[0][2] as Array<{ ref: string; content: string }>;
    expect(stored.map((r) => r.ref)).toEqual(want.slice(1));
    expect(stored[0].content).toContain('evidence: msg');
  });

  it("the hot-doc mirror never deletes a cold 'archive …' ref (they leave the hot doc on purpose)", async () => {
    const hotRefs = supervisorStateMemRows(doc).map((r) => r.ref);
    mockMemListRefs.mockResolvedValueOnce([...hotRefs.map((ref) => ({ ref, rows: 1 })), { ref: 'archive c0000001-0000 @x #y', rows: 1 }, { ref: 'directive vanished @x #y', rows: 1 }]);
    await embedSupervisorStateDoc('hot-mirror-chat', doc);
    const dropped = mockMemDeleteRefs.mock.calls.flatMap((c: any[]) => c[2]);
    expect(dropped).toContain('directive vanished @x #y');
    expect(dropped.some((r: string) => r.startsWith('archive '))).toBe(false);
  });
});
