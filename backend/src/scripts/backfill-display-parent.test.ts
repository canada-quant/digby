/**
 * scripts/framework-audit/backfill-display-parent.js — the 2026-10-21 display-parent
 * one-shot (lanefix/nesting), on a MOCKED Prisma client. Pins: dry run by default
 * (selection + per-proof / per-project counts, no writes); only lanes with
 * MACHINE-SPAWN PROOF (p1 delegation ledger, p2 ticket link, p3 supervisor parent,
 * p4 machine first message) are stamped — an owner chat, an API-key spawn, a lane
 * already parented by the supervisor, a supervisor itself, the standing engineering
 * lane and a folder with no / another owner's / an archived supervisor are not;
 * --apply writes the marker FIRST and the guarded raw update, which never touches
 * updatedAt (an idle lane stays idle; a lane bumped while the proof queries ran keeps
 * the NEWER clock — the first cut wrote back the SELECT-time value); a row stamped
 * meanwhile is skipped (never overwritten, no stray marker); --revert clears only rows
 * still carrying the recorded supervisor and drops their markers, updatedAt untouched.
 */
import path from 'path';

const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'backfill-display-parent.js'));

type Chat = {
  id: string; userId: string; projectId: string | null; parentChatId?: string | null;
  isSupervisor?: boolean; isProjectSupervisor?: boolean; archivedAt?: Date | null;
  displayParentChatId?: string | null; coding?: boolean; createdAt: number; updatedAt: Date;
  firstUserOrigin?: string | null;
};

const OWNER = 'u-owner';
const OTHER = 'u-other';
const CM = 'proj-crossmodel';
const SPARK = 'proj-spark';
const STALE = new Date('2026-10-01T00:00:00Z');

