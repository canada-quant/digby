/**
 * build 2026-10-08 D-2 — the tool-intent journal (pending receipts + idempotency
 * keys, SHADOW). Pins the key, the outcome classification, the would-reconcile
 * verdicts and the replays of the incident shapes architecture.md item C names:
 *   · the deploy-requeue double send (ticket 5ba5f03e — "the from-scratch re-run
 *     duplicated them: double-sent messages, a lane ledger hand-corrected 130→74"):
 *     a chat turn re-fired with recoveryForMessageId = the SAME row re-issues its
 *     sends / todo_create calls → every one is a `skip_applied`, a NEW call is not;
 *   · the resumed coding run's PR re-open (audit #8: the in-flight turn is
 *     discarded at the checkpoint rewind; the re-issued open_pull_request 422'd)
 *     → `skip_applied` at the SAME step on the SAME agent_runs row; a git_push
 *     that was IN FLIGHT when the process died (pending row) → `reconcile_lookup`;
 *   · an at-most-once notify_user in flight → `unknown_never_resend`;
 *   · a re-applied key is ONE `executed_twice` row (the act bar is 0).
 * Shadow contract: begin()/finish() never throw, never await the DB, never
 * change a result; the switch / a guest session make the journal inert.
 */

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { TOOL_INTENT: 'tool_intent' },
}));

import {
  classifyIntentOutcome, createIntentJournal, intentIdemKey, intentScopeFor, isIntentJournalTool,
  toolIntentJournalDisabled, wouldReconcileVerdict, INTENT_JOURNAL_TOOLS, type IntentJournalDeps,
} from './tool-intents';
import { receiptInputHash } from './run-receipts';

/** An in-memory tool_intents table shared by every attempt of a test. */
function memoryDb() {
  const rows: Array<Record<string, any>> = [];
  const metrics: Array<Record<string, unknown>> = [];
  let clock = Date.parse('2026-10-08T20:00:00Z');
  const deps: Partial<IntentJournalDeps> = {
    insert: async (row) => { rows.push({ ...row, state: 'pending', createdAt: new Date(clock), wouldReconcile: null, priorIntentId: null }); },
    findPrior: async (idemKey, attemptId) => {
      const hits = rows.filter((r) => r.idemKey === idemKey && r.attemptId !== attemptId);
      return hits.length ? { id: hits[hits.length - 1].id, state: hits[hits.length - 1].state, createdAt: hits[hits.length - 1].createdAt } : null;
    },
    stampPrior: async (id, priorIntentId, verdict) => { Object.assign(rows.find((r) => r.id === id)!, { priorIntentId, wouldReconcile: verdict }); },
    settle: async (id, patch) => { Object.assign(rows.find((r) => r.id === id)!, patch); },
    metric: (meta) => { metrics.push(meta); },
    now: () => clock,
  };
  return { rows, metrics, deps, tick: (ms: number) => { clock += ms; } };
}

const settle = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };

const okEnvelope = (tool: string, ids: Record<string, unknown> = {}) => JSON.stringify({ ok: true, tool, ids, message: 'done' });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TOOL_INTENT_JOURNAL_DISABLED;
});

