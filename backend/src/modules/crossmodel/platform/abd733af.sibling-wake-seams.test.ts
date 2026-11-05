/**
 * Replay for ticket abd733af — "6d19f11f sibling seams: follow-through/
 * adoption-ladder/premise-register wake() calls ignore {ok:false}; card-digest
 * + log-signal retry gates; enqueue_failed row backoff".
 *
 * THE DEFECT CLASS (parent: 6d19f11f, PR #1698): enqueueDirectWake NEVER
 * throws on failure — it returns { ok: false, error } (hooks.service
 * enqueueDirectWake: target chat missing, outbox write failed, queue capped).
 * Every caller that `await`s it without reading the return counts a FAILED
 * wake as delivered and then sets its Redis dedupe key — the wake is silenced
 * for the whole window without ever landing. PR #1698 fixed infra-watch
 * deliver() only; these are the sibling seams its review surfaced:
 *
 *  (1a) follow-through.service.ts — three sites: the owner-ask NUDGE
 *       (ASK_NUDGE_KEY, 24 h), the owner-ask ESCALATION to the Fleet
 *       Supervisor (ASK_ESCALATE_KEY, 24 h) and the diagnosis-nudge
 *       (NUDGE_KEY, 24 h).
 *  (1b) adoption-ladder.ts — the no-adoption wake set BOTH the 24 h
 *       NOADOPT_KEY and the 7-day NOADOPT_SEEN_KEY, so a failed enqueue also
 *       consumed the new-evidence comparator: no later pass retried, even on
 *       genuinely new counts.
 *  (1c) premise-register.ts — the drift wake (DRIFT_KEY, 24 h) and the
 *       cross-project conflict wake (CONFLICT_KEY, 7 d).
 *  (2a) infra-watch card-cost digest set its own 26 h CARD_DIGEST_KEY BEFORE
 *       deliver(), so a failed card wake was never retried that day.
 *  (3)  deliver() wrote one enqueue_failed loop_metrics row + one warn per
 *       target PER SWEEP for a permanently failing target (~96/day) — now
 *       dampened by a 1 h per-target backoff key (the first failure per hour
 *       is still the evidence row).
 *
 * THE FIX SHAPE (same as 6d19f11f): a not-ok return is NOT delivered — no
 * dedupe key is set (the next sweep retries the still-true condition), and a
 * failure row with meta.outcome='enqueue_failed' records it.
 *
 * Mock discipline mirrors adoption-ladder.test.ts / premise-register.test.ts
 * / follow-through.02c0bc79.test.ts (redis Map store, jest.mock'd prisma /
 * logger / loop-metrics).
 */

// ── shared mocks ─────────────────────────────────────────────────────────────

const mkStore = () => new Map<string, string>();
const mkRedis = (store: Map<string, string>): any => ({
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string, opts?: any) => {
    if (opts?.NX && store.has(k)) return null;
    store.set(k, v);
    if (opts?.EX) void 0; // TTL is a production concern; the Map is unbounded
    return 'OK';
  }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
});
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
/** premise-register's fetch seam shape (mirrors premise-register.test.ts okResponse). */
const okResponse = (body: string, contentType = 'application/json', status = 200) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  body: null,
  text: async () => body,
}) as any;

// ── 1b. adoption-ladder ──────────────────────────────────────────────────────

