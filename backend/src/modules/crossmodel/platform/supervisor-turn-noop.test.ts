/**
 * supervisor-turn-noop.ts — decision-gate purpose 'supervisor_turn_noop'
 * (agent-decisions program, area supervisor, 2026-09-27; shipped SHADOW).
 *
 *  - the kill switch and mode 'off' never touch the DB, Redis or the seat;
 *  - the request is PURE and memo-stable: ages bucketed, rates quantised, source
 *    ids hashed, the note texts NEVER enter the state, ≤ 4k chars;
 *  - has_new_input is DETERMINISTIC (trigram containment) and a HARD PIN;
 *  - shadow → the stash rides the turn (no outcome row for will_act here; the
 *    probe question is labelled at decision time from the code flag);
 *  - act → a confidently quiet turn is skipped (sweep) / parked (drain) with
 *    the heartbeat floor and the pins (new input, alarm, cap bypass, user rows);
 *  - fixer 2026-09-27: a PINNED turn stamps `pinned:true` + `pins` on its stash
 *    (its outcome row is excludeFromFit); a 'supervised chat' target ships note
 *    kind + age only (no heads); the facts budget is 1.5 s; consulted() gates
 *    the callers' pending-input reads;
 *  - every failure (facts read, timeout, null gate, throw) fails OPEN.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn() },
  loopMetric: { findMany: jest.fn() },
  crossModelMessage: { findMany: jest.fn() },
  eventHook: { findMany: jest.fn() },
  hookEvent: { count: jest.fn(), findMany: jest.fn() },
  ownerQuestion: { count: jest.fn() },
  pendingChatMessage: { count: jest.fn() },
  agentRun: { count: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
const mockRedis = {
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { redisStore.delete(k); return 1; }),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  stashDecision: (d: any, purpose: string, opts?: any) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now', ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
  reconstructDecision: (s: any) => (s && s.id && s.answers ? s : null),
}));

const mockLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockLoopMetric(...a),
  LOOP_METRIC_KINDS: { WAKE_PARKED: 'wake_parked' },
}));

const mockClassify: jest.Mock = jest.fn((c: unknown) => (/no-op/i.test(String(c)) ? 'supervisor_noop' : /ACTIONS TAKEN/.test(String(c)) ? 'supervisor_action' : 'supervisor_note'));
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (...a: any[]) => mockClassify(...(a as [unknown])),
}));

const mockGetSupervisorState: jest.Mock = jest.fn(async (): Promise<any> => ({ directives: [{ status: 'open' }, { status: 'done' }] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  getSupervisorState: (...a: any[]) => mockGetSupervisorState(...a),
}));

const mockIsAlarmEvent: jest.Mock = jest.fn((t: unknown) => String(t) === 'run_failed');
jest.mock('./hooks.service', () => ({
  __esModule: true,
  isAlarmEvent: (...a: any[]) => mockIsAlarmEvent(...a),
}));

import {
  SUPERVISOR_TURN_NOOP_QUESTION,
  SUPERVISOR_TURN_NOOP_PROBE_QUESTION,
  SUPERVISOR_TURN_NOOP_QUESTIONS,
  SUPERVISOR_TURN_NOOP_STATE_MAX_CHARS,
  SUPERVISOR_TURN_NOOP_DEFAULT_HEARTBEAT_TICKS,
  buildSupervisorTurnNoopRequest,
  closeUnstartedTurnNoop,
  computeSupervisorTurnNoopFacts,
  consecutiveTurnNoopSkips,
  hasNewInput,
  hashRef,
  loadSweepPendingInputs,
  pendingInputIsAlarm,
  preTriageSupervisorTurn,
  quantiseRate,
  readTurnNoopPark,
  supervisorTurnNoopActive,
  supervisorTurnNoopConsulted,
  supervisorTurnNoopDeferMin,
  supervisorTurnNoopHeartbeatTicks,
  turnNoopPins,
  turnNoopSkipStatus,
  withSiblingStash,
  wordTrigrams,
  SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS,
  type TurnNoopTargetFacts,
} from './supervisor-turn-noop';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const ENV = ['DECISION_GATE_SUPERVISOR_TURN_NOOP_HEARTBEAT_TICKS', 'DECISION_GATE_SUPERVISOR_TURN_NOOP_DEFER_MIN'];
const saved: Record<string, string | undefined> = {};

const NOTE_A = 'SWEEP: no-op — nothing moved on any project since last sweep';
const NOTE_B = 'ACTIONS TAKEN\n1. nudged lane canlaw-bench about the stalled verify (msg 12ab34cd)';
const NOTE_C = 'Status: the spark cluster lane finished its CPT run 7 of 12 and is waiting on the S3 sync; no action needed from me yet.';

const seedLedger = (over: Partial<Record<string, any>> = {}) => {
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup', userId: 'u1', projectId: 'p1', isSupervisor: false, isProjectSupervisor: true, ...over.chat });
  mockPrisma.crossModelChat.findMany.mockResolvedValue(over.scope ?? [{ id: 'lane-a' }, { id: 'lane-b' }]);
  mockPrisma.loopMetric.findMany.mockResolvedValue(over.metrics ?? [
    { kind: 'supervisor_noop', createdAt: min(60) },
    { kind: 'supervisor_noop', createdAt: min(120) },
    { kind: 'supervisor_action', createdAt: min(180) },
    { kind: 'supervisor_note', createdAt: min(240) },
    { kind: 'supervisor_noop', createdAt: min(300) },
  ]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue(over.notes ?? [
    { content: NOTE_A, createdAt: min(60) },
    { content: NOTE_B, createdAt: min(180) },
    { content: NOTE_C, createdAt: min(240) },
  ]);
  mockPrisma.eventHook.findMany.mockResolvedValue(over.hooks ?? [{ id: 'hook-1' }]);
  mockPrisma.hookEvent.count.mockResolvedValue(over.pendingHooks ?? 2);
  mockPrisma.hookEvent.findMany.mockResolvedValue(over.pendingRows ?? []);
  mockPrisma.ownerQuestion.count.mockResolvedValue(over.asks ?? 1);
  mockPrisma.pendingChatMessage.count.mockResolvedValue(over.userRows ?? 0);
  mockPrisma.agentRun.count.mockResolvedValue(over.running ?? 1);
};

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
  seedLedger();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const gate = (willAct: number, mode: 'shadow' | 'act' = 'shadow', hasNew?: number) => ({
  id: 'd1', backend: 'TypeSafe Jev', ms: 120, mode,
  answers: { [SUPERVISOR_TURN_NOOP_QUESTION]: { type: 'noul', noul: willAct }, ...(hasNew !== undefined ? { [SUPERVISOR_TURN_NOOP_PROBE_QUESTION]: { type: 'noul', noul: hasNew } } : {}) },
});

const facts = (over: Partial<TurnNoopTargetFacts> = {}): TurnNoopTargetFacts => ({
  target: 'project supervisor chat', projectId: 'p1', notes7d: 5, noopRate7d: 0.6, actionRate7d: 0.2, consecutiveNoops: 2, lastActionAgoMin: 180,
  lastNotes: [{ kind: 'supervisor_noop', head: NOTE_A, ageMin: 60 }, { kind: 'supervisor_action', head: NOTE_B.slice(0, 160), ageMin: 180 }],
  noteTexts: [NOTE_A, NOTE_B, NOTE_C, 'private full note body ZZZ-NOTE-TEXT-ONLY that must never reach the state'],
  board: { openDirectives: 1, lanesRunning: 1, pendingHookEvents: 2, openOwnerAsks: 1, userRowsWaiting: 0 },
  ...over,
});

describe('pure pieces', () => {
  it('the act question is a criteria-bearing noul under will_act; the probe is a second noul', () => {
    expect(SUPERVISOR_TURN_NOOP_QUESTION).toBe('will_act');
    expect(SUPERVISOR_TURN_NOOP_PROBE_QUESTION).toBe('has_new_input');
    for (const k of [SUPERVISOR_TURN_NOOP_QUESTION, SUPERVISOR_TURN_NOOP_PROBE_QUESTION]) {
      const q = SUPERVISOR_TURN_NOOP_QUESTIONS[k] as any;
      expect(q.type).toBe('noul');
      expect(q.criteria.true).toBeTruthy();
      expect(q.criteria.false).toBeTruthy();
    }
  });

  it('consecutiveTurnNoopSkips / turnNoopSkipStatus round-trip; other statuses read 0', () => {
    expect(consecutiveTurnNoopSkips(undefined)).toBe(0);
    expect(consecutiveTurnNoopSkips('started')).toBe(0);
    expect(consecutiveTurnNoopSkips('skipped:sweep_quiet:2')).toBe(0);
    expect(consecutiveTurnNoopSkips('skipped:turn_noop')).toBe(1);
    expect(consecutiveTurnNoopSkips('skipped:turn_noop:3')).toBe(3);
    expect(consecutiveTurnNoopSkips('skipped:turn_noop:x')).toBe(1);
    expect(turnNoopSkipStatus(2)).toBe('skipped:turn_noop:2');
    expect(consecutiveTurnNoopSkips(turnNoopSkipStatus(0))).toBe(1);
  });

  it('env knobs: heartbeat ticks clamped 2..24, defer clamped 5..60; active only when the mode is act', () => {
    mockMode.mockReturnValue('act');
    expect(supervisorTurnNoopActive()).toBe(true);
    mockMode.mockReturnValue('shadow');
    expect(supervisorTurnNoopActive()).toBe(false);
    mockMode.mockImplementation(() => { throw new Error('partial mock'); });
    expect(supervisorTurnNoopActive()).toBe(false);
    expect(supervisorTurnNoopConsulted()).toBe(false); // a partial mock reads as "not consulted"
    // consulted() (fixer 2026-09-27): the callers gate their pending-input reads on it — off ⇒ no query.
    mockMode.mockReturnValue('off');
    expect(supervisorTurnNoopConsulted()).toBe(false);
    mockMode.mockReturnValue('shadow');
    expect(supervisorTurnNoopConsulted()).toBe(true);
    // The facts budget sits inside the sibling triage's (concurrent asks — no serial latency added).
    expect(SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS).toBe(1500);
    expect(supervisorTurnNoopHeartbeatTicks()).toBe(SUPERVISOR_TURN_NOOP_DEFAULT_HEARTBEAT_TICKS);
    process.env.DECISION_GATE_SUPERVISOR_TURN_NOOP_HEARTBEAT_TICKS = '99';
    expect(supervisorTurnNoopHeartbeatTicks()).toBe(24);
    process.env.DECISION_GATE_SUPERVISOR_TURN_NOOP_HEARTBEAT_TICKS = '1';
    expect(supervisorTurnNoopHeartbeatTicks()).toBe(2);
    expect(supervisorTurnNoopDeferMin()).toBe(15);
    process.env.DECISION_GATE_SUPERVISOR_TURN_NOOP_DEFER_MIN = '2';
    expect(supervisorTurnNoopDeferMin()).toBe(5);
    process.env.DECISION_GATE_SUPERVISOR_TURN_NOOP_DEFER_MIN = '600';
    expect(supervisorTurnNoopDeferMin()).toBe(60);
  });

  it('hasNewInput is deterministic trigram containment: restated facts are not new; a new fact is; no notes ⇒ new; no inputs ⇒ not new', () => {
    expect(wordTrigrams('a b c d').size).toBe(2);
    expect(wordTrigrams('').size).toBe(0);
    expect(hasNewInput([], [NOTE_A])).toBe(false);
    expect(hasNewInput(['lane finished its run'], [])).toBe(true);
    // A restatement of a recent note (same words, same order) is contained.
    expect(hasNewInput(['the spark cluster lane finished its CPT run 7 of 12 and is waiting on the S3 sync'], [NOTE_A, NOTE_B, NOTE_C])).toBe(false);
    // A genuinely new fact (a failure the notes never mention) is new.
    expect(hasNewInput(['Run 8 of 12 FAILED with exit code 137 on the verify stage — OOM in the dev container'], [NOTE_A, NOTE_B, NOTE_C])).toBe(true);
    // Mixed batch: any new row makes the batch new.
    expect(hasNewInput([NOTE_C, 'Run 8 FAILED: OOM in the verify stage'], [NOTE_A, NOTE_B, NOTE_C])).toBe(true);
  });

  it('hashRef hashes source ids (never raw); quantiseRate buckets to tenths', () => {
    expect(hashRef('chat-1234-5678')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRef('chat-1234-5678')).not.toContain('chat');
    expect(hashRef('')).toBeUndefined();
    expect(quantiseRate(null)).toBeNull();
    expect(quantiseRate(0.66)).toBe('0.7');
    expect(quantiseRate(1.4)).toBe('1.0');
  });

  it('turnNoopPins names every hard pin the act rule honours (fixer 2026-09-27)', () => {
    expect(turnNoopPins({ newInput: false, alarm: false, capBypassed: false, userRowsWaiting: 0 })).toEqual([]);
    expect(turnNoopPins({ newInput: true, alarm: true, capBypassed: true, userRowsWaiting: 2 })).toEqual(['new_input', 'alarm', 'cap_bypass', 'user_rows']);
    expect(turnNoopPins({ newInput: false, alarm: false, capBypassed: false, userRowsWaiting: 1 })).toEqual(['user_rows']);
  });

  it('withSiblingStash attaches the sibling to the rider (or makes it the rider)', () => {
    const a: any = { id: 'a', purpose: 'sweep_triage', mode: 'shadow', backend: 'x', answers: {}, decidedAt: 'now' };
    const b: any = { id: 'b', purpose: 'supervisor_turn_noop', mode: 'shadow', backend: 'x', answers: {}, decidedAt: 'now' };
    expect(withSiblingStash(a, null)).toBe(a);
    expect(withSiblingStash(null, b)).toBe(b);
    expect(withSiblingStash(a, b)).toEqual({ ...a, also: [b] });
  });
});

describe('buildSupervisorTurnNoopRequest (pure, memo-stable, redacted)', () => {
  const pending = [
    { id: 'e1', eventType: 'run_completed', sourceChatId: 'chat-source-1', text: 'Run 8 of 12 FAILED with exit code 137 on the verify stage', depth: 1, createdAt: min(7) },
    { id: 'e2', eventType: 'run_completed', sourceChatId: 'chat-source-2', text: NOTE_C, depth: 1, createdAt: min(12) },
  ];

  it('facts first, prose last; the note TEXTS never enter the state; source ids are hashed; the deterministic flag is visible', () => {
    const r = buildSupervisorTurnNoopRequest({ origin: 'sweep', facts: facts(), pending, now: NOW.getTime() });
    const text = JSON.stringify(r.state);
    expect(text.length).toBeLessThanOrEqual(SUPERVISOR_TURN_NOOP_STATE_MAX_CHARS);
    expect(Object.keys(r.state).slice(0, 3)).toEqual(['origin', 'target', 'target_notes_7d']);
    expect(Object.keys(r.state).slice(-1)).toEqual(['pending']);
    expect(r.state.target_noop_rate_7d).toBe(0.6);
    expect(r.state.pending_input_is_new_vs_last_notes).toBe(true);
    expect(r.flags.has_new_input).toBe(true);
    expect(text).not.toContain('chat-source-1');
    expect(text).not.toContain('ZZZ-NOTE-TEXT-ONLY'); // the full note texts (facts.noteTexts) never ride; only the ≤160-char heads do
    expect((r.state.pending as any[])[0].from).toMatch(/^[0-9a-f]{8}$/);
    expect(r.questions).toBe(SUPERVISOR_TURN_NOOP_QUESTIONS);
  });

  it('memoState buckets ages and quantises rates so a re-ask a minute later hits the memo; a new input id or an alarm row breaks memoability', () => {
    const a = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: facts(), pending, now: NOW.getTime() });
    const b = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: facts({ lastActionAgoMin: 183 }), pending, now: NOW.getTime() + 90_000 });
    expect(a.memoable).toBe(true);
    expect(a.memoState).toEqual(b.memoState);
    expect(a.state).not.toEqual(b.state); // exact state still carries whole minutes
    expect((a.memoState as any).input_ids).toEqual(['e1', 'e2']);
    expect((a.memoState as any).noop_rate_7d).toBe('0.6');
    const grown = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: facts(), pending: [...pending, { ...pending[0], id: 'e3' }], now: NOW.getTime() });
    expect(grown.memoState).not.toEqual(a.memoState);
    const alarm = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: facts(), pending: [{ ...pending[0], alarm: true }], now: NOW.getTime() });
    expect(alarm.memoable).toBe(false);
    expect(alarm.memoState).toBeNull();
    expect(alarm.flags.any_alarm).toBe(true);
    const noId = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: facts(), pending: [{ ...pending[0], id: undefined }], now: NOW.getTime() });
    expect(noId.memoable).toBe(false);
    const empty = buildSupervisorTurnNoopRequest({ origin: 'sweep', facts: facts(), pending: [], now: NOW.getTime() });
    expect(empty.memoable).toBe(true);
    expect(empty.flags.has_new_input).toBe(false);
  });

  it('a pathological batch is capped: ≤ 8 rows shown, heads trimmed until the state fits 4k', () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, eventType: 'run_completed', text: `row ${i} ` + 'lorem ipsum dolor sit amet '.repeat(60), createdAt: min(i) }));
    const r = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: facts(), pending: big, now: NOW.getTime() });
    expect(JSON.stringify(r.state).length).toBeLessThanOrEqual(SUPERVISOR_TURN_NOOP_STATE_MAX_CHARS);
    expect(r.state.pending_inputs).toBe(40);
    expect((r.state.pending as any[]).length).toBeLessThanOrEqual(8);
  });
});

describe('computeSupervisorTurnNoopFacts (bounded ledger reads)', () => {
  it('derives the AACT features, the last notes (classified, head only) and the board counts', async () => {
    const f = await computeSupervisorTurnNoopFacts('sup', NOW);
    expect(f).not.toBeNull();
    expect(f!.target).toBe('project supervisor chat');
    expect(f!.notes7d).toBe(5);
    expect(f!.noopRate7d).toBeCloseTo(0.6);
    expect(f!.actionRate7d).toBeCloseTo(0.2);
    expect(f!.consecutiveNoops).toBe(2);
    expect(f!.lastActionAgoMin).toBe(180);
    expect(f!.lastNotes.map((n) => n.kind)).toEqual(['supervisor_noop', 'supervisor_action', 'supervisor_note']);
    expect(f!.lastNotes[1].head!.length).toBeLessThanOrEqual(160);
    expect(f!.noteTexts).toHaveLength(3);
    expect(f!.board).toEqual({ openDirectives: 1, lanesRunning: 1, pendingHookEvents: 2, openOwnerAsks: 1, userRowsWaiting: 0 });
    // Bounded reads: metric rows capped, notes capped at 3, scope capped.
    expect(mockPrisma.loopMetric.findMany.mock.calls[0][0].take).toBe(400);
    expect(mockPrisma.crossModelMessage.findMany.mock.calls[0][0].take).toBe(3);
  });

  // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): a note stamped with the
  // harness count (metadata.harnessActions) is classified from the harness record, not the markers.
  it('prefers the harness count over the marker regex (a report-up reads as a plain note); the kill switch restores the regex', async () => {
    seedLedger({ notes: [
      { content: 'WAKE: no-op — nothing moved', createdAt: min(60), metadata: { harnessActions: 2, harnessReceipts: { mode: 'actions' } } },
      { content: 'ACTIONS TAKEN\n- typed by the model', createdAt: min(120), metadata: { harnessActions: 0, harnessReceipts: { mode: 'noop' } } },
      { content: 'Goal moved.', createdAt: min(180), metadata: { harnessActions: 0, harnessReceipts: { mode: 'reported', reportUps: 1 } } },
    ] });
    const f = await computeSupervisorTurnNoopFacts('sup', NOW);
    expect(f!.lastNotes.map((n) => n.kind)).toEqual(['supervisor_action', 'supervisor_noop', 'supervisor_note']);
    expect(mockPrisma.crossModelMessage.findMany.mock.calls[0][0].select).toEqual({ content: true, createdAt: true, metadata: true });
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    try {
      mockPrisma.crossModelMessage.findMany.mockClear();
      const g = await computeSupervisorTurnNoopFacts('sup', NOW);
      expect(g!.lastNotes.map((n) => n.kind)[0]).not.toBe('supervisor_action');
      expect(mockPrisma.crossModelMessage.findMany.mock.calls[0][0].select).toEqual({ content: true, createdAt: true });
    } finally {
      delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    }
  });

  it('a missing chat yields null; an empty window yields null rates and a 0 streak; a plain chat skips the directives read', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect(await computeSupervisorTurnNoopFacts('nope', NOW)).toBeNull();
    seedLedger({ chat: { isSupervisor: false, isProjectSupervisor: false }, metrics: [] });
    const f = await computeSupervisorTurnNoopFacts('sup', NOW);
    expect(f!.target).toBe('supervised chat');
    expect(f!.noopRate7d).toBeNull();
    expect(f!.consecutiveNoops).toBe(0);
    expect(f!.board.openDirectives).toBeNull();
    expect(mockGetSupervisorState).not.toHaveBeenCalled();
  });

  it("a 'supervised chat' target (possibly a human's own conversation) ships note kind + age only — no heads in the facts, the state or the memo; the full texts still feed the new-input pin server-side (fixer 2026-09-27)", async () => {
    seedLedger({ chat: { isSupervisor: false, isProjectSupervisor: false } });
    const f = await computeSupervisorTurnNoopFacts('sup', NOW);
    expect(f!.target).toBe('supervised chat');
    expect(f!.lastNotes).toHaveLength(3);
    expect(f!.lastNotes.every((n) => n.head === undefined)).toBe(true);
    expect(f!.lastNotes.map((n) => n.kind)).toEqual(['supervisor_noop', 'supervisor_action', 'supervisor_note']);
    expect(f!.noteTexts).toHaveLength(3); // server-side only — the pin still sees them
    expect(f!.noteTexts[0]).toBe(NOTE_A);
    expect(hasNewInput([NOTE_C], f!.noteTexts)).toBe(false); // a restated note is still "contained" without any head shipped
    const r = buildSupervisorTurnNoopRequest({ origin: 'drain', facts: f!, pending: [{ id: 'm1', eventType: 'agent_message', text: 'ack', createdAt: min(1) }], now: NOW.getTime() });
    const text = JSON.stringify(r.state) + JSON.stringify(r.memoState);
    for (const t of [NOTE_A, NOTE_B, NOTE_C]) expect(text).not.toContain(t.slice(0, 24));
    expect((r.state.last_notes as any[])[0]).toEqual({ kind: 'supervisor_noop', minutes_ago: 60 });
    expect((r.memoState as any).last_notes[0]).toEqual({ kind: 'supervisor_noop', age: expect.any(String) });
    // A supervisor-class target still carries the ≤160-char heads.
    seedLedger();
    const sup = await computeSupervisorTurnNoopFacts('sup', NOW);
    expect(sup!.lastNotes[0].head).toBe(NOTE_A);
  });

  it('loadSweepPendingInputs reads the pending hook events oldest-first (≤ 8) with the alarm predicate; fails open to []', async () => {
    mockPrisma.hookEvent.findMany.mockResolvedValue([
      { id: 'h1', eventType: 'run_completed', payload: { summary: 'done', sourceChatId: 'c1', depth: 1 }, createdAt: min(3) },
      { id: 'h2', eventType: 'run_failed', payload: { summary: 'boom', sourceChatId: 'c2' }, createdAt: min(2) },
    ]);
    const rows = await loadSweepPendingInputs('sup');
    expect(rows.map((r) => [r.id, r.alarm])).toEqual([['h1', false], ['h2', true]]);
    expect(mockPrisma.hookEvent.findMany.mock.calls[0][0].take).toBe(8);
    mockPrisma.eventHook.findMany.mockRejectedValue(new Error('db down'));
    expect(await loadSweepPendingInputs('sup')).toEqual([]);
  });

  it('pendingInputIsAlarm: text markers pin; hooks.service predicate when loadable', async () => {
    expect(await pendingInputIsAlarm('run_completed', null, 'x [INFRA ALERT — box A disk] y')).toBe(true);
    expect(await pendingInputIsAlarm('run_failed', null, 'plain')).toBe(true);
    expect(await pendingInputIsAlarm('run_completed', null, 'plain')).toBe(false);
  });
});

describe('preTriageSupervisorTurn (the consumer)', () => {
  it('mode off: no DB, no Redis, no seat', async () => {
    mockMode.mockReturnValue('off');
    const r2 = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending: [] });
    expect(r2.decision).toBeNull();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('shadow: the stash rides the turn with { origin, control:false }; the probe is labelled from the code flag; no will_act outcome row here', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gate(0.05, 'shadow', 0.9));
    const r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], now: NOW });
    expect(r.skip).toBeNull();
    expect(r.control).toBe(false);
    expect(r.hasNewInput).toBe(false);
    expect(r.pins).toEqual([]);
    expect(r.stash).toMatchObject({ purpose: 'supervisor_turn_noop', extra: { origin: 'sweep', control: false, newInput: false } });
    expect((r.stash as any).extra.pinned).toBeUndefined(); // an unpinned turn's row enters the fit
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'supervisor_turn_noop', sessionId: 'sup' });
    expect(mockDecide.mock.calls[0][2].memoState).toBeDefined();
    const rows = mockRecord.mock.calls.map((c) => c[2]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question: 'has_new_input', actual: false, acted: false });
  });

  it('act + confidently quiet + no pins ⇒ sweep skip (acted outcome, wake_parked reason turn_noop, consecutive from lastStatus)', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gate(0.05, 'act'));
    const r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], consecutiveSkips: 0, now: NOW });
    expect(r.skip).toEqual({ p: 0.05, consecutive: 1 });
    expect(r.stash).toBeNull();
    const willAct = mockRecord.mock.calls.map((c) => c[2]).find((o) => o.question === 'will_act');
    expect(willAct).toMatchObject({ actual: null, acted: true, extra: { origin: 'sweep', consecutive: 1 } });
    expect(mockLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_parked', sessionId: 'sup', meta: expect.objectContaining({ reason: 'turn_noop', origin: 'sweep', consecutive: 1 }) }));
  });

  it('the heartbeat floor forces the turn after ticks−1 skips and marks its stash as the CONTROL row', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gate(0.05, 'act'));
    const r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], consecutiveSkips: SUPERVISOR_TURN_NOOP_DEFAULT_HEARTBEAT_TICKS - 1, now: NOW });
    expect(r.skip).toBeNull();
    expect(r.control).toBe(true);
    expect(r.stash).toMatchObject({ extra: { origin: 'sweep', control: true, floor: true, consecutive: 2 } });
    expect(mockLoopMetric).not.toHaveBeenCalled();
  });

  it('hard pins: new input, an alarm row, a cap bypass, a waiting user row — never skipped even when the gate is confident and in act', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gate(0.02, 'act'));
    const newInput = [{ id: 'e1', eventType: 'run_completed', text: 'Run 8 of 12 FAILED with exit code 137 on the verify stage', createdAt: min(1) }];
    let r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: newInput, now: NOW });
    expect(r.skip).toBeNull(); expect(r.hasNewInput).toBe(true); expect(r.stash).toBeTruthy();
    // fixer 2026-09-27: the pin rides the stash extra so the finalize label is excludeFromFit — the band
    // (shadow AND act) holds only turns the rule could have skipped.
    expect(r.pins).toEqual(['new_input']);
    expect(r.stash).toMatchObject({ extra: { pinned: true, pins: 'new_input', control: false } });
    r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [{ id: 'e1', eventType: 'run_failed', text: NOTE_C, alarm: true, createdAt: min(1) }], now: NOW });
    expect(r.skip).toBeNull();
    expect(r.pins).toEqual(['alarm']);
    r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], capBypassed: true, now: NOW });
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ extra: { pinned: true, pins: 'cap_bypass' } });
    seedLedger({ userRows: 1 });
    r = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending: [], now: NOW });
    expect(r.skip).toBeNull();
    expect(r.pins).toEqual(['user_rows']);
    expect(mockLoopMetric).not.toHaveBeenCalled();
  });

  it('an act-mode answer that is NOT quiet, or a decision the runtime downgraded to shadow, never skips', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gate(0.4, 'act'));
    expect((await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], now: NOW })).skip).toBeNull();
    mockDecide.mockResolvedValue(gate(0.05, 'shadow'));
    expect((await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], now: NOW })).skip).toBeNull();
  });

  it('drain origin: act skip writes the park marker with its skip ledger; a still-held park returns parked without a decision; a lapsed park re-asks with the ledger and the floor fires + clears the marker', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gate(0.05, 'act'));
    const pending = [{ id: 'm1', eventType: 'agent_message', text: NOTE_C, createdAt: min(1) }];
    const r = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending, now: NOW });
    expect(r.skip).toMatchObject({ p: 0.05, consecutive: 1 });
    expect(r.skip!.until).toBe(NOW.getTime() + 15 * 60_000);
    const marker = await readTurnNoopPark('sup');
    expect(marker).toMatchObject({ rowIds: ['m1'], skips: 1, p: 0.05 });
    expect(mockLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'turn_noop', origin: 'drain', deferMs: 15 * 60_000 }) }));
    // Still parked: no new decision.
    mockDecide.mockClear();
    const held = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending, now: new Date(NOW.getTime() + 60_000) });
    expect(held.parked).toMatchObject({ until: NOW.getTime() + 15 * 60_000 });
    expect(mockDecide).not.toHaveBeenCalled();
    // Lapsed: re-ask with skips=1 → second skip.
    const later = new Date(NOW.getTime() + 16 * 60_000);
    const r2 = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending, now: later });
    expect(r2.skip).toMatchObject({ consecutive: 2 });
    // Lapsed again: floor (ticks 3 ⇒ 2 skips max) → the turn runs as the control, marker cleared.
    const later2 = new Date(later.getTime() + 16 * 60_000);
    const r3 = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending, now: later2 });
    expect(r3.skip).toBeNull();
    expect(r3.control).toBe(true);
    expect(await readTurnNoopPark('sup')).toBeNull();
  });

  it('drain origin: a marker write failure delivers (fail open) with the stash riding', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gate(0.05, 'act'));
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    const r = await preTriageSupervisorTurn({ origin: 'drain', chatId: 'sup', pending: [{ id: 'm1', eventType: 'agent_message', text: NOTE_C, createdAt: min(1) }], now: NOW });
    expect(r.skip).toBeNull();
    expect(r.stash).toBeTruthy();
    // fixer 2026-09-27: the fail-open delivery is identifiable on its row (it is an in-band label that is not a floor turn).
    expect(r.stash).toMatchObject({ extra: { parkWriteFailed: true, control: false } });
  });

  it('fails OPEN: facts read throws / times out, gate answers null, gate throws, a missing chat', async () => {
    mockMode.mockReturnValue('act');
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db'));
    expect(await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [] })).toMatchObject({ decision: null, skip: null, stash: null });
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce(null);
    expect((await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [] })).decision).toBeNull();
    mockDecide.mockResolvedValueOnce(null);
    const r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], now: NOW });
    expect(r.decision).toBeNull(); expect(r.hasNewInput).toBe(false);
    mockDecide.mockRejectedValueOnce(new Error('seat down'));
    expect((await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [], now: NOW })).decision).toBeNull();
    expect(mockLoopMetric).not.toHaveBeenCalled();
  });

  it('closeUnstartedTurnNoop records one unlabelled row carrying the stash extra; ignores other purposes', () => {
    closeUnstartedTurnNoop({ id: 'd9', purpose: 'supervisor_turn_noop', mode: 'shadow', backend: 'x', answers: { will_act: { type: 'noul', noul: 0.2 } }, decidedAt: 'now', extra: { origin: 'sweep' } } as any, 'sup', 'busy');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'will_act', actual: null, acted: false, note: 'not started: busy', extra: { origin: 'sweep' } });
    expect(mockRecord.mock.calls[0][2].excludeFromFit).toBeUndefined();
    mockRecord.mockClear();
    // A pinned stash closes excludeFromFit (fixer 2026-09-27) — the pairing row never enters the fit either.
    closeUnstartedTurnNoop({ id: 'd10', purpose: 'supervisor_turn_noop', mode: 'shadow', backend: 'x', answers: { will_act: { type: 'noul', noul: 0.2 } }, decidedAt: 'now', extra: { origin: 'sweep', pinned: true, pins: 'alarm' } } as any, 'sup', 'sweep_triage skip');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ note: 'not started: sweep_triage skip', excludeFromFit: true, extra: { pinned: true } });
    mockRecord.mockClear();
    closeUnstartedTurnNoop({ id: 'd8', purpose: 'sweep_triage', mode: 'shadow', backend: 'x', answers: {}, decidedAt: 'now' } as any, 'sup', 'busy');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
