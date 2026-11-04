/**
 * F2 — the frontier reflection council (owner 2026-10-06 late: "when a coding agent or any agent makes multiple
 * failures it should reflect then message a frontier of its choosing or multiple to create a council citing all its
 * failures and goals and where it is at").
 *
 * Pure parts (triggers, the deterministic reflect note / brief / agreement line, arg validation, prior-run parsing)
 * and the run controller with injected I/O: tool refusal outside a trigger window, parallel advisors with one failing,
 * the harness auto-run after 2 ignored steps, per-run + daily caps, the kill switch, a keyless / no-frontier instance,
 * outbound redaction, spend rows. No provider keys, no catalog, no wall-clock races.
 */
import {
  agreementLine, buildCouncilBrief, buildReflectNote, compactCouncilResult, councilToolSchema, councilTrigger, countedFailures,
  createFrontierCouncilRun, formatCouncilResult, lastAssistantText, nextStepOf, priorRunsFrom, renderFailureDossier,
  runCouncilAdvisors, validateCouncilArgs, frontierCouncilDisabled, councilMaxPerRun, councilSessionDailyCap,
  FRONTIER_COUNCIL_TOOL, REFLECT_NOTE_PREFIX, COUNCIL_RESULT_PREFIX, FRONTIER_COUNCIL_SPEND_PROFILE, NON_AGENT_FAILURE_RE,
  type AdvisorCall, type CouncilCounts, type CouncilFailure, type FrontierCouncilDeps,
} from './frontier-council';

const UNKNOWN = { in: 15, out: 75 };
const CLAUDE = 'cql-litellm:api-anthropic-claude-fable-5-1';
const GPT = 'cql-litellm:api-openai-gpt-6-astra';
const GROK = 'cql-litellm:api-xai-grok-5';
const MODELS = [
  { spec: CLAUDE, family: 'claude', tier: 'strong', priceIn: 15, priceOut: 75 },
  { spec: GPT, family: 'gpt', tier: 'strong', priceIn: 1.25, priceOut: 10 },
  { spec: GROK, family: 'grok', tier: 'standard', priceIn: null, priceOut: null },
];
const c = (o: Partial<CouncilCounts> = {}): CouncilCounts => ({ streakTrips: 0, verifyReds: 0, rejectBacks: 0, priorConsecutiveFailed: 0, priorRunTroubled: false, ...o });

describe('councilTrigger — "multiple failures", each wired trigger', () => {
  it('one failure is not repeated failures', () => {
    expect(councilTrigger(c({ streakTrips: 1 }))).toBeNull();
    expect(councilTrigger(c({ verifyReds: 1 }))).toBeNull();
    expect(councilTrigger(c({ rejectBacks: 1 }))).toBeNull();
    expect(councilTrigger(c())).toBeNull();
    expect(councilTrigger(c({ priorConsecutiveFailed: 1 }))).toBeNull(); // one failed run before this one, nothing this run
    expect(councilTrigger(c({ priorRunTroubled: true }))).toBeNull();
  });
  it.each([
    ['(a) a second failure-streak trip in the run', c({ streakTrips: 2 }), 'streak_repeat'],
    ['(a) a trip on a session whose previous run tripped', c({ streakTrips: 1, priorRunTroubled: true }), 'streak_after_failed_run'],
    ['(a) a trip on a session whose previous run failed', c({ streakTrips: 1, priorConsecutiveFailed: 1, priorRunTroubled: true }), 'streak_after_failed_run'],
    ['(b) the verify chain red twice', c({ verifyReds: 2 }), 'verify_red'],
    ['(c) two consecutive failed runs (read at run start)', c({ priorConsecutiveFailed: 2, priorRunTroubled: true }), 'failed_runs'],
    ['(d) two evidence-guard reject-backs', c({ rejectBacks: 2 }), 'guard_reject_back'],
    ['mixed: a trip + a red verify', c({ streakTrips: 1, verifyReds: 1 }), 'mixed'],
    ['mixed: a red verify after a troubled previous run', c({ verifyReds: 1, priorRunTroubled: true }), 'mixed'],
  ] as const)('%s ⇒ %s', (_label, counts, trigger) => {
    expect(councilTrigger(counts)?.trigger).toBe(trigger);
  });
  it('counted failures: the in-run ones, +1 for a troubled previous run once this run failed', () => {
    expect(countedFailures(c({ streakTrips: 1, verifyReds: 1 }))).toBe(2);
    expect(countedFailures(c({ streakTrips: 1, priorRunTroubled: true }))).toBe(2);
    expect(countedFailures(c({ priorRunTroubled: true }))).toBe(0);
  });
});