describe('tool-intent journal — pure pieces', () => {
  it('scope: worker runs key on the agent_runs row, chat turns on their anchor row, else the attempt alone', () => {
    expect(intentScopeFor({ sessionId: 'c1', runId: 'run-9', anchor: 'row-1', attemptId: 'a' })).toEqual({ scope: 'run:run-9', kind: 'run' });
    expect(intentScopeFor({ sessionId: 'c1', anchor: 'row-1', attemptId: 'a' })).toEqual({ scope: 'chat:c1:row-1', kind: 'chat_turn' });
    expect(intentScopeFor({ sessionId: 'c1', attemptId: 'a' })).toEqual({ scope: 'attempt:a', kind: 'attempt' });
  });

  it('the key is a stable 40-hex digest of scope + tool + canonical args + slot (arg order never matters)', () => {
    const h1 = receiptInputHash({ chatId: 'x', content: 'y' });
    const h2 = receiptInputHash({ content: 'y', chatId: 'x' });
    expect(h1).toBe(h2);
    const k = intentIdemKey('run:r', 'send_chat_message', h1, '3:0');
    expect(k).toMatch(/^[0-9a-f]{40}$/);
    expect(intentIdemKey('run:r', 'send_chat_message', h1, '3:1')).not.toBe(k);
    expect(intentIdemKey('run:r2', 'send_chat_message', h1, '3:0')).not.toBe(k);
  });

  it('covers the side-effecting tools only (reads and run_command are never journaled)', () => {
    for (const t of ['git_push', 'open_pull_request', 'merge_pull_request', 'send_chat_message', 'start_coding_session', 'notify_user', 'schedule_message', 'schedule_self', 'todo_create']) {
      expect(isIntentJournalTool(t)).toBe(true);
    }
    for (const t of ['get_chat_status', 'list_chats', 'run_command', 'read_file', 'update_plan']) expect(isIntentJournalTool(t)).toBe(false);
    expect(INTENT_JOURNAL_TOOLS.notify_user).toBe('at_most_once');
    expect(INTENT_JOURNAL_TOOLS.send_email_as_digby).toBe('at_most_once');
    expect(INTENT_JOURNAL_TOOLS.start_coding_session).toBe('lookup');
  });

  it('verdicts: applied twin → skip; in-flight twin → reconcile (lookup) or never-resend (at-most-once); failed / staged / replayed twin → re-run', () => {
    expect(wouldReconcileVerdict({ state: 'applied' }, 'lookup')).toBe('skip_applied');
    expect(wouldReconcileVerdict({ state: 'applied' }, 'at_most_once')).toBe('skip_applied');
    expect(wouldReconcileVerdict({ state: 'pending' }, 'lookup')).toBe('reconcile_lookup');
    expect(wouldReconcileVerdict({ state: 'unknown' }, 'at_most_once')).toBe('unknown_never_resend');
    for (const s of ['failed', 'staged', 'replayed']) expect(wouldReconcileVerdict({ state: s }, 'lookup')).toBeNull();
    expect(wouldReconcileVerdict(null, 'lookup')).toBeNull();
  });

  it('outcome classification reads the harness-authored result shapes', () => {
    // receipt tools — the receipt extractor's verdict
    expect(classifyIntentOutcome('send_chat_message', {}, okEnvelope('send_chat_message', { chatId: 'c2' }))).toBe('applied');
    expect(classifyIntentOutcome('send_chat_message', {}, JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf1' }))).toBe('staged');
    expect(classifyIntentOutcome('git_push', {}, 'Pushed digby/s-1 to GitHub (https://x) — sha abcdef1234567')).toBe('applied');
    expect(classifyIntentOutcome('git_push', {}, 'git push failed: rejected')).toBe('failed');
    expect(classifyIntentOutcome('open_pull_request', {}, 'Opened PR #42: https://github.com/o/r/pull/42')).toBe('applied');
    // the harness's own idempotency answered — a replay, never a second application
    expect(classifyIntentOutcome('git_push', {}, '[idempotent skip] already done in this run: Pushed digby/s-1 to GitHub — sha abc (receipt r1).')).toBe('replayed');
    expect(classifyIntentOutcome('start_coding_session', {}, JSON.stringify({ ok: true, tool: 'start_coding_session', ids: { sessionId: 's' }, deduplicated: { firstAt: 'x' } }))).toBe('replayed');
    expect(classifyIntentOutcome('merge_pull_request', {}, 'PR o/r#9 is ALREADY merged (sha abc)')).toBe('replayed');
    expect(classifyIntentOutcome('schedule_self', {}, 'An IDENTICAL enabled recurring schedule already exists (id s1) — no duplicate was created; this returns the existing one')).toBe('replayed');
    // the loop's hard timeout — the effect may still land
    expect(classifyIntentOutcome('send_chat_message', {}, 'Tool "send_chat_message" exceeded 900s and was aborted. Do not retry it; proceed with what you have.')).toBe('unknown');
    // non-receipt tools — the envelope's ok flag, else the loop's failure verdict
    expect(classifyIntentOutcome('notify_user', {}, okEnvelope('notify_user'))).toBe('applied');
    expect(classifyIntentOutcome('notify_user', {}, JSON.stringify({ ok: false, tool: 'notify_user', reason: 'not_configured' }))).toBe('failed');
    expect(classifyIntentOutcome('schedule_self', {}, '⚠️ schedule_self FAILED — no schedule was created. bad', true)).toBe('failed');
    expect(classifyIntentOutcome('schedule_self', {}, 'Scheduled every 30 min (id s9).', false)).toBe('applied');
  });

  it('switch: TOOL_INTENT_JOURNAL_DISABLED=1 (or a guest / chatless session) makes the journal inert', () => {
    process.env.TOOL_INTENT_JOURNAL_DISABLED = '1';
    expect(toolIntentJournalDisabled()).toBe(true);
    const insert = jest.fn(async () => undefined);
    const off = createIntentJournal({ sessionId: 'chat-1', runId: 'r1', deps: { insert } });
    expect(off.enabled).toBe(false);
    expect(off.begin('send_chat_message', { chatId: 'c' }, 0)).toBeNull();
    delete process.env.TOOL_INTENT_JOURNAL_DISABLED;
    expect(createIntentJournal({ sessionId: 'anon-abc', deps: { insert } }).begin('send_chat_message', {}, 0)).toBeNull();
    expect(createIntentJournal({ sessionId: 'chatless-u1', deps: { insert } }).begin('send_chat_message', {}, 0)).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it('never throws and never waits: a failing DB still hands back a key', async () => {
    const j = createIntentJournal({ sessionId: 'chat-1', runId: 'r1', deps: { insert: () => { throw new Error('db down'); } } });
    const h = j.begin('send_chat_message', { chatId: 'c', content: 'x' }, 2);
    expect(h?.idemKey).toMatch(/^[0-9a-f]{40}$/);
    expect(() => j.finish(h, okEnvelope('send_chat_message'))).not.toThrow();
    await flush();
    // the default deps against a client without the model reject — swallowed too
    const k = createIntentJournal({ sessionId: 'chat-1', runId: 'r1' });
    expect(k.begin('notify_user', { message: 'hi' }, 0)).not.toBeNull();
    await flush();
  });
});

describe('tool-intent journal — incident replays (shadow: verdicts recorded, nothing skipped)', () => {
  it('ticket 5ba5f03e — a deploy re-fired chat turn re-issues its applied sends: each is skip_applied; a NEW call is not', async () => {
    const db = memoryDb();
    // Attempt 1: the supervisor turn answering user row "row-77" sends two lane nudges + one todo, then the deploy kills it.
    const a1 = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-77', deps: db.deps });
    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['send_chat_message', { chatId: 'lane-a', content: 'pick up todo 4' }, okEnvelope('send_chat_message', { chatId: 'lane-a' })],
      ['send_chat_message', { chatId: 'lane-b', content: 'rebase on main' }, okEnvelope('send_chat_message', { chatId: 'lane-b' })],
      ['todo_create', { goalId: 'g1', title: 'Fix the ledger' }, 'Created todo 0f1e2d3c-1111-2222-3333-444455556666 "Fix the ledger"'],
    ];
    for (const [tool, args, result] of calls) a1.finish(a1.begin(tool, args, 1), result);
    await flush();
    expect(db.rows.map((r) => r.state)).toEqual(['applied', 'applied', 'applied']);
    expect(db.metrics).toHaveLength(0);

    // Attempt 2: orphan-recovery re-fires the SAME row (recoveryForMessageId) — the run restarts from step 0.
    db.tick(90_000);
    const a2 = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-77', deps: db.deps });
    expect(a2.scope).toBe(a1.scope);
    const handles = calls.map(([tool, args]) => a2.begin(tool, args, 0));
    // the keys are attempt-independent
    expect(handles.map((h) => h!.idemKey)).toEqual(db.rows.slice(0, 3).map((r) => r.idemKey));
    const fresh = a2.begin('send_chat_message', { chatId: 'lane-c', content: 'new work' }, 3);
    await flush();
    const verdicts = db.metrics.filter((m) => m.phase === 'would_reconcile');
    expect(verdicts.map((m) => [m.tool, m.verdict])).toEqual([
      ['send_chat_message', 'skip_applied'], ['send_chat_message', 'skip_applied'], ['todo_create', 'skip_applied'],
    ]);
    expect(verdicts.every((m) => m.scopeKind === 'chat_turn' && m.priorState === 'applied' && m.priorAgeMs === 90_000)).toBe(true);
    expect(db.rows.find((r) => r.idemKey === fresh!.idemKey && r.attemptId === a2.attemptId)?.wouldReconcile).toBeNull();

    // Shadow: the re-issued calls still RUN — and re-applying a key is the executed_twice row the act bar counts.
    calls.forEach(([, , result], i) => a2.finish(handles[i], result));
    await flush();
    expect(db.metrics.filter((m) => m.phase === 'executed_twice').map((m) => m.tool)).toEqual(['send_chat_message', 'send_chat_message', 'todo_create']);
  });

  it('the same message sent twice ON PURPOSE in one turn is two slots, never a duplicate', async () => {
    const db = memoryDb();
    const j = createIntentJournal({ sessionId: 'sup-1', anchor: 'row-1', deps: db.deps });
    const h1 = j.begin('send_chat_message', { chatId: 'lane-a', content: 'ping' }, 0);
    const h2 = j.begin('send_chat_message', { chatId: 'lane-a', content: 'ping' }, 4);
    expect(h1!.slot).toBe('0');
    expect(h2!.slot).toBe('1');
    expect(h1!.idemKey).not.toBe(h2!.idemKey);
    j.finish(h1, okEnvelope('send_chat_message'));
    j.finish(h2, okEnvelope('send_chat_message'));
    await flush();
    expect(db.metrics).toHaveLength(0);
  });

  it('audit #8 — a resumed coding run re-issues its PR at the checkpoint step: skip_applied; the push in flight at the kill: reconcile_lookup', async () => {
    const db = memoryDb();
    // Attempt 1 (agent_runs row run-42): step 7 opens the PR (applied); step 9 starts git_push and the worker dies mid-call.
    const a1 = createIntentJournal({ sessionId: 'lane-1', runId: 'run-42', deps: db.deps });
    a1.finish(a1.begin('open_pull_request', { title: 'fix: ledger', base: 'main' }, 7), 'Opened PR #1339: https://github.com/o/r/pull/1339');
    a1.begin('git_push', {}, 9); // never settled — the process died
    await flush();
    expect(db.rows.map((r) => [r.tool, r.state, r.slot])).toEqual([['open_pull_request', 'applied', '7:0'], ['git_push', 'pending', '9:0']]);

    // Attempt 2: the worker re-claims the SAME row; the checkpoint rewind re-enters step 7 / step 9.
    const a2 = createIntentJournal({ sessionId: 'lane-1', runId: 'run-42', deps: db.deps });
    a2.begin('open_pull_request', { base: 'main', title: 'fix: ledger' }, 7);
    a2.begin('git_push', {}, 9);
    a2.begin('git_push', {}, 10); // a later step's push is new work
    await flush();
    const v = db.metrics.filter((m) => m.phase === 'would_reconcile').map((m) => [m.tool, m.verdict, m.slot, m.scopeKind]);
    expect(v).toEqual([
      ['open_pull_request', 'skip_applied', '7:0', 'run'],
      ['git_push', 'reconcile_lookup', '9:0', 'run'],
    ]);
  });

  it('an at-most-once push (notify_user) in flight at the kill: unknown_never_resend', async () => {
    const db = memoryDb();
    const a1 = createIntentJournal({ sessionId: 'sup-2', anchor: 'wake-5', deps: db.deps });
    a1.begin('notify_user', { message: 'PR #12 merged' }, 2);
    await flush();
    const a2 = createIntentJournal({ sessionId: 'sup-2', anchor: 'wake-5', deps: db.deps });
    a2.begin('notify_user', { message: 'PR #12 merged' }, 0);
    await flush();
    expect(db.metrics.find((m) => m.phase === 'would_reconcile')).toMatchObject({ tool: 'notify_user', verdict: 'unknown_never_resend', priorState: 'pending' });
  });

  it('a twin that FAILED or was STAGED is re-run legitimately — no verdict, no executed_twice', async () => {
    const db = memoryDb();
    const a1 = createIntentJournal({ sessionId: 'c9', anchor: 'row-9', deps: db.deps });
    a1.finish(a1.begin('start_coding_session', { projectId: 'p', prompt: 'x' }, 0), JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf' }));
    a1.finish(a1.begin('schedule_message', { prompt: 'daily' }, 0), 'Tool schedule_message failed: boom', );
    await flush();
    expect(db.rows.map((r) => r.state)).toEqual(['staged', 'failed']);
    const a2 = createIntentJournal({ sessionId: 'c9', anchor: 'row-9', deps: db.deps });
    a2.finish(a2.begin('start_coding_session', { projectId: 'p', prompt: 'x' }, 0), okEnvelope('start_coding_session', { sessionId: 's1' }));
    a2.finish(a2.begin('schedule_message', { prompt: 'daily' }, 0), okEnvelope('schedule_message', { scheduleId: 'sc1' }));
    await flush();
    expect(db.metrics).toHaveLength(0);
  });

  it('an attempt with no stable anchor never looks for twins (nothing to match across attempts)', async () => {
    const db = memoryDb();
    const findPrior = jest.fn(db.deps.findPrior!);
    const j = createIntentJournal({ sessionId: 'c1', deps: { ...db.deps, findPrior } });
    expect(j.scopeKind).toBe('attempt');
    j.begin('send_chat_message', { chatId: 'x' }, 0);
    await flush();
    expect(findPrior).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
  });
});
