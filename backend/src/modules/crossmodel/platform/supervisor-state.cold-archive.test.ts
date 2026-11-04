/**
 * fs-durable-memory review (2026-10-22), item 5: the HOT supervisor state doc
 * (loaded by every wake, rewritten by every state write) must not carry the
 * full 200-row closed archive. Measured on a realistic Fleet Supervisor doc
 * (50 live directives, 200 archived — 188 closed — 30 dispatches, 12 project
 * lines, 4000-char notes): 142,094 JSON chars with the archive in the doc,
 * 41,588 without the closed rows. Now only the newest ARCHIVE_HOT_CLOSED_KEEP
 * closed rows stay hot; older ones spill to the cold archive (context store,
 * one row per directive), stay mirrored for recall / search_memory, and are
 * read on demand by get_supervisor_state, a revive by id and the id lookup.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn(), findMany: jest.fn(async () => []) },
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  crossModelMessage: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
const mockColdEmbed: jest.Mock = jest.fn();
jest.mock('./supervisor-state-memory', () => ({
  __esModule: true,
  enqueueSupervisorStateEmbed: jest.fn(),
  enqueueSupervisorStateColdEmbed: (...a: any[]) => mockColdEmbed(...a),
}));
// An in-memory context store (namespace → key → { value, createdAt }) with the primitives the cold archive uses.
const cs = new Map<string, Map<string, { value: any; createdAt: number }>>();
let csClock = 0;
let failPut = false;
/** Emulate Prisma 7's UNESCAPED startsWith (verified on Postgres 16): '_' / '%' in the prefix are LIKE wildcards. */
let likeWildcards = false;
const likeRe = (prefix: string) => new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.').replace(/%/g, '.*'));
const ns = (n: string[]) => n.join(':');
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: async (n: string[], k: string) => cs.get(ns(n))?.get(k)?.value ?? null,
  storePut: async (n: string[], k: string, v: any) => {
    if (failPut) throw new Error('store down');
    const m = cs.get(ns(n)) ?? new Map();
    const prev = m.get(k);
    m.set(k, { value: JSON.parse(JSON.stringify(v)), createdAt: prev?.createdAt ?? ++csClock });
    cs.set(ns(n), m);
  },
  storeDelete: async (n: string[], k: string) => { cs.get(ns(n))?.delete(k); },
  storeListNamespace: async (n: string[]) => [...(cs.get(ns(n)) ?? new Map()).entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([key, r]) => ({ key, value: r.value, createdAt: new Date(r.createdAt), updatedAt: null })),
  storeDeleteChatScoped: async (ids: string[]) => {
    let n = 0;
    for (const id of ids) for (const kind of ['thread', 'supervisor-archive']) { n += cs.get(`${id}:${kind}`)?.size ?? 0; cs.delete(`${id}:${kind}`); }
    return n;
  },
  storeFindByKeyPrefix: async (nss: string[][], prefix: string, limit: number) => {
    const out: any[] = [];
    for (const n of nss) for (const [key, r] of cs.get(ns(n)) ?? new Map()) if (likeWildcards ? likeRe(prefix).test(key) : key.startsWith(prefix)) out.push({ namespace: ns(n), key, value: r.value });
    return out.slice(0, limit);
  },
}));

import {
  appendDirective,
  applyStateUpdate,
  archiveRuleText,
  coldArchiveNamespace,
  findColdArchivedDirective,
  formatStateForWake,
  readSupervisorStateSection,
  splitClosedArchive,
  ARCHIVE_HOT_CLOSED_KEEP,
  ARCHIVE_CLOSED_MAX,
  COLD_ARCHIVE_MAX,
  SupervisorDirective,
  SupervisorStateDoc,
} from './supervisor-state.service';

const CHAT = 'fs-cold-1';
const UID = 'owner-1';
let table: Map<string, any>;
const stored = (): SupervisorStateDoc => table.get(CHAT);
const cold = () => cs.get(ns(coldArchiveNamespace(CHAT))) ?? new Map();

const words = 'deploy the canlaw bench run on the H100 box and report the det-v2 score with receipts before merging any PR to main for spark cluster lanes'.split(' ');
const txt = (n: number, i: number) => Array.from({ length: n }, (_, k) => words[(i * 7 + k) % words.length]).join(' ');
const uuid = (i: number) => `${(0x10000000 + i * 7919).toString(16)}-aaaa-4bbb-8ccc-${String(i).padStart(12, '0')}`;

