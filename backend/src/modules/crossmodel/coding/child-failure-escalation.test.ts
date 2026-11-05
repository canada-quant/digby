/**
 * CHILD RUN FAILURE → PARENT ESCALATION pins (spark-cluster audit 2026-09-17,
 * child 1d39d145). A FAILED machine run on a spawned child wakes its
 * SUPERVISOR parent once per 2 h with [CHILD RUN FAILED]; user runs,
 * parentless chats, foreign or archived parents, the dedupe window and the
 * kill switch all skip; the run executor wires it next to the run_failed
 * hook event.
 *
 * Hand-off polish (2026-09-28, audit CT-4 / DOI-20): a PLAIN human parent
 * (not a Fleet / Project Supervisor) gets ONE honest assistant row + its
 * SESSION card flipped to FAILED instead of the raw machine wake; the
 * kill switch, a disabled hand-off / task card, and a failed row post all
 * fall back to the wake.
 */
const mockPrisma: any = { crossModelChat: { findUnique: jest.fn(async () => null) } };
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
};
const mockWake = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
const mockRecordLoopMetric = jest.fn();
const mockAppendMessage: jest.Mock = jest.fn(async (_chatId: string, _content: string, _meta: any) => ({ id: 'row-fail-1' }));
const mockPersistTaskCard: jest.Mock = jest.fn(async () => 'answer-row-1');
const mockEmitTask: jest.Mock = jest.fn(() => true);
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
jest.mock('../platform/hooks.service', () => ({ __esModule: true, enqueueDirectWake: (...a: any[]) => (mockWake as any)(...a) }));
// The hand-off's default deps route the row by what the TARGET is (the real
// module pulls prisma + coding-data.service); here the boundary is the seam.
jest.mock('./deliverable-handoff', () => ({
  __esModule: true,
  taskIdForSession: (id: string) => `session:${id}`,
  defaultHandoffDeps: () => ({ appendMessage: (...a: any[]) => mockAppendMessage(...a) }),
}));
jest.mock('../chat-agent/task-events', () => ({
  __esModule: true,
  buildTaskEvent: (p: any) => ({ steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0, artifacts: [], startedAt: 'now', updatedAt: 'now', ...p }),
  persistTaskCard: (...a: any[]) => mockPersistTaskCard(...a),
  emitTaskEvent: (...a: any[]) => mockEmitTask(...a),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  escalateChildRunFailure, renderChildFailureWake, renderChildFailureRow, CHILD_FAILURE_DEDUPE_SEC,
  CHILD_FAILURE_MESSAGE_KIND, CHILD_FAILURE_MESSAGE_ORIGIN,
} from './child-failure-escalation';

const CHILD = '1d39d145-0000-4000-8000-000000000000';
const PARENT = '28de72e5-0000-4000-8000-000000000000';
const CAUSE = 'Coding run failed: model provider killed the run (transient failure): The model kept rejecting the request (connect ETIMEDOUT 89.124.37.178:4000; 5 backoff-and-retry attempts exhausted).';
/** The prod occurrences (14 d, 15 rows) were ALL project-supervisor parents — the wake path's home. */
const SUPERVISOR_PARENT = { id: PARENT, userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: true };
const PLAIN_PARENT = { id: PARENT, userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false };

describe('escalateChildRunFailure', () => {
  beforeEach(() => {
    store.clear(); mockWake.mockClear(); mockRecordLoopMetric.mockClear(); mockRedis.set.mockClear();
    mockAppendMessage.mockClear(); mockPersistTaskCard.mockClear(); mockEmitTask.mockClear();
    mockAppendMessage.mockImplementation(async () => ({ id: 'row-fail-1' }));
    mockPersistTaskCard.mockImplementation(async () => 'answer-row-1');
    mockPrisma.crossModelChat.findUnique.mockReset();
  });
  const chatRows = (child: any, parent: any) => mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => (where.id === CHILD ? child : where.id === PARENT ? parent : null));

  it('a failed hook run on a spawned child wakes the SUPERVISOR parent ONCE with [CHILD RUN FAILED] and stamps the 2h dedupe', async () => {
    chatRows({ id: CHILD, title: 'Third-Pass Probe Re-Verified All', userId: 'u1', parentChatId: PARENT }, SUPERVISOR_PARENT);
    const out = await escalateChildRunFailure({ chatId: CHILD, runId: 'run-1111', cause: CAUSE, triggerKind: 'hook' });
    expect(out).toEqual({ escalated: true, reason: 'woken', parentChatId: PARENT });
    const call = (mockWake.mock.calls[0] as any)[0];
    expect(call.targetChatId).toBe(PARENT);
    expect(call.prompt).toContain('[CHILD RUN FAILED] Your sub-session 1d39d145 "Third-Pass Probe Re-Verified All" (hook run run-1111) ended FAILED: Coding run failed');
    expect(call.prompt).toContain('NOT on the same pinned endpoint');
    expect(call.prompt).toContain('start_coding_session');
    expect(call.meta).toMatchObject({ origin: 'child-failure-escalation', kind: 'child_run_failed', childChatId: CHILD, triggerKind: 'hook' });
    expect(mockRedis.set).toHaveBeenCalledWith(`child-fail:${CHILD}`, 'run-1111', { EX: CHILD_FAILURE_DEDUPE_SEC });
    expect(mockAppendMessage).not.toHaveBeenCalled(); // a supervisor never gets the plain-chat row
    // second failure inside the window → deduped
    const again = await escalateChildRunFailure({ chatId: CHILD, runId: 'run-2222', cause: CAUSE, triggerKind: 'hook' });
    expect(again).toEqual({ escalated: false, reason: 'deduped', parentChatId: PARENT });
    expect(mockWake).toHaveBeenCalledTimes(1);
  });

  it('skips user runs, parentless chats, a parent owned by another user, an archived parent, a failed wake (no dedupe stamp), and the kill switch', async () => {
    expect(await escalateChildRunFailure({ chatId: CHILD, cause: CAUSE, triggerKind: 'user' })).toEqual({ escalated: false, reason: 'user_run' });
    chatRows({ id: CHILD, title: 't', userId: 'u1', parentChatId: null }, null);
    expect(await escalateChildRunFailure({ chatId: CHILD, cause: CAUSE, triggerKind: 'hook' })).toEqual({ escalated: false, reason: 'no_parent' });
    chatRows({ id: CHILD, title: 't', userId: 'u1', parentChatId: PARENT }, { ...SUPERVISOR_PARENT, userId: 'u2' });
    expect(await escalateChildRunFailure({ chatId: CHILD, cause: CAUSE, triggerKind: 'hook' })).toEqual({ escalated: false, reason: 'parent_missing_or_foreign' });
    chatRows({ id: CHILD, title: 't', userId: 'u1', parentChatId: PARENT }, { ...SUPERVISOR_PARENT, archivedAt: new Date() });
    expect(await escalateChildRunFailure({ chatId: CHILD, cause: CAUSE, triggerKind: 'hook' })).toEqual({ escalated: false, reason: 'parent_archived' });
    chatRows({ id: CHILD, title: 't', userId: 'u1', parentChatId: PARENT }, SUPERVISOR_PARENT);
    mockWake.mockResolvedValueOnce({ ok: false, error: 'target chat not found' } as any);
    expect(await escalateChildRunFailure({ chatId: CHILD, cause: CAUSE, triggerKind: 'schedule' })).toEqual({ escalated: false, reason: 'wake_failed:target chat not found', parentChatId: PARENT });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('renderChildFailureWake names the child, the trigger, the cause, and the three exits; a non-network cause drops the endpoint clause', () => {
    const txt = renderChildFailureWake({ id: CHILD, title: null }, { chatId: CHILD, runId: 'r-1', cause: 'model provider killed the run (billing failure, HTTP 402)', triggerKind: 'schedule' });
    expect(txt).toContain('sub-session 1d39d145 "untitled" (schedule run r-1) ended FAILED: model provider killed the run (billing failure, HTTP 402)');
    expect(txt).not.toContain('NOT on the same pinned endpoint');
    expect(txt).toContain('todo_update');
  });

  // ── Hand-off polish (audit CT-4 / DOI-20): the PLAIN human parent ──
  describe('a PLAIN (human, non-supervisor) parent', () => {
    const child = { id: CHILD, title: '3-slide 16:9 PDF deck', userId: 'u1', parentChatId: PARENT };

    it('gets ONE honest assistant row + its SESSION card flipped to FAILED (no machine wake); the dedupe stamp + both metrics are written', async () => {
      chatRows(child, PLAIN_PARENT);
      const out = await escalateChildRunFailure({ chatId: CHILD, runId: 'run-3333', cause: CAUSE, triggerKind: 'schedule' });
      expect(out).toEqual({ escalated: true, reason: 'card', parentChatId: PARENT, messageId: 'row-fail-1' });
      expect(mockWake).not.toHaveBeenCalled();
      // the row: routed through the hand-off's appendMessage (chat row for a plain chat), harness-stamped, no worktree, no supervisor instruction
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      const [chatId, content, meta] = mockAppendMessage.mock.calls[0];
      expect(chatId).toBe(PARENT);
      expect(content).toContain('**Sub-session failed: 3-slide 16:9 PDF deck**');
      expect(content).toContain('ended without delivering anything');
      expect(content).toContain('Nothing from it landed in this chat. Reply here to retry');
      expect(content).not.toMatch(/MACHINE-TRIGGERED|start_coding_session|todo_update|\[CHILD RUN FAILED\]|\/app\//);
      expect(meta).toMatchObject({ kind: CHILD_FAILURE_MESSAGE_KIND, origin: CHILD_FAILURE_MESSAGE_ORIGIN, harness: true, childChatId: CHILD, runId: 'run-3333', triggerKind: 'schedule' });
      expect(meta.task).toMatchObject({ taskId: `session:${CHILD}`, chatId: PARENT, childChatId: CHILD, kind: 'session', status: 'failed', title: '3-slide 16:9 PDF deck' });
      expect(meta.task.note).toMatch(/^The sub-session's run failed: model provider killed the run/);
      // the card: preferCarrier (the answer row that spawned it), the new row as the fallback anchor, the live frame
      expect(mockPersistTaskCard).toHaveBeenCalledWith(PARENT, expect.objectContaining({ taskId: `session:${CHILD}`, status: 'failed' }), { preferCarrier: true, messageId: 'row-fail-1' });
      expect(mockEmitTask).toHaveBeenCalledWith(PARENT, expect.objectContaining({ taskId: `session:${CHILD}`, status: 'failed' }));
      expect(mockRedis.set).toHaveBeenCalledWith(`child-fail:${CHILD}`, 'run-3333', { EX: CHILD_FAILURE_DEDUPE_SEC });
      expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'handoff_parent_wake_skipped', sessionId: PARENT, meta: expect.objectContaining({ childChatId: CHILD, reason: 'failed_card_flipped', runIds: ['run-3333'], cardFlipped: 1 }) }));
      // a second failure inside the window is deduped exactly like the wake path
      expect(await escalateChildRunFailure({ chatId: CHILD, runId: 'run-4444', cause: CAUSE, triggerKind: 'hook' })).toEqual({ escalated: false, reason: 'deduped', parentChatId: PARENT });
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    });

    it('no card to flip (the spawn was never carded): the row still posts and the skip row says cardFlipped:0', async () => {
      chatRows(child, PLAIN_PARENT);
      mockPersistTaskCard.mockResolvedValueOnce(null);
      const out = await escalateChildRunFailure({ chatId: CHILD, runId: 'run-5555', cause: CAUSE, triggerKind: 'hook' });
      expect(out).toMatchObject({ escalated: true, reason: 'card' });
      expect(mockWake).not.toHaveBeenCalled();
      expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'handoff_parent_wake_skipped', meta: expect.objectContaining({ reason: 'failed_card_flipped', cardFlipped: 0 }) }));
    });

    it('falls back to the wake when the row cannot be posted', async () => {
      chatRows(child, PLAIN_PARENT);
      mockAppendMessage.mockRejectedValueOnce(new Error('db down'));
      expect(await escalateChildRunFailure({ chatId: CHILD, runId: 'r-a', cause: CAUSE, triggerKind: 'hook' })).toEqual({ escalated: true, reason: 'woken', parentChatId: PARENT });
      expect(mockWake).toHaveBeenCalledTimes(1);
      store.clear();
      mockAppendMessage.mockResolvedValueOnce(null as any); // no row id
      expect(await escalateChildRunFailure({ chatId: CHILD, runId: 'r-b', cause: CAUSE, triggerKind: 'hook' })).toMatchObject({ reason: 'woken' });
      expect(mockWake).toHaveBeenCalledTimes(2);
      expect(mockAppendMessage).toHaveBeenCalledTimes(2); // the two attempts that reached the row post
    });

    it('renderChildFailureRow: the title, the cause without the "Coding run failed:" prefix, no supervisor vocabulary', () => {
      const txt = renderChildFailureRow({ id: CHILD, title: null }, { chatId: CHILD, runId: 'r-1', cause: 'Coding run failed: model provider killed the run (billing failure, HTTP 402)', triggerKind: 'schedule' });
      expect(txt.startsWith('**Sub-session failed: Coding session**')).toBe(true);
      expect(txt).toContain('ended without delivering anything — model provider killed the run (billing failure, HTTP 402)');
      expect(txt).not.toMatch(/Coding run failed:|re-dispatch|todo/);
    });
  });

  it('wiring pin: the run executor escalates a FAILED unattended run (machine OR owner-dispatch) right after the run_failed hook event', () => {
    const src = fs.readFileSync(path.join(__dirname, 'run-executor.ts'), 'utf8');
    // unattendedRun = triggerKind !== 'user' || ownerDispatchRun (2026-10-01)
    expect(src).toContain("const unattendedRun = triggerKind !== 'user' || ownerDispatchRun;");
    expect(src).toContain("if (finalStatus === 'failed' && unattendedRun) {");
    expect(src).toContain("c.escalateChildRunFailure({ chatId: id, runId: claimed.id, cause: hookSummary, triggerKind, ...(ownerDispatchRun ? { unattended: true } : {}) })");
    expect(src.indexOf("c.escalateChildRunFailure")).toBeGreaterThan(src.indexOf("finalStatus === 'completed' ? 'run_completed' : 'run_failed'"));
  });

  it('owner-dispatch (2026-10-01): a USER-classified but UNATTENDED failed run escalates exactly like a machine run; a watched user run never does', async () => {
    chatRows({ id: CHILD, title: 'TB task 46', userId: 'u1', parentChatId: PARENT }, SUPERVISOR_PARENT);
    expect(await escalateChildRunFailure({ chatId: CHILD, cause: CAUSE, triggerKind: 'user' })).toEqual({ escalated: false, reason: 'user_run' });
    expect(mockWake).not.toHaveBeenCalled();
    const out = await escalateChildRunFailure({ chatId: CHILD, runId: 'run-od-1', cause: CAUSE, triggerKind: 'user', unattended: true });
    expect(out).toEqual({ escalated: true, reason: 'woken', parentChatId: PARENT });
    expect((mockWake.mock.calls[0] as any)[0].prompt).toContain('[CHILD RUN FAILED] Your sub-session 1d39d145 "TB task 46" (owner-dispatched run run-od-1) ended FAILED');
  });
});