/** An in-memory Prisma double covering exactly the calls the script makes. */
function makePrisma(chats: Chat[], extra: { tasks?: any[]; tickets?: any[] } = {}) {
  const store = new Map<string, { namespacePath: string; key: string; value: any }>();
  const nsKey = (ns: string, key: string) => `${ns}|${key}`;
  const matches = (c: Chat, where: any): boolean => {
    if (where.id !== undefined && typeof where.id === 'string' && c.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(c.id)) return false;
    if ('archivedAt' in where && where.archivedAt === null && c.archivedAt) return false;
    if (where.projectId?.in && !where.projectId.in.includes(c.projectId)) return false;
    if (where.projectId?.not === null && c.projectId === null) return false;
    if ('isSupervisor' in where && !!c.isSupervisor !== where.isSupervisor) return false;
    if ('isProjectSupervisor' in where && !!c.isProjectSupervisor !== where.isProjectSupervisor) return false;
    if ('displayParentChatId' in where && (c.displayParentChatId ?? null) !== where.displayParentChatId) return false;
    if (where.codingState?.isNot === null && !c.coding) return false;
    return true;
  };
  const prisma: any = {
    chats, store,
    crossModelChat: {
      findMany: jest.fn(async ({ where, select }: any) => chats
        .filter((c) => matches(c, where))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((c) => Object.fromEntries(Object.keys(select).map((k) => [k, (c as any)[k] ?? (k === 'parentChatId' ? null : (c as any)[k])])))),
      findUnique: jest.fn(async ({ where }: any) => {
        const c = chats.find((x) => x.id === where.id);
        return c ? { id: c.id } : null;
      }),
      // Any Prisma update would fire @updatedAt — the script must not use one.
      updateMany: jest.fn(async () => { throw new Error('updateMany must not be used (it writes updatedAt)'); }),
    },
    // The two guarded raw statements (stampSql / clearSql). Like Postgres, the mock
    // touches ONLY displayParentChatId — updatedAt is whatever the row already holds.
    // PrismaPromise-like: executes when awaited (inside $transaction or directly).
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: any[]) => ({
      then: (res: any, rej: any) => Promise.resolve().then(() => {
        const sql = strings.join('?');
        let row: Chat | undefined;
        if (/^UPDATE "crossmodel_chats" SET "displayParentChatId" = \? WHERE "id" = \? AND "displayParentChatId" IS NULL$/.test(sql)) {
          const [ps, id] = values;
          row = chats.find((c) => c.id === id && (c.displayParentChatId ?? null) === null);
          if (row) row.displayParentChatId = ps;
        } else if (/^UPDATE "crossmodel_chats" SET "displayParentChatId" = NULL WHERE "id" = \? AND "displayParentChatId" = \?$/.test(sql)) {
          const [id, ps] = values;
          row = chats.find((c) => c.id === id && c.displayParentChatId === ps);
          if (row) row.displayParentChatId = null;
        } else {
          throw new Error(`unexpected raw SQL: ${sql}`);
        }
        return row ? 1 : 0;
      }).then(res, rej),
    })),
    delegationTask: {
      findMany: jest.fn(async ({ where }: any) => (extra.tasks ?? []).filter((t) => where.childChatId.in.includes(t.childChatId)
        && where.OR.some((o: any) => o.kind === t.kind && (o.origin === undefined || o.origin === t.origin)))),
    },
    userFeatureRequest: { findMany: jest.fn(async () => (extra.tickets ?? []).map((t) => ({ context: t }))) },
    crossModelMessage: {
      findFirst: jest.fn(async ({ where }: any) => {
        const c = chats.find((x) => x.id === where.chatId);
        if (!c || c.firstUserOrigin === undefined) return null;
        return { metadata: c.firstUserOrigin === null ? null : { origin: c.firstUserOrigin } };
      }),
    },
    contextStoreEntry: {
      upsert: jest.fn(({ where, create, update }: any) => ({
        then: (res: any, rej: any) => Promise.resolve().then(() => {
          const k = nsKey(where.namespacePath_key.namespacePath, where.namespacePath_key.key);
          const existing = store.get(k);
          const row = existing ? { ...existing, value: update.value } : { namespacePath: create.namespacePath, key: create.key, value: create.value };
          store.set(k, row);
          return row;
        }).then(res, rej),
      })),
      findMany: jest.fn(async ({ where, take }: any) => {
        let rows = [...store.values()].filter((r) => r.key === where.key && r.namespacePath.endsWith(where.namespacePath.endsWith));
        rows = rows.sort((a, b) => a.namespacePath.localeCompare(b.namespacePath));
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((r) => ({ namespacePath: r.namespacePath, value: r.value }));
      }),
      deleteMany: jest.fn(async ({ where }: any) => ({ count: store.delete(nsKey(where.namespacePath, where.key)) ? 1 : 0 })),
    },
    $transaction: jest.fn(async (ops: any[]) => {
      const out: any[] = [];
      for (const op of ops) out.push(await op);
      return out;
    }),
  };
  return prisma;
}

