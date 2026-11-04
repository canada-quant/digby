/**
 * sup3 audit C2 (2026-09-27) — the pure done-suspect leaf. Replays the two
 * production closes the audit named: spark a57fb2e2 ("≥20 tok/s") closed at
 * an observed 5.33, and bench f6b31f1b closed with progressNote "redeploy of
 * :3001 held" while 34 HOLD reports followed.
 *
 * Review fixes (sup3 fixer pass, 2026-09-27): finding 1 — a source-less
 * target premise is `premise_target_unobserved` (telemetry only, never a
 * badge, remedy = goal_premise_set observed); finding 3 — the owner's own
 * close order, a directive inside the grace window, and another project's
 * directive never count; finding 4 — "holds" / "holding steady" / "halted
 * the container" / "pauses for 2s" are progress verbs, not holds.
 */
import {
  assessGoalDoneSuspect, targetPremiseMet, targetPremiseState, targetBound, isTargetPremise, unmetTargetPremises, unobservedTargetPremises,
  holdTokenIn, directiveNamesGoal, directiveOrdersClose, directiveInScope, relevantDirectives, renderGoalDoneSuspectBadge, formatUnmetPremise,
  GOAL_DONE_SUSPECT_BADGE, GOAL_DONE_SUSPECT_DIRECTIVE_GRACE_MS, GOAL_DONE_SUSPECT_BOARD_REASONS,
  isOriginatingDirective,
} from './goal-done-suspect';


const NOW = Date.parse('2026-09-27T12:00:00Z');
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600_000;

describe('target premises', () => {
  it('recognises target_* / target. / target- / target: keys only', () => {
    expect(isTargetPremise({ key: 'target_tok_per_s', value: 20 })).toBe(true);
    expect(isTargetPremise({ key: 'Target.suite_mean', value: 1 })).toBe(true);
    expect(isTargetPremise({ key: 'target-p95-ms', value: 1 })).toBe(true);
    expect(isTargetPremise({ key: 'target', value: 1 })).toBe(true);
    expect(isTargetPremise({ key: 'untrained_base_suite_mean', value: 60.07 })).toBe(false);
    expect(isTargetPremise({ key: 'targeting_budget', value: 1 })).toBe(false);
    expect(isTargetPremise(null)).toBe(false);
  });

  it('defaults to "at least"; max / ceiling / upper / under / below / at_most / le flip to "at most"', () => {
    expect(targetBound('target_tok_per_s')).toBe('min');
    expect(targetBound('target_max_latency_ms')).toBe('max');
    expect(targetBound('target_p95_ceiling')).toBe('max');
    expect(targetBound('target.under.cost_usd')).toBe('max');
    expect(targetBound('target_le_loss')).toBe('max');
    // "under" only as a whole segment — a key that merely CONTAINS the letters stays min.
    expect(targetBound('target_thunder_score')).toBe('min');
  });

  it('REPLAY spark a57fb2e2: ≥20 tok/s observed 5.33 is unmet; 21 is met; unobserved is NOT met (and not unmet either)', () => {
    expect(targetPremiseMet({ key: 'target_tok_per_s', value: 20, observed: 5.33 })).toBe(false);
    expect(targetPremiseState({ key: 'target_tok_per_s', value: 20, observed: 5.33 })).toBe('unmet');
    expect(targetPremiseMet({ key: 'target_tok_per_s', value: 20, observed: 21 })).toBe(true);
    expect(targetPremiseMet({ key: 'target_tok_per_s', value: 20, observed: 20 })).toBe(true);
    expect(targetPremiseMet({ key: 'target_tok_per_s', value: 20 })).toBe(false);
    expect(targetPremiseState({ key: 'target_tok_per_s', value: 20 })).toBe('unobserved');
    expect(targetPremiseState({ key: 'target_tok_per_s', value: 20, observed: 'n/a' })).toBe('unobserved');
    expect(targetPremiseState({ key: 'target_tok_per_s', value: 'NaN' })).toBe('malformed');
  });

  it('tolerance widens the bar; an upper bound accepts observed ≤ value + tol', () => {
    expect(targetPremiseMet({ key: 'target_tok_per_s', value: 20, observed: 19.5, tolerance: 0.5 })).toBe(true);
    expect(targetPremiseMet({ key: 'target_tok_per_s', value: 20, observed: 19.4, tolerance: 0.5 })).toBe(false);
    expect(targetPremiseMet({ key: 'target_max_latency_ms', value: 300, observed: 305, tolerance: 10 })).toBe(true);
    expect(targetPremiseMet({ key: 'target_max_latency_ms', value: 300, observed: 400 })).toBe(false);
  });

  it('unmetTargetPremises lists OBSERVED-and-missing target keys only; unobservedTargetPremises the rest; malformed rows and non-arrays skipped', () => {
    const rows = [
      { key: 'target_tok_per_s', value: 20, observed: 5.33, unit: 'tok/s' },
      { key: 'target_suite_mean', value: 65, observed: 66.1 },
      { key: 'target_p95_ms', value: 400, note: 'measured in run r-9' },
      { key: 'baseline', value: 60.07 },
      { key: 'target_bogus', value: 'NaN' },
      null,
    ];
    const u = unmetTargetPremises(rows);
    expect(u).toEqual([{ key: 'target_tok_per_s', value: 20, observed: 5.33, unit: 'tok/s', bound: 'min' }]);
    expect(unobservedTargetPremises(rows)).toEqual([{ key: 'target_p95_ms', value: 400, observed: null, bound: 'min' }]);
    expect(unmetTargetPremises('nope')).toEqual([]);
    expect(unobservedTargetPremises('nope')).toEqual([]);
    expect(formatUnmetPremise(u[0])).toBe('target_tok_per_s ≥20tok/s, observed 5.33tok/s');
    expect(formatUnmetPremise({ key: 'target_x', value: 1, observed: null, bound: 'max' })).toBe('target_x ≤1 never observed');
  });
});