const alStore = mkStore();
const alRedis = mkRedis(alStore);
const alPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  projectGoal: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
  projectTodo: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  agentRun: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  chatSchedule: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
};
const alMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: alPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: alRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: loggerMock }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => alMetric(...a),
}));
jest.mock('./supervisor-switch', () => ({
  __esModule: true,
  getProjectSupervisorsEnabled: jest.fn(async () => true),
  getFleetSupervisorEnabled: jest.fn(async () => true),
  recordSupervisorSwitchSkip: jest.fn(),
}));
// premise-register's SSRF guard resolves the source host — bench.example must
// read public (mirrors premise-register.test.ts).
jest.mock('dns', () => ({ promises: { lookup: jest.fn(async (host: string) => (host === 'private.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }])) } }));

import { sweepAdoptionLadder, ADOPTION_LADDER_DEDUPE_SEC, ADOPTION_LADDER_SEEN_SEC } from './adoption-ladder';

// ── 1c. premise-register ─────────────────────────────────────────────────────

import { runPremiseCheckOnce, PREMISE_DRIFT_DEDUPE_SEC, PREMISE_CONFLICT_DEDUPE_SEC } from './premise-register';

// ── 1a. follow-through ───────────────────────────────────────────────────────

import { sweepFollowThrough, OWNER_ASK_DEDUPE_SEC } from '../fleet/follow-through.service';

// ── 2a + 3. infra-watch ──────────────────────────────────────────────────────

import { deliver, ENQUEUE_FAIL_ROW_DEDUPE_SEC } from '../fleet/infra-watch.service';

// ── shared fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2026-10-18T04:05:00Z');
const SUP = '810c924d-0000-4000-8000-000000000000';
const GOAL = '226be7b7-0000-4000-8000-000000000000';
const LANE = 'ddd26be0-0000-4000-8000-000000000000';
const PID = 'p-ttrd';
const RID = 'f5b42fe6-1111-4000-8000-000000000000';
const KPI = {
  key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: RID, setAt: '2026-09-27T13:22:15Z',
  history: [{ value: 5.08, setAt: '2026-09-21T08:42:00Z', receiptId: '22222222-2222-4000-8000-000000000000' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  alStore.clear();
});

// ═══ 1b. adoption-ladder: failed no-adoption wake sets NEITHER key ═══════════

describe('abd733af — adoption-ladder no-adoption wake reads the { ok: false } return', () => {
  const goalRow = { id: GOAL, projectId: PID, title: 'Serve Qwen3.8 on node-a', status: 'active', premises: [KPI] };
  const wire = () => {
    alPrisma.projectGoal.findMany.mockResolvedValue([goalRow, { id: 'g-nokpi', projectId: PID, title: 'no kpi', status: 'active', premises: [] }]);
    alPrisma.projectTodo.findMany.mockResolvedValue([{ goalId: GOAL, assigneeChatId: LANE }]);
    alPrisma.agentRun.findMany.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({ sessionId: LANE, finishedAt: new Date(Date.UTC(2026, 8, 26, i, 0, 0)) })));
    alPrisma.crossModelChat.findMany.mockResolvedValue([{ id: SUP, projectId: PID }]);
    alPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PID, name: 'tt-rd', projectSupervisorEnabled: true, archivedAt: null }]);
  };

  it('REPLAY: a { ok: false } wake is NOT delivered — no NOADOPT_KEY, no NOADOPT_SEEN_KEY, a failure row, and the SAME evidence still wakes on the next sweep', async () => {
    wire();
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    const out = await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: failing });
    expect(out).toEqual({ projects: 1, tripped: 1, wakes: 0, unchanged: 0 });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(alStore.has(`adoption:noadopt:${GOAL}`)).toBe(false);
    expect(alStore.has(`adoption:noadopt:seen:${GOAL}`)).toBe(false);
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'adoption_ladder', sessionId: SUP,
      meta: expect.objectContaining({ goalId: GOAL, woken: false, outcome: 'enqueue_failed', error: 'target chat not found' }),
    }));
    // next sweep, wake healthy: the SAME ladder state (no new evidence was
    // consumed) still fires — the pre-fix code would have been deduped by the
    // seen key and stayed silent for 7 days.
    const healthy = jest.fn(async (_o: any) => ({ ok: true, hookEventId: 'he-1' }));
    const again = await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: healthy });
    expect(again).toEqual({ projects: 1, tripped: 1, wakes: 1, unchanged: 0 });
    expect(alStore.has(`adoption:noadopt:${GOAL}`)).toBe(true);
    expect(alStore.has(`adoption:noadopt:seen:${GOAL}`)).toBe(true);
    // TTL pins: the healthy retry stamps BOTH keys — the 24h dedupe and the
    // 7-day new-evidence comparator it must never have consumed on failure.
    expect(alRedis.set).toHaveBeenCalledWith(`adoption:noadopt:${GOAL}`, expect.any(String), { EX: ADOPTION_LADDER_DEDUPE_SEC });
    expect(alRedis.set).toHaveBeenCalledWith(`adoption:noadopt:seen:${GOAL}`, expect.any(String), { EX: ADOPTION_LADDER_SEEN_SEC });
  });

  it('a legacy seam with NO return value (undefined) still counts as delivered — no false-negative on the old contract', async () => {
    wire();
    const legacy = jest.fn(async () => undefined);
    const out = await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: legacy });
    expect(out).toEqual({ projects: 1, tripped: 1, wakes: 1, unchanged: 0 });
    expect(alStore.has(`adoption:noadopt:${GOAL}`)).toBe(true);
  });
});

