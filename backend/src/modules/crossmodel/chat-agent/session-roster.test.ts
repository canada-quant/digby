/**
 * roster 2026-10-06 D-1 — the persisted SESSION ROSTER: hysteresis (up at once, down one lane per turn), the record of
 * what ran, the read / write seam (modes, canary, kill switch, fail-open) and the lead stickiness.
 */
import {
  nextSessionLane, ranLaneOf, needLaneOf, maxLane, applyRosterTurn, parseSessionRoster, readSessionRosterForTurn,
  saveSessionRosterTurn, guardPriorLane, applyStickyLead, rosterActsFor, sessionRosterMetricMeta, rosterDepthRecord,
  newRosterTrace, sessionRosterNamespace, SESSION_ROSTER_KEY, ROSTER_HISTORY_MAX, ROSTER_OFF, STICKY_LEAD_MARGIN,
  type RosterIo, type SessionRoster, type RosterTurnInput,
} from './session-roster';
import { parseRosterConfig } from '../platform/roster-config';
import { SWITCH_MARGIN, type ModelPick } from '../platform/model-pick';

const turn = (over: Partial<RosterTurnInput> = {}): RosterTurnInput => ({
  messageId: 'm1', planLane: 'standard', ranLane: 'standard', lead: 'glm-5.3', checker: null, colleagues: [], callIn: null, ...over,
});

function memIo(config: Record<string, unknown>, rows: Map<string, unknown> = new Map()): RosterIo & { rows: Map<string, unknown>; puts: number } {
  const io: any = {
    rows, puts: 0,
    config: async () => parseRosterConfig(config),
    get: async (ns: string[], key: string) => rows.get(`${ns.join(':')}|${key}`) ?? null,
    put: async (ns: string[], key: string, value: Record<string, unknown>) => { io.puts += 1; rows.set(`${ns.join(':')}|${key}`, JSON.parse(JSON.stringify(value))); },
  };
  return io;
}

afterEach(() => { delete process.env.SESSION_ROSTER_DISABLED; delete process.env.SESSION_ROSTER_STICKY_LEAD_DISABLED; });

describe('hysteresis (pure)', () => {
  it('up at once, down at most one lane per turn, no prior ⇒ the need', () => {
    expect(nextSessionLane(null, 'quick')).toBe('quick');
    expect(nextSessionLane('quick', 'research')).toBe('research'); // up at once
    expect(nextSessionLane('research', 'quick')).toBe('checked'); // down ONE
    expect(nextSessionLane('checked', 'quick')).toBe('standard');
    expect(nextSessionLane('standard', 'quick')).toBe('quick');
    expect(nextSessionLane('checked', 'checked')).toBe('checked');
    expect(nextSessionLane('bogus' as any, 'standard')).toBe('standard');
  });

  it('the ran lane: council ⇒ research, a checker ⇒ checked, the Quick lane ⇒ quick, else standard', () => {
    expect(ranLaneOf({ quick: false, council: true, checker: false })).toBe('research');
    expect(ranLaneOf({ quick: false, council: false, checker: true })).toBe('checked');
    expect(ranLaneOf({ quick: true, council: false, checker: false })).toBe('quick');
    expect(ranLaneOf({ quick: false, council: false, checker: false })).toBe('standard');
  });

  it('the NEED lane is the turn plan\'s lane (not the preset\'s checker), raised by a council that ran, a Dig-deeper rung or a call_in', () => {
    // a keyword-L2 turn RAN a checker but the plan said standard — the session is not pushed to checked by the preset
    expect(needLaneOf({ planLane: 'standard', ranLane: 'checked' })).toBe('standard');
    // a council RAN (an explicit research request / preset 3) — the session is research whatever the classifier said
    expect(needLaneOf({ planLane: 'standard', ranLane: 'research' })).toBe('research');
    expect(needLaneOf({ planLane: null, ranLane: 'checked' })).toBe('checked'); // the plan was silent ⇒ what ran
    expect(needLaneOf({ planLane: 'quick', ranLane: 'quick', escalationRung: 'verify' })).toBe('checked');
    expect(needLaneOf({ planLane: null, ranLane: 'research', escalationRung: 'research' })).toBe('research');
    expect(needLaneOf({ planLane: 'standard', ranLane: 'standard', callInRole: 'checker' })).toBe('checked');
    expect(needLaneOf({ planLane: 'standard', ranLane: 'standard', callInRole: 'colleague' })).toBe('research');
    expect(maxLane(null, 'quick', undefined, 'checked')).toBe('checked');
  });
});

