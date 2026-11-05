// Clickable answer references (2026-10-08) — ./entity-refs.ts.
const db = {
  crossModelChat: { findMany: jest.fn(), findFirst: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  runToolReceipt: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: db }));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { normalizeRefId, resolveEntityRef, resolveEntityRefHandler } from './entity-refs';

const U = 'user-1';
beforeEach(() => { jest.resetAllMocks(); });

describe('entity refs', () => {
  it('accepts 8..36-char hex/uuid prefixes only', () => {
    expect(normalizeRefId('FBB5C9CA')).toBe('fbb5c9ca');
    expect(normalizeRefId('fbb5c9c')).toBeNull();
    expect(normalizeRefId('zzzzzzzz')).toBeNull();
    expect(normalizeRefId("fbb5c9ca' or 1=1")).toBeNull();
  });

  it('a session prefix opens the ONE owned chat it names; ambiguous or unknown → null', async () => {
    db.crossModelChat.findMany.mockResolvedValueOnce([{ id: 'fbb5c9ca-0000-4000-8000-000000000001', title: 'node-a 64K lane' }]);
    const r = await resolveEntityRef(U, 'session', 'fbb5c9ca');
    expect(r).toEqual({ kind: 'session', id: 'fbb5c9ca-0000-4000-8000-000000000001', title: 'node-a 64K lane', open: { type: 'chat', chatId: 'fbb5c9ca-0000-4000-8000-000000000001' } });
    expect(db.crossModelChat.findMany.mock.calls[0][0].where).toEqual({ userId: U, id: { startsWith: 'fbb5c9ca' } });
    db.crossModelChat.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    expect(await resolveEntityRef(U, 'chat', 'fbb5c9ca')).toBeNull();
    db.crossModelChat.findMany.mockResolvedValueOnce([]);
    expect(await resolveEntityRef(U, 'chat', 'fbb5c9ca')).toBeNull();
  });

  it('a goal opens its project; a todo opens its assigned lane, else its project', async () => {
    db.projectGoal.findMany.mockResolvedValueOnce([{ id: 'g1', title: 'node-a 64K', projectId: 'p1' }]);
    expect((await resolveEntityRef(U, 'goal', '534c37aa'))?.open).toEqual({ type: 'project', projectId: 'p1' });
    db.projectTodo.findMany.mockResolvedValueOnce([{ id: 't1', title: 'restart', projectId: 'p1', assigneeChatId: 'lane-1' }]);
    db.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'lane-1', title: 'lane' });
    expect((await resolveEntityRef(U, 'todo', '536d5d52'))?.open).toEqual({ type: 'chat', chatId: 'lane-1' });
    db.projectTodo.findMany.mockResolvedValueOnce([{ id: 't2', title: 'bench', projectId: 'p1', assigneeChatId: null }]);
    expect((await resolveEntityRef(U, 'todo', '63a8404a'))?.open).toEqual({ type: 'project', projectId: 'p1' });
  });

  it('a receipt opens the session it started (owned), else the chat that ran it', async () => {
    db.runToolReceipt.findMany.mockResolvedValueOnce([{ id: 'r1', tool: 'start_coding_session', chatId: 'sup', ids: { sessionId: 'child' } }]);
    db.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'child', title: 'lane' });
    expect((await resolveEntityRef(U, 'receipt', 'b3649334'))?.open).toEqual({ type: 'chat', chatId: 'child' });
    expect(db.runToolReceipt.findMany.mock.calls[0][0].where).toEqual({ id: { startsWith: 'b3649334' }, chat: { userId: U } });
    db.runToolReceipt.findMany.mockResolvedValueOnce([{ id: 'r2', tool: 'goal_create', chatId: 'sup', ids: {} }]);
    expect((await resolveEntityRef(U, 'receipt', 'aaaa1111'))?.open).toEqual({ type: 'chat', chatId: 'sup' });
  });

  it('the handler 404s on a bad kind, a bad id, or a miss', async () => {
    const res = () => { const r: any = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
    const r1 = res(); await resolveEntityRefHandler({ user: { id: U }, params: { kind: 'user', id: 'fbb5c9ca' } } as any, r1);
    expect(r1.status).toHaveBeenCalledWith(404);
    const r2 = res(); await resolveEntityRefHandler({ user: { id: U }, params: { kind: 'chat', id: 'nothex!!' } } as any, r2);
    expect(r2.status).toHaveBeenCalledWith(404);
    db.crossModelChat.findMany.mockResolvedValueOnce([{ id: 'c1', title: null }]);
    const r3 = res(); await resolveEntityRefHandler({ user: { id: U }, params: { kind: 'chat', id: 'fbb5c9ca' } } as any, r3);
    expect(r3.json).toHaveBeenCalledWith({ success: true, data: { kind: 'chat', id: 'c1', title: null, open: { type: 'chat', chatId: 'c1' } } });
  });
});