// ═══ 1c. premise-register: drift + conflict wakes read the return ════════════

describe('abd733af — premise-register drift/conflict wakes read the { ok: false } return', () => {
  const goalRow = (id: string, projectId: string, name: string, premises: any[], userId = 'u1') => ({
    id, projectId, userId, title: `${name} goal`, status: 'active', premises,
    project: { id: projectId, name }, updatedAt: NOW,
  });

  it('REPLAY (drift): a failed drift wake sets NO drift key — the still-drifted premise wakes again on the next sweep', async () => {
    // A checkedAt one hour old (past the 50-min recheck) so the premise is DUE;
    // value 1 with no tolerance ⇒ observed 5 always drifts.
    const row = goalRow('aaaaaaaa-0000-4000-8000-000000000000', 'p-canlaw', 'CanLaw', [{ key: 'k', value: 1, source: 'https://bench.example/k.json', jsonPath: 'v', checkedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() }]);
    alPrisma.projectGoal.findMany.mockResolvedValue([row]);
    alPrisma.projectGoal.findUnique.mockResolvedValue({ premises: row.premises, updatedAt: NOW });
    alPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'sup-canlaw' });
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(JSON.stringify({ v: 5 })));
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    const out = await runPremiseCheckOnce({ fetchImpl: fetchImpl as any, enqueueDirectWake: failing as any, now: NOW });
    expect(out).toMatchObject({ drifted: 1 });
    expect(alStore.has('premise:drift:aaaaaaaa-0000-4000-8000-000000000000:k')).toBe(false);
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ key: 'k', outcome: 'enqueue_failed', error: 'target chat not found' }),
    }));
    // next sweep, wake healthy: the same drift (still true) fires.
    const healthy = jest.fn(async (_o: any) => ({ ok: true }));
    const again = await runPremiseCheckOnce({ fetchImpl: fetchImpl as any, enqueueDirectWake: healthy as any, now: NOW });
    expect(again).toMatchObject({ drifted: 1 });
    expect(healthy).toHaveBeenCalledTimes(1);
    // TTL pin: the healthy retry stamps the 24h drift key with the OBSERVED value
    expect(alRedis.set).toHaveBeenCalledWith('premise:drift:aaaaaaaa-0000-4000-8000-000000000000:k', '5', { EX: PREMISE_DRIFT_DEDUPE_SEC });
  });

  it('REPLAY (conflict): a failed conflict wake sets NO 7-day conflict key — the contradiction re-surfaces next sweep; a healthy wake stamps it', async () => {
    const rows = [
      goalRow('aaaaaaaa-0000-4000-8000-000000000000', 'p-a', 'A', [{ key: 'shared', value: 1 }]),
      goalRow('bbbbbbbb-0000-4000-8000-000000000000', 'p-b', 'B', [{ key: 'shared', value: 2 }]),
    ];
    alPrisma.projectGoal.findMany.mockResolvedValueOnce(rows);
    alPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'fleet-sup' });
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'queue capped' }));
    const out = await runPremiseCheckOnce({ enqueueDirectWake: failing as any, now: NOW });
    expect(out).toMatchObject({ conflicts: 1 });
    expect([...alStore.keys()].some((k) => k.startsWith('premise:conflict:u1:'))).toBe(false);
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ key: 'shared', outcome: 'enqueue_failed', error: 'queue capped' }),
    }));
    // next sweep, wake healthy: the same contradiction (still true) fires.
    alPrisma.projectGoal.findMany.mockResolvedValueOnce(rows);
    alPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'fleet-sup' });
    const healthy = jest.fn(async (_o: any) => ({ ok: true }));
    const again = await runPremiseCheckOnce({ enqueueDirectWake: healthy as any, now: NOW });
    expect(again).toMatchObject({ conflicts: 1 });
    expect(healthy).toHaveBeenCalledTimes(1);
    expect([...alStore.keys()].some((k) => k.startsWith('premise:conflict:u1:'))).toBe(true);
    // TTL pin: the healthy retry stamps the 7d conflict key
    expect(alRedis.set).toHaveBeenCalledWith(expect.stringMatching(/^premise:conflict:u1:/), '1', { EX: PREMISE_CONFLICT_DEDUPE_SEC });
  });
});

