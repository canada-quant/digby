/**
 * routeMessageAuto × decision gate (purpose 'auto_route') + the patience plan
 * Phase 1a riders (docs/PATIENCE_AUTO_ONLY_DEPRECATION_PLAN_2026-09-25.md §5.1):
 *  - off returns the heuristic; shadow returns it immediately and records
 *    actual = heuristic.level, acted:false, meta.heuristic / segment / modeSource;
 *  - act uses the gate at/above threshold (result.mode gates it), falls back
 *    below, and fails open on a throw;
 *  - allowDeepResearch:false clamps L3 → thinking with reasonKey + clamped,
 *    the outcome's actual stays PRE-clamp;
 *  - the generic DECISION_GATE_THRESHOLD_AUTO_ROUTE can never lower the L3
 *    bar below 0.85; the per-option env can;
 *  - the label window (shadowAutoRouteAgainst) records note user_picked /
 *    user_default / user_explicit with actual = the user's level on the
 *    decision SEAT chain by default (2026-09-26 — owner Q1 answered; was the
 *    deepseek-flash readout), honours LABEL_WINDOW_DECISION_SPEC, the kill
 *    switch + sample percent.
 * decision-gate is a mocked boundary (thresholds mirror the real env reads).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDecide: jest.Mock = jest.fn();
const mockMode: jest.Mock = jest.fn();
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => {
  const clamp = (v: number) => Math.min(1, Math.max(0.5, v));
  // Mirrors the real reader incl. the 2026-09-26 blank rule: '' / whitespace = unset.
  const num = (raw: string | undefined) => (raw === undefined || String(raw).trim() === '' ? NaN : Number(raw));
  const threshold = (p: string, fallback: number) => {
    const raw = num(process.env[`DECISION_GATE_THRESHOLD_${p.toUpperCase()}`]);
    return clamp(Number.isFinite(raw) ? raw : fallback);
  };
  return {
    __esModule: true,
    decide: (...a: any[]) => mockDecide(...a),
    decisionMode: (...a: any[]) => mockMode(...a),
    decisionThreshold: threshold,
    decisionOptionThreshold: (p: string, option: string, fallback: number) => {
      const raw = num(process.env[`DECISION_GATE_THRESHOLD_${p.toUpperCase()}_${option.toUpperCase()}`]);
      return Number.isFinite(raw) ? clamp(raw) : threshold(p, fallback);
    },
    recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
  };
});

// roster 2026-10-06 B-2: the human-turn retirement records one decision_ask_retired row (platform/human-turn-retirement.ts).
const mockLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockLoopMetric(...a) }));

import { routeMessageAuto, shadowAutoRouteAgainst, autoRouteThreshold, labelWindowNote, labelWindowSpec, normalizeModeSource, autoRouteQuestions, LABEL_WINDOW_DEFAULT_SPEC } from './auto-router-gate';

const ENV_KEYS = ['DECISION_GATE_THRESHOLD_AUTO_ROUTE', 'DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH', 'DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED', 'LABEL_WINDOW_SAMPLE_PERCENT', 'LABEL_WINDOW_DECISION_SPEC', 'DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED', 'DECISION_GATE_AUTO_ROUTE_HUMAN_RETIRE_LIFTED'];
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  // roster 2026-10-06 B-2: the suites below pin the ASK behaviour — under the kill switch that restores it on human
  // segments. The retirement default has its own describe at the bottom.
  process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED = '1';
  mockMode.mockReturnValue('shadow');
});

const choice = (level: string, confidence: number, mode: 'shadow' | 'act' = 'act') => ({
  id: 'd1', backend: 'TypeSafe Jev', ms: 12, mode,
  answers: { level: { type: 'choice', choice: level, confidence, probabilities: { [level]: confidence } } },
});
const flush = () => new Promise(res => setImmediate(res));

const SIMPLE = 'What is the capital of France?';
const RESEARCH = 'Please research the EV battery market and cite sources.';

describe('routeMessageAuto', () => {
  it('off: the heuristic answers, the gate is never asked', async () => {
    mockMode.mockReturnValue('off');
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false });
    expect(out).toMatchObject({ level: 'single_thinking', source: 'heuristic', reasonKey: 'simple_lookup', heuristicLevel: 'single_thinking' });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('shadow: the heuristic answers IMMEDIATELY (gate still pending); the outcome row carries actual=heuristic, acted:false, heuristic/segment/modeSource', async () => {
    let resolve!: (v: any) => void;
    mockDecide.mockReturnValue(new Promise(r => { resolve = r; }));
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, sessionId: 'c1', segment: 'user', modeSource: 'default' });
    expect(out.level).toBe('single_thinking');
    expect(out.source).toBe('heuristic');
    expect(mockRecord).not.toHaveBeenCalled();
    resolve(choice('thinking', 0.9, 'shadow'));
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, purpose, outcome] = mockRecord.mock.calls[0];
    expect(purpose).toBe('auto_route');
    expect(outcome).toMatchObject({ question: 'level', actual: 'single_thinking', acted: false, sessionId: 'c1' });
    expect(outcome.extra).toMatchObject({ heuristic: 'single_thinking', source: 'heuristic', segment: 'user', modeSource: 'default', reasonKey: 'simple_lookup' });
    // The gate saw ONLY the typed message + the workspace flag (§3.3).
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(Object.keys(state).sort()).toEqual(['chat_has_code_workspace', 'message']);
    expect(Object.keys(questions)).toEqual(['level']);
    expect(opts).toMatchObject({ purpose: 'auto_route', sessionId: 'c1' });
  });

  it('act: a confident answer at/above threshold picks the level (source decision, acted:true)', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('thinking', 0.8));
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false });
    expect(out).toMatchObject({ level: 'thinking', source: 'decision', reasonKey: 'decision_gate', confidence: 0.8, backend: 'TypeSafe Jev', heuristicLevel: 'single_thinking' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'single_thinking', acted: true });
    expect(mockRecord.mock.calls[0][2].extra).toMatchObject({ source: 'decision' });
  });

  it('act: below threshold falls back to the heuristic (acted:false)', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('thinking', 0.6));
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false });
    expect(out.level).toBe('single_thinking');
    expect(out.source).toBe('heuristic');
    expect(mockRecord.mock.calls[0][2].acted).toBe(false);
  });

  it('act: Level 3 needs the stricter 0.85 bar', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('deep_research', 0.8));
    expect((await routeMessageAuto({ content: SIMPLE, hasWorkspace: false })).level).toBe('single_thinking');
    mockDecide.mockResolvedValue(choice('deep_research', 0.9));
    expect((await routeMessageAuto({ content: SIMPLE, hasWorkspace: false })).level).toBe('deep_research');
  });

  it("act: the RESULT's mode gates acting — an uncalibrated answer (mode 'shadow') never routes", async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('thinking', 0.99, 'shadow'));
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false });
    expect(out.level).toBe('single_thinking');
    expect(mockRecord.mock.calls[0][2].acted).toBe(false);
  });

  it('act: a throwing gate fails open to the heuristic', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockRejectedValue(new Error('timeout'));
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false });
    expect(out.level).toBe('single_thinking');
    expect(out.source).toBe('heuristic');
  });

  it('allowDeepResearch:false clamps a Level 3 pick to Ensemble AFTER the decision; the outcome actual stays pre-clamp', async () => {
    mockDecide.mockResolvedValue(choice('deep_research', 0.9, 'shadow'));
    const out = await routeMessageAuto({ content: RESEARCH, hasWorkspace: false, allowDeepResearch: false });
    expect(out).toMatchObject({ level: 'thinking', requestedLevel: 'deep_research', clamped: 'quota', reasonKey: 'quota_exhausted', heuristicLevel: 'deep_research' });
    expect(out.reason).toContain('demoted to Ensemble');
    await flush();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'deep_research' });
    expect(mockRecord.mock.calls[0][2].extra).toMatchObject({ clamped: 'quota', reasonKey: 'quota_exhausted', heuristic: 'deep_research' });
    // The clamp never reaches the gate's state or question.
    expect(mockDecide.mock.calls[0][0]).not.toHaveProperty('allowDeepResearch');
  });

  it('the clamp reason follows the allowance (guest_no_research / quota_unavailable); a non-L3 pick is never clamped', async () => {
    mockMode.mockReturnValue('off');
    expect((await routeMessageAuto({ content: RESEARCH, hasWorkspace: false, allowDeepResearch: false, allowDeepResearchReason: 'guest_no_research' })).reasonKey).toBe('guest_no_research');
    expect((await routeMessageAuto({ content: RESEARCH, hasWorkspace: false, allowDeepResearch: false, allowDeepResearchReason: 'quota_unavailable' })).reasonKey).toBe('quota_unavailable');
    const simple = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, allowDeepResearch: false });
    expect(simple).toMatchObject({ level: 'single_thinking', reasonKey: 'simple_lookup' });
    expect(simple.clamped).toBeUndefined();
  });

  it('act + clamp: a confident gate L3 under allowDeepResearch:false ships as thinking with source decision', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('deep_research', 0.95));
    const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, allowDeepResearch: false });
    expect(out).toMatchObject({ level: 'thinking', source: 'decision', clamped: 'quota', requestedLevel: 'deep_research', reasonKey: 'quota_exhausted' });
  });
});

describe('autoRouteThreshold (per-option Level 3 bar)', () => {
  it('defaults: 0.7 for L1/L2, 0.85 for L3', () => {
    expect(autoRouteThreshold('single_thinking')).toBe(0.7);
    expect(autoRouteThreshold('thinking')).toBe(0.7);
    expect(autoRouteThreshold('deep_research')).toBe(0.85);
  });
  it('the generic env moves L1/L2 but can never LOWER the L3 bar below 0.85', () => {
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '0.6';
    expect(autoRouteThreshold('thinking')).toBe(0.6);
    expect(autoRouteThreshold('deep_research')).toBe(0.85);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '0.95';
    expect(autoRouteThreshold('deep_research')).toBe(0.95); // raising is fine
  });
  it('the explicit per-option env (the Phase 2 refit) can set the L3 bar, lower included', () => {
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '0.6';
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH = '0.75';
    expect(autoRouteThreshold('deep_research')).toBe(0.75);
  });
  it('audit 2026-09-26 (settings-switches-1): a BLANK per-option env (compose passthrough) never bypasses the 0.85 floor; a blank generic env is unset too', () => {
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH = '';
    expect(autoRouteThreshold('deep_research')).toBe(0.85);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH = '   ';
    expect(autoRouteThreshold('deep_research')).toBe(0.85);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '';
    expect(autoRouteThreshold('thinking')).toBe(0.7);
    expect(autoRouteThreshold('deep_research')).toBe(0.85);
  });
});

describe('label window — shadowAutoRouteAgainst', () => {
  it('records actual = the user\'s level, note by modeSource, meta.heuristic + labelWindow, on the SEAT chain by default (no spec pin — Q1 answered 2026-09-26)', async () => {
    mockDecide.mockResolvedValue(choice('single_thinking', 0.9, 'shadow'));
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false, sessionId: 'c9' }, 'thinking', { modeSource: 'picked' });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'auto_route', sessionId: 'c9' });
    expect(mockDecide.mock.calls[0][2].spec).toBeUndefined();
    expect(mockDecide.mock.calls[0][2].memo).toBeUndefined(); // the seat chain memoises on its own
    // Same question shape as the router (one questionsHash partition).
    expect(mockDecide.mock.calls[0][1]).toEqual(autoRouteQuestions());
    const [, , outcome] = mockRecord.mock.calls[0];
    expect(outcome).toMatchObject({ question: 'level', actual: 'thinking', acted: false, note: 'user_picked', sessionId: 'c9' });
    expect(outcome.extra).toMatchObject({ heuristic: 'single_thinking', labelWindow: true, segment: 'user', modeSource: 'picked' });
  });

  it('notes: picked → user_picked; default/restored → user_default; no signal → user_explicit — and ONLY picked makes a call (§4.2: a default / restored / unsignalled level is not a human label; zero egress until the client sends modeSource)', async () => {
    expect(labelWindowNote('picked')).toBe('user_picked');
    expect(labelWindowNote('default')).toBe('user_default');
    expect(labelWindowNote('restored')).toBe('user_default');
    expect(labelWindowNote(undefined)).toBe('user_explicit');
    mockDecide.mockResolvedValue(choice('thinking', 0.9, 'shadow'));
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'deep_research', {});
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'deep_research', { modeSource: 'default' });
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'deep_research', { modeSource: 'restored' });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'deep_research', { modeSource: 'picked' });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2].note).toBe('user_picked');
  });

  it('default spec is "seat" (the seat chain); LABEL_WINDOW_DECISION_SPEC pins another backend with memo:true (the pre-Q1 deepseek-flash readout still works)', async () => {
    expect(LABEL_WINDOW_DEFAULT_SPEC).toBe('seat');
    expect(labelWindowSpec()).toBeUndefined();
    process.env.LABEL_WINDOW_DECISION_SPEC = '  ';
    expect(labelWindowSpec()).toBeUndefined(); // blank = default
    process.env.LABEL_WINDOW_DECISION_SPEC = 'SEAT';
    expect(labelWindowSpec()).toBeUndefined();
    process.env.LABEL_WINDOW_DECISION_SPEC = 'deepseek-flash';
    expect(labelWindowSpec()).toBe('deepseek-flash');
    mockDecide.mockResolvedValue(choice('single_thinking', 0.9, 'shadow'));
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false, sessionId: 'c9' }, 'thinking', { modeSource: 'picked' });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'auto_route', spec: 'deepseek-flash', memo: true, sessionId: 'c9' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'thinking', note: 'user_picked' });
  });

  it('kill switch, purpose off and sample percent 0 make no call; the percent samples; "seat" uses the seat chain', async () => {
    mockDecide.mockResolvedValue(choice('thinking', 0.9, 'shadow'));
    const picked = { modeSource: 'picked' as const };
    process.env.DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED = '1';
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', picked);
    delete process.env.DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED;
    mockMode.mockReturnValueOnce('off');
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', picked);
    process.env.LABEL_WINDOW_SAMPLE_PERCENT = '0';
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', picked);
    expect(mockDecide).not.toHaveBeenCalled();
    process.env.LABEL_WINDOW_SAMPLE_PERCENT = '50';
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', { ...picked, random: () => 0.9 });
    expect(mockDecide).not.toHaveBeenCalled();
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', { ...picked, random: () => 0.1 });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    process.env.LABEL_WINDOW_SAMPLE_PERCENT = '100';
    process.env.LABEL_WINDOW_DECISION_SPEC = 'seat';
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', picked);
    expect(mockDecide.mock.calls[1][2].spec).toBeUndefined();
    expect(mockDecide.mock.calls[1][2].memo).toBeUndefined(); // the seat chain memoises on its own
  });

  it('never throws — a gate error is swallowed (the send is unaffected)', async () => {
    mockDecide.mockRejectedValue(new Error('boom'));
    await expect(shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false }, 'thinking', { modeSource: 'picked' })).resolves.toBeUndefined();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('normalizeModeSource', () => {
  it('accepts picked/default/restored (case-insensitive), ignores everything else', () => {
    expect(normalizeModeSource('picked')).toBe('picked');
    expect(normalizeModeSource(' Restored ')).toBe('restored');
    expect(normalizeModeSource('auto')).toBeUndefined();
    expect(normalizeModeSource(undefined)).toBeUndefined();
    expect(normalizeModeSource(42)).toBeUndefined();
  });
});

describe('roster 2026-10-06 B-2 — auto_route retired on HUMAN turns', () => {
  beforeEach(() => { delete process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED; });

  it('a human segment (user / guest / telegram / supervisor) takes the heuristic level with NO ask and ONE decision_ask_retired row — exactly what OFF returns', async () => {
    for (const segment of ['user', 'guest', 'telegram', 'supervisor'] as const) {
      jest.clearAllMocks();
      const out = await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, sessionId: 'c1', segment });
      expect(out).toMatchObject({ level: 'single_thinking', source: 'heuristic' });
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(mockLoopMetric).toHaveBeenCalledTimes(1);
      expect(mockLoopMetric.mock.calls[0][0]).toMatchObject({ kind: 'decision_ask_retired', sessionId: 'c1', meta: { purpose: 'auto_route', site: 'route', segment } });
    }
  });

  it('the allowance clamp still applies on the retired path (a heuristic Level 3 without quota is Ensemble)', async () => {
    const out = await routeMessageAuto({ content: RESEARCH, hasWorkspace: false, segment: 'user', allowDeepResearch: false, allowDeepResearchReason: 'quota_exhausted' });
    expect(out).toMatchObject({ level: 'thinking', requestedLevel: 'deep_research', clamped: 'quota', reasonKey: 'quota_exhausted', heuristicLevel: 'deep_research', source: 'heuristic' });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('a MACHINE segment and an unsegmented caller still ask (machine sends keep the shadow ask; legacy callers unchanged)', async () => {
    mockDecide.mockResolvedValue(choice('single_thinking', 0.9, 'shadow'));
    await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, segment: 'machine' });
    await routeMessageAuto({ content: SIMPLE, hasWorkspace: false });
    await new Promise(r => setImmediate(r));
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(mockLoopMetric).not.toHaveBeenCalled();
  });

  it('mode off ⇒ no ask and no retired row (nothing was skipped)', async () => {
    mockMode.mockReturnValue('off');
    await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, segment: 'user' });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockLoopMetric).not.toHaveBeenCalled();
  });

  it('the label window is retired with it (a picked explicit level makes no ask, one retired row)', async () => {
    await shadowAutoRouteAgainst({ content: SIMPLE, hasWorkspace: false, sessionId: 'c9' }, 'thinking', { modeSource: 'picked' });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockLoopMetric.mock.calls[0][0]).toMatchObject({ kind: 'decision_ask_retired', meta: { purpose: 'auto_route', site: 'label_window', segment: 'user' } });
  });

  it('kill switches: DECISION_GATE_AUTO_ROUTE_HUMAN_RETIRE_LIFTED=1 (one purpose) and DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 (all) restore the ask', async () => {
    mockDecide.mockResolvedValue(choice('single_thinking', 0.9, 'shadow'));
    process.env.DECISION_GATE_AUTO_ROUTE_HUMAN_RETIRE_LIFTED = '1';
    await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, segment: 'user' });
    delete process.env.DECISION_GATE_AUTO_ROUTE_HUMAN_RETIRE_LIFTED;
    process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED = '1';
    await routeMessageAuto({ content: SIMPLE, hasWorkspace: false, segment: 'user' });
    await new Promise(r => setImmediate(r));
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(mockLoopMetric).not.toHaveBeenCalled();
  });
});
