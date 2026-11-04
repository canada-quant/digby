/**
 * fs-durable-memory (2026-10-22, rank #5a of the Fleet Supervisor context map):
 * the supervisor ledger's 50-row cap DELETED done / answered rows — an owner
 * remark ledgered as kind:'ask', answered on the next reply, then evicted a
 * week later — and the memory mirror deleted their digby_memory rows with
 * them, so the owner's words were gone from the ledger AND from search. The
 * cap now moves them to doc.archived (archivedAt stamped, bounded by
 * MAX_ARCHIVED with oldest CLOSED rows trimmed first) and the mirror keeps a
 * row for them. SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED=1 restores the
 * delete-at-cap.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn(), findMany: jest.fn(async () => []) },
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  crossModelMessage: { findUnique: jest.fn(async () => ({ content: 'Here is the answer: the H100 box is retired.' })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
// The memory mirror is dynamically imported by upsertDoc — keep it inert here
// (supervisorStateMemRows is exercised directly below, against the real module).
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memDeleteRefs: jest.fn(async () => 0),
  memListRefs: jest.fn(async () => []),
  memReplaceRef: jest.fn(async () => 0),
  memSearch: jest.fn(async () => []),
  memStore: jest.fn(async () => 0),
}));

import {
  appendDirective,
  closeAskOnReply,
  capDirectivesIntoArchive,
  evictDirectivesAtCap,
  trimArchive,
  formatStateForWake,
  SupervisorDirective,
  SupervisorStateDoc,
} from './supervisor-state.service';
import { supervisorStateMemRows } from './supervisor-state-memory';

const CHAT = 'fs-chat-1';
const UID = 'owner-1';

let table: Map<string, unknown>;
const stored = (): SupervisorStateDoc => table.get(CHAT) as SupervisorStateDoc;
const fresh = () => new Date().toISOString();
const d = (over: Partial<SupervisorDirective>): SupervisorDirective =>
  ({ id: 'x', text: 'some directive text', at: fresh(), status: 'open', ...over });
const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED;
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ isSupervisor: true, project: null });
});
afterAll(() => { delete process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED; });

/** A full live ledger: one answered owner ask (oldest) + 49 open rows. */
function fullLedger(): SupervisorStateDoc {
  const rows: SupervisorDirective[] = [
    d({ id: 'ask-answered-1', text: 'we decided the H100 box is retired — do not schedule on it', kind: 'ask', origin: 'owner', status: 'answered', evidence: 'msg reply001', messageId: 'owner-msg-0001' }),
  ];
  for (let i = 0; i < 49; i++) rows.push(d({ id: `open-${i}`, text: `open order number ${i}`, standing: true }));
  return { ...EMPTY, directives: rows };
}

describe('capDirectivesIntoArchive (pure)', () => {
  it('moves the closed rows the cap drops into the archive with archivedAt; open rows stay live', () => {
    const doc = { directives: [d({ id: 'done-1', status: 'done' }), d({ id: 'open-1' }), d({ id: 'ans-1', kind: 'ask', status: 'answered' }), d({ id: 'open-2' })], archived: [] };
    const now = new Date('2026-10-22T12:00:00.000Z');
    const r = capDirectivesIntoArchive(doc, now, 2);
    expect(r.directives.map((x) => x.id)).toEqual(['open-1', 'open-2']);
    expect(r.archived.map((x) => x.id)).toEqual(['done-1', 'ans-1']);
    expect(r.archived.every((x) => x.archivedAt === now.toISOString())).toBe(true);
    expect(r.archivedCount).toBe(2);
    expect(r.overflow).toBe(0);
  });

  it('evictDirectivesAtCap reports what it dropped', () => {
    const r = evictDirectivesAtCap([d({ id: 'a', status: 'done' }), d({ id: 'b' }), d({ id: 'c' })], 2);
    expect(r.evicted.map((x) => x.id)).toEqual(['a']);
  });

  it('a full archive trims its oldest CLOSED rows first — an archived-but-open order survives', () => {
    const archived = [d({ id: 'open-old' }), ...Array.from({ length: 4 }, (_, i) => d({ id: `closed-${i}`, status: 'done' }))];
    const kept = trimArchive([...archived, d({ id: 'closed-new', status: 'done' })], 4);
    expect(kept.map((x) => x.id)).toEqual(['open-old', 'closed-2', 'closed-3', 'closed-new']);
  });

  it('kill switch: the cap deletes again and the archive is a plain newest-N slice', () => {
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
    const r = capDirectivesIntoArchive({ directives: [d({ id: 'done-1', status: 'done' }), d({ id: 'open-1' })], archived: [] }, new Date(), 1);
    expect(r.directives.map((x) => x.id)).toEqual(['open-1']);
    expect(r.archived).toEqual([]);
    expect(r.archivedCount).toBe(0);
    expect(trimArchive([d({ id: 'open-old' }), d({ id: 'c1', status: 'done' }), d({ id: 'c2', status: 'done' })], 2).map((x) => x.id)).toEqual(['c1', 'c2']);
  });
});

