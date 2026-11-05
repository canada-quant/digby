/**
 * SAA-1.3 + SAA-1.4 PHASE 0 (todo 9114e7b5) — the OBSERVE-ONLY contract.
 *
 * These cases exist to pin the ONE property the Phase 0 exit gate asks for, in
 * the form that keeps holding after this file is forgotten: an enterprising
 * later change must be UNABLE to make the feature touch what an agent is shown
 * without turning a case here red.
 *
 * The three claims, in order of importance:
 *   1. `applied` is the literal false and cannot be anything else (type-level:
 *      a `true` literal is not assignable — see the compile-pinned case).
 *   2. The text a surface renders is BYTE-IDENTICAL with the switch unset and
 *      with the observation enabled (the gate's "empty diff" in test form).
 *   3. The kill switch stops the observation entirely — no plan, no segments,
 *      no metric row — so =1 restores today's behaviour including its cost.
 */
// drain-triage.ts pulls config/env → config/database (which process.exit(1)s on
// a bare env), so the wiring cases below mock the same seams the sibling suite
// does. Hoisted by jest, hence they sit above the imports.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) } }));
jest.mock('./decision-gate', () => ({ __esModule: true, decide: jest.fn(async () => null), decisionMode: jest.fn(() => 'off'), decisionOptionThreshold: (_p: string, _o: string, f: number) => f, stashDecision: () => null, recordDecisionOutcome: jest.fn() }));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, getSupervisorState: jest.fn(async () => ({ directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [] })) }));

import {
  INLINE_SPILL_SURFACES,
  inlineSpillInjectionDisabled,
  inlineSpillMetricMeta,
  inlineSpillMode,
  planInlineSpill,
  renderSpillPointers,
  spillPointerLine,
  type SpillSegment,
} from './inline-spill';
import {
  RECALL_CHAIN_SURFACES,
  chainOfRecallDisabled,
  chainOfRecallMode,
  planRecallChain,
  recallChainLine,
  recallChainMetricMeta,
  renderRecallChain,
  withRecallChainField,
} from './chain-of-recall';

const seg = (id: string, elidedChars: number): SpillSegment => ({ id, elidedChars, readCall: `get_chat_messages({messageId:"${id}"})` });

