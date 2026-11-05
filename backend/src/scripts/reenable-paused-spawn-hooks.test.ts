/**
 * scripts/framework-audit/reenable-paused-spawn-hooks.js — the audit 2026-10-08
 * W1-1 one-shot on a MOCKED Prisma client. Shapes from the One Piece incident:
 * paused supervisor 5c3f302e, child result hooks 7ad7880d (lane 7bd45d57) /
 * 0d49b520 (lane e91d41cf) and the supervisor's own direct-wake hook fda79d56,
 * each disabled by a `project_supervisor.pause` row minutes after creation.
 * Dry-run by default; --apply re-enables only the safe ones (guarded write +
 * audit row); --revert disables exactly what --apply enabled.
 */
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'reenable-paused-spawn-hooks.js'));

const U = '83e4fbf9-0000-4000-8000-000000000000';
const PS = '5c3f302e-0000-4000-8000-000000000001';
const PROJ = 'op-project';
type Hook = { id: string; userId: string; sourceChatId: string | null; targetChatId: string; createdVia: string | null; enabled: boolean; projectId?: string | null; createdAt: Date };
type Chat = { id: string; archivedAt: Date | null; projectId: string | null; isProjectSupervisor: boolean; isSupervisor: boolean };

function makePrisma(hooks: Hook[], chats: Chat[], pauses: Array<{ userId: string; createdAt: Date; metadata: any }>) {
  const activities: any[] = pauses.map((p) => ({ ...p, action: 'project_supervisor.pause' }));
  return {
    hooks,
    activities,
    eventHook: {
      findMany: jest.fn(async ({ where }: any) => hooks.filter((h) =>
        (where.enabled === undefined || h.enabled === where.enabled)
        && (!where.createdVia?.in || where.createdVia.in.includes(h.createdVia)))),
      findFirst: jest.fn(async ({ where }: any) => hooks.find((h) =>
        h.sourceChatId === where.sourceChatId && h.targetChatId === where.targetChatId && h.projectId === where.projectId && h.enabled === where.enabled) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const h = hooks.find((x) => x.id === where.id && x.enabled === where.enabled);
        if (!h) return { count: 0 };
        h.enabled = data.enabled;
        return { count: 1 };
      }),
    },
    crossModelChat: { findMany: jest.fn(async ({ where }: any) => chats.filter((c) => where.id.in.includes(c.id))) },
    activity: {
      findMany: jest.fn(async ({ where }: any) => activities.filter((a) =>
        a.userId === where.userId && a.action === where.action && a.createdAt >= where.createdAt.gte)),
      create: jest.fn(async ({ data }: any) => { activities.push({ ...data, createdAt: new Date() }); return data; }),
    },
  };
}

