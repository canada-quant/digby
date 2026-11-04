/**
 * ARCHIVED-TARGET-RETIRE (2026-10-20) — the leaf: pure text / predicate helpers
 * and the shared DB helpers (supervisor resolution, the archive-time todo
 * unassign + ONE todo_wake). The seams that call it are pinned in
 * coding/schedule.service.test.ts (sweeper pause, arm refusals, restore round
 * trip) and platform/owner-questions.archived-reroute.test.ts (owner-answer
 * re-route).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockProjectFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockTodoFindMany: jest.Mock = jest.fn(async (): Promise<any[]> => []);
const mockTodoUpdateMany: jest.Mock = jest.fn(async (): Promise<any> => ({ count: 0 }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findFirst: (...a: any[]) => mockChatFindFirst(...a) },
    crossModelProject: { findFirst: (...a: any[]) => mockProjectFindFirst(...a) },
    projectTodo: {
      findMany: (...a: any[]) => mockTodoFindMany(...a),
      updateMany: (...a: any[]) => mockTodoUpdateMany(...a),
    },
  },
}));

const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { ARCHIVED_TARGET_RETIRE: 'archived_target_retire' },
}));

import {
  archivedTargetRetireDisabled, isArchivedTargetRow, archivedTargetRefusal, ownerAnswerRerouteWake,
  orphanedTodosWake, archivedLaneProgressNote, readArchivedTarget, isArchivedScheduleTarget,
  resolveLaneSupervisor, unassignTodosForArchivedLane, ARCHIVED_SCHEDULE_LAST_STATUS, ARCHIVE_PAUSED_SCHEDULES_NS,
  ARCHIVED_LANE_LIVE_TODO_STATUSES, composeArchivedLaneProgressNote, previousLaneNote, actorInheritedTodosNote,
  ARCHIVED_LANE_HOLD_LEAD_RE,
} from './archived-target-retire';
import { LOOP_METRIC_KINDS } from './loop-metric-kinds';

const flush = () => new Promise((r) => setImmediate(r));

/** Chat rows by id + the supervisor lanes — answers findFirst by its where clause. */
function chatTable(rows: Record<string, any>, sup: { ps?: Record<string, string>; fs?: string | null } = {}) {
  mockChatFindFirst.mockImplementation(async ({ where }: any) => {
    if (where?.isProjectSupervisor) {
      const id = sup.ps?.[where.projectId];
      return id ? { id } : null;
    }
    if (where?.isSupervisor) return sup.fs ? { id: sup.fs } : null;
    return rows[where?.id] ?? null;
  });
}

beforeEach(() => {
  delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
  mockChatFindFirst.mockReset().mockResolvedValue(null);
  mockProjectFindFirst.mockReset().mockResolvedValue({ supervised: true });
  mockTodoFindMany.mockReset().mockResolvedValue([]);
  mockTodoUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
  mockRecordLoopMetric.mockReset();
});
afterAll(() => { delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED; });