describe('the record (pure)', () => {
  it('folds turns: lane + models that ran, the session lane after hysteresis, bounded history', () => {
    let r: SessionRoster | null = null;
    r = applyRosterTurn(r, turn({ planLane: 'research', ranLane: 'research', colleagues: ['deepseek-flash', 'kimi-k3', 'kimi-k3'] }), new Date('2026-10-06T10:00:00Z'));
    expect(r).toMatchObject({ v: 1, sessionLane: 'research', turns: 1, last: { needLane: 'research', sessionLane: 'research', colleagues: ['deepseek-flash', 'kimi-k3'] } });
    r = applyRosterTurn(r, turn({ planLane: 'quick', ranLane: 'quick', lead: 'q-flash' }));
    expect(r.sessionLane).toBe('checked'); // research → down one, not straight to quick
    expect(r.last).toMatchObject({ planLane: 'quick', ranLane: 'quick', needLane: 'quick', sessionLane: 'checked', lead: 'q-flash' });
    r = applyRosterTurn(r, turn({ planLane: 'quick', ranLane: 'quick', escalationRung: 'verify' }));
    expect(r.sessionLane).toBe('checked');
    expect(r.last.escalation).toBe('verify');
    for (let i = 0; i < 10; i += 1) r = applyRosterTurn(r, turn());
    expect(r.history).toHaveLength(ROSTER_HISTORY_MAX);
    expect(r.turns).toBe(13);
    expect(r.sessionLane).toBe('standard');
  });

  it('a failed call_in records the call but does not raise the session', () => {
    const r = applyRosterTurn(null, turn({ callIn: { role: 'colleague', model: 'kimi-k3', ok: false } }));
    expect(r.sessionLane).toBe('standard');
    expect(r.last.callIn).toEqual({ role: 'colleague', model: 'kimi-k3', ok: false });
  });

  it('round-trips through parse; a malformed row reads as no roster', () => {
    const r = applyRosterTurn(null, turn({ checker: 'cql:deepseek-v4.1-flash', callIn: { role: 'checker', model: 'cql:x', ok: true } }));
    expect(parseSessionRoster(JSON.parse(JSON.stringify(r)))).toEqual(r);
    for (const bad of [null, {}, { v: 2 }, { v: 1, sessionLane: 'quick' }, { v: 1, sessionLane: 'nope', last: r.last }]) expect(parseSessionRoster(bad)).toBeNull();
  });
});

