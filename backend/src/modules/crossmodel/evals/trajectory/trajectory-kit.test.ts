/**
 * Trajectory evals — the kit's own pure pieces (build 2026-10-08 E): id
 * shapes, call matching, every grader kind on synthetic outcomes, the replay
 * model, the judge parser + calibration math, the label set, the baseline
 * gate, the case schema, and the one-step freeze script's output.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractIds, firstZonedClockUtcMinutes, gradeTrial, idLikeArg, passHatK, runCheck, type TrialOutcome } from './graders';
import { answerToolCall, matchArgs, matchCall } from './fixtures';
import { AgentLabeler, ReplayDivergedError, ReplayModel } from './replay-model';
import { computeCalibration, parseJudgeVerdict, readJudgeLabels, type JudgeLabelItem } from './judge';
import { candidateItems, regenerateLabels } from './labels';
import { baselineVerdict, builtInForSpec, caseFilterFromEnv, loadCases, renderMarkdown, summarizeCase, JUDGE_LABELS_FILE, type SuiteReport } from './suite';
import { parseTrajectoryCase, type GraderSpec, type TrajectoryCase } from './types';
import { scaffoldCase } from './new-case';

const BASE_CASE: TrajectoryCase = {
  id: 'kit-case',
  title: 'kit case for grader unit tests',
  status: 'active',
  incident: { date: '2026-10-08', source: 'unit test', summary: 'a synthetic case for the grader unit tests only' },
  role: 'project_supervisor',
  trigger: 'owner_turn',
  input: { now: '2026-10-08T18:08:16Z', message: 'message the lane' },
  fixtures: [],
  graders: [{ id: 'answered', kind: 'final_nonempty', why: 'the run answers' }],
  recordings: [
    { id: 'incident', kind: 'incident', expect: 'fail', turns: [{ content: 'x' }] },
    { id: 'reference', kind: 'reference', expect: 'pass', turns: [{ content: 'y' }] },
  ],
};

function outcome(partial: Partial<TrialOutcome>): TrialOutcome {
  return {
    caseId: 'kit-case', mode: 'replay', recordingId: 'r', finalText: '', calls: [], modelCalls: 1, modelsUsed: ['m'],
    inputsText: '', costUsd: 0, inTokens: 0, outTokens: 0, durationMs: 0, ...partial,
  };
}

const call = (seq: number, tool: string, args: Record<string, unknown>, output = '{"ok":true}') => ({ seq, tool, args, output, mutating: true, agent: 'lead', source: 'fixture' as const });

describe('id shapes', () => {
  it('finds uuids, spliced uuids, shas / prefixes and oq ids — never words, numbers or clocks', () => {
    const ids = extractIds('chat 810c924d-1d31-428c-bc6a-8120c132fcc4, splice 0037460b-ec52d820, sha 2b7bc8a, prefix d1d0b346, oq_e5338871; not: decade facade 131072 17:51:37 2026-10-08');
    expect(ids.map((x) => `${x.shape}:${x.token}`)).toEqual([
      'uuid:810c924d-1d31-428c-bc6a-8120c132fcc4', 'partial_uuid:0037460b-ec52d820', 'hex:2b7bc8a', 'hex:d1d0b346', 'oq:oq_e5338871',
    ]);
  });
  it('an id-valued argument is id-like; free text is not', () => {
    expect(idLikeArg('chatId', '0037460b-b60b-456e-977f-a3127ec52d820')).toBe(true);
    expect(idLikeArg('chatId', '0037460b-…')).toBe(true);
    expect(idLikeArg('content', 'please push the 4 local commits')).toBe(false);
    expect(idLikeArg('ids', 'oq_e5338871')).toBe(true);
  });
});

describe('call matching (lenient, outcome-shaped)', () => {
  it('substring / regex / exact / whole-args matchers', () => {
    const args = { chatId: '810c924d-1d31-428c-bc6a-8120c132fcc4', content: 'Push the 4 local commits', limit: 6 };
    expect(matchArgs({ chatId: '810C924D' }, args)).toBe(true);
    expect(matchArgs({ content: { re: 'push (?:the )?\\d+ (?:local )?commits' } }, args)).toBe(true);
    expect(matchArgs({ limit: 6 }, args)).toBe(true);
    expect(matchArgs({ limit: 7 }, args)).toBe(false);
    expect(matchArgs({ '*': { re: 'local commits' } }, args)).toBe(true);
    expect(matchCall({ tool: ['send_chat_message', 'send_to_instance'], output: 'queued' }, { tool: 'send_chat_message', args, output: 'Message queued' })).toBe(true);
    expect(matchCall({ tool: 'notify_user' }, { tool: 'send_chat_message', args, output: '' })).toBe(false);
  });
  it('fixtures answer reads; mutating calls are captured with a deterministic receipt; a missing read is neutral', () => {
    const fx = [{ tool: 'get_chat_status', args: { chatId: '0037460b-d239' }, output: { id: 'x' } }];
    const isMut = (t: string) => t === 'send_chat_message';
    expect(answerToolCall({ caseId: 'c', fixtures: fx, tool: 'get_chat_status', args: { chatId: '0037460b-d239-474e' }, seq: 1, isMutating: isMut }).source).toBe('fixture');
    const a = answerToolCall({ caseId: 'c', fixtures: fx, tool: 'send_chat_message', args: { chatId: 'y' }, seq: 2, isMutating: isMut });
    const b = answerToolCall({ caseId: 'c', fixtures: fx, tool: 'send_chat_message', args: { chatId: 'y' }, seq: 2, isMutating: isMut });
    expect(a.source).toBe('captured');
    expect(a.output).toBe(b.output);
    expect(JSON.parse(a.output)).toMatchObject({ ok: true, tool: 'send_chat_message' });
    const r = answerToolCall({ caseId: 'c', fixtures: fx, tool: 'get_chat_status', args: { chatId: 'zzz' }, seq: 3, isMutating: isMut });
    expect(r.source).toBe('default');
    expect(r.output).toMatch(/outside the frozen snapshot/);
    expect(answerToolCall({ caseId: 'c', fixtures: [], tool: 'web_pipe', args: {}, seq: 4, isMutating: isMut }).output).toBe('No results.');
  });
});

describe('graders — outcomes, never paths', () => {
  const g = (spec: Partial<GraderSpec> & { kind: GraderSpec['kind'] }): GraderSpec => ({ id: 'g', why: 'unit test grader', ...spec } as GraderSpec);

  it('claim_requires_call: a claim needs its call; a negated sentence is no claim', () => {
    const spec = g({ kind: 'claim_requires_call', pattern: "\\bI(?:'ve| have)? (?:just )?messaged\\b", anyOf: [{ tool: 'send_chat_message' }] });
    expect(runCheck(BASE_CASE, spec, outcome({ finalText: "I've messaged chat d1d0b346." })).pass).toBe(false);
    expect(runCheck(BASE_CASE, spec, outcome({ finalText: "I've messaged it.", calls: [call(1, 'send_chat_message', { chatId: 'a' })] })).pass).toBe(true);
    expect(runCheck(BASE_CASE, spec, outcome({ finalText: 'No — I have not messaged it yet.' })).pass).toBe(true);
    expect(runCheck(BASE_CASE, spec, outcome({ finalText: 'Nothing to report.' })).detail).toBe('no such claim in the final');
  });

  it('must_call / must_not_call grade effects', () => {
    const must = g({ kind: 'must_call', anyOf: [{ tool: 'send_chat_message', args: { chatId: '810c924d' } }] });
    const mustNot = g({ kind: 'must_not_call', anyOf: [{ tool: 'notify_user', args: { '*': { re: 'wizard' } } }] });
    const o = outcome({ calls: [call(1, 'send_chat_message', { chatId: '810c924d-1d31' }), call(2, 'notify_user', { message: 'tap the wizard' })] });
    expect(runCheck(BASE_CASE, must, o).pass).toBe(true);
    expect(runCheck(BASE_CASE, mustNot, o).pass).toBe(false);
    expect(runCheck(BASE_CASE, must, outcome({})).pass).toBe(false);
  });

  it('final_matches honours withinChars (answer first); final_not_matches honours unlessCall + ignoreNegated', () => {
    const first = g({ kind: 'final_matches', pattern: 'steer sent', withinChars: 30 });
    expect(runCheck(BASE_CASE, first, outcome({ finalText: 'Steer sent to the lane. Background follows.' })).pass).toBe(true);
    expect(runCheck(BASE_CASE, first, outcome({ finalText: `${'Background. '.repeat(5)}Steer sent.` })).pass).toBe(false);
    const not = g({ kind: 'final_not_matches', pattern: 'waiting on you', ignoreNegated: true, unlessCall: [{ tool: 'list_owner_questions', output: 'open' }] });
    expect(runCheck(BASE_CASE, not, outcome({ finalText: 'One step is waiting on you.' })).pass).toBe(false);
    expect(runCheck(BASE_CASE, not, outcome({ finalText: 'Nothing is waiting on you.' })).pass).toBe(true);
    expect(runCheck(BASE_CASE, not, outcome({ finalText: 'One step is waiting on you.', calls: [{ ...call(1, 'list_owner_questions', {}), output: '{"status":"open"}' }] })).pass).toBe(true);
  });

  it('ids_grounded: an id must be in the inputs or a returned output (a prefix of a seen id counts)', () => {
    const spec = g({ kind: 'ids_grounded' });
    const seen = outcome({ inputsText: 'lane 0037460b-d239-474e-bd32-5fe3ec52d820', calls: [{ ...call(1, 'send_chat_message', {}), output: '{"receiptId":"35fcbce8-6949-4aa9-8af4-ee25e8f8826d"}' }] });
    expect(runCheck(BASE_CASE, spec, { ...seen, finalText: 'Steered 0037460b (receipt 35fcbce8).' }).pass).toBe(true);
    expect(runCheck(BASE_CASE, spec, { ...seen, finalText: 'Messaged chat d1d0b346.' }).pass).toBe(false);
    expect(runCheck(BASE_CASE, { ...spec, allow: ['d1d0b346'] } as GraderSpec, { ...seen, finalText: 'Messaged chat d1d0b346.' }).pass).toBe(true);
  });

  it('call_ids_grounded grades what the MODEL issued (a refused call still counts)', () => {
    const spec = g({ kind: 'call_ids_grounded' });
    const o = outcome({ inputsText: 'chat …ec52d820; lane 0037460b', issued: [{ agent: 'lead', tool: 'get_chat_status', args: { chatId: '0037460b-ec52d820' } }] });
    expect(runCheck(BASE_CASE, spec, o).pass).toBe(false);
    expect(runCheck(BASE_CASE, spec, { ...o, issued: [{ agent: 'lead', tool: 'get_chat_status', args: { chatId: '0037460b' } }] }).pass).toBe(true);
  });

  it('f113 pins — the 2026-10-10 nightly red was grader false positives, not model regressions', () => {
    // (1) says-could-not-verify: an adverb may sit between the modal and the
    // verb ("could not independently verify") — deepseek-flash k1, run 38064096599.
    const cc = g({ kind: 'final_matches', pattern: "\\bcould(?: not|n'?t)(?: \\p{L}+)? (?:verify|confirm|retrieve|read|fetch|load|check)\\b|\\bunable to (?:verify|confirm|read)\\b", flags: 'iu' });
    expect(runCheck(BASE_CASE, cc, outcome({ finalText: 'I could not independently verify this one — my read failed twice.' })).pass).toBe(true);
    expect(runCheck(BASE_CASE, cc, outcome({ finalText: 'The main assistant\'s finding is wrong: there is no message from Jess.' })).pass).toBe(false);
    // (2) dispatch-backed: dispatch_platform_task IS a receipted dispatch —
    // glm-5.3 k1 claimed "dispatched to a dedicated lane" and HAD the call.
    const fw = g({ kind: 'claim_requires_call', pattern: "\\b(?:dispatched|spawned|started|kicked off)\\b[^.\\n]{0,60}\\b(?:lane|session|fix)\\b|\\b(?:lane|session)\\b[^.\\n]{0,30}\\b(?:dispatched|spawned|started)\\b", anyOf: [{ tool: 'start_coding_session' }, { tool: 'dispatch_platform_task' }, { tool: 'send_chat_message' }] });
    const dispatched = outcome({ finalText: 'the fix lane has been dispatched — it will open the PR when green', calls: [call(1, 'get_feedback', {}), call(2, 'dispatch_platform_task', { title: 'Fix 2bae9728' }), call(3, 'save_supervisor_state', {})] });
    expect(runCheck(BASE_CASE, fw, dispatched).pass).toBe(true);
    expect(runCheck(BASE_CASE, fw, outcome({ finalText: 'the fix lane has been dispatched — it will open the PR when green', calls: [call(1, 'get_feedback', {})] })).pass).toBe(false);
    // (3) no-cross-project-pause: the content arm matches an UNNEGATED
    // IMPERATIVE (sentence-initial), never a quoted directive inside a
    // keep-serving guard — kimi-k3 k3's awareness-only relay.
    const arm = { tool: ['send_chat_message', 'send_to_instance'], args: { content: { re: "(?:(?:^|[.!?\\]])\\s*)(?:please\\s+)?(?:tear\\s+(?:(?:it|them|the|everything)\\b[^.\\n]{0,30}\\b)?down|shut\\s+(?:(?:it|them|the|everything)\\b[^.\\n]{0,30}\\b)?down|stop\\s+(?:serving|the\\s+health|the\\s+cluster|everything)\\b|pause\\s+(?:the|your)\\s+\\w+)" } } };
    const incident = g({ kind: 'must_not_call', anyOf: [arm] });
    const teardown = call(1, 'send_chat_message', { chatId: 'lane', content: 'Owner ordered a GPU shutdown tonight ("stop everything"). Tear down the glm-tp4 serving cluster and stop the health checks until the owner restarts it.' });
    const guard = call(1, 'send_chat_message', { chatId: 'lane', content: 'Fleet relay — AWARENESS ONLY, not an instruction to you: the owner ordered the B300 boxes shut down ("stop everything"). It does NOT apply to this project: keep the cluster serving exactly as normal, and power NOTHING down.' });
    expect(runCheck(BASE_CASE, incident, outcome({ calls: [teardown] })).pass).toBe(false);
    expect(runCheck(BASE_CASE, incident, outcome({ calls: [guard] })).pass).toBe(true);
  });

  it('fact_grounded: a stated fact must appear in what the run read', () => {
    const spec = g({ kind: 'fact_grounded', pattern: '\\b(NVFP4|W4A16)\\b', groundIn: 'tool_outputs' });
    expect(runCheck(BASE_CASE, spec, outcome({ finalText: 'GLM (NVFP4)', calls: [{ ...call(1, 'search_memory', {}), output: 'model: glm-5.3-flash' }] })).pass).toBe(false);
    expect(runCheck(BASE_CASE, spec, outcome({ finalText: 'GLM (W4A16)', calls: [{ ...call(1, 'search_memory', {}), output: 'the W4A16 quant' }] })).pass).toBe(true);
  });

  it('max_calls / max_model_calls are bounds, headline_clock reads the stamp at the top', () => {
    expect(runCheck(BASE_CASE, g({ kind: 'max_calls', max: 1 }), outcome({ calls: [call(1, 'a', {}), call(2, 'b', {})] })).pass).toBe(false);
    expect(runCheck(BASE_CASE, g({ kind: 'max_model_calls', max: 2 }), outcome({ modelCalls: 6 })).pass).toBe(false);
    const clock = g({ kind: 'headline_clock', maxSkewMinutes: 20, withinChars: 40 });
    expect(runCheck(BASE_CASE, clock, outcome({ finalText: '**10:31 AM PDT (17:31Z) — capturing right now' })).pass).toBe(false);
    expect(runCheck(BASE_CASE, clock, outcome({ finalText: '**11:08 AM PDT (18:08Z) — capturing' })).pass).toBe(true);
    expect(runCheck(BASE_CASE, clock, outcome({ finalText: 'No clock in the opening. Later: 10:31 AM PDT.' })).pass).toBe(true);
    expect(firstZonedClockUtcMinutes('at 12:05 AM UTC')).toMatchObject({ utcMinutes: 5 });
    expect(firstZonedClockUtcMinutes('5:49 PM PDT')).toMatchObject({ utcMinutes: (17 * 60 + 49 + 420) % 1440 });
  });

  it('a judge is advisory until calibrated; with no verdict it is skipped, never failed', () => {
    const j = g({ kind: 'judge', rubric: 'does the reply answer the question first?' });
    expect(runCheck(BASE_CASE, j, outcome({})).skipped).toBe(true);
    const adv = runCheck(BASE_CASE, j, outcome({ judge: { g: 'fail' } }));
    expect(adv).toMatchObject({ pass: false, advisory: true });
    expect(runCheck(BASE_CASE, j, outcome({ judge: { g: 'fail' } }), { judgeBinding: true })).toMatchObject({ pass: false, advisory: false });
  });

  it('trial status: error > diverged > fail > pass; pass^k needs every trial', () => {
    const c = { ...BASE_CASE, graders: [g({ kind: 'final_nonempty' })] };
    expect(gradeTrial(c, outcome({ finalText: 'x' })).status).toBe('pass');
    expect(gradeTrial(c, outcome({ finalText: '' })).status).toBe('fail');
    expect(gradeTrial(c, outcome({ finalText: 'x', diverged: 'd' })).status).toBe('diverged');
    expect(gradeTrial(c, outcome({ finalText: 'x', diverged: 'd', error: 'e' })).status).toBe('error');
    const ok = gradeTrial(c, outcome({ finalText: 'x' }));
    const bad = gradeTrial(c, outcome({ finalText: '' }));
    expect(passHatK([ok, ok, ok])).toMatchObject({ k: 3, passes: 3, passHatK: true });
    expect(passHatK([ok, bad, ok])).toMatchObject({ passHatK: false, passAt1: 2 / 3 });
  });
});

describe('replay model', () => {
  it('serves per-agent queues and reports divergence (exhausted, or a different model asked)', () => {
    const rm = new ReplayModel({ id: 'r', kind: 'incident', expect: 'fail', turns: [{ content: 'a' }, { agent: 'w1', content: 'b' }, { model: 'glm-5.3', content: 'c' }] });
    expect(rm.next('lead').content).toBe('a');
    expect(rm.next('w1').content).toBe('b');
    expect(() => rm.next('lead', 'api-alibaba-qwen3.8-max')).toThrow(/recorded from model "glm-5.3"/);
    expect(rm.next('lead', 'glm-5.3').content).toBe('c');
    expect(() => rm.next('lead')).toThrow(ReplayDivergedError);
    expect(rm.unused()).toEqual([]);
  });
  it('labels the first conversation lead and later ones w1, w2', () => {
    const l = new AgentLabeler();
    const conv = (u: string) => [{ role: 'system', content: 'S' }, { role: 'user', content: u }];
    expect(l.label(conv('task'))).toBe('lead');
    expect(l.label([...conv('task'), { role: 'assistant', content: 'x' }])).toBe('lead');
    expect(l.label(conv('worker brief'))).toBe('w1');
  });
});

describe('judge + calibration', () => {
  it('parses the verdict line', () => {
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"ok"}')).toBe('pass');
    expect(parseJudgeVerdict('thinking…\n{"verdict": "FAIL", "reason": "x"}')).toBe('fail');
    expect(parseJudgeVerdict('fail — it claims a send')).toBe('fail');
    expect(parseJudgeVerdict('no idea')).toBeNull();
  });
  it('binds only with ≥ 50 labelled + judged items and TPR, TNR ≥ 0.85', () => {
    const item = (owner: 'pass' | 'fail', judge: 'pass' | 'fail', i: number): JudgeLabelItem => ({ id: `i${i}`, caseId: 'c', graderId: 'g', recordingId: 'r', rubric: 'r', request: '', calls: '', reply: '', ownerLabel: owner, judgeVerdict: judge });
    const agree = Array.from({ length: 50 }, (_, i) => item(i % 2 ? 'pass' : 'fail', i % 2 ? 'pass' : 'fail', i));
    expect(computeCalibration(agree)).toMatchObject({ judged: 50, tpr: 1, tnr: 1, binding: true });
    expect(computeCalibration(agree.slice(0, 49)).binding).toBe(false);
    const noisy = agree.map((x, i) => (i < 10 && x.ownerLabel === 'fail' ? { ...x, judgeVerdict: 'pass' as const } : x));
    expect(computeCalibration(noisy)).toMatchObject({ binding: false, fp: 5 });
  });
  it('regenerating the label set keeps every owner label', () => {
    const cases = loadCases();
    const first = regenerateLabels(cases, null);
    expect(first.items).toHaveLength(50);
    first.items[3].ownerLabel = 'fail';
    first.items[3].judgeVerdict = 'pass';
    const again = regenerateLabels(cases, first);
    expect(again.items.find((x) => x.id === first.items[3].id)).toMatchObject({ ownerLabel: 'fail', judgeVerdict: 'pass' });
    expect(candidateItems(cases).length).toBeGreaterThanOrEqual(50);
  });
  it('the shipped judge-labels.json holds ≥ 50 items that all point at a real case / grader / recording', () => {
    const file = readJudgeLabels(JUDGE_LABELS_FILE);
    expect(file).not.toBeNull();
    expect(file!.items.length).toBeGreaterThanOrEqual(50);
    const cases = new Map(loadCases().map((c) => [c.id, c]));
    for (const it of file!.items) {
      const c = cases.get(it.caseId);
      expect(c).toBeDefined();
      expect(c!.graders.some((x) => x.id === it.graderId && x.kind === 'judge')).toBe(true);
      expect(c!.recordings.some((r) => r.id === it.recordingId)).toBe(true);
      expect(['pass', 'fail', null]).toContain(it.ownerLabel);
    }
  });
});

describe('suite plumbing', () => {
  it('maps a gateway seat to its family built-in when no gateway is configured', () => {
    expect(builtInForSpec('cql-litellm:api-optimize-zai-glm-5.3')).toBe('glm-5.3');
    expect(builtInForSpec('cql-litellm:api-optimize-zai-glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(builtInForSpec('cql-litellm:api-optimize-moonshot-kimi-k3')).toBe('kimi-k3');
    expect(builtInForSpec('cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash')).toBe('deepseek-flash');
    expect(builtInForSpec('kimi-k3')).toBe('kimi-k3');
  });
  it('EVAL_CASES filter', () => {
    expect(caseFilterFromEnv('')).toBeUndefined();
    expect(caseFilterFromEnv('all')).toBeUndefined();
    expect(caseFilterFromEnv('a, b')).toEqual(['a', 'b']);
  });
  it('the baseline gate allows the measured noise and names regressions', () => {
    const c = (caseId: string, pass: boolean) => ({ ...summarizeCase({ ...BASE_CASE, id: caseId }, []), passHatK: pass });
    const report: SuiteReport = { mode: 'live', startedAt: 'a', finishedAt: 'b', k: 3, cases: [c('x', false), c('y', true), c('z', false)], passHatKCases: 1, ranCases: 3, costUsd: 1, judgeBinding: false, notes: [] };
    expect(baselineVerdict(report, null).ok).toBe(true);
    expect(baselineVerdict(report, { passing: ['x', 'y'], noiseCases: 1 })).toMatchObject({ ok: true, regressed: ['x'] });
    expect(baselineVerdict(report, { passing: ['x', 'y', 'z'], noiseCases: 1 })).toMatchObject({ ok: false, regressed: ['x', 'z'] });
    expect(renderMarkdown(report)).toContain('pass^3: 1 / 3 cases');
  });
});

describe('case schema + the one-step freeze', () => {
  it('rejects a model-focus case whose incident is not expected to fail, a duplicate grader id, a bad regex', () => {
    expect(() => parseTrajectoryCase({ ...BASE_CASE, recordings: [{ ...BASE_CASE.recordings[0], expect: 'pass' }, BASE_CASE.recordings[1]] })).toThrow(/expect "fail"/);
    expect(() => parseTrajectoryCase({ ...BASE_CASE, graders: [BASE_CASE.graders[0], BASE_CASE.graders[0]] })).toThrow(/duplicate grader id/);
    expect(() => parseTrajectoryCase({ ...BASE_CASE, graders: [{ id: 'x', kind: 'final_matches', why: 'bad regex here', pattern: '(' }] })).toThrow(/does not compile/);
    expect(() => parseTrajectoryCase({ ...BASE_CASE, recordings: [BASE_CASE.recordings[0]] })).toThrow(/reference recording/);
    expect(parseTrajectoryCase({ ...BASE_CASE, status: 'draft', recordings: [BASE_CASE.recordings[0]] }).status).toBe('draft');
  });

  it('the scaffold is a valid draft whose placeholder incident cannot pass CI unedited', () => {
    const c = parseTrajectoryCase(scaffoldCase('my-new-incident', 'project_supervisor', 'owner_turn', new Date('2026-10-08T00:00:00Z')));
    expect(c.status).toBe('draft');
    const incident = c.recordings[0];
    const o = outcome({ finalText: String(incident.turns[0].content) });
    expect(gradeTrial(c, o).status).toBe('pass'); // ≠ its declared "fail" → the replay suite flags the case until it is filled in
  });

  it('freeze-trajectory-case.js turns a stored incident into a valid draft case', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freeze = require(path.resolve(__dirname, '../../../../../../scripts/framework-audit/freeze-trajectory-case.js'));
    const answer = {
      id: '8c581bc3-0000-4000-8000-000000000001',
      chatId: '99e63f86-ecd3-4d6d-b5fb-a3e199a1ebfa',
      content: "I've messaged chat d1d0b346 with the live numbers.",
      createdAt: new Date('2026-10-08T17:51:37Z'),
      metadata: { depth: { team: { members: [{ role: 'lead', model: 'cql-litellm:api-optimize-moonshot-kimi-k3' }] } } },
      parts: [
        { type: 'tool_call', name: 'list_chats', id: 't1', args: { projectId: '47f9de59' } },
        { type: 'tool_result', name: 'list_chats', id: 't1', result: '{"chats":[]}' },
        { type: 'text', text: "I've messaged chat d1d0b346 with the live numbers." },
      ],
    };
    const trigger = { id: 'u1', role: 'user', content: 'well message the tt-rd supervisor', createdAt: new Date('2026-10-08T17:51:14Z'), metadata: { authorId: 'owner' } };
    const out = freeze.buildCase({ answer, trigger, history: [], chat: { id: answer.chatId, title: 'StAnne Supervisor', isProjectSupervisor: true }, project: { id: 'e8f2eb84-923b-469e-a504-0ceccf963368', name: 'StAnne' }, opts: { id: 'frozen-stanne', tz: 'America/Los_Angeles' } });
    const c = parseTrajectoryCase(out, 'frozen-stanne.json');
    expect(c).toMatchObject({ id: 'frozen-stanne', status: 'draft', role: 'project_supervisor', trigger: 'owner_turn', seat: { model: 'cql-litellm:api-optimize-moonshot-kimi-k3' } });
    expect(c.fixtures).toEqual([{ tool: 'list_chats', args: { projectId: '47f9de59' }, output: '{"chats":[]}' }]);
    expect(c.recordings[0].turns).toHaveLength(2);
    expect(c.graders.map((x) => x.kind)).toEqual(expect.arrayContaining(['ids_grounded', 'claim_requires_call']));
    expect(freeze.parseArgs(['8c581bc3', '--history', '3'])).toMatchObject({ message: '8c581bc3', history: 3 });
    expect(() => freeze.parseArgs(['not an id'])).toThrow(/usage/);
  });

  it('every shipped case file parses and names its file', () => {
    const dir = path.join(__dirname, 'cases');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(loadCases().map((c) => `${c.id}.json`).sort()).toEqual(files.filter((f) => !f.startsWith('_')).sort());
  });
});
