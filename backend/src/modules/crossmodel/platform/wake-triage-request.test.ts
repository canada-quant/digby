/**
 * wake-triage-request.ts (E7, 2026-09-25) — the v2 fan-out over code-computed
 * state (prose last and capped), the code flags, the shadow would-park readout
 * with per-option thresholds, and the decision-time code-flag labels.
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));
jest.mock('../model-endpoints/model-roles.service', () => ({ resolveRoleModel: jest.fn(async () => 'jev'), resolveRoleFallback: jest.fn(async () => '') }));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));

import axios from 'axios';
import { recordLoopMetric } from './loop-metrics.service';
import { clearDecisionBackendCache, clearDecisionMemo, decide } from './decision-gate';
import { clearDecisionModeCache } from './decision-gate-modes';
import {
  NEEDS_TURN_NOW_QUESTION, WAKE_TRIAGE_PROSE_CAP, WAKE_TRIAGE_V2_QUESTIONS,
  buildWakeTriageRequest, buildWakeTriageRequestV2, wakeTriageAnsweredKeys, wakeTriageCodeFlags,
  wakeTriageCodeLabels, wakeTriageEventIds, wakeTriageMemoable, wakeTriageSourceIds, wakeTriageV2Note, wakeTriageV2WouldPark,
} from './wake-triage-request';

const ENV = ['DECISION_GATE_THRESHOLD_WAKE_TRIAGE', 'DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ACK', 'DECISION_GATE_THRESHOLD_WAKE_TRIAGE_COALESCE',
  'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_MODE_WAKE_TRIAGE', 'TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const NOW = Date.parse('2026-09-25T12:00:00Z');
const row = (summary: string, over: Record<string, unknown> = {}) => ({
  id: 'e', eventType: 'run_completed', createdAt: new Date(NOW - 5 * 60_000),
  payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Lane', summary, depth: 0 },
  ...over,
});
const preview = (summary = 'Run finished fine') => ({ eventType: 'run_completed', sourceChatTitle: 'Lane', summary });

describe('the request — the v2 fan-out; needs_turn_now keeps the pinned noul text', () => {
  it('buildWakeTriageRequest builds the v2 shape; the needs_turn_now noul text is pinned', () => {
    expect(buildWakeTriageRequest({ target: 'supervised chat', rows: [row('a')], preview: preview(), lanes: null }).shape).toBe('v2');
    expect(WAKE_TRIAGE_V2_QUESTIONS.needs_turn_now).toBe(NEEDS_TURN_NOW_QUESTION);
    expect(NEEDS_TURN_NOW_QUESTION).toEqual({
      type: 'noul',
      instructions: 'This event batch requires the supervisor to act NOW (decide, dispatch, reply, escalate, unblock or investigate) rather than being an informational report-up or routine completion notice that can wait for the next scheduled sweep.',
      criteria: {
        true: 'a failure or error, a question or request addressed to the supervisor, a blocked or stuck lane, an owner-facing decision, or work that must be dispatched now',
        false: 'a routine completion, a status or progress report, an acknowledgement, or duplicate / informational chatter with no action for the supervisor',
      },
    });
  });
});

describe('v2 request — code-computed fields first, lane facts, prose LAST and capped', () => {
  it('carries the event-kind histogram, the flags, distinct sources, ages, the lanes, and ends with summary ≤ 4000', () => {
    const rows = [
      row('Run finished fine'),
      row('Please approve the merge of #12?', { eventType: 'todo_done', payload: { eventType: 'todo_done', sourceChatId: 'c-two', sourceChatTitle: 'Two', summary: 'Please approve the merge of #12?', depth: 0 }, createdAt: new Date(NOW - 65 * 60_000) }),
    ];
    const lanes = [{ chat_id: 'c-src', coding_status: 'ready', last_run: { status: 'completed', ended_min_ago: 4, error_head: null } }];
    const r = buildWakeTriageRequestV2({ target: 'project supervisor chat', rows, preview: preview('y'.repeat(5000)), lanes, now: NOW });
    expect(r.shape).toBe('v2');
    const keys = Object.keys(r.state);
    expect(keys[0]).toBe('target');
    expect(keys[keys.length - 1]).toBe('summary');
    expect(keys.indexOf('event_kinds')).toBeLessThan(keys.indexOf('source_lanes'));
    expect(r.state).toMatchObject({
      target: 'project supervisor chat', events: 2, event_type: 'run_completed',
      event_kinds: { run_completed: 1, todo_done: 1 },
      any_row_is_question_or_request: true,
      any_row_addressed_to_supervisor: false,
      any_row_reports_failure_or_block: false,
      any_row_guard_replaced_final: false,
      any_row_owner_facing: false,
      distinct_sources: 2,
      oldest_event_age_min: 65,
      newest_event_age_min: 5,
      source_chat: 'Lane',
      source_lanes: lanes,
    });
    expect((r.state.summary as string).length).toBe(WAKE_TRIAGE_PROSE_CAP);
    expect(Object.keys(r.questions)).toEqual(['needs_turn_now', 'disposition', 'addressed_to_supervisor', 'contains_failure_or_block', 'urgency']);
    expect(r.questions.disposition).toMatchObject({ type: 'choice', criteria: { ack: expect.any(String), coalesce: expect.any(String), act_now: expect.any(String), escalate_owner: expect.any(String) } });
    expect((r.questions.urgency as any).criteria).toHaveLength(4);
    expect(r.flags?.distinct_sources).toBe(2);
  });

  it('lanes null (lookup unavailable) rides as source_lanes: null; malformed rows do not throw', () => {
    const r = buildWakeTriageRequestV2({ target: 'supervised chat', rows: [{}, { payload: null, createdAt: 'garbage' }], preview: preview(), lanes: null });
    expect(r.state.source_lanes).toBeNull();
    expect(r.state.event_kinds).toEqual({ unknown: 2 });
    expect(r.state.oldest_event_age_min).toBeNull();
    expect(wakeTriageSourceIds([{}, row('a'), row('b')])).toEqual(['c-src']);
    // E3b: rows without ids cannot be memoised — memo:false at the call site.
    expect(r.memoable).toBe(false);
    expect(r.memoState).toBeNull();
  });
});

/* E3b (2026-09-25) — LIVE DEFECT: 0 cached wake_triage rows over 37 min / 24
 * asks. The v2 state carried whole-minute event AGES and the growing batch
 * COUNT, so the busy re-ask of the same batch a minute later hashed
 * differently and the E3 memo never hit. The request now carries a
 * memo-stable projection (bucketed ages, sorted event ids, no count) that
 * decide() keys the memo on; the exact state still goes to the backend and
 * still stamps meta.stateHash. */