describe('SAA-1.3 inline-and-spill — Phase 1: the widen, and the property that MOVED with it', () => {
  // PHASE 1 (todo 2ef2b254) — THIS CASE WAS REWRITTEN, DELIBERATELY. In Phase 0 it
  // read `const notApplied: true = plan.applied` under a `@ts-expect-error`, pinning
  // `applied` to the literal `false`. That tripwire has now fired on purpose: the
  // type is `boolean`, and the safety property it protected did not disappear — it
  // MOVED to "the DEFAULT mode never renders", which is what the cases below pin.
  // Anything that lets a default box's text change without `apply` is still red.
  it('applied is a real boolean and is TRUE only when a render actually happened', () => {
    const applied = planInlineSpill({ surface: 'chat_messages', segments: [seg('m1', 900)] }, { INLINE_SPILL_INJECTION_DISABLED: 'apply' });
    expect(applied.mode).toBe('apply');
    expect(applied.applied).toBe(true);
    // The type is genuinely widened, not just the runtime value: a `true` plan is
    // now assignable, which is the exact line that used to fail to compile.
    const widened: boolean = applied.applied;
    expect(widened).toBe(true);
    // …and it is TRUTHFUL, not a mode flag: the same mode over nothing to spill
    // (or over a segment with no read call to follow) did NOT apply anything.
    expect(planInlineSpill({ surface: 'chat_messages', segments: [] }, { INLINE_SPILL_INJECTION_DISABLED: 'apply' }).applied).toBe(false);
    expect(planInlineSpill({ surface: 'decision_gate', segments: [{ id: 's', elidedChars: 10, readCall: '' }] }, { INLINE_SPILL_INJECTION_DISABLED: 'apply' }).applied).toBe(false);
  });

  // THE PROPERTY THAT MOVED. Phase 0 got byte-identity from the type; Phase 1 has to
  // get it from the render branch, so it is pinned here explicitly at the seam that
  // produces the text an agent reads.
  it('observe (the DEFAULT) renders byte-identical text; only apply rewrites it', () => {
    const body = 'the injected text';
    const plan = planInlineSpill({ surface: 'chat_messages', segments: [seg('m1', 900)] }, {});
    expect(plan.mode).toBe('observe');
    expect(renderSpillPointers(body, plan)).toBe(body);
    // off is byte-identical too — the kill switch must restore the old text exactly.
    const killed = planInlineSpill({ surface: 'chat_messages', segments: [seg('m1', 900)] }, { INLINE_SPILL_INJECTION_DISABLED: '1' });
    expect(renderSpillPointers(body, killed)).toBe(body);
    // apply is the ONLY shape that changes the bytes…
    const on = planInlineSpill({ surface: 'chat_messages', segments: [seg('m1', 900)] }, { INLINE_SPILL_INJECTION_DISABLED: 'apply' });
    const rendered = renderSpillPointers(body, on);
    expect(rendered).not.toBe(body);
    // …and it changes them by APPENDING a followable call, never by replacing what
    // the surface already showed (the body is still a prefix of the result).
    expect(rendered.startsWith(body)).toBe(true);
    expect(rendered).toContain('read them: get_chat_messages({messageId:"m1"})');
  });

  it('renders ONE pointer per unique read call, so a cap cannot be re-defeated by its own fix', () => {
    const sameCall: SpillSegment = { id: 'ignored', elidedChars: 10, readCall: 'get_chat_messages({chatId:"c"})' };
    const plan = planInlineSpill({ surface: 'chat_messages', segments: [seg('m1', 100), seg('m2', 200), sameCall] }, { INLINE_SPILL_INJECTION_DISABLED: 'apply' });
    const rendered = renderSpillPointers('x', plan);
    expect(rendered.match(/read them: get_chat_messages\(\{chatId:"c"\}\)/g)).toHaveLength(1);
    // The per-object pointers still each appear.
    expect(rendered).toContain('messageId:"m1"');
    expect(rendered).toContain('messageId:"m2"');
  });

  it('reports what a pointer WOULD add, and the plan itself carries no rendered text', () => {
    const plan = planInlineSpill({ surface: 'chat_messages', segments: [seg('m1', 900), seg('m2', 100)] }, {});
    expect(plan.mode).toBe('observe');
    expect(plan.segments).toHaveLength(2);
    expect(plan.elidedChars).toBe(1000);
    expect(plan.wouldAddChars).toBeGreaterThan(0);
    // The pointers are REPORTED, not injected: no field of the plan is the rendered
    // block, so a caller cannot accidentally return the plan instead of the text.
    expect(Object.keys(plan).sort()).toEqual(['applied', 'droppedRows', 'elidedChars', 'mode', 'segments', 'surface', 'wouldAddChars', 'wouldInject']);
  });

  it('drops whole objects from the report — an object with nothing elided is not a spill', () => {
    const plan = planInlineSpill({ surface: 'chat_messages', segments: [seg('whole', 0), seg('cut', 500), seg('', 40)] }, {});
    expect(plan.segments.map((s) => s.id)).toEqual(['cut']);
  });

  it('the kill switch yields an OFF plan with no segments and no metric row', () => {
    for (const on of ['1', 'true', 'ON', ' True ']) {
      const plan = planInlineSpill({ surface: 'drain_triage', segments: [seg('r1', 700)] }, { INLINE_SPILL_INJECTION_DISABLED: on });
      expect(plan.mode).toBe('off');
      expect(plan.segments).toEqual([]);
      expect(inlineSpillMetricMeta(plan)).toBeNull();
      expect(inlineSpillInjectionDisabled({ INLINE_SPILL_INJECTION_DISABLED: on })).toBe(true);
    }
    // Anything that is not the kill value OBSERVES — including '0' and junk,
    // so an operator typo can never silently disable the measurement.
    for (const off of ['', '0', 'false', 'no', undefined]) {
      expect(inlineSpillInjectionDisabled({ INLINE_SPILL_INJECTION_DISABLED: off as any })).toBe(false);
      expect(planInlineSpill({ surface: 'drain_triage', segments: [seg('r1', 700)] }, { INLINE_SPILL_INJECTION_DISABLED: off as any }).mode).toBe('observe');
    }
  });

  it('an idle call records nothing (no row per read, only per LOSS)', () => {
    expect(inlineSpillMetricMeta(planInlineSpill({ surface: 'chat_messages', segments: [] }, {}))).toBeNull();
  });

  // INDEPENDENT REVIEW 2026-11-02, HIGH finding: the instrument reproduced the very
  // blindness it exists to measure. A drain so long that WHOLE rows are skipped at
  // `budget <= 0` produces no per-row segment, so the old emptiness test
  // (`!plan.segments.length`) returned null and wrote NO row — for the exact class
  // the feature exists to expose. These two cases fail on that old code.
  it('WHOLE-row drops alone must still write a row (the blindly-dropped class)', () => {
    const plan = planInlineSpill({ surface: 'drain_triage', segments: [], droppedRows: 37 }, {});
    expect(plan.mode).toBe('observe');
    expect(plan.segments).toEqual([]);
    expect(plan.droppedRows).toBe(37);
    expect(plan.wouldInject).toBe(37);
    const meta: any = inlineSpillMetricMeta(plan, { chatId: 'c1' });
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({ surface: 'drain_triage', droppedRows: 37, clipped: 0, wouldInject: 37 });
  });

  it('clipped and dropped are counted as separate classes, not folded together', () => {
    const plan = planInlineSpill({ surface: 'drain_triage', segments: [seg('r1', 500), seg('r2', 300)], droppedRows: 10 }, {});
    const meta: any = inlineSpillMetricMeta(plan);
    expect(meta).toMatchObject({ clipped: 2, droppedRows: 10, wouldInject: 12, elidedChars: 800 });
    // A clipped object is one the model PARTIALLY saw; a dropped one it never saw.
    // elidedChars must not absorb the dropped rows (their size is unknown here).
    expect(meta.elidedChars).toBe(800);
  });

  it('genuinely nothing lost still writes nothing (droppedRows 0 + no segments)', () => {
    expect(inlineSpillMetricMeta(planInlineSpill({ surface: 'drain_triage', segments: [], droppedRows: 0 }, {}))).toBeNull();
  });

  it('the metric meta carries counts and ids only — never the prose it measured', () => {
    const plan = planInlineSpill({ surface: 'chat_messages', segments: [seg('11111111-2222', 900)] }, {});
    const meta: any = inlineSpillMetricMeta(plan, { chatId: 'c1' });
    expect(meta).toMatchObject({ surface: 'chat_messages', wouldInject: 1, elidedChars: 900, chatId: 'c1' });
    // The house rule: a telemetry row must not carry the object it is measuring.
    const flat = JSON.stringify(meta);
    expect(flat).not.toContain('… [');
    expect(Object.values(meta)).not.toContain('11111111-2222');
  });

  it('an unknown surface is labelled, not dropped — the closed set is a guard, not a filter', () => {
    const plan = planInlineSpill({ surface: 'not_a_surface', segments: [seg('x', 10)] }, {});
    expect(plan.surface).toBe('unknown');
    expect(plan.segments).toHaveLength(1);
    expect(INLINE_SPILL_SURFACES).toContain('chat_messages');
  });

  it('spillPointerLine is the exact bytes a Phase-1 apply would add', () => {
    expect(spillPointerLine(seg('m1', 900))).toBe('… [900 chars not inlined — read them: get_chat_messages({messageId:"m1"})]');
  });
});

