/**
 * Late cross-check reconcile (owner 2026-09-18 — "users get the first
 * available answer… updated after the Double Checker finished"): the pure
 * derivation helpers and the four outcomes over mocked prisma / an injected
 * reconcile pass / the run's own checker promise.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPrisma: any = {
  crossModelMessage: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(async (q: any) => q) },
  crossModelChat: { update: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { deriveRevisedAnswer, reviseParts, sameAnswer, runLateCrossCheck, pendingLateCrossCheckCount, abandonPendingLateCrossChecks } from './late-crosscheck';

const NOW = new Date('2026-09-18T20:36:15.000Z');
const ROW = {
  id: 'msg-1', chatId: 'chat-1',
  content: 'Honest answer: I dropped it twice.',
  metadata: { mode: 'thinking', engine: 'agent', models: { digby: { model: 'digby', response: 'Honest answer: I dropped it twice.', time: 89093 } }, followUps: ['Show the SupportsPP patch'], pendingCrossCheck: true },
  parts: [{ type: 'tool_call', name: 'todo_get' }, { type: 'text', text: 'Honest answer: I dropped it twice.' }],
};

function input(over: Partial<Parameters<typeof runLateCrossCheck>[0]> = {}) {
  const models: Record<string, any> = {};
  return {
    chatId: 'chat-1', messageId: 'msg-1', question: 'why not the first time?', draft: 'Honest answer: I dropped it twice.\n\n[FOLLOWUPS]\n- Show the SupportsPP patch\n[/FOLLOWUPS]',
    model: 'kimi-k3', sessionId: 'chat-1', projectId: 'p1', userId: 'u1', userTurnAt: undefined,
    checkersPromise: Promise.resolve('--- Double Checker ---\nThe drafter exists on HF since 09-06.'),
    models, cardKey: 'double_checker', startedAt: Date.now() - 100_000,
    reconcile: jest.fn(async () => 'Honest answer: I dropped it twice — and the Double Checker confirms the drafter has been public since 09-06.\n\n[FOLLOWUPS]\n- Open the SupportsPP patch\n[/FOLLOWUPS]'),
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW });
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-1' }); // still the latest row
});

describe('pure helpers', () => {
  it('deriveRevisedAnswer strips canvas/follow-up chrome, lifts new follow-ups, falls back to the previous chips', () => {
    const r = deriveRevisedAnswer('New text.\n\n[CANVAS:type=code title=x]\nconsole.log(1)\n[/CANVAS]\n\n[FOLLOWUPS]\n- Show me the SupportsPP patch\n- Compare the two drafters\n[/FOLLOWUPS]', ['old']);
    expect(r.content).toBe('New text.');
    expect(r.followUps).toEqual(['Show me the SupportsPP patch', 'Compare the two drafters']);
    expect(deriveRevisedAnswer('Just text.', ['old']).followUps).toEqual(['old']);
  });

  it('reviseParts swaps only the text parts; no parts → undefined', () => {
    expect(reviseParts(ROW.parts, 'revised')).toEqual([{ type: 'tool_call', name: 'todo_get' }, { type: 'text', text: 'revised' }]);
    expect(reviseParts(undefined, 'x')).toBeUndefined();
    expect(reviseParts([], 'x')).toBeUndefined();
  });

  it('sameAnswer ignores whitespace re-flow', () => {
    expect(sameAnswer('a  b\nc', 'a b c')).toBe(true);
    expect(sameAnswer('a b', 'a c')).toBe(false);
  });
});

describe('runLateCrossCheck outcomes', () => {
  it('revised: the draft lands, the row is still the latest, the reconcile changes the text → content/parts/followUps/revision/card written, ONE metric', async () => {
    const inp = input();
    inp.models.double_checker = { model: 'double_checker', response: 'draft…', time: 212488, persona: 'Double Checker', modelUsed: 'deepseek-flash' };
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('revised');
    expect(inp.reconcile).toHaveBeenCalledWith(expect.objectContaining({ model: 'kimi-k3', draft: inp.draft, block: expect.stringContaining('Double Checker') }));
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'msg-1' });
    expect(upd.data.content).toBe('Honest answer: I dropped it twice — and the Double Checker confirms the drafter has been public since 09-06.');
    expect(upd.data.parts).toEqual([{ type: 'tool_call', name: 'todo_get' }, { type: 'text', text: upd.data.content }]);
    expect(upd.data.metadata).toMatchObject({
      mode: 'thinking', pendingCrossCheck: false,
      followUps: ['Open the SupportsPP patch'],
      models: { digby: expect.any(Object), double_checker: expect.objectContaining({ modelUsed: 'deepseek-flash', time: 212488 }) },
      revision: { at: NOW.toISOString(), reason: 'double_checker', checkerTimeMs: 212488, previousContent: 'Honest answer: I dropped it twice.' },
      crossCheck: expect.objectContaining({ outcome: 'revised', checkerTimeMs: 212488 }),
    });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'chat-1' } }));
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'crosscheck_late_reconcile', sessionId: 'chat-1', meta: expect.objectContaining({ outcome: 'revised' }) }));
  });

  it('review fix 7 (turn continuation): a material revision goes through rewriteRevised — the continuation line survives, the hand-back and the chips do not', async () => {
    const CONT = 'Still working on this — I will post the result here.';
    const rewritten = `Honest answer: I dropped it twice.\n\n${CONT}`;
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: rewritten, parts: [{ type: 'text', text: rewritten }], metadata: { ...ROW.metadata, followUps: undefined, task: { taskId: 't1', status: 'running' } } });
    const inp = input({
      reconcile: jest.fn(async () => 'Honest answer: I dropped it twice — the Double Checker confirms the drafter has been public since 09-06.\n\nSay the word and I will search her thread next.\n\n[FOLLOWUPS]\n- Search her thread\n[/FOLLOWUPS]'),
      rewriteRevised: (c: string) => `${c.split('\n\n').filter((p) => !/say the word/i.test(p)).join('\n\n')}\n\n${CONT}`,
    });
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('revised');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBe(`Honest answer: I dropped it twice — the Double Checker confirms the drafter has been public since 09-06.\n\n${CONT}`);
    expect(upd.data.content).not.toMatch(/say the word/i);
    expect(upd.data.parts).toEqual([{ type: 'text', text: upd.data.content }]);
    expect(upd.data.metadata.followUps).toBeUndefined();
    expect(upd.data.metadata.task).toMatchObject({ taskId: 't1', status: 'running' }); // the card is untouched
  });

  it('FSN1021 review: a reconcile that echoes a row carrying the harness no-action line stays unchanged (compared like for like)', async () => {
    const NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
    const body = 'I have not made that change yet — nothing was changed in this answer.\n\nBoth actions are running in the background.';
    const noted = `${body}\n\n${NOTE}`;
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: noted, parts: [{ type: 'text', text: noted }] });
    const rewriteRevised = (c: string) => { const t = c.split(NOTE).join('').replace(/\n{3,}/g, '\n\n').trim(); return /in the background/.test(t) ? `${t}\n\n${NOTE}` : t; };
    const inp = input({ reconcile: jest.fn(async () => body), rewriteRevised, rewriteBaseline: true });
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('unchanged');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBeUndefined();
  });

  it('FSN1021 round 4: an ASYNC rewriteRevised (the receipt re-check) is awaited for both the revision and the baseline', async () => {
    const NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
    const body = 'Both actions are running in the background.';
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: `${body}\n\n${NOTE}`, parts: [{ type: 'text', text: `${body}\n\n${NOTE}` }] });
    // the re-check found an action since the turn: every copy goes, so the stored row's baseline is the bare body
    const rewriteRevised = jest.fn(async (c: string) => c.split(NOTE).join('').replace(/\n{3,}/g, '\n\n').trim());
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => 'Revised: the AGX lane was messaged by the checker.'), rewriteRevised, rewriteBaseline: true }));
    expect(out.outcome).not.toBe('unchanged');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(String(upd.data.content)).toContain('Revised:');
    expect(String(upd.data.content)).not.toContain('Harness check:');
    expect(rewriteRevised).toHaveBeenCalledTimes(2);
  });

  it('FSN1021 round 5: rewriteKeepsChips keeps the revision\'s own chips (only a continuation row drops them)', async () => {
    const reconciled = 'Ledger: 3 goals active (one reopened).\n\n[FOLLOWUPS]\n- Show the reopened goal\n[/FOLLOWUPS]';
    await runLateCrossCheck(input({ reconcile: jest.fn(async () => reconciled), rewriteRevised: async (c: string) => c, rewriteKeepsChips: true }));
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(String(upd.data.content)).toContain('Ledger: 3 goals active');
    expect(JSON.stringify(upd.data.metadata)).toContain('Show the reopened goal');
  });

  it('FSN1021 round 6: without rewriteBaseline the revision is compared with the raw stored row (pre-PR, plain-chat continuation rows)', async () => {
    const rewriteRevised = jest.fn(async (c: string) => c);
    await runLateCrossCheck(input({ reconcile: jest.fn(async () => 'Revised: something new.'), rewriteRevised }));
    expect(rewriteRevised).toHaveBeenCalledTimes(1); // the revision only — never the stored row
  });

  it('FSN1021 round 7: a revision that differs from the stored row ONLY by the harness line is unchanged — the line is the harness\'s decision, not a checker change', async () => {
    const NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
    const body = 'Both actions are running in the background.';
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: `${body}\n\n${NOTE}`, parts: [{ type: 'text', text: `${body}\n\n${NOTE}` }] });
    // the stored row keeps the line; the revision (the bare body) has none — they differ ONLY by the harness line
    const rewriteRevised = jest.fn(async (c: string) => c);
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => body), rewriteRevised, rewriteBaseline: true }));
    expect(out.outcome).toBe('unchanged');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBeUndefined();
  });

  it('FSN1021 round 8: outside note scope (no rewriteBaseline) a note-only difference is judged like any other change, as on main', async () => {
    const NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
    const body = 'Both actions are running in the background.';
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: `${body}\n\n${NOTE}`, parts: [{ type: 'text', text: `${body}\n\n${NOTE}` }] });
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => body) }));
    expect(out.outcome).not.toBe('unchanged');
  });

  // 2026-10-22 review (owner-turn live-state read): the unread-state line has its OWN comparison flag, so the
  // FSN1021 no-action switch keeps restoring the pre-FSN1021 comparison whatever the unread switch says.
  const UNREAD = 'Harness check: this answer states live status that was not read in this turn — treat it as unverified.';
  it('2026-10-22: unreadStateNoteless — a revision differing from the stored row ONLY by the unread-state line is unchanged (the line is the harness\'s decision)', async () => {
    const body = 'GLM-5.3 is deployed on spark-2.';
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: `${body}\n\n${UNREAD}`, parts: [{ type: 'text', text: `${body}\n\n${UNREAD}` }] });
    const rewriteRevised = jest.fn(async (c: string) => c.split(UNREAD).join('').trim());
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => body), rewriteRevised, rewriteKeepsChips: true, unreadStateNoteless: true }));
    expect(out.outcome).toBe('unchanged');
    expect(rewriteRevised).toHaveBeenCalledTimes(1); // the revision only — no rewriteBaseline, so the stored row is never rewritten
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.content).toBeUndefined();
  });

  it('2026-10-22: unreadStateNoteless never strips the FSN1021 no-action line — without rewriteBaseline (SUPERVISOR_NO_ACTION_NOTE_DISABLED=1) a no-action-only difference is judged like any change, as before', async () => {
    const NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
    const body = 'Both actions are running in the background.';
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW, content: `${body}\n\n${NOTE}`, parts: [{ type: 'text', text: `${body}\n\n${NOTE}` }] });
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => body), rewriteRevised: async (c: string) => c.split(UNREAD).join('').trim(), rewriteKeepsChips: true, unreadStateNoteless: true }));
    expect(out.outcome).not.toBe('unchanged');
  });

  it('unchanged: the reconcile re-flows the same answer → card only, no content write', async () => {
    const inp = input({ reconcile: jest.fn(async () => 'Honest answer:   I dropped it twice.') });
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('unchanged');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBeUndefined();
    expect(upd.data.metadata).toMatchObject({ pendingCrossCheck: false, crossCheck: expect.objectContaining({ outcome: 'unchanged' }) });
    expect(upd.data.metadata.revision).toBeUndefined();
  });

  it('conversation_moved: a newer row exists → the text is left alone, the card and outcome are attached', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-2' });
    const inp = input();
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('conversation_moved');
    expect(inp.reconcile).not.toHaveBeenCalled();
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBeUndefined();
    expect(upd.data.metadata).toMatchObject({ pendingCrossCheck: false, crossCheck: expect.objectContaining({ outcome: 'conversation_moved' }) });
  });

  it('no_draft: the checker produced nothing usable → its error card (if any) is attached and the flag cleared', async () => {
    const inp = input({ checkersPromise: Promise.resolve('') });
    inp.models.double_checker = { model: 'double_checker', response: '', time: 300000, error: 'cross-check deadline' };
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('no_draft');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.metadata.models.double_checker).toMatchObject({ error: 'cross-check deadline' });
    expect(upd.data.metadata.pendingCrossCheck).toBe(false);
  });

  it('timeout: the checker never resolves within the bound → flag cleared, outcome timeout, never throws', async () => {
    const inp = input({ checkersPromise: new Promise<string>(() => {}), maxWaitMs: 1_100, startedAt: Date.now() });
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('timeout');
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.pendingCrossCheck).toBe(false);
  });

  it('reconcile_failed: an empty reconcile → card only; a throwing prisma → flag still cleared, no throw', async () => {
    const inp = input({ reconcile: jest.fn(async () => '') });
    expect((await runLateCrossCheck(inp)).outcome).toBe('reconcile_failed');
    mockPrisma.crossModelMessage.findFirst.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW });
    const out = await runLateCrossCheck(input());
    expect(out.outcome).toBe('reconcile_failed');
  });

  it('reason attribution (firing 25): an empty reconcile stamps meta.reason "reconcile resolved empty"; a pre-started empty pass is distinguished; a thrown error carries its message', async () => {
    // fresh pass, empty result
    const empty = input({ reconcile: jest.fn(async () => '') });
    await runLateCrossCheck(empty);
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'crosscheck_late_reconcile',
      meta: expect.objectContaining({ outcome: 'reconcile_failed', reason: 'reconcile resolved empty' }),
    }));
    // pre-started pass, empty result — a different reason so the audit can tell them apart
    const preStarted = input({ preStartedReconcile: Promise.resolve('') });
    await runLateCrossCheck(preStarted);
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ outcome: 'reconcile_failed', reason: 'pre-started reconcile resolved empty' }),
    }));
    // thrown error — the catch path stamps the message (bounded to 200 chars)
    mockPrisma.crossModelMessage.findFirst.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW });
    await runLateCrossCheck(input());
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ outcome: 'reconcile_failed', reason: 'db down' }),
    }));
    // the persisted crossCheck card carries the reason too (the catch-path update is the LAST call)
    const cardUpdate = mockPrisma.crossModelMessage.update.mock.calls[mockPrisma.crossModelMessage.update.mock.calls.length - 1][0];
    expect(cardUpdate.data.metadata.crossCheck).toMatchObject({ outcome: 'reconcile_failed', reason: 'db down' });
    // and a healthy outcome stamps NO reason
    await runLateCrossCheck(input());
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.not.objectContaining({ reason: expect.anything() }),
    }));
  });
});

describe('pre-started reconcile (autonomy loop #4 — the inline pass outran its bound)', () => {
  it('awaits the handed-over pass instead of starting a second one, and revises from its result', async () => {
    const inp = input({
      checkersPromise: Promise.resolve('--- Double Checker ---\nlate draft'),
      preStartedReconcile: Promise.resolve('Reconciled by the pass the inline path started.\n\n[FOLLOWUPS]\n- Show the diff\n[/FOLLOWUPS]'),
    });
    const out = await runLateCrossCheck(inp);
    expect(out.outcome).toBe('revised');
    expect(inp.reconcile).not.toHaveBeenCalled();
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBe('Reconciled by the pass the inline path started.');
  });

  it('a pre-started pass that resolves empty reads as reconcile_failed — never a second pass', async () => {
    const inp = input({ preStartedReconcile: Promise.resolve('') });
    expect((await runLateCrossCheck(inp)).outcome).toBe('reconcile_failed');
    expect(inp.reconcile).not.toHaveBeenCalled();
  });
});

describe('drain accounting (2026-09-18 — the old colour used to be torn down mid-wait)', () => {
  it('an in-flight late reconcile counts as pending while it waits and clears on every exit', async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((res) => { release = res; });
    const inp = input({ checkersPromise: gate });
    const run = runLateCrossCheck(inp);
    await new Promise((r) => setImmediate(r));
    expect(pendingLateCrossCheckCount()).toBe(1);
    release('--- Double Checker ---\nlate draft');
    await run;
    expect(pendingLateCrossCheckCount()).toBe(0);
    // A vanished row exits early — and still clears.
    mockPrisma.crossModelMessage.findUnique.mockResolvedValueOnce(null);
    await runLateCrossCheck(input({ messageId: 'msg-gone' }));
    expect(pendingLateCrossCheckCount()).toBe(0);
  });

  it('abandonPendingLateCrossChecks (SIGTERM ritual) clears the flag on every in-flight row with an honest interrupted outcome', async () => {
    const never = new Promise<string>(() => {});
    void runLateCrossCheck(input({ messageId: 'msg-a', checkersPromise: never, maxWaitMs: 60_000, startedAt: Date.now() }));
    void runLateCrossCheck(input({ messageId: 'msg-b', checkersPromise: never, maxWaitMs: 60_000, startedAt: Date.now() }));
    await new Promise((r) => setImmediate(r));
    expect(pendingLateCrossCheckCount()).toBe(2);
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ metadata: { pendingCrossCheck: true, models: {} } });
    const n = await abandonPendingLateCrossChecks('deploy');
    expect(n).toBe(2);
    expect(pendingLateCrossCheckCount()).toBe(0);
    const updates = mockPrisma.crossModelMessage.update.mock.calls.map((c: any[]) => c[0]);
    expect(updates.map((u: any) => u.where.id).sort()).toEqual(['msg-a', 'msg-b']);
    for (const u of updates) {
      expect(u.data.metadata.pendingCrossCheck).toBe(false);
      expect(u.data.metadata.crossCheck).toMatchObject({ outcome: 'interrupted', reason: 'deploy' });
      expect(u.data.metadata.models).toEqual({}); // existing metadata preserved
    }
  });
});
