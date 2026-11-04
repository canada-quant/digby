/**
 * FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20) — the pure leaf:
 * which events route PS-first, the escalation meta (new / append / tolerant
 * read), the delivery verdict (handled / rehold / escalate against the project
 * supervisor's high-water mark), the held-row predicate + its kill switch, the
 * escalation prompt, and the fleet [BOARD] top-goal pace line.
 */
import {
  ageText, appendPsEscalation, fleetAlarmPsFirstDisabled, fleetBoardGoalPaceDisabled, fleetDiffPsCoveredDisabled,
  isHeldPsEscalation, isPsCadenceEventType, isPsFirstEventType, newPsEscalation, pickAlarmHandles, pickTopGoal, psEscalationCapMs,
  psEscalationVerdict, psEscalationWanted, psShedPhase, readPsEscalation, renderFleetPaceLine, renderPsEscalationPrompt,
  PS_ESCALATION_DELAY_MS, PS_ESCALATION_INFLIGHT_RECHECK_MS, PS_ESCALATION_MAX_ALARMS, PS_ESCALATION_MAX_HOLD_MS, PS_ESCALATION_METRIC_KIND,
  type PsEscalationAlarm,
} from './fleet-ps-first';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T12:00:00Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const alarm = (min: number, over: Partial<PsEscalationAlarm> = {}): PsEscalationAlarm => ({
  eventType: 'run_failed', sourceChatId: 'lane-1', sourceChatTitle: 'Eval lane', at: at(min), summary: `failed at +${min}`, ...over,
});
const ENV = ['HOOK_FLEET_ALARM_PS_FIRST_DISABLED', 'FLEET_DIFF_PS_COVERED_EXCLUDE_DISABLED', 'FLEET_BOARD_GOAL_PACE_DISABLED'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('routing predicates', () => {
  it('routes the four alarm types + the two cadence signals PS-first; quiet types never', () => {
    for (const t of ['attention_needed', 'run_failed', 'goal_blocked', 'schedule_disabled', 'schedule_near_cap', 'schedule_cap_skipped']) expect(isPsFirstEventType(t)).toBe(true);
    for (const t of ['run_completed', 'todo_done', 'ci_failed', 'todo_wake', '', undefined]) expect(isPsFirstEventType(t)).toBe(false);
  });

  it('ONLY an alarm-class row escalates; the cadence signals and an alarm TYPE made quiet by its cause are shed', () => {
    expect(psEscalationWanted('run_failed', true)).toBe(true);
    expect(psEscalationWanted('run_failed', false)).toBe(false); // cancelled / resume-queued — no one needs it
    // The escalation is a todo_wake (alarm-class at the Fleet): a quiet cadence signal must never become one.
    expect(psEscalationWanted('schedule_near_cap', false)).toBe(false);
    expect(psEscalationWanted('schedule_cap_skipped', false)).toBe(false);
    expect([psShedPhase('schedule_near_cap'), psShedPhase('schedule_cap_skipped'), psShedPhase('run_failed')]).toEqual(['shed_cadence', 'shed_cadence', 'shed_quiet']);
    expect([isPsCadenceEventType('schedule_near_cap'), isPsCadenceEventType('schedule_disabled')]).toEqual([true, false]);
  });

  it('pickAlarmHandles keeps only the passthrough handles, trimmed and clipped', () => {
    expect(pickAlarmHandles({ ownerQuestionId: ' oq_abc ', triage: 'supervisor', runId: '', scheduleId: 7, goalId: 'g'.repeat(100) }))
      .toEqual({ ownerQuestionId: 'oq_abc', scheduleId: '7', goalId: 'g'.repeat(64) });
    expect(pickAlarmHandles({ triage: 'supervisor' })).toBeUndefined();
    expect(pickAlarmHandles(null)).toBeUndefined();
  });

  it('kill switches read their env', () => {
    expect([fleetAlarmPsFirstDisabled(), fleetDiffPsCoveredDisabled(), fleetBoardGoalPaceDisabled()]).toEqual([false, false, false]);
    for (const k of ENV) process.env[k] = '1';
    expect([fleetAlarmPsFirstDisabled(), fleetDiffPsCoveredDisabled(), fleetBoardGoalPaceDisabled()]).toEqual([true, true, true]);
    expect(PS_ESCALATION_METRIC_KIND).toBe('fleet_ps_escalation');
  });
});

describe('escalation meta', () => {
  it('new → append keeps the newest alarms, an exact count and the union of project supervisors', () => {
    let m = newPsEscalation({ projectId: 'p1', projectName: 'spark', psChatIds: ['ps-1', 'ps-1', ''], alarm: alarm(0) });
    expect(m).toMatchObject({ projectId: 'p1', projectName: 'spark', psChatIds: ['ps-1'], firstAt: at(0), count: 1 });
    for (let i = 1; i <= PS_ESCALATION_MAX_ALARMS + 2; i += 1) m = appendPsEscalation(m, alarm(i), i === 3 ? ['ps-2'] : []);
    expect(m.count).toBe(PS_ESCALATION_MAX_ALARMS + 3);
    expect(m.alarms).toHaveLength(PS_ESCALATION_MAX_ALARMS);
    expect(m.alarms[m.alarms.length - 1].at).toBe(at(PS_ESCALATION_MAX_ALARMS + 2));
    expect(m.firstAt).toBe(at(0));
    expect(m.psChatIds).toEqual(['ps-1', 'ps-2']);
  });

  it('clips a long summary; the tolerant reader rejects garbage and round-trips a stored meta', () => {
    const m = newPsEscalation({ projectId: 'p1', psChatIds: ['ps-1'], alarm: alarm(0, { summary: 'x'.repeat(2000), handles: { ownerQuestionId: 'oq_1', bogus: 'x' } as any }) });
    expect(m.alarms[0].summary.length).toBeLessThanOrEqual(280);
    expect(m.alarms[0].handles).toEqual({ ownerQuestionId: 'oq_1' });
    expect(readPsEscalation({ psEscalation: JSON.parse(JSON.stringify(m)) })).toEqual(m);
    const stamped = { ...m, escalatedAt: at(50) };
    expect(readPsEscalation({ psEscalation: JSON.parse(JSON.stringify(stamped)) })).toEqual(stamped);
    // A new alarm re-arms an escalated row: the stamp is dropped so its next escalation counts again.
    expect(appendPsEscalation(stamped, alarm(51)).escalatedAt).toBeUndefined();
    expect(readPsEscalation(null)).toBeNull();
    expect(readPsEscalation({ psEscalation: { projectId: 'p1', alarms: [] } })).toBeNull();
    expect(readPsEscalation({ psEscalation: { alarms: [alarm(0)] } })).toBeNull();
    expect(readPsEscalation({ psEscalation: { projectId: 'p1', alarms: [{ at: 'not a date' }] } })).toBeNull();
  });

  it('isHeldPsEscalation: escalation payload + future retryAt; a due row, a plain row and the kill switch are not held', () => {
    const payload = { psEscalation: newPsEscalation({ projectId: 'p1', psChatIds: ['ps-1'], alarm: alarm(0) }) };
    expect(isHeldPsEscalation({ payload, retryAt: new Date(T0 + 30 * MIN) }, T0)).toBe(true);
    expect(isHeldPsEscalation({ payload, retryAt: new Date(T0 - MIN) }, T0)).toBe(false);
    expect(isHeldPsEscalation({ payload, retryAt: null }, T0)).toBe(false);
    expect(isHeldPsEscalation({ payload: { summary: 'x' }, retryAt: new Date(T0 + 30 * MIN) }, T0)).toBe(false);
    process.env.HOOK_FLEET_ALARM_PS_FIRST_DISABLED = '1';
    expect(isHeldPsEscalation({ payload, retryAt: new Date(T0 + 30 * MIN) }, T0)).toBe(false);
  });
});

describe('psEscalationVerdict', () => {
  const meta = (...mins: number[]) => mins.slice(1).reduce((m, n) => appendPsEscalation(m, alarm(n)), newPsEscalation({ projectId: 'p1', psChatIds: ['ps-1'], alarm: alarm(mins[0]) }));
  const mark = (min: number, source: 'store' | 'transcript' | 'default' = 'store') => ({ at: new Date(T0 + min * MIN), source });

  it('a project supervisor wake that started after every alarm ⇒ handled', () => {
    expect(psEscalationVerdict(meta(0, 5), [mark(6)], T0 + 46 * MIN)).toEqual({ action: 'handled', handled: 2 });
  });

  it('no wake since the alarm (a wedged PS) ⇒ escalate with every alarm; the 24 h default mark is never proof', () => {
    const v = psEscalationVerdict(meta(0), [mark(-30)], T0 + 46 * MIN);
    expect(v).toMatchObject({ action: 'escalate', handled: 0, psMarkAt: new Date(T0 - 30 * MIN).toISOString() });
    expect(psEscalationVerdict(meta(0), [mark(10, 'default')], T0 + 46 * MIN)).toMatchObject({ action: 'escalate', psMarkAt: null });
    expect(psEscalationVerdict(meta(0), [null], T0 + 46 * MIN)).toMatchObject({ action: 'escalate' });
  });

  it('the PS handled the first alarm but a newer one is still inside its window ⇒ re-hold until that alarm has had it', () => {
    const v = psEscalationVerdict(meta(0, 30), [mark(10)], T0 + 46 * MIN);
    expect(v).toMatchObject({ action: 'rehold', handled: 1, reason: 'window' });
    if (v.action === 'rehold') {
      expect(v.until.getTime()).toBe(T0 + 30 * MIN + PS_ESCALATION_DELAY_MS);
      expect(v.unhandled.map((a) => a.at)).toEqual([at(30)]);
    }
  });

  it('the re-hold is capped from the FIRST alarm — past the cap the unhandled alarms escalate', () => {
    const v = psEscalationVerdict(meta(0, 80), [mark(10)], T0 + PS_ESCALATION_MAX_HOLD_MS + MIN);
    expect(v).toMatchObject({ action: 'escalate', handled: 1 });
    if (v.action === 'escalate') expect(v.unhandled.map((a) => a.at)).toEqual([at(80)]);
    const capped = psEscalationVerdict(meta(0, 80), [mark(10)], T0 + 85 * MIN);
    expect(capped).toMatchObject({ action: 'rehold' });
    if (capped.action === 'rehold') expect(capped.until.getTime()).toBe(T0 + PS_ESCALATION_MAX_HOLD_MS);
  });

  it('the newest mark across several project supervisors counts', () => {
    expect(psEscalationVerdict(meta(0), [mark(-5), mark(3, 'transcript')], T0 + 46 * MIN)).toMatchObject({ action: 'handled' });
  });

  it('a PS wake still RUNNING that started after the alarm re-holds for a recheck (same cap); one started before it does not', () => {
    const now = T0 + 46 * MIN;
    const v = psEscalationVerdict(meta(0), [mark(-30)], now, { inflightStartMs: T0 + 30 * MIN });
    expect(v).toMatchObject({ action: 'rehold', reason: 'inflight', handled: 0 });
    if (v.action === 'rehold') expect(v.until.getTime()).toBe(now + PS_ESCALATION_INFLIGHT_RECHECK_MS);
    // The recheck never runs past the cap from the first alarm.
    const nearCap = psEscalationVerdict(meta(0), [mark(-30)], T0 + 85 * MIN, { inflightStartMs: T0 + 30 * MIN });
    expect(nearCap).toMatchObject({ action: 'rehold', reason: 'inflight' });
    if (nearCap.action === 'rehold') expect(nearCap.until.getTime()).toBe(psEscalationCapMs(meta(0)));
    // Past the cap a still-running wake no longer holds it — the Fleet is told one is in flight.
    expect(psEscalationVerdict(meta(0), [mark(-30)], T0 + PS_ESCALATION_MAX_HOLD_MS + MIN, { inflightStartMs: T0 + 30 * MIN }))
      .toMatchObject({ action: 'escalate', inflight: true });
    // A wake that started BEFORE the oldest unhandled alarm is not the one handling it.
    expect(psEscalationVerdict(meta(0), [mark(-30)], now, { inflightStartMs: T0 - MIN })).toMatchObject({ action: 'escalate', inflight: false });
    expect(psEscalationVerdict(meta(0), [mark(-30)], now, { inflightStartMs: null })).toMatchObject({ action: 'escalate', inflight: false });
  });
});

describe('renderPsEscalationPrompt', () => {
  it('names the project, its project supervisor, each alarm with the lane id, and the read-the-PS-first move', () => {
    let m = newPsEscalation({ projectId: 'p1234567-aaaa', projectName: 'spark-cluster', psChatIds: ['ps-chat-1'], alarm: alarm(0, { summary: 'OOM on shard 3' }) });
    m = appendPsEscalation(m, alarm(4, { eventType: 'attention_needed', sourceChatId: 'lane-2', sourceChatTitle: 'Bench lane', summary: 'needs a decision' }));
    const p = renderPsEscalationPrompt(m);
    expect(p.startsWith('[PS ESCALATION — harness-delayed alarm] Project "spark-cluster" (p1234567)')).toBe(true);
    expect(p).toContain('chat id ps-chat-1');
    // Enqueue-time wording is NEUTRAL (a fail-open / kill-switch delivery is not revalidated).
    expect(p).toContain('check its chat before acting — it may already have handled them');
    expect(p).not.toContain('has not completed a wake');
    // Only the delivery-time re-render after a revalidation states the fact.
    const r = renderPsEscalationPrompt(m, { revalidated: true });
    expect(r).toContain('held ≥45 min for it first, and it has not completed a wake since they fired:');
    expect(renderPsEscalationPrompt(m, { revalidated: true, inflight: true })).toContain('a wake it started after them is still running past the hold cap');
    expect(p).toContain('- run_failed at 12:00Z from lane "Eval lane" (chat id lane-1): OOM on shard 3');
    expect(p).toContain('- attention_needed at 12:04Z from lane "Bench lane" (chat id lane-2): needs a decision');
    expect(p).toContain('Read the project supervisor first');
    // Re-rendered at delivery with the unhandled subset only.
    expect(renderPsEscalationPrompt(m, { alarms: [m.alarms[1]] })).not.toContain('OOM on shard 3');
  });

  it('renders the passthrough handles after the clipped summary — the owner question id survives a long triage summary', () => {
    const long = `[OWNER-QUESTION TRIAGE — answer under standing directives or leave for the owner] ${'q'.repeat(1400)} — question id oq_tail1`;
    const m = newPsEscalation({ projectId: 'p1', psChatIds: ['ps-1'], alarm: alarm(0, { eventType: 'attention_needed', summary: long, handles: { ownerQuestionId: 'oq_tail1' } }) });
    const line = renderPsEscalationPrompt(m).split('\n').find((l) => l.startsWith('- attention_needed')) as string;
    expect(line).toContain('…');
    expect(line.endsWith(' — owner question id oq_tail1')).toBe(true);
    const two = newPsEscalation({ projectId: 'p1', psChatIds: [], alarm: alarm(0, { handles: { runId: 'r-1', scheduleId: 's-1' } }) });
    expect(renderPsEscalationPrompt(two)).toContain(': failed at +0 — run id r-1 · schedule id s-1');
  });

  it('says how many earlier alarms the bounded list dropped', () => {
    let m = newPsEscalation({ projectId: 'p1', psChatIds: [], alarm: alarm(0) });
    for (let i = 1; i < PS_ESCALATION_MAX_ALARMS + 3; i += 1) m = appendPsEscalation(m, alarm(i));
    const p = renderPsEscalationPrompt(m);
    expect(p).toContain('chat id unknown');
    expect(p).toContain('- …and 3 earlier alarm(s) from this project not listed');
  });
});

describe('fleet [BOARD] pace line', () => {
  it('pickTopGoal: KPI of record first, then active over blocked, then the most open work, then the oldest', () => {
    const g = (id: string, over: any = {}) => ({ id, title: id, status: 'active', createdAt: '2026-10-01T00:00:00Z', openTodos: 0, ...over });
    expect(pickTopGoal([g('a', { openTodos: 9 }), g('kpi', { hasKpi: true, status: 'blocked' })])?.id).toBe('kpi');
    expect(pickTopGoal([g('blocked', { status: 'blocked', openTodos: 9 }), g('active')])?.id).toBe('active');
    expect(pickTopGoal([g('few', { openTodos: 1 }), g('many', { openTodos: 5 })])?.id).toBe('many');
    expect(pickTopGoal([g('young', { createdAt: '2026-10-10T00:00:00Z' }), g('old', { createdAt: '2026-09-01T00:00:00Z' })])?.id).toBe('old');
    expect(pickTopGoal([g('done', { status: 'done' })])).toBeNull();
    expect(pickTopGoal([])).toBeNull();
  });

  it('renders goal, pace, KPI and last-move age; no move ⇒ said so', () => {
    const now = new Date(T0);
    expect(renderFleetPaceLine({ goalId: 'g1234567-xxxx', goalTitle: 'Ship dflash2E at parity', pace: 'at the current pace roughly 3 more days', kpi: 'KPI tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10)', lastMoveMs: T0 - 3 * 3_600_000, now }))
      .toBe('  ↳ top goal g1234567 "Ship dflash2E at parity": at the current pace roughly 3 more days · KPI tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · last move 3h ago');
    expect(renderFleetPaceLine({ goalId: 'g1', goalTitle: 'x'.repeat(80), pace: 'no movement in the last week, so no reliable estimate', lastMoveMs: null, now }))
      .toMatch(/"x{47}…": no movement in the last week, so no reliable estimate · no move recorded$/);
    expect([ageText(5 * MIN), ageText(3 * 3_600_000), ageText(4 * 86_400_000), ageText(-1)]).toEqual(['5m', '3h', '4d', '0m']);
  });
});