describe('E3b — memo-stable projection (memoState) + memoable', () => {
  const rowsAt = (now: number, ids: string[], over: Record<string, unknown> = {}) => ids.map((id) => row(`Run ${id} finished fine`, { id, createdAt: new Date(now - 5 * 60_000), ...over }));
  const lanes = [{ chat_id: 'c-src', coding_status: 'ready', last_run: { status: 'completed', ended_min_ago: 4, error_head: null } }];

  it('v2 memoState buckets the ages, identifies the batch by sorted event ids (not the count), buckets the lane age, and keeps the stable flags + prose', () => {
    const r = buildWakeTriageRequestV2({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e2', 'e1']), preview: preview('Both fine'), lanes, now: NOW });
    expect(r.memoable).toBe(true);
    expect(r.memoState).toEqual({
      target: 'fleet supervisor chat', event_type: 'run_completed', event_ids: ['e1', 'e2'],
      event_kinds: { run_completed: 2 },
      any_row_is_question_or_request: false, any_row_addressed_to_supervisor: false, any_row_reports_failure_or_block: false,
      any_row_guard_replaced_final: false, any_row_owner_facing: false, distinct_sources: 1,
      oldest_event_age: '5-15m', newest_event_age: '5-15m',
      source_chat: 'Lane',
      source_lanes: [{ chat_id: 'c-src', coding_status: 'ready', last_run: { status: 'completed', ended_ago: '0-5m', error_head: null } }],
      summary: 'Both fine',
    });
    // The exact state is untouched by the projection: count + whole-minute ages still ride to the backend.
    expect(r.state).toMatchObject({ events: 2, oldest_event_age_min: 5, newest_event_age_min: 5 });
    expect(r.state.event_ids).toBeUndefined();
    // Same batch, 30 s later: exact state changes (ages round to 6), memoState does not.
    const later = buildWakeTriageRequestV2({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e2', 'e1']), preview: preview('Both fine'), lanes, now: NOW + 30_000 });
    expect(later.state.oldest_event_age_min).toBe(6);
    expect(later.memoState).toEqual(r.memoState);
    // A NEW event id is a different memoState.
    const grown = buildWakeTriageRequestV2({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e2', 'e1', 'e3']), preview: preview('Both fine'), lanes, now: NOW });
    expect(grown.memoState).not.toEqual(r.memoState);
    expect((grown.memoState as any).event_ids).toEqual(['e1', 'e2', 'e3']);
  });

  it('wakeTriageEventIds / wakeTriageMemoable: distinct sorted ids; null / false without an id; false for an empty batch or an alarm row', () => {
    expect(wakeTriageEventIds([row('a', { id: 'b' }), row('a', { id: 'a' }), row('a', { id: 'b' })])).toEqual(['a', 'b']);
    expect(wakeTriageEventIds([row('a', { id: 'x' }), { payload: {} }])).toBeNull();
    expect(wakeTriageEventIds([row('a', { id: '' })])).toBeNull();
    expect(wakeTriageMemoable([])).toBe(false);
    expect(wakeTriageMemoable([row('a', { id: 'x' })])).toBe(true);
    expect(wakeTriageMemoable([row('a', { id: 'x' }), row('b', { id: 'y', eventType: 'run_failed' })], (r) => r.eventType === 'run_failed')).toBe(false);
    expect(wakeTriageMemoable([row('a', { id: 'x' })], () => { throw new Error('boom'); })).toBe(false); // a throwing predicate fails safe
    const alarm = buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e1']), preview: preview(), lanes: null, isAlarm: () => true });
    expect(alarm).toMatchObject({ memoable: false, memoState: null });
  });

  describe('through decide()', () => {
    const post = (axios as any).post as jest.Mock;
    const jevAnswers = { needs_turn_now: { noul: 0.04 }, disposition: { choice: 'ack', probabilities: { ack: 0.9, coalesce: 0.05, act_now: 0.03, escalate_owner: 0.02 } }, addressed_to_supervisor: { noul: 0.1 }, contains_failure_or_block: { noul: 0.05 }, urgency: { score: 0, probabilities: { 0: 0.9, 1: 0.05, 2: 0.03, 3: 0.02 } } };
    beforeEach(() => {
      process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
      process.env.TYPESAFE_API_KEY = 'k';
      post.mockReset();
      post.mockResolvedValue({ data: { model: 'jev-1.13.0', answers: jevAnswers, usage: { input_tokens: 80 } } });
      (recordLoopMetric as jest.Mock).mockReset();
      clearDecisionBackendCache();
      clearDecisionModeCache();
      clearDecisionMemo();
    });
    const ask = (req: ReturnType<typeof buildWakeTriageRequest>, sessionId = 'c-tgt') => decide(req.state, req.questions, {
      purpose: 'wake_triage', timeoutMs: 5000, sessionId,
      ...(req.memoable && req.memoState ? { memoState: req.memoState } : { memo: false }),
    });

    it('two asks 30 s apart on the SAME event set: the second answers from the memo (cached:true, same memoHash, a DIFFERENT exact stateHash)', async () => {
      const r1 = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e1', 'e2']), preview: preview('Both fine'), lanes, now: NOW }));
      const r2 = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e1', 'e2']), preview: preview('Both fine'), lanes, now: NOW + 30_000 }));
      expect(post).toHaveBeenCalledTimes(1);
      expect(r1!.cached).toBeUndefined();
      expect(r2).toMatchObject({ cached: true, answers: r1!.answers, memoHash: r1!.memoHash, questionsHash: r1!.questionsHash });
      expect(r2!.stateHash).not.toBe(r1!.stateHash); // the ruler's dedupe key still tells the two exact states apart
      const rows = (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]);
      expect(rows).toHaveLength(2);
      expect(rows[0].meta).toMatchObject({ phase: 'decision', purpose: 'wake_triage', ok: true, memoHash: r1!.memoHash, stateHash: r1!.stateHash });
      expect(rows[0].meta.cached).toBeUndefined();
      expect(rows[1].meta).toMatchObject({ phase: 'decision', purpose: 'wake_triage', ok: true, cached: true, cachedFrom: r1!.id, memoHash: r1!.memoHash, stateHash: r2!.stateHash });
    });

    it('a batch with a NEW event id is never served from the memo', async () => {
      await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e1', 'e2']), preview: preview('Both fine'), lanes, now: NOW }));
      const grown = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e1', 'e2', 'e3']), preview: preview('Both fine'), lanes, now: NOW + 30_000 }));
      expect(post).toHaveBeenCalledTimes(2);
      expect(grown!.cached).toBeUndefined();
      // And the original set is still a hit afterwards (its entry was not displaced).
      const again = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: rowsAt(NOW, ['e1', 'e2']), preview: preview('Both fine'), lanes, now: NOW + 60_000 }));
      expect(post).toHaveBeenCalledTimes(2);
      expect(again!.cached).toBe(true);
    });

    it('alarm events never memoise: identical alarm batches call the backend every time and never seed the memo', async () => {
      const alarmRows = rowsAt(NOW, ['e1'], { eventType: 'run_failed', payload: { eventType: 'run_failed', sourceChatId: 'c-src', sourceChatTitle: 'Lane', summary: 'Run failed: exit code 1', depth: 0 } });
      const isAlarm = (r: any) => r.eventType === 'run_failed';
      const a1 = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: alarmRows, preview: preview('Run failed: exit code 1'), lanes, now: NOW, isAlarm }));
      const a2 = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: alarmRows, preview: preview('Run failed: exit code 1'), lanes, now: NOW, isAlarm }));
      expect(post).toHaveBeenCalledTimes(2);
      expect(a1!.cached).toBeUndefined();
      expect(a2!.cached).toBeUndefined();
      // The same rows WITHOUT the alarm predicate would memoise — the predicate is what turns it off.
      const q = await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: alarmRows, preview: preview('Run failed: exit code 1'), lanes, now: NOW }));
      expect(q!.cached).toBeUndefined();
      expect(post).toHaveBeenCalledTimes(3);
      expect((await ask(buildWakeTriageRequest({ target: 'fleet supervisor chat', rows: alarmRows, preview: preview('Run failed: exit code 1'), lanes, now: NOW })))!.cached).toBe(true);
      expect(post).toHaveBeenCalledTimes(3);
    });
  });
});