describe('read / write seam (modes, canary, kill switch, fail-open)', () => {
  const stored = (lane: 'checked' | 'research') => applyRosterTurn(null, turn({ planLane: lane, ranLane: lane, lead: 'glm-5.3' }));

  it('SHADOW (default): read, but it does not act for a non-canary sender; a canary user acts', async () => {
    const rows = new Map<string, unknown>([[`${sessionRosterNamespace('c1').join(':')}|${SESSION_ROSTER_KEY}`, stored('research')]]);
    const shadow = await readSessionRosterForTurn('c1', 'u1', memIo({}, rows));
    expect(shadow).toMatchObject({ mode: 'shadow', acts: false });
    expect(shadow.roster?.sessionLane).toBe('research');
    const canary = await readSessionRosterForTurn('c1', 'u1', memIo({ rosterCanaryUserIds: ['u1'] }, rows));
    expect(canary.acts).toBe(true);
    const act = await readSessionRosterForTurn('c1', 'u2', memIo({ sessionRoster: 'act' }, rows));
    expect(act.acts).toBe(true);
  });

  it('OFF / the kill switch / a guest / no chat: nothing is read', async () => {
    const io = memIo({ sessionRoster: 'off' });
    const get = jest.spyOn(io, 'get');
    expect(await readSessionRosterForTurn('c1', 'u1', io)).toBe(ROSTER_OFF);
    expect(await readSessionRosterForTurn('c1', null, memIo({}))).toBe(ROSTER_OFF);
    expect(await readSessionRosterForTurn(null, 'u1', memIo({}))).toBe(ROSTER_OFF);
    process.env.SESSION_ROSTER_DISABLED = '1';
    expect(await readSessionRosterForTurn('c1', 'u1', memIo({ sessionRoster: 'act' }))).toBe(ROSTER_OFF);
    expect(get).not.toHaveBeenCalled();
  });

  it('a store error or a slow read fails open (no roster; the legacy priorLane stands)', async () => {
    const broken: RosterIo = { config: async () => parseRosterConfig({ sessionRoster: 'act' }), get: async () => { throw new Error('db'); }, put: async () => {} };
    expect(await readSessionRosterForTurn('c1', 'u1', broken)).toBe(ROSTER_OFF);
    jest.useFakeTimers();
    try {
      const slow: RosterIo = { config: async () => parseRosterConfig({ sessionRoster: 'act' }), get: () => new Promise(() => {}), put: async () => {} };
      const p = readSessionRosterForTurn('c1', 'u1', slow);
      await jest.advanceTimersByTimeAsync(400);
      await expect(p).resolves.toMatchObject({ mode: 'act', acts: true, roster: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('the guard reads the session lane only when the roster acts', () => {
    const roster = stored('research');
    expect(guardPriorLane({ mode: 'act', acts: true, roster }, 'quick')).toEqual({ lane: 'research', source: 'roster' });
    expect(guardPriorLane({ mode: 'shadow', acts: false, roster }, 'quick')).toEqual({ lane: 'quick', source: 'legacy' });
    expect(guardPriorLane({ mode: 'act', acts: true, roster: null }, 'standard')).toEqual({ lane: 'standard', source: 'legacy' });
    expect(guardPriorLane(null, null)).toEqual({ lane: null, source: 'legacy' });
    expect(rosterActsFor(parseRosterConfig({ sessionRoster: 'off', rosterCanaryUserIds: ['u1'] }), 'u1')).toBe(false);
  });

  it('save = read-modify-write in shadow AND act; off / the kill switch write nothing; a store error never throws', async () => {
    const io = memIo({});
    const a = await saveSessionRosterTurn('c1', turn({ planLane: 'research', ranLane: 'research' }), io);
    expect(a?.prior).toBeNull();
    const b = await saveSessionRosterTurn('c1', turn({ planLane: 'quick', ranLane: 'quick' }), io);
    expect(b?.prior?.sessionLane).toBe('research');
    expect(b?.next.sessionLane).toBe('checked');
    expect(io.puts).toBe(2);
    const off = memIo({ sessionRoster: 'off' });
    expect(await saveSessionRosterTurn('c1', turn(), off)).toBeNull();
    expect(off.puts).toBe(0);
    process.env.SESSION_ROSTER_DISABLED = '1';
    expect(await saveSessionRosterTurn('c1', turn(), io)).toBeNull();
    delete process.env.SESSION_ROSTER_DISABLED;
    const broken: RosterIo = { config: async () => parseRosterConfig({}), get: async () => null, put: async () => { throw new Error('db'); } };
    await expect(saveSessionRosterTurn('c1', turn(), broken)).resolves.toBeNull();
  });

  it('telemetry + the row record: what the guard read, the legacy lane, the session lanes before / after', async () => {
    const io = memIo({ rosterCanaryUserIds: ['u1'] }, new Map([[`c1:roster|session`, stored('research')]]));
    const trace = newRosterTrace();
    trace.read = await readSessionRosterForTurn('c1', 'u1', io);
    const g = guardPriorLane(trace.read, 'quick');
    trace.legacyPriorLane = 'quick'; trace.priorLaneRead = g.lane; trace.source = g.source; trace.sticky = 'kept_seat';
    const saved = await saveSessionRosterTurn('c1', turn({ planLane: 'quick', ranLane: 'quick' }), io);
    expect(sessionRosterMetricMeta('c1', saved!, trace)).toMatchObject({
      chatId: 'c1', planLane: 'quick', ranLane: 'quick', needLane: 'quick', sessionLanePrev: 'research', sessionLane: 'checked', changed: true,
      mode: 'shadow', acts: true, priorLaneRead: 'research', legacyPriorLane: 'quick', rosterPriorLane: 'research', priorLaneSource: 'roster', sticky: 'kept_seat',
    });
    expect(rosterDepthRecord(trace)).toEqual({ mode: 'shadow', acts: true, priorLane: 'research', source: 'roster', sessionLaneBefore: 'research', sticky: 'kept_seat' });
    expect(rosterDepthRecord(newRosterTrace())).toBeNull();
  });
});

describe('applyStickyLead (pure)', () => {
  const ranked = (rows: Array<[string, number, number?]>) => rows.map(([spec, utility, quality]) => ({ spec, utility, quality: quality ?? 4.5, ttftP50Ms: 10_000, n: 10 }));
  const pick = (over: Partial<ModelPick> = {}): ModelPick => ({
    spec: 'deepseek-flash', changed: true, seat: 'cql:seat', reason: 'faster', expectedTtftMs: 9_000, seatUtility: 4.0,
    ranked: ranked([['deepseek-flash', 4.4], ['glm-5.3', 4.3], ['kimi-k3', 4.1], ['cql:seat', 4.0]]), ...over,
  });

  it('keeps the prior lead when it is a valid switch itself and within the margin of the pick', () => {
    const s = applyStickyLead(pick(), 'glm-5.3');
    expect(s.stuck).toBe('kept_prior');
    expect(s.pick).toMatchObject({ spec: 'glm-5.3', changed: true });
    expect(s.pick.reason).toMatch(/session lead glm-5\.3 kept/);
  });

  it('a KIND-keyed pick: the seat is kept within the pick\'s own (wider) margin + the stickiness', () => {
    // margin 0.8 (thin writing buckets) + 0.15 sticky: a +0.85 pick does not move a session that ran on the seat
    const s = applyStickyLead(pick({ ranked: [{ ...ranked([['deepseek-flash', 4.85]])[0], margin: 0.8 }, ...ranked([['cql:seat', 4.0]])] }), 'cql:seat');
    expect(s.stuck).toBe('kept_seat');
    expect(s.pick.reason).toMatch(/within 0\.95/);
  });

  it('keeps the SEAT when the session ran on it and the pick only beats it by less than SWITCH_MARGIN + margin', () => {
    expect(STICKY_LEAD_MARGIN).toBe(SWITCH_MARGIN);
    // 4.25 − 4.0 = 0.25 < SWITCH_MARGIN + margin (0.30) ⇒ the seat the session ran on stays
    const s = applyStickyLead(pick({ ranked: ranked([['deepseek-flash', 4.25], ['cql:seat', 4.0]]) }), 'cql:seat');
    expect(s.stuck).toBe('kept_seat');
    expect(s.pick).toMatchObject({ spec: 'cql:seat', changed: false });
  });

  it('switches anyway when the pick is clearly better than the prior lead', () => {
    expect(applyStickyLead(pick({ ranked: ranked([['deepseek-flash', 4.9], ['glm-5.3', 4.3], ['cql:seat', 4.0]]) }), 'glm-5.3').stuck).toBeNull();
    expect(applyStickyLead(pick({ ranked: ranked([['deepseek-flash', 4.9], ['cql:seat', 4.0]]) }), 'cql:seat').stuck).toBeNull();
  });

  it('frontier hard rule (owner 2026-10-06 late): a persisted FRONTIER lead (a C-1-era pick) is dropped — never kept, even ranked and within the margin; the admin\'s own frontier seat is not a pick and is never dropped', () => {
    const fr = 'cql:api-anthropic-claude-fable-5-1';
    const s = applyStickyLead(pick({ ranked: ranked([['deepseek-flash', 4.4], [fr, 4.35], ['cql:seat', 4.0]]) }), fr, undefined, {});
    expect(s.stuck).toBe('dropped_frontier');
    expect(s.pick).toMatchObject({ spec: 'deepseek-flash', changed: true });
    // the same prior is kept under the env opt-in (the C-1 behaviour)
    expect(applyStickyLead(pick({ ranked: ranked([['deepseek-flash', 4.4], [fr, 4.35], ['cql:seat', 4.0]]) }), fr, undefined, { AUTO_PICK_FRONTIER_ENABLED: '1' }).stuck).toBe('kept_prior');
    // a frontier SEAT the session ran on keeps the seat rule (seats are admin settings)
    const seatPick = pick({ seat: fr, ranked: ranked([['deepseek-flash', 4.25], [fr, 4.0]]) });
    expect(applyStickyLead(seatPick, fr, undefined, {}).stuck).toBe('kept_seat');
  });

  it('never sticks to an unranked prior, a prior that would not beat the seat, a much worse-quality prior, or when the pick stays on the seat', () => {
    expect(applyStickyLead(pick(), 'q-flash').stuck).toBeNull();
    expect(applyStickyLead(pick(), 'kimi-k3').stuck).toBeNull(); // 4.1 − 4.0 < SWITCH_MARGIN
    expect(applyStickyLead(pick({ ranked: ranked([['deepseek-flash', 4.4, 4.8], ['glm-5.3', 4.3, 4.2], ['cql:seat', 4.0]]) }), 'glm-5.3').stuck).toBeNull(); // quality slack
    expect(applyStickyLead(pick({ changed: false, spec: 'cql:seat' }), 'glm-5.3').stuck).toBeNull();
    expect(applyStickyLead(pick(), null).stuck).toBeNull();
    expect(applyStickyLead(pick(), 'deepseek-flash').stuck).toBeNull();
  });
});
