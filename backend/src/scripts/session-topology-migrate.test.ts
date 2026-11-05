/**
 * scripts/framework-audit/session-topology-migrate.js on a MOCKED Prisma
 * client (SESSION_TITLES_TOPOLOGY design §C): dry-run by default (plans +
 * report, no writes), --apply binds charters (open todos majority → plan/title
 * word overlap → null), retitles charter lanes to "<goal> · <step>" (spawn-param
 * keeps its goal half), stamps charter-less lanes 'llm', PINS a human-renamed
 * lane instead of touching it, keeps every previous value in the store and
 * writes the per-project report (duplicate groups / R4 / R6); --revert restores
 * byte-for-byte and drops the store rows. The helpers come from the real TS
 * modules (the script `require`s their dist twins in the container).
 */
// The TS helpers are pure, but their modules import the app's prisma / logger /
// gate at load — stub those so the test never validates env or opens a client.
jest.mock('../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../modules/crossmodel/platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));
jest.mock('../modules/crossmodel/platform/decision-gate', () => ({ __esModule: true, decide: jest.fn(), decisionMode: jest.fn(() => 'off'), decisionThreshold: (_p: string, f: number) => f, stashDecision: jest.fn() }));

import path from 'path';
import { renderSessionTitle, splitSessionTitle, clipWords, stepFromReceipt, stepFromRunState } from '../modules/crossmodel/platform/session-titles';
import { normalizeGoalWords, jaccard } from '../modules/crossmodel/platform/session-topology';
import { PLATFORM_MUTATING_TOOLS } from '../modules/crossmodel/platform/platform-tool-names';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'session-topology-migrate.js'));
const lib = { renderSessionTitle, splitSessionTitle, clipWords, stepFromReceipt, stepFromRunState, normalizeGoalWords, jaccard, mutatingTools: [...PLATFORM_MUTATING_TOOLS, 'open_pull_request', 'merge_pull_request', 'run_command'] };

const NOW = new Date('2026-09-27T15:00:00Z');
const H = 3600_000;