/** The realistic doc: 50 live (standing open rows keep the cap from evicting them), 200 archived (12 open supervisor-written rows — an open OWNER order is restored to the live ledger — and 188 closed), 30 dispatches, 12 projects, full notes. */
function realisticDoc(): SupervisorStateDoc {
  const now = Date.now();
  const iso = (h: number) => new Date(now - h * 3600_000).toISOString();
  const directives: SupervisorDirective[] = [];
  for (let i = 0; i < 50; i++) directives.push({ id: uuid(i), text: txt(30 + (i % 40), i), at: iso(300 - i), status: i % 3 === 0 ? 'open' : 'done', ...(i % 3 === 0 ? { standing: true } : { evidence: `msg ${uuid(i + 900).slice(0, 8)} — dispatched: session ${uuid(i + 500)}` }), origin: 'owner', messageId: uuid(i + 1200), scope: 'fleet' } as SupervisorDirective);
  const archived: SupervisorDirective[] = [];
  for (let i = 0; i < 200; i++) archived.push({ id: uuid(i + 2000), text: txt(25 + (i % 50), i), at: iso(2000 - i * 5), status: i < 12 ? 'open' : (i % 2 ? 'answered' : 'done'), ...(i % 2 ? { kind: 'ask' } : {}), ...(i >= 12 ? { evidence: `msg ${uuid(i + 3000).slice(0, 8)}`, origin: 'owner' } : {}), messageId: uuid(i + 4000), scope: 'fleet', archivedAt: iso(100 - (i % 90)) } as SupervisorDirective);
  const dispatches = Array.from({ length: 30 }, (_, i) => ({ kind: 'session', id: uuid(i + 6000), at: iso(30 - i), note: txt(20, i) }));
  return { directives, archived, dispatches, projects: Array.from({ length: 12 }, (_, i) => ({ name: `project-${i}`, status: txt(25, i), at: iso(1) })), notes: txt(600, 1).slice(0, 4000), refutations: [], inflightPreemptAt: '' };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED;
  cs.clear(); csClock = 0; failPut = false; likeWildcards = false;
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) => (table.has(where.chatId) ? { state: JSON.parse(JSON.stringify(table.get(where.chatId))) } : null));
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => { table.set(where.chatId, JSON.parse(JSON.stringify(table.has(where.chatId) ? update.state : create.state))); return {}; });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ isSupervisor: true, project: null });
});
afterAll(() => { delete process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED; });

describe('splitClosedArchive (pure)', () => {
  it('keeps every open row + the newest N closed rows hot, in order; older closed rows go cold', () => {
    const a = (id: string, status: 'open' | 'done' = 'done') => ({ id, text: id, at: '', status }) as SupervisorDirective;
    const r = splitClosedArchive([a('c1'), a('o1', 'open'), a('c2'), a('c3'), a('o2', 'open'), a('c4')], 2);
    expect(r.hot.map((d) => d.id)).toEqual(['o1', 'c3', 'o2', 'c4']);
    expect(r.cold.map((d) => d.id)).toEqual(['c1', 'c2']);
    expect(splitClosedArchive([a('o', 'open')], 0).cold).toEqual([]);
  });
});

