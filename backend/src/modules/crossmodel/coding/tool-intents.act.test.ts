/**
 * build 2026-10-11 DL-2 — the tool-intent journal's ACT step (owner: "turn
 * everything remaining on"). Replays of the incident shapes the journal was
 * built for, now with act deciding whether the call RUNS:
 *   · ticket 5ba5f03e — a deploy-requeued chat turn (same anchor row) re-issues
 *     the send_chat_message an earlier attempt already applied → NOT re-run;
 *     the answer cites the earlier receipt; the row settles `replayed`; there is
 *     no executed_twice row;
 *   · audit #8 — a resumed coding run (same agent_runs row) re-issues git_push
 *     at the checkpoint step: skipped only while the worktree HEAD is still the
 *     sha that push carried (new commits ⇒ a real push);
 *   · an at-most-once notify_user in flight at the kill → NOT resent; a repeat
 *     call in the same attempt (a new slot) IS sent;
 *   · a different input hash, a failed / staged twin, no key → the call runs;
 *   · an in-flight spawn the delegation ledger recorded under the key → not
 *     re-run (skip_reconciled); no ledger row → runs; PR / push / merge in
 *     flight → the handler's own receipt read; no lookup → runs;
 *   · TOOL_INTENT_ACT_DISABLED=1 → the shadow journal byte-for-byte.
 * Every decision with a twin is a loop_metrics tool_intent phase `act` row.
 */

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { TOOL_INTENT: 'tool_intent' },
}));

import {
  choosePriorIntent, createIntentJournal, renderSkipApplied, renderWithheld, toolIntentActDisabled,
  INTENT_ACT_WAIT_MS, type IntentJournalDeps,
} from './tool-intents';
import type { ToolReceipt } from './run-receipts';

const RECEIPT_ID = '7d0c2f4e-9b1a-4c3d-8e5f-6a7b8c9d0e1f';

