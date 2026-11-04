/**
 * build 2026-10-11 T1 — tier-1 context clearing ACTS (context-gauge.ts tier1Act; context.md §4 stages 3–4).
 *
 * REPLAY: the four real post-T1 gateway GLM-5.3 lane runs (__fixtures__/context-gauge-glm-series.json — per-turn lead
 * prompt tokens from prod `context` events, 138–217 turns, peaks 235–254k) driven through the REAL gauge twice:
 *  - TREATMENT: at the top of every step tier1Act may edit the transcript; the provider then reports the prompt the
 *    edited transcript really is (the series minus the tokens the stubs keep out) and a cache that holds only the
 *    prefix before the edit point on the first request after an edit (append-only otherwise);
 *  - CONTROL: the same series, untouched (today's behaviour) — its tier1_shadow rows say what treatment would do.
 * Each turn's growth is rebuilt as an assistant tool call + a tool result (75 % of the appended tokens are tool
 * output — context.md §3's assumption), at Z.ai list prices.
 */

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import series from './__fixtures__/context-gauge-glm-series.json';
import {
  ContextGauge,
  CONTEXT_EDIT_KIND,
  STEER_MARKER_TEXT,
  TIER1_CLEAR_AT_LEAST_TOKENS,
  TIER1_DEFAULT_CONTROL_SHARE,
  TIER1_HEAD_CHARS,
  TIER1_KEEP_ROUNDS,
  TIER1_STEER_GUARD_TURNS,
  TIER1_TRIGGER_TOKENS,
  isSteerOrOwnerMessage,
  keepClearedTexts,
  planTier1Clear,
  tier1ArmFor,
  tier1ClearingConfig,
  turnsSinceSteerOrOwner,
  type Tier1Config,
} from './context-gauge';
import { CLEARED_RESULT_PREFIX, isClearedResult, type ContextMessage } from './context-clearing';
import type { Price } from './cost';

const GLM_LIST: Price = { in: 1.4, out: 4.4, cachedIn: 0.26 };
const TREATMENT: Tier1Config = { mode: 'act', controlShare: 0, valid: true };
const CONTROL: Tier1Config = { mode: 'act', controlShare: 1, valid: true };
const SHADOW: Tier1Config = { mode: 'shadow', controlShare: TIER1_DEFAULT_CONTROL_SHARE, valid: true };
const OFF: Tier1Config = { mode: 'off', controlShare: TIER1_DEFAULT_CONTROL_SHARE, valid: true };