describe('the hot doc stays small with a realistic full archive', () => {
  it('one write spills the old closed rows cold: hot doc ≈ 3× smaller, nothing lost, the wake line counts both', async () => {
    const before = realisticDoc();
    const beforeChars = JSON.stringify(before).length;
    table.set(CHAT, before);
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    const hot = stored();
    const afterChars = JSON.stringify(hot).length;
    // sizes (printed for the review record) — the bound the item asks for
    expect(beforeChars).toBeGreaterThan(130_000);
    expect(afterChars).toBeLessThan(65_000);
    expect(hot.archived.filter((d) => d.status === 'open')).toHaveLength(12);
    expect(hot.archived.filter((d) => d.status !== 'open')).toHaveLength(ARCHIVE_HOT_CLOSED_KEEP);
    // every closed row is kept somewhere: hot keep + cold (the live cap evicted one more closed row this write)
    const coldRows = [...cold().values()].map((r) => r.value);
    expect(coldRows.length + ARCHIVE_HOT_CLOSED_KEEP).toBe(Math.min(ARCHIVE_CLOSED_MAX, 188 + 1));
    expect(hot.archivedColdCount).toBe(coldRows.length);
    expect(coldRows.every((d: any) => d.status !== 'open')).toBe(true);
    // the wake block renders the SAME bounded line (counts only) — no archive rows enter the prompt
    const block = formatStateForWake(hot, new Date());
    expect(block).toMatch(/\d+ older directive\(s\) ARCHIVED \(12 open > 7 d/);
    expect(block.length).toBeLessThanOrEqual(6100);
    // the cold set was handed to the memory mirror (it keeps the 'archive …' rows searchable)
    expect(mockColdEmbed).toHaveBeenCalledWith(CHAT, expect.any(Array), { userId: UID });
    expect((mockColdEmbed.mock.calls[0][1] as any[]).length).toBe(coldRows.length);
    // eslint-disable-next-line no-console
    console.log(`hot doc JSON chars: before ${beforeChars}, after ${afterChars}; cold rows ${coldRows.length}; wake block ${block.length} chars`);
  });

  it('a failed cold write keeps every row hot (nothing lost) and retries on the next write', async () => {
    table.set(CHAT, realisticDoc());
    failPut = true;
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    expect(stored().archived.filter((d) => d.status !== 'open').length).toBeGreaterThan(ARCHIVE_HOT_CLOSED_KEEP);
    expect(stored().archivedColdCount).toBeUndefined();
    failPut = false;
    await appendDirective(CHAT, UID, 'From now on keep the bench lane paused on weekends.');
    expect(stored().archived.filter((d) => d.status !== 'open')).toHaveLength(ARCHIVE_HOT_CLOSED_KEEP);
    expect(stored().archivedColdCount).toBeGreaterThan(0);
  });

  it('the cold archive is bounded: at most ARCHIVE_CLOSED_MAX closed rows in all, the oldest dropped first', async () => {
    const d = realisticDoc();
    table.set(CHAT, d);
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    // push 30 more closed rows through the archive
    const doc = stored();
    for (let i = 0; i < 30; i++) doc.archived.push({ id: `extra-${i}`, text: `extra closed row ${i}`, at: new Date().toISOString(), status: 'done', evidence: 'pr #1', archivedAt: new Date().toISOString() });
    table.set(CHAT, doc);
    await appendDirective(CHAT, UID, 'From now on keep the bench lane paused on weekends.');
    expect(cold().size).toBeLessThanOrEqual(COLD_ARCHIVE_MAX);
    expect(cold().size + stored().archived.filter((x) => x.status !== 'open').length).toBeLessThanOrEqual(ARCHIVE_CLOSED_MAX);
    expect(cold().has('extra-29')).toBe(false); // newest closed rows stay hot
  });

  it('kill switch: no spill (the archive stays in the doc as before)', async () => {
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
    table.set(CHAT, realisticDoc());
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    expect(cold().size).toBe(0);
    expect(stored().archivedColdCount).toBeUndefined();
  });
});

describe('cold rows are still read, listed and revivable', () => {
  beforeEach(async () => {
    table.set(CHAT, realisticDoc());
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
  });

  it("get_supervisor_state section 'archived' lists hot + cold, OPEN rows first; 'all' lists only a few closed rows", async () => {
    const arch = await readSupervisorStateSection(CHAT, { section: 'archived', limit: 100 });
    const rows = arch.archived as SupervisorDirective[];
    expect(rows.slice(0, 12).every((d) => d.status === 'open')).toBe(true);
    expect((arch.counts as any).archived).toBe(stored().archived.length + (stored().archivedColdCount ?? 0));
    expect((arch.counts as any).archivedOpen).toBe(12);
    expect(String(arch.archiveRule)).not.toMatch(/nothing (is )?deleted/);
    expect(String(arch.archiveRule)).toContain('CLOSED (done / answered)');
    // 'all' (the default read): at most 10 closed rows, never ahead of an open one, and the answer says what it left out.
    const all = await readSupervisorStateSection(CHAT, {});
    const listed = all.archived as SupervisorDirective[];
    expect(listed.filter((d) => d.status !== 'open').length).toBeLessThanOrEqual(10);
    const firstClosed = listed.findIndex((d) => d.status !== 'open');
    if (firstClosed >= 0) expect(listed.slice(firstClosed).every((d) => d.status !== 'open')).toBe(true);
    expect((all.archivedNotListed as any).closed).toBeGreaterThan(100);
    expect(JSON.stringify(all).length).toBeLessThanOrEqual(12_000);
    // a query reaches the cold rows too
    const oldest = [...cold().values()][0].value as SupervisorDirective;
    const q = await readSupervisorStateSection(CHAT, { section: 'archived', query: oldest.evidence });
    expect((q.archived as SupervisorDirective[]).map((d) => d.id)).toContain(oldest.id);
  });

  it('update_supervisor_state {id, status:open} revives a COLD row (full id and 8-char prefix); its cold key is dropped by the NEXT write', async () => {
    const [first, second] = [...cold().values()].map((r) => r.value as SupervisorDirective);
    const r1 = await applyStateUpdate(CHAT, UID, { directives: [{ id: first.id, status: 'open' }] });
    expect(r1.errors).toEqual([]);
    expect(r1.applied.join(' ')).toContain(`directive ${first.id} revived from the cold archive`);
    expect(stored().directives.find((d) => d.id === first.id)?.status).toBe('open');
    // Review 2026-10-23: the promoting write keeps the cold copy (a stale write from another process could still
    // land after it) and records it as a deferred deletion; it is never counted, listed or mirrored as archived.
    expect(cold().has(first.id)).toBe(true);
    expect(stored().coldStaleIds).toEqual([first.id]);
    expect(stored().archivedColdCount).toBe(cold().size - 1);
    const listed = await readSupervisorStateSection(CHAT, { section: 'archived', limit: 100 });
    expect((listed.archived as SupervisorDirective[]).some((d) => d.id === first.id)).toBe(false);
    const r2 = await applyStateUpdate(CHAT, UID, { directives: [{ id: second.id.slice(0, 13), status: 'open' }] });
    expect(r2.errors).toEqual([]);
    expect(stored().directives.find((d) => d.id === second.id)).toBeDefined();
    expect(cold().has(first.id)).toBe(false); // this write's base held it hot
    expect(cold().has(second.id)).toBe(true);
    await applyStateUpdate(CHAT, UID, { notes: 'checked the archive' });
    expect(cold().has(second.id)).toBe(false);
    expect(stored().archivedColdCount).toBe(cold().size);
    await applyStateUpdate(CHAT, UID, { notes: 'checked the archive again' });
    expect(stored()).not.toHaveProperty('coldStaleIds');
  });

  it('an evidence update on a cold row lands on it (still closed, still kept)', async () => {
    const row = [...cold().values()][3].value as SupervisorDirective;
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: row.id, evidence: 'msg 0a0a0a0a — re-checked' }] });
    expect(r.errors).toEqual([]);
    const where = stored().archived.find((d) => d.id === row.id) ?? (cold().get(row.id)?.value as SupervisorDirective);
    expect(where?.evidence).toBe('msg 0a0a0a0a — re-checked');
    expect(where?.status).not.toBe('open');
    expect([stored().archived.some((d) => d.id === row.id), cold().has(row.id)].filter(Boolean)).toHaveLength(1); // never in both
  });

  it('a truly unknown id is still refused', async () => {
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'deadbeef-not-a-directive', status: 'open' }] });
    expect(r.errors.join(' ')).toContain('no such directive id');
  });
});