describe('pure helpers', () => {
  it('the kill switch reads per call; constants are stable', () => {
    expect(archivedTargetRetireDisabled()).toBe(false);
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    expect(archivedTargetRetireDisabled()).toBe(true);
    expect(ARCHIVED_SCHEDULE_LAST_STATUS).toBe('paused:archived');
    expect(ARCHIVE_PAUSED_SCHEDULES_NS('c1')).toEqual(['schedules', 'archive-paused', 'c1']);
    expect([...ARCHIVED_LANE_LIVE_TODO_STATUSES]).toEqual(['pending', 'in_progress', 'blocked']);
    expect(LOOP_METRIC_KINDS.ARCHIVED_TARGET_RETIRE).toBe('archived_target_retire');
  });

  it('isArchivedTargetRow: an archivedAt stamp OR a satellite parked archived; anything else (incl. null) is live', () => {
    expect(isArchivedTargetRow({ archivedAt: new Date() })).toBe(true);
    expect(isArchivedTargetRow({ archivedAt: null, codingState: { status: 'archived' } })).toBe(true);
    expect(isArchivedTargetRow({ archivedAt: null, codingState: { status: 'ready' } })).toBe(false);
    expect(isArchivedTargetRow({ archivedAt: null, codingState: null })).toBe(false);
    expect(isArchivedTargetRow(null)).toBe(false);
  });

  it('the arm refusal names the chat, says nothing was armed and gives both ways forward', () => {
    const create = archivedTargetRefusal('chat-9', 'create');
    expect(create).toMatch(/^Refused: chat chat-9 is ARCHIVED/);
    expect(create).toContain('Nothing was created');
    expect(create).toContain('start_coding_session');
    expect(create).toContain('restore the chat first');
    expect(archivedTargetRefusal('chat-9', 'resume')).toContain('Nothing was resumed');
  });

  it('the re-route wake carries the archived lane id, the question id, the tier and the original wake verbatim', () => {
    const w = ownerAnswerRerouteWake({ archivedChatId: 'lane-1', archivedTitle: 'Spark lane', questionId: 'oq_1', content: 'Q: "go?"\nA: "yes"', tier: 'project' });
    expect(w).toMatch(/^\[Owner inbox — RE-ROUTED to the project supervisor: the asking lane "Spark lane" \(lane-1\) is ARCHIVED\]/);
    expect(w).toContain('for question oq_1');
    expect(w).toContain('no retry was armed onto it');
    expect(w.endsWith('--- original wake for lane lane-1 ---\nQ: "go?"\nA: "yes"')).toBe(true);
    expect(ownerAnswerRerouteWake({ archivedChatId: 'lane-1', content: 'x', tier: 'fleet' })).toContain('RE-ROUTED to the Fleet Supervisor: the asking lane (lane-1)');
  });

  it('the orphaned-todos wake lists each todo once (capped at 12 + a remainder line)', () => {
    const todos = Array.from({ length: 14 }, (_, i) => ({ id: `todo-${String(i).padStart(4, '0')}-xxxx`, title: `Task ${i}`, status: 'pending' }));
    const w = orphanedTodosWake({ chatId: 'lane-1', chatTitle: 'Lane', todos });
    expect(w).toMatch(/^\[todo_wake — lane ARCHIVED, its todos are now UNASSIGNED\] Lane "Lane" \(lane-1\)/);
    expect(w).toContain('unassigned its 14 live todos');
    expect(w).toContain('- "Task 0" (todo-000, pending)');
    expect(w).toContain('- …and 2 more');
    expect(w).not.toContain('Task 13');
  });

  it('the progress note stays short and names the lane', () => {
    const n = archivedLaneProgressNote('abcdef1234567890');
    expect(n).toBe('lane archived (abcdef12) — unassigned; re-dispatch to a live lane');
    expect(n.length).toBeLessThanOrEqual(200);
  });

  it('the composed note KEEPS the lane\'s last note after the marker (review: overwriting it lost where the work stood)', () => {
    const marker = archivedLaneProgressNote('lane-1');
    expect(composeArchivedLaneProgressNote('lane-1', null)).toBe(marker);
    expect(composeArchivedLaneProgressNote('lane-1', '   ')).toBe(marker);
    expect(composeArchivedLaneProgressNote('lane-1', 'branch x at 70%, probe wired')).toBe(`${marker} | prev: branch x at 70%, probe wired`);
  });

  it('a HOLD-led note stays FIRST so the digest\'s "held per note" gate still reads it; the marker rides the tail', () => {
    const marker = archivedLaneProgressNote('lane-1');
    const hold = 'HOLD — waiting on owner key; branch x at 70%';
    const n = composeArchivedLaneProgressNote('lane-1', hold);
    expect(n).toBe(`${hold} | ${marker}`);
    expect(ARCHIVED_LANE_HOLD_LEAD_RE.test(n)).toBe(true);
    expect(ARCHIVED_LANE_HOLD_LEAD_RE.test(composeArchivedLaneProgressNote('lane-1', 'on hold until the owner answers'))).toBe(true);
    // A mid-sentence HOLD is not a hold (the digest regex anchors on the lead).
    expect(composeArchivedLaneProgressNote('lane-1', 'STATUS at_risk … HOLD (Δ+2.70)')).toBe(`${marker} | prev: STATUS at_risk … HOLD (Δ+2.70)`);
  });

  it('a re-archive never nests markers (either form is stripped from the previous note)', () => {
    const marker = archivedLaneProgressNote('lane-2');
    const once = composeArchivedLaneProgressNote('lane-1', 'probe wired');
    expect(previousLaneNote(once)).toBe('probe wired');
    expect(composeArchivedLaneProgressNote('lane-2', once)).toBe(`${marker} | prev: probe wired`);
    const holdOnce = composeArchivedLaneProgressNote('lane-1', 'HOLD — key');
    expect(previousLaneNote(holdOnce)).toBe('HOLD — key');
    expect(composeArchivedLaneProgressNote('lane-2', holdOnce)).toBe(`HOLD — key | ${marker}`);
    expect(previousLaneNote(archivedLaneProgressNote('lane-1'))).toBe('');
    expect(previousLaneNote(undefined)).toBe('');
  });

  it('the composed note never exceeds the storage cap and the marker always survives the clip', () => {
    const marker = archivedLaneProgressNote('lane-1');
    const long = 'x'.repeat(5000);
    const plain = composeArchivedLaneProgressNote('lane-1', long, 200);
    expect(Array.from(plain).length).toBe(200);
    expect(plain.startsWith(marker)).toBe(true);
    const held = composeArchivedLaneProgressNote('lane-1', `HOLD ${long}`, 200);
    expect(Array.from(held).length).toBeLessThanOrEqual(200);
    expect(held.endsWith(marker)).toBe(true);
    expect(held.startsWith('HOLD')).toBe(true);
    expect(composeArchivedLaneProgressNote('lane-1', `HOLD ${long}`, 10)).toBe(marker.slice(0, 10));
    expect(Array.from(composeArchivedLaneProgressNote('lane-1', long)).length).toBe(2000);
  });

  it('the orphaned-todos wake carries each todo\'s last note (clipped) so the supervisor sees where it stood', () => {
    const w = orphanedTodosWake({
      chatId: 'lane-1',
      todos: [
        { id: 't1-xxxxxxxx', title: 'Wire the probe', status: 'in_progress', prevNote: 'HOLD — waiting on owner key' },
        { id: 't2-xxxxxxxx', title: 'Bank it', status: 'pending', prevNote: null },
        { id: 't3-xxxxxxxx', title: 'Long', status: 'pending', prevNote: 'y'.repeat(300) },
      ],
    });
    expect(w).toContain('- "Wire the probe" (t1-xxxxx, in_progress) — last note: "HOLD — waiting on owner key"');
    expect(w).toContain('- "Bank it" (t2-xxxxx, pending)\n');
    expect(w).toContain(`last note: "${'y'.repeat(100)}…"`);
  });

  it('the re-route wake names a LINKED lane (forChatId) as linked, an asker as asking', () => {
    expect(ownerAnswerRerouteWake({ archivedChatId: 'lane-1', content: 'x', tier: 'project', laneRole: 'linked' }))
      .toMatch(/^\[Owner inbox — RE-ROUTED to the project supervisor: the linked lane \(lane-1\) is ARCHIVED\]/);
    expect(ownerAnswerRerouteWake({ archivedChatId: 'lane-1', content: 'x', tier: 'project', laneRole: 'asking' }))
      .toContain('the asking lane (lane-1)');
  });

  it('the actor tool-result note lists the inherited todos and never asks to wake the archived lane', () => {
    expect(actorInheritedTodosNote('lane-1', [])).toBe('');
    const n = actorInheritedTodosNote('lane-1', [{ id: 't1-xxxxxxxx', title: 'Wire the probe', status: 'blocked' }]);
    expect(n).toContain('Its 1 live todo was UNASSIGNED');
    expect(n).toContain('no separate wake was sent');
    expect(n).toContain('"Wire the probe" (t1-xxxxx, blocked)');
    expect(n).toContain('never wake lane lane-1');
    const many = actorInheritedTodosNote('lane-1', Array.from({ length: 14 }, (_, i) => ({ id: `t${i}-xxxxxxxx`, title: `T${i}`, status: 'pending' })));
    expect(many).toContain('Its 14 live todos were UNASSIGNED');
    expect(many).toContain('…and 2 more');
  });
});

