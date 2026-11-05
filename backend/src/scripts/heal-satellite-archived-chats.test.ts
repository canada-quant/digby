/**
 * scripts/framework-audit/heal-satellite-archived-chats.js — the lane
 * lifecycle C3 one-shot (2026-10-21) on a MOCKED Prisma client: dry-run by
 * default; --apply stamps archivedAt on satellite-archived, unstamped,
 * non-supervisor, schedule-free chats (guarded per row) with a per-chat
 * marker; --revert clears exactly the stamps it wrote.
 */
import path from 'path';

const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'heal-satellite-archived-chats.js'));

type Chat = { id: string; userId: string; projectId: string | null; title: string; updatedAt: Date; archivedAt: Date | null; isSupervisor: boolean; isProjectSupervisor: boolean; satellite: string | null; enabledSchedules: number };

function makePrisma(chats: Chat[]) {
  const store = new Map<string, any>();
  const k = (ns: string, key: string) => `${ns}::${key}`;
  const prisma: any = {
    store,
    crossModelChat: {
      findMany: jest.fn(async ({ where, take }: any) => chats
        .filter((c) => c.archivedAt === null && c.isSupervisor === where.isSupervisor && c.isProjectSupervisor === where.isProjectSupervisor
          && c.satellite === where.codingState.is.status && (where.chatSchedules?.none?.enabled ? c.enabledSchedules === 0 : true))
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()).slice(0, take)
        .map((c) => ({ id: c.id, userId: c.userId, projectId: c.projectId, title: c.title, updatedAt: c.updatedAt }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const c = chats.find((x) => x.id === where.id && (where.archivedAt === null ? x.archivedAt === null : x.archivedAt?.getTime() === where.archivedAt.getTime()));
        if (!c) return { count: 0 };
        c.archivedAt = data.archivedAt;
        return { count: 1 };
      }),
    },
    contextStoreEntry: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const id = k(where.namespacePath_key.namespacePath, where.namespacePath_key.key);
        store.set(id, { namespacePath: where.namespacePath_key.namespacePath, value: store.has(id) ? update.value : create.value });
        return {};
      }),
      findMany: jest.fn(async ({ where }: any) => [...store.entries()]
        .filter(([id]) => id.endsWith(`::${where.key}`) && id.split('::')[0].endsWith(where.namespacePath.endsWith))
        .map(([, v]) => ({ namespacePath: v.namespacePath, value: v.value }))),
      deleteMany: jest.fn(async ({ where }: any) => { store.delete(k(where.namespacePath, where.key)); return { count: 1 }; }),
    },
  };
  return prisma;
}

const fixture = (): Chat[] => [
  { id: 'b60a48b8', userId: 'u1', projectId: 'p-ui', title: 'stage_upload receipt proof 2', updatedAt: new Date('2026-09-26T22:01:00Z'), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, satellite: 'archived', enabledSchedules: 0 },
  { id: 'ca00a9a3', userId: 'u1', projectId: 'p-ui', title: 'stage_upload worktreePath PNG verify', updatedAt: new Date('2026-09-26T22:02:00Z'), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, satellite: 'archived', enabledSchedules: 0 },
  { id: 'c-scheduled', userId: 'u1', projectId: 'p-ui', title: 'watch', updatedAt: new Date('2026-09-20'), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, satellite: 'archived', enabledSchedules: 1 },
  { id: 'c-sup', userId: 'u1', projectId: 'p-ui', title: 'X Supervisor', updatedAt: new Date('2026-09-20'), archivedAt: null, isSupervisor: false, isProjectSupervisor: true, satellite: 'archived', enabledSchedules: 0 },
  { id: 'c-stamped', userId: 'u1', projectId: 'p-ui', title: 'already archived', updatedAt: new Date('2026-09-20'), archivedAt: new Date('2026-09-21'), isSupervisor: false, isProjectSupervisor: false, satellite: 'archived', enabledSchedules: 0 },
  { id: 'c-ready', userId: 'u1', projectId: 'p-ui', title: 'live lane', updatedAt: new Date('2026-09-20'), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, satellite: 'ready', enabledSchedules: 0 },
];

describe('heal-satellite-archived-chats.js (lane lifecycle C3, 2026-10-21)', () => {
  it('dry run (default) lists only satellite-archived, unstamped, non-supervisor, schedule-free chats and writes nothing', async () => {
    const chats = fixture();
    const prisma = makePrisma(chats);
    const r = await script.run({ prisma, argv: [] });
    expect(r).toMatchObject({ dryRun: true, candidates: 2, wouldHeal: 2 });
    expect(r.rows.map((x: any) => x.id)).toEqual(['b60a48b8', 'ca00a9a3']);
    expect(prisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    expect(prisma.contextStoreEntry.upsert).not.toHaveBeenCalled();
  });

  it('--apply stamps them (marker first), --revert clears exactly those stamps and drops the markers', async () => {
    const chats = fixture();
    const prisma = makePrisma(chats);
    const r = await script.run({ prisma, argv: ['--apply', '--run', 'h1'] });
    expect(r).toMatchObject({ healed: 2, skippedChanged: 0, healedIds: ['b60a48b8', 'ca00a9a3'] });
    expect(chats.find((c) => c.id === 'b60a48b8')!.archivedAt).toBeInstanceOf(Date);
    expect(chats.find((c) => c.id === 'c-scheduled')!.archivedAt).toBeNull();
    expect(chats.find((c) => c.id === 'c-sup')!.archivedAt).toBeNull();
    expect(prisma.store.get('b60a48b8:satellite-archive-heal::previous').value).toMatchObject({ previousArchivedAt: null, run: 'h1' });

    const dry = await script.run({ prisma, argv: ['--revert'] });
    expect(dry).toMatchObject({ dryRun: true, markers: 2, wouldRestore: 2, chats: ['b60a48b8', 'ca00a9a3'] });
    // a chat archived AGAIN since the heal keeps its newer stamp
    const newer = new Date('2026-10-22T00:00:00Z');
    chats.find((c) => c.id === 'ca00a9a3')!.archivedAt = newer;
    const rev = await script.run({ prisma, argv: ['--revert', '--apply'] });
    expect(rev).toMatchObject({ restored: 1, skippedChanged: 1 });
    expect(chats.find((c) => c.id === 'b60a48b8')!.archivedAt).toBeNull();
    expect(chats.find((c) => c.id === 'ca00a9a3')!.archivedAt).toBe(newer);
    expect(prisma.store.size).toBe(0);
  });

  it('a chat stamped between read and write is skipped (its marker dropped); usage errors are explicit', async () => {
    const chats = fixture();
    const prisma = makePrisma(chats);
    const real = prisma.crossModelChat.updateMany.getMockImplementation();
    prisma.crossModelChat.updateMany.mockImplementationOnce(async (args: any) => { chats.find((c) => c.id === 'b60a48b8')!.archivedAt = new Date(); return real(args); });
    const r = await script.run({ prisma, argv: ['--apply'] });
    expect(r).toMatchObject({ healed: 1, skippedChanged: 1, healedIds: ['ca00a9a3'] });
    expect(prisma.store.has('b60a48b8:satellite-archive-heal::previous')).toBe(false);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => script.parseArgs(['--limit', '-1'])).toThrow(/--limit must/);
  });
});