const rows = (event?: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r?.kind === CONTEXT_EDIT_KIND && (!event || r.meta?.event === event));
const tok = (chars: number) => Math.ceil(chars / 4);
const charsOf = (m: ContextMessage) => (typeof m.content === 'string' ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

beforeEach(() => {
  mockRecordLoopMetric.mockClear();
  delete process.env.CONTEXT_CLEARING_ENABLED;
});
afterEach(() => { delete process.env.CONTEXT_CLEARING_ENABLED; });

interface ReplayOut { cost: number; summary: any; acts: any[]; shadows: any[]; finalMessages: ContextMessage[]; editedAtSteps: number[] }

/** Drive one real series through the gauge (see the header). */
function replay(P: number[], cfg: Tier1Config, opts: { steerAt?: number; tools?: string[] } = {}): ReplayOut {
  mockRecordLoopMetric.mockClear();
  const gauge = new ContextGauge({ sessionId: 's1', runId: 'r1', profile: 'coding', priceOf: () => GLM_LIST, tier1: cfg });
  let messages: ContextMessage[] = [{ role: 'system', content: 'S'.repeat(40_000) }, { role: 'user', content: 'Implement the task.' }];
  const originalChars = new Map<string, number>(); // tool_call_id → original result chars
  let cost = 0;
  let prevActual = 0;
  let prevRequestLen = 0;
  const editedAtSteps: number[] = [];
  for (let i = 0; i < P.length; i++) {
    if (i > 0) {
      const a = Math.max(0, P[i] - P[i - 1]);
      const tool = opts.tools?.[i % opts.tools.length] ?? 'read_file';
      messages.push({ role: 'assistant', content: 'n'.repeat(Math.round(a * 0.25 * 4)), tool_calls: [{ id: `c${i}`, type: 'function', function: { name: tool, arguments: `{"path":"src/f${i}.ts"}` } }] });
      const body = 'r'.repeat(Math.round(a * 0.75 * 4));
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: body });
      originalChars.set(`c${i}`, body.length);
      if (opts.steerAt === i) messages.push({ role: 'user', content: `[HARNESS INJECTION — not typed by the user; treat as system instructions]\nThe user sent this WHILE you are working — ${STEER_MARKER_TEXT} with high priority: push now` });
    }
    // top of step i: the act path (treatment only — every other arm returns null)
    const pre = messages;
    const edit = gauge.tier1Act(messages, i);
    let editIndex = -1;
    if (edit) {
      messages = edit.messages;
      editedAtSteps.push(i);
      editIndex = messages.findIndex((m, k) => m !== pre[k]);
    }
    // what the provider counts: the series minus what the stubs keep out of the request
    let kept = 0;
    for (const m of messages) {
      if (m.role === 'tool' && isClearedResult(m.content)) kept += tok(originalChars.get(String(m.tool_call_id))!) - tok(String(m.content).length);
    }
    const actual = P[i] - kept;
    let cached: number;
    if (i === 0) cached = 0;
    else if (editIndex >= 0) {
      // the prefix before the edit point stays cached; the old request's tail from it is re-read
      let tail = 0;
      for (let k = editIndex; k < prevRequestLen; k++) tail += charsOf(pre[k]);
      cached = Math.max(0, prevActual - tok(tail));
    } else cached = Math.min(prevActual, actual);
    cost += ((actual - cached) * GLM_LIST.in + cached * GLM_LIST.cachedIn! + 300 * GLM_LIST.out) / 1e6;
    gauge.observeTurn({ step: i, model: 'api-optimize-zai-glm-5.3', usage: { promptTokens: actual, completionTokens: 300, cachedTokens: cached }, messages, toolCalls: [] });
    prevActual = actual;
    prevRequestLen = messages.length;
  }
  gauge.finish({ compactions: 0 });
  return { cost, summary: rows('run_summary').at(-1)!.meta, acts: rows('tier1_act').map((r: any) => r.meta), shadows: rows('tier1_shadow').map((r: any) => r.meta), finalMessages: messages, editedAtSteps };
}

const runs = (series as { runs: Record<string, number[]> }).runs;
/**
 * Edits per run (measured on the real series): every run crosses T twice; 33468968's second crossing is on its LAST
 * turn (index 216 of 217 — the shadow's would-clear at 216 has no next request to land on), so it edits once.
 * Measured list-$ deltas vs control: −16.5 % / −29.6 % / −21.5 % / −23.4 %.
 */
const EXPECTED_EDITS: Record<string, number> = { '33468968': 1, '6b7b7692': 2, '7de0b9c8': 2, add63ab5: 2 };