// ═══ 1a. follow-through: the three nudge seams ═══════════════════════════════

describe('abd733af — follow-through nudges read the { ok: false } return', () => {
  const PROJ = 'proj-ft';
  const SUP_ROW: any = { id: SUP, userId: 'u1', title: 'ft Supervisor', projectId: PROJ, isSupervisor: false, isProjectSupervisor: true };
  const ASK_ID = 'dir-ask-0001';
  const ASK = { id: ASK_ID, at: '2026-10-18T00:00:00.000Z', text: 'Ship or park the node-a cutover?', messageId: 'msg-ask-1' };

  const wireOwnerAsk = (ageH: number) => {
    const at = new Date(NOW.getTime() - ageH * 3600_000);
    alPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => (args?.where?.OR ? [SUP_ROW] : []));
    alPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PROJ, projectSupervisorEnabled: true, archivedAt: null }]);
    return { ...ASK, at: at.toISOString() };
  };

  it('REPLAY (nudge): a failed owner-ask nudge sets NO 24h nudge key — the still-open ask nudges again next sweep', async () => {
    const ask = wireOwnerAsk(3); // past the 2h nudge threshold, under the 8h escalation one
    alPrisma.crossModelMessage.findMany.mockResolvedValue([]); // note sweep: nothing due
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    const out = await sweepFollowThrough({ now: NOW, enqueueDirectWake: failing as any, listOpenOwnerAsks: jest.fn(async () => [ask]) as any, hasSupervisorReplyAfter: jest.fn(async () => false) as any });
    expect(out).toMatchObject({ askNudges: 0, askEscalations: 0 }); // not delivered ⇒ not counted
    expect(failing).toHaveBeenCalledTimes(1);
    expect((failing.mock.calls[0] as any[])[0].meta.kind).toBe('owner_ask_unanswered');
    expect(alStore.has(`follow-through:ask-nudge:${SUP}:${ASK_ID}`)).toBe(false);
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner_ask_nudge', meta: expect.objectContaining({ stage: 'nudge', outcome: 'enqueue_failed', error: 'target chat not found' }),
    }));
    // next sweep, wake healthy: the same open ask still nudges.
    const healthy = jest.fn(async (_o: any) => ({ ok: true }));
    const out2 = await sweepFollowThrough({ now: NOW, enqueueDirectWake: healthy as any, listOpenOwnerAsks: jest.fn(async () => [ask]) as any, hasSupervisorReplyAfter: jest.fn(async () => false) as any });
    expect(out2).toMatchObject({ askNudges: 1 }); // delivered ⇒ counted
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(alStore.has(`follow-through:ask-nudge:${SUP}:${ASK_ID}`)).toBe(true);
    // TTL pin: the healthy retry stamps the 24h nudge key with the ask id
    expect(alRedis.set).toHaveBeenCalledWith(`follow-through:ask-nudge:${SUP}:${ASK_ID}`, ASK_ID, { EX: OWNER_ASK_DEDUPE_SEC });
  });

  it('REPLAY (escalation): a failed escalation to the Fleet Supervisor sets NO 24h escalate key — and a FAILED NUDGE does not block the escalation path', async () => {
    const ask = wireOwnerAsk(9); // past the 8h escalation threshold
    alPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    alPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.isSupervisor === true && w.userId === 'u1' && w.archivedAt === null) return { id: 'fleet-sup-1' };
      return null;
    });
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: failing as any, listOpenOwnerAsks: jest.fn(async () => [ask]) as any, hasSupervisorReplyAfter: jest.fn(async () => false) as any });
    // nudge failed AND escalation failed: neither key set
    expect(alStore.has(`follow-through:ask-nudge:${SUP}:${ASK_ID}`)).toBe(false);
    expect(alStore.has(`follow-through:ask-escalate:${SUP}:${ASK_ID}`)).toBe(false);
    expect(failing).toHaveBeenCalledTimes(2); // nudge + escalation
    const escCall = (failing.mock.calls[1] as any[])[0];
    expect(escCall.targetChatId).toBe('fleet-sup-1');
    expect(escCall.meta.kind).toBe('owner_ask_escalated');
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner_ask_nudge', meta: expect.objectContaining({ stage: 'escalate', outcome: 'enqueue_failed' }),
    }));
    // next sweep, wake healthy: BOTH fire (nudge was never stamped either).
    const healthy = jest.fn(async (_o: any) => ({ ok: true }));
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: healthy as any, listOpenOwnerAsks: jest.fn(async () => [ask]) as any, hasSupervisorReplyAfter: jest.fn(async () => false) as any });
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(alStore.has(`follow-through:ask-nudge:${SUP}:${ASK_ID}`)).toBe(true);
    expect(alStore.has(`follow-through:ask-escalate:${SUP}:${ASK_ID}`)).toBe(true);
  });

  it('REPLAY (diagnosis nudge): a failed diagnosis-nudge sets NO nudge key — the diagnosis re-fires next sweep', async () => {
    const DIAGNOSIS = `Lane ddd26be0 looks stalled: no receipts in 6h.`;
    const noteRow = { id: 'note-dx-1', content: DIAGNOSIS, createdAt: new Date(NOW.getTime() - 94 * 60_000), metadata: { origin: 'schedule' } };
    alPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => (args?.where?.OR ? [SUP_ROW] : []));
    alPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PROJ, projectSupervisorEnabled: true, archivedAt: null }]);
    alPrisma.crossModelMessage.findMany.mockResolvedValue([noteRow]);
    alPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    alPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    alPrisma.chatSchedule.findFirst.mockResolvedValue(null);
    alPrisma.ownerQuestion.findFirst.mockResolvedValue(null);
    alPrisma.projectTodo.findFirst.mockResolvedValue(null);
    alStore.set(`follow-through:cursor:${SUP}`, String(new Date(NOW.getTime() - 120 * 60_000).getTime()));
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'queue capped' }));
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: failing as any });
    expect(failing).toHaveBeenCalledTimes(1);
    expect((failing.mock.calls[0] as any[])[0].meta.kind).toBe('diagnosis_without_action');
    expect(alStore.has(`follow-through:nudge:${SUP}:ddd26be0`)).toBe(false);
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'follow_through_nudge', meta: expect.objectContaining({ laneId8: 'ddd26be0', outcome: 'enqueue_failed', error: 'queue capped' }),
    }));
    // Retry semantics (review round 1b finding 3): the sweep cursor advances
    // past the note regardless of wake outcome, so the PRODUCTION retry path
    // is a re-fired diagnosis note (or the next sweep window while still due)
    // — the cursor is rewound here to prove the pin: with the key unset that
    // retry DELIVERS. The pre-fix code set NUDGE_KEY and would have silenced
    // it for 24h even then.
    alPrisma.crossModelMessage.findMany.mockResolvedValue([noteRow]);
    alStore.set(`follow-through:cursor:${SUP}`, String(new Date(NOW.getTime() - 120 * 60_000).getTime()));
    const healthy = jest.fn(async (_o: any) => ({ ok: true }));
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: healthy as any });
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(alStore.has(`follow-through:nudge:${SUP}:ddd26be0`)).toBe(true);
  });
});