function makePrisma() {
  const chats: any[] = [
    { id: 'lane-todo', title: 'Kickoff received', projectId: 'p1', userId: 'u1', charterGoalId: null, charterTodoId: null, titlePinned: false, createdAt: new Date(NOW.getTime() - 3 * 86400_000), updatedAt: new Date(NOW.getTime() - 2 * H), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, coding: true },
    { id: 'lane-spawn', title: 'H2H bench S3 S5', projectId: 'p1', userId: 'u1', charterGoalId: null, charterTodoId: null, titlePinned: false, createdAt: new Date(NOW.getTime() - 3 * 86400_000), updatedAt: new Date(NOW.getTime() - 30 * 60_000), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, coding: true },
    { id: 'lane-human', title: 'Paul renamed this one', projectId: 'p1', userId: 'u1', charterGoalId: null, charterTodoId: null, titlePinned: false, createdAt: new Date(NOW.getTime() - 3 * 86400_000), updatedAt: NOW, archivedAt: null, isSupervisor: false, isProjectSupervisor: false, coding: true },
    { id: 'lane-none', title: 'Bounty Submission Status Inquiry', projectId: 'p1', userId: 'u1', charterGoalId: null, charterTodoId: null, titlePinned: false, createdAt: new Date(NOW.getTime() - 9 * 86400_000), updatedAt: new Date(NOW.getTime() - 20 * H), archivedAt: null, isSupervisor: false, isProjectSupervisor: false, coding: true },
    { id: 'sup', title: 'P1 Supervisor', projectId: 'p1', userId: 'u1', charterGoalId: null, charterTodoId: null, titlePinned: false, createdAt: NOW, updatedAt: NOW, archivedAt: null, isSupervisor: false, isProjectSupervisor: true, coding: false },
    { id: 'archived', title: 'Old', projectId: 'p1', userId: 'u1', charterGoalId: null, charterTodoId: null, titlePinned: false, createdAt: NOW, updatedAt: NOW, archivedAt: NOW, isSupervisor: false, isProjectSupervisor: false, coding: true },
  ];
  const states: any[] = [
    { id: 'lane-todo', titleSource: null, title: 'Kickoff received' },
    { id: 'lane-spawn', titleSource: 'spawn-param', title: 'H2H bench S3 S5' },
    { id: 'lane-human', titleSource: null, title: 'Paul renamed this one' },
    { id: 'lane-none', titleSource: null, title: 'Bounty Submission Status Inquiry' },
  ];
  const store = new Map<string, any>();
  const k = (ns: string, key: string) => `${ns}|${key}`;
  const prisma: any = {
    chats, states, store,
    crossModelChat: {
      findMany: jest.fn(async ({ where, take }: any) => {
        let rows = chats.filter((c) => c.archivedAt === null && !c.isSupervisor && !c.isProjectSupervisor && c.coding && (!where.projectId || c.projectId === where.projectId));
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((c) => ({ ...c }));
      }),
      update: jest.fn(async ({ where, data }: any) => { const c = chats.find((x) => x.id === where.id); Object.assign(c, data); return c; }),
    },
    chatCodingState: {
      findMany: jest.fn(async ({ where }: any) => states.filter((s) => where.id.in.includes(s.id)).map((s) => ({ id: s.id, titleSource: s.titleSource }))),
      update: jest.fn(async ({ where, data }: any) => { const s = states.find((x) => x.id === where.id); Object.assign(s, data); return s; }),
    },
    projectTodo: { findMany: jest.fn(async () => [{ id: 'todo-1', goalId: 'goal-1', assigneeChatId: 'lane-todo' }, { id: 'todo-2', goalId: 'goal-1', assigneeChatId: 'lane-todo' }, { id: 'todo-3', goalId: 'goal-2', assigneeChatId: 'lane-todo' }]) },
    projectGoal: { findMany: jest.fn(async () => [{ id: 'goal-1', projectId: 'p1', title: 'Fix the upload MIME type on lane images' }, { id: 'goal-2', projectId: 'p1', title: 'Something else' }, { id: 'goal-3', projectId: 'p1', title: 'H2H bench S3 S5 shards' }]) },
    chatSchedule: { findMany: jest.fn(async () => []) },
    runToolReceipt: { findMany: jest.fn(async () => [{ chatId: 'lane-todo', tool: 'open_pull_request', ids: { prNumber: 41 }, createdAt: new Date(NOW.getTime() - H) }]) },
    agentRun: { groupBy: jest.fn(async () => [{ sessionId: 'lane-none', _count: { _all: 252 } }, { sessionId: 'lane-todo', _count: { _all: 9 } }]) },
    activity: { findMany: jest.fn(async () => [{ metadata: { chatId: 'lane-human', title: 'Paul renamed this one' } }, { metadata: { chatId: 'lane-spawn', title: 'H2H bench S3 S5', pin: false } }]) },
    contextStoreEntry: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.key === 'plan') return [];
        return [...store.values()].filter((r) => r.namespacePath.endsWith(where.namespacePath.endsWith) && r.key === where.key);
      }),
      upsert: jest.fn(async ({ where, create }: any) => { store.set(k(where.namespacePath_key.namespacePath, where.namespacePath_key.key), { ...create }); return create; }),
      delete: jest.fn(async ({ where }: any) => { store.delete(k(where.namespacePath_key.namespacePath, where.namespacePath_key.key)); return {}; }),
    },
  };
  return prisma;
}

