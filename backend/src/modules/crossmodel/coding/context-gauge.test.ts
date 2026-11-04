/**
 * build 2026-10-08 C — context gauge, tier-1 clearing SHADOW, chat fast path.
 *
 * REPLAY: the four real post-T1 gateway GLM-5.3 lane runs the context.md
 * simulation used (per-turn lead prompt tokens from prod `context` events,
 * __fixtures__/context-gauge-glm-series.json). Each turn's growth is rebuilt
 * as an assistant tool call + a tool result (75 % of the appended tokens are
 * tool output — the report's assumption) and fed through the REAL gauge with
 * an append-only cache (turn i hits turn i−1's prompt), at Z.ai list prices.
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
  OWNER_CANARY_USER_ID,
  STEER_MARKER_TEXT,
  TIER1_TRIGGER_TOKENS,
  chatClearingDecision,
  chatContextClearingMode,
  chatFastPathClear,
  contextGaugeDisabled,
} from './context-gauge';
import type { ContextMessage } from './context-clearing';
import type { Price } from './cost';

/** Z.ai list (context.md §2): $1.40 in / $0.26 cached / $4.40 out — pinned here so the replay is independent of the meter table. */
const GLM_LIST: Price = { in: 1.4, out: 4.4, cachedIn: 0.26 };

const rows = (event?: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r?.kind === CONTEXT_EDIT_KIND && (!event || r.meta?.event === event));

/** build 2026-10-11 T1: the default is now `act`; these replays pin the SHADOW (every run records, none edits). */
const SHADOW_CFG = { mode: 'shadow' as const, controlShare: 0.2, valid: true };