describe('the ledger cap on a real write keeps the answered owner ask', () => {
  it('appendDirective at the 50-row cap archives the answered ask (not deleted) and records directive_cap_archive', async () => {
    table.set(CHAT, fullLedger());
    await appendDirective(CHAT, UID, 'From now on always open a PR before merging anything to main.');
    const doc = stored();
    expect(doc.directives.find((x) => x.id === 'ask-answered-1')).toBeUndefined();
    const arch = doc.archived.find((x) => x.id === 'ask-answered-1');
    expect(arch).toBeDefined();
    expect(arch!.status).toBe('answered');
    expect(arch!.text).toContain('H100 box is retired');
    expect(typeof arch!.archivedAt).toBe('string');
    expect(doc.directives).toHaveLength(50);
    await new Promise((r) => setImmediate(r));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_cap_archive', sessionId: CHAT, value: 1 }));
  });

  it('the memory mirror still holds a row for the cap-archived ask (with its reply evidence and owner msg)', async () => {
    table.set(CHAT, fullLedger());
    await appendDirective(CHAT, UID, 'From now on always open a PR before merging anything to main.');
    const rows = supervisorStateMemRows(stored());
    const row = rows.find((r) => String(r.ref).startsWith('directive ask-answered-1'));
    expect(row).toBeDefined();
    expect(row!.title).toContain('Archived directive');
    expect(row!.content).toContain('H100 box is retired');
    expect(row!.content).toContain('evidence: msg reply001');
    expect(row!.content).toContain('owner msg owner-ms');
  });

  it('end to end: an ask closed on reply and then pushed past the cap stays in the archive', async () => {
    table.set(CHAT, { ...EMPTY, directives: [d({ id: 'ask-1', text: 'we moved billing to the new Stripe account last week', kind: 'ask', origin: 'owner', messageId: 'm-ask-1' })] });
    expect(await closeAskOnReply(CHAT, UID, { askMessageId: 'm-ask-1', replyMessageId: 'reply-0001' })).toBe(true);
    const doc = stored();
    for (let i = 0; i < 50; i++) doc.directives.push(d({ id: `o-${i}`, standing: true }));
    table.set(CHAT, doc);
    await appendDirective(CHAT, UID, 'From now on always open a PR before merging anything to main.');
    expect(stored().archived.map((x) => x.id)).toContain('ask-1');
  });

  it('kill switch: the answered ask is deleted at the cap (old behaviour) and leaves the mirror', async () => {
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
    table.set(CHAT, fullLedger());
    await appendDirective(CHAT, UID, 'From now on always open a PR before merging anything to main.');
    const doc = stored();
    expect([...doc.directives, ...doc.archived].find((x) => x.id === 'ask-answered-1')).toBeUndefined();
    expect(supervisorStateMemRows(doc).find((r) => String(r.ref).startsWith('directive ask-answered-1'))).toBeUndefined();
  });
});

describe('wake block archive line', () => {
  it('says how many archived rows are closed cap moves vs aged open orders', () => {
    const doc: SupervisorStateDoc = { ...EMPTY, archived: [d({ id: 'old-open', archivedAt: fresh() }), d({ id: 'ans', kind: 'ask', status: 'answered', archivedAt: fresh() })] };
    const text = formatStateForWake(doc, new Date());
    expect(text).toContain('2 older directive(s) ARCHIVED (1 open > 7 d while this ledger was long, 1 closed (done / answered) moved out at the 50-row cap; kept and searchable, up to 200 closed rows — the oldest closed rows go first)');
    // review 2026-10-22: the line never claims "nothing deleted" (the archive IS bounded).
    expect(text).not.toMatch(/nothing (is )?deleted/);
  });

  it('the cold-archive count joins the line (no cold read per wake)', () => {
    const doc: SupervisorStateDoc = { ...EMPTY, archived: [d({ id: 'old-open', archivedAt: fresh() }), d({ id: 'ans', kind: 'ask', status: 'answered', archivedAt: fresh() })], archivedColdCount: 150 };
    expect(formatStateForWake(doc, new Date())).toContain('152 older directive(s) ARCHIVED (1 open > 7 d while this ledger was long, 151 closed (done / answered) moved out');
  });

  it('an all-open archive renders the open-only line (also under the switch — the counts are read from the rows)', () => {
    const doc: SupervisorStateDoc = { ...EMPTY, archived: [d({ id: 'old-open', archivedAt: fresh() })] };
    const text = formatStateForWake(doc, new Date());
    expect(text).toContain('1 older directive(s) ARCHIVED (open > 7 d while this ledger was long; out of this block, still listed and searchable)');
    expect(text).not.toMatch(/nothing (is )?deleted/);
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
    expect(formatStateForWake(doc, new Date())).toContain('1 older directive(s) ARCHIVED (open > 7 d while this ledger was long; out of this block, still listed and searchable)');
  });
});