describe('priorRunsFrom — consecutive failed runs (agent_runs, newest first)', () => {
  it('counts back-to-back agent failures; a completed run stops the streak; superseded / crash / provider-killed rows neither count nor break it', () => {
    expect(priorRunsFrom([
      { id: 'r1', status: 'failed', error: 'verify chain red: typecheck' },
      { id: 'r2', status: 'failed', error: 'model provider killed the run (size failure, HTTP 403): quota' },
      { id: 'r3', status: 'failed', error: 'tool loop: git_push rejected' },
      { id: 'r4', status: 'completed' },
      { id: 'r5', status: 'failed', error: 'older' },
    ])).toEqual({ consecutiveFailed: 2, failed: [{ id: 'r1', error: 'verify chain red: typecheck' }, { id: 'r3', error: 'tool loop: git_push rejected' }] });
    expect(priorRunsFrom([{ id: 'x', status: 'failed', error: 'superseded by a newer run' }]).consecutiveFailed).toBe(0);
    expect(priorRunsFrom([{ id: 'x', status: 'cancelled' }, { id: 'y', status: 'failed', error: 'e' }]).consecutiveFailed).toBe(0);
    expect(NON_AGENT_FAILURE_RE.test('process died before the first checkpoint')).toBe(true);
  });
});

const FAILURES: CouncilFailure[] = [
  { kind: 'prior_run_failed', step: null, title: 'a previous run on this session failed', texts: ['tool loop: git_push rejected (non-fast-forward)'], runId: 'a1b2c3d4e5f6' },
  { kind: 'streak', step: 4, title: 'tool update_feedback — 3-failure streak', texts: ['Tool update_feedback failed: unknown id BREAKING_NOW', 'Tool update_feedback failed: unknown id X'], args: ['{"id":"BREAKING_NOW"}'] },
  { kind: 'verify_red', step: 9, title: 'verify chain red at stage "typecheck" (verify tool)', texts: ['src/a.ts(3,1): error TS2304: Cannot find name foo'] },
];
const GOAL = {
  runGoal: 'Fix the flaky delegation test and open a PR',
  plan: { goal: 'Green CI', steps: [{ id: 1, text: 'reproduce', status: 'completed' }, { id: 2, text: 'fix the race', status: 'in_progress' }] },
  charterGoal: { id: 'g0001111-2222', title: 'CI stays green', status: 'active', premises: [{ key: 'target_pass_rate', value: 0.99, unit: '%' }] },
  charterTodo: { id: 't0001111-2222', title: 'de-flake background delegation', status: 'in_progress' },
};
const WHERE = { step: 11, maxSteps: 40, receipts: [{ tool: 'git_commit', ok: true, ids: { sha: 'abcdef1234567890' } }, { tool: 'verify', ok: false, ids: { failedStage: 'typecheck' } }], councilsUsed: 0, councilsMax: 2 };

describe('the reflect note — every failure, the goal and where the run is, deterministically', () => {
  const note = () => buildReflectNote({ trigger: 'mixed', counted: 3, failures: FAILURES, goal: GOAL, where: WHERE, models: MODELS, defaults: [CLAUDE, GPT], ignoreSteps: 2, unknownPrice: UNKNOWN });
  it('lists every failure (tool, error text, args, failed run ids), the goal (plan + charter + premises), the state and the advisors with prices', () => {
    const n = note();
    expect(n.startsWith(REFLECT_NOTE_PREFIX)).toBe(true);
    for (const s of ['update_feedback', 'unknown id BREAKING_NOW', '{"id":"BREAKING_NOW"}', 'TS2304', 'run a1b2c3d4', 'git_push rejected',
      'Fix the flaky delegation test', '2. [in_progress] fix the race', 'Charter goal g0001111 "CI stays green"', 'target_pass_rate=0.99 %', 'Charter todo t0001111',
      'Step 11 of 40', 'verify FAILED (failedStage typecheck)', 'git_commit ok (sha abcdef1234)',
      `${CLAUDE} (claude, strong) — $15 → $75 per 1M tokens`, `${GROK} (grok, standard) — price not on record (estimated at $15 → $75`,
      FRONTIER_COUNCIL_TOOL, 'within 2 steps', `${CLAUDE}, ${GPT}`]) {
      expect(n).toContain(s);
    }
    // oldest first, numbered
    expect(n.indexOf('1. [before this run]')).toBeLessThan(n.indexOf('2. [step 4]'));
    expect(n.indexOf('2. [step 4]')).toBeLessThan(n.indexOf('3. [step 9]'));
  });
  it('is byte-identical for the same inputs (no clock, no randomness)', () => expect(note()).toBe(note()));
  it('a long failure list keeps the newest MAX and says how many earlier ones are not shown', () => {
    const many: CouncilFailure[] = Array.from({ length: 25 }, (_, i) => ({ kind: 'streak', step: i, title: `f${i}`, texts: [] }));
    const d = renderFailureDossier(many);
    expect(d).toContain('(5 earlier failure(s) not shown)');
    expect(d).toContain('f24');
    expect(d).not.toContain('f4\n');
  });
});