// ── Review round 3 (2026-10-23) ───────────────────────────────────────────────
const closedHotIds = () => stored().archived.filter((d) => d.status !== 'open').map((d) => d.id);
const archiveT = (d: any) => Date.parse(d.archivedAt ?? '') || Date.parse(d.at ?? '') || 0;

describe('id lookups match the id LITERALLY (LIKE wildcards in an id never pull a row)', () => {
  beforeEach(async () => {
    table.set(CHAT, realisticDoc());
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    likeWildcards = true; // the store answers like Prisma 7's unescaped startsWith
  });

  it("an id with '_' that LIKE-matches exactly one cold row neither moves it nor deletes its cold key", async () => {
    const first = [...cold().values()][0].value as SupervisorDirective;
    const wild = `${first.id.slice(0, 7)}_`; // 8 chars: matches `first` only as a LIKE pattern
    expect(await findColdArchivedDirective(CHAT, wild)).toEqual({});
    const was = stored();
    const coldSizeBefore = cold().size;
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: wild, evidence: 'msg 0b0b0b0b — re-checked' }] });
    expect(r.errors.join(' ')).toContain('no such directive id');
    expect(cold().has(first.id)).toBe(true);
    expect((cold().get(first.id)!.value as SupervisorDirective).evidence).toBe(first.evidence);
    // no row moved (rows are re-serialized on every write, so compare ids, not bytes)
    expect(stored().archived.map((d) => d.id)).toEqual(was.archived.map((d) => d.id));
    expect(stored().directives.map((d) => d.id)).toEqual(was.directives.map((d) => d.id));
    expect(stored().archivedColdCount).toBe(was.archivedColdCount);
    expect(cold().size).toBe(coldSizeBefore);
  });
});