describe('code flags', () => {
  const flagsOf = (summary: string) => wakeTriageCodeFlags([row(summary)], NOW);
  it('question / addressed / failure / guard-replaced / owner-facing are independent regex readings of the prose', () => {
    expect(flagsOf('Run finished fine')).toMatchObject({ any_row_is_question_or_request: false, any_row_addressed_to_supervisor: false, any_row_reports_failure_or_block: false, any_row_guard_replaced_final: false, any_row_owner_facing: false });
    expect(flagsOf('Can you unblock the deploy?').any_row_is_question_or_request).toBe(true);
    expect(flagsOf('Awaiting a decision on the branch').any_row_is_question_or_request).toBe(true);
    expect(flagsOf('Report-up to the supervisor: wave 3 done').any_row_addressed_to_supervisor).toBe(true);
    expect(flagsOf('Coding run failed: OOM at verify').any_row_reports_failure_or_block).toBe(true);
    expect(flagsOf('Lane is stuck on a 2FA prompt').any_row_reports_failure_or_block).toBe(true);
    const replaced = flagsOf('Coding run completed, but the evidence guard REPLACED its final answer');
    expect(replaced.any_row_guard_replaced_final).toBe(true);
    expect(replaced.any_row_reports_failure_or_block).toBe(true);
    expect(flagsOf("This needs the owner's decision on spend").any_row_owner_facing).toBe(true);
  });
});