describe('hold tokens', () => {
  it('REPLAY bench f6b31f1b: "redeploy of :3001 held" is a hold token', () => {
    expect(holdTokenIn('redeploy of :3001 held')).toBe('held');
    expect(holdTokenIn('redeploy of :3001 held; 34 reports')).toBe('held');
    expect(holdTokenIn('HOLD: waiting for the GPU box')).toBe('HOLD');
    expect(holdTokenIn('HOLD until the owner rules')).toBe('HOLD');
    expect(holdTokenIn('hold — redeploy pending the owner')).toBe('hold');
    expect(holdTokenIn('[hold] shard 3 pending')).toBe('hold');
    expect(holdTokenIn('on hold pending owner')).toBe('on hold');
    expect(holdTokenIn('paused until the bench reruns')).toBe('paused until');
    expect(holdTokenIn('halted at shard 3')).toBe('halted at');
    expect(holdTokenIn('holding for the owner ruling')).toBe('holding for');
    expect(holdTokenIn('held back by the quota reset')).toBe('held');
    expect(holdTokenIn('standing by for the owner')).toBe('standing by');
    expect(holdTokenIn('awaiting the owner')).toBe('awaiting the owner');
    expect(holdTokenIn('waiting on the owner for the go')).toBe('waiting on the owner');
  });
  it('ordinary progress is not a hold (finding 4 — the seven probe sentences + the verb senses)', () => {
    expect(holdTokenIn('benchmark holds at 92.4% suite mean after CPT')).toBeNull();
    expect(holdTokenIn('this result holds across all three seeds')).toBeNull();
    expect(holdTokenIn('PR #1102 holds the fix; merged')).toBeNull();
    expect(holdTokenIn('holding steady at 21 tok/s over 30 min')).toBeNull();
    expect(holdTokenIn('halted the stale :3001 container, new one serves')).toBeNull();
    expect(holdTokenIn('the bench pauses for 2s between prompts by design')).toBeNull();
    expect(holdTokenIn('pause between batches removed; 5/5 shards')).toBeNull();
    expect(holdTokenIn('held the fix in PR #1102; merged')).toBeNull();
    expect(holdTokenIn('the result held across seeds')).toBeNull();
    expect(holdTokenIn('threshold at 92% — 3/5 shards trained, loss 2.1')).toBeNull();
    expect(holdTokenIn('household budget reconciled')).toBeNull(); // no \\b match inside a word
    expect(holdTokenIn('behold the numbers: 24 tok/s')).toBeNull();
    expect(holdTokenIn(null)).toBeNull();
    expect(holdTokenIn('')).toBeNull();
  });
});