describe('kill switch flipped ON after cold rows exist', () => {
  beforeEach(async () => {
    table.set(CHAT, realisticDoc());
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED = '1';
  });

  it('a revived cold row leaves NO stale closed cold copy (count, listing and mirror agree)', async () => {
    const row = [...cold().values()][2].value as SupervisorDirective;
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: row.id, status: 'open' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives.find((d) => d.id === row.id)?.status).toBe('open');
    // the cold mirror is reconciled without it at once (a confirmed-hot row is never mirrored cold)…
    const lastCold = mockColdEmbed.mock.calls[mockColdEmbed.mock.calls.length - 1][1] as SupervisorDirective[];
    expect(lastCold.some((d) => d.id === row.id)).toBe(false);
    const arch = await readSupervisorStateSection(CHAT, { section: 'archived', limit: 100 });
    expect((arch.archived as SupervisorDirective[]).some((d) => d.id === row.id)).toBe(false);
    // …and the cold copy goes with the next write (nothing spills under the switch; the deferred set forces the listing).
    await applyStateUpdate(CHAT, UID, { notes: 'after the revive' });
    expect(cold().has(row.id)).toBe(false);
    expect(stored().archivedColdCount).toBe(cold().size);
  });

  it('the wake ARCHIVED line and the archive rule say what the switch does (evicted closed rows are DELETED)', async () => {
    const block = formatStateForWake(stored(), new Date());
    const line = block.split('\n').find((l) => /ARCHIVED/.test(l))!;
    expect(line).not.toMatch(/kept and searchable, up to/);
    expect(line).toMatch(/DELETED/);
    expect(archiveRuleText()).toMatch(/DELETED, not archived/);
  });
});

// Review 2026-10-23: "Every archived row stays findable by search_memory" was stated whatever the switches said —
// false with the ledger mirror off (SUPERVISOR_STATE_MEMORY_DISABLED: nothing new is mirrored) and with the supervisor
// search scopes off (SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED: search_memory never reads the chat scope).
describe('archiveRuleText states search_memory findability only when the harness provides it', () => {
  afterEach(() => { delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED; delete process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED; });
  it('both on: findable by search_memory; either off: not claimed — get_supervisor_state is named instead', () => {
    expect(archiveRuleText()).toContain('findable by search_memory');
    for (const sw of ['SUPERVISOR_STATE_MEMORY_DISABLED', 'SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED']) {
      process.env[sw] = '1';
      const text = archiveRuleText();
      expect(text).not.toContain('findable by search_memory');
      expect(text).toMatch(/search_memory does not reach (?:it|them)[^.]*get_supervisor_state/);
      delete process.env[sw];
    }
  });
});

describe('a stale cold copy of a HOT row is never listed as archived', () => {
  it('get_supervisor_state dedupes the cold set against the live ledger too', async () => {
    table.set(CHAT, realisticDoc());
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
    const live = stored().directives[0];
    cs.get(ns(coldArchiveNamespace(CHAT)))!.set(live.id, { value: { ...live, status: 'done', evidence: 'stale copy zq9', archivedAt: '2026-01-01T00:00:00Z' }, createdAt: ++csClock });
    const arch = await readSupervisorStateSection(CHAT, { section: 'archived', query: 'stale copy zq9', limit: 100 });
    expect((arch.archived as SupervisorDirective[]).some((d) => d.id === live.id)).toBe(false);
    expect((arch.counts as any).archivedClosed).toBe(stored().archived.filter((d) => d.status !== 'open').length + cold().size - 1);
  });
});