describe('shadow would-park readout (nothing acts on it) with per-option thresholds', () => {
  const answers = (disposition: string, p: number, needs = 0.05): any => ({
    needs_turn_now: { type: 'noul', noul: needs },
    disposition: { type: 'choice', choice: disposition, probabilities: { ack: 0, coalesce: 0, act_now: 0, escalate_owner: 0, [disposition]: p }, confidence: p },
    addressed_to_supervisor: { type: 'noul', noul: 0.1 },
    contains_failure_or_block: { type: 'noul', noul: 0.1 },
    urgency: { type: 'score', score: 0.3, probabilities: { '0': 0.7, '1': 0.3, '2': 0, '3': 0 }, confidence: 0.7 },
  });

  it('parks a confident ack / coalesce whose needs_turn_now is also confidently no; never act_now / escalate_owner', () => {
    expect(wakeTriageV2WouldPark(answers('ack', 0.93))).toMatchObject({ park: true, disposition: 'ack', p: 0.93, threshold: 0.85 });
    expect(wakeTriageV2WouldPark(answers('coalesce', 0.9))).toMatchObject({ park: true });
    expect(wakeTriageV2WouldPark(answers('ack', 0.8))).toMatchObject({ park: false });
    expect(wakeTriageV2WouldPark(answers('ack', 0.93, 0.4))).toMatchObject({ park: false }); // needs_turn_now not confidently no
    expect(wakeTriageV2WouldPark(answers('act_now', 0.99))).toMatchObject({ park: false });
    expect(wakeTriageV2WouldPark(answers('escalate_owner', 0.99))).toMatchObject({ park: false });
    expect(wakeTriageV2Note(answers('ack', 0.93))).toBe('v2 park:ack 0.93≥0.85');
    expect(wakeTriageV2Note(answers('act_now', 0.61))).toBe('v2 deliver:act_now 0.61');
  });

  it('DECISION_GATE_THRESHOLD_WAKE_TRIAGE_<OPTION> overrides one option; the purpose threshold covers the rest; v1 answers read null', () => {
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ACK = '0.95';
    expect(wakeTriageV2WouldPark(answers('ack', 0.93))).toMatchObject({ park: false, threshold: 0.95 });
    expect(wakeTriageV2WouldPark(answers('coalesce', 0.93))).toMatchObject({ park: true, threshold: 0.85 });
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE = '0.9';
    expect(wakeTriageV2WouldPark(answers('coalesce', 0.93, 0.08))).toMatchObject({ park: true, threshold: 0.9 });
    expect(wakeTriageV2WouldPark(answers('coalesce', 0.93, 0.12))).toMatchObject({ park: false }); // 0.12 > 1 − 0.9
    expect(wakeTriageV2WouldPark({ needs_turn_now: { type: 'noul', noul: 0.05 } })).toBeNull();
    expect(wakeTriageV2Note({ needs_turn_now: { type: 'noul', noul: 0.05 } })).toBe('');
    expect(wakeTriageV2Note(null)).toBe('');
  });
});