function replay(P: number[], opts?: { steerAt?: number }) {
  const gauge = new ContextGauge({ sessionId: 's1', runId: 'r1', profile: 'coding', priceOf: () => GLM_LIST, tier1: SHADOW_CFG });
  const messages: ContextMessage[] = [{ role: 'system', content: 'S'.repeat(40_000) }, { role: 'user', content: 'Implement the task.' }];
  let cost = 0;
  for (let i = 0; i < P.length; i++) {
    if (i > 0) {
      const a = Math.max(0, P[i] - P[i - 1]);
      messages.push({ role: 'assistant', content: 'n'.repeat(Math.round(a * 0.25 * 4)), tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"src/f${i}.ts"}` } }] });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'r'.repeat(Math.round(a * 0.75 * 4)) });
      if (opts?.steerAt === i) messages.push({ role: 'user', content: `[HARNESS INJECTION] The user sent this WHILE you are working — ${STEER_MARKER_TEXT}: push now` });
    }
    const cached = i > 0 ? Math.min(P[i - 1], P[i]) : 0;
    cost += ((P[i] - cached) * GLM_LIST.in + cached * GLM_LIST.cachedIn! + 300 * GLM_LIST.out) / 1e6;
    gauge.observeTurn({ step: i, model: 'api-optimize-zai-glm-5.3', usage: { promptTokens: P[i], completionTokens: 300, cachedTokens: cached }, messages });
  }
  gauge.finish({ compactions: 0 });
  return { cost, summary: rows('run_summary').at(-1)!.meta as any, events: rows('tier1_shadow').map((r: any) => r.meta) };
}

beforeEach(() => {
  mockRecordLoopMetric.mockClear();
  delete process.env.CONTEXT_GAUGE_DISABLED;
  delete process.env.CHAT_CONTEXT_CLEARING;
});

describe('tier-1 shadow — REPLAY of 4 real post-T1 GLM lane runs (context.md §3)', () => {
  const runs = (series as { runs: Record<string, number[]> }).runs;

  it.each(Object.keys(runs))('run %s: batched, rare, cache-aware would-clear events with a positive projected net saving; no prompt touched', (rid) => {
    const P = runs[rid];
    const { cost, summary, events } = replay(P);
    // 2–4 events per long run (the stage-2 exit bar's shape — measured: 2 on each of the 4 runs); each frees ≥ clear_at_least.
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(4);
    for (const e of events) {
      expect(e.freedTokens).toBeGreaterThanOrEqual(40_000);
      expect(e.simPromptBefore).toBeGreaterThan(TIER1_TRIGGER_TOKENS);
      expect(e.breakUsd).toBeGreaterThan(0);
      expect(e.editIndex).toBeGreaterThan(1); // never the system prompt / task
    }
    // The run summary carries the gauge and the projection; costs match the replay's own arithmetic.
    expect(summary.providerTurns).toBe(P.length);
    expect(summary.peakPromptTokens).toBe(Math.max(...P));
    expect(summary.costUsd).toBeCloseTo(cost, 4);
    expect(summary.noCacheUsd).toBeGreaterThan(summary.costUsd * 3); // ~97 % append-only hit ⇒ cache is worth ≥3×
    expect(summary.cacheBreaks).toBe(0); // append-only: the real run never broke its cache
    expect(summary.tokensAbove128k).toBeGreaterThan(0);
    expect(summary.t1Events).toBe(events.length);
    // Projected net list-priced saving after the cache breaks: measured 20.5–31.2 % (report's sim at T 100–128k: 26–32 %).
    // The stage-2 bar is "predicted $ −15 % or better".
    expect(summary.t1NetSavingUsd).toBeGreaterThan(0);
    expect(summary.t1SavingPct).toBeGreaterThanOrEqual(0.15);
    expect(summary.t1SavingPct).toBeLessThan(0.6);
    expect(summary.t1PeakSimPromptTokens).toBeLessThan(summary.peakPromptTokens);
    // pre-rot: ONE row per threshold crossed
    const prerot = rows('prerot').map((r: any) => r.meta.threshold);
    expect(prerot).toEqual(Math.max(...P) >= 200_000 ? [128_000, 200_000] : [128_000]);
  });

  it('records the steer distance on every event (exit bar: no event right after a steer)', () => {
    const P = runs['6b7b7692'];
    const { events } = replay(P, { steerAt: 60 });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(typeof e.roundsSinceSteer === 'number' || e.roundsSinceSteer === null).toBe(true);
  });

  it('a prompt that never crosses T makes no shadow event; estimated turns never feed the gauge', () => {
    const gauge = new ContextGauge({ profile: 'chat', priceOf: () => GLM_LIST });
    const ms: ContextMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }];
    expect(gauge.observeTurn({ step: 0, model: 'm', usage: null, messages: ms })).toBeNull();
    expect(gauge.observeTurn({ step: 1, model: 'm', usage: { promptTokens: 60_000, completionTokens: 10, cachedTokens: 40_000 }, messages: ms })).toEqual({ promptTokens: 60_000, cachedTokens: 40_000, cacheHit: 0.667 });
    gauge.finish({ compactions: 1, chatClears: 2 });
    gauge.finish({ compactions: 1 }); // idempotent
    expect(rows('tier1_shadow')).toEqual([]);
    expect(rows('prerot')).toEqual([]);
    const s = rows('run_summary');
    expect(s).toHaveLength(1);
    expect(s[0].meta).toMatchObject({ turns: 2, providerTurns: 1, compactions: 1, chatClears: 2, cacheHitRatio: 0.667, t1Events: 0 });
  });

  it('counts a real cache break (cached share collapses after a prefix edit)', () => {
    const gauge = new ContextGauge({ profile: 'chat', priceOf: () => GLM_LIST });
    const ms: ContextMessage[] = [{ role: 'system', content: 'S' }];
    gauge.observeTurn({ step: 0, model: 'm', usage: { promptTokens: 80_000, completionTokens: 1, cachedTokens: 0 }, messages: ms });
    gauge.observeTurn({ step: 1, model: 'm', usage: { promptTokens: 85_000, completionTokens: 1, cachedTokens: 79_000 }, messages: ms });
    gauge.observeTurn({ step: 2, model: 'm', usage: { promptTokens: 60_000, completionTokens: 1, cachedTokens: 20_000 }, messages: ms }); // compacted
    gauge.finish({ compactions: 1 });
    expect(rows('run_summary')[0].meta.cacheBreaks).toBe(1);
  });

  it('a run with no provider-reported turn records no summary row', () => {
    const gauge = new ContextGauge({ profile: 'coding' });
    gauge.observeTurn({ step: 0, model: 'm', usage: null, messages: [] });
    gauge.finish({ compactions: 0 });
    expect(rows()).toEqual([]);
  });

  it('CONTEXT_GAUGE_DISABLED reads the switch', () => {
    expect(contextGaugeDisabled()).toBe(false);
    process.env.CONTEXT_GAUGE_DISABLED = '1';
    expect(contextGaugeDisabled()).toBe(true);
  });

  it('STEER_MARKER_TEXT stays equal to compaction.ts STEER_MARKER', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn() }));
      jest.doMock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
      jest.doMock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn() }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { STEER_MARKER } = require('./compaction');
      expect(STEER_MARKER).toBe(STEER_MARKER_TEXT);
    });
  });
});

// ── Chat fast path ───────────────────────────────────────────────────────────

/** A real chat-turn shape: L2 research — 5 SERP / scrape rounds of ~14k-char results on a 100k-char chat budget. */
function chatTurn(): ContextMessage[] {
  const ms: ContextMessage[] = [{ role: 'system', content: 'S'.repeat(8_000) }, { role: 'user', content: 'Compare the three 2026 heat-pump rebates in Ontario.' }];
  for (let i = 0; i < 5; i++) {
    ms.push({ role: 'assistant', content: '', tool_calls: [{ id: `w${i}`, type: 'function', function: { name: i % 2 ? 'scrape_as_markdown' : 'search_engine', arguments: `{"query":"rebate ${i}"}` } }] });
    ms.push({ role: 'tool', tool_call_id: `w${i}`, content: `PAGE ${i}: ` + 'y'.repeat(14_000) });
  }
  return ms;
}
const sizeOf = (ms: ContextMessage[]) => ms.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);

describe('chat fast path', () => {
  it('mode switch: default canary — the owner canary ACTS, everyone else shadows; act / shadow / off; never a supervisor-sized budget or a coding run', () => {
    expect(chatContextClearingMode()).toBe('canary');
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 100_000, userId: OWNER_CANARY_USER_ID })).toBe('act');
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 100_000, userId: 'someone-else' })).toBe('shadow');
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 100_000, userId: null })).toBe('shadow'); // guests
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 1_000_000, userId: OWNER_CANARY_USER_ID })).toBeNull(); // supervisors keep the summariser
    expect(chatClearingDecision({ profileKind: 'coding', budgetChars: 100_000, userId: OWNER_CANARY_USER_ID })).toBeNull();
    process.env.CHAT_CONTEXT_CLEARING = 'act';
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 100_000, userId: 'someone-else' })).toBe('act');
    process.env.CHAT_CONTEXT_CLEARING = 'shadow';
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 100_000, userId: OWNER_CANARY_USER_ID })).toBe('shadow');
    process.env.CHAT_CONTEXT_CLEARING = 'off';
    expect(chatClearingDecision({ profileKind: 'chat', budgetChars: 100_000, userId: OWNER_CANARY_USER_ID })).toBeNull();
  });

  it('act: clears old results under the trigger with NO network call; the newest rounds stay raw; one cleared row', () => {
    const ms = chatTurn();
    const before = sizeOf(ms);
    expect(before).toBeGreaterThan(70_000); // over the 0.7 × 100k trigger — today this costs an ~9 s summary
    const out = chatFastPathClear(ms, { decision: 'act', beforeChars: before, budgetChars: 100_000, triggerChars: 70_000, step: 5, sessionId: 'chat-1' })!;
    expect(out).not.toBeNull();
    expect(sizeOf(out)).toBeLessThanOrEqual(70_000);
    expect(out.length).toBe(ms.length);
    expect(String(out[out.length - 1].content)).toBe(String(ms[ms.length - 1].content)); // newest round raw
    expect(String(out[3].content)).toMatch(/^\[cleared to save context: search_engine/);
    const r = rows('chat_clear');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sessionId: 'chat-1', unit: 'chars', meta: expect.objectContaining({ outcome: 'cleared', decision: 'act', step: 5 }) });
    expect(r[0].meta.afterChars).toBe(sizeOf(out));
  });

  it('shadow: records what the clear would free and returns null (the summariser runs as before)', () => {
    const ms = chatTurn();
    expect(chatFastPathClear(ms, { decision: 'shadow', beforeChars: sizeOf(ms), budgetChars: 100_000, triggerChars: 70_000, step: 5 })).toBeNull();
    expect(rows('chat_clear')[0].meta).toMatchObject({ outcome: 'shadow', decision: 'shadow' });
    expect(rows('chat_clear')[0].value).toBeGreaterThan(0);
  });

  it('insufficient: a transcript the clear cannot bring under the trigger falls back to the summariser (null)', () => {
    const ms = chatTurn();
    ms.splice(2, 0, { role: 'user', content: 'Q'.repeat(60_000) }); // a huge pasted document — never cleared
    expect(chatFastPathClear(ms, { decision: 'act', beforeChars: sizeOf(ms), budgetChars: 100_000, triggerChars: 70_000, step: 5 })).toBeNull();
    expect(rows('chat_clear')[0].meta.outcome).toBe('insufficient');
  });

  it('nothing clearable (one round only) ⇒ null + a nothing_clearable row', () => {
    const ms = chatTurn().slice(0, 4);
    expect(chatFastPathClear(ms, { decision: 'act', beforeChars: 999_999, budgetChars: 100_000, triggerChars: 70_000, step: 1 })).toBeNull();
    expect(rows('chat_clear')[0].meta.outcome).toBe('nothing_clearable');
  });
});