// ═══ 3. deliver(): per-target failure-evidence dedupe ═════════════════════════

describe('abd733af — deliver() enqueue-failure evidence dedupe (review finding 3)', () => {
  const T1 = { id: 'fleet-sup-1', userId: 'u1' };
  const T2 = { id: 'fleet-sup-2', userId: 'u1' };

  it('first failure writes the enqueue_failed row + arms the 1h evidence key; the SAME alert is still ATTEMPTED (not silenced) every sweep, writing no second row while the key holds; a healthy target in the same pass still delivers', async () => {
    const wake = jest.fn(async (o: any) => (o.targetChatId === 'fleet-sup-1' ? { ok: false, error: 'target chat not found' } : { ok: true }));
    const n1 = await deliver([T1, T2] as any, 'k1', 3600, 'p', { kind: 'disk' }, wake as any);
    expect(n1).toBe(1);
    expect(alStore.has('infra-watch:enqueue-fail-row:fleet-sup-1')).toBe(true);
    // TTL pin: the evidence key is armed for the 1h dedupe window
    expect(alRedis.set).toHaveBeenCalledWith('infra-watch:enqueue-fail-row:fleet-sup-1', expect.any(String), { EX: ENQUEUE_FAIL_ROW_DEDUPE_SEC });
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ outcome: 'enqueue_failed', error: 'target chat not found' }) }));
    // Partial failure (T2 delivered): the alert dedupe key IS set — PR #1698's
    // partial-failure contract; the failing half is retried per 6d19f11f only
    // until the key holds.
    expect(alStore.has('k1')).toBe(true);
    // fresh alert key, same failing target: the wake is STILL attempted (the
    // 6d19f11f retry contract — never silenced by the failure itself), but no
    // second evidence row is written while the 1h key holds.
    alMetric.mockClear();
    const before = wake.mock.calls.length;
    const n2 = await deliver([T1] as any, 'k2', 3600, 'p', { kind: 'disk' }, wake as any);
    expect(n2).toBe(0);
    expect(wake.mock.calls.length).toBe(before + 1); // attempted again
    const failedRows = alMetric.mock.calls.filter((c: any[]) => c[0]?.meta?.outcome === 'enqueue_failed');
    expect(failedRows.length).toBe(0); // evidence deduped — no churn row
    expect(alStore.has('k2')).toBe(false); // still not delivered ⇒ no dedupe key
  });

  it('evidence key expiry writes a fresh row (≤1 row/hour/target telemetry rate); a DELIVERED wake clears the key so the next failure is fully evidenced again', async () => {
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    await deliver([T1] as any, 'k3', 3600, 'p', { kind: 'backup' }, failing as any);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(alMetric).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ outcome: 'enqueue_failed' }) }));
    // key holds: attempted again, no new row
    alMetric.mockClear();
    loggerMock.warn.mockClear();
    await deliver([T1] as any, 'k4', 3600, 'p', { kind: 'backup' }, failing as any);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(alMetric).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled(); // review round 1b finding 4: the WARN is deduped evidence too, not just the row
    // key expires: one fresh evidence row
    alStore.delete('infra-watch:enqueue-fail-row:fleet-sup-1');
    await deliver([T1] as any, 'k5', 3600, 'p', { kind: 'backup' }, failing as any);
    expect(alMetric).toHaveBeenCalledTimes(1);
    // recovery: a delivered wake clears the key
    const healthy = jest.fn(async (_o: any) => ({ ok: true }));
    alStore.set('infra-watch:enqueue-fail-row:fleet-sup-1', 'held');
    await deliver([T1] as any, 'k6', 3600, 'p', { kind: 'backup' }, healthy as any);
    expect(alStore.has('infra-watch:enqueue-fail-row:fleet-sup-1')).toBe(false);
  });
});