describe('SAA-1.4 chain-of-recall — Phase 1: the widen, and the property that MOVED with it', () => {
  // PHASE 1 (todo 2ef2b254) — REWRITTEN DELIBERATELY, exactly like its SAA-1.3
  // sibling above: the `@ts-expect-error` tripwire on the literal `false` has fired
  // on purpose. What replaced it is the claim that actually has to hold now —
  // the DEFAULT appends nothing, and only `apply` (with a real hop) appends.
  it('applied is a real boolean, TRUE only when a line is actually appended', () => {
    const on = planRecallChain({ surface: 'goal_get', hops: [{ kind: 'todo', id: 't1' }] }, { CHAIN_OF_RECALL_DISABLED: 'apply' });
    expect(on.mode).toBe('apply');
    expect(on.applied).toBe(true);
    const widened: boolean = on.applied;
    expect(widened).toBe(true);
    // Truthful, not a mode flag: apply mode with nothing to append applied nothing.
    expect(planRecallChain({ surface: 'goal_get', hops: [] }, { CHAIN_OF_RECALL_DISABLED: 'apply' }).applied).toBe(false);
  });

  it('observe (the DEFAULT) appends nothing; apply appends the next: line; off does neither', () => {
    const hops = [{ kind: 'goal' as const, id: 'g1' }, { kind: 'todo' as const, id: 't1' }];
    const text = 'a memory answer';
    const observing = planRecallChain({ surface: 'search_memory', hops }, {});
    expect(observing.mode).toBe('observe');
    expect(observing.wouldAppendHops).toBe(2);
    // THE MOVED PROPERTY: the default renders byte-identical text, by reference.
    expect(renderRecallChain(text, observing)).toBe(text);
    expect(renderRecallChain(text, planRecallChain({ surface: 'search_memory', hops }, { CHAIN_OF_RECALL_DISABLED: '1' }))).toBe(text);
    const applied = renderRecallChain(text, planRecallChain({ surface: 'search_memory', hops }, { CHAIN_OF_RECALL_DISABLED: 'apply' }));
    expect(applied).toBe('a memory answer\nnext: goal g1 · todo t1');
  });

  // The JSON surfaces (goal_get / todo_get) parse from the first brace, so the hop
  // must be an ADDITIVE FIELD, never a trailing prose line — this repo has already
  // recorded the defect class that a suffix causes.
  it('withRecallChainField is additive, and hands back the SAME object when nothing applied', () => {
    const envelope = { id: 'g1', title: 'a goal' } as Record<string, unknown>;
    const hops = [{ kind: 'todo' as const, id: 't1', label: 'step' }];
    // observe ⇒ identity, so JSON.stringify output is byte-identical to before.
    expect(withRecallChainField(envelope, planRecallChain({ surface: 'goal_get', hops }, {}))).toBe(envelope);
    const withNext = withRecallChainField(envelope, planRecallChain({ surface: 'goal_get', hops }, { CHAIN_OF_RECALL_DISABLED: 'apply' }));
    expect(withNext).not.toBe(envelope);
    expect(withNext.next).toBe('next: todo t1 (step)');
    // Nothing else moved: every original key survives unchanged, and the hop rides
    // an additive field a first-brace parser never has to look at.
    expect(withNext).toMatchObject({ id: 'g1', title: 'a goal' });
  });

  it('mode resolution is fail-safe: junk is observe, never apply', () => {
    expect(chainOfRecallMode({})).toBe('observe');
    expect(chainOfRecallMode({ CHAIN_OF_RECALL_DISABLED: '0' })).toBe('observe');
    expect(chainOfRecallMode({ CHAIN_OF_RECALL_DISABLED: 'yes-please' })).toBe('observe');
    expect(chainOfRecallMode({ CHAIN_OF_RECALL_DISABLED: 'apply' })).toBe('apply');
    expect(chainOfRecallMode({ CHAIN_OF_RECALL_DISABLED: '1' })).toBe('off');
    // Same shape for the spill switch — an unrecognised value must never START
    // rewriting prompts, which is the whole reason observe is the floor.
    expect(inlineSpillMode({})).toBe('observe');
    expect(inlineSpillMode({ INLINE_SPILL_INJECTION_DISABLED: '0' })).toBe('observe');
    expect(inlineSpillMode({ INLINE_SPILL_INJECTION_DISABLED: 'apply' })).toBe('apply');
    expect(inlineSpillMode({ INLINE_SPILL_INJECTION_DISABLED: 'on' })).toBe('off');
  });

  // PHASE 1 REVIEW CATCH: the Phase-0 metric gate was `mode !== 'observe'`, correct
  // only while observe was the sole live mode. Left alone it would go BLIND the
  // moment the feature started changing prompts — the instrument switching itself
  // off exactly when someone needs to read it.
  it('the readout survives apply mode — it goes dark only on the kill switch', () => {
    const hops = [{ kind: 'goal' as const, id: 'g1' }];
    expect(recallChainMetricMeta(planRecallChain({ surface: 'goal_get', hops }, { CHAIN_OF_RECALL_DISABLED: 'apply' }))).not.toBeNull();
    expect(recallChainMetricMeta(planRecallChain({ surface: 'goal_get', hops }, { CHAIN_OF_RECALL_DISABLED: '1' }))).toBeNull();
    const segs = [seg('m1', 100)];
    expect(inlineSpillMetricMeta(planInlineSpill({ surface: 'chat_messages', segments: segs }, { INLINE_SPILL_INJECTION_DISABLED: 'apply' }))).not.toBeNull();
    expect(inlineSpillMetricMeta(planInlineSpill({ surface: 'chat_messages', segments: segs }, { INLINE_SPILL_INJECTION_DISABLED: '1' }))).toBeNull();
    // …and the row now says WHICH it was, so "would have" cannot be mistaken for "did".
    const observeRow: any = inlineSpillMetricMeta(planInlineSpill({ surface: 'chat_messages', segments: segs }, {}));
    expect(observeRow.applied).toBe(false);
  });

  it('resolves hops and keeps its shape in observe', () => {
    const chain = planRecallChain({ surface: 'get_run_receipts', hops: [{ kind: 'goal', id: 'g1' }, { kind: 'todo', id: 't1' }] }, {});
    expect(chain.mode).toBe('observe');
    expect(chain.wouldAppendHops).toBe(2);
    expect(Object.keys(chain).sort()).toEqual(['applied', 'hops', 'mode', 'surface', 'wouldAppendHops']);
  });

  it('collapses a duplicate hop and drops an empty one', () => {
    const chain = planRecallChain({ surface: 'get_run_receipts', hops: [{ kind: 'goal', id: 'g1' }, { kind: 'goal', id: 'g1' }, { kind: 'todo', id: '' }, null] }, {});
    expect(chain.hops).toEqual([{ kind: 'goal', id: 'g1' }]);
  });

  it('the kill switch yields an OFF chain with no hops and no metric row', () => {
    for (const on of ['1', 'true', 'On']) {
      const chain = planRecallChain({ surface: 'get_run_receipts', hops: [{ kind: 'goal', id: 'g1' }] }, { CHAIN_OF_RECALL_DISABLED: on });
      expect(chain.mode).toBe('off');
      expect(chain.hops).toEqual([]);
      expect(recallChainMetricMeta(chain)).toBeNull();
      expect(chainOfRecallDisabled({ CHAIN_OF_RECALL_DISABLED: on })).toBe(true);
    }
    expect(chainOfRecallDisabled({ CHAIN_OF_RECALL_DISABLED: '0' })).toBe(false);
  });

  it('an empty recall records nothing', () => {
    expect(recallChainMetricMeta(planRecallChain({ surface: 'get_run_receipts', hops: [] }, {}))).toBeNull();
  });

  it('the metric meta counts kinds and ids but drops the glossed labels', () => {
    const chain = planRecallChain({ surface: 'get_run_receipts', hops: [{ kind: 'goal', id: 'g1', label: 'ROLLOUT of SECRET prose' }] }, {});
    const meta: any = recallChainMetricMeta(chain);
    expect(meta).toMatchObject({ surface: 'get_run_receipts', wouldAppend: 1, kinds: { goal: 1 } });
    expect(JSON.stringify(meta)).not.toContain('SECRET');
  });

  it('recallChainLine is the exact bytes a Phase-1 apply would append', () => {
    expect(recallChainLine([{ kind: 'goal', id: 'g1' }, { kind: 'todo', id: 't1', label: 'st' }])).toBe('next: goal g1 · todo t1 (st)');
    expect(recallChainLine([])).toBe('');
  });

  it('redacts a hop id that is not id-shaped before it rides a metric row', () => {
    const chain = planRecallChain({ surface: 'get_run_receipts', hops: [{ kind: 'goal', id: 'sk-live-abc/../secret' }] }, {});
    const meta: any = recallChainMetricMeta(chain);
    expect(meta.ids).toEqual(['[redacte']);
  });

  it('the closed surface sets name the Phase-1 targets so they cannot be forgotten', () => {
    expect(RECALL_CHAIN_SURFACES).toEqual(expect.arrayContaining(['search_memory', 'get_run_receipts', 'goal_get', 'todo_get']));
  });

  // INDEPENDENT REVIEW 2026-11-02, HIGH finding: the `schedule` hop was DEAD CODE.
  // ops-tools.ts read `r.input?.scheduleId` while the runs query selected only
  // {id,status,attempts,currentStep,error,createdAt,startedAt,finishedAt} — `input`
  // was never fetched, so the hop could never resolve, and on a chat with no
  // charterGoalId/charterTodoId the chain was empty and logged NOTHING. Wiring a
  // hop to a field nobody selects is the NF_INERT class this registry exists to
  // catch. Source-pinned because the defect is an absent field in a query, which
  // no behavioural unit test on the pure leaf can see.
  it('pins the get_run_receipts runs select to FETCH input, and the envelope to STRIP it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, 'ops-tools.ts'), 'utf8') as string;
    // (1) the schedule hop's INPUT must be selected, or the hop is structurally unreachable.
    expect(src).toMatch(/select:\s*\{[^}]*finishedAt:\s*true,\s*input:\s*true[^}]*\}/);
    // (2) …and it must NOT ride the envelope: Phase 0 requires the read's output to
    // stay byte-identical, and `input` is a large per-run blob.
    expect(src).toMatch(/const\s*\{\s*input:\s*_runInput,\s*\.\.\.rest\s*\}\s*=\s*r\s+as\s+any/);
    expect(src).not.toMatch(/\.\.\.r,\s*receipts:/);
  });

  // SAA-1.4 PHASE 1 (todo 2ef2b254) — the RENDER SITE, which Phase 0 lacked.
  // Phase 0 computed the chain only to record what a Phase-1 `next:` field WOULD
  // have offered: the metric fired and the envelope was never touched, so an
  // ARMED box still got no `next:` key on this surface. The apply-mode canary
  // caught it (probe-saa1-phase1-canary.js CHECK 5 classified get_run_receipts
  // SILENT against 484 injectable hops in the 7 days to 2026-11-04).
  // Source-pinned because the defect is a MISSING CALL, which no behavioural test
  // on the pure leaf can see — the leaf was always correct.
  it('pins the get_run_receipts envelope to RENDER the chain (not just observe it)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, 'ops-tools.ts'), 'utf8') as string;
    // The returned envelope must be the rendered one…
    expect(src).toMatch(/return redactReadEnvelope\(ctx,\s*name,\s*chatId,\s*recallEnvelope\)/);
    // …and it must actually be produced by the field renderer.
    expect(src).toMatch(/recallEnvelope\s*=\s*chainMod\.withRecallChainField\(envelope,\s*chain\)/);
  });
});

