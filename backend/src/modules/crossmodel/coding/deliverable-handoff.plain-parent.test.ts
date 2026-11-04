/**
 * Deliverable hand-off → a PLAIN-chat parent (cohesive chat live fixes,
 * 2026-09-28). The live acceptance (parent b9ee9c20, 05:27:36Z) failed the
 * result post with `Invalid prisma.codingMessage.create() … Foreign key
 * constraint violated on coding_messages_sessionId_fkey` — the default deps'
 * appendMessage dual-wrote the CODING transcript for EVERY target while the
 * dual-write flag was on, and a plain chat has no coding_sessions row.
 *
 * Pins, against the REAL defaultHandoffDeps().appendMessage (prisma +
 * coding-data.service mocked at the boundary): a plain-chat parent gets the
 * chat message row only (result row posted, the task card flipped to done, NO
 * coding_messages write); a CODING parent keeps the coding transcript +
 * mirror path; the kill switch restores the unconditional dual-write.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const codingStateRows = new Set<string>();
const mockCrossModelMessageCreate: jest.Mock = jest.fn(async ({ data }: any) => ({ id: `xm-${data.chatId}` }));
const mockCodingMessageCreate: jest.Mock = jest.fn(async ({ data }: any) => ({ id: `cm-${data.chatId}`, ...data }));
const mockPrisma: any = {
  chatCodingState: { findUnique: jest.fn(async ({ where }: any) => (codingStateRows.has(where.id) ? { id: where.id } : null)) },
  crossModelMessage: { create: (...a: any[]) => mockCrossModelMessageCreate(...a) },
  codingMessage: { create: (...a: any[]) => mockCodingMessageCreate(...a) },
  crossModelChat: { update: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// coding-data.service at the boundary: appendCodingMessage IS the coding
// transcript write (it would hit coding_messages); a plain parent must never reach it.
const mockAppendCodingMessage: jest.Mock = jest.fn(async (d: any) => mockCodingMessageCreate({ data: { chatId: d.chatId, role: d.role, content: d.content } }));
const mockTouchChat: jest.Mock = jest.fn(async () => {});
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  transcriptDualWriteEnabled: () => process.env.TRANSCRIPT_DUAL_WRITE !== 'off',
  appendCodingMessage: (...a: any[]) => mockAppendCodingMessage(...a),
  touchChat: (...a: any[]) => mockTouchChat(...a),
}));

import {
  runDeliverableHandoff,
  defaultHandoffDeps,
  HANDOFF_MESSAGE_KIND,
  type HandoffChat,
  type HandoffDeps,
  type HandoffInput,
  type WorktreeFileEntry,
} from './deliverable-handoff';

const T0 = Date.parse('2026-09-28T05:10:00.000Z');
const NOW = new Date(T0 + 17 * 60_000);
const CHILD = '3d21b4d8-aaaa-4bbb-8ccc-000000000001';
const PARENT = 'b9ee9c20-aaaa-4bbb-8ccc-000000000002';
const RUN = 'c8bdbd01-aaaa-4bbb-8ccc-000000000003';
const USER = 'user-claudebot';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(900, 0x41)]);
const LISTING: WorktreeFileEntry[] = [{ rel: 'deck/three-slides.pdf', bytes: PDF.length, mtimeMs: T0 + 60_000 }];

function world() {
  const chats = new Map<string, HandoffChat>();
  chats.set(CHILD, { id: CHILD, userId: USER, parentChatId: PARENT, title: 'Three-slide deck', isSupervisor: false, isProjectSupervisor: false });
  chats.set(PARENT, { id: PARENT, userId: USER, parentChatId: null, title: 'Chat', isSupervisor: false, isProjectSupervisor: false });
  const w = {
    chats,
    files: [] as Array<{ chatId: string; uploadId: string }>,
    events: [] as any[],
    cards: [] as any[],
    metrics: [] as any[],
    claims: new Set<string>(),
  };
  const real = defaultHandoffDeps();
  const deps: HandoffDeps = {
    findChat: async (id) => chats.get(id) ?? null,
    countCompletedRuns: async () => 1,
    getRunReceipts: async () => [],
    listWorktree: async () => LISTING,
    gitClasses: async () => null,
    readFile: async (_root, rel) => (rel === 'deck/three-slides.pdf' ? PDF : null),
    listCanvases: async () => [],
    copyCanvas: async () => null,
    persistFiles: async (chatId, _u, loaded) => { for (const l of loaded) w.files.push({ chatId, uploadId: l.id }); },
    findChatFiles: async (chatId, ids) => w.files.filter((f) => f.chatId === chatId && ids.includes(f.uploadId)).map((f) => ({ id: `file-${f.uploadId.slice(0, 8)}`, uploadId: f.uploadId, sizeBytes: PDF.length })),
    // THE unit under test: the real default appendMessage (prisma + coding-data mocked at the boundary).
    appendMessage: real.appendMessage,
    claim: async (s, r) => { const k = `${s}/${r}`; if (w.claims.has(k)) return false; w.claims.add(k); return true; },
    releaseClaim: async (s, r) => { w.claims.delete(`${s}/${r}`); },
    saveRecord: async () => {},
    emitTask: (chatId, payload) => { w.events.push({ chatId, payload }); },
    persistTaskCard: async (chatId, payload, opts) => { w.cards.push({ chatId, payload, opts }); return 'row-answer'; },
    recordMetric: (m) => { w.metrics.push(m); },
  };
  return { ...w, deps };
}

const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  runId: RUN, sessionId: CHILD, userId: USER, worktreeRoot: '/work/' + CHILD, baseBranch: 'main',
  runStartedAt: new Date(T0), finalText: 'Built the 3-slide deck and exported deck/three-slides.pdf.',
  sessionTitle: 'Three-slide deck', triggerKind: 'user', now: NOW, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  codingStateRows.clear();
  delete process.env.TRANSCRIPT_DUAL_WRITE;
});

describe('hand-off result post → a PLAIN chat parent (no coding session row)', () => {
  it('posts the result row on the parent as a chat message, flips the task card to done, and writes NO coding_messages row', async () => {
    codingStateRows.add(CHILD); // the child is a coding session; the parent is a plain chat
    const w = world();
    const res = await runDeliverableHandoff(input(), w.deps);

    expect(res.posted).toBe(true);
    expect(res.targetChatId).toBe(PARENT);
    expect(res.resultMessageId).toBe(`xm-${PARENT}`);
    // The chat row, on the parent, stamped as the hand-off's harness row.
    expect(mockCrossModelMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockCrossModelMessageCreate.mock.calls[0][0]).toMatchObject({
      data: { chatId: PARENT, role: 'assistant', metadata: expect.objectContaining({ kind: HANDOFF_MESSAGE_KIND, childChatId: CHILD, runId: RUN }) },
      select: { id: true },
    });
    // NEVER the coding transcript for a plain chat (the FK violation of the live acceptance).
    expect(mockAppendCodingMessage).not.toHaveBeenCalled();
    expect(mockCodingMessageCreate).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.findUnique).toHaveBeenCalledWith({ where: { id: PARENT }, select: { id: true } });
    expect(mockTouchChat).toHaveBeenCalledWith(PARENT);
    // The task card: ONE card running → done, preferCarrier, anchored on the result row as fallback.
    expect(w.cards).toEqual([expect.objectContaining({
      chatId: PARENT,
      payload: expect.objectContaining({ kind: 'session', status: 'done', childChatId: CHILD, artifacts: [expect.objectContaining({ name: 'deck/three-slides.pdf', kind: 'file' })] }),
      opts: { preferCarrier: true, messageId: `xm-${PARENT}` },
    })]);
    expect(w.events).toEqual([expect.objectContaining({ chatId: PARENT, payload: expect.objectContaining({ status: 'done', resultMessageId: `xm-${PARENT}` }) })]);
    expect(w.metrics.find((m) => m.kind === 'deliverable_handoff')?.meta).toMatchObject({ posted: true, targetChatId: PARENT, files: 1 });
  });

  it('a CODING parent keeps the coding transcript + mirror path (dual-write on)', async () => {
    codingStateRows.add(CHILD);
    codingStateRows.add(PARENT);
    const w = world();
    const res = await runDeliverableHandoff(input(), w.deps);
    expect(res.posted).toBe(true);
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: PARENT, role: 'assistant' }));
    expect(mockCrossModelMessageCreate).not.toHaveBeenCalled();
    expect(res.resultMessageId).toBe(`cm-${PARENT}`);
  });

  it('a coding parent with the dual-write OFF takes the chat row (the mirror IS the read side)', async () => {
    process.env.TRANSCRIPT_DUAL_WRITE = 'off';
    codingStateRows.add(CHILD);
    codingStateRows.add(PARENT);
    const w = world();
    await runDeliverableHandoff(input(), w.deps);
    expect(mockAppendCodingMessage).not.toHaveBeenCalled();
    expect(mockCrossModelMessageCreate).toHaveBeenCalledTimes(1);
  });

  it('a probe error routes to the chat row (fail-open toward the write that cannot violate the FK)', async () => {
    codingStateRows.add(CHILD);
    mockPrisma.chatCodingState.findUnique.mockRejectedValueOnce(new Error('db hiccup'));
    const w = world();
    const res = await runDeliverableHandoff(input(), w.deps);
    expect(res.posted).toBe(true);
    expect(mockAppendCodingMessage).not.toHaveBeenCalled();
    expect(mockCrossModelMessageCreate).toHaveBeenCalledTimes(1);
  });
});