// ═══ 2a. card-digest gate ordering (indirect: the deliver() + caller contract) ═

describe('abd733af — card-digest 26h gate is a caller-owned retry gate', () => {
  it('a failed card wake leaves the day open: deliver() sets NO alert key on total failure (6d19f11f), and the CALLER digest key is now only stamped on delivered>0 — pinned via the deliver() contract the caller gates on', async () => {
    // This file pins deliver()'s half of the contract. The SWEEP-level
    // ordering (actionable day + {ok:false} wake ⇒ 26h dkey UNSET, second
    // sweep re-attempts, healthy delivery stamps it) is pinned in
    // infra-watch.service.test.ts — the test named 'abd733af … sweep-level'
    // (review round 1b finding 1: this comment used to cite a pin that did
    // not exist; the sweep describe there only exercised healthy wakes).
    const failing = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    const n = await deliver([{ id: 'fleet-sup-1', userId: 'u1' }] as any, 'cards-day-key', 26 * 3600, 'p', { kind: 'cards' }, failing as any);
    expect(n).toBe(0);
    expect(alStore.has('cards-day-key')).toBe(false);
    expect(alStore.has('infra-watch:enqueue-fail-row:fleet-sup-1')).toBe(true); // evidence row armed (≤1/h)
    // the retry next sweep is still attempted — pinned in the evidence-dedupe
    // suite above — so once the enqueue path recovers the digest delivers and
    // only then does the caller stamp its 26h day key.
  });
});
