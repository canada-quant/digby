/**
 * audit 2026-10-06 T5 — fleet-ops tools:
 *   T5-4 resolve_id sees supervisor-state ids (live + archived directives, the
 *        dispatch ledger) and flags an id that lives only in supervisor notes
 *        as UNVERIFIED (spark F8);
 *   T5-6 get_session_diff never renders a failed git read as "Worktree clean",
 *        and names HEAD + unpushed commits (litellm F3).
 * Executed through executeFleetOpsTool at the module boundary.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const supRows: Array<{ chatId: string; state: any }> = [];
const mockSupFindMany: jest.Mock = jest.fn(async () => supRows);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    activity: { create: jest.fn(async () => ({})) },
    supervisorState: { findMany: (...a: any[]) => mockSupFindMany(...a) },
    crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    projectGoal: { findMany: jest.fn(async () => []) },
    projectTodo: { findMany: jest.fn(async () => []) },
    eventHook: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    userFeatureRequest: { findMany: jest.fn(async () => []) },
    ownerQuestion: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    connectedInstance: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  },
}));
jest.mock('./platform.service', () => ({ __esModule: true, getProjectAccess: jest.fn(async () => null) }));
const mockColdAcross: jest.Mock = jest.fn(async () => []);
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  parseSupervisorStateDoc: (raw: any) => ({ directives: [], archived: [], dispatches: [], notes: '', ...(raw ?? {}) }),
  findColdArchivedDirectivesAcross: (...a: any[]) => mockColdAcross(...a),
}));
const mockSessionDiff: jest.Mock = jest.fn();
jest.mock('../coding/session-diff', () => ({ __esModule: true, sessionDiffForUser: (...a: any[]) => mockSessionDiff(...a) }));

import { executeFleetOpsTool, FLEET_OPS_TOOL_SCHEMA } from './fleet-ops-tools';

const deps = { platform: {}, isAdmin: jest.fn(async () => true) };
const ctx = { sessionId: 'sup-1', userId: 'u1' };
const run = async (name: any, args: any) => JSON.parse(await executeFleetOpsTool(ctx, name, args, deps));

const DIR = '2602af09-1111-4222-8333-444455556666';

beforeEach(() => {
  jest.clearAllMocks();
  supRows.length = 0;
  delete process.env.RESOLVE_ID_SUPERVISOR_STATE_DISABLED;
  supRows.push({
    chatId: 'cb2693e6-0000-4000-8000-000000000001',
    state: {
      directives: [{ id: 'aaaa1111-0000-4000-8000-000000000001', text: 'Keep the bench running', status: 'open', at: '2026-10-05T00:00:00Z' }],
      archived: [{ id: DIR, text: 'AGX reflash HOLD until the AGX lane verify chain is green', status: 'done', at: '2026-10-05T00:00:00Z', archivedAt: '2026-10-06T00:00:00Z' }],
      dispatches: [{ at: '2026-10-05T12:00:00Z', kind: 'start_coding_session', id: 'c90fed41-2222-4333-8444-555566667777', note: 'watchdog lane' }],
      notes: 'node-b slow-restore todo e83d5e45 open per my notes; hold 2602af09.',
    },
  });
});

describe('audit 2026-10-06 T5-4 — resolve_id sees supervisor-state ids', () => {
  it("an ARCHIVED directive's 8-char prefix resolves (the 'resolved to nothing' replay)", async () => {
    const r = await run('resolve_id', { id: '2602af09' });
    expect(r.resolved).toMatchObject({ family: 'directive', id: DIR });
    expect(r.resolved.label).toContain('done (archived) directive of supervisor chat cb2693e6');
    expect(mockSupFindMany).toHaveBeenCalledTimes(1); // one read shared by both families + the notes scan
    expect(mockSupFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
  });

  it('fs-durable-memory review (2026-10-22): a CLOSED directive in the COLD archive still resolves — looked up only when the doc says cold rows exist', async () => {
    const COLD = '7c7c7c7c-0000-4000-8000-000000000077';
    mockColdAcross.mockImplementation(async (chatIds: string[], prefix: string) => (COLD.startsWith(prefix) ? [{ chatId: chatIds[0], directive: { id: COLD, text: 'Owner asked: is the H100 box retired? Answered yes', status: 'answered', at: '2026-09-01T00:00:00Z' } }] : []));
    expect((await run('resolve_id', { id: '7c7c7c7c' })).resolved ?? null).toBeNull(); // no archivedColdCount → no cold read
    expect(mockColdAcross).not.toHaveBeenCalled();
    supRows[0].state.archivedColdCount = 3;
    const r = await run('resolve_id', { id: '7c7c7c7c' });
    expect(r.resolved).toMatchObject({ family: 'directive', id: COLD });
    expect(r.resolved.label).toContain('answered (archived) directive of supervisor chat cb2693e6');
    expect(mockColdAcross).toHaveBeenCalledWith(['cb2693e6-0000-4000-8000-000000000001'], '7c7c7c7c', 6);
  });

  it('a dispatch ledger id resolves with its kind', async () => {
    const r = await run('resolve_id', { id: 'c90fed41-2222-4333-8444-555566667777', family: 'dispatch' });
    expect(r.matches).toEqual([expect.objectContaining({ family: 'dispatch', id: 'c90fed41-2222-4333-8444-555566667777' })]);
    expect(r.matches[0].label).toContain('start_coding_session recorded by supervisor chat cb2693e6');
  });

  it('an id found in NO family but written in supervisor notes comes back as an UNVERIFIED mention', async () => {
    const r = await run('resolve_id', { id: 'e83d5e45' });
    expect(r.matches).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(r.mentions).toEqual([expect.objectContaining({ where: 'supervisor_notes', chatId: 'cb2693e6-0000-4000-8000-000000000001' })]);
    expect(r.mentions[0].excerpt).toContain('e83d5e45');
    expect(r.message).toContain('UNVERIFIED label, not a live id');
  });

  it('the schema enum carries the two new families', () => {
    const t = FLEET_OPS_TOOL_SCHEMA.find((x) => x.function.name === 'resolve_id')!;
    expect((t.function.parameters as any).properties.family.enum).toEqual(expect.arrayContaining(['directive', 'dispatch']));
  });

  it('kill switch RESOLVE_ID_SUPERVISOR_STATE_DISABLED=1: the eight families only, no mentions, no state read', async () => {
    process.env.RESOLVE_ID_SUPERVISOR_STATE_DISABLED = '1';
    const r = await run('resolve_id', { id: '2602af09' });
    expect(r.resolved).toBeNull();
    expect(r.mentions).toBeUndefined();
    expect(r.message).toContain('Nothing of yours matches 2602af09');
    expect(mockSupFindMany).not.toHaveBeenCalled();
    expect(await run('resolve_id', { id: '2602af09', family: 'directive' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('audit 2026-10-06 T5-6 — get_session_diff never renders a failed git read as clean', () => {
  it("source 'error' ⇒ ok:false git_error, the message says the state is UNKNOWN (never 'Worktree clean')", async () => {
    mockSessionDiff.mockResolvedValue({ branch: 'digby/session-c1d4abba', status: '', diffStat: '', source: 'error', error: 'git status: fatal: detected dubious ownership' });
    const r = await run('get_session_diff', { chatId: 'c1d4abba-0000-4000-8000-000000000001' });
    expect(r).toMatchObject({ ok: false, reason: 'git_error', source: 'error', changedFiles: null });
    expect(r.message).toContain('FAILED (git status: fatal: detected dubious ownership)');
    expect(r.message).toContain('UNKNOWN');
    expect(r.message).not.toContain('Worktree clean');
  });

  it('a clean tree with unpushed commits says so (HEAD + N commits NOT pushed)', async () => {
    mockSessionDiff.mockResolvedValue({ branch: 'digby/x', status: '', diffStat: '', source: 'disk', head: 'abcdef1234567890', upstream: 'origin/digby/x', ahead: 2, behind: 0 });
    const r = await run('get_session_diff', { chatId: 'c1' });
    expect(r).toMatchObject({ ok: true, changedFiles: 0, head: 'abcdef1234567890', ahead: 2, upstream: 'origin/digby/x' });
    expect(r.message).toContain('Worktree clean on digby/x (nothing uncommitted). HEAD abcdef12; 2 commit(s) NOT pushed to origin/digby/x.');
  });

  it('a branch with no upstream is named as never pushed', async () => {
    mockSessionDiff.mockResolvedValue({ branch: 'digby/y', status: ' M a.ts\n', diffStat: ' a.ts | 1 +', source: 'disk', head: '1234567890abcdef', upstream: null, ahead: null, behind: null });
    const r = await run('get_session_diff', { chatId: 'c2' });
    expect(r.message).toContain('1 changed path(s) on digby/y (uncommitted). HEAD 12345678; branch not on origin (nothing pushed).');
  });

  it('the legacy shape (no head fields — the kill-switched read) renders byte-identically', async () => {
    mockSessionDiff.mockResolvedValue({ branch: 'digby/z', status: '', diffStat: '', source: 'disk' });
    const r = await run('get_session_diff', { chatId: 'c3' });
    expect(r.message).toBe('Worktree clean on digby/z (nothing uncommitted).');
    expect(r.head).toBeUndefined();
  });
});
