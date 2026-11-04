/**
 * build 2026-10-11 DL-1 — the delegation ledger's model-facing reads (task_get /
 * task_list): stage 2 of architecture.md item B. Pins the STRICT scoping (the
 * caller's own delegations; a project supervisor + its project; the Fleet
 * Supervisor + its account; never another account — the seat is read from the
 * caller's chat row, `scope` only narrows), the get-by-child-chat path, the
 * no-existence-leak miss, machine-read redaction, the switch, and the doctrine
 * rows that make the ledger the status source.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// ── an in-memory Prisma double that evaluates the `where` shapes the executor builds ──
type Row = Record<string, any>;
function matches(row: Row, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'AND') { if (!(cond as any[]).every((w) => matches(row, w))) return false; continue; }
    if (k === 'OR') { if (!(cond as any[]).some((w) => matches(row, w))) return false; continue; }
    const v = row[k];
    if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
    if (cond instanceof Date || typeof cond !== 'object') { if (v !== cond) return false; continue; }
    const c = cond as Record<string, any>;
    if ('in' in c && !c.in.includes(v)) return false;
    if ('startsWith' in c && !(typeof v === 'string' && v.startsWith(c.startsWith))) return false;
    if ('gte' in c && !(v instanceof Date && v.getTime() >= c.gte.getTime())) return false;
    if ('not' in c && v === c.not) return false;
  }
  return true;
}
const mockTasks: Row[] = [];
const mockChats: Row[] = [];
const mockMetrics: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: {
      findUnique: async ({ where }: any) => mockChats.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where, take }: any) => mockChats.filter((c) => matches(c, where)).slice(0, take ?? 1e9).map((c) => ({ id: c.id })),
    },
    delegationTask: {
      findFirst: async ({ where }: any) => mockTasks.find((t) => matches(t, where)) ?? null,
      findMany: async ({ where, take, orderBy }: any) => {
        const rows = mockTasks.filter((t) => matches(t, where));
        if (orderBy?.createdAt === 'desc') rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(0, take ?? 1e9);
      },
      groupBy: async ({ where }: any) => {
        const by = new Map<string, number>();
        for (const t of mockTasks.filter((r) => matches(r, where))) by.set(t.state, (by.get(t.state) ?? 0) + 1);
        return [...by].map(([state, n]) => ({ state, _count: { _all: n } }));
      },
    },
  },
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (m: any) => { mockMetrics.push(m); },
  LOOP_METRIC_KINDS: { DELEGATION_TASK: 'delegation_task' },
}));

import {
  callerSeatFrom, delegationScopeWhere, executeDelegationTaskTool, isDelegationTaskTool, resolveDelegationScope,
  DELEGATION_TASK_TOOL_NAMES, DELEGATION_TASK_TOOL_SCHEMA,
} from './delegation-task-tools';
import { PLATFORM_READ_TOOLS } from './platform-tool-names';
import { groupForTool } from '../coding/tool-groups';
import { platformPlaybookBlock } from '../chat-agent/capability-doctrine';
import { fleetSupervisorRoleProfile, projectSupervisorRoleProfile } from './role-profiles';

const U = 'user-owner-1';
const OTHER = 'user-other-2';
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000);
const T = (id: string, over: Row): Row => ({
  id, kind: 'session', source: 'start_coding_session', state: 'working', userId: U, parentChatId: null, parentRunId: null,
  childChatId: null, childRef: null, projectId: null, brief: `brief ${id}`, origin: 'machine', idempotencyKey: null, duplicateOfId: null,
  artifacts: [], events: [{ at: ago(30).toISOString(), from: null, to: 'submitted', seam: 'start_coding_session' }], resultRef: null, reason: null,
  staleAfter: new Date(NOW + 3_600_000), lastEventAt: ago(5), completedAt: null, createdAt: ago(30), ...over,
});

function seed() {
  mockTasks.length = 0; mockChats.length = 0; mockMetrics.length = 0;
  mockChats.push(
    { id: 'lane-a-0000-0000', userId: U, isSupervisor: false, isProjectSupervisor: false, projectId: 'proj-1' },
    { id: 'lane-b-0000-0000', userId: U, isSupervisor: false, isProjectSupervisor: false, projectId: 'proj-1' },
    { id: 'lane-c-0000-0000', userId: U, isSupervisor: false, isProjectSupervisor: false, projectId: 'proj-2' },
    { id: 'ps-1-000-0000-00', userId: U, isSupervisor: false, isProjectSupervisor: true, projectId: 'proj-1' },
    { id: 'fleet-00-0000-00', userId: U, isSupervisor: true, isProjectSupervisor: false, projectId: null },
    { id: 'shared-0-0000-00', userId: OTHER, isSupervisor: false, isProjectSupervisor: true, projectId: 'proj-1' },
    { id: 'other-00-0000-00', userId: OTHER, isSupervisor: true, isProjectSupervisor: false, projectId: null },
  );
  mockTasks.push(
    // lane-a's own delegations
    T('t-a-session-1111', { parentChatId: 'lane-a-0000-0000', childChatId: 'child-1-0000-0000', state: 'completed', completedAt: ago(10), resultRef: 'run-1', artifacts: [{ kind: 'pr', ref: 'https://github.com/o/r/pull/7' }] }),
    T('t-a-ask-22222222', { kind: 'message_ask', source: 'send_chat_message', parentChatId: 'lane-a-0000-0000', childChatId: 'lane-b-0000-0000', state: 'working' }),
    T('t-a-old-33333333', { parentChatId: 'lane-a-0000-0000', childChatId: 'child-3-0000-0000', createdAt: new Date(NOW - 200 * 3_600_000) }),
    // a continuation task (null userId) on lane-a's own chat
    T('t-a-cont-4444444', { kind: 'continuation', userId: null, parentChatId: 'lane-a-0000-0000', childChatId: 'lane-a-0000-0000', state: 'input_required' }),
    // lane-b asked lane-a for work (lane-a is the CHILD)
    T('t-b-ask-55555555', { kind: 'message_ask', parentChatId: 'lane-b-0000-0000', childChatId: 'lane-a-0000-0000', state: 'submitted' }),
    // the project supervisor's spawn in proj-1 and a ticket lane in proj-1 from no chat
    T('t-ps-spawn-66666', { parentChatId: 'ps-1-000-0000-00', childChatId: 'lane-b-0000-0000', projectId: 'proj-1', state: 'working', staleAfter: ago(1) }),
    T('t-ticket-7777777', { kind: 'ticket', parentChatId: null, childChatId: 'lane-b-0000-0000', childRef: 'ticket-1', projectId: 'proj-1', state: 'working' }),
    // proj-2 work (same account)
    T('t-c-spawn-888888', { parentChatId: 'lane-c-0000-0000', childChatId: 'child-8-0000-0000', projectId: 'proj-2' }),
    // ANOTHER ACCOUNT: same project id string, a parent chat id that collides with nothing of ours, and a child of lane-a's id shape
    T('t-other-9999999', { userId: OTHER, parentChatId: 'other-00-0000-00', childChatId: 'lane-a-0000-0000', projectId: 'proj-1', brief: 'NOT YOURS' }),
    T('t-other-shared-a', { userId: OTHER, parentChatId: 'lane-a-0000-0000', projectId: 'proj-1', brief: 'NOT YOURS EITHER' }),
  );
}

const ctx = (sessionId: string, over: Row = {}) => ({ sessionId, userId: U, userTurnAt: new Date(), ...over });
const run = async (c: any, name: string, args: any = {}) => JSON.parse(await executeDelegationTaskTool(c, name, args));
const ids = (r: any) => (r.tasks as any[]).map((t) => t.id).sort();

beforeEach(() => { seed(); delete process.env.DELEGATION_TASK_TOOLS_DISABLED; });

describe('registration', () => {
  it('two read tools in the platform READ registry, grouped under platform_reads, schemas declared', () => {
    expect(DELEGATION_TASK_TOOL_NAMES).toEqual(['task_get', 'task_list']);
    for (const n of DELEGATION_TASK_TOOL_NAMES) {
      expect(isDelegationTaskTool(n)).toBe(true);
      expect(PLATFORM_READ_TOOLS as readonly string[]).toContain(n);
      expect(groupForTool(n)).toBe('platform_reads');
      expect(DELEGATION_TASK_TOOL_SCHEMA.some((s) => s.function.name === n)).toBe(true);
    }
  });
});

describe('scope — pure', () => {
  it('the seat comes from the caller chat row; a shared-project member gets the plain chat seat', () => {
    expect(callerSeatFrom({ sessionId: 'x', userId: U }, { userId: U, isSupervisor: true }).seat).toBe('fleet_supervisor');
    expect(callerSeatFrom({ sessionId: 'x', userId: U }, { userId: U, isProjectSupervisor: true, projectId: 'p' })).toMatchObject({ seat: 'project_supervisor', projectId: 'p', owner: true });
    expect(callerSeatFrom({ sessionId: 'x', userId: U }, { userId: OTHER, isProjectSupervisor: true, projectId: 'p' })).toMatchObject({ seat: 'chat', projectId: null, owner: false });
    expect(callerSeatFrom({ sessionId: 'x', userId: U }, null).seat).toBe('chat');
  });

  it('scope only narrows: a lane asking for the account is refused; a supervisor may narrow to its own', () => {
    expect(resolveDelegationScope('chat', undefined)).toBe('mine');
    expect(resolveDelegationScope('chat', 'account')).toBeNull();
    expect(resolveDelegationScope('chat', 'project')).toBeNull();
    expect(resolveDelegationScope('project_supervisor', undefined)).toBe('project');
    expect(resolveDelegationScope('project_supervisor', 'mine')).toBe('mine');
    expect(resolveDelegationScope('project_supervisor', 'account')).toBeNull();
    expect(resolveDelegationScope('fleet_supervisor', undefined)).toBe('account');
    expect(resolveDelegationScope('fleet_supervisor', 'bogus')).toBeNull();
  });

  it('every branch of the fence names the caller (a null-userId row only on the caller\'s OWN chat)', () => {
    const c = callerSeatFrom({ sessionId: 'ps', userId: U }, { userId: U, isProjectSupervisor: true, projectId: 'p' });
    for (const scope of ['mine', 'project', 'account'] as const) {
      const w = delegationScopeWhere(c, scope, ['x', 'y'], { includeChild: true }) as any;
      for (const b of w.OR) {
        if (b.userId === null) expect(b.parentChatId).toBe('ps');
        else expect(b.userId).toBe(U);
      }
    }
    const member = callerSeatFrom({ sessionId: 'sh', userId: U }, { userId: OTHER });
    expect((delegationScopeWhere(member, 'mine') as any).OR.some((b: any) => b.userId === null)).toBe(false);
  });
});

describe('task_list — the caller\'s delegations only', () => {
  it('a lane sees what IT delegated (its continuation too) — never another chat\'s or another account\'s', async () => {
    const r = await run(ctx('lane-a-0000-0000'), 'task_list');
    expect(r).toMatchObject({ ok: true, tool: 'task_list', scope: 'mine', seat: 'chat' });
    expect(ids(r)).toEqual(['t-a-ask-22222222', 't-a-cont-4444444', 't-a-session-1111']); // the 200-h-old one is outside 72 h
    expect(r.byState).toEqual({ completed: 1, working: 1, input_required: 1 });
    expect(JSON.stringify(r)).not.toContain('NOT YOURS');
    expect(r.tasks.find((t: any) => t.id === 't-a-session-1111')).toMatchObject({ state: 'completed', resultRef: 'run-1', artifacts: 1, childChatId: 'child-1-0000-0000' });
  });

  it('filters: state open, kind, sinceHours, chatId', async () => {
    expect(ids(await run(ctx('lane-a-0000-0000'), 'task_list', { state: 'open' }))).toEqual(['t-a-ask-22222222', 't-a-cont-4444444']);
    expect(ids(await run(ctx('lane-a-0000-0000'), 'task_list', { kind: 'message_ask' }))).toEqual(['t-a-ask-22222222']);
    expect(ids(await run(ctx('lane-a-0000-0000'), 'task_list', { sinceHours: 720 }))).toContain('t-a-old-33333333');
    expect(ids(await run(ctx('lane-a-0000-0000'), 'task_list', { chatId: 'lane-b-0000-0000' }))).toEqual(['t-a-ask-22222222']);
    expect(await run(ctx('lane-a-0000-0000'), 'task_list', { kind: 'nope' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run(ctx('lane-a-0000-0000'), 'task_list', { state: 'done' })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('a lane cannot widen its scope', async () => {
    expect(await run(ctx('lane-a-0000-0000'), 'task_list', { scope: 'account' })).toMatchObject({ ok: false, reason: 'scope' });
  });

  it('a project supervisor sees its project (by project id and by its chats) — not another project, not another account', async () => {
    const r = await run(ctx('ps-1-000-0000-00'), 'task_list');
    expect(r.scope).toBe('project');
    // lane-a's continuation (null userId) belongs to lane-a's own view only
    expect(ids(r)).toEqual(['t-a-ask-22222222', 't-a-session-1111', 't-b-ask-55555555', 't-ps-spawn-66666', 't-ticket-7777777']);
    expect(JSON.stringify(r)).not.toContain('NOT YOURS');
    expect(ids(r)).not.toContain('t-c-spawn-888888');
    expect(r.tasks.find((t: any) => t.id === 't-ps-spawn-66666').stale).toBe(true);
    // narrowed to its own delegations
    expect(ids(await run(ctx('ps-1-000-0000-00'), 'task_list', { scope: 'mine' }))).toEqual(['t-ps-spawn-66666']);
  });

  it('the Fleet Supervisor sees the whole account — never another account', async () => {
    const r = await run(ctx('fleet-00-0000-00'), 'task_list');
    expect(r.scope).toBe('account');
    expect(ids(r)).toContain('t-c-spawn-888888');
    expect(ids(r)).toContain('t-ticket-7777777');
    expect(JSON.stringify(r)).not.toContain('NOT YOURS');
    // the OTHER account's Fleet Supervisor sees only its own rows
    const o = await run({ sessionId: 'other-00-0000-00', userId: OTHER, userTurnAt: new Date() }, 'task_list');
    expect(ids(o)).toEqual(['t-other-9999999', 't-other-shared-a']);
  });

  it('a shared-project member running in someone else\'s supervisor chat gets no supervisor reach', async () => {
    const r = await run(ctx('shared-0-0000-00'), 'task_list');
    expect(r).toMatchObject({ ok: true, scope: 'mine', seat: 'chat', total: 0 });
  });

  it('records one tool_read metric per call', async () => {
    await run(ctx('lane-a-0000-0000'), 'task_list');
    expect(mockMetrics).toEqual([expect.objectContaining({ kind: 'delegation_task', sessionId: 'lane-a-0000-0000', meta: expect.objectContaining({ phase: 'tool_read', tool: 'task_list', seat: 'chat', scope: 'mine', returned: 3, open: 2 }) })]);
  });
});

describe('task_get — one task, in full', () => {
  it('by id and by a unique prefix: events, artifacts, result ref', async () => {
    const r = await run(ctx('lane-a-0000-0000'), 'task_get', { id: 't-a-session-1111' });
    expect(r).toMatchObject({ ok: true, via: 'task', task: { id: 't-a-session-1111', state: 'completed', resultRef: 'run-1', source: 'start_coding_session' } });
    expect(r.task.events[0]).toMatchObject({ to: 'submitted', seam: 'start_coding_session' });
    expect(r.task.artifacts).toEqual([{ kind: 'pr', ref: 'https://github.com/o/r/pull/7' }]);
    expect((await run(ctx('lane-a-0000-0000'), 'task_get', { id: 't-a-sess' })).task.id).toBe('t-a-session-1111');
  });

  it('by the CHILD chat id (newest first, the rest listed); a lane can read the task handed TO it', async () => {
    const r = await run(ctx('ps-1-000-0000-00'), 'task_get', { id: 'lane-b-0000-0000' });
    expect(r.via).toBe('child_chat');
    expect(r.task.childChatId).toBe('lane-b-0000-0000');
    expect(r.otherTasksForChat.length).toBeGreaterThan(0);
    const mine = await run(ctx('lane-a-0000-0000'), 'task_get', { id: 't-b-ask-55555555' });
    expect(mine).toMatchObject({ ok: true, task: { id: 't-b-ask-55555555', childChatId: 'lane-a-0000-0000' } });
  });

  it('never another account\'s task — and the miss does not say whether it exists', async () => {
    for (const id of ['t-other-9999999', 't-other-shared-a', 't-other-s']) {
      const r = await run(ctx('fleet-00-0000-00'), 'task_get', { id });
      expect(r).toMatchObject({ ok: false, reason: 'not_found' });
      expect(JSON.stringify(r)).not.toContain('NOT YOURS');
    }
    // lane-a is the CHILD of the other account's task: still invisible
    const r = await run(ctx('lane-a-0000-0000'), 'task_get', { id: 'lane-a-0000-0000' });
    expect(JSON.stringify(r)).not.toContain('t-other-9999999');
    // a lane cannot read a sibling project's delegation
    expect(await run(ctx('lane-a-0000-0000'), 'task_get', { id: 't-c-spawn-888888' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run(ctx('lane-a-0000-0000'), 'task_get', { id: 'short' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('guards + redaction + switch', () => {
  it('a guest / chatless run is refused', async () => {
    expect(await run({ sessionId: 'anon-1', userId: 'anonymous' }, 'task_list')).toMatchObject({ ok: false, reason: 'anonymous' });
    expect(await run({ sessionId: 'chatless-u1', userId: U }, 'task_get', { id: 't-a-session-1111' })).toMatchObject({ ok: false, reason: 'anonymous' });
  });

  it('a machine read redacts a credential-shaped brief; a human turn sees it unchanged', async () => {
    const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    mockTasks.push(T('t-a-secret-aaaaa', { parentChatId: 'lane-a-0000-0000', brief: `use token ${key} for the push` }));
    const machine = await executeDelegationTaskTool({ sessionId: 'lane-a-0000-0000', userId: U, machineTriggered: true } as any, 'task_get', { id: 't-a-secret-aaaaa' });
    expect(machine).not.toContain(key);
    expect(machine).toContain('CREDENTIALS REDACTED');
    const human = await executeDelegationTaskTool(ctx('lane-a-0000-0000') as any, 'task_get', { id: 't-a-secret-aaaaa' });
    expect(human).toContain(key);
  });

  it('DELEGATION_TASK_TOOLS_DISABLED=1: both tools refuse (naming the polling reads) and every doctrine row drops out', async () => {
    const on = platformPlaybookBlock({ chatId: 'c1', projectId: null, isSupervisor: false, hasUser: true });
    expect(on).toContain('task_list (every task this chat handed off, one call');
    expect(fleetSupervisorRoleProfile()).toContain("task_list (every delegation's state in one call");
    const ps = (s?: string) => projectSupervisorRoleProfile({ projectName: 'Apollo', projectId: 'p-apollo', fleetSupervisorChatId: s ?? 'fleet1', hookEventTypes: ['run_completed'] } as any);
    expect(ps()).toContain('Survey with task_list');
    expect(ps()).toContain('task_get (state, artifacts, result)');

    process.env.DELEGATION_TASK_TOOLS_DISABLED = '1';
    for (const n of DELEGATION_TASK_TOOL_NAMES) {
      expect(await run(ctx('lane-a-0000-0000'), n, { id: 't-a-session-1111' })).toMatchObject({ ok: false, reason: 'disabled' });
    }
    const off = platformPlaybookBlock({ chatId: 'c1', projectId: null, isSupervisor: false, hasUser: true });
    expect(off).not.toContain('task_list');
    expect(fleetSupervisorRoleProfile()).not.toContain('task_list');
    expect(ps()).not.toMatch(/task_list|task_get/);
    expect(off.length).toBeLessThan(on.length);
  });
});
