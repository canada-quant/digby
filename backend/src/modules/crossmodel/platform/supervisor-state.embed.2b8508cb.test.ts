/**
 * Ticket 2b8508cb — the WRITE seam: every supervisor-state doc write
 * (upsertDoc, the single serialized core ALL write paths go through) mirrors
 * the doc into digby_memory via the supervisor-state-memory bridge
 * (dynamic import + fire-and-forget, after the row commits). A memory
 * failure must NEVER fail the doc write.
 * This suite mocks the BRIDGE at the module boundary (its internals are
 * pinned in supervisor-state-memory.test.ts) and drives a real doc write
 * through applyStateUpdate — the same merge the update_supervisor_state
 * tool runs.
 * Harness copied from supervisor-state.liveness.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const stateRows = new Map<string, { chatId: string; userId: string; state: any }>();
const mockPrisma: any = {
  supervisorState: {
    findUnique: jest.fn(async ({ where }: any) => stateRows.get(where.chatId) ?? null),
    upsert: jest.fn(async (args: any) => {
      stateRows.set(args.where.chatId, { chatId: args.where.chatId, userId: args.create?.userId ?? 'u1', state: args.update?.state ?? args.create?.state });
      return stateRows.get(args.where.chatId);
    }),
  },
  crossModelChat: { findUnique: jest.fn(async () => ({ project: { name: 'Fleet' } })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// THE SEAM UNDER TEST — the memory bridge, mocked at the module boundary.
const mockEmbedDoc: jest.Mock = jest.fn(async () => 3);
const mockEnqueueEmbed: jest.Mock = jest.fn((chatId: string, doc: any, opts: any) => {
  // Mirror the real enqueue's contract: runs the embed, catches failures.
  void Promise.resolve()
    .then(() => mockEmbedDoc(chatId, doc, opts))
    .catch(() => {});
});
jest.mock('./supervisor-state-memory', () => ({
  __esModule: true,
  embedSupervisorStateDoc: (...a: any[]) => mockEmbedDoc(...(a as [any, any, any])),
  enqueueSupervisorStateEmbed: (...a: any[]) => mockEnqueueEmbed(...(a as [any, any, any])),
}));

import { applyStateUpdate, getSupervisorState } from './supervisor-state.service';

const CHAT = 'sup-chat-1';

async function flushMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  jest.clearAllMocks();
  stateRows.clear();
  delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED;
});
afterEach(() => { delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED; });

describe('upsertDoc → supervisor-state-memory embed (2b8508cb)', () => {
  it('a doc write mirrors the doc into digby_memory with the chat id + userId', async () => {
    // Seed a directive the way the merge adds one (text — the id is generated),
    // then close it BY that id (the citation-validation path).
    await applyStateUpdate(CHAT, 'u1', { directives: [{ text: 'Keep the audit tight' }] });
    const seededId = (await getSupervisorState(CHAT)).directives[0]?.id;
    expect(seededId).toBeTruthy();
    mockEmbedDoc.mockClear();
    const res = await applyStateUpdate(CHAT, 'u1', {
      directives: [{ id: seededId, status: 'done', evidence: 'session 11111111-1111-1111-1111-111111111111' }],
      dispatches: [{ kind: 'session', id: '11111111-1111-1111-1111-111111111111', note: 'spawned lane' }],
    });
    expect(res.errors).toEqual([]);
    await flushMicrotasks();
    expect(mockEmbedDoc).toHaveBeenCalledTimes(1);
    const [chatId, doc, opts] = mockEmbedDoc.mock.calls[0] as any[];
    expect(chatId).toBe(CHAT);
    expect(opts).toMatchObject({ userId: 'u1' });
    // the doc passed is the POST-write shape (the directive row is closed in it)
    const d = (doc.directives || []).find((x: any) => x.id === seededId);
    expect(d?.status).toBe('done');
    // and it round-trips through the row (the doc is the source of truth)
    const loaded = await getSupervisorState(CHAT);
    expect(loaded.dispatches.some((x: any) => x.id === '11111111-1111-1111-1111-111111111111')).toBe(true);
  });

  it('a SECOND write re-mirrors (the bridge itself short-circuits no-ops)', async () => {
    await applyStateUpdate(CHAT, 'u1', { notes: 'first' });
    await applyStateUpdate(CHAT, 'u1', { notes: 'second' });
    await flushMicrotasks();
    expect(mockEmbedDoc).toHaveBeenCalledTimes(2);
  });

  it('a bridge failure never fails the doc write (fire-and-forget)', async () => {
    mockEmbedDoc.mockRejectedValueOnce(new Error('vector store down'));
    const res = await applyStateUpdate(CHAT, 'u1', { notes: 'still persists' });
    expect(res.errors).toEqual([]);
    await flushMicrotasks();
    expect((await getSupervisorState(CHAT)).notes).toBe('still persists');
  });
});