describe('open directives', () => {
  it('names the goal when ≥30% of its key terms (and ≥2) appear in the directive', () => {
    expect(directiveNamesGoal('Do not close the vLLM throughput bench until 20 tok/s holds', 'vLLM throughput bench ≥20 tok/s')).toBe(true);
    expect(directiveNamesGoal('Rotate the Slack token', 'vLLM throughput bench ≥20 tok/s')).toBe(false);
    // A one-term title can never match (min shared 2).
    expect(directiveNamesGoal('finish the bench', 'bench')).toBe(false);
    expect(directiveNamesGoal('anything', '')).toBe(false);
  });

  it('directiveOrdersClose: the owner ORDERING the close is not an open contradiction; a negated / anti-close order still is', () => {
    expect(directiveOrdersClose('Mark the vLLM serving goal done — the 20 tok/s bar is met, I checked the box myself')).toBe(true);
    expect(directiveOrdersClose('close it, the target has been reached')).toBe(true);
    expect(directiveOrdersClose('call the quant box goal finished')).toBe(true);
    expect(directiveOrdersClose('the serving goal is done, move on to CanLaw')).toBe(true);
    expect(directiveOrdersClose('spark-cluster: quant box serving lane, keep going')).toBe(false);
    expect(directiveOrdersClose('Keep the vLLM serving lane on the tok/s target until it holds')).toBe(false);
    expect(directiveOrdersClose('Do not close the vLLM throughput bench as done until 20 tok/s holds')).toBe(false);
    expect(directiveOrdersClose("don't mark it done before the rerun")).toBe(false);
    expect(directiveOrdersClose('never treat the bench as complete without the seed sweep')).toBe(false);
    expect(directiveOrdersClose(null)).toBe(false);
  });

  it('directiveInScope: unset / fleet / same project count; another project does not; a missing project name never drops', () => {
    expect(directiveInScope(undefined, 'spark-cluster')).toBe(true);
    expect(directiveInScope('fleet', 'spark-cluster')).toBe(true);
    expect(directiveInScope('Spark-Cluster ', 'spark-cluster')).toBe(true);
    expect(directiveInScope('CanLaw', 'spark-cluster')).toBe(false);
    expect(directiveInScope('CanLaw', null)).toBe(true);
  });

  it('relevantDirectives: the ordered close, the grace-window directive, the run-window directive and the cross-project directive are excluded', () => {
    const goal = { title: 'vLLM serving ≥20 tok/s on the quant box' };
    const base = { text: 'spark-cluster: quant box serving lane, keep going — the vLLM serving goal stays open until 20 tok/s' };
    const old = { ...base, id: 'd-old', at: agoMs(5 * H) };
    const ordered = { id: 'd-ord', text: 'Mark the vLLM serving goal done — the 20 tok/s bar is met, I checked the box myself', at: agoMs(5 * H) };
    const fresh = { ...base, id: 'd-new', at: agoMs(GOAL_DONE_SUSPECT_DIRECTIVE_GRACE_MS - 60_000) };
    const canlaw = { ...base, id: 'd-cl', at: agoMs(5 * H), scope: 'CanLaw' };
    const fleet = { ...base, id: 'd-fl', at: agoMs(5 * H), scope: 'fleet' };
    const undated = { ...base, id: 'd-ud', at: 'garbage' };
    const ids = (ds: any[], opts: any = {}) => relevantDirectives(goal, ds, { now: NOW, projectName: 'spark-cluster', ...opts }).map((d) => d.id);
    expect(ids([old, ordered, fresh, canlaw, fleet, undated])).toEqual(['d-old', 'd-fl', 'd-ud']);
    // A directive recorded after the acting run started is this wake's own order too.
    expect(ids([old], { runStartedAt: NOW - 6 * H })).toEqual([]);
    expect(ids([old], { runStartedAt: NOW - 4 * H })).toEqual(['d-old']);
    // No project name ⇒ no scope filter (never drop on a missing fact).
    expect(ids([canlaw], { projectName: null })).toEqual(['d-cl']);
  });
});