describe('the council brief — the agent\'s reflection + question + the SAME dossier', () => {
  it('the advisors see every failure even when the reflection omits them', () => {
    const b = buildCouncilBrief({ reflection: 'I think the CI is just slow.', question: 'what now?', chosenBy: 'agent', trigger: 'mixed', failures: FAILURES, goal: GOAL, where: WHERE });
    expect(b.system).toMatch(/DIAGNOSIS:.*NEXT STEP:/s);
    for (const s of ['I think the CI is just slow.', 'what now?', 'unknown id BREAKING_NOW', 'TS2304', 'run a1b2c3d4', 'CI stays green', 'Step 11 of 40']) expect(b.user).toContain(s);
  });
});

describe('validateCouncilArgs — the agent chooses; non-frontier / unknown models are refused WITH the list', () => {
  it('accepts 1–3 listed frontier models, a reflection and a question', () => {
    const v = validateCouncilArgs({ models: [CLAUDE, GPT, CLAUDE], reflection: 'x'.repeat(60), question: 'why?' }, MODELS, UNKNOWN);
    expect(v).toMatchObject({ ok: true, models: [CLAUDE, GPT] });
  });
  it('refuses an open / unknown model, naming the allowed list', () => {
    const v = validateCouncilArgs({ models: ['glm-5.3', CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, MODELS, UNKNOWN);
    expect(v.ok).toBe(false);
    expect((v as any).reason).toBe('unknown_model');
    expect((v as any).message).toContain('glm-5.3 is not a servable frontier-class model');
    expect((v as any).message).toContain(GPT);
  });
  it('refuses 0 or 4+ models, a missing reflection or question', () => {
    expect((validateCouncilArgs({ models: [], reflection: 'x'.repeat(60), question: 'q' }, MODELS, UNKNOWN) as any).reason).toBe('bad_models');
    expect((validateCouncilArgs({ models: [CLAUDE, GPT, GROK, 'z'], reflection: 'x'.repeat(60), question: 'q' }, MODELS, UNKNOWN) as any).reason).toBe('bad_models');
    expect((validateCouncilArgs({ models: [CLAUDE], reflection: 'stuck', question: 'q' }, MODELS, UNKNOWN) as any).reason).toBe('no_reflection');
    expect((validateCouncilArgs({ models: [CLAUDE], reflection: 'x'.repeat(60), question: ' ' }, MODELS, UNKNOWN) as any).reason).toBe('no_question');
  });
  it('the tool schema enumerates the frontier specs and shows prices', () => {
    const s = councilToolSchema(MODELS, UNKNOWN);
    expect(s.function.name).toBe(FRONTIER_COUNCIL_TOOL);
    expect((s.function.parameters as any).properties.models.items.enum).toEqual([CLAUDE, GPT, GROK]);
    expect(s.function.description).toContain('$1.25 → $10 per 1M tokens');
  });
});

describe('agreement line (deterministic)', () => {
  it('names agreeing advisors, flags a differing one, and handles 0 / 1 answers', () => {
    const a = { model: CLAUDE, text: 'DIAGNOSIS: the id is invented.\nNEXT STEP: call list_feedback to read real ticket ids before update_feedback.' };
    const b = { model: GPT, text: 'DIAGNOSIS: ungrounded ids.\nNEXT STEP: read real ticket ids with list_feedback, then update_feedback.' };
    const d = { model: GROK, text: 'DIAGNOSIS: network.\nNEXT STEP: restart the dev container tailnet.' };
    expect(agreementLine([a, b])).toMatch(/^Agreement: all 2 advisors prescribe a similar next step/);
    expect(agreementLine([a, b, d])).toMatch(/api-anthropic-claude-fable-5-1 and api-openai-gpt-6-astra prescribe a similar next step.*api-xai-grok-5 differs/);
    expect(agreementLine([a, d])).toMatch(/DIFFERENT next steps/);
    expect(agreementLine([a])).toMatch(/only api-anthropic-claude-fable-5-1 answered/);
    expect(agreementLine([])).toBe('Agreement: no advisor answered.');
    expect(nextStepOf('**NEXT STEP:** do X')).toBe('do X');
  });
});

describe('lastAssistantText', () => {
  it('the newest assistant prose (string or text parts), skipping tool-only turns', () => {
    expect(lastAssistantText([
      { role: 'assistant', content: 'old' }, { role: 'tool', content: 'x' },
      { role: 'assistant', content: [{ type: 'text', text: 'newest reflection' }] }, { role: 'assistant', content: '' },
    ])).toBe('newest reflection');
    expect(lastAssistantText([])).toBe('');
  });
});

describe('runCouncilAdvisors — parallel, bounded, one failing advisor', () => {
  it('runs every advisor at once; a failing one is labelled, the others still answer; spend is estimated when the vendor reports no usage', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps: Pick<FrontierCouncilDeps, 'callAdvisor' | 'unknownPrice' | 'now'> = {
      unknownPrice: UNKNOWN, now: () => 0,
      callAdvisor: async (spec) => {
        started.push(spec);
        if (started.length === 3) release();
        await gate; // every call must have STARTED before any finishes ⇒ parallel
        if (spec === GPT) throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
        return spec === CLAUDE ? { text: 'DIAGNOSIS: a.\nNEXT STEP: b.', inTokens: 1000, outTokens: 200 } : { text: 'DIAGNOSIS: c.\nNEXT STEP: d.' };
      },
    };
    const priceOf = (s: string) => { const m = MODELS.find((x) => x.spec === s)!; return { in: m.priceIn, out: m.priceOut }; };
    const calls = await runCouncilAdvisors([CLAUDE, GPT, GROK], { system: 's', user: 'u'.repeat(400) }, priceOf, deps, { timeoutMs: 20_000, maxTokens: 1024, effortCap: 'high' });
    expect(started.sort()).toEqual([CLAUDE, GPT, GROK].sort());
    const by = Object.fromEntries(calls.map((x) => [x.model, x]));
    expect(by[CLAUDE]).toMatchObject({ ok: true, inTokens: 1000, outTokens: 200, tokensEstimated: false, priced: true, usd: (1000 * 15 + 200 * 75) / 1e6 });
    expect(by[GPT]).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 400/) });
    expect(by[GROK]).toMatchObject({ ok: true, tokensEstimated: true, priced: false });
    expect(by[GROK].usd).toBeGreaterThan(0); // the unknown frontier price estimate
    const text = formatCouncilResult({ calls, chosenBy: 'agent', latencyMs: 3_000 });
    expect(text.startsWith(COUNCIL_RESULT_PREFIX)).toBe(true);
    expect(text).toContain(`── ${GPT} — no answer (HTTP 400`);
    expect(text).toContain('2 of 3 answered');
    expect(compactCouncilResult({ calls })).toMatch(/NEXT STEP b\./);
  });
});