/** The owner's crossmodel + spark-cluster folders, shaped on the LLC1021 probe. */
const fleet = (): Chat[] => [
  { id: 'fs-c0e22e36', userId: OWNER, projectId: null, isSupervisor: true, createdAt: 1, updatedAt: STALE },
  { id: 'ps-daee2916', userId: OWNER, projectId: CM, isProjectSupervisor: true, createdAt: 2, updatedAt: STALE },
  { id: 'ps-590d604e', userId: OWNER, projectId: SPARK, isProjectSupervisor: true, createdAt: 3, updatedAt: STALE },
  { id: 'std-b92ef13f', userId: OWNER, projectId: CM, coding: true, createdAt: 4, updatedAt: STALE, firstUserOrigin: 'user' },
  // Ticket lanes (p2) + a family lane (p1 ledger row).
  { id: 'tl-241242d0', userId: OWNER, projectId: CM, coding: true, createdAt: 10, updatedAt: STALE, firstUserOrigin: 'agent' },
  { id: 'tl-b839643b', userId: OWNER, projectId: CM, coding: true, createdAt: 11, updatedAt: STALE, firstUserOrigin: 'agent' },
  { id: 'fam-4e2d280b', userId: OWNER, projectId: CM, coding: true, createdAt: 12, updatedAt: STALE, firstUserOrigin: 'agent' },
  // A Fleet-spawned lane in spark-cluster (p3).
  { id: 'ch-69fb25fc', userId: OWNER, projectId: SPARK, parentChatId: 'fs-c0e22e36', coding: true, createdAt: 13, updatedAt: STALE },
  // A lane whose first prompt was agent-authored, nothing else (p4).
  { id: 'l-5f90c628', userId: OWNER, projectId: CM, coding: true, createdAt: 14, updatedAt: STALE, firstUserOrigin: 'agent' },
  // Already nested under the supervisor — never a candidate.
  { id: 'ch-6ef785c3', userId: OWNER, projectId: CM, parentChatId: 'ps-daee2916', coding: true, createdAt: 15, updatedAt: STALE, firstUserOrigin: 'schedule' },
  // Owner-typed workspace lane / API-key spawn (first message origin user / none) — no proof.
  { id: 'own-heartbrk', userId: OWNER, projectId: CM, coding: true, createdAt: 16, updatedAt: STALE, firstUserOrigin: 'user' },
  { id: 'api-bench01', userId: OWNER, projectId: CM, coding: true, createdAt: 17, updatedAt: STALE, firstUserOrigin: null },
  // A plain (non-coding) chat in the folder — never a candidate.
  { id: 'plain-chat', userId: OWNER, projectId: CM, coding: false, createdAt: 18, updatedAt: STALE, firstUserOrigin: 'agent' },
  // Archived lane — never a candidate.
  { id: 'arch-lane', userId: OWNER, projectId: CM, coding: true, archivedAt: STALE, createdAt: 19, updatedAt: STALE, firstUserOrigin: 'agent' },
  // A member's chat in the owner's folder (another userId — no supervisor of THAT owner).
  { id: 'mem-lane', userId: OTHER, projectId: CM, coding: true, createdAt: 20, updatedAt: STALE, firstUserOrigin: 'agent' },
];
const extras = () => ({
  tasks: [
    { childChatId: 'fam-4e2d280b', kind: 'ticket', origin: 'machine' },
    // A HUMAN session ledger row is not proof.
    { childChatId: 'own-heartbrk', kind: 'session', origin: 'user' },
  ],
  tickets: [
    { dispatchedTo: 'tl-241242d0' },
    { dispatchedTo: 'tl-other', previousLanes: ['tl-b839643b'] },
    // The standing lane held hundreds of old tickets — still excluded.
    { dispatchedTo: 'std-b92ef13f' },
    null,
  ],
});
const ENV = { PLATFORM_ENGINEER_CHAT_ID: 'std-b92ef13f' } as any;

