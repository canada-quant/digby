/**
 * Ticket 2b8508cb — supervisor-state → digby_memory bridge
 * (platform/supervisor-state-memory.ts).
 *
 * Pins:
 *  - supervisorStateMemItems: one item per directive (live + archived) and
 *    per dispatch, deterministic order, ids/refs stable.
 *  - embedSupervisorStateDoc: replace-by-ref against the chat scope with the
 *    exact opts (skipCap, skipGate, maxChunks ≥ doc shape), the content-hash
 *    no-op short-circuit, the kill switch, and TOTAL failure behavior.
 *  - buildSupervisorStateRecallBlock: newest-first rendering under the cap,
 *    sources filter, kill switch, empty on no hits.
 *  - searchSupervisorStateMem: newest-first mapping, k clamp.
 *
 * The memory store is mocked at the module boundary — the REAL store is
 * pinned in memory/unified-memory suites.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { supervisorState: { findUnique: jest.fn(), upsert: jest.fn() }, crossModelChat: { findUnique: jest.fn() } },
}));
// The owner-turn KPI annotation the human-seam render mirrors (renderedStateText).
const mockLoadKpis: jest.Mock = jest.fn(async () => []);
jest.mock('./kpi-register.service', () => ({ __esModule: true, loadKpisForSupervisorChat: (...a: any[]) => mockLoadKpis(...a) }));

const mockMemReplaceRef: jest.Mock = jest.fn(async () => 3);
const mockMemSearch: jest.Mock = jest.fn(async () => []);
const mockMemListRefs: jest.Mock = jest.fn(async () => []);
const mockMemDeleteRefs: jest.Mock = jest.fn(async () => 0);
const mockMemStore: jest.Mock = jest.fn(async (_s: any, _src: any, items: any[]) => items.length);
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: (...a: any[]) => mockMemReplaceRef(...(a as [any, any, any, any, any])),
  memSearch: (...a: any[]) => mockMemSearch(...(a as [any, any, any, any])),
  memListRefs: (...a: any[]) => mockMemListRefs(...(a as [any, any])),
  memDeleteRefs: (...a: any[]) => mockMemDeleteRefs(...(a as [any, any, any])),
  memStore: (...a: any[]) => mockMemStore(...(a as [any, any, any, any])),
}));

import {
  SUPERVISOR_STATE_MEM_SOURCE,
  SUPERVISOR_STATE_MEM_REF,
  SUPERVISOR_STATE_RECALL_CAP,
  SUPERVISOR_STATE_RECALL_DEADLINE_MS,
  supervisorStateMemItems,
  supervisorStateMemHash,
  embedSupervisorStateDoc,
  enqueueSupervisorStateEmbed,
  buildSupervisorStateRecallBlock,
  searchSupervisorStateMem,
  supervisorStateMemRows,
  recallQueryFromLedgerDiff,
  supervisorStateRowKeyOfHit,
  supervisorStateRowVisible,
  rowAtFromRef,
  supervisorRecallDiffQueryDisabled,
  supervisorStateRowHidden,
  dedupeRecallHits,
  renderedStateText,
} from './supervisor-state-memory';
import type { SupervisorStateDoc } from './supervisor-state.service';

const doc = (over: Partial<SupervisorStateDoc> = {}): SupervisorStateDoc => ({
  directives: [
    { id: 'dir-open-1', text: 'Keep the nightly summary under one page', at: '2026-10-01T00:00:00Z', status: 'open', standing: true, scope: 'fleet' },
    { id: 'dir-done-2', text: 'Merge the rate limiter PR', at: '2026-10-02T00:00:00Z', status: 'done', evidence: 'PR #1234' },
  ],
  archived: [
    { id: 'dir-arch-3', text: 'Old archived order about the backup cadence', at: '2026-09-20T00:00:00Z', status: 'open', archivedAt: '2026-10-10T00:00:00Z' },
  ],
  dispatches: [
    { at: '2026-10-17T01:00:00Z', kind: 'session', id: '11111111-1111-1111-1111-111111111111', note: 'spawned the audit lane' },
    { at: '2026-10-17T02:00:00Z', kind: 'message', id: '22222222-2222-2222-2222-222222222222' },
  ],
  projects: [],
  notes: 'scratch notes',
  refutations: [],
  inflightPreemptAt: '',
  ...over,
});

describe('supervisorStateMemItems', () => {
  it('emits one item per directive (live + archived) and per dispatch, in deterministic order', () => {
    const items = supervisorStateMemItems(doc());
    expect(items.map((i) => i.ref)).toEqual([
      'directive dir-open-1',
      'directive dir-done-2',
      'directive dir-arch-3',
      'dispatch 11111111-1111-1111-1111-',
      'dispatch 22222222-2222-2222-2222-',
    ]);
    // The directive line carries id + text + status + evidence; a dispatch
    // line carries kind → id + the historical-ledger caveat.
    expect(items[0].content).toContain('dir-open-1');
    expect(items[0].content).toContain('Keep the nightly summary under one page');
    expect(items[0].content).toContain('standing');
    expect(items[1].content).toContain('PR #1234');
    expect(items[3].content).toContain('session → 11111111-1111-1111-1111-111111111111');
    expect(items[3].content).toContain('prior wake');
  });

  it('skips empty/malformed rows and an empty doc yields no items', () => {
    expect(supervisorStateMemItems({ ...doc(), directives: [], archived: [], dispatches: [] })).toEqual([]);
    expect(supervisorStateMemItems({ ...doc(), dispatches: [{ at: '', kind: '', id: '', note: '' }] as any }).length).toBe(3);
    expect(supervisorStateMemItems(null as any)).toEqual([]);
  });
});

describe('embedSupervisorStateDoc', () => {
  const CHAT = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    jest.clearAllMocks();
    // fresh in-process hash cache per test
    jest.resetModules();
    delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED;
    // MIND-HYGIENE: these pins cover the legacy batch mirror (the kill switch path).
    process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED = '1';
  });
  afterAll(() => { delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED; });

  it('replace-by-ref against the chat scope with skipCap/skipGate and a whole-batch maxChunks', async () => {
    const n = await embedSupervisorStateDoc(CHAT, doc(), { userId: 'u1' });
    expect(n).toBe(3);
    const call = mockMemReplaceRef.mock.calls[0] as any[];
    const [scope, source, ref, items, opts] = call;
    expect(scope).toEqual({ type: 'chat', id: CHAT });
    expect(source).toBe(SUPERVISOR_STATE_MEM_SOURCE);
    expect(ref).toBe(SUPERVISOR_STATE_MEM_REF);
    expect((items as any[]).length).toBe(5);
    expect(opts).toMatchObject({ userId: 'u1', skipCap: true, skipGate: true, maxChunks: 300 });
  });

  it('short-circuits a byte-identical re-embed (content hash, in-process)', async () => {
    // Unique chat id: the in-process hash cache is keyed by chatId and
    // survives across tests in this module instance.
    const CHAT2 = '77777777-7777-7777-7777-777777777777';
    await embedSupervisorStateDoc(CHAT2, doc(), { userId: 'u1' });
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(1);
    // A doc whose ITEMS are byte-identical (notes differ — notes are not
    // items) does NOT re-embed.
    const changed = doc({ notes: 'different notes do not matter (not an item)' });
    await embedSupervisorStateDoc(CHAT2, changed, { userId: 'u1' });
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(1);
    const changedItems = doc({ directives: [{ id: 'dir-x', text: 'a new order', at: '2026-10-18T00:00:00Z', status: 'open' }] });
    await embedSupervisorStateDoc(CHAT2, changedItems, { userId: 'u1' });
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(2);
  });

  it('a store failure is TOTAL — logs, returns 0, never throws', async () => {
    mockMemReplaceRef.mockRejectedValueOnce(new Error('embedding provider down'));
    const n = await embedSupervisorStateDoc(CHAT, doc());
    expect(n).toBe(0);
    await expect(embedSupervisorStateDoc(CHAT, doc())).resolves.toBe(0);
  });

  it('review N1: a SILENT store failure (memStore returns 0, never throws) is NOT cached — the next write retries', async () => {
    // Unique chat id: the hash cache is module-level and survives tests.
    const CHATN1 = '88888888-8888-8888-8888-888888888888';
    const docA = doc();
    const docB = doc({ directives: [{ id: 'dir-y', text: 'a later order', at: '2026-10-19T00:00:00Z', status: 'open' }] });
    // memStore swallows store failures internally and returns 0 — the exact
    // class the reviewer flagged: caching the hash on n=0 with a non-empty
    // doc would serve stale/empty recall until the next content change.
    mockMemReplaceRef.mockReset().mockResolvedValue(0);
    await embedSupervisorStateDoc(CHATN1, docA);
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(1);
    // different items, same chat: retried — the failed mirror was NOT cached
    await embedSupervisorStateDoc(CHATN1, docB);
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(2);
    // now a SUCCESSFUL mirror of docB caches its hash…
    mockMemReplaceRef.mockReset().mockResolvedValue(5);
    await embedSupervisorStateDoc(CHATN1, docB);
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(1);
    // …so an items-identical rewrite (notes differ) short-circuits
    await embedSupervisorStateDoc(CHATN1, docB !== docA ? doc({ directives: docB.directives, notes: 'items unchanged' }) : docA);
    expect(mockMemReplaceRef).toHaveBeenCalledTimes(1);
  });

  it('review N2: maxChunks sizes from the ACTUAL batch (an all-open ledger can exceed the 50-directive nominal cap)', async () => {
    const CHATN2 = '99999999-9999-9999-9999-999999999999';
    const many = Array.from({ length: 340 }, (_, i) => ({ id: `dir-open-${i}`, text: `standing order number ${i}`, at: '2026-10-01T00:00:00Z', status: 'open', standing: true }));
    await embedSupervisorStateDoc(CHATN2, doc({ directives: many as any, archived: [], dispatches: [] }));
    const call = mockMemReplaceRef.mock.calls[0] as any[];
    expect((call[3] as any[]).length).toBe(340);
    expect(call[4].maxChunks).toBeGreaterThanOrEqual(340);
  });

  it('review N3: enqueueSupervisorStateEmbed orders concurrent embeds per chat (no delete/insert interleave)', async () => {
    const CHATN3 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    mockMemReplaceRef.mockReset();
    mockMemReplaceRef.mockImplementationOnce(async () => { await gateA; order.push('A-done'); return 3; });
    mockMemReplaceRef.mockImplementation(async () => { order.push('B-done'); return 3; });
    // two DIFFERENT-item docs (notes-only diffs would hash-skip the second)
    const v1 = doc({ directives: [{ id: 'dir-v1', text: 'first order', at: '2026-10-01T00:00:00Z', status: 'open' }], archived: [], dispatches: [] });
    const v2 = doc({ directives: [{ id: 'dir-v2', text: 'second order', at: '2026-10-02T00:00:00Z', status: 'open' }], archived: [], dispatches: [] });
    enqueueSupervisorStateEmbed(CHATN3, v1);
    enqueueSupervisorStateEmbed(CHATN3, v2);
    await new Promise((r) => setTimeout(r, 10));
    // B has NOT run yet — it is chained behind A (A is gated)
    expect(order).toEqual([]);
    releaseA();
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['A-done', 'B-done']);
  });

  it('kill switch SUPERVISOR_STATE_MEMORY_DISABLED=1 skips the store entirely', async () => {
    process.env.SUPERVISOR_STATE_MEMORY_DISABLED = '1';
    expect(await embedSupervisorStateDoc(CHAT, doc())).toBe(0);
    expect(mockMemReplaceRef).not.toHaveBeenCalled();
    delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED;
  });
});

describe('buildSupervisorStateRecallBlock', () => {
  const CHAT = '44444444-4444-4444-4444-444444444444';

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
    // MIND-HYGIENE: these pins cover the legacy recall (the kill switch path).
    process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED = '1';
  });
  afterAll(() => { delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED; });

  it('queries ONLY the chat scope + supervisor_state source and renders newest-first under the cap', async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'supervisor-state', title: 'Directive [dir-old] (open)', content: 'An older directive about the backup cadence', createdAt: '2026-10-01T00:00:00Z' },
      { ref: 'supervisor-state', title: 'Directive [dir-new] (open)', content: 'The newest owner order', createdAt: '2026-10-18T00:00:00Z' },
      { ref: 'supervisor-state', title: 'Dispatch session → 55', content: 'Dispatch session → 55', createdAt: '2026-10-17T00:00:00Z' },
    ] as any);

    const block = await buildSupervisorStateRecallBlock(CHAT, 'what did the owner order about backups?');
    // Review round 3 (2026-10-23): closed archived rows rank last on the batch
    // mirror too — the plain search over-fetches (3k) and a second leg reads
    // the batch ref (the hot doc's rows); both stay chat scope + supervisor_state.
    expect(mockMemSearch).toHaveBeenCalledWith(
      [{ type: 'chat', id: CHAT }],
      'what did the owner order about backups?',
      15,
      { sources: [SUPERVISOR_STATE_MEM_SOURCE], purpose: 'supervisor_state_recall', deadlineMs: SUPERVISOR_STATE_RECALL_DEADLINE_MS },
    );
    expect(mockMemSearch).toHaveBeenCalledWith(
      [{ type: 'chat', id: CHAT }],
      'what did the owner order about backups?',
      15,
      { sources: [SUPERVISOR_STATE_MEM_SOURCE], purpose: 'supervisor_state_recall', deadlineMs: SUPERVISOR_STATE_RECALL_DEADLINE_MS, refs: ['supervisor-state'] },
    );
    expect(mockMemSearch).toHaveBeenCalledTimes(2);
    expect(block).toContain('[SUPERVISOR STATE (retrieved)');
    // newest first: dir-new above dispatch 55 above dir-old
    const iNew = block.indexOf('The newest owner order');
    const iDispatch = block.indexOf('Dispatch session → 55');
    const iOld = block.indexOf('backup cadence');
    expect(iNew).toBeGreaterThan(-1);
    expect(iDispatch).toBeGreaterThan(iNew);
    expect(iOld).toBeGreaterThan(iDispatch);
    // the historical-ledger caveat rides the block, and each line is labeled
    // with the row's TITLE (review N5: h.ref is the batch ref — dead weight)
    expect(block).toContain('HISTORICAL ledger');
    expect(block).toContain('- [Directive [dir-new] (open)] The newest owner order');
  });

  it('caps the rendered block at SUPERVISOR_STATE_RECALL_CAP chars', async () => {
    mockMemSearch.mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => ({
        ref: `dispatch ${i}`,
        title: 'Dispatch',
        content: 'x'.repeat(200),
        createdAt: new Date(Date.parse('2026-10-18T00:00:00Z') - i * 1000).toISOString(),
      })) as any,
    );
    const block = await buildSupervisorStateRecallBlock(CHAT, 'dispatches');
    expect(block.length).toBeLessThanOrEqual(SUPERVISOR_STATE_RECALL_CAP + 120);
    expect(block).not.toContain('x'.repeat(200) + '\n- (dispatch 39');
  });

  it('returns []-block (empty string) on no hits, kill switch, or failure', async () => {
    mockMemSearch.mockResolvedValueOnce([]);
    expect(await buildSupervisorStateRecallBlock(CHAT, 'nothing')).toBe('');
    process.env.SUPERVISOR_STATE_RECALL_DISABLED = '1';
    mockMemSearch.mockClear();
    expect(await buildSupervisorStateRecallBlock(CHAT, 'q')).toBe('');
    expect(mockMemSearch).not.toHaveBeenCalled();
    delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
    mockMemSearch.mockRejectedValueOnce(new Error('vector db down'));
    expect(await buildSupervisorStateRecallBlock(CHAT, 'q')).toBe('');
  });
});

describe('searchSupervisorStateMem', () => {
  const CHAT = '66666666-6666-6666-6666-666666666666';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps hits newest-first with the source filter, clamping k', async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'a', title: 'A', content: 'older row', createdAt: '2026-10-01T00:00:00Z', scopeType: 'chat', scopeId: CHAT, source: SUPERVISOR_STATE_MEM_SOURCE },
      { ref: 'b', title: 'B', content: 'newer row', createdAt: '2026-10-02T00:00:00Z', scopeType: 'chat', scopeId: CHAT, source: SUPERVISOR_STATE_MEM_SOURCE },
    ] as any);
    const rows = await searchSupervisorStateMem(CHAT, 'owner orders', 20);
    expect(mockMemSearch).toHaveBeenCalledWith(
      [{ type: 'chat', id: CHAT }],
      'owner orders',
      20,
      { sources: [SUPERVISOR_STATE_MEM_SOURCE], purpose: 'supervisor_state_route' },
    );
    expect(rows.map((r) => r.ref)).toEqual(['b', 'a']);
    // invalid k clamps into 1..50, never throws
    await searchSupervisorStateMem(CHAT, 'q', 9999 as any);
    expect((mockMemSearch.mock.calls[1] as any[])[2]).toBe(50);
    expect(await searchSupervisorStateMem(CHAT, '', 20)).toEqual([]);
  });
});

describe('supervisorStateMemHash', () => {
  it('changes only when the ITEMS change (notes are not items)', () => {
    const a = supervisorStateMemHash(doc());
    expect(a).toBe(supervisorStateMemHash(doc()));
    expect(a).toBe(supervisorStateMemHash(doc({ notes: 'totally different notes' })));
    expect(a).not.toBe(supervisorStateMemHash(doc({ directives: [] })));
  });
});

// ── MIND-HYGIENE (2026-10-20): diff-keyed recall + per-row refs ─────────────
describe('MIND-HYGIENE recall', () => {
  const CHAT = 'bbbbbbbb-2222-2222-2222-222222222222';
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED;
    delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
    delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED;
  });

  it('the kill switch reads 1 / true / on', () => {
    expect(supervisorRecallDiffQueryDisabled({})).toBe(false);
    expect(supervisorRecallDiffQueryDisabled({ SUPERVISOR_RECALL_DIFF_QUERY_DISABLED: '1' })).toBe(true);
  });

  it('recallQueryFromLedgerDiff: the diff body (heading / Material / empty lines dropped); the trigger text when nothing moved', () => {
    const diff = [
      '[SINCE YOUR LAST WAKE — harness ledger diff 2026-10-20T10:00Z → 2026-10-20T12:00Z (120 min); read from the ledger …]',
      'Owner messages: in this chat 11:40Z "move the backup cadence to nightly"',
      'Lane runs: FAILED 1 (aaaa1111 "bench lane" 11:50Z: OOM)',
      'Material: yes — owner_message',
    ].join('\n');
    const q = recallQueryFromLedgerDiff(diff, '[SCHEDULE] stock sweep');
    expect(q).toContain('move the backup cadence to nightly');
    expect(q).toContain('FAILED 1');
    expect(q).not.toContain('SINCE YOUR LAST WAKE');
    expect(q).not.toContain('Material:');
    const empty = '[SINCE YOUR LAST WAKE — harness ledger diff …]\nNothing recorded in the ledger since your last wake.';
    expect(recallQueryFromLedgerDiff(empty, '[SCHEDULE] stock sweep')).toBe('[SCHEDULE] stock sweep');
    expect(recallQueryFromLedgerDiff(null, 'trigger')).toBe('trigger');
    expect(recallQueryFromLedgerDiff('x'.repeat(5000), 't').length).toBe(2000);
  });

  it('supervisorStateMemRows: content-addressed per-row refs carrying the row time — stable for an unchanged row, new for a changed one', () => {
    const rows = supervisorStateMemRows(doc());
    expect(rows).toHaveLength(5);
    expect(rows[0].ref).toMatch(/^directive dir-open-1 @2026-10-01T00:00:00Z #[0-9a-f]{12}$/);
    expect(rows[3].ref).toMatch(/^dispatch 11111111-1111-1111-1111- @2026-10-17T01:00:00Z #[0-9a-f]{12}$/);
    expect(supervisorStateMemRows(doc()).map((r) => r.ref)).toEqual(rows.map((r) => r.ref));
    const changed = supervisorStateMemRows(doc({ directives: [{ ...doc().directives[0], text: 'Keep the nightly summary under TWO pages' }, doc().directives[1]] }));
    expect(changed[0].ref).not.toBe(rows[0].ref);
    expect(changed[1].ref).toBe(rows[1].ref);
    expect(rowAtFromRef(rows[0].ref)).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(rowAtFromRef('supervisor-state')).toBeNull();
  });

  it('the per-row mirror stores ONLY new rows and deletes vanished / legacy / doubled refs — an unchanged row keeps its own created_at', async () => {
    const rows = supervisorStateMemRows(doc());
    mockMemListRefs.mockResolvedValueOnce([
      { ref: rows[0].ref, rows: 1 }, // unchanged — kept, never rewritten
      { ref: rows[1].ref, rows: 2 }, // doubled by a cross-container race — re-stored once
      { ref: 'supervisor-state', rows: 5 }, // the legacy batch mirror
      { ref: 'directive gone @2026-09-01T00:00:00Z #aaaaaaaaaaaa', rows: 1 }, // vanished row
    ]);
    const n = await embedSupervisorStateDoc(CHAT, doc(), { userId: 'u1' });
    expect(mockMemReplaceRef).not.toHaveBeenCalled();
    const [scope, source, dropped] = mockMemDeleteRefs.mock.calls[0] as any[];
    expect(scope).toEqual({ type: 'chat', id: CHAT });
    expect(source).toBe(SUPERVISOR_STATE_MEM_SOURCE);
    expect([...dropped].sort()).toEqual(['directive gone @2026-09-01T00:00:00Z #aaaaaaaaaaaa', 'supervisor-state', rows[1].ref].sort());
    const stored = ((mockMemStore.mock.calls[0] as any[])[2] as any[]).map((i) => i.ref);
    expect(stored).not.toContain(rows[0].ref);
    expect(stored.sort()).toEqual([rows[1].ref, rows[2].ref, rows[3].ref, rows[4].ref].sort());
    expect((mockMemStore.mock.calls[0] as any[])[3]).toMatchObject({ userId: 'u1', skipCap: true, skipGate: true });
    expect(n).toBe(4);
    // a byte-identical second write is a hash no-op
    await embedSupervisorStateDoc(CHAT, doc(), { userId: 'u1' });
    expect(mockMemListRefs).toHaveBeenCalledTimes(1);
  });

  it('an unreadable store listing stores NOTHING and caches nothing (never reads "empty" into it)', async () => {
    const C2 = 'cccccccc-3333-3333-3333-333333333333';
    mockMemListRefs.mockResolvedValueOnce(null);
    expect(await embedSupervisorStateDoc(C2, doc())).toBe(0);
    expect(mockMemStore).not.toHaveBeenCalled();
    expect(mockMemDeleteRefs).not.toHaveBeenCalled();
    mockMemListRefs.mockResolvedValueOnce([]);
    expect(await embedSupervisorStateDoc(C2, doc())).toBe(5); // retried on the next write
  });

  it("row identity: per-row ref first, else the legacy title; visibility needs the row's OWN rendering", () => {
    expect(supervisorStateRowKeyOfHit({ ref: 'directive 0d4e1a2b-1111-2222-3333-44 @2026-10-01T00:00:00Z #abc', title: 'x' })).toEqual({ kind: 'directive', id: '0d4e1a2b-1111-2222-3333-44' });
    expect(supervisorStateRowKeyOfHit({ ref: 'supervisor-state', title: 'Archived directive [0d4e1a2b] (open)' })).toEqual({ kind: 'directive', id: '0d4e1a2b' });
    expect(supervisorStateRowKeyOfHit({ ref: 'supervisor-state', title: 'Dispatch session → 11111111-aaaa' })).toEqual({ kind: 'dispatch', id: '11111111-aaaa' });
    expect(supervisorStateRowKeyOfHit({ ref: 'supervisor-state', title: 'something else' })).toBeNull();
    const wake = '- [0d4e1a2b-1111-2222-3333-444455556666] (2h ago) keep the backups\n- 2026-10-17T01:00:00Z session → 11111111-1111-1111-1111-111111111111 — spawned';
    expect(supervisorStateRowVisible({ kind: 'directive', id: '0d4e1a2b-1111-2222-3333-44' }, wake)).toBe(true);
    expect(supervisorStateRowVisible({ kind: 'directive', id: '0d4e1a2b' }, wake)).toBe(true);
    expect(supervisorStateRowVisible({ kind: 'dispatch', id: '11111111-1111-1111-1111-' }, wake)).toBe(true);
    // a lane's 8-char prefix in the ledger diff is not the dispatch record
    expect(supervisorStateRowVisible({ kind: 'dispatch', id: '22222222-2222-2222-2222-' }, 'Lane runs: finished 1 (22222222 "x")')).toBe(false);
    // a 2-char model id never hides a row by coincidence
    expect(supervisorStateRowVisible({ kind: 'directive', id: 'd1' }, '- [d10] (1h ago) x')).toBe(false);
    expect(supervisorStateRowVisible({ kind: 'directive', id: 'd1' }, '- [d1] (1h ago) x')).toBe(true);
  });

  it("the recall block over-fetches, drops rows the wake already shows, and orders by the row's OWN time", async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'directive aaaaaaaa-0000-0000-0000-00 @2026-10-18T00:00:00Z #1', title: 'Directive [aaaaaaaa] (open)', content: 'VISIBLE order already in the wake', createdAt: '2026-10-20T00:00:00Z' },
      { ref: 'directive bbbbbbbb-0000-0000-0000-00 @2026-09-01T00:00:00Z #2', title: 'Archived directive [bbbbbbbb] (open)', content: 'an archived order about the GPU budget', createdAt: '2026-10-20T00:00:00Z' },
      { ref: 'dispatch cccccccc-0000-0000-0000-00 @2026-10-15T00:00:00Z #3', title: 'Dispatch session → cccccccc', content: 'a trimmed dispatch to the bench lane', createdAt: '2026-10-20T00:00:00Z' },
    ] as any);
    const visible = '- [aaaaaaaa-0000-0000-0000-000000000000] (1h ago) VISIBLE order';
    const block = await buildSupervisorStateRecallBlock(CHAT, 'Owner messages: GPU budget', 5, { visibleText: visible });
    expect((mockMemSearch.mock.calls[0] as any[])[2]).toBe(15);
    expect(block).not.toContain('VISIBLE order already in the wake');
    expect(block).toContain('does NOT show');
    // the trimmed dispatch (10-15) is newer than the archived order (09-01), though both were stored at the same time
    expect(block.indexOf('trimmed dispatch')).toBeGreaterThan(-1);
    expect(block.indexOf('trimmed dispatch')).toBeLessThan(block.indexOf('archived order'));
  });

  it('k keeps the MOST RELEVANT survivors (search order) before re-ordering them by row time', async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'directive r1-most-relevant-0000000000 @2026-09-01T00:00:00Z #1', title: 'Directive [r1] (open)', content: 'most relevant but old', createdAt: '2026-10-20T00:00:00Z' },
      { ref: 'directive r2-second-relevant-00000000 @2026-09-02T00:00:00Z #2', title: 'Directive [r2] (open)', content: 'second relevant', createdAt: '2026-10-20T00:00:00Z' },
      { ref: 'directive r3-least-relevant-000000000 @2026-10-19T00:00:00Z #3', title: 'Directive [r3] (open)', content: 'least relevant but newest', createdAt: '2026-10-20T00:00:00Z' },
    ] as any);
    const block = await buildSupervisorStateRecallBlock(CHAT, 'q', 2, { visibleText: 'nothing visible' });
    expect(block).toContain('most relevant but old');
    expect(block).toContain('second relevant');
    expect(block).not.toContain('least relevant but newest');
    expect(block.indexOf('second relevant')).toBeLessThan(block.indexOf('most relevant but old')); // newest first among the kept
  });

  it('every hit already visible ⇒ no block at all', async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'directive aaaaaaaa-0000-0000-0000-00 @2026-10-18T00:00:00Z #1', title: 'Directive [aaaaaaaa] (open)', content: 'VISIBLE', createdAt: '2026-10-20T00:00:00Z' },
    ] as any);
    expect(await buildSupervisorStateRecallBlock(CHAT, 'q', 5, { visibleText: '- [aaaaaaaa-0000-0000-0000-000000000000] (1h ago) VISIBLE' })).toBe('');
  });

  it('no visibleText passed: the block renders the state doc itself to know what the turn sees (human-turn seam)', async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'directive dddddddd-0000-0000-0000-00 @2026-10-18T00:00:00Z #1', title: 'Directive [dddddddd] (done)', content: 'a closed order the wake does not show', createdAt: '2026-10-20T00:00:00Z' },
    ] as any);
    const block = await buildSupervisorStateRecallBlock(CHAT, 'what did the owner order', 5);
    expect(block).toContain('a closed order the wake does not show');
  });
});

// ── Review fixes (2026-10-20) ────────────────────────────────────────────────
describe('MIND-HYGIENE recall — review fixes', () => {
  const CHAT = 'eeeeeeee-5555-5555-5555-555555555555';
  // Re-read per test: an earlier describe calls jest.resetModules(), so the module registry (and
  // the mocked prisma instance a dynamic import resolves to) is replaced after collection time.
  let prismaMock: { crossModelChat: { findUnique: jest.Mock } };
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock = jest.requireMock('../../../config/database').default;
    delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED;
    delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
    prismaMock.crossModelChat.findUnique.mockReset();
    mockLoadKpis.mockReset().mockResolvedValue([]);
  });

  it("supervisorStateRowHidden: an owner ask the wake shows without its id (or hides on purpose) counts as visible — directives only, prefix rule for ≥ 8 chars", () => {
    const hidden = ['a5a5a5a5-1111-2222-3333-444455556666'];
    expect(supervisorStateRowHidden({ kind: 'directive', id: 'a5a5a5a5-1111-2222-3333-44' }, hidden)).toBe(true);
    expect(supervisorStateRowHidden({ kind: 'directive', id: 'a5a5a5a5' }, hidden)).toBe(true);
    expect(supervisorStateRowHidden({ kind: 'directive', id: 'b6b6b6b6' }, hidden)).toBe(false);
    expect(supervisorStateRowHidden({ kind: 'dispatch', id: 'a5a5a5a5' }, hidden)).toBe(false);
    expect(supervisorStateRowHidden({ kind: 'directive', id: 'a5' }, hidden)).toBe(false); // a short id must match whole
    expect(supervisorStateRowHidden({ kind: 'directive', id: 'q1' }, ['q1'])).toBe(true);
    expect(supervisorStateRowHidden({ kind: 'directive', id: 'a5a5a5a5' }, undefined)).toBe(false);
  });

  it('an answered-not-closed owner ask hidden from the wake (hideAskIds) never comes back as a retrieved open directive', async () => {
    mockMemSearch.mockResolvedValueOnce([
      { ref: 'directive a5a5a5a5-1111-2222-3333-44 @2026-10-19T10:00:00Z #1', title: 'Directive [a5a5a5a5] (open)', content: 'Owner ask: is the GPU budget raised yet?', createdAt: '2026-10-20T00:00:00Z' },
      { ref: 'directive c7c7c7c7-1111-2222-3333-44 @2026-10-10T10:00:00Z #2', title: 'Archived directive [c7c7c7c7] (open)', content: 'an archived order about the GPU budget', createdAt: '2026-10-20T00:00:00Z' },
    ] as any);
    const block = await buildSupervisorStateRecallBlock(CHAT, 'Owner messages: "is the GPU budget raised yet?"', 5, {
      visibleText: '[SINCE YOUR LAST WAKE]\nOwner messages: "is the GPU budget raised yet?"', hiddenIds: ['a5a5a5a5-1111-2222-3333-444455556666'],
    });
    expect(block).not.toContain('is the GPU budget raised yet?');
    expect(block).toContain('an archived order about the GPU budget');
  });

  it('dedupeRecallHits collapses a cross-process double insert to one hit, so it never spends two of the k slots', async () => {
    const dup = { ref: 'directive d8d8d8d8-1111-2222-3333-44 @2026-10-18T00:00:00Z #9', title: 'Directive [d8d8d8d8] (open)', content: 'a trimmed order', createdAt: '2026-10-20T00:00:00Z' };
    const other = { ref: 'dispatch e9e9e9e9-1111-2222-3333-44 @2026-10-17T00:00:00Z #8', title: 'Dispatch session → e9e9e9e9', content: 'a trimmed dispatch', createdAt: '2026-10-20T00:00:00Z' };
    expect(dedupeRecallHits([dup, { ...dup }, other])).toEqual([dup, other]);
    // legacy batch rows share ONE ref — they are distinct rows, never collapsed
    expect(dedupeRecallHits([{ ref: 'supervisor-state', title: 'A', content: 'x' }, { ref: 'supervisor-state', title: 'B', content: 'y' }])).toHaveLength(2);
    mockMemSearch.mockResolvedValueOnce([dup, { ...dup }, other] as any);
    const block = await buildSupervisorStateRecallBlock(CHAT, 'q', 2, { visibleText: 'nothing visible' });
    expect(block.match(/a trimmed order/g)).toHaveLength(1);
    expect(block).toContain('a trimmed dispatch'); // the slot the duplicate would have taken
  });

  it('human seam: the render mirrors the owner-turn block — the same KPI annotation (fleet scope for the Fleet Supervisor, project scope for a project supervisor)', async () => {
    prismaMock.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: true, isProjectSupervisor: false, userId: 'u1', projectId: null });
    await renderedStateText(CHAT, {});
    expect(mockLoadKpis).toHaveBeenCalledWith({ projectId: null, userId: 'u1', fleet: true });
    prismaMock.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: false, isProjectSupervisor: true, userId: 'u2', projectId: 'p9' });
    await renderedStateText(CHAT, {});
    expect(mockLoadKpis).toHaveBeenLastCalledWith({ projectId: 'p9', userId: 'u2', fleet: false });
    // a failed chat-row read renders without KPIs (never throws)
    prismaMock.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(renderedStateText(CHAT, {})).resolves.toEqual(expect.any(String));
  });
});