// ── The run controller (injected I/O) ─────────────────────────────────────────

function harness(over: Partial<FrontierCouncilDeps> = {}, env: Record<string, string | undefined> = {}) {
  const metrics: any[] = [];
  const rows: any[] = [];
  const advisorCalls: Array<{ spec: string; brief: { system: string; user: string } }> = [];
  const parts: any[] = [];
  let daily = 0;
  const deps: Partial<FrontierCouncilDeps> = {
    models: async () => ({ candidates: MODELS, defaults: [CLAUDE, GPT] }),
    priorRuns: async () => ({ consecutiveFailed: 0, failed: [] }),
    consumeTripMarker: async () => false,
    setTripMarker: async () => undefined,
    dailyCount: async () => daily,
    bumpDaily: async () => { daily += 1; },
    plan: async () => GOAL.plan,
    charter: async () => ({ charterGoal: GOAL.charterGoal, charterTodo: GOAL.charterTodo }),
    callAdvisor: async (spec, brief) => { advisorCalls.push({ spec, brief }); return { text: `DIAGNOSIS: ${spec} sees it.\nNEXT STEP: read the real ids first.`, inTokens: 100, outTokens: 50 }; },
    recordMetric: (r) => metrics.push(r),
    recordRows: (r) => rows.push(...r),
    unknownPrice: UNKNOWN,
    now: () => 0,
    ...over,
  };
  const run = createFrontierCouncilRun({ sessionId: 'chat-1', runId: 'run-1', userId: 'u1', runGoal: 'Fix the flaky test', machine: true, deps, env, pushPart: (p) => parts.push(p) })!;
  return { run, metrics, rows, advisorCalls, parts, setDaily: (n: number) => { daily = n; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
const S = (step: number, latestText = 'my reflection text') => ({ step, maxSteps: 40, latestText, receipts: [] });
const trip = (step: number) => ({ tool: 'update_feedback', texts: ['Tool update_feedback failed: unknown id X'], args: ['{"id":"X"}'], perma: false, step });

describe('the run controller', () => {
  it('kill switch FRONTIER_REFLECTION_COUNCIL_DISABLED=1 ⇒ no controller (today\'s Double-Checker consult stands); env bounds parse', () => {
    expect(createFrontierCouncilRun({ sessionId: 's', runGoal: '', machine: false, env: { FRONTIER_REFLECTION_COUNCIL_DISABLED: '1' } })).toBeNull();
    expect(frontierCouncilDisabled({ FRONTIER_REFLECTION_COUNCIL_DISABLED: 'true' })).toBe(true);
    expect(councilMaxPerRun({})).toBe(2);
    expect(councilMaxPerRun({ FRONTIER_COUNCIL_MAX_PER_RUN: '99' })).toBe(4);
    expect(councilSessionDailyCap({})).toBe(6);
  });

  it('refuses the tool outside a trigger window (it is not a general "ask a frontier model" tool)', async () => {
    const h = harness();
    await flush();
    expect(h.run.offered()).toBe(false);
    const r = await h.run.executeTool({ models: [CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, S(1));
    expect(r).toMatch(/refused: the frontier council is for REPEATED failures/);
    expect(h.advisorCalls).toHaveLength(0);
    expect(h.metrics.find((m) => m.meta.phase === 'refused')?.meta.reason).toBe('no_trigger');
  });

  it('first trip: no escalation (the Double-Checker consult runs); second trip: escalates, the reflect note arms the window, the agent consults the models IT chose', async () => {
    const h = harness();
    expect(h.run.noteStreakTrip(trip(3))).toBe(false);
    await flush();
    expect(await h.run.beforeStep(S(4))).toBeNull();
    expect(h.run.noteStreakTrip(trip(6))).toBe(true); // models loaded at the first failure ⇒ the council supersedes the consult
    const note = await h.run.beforeStep(S(7));
    expect(note).toContain(REFLECT_NOTE_PREFIX);
    expect(note).toContain('a second failure-streak trip this run');
    expect(h.run.offered()).toBe(true);
    expect(h.metrics.find((m) => m.meta.phase === 'armed')?.meta).toMatchObject({ trigger: 'streak_repeat', machine: true });
    const out = await h.run.executeTool({ models: [GPT, GROK], reflection: 'I kept passing invented ids; I think the ids came from my narration.', question: 'How do I break this loop?' }, S(7));
    expect(out).toContain(COUNCIL_RESULT_PREFIX);
    expect(out).toContain('advisors chosen by you');
    expect(h.advisorCalls.map((x) => x.spec).sort()).toEqual([GPT, GROK].sort());
    // the brief carries the dossier the agent could not omit
    expect(h.advisorCalls[0].brief.user).toContain('Tool update_feedback failed: unknown id X');
    expect(h.advisorCalls[0].brief.user).toContain('Charter goal');
    // telemetry + spend + transcript
    const run = h.metrics.find((m) => m.kind === 'frontier_council' && m.meta.phase === 'run');
    expect(run.meta).toMatchObject({ trigger: 'streak_repeat', chosenBy: 'agent', models: [GPT, GROK], ok: { [GPT]: true, [GROK]: true }, failures: 2 });
    expect(typeof run.meta.usdEst).toBe('number');
    const spend = h.rows.filter((r) => r.kind === 'run_spend');
    expect(spend).toHaveLength(2);
    expect(spend[0].meta).toMatchObject({ profile: FRONTIER_COUNCIL_SPEND_PROFILE, chosenBy: 'agent', agentRunId: 'run-1' });
    expect(spend.find((r) => r.meta.model === GROK)!.meta).toMatchObject({ priceEstimated: true, priceSource: 'unknown_frontier_estimate', estimated: true });
    expect(h.rows.filter((r) => r.kind === 'run_tokens_in')).toHaveLength(2);
    expect(h.parts).toHaveLength(1);
    expect(h.parts[0]).toMatchObject({ type: 'subagent', role: 'reflection_council', title: 'Frontier council' });
    // the window closed with the council
    expect(h.run.offered()).toBe(false);
    expect(h.run.councilsRun).toBe(1);
  });

  it('the harness runs the council itself (default advisors, the agent\'s latest text as the reflection) after 2 ignored steps', async () => {
    const h = harness();
    h.run.noteVerifyRed({ stage: 'typecheck', tail: 'TS2304', step: 2, auto: true });
    await flush();
    h.run.noteVerifyRed({ stage: 'typecheck', tail: 'TS2304 again', step: 5, auto: false });
    expect(await h.run.beforeStep(S(6))).toContain('the verify chain failed twice this run');
    expect(await h.run.beforeStep(S(7, 'I will just retry'))).toBeNull(); // 1 ignored step
    const auto = await h.run.beforeStep(S(8, 'I will just retry the build'));
    expect(auto).toContain('advisors chosen by the harness');
    expect(auto).toContain('did not call consult_frontier_council within 2 steps');
    expect(h.advisorCalls.map((x) => x.spec)).toEqual([CLAUDE, GPT]);
    expect(h.advisorCalls[0].brief.user).toContain('I will just retry the build');
    expect(h.metrics.find((m) => m.meta.phase === 'run')!.meta.chosenBy).toBe('harness');
  });

  it('caps: ≤ 2 councils per run (a new window needs 2 MORE failures), and the per-session daily cap', async () => {
    const h = harness();
    h.run.noteGuardRejectBack({ round: 1, step: 1 });
    await flush();
    h.run.noteGuardRejectBack({ round: 2, step: 2, kinds: ['pr_opened'] });
    expect(await h.run.beforeStep(S(3))).toContain('the evidence guard rejected the final answer twice');
    await h.run.executeTool({ models: [CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, S(3));
    // one more failure is not enough for a second window
    h.run.noteVerifyRed({ stage: 'lint', tail: 'x', step: 4, auto: false });
    expect(await h.run.beforeStep(S(5))).toBeNull();
    expect(await h.run.executeTool({ models: [CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, S(5))).toMatch(/already answered these failures/);
    // two more ⇒ a second window
    h.run.noteVerifyRed({ stage: 'lint', tail: 'y', step: 6, auto: false });
    expect(await h.run.beforeStep(S(7))).toContain(REFLECT_NOTE_PREFIX);
    await h.run.executeTool({ models: [CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, S(7));
    expect(h.run.councilsRun).toBe(2);
    // the run cap: no third window, the tool refuses
    h.run.noteVerifyRed({ stage: 'lint', tail: 'z', step: 8, auto: false });
    h.run.noteVerifyRed({ stage: 'lint', tail: 'z', step: 9, auto: false });
    expect(await h.run.beforeStep(S(10))).toBeNull();
    expect(await h.run.executeTool({ models: [CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, S(10))).toMatch(/already convened 2 frontier council/);

    const d = harness();
    d.setDaily(6);
    d.run.noteStreakTrip(trip(1));
    await flush();
    d.run.noteStreakTrip(trip(2));
    await d.run.beforeStep(S(3));
    expect(await d.run.executeTool({ models: [CLAUDE], reflection: 'x'.repeat(60), question: 'q' }, S(3))).toMatch(/already convened 6 frontier council\(s\) today \(cap 6\)/);
    expect(d.advisorCalls).toHaveLength(0);
  });

  it('(c) two failed runs before this one ⇒ the reflect note at run start, the failed run ids + errors in it', async () => {
    const h = harness({ priorRuns: async () => ({ consecutiveFailed: 2, failed: [{ id: 'f1aaaaaaaa', error: 'verify red: test' }, { id: 'f2bbbbbbbb', error: 'git_push rejected' }] }) });
    await flush(); await flush();
    const note = await h.run.beforeStep(S(0));
    expect(note).toContain('the previous runs on this session failed back to back');
    expect(note).toContain('run f1aaaaaa');
    expect(note).toContain('git_push rejected');
  });

  it('(a) a trip after a previous run that also tripped (Redis marker) escalates on the FIRST trip of this run', async () => {
    const h = harness({ consumeTripMarker: async () => true });
    await flush();
    expect(h.run.noteStreakTrip(trip(2))).toBe(false); // models still loading at the first failure
    expect(await h.run.beforeStep(S(3))).toContain('a failure-streak trip right after a previous run that also tripped or failed');
  });

  it('a keyless / no-frontier instance: the trigger never arms (no_models row once) and every trip keeps the Double-Checker consult', async () => {
    const h = harness({ models: async () => ({ candidates: [], defaults: [] }) });
    h.run.noteStreakTrip(trip(1));
    await flush();
    expect(h.run.noteStreakTrip(trip(2))).toBe(false);
    expect(await h.run.beforeStep(S(3))).toBeNull();
    expect(await h.run.beforeStep(S(4))).toBeNull();
    expect(h.metrics.filter((m) => m.meta.phase === 'no_models')).toHaveLength(1);
    expect(h.run.offered()).toBe(false);
  });

  it('outbound: the brief is run through the credential redaction before it leaves for a vendor', async () => {
    const h = harness();
    h.run.noteStreakTrip({ ...trip(1), texts: ['curl -H "Authorization: Bearer sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" failed'] });
    await flush();
    h.run.noteStreakTrip(trip(2));
    await h.run.beforeStep(S(3));
    await h.run.executeTool({ models: [CLAUDE], reflection: 'my key is sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB and it fails', question: 'q' }, S(3));
    const sent = h.advisorCalls[0].brief.user;
    expect(sent).not.toContain('sk-proj-AAAAAAAA');
    expect(sent).not.toContain('sk-proj-BBBBBBBB');
    expect(h.metrics.find((m) => m.meta.phase === 'run')!.meta.redactions).toBeGreaterThanOrEqual(2);
  });

  it('escalateAtRunEnd: a stopping run with the trigger met gets the harness council (compact form for the final); none without a trigger', async () => {
    const none = harness();
    none.run.noteVerifyRed({ stage: 'x', tail: 't', step: 1, auto: true });
    await flush();
    expect(await none.run.escalateAtRunEnd({ ...S(2), reason: 'stopping' })).toBeNull();
    none.run.noteVerifyRed({ stage: 'x', tail: 't', step: 2, auto: true });
    const r = await none.run.escalateAtRunEnd({ ...S(3), reason: 'the verify chain kept failing and the run is stopping' });
    expect(r!.compact).toMatch(/^\[FRONTIER COUNCIL — convened by the harness \(the verify chain kept failing/);
    expect(r!.compact).toContain('NEXT STEP read the real ids first.');
    expect(none.advisorCalls).toHaveLength(2);
    // a second stop on the same failures does not re-run it
    expect(await none.run.escalateAtRunEnd({ ...S(4), reason: 'again' })).toBeNull();
  });

  it('a failing advisor never fails the council; an all-failed council says so honestly', async () => {
    const h = harness({ callAdvisor: async () => { throw new Error('socket hang up'); } });
    h.run.noteStreakTrip(trip(1));
    await flush();
    h.run.noteStreakTrip(trip(2));
    await h.run.beforeStep(S(3));
    const out = await h.run.executeTool({ models: [CLAUDE, GPT], reflection: 'x'.repeat(60), question: 'q' }, S(3));
    expect(out).toContain('0 of 2 answered');
    expect(out).toContain('No advisor answered');
    expect(h.metrics.find((m) => m.meta.phase === 'run')!.meta.ok).toEqual({ [CLAUDE]: false, [GPT]: false });
  });
});

// Type-only use so the import is not elided in isolatedModules builds.
export type _AdvisorCall = AdvisorCall;
