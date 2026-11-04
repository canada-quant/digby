/**
 * tool-intent-gate.ts — decision-gate purpose 'tool_intent' (N10, 2026-09-25; shadow telemetry only).
 *
 *  - options are POSITIONAL (option_1 = the emitted tool, then tools named in the tail,
 *    then recent calls), deduped and bounded, and the question text depends only on the
 *    option COUNT (so questionsHash partitions by n, never by which tools were offered);
 *  - the state carries the model's own reasoning/content tails — never tool results;
 *  - every decision gets a meta.label 'regex' outcome when the answer lands and a
 *    'next_call' outcome when the next turn's first call is dispatched;
 *  - a ONE-option set (nothing else named, no other recent tool — the first call of
 *    nearly every run) is never asked and consumes no cap slot (review 2026-09-25);
 *  - mode off, the kill switch, the per-run cap and thin narration make it inert;
 *  - observe() is synchronous and never throws (the seat is never awaited on the loop).
 */

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'shadow');
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  DECISION_MAX_OPTIONS: 20,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  buildToolIntentOptions, buildToolIntentQuestions, buildToolIntentState, createToolIntentShadow, optionKeyFor,
  toolIntentRunCap, toolsNamedInTail, TOOL_INTENT_NOT_AN_OPTION, TOOL_INTENT_QUESTION,
} from './tool-intent-gate';

const flush = () => new Promise<void>((r) => setImmediate(r));
const OFFERED = ['run_command', 'write_file', 'read_file', 'update_feedback', 'list_schedules', 'send_chat_message'];
const decisionFor = (choice: string, confidence = 0.9) => ({ id: 'd-' + choice, mode: 'shadow', backend: 'TypeSafe Jev', ms: 50, answers: { [TOOL_INTENT_QUESTION]: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } } });

const saved: Record<string, string | undefined> = {};
const ENV = ['DECISION_GATE_TOOL_INTENT_RUN_CAP'];
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockDecide.mockReset().mockResolvedValue(null);
  mockMode.mockReset().mockReturnValue('shadow');
  mockRecord.mockReset();
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('pure builders', () => {
  it('toolsNamedInTail: whole-word mentions only, ordered by LAST mention (closest to the call first)', () => {
    expect(toolsNamedInTail('Read the config, then run_command to build. Now write_file the script.', OFFERED)).toEqual(['write_file', 'run_command']);
    expect(toolsNamedInTail('read_files is not readfile; list_schedules_x no', OFFERED)).toEqual([]);
  });
  it('buildToolIntentOptions: emitted first, tail names next, recent (newest first) last, deduped, ≤ 20', () => {
    const o = buildToolIntentOptions('update_feedback', ['run_command', 'update_feedback'], ['read_file', 'run_command', 'write_file']);
    expect(o.keys).toEqual(['option_1', 'option_2', 'option_3', 'option_4']);
    expect(o.byKey).toEqual({ option_1: 'update_feedback', option_2: 'run_command', option_3: 'write_file', option_4: 'read_file' });
    const many = buildToolIntentOptions('t0', [], Array.from({ length: 40 }, (_, i) => `t${i + 1}`));
    expect(many.keys).toHaveLength(20);
    expect(optionKeyFor(o, 'write_file')).toBe('option_3');
    expect(optionKeyFor(o, 'nope')).toBeNull();
  });
  it('the question text depends only on the option COUNT — same keys ⇒ byte-identical question', () => {
    const a = buildToolIntentQuestions(['option_1', 'option_2', 'option_3']);
    const b = buildToolIntentQuestions(['option_1', 'option_2', 'option_3']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect((a[TOOL_INTENT_QUESTION] as any).criteria).toEqual({ option_1: expect.stringContaining('option_1'), option_2: expect.any(String), option_3: expect.any(String) });
    expect(JSON.stringify(a)).not.toContain('run_command');
  });
  it('the state names the emitted key, the option table and the two tails — bounded, tool results never present', () => {
    const options = buildToolIntentOptions('run_command', [], []);
    const state = buildToolIntentState({ emitted: 'run_command', reasoning: 'r'.repeat(5000), content: 'c'.repeat(3000), options, step: 4 });
    expect(state).toMatchObject({ emitted_tool: 'option_1', options: { option_1: 'run_command' }, step: 4 });
    expect((state.reasoning_tail as string).length).toBe(1500);
    expect((state.content_tail as string).length).toBe(1000);
    expect(Object.keys(state)).not.toContain('tool_results');
    const empty = buildToolIntentState({ emitted: 'x', reasoning: '', content: '', options });
    expect(empty).not.toHaveProperty('reasoning_tail');
  });
  it('the run cap reads DECISION_GATE_TOOL_INTENT_RUN_CAP, clamped 0..200, default 16', () => {
    expect(toolIntentRunCap()).toBe(16);
    process.env.DECISION_GATE_TOOL_INTENT_RUN_CAP = '999';
    expect(toolIntentRunCap()).toBe(200);
    process.env.DECISION_GATE_TOOL_INTENT_RUN_CAP = '0';
    expect(toolIntentRunCap()).toBe(0);
  });
});

describe('createToolIntentShadow', () => {
  const obs = (emitted: string, over: Partial<Parameters<ReturnType<typeof createToolIntentShadow>['observe']>[0]> = {}) => ({
    emitted, reasoning: 'I need to see the build output first. Shell first: run_command to build the target.', content: '',
    offeredNames: OFFERED, recentTools: ['read_file'], regexVerdict: null, step: 2, ...over,
  });

  it('asks the gate with option_1 = emitted; records label:regex when the answer lands; records label:next_call at the next call', async () => {
    mockDecide.mockResolvedValue(decisionFor('option_2', 0.91));
    const shadow = createToolIntentShadow({ sessionId: 'c1', runId: 'r1' });
    shadow.observe(obs('update_feedback', { regexVerdict: 'run_command' }));
    expect(shadow.asked).toBe(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(opts).toMatchObject({ purpose: 'tool_intent', sessionId: 'c1' });
    expect(state.options).toEqual({ option_1: 'update_feedback', option_2: 'run_command', option_3: 'read_file' });
    expect(Object.keys(questions[TOOL_INTENT_QUESTION].criteria)).toHaveLength(3);
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toBe('tool_intent');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: TOOL_INTENT_QUESTION, actual: 'option_2', acted: false, sessionId: 'c1', label: 'regex', note: expect.stringContaining('label:regex mismatch→run_command') });
    expect(mockRecord.mock.calls[0][2].note).not.toContain('batch');
    // The next dispatched call closes the previous decision with label:next_call.
    mockDecide.mockResolvedValue(null);
    shadow.observe(obs('run_command'));
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: 'option_2', label: 'next_call', note: expect.stringContaining('label:next_call run_command') });
  });

  it('a ONE-option set is never asked: decide not called, no cap slot consumed, no pending decision to close', async () => {
    mockDecide.mockResolvedValue(decisionFor('option_1'));
    const shadow = createToolIntentShadow({ sessionId: 'c1' });
    // The first call of a run: narration names only the emitted tool, nothing dispatched yet.
    shadow.observe(obs('read_file', { reasoning: 'Let me read the file first to understand the current shape of the module.', recentTools: [] }));
    expect(mockDecide).not.toHaveBeenCalled();
    expect(shadow.asked).toBe(0);
    // Later: emitted == the only recent tool and the tail names nothing else — still one option.
    shadow.observe(obs('read_file', { reasoning: 'Now the second half of that same file, to see the export list.', recentTools: ['read_file'] }));
    expect(mockDecide).not.toHaveBeenCalled();
    expect(shadow.asked).toBe(0);
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
    // A genuine two-option call afterwards is asked as normal.
    shadow.observe(obs('run_command', { recentTools: ['read_file', 'read_file'] }));
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(shadow.asked).toBe(1);
    expect(mockDecide.mock.calls[0][0].options).toEqual({ option_1: 'run_command', option_2: 'read_file' });
  });

  it('a batched turn (batchCalls > 1) is ONE decision: the batch size rides the state and both outcome notes', async () => {
    mockDecide.mockResolvedValue(decisionFor('option_1'));
    const shadow = createToolIntentShadow({ sessionId: 'c1' });
    shadow.observe(obs('run_command', { batchCalls: 5 }));
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][0]).toMatchObject({ batch_calls: 5 });
    await flush();
    expect(mockRecord.mock.calls[0][2].note).toContain('batch 5');
    mockDecide.mockResolvedValue(null);
    shadow.observe(obs('write_file'));
    await flush();
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ label: 'next_call', note: expect.stringContaining('batch 5') });
    // batchCalls 1 / absent: no batch key in the state.
    mockDecide.mockResolvedValue(decisionFor('option_1'));
    shadow.observe(obs('run_command', { batchCalls: 1 }));
    expect(mockDecide.mock.calls[1][0]).not.toHaveProperty('batch_calls');
  });

  it('an acquitting regex verdict labels the EMITTED tool (option_1); a next call outside the option set labels not_an_option', async () => {
    mockDecide.mockResolvedValue(decisionFor('option_1', 0.97));
    const shadow = createToolIntentShadow({ sessionId: 'c1' });
    shadow.observe(obs('run_command', { regexVerdict: null }));
    await flush();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'option_1', note: expect.stringContaining('label:regex aligned') });
    mockDecide.mockResolvedValue(null);
    shadow.observe(obs('todo_create', { reasoning: '' }));
    await flush();
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: TOOL_INTENT_NOT_AN_OPTION, note: expect.stringContaining('(not an option)') });
  });

  it('thunked recentTools / regexVerdict are evaluated only when a decision is asked (mode off ⇒ never)', async () => {
    const recent = jest.fn(() => ['read_file']);
    const regex = jest.fn(() => 'run_command');
    mockMode.mockReturnValue('off');
    createToolIntentShadow({}).observe(obs('update_feedback', { recentTools: recent, regexVerdict: regex }));
    expect(recent).not.toHaveBeenCalled();
    expect(regex).not.toHaveBeenCalled();
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(decisionFor('option_2'));
    createToolIntentShadow({}).observe(obs('update_feedback', { recentTools: recent, regexVerdict: regex }));
    expect(recent).toHaveBeenCalledTimes(1);
    expect(regex).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'option_2', note: expect.stringContaining('mismatch→run_command') });
  });

  it('a null gate answer records nothing and leaves no pending decision', async () => {
    const shadow = createToolIntentShadow({ sessionId: 'c1' });
    shadow.observe(obs('run_command'));
    shadow.observe(obs('write_file'));
    await flush();
    expect(shadow.asked).toBe(2);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('mode off, thin narration, no offered tools and the cap make it inert (but a pending decision still closes)', async () => {
    mockMode.mockReturnValue('off');
    const s1 = createToolIntentShadow({});
    s1.observe(obs('run_command'));
    expect(mockDecide).not.toHaveBeenCalled();
    mockMode.mockReturnValue('shadow');
    s1.observe(obs('run_command', { reasoning: 'ok', content: '' }));
    s1.observe(obs('run_command', { offeredNames: [] }));
    expect(mockDecide).not.toHaveBeenCalled();
    process.env.DECISION_GATE_TOOL_INTENT_RUN_CAP = '1';
    mockDecide.mockResolvedValue(decisionFor('option_1'));
    s1.observe(obs('run_command'));
    s1.observe(obs('write_file')); // over the cap: closes the pending one, asks nothing new
    expect(mockDecide).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(2); // label:regex + label:next_call for the one decision
  });

  it('never throws into the loop — a throwing decide is contained', async () => {
    mockDecide.mockImplementation(() => { throw new Error('boom'); });
    const shadow = createToolIntentShadow({});
    expect(() => shadow.observe(obs('run_command'))).not.toThrow();
    mockDecide.mockRejectedValue(new Error('later'));
    expect(() => shadow.observe(obs('write_file'))).not.toThrow();
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