describe('oldest closed rows go first — by archive time, not by write order', () => {
  beforeEach(async () => {
    table.set(CHAT, realisticDoc());
    await appendDirective(CHAT, UID, 'From now on post the nightly digest before 08:00 UTC.');
  });

  it('a cold row pulled back for an evidence-only update goes back to its archive position (it stays cold; the newest closed rows stay hot)', async () => {
    const hotBefore = closedHotIds();
    const row = [...cold().values()][3].value as SupervisorDirective;
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: row.id, evidence: 'msg 0a0a0a0a — re-checked' }] });
    expect(r.errors).toEqual([]);
    expect(closedHotIds()).toEqual(hotBefore);
    expect((cold().get(row.id)?.value as SupervisorDirective).evidence).toBe('msg 0a0a0a0a — re-checked');
    expect(stored().archived.some((d) => d.id === row.id)).toBe(false);
    expect(stored().archivedColdCount).toBe(cold().size);
  });

  it('the cold trim drops the OLDEST archived rows even when they were written to the store last', async () => {
    // 15 ancient closed rows land in the cold store AFTER everything else (newest createdAt, oldest archivedAt).
    const m = cs.get(ns(coldArchiveNamespace(CHAT)))!;
    for (let i = 0; i < 15; i++) m.set(`ancient-${i}`, { value: { id: `ancient-${i}`, text: `ancient closed row ${i}`, at: '2025-01-01T00:00:00Z', status: 'done', evidence: 'pr #1', archivedAt: `2025-01-0${1 + (i % 9)}T00:00:00Z` }, createdAt: ++csClock });
    const doc = stored();
    doc.archivedColdCount = m.size;
    for (let i = 0; i < 30; i++) doc.archived.push({ id: `extra-${i}`, text: `extra closed row ${i}`, at: new Date().toISOString(), status: 'done', evidence: 'pr #1', archivedAt: new Date().toISOString() });
    table.set(CHAT, doc);
    await appendDirective(CHAT, UID, 'From now on keep the bench lane paused on weekends.');
    expect(cold().size).toBe(COLD_ARCHIVE_MAX);
    for (let i = 0; i < 15; i++) expect(cold().has(`ancient-${i}`)).toBe(false);
    // what is left cold is the newest COLD_ARCHIVE_MAX closed rows below the hot keep
    const coldTimes = [...cold().values()].map((r) => archiveT(r.value));
    const hotClosedTimes = stored().archived.filter((d) => d.status !== 'open').map(archiveT);
    expect(Math.max(...coldTimes)).toBeLessThanOrEqual(Math.min(...hotClosedTimes));
  });

  it("a revive whose hot write is overwritten by a concurrent stale write keeps the row's cold copy (nothing lost)", async () => {
    const row = [...cold().values()][1].value as SupervisorDirective;
    const staleDoc = JSON.parse(JSON.stringify(stored()));
    mockPrisma.supervisorState.upsert.mockImplementationOnce(async ({ where, update }: any) => {
      table.set(where.chatId, JSON.parse(JSON.stringify(update.state)));
      table.set(where.chatId, staleDoc); // another process's stale read-modify-write lands right after
      return {};
    });
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: row.id, status: 'open' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives.some((d) => d.id === row.id)).toBe(false); // the stale write won
    expect(cold().has(row.id)).toBe(true); // ...and the row survives cold
  });

  // Review 2026-10-23: the re-read only covers a stale write that lands BEFORE the confirmation. Another process's
  // stale read-modify-write (closeAskOnReply, appendDirective, a verifier refutation …) landing AFTER the settle
  // used to find the cold key already deleted — the row was in neither tier, and the count still said it was there.
  it('a stale write from another process landing AFTER the settle loses nothing — the promoting write never deletes the cold copy', async () => {
    const row = [...cold().values()][1].value as SupervisorDirective;
    const staleDoc = JSON.parse(JSON.stringify(stored())); // B read the doc before A's revive
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: row.id, status: 'open' }] });
    expect(r.errors).toEqual([]);
    table.set(CHAT, staleDoc); // …and B's upsert lands after A's settle
    const inHot = [...stored().directives, ...stored().archived].some((d) => d.id === row.id);
    expect(inHot || cold().has(row.id)).toBe(true);
    // the next write sees it as a cold row again (counted, listed, revivable)
    await applyStateUpdate(CHAT, UID, { notes: 'after the race' });
    expect(cold().has(row.id)).toBe(true);
    // (the row A's cap spilled cold is still hot in B's doc too — the count is of cold rows the hot doc lacks)
    const hot = new Set([...stored().directives, ...stored().archived].map((d) => d.id));
    expect(stored().archivedColdCount).toBe([...cold().keys()].filter((k) => !hot.has(k)).length);
    const arch = await readSupervisorStateSection(CHAT, { section: 'archived', query: row.evidence, limit: 100 });
    expect((arch.archived as SupervisorDirective[]).some((d) => d.id === row.id)).toBe(true);
  });
});