describe('readArchivedTarget / isArchivedScheduleTarget / resolveLaneSupervisor', () => {
  it('reads with ONE findFirst and classifies both archive shapes; a missing chat or an error is null (fail-open)', async () => {
    chatTable({
      a: { id: 'a', userId: 'u1', projectId: 'p1', title: 'A', archivedAt: new Date(), codingState: null },
      b: { id: 'b', userId: 'u1', projectId: null, title: 'B', archivedAt: null, codingState: { status: 'archived' } },
      c: { id: 'c', userId: 'u1', projectId: null, title: 'C', archivedAt: null, codingState: { status: 'ready' } },
    });
    expect(await readArchivedTarget('a')).toEqual({ archived: true, userId: 'u1', projectId: 'p1', title: 'A' });
    expect((await readArchivedTarget('b'))?.archived).toBe(true);
    expect((await readArchivedTarget('c'))?.archived).toBe(false);
    expect(await readArchivedTarget('gone')).toBeNull();
    expect(await isArchivedScheduleTarget('a')).toBe(true);
    expect(await isArchivedScheduleTarget('c')).toBe(false);
    mockChatFindFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await isArchivedScheduleTarget('a')).toBe(false);
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    expect(await isArchivedScheduleTarget('a')).toBe(false); // the switch never even reads
  });

  it('prefers the project supervisor (supervision ON, not archived), else the Fleet Supervisor; never the excluded chat', async () => {
    chatTable({}, { ps: { p1: 'ps-1' }, fs: 'fs-1' });
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p1' })).toEqual({ id: 'ps-1', tier: 'project' });
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p2' })).toEqual({ id: 'fs-1', tier: 'fleet' });
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: null })).toEqual({ id: 'fs-1', tier: 'fleet' });
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p2', excludeChatId: 'fs-1' })).toBeNull();
    const psWhere = mockChatFindFirst.mock.calls.map((c) => c[0].where).find((w: any) => w.isProjectSupervisor);
    expect(psWhere).toMatchObject({ userId: 'u1', projectId: 'p1', isProjectSupervisor: true, archivedAt: null, project: { projectSupervisorEnabled: true } });
    mockChatFindFirst.mockRejectedValue(new Error('db down'));
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p1' })).toBeNull();
  });

  it('AUTOMATIC callers never fall back to the Fleet Supervisor for a project opted out of supervision (supervised:false); its own PS still inherits; an unreadable flag fails open', async () => {
    chatTable({}, { ps: { p1: 'ps-1' }, fs: 'fs-1' });
    mockProjectFindFirst.mockResolvedValue({ supervised: false });
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p2', automatic: true })).toBeNull();
    expect(mockProjectFindFirst).toHaveBeenCalledWith({ where: { id: 'p2' }, select: { supervised: true } });
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p1', automatic: true })).toEqual({ id: 'ps-1', tier: 'project' });
    // An owner ANSWER (not automatic) is a user action — never filtered.
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p2' })).toEqual({ id: 'fs-1', tier: 'fleet' });
    // Ungrouped lanes are always supervised.
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: null, automatic: true })).toEqual({ id: 'fs-1', tier: 'fleet' });
    mockProjectFindFirst.mockRejectedValue(new Error('db down'));
    expect(await resolveLaneSupervisor({ userId: 'u1', projectId: 'p2', automatic: true })).toEqual({ id: 'fs-1', tier: 'fleet' });
  });
});