describe('REPLAY — tier 1 ACTS on 4 real GLM lane runs (treatment vs control)', () => {
  it.each(Object.keys(runs))('run %s: crossing T twice ⇒ two batched edits, each ≥ clear_at_least, ≥ 15 %% cheaper at list prices; the control never edits', (rid) => {
    const P = runs[rid];
    const control = replay(P, CONTROL);
    const treated = replay(P, TREATMENT);

    // CONTROL keeps today's behaviour: no edit, shadow rows (arm control) say what treatment would do.
    expect(control.editedAtSteps).toEqual([]);
    expect(control.acts).toEqual([]);
    expect(control.finalMessages.some((m) => isClearedResult(m.content))).toBe(false);
    expect(control.shadows.length).toBeGreaterThanOrEqual(2);
    expect(control.shadows.every((e) => e.arm === 'control')).toBe(true);
    expect(control.summary).toMatchObject({ arm: 'control', t1Mode: 'act', t1Eligible: true, t1Events: control.shadows.length });

    // TREATMENT: the prompt crosses T twice ⇒ TWO batched edits — one per crossing the control's shadow predicted
    // (the act path decides one turn later: the round appended since the reading is inside the kept window).
    expect(control.shadows).toHaveLength(2);
    expect(treated.editedAtSteps).toHaveLength(EXPECTED_EDITS[rid]);
    expect(treated.acts).toHaveLength(EXPECTED_EDITS[rid]);
    treated.acts.forEach((e, k) => expect(e.step).toBeGreaterThanOrEqual(control.shadows[k].step));
    for (const e of treated.acts) {
      expect(e.arm).toBe('treatment');
      expect(e.promptTokensBefore).toBeGreaterThan(TIER1_TRIGGER_TOKENS);
      expect(e.freedTokens).toBeGreaterThanOrEqual(TIER1_CLEAR_AT_LEAST_TOKENS);
      expect(e.editIndex).toBeGreaterThan(1); // never the system prompt or the task
      expect(e.turnsSinceAnchor).toBeGreaterThanOrEqual(TIER1_STEER_GUARD_TURNS);
      // predicted vs observed: the next request reported a cache that ends at the edit point
      expect(e.observedCachedTokens).toBeGreaterThan(0);
      expect(Math.abs(e.observedCachedTokens - e.predictedCachedTokens)).toBeLessThanOrEqual(e.predictedCachedTokens * 0.02);
      expect(e.unplannedMiss).toBe(false);
      expect(e.breakUsdObserved).toBeGreaterThan(0);
    }
    // the edited transcript: stubs only on tool results, the last K rounds raw, every role / id intact
    expect(treated.finalMessages).toHaveLength(control.finalMessages.length);
    treated.finalMessages.forEach((m, k) => {
      expect(m.role).toBe(control.finalMessages[k].role);
      if (m.role !== 'tool') expect(m).toEqual(control.finalMessages[k]);
      else expect(m.tool_call_id).toBe(control.finalMessages[k].tool_call_id);
    });
    const lastRounds = treated.finalMessages.filter((m) => m.role === 'tool').slice(-TIER1_KEEP_ROUNDS);
    expect(lastRounds.every((m) => !isClearedResult(m.content))).toBe(true);
    const stub = treated.finalMessages.find((m) => isClearedResult(m.content))!;
    expect(String(stub.content)).toMatch(/^\[cleared to save context: read_file\(\{"path":"src\/f\d+\.ts"\}\) returned [\d,]+ chars — the first 400 are kept below\. Re-run the call if you need the full result\.\]\nr{400}…$/);

    // The deciding metric (cache-aware list $): treatment ≥ 15 % cheaper than control, after the cache breaks.
    expect(treated.summary.costUsd).toBeCloseTo(treated.cost, 4);
    expect(control.summary.costUsd).toBeCloseTo(control.cost, 4);
    const delta = (treated.summary.costUsd - control.summary.costUsd) / control.summary.costUsd;
    expect(delta).toBeLessThanOrEqual(-0.15);
    expect(delta).toBeGreaterThan(-0.6);
    expect(treated.summary).toMatchObject({ arm: 'treatment', t1Events: EXPECTED_EDITS[rid], t1Eligible: true, t1ReReads: 0 });
    expect(treated.summary.t1BreakObservedUsd).toBeGreaterThan(0);
    expect(treated.summary.t1SavingUsd).toBeGreaterThan(treated.summary.t1BreakObservedUsd);
    // the peak prompt is the crossing turn (identical in both arms — the eligibility filter is unbiased)
    expect(treated.summary.peakPromptTokens).toBeLessThan(control.summary.peakPromptTokens);
    // each edit is ONE planned cache break, never a per-turn churn
    expect(treated.summary.cacheBreaks).toBeLessThanOrEqual(2);
  });
});

