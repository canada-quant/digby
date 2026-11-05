/**
 * scripts/framework-audit/pause-hooks-archived-targets.js — the audit 2026-10-08
 * W3-5 one-shot on a MOCKED Prisma client: dry-run by default, --apply pauses
 * the owner's enabled hooks into ARCHIVED chats (guarded per row) and records
 * them in the SAME archive-paused store row the runtime restore reads,
 * --revert --run re-enables exactly what that run paused.
 */
import path from 'path';

const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'pause-hooks-archived-targets.js'));

type Hook = { id: string; userId: string; sourceChatId: string | null; targetChatId: string; createdVia: string | null; enabled: boolean; createdAt: Date };
type Chat = { id: string; userId: string; archivedAt: Date | null };

function makePrisma(hooks: Hook[], chats: Chat[]) {
  const store = new Map<string, any>();
  const k = (ns: string, key: string) => `${ns}::${key}`;
  const prisma: any = {
    store,
    eventHook: {
      findMany: jest.fn(async ({ where }: any) => hooks.filter((h) => (where.enabled === undefined || h.enabled === where.enabled)).map((h) => ({ ...h }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const h = hooks.find((x) => x.id === where.id && x.enabled === where.enabled);
        if (!h) return { count: 0 };
        h.enabled = data.enabled;
        return { count: 1 };
      }),
    },
    crossModelChat: {
      findMany: jest.fn(async ({ where }: any) => chats.filter((c) => where.id.in.includes(c.id) && c.archivedAt !== null).map((c) => ({ ...c }))),
    },
    contextStoreEntry: {
      findUnique: jest.fn(async ({ where }: any) => {
        const v = store.get(k(where.namespacePath_key.namespacePath, where.namespacePath_key.key));
        return v ? { value: v } : null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const id = k(where.namespacePath_key.namespacePath, where.namespacePath_key.key);
        store.set(id, store.has(id) ? update.value : create.value);
        return {};
      }),
      deleteMany: jest.fn(async ({ where }: any) => { store.delete(k(where.namespacePath, where.key)); return { count: 1 }; }),
    },
  };
  return prisma;
}

const fixture = () => {
  const hooks: Hook[] = [
    { id: 'h-child-result', userId: 'u1', sourceChatId: 'c-child', targetChatId: 'c-archived-parent', createdVia: 'system:child-result-hook', enabled: true, createdAt: new Date('2026-10-01') },
    { id: 'h-self-wake', userId: 'u1', sourceChatId: 'c-archived-lane', targetChatId: 'c-archived-lane', createdVia: 'system:direct-wake', enabled: true, createdAt: new Date('2026-10-02') },
    { id: 'h-live', userId: 'u1', sourceChatId: null, targetChatId: 'c-live-supervisor', createdVia: 'system:fleet-supervisor', enabled: true, createdAt: new Date('2026-09-01') },
    { id: 'h-foreign', userId: 'u2', sourceChatId: 'c-x', targetChatId: 'c-archived-parent', createdVia: null, enabled: true, createdAt: new Date('2026-10-03') },
    { id: 'h-already-off', userId: 'u1', sourceChatId: 'c-y', targetChatId: 'c-archived-parent', createdVia: null, enabled: false, createdAt: new Date('2026-10-03') },
  ];
  const chats: Chat[] = [
    { id: 'c-archived-parent', userId: 'u1', archivedAt: new Date('2026-10-05') },
    { id: 'c-archived-lane', userId: 'u1', archivedAt: new Date('2026-10-06') },
    { id: 'c-live-supervisor', userId: 'u1', archivedAt: null },
  ];
  return { hooks, chats };
};

describe('pause-hooks-archived-targets.js (audit 2026-10-08 W3-5)', () => {
  it('dry run (default) lists only the OWNER\'s enabled hooks into archived chats and writes nothing', async () => {
    const { hooks, chats } = fixture();
    const prisma = makePrisma(hooks, chats);
    const r = await script.run({ prisma, argv: [] });
    expect(r).toMatchObject({ dryRun: true, candidates: 2, chats: 2, wouldPause: 2 });
    expect(r.rows.map((x: any) => x.id)).toEqual(['h-child-result', 'h-self-wake']);
    expect(prisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(prisma.contextStoreEntry.upsert).not.toHaveBeenCalled();
  });

  it('--apply pauses them, merges into the runtime archive-paused record, and --revert re-enables exactly them', async () => {
    const { hooks, chats } = fixture();
    const prisma = makePrisma(hooks, chats);
    prisma.store.set('hooks:archive-paused:c-archived-parent::ids', { ids: ['h-older'], at: 'x' }); // an earlier runtime pause
    const r = await script.run({ prisma, argv: ['--apply', '--run', 'r1'] });
    expect(r).toMatchObject({ paused: 2, skippedChanged: 0, chats: 2 });
    expect(hooks.find((h) => h.id === 'h-child-result')!.enabled).toBe(false);
    expect(hooks.find((h) => h.id === 'h-live')!.enabled).toBe(true);
    expect(hooks.find((h) => h.id === 'h-foreign')!.enabled).toBe(true);
    expect(prisma.store.get('hooks:archive-paused:c-archived-parent::ids').ids).toEqual(['h-older', 'h-child-result']);
    expect(prisma.store.get('hooks:archive-paused:c-archived-lane::ids').ids).toEqual(['h-self-wake']);
    expect(prisma.store.get('hooks:archive-target-backfill::r1').hookIds).toEqual(['h-child-result', 'h-self-wake']);

    const dry = await script.run({ prisma, argv: ['--revert', '--run', 'r1'] });
    expect(dry).toMatchObject({ dryRun: true, recordedHooks: 2, wouldRestore: 2 });
    const rev = await script.run({ prisma, argv: ['--revert', '--run', 'r1', '--apply'] });
    expect(rev).toMatchObject({ restored: 2, skippedChanged: 0 });
    expect(hooks.find((h) => h.id === 'h-child-result')!.enabled).toBe(true);
    expect(prisma.store.has('hooks:archive-target-backfill::r1')).toBe(false);
  });

  it('a hook flipped between read and write is skipped, never overwritten; usage errors are explicit', async () => {
    const { hooks, chats } = fixture();
    const prisma = makePrisma(hooks, chats);
    const realUpdate = prisma.eventHook.updateMany.getMockImplementation();
    prisma.eventHook.updateMany.mockImplementationOnce(async (args: any) => { hooks.find((h) => h.id === 'h-child-result')!.enabled = false; return realUpdate(args); });
    const r = await script.run({ prisma, argv: ['--apply', '--run', 'r2'] });
    expect(r).toMatchObject({ paused: 1, skippedChanged: 1 });
    expect(() => script.parseArgs(['--revert'])).toThrow(/--revert needs --run/);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
