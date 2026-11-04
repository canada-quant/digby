/**
 * audit 2026-10-06 T3-8 (schooltime F4) — the unfiled-decision path no longer
 * auto-files an owner question for work already acted on since the note.
 * Replay: note e38d0e31 (23:40Z) "30532e70 … capture is owner-gated"; the
 * supervisor steered the lane at 00:29Z and todo 30532e70 went in_progress at
 * 00:27:56Z; the detector still filed oq_d2110692 at 01:12Z. Pins: the todo
 * moved / its assignee ran / a receipt names the id ⇒ no card (decision_autofiled
 * outcome 'acted_since'); nothing moved ⇒ files as before; kill switch
 * FOLLOW_THROUGH_ACTED_SINCE_DISABLED=1 files. Harness mirrors
 * follow-through.be90502f.test.ts.
 */

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  agentRun: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { sweepFollowThrough, idRefsIn } from './follow-through.service';
import { recordLoopMetric } from '../platform/loop-metrics.service';

const mockMetric = recordLoopMetric as jest.Mock;
const NOW = new Date('2026-10-06T01:12:00Z');
const NOTE_AT = new Date('2026-10-05T23:40:00Z');
const SUP = '41bd202a-0000-4000-8000-000000000000';
const PROJ = 'proj-schooltime';
const CLAIM = 'Todo 30532e70 left pending deliberately — the recorder capture is owner-gated.';
const SUP_ROW: any = { id: SUP, userId: 'u1', title: 'Schooltime Supervisor', projectId: PROJ, isSupervisor: false, isProjectSupervisor: true };
const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_d2110692-aaaa' } }));
const wake = jest.fn(async () => ({}));

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  delete process.env.FOLLOW_THROUGH_ACTED_SINCE_DISABLED;
  mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => (args?.where?.OR ? [SUP_ROW] : args?.where?.projectId ? [{ id: 'lane-1' }] : []));
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PROJ, projectSupervisorEnabled: true, archivedAt: null }]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ id: 'note-e38d0e31', content: CLAIM, createdAt: NOTE_AT, metadata: { origin: 'hook' } }]);
  mockPrisma.ownerQuestion.findFirst.mockResolvedValue(null);
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findFirst.mockResolvedValue(null);
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  store.set(`follow-through:cursor:${SUP}`, String(new Date('2026-10-05T23:00:00Z').getTime()));
});

const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });
const actedSinceMetric = () => mockMetric.mock.calls.find((c: any[]) => c[0]?.kind === 'decision_autofiled' && c[0]?.meta?.outcome === 'acted_since');

describe('T3-8 — no auto-filed owner decision for work already moving', () => {
  it('idRefsIn picks the 8-hex ids (≥1 letter) a claim names', () => {
    expect(idRefsIn(CLAIM)).toEqual(['30532e70']);
    expect(idRefsIn('build 20261005 and todo deadbeef plus oq_abcdef12 and ab12cd34ef')).toEqual(['deadbeef']);
  });

  it('REPLAY: the todo went in_progress after the note ⇒ nothing is filed; telemetry says acted_since', async () => {
    mockPrisma.projectTodo.findFirst.mockResolvedValue({ status: 'in_progress', startedAt: new Date('2026-10-06T00:27:56Z'), updatedAt: new Date('2026-10-06T00:27:56Z'), assigneeChatId: 'lane-1' });
    const out = await run();
    expect(flag).not.toHaveBeenCalled();
    expect(out.autofiled).toBe(0);
    expect(actedSinceMetric()?.[0]?.meta).toMatchObject({ id8: '30532e70' });
    expect(mockPrisma.projectTodo.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { startsWith: '30532e70' }, userId: 'u1' } }));
  });

  it('the todo is still pending but its ASSIGNEE ran after the note ⇒ nothing is filed', async () => {
    mockPrisma.projectTodo.findFirst.mockResolvedValue({ status: 'pending', startedAt: null, updatedAt: new Date('2026-10-05T20:00:00Z'), assigneeChatId: 'lane-1' });
    mockPrisma.agentRun.findFirst.mockImplementation(async ({ where }: any) => (where.sessionId === 'lane-1' ? { id: 'run-1' } : null));
    await run();
    expect(flag).not.toHaveBeenCalled();
    expect(actedSinceMetric()).toBeTruthy();
  });

  it('the supervisor\'s own todo_update receipt naming the id since the note ⇒ nothing is filed (the diagnosis path\'s acted-since check)', async () => {
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ tool: 'todo_update', ids: { todoId: '30532e70-1111-2222-3333-444444444444' } }]);
    await run();
    expect(flag).not.toHaveBeenCalled();
  });

  it('nothing moved ⇒ the decision is filed exactly as before; the kill switch files even when the todo moved', async () => {
    mockPrisma.projectTodo.findFirst.mockResolvedValue({ status: 'pending', startedAt: null, updatedAt: new Date('2026-10-05T20:00:00Z'), assigneeChatId: 'lane-1' });
    await run();
    expect(flag).toHaveBeenCalledTimes(1);

    jest.clearAllMocks(); store.clear();
    store.set(`follow-through:cursor:${SUP}`, String(new Date('2026-10-05T23:00:00Z').getTime()));
    process.env.FOLLOW_THROUGH_ACTED_SINCE_DISABLED = '1';
    mockPrisma.projectTodo.findFirst.mockResolvedValue({ status: 'in_progress', startedAt: new Date('2026-10-06T00:27:56Z'), updatedAt: new Date('2026-10-06T00:27:56Z'), assigneeChatId: 'lane-1' });
    await run();
    expect(flag).toHaveBeenCalledTimes(1);
  });
});
