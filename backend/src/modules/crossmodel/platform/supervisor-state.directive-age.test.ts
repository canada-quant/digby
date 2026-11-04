/**
 * Directive age alarm + closure receipt-match (supervisor-directives-closure
 * D2, 2026-09-27) — supervisor-state.service pins.
 *
 *  - unactedDirectives: OPEN, non-standing, NO evidence, age ≥ threshold —
 *    live AND archived rows, oldest first; done / standing / evidenced /
 *    undated / young rows never qualify.
 *  - formatStateForWake: the DIRECTIVE AGE ALARM line names the count, the
 *    oldest ids, the archived-but-open share and the two ways to clear it;
 *    absent when nothing is overdue; it survives the wake-block trim.
 *  - applyStateUpdate receipt-match: a pr/receipt/run/deploy close whose id
 *    matches no receipt of this chat and no dispatch id LANDS (observe-only)
 *    with an UNRECEIPTED ack + one directive_close_unreceipted row; a matching
 *    receipt or a dispatch-ledger id passes silently; a receipts read error is
 *    fail-open.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  projectTodo: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  agentRun: { groupBy: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
  // The ACCOUNT-wide pr probe (review fix): any ok receipt of this owner carrying ids.prNumber.
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
const mockGetRecentChatReceipts = jest.fn(async (_chatId: string, _sinceMs?: number) => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));
jest.mock('./action-verifier', () => {
  const actual = jest.requireActual('./action-verifier');
  return {
    ...actual,
    citedMessageRowExists: jest.fn(async () => true),
    citedScheduleRowExists: jest.fn(async () => true),
    samePrefixRealIds: jest.fn(async () => []),
  };
});

import {
  applyStateUpdate,
  formatStateForWake,
  directiveAgeAlarmLine,
  unactedDirectives,
  evidenceRefInReceipts,
  prReceiptExistsInAccount,
  RECEIPT_MATCHED_EVIDENCE_TYPES,
  ACCOUNT_MATCHED_EVIDENCE_TYPES,
  DIRECTIVE_AGE_ALARM_MS,
  DIRECTIVE_FOLLOW_THROUGH_MS,
  SupervisorStateDoc,
} from './supervisor-state.service';

const CHAT = 'sup-chat-1';
const UID = 'u1';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const dir = (id: string, ageH: number, extra: Partial<SupervisorStateDoc['directives'][number]> = {}) => ({
  id, text: `order ${id}`, at: hoursAgo(ageH), status: 'open' as const, ...extra,
});

let table: Map<string, unknown>;
const stored = (): SupervisorStateDoc => table.get(CHAT) as SupervisorStateDoc;

beforeEach(() => {
  jest.clearAllMocks();
  table = new Map();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.runToolReceipt.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
});

describe('unactedDirectives', () => {
  it('returns OPEN, non-standing, evidence-less rows past the threshold — live and archived — oldest first', () => {
    const doc: SupervisorStateDoc = {
      ...EMPTY,
      directives: [
        dir('young', 10),
        dir('old-a', 60),
        dir('standing', 200, { standing: true }),
        dir('done', 200, { status: 'done', evidence: 'pr #1' }),
        dir('evidenced', 200, { evidence: 'blocked: waiting on oq_12345678' }),
        dir('undated', 0, { at: '' }),
      ],
      archived: [dir('arch-open', 300, { archivedAt: hoursAgo(1) }), dir('arch-done', 300, { status: 'done', evidence: 'session abc12345' })],
    };
    const rows = unactedDirectives(doc, NOW, DIRECTIVE_AGE_ALARM_MS);
    expect(rows.map((r) => r.id)).toEqual(['arch-open', 'old-a']);
    expect(rows[0].archived).toBe(true);
    expect(rows[1].archived).toBe(false);
    expect(rows[1].ageMs).toBe(60 * 3_600_000);
    // The 24h follow-through threshold admits the same set here (young is 10h).
    expect(unactedDirectives(doc, NOW, DIRECTIVE_FOLLOW_THROUGH_MS).map((r) => r.id)).toEqual(['arch-open', 'old-a']);
    // Threshold 0 admits the 10h row too.
    expect(unactedDirectives(doc, NOW, 0).map((r) => r.id)).toEqual(['arch-open', 'old-a', 'young']);
  });
});

describe('formatStateForWake — DIRECTIVE AGE ALARM line', () => {
  it('names the count, the oldest ids with ages, the archived-but-open share, and how to clear it', () => {
    const doc: SupervisorStateDoc = {
      ...EMPTY,
      directives: [dir('aaaaaaaa-1', 60), dir('bbbbbbbb-1', 49), dir('cccccccc-1', 5)],
      archived: [dir('dddddddd-1', 400, { archivedAt: hoursAgo(1) })],
    };
    const block = formatStateForWake(doc, NOW);
    const line = directiveAgeAlarmLine(doc, NOW);
    expect(line).toMatch(/^- DIRECTIVE AGE ALARM: 3 directive\(s\) open >48h with NO evidence recorded/);
    expect(line).toContain('dddddddd 16d archived, aaaaaaaa 2d, bbbbbbbb 2d');
    expect(line).toContain('1 archived-but-open');
    expect(line).toContain("evidence:'blocked:");
    expect(block).toContain(line);
    // The 5h row is listed as open but is NOT in the alarm.
    expect(line).not.toContain('cccccccc');
    expect(block).toContain('[cccccccc-1]');
  });

  it('is absent when nothing is overdue', () => {
    const doc: SupervisorStateDoc = { ...EMPTY, directives: [dir('a', 10), dir('b', 100, { evidence: 'blocked: oq_1234abcd' }), dir('c', 100, { standing: true })] };
    expect(directiveAgeAlarmLine(doc, NOW)).toBe('');
    expect(formatStateForWake(doc, NOW)).not.toContain('DIRECTIVE AGE ALARM');
    const overdue: SupervisorStateDoc = { ...EMPTY, directives: [dir('a', 100)] };
    expect(directiveAgeAlarmLine(overdue, NOW)).toContain('DIRECTIVE AGE ALARM');
  });

  it('survives the wake-block trim (a long ledger drops directive rows, never the alarm line)', () => {
    const directives = Array.from({ length: 40 }, (_, i) => dir(`d${String(i).padStart(2, '0')}-${'x'.repeat(30)}`, 100 + i, { text: 'y'.repeat(400) }));
    const block = formatStateForWake({ ...EMPTY, directives }, NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    expect(block).toContain('DIRECTIVE AGE ALARM: 40 directive(s)');
    expect(block).toContain('NOT shown');
  });
});

describe('evidenceRefInReceipts (pure, DB-shaped rows: id + ids only — heads are never persisted)', () => {
  it('matches a pr ref by ids.prNumber only; receipt/run by the row id prefix, an ids substring, or a dispatch id', () => {
    const receipts = [
      { id: 'a0a0a0a0-1111-4222-8333-444455556666', tool: 'open_pull_request', ids: { prNumber: 215, url: 'https://github.com/x/y/pull/215' } },
      { id: 'b1b1b1b1-1111-4222-8333-444455556666', tool: 'run_command', ids: {} },
      { id: 'c2c2c2c2-1111-4222-8333-444455556666', tool: 'start_coding_session', ids: { chatId: 'feedface-0000-4000-8000-000000000000' } },
    ];
    const dispatches = [{ at: '', kind: 'start_coding_session', id: 'deadbeef-1111-4222-8333-444455556666' }];
    expect(evidenceRefInReceipts({ type: 'pr', id: '215' }, receipts, [])).toBe(true);
    expect(evidenceRefInReceipts({ type: 'pr', id: '#215' }, receipts, [])).toBe(true);
    expect(evidenceRefInReceipts({ type: 'pr', id: '21' }, receipts, [])).toBe(false);
    expect(evidenceRefInReceipts({ type: 'pr', id: '999' }, receipts, [])).toBe(false);
    // A pr number never matches a receipt row id or an ids substring (the url carries "215" — only prNumber counts).
    expect(evidenceRefInReceipts({ type: 'pr', id: '215' }, [{ id: 'x', tool: 'run_command', ids: { url: 'https://github.com/x/y/pull/215' } }], [])).toBe(false);
    expect(evidenceRefInReceipts({ type: 'run', id: 'deadbeef' }, [], dispatches)).toBe(true);
    expect(evidenceRefInReceipts({ type: 'run', id: 'feedface' }, receipts, [])).toBe(true); // ids substring
    expect(evidenceRefInReceipts({ type: 'receipt', id: 'b1b1b1b1' }, receipts, [])).toBe(true); // row id prefix
    expect(evidenceRefInReceipts({ type: 'receipt', id: 'cafebabe' }, receipts, dispatches)).toBe(false);
    expect(evidenceRefInReceipts({ type: 'receipt', id: 'b1b1b' }, receipts, [])).toBe(false); // <6 chars: exact only
  });
});

describe('prReceiptExistsInAccount (fail-open account-wide pr probe)', () => {
  it('asks for an ok receipt of any chat of this owner with ids.prNumber = N; null ⇒ false, a row ⇒ true, no client / throw ⇒ undefined', async () => {
    mockPrisma.runToolReceipt.findFirst.mockResolvedValue(null);
    expect(await prReceiptExistsInAccount(UID, '215')).toBe(false);
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledWith({
      where: { ok: true, ids: { path: ['prNumber'], equals: 215 }, chat: { userId: UID } },
      select: { id: true },
    });
    mockPrisma.runToolReceipt.findFirst.mockResolvedValue({ id: 'r1' });
    expect(await prReceiptExistsInAccount(UID, '215')).toBe(true);
    expect(await prReceiptExistsInAccount(UID, 'abc')).toBe(false); // not a PR number — never probed
    mockPrisma.runToolReceipt.findFirst.mockRejectedValue(new Error('db down'));
    expect(await prReceiptExistsInAccount(UID, '215')).toBeUndefined();
    const saved = mockPrisma.runToolReceipt;
    delete mockPrisma.runToolReceipt;
    expect(await prReceiptExistsInAccount(UID, '215')).toBeUndefined();
    mockPrisma.runToolReceipt = saved;
  });
});

describe('applyStateUpdate — closure receipt-match', () => {
  const seed = () => table.set(CHAT, { ...EMPTY, directives: [{ id: 'd1', text: 'move the H100 job', at: hoursAgo(50), status: 'open' }] });

  it('only receipt/run are chat-matched and only pr is account-matched; deploy is matched nowhere (nothing persists it)', () => {
    expect([...RECEIPT_MATCHED_EVIDENCE_TYPES].sort()).toEqual(['receipt', 'run']);
    expect([...ACCOUNT_MATCHED_EVIDENCE_TYPES]).toEqual(['pr']);
  });

  it('OBSERVE-ONLY by default: a pr close matching no chat receipt, dispatch id, or account PR receipt LANDS with a NEUTRAL UNRECEIPTED ack and one honest directive_close_unreceipted row', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'pr #215' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
    const ack = r.applied.join(' ');
    expect(ack).toMatch(/directive d1 closed UNRECEIPTED \(observed only — the close stands\): evidence pr 215 was found in none of this chat's receipts \(last 30 d\), its dispatch ledger, or this account's PR receipts/);
    expect(ack).not.toMatch(/unbacked|fabricat/i); // neutral — the doctrine lists a PR# as valid evidence
    expect(mockGetRecentChatReceipts).toHaveBeenCalledWith(CHAT, expect.any(Number));
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ok: true, ids: { path: ['prNumber'], equals: 215 }, chat: { userId: UID } } }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'directive_close_unreceipted', sessionId: CHAT,
      meta: { directiveId: 'd1', refs: ['pr 215'], outcome: 'observed', matchable: true, scope: { pr: 'account' } },
    }));
  });

  it('a pr opened by ANY lane of this account (ids.prNumber receipt) passes silently — a supervisor never mints one itself', async () => {
    seed();
    mockPrisma.runToolReceipt.findFirst.mockResolvedValue({ id: 'lane-receipt' });
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'pr #215' }] });
    expect(r.errors).toEqual([]);
    expect(r.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_close_unreceipted' }));
    // Probe unavailable (no client shape) ⇒ fail-open, silent.
    seed();
    const saved = mockPrisma.runToolReceipt;
    delete mockPrisma.runToolReceipt;
    const r2 = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'pr #215' }] });
    mockPrisma.runToolReceipt = saved;
    expect(r2.errors).toEqual([]);
    expect(r2.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
  });

  it('a deploy close is never receipt-matched (format-only, as before) — no receipts read, no row', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'deploy 36209251894' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
    expect(r.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
    expect(mockGetRecentChatReceipts).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_close_unreceipted' }));
  });

  it('a receipt/run id in THIS chat\'s receipts passes silently; so does a dispatch-ledger id; an unmatched one is observed at chat scope', async () => {
    seed();
    mockGetRecentChatReceipts.mockResolvedValue([{ id: 'cafebabe-1111-4222-8333-444455556666', tool: 'send_chat_message', ids: {} }]);
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'receipt cafebabe' }] });
    expect(r.errors).toEqual([]);
    expect(r.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_close_unreceipted' }));
    seed();
    mockGetRecentChatReceipts.mockResolvedValue([]);
    const r1 = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'receipt cafebabe' }] });
    expect(r1.errors).toEqual([]);
    expect(r1.applied.join(' ')).toMatch(/closed UNRECEIPTED .*evidence receipt cafebabe was found in none of this chat's receipts \(last 30 d\), its dispatch ledger\./);
    expect(mockPrisma.runToolReceipt.findFirst).not.toHaveBeenCalled(); // the account probe is pr-only
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ refs: ['receipt cafebabe'], scope: { receipt: 'chat' } }) }));
    // Dispatch ledger: the real tool-returned id recorded on a prior wake.
    table.set(CHAT, { ...EMPTY, directives: [{ id: 'd2', text: 'x', at: hoursAgo(5), status: 'open' }], dispatches: [{ at: hoursAgo(4), kind: 'start_coding_session', id: 'feedface-0000-4000-8000-000000000000' }] });
    mockGetRecentChatReceipts.mockResolvedValue([]);
    const r2 = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd2', status: 'done', evidence: 'run feedface' }] });
    expect(r2.errors).toEqual([]);
    expect(r2.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
  });

  it('a receipts read ERROR is fail-open', async () => {
    seed();
    mockGetRecentChatReceipts.mockRejectedValue(new Error('redis down'));
    const r2 = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'pr #215' }] });
    expect(r2.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
    expect(r2.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
  });

  it('existence-checked types (session/ticket/msg/oq) are never receipt-matched — a session close stays silent', async () => {
    seed();
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: '1a2b3c4d-full' });
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'session 1a2b3c4d' }] });
    expect(r.errors).toEqual([]);
    expect(r.applied.join(' ')).not.toMatch(/UNRECEIPTED/);
    expect(mockGetRecentChatReceipts).not.toHaveBeenCalled();
  });

  it('recording a blocker as evidence on an OPEN row clears the age alarm without closing', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', evidence: 'blocked: H100 pool is full — asked in oq_12345678' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('open');
    expect(stored().directives[0].evidence).toMatch(/blocked: H100/);
    expect(directiveAgeAlarmLine(stored(), NOW)).toBe('');
  });
});