describe('backfill-display-parent — dry run', () => {
  it('selects exactly the machine-spawned flat lanes, names each proof, writes nothing', async () => {
    const prisma = makePrisma(fleet(), extras());
    const r = await script.run({ prisma, argv: [], env: ENV });
    expect(r.dryRun).toBe(true);
    expect(r.supervisors).toBe(2);
    expect(r.standingLaneExcluded).toBe('std-b92e');
    expect(r.candidates).toBe(7); // 5 proven + own-heartbrk + api-bench01
    expect(r.proven).toBe(5);
    expect(r.unproven).toBe(2);
    expect(r.unprovenIds.sort()).toEqual(['api-benc', 'own-hear']);
    expect(r.byProof).toEqual({ p1_delegation: 1, p2_ticket: 2, p3_supervisor_parent: 1, p4_first_message: 1 });
    expect(r.byProject['proj-cro']).toEqual({ ps: 'ps-daee2', n: 4, ids: ['tl-24124:p2_ticket', 'tl-b8396:p2_ticket', 'fam-4e2d:p1_delegation', 'l-5f90c6:p4_first_message'] });
    expect(r.byProject['proj-spa']).toEqual({ ps: 'ps-590d6', n: 1, ids: ['ch-69fb2:p3_supervisor_parent'] });
    expect(r.wouldUpdate).toBe(5);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.contextStoreEntry.upsert).not.toHaveBeenCalled();
  });

  it('a folder whose supervisor is archived or belongs to another owner selects nothing there', async () => {
    const chats = fleet().map((c) => (c.id === 'ps-590d604e' ? { ...c, archivedAt: STALE } : c.id === 'ps-daee2916' ? { ...c, userId: OTHER } : c));
    const r = await script.run({ prisma: makePrisma(chats, extras()), argv: [], env: ENV });
    // Only the member's lane (userId OTHER) now matches the crossmodel supervisor's owner.
    expect(r.candidates).toBe(1);
    expect(r.byProject['proj-cro']).toEqual({ ps: 'ps-daee2', n: 1, ids: ['mem-lane:p4_first_message'] });
    expect(r.byProject['proj-spa']).toBeUndefined();
  });

  it('without the standing-lane env the R&D lane is a candidate (proved by its tickets)', async () => {
    const r = await script.run({ prisma: makePrisma(fleet(), extras()), argv: [], env: {} as any });
    expect(r.standingLaneExcluded).toBeNull();
    expect(r.byProject['proj-cro'].ids).toContain('std-b92e:p2_ticket');
  });

  it('second review fixer (2026-10-21): a first WEBHOOK message is not proof while the chat carries a ChatWebhook row — the same rule as lane-family-facts proveMachineSpawned', async () => {
    const chats: Chat[] = [
      { id: 'wh-owned', userId: OWNER, projectId: CM, createdAt: 1, updatedAt: STALE, firstUserOrigin: 'webhook' },
      { id: 'wh-bare', userId: OWNER, projectId: CM, createdAt: 2, updatedAt: STALE, firstUserOrigin: 'webhook' },
      { id: 'ag-lane', userId: OWNER, projectId: CM, createdAt: 3, updatedAt: STALE, firstUserOrigin: 'agent' },
    ];
    const prisma = makePrisma(chats);
    prisma.chatWebhook = { findMany: jest.fn(async ({ where }: any) => where.chatId.in.filter((id: string) => id === 'wh-owned').map((chatId: string) => ({ chatId }))) };
    const proofs = await script.proveMachineSpawn(prisma, chats);
    expect(Object.fromEntries(proofs)).toEqual({ 'wh-bare': 'p4_first_message', 'ag-lane': 'p4_first_message' });
    expect(prisma.chatWebhook.findMany).toHaveBeenCalledWith({ where: { chatId: { in: ['wh-owned', 'wh-bare'] } }, select: { chatId: true } });
  });

  it('usage errors throw', () => {
    expect(() => script.parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => script.parseArgs(['--limit', '-1'])).toThrow(/--limit must/);
  });
});

