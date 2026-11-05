/**
 * 2026-10-20 — two supervisor directive-ledger defects.
 *
 * (b) The 7-day archive hid an OPEN OWNER ORDER: the 2026-10-12 standing
 *     ruling answering oq_68d001e9 ("the digby defaults shouldnt be on litellm
 *     cql …") moved to `archived` on 2026-10-19T19:35Z still open and vanished
 *     from the wake view. Pins: owner-origin open orders never archive; an
 *     already-archived one is restored on read / write (with a metric); the
 *     wake block's last-resort trim drops machine rows before owner rows; the
 *     kill switch DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED=1 restores the old rule.
 *
 * (a) A fleet-scope owner RULING given as an owner-question answer or as the
 *     note on an owner-dismissed card was never ledgered (specimen
 *     oq_892c91ae: "no new Hyperstack IP, ever — the account is shutting down;
 *     canlegalbench.com comes back from the stanne lab"). Pins: the
 *     deterministic classifier (the two specimens rule, choices / questions /
 *     remarks do not), the OPEN owner-origin standing 'fleet' row, idempotence,
 *     secret redaction and OWNER_RULING_CAPTURE_DISABLED=1.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  appendOwnerRulingDirective,
  archiveStaleDirectives,
  classifyOwnerRuling,
  formatStateForWake,
  getSupervisorState,
  ownerRulingDirectiveId,
  readSupervisorStateSection,
  DIRECTIVE_ARCHIVE_MIN_OPEN,
  SupervisorStateDoc,
  SupervisorDirective,
} from './supervisor-state.service';

const CHAT = 'fleet-sup-1';
const UID = 'u1';
const day = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now() - 60_000);

let table: Map<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED;
  delete process.env.OWNER_RULING_CAPTURE_DISABLED;
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ isSupervisor: true });
});

afterAll(() => {
  delete process.env.DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED;
  delete process.env.OWNER_RULING_CAPTURE_DISABLED;
});

const flush = () => new Promise((r) => setImmediate(r));
const stored = (): SupervisorStateDoc => table.get(CHAT) as SupervisorStateDoc;
const base = (directives: SupervisorDirective[], archived: SupervisorDirective[] = []): SupervisorStateDoc =>
  ({ directives, archived, dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' });
const mk = (n: number, ageDays: number, prefix: string, extra: Partial<SupervisorDirective> = {}): SupervisorDirective[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${ageDays}d-${i}`, text: `${prefix} directive ${ageDays}d #${i}`,
    at: new Date(NOW.getTime() - ageDays * day - i * 1000).toISOString(), status: 'open' as const, ...extra,
  }));

const SPECIMEN_LITELLM = 'the digby defaults shouldnt be on litellm cql any way they should all be using the github environment secrets as defaults always';
const SPECIMEN_HYPERSTACK = 'no new Hyperstack IP, ever — the account is shutting down; canlegalbench.com comes back from the stanne lab';

// ── (b) the archive never hides an open owner order ──────────────────────────

describe('archive keeps open owner-origin orders live', () => {
  it('a 12-day open owner order (origin owner / owner_question) never archives; machine rows age out around it', () => {
    const owner = mk(1, 12, 'own', { origin: 'owner' });
    const ruling = mk(1, 13, 'oq', { origin: 'owner_question' });
    const machine = mk(20, 12, 'mac');
    const { doc, moved } = archiveStaleDirectives(base([...owner, ...ruling, ...machine]), NOW);
    expect(moved.every((d) => d.id.startsWith('mac-'))).toBe(true);
    expect(doc.directives.map((d) => d.id)).toEqual(expect.arrayContaining(['own-12d-0', 'oq-13d-0']));
    expect(doc.archived.some((d) => d.origin)).toBe(false);
    // The 10-row floor still counts the owner rows: 22 open → 10 live (2 owner + 8 machine).
    expect(doc.directives.filter((d) => d.status === 'open')).toHaveLength(DIRECTIVE_ARCHIVE_MIN_OPEN);
  });

  it('owner ASKS keep the old aging rule (a status question is not an order)', () => {
    const ask = mk(1, 30, 'ask', { origin: 'owner', kind: 'ask' });
    const { moved } = archiveStaleDirectives(base([...ask, ...mk(20, 12, 'mac')]), NOW);
    expect(moved[0].id).toBe('ask-30d-0');
  });

  it('the live specimen: an open owner order already in the archive is RESTORED on read, archivedAt dropped', async () => {
    const victim: SupervisorDirective = { id: 'd9f1c2aa-1111', text: `Owner: ${SPECIMEN_LITELLM}`, at: '2026-10-12T15:00:00.000Z', status: 'open', origin: 'owner', scope: 'fleet', archivedAt: '2026-10-19T19:35:00.000Z' };
    const machineArchived = mk(3, 20, 'old')[0];
    table.set(CHAT, base(mk(12, 1, 'fresh'), [{ ...machineArchived, archivedAt: '2026-10-19T19:35:00.000Z' }, victim]));
    const doc = await getSupervisorState(CHAT);
    const back = doc.directives.find((d) => d.id === victim.id)!;
    expect(back).toBeTruthy();
    expect(back.archivedAt).toBeUndefined();
    expect(doc.directives[0].id).toBe(victim.id); // prepended — the ledger stays chronological
    expect(doc.archived.map((d) => d.id)).toEqual([machineArchived.id]);
    expect(formatStateForWake(doc, NOW)).toContain(SPECIMEN_LITELLM);
    const read = await readSupervisorStateSection(CHAT, { section: 'archived' });
    expect(String(read.archiveRule)).toMatch(/owner-origin order .* never moves here/);
  });

  it('the write path persists the restore and records directive_archive_restore', async () => {
    const victim: SupervisorDirective = { id: 'owner-arch-1', text: 'Owner: never ship on a red main', at: new Date(NOW.getTime() - 9 * day).toISOString(), status: 'open', origin: 'owner', archivedAt: NOW.toISOString() };
    table.set(CHAT, base(mk(3, 1, 'fresh'), [victim]));
    // Any write through upsertDoc persists the read-side tidy.
    await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_bbbb2222', question: 'Which host?', ruling: SPECIMEN_HYPERSTACK, source: 'dismissal' });
    await flush();
    expect(stored().directives.some((d) => d.id === 'owner-arch-1' && !d.archivedAt)).toBe(true);
    expect(stored().archived).toEqual([]);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_archive_restore', sessionId: CHAT, value: 1 }));
  });

  it('kill switch DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED=1 restores the pre-fix archive (owner rows age out, no restore)', () => {
    process.env.DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED = '1';
    const { moved, restored } = archiveStaleDirectives(base([...mk(1, 30, 'own', { origin: 'owner' }), ...mk(20, 12, 'mac')], [{ ...mk(1, 9, 'arch', { origin: 'owner' })[0], archivedAt: NOW.toISOString() }]), NOW);
    expect(moved[0].id).toBe('own-30d-0');
    expect(restored).toEqual([]);
  });
});

describe('wake-block trim keeps owner rows ahead of machine rows', () => {
  const long = (s: string) => `${s} ${'x'.repeat(440)}`;
  const mkLong = (n: number, prefix: string, extra: Partial<SupervisorDirective> = {}) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, text: long(`${prefix} #${i}`), at: new Date(NOW.getTime() - (50 - i) * 60_000).toISOString(), status: 'open' as const, ...extra }));

  it('drops machine non-standing, then machine standing, before any owner row (owner rows are the oldest here)', () => {
    const doc = base([...mkLong(4, 'own', { origin: 'owner' }), ...mkLong(3, 'macstd', { standing: true }), ...mkLong(12, 'mac')]);
    const block = formatStateForWake(doc, NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    for (let i = 0; i < 4; i++) expect(block).toContain(`[own-${i}]`);
    expect(block).toMatch(/NOT shown \(mac-0/);
  });

  it('kill switch: the pre-fix order drops the oldest non-standing row first even when it is an owner row', () => {
    process.env.DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED = '1';
    const doc = base([...mkLong(4, 'own', { origin: 'owner' }), ...mkLong(12, 'mac')]);
    expect(formatStateForWake(doc, NOW)).not.toContain('[own-0]');
  });
});

// ── (a) owner rulings on flagged questions become directives ─────────────────

describe('classifyOwnerRuling', () => {
  it.each<[string, boolean, boolean]>([
    [SPECIMEN_HYPERSTACK, true, true],
    [SPECIMEN_LITELLM, true, true],
    ['from now on every lane deploys through the batch train only', true, true],
    ['stop the H100 run and move the eval to the stanne lab today', true, false],
    ['please merge PR 412 once CI is green', true, false],
    // Choices, acks, questions and remarks are not rulings (the DONE row banks them).
    ['go ahead', false, false],
    ['yes merge it', false, false],
    ['Option B', false, false],
    ['ok thanks', false, false],
    ['should we always use the github secrets?', false, false],
    ['i never got the email about it', false, false],
    ['everything looks fine to me', false, false],
    ['', false, false],
  ])('%j → ruling %s, standing %s', (text, ruling, standing) => {
    expect(classifyOwnerRuling(text)).toEqual({ ruling, standing: ruling && standing });
  });
});

describe('appendOwnerRulingDirective', () => {
  it('the oq_892c91ae specimen lands as ONE open, standing, fleet-scoped owner-origin directive — idempotent on re-capture', async () => {
    const entry = { questionId: 'oq_892c91ae-0000-4000-8000-000000000000', question: 'Re-provision a new Hyperstack IP for canlegalbench.com?', ruling: SPECIMEN_HYPERSTACK, source: 'dismissal' as const, scope: 'canlegal-bench' };
    expect(await appendOwnerRulingDirective(CHAT, UID, entry)).toBe('appended');
    const row = stored().directives.find((d) => d.id === ownerRulingDirectiveId(entry.questionId))!;
    expect(row).toMatchObject({ status: 'open', origin: 'owner_question', standing: true, scope: 'fleet' });
    expect(row.text).toContain(SPECIMEN_HYPERSTACK);
    expect(row.text).toMatch(/^Owner RULING \(standing\) — /);
    expect(row.text).toContain('dismissing flagged question oq_892c91ae');
    expect(row.id.slice(0, 8)).toBe('oq_892c9'); // the wake alarm's 8-char id reads as the oq id
    // Re-capture (a retry, a second surface) never duplicates.
    expect(await appendOwnerRulingDirective(CHAT, UID, entry)).toBe('duplicate');
    expect(stored().directives.filter((d) => d.text.includes('Hyperstack'))).toHaveLength(1);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ruling_captured', meta: expect.objectContaining({ source: 'dismissal', standing: true, outcome: 'appended' }) }));
    // …and it renders in the wake view.
    expect(formatStateForWake(stored(), new Date())).toContain('no new Hyperstack IP, ever');
  });

  it('a non-standing order keeps the asking chat scope; an owner message already carrying the same ruling is not duplicated', async () => {
    expect(await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_11112222', question: 'Which box?', ruling: 'stop the H100 run and move the eval to the stanne lab today', source: 'answer', scope: 'canlaw' }))
      .toBe('appended');
    expect(stored().directives.at(-1)).toMatchObject({ scope: 'canlaw', origin: 'owner_question' });
    expect(stored().directives.at(-1)!.standing).toBeUndefined();
    table.set(CHAT, base([{ id: 'own-1', text: `Owner said: ${SPECIMEN_LITELLM}`, at: NOW.toISOString(), status: 'open', origin: 'owner' }]));
    expect(await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_68d001e9', question: 'Which defaults?', ruling: SPECIMEN_LITELLM, source: 'answer' })).toBe('duplicate');
    expect(stored().directives).toHaveLength(1);
  });

  it('secrets in the ruling are redacted before they ride every wake', async () => {
    const key = `sk-proj-${'A1b2C3d4E5f6G7h8'.repeat(3)}`;
    expect(await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_33334444', question: 'Which key?', ruling: `always use ${key} for the gateway from now on`, source: 'answer' })).toBe('appended');
    expect(JSON.stringify(stored())).not.toContain(key);
  });

  it('a non-ruling and the kill switch write nothing', async () => {
    expect(await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_55556666', question: 'Merge?', ruling: 'yes merge it', source: 'answer' })).toBe('not_ruling');
    process.env.OWNER_RULING_CAPTURE_DISABLED = '1';
    expect(await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_77778888', question: 'Host?', ruling: SPECIMEN_HYPERSTACK, source: 'dismissal' })).toBe('disabled');
    expect(table.has(CHAT)).toBe(false);
  });

  it('never throws — a DB failure answers failed', async () => {
    mockPrisma.supervisorState.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await appendOwnerRulingDirective(CHAT, UID, { questionId: 'oq_9999aaaa', question: 'Host?', ruling: SPECIMEN_HYPERSTACK, source: 'dismissal' })).toBe('failed');
  });
});