/** In-memory tool_intents + receipts + ledger shared by every attempt of a test (the PRODUCTION chooser picks the twin). */
function memoryDb(opts: { receipts?: ToolReceipt[]; tasks?: Array<{ idempotencyKey: string; id: string; kind: string; state: string; childChatId: string | null }>; head?: { sha: string | null; branch: string | null } } = {}) {
  const rows: Array<Record<string, any>> = [];
  const metrics: Array<Record<string, any>> = [];
  let clock = Date.parse('2026-10-11T09:00:00Z');
  const receipts = opts.receipts ?? [];
  const tasks = opts.tasks ?? [];
  const headOf = jest.fn(async () => opts.head ?? { sha: null, branch: null });
  const deps: Partial<IntentJournalDeps> = {
    insert: async (row) => { rows.push({ ...row, state: 'pending', createdAt: new Date(clock), completedAt: null, receiptId: null }); },
    findPrior: async (idemKey, attemptId) => choosePriorIntent(rows.filter((r) => r.idemKey === idemKey && r.attemptId !== attemptId).reverse() as any) as any,
    stampPrior: async (id, priorIntentId, verdict) => { Object.assign(rows.find((r) => r.id === id)!, { priorIntentId, wouldReconcile: verdict }); },
    settle: async (id, patch) => { Object.assign(rows.find((r) => r.id === id)!, patch); },
    metric: (meta) => { metrics.push(meta); },
    now: () => clock,
    loadReceipt: async (id) => receipts.find((r) => r.id === id) ?? null,
    findTaskByKey: async (key) => tasks.find((t) => t.idempotencyKey === key) ?? null,
    headOf,
  };
  return { rows, metrics, deps, headOf, tick: (ms: number) => { clock += ms; } };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const okSend = (chatId: string) => JSON.stringify({ ok: true, tool: 'send_chat_message', ids: { chatId }, message: `Message queued in chat ${chatId}.` });
const receipt = (over: Partial<ToolReceipt>): ToolReceipt => ({
  id: RECEIPT_ID, chatId: 'sup-1', runId: null, tool: 'send_chat_message', ok: true, ids: { chatId: 'lane-a' },
  inputHash: null, outputHash: null, createdAt: new Date('2026-10-11T09:00:01Z'), ...over,
});

/** Attempt 1 runs `calls`, each settled with its result (a null result = in flight when the process died). */
async function firstAttempt(db: ReturnType<typeof memoryDb>, o: { sessionId: string; runId?: string; anchor?: string }, calls: Array<[string, Record<string, unknown>, number, string | null, string | null]>) {
  const a1 = createIntentJournal({ ...o, deps: db.deps });
  for (const [tool, args, step, result, receiptId] of calls) {
    const h = a1.begin(tool, args, step);
    if (result !== null) a1.finish(h, result, { receiptId });
  }
  await flush();
  return a1;
}

beforeEach(() => {
  delete process.env.TOOL_INTENT_ACT_DISABLED;
  delete process.env.TOOL_INTENT_JOURNAL_DISABLED;
});

describe('DL-2 act — pure pieces', () => {
  it('the switch defaults ON; TOOL_INTENT_ACT_DISABLED=1 turns it off', () => {
    expect(toolIntentActDisabled({})).toBe(false);
    expect(toolIntentActDisabled({ TOOL_INTENT_ACT_DISABLED: '1' })).toBe(true);
  });

  it('choosePriorIntent: an APPLIED twin wins over a later replayed / withheld row; else the newest', () => {
    expect(choosePriorIntent([{ id: 'r3', state: 'replayed' }, { id: 'r1', state: 'applied' }])?.id).toBe('r1');
    expect(choosePriorIntent([{ id: 'w2', state: 'withheld' }, { id: 'p1', state: 'pending' }])?.id).toBe('w2');
    expect(choosePriorIntent([])).toBeNull();
  });

  it('the skip answer names the time + receipt and is a replay everywhere it is read; the withheld answer names where to verify', () => {
    const t = renderSkipApplied('send_chat_message', { id: 'i1', state: 'applied', createdAt: new Date('2026-10-11T09:00:00Z'), completedAt: new Date('2026-10-11T09:00:02Z') }, receipt({}));
    expect(t).toMatch(/^\[idempotent skip\] send_chat_message already applied at 2026-10-11T09:00:02\.000Z — receipt 7d0c2f4e-9b1a-4c3d-8e5f-6a7b8c9d0e1f; not re-run\./);
    expect(t).toContain('ids {"chatId":"lane-a"}');
    const w = renderWithheld('notify_user', { id: 'i1', state: 'pending', createdAt: new Date('2026-10-11T09:00:00Z') });
    expect(w).toMatch(/^\[intent withheld\] notify_user NOT re-sent/);
    expect(w).toContain('Verify with the user');
  });
});

describe('DL-2 act — incident replays', () => {
  it('ticket 5ba5f03e — a deploy-requeued chat turn re-attempting send_chat_message with the same key is SKIPPED with the earlier receipt', async () => {
    const db = memoryDb({ receipts: [receipt({})] });
    await firstAttempt(db, { sessionId: 'sup-1', anchor: 'row-77' }, [
      ['send_chat_message', { chatId: 'lane-a', content: 'pick up todo 4' }, 1, okSend('lane-a'), RECEIPT_ID],
    ]);
    db.tick(90_000);
    // The deploy requeue re-fires the SAME user row: a new attempt, same anchor.
    const a2 = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-77', deps: db.deps });
    const h = a2.begin('send_chat_message', { content: 'pick up todo 4', chatId: 'lane-a' }, 0);
    const act = await a2.act(h);
    expect(act.skip).toBe(true);
    expect(act.decision).toBe('skip_applied');
    expect(act.result).toContain(`receipt ${RECEIPT_ID}; not re-run`);
    expect(act.carriedReceipt?.id).toBe(RECEIPT_ID);
    a2.finish(h, act.result, { state: act.settleAs, receiptId: RECEIPT_ID });
    await flush();
    expect(db.rows.map((r) => r.state)).toEqual(['applied', 'replayed']);
    const m = db.metrics.filter((x) => x.phase === 'act');
    expect(m).toEqual([expect.objectContaining({ decision: 'skip_applied', tool: 'send_chat_message', priorState: 'applied', receiptId: RECEIPT_ID, priorAgeMs: 90_000, scopeKind: 'chat_turn' })]);
    expect(m[0].priorIntentId).toBe(db.rows[0].id);
    expect(db.metrics.some((x) => x.phase === 'executed_twice')).toBe(false);

    // A THIRD attempt (another requeue) still finds the applied row behind the replay — still skipped.
    const a3 = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-77', deps: db.deps });
    expect((await a3.act(a3.begin('send_chat_message', { chatId: 'lane-a', content: 'pick up todo 4' }, 0))).decision).toBe('skip_applied');
  });

  it('a different input hash executes (a new message to the same lane is new work)', async () => {
    const db = memoryDb({ receipts: [receipt({})] });
    await firstAttempt(db, { sessionId: 'sup-1', anchor: 'row-77' }, [
      ['send_chat_message', { chatId: 'lane-a', content: 'pick up todo 4' }, 1, okSend('lane-a'), RECEIPT_ID],
    ]);
    const a2 = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-77', deps: db.deps });
    const act = await a2.act(a2.begin('send_chat_message', { chatId: 'lane-a', content: 'pick up todo 5 instead' }, 0));
    expect(act).toEqual({ skip: false, decision: 'run_no_prior' });
    expect(db.metrics.filter((x) => x.phase === 'act')).toHaveLength(0);
  });

  it('defensive: a twin whose recorded input hash differs never skips (run_input_mismatch)', async () => {
    const db = memoryDb();
    const deps = { ...db.deps, findPrior: async () => ({ id: 'old', state: 'applied', createdAt: new Date(), inputHash: 'not-this-hash' }) };
    const j = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-1', deps });
    const act = await j.act(j.begin('todo_create', { title: 'x' }, 0));
    expect(act.decision).toBe('run_input_mismatch');
    expect(act.skip).toBe(false);
  });

  it('audit #8 — a resumed run re-issuing git_push at the checkpoint step: skipped at the SAME HEAD sha, executed once HEAD moved', async () => {
    const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const pushReceipt = receipt({ tool: 'git_push', chatId: 'lane-1', runId: 'run-42', ids: { branch: 'digby/s-1', sha: SHA } });
    const same = memoryDb({ receipts: [pushReceipt], head: { sha: SHA, branch: 'digby/s-1' } });
    await firstAttempt(same, { sessionId: 'lane-1', runId: 'run-42' }, [['git_push', {}, 9, `Pushed digby/s-1 to GitHub (https://x) — sha ${SHA}`, RECEIPT_ID]]);
    const a2 = createIntentJournal({ sessionId: 'lane-1', runId: 'run-42', deps: same.deps });
    const act = await a2.act(a2.begin('git_push', {}, 9), { worktree: '/wt/lane-1' });
    expect(act.decision).toBe('skip_applied');
    expect(act.result).toContain(`receipt ${RECEIPT_ID}`);
    expect(act.result).toContain(`"sha":"${SHA}"`);
    expect(same.headOf).toHaveBeenCalledWith('/wt/lane-1');

    const moved = memoryDb({ receipts: [pushReceipt], head: { sha: 'ffffffffffffffffffffffffffffffffffffffff', branch: 'digby/s-1' } });
    await firstAttempt(moved, { sessionId: 'lane-1', runId: 'run-42' }, [['git_push', {}, 9, `Pushed digby/s-1 to GitHub (https://x) — sha ${SHA}`, RECEIPT_ID]]);
    const b2 = createIntentJournal({ sessionId: 'lane-1', runId: 'run-42', deps: moved.deps });
    const actMoved = await b2.act(b2.begin('git_push', {}, 9), { worktree: '/wt/lane-1' });
    expect(actMoved).toEqual({ skip: false, decision: 'run_precondition' });
    expect(moved.metrics.find((m) => m.phase === 'act')).toMatchObject({ decision: 'run_precondition', why: 'head_moved' });

    // No worktree (a chat run) / no sha on the receipt → the push runs (its handler's own receipt guard still applies).
    const c2 = createIntentJournal({ sessionId: 'lane-1', runId: 'run-42', deps: same.deps });
    expect((await c2.act(c2.begin('git_push', {}, 9))).decision).toBe('run_precondition');
  });

  it('a PR re-open is left to its handler (it re-reads the PR head); a push / merge in flight → the handler lookup', async () => {
    const db = memoryDb();
    await firstAttempt(db, { sessionId: 'lane-1', runId: 'run-42' }, [
      ['open_pull_request', { title: 'fix: ledger', base: 'main' }, 7, 'Opened PR #1339: https://github.com/o/r/pull/1339', null],
      ['merge_pull_request', { prNumber: 1339 }, 8, null, null],
    ]);
    const a2 = createIntentJournal({ sessionId: 'lane-1', runId: 'run-42', deps: db.deps });
    expect((await a2.act(a2.begin('open_pull_request', { base: 'main', title: 'fix: ledger' }, 7))).decision).toBe('run_handler_lookup');
    expect((await a2.act(a2.begin('merge_pull_request', { prNumber: 1339 }, 8))).decision).toBe('run_handler_lookup');
  });

  it('an at-most-once notify_user in flight at the kill is NOT resent; a repeat call in the same attempt (a new slot) is sent', async () => {
    const db = memoryDb();
    await firstAttempt(db, { sessionId: 'sup-2', anchor: 'wake-5' }, [['notify_user', { message: 'PR #12 merged' }, 2, null, null]]);
    const a2 = createIntentJournal({ sessionId: 'sup-2', anchor: 'wake-5', deps: db.deps });
    const h = a2.begin('notify_user', { message: 'PR #12 merged' }, 0);
    const act = await a2.act(h);
    expect(act.skip).toBe(true);
    expect(act.decision).toBe('withheld');
    expect(act.result).toMatch(/^\[intent withheld\] notify_user NOT re-sent/);
    a2.finish(h, act.result, { state: act.settleAs });
    await flush();
    expect(db.rows.map((r) => r.state)).toEqual(['pending', 'withheld']);
    // the model verified and calls again: a new slot, no twin → sent
    expect((await a2.act(a2.begin('notify_user', { message: 'PR #12 merged' }, 3))).decision).toBe('run_no_prior');
    // a third attempt still sees an unknown outcome (pending / withheld) → withheld again
    const a3 = createIntentJournal({ sessionId: 'sup-2', anchor: 'wake-5', deps: db.deps });
    expect((await a3.act(a3.begin('notify_user', { message: 'PR #12 merged' }, 0))).decision).toBe('withheld');
  });

  it('a twin that FAILED or was STAGED runs again (run_prior_not_applied)', async () => {
    const db = memoryDb();
    await firstAttempt(db, { sessionId: 'c9', anchor: 'row-9' }, [
      ['start_coding_session', { projectId: 'p', prompt: 'x' }, 0, JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf' }), null],
      ['schedule_message', { prompt: 'daily' }, 0, 'Tool schedule_message failed: boom', null],
    ]);
    expect(db.rows.map((r) => r.state)).toEqual(['staged', 'failed']);
    const a2 = createIntentJournal({ sessionId: 'c9', anchor: 'row-9', deps: db.deps });
    expect(await a2.act(a2.begin('start_coding_session', { projectId: 'p', prompt: 'x' }, 0))).toEqual({ skip: false, decision: 'run_prior_not_applied' });
    expect(await a2.act(a2.begin('schedule_message', { prompt: 'daily' }, 0))).toEqual({ skip: false, decision: 'run_prior_not_applied' });
  });

  it('a spawn in flight at the kill: the ledger task under the key proves it applied (skip_reconciled); no task → it runs', async () => {
    const db = memoryDb();
    const a1 = await firstAttempt(db, { sessionId: 'sup-3', anchor: 'row-3' }, [
      ['start_coding_session', { projectId: 'p', prompt: 'build it' }, 0, null, null],
      ['send_chat_message', { chatId: 'lane-z', content: 'go' }, 0, null, null],
    ]);
    expect(a1.scopeKind).toBe('chat_turn');
    const key = db.rows[0].idemKey;
    (db.deps as any).findTaskByKey = async (k: string) => (k === key ? { id: 'task-0001', kind: 'session', state: 'working', childChatId: 'child-9' } : null);
    const a2 = createIntentJournal({ sessionId: 'sup-3', anchor: 'row-3', deps: db.deps });
    const spawn = await a2.act(a2.begin('start_coding_session', { projectId: 'p', prompt: 'build it' }, 0));
    expect(spawn.skip).toBe(true);
    expect(spawn.decision).toBe('skip_reconciled');
    expect(spawn.result).toContain('delegation task task-0001 (chat child-9) exists (state working); not re-run');
    expect((await a2.act(a2.begin('send_chat_message', { chatId: 'lane-z', content: 'go' }, 0))).decision).toBe('run_lookup_miss');
  });

  it('a lookup tool with no read-back in flight runs as today (run_no_lookup)', async () => {
    const db = memoryDb();
    await firstAttempt(db, { sessionId: 'sup-4', anchor: 'row-4' }, [['todo_create', { goalId: 'g', title: 't' }, 0, null, null]]);
    const a2 = createIntentJournal({ sessionId: 'sup-4', anchor: 'row-4', deps: db.deps });
    expect((await a2.act(a2.begin('todo_create', { goalId: 'g', title: 't' }, 0))).decision).toBe('run_no_lookup');
  });

  it('an attempt-only scope, a missing handle and the switch never skip — and never wait', async () => {
    const db = memoryDb();
    const findPrior = jest.fn(db.deps.findPrior!);
    const loose = createIntentJournal({ sessionId: 'c1', deps: { ...db.deps, findPrior } });
    expect((await loose.act(loose.begin('send_chat_message', { chatId: 'x' }, 0))).decision).toBe('run_off');
    expect(await loose.act(null)).toEqual({ skip: false, decision: 'run_off' });

    await firstAttempt(db, { sessionId: 'sup-1', anchor: 'row-1' }, [['send_chat_message', { chatId: 'lane-a', content: 'x' }, 0, okSend('lane-a'), null]]);
    process.env.TOOL_INTENT_ACT_DISABLED = '1';
    const off = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-1', deps: db.deps });
    const h = off.begin('send_chat_message', { chatId: 'lane-a', content: 'x' }, 0);
    expect(await off.act(h)).toEqual({ skip: false, decision: 'run_off' });
    off.finish(h, okSend('lane-a'));
    await flush();
    // shadow, byte-for-byte: the verdict is recorded and re-applying is the executed_twice row
    expect(db.metrics.map((m) => m.phase)).toEqual(['would_reconcile', 'executed_twice']);
  });

  it('a lookup that never answers runs the tool after the bounded wait (run_lookup_timeout)', async () => {
    jest.useFakeTimers();
    try {
      const metrics: any[] = [];
      const j = createIntentJournal({
        sessionId: 'sup-1', anchor: 'row-1',
        deps: { insert: () => new Promise(() => undefined), findPrior: async () => null, stampPrior: async () => undefined, settle: async () => undefined, metric: (m) => { metrics.push(m); }, now: () => 0 },
      });
      const p = j.act(j.begin('send_chat_message', { chatId: 'x' }, 0));
      await jest.advanceTimersByTimeAsync(INTENT_ACT_WAIT_MS);
      expect(await p).toEqual({ skip: false, decision: 'run_lookup_timeout' });
      expect(metrics).toEqual([expect.objectContaining({ phase: 'act', decision: 'run_lookup_timeout' })]);
    } finally {
      jest.useRealTimers();
    }
  });
});