describe('assessGoalDoneSuspect', () => {
  const spark = { title: 'vLLM serving ≥20 tok/s', premises: [{ key: 'target_tok_per_s', value: 20, observed: 5.33, unit: 'tok/s' }] };

  it('returns the three badge-class reasons with a note naming the REAL remedy; a clean close returns none', () => {
    const v = assessGoalDoneSuspect(
      { ...spark, progressNote: 'redeploy of :3001 held' },
      [{ id: 'd-12345678', text: 'Keep the vLLM serving lane on the tok/s target until it holds', at: agoMs(5 * H) }],
      { now: NOW },
    );
    expect(v.reasons).toEqual(['premise_target_unmet', 'hold_token', 'open_directive']);
    expect(v.boardReasons).toEqual(['premise_target_unmet', 'hold_token']);
    expect(v.unmetPremises[0].key).toBe('target_tok_per_s');
    expect(v.unobservedPremises).toEqual([]);
    expect(v.holdToken).toBe('held');
    expect(v.directiveIds).toEqual(['d-123456']);
    expect(v.note).toContain(GOAL_DONE_SUSPECT_BADGE);
    expect(v.note).toContain('observed 5.33tok/s');
    expect(v.note).toContain('the close stands (observe-only)');
    expect(v.note).toContain("reopen the goal (goal_update status:'active') or record the measured value (goal_premise_set observed + observedNote)");
    expect(v.note).not.toContain('record the met premise');

    const clean = assessGoalDoneSuspect({ title: 'Ship it', progressNote: '3/5 done', premises: [{ key: 'target_tok_per_s', value: 20, observed: 22 }] });
    expect(clean.reasons).toEqual([]);
    expect(clean.note).toBe('');
  });

  it('finding 1: a source-less target premise with a note is premise_target_unobserved — telemetry only, NO badge, remedy = record it, never reopen', () => {
    const v = assessGoalDoneSuspect({ title: 'x', premises: [{ key: 'target_tok_per_s', value: 20, note: 'measured 24.1 in run r-9' }] });
    expect(v.reasons).toEqual(['premise_target_unobserved']);
    expect(v.boardReasons).toEqual([]);
    expect(v.unobservedPremises).toEqual([{ key: 'target_tok_per_s', value: 20, observed: null, bound: 'min' }]);
    expect(renderGoalDoneSuspectBadge(v)).toBe('');
    expect(v.note).not.toContain(GOAL_DONE_SUSPECT_BADGE);
    expect(v.note).not.toContain('reopen');
    expect(v.note).toContain('record the measured value with goal_premise_set observed + observedNote');
    expect(GOAL_DONE_SUSPECT_BOARD_REASONS.has('premise_target_unobserved')).toBe(false);
    // …and once the lane records the measured value (goal_premise_set observed), the close is clean.
    expect(assessGoalDoneSuspect({ title: 'x', premises: [{ key: 'target_tok_per_s', value: 20, observed: 24.1, observedNote: 'run r-9' }] }).reasons).toEqual([]);
  });

  it('a HOLD in blockedReason counts when the note is clean (the row as written)', () => {
    expect(assessGoalDoneSuspect({ title: 'x', blockedReason: 'HOLD until the owner rules' }).reasons).toEqual(['hold_token']);
  });

  // Ticket a8d6e514: a note may now carry a 2,000-char continuation ledger — the HOLD idiom is read from its LEAD
  // (the first 200 chars, what the reader always saw), so an old cycle's "on hold" deep in the ledger never badges.
  it('a8d6e514: the hold idiom is read from the note lead only', () => {
    const clean = 'Shipped: all 3 shards trained, loss 2.1, PR #412 merged.';
    const tail = `${clean}${' '.repeat(200 - clean.length)} ledger f12: the canary was on hold until the window opened; f13 resumed.`;
    expect(assessGoalDoneSuspect({ title: 'x', progressNote: tail }).reasons).toEqual([]);
    expect(assessGoalDoneSuspect({ title: 'x', progressNote: `redeploy of :3001 held — ${'ledger '.repeat(60)}` }).reasons).toEqual(['hold_token']);
  });

  it('finding 3: the close the owner ORDERED is not an open_directive suspect', () => {
    const v = assessGoalDoneSuspect(
      { title: 'vLLM serving ≥20 tok/s on the quant box' },
      [{ id: 'd-1', text: 'Mark the vLLM serving goal done — the 20 tok/s bar is met, I checked the box myself', at: agoMs(2 * H) }],
      { now: NOW, projectName: 'spark-cluster' },
    );
    expect(v.reasons).toEqual([]);
  });

  it('never throws on garbage input', () => {
    expect(assessGoalDoneSuspect({ title: 1 as any, premises: { key: 'target_x' } as any, progressNote: {} as any }, [{ text: null as any }]).reasons).toEqual([]);
  });

  it('renders a short board badge with the first unmet premise; unobserved-only and directive-only verdicts render nothing', () => {
    const v = assessGoalDoneSuspect({ ...spark, progressNote: 'held' });
    expect(renderGoalDoneSuspectBadge(v)).toBe('⚠ suspect: premise_target_unmet, hold_token (target_tok_per_s ≥20tok/s, observed 5.33tok/s)');
    expect(renderGoalDoneSuspectBadge({ reasons: [], unmetPremises: [] })).toBe('');
    expect(renderGoalDoneSuspectBadge({ reasons: ['open_directive'], unmetPremises: [] })).toBe('');
    // Board-time re-derivation (2026-09-28): a caller that assessed against a live directive read badges it.
    expect(renderGoalDoneSuspectBadge({ reasons: ['open_directive'], unmetPremises: [] }, { withDirectives: true })).toBe('⚠ suspect: open_directive');
    expect(renderGoalDoneSuspectBadge({ reasons: ['hold_token', 'open_directive'], boardReasons: ['hold_token'], unmetPremises: [] }, { withDirectives: true })).toBe('⚠ suspect: hold_token, open_directive');
    expect(renderGoalDoneSuspectBadge({ reasons: ['premise_target_unobserved', 'open_directive'], unmetPremises: [] }, { withDirectives: false })).toBe('');
    expect(renderGoalDoneSuspectBadge({ reasons: ['premise_target_unobserved'], unmetPremises: [] })).toBe('');
  });
});

