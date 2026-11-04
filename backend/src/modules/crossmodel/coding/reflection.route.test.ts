/**
 * reflection.ts — decision-gate purpose 'reflection_route' (N8, 2026-09-25).
 *
 *  - the kill switch and mode 'off' never touch the seat; the consult is unchanged;
 *  - shadow → the gate runs CONCURRENTLY with the consult; the label is the
 *    remedy the consult's advice prescribed (classifyConsultAdvice), else the
 *    lane's next tool call when it was the intended different tool, else null;
 *  - act (designed, not enabled) → a confident non-needs_diagnosis RESULT skips
 *    the consult (acted:true); needs_diagnosis / unconfident / an uncalibrated
 *    'shadow' result consults as before;
 *  - every gate failure fails OPEN — the consult runs and its advice returns.
 * Boundary-mocked like reflection.test.ts plus the decision gate.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: { crossModelChat: { findUnique: jest.fn() }, userFeatureRequest: { create: jest.fn() } } }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK') } }));

const mockProviderFor = jest.fn(async (..._a: any[]): Promise<any> => ({ url: 'u', apiKey: 'k', model: 'deepseek-flash', envKey: 'DEEPSEEK_API_KEY', label: 'DeepSeek direct', extra: {} }));
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: jest.fn(async () => 'deepseek-flash'),
  resolveProviderForRun: (...a: any[]) => mockProviderFor(...a),
}));

let consultRelease: (() => void) | null = null;
const mockPost = jest.fn(async (..._a: any[]): Promise<any> => ({ data: { choices: [{ message: { content: 'Call read_file with the real path.' } }] } }));
jest.mock('./helper-completion', () => ({
  __esModule: true,
  postNonStreamingCompletion: (...a: any[]) => mockPost(...a),
  extractNonStreamingAnswer: (c: any) => ({ text: c?.message?.content ?? '' }),
}));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  confidenceOf: (a: any) => (a ? (a.type === 'noul' ? Math.max(a.noul, 1 - a.noul) : a.confidence ?? 0) : 0),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  buildReflectionRouteState, classifyConsultAdvice, consultCrossCheckerOnStreak, labelReflectionRoute,
  REFLECTION_ROUTE_QUESTION, REFLECTION_ROUTE_QUESTIONS, REFLECTION_ROUTES, REFLECTION_ROUTE_HINT, REFLECTION_ROUTE_TIMEOUT_MS, REFLECTION_ROUTE_POST_CONSULT_WAIT_MS, type ReflectionRoutePending, type StreakEvidence,
} from './reflection';

const EV: StreakEvidence = {
  sessionId: 's1', runId: 'r1', tool: 'update_feedback', perma: false, intended: 'run_command',
  recentFailures: ['Tool update_feedback failed: no such ticket "noop"', 'Tool update_feedback failed: no such ticket "noop"'],
  goalHint: 'fix the flaky test',
};

const choice = (mode: 'shadow' | 'act', c: string, confidence: number) => ({
  id: 'd1', mode, backend: 'TypeSafe Jev', ms: 9,
  answers: { [REFLECTION_ROUTE_QUESTION]: { type: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
  mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'Call read_file with the real path.' } }] } });
  consultRelease = null;
});

describe('pure pieces', () => {
  it('the question is a 4-way choice with criteria; the state is the packaged evidence', () => {
    const q = REFLECTION_ROUTE_QUESTIONS[REFLECTION_ROUTE_QUESTION] as any;
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual([...REFLECTION_ROUTES]);
    const s = buildReflectionRouteState(EV);
    expect(s).toMatchObject({ tool: 'update_feedback', second_streak_this_run: false, tool_named_by_agents_own_reasoning: 'run_command', run_goal: 'fix the flaky test' });
    expect(s.trip_shape).toMatch(/3 consecutive failures/);
    expect((s.recent_results_newest_first as string[]).length).toBe(2);
    expect(buildReflectionRouteState({ ...EV, shape: 'success_intent', intended: null }).trip_shape).toMatch(/SUCCEEDED/);
    expect(buildReflectionRouteState({ ...EV, shape: 'success_intent', intended: null })).not.toHaveProperty('tool_named_by_agents_own_reasoning');
    expect(Object.keys(REFLECTION_ROUTE_HINT)).toEqual(['retry_with_corrected_params', 'different_tool', 'deterministic_framework']);
  });

  it('classifyConsultAdvice: clause-level, negation-aware, precedence different_tool > deterministic > retry > diagnosis > null', () => {
    expect(classifyConsultAdvice('The failures are not deterministic. The path parameter is wrong — retry read_file with the real path from ls.', EV)).toBe('retry_with_corrected_params');
    expect(classifyConsultAdvice('Your reasoning named run_command; call run_command instead of update_feedback.', EV)).toBe('different_tool');
    expect(classifyConsultAdvice('This is a different tool problem: use grep instead.', EV)).toBe('different_tool');
    expect(classifyConsultAdvice('This looks like a schema/preflight gate rejecting the id format — it is deterministic; stop retrying and note it.', EV)).toBe('deterministic_framework');
    expect(classifyConsultAdvice('It is unclear from the texts; inspect the error output first before calling anything.', EV)).toBe('needs_diagnosis');
    expect(classifyConsultAdvice('Hmm.', EV)).toBeNull();
    // A GROUNDING read (read_file / ls / grep / search_*) is the retry's own vocabulary, never "a different tool" (review 2026-09-25).
    expect(classifyConsultAdvice('Call read_file with the real path.', EV)).toBe('retry_with_corrected_params');
    expect(classifyConsultAdvice('Read the file with read_file first, then re-issue update_feedback with the real ticket id.', EV)).toBe('retry_with_corrected_params');
    expect(classifyConsultAdvice('Use search_files to find the exact filename, then retry with the correct path.', EV)).toBe('retry_with_corrected_params');
    // …but a genuinely different NON-grounding tool named anywhere in the clause still wins, even after a grounding read.
    expect(classifyConsultAdvice('Use grep to locate the ticket, then call update_canvas to record it.', EV)).toBe('different_tool');
    // …and the lane's own INTENDED tool wins even when it is a grounding read.
    expect(classifyConsultAdvice('Call read_file on the real path.', { tool: 'update_feedback', intended: 'read_file' })).toBe('different_tool');
    expect(classifyConsultAdvice('Call update_feedback with the real ticket id.', EV)).toBe('retry_with_corrected_params'); // the streak tool itself → params
    expect(classifyConsultAdvice('', EV)).toBeNull();
    expect(classifyConsultAdvice(null)).toBeNull();
    // A negated mention does not count: "not a framework issue" + a retry prescription → retry.
    expect(classifyConsultAdvice('This is not a framework issue. Re-issue the same call with the ticket id you actually read.', EV)).toBe('retry_with_corrected_params');
    // The intended tool named positively wins even without the "instead" shape.
    expect(classifyConsultAdvice('Use run_command to run the test directly.', EV)).toBe('different_tool');
    // …but a negated mention of it does not.
    expect(classifyConsultAdvice('Do not call run_command here; the ticket id is invalid — fix the id.', EV)).toBe('retry_with_corrected_params');
  });

  it('labelReflectionRoute: consult verdict is the primary label; the next tool labels only the unambiguous intended-tool case', () => {
    const base: ReflectionRoutePending = { decision: choice('shadow', 'different_tool', 0.6) as any, sessionId: 's1', streakTool: 'update_feedback', intended: 'run_command', consultVerdict: 'retry_with_corrected_params', consulted: true, acted: false, route: null };
    labelReflectionRoute(base, 'run_command');
    expect(mockRecord.mock.calls[0][1]).toBe('reflection_route');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'route', actual: 'retry_with_corrected_params', acted: false, sessionId: 's1' });
    expect(mockRecord.mock.calls[0][2].note).toBe('label:consult consult=retry_with_corrected_params next=run_command streak=update_feedback');
    labelReflectionRoute({ ...base, consultVerdict: null }, 'run_command');
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: 'different_tool' });
    expect(mockRecord.mock.calls[1][2].note).toMatch(/^label:next_tool consult=unclassified/);
    labelReflectionRoute({ ...base, consultVerdict: null }, 'grep'); // not the intended tool → unlabelled
    expect(mockRecord.mock.calls[2][2]).toMatchObject({ actual: null });
    labelReflectionRoute({ ...base, consultVerdict: null, consulted: false, acted: true }, null);
    expect(mockRecord.mock.calls[3][2]).toMatchObject({ actual: null, acted: true });
    expect(mockRecord.mock.calls[3][2].note).toBe('label:none consult=skipped next=final streak=update_feedback');
    labelReflectionRoute(null, 'x');
    expect(mockRecord).toHaveBeenCalledTimes(4);
  });
});

describe('consultCrossCheckerOnStreak + the route gate', () => {
  it('mode off: no decide(); the consult is byte-for-byte the old one', async () => {
    const advice = await consultCrossCheckerOnStreak(EV);
    expect(advice).toBe('Call read_file with the real path.');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('shadow: the gate is fired BEFORE the consult and runs concurrently; the callback gets the classified verdict; advice unchanged', async () => {
    mockMode.mockReturnValue('shadow');
    let decideStartedBeforeConsult = false;
    mockDecide.mockImplementation(async () => choice('shadow', 'retry_with_corrected_params', 0.7));
    mockPost.mockImplementation(async () => {
      decideStartedBeforeConsult = mockDecide.mock.calls.length === 1;
      await new Promise<void>((r) => { consultRelease = r; setTimeout(r, 5); });
      return { data: { choices: [{ message: { content: 'The ticket id is invalid — fix the id and retry.' } }] } };
    });
    const onRoutePending = jest.fn();
    const advice = await consultCrossCheckerOnStreak(EV, { onRoutePending });
    expect(advice).toBe('The ticket id is invalid — fix the id and retry.');
    expect(decideStartedBeforeConsult).toBe(true);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'reflection_route', sessionId: 's1' });
    expect(onRoutePending).toHaveBeenCalledTimes(1);
    const p: ReflectionRoutePending = onRoutePending.mock.calls[0][0];
    expect(p).toMatchObject({ streakTool: 'update_feedback', intended: 'run_command', consultVerdict: 'retry_with_corrected_params', consulted: true, acted: false, route: null });
    expect(mockRecord).not.toHaveBeenCalled(); // the caller labels it at the next turn
  });

  it('shadow: a FAST consult (keyless seat → null at once) waits at most REFLECTION_ROUTE_POST_CONSULT_WAIT_MS on a slow gate, then labels async', async () => {
    mockMode.mockReturnValue('shadow');
    mockProviderFor.mockResolvedValueOnce({ url: 'u', apiKey: '', model: 'deepseek-flash', envKey: 'DEEPSEEK_API_KEY', label: 'DeepSeek direct', extra: {} });
    let releaseGate: (v: any) => void = () => {};
    mockDecide.mockImplementation(() => new Promise((r) => { releaseGate = r; }));
    const onRoutePending = jest.fn();
    const t0 = Date.now();
    expect(await consultCrossCheckerOnStreak(EV, { onRoutePending })).toBeNull();
    const waitedMs = Date.now() - t0;
    expect(mockPost).not.toHaveBeenCalled(); // keyless → honest skip, no seat call
    expect(waitedMs).toBeLessThan(REFLECTION_ROUTE_TIMEOUT_MS); // never the 3 s gate deadline
    expect(waitedMs).toBeGreaterThanOrEqual(REFLECTION_ROUTE_POST_CONSULT_WAIT_MS - 20);
    expect(onRoutePending).not.toHaveBeenCalled(); // gate still pending → nothing to label yet
    releaseGate(choice('shadow', 'needs_diagnosis', 0.5));
    await new Promise((r) => setTimeout(r, 0));
    expect(onRoutePending).toHaveBeenCalledTimes(1); // …and the label lands once the gate answers
    expect(onRoutePending.mock.calls[0][0]).toMatchObject({ consultVerdict: null, consulted: true, acted: false });
  });

  it('shadow without a callback: the outcome is recorded here from the consult\'s advice (next=final)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(choice('shadow', 'different_tool', 0.9));
    mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'Call run_command instead.' } }] } });
    await consultCrossCheckerOnStreak(EV);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'route', actual: 'different_tool', acted: false });
    expect(mockRecord.mock.calls[0][2].note).toMatch(/next=final/);
  });

  it('shadow: a failed consult still labels nothing false — verdict null, advice null, gate failure fails open', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(choice('shadow', 'needs_diagnosis', 0.5));
    mockPost.mockRejectedValue(new Error('seat down'));
    const onRoutePending = jest.fn();
    expect(await consultCrossCheckerOnStreak(EV, { onRoutePending })).toBeNull();
    expect(onRoutePending.mock.calls[0][0]).toMatchObject({ consultVerdict: null, consulted: true, acted: false });
    jest.clearAllMocks();
    mockMode.mockReturnValue('shadow');
    mockDecide.mockRejectedValue(new Error('gate down'));
    mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'Retry with the real id.' } }] } });
    const cb = jest.fn();
    expect(await consultCrossCheckerOnStreak(EV, { onRoutePending: cb })).toBe('Retry with the real id.');
    expect(cb).not.toHaveBeenCalled(); // no decision → nothing to label
  });

  it('act: a confident non-needs_diagnosis RESULT skips the consult (acted, route carried); needs_diagnosis / unconfident / shadow-downgraded results consult', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('act', 'retry_with_corrected_params', 0.95));
    const cb = jest.fn();
    expect(await consultCrossCheckerOnStreak(EV, { onRoutePending: cb })).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
    expect(cb.mock.calls[0][0]).toMatchObject({ acted: true, consulted: false, route: 'retry_with_corrected_params', consultVerdict: null });

    jest.clearAllMocks(); mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('act', 'needs_diagnosis', 0.99));
    expect(await consultCrossCheckerOnStreak(EV)).toBe('Call read_file with the real path.');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ acted: false, actual: 'retry_with_corrected_params' }); // 'Call read_file with the real path' = a grounded retry

    jest.clearAllMocks(); mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('act', 'different_tool', 0.6)); // below τ 0.85
    expect(await consultCrossCheckerOnStreak(EV)).toBe('Call read_file with the real path.');
    expect(mockPost).toHaveBeenCalledTimes(1);

    jest.clearAllMocks(); mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('shadow', 'different_tool', 0.99)); // E2: uncalibrated backend → shadow result
    expect(await consultCrossCheckerOnStreak(EV)).toBe('Call read_file with the real path.');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockDecide).toHaveBeenCalledTimes(1); // the pre-wait answer is reused, not re-asked
  });
});
