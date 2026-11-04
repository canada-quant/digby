/**
 * get_decision_gate_status + set_decision_gate_mode (rollout self-governance,
 * 2026-09-27) — executed through executeFleetOpsTool at the module boundary:
 * the registry / modes / readiness / rollout reads are mocked as the seams
 * they are, and the flip goes through decision-gate-modes updateDecisionModes
 * (the admin PUT's admission) — asserted on, never re-implemented.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const ownerQuestions = new Map<string, any>();
const mockActivityCreate: jest.Mock = jest.fn(async () => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    activity: { create: (...a: any[]) => mockActivityCreate(...a) },
    ownerQuestion: { findFirst: async ({ where }: any) => { const r = ownerQuestions.get(where.id); return r && r.userId === where.userId ? r : null; } },
  },
}));
const mockGetConfig = jest.fn();
const mockUpdateModes = jest.fn();
const mockStoredSync = jest.fn((_p: string): string | null => null);
jest.mock('./decision-gate-modes', () => ({
  __esModule: true,
  ...jest.requireActual('./decision-gate-modes'),
  getDecisionModeConfig: (...a: any[]) => mockGetConfig(...a),
  updateDecisionModes: (...a: any[]) => mockUpdateModes(...a),
  storedDecisionModeSync: (p: string) => mockStoredSync(p),
}));
const mockReadStamp: jest.Mock = jest.fn(async () => ({ wake_triage: { ready: true, at: '2026-09-27T10:00:00Z', backend: 'TypeSafe Jev', metrics: { n: 300 }, reasons: [] } }));
jest.mock('./decision-gate-readiness', () => ({ __esModule: true, readReadinessStamp: (...a: any[]) => mockReadStamp(...a) }));
const mockRolloutView: jest.Mock = jest.fn(async () => ({
  switch: { enabled: true, dryRun: false, jobDisabled: false, intervalMin: 60 },
  state: { lastRunAt: '2026-09-27T11:00:00Z', lastSummary: 'flipped 1', parked: { browser_driver: { until: '2999-01-01T00:00:00Z', reason: 'r', demotedAt: [] } }, actions: [{ at: '2026-09-27T11:00:00Z', purpose: 'wake_triage', from: 'shadow', to: 'act', reason: 'flipped' }], ownerAsks: {}, inconsistencies: ['drain_triage: the store row says act but the code caps it at shadow'] },
  tierRule: 'tier rule',
  recentDemotes: [],
}));
jest.mock('./decision-gate-rollout', () => ({
  __esModule: true,
  ...jest.requireActual('./decision-gate-rollout'),
  getRolloutView: (...a: any[]) => mockRolloutView(...a),
}));
const mockIsSupervisorChat = jest.fn(async (_id: string) => false);
jest.mock('./supervisor-state.service', () => ({ __esModule: true, isSupervisorChat: (id: string) => mockIsSupervisorChat(id) }));
const mockFlag: jest.Mock = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_new1' } }));
jest.mock('./owner-questions', () => ({ __esModule: true, flagOwnerQuestion: (...a: any[]) => mockFlag(...a) }));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
jest.mock('./decision-gate-backends', () => ({ __esModule: true, resolveEffectivePrimarySpec: async () => 'jev' }));

import { executeFleetOpsTool, FLEET_OPS_TOOL_SCHEMA, isFleetOpsTool } from './fleet-ops-tools';
import { PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS } from './platform-tool-names';
import { RECEIPT_TOOLS } from '../coding/run-receipts';
import { PLATFORM_OBSERVE_TOOLS } from '../coding/evidence-tools';
import { DECISION_PURPOSES } from './decision-gate-modes';

const deps = { platform: {}, isAdmin: jest.fn(async () => true) };
const ctx = (over: Partial<{ userTurnAt: Date | null }> = {}) => ({ sessionId: 'fleet-chat-1', userId: 'admin-1', userTurnAt: null, ...over });
const parse = (s: string) => JSON.parse(s);

function config(over: Record<string, any> = {}) {
  return {
    purposes: DECISION_PURPOSES.map(p => ({ purpose: p.purpose, label: p.label, description: p.description, storeMode: null, envMode: 'shadow', effective: 'shadow', effectiveSource: 'default', readiness: null, admission: { admitted: true }, ...(over[p.purpose] ?? {}) })),
    gateDisabled: false, admissionDisabled: false,
  };
}

beforeEach(() => {
  ownerQuestions.clear(); mockActivityCreate.mockClear(); mockGetConfig.mockReset(); mockUpdateModes.mockReset(); mockStoredSync.mockReset(); mockStoredSync.mockReturnValue(null);
  mockIsSupervisorChat.mockReset(); mockIsSupervisorChat.mockResolvedValue(false); mockFlag.mockClear(); mockRecordLoopMetric.mockClear(); deps.isAdmin.mockClear(); deps.isAdmin.mockResolvedValue(true);
  mockGetConfig.mockResolvedValue(config({ wake_triage: { effective: 'act', storeMode: 'act', effectiveSource: 'store' } }));
  mockUpdateModes.mockImplementation(async (patch: any) => config(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { effective: v || 'shadow', storeMode: v || null, effectiveSource: v ? 'store' : 'default' }]))));
});

describe('registration', () => {
  it('both tools are fleet-ops tools with a schema; the read joins the observe + receipt sets, the flip the receipt set', () => {
    expect(isFleetOpsTool('get_decision_gate_status')).toBe(true);
    expect(isFleetOpsTool('set_decision_gate_mode')).toBe(true);
    expect(FLEET_OPS_TOOL_SCHEMA.map(t => t.function.name)).toEqual(expect.arrayContaining(['get_decision_gate_status', 'set_decision_gate_mode']));
    expect(PLATFORM_READ_TOOLS).toContain('get_decision_gate_status');
    expect(PLATFORM_MUTATING_TOOLS).toContain('set_decision_gate_mode');
    expect(PLATFORM_OBSERVE_TOOLS.has('get_decision_gate_status')).toBe(true);
    expect(RECEIPT_TOOLS.has('get_decision_gate_status')).toBe(true);
    expect(RECEIPT_TOOLS.has('set_decision_gate_mode')).toBe(true);
    const set = FLEET_OPS_TOOL_SCHEMA.find(t => t.function.name === 'set_decision_gate_mode')!;
    expect((set.function.parameters as any).required).toEqual(['purpose', 'mode']);
  });
});

describe('get_decision_gate_status', () => {
  it('returns every purpose with tier / effective / readiness / parked / cap, the rollout view and the act set — never gated', async () => {
    deps.isAdmin.mockResolvedValue(false);
    const r = parse(await executeFleetOpsTool(ctx(), 'get_decision_gate_status', {}, deps));
    expect(r.ok).toBe(true);
    expect(r.count).toBe(24); // 21 + session_topology (merged 2026-09-27) + turn_plan (dynamic roster 2026-10-03) + task_kind (task-aware pick 2026-10-20)
    expect(r.act).toEqual(['wake_triage']);
    const wt = r.purposes.find((p: any) => p.purpose === 'wake_triage');
    expect(wt).toMatchObject({ tier: 1, effective: 'act', source: 'store', ready: 'READY', labels: 300, readinessBackend: 'TypeSafe Jev', parked: false, actCap: null });
    expect(r.purposes.find((p: any) => p.purpose === 'browser_driver').parked).toBe(true);
    expect(r.purposes.find((p: any) => p.purpose === 'drain_triage').actCap).toMatch(/^since 2026-09-27/);
    // roster 2026-10-06 B-2: the four purposes no longer asked on human turns say so; every other purpose carries no such key
    for (const p of ['auto_route', 'compute_policy', 'checker_route', 'drafts_agree']) expect(r.purposes.find((x: any) => x.purpose === p).humanTurns).toMatch(/^retired since 2026-10-06/);
    expect(wt.humanTurns).toBeUndefined();
    expect(r.purposes.find((p: any) => p.purpose === 'sweep_triage').ready).toBe('no stamp');
    expect(r.rollout).toMatchObject({ enabled: true, dryRun: false, lastSummary: 'flipped 1', inconsistencies: [expect.stringMatching(/^drain_triage/)] });
    expect(r.message).toMatch(/1 purpose\(s\) in act \(wake_triage\); auto-rollout ON; 1 store\/code inconsistency/);
    // The compact row carries no doctrine prose; purpose:<id> returns it in full.
    expect(wt.decides).toBeUndefined();
    const one = parse(await executeFleetOpsTool(ctx(), 'get_decision_gate_status', { purpose: 'wake_triage' }, deps));
    expect(one.count).toBe(1);
    expect(one.purposes[0]).toMatchObject({ decides: expect.stringMatching(/supervisor turn NOW/), actDoes: expect.any(String), consumerSite: expect.stringMatching(/hooks\.service/), bars: expect.objectContaining({ minLabels: 200 }), killSwitches: expect.any(Array) });
    const bad = parse(await executeFleetOpsTool(ctx(), 'get_decision_gate_status', { purpose: 'nope' }, deps));
    expect(bad).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('fails open when a read seam throws (unknown fields, still ok:true)', async () => {
    mockGetConfig.mockRejectedValue(new Error('db down'));
    mockRolloutView.mockRejectedValueOnce(new Error('store down'));
    const r = parse(await executeFleetOpsTool(ctx(), 'get_decision_gate_status', {}, deps));
    expect(r.ok).toBe(true);
    expect(r.purposes[0].effective).toBe('unknown');
    expect(r.rollout).toBeNull();
  });
});

describe('set_decision_gate_mode', () => {
  it('refuses non-admins, non-supervisor machine turns, unknown purposes and bad modes without touching the store', async () => {
    deps.isAdmin.mockResolvedValue(false);
    expect(parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'wake_triage', mode: 'shadow' }, deps))).toMatchObject({ ok: false, reason: 'forbidden' });
    deps.isAdmin.mockResolvedValue(true);
    expect(parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'nope', mode: 'shadow' }, deps))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'wake_triage', mode: 'maybe' }, deps))).toMatchObject({ ok: false, reason: 'invalid' });
    const scope = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'wake_triage', mode: 'shadow' }, deps));
    expect(scope).toMatchObject({ ok: false, reason: 'scope' });
    expect(scope.message).toMatch(/rule gate\.outcome/);
    expect(mockUpdateModes).not.toHaveBeenCalled();
  });

  it('a supervisor chat sets shadow / act on a tier-1 purpose through updateDecisionModes (the PUT path) — audited, metered, receipted', async () => {
    mockIsSupervisorChat.mockResolvedValue(true);
    mockStoredSync.mockReturnValue('act');
    const r = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'wake_triage', mode: 'shadow' }, deps));
    expect(r).toMatchObject({ ok: true, ids: { purpose: 'wake_triage', mode: 'shadow' }, before: 'act', effective: 'shadow' });
    expect(mockUpdateModes).toHaveBeenCalledWith({ wake_triage: 'shadow' }, 'tool:admin-1', { primarySpecFor: expect.any(Function) });
    expect(mockActivityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'decision_gate.mode_set' }) }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_gate_rollout', meta: expect.objectContaining({ purpose: 'wake_triage', from: 'act', to: 'shadow', reason: 'tool' }) }));
    const act = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'sweep_triage', mode: 'act' }, deps));
    expect(act).toMatchObject({ ok: true, ids: { purpose: 'sweep_triage', mode: 'act' } });
    expect(mockFlag).not.toHaveBeenCalled();
    // '' clears to env.
    const clear = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'sweep_triage', mode: '' }, deps));
    expect(clear).toMatchObject({ ok: true, ids: { purpose: 'sweep_triage', mode: '' } });
    expect(mockUpdateModes).toHaveBeenLastCalledWith({ sweep_triage: '' }, 'tool:admin-1', expect.anything());
  });

  it('an admission refusal (409) is NOT done — the exact bar comes back, nothing thrown', async () => {
    mockIsSupervisorChat.mockResolvedValue(true);
    mockUpdateModes.mockRejectedValue(Object.assign(new Error('Cannot set auto_route to act — not ready: no readiness stamp'), { statusCode: 409 }));
    const r = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'auto_route', mode: 'act' }, deps));
    expect(r).toMatchObject({ ok: false, reason: 'refused', ids: { purpose: 'auto_route' } });
    expect(r.message).toMatch(/^NOT done — Cannot set auto_route to act/);
    expect(mockActivityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'decision_gate.mode_refused' }) }));
  });

  it('a widening act flip outside tier 1 from a machine turn files ONE owner question and returns staged; the GO answer executes; a hold refuses', async () => {
    mockIsSupervisorChat.mockResolvedValue(true);
    const staged = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'compute_policy', mode: 'act' }, deps));
    expect(staged).toMatchObject({ ok: false, reason: 'staged', staged: true, ownerQuestionId: 'oq_new1', ids: { purpose: 'compute_policy' } });
    expect(staged.message).toMatch(/^Nothing has changed yet/);
    expect(mockFlag).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'fleet-chat-1', userId: 'admin-1', machineTriggered: true, question: expect.stringMatching(/Flip compute_policy to act\? It is tier 2/) }));
    expect(mockUpdateModes).not.toHaveBeenCalled();
    // Unknown / foreign question id.
    expect(parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'compute_policy', mode: 'act', ownerQuestionId: 'oq_x' }, deps))).toMatchObject({ ok: false, reason: 'invalid' });
    // Still open → still staged.
    ownerQuestions.set('oq_new1', { id: 'oq_new1', userId: 'admin-1', status: 'open', answer: null, chosenOption: null, question: '[Decision gate] Flip compute_policy to act?' });
    expect(parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'compute_policy', mode: 'act', ownerQuestionId: 'oq_new1' }, deps))).toMatchObject({ ok: false, reason: 'staged', staged: true });
    // Hold → refused.
    ownerQuestions.set('oq_new1', { id: 'oq_new1', userId: 'admin-1', status: 'answered', answer: null, chosenOption: 'hold', question: '[Decision gate] Flip compute_policy to act?' });
    expect(parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'compute_policy', mode: 'act', ownerQuestionId: 'oq_new1' }, deps))).toMatchObject({ ok: false, reason: 'refused' });
    expect(mockUpdateModes).not.toHaveBeenCalled();
    // GO → executes through the PUT path.
    ownerQuestions.set('oq_new1', { id: 'oq_new1', userId: 'admin-1', status: 'answered', answer: 'flip it', chosenOption: null, question: '[Decision gate] Flip compute_policy to act?' });
    const done = parse(await executeFleetOpsTool(ctx(), 'set_decision_gate_mode', { purpose: 'compute_policy', mode: 'act', ownerQuestionId: 'oq_new1' }, deps));
    expect(done).toMatchObject({ ok: true, ids: { purpose: 'compute_policy', mode: 'act' } });
    expect(mockUpdateModes).toHaveBeenCalledWith({ compute_policy: 'act' }, 'tool:admin-1', expect.anything());
    // A user-present turn (the owner directing) executes a tier-2 act directly.
    mockUpdateModes.mockClear(); mockFlag.mockClear();
    const direct = parse(await executeFleetOpsTool(ctx({ userTurnAt: new Date() }), 'set_decision_gate_mode', { purpose: 'wake_effort', mode: 'act' }, deps));
    expect(direct.ok).toBe(true);
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockUpdateModes).toHaveBeenCalledWith({ wake_effort: 'act' }, 'tool:admin-1', expect.anything());
  });
});