// ── audit 2026-10-08 W5-5: the goal's own ORIGINATING directive is never a suspect reason ──
// The real rows (owner directives + goals, prod 2026-10-07/08): every open_directive
// strike in the 3 days before the audit fired on the directive that CREATED the goal.
describe('W5-5 — originating directives', () => {
  const OPTCG = { id: '2f45b016-6fff-42bd-9173-65fd51778e40', title: 'Ingest official OPTCG events + event rules into DB, API/UI, and RAG', createdAt: '2026-10-07T21:54:34.693Z' };
  const B3A = { id: 'b3a7775f-2daa-423d-8b7c-49902849aa30', at: '2026-10-07T21:53:25.874Z', text: 'add events and special event details to database and knkowlege base and rag and build out more integrations for all rules events evetn rules standard vs special events etc' };
  const DASH = { id: '5586ccd7-048d-4d30-8cc6-fabc5d56fcd0', title: 'Polished fleet health dashboard — live per-device metrics overview', createdAt: '2026-10-07T17:10:15.270Z' };
  const D9C = { id: '9c2f9b73-8b70-4408-8ea5-1f5ee76935dd', at: '2026-10-07T17:08:24.304Z', text: 'ok the main ui is not very clean and polished and doesnt have a good overview for a quick look into all health of devices…we need alot more features and views ie. gpu % memory % thourghput % network throughputs' };
  const D443 = { id: '443ff515-4117-4a3b-bb9a-d6af737ef9b7', at: '2026-10-07T17:11:06.792Z', text: 'Rebuild the main UI — not clean/polished, needs a quick-look fleet health overview with many more features: GPU %, memory %, throughput %, network throughputs, storage %, models served, containers running — all dynamic' };
  afterEach(() => { delete process.env.GOAL_DONE_SUSPECT_ORIGIN_DIRECTIVE_DISABLED; });

  it('REPLAY 2f45b016 ← b3a7775f: the owner order that created the goal (69 s before it) no longer marks the auto-close suspect', () => {
    const closeAt = Date.parse('2026-10-08T16:48:53.198Z');
    expect(directiveNamesGoal(B3A.text, OPTCG.title)).toBe(true); // the title overlap that fired before
    expect(relevantDirectives(OPTCG, [B3A], { now: closeAt })).toEqual([]);
    expect(assessGoalDoneSuspect(OPTCG, [B3A], { now: closeAt }).reasons).toEqual([]);
    process.env.GOAL_DONE_SUSPECT_ORIGIN_DIRECTIVE_DISABLED = '1';
    expect(assessGoalDoneSuspect(OPTCG, [B3A], { now: closeAt }).reasons).toEqual(['open_directive']); // pre-fix
  });

  it('REPLAY 5586ccd7 ← 9c2f9b73 + 443ff515: the owner order AND the supervisor\'s restatement 51 s after the goal are both its origin', () => {
    const closeAt = Date.parse('2026-10-07T20:28:09.919Z');
    expect(relevantDirectives(DASH, [D9C, D443], { now: closeAt })).toEqual([]);
  });

  it('a directive recorded AFTER the goal existed (beyond the slack) still counts — unless its evidence cites the goal or a lane', () => {
    const later = { id: 'later001', at: '2026-10-08T03:00:00.000Z', text: 'the OPTCG events rules RAG ingest must also cover regional events before it is done' };
    const closeAt = Date.parse('2026-10-08T16:48:53.198Z');
    expect(relevantDirectives(OPTCG, [later], { now: closeAt }).map((d) => d.id)).toEqual(['later001']);
    expect(relevantDirectives(OPTCG, [{ ...later, evidence: 'dispatched: goal 2f45b016 lane 7bd45d57' }], { now: closeAt })).toEqual([]);
    expect(relevantDirectives(OPTCG, [{ ...later, evidence: 'lane 7bd45d57 working' }], { now: closeAt, laneIds: ['7bd45d57-059b-42c5-8245-ea1ee358635f'] })).toEqual([]);
    // the directive's own TEXT naming the goal id is a real signal, never an origin marker
    expect(isOriginatingDirective(OPTCG, { ...later, text: `${later.text} (goal 2f45b016)` })).toBe(false);
  });

  it('a goal without createdAt / id keeps the pre-fix behaviour (no origin evidence)', () => {
    expect(isOriginatingDirective({ title: OPTCG.title }, B3A)).toBe(false);
  });
});