describe('session-topology-migrate.js', () => {
  it('parseArgs: defaults, flags, usage errors', () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, revert: false, limit: null, overlap: 0.6, project: null });
    expect(script.parseArgs(['--apply', '--limit=5', '--project', 'p1', '--overlap', '0.5'])).toMatchObject({ apply: true, limit: 5, project: 'p1', overlap: 0.5 });
    expect(() => script.parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => script.parseArgs(['--overlap', '2'])).toThrow(/--overlap/);
  });

  it('dry run: plans every live coding lane (supervisors + archived excluded), binds charters (todo majority / word overlap / none), pins the human rename, writes NOTHING', async () => {
    const prisma = makePrisma();
    const r = await script.run({ prisma, argv: [], lib, now: NOW });
    expect(r).toMatchObject({ action: 'forward', dryRun: true, lanes: 4 });
    expect(r.byAction).toEqual({ retitle: 2, pin: 1, 'stamp:llm': 1 });
    const by = Object.fromEntries(r.changes.map((c: any) => [c.chatId, c]));
    expect(by['lane-todo']).toMatchObject({ action: 'retitle', charterGoalId: 'goal-1', charterSource: 'todos', to: 'Fix the upload MIME type · PR #41 opened' });
    expect(by['lane-spawn']).toMatchObject({ action: 'retitle', charterGoalId: 'goal-3', charterSource: expect.stringMatching(/^overlap:/), to: 'H2H bench S3 S5 · idle 30 m' });
    expect(by['lane-human']).toMatchObject({ action: 'pin' });
    expect(by['lane-none']).toMatchObject({ action: 'stamp:llm', charterGoalId: null });
    expect(r.topology.p1).toMatchObject({ lanes: 4 });
    expect(r.topology.p1.r4Candidates.map((c: any) => c.chatId)).toEqual(['lane-none']);
    expect(r.topology.p1.r6Candidates.map((c: any) => c.chatId)).toEqual(expect.arrayContaining(['lane-none']));
    expect(prisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(prisma.contextStoreEntry.upsert).not.toHaveBeenCalled();
  });

  it('--apply: store row first, then the chat + satellite writes; the report lands in the store; --revert restores byte-for-byte and drops the rows', async () => {
    const prisma = makePrisma();
    const r = await script.run({ prisma, argv: ['--apply', '--run', 'r1'], lib, now: NOW });
    expect(r).toMatchObject({ apply: true, updated: 2, pinned: 1, stamped: 1, reportsWritten: 1 });
    const todoLane = prisma.chats.find((c: any) => c.id === 'lane-todo');
    expect(todoLane).toMatchObject({ title: 'Fix the upload MIME type · PR #41 opened', titleStep: 'PR #41 opened', charterGoalId: 'goal-1', charterTodoId: null });
    expect(prisma.states.find((s: any) => s.id === 'lane-todo')).toMatchObject({ title: 'Fix the upload MIME type · PR #41 opened', titleSource: 'harness' });
    expect(prisma.states.find((s: any) => s.id === 'lane-spawn')).toMatchObject({ titleSource: 'spawn-param' });
    expect(prisma.chats.find((c: any) => c.id === 'lane-human')).toMatchObject({ title: 'Paul renamed this one', titlePinned: true });
    expect(prisma.states.find((s: any) => s.id === 'lane-human')).toMatchObject({ titleSource: 'user' });
    expect(prisma.states.find((s: any) => s.id === 'lane-none')).toMatchObject({ titleSource: 'llm' });
    expect(prisma.store.get('lane-todo:title-migration|previous').value).toMatchObject({ title: 'Kickoff received', titleSource: null, charterGoalId: null, titlePinned: false, run: 'r1' });
    expect(prisma.store.get('instance:session-topology|report-p1').value).toMatchObject({ lanes: 4, run: 'r1' });

    const dry = await script.run({ prisma, argv: ['--revert'], lib, now: NOW });
    expect(dry).toMatchObject({ action: 'revert', dryRun: true, backfilledRows: 4, wouldRestore: 4 });
    const rev = await script.run({ prisma, argv: ['--revert', '--apply'], lib, now: NOW });
    expect(rev).toMatchObject({ restored: 4 });
    expect(prisma.chats.find((c: any) => c.id === 'lane-todo')).toMatchObject({ title: 'Kickoff received', charterGoalId: null, titlePinned: false, titleStep: null });
    expect(prisma.chats.find((c: any) => c.id === 'lane-human')).toMatchObject({ titlePinned: false });
    expect(prisma.states.find((s: any) => s.id === 'lane-todo')).toMatchObject({ title: 'Kickoff received', titleSource: null });
    expect([...prisma.store.keys()].filter((key) => key.includes('title-migration'))).toEqual([]);
  });
});
