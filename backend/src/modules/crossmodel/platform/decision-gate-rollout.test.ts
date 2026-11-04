/**
 * Decision-gate rollout automaton (rollout self-governance, 2026-09-27).
 *
 * The pure planner (planRollout / measuredReady / ownerAnswerIsGo /
 * normalizeRolloutState) is tested directly; the pass
 * (runDecisionGateRolloutOnce) is tested at the module boundary with the
 * context store, prisma, the modes module's PUT path and the owner-question
 * filer mocked — the SAME admission path the admin PUT uses is what the flip
 * goes through (updateDecisionModes is mocked at the seam and asserted on).
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const settings = new Map<string, { key: string; value: string; updatedAt: Date }>();
const ownerQuestions = new Map<string, { id: string; status: string; answer: string | null; chosenOption: string | null; question: string }>();
let demotedRows: Array<{ meta: any; createdAt: Date }> = [];
const mockSettingFind: jest.Mock = jest.fn(async ({ where }: any) => settings.get(where.key) ?? null);
const mockSettingUpsert: jest.Mock = jest.fn(async ({ where, update, create }: any) => {
  const row = { key: where.key, value: String(update?.value ?? create?.value), updatedAt: new Date('2026-09-27T12:00:00Z') };
  settings.set(where.key, row);
  return row;
});
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    systemSetting: { findUnique: (...a: any[]) => mockSettingFind(...a), upsert: (...a: any[]) => mockSettingUpsert(...a) },
    ownerQuestion: { findUnique: async ({ where }: any) => ownerQuestions.get(where.id) ?? null },
    loopMetric: { findMany: async () => demotedRows },
  },
}));
const store = new Map<string, any>();
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], key: string, value: any) => { store.set(`${ns.join('/')}/${key}`, value); });
jest.mock('../memory/context-store', () => ({
  storeGet: async (ns: string[], key: string) => store.get(`${ns.join('/')}/${key}`) ?? null,
  storePut: (...a: any[]) => mockStorePut(...a),
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

const mockGetConfig = jest.fn();
const mockUpdateModes = jest.fn();
jest.mock('./decision-gate-modes', () => ({
  __esModule: true,
  ...jest.requireActual('./decision-gate-modes'),
  getDecisionModeConfig: (...a: any[]) => mockGetConfig(...a),
  updateDecisionModes: (...a: any[]) => mockUpdateModes(...a),
}));
const mockReadStamp = jest.fn();
const mockReadReport = jest.fn();
jest.mock('./decision-gate-readiness', () => ({
  __esModule: true,
  readReadinessStamp: (...a: any[]) => mockReadStamp(...a),
  readLatestReadinessReport: (...a: any[]) => mockReadReport(...a),
}));
const mockFlag = jest.fn();
jest.mock('./owner-questions', () => ({ __esModule: true, flagOwnerQuestion: (...a: any[]) => mockFlag(...a) }));
jest.mock('../fleet/infra-watch.service', () => ({ __esModule: true, adminFleetSupervisors: async () => [{ id: 'fleet-chat-1', userId: 'admin-1' }] }));
const mockFileTicket = jest.fn();
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: (...a: any[]) => mockFileTicket(...a) }));

import {
  ROLLOUT_STORE_KEY, ROLLOUT_STORE_NS, ROLLOUT_SETTING_KEY, ROLLOUT_METRIC_KIND, ROLLOUT_ACTOR,
  planRollout, measuredReady, ownerAnswerIsGo, normalizeRolloutState, emptyRolloutState, runDecisionGateRolloutOnce,
  rolloutEnabled, setRolloutEnabled, invalidateRolloutSettingCache, rolloutBootDefault, rolloutIntervalMin,
  rolloutBriefingLine, rolloutRecentLineSync, parkedPurposesSync, primeRolloutStateCache, clearRolloutStateCache,
  planLifecycle, reviewDueMs, NON_CONVERGING_MIN_OUTCOME_ROWS, NON_CONVERGING_MAX_ACCURACY,
} from './decision-gate-rollout';
import { DECISION_PURPOSES, purposeActCap } from './decision-gate-modes';
import { DECISION_ROLE_REGISTRY } from './decision-gate-registry';

const NOW = new Date('2026-09-27T12:00:00Z');
const iso = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function view(purpose: string, over: Partial<any> = {}): any {
  return {
    purpose, label: purpose, description: '', storeMode: null, envMode: 'shadow', effective: 'shadow', effectiveSource: 'default',
    readiness: null, admission: { admitted: true }, ...over,
  };
}
function config(overrides: Record<string, Partial<any>> = {}): any {
  return { purposes: DECISION_PURPOSES.map(p => view(p.purpose, overrides[p.purpose] ?? {})), gateDisabled: false, admissionDisabled: false };
}
function stampEntry(over: Partial<any> = {}): any {
  return { ready: true, at: iso(1), backend: 'TypeSafe Jev (jev-1.13.0)', backendSpec: 'jev', metrics: { n: 320 }, reasons: [], windowDays: 14, partition: '', ...over };
}

beforeEach(() => {
  settings.clear(); ownerQuestions.clear(); store.clear(); demotedRows = [];
  mockStorePut.mockClear(); mockRecordLoopMetric.mockClear(); mockGetConfig.mockReset(); mockUpdateModes.mockReset(); mockReadStamp.mockReset(); mockReadReport.mockReset(); mockFlag.mockReset();
  mockUpdateModes.mockImplementation(async () => config());
  mockReadReport.mockResolvedValue({ computedAt: iso(0.5) });
  invalidateRolloutSettingCache(); clearRolloutStateCache();
  delete process.env.DECISION_GATE_AUTO_ROLLOUT; delete process.env.DECISION_GATE_AUTO_ROLLOUT_DRY_RUN; delete process.env.DECISION_GATE_ROLLOUT_JOB_DISABLED;
});

describe('measuredReady — a fresh MEASURED READY stamp, never an owner-override', () => {
  it('accepts a measured READY with labels above the bar', () => {
    expect(measuredReady(stampEntry(), 'wake_triage', NOW.getTime()).ok).toBe(true);
  });
  it('refuses missing / NOT READY / stale / owner-override / under-labelled stamps', () => {
    expect(measuredReady(undefined, 'wake_triage', NOW.getTime()).why).toMatch(/no readiness stamp/);
    expect(measuredReady(stampEntry({ ready: false, reasons: ['labels 12 < 200'] }), 'wake_triage', NOW.getTime()).why).toMatch(/NOT READY: labels 12/);
    expect(measuredReady(stampEntry({ at: iso(24 * 9) }), 'wake_triage', NOW.getTime()).why).toMatch(/stale/);
    expect(measuredReady(stampEntry({ backend: 'owner-override:claude-loop' }), 'wake_triage', NOW.getTime()).why).toMatch(/owner-override/);
    expect(measuredReady(stampEntry({ metrics: { n: 40 } }), 'wake_triage', NOW.getTime()).why).toMatch(/40 labels < 200/);
    expect(measuredReady(stampEntry({ metrics: {} }), 'wake_triage', NOW.getTime()).why).toMatch(/no labels/);
  });
});

describe('ownerAnswerIsGo', () => {
  it('reads the typed option first, then the standing proceed words', () => {
    expect(ownerAnswerIsGo(null, 'flip')).toBe(true);
    expect(ownerAnswerIsGo('go ahead', 'hold')).toBe(false);
    expect(ownerAnswerIsGo('yes, flip it', null)).toBe(true);
    expect(ownerAnswerIsGo('not yet — keep it shadow', null)).toBe(false);
    expect(ownerAnswerIsGo('', null)).toBe(false);
  });
});

describe('planRollout — the pure automaton', () => {
  it('flips a tier-1 purpose in shadow on a measured READY stamp; never an owner-override, a stale stamp, an act cap, an off purpose or an already-act purpose', () => {
    const plan = planRollout({
      now: NOW,
      modes: config({
        memory_extract: { effective: 'act', storeMode: 'act', effectiveSource: 'store' },
        delta_material: { effective: 'off', storeMode: 'off', effectiveSource: 'store' },
        drain_triage: { storeMode: 'act', effective: 'shadow', effectiveSource: 'registry_cap', actCap: { since: '2026-09-27', why: 'capped', liftEnv: 'X' }, admission: { admitted: false, reason: 'capped' } },
      }),
      stamp: {
        wake_triage: stampEntry(),
        sweep_triage: stampEntry({ backend: 'owner-override:claude-loop', metrics: {} }),
        imessage_send: stampEntry({ at: iso(24 * 10) }),
        memory_extract: stampEntry(), delta_material: stampEntry(), drain_triage: stampEntry(),
        coding_memory_fold: stampEntry(),
      },
      demotions: {}, state: emptyRolloutState(), askStatus: {},
    });
    expect(plan.flips.map(f => f.purpose).sort()).toEqual(['coding_memory_fold', 'wake_triage']);
    expect(plan.flips[0].reason).toBe('measured_ready');
    const skipped = Object.fromEntries(plan.skipped.map(s => [s.purpose, s.reason]));
    expect(skipped.sweep_triage).toMatch(/owner-override/);
    expect(skipped.imessage_send).toMatch(/stale/);
    expect(skipped.memory_extract).toBe('already act');
    expect(skipped.delta_material).toMatch(/off — never touched/);
    expect(skipped.drain_triage).toMatch(/act-capped in code/);
    expect(plan.inconsistencies).toEqual([expect.stringMatching(/^drain_triage: the store row says act but the code caps it at shadow/)]);
    expect(plan.asks).toEqual([]);
  });

  it('task_kind (task-aware pick 2026-10-20): a READY tier-3 evidence key under its REAL code cap is skipped — never flipped, never an owner question', () => {
    const cap = purposeActCap('task_kind');
    expect(cap).not.toBeNull();
    const plan = planRollout({
      now: NOW,
      modes: config({ task_kind: { actCap: cap, admission: { admitted: false, reason: 'capped' } } }),
      stamp: { task_kind: stampEntry() },
      demotions: {}, state: emptyRolloutState(), askStatus: {},
    });
    expect(plan.flips).toEqual([]);
    expect(plan.asks).toEqual([]);
    expect(plan.skipped.find(s => s.purpose === 'task_kind')?.reason).toBe('act-capped in code since 2026-10-20');
  });

  it('parks a purpose auto-demoted twice inside the window and never flips a parked purpose', () => {
    const plan = planRollout({
      now: NOW, modes: config(), stamp: { wake_triage: stampEntry() },
      demotions: { wake_triage: [iso(30), iso(2)], auto_route: [iso(24 * 9), iso(1)] },
      state: emptyRolloutState(), askStatus: {},
    });
    expect(plan.parks).toEqual([{ purpose: 'wake_triage', until: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(), demotedAt: [iso(30), iso(2)] }]);
    expect(plan.flips).toEqual([]);
    expect(plan.skipped.find(s => s.purpose === 'wake_triage')?.reason).toMatch(/parked after 2 auto-demotions/);
    // One demotion inside the window (the other is 9 d old) does not park.
    expect(plan.parks.find(p => p.purpose === 'auto_route')).toBeUndefined();
  });

  it('a purpose already parked in the state is skipped without a second park', () => {
    const state = emptyRolloutState();
    state.parked.wake_triage = { until: new Date(NOW.getTime() + 86_400_000).toISOString(), reason: 'x', demotedAt: [] };
    const plan = planRollout({ now: NOW, modes: config(), stamp: { wake_triage: stampEntry() }, demotions: {}, state, askStatus: {} });
    expect(plan.parks).toEqual([]);
    expect(plan.flips).toEqual([]);
    expect(plan.skipped.find(s => s.purpose === 'wake_triage')?.reason).toMatch(/parked/);
  });

  it('2026-10-04 (owner authorization): a MEASURED-ready tier-2 purpose FLIPS like tier 1; an owner-locked one is still asked; tier 3 still never flips', () => {
    const stamp = { compute_policy: stampEntry(), wake_effort: stampEntry(), tool_intent: stampEntry() };
    const plan = planRollout({ now: NOW, modes: config(), stamp, demotions: {}, state: emptyRolloutState(), askStatus: {} });
    expect(plan.flips.map((f) => [f.purpose, f.reason])).toEqual([['compute_policy', 'measured_ready']]);
    expect(plan.flips[0].bars).toMatchObject({ tier: 2, ownerAuthorized: '2026-10-04' });
    expect(plan.asks.map((a) => a.purpose).sort()).toEqual(['tool_intent', 'wake_effort']);
  });

  it('DECISION_GATE_AUTO_ROLLOUT_MAX_TIER=1: a ready tier-2 purpose is ONE owner question, deduped while open; a GO answer flips, a hold does not; tier 3 never flips', () => {
    process.env.DECISION_GATE_AUTO_ROLLOUT_MAX_TIER = '1';
    const stamp = { compute_policy: stampEntry(), tool_intent: stampEntry(), firing_superseded: stampEntry() };
    const first = planRollout({ now: NOW, modes: config(), stamp, demotions: {}, state: emptyRolloutState(), askStatus: {} });
    expect(first.flips).toEqual([]);
    expect(first.asks.map(a => [a.purpose, a.tier]).sort()).toEqual([['compute_policy', 2], ['firing_superseded', 2], ['tool_intent', 3]]);
    const state = emptyRolloutState();
    state.ownerAsks.compute_policy = { questionId: 'oq_1', at: iso(3), tier: 2 };
    state.ownerAsks.tool_intent = { questionId: 'oq_2', at: iso(3), tier: 3 };
    state.ownerAsks.firing_superseded = { questionId: 'oq_3', at: iso(3), tier: 2 };
    const second = planRollout({
      now: NOW, modes: config(), stamp, demotions: {}, state,
      askStatus: { compute_policy: { status: 'open', answer: null, chosenOption: null }, tool_intent: { status: 'answered', answer: 'flip', chosenOption: null }, firing_superseded: { status: 'answered', answer: null, chosenOption: 'flip' } },
    });
    expect(second.asks).toEqual([]);
    expect(second.skipped.find(s => s.purpose === 'compute_policy')?.reason).toMatch(/owner question oq_1 still open/);
    expect(second.flips.map(f => [f.purpose, f.reason])).toEqual([['firing_superseded', 'owner_answered']]);
    expect(second.skipped.find(s => s.purpose === 'tool_intent')?.reason).toMatch(/tier 3 is never flipped here/);
    expect(second.closeAsks.sort()).toEqual(['firing_superseded', 'tool_intent']);
    delete process.env.DECISION_GATE_AUTO_ROLLOUT_MAX_TIER;
  });

  it('an admission refusal on a measured stamp is a skip with the bar named (the planner never overrides the PUT rules)', () => {
    const plan = planRollout({
      now: NOW, modes: config({ wake_triage: { admission: { admitted: false, reason: 'readiness measured on laya, primary is jev' } } }),
      stamp: { wake_triage: stampEntry() }, demotions: {}, state: emptyRolloutState(), askStatus: {},
    });
    expect(plan.flips).toEqual([]);
    expect(plan.skipped.find(s => s.purpose === 'wake_triage')?.reason).toMatch(/admission refused: readiness measured on laya/);
  });
});

describe('normalizeRolloutState', () => {
  it('drops malformed fields and keeps well-formed ones', () => {
    const s = normalizeRolloutState({
      lastRunAt: 'nope', lastReadinessComputedAt: iso(1), lastSummary: 42,
      parked: { wake_triage: { until: iso(-24), reason: 'r', demotedAt: [iso(2)] }, bad: { until: 'x' } },
      actions: [{ at: iso(1), purpose: 'a', from: 'shadow', to: 'act', reason: 'flipped' }, { at: 'bad' }, null],
      ownerAsks: { compute_policy: { questionId: 'oq_1', at: iso(1), tier: 2 }, bad: {} },
      inconsistencies: ['x', 3],
    });
    expect(s.lastRunAt).toBeNull();
    expect(s.lastReadinessComputedAt).toBe(iso(1));
    expect(s.lastSummary).toBeNull();
    expect(Object.keys(s.parked)).toEqual(['wake_triage']);
    expect(s.actions).toHaveLength(1);
    expect(Object.keys(s.ownerAsks)).toEqual(['compute_policy']);
    expect(s.inconsistencies).toEqual(['x']);
    expect(normalizeRolloutState(null)).toEqual(emptyRolloutState());
  });
});

describe('the switch — SystemSetting decision_gate_auto_rollout, env boot default ON', () => {
  it('boot default is ON unless DECISION_GATE_AUTO_ROLLOUT=0; the row wins; the flip is idempotent and audited', async () => {
    expect(rolloutBootDefault()).toBe(true);
    process.env.DECISION_GATE_AUTO_ROLLOUT = '0';
    expect(rolloutBootDefault()).toBe(false);
    expect(await rolloutEnabled()).toBe(false);
    delete process.env.DECISION_GATE_AUTO_ROLLOUT;
    invalidateRolloutSettingCache();
    expect(await rolloutEnabled()).toBe(true);
    const off = await setRolloutEnabled(false, 'paul@example');
    expect(off.changed).toBe(true);
    expect(settings.get(ROLLOUT_SETTING_KEY)?.value).toBe('0');
    expect(settings.get(`${ROLLOUT_SETTING_KEY}_by`)?.value).toBe('paul@example');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: ROLLOUT_METRIC_KIND, meta: expect.objectContaining({ action: 'switch', enabled: false }) }));
    expect((await setRolloutEnabled(false, 'paul@example')).changed).toBe(false);
    expect(off.state.since).toBe('2026-09-27T12:00:00.000Z');
    expect(rolloutIntervalMin({ DECISION_GATE_ROLLOUT_INTERVAL_MIN: '5' })).toBe(15);
    expect(rolloutIntervalMin({})).toBe(60);
  });
});

describe('runDecisionGateRolloutOnce — the pass', () => {
  it('flips a tier-1 measured-READY purpose through updateDecisionModes (the admin PUT path), records the metric + the ledger, judges each readiness report once', async () => {
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ wake_triage: stampEntry(), auto_route: stampEntry({ backend: 'owner-override:claude-loop', metrics: {} }) });
    const summary = await runDecisionGateRolloutOnce({ now: NOW });
    expect(summary).toMatch(/^flipped 1, refused 0, asked 0, parked 0, inconsistencies 0, evaluated 24/);
    expect(mockUpdateModes).toHaveBeenCalledTimes(1);
    expect(mockUpdateModes).toHaveBeenCalledWith({ wake_triage: 'act' }, ROLLOUT_ACTOR, undefined);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: ROLLOUT_METRIC_KIND, meta: expect.objectContaining({ purpose: 'wake_triage', from: 'shadow', to: 'act', reason: 'measured_ready', dryRun: false }) }));
    const row = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(row.actions[0]).toMatchObject({ purpose: 'wake_triage', from: 'shadow', to: 'act', reason: 'flipped', by: ROLLOUT_ACTOR });
    expect(row.lastReadinessComputedAt).toBe(iso(0.5));
    // The same report again → no-op (once per readiness firing) — but the
    // waiting pass still stamps the LIVENESS heartbeat (FO firing 78): a
    // healthy idle must not look like a stalled automaton on the status surface.
    mockUpdateModes.mockClear();
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/waiting for a fresher readiness report/);
    expect(mockUpdateModes).not.toHaveBeenCalled();
    const idleRow = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(idleRow.lastRunAt).toBe(NOW.toISOString());
    expect(idleRow.lastSummary).toMatch(/^waiting for a fresher readiness report/);
  });

  it('DRY RUN records what it would flip and writes no mode; OFF evaluates nothing; a refused admission is recorded, never thrown', async () => {
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ wake_triage: stampEntry() });
    process.env.DECISION_GATE_AUTO_ROLLOUT_DRY_RUN = '1';
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/^DRY RUN: flipped 0 \(would flip 1\)/);
    expect(mockUpdateModes).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ purpose: 'wake_triage', dryRun: true }) }));
    delete process.env.DECISION_GATE_AUTO_ROLLOUT_DRY_RUN;

    settings.set(ROLLOUT_SETTING_KEY, { key: ROLLOUT_SETTING_KEY, value: '0', updatedAt: NOW });
    invalidateRolloutSettingCache();
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/auto-rollout OFF/);
    expect(mockGetConfig).toHaveBeenCalledTimes(1);
    settings.delete(ROLLOUT_SETTING_KEY);
    invalidateRolloutSettingCache();

    mockReadReport.mockResolvedValue({ computedAt: iso(0.1) });
    mockUpdateModes.mockRejectedValue(Object.assign(new Error('Cannot set wake_triage to act — not ready: the READY stamp is stale'), { statusCode: 409 }));
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/flipped 0, refused 1/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ purpose: 'wake_triage', reason: 'refused' }) }));
  });

  it('files ONE owner question for a ready tier-2 purpose and remembers it (MAX_TIER=1); a GO answer flips on the next pass', async () => {
    process.env.DECISION_GATE_AUTO_ROLLOUT_MAX_TIER = '1';
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ compute_policy: stampEntry() });
    mockFlag.mockResolvedValue({ kind: 'created', question: { id: 'oq_cp1' } });
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/asked 1/);
    expect(mockFlag).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'fleet-chat-1', userId: 'admin-1', machineTriggered: true, options: [{ id: 'flip', label: 'Flip to act' }, { id: 'hold', label: 'Keep shadow' }] }));
    expect(mockFlag.mock.calls[0][0].question).toMatch(/compute_policy.*READY.*tier 2/);
    expect(mockUpdateModes).not.toHaveBeenCalled();
    // Still open → no second question.
    ownerQuestions.set('oq_cp1', { id: 'oq_cp1', status: 'open', answer: null, chosenOption: null, question: 'compute_policy' });
    mockReadReport.mockResolvedValue({ computedAt: iso(0.2) });
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/asked 0/);
    expect(mockFlag).toHaveBeenCalledTimes(1);
    // Answered 'flip' → the flip runs through the PUT path with reason owner_answered.
    ownerQuestions.set('oq_cp1', { id: 'oq_cp1', status: 'answered', answer: null, chosenOption: 'flip', question: 'compute_policy' });
    mockReadReport.mockResolvedValue({ computedAt: iso(0.1) });
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/flipped 1/);
    expect(mockUpdateModes).toHaveBeenCalledWith({ compute_policy: 'act' }, ROLLOUT_ACTOR, undefined);
    const row = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(row.ownerAsks).toEqual({});
    expect(row.actions[0]).toMatchObject({ purpose: 'compute_policy', reason: 'owner_answered' });
  });

  it('r3 interactions finding 3: a re-ask after an auto-demote carries the demote as harnessEventAt (an earlier owner ruling annotates it, never refuses it); with no demote the re-ask carries none', async () => {
    delete process.env.DECISION_GATE_AUTO_ROLLOUT_MAX_TIER;
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ wake_effort: stampEntry() }); // tier 2, owner-locked → asked
    mockFlag.mockResolvedValue({ kind: 'created', question: { id: 'oq_we1' } });
    demotedRows = [{ meta: { purpose: 'wake_effort', outcome: 'demoted' }, createdAt: new Date(iso(30)) }];
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/asked 1/);
    expect(mockFlag.mock.calls[0][0]).toMatchObject({ machineTriggered: true, harnessEventAt: iso(30) });
    expect(mockFlag.mock.calls[0][0].context).toContain(`Last auto-demoted from act at ${iso(30)}.`);

    store.clear(); mockFlag.mockClear(); demotedRows = [];
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/asked 1/);
    expect(mockFlag.mock.calls[0][0]).not.toHaveProperty('harnessEventAt');
  });

  it('parks a twice-demoted purpose (metric + ledger) and reports a store/code inconsistency without rewriting it', async () => {
    mockGetConfig.mockResolvedValue(config({ drain_triage: { storeMode: 'act', effective: 'shadow', effectiveSource: 'registry_cap', actCap: { since: '2026-09-27', why: 'capped', liftEnv: 'X' }, admission: { admitted: false, reason: 'capped' } } }));
    mockReadStamp.mockResolvedValue({ wake_triage: stampEntry() });
    demotedRows = [{ meta: { purpose: 'wake_triage', outcome: 'demoted' }, createdAt: new Date(iso(20)) }, { meta: { purpose: 'wake_triage', outcome: 'demoted' }, createdAt: new Date(iso(2)) }, { meta: { purpose: 'wake_triage', outcome: 'observed' }, createdAt: new Date(iso(1)) }];
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/flipped 0, refused 0, asked 0, parked 1, inconsistencies 1/);
    expect(mockUpdateModes).not.toHaveBeenCalled();
    const row = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(row.parked.wake_triage.demotedAt).toHaveLength(2);
    expect(row.inconsistencies[0]).toMatch(/^drain_triage: the store row says act/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ purpose: 'wake_triage', to: 'parked', reason: 'parked' }) }));
  });

  it('never throws: a failing modes read leaves every mode alone and returns a failed summary; the kill switch short-circuits', async () => {
    mockGetConfig.mockRejectedValue(new Error('db down'));
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/^failed: db down/);
    expect(mockUpdateModes).not.toHaveBeenCalled();
    process.env.DECISION_GATE_ROLLOUT_JOB_DISABLED = '1';
    await expect(runDecisionGateRolloutOnce({ now: NOW })).resolves.toMatch(/^disabled/);
  });
});

describe('the sync prompt view + the briefing line', () => {
  it('parkedPurposesSync / rolloutRecentLineSync read the primed cache with relative ages; the briefing line names the week', async () => {
    const state = emptyRolloutState();
    state.parked.auto_route = { until: new Date(NOW.getTime() + 86_400_000).toISOString(), reason: 'r', demotedAt: [] };
    state.parked.old = { until: iso(1), reason: 'r', demotedAt: [] };
    state.actions = [{ at: new Date(Date.now() - 3 * 3_600_000).toISOString(), purpose: 'wake_triage', from: 'shadow', to: 'act', reason: 'flipped' }, { at: new Date(Date.now() - 50 * 3_600_000).toISOString(), purpose: 'x', from: 'shadow', to: 'act', reason: 'dry_run' }];
    state.ownerAsks.compute_policy = { questionId: 'oq_1', at: iso(1), tier: 2 };
    primeRolloutStateCache(state);
    expect(parkedPurposesSync(NOW.getTime())).toEqual(['auto_route']);
    expect(rolloutRecentLineSync()).toBe('wake_triage shadow → act (3 h ago)');
    store.set(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`, { ...state, actions: [{ at: iso(3), purpose: 'wake_triage', from: 'shadow', to: 'act', reason: 'flipped' }] });
    const line = await rolloutBriefingLine(NOW);
    expect(line).toMatch(/^Decision gate \(auto-rollout ON\): 1 purpose moved to act by the rollout automaton this week \(wake_triage 3 h ago\); parked after repeated auto-demotes: auto_route; ready and waiting for your answer: compute_policy\.$/);
    clearRolloutStateCache();
    expect(parkedPurposesSync()).toEqual([]);
    store.clear();
    expect(await rolloutBriefingLine(NOW)).toBeNull();
  });
});

// 2026-10-04: the tier-2 authorization switch never leaks between tests.
afterEach(() => { delete process.env.DECISION_GATE_AUTO_ROLLOUT_MAX_TIER; });

// ── DECISION-GATE-LIFECYCLE (2026-10-20) ──────────────────────────────────────
// reviewBy was read only by its type (self_audit missed 2026-10-12 and kept
// ~3k asks / 30 d) and non-converging purposes (AUROC < 0.6 at n ≥ 200 —
// claim_evidenced 0.466) asked forever. Pins: the pure planner, the pass
// (off through the admin path + metric + ticket + ledger), dry run, the kill
// switch, act purposes untouched, the hand-restore rule, the briefing line.
describe('DECISION-GATE-LIFECYCLE', () => {
  const LNOW = new Date('2026-10-20T12:00:00Z');
  const liso = (h: number) => new Date(LNOW.getTime() - h * 3_600_000).toISOString();
  const lstamp = (over: Partial<any> = {}, metrics: Partial<any> = {}): any =>
    ({ ready: false, at: liso(1), backend: 'TypeSafe Jev (jev-1.13.0)', backendSpec: 'jev', metrics: { n: 420, days: 13.5, auroc: 0.466, accuracy: 302 / 420, ...metrics }, reasons: ['AUROC low'], windowDays: 14, partition: 'q1', ...over });
  beforeEach(() => {
    mockFileTicket.mockReset().mockResolvedValue({ deduped: false, ticket: { id: 'tkt-11112222-3333' } });
    mockReadReport.mockResolvedValue({ computedAt: liso(0.5) });
    delete process.env.DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED;
  });
  afterAll(() => { delete process.env.DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED; });

  it('the registry carries a machine-checkable bar for every shadow_review row (self_audit: AUROC ≥ 0.6 on ≥ 200)', () => {
    expect(DECISION_ROLE_REGISTRY.self_audit.lifecycle?.reviewBar).toEqual({ minAuroc: 0.6, minLabels: 200 });
    for (const [, spec] of Object.entries(DECISION_ROLE_REGISTRY)) {
      if (spec.lifecycle?.decision === 'shadow_review') expect(spec.lifecycle.reviewBar).toBeDefined();
    }
    expect(reviewDueMs('2026-10-12')).toBe(Date.parse('2026-10-12T23:59:59.999Z'));
    expect(Number.isNaN(reviewDueMs('soon'))).toBe(true);
  });

  it('planLifecycle: review_by retires self_audit past its date with the bar unmet; non_converging parks claim_evidenced; act / off / young / few-label / degenerate / override stamps are never planned', () => {
    const plan = planLifecycle({
      now: LNOW,
      modes: config({ wake_triage: { effective: 'act', storeMode: 'act' }, tool_intent: { effective: 'off', storeMode: 'off' } }),
      stamp: {
        self_audit: lstamp({}, { auroc: 0.516, n: 85 }),
        claim_evidenced: lstamp(),
        wake_triage: lstamp(), // act — auto-demote owns it
        tool_intent: lstamp(), // already off
        checker_route: lstamp({}, { days: 6 }), // too young
        guard_strike: lstamp({}, { n: 150 }), // too few labels
        firing_superseded: lstamp({}, { degenerateLabels: true }), // AUROC waived
        browser_driver: lstamp({ backend: 'owner-override:claude-loop' }), // not measured
        memory_extract: lstamp({ at: liso(24 * 9) }), // stale
        reflection_route: lstamp({}, { auroc: 0.71 }), // converging
      },
      state: emptyRolloutState(),
    });
    expect(plan.retire.map(r => [r.purpose, r.rule])).toEqual([['self_audit', 'review_by'], ['claim_evidenced', 'non_converging']]);
    expect(plan.retire[0].detail).toMatch(/past its review date 2026-10-12 with the bar unmet — AUROC 0\.516 on n=85/);
    expect(plan.retire[1].detail).toMatch(/non-converging — AUROC 0\.466 < 0\.6 on n=420 labels over 13\.5 d, 118 errors \(accuracy 71\.9 %/);
    expect(plan.retire[1].metrics).toMatchObject({ n: 420, errors: 118, partition: 'q1' });
    expect(plan.skipped).toEqual([]); // nothing above crossed the AUROC bar and was waived
  });

  // Review fix (major): the stamp's AUROC is auroc(1 − confidence, !agreed) — it ranks the gate's
  // ERRORS, so it is noise with a handful of errors whatever the question's quality, and
  // degenerateLabels (the ACTUAL yes / no split) never covered that.
  it('non_converging needs an ESTIMABLE AUROC: ≥ 20 errors AND ≥ 20 agreed rows, and accuracy < 0.9 — a 98 %-accurate question is never parked', () => {
    expect(NON_CONVERGING_MIN_OUTCOME_ROWS).toBe(20);
    expect(NON_CONVERGING_MAX_ACCURACY).toBe(0.9);
    const plan = planLifecycle({
      now: LNOW,
      modes: config(),
      stamp: {
        // the finding's case: 240 labels over 12 d, 236 agreed, a balanced yes/no split, 4 errors mid-confidence
        memory_extract: lstamp({}, { n: 240, days: 12, auroc: 0.45, accuracy: 236 / 240, positives: 120, negatives: 120, degenerateLabels: false }),
        coding_memory_fold: lstamp({}, { n: 400, accuracy: 381 / 400 }), // 19 errors — one short of estimable
        guard_strike: lstamp({}, { n: 400, accuracy: 15 / 400 }), // anti-predictive, but only 15 agreed rows
        reflection_route: lstamp({}, { n: 500, accuracy: 0.92 }), // 40 errors (estimable) — but right 92 % of the time
        sweep_triage: lstamp({}, { accuracy: undefined }), // no accuracy on the stamp — never judged
        claim_evidenced: lstamp({}, { n: 400, accuracy: 0.85 }), // 60 errors / 340 agreed at 85 % — parked
      },
      state: emptyRolloutState(),
    });
    expect(plan.retire.map(r => r.purpose)).toEqual(['claim_evidenced']);
    expect(plan.retire[0].detail).toMatch(/60 errors \(accuracy 85\.0 %/);
    const why = (p: string) => plan.skipped.find(k => k.purpose === p)?.reason ?? '';
    expect(why('memory_extract')).toMatch(/not estimable — 4 errors \/ 236 agreed \(needs ≥ 20 of each\) — not parked/);
    expect(why('coding_memory_fold')).toMatch(/19 errors \/ 381 agreed/);
    expect(why('guard_strike')).toMatch(/385 errors \/ 15 agreed/);
    expect(why('reflection_route')).toMatch(/accuracy 92\.0 % ≥ 90 % \(40 errors\) — the answers converge/);
    expect(why('sweep_triage')).toMatch(/no accuracy on the stamp/);
  });

  it('non_converging never parks a shadow_review row before its reviewBy, nor a purpose whose HUMAN-turn ask is retired (frozen human partition) — both are named in skipped', () => {
    // 2026-10-05: self_audit's reviewBy (2026-10-12) is still ahead — a low AUROC on 260 labels waits for the date.
    const early = planLifecycle({ now: new Date('2026-10-05T12:00:00Z'), modes: config(), stamp: { self_audit: lstamp({ at: '2026-10-05T11:00:00Z' }, { auroc: 0.55, n: 260, days: 11 }) }, state: emptyRolloutState() });
    expect(early.retire).toEqual([]);
    expect(early.skipped.find(k => k.purpose === 'self_audit')?.reason).toMatch(/review date 2026-10-12 has not passed — judged on its reviewBar then, never parked early/);
    // compute_policy / drafts_agree: human asks retired 2026-10-06, machine turns still ask — the stale human partition is never the basis for a park.
    const retired = planLifecycle({ now: LNOW, modes: config(), stamp: { compute_policy: lstamp({}, { auroc: 0.55, n: 250 }), drafts_agree: lstamp() }, state: emptyRolloutState(), env: {} });
    expect(retired.retire).toEqual([]);
    expect(retired.skipped.filter(k => /human-turn ask is retired/.test(k.reason)).map(k => k.purpose).sort()).toEqual(['compute_policy', 'drafts_agree']);
    // (self_audit, past its reviewBy with no stamp entry in this pass, is named too — never retired on absent evidence)
    expect(retired.skipped.find(k => k.purpose === 'self_audit')?.reason).toMatch(/no fresh measured readiness stamp to judge the bar \(no stamp entry\)/);
    // lifting the human-turn retirement on this process makes the partition live again — judged as any other purpose
    const lifted = planLifecycle({ now: LNOW, modes: config(), stamp: { drafts_agree: lstamp() }, state: emptyRolloutState(), env: { DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED: '1' } });
    expect(lifted.retire.map(r => r.purpose)).toEqual(['drafts_agree']);
  });

  it('review_by: a met bar stays; a missing / stale stamp is skipped (never retired on absent evidence); before the date nothing happens', () => {
    const met = planLifecycle({ now: LNOW, modes: config(), stamp: { self_audit: lstamp({}, { auroc: 0.64, n: 260 }) }, state: emptyRolloutState() });
    expect(met.retire).toEqual([]);
    expect(met.skipped.find(s => s.purpose === 'self_audit')?.reason).toMatch(/bar met/);
    const none = planLifecycle({ now: LNOW, modes: config(), stamp: {}, state: emptyRolloutState() });
    expect(none.retire).toEqual([]);
    expect(none.skipped.find(s => s.purpose === 'self_audit')?.reason).toMatch(/no fresh measured readiness stamp/);
    const early = planLifecycle({ now: new Date('2026-10-12T20:00:00Z'), modes: config(), stamp: { self_audit: lstamp({ at: '2026-10-12T19:00:00Z' }, { auroc: 0.516, n: 85 }) }, state: emptyRolloutState() });
    expect(early.retire).toEqual([]);
  });

  it('a purpose a human restored after a lifecycle action is not retired again for the SAME question; a re-posed partition is judged afresh', () => {
    const state = emptyRolloutState();
    state.lifecycle.claim_evidenced = { rule: 'non_converging', at: liso(48), from: 'shadow', detail: 'd', partition: 'q1' };
    state.lifecycle.self_audit = { rule: 'review_by', at: liso(48), from: 'shadow', detail: 'd', partition: 'q1' };
    const same = planLifecycle({ now: LNOW, modes: config(), stamp: { claim_evidenced: lstamp(), self_audit: lstamp({}, { auroc: 0.5 }) }, state });
    expect(same.retire).toEqual([]);
    expect(same.skipped.filter(s => /restored by hand/.test(s.reason)).map(s => s.purpose).sort()).toEqual(['claim_evidenced', 'self_audit']);
    const reposed = planLifecycle({ now: LNOW, modes: config(), stamp: { claim_evidenced: lstamp({ partition: 'q2' }) }, state });
    expect(reposed.retire.map(r => r.purpose)).toEqual(['claim_evidenced']);
  });

  it('the pass sets each OFF through updateDecisionModes, records decision_gate_lifecycle_retired, files ONE re-pose ticket for the non-converging one, keeps the ledger and names it in the briefing', async () => {
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ self_audit: lstamp({}, { auroc: 0.516, n: 85 }), claim_evidenced: lstamp() });
    const summary = await runDecisionGateRolloutOnce({ now: LNOW });
    expect(summary).toMatch(/evaluated 24, lifecycle-off 2,/);
    expect(mockUpdateModes).toHaveBeenCalledWith({ self_audit: 'off' }, ROLLOUT_ACTOR, undefined);
    expect(mockUpdateModes).toHaveBeenCalledWith({ claim_evidenced: 'off' }, ROLLOUT_ACTOR, undefined);
    const lifecycleRows = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter((r: any) => r.kind === 'decision_gate_lifecycle_retired');
    expect(lifecycleRows.map((r: any) => [r.meta.purpose, r.meta.rule, r.meta.to])).toEqual([['self_audit', 'review_by', 'off'], ['claim_evidenced', 'non_converging', 'off']]);
    expect(lifecycleRows[1].meta.ticketId).toBe('tkt-11112222-3333');
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    const t = mockFileTicket.mock.calls[0][0];
    expect(t).toMatchObject({ userId: null, type: 'enhancement', area: 'framework' });
    expect(t.title).toBe('[decision-gate lifecycle] re-pose claim_evidenced — non-converging (AUROC < 0.6 on ≥ 200 labels)');
    expect(t.context).toMatchObject({ purpose: 'claim_evidenced', signal: 'decision_gate_non_converging' });
    const row = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(row.lifecycle.self_audit).toMatchObject({ rule: 'review_by', from: 'shadow' });
    expect(row.lifecycle.claim_evidenced).toMatchObject({ rule: 'non_converging', ticketId: 'tkt-11112222-3333', partition: 'q1', n: 420, errors: 118 });
    expect(row.actions.map((a: any) => a.reason)).toEqual(expect.arrayContaining(['lifecycle_retired', 'lifecycle_parked']));
    expect(normalizeRolloutState(row).lifecycle.claim_evidenced.ticketId).toBe('tkt-11112222-3333');
    const line = await rolloutBriefingLine(LNOW);
    expect(line).toContain('set off by the registry lifecycle this week: self_audit (past its review date with the bar unmet), claim_evidenced (non-converging — 118 errors in 420 labels; re-pose ticket tkt-1111)');
    expect(mockFileTicket.mock.calls[0][0].description).toMatch(/118 errors/);
    primeRolloutStateCache(normalizeRolloutState(row));
    expect(rolloutRecentLineSync(LNOW.getTime())).toMatch(/self_audit shadow → off — review bar unmet/);
    clearRolloutStateCache();
  });

  it('DRY RUN records what it would set off and writes no mode / ticket; the kill switch plans nothing; a refused off-write is recorded, never thrown', async () => {
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ claim_evidenced: lstamp() });
    process.env.DECISION_GATE_AUTO_ROLLOUT_DRY_RUN = '1';
    await runDecisionGateRolloutOnce({ now: LNOW });
    expect(mockUpdateModes).not.toHaveBeenCalled();
    expect(mockFileTicket).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_gate_lifecycle_retired', meta: expect.objectContaining({ purpose: 'claim_evidenced', dryRun: true }) }));
    delete process.env.DECISION_GATE_AUTO_ROLLOUT_DRY_RUN;

    store.clear(); mockRecordLoopMetric.mockClear();
    process.env.DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED = '1';
    await runDecisionGateRolloutOnce({ now: LNOW });
    expect(mockUpdateModes).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric.mock.calls.some(c => c[0]?.kind === 'decision_gate_lifecycle_retired')).toBe(false);
    delete process.env.DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED;

    store.clear();
    mockUpdateModes.mockRejectedValueOnce(new Error('store down'));
    await expect(runDecisionGateRolloutOnce({ now: LNOW })).resolves.toMatch(/lifecycle-off 0/);
    const row = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(row.lifecycle).toEqual({});
    expect(row.actions[0]).toMatchObject({ purpose: 'claim_evidenced', reason: 'refused' });
  });

  it('the ledger record is persisted right after the off-write — a failing FINAL state write never loses it, and the failure log says a mode changed', async () => {
    const logger = jest.requireMock('../../../utils/logger').default as { warn: jest.Mock; info: jest.Mock };
    logger.warn.mockClear(); logger.info.mockClear();
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ claim_evidenced: lstamp(), memory_extract: lstamp({}, { n: 240, days: 12, auroc: 0.45, accuracy: 236 / 240 }) });
    // 1st put (the in-loop record) lands; 2nd put (the pass's final write) fails.
    mockStorePut.mockImplementationOnce(async (ns: string[], key: string, value: any) => { store.set(`${ns.join('/')}/${key}`, value); }).mockImplementationOnce(async () => { throw new Error('store hiccup'); });
    await expect(runDecisionGateRolloutOnce({ now: LNOW })).resolves.toMatch(/^failed: store hiccup/);
    expect(mockUpdateModes).toHaveBeenCalledWith({ claim_evidenced: 'off' }, ROLLOUT_ACTOR, undefined);
    const row = store.get(`${ROLLOUT_STORE_NS.join('/')}/${ROLLOUT_STORE_KEY}`);
    expect(row.lifecycle.claim_evidenced).toMatchObject({ rule: 'non_converging', partition: 'q1' });
    const failLine = String(logger.warn.mock.calls.map(c => c[0]).find((m: string) => /pass failed/.test(m)));
    expect(failLine).toMatch(/1 mode write committed earlier in the pass stands/);
    expect(failLine).not.toMatch(/no mode changed/);
    // the waived purpose is named once in the log
    expect(logger.info.mock.calls.map(c => String(c[0])).some(m => /lifecycle not retired — memory_extract: AUROC 0\.450 on n=240, but not estimable/.test(m))).toBe(true);
  });

  it('the summary counts purposes the lifecycle looked at and did not retire (a waived AUROC, a review with no stamp entry)', async () => {
    mockGetConfig.mockResolvedValue(config());
    mockReadStamp.mockResolvedValue({ claim_evidenced: lstamp(), memory_extract: lstamp({}, { n: 240, days: 12, auroc: 0.45, accuracy: 236 / 240 }) });
    await expect(runDecisionGateRolloutOnce({ now: LNOW })).resolves.toMatch(/lifecycle-off 1 \(2 not retired, logged\),/);
  });
});