describe('the steer guard (K = 5 turns since a steer / owner message)', () => {
  it('REPLAY: a steer right before the crossing defers the edit by K turns; no edit ever lands inside the guard', () => {
    const P = runs['6b7b7692'];
    const plain = replay(P, TREATMENT);
    const firstEdit = plain.editedAtSteps[0];
    const steered = replay(P, TREATMENT, { steerAt: firstEdit - 1 });
    expect(steered.editedAtSteps[0]).toBeGreaterThan(firstEdit);
    expect(steered.editedAtSteps[0] - (firstEdit - 1)).toBeGreaterThanOrEqual(TIER1_STEER_GUARD_TURNS);
    expect(steered.summary.t1SteerBlockedTurns).toBeGreaterThan(0);
    for (const e of steered.acts) expect(e.turnsSinceAnchor).toBeGreaterThanOrEqual(TIER1_STEER_GUARD_TURNS);
  });

  it('planTier1Clear: steer_guard below K turns, clear at K; harness-framed user messages are not anchors', () => {
    const ms: ContextMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: '[MACHINE-TRIGGERED RUN] lane firing' }];
    for (let i = 0; i < 12; i++) {
      ms.push({ role: 'assistant', content: '', tool_calls: [{ id: `x${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"a${i}"}` } }] });
      ms.push({ role: 'tool', tool_call_id: `x${i}`, content: 'z'.repeat(40_000) });
    }
    expect(turnsSinceSteerOrOwner(ms)).toBeNull(); // a machine prompt is not the owner's words
    expect(planTier1Clear(ms, { promptTokens: 170_000 }).status).toBe('clear');
    const steer: ContextMessage = { role: 'user', content: `[HARNESS INJECTION — not typed by the user; treat as system instructions]\nAnother Digby agent sent this WHILE you are working — ${STEER_MARKER_TEXT} from that agent: stop` };
    const withSteer = [...ms.slice(0, ms.length - 2 * (TIER1_STEER_GUARD_TURNS - 1)), steer, ...ms.slice(ms.length - 2 * (TIER1_STEER_GUARD_TURNS - 1))];
    expect(turnsSinceSteerOrOwner(withSteer)).toBe(TIER1_STEER_GUARD_TURNS - 1);
    expect(planTier1Clear(withSteer, { promptTokens: 170_000 }).status).toBe('steer_guard');
    const atK = [...ms.slice(0, ms.length - 2 * TIER1_STEER_GUARD_TURNS), steer, ...ms.slice(ms.length - 2 * TIER1_STEER_GUARD_TURNS)];
    expect(turnsSinceSteerOrOwner(atK)).toBe(TIER1_STEER_GUARD_TURNS);
    expect(planTier1Clear(atK, { promptTokens: 170_000 }).status).toBe('clear');
    // an owner-typed message is an anchor; harness notices are not
    expect(isSteerOrOwnerMessage({ role: 'user', content: 'please also update the README' })).toBe(true);
    expect(isSteerOrOwnerMessage({ role: 'user', content: '[HARNESS NOTICE — not typed by the user] FINAL TURN' })).toBe(false);
    expect(isSteerOrOwnerMessage({ role: 'user', content: '[BACKGROUND WORKER REPORT — explorer x]' })).toBe(false);
    expect(isSteerOrOwnerMessage({ role: 'assistant', content: 'please' })).toBe(false);
  });
});