describe('backfill-display-parent — apply + revert', () => {
  it('--apply writes the marker first and the guarded raw update, leaving updatedAt alone; a re-run is a no-op', async () => {
    const prisma = makePrisma(fleet(), extras());
    const r = await script.run({ prisma, argv: ['--apply', '--run', 't1'], env: ENV });
    expect(r).toEqual(expect.objectContaining({ apply: true, updated: 5, skippedChanged: 0 }));
    const byId = new Map(prisma.chats.map((c: Chat) => [c.id, c]));
    for (const id of ['tl-241242d0', 'tl-b839643b', 'fam-4e2d280b', 'l-5f90c628']) {
      expect((byId.get(id) as Chat).displayParentChatId).toBe('ps-daee2916');
      expect((byId.get(id) as Chat).updatedAt).toBe(STALE); // idle clocks untouched
    }
    expect((byId.get('ch-69fb25fc') as Chat).displayParentChatId).toBe('ps-590d604e');
    for (const id of ['own-heartbrk', 'api-bench01', 'std-b92ef13f', 'ch-6ef785c3', 'plain-chat', 'arch-lane']) {
      expect((byId.get(id) as Chat).displayParentChatId ?? null).toBeNull();
    }
    expect(prisma.store.get('tl-241242d0:display-parent-backfill|previous').value).toEqual(expect.objectContaining({ previous: null, ps: 'ps-daee2916', proof: 'p2_ticket', run: 't1' }));
    // The marker precedes the update in each transaction.
    const first = prisma.$transaction.mock.calls[0][0];
    expect(first).toHaveLength(2);
    expect(prisma.contextStoreEntry.upsert.mock.invocationCallOrder[0]).toBeLessThan(prisma.$executeRaw.mock.invocationCallOrder[0]);
    expect(prisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    // Re-run: everything is stamped — nothing selected.
    const again = await script.run({ prisma, argv: ['--apply'], env: ENV });
    expect(again.candidates).toBe(2); // the two unproven chats only
    expect(again.updated).toBe(0);
  });

  it('a row stamped between the read and the write is skipped and leaves no marker', async () => {
    const prisma = makePrisma(fleet(), extras());
    const realUpsert = prisma.contextStoreEntry.upsert.getMockImplementation();
    prisma.contextStoreEntry.upsert.mockImplementation((args: any) => {
      // The runtime stamped tl-241242d0 concurrently.
      if (args.where.namespacePath_key.namespacePath.startsWith('tl-241242d0')) prisma.chats.find((c: Chat) => c.id === 'tl-241242d0').displayParentChatId = 'ps-runtime';
      return realUpsert(args);
    });
    const r = await script.run({ prisma, argv: ['--apply'], env: ENV });
    expect(r.updated).toBe(4);
    expect(r.skippedChanged).toBe(1);
    expect(prisma.chats.find((c: Chat) => c.id === 'tl-241242d0').displayParentChatId).toBe('ps-runtime');
    expect(prisma.store.has('tl-241242d0:display-parent-backfill|previous')).toBe(false);
  });

  it('a lane bumped while the proof queries run keeps its NEWER updatedAt (never rewound to the SELECT-time value)', async () => {
    const prisma = makePrisma(fleet(), extras());
    const BUMPED = new Date('2026-10-21T19:10:00Z');
    const realFindFirst = prisma.crossModelMessage.findFirst.getMockImplementation();
    prisma.crossModelMessage.findFirst.mockImplementation(async (args: any) => {
      // p4 runs after the candidate SELECT: a live run on l-5f90c628 bumps its row now.
      if (args.where.chatId === 'l-5f90c628') prisma.chats.find((c: Chat) => c.id === 'l-5f90c628').updatedAt = BUMPED;
      return realFindFirst(args);
    });
    const r = await script.run({ prisma, argv: ['--apply'], env: ENV });
    expect(r.updated).toBe(5);
    const lane = prisma.chats.find((c: Chat) => c.id === 'l-5f90c628');
    expect(lane.displayParentChatId).toBe('ps-daee2916');
    expect(lane.updatedAt).toBe(BUMPED);
    // The candidate SELECT no longer even reads updatedAt — nothing stale to write back.
    const selects = prisma.crossModelChat.findMany.mock.calls.map((c: any[]) => c[0].select);
    for (const sel of selects) expect(sel.updatedAt).toBeUndefined();
  });

  it('the stamp / clear statements are parameterised and name only displayParentChatId', () => {
    const calls: any[] = [];
    const fake = { $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => { calls.push({ sql: strings.join('?'), values }); return 0; } };
    script.stampSql(fake, 'lane-1', 'ps-1');
    script.clearSql(fake, 'lane-1', 'ps-1');
    expect(calls[0]).toEqual({ sql: 'UPDATE "crossmodel_chats" SET "displayParentChatId" = ? WHERE "id" = ? AND "displayParentChatId" IS NULL', values: ['ps-1', 'lane-1'] });
    expect(calls[1]).toEqual({ sql: 'UPDATE "crossmodel_chats" SET "displayParentChatId" = NULL WHERE "id" = ? AND "displayParentChatId" = ?', values: ['lane-1', 'ps-1'] });
    for (const c of calls) expect(c.sql).not.toMatch(/updatedAt/);
  });

  it('--limit caps the rows written', async () => {
    const prisma = makePrisma(fleet(), extras());
    const r = await script.run({ prisma, argv: ['--apply', '--limit', '2'], env: ENV });
    expect(r.updated).toBe(2);
    expect(prisma.store.size).toBe(2);
  });

  it('--revert (dry run) lists the marked rows; --revert --apply clears only rows still carrying the recorded supervisor', async () => {
    const prisma = makePrisma(fleet(), extras());
    await script.run({ prisma, argv: ['--apply'], env: ENV });
    // A runtime-stamped lane (no marker) must survive the revert.
    prisma.chats.push({ id: 'rt-lane', userId: OWNER, projectId: CM, coding: true, createdAt: 30, updatedAt: STALE, displayParentChatId: 'ps-daee2916' });
    // One marked lane was re-pointed since — left alone, marker kept.
    prisma.chats.find((c: Chat) => c.id === 'l-5f90c628').displayParentChatId = 'ps-moved';
    const dry = await script.run({ prisma, argv: ['--revert'], env: ENV });
    expect(dry.wouldRestore).toBe(5);
    expect(prisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    const r = await script.run({ prisma, argv: ['--revert', '--apply'], env: ENV });
    expect(r).toEqual(expect.objectContaining({ restored: 4, skippedChanged: 1, chatGone: 0 }));
    const byId = new Map(prisma.chats.map((c: Chat) => [c.id, c]));
    expect((byId.get('tl-241242d0') as Chat).displayParentChatId).toBeNull();
    expect((byId.get('tl-241242d0') as Chat).updatedAt).toBe(STALE);
    expect(prisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    expect((byId.get('rt-lane') as Chat).displayParentChatId).toBe('ps-daee2916');
    expect((byId.get('l-5f90c628') as Chat).displayParentChatId).toBe('ps-moved');
    expect(prisma.store.size).toBe(1);
  });

  it('--revert keeps a bump that landed after the marker read (never rewinds updatedAt)', async () => {
    const prisma = makePrisma(fleet(), extras());
    await script.run({ prisma, argv: ['--apply'], env: ENV });
    const BUMPED = new Date('2026-10-21T19:20:00Z');
    const realFindUnique = prisma.crossModelChat.findUnique.getMockImplementation();
    prisma.crossModelChat.findUnique.mockImplementation(async (args: any) => {
      const out = await realFindUnique(args);
      // A human typed into tl-b839643b between the revert's read and its write.
      if (args.where.id === 'tl-b839643b') prisma.chats.find((c: Chat) => c.id === 'tl-b839643b').updatedAt = BUMPED;
      return out;
    });
    const r = await script.run({ prisma, argv: ['--revert', '--apply'], env: ENV });
    expect(r.restored).toBe(5);
    const lane = prisma.chats.find((c: Chat) => c.id === 'tl-b839643b');
    expect(lane.displayParentChatId).toBeNull();
    expect(lane.updatedAt).toBe(BUMPED);
  });

  it('--revert --apply drops the marker of a chat that no longer exists', async () => {
    const prisma = makePrisma(fleet(), extras());
    await script.run({ prisma, argv: ['--apply'], env: ENV });
    prisma.chats.splice(prisma.chats.findIndex((c: Chat) => c.id === 'fam-4e2d280b'), 1);
    const r = await script.run({ prisma, argv: ['--revert', '--apply'], env: ENV });
    expect(r).toEqual(expect.objectContaining({ restored: 4, chatGone: 1 }));
    expect(prisma.store.size).toBe(0);
  });
});