const at = (iso: string) => new Date(iso);
function incident() {
  const hooks: Hook[] = [
    { id: '7ad7880d-0000-4000-8000-0000000000a1', userId: U, sourceChatId: '7bd45d57-lane', targetChatId: PS, createdVia: 'system:child-result-hook', enabled: false, createdAt: at('2026-10-07T21:55:36Z') },
    { id: '0d49b520-0000-4000-8000-0000000000a2', userId: U, sourceChatId: 'e91d41cf-lane', targetChatId: PS, createdVia: 'system:child-result-hook', enabled: false, createdAt: at('2026-10-08T18:23:01Z') },
    { id: 'fda79d56-0000-4000-8000-0000000000a3', userId: U, sourceChatId: PS, targetChatId: PS, createdVia: 'system:direct-wake', enabled: false, createdAt: at('2026-10-08T18:17:00Z') },
    // a child that was archived since — its hook stays off
    { id: '688c661a-0000-4000-8000-0000000000a4', userId: U, sourceChatId: '3532d1ad-lane', targetChatId: PS, createdVia: 'system:child-result-hook', enabled: false, createdAt: at('2026-10-08T16:14:58Z') },
    // the project-scope hook (disabled by the owner's toggle-OFF) — never touched
    { id: 'proj-hook', userId: U, sourceChatId: null, targetChatId: PS, createdVia: null, enabled: false, projectId: PROJ, createdAt: at('2026-09-20T00:00:00Z') },
  ];
  const chats: Chat[] = [
    { id: PS, archivedAt: null, projectId: PROJ, isProjectSupervisor: true, isSupervisor: false },
    { id: '7bd45d57-lane', archivedAt: null, projectId: PROJ, isProjectSupervisor: false, isSupervisor: false },
    { id: 'e91d41cf-lane', archivedAt: null, projectId: PROJ, isProjectSupervisor: false, isSupervisor: false },
    { id: '3532d1ad-lane', archivedAt: at('2026-10-08T17:00:00Z'), projectId: PROJ, isProjectSupervisor: false, isSupervisor: false },
  ];
  const pauses = [
    { userId: U, createdAt: at('2026-10-07T21:58:48Z'), metadata: { chatId: PS, hookIds: ['7ad7880d-0000-4000-8000-0000000000a1'] } },
    { userId: U, createdAt: at('2026-10-08T16:19:23Z'), metadata: { chatId: PS, hookIds: ['688c661a-0000-4000-8000-0000000000a4'] } },
    { userId: U, createdAt: at('2026-10-08T18:19:56Z'), metadata: { chatId: PS, hookIds: ['fda79d56-0000-4000-8000-0000000000a3'] } },
    { userId: U, createdAt: at('2026-10-08T18:35:01Z'), metadata: { chatId: PS, hookIds: ['0d49b520-0000-4000-8000-0000000000a2'] } },
  ];
  return { hooks, chats, pauses };
}

describe('reenable-paused-spawn-hooks.js', () => {
  it('dry run (default) classifies and writes nothing', async () => {
    const { hooks, chats, pauses } = incident();
    const prisma = makePrisma(hooks, chats, pauses);
    const r = await script.run({ prisma, argv: [] });
    expect(r.dryRun).toBe(true);
    expect(r.wouldReenable).toBe(3);
    expect(r.byReason).toEqual({ 'reenable:supervision_paused': 2, 'reenable:direct_wake_plumbing': 1, 'skip:child_archived': 1 });
    expect(prisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('--apply re-enables the safe hooks with a guarded write + one audit row per supervisor; the project-scope hook is never touched', async () => {
    const { hooks, chats, pauses } = incident();
    const prisma = makePrisma(hooks, chats, pauses);
    const r = await script.run({ prisma, argv: ['--apply', '--run', 'r1'] });
    expect(r.reenabled).toBe(3);
    expect(hooks.filter((h) => h.enabled).map((h) => h.id.slice(0, 8)).sort()).toEqual(['0d49b520', '7ad7880d', 'fda79d56']);
    expect(hooks.find((h) => h.id === 'proj-hook')!.enabled).toBe(false);
    expect(prisma.activity.create).toHaveBeenCalledTimes(1);
    expect(prisma.activity.create.mock.calls[0][0].data).toMatchObject({ userId: U, action: script.AUDIT_ACTION, metadata: expect.objectContaining({ chatId: PS, run: 'r1' }) });
    // --revert disables exactly those three again
    const back = await script.run({ prisma, argv: ['--revert', '--apply', '--run', 'r1'] });
    expect(back.disabled).toBe(3);
    expect(hooks.every((h) => !h.enabled)).toBe(true);
  });

  it('a supervisor whose project hook is LIVE again keeps its in-project child hooks off (the project hook already delivers them)', async () => {
    const { hooks, chats, pauses } = incident();
    hooks.find((h) => h.id === 'proj-hook')!.enabled = true;
    const prisma = makePrisma(hooks, chats, pauses);
    const r = await script.run({ prisma, argv: [] });
    expect(r.byReason['skip:supervision_live_project_hook_covers']).toBe(2);
    expect(r.wouldReenable).toBe(1); // only the direct-wake self-hook
  });

  it('rejects unknown args and a bad --since', () => {
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => script.parseArgs(['--since', 'not-a-date'])).toThrow(/--since must/);
  });
});