describe('decision-time code-flag labels + answered keys', () => {
  it('labels only the batch-property nouls the decision answered, from the flags', () => {
    const flags = wakeTriageCodeFlags([row('Please approve?'), row('Run failed: exit code 2')], NOW);
    const labels = wakeTriageCodeLabels({ answers: { needs_turn_now: { type: 'noul', noul: 0.2 }, addressed_to_supervisor: { type: 'noul', noul: 0.9 }, contains_failure_or_block: { type: 'noul', noul: 0.8 } } }, flags);
    expect(labels).toEqual([{ question: 'addressed_to_supervisor', actual: true }, { question: 'contains_failure_or_block', actual: true }]);
    expect(wakeTriageCodeLabels({ answers: { needs_turn_now: { type: 'noul', noul: 0.2 } } }, flags)).toEqual([]); // a v1 answer set
    expect(wakeTriageCodeLabels({ answers: { addressed_to_supervisor: { type: 'noul', noul: 0.9 } } }, null)).toEqual([]); // v1 request (no flags)
    expect(wakeTriageCodeLabels(null, flags)).toEqual([]);
  });

  it('wakeTriageAnsweredKeys lists the v2 keys present (unknown keys ignored)', () => {
    expect(wakeTriageAnsweredKeys({ needs_turn_now: { type: 'noul', noul: 0.1 }, urgency: { type: 'score', score: 1, probabilities: {}, confidence: 1 }, bogus: { type: 'noul', noul: 1 } } as any)).toEqual(['needs_turn_now', 'urgency']);
    expect(wakeTriageAnsweredKeys(null)).toEqual([]);
  });
});

describe('the request carries no target_facts block', () => {
  it('state and memoState hold no target_facts; the shape is v2 with the v2 question set', () => {
    const without = buildWakeTriageRequestV2({ target: 'fleet supervisor chat', rows: [row('a', { id: 'e1' })], preview: preview('x'), lanes: null, now: NOW });
    expect(without.state.target_facts).toBeUndefined();
    expect((without.memoState as any).target_facts).toBeUndefined();
    expect(without.shape).toBe('v2');
    expect(without.questions).toBe(WAKE_TRIAGE_V2_QUESTIONS);
  });
});