/**
 * THE GATE ITSELF, in test form. The leaf cases above prove the pure modules
 * behave; these prove the WIRED surface is untouched — i.e. criterion (c) of
 * the Phase 0 exit gate ("an EMPTY diff of the assembled prompt") held at the
 * function that actually builds the injected state, not at a helper beside it.
 */
describe('SAA-1.3 Phase 0 exit gate — the assembled drain state is byte-identical', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    id: `row-${i}`,
    content: `${'x'.repeat(1200)} message ${i}`,
    createdAt: new Date('2026-11-02T10:00:00Z'),
  }));
  const origins = rows.map((_, i) => ({ sourceChatId: `chat-${i}` }));
  const snapshot = { target: 'fleet supervisor chat', openDirectives: 2, pendingUserRows: 1 };
  const flags = { has_user_rows: true };

  it('the state WITH observation deeply equals the state WITHOUT it, and the observation is non-empty', () => {
    const { buildDrainTriageState } = require('./drain-triage');
    const now = new Date('2026-11-02T12:00:00Z').getTime();

    const plain = buildDrainTriageState({ snapshot, flags, rows, origins, now });
    const observation: any = { segments: [], droppedRows: 0, rows: 0 };
    const observed = buildDrainTriageState({ snapshot, flags, rows, origins, now, observe: observation });

    // THE PROMISE: identical assembled state, so the prompt the gate sees cannot
    // differ. JSON (not toEqual) because byte-identity is the actual claim.
    expect(JSON.stringify(observed)).toBe(JSON.stringify(plain));
    // …and the observation really did see the loss, so the case cannot pass
    // vacuously by observing nothing.
    expect(observation.rows).toBe(rows.length);
    expect(observation.segments.length).toBeGreaterThan(0);
    expect(observation.segments[0]).toMatchObject({ id: 'row-0' });
    expect(observation.segments[0].elidedChars).toBeGreaterThan(0);
    // The observation never leaks INTO the state under any key.
    expect(Object.keys(plain)).not.toContain('segments');
    expect(JSON.stringify(plain)).not.toContain('elidedChars');
  });

  it('the kill switch changes nothing about the state either — it only stops the observation', () => {
    const { buildDrainTriageState } = require('./drain-triage');
    const now = new Date('2026-11-02T12:00:00Z').getTime();
    const plain = buildDrainTriageState({ snapshot, flags, rows, origins, now });
    const prev = process.env.INLINE_SPILL_INJECTION_DISABLED;
    process.env.INLINE_SPILL_INJECTION_DISABLED = '1';
    try {
      const observation: any = { segments: [], droppedRows: 0, rows: 0 };
      const killed = buildDrainTriageState({ snapshot, flags, rows, origins, now, observe: observation });
      expect(JSON.stringify(killed)).toBe(JSON.stringify(plain));
      // Off is off: the plan is empty, so no metric row would be written.
      const plan = planInlineSpill({ surface: 'drain_triage', segments: observation.segments });
      expect(plan.mode).toBe('off');
      expect(plan.segments).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.INLINE_SPILL_INJECTION_DISABLED;
      else process.env.INLINE_SPILL_INJECTION_DISABLED = prev;
    }
  });

  // THE COLLECTOR, not just the leaf. The case above uses 6 rows, which can never
  // deplete a 4000-char budget (perRow = 4000/6 = 666, 6 x 666 = 3996) — so it
  // proves byte-identity but is structurally INCAPABLE of exercising `budget <= 0`.
  // The whole-row-drop class was therefore asserted only against the pure plan,
  // never against the builder that actually fills the observation. This drives the
  // real builder past the budget and pins BOTH halves of the promise: the drop is
  // seen, and the assembled state is still byte-identical WITH drops present.
  it('whole-row drops past the budget are seen by the builder AND still leave the state byte-identical', () => {
    const { buildDrainTriageState } = require('./drain-triage');
    const now = new Date('2026-11-02T12:00:00Z').getTime();
    // 21 rows x ~1210 chars: perRow floors at the 200-char minimum (4000/21 = 190),
    // so the first 20 consume the whole 4000-char budget and row 21 is skipped whole.
    const manyRows = Array.from({ length: 21 }, (_, i) => ({
      id: `drow-${i}`,
      content: `${'x'.repeat(1200)} body ${i}`,
      createdAt: new Date('2026-11-02T10:00:00Z'),
    }));
    const manyOrigins = manyRows.map((_, i) => ({ sourceChatId: `chat-${i}` }));

    const plain = buildDrainTriageState({ snapshot, flags, rows: manyRows, origins: manyOrigins, now });
    const observation: any = { segments: [], droppedRows: 0, rows: 0 };
    const observed = buildDrainTriageState({ snapshot, flags, rows: manyRows, origins: manyOrigins, now, observe: observation });

    // (1) The collector SAW the silently-dropped rows — the class the pre-fix
    // emptiness test (`!plan.segments.length`) could not emit at all.
    expect(observation.droppedRows).toBeGreaterThan(0);
    expect(observation.rows).toBe(21);
    // (2) …and the gate state is STILL byte-identical with drops present.
    expect(JSON.stringify(observed)).toBe(JSON.stringify(plain));
    // (3) The row the fix exists for is now emittable end-to-end from the builder.
    const plan = planInlineSpill({ surface: 'drain_triage', segments: observation.segments, droppedRows: observation.droppedRows });
    const meta: any = inlineSpillMetricMeta(plan, { chatId: 'c1' });
    expect(meta).not.toBeNull();
    expect(meta.droppedRows).toBe(observation.droppedRows);
    expect(meta.surface).toBe('drain_triage');
  });
});