describe('unassignTodosForArchivedLane (e)', () => {
  const todos = [
    { id: 't1', title: 'Wire the probe', status: 'in_progress', projectId: 'p1' },
    { id: 't2', title: 'Bank the result', status: 'blocked', projectId: 'p1' },
  ];

  it('unassigns the lane\'s LIVE todos (conditional on still being assigned) and sends ONE todo_wake to the project supervisor', async () => {
    chatTable({ 'lane-1': { id: 'lane-1', title: 'Spark lane' } }, { ps: { p1: 'ps-1' }, fs: 'fs-1' });
    mockTodoFindMany.mockResolvedValue(todos);
    mockTodoUpdateMany.mockResolvedValue({ count: 2 });
    const out = await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' });
    expect(out).toEqual({ unassigned: 2, wokeChatIds: ['ps-1'] });
    expect(mockTodoFindMany.mock.calls[0][0].where).toEqual({ userId: 'u1', assigneeChatId: 'lane-1', status: { in: ['pending', 'in_progress', 'blocked'] } });
    expect(mockTodoUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['t1', 't2'] }, assigneeChatId: 'lane-1' },
      data: { assigneeChatId: null, progressNote: 'lane archived (lane-1) — unassigned; re-dispatch to a live lane' },
    });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0] as any;
    expect(wake.targetChatId).toBe('ps-1');
    expect(wake.prompt).toContain('"Wire the probe" (t1, in_progress)');
    expect(wake.prompt).toContain('"Bank the result" (t2, blocked)');
    expect(wake.meta).toEqual({ reason: 'archived_lane_todos', archivedChatId: 'lane-1', todoIds: ['t1', 't2'] });
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'archived_target_retire', sessionId: 'lane-1', value: 2,
      meta: expect.objectContaining({ surface: 'todo', action: 'unassigned', source: 'archive_chat', wokeChatIds: ['ps-1'] }),
    }));
  });

  it('no project supervisor → the Fleet Supervisor inherits; no supervisor at all → unassigned, nobody woken', async () => {
    chatTable({}, { fs: 'fs-1' });
    mockTodoFindMany.mockResolvedValue(todos);
    mockTodoUpdateMany.mockResolvedValue({ count: 2 });
    expect(await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'session_archive' })).toEqual({ unassigned: 2, wokeChatIds: ['fs-1'] });
    chatTable({}, {});
    mockEnqueueDirectWake.mockClear();
    expect(await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'session_archive' })).toEqual({ unassigned: 2, wokeChatIds: [] });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('writes the composed note per distinct previous note (keeping where each todo stood), resolves the supervisor ONCE per project, and leaves a lost-race group out of the wake', async () => {
    chatTable({ 'lane-1': { id: 'lane-1', title: 'Spark lane' } }, { ps: { p1: 'ps-1' }, fs: 'fs-1' });
    mockTodoFindMany.mockResolvedValue([
      { id: 't1', title: 'Wire the probe', status: 'in_progress', projectId: 'p1', progressNote: 'HOLD — waiting on owner key' },
      { id: 't2', title: 'Bank the result', status: 'pending', projectId: 'p1', progressNote: 'probe at 70%' },
      { id: 't3', title: 'Raced', status: 'pending', projectId: 'p1', progressNote: 'other lane took it' },
    ]);
    mockTodoUpdateMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.includes('t3') ? 0 : where.id.in.length }));
    const out = await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' });
    expect(out).toEqual({ unassigned: 2, wokeChatIds: ['ps-1'] });
    const marker = archivedLaneProgressNote('lane-1');
    expect(mockTodoUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: { in: ['t1'] }, assigneeChatId: 'lane-1' }, data: { assigneeChatId: null, progressNote: `HOLD — waiting on owner key | ${marker}` } },
      { where: { id: { in: ['t2'] }, assigneeChatId: 'lane-1' }, data: { assigneeChatId: null, progressNote: `${marker} | prev: probe at 70%` } },
      { where: { id: { in: ['t3'] }, assigneeChatId: 'lane-1' }, data: { assigneeChatId: null, progressNote: `${marker} | prev: other lane took it` } },
    ]);
    expect(mockTodoFindMany.mock.calls[0][0].select).toMatchObject({ progressNote: true });
    // ONE project-supervisor lookup for the three same-project todos.
    expect(mockChatFindFirst.mock.calls.filter((c) => c[0].where?.isProjectSupervisor)).toHaveLength(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0] as any;
    expect(wake.meta.todoIds).toEqual(['t1', 't2']);
    expect(wake.prompt).toContain('last note: "HOLD — waiting on owner key"');
    expect(wake.prompt).not.toContain('Raced');
  });

  it('the archiving ACTOR that inherits the todos gets them back (actorInherited) instead of a todo_wake about its own action', async () => {
    chatTable({ 'lane-1': { id: 'lane-1', title: 'Spark lane' } }, { ps: { p1: 'ps-1' }, fs: 'fs-1' });
    mockTodoFindMany.mockResolvedValue([...todos, { id: 't9', title: 'Other board', status: 'pending', projectId: 'p9' }]);
    mockTodoUpdateMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
    const out = await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat', actorChatId: 'ps-1' });
    expect(out.unassigned).toBe(3);
    expect(out.actorInherited?.map((t) => t.id)).toEqual(['t1', 't2']);
    // The other board's inheritor (the Fleet Supervisor) is still woken.
    expect(out.wokeChatIds).toEqual(['fs-1']);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect((mockEnqueueDirectWake.mock.calls[0][0] as any).targetChatId).toBe('fs-1');
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ actorChatId: 'ps-1', actorInherited: 2, wokeChatIds: ['fs-1'] }),
    }));
  });

  it('a lane in a project OPTED OUT of supervision (no PS) is still unassigned, but no Fleet Supervisor is woken', async () => {
    chatTable({ 'lane-1': { id: 'lane-1', title: 'Spark lane' } }, { fs: 'fs-1' });
    mockProjectFindFirst.mockResolvedValue({ supervised: false });
    mockTodoFindMany.mockResolvedValue(todos);
    mockTodoUpdateMany.mockResolvedValue({ count: 2 });
    expect(await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' })).toEqual({ unassigned: 2, wokeChatIds: [] });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ noSupervisor: 2 }) }));
  });

  it('nothing assigned, a lost race (0 written), the kill switch or a DB error → no wake, never throws', async () => {
    expect(await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' })).toEqual({ unassigned: 0, wokeChatIds: [] });
    mockTodoFindMany.mockResolvedValue(todos);
    mockTodoUpdateMany.mockResolvedValue({ count: 0 });
    expect(await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' })).toEqual({ unassigned: 0, wokeChatIds: [] });
    mockTodoUpdateMany.mockRejectedValue(new Error('db down'));
    await expect(unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' })).resolves.toEqual({ unassigned: 0, wokeChatIds: [] });
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockTodoFindMany.mockClear();
    expect(await unassignTodosForArchivedLane({ userId: 'u1', chatId: 'lane-1', source: 'archive_chat' })).toEqual({ unassigned: 0, wokeChatIds: [] });
    expect(mockTodoFindMany).not.toHaveBeenCalled();
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });
});