describe('what tier 1 never clears', () => {
  const base = (): ContextMessage[] => {
    const ms: ContextMessage[] = [{ role: 'system', content: 'S'.repeat(50_000) }, { role: 'user', content: 'U'.repeat(50_000) }];
    const tools = ['update_plan', 'verify', 'todo_list', 'get_run_receipts', 'get_supervisor_state', 'delegate', 'goal_get', 'read_file', 'run_command', 'grep'];
    tools.forEach((t, i) => {
      ms.push({ role: 'assistant', content: 'A'.repeat(5_000), reasoning_content: 'R'.repeat(5_000), tool_calls: [{ id: `e${i}`, type: 'function', function: { name: t, arguments: `{"i":${i}}` } }] });
      ms.push({ role: 'tool', tool_call_id: `e${i}`, content: `${t}:` + 'b'.repeat(60_000) });
    });
    ms.push({ role: 'user', content: [{ type: 'text', text: 'image turn' }] }); // vision content is never a candidate either
    for (let i = 0; i < TIER1_KEEP_ROUNDS; i++) {
      ms.push({ role: 'assistant', content: '', tool_calls: [{ id: `k${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      ms.push({ role: 'tool', tool_call_id: `k${i}`, content: 'k'.repeat(30_000) });
    }
    return ms;
  };

  it('system / user / assistant text, reasoning, plan / verify / todo / goal / receipts / supervisor state / worker digests and the last K rounds stay verbatim', () => {
    const ms = base();
    ms.splice(1, 1, { role: 'user', content: '[MACHINE-TRIGGERED RUN] x' + 'U'.repeat(50_000) }); // no owner anchor
    const gauge = new ContextGauge({ profile: 'coding', priceOf: () => GLM_LIST, tier1: TREATMENT });
    gauge.observeTurn({ step: 1, model: 'glm-5.3', usage: { promptTokens: 200_000, completionTokens: 1, cachedTokens: 190_000 }, messages: ms });
    const r = gauge.tier1Act(ms, 2)!;
    expect(r).not.toBeNull();
    const cleared = r.messages.filter((m) => isClearedResult(m.content)).map((m) => String(m.content).slice(CLEARED_RESULT_PREFIX.length + 2, CLEARED_RESULT_PREFIX.length + 12));
    expect(cleared.sort()).toEqual(['grep({"i":', 'read_file(', 'run_comman'].sort());
    r.messages.forEach((m, k) => {
      if (m.role !== 'tool') expect(m).toBe(ms[k]); // the same object — never rewritten
    });
    expect(r.originals).toHaveLength(3);
    expect(r.originals.every((t) => t.length > 60_000)).toBe(true);
    // one decision per provider reading: no second edit before the next turn is observed
    expect(gauge.tier1Act(r.messages, 2)).toBeNull();
  });

  it('a stub keeps the name, the args summary, the first 400 chars and how to restore it; it is never cleared twice', () => {
    const ms = base();
    const gauge = new ContextGauge({ profile: 'coding', priceOf: () => GLM_LIST, tier1: TREATMENT });
    gauge.observeTurn({ step: 1, model: 'glm-5.3', usage: { promptTokens: 200_000, completionTokens: 1, cachedTokens: 190_000 }, messages: ms });
    const r = gauge.tier1Act(ms, 2);
    // the task above is owner-typed and > K turns old ⇒ no guard
    expect(r).not.toBeNull();
    const stub = String(r!.messages.find((m) => isClearedResult(m.content))!.content);
    expect(stub).toContain('read_file({"i":7})');
    expect(stub).toContain('returned 60,010 chars — the first 400 are kept below. Re-run the call if you need the full result.]');
    expect(stub.split('\n')[1]).toBe(`read_file:${'b'.repeat(TIER1_HEAD_CHARS - 'read_file:'.length)}…`);
    gauge.observeTurn({ step: 2, model: 'glm-5.3', usage: { promptTokens: 200_000, completionTokens: 1, cachedTokens: 20_000 }, messages: r!.messages });
    const again = planTier1Clear(r!.messages, { promptTokens: 200_000 });
    expect(again.picks.map((p) => p.tool)).not.toContain('read_file'); // stubs are never candidates
  });
});

describe('the switch and the arms', () => {
  it('CONTEXT_CLEARING_ENABLED: blank = act with a 20 % control; act[:share]; shadow; off; junk never acts', () => {
    const at = (v?: string) => tier1ClearingConfig(v === undefined ? {} : { CONTEXT_CLEARING_ENABLED: v });
    expect(at()).toEqual({ mode: 'act', controlShare: 0.2, valid: true });
    expect(at('  ')).toEqual({ mode: 'act', controlShare: 0.2, valid: true });
    expect(at('act')).toEqual({ mode: 'act', controlShare: 0.2, valid: true });
    expect(at('ACT:0.35')).toEqual({ mode: 'act', controlShare: 0.35, valid: true });
    expect(at('1')).toMatchObject({ mode: 'act' });
    expect(at('act:2')).toEqual({ mode: 'act', controlShare: 0.2, valid: false });
    expect(at('shadow')).toMatchObject({ mode: 'shadow', valid: true });
    expect(at('off')).toMatchObject({ mode: 'off', valid: true });
    expect(at('0')).toMatchObject({ mode: 'off' });
    expect(at('banana')).toMatchObject({ mode: 'shadow', valid: false });
    process.env.CONTEXT_CLEARING_ENABLED = 'shadow';
    expect(tier1ClearingConfig().mode).toBe('shadow');
  });

  it('the arm is a deterministic hash of the run id (a resumed run keeps it); ~controlShare of runs are control', () => {
    const cfg = tier1ClearingConfig({});
    expect(tier1ArmFor(cfg, 'run-abc')).toBe(tier1ArmFor(cfg, 'run-abc'));
    let control = 0;
    for (let i = 0; i < 2_000; i++) if (tier1ArmFor(cfg, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) === 'control') control += 1;
    expect(control / 2_000).toBeGreaterThan(0.17);
    expect(control / 2_000).toBeLessThan(0.23);
    expect(tier1ArmFor(TREATMENT, 'x')).toBe('treatment');
    expect(tier1ArmFor(CONTROL, 'x')).toBe('control');
    expect(tier1ArmFor(SHADOW, 'x')).toBe('shadow');
    expect(tier1ArmFor(OFF, 'x')).toBe('off');
    expect(tier1ArmFor(cfg, undefined, () => 0.1)).toBe('control');
    expect(tier1ArmFor(cfg, undefined, () => 0.5)).toBe('treatment');
  });

  it.each([['control', CONTROL], ['shadow', SHADOW], ['off', OFF]] as const)('%s never edits a prompt', (arm, cfg) => {
    const out = replay(runs['33468968'], cfg);
    expect(out.editedAtSteps).toEqual([]);
    expect(out.acts).toEqual([]);
    expect(out.summary.arm).toBe(arm);
    if (arm === 'off') expect(out.shadows).toEqual([]);
    else expect(out.shadows.every((e) => e.arm === arm)).toBe(true);
  });
});

describe('telemetry: the act row, guardrails, outcomes', () => {
  const big = (): ContextMessage[] => {
    const ms: ContextMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'Ship the fix.' }];
    for (let i = 0; i < 12; i++) {
      ms.push({ role: 'assistant', content: '', tool_calls: [{ id: `q${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}.ts"}` } }] });
      ms.push({ role: 'tool', tool_call_id: `q${i}`, content: 'q'.repeat(40_000) });
    }
    return ms;
  };

  it('predicted vs observed cached tokens on the first request after the edit; a cold prefix is an unplanned miss', () => {
    const ms = big();
    const gauge = new ContextGauge({ sessionId: 'c1', runId: 'r1', profile: 'coding', priceOf: () => GLM_LIST, tier1: TREATMENT });
    gauge.observeTurn({ step: 11, model: 'glm-5.3', usage: { promptTokens: 175_000, completionTokens: 1, cachedTokens: 170_000 }, messages: ms });
    const r = gauge.tier1Act(ms, 12)!;
    expect(rows('tier1_act')).toEqual([]); // written once the next request's usage is known
    gauge.observeTurn({ step: 12, model: 'glm-5.3', usage: { promptTokens: 110_000, completionTokens: 1, cachedTokens: 0 }, messages: r.messages });
    const [row] = rows('tier1_act');
    expect(row).toMatchObject({ sessionId: 'c1', runId: 'r1', unit: 'tokens' });
    expect(row.meta).toMatchObject({ arm: 'treatment', step: 12, promptTokensBefore: 175_000, clearedResults: r.cleared, observedPromptTokens: 110_000, observedCachedTokens: 0, unplannedMiss: true, steerGuardTurns: 5, headChars: 400 });
    expect(row.meta.freedTokens).toBe(r.freedTokens);
    expect(row.meta.breakUsdObserved).toBeGreaterThan(row.meta.breakUsdPredicted);
  });

  it('an edit the run never gets to send is flushed at finish without observed fields', () => {
    const ms = big();
    const gauge = new ContextGauge({ profile: 'coding', priceOf: () => GLM_LIST, tier1: TREATMENT });
    gauge.observeTurn({ step: 11, model: 'glm-5.3', usage: { promptTokens: 175_000, completionTokens: 1, cachedTokens: 170_000 }, messages: ms });
    expect(gauge.tier1Act(ms, 12)).not.toBeNull();
    gauge.finish({ compactions: 0 });
    const [row] = rows('tier1_act');
    expect(row.meta).not.toHaveProperty('observedPromptTokens');
    expect(rows('run_summary')[0].meta).toMatchObject({ arm: 'treatment', t1Events: 1 });
  });

  it('run_summary: duplicate share, reads per file, search_memory, re-reads of a cleared result, outcomes from receipts, end state', () => {
    const ms = big();
    const gauge = new ContextGauge({ profile: 'coding', priceOf: () => GLM_LIST, tier1: TREATMENT });
    const call = (name: string, args: string) => ({ name, arguments: args });
    gauge.observeTurn({ step: 1, model: 'glm-5.3', usage: { promptTokens: 175_000, completionTokens: 1, cachedTokens: 170_000 }, messages: ms,
      toolCalls: [call('read_file', '{"path":"f0.ts"}'), call('read_file', '{"path":"f1.ts"}'), call('search_memory', '{"q":"x"}'), call('verify', '{}')] });
    const r = gauge.tier1Act(ms, 2)!;
    expect(r.messages.some((m) => m.tool_call_id === 'q0' && isClearedResult(m.content))).toBe(true);
    // the model re-reads f0.ts (whitespace differs) — a duplicate call AND a re-read of a cleared result
    gauge.observeTurn({ step: 2, model: 'glm-5.3', usage: { promptTokens: 100_000, completionTokens: 1, cachedTokens: 40_000 }, messages: r.messages,
      toolCalls: [call('read_file', '{ "path": "f0.ts" }'), call('read_file', '{"path":"new.ts"}')] });
    gauge.finish({
      compactions: 0, endState: 'ok',
      receipts: [
        { tool: 'git_commit', ok: true, ids: { sha: 'abc1234' } }, { tool: 'git_commit', ok: false },
        { tool: 'git_push', ok: true }, { tool: 'open_pull_request', ok: true, ids: { prNumber: 7 } },
        { tool: 'verify', ok: true, ids: { passed: true } }, { tool: 'verify', ok: true, ids: { passed: false, failedStage: 'test' } },
      ],
    });
    expect(rows('run_summary')[0].meta).toMatchObject({
      toolCalls: 6, dupCalls: 1, dupShare: 0.167, readFileCalls: 4, readFilePaths: 3, searchMemoryCalls: 1, verifyCalls: 1,
      t1ReReads: 1, commits: 1, pushes: 1, prs: 1, merges: 0, verifyRuns: 2, verifyPassed: 1, outcomes: 3, endState: 'ok',
    });
  });

  it('keepClearedTexts keeps the newest originals under the cap', () => {
    const into: string[] = [];
    keepClearedTexts(into, ['a'.repeat(6), 'b'.repeat(6)], 10);
    expect(into).toEqual(['b'.repeat(6)]);
    keepClearedTexts(into, ['c'.repeat(3)], 10);
    expect(into).toEqual(['b'.repeat(6), 'c'.repeat(3)]);
  });
});