describe('the cold namespace is one of the chat-scoped namespaces a chat / account deletion clears', () => {
  it('coldArchiveNamespace(chatId) ∈ chatScopedStorePaths([chatId])', () => {
    const actual = jest.requireActual('../memory/context-store') as typeof import('../memory/context-store');
    expect(actual.chatScopedStorePaths(['c-9'])).toContain(coldArchiveNamespace('c-9').join(':'));
    expect(actual.chatScopedStorePaths(['c-9'])).toContain('c-9:thread');
  });
});

// fs-durable-memory re-review (2026-10-23), item 2: the spill writes the cold
// rows BEFORE the hot upsert. A chat (or account) delete that lands between
// the two — its storeDeleteChatScoped already ran — leaves the spill's cold
// rows behind, and the upsert then fails on the chat FK, so nothing settled
// them: owner directive text with no later deletion path.
describe('a supervisor write racing a chat delete leaves no cold rows behind', () => {
  let chatGone = false;
  beforeEach(() => {
    chatGone = false;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => (chatGone ? null : { id: CHAT, isSupervisor: true, project: null }));
  });

  it('the hot upsert fails because the chat is gone ⇒ the chat-keyed rows the spill wrote are purged; the error still surfaces', async () => {
    table.set(CHAT, realisticDoc());
    cs.set(`${CHAT}:thread`, new Map([['state', { value: { threadSummary: 'owner words' }, createdAt: ++csClock }]]));
    mockPrisma.supervisorState.upsert.mockImplementationOnce(async () => {
      // deleteChat ran meanwhile: row delete (cascades supervisor_states) + its purge, BEFORE the spill's puts landed
      chatGone = true;
      table.delete(CHAT);
      const err: any = new Error('Foreign key constraint violated on the constraint: `supervisor_states_chatId_fkey`');
      err.code = 'P2003';
      throw err;
    });
    const r = await applyStateUpdate(CHAT, UID, { notes: 'racing note' });
    expect(r.applied).toEqual([]);
    expect(r.errors.join(' ')).toMatch(/Foreign key/); // the failure still surfaces to the caller
    expect(cold().size).toBe(0);
    expect(cs.get(`${CHAT}:thread`)?.size ?? 0).toBe(0);
  });

  it('a hot upsert failure while the chat STILL exists purges nothing (the rows are live state)', async () => {
    table.set(CHAT, realisticDoc());
    mockPrisma.supervisorState.upsert.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    await applyStateUpdate(CHAT, UID, { notes: 'transient failure' }).catch(() => {});
    expect(cold().size).toBeGreaterThan(0); // the spill's rows stay (the hot doc still holds them too — the next write settles)
    expect(stored().archived.filter((d) => d.status !== 'open').length).toBeGreaterThan(ARCHIVE_HOT_CLOSED_KEEP);
  });

  it('a failing existence check purges nothing (fail-safe: only a confirmed-gone chat is purged)', async () => {
    table.set(CHAT, realisticDoc());
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => { throw new Error('db down'); });
    mockPrisma.supervisorState.upsert.mockImplementationOnce(async () => { throw new Error('db down'); });
    await applyStateUpdate(CHAT, UID, { notes: 'db down' }).catch(() => {});
    expect(cold().size).toBeGreaterThan(0);
  });
});
